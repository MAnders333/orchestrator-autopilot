// -------------------------------------------------------------------------
// Decision panel — pi TUI overlay (the human decision inbox).
//
// One command, TWO views (tab toggles): the proposals feed and the
// human-review feed, both built by the shared buildPanelDoc from queue
// state. Decisions are applied by the shared applyPanelDecision (validated
// store mutations — same transitions the queue_* tools enforce) and the
// overlay re-renders from the store, so the panel can never drift from the
// queue. The panel is pure UI over the shared core; if pi-tui is unavailable
// the command fails closed and the regular tick JSON remains the fallback.
//
// Keymap (footer-printed): ↑/↓/jk select · gg top · G bottom · m expand (full item) · t/tab toggle view ·
// enter/a approve · r reject · d defer · e refine (scope + repo input) · x re-dispatch (text field)
// · esc/q close. The action keys work in the expanded detail view too — the detail collapses
// and the action (or its editor) runs against the expanded item. The refine/re-dispatch field
// is a real multi-line editor: ENTER inserts a NEWLINE and ctrl+s is the single explicit
// submit, so a terminal without the Kitty protocol (where shift+enter collapses to \r) can
// never submit by accident; esc cancels. The refine scope field is prefilled with the current
// scope with select-all semantics — the first keystroke REPLACES the prefill, so a submitted
// refinement replaces the scope instead of appending to it. Repo-less proposals get a second
// "repo (cwd)" stage during refine — the repo the work lands in.
//
// The expanded detail view (m) is a SCROLLABLE pane: j/k scroll by WRAPPED
// line, ctrl+d/ctrl+u by half a page, gg/G jump to top/bottom — clamped to
// the wrapped content height so overflowing detail can never get stuck
// unreachable. esc/m collapse back to the list; a/r/d/e/x act on the item.
// -------------------------------------------------------------------------

import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  decodeKittyPrintable,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyPanelDecision, buildPanelDoc, type PanelActionId, type PanelItem, type PanelKind } from "../framework/panels.ts";
import { loadStoreOrNew, queueLengths, resolveSeries } from "../queue-store.ts";
import { formatDurationMs } from "../duration.ts";

type Theme = ExtensionContext["ui"]["theme"];

export interface DecisionPanelOptions {
  stateDir: string;
  initial?: PanelKind;
  theme: Theme;
  tui: { requestRender(): void };
  /** Called to close the overlay (the ctx.ui.custom done callback). */
  done: () => void;
  /** Called after every decision — hosts refresh their pending badge here. */
  onChanged?: () => void;
  /** The decision-tick sink (pi: the same custom-role sendMessage channel the
   *  runner's ticks use). Called once per APPLIED status move, BEFORE the
   *  panel refreshes/closes — the orchestrator learns the move at
   *  application time. */
  deliver?: (message: string) => void;
}

/** The pending-count badge (setWidget above the editor). Fed from queue
 *  state — shows when either view has items awaiting the user. */
export function refreshPanelBadge(
  ui: { setWidget(key: string, value: unknown): void; theme: Theme },
  stateDir: string,
): void {
  const counts = queueLengths(loadStoreOrNew(stateDir));
  const p = counts.proposal;
  const h = counts["human-review"];
  if (p + h === 0) {
    ui.setWidget("orch-panel-badge", undefined);
    return;
  }
  const th = ui.theme;
  ui.setWidget("orch-panel-badge", [th.fg("accent", "∎") + ` decision panel: proposals ${p} · human review ${h} — /orchestrate-panel`]);
}

const VIEWS: Array<{ kind: PanelKind; label: string }> = [
  { kind: "proposals", label: "Proposals" },
  { kind: "human-review", label: "Human review" },
];

const PANEL_KEY: Record<PanelActionId, string> = { approve: "a", reject: "r", defer: "d", refine: "e", redispatch: "x" };
const PANEL_LABEL: Record<PanelActionId, string> = { approve: "approve", reject: "reject", defer: "defer", refine: "refine", redispatch: "re-dispatch" };

