// -------------------------------------------------------------------------
// opencode TUI plugin — the decision panel for the opencode host.
//
// A `@opencode-ai/plugin/tui` module (client-side): registers a full-screen
// route (tabbed proposals / human-review views) + a keymap layer bound
// while the route is open. The panel is a view over queue state built by the
// SHARED buildPanelDoc; decisions go through the SHARED applyPanelDecision
// (validated store mutations — the same store the opencode server plugin's
// queue_* tools read). State-dir resolution reuses the framework's
// resolveStateDir against the opencode config's command/orchestrate.md, so
// the TUI panel reads the SAME queue as the server host.
//
// DECISION TICKS: the client-side TUI cannot push a custom-role message
// directly (no server channel from the TUI process). Panel actions therefore
// toast + ride the shared orch:human-decision event; when the server-plugin
// tick channel is wired to the panel (separate server-plugin task), the same
// applyPanelDecision decision tick will ride it.
//
// Distribution: `exports["./tui"]` (target-only module — the server entry
// stays at `exports["."]`). Enable via tui.json: "plugin": ["orchestrator-autopilot"].
// -------------------------------------------------------------------------

import { jsx } from "@opentui/solid/jsx-runtime";
import type { JSX } from "@opentui/solid";
import { onCleanup, createSignal } from "solid-js";
import { join } from "node:path";
import { resolveStateDir } from "../config.ts";
import { applyPanelDecision, buildPanelDoc, type PanelActionId, type PanelItem, type PanelKind } from "../framework/panels.ts";
import { loadStoreOrNew, queueLengths } from "../queue-store.ts";
import { formatDurationMs } from "../duration.ts";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";

// The plugin API surface we touch — kept local so the host can evolve it.
interface TuiApi {
  route: {
    register(routes: Array<{ name: string; render: (input: { params?: Record<string, unknown> }) => JSX.Element }>): void;
    navigate(name: string, params?: { params?: Record<string, unknown> }): void;
  };
  keymap: {
    registerLayer(layer: {
      mode?: string;
      commands: Array<{ name: string; title?: string; category?: string; namespace?: string; slashName?: string; run?: () => void }>;
      bindings: Array<{ key: string; cmd: string; desc?: string }>;
    }): unknown;
  };
  mode?: { push(mode: string): () => void };
  state: { path?: { config?: string } };
  slots?: { register(p: { slots: Record<string, (...args: unknown[]) => unknown> }): string };
  ui: {
    toast(input: { variant?: "info" | "success" | "warning" | "error"; title?: string; message: string }): void;
    dialog?: {
      replace(render: () => JSX.Element, onClose?: () => void): void;
    };
    DialogPrompt?: (props: {
      title: string;
      placeholder?: string;
      value?: string;
      onConfirm?: (value: string) => void;
      onCancel?: () => void;
    }) => JSX.Element;
  };
}

export interface PanelController {
  stateDir: string;
  kind: PanelKind;
  sel: number;
  lastResult: { text: string; isError: boolean } | null;
  notify: () => void;
  items(): PanelItem[];
  otherLabel(): string;
  act(action: PanelActionId, payload?: { scope?: string; cwd?: string; findings?: string }): { ok: boolean; text: string } | null;
  toggleView(): void;
  move(delta: number): void;
}

/** The pure controller — one per plugin instance; testable without a TUI. */
export function createPanelController(stateDir: string): PanelController {
  return {
    stateDir,
    kind: "proposals",
    sel: 0,
    lastResult: null,
    notify: () => {},
    items() {
      const sec = buildPanelDoc(this.stateDir, this.kind).sections[0];
      return sec?.items ?? [];
    },
    otherLabel() {
      return this.kind === "proposals" ? "Human review" : "Proposals";
    },
    act(action, payload) {
      const items = this.items();
      const item = items[this.sel];
      if (!item) return null;
      const r = applyPanelDecision(this.stateDir, item.key, action, payload);
      this.lastResult = { text: r.text, isError: !r.ok };
      const next = this.items();
      this.sel = Math.min(this.sel, Math.max(0, next.length - 1));
      this.notify();
      return r;
    },
    toggleView() {
      this.kind = this.kind === "proposals" ? "human-review" : "proposals";
      this.sel = 0;
      this.notify();
    },
    move(delta) {
      const items = this.items();
      const next = Math.max(0, Math.min(this.sel + delta, items.length - 1));
      if (next !== this.sel) {
        this.sel = next;
        this.notify();
      }
    },
  };
}

