// test/finisher-evidence.test.ts — AUTOPILOT-34. A MERGE FINISHER writes into
// the target repo's CHECKOUT (its declared cwd) and leaves its own worktree
// untouched by design, so the runtime's "no edits in the worktree" heuristic
// always misreports the class whose success matters most (observed live:
// AUTOPILOT-33 landing AUTOPILOT-24 — merge landed, suite green, run reported
// as "returned planning or scratchpad output" and marked FAILED). A false
// failure is not cosmetic: auto-recovery treats `failed` as a re-dispatch
// candidate, so it can re-run a merge that already landed.
//
// Pinned here, including the LANDING SHAPES (a finisher in this project lands
// by CHERRY-PICK, because the approved branch's base is stale — so ancestry
// alone would cover nothing): a merge/fast-forward and a clean cherry-pick or
// rebase (patch-equivalent) ARE evidence; a CONFLICT-RESOLVED cherry-pick is
// NOT, because resolving the conflict rewrites the patch — that case fails
// closed and stays a deliberate human override.
//
// Pinned here: (1) a finisher-class run whose DECLARED SOURCE landed in the
// declared cwd is NOT failed — the verdict is overridden and the override
// RECORDED; (2) a run that landed nothing IS failed (finisher and plain worker
// alike — the real "wrote a plan and stopped" case still lands); (3) evidence
// is bound to THE RUN BEING JUDGED and to the DECLARED SOURCE, so neither a
// previous run's landing (via ANY re-activation lane) nor a third party's
// commit in the same checkout can launder a failed run; (4) auto-recovery never
// re-dispatches an item with landed evidence; (5) the override record survives
// a store round-trip.
import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../src/core.ts";
import {
  newStore,
  addItem,
  saveStore,
  loadStore,
  mutateStore,
  updateItem,
  type QueueItem,
  type QueueStore,
} from "../src/queue-store.ts";
import { captureFinisherBaseline, finisherLandedEvidence, landedNote, landedOverride, readRepoHead } from "../src/finisher-evidence.ts";
import { autoDispatchEligible, autoRedispatch } from "../src/framework/auto-dispatch.ts";
import { autoRecoverFails } from "../src/framework/auto-recovery.ts";
import { queueDispatch, queueUpdate, type QueueOpsCtx } from "../src/tools/queue-ops.ts";
import type { SubagentBackend } from "../src/backends/types.ts";

const NOW = 1_800_000_000_000;
const trash: string[] = [];
afterEach(() => {
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A real repo — the landed check reads git, so the tests do too. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "orch-finisher-repo-"));
  trash.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.email", "test@test");
  g(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  return repo;
}

function commit(repo: string, file: string, message: string): string {
  writeFileSync(join(repo, file), `${message}\n`);
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", message);
  return g(repo, "rev-parse", "HEAD");
}

/** The approved work a finisher is sent to LAND: a branch with a commit on it,
 *  left unmerged. Returns its sha. */
function branchWithCommit(repo: string, branch: string): string {
  const base = g(repo, "rev-parse", "--abbrev-ref", "HEAD");
  g(repo, "checkout", "-q", "-b", branch);
  const sha = commit(repo, `${branch}.txt`, `work on ${branch}`);
  g(repo, "checkout", "-q", base);
  return sha;
}

/** One landing shape: merge the approved branch into the checkout. */
function landBranch(repo: string, branch: string): string {
  g(repo, "merge", "--no-ff", "-m", `ship ${branch}`, branch);
  return g(repo, "rev-parse", "HEAD");
}

/** THE landing shape this project actually uses: the branch's base is stale, so
 *  the finisher CHERRY-PICKS it onto the checkout — new commits, so the declared
 *  sha never becomes an ancestor. */
function cherryPickBranch(repo: string, branch: string): string {
  g(repo, "cherry-pick", "-x", branch);
  return g(repo, "rev-parse", "HEAD");
}

/** The approved work as a MULTI-COMMIT branch: the shape a squash cannot
 *  evidence — one combined patch matches none of the source patch-ids. */
function branchWithCommits(repo: string, branch: string, files: string[]): string {
  const base = g(repo, "rev-parse", "--abbrev-ref", "HEAD");
  g(repo, "checkout", "-q", "-b", branch);
  let tip = "";
  for (const f of files) tip = commit(repo, f, `work on ${branch}: ${f}`);
  g(repo, "checkout", "-q", base);
  return tip;
}

/** A SQUASH landing: `git merge --squash` collapses the branch into ONE new
 *  commit on the checkout (never a fast-forward). */
function squashBranch(repo: string, branch: string): string {
  g(repo, "merge", "--squash", branch);
  g(repo, "commit", "-q", "-m", `squash ${branch}`);
  return g(repo, "rev-parse", "HEAD");
}