const WINDOW = 7; // visible item window — the overlay scrolls via selection
/** Visible WRAPPED lines in the expanded detail pane. j/k scroll by line,
 *  ctrl+d/ctrl+u by half this, gg/G jump to the edges. Sized so the whole
 *  panel (frame + header + detail + hints + footer) stays inside the overlay
 *  without ever clipping the footer hint. */
const DETAIL_HEIGHT = 26;

export class DecisionPanel implements Component, Focusable {
  /** Focusable — the TUI sets this; propagate to the Input in input mode (IME). */
  focused = false;

  private kind: PanelKind;
  private items: PanelItem[] = [];
  private sel = 0;
  private counts = { proposals: 0, "human-review": 0 };
  private lastResult: { text: string; isError: boolean } | null = null;
  /** null = nav mode; "refine" (scope) → "refine-repo" (repo-less proposals
   *  then ask for their repo) | "redispatch" = text-input stages. A real,
   *  focused multi-line editor with a visible caret renders in input mode. */
  private inputFor: "refine" | "refine-repo" | "redispatch" | null = null;
  private editor: Editor;
  /** null = nav/list mode; an index into `items` = that item's full-detail view. */
  private detailFor: number | null = null;
  /** The detail pane's scroll offset — WRAPPED visible lines to skip. Clamped
   *  to the wrapped content height (render keeps it current; the input
   *  handlers scroll against `detailTotal`, so the pane can never overshoot). */
  private detailScroll = 0;
  /** Wrapped line count of the current detail content, refreshed at render
   *  (input handlers need it to clamp j/k and gg/G between renders). */
  private detailTotal = 0;
  /** A bare `g` was pressed — awaiting the second `g` to make `gg`. */
  private ggArmed = false;
  /** The scope typed in the refine stage — submitted together with the repo
   *  field when the item is repo-less. */
  private pendingScope: string | null = null;
  /** The refine scope field opens prefilled with the current scope; the prefill
   *  is armed as a "selection" — typing REPLACES it, so a submitted refinement
   *  replaces the scope instead of appending to it (select-all semantics; the
   *  pi-tui Editor exposes no selection API). A navigation/deletion key first
   *  collapses the "selection" and keeps the prefill editable. */
  private prefillArmed = false;
  private cached?: { width: number; lines: string[] };

  constructor(private opts: DecisionPanelOptions) {
    this.kind = opts.initial ?? "proposals";
    // The editor is the shared pi-tui Editor (multi-line, undo, paste, visible
    // caret). It connects to the overlay via a minimal TUI shim — render only
    // needs the terminal row count, and input is driven by the panel's own
    // handleInput (same IME/paste path as before).
    this.editor = new Editor(this.editorTui(), this.editorTheme(), {});
    // The editor's OWN submit path (enter/return) is neutralized: enter is a
    // NEWLINE in these fields and ctrl+s is the single explicit submit. onSubmit
    // stays wired as a last-resort fallback, but disableSubmit means no enter
    // encoding (incl. shift+enter-as-\r) can ever trigger it.
    this.editor.disableSubmit = true;
    this.editor.onSubmit = (value) => this.confirmInput(value);
    this.refresh();
  }

  /** The pi-tui Editor needs a TUI only for rows (render sizing) + re-render
   *  requests; both are delegated to the panel's overlay shim. */
  private editorTui(): TUI {
    return { requestRender: () => this.opts.tui.requestRender(), terminal: { rows: 30 } } as TUI;
  }

