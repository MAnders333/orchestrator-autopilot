// test/framework/worktree-preservation.test.ts — the worktree HANDOFF
// preservation tests (KEY: AUTOPILOT-WORKTREE-PRESERVATION, fix 1). The
// runtime deletes a worker's managed worktree AND its pi-parallel-* branch at
// run end — success AND failure/timeout — before any completion event reaches
// this framework, so committed-but-unpushed branches became dangling objects
// (three live incidents needed `git fsck` rescue; deletion cannot be
// intercepted, only pre-empted). These tests use TEMP REAL REPOS to prove:
//   - success path: tips journaled + keep-ref written BEFORE a simulated
//     `git branch -D` → commits stay reachable;
//   - failure/timeout path (zombie reconciliation sweep): same guarantee;
//   - transition-timed capture: commits landing AFTER the last sweep are
//     still captured by the completion-flip capture;
//   - retention: keep refs die when the item goes terminal OR the tip
//     becomes reachable from main — never while failed/blocked.
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { loadAutopilotConfig } from "../../src/config.ts";
import { newStore, addItem, saveStore, loadStore, loadStoreOrNew } from "../../src/queue-store.ts";
import { createFrameworkRunner } from "../../src/framework/runner.ts";
import { queueDispatch, type QueueOpsCtx } from "../../src/tools/queue-ops.ts";
import {
  preserveRunWorktree,
  preserveActiveItems,
  prunePreservedRefs,
  parallelBranches,
  keepRefFor,
  handoffsLogPath,
  reviewPointersFor,
  webUrlForCommit,
  deliverablePathsFor,
  runWorktreePath,
  recordActiveWorktrees,
} from "../../src/framework/worktree-preservation.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Like g(), but a missing ref resolves to "" instead of throwing (rev-parse
 *  --verify --quiet exits non-zero when the ref is absent — exactly the case
 *  the retention assertions probe for). */
