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
import { loadAutopilotConfig, appendTelemetry } from "../config.ts";
import { loadStore, itemByRunId } from "../queue-store.ts";
import { formatDurationMs } from "../duration.ts";
import { flagForReview } from "./flag-review.ts";
import { createTickRouter, type TickHostState } from "./tick-router.ts";
import { autoDispatchEligible, autoRedispatch, autoReview } from "./auto-dispatch.ts";
import { autoRecoverFails } from "./auto-recovery.ts";
import { decisionTick } from "./panels.ts";
import { humanReviewTargetsFor, preserveActiveItems, prunePreservedRefs, preserveRunWorktree, recordActiveWorktrees } from "./worktree-preservation.ts";
import { checkMainWrites } from "./main-write-guard.ts";
import { configChangeTick, detectConfigChanges, recordConfigSnapshot } from "./config-watch.ts";
import { runShippingPass } from "./shipping.ts";
import { runStateEvidence } from "./run-liveness.ts";

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
   *  SAME gate: deferred → held for the settle flush; never lost. Returns the
   *  router verdict so a caller with once-only state (the config watcher) can
   *  tell "nobody was listening" (dropped) from "held for the settle"
   *  (deferred) and re-announce instead of silently consuming the change. */
  const sendTickText = (message: string): "delivered" | "dropped" | "deferred" => {
    const r = router.send(message, { bypassCooldown: true });
    if (r === "deferred") queueDeferred(message, "tick");
    return r;
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
    for (const h of outcome.finisherHeld) {
      if (!h.surfaced) continue; // announced once, not on every sweep
      sendTickText(
        `[orch-tick: recover] ${h.key} is FINISHER-CLASS and failed (${h.cause}) — auto-recovery will NOT re-dispatch it (a finisher re-run can duplicate a landing, and a conflict-resolved cherry-pick or multi-commit squash leaves no evidence to detect). It STAYS failed. Check the target checkout (git log / git cherry): if the work is IN, close it out (failed → done with an overrideReason); if it is not, re-dispatch it deliberately. Not a user request; respond ≤2 lines.`,
      );
    }
    for (const l of outcome.landedSkipped) {
      if (!l.surfaced) continue; // announced once, not on every sweep
      sendTickText(
        `[orch-tick: recover] ${l.key} is marked failed but its work is EVIDENCED AS LANDED (${l.repo} HEAD ${l.sha.slice(0, 8)}) — auto-recovery will NOT re-dispatch it (a re-run would duplicate a merge that already landed). Verify the landed commit, then close it out (failed → done) or re-open deliberately. Not a user request; respond ≤2 lines.`,
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
  /** FLEET-RPC DEGRADED EPISODE (AUTOPILOT-24): true while `backend.fleetStatus()`
   *  cannot tell us the fleet — it THREW, or it returned NULL after having
   *  answered before. One-shot like `heldNotified` in recovery-state.ts — the
   *  orchestrator learns the harness went fleet-blind once per episode and once
   *  when it recovers, not on every sweep. Silent degradation ('the
   *  orchestrator just stopped doing anything') is the failure class this
   *  framework keeps getting bitten by. */
  let fleetRpcDegraded = false;
  /** LEARNED CAPABILITY (AUTOPILOT-24): flipped by the first fleetStatus() that
   *  actually answers. The seam's type is `Promise<{totalActive}|null>`, so a
   *  backend that does not implement a fleet view answers `null` FOREVER and is
   *  UNSUPPORTED, not degraded — ticking every sweep for it would be pure spam.
   *  A backend that answered once and now returns null is BROKEN, and that is
   *  the real-world failure mode: the pi backend's `rpc()` resolves a timeout as
   *  `{success:false}` (backends/pi.ts) → fleetStatus() returns null, it never
   *  rejects. Capability is therefore learned at runtime instead of declared. */
  let fleetRpcEverAnswered = false;
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
      // AUTOPILOT-47 C: and record WHERE each active run's worktree is, so a
      // reaped run's UNCOMMITTED changes are found by reading the item instead
      // of matching run ids to pi-worktree-* directories by hand.
      recordActiveWorktrees(opts.stateDir);
    } catch {
      // preservation must never break the sweep
    }
    // CONFIG CHANGE SIGNAL (KEY: AUTOPILOT-48) — a fleet-wide config edit
    // (`/autopilot capacity 6` writes autopilot.config.json) used to reach the
    // HUMAN's TUI only: the orchestrator kept dispatching against the cached
    // cap and told the user work was gated after the cap had doubled. The
    // change now rides the SAME [orch-tick] channel as queue decisions, ONCE
    // per change (the surfaced values are snapshotted next to the harness
    // state). A permanently dropped tick (no loaded orchestrator) is NOT
    // recorded as surfaced — the next sweep re-announces it.
    try {
      const current = cfg();
      const changes = detectConfigChanges(opts.stateDir, current);
      const message = configChangeTick(changes);
      if (!message) {
        recordConfigSnapshot(opts.stateDir, current); // baseline / unchanged
      } else if (sendTickText(message) !== "dropped") {
        recordConfigSnapshot(opts.stateDir, current);
      }
    } catch {
      // the config notice must never break the sweep
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
    // ORDERING: this runs AFTER the guard, so a flow 'merge' ship moves main
    // past the baseline the guard just took. The lane closes that gap itself
    // via recordExpectedMainWrite (the narrow expected-write handshake) — its
    // own legitimate merge must never fire a main-immutability violation, and
    // any OTHER main move still does.
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
    // GUARDED (AUTOPILOT-24): this was the ONE bare await in sweep(). A throwing
    // status RPC used to skip EVERYTHING below it (zombie reconciliation,
    // auto-dispatch, recovery, the engine sweep) AND escape as an unhandled
    // rejection in the host process. A throw now degrades to the UNKNOWN fleet
    // (`null`) — a state every consumer below already handles — so the rest of
    // the sweep still runs off the store/ledger inventory.
    //
    // WHAT COUNTS AS DEGRADED: "could not determine the fleet", not just
    // "threw". The pi backend NEVER rejects — `rpc()` resolves a timeout as
    // `{success:false, error}` and fleetStatus() turns that into `null`
    // (backends/pi.ts) — so a null RETURN is the failure mode that actually
    // happens in production and the throw path is close to unreachable there.
    // But `null` is ALSO the seam's legitimate "I have no fleet view" answer,
    // and a backend that never implements one would tick every single sweep.
    // The two are told apart by LEARNED CAPABILITY (`fleetRpcEverAnswered`):
    // null degrades only once this runner has seen the backend answer at least
    // once (or an episode is already open). A throw always degrades — the seam
    // spells "unsupported" as null, never as an exception.
    let fleet: { totalActive: number } | null = null;
    let fleetFailure: string | null = null; // null = the RPC answered
    let fleetThrew = false;
    try {
      fleet = await opts.backend.fleetStatus();
      if (!fleet) fleetFailure = "returned NULL (no fleet answer — a failed/timed-out status RPC resolves null instead of rejecting)";
    } catch (e) {
      // UNKNOWN fleet, never a fake 0 — zombieReconcile(undefined) refuses to flip.
      fleet = null;
      fleetThrew = true;
      fleetFailure = `THREW (${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`;
    }
    if (fleetFailure === null) {
      fleetRpcEverAnswered = true; // capability proven — nulls from here on are BREAKAGE
      if (fleetRpcDegraded) {
        fleetRpcDegraded = false;
        appendTelemetry(opts.stateDir, JSON.stringify({ t: new Date().toISOString(), type: "fleet-rpc", state: "recovered", source }));
        sendTickText(
          `[orch-tick: harness] fleet RPC RECOVERED: backend.fleetStatus() answers again (fleet ${fleet ? fleet.totalActive : "unknown"} active) — fleet-aware sweeps resume, including zombie reconciliation. Not a user request; respond ≤2 lines.`,
        );
      }
    } else if (fleetThrew || fleetRpcEverAnswered || fleetRpcDegraded) {
      // Not the never-answered (UNSUPPORTED) backend: this one lost a fleet
      // view it demonstrably had, so the blindness is worth saying out loud.
      appendTelemetry(
        opts.stateDir,
        JSON.stringify({ t: new Date().toISOString(), type: "fleet-rpc", state: "failed", source, mode: fleetThrew ? "threw" : "null", error: fleetFailure }),
      );
      if (!fleetRpcDegraded) {
        fleetRpcDegraded = true;
        sendTickText(
          `[orch-tick: harness] DEGRADED: backend.fleetStatus() ${fleetFailure} — the sweep CONTINUES with an unknown fleet: auto-dispatch + recovery still run off the store/ledger inventory, and zombie reconciliation is SUSPENDED (unknown is never read as 0, so no live item is flipped to failed by an RPC blip). One notice per degraded episode; a recovery tick follows when the RPC answers again. Not a user request; respond ≤2 lines.`,
        );
      }
    }
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
        // DEAD-RUN reconciliation runs FIRST and is NOT fleet-gated (AUTOPILOT-47).
        // zombieReconcile below needs an authoritatively IDLE fleet, which a busy
        // queue never has — one live worker made every dead run in the store
        // immune (observed: 117m and 287m stale items while other workers ran).
        // This pass condemns a run on its OWN status.json saying a terminal
        // phase, and on nothing weaker: an unreadable/absent/unknown status is
        // absence of evidence and is left alone (see run-liveness.ts).
        const dead = autopilot.deadRunReconcile((runId) => runStateEvidence(opts.backend, runId));
        if (dead.flippedKeys.length) {
          harnessTick([`dead-run reconciliation flipped ${dead.flippedKeys.join(", ")} to failed (the run's own status.json reports a terminal state — its completion event was lost; verify partial work on pi-parallel-* branches before re-dispatch)`], fleet?.totalActive);
          for (const key of dead.flippedKeys) {
            const decision = decisionTick({ key, action: "failed", from: "active", to: "failed", note: "dead-run" });
            if (!decision) continue;
            const sendResult = router.send(decision, { bypassCooldown: true });
            if (sendResult === "deferred") queueDeferred(decision, "tick");
          }
        }
      } catch {
        // never let the safety net break the sweep
      }
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
    // Guarded at the CALL SITE too: runRecoveryPass's own try/catch covers the
    // autoRecoverFails engine call, but the tick delivery AFTER it (sendTickText
    // → the deferral flush → refreshTickFacts against the live store) is outside
    // that guard, so a failure there would still abort the engine sweep below.
    try {
      await runRecoveryPass(effectiveTotalActive);
    } catch {
      // recovery announcements must never break the sweep
    }
    const result = autopilot.sweep(source, Date.now(), fleet ? { totalActive: fleet.totalActive } : undefined);
    if (result.tick) sendTick(result.tick);
    // timer/activate safety net: stuck ai-review items get a review nudge —
    // the "stuck" wording (reviewers may still be running; never claim completion)
    else if (source === "timer" || source === "activate") sendTick(autopilot.reviewTick(undefined, "stuck"));
  };

  /** One-shot dedupe for the sweep-failure tick (same episode discipline as
   *  `fleetRpcDegraded`): cleared by the next sweep that completes. */
  let sweepFailureNotified = false;
  /** EVERY sweep trigger goes through here (AUTOPILOT-24). A rejected sweep
   *  used to be a bare `void sweep(...)` — an UNHANDLED PROMISE REJECTION
   *  inside the host process (pi extension / opencode plugin), which can take
   *  the host down or vanish silently depending on the runtime. The guarded
   *  fleet RPC above removed today's known thrower; this records tomorrow's
   *  unknown one instead of losing it. */
  const runSweep = (source: "settled" | "activate" | "timer" | "worker-done"): void => {
    void sweep(source)
      .then(() => {
        sweepFailureNotified = false; // a completed sweep ends the failing episode
      })
      .catch((e: unknown) => {
        try {
          const reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
          appendTelemetry(opts.stateDir, JSON.stringify({ t: new Date().toISOString(), type: "sweep-failure", source, error: reason }));
          if (sweepFailureNotified) return; // one notice per failing episode, not per sweep
          sweepFailureNotified = true;
          sendTickText(
            `[orch-tick: harness] SWEEP FAILED (${source}): ${reason} — the harness caught it instead of losing it to an unhandled rejection, but THIS sweep did no work (dispatch, recovery and ticks were skipped). Later triggers retry; if it repeats, the harness is effectively stopped. Not a user request; respond ≤2 lines.`,
          );
        } catch {
          // the failure recorder itself must never reject — that would recreate
          // the very unhandled rejection this wrapper exists to prevent
        }
      });
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
        runSweep("worker-done");
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
      runSweep("settled");
    },
    onTimer() {
      flushDeferred(); // backstop if the agent never settles
      flushHarness();
      runSweep("timer"); // never lets the timer break the host (sync or async)
    },
    activate() {
      runSweep("activate");
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
