// auto-recovery.ts — AUTOMATIC RECOVERY of FAILED items (the failed-status
// lane), bounded + transparent.
//
// Observed failure mode: children died at the provider layer (bare 400 at
// spawn, empty api_error mid-run, hang-then-die); every one needed a manual
// re-dispatch, and re-dispatches during the degraded window churned. This
// engine turns that manual loop into a DETERMINISTIC policy driven from the
// failed item's recorded `failCause` (BUDGET-GOVERNANCE), with a short backoff,
// per-item bounds, and a provider-health hold:
//
//   budget-capped → re-dispatch with a BIGGER budget (timeoutMs ×1.5, max 3h)
//   verdict       → ONE recovery re-dispatch carrying the P5 recovery context
//   zombie        → ONE recovery re-dispatch carrying the P5 recovery context
//   spawn/infra   → retry up to 2× with backoff, then ESCALATE
//
// BOUNDS: every attempt (including a spawn the provider REJECTED) increments
// the item's `recoveries`; once the per-cause cap (min per-cause, global
// default 2) is spent the item STAYS failed and gets a one-time escalation
// tick — never an unbounded retry loop. DEGRADED-WINDOW HOLD: consecutive
// provider failures (spawn throws / hang-then-die zombies) pause retries and
// emit a user tick instead of churning (recovery-state.ts owns the counter).
//
// RECOVERED ITEMS CARRY THEIR BRANCH (AUTO-SHIP-ON-DONE integration): the
// re-dispatch preserves the new run's parallel-branch tip exactly like every
// other dispatch lane, and the item still flows active → ai-review →
// human-review. Recovery NEVER short-circuits the approval gate and NEVER
// touches main — shipping stays the post-`done` merge-finisher lane.

import { loadStore, saveStore, updateItem, isFailCause, type QueueItem, type FailCause } from "../queue-store.ts";
import type { SubagentBackend } from "../backends/types.ts";
import { workerTask } from "./auto-dispatch.ts";
import { preserveRunWorktree } from "./worktree-preservation.ts";
import {
  loadRecoveryState,
  saveRecoveryState,
  SPAWN_FAILURE_THRESHOLD,
  DEGRADED_COOLDOWN_MS,
} from "./recovery-state.ts";

/** Global per-item auto-recovery cap (attempts, including rejected spawns). */
export const MAX_RECOVERIES = 2;
/** Short backoff between a failure and its recovery attempt (recovery timer). */
export const RECOVERY_BACKOFF_MS = 30_000;
/** budget-capped recovery: grow the wall-clock budget by this factor … */
export const BUDGET_MULTIPLIER = 1.5;
/** … capped at 3h (the outer bound the operator asked for). */
export const BUDGET_MAX_MS = 3 * 60 * 60_000;
/** Base used to grow a cap that has no recorded budget (the observed runtime
 *  default — a capped run with `timeoutMs: null` still gets a bigger next run). */
export const DEFAULT_BUDGET_MS = 30 * 60_000;

/** Recovery attempt cap per cause (clamped to MAX_RECOVERIES). */
const CAUSE_MAX_ATTEMPTS: Record<FailCause, number> = {
  "budget-capped": MAX_RECOVERIES,
  verdict: 1, // one recovery re-dispatch, then escalate
  zombie: 1, // one recovery re-dispatch, then escalate
  spawn: MAX_RECOVERIES, // provider retries (2×) then escalate
};

export interface RecoveryPlan {
  cause: FailCause;
  /** Attempts allowed for this cause (already clamped to the global cap). */
  maxAttempts: number;
  /** The wall-clock budget the re-dispatch runs under (null = runtime default). */
  budgetMs: number | null;
  /** The task block appended after KEY + scope (the P5 recovery context). */
  context: string;
}

/** The deterministic plan for one failed item: cap, budget, task context. */
export function recoveryPlan(item: QueueItem, cause: FailCause, globalMax = MAX_RECOVERIES): RecoveryPlan {
  const maxAttempts = Math.max(1, Math.min(CAUSE_MAX_ATTEMPTS[cause] ?? globalMax, globalMax));
  if (cause === "budget-capped") {
    const base = item.timeoutMs && item.timeoutMs > 0 ? item.timeoutMs : DEFAULT_BUDGET_MS;
    const budgetMs = Math.min(Math.round(base * BUDGET_MULTIPLIER), BUDGET_MAX_MS);
    return { cause, maxAttempts, budgetMs, context: recoveryContext(cause) };
  }
  return { cause, maxAttempts, budgetMs: item.timeoutMs ?? null, context: recoveryContext(cause) };
}

/** The P5 recovery context appended to a re-dispatch task. P5 is the
 *  fleet-health rule (prompts/orchestrate.md): CHECK RECOVERABILITY BEFORE A
 *  FULL REDO — the prior attempt's commits may live on its parallel branch. */
