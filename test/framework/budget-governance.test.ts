// test/framework/budget-governance.test.ts — AUTOPILOT-8 / BUDGET-GOVERNANCE.
// The historical gap: framework workers ran at a silent uniform default budget
// and died mid-task with no signal (recovery = manual branch archaeology). The
// item.timeoutMs plumbing already reaches every dispatch lane; these tests pin
// the GOVERNANCE layer: (1) the FAIL cause is explicit — failed=budget-capped
// (timeoutMs cut the run off) vs failed=verdict, as a store flag + note;
// (2) a worker failure is never silent — it ticks with a bigger-budget
// re-dispatch hint; (3) budget health (cap/remaining) rides the dispatch tick
// facts + the panel row, and the timer warns once per run past ~75%.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot, storeToSnapshot } from "../../src/core.ts";
import {
  newStore,
  addItem,
  saveStore,
  updateItem,
  queryItems,
  loadStore,
  type QueueStore,
  type QueueItem,
} from "../../src/queue-store.ts";
import { buildPanelDoc } from "../../src/framework/panels.ts";
import { formatDurationMs } from "../../src/duration.ts";
import { RUNTIME_STEP_BUDGET_CEILING_MS } from "../../src/framework/run-budget.ts";

const NOW = 1_800_000_000_000; // fixed clock — deterministic elapsed math
const CAP = 43_200_000; // 12h — the observed incident request

function item(over: Partial<QueueItem> & { key: string }): QueueItem {
  return {
    status: "approved",
    blocker: null,
    title: "t",
    scope: "do the thing",
    cwd: "/tmp/repo",
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    failCause: null,
    notes: "",
    createdAt: new Date(NOW - 10_000).toISOString(),
    updatedAt: new Date(NOW - 10_000).toISOString(),
    ...over,
  };
}

function dirWith(items: QueueItem[]): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-budget-"));
  const store = newStore();
  for (const it of items) addItem(store, it, it.updatedAt || it.createdAt);
  saveStore(dir, store);
  return dir;
}

function make(dir: string): Autopilot {
  return new Autopilot({ stateDir: dir, now: () => NOW });
}

function read(dir: string): QueueStore {
  return JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
}

