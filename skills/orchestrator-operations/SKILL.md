---
name: orchestrator-operations
description: >-
  Operating rules for the orchestrator framework — the dispatch contract,
  review-loop judgment, completion standards, and the human handover. Load
  when orchestrating (dispatching workers, routing reviews, flagging completed
  work). Backend-conditional: read references/<your-backend>.md for the
  host-specific notes.
---

# Orchestrator Operations

Generic operating rules for the orchestrator-autopilot framework. The
authoritative queue model lives in the package (`docs/queue-model.md`).

## Detect your backend (deterministic — from your own tools)

The launched tool determines the backend — no env, no files. Look at the
`queue_list` tool's description: it carries the host marker.
- `(pi host)` → you are on **pi** (the extension).
- `(opencode host)` → you are on **opencode** (the plugin).

Read ONLY `references/pi.md` or `references/opencode.md` for your backend's
host-specific notes (worktree enforcement, ticks, steering, flagging). Apply
only your own backend's notes.

## Dispatch contract

- **Auto-dispatch**: an approved item with a complete `scope` + `cwd` +
  low/medium risk is dispatched AUTOMATICALLY when a slot frees (the task =
  `KEY: <key>` + the scope). Write good scopes at proposal/approval time —
  that is where the worker prompt lives now.
- **The approval gate makes this possible**: reaching `approved` REQUIRES a
  non-empty `scope` + `cwd` (enforced by `queue_add`/`queue_update` — not skill
  guidance). Approved = fully specified = the harness can act without you.`
- `queue_dispatch(key, task, { cwd?, timeoutMs? })` stays the MANUAL tool for
  everything auto-dispatch does NOT take: high-risk items, incomplete scope or
  missing `cwd` (blocked items are never dispatchable — unblock first).
- The dispatch TICK now nudges only those manual cases — the auto-dispatchable
  work never nags.
- The task prompt is the COMPLETE contract — self-contained: the concrete task,
  the relevant context, the success criteria, and the source/universe/repo the
  worker must use. Ambiguity about the data source is a blocker — never a
  worker guess.
- **Intake sources are YOURS**: the intake tick only nudges a scan when the
  approved buffer is low (and suppresses while proposals pend). WHERE the
  orchestrator scans — ticket trackers, meeting action items, file diffs,
  goals — is defined in your orchestrator command, not the framework.
- **Commit-early is HARD**: never accumulate > ~15 min uncommitted; the first
  commit lands before any long-running test or fix cycle.
- **Worker authority**: the worker executes its task; it must NOT modify
  infrastructure or config outside the task scope (it flags such problems, it
  does not fix them).

## Review-loop judgment (the framework routes verdicts; you supply judgment)

- **Auto-review**: when a worker completes, the framework dispatches the
  reviewer AUTOMATICALLY with the same fields the dispatch used (`KEY` + scope
  + `cwd` to locate the work) — you do not call `queue_review` for those.
  `queue_review` stays the OVERRIDE: high-risk items, a custom review focus,
  or replacing/steering an auto review (a tick announces each auto-review).
- On a review **FAIL**: the framework flipped the item to active AND
  auto-re-dispatches it with the original scope + the reviewer's findings (up
  to the cap). The worker sees only its task prompt — the findings must
  be IN it. If the findings are mechanical, applying the fix directly is a
  judgment call; for code tasks, re-spawn.
- On **cap** (5 FAILs): the framework marked it failed — surface the options:
  apply the findings directly / review the work as-is / drop.
- `queue_review(key, task?)` remains the tool for dispatching the reviewer on
  a `reviewing` item.
- **PASS** → the human handover: `flag_for_review` (below). Never hand off
  before agent review passes.

## Completion standards

- Every finished worker gets a **completion card**: outcome-first, key numbers,
  files/commits, risks/limitations, and the user's action. Never a raw output
  dump.
- **DIRECT in-session deliverables get the same handover** — not just queue
  items. The queue pipeline nudges you (the PASS tick says "flag_for_review"),
  but work YOU produce directly has no pipeline: after handing the user any
  user-facing artifact (a doc, an analysis, a plan), call `flag_for_review`
  with the file paths as `review_targets` BEFORE moving on. An agent review
  pass is optional for direct work — honest `self_reviewed: false` +
  `review_method: "none"` is correct. The user should never discover a
  finished deliverable in chat without the flag.
- The handover: `flag_for_review(summary, risk, blast_radius, review_targets,
  self_reviewed, review_method, action_needed?, residual_risks?, queue_key?)`
  — ONLY when the work is done, committed, and any automated review has passed.
  `review_targets` is MANDATORY: the file paths / `path:line` ranges / commit
  SHAs / MR links the human should look at — name the files, never just
  "task done". Reason about risk (what happens if wrong) and blast radius
  (what breaks) before flagging; say what the user should DO next
  (`action_needed`). Move the item reviewing → done (`queue_update`) after
  flagging — the human's review is the FINAL gate: if the user finds issues,
  re-open with `queue_update(key, { status: "approved" })` (done → approved,
  attempts reset) and re-dispatch with the human's findings in the task.

## Queue model

See the package's `docs/queue-model.md` — statuses, transitions, and the tick
behavior (dispatch / intake with proposal-pending suppression / review).
