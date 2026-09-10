// tools/queue-ops.ts — the SIX queue tools as host-agnostic operations.
// Both hosts (the pi extension and the opencode plugin) register these tools;
// the logic lives here ONCE (single authoritative implementation — no dead
// copies between hosts). Hosts adapt the result shape: pi wraps
// { text, details } into its tool-result envelope, opencode returns the text.
//
// These are deterministic store+backend operations; all LLM judgment stays in
// the orchestrator (the tool CALLER), per the framework's trigger-only rule.

import type { SubagentBackend } from "../backends/types.ts";
import type { Autopilot } from "../core.ts";
import type { LoadedAutopilotConfig } from "../config.ts";
import { loadStore, newStore, mutateStore, addItem, updateItem, queryItems, queueLengths, resolveSeries, recordSeries, isDispatchClass, type DispatchClass, type QueueStore } from "../queue-store.ts";
import { appendOverride, captureFinisherBaseline } from "../finisher-evidence.ts";
import { effectiveOccupiedSlots, isAutoDispatchable } from "../framework/auto-dispatch.ts";
import { assessRequestedBudget, budgetCeilingWarning } from "../framework/run-budget.ts";
import { reviewerRunAlive } from "../framework/run-liveness.ts";
import { formatDurationMs } from "../duration.ts";
import { preserveRunWorktree } from "../framework/worktree-preservation.ts";

export interface ToolResult {
  text: string;
  details: Record<string, unknown>;
}

/** Host adapter seam — the pi extension and opencode plugin both satisfy this. */
export interface QueueOpsCtx {
  stateDir: string;
  backend: SubagentBackend;
  storeOrNew(): QueueStore;
  autopilot(): Autopilot;
  cfg(): LoadedAutopilotConfig;
  /** Domain-event sink (orch:reviewer-dispatched, ...) — host-local bus. */
  emit(events: Array<{ name: string; data?: Record<string, unknown> }>): void;
  /** Fail-closed repo check for dispatch cwd (git toplevel + dirty tree). */
  repoCheck(cwd: string): Promise<{ ok: boolean; reason?: string; files?: number }>;
  /** The host session's cwd (dispatch falls back to it when no explicit cwd). */
  sessionCwd?: string;
}

function err(e: unknown, op: string): ToolResult {
  return { text: `${op} failed: ${e instanceof Error ? e.message : String(e)}`, details: {} };
}

/** Validate a requested wall-clock budget: a positive finite number, else null.
 *  null = "not requested" — the runtime default budget stays authoritative. */
export function normalizeTimeoutMs(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? v : null;
}

/** queue_list — read path (filter by status / since / sort, compact or notes). */
export async function queueList(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const store = ctx.storeOrNew();
    const items = queryItems(store, {
      status: params.status as never,
      since: params.since as string | undefined,
      sort: params.sort as never,
      limit: params.limit as number | undefined,
      includeNotes: params.includeNotes as boolean | undefined,
    });
    const counts = queueLengths(store);
    const backendFleet = await ctx.backend.fleetStatus();
    const fleet = {
      occupied: ctx.autopilot().status().running,
      totalActive: backendFleet?.totalActive ?? null,
      maxSlots: ctx.cfg().maxSlots,
    };
    return { text: JSON.stringify({ counts, fleet, items }, null, 2), details: {} };
  } catch (e) {
    return err(e, "queue_list");
  }
}

/** The approval contract: an item is APPROVED only when it is fully
 *  specified — a non-empty scope (the worker/reviewer prompt lives there) and
 *  a cwd (the repo the work lands in). Enforced here so the approval-time
 *  requirement is real, not skill guidance. Blocked items are exempt (they are
 *  waiting by design, not dispatchable). */
export function approvalReady(scope: string | null | undefined, cwd: string | null | undefined): boolean {
  return Boolean((scope ?? "").trim() && cwd);
}

