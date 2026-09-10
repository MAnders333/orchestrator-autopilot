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

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, linkSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

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

/** WHERE a dispatched run writes (FINISHER-EVIDENCE). `worker` (default): the
 *  run writes ONLY inside its isolated worktree, so worktree edits are the
 *  evidence of work. `finisher`: the run writes OUTSIDE its worktree — into
 *  the DECLARED cwd's checkout (a merge finisher cherry-picks/merges an
 *  approved branch into the target repo's main checkout) — so its worktree is
 *  untouched BY DESIGN and a runtime 'no edits' heuristic misreads it as
 *  "returned planning output". For that class the queue's own record is
 *  authoritative: the evidence is the DECLARED SOURCE entering the declared
 *  cwd's history during the run (`landedEvidence`), not worktree file edits
 *  — and not a bare HEAD move, which other lanes and humans also produce. */
export type DispatchClass = "worker" | "finisher";

export function isDispatchClass(v: unknown): v is DispatchClass {
  return v === "worker" || v === "finisher";
}

/** The declared-cwd HEAD as it stood WHEN a finisher-class run was dispatched,
 *  plus the SOURCE that run was sent to land — together, the baseline the
 *  landed check compares against. Written by EVERY lane that spawns a
 *  finisher-class run, and cleared when the item (re-)enters `active`, so a
 *  baseline always describes the item's most recent dispatch. */
export interface FinisherBaseline {
  /** The checkout the finisher writes to (the item's declared cwd). */
  repo: string;
  /** The checked-out ref at dispatch (e.g. `main`), or null when detached. */
  ref: string | null;
  /** HEAD sha at dispatch; null when the repo could not be read. */
  sha: string | null;
  /** WHAT this dispatch was sent to land (branch/tag/sha), or null when the
   *  dispatch declared none — with no source there is NO landed evidence. */
  source: string | null;
  /** `source` resolved to a commit AT DISPATCH, so a branch deleted by the
   *  merge can still answer "is it in the target's history now?". */
  sourceSha: string | null;
  /** The run this baseline belongs to. */
  runId: string | null;
  at: string;
}

/** PROOF that a finisher-class dispatch's work LANDED: the source it was sent
 *  to land entered the declared cwd's history during the run. This is the
 *  success evidence for work that never touches its own worktree. */
/** How a declared source is present in a history: `ancestor` = the very
 *  commits it names (merge/fast-forward); `patch-equivalent` = copies carrying
 *  the same patch (cherry-pick/rebase/squash of a single-commit source). */
export type LandingShape = "ancestor" | "patch-equivalent";

export interface LandedEvidence {
  repo: string;
  ref: string | null;
  /** HEAD at dispatch (the baseline) — null when it could not be read. */
  fromSha: string | null;
  /** HEAD after the run — the landed commit. */
  sha: string;
  /** HOW the source is present. Absent on records written before the shape
   *  was tracked. */
  landing?: LandingShape;
  /** The source that landed, as declared at dispatch, and its commit. */
  source: string | null;
  sourceSha: string;
  /** The run whose work this is. */
  runId: string | null;
  at: string;
}

/** A RECORDED override of a run-level failure verdict — the thing that used to
 *  be hand-written prose in `notes`. Machine-readable so a PATTERN of
 *  overrides is visible (many overrides = the runtime verdict is systematically
 *  wrong, or the operator is waving failures through). */
