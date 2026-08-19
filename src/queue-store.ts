// queue-store.ts — the programmatic orchestrator queue store. Extension-owned,
// machine-readable, with free-form text fields (notes/description carry the
// schema-free content). state.md becomes a RENDER of this store.
//
// Statuses: proposal → approved → active → reviewing → done
//                 ↘ rejected        ↘ failed   ↗ (re-dispatch)
//                     ↘ failed ←(recovery)→ active
//
// Ownership split: approval/dispatch/review verdicts are orchestrator
// judgment (via queue_* tools); active→reviewing/failed are extension events
// (async-complete). Only the two event transitions happen automatically.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type QueueStatus = "proposal" | "approved" | "blocked" | "active" | "reviewing" | "failed" | "done" | "rejected";
export type BlockerReason = "parked" | "serialized" | "merge" | "decision" | null;

const STATUSES: QueueStatus[] = ["proposal", "approved", "blocked", "active", "reviewing", "failed", "done", "rejected"];

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
  /** re-dispatch attempt counter (review-FAIL cap is 5) */
  attempts: number;
  /** free-form notes/description — no schema constraints on content */
  notes: string;
  createdAt: string;
  updatedAt: string;
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
  active: ["reviewing", "failed"],      // event-driven (extension)
  reviewing: ["done", "failed", "active"], // active = review-FAIL re-dispatch
  failed: ["active", "done"],             // recovery re-dispatch; done = verified-complete despite the failure record
  done: ["approved"],                     // human re-open: the user found issues in their review
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
      for (const it of Object.values(raw.items)) {
        if (it.reviewerRunId === undefined) it.reviewerRunId = null;
        if (it.attempts === undefined) it.attempts = 0;
        if (it.runId === undefined) it.runId = null;
        if (it.cwd === undefined) it.cwd = null;
        if (it.blocker === undefined) it.blocker = null;
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
  const out: QueueLengths = { proposal: 0, approved: 0, blocked: 0, active: 0, reviewing: 0, failed: 0, done: 0, rejected: 0 };
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
      updatedAt: i.updatedAt,
    };
    if (q.includeNotes) {
      return { ...base, scope: i.scope, evidence: i.evidence, value: i.value, urgency: i.urgency, risk: i.risk, notes: i.notes };
    }
    return base;
  });
}

export function itemByRunId(store: QueueStore, runId: string): QueueItem | null {
  for (const it of Object.values(store.items)) {
    if (it.runId && runIdMatches(runId, it.runId)) return it;
  }
  return null;
}

/** Find a `reviewing` item whose REVIEWER run matches (queue_review attribution). */
export function itemByReviewerRunId(store: QueueStore, runId: string): QueueItem | null {
  for (const it of Object.values(store.items)) {
    if (it.status === "reviewing" && it.reviewerRunId && runIdMatches(runId, it.reviewerRunId)) return it;
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
  attempts?: number;
  title?: string;
  scope?: string;
  evidence?: string;
  value?: string;
  urgency?: string;
  risk?: string;
  notes?: string;
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
  // blocked must say WHY (parked/serialized/merge/decision) — a blocker-less
  // block would be indistinguishable from a rejected proposal.
  if (to === "blocked" && !clean.blocker) {
    throw new Error(`queue: blocked requires a blocker reason (parked/serialized/merge/decision) for '${key}'`);
  }
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
    if (name.startsWith("Reviewing")) return "reviewing";
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
