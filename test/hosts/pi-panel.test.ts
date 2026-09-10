// DecisionPanel (pi overlay component) — hermetic logic tests. The pi TUI
// runtime is not available in the suite, so we drive the component directly
// with a fake theme/tui and assert: width-safe rendering, keyboard selection,
// view toggle, and that decisions land in the queue store (same store the
// queue_* tools read — the panel can never drift from it).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth, matchesKey, Key } from "@earendil-works/pi-tui";
import { newStore, saveStore, type QueueItem } from "../../src/queue-store.ts";
import { DecisionPanel, refreshPanelBadge } from "../../src/hosts/pi-panel.ts";
import { SCOPE_SKELETON } from "../../src/framework/spec-completeness.ts";

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

  test("stale PROVISIONAL proposals get the ⚠ tag in the item row (provisional-linger)", () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const { panel } = setup([
      item({ key: "Q-3", status: "proposal", provisionalKey: true, title: "stale provisional", scope: "", createdAt: ago(12) }),
      item({ key: "P1", status: "proposal", title: "normal proposal", scope: "", createdAt: ago(12) }),
    ]);
    const shown = panel.render(80).join("\n");
    expect(shown).toContain("Q-3");
    expect(shown).toContain("⚠ provisional");
    expect(shown).not.toContain("P1 ⚠ provisional"); // the non-provisional item never gets THIS tag
    expect(shown.match(/⚠ provisional/g)).toHaveLength(1);
  });

  test("under-specified proposals get the ⚠ spec tag in the item row (spec-completeness, AUTOPILOT-26)", () => {
    const good = readFileSync(join(import.meta.dir, "..", "fixtures", "scope-autopilot-20.txt"), "utf8");
    const { panel } = setup([
      item({ key: "P1", status: "proposal", title: "capture note", scope: "", cwd: null }),
      item({ key: "P9", status: "proposal", title: "specified", scope: good, cwd: "/tmp/repo" }),
    ]);
    const lines = panel.render(100);
    const shown = lines.join("\n");
    expect(shown).toContain("NEEDS SPEC");
    expect(shown).not.toContain("P9 ⚠"); // a fully specified proposal is never tagged
    expect(Math.max(...lineWidths(lines))).toBeLessThanOrEqual(100); // the tag never overflows the row
  });

  test("empty view says all clear; no crash at render", () => {
    const { panel } = setup([item({ key: "A1", status: "approved" })]);
    const lines = panel.render(80);
    expect(lines.join("\n")).toContain("all clear");
  });

  test("row shows the recorded budget; a budget-capped row gets the bigger-budget marker", () => {
    const { panel } = setup([
      item({ key: "H1", status: "human-review", title: "h1", scope: "work", cwd: "/tmp/repo", timeoutMs: 43_200_000 }),
    ]);
    panel.handleInput("t"); // human-review view
    expect(panel.render(80).join("\n")).toContain("budget 12h");
    const capped = setup([
      item({ key: "H2", status: "human-review", title: "h2", scope: "work", cwd: "/tmp/repo", timeoutMs: 5_400_000, failCause: "budget-capped" }),
    ]);
    capped.panel.handleInput("t");
    const rendered = capped.panel.render(80).join("\n");
    expect(rendered).toContain("budget 1h30m");
    expect(rendered).toContain("budget-capped: re-dispatch with a LARGER budget");
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

  test("refine input mode collects scope text and rewrites the item (typing REPLACES the prefill)", () => {
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: "old", cwd: "/tmp" })]);
    panel.handleInput("e");
    panel.handleInput("t"); // typing in INPUT mode — must be consumed by the editor, not toggle
    panel.handleInput("h"); // 'h' — consumed as text, not a nav key
    panel.handleInput("i"); // 'i' — nav? no: input mode routes everything to the editor
    panel.handleInput("\x13"); // ctrl+s submits (enter is a newline now)
    expect(read()["P1"].scope).toBe("thi"); // the prefill is GONE — replace, not append
  });

  test("repo-less provisional proposal: refine collects the repo → key stays Q-<n>; approval renames it (seriesHint live)", () => {
    const { panel, read } = setup([
      item({ key: "B1", status: "proposal", scope: "history item", cwd: "/repo/b", updatedAt: "2026-09-01T09:00:00.000Z" }),
      item({ key: "Q1", status: "proposal", provisionalKey: true, scope: "the task" }),
    ]);
    panel.handleInput("j"); // select Q1 (oldest-first feed: B1, Q1)
    panel.handleInput("e"); // refine — scope stage prefilled with the full scope
    panel.handleInput("\x13"); // ctrl+s: scope unchanged → repo-less item now asks for its REPO
    for (const ch of "/repo/b") panel.handleInput(ch);
    // LIVE destined-series preview while the path is typed (registry/history/slug)
    expect(panel.render(80).join("\n")).toContain("series B");
    panel.handleInput("\x13"); // ctrl+s: submit the repo
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
    panel.handleInput("\x13"); // ctrl+s submits (enter only inserts newlines)
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

  test("refine opens a prefilled editable field; typing REPLACES the prefill; ctrl+s submits into the store", () => {
    const multiScope = "rewrite the parser\nsecond scope line";
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: multiScope, cwd: "/tmp" })]);
    panel.handleInput("e");
    const field = panel.render(80).join("\n");
    expect(field).toContain("Refine scope — P1:"); // prompt label
    expect(field).toContain("rewrite the parser"); // the FULL scope visible in the box
    expect(field).toContain("second scope line"); // multi-line, not the truncated summary
    expect(field).toContain("ctrl+s submit · esc cancel");

    for (const ch of "brand new scope") panel.handleInput(ch); // typing replaces the prefill
    panel.handleInput("\x13"); // ctrl+s is the explicit submit
    expect(read()["P1"].scope).toBe("brand new scope"); // ONLY the new text — no old prefix
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

