// test/framework/runner.test.ts — the shared tick machinery: identical
// trigger routing + gate + cooldown that BOTH hosts use (pi extension +
// opencode plugin). Host-agnostic — mock backend, real Autopilot + store.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { newStore, addItem, updateItem } from "../../src/queue-store.ts";
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
    stateDir: dir,
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
  test("forced sweep (timer) with a ready item → dispatch tick delivered through the gate", () => {
    const f = setup();
    seed(f, "A1");
    f.runner.onTimer();
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
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.busy = false;
    f.interactive = false;
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.interactive = true;
    f.loaded = false;
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.loaded = true;
    f.compacting = true;
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(0);
    f.compacting = false;
    seed(f, "A2"); // queue hash changed → the quiet period allows a new tick
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(1);
  });

  test("cooldown throttles rapid ticks (the double-fire dedupe)", async () => {
    const f = setup();
    seed(f, "A1");
    f.runner.onTimer();
    f.runner.onTimer(); // immediate second — within the 1500ms cooldown
    await new Promise((r) => setTimeout(r, 50));
    expect(f.delivered.length).toBe(1);
  });

  test("enabled=false stops triggers entirely (pi: autopilot off for the session)", async () => {
    const f = setup();
    seed(f, "A1");
    f.enabled = false;
    f.runner.onTimer();
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
    expect(st.items["W1"].status).toBe("ai-review");
    // the freed slot → worker-done sweep → dispatch tick
    expect(f.delivered.some((m) => m.includes("[orch-tick: dispatch]"))).toBe(true);
  });

  test("onCompletion: a budget-capped worker failure DELIVERS the failure tick (never silent) with the bigger-budget hint", async () => {
    const f = setup();
    seed(f, "W1", { status: "active", runId: "9be47d4f-0839-4c8f-9f41-71764658da3c", timeoutMs: 43_200_000 });
    f.runner.onCompletion({ runId: "9be47d4f-0839-4c8f-9f41-71764658da3c", agent: "worker", success: false, timedOut: true } as never);
    await new Promise((r) => setTimeout(r, 60));
    const st = load(f);
    expect(st.items["W1"].status).toBe("failed");
    expect(st.items["W1"].failCause).toBe("budget-capped");
    expect(f.delivered.some((m) => m.includes("[orch-tick: failure]") && m.includes("RE-DISPATCH WITH A BIGGER BUDGET"))).toBe(true);
  });

  test("onCompletion: reviewer Verdict: PASS → human-review + reviewTick", async () => {
    const f = setup();
    seed(f, "R1", { status: "ai-review", cwd: "/tmp/repo", risk: "low" });
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
    // AI PASS → HUMAN review (awaiting the user), NOT done — user approval flips done
    expect(st.items["R1"].status).toBe("human-review");
    expect(f.delivered.some((m) => m.includes("[orch-tick: review]"))).toBe(true);
    // DETERMINISTIC HANDOVER: the framework auto-flagged from the item
    const reviewLog = join(f.dir, "reviews.jsonl");
    expect(existsSync(reviewLog)).toBe(true);
    const flag = JSON.parse(readFileSync(reviewLog, "utf8"));
    expect(flag.event).toBe("flag_for_review");
    expect(flag.summary).toContain("agent review PASSED");
    expect(flag.risk).toBe("low"); // the seed item's risk
    expect(flag.review_targets[0]).toBe("/tmp/repo"); // hmm — the seed item's cwd
    expect(flag.queue_key).toBe("R1");
    expect(flag.self_reviewed).toBe(true);
  });

  test("REGRESSION: the stuck reviewTick (timer) does NOT claim 'A reviewer completed'", async () => {
    const f = setup();
    // all slots busy (fleet 3/3) + buffer full (2 ready) → the sweep yields
    // nothing → the reviewTick fallback nudges with the cause-aware wording.
    const s0 = load(f);
    addItem(s0, { key: "S1", title: "s1", status: "ai-review", blocker: null, scope: "x", cwd: "/tmp", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: "rev-live", attempts: 0, notes: "", createdAt: "a", updatedAt: "b" });
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
    seed(f, "R1", { status: "ai-review" });
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

  test("reviewTick surfaces HUMAN-review items awaiting your approval (tracked stage, not done)", async () => {
    const f = setup();
    // all slots busy (fleet 3/3) so the sweep yields no tick → the reviewTick
    // fallback nudges the HUMAN-review item awaiting your approval
    seed(f, "H1", { status: "human-review", cwd: "/tmp/repo", risk: "low" });
    seed(f, "B1");
    seed(f, "B2");
    f.runner = createFrameworkRunner({
      autopilot: f.autopilot,
      backend: { ...backend, fleetStatus: async () => ({ totalActive: 3 }) },
      host: { interactive: () => f.interactive, loaded: () => f.loaded, busy: () => f.busy, compacting: () => f.compacting },
      deliver: (m) => f.delivered.push(m),
      enabled: () => f.enabled,
      sweepIntervalMs: 0,
    });
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    const nudge = f.delivered.find((m) => m.includes("[orch-tick: review]"));
    expect(nudge).toBeTruthy();
    expect(nudge).toContain("H1");
    expect(nudge).toContain("Awaiting YOUR approval");
    expect(nudge).toContain("status: done to accept");
    // the item is NOT done — it is explicitly awaiting the human, not auto-complete
    expect(load(f).items["H1"].status).toBe("human-review");
  });

  test("zombie flips deliver the one-line DECISION tick (source: zombie) through the shared gate", async () => {
    const f = setup();
    seed(f, "Z1", { status: "active", runId: "deadfeed" });
    const st = load(f);
    st.items["Z1"].updatedAt = new Date(Date.now() - 45 * 60_000).toISOString(); // 45m idle > 30m grace
    save(f, st);
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(load(f).items["Z1"].status).toBe("failed"); // the flip applied
    const decision = f.delivered.find((m) => m.includes("[orch-tick: decision]"));
    expect(decision).toBeTruthy(); // the orchestrator learns the move, not by surprise
    expect(decision).toContain("Z1 failed: active → failed (zombie)");
    // the consolidated harness line (verify-branch guidance) still rides along
    expect(f.delivered.some((m) => m.includes("[orch-tick: harness]") && m.includes("zombie reconciliation flipped Z1"))).toBe(true);
  });

  // AUTOPILOT-47: the incident the fleet-gated zombie net could never catch —
  // a BUSY fleet keeps zombieReconcile silent forever, so a dead run's item sat
  // active for hours. The per-run net reads the run's own status.json instead.
  test("dead-run flips fire while the fleet is BUSY, from the run's own terminal status.json", async () => {
    const f = setup();
    const runsRoot = mkdtempSync(join(tmpdir(), "orch-runner-deadrun-"));
    mkdirSync(join(runsRoot, "deadrun"), { recursive: true });
    writeFileSync(
      join(runsRoot, "deadrun", "status.json"),
      JSON.stringify({ state: "failed", error: "Subagent timed out after 1800000ms." }),
    );
    seed(f, "D1", { status: "active", runId: "deadrun" });
    const st = load(f);
    st.items["D1"].updatedAt = new Date(Date.now() - 117 * 60_000).toISOString(); // the observed 117m staleness
    save(f, st);
    f.runner = createFrameworkRunner({
      stateDir: f.dir,
      autopilot: f.autopilot,
      backend: {
        ...backend,
        fleetStatus: async () => ({ totalActive: 2 }), // BUSY — the old net is mute here
        asyncDirFor: (id: string) => (id === "deadrun" ? join(runsRoot, id) : null),
      },
      host: { interactive: () => f.interactive, loaded: () => f.loaded, busy: () => f.busy, compacting: () => f.compacting },
      deliver: (m) => f.delivered.push(m),
      enabled: () => f.enabled,
      sweepIntervalMs: 0,
    });
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(load(f).items["D1"].status).toBe("failed");
    expect(load(f).items["D1"].failCause).toBe("budget-capped"); // the runtime's own timeout message routes it as a CAP
    expect(f.delivered.some((m) => m.includes("[orch-tick: harness]") && m.includes("dead-run reconciliation flipped D1"))).toBe(true);
    expect(f.delivered.some((m) => m.includes("[orch-tick: decision]") && m.includes("D1 failed: active → failed (dead-run)"))).toBe(true);
    rmSync(runsRoot, { recursive: true, force: true });
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
    expect(after.items["C1"].status).toBe("ai-review");
    expect(after.items["C1"].reviewerRunId).toBe("rev-1");
    runner.onSettled(); // the queued harness info flushes at the settle boundary
    await new Promise((r) => setTimeout(r, 80));
    const harness = delivered.find((m) => m.includes("[orch-tick: harness]"));
    expect(harness).toBeTruthy();
    expect(harness).toContain("reviewer for C1");
  });
});

