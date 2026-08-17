import { tool, type Plugin } from "@opencode-ai/plugin";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { createOpenCodeBackend, defaultRunsDir } from "../backends/opencode.ts";
import type { OpenCodeRunRecord } from "../backends/types.ts";
import { Autopilot } from "../core.ts";
import { loadAutopilotConfig, type AutopilotConfig } from "../config.ts";
import { loadStore, newStore } from "../queue-store.ts";
import {
  queueList, queueAdd, queueUpdate, queueDispatch, queueReview, queueSteer, repoCheck,
  type QueueOpsCtx, type ToolResult,
} from "../tools/queue-ops.ts";
import { installOpenCodeReviewer, installOpenCodeWorker } from "../agents/install.ts";

// opencode-plugin.ts — the opencode HOST (one file per host, symmetric with
// hosts/pi-extension.ts). Two layers in one file:
//
//   1. HOST LOGIC — createOpenCodeFramework: wires the opencode backend + the
//      six shared queue tools (tools/queue-ops.ts) + completion (backend
//      process-exit → core.handleAsyncComplete → queue flips + Verdict:
//      PASS/FAIL routing) + the periodic capacity sweep + the framework agent
//      projections. No @opencode-ai/plugin dependency — the logic is the
//      framework's, testable without the opencode runtime.
//   2. ADAPTER — OrchestratorAutopilot (the Plugin opencode loads): maps the
//      tools to the tool() API, tracks the orchestrator session via the event
//      hook, and delivers ticks into it (client.session.promptAsync).
//
// Registered in the global opencode.jsonc `plugin` array (work + personal;
// the state dir resolves per mode).
//
// TICK DELIVERY (verified): the sweep → onTick → promptAsync pipeline works
// end-to-end (the API accepts the injection). LIMITATION: a headless one-shot
// `oc run` never PROCESSES queued prompts (it runs its initial prompt and
// exits), so live ticks only reach a persistent session — the interactive TUI
// orchestrator (opencode's prompt_async is the async-prompting path live
// sessions consume). A serve-based orchestrator would also receive them.

export interface ArgSpec {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
}

