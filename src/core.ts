// core.ts — the orchestrator-autopilot decision engine. Framework-agnostic:
// consumes subagent lifecycle events, owns a run ledger, derives the domain
// signals (slot-freed / queue-low / capacity-gap) from the PROGRAMMATIC QUEUE
// STORE (queue.json — extension-owned, machine-readable) and decides whether
// to emit a tick. Adapters (pi/opencode/claude) wire this to their platform
// events, wake channels, and queue tools.
//
// Design principle: the plugin guarantees the TRIGGER, the orchestrator keeps
// the JUDGMENT. This engine never picks a task, never dispatches, never
// approves. It ensures the orchestrator runs its loop at the right moments.
//
// Facts split: FLEET (running workers) is event-derived via the run ledger;
// QUEUE (approved/ready items) comes from the queue store — both deterministic.
// The old state.md parse survives ONLY as a transition-period fallback (the
// store is migrated once from state.md, then md is retired).
//
// Deferred delivery (AUTOPILOT-6): a tick whose delivery the busy-deferral
// held is RE-DERIVED from the live store at delivery (refreshTickFacts) — the
// facts in the message are the facts at delivery, never a stale generation-time
// snapshot ("X free, N ready" can never be shown while those items run).
//
// Fail-safe to action: when neither store nor md is available, we tick anyway
// rather than risk a missed refill — a spurious tick costs one LLM turn, a
// missed one costs an idle slot.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadStore,
  mutateStore,
  itemByRunId,
  itemByReviewerRunId,
  updateItem,
  type QueueStore,
  type FailCause,
} from "./queue-store.ts";
import type { Tick, TickReason, CompletionEvent, DomainEvent, AutopilotResult } from "./types.ts";
import type { AutopilotConfig } from "./config.ts";
import { parseVerdict } from "./verdict.ts";
import { appendOverride, finisherLandedEvidence, isFinisherItem, landedNote, landedOverride } from "./finisher-evidence.ts";
import { collectRunIds } from "./run-ids.ts";
import { formatDurationMs } from "./duration.ts";

// The snapshot shape the tick engine consumes (derived from the queue store).
// The legacy md parser (queue.ts) is RETIRED — state.md exists only as a
// one-time migration input, parsed by queue-store.migrateFromMd.
interface QueueState {
  active: Array<{
    key: string;
    runId?: string;
    status?: string;
    title: string;
    line: string;
    lineIndex: number;
    section: string;
  }>;
  approved: Array<{ key: string; title: string; line: string; lineIndex: number }>; // all dispatchable
  occupied: number;
  ready: number;
  /** The queue-known inventory (max of the event ledger + store-derived),
   *  pre-fleet clamp — used for the fleet-status-vs-inventory parity note. */
  tracked?: number;
  /** Items awaiting the user's approval decision (status: proposal). */
  proposalsPending: number;
  ok: boolean;
  /** Budget telemetry: ACTIVE items with a recorded wall-clock budget
   *  (timeoutMs) — remaining/cap per run, so dispatch ticks can surface cap
   *  risk (~75% used) before the run is cut off. Derived from the item's
   *  updatedAt (the flip-to-active dispatch stamp ≈ run start). */
  budget: Array<{ key: string; cap: number; remaining: number; elapsed: number; used: number }>;
  /** Keys of FAILED items whose cause is budget-capped — the at-cap recovery
   *  queue (re-dispatch with a bigger budget). */
  budgetCappedFailed: string[];
}


interface LedgerEntry {
  agent?: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

export class Autopilot {
  private cfg: Required<Pick<AutopilotConfig, "maxSlots" | "queueLowThreshold" | "workerAgents" | "quietPeriodMs" | "zombieGraceMinutes">> & AutopilotConfig;
  private ledger = new Map<string, LedgerEntry>();
  private lastTickAt = 0;
  private lastTickHash = "";
  private lastSettledHash = "";
  private lastReviewTickAt = 0;
  /** Runs already warned about approaching their budget (one warning per run
   *  per Autopilot lifetime — the timer must not nag every sweep). */
  private budgetWarned = new Set<string>();

  constructor(config: AutopilotConfig) {
    this.cfg = {
      maxSlots: 3,
      queueLowThreshold: 2,
      workerAgents: ["worker"],
      reviewerAgents: ["orchestrator-reviewer"],
      reviewCap: 5,
      quietPeriodMs: 60_000,
      zombieGraceMinutes: 30,
      ...config,
    };
  }

  // -- public API -----------------------------------------------------------

  /** subagent:async-started → record the run in the ledger (fleet truth). */
  handleAsyncStarted(runId: string, agent?: string | null, now = this.now()): AutopilotResult {
    if (!runId) return empty();
    this.ledger.set(runId, { agent: agent ?? undefined, startedAt: now });
    this.logEvent("started", { runId, agent });
    return empty();
  }

