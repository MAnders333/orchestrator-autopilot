// test/backends/opencode.test.ts — the opencode backend. Hermetic tests use a
// FAKE `oc` script (behavior driven by the task string: SLEEP-<ms> long runs,
// FAIL exit-1, HOLD never-exits) so nothing real is spawned; the opt-in REAL
// e2e (OPENCODE_E2E=1) spawns an actual `oc run` and verifies end-to-end.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenCodeBackend } from "../../src/backends/opencode.ts";

const ENABLED = process.env.OPENCODE_E2E === "1";

const FAKE_OC = `#!/bin/bash
# fake opencode — emits opencode-style JSONL events, exits per the task:
#   SLEEP-<ms>  sleep before emitting (long-running simulation)
#   FAIL        exit 1 after emitting
#   HOLD        never exit (stuck-run simulation)
if [ "\${1}" != "run" ]; then exit 1; fi
echo "BG=$OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS" >&2
shift
TASK="\$*"
if [[ "\$TASK" == *HOLD* ]]; then sleep 60; fi
if [[ "\$TASK" == *SLEEP-* ]]; then
  MS=\$(echo "\$TASK" | sed -E 's/.*SLEEP-([0-9]+).*/\\1/')
  sleep \$((MS / 1000))
fi
echo '{"type":"step_start","sessionID":"ses_testfake123","timestamp":1,"part":{"id":"p1"}}'
echo '{"type":"text","sessionID":"ses_testfake123","timestamp":2,"part":{"id":"p2","text":"done"}}'
echo '{"type":"step_finish","sessionID":"ses_testfake123","timestamp":3,"reason":"stop"}'
if [[ "\$TASK" == *FAIL* ]]; then exit 1; fi
exit 0
`;

interface Fixture {
  runsDir: string;
  ocBin: string;
  completions: Array<{ runId: string; status: string; exitCode: number | null }>;
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "orch-oc-backend-"));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const ocBin = join(root, "fake-oc");
  writeFileSync(ocBin, FAKE_OC);
  chmodSync(ocBin, 0o755);
  const completions: Fixture["completions"] = [];
  return { runsDir, ocBin, completions };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

