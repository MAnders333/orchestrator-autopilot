// autopilot.test.ts — core decision engine tests (STORE-first model).
// The legacy md parser (queue.ts) is retired with state.md — the parser logic
// survives only in queue-store.migrateFromMd (covered in queue-store.test.ts).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
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
  autopilotCommand,
  resolveStateDir,
  autopilotModeMessage,
  autopilotConfigPath,
  probeStateDir,
  logStateDirProbe,
  staleProvisionalProposals,
  underSpecifiedProposals,
  workspaceFactsPromised,
} from "../src/config.ts";
import { buildPanelDoc } from "../src/framework/panels.ts";
import { isUnisolatedWorkerSpawn } from "../src/framework/auto-dispatch.ts";
import {
  newStore,
  addItem,
  saveStore,
  updateItem,
  type QueueStore,
  type QueueItem,
} from "../src/queue-store.ts";
import type { Tick } from "../src/types.ts";

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
      item({ key: "B1", status: "approved", title: "b1" }),
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
    expect(store.items["G1"].status).toBe("ai-review");
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
    writeStore(dir, [item({ key: "B1", status: "approved", title: "b1" })]);
    const r = make().handleAsyncComplete({ runId: "99999999-aaaa", agent: "orchestrator-reviewer", success: true });
    expect(r.flipped).toBe(false);
    expect(r.freedSlot).toBe(true); // a reviewer completion frees its slot — capacity counts all subagents
  });

  test("unmatched WORKER completion logs telemetry (pipeline-bypass signature) — scouts don't, matched workers don't", () => {
    writeStore(dir, [item({ key: "K1", status: "active", runId: "match1234", title: "k1" })]);
    const a = make();
    a.handleAsyncComplete({ runId: "ecc034e3-1234", agent: "worker", success: true }); // bypass: no item carries this id
    a.handleAsyncComplete({ runId: "scout9999", agent: "scout", success: true }); // non-harness agent: expected unmatched
    a.handleAsyncComplete({ runId: "match1234-aaaa", agent: "worker", success: true }); // properly linked
    const unmatched = telemetry.filter((l) => l.includes('"unmatched-completion"'));
    expect(unmatched.length).toBe(1); // ONLY the bypassed worker run
    expect(unmatched[0]).toContain("ecc034e3");
  });

  test("ledger-tracked completion without store match still ticks (fail-safe)", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", title: "b1" })]);
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
      item({ key: "B1", status: "approved", title: "b1" }),
    ]);
    const r = make().sweep("activate");
    expect(r.tick?.reason).toBe("dispatch");
    expect(r.tick?.facts.slotsFree).toBe(2);
  });

  test("settled re-ticks only on state change; timer re-nudges a persistent gap", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", title: "b1" })]);
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
      item({ key: "B1", status: "approved", title: "b1" }),
      item({ key: "B2", status: "approved", title: "b2" }),
    ]);
    expect(a.sweep("timer", 3_000_000).tick).toBeNull();
  });

  test("reviewer verdict PASS → item done + verdict event + tick", () => {
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "R1", status: "ai-review", title: "r1" }),
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
    expect(r.tick?.message).toContain("HUMAN review");
    expect(r.domainEvents.some((e) => e.name === "orch:verdict" && e.data.verdict === "PASS")).toBe(true);
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    // AI PASS puts the item in HUMAN review (your approval), not done
    expect(store.items["R1"].status).toBe("human-review");
  });

  test("reviewer verdict FAIL → re-dispatch (active) + attempts incremented + persisted", () => {
    writeStore(dir, [item({ key: "R1", status: "ai-review", title: "r1" })]);
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
    writeStore(dir, [item({ key: "R1", status: "ai-review", title: "r1" })]);
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
    writeStore(dir, [item({ key: "R1", status: "ai-review", title: "r1" })]);
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
    expect(store.items["R1"].status).toBe("ai-review"); // untouched
  });

  test("reviewers in flight occupy a slot (store fallback counts them)", () => {
    // store: 1 active worker + 1 reviewing item with a reviewer dispatched
    writeStore(dir, [
      item({ key: "G1", status: "active", runId: "371d1bb9", title: "g1" }),
      item({ key: "R1", status: "ai-review", title: "r1", reviewerRunId: "6f559944" }),
      item({ key: "B1", status: "approved", title: "b1" }),
    ]);
    const a = make();
    const r = a.sweep("timer", 1_000_000); // no fleet → store fallback
    expect(r.tick?.facts.occupied).toBe(2); // worker + reviewer both count
    expect(r.tick?.reason).toBe("dispatch"); // 1 free (3 - 2) + B1 ready
  });

  test("fleet ledger guards against store undercount (no false free slots)", () => {
    // store has 0 active (orchestrator forgot to dispatch-record), ledger says 2 running
    writeStore(dir, [item({ key: "B1", status: "approved", title: "b1" })]);
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
      item({ key: "B1", status: "approved", title: "b1" }),
    ]);
    const a = make();
    a.handleAsyncComplete({ runId: "371d1bb9-aaaa", agent: "worker", success: true });
    const tick = a.sweep("worker-done", 1_000_000, { occupied: 0 }).tick;
    expect(tick?.message).toContain("[orch-tick: dispatch]");
    expect(tick?.message).toContain("FLEET:");
    expect(tick?.message).toContain("QUEUE:");
    expect(tick?.facts.readyKeys).toEqual(["B1"]);
  });

  // AUTOPILOT-6 — delivery-time fact refresh: a tick deferred by the busy
  // gate is flushed at the NEXT settle; the store can move underneath it
  // (manual dispatch mid-window, auto-dispatch, completion flips). The flush
  // recomputes FLEET/QUEUE facts from the LIVE store, so a late-delivered
  // tick never claims "X free, N ready (…)" while those items are running.
  test("refreshTickFacts: a deferred dispatch tick is recomputed against the LIVE store at delivery", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", title: "b1" })]);
    const a = make({ quietPeriodMs: 0, maxSlots: 3 });
    const gen = a.sweep("timer", 1_000_000).tick!;
    expect(gen.reason).toBe("dispatch");
    expect(gen.facts.readyKeys).toEqual(["B1"]); // generation-time facts: B1 ready, 0 occupied
    expect(gen.facts.occupied).toBe(0);
    // Between generation and delivery the store moved: B1 dispatched (parent
    // workflow run) + B2 approved — the LIVE state, not the old snapshot.
    const s = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    updateItem(s, "B1", { status: "active", runId: "b0f7631f-parent" });
    addItem(s, item({ key: "B2", title: "b2" }));
    saveStore(dir, s);
    a.handleAsyncStarted("b0f7631f-parent", "workflow"); // the fleet ledger sees the parent spawn
    const fresh = a.refreshTickFacts(gen, undefined, 2_000_000)!;
    expect(fresh.reason).toBe("dispatch"); // slots remain + B2 ready — the nudge still applies
    expect(fresh.facts.occupied).toBe(1); // the dispatched parent counts in FLEET now
    expect(fresh.facts.slotsFree).toBe(2);
    expect(fresh.facts.readyKeys).toEqual(["B2"]); // B1 is NEVER listed ready again
    expect(fresh.message).toContain("FLEET: 1/3");
    expect(fresh.message).not.toContain("B1");
    expect(fresh.facts.refreshedAt).toBe(2_000_000); // delivery-time stamp
    expect(fresh.facts.generatedAt).toBe(1_000_000); // generation time preserved (audit trail)
    // Telemetry characterization: the tick-refresh line timestamps the DELIVERY
    // re-derivation — the gap from the generation `tick` line is the deferral.
    expect(telemetry.some((l) => l.includes('"type":"tick-refresh"') && l.includes('"changed":true'))).toBe(true);
  });

  test("refreshTickFacts: full dispatch while busy → the stale '3 free' claim never surfaces (current nudge instead)", () => {
    writeStore(dir, [
      item({ key: "B1", status: "approved", title: "b1" }),
      item({ key: "B2", status: "approved", title: "b2" }),
      item({ key: "B3", status: "approved", title: "b3" }),
    ]);
    const a = make({ quietPeriodMs: 0, maxSlots: 3 });
    const gen = a.sweep("timer", 1_000_000).tick!;
    expect(gen.message).toContain("FLEET: 0/3");
    expect(gen.message).toContain("3 free");
    // Delivery time: all three items are LIVE (dispatched mid-window)
    const s = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    for (const k of ["B1", "B2", "B3"]) {
      updateItem(s, k, { status: "active", runId: `run-${k}` });
      a.handleAsyncStarted(`run-${k}`, "workflow");
    }
    saveStore(dir, s);
    const fresh = a.refreshTickFacts(gen, undefined, 2_000_000);
    expect(fresh).not.toBeNull(); // SOMETHING truthful applies: with the buffer empty the current nudge is intake
    expect(fresh!.reason).toBe("intake"); // never a dispatch claiming free slots
    expect(fresh!.message).not.toContain("free");
    expect(fresh!.message).toContain("approved buffer low (0 ready");
    expect(fresh!.facts.ready).toBe(0);
  });

  test("refreshTickFacts: no nudge applies to the current state → null (the stale message is dropped, never delivered)", () => {
    writeStore(dir, [
      item({ key: "B1", status: "approved", title: "b1" }),
      item({ key: "B2", status: "approved", title: "b2" }),
    ]);
    const a = make({ quietPeriodMs: 0, maxSlots: 3 });
    const gen = a.sweep("timer", 1_000_000).tick!;
    expect(gen.reason).toBe("dispatch");
    // Delivery time: three ad-hoc runs fill the fleet (the queue never tracks
    // them) while the buffer stays full — neither dispatch nor intake applies.
    a.handleAsyncStarted("scout-1", "scout");
    a.handleAsyncStarted("scout-2", "scout");
    a.handleAsyncStarted("scout-3", "scout");
    expect(a.refreshTickFacts(gen, undefined, 2_000_000)).toBeNull();
  });

  test("refreshTickFacts: state unchanged since generation → the original dispatch tick stands", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", title: "b1" })]);
    const a = make({ quietPeriodMs: 0 });
    const gen = a.sweep("timer", 1_000_000).tick!;
    const fresh = a.refreshTickFacts(gen, undefined, 2_000_000)!;
    expect(fresh.message).toBe(gen.message); // no changes → identical message
    expect(fresh.facts.readyKeys).toEqual(["B1"]);
    expect(fresh.facts.occupied).toBe(0);
    expect(fresh.facts.refreshedAt).toBe(2_000_000); // audit stamp still added at delivery
  });

  test("refreshTickFacts: review ticks pass through untouched (event-scoped facts, no FLEET/QUEUE claims)", () => {
    const a = make();
    const reviewTick: Tick = { reason: "review", message: "[orch-tick: review] R1 PASSED — awaiting you", facts: { key: "R1", verdict: "PASS" } };
    expect(a.refreshTickFacts(reviewTick)).toBe(reviewTick);
  });

  test("zombieReconcile: an UNAVAILABLE fleet count (RPC failure) never acts as a fake 0 (AUTOPILOT-6)", () => {
    const s = newStore();
    addItem(s, item({ key: "Z1", status: "active", runId: "runner-alive", title: "long worker" }));
    // idle past the grace — a REAL 0 would flip it, but the RPC failed:
    s.items["Z1"].updatedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    saveStore(dir, s);
    const r = make().zombieReconcile(undefined); // fleet status timed out — unknown ≠ 0
    expect(r.flippedKeys).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")).items["Z1"].status).toBe("active");
  });

  test("fleet parity: a transient fleet UNDERTCOUNT never shows phantom free slots (occupied = UNION, AUTOPILOT-6)", () => {
    writeStore(dir, [item({ key: "B1", status: "approved", title: "b1" })]);
    const a = make({ quietPeriodMs: 0 });
    a.handleAsyncStarted("b0f7631f", "workflow"); // a parent run the status RPC has NOT caught up to
    const tick = a.sweep("timer", 1_000_000, { occupied: 0 }).tick; // the RPC undercounts: reports 0
    expect(tick?.facts.occupied).toBe(1); // the ledger's parent is never erased by the lagging RPC
    expect(tick?.message).toContain("FLEET: 1/3");
    expect(tick?.message).not.toContain("0/3");
  });

  test("fleet parity: a worktree-parent spawn counts in FLEET; its completion attributes correctly (AUTOPILOT-6)", () => {
    writeStore(dir, [
      item({ key: "P1", status: "active", runId: "b0f7631f", title: "parent" }),
      item({ key: "B1", status: "approved", title: "b1" }),
    ]);
    const a = make({ quietPeriodMs: 0 });
    a.handleAsyncStarted("b0f7631f", "workflow"); // the parent spawn (queue_dispatch → workflow mode)
    // The parent counts in FLEET via the ledger — no false 0 for the sweep /
    // zombie net even when the queue view is light.
    const sweepView = a.sweep("timer", 1_000_000).tick!;
    expect(sweepView.facts.occupied).toBe(1);
    expect(sweepView.message).toContain("FLEET: 1/3");
    // The parent completes → ITS item is attributed + flipped (never left active)
    const r = a.handleAsyncComplete({
      runId: "b0f7631f",
      agent: "workflow",
      success: true,
      results: [{ agent: "worker", runId: "b0f7631f-child", sessionPath: "/s/b0f7631f/run-0/session.jsonl" }],
    });
    expect(r.flipped).toBe(true);
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(store.items["P1"].status).toBe("ai-review");
    // The freed slot → dispatch nudge for the ready work, count back to 0
    const after = a.sweep("worker-done", 2_000_000, { occupied: 0 }).tick!;
    expect(after.facts.occupied).toBe(0);
    expect(after.facts.readyKeys).toEqual(["B1"]);
  });

  test("resolveStateDir: basename-scoped — deterministic per profile, no mode-name semantics", () => {
    delete process.env.AUTOPILOT_STATE_DIR;
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/Users/x/.pi/personal";
    try {
      expect(resolveStateDir(undefined)).toBe(join(homedir(), ".local/state/orchestrator/personal"));
      process.env.PI_CODING_AGENT_DIR = "/Users/x/.pi/work";
      expect(resolveStateDir(undefined)).toBe(join(homedir(), ".local/state/orchestrator/work"));
      // existence-independent: a BRAND-NEW profile resolves to its scoped path
      process.env.PI_CODING_AGENT_DIR = "/Users/x/.pi/brand-new";
      expect(resolveStateDir(undefined)).toBe(join(homedir(), ".local/state/orchestrator/brand-new"));
      // sanitization: weird basename → clean; degenerate → "default"
      process.env.PI_CODING_AGENT_DIR = "/Users/x/.pi/my profile!";
      expect(resolveStateDir(undefined)).toBe(join(homedir(), ".local/state/orchestrator/myprofile"));
      process.env.PI_CODING_AGENT_DIR = "/";
      expect(resolveStateDir(undefined)).toBe(join(homedir(), ".local/state/orchestrator/default")); // degenerate root
    } finally {
      process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  test("resolveStateDir: commandFile STATE_DIR line still wins (opencode config-carried)", () => {
    delete process.env.AUTOPILOT_STATE_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    const fakeAgentDir = join(dir, "fake-mode");
    const fakeState = join(dir, "resolved-state");
    mkdirSync(join(fakeAgentDir, "prompts"), { recursive: true });
    writeFileSync(
      join(fakeAgentDir, "prompts", "orchestrate.md"),
      `# Orchestrator Mode\n\n- \`STATE_DIR\`: \`${fakeState}/\`\n`,
    );
    expect(resolveStateDir(join(fakeAgentDir, "prompts/orchestrate.md"))).toBe(fakeState);
  });

  test("workspace config roundtrip: intake sources + goals file survive loadAutopilotConfig", () => {
    writeAtomic(autopilotConfigPath(dir), JSON.stringify({
      maxSlots: 4,
      workspace: {
        goalsFile: "my-goals.json",
        intake: [{ type: "jira", project: "MI" }, { type: "git-state" }],
        notes: "personal mode",
      },
    }));
    const cfg = loadAutopilotConfig(dir);
    expect(cfg.maxSlots).toBe(4);
    expect(cfg.workspace?.goalsFile).toBe("my-goals.json");
    expect(cfg.workspace?.intake).toEqual([{ type: "jira", project: "MI" }, { type: "git-state" }]);
    expect(cfg.workspace?.notes).toBe("personal mode");
  });

  test("autopilotModeMessage ON carries the workspace facts pointer only when asked", () => {
    expect(autopilotModeMessage("on", { stateDir: "/tmp/state" })).toContain("/tmp/state");
    expect(autopilotModeMessage("on", { stateDir: "/tmp/state" })).toContain("autopilot.config.json");
    expect(autopilotModeMessage("on")).not.toContain("Workspace facts");
    expect(autopilotModeMessage("off", { stateDir: "/tmp/state" })).not.toContain("Workspace facts");
  });

  test("zombieReconcile: fleet idle + active item past grace → flipped to failed with evidence in notes", () => {
    const s = newStore();
    addItem(s, item({ key: "Z1", status: "active", runId: "deadfeed", title: "zombie" }));
    addItem(s, item({ key: "F1", status: "active", runId: "fresh1234", title: "fresh" }));
    // addItem stamps updatedAt = insert time; set the idle window explicitly
    s.items["Z1"].updatedAt = new Date(Date.now() - 45 * 60_000).toISOString(); // 45m idle > 30m grace
    s.items["F1"].updatedAt = new Date().toISOString(); // fresh
    saveStore(dir, s);
    const ap = make();
    const r = ap.zombieReconcile(0); // fleet reports ZERO active runs
    expect(r.flippedKeys).toEqual(["Z1"]); // only the stale one
    const after = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    expect(after.items["Z1"].status).toBe("failed");
    expect(after.items["Z1"].runId).toBeNull(); // failed clears stale run refs
    expect(after.items["Z1"].notes).toContain("zombie reconciliation");
    expect(after.items["Z1"].notes).toContain("deadfeed");
    expect(after.items["Z1"].notes).toContain("pi-parallel-*"); // points at partial-work recovery
    expect(after.items["F1"].status).toBe("active"); // within grace — untouched
    expect(telemetry.some((l) => l.includes('"source":"zombie"'))).toBe(true);
  });

  test("zombieReconcile: fleet busy → nothing flips even past grace (something IS running)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "autopilot-zombie-"));
    try {
      const s = newStore();
      addItem(s, item({ key: "Z1", status: "active", runId: "alive0000", title: "long worker" }));
      s.items["Z1"].updatedAt = new Date(Date.now() - 45 * 60_000).toISOString();
      saveStore(dir2, s);
      const r = new Autopilot({ stateDir: dir2 }).zombieReconcile(2); // 2 runs live elsewhere/legit long workers
      expect(r.flippedKeys).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir2, "queue.json"), "utf8")).items["Z1"].status).toBe("active");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("zombieReconcile: zombieGraceMinutes 0 disables the sweep", () => {
    const s = newStore();
    addItem(s, item({ key: "Z1", status: "active", runId: "deadfeed", title: "zombie" }));
    s.items["Z1"].updatedAt = new Date(Date.now() - 48 * 3600_000).toISOString(); // 48h idle
    saveStore(dir, s);
    const r = make({ zombieGraceMinutes: 0 }).zombieReconcile(0);
    expect(r.flippedKeys).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")).items["Z1"].status).toBe("active");
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

  test("unknown session defaults OFF — no legacy-sentinel auto-on", () => {
    // The legacy global .autopilot=on must NOT turn a fresh session on: a
    // session only ever starts via explicit /autopilot on.
    writeSentinel(dir, "on");
    expect(readSessionAutopilotState(dir, "first-session")).toBe("off");
    expect(readSentinel(dir)).toBe("on"); // untouched — not consumed by a migration
    writeSessionAutopilotState(dir, "first-session", "on");
    expect(readSessionAutopilotState(dir, "first-session")).toBe("on"); // explicit toggle works
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
      item({ key: "B1", status: "approved", title: "b1" }),
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
    writeStore([item({ key: "A1", status: "blocked", blocker: "parked", title: "a1" })]); // blocked: approved buffer is effectively low
    const t = f.sweep("timer", 1_000_000).tick;
    expect(t?.reason).toBe("intake");
  });

  test("intake SUPPRESSED while proposals are pending (the user deliberates — the user's scenario)", () => {
    const f = make();
    // the previous intake proposed items; the approved buffer is still low
    writeStore([
      item({ key: "P1", status: "proposal", title: "p1" }),
      item({ key: "P2", status: "proposal", title: "p2" }),
    ]);
    // even a hash change (adding more proposals) must NOT re-fire intake
    const t1 = f.sweep("timer", 1_000_000).tick;
    expect(t1).toBeNull();
    const t2 = f.sweep("settled", 1_100_000).tick;
    expect(t2).toBeNull();
  });

  test("intake re-arms when a proposal goes STALE (older than the suppression window) + names it", () => {
    const f = make();
    // a proposal pending longer than the default 24h window must NOT starve
    // the refill nudge forever — the user's real scenario (B1 since 08-17)
    writeStore([item({ key: "B1", status: "proposal", title: "b1" })]);
    // addItem stamps createdAt=now — mutate the STORED item to 30h ago
    const store = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    store.items["B1"].createdAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    store.items["B1"].updatedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    writeFileSync(join(dir, "queue.json"), JSON.stringify(store));
    const t = f.sweep("timer", Date.now()).tick;
    expect(t?.reason).toBe("intake"); // the suppression lapsed
    expect(t?.message).toContain("B1 has been pending"); // the stale proposal is named
  });

  test("a FRESH proposal still suppresses (within the window)", () => {
    const f = make();
    writeStore([item({ key: "P1", status: "proposal", title: "p1" })]); // createdAt = now
    expect(f.sweep("timer", Date.now()).tick).toBeNull();
  });

  test("intake re-arms when the proposals resolve (rejected → pending 0)", () => {
    const f = make();
    writeStore([
      item({ key: "P1", status: "proposal", title: "p1" }),
      item({ key: "A1", status: "blocked", blocker: "parked", title: "a1" }),
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
      item({ key: "P1", status: "proposal", title: "p1" }),
      item({ key: "A1", status: "approved", title: "a1" }),
    ]);
    const t = f.sweep("timer", 1_000_000).tick;
    expect(t?.reason).toBe("dispatch"); // ready 1 + slot free → dispatch, not intake
  });
});

describe("autopilotCommand — ONE shared toggle implementation (both hosts)", () => {
  test("on/off write the per-session state + return the framework's mode message", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-cmd-"));
    const on = autopilotCommand("on", undefined, { stateDir: dir, sessionId: "s1" });
    expect(on.ok).toBe(true);
    expect(on.mode).toBe("on");
    expect(on.message).toContain("Autopilot is now ON");
    expect(isAutopilotOn(dir, "s1")).toBe(true);
    const off = autopilotCommand("off", undefined, { stateDir: dir, sessionId: "s1" });
    expect(off.mode).toBe("off");
    expect(off.message).toContain("Autopilot is now OFF");
    expect(isAutopilotOn(dir, "s1")).toBe(false);
  });
  test("status reports mode + capacity; capacity validates + saves", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-cmd-"));
    const st = autopilotCommand("status", undefined, { stateDir: dir, sessionId: "s1" });
    expect(st.message).toContain("Autopilot OFF");
    expect(st.message).toContain("capacity 3 workers");
    const cap = autopilotCommand("capacity", "5", { stateDir: dir, sessionId: "s1" });
    expect(cap.ok).toBe(true);
    expect(cap.message).toContain("5");
    expect(loadAutopilotConfig(dir).maxSlots).toBe(5);
    expect(autopilotCommand("capacity", "0", { stateDir: dir, sessionId: "s1" }).ok).toBe(false);
    expect(autopilotCommand("bogus", undefined, { stateDir: dir, sessionId: "s1" }).ok).toBe(false);
  });

});
});

