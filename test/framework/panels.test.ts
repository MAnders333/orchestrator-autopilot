// Decision panels — shared core (buildPanelDoc + applyPanelDecision) hermetic
// tests. No host involved: the doc is a pure projection of queue state, and
// decisions are validated store mutations.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newStore, saveStore, type QueueItem } from "../../src/queue-store.ts";
import { applyPanelDecision, buildPanelDoc, decisionTick, PANEL_ACTIONS, actionsForStatus } from "../../src/framework/panels.ts";

let n = 0;
function item(p: Partial<QueueItem> & { key: string; status: QueueItem["status"] }): QueueItem {
  n += 1;
  return {
    blocker: null,
    title: p.key,
    scope: "",
    cwd: null,
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    notes: "",
    createdAt: `2026-09-01T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    updatedAt: `2026-09-01T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    ...p,
  };
}

function dirWith(seed: QueueItem[]): { dir: string; read: () => { items: Record<string, QueueItem> } } {
  const dir = mkdtempSync(join(tmpdir(), "orch-panel-"));
  const store = newStore();
  for (const i of seed) store.items[i.key] = i; // direct write: addItem stamps updatedAt=now, breaks the ordering test
  saveStore(dir, store);
  return { dir, read: () => JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) };
}

describe("buildPanelDoc — the feed from queue state", () => {
  test("proposals view shows ONLY proposal items, oldest first, with the right actions", () => {
    const { dir } = dirWith([
      item({ key: "P1", status: "proposal", title: "fix parser", scope: "Rewrite the parser\nsecond line", cwd: "/tmp/repo", evidence: "fixed 12 files", value: "H", urgency: "M", risk: "high", notes: "context note", createdAt: "2026-09-01T07:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z" }),
      item({ key: "P2", status: "proposal", title: "add docs", scope: "Write the docs", cwd: "/tmp/repo", updatedAt: "2026-09-01T08:00:00.000Z" }),
      item({ key: "A1", status: "approved", title: "approved one" }),
      item({ key: "H1", status: "human-review", title: "in human review" }),
    ]);
    const doc = buildPanelDoc(dir, "proposals");
    expect(doc.kind).toBe("proposals");
    const keys = doc.sections[0].items.map((i) => i.key);
    expect(keys).toEqual(["P2", "P1"]); // oldest first
    expect(keys).not.toContain("A1");
    expect(keys).not.toContain("H1");
    const p1 = doc.sections[0].items.find((i) => i.key === "P1")!;
    expect(p1.summary).toBe("Rewrite the parser"); // scope head — the LIST projection
    expect(p1.actions).toEqual(["approve", "reject", "defer", "refine"]);
    expect(p1.targets[0].label).toBe("/tmp/repo");
    // additive detail projection: FULL untruncated fields + meta (truncation is a RENDER choice)
    expect(p1.fullScope).toBe("Rewrite the parser\nsecond line");
    expect(p1.fullNotes).toBe("context note");
    expect(p1.fullTargets.map((t) => t.label)).toEqual(["/tmp/repo"]);
    expect(p1.meta).toMatchObject({
      createdAt: "2026-09-01T07:00:00.000Z",
      updatedAt: "2026-09-01T09:00:00.000Z",
      evidence: "fixed 12 files",
      value: "H",
      urgency: "M",
      risk: "high",
      blocker: null,
      runId: null,
      reviewerRunId: null,
    });
  });

  test("proposals view carries the destined-series hint — real keys stay put, provisional Q-<n> is called out", () => {
    const { dir } = dirWith([
      // repo-backed proposal: key allocated from cwd at queue_add → real series B
      item({ key: "B-42", status: "proposal", scope: "task", cwd: "/tmp/repo-b", updatedAt: "2026-09-01T09:00:00.000Z" }),
      // genuinely repo-less proposal: provisional handle, rename at approval
      item({ key: "Q-3", status: "proposal", scope: "brainstorm", cwd: null, provisionalKey: true, updatedAt: "2026-09-01T09:05:00.000Z" }),
      item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo-h" }),
    ]);
    const doc = buildPanelDoc(dir, "proposals");
    const byKey = Object.fromEntries(doc.sections[0].items.map((i) => [i.key, i]));
    // real-series key: hint confirms approval keeps it (no rename surprise)
    expect(byKey["B-42"].seriesHint).toContain("does NOT rename");
    expect(byKey["B-42"].seriesHint).toContain("series B"); // destined series resolved from the repo (registry → history → slug)
    // provisional handle: the rename at approval is announced up front
    expect(byKey["Q-3"].seriesHint?.toLowerCase()).toContain("provisional");
    expect(byKey["Q-3"].seriesHint?.toLowerCase()).toContain("renamed");
    expect(byKey["Q-3"].seriesHint).toContain("registry → history → slug");
    // the human-review view carries no series hint (keys there are final)
    const hr = buildPanelDoc(dir, "human-review");
    expect(hr.sections[0].items[0].seriesHint).toBeUndefined();
  });

  test("proposals view TAGS stale PROVISIONAL Q proposals (provisional-linger, AUTOPILOT-3)", () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const { dir } = dirWith([
      item({ key: "Q-3", status: "proposal", provisionalKey: true, title: "cwd-less brainstorm", createdAt: ago(12) }),
      item({ key: "P1", status: "proposal", title: "normal proposal", createdAt: ago(12) }), // no provisional marker
      item({ key: "Q-4", status: "proposal", provisionalKey: true, title: "fresh provisional", createdAt: ago(1) }),
    ]);
    const doc = buildPanelDoc(dir, "proposals");
    const q3 = doc.sections[0].items.find((i) => i.key === "Q-3")!;
    const p1 = doc.sections[0].items.find((i) => i.key === "P1")!;
    const q4 = doc.sections[0].items.find((i) => i.key === "Q-4")!;
    expect(q3.staleProvisionalDays).toBeGreaterThanOrEqual(10); // past the 3d default
    expect(q4.staleProvisionalDays).toBeUndefined(); // within the threshold
    expect(p1.staleProvisionalDays).toBeUndefined(); // key shape alone is not enough
    expect(doc.sections[0].title).toContain("stale provisional");
    // human-review feed carries none of this (proposals only)
    expect(buildPanelDoc(dir, "human-review").sections[0].title).not.toContain("stale provisional");
  });

  test("human-review view shows ONLY human-review items with navigation targets", () => {
    const { dir } = dirWith([
      item({ key: "H1", status: "human-review", title: "findings doc", scope: "Produce the findings report", cwd: "/tmp/repo", notes: "wrote docs/findings.md" }),
      item({ key: "P1", status: "proposal", title: "a proposal" }),
      item({ key: "D1", status: "done", title: "done one" }),
    ]);
    const doc = buildPanelDoc(dir, "human-review");
    expect(doc.kind).toBe("human-review");
    const keys = doc.sections[0].items.map((i) => i.key);
    expect(keys).toEqual(["H1"]);
    const h1 = doc.sections[0].items[0];
    expect(h1.actions).toEqual(["approve", "redispatch", "reject"]);
    // no journal entries → fallback targets (cwd + the reviewed-work pointer)
    expect(h1.targets.length).toBeGreaterThanOrEqual(1);
    expect(h1.targets[0].label).toBe("/tmp/repo");
    expect(h1.summary).toContain("findings.md");
    // additive projections: full notes + the same full target list
    expect(h1.fullNotes).toBe("wrote docs/findings.md");
    expect(h1.fullScope).toBe("Produce the findings report");
    expect(h1.fullTargets).toEqual(h1.targets);
  });

  test("human-review fullTargets carry EVERY journaled branch@sha (no cap at the core)", () => {
    const { dir } = dirWith([item({ key: "H1", status: "human-review", title: "work", scope: "task", cwd: "/tmp/repo" })]);
    writeFileSync(
      join(dir, "handoffs.jsonl"),
      [
        JSON.stringify({ runId: "r1", key: "H1", branch: "pi-parallel-r1-a", tipSha: "11111111", ts: "2026-09-01T10:00:00.000Z" }),
        JSON.stringify({ runId: "r1", key: "H1", branch: "pi-parallel-r1-b", tipSha: "22222222", ts: "2026-09-01T10:00:01.000Z" }),
        JSON.stringify({ runId: "r1", key: "H1", branch: "pi-parallel-r1-c", tipSha: "33333333", ts: "2026-09-01T10:00:02.000Z" }),
      ].join("\n") + "\n",
    );
    const h1 = buildPanelDoc(dir, "human-review").sections[0].items[0];
    // cwd + one target per journaled branch = 4 — nothing capped
    expect(h1.fullTargets.length).toBe(4);
    expect(h1.fullTargets.map((t) => t.label)).toEqual([
      "/tmp/repo",
      "branch pi-parallel-r1-a @ 11111111 — diff vs main: git diff main...11111111",
      "branch pi-parallel-r1-b @ 22222222 — diff vs main: git diff main...22222222",
      "branch pi-parallel-r1-c @ 33333333 — diff vs main: git diff main...33333333",
    ]);
  });

  test("actionsForStatus + PANEL_ACTIONS labels are stable (hosts render from them)", () => {
    expect(actionsForStatus("proposal")).toEqual(["approve", "reject", "defer", "refine"]);
    expect(actionsForStatus("human-review")).toEqual(["approve", "redispatch", "reject"]);
    expect(actionsForStatus("active")).toEqual([]);
    expect(PANEL_ACTIONS.refine.needsInput).toBe(true);
    expect(PANEL_ACTIONS.redispatch.needsInput).toBe(true);
  });
  test("buildPanelDoc carries a seriesHint for provisional proposals that resolves once the repo is set", () => {
    const { dir } = dirWith([
      item({ key: "B1", status: "proposal", title: "history", scope: "x", cwd: "/repo/b", updatedAt: "2026-09-01T09:00:00.000Z" }),
      item({ key: "Q1", status: "proposal", provisionalKey: true, title: "brainstormed", scope: "the task" }),
      item({ key: "P1", status: "proposal", title: "plain", scope: "no hint here" }),
    ]);
    const q1 = (d: string) => buildPanelDoc(d, "proposals").sections[0].items.find((i) => i.key === "Q1")!;
    expect(q1(dir).seriesHint).toContain("provisional"); // repo-less: the rename is coming, no series yet
    // set the repo via the panel → the hint resolves (registry/history/slug)
    applyPanelDecision(dir, "Q1", "refine", { scope: "the task", cwd: "/repo/b" });
    const after = q1(dir);
    expect(after.cwd).toBe("/repo/b");
    expect(after.seriesHint).toContain("series B"); // history vote — NOT the item's own provisional Q
    // non-provisional keys carry no hint
    const p1 = buildPanelDoc(dir, "proposals").sections[0].items.find((i) => i.key === "P1")!;
    expect(p1.seriesHint).toBeNull();
  });
});

