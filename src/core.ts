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
  approved: Array<{ key: string; title: string; ready: boolean; line: string; lineIndex: number }>;
  occupied: number;
  ready: number;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TickReason = "dispatch" | "intake" | "review";

export interface Tick {
  reason: TickReason;
  /** Human/LLM-readable tick message (the orchestrator consumes this). */
  message: string;
  /** Machine-readable facts the orchestrator can use without re-deriving. */
  facts: Record<string, unknown>;
}

export interface CompletionEvent {
  runId?: string;
  id?: string;
  agent?: string | null;
  success?: boolean;
  status?: string;          // "completed" | "failed" | "stopped" | "detached" | ...
  timedOut?: boolean;
  stopped?: boolean;
  summary?: string;
  sessionFile?: string;
  results?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface DomainEvent {
  name: string;
  data: Record<string, unknown>;
}

export interface AutopilotResult {
  tick: Tick | null;
  /** Structured domain events (orch:item-completed, orch:verdict, ...) — the
   *  only machine channel; the adapter publishes them on the platform bus. */
  domainEvents: DomainEvent[];
  /** true when the completion was attributed to a store item and flipped. */
  flipped: boolean;
  /** true when the completed run freed a worker slot (flipped or ledger-tracked). */
  freedSlot: boolean;
  /** true when the completed run was a REVIEWER (its verdict needs routing). */
  reviewerCompleted: boolean;
}

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
    const readyKeys = state.approved.filter((a) => a.ready).map((a) => a.key);
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
    .map((i) => ({ key: i.key, title: i.title, ready: i.ready, line: "", lineIndex: 0 }));
  const reviewingWithReviewer = items.filter((i) => i.status === "reviewing" && i.reviewerRunId);
  const occupied = active.length + reviewingWithReviewer.length;
  const ready = approved.filter((a) => a.ready).length;
  return { active, approved, occupied, ready, ok: true };
}

function stateHash(state: QueueState): string {
  const active = state.active
    .map((a) => `${a.key}:${a.runId ?? ""}:${a.status ?? ""}`)
    .sort()
    .join("|");
  const approved = state.approved
    .map((a) => `${a.key}:${a.ready}`)
    .sort()
    .join("|");
  return `${state.occupied}|${state.ready}|${active}|${approved}`;
}

function emptyState(): QueueState {
  return { active: [], approved: [], occupied: 0, ready: 0, ok: false };
}

function empty(): AutopilotResult {
  return { tick: null, domainEvents: [], flipped: false, freedSlot: false, reviewerCompleted: false };
}

// ---------------------------------------------------------------------------
// Verdict parsing (strict — the queue_review reviewer contract mandates a
// 'Verdict: PASS'/'Verdict: FAIL' FIRST line; anything else → manual path)
// ---------------------------------------------------------------------------

const VERDICT_RE = /^Verdict:\s*(PASS|FAIL)\b/;

/** First non-empty line of a text (the verdict contract anchors there). */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/**
 * Strict verdict parse: the queue_review reviewer contract mandates the FIRST
 * non-empty line is exactly `Verdict: PASS`/`Verdict: FAIL`. Anything else →
 * null → the manual path (no silent wrong flips).
 */
export function parseVerdict(ev: CompletionEvent, reviewerAgents: string[] = []): "PASS" | "FAIL" | null {
  const results = Array.isArray(ev.results) ? ev.results : [];
  const reviewerSet = new Set(reviewerAgents);
  const pick = (out: unknown): "PASS" | "FAIL" | null => {
    if (typeof out !== "string") return null;
    const m = firstLine(out).match(VERDICT_RE);
    return m ? (m[1] === "PASS" ? "PASS" : "FAIL") : null;
  };
  // reviewer children first — a fan-out may include non-reviewer results
  for (const r of results) {
    const agent = (r as { agent?: unknown }).agent;
    if (typeof agent === "string" && reviewerSet.has(agent)) {
      const v = pick((r as { output?: unknown }).output);
      if (v) return v;
    }
  }
  for (const r of results) {
    const v = pick((r as { output?: unknown }).output);
    if (v) return v;
  }
  if (typeof ev.summary === "string") {
    const m = firstLine(ev.summary).match(VERDICT_RE);
    if (m) return m[1] === "PASS" ? "PASS" : "FAIL";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run-id collection (async payload → candidate ids)
// ---------------------------------------------------------------------------

const SESSION_PATH_RUN_RE = /\/([0-9a-f]{6,})\/run-\d+\//i;

/**
 * Collect every run-id candidate from an async-complete payload: the top-level
 * workflow id, per-child run ids, and ids extracted from session paths.
 */
export function collectRunIds(ev: CompletionEvent): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  push(ev.runId);
  push(ev.id);
  push(ev.sessionFile);
  if (Array.isArray(ev.results)) {
    for (const r of ev.results) {
      push(r.runId);
      push(r.sessionPath);
      push(r.sessionFile);
    }
  }
  for (const p of [...out]) {
    if (p.includes("/")) {
      const m = p.match(SESSION_PATH_RUN_RE);
      if (m) out.push(m[1]);
    }
  }
  return [...new Set(out.filter((v) => v.length >= 6))];
}

// ---------------------------------------------------------------------------
// File/telemetry helpers
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
