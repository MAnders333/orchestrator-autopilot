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
import { createFrameworkRunner } from "../framework/runner.ts";
import { flagForReview } from "../framework/flag-review.ts";

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
  /** Tick delivery — the plugin's promptAsync injector (session-targeted). */
  delivery?: TickDelivery;
  /** Domain-event sink (orch:reviewer-dispatched, orch:verdict, ...). */
  onDomainEvent?: (e: { name: string; data?: Record<string, unknown> }) => void;
  sweepIntervalMs?: number; // 0 disables the timer (default 10 min, like the pi extension)
}

export interface OpenCodeFramework {
  backend: ReturnType<typeof createOpenCodeBackend>;
  autopilot: Autopilot;
  tools: Record<string, OpenCodeToolDef>;
  /** The orchestrator's session settled (session.idle) → settled sweep. */
  onSettled(): void;
  /** Feed a session event (busy tracking + settled + tick target). */
  handleSessionEvent(event: unknown): void;
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

  const isHeadlessRun = process.argv.includes("run"); // oc run = one-shot (no live ticks)
  let busy = false; // session.status busy/idle tracking

  // The completion event build (reviewer verdict from the run output).
  const buildEvent = (runId: string, rec: OpenCodeRunRecord): Record<string, unknown> => {
    const output = rec.agent === reviewerAgent ? readLatestText(rec.logPath) : undefined;
    return {
      runId,
      agent: rec.agent,
      success: rec.status === "completed",
      status: rec.status === "completed" ? "completed" : "failed",
      results: output ? [{ agent: rec.agent, output }] : [],
    };
  };

  const backend = createOpenCodeBackend({ runsDir, ocBin: opts.ocBin, onComplete: (runId, rec) => runner.onCompletion(buildEvent(runId, rec) as never) });

  // The shared runner: identical trigger machinery in both hosts (see
  // src/framework/runner.ts). The opencode host supplies its gate state +
  // the promptAsync delivery; the pi host supplies the same shape with
  // sendMessage.
  const runner = createFrameworkRunner({
    stateDir,
    autopilot,
    backend,
    host: {
      interactive: () => !!opts.delivery?.target() && !isHeadlessRun,
      loaded: () => true, // the plugin IS the orchestrator context in opencode
      busy: () => busy,
      compacting: () => false,
    },
    deliver: (message) => opts.delivery?.deliver(message),
    emit: (e) => e.forEach((x) => opts.onDomainEvent?.(x as { name: string; data?: Record<string, unknown> })),
    enabled: () => true,
    sweepIntervalMs: opts.sweepIntervalMs ?? cfg.sweepIntervalMs,
  });

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
      "List the orchestrator task queue (opencode host). Filter by status/since/sort; compact view by default, heavy fields only with includeNotes. Returns per-status counts + fleet occupancy + matching items.",
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
      ],
      (a) => queueAdd(ctx, a),
    ),
    queue_update: def(
      "Update a queue item: status (validated transitions: proposal→approved/rejected, approved→active/rejected, active→reviewing/failed, reviewing→done/failed/active, failed→active, done→approved (human re-open — you found issues in your review)), blocker, or free-form notes. active→reviewing/failed are event-driven — do NOT set them by hand.",
      [
        { name: "key", type: "string", required: true },
        { name: "status", type: "string", required: false },
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
      "Dispatch a queue item: spawns the worker (fresh context, worktree isolation) AND records approved→active with the run id — atomically. Call with the key of an approved item and the scoped worker prompt. High-risk items: surface the final checkpoint BEFORE calling. Returns the run id.",
      [
        { name: "key", type: "string", required: true, description: "queue key of an approved item" },
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

  // Periodic capacity sweep — owned by the shared runner (identical machinery
  // in both hosts).
  runner.start();

  return {
    backend,
    autopilot,
    tools,
    onSettled: () => runner.onSettled(),
    handleSessionEvent(event: unknown) {
      const e = event as { type?: string; properties?: { sessionID?: string; status?: { type?: string } } };
      const sid = e.properties?.sessionID;
      if (sid) opts.delivery?.setTarget(sid);
      if (e.type === "session.status") busy = e.properties?.status?.type === "busy";
      if (e.type === "session.idle") {
        busy = false;
        runner.onSettled();
      }
    },
    dispose() {
      runner.stop();
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
          body: { parts: [{ type: "text", text: message }] },
        })
        .catch((err) => log(`[orch-tick] inject failed: ${err instanceof Error ? err.message : String(err)}`));
    },
  };
}

