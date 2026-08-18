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
// Fail-safe to action: when neither store nor md is available, we tick anyway
// rather than risk a missed refill — a spurious tick costs one LLM turn, a
// missed one costs an idle slot.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadStore,
  saveStore,
  itemByRunId,
  itemByReviewerRunId,
  updateItem,
  type QueueStore,
} from "./queue-store.ts";
import type { Tick, TickReason, CompletionEvent, DomainEvent, AutopilotResult } from "./types.ts";
import type { AutopilotConfig } from "./config.ts";
import { parseVerdict } from "./verdict.ts";
import { collectRunIds } from "./run-ids.ts";

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
  /** Items awaiting the user's approval decision (status: proposal). */
  proposalsPending: number;
  ok: boolean;
}


interface LedgerEntry {
  agent?: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

export class Autopilot {
  private cfg: Required<Pick<AutopilotConfig, "maxSlots" | "queueLowThreshold" | "workerAgents" | "quietPeriodMs">> & AutopilotConfig;
  private ledger = new Map<string, LedgerEntry>();
  private lastTickAt = 0;
  private lastTickHash = "";
  private lastSettledHash = "";
  private lastReviewTickAt = 0;

  constructor(config: AutopilotConfig) {
    this.cfg = {
      maxSlots: 3,
      queueLowThreshold: 2,
      workerAgents: ["worker"],
      reviewerAgents: ["orchestrator-reviewer"],
      reviewCap: 5,
      quietPeriodMs: 60_000,
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
   * active→reviewing/failed. Does NOT tick — the adapter fetches the
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
    const outcome: "failed" | "reviewing" = ev.success === false || ev.timedOut ? "failed" : "reviewing";

    let flipped = false;
    let flippedKey = "";
    const store = loadStore(this.cfg.stateDir);
    if (store) {
      for (const cand of candidates) {
        const it = itemByRunId(store, cand);
        if (it && it.status === "active") {
          updateItem(store, it.key, { status: outcome });
          flipped = true;
          flippedKey = it.key; // capture inside the loop — the FIRST matching item, not any same-status item
          this.logEvent("flip", { key: it.key, runId: cand, outcome });
          break;
        }
      }
      if (flipped) saveStore(this.cfg.stateDir, store);
    }

    // A flipped item (or a ledger-tracked run) freed a worker slot.
    const freedSlot = flipped || entry !== undefined;
    const isReviewerRun = [ev.agent, ...(Array.isArray(ev.results) ? ev.results.map((r) => (r as { agent?: string })?.agent) : [])]
      .filter((a): a is string => typeof a === "string" && !!a)
      .some((a) => this.cfg.reviewerAgents.includes(a));

    const domainEvents: DomainEvent[] = [];
    if (flipped) {
      domainEvents.push({ name: "orch:item-completed", data: { key: flippedKey, runId: topRunId, outcome } });
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
          updateItem(store, matched.key, { status: "done" });
          saveStore(this.cfg.stateDir, store);
          domainEvents.push({ name: "orch:verdict", data: { key: matched.key, verdict: "PASS", attempts: matched.attempts ?? 0 } });
          this.logEvent("flip", { key: matched.key, outcome: "done", source: "verdict-pass" });
          if (!withinQuiet) this.lastReviewTickAt = now;
          return {
            tick: withinQuiet ? null : {
              reason: "review",
              message: `[orch-tick: review] ${matched.key} PASSED review — flag_for_review + surface the completion card (orchestrator-review skill). Not a user request; respond ≤2 lines.`,
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
            updateItem(store, matched.key, { status: "failed", attempts });
            saveStore(this.cfg.stateDir, store);
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
          updateItem(store, matched.key, { status: "active", attempts, runId: null, reviewerRunId: null });
          saveStore(this.cfg.stateDir, store);
          domainEvents.push({ name: "orch:verdict", data: { key: matched.key, verdict: "FAIL", attempts } });
          this.logEvent("flip", { key: matched.key, outcome: "active", source: "verdict-fail", attempts });
          if (!withinQuiet) this.lastReviewTickAt = now;
          return {
            tick: withinQuiet ? null : {
              reason: "review",
              message: `[orch-tick: review] ${matched.key} FAILED review (attempt ${attempts}) — re-dispatch via queue_dispatch with the accumulated findings (orchestrator-review skill). Not a user request; respond ≤2 lines.`,
              facts: { key: matched.key, verdict: "FAIL", attempts },
            },
                        domainEvents,
            flipped: true,
            freedSlot: true, // reviewer slot freed — dispatch sweep runs too
            reviewerCompleted: true,
          };
        }
        // no parseable verdict → manual path
        const reviewing = Object.values(store.items).filter((i) => i.status === "reviewing").map((i) => i.key);
        return {
          tick: {
            reason: "review",
            message: `[orch-tick: review] Reviewer for ${matched.key} completed but the verdict line was not parseable — read its output and move the item to done / re-dispatch / failed yourself. In reviewing: ${reviewing.join(", ") || "none"}. Not a user request; respond ≤2 lines.`,
            facts: { key: matched.key, reviewing },
          },
                    domainEvents,
          flipped: false,
          freedSlot: true, // reviewer slot freed — dispatch sweep runs too
          reviewerCompleted: true,
        };
      }
      // reviewer completed but no item attributed (plain subagent review) → generic review tick
      const reviewing = Object.values(store.items).filter((i) => i.status === "reviewing").map((i) => i.key);
      const generic = this.reviewTick(now);
      return {
        tick: generic,
                domainEvents,
        flipped: false,
        freedSlot: true, // reviewer slot freed — dispatch sweep runs too
        reviewerCompleted: true,
      };
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
    const snapshot = this.readQueueSnapshot();
    // Occupied = ALL subagents dispatched from the orchestrator session —
    // workers, reviewers, scouts, plain subagent calls (the general case).
    //   - fleet.totalActive (pi-subagents status) is the AUTHORITATIVE count:
    //     it sees every run the session spawned, whatever its role.
    //   - fallback: max(event-ledger, store-derived) — the conservative union,
    //     so a store undercount or a ledger miss can never report false free
    //     slots. Store-derived includes active workers AND reviewing items with
    //     a reviewer in flight.
    const occupied = fleet?.totalActive ?? Math.max(this.ledger.size, snapshot.occupied);
    const eff = { ...snapshot, occupied };
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
    if (!tick) return empty();
    this.logEvent("tick", { reason: tick.reason, source });
    return { tick, domainEvents: [], flipped: false, freedSlot: false, reviewerCompleted: false };
  }

  /**
   * Review tick — the deterministic trigger for the orchestrator's judgment
   * step: when items are stuck in `reviewing`, the orchestrator has no other
   * way to know a reviewer finished. Fired on reviewer completion and by the
   * periodic timer. The verdict (PASS/FAIL) is the orchestrator's call — the
   * tick only says "route it".
   */
  reviewTick(now = this.now()): Tick | null {
    const store = loadStore(this.cfg.stateDir);
    if (!store) return null;
    const reviewing = Object.values(store.items).filter((i) => i.status === "reviewing");
    if (!reviewing.length) return null;
    if (now - this.lastReviewTickAt < this.cfg.quietPeriodMs) return null;
    this.lastReviewTickAt = now;
    const keys = reviewing.map((i) => i.key);
    return {
      reason: "review",
      message:
        `[orch-tick: review] Items in reviewing: ${keys.join(", ") || "none"}. A reviewer completed — read its verdict and move each to done ` +
        `(queue_update status: done) or re-dispatch (queue_dispatch) / mark failed. Not a user request; respond ≤2 lines.`,
      facts: { reviewing: keys, count: keys.length },
    };
  }

  /**
   * Public status snapshot for `/autopilot status`.
   */
  status(): { running: number; lastTickAt: number; lastTickHash: string } {
    return { running: this.ledger.size, lastTickAt: this.lastTickAt, lastTickHash: this.lastTickHash };
  }

  // -- internals ------------------------------------------------------------

  private readQueueSnapshot(): QueueState {
    const store = loadStore(this.cfg.stateDir);
    // No md fallback: state.md is retired (migration ran once at activation).
    // Missing store → empty snapshot → fail-safe to action (spurious tick costs
    // one turn; a missed one costs an idle slot).
    return store ? storeToSnapshot(store) : emptyState();
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

    const slotsFree = Math.max(0, this.cfg.maxSlots - state.occupied);
    const ready = state.ready;
    const readyKeys = state.approved.map((a) => a.key); // approved = dispatchable (the fold)
    // Cross-check: the fleet counts ALL session subagents; when it sees runs
    // the ledger/store haven't attributed (plain subagent calls, scouts), flag
    // it so the orchestrator can run `subagent status`. Occupied itself is the
    // fleet number (or the fallback) — never worker-only.
    const reconcile =
      typeof fleetTotalActive === "number" && fleetTotalActive > state.occupied
        ? ` (fleet status shows ${fleetTotalActive} active — ${fleetTotalActive - state.occupied} not tracked by the queue)`
        : "";

    // Capacity gap → dispatch tick (the core fix: refill on slot-free).
    // FLEET counts ALL session subagents (workers + reviewers + scouts — any
    // dispatched run occupies a slot); QUEUE comes from the store.
    if (slotFreed && slotsFree > 0 && ready >= 1) {
      this.rememberTick(state, now);
      return {
        reason: "dispatch",
        message:
          `[orch-tick: dispatch] FLEET: ${state.occupied}/${this.cfg.maxSlots} subagent runs active (workers + reviewers + scouts), ${slotsFree} free. ` +
          `QUEUE: ${ready} ready (${readyKeys.join(", ") || "none"}).` +
          reconcile +
          ` Rule: a slot is free + queue has ready work → dispatch it. System ping: run your loop. Respond ≤2 lines. Not a user request.`,
        facts: { slotsFree, occupied: state.occupied, ready, readyKeys, source, runId, fleetTotalActive },
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
      if (state.proposalsPending > 0) return null;
      this.rememberTick(state, now);
      return {
        reason: "intake",
        message:
          `[orch-tick: intake] QUEUE: approved buffer low (${ready} ready < ${this.cfg.queueLowThreshold}; ready: ${readyKeys.join(", ") || "none"}). ` +
          `FLEET: not involved — this is about refilling the approved queue, not dispatch. ` +
          `Run a FULL intake scan NOW: scan ALL sources in order, diff against the queue, AND run the beyond-source pass (cross-source gaps, industry standards, project understanding). ` +
          `Propose the next batch for approval per the approval gate (evidence + scope + value/urgency + risk). ` +
          `This is a real scan, not a quick check — present candidates. Not a user request; the ≤2-line rule does NOT apply to intake ticks.`,
        facts: { ready, readyKeys, threshold: this.cfg.queueLowThreshold, source, runId },
      };
    }

    return null;
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
 * and covers runs the queue doesn't track (scouts, plain subagent calls). */
export function storeToSnapshot(store: QueueStore): QueueState {
  const items = Object.values(store.items);
  const active = items
    .filter((i) => i.status === "active")
    .map((i) => ({ key: i.key, runId: i.runId ?? undefined, status: "working" as const, title: i.title, line: "", lineIndex: 0, section: "active" as const }));
  const approved = items
    .filter((i) => i.status === "approved")
    .map((i) => ({ key: i.key, title: i.title, line: "", lineIndex: 0 }));
  const reviewingWithReviewer = items.filter((i) => i.status === "reviewing" && i.reviewerRunId);
  const occupied = active.length + reviewingWithReviewer.length;
  const ready = approved.length; // approved = dispatchable (the fold)
  const proposalsPending = items.filter((i) => i.status === "proposal").length;
  return { active, approved, occupied, ready, proposalsPending, ok: true };
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
  return { active: [], approved: [], occupied: 0, ready: 0, proposalsPending: 0, ok: false };
}

function empty(): AutopilotResult {
  return { tick: null, domainEvents: [], flipped: false, freedSlot: false, reviewerCompleted: false };
}
