// recovery-state.ts — the PROVIDER-HEALTH ledger behind automatic recovery
// (AUTO-RECOVER-FAILS). A degraded provider window is a machine fact, not a
// per-item guess: when spawns start failing back-to-back (bare 400 at spawn,
// empty api_error, hang-then-die), the harness must STOP retrying and tell the
// user instead of churning re-dispatches into a dead provider.
//
// This is a LEAF module (no framework imports) so both the recovery engine
// (auto-recovery.ts) and the dispatch lane (auto-dispatch.ts) can share ONE
// counter without an import cycle.
//
// State semantics:
//   - providerFailures counts CONSECUTIVE provider-layer failures. Any
//     successful spawn resets it to 0 (a healthy spawn proves the window is
//     over).
//   - The degraded window is ACTIVE while providerFailures ≥ threshold AND the
//     last failure is younger than the cooldown. After the cooldown the next
//     pass PROBES (one attempt); a success resets, a failure re-arms. A pause
//     that never probes would deadlock recovery.
//   - heldNotified dedupes the user-facing "retries paused" tick to the
//     false→true transition of the window.

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Consecutive provider failures that trip the degraded-window hold. */
export const SPAWN_FAILURE_THRESHOLD = 2;
/** How long the window pauses retries before a probe is allowed. */
export const DEGRADED_COOLDOWN_MS = 5 * 60_000;

export interface RecoveryState {
  providerFailures: number;
  heldNotified: boolean;
  lastProviderFailureAt: number | null;
  updatedAt: string;
}

export function recoveryStatePath(stateDir: string): string {
  return join(stateDir, "recovery-state.json");
}

export function loadRecoveryState(stateDir: string): RecoveryState {
  try {
    const p = recoveryStatePath(stateDir);
    if (!existsSync(p)) return freshState();
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<RecoveryState>;
    return {
      providerFailures: typeof raw.providerFailures === "number" && raw.providerFailures > 0 ? raw.providerFailures : 0,
      heldNotified: raw.heldNotified === true,
      lastProviderFailureAt: typeof raw.lastProviderFailureAt === "number" ? raw.lastProviderFailureAt : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return freshState();
  }
}

export function saveRecoveryState(stateDir: string, state: RecoveryState): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const p = recoveryStatePath(stateDir);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch {
    // provider-health telemetry must never break a sweep/dispatch
  }
}

function freshState(): RecoveryState {
  return { providerFailures: 0, heldNotified: false, lastProviderFailureAt: null, updatedAt: new Date().toISOString() };
}

/** Record a provider-layer failure (spawn rejected / run died with no work).
 *  Returns the mutation so a caller holding the state can reuse it. */
export function recordProviderFailure(stateDir: string, now = Date.now()): RecoveryState {
  const state = loadRecoveryState(stateDir);
  state.providerFailures += 1;
  state.lastProviderFailureAt = now;
  state.updatedAt = new Date(now).toISOString();
  saveRecoveryState(stateDir, state);
  return state;
}

/** Record a SUCCESSFUL spawn — a healthy provider proves the window is over. */
export function recordProviderSuccess(stateDir: string): RecoveryState {
  const state = loadRecoveryState(stateDir);
  state.providerFailures = 0;
  state.heldNotified = false;
  state.updatedAt = new Date().toISOString();
  saveRecoveryState(stateDir, state);
  return state;
}

/** Is the degraded window currently pausing provider retries? */
export function isProviderDegraded(
  stateDir: string,
  now = Date.now(),
  opts: { threshold?: number; cooldownMs?: number } = {},
): boolean {
  const threshold = opts.threshold ?? SPAWN_FAILURE_THRESHOLD;
  const cooldownMs = opts.cooldownMs ?? DEGRADED_COOLDOWN_MS;
  const state = loadRecoveryState(stateDir);
  if (state.providerFailures < threshold) return false;
  if (state.lastProviderFailureAt === null) return false;
  return now - state.lastProviderFailureAt < cooldownMs;
}