  /**
   * subagent:async-complete → attribute the run to the store item and flip
   * active→ai-review/failed. Does NOT tick — the adapter fetches the
   * AUTHORITATIVE fleet count (pi-subagents fleet status — the same source the
   * orchestrator's `subagent status` reads) and then sweeps, so the tick's
   * FLEET number can never contradict the orchestrator's own view.
   */
  handleAsyncComplete(ev: CompletionEvent, now = this.now()): AutopilotResult {
    const topRunId = typeof ev.runId === "string" && ev.runId ? ev.runId : typeof ev.id === "string" ? ev.id : undefined;
    if (!topRunId) return empty();
    const entry = this.ledger.get(topRunId);
    this.ledger.delete(topRunId);
    this.logEvent("complete", { runId: topRunId, agent: ev.agent, success: ev.success, status: ev.status });

    const candidates = collectRunIds(ev);
    let outcome: "failed" | "ai-review" = ev.success === false || ev.timedOut ? "failed" : "ai-review";

    let flipped = false;
    let flippedKey = "";
    let failCause: FailCause | null = null;
    /** FINISHER-EVIDENCE (AUTOPILOT-34): set when a runtime failure verdict was
     *  overridden because the item's work is evidenced as LANDED. */
    let landedOverrideNote: string | null = null;
    const store = loadStore(this.cfg.stateDir);
    if (store) {
      for (const cand of candidates) {
        const it = itemByRunId(store, cand);
        if (it && it.status === "active") {
          // BUDGET-GOVERNANCE: make the FAIL cause EXPLICIT. A run that was
          // cut off by its wall-clock budget (the runtime reported timedOut,
          // or the run lived at/over the item's recorded timeoutMs) is a CAP
          // failure — the work is unjudged and the recovery is a bigger-budget
          // re-dispatch — NOT the same as a run that ended with an unsuccessful
          // verdict. Recorded as the machine flag failCause + a human note.
          // The store change goes through mutateStore (load → apply → write,
          // serialized + CAS): a harness flip on a timer used to clobber a
          // concurrent tool write with its own whole-file snapshot.
          // FINISHER-EVIDENCE (AUTOPILOT-34): a FINISHER-CLASS run writes into
          // the declared cwd's checkout, NOT its worktree, so the runtime's
          // "no edits in the worktree" signal cannot judge it. Before believing
          // a failure verdict, ask the authoritative record: did the declared
          // cwd's HEAD move off the dispatch baseline? If it did, the work
          // LANDED — the verdict is overridden (and the override RECORDED, so
          // a pattern of overrides is visible), and the item takes the normal
          // success path. A finisher whose HEAD did NOT move has no evidence,
          // so its failure stands — the real "wrote a plan and stopped" case.
          if (outcome === "failed" && isFinisherItem(it)) {
            const evidence = finisherLandedEvidence(it, now);
            if (evidence) {
              const note = landedNote(evidence, topRunId, now);
              mutateStore(this.cfg.stateDir, (s) => {
                const fresh = s.items[it.key];
                if (!fresh || fresh.status !== "active") return;
                updateItem(s, it.key, {
                  status: "ai-review",
                  landedEvidence: evidence,
                  overrides: appendOverride(fresh, landedOverride(evidence, topRunId, now)),
                  notes: fresh.notes ? `${fresh.notes}\n\n${note}` : note,
                });
              });
              outcome = "ai-review";
              landedOverrideNote = note;
              flipped = true;
              flippedKey = it.key;
              this.logEvent("flip", { key: it.key, runId: cand, outcome, source: "finisher-landed" });
              break;
            }
          }
          if (outcome === "failed") {
            failCause = workerFailCause(ev, it.timeoutMs, it.updatedAt, now);
            const capNote = failCause === "budget-capped"
              ? `[budget-capped] ${new Date(now).toISOString()} — worker run ${topRunId} hit the item's wall-clock budget` +
                (it.timeoutMs ? ` (cap ${formatDurationMs(it.timeoutMs)}, timeoutMs ${it.timeoutMs}ms)` : " (runtime default)") +
                ` and was CUT OFF mid-task — this is a CAP, not a verdict on the work. Partial work may exist on the pi-parallel-* branch (verify before re-dispatch). RE-DISPATCH WITH A BIGGER BUDGET: queue_update('${it.key}', {timeoutMs: <larger than ${it.timeoutMs ? `${it.timeoutMs}ms` : "the previous cap"}>}) then queue_dispatch — the recorded budget rides every dispatch lane (the harness also auto-recovers capped items with a bigger budget).`
              : failCause === "spawn"
                ? `[failed: spawn] ${new Date(now).toISOString()} — worker run ${topRunId} died at the provider/infra layer (bare 400 / empty api_error — no deliverable produced), not a verdict on the work. The harness AUTO-RECOVERS with backoff (bounded retries, then escalates). Verify partial work on the pi-parallel-* branch.`
                : `[failed: verdict] ${new Date(now).toISOString()} — worker run ${topRunId} ended unsuccessfully (not budget-capped). Read its output; verify partial work on the pi-parallel-* branch before re-dispatching (failed items are re-dispatchable: queue_dispatch).`;
            mutateStore(this.cfg.stateDir, (s) => {
              const fresh = s.items[it.key];
              if (!fresh || fresh.status !== "active") return;
              updateItem(s, it.key, {
                status: "failed",
                failCause,
                notes: fresh.notes ? `${fresh.notes}\n\n${capNote}` : capNote,
              });
            });
          } else {
            mutateStore(this.cfg.stateDir, (s) => {
              if (s.items[it.key]?.status === "active") updateItem(s, it.key, { status: "ai-review" });
            });
          }
          flipped = true;
          flippedKey = it.key; // capture inside the loop — the FIRST matching item, not any same-status item
          this.logEvent("flip", { key: it.key, runId: cand, outcome, failCause: failCause ?? undefined });
          break;
        }
      }
    }

    // A flipped item (or a ledger-tracked run) freed a worker slot.
    const freedSlot = flipped || entry !== undefined;
    const isReviewerRun = [ev.agent, ...(Array.isArray(ev.results) ? ev.results.map((r) => (r as { agent?: string })?.agent) : [])]
      .filter((a): a is string => typeof a === "string" && !!a)
      .some((a) => this.cfg.reviewerAgents.includes(a));

    const domainEvents: DomainEvent[] = [];
    if (flipped) {
      domainEvents.push({ name: "orch:item-completed", data: { key: flippedKey, runId: topRunId, outcome } });
      // A WORKER FAILURE must never be silent (the historical gap: children
      // died at the budget default with no signal; recovery was archaeology).
      // Surface it as a failure tick — the operator sees it was capped and the
      // message routes a bigger-budget re-dispatch instead of generic
      // fail-forward. The verdict path also ticks (a failed run is exactly
      // when judgment is needed), without the budget-cap wording.
      if (outcome === "failed") {
        const item = loadStore(this.cfg.stateDir)?.items[flippedKey];
        const cap = item?.timeoutMs ?? null;
        domainEvents.push({ name: "orch:item-failed", data: { key: flippedKey, runId: topRunId, cause: failCause, timeoutMs: cap } });
        const capped = failCause === "budget-capped";
        const infra = failCause === "spawn";
        return {
          tick: {
            reason: "failure",
            message: capped
              ? `[orch-tick: failure] ${flippedKey} FAILED — its worker run ${topRunId.slice(0, 8)} hit the item's wall-clock budget cap` +
                (cap ? ` (${formatDurationMs(cap)})` : "") +
                ` and was CUT OFF mid-task (budget-capped, NOT a verdict on the work). Verify partial work on the pi-parallel-* branch, then RE-DISPATCH WITH A BIGGER BUDGET: queue_update('${flippedKey}', {timeoutMs: ${cap ? `> ${cap}` : "<a larger budget>"}}) then queue_dispatch (or let auto-dispatch take it — the recorded budget rides every lane). Respond ≤2 lines.`
              : infra
                ? `[orch-tick: failure] ${flippedKey} FAILED — its worker run ${topRunId.slice(0, 8)} died at the provider/infra layer (bare 400 / empty api_error, no deliverable) — NOT a verdict on the work. The harness AUTO-RECOVERS with a short backoff (bounded retries, then escalates); verify partial work on the pi-parallel-* branch. Respond ≤2 lines.`
                : `[orch-tick: failure] ${flippedKey} FAILED — its worker run ${topRunId.slice(0, 8)} ended unsuccessfully (verdict/exit, not budget-capped). Read the run's output and verify partial work on the pi-parallel-* branch before re-dispatching (failed items are re-dispatchable: queue_dispatch). Respond ≤2 lines.`,
            facts: {
              key: flippedKey,
              outcome: "failed",
              failCause,
              budgetCapped: capped,
              ...(cap !== null ? { timeoutMs: cap } : {}),
            },
          },
          domainEvents,
          flipped,
          freedSlot,
          reviewerCompleted: isReviewerRun,
        };
      }
      // A FALSE FAILURE THAT THE QUEUE OVERRODE must be visible: the operator
      // just saw the runtime report the run as failed, while the queue moved
      // the item forward on landed evidence. Silence there is how the two
      // views drift apart (and how a real failure eventually gets waved
      // through). The override itself is already RECORDED on the item.
      if (landedOverrideNote) {
        const evidence = loadStore(this.cfg.stateDir)?.items[flippedKey]?.landedEvidence ?? null;
        domainEvents.push({ name: "orch:failure-overridden", data: { key: flippedKey, runId: topRunId, evidence } });
        return {
          tick: {
            reason: "review",
            message:
              `[orch-tick: review] ${flippedKey} — the runtime reported run ${topRunId.slice(0, 8)} UNSUCCESSFUL, but this is a FINISHER-CLASS dispatch (writes outside its worktree) and its work LANDED: ` +
              `${evidence ? `${evidence.repo} ${evidence.ref ?? "HEAD"} ${String(evidence.fromSha ?? "?").slice(0, 8)} → ${evidence.sha.slice(0, 8)}` : "HEAD moved in the declared cwd"}. ` +
              `The failure verdict was OVERRIDDEN (recorded in the item's overrides[]) and ${flippedKey} moved to ai-review — do NOT re-dispatch it; verify the landed commit. Respond ≤2 lines.`,
            facts: { key: flippedKey, outcome: "ai-review", failureOverridden: true, ...(evidence ? { landedSha: evidence.sha, repo: evidence.repo } : {}) },
          },
          domainEvents,
          flipped,
          freedSlot,
          reviewerCompleted: isReviewerRun,
        };
      }
      return { tick: null, domainEvents, flipped, freedSlot, reviewerCompleted: isReviewerRun };
    }

    // REVIEWER completion path: attribute to the item via reviewerRunId, parse
    // the verdict line, auto-flip (strict parse only), and tick the orchestrator
    // for the remaining judgment (flag_for_review / re-dispatch / cap surface).
    if (isReviewerRun && store) {
      const matched = candidates.map((c) => itemByReviewerRunId(store, c)).find(Boolean) ?? null;
      if (matched) {
        domainEvents.push({ name: "orch:reviewer-completed", data: { key: matched.key, reviewerRunId: matched.reviewerRunId ?? topRunId } });
        const verdict = parseVerdict(ev, this.cfg.reviewerAgents);
        const withinQuiet = now - this.lastReviewTickAt < this.cfg.quietPeriodMs;
        if (verdict === "PASS") {
          // AI review passed → the item enters HUMAN review (your approval),
          // not done. The harness auto-flags it; YOU make it done.
          mutateStore(this.cfg.stateDir, (s) => {
            if (s.items[matched.key]) updateItem(s, matched.key, { status: "human-review" });
          });
          domainEvents.push({ name: "orch:verdict", data: { key: matched.key, verdict: "PASS", attempts: matched.attempts ?? 0 } });
          this.logEvent("flip", { key: matched.key, outcome: "human-review", source: "verdict-pass" });
          if (!withinQuiet) this.lastReviewTickAt = now;
          return {
            tick: withinQuiet ? null : {
              reason: "review",
              message: `[orch-tick: review] ${matched.key} PASSED AI review and is in HUMAN review, awaiting you — the harness auto-flagged it (with targets). Approve it (queue_update status: done), re-dispatch (active), or drop (rejected). Not a user request; respond ≤2 lines.`,
              facts: { key: matched.key, verdict: "PASS" },
            },
                        domainEvents,
            flipped: true,
            freedSlot: true, // reviewer slot freed — dispatch sweep runs too
            reviewerCompleted: true,
          };
        }
        if (verdict === "FAIL") {
          const attempts = (matched.attempts ?? 0) + 1;
          if (attempts >= this.cfg.reviewCap) {
            const causeNote = `[failed: verdict] ${new Date(now).toISOString()} — review FAIL at attempt ${attempts} (cap ${this.cfg.reviewCap}) — the work failed AI review ${attempts} times, not a budget cap. Apply the findings directly, re-scope, or drop.`;
            mutateStore(this.cfg.stateDir, (s) => {
              const fresh = s.items[matched.key];
              if (!fresh) return;
              updateItem(s, matched.key, {
                status: "failed",
                attempts,
                failCause: "verdict",
                notes: fresh.notes ? `${fresh.notes}\n\n${causeNote}` : causeNote,
              });
            });
            domainEvents.push({ name: "orch:verdict", data: { key: matched.key, verdict: "FAIL", attempts } });
            this.logEvent("flip", { key: matched.key, outcome: "failed", source: "verdict-cap" });
            if (!withinQuiet) this.lastReviewTickAt = now;
            return {
              tick: withinQuiet ? null : {
                reason: "review",
                message: `[orch-tick: review] ${matched.key} FAILED review at attempt ${attempts} (cap ${this.cfg.reviewCap}) — surface to the user: (a) apply findings directly, (b) review as-is, (c) drop. Not a user request; respond ≤2 lines.`,
                facts: { key: matched.key, verdict: "FAIL", attempts, cap: this.cfg.reviewCap },
              },
                            domainEvents,
              flipped: true,
              freedSlot: true, // reviewer slot freed — dispatch sweep runs too
              reviewerCompleted: true,
            };
          }
          mutateStore(this.cfg.stateDir, (s) => {
            if (s.items[matched.key]) updateItem(s, matched.key, { status: "active", attempts, runId: null, reviewerRunId: null });
          });
          domainEvents.push({ name: "orch:verdict", data: { key: matched.key, verdict: "FAIL", attempts } });
          this.logEvent("flip", { key: matched.key, outcome: "active", source: "verdict-fail", attempts });
          if (!withinQuiet) this.lastReviewTickAt = now;
          return {
            tick: withinQuiet ? null : {
              reason: "review",
              message: `[orch-tick: review] ${matched.key} FAILED review (attempt ${attempts}) — the item is ACTIVE: the harness auto-re-dispatches it (queue_dispatch only if autopilot's auto-dispatch is off). Before the redo runs: VERIFY GROUND TRUTH — false-negative reviews are the recurring pattern (the reviewer may have missed the work on a parallel branch); if the deliverable is already delivered, stop the redo + reconcile the item. Not a user request; respond ≤2 lines.`,
              facts: { key: matched.key, verdict: "FAIL", attempts },
            },
                        domainEvents,
            flipped: true,
            freedSlot: true, // reviewer slot freed — dispatch sweep runs too
            reviewerCompleted: true,
          };
        }
        // no parseable verdict → manual path
        const aiReviewing = Object.values(store.items).filter((i) => i.status === "ai-review").map((i) => i.key);
        return {
          tick: {
            reason: "review",
            message: `[orch-tick: review] Reviewer for ${matched.key} completed but the verdict line was not parseable — read its output and move the item to human-review / re-dispatch / failed yourself. In ai-review: ${aiReviewing.join(", ") || "none"}. Not a user request; respond ≤2 lines.`,
            facts: { key: matched.key, aiReview: aiReviewing },
          },
                    domainEvents,
          flipped: false,
          freedSlot: true, // reviewer slot freed — dispatch sweep runs too
          reviewerCompleted: true,
        };
      }
      // reviewer completed but no item attributed (plain subagent review) → generic review tick
      const aiReviewing = Object.values(store.items).filter((i) => i.status === "ai-review").map((i) => i.key);
      const generic = this.reviewTick(now);
      return {
        tick: generic,
                domainEvents,
        flipped: false,
        freedSlot: true, // reviewer slot freed — dispatch sweep runs too
        reviewerCompleted: true,
      };
    }

    // UNMATCHED COMPLETION telemetry: a worker/reviewer run ended but no
    // store item carries its id. This is the signature of a pipeline bypass
    // (an ad-hoc `subagent` spawn that never went through queue_dispatch, so
    // no run linkage was ever written) — the work lands on some branch while
    // the item stays put, and WITHOUT this line the only diagnosis is
    // archaeology across session logs (observed live: EVAL-WATCHDOG-ACTIVITY).
    // Non-harness agents (scouts, ad-hoc Q&A) are expected to be unmatched —
    // don't log those.
    if (!flipped && !isReviewerRun &&
        (this.cfg.workerAgents.includes(ev.agent ?? "") || this.cfg.reviewerAgents.includes(ev.agent ?? ""))) {
      this.logEvent("unmatched-completion", { runId: topRunId, agent: ev.agent, candidates });
    }

    return { tick: null, domainEvents, flipped, freedSlot, reviewerCompleted: isReviewerRun };
  }

