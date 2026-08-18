// config.ts — framework configuration + per-session autopilot state.
// Split out of core.ts: the Autopilot lifecycle is the engine; everything
// about HOW it is configured, WHERE state lives, and WHICH sessions are
// autopilot-on lives here.

import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

export function writeAtomic(path: string, content: string): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

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

export function sessionAutopilotPath(stateDir: string): string {
  return join(stateDir, "autopilot.sessions.json");
}

interface SessionAutopilotStore {
  [sessionId: string]: { status: "on" | "off"; updatedAt: string };
}

function readSessionStore(stateDir: string): SessionAutopilotStore {
  try {
    const p = sessionAutopilotPath(stateDir);
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as SessionAutopilotStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeSessionStore(stateDir: string, store: SessionAutopilotStore): void {
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  for (const [k, v] of Object.entries(store)) {
    const t = new Date(v.updatedAt).getTime();
    if (!Number.isFinite(t) || t < cutoff) delete store[k];
  }
  writeAtomic(sessionAutopilotPath(stateDir), JSON.stringify(store, null, 2) + "\n");
}

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

export function writeSessionAutopilotState(stateDir: string, sessionId: string, status: "on" | "off"): void {
  if (!sessionId) return;
  const store = readSessionStore(stateDir);
  store[sessionId] = { status, updatedAt: new Date().toISOString() };
  writeSessionStore(stateDir, store);
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
  sweepIntervalMs?: number; // periodic capacity sweep; 0 disables (default 10 min)
}

/** The ONE mode explanation for the orchestrator — the toggle means the
 *  SAME thing on every host. Hosts only DELIVER it (pi: sendUserMessage
 *  followUp; opencode: the autopilot tool return); they never re-word it.
 *  The per-session state (isAutopilotOn) is the shared gate for all of it. */
export function autopilotModeMessage(mode: "on" | "off"): string {
  return mode === "on"
    ? "Autopilot is now ON — the harness is active: it auto-dispatches approved items (scope + cwd + low/med risk), auto-dispatches reviews on completion, auto-re-dispatches on review FAIL, routes verdicts (PASS to done), and sends [orch-tick] state messages. You keep: approval, high-risk checkpoints, review overrides, flag_for_review, steering. Do not manually queue_dispatch/queue_review what the harness handles."
    : "Autopilot is now OFF — the harness is idle: no auto flips, no verdict routing, no auto-dispatch/review, no ticks. YOU must do everything manually: reconcile completions (queue_update active to reviewing/failed), route reviews (queue_review), read verdicts and move items (queue_update), dispatch (queue_dispatch), and flag (flag_for_review). The queue tools remain available. Re-enable by running the autopilot on command.";
}

/** Resolve the state dir ONCE, in the framework — no per-host copies (the
 *  hosts' versions already diverged: opencode skipped the command's STATE_DIR
 *  line and leaned on the pi-runtime var). Chain: AUTOPILOT_STATE_DIR env →
 *  the host's orchestrate command STATE_DIR line (when a commandFile is given)
 *  → the PI_CODING_AGENT_DIR mode name → the documented default. */
export function resolveStateDir(commandFile?: string): string {
  if (process.env.AUTOPILOT_STATE_DIR) return process.env.AUTOPILOT_STATE_DIR;
  if (commandFile) {
    try {
      if (existsSync(commandFile)) {
        const parsed = parseStateDirFromCommand(commandFile);
        if (parsed) return parsed;
      }
    } catch {
      // fall through to the name-based + default resolution
    }
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  return agentDir.includes("personal")
    ? join(homedir(), ".local/state/orchestrator-personal")
    : join(homedir(), ".local/state/orchestrator");
}

export function autopilotConfigPath(stateDir: string): string {
  return join(stateDir, "autopilot.config.json");
}

/**
 * Read autopilot.config.json. Env overrides (AUTOPILOT_MAX_SLOTS,
 * AUTOPILOT_QUEUE_LOW, AUTOPILOT_WORKER_AGENTS) win over the file; the file
 * wins over built-in defaults.
 */
export function loadAutopilotConfig(stateDir: string, env: NodeJS.ProcessEnv = process.env): Required<AutopilotConfigFile> {
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
  return {
    maxSlots: Number.isFinite(maxSlots) && maxSlots >= 1 ? maxSlots : 3,
    queueLowThreshold: Number.isFinite(queueLowThreshold) && queueLowThreshold >= 1 ? queueLowThreshold : 2,
    workerAgents: workerAgents.length ? workerAgents : ["worker"],
    reviewerAgents: reviewerAgents.length ? reviewerAgents : ["orchestrator-reviewer"],
    reviewCap: Number.isFinite(reviewCap) && reviewCap >= 1 ? reviewCap : 5,
    sweepIntervalMs: Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= 0 ? sweepIntervalMs : 600_000,
  };
}

export function saveAutopilotConfig(stateDir: string, cfg: AutopilotConfigFile): void {
  writeAtomic(autopilotConfigPath(stateDir), JSON.stringify(cfg, null, 2) + "\n");
}
