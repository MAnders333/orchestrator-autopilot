// queue-store.test.ts — pure store logic: CRUD, validated transitions,
// queries (status/since/sort), migration from legacy state.md.
import { describe, test, expect } from "bun:test";
import {
  newStore,
  addItem,
  updateItem,
  validTransition,
  queueLengths,
  readyItems,
  itemByRunId,
  itemByReviewerRunId,
  runIdMatches,
  queryItems,
  migrateFromMd,
  type QueueStore,
} from "../src/queue-store.ts";

const PERSONAL_MD = `# Orchestrator State
updated: 2026-08-16T11:10Z

## Active (max 3 slots)
G-ARMD-RERUN-FINISHER: continue the lane — worker run 3a84fd83, timeout 2.4h, status: failed
G-B2-REVIEW-PULLBACK: Review pull-back — worker run 6f559944, timeout 90min, status: working

## Approved (ready to dispatch when a slot frees — buffer ≥2 ready)
A9-TAGS-SURFACE-REDO: A9 tags page honest framing — ORIGINAL WORKER LOST (hit
30-min cap). Re-dispatch; hold until upstream stabilizes. (PARKED)
B3-POLICY-VERSION: /policy optimistic concurrency — SERIALIZED behind G-B2 (both touch policy.ts).
B4-AGENTIC-JUDGE-TIMEOUT [BEYOND]: give the judge a real timeout — tests/agentic-eval/compare.ts
has ZERO timeout code. Risk: low — test harness only.

## Backlog
B1: [notion-design] Notion WP-N5 — block-walk fallback.

## Reviewing
R1: [Koop] migration readiness — worker done, reviewer running.

## Completed
C1: [DACH dims] M7 mapping — reviewed, delivered.
`;

function sample(over: Partial<Parameters<typeof addItem>[1]> = {}): Parameters<typeof addItem>[1] {
  return {
    key: "B4-AGENTIC-JUDGE-TIMEOUT",
    status: "approved",
    blocker: null,
    title: "judge timeout",
    scope: "add timeout to the eval harness",
    evidence: "today's operational record",
    value: "M",
    urgency: "M",
    risk: "low",
    runId: null,
    notes: "free-form notes",
    ...over,
  };
}

describe("queue-store transitions", () => {
  test("allowed transitions", () => {
    expect(validTransition("proposal", "approved")).toBe(true);
    expect(validTransition("proposal", "rejected")).toBe(true);
    expect(validTransition("approved", "active")).toBe(true);
    expect(validTransition("active", "reviewing")).toBe(true);
    expect(validTransition("active", "failed")).toBe(true);
    expect(validTransition("reviewing", "done")).toBe(true);
    expect(validTransition("reviewing", "active")).toBe(true); // re-dispatch
    expect(validTransition("failed", "active")).toBe(true);    // recovery
    expect(validTransition("done", "active")).toBe(false);     // terminal
    expect(validTransition("approved", "done")).toBe(false);   // no skipping
  });

  test("updateItem throws on illegal transition", () => {
    const store = newStore();
    addItem(store, sample());
    expect(() => updateItem(store, "B4-AGENTIC-JUDGE-TIMEOUT", { status: "done" })).toThrow(/illegal transition/);
  });

  test("updateItem applies legal transition + notes", () => {
    const store = newStore();
    addItem(store, sample());
    updateItem(store, "B4-AGENTIC-JUDGE-TIMEOUT", { status: "active", runId: "d67a18c6" });
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].status).toBe("active");
    expect(queueLengths(store).active).toBe(1);
    updateItem(store, "B4-AGENTIC-JUDGE-TIMEOUT", { notes: "new free-form note" });
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].notes).toBe("new free-form note");
  });

  test("update WITHOUT a status field does NOT clobber the item's status", () => {
    const store = newStore();
    addItem(store, sample());
    // the LLM called queue_update with only notes — params.status is undefined
    updateItem(store, "B4-AGENTIC-JUDGE-TIMEOUT", { status: undefined, notes: "only notes" });
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].status).toBe("approved"); // preserved
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].notes).toBe("only notes");
  });

  test("corrupt item (status undefined) can be REPAIRED to a valid status", () => {
    const store = newStore();
    const it = addItem(store, sample());
    // simulate the corruption: status got clobbered to undefined
    store.items[it.key] = { ...it, status: undefined as never };
    updateItem(store, "B4-AGENTIC-JUDGE-TIMEOUT", { status: "approved" });
    expect(store.items["B4-AGENTIC-JUDGE-TIMEOUT"].status).toBe("approved");
    expect(queueLengths(store).approved).toBe(1);
    // but a legit illegal transition still throws
    expect(() => updateItem(store, "B4-AGENTIC-JUDGE-TIMEOUT", { status: "done" })).toThrow(/illegal transition/);
  });
});

