// test/framework/run-liveness.test.ts — a STALE reviewerRunId must never wedge
// an item's review lane. Covers reviewerRunAlive itself plus its three call
// sites: queue_review (refused forever on a dead ref), the ai-review re-entry
// stamping in updateItem, and the harness autoReview (which skipped SILENTLY).
// Hermetic: the "run dirs" are temp dirs and status.json files, no real runs.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStore, addItem, saveStore, loadStore, updateItem, type QueueItem, type QueueStore } from "../../src/queue-store.ts";
import { reviewerRunAlive } from "../../src/framework/run-liveness.ts";
import { autoReview } from "../../src/framework/auto-dispatch.ts";
import { queueReview, type QueueOpsCtx } from "../../src/tools/queue-ops.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

const ALREADY_RUNNING = "a reviewer is ALREADY running";

function item(key: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    key,
    status: "ai-review",
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
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...over,
  };
}

interface Fixture {
  stateDir: string;
  runsDir: string;
  spawns: string[];
  backend: SubagentBackend;
  ctx: QueueOpsCtx;
}

let f: Fixture;

/** A fake run dir: `state` (pi) or `status` (opencode) in status.json. */
function writeRunStatus(runId: string, status: Record<string, unknown>): void {
  const dir = join(f.runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(status));
}
/** A run dir with an UNREADABLE status.json — liveness is undeterminable. */
function writeGarbageRunStatus(runId: string): void {
  const dir = join(f.runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), "{not json");
}

function seed(it: QueueItem): void {
  const s = loadStore(f.stateDir) ?? newStore();
  addItem(s, it);
  saveStore(f.stateDir, s);
}
function stored(key: string): QueueItem {
  return (JSON.parse(readFileSync(join(f.stateDir, "queue.json"), "utf8")) as QueueStore).items[key]!;
}

beforeEach(() => {
  const stateDir = mkdtempSync(join(tmpdir(), "orch-revlive-"));
  const runsDir = mkdtempSync(join(tmpdir(), "orch-revruns-"));
  writeFileSync(join(stateDir, "queue.json"), JSON.stringify(newStore()));
  const spawns: string[] = [];
  const backend: SubagentBackend = {
    spawn: async (task) => {
      spawns.push(task);
      return `new-reviewer-${spawns.length}`;
    },
    fleetStatus: async () => ({ totalActive: 0 }),
    steer: async () => ({ id: "req", ack: "delivered" }),
    // Mirrors both real backends: the dir exists only while the run's
    // status.json does (src/backends/pi.ts, src/backends/opencode.ts).
    asyncDirFor: (runId) => {
      const dir = join(runsDir, runId);
      return existsSync(join(dir, "status.json")) ? dir : null;
    },
  };
  const ctx = {
    stateDir,
    backend,
    storeOrNew: () => loadStore(stateDir) ?? newStore(),
    autopilot: () => null as never,
    cfg: () => ({ reviewerAgents: ["orchestrator-reviewer"] }) as never,
    emit: () => {},
    repoCheck: async () => ({ ok: true }),
    sessionCwd: tmpdir(),
  } as unknown as QueueOpsCtx;
  f = { stateDir, runsDir, spawns, backend, ctx };
});
afterEach(() => {
  rmSync(f.stateDir, { recursive: true, force: true });
  rmSync(f.runsDir, { recursive: true, force: true });
});