describe("the shared deferral (framework-level: busy sends held + flushed at settle)", () => {
  test("a tick send while busy is DEFERRED by the runner + delivered at onSettled — host-agnostic", async () => {
    const f = setup();
    seed(f, "A1");
    f.busy = true;
    f.runner.onTimer(); // the sweep's tick → the router "deferred" → the runner holds it
    await new Promise((r) => setTimeout(r, 60));
    expect(f.delivered.length).toBe(0); // nothing injected mid-turn
    f.busy = false; // the agent settles (pi: agent_settled; opencode: session.idle)
    f.runner.onSettled();
    await new Promise((r) => setTimeout(r, 60));
    expect(f.delivered.length).toBeGreaterThan(0); // the deferred tick arrived at the settle
  });

  test("a deferred USER message (the /orchestrate injection) flushes via deliverUserMessage at the settle", async () => {
    const f = setup();
    const deliveredUser: Array<[string, Record<string, unknown> | undefined]> = [];
    f.runner = createFrameworkRunner({
      stateDir: f.dir,
      autopilot: f.autopilot,
      backend,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => f.delivered.push(m),
      deliverUserMessage: (m, o) => deliveredUser.push([m, o]),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    f.runner.deferUserMessage("/orchestrate", { expandPromptTemplates: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(deliveredUser.length).toBe(1); // the flush delivered it (host idle)
    expect(deliveredUser[0][0]).toBe("/orchestrate");
    expect(deliveredUser[0][1]).toEqual({ expandPromptTemplates: true });
  });
});

describe("AUTOPILOT-6: deferred ticks recompute FLEET/QUEUE facts at delivery (never generation-time)", () => {
  test("a dispatch tick deferred while busy is refreshed when flushed — CURRENT ready keys + CURRENT FLEET", async () => {
    const f = setup();
    seed(f, "A1");
    seed(f, "A2");
    f.busy = true;
    f.runner.onTimer(); // generation: FLEET 0/3, QUEUE 2 ready (A1, A2) → busy → deferred
    await new Promise((r) => setTimeout(r, 60));
    expect(f.delivered.length).toBe(0); // nothing injected mid-turn
    // mid-deferral the store moved: A1 dispatched (parent run) + A3 approved
    const s = load(f);
    updateItem(s, "A1", { status: "active", runId: "b0f7631f" });
    addItem(s, { key: "A3", title: "a3", status: "approved", blocker: null, scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: null, notes: "" });
    save(f, s);
    f.autopilot.handleAsyncStarted("b0f7631f", "workflow");
    f.busy = false;
    f.runner.onSettled(); // flush → delivery-time recompute
    await new Promise((r) => setTimeout(r, 80));
    const ticks = f.delivered.filter((m) => m.includes("[orch-tick:"));
    expect(ticks.length).toBe(1); // one truthful nudge — no stale + fresh duplicates
    expect(ticks[0]).toContain("[orch-tick: dispatch]");
    expect(ticks[0]).toContain("FLEET: 1/3"); // the parent run is counted NOW
    expect(ticks[0]).toContain("QUEUE: 2 ready (A2, A3)"); // CURRENT ready set
    expect(ticks[0]).not.toContain("FLEET: 0/3"); // generation-time facts never surface
    expect(ticks[0]).not.toContain("(A1, A2)");
  });

  test("a deferred dispatch tick whose slots filled mid-deferral never delivers 'X free' — the truthful current nudge", async () => {
    const f = setup();
    seed(f, "A1");
    seed(f, "A2");
    seed(f, "A3");
    f.busy = true;
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 60));
    expect(f.delivered.length).toBe(0);
    // all three dispatched while the session stayed busy → 0 free, 0 ready
    const s = load(f);
    for (const k of ["A1", "A2", "A3"]) {
      updateItem(s, k, { status: "active", runId: `run-${k}` });
      f.autopilot.handleAsyncStarted(`run-${k}`, "workflow");
    }
    save(f, s);
    f.busy = false;
    f.runner.onSettled();
    await new Promise((r) => setTimeout(r, 80));
    const ticks = f.delivered.filter((m) => m.includes("[orch-tick:"));
    expect(ticks.length).toBe(1);
    expect(ticks[0]).toContain("[orch-tick: intake]"); // current truth: buffer empty
    expect(ticks[0]).not.toContain("free"); // the stale "3 free" dispatch claim is gone
    expect(ticks[0]).toContain("approved buffer low");
  });

  test("auto-dispatch uses the fleet-vs-inventory UNION — an undercounting RPC cannot over-spawn (AUTOPILOT-6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-adspawn-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const s0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    // 3 live runs the RPC does NOT see (worktree-parent spawns went out via
    // queue_dispatch; the status call lags) + 2 auto-dispatchable approved.
    // The R-runs carry NO cwd: a completed worker auto-dispatches its REVIEWER
    // (AUTOPILOT-8), and the modern slot math (AUTOPILOT-9) counts an in-flight
    // reviewer against the pool — with a cwd, R1's reviewer would race the
    // sweep and consume the free slot before the union math saw it. cwd-less
    // R-runs keep the undercount-vs-union assertion deterministic.
    for (const k of ["R1", "R2", "R3"]) {
      addItem(s0, { key: k, title: k.toLowerCase(), status: "active", blocker: null, scope: "do it", evidence: "", value: "", urgency: "", risk: "low", runId: `run-${k}`, reviewerRunId: null, attempts: 0, notes: "" });
    }
    for (const k of ["B1", "B2"]) {
      addItem(s0, { key: k, title: k.toLowerCase(), status: "approved", blocker: null, scope: "do it", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, attempts: 0, notes: "" });
    }
    writeFileSync(join(dir, "queue.json"), JSON.stringify(s0));
    const workerSpawns: string[] = [];
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend: {
        spawn: async (task, o) => { if (!o?.agent) workerSpawns.push(String(task).split("\n")[0]); return `spawn-${workerSpawns.length}`; },
        fleetStatus: async () => ({ totalActive: 0 }), // the RPC undercounts: reports ZERO live runs
        steer: async () => "req",
        asyncDirFor: () => null,
      },
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: () => {},
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    runner.onCompletion({ runId: "run-R1", agent: "worker", success: true }); // → worker-done sweep → auto-dispatch A
    await new Promise((r) => setTimeout(r, 150));
    // R1 flipped → 2 of the 3 runs still live (store inventory) → exactly ONE
    // free slot. The union count leaves no phantom free slots to over-spawn.
    expect(workerSpawns.length).toBe(1);
    expect(workerSpawns[0]).toContain("KEY: B1"); // the OLDEST eligible item, one only
    runner.stop();
  });

  test("zombie sweep never sees a fake 0: a failed fleet status (null backend) passes undefined → no flips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-zombie-guard-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const s0 = { ...JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) };
    addItem(s0, { key: "Z1", title: "z1", status: "active", blocker: null, scope: "s", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: "live-run-1", reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "" });
    s0.items["Z1"].updatedAt = new Date(Date.now() - 3600_000).toISOString(); // idle past the 30m grace
    writeFileSync(join(dir, "queue.json"), JSON.stringify(s0));
    const delivered: string[] = [];
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend: { ...backend, fleetStatus: async () => null }, // the status RPC FAILED
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    runner.onTimer();
    await new Promise((r) => setTimeout(r, 80));
    const after = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(after.items["Z1"].status).toBe("active"); // NOT flipped — unknown fleet ≠ fake 0
    expect(delivered.some((m) => m.includes("zombie reconciliation"))).toBe(false);
    runner.stop();
  });
});