const WINDOW = 7;

function pendingCounts(stateDir: string): { p: number; h: number } {
  const counts = queueLengths(loadStoreOrNew(stateDir));
  return { p: counts.proposal, h: counts["human-review"] };
}

/** The persistent app_bottom badge (the push nudge): shows pending counts
 *  while either view has items; self-refreshes via a poll. Same feed as the
 *  panel — never duplicative, just visible. */
function BadgeComponent(props: { stateDir: string }): JSX.Element {
  const [c, setC] = createSignal(pendingCounts(props.stateDir));
  const timer = setInterval(() => setC(pendingCounts(props.stateDir)), 30_000);
  onCleanup(() => clearInterval(timer));
  const { p, h } = c();
  if (p + h === 0) return null;
  return jsx("text", { children: `decision panel — proposals ${p} · human review ${h} (open: /panel)` });
}

/** The route body — a Solid component: reads the controller (a signal bump
 *  re-renders after every action/navigation), pushes the panel keymap mode. */
function PanelComponent(props: { api: TuiApi; ctl: PanelController }): JSX.Element {
  const api = props.api;
  const ctl = props.ctl;
  const [, setTick] = createSignal(0);
  ctl.notify = () => setTick((t) => t + 1);
  if (api.mode) {
    const pop = api.mode.push("orch-panel");
    onCleanup(pop);
  }
  onCleanup(() => {
    ctl.notify = () => {};
  });
  return renderPanelContent(api, ctl);
}

function renderPanelContent(api: TuiApi, ctl: PanelController): JSX.Element {
  const items = ctl.items();
  const counts = queueLengths(loadStoreOrNew(ctl.stateDir));
  const count = ctl.kind === "proposals" ? counts.proposal : counts["human-review"];
  const otherCount = ctl.kind === "proposals" ? counts["human-review"] : counts.proposal;
  const start = Math.max(0, Math.min(ctl.sel - 3, Math.max(0, items.length - WINDOW)));
  const visible = items.slice(start, start + WINDOW);
  const label = ctl.kind === "proposals" ? "Proposals" : "Human review";

  const lines: string[] = [];
  lines.push(`Decision panel — ${label} (${count} pending)   [tab: ${ctl.otherLabel()} ${otherCount}]`);
  lines.push("");
  if (items.length === 0) {
    lines.push(`✓ Nothing awaiting you here (${ctl.kind}).`);
    lines.push(`  ${ctl.otherLabel()}: ${otherCount} — tab to check`);
    lines.push("  Decisions apply straight to the queue (queue_update semantics).");
  } else {
    for (const [i, it] of visible.entries()) {
      const selected = start + i === ctl.sel;
      const risk = it.risk === "high" ? " [high]" : it.risk === "medium" ? " [medium]" : "";
      lines.push(`${selected ? "▸" : " "} ${it.key}${risk}${it.staleProvisionalDays ? ` ⚠ provisional ${it.staleProvisionalDays}d` : ""}`);
      lines.push(`    ${it.summary}`);
      if (it.targets[0]) lines.push(`    ↳ ${it.targets[0].label}`);
      // Destined-series hint (proposals view): provisional Q-<n> handles are
      // renamed at approval — shown here so the rename is never a surprise.
      if (it.seriesHint) lines.push(`    ↳ ${it.seriesHint}`);
      if (it.timeoutMs) {
        lines.push(it.budgetCapped
          ? `    budget ${formatDurationMs(it.timeoutMs)} — budget-capped: re-dispatch with a LARGER budget`
          : `    budget ${formatDurationMs(it.timeoutMs)}`);
      }
      const hints = it.actions
        .map((a) => (a === "approve" ? "[a] approve" : a === "reject" ? "[r] reject" : a === "defer" ? "[d] defer" : a === "refine" ? "[e] refine" : "[x] re-dispatch"))
        .join("  ");
      lines.push(`    ${hints}`);
      lines.push("");
    }
  }
  if (ctl.lastResult) lines.push(`${ctl.lastResult.isError ? "!!" : "✓"} ${ctl.lastResult.text}`);
  lines.push("↑↓/jk: select · tab: view · enter/a: approve · r: reject · d: defer · e: refine scope+repo · x: re-dispatch · esc: close");

  return jsx("text", { children: lines.join("\n") });
}

