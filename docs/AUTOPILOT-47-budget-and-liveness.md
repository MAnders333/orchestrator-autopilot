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

The trace above was re-verified line by line against the installed
`pi-subagents@0.66.0` source:
`src/runs/background/async-execution.ts:156` (`DEFAULT_ASYNC_TIMEOUT_MS = 30 * 60 * 1000`),
`:1048` (`timeoutMs: a.defaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS` — the step
budget never consults the caller's request), and
`src/runs/background/subagent-runner.ts:1892-1895`
(`Math.min(step.timeoutMs, parentRemainingMs)`, with the kill message formatted
from `step.timeoutMs`). `a.defaultTimeoutMs` comes from an agent definition's
`timeoutMs:` key (`src/agents/agents.ts:2031-2037`); no agent in this fleet sets
one, so the 30-minute ceiling is real here.

**So the framework refuses to record or promise a budget it cannot honour, and
warns loudly wherever one is stated** (`src/framework/run-budget.ts`):

- `queue_add` / `queue_update` warn when an explicitly-set `timeoutMs` exceeds
  the ceiling — the operator plans against the number they SET, so the dispatch
  receipt is already too late.
- `queue_dispatch` warns on the receipt, and reports `budgetTruncated` in details.
- auto-recovery **clamps** its ×1.5 escalation to the honourable budget and tells
  the worker the truth (see below).

Operator-supplied budgets are warned, not rejected: rejecting would strand an
item whose recorded budget is merely optimistic, and a truncated run still does
30 minutes of real work. What is refused is the framework's own manufacture of a
fictional number.

### The escalation was worse than cosmetic

Auto-recovery grew a capped item's budget ×1.5 toward a nominal 3h. The runtime
truncates that to 30 minutes, so the extra bought nothing — but the inflated
number was then written onto the item, and `workerFailCause`'s deterministic cap
backstop compares the run's lifetime against the item's RECORDED `timeoutMs`. A
run asked for 12h and killed at 30m never trips that comparison, so **a run the
budget killed was filed as a `verdict` failure**: fewer recovery attempts, and a
note telling the operator "not budget-capped" about a capped run.

AUTOPILOT-47's own first attempt was mis-filed exactly this way
(`autopilot.jsonl`: `"outcome":"failed","failCause":"verdict"`).

So `recoveryPlan` clamps the escalation to the honourable budget and reports
`budgetGrew`; `recoveryContext` promises a BIGGER budget only when there is one,
and otherwise names the wall and says COMMIT EARLY — the advice that would have
saved both of today's runs. `workerFailCause` compares against the honoured
budget, so a cap is recognised as a cap whatever was requested.

## B — why no sweep noticed, and the AUTOPILOT-20 trade

`zombieReconcile` is gated on the fleet being AUTHORITATIVELY IDLE
(`src/core.ts:506` — `if (fleetTotalActive > 0) return { flippedKeys: [] }`). On
a busy queue that is never true: **one live worker anywhere makes every dead run
in the store immune.** Three runs sat dead-but-`active`/`ai-review` for 117 and
287 minutes and more while other workers ran. The incident-day telemetry records
the gate holding shut: `{"type":"sweep","fleetTotalActive":6}`. The gate was not a bug in itself — without a per-run signal,
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

- The ceiling is a CONSTANT (`RUNTIME_STEP_BUDGET_CEILING_MS`) mirroring the
  runtime's `DEFAULT_ASYNC_TIMEOUT_MS`, not a value read from the runtime. If an
  agent definition gains its own `timeoutMs:`, or the runtime changes its
  default, this constant must be updated or the warning becomes a false positive.
  It is pinned to `pi-subagents@0.66.0` as verified above.
- `auto-dispatch` still passes an operator-set unhonourable budget to the spawn
  without a per-dispatch warning. The budget is warned at `queue_add` /
  `queue_update` (where it is stated) and at `queue_dispatch`, so the operator is
  told — but a harness-initiated dispatch emits no fresh warning of its own.
- `runWorktreePath` matches on the `pi-parallel-<runId>` branch naming. A
  worktree provider that names branches differently resolves to null and records
  nothing — no invented path.
- Every sweep, including `deadRunReconcile`, runs only while autopilot is ON. On
  the incident day it WAS on (the telemetry shows sweeps throughout), so this was
  not the cause — but a dead run in a store nobody is sweeping is still invisible.
