// session-store.ts — the per-session autopilot state file
// (autopilot.sessions.json): where sessions record on/off (+ the optional
// scheduledOffAt deadline) and how they prune after 30 days.
//
// This module is a LEAF: it imports nothing from config.ts or the framework,
// so config.ts (command layer) and framework/scheduled-off.ts (due-check
// backstop) can both depend on it WITHOUT an import cycle. The earlier shape
// — these helpers living in config.ts while scheduled-off.ts imported them
// back — worked only because every cross-reference resolved at call time;
// one top-level constant would have broken under ESM.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Atomic file write: tmp file + rename, so a crash mid-write cannot leave a
 *  truncated state file behind. */
export function writeAtomic(path: string, content: string): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function sessionAutopilotPath(stateDir: string): string {
  return join(stateDir, "autopilot.sessions.json");
}

interface SessionAutopilotStore {
  [sessionId: string]: { status: "on" | "off"; updatedAt: string; scheduledOffAt?: number };
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
export { readSessionStore, writeSessionStore };

function writeSessionStore(stateDir: string, store: SessionAutopilotStore): void {
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  for (const [k, v] of Object.entries(store)) {
    const t = new Date(v.updatedAt).getTime();
    if (!Number.isFinite(t) || t < cutoff) delete store[k];
  }
  writeAtomic(sessionAutopilotPath(stateDir), JSON.stringify(store, null, 2) + "\n");
}

// Scheduled-off persistence rides THIS entry (no second state file): an
// explicit status write drops `scheduledOffAt` — explicit on/off cancels any
// pending schedule by construction, so callers cannot forget it.

export function writeSessionAutopilotState(stateDir: string, sessionId: string, status: "on" | "off"): void {
  if (!sessionId) return;
  const store = readSessionStore(stateDir);
  // No scheduledOffAt here: an explicit toggle CANCELS a pending schedule.
  store[sessionId] = { status, updatedAt: new Date().toISOString() };
  writeSessionStore(stateDir, store);
}

/** The persisted scheduled-off deadline for a session (epoch ms), or null.
 *  Never throws — fail-safe to "nothing scheduled". */
export function readScheduledOffAt(stateDir: string, sessionId: string): number | null {
  try {
    if (!sessionId) return null;
    const mine = readSessionStore(stateDir)[sessionId];
    return typeof mine?.scheduledOffAt === "number" && Number.isFinite(mine.scheduledOffAt) ? mine.scheduledOffAt : null;
  } catch {
    return null;
  }
}

/** Persist a scheduled-off deadline (epoch ms) and keep the session ON —
 *  scheduling must not flip the mode; only the deadline firing does. */
export function scheduleScheduledOff(stateDir: string, sessionId: string, deadlineMs: number): void {
  const store = readSessionStore(stateDir);
  store[sessionId] = { status: "on", updatedAt: new Date().toISOString(), scheduledOffAt: Math.round(deadlineMs) };
  writeSessionStore(stateDir, store);
}