function openPanel(api: TuiApi, ctl: PanelController, kind?: PanelKind): void {
  api.route.navigate("orchestrator-panel", kind ? { params: { kind } } : { params: {} });
}

function promptFor(api: TuiApi, ctl: PanelController, which: "refine" | "redispatch"): void {
  if (!api.ui.dialog?.replace || typeof api.ui.DialogPrompt !== "function") {
    // degrade: no dialog surface — toast the hint instead
    api.ui.toast({ variant: "info", message: `${which}: use queue_update in the chat to refine/re-dispatch` });
    return;
  }
  const items = ctl.items();
  const item = items[ctl.sel];
  if (!item) return;
  const refine = which === "refine";
  const key = item.key;
  if (!refine) {
    api.ui.dialog.replace(
      () =>
        jsx(api.ui.DialogPrompt!, {
          title: `Re-dispatch with findings — ${key}`,
          onConfirm: (value: string) => {
            const r = ctl.act("redispatch", { findings: value });
            if (r) api.ui.toast({ variant: r.ok ? "success" : "error", message: r.text });
          },
        }),
    );
    return;
  }
  // Refine = scope, then — for a REPO-LESS proposal — the repo (cwd). The
  // approval gate needs a cwd, and the provisional Q-<n> key renames into the
  // repo's real series at approval, so the repo field closes the repo-less
  // gap without leaving the panel. DialogPrompt covers both (two prompts).
  const repoPrompt = (scope: string) => {
    api.ui.dialog.replace(
      () =>
        jsx(api.ui.DialogPrompt!, {
          title: `Repo (cwd) — ${key}`,
          placeholder: "repo path — empty keeps it repo-less (approval needs a repo)",
          onConfirm: (value: string) => {
            const cwd = value.trim();
            const r = cwd ? ctl.act("refine", { scope, cwd }) : ctl.act("refine", { scope });
            if (r) api.ui.toast({ variant: r.ok ? "success" : "error", message: r.text });
          },
        }),
    );
  };
  // PARITY NOTE (pi refine UX, 2026-09-09): the pi overlay's refine field is
  // prefilled with the current scope using SELECT-ALL semantics — the first
  // keystroke replaces it — so a submitted refinement REPLACES the scope
  // (applyPanelDecision replaces; it never appends). This host has no
  // multi-line editor: DialogPrompt is a one-shot modal whose confirmed value
  // IS the new scope, and a modal submit is explicit by nature (no
  // shift+enter-as-\r ambiguity). If a future DialogPrompt appends to `value`
  // on typing, it must adopt the same replace-on-first-edit behavior.
  const fullScope = refine ? (loadStoreOrNew(ctl.stateDir).items[key]?.scope ?? "") : "";
  api.ui.dialog.replace(
    () =>
      jsx(api.ui.DialogPrompt!, {
        title: `Refine scope — ${key}`,
        value: fullScope,
        onConfirm: (value: string) => {
          const stillRepoLess = !loadStoreOrNew(ctl.stateDir).items[key]?.cwd;
          if (!stillRepoLess) {
            const r = ctl.act("refine", { scope: value });
            if (r) api.ui.toast({ variant: r.ok ? "success" : "error", message: r.text });
            return;
          }
          repoPrompt(value);
        },
      }),
  );
}

