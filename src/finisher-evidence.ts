// finisher-evidence.ts — FINISHER-CLASS EVIDENCE (KEY: AUTOPILOT-34).
//
// The runtime decides "this child did nothing" by looking for file edits in the
// child's own ISOLATED WORKTREE. That heuristic is right for a normal worker
// and WRONG for a merge finisher: a finisher lands an approved branch into the
// TARGET REPO'S CHECKOUT (its declared cwd) — usually by CHERRY-PICK, because
// the branch's base is stale — and leaves its worktree untouched BY DESIGN.
// Observed live (AUTOPILOT-33 landing AUTOPILOT-24): the merge landed, the
// suite was green — and the run was reported as "returned planning or
// scratchpad output instead of applying changes" and marked FAILED.
//
// A false failure is not cosmetic here. AUTOPILOT-18's auto-recovery treats a
// `failed` item as a re-dispatch candidate, so a false failure on a finisher
// can RE-RUN A MERGE THAT ALREADY LANDED (duplicate cherry-pick, or a worker
// pointed at a moved main).
//
// THE FIX: the queue's own record is authoritative for that class.
//   1. a dispatch DECLARES its class (`dispatchClass: "finisher"` = writes
//      OUTSIDE its worktree, into the declared cwd) and records the cwd's HEAD
//      plus the SOURCE it was sent to land as the dispatch BASELINE;
//   2. success evidence for that class is the declared source ENTERING the
//      declared cwd's history during this run (`landedEvidence`), not worktree
//      edits;
//   3. a runtime failure verdict on a finisher whose work is EVIDENCED AS
//      LANDED is overridden — and the override is RECORDED on the item
//      (`overrides`), so a pattern of overrides is visible instead of folklore;
//   4. auto-recovery never re-dispatches an item carrying landed evidence.
//
// WHAT THE EVIDENCE PROVES, EXACTLY — and what it does not.
// The check is deliberately narrow, because "the declared cwd's HEAD moved" on
// its own is NOT evidence of this run: the same checkout is written by the
// shipping lane's `git merge --no-ff` for other done items, by a second
// finisher, and by humans. So evidence requires ALL of:
//   * the run being judged OWNS the baseline (baseline.runId is this item's
//     run — a stale baseline from a previous run proves nothing about this one;
//     on a terminal status the item has NO runId, and there the baseline is its
//     most recent dispatch BY CONSTRUCTION: entering `active` clears the
//     baseline and only a dispatch lane writes one);
//   * a SOURCE was declared at dispatch and resolved to a commit
//     (`finisherSource`, e.g. the approved branch) — with no declared source
//     there is NO evidence and the runtime verdict stands, unchanged;
//   * HEAD ADVANCED from the baseline (baseline is an ancestor of HEAD — a
//     reset/checkout to an unrelated commit is not a landing);
//   * the declared source is IN the target's history NOW and was NOT at the
//     baseline — i.e. it entered during this dispatch's window.
//
// WHICH LANDING SHAPES ARE DETECTABLE — precisely, because a check that
// silently covers nothing is worse than no check. "IN" means EITHER the source
// commits themselves are ancestors of HEAD (`git merge --no-ff`, fast-forward),
// OR every source commit has a PATCH-EQUIVALENT commit in HEAD's history
// (`git cherry`, i.e. patch-id equality — cherry-pick, rebase, and a squash of
// a single-commit source). Cherry-pick is the shape this project actually uses,
// so ancestry alone would have made this lane inert.
// NOT detectable — these produce NO evidence and the runtime's failure verdict
// STANDS (fail closed; the operator overrides deliberately with
// `queue_update(key, {overrideReason})` after verifying the commit):
//   * a CONFLICT-RESOLVED cherry-pick/rebase. Resolving a conflict changes the
//     patch, so the patch-id no longer matches and no mechanism can tell that
//     landing apart from "landed something else" without judging content
//     equivalence — which is a human/reviewer call, not a git question.
//     (Observed: AUTOPILOT-25's finisher, where `git cherry` reported its own
//     landed commit as unlanded for exactly this reason.)
//   * a SQUASH of a MULTI-COMMIT source: one combined patch matches none of the
//     source commits' patch-ids.
//   * a landing that never touches the declared cwd at all — notably the
//     shipping lane's `mrs` flow, which PUSHES the branch and opens an MR: the
//     local checkout's HEAD never moves, so there is nothing to evidence here
//     (that work is judged by the MR, not by this lane).
// RESIDUAL (stated, not hidden): this proves THE WORK LANDED, not WHO landed
// it. If a human or another lane merges the same declared source while the
// finisher runs, that also satisfies the check. The consequence is bounded and
// deliberate: the item is moved off `failed` and LEFT FOR A HUMAN (auto-recovery
// refuses to re-dispatch, it never closes the item), which is the right call in
// that case too — the branch IS in, so a re-run would duplicate the merge.
// Everything else fails closed: unreadable repo, unresolvable source, missing
// baseline, mismatched run, non-advancing HEAD, a git question git cannot
// answer (bad object, timeout), or a landing shape outside the two detectable
// ones → no evidence, the failure verdict stands.
//
// THE UPSTREAM FIX this lane substitutes for: pi-subagents exposes a per-agent
// `completionGuard` boolean, which is where "this class of child writes outside
// its worktree" ultimately belongs. Using it needs an agent identity plus a
// spawn-time selector on SubagentBackend.spawn (neither exists here), and it
// would only cover the pi host. This framework-side lane is the durable answer
// — the queue's own record stays authoritative across hosts — but a
// spawn-time completionGuard selector upstream is the cheaper long-term fix
// for the pi host specifically.

