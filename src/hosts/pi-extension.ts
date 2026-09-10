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
//   queue_review   — spawn the reviewer for an `ai-review` item
//   queue_steer    — steer a running worker/reviewer via the control channel
// Completion (active→ai-review/failed) is event-inferred from
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

// The framework lib is THIS project — the extension lives at src/hosts/ and
// requires the lib relative to itself (no dotfiles-layout assumption). A
// published/installed layout can override via AUTOPILOT_LIB_DIR.
const LIB_DIR = (() => {
  if (process.env.AUTOPILOT_LIB_DIR) return process.env.AUTOPILOT_LIB_DIR;
  return join(__dirname, "..");
})();
// jiti resolves .ts imports at runtime; createRequire keeps this ESM-safe.
const { Autopilot } = require(`${LIB_DIR}/core.ts`) as typeof import("./core.ts");
const { loadAutopilotConfig, isAutopilotOn, appendTelemetry, autopilotCommand, autopilotModeMessage, resolveStateDir, writeSessionAutopilotState, probeStateDir, logStateDirProbe } = require(`${LIB_DIR}/config.ts`) as typeof import("./config.ts");
const { loadStoreOrNew, ensureMigrated, queueLengths } = require(`${LIB_DIR}/queue-store.ts`) as typeof import("./queue-store.ts");
const { createSubagentBackend, defaultRunsDir } = require(`${LIB_DIR}/backends/index.ts`) as typeof import("./backends/index.ts");
const { queueList, queueAdd, queueUpdate, queueDispatch, queueReview, queueSteer, repoCheck } = require(`${LIB_DIR}/tools/queue-ops.ts`) as typeof import("./tools/queue-ops.ts");
const { CONTRACTS } = require(`${LIB_DIR}/tools/contracts.ts`) as typeof import("./tools/contracts.ts");
const { createFrameworkRunner } = require(`${LIB_DIR}/framework/runner.ts`) as typeof import("./framework/runner.ts");
const { isUnisolatedWorkerSpawn } = require(`${LIB_DIR}/framework/auto-dispatch.ts`) as typeof import("./framework/auto-dispatch.ts");
const { flagForReview } = require(`${LIB_DIR}/framework/flag-review.ts`) as typeof import("./framework/flag-review.ts");
const { createScheduleManager, scheduledOffDue } = require(`${LIB_DIR}/framework/scheduled-off.ts`) as typeof import("./framework/scheduled-off.ts");
const { installPiReviewer } = require(`${LIB_DIR}/agents/install.ts`) as typeof import("./agents/install.ts");
const { registerDecisionPanel } = require(`${LIB_DIR}/hosts/pi-panel.ts`) as typeof import("./pi-panel.ts");


// Install the framework-owned reviewer agent (idempotent, version-stamped).
// The framework DEPENDS on the reviewer (queue_review spawns it, the lifecycle
// parses its verdict) — shipping it with the extension is what makes the
// review step work on any machine. Never throw: a broken install must not
// affect pi (a missing reviewer surfaces as a generic spawn error at review
// time — re-install happens on the next activation).
try {
  installPiReviewer();
} catch {
  // silent — fail-closed check in queue_review reports if the agent is absent
}

const TICK_TYPE = "orchestrator-autopilot";

/** The orchestrate.md command file this host resolves FROM (the pi agent-dir
 *  prompts copy — the SAME file the /orchestrate command loads). Shared by
 *  resolveStateDir + the state-dir probe (host-parity input). */
function commandFilePath(): string | undefined {
  return process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, "prompts/orchestrate.md") : undefined;
}

let stateDir = resolveStateDir(commandFilePath());

