// finisher-evidence.ts — FINISHER-CLASS EVIDENCE (KEY: AUTOPILOT-34).
//
// The runtime decides "this child did nothing" by looking for file edits in the
// child's own ISOLATED WORKTREE. That heuristic is right for a normal worker
// and WRONG for a merge finisher: a finisher cherry-picks/merges an approved
// branch into the TARGET REPO'S CHECKOUT (its declared cwd) and leaves its
// worktree untouched BY DESIGN. Observed live (AUTOPILOT-33 landing
// AUTOPILOT-24): the merge landed, the suite was green — and the run was
// reported as "returned planning or scratchpad output instead of applying
// changes" and marked FAILED.
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
//     run — a stale baseline from a previous run proves nothing about this one);
//   * a SOURCE was declared at dispatch and resolved to a commit
//     (`finisherSource`, e.g. the approved branch) — with no declared source
//     there is NO evidence and the runtime verdict stands, unchanged;
//   * HEAD ADVANCED from the baseline (baseline is an ancestor of HEAD — a
//     reset/checkout to an unrelated commit is not a landing);
//   * the declared source is NOW an ancestor of HEAD but was NOT an ancestor
//     of the baseline — i.e. that branch entered the target's history during
//     this dispatch's window.
// RESIDUAL (stated, not hidden): this proves THE WORK LANDED, not WHO landed
// it. If a human or another lane merges the same declared source while the
// finisher runs, that also satisfies the check. The consequence is bounded and
// deliberate: the item is moved off `failed` and LEFT FOR A HUMAN (auto-recovery
// refuses to re-dispatch, it never closes the item), which is the right call in
// that case too — the branch IS in, so a re-run would duplicate the merge.
// Everything else fails closed: unreadable repo, unresolvable source, missing
// baseline, mismatched run, non-advancing HEAD → no evidence, failure stands.
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
import type { FailureOverride, FinisherBaseline, LandedEvidence, QueueItem } from "./queue-store.ts";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
}

/** `git merge-base --is-ancestor` as a THREE-state answer: true/false, and
 *  null when git could not answer (missing object, not a repo). Null is never
 *  treated as a yes — an unanswerable ancestry question yields no evidence. */
function isAncestor(repo: string, ancestor: string, descendant: string): boolean | null {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo, stdio: "ignore" });
  if (r.error || r.status === null) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null; // 128 & friends: bad object / not a repo
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
 * sent to land ENTER the declared cwd's history during this run?
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
  if (isAncestor(repo, baseline.sourceSha, head.sha) !== true) return null; // the declared source is still not in
  if (isAncestor(repo, baseline.sourceSha, baseline.sha) !== false) return null; // it was ALREADY in at dispatch
  return {
    repo,
    ref: head.ref ?? baseline.ref,
    fromSha: baseline.sha,
    sha: head.sha,
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
      `${evidence.source ?? short(evidence.sourceSha)} is now in ${evidence.repo} ${evidence.ref ?? "HEAD"} (${short(evidence.fromSha)} → ${short(evidence.sha)}), and was not at dispatch. ` +
      `The 'no edits in the worktree' signal does not apply to this class. This evidences THE LANDING, not who performed it — a re-run would duplicate the merge either way.`,
    evidence,
  };
}

/** The human-readable one-liner both the note and the tick use. */
export function landedNote(evidence: LandedEvidence, runId: string | null, now = Date.now()): string {
  return (
    `[finisher-landed] ${new Date(now).toISOString()} — run ${runId ?? evidence.runId ?? "?"} was reported unsuccessful by the runtime, ` +
    `but this item is FINISHER-CLASS (it writes into ${evidence.repo}, not its worktree) and the source it was sent to land IS IN: ` +
    `${evidence.source ?? short(evidence.sourceSha)} → ${evidence.ref ?? "HEAD"} ${short(evidence.fromSha)} → ${short(evidence.sha)}. ` +
    `The failure verdict is OVERRIDDEN (recorded in overrides[]) and auto-recovery will NOT re-dispatch this item — a re-run would duplicate a merge that already landed. Verify the landed commit.`
  );
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "?";
}
