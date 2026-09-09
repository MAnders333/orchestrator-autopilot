# Decision panels (research + design)

A new feature class: **human decision panels** — a small, focused UI surface for
decisions that otherwise get swamped in the orchestrator tick stream. Two
panels are the first consumers:

1. **Proposals** — after an intake sweep: read, approve, reject, refine, defer
   (block) each candidate.
2. **Human review** — items in `human-review`: a summary of what was done,
   pointers to where to navigate for review, approve / re-dispatch-with-
   findings / reject.

Reference implementation: pi-subagents' fleet inspector — a command that pops a
small overlay in the pi TUI with live controls.

Research date: 2026-09. Evidence is per-source and cited inline (`[verified]`).

## Status

- **Done** — shared core: `src/framework/panels.ts` (`buildPanelDoc` = the feed,
  one view per status; `applyPanelDecision` = validated mutations) + hermetic
  tests (`test/framework/panels.test.ts`, 11 tests). Extracted
  `humanReviewTargetsFor` (the runner auto-flag and the panel share one target
  builder); exported `approvalReady` for approval-gate reuse.
- **Done** — pi UI: `src/hosts/pi-panel.ts` — one `/orchestrate-panel` command,
  TAB-Toggled overlay (proposals / human-review views with live pending
  counts), keyboard actions a approve · r reject · d defer · e refine
  (input) · x re-dispatch (input) · esc/q close; decisions applied through
  `applyPanelDecision` (same store the tools read — no drift). Component
  logic tested hermetic (6 tests: width safety, keyboard flow, store
  effects). `@earendil-works/pi-tui@^0.85.1` added as a runtime dep.
- **Remaining** — opencode `./tui` module, nudges (widget/badge + attention).

---

## 1. Capability research

### pi — the TUI panel surface (verified from installed docs + pi-subagents source)

pi ships a first-class extension TUI API (`ctx.ui.*`, read from the installed
`docs/tui.md`):

| Capability | API | Verdict for panels |
|---|---|---|
| Modal overlay (popup window) | `ctx.ui.custom((tui, theme, kb, done) => component, { overlay: true, overlayOptions: { anchor, width, maxHeight, margin } })` | **[verified]** exactly what the fleet inspector uses: `anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%"` |
| Keyboard list selection | `SelectList`, `SettingsList`, `Input`/`Editor` (IME-capable), custom `Component` with `handleInput` + `matchesKey` | **[verified]** |
| Mouse | `MouseRegion` (click), OSC 8 links via `Markdown` (`mdLink`) | **[verified]** links work in supported terminals |
| Persistent indicator | `ctx.ui.setWidget(key, ...)` (above/below editor), `ctx.ui.setStatus`, `ctx.ui.notify(msg, type)` | **[verified]** pi-subagents clears its status widget when the overlay opens |
| Custom tool rendering | `renderCall`/`renderResult` overrides, `registerMessageRenderer` | **[verified]** relevant for rendering panel output inline as fallback |

Works from **commands** (`pi.registerCommand`) and from **custom tools**
(`ctx.ui.custom` is available in tool `execute`) — the agent can open a panel
and block on the human's decision. Graceful degradation: when no TUI is
available (headless), the call fails closed and the caller falls back to the
existing JSON tick.

Reference: `openSubagentFleet()` in
`~/.pi/personal/npm/node_modules/pi-subagents/src/tui/fleet.ts` — the exact
overlay invocation pattern to copy. Deep-dive transcripts additionally open in
a **Herdr pane** (`inspector.open` via herdr client) — a second, optional
mechanism when the terminal in front of the user is a herdr pane, not the pi
TUI.

### opencode — server plugins have NO UI; TUI plugins now do (verified from the published package)

**Server plugins** (what orchestrator-autopilot's opencode host uses today —
`src/hosts/opencode-plugin.ts`) expose tools, hooks, and events. Their only
user-facing surface is: SDK `client` calls, system notifications via
`osascript` in hooks, and toast events. **No dialogs, no panels, no webview**
in the classic API.

