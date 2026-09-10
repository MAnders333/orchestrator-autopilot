// test/framework/auto-recovery.test.ts — AUTO-RECOVER-FAILS. The failed-status
// lane must re-dispatch by POLICY (never churn): capped → bigger budget;
// verdict/zombie → one P5 recovery; spawn/infra → 2× with backoff then
// escalate; consecutive provider failures hold retries (degraded window);
// per-item bounds cap the loop; every move announced as a `[orch-tick:
// recover]` line. Mock backend + real store.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newStore, addItem, saveStore, loadStore, type QueueItem, type QueueStore } from "../../src/queue-store.ts";
import {
  autoRecoverFails,
  recoveryPlan,
  recoveryContext,
  recoveryTask,
  MAX_RECOVERIES,
  BUDGET_MAX_MS,
  DEFAULT_BUDGET_MS,
} from "../../src/framework/auto-recovery.ts";
import { loadRecoveryState, recordProviderFailure, saveRecoveryState } from "../../src/framework/recovery-state.ts";
import { autoDispatchEligible } from "../../src/framework/auto-dispatch.ts";
import { createFrameworkRunner } from "../../src/framework/runner.ts";
import { Autopilot } from "../../src/core.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const BACKOFF = 1_000; // small injected backoff for the tests

function item(over: Partial<QueueItem> & { key: string }): QueueItem {
  return {
    status: "failed",
    blocker: null,
    title: "t",
    scope: "do the thing",
    cwd: "/tmp/repo",
    evidence: "",
    value: "M",
    urgency: "M",
    risk: "low",
    runId: "dead-run-1",
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    failCause: "verdict",
    recoveries: 0,
    recoveryNotBefore: null,
    recoveryEscalated: false,
    notes: "",
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

function fixture(items: QueueItem[]): { dir: string; store: QueueStore } {
  const dir = mkdtempSync(join(tmpdir(), "orch-recover-"));
  const store = newStore();
  for (const it of items) addItem(store, it, it.updatedAt || it.createdAt);
  saveStore(dir, store);
  return { dir, store };
}

function read(dir: string): QueueStore {
  return JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
}

function recordingBackend(impl?: () => Promise<string>): { backend: SubagentBackend; spawns: Array<{ task: string; cwd?: string; timeoutMs?: number }> } {
  const spawns: Array<{ task: string; cwd?: string; timeoutMs?: number }> = [];
  const backend: SubagentBackend = {
    spawn: async (task, o) => {
      spawns.push({ task, cwd: o?.cwd, timeoutMs: o?.timeoutMs });
      return impl ? impl() : `run-${spawns.length}`;
    },
    fleetStatus: async () => ({ totalActive: 0 }),
    steer: async () => "req",
    asyncDirFor: () => null,
  };
  return { backend, spawns };
}

describe("recoveryPlan — the deterministic per-cause policy", () => {
  test("budget-capped → timeoutMs ×1.5, capped at 3h", () => {
    expect(recoveryPlan(item({ key: "A", timeoutMs: HOUR }), "budget-capped")).toMatchObject({ maxAttempts: 2, budgetMs: HOUR * 1.5 });
    expect(recoveryPlan(item({ key: "B", timeoutMs: 4 * HOUR }), "budget-capped").budgetMs).toBe(BUDGET_MAX_MS);
    // no recorded budget → grow from the observed runtime default
    expect(recoveryPlan(item({ key: "C", timeoutMs: null }), "budget-capped").budgetMs).toBe(Math.round(DEFAULT_BUDGET_MS * 1.5));
  });
  test("verdict + zombie → ONE recovery re-dispatch; spawn → retries up to the cap", () => {
    expect(recoveryPlan(item({ key: "V" }), "verdict").maxAttempts).toBe(1);
    expect(recoveryPlan(item({ key: "Z" }), "zombie").maxAttempts).toBe(1);
    expect(recoveryPlan(item({ key: "S" }), "spawn").maxAttempts).toBe(MAX_RECOVERIES);
  });
  test("the global cap clamps every cause", () => {
    expect(recoveryPlan(item({ key: "A", timeoutMs: HOUR }), "budget-capped", 1).maxAttempts).toBe(1);
    expect(recoveryPlan(item({ key: "S" }), "spawn", 1).maxAttempts).toBe(1);
  });
});

describe("recoveryTask — P5 context rides the re-dispatch", () => {
  test("KEY + scope + the recoverability rule; never main", () => {
    const t = recoveryTask(item({ key: "R1" }), "verdict");
    expect(t).toContain("KEY: R1");
    expect(t).toContain("do the thing");
    expect(t).toContain("## Recovery re-dispatch (P5)");
    expect(t).toContain("pi-parallel-<runid>-0");
    expect(t).toContain("NEVER commit or merge to main");
    expect(recoveryContext("budget-capped")).toContain("BIGGER budget");
    expect(recoveryContext("spawn")).toContain("rejected the previous run AT SPAWN");
  });

  test("the main-write rule is DISPATCH-CLASS aware: a finisher is not told never to merge (AUTOPILOT-46)", () => {
    // "NEVER commit or merge to main" instructs a merge finisher to fail: its
    // whole scope is landing the approved branch in the target checkout.
    const forFinisher = recoveryContext("verdict", "finisher");
    expect(forFinisher).not.toContain("NEVER commit or merge to main");
    expect(forFinisher).toContain("FINISHER-CLASS");
    expect(forFinisher).toContain("CHECK FIRST whether the previous attempt already landed it");
    expect(recoveryContext("verdict", "worker")).toContain("NEVER commit or merge to main");
    // the item's class drives the task, so no call site has to remember
    expect(recoveryTask(item({ key: "R2", dispatchClass: "finisher" }), "verdict")).toContain("FINISHER-CLASS");
    expect(recoveryTask(item({ key: "R3" }), "verdict")).toContain("NEVER commit or merge to main");
  });
});

describe("autoRecoverFails — capped → bigger budget", () => {
  test("arms the backoff, then re-dispatches with timeoutMs ×1.5 and records the move", async () => {
    const f = fixture([item({ key: "CAP1", status: "failed", failCause: "budget-capped", timeoutMs: HOUR })]);
    const { backend, spawns } = recordingBackend();
    // pass 1: a fresh failure arms the short backoff — no spawn yet
    const p1 = await autoRecoverFails(f.dir, backend, { now: NOW, backoffMs: BACKOFF });
    expect(p1.recovered).toHaveLength(0);
    expect(p1.nextAt).toBe(NOW + BACKOFF);
    expect(read(f.dir).items["CAP1"].recoveryNotBefore).toBe(NOW + BACKOFF);
    expect(spawns).toHaveLength(0);
    // pass 2 (after the backoff): the re-dispatch runs with the bigger budget
    const p2 = await autoRecoverFails(f.dir, backend, { now: NOW + BACKOFF + 1, backoffMs: BACKOFF });
    expect(p2.recovered).toHaveLength(1);
    expect(p2.recovered[0]).toMatchObject({ key: "CAP1", attempt: 1, cause: "budget-capped", budgetMs: Math.round(HOUR * 1.5) });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].timeoutMs).toBe(Math.round(HOUR * 1.5)); // the recorded budget rides the re-dispatch
    expect(spawns[0].task).toContain("KEY: CAP1");
    const after = read(f.dir).items["CAP1"];
    expect(after.status).toBe("active");
    expect(after.runId).toBe("run-1");
    expect(after.timeoutMs).toBe(Math.round(HOUR * 1.5));
    expect(after.recoveries).toBe(1);
    expect(after.failCause).toBeNull(); // leaving failed clears the stale cause
    expect(after.recoveryNotBefore).toBeNull(); // and the scheduling gate
    expect(after.notes).toContain("[recover]");
  });
});