import { execFileSync, spawnSync } from "node:child_process";
import type { FailureOverride, FinisherBaseline, LandedEvidence, LandingShape, QueueItem } from "./queue-store.ts";

/** Every git call here is bounded: a hung/huge repo must not stall completion
 *  handling, and a timeout throws/sets `error` → null → NO evidence (closed). */
const GIT_TIMEOUT_MS = 15_000;

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS }).trim() || null;
  } catch {
    return null;
  }
}

/** `git merge-base --is-ancestor` as a THREE-state answer: true/false, and
 *  null when git could not answer (missing object, not a repo). Null is never
 *  treated as a yes — an unanswerable ancestry question yields no evidence. */
function isAncestor(repo: string, ancestor: string, descendant: string): boolean | null {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo, stdio: "ignore", timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status === null) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null; // 128 & friends: bad object / not a repo
}

/**
 * Is the declared SOURCE in `tip`'s history? FOUR-state: the shape when it is,
 * `false` when it demonstrably is not, `null` when git could not answer (bad
 * object, not a repo, timeout) — and null is never treated as a yes.
 *
 * Ancestry alone is not enough: a cherry-pick, rebase or squash creates NEW
 * commits, so the declared sha never becomes an ancestor even though the work
 * IS in — and cherry-pick is how every finisher in this project lands (the
 * branch's base is routinely stale). So after the ancestry fast path we ask
 * `git cherry <tip> <source>`, which lists the source-side commits since the
 * merge base and marks each `-` when an equivalent PATCH already exists in tip
 * and `+` when it does not. ALL `-` ⇒ the whole declared source is in.
 *
 * Why `git cherry` and not hand-rolled `git patch-id` comparison: it is git's
 * own patch-equivalence primitive (same patch-id machinery, merge-base scoped,
 * merges skipped), it answers both sides of the narrowing with ONE predicate
 * (present now / absent at the baseline), and reimplementing it would add
 * failure modes without adding power.
 *
 * Its known limit is REAL and deliberate: a CONFLICT-RESOLVED cherry-pick has a
 * different patch, so it reports `+` and this returns false → no evidence, the
 * failure verdict stands. Same for a squash of a multi-commit source. Deciding
 * those landed needs content judgment, not a git predicate, so they stay a
 * human override — see the header.
 */
