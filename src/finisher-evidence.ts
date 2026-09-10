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
//      as the dispatch BASELINE;
//   2. success evidence for that class is a HEAD MOVE in the declared cwd
//      (`landedEvidence`), not worktree edits;
//   3. a runtime failure verdict on a finisher whose work is EVIDENCED AS
//      LANDED is overridden — and the override is RECORDED on the item
//      (`overrides`), so a pattern of overrides is visible instead of folklore;
//   4. auto-recovery never re-dispatches an item carrying landed evidence.
//
// It still catches the real case: a finisher whose declared cwd's HEAD did NOT
// move has no evidence, so its failure stands exactly as before — and a plain
// worker is untouched by all of this.

import { execFileSync } from "node:child_process";
import type { FailureOverride, FinisherBaseline, LandedEvidence, QueueItem } from "./queue-store.ts";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
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

/** The dispatch-time baseline for a finisher run: the declared cwd's HEAD as
 *  it stands right now. Recorded on the item by the dispatch lane. */
export function captureFinisherBaseline(repo: string, runId: string | null, now = Date.now()): FinisherBaseline {
  const head = readRepoHead(repo);
  return { repo, ref: head?.ref ?? null, sha: head?.sha ?? null, runId, at: new Date(now).toISOString() };
}

/**
 * The landed check for ONE finisher item: did the declared cwd's HEAD move off
 * the dispatch baseline?
 *
 * Returns the evidence, or null when there is none (not a finisher, no cwd, no
 * baseline, unreadable repo, or HEAD still sitting on the baseline sha).
 * ALREADY-RECORDED evidence wins — it is a fact about the run that produced it,
 * and later HEAD movement by other work must not rewrite it.
 */
export function finisherLandedEvidence(item: QueueItem, now = Date.now()): LandedEvidence | null {
  if (item.landedEvidence) return item.landedEvidence;
  if (!isFinisherItem(item)) return null;
  const baseline = item.finisherBaseline ?? null;
  const repo = baseline?.repo ?? item.cwd;
  if (!repo || !baseline) return null; // no declared baseline → nothing to compare against
  const head = readRepoHead(repo);
  if (!head) return null;
  if (baseline.sha === null || head.sha === baseline.sha) return null; // HEAD never moved → no evidence
  return {
    repo,
    ref: head.ref ?? baseline.ref,
    fromSha: baseline.sha,
    sha: head.sha,
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
      `runtime reported the run unsuccessful, but this is a FINISHER-CLASS dispatch (writes outside its worktree) and its work is EVIDENCED AS LANDED: ` +
      `${evidence.repo} ${evidence.ref ?? "HEAD"} moved ${short(evidence.fromSha)} → ${short(evidence.sha)}. ` +
      `The 'no edits in the worktree' signal does not apply to this class.`,
    evidence,
  };
}

/** The human-readable one-liner both the note and the tick use. */
export function landedNote(evidence: LandedEvidence, runId: string | null, now = Date.now()): string {
  return (
    `[finisher-landed] ${new Date(now).toISOString()} — run ${runId ?? evidence.runId ?? "?"} was reported unsuccessful by the runtime, ` +
    `but this item is FINISHER-CLASS (it writes into ${evidence.repo}, not its worktree) and its work LANDED: ` +
    `${evidence.ref ?? "HEAD"} ${short(evidence.fromSha)} → ${short(evidence.sha)}. ` +
    `The failure verdict is OVERRIDDEN (recorded in overrides[]) and auto-recovery will NOT re-dispatch this item — a re-run would duplicate a merge that already landed.`
  );
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "?";
}