/** queue_add — new proposal (default) or approved item; free-form notes. */
/** Jira-style sequential allocation: the next free `PREFIX-N` for a series.
 *  N = max existing N + 1. The number is the FIRST number after the prefix
 *  (and an optional separator), so every real convention counts:
 *  `B5-NAME` → 5, `B-4` → 4, `EVAL-EXPT-M9` → 9, `B20-REMAINING` → 20 — the
 *  hand-allocated era produced duplicates ("multiple B-49 items") exactly
 *  because suffixed keys were invisible to eyeball counting. Guaranteed free:
 *  bumps until the key is unclaimed. */
export function nextKeyFor(store: QueueStore, prefix: string): string {
  const clean = prefix.replace(/[^A-Za-z0-9_-]/g, "");
  const re = new RegExp(`^${clean}(?:-|_)?(.+)$`);
  let max = 0;
  for (const k of Object.keys(store.items)) {
    const m = re.exec(k);
    if (!m) continue;
    const num = /\d+/.exec(m[1]);
    if (num) max = Math.max(max, Number(num[0]));
  }
  let n = max + 1;
  while (store.items[`${clean}-${n}`]) n += 1;
  return `${clean}-${n}`;
}

export async function queueAdd(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    // Key allocation: explicit key (unique, semantic suffixes welcome) OR a
    // series ("B") → Jira-style auto-allocated B-<n>. Omitting both allocates
    // under the default series "Q" — keys are load-bearing identifiers
    // (telemetry, handoffs, steering), so the harness must hand them out
    // collision-free instead of trusting hand-numbering.
    let key = (params.key as string | undefined)?.trim();
    // Series resolution: explicit `series` is a DELIBERATE choice (new
    // workstream / re-association). Otherwise the framework derives from the
    // item's cwd (registry → history → repo-name slug) — the agent's only job
    // is to not fight it. Without a cwd (proposal stage) there is nothing to
    // derive from: allocate PROVISIONALLY in the default Q series; the key is
    // renamed into the repo's real series at the approved transition (where
    // cwd becomes mandatory).
    const cwd = (params.cwd as string | null) ?? null;
    const explicitSeries = ((params.series as string | undefined) ?? "").replace(/[^A-Za-z0-9_-]/g, "").toUpperCase();
    // Provisional = we had NEITHER an explicit series NOR a cwd to derive one
    // from — the Q handle is a placeholder that the approved transition renames.
    const provisional = !key && !explicitSeries && !cwd;
    const series = explicitSeries || (cwd ? resolveSeries(ctx.stateDir, cwd) : "Q");
    const status: "approved" | "proposal" = params.status === "approved" ? "approved" : "proposal";
    const scope = (params.scope as string) ?? "";
    if (status === "approved" && !approvalReady(scope, cwd)) {
      return { text: "queue_add: approval requires a complete scope + cwd (the scope is the worker prompt; cwd is the repo it runs in) — add as proposal or supply both", details: {} };
    }
    // ALLOCATE AND INSERT IN ONE MUTATION. nextKeyFor computes max+1 from the
    // store it can see, so allocating in a separate read-modify-write cycle is
    // how the same key gets handed out twice (observed live: AUTOPILOT-28).
    // Inside mutateStore the store it sees IS the store the insert lands in.
    const explicitKey = key;
    const outcome = mutateStore(ctx.stateDir, (store) => {
      const allocated = explicitKey || nextKeyFor(store, series);
      if (store.items[allocated]) return { taken: true, key: allocated };
      addItem(store, {
        key: allocated,
        status,
        blocker: null,
        title: params.title as string,
        scope,
        cwd,
        evidence: (params.evidence as string) ?? "",
        value: (params.value as string) ?? "",
        urgency: (params.urgency as string) ?? "",
        risk: (params.risk as string) ?? "",
        runId: null,
        reviewerRunId: null,
        timeoutMs: normalizeTimeoutMs(params.timeoutMs),
        attempts: 0,
        notes: (params.notes as string) ?? "",
        ...(provisional ? { provisionalKey: true } : {}),
      });
      return { taken: false, key: allocated };
    });
    if (outcome.taken) return { text: `queue_add: key '${outcome.key}' already exists — use queue_update, or omit key to auto-allocate the next number in a series`, details: {} };
    key = outcome.key;
    if (cwd) recordSeries(ctx.stateDir, cwd, series);
    // NO FALSE SUCCESS: the receipt is only issued for an item that is ACTUALLY
    // in the persisted store. mutateStore already aborts loudly on a conflict;
    // this re-read is the belt on those braces, because "added '<key>'" for an
    // item that never existed is what made the live loss invisible.
    if (!loadStore(ctx.stateDir)?.items[key]) {
      return { text: `queue_add: '${key}' did NOT survive the write (concurrent writer) — NOT added, retry`, details: {} };
    }
    // Provisional keys are ALWAYS called out in the tool text: a repo-less
    // proposal gets a Q-<n> handle by necessity (nothing to derive a series
    // from), but the caller must know it is temporary — approval with a cwd
    // RENAMES it into the repo's real series (registry → history → slug).
    const provisionalNote = provisional
      ? ` — NOTE: '${key}' is a PROVISIONAL handle (no cwd — repo-less proposal). At approval, where cwd becomes mandatory, the key is RENAMED into the repo's real series (registry → history → slug). Pass cwd (git rev-parse --show-toplevel of the target repo) to queue_add to get a stable real-series key now.`
      : "";
    return { text: `added '${key}' (${status})${provisionalNote}`, details: {} };
  } catch (e) {
    return err(e, "queue_add");
  }
}

