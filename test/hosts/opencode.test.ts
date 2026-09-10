// test/hosts/opencode.test.ts — the opencode HOST framework: tools register,
// execute against the store, and the completion wiring (backend onComplete →
// handleAsyncComplete → queue flips + reviewer verdict routing) works with a
// fake `oc`. Hermetic; the REAL plugin registration is verified by loading the
// plugin in an actual opencode session (see the plugins/ dir + global config).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createOpenCodeFramework } from "../../src/hosts/opencode-plugin.ts";
import { newStore, addItem, updateItem, saveStore as _save } from "../../src/queue-store.ts";
import { loadStore } from "../../src/queue-store.ts";
import { writeSessionAutopilotState, autopilotCommand, isAutopilotOn, probeStateDir } from "../../src/config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

interface Fixture {
  root: string;
  stateDir: string;
  runsDir: string;
  repo: string;
  ocBin: string;
  ticks: string[];
  events: Array<{ name: string }>;
}

function setup(verdictText = ""): Fixture {
  const root = mkdtempSync(join(tmpdir(), "orch-oc-host-"));
  const stateDir = join(root, "state");
  const runsDir = join(root, "runs");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  const ocBin = join(root, "fake-oc");
  writeFileSync(ocBin, `#!/bin/bash
if [ "\${1}" != "run" ]; then exit 1; fi
shift
TASK="\$*"
if [[ "\$TASK" == *SLEEP-* ]]; then
  MS=\$(echo "\$TASK" | sed -E 's/.*SLEEP-([0-9]+).*/\\\\1/')
  sleep \$((MS / 1000))
fi
echo '{"type":"step_start","sessionID":"ses_test","timestamp":1,"part":{"id":"p1"}}'
echo '{"type":"text","sessionID":"ses_test","timestamp":2,"part":{"id":"p2","text":"${verdictText}"}}'
echo '{"type":"step_finish","sessionID":"ses_test","timestamp":3,"reason":"stop"}'
if [[ "\$TASK" == *FAIL* ]]; then exit 1; fi
exit 0
`);
  chmodSync(ocBin, 0o755);
  const f: Fixture = { root, stateDir, runsDir, repo: join(root, "repo"), ocBin, ticks: [], events: [] };
  // a clean temp git repo — dispatch's fail-closed repoCheck needs one
  mkdirSync(f.repo, { recursive: true });
  execFileSync("git", ["init", "-qb", "main"], { cwd: f.repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: f.repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: f.repo, stdio: "pipe" });
  writeFileSync(join(f.repo, "a.txt"), "x\n");
  execFileSync("git", ["add", "a.txt"], { cwd: f.repo, stdio: "pipe" });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "init"], { cwd: f.repo, stdio: "pipe" });
  // seed an empty store + autopilot ON (these framework tests exercise the
  // harness mechanics — the toggle gate is covered by the pi host tests)
  writeFileSync(join(stateDir, "queue.json"), JSON.stringify(newStore()));
  writeSessionAutopilotState(stateDir, "test-session", "on");
  return f;
}

/** A delivery stub with a REAL session target — the shared autopilot gate
 *  (enabled = isAutopilotOn(stateDir, target)) needs it; ticks go to f.ticks. */
function delivery(f: Fixture) {
  return { target: () => "test-session", setTarget: () => {}, deliver: (m: string) => f.ticks.push(m) };
}

function store(f: Fixture) {
  return loadStore(f.stateDir)!;
}

function seedItem(f: Fixture, key: string, over: Record<string, unknown> = {}): void {
  const s = store(f);
  addItem(s, { key, title: key.toLowerCase(), status: "approved", blocker: null, scope: "", evidence: "", value: "", urgency: "", risk: "", runId: null, notes: "", ...over });
  writeFileSync(join(f.stateDir, "queue.json"), JSON.stringify(s));
}

