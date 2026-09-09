// test/backends/pi-fleet.test.ts — AUTOPILOT-6 backend FLEET-vs-INVENTORY
// parity (review findings 1-3). The pi backend's fleetStatus() is the UNION of
// the session-gated RPC fleet and the in-flight async-run inventory on disk.
// pi-subagents' RPC `status → fleet.totalActive` counts only the caller
// session's LIVE runs (its fleet candidates are gated on the session id), so a
// workflow parent spawned pre-activation / cross-session / after a runtime
// restart reports as 0 while `subagent status fleet` still shows it running —
// the live "FLEET 0/3 while items ran" class. Counting the inventory's
// in-flight run dirs makes the FLEET number match the fleet view AND keeps
// zombie reconciliation from flipping LIVE workflow parents on an
// undercount-to-0.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiBackend } from "../../src/backends/pi.ts";
import type { PiLike } from "../../src/backends/types.ts";
import { newStore, addItem } from "../../src/queue-store.ts";
import { Autopilot } from "../../src/core.ts";
import { createFrameworkRunner } from "../../src/framework/runner.ts";

/** Fake pi whose status RPC answers with a FIXED fleet count — the test
 *  controls the RPC side; the inventory side is real files on disk under an
 *  injected temp asyncDirRoot. */
function mockPiWithFleet(totalActive: number): PiLike {
  const handlers: Record<string, Array<(data: unknown) => void>> = {};
  return {
    events: {
      on: (ch: string, h: (data: unknown) => void) => {
        (handlers[ch] ??= []).push(h);
        return () => {};
      },
      emit: (ch: string, payload: unknown) => {
        if (ch === "subagents:rpc:v1:request") {
          const req = payload as { requestId: string; method: string };
          if (req.method === "status") {
            for (const h of handlers[`subagents:rpc:v1:reply:${req.requestId}`] ?? []) {
              h({ success: true, data: { fleet: { totalActive, omitted: 0 } } });
            }
          }
        }
      },
    },
    on: () => {},
  } as unknown as PiLike;
}

describe("pi backend fleetStatus — the RPC count is never a fake 0 (AUTOPILOT-6)", () => {
  test("counts an in-flight workflow parent the RPC reports as 0 (matches `subagent status fleet`)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fleet-root-"));
    try {
      // A workflow parent the RPC cannot see: it started in an earlier session
      // / survived a restart — but its async-run dir still says running.
      const runId = "aaaaaaaa-0000-0000-0000-000000000001";
      mkdirSync(join(root, runId), { recursive: true });
      writeFileSync(join(root, runId, "status.json"), JSON.stringify({ runId, state: "running", mode: "workflow" }));
      const backend = createPiBackend(mockPiWithFleet(0), { asyncDirRoot: root });
      expect((await backend.fleetStatus())?.totalActive).toBe(1); // the RPC's 0 is never reported as idle
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty inventory → the RPC count is the floor (no inflation)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fleet-root-"));
    try {
      const backend = createPiBackend(mockPiWithFleet(3), { asyncDirRoot: root });
      expect((await backend.fleetStatus())?.totalActive).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the union is the MAX — the RPC count and the inventory count never double-report", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fleet-root-"));
    try {
      const runId = "bbbbbbbb-0000-0000-0000-000000000002";
      mkdirSync(join(root, runId), { recursive: true });
      writeFileSync(join(root, runId, "status.json"), JSON.stringify({ runId, state: "running", mode: "workflow" }));
      const backend = createPiBackend(mockPiWithFleet(5), { asyncDirRoot: root });
      expect((await backend.fleetStatus())?.totalActive).toBe(5); // RPC sees more (its session children) — floor wins
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminal runs, foreign dirs, and mismatched statuses never count as in-flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fleet-root-"));
    try {
      const live = "cccccccc-0000-0000-0000-000000000003";
      mkdirSync(join(root, live), { recursive: true });
      writeFileSync(join(root, live, "status.json"), JSON.stringify({ runId: live, state: "running", mode: "workflow" }));
      // completed run dir left on disk — must NOT count (state moved terminal)
      const done = "dddddddd-0000-0000-0000-000000000004";
      mkdirSync(join(root, done), { recursive: true });
      writeFileSync(join(root, done, "status.json"), JSON.stringify({ runId: done, state: "complete", mode: "workflow" }));
      // a dir whose status.json references a DIFFERENT run id — not this run
      mkdirSync(join(root, "eeeeeeee-0000-0000-0000-000000000005"), { recursive: true });
      writeFileSync(join(root, "eeeeeeee-0000-0000-0000-000000000005", "status.json"), JSON.stringify({ runId: "elsewhere", state: "running" }));
      // a foreign/control dir with no status.json — never counted
      mkdirSync(join(root, "junk-dir"), { recursive: true });
      const backend = createPiBackend(mockPiWithFleet(0), { asyncDirRoot: root });
      expect((await backend.fleetStatus())?.totalActive).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("zombie sweep never flips a LIVE workflow parent the RPC undercounts to 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fleet-root-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pi-fleet-zombie-"));
    try {
      const runId = "aaaaaaaa-0000-0000-0000-00000000beef";
      // the parent is IN FLIGHT on disk (children running under it)…
      mkdirSync(join(root, runId), { recursive: true });
      writeFileSync(join(root, runId, "status.json"), JSON.stringify({ runId, state: "running", mode: "workflow" }));
      // …its queue item sits active, idle past the 30m zombie grace
      const store = newStore();
      addItem(store, {
        key: "Z1", status: "active", blocker: null, title: "live workflow parent", scope: "s", cwd: "/tmp",
        evidence: "", value: "", urgency: "", risk: "low", runId, reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "",
      });
      store.items["Z1"].updatedAt = new Date(Date.now() - 45 * 60_000).toISOString();
      writeFileSync(join(stateDir, "queue.json"), JSON.stringify(store));
      const delivered: string[] = [];
      const runner = createFrameworkRunner({
        stateDir,
        autopilot: new Autopilot({ stateDir }),
        backend: createPiBackend(mockPiWithFleet(0), { asyncDirRoot: root }), // the RPC says 0…
        host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
        deliver: (m) => delivered.push(m),
        enabled: () => true,
        sweepIntervalMs: 0,
      });
      runner.onTimer(); // the zombie timer sweep — corrected fleet = 1 → no authority to flip
      await new Promise((r) => setTimeout(r, 120));
      const after = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"));
      expect(after.items["Z1"].status).toBe("active"); // the LIVE parent is never flipped to failed
      expect(delivered.some((m) => m.includes("zombie reconciliation"))).toBe(false);
      runner.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