/** PROVISIONAL-KEY RENAME — the ONE implementation, shared by queue_update
 *  (approval via tool) and the decision panel (approve in the UI). Call when
 *  the item is ALREADY approved in `store` and carries a cwd. Resolves the
 *  real series EXCLUDING the item's own vote (a freshly-specified provisional
 *  Q handle would otherwise win updatedAt ties against its repo's history),
 *  records cwd → series for future adds, renames the key when its series
 *  differs, and drops the provisional marker. Returns the new key, or null
 *  when the key already sits in the right series (marker cleared in place).
 *  The caller persists the store. */
export function renameProvisionalKey(stateDir: string, store: QueueStore, key: string): string | null {
  const updated = store.items[key];
  if (!updated || updated.provisionalKey !== true || !updated.cwd) return null;
  const realSeries = resolveSeries(stateDir, updated.cwd, { excludeKey: key });
  recordSeries(stateDir, updated.cwd, realSeries);
  const currentSeries = /^([A-Za-z0-9_-]+?)-\d+/.exec(updated.key)?.[1] ?? "";
  if (currentSeries === realSeries) {
    updated.provisionalKey = undefined; // already in the real series — the marker is just dropped
    return null;
  }
  const newKey = nextKeyFor(store, realSeries);
  const renameNote = `(renamed from ${updated.key} at approval — provisional handle → real series ${realSeries})`;
  store.items[newKey] = {
    ...updated,
    key: newKey,
    provisionalKey: undefined,
    notes: updated.notes ? `${updated.notes}\n\n${renameNote}` : renameNote,
  };
  delete store.items[updated.key];
  return newKey;
}