/** A cherry-pick that CONFLICTED and was resolved by hand: the landed patch is
 *  no longer the source's patch, so patch-id equality legitimately fails. */
function cherryPickWithConflict(repo: string, branch: string, file: string, resolution: string): string {
  try {
    g(repo, "cherry-pick", branch);
  } catch {
    // expected: the conflict is the point
  }
  writeFileSync(join(repo, file), resolution);
  g(repo, "add", ".");
  g(repo, "-c", "core.editor=true", "cherry-pick", "--continue");
  return g(repo, "rev-parse", "HEAD");
}

/** The dispatch record a finisher lane writes before spawning: cwd HEAD +
 *  the source it must land, bound to the run being dispatched. */
function baselineFor(repo: string, source: string, sourceSha: string, runId: string | null) {
  return {
    repo,
    ref: "main",
    sha: g(repo, "rev-parse", "HEAD"),
    source,
    sourceSha,
    runId,
    at: new Date(NOW - 60_000).toISOString(),
  };
}

function item(over: Partial<QueueItem> & { key: string }): QueueItem {
  return {
    status: "active",
    blocker: null,
    title: "t",
    scope: "land the approved branch",
    cwd: null,
    evidence: "",
    value: "M",
    urgency: "M",
    risk: "low",
    runId: "run-fin-1",
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    failCause: null,
    recoveries: 0,
    recoveryNotBefore: null,
    recoveryEscalated: false,
    notes: "",
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

/** The host adapter seam queue_dispatch/queue_update run against. */
function ctxForDispatch(dir: string, spawns: string[]): QueueOpsCtx {
  return {
    stateDir: dir,
    backend: {
      spawn: async (task: string) => {
        spawns.push(task);
        return "run-dispatched";
      },
    },
    storeOrNew: () => loadStore(dir) ?? newStore(),
    autopilot: () => ({ handleAsyncStarted: () => undefined }),
    cfg: () => ({}),
    emit: () => {},
    repoCheck: async () => ({ ok: true }),
    sessionCwd: tmpdir(),
  } as unknown as QueueOpsCtx;
}

function dirWith(items: QueueItem[]): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-finisher-"));
  trash.push(dir);
  const store = newStore();
  for (const it of items) addItem(store, it, it.updatedAt || it.createdAt);
  saveStore(dir, store);
  return dir;
}

function read(dir: string): QueueStore {
  return loadStore(dir) as QueueStore;
}

/** The completion the runtime reports for a finisher: unsuccessful, because it
 *  found no edits in the child's own worktree. */
function failedCompletion(runId: string) {
  return { runId, agent: "worker", success: false, status: "failed", summary: "no edits detected" };
}

describe("finisher-class evidence — the declared source landing in the declared cwd is the success proof", () => {
  test("a finisher-class run whose DECLARED SOURCE landed is NOT failed; the verdict is overridden and RECORDED", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-1");
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([
      item({
        key: "AP-1",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-1",
        finisherBaseline: baselineFor(repo, "feature-1", sourceSha, "run-fin-1"),
      }),
    ]);
    // the finisher's ONLY output: the merge in the target repo's checkout
    const landedSha = landBranch(repo, "feature-1");

    const res = new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    const it = read(dir).items["AP-1"];
    expect(it.status).toBe("ai-review"); // NOT failed
    expect(it.landedEvidence?.sha).toBe(landedSha);
    expect(it.landedEvidence?.fromSha).toBe(baseSha);
    expect(it.landedEvidence?.landing).toBe("ancestor"); // merged, not patch-equivalent
    expect(it.failCause ?? null).toBeNull();
    // the override is a RECORD, not folklore in notes
    expect(it.overrides?.length).toBe(1);
    expect(it.overrides?.[0].by).toBe("framework");
    expect(it.overrides?.[0].runId).toBe("run-fin-1");
    expect(it.overrides?.[0].evidence?.sha).toBe(landedSha);
    expect(it.landedEvidence?.source).toBe("feature-1");
    expect(it.landedEvidence?.sourceSha).toBe(sourceSha);
    expect(it.notes).toContain("[finisher-landed]");
    // and the operator is told, because the runtime just said "failed"
    expect(res.flipped).toBe(true);
    expect(res.tick?.facts.failureOverridden).toBe(true);
    expect(res.tick?.message).toContain("OVERRIDDEN");
    expect(res.domainEvents.some((e) => e.name === "orch:failure-overridden")).toBe(true);
  });

  test("a finisher whose declared cwd did NOT move IS failed — the plan-only case still lands", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-2");
    const dir = dirWith([
      item({
        key: "AP-2",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-2",
        finisherBaseline: baselineFor(repo, "feature-2", sourceSha, "run-fin-1"),
      }),
    ]);

    const res = new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    const it = read(dir).items["AP-2"];
    expect(it.status).toBe("failed");
    expect(it.failCause).toBe("verdict");
    expect(it.landedEvidence ?? null).toBeNull();
    expect(it.overrides ?? []).toEqual([]);
    expect(res.tick?.reason).toBe("failure");
  });

  test("a plain worker is untouched by the evidence path — a failed run still fails even if the repo moved", () => {
    const repo = initRepo();
    const dir = dirWith([item({ key: "AP-3", cwd: repo })]); // no dispatchClass → worker
    commit(repo, "someone-else.txt", "unrelated commit in the checkout");

    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    const it = read(dir).items["AP-3"];
    expect(it.status).toBe("failed");
    expect(it.landedEvidence ?? null).toBeNull();
  });

  test("finisherLandedEvidence: recorded evidence wins, and a missing baseline yields none", () => {
    const repo = initRepo();
    const baseSha = g(repo, "rev-parse", "HEAD");
    const recorded = {
      repo,
      ref: "main",
      fromSha: baseSha,
      sha: "deadbeefdeadbeef",
      source: "feature-old",
      sourceSha: "cafecafecafecafe",
      runId: "run-old",
      at: "2026-01-01T00:00:00.000Z",
    };
    const withRecord = item({ key: "AP-4", cwd: repo, dispatchClass: "finisher", landedEvidence: recorded });
    expect(finisherLandedEvidence(withRecord, NOW)).toEqual(recorded);
    // finisher without a baseline: nothing to compare against → no evidence
    expect(finisherLandedEvidence(item({ key: "AP-5", cwd: repo, dispatchClass: "finisher" }), NOW)).toBeNull();

    // AUTOPILOT-46: `landing` is optional (evidence recorded before the shape
    // was), and evidence with no recorded shape must not be described as one —
    // the phrasing stays NEUTRAL instead of asserting merge/fast-forward.
    expect(recorded).not.toHaveProperty("landing");
    expect(landedNote(recorded, "run-old", NOW)).toContain("in that history");
    expect(landedNote(recorded, "run-old", NOW)).not.toContain("merge/fast-forward");
    expect(landedOverride(recorded, "run-old", NOW).reason).toContain("in that history");
    // … while a RECORDED shape is still named exactly
    expect(landedNote({ ...recorded, landing: "ancestor" }, "run-old", NOW)).toContain("merge/fast-forward");
    expect(landedNote({ ...recorded, landing: "patch-equivalent" }, "run-old", NOW)).toContain("patch-equivalent commits");
  });

  test("a re-dispatch drops the previous run's landed evidence — the new run is judged on its own", async () => {
    const repo = initRepo();
    const oldSourceSha = branchWithCommit(repo, "feature-old");
    const baseSha = g(repo, "rev-parse", "HEAD");
    const landed = landBranch(repo, "feature-old");
    const dir = dirWith([
      item({
        key: "AP-10",
        status: "failed",
        failCause: "verdict",
        cwd: repo,
        runId: null,
        dispatchClass: "finisher",
        finisherSource: "feature-old",
        finisherBaseline: { repo, ref: "main", sha: baseSha, source: "feature-old", sourceSha: oldSourceSha, runId: "run-old", at: new Date(NOW - 60_000).toISOString() },
        landedEvidence: { repo, ref: "main", fromSha: baseSha, sha: landed, source: "feature-old", sourceSha: oldSourceSha, runId: "run-old", at: new Date(NOW - 60_000).toISOString() },
      }),
    ]);
    const nextSourceSha = branchWithCommit(repo, "feature-next");
    const spawns: string[] = [];

    await queueDispatch(ctxForDispatch(dir, spawns), {
      key: "AP-10",
      task: "re-run the finisher",
      cwd: repo,
      dispatchClass: "finisher",
      finisherSource: "feature-next",
    });
    const redispatched = read(dir).items["AP-10"];
    expect(redispatched.landedEvidence ?? null).toBeNull(); // stale proof cleared
    expect(redispatched.finisherBaseline?.sha).toBe(landed); // fresh baseline = the CURRENT head
    expect(redispatched.finisherBaseline).toMatchObject({ source: "feature-next", sourceSha: nextSourceSha, runId: "run-dispatched" });

    // the new run writes nothing → it fails, exactly like the plan-only case
    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-dispatched"), NOW);
    expect(read(dir).items["AP-10"].status).toBe("failed");
  });

  test("captureFinisherBaseline/readRepoHead read the declared cwd's real HEAD and resolve the declared source", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-cap");
    const head = readRepoHead(repo);
    expect(head?.sha).toBe(g(repo, "rev-parse", "HEAD"));
    expect(head?.ref).toBe("main");
    const baseline = captureFinisherBaseline(repo, "run-x", "feature-cap", NOW);
    expect(baseline).toMatchObject({ repo, ref: "main", sha: head?.sha, source: "feature-cap", sourceSha, runId: "run-x" });
    // an undeclared / unresolvable source resolves to null — the evidence path is then OFF
    expect(captureFinisherBaseline(repo, "run-x", null, NOW).sourceSha).toBeNull();
    expect(captureFinisherBaseline(repo, "run-x", "no-such-branch", NOW).sourceSha).toBeNull();
    expect(readRepoHead(mkdtempSync(join(tmpdir(), "orch-not-a-repo-")))).toBeNull();
  });
});

