// config.ts — framework configuration + per-session autopilot state.
// Split out of core.ts: the Autopilot lifecycle is the engine; everything
// about HOW it is configured, WHERE state lives, and WHICH sessions are
// autopilot-on lives here.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Scheduled-off parsing lives in the framework module (ONE place with the
// due-check + timer manager). The per-session state file lives in the LEAF
// session-store.ts so both this module and scheduled-off.ts can depend on it
// WITHOUT an import cycle (the earlier config ↔ scheduled-off shape only
// worked because every cross-reference resolved at call time).
import {
  writeAtomic,
  sessionAutopilotPath,
  readSessionStore,
  writeSessionStore,
  readScheduledOffAt,
  writeSessionAutopilotState,
  scheduleScheduledOff,
} from "./session-store.ts";
import { parseDurationMs } from "./framework/scheduled-off.ts";
import { specCompleteness, specGapTag, type SpecGapId } from "./framework/spec-completeness.ts";
import { loadStore } from "./queue-store.ts";

// Re-exports: the state helpers' public home stays config.ts for callers
// (hosts, tests) that predate the leaf extraction.
export { writeAtomic, sessionAutopilotPath, readScheduledOffAt, writeSessionAutopilotState };

export interface AutopilotConfig {
  stateDir: string;
  maxSlots?: number;              // default 3
  queueLowThreshold?: number;     // default 2 (matches orchestrate.md buffer rule)
  workerAgents?: string[];        // default ["worker"]
  reviewerAgents?: string[];      // default ["orchestrator-reviewer"] (framework-owned, installed by the reviewer installer)
  reviewCap?: number;              // review-FAIL re-dispatch cap, default 5
  quietPeriodMs?: number;         // min gap between ticks, default 60_000
  /** Minutes an `active` item may sit past its last update before the
   *  reconciliation sweeps may condemn its run, default 30; 0 disables them.
   *  Read by Autopilot (zombieReconcile / deadRunReconcile) and set from the
   *  config file + AUTOPILOT_ZOMBIE_GRACE_MINUTES — it was always passed and
   *  always read, but never declared here. */
  zombieGraceMinutes?: number;
  log?: (line: string) => void;   // telemetry sink
  now?: () => number;             // injectable clock
}

// ---------------------------------------------------------------------------

/** Append a JSONL telemetry line (never throws). */
export function appendTelemetry(stateDir: string, line: string): void {
  try {
    const p = join(stateDir, "autopilot.jsonl");
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(p, line + "\n", "utf8");
  } catch {
    // silent
  }
}

// ---------------------------------------------------------------------------
// State-dir resolution from the projected command
// ---------------------------------------------------------------------------

/**
 * Parse the `- STATE_DIR: <path>` line from an orchestrate.md Workspace block
 * (the mode-specific, not-synced section). This is the SAME file the loaded
 * command reads, so the extension's state dir matches the orchestrator's by
 * construction. Returns null when unparseable.
 */
