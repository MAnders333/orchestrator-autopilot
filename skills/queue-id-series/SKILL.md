---
name: queue-id-series
description: >-
  How to derive the id series (Jira-style prefix) for orchestrator-autopilot
  queue items: the general rule for choosing PREFIX-<N> keys for any given
  task/repo, plus the allocation mechanics. Load when creating queue items
  (queue_add / queue_update) or proposing work for the orchestrator queue.
---

# Queue id series — deriving the prefix

Queue items are identified by Jira-style keys: `PREFIX-<N>` (e.g. `B-21`,
`EVAL-EXPT-10`). `queue_add` ALLOCATES them — omit `key`, pass `series`, and the
harness computes `PREFIX-<max+1>`, guaranteed free. Hand-numbering is what
produced the duplicate-series-number incidents ("multiple B-49 items"): humans
miss the suffixed keys (`B5-NAME`) when eyeballing a counter.

## Deriving the prefix for ANY task

The prefix identifies the **workstream, not the item type**. Decide in order:

1. **Existing items in the target repo win.** If the store already holds items
   with the same `cwd`, reuse the dominant series among them (a
   `queue_list({ includeNotes: true })` scan shows which keys point where).
   Never start a second series for the same workstream — fragmenting the
   counter destroys its meaning (Jira-series values only exist relative to one
   project).
2. **No existing items → derive from the repo/project name**: a short uppercase
   code, 2–8 chars, `A-Z 0-9 - _` (e.g. repo `addrl` → `ADDRL`; repo `atl` →
   `ATL`). Prefer the name a teammate would recognize without a lookup table.
3. **Sub-series for internal structure are allowed** when a workstream has a
   strong internal axis (`EVAL-EXPT` for eval experiments inside a larger
   product repo) — but keep hierarchies shallow (one dash-level, at most).
4. **No workstream affinity at all → omit `series` entirely**: the default `Q`
   series exists precisely for generic items; don't mint a new prefix per task.

## Rules (enforced by `queue_add` — don't restate, rely on them)

- Prefix characters are normalized (`A-Z 0-9 - _`, uppercased); allocated keys
  are plain `PREFIX-<N>`; the counting rule (first number after the prefix)
  makes suffixed keys visible to the counter; series counters are independent.
- **Explicit keys stay allowed** for semantic suffixes (`B21-FINISHER`) or
  milestone letters (`EVAL-EXPT-M3`): the allocator guarantees uniqueness and
  monotonicity, you add the human-readable hint.

## When NOT to follow this

Ad-hoc subagent runs (spawns that never enter the queue) don't get keys at all —
they leave `unmatched-completion` telemetry in the harness log by design. If
work matters enough to track, it matters enough to `queue_add`.
