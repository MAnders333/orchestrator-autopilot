// autopilot.test.ts — core decision engine tests (STORE-first model).
// The legacy md parser (queue.ts) is retired with state.md — the parser logic
// survives only in queue-store.migrateFromMd (covered in queue-store.test.ts).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Autopilot } from "../src/core.ts";
import {
  loadAutopilotConfig,
  saveAutopilotConfig,
  writeSentinel,
  readSentinel,
  isAutopilotOn,
  writeAtomic,
  parseStateDirFromCommand,
  readSessionAutopilotState,
  writeSessionAutopilotState,
} from "../src/config.ts";
import {
  newStore,
  addItem,
  saveStore,
  type QueueStore,
  type QueueItem,
} from "../src/queue-store.ts";

const FIXTURE = `# Orchestrator State
updated: 2026-08-14T09:30Z

## Active (max 3 slots)
G24: [MI-4451 finish] Worker 371d1bb9 — restore files → commit → tests. status: working
G25: [M1/OBW test] Worker 29891f51 — find model, SQL extraction, report. status: working
G26: [M7/DACH dims] Worker 79a3db4d — map dims. status: working

## Approved (ready to dispatch when a slot frees)
A4: [Re-run 3 analyses] USER-APPROVED. BLOCKED on MI-4451 master-MR merge (!1440).
A5: [Review MR !1441] DISPATCHED (worker 5039cd3e, auto-dispatch, risk med).
A6: [Koop migration research] — risk: low | blockers: none | scope: Research go/no-go.
A7: [Review MI-4283] DISPATCHED (worker 78d70568, auto-dispatch).

### A6 DONE — paragraph blocks are ignored
## Backlog (candidates from intake)
B1: [circleback] some candidate
`;

function item(over: Partial<QueueItem> & { key: string }): QueueItem {
  return {
    status: "approved",
    ready: true,
    blocker: null,
    title: "t",
    scope: "",
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    notes: "",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...over,
  };
}

function writeStore(dir: string, items: QueueItem[]): QueueStore {
  const s = newStore();
  for (const it of items) addItem(s, it, it.createdAt);
  saveStore(dir, s);
  return s;
}

