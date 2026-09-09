---
name: queue-id-series
description: >-
  How queue-item ids (Jira-style PREFIX-<N> series) are allocated in the
  orchestrator-autopilot harness — deterministic, derived from the item's cwd;
  when (rarely) the agent picks a series, and the provisional-key flow for
  proposals. Load when creating queue items (queue_add / queue_update) or
  proposing work for the orchestrator queue.
---

# Queue id series — the prefix is NOT your job

Queue items are identified by Jira-style keys: `PREFIX-<N>` (e.g. `B-21`). The
prefix is a **property of the workstream, and the harness resolves it
deterministically from the item's cwd** — you do not pick it per item.

## What you do

1. **Pass `cwd` whenever you know the target repo** (even at proposal stage).
   The series then resolves immediately: registry → history → repo-name slug.
   `queue_add({ title, cwd: "/x/addrl", ... })` lands in the addrl series with
   no thought spent.
2. **Proposals without a cwd get a provisional `Q-<n>` handle.** Fine for
   conversation ("approve Q-3"); at the approved transition — where cwd becomes
   mandatory — the key is automatically RENAMED into the repo's real series
   (`Q-3` → `B-49`), the rename is recorded in the item's notes, and the tool
   result tells you the new key. Use the NEW key afterwards.
3. **Explicit `series` only when starting a genuinely NEW workstream** (no
   prior items, and the repo-name slug is wrong — e.g. a sub-workstream like
   `EVAL-EXPT` inside a larger repo). That choice is recorded for the cwd and
   every future item inherits it.
4. **Explicit `key` for semantic suffixes** (`B21-FINISHER`) or milestone
   letters (`EVAL-EXPT-M3`). Explicit keys are never renamed.

## Why not hand-pick prefixes

Hand-numbering produced duplicate series numbers ("multiple B-49 items"):
humans miss suffixed keys (`B5-NAME`) when eyeballing a counter. The harness
counts them (first number after the prefix, all series, guaranteed free) and
remembers cwd→series across sessions — judgment is needed at most once per
workstream, then never again.

## When NOT to follow this

Ad-hoc subagent runs (spawns that never enter the queue) don't get keys at all —
they leave `unmatched-completion` telemetry in the harness log by design. If
work matters enough to track, it matters enough to `queue_add`.