But the **TUI plugin system is real and shipped**: `@opencode-ai/plugin` has a
`./tui` export since at least v1.18.30 (verified by unpacking the published
package; the installed CLI is 1.18.29, plugins version-match the CLI), with
`engines.opencode ^1.0.0`. Capabilities (verified from `dist/tui.d.ts`:

| Capability | API | Verdict for panels |
|---|---|---|
| Full-screen custom route | `api.route.register([{ name, render: () => <box><text>…</text></box> }])` + `api.route.navigate(name)` (JSX via `@opentui/solid`) | **[verified]** `<box><text>` components exist in the published type surface |
| Dialogs | `api.ui.DialogConfirm`, `DialogPrompt`, `DialogSelect` (+ `DialogAlert`, `ui.toast`, `ui.dialog` stack) | **[verified]** DialogSelect = approve/reject/refine options; DialogPrompt = refine text; DialogConfirm = destructive confirms |
| Sidebar / persistent slots | `api.slots.register({ … })` — `sidebar_content`, `app`, `app_bottom`, `home_bottom` (library-default mode), `sidebar_title/footer` (single-winner), custom slot names | **[verified]** a badge/list in `app_bottom` or a custom slot rendered from our own route |
| Command + keybinding | `api.keymap.registerLayer({ commands: [{ name, title, namespace: "palette", run }], bindings: [{ key: "ctrl+shift+m", cmd }] })` | **[verified]** mirrors pi-subagents' `Ctrl+Alt+F` open-shortcut pattern |
| User attention | `api.attention.notify({ title, message, notification, sound })` + semantic sounds incl. `subagent_done`, `question` | **[verified]** |
| State reads (concurrency-safe panel data) | `api.state.session.*`, `api.event.on(...)` | **[verified]** |
| Persistence | `api.kv` (`state/kv.json`) | **[verified]** panel "last seen" markers etc. |

Caveats (verified against the repo spec `packages/opencode/specs/tui-plugins.md`):

- **No directory auto-discovery for TUI plugins** — a file plugin must be
  listed in `tui.json` (`"plugin": ["./plugins/x.tsx"]`); npm plugins via
  `"plugin": ["orchestrator-autopilot"]` resolve the package's `exports["./tui"]`.
- The `api.command` legacy shape is already deprecated (`keymap.registerLayer`
  is the current form) — signals the API is young and evolving; expect churn.
- Sidebar `sidebar_content` renders with the slot library default mode —
  built-in plugins (context/mcp/lsp/todo/files) also render there; a route +
  `app_bottom` badge is the safer home for our panel opener.
- `tui` and `server` entrypoints must be **separate modules** — one module
  cannot export both. That matches our current shape (server entry at
  `exports["."]`; a new `exports["./tui"]` would be a distinct file).

### Honest comparison

| | pi | opencode |
|---|---|---|
| Popup panel | `ctx.ui.custom` overlay — mature, documented, stable | TUI plugin routes/dialogs — shipped but young (`^1.0.0`-era, deprecated bits in-tree) |
| Identity/perf | Terminal must be the pi TUI (same constraint as pi-subagents fleet) | Terminal must be the opencode TUI |
| Depth | Also can open herdr panes (deep-dive) | No herdr-style escape hatch API; full-screen route + dialogs only |
| Risk | Low | Medium: API churn, version parity between CLI and `@opencode-ai/plugin` |

**Verdict: both are implementable.** pi is low-risk and directly templated on
pi-subagents. opencode is medium-risk but genuinely supported — a `./tui`
module in the same npm package, wired as one `tui.json` entry, is the minimal
integration.

---

## 2. The generalization: panels as a view + action dispatcher over the queue

The key move that keeps this a framework feature, not two unrelated UIs:

> **A panel is a host-agnostic document (read) + a set of already-validated
> mutations (write). The panel adds a human-scale decision surface over the
> SAME store the queue_* tools use — zero new state, zero new transitions.**

The queue model already has every piece the panels need:

- proposals exist (`proposal` status, scope written at sweep time)
- approve/reject are transitions `proposal → approved/rejected/blocked`
- human-review items exist (`human-review`) with pointer-rich auto-flags
  (`reviewPointersFor`, `deliverablePathsFor`, `webUrlForCommit` — built for
  exactly this navigation need)
- the mutation primitives validate (`ALLOWED`, approval gate, blocker reasons)

So the shared core is thin:

```
src/framework/panels.ts            (NEW — pure framework, no host imports)
  buildPanelDoc(stateDir, { kind }) → PanelDocument
    kind: "proposals" | "human-review"
    PanelDocument = {
      kind, generatedAt,
      sections: [{ title, items: [{
        key, title, status, risk, cwd,
        summary,                    // scope head / work summary
        targets: [{ label, hint }], // branch@tip diff commands, file paths, web links
        actions: ["approve","reject","refine","defer"]  // per status, from PANEL_ACTIONS
      }] }]
    }
  applyPanelDecision(stateDir, key, action, payload?) → { ok, text }
    // calls the SAME queue-ops handlers (queueUpdate/queueAdd) — validated
    // transitions only; emits orch:human-decision domain event.
  PANEL_ACTIONS           // { id, label, transition?, needsInput? }
    approve  → proposal→approved / human-review→done
    reject   → proposal→rejected / human-review→rejected
    refine   → needs input; rewrites scope/notes (proposal) or re-dispatch
               findings (human-review)
    defer    → proposal→blocked (blocker: decision/parked)
```

Rules that keep the design honest:

1. **The panel never invents a transition.** Every action maps 1:1 to an
   existing validated `queue_*` operation. If the queue model changes, panels
   inherit it for free.
2. **Direct mutation for deterministic actions; the agent only for
   judgment.** Approve/reject/defer are pure transitions — the panel applies
   them and the harness emits `orch:human-decision`, so the orchestrator sees
   exactly what happened (same event surface as a manual `queue_update`).
   Refine needs free text and judgment — the action opens an input surface and
   forwards the human's words to the item (scope edit) or into a re-dispatch
   task; nothing is ever sent to a worker without the orchestrator's normal
   dispatch path.
3. **Panels are `pull` (open on demand), nudges are `push`.** No aggressive
   auto-pop. The tick keeps doing what it does; when human decisions pend, the
   panel surface shows an indicator (pi: status widget; opencode: `app_bottom`
   badge) plus `attention`/`notify` — opening is one keybind/command away
   (`Ctrl/Cmd`-style, per host). This mirrors pi-subagents (status widget +
   `Ctrl+Alt+F`).
4. **Graceful degradation.** If no TUI is present (headless session, agent
   worker), `applyPanelDecision` still works and the *render* falls back to
   the existing JSON tick (which already carries keys, verdicts, targets).
   Panels are an enrichment layer — never a requirement.
5. **Pull, not watched.** The doc is built from `queue.json` on demand — the
   same file the tools read. No new watcher, no new event bus beyond the
   existing domain-event/ledger plumbing.

## 3. Host adapters

### pi (`src/hosts/pi-panel.ts` — extension side)

- `registerCommand("orchestrate panel")` → `ctx.ui.custom` overlay
  `anchor: "center", width: "90%", maxHeight: "80%"` (pi-subagents pattern).
- Component: per-section `SelectList`-style navigation with action rows
  (Approve/Reject/Defer), `Input` for refine (IME-capable `Focusable`), OSC 8
  targets rendered via `Markdown`.
- Open shortcuts: keybind (mirror `Ctrl+Alt+F` pattern) + a tool
  `panel_open(kind)` so the orchestrator can open it when appropriate (e.g.
  after an intake sweep, in the review tick).
- Fallback: tool fails closed → keep the tick text as today.

### opencode (`src/hosts/opencode-tui.tsx` — `@opencode-ai/plugin/tui` entry)

- `exports["./tui"]` → this module; `exports["."]` stays the server plugin.
  One package, two target-only modules (required by the spec).
- `api.route.register` a full-screen panel route (proposals / human-review);
  `api.keymap.registerLayer` command `orchestrator.panel` (`ctrl+shift+o`-ish)
  to open; `api.slots.register` an `app_bottom` badge ("3 proposals awaiting").
- Per-item actions via `api.ui.DialogSelect` (options = PANEL_ACTIONS), refine
  via `DialogPrompt`; confirm via `DialogConfirm`.
- New-item attention via `api.attention.notify` (question/done sounds).
- Reads the same `buildPanelDoc` (framework module is host-agnostic); actions
  call `applyPanelDecision` (imports queue-ops — works headless too).
- Distribution: one `tui.json` line in the opencode config,
  `"plugin": ["orchestrator-autopilot"]` (version-matched to the CLI).

### Invariant across both

The human types `a`/clicks "Approve" → `applyPanelDecision` → `parseVerdict`-
independent; the transition is identical to a hand-typed
`queue_update(key, { status: "done" })`. The orchestrator is informed by the
same ticks it already understands. No fork in behavior on which host is warm.

## 4. Scope guardrails

- **Do NOT** add new statuses, a `ready` flag, or a panel-ownership layer to
  the store. The two-stage review model was built for exactly this; panels
  consume it.
- **Do NOT** route decisions around the agent silently. Deterministic
  transitions are applied directly; anything with judgment (refine payloads,
  re-dispatch tasks, high-risk items) lands on the orchestrator's normal
  path (`queue_update`/`queue_dispatch` semantics + events).
- **Do NOT** make panels a prerequisite for anything. Fallback = today's tick.
- **Do NOT** render panel UI from the server plugin (opencode) — server module
  must stay UI-free (it already is; the constraint is real).
- **Order of work** (suggested): (1) `src/framework/panels.ts` + tests in the
  hermetic suite (the doc contract + decision application are unit-testable
  without any host); (2) pi overlay (template: pi-subagents fleet); (3)
  opencode `./tui` module + `tui.json` wiring; (4) nudges (widget/badge +
  attention) last, as the polish layer.

## 5. Residual risks / open questions

- **opencode API maturity**: TUI plugin API is post-1.0 but visibly evolving
  (deprecated `api.command` already). Version parity CLI ↔ `@opencode-ai/plugin`
  matters; pin engines + verify at the work profile's opencode version before
  building on it.
- **Mid-edit focus**: an overlay opened while the user is typing in the TUI's
  textarea interrupts input ownership (pi handles this via overlay focus
  rules; opencode via `api.mode.push`). The open-shortcut UX must not grab
  focus from an in-progress prompt unless the user asks.
- **herdr-pane alternative**: for sessions where the visible terminal is a
  herdr pane, pi-side could optionally open a herdr inspector pane instead of
  (or in addition to) the TUI overlay. Deferred — decide after the TUI-native
  version exists.
- **Refine UX**: free-text refine needs a decision about who writes scope:
  direct field edit (panel `Input`/`DialogPrompt`) vs "draft + agent
  confirms". Proposal: panel edits the item's scope/notes directly; the
  dispatcher (and any future intake diff) validates nothing beyond
  non-empty — matching today's approval gate.