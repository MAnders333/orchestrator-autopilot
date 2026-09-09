// DecisionPanel (pi overlay component) — hermetic logic tests. The pi TUI
// runtime is not available in the suite, so we drive the component directly
// with a fake theme/tui and assert: width-safe rendering, keyboard selection,
// view toggle, and that decisions land in the queue store (same store the
// queue_* tools read — the panel can never drift from it).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { newStore, saveStore, type QueueItem } from "../../src/queue-store.ts";
import { DecisionPanel } from "../../src/hosts/pi-panel.ts";

const theme: Record<string, any> = {
  fg: (c: string, s: string) => (typeof s === "string" ? s : String(s)),
  bg: (c: string, s: string) => (typeof s === "string" ? s : String(s)),
  bold: (s: string) => (typeof s === "string" ? s : String(s)),
};

function item(p: Partial<QueueItem> & { key: string; status: QueueItem["status"] }): QueueItem {
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
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...p,
  };
}

function setup(seed: QueueItem[]) {
  const dir = mkdtempSync(join(tmpdir(), "orch-pi-panel-"));
  const store = newStore();
  for (const i of seed) store.items[i.key] = i;
  saveStore(dir, store);
  let closed = false;
  const panel = new DecisionPanel({ stateDir: dir, initial: "proposals", theme: theme as never, tui: { requestRender: () => {} }, done: () => { closed = true; } });
  const read = () => JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")).items as Record<string, QueueItem>;
  return { dir, panel, read, get closed() { return closed; } };
}

function lineWidths(lines: string[]): number[] {
  return lines.map((l) => visibleWidth(l));
}

describe("DecisionPanel renders width-safely from queue state", () => {
  test("shows both view counts, the proposals feed, and no line overflows", () => {
    const { panel } = setup([
      item({ key: "P1", status: "proposal", scope: "Rewrite the parser\nsecond line", cwd: "/tmp/repo" }),
      item({ key: "P2", status: "proposal", scope: "Add docs" }),
      item({ key: "H1", status: "human-review", scope: "Produce findings", cwd: "/tmp/repo" }),
    ]);
    const lines = panel.render(80);
    expect(lines.join("\n")).toContain("Proposals 2");
    expect(lines.join("\n")).toContain("Human review 1");
    expect(lines.join("\n")).toContain("P1");
    expect(lines.join("\n")).toContain("Rewrite the parser");
    expect(Math.max(...lineWidths(lines))).toBeLessThanOrEqual(80);

    const narrow = panel.render(60);
    expect(Math.max(...lineWidths(narrow))).toBeLessThanOrEqual(60);
  });

  test("empty view says all clear; no crash at render", () => {
    const { panel } = setup([item({ key: "A1", status: "approved" })]);
    const lines = panel.render(80);
    expect(lines.join("\n")).toContain("all clear");
  });
});

describe("DecisionPanel keyboard flow", () => {
  test("t toggles the view; approve lands in the store as proposal → approved", () => {
    const sut = setup([
      item({ key: "P1", status: "proposal", scope: "task", cwd: "/tmp/repo" }),
      item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" }),
    ]);
    const { panel, read } = sut;
    panel.handleInput("a");
    expect(read()["P1"].status).toBe("approved");
    expect(sut.closed).toBe(false);

    // toggle to the human-review view — now shows H1; approve → done
    panel.handleInput("t");
    expect(panel.render(80).join("\n")).toContain("H1");
    panel.handleInput("a");
    expect(read()["H1"].status).toBe("done");
  });

  test("reject and defer apply validated transitions", () => {
    const { panel, read } = setup([
      item({ key: "P1", status: "proposal", scope: "x", cwd: "/tmp" }),
      item({ key: "P2", status: "proposal" }),
    ]);
    panel.handleInput("r"); // reject P1
    expect(read()["P1"].status).toBe("rejected");
    // P2 remains — the panel re-renders from the store (P1 left the view)
    const shown = panel.render(80).join("\n");
    expect(shown).toContain("P2");
    expect(shown).not.toContain("▸ P1"); // the rejected item LEFT the feed (result line mentions its key — that's fine)
    panel.handleInput("d"); // defer P2
    expect(read()["P2"].status).toBe("blocked");
  });

  test("refine input mode collects scope text and rewrites the item", () => {
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: "old", cwd: "/tmp" })]);
    panel.handleInput("e");
    panel.handleInput("t"); // typing in INPUT mode — must be consumed by the Input, not toggle
    panel.handleInput("h"); // 'h' — consumed as text, not a nav key
    panel.handleInput("i"); // 'i' — nav? no: input mode routes everything to Input
    panel.handleInput("\r"); // enter submits
    expect(read()["P1"].scope).toContain("thi");
  });

  test("redispatch records findings without transitioning; esc closes the panel", () => {
    const sut = setup([item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" })]);
    const { panel, read } = sut;
    panel.handleInput("t"); // → human-review
    panel.handleInput("x");
    panel.handleInput("m");
    panel.handleInput("e");
    panel.handleInput("r");
    panel.handleInput("g");
    panel.handleInput("e");
    panel.handleInput("e"); // text 'mergee'… wait: 'e' in input mode is text
    panel.handleInput("d");
    panel.handleInput("\r");
    expect(read()["H1"].status).toBe("human-review"); // no transition — harness re-dispatches
    expect(read()["H1"].notes).toContain("merge");
    panel.handleInput("q");
    expect(sut.closed).toBe(true);
  });
});