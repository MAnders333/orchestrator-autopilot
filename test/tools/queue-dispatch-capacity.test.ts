// test/tools/queue-dispatch-capacity.test.ts — the fleet cap must bind the
// MANUAL lane too (KEY: AUTOPILOT-48). auto-dispatch has always honoured
// maxSlots; queue_dispatch consulted it nowhere, so a live queue_list read
// occupied 11 / totalActive 5 against maxSlots 3 with nothing refusing — while
// ~8 concurrent workers had already caused provider-level failures. The chosen
// behaviour: REFUSE at/above capacity, with an explicit one-parameter override
// named in the refusal so the deliberate path is never stranded.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { newStore, addItem, saveStore, loadStore, type QueueItem, type QueueStore } from "../../src/queue-store.ts";
import { queueDispatch, type QueueOpsCtx } from "../../src/tools/queue-ops.ts";
import { loadAutopilotConfig } from "../../src/config.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

function item(key: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    status: "approved",
    blocker: null,
    title: key,
    scope: "do the thing",
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    cwd: null,
    runId: null,
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    notes: "",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...over,
    key,
  };
}

interface Fixture {
  ctx: QueueOpsCtx;
  dir: string;
  spawns: number;
  store(): QueueStore;
}

function setup(opts: { maxSlots: number; active: number; fleetTotalActive?: number | null; fleetThrows?: boolean }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "orch-dispatch-cap-"));
  const store = newStore();
  addItem(store, item("CAP-1"));
  for (let i = 0; i < opts.active; i++) addItem(store, item(`ACT-${i}`, { status: "active", runId: `run-active-${i}` }));
  saveStore(dir, store);
  writeFileSync(join(dir, "autopilot.config.json"), JSON.stringify({ maxSlots: opts.maxSlots }));
  const f: Fixture = { ctx: null as never, dir, spawns: 0, store: () => loadStore(dir)! };
  const backend: SubagentBackend = {
    spawn: async () => {
      f.spawns += 1;
      return "run-new";
    },
    fleetStatus: async () => {
      if (opts.fleetThrows) throw new Error("status RPC down");
      return opts.fleetTotalActive === undefined ? null : opts.fleetTotalActive === null ? null : { totalActive: opts.fleetTotalActive };
    },
    steer: async () => ({ id: "req-1", ack: "delivered" as const }),
    asyncDirFor: () => null,
  };
  const autopilot = new Autopilot({ stateDir: dir });
  f.ctx = {
    stateDir: dir,
    backend,
    storeOrNew: () => loadStore(dir) ?? newStore(),
    autopilot: () => autopilot,
    cfg: () => loadAutopilotConfig(dir, {}),
    emit: () => {},
    repoCheck: async () => ({ ok: true }),
    sessionCwd: dir,
  };
  return f;
}

describe("queue_dispatch capacity gate (AUTOPILOT-48)", () => {
  test("below capacity → dispatches normally", async () => {
    const f = setup({ maxSlots: 3, active: 1 });
    const r = await queueDispatch(f.ctx, { key: "CAP-1", task: "KEY: CAP-1", cwd: f.dir });
    expect(r.text).toContain("dispatched 'CAP-1'");
    expect(f.spawns).toBe(1);
    expect(f.store().items["CAP-1"].status).toBe("active");
  });

  test("at capacity → REFUSES, spawns nothing, leaves the item dispatchable", async () => {
    const f = setup({ maxSlots: 2, active: 2 });
    const r = await queueDispatch(f.ctx, { key: "CAP-1", task: "KEY: CAP-1", cwd: f.dir });
    expect(r.text).toContain("AT CAPACITY");
    expect(r.text).toContain("2 of 2");
    expect(f.spawns).toBe(0);
    expect(f.store().items["CAP-1"].status).toBe("approved");
    expect(r.details).toMatchObject({ occupied: 2, maxSlots: 2, refused: "capacity" });
  });

  test("the refusal TELLS the operator how to override — it never strands the work silently", async () => {
    const f = setup({ maxSlots: 2, active: 2 });
    const r = await queueDispatch(f.ctx, { key: "CAP-1", task: "KEY: CAP-1", cwd: f.dir });
    expect(r.text).toContain("overrideCapacity: true");
    expect(r.text).toContain("/autopilot capacity <n>");
  });

  test("overrideCapacity: true → dispatches and says it went ABOVE capacity", async () => {
    const f = setup({ maxSlots: 2, active: 2 });
    const r = await queueDispatch(f.ctx, { key: "CAP-1", task: "KEY: CAP-1", cwd: f.dir, overrideCapacity: true });
    expect(r.text).toContain("dispatched 'CAP-1'");
    expect(r.text).toContain("ABOVE capacity");
    expect(f.spawns).toBe(1);
    expect(r.details).toMatchObject({ overCapacity: true });
  });

  test("the backend fleet count binds too — a fleet fuller than the store still refuses", async () => {
    const f = setup({ maxSlots: 3, active: 0, fleetTotalActive: 5 });
    const r = await queueDispatch(f.ctx, { key: "CAP-1", task: "KEY: CAP-1", cwd: f.dir });
    expect(r.text).toContain("AT CAPACITY");
    expect(r.text).toContain("5 of 3");
    expect(f.spawns).toBe(0);
  });

  test("an UNKNOWN fleet (RPC throws) is not read as full — the store count still decides", async () => {
    const f = setup({ maxSlots: 3, active: 1, fleetThrows: true });
    const r = await queueDispatch(f.ctx, { key: "CAP-1", task: "KEY: CAP-1", cwd: f.dir });
    expect(r.text).toContain("dispatched 'CAP-1'");
    expect(f.spawns).toBe(1);
  });
});