export function parseStateDirFromCommand(commandFile: string): string | null {
  try {
    const content = readFileSync(commandFile, "utf8");
    const m = content.match(/STATE_DIR[`']?:\s*[`']?([^`'\n]+)[`']?/);
    if (!m) return null;
    let p = m[1].trim();
    if (p.startsWith("~")) p = join(process.env.HOME ?? "/", p.slice(1));
    p = p.replace(/\/+$/, ""); // normalize trailing slash
    return p || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State-dir startup/activation probe (AUTOPILOT-3)
// ---------------------------------------------------------------------------
// The SILENT split-brain bug class: the extension resolves a state dir
// (env → host command STATE_DIR → profile fallback) that is stale, missing,
// or diverged from the orchestrator's own projection, then operates on a
// phantom/empty store with NO signal — observed three times (opencode
// projections pointing at pre-migration paths → empty-queue phantoms; a
// missing autopilot.config.json → unreadable workspace facts; legacy
// digit-less keys latching weird series prefixes). This probe verifies the
// RESOLVED dir before anyone relies on it: the dir exists, queue.json (the
// store) is there, autopilot.config.json is there when workspace facts are
// promised, and the extension's resolution agrees with the orchestrate.md
// projection (host parity). It NEVER throws — findings are reported (ONE
// telemetry log + ONE host notify); the harness keeps running fail-open (a
// spurious warning costs a notify; silent wrong-queue operation compounds).

export interface StateDirProbeOptions {
  stateDir: string;
  /** The orchestrate.md command file the host resolved FROM — the host-parity
   *  input (the orchestrator reads ITS projected state dir from this SAME
   *  file's Workspace block). Omit when the host has no projection. */
  commandFile?: string;
  /** Verify autopilot.config.json too. Default: inferred from the command
   *  file — its Workspace-facts promise (the ON message points the orchestrator
   *  at the config; a promised-but-missing config makes the workspace facts
   *  unreadable). No command file / no promise → check skipped. */
  expectWorkspaceConfig?: boolean;
}

export interface StateDirProbeResult {
  ok: boolean;
  /** Human-readable findings; empty when ok. */
  findings: string[];
}

/** Does the orchestrate command PROMISE workspace facts (an autopilot.config.json
 *  with a workspace section)? True when the projection carries the Workspace
 *  facts block. Never throws — an unreadable file promises nothing. */
export function workspaceFactsPromised(commandFile: string): boolean {
  try {
    const content = readFileSync(commandFile, "utf8");
    return /\bWorkspace facts\b/i.test(content) || /autopilot\.config\.json/.test(content);
  } catch {
    return false;
  }
}

/** The framework-level state-dir probe (AUTOPILOT-3). Called at activation
 *  (/autopilot on) and at session start; reports findings, NEVER throws. */
export function probeStateDir(opts: StateDirProbeOptions): StateDirProbeResult {
  const findings: string[] = [];
  const { stateDir } = opts;
  try {
    if (!existsSync(stateDir)) {
      findings.push(`state dir does not exist: ${stateDir} — the harness would operate on a PHANTOM store (nothing is ever read here)`);
    }
    const queuePath = join(stateDir, "queue.json");
    if (!existsSync(queuePath)) {
      findings.push(`queue.json is missing at ${stateDir} — every queue read would be an EMPTY store. The real queue may live elsewhere (stale STATE_DIR projection?)`);
    }
    const configExpected = opts.expectWorkspaceConfig ?? (opts.commandFile ? workspaceFactsPromised(opts.commandFile) : false);
    if (configExpected && !existsSync(join(stateDir, "autopilot.config.json"))) {
      findings.push(`autopilot.config.json is missing at ${stateDir} — workspace facts were promised (intake sources / goals file / notes) but the orchestrator cannot read them`);
    }
    // HOST PARITY: what the EXTENSION resolved vs what the ORCHESTRATOR's own
    // projection says. Normally identical (one resolution chain); a mismatch
    // means env/fallback took over while the orchestrator still reads ITS
    // file — the extension queues into A while the orchestrator reads B.
    if (opts.commandFile) {
      if (existsSync(opts.commandFile)) {
        const projected = parseStateDirFromCommand(opts.commandFile);
        if (projected && projected !== stateDir) {
          findings.push(`HOST PARITY MISMATCH — the extension resolves ${stateDir} but the orchestrate.md projection reads ${projected}; the orchestrator operates on a DIFFERENT store`);
        } else if (projected === null) {
          findings.push(`orchestrate.md has no STATE_DIR line — the orchestrator has no projected state dir; the extension uses ${stateDir}. Fix the Workspace block or they diverge silently`);
        }
      }
    }
  } catch {
    findings.push(`state-dir probe could not read ${stateDir} (permissions?) — verify the directory is accessible`);
  }
  return { ok: findings.length === 0, findings };
}

/** Report a probe ONCE: ONE telemetry line (type `state-dir-probe`) when there
 *  are findings, nothing when healthy. The host delivers the single notify
 *  itself (its UI is host-specific). Never throws. */
export function logStateDirProbe(stateDir: string, r: StateDirProbeResult, extra: Record<string, unknown> = {}): void {
  if (r.ok) return;
  appendTelemetry(stateDir, JSON.stringify({ t: new Date().toISOString(), type: "state-dir-probe", stateDir, ...extra, findings: r.findings }));
}

/** PROVISIONAL-LINGER check (AUTOPILOT-3): Q-<n> PROVISIONAL proposals older
 *  than `thresholdDays` that never reached approval. A provisional handle is
 *  the default-Q series key allocated to a cwd-less proposal; it keeps its
 *  Q-<n> name until the approved transition renames it into the repo's real
 *  series — so a stale one looks like a REAL series key (e.g. a genuine Q
 *  workstream) and gets mistaken for one. Returns each lingering key with its
 *  age in whole days (oldest first). NEVER throws. */
export function staleProvisionalProposals(
  stateDir: string,
  opts: { thresholdDays?: number; now?: number } = {},
): Array<{ key: string; days: number }> {
  const thresholdDays = opts.thresholdDays ?? 3;
  const now = opts.now ?? Date.now();
  const out: Array<{ key: string; days: number }> = [];
  try {
    const store = loadStore(stateDir);
    if (!store) return out;
    for (const it of Object.values(store.items)) {
      if (it.status !== "proposal") continue;
      if (it.provisionalKey !== true) continue; // explicit keys / deliberate series are never provisional
      if (!/^Q-\d/.test(it.key)) continue;
      const t = Date.parse(it.createdAt || it.updatedAt || "");
      if (Number.isNaN(t)) continue;
      const days = Math.floor(Math.max(0, now - t) / 86_400_000);
      if (days >= thresholdDays) out.push({ key: it.key, days });
    }
  } catch {
    // best-effort read — never throws
  }
  out.sort((a, b) => b.days - a.days);
  return out;
}

/** SPEC-COMPLETENESS surface (AUTOPILOT-26): the proposals whose scope is
 *  missing at least one element, each with its gap list (worst first — no
 *  scope at all outranks a thin one). ADVISORY ONLY: this feeds the panel tag
 *  and the /autopilot status count; it is never consulted by the approval
 *  gate. Reading the store here (rather than in the panel) is what keeps the
 *  panel count and the status count identical by construction. NEVER throws. */
export function underSpecifiedProposals(stateDir: string): Array<{ key: string; gaps: SpecGapId[] }> {
  const out: Array<{ key: string; gaps: SpecGapId[] }> = [];
  try {
    const store = loadStore(stateDir);
    if (!store) return out;
    for (const it of Object.values(store.items)) {
      if (it.status !== "proposal") continue;
      const gaps = specCompleteness(it);
      if (gaps.length) out.push({ key: it.key, gaps });
    }
  } catch {
    // best-effort read — never throws
  }
  out.sort((a, b) => Number(b.gaps.includes("no-scope")) - Number(a.gaps.includes("no-scope")) || a.key.localeCompare(b.key));
  return out;
}

// ---------------------------------------------------------------------------
// Per-session autopilot state
// ---------------------------------------------------------------------------
// The on/off toggle is scoped to the SESSION (keyed by pi session id), not the
// mode's state dir — turning autopilot on in one session must not enable it in
// another session sharing the same queue. Stored in autopilot.sessions.json.

export function autopilotSentinelPath(stateDir: string): string {
  return join(stateDir, ".autopilot");
}

/** Sentinel: "on" | "off" | "unset" — legacy global file (migration input). */
export function readSentinel(stateDir: string): "on" | "off" | "unset" {
  try {
    const p = autopilotSentinelPath(stateDir);
    if (!existsSync(p)) return "unset";
    const content = readFileSync(p, "utf8").trim();
    return content.startsWith("on") ? "on" : content.startsWith("off") ? "off" : "unset";
  } catch {
    return "unset";
  }
}

export function writeSentinel(stateDir: string, status: "on" | "off"): void {
  writeAtomic(autopilotSentinelPath(stateDir), `${status} — ${new Date().toISOString()}\n`);
}

// The per-session state file + its accessors (readSessionStore,
// writeSessionStore, writeSessionAutopilotState, readScheduledOffAt,
// scheduleScheduledOff) live in the LEAF src/session-store.ts — see the
// cycle note in the imports above. This module keeps the POLICY on top of it:
// the sentinel migration and the command semantics.

/**
 * Per-session autopilot state: "on" | "off". Unknown sessions default OFF.
 * One-time migration: a legacy global `.autopilot`=on migrates the first
 * session that checks in to "on", then the legacy file is removed.
 */
export function readSessionAutopilotState(stateDir: string, sessionId: string): "on" | "off" {
  if (!sessionId) return "off";
  const store = readSessionStore(stateDir);
  const mine = store[sessionId];
  if (mine?.status === "on" || mine?.status === "off") return mine.status;
  // Sessions start OFF (the host writes off at session_start). There is no
  // legacy global-sentinel auto-on: activation is always an explicit
  // /autopilot on.
  return "off";
}

/** Per-session gate: the extension's behavior is scoped to one session. */
export function isAutopilotOn(stateDir: string, sessionId?: string): boolean {
  if (!sessionId) return false;
  return readSessionAutopilotState(stateDir, sessionId) === "on";
}

// ---------------------------------------------------------------------------
// Capacity / config
// ---------------------------------------------------------------------------

export interface AutopilotConfigFile {
  maxSlots?: number;
  queueLowThreshold?: number;
  workerAgents?: string[];
  reviewerAgents?: string[];
  reviewCap?: number; // review-FAIL re-dispatch cap (default 5)
  /** Zombie reconciliation grace (default 30 min): an `active` item idle this
   *  long while the fleet reports ZERO active runs is flipped to failed — its
   *  completion event was lost (timeout overnight / crash / restart). 0
   *  disables the sweep. */
  zombieGraceMinutes?: number;
  /** Workspace FACTS (mode-invariant): the per-environment truth the
   *  orchestrator reads instead of per-mode prompt projections. Facts live in
   *  config; procedure lives in the (single, mode-invariant) /orchestrate
   *  command. Credentials stay out — reference a secret store. */
  workspace?: WorkspaceConfig;
  sweepIntervalMs?: number; // periodic capacity sweep; 0 disables (default 10 min)
  /** Intake suppression window: pending proposals suppress intake ticks for
   *  this many hours (the user deliberates), then the suppression lapses so a
   *  STALE proposal cannot starve the refill nudge forever. Default 24. */
  intakeSuppressionHours?: number;
  /** SHIPPING POLICY (KEY: AUTO-SHIP-ON-DONE) — the per-repo merge-finisher
   *  gate. See ShippingConfig. */
  shipping?: ShippingConfig;
  /** Provisional-linger threshold (default 3 days): a Q-<n> PROVISIONAL
   *  proposal (a cwd-less candidate allocated in the default Q series, renamed
   *  into its real series only at approval) pending for longer than this is
   *  surfaced in the decision panel + /autopilot status so nobody mistakes a
   *  provisional handle for a real queue key. */
  provisionalLingerDays?: number;
}

/** The intake source vocabulary is deliberately OPEN: `type` is the label the
 *  orchestrator interprets (the procedure for each type lives in the
 *  orchestrator skill/command); everything else is that type's params. */
export interface IntakeSource {
  type: string;
  [param: string]: unknown;
}

export interface WorkspaceConfig {
  /** Goals file path (absolute or relative to the state dir). Default:
   *  goals.json in the state dir. */
  goalsFile?: string;
  /** Where the orchestrator's intake scans come from. */
  intake?: IntakeSource[];
  /** Free-form environment notes the orchestrator should know (working
   *  hours, escalation paths, whatever). */
  notes?: string;
}

/** SHIPPING POLICY (KEY: AUTO-SHIP-ON-DONE). The deterministic post-approval
 *  merge-finisher lane is gated by a PER-REPO shipping policy. NO FALLBACK:
 *  a repo without a policy never gets a guessed flow/base — the shipping run
 *  NOTICES, asks the user once (policy-inquiry), and stays paused until the
 *  one-time answer is written. */
export type ShippingFlow = "mrs" | "merge";
export interface ShippingRepoPolicy {
  /** `mrs` = one MR per baseBranch (a remote exists); `merge` = merge the
   *  approved work into the LOCAL base branch (no remote). */
  flow: ShippingFlow;
  /** Base branches — ORDER = MR sequence. `["main"]` = one MR;
   *  `["dev","master"]` = two MRs. Any strings. For `merge`, the first is the
   *  local target (default `main`). */
  baseBranches: string[];
}
export interface ShippingConfig {
  /** `auto` (default) runs the merge-finisher as soon as an item hits `done`;
   *  `manual` only nudges — batch finishers stay an explicit orchestrator act. */
  mergeMode?: "auto" | "manual";
  /** Per-repo policies, keyed by origin-slug (`owner/repo` or `repo`) or the
   *  repo's basename. An unknown repo → policy-inquiry, never a guess. */
  repos?: Record<string, ShippingRepoPolicy>;
}

/** The fully-resolved config `loadAutopilotConfig` returns (defaults applied).
 *  `workspace`/`shipping` stay optional — their ABSENCE is meaningful (no
 *  workspace facts / no shipping policy), never defaulted away. */
export type LoadedAutopilotConfig = Omit<Required<AutopilotConfigFile>, "workspace" | "shipping"> & {
  workspace?: WorkspaceConfig;
  shipping?: ShippingConfig;
};

/** The autopilot TOGGLE — ONE implementation, both hosts (pi /autopilot + the
 *  opencode autopilot tool used to carry the same switch twice). on/off write
 *  the per-session state + return the framework's mode message; status reports
 *  the mode + capacity; capacity validates + saves. The hosts keep ONLY
 *  delivery + host side effects (pi: notify + the /orchestrate injection on
 *  "on"; opencode: the tool return). */
/** The ONE toggle result. `mode` is set for explicit on/off; `scheduledOffAt`
 *  is the DISTINCT scheduling signal (epoch ms) — scheduling must never be
 *  reported as mode "off" (autopilot stays ON until the deadline). Hosts arm
 *  their ScheduleManager from it and deliver the message verbatim. */
export interface AutopilotCommandResult {
  ok: boolean;
  message: string;
  mode?: "on" | "off";
  scheduledOffAt?: number;
}

export function autopilotCommand(
  action: string,
  value: string | undefined,
  opts: { stateDir: string; sessionId?: string; now?: () => number },
): AutopilotCommandResult {
  const { stateDir, sessionId } = opts;
  switch (action) {
    case "on":
      if (sessionId) writeSessionAutopilotState(stateDir, sessionId, "on"); // also clears any schedule
      // The workspace hint rides the shared message: both hosts deliver THIS
      // result to their agent (opencode tool return / pi injected message).
      return { ok: true, message: autopilotModeMessage("on", opts.stateDir ? { stateDir: opts.stateDir } : undefined), mode: "on" };
    case "off": {
      // "off in <dur>" = SCHEDULED off: keep ON until the deadline, return the
      // distinct scheduledOffAt signal (never mode:"off"). The leading "in"
      // is optional so both "off in 30m" and a bare duration value parse.
      const spec = value?.trim();
      if (spec) {
        const parsed = parseDurationMs(spec.replace(/^in\s+/i, ""));
        if (!parsed) {
          return { ok: false, message: "Usage: autopilot off in <duration> — e.g. 90s | 30m | 2h | 1h30m (max 24h). Bare 'off' takes effect immediately." };
        }
        const nowMs = (opts.now ?? Date.now)();
        const at = nowMs + parsed;
        if (!sessionId) {
          // A schedule that persists nothing but reports success is a lie —
          // the caller would believe an OFF is armed when no deadline exists.
          // (Immediate on/off tolerate a missing session — pre-existing
          // per-session guards — but this is a NEW success-looking response.)
          return { ok: false, message: "No session target yet — 'off in <duration>' needs an active session. Run status first, then retry once the session registers." };
        }
        scheduleScheduledOff(stateDir, sessionId, at);
        return {
          ok: true,
          message: `Autopilot stays ON until ${new Date(at).toISOString()} (${parsed / 1000}s) — then OFF automatically. Any explicit on/off cancels the schedule.`,
          scheduledOffAt: at,
        };
      }
      if (sessionId) writeSessionAutopilotState(stateDir, sessionId, "off"); // also clears any schedule
      return { ok: true, message: autopilotModeMessage("off"), mode: "off" };
    }
    case "status": {
      const on = isAutopilotOn(stateDir, sessionId);
      const cfg = loadAutopilotConfig(stateDir);
      const pending = sessionId ? readScheduledOffAt(stateDir, sessionId) : null;
      const suffix = pending !== null ? ` Scheduled OFF at ${new Date(pending).toISOString()}.` : "";
      // Provisional-linger surface (AUTOPILOT-3): old Q-<n> provisional
      // proposals look like real queue keys — name them here so nobody
      // mistakes a provisional handle for dispatched/reviewed work.
      const stale = staleProvisionalProposals(stateDir, { thresholdDays: cfg.provisionalLingerDays });
      const linger = stale.length
        ? ` NOTE: provisional ${stale.map((s) => `${s.key} (${s.days}d)`).join(", ")} pending — resolve or reject it in the panel; a provisional Q-<n> is NOT a real key.`
        : "";
      // Spec-completeness surface (AUTOPILOT-26): the SAME count the proposals
      // panel tags, named here so under-specification is visible before the
      // approval gate. Advisory — these items still approve normally.
      const thin = underSpecifiedProposals(stateDir);
      const spec = thin.length
        ? ` NOTE: ${thin.length} proposal${thin.length === 1 ? "" : "s"} under-specified — ${thin.map((t) => `${t.key} (${specGapTag(t.gaps)})`).join(", ")}; refine in the panel (advisory, approval is still yours).`
        : "";
      return {
        ok: true,
        message: `Autopilot ${on ? "ON" : "OFF"} (this session${sessionId ? ` ${sessionId.slice(0, 8)}` : ""}) — capacity ${cfg.maxSlots} workers, queue-low < ${cfg.queueLowThreshold} ready.${suffix}${linger}${spec}`,
      };
    }
    case "capacity": {
      const n = Number((value ?? "").trim());
      if (!Number.isFinite(n) || n < 1) return { ok: false, message: "Usage: autopilot capacity <n> (n ≥ 1)" };
      saveAutopilotConfig(stateDir, { ...loadAutopilotConfig(stateDir), maxSlots: n });
      return { ok: true, message: `Worker capacity set to ${n} (takes effect immediately)` };
    }
    default:
      return { ok: false, message: "Usage: autopilot on | off [in <duration>] | status | capacity <n>" };
  }
}

/** The ONE mode explanation for the orchestrator — the toggle means the
 *  SAME thing on every host. Hosts only DELIVER it (pi: sendUserMessage
 *  followUp; opencode: the autopilot tool return); they never re-word it.
 *  The per-session state (isAutopilotOn) is the shared gate for all of it. */
export function autopilotModeMessage(mode: "on" | "off", workspace?: { stateDir: string }): string {
  // The workspace hint rides the ON message only: facts are read ONCE at
  // activation (single source of per-environment truth = the config file);
  // OFF doesn't need them (the orchestrator isn't scanning anything).
  const hint = mode === "on" && workspace
    ? `\n\nWorkspace facts: state dir ${workspace.stateDir} — autopilot.config.json there carries your \"workspace\" section (intake sources, goals file). Read it before intake scans; it is the single source of per-environment truth.`
    : "";
  // The run-now directive makes startup DETERMINISTIC without a tick: the ON
  // message is an instruction to act, arriving AFTER /orchestrate loaded the
  // mode. Startup never nudges (no activation tick) — this replaces it.
  const runNow = mode === "on"
    ? "\n\nYou were just activated: run your loop now — call queue_list to read the queue, dispatch ready approved items into free slots, and run an intake scan (proposing the next batch) if the approved buffer is low (< 2 ready)."
    : "";
  return mode === "on"
    ? "Autopilot is now ON — the harness is active: it auto-dispatches approved items (scope + cwd + low/med risk), auto-dispatches reviews on completion, auto-re-dispatches on review FAIL, AUTO-RECOVERS failed items (by cause: capped → bigger budget, verdict/zombie → one P5 re-dispatch, provider/infra → bounded retries with a degraded-window hold), routes verdicts (PASS to human-review, awaiting you), and sends [orch-tick] state messages. You keep: approval, high-risk checkpoints, review overrides, flag_for_review, steering. Do not manually queue_dispatch/queue_review what the harness handles." + hint + runNow
    : "Autopilot is now OFF — the harness is idle: no auto flips, no verdict routing, no auto-dispatch/review, no ticks. YOU must do everything manually: reconcile completions (queue_update active to ai-review/failed), route reviews (queue_review), read verdicts and move items (queue_update), dispatch (queue_dispatch), and flag (flag_for_review). The queue tools remain available. Re-enable by running the autopilot on command.";
}

/** Resolve the state dir ONCE, in the framework — no per-host copies. Chain:
 *  AUTOPILOT_STATE_DIR env → the host's orchestrate command STATE_DIR line
 *  (when a commandFile is given; config-carried) → PROFILE-SCOPED:
 *  ~/.local/state/orchestrator/<basename of the agent dir>. The profile
 *  folder's NAME (not its semantics) namespaces the state — machine-scoped
 *  (~/.local/state), never inside the profile dir itself (agent dirs may be
 *  managed repos), no mode-name knowledge. The framework is profile-blind. */
export function resolveStateDir(commandFile?: string): string {
  if (process.env.AUTOPILOT_STATE_DIR) return process.env.AUTOPILOT_STATE_DIR;
  if (commandFile) {
    try {
      if (existsSync(commandFile)) {
        const parsed = parseStateDirFromCommand(commandFile);
        if (parsed) return parsed;
      }
    } catch {
      // fall through to the profile-scoped resolution
    }
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (!agentDir) return join(homedir(), ".local/state/orchestrator");
  // The profile dir's basename namespaces the state (personal, work, …) — a
  // folder name, not a mode name: no semantics, purely deterministic scoping.
  const profile = (agentDir.split("/").filter(Boolean).pop() ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "default";
  return join(homedir(), ".local/state/orchestrator", profile);
}

export function autopilotConfigPath(stateDir: string): string {
  return join(stateDir, "autopilot.config.json");
}

/**
 * Read autopilot.config.json. Env overrides (AUTOPILOT_MAX_SLOTS,
 * AUTOPILOT_QUEUE_LOW, AUTOPILOT_WORKER_AGENTS) win over the file; the file
 * wins over built-in defaults.
 */
export function loadAutopilotConfig(stateDir: string, env: NodeJS.ProcessEnv = process.env): LoadedAutopilotConfig {
  let file: AutopilotConfigFile = {};
  try {
    const p = autopilotConfigPath(stateDir);
    if (existsSync(p)) file = JSON.parse(readFileSync(p, "utf8")) as AutopilotConfigFile;
  } catch {
    file = {};
  }
  const maxSlots = env.AUTOPILOT_MAX_SLOTS ? Number(env.AUTOPILOT_MAX_SLOTS) : file.maxSlots ?? 3;
  const queueLowThreshold = env.AUTOPILOT_QUEUE_LOW ? Number(env.AUTOPILOT_QUEUE_LOW) : file.queueLowThreshold ?? 2;
  const workerAgents = env.AUTOPILOT_WORKER_AGENTS
    ? env.AUTOPILOT_WORKER_AGENTS.split(",").map((s) => s.trim()).filter(Boolean)
    : file.workerAgents ?? ["worker"];
  const reviewerAgents = env.AUTOPILOT_REVIEWER_AGENTS
    ? env.AUTOPILOT_REVIEWER_AGENTS.split(",").map((s) => s.trim()).filter(Boolean)
    : file.reviewerAgents ?? ["orchestrator-reviewer"];
  const reviewCap = env.AUTOPILOT_REVIEW_CAP ? Number(env.AUTOPILOT_REVIEW_CAP) : file.reviewCap ?? 5;
  const sweepIntervalMs = env.AUTOPILOT_SWEEP_INTERVAL_MS
    ? Number(env.AUTOPILOT_SWEEP_INTERVAL_MS)
    : file.sweepIntervalMs ?? 600_000;
  const zombieGraceMinutes = env.AUTOPILOT_ZOMBIE_GRACE_MINUTES
    ? Number(env.AUTOPILOT_ZOMBIE_GRACE_MINUTES)
    : file.zombieGraceMinutes ?? 30;
  const provisionalLingerDays = file.provisionalLingerDays ?? 3;
  return {
    maxSlots: Number.isFinite(maxSlots) && maxSlots >= 1 ? maxSlots : 3,
    queueLowThreshold: Number.isFinite(queueLowThreshold) && queueLowThreshold >= 1 ? queueLowThreshold : 2,
    workerAgents: workerAgents.length ? workerAgents : ["worker"],
    reviewerAgents: reviewerAgents.length ? reviewerAgents : ["orchestrator-reviewer"],
    reviewCap: Number.isFinite(reviewCap) && reviewCap >= 1 ? reviewCap : 5,
    sweepIntervalMs: Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= 0 ? sweepIntervalMs : 600_000,
    zombieGraceMinutes: Number.isFinite(zombieGraceMinutes) && zombieGraceMinutes >= 0 ? zombieGraceMinutes : 30,
    provisionalLingerDays: Number.isFinite(provisionalLingerDays) && provisionalLingerDays >= 1 ? provisionalLingerDays : 3,
    ...(file.workspace ? { workspace: file.workspace } : {}),
    ...(file.shipping ? { shipping: file.shipping } : {}),
  };
}

export function saveAutopilotConfig(stateDir: string, cfg: AutopilotConfigFile): void {
  writeAtomic(autopilotConfigPath(stateDir), JSON.stringify(cfg, null, 2) + "\n");
}
