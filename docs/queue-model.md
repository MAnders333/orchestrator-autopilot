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
| `failed` | run failed (re-dispatchable). **The FAIL cause is explicit**: every failed item records *why* in `failCause` — `budget-capped` (the worker run was CUT OFF by the item's wall-clock budget `timeoutMs`, mid-task: a cap, not a verdict on the work), `verdict` (the run ended with an unsuccessful verdict/exit — incl. a review FAIL reaching the attempts cap), or `zombie` (the run's completion event was lost). Legacy failures without a recorded cause read as `null`. The cause is cleared on any transition OUT of `failed` — a re-dispatch starts fresh |
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

## Writing the store — one safe mutation path (`mutateStore`)

Every change to `queue.json` goes through `mutateStore(stateDir, apply)`, which
owns load → apply → write. `saveStore` alone is NOT safe: it is atomic per write
(tmp + rename, so a reader never sees a torn file), but a bare
`loadStore → mutate → saveStore` pair has an unguarded read-modify-write window
— a writer that loaded before another's rename erases it, whole-file. That cost
a fully-specified proposal (with an "added" receipt) and handed the same key out
twice, because `nextKeyFor` computes max+1 from the store it can see.

The writers live in different PROCESSES (the pi host, the opencode host, the
tools) and several fire from harness timers, so the guard is cross-process:

- an advisory **lock file** (`queue.json.lock`) around the window, stamped with
  the holder's write identity and published atomically (a private tmp file is
  `link()`ed into place, so a contender never reads a half-created lock and
  mistakes it for an abandoned one). A stale/abandoned/dead-pid lock is BROKEN
  OPEN, never waited on forever: a wedged sweep would be worse than the bug —
  and an *unreadable* lock only counts as abandoned after a short grace, since
  unparsable content is not proof that anybody left;
- an **identified compare-and-swap** as the correctness floor. Every write
  carries a unique nonce (`<pid>@<host>:<random>`) which the store records in
  `revBy` next to `rev`. The mutation refuses to write over a revision newer
  than the one it read, and counts its write as landed only when the re-read
  shows **its own nonce** at `rev + 1` *and* the lock is still its own.
  Identity is load-bearing: `rev` alone is not identifying, so two writers that
  both read revision N both stamp N+1, both see the number they expected, and
  both report success while one write is silently gone. Bounded retries;
  exhaustion THROWS. (`rev` backfills to 0 and `revBy` to null on read, so
  pre-`rev` stores just work.)

That identity is exactly what makes a broken-open lock safe **for the writer
whose window was stolen**: it finds the lock is no longer its own, counts a
conflict, and re-applies against the fresh store instead of handing back a
receipt for a write that did not survive.

The guarantee is **asymmetric**, and the residual belongs to the *thief*: the
victim's pre-write check can pass a moment before the steal, so its rename is
already in flight and may land on top of a write the thief has already made,
verified and reported. The victim re-applies (its own change is never lost), but
the thief's receipt was for a write that is gone. Reaching that needs a steal (5s
of contention, or a stale/dead-pid lock) *plus* that interleaving — where before
the lock+CAS a loss needed nothing but two overlapping writers. Closing it fully
needs a different commit point (an `O_EXCL` rev-marker rename protocol, where the
marker create rather than the store rename decides the winner); that is deferred,
and named here rather than papered over.

Consequences for callers: `apply` may be re-run, so it must be a pure function
of the store it is handed — spawns, git, and other side effects happen before or
after the call, never inside it. Passes that span `await`s (auto-dispatch,
auto-recovery, shipping) stage their patches and merge them onto the current
store at the end. And no tool reports success for a write that did not survive:
`queue_add` re-reads the persisted store before it says `added`.

## The reviewer run ref (`reviewerRunId`) — record it or lose the verdict

