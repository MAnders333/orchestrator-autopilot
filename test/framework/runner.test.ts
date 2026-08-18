// test/framework/runner.test.ts — the shared tick machinery: identical
// trigger routing + gate + cooldown that BOTH hosts use (pi extension +
// opencode plugin). Host-agnostic — mock backend, real Autopilot + store.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { newStore, addItem } from "../../src/queue-store.ts";
import { createFrameworkRunner, type FrameworkRunner } from "../../src/framework/runner.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

interface Fixture {
  dir: string;
  delivered: string[];
  autopilot: Autopilot;
  runner: FrameworkRunner;
  busy: boolean;
  interactive: boolean;
  loaded: boolean;
  compacting: boolean;
  enabled: boolean;
}

const backend: SubagentBackend = {
  spawn: async () => "run-1",
  fleetStatus: async () => ({ totalActive: 0 }),
  steer: async () => "req-1",
  asyncDirFor: () => null,
};

function setup(opts: { sweepIntervalMs?: number } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "orch-runner-"));
  writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
  const f: Fixture = {
    dir,
    delivered: [],
    autopilot: new Autopilot({ stateDir: dir }),
    runner: null as never,
    busy: false,
    interactive: true,
    loaded: true,
    compacting: false,
    enabled: true,
  };
  f.runner = createFrameworkRunner({
    autopilot: f.autopilot,
    backend,
    host: {
      interactive: () => f.interactive,
      loaded: () => f.loaded,
      busy: () => f.busy,
      compacting: () => f.compacting,
    },
    deliver: (m) => f.delivered.push(m),
    enabled: () => f.enabled,
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
  });
  return f;
}

function seed(f: Fixture, key: string, over: Record<string, unknown> = {}): void {
  const s = load(f);
  addItem(s, { key, title: key.toLowerCase(), status: "approved", blocker: null, scope: "", evidence: "", value: "", urgency: "", risk: "", runId: null, notes: "", ...over });
  save(f, s);
}
function load(f: Fixture) { return JSON.parse(readFileSync(join(f.dir, "queue.json"), "utf8")); }
function save(f: Fixture, s: unknown) { writeFileSync(join(f.dir, "queue.json"), JSON.stringify(s)); }