describe("core.Autopilot (store-first)", () => {
  let dir: string;
  const telemetry: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-test-"));
    telemetry.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function make(config: Record<string, unknown> = {}) {
    return new Autopilot({
      stateDir: dir,
      log: (l) => telemetry.push(l),
      ...config,
    });
  }

  test("completion flips the store item (active→reviewing) and fires dispatch tick", () => {
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "B1", status: "approved", ready: true, title: "b1" }),
    ]);
    const a = make();
    const r = a.handleAsyncComplete({
      runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601",
      agent: "workflow",
      success: true,
      results: [{ agent: "worker", runId: "371d1bb9-dead-beef", sessionPath: "/s/371d1bb9/run-0/session.jsonl" }],
    });
    expect(r.flipped).toBe(true);
    expect(r.freedSlot).toBe(true);
    // the adapter then sweeps with the authoritative fleet count (run gone → 0)
    const tick = a.sweep("worker-done", 1_000_000, { occupied: 0 }).tick;
    expect(tick?.reason).toBe("dispatch"); // slot freed, 1 ready
    expect(tick?.facts.occupied).toBe(0);
    // store persisted: G1 → reviewing
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["G1"].status).toBe("reviewing");
  });

  test("failed completion flips to failed", () => {
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
    ]);
    const a = make();
    const r = a.handleAsyncComplete({ runId: "371d1bb9-aaaa", agent: "worker", success: false, timedOut: true });
    expect(r.flipped).toBe(true);
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["G1"].status).toBe("failed");
    const tick = a.sweep("worker-done", 1_000_000, { occupied: 0 }).tick;
    expect(tick?.reason).toBe("intake"); // no ready work
  });

  test("non-orchestrator run (not in store, not a worker agent) → no tick, no flip", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", ready: true, title: "b1" })]);
    const r = make().handleAsyncComplete({ runId: "99999999-aaaa", agent: "orchestrator-reviewer", success: true });
    expect(r.flipped).toBe(false);
    expect(r.freedSlot).toBe(true); // a reviewer completion frees its slot — capacity counts all subagents
  });

  test("ledger-tracked completion without store match still ticks (fail-safe)", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", ready: true, title: "b1" })]);
    const a = make();
    a.handleAsyncStarted("d67a18c6-c2be-4e7d-be25-5d07a2931601", "worker");
    const r = a.handleAsyncComplete({ runId: "d67a18c6-c2be-4e7d-be25-5d07a2931601", agent: "workflow", success: true });
    expect(r.flipped).toBe(false); // no store item matched
    expect(r.freedSlot).toBe(true); // ledger-tracked → worker slot freed
    const tick = a.sweep("worker-done", 1_000_000, { occupied: 1 }).tick;
    expect(tick?.reason).toBe("dispatch");
  });

  test("sweep(activate) nudges a pre-existing capacity gap with zero dispatches", () => {
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "B1", status: "approved", ready: true, title: "b1" }),
    ]);
    const r = make().sweep("activate");
    expect(r.tick?.reason).toBe("dispatch");
    expect(r.tick?.facts.slotsFree).toBe(2);
  });

  test("settled re-ticks only on state change; timer re-nudges a persistent gap", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", ready: true, title: "b1" })]);
    const a = make();
    // settled: first tick, then suppressed for unchanged state
    expect(a.sweep("settled", 1_000_000).tick).not.toBeNull();
    expect(a.sweep("settled", 1_000_060).tick).toBeNull();
    // timer: re-nudges the SAME persistent gap (the orchestrator didn't act)
    const t = a.sweep("timer", 2_000_000);
    expect(t.tick?.reason).toBe("dispatch");
    // ...and a genuinely non-actionable state stays silent: fleet full + buffer ≥ threshold
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "aaaa1111", title: "g1" }),
      item({ key: "G2", status: "active", runId: "aaaa2222", title: "g2" }),
      item({ key: "G3", status: "active", runId: "aaaa3333", title: "g3" }),
      item({ key: "B1", status: "approved", ready: true, title: "b1" }),
      item({ key: "B2", status: "approved", ready: true, title: "b2" }),
    ]);
    expect(a.sweep("timer", 3_000_000).tick).toBeNull();
  });

  test("reviewer verdict PASS → item done + verdict event + tick", () => {
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "R1", status: "reviewing", title: "r1" }),
    ]);
    const a = make();
    // R1 got a queue_review: reviewerRunId recorded
    const st = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    st.items["R1"].reviewerRunId = "12345678-dead-beef";
    writeFileSync(join(dir, "queue.json"), JSON.stringify(st));
    const r = a.handleAsyncComplete({
      runId: "12345678-dead-beef-cafe",
      agent: "workflow",
      success: true,
      results: [{ agent: "orchestrator-reviewer", output: "Verdict: PASS\nEverything checks out.", runId: "12345678-dead-beef" }],
    });
    expect(r.flipped).toBe(true);
    expect(r.tick?.message).toContain("PASSED review");
    expect(r.domainEvents.some((e) => e.name === "orch:verdict" && e.data.verdict === "PASS")).toBe(true);
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["R1"].status).toBe("done");
  });

  test("reviewer verdict FAIL → re-dispatch (active) + attempts incremented + persisted", () => {
    writeStore(dir, [item({ key: "R1", status: "reviewing", title: "r1" })]);
    const st = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    st.items["R1"].reviewerRunId = "12345678-dead-beef";
    writeFileSync(join(dir, "queue.json"), JSON.stringify(st));
    const a = make();
    const r = a.handleAsyncComplete({
      runId: "12345678-dead-beef-cafe",
      agent: "workflow",
      results: [{ agent: "orchestrator-reviewer", output: "Verdict: FAIL\nFix the schema.", runId: "12345678-dead-beef" }],
    });
    expect(r.tick?.message).toContain("attempt 1");
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["R1"].status).toBe("active");
    expect(store.items["R1"].attempts).toBe(1);
  });

  test("reviewer verdict FAIL at cap → failed (PERSISTED) + cap tick", () => {
    writeStore(dir, [item({ key: "R1", status: "reviewing", title: "r1" })]);
    const st = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    st.items["R1"].reviewerRunId = "12345678-dead-beef";
    st.items["R1"].attempts = 4; // next FAIL hits the cap of 5
    writeFileSync(join(dir, "queue.json"), JSON.stringify(st));
    const a = make();
    const r = a.handleAsyncComplete({
      runId: "12345678-dead-beef-cafe",
      agent: "workflow",
      results: [{ agent: "orchestrator-reviewer", output: "Verdict: FAIL", runId: "12345678-dead-beef" }],
    });
    expect(r.tick?.message).toContain("cap 5");
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["R1"].status).toBe("failed"); // PERSISTED — the reviewer-caught bug
    expect(store.items["R1"].attempts).toBe(5);
  });

  test("unparseable verdict → no flip, manual review tick", () => {
    writeStore(dir, [item({ key: "R1", status: "reviewing", title: "r1" })]);
    const st = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    st.items["R1"].reviewerRunId = "12345678-dead-beef";
    writeFileSync(join(dir, "queue.json"), JSON.stringify(st));
    const a = make();
    const r = a.handleAsyncComplete({
      runId: "12345678-dead-beef-cafe",
      agent: "workflow",
      results: [{ agent: "orchestrator-reviewer", output: "Everything looks good, minor nit.", runId: "12345678-dead-beef" }],
    });
    expect(r.flipped).toBe(false);
    expect(r.tick?.message).toContain("not parseable");
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["R1"].status).toBe("reviewing"); // untouched
  });

  test("reviewers in flight occupy a slot (store fallback counts them)", () => {
    // store: 1 active worker + 1 reviewing item with a reviewer dispatched
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "R1", status: "reviewing", title: "r1", reviewerRunId: "6f559944" }),
      item({ key: "B1", status: "approved", ready: true, title: "b1" }),
    ]);
    const a = make();
    const r = a.sweep("timer", 1_000_000); // no fleet → store fallback
    expect(r.tick?.facts.occupied).toBe(2); // worker + reviewer both count
    expect(r.tick?.reason).toBe("dispatch"); // 1 free (3 - 2) + B1 ready
  });

  test("fleet ledger guards against store undercount (no false free slots)", () => {
    // store has 0 active (orchestrator forgot to dispatch-record), ledger says 2 running
    writeStore(dir, [item({ key: "B1", status: "approved", ready: true, title: "b1" })]);
    const a = make();
    a.handleAsyncStarted("run-1-aaaa-1111", "worker");
    a.handleAsyncStarted("run-2-aaaa-2222", "worker");
    const r = a.sweep("timer", 1_000_000);
    expect(r.tick?.facts.occupied).toBe(2); // from events, store parsed 0
    expect(r.tick?.reason).toBe("dispatch"); // 1 free + B1 ready
  });

  test("tick carries transparent FLEET:/QUEUE: facts with readyKeys", () => {
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "B1", status: "approved", ready: true, title: "b1" }),
    ]);
    const a = make();
    a.handleAsyncComplete({ runId: "371d1bb9-aaaa", agent: "worker", success: true });
    const tick = a.sweep("worker-done", 1_000_000, { occupied: 0 }).tick;
    expect(tick?.message).toContain("[orch-tick: dispatch]");
    expect(tick?.message).toContain("FLEET:");
    expect(tick?.message).toContain("QUEUE:");
    expect(tick?.facts.readyKeys).toEqual(["B1"]);
  });
});