`reviewerRunId` is how a reviewer completion is ATTRIBUTED back to its item: the
completion handler matches the finished run against the `ai-review` items
(`itemByReviewerRunId`), parses the `Verdict: PASS/FAIL` line, and auto-routes
(PASS → `human-review` + auto-flag, FAIL → re-dispatch with findings, cap →
`failed`). `queue_review` and the harness's auto-review stamp the ref
themselves.

**If you dispatch a reviewer OUTSIDE `queue_review`** (a raw subagent spawn, a
custom review harness), RECORD the run id immediately:
`queue_update(key, { reviewerRunId: "<run id>" })`. Without it the verdict is
unattributable — the run completes into nothing and the item sits in `ai-review`
until you route it by hand, which is exactly the drift the queue exists to
prevent.

A stale ref no longer wedges the lane. Both review-dispatch paths check whether
the recorded run is genuinely in flight (the backend's run dir + status.json:
`queued`/`running` = alive) before refusing; a dead ref is cleared and the
dispatch proceeds. The check FAILS OPEN — undeterminable liveness dispatches
anyway, because reviewers are read-only (a duplicate costs tokens) while a false
block forces a manual bypass (which breaks the attribution above). Entering
`ai-review` from any other status also clears the previous round's ref; an
`ai-review → ai-review` re-statement does not (it would drop a LIVE reviewer).

## Shipping (the merge-finisher lane) — `done` is NOT the merge

`done` means **human-approved**, nothing more: it unlocks shipping but does NOT
ship by itself. Moving work into a base branch is a SEPARATE post-approval step
— the **merge-finisher lane** (merge to main when the policy says so, one MR per
base branch when a remote exists). Work stays on its worktree branch through the
whole review loop; a recovery re-dispatch re-commits on the branch, never on
main. The ONLY main-branch write the framework ever welcomes is the
merge-finisher's shipping of an item the human already marked `done` (or the
human's own merge).

**The lane is AUTOMATIC, and gated by a PER-REPO SHIPPING POLICY (KEY:
AUTO-SHIP-ON-DONE).** When an item reaches `human-review → done`, the runner's
next reconcile step ships it deterministically with the DECLARED policy — and
NEVER with a guessed one (no fallback: guessing flow/base-branches is the msf
incident root). The policy lives in `autopilot.config.json`:

```json
{
  "shipping": {
    "mergeMode": "auto",              // "auto" (default) | "manual"
    "repos": {
      "<origin-slug-or-basename>": { "flow": "mrs",   "baseBranches": ["dev", "master"] },
      "<other-repo>":              { "flow": "merge", "baseBranches": ["main"] }
    }
  }
}
```

- **Per-repo key**: the repo's origin slug (`owner/repo` or `repo`) or its
  basename — any match resolves the policy. A repo with NO matching entry is
  POLICY-LESS: the shipping run NOTICES, asks the user directly ONE time
  (intercom policy-inquiry: `shipping policy for <repo>? flow, baseBranches`
  + detection-based candidate hints — remote default branch, local/origin
  branch names; branch protection is a named blind spot, setup help only),
  and stays PAUSED. The orchestrator relays the answer and writes it into
  `shipping.repos[<key>]`; the NEXT sweep resolves it and ships. **Nothing
  merges before the policy is set** — a policy-less repo never receives a
  guessed flow/base.
- **`flow: "mrs"`** (a remote exists): one MR per `baseBranch`, in the order
  listed (`["dev","master"]` = two MRs, listed first ships first;
  `["main"]` = one MR). The approved work's tip is pushed to origin for each
  base (never `--force`); the tick reports the MR/create URL when the remote's
  web layout is derivable, else the pushed ref. **`flow: "merge"`** (local /
  no remote): merges the approved work into the LOCAL base branch (default
  `main`).
- **`mergeMode: "manual"`** suppresses the automatic lane: a done item gets ONE
  nudge naming the declared plan and stays YOUR explicit act (batch finishers
  are never silently auto-run). Default is **`auto`**.
- **`shippedAt` marker prevents re-merge**: the shipping step stamps the item
  `shippedAt` (ISO ts) and the lane skips it forever after. A human re-open
  (`done → approved`) clears the marker — the next approval ships again.
