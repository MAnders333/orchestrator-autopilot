// auto-dispatch.ts — the framework ACTS on the queue instead of only nudging.
// Two automations (both gated on the item being FULLY specified):
//
//  A. autoDispatchEligible — when a slot frees, fill it with approved items
//     items that have a complete scope + cwd + low/medium risk. The task is
//     `KEY: <key>` + the scope (the orchestrator writes scopes at
//     proposal/approval time — the dispatch-time scoping moves earlier).
//     HIGH-risk or incomplete items are left for the orchestrator's
//     checkpoint (the dispatch tick still nudges those).
//
//  B. autoRedispatch — on a review FAIL, re-dispatch with the original scope
//     PLUS the reviewer's findings (up to the cap). The cap still surfaces.
//
//  C. autoReview — when a worker completes (active → reviewing), dispatch the
//     reviewer automatically with the SAME fields the dispatch used: KEY +
//     scope + cwd (to locate the work). The approval gate guarantees scope +
//     cwd on every approved item, so both automations just take them off the
//     item. The verdict routing (PASS → done, FAIL → B, cap → failed) is the
//     engine's; the human handover (flag_for_review) stays the orchestrator's.
//
// The orchestrator keeps all JUDGMENT (intake scanning, approval, high-risk
// checkpoints); these automations remove the mechanical round-trips.

import { loadStore, saveStore, updateItem, type QueueItem } from "../queue-store.ts";
import type { SubagentBackend } from "../backends/types.ts";

/** B26 rule as a testable PREDICATE: a subagent tool call is a worker spawn
 *  WITHOUT worktree isolation — the class that breaks parallel workers (B20's
 *  strays blocked B22/B23 at launch, dirtying the main checkout). The pi host
 *  wires its tool_call interception to this; any host with a tool-call hook
 *  can adopt the same rule. Management actions (status/steer/stop) are not
 *  spawns — never blocked. */
export function isUnisolatedWorkerSpawn(
  args: { agent?: string; worktree?: boolean; action?: string },
  workerAgents: string[],
): boolean {
  if (args.action !== undefined) return false; // management — not spawns
  if (!args.agent || !workerAgents.includes(args.agent)) return false;
  if (args.worktree === true) return false; // explicitly isolated
  return true;
}

/** A low/medium-risk item with a complete scope + cwd is auto-dispatchable. */
export function isAutoDispatchable(item: QueueItem): boolean {
  return (
    item.status === "approved" &&
    item.risk !== "high" &&
    typeof item.scope === "string" &&
    item.scope.trim().length > 0 &&
    typeof item.cwd === "string" &&
    item.cwd.trim().length > 0
  );
}

/** Build the worker task: the KEY line + the scope (+ optional findings). */
export function workerTask(item: QueueItem, findings?: string): string {
  const task = `KEY: ${item.key}\n${item.scope.trim()}`;
  if (findings && findings.trim()) {
    return `${task}\n\n## Review findings (address them)\n${findings.trim()}`;
  }
  return task;
}

/** The number of free slots (fleet-aware; falls back to the store's active count). */
function freeSlots(stateDir: string, backend: SubagentBackend, maxSlots: number, fleetTotalActive?: number): number {
  const store = loadStore(stateDir);
  const active = store ? Object.values(store.items).filter((i) => i.status === "active").length : 0;
  const occupied = fleetTotalActive ?? active;
  return Math.max(0, maxSlots - occupied);
}

/**
 * A — fill free slots with auto-dispatchable approved items. Returns the
 * number dispatched. Never throws — a spawn failure stops the batch.
 */
export async function autoDispatchEligible(
  stateDir: string,
  backend: SubagentBackend,
  maxSlots: number,
  fleetTotalActive?: number,
): Promise<Array<{ key: string; runId: string }>> {
  const store = loadStore(stateDir);
  if (!store) return [];
  const eligible = Object.values(store.items)
    .filter(isAutoDispatchable)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1)); // oldest first
  if (eligible.length === 0) return []; // no fleet call when there is no work
  const slots = freeSlots(stateDir, backend, maxSlots, fleetTotalActive);
  if (slots <= 0) return [];
  const dispatched: Array<{ key: string; runId: string }> = [];
  for (const item of eligible.slice(0, slots)) {
    try {
      const runId = await backend.spawn(workerTask(item), { cwd: item.cwd! });
      if (!runId) continue;
      updateItem(store, item.key, { status: "active", runId });
      dispatched.push({ key: item.key, runId });
    } catch {
      break; // a spawn failure stops the batch — the orchestrator handles it
    }
  }
  if (dispatched.length > 0) saveStore(stateDir, store);
  return dispatched;
}

/**
 * B — re-dispatch a review-FAILED item with the reviewer's findings (up to
 * the cap). The caller decides the cap (the engine already flipped to active
 * when attempts < cap). Returns true when re-dispatched.
 */
export async function autoRedispatch(
  stateDir: string,
  backend: SubagentBackend,
  key: string,
  findings: string,
): Promise<boolean> {
  const store = loadStore(stateDir);
  const item = store?.items[key];
  if (!item || item.status !== "active") return false; // only the FAIL→active flip is re-dispatchable
  if (typeof item.cwd !== "string" || !item.cwd.trim()) return false; // no repo → orchestrator
  try {
    const runId = await backend.spawn(workerTask(item, findings), { cwd: item.cwd });
    if (!runId) return false;
    updateItem(store!, key, { runId });
    saveStore(stateDir, store!);
    return true;
  } catch {
    return false; // the orchestrator re-dispatches manually
  }
}

/**
 * C — the review task for an item: the SAME fields the dispatch used (KEY +
 * scope), plus where the work landed (cwd) and the locate-it-yourself rule.
 * The reviewer must read the actual work product, not the worker's summary.
 */
export function reviewTask(item: QueueItem): string {
  return [
    `KEY: ${item.key}`,
    item.scope.trim(),
    "",
    "## Review the completed work",
    `Verify the work product in the repo at: ${item.cwd}`,
    "Locate the work yourself: the worker ran in an isolated worktree and pushed to ITS OWN parallel branch (pi-parallel-<runid>-0) — the commits may be there, unmerged. Check `git log --all -- <path>` + `git branch -a -r` + `git show` on those branches BEFORE concluding anything is missing; a FAIL must be based on the work being absent everywhere, never just on main. Read the actual diff/files — do NOT trust the worker's summary.",
    "",
    "The FIRST line of your response MUST be exactly `Verdict: PASS` or `Verdict: FAIL`. If FAIL, list each finding as an actionable item.",
  ].join("\n");
}

/**
 * C — auto-dispatch the reviewer for a completed item (active → reviewing).
 * Mirrors queueReview but builds the task from the item (no orchestrator
 * round-trip). Returns true when a reviewer was spawned.
 */
export async function autoReview(
  stateDir: string,
  backend: SubagentBackend,
  reviewerAgent: string,
  key: string,
): Promise<string | null> {
  try {
    const store = loadStore(stateDir);
    const item = store?.items[key];
    if (!item || item.status !== "reviewing" || item.reviewerRunId) return null;
    if (!(item.scope ?? "").trim() || !item.cwd) return null; // safety net — the approval gate guarantees these
    const runId = await backend.spawn(reviewTask(item), {
      agent: reviewerAgent,
      worktree: false, // reviewers are read-only — no worktree
      cwd: item.cwd,
    });
    if (!runId) return null;
    updateItem(store!, key, { reviewerRunId: runId });
    saveStore(stateDir, store!);
    return runId;
  } catch {
    return null; // the review tick nudges the orchestrator
  }
}