  /** agent_settled → the orchestrator's own turn ended; check for unacted capacity. */
  handleAgentSettled(now = this.now()): AutopilotResult {
    return this.sweep("settled", now);
  }

  /**
   * Explicit capacity sweep — activation (/autopilot on), periodic timer,
   * settled turns, and store-driven completions. `fleet.occupied` is the
   * AUTHORITATIVE active-run count (pi-subagents fleet status — the same source
   * the orchestrator trusts); when absent, falls back to the event ledger /
   * store active items.
   */
  sweep(source: "settled" | "activate" | "timer" | "worker-done", now = this.now(), fleet?: { totalActive?: number }): AutopilotResult {
    const snapshot = this.readQueueSnapshot(now);
    // Occupied = ALL subagents dispatched from the orchestrator session —
    // workers, reviewers, scouts, plain subagent calls (the general case).
    //   - fleet.totalActive is the AUTHORITATIVE count (the backend's
    //     FLEET-vs-INVENTORY parity union: the pi-subagents status RPC + the
    //     in-flight async-run inventory — the same source `subagent status`
    //     reads). It sees every run this backend spawns, whatever its role,
    //     including parents the session-gated RPC alone would undercount.
    //   - FLEET-vs-INVENTORY PARITY (AUTOPILOT-6): the fleet count is the
    //     FLOOR, never a replacement for what the engine's OWN view (event
    //     ledger + store-derived) knows is running — a transient fleet
    //     undercount (status RPC lagging a just-started parent) must never
    //     report phantom free slots. Occupied = the conservative union:
    //     max(fleet, ledger, store). The old store undercount / ledger miss
    //     protection still holds — and now so does the RPC-undercount case.
    const tracked = Math.max(this.ledger.size, snapshot.occupied);
    const occupied = Math.max(fleet?.totalActive ?? 0, tracked);
    const eff = { ...snapshot, occupied, tracked };
    const hash = this.queueHash(eff);
    // settled/activate/worker-done: only tick when the queue state changed.
    // timer: re-nudge a PERSISTENT gap even when unchanged — the orchestrator
    // may have ignored the earlier nudge (or was mid-flight), and the 10-min
    // interval is the throttle. Without this, a gap nudged once and unacted
    // is never nudged again.
    if (source !== "timer" && hash === this.lastSettledHash) return empty();
    this.lastSettledHash = hash;
    this.logEvent("sweep", { source, occupied, ready: eff.ready, ledger: this.ledger.size, fleetTotalActive: fleet?.totalActive });

    const tick = this.decideTick(eff, source, undefined, now, true, fleet?.totalActive);
    if (tick) {
      this.logEvent("tick", { reason: tick.reason, source });
      return { tick, domainEvents: [], flipped: false, freedSlot: false, reviewerCompleted: false };
    }
    // BUDGET TELEMETRY at the timer heartbeat: an ACTIVE budgeted run past
    // ~75% of its wall-clock budget gets ONE proactive warning per run (the
    // operator can steer it to wrap up / commit before the cap cuts it off)
    // instead of the failure being the first signal. Nudged on the timer only
    // (the completion path for the cap itself is event-driven + deduped); the
    // warned set prevents a 10-minute nag for the same run.
    if (source === "timer") {
      const budgetTick = this.budgetWarningTick(eff.budget);
      if (budgetTick) {
        this.logEvent("tick", { reason: budgetTick.reason, source });
        return { tick: budgetTick, domainEvents: [], flipped: false, freedSlot: false, reviewerCompleted: false };
      }
    }
    return empty();
  }

