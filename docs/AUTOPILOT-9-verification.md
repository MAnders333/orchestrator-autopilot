# AUTOPILOT-9 — autopilot ON/OFF contract verification (end-to-end)

Scope: verify the autopilot ON/OFF contract invariant-by-invariant against a
scratch state dir + clean repo, fix any deviation found, and hand the branch
to review (main untouched until human approval).

Evidence sources:
- **Live pi-host telemetry** (read-only): `~/.local/state/orchestrator/personal/`
  `autopilot.jsonl`, `reviews.jsonl` — real session artefacts from today's
  runs (the same sessions the task observations came from).
- **Real-code fixture pass**: the full suite loads the REAL modules (queue
  store, Autopilot engine, framework runner, pi-host adapter) against scratch
  state dirs + scratch clean git repos with a stubbed subagent RPC.
- A fully-headless `pi -e <this-tree-extension>` live pass could NOT run in
  this sandbox: the pi profile auto-loads the installed
  `orchestrator-autopilot@0.4.0` package extension, so the `-e` registration
  doubles the queue tools (reproduced error below), and the sandboxed child
  cannot reach the profile's model provider (180s timeout). The authoritative
  TUI live pass runs in the orchestrator session — this document tells the
  reviewer exactly what to re-check there.

## ON contract

### (i) approved + scope/cwd + low/med → auto-dispatch into free slots on a worker-done sweep, without queue_dispatch
**PASS** (code + fixture pass; see the AUTOPILOT-9 fix note below for the
idle-slot extension).
- `runner.onCompletion` → `handleAsyncComplete` (flip) → `sweep("worker-done")`
  → `autoDispatchEligible` (scope+cwd+risk gate, oldest-first, slot-capped) →
  spawn + `approved→active` + `runId` → one consolidated `[orch-tick: harness]`.
- Tests: `test/framework/auto-dispatch.test.ts` (eligibility gates, slot cap,
  oldest-first) + `test/framework/runner.test.ts` "auto-dispatch fills free
  slots on EVERY free-slot window".
- Live: `2026-09-09T14:56:27.066Z sweep worker-done` →
  `14:56:27.245Z started (worker)` + `14:56:27.304Z started (worker)` — the
  harness engaged on the worker-done sweep.

### (ii) worker completion → active→ai-review + reviewer auto-dispatched
**PASS**.
- `core.handleAsyncComplete` flips `active→ai-review`; runner `onCompletion`
  auto-dispatches the reviewer (`autoReview`, same KEY+scope+cwd, reviewer
  agent, verdict contract) — `reviewerRunId` stored, one harness tick.
- Live: `14:22:34.120Z flip AUTOPILOT-6 → ai-review` →
  `14:22:34.294Z sweep worker-done` → `14:22:34.384Z started (orchestrator-reviewer)`
  — reviewer spawned ~90ms after the completion event.
- Test: runner "auto-review (C) through the runner".

### (iii) verdict routing
**PASS**.
- PASS → `ai-review→human-review` + auto-flag (`reviews.jsonl`) + review tick.
  Live: `14:20:48.935Z flip AUTOPILOT-4 → human-review (verdict-pass)` +
  `reviews.jsonl 14:20:48.946Z flag_for_review`; `14:52:08.586Z flip
  AUTOPILOT-7 → human-review` + flag `14:52:08.607Z`.
