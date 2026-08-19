// backends/opencode.ts — the opencode backend: detached `oc run` child
// processes. Async in opencode's headless mode = a detached process (there is
// no in-process event bus like pi-subagents' async-complete; completion is the
// process exit + the run's output.jsonl).
//
// Run identity: our own uuid (known immediately — opencode requires an EXISTING
// session for --session, so we cannot pre-choose its id). The opencode
// sessionID is parsed best-effort from the first output event for diagnostics /
// future re-attach. Completion detection: child 'exit' → status.json flips
// running→completed/failed + onComplete fires (the extension/plugin drives the
// queue flip from that signal). Steering is NOT supported for headless runs —
// we throw an honest error rather than claiming delivery.
//
// Runs are fully isolated under <runsDir>/<runId>/: status.json (machine-
// readable state), output.jsonl (opencode JSON events), stderr.log.

import { spawn as spawnProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import type { SubagentBackend, OpenCodeBackendOptions, OpenCodeRunRecord } from "./types.ts";

const SESSION_ID_RE = /"sessionID"\s*:\s*"([^"]+)"/;

/** Default state root: ~/.local/state/orchestrator-opencode/runs (overridable
 *  via AUTOPILOT_OPENCODE_RUNS_DIR — the audit caught it documented but never
 *  read; now wired here in the framework, not per-host). */
export function defaultRunsDir(): string {
  return process.env.AUTOPILOT_OPENCODE_RUNS_DIR ?? join(homedir(), ".local/state/orchestrator-opencode/runs");
}

/** Extract the reviewer's reply (last text event) from a run's output.jsonl —
 *  the verdict contract anchors on the first non-empty line of that reply.
 *  BACKEND logic (the run record belongs to the backend); the pi backend
 *  reads the same shape from the child session file. */
export function readLatestText(logPath: string): string {
  try {
    const text = readFileSync(logPath, "utf8");
    let last = "";
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as { type?: string; part?: { text?: string } };
        if (e.type === "text" && typeof e.part?.text === "string" && e.part.text.trim()) last = e.part.text.trim();
      } catch {
        // non-JSON line — skip
      }
    }
    return last;
  } catch {
    return "";
  }
}

/** Build the CompletionEvent for a finished opencode run — the same shape the
 *  pi backend's buildCompletionEvent produces (runId/agent/success/status/
 *  results[].output = the last assistant text). The backend owns this; the
 *  host only wires onComplete → runner.onCompletion. */
export function buildOpenCodeCompletionEvent(runId: string, rec: OpenCodeRunRecord): Record<string, unknown> {
  const output = readLatestText(rec.logPath);
  return {
    runId,
    agent: rec.agent,
    success: rec.status === "completed",
    status: rec.status === "completed" ? "completed" : "failed",
    results: output ? [{ agent: rec.agent, output }] : [],
  };
}

export function createOpenCodeBackend(opts: OpenCodeBackendOptions): SubagentBackend {
  const runsDir = opts.runsDir;
  // Canonical default = the opencode binary name; local setups (e.g. the oc
  // wrapper that injects secrets) override via AUTOPILOT_OPENCODE_BIN.
  const ocBin = opts.ocBin ?? process.env.AUTOPILOT_OPENCODE_BIN ?? "opencode";
  const sessionIdTimeoutMs = opts.sessionIdTimeoutMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const children = new Map<string, ReturnType<typeof spawnProcess>>();

  const statusPath = (runId: string): string => join(runsDir, runId, "status.json");
  const readRecord = (runId: string): OpenCodeRunRecord | null => {
    try {
      const p = statusPath(runId);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf8")) as OpenCodeRunRecord;
    } catch {
      return null;
    }
  };
  const writeRecord = (rec: OpenCodeRunRecord): void => {
    try {
      writeFileSync(statusPath(rec.runId), JSON.stringify(rec));
    } catch {
      // run dir gone — the record is informational
    }
  };

  return {
    async spawn(task, spawnOpts) {
      const runId = randomUUID();
      const dir = join(runsDir, runId);
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, "output.jsonl");
      const errPath = join(dir, "stderr.log");
      const agent = spawnOpts.agent ?? "worker";

      const args = ["run", "--format", "json"];
      if (spawnOpts.agent) args.push("--agent", agent);
      args.push(task);

      const out = createWriteStream(logPath);
      const err = createWriteStream(errPath);
      // Bun: stream objects in the stdio array are unimplemented — use pipes
      // and forward stdout/stderr to the run's log files manually.
      const child = spawnProcess(ocBin, args, {
        cwd: spawnOpts.cwd ?? process.cwd(),
        detached: true, // survives the orchestrator process (pi-style detached runs)
        stdio: ["ignore", "pipe", "pipe"],
        // The framework DEPENDS on opencode's async-subagent feature (workers
        // use task(background=true)) — ensure the env flag is set on every
        // spawned run rather than relying on the launcher wrapper exporting it.
        env: { ...process.env, OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "1" },
      });
      child.stdout.pipe(out);
      child.stderr.pipe(err);
      child.unref();

      const startedAt = now();
      writeRecord({ runId, agent, status: "running", startedAt, exitCode: null, pid: child.pid ?? -1, logPath });
      children.set(runId, child);

      child.on("exit", (code) => {
        children.delete(runId);
        const rec = readRecord(runId);
        if (!rec) return;
        out.end();
        err.end();
        const finished: OpenCodeRunRecord = {
          ...rec,
          status: code === 0 ? "completed" : "failed",
          finishedAt: now(),
          exitCode: code ?? -1,
        };
        writeRecord(finished);
        opts.onComplete?.(runId, finished);
      });

      // Best-effort: capture the opencode session id from the first output
      // event (diagnostics / future re-attach). Never blocks spawn.
      void (async () => {
        const deadline = Date.now() + sessionIdTimeoutMs;
        while (Date.now() < deadline) {
          try {
            const text = readFileSync(logPath, "utf8");
            const m = text.match(SESSION_ID_RE);
            if (m) {
              const rec = readRecord(runId);
              if (rec && !rec.sessionId) writeRecord({ ...rec, sessionId: m[1] });
              return;
            }
          } catch {
            // log not written yet — keep polling
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })();

      return runId;
    },

    async fleetStatus() {
      let totalActive = 0;
      try {
        const runs = existsSync(runsDir) ? readdirSync(runsDir) : [];
        for (const runId of runs) {
          const rec = readRecord(runId);
          if (!rec || rec.status !== "running") continue;
          // Liveness: the process may have died without the exit handler
          // (e.g. the orchestrator restarted) — count only living pids.
          if (rec.pid > 0) {
            try {
              process.kill(rec.pid, 0);
              totalActive++;
            } catch {
              // ESRCH — dead; the exit handler will finalize when observed
            }
          } else {
            totalActive++;
          }
        }
      } catch {
        // unreadable runs dir — report 0 (fail-safe to action)
      }
      return { totalActive };
    },

    async steer() {
      throw new Error(
        "opencode headless runs (oc run) have no steering channel — stop + re-dispatch instead",
      );
    },

    asyncDirFor(runId) {
      const dir = join(runsDir, runId);
      return existsSync(join(dir, "status.json")) ? dir : null;
    },
  };
}
