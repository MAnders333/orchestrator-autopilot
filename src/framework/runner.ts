// runner.ts — the framework RUNNER: host-agnostic TRIGGER ROUTING + tick
// delivery. Both hosts (pi extension + opencode plugin) wire their tool events
// to these methods; everything about WHAT a trigger does (fleet reconcile →
// sweep → tick → reviewTick fallback → gate → deliver) lives here ONCE.
//
// The hosts keep only the WIRING:
//   - their event sources (pi: async-complete/agent_settled/timer//autopilot;
//     opencode: backend process-exit/session.idle/timer)
//   - their gate-state semantics (interactive/loaded/busy/compacting)
//   - their delivery mechanism (pi: sendMessage; opencode: promptAsync)

import type { SubagentBackend } from "../backends/types.ts";
import { join } from "node:path";
import { storeToSnapshot, type Autopilot } from "../core.ts";
import type { CompletionEvent, Tick } from "../types.ts";
import { loadAutopilotConfig } from "../config.ts";
import { loadStore, itemByRunId } from "../queue-store.ts";
import { formatDurationMs } from "../duration.ts";
import { flagForReview } from "./flag-review.ts";
import { createTickRouter, type TickHostState } from "./tick-router.ts";
import { autoDispatchEligible, autoRedispatch, autoReview } from "./auto-dispatch.ts";
import { autoRecoverFails } from "./auto-recovery.ts";
import { decisionTick } from "./panels.ts";
import { humanReviewTargetsFor, preserveActiveItems, prunePreservedRefs, preserveRunWorktree } from "./worktree-preservation.ts";
import { checkMainWrites } from "./main-write-guard.ts";
import { runShippingPass } from "./shipping.ts";

export interface RunnerOptions {
  stateDir: string;
  autopilot: Autopilot;
  backend: SubagentBackend;
  /** The tick delivery gate state (what interactive/loaded/busy/compacting
   *  mean in this host). */
  host: TickHostState;
  /** The host's delivery mechanism (pi sendMessage / opencode promptAsync).
   *  May return a promise: a REJECTION means the runtime accepted the call but
   *  the send ultimately failed (pi: the settled-vs-teardown race where the
   *  triggered prompt() throws "already processing" AFTER sendMessage resolved).
   *  Nothing was persisted on that failure path, so the framework re-holds the
   *  message + retries — duplicate-safe by construction. */
  deliver: (message: string) => void | Promise<void>;
  /** Optional user-message delivery for deferred DIRECT sends (the pi host's
   *  /orchestrate injection + toggle messages; opencode has none). */
  deliverUserMessage?: (message: string, options?: Record<string, unknown>) => void;
  /** Host gate: should triggers run at all right now (pi: autopilot-on for
   *  this session; opencode: always). */
  enabled?: () => boolean;
  /** Domain-event sink (orch:item-completed, orch:verdict, ...). */
  emit?: (events: Array<{ name: string; data?: Record<string, unknown> }>) => void;
  cooldownMs?: number; // min gap between delivered ticks (default 1500)
  /** Periodic sweep interval; 0 disables the timer. */
  sweepIntervalMs: number;
  /** Backoff before re-delivering a tick whose send rejected asynchronously
   *  (default 1000ms; tests inject a tiny value). */
  deliveryRetryDelayMs?: number;
  /** Auto-dispatch + auto re-dispatch (default true; AUTOPILOT_AUTO_DISPATCH=0
   *  disables — a real, working opt-out). The framework fills free slots + re-dispatches FAIL items
   *  itself — the orchestrator keeps the judgment (intake, approval,
   *  high-risk checkpoints). */
  autoDispatch?: boolean;
  /** AUTOMATIC RECOVERY of failed items (AUTO-RECOVER-FAILS). Default on with
   *  auto-dispatch; the per-cause policy + bounds live in auto-recovery.ts.
   *  backoffMs/maxRecoveries/degraded window are injectable for tests and for
   *  a slow-provider deployment. */
  recovery?: {
    enabled?: boolean;
    backoffMs?: number;
    maxRecoveries?: number;
    spawnFailureThreshold?: number;
    degradedCooldownMs?: number;
  };
}

