// framework/run-budget.ts — what the RUNTIME will actually honour of a
// requested wall-clock budget (item.timeoutMs), so a budget it cannot honour is
// never accepted in silence.
//
// AUTOPILOT-47, PROBLEM A — the budget IS passed and IS dropped. Traced end to
// end against the installed runtime (pi-subagents 0.66.0):
//
//   1. queue_dispatch / auto-dispatch / auto-recovery / auto-review all put the
//      item's timeoutMs on backend.spawn (src/tools/queue-ops.ts,
//      src/framework/auto-dispatch.ts, src/framework/auto-recovery.ts).
//   2. The pi backend embeds it in the workflow script:
//      `runs.run("main", { agent, task, …, timeoutMs })` (src/backends/pi.ts).
//   3. pi-subagents forwards it into the child launch params
//      (subagent-executor.ts buildWorkflowChildParams) and turns it into the
//      RUN-level deadline only: `deadlineAt = Date.now() + params.timeoutMs`
//      (async-execution.ts).
//   4. THE DROP: the per-STEP budget the child actually runs under is built
//      WITHOUT reference to the caller's request —
//      `timeoutMs: a.defaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS`
//      (async-execution.ts, buildAsyncRunnerSteps), DEFAULT_ASYNC_TIMEOUT_MS =
//      30 * 60 * 1000. The runner then enforces
//      `Math.min(step.timeoutMs, parentRemainingMs)`
//      (subagent-runner.ts, runSingleStepWithTimeout) — so the SMALLER of the
//      two wins and any request above 30 minutes is truncated to 30 minutes.
//      The kill message is formatted from the STEP budget, which is why
//      AUTOPILOT-32 (item timeoutMs 7200000, spawn timeout 7200000) died with
//      "Subagent timed out after 1800000ms" and durationMs 1800489.
//
// The framework CANNOT lift that ceiling from the dispatch side: it is the
// agent definition's `defaultTimeoutMs` or a hardcoded constant, never a launch
// parameter. `config.timeoutMs` does not reach it either. Raising it requires a
// per-agent `timeoutMs:` in the agent definition (a static, fleet-wide change,
// not a per-item budget) or an upstream fix.
//
// So dispatch WARNS LOUDLY instead of pretending. It does not refuse: refusing
// would strand every item whose recorded budget exceeds 30 minutes (including
// auto-recovery's escalated re-dispatches) and a truncated run still does 30
// minutes of real work. What must never happen again is the operator planning
// two hours of work against a budget the runtime silently halves.

/**
 * The largest per-step wall-clock budget the installed runtime will honour for
 * a spawned child, in ms. Source: pi-subagents `DEFAULT_ASYNC_TIMEOUT_MS`
 * (30 minutes), applied as the runner step budget for every agent without its
 * own `defaultTimeoutMs`. A request larger than this is truncated to it.
 */
export const RUNTIME_STEP_BUDGET_CEILING_MS = 30 * 60 * 1000;

/** What the runtime will do with a requested budget. */
export type BudgetAssessment = {
  /** The budget as requested (ms), or null when none was requested. */
  requestedMs: number | null;
  /** What the child will actually run under (ms), or null when none was requested. */
  effectiveMs: number | null;
  /** True when effectiveMs < requestedMs — the request cannot be honoured. */
  truncated: boolean;
};

/**
 * Assess a requested budget against the runtime ceiling. A null/absent request
 * is never truncated (the runtime default applies and no promise was made).
 */
export function assessRequestedBudget(
  requestedMs: number | null | undefined,
  ceilingMs: number = RUNTIME_STEP_BUDGET_CEILING_MS,
): BudgetAssessment {
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return { requestedMs: null, effectiveMs: null, truncated: false };
  }
  const effectiveMs = Math.min(requestedMs, ceilingMs);
  return { requestedMs, effectiveMs, truncated: effectiveMs < requestedMs };
}

/**
 * The loud, actionable warning for a budget the runtime cannot honour — empty
 * string when the request is honourable (so callers can concatenate freely).
 *
 * `formatMs` renders a human duration (src/duration.ts formatDurationMs) so the
 * warning reads in minutes/hours, not raw milliseconds.
 */
export function budgetCeilingWarning(
  assessment: BudgetAssessment,
  formatMs: (ms: number) => string,
): string {
  if (!assessment.truncated || assessment.requestedMs === null || assessment.effectiveMs === null) return "";
  return (
    ` BUDGET NOT HONOURED: ${formatMs(assessment.requestedMs)} (${assessment.requestedMs}ms) was requested but the runtime caps every spawned child at ` +
    `${formatMs(assessment.effectiveMs)} (${assessment.effectiveMs}ms) — pi-subagents builds the runner step budget from the AGENT's defaultTimeoutMs (else its 30-minute ` +
    `DEFAULT_ASYNC_TIMEOUT_MS) and enforces the MINIMUM of that and the requested deadline, so the extra budget is dropped, not queued. ` +
    `This run WILL be cut off at ${formatMs(assessment.effectiveMs)} with "Subagent timed out after ${assessment.effectiveMs}ms" — scope the task to fit, or split it. ` +
    `Raising the real ceiling needs a per-agent timeoutMs in the agent definition (fleet-wide), not a per-item budget.`
  );
}