  /** Editor theme from the host theme (border + selection colors). The
   *  select-list half is only used by autocomplete, which the panel never
   *  enables — a plausible theme keeps the editor self-contained. */
  private editorTheme(): EditorTheme {
    const t = this.opts.theme;
    return {
      borderColor: (s: string) => t.fg("border", s),
      selectList: {
        selectedPrefix: (s: string) => t.fg("accent", s),
        selectedText: (s: string) => t.fg("text", s),
        description: (s: string) => t.fg("dim", s),
        scrollInfo: (s: string) => t.fg("dim", s),
        noMatch: (s: string) => t.fg("error", s),
      },
    };
  }

  // -- state ----------------------------------------------------------------

  private refresh(): void {
    const store = loadStoreOrNew(this.opts.stateDir);
    const counts = queueLengths(store);
    this.counts = { proposals: counts.proposal, "human-review": counts["human-review"] };
    this.items = buildPanelDoc(this.opts.stateDir, this.kind).sections[0].items;
    if (this.sel >= this.items.length) this.sel = Math.max(0, this.items.length - 1);
    this.cached = undefined;
  }

  private apply(action: PanelActionId, payload?: { scope?: string; cwd?: string; findings?: string }): void {
    const item = this.items[this.sel];
    if (!item) return;
    const r = applyPanelDecision(this.opts.stateDir, item.key, action, payload);
    // DECISION TICK first: every applied status move rides the custom-role
    // channel (same as ticks) BEFORE the panel refreshes/closes — the
    // orchestrator learns the move at application time, fresh by
    // construction (non-moves — refine/redispatch findings — carry no tick).
    if (r.ok && r.tick) this.opts.deliver?.(r.tick);
    this.lastResult = { text: r.text, isError: !r.ok };
    this.refresh();
    if (this.items.length) this.sel = Math.min(this.sel, Math.max(0, this.items.length - 1));
    this.opts.onChanged?.();
    this.opts.tui.requestRender();
  }

  /** Open a text-input stage. `prefill` is placed in the editor with the caret
   *  at its end; `armPrefill` marks it as a selection — the next text insertion
   *  replaces it (refine opens with armPrefill so a typed scope REPLACES the old
   *  one). */
  private openInput(stage: "refine" | "refine-repo" | "redispatch", prefill = "", armPrefill = false): void {
    this.inputFor = stage;
    this.editor.setText(prefill);
    this.prefillArmed = armPrefill;
    this.cached = undefined;
    this.opts.tui.requestRender();
  }