  /**
   * Zombie reconciliation — the deterministic safety net for LOST completion
   * events. The active→ai-review/failed flip is event-driven
   * (subagent:async-complete on the spawning session's in-process bus), so a
   * run that ends while no session is listening (timeout overnight, crash,
   * restart) leaves its item active FOREVER — observed live (EVAL-EXPT-M3:
   * 8h timeout, still active the next day). The AUTHORITATIVE counter-evidence
   * is fleetStatus: when it reports zero active runs, NOTHING is running
   * anywhere this backend spawned (the backend count now unions the RPC with
   * the in-flight async inventory — an undercounting RPC can no longer fake a
   * 0, AUTOPILOT-6) — any `active` item idle past the grace
   * window is a zombie by definition. Flip it to failed with the evidence in
   * notes; the orchestrator then re-dispatches deliberately (verifying
   * pi-parallel-* branches for partial work first) instead of a dead run
   * occupying a phantom slot indefinitely.
   *
   * FAKE-ZERO GUARD (AUTOPILOT-6): only an AUTHORITATIVE fleet count may
   * trigger the net. When the RPC failed / the backend was unreachable the
   * runner passes `undefined` — that is NOT evidence of an idle fleet and must
   * never be coerced into a 0 (the old `?? 0` could flip LIVE runs whose
   * status call just timed out). Undefined → skip; a real 0 is required.
   */
  zombieReconcile(fleetTotalActive: number | undefined, now = this.now()): { flippedKeys: string[] } {
    if (fleetTotalActive === undefined) return { flippedKeys: [] }; // unknown fleet — NOT authority to flip (fake-zero guard)
    if (fleetTotalActive > 0) return { flippedKeys: [] }; // something IS running — fleet not authoritative-idle
    const graceMs = this.cfg.zombieGraceMinutes * 60_000;
    if (graceMs <= 0) return { flippedKeys: [] }; // 0 disables the sweep
    if (!loadStore(this.cfg.stateDir)) return { flippedKeys: [] };
    // The whole scan runs INSIDE the mutation: deciding from one snapshot and
    // writing a different one is the lost-update window. mutateStore may re-run
    // this on a conflict, so it stays a pure function of the store it is given
    // (the logging happens after it returns).
    const flipped = mutateStore(this.cfg.stateDir, (store) => {
      const keys: Array<{ key: string; runId: string | null }> = [];
      for (const it of Object.values(store.items)) {
        if (it.status !== "active") continue;
        const updatedAt = Date.parse(it.updatedAt);
        const idleMs = now - updatedAt;
        if (!Number.isFinite(updatedAt) || idleMs < graceMs) continue;
        const evidence =
          `zombie reconciliation ${new Date(now).toISOString()} — fleet reported 0 active runs while this item sat active ~${Math.round(idleMs / 60_000)}m past update ` +
          `(run ${it.runId ?? "?"}): timeout/crash/lost completion event. Partial work may exist on pi-parallel-* branches — verify before re-dispatch.`;
        updateItem(store, it.key, {
          status: "failed",
          failCause: "zombie",
          notes: it.notes ? `${it.notes}\n\n${evidence}` : evidence,
        });
        keys.push({ key: it.key, runId: it.runId ?? null });
      }
      return keys;
    });
    for (const f of flipped) this.logEvent("flip", { key: f.key, runId: f.runId, outcome: "failed", source: "zombie" });
    return { flippedKeys: flipped.map((f) => f.key) };
  }