describe("framework runner (shared tick machinery)", () => {
  test("onActivate with a ready item → dispatch tick delivered through the gate", () => {
    const f = setup();
    seed(f, "A1");
    f.runner.onActivate();
    return new Promise((r) => setTimeout(r, 50)).then(() => {
      expect(f.delivered.length).toBe(1);
      expect(f.delivered[0]).toContain("[orch-tick: dispatch]");
    });
  });

  test("REGRESSION: harness info is QUEUED while busy, flushed on settle (no mid-turn injection)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-busy-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const spawns: Array<{ task: string }> = [];
    const recBackend: SubagentBackend = {
      spawn: async (task) => { spawns.push({ task }); return "rev-1"; },
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req",
      asyncDirFor: () => null,
    };
    const delivered: string[] = [];
    const state = { busy: true }; // the agent is mid-turn — the exact moment completions land
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend: recBackend,
      host: { interactive: () => true, loaded: () => true, busy: () => state.busy, compacting: () => false },
      deliver: (m) => delivered.push(m),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    const s0 = load({ dir } as Fixture);
    addItem(s0, { key: "C1", title: "c1", status: "active", blocker: null, scope: "do the thing", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: "worker-1", reviewerRunId: null, attempts: 0, notes: "", createdAt: "a", updatedAt: "b" });
    save({ dir } as Fixture, s0);

    runner.onCompletion({ runId: "worker-1", agent: "worker", success: true, results: [{ agent: "worker" }] });
    await new Promise((r) => setTimeout(r, 120));

    expect(spawns.length).toBe(1); // the auto-review STILL happens while busy
    expect(delivered.some((m) => m.includes("[orch-tick: harness]"))).toBe(false); // NOT injected mid-turn

    state.busy = false; // the turn ends
    runner.onSettled();  // the queue flushes
    await new Promise((r) => setTimeout(r, 80));
    const harness = delivered.find((m) => m.includes("[orch-tick: harness]"));
    expect(harness).toBeTruthy(); // delivered at the settle boundary, not lost
  });

  test("the gate: busy / not-interactive / not-loaded / compacting all block delivery", async () => {
    const f = setup();
    seed(f, "A1");
    f.busy = true;
    f.runner.onActivate();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.busy = false;
    f.interactive = false;
    f.runner.onActivate();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.interactive = true;
    f.loaded = false;
    f.runner.onActivate();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.loaded = true;
    f.compacting = true;
    f.runner.onActivate();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.compacting = false;
    seed(f, "A2"); // queue hash changed → the quiet period allows a new tick
    f.runner.onActivate();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(1);
  });

  test("cooldown throttles rapid ticks (the double-fire dedupe)", async () => {
    const f = setup();
    seed(f, "A1");
    f.runner.onActivate();
    f.runner.onActivate(); // immediate second — within the 1500ms cooldown
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(1);
  });

  test("enabled=false stops triggers entirely (pi: autopilot off for the session)", async () => {
    const f = setup();
    seed(f, "A1");
    f.enabled = false;
    f.runner.onActivate();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
  });

  test("onCompletion: worker completion flips active→reviewing + frees the slot (fleet sweep)", async () => {
    const f = setup();
    seed(f, "W1", { status: "active", runId: "9be47d4f-0839-4c8f-9f41-71764658da3c" });
    seed(f, "B1"); // ready work for the freed-slot dispatch sweep to see
    f.runner.onCompletion({ runId: "9be47d4f-0839-4c8f-9f41-71764658da3c", agent: "workflow", success: true } as never);
    await new Promise((r) => setTimeout(r, 50));
    const st = load(f);
    expect(st.items["W1"].status).toBe("reviewing");
    // the freed slot → worker-done sweep → dispatch tick
    expect(f.delivered.some((m) => m.includes("[orch-tick: dispatch]"))).toBe(true);
  });

  test("onCompletion: reviewer Verdict: PASS → done + reviewTick", async () => {
    const f = setup();
    seed(f, "R1", { status: "reviewing" });
    const s = load(f);
    s.items["R1"].reviewerRunId = "12345678-dead-beef";
    save(f, s);
    f.runner.onCompletion({
      runId: "12345678-dead-beef-cafe",
      agent: "workflow",
      success: true,
      results: [{ agent: "orchestrator-reviewer", output: "Verdict: PASS\nClean.", runId: "12345678-dead-beef" }],
    } as never);
    await new Promise((r) => setTimeout(r, 50));
    const st = load(f);
    expect(st.items["R1"].status).toBe("done");
    expect(f.delivered.some((m) => m.includes("[orch-tick: review]"))).toBe(true);
  });

  test("REGRESSION: the stuck reviewTick (timer) does NOT claim 'A reviewer completed'", async () => {
    const f = setup();
    // all slots busy (fleet 3/3) + buffer full (2 ready) → the sweep yields
    // nothing → the reviewTick fallback nudges with the cause-aware wording.
    const s0 = load(f);
    addItem(s0, { key: "S1", title: "s1", status: "reviewing", blocker: null, scope: "x", cwd: "/tmp", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: "rev-live", attempts: 0, notes: "", createdAt: "a", updatedAt: "b" });
    addItem(s0, { key: "B1", title: "b1", status: "approved", blocker: null, scope: "x", cwd: "/tmp", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, attempts: 0, notes: "", createdAt: "a", updatedAt: "b" });
    addItem(s0, { key: "B2", title: "b2", status: "approved", blocker: null, scope: "x", cwd: "/tmp", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, attempts: 0, notes: "", createdAt: "a", updatedAt: "b" });
    save(f, s0);
    f.runner = createFrameworkRunner({
      autopilot: f.autopilot,
      backend: { ...backend, fleetStatus: async () => ({ totalActive: 3 }) },
      host: { interactive: () => f.interactive, loaded: () => f.loaded, busy: () => f.busy, compacting: () => f.compacting },
      deliver: (m) => f.delivered.push(m),
      enabled: () => f.enabled,
      sweepIntervalMs: 0,
    });
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 80));
    const stuck = f.delivered.find((m) => m.includes("[orch-tick: review]"));
    expect(stuck).toBeTruthy();
    expect(stuck).toContain("check each"); // cause-aware wording
    expect(stuck).not.toContain("A reviewer completed"); // the old false premise
    expect(stuck).toContain("still running");
  });

  test("onTimer + reviewTick fire even when the sweep has no tick (stuck-review nudge)", async () => {
    const f = setup();
    // all slots busy (fleet 3/3) + buffer full (2 ready) → the sweep yields
    // nothing (no dispatch, no intake) → the reviewTick fallback nudges.
    seed(f, "R1", { status: "reviewing" });
    seed(f, "B1");
    seed(f, "B2");
    f.runner = createFrameworkRunner({
      autopilot: f.autopilot,
      backend: { ...backend, fleetStatus: async () => ({ totalActive: 3 }) },
      host: {
        interactive: () => f.interactive,
        loaded: () => f.loaded,
        busy: () => f.busy,
        compacting: () => f.compacting,
      },
      deliver: (m) => f.delivered.push(m),
      enabled: () => f.enabled,
      sweepIntervalMs: 0,
    });
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.some((m) => m.includes("[orch-tick: review]"))).toBe(true);
  });
});