- **Skip when nothing new**: a tip already on the base (ancestor) is a
  legitimate no-op — marked shipped, never re-evaluated forever.
- **Conflicts are failures, never forced**: a merge conflict (or a rejected,
  non-fast-forward push) ABORTS the merge, leaves the base untouched, keeps the
  item unshipped (no shippedAt), and escalates once
  (`[orch-tick: ship] SHIPPING FAILED …` + `orch:ship-failed` with
  conflict/reason). Resolution stays on the branch; nothing is force-pushed.
- **Telemetry**: every lane action lands as a `[orch-tick: ship]` tick —
  `merged <key> @ <sha>` / `MR <url>` — plus a domain event
  (`orch:item-shipped`, `orch:shipping-policy-inquiry`, `orch:ship-failed`).
  The policy-inquiry + escalation events ride the shared gate like every
  harness tick.

- **Pre-`done` main writes are flagged, mechanically.** The runner's reconcile
  step records each queue-referenced repo's main HEAD every sweep and compares
  it against the previous step (a one-`git rev-parse` ref check per repo). A
  tracked main ref (`main` / `origin/main`) that moved while ≥1 item
  referencing that repo was NOT human-approved (pre-`done`) emits the
  `orch:main-write-pre-approval` WARNING telemetry event (data: `repo`, `ref`,
  `sha` — what landed, `previousSha`, `keys` — the offending pre-done item
  keys) plus a loud `[orch-tick: main-write]` violation tick. This is
  telemetry, not a block — the orchestrator still verifies who wrote and what
  landed — but guidance alone can lose (the live incident that codified the
  rule), so the guard makes the rule mechanical.
- **Post-`done` main writes are the legitimate lane.** Once every item
  referencing a repo is `done` (or `rejected`), a main write advances the
  guard's recorded baseline silently — the merge-finisher's shipping step is
  exactly the case that must NOT warn.
- **The shipping lane declares its own write (expected-write handshake).** The
  guard runs BEFORE the lane in a sweep, so a flow `merge` ship moves main past
  the baseline the guard just took — and a repo usually still has other
  in-flight items, so the next sweep would flag the lane's own legitimate merge.
  The lane therefore hands the guard the exact sha it produced
  (`recordExpectedMainWrite`) and the baseline advances to that sha only. The
  exemption is narrow by construction: it is refused unless the ref is at that
  sha right now AND the recorded baseline is that sha's first parent (the
  `merge --no-ff` shape), so any other main write still raises the violation.

## Finisher-class dispatches — evidence for work that lands OUTSIDE the worktree

A normal worker writes only inside its isolated worktree, so "did this run
touch any files?" is a fair proxy for "did it do anything?". A **merge
finisher** does not: it lands an approved branch in the TARGET REPO'S CHECKOUT
(its declared `cwd`) and leaves its worktree untouched by design. A runtime
that judges by worktree edits therefore reports the class whose success matters
most as *"returned planning or scratchpad output instead of applying changes"*
— observed live, on a merge that had already landed with a green suite. That is
not only noise: auto-recovery treats `failed` as a re-dispatch candidate, so a
false failure can RE-RUN A MERGE THAT ALREADY LANDED.

For that class the queue's own record is authoritative:

- **The dispatch declares the class AND what it lands**: `queue_dispatch(...,
  dispatchClass: "finisher", finisherSource: "<branch/tag/sha>")` records
  `dispatchClass` + `finisherSource` on the item and captures the declared cwd's
  HEAD *and* that source's commit as `finisherBaseline` (repo, ref, sha, source,
  sourceSha, run). Default is `worker` — nothing about plain workers changes.