export default function (pi: ExtensionAPI) {
  // Re-resolve per load (the test harness re-imports + mutates env between
  // cases; the real runtime loads the extension once). Production: called once.
  stateDir = resolveStateDir(commandFilePath());

  let autopilot: InstanceType<typeof Autopilot> | null = null;
  let agentBusy = false;          // orchestrator (main agent) mid-turn
  let compacting = false;         // auto-compaction in progress — never inject into it
  let interactive = false;        // true only in the interactive TUI session
  let sessionId = "";             // current pi session id (per-session autopilot scope)
  let orchestratorLoaded = false; // /orchestrate injected into this session
  let hostCtx: { ui?: { notify(message: string, kind?: string): void } } | null = null; // last-seen command/session ctx — the scheduled-off fire needs ui.notify outside a handler


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
    return loadStoreOrNew(stateDir);
  }

  /** Subagent-runtime seam — see src/backends/. The backend is DEDUCED from
   *  the runtime, never env: this extension IS pi, so workers spawn on the
   *  pi-subagents backend (the opencode plugin wires its own opencode
   *  backend + completion signal to the same queue tools). */
  const backend = createSubagentBackend({ kind: "pi", pi: pi as never });

  function maybeInjectOrchestrate() {
    // Never inject into child/headless processes (async runners are
    // --mode json -p): their session_start must not load orchestrator mode or
    // collide with the runner's task prompt. Also per-session: only the session
    // that turned autopilot on gets orchestrator mode injected.
    if (!interactive || !sessionId) return;
    if (!isAutopilotOn(stateDir, sessionId)) return;
    if (orchestratorLoaded) return;
    orchestratorLoaded = true; // assume success; reset on failure or session_start
    // deferAs: when the agent is busy but NOT streaming, the runtime's
    // followUp is ignored and sendUserMessage THROWS — defer to the settle.
    if (agentBusy) {
      runner.deferUserMessage("/orchestrate", { expandPromptTemplates: true }); // shared deferral — flush at the settle
      return;
    }
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
      // A synchronous throw (busy-not-streaming edge cases) must NOT take
      // down the /autopilot command — the shared deferral flushes at the settle.
      runner.deferUserMessage("/orchestrate", { expandPromptTemplates: true });
    }
  }

  // The shared tick machinery (gate + cooldown + delivery) lives in
  // src/framework/runner.ts — identical in both hosts. The pi host supplies
  // its gate state + the sendMessage delivery; runSweep/onCompletion etc.
  // wire the triggers.
  // The custom-role tick channel — ONE sendMessage implementation shared by
  // the runner's ticks AND the decision panel's decision ticks (same
  // customType orchestrator-autopilot, triggerTurn followUp): the orchestrator
  // sees panel decisions exactly like capacity ticks, no second mechanism.
  // pi.sendMessage is declared `: void` (not a Promise) — the runtime
  // sometimes returns a thenable and sometimes undefined. Never assume.
  // RETURN the thenable: the runner watches it — an ASYNC rejection (the
  // settled-vs-teardown race where the triggered prompt() throws "already
  // processing" after sendMessage resolved) re-defers the tick instead of
  // silently dropping it. A SYNC throw propagates → the router maps it to
  // "deferred" + the runner holds it (existing path).
  const deliverTick = (message: string): void | Promise<void> => {
    const sent = pi.sendMessage(
      { customType: TICK_TYPE, content: message, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return sent && typeof (sent as Promise<void>).catch === "function" ? (sent as Promise<void>) : undefined;
  };

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
    deliver: deliverTick,
    deliverUserMessage: (message, options) => {
      try {
        const sent = pi.sendUserMessage(message, { deliverAs: "followUp", ...(options ?? {}) });
        if (sent && typeof (sent as Promise<void>).catch === "function") {
          void (sent as Promise<void>).catch(() => {});
        }
      } catch {
        throw new Error("deferred"); // the runner re-holds until the next flush
      }
    },
    emit: (e) => emitDomain(e as never),
    enabled: () => {
      // Scheduled-off BACKSTOP: a persisted deadline in the past flips the
      // session OFF here before any sweep runs. Covers the process-restart
      // case (the armed timer died with the old process) and any missed fire.
      fireScheduledOffIfDue(sessionId);
      return isAutopilotOn(stateDir, sessionId);
    },
    sweepIntervalMs: loadAutopilotConfig(stateDir).sweepIntervalMs,
  });

  // Scheduled shutdown ("off in <dur>") — parsing, persistence and the due
  // check are the framework's (config.autopilotCommand + scheduledOffDue);
  // this manager only owns the in-process timer whose firing replays today's
  // immediate-"off" side effects. Nothing else is host-specific.
  const schedules = createScheduleManager({
    onFire: (sid) => fireScheduledOffIfDue(sid),
  });
  /** The ONE fire path (timer AND enable-gate backstop): the framework's
   *  due-check flips OFF + clears the persisted deadline first, so the side
   *  effects below replay EXACTLY ONCE per schedule (a second caller — e.g.
   *  the backstop racing an earlier fire — sees no deadline and returns). */
  function fireScheduledOffIfDue(sid: string) {
    if (!sid || !scheduledOffDue(stateDir, sid)) return;
    informOrchestrator("off"); // best-effort internally (defers while busy)
    try {
      hostCtx?.ui?.notify(`Autopilot OFF (session ${sid.slice(0, 8)}) — scheduled shutdown fired; ticks disabled`, "info");
    } catch {
      // best-effort — the OFF state itself is already persisted
    }
  }
  /** Inform the ORCHESTRATOR (not the user) when the autopilot toggle changes —
   *  the harness's behavior flips entirely between the two modes and the agent
   *  must know which one it is running under. Best-effort: a busy-agent sync
   *  throw must not fail the command (followUp + guard, same as injection). */
  function informOrchestrator(mode: "on" | "off") {
    // The message is the framework's (autopilotModeMessage) — this host only
    // DELIVERS it (followUp so a busy agent cannot fail the command). The ON
    // message carries the workspace facts pointer (state dir → config).
    const msg = autopilotModeMessage(mode, { stateDir });
    if (agentBusy) {
      runner.deferUserMessage(msg); // the busy-not-streaming window throws — shared deferral
      return;
    }
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

  /** B26: block direct worker subagent spawns without worktree isolation.
   *  The RULE is the framework's (isUnisolatedWorkerSpawn — testable, shared);
   *  this host only wires its tool_call interception event to it. */
  pi.on("tool_call", (event) => {
    if (!interactive || !isAutopilotOn(stateDir, sessionId)) return;
    if (event.toolName !== "subagent") return;
    const args = (event.input ?? {}) as { agent?: string; worktree?: boolean; action?: string };
    if (!isUnisolatedWorkerSpawn(args, loadAutopilotConfig(stateDir).workerAgents)) return;
    return {
      block: true,
      reason:
        "Worker dispatch without worktree isolation is BLOCKED by the autopilot — use queue_dispatch instead " +
        "(it enforces worktree:true). A direct subagent worker spawn runs in the main checkout, dirties it, and breaks " +
        "worktree isolation for all parallel workers (B26: B20's strays blocked B22/B23 at launch).",
    };
  });

  // -- lifecycle -------------------------------------------------------------

  pi.on("agent_start", () => {
    agentBusy = true;
    compacting = false; // failsafe: a run beginning means compaction finished or was cancelled
  });
  pi.on("agent_settled", () => {
    agentBusy = false;
    runner.onSettled(); // the runner flushes the shared deferral + harness queue at the settle (the agent is idle)
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
    hostCtx = ctx ?? null;
    // A session ALWAYS starts with autopilot OFF — no auto-restore from a
    // persisted on (resumed sessions), no legacy-sentinel auto-on. The user
    // explicitly runs /autopilot on to engage the harness; that is the only
    // activation path (it injects /orchestrate + the run-your-loop directive).
    if (sessionId) writeSessionAutopilotState(stateDir, sessionId, "off");
    // STATE-DIR PROBE (AUTOPILOT-3) at session start: catch silent state-dir /
    // config split-brain BEFORE the session operates on a phantom/empty store
    // (a stale orchestrate.md projection, a missing config, a host-parity
    // divergence — all observed). Interactive TUI sessions only (children are
    // headless json runners with no UI) and only when THIS host has an
    // orchestrate.md projection to check against (an env-only harness session
    // has no orchestrator reading any state dir yet — its first activation
    // runs the full probe). ONE telemetry log + ONE notify, NEVER a throw or
    // a block. NOTE: this probe ships in the extension — a live session
    // predating the update may need a restart to pick it up.
    if (interactive && commandFilePath()) {
      const probe = probeStateDir({ stateDir, commandFile: commandFilePath() });
      if (!probe.ok) {
        logStateDirProbe(stateDir, probe, { hook: "session_start" });
        try {
          ctx?.ui?.notify?.(`State-dir probe: ${probe.findings.join(" | ")}`, "error");
        } catch {
          // best-effort — the probe must never affect the session
        }
      }
    }
  });

  // -- periodic capacity sweep (deterministic safety net) --------------------
  // The timer is owned by the shared runner (identical machinery in both
  // hosts); pi gates it via enabled() = autopilot-on for this session.
  runner.start();
  pi.on("session_shutdown", () => {
    runner.stop();
    schedules.dispose(); // no leaked timers across sessions
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
    // The pi runtime's raw payload is flat (no per-child agent/output) — the
    // backend normalizes it from the run record (same shape the opencode
    // backend builds), so the shared attribution + verdict routing work
    // identically on both hosts. Without this, reviewer completions never
    // route (queue_review wedged on its first reviewer run).
    const ev = backend.buildCompletionEvent ? backend.buildCompletionEvent(payload) : ((payload ?? {}) as never);
    runner.onCompletion(ev);
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
    description: CONTRACTS.queue_list,
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.String({ description: "status filter (proposal|approved|active|ai-review|human-review|failed|done)" }), Type.Array(Type.String())])),
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
    description: CONTRACTS.queue_add,
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: "unique key; OMIT to auto-allocate the next sequential id (with `series`, e.g. \"B\" → B-<max+1>; default series Q)" })),
      series: Type.Optional(Type.String({ description: "id series for auto-allocation when key is omitted (e.g. \"B\" → B-<n>)" })),
      status: Type.Optional(Type.String({ description: "proposal (default) | approved" })),
      title: Type.String(),
      scope: Type.Optional(Type.String({ description: "draft worker scope (free-form); REQUIRED when status=approved" })),
      cwd: Type.Optional(Type.String({ description: "repo the worker runs in; REQUIRED when status=approved" })),
      timeoutMs: Type.Optional(Type.Number({ description: "requested wall-clock budget (ms) — recorded on the item and passed to EVERY spawned run (worker dispatch, re-dispatch, review) instead of the runtime default" })),
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
    description: CONTRACTS.queue_update,
    parameters: Type.Object({
      key: Type.String(),
      status: Type.Optional(Type.String({ description: "target status (see description for valid transitions); approved REQUIRES a complete scope + cwd" })),
      blocker: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ description: "requested wall-clock budget (ms) recorded on the item; every dispatch/review passes it to the spawned run" })),
      dispatchClass: Type.Optional(Type.String({ description: "worker (default) | finisher — finisher declares the run writes OUTSIDE its worktree, into the declared cwd's checkout (merge finisher)" })),
      finisherSource: Type.Optional(Type.String({ description: "for a finisher item: WHAT it lands (branch/tag/sha in the cwd). Required for landed evidence — without it a finisher's runtime failure verdict stands as usual" })),
      overrideReason: Type.Optional(Type.String({ description: "RECORD an override of the run's failure verdict on the item (append-only overrides[]) instead of hand-writing it into notes — say WHY the failure is not believed" })),
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
    description: CONTRACTS.queue_dispatch,
    parameters: Type.Object({
      key: Type.String({ description: "queue key of an approved item" }),
      task: Type.String({ description: "the scoped worker prompt (self-contained; KEY: <key> as first line is recommended)" }),
      cwd: Type.Optional(Type.String({ description: "repo the worker operates on (worktree isolation runs THERE). REQUIRED when the session cwd is not the target repo (e.g. dispatching from a parent dir into the repo the worker must touch)." })),
      timeoutMs: Type.Optional(Type.Number()),
      dispatchClass: Type.Optional(Type.String({ description: "worker (default) | finisher — use 'finisher' for a MERGE FINISHER that writes into the cwd's checkout instead of its worktree; success is then judged on the declared source landing there, not on worktree edits" })),
      finisherSource: Type.Optional(Type.String({ description: "the branch/tag/sha this finisher must land in cwd (e.g. pi-parallel-<runid>-0). REQUIRED for the landed-evidence path: without it a runtime 'no edits in the worktree' verdict fails the run as usual" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await queueDispatch(opsFor(ctx), params as never);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });

  pi.registerTool({
    name: "queue_review",
    label: "Queue review",
    description: CONTRACTS.queue_review,
    parameters: Type.Object({
      key: Type.String({ description: "queue key of an `ai-review` item" }),
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
    description: CONTRACTS.queue_steer,
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
    description: CONTRACTS.flag_for_review,
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
      const { deliveryNote } = flagForReview(params, { logPath: join(stateDir, "reviews.jsonl") });
      return { content: [{ type: "text", text: `Flagged for review. Risk: ${params.risk}. ${deliveryNote}` }], details: {} };
    },
  });

  // -- /autopilot command ----------------------------------------------------

  pi.registerCommand("autopilot", {
    description: "Orchestrator autopilot: on | off [in <duration>] | status | capacity <n>",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = (args ?? "").trim().split(/\s+/);
      const val = rest.length ? rest.join(" ") : undefined; // full remainder — "off in 30m" must reach the shared parser intact
      hostCtx = ctx ?? null;
      try {
        // PREREQUISITE PROBE (fail-closed, BEFORE the toggle writes state):
        // the harness spawns through the subagent backend — without that
        // runtime, dispatch/review would fail downstream in confusing ways.
        // Say so NOW instead of half-activating.
        if (cmd === "on") {
          const fleet = await backend.fleetStatus();
          if (fleet === null) {
            ctx.ui.notify("Autopilot NOT activated: the subagent backend is unreachable (fleet status timed out). Install/enable the pi-subagents extension and retry — the queue tools work without it, but ticks/dispatch do not.", "error");
            return;
          }
        }
        // ONE shared toggle implementation (config.autopilotCommand) — this
        // host keeps only its SIDE EFFECTS: the /orchestrate injection, the
        // activation nudge, the orchestrator mode notice, and the notify.
        const r = autopilotCommand(cmd, val, { stateDir, sessionId });
        if (!r.ok) {
          ctx.ui.notify(r.message, "error");
          return;
        }
        if (r.scheduledOffAt !== undefined && sessionId) {
          // SCHEDULED off: still ON until the deadline — arm the timer (the
          // manager replaces any previous one) + confirm with the absolute time.
          schedules.schedule(sessionId, r.scheduledOffAt);
          ctx.ui.notify(r.message, "info");
        } else if (r.mode === "on") {
          schedules.cancel(sessionId); // explicit toggle cancels a pending schedule
          ensureMigrated(stateDir); // import legacy state.md into queue.json once
          // STATE-DIR PROBE (AUTOPILOT-3) at ACTIVATION: the ON message points
          // the orchestrator at this state dir for workspace facts — verify it
          // is REAL (dir + queue.json + promised autopilot.config.json + host
          // parity vs the orchestrate.md projection) BEFORE relying on it.
          // Fail-open: ONE telemetry log + ONE notify; activation proceeds even
          // with findings (a warning costs a notify; blocking would strand the
          // user mid-activation). Never throws.
          const probe = probeStateDir({ stateDir, commandFile: commandFilePath() });
          if (!probe.ok) {
            logStateDirProbe(stateDir, probe, { hook: "autopilot-on" });
            try {
              ctx.ui.notify(`State-dir probe: ${probe.findings.join(" | ")}`, "error");
            } catch {
              // best-effort — the activation itself is already committed
            }
          }
          // STARTUP DOES NOT NUDGE: /orchestrate loads the mode; the ON
          // message (autopilotModeMessage) carries the run-your-loop now
          // directive. The first tick can never race the injection because
          // no tick is fired here.
          // EXCEPT auto-actions: the activation sweep refreshes the fleet and
          // lets the harness fill free slots IMMEDIATELY (approved items never
          // wait for the first settle/timer — AUTOPILOT-9). Its ticks are
          // gated on orchestratorLoaded, so pre-injection it can only dispatch.
          runner.activate();
          maybeInjectOrchestrate();
          informOrchestrator("on");
          ctx.ui.notify(`Autopilot ON (session ${sessionId.slice(0, 8)}) — orchestrator mode loaded, capacity ticks enabled`, "info");
        } else if (r.mode === "off") {
          schedules.cancel(sessionId); // explicit toggle cancels a pending schedule
          informOrchestrator("off");
          ctx.ui.notify(`Autopilot OFF (session ${sessionId.slice(0, 8)}) — ticks and queue tools remain available, ticks disabled`, "info");
        } else if (cmd === "status") {
          const st = ensureAutopilot().status();
          const counts = queueLengths(storeOrNew());
          // the helper's mode+capacity line + this host's runtime detail
          ctx.ui.notify(`${r.message} running: ${st.running}, queue: ${JSON.stringify(counts)}`, "info");
        } else if (cmd === "capacity") {
          autopilot = null; // recreate with the new capacity
          ctx.ui.notify(r.message, "info");
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

  // -- decision panel (/orchestrate-panel) -----------------------------------
  // The user-facing decision inbox: proposals + human-review views over queue
  // state (tab toggles). Pure UI over the shared panels core; fail-closed —
  // if the TUI surface is unavailable the command notifies instead of
  // throwing, and queue_list remains the fallback read.
  try {
    registerDecisionPanel(pi, { stateDir: () => stateDir, deliver: deliverTick });
  } catch {
    // a broken panel must never affect pi — the command simply won't exist
  }
}