describe("auto-review (C) through the runner", () => {
  test("a worker completion flips to reviewing and auto-dispatches the reviewer + announces it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-ar-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const spawns: Array<{ task: string; agent?: string; cwd?: string }> = [];
    const recBackend: SubagentBackend = {
      spawn: async (task, o) => { spawns.push({ task, agent: o?.agent, cwd: o?.cwd }); return "rev-1"; },
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req",
      asyncDirFor: () => null,
    };
    const delivered: string[] = [];
    const autopilot = new Autopilot({ stateDir: dir });
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot,
      backend: recBackend,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    const s0 = load({ dir } as Fixture);
    addItem(s0, { key: "C1", title: "c1", status: "active", blocker: null, scope: "do the thing", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: "worker-1", reviewerRunId: null, attempts: 0, notes: "", createdAt: "a", updatedAt: "b" });
    save({ dir } as Fixture, s0);

    runner.onCompletion({ runId: "worker-1", agent: "worker", success: true, results: [{ agent: "worker" }] });
    await new Promise((r) => setTimeout(r, 150));

    expect(spawns.length).toBe(1);
    expect(spawns[0].agent).toBe("orchestrator-reviewer");
    expect(spawns[0].cwd).toBe("/tmp/repo");
    expect(spawns[0].task).toContain("KEY: C1");
    expect(spawns[0].task).toContain("Verdict: PASS");
    const after = load({ dir } as Fixture);
    expect(after.items["C1"].status).toBe("reviewing");
    expect(after.items["C1"].reviewerRunId).toBe("rev-1");
    runner.onSettled(); // the queued harness info flushes at the settle boundary
    await new Promise((r) => setTimeout(r, 80));
    const harness = delivered.find((m) => m.includes("[orch-tick: harness]"));
    expect(harness).toBeTruthy();
    expect(harness).toContain("reviewer for C1");
  });
});

describe("the shared autopilot gate (toggle off → harness idle)", () => {
  test("enabled=false → completions are IGNORED: no flip, no auto-review, no ticks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-gate-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const spawns: Array<{ task: string }> = [];
    const gateBackend: SubagentBackend = {
      spawn: async (task) => { spawns.push({ task }); return "rev-1"; },
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req",
      asyncDirFor: () => null,
    };
    const delivered: string[] = [];
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend: gateBackend,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      enabled: () => false, // the toggle is OFF
      sweepIntervalMs: 0,
    });
    const s0 = load({ dir } as Fixture);
    addItem(s0, { key: "C1", title: "c1", status: "active", blocker: null, scope: "do the thing", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: "worker-1", reviewerRunId: null, attempts: 0, notes: "", createdAt: "a", updatedAt: "b" });
    save({ dir } as Fixture, s0);

    runner.onCompletion({ runId: "worker-1", agent: "worker", success: true, results: [{ agent: "worker" }] });
    await new Promise((r) => setTimeout(r, 100));

    expect(load({ dir } as Fixture).items["C1"].status).toBe("active"); // NO flip
    expect(spawns.length).toBe(0);                                       // NO auto-review
    expect(delivered.length).toBe(0);                                    // NO ticks
  });
});