// The false-positive surface: evidence must belong to THE RUN BEING JUDGED and
// to the SOURCE THE DISPATCH WAS SENT TO LAND. A stale baseline (any lane that
// re-activates an item) or a third party writing the same checkout (the
// shipping lane's `merge --no-ff` for another item, a second finisher, a human)
// would otherwise let a genuinely failed run inherit somebody else's commit as
// its own success — and auto-recovery would then refuse to recover it while
// announcing "EVIDENCED AS LANDED".
describe("finisher evidence is bound to this run AND to the declared source", () => {
  test("a baseline from a DIFFERENT run is not evidence for this one", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-bind");
    const baseline = baselineFor(repo, "feature-bind", sourceSha, "run-one");
    const landed = landBranch(repo, "feature-bind");
    const stale = item({ key: "AP-20", cwd: repo, runId: "run-two", dispatchClass: "finisher", finisherSource: "feature-bind", finisherBaseline: baseline });

    expect(finisherLandedEvidence(stale, NOW)).toBeNull(); // run 2 did not land this
    // the SAME repo state IS evidence for the run the baseline belongs to
    expect(finisherLandedEvidence({ ...stale, runId: "run-one" }, NOW)?.sha).toBe(landed);
  });

  test("a third party moving the declared cwd is NOT evidence — only the declared source landing is", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-third");
    const dir = dirWith([
      item({
        key: "AP-21",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-third",
        finisherBaseline: baselineFor(repo, "feature-third", sourceSha, "run-fin-1"),
      }),
    ]);
    // somebody else's write to the same checkout while the finisher ran
    // (the shipping lane merging ANOTHER done item, a second finisher, a human)
    commit(repo, "someone-else.txt", "an unrelated commit on main");

    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    const it = read(dir).items["AP-21"];
    expect(it.status).toBe("failed"); // the finisher's own failure stands
    expect(it.landedEvidence ?? null).toBeNull();
    expect(it.overrides ?? []).toEqual([]);
  });

  test("a CHERRY-PICKED landing is evidence — new commits, patch-equivalent to the declared source", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-cp");
    commit(repo, "moved-on.txt", "main advanced, so the branch base is stale"); // why finishers cherry-pick
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([
      item({
        key: "AP-40",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-cp",
        finisherBaseline: baselineFor(repo, "feature-cp", sourceSha, "run-fin-1"),
      }),
    ]);
    const landedSha = cherryPickBranch(repo, "feature-cp"); // the finisher's only output
    expect(landedSha).not.toBe(sourceSha);
    expect(() => g(repo, "merge-base", "--is-ancestor", sourceSha, "HEAD")).toThrow(); // NOT an ancestor

    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    const it = read(dir).items["AP-40"];
    expect(it.status).toBe("ai-review"); // NOT failed
    expect(it.landedEvidence?.sha).toBe(landedSha);
    expect(it.landedEvidence?.fromSha).toBe(baseSha);
    expect(it.landedEvidence?.landing).toBe("patch-equivalent"); // the shape is RECORDED, not implied
    expect(it.overrides?.[0].reason).toContain("patch-equivalent");
    expect(it.notes).toContain("[finisher-landed]");
  });

  test("a CONFLICT-RESOLVED cherry-pick yields NO evidence — the patch changed, so the failure verdict STANDS", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-conflict"); // writes feature-conflict.txt
    // the checkout already has that file with other content → the pick conflicts
    commit(repo, "feature-conflict.txt", "a different line on main");
    const dir = dirWith([
      item({
        key: "AP-41",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-conflict",
        finisherBaseline: baselineFor(repo, "feature-conflict", sourceSha, "run-fin-1"),
      }),
    ]);
    const landedSha = cherryPickWithConflict(repo, "feature-conflict", "feature-conflict.txt", "a hand-merged resolution\n");
    expect(landedSha).not.toBe(g(repo, "rev-parse", "HEAD~1")); // it DID land something

    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    // DECIDED AND DOCUMENTED: resolving a conflict rewrites the patch, so no git
    // predicate can distinguish it from "landed something else". This fails
    // CLOSED — the verdict stands and the operator overrides deliberately
    // (queue_update overrideReason) after verifying the commit.
    const it = read(dir).items["AP-41"];
    expect(it.status).toBe("failed");
    expect(it.landedEvidence ?? null).toBeNull();
    expect(it.overrides ?? []).toEqual([]);
  });

  test("a SQUASH of a SINGLE-commit source is evidence — one commit, one patch, patch-equivalent", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-squash1"); // exactly ONE commit
    commit(repo, "moved-on.txt", "main advanced");
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([
      item({
        key: "AP-43",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-squash1",
        finisherBaseline: baselineFor(repo, "feature-squash1", sourceSha, "run-fin-1"),
      }),
    ]);
    const landedSha = squashBranch(repo, "feature-squash1"); // the finisher's only output
    expect(landedSha).not.toBe(sourceSha);

    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    const it = read(dir).items["AP-43"];
    expect(it.status).toBe("ai-review"); // NOT failed
    expect(it.landedEvidence?.sha).toBe(landedSha);
    expect(it.landedEvidence?.fromSha).toBe(baseSha);
    expect(it.landedEvidence?.landing).toBe("patch-equivalent"); // the shape the five surfaces name
  });

  test("a SQUASH of a MULTI-commit source yields NO evidence — the combined patch matches none of them", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommits(repo, "feature-squashN", ["a.txt", "b.txt"]); // TWO commits
    commit(repo, "moved-on.txt", "main advanced");
    const dir = dirWith([
      item({
        key: "AP-44",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-squashN",
        finisherBaseline: baselineFor(repo, "feature-squashN", sourceSha, "run-fin-1"),
      }),
    ]);
    const landedSha = squashBranch(repo, "feature-squashN");
    expect(landedSha).not.toBe(sourceSha); // it DID land the content

    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    // DECIDED AND DOCUMENTED: patch-id equality cannot settle a combined patch,
    // so this fails CLOSED — the verdict stands and the close-out is the
    // operator's deliberate call.
    const it = read(dir).items["AP-44"];
    expect(it.status).toBe("failed");
    expect(it.landedEvidence ?? null).toBeNull();
    expect(it.overrides ?? []).toEqual([]);
  });

  test("a baseline sourceSha git cannot resolve yields NO evidence — the unanswerable question fails CLOSED", () => {
    // The SAFETY PROPERTY the docs rest on: isAncestor/sourceLandingIn answer
    // `null` when git cannot answer (bad object, unreadable repo, timeout), and
    // null is NEVER read as a yes. Exercised here, not merely asserted in prose.
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-bogus");
    const baseline = baselineFor(repo, "feature-bogus", sourceSha, "run-fin-1");
    landBranch(repo, "feature-bogus"); // a REAL landing: only the bogus sha stops the evidence
    expect(finisherLandedEvidence(item({ key: "AP-45", cwd: repo, dispatchClass: "finisher", finisherSource: "feature-bogus", finisherBaseline: baseline }), NOW)).not.toBeNull();

    const bogus = "cafecafecafecafecafecafecafecafecafecafe"; // resolves to nothing
    expect(() => g(repo, "cat-file", "-e", bogus)).toThrow();
    const dir = dirWith([
      item({
        key: "AP-45",
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-bogus",
        finisherBaseline: { ...baseline, sourceSha: bogus },
      }),
    ]);
    expect(finisherLandedEvidence(read(dir).items["AP-45"], NOW)).toBeNull();

    // …and through the completion path: the runtime's failure verdict stands.
    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);
    const it = read(dir).items["AP-45"];
    expect(it.status).toBe("failed");
    expect(it.landedEvidence ?? null).toBeNull();
    expect(it.overrides ?? []).toEqual([]);
  });

  test("a source CHERRY-PICKED before the dispatch is not evidence — patch-presence is checked at the baseline too", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-cp-old");
    commit(repo, "moved-on.txt", "main advanced");
    cherryPickBranch(repo, "feature-cp-old"); // it landed BEFORE this dispatch
    const baseline = baselineFor(repo, "feature-cp-old", sourceSha, "run-fin-1");
    const it = item({ key: "AP-42", cwd: repo, dispatchClass: "finisher", finisherSource: "feature-cp-old", finisherBaseline: baseline });
    commit(repo, "later.txt", "HEAD keeps moving for other reasons");

    expect(finisherLandedEvidence(it, NOW)).toBeNull();
  });

  test("a source that was ALREADY in at dispatch is not evidence, however far HEAD then moves", () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-already");
    landBranch(repo, "feature-already"); // it landed BEFORE this dispatch
    const baseline = baselineFor(repo, "feature-already", sourceSha, "run-fin-1");
    const it = item({ key: "AP-22", cwd: repo, dispatchClass: "finisher", finisherSource: "feature-already", finisherBaseline: baseline });
    commit(repo, "later.txt", "HEAD keeps moving for other reasons");

    expect(finisherLandedEvidence(it, NOW)).toBeNull();
  });

  test("no declared source → no evidence path at all: the dispatch says so and the run fails as usual", async () => {
    const repo = initRepo();
    const dir = dirWith([item({ key: "AP-23", status: "approved", runId: null, cwd: repo })]);

    const res = await queueDispatch(ctxForDispatch(dir, []), { key: "AP-23", task: "land something", cwd: repo, dispatchClass: "finisher" });
    expect(res.text).toContain("LANDED EVIDENCE IS OFF");
    expect(read(dir).items["AP-23"].finisherBaseline?.sourceSha ?? null).toBeNull();

    commit(repo, "whoever.txt", "a commit from somewhere else");
    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-dispatched"), NOW);
    expect(read(dir).items["AP-23"].status).toBe("failed");
  });
});

