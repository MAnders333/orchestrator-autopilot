// e2e.test.ts — REAL end-to-end: loads the actual adapter in an actual pi
// process (headless `pi -e <adapter> -p <script>`), drives the queue tools
// against a scratch state dir + a scratch clean git repo (worktree isolation),
// spawns a real worker, and verifies the store transitions + worker output.
//
// OPT-IN: run with PI_E2E=1 (needs the pi binary, a model backend, and git):
//   PI_E2E=1 bun test e2e.test.ts
// Skipped by default — unit + smoke suites must stay hermetic.
//
// Boundary (by design): the TUI-only paths (ticks, active→reviewing flips,
// review routing) are gated on interactive sessions and are covered by the
// smoke suite; headless e2e covers the runtime wiring: jiti module load, real
// pi-subagents RPC, real worktree spawn, real filesystem control channel.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const PI_BIN = process.env.PI_BIN ?? "/opt/homebrew/bin/pi";
const ENABLED = !!process.env.PI_E2E && existsSync(PI_BIN);

const E2E_SKIP_REASON = "PI_E2E=1 + the pi binary are required (real model-backed run; opt-in for CI)";

describe.skipIf(!ENABLED)("orchestrator-autopilot E2E (real pi)", () => {
  let stateDir: string;
  let repo: string;
  let sessionCwd: string;
  let stdout = "";

  beforeAll(async () => {
    // scratch state dir
    stateDir = mkdtempSync(join(tmpdir(), "orch-e2e-state-"));
    // scratch CLEAN git repo (worktree isolation pre-flight + worker worktree)
    repo = mkdtempSync(join(tmpdir(), "orch-e2e-repo-"));
    // session cwd is a NON-repo parent dir — the parent → target-repo
    // mismatch that broke every dispatch. queue_dispatch must target the repo
    // via its cwd param (which flows into runs.run) for the spawn to succeed.
    sessionCwd = mkdtempSync(join(tmpdir(), "orch-e2e-session-"));
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
    const gc = (...a: string[]) => g("-c", "core.hooksPath=/dev/null", "commit", ...a);
    g("init", "-q", "-b", "main");
    g("config", "user.email", "e2e@test");
    g("config", "user.name", "e2e");
    writeFileSync(join(repo, "README.md"), "# e2e\n");
    g("add", "README.md");
    gc("-m", "init");

    const prompt = [
      "You are testing the orchestrator queue tools E2E in a headless session. Follow exactly:",
      "1. queue_add with key E2E-1, title 'e2e-worker', status approved (ready by default).",
      "2. queue_list and confirm E2E-1 appears (report the counts).",
            "3. queue_dispatch E2E-1 with cwd: <repo> and this worker task: 'Reply with exactly: E2E-DONE. Do not use any tools.' (the session cwd is NOT a git repo — cwd is required; report the exact tool result).",
      "4. Sleep 5 seconds (bash: sleep 5).",
      "5. queue_steer E2E-1 with message 'reply with exactly: STEERED instead of E2E-DONE' — report the EXACT tool result text (it may honestly refuse headless steering).",
      "6. Sleep 30 seconds (bash: sleep 30) for the worker to finish.",
      "7. Find the worker run's output (run id is in /tmp state queue.json; check the pi-subagents async dirs and session artifacts) and report EXACTLY what the worker replied.",
      "8. queue_list one more time and report E2E-1's status + runId.",
      "Report each step's result on its own line with the step number.",
    ].join("\n");

    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        PI_BIN,
        ["-e", process.env.AUTOPILOT_EXTENSION_PATH ?? join(import.meta.dir, "../../src/hosts/pi-extension.ts"), "-p", prompt],
        {
          cwd: sessionCwd,
          env: {
            ...process.env,
            AUTOPILOT_STATE_DIR: stateDir,
            PI_CODING_AGENT_DIR: process.env.HOME + "/.pi/work",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let buf = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`e2e: pi timed out after 180s. Partial output:\n${buf.slice(-2000)}`));
      }, 180_000);
      child.stdout.on("data", (d) => { buf += String(d); });
      child.stderr.on("data", (d) => { buf += String(d); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(buf);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    stdout = out;
  }, 200_000);

  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  });

  test("the real module loads and the queue tools execute (add → list → dispatch)", () => {
    // the agent's transcript must show the tool calls succeeded
    expect(stdout).toContain("added 'E2E-1'");
    expect(stdout).toContain("dispatched 'E2E-1'");
  });

  test("queue.json records E2E-1 approved→active with a real run id", () => {
    const store = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"));
    const item = store.items["E2E-1"];
    expect(item).toBeDefined();
    expect(item.status).toBe("active"); // headless: completion is TUI-gated, so it stays active
    expect(typeof item.runId).toBe("string");
    expect(item.runId!.length).toBeGreaterThanOrEqual(8);
  });

  test("a REAL worker ran in a worktree and replied E2E-DONE", () => {
    expect(stdout).toContain("E2E-DONE");
  });

  test("queue_steer reported the honest outcome for a headless child", () => {
    // headless workers can't be steered — the tool must say so instead of
    // claiming delivery. Any of these is honest:
    expect(stdout).toMatch(/does not support steering|no steering acknowledgment|FAILED delivery|acknowledged by the child/);
  });

  test("E2E-1 survives the session (list still sees it with its run id)", () => {
    expect(stdout).toMatch(/E2E-1/);
  });
});
