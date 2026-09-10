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
  (or `… exhausted auto-recovery (N attempts, cause) — it STAYS failed …`).
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
