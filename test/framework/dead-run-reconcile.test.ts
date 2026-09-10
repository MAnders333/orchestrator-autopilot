// test/framework/dead-run-reconcile.test.ts — AUTOPILOT-47 PROBLEM B. The
// historical gap: zombieReconcile is the ONLY sweep that condemns an `active`
// item, and it refuses unless the fleet is authoritatively IDLE
// (fleetTotalActive === 0). A busy queue never is — one live worker anywhere
// made every dead run in the store immune. Observed live: three runs sat
// dead-but-`active` for 117m, 287m and more while other workers ran, and every
// item gated behind them waited on a corpse.
//
// These tests pin the per-run net: a run whose OWN status.json says a terminal
// state, while the item says active and the fleet is busy, is SURFACED — and
// the fail-open boundary AUTOPILOT-20 chose is held exactly where it applies:
// an unreadable / missing / unrecognised status is absence of evidence and
// flips nothing.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { newStore, addItem, saveStore, loadStore, type QueueStore } from "../../src/queue-store.ts";
import { runStateEvidence, reviewerRunAlive } from "../../src/framework/run-liveness.ts";

const NOW = 1_800_000_000_000;
const STALE_UPDATED_AT = new Date(NOW - 117 * 60_000).toISOString(); // the observed 117m staleness
const FRESH_UPDATED_AT = new Date(NOW - 60_000).toISOString();

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "orch-dead-run-"));
}

/** A run dir whose status.json carries the given payload — the exact shape the
 *  hand audit read (`state`, `error`). Returns a backend stub resolving it. */