function refSha(repo: string, ref: string): string {
  try {
    return g(repo, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
}

/** Bounded wait for an async condition — the runner's onTimer() fires its
 *  sweep with `void`, so callers cannot await it directly. */
async function waitFor(desc: string, probe: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function initRepo(dir?: string): string {
  const repo = dir ?? mkdtempSync(join(tmpdir(), "orch-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.email", "test@test");
  g(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** Simulate the worker's committed-but-unpushed branch + returns the tip. */
function makeParallelBranch(repo: string, runId: string, file: string, message: string): string {
  g(repo, "checkout", "-q", "-b", `pi-parallel-${runId}-0`);
  writeFileSync(join(repo, file), `${message}\n`);
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", message);
  const tip = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "main");
  return tip;
}

function commitOnBranch(repo: string, branch: string, file: string, message: string): string {
  g(repo, "checkout", "-q", branch);
  writeFileSync(join(repo, file), `${message}\n`);
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", message);
  const tip = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "main");
  return tip;
}

function journal(stateDir: string): Array<Record<string, string>> {
  const p = handoffsLogPath(stateDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The incident's kill step: what pi-subagents does after every run. */
function simulateRuntimeCleanup(repo: string, runId: string): void {
  for (const b of parallelBranches(repo, runId)) g(repo, "branch", "-D", b);
}

function commitsSurvive(repo: string, runId: string, expectedTip: string): boolean {
  try {
    // the durable ref resolves to the expected tip …
    if (g(repo, "rev-parse", "--verify", `${keepRefFor(runId)}^{commit}`) !== expectedTip) return false;
    // … so the commit object is reachable and survives gc
    g(repo, "cat-file", "-e", `${expectedTip}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

const backendIdle: SubagentBackend = {
  spawn: async () => "unused",
  fleetStatus: async () => ({ totalActive: 0 }),
  steer: async () => "req-1",
  asyncDirFor: () => null,
};

// AUTOPILOT-47 C: keep refs save COMMITTED work. A reaped run's UNCOMMITTED
// changes live only in its worktree DIRECTORY, and nothing recorded which one —
// today's salvage matched run ids to pi-worktree-* paths by hand.
describe("worktree path recording — post-mortem salvage without archaeology", () => {
  test("runWorktreePath resolves the directory holding the run's pi-parallel branch", () => {
    const repo = initRepo();
    const runId = "run-wtpath-1";
    makeParallelBranch(repo, runId, "work.txt", "partial");
    const wt = mkdtempSync(join(tmpdir(), "orch-pi-worktree-"));
    rmSync(wt, { recursive: true, force: true }); // git demands a non-existent path
    g(repo, "worktree", "add", "-q", wt, `pi-parallel-${runId}-0`);
    try {
      expect(runWorktreePath(repo, runId)).toMatchObject({ branch: `pi-parallel-${runId}-0` });
      // realpath: macOS tmpdir is a /var → /private/var symlink
      expect(runWorktreePath(repo, runId)!.path).toContain("orch-pi-worktree-");
      expect(runWorktreePath(repo, "run-that-never-ran")).toBeNull();
    } finally {
      g(repo, "worktree", "remove", "--force", wt);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("recordActiveWorktrees writes the path onto the ACTIVE item (and only for its current run)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-state-"));
    const repo = initRepo();
    const runId = "run-wtpath-2";
    makeParallelBranch(repo, runId, "work.txt", "partial");
    const wt = mkdtempSync(join(tmpdir(), "orch-pi-worktree-"));
    rmSync(wt, { recursive: true, force: true });
    g(repo, "worktree", "add", "-q", wt, `pi-parallel-${runId}-0`);
    const store = newStore();
    addItem(store, { key: "K-WT", title: "k", status: "active", blocker: null, scope: "s", cwd: repo, evidence: "", value: "", urgency: "", risk: "low", runId, reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    addItem(store, { key: "K-IDLE", title: "k2", status: "approved", blocker: null, scope: "s", cwd: repo, evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    saveStore(stateDir, store);
    try {
      const recorded = recordActiveWorktrees(stateDir);
      expect(recorded.map((r) => r.key)).toEqual(["K-WT"]);
      const after = loadStore(stateDir)!;
      expect(after.items["K-WT"].runWorktree).toMatchObject({ runId, branch: `pi-parallel-${runId}-0` });
      expect(after.items["K-IDLE"].runWorktree ?? null).toBeNull();
      // idempotent — a second pass finds nothing new to write
      expect(recordActiveWorktrees(stateDir)).toEqual([]);
    } finally {
      g(repo, "worktree", "remove", "--force", wt);
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a run with no worktree records nothing — no invented path", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-state-"));
    const repo = initRepo();
    const store = newStore();
    addItem(store, { key: "K-NOWT", title: "k", status: "active", blocker: null, scope: "s", cwd: repo, evidence: "", value: "", urgency: "", risk: "low", runId: "run-no-worktree", reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    saveStore(stateDir, store);
    try {
      expect(recordActiveWorktrees(stateDir)).toEqual([]);
      expect(loadStore(stateDir)!.items["K-NOWT"].runWorktree ?? null).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("worktree preservation — module (success-path mechanics)", () => {
  test("a committed-but-unpushed parallel branch survives simulated runtime cleanup", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-state-"));
    const repo = initRepo();
    const runId = "run-success-1";
    const tip = makeParallelBranch(repo, runId, "feature.txt", "the actual work");

    const entries = preserveRunWorktree({ stateDir, repo, runId, key: "K-SUCCESS" });
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ runId, key: "K-SUCCESS", branch: `pi-parallel-${runId}-0`, tipSha: tip });
    expect(journal(stateDir)[0].tipSha).toBe(tip);

    simulateRuntimeCleanup(repo, runId); // branch -D — the historical data-loss point
    expect(parallelBranches(repo, runId)).toEqual([]);
    expect(commitsSurvive(repo, runId, tip)).toBe(true);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("same tip twice → one journal line; an advanced tip updates ref + journals again", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-state-"));
    const repo = initRepo();
    const runId = "run-dedup-1";
    const tip1 = makeParallelBranch(repo, runId, "a.txt", "work v1");
    preserveRunWorktree({ stateDir, repo, runId, key: "K-D" });
    preserveRunWorktree({ stateDir, repo, runId, key: "K-D" }); // no-op — unchanged tip
    expect(journal(stateDir).filter((e) => e.runId === runId).length).toBe(1);

    const tip2 = commitOnBranch(repo, `pi-parallel-${runId}-0`, "b.txt", "work v2");
    const entries = preserveRunWorktree({ stateDir, repo, runId, key: "K-D" });
    expect(entries.map((e) => e.tipSha)).toEqual([tip2]);
    expect(journal(stateDir).filter((e) => e.runId === runId).map((e) => e.tipSha)).toEqual([tip1, tip2]);
    expect(commitsSurvive(repo, runId, tip2)).toBe(true);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("no parallel branch / not a repo → silent no-op", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-state-"));
    const repo = initRepo(); // no parallel branches yet
    expect(preserveRunWorktree({ stateDir, repo, runId: "run-none", key: "K-NONE" })).toEqual([]);
    expect(existsSync(handoffsLogPath(stateDir))).toBe(false);
    expect(preserveActiveItems(mkdtempSync(join(tmpdir(), "orch-wt-empty-")))).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("preserveActiveItems scans ACTIVE items only", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-state-"));
    const store = newStore();
    addItem(store, { key: "A-ACT", title: "", status: "active", blocker: null, scope: "", cwd: null, evidence: "", value: "", urgency: "", risk: "", runId: null, reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    saveStore(stateDir, store);
    const repo = initRepo();
    const tip = makeParallelBranch(repo, "run-active-1", "w.txt", "active work");
    // wire the item to the repo via updateItem-shaped patch (status stays active)
    const s2 = loadStore(stateDir)!;
    Object.assign(s2.items["A-ACT"], { cwd: repo, runId: "run-active-1" });
    saveStore(stateDir, s2);
    const entries = preserveActiveItems(stateDir);
    expect(entries.map((e) => e.tipSha)).toEqual([tip]);

    // reviewing items are NOT re-scanned (their capture happened at the flip)
    const s3 = loadStore(stateDir)!;
    s3.items["A-ACT"].status = "ai-review";
    saveStore(stateDir, s3);
    const tip2 = commitOnBranch(repo, `pi-parallel-run-active-1-0`, "w2.txt", "post-flip work");
    expect(preserveActiveItems(stateDir)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("worktree preservation — retention (keep refs do not accumulate)", () => {
  function setupWithRef(opts: { status: string; mergeToMain?: boolean }): { stateDir: string; repo: string; runId: string } {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-state-"));
    const repo = initRepo();
    const runId = `run-ret-${opts.status}`;
    const tip = makeParallelBranch(repo, runId, "f.txt", "preserved work");
    if (opts.mergeToMain) {
      g(repo, "merge", "-q", "--no-ff", `-m`, "merge the work", `pi-parallel-${runId}-0`);
    }
    const store = newStore();
    addItem(store, { key: "K-RET", title: "", status: "active", blocker: null, scope: "", cwd: repo, evidence: "", value: "", urgency: "", risk: "", runId, reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    saveStore(stateDir, store);
    preserveRunWorktree({ stateDir, repo, runId, key: "K-RET" });
    const s = loadStore(stateDir)!;
    s.items["K-RET"].status = opts.status as never;
    saveStore(stateDir, s);
    return { stateDir, repo, runId };
  }

  test("terminal item (done) → ref deleted; second prune is idempotent", () => {
    const { stateDir, repo, runId } = setupWithRef({ status: "done" });
    const deleted = prunePreservedRefs(stateDir);
    expect(deleted).toContain(keepRefFor(runId));
    expect(refSha(repo, keepRefFor(runId))).toBe("");
    expect(prunePreservedRefs(stateDir)).toContain(keepRefFor(runId)); // already gone — idempotent report
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("rejected item → ref deleted", () => {
    const { stateDir, repo, runId } = setupWithRef({ status: "rejected" });
    expect(prunePreservedRefs(stateDir)).toContain(keepRefFor(runId));
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("failed item with UNMERGED tip → ref KEPT (recovery may need the commits)", () => {
    const { stateDir, repo, runId } = setupWithRef({ status: "failed" });
    expect(prunePreservedRefs(stateDir)).not.toContain(keepRefFor(runId));
    expect(g(repo, "rev-parse", "--verify", `${keepRefFor(runId)}^{commit}`)).not.toBe("");
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("tip reachable from local main → ref deleted even while the item is active", () => {
    const { stateDir, repo, runId } = setupWithRef({ status: "active", mergeToMain: true });
    expect(prunePreservedRefs(stateDir)).toContain(keepRefFor(runId));
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("worktree preservation — runner wiring (failure/timeout + transition paths)", () => {
  test("timer sweep captures a zombie's last tip BEFORE flipping it to failed; cleanup then loses nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-runner-"));
    const repo = initRepo();
    const runId = "run-zombie-9";
    const tip = makeParallelBranch(repo, runId, "late.txt", "committed right before the timeout kill");
    const store = newStore();
    addItem(store, {
      key: "K-ZOMBIE",
      title: "",
      status: "active",
      blocker: null,
      scope: "s",
      cwd: repo,
      evidence: "",
      value: "",
      urgency: "",
      risk: "low",
      runId,
      reviewerRunId: null,
      timeoutMs: null,
      attempts: 0,
      notes: "",
    });
    saveStore(stateDir, store);
    // Backdate AFTER addItem — addItem stamps updatedAt=now itself (the spread
    // order overwrites any literal), and the zombie grace keys off updatedAt.
    const backdated = loadStore(stateDir)!;
    backdated.items["K-ZOMBIE"].updatedAt = new Date(Date.now() - 3600_000).toISOString(); // idle past the zombie grace
    saveStore(stateDir, backdated);

    const autopilot = new Autopilot({ stateDir });
    const runner = createFrameworkRunner({
      stateDir,
      autopilot,
      backend: backendIdle, // fleet reports ZERO active runs → zombie by definition
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: () => {},
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    await runner.onTimer();
    // onTimer fires its sweep with `void` — it cannot be awaited directly, and
    // a fixed sleep races the git subprocesses preservation shells out to. Wait
    // for the zombie flip (the sweep's last relevant stage) instead; the
    // journal capture is guaranteed to precede it in the same sweep.
    await waitFor("zombie flip to failed", () => loadStore(stateDir)?.items["K-ZOMBIE"].status === "failed");

    // captured BEFORE the flip …
    expect(journal(stateDir).some((e) => e.runId === runId && e.tipSha === tip)).toBe(true);
    // … and the zombie net flipped it with its evidence intact
    const after = loadStore(stateDir)!;
    expect(after.items["K-ZOMBIE"].status).toBe("failed");
    expect(after.items["K-ZOMBIE"].notes).toContain("zombie reconciliation");

    simulateRuntimeCleanup(repo, runId); // the runtime already deleted it in real life — same shape
    expect(commitsSurvive(repo, runId, tip)).toBe(true);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("completion-flip capture records commits that landed AFTER the last sweep", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-runner-"));
    const repo = initRepo();
    const runId = "run-late-commit-1";
    const tip1 = makeParallelBranch(repo, runId, "early.txt", "captured by the last sweep");
    const store = newStore();
    addItem(store, { key: "K-LATE", title: "", status: "active", blocker: null, scope: "s", cwd: repo, evidence: "", value: "", urgency: "", risk: "low", runId, reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    saveStore(stateDir, store);
    const autopilot = new Autopilot({ stateDir });
    const runner = createFrameworkRunner({
      stateDir,
      autopilot,
      backend: backendIdle,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: () => {},
      enabled: () => true,
      sweepIntervalMs: 0,
    });

    preserveActiveItems(stateDir); // the LAST SWEEP before the kill
    const tip2 = commitOnBranch(repo, `pi-parallel-${runId}-0`, "late.txt", "committed after the sweep, before the kill");

    runner.onCompletion({ runId, agent: "worker", success: true } as never); // the transition capture
    const tips = journal(stateDir).filter((e) => e.runId === runId).map((e) => e.tipSha);
    expect(tips).toEqual([tip1, tip2]); // both generations journaled
    expect(commitsSurvive(repo, runId, tip2)).toBe(true); // the ref holds the LATEST tip

    simulateRuntimeCleanup(repo, runId);
    expect(g(repo, "cat-file", "-e", `${tip1}^{commit}`)); // tip1 survives transitively (tip2 descends from it)
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("dispatch-recorded capture wires preservation on at dispatch time", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-wt-dispatch-"));
    const repo = initRepo();
    const runId = "run-dispatch-7";
    const tip = makeParallelBranch(repo, runId, "pre.txt", "existing branch work"); // re-dispatch onto a live branch
    const store = newStore();
    addItem(store, { key: "K-DISP", title: "", status: "approved", blocker: null, scope: "s", cwd: repo, evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    saveStore(stateDir, store);
    const spawnBackend: SubagentBackend = {
      spawn: async () => runId,
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req-1",
      asyncDirFor: () => null,
    };
    const ctx = {
      stateDir,
      backend: spawnBackend,
      storeOrNew: () => loadStoreOrNew(stateDir),
      autopilot: () => new Autopilot({ stateDir }),
      cfg: () => loadAutopilotConfig(stateDir),
      emit: () => {},
      repoCheck: async () => ({ ok: true }),
      sessionCwd: tmpdir(),
    } as unknown as QueueOpsCtx;
    await queueDispatch(ctx, { key: "K-DISP", task: "KEY: K-DISP\nredo", cwd: repo });
    expect(journal(stateDir).map((e) => e.tipSha)).toContain(tip);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("reviewPointersFor: latest journaled tip per branch for the item's key", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ptr-"));
    const repo = mkdtempSync(join(tmpdir(), "orch-ptr-repo-"));
    try {
      g(repo, "init", "-q", "-b", "main");
      g(repo, "config", "user.email", "t@t");
      g(repo, "config", "user.name", "t");
      g(repo, "commit", "--allow-empty", "-m", "base");
      g(repo, "branch", "pi-parallel-run1-0");
      const tip1 = g(repo, "rev-parse", "pi-parallel-run1-0");
      // journal two entries for the same key — the NEWEST tip must win
      appendFileSync(join(stateDir, "handoffs.jsonl"),
        `${JSON.stringify({ runId: "run1", key: "K-PTR", branch: "pi-parallel-run1-0", tipSha: tip1, ts: "2026-08-23T10:00:00Z" })}\n` +
        `${JSON.stringify({ runId: "run2", key: "OTHER-KEY", branch: "pi-parallel-run2-0", tipSha: "cafe123", ts: "2026-08-23T11:00:00Z" })}\n`);
      const ptrs = reviewPointersFor(stateDir, "K-PTR");
      expect(ptrs).toEqual([{ branch: "pi-parallel-run1-0", tipSha: tip1 }]); // OTHER-KEY filtered out
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("deliverablePathsFor: changed files vs main, docs first, capped — the document deliverable IS the pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-doc-"));
    try {
      g(dir, "init", "-q", "-b", "main");
      g(dir, "config", "user.email", "t@t");
      g(dir, "config", "user.name", "t");
      writeFileSync(join(dir, "base.txt"), "base\n");
      g(dir, "add", ".");
      g(dir, "commit", "-m", "base");
      g(dir, "branch", "pi-parallel-docrun-0");
      g(dir, "checkout", "-q", "pi-parallel-docrun-0");
      mkdirSync(join(dir, "docs"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "docs", "findings.md"), "# findings\n");
      writeFileSync(join(dir, "src", "impl.ts"), "export {}\n");
      g(dir, "add", ".");
      g(dir, "commit", "-m", "deliverable");
      const tip = g(dir, "rev-parse", "HEAD");
      const files = deliverablePathsFor(dir, tip);
      expect(files).toEqual(["docs/findings.md", "src/impl.ts"]); // doc first — it is the deliverable
      expect(files![0]).toContain("findings.md");
      // cap: a flood of files truncates
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(dir, `f${i}.txt`), "x\n");
      }
      g(dir, "add", ".");
      g(dir, "commit", "-m", "flood");
      expect(deliverablePathsFor(dir, g(dir, "rev-parse", "HEAD"))!.length).toBeLessThanOrEqual(6);
      expect(deliverablePathsFor(dir, "nonexistent-sha")).toBeNull(); // best-effort: git failure → null
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("webUrlForCommit: structural parsing — forges transform, layouts that would break bail to local pointers", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-web-"));
    try {
      g(dir, "init", "-q");
      const withRemote = (remote: string | null): string | null => {
        try { g(dir, "remote", "remove", "origin"); } catch { /* none yet */ }
        if (remote) g(dir, "remote", "add", "origin", remote);
        return webUrlForCommit(dir, "abc1234");
      };
      expect(withRemote("git@github.com:o/r.git")).toBe("https://github.com/o/r/commit/abc1234");
      expect(withRemote("https://github.com/o/r")).toBe("https://github.com/o/r/commit/abc1234");
      expect(withRemote("https://gitlab.com/group/sub/repo.git")).toBe("https://gitlab.com/group/sub/repo/commit/abc1234"); // nested subgroups
      expect(withRemote("https://git.sr.ht/~user/repo")).toBe("https://git.sr.ht/~user/repo/commit/abc1234"); // tilde owner
      expect(withRemote("git@corp-gitea.local:team/proj.git")).toBe("https://corp-gitea.local/team/proj/commit/abc1234"); // self-hosted, dot-less host
      expect(withRemote("https://bitbucket.org/team/proj.git")).toBe("https://bitbucket.org/team/proj/commit/abc1234");
      expect(withRemote("ssh://git@host.org:2222/o/r.git")).toBeNull(); // ssh port — no reliable web mapping
      expect(withRemote("https://host.org:8443/o/r.git")).toBeNull(); // nonstandard web port
      expect(withRemote("https://dev.azure.com/org/proj/_git/repo")).toBeNull(); // azure layout — wrong link worse than none
      expect(withRemote("file:///srv/git/repo")).toBeNull(); // local scheme
      expect(withRemote(null)).toBeNull(); // no origin — local-only repo (atl pattern)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