- **Success evidence is the declared source LANDING, not file edits and not a
  bare HEAD move**: on completion, a finisher-class run reported unsuccessful is
  checked against the baseline. Evidence requires all of: the baseline belongs to
  THIS run, a source was declared and resolved, HEAD ADVANCED from the baseline
  (baseline is an ancestor of HEAD), and the source is IN the checkout's history
  now but was NOT at dispatch. Then the work LANDED: the item takes the normal
  success path (`active → ai-review`, so the reviewer still verifies the commit),
  the proof is stored as `landedEvidence`
  (repo/ref/fromSha/sha/source/sourceSha/run), and an `[orch-tick: review]` tick
  tells the operator the runtime verdict was overridden. A bare HEAD move is
  deliberately NOT enough: the same checkout is written by the shipping lane's
  `merge --no-ff` for other items, by a second finisher, and by humans.
- **Which landing shapes count — exactly**: "IN the history" means EITHER the
  declared commits are ancestors of HEAD (`merge --no-ff`, fast-forward) OR
  every source commit has a PATCH-EQUIVALENT commit in HEAD's history
  (`git cherry`, i.e. patch-id equality: clean cherry-pick, rebase, squash of a
  single-commit source). Patch equivalence is not optional garnish: finishers in
  this project routinely CHERRY-PICK because the approved branch's base is
  stale, which creates new commits, so an ancestry-only check would evidence
  almost nothing. The recorded evidence names the shape it found
  (`landing: "ancestor" | "patch-equivalent"`).
- **What produces NO evidence — say it out loud**: a **conflict-resolved**
  cherry-pick/rebase (resolving the conflict rewrites the patch, so patch-id
  equality fails; deciding it landed needs content judgment, which is the
  reviewer's call, not a git predicate), a **squash of a multi-commit source**
  (one combined patch matches none of the source patch-ids), and any landing
  that never moves the declared checkout — notably the shipping lane's **`mrs`
  flow**, which pushes the branch and opens an MR, leaving the local HEAD where
  it was. In all of those the runtime's failure verdict STANDS: the operator
  verifies the commit and overrides deliberately with
  `queue_update(..., overrideReason: "…")`. That is the fail-closed side of the
  trade — a check that quietly covered these would be worse than no check.
- **Overrides are RECORDED, not folklore**: every override of a failure verdict
  appends to the item's `overrides[]` (`by: framework` with the evidence, or
  `by: orchestrator` via `queue_update(..., overrideReason: "…")`). A PATTERN of
  overrides is then visible — either the runtime verdict is systematically wrong
  for a class of work, or failures are being waved through.
- **Auto-recovery refuses landed work**: a `failed` item whose work is evidenced
  as landed is never re-dispatched. It is recorded, surfaced ONCE
  (`[orch-tick: recover] … EVIDENCED AS LANDED`), and left for the human's
  close-out call (`failed → done`) — a re-run would duplicate the merge.
- **… and it refuses the WHOLE finisher class, evidence or not** (AUTOPILOT-46):
  the shapes above that produce NO evidence would otherwise fall through as
  ordinary verdict failures and be RE-DISPATCHED after the backoff — automatic,
  unattended, and before the operator could override. Since a finisher re-run is
  the single action that can duplicate a landing, auto-recovery HOLDS every
  `failed` item with `dispatchClass: "finisher"`: it stays `failed`, the hold is
  written to its notes (`[recover-hold: finisher]`) and ticked ONCE
  (`[orch-tick: recover] … is FINISHER-CLASS and failed …`). The cost is real
  and deliberate: a finisher that genuinely failed gets NO automatic retry — it
  is announced and waits for your deliberate re-dispatch. Nothing is dropped
  silently.
- **The real case still fails**: a finisher that did not land its declared
  source has no evidence, so its failure stands — as does one dispatched with no
  `finisherSource` at all (no source → no evidence path, by design).
