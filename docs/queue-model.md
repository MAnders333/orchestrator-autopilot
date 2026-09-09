# Queue model

The programmatic task queue (`queue.json`) — statuses, transitions, and the tick
behavior. This is the AUTHORITATIVE model; the orchestrator skills reference it.

## Statuses (status = dispatchability)

| Status | Meaning |
|---|---|
| `proposal` | candidate, under discussion (intake output) |
| `approved` | **dispatchable** — a free slot dispatches it |
| `blocked` | waiting — blocker says why (`parked` \| `serialized` \| `merge` \| `decision`); reached from `approved` or directly from `proposal` (defer without approving) |
| `active` | dispatched — worker running (runId set) |
| `ai-review` | worker done — AI reviewer in flight (reviewerRunId set). This is the **AI review** stage |
| `human-review` | AI review PASSED — **your** approval pending. Not done until you act |
| `failed` | run failed (re-dispatchable) |
| `done` | **human-approved** — you accepted the flagged work (re-openable) |
| `rejected` | terminal — deliberately dropped |

An item is only `done` after the **human** approves it. `ai-review` is the
machine review (run by the harness when autopilot is on, or by the orchestrator
when it is off); `human-review` is the tracked stage where the flagged work sits
awaiting your decision. There is no path from `ai-review` straight to `done`.

There is no separate `ready` boolean — an approved item IS ready to dispatch; a
not-yet-dispatchable approved item is `blocked`. (The `ready` field was folded
into the status; old stores normalize on read: `approved+!ready → blocked`.)

## Transitions

```
proposal  ─► approved │ rejected
approved  ─► blocked │ active │ rejected
proposal  ─► blocked (defer a candidate — parked/serialized/decision; no approval needed)
blocked   ─► approved (unblock) │ rejected
active       ─► ai-review │ failed          (event-driven: worker completion)
ai-review    ─► human-review │ failed │ active   (PASS → human-review; FAIL → active re-dispatch; cap → failed)
human-review ─► done │ active │ rejected         (you approve → done; you find issues → active re-dispatch; you drop → rejected)
failed       ─► active (recovery re-dispatch) │ done (verified-complete)
done         ─► approved (human re-open: issues found after approval)
rejected     ─► (terminal)
```

`active→ai-review/failed` are event-driven (the completion handler flips them —
do not set by hand). `ai-review→active` is the re-dispatch path after a review
FAIL (attempts increment, capped at `reviewCap` = 5). `human-review→active` is
your "this isn't right" path — re-dispatch with your findings.

`done` is reached ONLY through `human-review`: the AI review PASS moves the
item there, the harness auto-flags it for you, and your
`queue_update(key, {status: "done"})` is what actually completes it.
`done` is NOT a dead end: if you later find issues, re-open via `done → approved`
(attempts reset — a fresh agent review loop starts with your findings).

## Tick behavior (what the orchestrator is nudged to do)

- **dispatch** — a slot is free AND ≥1 approved item → "dispatch it". The
  harness AUTO-dispatches fully-specified approved items (scope + cwd +
  low/medium risk — the approval gate guarantees them); the tick fires only
  for the MANUAL cases (high-risk or incomplete).
- **intake** — approved count < `queueLowThreshold` (2) → "run a full intake
  scan, propose the next batch".
  - **Intake suppression**: while ANY proposal is pending (the user is
    deliberating), intake ticks are suppressed — adding proposals changes the
    queue hash but must NOT re-fire the tick. The intake re-arms when the
    proposals resolve (approved/rejected) or the queue changes.
  - The 10-min timer (sweep) also respects the suppression.
  - **Sources are consumer-defined.** The framework owns the NUDGE (buffer low
    → scan) and the QUEUE (proposal → approval); it does not know where work
    comes from. Your orchestrator command defines the intake procedure: which
    ticket trackers, meeting/action-item sources, file diffs, and goals to
    scan, in what order, and how to scope a proposal (title + scope + cwd +
    risk). The contract: scan → propose (`queue_add`, status=proposal) → the
    user approves → the buffer refills. A framework config file for sources
    would be over-engineering — intake is agent judgment + consumer tooling.
- **review** — two stages. (1) **AI review**: items in `ai-review` (reviewer in
  flight) → "read the verdict, route each item". The harness AUTO-dispatches the
  reviewer when a worker completes (same fields: KEY + scope + cwd); verdict
  routing is automatic (PASS → `human-review`, FAIL → re-dispatch, cap →
  failed). (2) **Human review**: items in `human-review` are surfaced as
  *awaiting YOUR approval* — you `queue_update(key, {status: "done"})` to
  accept, `active` to re-dispatch with findings, or `rejected` to drop. On PASS
  the harness auto-flags the item (`flag_for_review`); nothing reaches `done`
  without your call. The orchestrator keeps: approval, high-risk checkpoints,
  `queue_review` overrides, and the `flag_for_review` handover.
- **decision** — a status MOVE applied by a panel decision or by a
  harness-applied flip (e.g. zombie reconciliation): ONE line,
  `[orch-tick: decision] <key> <action>: <from> → <to>` (with a note for the
  annotated cases — `approved: proposal → approved (dispatchable)`,
  `deferred: proposal → blocked (decision)`, `failed: active → failed (zombie)`)
  so the orchestrator never learns of a move by surprise. The tick is generated
  AT APPLICATION TIME from the `orch:human-decision` event data — fresh by
  construction, never a stale snapshot. Non-moves (refine scope edits,
  re-dispatch findings) record words and are events only — no tick.
- **blocked** items never trigger ticks (they are waiting by design).