// EVERY lane that returns an item to `active` starts a new run, and each one
// must judge that run on its own baseline. The dispatch tool is not the only
// lane: the harness auto-dispatches approved items, re-dispatches after a
// review FAIL, and recovers failed ones.
describe("every re-activation lane rebaselines the finisher", () => {
  function laneBackend(ids: string[]): { backend: SubagentBackend; spawns: string[] } {
    const spawns: string[] = [];
    const backend: SubagentBackend = {
      spawn: async (task) => {
        spawns.push(task);
        return ids[spawns.length - 1] ?? `run-${spawns.length}`;
      },
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req",
      asyncDirFor: () => null,
    };
    return { backend, spawns };
  }

  test("review-FAIL re-dispatch (autoRedispatch): run 1's landing is never run 2's evidence", async () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-rd");
    const dir = dirWith([
      item({
        key: "AP-30",
        cwd: repo,
        runId: "run-one",
        dispatchClass: "finisher",
        finisherSource: "feature-rd",
        finisherBaseline: baselineFor(repo, "feature-rd", sourceSha, "run-one"),
      }),
    ]);
    // run 1 DOES land the merge; the runtime still reports it unsuccessful
    const landed = landBranch(repo, "feature-rd");
    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-one"), NOW);
    expect(read(dir).items["AP-30"].status).toBe("ai-review");
    expect(read(dir).items["AP-30"].landedEvidence?.sha).toBe(landed);

    // the reviewer FAILs → the engine flips ai-review → active, then the
    // harness re-dispatches run 2 with the findings
    mutateStore(dir, (s) => updateItem(s, "AP-30", { status: "active", attempts: 1 }));
    const { backend, spawns } = laneBackend(["run-two"]);
    expect(await autoRedispatch(dir, backend, "AP-30", "findings: the merge is wrong")).toBe(true);
    expect(spawns.length).toBe(1);
    const redispatched = read(dir).items["AP-30"];
    expect(redispatched.landedEvidence ?? null).toBeNull(); // run 1's proof is gone
    expect(redispatched.finisherBaseline).toMatchObject({ sha: landed, runId: "run-two" }); // fresh, bound to run 2

    // run 2 writes NOTHING — it must fail on its own merits
    new Autopilot({ stateDir: dir, now: () => NOW + 1000 }).handleAsyncComplete(failedCompletion("run-two"), NOW + 1000);
    const final = read(dir).items["AP-30"];
    expect(final.status).toBe("failed");
    expect(final.landedEvidence ?? null).toBeNull();
    expect(final.overrides?.length ?? 0).toBe(1); // only run 1's override — nothing fabricated for run 2
  });

  test("recovery re-dispatch is NO LONGER a lane for this class (AUTOPILOT-46): the failed finisher is HELD, so no run of it is ever judged against another run's baseline", async () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-rec");
    const dir = dirWith([
      item({
        key: "AP-31",
        status: "failed",
        failCause: "verdict",
        cwd: repo,
        runId: null,
        dispatchClass: "finisher",
        finisherSource: "feature-rec",
        finisherBaseline: baselineFor(repo, "feature-rec", sourceSha, "run-one"),
        recoveryNotBefore: NOW - 1000, // the backoff HAS elapsed: before the hold this re-dispatched
      }),
    ]);
    const { backend, spawns } = laneBackend(["run-two"]);

    const out = await autoRecoverFails(dir, backend, { now: NOW, backoffMs: 1000 });
    expect(out.recovered).toEqual([]); // no automatic re-run of a merge finisher, ever
    expect(spawns).toEqual([]);
    const held = read(dir).items["AP-31"];
    expect(held.status).toBe("failed");
    // run-one's baseline is left exactly as it was — nothing rebaselined it,
    // because no new run was started to rebaseline for.
    expect(held.finisherBaseline).toMatchObject({ source: "feature-rec", sourceSha, runId: "run-one" });
    expect(held.landedEvidence ?? null).toBeNull();
    expect(held.overrides ?? []).toEqual([]);
  });

  test("harness auto-dispatch (approved → active) rebaselines too", async () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-auto");
    const dir = dirWith([
      item({
        key: "AP-32",
        status: "approved",
        runId: null,
        cwd: repo,
        dispatchClass: "finisher",
        finisherSource: "feature-auto",
        finisherBaseline: baselineFor(repo, "feature-auto", sourceSha, "run-one"),
      }),
    ]);
    const landed = landBranch(repo, "feature-auto"); // the PREVIOUS run's landing
    const { backend } = laneBackend(["run-two"]);

    const dispatched = await autoDispatchEligible(dir, backend, 3);
    expect(dispatched.map((d) => d.key)).toEqual(["AP-32"]);
    const it = read(dir).items["AP-32"];
    expect(it.finisherBaseline).toMatchObject({ sha: landed, runId: "run-two" });

    // the new run lands nothing → no evidence from the old landing
    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-two"), NOW);
    expect(read(dir).items["AP-32"].status).toBe("failed");
    expect(read(dir).items["AP-32"].landedEvidence ?? null).toBeNull();
  });
});