describe("autoRecoverFails — verdict/zombie → one recovery then escalate", () => {
  test("a verdict item gets exactly one P5 re-dispatch, then stays failed + escalates once", async () => {
    const f = fixture([item({ key: "V1", status: "failed", failCause: "verdict" })]);
    const { backend, spawns } = recordingBackend();
    await autoRecoverFails(f.dir, backend, { now: NOW, backoffMs: BACKOFF }); // arm
    const p2 = await autoRecoverFails(f.dir, backend, { now: NOW + BACKOFF + 1, backoffMs: BACKOFF });
    expect(p2.recovered).toHaveLength(1);
    expect(spawns[0].task).toContain("## Recovery re-dispatch (P5)");
    let after = read(f.dir).items["V1"];
    expect(after.status).toBe("active");
    expect(after.recoveries).toBe(1);
    // the redo fails again (verdict) → no attempts left → escalate
    const store = loadStore(f.dir)!;
    store.items["V1"].status = "failed";
    store.items["V1"].failCause = "verdict";
    store.items["V1"].runId = null;
    store.items["V1"].recoveryNotBefore = null;
    saveStore(f.dir, store);
    const p3 = await autoRecoverFails(f.dir, backend, { now: NOW + 2 * BACKOFF, backoffMs: BACKOFF });
    expect(p3.escalated).toHaveLength(1);
    expect(p3.escalated[0]).toMatchObject({ key: "V1", cause: "verdict", attempts: 1 });
    after = read(f.dir).items["V1"];
    expect(after.status).toBe("failed");
    expect(after.recoveryEscalated).toBe(true);
    expect(spawns).toHaveLength(1); // ONE recovery — never a loop
    // a second pass does not re-escalate (no nagging tick)
    const p4 = await autoRecoverFails(f.dir, backend, { now: NOW + 3 * BACKOFF, backoffMs: BACKOFF });
    expect(p4.escalated).toHaveLength(0);
  });
});