describe("AUTOPILOT-24: a NULL fleetStatus() degrades too — once the backend has PROVEN it can answer", () => {
  // The pi backend's rpc() NEVER rejects: a timeout resolves
  // {success:false,error} and fleetStatus() turns that into `null`
  // (src/backends/pi.ts). So the production failure mode is a null RETURN, not
  // a throw — but null is ALSO how the seam spells "I have no fleet view", so
  // the two are told apart by learned capability.
  interface NullFixture {
    dir: string;
    delivered: string[];
    runner: FrameworkRunner;
    fleet: { answer: { totalActive: number } | null };
  }
  function nullSetup(initial: { totalActive: number } | null): NullFixture {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-a24-null-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const delivered: string[] = [];
    const fleet = { answer: initial };
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir, log: () => {} }),
      backend: { ...backend, fleetStatus: async () => fleet.answer },
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    return { dir, delivered, runner, fleet };
  }
  const telemetry = (dir: string): Array<Record<string, unknown>> => {
    const f = join(dir, "autopilot.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const sweepOnce = async (r: FrameworkRunner): Promise<void> => {
    r.onTimer();
    await new Promise((res) => setTimeout(res, 60));
  };

  test("answered ONCE, then null forever: exactly ONE degraded tick, telemetry on EVERY failing sweep, ONE recovery tick", async () => {
    const f = nullSetup({ totalActive: 1 });
    await sweepOnce(f.runner); // the backend proves it has a fleet view
    f.fleet.answer = null; // … and then the status RPC starts timing out
    await sweepOnce(f.runner);
    await sweepOnce(f.runner);
    await sweepOnce(f.runner);
    const degraded = f.delivered.filter((m) => m.includes("DEGRADED: backend.fleetStatus()"));
    expect(degraded.length).toBe(1); // ONE notice for the whole episode, not one per sweep
    expect(degraded[0]).toContain("returned NULL"); // the null mode is NAMED, not reported as a throw
    expect(degraded[0]).toContain("zombie reconciliation is SUSPENDED");
    const failures = telemetry(f.dir).filter((l) => l.type === "fleet-rpc" && l.state === "failed");
    expect(failures.length).toBe(3); // every failing sweep is on the trail
    expect(failures.every((l) => l.mode === "null")).toBe(true);
    f.fleet.answer = { totalActive: 2 }; // the RPC comes back
    await sweepOnce(f.runner);
    expect(f.delivered.filter((m) => m.includes("fleet RPC RECOVERED")).length).toBe(1);
    expect(telemetry(f.dir).filter((l) => l.type === "fleet-rpc" && l.state === "recovered").length).toBe(1);
    // and a second failure AFTER recovery opens a NEW episode (the one-shot re-arms)
    f.fleet.answer = null;
    await sweepOnce(f.runner);
    expect(f.delivered.filter((m) => m.includes("DEGRADED: backend.fleetStatus()")).length).toBe(2);
    f.runner.stop();
  });

  test("ANTI-SPAM: a backend that ALWAYS returns null is UNSUPPORTED, not degraded — never a tick, never a telemetry line", async () => {
    const f = nullSetup(null); // never answers: the seam's legitimate 'no fleet view'
    for (let i = 0; i < 5; i++) await sweepOnce(f.runner);
    expect(f.delivered.filter((m) => m.includes("DEGRADED: backend.fleetStatus()"))).toEqual([]);
    expect(f.delivered.filter((m) => m.includes("fleet RPC RECOVERED"))).toEqual([]);
    expect(telemetry(f.dir).filter((l) => l.type === "fleet-rpc")).toEqual([]); // not even a growing jsonl
    f.runner.stop();
  });
});