function runDirBackend(root: string, runs: Record<string, unknown | null>): { asyncDirFor: (id: string) => string | null } {
  for (const [runId, payload] of Object.entries(runs)) {
    const dir = join(root, runId);
    mkdirSync(dir, { recursive: true });
    if (payload !== null) writeFileSync(join(dir, "status.json"), typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  return { asyncDirFor: (id) => (Object.hasOwn(runs, id) ? join(root, id) : null) };
}

type Seed = { key: string; runId?: string | null; updatedAt: string };

function seed(stateDir: string, items: Seed[]): void {
  const store: QueueStore = newStore();
  for (const over of items) {
    addItem(store, {
      key: over.key,
      title: over.key,
      status: "active",
      blocker: null,
      scope: "s",
      cwd: tmpdir(),
      evidence: "",
      value: "",
      urgency: "",
      risk: "low",
      runId: null,
      reviewerRunId: null,
      timeoutMs: null,
      attempts: 0,
      notes: "",
      ...(over.runId !== undefined ? { runId: over.runId } : {}),
    });
  }
  // addItem stamps updatedAt at wall-clock now and updateItem re-stamps it, so
  // the intended staleness is written straight onto the record.
  for (const over of items) store.items[over.key]!.updatedAt = over.updatedAt;
  saveStore(stateDir, store);
}

describe("run state evidence — terminal is proof of death, undeterminable is not", () => {
  test("a parsed terminal phase is `terminal`; queued/running is `in-flight`", () => {
    const root = freshDir();
    try {
      const backend = runDirBackend(root, {
        dead: { state: "failed", error: "Subagent timed out after 1800000ms." },
        done: { state: "complete" },
        alive: { state: "running" },
        oc: { status: "stopped" },
      });
      const dead = runStateEvidence(backend, "dead");
      expect(dead.kind).toBe("terminal");
      expect(dead.kind === "terminal" && dead.error).toContain("timed out after 1800000ms");
      expect(runStateEvidence(backend, "done").kind).toBe("terminal");
      expect(runStateEvidence(backend, "oc").kind).toBe("terminal");
      expect(runStateEvidence(backend, "alive").kind).toBe("in-flight");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FAIL-OPEN BOUNDARY (AUTOPILOT-20): no backend, no dir, no/garbage status, unknown phase → undeterminable", () => {
    const root = freshDir();
    try {
      const backend = runDirBackend(root, { nostatus: null, garbage: "{not json", nophase: {}, weird: { state: "hibernating" } });
      expect(runStateEvidence(null, "x").kind).toBe("undeterminable");
      expect(runStateEvidence(backend, "never-existed").kind).toBe("undeterminable");
      expect(runStateEvidence(backend, "nostatus").kind).toBe("undeterminable");
      expect(runStateEvidence(backend, "garbage").kind).toBe("undeterminable");
      expect(runStateEvidence(backend, "nophase").kind).toBe("undeterminable");
      expect(runStateEvidence(backend, "weird").kind).toBe("undeterminable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reviewerRunAlive keeps its OWN fail direction: only queued/running blocks a reviewer", () => {
    const root = freshDir();
    try {
      const backend = runDirBackend(root, {
        running: { state: "running" },
        paused: { state: "paused" },
        failed: { state: "failed" },
        garbage: "{",
      });
      expect(reviewerRunAlive(backend, "running")).toBe(true);
      // paused/failed/garbage all mean "dispatch a reviewer" — unchanged by the
      // tri-state read, even though the sweep reads `paused` as alive.
      expect(reviewerRunAlive(backend, "paused")).toBe(false);
      expect(reviewerRunAlive(backend, "failed")).toBe(false);
      expect(reviewerRunAlive(backend, "garbage")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dead-run reconciliation — a dead run is surfaced even while the fleet is busy", () => {
  test("THE INCIDENT: item active, its status.json says failed, other workers running → flipped, not silently left", () => {
    const dir = freshDir();
    const root = freshDir();
    try {
      seed(dir, [
        { key: "AP-32", runId: "run-dead", updatedAt: STALE_UPDATED_AT },
        { key: "AP-99", runId: "run-live", updatedAt: STALE_UPDATED_AT },
      ]);
      const backend = runDirBackend(root, {
        "run-dead": { state: "failed", error: "Subagent timed out after 1800000ms." },
        "run-live": { state: "running" },
      });
      const ap = new Autopilot({ stateDir: dir });

      // The OLD net is structurally incapable here: the fleet is not idle.
      expect(ap.zombieReconcile(1, NOW).flippedKeys).toEqual([]);

      const dead = ap.deadRunReconcile((runId) => runStateEvidence(backend, runId), NOW);
      expect(dead.flippedKeys).toEqual(["AP-32"]);

      const store = loadStore(dir)!;
      expect(store.items["AP-32"]!.status).toBe("failed");
      // the run's own error routes recovery: a timeout kill is a CAP, not a verdict
      expect(store.items["AP-32"]!.failCause).toBe("budget-capped");
      expect(store.items["AP-32"]!.notes).toContain("dead-run reconciliation");
      expect(store.items["AP-32"]!.notes).toContain("run-dead");
      expect(store.items["AP-32"]!.notes).toContain("Subagent timed out after 1800000ms");
      // the live worker is untouched
      expect(store.items["AP-99"]!.status).toBe("active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a terminal run with no timeout error is a lost completion event → failCause zombie", () => {
    const dir = freshDir();
    const root = freshDir();
    try {
      seed(dir, [{ key: "AP-1", runId: "run-x", updatedAt: STALE_UPDATED_AT }]);
      const backend = runDirBackend(root, { "run-x": { state: "complete" } });
      const ap = new Autopilot({ stateDir: dir });
      expect(ap.deadRunReconcile((id) => runStateEvidence(backend, id), NOW).flippedKeys).toEqual(["AP-1"]);
      expect(loadStore(dir)!.items["AP-1"]!.failCause).toBe("zombie");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("undeterminable NEVER flips — the fail-open trade, held", () => {
    const dir = freshDir();
    const root = freshDir();
    try {
      seed(dir, [
        { key: "AP-A", runId: "gone", updatedAt: STALE_UPDATED_AT },
        { key: "AP-B", runId: "garbage", updatedAt: STALE_UPDATED_AT },
        { key: "AP-C", runId: "weird", updatedAt: STALE_UPDATED_AT },
      ]);
      const backend = runDirBackend(root, { garbage: "{", weird: { state: "hibernating" } });
      const ap = new Autopilot({ stateDir: dir });
      expect(ap.deadRunReconcile((id) => runStateEvidence(backend, id), NOW).flippedKeys).toEqual([]);
      const store = loadStore(dir)!;
      for (const k of ["AP-A", "AP-B", "AP-C"]) expect(store.items[k]!.status).toBe("active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("within the grace window nothing flips — the completion event is still allowed to land", () => {
    const dir = freshDir();
    const root = freshDir();
    try {
      seed(dir, [{ key: "AP-2", runId: "run-y", updatedAt: FRESH_UPDATED_AT }]);
      const backend = runDirBackend(root, { "run-y": { state: "failed" } });
      const ap = new Autopilot({ stateDir: dir });
      expect(ap.deadRunReconcile((id) => runStateEvidence(backend, id), NOW).flippedKeys).toEqual([]);
      expect(loadStore(dir)!.items["AP-2"]!.status).toBe("active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a throwing evidence lookup is undeterminable, never death", () => {
    const dir = freshDir();
    try {
      seed(dir, [{ key: "AP-3", runId: "run-z", updatedAt: STALE_UPDATED_AT }]);
      const ap = new Autopilot({ stateDir: dir });
      expect(ap.deadRunReconcile(() => { throw new Error("backend exploded"); }, NOW).flippedKeys).toEqual([]);
      expect(loadStore(dir)!.items["AP-3"]!.status).toBe("active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("zombieGraceMinutes 0 disables this sweep too", () => {
    const dir = freshDir();
    const root = freshDir();
    try {
      seed(dir, [{ key: "AP-4", runId: "run-w", updatedAt: STALE_UPDATED_AT }]);
      const backend = runDirBackend(root, { "run-w": { state: "failed" } });
      const ap = new Autopilot({ stateDir: dir, zombieGraceMinutes: 0 });
      expect(ap.deadRunReconcile((id) => runStateEvidence(backend, id), NOW).flippedKeys).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