/** queue_update — validated transitions, blocker, free-form fields. */
export async function queueUpdate(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const key = params.key as string;
    // The read (existence + approval gate), the patch, and the provisional-key
    // rename are ONE mutation: validating against a store snapshot and writing
    // a different one is the read-modify-write window this fix closes.
    const outcome = mutateStore(ctx.stateDir, (store) => {
      const cur = store.items[key];
      if (!cur) return { kind: "missing" as const, renamedTo: null };
      const nextStatus = (params.status as string | undefined) ?? cur.status;
      const nextScope = (params.scope as string | undefined) ?? cur.scope;
      const nextCwd = (params.cwd as string | null | undefined) ?? cur.cwd;
      if (nextStatus === "approved" && !approvalReady(nextScope, nextCwd)) return { kind: "unready" as const, renamedTo: null };
      // An approval may complete a PROVISIONAL key: run the shared rename AFTER
      // the patch (resolveSeries excludes the item's own vote, so the rename
      // cannot resolve to its own provisional Q).
      const renamingProvisional = cur.provisionalKey === true && nextStatus === "approved" && !!nextCwd;
      // FAILURE-OVERRIDE RECORD (AUTOPILOT-34): overriding a run's failure
      // verdict used to be hand-written prose in `notes`, so a PATTERN of
      // overrides was invisible. `overrideReason` records it on the item as
      // structured, append-only history (and still writes the human line).
      const overrideReason = typeof params.overrideReason === "string" ? params.overrideReason.trim() : "";
      const override = overrideReason
        ? {
            at: new Date().toISOString(),
            by: "orchestrator" as const,
            runId: cur.runId,
            reason: overrideReason,
            evidence: cur.landedEvidence ?? null,
          }
        : null;
      const overrideNote = override
        ? `[override] ${override.at} — the run's failure verdict was OVERRIDDEN by the orchestrator: ${override.reason}`
        : "";
      const patchedNotes = params.notes as string | undefined;
      updateItem(store, key, {
        status: params.status as never,
        blocker: params.blocker as never,
        title: params.title as string | undefined,
        scope: params.scope as string | undefined,
        cwd: params.cwd as string | null | undefined,
        evidence: params.evidence as string | undefined,
        value: params.value as string | undefined,
        urgency: params.urgency as string | undefined,
        risk: params.risk as string | undefined,
        // Explicit param wins; absent param leaves the recorded budget alone.
        ...(params.timeoutMs !== undefined ? { timeoutMs: normalizeTimeoutMs(params.timeoutMs) } : {}),
        ...(isDispatchClass(params.dispatchClass) ? { dispatchClass: params.dispatchClass } : {}),
        // WHAT a finisher lands (branch/tag/sha) is item state, not per-run
        // state: the harness lanes re-dispatch without dispatch params and
        // read it from here.
        ...(typeof params.finisherSource === "string" ? { finisherSource: params.finisherSource.trim() || null } : {}),
        ...(override ? { overrides: appendOverride(cur, override) } : {}),
        notes: override
          ? [patchedNotes ?? cur.notes, overrideNote].filter(Boolean).join("\n\n")
          : patchedNotes,
      });
      return {
        kind: "updated" as const,
        renamedTo: renamingProvisional ? renameProvisionalKey(ctx.stateDir, store, key) : null,
        // the provisional-key rename above may have moved the item to a new key
        overrides: override ? (store.items[key]?.overrides?.length ?? 1) : 0,
      };
    });
    if (outcome.kind === "missing") return { text: `queue_update: no item '${key}'`, details: {} };
    const overrideNote =
      outcome.kind === "updated" && outcome.overrides > 0
        ? ` — failure-verdict OVERRIDE recorded on the item (${outcome.overrides} total; a pattern of overrides means the runtime verdict is systematically wrong for this class of work — or that failures are being waved through)`
        : "";
    if (outcome.kind === "unready") {
      return { text: "queue_update: approval requires a complete scope + cwd (the scope is the worker prompt; cwd is the repo it runs in) — blocked items are for waiting, not dispatchable work", details: {} };
    }
    if (outcome.renamedTo) {
      const series = /^([A-Za-z0-9_-]+?)-\d+/.exec(outcome.renamedTo)?.[1] ?? outcome.renamedTo;
      return { text: `updated '${key}' → approved; provisional key renamed to '${outcome.renamedTo}' (series ${series})`, details: { renamedFrom: key, key: outcome.renamedTo } };
    }
    return { text: `updated '${key}'${overrideNote}`, details: {} };
  } catch (e) {
    return err(e, "queue_update");
  }
}

/** CAPACITY GATE for the manual lane (KEY: AUTOPILOT-48).
 *  The harness lane has always honoured maxSlots (auto-dispatch's freeSlots);
 *  `queue_dispatch` — the lane MOST work actually runs through — consulted it
 *  nowhere: a live queue_list read occupied 11 / totalActive 5 against
 *  maxSlots 3 with nothing refusing, and ~8 concurrent workers had already
 *  produced provider-level failures that day. So the cap BINDS here too:
 *  refuse at/above capacity, and name the one-parameter override in the same
 *  breath. Warn-and-proceed was rejected — the failure this item exists for is
 *  an orchestrator acting on capacity facts it did not re-read, and a warning
 *  it can ignore reproduces exactly that. Leaving it unconstrained keeps the
 *  cap decorative in the lane that matters. The override keeps the deliberate
 *  path the orchestrator relies on when it knows better than the harness, so
 *  no work is stranded — it just becomes a decision instead of an accident. */