export interface OpenCodeToolDef {
  description: string;
  args: ArgSpec[];
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface OpenCodeFrameworkOptions {
  stateDir: string;
  runsDir?: string;
  ocBin?: string;
  config?: Partial<AutopilotConfig>;
  /** Tick sink — the opencode plugin routes this to the orchestrator session. */
  onTick?: (message: string) => void;
  /** Domain-event sink (orch:reviewer-dispatched, orch:verdict, ...). */
  onDomainEvent?: (e: { name: string; data?: Record<string, unknown> }) => void;
  sweepIntervalMs?: number; // 0 disables the timer (default 10 min, like the pi extension)
}

export interface OpenCodeFramework {
  backend: ReturnType<typeof createOpenCodeBackend>;
  autopilot: Autopilot;
  tools: Record<string, OpenCodeToolDef>;
  dispose(): void;
}

/** Extract the reviewer's reply (last text event) from a run's output.jsonl —
 *  the verdict contract anchors on the first non-empty line of that reply. */
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

export function createOpenCodeFramework(opts: OpenCodeFrameworkOptions): OpenCodeFramework {
  const stateDir = opts.stateDir;
  const runsDir = opts.runsDir ?? defaultRunsDir();
  const cfg = loadAutopilotConfig(stateDir);
  const autopilot = new Autopilot({ stateDir, ...opts.config });

  const storeOrNew = () => loadStore(stateDir) ?? newStore();
  const reviewerAgent = cfg.reviewerAgents[0] ?? "orchestrator-reviewer";

  const onComplete = (runId: string, rec: OpenCodeRunRecord): void => {
    const output = rec.agent === reviewerAgent ? readLatestText(rec.logPath) : undefined;
    const ev = {
      runId,
      agent: rec.agent,
      success: rec.status === "completed",
      status: rec.status === "completed" ? "completed" : "failed",
      results: output ? [{ agent: rec.agent, output }] : [],
    } as Record<string, unknown>;
    const result = autopilot.handleAsyncComplete(ev);
    for (const e of result.domainEvents) opts.onDomainEvent?.(e as { name: string; data?: Record<string, unknown> });
    if (result.tick?.message) opts.onTick?.(result.tick.message);
    if (result.freedSlot) {
      void (async () => {
        const fleet = await backend.fleetStatus();
        const sweep = autopilot.sweep("worker-done", Date.now(), fleet ? { totalActive: fleet.totalActive } : undefined);
        if (sweep.tick?.message) opts.onTick?.(sweep.tick.message);
      })();
    }
    if (result.reviewerCompleted) {
      const t = autopilot.reviewTick();
      if (t?.message) opts.onTick?.(t.message);
    }
  };

  const backend = createOpenCodeBackend({ runsDir, ocBin: opts.ocBin, onComplete });

  const ctx: QueueOpsCtx = {
    stateDir,
    backend,
    storeOrNew,
    autopilot: () => autopilot,
    cfg: () => loadAutopilotConfig(stateDir),
    emit: (e) => e.forEach((x) => opts.onDomainEvent?.(x as { name: string; data?: Record<string, unknown> })),
    repoCheck,
    sessionCwd: process.cwd(),
  };

  const def = (description: string, args: ArgSpec[], execute: (a: Record<string, unknown>) => Promise<ToolResult>): OpenCodeToolDef =>
    ({ description, args, execute });

  const tools: Record<string, OpenCodeToolDef> = {
    queue_list: def(
      "List the orchestrator task queue. Filter by status/since/sort; compact view by default, heavy fields only with includeNotes. Returns per-status counts + fleet occupancy + matching items.",
      [
        { name: "status", type: "string", required: false, description: "status filter (proposal|approved|active|reviewing|failed|done)" },
        { name: "since", type: "string", required: false, description: "ISO timestamp — only items with updatedAt >= since" },
        { name: "sort", type: "string", required: false, description: "updatedAt|createdAt|key (default updatedAt desc)" },
        { name: "limit", type: "number", required: false, description: "max items (default 50)" },
        { name: "includeNotes", type: "boolean", required: false, description: "include scope/evidence/value/urgency/risk/notes" },
      ],
      (a) => queueList(ctx, a),
    ),
    queue_add: def(
      "Add a new queue item (proposal by default, or approved). Notes/scope are free-form — no schema constraints on content.",
      [
        { name: "key", type: "string", required: true, description: "unique key, e.g. B4-AGENTIC-JUDGE-TIMEOUT" },
        { name: "title", type: "string", required: true },
        { name: "status", type: "string", required: false, description: "proposal (default) | approved" },
        { name: "scope", type: "string", required: false },
        { name: "evidence", type: "string", required: false },
        { name: "value", type: "string", required: false },
        { name: "urgency", type: "string", required: false },
        { name: "risk", type: "string", required: false },
        { name: "notes", type: "string", required: false },
        { name: "ready", type: "boolean", required: false },
      ],
      (a) => queueAdd(ctx, a),
    ),
    queue_update: def(
      "Update a queue item: status (validated transitions: proposal→approved/rejected, approved→active/rejected, active→reviewing/failed, reviewing→done/failed/active, failed→active), ready flag, blocker, or free-form notes. active→reviewing/failed are event-driven — do NOT set them by hand.",
      [
        { name: "key", type: "string", required: true },
        { name: "status", type: "string", required: false },
        { name: "ready", type: "boolean", required: false },
        { name: "blocker", type: "string", required: false },
        { name: "title", type: "string", required: false },
        { name: "scope", type: "string", required: false },
        { name: "evidence", type: "string", required: false },
        { name: "value", type: "string", required: false },
        { name: "urgency", type: "string", required: false },
        { name: "risk", type: "string", required: false },
        { name: "notes", type: "string", required: false },
      ],
      (a) => queueUpdate(ctx, a),
    ),
    queue_dispatch: def(
      "Dispatch a queue item: spawns the worker (fresh context, worktree isolation) AND records approved→active with the run id — atomically. Call with the key of an approved+ready item and the scoped worker prompt. High-risk items: surface the final checkpoint BEFORE calling. Returns the run id.",
      [
        { name: "key", type: "string", required: true, description: "queue key of an approved+ready item" },
        { name: "task", type: "string", required: true, description: "the scoped worker prompt (self-contained; KEY: <key> as first line is recommended)" },
        { name: "cwd", type: "string", required: false, description: "repo the worker operates on (worktree isolation runs THERE). REQUIRED when the session cwd is not the target repo." },
        { name: "timeoutMs", type: "number", required: false },
      ],
      (a) => queueDispatch(ctx, a),
    ),
    queue_review: def(
      "Dispatch the reviewer for a `reviewing` item: spawns the reviewer (read-only, no worktree), records the reviewerRunId, and emits orch:reviewer-dispatched. When the reviewer completes, the framework parses its first-line 'Verdict: PASS/FAIL' and auto-transitions (PASS → done, FAIL → active re-dispatch, cap → failed).",
      [
        { name: "key", type: "string", required: true, description: "queue key of a `reviewing` item" },
        { name: "task", type: "string", required: false, description: "optional reviewer prompt; the verdict contract is injected if omitted" },
        { name: "timeoutMs", type: "number", required: false },
      ],
      (a) => queueReview(ctx, a),
    ),
    queue_steer: def(
      "Steer a RUNNING worker or reviewer. Headless opencode runs (oc run) have NO steering channel — the backend honestly refuses; stop + re-dispatch instead.",
      [
        { name: "key", type: "string", required: true, description: "queue key of the running worker/reviewer" },
        { name: "message", type: "string", required: true, description: "the steering instruction (interrupt-and-deliver)" },
        { name: "mode", type: "string", required: false, description: "steer (interrupt, default) | follow_up (queued until idle)" },
        { name: "ackTimeoutMs", type: "number", required: false },
      ],
      (a) => queueSteer(ctx, a),
    ),
  };

  // Ensure the framework-owned agents are projected into opencode's agents dir
  // (idempotent, version-stamped). Never throws — a missing agent surfaces as
  // a spawn error downstream (queue_dispatch would fail with 'agent not found').
  try {
    installOpenCodeReviewer({ log: (l) => opts.onDomainEvent?.({ name: "orch:reviewer-installed", data: { log: l } }) });
    installOpenCodeWorker({ log: (l) => opts.onDomainEvent?.({ name: "orch:worker-installed", data: { log: l } }) });
  } catch {
    // silent
  }

  // Periodic capacity sweep (mirrors the pi extension's timer).
  let timer: ReturnType<typeof setInterval> | null = null;
  const intervalMs = opts.sweepIntervalMs ?? cfg.sweepIntervalMs ?? 600_000;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      try {
        const sweep = autopilot.sweep("timer", Date.now());
        if (sweep.tick?.message) opts.onTick?.(sweep.tick.message);
        const rt = autopilot.reviewTick();
        if (rt?.message) opts.onTick?.(rt.message);
      } catch {
        // never let the timer break opencode
      }
    }, intervalMs);
  }

  return {
    backend,
    autopilot,
    tools,
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function resolveStateDir(): string {
  if (process.env.AUTOPILOT_STATE_DIR) return process.env.AUTOPILOT_STATE_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  return agentDir.includes("personal")
    ? join(homedir(), ".local/state/orchestrator-personal")
    : join(homedir(), ".local/state/orchestrator");
}

function argsSchema(specs: ArgSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    let v: unknown = s.type === "number" ? tool.schema.number() : s.type === "boolean" ? tool.schema.boolean() : tool.schema.string();
    if (s.description) v = (v as { describe?: (d: string) => unknown }).describe?.(s.description) ?? v;
    out[s.name] = s.required ? v : (v as { optional?: () => unknown }).optional?.() ?? v;
  }
  return out;
}