  /** True for input that INSERTS text — a printable character, a bracketed
   *  paste, or a newline. In the armed refine field those REPLACE the prefilled
   *  scope (select-all semantics); navigation and deletion keys KEEP the prefill
   *  so the old scope stays editable after a caret move. */
  private replacesPrefill(data: string): boolean {
    if (matchesKey(data, Key.enter) || matchesKey(data, "shift+enter")) return true;
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      return code >= 32 && code !== 127; // printable single char (incl. space)
    }
    return data.startsWith("\x1b[200~") || decodeKittyPrintable(data) !== undefined; // paste / Kitty-encoded char
  }

  private confirmInput(value: string): void {
    const forAction = this.inputFor;
    this.inputFor = null;
    this.prefillArmed = false;
    const item = this.items[this.sel];
    if (!item || !forAction) {
      this.opts.tui.requestRender();
      return;
    }
    if (forAction === "redispatch") {
      this.apply("redispatch", { findings: value });
      return;
    }
    if (forAction === "refine") {
      // Scope stage done. An item that already has a repo is refined here;
      // a REPO-LESS proposal moves on to the repo field (the approval gate
      // needs a cwd, and this is where the panel can supply it).
      this.pendingScope = value;
      if (loadStoreOrNew(this.opts.stateDir).items[item.key]?.cwd) {
        this.pendingScope = null;
        this.apply("refine", { scope: value });
        return;
      }
      this.openInput("refine-repo");
      return;
    }
    // refine-repo stage: a non-empty repo sets the item's cwd (the KEY stays
    // provisional — approval renames it); empty keeps the item repo-less and
    // applies the scope-only refine.
    const repo = value.trim();
    const scope = this.pendingScope;
    this.pendingScope = null;
    this.apply("refine", repo ? { scope: scope ?? undefined, cwd: repo } : { scope: scope ?? undefined });
  }

  /** Scroll the expanded detail pane by `delta` WRAPPED visible lines, clamped
   *  to the pane content height known from the last render (the TUI re-renders
   *  after every key, so `detailTotal` is always current — and render re-clamps
   *  if the wrap count changed with the width, so the pane never overshoots). */
  private scrollDetail(delta: number): void {
    this.detailScroll = Math.max(0, Math.min(this.detailScroll + delta, Math.max(0, this.detailTotal - DETAIL_HEIGHT)));
    this.cached = undefined;
    this.opts.tui.requestRender();
  }

  // -- input ----------------------------------------------------------------

  handleInput(data: string): void {
    if (this.inputFor) {
      // Text-input mode. esc cancels; ctrl+s is the ONE explicit submit (matched
      // in legacy, Kitty CSI-u and modifyOtherKeys encodings); ENTER inserts a
      // newline — including shift+enter on terminals without the Kitty protocol,
      // where shift+enter collapses to \r. The editor's own submit path is
      // disabled, so no enter/return encoding can submit.
      if (matchesKey(data, Key.escape)) {
        this.inputFor = null;
        this.pendingScope = null;
        this.prefillArmed = false;
        this.opts.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.ctrl("s"))) {
        this.confirmInput(this.editor.getExpandedText());
        return;
      }
      // Select-all emulation: an input that inserts text REPLACES the prefilled
      // refine scope before it is applied — typing a new scope never
      // concatenates onto the old one (navigation/deletion keep the prefill).
      if (this.prefillArmed) {
        this.prefillArmed = false;
        if (this.replacesPrefill(data)) this.editor.setText("");
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, "shift+enter")) {
        this.editor.handleInput("\n"); // enter = newline, never submit
      } else {
        this.editor.handleInput(data);
      }
      // typing must NOT hit the width-cache — the input line + the live
      // destined-series preview re-render from the current value
      this.cached = undefined;
      this.opts.tui.requestRender();
      return;
    }

    if (this.detailFor !== null) {
      // Detail mode: m/esc collapse back to the list; q still closes the
      // panel. Vim scrolling: j/k (and arrows) by wrapped line, ctrl+d/ctrl+u
      // by half a page, gg/G to top/bottom — always clamped to the wrapped
      // content height.
      if (matchesKey(data, Key.escape) || matchesKey(data, "m")) {
        this.detailFor = null;
        this.detailScroll = 0;
        this.detailTotal = 0;
        this.ggArmed = false;
        this.cached = undefined;
        this.opts.tui.requestRender();
        return;
      }
      if (matchesKey(data, "q")) {
        this.opts.done();
        return;
      }
      if (matchesKey(data, "g")) {
        if (this.ggArmed) {
          this.ggArmed = false;
          this.detailScroll = 0; // gg — top of the detail pane
          this.cached = undefined;
          this.opts.tui.requestRender();
        } else {
          this.ggArmed = true;
        }
        return;
      }
      this.ggArmed = false; // any other key discards a pending `g`
      if (matchesKey(data, "shift+g")) {
        this.detailScroll = Math.max(0, this.detailTotal - DETAIL_HEIGHT); // G — bottom
        this.cached = undefined;
        this.opts.tui.requestRender();
        return;
      }
      if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
        this.scrollDetail(1);
        return;
      }
      if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
        this.scrollDetail(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.scrollDetail(Math.ceil(DETAIL_HEIGHT / 2));
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.scrollDetail(-Math.ceil(DETAIL_HEIGHT / 2));
        return;
      }
      // Action keys work HERE too: collapse the detail view and fall through to
      // the list handlers, so the action (and any editor it opens) is exactly
      // the list-mode one against the expanded item — the item hints drawn
      // beside the detail pane are never inert. Keys the item does not support
      // (and every other key) stay put, so the detail can never be collapsed by
      // a no-op.
      const detailAction = (Object.keys(PANEL_KEY) as PanelActionId[]).find((a) => matchesKey(data, PANEL_KEY[a]));
      if (detailAction && this.items[this.detailFor]?.actions.includes(detailAction)) {
        this.detailFor = null;
        this.detailScroll = 0;
        this.detailTotal = 0;
        this.ggArmed = false;
        this.cached = undefined;
        // fall through to the list-mode handlers below
      } else {
        return;
      }
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.opts.done();
      return;
    }
    // `g` arms the two-key `gg` chord (top); any other key discards it. The
    // single `g` itself performs no action, so arming stays side-effect free
    // (and `G` — a DIFFERENT key from `g` — jumps to the bottom directly).
    if (matchesKey(data, "g")) {
      if (this.ggArmed) {
        this.ggArmed = false;
        this.sel = 0; // gg — first item
        this.cached = undefined;
        this.opts.tui.requestRender();
      } else {
        this.ggArmed = true;
      }
      return;
    }
    this.ggArmed = false;
    if (matchesKey(data, "shift+g")) {
      if (this.items.length) this.sel = this.items.length - 1; // G — last item
      this.cached = undefined;
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (this.sel > 0) {
        this.sel--;
        this.cached = undefined;
        this.opts.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.sel < this.items.length - 1) {
        this.sel++;
        this.cached = undefined;
        this.opts.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, "t")) {
      this.kind = this.kind === "proposals" ? "human-review" : "proposals";
      this.sel = 0;
      this.refresh();
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, "a")) {
      this.apply("approve");
      return;
    }
    if (matchesKey(data, "r")) {
      this.apply("reject");
      return;
    }
    if (matchesKey(data, "d")) {
      this.apply("defer");
      return;
    }
    if (matchesKey(data, "e")) {
      const item = this.items[this.sel];
      if (item && item.actions.includes("refine")) {
        this.pendingScope = null;
        // prefill the FULL scope (the worker prompt), not the truncated summary;
        // armed so the first keystroke REPLACES it (refine = replace, not append)
        this.openInput("refine", item.fullScope, true);
      }
      return;
    }
    if (matchesKey(data, "x")) {
      const item = this.items[this.sel];
      if (item && item.actions.includes("redispatch")) this.openInput("redispatch");
      return;
    }
    if (matchesKey(data, "m")) {
      // one key expands the selected item to its ENTIRE readable content,
      // scrolled to the top of the pane
      if (this.items.length) {
        this.detailFor = this.sel;
        this.detailScroll = 0;
        this.detailTotal = 0;
        this.ggArmed = false;
        this.cached = undefined;
        this.opts.tui.requestRender();
      }
    }
  }

  // -- rendering ------------------------------------------------------------

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number): string[] {
    if (this.cached && this.cached.width === width) return this.cached.lines;

    const inner = Math.max(10, width - 2); // the box frame takes 2 columns
    const lines: string[] = [];
    const th = this.opts.theme;
    const t = (s: string) => truncateToWidth(s, inner);
    const wrap = (s: string, pad = 2) => wrapTextWithAnsi(s, inner - pad).map((l) => t(" ".repeat(pad) + l));
    const border = (s: string) => th.fg("border", s);

    // Header + tab bar (with live pending counts per view)
    lines.push(t(`${th.fg("accent", th.bold(" Decision panel"))}${th.fg("dim", " — the human decision inbox (fed from queue state)")}`));
    const tabParts = VIEWS.map((v) => {
      const n = this.counts[v.kind];
      const label = `${v.label} ${n}`;
      return v.kind === this.kind ? th.fg("accent", th.bold(`▸ ${label}`)) : th.fg("dim", label);
    });
    lines.push(t(tabParts.join(th.fg("muted", "   "))));
    lines.push("");

    if (this.items.length === 0) {
      // fuller empty state — fills the window and shows BOTH views' counts
      lines.push(...wrap(th.fg("success", "  ✓ Nothing awaiting you here — this view is all clear")));
      lines.push("");
      const other = VIEWS.filter((v) => v.kind !== this.kind)[0];
      lines.push(t(th.fg("dim", `  ${other.label}: ${this.counts[other.kind]} — tab to check`)));
      lines.push("");
      lines.push(...wrap(th.fg("dim", "  Decisions here apply straight to the queue (queue_update semantics);")));
      lines.push(...wrap(th.fg("dim", "  queue_list shows the same state at any time. New proposals land here")));
      lines.push(...wrap(th.fg("dim", "  after an intake sweep; reviewed work lands here after the AI review.")));
    } else if (this.detailFor !== null) {
      // EXPANDED detail view — the item's ENTIRE content, wrapped never
      // truncated: full scope, notes, evidence/value/urgency/risk, timestamps
      // and EVERY target (no 2-target cap). Wrapping is the only width
      // handling; nothing here is sliced to a summary. The wrapped lines
      // play through a scrollable viewport (DETAIL_HEIGHT visible lines):
      // j/k by line, ctrl+d/ctrl+u by half a page, gg/G to top/bottom — the
      // offset is clamped to the WRAPPED line count, so wrapping never hides
      // content and the pane can never scroll past its end.
      const it = this.items[this.detailFor] ?? this.items[this.sel];
      const risk = it.risk === "high" ? th.fg("warning", " [high]") : it.risk === "medium" ? th.fg("muted", " [medium]") : "";
      const wrapAll = (s: string, pad = 2) => wrapTextWithAnsi(s, inner - pad).map((l) => " ".repeat(pad) + l);
      const content: string[] = [];
      const section = (name: string) => content.push(t(th.fg("accent", th.bold(` ${name}`))));
      content.push(...wrapAll(`${th.fg("accent", th.bold(`▸ ${it.key} — ${it.title}`))}${risk}`));
      content.push("");

      section("Scope");
      content.push(...wrapAll(it.fullScope || "(empty)"));
      content.push("");

      if (it.fullNotes) {
        section("Notes");
        content.push(...wrapAll(it.fullNotes));
        content.push("");
      }

      section("Meta");
      const metaLine = (k: string, v: string) => content.push(...wrapAll(`  ${k}: ${v}`));
      metaLine("created", it.meta.createdAt);
      metaLine("updated", it.updatedAt);
      metaLine("evidence", it.meta.evidence || "—");
      metaLine("value", it.meta.value || "—");
      metaLine("urgency", it.meta.urgency || "—");
      metaLine("risk", it.meta.risk || "—");
      metaLine("blocker", it.meta.blocker || "—");
      metaLine("cwd", it.cwd ?? "—");
      if (it.meta.runId) metaLine("run", it.meta.runId);
      if (it.meta.reviewerRunId) metaLine("reviewer run", it.meta.reviewerRunId);
      content.push("");

      section("Targets");
      if (it.fullTargets.length) {
        for (const target of it.fullTargets) content.push(...wrapAll(`↳ ${target.label}`));
      } else {
        content.push(t("  (none)"));
      }
      content.push("");

      // Scrollable window over the WRAPPED content lines — re-clamped here
      // (content re-wraps when the width changes), and the pane size is what
      // the input handlers scroll against (detailTotal, kept current).
      const total = content.length;
      this.detailTotal = total;
      this.detailScroll = Math.min(this.detailScroll, Math.max(0, total - DETAIL_HEIGHT));
      lines.push(...content.slice(this.detailScroll, this.detailScroll + DETAIL_HEIGHT));

      const hints = it.actions.map((a) => `[${PANEL_KEY[a]}] ${PANEL_LABEL[a]}`);
      lines.push(t(th.fg("dim", ` ${hints.join("  ")}`)));
    } else {
      // scroll window around the selection
      const start = Math.max(0, Math.min(this.sel - 3, this.items.length - WINDOW));
      const visible = this.items.slice(start, start + WINDOW);
      const selInWindow = this.sel - start;
      for (let i = 0; i < visible.length; i++) {
        const it = visible[i];
        const selected = i === selInWindow;
        const head = `${selected ? "▸ " : "  "}${it.key}`;
        const risk = it.risk === "high" ? th.fg("warning", ` [${it.risk}]`) : it.risk === "medium" ? th.fg("muted", ` [${it.risk}]`) : "";
        // Provisional-linger surface (AUTOPILOT-3): an old Q-<n> provisional
        // handle looks like a real key — tag it so it is never mistaken for one.
        const stale = it.staleProvisionalDays ? th.fg("warning", ` ⚠ provisional ${it.staleProvisionalDays}d`) : "";
        lines.push(t((selected ? th.fg("accent", th.bold(head)) : th.fg("text", head)) + risk + stale));
        lines.push(...wrap(t(it.summary), 4));
        for (const target of it.targets.slice(0, 2)) {
          lines.push(...wrap(th.fg("dim", `   ↳ ${target.label}`), 4));
        }
        // Destined-series hint (proposals view): provisional Q-<n> handles are
        // renamed at approval — shown here so the rename is never a surprise,
        // and the human sees the repo's resolved series once the cwd is set
        if (it.seriesHint) {
          lines.push(...wrap(th.fg("muted", `   ↳ ${it.seriesHint}`), 4));
        }
        // Budget-governance row: the cap the item runs under (and, when a
        // previous run was CUT OFF at it, the explicit budget-capped marker) —
        // re-dispatch with a larger budget is the obvious next step.
        if (it.timeoutMs) {
          lines.push(t(it.budgetCapped
            ? th.fg("error", `   budget ${formatDurationMs(it.timeoutMs)} — budget-capped: re-dispatch with a LARGER budget`)
            : th.fg("dim", `   budget ${formatDurationMs(it.timeoutMs)}`)));
        }
        const hints = it.actions.map((a) => `[${PANEL_KEY[a]}] ${PANEL_LABEL[a]}`);
        lines.push("");
      }
    }

    // Input mode — the visible multi-line TEXT FIELD: a prompt label above a
    // real focused editor with a visible caret (prefilled with the full scope
    // for refine; empty for findings).
    if (this.inputFor) {
      const currentKey = this.items[this.sel]?.key ?? "";
      const label =
        this.inputFor === "refine"
          ? ` Refine scope — ${currentKey}:`
          : this.inputFor === "refine-repo"
            ? ` Repo (cwd) — ${currentKey} (the repo this work lands in):`
            : ` Re-dispatch findings — ${currentKey}:`;
      lines.push(t(th.fg("accent", th.bold(label))));
      if (this.inputFor === "refine") {
        lines.push(...wrap(th.fg("dim", "prefilled with the current scope — typing replaces it; ctrl+s submits"), 2));
      }
      this.editor.focused = this.focused;
      const inputLines = this.editor.render(inner - 2);
      lines.push(...inputLines.map((l) => "  " + l));
      // LIVE destined-series preview: as the repo path is typed, the series
      // this key would rename into is resolved (registry → history → slug).
      if (this.inputFor === "refine-repo") {
        const repoText = this.editor.getText().trim();
        const hint = repoText
          ? `→ approval renames ${currentKey} into series ${resolveSeries(this.opts.stateDir, repoText)}`
          : `(empty keeps ${currentKey} repo-less — approval needs a repo)`;
        lines.push(...wrap(th.fg("dim", `  ${hint}`), 2));
      }
    }

    // Last decision result
    if (this.lastResult) {
      const color = this.lastResult.isError ? "error" : "success";
      lines.push(t(th.fg(color, ` ${this.lastResult.text}`)));
    }

    // Footer
    // Detail mode keeps the vim scroll keys + live position (wrapped lines) on
    // screen at ALL times — the keymap is discoverable with ONE glance, and a
    // scrolled pane always says where it is (first–last/total wrapped lines).
    const detailPos =
      this.detailFor !== null && this.detailTotal > DETAIL_HEIGHT
        ? ` — ${this.detailScroll + 1}–${Math.min(this.detailScroll + DETAIL_HEIGHT, this.detailTotal)}/${this.detailTotal}`
        : "";
    const footer =
      this.inputFor !== null
        ? "enter newline · ctrl+s submit · esc cancel"
        : this.detailFor !== null
          ? `j/k scroll · ctrl+d/u · gg/G · esc collapse${detailPos}`
          : `↑↓/jk select · gg top · G bottom · m expand · t/tab view · a approve · r reject · d defer · e refine · x re-dispatch · esc close`;
    lines.push(...wrap(th.fg("dim", ` ${footer}`), 1));

    // Frame: a FULL boundary box — all four sides, not just top/bottom
    const boxed: string[] = [border(`╭${"─".repeat(inner)}╮`)];
    for (const l of lines) {
      const pad = Math.max(0, inner - visibleWidth(l));
      boxed.push(border("│") + l + " ".repeat(pad) + border("│"));
    }
    boxed.push(border(`╰${"─".repeat(inner)}╯`));
    for (const line of boxed) {
      if (visibleWidth(line) > width) {
        throw new Error(`panel render overflow: ${visibleWidth(line)} > ${width}`);
      }
    }
    this.cached = { width, lines: boxed };
    return boxed;
  }
}

