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
// Keymap (footer-printed): ↑/↓ select · t/tab toggle view · enter/a approve ·
// r reject · d defer · e refine (input) · x re-dispatch (input) · esc/q close
// -------------------------------------------------------------------------

import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyPanelDecision, buildPanelDoc, type PanelActionId, type PanelItem, type PanelKind } from "../framework/panels.ts";
import { loadStoreOrNew, queueLengths } from "../queue-store.ts";

type Theme = ExtensionContext["ui"]["theme"];

export interface DecisionPanelOptions {
  stateDir: string;
  initial?: PanelKind;
  theme: Theme;
  tui: { requestRender(): void };
  /** Called to close the overlay (the ctx.ui.custom done callback). */
  done: () => void;
}

const VIEWS: Array<{ kind: PanelKind; label: string }> = [
  { kind: "proposals", label: "Proposals" },
  { kind: "human-review", label: "Human review" },
];

const PANEL_KEY: Record<PanelActionId, string> = { approve: "a", reject: "r", defer: "d", refine: "e", redispatch: "x" };
const PANEL_LABEL: Record<PanelActionId, string> = { approve: "approve", reject: "reject", defer: "defer", refine: "refine", redispatch: "re-dispatch" };

const WINDOW = 7; // visible item window — the overlay scrolls via selection

export class DecisionPanel implements Component, Focusable {
  /** Focusable — the TUI sets this; propagate to the Input in input mode (IME). */
  focused = false;

  private kind: PanelKind;
  private items: PanelItem[] = [];
  private sel = 0;
  private counts = { proposals: 0, "human-review": 0 };
  private lastResult: { text: string; isError: boolean } | null = null;
  /** null = nav mode; "refine" | "redispatch" = text-input mode. */
  private inputFor: "refine" | "redispatch" | null = null;
  private input = new Input({ placeholder: "type here" });
  private cached?: { width: number; lines: string[] };

  constructor(private opts: DecisionPanelOptions) {
    this.kind = opts.initial ?? "proposals";
    this.input.onSubmit = (value) => this.confirmInput(value);
    this.input.onEscape = () => {
      this.inputFor = null;
      this.opts.tui.requestRender();
    };
    this.refresh();
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

  private apply(action: PanelActionId, payload?: { scope?: string; findings?: string }): void {
    const item = this.items[this.sel];
    if (!item) return;
    const r = applyPanelDecision(this.opts.stateDir, item.key, action, payload);
    this.lastResult = { text: r.text, isError: !r.ok };
    this.refresh();
    if (this.items.length) this.sel = Math.min(this.sel, Math.max(0, this.items.length - 1));
    this.opts.tui.requestRender();
  }

  private confirmInput(value: string): void {
    const forAction = this.inputFor;
    this.inputFor = null;
    const item = this.items[this.sel];
    if (!item || !forAction) {
      this.opts.tui.requestRender();
      return;
    }
    if (forAction === "refine") this.apply("refine", { scope: value });
    else this.apply("redispatch", { findings: value });
  }

  // -- input ----------------------------------------------------------------

  handleInput(data: string): void {
    if (this.inputFor) {
      this.input.handleInput(data);
      this.opts.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.opts.done();
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
        this.inputFor = "refine";
        // prefill the FULL scope (the worker prompt), not the truncated summary
        this.input.setValue(loadStoreOrNew(this.opts.stateDir).items[item.key]?.scope ?? "");
        this.opts.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "x")) {
      const item = this.items[this.sel];
      if (item && item.actions.includes("redispatch")) {
        this.inputFor = "redispatch";
        this.input.setValue("");
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

    const lines: string[] = [];
    const th = this.opts.theme;
    const t = (s: string) => truncateToWidth(s, width);
    const wrap = (s: string, pad = 2) => wrapTextWithAnsi(s, width - pad).map((l) => t(" ".repeat(pad) + l));

    // Header + tab bar (with live pending counts per view)
    lines.push(t(`${th.fg("accent", th.bold(" Decision panel"))}${th.fg("dim", " — the human decision inbox (fed from queue state)")}`));
    const tabParts = VIEWS.map((v) => {
      const n = this.counts[v.kind];
      const label = `${v.label} ${n}`;
      return v.kind === this.kind ? th.fg("accent", th.bold(`▸ ${label}`)) : th.fg("dim", label);
    });
    lines.push(t(tabParts.join(th.fg("muted", "   "))));
    lines.push(th.fg("border", "─".repeat(Math.max(10, width - 2))));

    if (this.items.length === 0) {
      lines.push(th.fg("success", " Nothing awaiting you here — all clear ✓"));
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
        lines.push(t((selected ? th.fg("accent", th.bold(head)) : th.fg("text", head)) + risk));
        lines.push(...wrap(t(it.summary), 4));
        for (const target of it.targets.slice(0, 2)) {
          lines.push(...wrap(th.fg("dim", `   ↳ ${target.label}`), 4));
        }
        const hints = it.actions.map((a) => `[${PANEL_KEY[a]}] ${PANEL_LABEL[a]}`);
        lines.push(t(th.fg("dim", `   ${hints.join("  ")}`)));
        lines.push("");
      }
    }

    // Input mode prompt
    if (this.inputFor) {
      const label = this.inputFor === "refine" ? " Refine scope:" : " Re-dispatch findings:";
      lines.push(t(th.fg("accent", th.bold(label))));
      const inputLines = this.input.render(width);
      lines.push(...inputLines.map((l) => " " + l));
    }

    // Last decision result
    if (this.lastResult) {
      const color = this.lastResult.isError ? "error" : "success";
      lines.push(t(th.fg(color, ` ${this.lastResult.text}`)));
    }

    // Footer
    const footer =
      this.inputFor !== null
        ? "enter submit · esc cancel input"
        : `↑↓ select · t/tab view · a approve · r reject · d defer · e refine · x re-dispatch · esc close`;
    lines.push(th.fg("dim", t(` ${footer}`)));
    lines.push(th.fg("border", "─".repeat(Math.max(10, width - 2))));

    for (const line of lines) {
      if (visibleWidth(line) > width) {
        throw new Error(`panel render overflow: ${visibleWidth(line)} > ${width}`);
      }
    }
    this.cached = { width, lines };
    return lines;
  }
}

/** Register the /orchestrate-panel command (tabbed proposals/human-review
 *  overlay). Fail-closed: if the TUI surface is unavailable the command
 *  notifies instead of throwing. */
export function registerDecisionPanel(
  pi: ExtensionAPI,
  deps: { stateDir: () => string },
): void {
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand("orchestrate-panel", {
    description: "Decision panel: proposals + human-review views (tab toggles; a approve · r reject · d defer · e refine · x re-dispatch)",
    handler: async (args, ctx) => {
      const initial: PanelKind = (args ?? "").trim() === "review" ? "human-review" : "proposals";
      try {
        await ctx.ui.custom<undefined>(
          (tui, theme, _keybindings, done) =>
            new DecisionPanel({ stateDir: deps.stateDir(), initial, theme, tui, done }),
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: "92%", minWidth: 60, maxHeight: "85%", margin: 1 },
          },
        );
      } catch {
        ctx.ui.notify("Decision panel unavailable in this context — queue_list still shows the same state", "info");
      }
    },
  });
}