describe("AUTOPILOT-24: a THROWING fleetStatus() degrades the sweep instead of aborting it", () => {
  // The bare `await opts.backend.fleetStatus()` used to skip zombie
  // reconciliation, auto-dispatch, recovery AND the engine sweep, then escape
  // as an unhandled rejection in the host process.
  interface ThrowFixture {
    dir: string;
    delivered: string[];
    engineLog: string[];
    spawns: string[];
    autopilot: Autopilot;
    runner: FrameworkRunner;
    fleet: { throws: boolean };
  }
  function throwingSetup(): ThrowFixture {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-a24-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const delivered: string[] = [];
    const engineLog: string[] = [];
    const spawns: string[] = [];
    const fleet = { throws: true };
    const autopilot = new Autopilot({ stateDir: dir, log: (l) => engineLog.push(l) });
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot,
      backend: {
        spawn: async (task) => { spawns.push(String(task)); return `run-${spawns.length}`; },
        fleetStatus: async () => {
          if (fleet.throws) throw new Error("status RPC exploded");
          return { totalActive: 0 };
        },
        steer: async () => "req",
        asyncDirFor: () => null,
      },
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => delivered.push(m),
      enabled: () => true,
      sweepIntervalMs: 0,
    });
    return { dir, delivered, engineLog, spawns, autopilot, runner, fleet };
  }
  const readStore = (dir: string) => JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
  const writeItems = (dir: string, items: Array<Record<string, unknown>>) => {
    const s = readStore(dir);
    for (const it of items) addItem(s, it as never);
    writeFileSync(join(dir, "queue.json"), JSON.stringify(s));
  };

  test("the RPC throws → auto-dispatch, recovery AND the engine sweep all still run in that SAME sweep", async () => {
    const f = throwingSetup();
    writeItems(f.dir, [
      { key: "A1", title: "a1", status: "approved", blocker: null, scope: "do the thing", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, attempts: 0, notes: "" },
      { key: "F1", title: "f1", status: "failed", blocker: null, scope: "redo the thing", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: "dead-run", reviewerRunId: null, attempts: 0, notes: "", failCause: "verdict", recoveries: 0, recoveryNotBefore: Date.now() - 60_000, recoveryEscalated: false },
    ]);
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 120));
    const after = readStore(f.dir);
    expect(after.items["A1"].status).toBe("active"); // auto-dispatch ran past the failed RPC
    expect(after.items["F1"].status).toBe("active"); // runRecoveryPass ran too
    expect(f.spawns.some((t) => t.includes("KEY: A1"))).toBe(true);
    expect(f.spawns.some((t) => t.includes("KEY: F1") && t.includes("Recovery re-dispatch (P5)"))).toBe(true);
    // the engine sweep itself reached its own telemetry line — nothing below
    // the RPC was skipped
    expect(f.engineLog.some((l) => JSON.parse(l).type === "sweep")).toBe(true);
  });

  test("SAFETY: a throwing RPC never causes a zombie flip — unknown is UNKNOWN, never a fake 0", async () => {
    const f = throwingSetup();
    writeItems(f.dir, [
      { key: "Z1", title: "z1", status: "active", blocker: null, scope: "s", cwd: "/tmp/repo", evidence: "", value: "", urgency: "", risk: "low", runId: "live-run", reviewerRunId: null, attempts: 0, notes: "" },
    ]);
    const s = readStore(f.dir);
    s.items["Z1"].updatedAt = new Date(Date.now() - 60 * 60_000).toISOString(); // 60m idle >> 30m grace
    writeFileSync(join(f.dir, "queue.json"), JSON.stringify(s));
    f.runner.onTimer(); // timer = the only source that runs the zombie net
    await new Promise((r) => setTimeout(r, 120));
    expect(readStore(f.dir).items["Z1"].status).toBe("active"); // a transient blip must never destroy run attribution
    expect(f.delivered.some((m) => m.includes("zombie reconciliation flipped"))).toBe(false);
    expect(f.delivered.some((m) => m.includes("[orch-tick: decision]"))).toBe(false);
    // and the engine primitive itself: undefined refuses, a genuine 0 flips
    expect(f.autopilot.zombieReconcile(undefined).flippedKeys).toEqual([]);
    expect(readStore(f.dir).items["Z1"].status).toBe("active");
    expect(f.autopilot.zombieReconcile(0).flippedKeys).toEqual(["Z1"]); // the guard is unknown-vs-zero, not "never flip"
  });

  test("the degradation is VISIBLE but not spammy: one tick per episode + one on recovery", async () => {
    const f = throwingSetup();
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 80));
    f.runner.onTimer(); // still failing — same episode
    await new Promise((r) => setTimeout(r, 80));
    const degraded = f.delivered.filter((m) => m.includes("DEGRADED: backend.fleetStatus() THREW"));
    expect(degraded.length).toBe(1); // ONE notice for the whole episode
    expect(degraded[0]).toContain("status RPC exploded"); // the RPC failure is NAMED
    expect(degraded[0]).toContain("[orch-tick: harness]");
    f.fleet.throws = false; // the backend comes back
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 80));
    expect(f.delivered.filter((m) => m.includes("fleet RPC RECOVERED")).length).toBe(1);
    expect(f.delivered.filter((m) => m.includes("DEGRADED: backend.fleetStatus() THREW")).length).toBe(1);
    // both transitions are on the telemetry trail too
    const lines = readFileSync(join(f.dir, "autopilot.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === "fleet-rpc" && l.state === "failed").length).toBe(2); // every failure logged
    expect(lines.filter((l) => l.type === "fleet-rpc" && l.state === "failed").every((l) => l.mode === "threw")).toBe(true);
    // a THROW degrades even though this backend never answered successfully:
    // the seam spells 'unsupported' as null, never as an exception
    expect(degraded[0]).toContain("THREW");
    expect(lines.filter((l) => l.type === "fleet-rpc" && l.state === "recovered").length).toBe(1);
  });

  test("a sweep that throws internally is CAUGHT at the call site — no unhandled rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-a24-catch-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const delivered: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const runner = createFrameworkRunner({
        stateDir: dir,
        autopilot: new Autopilot({ stateDir: dir }),
        backend,
        host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
        deliver: (m) => delivered.push(m),
        enabled: () => { throw new Error("gate blew up"); }, // the first statement in sweep()
        sweepIntervalMs: 0,
      });
      runner.onTimer();
      runner.onSettled();
      runner.activate();
      await new Promise((r) => setTimeout(r, 120));
      expect(unhandled.length).toBe(0); // the host process never sees a stray rejection
      const failures = delivered.filter((m) => m.includes("SWEEP FAILED"));
      expect(failures.length).toBe(1); // recorded once per failing episode, not per trigger
      expect(failures[0]).toContain("gate blew up");
      const lines = readFileSync(join(dir, "autopilot.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const recorded = lines.filter((l) => l.type === "sweep-failure");
      expect(recorded.length).toBe(3); // EVERY call site records — timer, settled, activate
      expect(recorded.map((l) => l.source).sort()).toEqual(["activate", "settled", "timer"]);
      runner.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

  test("ASYNC delivery rejection → re-deferred, retried after backoff, delivered exactly once", async () => {
    // The pi settled-vs-teardown race: sendMessage resolves, then the runtime
    // rejects the triggered turn. The tick must NOT be lost (the old behavior
    // dropped it) and must not double-deliver.
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-async-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const delivered: string[] = [];
    let calls = 0;
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: (m) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("Agent is already processing a prompt."));
        delivered.push(m);
        return undefined;
      },
      enabled: () => true,
      sweepIntervalMs: 0,
      deliveryRetryDelayMs: 10,
    });
    runner.onTimer(); // activation sweep → tick fires through the gate
    await new Promise((r) => setTimeout(r, 5));
    expect(delivered.length).toBe(0); // first attempt failed async — NOT counted as delivered
    await new Promise((r) => setTimeout(r, 40)); // backoff elapses → retry
    expect(delivered.length).toBe(1); // recovered at the retry
    expect(delivered[0]).toContain("[orch-tick:");
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered.length).toBe(1); // exactly once — no duplicate flushes
    expect(calls).toBe(2);
  });

  test("ASYNC delivery rejection is bounded — a permanently rejecting runtime drops after max attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-cap-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    let calls = 0;
    const runner = createFrameworkRunner({
      stateDir: dir,
      autopilot: new Autopilot({ stateDir: dir }),
      backend,
      host: { interactive: () => true, loaded: () => true, busy: () => false, compacting: () => false },
      deliver: () => {
        calls += 1;
        return Promise.reject(new Error("still broken"));
      },
      enabled: () => true,
      sweepIntervalMs: 0,
      deliveryRetryDelayMs: 5,
    });
    runner.onTimer();
    // max 5 attempts + scheduling slack
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBeLessThanOrEqual(6); // bounded — no infinite hot loop
    runner.stop();
  });
});

