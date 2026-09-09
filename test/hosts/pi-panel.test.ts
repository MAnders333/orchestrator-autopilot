// DecisionPanel (pi overlay component) — hermetic logic tests. The pi TUI
// runtime is not available in the suite, so we drive the component directly
// with a fake theme/tui and assert: width-safe rendering, keyboard selection,
// view toggle, and that decisions land in the queue store (same store the
// queue_* tools read — the panel can never drift from it).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { newStore, saveStore, type QueueItem } from "../../src/queue-store.ts";
import { DecisionPanel, refreshPanelBadge } from "../../src/hosts/pi-panel.ts";

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

  test("proposals render the destined-series hint (real keys stable; provisional Q-<n> rename called out)", () => {
    const { panel } = setup([
      item({ key: "B-42", status: "proposal", scope: "parse the thing", cwd: "/tmp/repo-b" }),
      item({ key: "Q-3", status: "proposal", scope: "repo-less idea", provisionalKey: true }),
    ]);
    const text = panel.render(80).join("\n");
    expect(text).toContain("B-42");
    expect(text.toLowerCase()).toContain("does not rename"); // approval keeps real-series keys
    expect(text).toContain("Q-3");
    expect(text.toLowerCase()).toContain("provisional"); // the repo-less handle is called out
    expect(Math.max(...lineWidths(panel.render(60)))).toBeLessThanOrEqual(60); // hint wraps, no overflow
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

  test("repo-less provisional proposal: refine collects the repo → key stays Q-<n>; approval renames it (seriesHint live)", () => {
    const { panel, read } = setup([
      item({ key: "B1", status: "proposal", scope: "history item", cwd: "/repo/b", updatedAt: "2026-09-01T09:00:00.000Z" }),
      item({ key: "Q1", status: "proposal", provisionalKey: true, scope: "the task" }),
    ]);
    panel.handleInput("j"); // select Q1 (oldest-first feed: B1, Q1)
    panel.handleInput("e"); // refine — scope stage prefilled with the full scope
    panel.handleInput("\r"); // scope unchanged → repo-less item now asks for its REPO
    for (const ch of "/repo/b") panel.handleInput(ch);
    // LIVE destined-series preview while the path is typed (registry/history/slug)
    expect(panel.render(80).join("\n")).toContain("series B");
    panel.handleInput("\r"); // submit the repo
    let after = read()["Q1"];
    expect(after.cwd).toBe("/repo/b");
    expect(after.status).toBe("proposal");
    expect(after.provisionalKey).toBe(true); // KEY STAYS Q-<n> — identity until approval
    // seriesHint on the row reflects the now-resolvable destined series
    expect(panel.render(80).join("\n")).toContain("renames Q1 into series B");
    // approval completes the flow INSIDE the panel: Q-1 renames into the real series
    panel.handleInput("a");
    after = read();
    expect(after["Q1"]).toBeUndefined();
    expect(after["B-2"].status).toBe("approved");
    expect(after["B-2"].provisionalKey).toBeUndefined();
    expect(after["B-2"].notes).toContain("renamed from Q1");
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
describe("DecisionPanel item expansion + the visible refine text field", () => {
  test("m expands the selected item to its FULL untruncated detail (scope/notes/evidence/meta)", () => {
    const longScope = "Rewrite the entire parser to a streaming tokenizer\nsecond scope line\n" + "z".repeat(200) + "\ntail line past the first head";
    const { panel } = setup([
      item({
        key: "P1",
        status: "proposal",
        title: "rewrite parser",
        scope: longScope,
        notes: "first note line\nsecond note line",
        cwd: "/tmp/repo",
        evidence: "ran the parser on the corpus",
        value: "H",
        urgency: "M",
        risk: "high",
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
      }),
    ]);
    // the LIST view truncates to the scope head — the tail is invisible
    const list = panel.render(80).join("\n");
    expect(list).toContain("Rewrite the entire parser");
    expect(list).not.toContain("second scope line");
    expect(list).not.toContain("tail line past the first head");

    panel.handleInput("m");
    const detail = panel.render(80).join("\n");
    expect(detail).toContain("second scope line");
    expect(detail).toContain("tail line past the first head"); // past the 120-char head cap
    expect(detail).toContain("first note line");
    expect(detail).toContain("second note line");
    expect(detail).toContain("ran the parser on the corpus"); // evidence
    expect(detail).toContain("value: H");
    expect(detail).toContain("urgency: M");
    expect(detail).toContain("risk: high");
    expect(detail).toContain("created: 2026-09-01T08:00:00.000Z");
    expect(detail).toContain("updated: 2026-09-01T09:00:00.000Z");
    expect(detail).toContain("↳ /tmp/repo");
    // the expanded view still renders width-safely (wrapping, never truncating)
    expect(Math.max(...lineWidths(panel.render(80)))).toBeLessThanOrEqual(80);

    // m collapses back to the list
    panel.handleInput("m");
    expect(panel.render(80).join("\n")).not.toContain("second scope line");
  });

  test("detail shows EVERY navigation target — no 2-target list cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-pi-panel-"));
    const store = newStore();
    store.items["H1"] = item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" });
    saveStore(dir, store);
    writeFileSync(
      join(dir, "handoffs.jsonl"),
      ["a", "b", "c"]
        .map((b, i) => JSON.stringify({ runId: "r1", key: "H1", branch: `pi-parallel-r1-${b}`, tipSha: `${i + 1}`.repeat(8), ts: `2026-09-01T10:00:0${i}.000Z` }))
        .join("\n") + "\n",
    );
    let closed = false;
    const panel = new DecisionPanel({ stateDir: dir, initial: "human-review", theme: theme as never, tui: { requestRender: () => {} }, done: () => { closed = true; } });
    // list view caps at the first two targets
    const list = panel.render(80).join("\n");
    expect(list).toContain("pi-parallel-r1-a");
    expect(list).not.toContain("pi-parallel-r1-b");
    // expanded view shows branch b AND c (all three + cwd)
    panel.handleInput("m");
    const detail = panel.render(80).join("\n");
    expect(detail).toContain("pi-parallel-r1-a");
    expect(detail).toContain("pi-parallel-r1-b");
    expect(detail).toContain("pi-parallel-r1-c");
    expect(detail).toContain("main...33333333"); // every branch@sha diff command (wrapped, never truncated)
    expect(closed).toBe(false);
    panel.handleInput("q");
    expect(closed).toBe(true);
  });

  test("refine opens a visible editable text field PREFILLED with the full scope; enter submits into the store", () => {
    const multiScope = "rewrite the parser\nsecond scope line";
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: multiScope, cwd: "/tmp" })]);
    panel.handleInput("e");
    const field = panel.render(80).join("\n");
    expect(field).toContain("Refine scope — P1:"); // prompt label
    expect(field).toContain("rewrite the parser"); // the FULL scope visible in the box
    expect(field).toContain("second scope line"); // multi-line, not the truncated summary
    expect(field).toContain("enter submit · shift+enter newline · esc cancel input");

    panel.handleInput("!"); // edit live
    panel.handleInput("\r"); // enter submits (non-conflicting: shift+enter makes newlines)
    expect(read()["P1"].scope).toBe("rewrite the parser\nsecond scope line!");
  });

  test("esc cancels the refine field without touching the store", () => {
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: "keep me", cwd: "/tmp" })]);
    panel.handleInput("e");
    panel.handleInput("g"); // typed text — discarded on cancel
    panel.handleInput("\x1b"); // esc cancels
    expect(read()["P1"].scope).toBe("keep me");
    expect(panel.render(80).join("\n")).not.toContain("Refine scope — P1:"); // back to nav mode
  });
});