function capacityRefusal(occupied: number, maxSlots: number): string {
  return (
    `queue_dispatch: AT CAPACITY — ${occupied} of ${maxSlots} worker slots occupied, nothing dispatched. ` +
    `Over-subscription is not free (concurrent-worker pileups have caused provider-level failures). ` +
    `Deliberate override: re-call with overrideCapacity: true (the dispatch proceeds and is marked as over-capacity). ` +
    `Or raise the cap for everyone: /autopilot capacity <n>. Or wait for a slot — a completion frees one and the harness re-dispatches.`
  );
}

/** queue_dispatch — spawn the worker (worktree isolation, fail-closed repo
 *  check) AND record approved→active + runId atomically. Refuses above the
 *  fleet cap unless overrideCapacity is passed (see capacityRefusal). */
export async function queueDispatch(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const store = ctx.storeOrNew();
    const key = params.key as string;
    const item = store.items[key];
    if (!item) return { text: `queue_dispatch: no item '${key}'`, details: {} };
    if (item.status === "approved") {
      // approved = dispatchable (the fold); a blocked item is NOT approved
    } else if (item.status !== "ai-review" && item.status !== "failed") {
      return { text: `queue_dispatch: '${key}' is ${item.status}, not dispatchable`, details: {} };
    }
    // CAPACITY GATE — before the repo check and the spawn, so a refusal costs
    // nothing. The item being dispatched is approved/ai-review/failed (never
    // `active`), so it is not itself part of the occupied count.
    const overrideCapacity = params.overrideCapacity === true;
    const maxSlots = ctx.cfg().maxSlots;
    let fleetTotalActive: number | null = null;
    try {
      // A failing/absent fleet view is UNKNOWN, never a fake 0 — the store and
      // the engine ledger still bind the count below.
      fleetTotalActive = (await ctx.backend.fleetStatus())?.totalActive ?? null;
    } catch {
      fleetTotalActive = null;
    }
    const occupied = effectiveOccupiedSlots(ctx.stateDir, {
      ledgerRunning: ctx.autopilot().status().running,
      fleetTotalActive,
    });
    // An unreadable/absent cap FAILS OPEN: a missing config must never strand a
    // dispatch (the harness lane treats it the same way — a default, not a stop).
    const capBinds = Number.isFinite(maxSlots) && maxSlots >= 1;
    if (capBinds && occupied >= maxSlots && !overrideCapacity) {
      return { text: capacityRefusal(occupied, maxSlots), details: { occupied, maxSlots, refused: "capacity" } };
    }
    const overCapacityNote =
      capBinds && occupied >= maxSlots
        ? ` WARNING: dispatched ABOVE capacity by explicit override (${occupied + 1} running vs maxSlots ${maxSlots}) — deliberate over-subscription; concurrent-worker pileups have caused provider-level failures. Raise the cap (/autopilot capacity <n>) if this is the new normal.`
        : "";
    const cwd = (params.cwd as string | undefined) ?? ctx.sessionCwd ?? process.cwd();
    const check = await ctx.repoCheck(cwd);
    if (!check.ok) {
      return { text: `queue_dispatch: ${check.reason}`, details: { cwd, ...(check.files ? { dirty: check.files } : {}) } };
    }
    // TIMEOUT PLUMBING: an explicit param wins; otherwise the item's recorded
    // budget is delivered to EVERY lane's spawn (the historical gap: harness
    // dispatch/re-dispatch/review dropped the request and children ran at the
    // runtime default). A manually supplied budget is persisted so re-dispatch
    // and review inherit it too. Unset → undefined passthrough (runtime default).
    const requestedTimeout = normalizeTimeoutMs(params.timeoutMs);
    const timeoutMs = requestedTimeout ?? item.timeoutMs ?? undefined;
    // FINISHER-EVIDENCE (AUTOPILOT-34): a dispatch may DECLARE that it writes
    // OUTSIDE its worktree — a merge finisher lands an approved branch in the
    // TARGET REPO'S CHECKOUT (`cwd`) and leaves its worktree untouched by
    // design. Record the class + the cwd's HEAD + the SOURCE it must land as
    // the dispatch BASELINE, so the completion path can judge that run on THAT
    // SOURCE LANDING instead of on the runtime's "no worktree edits" signal
    // (which always misreads this class).
    const dispatchClass: DispatchClass = isDispatchClass(params.dispatchClass)
      ? params.dispatchClass
      : item.dispatchClass === "finisher"
        ? "finisher"
        : "worker";
    // WHAT this finisher lands. An explicit param wins; otherwise the item's
    // recorded source rides along (the harness re-dispatch lanes have no
    // params). With no resolvable source there is NO landed evidence and the
    // runtime's verdict stands unchanged — the dispatch says so out loud.
    const finisherSource =
      dispatchClass === "finisher"
        ? (typeof params.finisherSource === "string" && params.finisherSource.trim()
            ? params.finisherSource.trim()
            : (item.finisherSource ?? null))
        : null;
    const finisherBaseline = dispatchClass === "finisher" ? captureFinisherBaseline(cwd, null, finisherSource) : null;
    // BUDGET REALITY (AUTOPILOT-47): the runtime silently truncates any budget
    // above its per-step ceiling. Assess BEFORE the spawn so the receipt says
    // what this run will actually get — a silently halved budget is what made
    // the operator plan two hours of work into a 30-minute run.
    const budget = assessRequestedBudget(timeoutMs);
    const budgetNote = budgetCeilingWarning(budget, formatDurationMs);
    const runId = await ctx.backend.spawn(params.task as string, { cwd, timeoutMs });
    if (!runId) return { text: "queue_dispatch: spawned but no run id returned", details: {} };
    // The spawn happens OUTSIDE the mutation (mutateStore may re-run its apply
    // on a conflict; a spawn must happen exactly once). The store change that
    // records the run goes through the safe path.
    mutateStore(ctx.stateDir, (s) => {
      if (s.items[key]) {
        updateItem(s, key, {
          status: "active",
          runId,
          ...(requestedTimeout ? { timeoutMs: requestedTimeout } : {}),
          dispatchClass,
          ...(dispatchClass === "finisher" ? { finisherSource } : {}),
          ...(finisherBaseline ? { finisherBaseline: { ...finisherBaseline, runId } } : {}),
        });
      }
    });
    try {
      // Worktree handoff preservation starts AT DISPATCH: journal + keep-ref
      // the parallel branch from its first commit onward (sweeps continue it).
      preserveRunWorktree({ stateDir: ctx.stateDir, repo: cwd, runId, key });
    } catch {
      // preservation never breaks dispatch
    }
    ctx.autopilot().handleAsyncStarted(runId, "worker"); // fleet ledger
    // Double-dispatch guard: an APPROVED item that the harness would
    // auto-dispatch (scope + cwd + low/med risk) should rarely be dispatched
    // manually — the harness fills free slots itself. The dispatch proceeds
    // (the override path is legitimate), but the risk is surfaced.
    const autoNote = item.status === "approved" && isAutoDispatchable(item)
      ? " WARNING: auto-dispatchable (approved + scope + cwd + low/med) — the harness will dispatch this itself when a slot frees; manual dispatch risks a duplicate worker. Override ok, but only if you mean it."
      : "";
    const finisherNote =
      dispatchClass === "finisher"
        ? finisherBaseline?.sourceSha
          ? ` FINISHER-CLASS: this dispatch writes into ${cwd} (not its worktree); success is judged on '${finisherSource}' (${finisherBaseline.sourceSha.slice(0, 8)}) entering that checkout's history from baseline ${finisherBaseline.sha ? finisherBaseline.sha.slice(0, 8) : "unreadable"} — EITHER as the declared commits (merge/fast-forward) OR as patch-equivalent copies (clean cherry-pick/rebase/squash of a single-commit source), so a runtime 'no edits' verdict is overridden (and recorded) when the work lands in one of those shapes. NOT DETECTED, so the failure stands and closing the item is your deliberate call (queue_update overrideReason): a CONFLICT-RESOLVED cherry-pick (resolving the conflict rewrites the patch), a squash of a MULTI-commit source, and any landing that never moves this checkout — notably shipping flow 'mrs', which only pushes the branch and opens an MR.`
          : ` FINISHER-CLASS: this dispatch writes into ${cwd} (not its worktree), but ${finisherSource ? `the declared source '${finisherSource}' does not resolve to a commit there` : "NO source branch/sha was declared (finisherSource)"} — LANDED EVIDENCE IS OFF for this run, so a runtime 'no edits in the worktree' verdict will fail it as usual. Re-dispatch with finisherSource=<branch/sha it must land> to get the evidence path.`
        : "";
    return {
      text: `dispatched '${key}' — run ${runId}.${budgetNote}${overCapacityNote}${autoNote}${finisherNote}`,
      details: {
        runId,
        dispatchClass,
        occupied: occupied + 1,
        maxSlots,
        ...(overCapacityNote ? { overCapacity: true } : {}),
        ...(budget.truncated ? { budgetTruncated: true, requestedTimeoutMs: budget.requestedMs, effectiveTimeoutMs: budget.effectiveMs } : {}),
      },
    };
  } catch (e) {
    return err(e, "queue_dispatch");
  }
}

