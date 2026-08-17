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
import { createOpenCodeFramework, readLatestText } from "../../src/hosts/opencode-framework.ts";
import { newStore, addItem, updateItem, saveStore as _save } from "../../src/queue-store.ts";
import { loadStore } from "../../src/queue-store.ts";

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
  // seed an empty store
  writeFileSync(join(stateDir, "queue.json"), JSON.stringify(newStore()));
  return f;
}

function store(f: Fixture) {
  return loadStore(f.stateDir)!;
}

function seedItem(f: Fixture, key: string, over: Record<string, unknown> = {}): void {
  const s = store(f);
  addItem(s, { key, title: key.toLowerCase(), status: "approved", ready: true, blocker: null, scope: "", evidence: "", value: "", urgency: "", risk: "", runId: null, notes: "", ...over });
  writeFileSync(join(f.stateDir, "queue.json"), JSON.stringify(s));
}

describe("opencode host framework (hermetic, fake oc)", () => {
  test("registers the six queue tools with arg specs", () => {
    const f = setup();
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0 });
    const names = Object.keys(fw.tools).sort();
    expect(names).toEqual(["queue_add", "queue_dispatch", "queue_list", "queue_review", "queue_steer", "queue_update"]);
    expect(fw.tools.queue_dispatch.args.some((a) => a.name === "task" && a.required)).toBe(true);
    expect(fw.tools.queue_list.args.some((a) => a.name === "includeNotes")).toBe(true);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("queue_add + queue_list mutate the store", async () => {
    const f = setup();
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0 });
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
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, onTick: (m) => f.ticks.push(m) });
    // seed an approved+ready item, then dispatch it
    seedItem(f, "W1");
    const r = await fw.tools.queue_dispatch.execute({ key: "W1", task: "SLEEP-1200 do work", cwd: f.repo });
    expect(r.details.runId).toBeTruthy();
    const runId = r.details.runId as string;
    expect(store(f).items["W1"].status).toBe("active");
    // the fake worker exits after ~1.2s → onComplete → flip to reviewing
    expect(await waitFor(() => store(f).items["W1"].status === "reviewing", 6000)).toBe(true);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("reviewer completion → Verdict: PASS → done", async () => {
    const f = setup("Verdict: PASS\\nEverything checks out.");
    const fw = createOpenCodeFramework({ stateDir: f.stateDir, runsDir: f.runsDir, ocBin: f.ocBin, sweepIntervalMs: 0, onDomainEvent: (e) => f.events.push(e) });
    seedItem(f, "R1", { status: "reviewing" });
    const r = await fw.tools.queue_review.execute({ key: "R1" });
    expect(r.details.runId).toBeTruthy();
    const runId = r.details.runId as string;
    const s = store(f);
    s.items["R1"].reviewerRunId = runId;
    writeFileSync(join(f.stateDir, "queue.json"), JSON.stringify(s));
    expect(await waitFor(() => store(f).items["R1"].status === "done", 6000)).toBe(true);
    expect(f.events.some((e) => e.name === "orch:reviewer-dispatched")).toBe(true);
    fw.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });

  test("readLatestText extracts the last text event", () => {
    const f = setup();
    const log = join(f.runsDir, "x", "output.jsonl");
    mkdirSync(join(f.runsDir, "x"), { recursive: true });
    writeFileSync(log, [
      '{"type":"text","part":{"id":"a","text":"first"}}',
      '{"type":"reasoning","part":{"id":"b"}}',
      '{"type":"text","part":{"id":"c","text":"Verdict: PASS\\nClean."}}',
      "not json",
    ].join("\n"));
    expect(readLatestText(log)).toContain("Verdict: PASS");
    expect(existsSync(log)).toBe(true);
    rmSync(f.root, { recursive: true, force: true });
  });
});