describe("auto-recovery — landed work is never re-dispatched", () => {
  function recordingBackend(): { backend: SubagentBackend; spawns: string[] } {
    const spawns: string[] = [];
    const backend: SubagentBackend = {
      spawn: async (task) => {
        spawns.push(task);
        return `run-${spawns.length}`;
      },
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req",
      asyncDirFor: () => null,
    };
    return { backend, spawns };
  }

  test("a failed finisher whose work LANDED is skipped, recorded and surfaced once — never re-dispatched", async () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-6");
    const dir = dirWith([
      item({
        key: "AP-6",
        status: "failed",
        failCause: "verdict",
        cwd: repo,
        runId: "run-fin-1",
        dispatchClass: "finisher",
        finisherSource: "feature-6",
        finisherBaseline: baselineFor(repo, "feature-6", sourceSha, "run-fin-1"),
        recoveryNotBefore: NOW - 1000, // backoff already elapsed: without the evidence check this WOULD re-dispatch
      }),
    ]);
    const landedSha = landBranch(repo, "feature-6");
    const { backend, spawns } = recordingBackend();

    const first = await autoRecoverFails(dir, backend, { now: NOW, backoffMs: 1000 });
    expect(spawns).toEqual([]);
    expect(first.recovered).toEqual([]);
    expect(first.landedSkipped).toEqual([{ key: "AP-6", repo, sha: landedSha, surfaced: true }]);
    const it = read(dir).items["AP-6"];
    expect(it.status).toBe("failed"); // stays failed for the human's close-out call
    expect(it.landedEvidence?.sha).toBe(landedSha);
    expect(it.overrides?.length).toBe(1);
    expect(it.notes).toContain("[recover-skip: landed]");

    // …and it is announced ONCE: the next pass still skips, without re-surfacing
    const second = await autoRecoverFails(dir, backend, { now: NOW + 5_000, backoffMs: 1000 });
    expect(spawns).toEqual([]);
    expect(second.landedSkipped).toEqual([{ key: "AP-6", repo, sha: landedSha, surfaced: false }]);
    expect(read(dir).items["AP-6"].overrides?.length).toBe(1);
  });

  // AUTOPILOT-46. The evidence check only skips landings it can SEE. A
  // CONFLICT-RESOLVED cherry-pick (and a multi-commit squash) leaves none by
  // design — so before the hold, the item fell through as an ordinary verdict
  // failure and auto-recovery RE-DISPATCHED it once the backoff elapsed,
  // re-running a merge that had already landed, before the operator could
  // close it out. The whole class is held instead.
  test("a failed finisher whose landing is UNDETECTABLE is not re-dispatched — it is held and surfaced once", async () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-conflict-rec"); // writes feature-conflict-rec.txt
    commit(repo, "feature-conflict-rec.txt", "a different line on main"); // so the pick conflicts
    const dir = dirWith([
      item({
        key: "AP-7",
        status: "failed",
        failCause: "verdict",
        cwd: repo,
        runId: null,
        dispatchClass: "finisher",
        finisherSource: "feature-conflict-rec",
        finisherBaseline: baselineFor(repo, "feature-conflict-rec", sourceSha, "run-fin-1"),
        recoveryNotBefore: NOW - 1000, // the backoff HAS elapsed
      }),
    ]);
    // the finisher DID land the work — with a hand-resolved conflict, so the
    // patch changed and no git predicate can evidence it
    const landedSha = cherryPickWithConflict(repo, "feature-conflict-rec", "feature-conflict-rec.txt", "a hand-merged resolution\n");
    const { backend, spawns } = recordingBackend();

    const out = await autoRecoverFails(dir, backend, { now: NOW, backoffMs: 1000 });

    expect(spawns).toEqual([]); // the merge is NOT re-run
    expect(out.recovered).toEqual([]);
    expect(out.landedSkipped).toEqual([]); // no evidence — this is the hold, not the evidence skip
    expect(out.finisherHeld).toEqual([{ key: "AP-7", cause: "verdict", attempts: 0, surfaced: true }]);
    const it = read(dir).items["AP-7"];
    expect(it.status).toBe("failed"); // the verdict stands — the operator closes it out
    expect(it.recoveryEscalated).toBe(true);
    expect(it.notes).toContain("[recover-hold: finisher]");
    expect(g(repo, "rev-parse", "HEAD")).toBe(landedSha); // nothing touched the checkout

    // announced ONCE: the next pass still holds, without re-surfacing
    const second = await autoRecoverFails(dir, backend, { now: NOW + 5_000, backoffMs: 1000 });
    expect(second.finisherHeld).toEqual([{ key: "AP-7", cause: "verdict", attempts: 0, surfaced: false }]);
    expect(spawns).toEqual([]);
    expect(read(dir).items["AP-7"].notes.match(/recover-hold: finisher/g)?.length).toBe(1);
  });
});

