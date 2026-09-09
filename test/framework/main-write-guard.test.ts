// test/framework/main-write-guard.test.ts — MAIN-IMMUTABILITY-GUARD tests
// (KEY: MAIN-IMMUTABILITY-GUARD). The rule "nothing merges to main before
// human approval" is codified (55ce183) but guidance alone can lose — the
// guard makes it MECHANICAL: each runner reconcile step records every
// queue-referenced repo's main HEAD; a main-branch write that lands while an
// item referencing that repo is pre-done (not human-approved) raises the
// orch:main-write-pre-approval WARNING event + a loud [orch-tick: main-write]
// tick naming the SHA + offending key. These tests use TEMP REAL REPOS to
// prove: baseline capture on first sighting; pre-done HEAD move → warning;
// post-done HEAD move → no warning; dedupe (one warning per write); the
// runner wiring (event + tick through the shared gate).
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { newStore, addItem, saveStore, loadStore } from "../../src/queue-store.ts";
import { createFrameworkRunner } from "../../src/framework/runner.ts";
import { checkMainWrites, mainHeadsPath, preDoneKeysFor } from "../../src/framework/main-write-guard.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir?: string): string {
  const repo = dir ?? mkdtempSync(join(tmpdir(), "orch-mwg-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.email", "test@test");
  g(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** Commit directly ON main — the worker/harness pre-approval main write. */
function commitOnMain(repo: string, file: string, message: string): string {
  writeFileSync(join(repo, file), `${message}\n`);
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", message);
  return g(repo, "rev-parse", "HEAD");
}

function seedItem(stateDir: string, key: string, repo: string, status: string): void {
  const store = loadStore(stateDir) ?? newStore();
  addItem(store, {
    key,
    title: key.toLowerCase(),
    status: status as never,
    blocker: null,
    scope: "do the thing",
    cwd: repo,
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: status === "active" ? `run-${key}` : null,
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    notes: "",
  });
  saveStore(stateDir, store);
}

function headsFile(stateDir: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(mainHeadsPath(stateDir), "utf8")).repos;
}

const backendIdle: SubagentBackend = {
  spawn: async () => "unused",
  fleetStatus: async () => ({ totalActive: 0 }),
  steer: async () => "req-1",
  asyncDirFor: () => null,
};

/** Bounded wait for an async condition — the runner fires sweeps with `void`,
 *  so callers cannot await them directly. */
async function waitFor(desc: string, probe: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("main-write guard — module (checkMainWrites)", () => {
  test("first sighting records the baseline silently; a pre-done main move warns with the SHA + offending key", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-state-"));
    const repo = initRepo();
    seedItem(stateDir, "K-INFLIGHT", repo, "active");
    // baseline capture — no warning on first contact
    expect(checkMainWrites(stateDir)).toEqual([]);
    expect(headsFile(stateDir)[repo].main).toBe(g(repo, "rev-parse", "main"));

    const prev = g(repo, "rev-parse", "main");
    const cur = commitOnMain(repo, "violation.txt", "pre-approval main write");
    expect(prev).not.toBe(cur);

    const warnings = checkMainWrites(stateDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatchObject({ repo, ref: "main", previousSha: prev, sha: cur, keys: ["K-INFLIGHT"] });
    // the new HEAD is recorded so the SAME write is never warned twice
    expect(headsFile(stateDir)[repo].main).toBe(cur);
    expect(checkMainWrites(stateDir)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("post-done: main moves with the item already human-approved → no warning (the merge-finisher lane)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-state-"));
    const repo = initRepo();
    seedItem(stateDir, "K-DONE", repo, "done");
    checkMainWrites(stateDir); // baseline
    commitOnMain(repo, "shipped.txt", "merge-finisher ships the approved work");
    expect(checkMainWrites(stateDir)).toEqual([]); // legitimate — human-approved
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("rejected item does not make a main write suspect (deliberately dropped — no work pending)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-state-"));
    const repo = initRepo();
    seedItem(stateDir, "K-REJ", repo, "rejected");
    checkMainWrites(stateDir); // baseline
    commitOnMain(repo, "x.txt", "unrelated main commit");
    expect(checkMainWrites(stateDir)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("the warning names EVERY pre-done item referencing the repo; a done sibling does not silence it", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-state-"));
    const repo = initRepo();
    seedItem(stateDir, "K-DONE", repo, "done");
    seedItem(stateDir, "K-REVIEW", repo, "human-review");
    checkMainWrites(stateDir); // baseline
    const cur = commitOnMain(repo, "y.txt", "main write while K-REVIEW is pre-done");
    const warnings = checkMainWrites(stateDir);
    expect(warnings.length).toBe(1);
    expect(warnings[0].keys).toEqual(["K-REVIEW"]); // the done item is NOT an offender
    expect(warnings[0].sha).toBe(cur);
    expect(preDoneKeysFor(loadStore(stateDir)!, repo)).toEqual(["K-REVIEW"]);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("origin/main (remote-tracking ref) movement warns too — a push pre-approval is the MR-less push case", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-state-"));
    const repo = initRepo();
    const remote = mkdtempSync(join(tmpdir(), "orch-mwg-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    g(repo, "remote", "add", "origin", remote);
    g(repo, "push", "-q", "-u", "origin", "main");
    g(repo, "fetch", "-q", "origin");
    seedItem(stateDir, "K-ACTIVE", repo, "active");
    checkMainWrites(stateDir); // baseline records both refs
    expect(headsFile(stateDir)[repo]["origin/main"]).toBe(g(repo, "rev-parse", "origin/main"));

    const cur = commitOnMain(repo, "pushed.txt", "pre-approval push");
    g(repo, "push", "-q", "origin", "main");
    g(repo, "fetch", "-q", "origin");
    const warnings = checkMainWrites(stateDir);
    expect(warnings.some((w) => w.ref === "origin/main" && w.keys.includes("K-ACTIVE"))).toBe(true);
    rmSync(remote, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("non-repo cwd / absent store / no queue items → silent no-op", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-state-"));
    expect(checkMainWrites(stateDir)).toEqual([]); // no store yet
    const store = newStore();
    saveStore(stateDir, store);
    expect(checkMainWrites(stateDir)).toEqual([]); // no items → no repos to compare
    addItem(store, { key: "K-NOREPO", title: "", status: "active", blocker: null, scope: "", cwd: "/nonexistent/repo", evidence: "", value: "", urgency: "", risk: "", runId: "r", reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    saveStore(stateDir, store);
    expect(checkMainWrites(stateDir)).toEqual([]); // not a repo → skipped, nothing recorded
    expect(existsSync(mainHeadsPath(stateDir))).toBe(false);
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("main-write guard — runner wiring (the loud reconcile-step telemetry)", () => {
  test("PRE-DONE HEAD move → orch:main-write-pre-approval WARNING event + [orch-tick: main-write] with SHA + key", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-runner-"));
    const repo = initRepo();
    writeFileSync(join(stateDir, "queue.json"), JSON.stringify(newStore()));
    seedItem(stateDir, "K-WORKER", repo, "active");
    const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
    const delivered: string[] = [];
    const runner = createFrameworkRunner({
      stateDir,
      autopilot: new Autopilot({ stateDir }),
      backend: backendIdle,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      emit: (evs) => events.push(...evs),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    runner.onTimer(); // reconcile step 1 — records the baseline
    await waitFor("main-heads baseline recorded", () => existsSync(mainHeadsPath(stateDir)));

    const cur = commitOnMain(repo, "violation.txt", "worker wrote to main pre-approval");
    runner.onSettled(); // reconcile step 2 — the worker round ended, compare
    await waitFor("main-write warning emitted", () => events.length > 0);

    const ev = events.find((e) => e.name === "orch:main-write-pre-approval");
    expect(ev).toBeTruthy();
    expect(ev!.data!.severity).toBe("warning");
    expect(ev!.data!.repo).toBe(repo);
    expect(ev!.data!.ref).toBe("main");
    expect(ev!.data!.sha).toBe(cur);
    expect(ev!.data!.keys).toContain("K-WORKER");
    // loud: the violation reaches the orchestrator as a dedicated tick
    const tick = delivered.find((m) => m.includes("[orch-tick: main-write]"));
    expect(tick).toBeTruthy();
    expect(tick).toContain("K-WORKER");
    expect(tick).toContain(cur.slice(0, 8));
    expect(tick).toContain("NOT human-approved");
    // the SAME write never re-warns on a later sweep
    runner.onSettled();
    await new Promise((r) => setTimeout(r, 60));
    expect(events.filter((e) => e.name === "orch:main-write-pre-approval").length).toBe(1);
    runner.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("POST-DONE HEAD move (the merge-finisher shipping step) → NO warning, NO tick", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-mwg-runner-"));
    const repo = initRepo();
    writeFileSync(join(stateDir, "queue.json"), JSON.stringify(newStore()));
    seedItem(stateDir, "K-SHIPPED", repo, "done"); // human already approved
    const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
    const delivered: string[] = [];
    const runner = createFrameworkRunner({
      stateDir,
      autopilot: new Autopilot({ stateDir }),
      backend: backendIdle,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      emit: (evs) => events.push(...evs),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    runner.onTimer(); // baseline
    await waitFor("main-heads baseline recorded", () => existsSync(mainHeadsPath(stateDir)));

    commitOnMain(repo, "shipped.txt", "merge-finisher ships the approved work");
    runner.onSettled(); // reconcile step 2 — a legitimate post-done merge
    await new Promise((r) => setTimeout(r, 80));
    expect(events.filter((e) => e.name === "orch:main-write-pre-approval")).toEqual([]);
    expect(delivered.some((m) => m.includes("[orch-tick: main-write]"))).toBe(false);
    runner.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
});