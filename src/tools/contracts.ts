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
    "Approval (status=approved) REQUIRES a complete scope + cwd. " +
    "KEY ALLOCATION is deterministic: pass `cwd` and the series resolves automatically (registry → history → repo-name slug). A proposal without cwd gets a provisional Q-<n> handle, renamed into the repo's real series at approval. " +
    "Pass explicit `series` only when starting a NEW workstream; explicit `key` for semantic suffixes (must be unique). Hand-numbering collides — do not hand-pick numbers.",
  queue_update:
    "Update a queue item: status (validated transitions: proposal→approved/rejected/blocked (defer a candidate without approving), approved→active/rejected, " +
    "active→ai-review/failed, ai-review→human-review/failed/active, human-review→done/active/rejected, failed→active (recovery re-dispatch) | done (verified-complete despite the failure record), done→approved (human re-open — you found issues after approval)); " +
    "approved REQUIRES a complete scope + cwd; blocked REQUIRES a blocker reason (parked/serialized/merge/decision). " +
    "active→ai-review/failed are event-driven — do NOT set them by hand. " +
    "OVERRIDING A FAILURE VERDICT: pass `overrideReason` — it is RECORDED on the item (append-only overrides[]) instead of living as prose in notes, so a pattern of overrides stays visible.",
  queue_dispatch:
    "Dispatch a queue item: spawns the worker (same executor as the subagent tool; fresh context, worktree isolation) AND records " +
    "approved→active with the run id — atomically. Call with the key of an approved item and the scoped worker prompt. " +
    "High-risk items: still surface the final checkpoint BEFORE calling this. Returns the run id. " +
    "MERGE FINISHERS: pass dispatchClass='finisher' AND finisherSource=<branch/sha it must land> when the run writes into the cwd's CHECKOUT (cherry-pick/merge into main) instead of its own worktree — the dispatch records the cwd's HEAD plus that source as a baseline, and success is then judged on the source entering the cwd's history, so a runtime 'no edits in the worktree' failure verdict is overridden (and the override recorded) instead of re-dispatching a merge that already landed. Without finisherSource there is NO evidence and the runtime verdict stands.",
  queue_review:
    "Dispatch the reviewer for an `ai-review` item: spawns the reviewer subagent (read-only, no worktree) via the same executor, records the " +
    "reviewerRunId on the item, and emits orch:reviewer-dispatched. When the reviewer completes, the verdict line ('Verdict: PASS/FAIL') " +
    "is parsed and the item auto-transitions (PASS → human-review awaiting your approval, FAIL → active re-dispatch, cap → failed) — see the queue model. Returns the run id.",
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