export function recoveryContext(cause: FailCause): string {
  const lines = [
    "## Recovery re-dispatch (P5)",
    `This item previously FAILED (cause: ${cause}); this is an automated recovery re-dispatch.`,
    ...(cause === "budget-capped"
      ? [
          "The prior run was CUT OFF by its wall-clock budget mid-task — this re-dispatch runs with a BIGGER budget (see the launch). Land a committable increment EARLY (commit on your branch before long test/fix cycles), then continue.",
        ]
      : []),
    ...(cause === "spawn"
      ? [
          "The provider/infra layer rejected the previous run AT SPAWN (bare 400 / empty api_error) — no work was produced. If this attempt fails the same way, the harness escalates instead of retrying forever.",
        ]
      : []),
    "P5 — CHECK RECOVERABILITY BEFORE REDOING ANYTHING: the prior attempt ran in an isolated worktree and pushed to its own parallel branch (pi-parallel-<runid>-0). Its commits may exist there, unmerged. Check `git log --all`, `git branch -a`, and the run's session log; if the work is present, RESTORE/reconcile it ON THE BRANCH instead of re-implementing it.",
    "NEVER commit or merge to main — main is touched ONLY by the human-approved merge-finisher AFTER review. Commit early on your branch; this item still goes through the normal AI review + human approval.",
  ];
  return lines.join("\n");
}

/** Build the recovery task: the original worker task (KEY + scope) + context. */
export function recoveryTask(item: QueueItem, cause: FailCause): string {
  return `${workerTask(item)}\n\n${recoveryContext(cause)}`;
}

export interface RecoveryOptions {
  now?: number;
  /** Global per-item attempt cap (default MAX_RECOVERIES = 2). */
  maxRecoveries?: number;
  /** Backoff between attempts (default RECOVERY_BACKOFF_MS = 30s). */
  backoffMs?: number;
  spawnFailureThreshold?: number;
  degradedCooldownMs?: number;
  /** Free-slot accounting: recovery never over-spawns past capacity. */
  maxSlots?: number;
  /** Authoritative active count (the runner's fleet union) — the floor. */
  totalActive?: number;
}

export interface RecoveryOutcome {
  recovered: Array<{ key: string; attempt: number; cause: FailCause; budgetMs: number | null; runId: string }>;
  escalated: Array<{ key: string; cause: FailCause; attempts: number }>;
  /** true when the degraded window is currently pausing attempts. */
  held: boolean;
  /** true on the false→true transition — emit the one-time "paused" tick. */
  heldNotice: boolean;
  /** Consecutive provider failures at the end of this pass (for the message). */
  spawnFailures: number;
  /** Soonest future due time (epoch ms) — the runner arms its recovery timer. */
  nextAt: number | null;
}

function appendNote(existing: string, note: string): string {
  return existing ? `${existing}\n\n${note}` : note;
}

/**
 * One recovery pass. Deterministic and idempotent per (item, now): items whose
 * backoff has not elapsed are deferred (reported via nextAt), exhausted items
 * escalate once, and provider failures drive the degraded-window hold. Never
 * throws. The caller (runner) owns tick delivery.
 */