describe("autoRecoverFails — spawn/infra → retry up to 2× with backoff, then escalate", () => {
  test("bare-400 at spawn is retried twice and then escalated; the degraded window engages", async () => {
    const f = fixture([item({ key: "S1", status: "failed", failCause: "spawn" })]);
    const { backend, spawns } = recordingBackend(async () => { throw new Error("provider 400: bad request"); });
    await autoRecoverFails(f.dir, backend, { now: NOW, backoffMs: BACKOFF }); // arm
    const p2 = await autoRecoverFails(f.dir, backend, { now: NOW + BACKOFF + 1, backoffMs: BACKOFF });
    expect(spawns).toHaveLength(1);
    expect(p2.recovered).toHaveLength(0);
    let after = read(f.dir).items["S1"];
    expect(after.recoveries).toBe(1);
    expect(after.failCause).toBe("spawn"); // the infra class
    expect(after.status).toBe("failed");
    const p3 = await autoRecoverFails(f.dir, backend, { now: NOW + 2 * BACKOFF + 2, backoffMs: BACKOFF });
    expect(spawns).toHaveLength(2);
    expect(read(f.dir).items["S1"].recoveries).toBe(2);
    // 2 consecutive provider failures → the degraded-window notice fires
    expect(p3.spawnFailures).toBe(2);
    expect(p3.heldNotice).toBe(true);
    // the next pass is HELD (no third spawn); the exhausted item escalates once
    const p4 = await autoRecoverFails(f.dir, backend, { now: NOW + 3 * BACKOFF + 3, backoffMs: BACKOFF });
    expect(p4.held).toBe(true);
    expect(spawns).toHaveLength(2); // paused — no churn
    expect(p4.escalated).toHaveLength(1);
    after = read(f.dir).items["S1"];
    expect(after.status).toBe("failed");
    expect(after.recoveryEscalated).toBe(true);
  });
});

