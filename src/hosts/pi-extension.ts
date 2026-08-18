// orchestrator-autopilot.ts — pi adapter for the orchestrator autopilot.
//
// The framework core lives in THIS project (src/).
// (imported at runtime via jiti, same pattern as corrections.ts).
//
// The extension owns the PROGRAMMATIC QUEUE (queue.json) and the FLEET ledger
// (event-derived). The orchestrator interacts with the queue via tools:
//   queue_list     — read path (filter by status / last-change, compact view)
//   queue_add      — new proposal/approved item
//   queue_update   — status/flags/notes (validated transitions)
//   queue_dispatch — spawn the worker (same executor as subagent) AND record
//                    approved→active + runId atomically (worktree isolation
//                    enforced: dirty-tree pre-flight + blocked direct spawns)
//   queue_review   — spawn the reviewer for a `reviewing` item
//   queue_steer    — steer a running worker/reviewer via the control channel
// Completion (active→reviewing/failed) is event-inferred from
// subagent:async-complete. state.md is retired: it exists only as a one-time
// migration input (imported into queue.json on first activation).
//
// All subagent-runtime specifics (RPC spawn/fleet, control-channel steer, run
// dir resolution) live behind the backend seam
// (src/backends/) so the queue tools depend
// on an interface, not on pi-subagents internals.
//
// Behavior gated per-session (autopilot.sessions.json), interactive TUI only:
//   - /autopilot on|off|status|capacity <n>
//   - ticks via custom-role sendMessage (customType orchestrator-autopilot)
//   - children (async runners, --mode json -p) NEVER inject or tick.
//
// Design rules: NEVER throw (a broken autopilot must not affect pi); fail-safe
// to action; trigger-only (the orchestrator keeps all judgment).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync as fsExistsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// The framework lib is THIS project — the extension lives at src/hosts/ and
// requires the lib relative to itself (no dotfiles-layout assumption). A
// published/installed layout can override via AUTOPILOT_LIB_DIR.
const LIB_DIR = (() => {
  if (process.env.AUTOPILOT_LIB_DIR) return process.env.AUTOPILOT_LIB_DIR;
  return join(__dirname, "..");
})();
// jiti resolves .ts imports at runtime; createRequire keeps this ESM-safe.
const { Autopilot } = require(`${LIB_DIR}/core.ts`) as typeof import("./core.ts");
const { loadAutopilotConfig, saveAutopilotConfig, readSessionAutopilotState, writeSessionAutopilotState, isAutopilotOn, appendTelemetry, parseStateDirFromCommand, autopilotModeMessage } = require(`${LIB_DIR}/config.ts`) as typeof import("./config.ts");
const { loadStore, saveStore, newStore, queryItems, addItem, updateItem, queueLengths, migrateFromMd } = require(`${LIB_DIR}/queue-store.ts`) as typeof import("./queue-store.ts");
const { createSubagentBackend, defaultRunsDir } = require(`${LIB_DIR}/backends/index.ts`) as typeof import("./backends/index.ts");
const { queueList, queueAdd, queueUpdate, queueDispatch, queueReview, queueSteer, repoCheck } = require(`${LIB_DIR}/tools/queue-ops.ts`) as typeof import("./tools/queue-ops.ts");
const { createFrameworkRunner } = require(`${LIB_DIR}/framework/runner.ts`) as typeof import("./framework/runner.ts");
const { flagForReview } = require(`${LIB_DIR}/framework/flag-review.ts`) as typeof import("./framework/flag-review.ts");
const { installPiReviewer } = require(`${LIB_DIR}/agents/install.ts`) as typeof import("./agents/install.ts");
const { existsSync, readFileSync, renameSync } = require("node:fs") as typeof import("node:fs");

// Install the framework-owned reviewer agent (idempotent, version-stamped).
// The framework DEPENDS on the reviewer (queue_review spawns it, the lifecycle
// parses its verdict) — shipping it with the extension is what makes the
// review step work on any machine, not just this dotfiles stack. Never throw:
// a broken install must not affect pi (the queue_review fail-closed check
// surfaces a missing reviewer if install ever fails).
try {
  installPiReviewer();
} catch {
  // silent — fail-closed check in queue_review reports if the agent is absent
}

const TICK_TYPE = "orchestrator-autopilot";

