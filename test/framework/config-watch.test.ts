// test/framework/config-watch.test.ts — a fleet-config CHANGE must reach the
// orchestrator (KEY: AUTOPILOT-48). The live failure: `/autopilot capacity 6`
// wrote autopilot.config.json and returned a message to the HUMAN's TUI; the
// orchestrator kept reasoning with "3 slots, all occupied" and told the user
// work was gated after that had become false. These pin the signal itself:
// it names OLD → NEW, it rides the [orch-tick] channel, and it fires ONCE.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { newStore } from "../../src/queue-store.ts";
import { createFrameworkRunner, type FrameworkRunner } from "../../src/framework/runner.ts";
import { detectConfigChanges, recordConfigSnapshot } from "../../src/framework/config-watch.ts";
import { loadAutopilotConfig } from "../../src/config.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";

const backend: SubagentBackend = {
  spawn: async () => "run-1",
  fleetStatus: async () => ({ totalActive: 0 }),
  steer: async () => ({ id: "req-1", ack: "delivered" as const }),
  asyncDirFor: () => null,
};

interface Fixture {
  dir: string;
  delivered: string[];
  runner: FrameworkRunner;
  loaded: boolean;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "orch-config-watch-"));
  writeFileSync(join(dir, "queue.json"), JSON.stringify(newStore()));
  const f: Fixture = { dir, delivered: [], runner: null as never, loaded: true };
  f.runner = createFrameworkRunner({
    stateDir: dir,
    autopilot: new Autopilot({ stateDir: dir }),
    backend,
    host: { interactive: () => true, loaded: () => f.loaded, busy: () => false, compacting: () => false },
    deliver: (m) => {
      f.delivered.push(m);
    },
    sweepIntervalMs: 0,
  });
  return f;
}

function writeConfig(f: Fixture, cfg: Record<string, unknown>): void {
  writeFileSync(join(f.dir, "autopilot.config.json"), JSON.stringify(cfg, null, 2));
}
function configTicks(f: Fixture): string[] {
  return f.delivered.filter((m) => m.startsWith("[orch-tick: config]"));
}
async function sweep(f: Fixture): Promise<void> {
  f.runner.onTimer();
  await new Promise((r) => setTimeout(r, 60));
}

describe("config-change signal (AUTOPILOT-48)", () => {
  test("a capacity change surfaces EXACTLY ONCE and names old → new", async () => {
    const f = setup();
    writeConfig(f, { maxSlots: 3 });
    await sweep(f);
    expect(configTicks(f)).toEqual([]); // first observation is a baseline, not a change

    writeConfig(f, { maxSlots: 6 });
    await sweep(f);
    const ticks = configTicks(f);
    expect(ticks.length).toBe(1);
    expect(ticks[0]).toContain("maxSlots");
    expect(ticks[0]).toContain("3 → 6");

    await sweep(f);
    await sweep(f);
    expect(configTicks(f).length).toBe(1); // not re-announced on every sweep
  });

  test("a change while no orchestrator is loaded is re-announced when one is", async () => {
    const f = setup();
    writeConfig(f, { maxSlots: 3 });
    await sweep(f);
    f.loaded = false; // permanent drop: nobody is listening
    writeConfig(f, { maxSlots: 6 });
    await sweep(f);
    expect(configTicks(f)).toEqual([]);
    f.loaded = true;
    await sweep(f);
    expect(configTicks(f).length).toBe(1);
    expect(configTicks(f)[0]).toContain("3 → 6");
  });

  test("shipping policy and worker agents ride the same signal", async () => {
    const f = setup();
    writeConfig(f, { maxSlots: 3, workerAgents: ["worker"], shipping: { mergeMode: "auto", repos: { "me/repo": { flow: "merge", baseBranches: ["main"] } } } });
    await sweep(f);
    expect(configTicks(f)).toEqual([]);

    writeConfig(f, { maxSlots: 3, workerAgents: ["worker", "fixer"], shipping: { mergeMode: "manual", repos: { "me/repo": { flow: "merge", baseBranches: ["main"] } } } });
    await sweep(f);
    const ticks = configTicks(f);
    expect(ticks.length).toBe(1);
    expect(ticks[0]).toContain("worker → worker,fixer");
    expect(ticks[0]).toContain("mergeMode auto");
    expect(ticks[0]).toContain("mergeMode manual");
  });

  test("detectConfigChanges: no snapshot → no change; a recorded snapshot makes the next edit a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-config-detect-"));
    writeFileSync(join(dir, "autopilot.config.json"), JSON.stringify({ maxSlots: 3 }));
    expect(detectConfigChanges(dir, loadAutopilotConfig(dir, {}))).toEqual([]);
    recordConfigSnapshot(dir, loadAutopilotConfig(dir, {}));
    writeFileSync(join(dir, "autopilot.config.json"), JSON.stringify({ maxSlots: 6 }));
    const changes = detectConfigChanges(dir, loadAutopilotConfig(dir, {}));
    expect(changes.length).toBe(1);
    expect(changes[0]).toMatchObject({ field: "maxSlots", from: "3", to: "6" });
  });
});