describe("store — failed=cap vs failed=verdict is machine-readable", () => {
  test("failCause normalizes on read (legacy items default null) + compact queryItems carries timeoutMs/failCause", () => {
    const dir = dirWith([
      item({ key: "F1", status: "failed", timeoutMs: CAP, failCause: "budget-capped" }),
      item({ key: "F2", status: "failed", notes: "legacy, no flag" }),
    ]);
    const store = loadStore(dir)!;
    expect(store.items["F1"].failCause).toBe("budget-capped");
    expect(store.items["F2"].failCause).toBeNull(); // backfilled on read
    const compact = queryItems(store, { status: "failed", sort: "key" });
    expect(compact.find((i) => i.key === "F1")).toMatchObject({ timeoutMs: CAP, failCause: "budget-capped" });
    expect(compact.find((i) => i.key === "F2")).toMatchObject({ timeoutMs: null, failCause: null });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a transition OUT of failed clears the stale cause; staying failed keeps it", () => {
    const dir = dirWith([item({ key: "F1", status: "failed", timeoutMs: CAP, failCause: "budget-capped" })]);
    // re-dispatch (recovery): failed → active is a FRESH run — no stale cap flag
    const store = loadStore(dir)!;
    updateItem(store, "F1", { status: "active", runId: "redone1234" });
    saveStore(dir, store);
    expect(loadStore(dir)!.items["F1"].failCause).toBeNull();
    // a re-statement of failed (metadata update while the item stays failed) keeps the cause
    const again = loadStore(dir)!;
    updateItem(again, "F1", { status: "failed", failCause: "budget-capped", notes: "x" });
    saveStore(dir, again);
    expect(loadStore(dir)!.items["F1"].failCause).toBe("budget-capped");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("engine — a failed worker is never silent and its cause is explicit", () => {
  test("budget-capped worker failure (timedOut): flipped failed + flag + note + failure tick with the bigger-budget re-dispatch hint", () => {
    const dir = dirWith([
      item({ key: "W-12", status: "active", runId: "371d1bb9", title: "w12", timeoutMs: CAP }),
    ]);
    const a = make(dir);
    const r = a.handleAsyncComplete({ runId: "371d1bb9-aaaa-bbbb", agent: "worker", success: false, timedOut: true });
    expect(r.flipped).toBe(true);
    expect(r.tick?.reason).toBe("failure");
    expect(r.tick?.facts).toMatchObject({ key: "W-12", outcome: "failed", failCause: "budget-capped", budgetCapped: true, timeoutMs: CAP });
    expect(r.tick?.message).toContain("W-12 FAILED");
    expect(r.tick?.message).toContain("budget-capped");
    expect(r.tick?.message).toContain("RE-DISPATCH WITH A BIGGER BUDGET");
    expect(r.domainEvents.some((e) => e.name === "orch:item-failed" && e.data.cause === "budget-capped")).toBe(true);
    const after = read(dir).items["W-12"];
    expect(after.status).toBe("failed");
    expect(after.failCause).toBe("budget-capped");
    expect(after.notes).toContain("[budget-capped]");
    expect(after.notes).toContain("pi-parallel-*");
    expect(after.runId).toBeNull(); // failed clears stale run refs
    rmSync(dir, { recursive: true, force: true });
  });

  test("a run that lived AT/OVER its recorded budget is classified budget-capped even without a timedOut flag (deterministic backstop)", () => {
    const dir = dirWith([
      // dispatched CAP ago — the runtime died at the cap but reported no timedOut flag
      item({ key: "W-13", status: "active", runId: "371d1bb9", timeoutMs: CAP, updatedAt: new Date(NOW - CAP - 5000).toISOString() }),
    ]);
    const r = make(dir).handleAsyncComplete({ runId: "371d1bb9-aaaa-bbbb", agent: "worker", success: false });
    expect(r.tick?.facts.failCause).toBe("budget-capped");
    expect(read(dir).items["W-13"].failCause).toBe("budget-capped");
    rmSync(dir, { recursive: true, force: true });
  });

  test("AUTOPILOT-47: a run killed at the RUNTIME CEILING is a cap, even though its recorded budget is far larger", () => {
    // THE MISCLASSIFICATION: the item asked for 12h, but the runtime truncates
    // every child to its per-step ceiling and killed this run at 30m. Comparing
    // the run's lifetime against the 12h REQUEST never fires, so the cap used to
    // be filed as a `verdict` failure — fewer recovery attempts, and a note
    // telling the operator "not budget-capped" about a run the budget killed.
    // AUTOPILOT-47's own first attempt was mis-filed exactly this way.
    const dir = dirWith([
      item({
        key: "W-47",
        status: "active",
        runId: "371d1bb9",
        timeoutMs: CAP, // 12h requested
        updatedAt: new Date(NOW - RUNTIME_STEP_BUDGET_CEILING_MS - 500).toISOString(), // died at the 30m wall
      }),
    ]);
    const r = make(dir).handleAsyncComplete({ runId: "371d1bb9-aaaa-bbbb", agent: "worker", success: false });
    expect(r.tick?.facts.failCause).toBe("budget-capped");
    expect(read(dir).items["W-47"].failCause).toBe("budget-capped");
    rmSync(dir, { recursive: true, force: true });
  });

  test("verdict worker failure (within budget, no timeout): failed=verdict — flag, note, and a tick WITHOUT the cap wording", () => {
    const dir = dirWith([
      item({ key: "W-14", status: "active", runId: "371d1bb9", timeoutMs: CAP, updatedAt: new Date(NOW - 60_000).toISOString() }),
    ]);
    const a = make(dir);
    const r = a.handleAsyncComplete({ runId: "371d1bb9-aaaa-bbbb", agent: "worker", success: false });
    expect(r.tick?.reason).toBe("failure");
    expect(r.tick?.facts).toMatchObject({ failCause: "verdict", budgetCapped: false });
    expect(r.tick?.message).toContain("not budget-capped");
    expect(r.tick?.message).not.toContain("RE-DISPATCH WITH A BIGGER BUDGET");
    const after = read(dir).items["W-14"];
    expect(after.status).toBe("failed");
    expect(after.failCause).toBe("verdict");
    expect(after.notes).toContain("[failed: verdict]");
    rmSync(dir, { recursive: true, force: true });
  });

  test("review-FAIL at the attempts cap records failed=verdict (the cap is an attempts cap, not a budget cap)", () => {
    const dir = dirWith([
      item({ key: "R1", status: "ai-review", title: "r1", timeoutMs: CAP }),
    ]);
    const st = loadStore(dir)!;
    st.items["R1"].reviewerRunId = "12345678-dead-beef";
    st.items["R1"].attempts = 4; // next FAIL hits cap 5
    saveStore(dir, st);
    const a = make(dir);
    const r = a.handleAsyncComplete({
      runId: "12345678-dead-beef-cafe",
      agent: "workflow",
      results: [{ agent: "orchestrator-reviewer", output: "Verdict: FAIL", runId: "12345678-dead-beef" }],
    });
    expect(r.tick?.message).toContain("cap 5");
    const after = read(dir).items["R1"];
    expect(after.status).toBe("failed");
    expect(after.failCause).toBe("verdict");
    expect(after.notes).toContain("[failed: verdict]");
    expect(after.notes).toContain("review FAIL at attempt 5");
    rmSync(dir, { recursive: true, force: true });
  });

  test("zombie reconciliation records failed=zombie (lost completion — its own recovery story)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-budget-zombie-"));
    const s = newStore();
    addItem(s, item({ key: "Z1", status: "active", runId: "deadfeed", updatedAt: new Date(NOW - 45 * 60_000).toISOString() }));
    saveStore(dir, s);
    const a = make(dir);
    a.zombieReconcile(0); // fleet idle, 45m > 30m grace
    expect(read(dir).items["Z1"].failCause).toBe("zombie");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("telemetry — budget health in dispatch tick facts + the ~75% cap risk", () => {
  test("storeToSnapshot derives remaining/cap/elapsed/used rows for active budgeted runs + the failed-at-cap keys", () => {
    const dir = dirWith([
      item({ key: "W-1", status: "active", runId: "aaaa1111", timeoutMs: CAP, updatedAt: new Date(NOW - 10_800_000).toISOString() }), // 25% used (10.8m of 12h — under the line)
      item({ key: "W-2", status: "active", runId: "aaaa2222", timeoutMs: null }), // no recorded budget → no row
      item({ key: "F-1", status: "failed", failCause: "budget-capped", timeoutMs: CAP }),
    ]);
    const snap = storeToSnapshot(loadStore(dir)!, NOW);
    expect(snap.budget).toHaveLength(1);
    expect(snap.budget[0]).toMatchObject({ key: "W-1", cap: CAP, remaining: CAP - 10_800_000, elapsed: 10_800_000 });
    expect(snap.budgetCappedFailed).toEqual(["F-1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dispatch tick facts carry the budget rows + budgetCapped keys; the message names runs past ~75%", () => {
    const dir = dirWith([
      item({ key: "W-1", status: "active", runId: "aaaa1111", timeoutMs: CAP, updatedAt: new Date(NOW - 34_560_000).toISOString() }), // 80% used
      item({ key: "B-1", status: "approved", title: "b1" }),
    ]);
    const a = make(dir);
    const tick = a.sweep("settled", NOW, { totalActive: 0 })?.tick;
    expect(tick?.reason).toBe("dispatch"); // slot free + ready work
    expect(Array.isArray(tick?.facts.budget)).toBe(true);
    const row = (tick?.facts.budget as Array<Record<string, unknown>>).find((b) => b.key === "W-1");
    expect(row?.cap).toBe(CAP);
    expect(row?.remaining).toBe(CAP - 34_560_000);
    expect(tick?.message).toContain("BUDGET:");
    expect(tick?.message).toContain("W-1 at ~80%");
    rmSync(dir, { recursive: true, force: true });
  });

  test("dispatch facts are emitted for under-the-line runs too (remaining/cap), but the message stays quiet", () => {
    const dir = dirWith([
      item({ key: "W-1", status: "active", runId: "aaaa1111", timeoutMs: CAP, updatedAt: new Date(NOW - 60_000).toISOString() }),
      item({ key: "B-1", status: "approved", title: "b1" }),
    ]);
    const tick = make(dir).sweep("settled", NOW, { totalActive: 0 })?.tick;
    expect(Array.isArray(tick?.facts.budget)).toBe(true);
    expect(tick?.message).not.toContain("BUDGET:");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the timer heartbeat warns ONCE per run past ~75% (no 10-minute nag)", () => {
    const dir = dirWith([
      item({ key: "W-1", status: "active", runId: "aaaa1111", timeoutMs: CAP, updatedAt: new Date(NOW - 34_560_000).toISOString() }), // 80%
      item({ key: "B-1", status: "approved", title: "b1" }),
      item({ key: "B-2", status: "approved", title: "b2" }),
    ]);
    const a = make(dir);
    // fleet full (3/3) + buffer ≥ threshold → the sweep itself is silent; the
    // budget heartbeat must carry the warning.
    const t1 = a.sweep("timer", NOW, { totalActive: 3 });
    expect(t1?.tick?.reason).toBe("budget");
    expect(t1?.tick?.message).toContain("[orch-tick: budget]");
    expect(t1?.tick?.message).toContain("W-1");
    const t2 = a.sweep("timer", NOW + 61_000, { totalActive: 3 }); // next heartbeat, same run
    expect(t2?.tick).toBeNull(); // already warned — not nagged again
    rmSync(dir, { recursive: true, force: true });
  });

  test("an under-the-line run does not warn; a capped failure then re-dispatched fresh does not warn either", () => {
    const dir = dirWith([
      item({ key: "W-1", status: "active", runId: "aaaa1111", timeoutMs: CAP, updatedAt: new Date(NOW - 60_000).toISOString() }),
      item({ key: "B-1", status: "approved", title: "b1" }),
      item({ key: "B-2", status: "approved", title: "b2" }),
    ]);
    const a = make(dir);
    expect(a.sweep("timer", NOW, { totalActive: 3 })?.tick).toBeNull(); // fresh run, ~0% used
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("panel + duration — the human-scale read path", () => {
  test("panel rows carry the recorded budget + the budget-capped marker (buildPanelDoc)", () => {
    const dir = dirWith([
      item({ key: "H1", status: "human-review", title: "h1", scope: "work", timeoutMs: CAP, notes: "wrote docs/x.md" }),
      item({ key: "H2", status: "human-review", title: "h2", scope: "work", timeoutMs: CAP, failCause: "budget-capped", notes: "had to be cut off" }),
      item({ key: "P1", status: "proposal", title: "p1", scope: "draft", timeoutMs: 3_600_000 }),
    ]);
    const doc = buildPanelDoc(dir, "human-review");
    const h1 = doc.sections[0].items.find((i) => i.key === "H1")!;
    expect(h1.timeoutMs).toBe(CAP);
    expect(h1.budgetCapped).toBe(false);
    const h2 = doc.sections[0].items.find((i) => i.key === "H2")!;
    expect(h2.budgetCapped).toBe(true); // the flag projects through to the row
    const p1 = buildPanelDoc(dir, "proposals").sections[0].items.find((i) => i.key === "P1")!;
    expect(p1.timeoutMs).toBe(3_600_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("formatDurationMs — one operator-visible spelling for budgets", () => {
    expect(formatDurationMs(43_200_000)).toBe("12h");
    expect(formatDurationMs(5_400_000)).toBe("1h30m");
    expect(formatDurationMs(1_800_000)).toBe("30m");
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(5_580_000)).toBe("1h33m");
    expect(formatDurationMs(-1)).toBe("0s");
  });
});