describe("isUnisolatedWorkerSpawn — the B26 rule as a shared predicate", () => {
  test("a worker spawn without worktree:true is blocked; isolated + management actions pass", () => {
    const agents = ["worker"];
    expect(isUnisolatedWorkerSpawn({ agent: "worker" }, agents)).toBe(true);
    expect(isUnisolatedWorkerSpawn({ agent: "worker", worktree: false }, agents)).toBe(true);
    expect(isUnisolatedWorkerSpawn({ agent: "worker", worktree: true }, agents)).toBe(false);
    expect(isUnisolatedWorkerSpawn({ agent: "other", worktree: false }, agents)).toBe(false);
    expect(isUnisolatedWorkerSpawn({ action: "status", agent: "worker" }, agents)).toBe(false);
    expect(isUnisolatedWorkerSpawn({}, agents)).toBe(false);
  });
});

describe("AUTOPILOT-3 state-dir probe (probeStateDir + logStateDirProbe)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-probe-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a healthy resolved dir passes silently (no findings)", () => {
    writeStore(dir, [item({ key: "A1", status: "approved", title: "a1" })]);
    const r = probeStateDir({ stateDir: dir });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  test("missing dir OR missing queue.json → findings (the phantom/empty-store signatures)", () => {
    const missing = probeStateDir({ stateDir: join(dir, "nope") });
    expect(missing.ok).toBe(false);
    expect(missing.findings.some((f) => f.includes("PHANTOM"))).toBe(true);
    // dir with NO queue.json (migration never ran / projection points at an empty dir)
    const empty = probeStateDir({ stateDir: dir });
    expect(empty.ok).toBe(false);
    expect(empty.findings.some((f) => f.includes("EMPTY store"))).toBe(true);
  });

  test("autopilot.config.json checked when workspace facts are promised (command-file inference + explicit flag)", () => {
    writeStore(dir, [item({ key: "A1", status: "approved", title: "a1" })]);
    const cmd = join(dir, "orchestrate.md");
    writeFileSync(cmd, `# Orchestrator Mode\n\n## Workspace facts (config)\n\n- \`STATE_DIR\`: \`${dir}/\`\n`);
    const r = probeStateDir({ stateDir: dir, commandFile: cmd });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.includes("autopilot.config.json is missing"))).toBe(true);
    // an explicit promise works without a command file
    const r2 = probeStateDir({ stateDir: dir, expectWorkspaceConfig: true });
    expect(r2.findings.some((f) => f.includes("autopilot.config.json is missing"))).toBe(true);
    // no promise → the check is skipped (fresh/default setups stay quiet)
    expect(probeStateDir({ stateDir: dir }).ok).toBe(true);
    // facts readable → the same probe passes
    writeFileSync(join(dir, "autopilot.config.json"), JSON.stringify({ workspace: { notes: "x" } }));
    expect(probeStateDir({ stateDir: dir, commandFile: cmd }).ok).toBe(true);
  });

  test("host parity: extension resolution vs the orchestrate.md STATE_DIR projection", () => {
    writeStore(dir, [item({ key: "A1", status: "approved", title: "a1" })]); // the ENV-resolved store
    const projected = join(dir, "projected");
    writeStore(projected, [item({ key: "P1", status: "proposal", title: "p1" })]); // where the projection points
    const cmd = join(dir, "orchestrate.md");
    writeFileSync(cmd, `- \`STATE_DIR\`: \`${projected}/\`\n`);
    const r = probeStateDir({ stateDir: dir, commandFile: cmd });
    expect(r.findings.some((f) => f.includes("HOST PARITY MISMATCH"))).toBe(true);
    // the projection agreeing with the extension → silent
    const cmd2 = join(dir, "orchestrate-ok.md");
    writeFileSync(cmd2, `- \`STATE_DIR\`: \`${dir}/\`\n`);
    expect(probeStateDir({ stateDir: dir, commandFile: cmd2 }).ok).toBe(true);
  });

  test("a command file WITHOUT a STATE_DIR line is flagged (the orchestrator has no projected dir)", () => {
    writeStore(dir, [item({ key: "A1", status: "approved", title: "a1" })]);
    const cmd = join(dir, "orchestrate.md");
    writeFileSync(cmd, "# Orchestrator Mode\nno state dir line\n");
    const r = probeStateDir({ stateDir: dir, commandFile: cmd });
    expect(r.findings.some((f) => f.includes("no STATE_DIR line"))).toBe(true);
  });

  test("probe NEVER throws — unreadable/missing command files degrade to findings or silence", () => {
    writeStore(dir, [item({ key: "A1", status: "approved", title: "a1" })]);
    // an absent command file: no projection claims to check → silent
    expect(probeStateDir({ stateDir: dir, commandFile: join(dir, "missing.md") }).ok).toBe(true);
    // a DIRECTORY passed as the command file → internal read throws → swallowed
    expect(() => probeStateDir({ stateDir: dir, commandFile: dir })).not.toThrow();
  });

  test("logStateDirProbe writes ONE telemetry line only when findings exist", () => {
    const logPath = join(dir, "autopilot.jsonl");
    logStateDirProbe(dir, probeStateDir({ stateDir: join(dir, "missing") }), { hook: "session_start" });
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("state-dir-probe");
    expect(lines[0].hook).toBe("session_start");
    expect(Array.isArray(lines[0].findings)).toBe(true);
    // a healthy report appends nothing
    const before = readFileSync(logPath, "utf8");
    logStateDirProbe(dir, { ok: true, findings: [] });
    expect(readFileSync(logPath, "utf8")).toBe(before);
  });

  test("workspaceFactsPromised reads only the Workspace-facts marker / config pointer", () => {
    const cmd = join(dir, "orchestrate.md");
    writeFileSync(cmd, "## Workspace facts (config)\nthe promise lives here\n");
    expect(workspaceFactsPromised(cmd)).toBe(true);
    writeFileSync(cmd, "read autopilot.config.json before scanning\n");
    expect(workspaceFactsPromised(cmd)).toBe(true);
    writeFileSync(cmd, "## Workspace\n- `STATE_DIR`: `/tmp/x`\n");
    expect(workspaceFactsPromised(cmd)).toBe(false); // a bare projection promises no facts
    expect(workspaceFactsPromised(join(dir, "missing.md"))).toBe(false);
  });
});