export interface FailureOverride {
  at: string;
  /** `framework` = the harness overrode a runtime verdict against recorded
   *  evidence; `orchestrator` = a human/agent judgment call. */
  by: "framework" | "orchestrator";
  /** The run whose failure verdict was overridden. */
  runId: string | null;
  /** WHY the failure was not believed. */
  reason: string;
  /** The landed evidence that justified a framework override (null for a
   *  judgment-only orchestrator override). */
  evidence: LandedEvidence | null;
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
  /** WHERE this item's dispatched run writes (see DispatchClass). Absent =
   *  `worker` (writes only inside its worktree). `finisher` declares that the
   *  run writes into the DECLARED cwd's checkout, so an empty worktree is
   *  expected and NEVER evidence of a run that did nothing. */
  dispatchClass?: DispatchClass;
  /** WHAT a finisher-class dispatch lands (branch/tag/sha). Sticky across
   *  re-dispatches — it describes the item's work, not one run — and required
   *  for landed evidence (no declared source → no evidence). */
  finisherSource?: string | null;
  /** The declared cwd's HEAD when the current finisher run was dispatched. */
  finisherBaseline?: FinisherBaseline | null;
  /** Evidence that the work LANDED in the declared cwd (the declared source
   *  entered its history). Sticky: it records a fact about this item's work,
   *  and auto-recovery refuses to re-dispatch an item that carries it (a
   *  re-run would duplicate a merge that already landed). */
  landedEvidence?: LandedEvidence | null;
  /** Recorded overrides of run-level failure verdicts (append-only). */
  overrides?: FailureOverride[];
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
  /** Monotonic revision — half of the COMPARE-AND-SWAP token. Bumped by every
   *  mutateStore write; a mutation that finds a different rev on disk than the
   *  one it read has been overtaken and re-applies instead of clobbering.
   *  Backfilled to 0 on read for pre-rev stores (no schema break). */
  rev: number;
  /** The WRITE IDENTITY that stamped `rev` — the other half of the CAS token.
   *  `rev` alone is not identifying: two writers that both read revision N both
   *  stamp N+1, so each one's post-write re-read is satisfied by the OTHER's
   *  write and both report success while one is silently gone. The nonce is
   *  unique per write (`<pid>@<host>:<random>`), so a writer recognises its own
   *  write and nothing else. Backfilled to null on read. */
  revBy?: string | null;
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
      // Pre-rev stores start at revision 0 (same backfill-on-read rule as the
      // item fields below) — the first mutateStore write stamps rev 1.
      if (typeof raw.rev !== "number" || !Number.isFinite(raw.rev)) raw.rev = 0;
      if (typeof raw.revBy !== "string") raw.revBy = null;
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

/** RAW whole-file write (atomic tmp+rename, so a reader never sees a torn
 *  file). It does NOT serialize against other writers and does NOT bump `rev`
 *  — a bare loadStore → mutate → saveStore pair is exactly the lost-update
 *  race this module now guards against. Every mutation goes through
 *  mutateStore — which is the only non-test caller left (ensureMigrated writes
 *  through it too). Exported for tests, which need to plant store states the
 *  protocol would never produce. */
export function saveStore(stateDir: string, store: QueueStore): void {
  const p = storePath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

export function newStore(): QueueStore {
  return { version: 1, rev: 0, revBy: null, items: {} };
}

/** The store-ownership helper both hosts used to inline (loadStore ?? newStore).
 *  One place, in the store layer. */
export function loadStoreOrNew(stateDir: string): QueueStore {
  return loadStore(stateDir) ?? newStore();
}

// ---------------------------------------------------------------------------
// The ONE safe mutation path (lock + compare-and-swap)
// ---------------------------------------------------------------------------
//
// saveStore is atomic per write, but every caller used to do
// loadStore → mutate → saveStore with no serialization: a writer that loaded
// before another's rename silently erased it, whole-file (observed live — a
// fully-specified proposal vanished with a success receipt, and its key was
// handed out twice). The writers span PROCESSES (pi host, opencode host,
// tools) and harness timers, so an in-process mutex is not enough.
//
// Two mechanisms, layered, and BOTH carry the writer's identity:
//   1. an advisory LOCK FILE around the read-modify-write window —
//      cross-process, stamped with the holder's nonce, and published
//      ATOMICALLY (write a private tmp file, then link it into place) so a
//      contender never observes a half-created lock;
//   2. an identified COMPARE-AND-SWAP as the correctness floor — the mutation
//      refuses to write over a revision newer than the one it read, and treats
//      its write as landed only when the re-read shows ITS OWN nonce at
//      rev+1 while the lock is still its own.
// Identity is the whole point. A bare `rev === baseRev + 1` check is satisfied
// by a COMPETITOR's stamp of the same number: two writers that both read
// revision N both write N+1, both re-read N+1, and both report success while
// one of the two writes is gone — bit for bit the incident this module exists
// to prevent. So the lock is stamped with a nonce and the store records the
// nonce that produced its revision; a writer only ever recognises its own.
// The lock can still be stolen (a hard-killed holder must not wedge the
// harness, so a stale/expired lock IS broken open) — the identity checks are
// what make that steal safe FOR THE WRITER WHOSE LOCK WAS TAKEN: it sees that
// it no longer holds it, counts a conflict, and re-applies on the fresh store.
// The guarantee is ASYMMETRIC, and the residual is the THIEF's: the victim's
// pre-write guard can pass a moment before the steal, so its rename is already
// in flight and can land ON TOP of a write the thief has already made, verified
// and reported. The victim then re-applies (its own change is never lost), but
// the thief's receipt was for a write that is gone. That needs a steal (5s of
// contention, or a stale/dead-pid lock) PLUS that interleaving, where before
// the lock+CAS a loss needed nothing but two overlapping writers — which is why
// this shipped with the hole named rather than hidden. Closing it fully needs a
// different commit point: an O_EXCL rev-marker rename protocol on the store
// file, where the marker create (not the store rename) decides the winner, so
// no writer can be overwritten after it has been told it won. Deferred. A
// cheaper partial mitigation was evaluated and also deferred: re-probing lock
// ownership between saveStore's tmp write and its rename would shrink the
// victim's exposure from a whole serialize+write to a single syscall, but it is
// a real behaviour change (a new abort path, and saveStore would have to take a
// nonce), so it belongs to the rev-marker work, not here.
// Liveness is the hard requirement: NOTHING here waits unboundedly — a stuck
// sweep would be a worse failure than the bug.

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
/** How long an UNREADABLE lock file is given before it counts as abandoned.
 *  Unparsable content is not proof of abandonment — it is also what a lock
 *  looks like for the instant between its creation and its content landing on
 *  a filesystem that reorders them. Breaking one open immediately would let a
 *  contender delete a lock a live writer had just taken. */
const LOCK_UNREADABLE_GRACE_MS = 250;
const MAX_MUTATE_ATTEMPTS = 8;
const MAX_LOCK_ROUNDS = 500;

interface LockInfo {
  pid: number;
  host: string;
  at: number;
  /** the holder's WRITE IDENTITY — the same nonce it stamps into store.revBy.
   *  "" for a lock written by a pre-nonce build (never matches a live nonce,
   *  so such a lock is simply never mistaken for ours). */
  nonce: string;
}

/** A globally unique write identity. Two writers can stamp the same `rev`;
 *  they can never stamp the same nonce. */
function newWriteNonce(): string {
  return `${process.pid}@${hostname()}:${randomBytes(8).toString("hex")}`;
}

function lockPath(stateDir: string): string {
  return `${storePath(stateDir)}.lock`;
}

/** Block the thread for ~ms. The store writers are synchronous end to end, so
 *  the wait has to be too; holds are file-IO short. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(p: string): LockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
    if (!raw || typeof raw.pid !== "number" || typeof raw.at !== "number") return null;
    return { ...raw, nonce: typeof raw.nonce === "string" ? raw.nonce : "" };
  } catch {
    return null;
  }
}

/** Do WE hold the lock right now? The steal-safety check: any other writer
 *  entering the critical section must first replace this file with its own, so
 *  a lock that is missing or carries someone else's nonce means our window was
 *  taken and whatever we are about to write (or just wrote) is unsafe. */
function holdsStoreLock(stateDir: string, nonce: string): boolean {
  const info = readLock(lockPath(stateDir));
  return info !== null && info.nonce === nonce;
}

/** Is the lock holder gone (so the lock may be broken open)? Older than the
 *  stale timeout = abandoned; a dead pid on THIS host = abandoned (the pid
 *  check is only meaningful on the machine that wrote it); unreadable = only
 *  once it has sat unreadable for the grace window (see the constant). */
function lockHolderGone(p: string, now: number, staleMs: number): boolean {
  const info = readLock(p);
  if (!info) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      return true; // already gone from under us — nothing to wait for
    }
    return now - mtimeMs > LOCK_UNREADABLE_GRACE_MS;
  }
  if (now - info.at > staleMs) return true;
  if (info.host === hostname() && info.pid !== process.pid) {
    try {
      process.kill(info.pid, 0);
    } catch (e) {
      if ((e as { code?: string }).code === "ESRCH") return true;
    }
  }
  return false;
}

