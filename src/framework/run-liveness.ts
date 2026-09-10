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
  // Expressed on the tri-state read so there is ONE status.json parser, but the
  // answer is byte-for-byte the old one: ONLY queued/running blocks a reviewer
  // dispatch. Terminal, undeterminable, and the paused/blocked phases the sweep
  // treats as alive all still mean "go" here — AUTOPILOT-20's fail-open lane is
  // not being widened by AUTOPILOT-47's tri-state.
  const ev = runStateEvidence(backend, runId);
  return ev.kind === "in-flight" && (ev.phase === "queued" || ev.phase === "running");
}

/**
 * What the run dir PROVES about a run, as three distinct answers.
 *
 * WHY THREE AND NOT TWO (AUTOPILOT-47, and the tension with AUTOPILOT-20): a
 * run whose status.json parsed and says `state:"failed"` is NOT the same fact
 * as a run whose status is missing, unreadable, or spells a phase this code has
 * never seen. The first is POSITIVE EVIDENCE OF DEATH; the second is ABSENCE OF
 * EVIDENCE. Collapsing them into one boolean is what forces every caller to
 * pick a single fail direction for both — and the right direction is not the
 * same in both lanes:
 *
 *   - reviewer dispatch (AUTOPILOT-20): a wrong "dead" costs a duplicate
 *     read-only reviewer (cheap); a wrong "alive" costs a manual bypass that
 *     breaks verdict attribution (expensive). Fail toward dispatching.
 *   - the dead-run sweep (AUTOPILOT-47): a wrong "dead" FLIPS A LIVE WORKER'S
 *     item to failed and invites a duplicate re-dispatch (expensive); a wrong
 *     "alive" costs one more grace window (cheap). Fail toward leaving it be.
 *
 * Same input, opposite safe answers. So this function reports the EVIDENCE and
 * each lane owns its own fail direction — AUTOPILOT-20's fail-open is preserved
 * exactly where it applies (`undeterminable` is never treated as death) instead
 * of being reversed to make the sweep work.
 */
export type RunStateEvidence =
  /** status.json parsed and names a live phase (queued/running/paused/blocked). */
  | { kind: "in-flight"; phase: string }
  /** status.json parsed and names a TERMINAL phase — the run is provably over. */
  | { kind: "terminal"; phase: string; error?: string }
  /** No backend, no dir, no/unreadable status, or a phase this code does not know. */
  | { kind: "undeterminable"; reason: string };

/** Phases that mean the run is still the framework's to wait on. `paused` and
 *  `blocked` are ALIVE: the run is waiting on input, not dead. */
const LIVE_PHASES = new Set(["queued", "running", "paused", "blocked"]);
/** Phases that mean the run will never produce more work. */
const TERMINAL_PHASES = new Set(["complete", "completed", "failed", "partial", "stopped", "rejected", "cancelled", "canceled"]);

export function runStateEvidence(
  backend: Pick<SubagentBackend, "asyncDirFor"> | null | undefined,
  runId: string,
): RunStateEvidence {
  if (!runId) return { kind: "undeterminable", reason: "no run id" };
  if (!backend || typeof backend.asyncDirFor !== "function") return { kind: "undeterminable", reason: "backend cannot resolve run dirs" };
  let dir: string | null = null;
  try {
    dir = backend.asyncDirFor(runId);
  } catch {
    return { kind: "undeterminable", reason: "asyncDirFor threw" };
  }
  if (!dir) return { kind: "undeterminable", reason: "run dir not found" };
  const path = join(dir, "status.json");
  let status: { state?: string; status?: string; error?: string } | null;
  try {
    if (!existsSync(path)) return { kind: "undeterminable", reason: "no status.json" };
    status = JSON.parse(readFileSync(path, "utf8")) as typeof status;
  } catch {
    return { kind: "undeterminable", reason: "status.json unreadable or malformed" };
  }
  // pi records `state`, opencode records `status` — either naming counts.
  const phase = status?.state ?? status?.status;
  if (typeof phase !== "string" || !phase) return { kind: "undeterminable", reason: "status.json names no phase" };
  if (LIVE_PHASES.has(phase)) return { kind: "in-flight", phase };
  if (TERMINAL_PHASES.has(phase)) {
    return { kind: "terminal", phase, ...(typeof status?.error === "string" && status.error ? { error: status.error } : {}) };
  }
  // An UNKNOWN phase is absence of evidence, never death — a runtime that adds
  // a phase must not silently start reaping live work.
  return { kind: "undeterminable", reason: `unrecognised phase '${phase}'` };
}