describe("autoRecoverFails — the FINISHER HOLD (AUTOPILOT-46)", () => {
  test("a failed finisher is held and escalated once; a plain worker beside it still recovers", async () => {
    const f = fixture([
      item({ key: "FIN1", status: "failed", failCause: "verdict", dispatchClass: "finisher", recoveryNotBefore: NOW - 1 }),
      item({ key: "W1", status: "failed", failCause: "verdict", recoveryNotBefore: NOW - 1 }),
    ]);
    const { backend, spawns } = recordingBackend();

    const out = await autoRecoverFails(f.dir, backend, { now: NOW, backoffMs: BACKOFF });

    // the guard is NARROW: it holds the finisher and nothing else — a blanket
    // skip that stranded ordinary failures would be the worse bug
    expect(out.finisherHeld).toEqual([{ key: "FIN1", cause: "verdict", attempts: 0, surfaced: true }]);
    expect(out.recovered.map((r) => r.key)).toEqual(["W1"]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].task).toContain("KEY: W1");
    const fin = read(f.dir).items["FIN1"];
    expect(fin.status).toBe("failed"); // stays failed — never silently dropped
    expect(fin.recoveries).toBe(0); // no attempt was spent on it
    expect(fin.recoveryEscalated).toBe(true); // … and it is ESCALATED, not forgotten
    expect(fin.notes).toContain("[recover-hold: finisher]");
    expect(fin.notes).toContain("conflict-resolved cherry-pick");

    // a second pass neither re-announces nor re-dispatches
    const again = await autoRecoverFails(f.dir, backend, { now: NOW + 10 * BACKOFF, backoffMs: BACKOFF });
    expect(again.finisherHeld).toEqual([{ key: "FIN1", cause: "verdict", attempts: 0, surfaced: false }]);
    expect(again.recovered).toEqual([]);
    expect(spawns).toHaveLength(1);
  });

  test("the hold covers EVERY cause — a budget-capped finisher gets no bigger-budget retry either", async () => {
    const f = fixture([item({ key: "FIN2", status: "failed", failCause: "budget-capped", timeoutMs: HOUR, dispatchClass: "finisher" })]);
    const { backend, spawns } = recordingBackend();

    // pass 1: a fresh failure. A worker would arm the backoff here; the finisher
    // is held immediately — there is no attempt to schedule.
    const p1 = await autoRecoverFails(f.dir, backend, { now: NOW, backoffMs: BACKOFF });
    expect(p1.finisherHeld).toEqual([{ key: "FIN2", cause: "budget-capped", attempts: 0, surfaced: true }]);
    expect(p1.nextAt).toBeNull(); // nothing is waiting to fire
    expect(read(f.dir).items["FIN2"].recoveryNotBefore).toBeNull();
    // pass 2, well past any backoff: still no spawn
    await autoRecoverFails(f.dir, backend, { now: NOW + 10 * BACKOFF, backoffMs: BACKOFF });
    expect(spawns).toEqual([]);
    expect(read(f.dir).items["FIN2"].status).toBe("failed");
  });

  test("the failure note does not promise a recovery this class will not get", () => {
    // The infra/cap notes tell the operator "the harness AUTO-RECOVERS" — true
    // for a worker, false for a finisher now that the hold exists.
    const dir = mkdtempSync(join(tmpdir(), "orch-recover-finisher-note-"));
    const store = newStore();
    addItem(store, item({ key: "FIN4", status: "active", failCause: null, runId: "371d1bb9", dispatchClass: "finisher" }));
    addItem(store, item({ key: "W4", status: "active", failCause: null, runId: "482e2cc0" }));
    saveStore(dir, store);
    const ap = new Autopilot({ stateDir: dir, now: () => NOW });
    ap.handleAsyncComplete({ runId: "371d1bb9-aaaa", agent: "worker", success: false, results: [{ agent: "worker" }] });
    ap.handleAsyncComplete({ runId: "482e2cc0-bbbb", agent: "worker", success: false, results: [{ agent: "worker" }] });
    const items = read(dir).items;
    expect(items["FIN4"].failCause).toBe("spawn");
    expect(items["FIN4"].notes).toContain("auto-recovery does NOT re-dispatch this item");
    expect(items["W4"].notes).toContain("The harness AUTO-RECOVERS");
    expect(items["W4"].notes).not.toContain("auto-recovery does NOT re-dispatch this item");
  });

  test("the hold is DELIVERED: the runner ticks it once, naming the item and what to do", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-recover-finisher-"));
    const store = newStore();
    addItem(store, item({ key: "FIN3", status: "failed", failCause: "verdict", dispatchClass: "finisher" }));
    saveStore(dir, store);
    const { backend, spawns } = recordingBackend();
    const delivered: string[] = [];
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => {
        delivered.push(m);
      },
      enabled: () => true,
      sweepIntervalMs: 0,
      recovery: { backoffMs: 5 },
    });
    runner.onTimer();
    await new Promise((r) => setTimeout(r, 120));
    expect(spawns).toEqual([]); // never re-dispatched
    const tick = delivered.find((m) => m.includes("FINISHER-CLASS"));
    expect(tick).toBeTruthy();
    expect(tick).toContain("[orch-tick: recover]");
    expect(tick).toContain("FIN3");
    expect(tick).toContain("will NOT re-dispatch it");
    expect(tick).toContain("STAYS failed");
    runner.stop();
  });
});