  /**
   * Review tick — the deterministic trigger for the orchestrator's judgment
   * step: when items are stuck in `reviewing`, the orchestrator has no other
   * way to know a reviewer finished. Fired on reviewer completion and by the
   * periodic timer. The verdict (PASS/FAIL) is the orchestrator's call — the
   * tick only says "route it".
   */
  reviewTick(now = this.now(), why: "reviewer-completed" | "stuck" = "reviewer-completed"): Tick | null {
    const store = loadStore(this.cfg.stateDir);
    if (!store) return null;
    const aiReview = Object.values(store.items).filter((i) => i.status === "ai-review");
    const humanReview = Object.values(store.items).filter((i) => i.status === "human-review");
    if (!aiReview.length && !humanReview.length) return null;
    if (now - this.lastReviewTickAt < this.cfg.quietPeriodMs) return null;
    this.lastReviewTickAt = now;
    const aiKeys = aiReview.map((i) => i.key);
    const humanKeys = humanReview.map((i) => i.key);
    const message = why === "stuck"
      ? `[orch-tick: review] AI-review in flight: ${aiKeys.join(", ") || "none"} — check each: if its reviewer finished, read the verdict (human-review / re-dispatch); if the reviewer is still running, leave it (its completion will notify); if it died, re-dispatch. Awaiting YOUR approval: ${humanKeys.join(", ") || "none"} — queue_update status: done to accept, active to re-dispatch with findings. Not a user request; respond ≤2 lines.`
      : `[orch-tick: review] A reviewer completed. AI-review items: ${aiKeys.join(", ") || "none"}. Awaiting YOUR approval (human-review): ${humanKeys.join(", ") || "none"} — queue_update status: done to accept / active to re-dispatch / rejected to drop. Not a user request; respond ≤2 lines.`;
    return {
      reason: "review",
      message,
      facts: { aiReview: aiKeys, humanReview: humanKeys, count: aiKeys.length + humanKeys.length, why },
    };
  }