describe("the dispatch declares the class, and the override record persists", () => {
  test("queue_dispatch with dispatchClass=finisher records the class, the source and the cwd's HEAD baseline", async () => {
    const repo = initRepo();
    const sourceSha = branchWithCommit(repo, "feature-8");
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([item({ key: "AP-8", status: "approved", runId: null, cwd: repo })]);
    const spawns: string[] = [];

    const res = await queueDispatch(ctxForDispatch(dir, spawns), {
      key: "AP-8",
      task: "land AP-4",
      cwd: repo,
      dispatchClass: "finisher",
      finisherSource: "feature-8",
    });

    expect(res.details.dispatchClass).toBe("finisher");
    expect(res.text).toContain("FINISHER-CLASS");
    const it = read(dir).items["AP-8"];
    expect(it.status).toBe("active");
    expect(it.dispatchClass).toBe("finisher");
    expect(it.finisherSource).toBe("feature-8");
    expect(it.finisherBaseline).toMatchObject({ repo, ref: "main", sha: baseSha, source: "feature-8", sourceSha, runId: "run-dispatched" });

    // the item's recorded source rides along when a later dispatch omits it
    mutateStore(dir, (s) => updateItem(s, "AP-8", { status: "failed" }));
    await queueDispatch(ctxForDispatch(dir, spawns), { key: "AP-8", task: "re-run", cwd: repo, dispatchClass: "finisher" });
    expect(read(dir).items["AP-8"].finisherBaseline?.sourceSha).toBe(sourceSha);
  });

  test("queue_update records an orchestrator override on the item, and it survives a store round-trip", async () => {
    const repo = initRepo();
    const dir = dirWith([item({ key: "AP-9", status: "failed", failCause: "verdict", cwd: repo, runId: null, notes: "prior" })]);

    const res = await queueUpdate(ctxForDispatch(dir, []), {
      key: "AP-9",
      status: "done",
      overrideReason: "the merge landed on main (a0fe5a1); the runtime's no-edits verdict does not apply to a finisher",
    });
    expect(res.text).toContain("OVERRIDE recorded");

    // round-trip: the record is store state, not tool-local memory
    const reloaded = read(dir).items["AP-9"];
    expect(reloaded.status).toBe("done");
    expect(reloaded.overrides?.length).toBe(1);
    expect(reloaded.overrides?.[0].by).toBe("orchestrator");
    expect(reloaded.overrides?.[0].reason).toContain("finisher");
    expect(reloaded.notes).toContain("prior");
    expect(reloaded.notes).toContain("[override]");

    // a SECOND override appends (the pattern is what makes overrides visible)
    await queueUpdate(ctxForDispatch(dir, []), { key: "AP-9", overrideReason: "second call" });
    const again = read(dir).items["AP-9"];
    expect(again.overrides?.map((o) => o.reason)).toEqual([
      "the merge landed on main (a0fe5a1); the runtime's no-edits verdict does not apply to a finisher",
      "second call",
    ]);
  });
});