describe("core.parseStateDirFromCommand", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-cmd-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("parses the STATE_DIR line from an orchestrate.md Workspace block", () => {
    const f = join(dir, "orchestrate.md");
    writeFileSync(f, `# Orchestrator Mode\n...\n## Workspace (personal mode — not synced)\n\n- \`STATE_DIR\`: \`~/.local/state/orchestrator-personal/\`\n- \`GOALS_FILE\`: \`~/.local/state/orchestrator-personal/goals.json\`\n`);
    const got = parseStateDirFromCommand(f);
    expect(got).toBe(join(process.env.HOME ?? "/", ".local/state/orchestrator-personal"));
  });

  test("returns null for a file without STATE_DIR", () => {
    const f = join(dir, "nope.md");
    writeFileSync(f, "# nothing\n");
    expect(parseStateDirFromCommand(f)).toBeNull();
  });
});

describe("core config + sentinel", () => {
  let dir: string;
  function make(config: Record<string, unknown> = {}) {
    return new Autopilot({ stateDir: dir, log: () => {}, ...config });
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("sentinel on/off roundtrip, default unset", () => {
    expect(readSentinel(dir)).toBe("unset");
    writeSentinel(dir, "on");
    expect(readSentinel(dir)).toBe("on");
    writeSentinel(dir, "off");
    expect(readSentinel(dir)).toBe("off");
  });

  test("per-session autopilot: sessions are independent, default off", () => {
    expect(readSessionAutopilotState(dir, "sess-A")).toBe("off");
    writeSessionAutopilotState(dir, "sess-A", "on");
    expect(readSessionAutopilotState(dir, "sess-A")).toBe("on");
    expect(readSessionAutopilotState(dir, "sess-B")).toBe("off");
    expect(isAutopilotOn(dir, "sess-A")).toBe(true);
    expect(isAutopilotOn(dir, "sess-B")).toBe(false);
    expect(isAutopilotOn(dir)).toBe(false);
  });

  test("legacy global sentinel migrates to the first session, then legacy is off", () => {
    writeSentinel(dir, "on");
    expect(readSessionAutopilotState(dir, "first-session")).toBe("on");
    expect(readSentinel(dir)).toBe("off");
    expect(readSessionAutopilotState(dir, "second-session")).toBe("off");
  });

  test("config file + env override", () => {
    expect(loadAutopilotConfig(dir).maxSlots).toBe(3);
    saveAutopilotConfig(dir, { maxSlots: 5, queueLowThreshold: 3 });
    const cfg = loadAutopilotConfig(dir, {} as NodeJS.ProcessEnv);
    expect(cfg.maxSlots).toBe(5);
    expect(cfg.queueLowThreshold).toBe(3);
    const envCfg = loadAutopilotConfig(dir, { AUTOPILOT_MAX_SLOTS: "7" } as NodeJS.ProcessEnv);
    expect(envCfg.maxSlots).toBe(7);
  });

  test("capacity change reflects in tick facts", () => {
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "B1", status: "approved", ready: true, title: "b1" }),
    ]);
    const a = make({ maxSlots: 4 });
    a.handleAsyncComplete({ runId: "371d1bb9-aaaa", agent: "worker", success: true });
    const tick = a.sweep("worker-done", 1_000_000, { occupied: 0 }).tick;
    expect(tick?.facts.slotsFree).toBe(4); // G1 freed, capacity 4
  });
});

