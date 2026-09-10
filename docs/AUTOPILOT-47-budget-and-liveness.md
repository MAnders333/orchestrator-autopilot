# AUTOPILOT-47 — the budget is dropped, and nobody notices the death

Two independent failures produced one symptom: workers died at 30 minutes no
matter what budget was requested, and the queue kept reporting them as running.

## A — the budget IS passed, and IS dropped at the last hop

Traced end to end against the installed runtime (`pi-subagents@0.66.0`):

| hop | what happens to `timeoutMs` |
| --- | --- |
| `queue_dispatch` / `auto-dispatch` / `auto-recovery` / `auto-review` | put `item.timeoutMs` on `backend.spawn` |
| `backends/pi.ts` | embeds it in `runs.run("main", { …, timeoutMs })` |
| `subagent-executor.ts` `buildWorkflowChildParams` | forwards it into the child launch params |
| `async-execution.ts` | turns it into the RUN-level deadline: `deadlineAt = Date.now() + params.timeoutMs` |
| `async-execution.ts` `buildAsyncRunnerSteps` | **THE DROP** — the per-STEP budget is built as `timeoutMs: a.defaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS` (30 min), with no reference to the request |
| `subagent-runner.ts` `runSingleStepWithTimeout` | enforces `Math.min(step.timeoutMs, parentRemainingMs)` — the SMALLER wins |

So a request above 30 minutes is truncated to 30 minutes, and the kill message
is formatted from the STEP budget. That is exactly AUTOPILOT-32: item
`timeoutMs` 7200000, spawn timeout 7200000, `status.json` error
`"Subagent timed out after 1800000ms"`, `durationMs` 1800489 — twice.

**The framework cannot lift that ceiling from the dispatch side.** It is the
agent definition's `defaultTimeoutMs` or a hardcoded constant, never a launch
parameter; `config.timeoutMs` does not reach it either. Raising it for real
needs a per-agent `timeoutMs:` in the agent definition (a static, fleet-wide
change) or an upstream fix.

**So dispatch warns loudly instead of pretending** (`src/framework/run-budget.ts`,
surfaced by `queue_dispatch`). It does not refuse: refusing would strand every
item whose recorded budget exceeds 30 minutes — including auto-recovery's
escalated re-dispatches — and a truncated run still does 30 minutes of real
work. What must never happen again is the operator planning two hours of work
against a budget the runtime silently halves.

## B — why no sweep noticed, and the AUTOPILOT-20 trade

`zombieReconcile` is gated on the fleet being AUTHORITATIVELY IDLE
(`fleetTotalActive === 0`). On a busy queue that is never true: **one live
worker anywhere makes every dead run in the store immune.** Three runs sat
dead-but-`active`/`ai-review` for 117 and 287 minutes and more while other
workers ran. The gate was not a bug in itself — without a per-run signal,
"nothing is running anywhere" was the only evidence strong enough to condemn an
item — but it made the net impossible to fire exactly when it was needed.

Fail-open was NOT the cause. It is still the tension worth naming, because the
obvious fix is to make liveness fail closed, and AUTOPILOT-20 chose fail-open
deliberately.

**The distinction this item adds: `terminal` is not `undeterminable`.**
A run whose `status.json` parsed and says `state:"failed"` is POSITIVE EVIDENCE
OF DEATH. A run whose status is missing, unreadable, or spells a phase this code
has never seen is ABSENCE OF EVIDENCE. Collapsing them into one boolean forces
every caller to pick one fail direction for both — and the right direction is
not the same in both lanes:

- **reviewer dispatch (AUTOPILOT-20)**: a wrong "dead" costs a duplicate
  read-only reviewer (cheap); a wrong "alive" costs a manual bypass that breaks
  verdict attribution (expensive). Fail toward dispatching.
- **the dead-run sweep (AUTOPILOT-47)**: a wrong "dead" flips a LIVE worker's
  item to failed and invites a duplicate re-dispatch (expensive); a wrong
  "alive" costs one more grace window (cheap). Fail toward leaving it be.

Same input, opposite safe answers. So `runStateEvidence` reports the EVIDENCE
(`in-flight` | `terminal` | `undeterminable`) and each lane owns its fail
direction. `reviewerRunAlive`'s answers are byte-for-byte unchanged — nothing
about AUTOPILOT-20 was reversed. `deadRunReconcile` condemns only on `terminal`;
no backend, a missing run dir, an unreadable `status.json`, an unrecognised
phase, and a throwing lookup all flip nothing.

`deadRunReconcile` is NOT fleet-gated (that is the whole point) and reuses the
existing `zombieGraceMinutes` window, for the same reason the fleet net does:
the active→ai-review flip is event-driven, so an item whose run just ended is
legitimately `active` for a moment. Only an item still `active` a full grace
window after its last update has provably lost its completion event.

A run killed by the budget (`error` matching the runtime's `timed out after
<n>ms`) is routed to `failCause: "budget-capped"`, so auto-recovery treats it as
a CAP; anything else is `zombie`, a lost completion event.

## C — where the uncommitted work went

Keep refs preserve COMMITTED work. A reaped run's UNCOMMITTED changes survive
only in its worktree directory, and nothing recorded which one — salvage meant
matching run ids to `pi-worktree-*` paths by hand.

`runWorktreePath` resolves the directory from `git worktree list` via the run's
`pi-parallel-<runId>` branch; `recordActiveWorktrees` writes it onto the active
item during the existing preservation pass. Dispatch is too early — the runtime
creates the worktree after the spawn returns — so the first sweep after dispatch
is the earliest honest moment. The path is left in place after the run ends: a
stale path is a post-mortem's starting point, not a lie about a live run
(`runWorktree.runId` says which run it belonged to). `deadRunReconcile`'s
evidence note names it.

## Known gaps

- The budget warning is on the `queue_dispatch` receipt. The harness lanes
  (auto-dispatch, auto-recovery, auto-review) pass the same unhonourable budget
  without a per-dispatch warning; auto-recovery still escalates a capped item's
  budget ×1.5 up to 3h, which the runtime will keep truncating to 30 minutes.
- `runWorktreePath` matches on the `pi-parallel-<runId>` branch naming. A
  worktree provider that names branches differently resolves to null and records
  nothing — no invented path.
