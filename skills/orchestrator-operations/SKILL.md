---
name: orchestrator-operations
description: Operating rules for the orchestrator framework — the dispatch contract, review-loop judgment, completion standards, and the human handover. Load when orchestrating (dispatching workers, routing reviews, flagging completed work). Backend-conditional: read references/<your-backend>.md for the host-specific notes.
---

# Orchestrator Operations

Generic operating rules for the orchestrator-autopilot framework. The
authoritative queue model lives in the package (`docs/queue-model.md`).

## Detect your backend (deterministic — from the tool you are running in)

The launched tool determines the backend — no env, no files:
- You are on **pi** if your session has the `/autopilot` command (the pi
  extension registers it).
- You are on **opencode** otherwise (the opencode plugin registers no commands).

Read ONLY `references/pi.md` or `references/opencode.md` for your backend's
host-specific notes (worktree enforcement, ticks, steering, flagging). Apply
only your own backend's notes.

## Dispatch contract

- `queue_dispatch(key, task, { cwd?, timeoutMs? })` — only **approved** items
  dispatch; `blocked` items are not dispatchable (unblock first). Fresh context
  + worktree isolation (the enforcement mechanism is in your backend reference).
- The task prompt is the COMPLETE contract — self-contained: the concrete task,
  the relevant context, the success criteria, and the source/universe/repo the
  worker must use. Ambiguity about the data source is a blocker — never a
  worker guess.
- **Commit-early is HARD**: never accumulate > ~15 min uncommitted; the first
  commit lands before any long-running test or fix cycle.
- **Worker authority**: the worker executes its task; it must NOT modify
  infrastructure or config outside the task scope (it flags such problems, it
  does not fix them).

## Review-loop judgment (the framework routes verdicts; you supply judgment)

- On a review **FAIL**: the framework flipped the item to active — re-dispatch
  with the original scope PLUS all accumulated findings (the worker sees only
  its task prompt).
- On **cap** (5 FAILs): the framework marked it failed — surface the options:
  apply the findings directly / review the work as-is / drop.
- **PASS** → the human handover: `flag_for_review` (below). Never hand off
  before agent review passes.

## Completion standards

- Every finished worker gets a **completion card**: outcome-first, key numbers,
  files/commits, risks/limitations, and the user's action. Never a raw output
  dump.
- The handover: `flag_for_review(summary, risk, blast_radius, self_reviewed,
  review_method)` — ONLY when the work is done, committed, and any automated
  review has passed. Reason about risk (what happens if wrong) and blast radius
  (what breaks) before flagging.

## Queue model

See the package's `docs/queue-model.md` — statuses, transitions, and the tick
behavior (dispatch / intake with proposal-pending suppression / review).