describe("queue_review — stale reviewerRunId no longer blocks the item", () => {
  test("stale id whose run dir is GONE → proceeds and clears the stale ref", async () => {
    seed(item("R1", { reviewerRunId: "dead-run-0001" })); // no run dir written
    const r = await queueReview(f.ctx, { key: "R1" });
    expect(r.text).toContain("reviewer dispatched");
    expect(r.text).toContain("dead-run");
    expect(f.spawns.length).toBe(1);
    expect(stored("R1").reviewerRunId).toBe("new-reviewer-1");
  });

  test("stale id whose status.json says COMPLETED → proceeds", async () => {
    writeRunStatus("done-run-0002", { runId: "done-run-0002", state: "complete" });
    seed(item("R2", { reviewerRunId: "done-run-0002" }));
    const r = await queueReview(f.ctx, { key: "R2" });
    expect(r.text).toContain("reviewer dispatched");
    expect(stored("R2").reviewerRunId).toBe("new-reviewer-1");
  });

  test("a GENUINELY running reviewer is still refused with the existing message", async () => {
    writeRunStatus("live-run-0003", { runId: "live-run-0003", state: "running" });
    seed(item("R3", { reviewerRunId: "live-run-0003" }));
    const r = await queueReview(f.ctx, { key: "R3" });
    expect(r.text).toContain(ALREADY_RUNNING);
    expect(f.spawns.length).toBe(0);
    expect(stored("R3").reviewerRunId).toBe("live-run-0003"); // ref preserved
  });

  test("liveness UNDETERMINABLE (unreadable status.json) → proceeds (fail-open)", async () => {
    writeGarbageRunStatus("murky-run-0004");
    seed(item("R4", { reviewerRunId: "murky-run-0004" }));
    const r = await queueReview(f.ctx, { key: "R4" });
    expect(r.text).toContain("reviewer dispatched");
    expect(stored("R4").reviewerRunId).toBe("new-reviewer-1");
  });
});

describe("reviewerRunAlive — the liveness surface", () => {
  test("queued and running are alive; terminal states are not", () => {
    writeRunStatus("q", { state: "queued" });
    writeRunStatus("r", { state: "running" });
    writeRunStatus("c", { state: "complete" });
    writeRunStatus("f", { state: "failed" });
    writeRunStatus("oc-run", { status: "running" }); // opencode record shape
    writeRunStatus("oc-done", { status: "completed" });
    expect(reviewerRunAlive(f.backend, "q")).toBe(true);
    expect(reviewerRunAlive(f.backend, "r")).toBe(true);
    expect(reviewerRunAlive(f.backend, "c")).toBe(false);
    expect(reviewerRunAlive(f.backend, "f")).toBe(false);
    expect(reviewerRunAlive(f.backend, "oc-run")).toBe(true);
    expect(reviewerRunAlive(f.backend, "oc-done")).toBe(false);
  });

  test("fail-open: no backend / null asyncDirFor / throwing backend → NOT alive", () => {
    expect(reviewerRunAlive(null, "x")).toBe(false);
    expect(reviewerRunAlive({ asyncDirFor: () => null }, "x")).toBe(false);
    expect(reviewerRunAlive({ asyncDirFor: () => { throw new Error("boom"); } }, "x")).toBe(false);
  });
});

describe("updateItem — entering ai-review clears the previous round's reviewer ref", () => {
  test("active → ai-review clears reviewerRunId; ai-review → ai-review does NOT", () => {
    const s = newStore();
    addItem(s, item("S1", { status: "active", runId: "w-1", reviewerRunId: "old-reviewer" }));
    updateItem(s, "S1", { status: "ai-review" });
    expect(s.items["S1"]!.reviewerRunId).toBeNull();

    addItem(s, item("S2", { reviewerRunId: "live-reviewer" }));
    updateItem(s, "S2", { status: "ai-review", notes: "re-stated" });
    expect(s.items["S2"]!.reviewerRunId).toBe("live-reviewer");

    // a metadata-only patch (no status) never touches the ref either
    updateItem(s, "S2", { notes: "metadata only" });
    expect(s.items["S2"]!.reviewerRunId).toBe("live-reviewer");
  });
});

describe("autoReview — the harness skips a LIVE reviewer, re-dispatches past a dead one", () => {
  test("live reviewer → skipped; dead reviewer → re-dispatched", async () => {
    writeRunStatus("live-run-0005", { runId: "live-run-0005", state: "running" });
    seed(item("A1", { reviewerRunId: "live-run-0005" }));
    seed(item("A2", { reviewerRunId: "dead-run-0006" })); // no run dir

    expect(await autoReview(f.stateDir, f.backend, "orchestrator-reviewer", "A1")).toBeNull();
    expect(stored("A1").reviewerRunId).toBe("live-run-0005");
    expect(f.spawns.length).toBe(0);

    expect(await autoReview(f.stateDir, f.backend, "orchestrator-reviewer", "A2")).toBe("new-reviewer-1");
    expect(stored("A2").reviewerRunId).toBe("new-reviewer-1");
    expect(f.spawns[0]).toContain("KEY: A2");
  });
});