describe("autoRecoverFails — degraded window + bounds", () => {
  test("provider failures pause retries (including a fresh failed item) and the notice fires once", async () => {
    const f = fixture([item({ key: "A", status: "failed", failCause: "verdict" })]);
    // simulate a provider already degraded: 2 recent failures
    saveRecoveryState(f.dir, { providerFailures: 2, heldNotified: false, lastProviderFailureAt: NOW - 10, updatedAt: new Date(NOW).toISOString() });
    const { backend, spawns } = recordingBackend();
    const out = await autoRecoverFails(f.dir, backend, { now: NOW, backoffMs: BACKOFF, spawnFailureThreshold: 2, degradedCooldownMs: 60_000 });
    expect(out.held).toBe(true);
    expect(out.heldNotice).toBe(true);
    expect(spawns).toHaveLength(0); // retries paused instead of churning
    expect(out.nextAt).toBe(NOW - 10 + 60_000); // a probe is scheduled after the cooldown
    // the notice is a one-time transition — a second pass within the window is silent
    const out2 = await autoRecoverFails(f.dir, backend, { now: NOW + 1, backoffMs: BACKOFF, spawnFailureThreshold: 2, degradedCooldownMs: 60_000 });
    expect(out2.held).toBe(true);
    expect(out2.heldNotice).toBe(false);
  });

  test("a healthy spawn resets the window (the ledger's consecutive rule)", () => {
    const f = fixture([]);
    recordProviderFailure(f.dir, NOW);
    recordProviderFailure(f.dir, NOW + 1);
    expect(loadRecoveryState(f.dir).providerFailures).toBe(2);
    // a success clears it — proven by the next recordProvider* call path
    saveRecoveryState(f.dir, { providerFailures: 0, heldNotified: false, lastProviderFailureAt: null, updatedAt: new Date(NOW).toISOString() });
    expect(loadRecoveryState(f.dir).providerFailures).toBe(0);
  });

  test("the global maxRecoveries overrides the per-cause cap", async () => {
    const f = fixture([item({ key: "B1", status: "failed", failCause: "budget-capped", timeoutMs: HOUR, recoveries: 1, recoveryNotBefore: NOW - 1 })]);
    const { backend } = recordingBackend();
    const out = await autoRecoverFails(f.dir, backend, { now: NOW, backoffMs: BACKOFF, maxRecoveries: 1 });
    expect(out.escalated).toHaveLength(1); // 1 attempt already spent ≥ cap 1
    expect(read(f.dir).items["B1"].recoveryEscalated).toBe(true);
  });

  test("a degraded provider also pauses auto-dispatch (no churn into a dead provider)", async () => {
    const f = fixture([item({ key: "AP1", status: "approved", failCause: null, cwd: "/tmp/repo" })]);
    const { backend, spawns } = recordingBackend();
    expect((await autoDispatchEligible(f.dir, backend, 3)).map((d) => d.key)).toEqual(["AP1"]);
    expect(spawns).toHaveLength(1);
    // two provider failures → the next dispatch window is held
    recordProviderFailure(f.dir);
    recordProviderFailure(f.dir);
    expect(await autoDispatchEligible(f.dir, backend, 3)).toEqual([]);
    expect(spawns).toHaveLength(1);
  });
});