export interface FrameworkRunner {
  /** A run completed (worker done / reviewer done / any session subagent).
   *  pi: subagent:async-complete; opencode: backend process-exit. */
  onCompletion(ev: CompletionEvent): void;
  /** The orchestrator's own turn settled (queue may have changed).
   *  pi: agent_settled; opencode: session.idle. Hash-gated sweep. */
  onSettled(): void;
  /** Periodic re-nudge (bypasses the hash — re-ticks a persistent gap). */
  onTimer(): void;
  /** Explicit activation sweep (/autopilot on) — the harness fills free slots
   *  immediately instead of waiting for the first settle/timer (AUTOPILOT-9). */
  activate(): void;
  start(): void;
  stop(): void;
}

export function createFrameworkRunner(opts: RunnerOptions): FrameworkRunner {
  const autopilot = opts.autopilot;
  // ASYNC delivery failures are indistinguishable from success at the call
  // site (the sync verdict says "handed off"), so the wrapper watches the
  // returned thenable: a rejection re-defers the message for a bounded retry.
  // The immediate re-flush is deliberately SKIPPED here — the same race would
  // reject again mid-settle; a short backoff (plus the natural settle/timer
  // flushes) gives the runtime's teardown time to finish.
  const RETRY_DELAY_MS = opts.deliveryRetryDelayMs ?? 1000;
  const RETRY_MAX_ATTEMPTS = 5;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Attempt counts live HERE, not on the deferred entries: the flush paths
  // remove an entry the moment the host ACCEPTS the send (sync verdict), so a
  // count stored on the entry would reset every cycle and never hit the cap.
  const retryAttempts = new Map<string, number>();
  const deliverWatchingAsync = (message: string): void => {
    try {
      const r = opts.deliver(message) as unknown;
      if (r && typeof (r as Promise<unknown>).then === "function") {
        void (r as Promise<void>).then(
          () => retryAttempts.delete(message), // delivered (or safely queued) — reset
          () => {
            // ASYNC rejection — the runtime accepted the call but the turn
            // trigger failed afterwards (pi: prompt() threw "already
            // processing" post-resolve). Nothing was persisted on that path,
            // so re-hold + retry after a short backoff; bounded attempts.
            const n = (retryAttempts.get(message) ?? 0) + 1;
            if (n > RETRY_MAX_ATTEMPTS) {
              retryAttempts.delete(message);
              return; // permanently rejecting runtime — nudges re-fire anyway
            }
            retryAttempts.set(message, n);
            if (!deferred.some((d) => d.kind === "tick" && d.message === message)) {
              deferred.push({ message, kind: "tick" });
            }
            // NO immediate flush — the same race would reject again mid-settle.
            if (!retryTimer) {
              retryTimer = setTimeout(() => {
                retryTimer = null;
                flushDeferred();
              }, RETRY_DELAY_MS);
            }
          },
        );
      }
    } catch (e) {
      throw e; // sync throw still propagates — the router maps it to "deferred"
    }
  };
  const router = createTickRouter(opts.host, deliverWatchingAsync, opts.cooldownMs);
  const enabled = opts.enabled ?? (() => true);
  // SHARED deferral: messages the runtime rejected (busy-not-streaming —
  // the host's deliver threw) are held here + flushed at the host's
  // settle/idle event (the agent is idle then). This is framework logic;
  // the hosts only wire their idle event to onSettled + supply delivery.
  // DELIVERY-TIME FACTS (AUTOPILOT-6): a deferred dispatch/intake tick keeps
  // its engine Tick and is RE-DERIVED against the live store at each flush —
  // see refreshDeferredFacts below.
  interface DeferredEntry {
    message: string;
    kind: "tick" | "user";
    /** The engine tick a deferred tick entry was generated from (dispatch /
     *  intake refreshes recompute its FLEET/QUEUE facts at delivery; harness
     *  and review ticks have no such facts). */
    tick?: Tick;
    /** Delivery-time refresh decided the nudge no longer applies — drop. */
    drop?: boolean;
    options?: Record<string, unknown>;
  }
  const deferred: DeferredEntry[] = [];
  const queueDeferred = (message: string, kind: "tick" | "user", tick?: Tick, options?: Record<string, unknown>): void => {
    deferred.push({ message, kind, ...(tick ? { tick } : {}), ...(options ? { options } : {}) });
    flushDeferred();
  };
  // Recompute the FLEET/QUEUE facts of every held dispatch/intake tick from
  // the LIVE store before a flush delivers it. Between generation and the
  // busy-deferral flush the store can move (manual dispatch mid-window, an
  // auto-dispatch, a completion flip): "QUEUE: N ready (…)" must never list
  // items that are already active/running, and "FLEET: X free" must never
  // forget runs that started meanwhile. refreshTickFacts returns the CURRENT
  // truthful nudge or null (= no nudge applies anymore → drop the stale text
  // instead of contradicting the live state).
  const refreshDeferredFacts = (): void => {
    for (const d of deferred) {
      if (d.kind !== "tick" || !d.tick || d.drop) continue;
      if (d.tick.reason !== "dispatch" && d.tick.reason !== "intake") continue;
      const fresh = autopilot.refreshTickFacts(d.tick);
      if (!fresh) {
        d.drop = true; // generation-time facts are STALE by delivery — never present them
        continue;
      }
      d.message = fresh.message;
      d.tick = fresh;
    }
  };
  const flushDeferred = (): void => {
    if (!deferred.length) return;
    refreshDeferredFacts();
    // De-dupe identical ticks within one flush: a busy window that saw both a
    // nudge and a state-changing sweep can accumulate two dispatch ticks that
    // refresh to the SAME current message — deliver it once.
    const deliveredThisFlush = new Set<string>();
    const hold: typeof deferred = [];
    for (const d of deferred) {
      if (d.drop) continue;
      if (d.kind === "user") {
        if (!opts.deliverUserMessage) continue; // no user-delivery on this host
        try {
          opts.deliverUserMessage(d.message, d.options);
        } catch {
          hold.push(d); // still busy — re-flush at the next settle
        }
        continue;
      }
      if (deliveredThisFlush.has(d.message)) continue; // already delivered this flush
      const r = router.send(d.message, { bypassCooldown: true });
      if (r === "deferred") hold.push(d); // the runtime still rejected it
      else if (r === "delivered") deliveredThisFlush.add(d.message);
      // "dropped" (interactive/loaded) — permanent, drop; "delivered" — done
    }
    deferred.length = 0;
    deferred.push(...hold);
  };
  /** Host-facing: defer a DIRECT user-message send (the /orchestrate injection,
   *  the toggle message) — delivered via deliverUserMessage at the settle. */
  const deferUserMessage = (message: string, options?: Record<string, unknown>): void => {
    queueDeferred(message, "user", undefined, options);
  };
  const sendTick = (t: Tick | null | undefined): void => {
    if (!t?.message) return;
    const r = router.send(t.message);
    if (r === "deferred") queueDeferred(t.message, "tick", t); // hold the ENGINE tick — its facts refresh at delivery
  };
  /** Framework-crafted one-line ticks (recovery announcements) through the
   *  SAME gate: deferred → held for the settle flush; never lost. */
  const sendTickText = (message: string): void => {
    const r = router.send(message, { bypassCooldown: true });
    if (r === "deferred") queueDeferred(message, "tick");
  };

  // The auto-actions opt-out: env (AUTOPILOT_AUTO_DISPATCH=0) or the option.
  const autoDispatchOn = opts.autoDispatch ?? process.env.AUTOPILOT_AUTO_DISPATCH !== "0";
  const cfg = () => loadAutopilotConfig(opts.stateDir);
  // AUTOMATIC RECOVERY (AUTO-RECOVER-FAILS): the failed lane's deterministic
  // policy. Gated with the other auto-actions; the engine (auto-recovery.ts)
  // owns the per-cause plan + bounds, this runner owns DELIVERY (the
  // `[orch-tick: recover]` announcements) and the short backoff TIMER.
  const recoveryOn = autoDispatchOn && (opts.recovery?.enabled ?? true);
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimerAt = 0;
  const scheduleRecoveryAt = (at: number | null): void => {
    if (at === null || !recoveryOn) return;
    // An earlier (or equal) pass is already armed — leave it.
    if (recoveryTimer && recoveryTimerAt <= at) return;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimerAt = at;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      recoveryTimerAt = 0;
      void runRecoveryPass();
    }, Math.max(0, at - Date.now()));
  };
  const runRecoveryPass = async (totalActive?: number): Promise<void> => {
    // The recovery timer fires outside the sweep's own gate — honour BOTH the
    // structural opt-out and the live autopilot toggle there too (a pending
    // backoff scheduled before an OFF must not spawn).
    if (!recoveryOn || !enabled()) return;
    let outcome;
    try {
      outcome = await autoRecoverFails(opts.stateDir, opts.backend, {
        backoffMs: opts.recovery?.backoffMs,
        maxRecoveries: opts.recovery?.maxRecoveries,
        spawnFailureThreshold: opts.recovery?.spawnFailureThreshold,
        degradedCooldownMs: opts.recovery?.degradedCooldownMs,
        maxSlots: cfg().maxSlots,
        totalActive,
      });
    } catch {
      return; // recovery must never break a sweep
    }
    for (const r of outcome.recovered) {
      const budget = r.budgetMs ? `, budget ${formatDurationMs(r.budgetMs)}` : "";
      sendTickText(`[orch-tick: recover] re-dispatched ${r.key} (attempt ${r.attempt}, ${r.cause}${budget})`);
    }
    for (const e of outcome.escalated) {
      sendTickText(
        `[orch-tick: recover] ${e.key} exhausted auto-recovery (${e.attempts} attempt${e.attempts === 1 ? "" : "s"}, ${e.cause}) — it STAYS failed. Verify its pi-parallel-* branch, then your call: re-dispatch manually with a bigger budget / apply findings / drop. Not a user request; respond ≤2 lines.`,
      );
    }
    if (outcome.heldNotice) {
      sendTickText(
        `[orch-tick: recover] DEGRADED WINDOW: ${outcome.spawnFailures} consecutive provider failures (bare 400 / empty api_error / hang-then-die) — auto-recovery is PAUSED for a cooldown instead of churning retries. Failed items are held, not lost; a probe resumes automatically. Tell the user the provider looks degraded. Not a user request; respond ≤2 lines.`,
      );
    }
    scheduleRecoveryAt(outcome.nextAt);
  };
  // QUEUED harness info: auto-actions (dispatched / reviewed / re-dispatched)
  // accumulate into ONE consolidated tick, flushed at the next natural boundary
  // (the agent settles / the timer) instead of interrupting mid-turn. If the
  // router drops the flush (busy / cooldown), the parts are requeued — never
  // lost. The orchestrator learns what the harness DID without any gate bypass.
  let pendingHarness: string[] = [];
  let pendingFleet: number | undefined;
  const harnessTick = (parts: string[], fleetTotalActive?: number): void => {
    pendingHarness.push(...parts);
    if (fleetTotalActive !== undefined) pendingFleet = fleetTotalActive;
    flushHarness();
  };
  const flushHarness = (): void => {
    if (!pendingHarness.length) return;
    const parts = pendingHarness;
    pendingHarness = [];
    const fleet = pendingFleet !== undefined ? ` — fleet ${pendingFleet}` : "";
    const r = router.send(
      `[orch-tick: harness] auto: ${parts.join("; ")}.${fleet} Your calls: approvals, high-risk checkpoints, review overrides, flag_for_review. Not a user request; respond ≤2 lines.`,
      { bypassCooldown: true },
    );
    if (r === "deferred") pendingHarness = [...parts, ...pendingHarness]; // runtime rejected — re-flush at the next settle
  };
  const sweep = async (source: "settled" | "activate" | "timer" | "worker-done"): Promise<void> => {
    if (!enabled()) return;
    // WORKTREE HANDOFF PRESERVATION — capture the active runs' pi-parallel-*
    // tips into the durable journal + keep refs BEFORE anything else looks at
    // the queue. Rides the existing sweep (no new timers); running it on every
    // source means a dispatch is journalled within one sweep and a worker that
    // commits late still gets captured at the next state change. Best-effort.
    try {
      preserveActiveItems(opts.stateDir);
    } catch {
      // preservation must never break the sweep
    }
    // MAIN-IMMUTABILITY GUARD (KEY: MAIN-IMMUTABILITY-GUARD) — the MECHANICAL
    // enforcement of "nothing merges to main before human approval" (the rule
    // is codified in the skills/prompts, but guidance alone can lose — a live
    // incident committed a recovered deliverable to main pre-review). Every
    // reconcile step records the main HEAD of every queue-referenced repo; a
    // worker round that moves a tracked main ref while ≥1 item referencing
    // that repo is pre-done (not human-approved) raises the
    // orch:main-write-pre-approval WARNING event + a loud tick naming the SHA
    // + the offending keys. The ONLY legitimate main-write path is the
    // post-approval merge-finisher (MR when a remote exists, else merge to
    // main) — nothing auto-merges.
    try {
      for (const w of checkMainWrites(opts.stateDir)) {
        if (opts.emit) {
          opts.emit([{ name: "orch:main-write-pre-approval", data: { severity: "warning", ...w } }]);
        }
        const short = (s: string): string => s.slice(0, 8);
        const keys = w.keys.join(", ");
        const message = `[orch-tick: main-write] MAIN-IMMUTABILITY VIOLATION: ${w.ref} moved ${short(w.previousSha)} → ${short(w.sha)} in ${w.repo} while ${keys} ${w.keys.length > 1 ? "are" : "is"} NOT human-approved (pre-done). The ONLY legitimate main-write path is the merge-finisher AFTER the human's done (MR when a remote exists, else merge to main); nothing auto-merges. Verify what landed (git log ${short(w.sha)}); recovery stays on the branch. Not a user request; respond ≤2 lines.`;
        const r = router.send(message, { bypassCooldown: true });
        if (r === "deferred") queueDeferred(message, "tick");
      }
    } catch {
      // the guard must never break the sweep
    }
    // SHIPPING LANE (KEY: AUTO-SHIP-ON-DONE) — the deterministic post-approval
    // merge-finisher. `done` is human-approved, NOT merged; this reconcile step
    // reacts to done: a done item with a declared PER-REPO policy ships by
    // itself (MRs per baseBranch / merge to local main); a done item WITHOUT a
    // policy fires the ONE-TIME policy-inquiry ask and stays paused — nothing
    // merges before the policy is set (NO FALLBACK, never guess); mergeMode
    // manual suppresses the lane (batch finishers stay explicit). mergeMode
    // auto is the default. Every action lands as a `[orch-tick: ship]` tick +
    // a domain event; shippedAt markers prevent re-merge. Best-effort like the
    // guard above: a git/store failure must never break the sweep.
    try {
      for (const o of runShippingPass(opts.stateDir)) {
        if (o.event && opts.emit) opts.emit([o.event]);
        const r = router.send(o.message, { bypassCooldown: true });
        if (r === "deferred") queueDeferred(o.message, "tick");
      }
    } catch {
      // the shipping lane must never break the sweep — a failure inside is
      // already an outcome of the pass, not an exception
    }
    // The authoritative fleet, fetched ONCE — both the auto-dispatch (A) and
    // the engine sweep use it (one RPC, and the request is emitted synchronously
    // so hosts/replies see it immediately).
    const fleet = await opts.backend.fleetStatus();
    // FLEET-vS-INVENTORY PARITY (AUTOPILOT-6): the RPC count is the floor, never
    // a replacement for what the engine's own view (event ledger + store)
    // knows is running — a transient undercount (status RPC lagging a
    // just-started parent) must not let the harness OVER-SPAWN into phantom
    // free slots. Auto-dispatch fires on every free-slot window now (not just
    // worker-done), so this guard matters more. Zombie reconciliation uses the
    // BACKEND's corrected count (fleetStatus now unions the RPC with the
    // in-flight async-run inventory, so a 0 really means nothing is running
    // anywhere this backend spawns; the undefined guard still covers an RPC
    // failure — never a fake 0).
    const storeOccupied = (() => {
      const s = loadStore(opts.stateDir);
      return s ? storeToSnapshot(s).occupied : 0;
    })();
    const effectiveTotalActive = Math.max(fleet?.totalActive ?? 0, autopilot.status().running, storeOccupied);
    if (source === "timer") {
      // RETENTION: drop keep refs whose job is done (item terminal, or tip
      // reachable from main) so preserved refs don't accumulate forever.
      try {
        prunePreservedRefs(opts.stateDir);
      } catch {
        // never let retention break the sweep
      }
      // Zombie reconciliation FIRST (deterministic safety net): flip active
      // items whose run is provably gone (fleet idle past grace) so a lost
      // completion event cannot wedge an item in active forever. Any flips
      // ride the consolidated harness tick — the orchestrator learns WHAT was
      // flipped and checks pi-parallel-* branches before re-dispatching. The
      // preservation capture above already ran, so even a timed-out worker's
      // last commits were journalled while its branch still existed.
      try {
        const zombies = autopilot.zombieReconcile(fleet?.totalActive); // the corrected count (RPC + async-inventory union) — only a genuine 0 may trigger the net
        if (zombies.flippedKeys.length) {
          harnessTick([`zombie reconciliation flipped ${zombies.flippedKeys.join(", ")} to failed (no live run — verify partial work on pi-parallel-* branches before re-dispatch)`], fleet?.totalActive);
          // DECISION TICK per flip — the canonical one-line move record, in
          // addition to the consolidated harness line above (which keeps the
          // verify-branch guidance). Router-gated like every other harness
          // tick: a busy deferral holds it for the settle; a permanent drop
          // is covered by the harness line — never lost, never a surprise.
          for (const key of zombies.flippedKeys) {
            const decision = decisionTick({ key, action: "failed", from: "active", to: "failed", note: "zombie" });
            if (!decision) continue;
            const sendResult = router.send(decision, { bypassCooldown: true });
            // REVIEW/COMPLETE are already ticked (review ticks on verdict
            // routing; the harness tick on worker completion/auto-actions) —
            // zombie is the one harness flip that only got the batch line.
            if (sendResult === "deferred") queueDeferred(decision, "tick");
          }
        }
      } catch {
        // never let the safety net break the sweep
      }
    }
    // A — fill free slots with auto-dispatchable items before deciding ticks,
    // so the dispatch nudge fires only for the MANUAL cases (high-risk or
    // incomplete scope/cwd). Fires on EVERY free-slot window — the activation
    // path, the turn-end settle, the periodic sweep, AND worker completions:
    // the docs/skill contract is "an approved item fills a free slot by itself"
    // (no worker-done qualifier), and the worker-done-only gate stranded
    // approved items next to idle slots until a completion happened (observed
    // live: early-ON window fired ZERO auto-dispatches; idle free slots needed
    // the manual dispatch tick — AUTOPILOT-9). The eligible-item + slot guards
    // make the extra triggers inert when there is nothing to do.
    if (autoDispatchOn) {
      try {
        const dispatched = await autoDispatchEligible(opts.stateDir, opts.backend, cfg().maxSlots, effectiveTotalActive);
        if (dispatched.length) harnessTick([`dispatched ${dispatched.map((d) => d.key).join(", ")}`], fleet?.totalActive);
      } catch {
        // silent — the tick still nudges the manual cases
      }
    }
    // AUTOMATIC RECOVERY of failed items (AUTO-RECOVER-FAILS): the failed lane
    // re-dispatches by policy AFTER the backoff; running it after auto-dispatch
    // lets the engine's slot math see the just-filled slots. The pass arms its
    // own backoff timer for the next due attempt.
    await runRecoveryPass(effectiveTotalActive);
    const result = autopilot.sweep(source, Date.now(), fleet ? { totalActive: fleet.totalActive } : undefined);
    if (result.tick) sendTick(result.tick);
    // timer/activate safety net: stuck ai-review items get a review nudge —
    // the "stuck" wording (reviewers may still be running; never claim completion)
    else if (source === "timer" || source === "activate") sendTick(autopilot.reviewTick(undefined, "stuck"));
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    onCompletion(ev) {
      // The SHARED autopilot gate: when the toggle is off, the harness ignores
      // completions entirely (no flips, no verdict routing, no auto-actions) —
      // the orchestrator reconciles manually. Both hosts inherit this; they
      // must not re-implement the gate in their own handlers.
      if (!enabled()) return;
      const result = autopilot.handleAsyncComplete(ev);
      if (opts.emit) opts.emit(result.domainEvents);
      // TRANSITION-TIMED preservation capture: the active→ai-review/failed
      // flip is the last queue-state change this run gets — journal its
      // parallel-branch tip NOW so commits that landed after the previous
      // sweep are still recorded (best-effort: if the runtime's own cleanup
      // already removed the branch, this no-ops and the sweep captures hold).
      try {
        const doneRunId = String((ev as { runId?: string }).runId ?? "");
        const store = doneRunId ? loadStore(opts.stateDir) : null;
        const item = store ? itemByRunId(store, doneRunId) : null;
        if (item?.cwd) preserveRunWorktree({ stateDir: opts.stateDir, repo: item.cwd, runId: doneRunId, key: item.key });
      } catch {
        // preservation never breaks completion routing
      }
      // B + C, ONE consolidated harness tick. B — a review FAIL
      // auto-re-dispatches with the findings (up to the cap; the engine
      // already flipped to active when attempts < cap). C — a worker
      // completion (active → ai-review) auto-dispatches its review with the
      // SAME fields the dispatch used (KEY + scope + cwd). The orchestrator
      // learns what happened from the single harness tick and can still
      // queue_review/queue_dispatch to override.
      if (autoDispatchOn) {
        const verdict = result.domainEvents.find((e) => e.name === "orch:verdict" && e.data?.verdict === "FAIL");
        const completed = result.domainEvents.find(
          (e) => e.name === "orch:item-completed" && e.data?.outcome === "ai-review",
        );
        const tasks: Array<Promise<{ part: string; ok: boolean }>> = [];
        if (verdict) {
          const findings = (Array.isArray(ev.results) ? ev.results : [])
            .map((r) => (r as { agent?: string; output?: string })?.output ?? "")
            .filter(Boolean)
            .join("\n\n");
          const key = String(verdict.data?.key ?? "");
          if (key && findings) {
            tasks.push(autoRedispatch(opts.stateDir, opts.backend, key, findings).then((ok) => ({ part: `re-dispatched ${key} with findings`, ok })));
          }
        }
        if (completed) {
          const key = String(completed.data?.key ?? "");
          if (key) {
            tasks.push(
              autoReview(opts.stateDir, opts.backend, cfg().reviewerAgents[0] ?? "orchestrator-reviewer", key).then((runId) => ({
                part: `reviewer for ${key}${runId ? ` (run ${String(runId).slice(0, 8)})` : ""}`,
                ok: !!runId,
              })),
            );
          }
        }
        if (tasks.length) {
          void Promise.all(tasks)
            .then((results) => {
              const parts = results.filter((r) => r.ok).map((r) => r.part);
              if (parts.length) harnessTick(parts);
            })
            .catch(() => {
              // silent — the review tick nudges the orchestrator
            });
        }
      }
      
      // DETERMINISTIC HANDOVER: on a review PASS the framework auto-flags for
      // the user's review, built from the ITEM (title/scope/risk/cwd — the
      // orchestrator wrote those at approval, so no judgment is needed here).
      // The user ALWAYS gets the notification; the orchestrator's manual
      // flag_for_review becomes the refinement (specific files/commits).
      const pass = result.domainEvents.find((e) => e.name === "orch:verdict" && e.data?.verdict === "PASS");
      if (pass) {
        try {
          const key = String(pass.data?.key ?? "");
          const store = loadStore(opts.stateDir);
          const item = store?.items[key];
          if (item) {
            const risk = (["low", "medium", "high"] as const).includes(item.risk as never) ? (item.risk as "low" | "medium" | "high") : "medium";
            const scopeHead = (item.scope ?? "").split(/\n/)[0].trim().slice(0, 80);
            // POINTER-RICH targets: shared builder (cwd + branch@tip diff/view
            // commands + changed-file deliverable paths + web link) — also used
            // by the decision panel, one source of "where do I navigate".
            const targets = humanReviewTargetsFor(opts.stateDir, key, item);
            flagForReview(
              {
                summary: `${item.title || key} — agent review PASSED, awaiting your approval (human-review). Accept with queue_update status: done${scopeHead ? ` (${scopeHead}…)` : ""}.`,
                risk,
                blast_radius: `The reviewed work lands in the repo at ${item.cwd ?? "?"} — if wrong, ${item.title || key} is affected.`,
                review_targets: targets.length ? targets : [item.cwd ?? "", `the reviewed work (queue item ${key})`],
                self_reviewed: true,
                review_method: "reviewer-subagent",
                queue_key: key,
              },
              { logPath: join(opts.stateDir, "reviews.jsonl") },
            );
          }
        } catch {
          // the PASS tick below still nudges the orchestrator to flag manually
        }
      }
      sendTick(result.tick);
      if (result.freedSlot) {
        // ANY run completing frees a slot → dispatch sweep with the
        // authoritative fleet count.
        void sweep("worker-done");
      }
      if (result.reviewerCompleted) {
        sendTick(autopilot.reviewTick());
      }
    },
    deferUserMessage,
    onSettled() {
      // flush the shared deferral + the queued harness info FIRST (the agent
      // just settled — the busy gate is clear), then the sweep's nudges.
      flushDeferred();
      flushHarness();
      void sweep("settled");
    },
    onTimer() {
      flushDeferred(); // backstop if the agent never settles
      flushHarness();
      try {
        void sweep("timer");
      } catch {
        // never let the timer break the host
      }
    },
    activate() {
      void sweep("activate");
    },
    start() {
      if (opts.sweepIntervalMs > 0 && !timer) {
        timer = setInterval(() => this.onTimer(), opts.sweepIntervalMs);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
    },
  };
}
