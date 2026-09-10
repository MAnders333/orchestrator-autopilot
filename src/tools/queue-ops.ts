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
import { loadStore, saveStore, newStore, addItem, updateItem, queryItems, queueLengths, resolveSeries, recordSeries, type QueueStore } from "../queue-store.ts";
import { isAutoDispatchable } from "../framework/auto-dispatch.ts";
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
    const store = ctx.storeOrNew();
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
    let series = explicitSeries || (cwd ? resolveSeries(ctx.stateDir, cwd) : "Q");
    if (!key) key = nextKeyFor(store, series);
    if (cwd) recordSeries(ctx.stateDir, cwd, series);
    if (store.items[key]) return { text: `queue_add: key '${key}' already exists — use queue_update, or omit key to auto-allocate the next number in a series`, details: {} };
    const status: "approved" | "proposal" = params.status === "approved" ? "approved" : "proposal";
    const scope = (params.scope as string) ?? "";
    if (status === "approved" && !approvalReady(scope, cwd)) {
      return { text: "queue_add: approval requires a complete scope + cwd (the scope is the worker prompt; cwd is the repo it runs in) — add as proposal or supply both", details: {} };
    }
    addItem(store, {
      key,
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
    saveStore(ctx.stateDir, store);
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
    const store = ctx.storeOrNew();
    const cur = store.items[params.key as string];
    if (!cur) return { text: `queue_update: no item '${params.key}'`, details: {} };
    const nextStatus = (params.status as string | undefined) ?? cur.status;
    const nextScope = (params.scope as string | undefined) ?? cur.scope;
    const nextCwd = (params.cwd as string | null | undefined) ?? cur.cwd;
    if (nextStatus === "approved" && !approvalReady(nextScope, nextCwd)) {
      return { text: "queue_update: approval requires a complete scope + cwd (the scope is the worker prompt; cwd is the repo it runs in) — blocked items are for waiting, not dispatchable work", details: {} };
    }
    // An approval may complete a PROVISIONAL key: run the shared rename AFTER
    // the mutation (resolveSeries excludes the item's own vote, so the rename
    // cannot resolve to its own provisional Q).
    const renamingProvisional = cur.provisionalKey === true && nextStatus === "approved" && !!nextCwd;
    updateItem(store, params.key as string, {
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
      notes: params.notes as string | undefined,
    });
    saveStore(ctx.stateDir, store);
    if (renamingProvisional) {
      const renamedTo = renameProvisionalKey(ctx.stateDir, store, params.key as string);
      saveStore(ctx.stateDir, store); // marker clear AND/OR the rename
      if (renamedTo) {
        const series = /^([A-Za-z0-9_-]+?)-\d+/.exec(renamedTo)?.[1] ?? renamedTo;
        return { text: `updated '${params.key}' → approved; provisional key renamed to '${renamedTo}' (series ${series})`, details: { renamedFrom: params.key, key: renamedTo } };
      }
    }
    return { text: `updated '${params.key}'`, details: {} };
  } catch (e) {
    return err(e, "queue_update");
  }
}

/** queue_dispatch — spawn the worker (worktree isolation, fail-closed repo
 *  check) AND record approved→active + runId atomically. */
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
    const runId = await ctx.backend.spawn(params.task as string, { cwd, timeoutMs });
    if (!runId) return { text: "queue_dispatch: spawned but no run id returned", details: {} };
    updateItem(store, key, { status: "active", runId, ...(requestedTimeout ? { timeoutMs: requestedTimeout } : {}) });
    saveStore(ctx.stateDir, store);
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
    return { text: `dispatched '${key}' — run ${runId}.${autoNote}`, details: { runId } };
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
    if (item.reviewerRunId) {
      return { text: `queue_review: a reviewer is ALREADY running for '${key}' (run ${item.reviewerRunId.slice(0, 8)}…) — steer it or wait for its completion`, details: {} };
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
    updateItem(store, key, { reviewerRunId: runId });
    saveStore(ctx.stateDir, store);
    ctx.emit([{ name: "orch:reviewer-dispatched", data: { key, reviewerRunId: runId } }]);
    return { text: `reviewer dispatched for '${key}' — run ${runId}`, details: { runId } };
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
