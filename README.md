# Orchestrator Autopilot

Deterministic orchestrator framework: keeps a subagent worker fleet at capacity,
routes queue items through a review lifecycle, and ships its own agents —
**one implementation, multiple hosts** (pi + opencode).

Moved out of the dotfiles config into its own project: this is SOFTWARE, not
configuration. The dotfiles repo holds only the wiring (pi settings, the
opencode plugin array, env exports) that points the tools at this project.

## Architecture

```
src/
├── core.ts               ← Autopilot lifecycle: ticks (dispatch|intake|review),
│                            completion attribution, verdict routing, review cap
├── queue-store.ts        ← programmatic queue (queue.json), validated transitions
├── backends/             ← runtime executor adapters (the portability seam)
│   ├── types.ts          ← SubagentBackend contract
│   ├── pi.ts             ← pi-subagents RPC spawn + file control channel
│   └── opencode.ts       ← detached `oc run` children (completion = process exit)
├── framework/
│   └── queue-ops.ts      ← the SIX queue tools, host-agnostic (single impl)
├── agents/               ← framework-owned agents (canonical prompt + installer)
│   ├── install.ts        ← agent registry + per-backend projection, version-stamped
│   ├── reviewer/         ← orchestrator-reviewer (Verdict: PASS/FAIL gate, read-only)
│   └── worker/           ← worker (worktree isolation, commit-early, full tools)
└── hosts/                ← one file per host (logic + tool adapter together)
    ├── pi-extension.ts   ← pi extension: tools + ticks + lifecycle events
    └── opencode-plugin.ts← opencode plugin: host logic (completion, sweep)
                            + the tool()/event() adapter + tick delivery
```

## How the hosts wire it

- **pi**: `settings.json` `extensions` → `src/hosts/pi-extension.ts`
  (activates: installs the reviewer, registers the queue tools + `/autopilot`,
  subscribes to `subagent:async-complete`, ticks the orchestrator session).
- **opencode**: `opencode.jsonc` `plugin` → `src/hosts/opencode-plugin.ts`
  (registers the six queue tools; completion = backend process-exit →
  `handleAsyncComplete` → queue flips + verdict routing).
- **Agents** install into the host's agent dirs at activation
  (`~/.pi/shared/agents`, `~/.config/opencode/agents`) — idempotent,
  version-stamped, never hand-edited (framework-managed between markers).

## Config / portability

Canonical defaults; local setups override via env:

| Var | Purpose |
|---|---|
| `AUTOPILOT_STATE_DIR` | queue store location (default `~/.local/state/orchestrator[-personal]`) |
| `AUTOPILOT_LIB_DIR` | override lib resolution (published layouts) |
| `AUTOPILOT_OPENCODE_BIN` | opencode launcher (default `opencode`; the `oc` wrapper sets it) |
| `AUTOPILOT_BACKEND` | `pi` (default) \| `opencode` |
| `AUTOPILOT_OPENCODE_RUNS_DIR` | opencode run records (default `~/.local/state/orchestrator-opencode/runs`) |
| `AUTOPILOT_*` (config) | `AUTOPILOT_MAX_SLOTS`, `AUTOPILOT_QUEUE_LOW`, `AUTOPILOT_WORKER_AGENTS`, `AUTOPILOT_REVIEWER_AGENTS`, `AUTOPILOT_REVIEW_CAP`, `AUTOPILOT_SWEEP_INTERVAL_MS` |

## Tests

```
bun test                      # 89 hermetic (fake oc backend, fake pi API)
OPENCODE_E2E=1 bun test       # + real `oc run` e2e
```
