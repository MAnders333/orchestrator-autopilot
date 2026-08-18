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
import type { SubagentBackend, PiLike, CompletionEvent } from "./types.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = (id: string) => `subagents:rpc:v1:reply:${id}`;

/** The pi child session's LAST assistant text — the run's final deliverable
 *  (the reviewer's verdict line + the review body). Line-based read of the
 *  session.jsonl (assistant text parts only). */
export function readLastAssistantText(sessionFile: string): string | null {
  try {
    let last = "";
    for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let msg: { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } } | null = null;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const m = msg?.message;
      if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      const text = (m.content ?? [])
        .filter((x) => x?.type === "text" && typeof x.text === "string")
        .map((x) => x.text ?? "")
        .join("");
      if (text.trim()) last = text;
    }
    return last || null;
  } catch {
    return null;
  }
}

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

  /**
   * Resolve the child's steer-route control inbox — the mechanism the NATIVE
   * subagent steer action uses. Workflow-mode detached runs nest it at
   * <asyncDir>/control/workflow-foreground/<workflowId>/control (verified
   * live: the worker publishes steer-capabilities there); plain runs use the
   * flat <asyncDir>/control. Returns null when no route exists (run gone).
   */
  function steerRouteDir(asyncDir: string): string | null {
    try {
      const wfRoot = join(asyncDir, "control/workflow-foreground");
      if (existsSync(wfRoot)) {
        for (const id of readdirSync(wfRoot)) {
          const nested = join(wfRoot, id, "control");
          if (existsSync(join(nested, "steer-capabilities")) || existsSync(join(nested, "steer-targets"))) return nested;
        }
      }
    } catch {
      // unreadable — fall through to the flat dir
    }
    const flat = join(asyncDir, "control");
    return existsSync(flat) ? flat : null;
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
      // The child's steer route: workflow-mode runs nest the control inbox at
      // control/workflow-foreground/<workflowId>/control (the NATIVE subagent
      // steer action's route) — the flat control dir is the plain-run fallback.
      const routeDir = steerRouteDir(asyncDir);
      if (!routeDir) throw new Error("run has no steer route — it likely completed or died; stop + re-dispatch instead");
      // 1. capability pre-check: the child publishes whether it can receive
      //    steering (headless children report supported:true — steering works).
      const capDir = join(routeDir, "steer-capabilities");
      if (existsSync(capDir)) {
        for (const f of readdirSync(capDir).filter((n) => n.endsWith(".json"))) {
          let supported: boolean | undefined;
          try {
            supported = (JSON.parse(readFileSync(join(capDir, f), "utf8")) as { supported?: boolean }).supported;
          } catch {
            continue; // unreadable capability file — fall through to the write
          }
          if (supported === false) {
            throw new Error("the child Pi session does not support steering (capability supported:false) — steer will NOT be delivered; stop + re-dispatch instead");
          }
        }
      }
      // 2. write the request to the child's STEP INBOX (steer-targets/<index>)
      //    — the native mechanism (writeSteerRequestToExistingDir requires an
      //    EXISTING dir: the child creates the inbox when its steering runtime
      //    is ready; never mkdir here).
      const index = "0";
      const inbox = join(routeDir, "steer-targets", index);
      if (!existsSync(inbox)) {
        throw new Error("steer inbox not ready (steer-targets/0 missing) — the child has not initialized its steering runtime; retry shortly or stop + re-dispatch");
      }
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
      // match pi-subagents' steerRequestFileName: <ts13>-<base64url id>.json
      const name = `${String(request.ts as number).padStart(13, "0")}-${Buffer.from(id).toString("base64url")}.json`;
      writeFileSync(join(inbox, name), JSON.stringify(request), "utf8");
      // 3. verify delivery: poll the child's steer-acks/<index>/ at the ROUTE
      //    dir for our request id. Delivered/queued = accepted; failed or
      //    silent timeout = NOT delivered.
      const deadline = Date.now() + ackTimeoutMs;
      while (Date.now() < deadline) {
        const ackDir = join(routeDir, "steer-acks", index);
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
            // unknown ack state — keep polling (degrade gracefully)
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        `no steering acknowledgment within ${ackTimeoutMs}ms — the request was written but NOT delivered (the child did not consume its steer inbox; it may have completed). Stop + re-dispatch if it is gone.`,
      );
    },

    /** Normalize the RAW async-complete payload into the CompletionEvent the
     *  shared machinery expects. The pi runtime's payload is flat
     *  ({id, success, state, asyncDir, sessionId}) — NO per-child agent or
     *  output — so the reviewer attribution (isReviewerRun) NEVER fired and
     *  queue_review wedged on the first reviewer run. Enrich from the run
     *  record: status.json's step agent + the child session's last assistant
     *  text. Same shape the opencode backend builds. */
    buildCompletionEvent(raw: unknown) {
      const base = (raw ?? {}) as Record<string, unknown>;
      const p = base as { id?: string; runId?: string; success?: boolean; state?: string; asyncDir?: string };
      const runId = p.id ?? p.runId ?? "";
      const success = p.success !== false && p.state !== "failed";
      // Start from the raw payload (its own results survive when the run
      // record is missing — e.g. tests, or a cleaned-up run dir); the run
      // record enrichment below overrides agent/results when found.
      const event: Record<string, unknown> = { ...base, runId, id: runId, agent: "workflow", success, status: success ? "completed" : "failed" };
      try {
        const dir = p.asyncDir && existsSync(p.asyncDir) ? p.asyncDir : this.asyncDirFor(runId);
        if (dir && existsSync(join(dir, "status.json"))) {
          const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { steps?: Array<{ agent?: string; sessionFile?: string }> };
          const step = (status.steps ?? [])[0];
          const agent = step?.agent ?? "";
          let output: string | null = null;
          if (step?.sessionFile && existsSync(step.sessionFile)) output = readLastAssistantText(step.sessionFile);
          if (agent) {
            event.agent = agent;
            event.results = output ? [{ agent, output }] : [{ agent }];
          }
        }
      } catch {
        // best-effort — the raw event still routes worker flips by run id
      }
      return event as never;
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
