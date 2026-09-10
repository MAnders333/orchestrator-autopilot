// queue-store.ts — the programmatic orchestrator queue store. Extension-owned,
// machine-readable, with free-form text fields (notes/description carry the
// schema-free content). state.md becomes a RENDER of this store.
//
// Statuses: proposal → approved → active → ai-review → human-review → done
//                 ↘ rejected        ↘ failed   ↗ (re-dispatch)
//                     ↘ failed ←(recovery)→ active
//
// Ownership split: approval/dispatch/review verdicts are orchestrator
// judgment (via queue_* tools); active→ai-review/failed are extension events
// (async-complete). Only the two event transitions happen automatically.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type QueueStatus = "proposal" | "approved" | "blocked" | "active" | "ai-review" | "human-review" | "failed" | "done" | "rejected";
export type BlockerReason = "parked" | "serialized" | "merge" | "decision" | null;
/** WHY an item reached `failed` — the failed=cap vs failed=verdict distinction
 *  (BUDGET-GOVERNANCE). `budget-capped`: the worker run was CUT OFF by the
 *  item's requested wall-clock budget (timeoutMs) mid-task — the failure says
 *  nothing about the work, and the re-dispatch must run with a BIGGER budget.
 *  `verdict`: the run ended with an unsuccessful verdict/exit (incl. a review
 *  FAIL reaching the attempts cap). `zombie`: the run's completion event was
 *  lost (fleet idle past grace). `spawn`: the provider/infra layer failed the
 *  run — rejected AT SPAWN (bare 400) or died mid-run producing NO deliverable
 *  (empty api_error) — so the failure says nothing about the work and the
 *  recovery is a bounded provider retry (2× then escalate, AUTO-RECOVER-FAILS).
 *  null = not failed, or a legacy/pre-governance failure with no recorded
 *  cause. */
export type FailCause = "budget-capped" | "verdict" | "zombie" | "spawn";

export function isFailCause(v: unknown): v is FailCause {
  return v === "budget-capped" || v === "verdict" || v === "zombie" || v === "spawn";
}

const STATUSES: QueueStatus[] = ["proposal", "approved", "blocked", "active", "ai-review", "human-review", "failed", "done", "rejected"];

export function isValidStatus(s: unknown): s is QueueStatus {
  return typeof s === "string" && (STATUSES as string[]).includes(s);
}

export interface QueueItem {
  key: string;
  status: QueueStatus;
  /** approved = dispatchable; blocked = approved-but-waiting (blocker says why). */
  blocker: BlockerReason;
  title: string;
  /** The worker-prompt scope (auto-dispatch builds the task from this). */
  scope: string;
  /** The repo the worker runs in (auto-dispatch requires it). */
  cwd: string | null;
  evidence: string;
  value: string;      // H/M/L — free-form
  urgency: string;    // H/M/L — free-form
  risk: string;       // low/med/high — free-form
  runId: string | null;
  /** reviewer run id when a queue_review was spawned for this item */
  reviewerRunId: string | null;
  /** Requested wall-clock budget (ms) recorded on the item — EVERY dispatch
   *  lane (manual dispatch/review + auto-dispatch/re-dispatch/auto-review)
   *  passes it to backend.spawn so the child inherits the requested budget
   *  instead of a runtime default. null = unset → runtime default applies. */
  timeoutMs: number | null;
  /** re-dispatch attempt counter (review-FAIL cap is 5) */
  attempts: number;
  /** SHIPPING MARKER (KEY: AUTO-SHIP-ON-DONE): the ISO timestamp when the
   *  merge-finisher shipped this item (merged into main / MRs created).
   *  absent/null = not shipped yet — a `done` item without this marker is
   *  still waiting for the shipping lane. The marker prevents re-merge:
   *  once set, the shipping lane skips the item. Cleared when the item
   *  leaves `done` (a human re-open starts a fresh approval + ship cycle). */
  shippedAt?: string | null;
  /** Why this item reached `failed` (see FailCause). null when not failed or
   *  a legacy failure with no recorded cause. Set by the event-driven flips
   *  (worker completion, review-cap, zombie reconciliation) and cleared on any
   *  transition OUT of failed — a stale cause must never ride into a fresh
   *  run. The capped-failure path ALSO writes a human note, so both the
   *  machine flag and the operator-visible text say 'budget-capped'. */
  failCause?: FailCause | null;
  /** AUTO-RECOVER-FAILS bookkeeping: how many automatic recovery attempts
   *  this item has consumed (spawn calls made by the recovery engine). Bounded
   *  by the recovery policy per cause + the global cap (default 2) — an item
   *  that exhausts them stays `failed` with a one-time escalation tick. Counts
   *  FAILED attempts too (a spawn the provider rejected consumed an attempt). */
  recoveries?: number;
  /** Epoch ms before which the next automatic recovery attempt must NOT run
   *  (the short backoff after a failure). null = eligible on the next pass. */
  recoveryNotBefore?: number | null;
  /** true once the recovery budget is spent and the escalation tick fired —
   *  the item stays failed for the orchestrator/human to act on. Prevents a
   *  re-escalation tick on every sweep. */
  recoveryEscalated?: boolean;
  /** free-form notes/description — no schema constraints on content */
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** true when the key was allocated PROVISIONALLY (proposal with no cwd yet →
   *  default Q series); a later approved transition with cwd RENAMES the key
   *  into the repo's real series. Never set for explicit keys or deliberate
   *  series choices. */
  provisionalKey?: boolean;
}