- **Every run is judged on its own**: entering `active` clears BOTH the previous
  run's `landedEvidence` and its `finisherBaseline`, on the lifecycle edge in
  `updateItem`, so every lane that re-activates an item is covered (queue
  dispatch, harness auto-dispatch, review-FAIL re-dispatch — the recovery lane
  no longer re-activates this class at all, see the hold above). Each of those
  lanes captures a FRESH baseline for the run it spawns, and the landed check
  additionally refuses a baseline whose `runId` is
  not the item's current run — which the item only HAS while it is active: on a
  terminal status `runId` is null, and there the baseline is that item's most
  recent dispatch BY CONSTRUCTION (entering `active` clears it, and only a
  dispatch lane writes one), so there is no foreign baseline to refuse.
  `finisherSource` is sticky (it describes the item's work, not one run) and the override LOG keeps the history.

**Residual on the hold, stated plainly**: the hold covers the RECOVERY lane
(the `failed` lane). The review-FAIL re-dispatch lane is unchanged — an
AI-reviewer `FAIL` on a finisher still flips `ai-review → active` and re-runs
it; that path is a judged verdict on work someone read, not an unattended
timer, and it rebaselines the new run. `dispatchClass` is sticky, so an item
that was once dispatched as a finisher keeps the hold until a dispatch declares
`dispatchClass: "worker"` explicitly.

**Residual, stated plainly**: the evidence proves THE DECLARED SOURCE IS IN the
target's history, not WHO put it there. A human (or another lane) merging the
same branch during the run satisfies it too. The consequence is bounded on
purpose: the item is moved off the failure path and LEFT FOR A HUMAN —
auto-recovery declines to re-dispatch, and nothing closes the item — which is
also the right handling when someone else landed it, because a re-run would
still duplicate the merge. Everything else fails closed (unreadable repo,
unresolvable source, missing/foreign baseline, non-advancing HEAD, a git
question git cannot answer, or a landing shape outside the two above → no
evidence).

**Where this belongs eventually**: the pi runtime has a per-agent
`completionGuard` flag — the right home for "this class of child writes outside
its worktree". Using it needs an agent identity plus a spawn-time selector on
`SubagentBackend.spawn`, and it would only fix the pi host. The queue-side lane
above stays authoritative across hosts; a spawn-time `completionGuard` selector
upstream is the cheaper host-specific complement, not a replacement.

## Worker-time budget governance (timeoutMs)

Every item can carry a requested wall-clock budget (`timeoutMs`, set via
`queue_add`/`queue_update`); null = unset → the runtime default applies. The
budget is delivered to EVERY dispatch lane (manual `queue_dispatch`, auto
`autoDispatchEligible`, review-FAIL `autoRedispatch`, `queue_review`/autoReview)
so the child inherits the requested budget instead of a silent uniform default.
The governance layer makes that budget **visible and recoverable**:

- **`failCause` (store)**: a worker that dies at its budget flips to `failed`
  with `failCause: "budget-capped"` + a `[budget-capped] …` note naming the
  run, the cap, and the re-dispatch-with-bigger-budget path. A run that fails
  with an unsuccessful verdict (or a review FAIL reaching the attempts cap)
  records `failCause: "verdict"` (`[failed: verdict]` note) — the
  failed=cap vs failed=verdict distinction is machine-readable
  (`queue_list` compact rows carry `timeoutMs` + `failCause`) and human-readable.
- **Failure surfacing (tick)**: a failed worker run is never silent — the
  completion handler returns an `[orch-tick: failure]` tick. A budget-capped
  failure says *RE-DISPATCH WITH A BIGGER BUDGET* (`queue_update` `timeoutMs`
  then `queue_dispatch`; the recorded budget rides every lane) instead of
  generic fail-forward; partial work on the `pi-parallel-*` branch must be
  verified first.
- **Budget telemetry (dispatch ticks + panel rows)**: dispatch-tick `facts`
  carry `budget` rows for every active budgeted run (`key`/`cap`/`remaining`/
  `elapsed`/`used`) plus the failed-at-cap recovery keys as `budgetCapped`;
  the message names any run past ~75% of its budget (cap risk). Panel rows
  show the recorded budget and a budget-capped marker. The 10-min timer
  heartbeat adds ONE `[orch-tick: budget]` warning per run once it passes
  ~75% (never a 10-minute nag), so the operator can steer the run to wrap up /
  commit before the cap cuts it off.

Reason vocabulary: ticks arrive as `[orch-tick: <reason>]` — `dispatch` /
`intake` / `review` / `failure` (a run failed; re-dispatch or recover) /
`budget` (an active run is past ~75% of its wall-clock budget) /
`recover` (automatic recovery of a failed item — re-dispatched /
escalated / degraded-window hold; see below) /
`main-write` (a main-branch write landed while an item referencing that repo
was not yet human-approved — a MAIN-IMMUTABILITY violation; SHA + offending
key in the message) /
`ship` (the merge-finisher lane acted — shipped `done` work (merged @ sha /
MR url), a policy-inquiry ask for a policy-less repo, an escalation on a
conflict/non-forced failure, or the manual-mode nudge).

## Tick behavior (what the orchestrator is nudged to do)

- **dispatch** — a slot is free AND ≥1 approved item → "dispatch it". The
  harness AUTO-dispatches fully-specified approved items (scope + cwd +
  low/medium risk — the approval gate guarantees them) on EVERY free-slot
  window: the activation sweep (`/autopilot on`), the turn-end settle sweep,
  the periodic 10-min sweep, and worker completions. The tick fires only for
  the MANUAL cases (high-risk or incomplete) — and then only when the
  harness left something for it.
  - **Delivery-time facts (AUTOPILOT-6)**: the FLEET/QUEUE numbers are
    recomputed from the live store when a tick is DELIVERED, not baked at
    generation — a tick deferred by a busy session (flushed at the next
    settle) can never claim "X free, N ready (…)" for items that are already
    active/running. If the current state no longer warrants the nudge, the
    stale message is dropped (the current intake/dispatch nudge, if any,
    replaces it). Telemetry records each re-derivation as `tick-refresh`
    (timestamped at delivery; the gap from the generation `tick` line is the
    deferral window).
  - **FLEET-vs-inventory parity (AUTOPILOT-6)**: the backend's fleetStatus()
    is the UNION of its RPC fleet count and its in-flight async-run inventory
    scan (pi-subagents' RPC fleet is gated on the caller's session id — a
    workflow parent spawned pre-activation / cross-session / after a runtime
    restart is invisible to it, the observed "FLEET 0/3 while items ran"). The
    union means a tick's FLEET matches `subagent status fleet`, auto-dispatch
    cannot over-spawn into phantom free slots, and zombie reconciliation
    cannot flip a LIVE parent on an undercount-to-0 (a genuine 0 requires the
    RPC AND the inventory to both report idle). Tests isolate the inventory
    scan via AUTOPILOT_PI_ASYNC_ROOT / the backend's asyncDirRoot seam.
  - **A failing fleet RPC DEGRADES, it does not stop the sweep (AUTOPILOT-24)**:
    a `fleetStatus()` that cannot answer is contained — the sweep continues with
    an UNKNOWN fleet, so auto-dispatch and auto-recovery still run off the
    store/ledger inventory and zombie reconciliation is SUSPENDED (unknown is
    passed as `undefined`, never coerced to 0, so an RPC blip can never flip a
    live item to `failed`). "Cannot answer" is BOTH a throw and a `null`
    return: the pi backend's `rpc()` never rejects (a timeout resolves
    `{success:false}` → `fleetStatus()` returns `null`), so null is the failure
    mode that actually happens in production. `null` is also the seam's
    legitimate "this backend has no fleet view", so the two are told apart by
    LEARNED CAPABILITY: null degrades only after the runner has seen that
    backend answer at least once. A backend that never answers stays silent
    (unsupported, not broken); one that stops answering raises exactly once.
    A throw always degrades — the seam spells unsupported as null, never as an
    exception. The degradation is announced with ONE `[orch-tick: harness]`
    tick when the episode starts and ONE when the RPC recovers (`fleet-rpc`
    telemetry records every failing sweep with `mode: threw|null` plus the
    recovery) — never silent, never per-sweep. Every sweep trigger is
    `.catch`-guarded, so a sweep that fails for any other reason is recorded
    (`sweep-failure` telemetry + one tick per failing episode) instead of
    escaping as an unhandled rejection in the host process.
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
- **main-write** — a MAIN-IMMUTABILITY violation: a tracked main ref
  (`main` / `origin/main`) of a queue-referenced repo moved between two
  reconcile steps while ≥1 item referencing that repo was pre-`done` (not
  human-approved). The orchestrator verifies what landed (`git log <sha>`)
  and who wrote it, and keeps recovery on the branch — the only legitimate
  main-write path is the post-approval merge-finisher (see Shipping above).