function resolveStateDir(): string | null {
  if (process.env.AUTOPILOT_STATE_DIR) return process.env.AUTOPILOT_STATE_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (agentDir) {
    const promptFile = join(agentDir, "prompts/orchestrate.md");
    if (existsSync(promptFile)) {
      const parsed = parseStateDirFromCommand(promptFile);
      if (parsed) return parsed;
    }
    return agentDir.includes("personal")
      ? join(homedir(), ".local/state/orchestrator-personal")
      : join(homedir(), ".local/state/orchestrator");
  }
  return null; // unknown mode → fail closed
}

export default function (pi: ExtensionAPI) {
  const stateDir = resolveStateDir();
  // Fail closed: without a resolvable mode, stay fully inert.
  if (!stateDir) return;

  let autopilot: InstanceType<typeof Autopilot> | null = null;
  let agentBusy = false;          // orchestrator (main agent) mid-turn
  let compacting = false;         // auto-compaction in progress — never inject into it
  let interactive = false;        // true only in the interactive TUI session
  let sessionId = "";             // current pi session id (per-session autopilot scope)
  let orchestratorLoaded = false; // /orchestrate injected into this session

  function ensureAutopilot() {
    if (autopilot) return autopilot;
    const cfg = loadAutopilotConfig(stateDir);
    autopilot = new Autopilot({
      stateDir,
      maxSlots: cfg.maxSlots,
      queueLowThreshold: cfg.queueLowThreshold,
      workerAgents: cfg.workerAgents,
      reviewerAgents: cfg.reviewerAgents,
      reviewCap: cfg.reviewCap,
      log: (line) => {
        if (isAutopilotOn(stateDir, sessionId)) appendTelemetry(stateDir, line);
      },
    });
    return autopilot;
  }

  function storeOrNew() {
    return loadStore(stateDir) ?? newStore();
  }

  /** Subagent-runtime seam — see src/backends/. The backend is DEDUCED from
   *  the runtime, never env: this extension IS pi, so workers spawn on the
   *  pi-subagents backend (the opencode plugin wires its own opencode
   *  backend + completion signal to the same queue tools). */
  const backend = createSubagentBackend({ kind: "pi", pi: pi as never });

  /** One-time migration: import a legacy state.md into the programmatic store. */
  function ensureMigrated() {
    try {
      if (loadStore(stateDir)) return;
      const mdPath = join(stateDir, "state.md");
      if (!existsSync(mdPath)) return;
      const store = migrateFromMd(readFileSync(mdPath, "utf8"));
      saveStore(stateDir, store);
      const archived = `${mdPath}.migrated-${Date.now()}`;
      try {
        renameSync(mdPath, archived);
      } catch {
        // keep the original if rename fails — the store is authoritative now
      }
    } catch {
      // migration is best-effort; autopilot still works on an empty store
    }
  }

  function maybeInjectOrchestrate() {
    // Never inject into child/headless processes (async runners are
    // --mode json -p): their session_start must not load orchestrator mode or
    // collide with the runner's task prompt. Also per-session: only the session
    // that turned autopilot on gets orchestrator mode injected.
    if (!interactive || !sessionId) return;
    if (!isAutopilotOn(stateDir, sessionId)) return;
    if (orchestratorLoaded) return;
    orchestratorLoaded = true; // assume success; reset on failure or session_start
    // deliverAs: "followUp" is REQUIRED — sendUserMessage THROWS "Agent is
    // already processing..." while the agent is streaming (e.g. mid-command),
    // and the rejection is async so a sync try/catch cannot contain it.
    // followUp queues the injection until the current turn finishes.
    try {
      const sent = pi.sendUserMessage("/orchestrate", {
        expandPromptTemplates: true,
        deliverAs: "followUp",
      });
      if (sent && typeof (sent as Promise<void>).catch === "function") {
        void (sent as Promise<void>).catch(() => {
          orchestratorLoaded = false;
        });
      }
    } catch {
      // A synchronous throw (busy agent edge cases) must NOT take down the
      // /autopilot command — the runner + ticks keep working; the injection
      // retries on the next settled/completion event.
      orchestratorLoaded = false;
    }
  }

  let lastTickSentAt = 0;
  const TICK_COOLDOWN_MS = 1500;
  // The shared tick machinery (gate + cooldown + delivery) lives in
  // src/framework/runner.ts — identical in both hosts. The pi host supplies
  // its gate state + the sendMessage delivery; runSweep/onCompletion etc.
  // wire the triggers.
  const runner = createFrameworkRunner({
    stateDir,
    autopilot: ensureAutopilot(),
    backend,
    host: {
      interactive: () => interactive,
      loaded: () => orchestratorLoaded,
      busy: () => agentBusy,
      compacting: () => compacting,
    },
    deliver: (message) => {
      // pi.sendMessage is declared `: void` (not a Promise) — the runtime
      // sometimes returns a thenable and sometimes undefined. Never assume:
      // guard the catch so an undefined return cannot crash pi.
      const sent = pi.sendMessage(
        { customType: TICK_TYPE, content: message, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      if (sent && typeof (sent as Promise<void>).catch === "function") {
        void (sent as Promise<void>).catch(() => {
          // silent — next event retries
        });
      }
    },
    emit: (e) => emitDomain(e as never),
    enabled: () => isAutopilotOn(stateDir, sessionId),
    sweepIntervalMs: loadAutopilotConfig(stateDir).sweepIntervalMs,
  });
  /** Inform the ORCHESTRATOR (not the user) when the autopilot toggle changes —
   *  the harness's behavior flips entirely between the two modes and the agent
   *  must know which one it is running under. Best-effort: a busy-agent sync
   *  throw must not fail the command (followUp + guard, same as injection). */
  function informOrchestrator(mode: "on" | "off") {
    // The message is the framework's (autopilotModeMessage) — this host only
    // DELIVERS it (followUp so a busy agent cannot fail the command).
    const msg = autopilotModeMessage(mode);
    try {
      const sent = pi.sendUserMessage(msg, { deliverAs: "followUp" });
      if (sent && typeof (sent as Promise<void>).catch === "function") {
        void (sent as Promise<void>).catch(() => {});
      }
    } catch {
      // best-effort — the command itself already succeeded
    }
  }

  /** Publish structured domain events on the in-process bus (orch:*). */
  function emitDomain(events: Array<{ name: string; data: Record<string, unknown> }>) {
    for (const e of events) {
      try {
        pi.events.emit(e.name, { ...e.data, t: Date.now() });
      } catch {
        // silent
      }
    }
  }

  /** B26: block direct worker subagent spawns without worktree isolation. */
  pi.on("tool_call", (event) => {
    if (!interactive || !isAutopilotOn(stateDir, sessionId)) return;
    if (event.toolName !== "subagent") return;
    const args = (event.input ?? {}) as { agent?: string; worktree?: boolean; action?: string };
    if (args.action !== undefined) return; // status/steer/stop/inspector — not spawns
    if (!args.agent || !loadAutopilotConfig(stateDir).workerAgents.includes(args.agent)) return;
    if (args.worktree === true) return; // explicitly isolated
    return {
      block: true,
      reason:
        "Worker dispatch without worktree isolation is BLOCKED by the autopilot — use queue_dispatch instead " +
        "(it enforces worktree:true). A direct subagent worker spawn runs in the main checkout, dirties it, and breaks " +
        "worktree isolation for all parallel workers (B26: B20's strays blocked B22/B23 at launch).",
    };
  });

  /** git helper (best-effort; resolves stdout + ok flag). */
  function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; err?: string }> {
    return new Promise((resolve) => {
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      execFile("git", ["-C", cwd, ...args], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ ok: false, stdout: "", err: String(err) });
        resolve({ ok: true, stdout: String(stdout) });
      });
    });
  }

  /** Pre-flight for worktree isolation. FAIL-CLOSED: the worker's worktree is
   *  created in the TARGET repo, which must be a clean git checkout. Mirrors
   *  pi-subagents' own check (status --porcelain, untracked included,
   *  .pi/subagents excluded) so we never pass a dispatch the launcher would
   *  then reject. A session cwd that is NOT a repo (e.g. a parent dir with workers
   *  targeting a repo the session is not inside) is a clear error, not a silent skip — that
   *  skip class caused every dispatch to fail at spawn with the cryptic
   *  'worktree isolation requires a git repository'. */

  // -- lifecycle -------------------------------------------------------------

  pi.on("agent_start", () => {
    agentBusy = true;
    compacting = false; // failsafe: a run beginning means compaction finished or was cancelled
  });
  pi.on("agent_settled", () => {
    agentBusy = false;
    runner.onSettled(); // queue may have changed while the orchestrator worked
  });
  // A tick delivered DURING auto-compaction aborts it ('Turn prefix
  // summarization failed: This operation was aborted') — the runtime can't
  // interleave a triggered turn with the summarization LLM call. agentBusy is
  // false in the compaction window (it sits between agent_end and the next
  // run), so gate on the compaction events explicitly.
  pi.on("session_before_compact", () => { compacting = true; });
  pi.on("session_compact", () => { compacting = false; });
  pi.on("session_start", (event, ctx) => {
    compacting = false;
    interactive = ctx?.mode === "tui";
    sessionId = (ctx?.sessionManager?.getSessionId?.() as string | undefined) ?? "";
    orchestratorLoaded = false;
    maybeInjectOrchestrate(); // persisted per-session state → auto-load orchestrator mode
  });

  // -- periodic capacity sweep (deterministic safety net) --------------------
  // The timer is owned by the shared runner (identical machinery in both
  // hosts); pi gates it via enabled() = autopilot-on for this session.
  runner.start();
  pi.on("session_shutdown", () => {
    runner.stop();
  });

  // -- subagent lifecycle (in-process bus, emitted by pi-subagents) ----------

  pi.events.on("subagent:async-started", (payload: unknown) => {
    if (!interactive || !isAutopilotOn(stateDir, sessionId)) return;
    // The started event carries the workflow/async id under `id` (not `runId`).
    const p = payload as { id?: string; runId?: string; agent?: string } | null;
    const runId = p?.runId ?? p?.id;
    if (!runId) return;
    ensureAutopilot().handleAsyncStarted(runId, p?.agent);
  });

  pi.events.on("subagent:async-complete", (payload: unknown) => {
    if (!interactive) return; // the RUNNER gates the autopilot toggle (shared)
    maybeInjectOrchestrate();
    // Attribute the completion (active→reviewing/failed), route the verdict,
    // and sweep — the shared runner owns this logic (identical in opencode).
    runner.onCompletion((payload ?? {}) as never);
  });

  // -- queue tools -----------------------------------------------------------

  // Shared queue ops — the six tools are host-agnostic implementations in
  // lib/orchestrator-autopilot/src/tools/queue-ops.ts (the opencode plugin
  // registers the SAME handlers). This ctx binds them to the pi host.
  const opsFor = (ctx?: { cwd?: string }): import("./tools/queue-ops.ts").QueueOpsCtx => ({
    stateDir,
    backend,
    storeOrNew,
    autopilot: () => ensureAutopilot(),
    cfg: () => loadAutopilotConfig(stateDir),
    emit: (e) => emitDomain(e as never),
    repoCheck,
    sessionCwd: ctx?.cwd,
  });

  pi.registerTool({
    name: "queue_list",
    label: "Queue list",
    description:
      "List the orchestrator task queue (pi host — the programmatic store). Filter by status and/or last-change timestamp; compact view by default " +
      "(heavy free-form fields only with includeNotes). Returns per-status counts + fleet occupancy (event-derived) + matching items.",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.String({ description: "status filter (proposal|approved|active|reviewing|failed|done)" }), Type.Array(Type.String())])),
      since: Type.Optional(Type.String({ description: "ISO timestamp — only items with updatedAt >= since" })),
      sort: Type.Optional(Type.String({ description: "updatedAt|createdAt|key (default updatedAt desc)" })),
      limit: Type.Optional(Type.Number({ description: "max items (default 50)" })),
      includeNotes: Type.Optional(Type.Boolean({ description: "include scope/evidence/value/urgency/risk/notes" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await queueList(opsFor(ctx), params as never);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });

  pi.registerTool({
    name: "queue_add",
    label: "Queue add",
    description: "Add a new queue item (proposal by default, or approved). Notes/scope are free-form — no schema constraints on content.",
    parameters: Type.Object({
      key: Type.String({ description: "unique key, e.g. B4-AGENTIC-JUDGE-TIMEOUT" }),
      status: Type.Optional(Type.String({ description: "proposal (default) | approved" })),
      title: Type.String(),
      scope: Type.Optional(Type.String({ description: "draft worker scope (free-form)" })),
      evidence: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      urgency: Type.Optional(Type.String()),
      risk: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String({ description: "free-form notes/description" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await queueAdd(opsFor(ctx), params as never);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });

  pi.registerTool({
    name: "queue_update",
    label: "Queue update",
    description:
      "Update a queue item: status (validated transitions: proposal→approved/rejected, approved→active/rejected, active→reviewing/failed, " +
      "reviewing→done/failed/active, failed→active, done→approved (human re-open — you found issues in your review)), blocker (parked/serialized/merge/decision), or free-form notes. " +
      "active→reviewing/failed are event-driven — do NOT set them by hand.",
    parameters: Type.Object({
      key: Type.String(),
      status: Type.Optional(Type.String({ description: "target status (see description for valid transitions); approved REQUIRES a complete scope + cwd" })),
      blocker: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      urgency: Type.Optional(Type.String()),
      risk: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await queueUpdate(opsFor(ctx), params as never);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });

  pi.registerTool({
    name: "queue_dispatch",
    label: "Queue dispatch",
    description:
      "Dispatch a queue item: spawns the worker (same executor as the subagent tool; fresh context, worktree isolation) AND records " +
      "approved→active with the run id — atomically. Call with the key of an approved item and the scoped worker prompt. " +
      "High-risk items: still surface the final checkpoint BEFORE calling this. Returns the run id (use it for the inspector pane).",
    parameters: Type.Object({
      key: Type.String({ description: "queue key of an approved item" }),
      task: Type.String({ description: "the scoped worker prompt (self-contained; KEY: <key> as first line is recommended)" }),
      cwd: Type.Optional(Type.String({ description: "repo the worker operates on (worktree isolation runs THERE). REQUIRED when the session cwd is not the target repo (e.g. dispatching from a parent dir into the repo the worker must touch)." })),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await queueDispatch(opsFor(ctx), params as never);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });

  pi.registerTool({
    name: "queue_review",
    label: "Queue review",
    description:
      "Dispatch the reviewer for a `reviewing` item: spawns the reviewer subagent (read-only, no worktree) via the same executor, records the " +
      "reviewerRunId on the item, and emits orch:reviewer-dispatched. When the reviewer completes, the extension parses its 'Verdict: PASS/FAIL' " +
      "line and auto-transitions (PASS → done, FAIL → active re-dispatch, cap → failed) — see the queue model. Returns the run id.",
    parameters: Type.Object({
      key: Type.String({ description: "queue key of a `reviewing` item" }),
      task: Type.Optional(Type.String({ description: "optional reviewer prompt; the verdict contract is injected if omitted" })),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await queueReview(opsFor(ctx), params as never);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });

  pi.registerTool({
    name: "queue_steer",
    label: "Queue steer",
    description:
      "Steer a RUNNING worker or reviewer (dispatched via queue_dispatch/queue_review). Writes a steer request to pi-subagents' control channel " +
      "(the same mechanism FleetView uses) and VERIFIES the child's acknowledgment. Headless (-p) children do not support steering (supported:false " +
      "capability or silent no-ack) — the tool reports that honestly instead of claiming delivery. If the run dir is gone, the run completed/died — " +
      "stop + re-dispatch instead.",
    parameters: Type.Object({
      key: Type.String({ description: "queue key of the running worker/reviewer" }),
      message: Type.String({ description: "the steering instruction (interrupt-and-deliver)" }),
      mode: Type.Optional(Type.String({ description: "steer (interrupt, default) | follow_up (queued until idle)" })),
      ackTimeoutMs: Type.Optional(Type.Number({ description: "ack poll deadline in ms (default 4000)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await queueSteer(opsFor(ctx), params as never);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });

  pi.registerTool({
    name: "flag_for_review",
    label: "Flag for review",
    description:
      "Flag that you believe the current task is complete and ready for the user's judgment. Call this ONLY when you believe the work is done — not after every turn, not when you have a question. Before calling, reason explicitly about the risk (what happens if this is wrong) and blast radius (what breaks). If the work produced a commit and the pre-commit reviewer passed, set self_reviewed=true and review_method='commit-hook'. If you ran a reviewer subagent, set review_method='reviewer-subagent'. If no automated review ran, set self_reviewed=false.",
    parameters: Type.Object({
      summary: Type.String({ description: "What was done (one line)" }),
      risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "low = mistake has no real-world impact; medium = contained but visible; high = affects production/data/auth/pipelines" }),
      blast_radius: Type.String({ description: "What breaks if this is wrong — be specific" }),
      review_targets: Type.Array(Type.String(), { description: "WHERE to review: file paths, path:line ranges, commit SHAs, MR/PR links — the human reviews these" }),
      self_reviewed: Type.Boolean({ description: "true if the pre-commit reviewer or a reviewer subagent passed; false if no automated review ran" }),
      review_method: Type.Union([Type.Literal("commit-hook"), Type.Literal("reviewer-subagent"), Type.Literal("none")], { description: "How the self-review happened" }),
      action_needed: Type.Optional(Type.String({ description: "What the user should DO after reviewing (merge X, approve Y, decide A/B)" })),
      residual_risks: Type.Optional(Type.String({ description: "What was NOT verified / could change" })),
      queue_key: Type.Optional(Type.String({ description: "The queue item this flag came from (when orchestrated)" })),
    }),
    async execute(_toolCallId, params: { summary: string; risk: "low" | "medium" | "high"; blast_radius: string; review_targets: string[]; self_reviewed: boolean; review_method: "commit-hook" | "reviewer-subagent" | "none"; action_needed?: string; residual_risks?: string; queue_key?: string }) {
      const { deliveryNote } = flagForReview(params);
      return { content: [{ type: "text", text: `Flagged for review. Risk: ${params.risk}. ${deliveryNote}` }], details: {} };
    },
  });

  // -- /autopilot command ----------------------------------------------------

  pi.registerCommand("autopilot", {
    description: "Orchestrator autopilot: on | off | status | capacity <n>",
    handler: async (args, ctx) => {
      const [cmd, val] = (args ?? "").trim().split(/\s+/);
      try {
        switch (cmd) {
          case "on":
            ensureMigrated(); // import legacy state.md into queue.json once
            writeSessionAutopilotState(stateDir, sessionId, "on");
            maybeInjectOrchestrate();
            runner.onActivate(); // nudge a pre-existing capacity gap immediately
            informOrchestrator("on");
            ctx.ui.notify(`Autopilot ON (session ${sessionId.slice(0, 8)}) — orchestrator mode loaded, capacity ticks enabled`, "info");
            break;
          case "off":
            writeSessionAutopilotState(stateDir, sessionId, "off");
            informOrchestrator("off");
            ctx.ui.notify(`Autopilot OFF (session ${sessionId.slice(0, 8)}) — ticks and queue tools remain available, ticks disabled`, "info");
            break;
          case "status": {
            const cfg = loadAutopilotConfig(stateDir);
            const st = ensureAutopilot().status();
            const mine = readSessionAutopilotState(stateDir, sessionId);
            const store = storeOrNew();
            const counts = queueLengths(store);
            ctx.ui.notify(
              `Autopilot ${mine} (this session) — capacity ${cfg.maxSlots} workers, queue-low < ${cfg.queueLowThreshold} ready, running: ${st.running}, queue: ${JSON.stringify(counts)}`,
              "info",
            );
            break;
          }
          case "capacity": {
            const n = Number(val);
            if (!Number.isFinite(n) || n < 1) {
              ctx.ui.notify("Usage: /autopilot capacity <n> (n ≥ 1)", "error");
              return;
            }
            const cfg = loadAutopilotConfig(stateDir);
            saveAutopilotConfig(stateDir, { ...cfg, maxSlots: n });
            autopilot = null; // recreate with the new capacity
            ctx.ui.notify(`Worker capacity set to ${n} (takes effect immediately)`, "info");
            break;
          }
          default:
            ctx.ui.notify("Usage: /autopilot on | off | status | capacity <n>", "info");
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        // ALWAYS log the failure (even when autopilot is off) — the notify
        // promises "see autopilot.jsonl"; without this line the promise is a
        // lie and the failure is undebuggable.
        try {
          appendTelemetry(stateDir, JSON.stringify({
            t: new Date().toISOString(),
            type: "command-error",
            command: args,
            error: err.message,
            stack: err.stack?.split("\n").slice(0, 6).join("\n"),
          }));
        } catch {
          // jsonl write failing is not worth a second notification
        }
        ctx.ui.notify("Autopilot command failed (see autopilot.jsonl)", "error");
      }
    },
  });
}
