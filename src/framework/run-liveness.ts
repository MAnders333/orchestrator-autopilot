// framework/run-liveness.ts — "is this recorded run still in flight?" answered
// from the backend's run dir, so a STALE run ref never wedges a lane.
//
// Both review-dispatch lanes (queue_review and the harness autoReview) used to
// treat "the item has a reviewerRunId" as "a reviewer is running". A run ref
// outlives its run: the reviewer crashes, the process is stopped, the engine
// restarts mid-review, or a completion event is lost — the id stays on the item
// and the item can never be reviewed again (queue_review refuses forever;
// autoReview returns null SILENTLY). The only escape was a manual bypass, which
// is exactly what breaks verdict attribution (src/core.ts attributes a reviewer
// completion via reviewerRunId) and drifts the queue from reality.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentBackend } from "../backends/types.ts";

/**
 * Is the recorded reviewer run still in flight?
 *
 * Resolves `backend.asyncDirFor(runId)` and reads its status.json: `queued` /
 * `running` (pi's `state`, opencode's `status`) → ALIVE; a terminal state → not
 * alive; the run dir gone → not alive.
 *
 * FAILS OPEN BY DESIGN — do not "harden" this into a fail-closed check. When
 * liveness cannot be determined (no backend, `asyncDirFor` returns null,
 * unreadable/garbage status.json) this reports NOT alive and the caller
 * dispatches. Reviewers are read-only, so a duplicate reviewer merely costs
 * tokens; a FALSE BLOCK costs a manual bypass — and the manual bypass is what
 * breaks verdict auto-routing and drifts the queue from reality. Cheap wrong
 * answer vs expensive wrong answer: choose the cheap one.
 */
export function reviewerRunAlive(backend: Pick<SubagentBackend, "asyncDirFor"> | null | undefined, runId: string): boolean {
  if (!backend || typeof backend.asyncDirFor !== "function") return false;
  let dir: string | null = null;
  try {
    dir = backend.asyncDirFor(runId);
  } catch {
    return false; // backend cannot resolve it — undeterminable → not alive
  }
  if (!dir) return false; // run dir gone → the run is over
  try {
    const path = join(dir, "status.json");
    if (!existsSync(path)) return false;
    const status = JSON.parse(readFileSync(path, "utf8")) as { state?: string; status?: string } | null;
    // pi records `state`, opencode records `status` — either naming counts.
    const phase = status?.state ?? status?.status;
    return phase === "queued" || phase === "running";
  } catch {
    return false; // unreadable/garbage status — undeterminable → not alive
  }
}