describe("AUTOPILOT-3 provisional-linger (staleProvisionalProposals + status surface)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-linger-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  test("flags ONLY Q-<n> PROVISIONAL proposals older than the threshold, oldest first", () => {
    writeStore(dir, [
      item({ key: "Q-9", status: "proposal", provisionalKey: true, title: "old provisional", createdAt: ago(8) }),
      item({ key: "Q-10", status: "proposal", provisionalKey: true, title: "middle provisional", createdAt: ago(4) }),
      item({ key: "Q-11", status: "proposal", provisionalKey: true, title: "fresh provisional", createdAt: ago(1) }),
      item({ key: "B-1", status: "proposal", title: "real series proposal", createdAt: ago(8) }), // no provisional marker
      item({ key: "Q-20", status: "approved", provisionalKey: true, title: "already approved", createdAt: ago(8) }), // not a proposal
      item({ key: "Q-30", status: "proposal", title: "explicit Q key", createdAt: ago(8) }), // key shape alone is NOT enough
    ]);
    const stale = staleProvisionalProposals(dir); // default threshold 3
    expect(stale.map((s) => s.key)).toEqual(["Q-9", "Q-10"]);
    expect(stale[0].days).toBeGreaterThanOrEqual(8);
    expect(stale[1].days).toBeGreaterThanOrEqual(4);
  });

  test("thresholdDays + now are honored (hermetic age math)", () => {
    writeStore(dir, [item({ key: "Q-1", status: "proposal", provisionalKey: true, title: "pending", createdAt: ago(8) })]);
    expect(staleProvisionalProposals(dir)).toHaveLength(1); // 3d default
    expect(staleProvisionalProposals(dir, { thresholdDays: 10 })).toHaveLength(0); // 8d < 10d
    // the `now` clock is injected: 2d BEFORE the item was created → not stale yet
    expect(staleProvisionalProposals(dir, { now: Date.parse(ago(10)), thresholdDays: 3 })).toHaveLength(0);
    // 9d AFTER the item was created relative to a future clock → 17d old → stale
    expect(staleProvisionalProposals(dir, { now: Date.parse(ago(-9)), thresholdDays: 3 })).toHaveLength(1);
  });

  test("never throws on a missing/corrupt store", () => {
    const r = staleProvisionalProposals(join(dir, "missing"));
    expect(r).toEqual([]);
    expect(() => staleProvisionalProposals(dir)).not.toThrow(); // isEmpty → []
  });

  test("provisionalLingerDays loads from config (default 3; file wins)", () => {
    expect(loadAutopilotConfig(dir).provisionalLingerDays).toBe(3);
    saveAutopilotConfig(dir, { provisionalLingerDays: 30 });
    expect(loadAutopilotConfig(dir).provisionalLingerDays).toBe(30);
    saveAutopilotConfig(dir, { provisionalLingerDays: 0 });
    expect(loadAutopilotConfig(dir).provisionalLingerDays).toBe(3); // invalid → default
  });

  test("/autopilot status NAMES lingering provisionals (nobody mistakes them for real keys)", () => {
    writeStore(dir, [
      item({ key: "Q-9", status: "proposal", provisionalKey: true, title: "old provisional", createdAt: ago(8) }),
      item({ key: "B-4", status: "approved", title: "real work", createdAt: ago(8) }),
    ]);
    const r = autopilotCommand("status", undefined, { stateDir: dir, sessionId: "s1" });
    expect(r.message).toContain("Q-9 (8d)");
    expect(r.message).toContain("NOT a real key");
    expect(r.message).not.toContain("B-4"); // a real series key is never named
  });
});