/** queue_review — spawn the reviewer (read-only, no worktree) for a reviewing
 *  item; the verdict contract is injected when no task is supplied. */
export async function queueReview(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const store = ctx.storeOrNew();
    const key = params.key as string;
    const item = store.items[key];
    if (!item) return { text: `queue_review: no item '${key}'`, details: {} };
    if (item.status !== "ai-review") {
      return { text: `queue_review: '${key}' is ${item.status}, not reviewing`, details: {} };
    }
    // STALE-REF GUARD: refuse only for a reviewer that is genuinely in flight.
    // A dead reviewer's id used to block this item forever (crash, stop, engine
    // restart, lost completion) — the liveness check clears it and proceeds.
    // reviewerRunAlive FAILS OPEN (see run-liveness.ts): undeterminable → not
    // alive → dispatch. A duplicate read-only reviewer costs tokens; a false
    // block costs a manual bypass, which breaks verdict attribution.
    let clearedStaleReviewerRunId: string | null = null;
    if (item.reviewerRunId) {
      if (reviewerRunAlive(ctx.backend, item.reviewerRunId)) {
        return { text: `queue_review: a reviewer is ALREADY running for '${key}' (run ${item.reviewerRunId.slice(0, 8)}…) — steer it or wait for its completion`, details: {} };
      }
      clearedStaleReviewerRunId = item.reviewerRunId;
      // de-stale durably, even if the spawn below fails
      mutateStore(ctx.stateDir, (s) => {
        if (s.items[key]) updateItem(s, key, { reviewerRunId: null });
      });
    }
    const task = (params.task as string | undefined)?.trim()
      ? (params.task as string)
      : "Review the completed work for correctness, approach quality, and completeness. Read the work product yourself (the diff/files), do NOT trust the worker's summary.\n\n" +
        "The FIRST line of your response MUST be exactly `Verdict: PASS` or `Verdict: FAIL`. If FAIL, list each finding as an actionable item.";
    const agentName = ctx.cfg().reviewerAgents[0] ?? "orchestrator-reviewer";
    const runId = await ctx.backend.spawn(task, {
      agent: agentName,
      worktree: false, // reviewers are read-only — no worktree
      cwd: item.cwd ?? undefined, // the work repo — the reviewer locates the product there
      timeoutMs: normalizeTimeoutMs(params.timeoutMs) ?? item.timeoutMs ?? undefined,
    });
    if (!runId) return { text: "queue_review: spawned but no run id returned", details: {} };
    mutateStore(ctx.stateDir, (s) => {
      if (s.items[key]) updateItem(s, key, { reviewerRunId: runId });
    });
    ctx.emit([{ name: "orch:reviewer-dispatched", data: { key, reviewerRunId: runId } }]);
    const staleNote = clearedStaleReviewerRunId
      ? ` (cleared a STALE reviewer ref ${clearedStaleReviewerRunId.slice(0, 8)}… — that run is gone/terminal)`
      : "";
    return { text: `reviewer dispatched for '${key}' — run ${runId}${staleNote}`, details: { runId, ...(clearedStaleReviewerRunId ? { clearedStaleReviewerRunId } : {}) } };
  } catch (e) {
    return err(e, "queue_review");
  }
}