export const OrchestratorAutopilot: Plugin = async (ctx) => {
  const delivery = createTickDelivery(ctx.client as unknown as PromptClient);
  const fw = createOpenCodeFramework({
    stateDir: resolveStateDir(),
    delivery,
  });

  tools.autopilot = tool({
    description:
      "Toggle or query the orchestrator autopilot for THIS session. on: enable ticks + the intake/dispatch/review nudges; off: disable them (the queue tools stay available); status: show the current state + capacity; capacity <n>: set the worker slot limit. The toggle is per-session (like the pi /autopilot command).",
    args: {
      action: tool.schema.string().describe("on | off | status | capacity"),
      value: tool.schema.string().optional().describe("capacity value (when action=capacity)"),
    },
    execute: async (args) => {
      const sid = delivery.target();
      const action = String(args.action ?? "").trim();
      try {
        switch (action) {
          case "on":
            writeSessionAutopilotState(stateDir, sid ?? "", "on");
            return `Autopilot ON for session ${(sid ?? "?").slice(0, 8)} — ticks + capacity nudges enabled. (Turn it on in the session that should orchestrate.)`;
          case "off":
            writeSessionAutopilotState(stateDir, sid ?? "", "off");
            return `Autopilot OFF for session ${(sid ?? "?").slice(0, 8)} — ticks disabled; queue tools remain available.`;
          case "status": {
            const st = isAutopilotOn(stateDir, sid);
            const cfg = loadAutopilotConfig(stateDir);
            return `Autopilot ${st ? "ON" : "OFF"} (this session${sid ? " " + sid.slice(0, 8) : ""}) — capacity ${cfg.maxSlots} workers, queue-low < ${cfg.queueLowThreshold} ready.`;
          }
          case "capacity": {
            const n = Number(String(args.value ?? "").trim());
            if (!Number.isFinite(n) || n < 1) return "Usage: autopilot capacity <n> (n ≥ 1)";
            saveAutopilotConfig(stateDir, { ...loadAutopilotConfig(stateDir), maxSlots: n });
            return `Worker capacity set to ${n} (takes effect immediately).`;
          }
          default:
            return "Usage: autopilot on | off | status | capacity <n>";
        }
      } catch (err) {
        return `autopilot failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  tools.flag_for_review = tool({
    description:
      "Flag that you believe the current task is complete and ready for the user's judgment. Call this ONLY when you believe the work is done — not after every turn, not when you have a question. Reason explicitly about risk (what happens if wrong) and blast radius (what breaks) before flagging. self_reviewed=true when an automated review passed (commit-hook / reviewer-subagent), else false.",
    args: {
      summary: tool.schema.string().describe("What was done (one line)"),
      risk: tool.schema.string().describe("low | medium | high"),
      blast_radius: tool.schema.string().describe("What breaks if this is wrong — be specific"),
      review_targets: tool.schema.array(tool.schema.string()).describe("WHERE to review: file paths, path:line ranges, commit SHAs, MR/PR links"),
      self_reviewed: tool.schema.boolean().describe("true if an automated review passed, else false"),
      review_method: tool.schema.string().describe("commit-hook | reviewer-subagent | none"),
      action_needed: tool.schema.string().optional().describe("What the user should DO after reviewing"),
      residual_risks: tool.schema.string().optional().describe("What was NOT verified / could change"),
      queue_key: tool.schema.string().optional().describe("The queue item this flag came from"),
    },
    execute: async (args) => {
      const { deliveryNote } = flagForReview(args as never);
      return `Flagged for review. Risk: ${args.risk}. ${deliveryNote}`;
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
    // Feed session events to the framework: busy tracking, the tick target,
    // and the settled sweep (session.idle).
    event: async ({ event }) => {
      fw.handleSessionEvent(event);
    },
  };
};