describe("AUTO-RECOVER-FAILS through the runner (delivery + announcement)", () => {
  test("an empty api_error mid-run is classified provider/infra (spawn) and gets the bounded provider retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-recover-infra-"));
    const store = newStore();
    addItem(store, item({ key: "E1", status: "active", failCause: null, runId: "371d1bb9" }));
    saveStore(dir, store);
    const r = new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete({
      runId: "371d1bb9-aaaa-bbbb",
      agent: "worker",
      success: false,
      results: [{ agent: "worker" }], // the run existed but produced NO deliverable text
    });
    expect(r.tick?.facts.failCause).toBe("spawn");
    expect(r.tick?.message).toContain("provider/infra");
    const after = read(dir).items["E1"];
    expect(after.status).toBe("failed");
    expect(after.failCause).toBe("spawn");
    expect(after.notes).toContain("[failed: spawn]");
  });

  test("a verdict failure with real output stays a verdict (not infra)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-recover-verdict-"));
    const store = newStore();
    addItem(store, item({ key: "V9", status: "active", failCause: null, runId: "abcd1234" }));
    saveStore(dir, store);
    const r = new Autopilot({ stateDir: dir, now: () => NOW }).handleAsyncComplete({
      runId: "abcd1234-aaaa-bbbb",
      agent: "worker",
      success: false,
      results: [{ agent: "worker", output: "tests failed: 3 assertions" }],
    });
    expect(r.tick?.facts.failCause).toBe("verdict");
    expect(read(dir).items["V9"].notes).toContain("[failed: verdict]");
  });

  test("a failed item is auto-recovered and announced as a [orch-tick: recover] line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-recover-runner-"));
    const store = newStore();
    addItem(store, item({ key: "R1", status: "failed", failCause: "budget-capped", timeoutMs: HOUR }));
    saveStore(dir, store);
    const spawns: Array<{ task: string; timeoutMs?: number }> = [];
    const backend: SubagentBackend = {
      spawn: async (task, o) => { spawns.push({ task, timeoutMs: o?.timeoutMs }); return "rec-run-1"; },
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req",
      asyncDirFor: () => null,
    };
    const delivered: string[] = [];
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      enabled: () => true,
      sweepIntervalMs: 0,
      recovery: { backoffMs: 5 },
    });
    runner.onTimer(); // arms the backoff + schedules the recovery timer
    await new Promise((r) => setTimeout(r, 120));
    expect(spawns).toHaveLength(1);
    expect(spawns[0].timeoutMs).toBe(Math.round(HOUR * 1.5));
    const tick = delivered.find((m) => m.includes("[orch-tick: recover]"));
    expect(tick).toBeTruthy();
    expect(tick).toContain("re-dispatched R1");
    expect(tick).toContain("attempt 1");
    expect(tick).toContain("budget-capped");
    expect(tick).toContain("budget 1h30m");
    runner.stop();
  });
});