describe("refreshPanelBadge — the push nudge", () => {
  test("shows pending counts when either view has items; clears when empty", () => {
    const { dir } = (() => {
      const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { newStore, saveStore } = require("../../src/queue-store.ts") as typeof import("../../src/queue-store.ts");
      const d = mkdtempSync(join(tmpdir(), "orch-badge-"));
      const st = newStore();
      st.items["P1"] = item({ key: "P1", status: "proposal", scope: "x", cwd: "/tmp" });
      st.items["H1"] = item({ key: "H1", status: "human-review", scope: "x", cwd: "/tmp" });
      saveStore(d, st);
      return { dir: d, read: () => JSON.parse(readFileSync(join(d, "queue.json"), "utf8")).items };
    })();
    const widget: Record<string, unknown> = {};
    const ui = { setWidget: (k: string, v: unknown) => { widget[k] = v; }, theme } as never;
    refreshPanelBadge(ui, dir);
    expect(widget["orch-panel-badge"]).toBeTruthy();
    expect(String(widget["orch-panel-badge"])).toContain("proposals 1");
    expect(String(widget["orch-panel-badge"])).toContain("human review 1");
    // empty the queue → badge cleared
    const { newStore, saveStore } = require("../../src/queue-store.ts") as typeof import("../../src/queue-store.ts");
    const st = newStore();
    saveStore(dir, st);
    refreshPanelBadge(ui, dir);
    expect(widget["orch-panel-badge"]).toBeUndefined();
  });
});