- **ship** — the merge-finisher lane acted, always informational:
  - `merged <key> @ <sha>` / `MR <url>` — a `done` item shipped via its
    declared policy (the shippedAt marker is set; nothing to do),
  - **policy-inquiry** — `<repo>` has NO shipping policy: RELAY the question
    to the user exactly (`shipping policy for <repo>? flow, baseBranches` +
    the detection hints) and write the one-time answer into
    `autopilot.config.json` `shipping.repos[<key>]`. Nothing ships and
    nothing merges until it is set — never guess,
  - `SHIPPING FAILED <key>` — a merge conflict / rejected push: NEVER forced;
    resolve on the branch; the item stays done-but-unshipped,
  - mergeMode `manual` — the plan is declared; the finisher stays YOUR call.
  > The lane runs on every reconcile step; batch finishers stay explicit
  > under `mergeMode: manual` (auto is the default). Response ≤2 lines.
- **blocked** items never trigger ticks (they are waiting by design).

## Automatic recovery of failed items (AUTO-RECOVER-FAILS)

No failed item sits silent: the harness acts on the `failed` lane itself,
deterministically, by the item's recorded `failCause`, after a short backoff
(default 30s):

- **`budget-capped`** → re-dispatch with a BIGGER budget (`timeoutMs × 1.5`,
  capped at 3h; a cap-less run grows from the observed 30-min runtime default).
