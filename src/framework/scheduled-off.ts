// scheduled-off.ts — "/autopilot off in <duration>" — the WHOLE scheduled
// shutdown feature in ONE framework module (the seam rule from runner.ts:
// engine logic lives here ONCE; hosts only DELIVER).
//
// Pieces (all host-agnostic):
//   - parseDurationMs   — "<n>s|<n>m|<n>h" + compounds ("1h30m"), rejects
//                         invalid/zero/negative and anything over the 24h cap.
//   - scheduledOffDue   — backstop: a persisted deadline in the past flips the
//                         session OFF (+ clears the schedule) and says so. The
//                         hosts call it inside their enabled() gate so a
//                         process restart can never lose the shutdown.
//   - createScheduleManager — owns the timer lifecycle for armed deadlines
//                         (schedule / cancel / replace / dispose). Everything
//                         environment-shaped is injected: the clock ({now})
//                         and the timers ({set, clear}) so tests run with zero
//                         real timers; onFire is where a host plugs its side
//                         effects (pi: informOrchestrator + ui.notify;
//                         opencode: promptAsync delivery). The framework never
//                         delivers itself.
//
// Persistence is NOT here: the deadline rides the EXISTING per-session entry
// in autopilot.sessions.json (config.ts read/write helpers were extended with
// `scheduledOffAt`) — no second state file.

import { readScheduledOffAt, writeSessionAutopilotState } from "../config.ts";

/** Hard cap: a scheduled shutdown further than 24h out is rejected (a typo
 *  guard — "off in 240m" vs "24h" class of mistakes must fail loudly). */
export const MAX_SCHEDULE_MS = 24 * 3600_000;

/**
 * Parse a duration spec ("90s", "30m", "2h", "1h30m") into milliseconds.
 * Returns null for anything invalid, zero, or over the 24h cap (negative
 * values cannot match the grammar and are rejected by it).
 */
export function parseDurationMs(spec: string): number | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  // One-or-more <number><unit> segments, nothing else (no bare numbers, no
  // unknown units, no separators).
  if (!/^(?:\d+(?:\.\d+)?[smh])+$/.test(s)) return null;
  let ms = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)([smh])/g)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    ms += n * (m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000);
  }
  if (!(ms > 0) || ms > MAX_SCHEDULE_MS) return null;
  return Math.round(ms);
}

/**
 * Backstop due-check: when this session's persisted scheduled-off deadline is
 * in the past, flip the session OFF (writeSessionAutopilotState also drops the
 * stale deadline) and return true — the caller replays its immediate-"off"
 * side effects. Never throws: a state-dir problem must not break the host's
 * enable gate (fail-safe style).
 */
export function scheduledOffDue(stateDir: string, sessionId: string, now: () => number = Date.now): boolean {
  try {
    if (!sessionId) return false;
    const at = readScheduledOffAt(stateDir, sessionId);
    if (at === null || now() < at) return false;
    writeSessionAutopilotState(stateDir, sessionId, "off");
    return true;
  } catch {
    return false;
  }
}

/** The timer port — injectable so tests run deterministically without real
 *  timers. The handle is opaque to the manager. */
export interface TimerPort {
  set(delayMs: number, fire: () => void): unknown;
  clear(handle: unknown): void;
}

export const nodeTimers: TimerPort = {
  set: (delayMs, fire) => setTimeout(fire, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ScheduleManagerDeps {
  /** Timer source (default: nodeTimers). Tests inject a fake. */
  timers?: TimerPort;
  /** Injected clock for deadline→delay math (default Date.now). */
  now?: () => number;
  /** The HOST's immediate-"off" side effects at the deadline. Invoked exactly
   *  once per firing; a throw is contained (must not break the manager). */
  onFire: (sessionId: string) => void;
}

export interface ScheduleManager {
  /** Arm (or REPLACE — re-scheduling cancels the old timer) the shutdown
   *  timer for a session. Exactly one live timer per session, ever. */
  schedule(sessionId: string, deadlineMs: number): void;
  /** Disarm a session's timer (explicit on/off). No-op when none armed. */
  cancel(sessionId: string): void;
  /** Sessions currently holding a live timer (test/teardown visibility). */
  pendingCount(): number;
  /** Disarm everything (host shutdown) — no leaked timers. */
  dispose(): void;
}

export function createScheduleManager(deps: ScheduleManagerDeps): ScheduleManager {
  const timers = deps.timers ?? nodeTimers;
  const now = deps.now ?? (() => Date.now());
  const armed = new Map<string, unknown>();
  const disarm = (sessionId: string): void => {
    const handle = armed.get(sessionId);
    if (handle !== undefined) {
      timers.clear(handle);
      armed.delete(sessionId);
    }
  };
  return {
    schedule(sessionId, deadlineMs) {
      disarm(sessionId); // replace semantics — the exactly-one-timer invariant
      // A past deadline (clock skew, restart race) fires on the next tick
      // rather than never — Math.max(0, …), not a negative delay.
      const delay = Math.max(0, deadlineMs - now());
      const handle = timers.set(delay, () => {
        armed.delete(sessionId); // self-disarm FIRST: exactly-once even if onFire re-enters
        try {
          deps.onFire(sessionId);
        } catch {
          // Host side effects must not break the manager — the persisted
          // deadline + the enabled()-gate backstop still hold the OFF line.
        }
      });
      armed.set(sessionId, handle);
    },
    cancel(sessionId) {
      disarm(sessionId);
    },
    pendingCount() {
      return armed.size;
    },
    dispose() {
      for (const sessionId of [...armed.keys()]) disarm(sessionId);
    },
  };
}
