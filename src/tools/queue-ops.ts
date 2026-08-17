// tools/queue-ops.ts — the SIX queue tools as host-agnostic operations.
// Both hosts (the pi extension and the opencode plugin) register these tools;
// the logic lives here ONCE (single authoritative implementation — no dead
// copies between hosts). Hosts adapt the result shape: pi wraps
// { text, details } into its tool-result envelope, opencode returns the text.
//
// These are deterministic store+backend operations; all LLM judgment stays in
// the orchestrator (the tool CALLER), per the framework's trigger-only rule.

import type { SubagentBackend } from "../backends/types.ts";
import type { Autopilot, AutopilotConfig } from "../core.ts";
import { loadStore, saveStore, newStore, addItem, updateItem, queryItems, queueLengths, type QueueStore } from "../queue-store.ts";

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
  cfg(): AutopilotConfig;
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

/** queue_add — new proposal (default) or approved item; free-form notes. */
export async function queueAdd(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const store = ctx.storeOrNew();
    const key = params.key as string;
    if (store.items[key]) return { text: `queue_add: key '${key}' already exists — use queue_update`, details: {} };
    const status: "approved" | "proposal" = params.status === "approved" ? "approved" : "proposal";
    addItem(store, {
      key,
      status,
      ready: (params.ready as boolean | undefined) ?? status === "approved",
      blocker: null,
      title: params.title as string,
      scope: (params.scope as string) ?? "",
      evidence: (params.evidence as string) ?? "",
      value: (params.value as string) ?? "",
      urgency: (params.urgency as string) ?? "",
      risk: (params.risk as string) ?? "",
      runId: null,
      notes: (params.notes as string) ?? "",
    });
    saveStore(ctx.stateDir, store);
    return { text: `added '${key}' (${status})`, details: {} };
  } catch (e) {
    return err(e, "queue_add");
  }
}

/** queue_update — validated transitions, ready flag, blocker, free-form fields. */
export async function queueUpdate(ctx: QueueOpsCtx, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const store = ctx.storeOrNew();
    updateItem(store, params.key as string, {
      status: params.status as never,
      ready: params.ready as boolean | undefined,
      blocker: params.blocker as never,
      title: params.title as string | undefined,
      scope: params.scope as string | undefined,
      evidence: params.evidence as string | undefined,
      value: params.value as string | undefined,
      urgency: params.urgency as string | undefined,
      risk: params.risk as string | undefined,
      notes: params.notes as string | undefined,
    });
    saveStore(ctx.stateDir, store);
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
      if (!item.ready) {
        return { text: `queue_dispatch: '${key}' is not ready (blocker: ${item.blocker ?? "none"})`, details: {} };
      }
    } else if (item.status !== "reviewing" && item.status !== "failed") {
      return { text: `queue_dispatch: '${key}' is ${item.status}, not dispatchable`, details: {} };
    }
    const cwd = (params.cwd as string | undefined) ?? ctx.sessionCwd ?? process.cwd();
    const check = await ctx.repoCheck(cwd);
    if (!check.ok) {
      return { text: `queue_dispatch: ${check.reason}`, details: { cwd, ...(check.files ? { dirty: check.files } : {}) } };
    }
    const runId = await ctx.backend.spawn(params.task as string, { cwd, timeoutMs: params.timeoutMs as number | undefined });
    if (!runId) return { text: "queue_dispatch: spawned but no run id returned", details: {} };
    updateItem(store, key, { status: "active", runId });
    saveStore(ctx.stateDir, store);
    ctx.autopilot().handleAsyncStarted(runId, "worker"); // fleet ledger
    return { text: `dispatched '${key}' — run ${runId}`, details: { runId } };
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
    if (item.status !== "reviewing") {
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
    const runId = await ctx.backend.spawn(task, { agent: agentName, worktree: false, timeoutMs: params.timeoutMs as number | undefined });
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
    const runId = item.status === "active" ? item.runId : item.status === "reviewing" ? item.reviewerRunId : null;
    if (!runId) {
      return { text: `queue_steer: '${key}' has no running run (status ${item.status}) — only active workers / reviewing reviewers are steerable`, details: {} };
    }
    const mode = params.mode === "follow_up" ? "follow_up" : "steer";
    const id = await ctx.backend.steer(runId, params.message as string, mode, params.ackTimeoutMs as number | undefined);
    return { text: `steered '${key}' (run ${runId.slice(0, 8)}…, request ${id}) — ${mode} acknowledged by the child`, details: { requestId: id, runId } };
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