describe("queue-store queries", () => {
  function store(): QueueStore {
    const s = newStore();
    addItem(s, sample({ key: "A9-TAGS-SURFACE-REDO", status: "blocked", blocker: "parked", title: "a9" }), "2026-08-16T10:00:00.000Z");
    addItem(s, sample({ key: "B4-AGENTIC-JUDGE-TIMEOUT", title: "b4", notes: "n" }), "2026-08-16T11:00:00.000Z");
    addItem(s, sample({ key: "B3-POLICY-VERSION", status: "active", runId: "6f559944", title: "b3" }), "2026-08-16T12:00:00.000Z");
    return s;
  }

  test("status filter + deterministic counts", () => {
    const s = store();
    const items = queryItems(s, { status: "approved" });
    expect(items.map((i) => i.key)).toEqual(["B4-AGENTIC-JUDGE-TIMEOUT"]); // A9 is blocked, not approved
    expect(queueLengths(s)).toEqual({ proposal: 0, approved: 1, blocked: 1, active: 1, reviewing: 0, failed: 0, done: 0, rejected: 0 });
  });

  test("since filter (last change) + updatedAt desc sort", () => {
    const s = store();
    const items = queryItems(s, { since: "2026-08-16T11:30:00.000Z" });
    expect(items.map((i) => i.key)).toEqual(["B3-POLICY-VERSION"]); // only updated after since, desc
  });

  test("compact view excludes heavy fields unless includeNotes", () => {
    const s = store();
    const compact = queryItems(s, { status: "approved", sort: "key" })[0];
    expect(compact.notes).toBeUndefined();
    expect(compact.scope).toBeUndefined();
    expect(compact.key).toBe("B4-AGENTIC-JUDGE-TIMEOUT"); // A9 is blocked now; B4 is the approved item
    const full = queryItems(s, { status: "approved", sort: "key", includeNotes: true })[0];
    expect(full.notes).toBe("n"); // B4's free-form note
    expect(full.scope).toBeTruthy();
  });

  test("itemByRunId matches by prefix", () => {
    const s = store();
    expect(itemByRunId(s, "6f559944-aaaa-bbbb")?.key).toBe("B3-POLICY-VERSION");
    expect(itemByRunId(s, "deadbeef")).toBeNull();
  });
});

describe("queue-store run attribution", () => {
  test("runIdMatches: 8-char and 6-char prefix matching", () => {
    expect(runIdMatches("371d1bb9-aaaa-bbbb", "371d1bb9")).toBe(true);
    expect(runIdMatches("371d1bb9-aaaa", "371d1b")).toBe(true);
    expect(runIdMatches("deadbeef", "cafebabe")).toBe(false);
    expect(runIdMatches("ab", "abcdef")).toBe(false); // < 6 chars → no match
  });

  test("itemByRunId finds active items; itemByReviewerRunId only reviewing items", () => {
    const store = newStore();
    addItem(store, { key: "W1", status: "active", blocker: null, title: "w1", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: "371d1bb9-aaaa-bbbb", reviewerRunId: null, attempts: 0, notes: "", createdAt: "x", updatedAt: "x" });
    addItem(store, { key: "R1", status: "reviewing", blocker: null, title: "r1", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: "6f559944-cccc", attempts: 0, notes: "", createdAt: "x", updatedAt: "x" });
    expect(itemByRunId(store, "371d1bb9-dead-beef")?.key).toBe("W1");
    expect(itemByRunId(store, "6f559944-dead-beef")).toBeNull(); // reviewer run is not a worker run
    expect(itemByReviewerRunId(store, "6f559944-cccc-dddd")?.key).toBe("R1");
  });
});

describe("queue-store migration", () => {
  test("imports legacy personal-format state.md faithfully", () => {
    const store = migrateFromMd(PERSONAL_MD);
    expect(queueLengths(store)).toEqual({ proposal: 1, approved: 1, blocked: 2, active: 2, reviewing: 1, failed: 0, done: 1, rejected: 0 });
    const a9 = store.items["A9-TAGS-SURFACE-REDO"];
    expect(a9).toBeDefined();
    expect(a9.status).toBe("blocked");   // PARKED → the fold
    expect(a9.blocker).toBe("parked");
    expect(a9.notes).toContain("ORIGINAL WORKER LOST"); // full text preserved
    const b3 = store.items["B3-POLICY-VERSION"];
    expect(b3.status).toBe("blocked");   // SERIALIZED → the fold
    expect(b3.blocker).toBe("serialized");
    const b4 = store.items["B4-AGENTIC-JUDGE-TIMEOUT"];
    expect(b4.status).toBe("approved");  // [BEYOND] tag parsed, no blocker → dispatchable
    expect(store.items["G-B2-REVIEW-PULLBACK"].runId).toBe("6f559944");
    expect(store.items["G-ARMD-RERUN-FINISHER"].status).toBe("active"); // failed md status → still active entry
    expect(store.items["C1"].status).toBe("done");
    expect(store.items["R1"].status).toBe("reviewing");
    expect(store.items["B1"].status).toBe("proposal");
  });

  test("failed→done is legal (verified-complete despite a failure record)", () => {
    const store = newStore();
    addItem(store, { key: "R", status: "failed", ready: false, blocker: null, title: "r", scope: "", evidence: "", value: "", urgency: "", risk: "low", runId: "deadbeef", reviewerRunId: null, attempts: 1, notes: "", createdAt: "x", updatedAt: "x" });
    const it = updateItem(store, "R", { status: "done" });
    expect(it.status).toBe("done");
    expect(validTransition("failed", "done")).toBe(true);
    expect(validTransition("failed", "rejected")).toBe(false);
  });

  test("empty/absent md → empty store", () => {
    const store = migrateFromMd("# nothing\n");
    expect(queueLengths(store).approved).toBe(0);
  });
});
