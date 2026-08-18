// test/framework/auto-dispatch.test.ts — the framework ACTS on the queue:
// A) fill free slots with auto-dispatchable approved items; B) re-dispatch a
// review-FAILed item with the reviewer's findings. Mock backend; real store.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newStore, addItem, updateItem, type QueueItem } from "../../src/queue-store.ts";
import { isAutoDispatchable, workerTask, autoDispatchEligible, autoRedispatch, autoReview, reviewTask } from "../../src/framework/auto-dispatch.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

interface Fixture {
  dir: string;
  spawns: Array<{ task: string; cwd: string }>;
  backend: SubagentBackend;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "orch-autod-"));
  writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
  const spawns: Fixture["spawns"] = [];
  const backend: SubagentBackend = {
    spawn: async (task, opts) => {
      spawns.push({ task, cwd: opts.cwd ?? "" });
      return `run-${spawns.length}`;
    },
    fleetStatus: async () => ({ totalActive: 1 }), // one slot used → 2 free (max 3)
    steer: async () => "req",
    asyncDirFor: () => null,
  };
  return { dir, spawns, backend };
}

function item(key: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    key,
    status: "approved",
    blocker: null,
    title: key.toLowerCase(),
    scope: "do the thing",
    cwd: "/tmp/repo",
    evidence: "",
    value: "M",
    urgency: "M",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    attempts: 0,
    notes: "",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...over,
  };
}

function store(f: Fixture) {
  return JSON.parse(readFileSync(join(f.dir, "queue.json"), "utf8"));
}
function seed(f: Fixture, items: QueueItem[]): void {
  const s = store(f);
  for (const it of items) addItem(s, it);
  writeFileSync(join(f.dir, "queue.json"), JSON.stringify(s));
}

describe("isAutoDispatchable", () => {
  test("approved + scope + cwd + low/medium risk → yes", () => {
    expect(isAutoDispatchable(item("A1"))).toBe(true);
    expect(isAutoDispatchable(item("A2", { risk: "medium" }))).toBe(true);
  });
  test("gates: high risk / empty scope / no cwd / non-approved → no", () => {
    expect(isAutoDispatchable(item("H1", { risk: "high" }))).toBe(false);
    expect(isAutoDispatchable(item("S1", { scope: "  " }))).toBe(false);
    expect(isAutoDispatchable(item("C1", { cwd: null }))).toBe(false);
    expect(isAutoDispatchable(item("B1", { status: "blocked", blocker: "parked" }))).toBe(false);
    expect(isAutoDispatchable(item("P1", { status: "proposal" }))).toBe(false);
  });
});

describe("workerTask", () => {
  test("KEY line + scope; findings appended on re-dispatch", () => {
    expect(workerTask(item("A1"))).toBe("KEY: A1\ndo the thing");
    expect(workerTask(item("A1"), "Fix the schema.")).toContain("## Review findings (address them)");
    expect(workerTask(item("A1"), "Fix the schema.")).toContain("Fix the schema.");
  });
});

describe("autoDispatchEligible (A)", () => {
  test("fills free slots with eligible items (oldest first), records active + runId", async () => {
    const f = setup();
    seed(f, [item("A1"), item("A2", { updatedAt: "2026-08-17T01:00:00.000Z" })]);
    const dispatched = await autoDispatchEligible(f.dir, f.backend, 3); // fleet 1 → 2 free
    expect(dispatched.map((d) => d.key)).toEqual(["A1", "A2"]);
    const s = store(f);
    expect(s.items["A1"].status).toBe("active");
    expect(s.items["A1"].runId).toBeTruthy();
    expect(s.items["A2"].status).toBe("active");
    expect(f.spawns[0].task).toBe("KEY: A1\ndo the thing");
    expect(f.spawns[0].cwd).toBe("/tmp/repo");
  });

  test("respects the slot cap + skips ineligible items", async () => {
    const f = setup();
    seed(f, [item("A1"), item("A2", { updatedAt: "2026-08-17T01:00:00.000Z" }), item("H1", { risk: "high" })]);
    const dispatched = await autoDispatchEligible(f.dir, f.backend, 3, 2); // fleet 2 → 1 free
    expect(dispatched.map((d) => d.key)).toEqual(["A1"]);
    const s = store(f);
    expect(s.items["A1"].status).toBe("active"); // oldest fills the single free slot
    expect(s.items["A2"].status).toBe("approved"); // no slot left
    expect(s.items["H1"].status).toBe("approved"); // high-risk: never auto
  });

  test("no eligible work → no fleet call, nothing dispatched", async () => {
    const f = setup();
    seed(f, [item("H1", { risk: "high" })]);
    const dispatched = await autoDispatchEligible(f.dir, f.backend, 3);
    expect(dispatched.length).toBe(0);
    expect(f.spawns.length).toBe(0);
  });
});