function readStatus(f: Fixture, runId: string): Record<string, unknown> | null {
  const p = join(f.runsDir, runId, "status.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null;
}

describe("opencode backend (hermetic, fake oc)", () => {
  test("spawn writes a running record; asyncDirFor resolves; logs exist", async () => {
    const f = setup();
    const b = createOpenCodeBackend({ runsDir: f.runsDir, ocBin: f.ocBin });
    const runId = await b.spawn("hello", { agent: "worker", cwd: tmpdir() });
    expect(runId).toBeTruthy();
    const st = readStatus(f, runId);
    expect(st?.status).toBe("running");
    expect(st?.agent).toBe("worker");
    expect((st as { pid?: number })?.pid).toBeGreaterThan(0);
    expect(b.asyncDirFor(runId)).toBe(join(f.runsDir, runId));
    expect(b.asyncDirFor("no-such-run")).toBeNull();
    // cleanup: the child exits quickly on its own; wait + kill if needed
    await waitFor(() => readStatus(f, runId)?.status !== "running");
    rmSync(f.runsDir, { recursive: true, force: true });
  });

  test("exit flips status to completed; onComplete fires with the record", async () => {
    const f = setup();
    const b = createOpenCodeBackend({
      runsDir: f.runsDir,
      ocBin: f.ocBin,
      onComplete: (runId, rec) => f.completions.push({ runId, status: rec.status, exitCode: rec.exitCode }),
    });
    const runId = await b.spawn("plain task", { cwd: tmpdir() });
    expect(await waitFor(() => readStatus(f, runId)?.status === "completed")).toBe(true);
    expect(f.completions.length).toBe(1);
    expect(f.completions[0].status).toBe("completed");
    expect(f.completions[0].exitCode).toBe(0);
    expect(existsSync(join(f.runsDir, runId, "output.jsonl"))).toBe(true);
    expect(existsSync(join(f.runsDir, runId, "stderr.log"))).toBe(true);
    rmSync(f.runsDir, { recursive: true, force: true });
  });

  test("FAIL run → status failed + non-zero exitCode", async () => {
    const f = setup();
    const b = createOpenCodeBackend({ runsDir: f.runsDir, ocBin: f.ocBin });
    const runId = await b.spawn("FAIL task", { cwd: tmpdir() });
    expect(await waitFor(() => readStatus(f, runId)?.status === "failed")).toBe(true);
    expect((readStatus(f, runId) as { exitCode?: number })?.exitCode).not.toBe(0);
    rmSync(f.runsDir, { recursive: true, force: true });
  });

  test("fleetStatus counts running children only", async () => {
    const f = setup();
    const b = createOpenCodeBackend({ runsDir: f.runsDir, ocBin: f.ocBin });
    const a = await b.spawn("SLEEP-1500 a", { cwd: tmpdir() });
    const c = await b.spawn("SLEEP-3000 c", { cwd: tmpdir() });
    expect((await b.fleetStatus())?.totalActive).toBe(2);
    // a completes first (shorter sleep) → 1 running
    await waitFor(() => readStatus(f, a)?.status !== "running");
    expect((await b.fleetStatus())?.totalActive).toBe(1);
    await waitFor(() => readStatus(f, c)?.status !== "running");
    expect((await b.fleetStatus())?.totalActive).toBe(0);
    rmSync(f.runsDir, { recursive: true, force: true });
  });

  test("fleetStatus liveness: a running record with a dead pid counts 0", async () => {
    const f = setup();
    const b = createOpenCodeBackend({ runsDir: f.runsDir, ocBin: f.ocBin });
    // fabricate a run record whose pid is guaranteed dead (max pid)
    mkdirSync(join(f.runsDir, "dead-run"), { recursive: true });
    writeFileSync(
      join(f.runsDir, "dead-run/status.json"),
      JSON.stringify({ runId: "dead-run", agent: "worker", status: "running", startedAt: 1, exitCode: null, pid: 2147483647, logPath: "" }),
    );
    expect((await b.fleetStatus())?.totalActive).toBe(0);
    rmSync(f.runsDir, { recursive: true, force: true });
  });

  test("steer throws (headless runs have no steering channel)", async () => {
    const f = setup();
    const b = createOpenCodeBackend({ runsDir: f.runsDir, ocBin: f.ocBin });
    await expect(b.steer("some-run", "nudge")).rejects.toThrow(/no steering channel/);
    rmSync(f.runsDir, { recursive: true, force: true });
  });

  test("sessionId is captured best-effort from the output stream", async () => {
    const f = setup();
    const b = createOpenCodeBackend({ runsDir: f.runsDir, ocBin: f.ocBin });
    const runId = await b.spawn("plain", { cwd: tmpdir() });
    const ok = await waitFor(() => {
      const st = readStatus(f, runId) as { sessionId?: string } | null;
      return st?.sessionId === "ses_testfake123";
    }, 3000);
    expect(ok).toBe(true);
    await waitFor(() => readStatus(f, runId)?.status !== "running");
    rmSync(f.runsDir, { recursive: true, force: true });
  });
  test("spawn forces OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 on the child (framework dependency)", async () => {
    const f = setup();
    const b = createOpenCodeBackend({ runsDir: f.runsDir, ocBin: f.ocBin });
    const runId = await b.spawn("env check", { cwd: tmpdir() });
    await waitFor(() => readStatus(f, runId)?.status !== "running");
    const stderr = readFileSync(join(f.runsDir, runId, "stderr.log"), "utf8");
    expect(stderr).toContain("BG=1");
    rmSync(f.runsDir, { recursive: true, force: true });
  });
});

describe.skipIf(!ENABLED)("opencode backend REAL e2e (OPENCODE_E2E=1)", () => {
  test(
    "spawns a real oc run; completes; output contains the reply",
    async () => {
      const f = setup();
      const b = createOpenCodeBackend({
        runsDir: f.runsDir,
        ocBin: "oc",
        onComplete: (runId, rec) => f.completions.push({ runId, status: rec.status, exitCode: rec.exitCode }),
      });
      const runId = await b.spawn("reply with exactly OK", { agent: "build", cwd: tmpdir() });
      expect(await waitFor(() => readStatus(f, runId)?.status === "completed", 120_000)).toBe(true);
      expect(f.completions[0]?.exitCode).toBe(0);
      const output = readFileSync(join(f.runsDir, runId, "output.jsonl"), "utf8");
      expect(output).toContain("OK");
      rmSync(f.runsDir, { recursive: true, force: true });
    },
    { timeout: 180_000 },
  );
});