export async function autoRecoverFails(
  stateDir: string,
  backend: SubagentBackend,
  opts: RecoveryOptions = {},
): Promise<RecoveryOutcome> {
  const now = opts.now ?? Date.now();
  const backoffMs = opts.backoffMs ?? RECOVERY_BACKOFF_MS;
  const globalMax = Math.max(1, opts.maxRecoveries ?? MAX_RECOVERIES);
  const threshold = opts.spawnFailureThreshold ?? SPAWN_FAILURE_THRESHOLD;
  const cooldownMs = opts.degradedCooldownMs ?? DEGRADED_COOLDOWN_MS;
  const maxSlots = opts.maxSlots ?? 3;
  const outcome: RecoveryOutcome = { recovered: [], escalated: [], held: false, heldNotice: false, spawnFailures: 0, nextAt: null };
  const store = loadStore(stateDir);
  if (!store) return outcome;
  const state = loadRecoveryState(stateDir);
  const degraded = state.providerFailures >= threshold && state.lastProviderFailureAt !== null && now - state.lastProviderFailureAt < cooldownMs;
  outcome.held = degraded;

  // Oldest failed first — the items waiting longest recover first (matches the
  // auto-dispatch ordering). Only items with a recorded, recoverable cause.
  const failed = Object.values(store.items)
    .filter((i) => i.status === "failed" && !!i.failCause && isFailCause(i.failCause))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));

  const later = (t: number): void => {
    outcome.nextAt = outcome.nextAt === null ? t : Math.min(outcome.nextAt, t);
  };

  // Phase 1 — escalate exhausted items. This does NOT spawn, so it runs even
  // while the degraded window pauses attempts: an item that already spent its
  // budget must still be surfaced once.
  let changed = false;
  for (const item of failed) {
    if (item.recoveryEscalated) continue;
    const cause = item.failCause as FailCause;
    const attempts = item.recoveries ?? 0;
    const plan = recoveryPlan(item, cause, globalMax);
    if (attempts >= plan.maxAttempts) {
      updateItem(store, item.key, {
        recoveryEscalated: true,
        notes: appendNote(
          item.notes,
          `[recover-exhausted] ${new Date(now).toISOString()} — auto-recovery spent ${attempts} attempt(s) (cause: ${cause}); the item STAYS failed. Needs your call: verify the pi-parallel-* branch, re-dispatch manually with a bigger budget, or drop.`,
        ),
      });
      outcome.escalated.push({ key: item.key, cause, attempts });
      changed = true;
    }
  }

  // Phase 2 — attempt recovery (paused while degraded). Recovery spawns are
  // slot-bounded so the failed lane can never over-spawn past capacity.
  if (!degraded) {
    const storeActive = Object.values(store.items).filter((i) => i.status === "active").length;
    const occupied = Math.max(opts.totalActive ?? 0, storeActive);
    let free = Math.max(0, maxSlots - occupied);
    for (const item of failed) {
      if (item.recoveryEscalated) continue;
      const cause = item.failCause as FailCause;
      const attempts = item.recoveries ?? 0;
      const plan = recoveryPlan(item, cause, globalMax);
      if (attempts >= plan.maxAttempts) continue; // phase 1 escalated it
      const notBefore = item.recoveryNotBefore ?? null;
      if (notBefore === null) {
        // A fresh failure — arm the short backoff first. A hang-then-die
        // (zombie) is ALSO provider-layer evidence; count it toward the hold.
        if (cause === "zombie") {
          state.providerFailures += 1;
          state.lastProviderFailureAt = now;
        }
        updateItem(store, item.key, { recoveryNotBefore: now + backoffMs });
        later(now + backoffMs);
        changed = true;
        continue;
      }
      if (notBefore > now) {
        later(notBefore);
        continue;
      }
      if (free <= 0) {
        // No capacity — try again after the backoff instead of spawning into a
        // full fleet. The engine's own auto-dispatch owns the free-slot fill.
        later(now + backoffMs);
        continue;
      }
      const attempt = attempts + 1;
      let runId: string | null = null;
      try {
        runId = await backend.spawn(recoveryTask(item, cause), { cwd: item.cwd ?? undefined, timeoutMs: plan.budgetMs ?? undefined });
      } catch {
        runId = null;
      }
      if (runId) {
        updateItem(store, item.key, {
          status: "active",
          runId,
          recoveries: attempt,
          recoveryNotBefore: null,
          ...(plan.budgetMs !== null ? { timeoutMs: plan.budgetMs } : {}),
          notes: appendNote(
            item.notes,
            `[recover] ${new Date(now).toISOString()} — auto-recovery re-dispatched (attempt ${attempt}, cause: ${cause}${plan.budgetMs ? `, budget ${plan.budgetMs}ms` : ""}); prior run ${item.runId ?? "?"} — verify its pi-parallel-* branch.`,
          ),
        });
        try {
          if (item.cwd) preserveRunWorktree({ stateDir, repo: item.cwd, runId, key: item.key });
        } catch {
          // preservation never breaks recovery
        }
        state.providerFailures = 0;
        state.heldNotified = false;
        outcome.recovered.push({ key: item.key, attempt, cause, budgetMs: plan.budgetMs, runId });
        free -= 1;
      } else {
        // The provider rejected the spawn (bare 400 / empty api_error): record
        // the attempt, switch the cause to `spawn` (the infra class — 2× then
        // escalate), and back off. The global provider-health counter drives
        // the degraded-window hold.
        state.providerFailures += 1;
        state.lastProviderFailureAt = now;
        updateItem(store, item.key, {
          failCause: "spawn",
          recoveries: attempt,
          recoveryNotBefore: now + backoffMs,
          notes: appendNote(
            item.notes,
            `[recover] ${new Date(now).toISOString()} — auto-recovery attempt ${attempt} could not spawn (provider/infra failure); retrying after backoff.`,
          ),
        });
        later(now + backoffMs);
      }
      changed = true;
    }
  } else if (state.lastProviderFailureAt !== null) {
    // Paused until the cooldown lets a probe through.
    later(state.lastProviderFailureAt + cooldownMs);
  }

  if (state.providerFailures >= threshold && !state.heldNotified) {
    state.heldNotified = true;
    outcome.heldNotice = true;
  }
  outcome.spawnFailures = state.providerFailures;
  state.updatedAt = new Date(now).toISOString();
  saveRecoveryState(stateDir, state);
  if (changed) saveStore(stateDir, store);
  return outcome;
}
