// pi-extension.test.ts — loads the REAL pi adapter (src/hosts/pi-extension.ts) with
// a mocked ExtensionAPI and verifies the
// wiring: migration, queue tools (add/update/dispatch via RPC), event-driven
// completion flips, per-session gating, and child-process inertness.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolveStateDir, isAutopilotOn } from "../../src/config.ts";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY_MD = `# Orchestrator State
updated: 2026-08-16T11:10Z

## Active (max 3 slots)
G1: [task one] — worker run 371d1bb9, status: working

## Approved
A6: [Koop migration research] — risk: low | blockers: none.

## Backlog
B1: [circleback] candidate
`;

function mockPi() {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  const sent: Array<{ kind: string; args: any[] }> = [];
  const emitted: Array<{ channel: string; payload: any }> = [];
  let commands: Record<string, any> = {};
  let tools: Record<string, any> = {};
  // Model the RUNTIME's busy contract faithfully: the agent is busy between
  // agent_start and agent_settled, and a triggerTurn sendMessage mid-turn is
  // rejected with the real runtime error. This is what the live bug was: a
  // delayed activate sweep injected while the settled tick's turn ran.
  let agentBusy = false;
  // The subagent backend's runtime reachability — the /autopilot on probe
  // fleetStatus()'s this; false simulates pi-subagents absent (refusal path).
  let fleetReachable = true;
  // (manualFleetReplies lives at MODULE level — replyToLastStatus is
  // module-scoped too — reset in beforeEach below.)
  // Tests that reply to status RPCs MANUALLY (replyToLastStatus) set this so
  // the fake's auto-answer does not race their replies.
  let manualFleetReplies = false;
  const runtimeError = "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.";
  const pi = {
    events: {
      on: (ch: string, h: (...a: any[]) => void) => {
        (handlers[ch] ||= []).push(h);
        return () => {};
      },
      emit: (ch: string, payload: any) => {
        if (ch === "agent_start") agentBusy = true;
        if (ch === "agent_settled") agentBusy = false;
        // Deferred auto-answer for STATUS RPCs: one macrotask later, so a test
        // that replies SYNCHRONOUSLY right after triggering (replyToLastStatus)
        // always wins the first-reply race. The payload is test-controllable
        // (fleetAnswer) — default: reachable, empty fleet.
        if (ch === "subagents:rpc:v1:request" && payload?.method === "status") {
          setTimeout(() => {
            for (const h of handlers[`subagents:rpc:v1:reply:${payload.requestId}`] ?? []) h(fleetAnswer);
          }, 0);
        }
        emitted.push({ channel: ch, payload });
      },
    },
    on: (ch: string, h: (...a: any[]) => void) => {
      (handlers[ch] ||= []).push(h);
    },
    sendMessage: (payload: any, meta: any): Promise<void> => {
      // RUNTIME contract (sendCustomMessage): while streaming, a message is
      // QUEUED via steer/followUp — it never throws. Only an idle agent gets a
      // triggered turn (which then marks busy).
      if (meta?.triggerTurn) {
        if (agentBusy) {
          sent.push({ kind: "message", args: [payload, meta], queued: true });
          return Promise.resolve();
        }
        agentBusy = true;
      }
      sent.push({ kind: "message", args: [payload, meta] });
      return Promise.resolve();
    },
    sendUserMessage: (content: any, options?: any) => {
      // RUNTIME contract (agent-session.js): sendUserMessage THROWS while the
      // agent is streaming unless deliverAs is given. The mock reproduces it
      // so mid-turn injections fail tests instead of the live TUI.
      if (agentBusy && !options?.deliverAs) {
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
      sent.push({ kind: "user", args: [content, options] });
      return Promise.resolve();
    },
    registerCommand: (name: string, opts: any) => {
      commands[name] = opts;
    },
    registerTool: (def: any) => {
      tools[def.name] = def;
    },
    _handlers: handlers,
    _sent: sent,
    _emitted: emitted,
    _commands: () => commands,
    _tools: () => tools,
  };
  return pi;
}

type MockPi = ReturnType<typeof mockPi>;

// The fake pi's deferred status-RPC answer (one macrotask after the request —
// synchronous manual replies always win). Default: backend reachable, empty
// fleet; tests override per scenario.
let fleetAnswer: unknown = { success: true, data: { fleet: { totalActive: 0, omitted: 0 } } };

describe("pi adapter smoke", () => {
  let dir: string;
  let repo: string;
  let pi: MockPi;
  let mod: { default: (pi: any) => void };
  let ctx: any;
  let sessionCounter = 0;
  let lastSid = "";
  /** Isolated async-run inventory root for the backend (AUTOPILOT_PI_ASYNC_ROOT)
   *  — the mocked host suite must never merge a LIVE pi-subagents session's
   *  runs into its assertions (the fleetStatus union reads this root). */
  let fleetRoot = "";

  beforeEach(async () => {
    fleetAnswer = { success: true, data: { fleet: { totalActive: 0, omitted: 0 } } };
    dir = mkdtempSync(join(tmpdir(), "autopilot-smoke-"));
    writeFileSync(join(dir, "state.md"), LEGACY_MD);
    process.env.AUTOPILOT_STATE_DIR = dir;
    fleetRoot = mkdtempSync(join(tmpdir(), "autopilot-fleet-"));
    process.env.AUTOPILOT_PI_ASYNC_ROOT = fleetRoot;
    pi = mockPi();
    ctx = { ui: { notify: () => {} }, cwd: dir };
    mod = await import(process.env.AUTOPILOT_EXTENSION_PATH ?? "file://" + join(import.meta.dir, "../../src/hosts/pi-extension.ts"));
    mod.default(pi);
    startSession("tui");
  });

  afterEach(() => {
    for (const h of pi._handlers["session_shutdown"] ?? []) h({});
    delete process.env.AUTOPILOT_STATE_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.AUTOPILOT_PI_ASYNC_ROOT;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fleetRoot, { recursive: true, force: true });
  });

  /** Lazy clean fixture repo — only dispatch tests pay the git-init cost. */
  function makeRepo(): string {
    const r = mkdtempSync(join(tmpdir(), "ap-fixture-repo-"));
    const g = (...a: string[]) => execFileSync("git", ["-C", r, ...a], { stdio: "pipe" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(join(r, "f.txt"), "clean\n");
    g("add", "f.txt");
    g("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");
    return r;
  }

  function emit(channel: string, payload: unknown, ctxArg?: any) {
    for (const h of pi._handlers[channel] ?? []) h(payload, ctxArg);
  }
  async function runAutopilotCmd(args: string) {
    await pi._commands()["autopilot"].handler(args, ctx);
  }
  function startSession(mode: "tui" | "json", sid?: string) {
    sessionCounter += 1;
    const id = sid ?? `test-session-${sessionCounter}`;
    lastSid = id;
    emit("session_start", { reason: "new" }, { mode, sessionManager: { getSessionId: () => id } });
  }
  /** Wait (async) for the dispatch's spawn RPC request — the pre-flight dirty check makes it async. */
  async function waitForSpawnRequest(): Promise<{ channel: string; payload: any }> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      // the LATEST spawn request — earlier ones may already have been consumed
      for (let i = pi._emitted.length - 1; i >= 0; i--) {
        const e = pi._emitted[i];
        if (e.channel === "subagents:rpc:v1:request" && e.payload?.method === "spawn") return e;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no spawn RPC request emitted");
  }
  /** Fire the RPC reply for the last emitted spawn request (simulates the runner). */
  async function replyToLastSpawn(runId: string) {
    const req = await waitForSpawnRequest();
    const requestId = req.payload.requestId;
    for (const h of pi._handlers[`subagents:rpc:v1:reply:${requestId}`] ?? []) h({ success: true, data: { runId } });
  }
  /** Fire the RPC reply for the last emitted STATUS request (fleet status). */
  function replyToLastStatus(totalActive: number, entries: Array<{ agent: string }> = []) {
    fleetAnswer = { success: true, data: { fleet: { totalActive, entries, omitted: 0 } } }; // if the manual reply lost the race, the deferred answer carries the right payload
    let req: { channel: string; payload: any } | undefined;
    for (let i = pi._emitted.length - 1; i >= 0; i--) {
      const e = pi._emitted[i];
      if (e.channel === "subagents:rpc:v1:request" && e.payload?.method === "status") { req = e; break; }
    }
    expect(req).toBeDefined();
    const requestId = req!.payload.requestId;
    for (const h of pi._handlers[`subagents:rpc:v1:reply:${requestId}`] ?? []) h({ success: true, data: { fleet: { version: 1, entries, totalActive, omitted: 0 } } });
  }

  test("a failing /autopilot command logs the real error to autopilot.jsonl (the notify's promise)", async () => {
    startSession("tui");
    const failNotify = { on: false };
    ctx = { ui: { notify: (m: string, kind: string) => { if (failNotify.on) throw new Error("boom: notify"); } }, cwd: dir };
    const logPath = join(dir, "autopilot.jsonl");
    expect(existsSync(logPath)).toBe(false);
    // The final "Autopilot ON" notify throws → the catch runs → logs the
    // command-error, then its own notify throws again (flag still on) — the
    // test absorbs that.
    failNotify.on = true;
    try {
      await runAutopilotCmd("on");
    } catch {
      // expected — the catch's own notify re-threw
    } finally {
      failNotify.on = false;
      ctx = { ui: { notify: () => {} }, cwd: dir };
    }
    const entries = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const err = entries.find((e) => e.type === "command-error");
    expect(err).toBeDefined();
    expect(err.command).toBe("on");
    expect(err.error).toContain("boom: notify");
    expect(err.stack).toBeTruthy();
  });

  test("the /autopilot toggle informs the ORCHESTRATOR of the mode (on → harness active; off → manual)", async () => {
    startSession("tui");
    await runAutopilotCmd("on");
    const onMsg = pi._sent.find((m) => m.kind === "user" && String(m.args?.[0] ?? "").includes("Autopilot is now ON"));
    expect(onMsg).toBeTruthy();
    expect(String(onMsg.args[0])).toContain("auto-dispatches reviews on completion");
    pi._sent.length = 0;
    await runAutopilotCmd("off");
    const offMsg = pi._sent.find((m) => m.kind === "user" && String(m.args?.[0] ?? "").includes("Autopilot is now OFF"));
    expect(offMsg).toBeTruthy();
    expect(String(offMsg.args[0])).toContain("do everything manually");
    expect(String(offMsg.args[0])).toContain("queue_review");
  });

  test("scheduled off ('off in <dur>') keeps ON + confirms; explicit on cancels; bad duration errors", async () => {
    startSession("tui");
    const notes: Array<[string, string]> = [];
    ctx = { ui: { notify: (m: string, k: string) => notes.push([m, k]) }, cwd: dir };
    await runAutopilotCmd("on");
    notes.length = 0;
    await runAutopilotCmd("off in 1h30m");
    // still ON — scheduling is NOT an immediate off
    expect(isAutopilotOn(dir, lastSid)).toBe(true);
    const stored = JSON.parse(readFileSync(join(dir, "autopilot.sessions.json"), "utf8"));
    const at = stored[lastSid].scheduledOffAt as number;
    expect(at).toBeGreaterThan(Date.now());
    // confirmation notify carries the absolute time (the framework message)
    const confirm = notes.find(([m]) => m.includes(new Date(at).toISOString()));
    expect(confirm).toBeTruthy();
    expect(confirm![1]).toBe("info");
    // explicit on CANCELS the schedule (persisted deadline dropped)
    notes.length = 0;
    await runAutopilotCmd("on");
    const cleared = JSON.parse(readFileSync(join(dir, "autopilot.sessions.json"), "utf8"));
    expect(cleared[lastSid].scheduledOffAt).toBeUndefined();
    // invalid duration → error notify, state untouched
    notes.length = 0;
    await runAutopilotCmd("off in banana");
    expect(notes.some(([, k]) => k === "error")).toBe(true);
    ctx = { ui: { notify: () => {} }, cwd: dir };
  });

  test("scheduled-off BACKSTOP: a persisted past deadline flips OFF at the enable gate (process-restart case)", async () => {
    startSession("tui");
    await runAutopilotCmd("on");
    pi._sent.length = 0;
    // simulate the deadline surviving a restart: seed a PAST deadline into the
    // per-session store (the armed timer died with the old process)
    const storePath = join(dir, "autopilot.sessions.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    store[lastSid] = { status: "on", updatedAt: new Date().toISOString(), scheduledOffAt: Date.now() - 1_000 };
    writeFileSync(storePath, JSON.stringify(store));
    emit("agent_settled", {}); // any trigger runs enabled() → due-check fires
    await new Promise((r) => setTimeout(r, 30));
    // flipped OFF + both immediate-off side effects replayed
    expect(isAutopilotOn(dir, lastSid)).toBe(false);
    expect(pi._sent.some((s) => s.kind === "user" && String(s.args?.[0] ?? "").includes("Autopilot is now OFF"))).toBe(true);
  });

  test("REGRESSION: a FLAT reviewer completion (raw payload, no results) still routes the verdict — the wedge", async () => {
    startSession("tui");
    await runAutopilotCmd("on");
    // seed a reviewing item whose reviewerRunId matches the workflow id
    const s0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    s0.items["WEDGE-1"] = { key: "WEDGE-1", title: "wedge", status: "ai-review", blocker: null, scope: "x", cwd: "/tmp", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: "rev-abc-1234", attempts: 0, notes: "", createdAt: "a", updatedAt: "b" };
    writeFileSync(join(dir, "queue.json"), JSON.stringify(s0));
    // the REAL pi async-complete payload: flat, no results, no agent
    emit("subagent:async-complete", { id: "rev-abc-1234", success: true, state: "complete", asyncDir: join(dir, "no-such-run") });
    await new Promise((r) => setTimeout(r, 100));
    const after = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    // no run record → no verdict → the item must NOT flip silently (manual path)
    expect(after.items["WEDGE-1"].status).toBe("ai-review");
  });

  test("REGRESSION: a sync sendUserMessage throw mid-command cannot fail /autopilot (injection retries)", async () => {
    startSession("tui");
    const throwSend = { on: false };
    const origSend = pi.sendUserMessage;
    pi.sendUserMessage = ((_m: string, _o?: unknown) => {
      if (throwSend.on) throw new Error("Agent is already processing...");
      return origSend(_m, _o);
    }) as typeof pi.sendUserMessage;
    const notes: Array<[string, string]> = [];
    ctx = { ui: { notify: (m: string, k: string) => notes.push([m, k]) }, cwd: dir };
    try {
      await runAutopilotCmd("on");
      expect(notes.filter(([, k]) => k === "error")).toHaveLength(0); // no failure
      expect(notes.some(([m]) => m.startsWith("Autopilot ON"))).toBe(true);
    } finally {
      throwSend.on = false;
      pi.sendUserMessage = origSend;
      ctx = { ui: { notify: () => {} }, cwd: dir };
    }
  });

  test("registers /autopilot + the four queue tools", () => {
    expect(pi._commands()["autopilot"]).toBeDefined();
    for (const t of ["queue_list", "queue_add", "queue_update", "queue_dispatch"]) {
      expect(pi._tools()[t]).toBeDefined();
    }
  });

  test("REGRESSION: ticks are suppressed during auto-compaction (they aborted it: 'Turn prefix summarization failed')", async () => {
    await runAutopilotCmd("on");
    pi._sent.length = 0;
    // compaction starts — agentBusy is false in this window (between runs)
    emit("session_before_compact", {});
    emit("agent_settled", {}); // settled sweep would want a dispatch tick
    replyToLastStatus(0, []);
    await new Promise((r) => setTimeout(r, 30));
    expect(pi._sent.filter((s) => s.kind === "message")).toHaveLength(0);
    // compaction ends → ticks flow again (queue changed so the hash guard passes)
    const s2 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    s2.items["A6-NEW"] = { key: "A6-NEW", status: "approved", ready: true, blocker: null, title: "a6-new", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, attempts: 0, notes: "", createdAt: "x", updatedAt: "x" };
    writeFileSync(join(dir, "queue.json"), JSON.stringify(s2));
    emit("session_compact", {});
    emit("agent_settled", {});
    replyToLastStatus(0, []);
    await new Promise((r) => setTimeout(r, 30));
    expect(pi._sent.filter((s) => s.kind === "message")).toHaveLength(1);
  });

  test("REGRESSION: /autopilot on mid-turn DEFERS the /orchestrate injection to the settle (the runtime throws otherwise)", async () => {
    // the command handler runs INSIDE a turn — the runtime would throw
    // ("Agent already processing a prompt") for a direct send in this window
    emit("agent_start", {});
    const origUser = pi.sendUserMessage;
    let throwWhileBusy = true;
    pi.sendUserMessage = ((content, options) => {
      // the runtime's busy-not-streaming behavior: even WITH deliverAs the
      // direct send throws (followUp is only honored while streaming)
      if (throwWhileBusy) throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.");
      return origUser(content, options);
    }) as typeof pi.sendUserMessage;
    try {
      await runAutopilotCmd("on");
      await new Promise((r) => setTimeout(r, 20));
      // deferred — nothing sent while busy
      expect(pi._sent.some((s) => s.kind === "user" && s.args[0] === "/orchestrate")).toBe(false);
      throwWhileBusy = false; // the agent settles — sends are accepted again
      emit("agent_settled", {});
      await new Promise((r) => setTimeout(r, 20));
      const injected = pi._sent.find((s) => s.kind === "user" && s.args[0] === "/orchestrate");
      expect(injected).toBeDefined();
      expect(injected!.args[1]?.deliverAs).toBe("followUp");
    } finally {
      pi.sendUserMessage = origUser;
    }
  });

  test("REGRESSION: a tick rejected in the busy-not-streaming window is DEFERRED + delivered at the settle", async () => {
    startSession("tui");
    const origSend = pi.sendMessage;
    let throwWhileBusy = true;
    pi.sendMessage = ((payload, meta) => {
      // the runtime's busy-not-streaming behavior: a direct send THROWS
      if (throwWhileBusy && meta?.triggerTurn) {
        throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.");
      }
      return origSend(payload, meta);
    }) as typeof pi.sendMessage;
    try {
      await runAutopilotCmd("on"); // the activate sweep produces a tick → the deliver throws → deferred
      await new Promise((r) => setTimeout(r, 30));
      replyToLastStatus(0, []); // unblock the sweep's fleet query
      await new Promise((r) => setTimeout(r, 30));
      expect(pi._sent.filter((s) => s.kind === "message")).toHaveLength(0); // nothing while busy
      throwWhileBusy = false; // the agent settles — sends are accepted again
      emit("agent_settled", {});
      await new Promise((r) => setTimeout(r, 30));
      expect(pi._sent.filter((s) => s.kind === "message").length).toBeGreaterThan(0); // the deferred tick delivered
    } finally {
      pi.sendMessage = origSend;
    }
  });

  test("PREREQ PROBE: backend unreachable → /autopilot on REFUSES (state stays off)", async () => {
    fleetAnswer = { success: false }; // simulates pi-subagents absent
    const notes: Array<[string, string]> = [];
    ctx = { ui: { notify: (m: string, k: string) => notes.push([m, k]) }, cwd: dir };
    await runAutopilotCmd("on");
    expect(notes.some(([m]) => m.startsWith("Autopilot NOT activated"))).toBe(true);
    // the toggle must NOT have turned the session on (it starts OFF and the
    // refusal leaves it OFF)
    const sess = JSON.parse(readFileSync(join(dir, "autopilot.sessions.json"), "utf8"));
    expect(Object.values(sess).every((v: any) => v.status !== "on")).toBe(true);
    // and the orchestrator was never injected
    expect(pi._sent.some((m) => m.kind === "user" && m.args?.[0] === "/orchestrate")).toBe(false);
  });

  test("autopilot on → migrates legacy state.md into queue.json + injects /orchestrate", async () => {
    await runAutopilotCmd("on");
    expect(existsSync(join(dir, "queue.json"))).toBe(true);
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["G1"].status).toBe("active");
    expect(store.items["A6"].status).toBe("approved");
    expect(existsSync(join(dir, "state.md"))).toBe(false); // archived
    const injected = pi._sent.find((s) => s.kind === "user" && s.args[0] === "/orchestrate");
    expect(injected).toBeDefined();
  });

  test("AUTOPILOT-9: /autopilot on auto-dispatches eligible approved items in the ACTIVATION sweep (idle slots never strand)", async () => {
    // Seed an eligible approved item (scope + cwd + low risk) into the scratch
    // store BEFORE activation. The ON command used to ONLY inject /orchestrate
    // + nudge — the harness filled free slots exclusively on worker-done, so an
    // early-ON window stranded approved items until the first completion
    // (observed live). The activation sweep now fills slots immediately.
    writeFileSync(join(dir, "queue.json"), JSON.stringify({ version: 1, items: {} }));
    const s = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    s.items["A9"] = {
      key: "A9", title: "a9", status: "approved", blocker: null,
      scope: "do the thing", cwd: dir, evidence: "", value: "", urgency: "", risk: "low",
      runId: null, reviewerRunId: null, attempts: 0, notes: "",
      createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    };
    writeFileSync(join(dir, "queue.json"), JSON.stringify(s));
    await runAutopilotCmd("on");
    const req = await waitForSpawnRequest(); // the activation sweep spawned the worker
    expect(req.payload.method).toBe("spawn");
    await replyToLastSpawn("run-a9");
    await new Promise((r) => setTimeout(r, 30));
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["A9"].status).toBe("active");
    expect(store.items["A9"].runId).toBe("run-a9");
  });

  test("queue_add + queue_update mutate the store (free-form notes)", async () => {
    const add = pi._tools()["queue_add"];
    await add.execute("c1", { key: "B4-AGENTIC-JUDGE-TIMEOUT", title: "judge timeout", scope: "add timeout", notes: "free-form notes" }, undefined, undefined, ctx);
    const up = pi._tools()["queue_update"];
    // the approval contract: reaching approved REQUIRES scope + cwd
    const rejected = await up.execute("c2", { key: "B4-AGENTIC-JUDGE-TIMEOUT", status: "approved", notes: "updated note" }, undefined, undefined, ctx);
    expect(rejected.content[0].text).toContain("requires a complete scope + cwd");
    const r = await up.execute("c2b", { key: "B4-AGENTIC-JUDGE-TIMEOUT", status: "approved", cwd: "/tmp/repo", notes: "updated note" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("updated");
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].status).toBe("approved");
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].cwd).toBe("/tmp/repo");
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].notes).toBe("updated note");
  });

  test("queue_dispatch WARNs when manually dispatching an auto-dispatchable item (double-dispatch guard)", async () => {
    startSession("tui");
    await runAutopilotCmd("on");
    // The activation sweep runs async — let it finish against the migrated
    // store (G1 active, A6 approved-without-scope: nothing eligible) so it
    // cannot race this test's item.
    await new Promise((r) => setTimeout(r, 40));
    const repo = makeRepo();
    const s0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    // AUTO-1 becomes approved AFTER activation — the mid-turn manual dispatch
    // window (the harness takes it at the next settle/timer otherwise).
    s0.items["AUTO-1"] = { key: "AUTO-1", title: "auto", status: "approved", blocker: null, scope: "do the thing", cwd: repo, evidence: "", value: "M", urgency: "M", risk: "low", runId: null, reviewerRunId: null, attempts: 0, notes: "", createdAt: "a", updatedAt: "b" };
    writeFileSync(join(dir, "queue.json"), JSON.stringify(s0));
    const disp = pi._tools()["queue_dispatch"];
    const p = disp.execute("c3", { key: "AUTO-1", task: "KEY: AUTO-1 — do the thing" }, undefined, undefined, { ui: { notify: () => {} }, cwd: repo });
    await waitForSpawnRequest();
    await replyToLastSpawn("auto-1-run");
    const r = await p;
    expect(r.content[0].text).toContain("auto-dispatchable");
    expect(r.content[0].text).toContain("duplicate worker");
    // it still dispatches (the override path is legitimate)
    const after = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(after.items["AUTO-1"].status).toBe("active");
  });

  test("queue_dispatch spawns via RPC + records approved→active atomically", async () => {
    const repo = makeRepo();
    await runAutopilotCmd("on"); // migrate first
    const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    store0.items["A6"].ready = true;
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
    const disp = pi._tools()["queue_dispatch"];
    const p = disp.execute("c3", { key: "A6", task: "KEY: A6 — research go/no-go" }, undefined, undefined, { ui: { notify: () => {} }, cwd: repo });
    const emitted = await waitForSpawnRequest();
    expect(emitted.payload.params.workflowScript).toContain("KEY: A6");
    await replyToLastSpawn("d67a18c6-c2be-4e7d-be25-5d07a2931601");
    const r = await p;
    expect(r.content[0].text).toContain("dispatched");
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["A6"].status).toBe("active");
    expect(store.items["A6"].runId).toBe("d67a18c6-c2be-4e7d-be25-5d07a2931601");
  });

  test("queue_dispatch extracts the run id from the REAL reply shape (text, not structured)", async () => {
    const repo = makeRepo();
    await runAutopilotCmd("on");
    const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    store0.items["A6"].ready = true;
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
    const disp = pi._tools()["queue_dispatch"];
    const p = disp.execute("c3", { key: "A6", task: "KEY: A6" }, undefined, undefined, { ui: { notify: () => {} }, cwd: repo });
    // Real pi-subagents reply: data = { text, details } — run id only in text
    const req = await waitForSpawnRequest();
    const requestId = req.payload.requestId;
    for (const h of pi._handlers[`subagents:rpc:v1:reply:${requestId}`] ?? []) {
      h({ success: true, data: { text: "Run fan-out: 0/64 used\nAsync workflow [d67a18c6-c2be-4e7d-be25-5d07a2931601]\n\nThe async run is detached.", details: { mode: "workflow", results: [] } } });
    }
    const r = await p;
    expect(r.content[0].text).toContain("dispatched");
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["A6"].status).toBe("active");
    expect(store.items["A6"].runId).toBe("d67a18c6-c2be-4e7d-be25-5d07a2931601");
  });

  test("async-complete flips the store item + ticks with the authoritative fleet", async () => {
    await runAutopilotCmd("on");
    pi._sent.length = 0;
    pi._emitted.length = 0;
    emit("subagent:async-complete", {
      runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601",
      agent: "workflow",
      success: true,
      results: [{ agent: "worker", runId: "371d1bb9", sessionPath: `/s/371d1bb9/run-0/session.jsonl` }],
    });
    // the completion handler queried the authoritative fleet → reply: 1 WORKER active (reviewer excluded)
    replyToLastStatus(2, [{ agent: "worker" }, { agent: "reviewer" }]);
    await new Promise((r) => setTimeout(r, 20)); // let the async sweep finish
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["G1"].status).toBe("ai-review");
    const tick = pi._sent.find((s) => s.kind === "message");
    expect(tick).toBeDefined();
    expect(tick!.args[0].content).toContain("[orch-tick:");
    expect(tick!.args[0].content).toContain("FLEET: 2/3"); // fleet totalActive counts ALL subagents (worker + reviewer)
    expect(tick!.args[0].content).toContain("workers + reviewers + scouts"); // general case — not worker-only
  });

  test("queue_dispatch pre-flights the dirty-tree check (B26: worktree isolation needs a clean main checkout)", async () => {
    await runAutopilotCmd("on");
    const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    store0.items["A6"].ready = true;
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
    const disp = pi._tools()["queue_dispatch"];
    // fixture repo: clean first, then dirty — never the ambient checkout
    const repo = makeRepo();
    const gc = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "commit", ...a], { stdio: "pipe" });
    try {
      // dirty fixture → blocked with a clear error, no spawn
      writeFileSync(join(repo, "f.txt"), "dirty\n");
      const r = await disp.execute("c3", { key: "A6", task: "KEY: A6" }, undefined, undefined, { ui: { notify: () => {} }, cwd: repo });
      expect(r.content[0].text).toContain("DIRTY");
      expect(pi._emitted.filter((e) => e.channel === "subagents:rpc:v1:request" && e.payload?.method === "spawn").length).toBe(0);
      // clean fixture → passes the check and dispatches
      gc("-am", "dirty");
      const ok = disp.execute("c3", { key: "A6", task: "KEY: A6" }, undefined, undefined, { ui: { notify: () => {} }, cwd: repo });
      await replyToLastSpawn("d67a18c6-c2be-4e7d-be25-5d07a2931601");
      const okr = await ok;
      expect(okr.content[0].text).not.toContain("DIRTY");
      expect(okr.content[0].text).toContain("dispatched");
      // a non-repo cwd FAILS CLOSED with a clear error (was a silent skip that
      // made every dispatch fail at spawn with the cryptic worktree error)
      const s2 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
      s2.items["A6"] = { ...s2.items["A6"], status: "approved", runId: null };
      writeFileSync(join(dir, "queue.json"), JSON.stringify(s2));
      pi._emitted.length = 0;
      const skip = await disp.execute("c3", { key: "A6", task: "KEY: A6" }, undefined, undefined, { ui: { notify: () => {} }, cwd: dir });
      expect(skip.content[0].text).toContain("not inside a git repository");
      expect(skip.content[0].text).toContain("cwd=<target-repo>");
      expect(pi._emitted.filter((e) => e.channel === "subagents:rpc:v1:request" && e.payload?.method === "spawn").length).toBe(0);
      // explicit cwd=<clean repo> dispatches (the session-cwd-mismatch fix: the
      // worker's repo is passed through to the spawn's runs.run)
      pi._emitted.length = 0;
      const viaCwd = disp.execute("c3", { key: "A6", task: "KEY: A6", cwd: repo }, undefined, undefined, { ui: { notify: () => {} }, cwd: dir });
      await replyToLastSpawn("d67a18c6-c2be-4e7d-be25-5d07a2931601");
      const viaCwdR = await viaCwd;
      expect(viaCwdR.content[0].text).toContain("dispatched");
      const spawnReq = pi._emitted.find((e) => e.channel === "subagents:rpc:v1:request" && e.payload?.method === "spawn");
      expect(spawnReq.payload.params.workflowScript).toContain(`"cwd":"${repo}"`); // the worker targets the repo, not the session cwd
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("B26: direct subagent worker spawn without worktree:true is BLOCKED (tool_call interception)", async () => {
    await runAutopilotCmd("on");
    const toolCallHandlers = pi._handlers["tool_call"] ?? [];
    expect(toolCallHandlers.length).toBeGreaterThan(0);
    let result: unknown;
    for (const h of toolCallHandlers) {
      result = h({ toolName: "subagent", input: { agent: "worker", task: "KEY: B20", async: true } }, { ui: { notify: () => {} }, cwd: dir });
    }
    const blocked = result as { block: boolean; reason: string };
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("worktree isolation");
    expect(blocked?.reason).toContain("queue_dispatch");
    // explicitly-isolated spawns pass through
    for (const h of toolCallHandlers) {
      result = h({ toolName: "subagent", input: { agent: "worker", task: "KEY: B20", worktree: true } }, { ui: { notify: () => {} }, cwd: dir });
    }
    expect((result as { block?: boolean })?.block).toBeUndefined();
    // reviewer/scout spawns pass through (read-only)
    for (const h of toolCallHandlers) {
      result = h({ toolName: "subagent", input: { agent: "reviewer", task: "review" } }, { ui: { notify: () => {} }, cwd: dir });
    }
    expect((result as { block?: boolean })?.block).toBeUndefined();
    // management actions (status/steer) pass through
    for (const h of toolCallHandlers) {
      result = h({ toolName: "subagent", input: { action: "status", view: "fleet" } }, { ui: { notify: () => {} }, cwd: dir });
    }
    expect((result as { block?: boolean })?.block).toBeUndefined();
  });

  test("queue_dispatch allows re-dispatch (reviewing→active) and recovery (failed→active)", async () => {
    const repo = makeRepo();
    await runAutopilotCmd("on");
    const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    store0.items["A6"].status = "ai-review"; // review FAIL → re-dispatch
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
    const disp = pi._tools()["queue_dispatch"];
    const p = disp.execute("c3", { key: "A6", task: "KEY: A6 — fix findings" }, undefined, undefined, { ui: { notify: () => {} }, cwd: repo });
    replyToLastSpawn("d67a18c6-c2be-4e7d-be25-5d07a2931601");
    const r = await p;
    expect(r.content[0].text).toContain("dispatched");
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["A6"].status).toBe("active"); // reviewing → active
  });

  test("queue_steer writes a control-channel steer request and VERIFIES the child ack", async () => {
    const fakeAsyncDir = join(fleetRoot, "d67a18c6-c2be-4e7d-be25-5d07a2931601"); // isolated test async root (AUTOPILOT_PI_ASYNC_ROOT)
    const routeDir = join(fakeAsyncDir, "control", "workflow-foreground", "wf1", "control");
    mkdirSync(join(routeDir, "steer-targets", "0"), { recursive: true });
    mkdirSync(join(routeDir, "steer-acks", "0"), { recursive: true });
    writeFileSync(join(fakeAsyncDir, "status.json"), JSON.stringify({ runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", mode: "workflow" }));
    try {
      await runAutopilotCmd("on");
      const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
      store0.items["G1"] = { key: "G1", status: "active", ready: false, blocker: null, title: "g1", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", reviewerRunId: null, attempts: 0, notes: "", createdAt: "x", updatedAt: "x" };
      writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
      const steer = pi._tools()["queue_steer"];
      // simulate the child's prompt-runtime: acknowledge as delivered
      const r = steer.execute("c4", { key: "G1", message: "switch to the DACH report" }, undefined, undefined, ctx);
      await new Promise((res) => setTimeout(res, 250));
      const reqs = readdirSync(join(routeDir, "steer-targets", "0"));
      expect(reqs.length).toBe(1);
      const req = JSON.parse(readFileSync(join(routeDir, "steer-targets", "0", reqs[0]), "utf8"));
      expect(req.type).toBe("steer");
      expect(req.message).toBe("switch to the DACH report");
      expect(req.targetIndex).toBe(0);
      expect(req.source).toBe("queue_steer");
      writeFileSync(
        join(routeDir, "steer-acks", "0", `${Buffer.from(req.id).toString("base64url")}.json`),
        JSON.stringify({ type: "steer-ack", requestId: req.id, index: 0, ts: Date.now(), state: "delivered", message: "delivered" }),
      );
      const rr = await r;
      expect(rr.content[0].text).toContain("steered 'G1'");
    } finally {
      rmSync(fakeAsyncDir, { recursive: true, force: true });
    }
  });

  test("queue_steer REFUSES when the child publishes supported:false (headless worker)", async () => {
    const fakeAsyncDir = join(fleetRoot, "d67a18c6-c2be-4e7d-be25-5d07a2931601"); // isolated test async root (AUTOPILOT_PI_ASYNC_ROOT)
    const routeDir = join(fakeAsyncDir, "control", "workflow-foreground", "wf1", "control");
    mkdirSync(join(routeDir, "steer-capabilities"), { recursive: true });
    writeFileSync(join(fakeAsyncDir, "status.json"), JSON.stringify({ runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", mode: "workflow" }));
    writeFileSync(join(routeDir, "steer-capabilities", "0.json"), JSON.stringify({ type: "steer-capability", protocolVersion: 1, index: 0, pid: 1, readyAt: Date.now(), supported: false }));
    try {
      await runAutopilotCmd("on");
      const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
      store0.items["G1"] = { key: "G1", status: "active", ready: false, blocker: null, title: "g1", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", reviewerRunId: null, attempts: 0, notes: "", createdAt: "x", updatedAt: "x" };
      writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
      const steer = pi._tools()["queue_steer"];
      const r = await steer.execute("c4", { key: "G1", message: "hi" }, undefined, undefined, ctx);
      expect(r.content[0].text).toContain("does not support steering");
      expect(r.content[0].text).toContain("NOT be delivered");
    } finally {
      rmSync(fakeAsyncDir, { recursive: true, force: true });
    }
  });

  test("queue_steer reports the child's explicit rejection (ack state failed)", async () => {
    const fakeAsyncDir = join(fleetRoot, "d67a18c6-c2be-4e7d-be25-5d07a2931601"); // isolated test async root (AUTOPILOT_PI_ASYNC_ROOT)
    const routeDir = join(fakeAsyncDir, "control", "workflow-foreground", "wf1", "control");
    mkdirSync(join(routeDir, "steer-targets", "0"), { recursive: true });
    mkdirSync(join(routeDir, "steer-acks", "0"), { recursive: true });
    writeFileSync(join(fakeAsyncDir, "status.json"), JSON.stringify({ runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", mode: "workflow" }));
    try {
      await runAutopilotCmd("on");
      const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
      store0.items["G1"] = { key: "G1", status: "active", ready: false, blocker: null, title: "g1", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", reviewerRunId: null, attempts: 0, notes: "", createdAt: "x", updatedAt: "x" };
      writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
      const steer = pi._tools()["queue_steer"];
      const r = steer.execute("c4", { key: "G1", message: "switch" }, undefined, undefined, ctx);
      await new Promise((res) => setTimeout(res, 200));
      const reqs = readdirSync(join(routeDir, "steer-targets", "0"));
      const req = JSON.parse(readFileSync(join(routeDir, "steer-targets", "0", reqs[0]), "utf8"));
      writeFileSync(
        join(routeDir, "steer-acks", "0", `${Buffer.from(req.id).toString("base64url")}.json`),
        JSON.stringify({ type: "steer-ack", requestId: req.id, index: 0, ts: Date.now(), state: "failed", message: "already has an active steer" }),
      );
      const rr = await r;
      expect(rr.content[0].text).toContain("FAILED delivery");
      expect(rr.content[0].text).toContain("already has an active steer");
    } finally {
      rmSync(fakeAsyncDir, { recursive: true, force: true });
    }
  });

  test("queue_steer reports silent no-ack (headless child) instead of claiming delivery", async () => {
    const fakeAsyncDir = join(fleetRoot, "d67a18c6-c2be-4e7d-be25-5d07a2931601"); // isolated test async root (AUTOPILOT_PI_ASYNC_ROOT)
    const routeDir = join(fakeAsyncDir, "control", "workflow-foreground", "wf1", "control");
    mkdirSync(join(routeDir, "steer-targets", "0"), { recursive: true });
    mkdirSync(join(routeDir, "steer-acks", "0"), { recursive: true });
    writeFileSync(join(fakeAsyncDir, "status.json"), JSON.stringify({ runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", mode: "workflow" }));
    try {
      await runAutopilotCmd("on");
      const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
      store0.items["G1"] = { key: "G1", status: "active", ready: false, blocker: null, title: "g1", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", reviewerRunId: null, attempts: 0, notes: "", createdAt: "x", updatedAt: "x" };
      writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
      const steer = pi._tools()["queue_steer"];
      const r = await steer.execute("c4", { key: "G1", message: "switch", ackTimeoutMs: 150 }, undefined, undefined, ctx);
      expect(r.content[0].text).toContain("no steering acknowledgment");
      expect(r.content[0].text).toContain("NOT delivered");
    } finally {
      rmSync(fakeAsyncDir, { recursive: true, force: true });
    }
  });

  test("queue_steer errors clearly when the run dir is gone", async () => {
    await runAutopilotCmd("on");
    const store0 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    store0.items["G1"] = { key: "G1", status: "active", ready: false, blocker: null, title: "g1", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: "deadbeef-0000-0000-0000-000000000000", reviewerRunId: null, attempts: 0, notes: "", createdAt: "x", updatedAt: "x" };
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store0));
    const steer = pi._tools()["queue_steer"];
    const r = await steer.execute("c4", { key: "G1", message: "hi" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("dir not found");
  });

  test("off → migration + tools still work, but no ticks", async () => {
    await runAutopilotCmd("on");
    await runAutopilotCmd("off");
    pi._sent.length = 0;
    emit("subagent:async-complete", { runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", agent: "worker", success: true });
    expect(pi._sent.filter((s) => s.kind === "message").length).toBe(0);
    expect(existsSync(join(dir, "queue.json"))).toBe(true); // migration happened on 'on'
  });

  test("REGRESSION: async-runner children (json mode) NEVER get /orchestrate or ticks", async () => {
    await runAutopilotCmd("on");
    expect(pi._sent.some((s) => s.kind === "user" && s.args[0] === "/orchestrate")).toBe(true);
    pi._sent.length = 0;
    startSession("json");
    expect(pi._sent.filter((s) => s.kind === "user").length).toBe(0);
    emit("subagent:async-complete", { runId: "371d1bb9-aaaa", agent: "worker", success: true });
    expect(pi._sent.filter((s) => s.kind === "message").length).toBe(0);
  });

  test("per-session: autopilot on in session A does NOT affect session B", async () => {
    await runAutopilotCmd("on");
    expect(pi._sent.some((s) => s.kind === "user" && s.args[0] === "/orchestrate")).toBe(true);
    pi._sent.length = 0;
    startSession("tui"); // session B
    expect(pi._sent.filter((s) => s.kind === "user").length).toBe(0);
    emit("subagent:async-complete", { runId: "371d1bb9-aaaa", agent: "worker", success: true });
    expect(pi._sent.filter((s) => s.kind === "message").length).toBe(0);
  });
  test("ACTIVATION: no immediate tick — /orchestrate + run-now directive only (startup never nudges)", async () => {
    await runAutopilotCmd("on");
    const users = pi._sent.filter((x) => x.kind === "user").map((x) => String(x.args?.[0] ?? ""));
    // /orchestrate loaded first, then the run-now directive — and NO [orch-tick] message
    expect(users.some((u) => u === "/orchestrate")).toBe(true);
    expect(users.some((u) => u.includes("run your loop now"))).toBe(true);
    expect(users.indexOf("/orchestrate")).toBeLessThan(users.findIndex((u) => u.includes("run your loop now")));
    expect(pi._sent.some((x) => x.kind === "message" && JSON.stringify(x.args).includes("[orch-tick:"))).toBe(false);
  });

  test("SESSION START: a previously-on session restarts OFF — no auto-inject, explicit /autopilot on required", async () => {
    startSession("tui", "fixed-sid");
    await runAutopilotCmd("on"); // turn on in this session
    expect(pi._sent.some((x) => x.kind === "user" && x.args?.[0] === "/orchestrate")).toBe(true);
    pi._sent.length = 0;
    startSession("tui", "fixed-sid"); // resume the SAME session — must NOT auto-restore ON
    expect(pi._sent.filter((x) => x.kind === "user").length).toBe(0); // no auto-inject
    expect(pi._sent.filter((x) => x.kind === "message").length).toBe(0); // no tick
    // and the persisted per-session state was reset to OFF
    const sess = JSON.parse(readFileSync(join(dir, "autopilot.sessions.json"), "utf8"));
    expect(sess["fixed-sid"].status).toBe("off");
    // the harness is idle until the user explicitly turns it on
    emit("agent_settled", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(pi._sent.some((x) => x.kind === "message" && JSON.stringify(x.args).includes("[orch-tick:"))).toBe(false);
  });



  test("no env → the documented default state dir (the shared resolver never fails closed)", () => {
    delete process.env.AUTOPILOT_STATE_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    // PURE resolution check — never load the extension against the real dir
    // (a previous version of this test did, and LEAKED session state into
    // ~/.local/state/orchestrator: the fake-sid artifact).
    expect(resolveStateDir(undefined)).toBe(join(homedir(), ".local/state/orchestrator"));
  });


  test("state dir resolved authoritatively from the projected orchestrate.md", () => {
    delete process.env.AUTOPILOT_STATE_DIR;
    const fakeAgentDir = join(dir, "fake-mode");
    const fakeState = join(dir, "resolved-state");
    mkdirSync(join(fakeAgentDir, "prompts"), { recursive: true });
    writeFileSync(
      join(fakeAgentDir, "prompts", "orchestrate.md"),
      `# Orchestrator Mode\n\n## Workspace (fake mode — not synced)\n\n- \`STATE_DIR\`: \`${fakeState}/\`\n`,
    );
    // PURE resolution check — the command file's STATE_DIR line wins. No
    // extension load, no writes (this test previously ran '/autopilot on'
    // against the resolved dir and leaked fake-sid into the REAL sessions
    // file when the resolution fell back to the default).
    expect(resolveStateDir(join(fakeAgentDir, "prompts/orchestrate.md"))).toBe(fakeState);
    delete process.env.PI_CODING_AGENT_DIR;
  });
});