/** queue_steer — steer a running worker/reviewer; the backend verifies
 *  delivery (headless children are honestly refused). */
export async function queueSteer(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const store = ctx.storeOrNew();
    const key = params.key as string;
    const item = store.items[key];
    if (!item) return { text: `queue_steer: no item '${key}'`, details: {} };
    const runId = item.status === "active" ? item.runId : item.status === "ai-review" ? item.reviewerRunId : null;
    if (!runId) {
      return { text: `queue_steer: '${key}' has no running run (status ${item.status}) — only active workers / ai-review reviewers are steerable`, details: {} };
    }
    const mode = params.mode === "follow_up" ? "follow_up" : "steer";
    const { id, ack } = await ctx.backend.steer(runId, params.message as string, mode, params.ackTimeoutMs as number | undefined);
    // HONEST uptake semantics: the ack certifies TRANSPORT acceptance only.
    // "delivered" = injected into the running turn. "queued" = waiting for
    // the child's NEXT turn boundary — a run that ends first never consumes
    // it (observed live: steering a reviewer that was seconds from finishing;
    // the queued message could not retroactively change its verdict). The
    // caller must know which one happened so it can verify uptake instead of
    // trusting the acknowledgment.
    const text = ack === "delivered"
      ? `steered '${key}' (run ${runId.slice(0, 8)}…, request ${id}) — ${mode} DELIVERED into the running turn (ack: delivered)`
      : `steered '${key}' (run ${runId.slice(0, 8)}…, request ${id}) — ${mode} QUEUED at the child's next turn boundary (ack: queued). CAVEAT: if the run completes before consuming it, the steer has no effect — verify uptake in the run's output rather than trusting this acknowledgment.`;
    return { text, details: { requestId: id, runId, ack } };
  } catch (e) {
    return err(e, "queue_steer");
  }
}