describe("opencode host framework (hermetic, fake oc)", () => {
  test("registers the six queue tools with arg specs", () => {
    const f = setup();
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, delivery: delivery(f) });
    const names = Object.keys(fw.tools).sort();
    expect(names).toEqual(["queue_add", "queue_dispatch", "queue_list", "queue_review", "queue_steer", "queue_update"]);
    expect(fw.tools.queue_dispatch.args.some((a) => a.name === "task" && a.required)).toBe(true);
    expect(fw.tools.queue_list.args.some((a) => a.name === "includeNotes")).toBe(true);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("STARTUP PROBE (AUTOPILOT-3): a vanished store warns via onProbeWarning at framework construction", () => {
    const f = setup();
    rmSync(join(f.stateDir, "queue.json")); // the store disappears (pre-migration projection / drift signature)
    const warnings: Array<{ ok: boolean; findings: string[] }> = [];
    const fw = createOpenCodeFramework({
      stateDir: f.stateDir,
      runsDir: f.runsDir,
      ocBin: f.ocBin,
      sweepIntervalMs: 0,
      delivery: delivery(f),
      commandFile: join(f.root, "command/orchestrate.md"),
      onProbeWarning: (r) => warnings.push(r),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].ok).toBe(false);
    expect(warnings[0].findings.some((x) => x.includes("EMPTY store"))).toBe(true);
    // the harness itself still constructed (fail-open)
    expect(Object.keys(fw.tools).length).toBe(6);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("ACTIVATION SWEEP is FAIL-OPEN (AUTOPILOT-3): an UNHEALTHY state dir still fills free slots", async () => {
    const f = setup();
    // The same unhealthy shape the `/autopilot on` path probes: an
    // orchestrate.md projection with NO STATE_DIR line — findings, not health.
    const commandFile = join(f.root, "command/orchestrate.md");
    mkdirSync(join(f.root, "command"), { recursive: true });
    writeFileSync(commandFile, "# orchestrate\nno Workspace block, so no STATE_DIR line\n");
    expect(probeStateDir({ stateDir: f.stateDir, commandFile }).ok).toBe(false);
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, delivery: delivery(f), commandFile });
    seedItem(f, "ACT1", { scope: "SLEEP-1200 do the thing", cwd: f.repo });
    // A probe finding must never cost the activation sweep ("never a throw,
    // never a block" — docs/queue-model.md): the free slot is filled anyway.
    fw.activate();
    expect(await waitFor(() => store(f).items["ACT1"].status === "active", 4000)).toBe(true);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  // The `autopilot` TOOL path (plugin adapter) asserts the same fall-through
  // one layer up — blocked on AUTOPILOT-WORKTREE-PRESERVATION-2's adapter
  // repair (the adapter assigns tools.autopilot before `const tools` and reads
  // bare stateDir/backend/schedules, so OrchestratorAutopilot cannot load).
  // Enable this once that lands.
  test.todo("autopilot tool: `on` with an UNHEALTHY state dir logs the probe AND still reaches schedules.cancel + fw.activate()");

  test("queue_add + queue_list mutate the store", async () => {
    const f = setup();
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, delivery: delivery(f) });
    const add = await fw.tools.queue_add.execute({ key: "TEST-1", title: "test one", notes: "free-form" });
    expect(add.text).toContain("added 'TEST-1'");
    const list = await fw.tools.queue_list.execute({});
    expect(list.text).toContain('"key": "TEST-1"');
    const item = store(f).items["TEST-1"];
    expect(item?.status).toBe("proposal");
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("worker completion flips active→reviewing (backend onComplete wiring)", async () => {
    const f = setup();
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, delivery: delivery(f), onTick: (m) => f.ticks.push(m) });
    // seed an approved+ready item, then dispatch it
    seedItem(f, "W1");
    const r = await fw.tools.queue_dispatch.execute({ key: "W1", task: "SLEEP-1200 do work", cwd: f.repo });
    expect(r.details.runId).toBeTruthy();
    const runId = r.details.runId as string;
    expect(store(f).items["W1"].status).toBe("active");
    // the fake worker exits after ~1.2s → onComplete → flip to reviewing
    expect(await waitFor(() => store(f).items["W1"].status === "ai-review", 6000)).toBe(true);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("reviewer completion → Verdict: PASS → human-review", async () => {
    const f = setup("Verdict: PASS\\nEverything checks out.");
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, delivery: delivery(f), onDomainEvent: (e) => f.events.push(e) });
    seedItem(f, "R1", { status: "ai-review" });
    const r = await fw.tools.queue_review.execute({ key: "R1" });
    expect(r.details.runId).toBeTruthy();
    const runId = r.details.runId as string;
    const s = store(f);
    s.items["R1"].reviewerRunId = runId;
    writeFileSync(join(f.stateDir, "queue.json"), JSON.stringify(s));
    // AI PASS → HUMAN review (your approval), NOT done
    expect(await waitFor(() => store(f).items["R1"].status === "human-review", 6000)).toBe(true);
    expect(f.events.some((e) => e.name === "orch:reviewer-dispatched")).toBe(true);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("scheduled off: arming fires the OFF delivery at the deadline; backstop covers a past deadline", async () => {
    const f = setup();
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, delivery: delivery(f) });
    // schedule through the SHARED command (keeps ON + persists the deadline);
    // the injected clock puts the deadline 100ms out, then arm exactly like
    // the autopilot tool does
    const at = Date.now() + 100;
    const r = autopilotCommand("off", "in 30m", { stateDir: f.stateDir, sessionId: "test-session", now: () => at - 30 * 60_000 });
    expect(r.ok).toBe(true);
    expect(r.scheduledOffAt).toBe(at);
    expect(isAutopilotOn(f.stateDir, "test-session")).toBe(true); // still ON until the deadline
    fw.schedules.schedule("test-session", r.scheduledOffAt!);
    expect(await waitFor(() => f.ticks.some((m) => m.includes("Autopilot is now OFF")), 2000)).toBe(true);
    expect(isAutopilotOn(f.stateDir, "test-session")).toBe(false); // fire path flips the state too
    expect(f.ticks.filter((m) => m.includes("Autopilot is now OFF")).length).toBe(1); // exactly once
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });

    // BACKSTOP (process-restart case): seed a PAST deadline with no armed
    // timer — the next enable-gate evaluation must flip OFF + deliver once.
    const f2 = setup();
    const fw2 = createOpenCodeFramework({ stateDir: f2.stateDir, runsDir: f2.runsDir, ocBin: f2.ocBin, sweepIntervalMs: 0, delivery: delivery(f2) });
    const p = join(f2.stateDir, "autopilot.sessions.json");
    const s = JSON.parse(readFileSync(p, "utf8"));
    s["test-session"] = { status: "on", updatedAt: new Date().toISOString(), scheduledOffAt: Date.now() - 1_000 };
    writeFileSync(p, JSON.stringify(s));
    fw2.onSettled(); // any trigger runs enabled() → due-check fires
    expect(await waitFor(() => !isAutopilotOn(f2.stateDir, "test-session"), 2000)).toBe(true);
    expect(f2.ticks.some((m) => m.includes("Autopilot is now OFF"))).toBe(true);
    fw2.dispose();
    rmSync(f2.root, { recursive: true, force: true });
  });
});