/** The state dir for the opencode TUI panel: env override → the opencode
 *  config dir's command/orchestrate.md STATE_DIR line → profile fallback.
 *  The SAME resolution the server plugin uses, so both hosts read one queue. */
export function tuiStateDir(configDir: string | undefined): string {
  return resolveStateDir(configDir ? join(configDir, "command", "orchestrate.md") : undefined);
}

export const tui: TuiPlugin = async (api, _options, _meta) => {
  const configDir = (api.state as { path?: { config?: string } })?.path?.config;
  const stateDir = tuiStateDir(configDir);
  const ctl = createPanelController(stateDir);

  // THE PUSH NUDGE: a persistent app_bottom badge with live pending counts.
  api.slots?.register({ slots: { app_bottom: (() => jsx(BadgeComponent, { stateDir })) as never } });

  api.route.register([
    {
      name: "orchestrator-panel",
      render: ({ params }) => {
        const k = params?.kind;
        if (k === "proposals" || k === "human-review") ctl.kind = k;
        return jsx(PanelComponent, { api, ctl });
      },
    },
  ]);

  // Opener layer — UNMODE'd so /panel + the palette command work from the
  // base UI (a mode-gated layer only activates while the panel route is open).
  api.keymap.registerLayer({
    commands: [
      { name: "orch.panel", title: "Open decision panel", category: "Orchestrator", namespace: "palette", slashName: "panel", run: () => openPanel(api, ctl) },
    ],
    bindings: [],
  });

  // Panel-action layer — active only while the route is open (mode pushed by
  // PanelComponent), so the a/r/d/e/x keys never leak into the prompt.
  api.keymap.registerLayer({
    mode: "orch-panel",
    commands: [
      { name: "orch.close", title: "Close decision panel", category: "Orchestrator", run: () => api.route.navigate("home") },
      { name: "orch.toggle", title: "Toggle view (proposals / human review)", category: "Orchestrator", run: () => ctl.toggleView() },
      { name: "orch.selUp", title: "Select previous", category: "Orchestrator", run: () => ctl.move(-1) },
      { name: "orch.selDown", title: "Select next", category: "Orchestrator", run: () => ctl.move(1) },
      { name: "orch.approve", title: "Approve", category: "Orchestrator", run: () => { const r = ctl.act("approve"); if (r) api.ui.toast({ variant: r.ok ? "success" : "error", message: r.text }); } },
      { name: "orch.reject", title: "Reject", category: "Orchestrator", run: () => { const r = ctl.act("reject"); if (r) api.ui.toast({ variant: r.ok ? "success" : "error", message: r.text }); } },
      { name: "orch.defer", title: "Defer", category: "Orchestrator", run: () => { const r = ctl.act("defer"); if (r) api.ui.toast({ variant: r.ok ? "success" : "error", message: r.text }); } },
      { name: "orch.refine", title: "Refine scope", category: "Orchestrator", run: () => promptFor(api, ctl, "refine") },
      { name: "orch.redispatch", title: "Re-dispatch with findings", category: "Orchestrator", run: () => promptFor(api, ctl, "redispatch") },
    ],
    bindings: [
      { key: "escape", cmd: "orch.close", desc: "Close panel" },
      { key: "tab", cmd: "orch.toggle", desc: "Toggle view" },
      { key: "t", cmd: "orch.toggle" },
      { key: "up", cmd: "orch.selUp", desc: "Select previous" },
      { key: "k", cmd: "orch.selUp" },
      { key: "down", cmd: "orch.selDown", desc: "Select next" },
      { key: "j", cmd: "orch.selDown" },
      { key: "enter", cmd: "orch.approve", desc: "Approve" },
      { key: "a", cmd: "orch.approve" },
      { key: "r", cmd: "orch.reject", desc: "Reject" },
      { key: "d", cmd: "orch.defer", desc: "Defer" },
      { key: "e", cmd: "orch.refine", desc: "Refine scope" },
      { key: "x", cmd: "orch.redispatch", desc: "Re-dispatch with findings" },
    ],
  });};

export default { id: "orchestrator-autopilot", tui };