/** Register the /orchestrate-panel command (tabbed proposals/human-review
 *  overlay). Fail-closed: if the TUI surface is unavailable the command
 *  notifies instead of throwing. */
export function registerDecisionPanel(
  pi: ExtensionAPI,
  deps: {
    stateDir: () => string;
    /** The decision-tick deliver sink (pi: the runner's custom-role sendMessage
     *  channel — the same channel capacity ticks use). Optional: without it
     *  the panel still applies + refreshes the badge, only the tick is skipped. */
    deliver?: (message: string) => void;
  },
): void {
  if (typeof pi.registerCommand !== "function") return;
  // Hold the most recent command ctx for badge refreshes (panel decisions +
  // the periodic sweep). The badge is the PUSH nudge: pending counts above
  // the editor when either view has items awaiting the user.
  let ui: { setWidget(k: string, v: unknown): void; theme: Theme } | null = null;
  const refresh = () => {
    if (ui) refreshPanelBadge(ui, deps.stateDir());
  };
  pi.registerCommand("orchestrate-panel", {
    description: "Decision panel: proposals + human-review views (tab toggles; a approve · r reject · d defer · e refine scope+repo · x re-dispatch)",
    handler: async (args, ctx) => {
      ui = ctx.ui as typeof ui;
      const initial: PanelKind = (args ?? "").trim() === "review" ? "human-review" : "proposals";
      refresh();
      try {
        await ctx.ui.custom<undefined>(
          (tui, theme, _keybindings, done) =>
            new DecisionPanel({
              stateDir: deps.stateDir(),
              initial,
              theme,
              tui,
              done: () => {
                refresh();
                done();
              },
              onChanged: refresh,
              deliver: deps.deliver,
            }),
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: "96%", minWidth: 64, maxHeight: "92%", margin: 1 },
          },
        );
      } catch {
        ctx.ui.notify("Decision panel unavailable in this context — queue_list still shows the same state", "info");
      }
    },
  });
  // Periodic badge refresh — the badge stays truthful between actions.
  const timer = setInterval(refresh, 60_000);
  timer.unref?.();
}