/** Fail-closed repo check for dispatch cwds (mirrors the pi extension's
 *  original): the cwd must be inside a git repo (toplevel-resolved) and the
 *  checkout clean — worktree isolation needs a clean main checkout to clone
 *  from. Message formats are load-bearing (tests assert them). */
export async function repoCheck(cwd: string): Promise<{ ok: boolean; reason?: string; files?: number }> {
  try {
    const { execFileSync } = await import("node:child_process");
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
    if (!top) {
      return { ok: false, reason: `${cwd} is not inside a git repository — pass cwd=<target-repo> to queue_dispatch (the session cwd is not the worker's repo)` };
    }
    const status = execFileSync("git", ["status", "--porcelain", "--", ".", ":(exclude).pi/subagents"], { cwd: top, encoding: "utf8" });
    const lines = status.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      return { ok: false, files: lines.length, reason: `main checkout ${top} is DIRTY (${lines.length} file(s)) — worktree isolation requires a clean tree. Commit/stash real work, or gitignore tooling artifacts (.pi/, .pi-subagents/, .reviews/), then re-dispatch.` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `${cwd} is not inside a git repository — pass cwd=<target-repo> to queue_dispatch (the session cwd is not the worker's repo)` };
  }
}

// keep loadStore referenced (storeOrNew helpers in hosts may use it)
export { loadStore, newStore };
