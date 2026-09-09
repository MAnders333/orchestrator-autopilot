// Decision panels — shared core (buildPanelDoc + applyPanelDecision) hermetic
// tests. No host involved: the doc is a pure projection of queue state, and
// decisions are validated store mutations.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newStore, saveStore, type QueueItem } from "../../src/queue-store.ts";
import { applyPanelDecision, buildPanelDoc, PANEL_ACTIONS, actionsForStatus } from "../../src/framework/panels.ts";

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
      item({ key: "P1", status: "proposal", title: "fix parser", scope: "Rewrite the parser\nsecond line", cwd: "/tmp/repo", updatedAt: "2026-09-01T09:00:00.000Z" }),
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
    expect(p1.summary).toBe("Rewrite the parser"); // scope head
    expect(p1.actions).toEqual(["approve", "reject", "defer", "refine"]);
    expect(p1.targets[0].label).toBe("/tmp/repo");
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
  });

  test("actionsForStatus + PANEL_ACTIONS labels are stable (hosts render from them)", () => {
    expect(actionsForStatus("proposal")).toEqual(["approve", "reject", "defer", "refine"]);
    expect(actionsForStatus("human-review")).toEqual(["approve", "redispatch", "reject"]);
    expect(actionsForStatus("active")).toEqual([]);
    expect(PANEL_ACTIONS.refine.needsInput).toBe(true);
    expect(PANEL_ACTIONS.redispatch.needsInput).toBe(true);
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
});