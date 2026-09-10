// test/framework/shipping.test.ts — AUTO-SHIP-ON-DONE (KEY). The merge-finisher
// lane reacts to `done` deterministically, gated by a PER-REPO SHIPPING POLICY
// (autopilot.config.json → shipping.repos). NO FALLBACK: a policy-less repo
// fires a ONE-TIME policy-inquiry ask and stays paused — nothing merges before
// the policy is set. Tests use TEMP REAL REPOS: policy resolution (slug /
// basename / no-fallback), runner wiring (auto dispatched, manual suppressed),
// shippedAt idempotence, two-base MR flow, policy-inquiry fires + resumes after
// the orchestrator writes the answer, and conflicts → failure, never force.
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { newStore, addItem, saveStore, loadStore } from "../../src/queue-store.ts";
import { createFrameworkRunner } from "../../src/framework/runner.ts";
import { saveAutopilotConfig } from "../../src/config.ts";
import { preserveRunWorktree } from "../../src/framework/worktree-preservation.ts";
import {
  resolveRepoPolicy,
  runShippingPass,
  writeShippingPolicy,
  shippingStatePath,
  shipItem,
  suggestedPolicyKey,
  originSlug,
} from "../../src/framework/shipping.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";
import type { ShippingRepoPolicy } from "../../src/config.ts";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir?: string): string {
  const repo = dir ?? mkdtempSync(join(tmpdir(), "orch-ship-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.email", "test@test");
  g(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** A bare origin remote pushed with the current main (the remote-exists case). */
function addBareRemote(repo: string): string {
  const remote = mkdtempSync(join(tmpdir(), "orch-ship-remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  g(repo, "remote", "add", "origin", remote);
  g(repo, "push", "-q", "-u", "origin", "main");
  g(repo, "fetch", "-q", "origin");
  return remote;
}

function commitOnBranch(repo: string, branch: string, file: string, message: string): string {
  g(repo, "checkout", "-q", "-b", branch);
  writeFileSync(join(repo, file), `${message}\n`);
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", message);
  return g(repo, "rev-parse", "HEAD");
}

/** Seed a done item referencing `repo` + journal its work branch (the shape a
 *  completed+approved review leaves behind). */
function seedDone(stateDir: string, repo: string, key: string, runId: string): void {
  const tip = commitOnBranch(repo, `pi-parallel-${runId}-0`, "work.txt", `${key} work`);
  const store = loadStore(stateDir) ?? newStore();
  addItem(store, {
    key,
    title: key.toLowerCase(),
    status: "done",
    blocker: null,
    scope: "do the thing",
    cwd: repo,
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    notes: "",
  });
  saveStore(stateDir, store);
  preserveRunWorktree({ stateDir, repo, runId, key });
  return void tip; // the journal carries the tip — the item does not need it
}

function policy(flow: "mrs" | "merge", baseBranches: string[]): ShippingRepoPolicy {
  return { flow, baseBranches };
}

const backendIdle: SubagentBackend = {
  spawn: async () => "unused",
  fleetStatus: async () => ({ totalActive: 0 }),
  steer: async () => "req-1",
  asyncDirFor: () => null,
};

/** Bounded wait for an async condition (the runner fires sweeps with `void`). */
async function waitFor(desc: string, probe: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("shipping — policy resolution (NO FALLBACK)", () => {
  test("matches the origin slug (owner/repo) and the repo basename; unknown repo → null (never a guess)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-state-"));
    const repo = initRepo();
    addBareRemote(repo);
    // make the remote URL shape forge-like so the slug is owner/repo (no fetch —
    // the URL string is parsed, the remote-tracking refs from the bare remote stay)
    g(repo, "remote", "set-url", "origin", "https://github.com/acme/thing.git");

    saveAutopilotConfig(stateDir, { shipping: { repos: { "acme/thing": policy("mrs", ["main"]) } } });
    expect(resolveRepoPolicy(stateDir, repo)?.key).toBe("acme/thing");
    expect(originSlug(repo)).toBe("acme/thing");

    // basename key matches too
    saveAutopilotConfig(stateDir, { shipping: { repos: { thing: policy("merge", ["main"]) } } });
    const byBase = resolveRepoPolicy(stateDir, repo);
    expect(byBase?.key).toBe("thing");
    expect(byBase?.policy.flow).toBe("merge");

    // an unknown repo → null — the caller MUST inquire, never guess
    const other = initRepo();
    expect(resolveRepoPolicy(stateDir, other)).toBeNull();
    // an invalid policy (bad flow / empty bases) resolves as NO policy too
    saveAutopilotConfig(stateDir, { shipping: { repos: { thing: { flow: "auto" as never, baseBranches: [] } } } });
    expect(resolveRepoPolicy(stateDir, repo)).toBeNull();
    expect(suggestedPolicyKey(repo)).toBe("acme/thing");
    rmSync(repo, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("shipping — the lane (module level, real repos)", () => {
  test("flow merge: ships into the local base + sets shippedAt; nothing new → skipped + marked", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-state-"));
    const repo = initRepo();
    // basename of the temp dir is orch-ship-XXXX — keyed by what suggestedPolicyKey
    // derives (basename, no remote) so the resolution under test is exact
    const slug = suggestedPolicyKey(repo);
    saveAutopilotConfig(stateDir, { shipping: { repos: { [slug]: policy("merge", ["main"]) } } });

    const mainBefore = g(repo, "rev-parse", "main");
    seedDone(stateDir, repo, "K-MERGE", "run-merge-1");
    const outcomes = runShippingPass(stateDir);
    const shipped = outcomes.find((o) => o.kind === "shipped");
    expect(shipped).toBeTruthy();
    expect(shipped!.message).toContain("merged K-MERGE @");
    const mainAfter = g(repo, "rev-parse", "main");
    expect(mainAfter).not.toBe(mainBefore);
    const item = loadStore(stateDir)!.items["K-MERGE"];
    expect(item.shippedAt).toBeTruthy();
    expect(item.notes).toContain("[shipped]");

    // idempotence: the marker prevents re-merge, even if the lane runs again
    const second = runShippingPass(stateDir);
    expect(second).toEqual([]); // no re-ship outcome
    expect(g(repo, "rev-parse", "main")).toBe(mainAfter); // NOT merged again
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("two-base MR flow: one MR per baseBranch, in order → both land on origin, never forced", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-state-"));
    const repo = initRepo();
    const remote = addBareRemote(repo);
    const slug = suggestedPolicyKey(repo); // basename of the temp repo
    saveAutopilotConfig(stateDir, { shipping: { repos: { [slug]: policy("mrs", ["dev", "master"]) } } });

    const runId = "run-mrs-2";
    seedDone(stateDir, repo, "K-TWO", runId);
    const outcomes = runShippingPass(stateDir);
    const shipped = outcomes.find((o) => o.kind === "shipped");
    expect(shipped).toBeTruthy();
    expect(shipped!.message).toContain("MR into dev");
    expect(shipped!.message).toContain("MR into master");
    expect(shipped!.event?.name).toBe("orch:item-shipped");
    expect((shipped!.event!.data!.mrs as Array<{ base: string }>).map((m) => m.base)).toEqual(["dev", "master"]); // declared order

    // both MR "sources" are the SAME approved branch pushed to origin — the
    // branch exists there exactly once (a no-force push, never -f)
    const source = `pi-parallel-${runId}-0`;
    expect(g(remote, "rev-parse", "--verify", `refs/heads/${source}`)).toBeTruthy();
    expect(loadStore(stateDir)!.items["K-TWO"].shippedAt).toBeTruthy();
    // no-force: pushing a DIFFERENT LOCAL tip (a new commit on another branch)
    // onto the existing origin/source is a rejected push → failure
    g(repo, "checkout", "-q", "-b", "other", "main");
    writeFileSync(join(repo, "other.txt"), "divergent\n");
    g(repo, "add", ".");
    g(repo, "commit", "-q", "-m", "divergent history");
    const divergent = g(repo, "rev-parse", "HEAD");
    expect(shipItem({ repo, key: "K-TWO", branch: source, sha: divergent, policy: policy("mrs", ["dev"]) }).ok).toBe(false);
    rmSync(remote, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("merge CONFLICT → failure + escalation, never a forced merge, base untouched", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-state-"));
    const repo = initRepo();
    const slug = suggestedPolicyKey(repo);
    saveAutopilotConfig(stateDir, { shipping: { repos: { [slug]: policy("merge", ["main"]) } } });
    // the work branch edits work.txt…
    const runId = "run-conflict-3";
    seedDone(stateDir, repo, "K-CONFLICT", runId);
    // …then main edits the SAME path in the opposite direction → guaranteed conflict
    g(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "work.txt"), "main sides the same file\n");
    g(repo, "add", ".");
    g(repo, "commit", "-q", "-m", "main changes work.txt");
    const mainBefore = g(repo, "rev-parse", "main");

    const outcomes = runShippingPass(stateDir);
    const failure = outcomes.find((o) => o.kind === "failure");
    expect(failure).toBeTruthy();
    expect(failure!.message).toContain("SHIPPING FAILED K-CONFLICT");
    expect(failure!.message).toContain("never forced");
    expect(failure!.event?.data?.conflict).toBe(true);
    expect(g(repo, "rev-parse", "main")).toBe(mainBefore); // nothing landed
    expect(g(repo, "status", "--porcelain")).toBe(""); // the abort cleaned the tree
    expect(loadStore(stateDir)!.items["K-CONFLICT"].shippedAt).toBeNull(); // still unshipped
    // and the lane does NOT hammer the failure every sweep (one-time escalation)
    expect(runShippingPass(stateDir)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("shipping — policy-inquiry (fires once, resumes after the orchestrator writes it)", () => {
  test("policy-less repo → one-time ask + paused; writing the policy resumes the run", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-state-"));
    const repo = initRepo();
    const runId = "run-inq-4";
    seedDone(stateDir, repo, "K-PENDING", runId);

    const first = runShippingPass(stateDir);
    const ask = first.find((o) => o.kind === "policy-inquiry");
    expect(ask).toBeTruthy();
    expect(ask!.message).toContain("shipping policy for");
    expect(ask!.message).toContain("flow (mrs|merge), baseBranches");
    expect(ask!.message).toContain("Nothing ships and nothing merges until the policy is set");
    // detection-based hints ride the ask (setup help only)
    expect(ask!.message).toContain("Hints:");
    expect(ask!.event?.name).toBe("orch:shipping-policy-inquiry");
    // persisted as a pending intercom inquiry — the SAME sweep does not re-ask
    const state = JSON.parse(readFileSync(shippingStatePath(stateDir), "utf8"));
    expect(state.inquiries[suggestedPolicyKey(repo)]).toBeTruthy();
    expect(runShippingPass(stateDir)).toEqual([]); // paused + silently one-time
    expect(loadStore(stateDir)!.items["K-PENDING"].shippedAt).toBeNull(); // nothing merged pre-policy

    // the orchestrator relays the user's answer → writes the policy (one-time)
    const key = suggestedPolicyKey(repo);
    const mainBefore = g(repo, "rev-parse", "main");
    writeShippingPolicy(stateDir, key, policy("merge", ["main"]));
    const resumed = runShippingPass(stateDir);
    const shipped = resumed.find((o) => o.kind === "shipped");
    expect(shipped).toBeTruthy();
    expect(loadStore(stateDir)!.items["K-PENDING"].shippedAt).toBeTruthy();
    expect(g(repo, "rev-parse", "main")).not.toBe(mainBefore);
    // the inquiry is cleared — the intercom asks no more
    const after = JSON.parse(readFileSync(shippingStatePath(stateDir), "utf8"));
    expect(after.inquiries[key]).toBeUndefined();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe("shipping — runner wiring (the runner reacts to done)", () => {
  function runnerFixture(stateDir: string) {
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
    return { runner, events, delivered };
  }

  test("done → merge-finisher AUTO-dispatched on the next sweep: shippedAt + [orch-tick: ship] merged", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-runner-"));
    const repo = initRepo();
    saveAutopilotConfig(stateDir, { shipping: { repos: { [suggestedPolicyKey(repo)]: policy("merge", ["main"]) } } });
    seedDone(stateDir, repo, "K-AUTO", "run-auto-5");
    const { runner, delivered, events } = runnerFixture(stateDir);
    runner.onTimer(); // the reconcile sweep sees done → ships
    await waitFor("shippedAt marker set", () => Boolean(loadStore(stateDir)?.items["K-AUTO"].shippedAt));
    const merged = delivered.find((m) => m.includes("[orch-tick: ship]") && m.includes("merged K-AUTO @"));
    expect(merged).toBeTruthy();
    expect(events.some((e) => e.name === "orch:item-shipped" && e.data?.key === "K-AUTO")).toBe(true);
    const sha = g(repo, "rev-parse", "main");
    expect(merged).toContain(sha.slice(0, 8));
    runner.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("mergeMode manual → lane SUPPRESSED (finishers stay explicit): no merge, no shippedAt, ONE nudge", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-runner-"));
    const repo = initRepo();
    saveAutopilotConfig(stateDir, {
      shipping: { mergeMode: "manual", repos: { [suggestedPolicyKey(repo)]: policy("merge", ["main"]) } },
    });
    const mainBefore = g(repo, "rev-parse", "main");
    seedDone(stateDir, repo, "K-MAN", "run-manual-6");
    const { runner, delivered } = runnerFixture(stateDir);
    runner.onTimer();
    await waitFor("manual nudge delivered", () => delivered.some((m) => m.includes("[orch-tick: ship]")));
    const nudge = delivered.find((m) => m.includes("[orch-tick: ship]"));
    expect(nudge).toContain("mergeMode is manual");
    expect(loadStore(stateDir)!.items["K-MAN"].shippedAt).toBeNull(); // NOT shipped
    expect(g(repo, "rev-parse", "main")).toBe(mainBefore);        // NOT merged
    runner.onTimer(); // the nudge is one-time — no re-nudge, still no auto-ship
    await new Promise((r) => setTimeout(r, 80));
    expect(delivered.filter((m) => m.includes("[orch-tick: ship]")).length).toBe(1);
    expect(g(repo, "rev-parse", "main")).toBe(mainBefore);
    runner.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("shippedAt idempotence THROUGH the runner: a second sweep never re-merges, never re-ticks", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "orch-ship-runner-"));
    const repo = initRepo();
    saveAutopilotConfig(stateDir, { shipping: { repos: { [suggestedPolicyKey(repo)]: policy("merge", ["main"]) } } });
    seedDone(stateDir, repo, "K-IDEM", "run-idem-7");
    const { runner, delivered } = runnerFixture(stateDir);
    runner.onTimer();
    await waitFor("first ship", () => Boolean(loadStore(stateDir)?.items["K-IDEM"].shippedAt));
    const afterFirst = g(repo, "rev-parse", "main");
    runner.onTimer(); // second sweep — the marker must hold
    await new Promise((r) => setTimeout(r, 120)); // let the async sweep fully settle
    expect(g(repo, "rev-parse", "main")).toBe(afterFirst); // NOT merged again
    expect(delivered.filter((m) => m.includes("[orch-tick: ship]") && m.includes("merged K-IDEM")).length).toBe(1);
    runner.stop();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
});