describe("autoRedispatch (B)", () => {
  test("review-FAIL→active item with cwd re-dispatches with the findings", async () => {
    const f = setup();
    seed(f, [item("R1", { status: "active", runId: "old-run", attempts: 1 })]);
    const ok = await autoRedispatch(f.dir, f.backend, "R1", "The schema is wrong.");
    expect(ok).toBe(true);
    const s = store(f);
    expect(s.items["R1"].runId).not.toBe("old-run");
    expect(f.spawns[0].task).toContain("## Review findings (address them)");
    expect(f.spawns[0].task).toContain("The schema is wrong.");
  });

  test("non-active / no-cwd items are not re-dispatched", async () => {
    const f = setup();
    seed(f, [item("A1"), item("C1", { status: "active", runId: "x", cwd: null })]);
    expect(await autoRedispatch(f.dir, f.backend, "A1", "findings")).toBe(false); // approved, not active
    expect(await autoRedispatch(f.dir, f.backend, "C1", "findings")).toBe(false); // no cwd
    expect(f.spawns.length).toBe(0);
  });
});

describe("autoReview (C)", () => {
  test("a completed item (reviewing) gets a reviewer with the SAME fields the dispatch used", async () => {
    const f = setup();
    seed(f, [item("R1", { status: "reviewing", runId: "worker-run", reviewerRunId: null })]);
    const runId = await autoReview(f.dir, f.backend, "orchestrator-reviewer", "R1");
    expect(runId).toBeTruthy();
    const s = store(f);
    expect(s.items["R1"].reviewerRunId).toBeTruthy();
    const spawned = f.spawns[0];
    expect(spawned.task).toContain("KEY: R1");
    expect(spawned.task).toContain("do the thing"); // the scope
    expect(spawned.task).toContain("/tmp/repo");     // cwd → where the work is
    expect(spawned.task).toContain("Verdict: PASS"); // the contract
  });

  test("refuses when not reviewing / reviewer already running / missing scope or cwd", async () => {
    const f = setup();
    seed(f, [
      item("A1", { status: "approved" }),                     // not reviewing
      item("R2", { status: "reviewing", reviewerRunId: "x" }), // reviewer already running
      item("R3", { status: "reviewing", scope: "  " }),        // no scope
      item("R4", { status: "reviewing", cwd: null }),          // no cwd
    ]);
    expect(await autoReview(f.dir, f.backend, "orchestrator-reviewer", "A1")).toBeNull();
    expect(await autoReview(f.dir, f.backend, "orchestrator-reviewer", "R2")).toBeNull();
    expect(await autoReview(f.dir, f.backend, "orchestrator-reviewer", "R3")).toBeNull();
    expect(await autoReview(f.dir, f.backend, "orchestrator-reviewer", "R4")).toBeNull();
    expect(f.spawns.length).toBe(0);
  });

  test("reviewTask carries the locate-the-work rule (never trust the worker's summary)", () => {
    const t = reviewTask(item("R1"));
    expect(t).toContain("git log/reflog");
    expect(t).toContain("do NOT trust the worker's summary");
  });
});