/** The opencode SDK client surface the delivery needs (injectable for tests). */
export interface PromptClient {
  session: {
    promptAsync(options: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }): Promise<unknown>;
  };
}

export interface TickDelivery {
  /** The current tick target session id (undefined until a session event is seen). */
  target(): string | undefined;
  /** Record the session id from an event (session.* events carry it). */
  setTarget(sessionID: string | undefined): void;
  /** Deliver a tick: inject into the target session, or console-fallback. */
  deliver(message: string): void;
}

/**
 * The opencode tick-delivery mechanism (extracted for hermetic testing):
 * tracks the orchestrator session id and injects tick messages via
 * client.session.promptAsync. Never throws — a delivery failure degrades to
 * the console log.
 */
export function createTickDelivery(client: PromptClient, log: (line: string) => void = console.log): TickDelivery {
  let target: string | undefined;
  return {
    target: () => target,
    setTarget(sessionID) {
      if (typeof sessionID === "string" && sessionID) target = sessionID;
    },
    deliver(message) {
      if (!target) {
        log(`[orch-tick] ${message}`);
        return;
      }
      void client.session
        .promptAsync({
          path: { id: target },
          body: { parts: [{ type: "text", text: `[orch-tick] ${message}` }] },
        })
        .catch((err) => log(`[orch-tick] inject failed: ${err instanceof Error ? err.message : String(err)}`));
    },
  };
}

export const OrchestratorAutopilot: Plugin = async (ctx) => {
  const delivery = createTickDelivery(ctx.client as unknown as PromptClient);
  const fw = createOpenCodeFramework({
    stateDir: resolveStateDir(),
    onTick: (message) => {
      delivery.deliver(message);
    },
  });

  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const [name, def] of Object.entries(fw.tools)) {
    tools[name] = tool({
      description: def.description,
      args: argsSchema(def.args),
      execute: async (args) => (await def.execute(args as Record<string, unknown>)).text,
    });
  }

  return {
    tool: tools,
    // Track the orchestrator session (tick target) from session events.
    event: async ({ event }) => {
      const sid = (event as { properties?: { sessionID?: string } }).properties?.sessionID;
      if (sid) delivery.setTarget(sid);
    },
  };
};
