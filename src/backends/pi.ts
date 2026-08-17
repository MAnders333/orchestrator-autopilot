// backends/pi.ts — the pi-subagents backend: RPC spawn/fleet + the file
// control channel for steering detached async runs. This is the ACTIVE backend
// for the pi extension (the queue tools run in an interactive pi session).
//
// The seam contract lives in backends/types.ts; backends/index.ts is the
// factory. pi-subagents specifics live here: the RPC spawn/fleet seams and the
// control-channel steer. Steer is written directly to the run's control inbox
// (the mechanism pi-subagents' own FleetView uses) because the public
// `api/control-channel` export only exposes stop, and the subagent steer
// action routes workflow-mode detached runs to the foreground path ('no live
// foreground child') — an upstream routing gap.
//
// Ack protocol (verified in pi-subagents src): the child's prompt-runtime
// acknowledges each request via writeSteerAckAt → steerAckPathFromDir:
//   control/steer-acks/<index>/<base64url(requestId)>.json
// with { type: "steer-ack", requestId, index, ts, state, message } where
// state ∈ delivered | queued | failed. The runner fails steers when the
// child publishes steer-capabilities/<index>.json with supported:false.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import type { SubagentBackend, PiLike } from "./types.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = (id: string) => `subagents:rpc:v1:reply:${id}`;

export function createPiBackend(pi: PiLike): SubagentBackend {
  /** Extract the async workflow id from a spawn RPC reply (structured or text). */
  function extractRunId(reply: unknown): string {
    const d = (reply as { data?: Record<string, unknown> } | null)?.data;
    if (d) {
      const details = d.details as Record<string, unknown> | undefined;
      for (const c of [d.runId, d.id, (d.run as { id?: string } | undefined)?.id, details?.asyncId, details?.runId]) {
        if (typeof c === "string" && c) return c;
      }
      const text = typeof d.text === "string" ? d.text : "";
      const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) return m[0];
      const m2 = text.match(/Async workflow \[([0-9a-f]+)\]/i);
      if (m2) return m2[1];
    }
    return "";
  }

  function rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        unsub();
        resolve({ success: false, error: { message: `${method} RPC timed out` } });
      }, timeoutMs);
      const unsub = pi.events.on(RPC_REPLY(requestId), (reply: unknown) => {
        clearTimeout(timer);
        unsub();
        resolve(reply);
      });
      pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, params });
    });
  }

  return {
    async spawn(task, opts) {
      const script = `return runs.run("main", ${JSON.stringify({
        agent: opts.agent ?? "worker",
        task,
        context: "fresh",
        worktree: opts.worktree ?? true,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })})`;
      const reply = await rpc("spawn", { workflowScript: script, context: "fresh" }, 30_000);
      const r = reply as { success?: boolean; error?: { message?: string } };
      if (r?.success !== true) throw new Error(r?.error?.message ?? "spawn rejected");
      return extractRunId(reply);
    },

    async fleetStatus() {
      const reply = await rpc("status", {}, 2500);
      const r = reply as { success?: boolean; data?: { fleet?: { totalActive?: number } } };
      const f = r?.data?.fleet;
      if (r?.success !== true || !f) return null;
      return { totalActive: f.totalActive ?? 0 };
    },

    async steer(runId, message, mode, ackTimeoutMs = 4000) {
      const asyncDir = this.asyncDirFor(runId);
      if (!asyncDir) throw new Error("run dir not found — it likely completed or died; stop + re-dispatch instead");
      // 1. capability pre-check: the child pi publishes whether it can receive
      //    steering (headless -p sessions report supported:false or nothing).
      const controlDir = join(asyncDir, "control");
      if (existsSync(join(controlDir, "steer-inbox-closed.json"))) {
        throw new Error("run no longer accepts steering requests");
      }
      const capDir = join(controlDir, "steer-capabilities");
      if (existsSync(capDir)) {
        for (const f of readdirSync(capDir).filter((n) => n.endsWith(".json"))) {
          let supported: boolean | undefined;
          try {
            supported = (JSON.parse(readFileSync(join(capDir, f), "utf8")) as { supported?: boolean }).supported;
          } catch {
            continue; // unreadable capability file — fall through to the write
          }
          if (supported === false) {
            throw new Error("the child Pi session does not support steering (headless / no sendUserMessage) — steer will NOT be delivered; stop + re-dispatch instead");
          }
        }
      }
      const dir = join(controlDir, "steer-requests");
      mkdirSync(dir, { recursive: true });
      const id = randomUUID();
      const request: Record<string, unknown> = {
        type: "steer",
        id,
        ts: Date.now(),
        message,
        targetIndex: 0,
        source: "queue_steer",
      };
      if (mode && mode !== "steer") request.mode = mode;
      // match pi-subagents' writeSteerRequestToDir naming: <ts13>-<base64url id>.json
      const name = `${String(request.ts as number).padStart(13, "0")}-${Buffer.from(id).toString("base64url")}.json`;
      const p = join(dir, name);
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(request), "utf8");
      renameSync(tmp, p);
      // 2. verify delivery: poll the child's steer-acks/<index>/ for our request
      //    id. Delivered/queued acks confirm the child accepted it; a failed ack
      //    or a silent timeout means the steer did NOT reach the child.
      const deadline = Date.now() + ackTimeoutMs;
      while (Date.now() < deadline) {
        const ackDir = join(controlDir, "steer-acks", "0");
        if (existsSync(ackDir)) {
          for (const f of readdirSync(ackDir).filter((n) => n.endsWith(".json"))) {
            let ack: { requestId?: string; state?: string; message?: string };
            try {
              ack = JSON.parse(readFileSync(join(ackDir, f), "utf8")) as { requestId?: string; state?: string; message?: string };
            } catch {
              continue; // unreadable ack — keep polling
            }
            if (ack.requestId !== id) continue; // only our request
            if (ack.state === "delivered" || ack.state === "queued") return id;
            if (ack.state === "failed") {
              throw new Error(`steer FAILED delivery: ${ack.message ?? "child rejected it"}`);
            }
            // unknown ack state — keep polling (degrade gracefully, don't spurious-fail)
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        "no steering acknowledgment within 4s — the child is NOT consuming its steering inbox " +
        "(headless -p sessions do not support steering). The request was written but NOT delivered.",
      );
    },

    asyncDirFor(runId) {
      try {
        const scope = `pi-subagents-uid-${process.getuid?.() ?? ""}`;
        const root = join(tmpdir(), scope, "async-subagent-runs");
        const dir = join(root, runId);
        if (existsSync(join(dir, "status.json"))) {
          // sanity: the status must reference this run
          try {
            const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { runId?: string; mode?: string };
            if (status.runId && status.runId !== runId) return null;
          } catch {
            // unreadable status — trust the dir name
          }
          return dir;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