- **`verdict` / `zombie`** → ONE recovery re-dispatch carrying the **P5**
  context (check recoverability on the `pi-parallel-<runid>-0` branch BEFORE
  redoing anything; commit early on the branch; never main).
- **`spawn` / infra** (the provider rejected the run at spawn — bare 400 /
  empty api_error) → retry up to **2×** with backoff, then ESCALATE.
- **FINISHER-CLASS items are never re-dispatched by this lane** (AUTOPILOT-46):
  whatever the cause, a `failed` item with `dispatchClass: "finisher"` is HELD
  and escalated once instead — a finisher re-run is the one action that can
  duplicate an already-landed merge, and the landing shapes that leave no
  evidence (conflict-resolved cherry-pick, multi-commit squash) are exactly the
  ones the evidence check cannot skip for you. Re-running one is a deliberate
  human act (`queue_dispatch`). See the finisher-evidence section above.
- **Bounds**: every attempt (including a spawn the provider REJECTED)
  increments the item's `recoveries`; once the per-cause cap (clamped to the
  global `MAX_RECOVERIES` = 2) is spent the item STAYS `failed` and gets a
  one-time escalation tick (`recoveryEscalated` prevents re-nagging).
- **Degraded-window hold**: consecutive provider failures (spawn throws, or a
  hang-then-die zombie pattern) trip a hold — retries and auto-dispatch PAUSE
  and one `[orch-tick: recover] DEGRADED WINDOW …` tick tells the user, instead
  of churning re-dispatches into a dead provider. The hold self-heals: after a
  cooldown the next pass PROBES once; a successful spawn resets the counter.
- **Announcements**: each move is one line —
  `[orch-tick: recover] re-dispatched <key> (attempt N, <cause>, budget <dur>)`
  (or `… exhausted auto-recovery (N attempts, cause) — it STAYS failed …`, or
  `… is FINISHER-CLASS and failed … will NOT re-dispatch it …`).