- FAIL < cap → `ai-review→active` (attempts++) + auto re-dispatch with the
  reviewer's findings. Live: `14:56:26.824Z flip AUTOPILOT-6 → active
  (verdict-fail, attempts 1)` → `14:56:27.245Z started (worker)` — the redo
  branch `pi-subagents/main-0b611e5` is the auto-re-dispatched work.
- cap → `failed` (+ cap tick). Test: `test/autopilot.test.ts` "reviewer
  verdict FAIL at cap → failed (PERSISTED) + cap tick".
- Tests: runner "onCompletion: reviewer Verdict: PASS → human-review +
  reviewTick" (also asserts the deterministic reviews.jsonl flag).

### (iv) dispatch/intake/harness ticks reach the orchestrator role with delivery-fresh FLEET/QUEUE facts
**PARTIAL — mechanics PASS, freshness FAIL in THIS tree (fix in flight
elsewhere).**
- Delivery mechanics PASS: ticks route through the shared router
  (interactive/loaded/busy/compacting gate, cooldown, busy-deferral flushed at
  the settle), delivered to the role via pi `sendMessage customType
  orchestrator-autopilot` / opencode `promptAsync`. Tests: runner deferral +
  cooldown + gate suites.
- Freshness-at-delivery FAIL-in-tree: this branch (HEAD 55ce183) predates the
  AUTOPILOT-6 fixes. The runner defers tick MESSAGES (frozen generation-time
  facts) across the busy window, and the engine takes the fleet RPC verbatim —
  so a tick CAN still claim stale FLEET/QUEUE numbers at delivery (the
  observed `FLEET: 0/3` stale-at-delivery + the RPC undercounting a
  just-started workflow-parent run). Both fixes exist on the in-flight
  AUTOPILOT-6 thread (`pi-subagents/main-0b611e5`): `c271a9e`
  (refreshTickFacts at delivery) + `bcfa9ff` (fleet-vs-inventory union).
  **Approve/merge that thread for (iv)'s freshness clause to hold on main.**
- The AUTOPILOT-9 fix in THIS tree already applies the conservative union to
  the AUTO-DISPATCH slot math (so the now-more-frequent auto-dispatch cannot
  over-spawn on an undercount); it deliberately does NOT duplicate
  `c271a9e`/`bcfa9ff` (that thread's scope).
- Compare-at-delivery aid: `autopilot.jsonl` sweep lines log
  `fleetTotalActive` + `occupied` side-by-side (e.g. `14:58:01.827Z occupied 6
  fleetTotalActive 6`) — the parent's live pass should snapshot `subagent
  status fleet` at delivery time for each tick.

## OFF contract (second scratch session)

### (v) completion → NO flip, NO auto-review, NO tick
**PASS** by construction + tests. The shared runner gates `onCompletion` on
`enabled()` (= `isAutopilotOn(stateDir, sessionId)`; pi + opencode both) — an
OFF completion returns before any flip/verdict/auto-action. Tests: runner
"enabled=false → completions are IGNORED: no flip, no auto-review, no ticks";
`pi-extension` "off → migration + tools still work, but no ticks".

### (vi) sweep auto-dispatches nothing
**PASS** + regression-covered. The same `enabled()` gate is the sweep's first
line; my new OFF-gate test covers the NEW sweep sources (timer/settled/
activate) — zero spawns while OFF.

### (vii) queue tools + `/autopilot status` work manually
**PASS** (code). The queue tools carry no autopilot gate
(`src/tools/queue-ops.ts` has no `isAutopilotOn`); `queue_dispatch/
queue_review/queue_update/flag_for_review` operate identically OFF (the OFF
mode message says exactly this). Tests: "off → migration + tools still work"
+ the full queue-tool suite. The headless live `pi -e` re-run is blocked in
this sandbox (see evidence note) — re-run `PI_E2E=1 bun test
test/hosts/pi-e2e.test.ts` in the parent session for the live tool pass.

### (viii) the runner's enabled() gate holds on both hosts
**PASS** by construction. pi: `enabled = fireScheduledOffIfDue(sid) +
isAutopilotOn(stateDir, sessionId)`; opencode: identical pattern with
`delivery.target()` as the session id. Both feed the ONE shared runner;
tests: gate suite (busy/not-interactive/not-loaded/compacting/off) + pi
per-session isolation.

## (a) — is idle-free-slot non-auto-dispatch by design? NO → FIXED

- **Documented contract is unconditional**: "the orchestrator auto-dispatches
  when a slot frees" (`prompts/orchestrate.md`), "an approved item … fills a
  free slot by itself" (`prompts/orchestrate.md` harness section), "dispatched
  AUTOMATICALLY when a slot frees" (`skills/…/SKILL.md`), "the harness
  AUTO-dispatches fully-specified approved items" (`docs/queue-model.md`) —
  no worker-done qualifier anywhere.
- **Implementation violated it**: `runner.sweep` ran `autoDispatchEligible`
  only on `source === "worker-done"`; the activation path ran no sweep at all;
  `settled`/`timer` sweeps only nudged (and the timer nudges a PERSISTENT gap,
  so an unacted orchestration loop is nudged forever without the harness
  acting).
- **Live confirmation** (personal `autopilot.jsonl`): `14:42:11Z`–`14:56:26Z`
  — settled/timer sweeps with free slots + ready work (`14:53:09.865Z
  occupied 2 ready 3` → `tick dispatch settled`; `14:56:08.787Z occupied 2
  ready 3` → `tick dispatch timer`) produced ONLY nudges; the first harness
  spawns landed right after the NEXT worker-done sweep (`14:56:27.245/
  .304Z`). Approved items stranded next to idle slots until a completion —
  matching the observed "early-ON window fired ZERO auto-dispatches".
- **Fix (this branch)**:
  1. `runner.sweep` auto-dispatches on EVERY free-slot window
     (worker-done | timer | settled | activate) — the eligible-item + slot
     guards make the extra triggers inert when nothing is eligible.
  2. `runner.activate()` added + wired to `/autopilot on` on BOTH hosts,
     so the early-ON window fills immediately; its tick side stays inert
     pre-injection (the router drops pre-`loaded` ticks — only the auto-action
     runs).
  3. Auto-dispatch slot math now uses the fleet-vs-inventory union
     (max(RPC, ledger, store-occupied)) so the more frequent harness cannot
     over-spawn while the status RPC lags a just-started parent.
  4. Docs updated to name the free-slot windows explicitly
     (`docs/queue-model.md`, `skills/…/SKILL.md`, `prompts/orchestrate.md`).
- **Tests**: `test/framework/runner.test.ts` AUTOPILOT-9 block (timer/settled/
  activate auto-dispatch, OFF-gate on all new sources, undercount no-over-spawn)
  and `test/hosts/pi-extension.test.ts` "AUTOPILOT-9: /autopilot on
  auto-dispatches … ACTIVATION sweep".

## Reproduced sandbox limitation (for the live re-run)

```
Error: Failed to load extension ".../pi-extension.ts":
  Tool "queue_list" conflicts with
  /Users/marc.anders/personal/.../pi-worktree-.../src/hosts/pi-extension.ts
```

The pi profile auto-loads the installed package extension; `-e <tree path>`
double-registers the queue tools. The parent's TUI live pass should load the
branch extension via a temporary profile (or temporarily skip the installed
package) and re-run under `PI_E2E=1`.

## Result

Contract verified end-to-end for (i)–(iii), (v)–(viii); (iv) delivery mechanics
verified with freshness explicitly dependent on the in-flight AUTOPILOT-6
thread (`c271a9e` + `bcfa9ff`); (a) judged a contract violation and fixed.
Main untouched — all changes on `pi-subagents/main-aa945f8-e9af-s0-t0`.