  /**
   * Budget warning tick — ONE proactive per-run nudge at the timer heartbeat
   * when an ACTIVE budgeted run has consumed ~75%+ of its recorded wall-clock
   * budget. Warned keys are remembered for the Autopilot lifetime and pruned
   * once the run leaves the at-risk set, so a re-dispatch that runs long again
   * warns once more, but the same run is never nagged every 10 minutes.
   */
  private budgetWarningTick(budget: QueueState["budget"]): Tick | null {
    const atRisk = budget.filter((b) => b.used >= 0.75);
    const riskKeys = new Set(atRisk.map((b) => b.key));
    // Prune runs that finished (or were re-dispatched below the line).
    for (const k of this.budgetWarned) {
      if (!riskKeys.has(k)) this.budgetWarned.delete(k);
    }
    const fresh = atRisk.filter((b) => !this.budgetWarned.has(b.key));
    if (!fresh.length) return null;
    for (const b of fresh) this.budgetWarned.add(b.key);
    const pctOf = (used: number): string => (used >= 1 ? "100%+" : `${Math.floor(used * 100)}%`);
    return {
      reason: "budget",
      message:
        `[orch-tick: budget] ${fresh.map((b) => `${b.key} has used ~${pctOf(b.used)} of its ${formatDurationMs(b.cap)} wall-clock budget (~${formatDurationMs(b.remaining)} left)`).join("; ")} — a budget cap will cut the run off mid-task. Steer it to wrap up + commit, or plan the bigger-budget re-dispatch now. Not a user request; respond ≤2 lines.`,
      facts: { budget: fresh.map((b) => ({ key: b.key, cap: b.cap, remaining: b.remaining, elapsed: b.elapsed, used: b.used })) },
    };
  }

  /** The OLDEST pending proposal's age in ms (null when none / unparseable). */
  private oldestProposalAgeMs(now: number): number | null {
    const store = loadStore(this.cfg.stateDir);
    if (!store) return null;
    let oldest: number | null = null;
    for (const it of Object.values(store.items)) {
      if (it.status !== "proposal") continue;
      const t = Date.parse(it.createdAt || it.updatedAt || "");
      if (Number.isNaN(t)) continue;
      if (oldest === null || t < oldest) oldest = t;
    }
    return oldest === null ? null : Math.max(0, now - oldest);
  }

  /** The key of the OLDEST pending proposal (for the intake tick's note). */
  private oldestProposalKey(): string | null {
    const store = loadStore(this.cfg.stateDir);
    if (!store) return null;
    let oldestKey: string | null = null;
    let oldestT = Number.POSITIVE_INFINITY;
    for (const it of Object.values(store.items)) {
      if (it.status !== "proposal") continue;
      const t = Date.parse(it.createdAt || it.updatedAt || "");
      if (Number.isNaN(t)) continue;
      if (t < oldestT) {
        oldestT = t;
        oldestKey = it.key;
      }
    }
    return oldestKey;
  }

  /** Public status snapshot for `/autopilot status`.
   */
  status(): { running: number; lastTickAt: number; lastTickHash: string } {
    return { running: this.ledger.size, lastTickAt: this.lastTickAt, lastTickHash: this.lastTickHash };
  }

  // -- internals ------------------------------------------------------------

  private readQueueSnapshot(now = this.now()): QueueState {
    const store = loadStore(this.cfg.stateDir);
    // No md fallback: state.md is retired (migration ran once at activation).
    // Missing store → empty snapshot → fail-safe to action (spurious tick costs
    // one turn; a missed one costs an idle slot).
    return store ? storeToSnapshot(store, now) : emptyState();
  }

  private decideTick(
    state: QueueState,
    source: string,
    runId: string | undefined,
    now: number,
    slotFreed: boolean,
    fleetTotalActive?: number,
  ): Tick | null {
    if (now - this.lastTickAt < this.cfg.quietPeriodMs) {
      // Within the quiet window, never repeat a tick with the same queue hash
      // (a completion re-arms it via the ledger-size hash component).
      if (this.lastTickHash === this.queueHash(state)) return null;
    }
    const tick = this.currentTick(state, source, runId, now, slotFreed, fleetTotalActive);
    if (tick) this.rememberTick(state, now);
    return tick;
  }

