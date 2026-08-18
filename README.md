# Orchestrator Autopilot

Deterministic orchestrator framework: keeps a subagent worker fleet at capacity,
routes queue items through a review lifecycle, and ships its own agents —
**one implementation, multiple hosts** (pi + opencode).

The framework is host-agnostic software: a programmatic queue store, a
deterministic lifecycle (ticks, completion attribution, verdict routing), and
thin per-host adapters. Hosts only wire events, gate state, and deliver ticks —
the machinery is shared.

## Getting started

1. Clone + install: `bun install` (Bun required; the test suite is hermetic).
2. Wire the host you use:
   - **pi**: add `src/hosts/pi-extension.ts` to your settings `extensions` array.
   - **opencode**: add `src/hosts/opencode-plugin.ts` to your `opencode.jsonc`
     `plugin` array (requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1`
     for detached worker runs).
3. Load the orchestrator command in your orchestrator session (a slash command
   that tells the agent to run the queue loop — the `docs/queue-model.md`
   describes what the framework enforces vs. what the agent decides). That
   command is also where you define YOUR intake sources: the framework nudges
   a scan when the approved buffer is low, but it does not know where your
   work comes from (trackers, meetings, diffs, goals — your call).
4. The package installs its own agents (reviewer + worker) into the host's
   agent dirs at activation — version-stamped, idempotent.
5. Point the orchestrator at the queue store (`AUTOPILOT_STATE_DIR` or the
   defaults below) and add the `skills/orchestrator-operations/` skill to your
   agent's skills config for the operating rules.

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
│   ├── queue-ops.ts      ← the SIX queue tools, host-agnostic (single impl)
│   ├── runner.ts         ← shared tick machinery: trigger routing (completion/
│   │                        settled/timer/activation) + gate + cooldown — the
│   │                        hosts only WIRE their events to it
│   └── tick-router.ts    ← the delivery gate (interactive/loaded/busy/
│                            compacting + cooldown + message format)
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

## Docs

- `docs/queue-model.md` — the AUTHORITATIVE queue model: statuses (proposal / approved / blocked / active / reviewing / failed / done / rejected), transitions, and the tick behavior (dispatch / intake with proposal-pending suppression / review).
- `skills/orchestrator-operations/` — the GENERIC operating skill for consumers (dispatch contract, review-loop judgment, completion standards, the flag_for_review handover). Backend-conditional: `SKILL.md` detects the active host in-session (the `/autopilot` command = pi) and loads only `references/pi.md` or `references/opencode.md`. Add it to your tool's skills config.
- The `flag_for_review` handover tool ships with the package (registered by the pi extension and the opencode plugin).

## Config / portability

Canonical defaults; local setups override via env:

| Var | Purpose |
|---|---|
| `AUTOPILOT_STATE_DIR` | queue store location (default `~/.local/state/orchestrator[-personal]`) |
| `AUTOPILOT_LIB_DIR` | override lib resolution (published layouts) |
| `AUTOPILOT_OPENCODE_BIN` | opencode launcher (default `opencode`; a local wrapper can pin its own binary) |
| `AUTOPILOT_BACKEND` | `pi` (default) \| `opencode` |
| `AUTOPILOT_OPENCODE_RUNS_DIR` | opencode run records (default `~/.local/state/orchestrator-opencode/runs`) |
| `AUTOPILOT_*` (config) | `AUTOPILOT_MAX_SLOTS`, `AUTOPILOT_QUEUE_LOW`, `AUTOPILOT_WORKER_AGENTS`, `AUTOPILOT_REVIEWER_AGENTS`, `AUTOPILOT_REVIEW_CAP`, `AUTOPILOT_SWEEP_INTERVAL_MS` |

## Tests

```
bun test                      # 120 hermetic (fake oc backend, fake pi API)
OPENCODE_E2E=1 bun test       # + real `oc run` e2e
PI_E2E=1 bun test             # + real pi-subagents e2e
```