describe("AUTOPILOT-9: auto-dispatch fills free slots on EVERY free-slot window (idle slots never strand approved items)", () => {
  // A recording fixture: real store + real Autopilot + real runner; the only
  // mock is the backend (spawn/fleet RPC), exactly like the pi host wires it.
  function quickSetup(over: { enabled?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "orch-runner-a9-"));
    writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
    const spawns: Array<{ task: string; cwd?: string }> = [];
    const backend: SubagentBackend = {
      spawn: async (task, o) => {
        spawns.push({ task, cwd: o?.cwd });
        return `run-${spawns.length}`;
      },
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
      enabled: () => over.enabled ?? true,
      sweepIntervalMs: 0,
    });
    const save = (items: Array<Record<string, unknown>>) => {
      const s = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
      for (const it of items) addItem(s, it as never);
      writeFileSync(join(dir, "queue.json"), JSON.stringify(s));
    };
    const load = () => JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    return { dir, spawns, delivered, runner, save, load };
  }
  function eligible(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      key,
      title: key.toLowerCase(),
      status: "approved",
      blocker: null,
      scope: "do the thing",
      cwd: "/tmp/repo",
      evidence: "",
      value: "",
      urgency: "",
      risk: "low",
      runId: null,
      reviewerRunId: null,
      attempts: 0,
      notes: "",
      createdAt: "a",
      updatedAt: "b",
      ...over,
    };
  }

  test("TIMER sweep with a free slot auto-dispatches the eligible item (the old code only filled on worker-done)", async () => {
    const f = quickSetup();
    f.save([eligible("A1")]);
    f.runner.onTimer(); // idle periodic sweep — a free slot + approved work
    await new Promise((r) => setTimeout(r, 80));
    expect(f.spawns.length).toBe(1); // the harness acted WITHOUT any worker-done event
    expect(f.spawns[0].task).toContain("KEY: A1");
    expect(f.spawns[0].cwd).toBe("/tmp/repo");
    expect(f.load().items["A1"].status).toBe("active");
    const harness = f.delivered.find((m) => m.includes("[orch-tick: harness]"));
    expect(harness).toBeTruthy();
    expect(harness).toContain("dispatched A1");
  });

  test("SETTLED sweep (an orchestrator turn ended) with a free slot + approved work auto-dispatches too", async () => {
    const f = quickSetup();
    f.save([eligible("B1")]);
    f.runner.onSettled();
    await new Promise((r) => setTimeout(r, 80));
    expect(f.spawns.length).toBe(1);
    expect(f.load().items["B1"].status).toBe("active");
  });

  test("activate() (the /autopilot on sweep) fills free slots IMMEDIATELY — the early-ON window no longer strands", async () => {
    const f = quickSetup();
    f.save([eligible("C1")]);
    f.runner.activate();
    await new Promise((r) => setTimeout(r, 80));
    expect(f.spawns.length).toBe(1);
    expect(f.load().items["C1"].status).toBe("active");
  });

  test("OFF gate holds on EVERY new sweep source: no auto-dispatch, no ticks (periodic/settled/activate)", async () => {
    const f = quickSetup({ enabled: false });
    f.save([eligible("D1")]);
    f.runner.onTimer();
    f.runner.onSettled();
    f.runner.activate();
    await new Promise((r) => setTimeout(r, 80));
    expect(f.spawns.length).toBe(0); // NO auto-dispatch anywhere while OFF
    expect(f.delivered.length).toBe(0); // NO ticks
    expect(f.load().items["D1"].status).toBe("approved"); // untouched
  });

  test("slot math uses the fleet-vs-inventory UNION so an undercounting RPC cannot over-spawn", async () => {
    const f = quickSetup();
    // 1 active run the RPC does NOT see (status call lags a just-started
    // parent) + 3 eligible approved. The union says 2 free slots → exactly 2
    // spawns; the RPC-only math would have spawned 3.
    f.save([
      eligible("LIVE1", { status: "active", runId: "run-live" }),
      eligible("E1"),
      eligible("E2", { updatedAt: "c" }),
      eligible("E3", { updatedAt: "d" }),
    ]);
    f.runner.onTimer();
    await new Promise((r) => setTimeout(r, 80));
    expect(f.spawns.map((s) => s.task.split(/\n/)[0])).toEqual(["KEY: E1", "KEY: E2"]); // 2 free, not 3
    expect(f.load().items["E3"].status).toBe("approved"); // no slot left
  });
});