  /** The CURRENT-state tick decision — the single source of dispatch/intake
   *  message text. decideTick calls it at GENERATION (behind the quiet/hash
   *  gates above); refreshTickFacts calls it at DELIVERY so a busy-deferral
   *  flush re-derives FLEET/QUEUE facts instead of presenting the snapshot
   *  they were baked with. */
  private currentTick(
    state: QueueState,
    source: string,
    runId: string | undefined,
    now: number,
    slotFreed: boolean,
    fleetTotalActive?: number,
  ): Tick | null {
    const slotsFree = Math.max(0, this.cfg.maxSlots - state.occupied);
    const ready = state.ready;
    const readyKeys = state.approved.map((a) => a.key); // approved = dispatchable (the fold)
    // BUDGET-GOVERNANCE telemetry: any ACTIVE run past ~75% of its recorded
    // wall-clock budget is cap-risk — name it in the dispatch message so the
    // operator can steer/commit (or plan a bigger-budget re-dispatch) before
    // the cap cuts the run off. Facts always carry the full per-run
    // remaining/cap rows + the failed-at-cap recovery keys.
    const atRisk = state.budget.filter((b) => b.used >= 0.75);
    const pctOf = (used: number): string => (used >= 1 ? "100%+" : `${Math.floor(used * 100)}%`);
    const budgetLine = atRisk.length
      ? ` BUDGET: ${atRisk.map((b) => `${b.key} at ~${pctOf(b.used)} of its ${formatDurationMs(b.cap)} cap (~${formatDurationMs(b.remaining)} left)`).join("; ")} — cap risk: steer it to wrap up + commit, or plan a bigger-budget re-dispatch.`
      : "";
    // Cross-check: when the authoritative fleet sees runs beyond what the
    // engine's own view (ledger + store — the `tracked` inventory) attributes,
    // flag it so the orchestrator can run `subagent status` on the untracked
    // ones (scouts, plain subagent calls). Occupied itself is the conservative
    // union — never a queue-only or an RPC-only number.
    const tracked = state.tracked ?? state.occupied;
    const reconcile =
      typeof fleetTotalActive === "number" && fleetTotalActive > tracked
        ? ` (fleet status shows ${fleetTotalActive} active — ${fleetTotalActive - tracked} not tracked by the queue)`
        : "";

    // Capacity gap → dispatch tick (the core fix: refill on slot-free).
    // FLEET counts ALL session subagents (workers + reviewers + scouts — any
    // dispatched run occupies a slot); QUEUE comes from the store.
    if (slotFreed && slotsFree > 0 && ready >= 1) {
      return {
        reason: "dispatch",
        message:
          `[orch-tick: dispatch] FLEET: ${state.occupied}/${this.cfg.maxSlots} subagent runs active (workers + reviewers + scouts), ${slotsFree} free. ` +
          `QUEUE: ${ready} ready (${readyKeys.join(", ") || "none"}).` +
          reconcile +
          budgetLine +
          ` Rule: a slot is free + queue has ready work → dispatch it. System ping: run your loop. Respond ≤2 lines. Not a user request.`,
        facts: {
          slotsFree,
          occupied: state.occupied,
          ready,
          readyKeys,
          source,
          runId,
          fleetTotalActive,
          generatedAt: now,
          // Budget health: per-active-run remaining budget + cap (ms) and the
          // failed-at-cap recovery keys (failed=cap vs failed=verdict is the
          // failCause flag on each failed item).
          ...(state.budget.length ? { budget: state.budget.map((b) => ({ key: b.key, cap: b.cap, remaining: b.remaining, elapsed: b.elapsed, used: b.used })) } : {}),
          ...(state.budgetCappedFailed.length ? { budgetCapped: state.budgetCappedFailed } : {}),
        },
      };
    }

    // Queue drained below the buffer → intake tick (refill the approval buffer).
    // The ≤2-line rule does NOT apply here — intake ticks demand a REAL scan.
    if (ready < this.cfg.queueLowThreshold) {
      // INTAKE SUPPRESSION: while proposals from the previous intake are still
      // pending (the user is reading/thinking/discussing them), do NOT re-nudge
      // — ADDING proposals changes the queue hash, which would otherwise re-fire
      // this tick while the approved buffer is still low. The intake re-arms
      // when the proposals resolve (approved/rejected) or the queue changes.
      // AGE-AWARE: a proposal that has been pending for longer than the
      // suppression window (default 24h) must NOT starve the refill nudge
      // forever — the intake tick returns and names the stale proposal.
      if (state.proposalsPending > 0) {
        const suppressionMs = (this.cfg.intakeSuppressionHours ?? 24) * 3600 * 1000;
        const oldest = this.oldestProposalAgeMs(now);
        if (oldest !== null && oldest < suppressionMs) return null;
      }
      const stale = this.oldestProposalKey();
      return {
        reason: "intake",
        message:
          `[orch-tick: intake] QUEUE: approved buffer low (${ready} ready < ${this.cfg.queueLowThreshold}; ready: ${readyKeys.join(", ") || "none"}). ` +
          `FLEET: not involved — this is about refilling the approved queue, not dispatch. ` +
          `Run a FULL intake scan NOW: scan ALL sources in order, diff against the queue, AND run the beyond-source pass (cross-source gaps, industry standards, project understanding). ` +
          `Propose the next batch for approval per the approval gate (evidence + scope + value/urgency + risk). ` +
          `This is a real scan, not a quick check — present candidates. Not a user request; the ≤2-line rule does NOT apply to intake ticks.` +
          (stale ? ` NOTE: ${stale} has been pending for a while — resolve or reject it so it stops blocking the buffer.` : ""),
        facts: { ready, readyKeys, threshold: this.cfg.queueLowThreshold, source, runId, generatedAt: now },
      };
    }

    return null;
  }

  /**
   * DELIVERY-TIME FACT REFRESH (AUTOPILOT-6). A dispatch/intake tick that the
   * busy-deferral held is flushed at the host's NEXT settle — possibly long
   * after generation, when the store has moved underneath it (items the tick
   * listed as ready were dispatched mid-window, completions flipped items,
   * auto-dispatch filled slots). Re-derive the facts from the LIVE store (+
   * authoritative fleet when the caller has one, else the conservative
   * ledger/store fallback) so a late-delivered tick NEVER claims "X free,
   * N ready (…)" while those items are running:
   *   - returns the CURRENT truthful nudge (dispatch-first, then intake) with
   *     fresh facts + a refreshedAt stamp (generatedAt preserved for the audit
   *     trail); null when NO nudge applies to the current state — the flush
   *     drops the stale message rather than deliver it;
   *   - review ticks pass through untouched (their facts are event-scoped —
   *     key/verdict — they carry no FLEET/QUEUE claims).
   * The CURRENT state's hash is remembered so the same-settle sweep does not
   * re-fire the identical fresh nudge.
   */
  refreshTickFacts(tick: Tick, fleet?: { totalActive?: number }, now = this.now()): Tick | null {
    if (tick.reason !== "dispatch" && tick.reason !== "intake") return tick;
    const snapshot = this.readQueueSnapshot();
    // Same FLEET-vs-INVENTORY PARITY as sweep: the authoritative fleet is the
    // floor; the delivery-time numbers are the conservative union.
    const tracked = Math.max(this.ledger.size, snapshot.occupied);
    const occupied = Math.max(fleet?.totalActive ?? 0, tracked);
    const eff = { ...snapshot, occupied, tracked };
    const source = typeof tick.facts.source === "string" ? tick.facts.source : "settled";
    const fresh = this.currentTick(eff, source, undefined, now, true, fleet?.totalActive);
    if (!fresh) return null; // the nudge no longer applies — the stale message must not be delivered
    this.rememberTick(eff, now); // arm the same-settle sweep dedupe with the CURRENT hash
    const generatedAt = typeof tick.facts.generatedAt === "number" ? tick.facts.generatedAt : now;
    const facts = { ...fresh.facts, generatedAt, refreshedAt: now };
    // Delivery-time telemetry: the gap between the generation `tick` line and
    // this `tick-refresh` line IS the busy-deferral delay — and `changed`
    // records whether the live facts moved underneath the held message.
    this.logEvent("tick-refresh", { reason: fresh.reason, from: tick.reason, changed: fresh.message !== tick.message });
    return { ...fresh, facts };
  }