function acquireStoreLock(stateDir: string, nonce: string, waitMs: number, staleMs: number): void {
  const p = lockPath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + waitMs;
  // The lock is published CONTENT-FIRST: fill a private tmp file, then link it
  // into place. link() is the exclusive-create primitive here, so the lock
  // never exists in the empty/half-written state that an open("wx") +
  // write-afterwards sequence leaves visible — a contender that read the lock
  // in that gap saw unparsable content, called it abandoned, and deleted a lock
  // its live owner was still about to write into (two holders, no dead pid, no
  // staleness, no expired wait budget).
  // CONSTRAINT: this requires a filesystem with HARDLINKS. A link() that fails
  // with anything but EEXIST (EPERM/ENOSYS/EOPNOTSUPP on some network/FUSE
  // mounts) propagates and fails the write, loudly. That is deliberate: the
  // obvious fallback — openSync(p, "wx") then write the content — is exactly
  // the half-created-lock hazard above, so falling back to it would trade a
  // clear failure for the silent two-holders bug. The state dir is a local
  // ~/.local/state path, so this does not arise; if it ever must live on a
  // hardlink-less mount, the fix is a directory lock (mkdir is atomic-exclusive
  // everywhere), not a wx fallback.
  const tmp = `${p}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    for (let round = 0; round < MAX_LOCK_ROUNDS; round++) {
      try {
        writeFileSync(tmp, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), nonce } satisfies LockInfo));
        linkSync(tmp, p);
        return;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
      }
      const now = Date.now();
      if (lockHolderGone(p, now, staleMs) || now >= deadline) {
        // NEVER WEDGE THE HARNESS: a dead/abandoned holder, or one that
        // outlived the wait budget, gets its lock broken open rather than
        // waited on. The identified CAS below is what keeps a broken-open lock
        // from losing a write — the writer we stole from will see that the lock
        // is no longer its own and re-apply instead of reporting success.
        try {
          unlinkSync(p);
        } catch {
          // someone else broke it first — just retry the create
        }
        continue;
      }
      sleepSync(4 + Math.floor(Math.random() * 12));
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // the tmp link is scratch — the lock file survives it
    }
  }
  throw new Error(`queue: could not acquire the store lock at ${p} (contended past ${MAX_LOCK_ROUNDS} rounds)`);
}

function releaseStoreLock(stateDir: string, nonce: string): void {
  // Only unlink OUR lock: if it was broken open and re-taken while we ran, the
  // file belongs to the new holder and deleting it would strand them.
  if (!holdsStoreLock(stateDir, nonce)) return;
  try {
    unlinkSync(lockPath(stateDir));
  } catch {
    // best-effort — a missing lock is already released
  }
}

/** The on-disk revision AND the identity that stamped it — together, the CAS
 *  comparand. (0/null when the store is absent or unreadable.) */
function diskStamp(stateDir: string): { rev: number; revBy: string | null } {
  const store = loadStore(stateDir);
  return { rev: store?.rev ?? 0, revBy: store?.revBy ?? null };
}

export interface MutateOptions {
  /** bounded CAS retries before the mutation ABORTS loudly (default 8) */
  maxAttempts?: number;
  /** how long to wait for a contended lock before breaking it open (default 5s) */
  lockWaitMs?: number;
  /** a lock older than this is abandoned (default 15s) */
  lockStaleMs?: number;
}

/**
 * THE safe mutation path: load → apply → write, serialized across processes and
 * verified by compare-and-swap. `apply` receives the CURRENT store and mutates
 * it in place (returning whatever the caller needs to report); it may be re-run
 * on a conflict, so it must be a pure function of the store it is handed — no
 * spawns, no git, no nested mutateStore, no side effects that must happen once.
 * Do those before or after the call.
 *
 * Throws when the mutation could not be applied: an ABORT is the contract, so a
 * caller can never report success for a write that did not survive. An
 * exception from `apply` itself (an illegal transition, say) propagates
 * unchanged and writes nothing.
 */
export function mutateStore<T>(stateDir: string, apply: (store: QueueStore) => T, opts: MutateOptions = {}): T {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_MUTATE_ATTEMPTS);
  const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const lockStaleMs = opts.lockStaleMs ?? LOCK_STALE_MS;
  let conflicts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A FRESH identity per attempt: it stamps the lock we take and the revision
    // we write, so both the "is this still my window?" and the "is this my
    // write?" questions have an answer no competitor can accidentally give.
    const nonce = newWriteNonce();
    acquireStoreLock(stateDir, nonce, lockWaitMs, lockStaleMs);
    let landed: { value: T } | null = null;
    try {
      const store = loadStoreOrNew(stateDir);
      const baseRev = store.rev ?? 0;
      const value = apply(store);
      if (diskStamp(stateDir).rev !== baseRev || !holdsStoreLock(stateDir, nonce)) {
        // Our window was taken (the lock is someone else's now) or the store
        // moved under us — either way, re-apply on the fresh store.
        // ORDER IS DELIBERATE: the rev term reads and parses the WHOLE store
        // (milliseconds at real store sizes), so it runs FIRST; the cheap lock
        // probe runs last, leaving only a lock read between the check and the
        // write. Both terms are pure reads, so this is evaluation order only —
        // it narrows the check-then-act gap at zero cost. It does not close it
        // (see the residual above).
        conflicts++;
      } else {
        store.rev = baseRev + 1;
        store.revBy = nonce;
        saveStore(stateDir, store);
        const after = diskStamp(stateDir);
        // OUR nonce at OUR revision, with the window still ours. A competitor's
        // rev+1 does not count: that is exactly the write that erased us.
        if (after.rev === baseRev + 1 && after.revBy === nonce && holdsStoreLock(stateDir, nonce)) landed = { value };
        else conflicts++; // someone wrote over us — our change did NOT survive
      }
    } finally {
      releaseStoreLock(stateDir, nonce);
    }
    if (landed) return landed.value;
    sleepSync(3 + Math.floor(Math.random() * 12 * attempt)); // backoff + jitter
  }
  throw new Error(
    `queue: store mutation ABORTED after ${maxAttempts} attempts — ${conflicts} concurrent write conflict(s) on ${storePath(stateDir)}; the change was NOT saved`,
  );
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
    const migrated = migrateFromMd(readFileSync(mdPath, "utf8"));
    // Through the safe path like every other writer: two hosts can activate at
    // once, and the loser must see the winner's store rather than overwrite it.
    mutateStore(stateDir, (store) => {
      if (Object.keys(store.items).length > 0) return; // another activation migrated first
      store.items = migrated.items;
    });
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
  /** FINISHER-EVIDENCE: the dispatch class, the dispatch-time HEAD baseline,
   *  the landed proof, and the append-only override log. */
  dispatchClass?: DispatchClass;
  finisherSource?: string | null;
  finisherBaseline?: FinisherBaseline | null;
  landedEvidence?: LandedEvidence | null;
  overrides?: FailureOverride[];
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
  // ENTERING ai-review starts a NEW review round, so the previous round's
  // reviewer ref must not survive into it (a stale id blocks queue_review and
  // silently stops the harness's auto-review). Only on an ACTUAL entry: an
  // ai-review → ai-review re-statement (a metadata patch that repeats the
  // status) must NOT drop the reviewer that is running right now. An explicit
  // reviewerRunId in the same patch wins — the caller is stamping the dispatch.
  if (to === "ai-review" && from !== "ai-review" && clean.reviewerRunId === undefined) clean.reviewerRunId = null;
  // ENTERING `active` starts a NEW run, so the PREVIOUS run's landed evidence
  // AND its dispatch baseline must not survive into it (FINISHER-EVIDENCE): a
  // re-dispatched finisher that genuinely does nothing has to fail on its own
  // merits, and either leftover would launder that failure into a landing (a
  // stale baseline makes the PREVIOUS run's commit look like this run's work).
  // Both are cleared HERE, on the lifecycle edge, so every lane that returns an
  // item to `active` is covered — not just the dispatch tool. A lane that
  // spawns a finisher passes a FRESH baseline in the same patch (explicit wins);
  // the override LOG (overrides[]) and finisherSource keep the history.
  if (to === "active" && from !== "active" && clean.landedEvidence === undefined) clean.landedEvidence = null;
  if (to === "active" && from !== "active" && clean.finisherBaseline === undefined) clean.finisherBaseline = null;
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
