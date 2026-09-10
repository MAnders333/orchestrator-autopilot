// test/finisher-evidence.test.ts — AUTOPILOT-34. A MERGE FINISHER writes into
// the target repo's CHECKOUT (its declared cwd) and leaves its own worktree
// untouched by design, so the runtime's "no edits in the worktree" heuristic
// always misreports the class whose success matters most (observed live:
// AUTOPILOT-33 landing AUTOPILOT-24 — merge landed, suite green, run reported
// as "returned planning or scratchpad output" and marked FAILED). A false
// failure is not cosmetic: auto-recovery treats `failed` as a re-dispatch
// candidate, so it can re-run a merge that already landed.
//
// Pinned here: (1) a finisher-class run whose declared cwd's HEAD MOVED is NOT
// failed — the verdict is overridden and the override RECORDED; (2) a run that
// moved nothing IS failed (finisher and plain worker alike — the real
// "wrote a plan and stopped" case still lands); (3) auto-recovery never
// re-dispatches an item with landed evidence; (4) the override record survives
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
  type QueueItem,
  type QueueStore,
} from "../src/queue-store.ts";
import { captureFinisherBaseline, finisherLandedEvidence, readRepoHead } from "../src/finisher-evidence.ts";
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

describe("finisher-class evidence — a HEAD move in the declared cwd is the success proof", () => {
  test("a finisher-class run whose declared cwd's HEAD MOVED is NOT failed; the verdict is overridden and RECORDED", () => {
    const repo = initRepo();
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([
      item({
        key: "AP-1",
        cwd: repo,
        dispatchClass: "finisher",
        finisherBaseline: { repo, ref: "main", sha: baseSha, runId: "run-fin-1", at: new Date(NOW - 60_000).toISOString() },
      }),
    ]);
    // the finisher's ONLY output: a commit in the target repo's checkout
    const landedSha = commit(repo, "shipped.txt", "cherry-picked the approved branch");

    const res = new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-fin-1"), NOW);

    const it = read(dir).items["AP-1"];
    expect(it.status).toBe("ai-review"); // NOT failed
    expect(it.landedEvidence?.sha).toBe(landedSha);
    expect(it.landedEvidence?.fromSha).toBe(baseSha);
    expect(it.failCause ?? null).toBeNull();
    // the override is a RECORD, not folklore in notes
    expect(it.overrides?.length).toBe(1);
    expect(it.overrides?.[0].by).toBe("framework");
    expect(it.overrides?.[0].runId).toBe("run-fin-1");
    expect(it.overrides?.[0].evidence?.sha).toBe(landedSha);
    expect(it.notes).toContain("[finisher-landed]");
    // and the operator is told, because the runtime just said "failed"
    expect(res.flipped).toBe(true);
    expect(res.tick?.facts.failureOverridden).toBe(true);
    expect(res.tick?.message).toContain("OVERRIDDEN");
    expect(res.domainEvents.some((e) => e.name === "orch:failure-overridden")).toBe(true);
  });

  test("a finisher whose declared cwd did NOT move IS failed — the plan-only case still lands", () => {
    const repo = initRepo();
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([
      item({
        key: "AP-2",
        cwd: repo,
        dispatchClass: "finisher",
        finisherBaseline: { repo, ref: "main", sha: baseSha, runId: "run-fin-1", at: new Date(NOW - 60_000).toISOString() },
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
    const recorded = { repo, ref: "main", fromSha: baseSha, sha: "deadbeefdeadbeef", runId: "run-old", at: "2026-01-01T00:00:00.000Z" };
    const withRecord = item({ key: "AP-4", cwd: repo, dispatchClass: "finisher", landedEvidence: recorded });
    expect(finisherLandedEvidence(withRecord, NOW)).toEqual(recorded);
    // finisher without a baseline: nothing to compare against → no evidence
    expect(finisherLandedEvidence(item({ key: "AP-5", cwd: repo, dispatchClass: "finisher" }), NOW)).toBeNull();
  });

  test("a re-dispatch drops the previous run's landed evidence — the new run is judged on its own", async () => {
    const repo = initRepo();
    const baseSha = g(repo, "rev-parse", "HEAD");
    const landed = commit(repo, "shipped.txt", "the previous finisher's merge");
    const dir = dirWith([
      item({
        key: "AP-10",
        status: "failed",
        failCause: "verdict",
        cwd: repo,
        runId: null,
        dispatchClass: "finisher",
        finisherBaseline: { repo, ref: "main", sha: baseSha, runId: "run-old", at: new Date(NOW - 60_000).toISOString() },
        landedEvidence: { repo, ref: "main", fromSha: baseSha, sha: landed, runId: "run-old", at: new Date(NOW - 60_000).toISOString() },
      }),
    ]);
    const spawns: string[] = [];

    await queueDispatch(ctxForDispatch(dir, spawns), { key: "AP-10", task: "re-run the finisher", cwd: repo, dispatchClass: "finisher" });
    const redispatched = read(dir).items["AP-10"];
    expect(redispatched.landedEvidence ?? null).toBeNull(); // stale proof cleared
    expect(redispatched.finisherBaseline?.sha).toBe(landed); // fresh baseline = the CURRENT head

    // the new run writes nothing → it fails, exactly like the plan-only case
    new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete(failedCompletion("run-dispatched"), NOW);
    expect(read(dir).items["AP-10"].status).toBe("failed");
  });

  test("captureFinisherBaseline/readRepoHead read the declared cwd's real HEAD", () => {
    const repo = initRepo();
    const head = readRepoHead(repo);
    expect(head?.sha).toBe(g(repo, "rev-parse", "HEAD"));
    expect(head?.ref).toBe("main");
    const baseline = captureFinisherBaseline(repo, "run-x", NOW);
    expect(baseline).toMatchObject({ repo, ref: "main", sha: head?.sha, runId: "run-x" });
    expect(readRepoHead(mkdtempSync(join(tmpdir(), "orch-not-a-repo-")))).toBeNull();
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
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([
      item({
        key: "AP-6",
        status: "failed",
        failCause: "verdict",
        cwd: repo,
        runId: "run-fin-1",
        dispatchClass: "finisher",
        finisherBaseline: { repo, ref: "main", sha: baseSha, runId: "run-fin-1", at: new Date(NOW - 60_000).toISOString() },
        recoveryNotBefore: NOW - 1000, // backoff already elapsed: without the evidence check this WOULD re-dispatch
      }),
    ]);
    const landedSha = commit(repo, "shipped.txt", "the merge that already landed");
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

  test("a failed finisher with NO landed evidence still recovers normally", async () => {
    const repo = initRepo();
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([
      item({
        key: "AP-7",
        status: "failed",
        failCause: "verdict",
        cwd: repo,
        dispatchClass: "finisher",
        finisherBaseline: { repo, ref: "main", sha: baseSha, runId: "run-fin-1", at: new Date(NOW - 60_000).toISOString() },
        recoveryNotBefore: NOW - 1000,
      }),
    ]);
    const { backend, spawns } = recordingBackend();

    const out = await autoRecoverFails(dir, backend, { now: NOW, backoffMs: 1000 });
    expect(spawns.length).toBe(1);
    expect(out.recovered.map((r) => r.key)).toEqual(["AP-7"]);
    expect(out.landedSkipped).toEqual([]);
  });
});

describe("the dispatch declares the class, and the override record persists", () => {
  test("queue_dispatch with dispatchClass=finisher records the class + the cwd's HEAD baseline", async () => {
    const repo = initRepo();
    const baseSha = g(repo, "rev-parse", "HEAD");
    const dir = dirWith([item({ key: "AP-8", status: "approved", runId: null, cwd: repo })]);
    const spawns: string[] = [];

    const res = await queueDispatch(ctxForDispatch(dir, spawns), { key: "AP-8", task: "land AP-4", cwd: repo, dispatchClass: "finisher" });

    expect(res.details.dispatchClass).toBe("finisher");
    expect(res.text).toContain("FINISHER-CLASS");
    const it = read(dir).items["AP-8"];
    expect(it.status).toBe("active");
    expect(it.dispatchClass).toBe("finisher");
    expect(it.finisherBaseline).toMatchObject({ repo, ref: "main", sha: baseSha, runId: "run-dispatched" });
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