  private queueHash(state: QueueState): string {
    // Include the fleet count so a completion (ledger shrink) re-arms the
    // settle check even when the queue content itself did not change.
    return stateHash(state) + `|fleet:${this.ledger.size}`;
  }

  private rememberTick(state: QueueState, now: number): void {
    this.lastTickAt = now;
    this.lastTickHash = this.queueHash(state);
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  private logEvent(type: string, data: Record<string, unknown>): void {
    if (!this.cfg.log) return;
    try {
      this.cfg.log(JSON.stringify({ t: new Date().toISOString(), type, ...data }));
    } catch {
      // silent
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Derive the queue facts the tick engine needs from the store (deterministic).
 * Occupied = ALL subagents the queue has in flight: active items (workers) +
 * reviewing items with a reviewer dispatched (reviewerRunId set). This is the
 * store fallback for the fleet number — the fleet RPC totalActive is preferred
 * and covers runs the queue doesn't track (scouts, plain subagent calls).
 * `now` also drives the budget telemetry: elapsed = now − the item's
 * flip-to-active updatedAt stamp (≈ dispatch time), remaining = cap − elapsed. */
export function storeToSnapshot(store: QueueStore, now = Date.now()): QueueState {
  const items = Object.values(store.items);
  const active = items
    .filter((i) => i.status === "active")
    .map((i) => ({ key: i.key, runId: i.runId ?? undefined, status: "working" as const, title: i.title, line: "", lineIndex: 0, section: "active" as const }));
  const budget = active
    .filter((a) => {
      const it = store.items[a.key];
      return it.timeoutMs !== null && it.timeoutMs !== undefined && it.timeoutMs > 0;
    })
    .map((a) => {
      const it = store.items[a.key];
      const cap = it.timeoutMs as number;
      const startedAt = Date.parse(it.updatedAt || "");
      const elapsed = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
      return { key: a.key, cap, elapsed, remaining: Math.max(0, cap - elapsed), used: cap > 0 ? elapsed / cap : 0 };
    });
  const budgetCappedFailed = items
    .filter((i) => i.status === "failed" && i.failCause === "budget-capped")
    .map((i) => i.key);
  const approved = items
    .filter((i) => i.status === "approved")
    .map((i) => ({ key: i.key, title: i.title, line: "", lineIndex: 0 }));
  const reviewingWithReviewer = items.filter((i) => i.status === "ai-review" && i.reviewerRunId);
  const occupied = active.length + reviewingWithReviewer.length;
  const ready = approved.length; // approved = dispatchable (the fold)
  const proposalsPending = items.filter((i) => i.status === "proposal").length;
  return { active, approved, occupied, ready, proposalsPending, ok: true, budget, budgetCappedFailed };
}

function stateHash(state: QueueState): string {
  const active = state.active
    .map((a) => `${a.key}:${a.runId ?? ""}:${a.status ?? ""}`)
    .sort()
    .join("|");
  const approved = state.approved
    .map((a) => a.key)
    .sort()
    .join("|");
  return `${state.occupied}|${state.ready}|${state.proposalsPending}|${active}|${approved}`;
}

function emptyState(): QueueState {
  return { active: [], approved: [], occupied: 0, ready: 0, proposalsPending: 0, ok: false, budget: [], budgetCappedFailed: [] };
}

function empty(): AutopilotResult {
  return { tick: null, domainEvents: [], flipped: false, freedSlot: false, reviewerCompleted: false };
}

/** Classify a FAILED worker run: a budget CAP cut it off (runtime reported
 *  timedOut, or the run lived at/over the item's recorded timeoutMs — the
 *  deterministic backstop when the runtime does not say 'timed out'), versus
 *  an unsuccessful verdict/exit. Elapsed comes from the item's updatedAt (the
 *  flip-to-active stamp ≈ dispatch time); only items with a recorded budget
 *  are ever classified by elapsed. */
function workerFailCause(ev: CompletionEvent, timeoutMs: number | null | undefined, updatedAt: string, now: number): FailCause {
  if (ev.timedOut === true) return "budget-capped";
  if (timeoutMs && timeoutMs > 0) {
    const startedAt = Date.parse(updatedAt || "");
    if (Number.isFinite(startedAt) && now - startedAt >= timeoutMs) return "budget-capped";
  }
  // PROVIDER/INFRA (AUTO-RECOVER-FAILS): a run that ended unsuccessful with NO
  // deliverable text at all — the provider returned an empty api_error / the
  // session produced nothing. That is not a verdict on the work, so it gets the
  // bounded provider-retry recovery (2× then escalate). Detected only when the
  // event carries a results array whose entries have no output AND no summary;
  // an event with no results at all stays a verdict (legacy/unenriched runs).
  if (infraNoOutput(ev)) return "spawn";
  return "verdict";
}

/** true when the completion carries results but produced NO output text. */
function infraNoOutput(ev: CompletionEvent): boolean {
  if (typeof ev.summary === "string" && ev.summary.trim()) return false;
  if (!Array.isArray(ev.results) || ev.results.length === 0) return false;
  return ev.results.every((r) => {
    const out = (r as { output?: unknown })?.output;
    return !(typeof out === "string" && out.trim());
  });
}
