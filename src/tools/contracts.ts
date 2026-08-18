// src/tools/contracts.ts — the tool CONTRACT TEXT, single-sourced. The hosts
// (pi TypeBox tools, opencode def tools) reference these instead of
// hand-writing descriptions — the contract has drifted before (the ready
// flag, the done→approved transition) and must be fixed in ONE place.

export const CONTRACTS = {
  queue_list:
    "List the orchestrator task queue. Filter by status and/or last-change timestamp; compact view by default " +
    "(heavy free-form fields only with includeNotes). Returns per-status counts + fleet occupancy + matching items.",
  queue_add:
    "Add a new queue item (proposal by default, or approved). Notes/scope are free-form — no schema constraints on content. " +
    "Approval (status=approved) REQUIRES a complete scope + cwd.",
  queue_update:
    "Update a queue item: status (validated transitions: proposal→approved/rejected, approved→active/rejected, active→reviewing/failed, " +
    "reviewing→done/failed/active, failed→active, done→approved (human re-open — you found issues in your review)); " +
    "approved REQUIRES a complete scope + cwd. blocker (parked/serialized/merge/decision), or free-form notes. " +
    "active→reviewing/failed are event-driven — do NOT set them by hand.",
  queue_dispatch:
    "Dispatch a queue item: spawns the worker (same executor as the subagent tool; fresh context, worktree isolation) AND records " +
    "approved→active with the run id — atomically. Call with the key of an approved item and the scoped worker prompt. " +
    "High-risk items: still surface the final checkpoint BEFORE calling this. Returns the run id.",
  queue_review:
    "Dispatch the reviewer for a `reviewing` item: spawns the reviewer subagent (read-only, no worktree) via the same executor, records the " +
    "reviewerRunId on the item, and emits orch:reviewer-dispatched. When the reviewer completes, the verdict line ('Verdict: PASS/FAIL') " +
    "is parsed and the item auto-transitions (PASS → done, FAIL → active re-dispatch, cap → failed) — see the queue model. Returns the run id.",
  queue_steer:
    "Steer a RUNNING worker or reviewer (dispatched via queue_dispatch/queue_review). Writes a steer request to the subagent control " +
    "channel and VERIFIES the child's acknowledgment. Headless children do not support steering (supported:false capability or silent " +
    "no-ack) — the tool reports that honestly instead of claiming delivery. If the run dir is gone, the run completed/died — stop + " +
    "re-dispatch instead.",
  flag_for_review:
    "Flag that you believe the current task is complete and ready for the user's judgment. Call this ONLY when you believe the work is " +
    "done — not after every turn, not when you have a question. Reason explicitly about risk (what happens if wrong) and blast radius " +
    "(what breaks) before flagging. self_reviewed=true when an automated review passed (commit-hook / reviewer-subagent), else false.",
} as const;
