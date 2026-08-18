# Queue model

The programmatic task queue (`queue.json`) — statuses, transitions, and the tick
behavior. This is the AUTHORITATIVE model; the orchestrator skills reference it.

## Statuses (status = dispatchability)

| Status | Meaning |
|---|---|
| `proposal` | candidate, under discussion (intake output) |
| `approved` | **dispatchable** — a free slot dispatches it |
| `blocked` | approved but waiting — blocker says why (`parked` \| `serialized` \| `merge` \| `decision`) |
| `active` | dispatched — worker running (runId set) |
| `reviewing` | worker done — reviewer in flight (reviewerRunId set) |
| `failed` | run failed (re-dispatchable) |
| `done` | agent-reviewed + handed to the human (re-openable) |
| `rejected` | terminal — deliberately dropped |

There is no separate `ready` boolean — an approved item IS ready to dispatch; a
not-yet-dispatchable approved item is `blocked`. (The `ready` field was folded
into the status; old stores normalize on read: `approved+!ready → blocked`.)

## Transitions

```
proposal  ─► approved │ rejected
approved  ─► blocked │ active │ rejected
blocked   ─► approved (unblock) │ rejected
active    ─► reviewing │ failed        (event-driven: worker completion)
reviewing ─► done │ failed │ active    (active = review-FAIL re-dispatch)
failed    ─► active (recovery re-dispatch) │ done (verified-complete)
done      ─► approved (human re-open: issues found in the user's review)
rejected  ─► (terminal)
```

`active→reviewing/failed` are event-driven (the completion handler flips them —
do not set by hand). `reviewing→active` is the re-dispatch path after a review
FAIL (attempts increment, capped at `reviewCap` = 5).

`done` is NOT a dead end: the human reviews the flagged work and, if issues
are found, re-opens it via `done → approved` (attempts reset — a fresh agent
review loop starts with the human's findings in the re-dispatch task).

## Tick behavior (what the orchestrator is nudged to do)

- **dispatch** — a slot is free AND ≥1 approved item → "dispatch it".
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
- **review** — items stuck in `reviewing` (a reviewer completed) → "read the
  verdict, route each item".
- **blocked** items never trigger ticks (they are waiting by design).