describe("applyPanelDecision — validated store mutations", () => {
  test("approve a fully-specified proposal → approved + human-decision event", () => {
    const { dir, read } = dirWith([item({ key: "P1", status: "proposal", scope: "task", cwd: "/tmp/repo" })]);
    const r = applyPanelDecision(dir, "P1", "approve");
    expect(r.ok).toBe(true);
    expect(read().items["P1"].status).toBe("approved");
    expect(r.event?.name).toBe("orch:human-decision");
    expect(r.event?.data).toMatchObject({ key: "P1", action: "approve", from: "proposal", to: "approved" });
  });

  test("approve respects the approval gate (scope + cwd required)", () => {
    const { dir, read } = dirWith([item({ key: "P1", status: "proposal", title: "no spec" })]);
    const r = applyPanelDecision(dir, "P1", "approve");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("refine");
    expect(read().items["P1"].status).toBe("proposal"); // untouched
  });

  test("approve a human-review item → done (the human approval gate)", () => {
    const { dir, read } = dirWith([item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" })]);
    const r = applyPanelDecision(dir, "H1", "approve");
    expect(r.ok).toBe(true);
    expect(read().items["H1"].status).toBe("done");
  });

  test("reject works for both kinds; wrong status is refused", () => {
    const { dir, read } = dirWith([
      item({ key: "P1", status: "proposal" }),
      item({ key: "H1", status: "human-review" }),
      item({ key: "A1", status: "active" }),
    ]);
    expect(applyPanelDecision(dir, "P1", "reject").ok).toBe(true);
    expect(applyPanelDecision(dir, "H1", "reject").ok).toBe(true);
    expect(read().items["P1"].status).toBe("rejected");
    expect(read().items["H1"].status).toBe("rejected");
    expect(applyPanelDecision(dir, "A1", "reject").ok).toBe(false);
  });

  test("defer parks a proposal as blocked (default reason: decision; explicit honored)", () => {
    const { dir, read } = dirWith([
      item({ key: "P1", status: "proposal" }),
      item({ key: "P2", status: "proposal" }),
    ]);
    applyPanelDecision(dir, "P1", "defer");
    expect(read().items["P1"].status).toBe("blocked");
    expect(read().items["P1"].blocker).toBe("decision");
    applyPanelDecision(dir, "P2", "defer", { blocker: "parked" });
    expect(read().items["P2"].blocker).toBe("parked");
  });

  test("refine rewrites the proposal scope (the worker prompt)", () => {
    const { dir, read } = dirWith([item({ key: "P1", status: "proposal", scope: "old" })]);
    const r = applyPanelDecision(dir, "P1", "refine", { scope: "new scope\nmore" });
    expect(r.ok).toBe(true);
    expect(read().items["P1"].scope).toBe("new scope\nmore");
    // refine then makes a previously-unspecified proposal approvable
    const { dir: d2, read: r2 } = dirWith([item({ key: "P2", status: "proposal", title: "no spec" })]);
    applyPanelDecision(d2, "P2", "refine", { scope: "now specified" });
    applyPanelDecision(d2, "P2", "refine", { scope: "now specified" });
    // approve still needs cwd
    expect(applyPanelDecision(d2, "P2", "approve").ok).toBe(false);
    expect(r2().items["P2"].scope).toBe("now specified");
    expect(applyPanelDecision(dir, "P1", "refine", { scope: "  " }).ok).toBe(false); // empty rejected
  });

  test("redispatch records the human's findings + event, NO transition (harness re-dispatches, like review-FAIL)", () => {
    const { dir, read } = dirWith([item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" })]);
    const r = applyPanelDecision(dir, "H1", "redispatch", { findings: "the merge is missing on main" });
    expect(r.ok).toBe(true);
    expect(read().items["H1"].status).toBe("human-review"); // unchanged — not auto-sent to a worker
    expect(read().items["H1"].notes).toContain("the merge is missing on main");
    expect(r.event?.data.findings).toBe("the merge is missing on main");
    expect(applyPanelDecision(dir, "H1", "redispatch").ok).toBe(false); // findings required
    expect(applyPanelDecision(dir, "H1", "redispatch", { findings: "x" }).ok).toBe(true); // and usable twice
  });

  test("approve is refused for items the two views do not own (active/blocked/done)", () => {
    const { dir } = dirWith([
      item({ key: "A1", status: "active", scope: "x", cwd: "/tmp" }),
      item({ key: "B1", status: "blocked", scope: "x", cwd: "/tmp" }),
      item({ key: "D1", status: "done" }),
    ]);
    for (const k of ["A1", "B1", "D1"]) expect(applyPanelDecision(dir, k, "approve").ok).toBe(false);
  });
  test("refine accepts the repo (cwd) — scope and/or cwd are persisted, identity held until approval", () => {
    const { dir, read } = dirWith([item({ key: "Q1", status: "proposal", provisionalKey: true, scope: "the task", cwd: null })]);
    // cwd-only refine (scope already good from intake)
    expect(applyPanelDecision(dir, "Q1", "refine", { cwd: "/repo/b" }).ok).toBe(true);
    let after = read().items["Q1"];
    expect(after.cwd).toBe("/repo/b");
    expect(after.scope).toBe("the task"); // untouched
    expect(after.provisionalKey).toBe(true); // KEY STAYS Q-<n> — identity is not the repo yet
    expect(after.status).toBe("proposal");
    // scope+cwd together
    const r = applyPanelDecision(dir, "Q1", "refine", { scope: "sharper scope", cwd: "/repo/b" });
    expect(r.ok).toBe(true);
    after = read().items["Q1"];
    expect(after.scope).toBe("sharper scope");
    expect(after.cwd).toBe("/repo/b");
    // neither field → rejected
    expect(applyPanelDecision(dir, "Q1", "refine", {}).ok).toBe(false);
    expect(applyPanelDecision(dir, "Q1", "refine", { scope: "   " }).ok).toBe(false);
    // still repo-less + no scope stays unapprovable until refine supplies both
    const { dir: d2, read: r2 } = dirWith([item({ key: "Q2", status: "proposal", provisionalKey: true, title: "empty" })]);
    applyPanelDecision(d2, "Q2", "refine", { cwd: "/repo/x" });
    expect(applyPanelDecision(d2, "Q2", "approve").ok).toBe(false); // gate: scope still missing
    expect(r2().items["Q2"].status).toBe("proposal");
  });

  test("approve of a repo-set provisional proposal RENAMES it into the repo's real series (panel == queue_update path)", () => {
    const { dir, read } = dirWith([
      item({ key: "B1", status: "proposal", title: "history", scope: "h", cwd: "/repo/b", updatedAt: "2026-09-01T09:00:00.000Z" }),
      item({ key: "Q1", status: "proposal", provisionalKey: true, scope: "the task", cwd: "/repo/b" }),
    ]);
    const r = applyPanelDecision(dir, "Q1", "approve");
    expect(r.ok).toBe(true);
    const after = read().items;
    expect(after["Q1"]).toBeUndefined(); // provisional handle gone
    expect(after["B-2"]).toBeDefined(); // real series (B1 counted as 1) — the item could NOT vote its own Q
    expect(after["B-2"].status).toBe("approved");
    expect(after["B-2"].provisionalKey).toBeUndefined(); // marker cleared
    expect(after["B-2"].notes).toContain("renamed from Q1");
    // the event carries the FINAL key so consumers dispatch the live item
    expect(r.event?.data).toMatchObject({ key: "B-2", renamedFrom: "Q1", action: "approve", to: "approved" });
  });
});

describe("decision tick — the one-line move record (the orchestrator never surprised)", () => {
  test("tick text per move action (approve/reject/defer), built at application time", () => {
    const { dir } = dirWith([
      item({ key: "P1", status: "proposal", scope: "task", cwd: "/tmp/repo" }),
      item({ key: "P2", status: "proposal", scope: "task", cwd: "/tmp/repo" }),
      item({ key: "P3", status: "proposal" }),
      item({ key: "P4", status: "proposal" }),
      item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" }),
    ]);
    expect(applyPanelDecision(dir, "P1", "approve").tick).toBe("[orch-tick: decision] P1 approved: proposal → approved (dispatchable)");
    expect(applyPanelDecision(dir, "P2", "defer").tick).toBe("[orch-tick: decision] P2 deferred: proposal → blocked (decision)");
    expect(applyPanelDecision(dir, "P4", "defer", { blocker: "parked" }).tick).toBe("[orch-tick: decision] P4 deferred: proposal → blocked (parked)");
    expect(applyPanelDecision(dir, "P3", "reject").tick).toBe("[orch-tick: decision] P3 rejected: proposal → rejected");
    expect(applyPanelDecision(dir, "H1", "approve").tick).toBe("[orch-tick: decision] H1 approved: human-review → done");
    // every move tick is ONE line, by construction
    expect(decisionTick({ key: "P9", action: "approved", from: "proposal", to: "approved", note: "dispatchable" })?.split("\n").length).toBe(1);
  });

  test("non-moves (refine scope, re-dispatch findings) carry NO tick — they record words, not status flips", () => {
    const { dir } = dirWith([
      item({ key: "P1", status: "proposal", scope: "old", cwd: "/tmp/repo" }),
      item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" }),
    ]);
    expect(applyPanelDecision(dir, "P1", "refine", { scope: "new" }).tick).toBeUndefined();
    expect(applyPanelDecision(dir, "H1", "redispatch", { findings: "merge missing on main" }).tick).toBeUndefined();
    // the builder itself returns null for any non-move (from === to)
    expect(decisionTick({ key: "H1", action: "re-dispatched", from: "human-review", to: "human-review" })).toBeNull();
    expect(decisionTick({ key: "P1", action: "approved", from: "proposal", to: null })).toBeNull();
    // harness-applied moves use their own verb + note (zombie reconciliation)
    expect(decisionTick({ key: "Z1", action: "failed", from: "active", to: "failed", note: "zombie" })).toBe("[orch-tick: decision] Z1 failed: active → failed (zombie)");
  });
});