export interface QueueStore {
  version: 1;
  items: Record<string, QueueItem>;
}

export type QueueLengths = Record<QueueStatus, number>;

// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------

const ALLOWED: Record<QueueStatus, QueueStatus[]> = {
  // A proposal may be BLOCKED directly (deferred: parked/serialized/decision)
  // without an approval — blocking resolves it from the pending-proposal set
  // (intake re-arms) without a false approval record.
  proposal: ["approved", "rejected", "blocked"],
  approved: ["blocked", "active", "rejected"],
  blocked: ["approved", "rejected"],   // unblock (approved) or drop (rejected)
  active: ["ai-review", "failed"],          // event-driven (extension): worker done → AI review
  "ai-review": ["human-review", "failed", "active"], // PASS→human-review; FAIL→active re-dispatch; cap→failed
  "human-review": ["done", "active", "rejected"],   // you approve→done; find issues→active re-dispatch; drop→rejected
  failed: ["active", "done"],               // recovery re-dispatch; done = verified-complete despite the failure record
  done: ["approved"],                       // human re-open: the user found issues after approval
  rejected: [],
};

export function validTransition(from: QueueStatus, to: QueueStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Store IO
// ---------------------------------------------------------------------------

export function storePath(stateDir: string): string {
  return join(stateDir, "queue.json");
}

export function loadStore(stateDir: string): QueueStore | null {
  try {
    const p = storePath(stateDir);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as QueueStore;
    if (raw && typeof raw === "object" && raw.items && typeof raw.items === "object") {
      // Backfill schema drift: older stores lack reviewerRunId/attempts (and
      // the legacy runId may be a bare short token). Normalize on read so
      // downstream code can rely on the fields existing.
      // MIGRATION: the pre-two-stage-review store used status "reviewing" for
      // the AI-review stage (renamed to "ai-review"; "human-review" is new).
      // Rewrite in memory so reads treat them as the current stage; persisted
      // on the next save.
      for (const it of Object.values(raw.items)) {
        if (it.status === "reviewing") it.status = "ai-review";
      }
      for (const it of Object.values(raw.items)) {
        if (it.reviewerRunId === undefined) it.reviewerRunId = null;
        if (it.timeoutMs === undefined) it.timeoutMs = null;
        if (it.attempts === undefined) it.attempts = 0;
        if (it.failCause === undefined) it.failCause = null;
        if (it.recoveries === undefined) it.recoveries = 0;
        if (it.recoveryNotBefore === undefined) it.recoveryNotBefore = null;
        if (it.recoveryEscalated === undefined) it.recoveryEscalated = false;
        if (it.runId === undefined) it.runId = null;
        if (it.cwd === undefined) it.cwd = null;
        if (it.blocker === undefined) it.blocker = null;
        if (it.shippedAt === undefined) it.shippedAt = null;
        // The ready boolean was folded into the status: approved = dispatchable,
        // approved+!ready → blocked. Normalize old stores on read.
        if (it.status === "approved" && (it as { ready?: boolean }).ready === false) it.status = "blocked";
        delete (it as { ready?: boolean }).ready;
      }
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveStore(stateDir: string, store: QueueStore): void {
  const p = storePath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

export function newStore(): QueueStore {
  return { version: 1, items: {} };
}

/** The store-ownership helper both hosts used to inline (loadStore ?? newStore).
 *  One place, in the store layer. */
export function loadStoreOrNew(stateDir: string): QueueStore {
  return loadStore(stateDir) ?? newStore();
}

/** One-time migration: import a legacy state.md into the programmatic store.
 *  Host-agnostic — this is STORE logic (pi used to inline it; opencode never
 *  got it). Best-effort: a broken migration must not break activation, and an
 *  absent store is a no-op. */
export function ensureMigrated(stateDir: string): void {
  try {
    if (loadStore(stateDir)) return;
    const mdPath = join(stateDir, "state.md");
    if (!existsSync(mdPath)) return;
    const store = migrateFromMd(readFileSync(mdPath, "utf8"));
    saveStore(stateDir, store);
    const archived = `${mdPath}.migrated-${Date.now()}`;
    try {
      renameSync(mdPath, archived);
    } catch {
      // keep the original if rename fails — the store is authoritative now
    }
  } catch {
    // migration is best-effort; autopilot still works on an empty store
  }
}

export function queueLengths(store: QueueStore): QueueLengths {
  const out: QueueLengths = { proposal: 0, approved: 0, blocked: 0, active: 0, "ai-review": 0, "human-review": 0, failed: 0, done: 0, rejected: 0 };
  for (const it of Object.values(store.items)) {
    if (isValidStatus(it.status)) out[it.status]++;
    // corrupt statuses (missing/invalid) are not counted here — they surface
    // in queryItems (list all) so they can be repaired
  }
  return out;
}

export interface QueueQuery {
  /** filter by one or more statuses (omitted = all) */
  status?: QueueStatus | QueueStatus[];
  /** ISO timestamp — only items with updatedAt >= since (last change filter) */
  since?: string;
  sort?: "updatedAt" | "createdAt" | "key"; // default updatedAt desc
  limit?: number; // default 50
  /** include the heavy free-form fields (scope/evidence/value/urgency/risk/notes) */
  includeNotes?: boolean;
}

/**
 * Query the store: filter by status / last-change, sort, cap, and project a
 * compact view (heavy free-form fields only on request — keeps the LLM's
 * context small). Deterministic — no parsing anywhere.
 */
export function queryItems(store: QueueStore, q: QueueQuery = {}): Array<Partial<QueueItem> & { key: string }> {
  let items = Object.values(store.items);
  const statuses = q.status === undefined ? null : Array.isArray(q.status) ? q.status : [q.status];
  if (statuses) items = items.filter((i) => statuses!.includes(i.status));
  if (q.since) items = items.filter((i) => i.updatedAt >= q.since!);
  items = [...items];
  switch (q.sort ?? "updatedAt") {
    case "key":
      items.sort((a, b) => a.key.localeCompare(b.key));
      break;
    case "createdAt":
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      break;
    default:
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  items = items.slice(0, q.limit ?? 50);
  return items.map((i) => {
    const base = {
      key: i.key,
      status: i.status,
      blocker: i.blocker,
      title: i.title,
      runId: i.runId,
      reviewerRunId: i.reviewerRunId, // the reviewer-in-flight fact — an ai-review item with a reviewerRunId is ALREADY dispatched (do NOT queue_review it)
      // Budget-governance read facts: the cap the item runs under, and WHY it
      // failed (budget-capped vs verdict) — the operator-facing 'panel' read
      // must distinguish a run that died at its budget from one that failed on
      // a verdict without loading notes.
      timeoutMs: i.timeoutMs,
      failCause: i.failCause ?? null,
      shippedAt: i.shippedAt ?? null,
      updatedAt: i.updatedAt,
    };
    if (q.includeNotes) {
      return { ...base, scope: i.scope, evidence: i.evidence, value: i.value, urgency: i.urgency, risk: i.risk, notes: i.notes };
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// Series registry — cwd → id series, AUTO-MAINTAINED by the framework
// ---------------------------------------------------------------------------

/** The prefix is a PROPERTY OF THE WORKSTREAM, discovered from history and
 *  remembered by the framework — the agent's only job is to not fight it.
 *  Resolution order (resolveSeries): registry → history (dominant series among
 *  items with the same cwd) → repo-name slug → default "Q". Every add with a
 *  cwd RECORDS the used series, so judgment is needed exactly once per
 *  workstream — the first item — and never again. */

export interface SeriesRegistryEntry {
  series: string;
  updatedAt: string;
}

function seriesRegistryPath(stateDir: string): string {
  return join(stateDir, "series-registry.json");
}

export function readSeriesRegistry(stateDir: string): Record<string, SeriesRegistryEntry> {
  try {
    const p = seriesRegistryPath(stateDir);
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, SeriesRegistryEntry>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Record cwd → series (best-effort, never throws — a registry problem must
 *  not fail an add; the next add simply re-derives). */
export function recordSeries(stateDir: string, cwd: string, series: string): void {
  try {
    const reg = readSeriesRegistry(stateDir);
    reg[cwd] = { series, updatedAt: new Date().toISOString() };
    const p = seriesRegistryPath(stateDir);
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch {
    // best-effort
  }
}

/** The slug fallback: repo basename, uppercased + sanitized. */
export function seriesSlugFor(cwd: string): string {
  const base = (cwd.split("/").filter(Boolean).pop() ?? "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return base || "Q";
}

/** Dominant series among existing items with the same cwd (history beats the
 *  slug — it survives repo renames and preserves sub-series). Same counting
 *  rule as nextKeyFor: the series is the text BEFORE the first digit
 *  (`B48-EARLIER` → B, `EVAL-EXPT-M9` → EVAL-EXPT-M). Most frequent wins;
 *  ties broken by most recently updated. `excludeKey` skips one item (the
 *  caller's own key) so a freshly-specified provisional Q handle cannot vote
 *  for its own provisional series. */
function historicalSeries(store: QueueStore, cwd: string, excludeKey?: string): string | null {
  const counts = new Map<string, { n: number; latest: number }>();
  for (const it of Object.values(store.items)) {
    if (it.cwd !== cwd) continue;
    if (excludeKey && it.key === excludeKey) continue;
    const m = /^([A-Za-z0-9_-]*?)(?:\d|$)/.exec(it.key);
    let series = m?.[1].replace(/[-_]+$/, "");
    if (!series) continue;
    // A DIGIT-LESS key votes only its FIRST segment as the series. The old
    // rule let the whole key-without-digits become its own series, so one
    // legacy key (e.g. "MBR-HANDOVER-SAEID", "AUTOPILOT-SCHEDULED-OFF")
    // latched as the workstream identity and every new item inherited the
    // weird prefix (observed twice: MBR-HANDOVER-SAEID-1, AUTOPILOT-
    // WORKTREE-PRESERVATION-1).
    if (!/\d/.test(it.key)) {
      series = (series.split(/[-_]/)[0] || series).trim();
      if (!series) continue;
    }
    const cur = counts.get(series) ?? { n: 0, latest: 0 };
    counts.set(series, { n: cur.n + 1, latest: Math.max(cur.latest, Date.parse(it.updatedAt) || 0) });
  }
  let best: string | null = null;
  for (const [series, v] of counts) {
    if (best === null) {
      best = series;
      continue;
    }
    const bv = counts.get(best)!;
    if (v.n > bv.n || (v.n === bv.n && v.latest > bv.latest)) best = series;
  }
  return best;
}

/** Resolve the series for a cwd: registry → history → slug. Records nothing —
 *  the caller records the series it actually used. `excludeKey` excludes one
 *  item from the history vote (the item being renamed must not vote for its
 *  own provisional series — it would win updatedAt ties). */
export function resolveSeries(stateDir: string, cwd: string, opts?: { excludeKey?: string }): string {
  if (!cwd) return "Q";
  const hit = readSeriesRegistry(stateDir)[cwd];
  if (hit?.series) return hit.series;
  const store = loadStore(stateDir);
  if (store) {
    const hist = historicalSeries(store, cwd, opts?.excludeKey);
    if (hist) return hist;
  }
  return seriesSlugFor(cwd);
}

export function itemByRunId(store: QueueStore, runId: string): QueueItem | null {
  for (const it of Object.values(store.items)) {
    if (it.runId && runIdMatches(runId, it.runId)) return it;
  }
  return null;
}

/** Find an `ai-review` item whose REVIEWER run matches (queue_review attribution). */
export function itemByReviewerRunId(store: QueueStore, runId: string): QueueItem | null {
  for (const it of Object.values(store.items)) {
    if (it.status === "ai-review" && it.reviewerRunId && runIdMatches(runId, it.reviewerRunId)) return it;
  }
  return null;
}

export function runIdMatches(fullRunId: string, token: string): boolean {
  const a = fullRunId.toLowerCase();
  const b = token.toLowerCase();
  const n = Math.min(a.length, b.length, 8);
  if (n < 6) return false;
  return a.slice(0, n) === b.slice(0, n);
}

// ---------------------------------------------------------------------------
// Mutations (validated)
// ---------------------------------------------------------------------------

export interface UpdatePatch {
  status?: QueueStatus;
  blocker?: BlockerReason;
  runId?: string | null;
  reviewerRunId?: string | null;
  timeoutMs?: number | null;
  attempts?: number;
  failCause?: FailCause | null;
  recoveries?: number;
  recoveryNotBefore?: number | null;
  recoveryEscalated?: boolean;
  title?: string;
  scope?: string;
  cwd?: string | null;
  evidence?: string;
  value?: string;
  urgency?: string;
  risk?: string;
  notes?: string;
  /** SHIPPING MARKER (KEY: AUTO-SHIP-ON-DONE) — set by the merge-finisher
   *  when it ships; cleared when the item leaves `done` (re-open). */
  shippedAt?: string | null;
}

/** Apply a validated update. Throws on an illegal transition. Returns the item. */
export function updateItem(store: QueueStore, key: string, patch: UpdatePatch, now = new Date().toISOString()): QueueItem {
  const item = store.items[key];
  if (!item) throw new Error(`queue: no item '${key}'`);
  // Strip undefined fields BEFORE spreading — otherwise `{...patch}` would
  // clobber existing values (e.g. status) with undefined when the caller
  // omits a field.
  const clean: UpdatePatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
  }
  const from = item.status;
  const to = clean.status;
  // Leaving `failed` (re-dispatch to active, verified-complete to done, human
  // re-open to approved, drop to rejected) clears the failure cause — a stale
  // 'budget-capped' flag must not describe the NEXT run of the same item.
  // (A metadata-only patch with status undefined leaves the cause alone, as
  // does a re-statement of status failed while the item stays failed.)
  if (to !== undefined && to !== "failed") clean.failCause = null;
  // Leaving `failed` also drops the recovery SCHEDULING gate (the backoff is
  // per-failure-episode) — a manual re-dispatch or a recovery must never
  // inherit a stale "not before" instant. The attempt COUNTER + the escalation
  // flag deliberately persist (the recovery bound spans the item's history).
  if (to !== undefined && to !== "failed" && clean.recoveryNotBefore === undefined) clean.recoveryNotBefore = null;
  // done/human-review/failed are terminal-ish for their runs: the AI review
  // is over at human-review, so clear stale run refs (a done item must not
  // keep pointing at a dead worker; the FAIL flip already nulls them; this
  // covers the manual/orchestrator paths).
  if (to === "done" || to === "human-review" || to === "failed") {
    clean.runId = null;
    clean.reviewerRunId = null;
  }
  // blocked must say WHY (parked/serialized/merge/decision) — a blocker-less
  // block would be indistinguishable from a rejected proposal.
  if (to === "blocked" && !clean.blocker) {
    throw new Error(`queue: blocked requires a blocker reason (parked/serialized/merge/decision) for '${key}'`);
  }
  // SHIPPING MARKER lifecycle: the marker is only meaningful while the item is
  // `done`. ANY transition OUT of done (re-open to approved, re-dispatch to
  // active, drop to rejected) clears it — a re-approved item starts a fresh
  // approval → shipping cycle and must ship again. Re-stating done (or a
  // metadata-only patch) leaves it alone.
  if (to !== undefined && to !== "done") clean.shippedAt = null;
  if (to !== undefined && to !== from && !validTransition(from, to)) {
    // allow REPAIR of a corrupt item (status missing/invalid) to any valid status
    if (!isValidStatus(from) && isValidStatus(to)) {
      // repair path — fall through
    } else {
      throw new Error(`queue: illegal transition ${from} → ${to} for '${key}'`);
    }
  }
  const next: QueueItem = { ...item, ...clean, updatedAt: now };
  // A human re-open (done → approved) starts a FRESH agent review loop — the
  // attempts counter was the agent-review FAIL cap, not the human's judgment.
  if (from === "done" && to === "approved") next.attempts = 0;
  store.items[key] = next;
  return next;
}

export function addItem(
  store: QueueStore,
  item: Omit<QueueItem, "createdAt" | "updatedAt">,
  now = new Date().toISOString(),
): QueueItem {
  const full: QueueItem = { ...item, createdAt: now, updatedAt: now };
  store.items[item.key] = full;
  return full;
}

// ---------------------------------------------------------------------------
// Migration (one-time: import an existing state.md into the store)
// ---------------------------------------------------------------------------

export function migrateFromMd(md: string): QueueStore {
  const store = newStore();
  // Tolerant: reuses the section+grouping logic from queue.ts via a lightweight
  // local scan — a key line starts an entry; continuation lines append.
  const lines = md.split("\n");
  const sections = splitSections(lines);
  const statusFor = (name: string): QueueStatus | null => {
    if (name.startsWith("Active")) return "active";
    if (name.startsWith("Approved")) return "approved";
    if (name.startsWith("Backlog")) return "proposal";
    if (name.startsWith("Reviewing")) return "ai-review";
    if (name.startsWith("Completed")) return "done";
    if (name.startsWith("Failed")) return "failed";
    return null;
  };
  for (const sec of sections) {
    const status = statusFor(sec.name);
    if (!status) continue;
    for (const { key, text } of groupEntries(lines, sec.start + 1, sec.end)) {
      const joined = text.join(" ");
      const runM = joined.match(/(?:worker|Worker)\s+(?:run\s+)?([0-9a-f]{6,})/);
      const statusM = joined.match(/status:\s*([A-Za-z]+)/);
      const title = text[0].slice(text[0].indexOf(":") + 1).trim();
      const nonReady = /\b(BLOCKED|DISPATCHED|REMOVED|PARKED|SERIALIZED|HOLD|DEFERRED)\b/i.test(joined);
      const blocker = /\bPARKED\b/i.test(joined) ? "parked" : /\bSERIALIZED\b/i.test(joined) ? "serialized" : /\bBLOCKED\b/i.test(joined) ? "merge" : null;
      // The fold: approved + a non-ready marker in the text → blocked.
      const foldedStatus: QueueStatus = status === "approved" && nonReady ? "blocked" : status;
      addItem(store, {
        key,
        status: foldedStatus,
        blocker,
        title,
        // preserve the FULL original entry text (free-form) — nothing lost in the render
        scope: joined,
        evidence: "",
        value: "",
        urgency: "",
        risk: "",
        runId: runM ? runM[1] : null,
        reviewerRunId: null,
        timeoutMs: null,
        attempts: 0,
        notes: joined,
      });
    }
  }
  return store;
}

// ---------------------------------------------------------------------------
// Internal helpers (kept local; queue.ts exports its own equivalents)
// ---------------------------------------------------------------------------

function splitSections(lines: string[]): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  let cur: { name: string; start: number; end: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+([A-Za-z ]+)/);
    if (m) {
      if (cur) cur.end = i;
      cur = { name: m[1].trim(), start: i, end: lines.length };
      out.push(cur);
    }
  }
  return out;
}

function groupEntries(lines: string[], start: number, end: number): Array<{ key: string; text: string[] }> {
  const entries: Array<{ key: string; text: string[] }> = [];
  let cur: { key: string; text: string[] } | null = null;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || /^#{1,3}\s+/.test(line)) {
      cur = null;
      continue;
    }
    const key = entryKey(line);
    if (key) {
      cur = { key, text: [line] };
      entries.push(cur);
    } else if (cur) {
      cur.text.push(line);
    }
  }
  return entries;
}

function entryKey(line: string): string | null {
  const m = line.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)(?:\s*\[[^\]]*\])?:\s/);
  return m ? m[1] : null;
}