- **Recovered items carry their branch** (AUTO-SHIP-ON-DONE): the re-dispatch
  preserves the new run's parallel-branch tip exactly like every other lane,
  and the item still flows `active → ai-review → human-review`. Recovery NEVER
  short-circuits the approval gate and NEVER touches main — shipping remains
  the post-`done` merge-finisher lane.

Recovery bookkeeping lives on the item (`recoveries`, `recoveryNotBefore`,
`recoveryEscalated`); provider health lives in `recovery-state.json`
(`providerFailures`, cooldown). Neither is operator-editable — the harness
owns them, like `attempts`/`failCause`.

## Startup/activation state-dir probe (AUTOPILOT-3)

Before the harness relies on the resolved state dir, the extension verifies it
at activation (`/autopilot on` / the opencode autopilot tool) and at session
start (pi host):

- the resolved state dir **exists** and contains **`queue.json`** (the store) —
  otherwise every read is a phantom/empty queue;
- **`autopilot.config.json`** exists *when workspace facts are promised* (the
  orchestrate command's `Workspace facts` block) — a promised-but-missing
  config makes the workspace facts unreadable;
- **host parity**: the extension's resolved dir (env → command `STATE_DIR` →
  profile fallback) must match the `STATE_DIR` line of the orchestrate.md
  projection the orchestrator reads. A mismatch (env override / fallback vs a
  stale or missing projection) is reported as a hard warning.

Findings are **one telemetry line** (`state-dir-probe` in `autopilot.jsonl`)
plus **one notify** — never a throw, never a block (fail-open: a spurious
warning costs a notify; silently operating on the wrong/empty queue compounds).
Both hosts *continue the activation* after reporting: pi notifies and still runs
the sweep; the opencode host prepends the findings to the tool's ON message and
still arms/cancels the schedule and runs the sweep.
The probe exists to make future drift loud at activation instead of silent.

## Provisional-linger surface

A cwd-less proposal gets a **provisional `Q-<n>` handle** (the default series);
its key is renamed into the repo's real series only at approval. A provisional
stuck in `proposal` past `provisionalLingerDays` (default **3**, set in
`autopilot.config.json`) looks like a real series key and gets mistaken for
one. The decision panel tags such items (`⚠ provisional Nd`) and raises the
count in the section header, and `/autopilot status` names them — resolve or
reject them so no one mistakes a provisional handle for dispatched work.

## Spec-completeness surface (advisory — it never blocks)

`approvalReady(scope, cwd)` is a PRESENCE check by design: non-empty scope +
cwd. `specCompleteness(item)` (`src/framework/spec-completeness.ts`) answers
the different question — *what is missing from this scope?* — with a bounded
list of missing elements: `no-scope`, `no-cwd`, `no-artifact` (no path,
`file:line` or symbol named), `no-acceptance` (no test/verify/assert-style
statement of how we know it worked), `thin-scope` (under 120 characters). No
score, no percentage, no model call: every check is a regex or a length
compare, so the output is predictable by reading the function.

The result is surfaced exactly like the provisional-linger tag — per item in
both panel renderers (`⚠ NEEDS SPEC: no scope` / `⚠ thin spec: …`), as a count
in the proposals section header, and named in `/autopilot status` (one helper,
`underSpecifiedProposals`, feeds both, so the counts cannot drift).

**It is ADVISORY and stays advisory.** Nothing here is wired into the approval
gate: a tagged proposal approves exactly like an untagged one, because a queue
whose approvals are expensive stops being used. The one-keystroke fix is the
other half: refining a proposal whose scope is EMPTY opens the editor prefilled
with the scope template skeleton (`SCOPE_SKELETON`) instead of a blank buffer;
the field keeps its select-all semantics, so typing replaces the skeleton. The
template PROCEDURE (what belongs under each heading, and that it is required at
approval but optional at capture time) lives in `prompts/orchestrate.md` and
`skills/orchestrator-operations/SKILL.md`.