describe("intake suppression (proposals pending)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-intake-"));
  const make = () => new Autopilot({ stateDir: dir });
  const writeStore = (items: QueueItem[]) => {
    const store = newStore();
    for (const it of items) addItem(store, it);
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store));
  };

  test("intake fires with 0 proposals + low ready", () => {
    const f = make();
    writeStore([item({ key: "A1", status: "approved", ready: false, title: "a1" })]);
    const t = f.sweep("timer", 1_000_000).tick;
    expect(t?.reason).toBe("intake");
  });

  test("intake SUPPRESSED while proposals are pending (the user deliberates — the user's scenario)", () => {
    const f = make();
    // the previous intake proposed items; the approved buffer is still low
    writeStore([
      item({ key: "P1", status: "proposal", ready: false, title: "p1" }),
      item({ key: "P2", status: "proposal", ready: false, title: "p2" }),
    ]);
    // even a hash change (adding more proposals) must NOT re-fire intake
    const t1 = f.sweep("timer", 1_000_000).tick;
    expect(t1).toBeNull();
    const t2 = f.sweep("settled", 1_100_000).tick;
    expect(t2).toBeNull();
  });

  test("intake re-arms when the proposals resolve (rejected → pending 0)", () => {
    const f = make();
    writeStore([
      item({ key: "P1", status: "proposal", ready: false, title: "p1" }),
      item({ key: "A1", status: "approved", ready: false, title: "a1" }),
    ]);
    expect(f.sweep("timer", 1_000_000).tick).toBeNull(); // suppressed
    // the user rejects P1 → no proposals pending → intake re-arms
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    store.items["P1"].status = "rejected";
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store));
    const t = f.sweep("timer", 2_000_000).tick;
    expect(t?.reason).toBe("intake");
  });

  test("dispatch is NOT suppressed by pending proposals (execution proceeds)", () => {
    const f = make();
    writeStore([
      item({ key: "P1", status: "proposal", ready: false, title: "p1" }),
      item({ key: "A1", status: "approved", ready: true, title: "a1" }),
    ]);
    const t = f.sweep("timer", 1_000_000).tick;
    expect(t?.reason).toBe("dispatch"); // ready 1 + slot free → dispatch, not intake
  });
});