function sourceLandingIn(repo: string, sourceSha: string, tip: string): LandingShape | false | null {
  const direct = isAncestor(repo, sourceSha, tip);
  if (direct === null) return null;
  if (direct) return "ancestor";
  const r = spawnSync("git", ["cherry", tip, sourceSha], { cwd: repo, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null; // unanswerable → no evidence
  const marks = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  // Not an ancestor ⇒ there IS at least one source-side commit. An empty list
  // means git answered something we cannot interpret → fail closed.
  if (!marks.length) return null;
  return marks.every((l) => l.startsWith("-")) ? "patch-equivalent" : false;
}

export interface RepoHead {
  /** The checked-out branch, or null when detached/unreadable. */
  ref: string | null;
  sha: string;
}

/** The declared cwd's current HEAD (sha + checked-out ref). Null when the path
 *  is not a readable repo — an unreadable repo yields NO evidence, so the
 *  runtime verdict stands (fail closed: we never invent a landing). */
export function readRepoHead(repo: string): RepoHead | null {
  const sha = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!sha) return null;
  const ref = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { ref: ref && ref !== "HEAD" ? ref : null, sha };
}

/** true when this item's run writes OUTSIDE its worktree (merge finisher). */
export function isFinisherItem(item: Pick<QueueItem, "dispatchClass">): boolean {
  return item.dispatchClass === "finisher";
}

/**
 * The dispatch-time baseline for a finisher run: the declared cwd's HEAD as it
 * stands right now, plus the SOURCE this dispatch was sent to land (a branch,
 * tag or sha, resolved to a commit NOW so a branch deleted by the merge still
 * answers the ancestry question later). Recorded on the item by every lane
 * that spawns a finisher-class run.
 *
 * `source` null (or unresolvable) → the run gets no landed evidence at all.
 */
export function captureFinisherBaseline(
  repo: string,
  runId: string | null,
  source: string | null,
  now = Date.now(),
): FinisherBaseline {
  const head = readRepoHead(repo);
  const sourceSha = source ? git(repo, ["rev-parse", "--verify", "--quiet", `${source}^{commit}`]) : null;
  return {
    repo,
    ref: head?.ref ?? null,
    sha: head?.sha ?? null,
    source: source ?? null,
    sourceSha,
    runId,
    at: new Date(now).toISOString(),
  };
}

/**
 * The landed check for ONE finisher item: did the source this dispatch was
 * sent to land ENTER the declared cwd's history during this run — as itself,
 * or as patch-equivalent commits (cherry-pick/rebase/squash-of-one)?
 *
 * Returns the evidence, or null when there is none — see the header for the
 * exact conditions and the stated residual. ALREADY-RECORDED evidence wins: it
 * is a fact about the run that produced it, and later movement in the repo must
 * not rewrite it.
 */
export function finisherLandedEvidence(item: QueueItem, now = Date.now()): LandedEvidence | null {
  if (item.landedEvidence) return item.landedEvidence;
  if (!isFinisherItem(item)) return null;
  const baseline = item.finisherBaseline ?? null;
  if (!baseline) return null; // no declared baseline → nothing to compare against
  // RUN BINDING: the baseline must belong to the run being judged. A baseline
  // left over from a PREVIOUS run says nothing about this one — that is how a
  // genuinely failed re-run would launder itself into a landing. `item.runId`
  // is null on terminal statuses (queue-store clears it entering `failed`);
  // there the baseline is still unambiguous, because entering `active` clears
  // the baseline and only a dispatch lane writes one, so a baseline on a
  // run-less item belongs to that item's most recent dispatch.
  if (item.runId && baseline.runId !== item.runId) return null;
  const repo = baseline.repo;
  // No readable dispatch HEAD, or no source declared/resolved → no evidence.
  if (!repo || !baseline.sha || !baseline.sourceSha) return null;
  const head = readRepoHead(repo);
  if (!head || head.sha === baseline.sha) return null; // HEAD never moved → no evidence
  if (isAncestor(repo, baseline.sha, head.sha) !== true) return null; // HEAD did not ADVANCE from the baseline
  // IN NOW, NOT IN AT THE BASELINE — the same predicate on both sides, so the
  // narrowing survives: a cherry-pick that landed BEFORE this dispatch is
  // already patch-present at the baseline and yields no evidence.
  const landing = sourceLandingIn(repo, baseline.sourceSha, head.sha);
  if (landing === false || landing === null) return null; // still not in, or unanswerable
  if (sourceLandingIn(repo, baseline.sourceSha, baseline.sha) !== false) return null; // already in at dispatch (or unanswerable)
  return {
    repo,
    ref: head.ref ?? baseline.ref,
    fromSha: baseline.sha,
    sha: head.sha,
    landing,
    source: baseline.source,
    sourceSha: baseline.sourceSha,
    runId: item.runId ?? baseline.runId,
    at: new Date(now).toISOString(),
  };
}

/** Append an override to the item's append-only override log. */
export function appendOverride(item: Pick<QueueItem, "overrides">, override: FailureOverride): FailureOverride[] {
  return [...(item.overrides ?? []), override];
}

/** The framework override of a runtime failure verdict, built from evidence. */
export function landedOverride(evidence: LandedEvidence, runId: string | null, now = Date.now()): FailureOverride {
  return {
    at: new Date(now).toISOString(),
    by: "framework",
    runId: runId ?? evidence.runId,
    reason:
      `runtime reported the run unsuccessful, but this is a FINISHER-CLASS dispatch (writes outside its worktree) and the work it was sent to land IS LANDED: ` +
      `${evidence.source ?? short(evidence.sourceSha)} is now in ${evidence.repo} ${evidence.ref ?? "HEAD"} ${landingPhrase(evidence.landing)} (${short(evidence.fromSha)} → ${short(evidence.sha)}), and was not at dispatch. ` +
      `The 'no edits in the worktree' signal does not apply to this class. This evidences THE LANDING, not who performed it — a re-run would duplicate the merge either way.`,
    evidence,
  };
}

/** The human-readable one-liner both the note and the tick use. */
export function landedNote(evidence: LandedEvidence, runId: string | null, now = Date.now()): string {
  return (
    `[finisher-landed] ${new Date(now).toISOString()} — run ${runId ?? evidence.runId ?? "?"} was reported unsuccessful by the runtime, ` +
    `but this item is FINISHER-CLASS (it writes into ${evidence.repo}, not its worktree) and the source it was sent to land IS IN: ` +
    `${evidence.source ?? short(evidence.sourceSha)} → ${evidence.ref ?? "HEAD"} ${landingPhrase(evidence.landing)} ${short(evidence.fromSha)} → ${short(evidence.sha)}. ` +
    `The failure verdict is OVERRIDDEN (recorded in overrides[]) and auto-recovery will NOT re-dispatch this item — a re-run would duplicate a merge that already landed. Verify the landed commit.`
  );
}

/** Say WHICH landing shape the evidence found — "is now in" would be false for
 *  a cherry-pick, where the declared sha itself is not in the history at all. */
function landingPhrase(landing: LandingShape | undefined): string {
  return landing === "patch-equivalent" ? "as patch-equivalent commits (cherry-pick/rebase)" : "as the declared commits (merge/fast-forward)";
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "?";
}