describe("DecisionPanel vim keys — nav gg/G + scrollable detail pane", () => {
  test("nav mode: gg selects the first item, G the last (j/k keep working beside them)", () => {
    const { panel } = setup([
      item({ key: "P1", status: "proposal", scope: "one", cwd: "/tmp" }),
      item({ key: "P2", status: "proposal", scope: "two", cwd: "/tmp" }),
      item({ key: "P3", status: "proposal", scope: "three", cwd: "/tmp" }),
    ]);
    panel.handleInput("j"); // ↓ to P2
    expect(panel.render(80).join("\n")).toContain("▸ P2");
    panel.handleInput("g");
    panel.handleInput("g"); // gg — first item
    let nav = panel.render(80).join("\n");
    expect(nav).toContain("▸ P1");
    expect(nav).not.toContain("▸ P2");
    panel.handleInput("G"); // G — last item
    nav = panel.render(80).join("\n");
    expect(nav).toContain("▸ P3");
    expect(nav).not.toContain("▸ P2");
    panel.handleInput("k"); // j/k still move after gg/G
    expect(panel.render(80).join("\n")).toContain("▸ P2");
    panel.handleInput("g"); // a lone g arms gg but does NOT move…
    panel.handleInput("j"); // …and the very next key discards the armed g
    expect(panel.render(80).join("\n")).toContain("▸ P3");
    // nav footer advertises the vim keys — discoverability is printed, not assumed
    expect(panel.render(80).join("\n")).toContain("↑↓/jk select · gg top · G bottom");
  });

  test("detail mode: j/k scroll by line, ctrl+d/ctrl+u half-page, gg/G jump — all clamped to the content end", () => {
    const scope = Array.from({ length: 60 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`).join("\n");
    const { panel } = setup([item({ key: "P1", status: "proposal", scope, cwd: "/tmp" })]);
    panel.handleInput("m");
    const top = panel.render(80).join("\n");
    expect(top).toContain("▸ P1 — P1"); // detail title
    expect(top).toContain("  line 01");
    expect(top).toContain("  line 23");
    expect(top).not.toContain("  line 24"); // viewport bottom is line 23
    // the vim scroll keymap + live position are ALWAYS on screen
    expect(top).toContain("j/k scroll · ctrl+d/u · gg/G · esc collapse");
    expect(top).toContain("1–26/77");

    panel.handleInput("j"); // one wrapped line down — the TITLE scrolls away first
    const one = panel.render(80).join("\n");
    expect(one).not.toContain("▸ P1 — P1");
    expect(one).toContain("  line 24");
    expect(one).toContain("2–27/77");
    panel.handleInput("j");
    const two = panel.render(80).join("\n");
    expect(two).toContain("  line 25");
    expect(two).toContain("3–28/77");

    panel.handleInput("\x04"); // ctrl+d — half page (13) down: offset 2 → 15
    const half = panel.render(80).join("\n");
    expect(half).toContain("  line 13");
    expect(half).not.toContain("  line 12");
    expect(half).toContain("16–41/77");
    panel.handleInput("\x15"); // ctrl+u — half page up: offset 15 → 2
    const up = panel.render(80).join("\n");
    expect(up).toContain("  line 01");
    expect(up).toContain("3–28/77");

    panel.handleInput("G"); // bottom: offset 51 → first visible line 49
    const bottom = panel.render(80).join("\n");
    expect(bottom).toContain("  line 49");
    expect(bottom).not.toContain("  line 48");
    expect(bottom).toContain("↳ /tmp"); // tail of the detail is reachable
    expect(bottom).toContain("52–77/77");
    // clamped at the content end: further j presses rest on the last page
    for (let i = 0; i < 5; i++) panel.handleInput("j");
    expect(panel.render(80).join("\n")).toBe(bottom);

    panel.handleInput("g");
    panel.handleInput("g"); // gg — back to the top
    const topAgain = panel.render(80).join("\n");
    expect(topAgain).toContain("▸ P1 — P1");
    expect(topAgain).toContain("  line 01");
    expect(topAgain).toContain("1–26/77");
    panel.handleInput("k"); // up from the top clamps at 0
    expect(panel.render(80).join("\n")).toBe(topAgain);

    panel.handleInput("m"); // collapse — back to the nav keymap
    const collapsed = panel.render(80).join("\n");
    expect(collapsed).toContain("↑↓/jk select · gg top · G bottom");
    expect(collapsed).not.toContain("j/k scroll · ctrl+d/u · gg/G · esc collapse");
  });

  test("detail j/k step by WRAPPED visible lines — a long line counts once per wrap chunk", () => {
    const long = "x".repeat(200);
    const scope = [long, ...Array.from({ length: 40 }, (_, i) => `n ${String(i + 1).padStart(2, "0")}`)].join("\n");
    const { panel } = setup([item({ key: "P1", status: "proposal", scope, cwd: "/tmp" })]);
    panel.handleInput("m");
    const top = panel.render(80).join("\n");
    expect(top).toContain("  " + long.slice(0, 74)); // first wrap chunk visible at the top
    expect(top).toContain("  n 01");
    expect(top).toContain("1–26/60");

    // 3 visible steps (title, blank, scope header) bring the head line's FIRST
    // chunk to the top edge; 3 MORE steps scroll past ALL THREE wrap chunks of
    // that ONE source line — n 01 is then the first visible line and every
    // wrap chunk is off screen. Steps are WRAPPED lines, not source lines.
    for (let i = 0; i < 6; i++) panel.handleInput("j");
    const six = panel.render(80).join("\n");
    expect(six).not.toContain("x".repeat(40)); // every wrap chunk scrolled past
    expect(six).toContain("  n 01"); // …yet source line #2 is not skipped
    expect(six).toContain("  n 26");
    expect(six).not.toContain("  n 27");
    expect(six).toContain("7–32/60");

    panel.handleInput("G"); // bottom clamps to the WRAPPED end (60 lines)
    const bottom = panel.render(80).join("\n");
    expect(bottom).toContain("  n 29");
    expect(bottom).toContain("↳ /tmp");
    expect(bottom).toContain("35–60/60"); // clamped to the WRAPPED end (60 lines)
    panel.handleInput("g");
    panel.handleInput("g"); // gg — straight back to the top
    const topAgain = panel.render(80).join("\n");
    expect(topAgain).toContain("  " + long.slice(0, 74));
    expect(topAgain).toContain("1–26/60");
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

describe("DecisionPanel deliver sink — the decision tick rides the custom-role channel", () => {
  test("every applied status move delivers its one-line tick BEFORE the panel refreshes", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-pi-panel-tick-"));
    const store = newStore();
    store.items["P1"] = item({ key: "P1", status: "proposal", scope: "task", cwd: "/tmp/repo" });
    store.items["H1"] = item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" });
    saveStore(dir, store);
    const delivered: string[] = [];
    let refreshed = 0;
    const panel = new DecisionPanel({
      stateDir: dir,
      initial: "proposals",
      theme: theme as never,
      tui: { requestRender: () => {} },
      done: () => {},
      deliver: (m) => delivered.push(m),
      onChanged: () => { refreshed += 1; },
    });
    panel.handleInput("a"); // approve P1
    expect(delivered).toEqual(["[orch-tick: decision] P1 approved: proposal → approved (dispatchable)"]);
    expect(refreshed).toBe(1); // the tick lands BEFORE the panel refreshes (deliver runs first in apply)

    // non-moves (redispatch findings) deliver NOTHING — they record words, not a flip
    panel.handleInput("t"); // → human-review view (H1)
    panel.handleInput("x");
    for (const ch of "merge") panel.handleInput(ch);
    panel.handleInput("\x13");
    expect(delivered.length).toBe(1); // still only the approve tick
  });
});

describe("DecisionPanel refine UX fixes — detail actions, newline safety, replace-not-append", () => {
  test("detail mode: action keys WORK — e opens the editor (detail collapses), a approves; hints are never inert", () => {
    const sut = setup([
      item({ key: "P1", status: "proposal", scope: "old scope", cwd: "/tmp" }),
      item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" }),
    ]);
    const { panel, read } = sut;
    panel.handleInput("m"); // expand P1
    const detail = panel.render(80).join("\n");
    expect(detail).toContain("Meta"); // the detail pane is up
    expect(detail).toContain("[e] refine"); // …and it advertises the refine action

    panel.handleInput("e"); // action key from the expanded view
    const field = panel.render(80).join("\n");
    expect(field).toContain("Refine scope — P1:"); // the editor opened
    expect(field).not.toContain("Meta"); // detail collapsed first, so the editor is visible not buried
    for (const ch of "refined scope") panel.handleInput(ch);
    panel.handleInput("\x13"); // ctrl+s submits
    expect(read()["P1"].scope).toBe("refined scope"); // REPLACES — no "old scope" prefix

    // a also works from the expanded view
    panel.handleInput("m");
    expect(panel.render(80).join("\n")).toContain("Meta");
    panel.handleInput("a");
    expect(read()["P1"].status).toBe("approved");

    // x works from detail on a human-review item
    panel.handleInput("t"); // human-review view
    panel.handleInput("m"); // expand H1
    panel.handleInput("x"); // re-dispatch editor opens
    expect(panel.render(80).join("\n")).toContain("Re-dispatch findings — H1:");
    for (const ch of "fix it") panel.handleInput(ch);
    panel.handleInput("\x13");
    expect(read()["H1"].notes).toContain("fix it");
  });

  test("enter inserts a NEWLINE and never submits (shift+enter-as-\\r included); ctrl+s is the only submit", () => {
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: "old", cwd: "/tmp" })]);
    panel.handleInput("e");
    for (const ch of "new") panel.handleInput(ch); // replaces the prefill → "new"
    // legacy \r is ALSO what shift+enter collapses to on terminals without the
    // Kitty protocol — neither press may submit
    panel.handleInput("\r");
    panel.handleInput("\r");
    expect(read()["P1"].scope).toBe("old"); // nothing applied yet
    expect(panel.render(80).join("\n")).toContain("Refine scope — P1:"); // the field is still open
    for (const ch of "line") panel.handleInput(ch);
    panel.handleInput("\x13"); // the explicit submit
    expect(read()["P1"].scope).toBe("new\n\nline"); // the two \r presses became real newlines
  });

  test("ctrl+s is distinct from enter in legacy AND Kitty encodings (submit can never be confused with a newline)", () => {
    expect(matchesKey("\x13", Key.ctrl("s"))).toBe(true); // legacy control char
    expect(matchesKey("\x1b[115;5u", Key.ctrl("s"))).toBe(true); // Kitty CSI-u
    expect(matchesKey("\x1b[27;5;115~", Key.ctrl("s"))).toBe(true); // modifyOtherKeys fallback
    expect(matchesKey("\r", Key.ctrl("s"))).toBe(false); // enter never matches submit
    expect(matchesKey("\n", Key.ctrl("s"))).toBe(false);
    expect(matchesKey("\x13", Key.enter)).toBe(false);
  });

  test("refine on an EMPTY scope prefills the TEMPLATE SKELETON; typing still REPLACES it (AUTOPILOT-26)", () => {
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: "", cwd: "/tmp" })]);
    panel.handleInput("e");
    const field = panel.render(100).join("\n");
    expect(field).toContain("PROBLEM"); // the skeleton is IN the editor, not an empty buffer
    expect(field).toContain("TESTS / ACCEPTANCE");
    // select-all semantics survive the new prefill source: the first keystroke
    // wipes the skeleton instead of appending to it
    for (const ch of "PROBLEM: mine") panel.handleInput(ch);
    panel.handleInput("\x13"); // ctrl+s
    expect(read()["P1"].scope).toBe("PROBLEM: mine");
    expect(read()["P1"].scope).not.toContain("EVIDENCE"); // no skeleton residue
  });

  test("refine on a NON-empty scope still prefills the existing scope (the skeleton never overwrites real work)", () => {
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: "old scope", cwd: "/tmp" })]);
    panel.handleInput("e");
    const field = panel.render(100).join("\n");
    expect(field).toContain("old scope");
    expect(field).not.toContain("JUDGMENT CALLS");
    panel.handleInput("\x7f"); // backspace keeps the prefill editable
    panel.handleInput("\x13");
    expect(read()["P1"].scope).toBe("old scop");
    expect(SCOPE_SKELETON).toContain("PROBLEM"); // the skeleton is the OTHER branch's source
  });

  test("a navigation/deletion key collapses the select-all — the prefill stays editable", () => {
    const { panel, read } = setup([item({ key: "P1", status: "proposal", scope: "old", cwd: "/tmp" })]);
    panel.handleInput("e");
    panel.handleInput("\x7f"); // backspace EDITS the prefill (does not nuke it)
    panel.handleInput("\x13"); // ctrl+s submits
    expect(read()["P1"].scope).toBe("ol"); // the old scope survived the edit
  });

  test("detail mode: r (reject) and d (defer) also act on the expanded item", () => {
    const rejected = setup([item({ key: "P1", status: "proposal", scope: "s", cwd: "/tmp" })]);
    rejected.panel.handleInput("m");
    rejected.panel.handleInput("r");
    expect(rejected.read()["P1"].status).toBe("rejected");

    const deferred = setup([item({ key: "P2", status: "proposal", scope: "s", cwd: "/tmp" })]);
    deferred.panel.handleInput("m");
    deferred.panel.handleInput("d");
    expect(deferred.read()["P2"].status).toBe("blocked");
  });
});
