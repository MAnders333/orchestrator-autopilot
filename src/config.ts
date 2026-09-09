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
  if (readSentinel(stateDir) === "on") {
    const next = { ...store, [sessionId]: { status: "on" as const, updatedAt: new Date().toISOString() } };
    writeSessionStore(stateDir, next);
    try {
      writeAtomic(autopilotSentinelPath(stateDir), "off — migrated to per-session (" + new Date().toISOString() + ")\n");
    } catch {
      // best effort
    }
    return "on";
  }
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
      return {
        ok: true,
        message: `Autopilot ${on ? "ON" : "OFF"} (this session${sessionId ? ` ${sessionId.slice(0, 8)}` : ""}) — capacity ${cfg.maxSlots} workers, queue-low < ${cfg.queueLowThreshold} ready.${suffix}`,
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
  return mode === "on"
    ? "Autopilot is now ON — the harness is active: it auto-dispatches approved items (scope + cwd + low/med risk), auto-dispatches reviews on completion, auto-re-dispatches on review FAIL, routes verdicts (PASS to done), and sends [orch-tick] state messages. You keep: approval, high-risk checkpoints, review overrides, flag_for_review, steering. Do not manually queue_dispatch/queue_review what the harness handles." + hint
    : "Autopilot is now OFF — the harness is idle: no auto flips, no verdict routing, no auto-dispatch/review, no ticks. YOU must do everything manually: reconcile completions (queue_update active to reviewing/failed), route reviews (queue_review), read verdicts and move items (queue_update), dispatch (queue_dispatch), and flag (flag_for_review). The queue tools remain available. Re-enable by running the autopilot on command.";
}

/** Resolve the state dir ONCE, in the framework — no per-host copies. Chain:
 *  AUTOPILOT_STATE_DIR env → the host's orchestrate command STATE_DIR line
 *  (when a commandFile is given; config-carried) → PROFILE-SCOPED
 *  ($PI_CODING_AGENT_DIR/orchestrator — the environment IS the profile root;
 *  no mode-name knowledge) → LEGACY compat: the old mode-name heuristic
 *  (~/.local/state/orchestrator[-personal]) only when that dir already
 *  EXISTS (existing environments keep their queues; never re-derive from
 *  a name) → the documented default. */
export function resolveStateDir(commandFile?: string): string {
  if (process.env.AUTOPILOT_STATE_DIR) return process.env.AUTOPILOT_STATE_DIR;
  if (commandFile) {
    try {
      if (existsSync(commandFile)) {
        const parsed = parseStateDirFromCommand(commandFile);
        if (parsed) return parsed;
      }
    } catch {
      // fall through to the profile-based + legacy resolution
    }
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (agentDir) {
    const profileScoped = join(agentDir, "orchestrator");
    if (existsSync(profileScoped)) return profileScoped;
    // LEGACY compat (deprecated): the old mode-NAME heuristic — only while
    // that dir already exists, so existing environments keep their queues.
    const legacy = join(homedir(), agentDir.includes("personal")
      ? ".local/state/orchestrator-personal"
      : ".local/state/orchestrator");
    if (existsSync(legacy)) return legacy;
    return profileScoped; // new profile — deterministic, no name knowledge
  }
  return join(homedir(), ".local/state/orchestrator");
}

export function autopilotConfigPath(stateDir: string): string {
  return join(stateDir, "autopilot.config.json");
}

/**
 * Read autopilot.config.json. Env overrides (AUTOPILOT_MAX_SLOTS,
 * AUTOPILOT_QUEUE_LOW, AUTOPILOT_WORKER_AGENTS) win over the file; the file
 * wins over built-in defaults.
 */
export function loadAutopilotConfig(stateDir: string, env: NodeJS.ProcessEnv = process.env): Omit<Required<AutopilotConfigFile>, "workspace"> & { workspace?: WorkspaceConfig } {
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
  return {
    maxSlots: Number.isFinite(maxSlots) && maxSlots >= 1 ? maxSlots : 3,
    queueLowThreshold: Number.isFinite(queueLowThreshold) && queueLowThreshold >= 1 ? queueLowThreshold : 2,
    workerAgents: workerAgents.length ? workerAgents : ["worker"],
    reviewerAgents: reviewerAgents.length ? reviewerAgents : ["orchestrator-reviewer"],
    reviewCap: Number.isFinite(reviewCap) && reviewCap >= 1 ? reviewCap : 5,
    sweepIntervalMs: Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= 0 ? sweepIntervalMs : 600_000,
    zombieGraceMinutes: Number.isFinite(zombieGraceMinutes) && zombieGraceMinutes >= 0 ? zombieGraceMinutes : 30,
    ...(file.workspace ? { workspace: file.workspace } : {}),
  };
}

export function saveAutopilotConfig(stateDir: string, cfg: AutopilotConfigFile): void {
  writeAtomic(autopilotConfigPath(stateDir), JSON.stringify(cfg, null, 2) + "\n");
}