describe("AUTOPILOT-26 spec-completeness (underSpecifiedProposals + status surface)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-spec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const specified = readFileSync(join(import.meta.dir, "fixtures", "scope-autopilot-20.txt"), "utf8");

  test("flags ONLY proposals, and only the under-specified ones (no-scope first)", () => {
    writeStore(dir, [
      item({ key: "P1", status: "proposal", title: "thin", scope: "Fix the parser", cwd: "/tmp/repo" }),
      item({ key: "P2", status: "proposal", title: "capture note", scope: "", cwd: null }),
      item({ key: "P3", status: "proposal", title: "specified", scope: specified, cwd: "/tmp/repo" }),
      item({ key: "A1", status: "approved", title: "approved thin", scope: "go", cwd: "/tmp/repo" }), // not a proposal
    ]);
    const thin = underSpecifiedProposals(dir);
    expect(thin.map((t) => t.key)).toEqual(["P2", "P1"]); // no-scope outranks thin-scope
    expect(thin[0].gaps).toEqual(["no-scope", "no-cwd"]);
  });

  test("never throws on a missing/corrupt store", () => {
    expect(underSpecifiedProposals(join(dir, "missing"))).toEqual([]);
    expect(() => underSpecifiedProposals(dir)).not.toThrow();
  });

  test("/autopilot status count MATCHES the panel count, and says nothing when every proposal is specified", () => {
    writeStore(dir, [
      item({ key: "P1", status: "proposal", title: "thin", scope: "Fix the parser", cwd: "/tmp/repo" }),
      item({ key: "P2", status: "proposal", title: "capture note", scope: "", cwd: null }),
      item({ key: "P3", status: "proposal", title: "specified", scope: specified, cwd: "/tmp/repo" }),
    ]);
    const r = autopilotCommand("status", undefined, { stateDir: dir, sessionId: "s1" });
    expect(r.message).toContain("2 proposals under-specified");
    expect(r.message).toContain("P2 (NEEDS SPEC: no scope, no repo (cwd))");
    expect(r.message).toContain("P1 (thin spec:");
    expect(r.message).not.toContain("P3 ("); // a specified proposal is never named
    // the panel section title reports the SAME count (one helper, two surfaces)
    const tagged = buildPanelDoc(dir, "proposals").sections[0].items.filter((i) => i.specGaps?.length).length;
    expect(tagged).toBe(2);
    expect(buildPanelDoc(dir, "proposals").sections[0].title).toContain(`${tagged} need spec`);

    writeStore(dir, [item({ key: "P3", status: "proposal", title: "specified", scope: specified, cwd: "/tmp/repo" })]);
    const clean = autopilotCommand("status", undefined, { stateDir: dir, sessionId: "s1" });
    expect(clean.message).not.toContain("under-specified");
  });

  test("the status tag is ADVISORY — it never says blocked/refused (approval stays a human call)", () => {
    writeStore(dir, [item({ key: "P1", status: "proposal", title: "thin", scope: "Fix the parser", cwd: "/tmp/repo" })]);
    const r = autopilotCommand("status", undefined, { stateDir: dir, sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("advisory");
    expect(r.message.toLowerCase()).not.toContain("blocked");
  });
});
