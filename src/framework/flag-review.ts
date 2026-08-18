// flag-review.ts — the framework's human-handover signal: "this work is done,
// flag it for the user's review." The FINAL step of the review lifecycle
// (dispatch → agent review → flag_for_review). Tool-agnostic; each host
// registers the tool + supplies its notify sink.
//
// Log format (JSONL, one entry per flag):
//   { ts, event: "flag_for_review", summary, risk, blast_radius,
//     self_reviewed, review_method }

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type ReviewRisk = "low" | "medium" | "high";
export type ReviewMethod = "commit-hook" | "reviewer-subagent" | "none";

export interface FlagReviewParams {
  summary: string;
  risk: ReviewRisk;
  blast_radius: string;
  /** WHERE to review — file paths, `path:line` ranges, diff refs, commit
   *  SHAs, MR/PR links. The human reviews these. */
  review_targets: string[];
  self_reviewed: boolean;
  review_method: ReviewMethod;
  /** What the user should DO after reviewing (merge X, approve Y, decide A/B). */
  action_needed?: string;
  /** What was NOT verified / could change. */
  residual_risks?: string;
  /** The queue item this flag came from (when orchestrated). */
  queue_key?: string;
}

export interface FlagReviewSinks {
  /** Reviews log path (default: $AGENT_FEEDBACK_REVIEWS_DIR ||
   *  ~/.local/state/orchestrator/reviews.jsonl). */
  logPath?: string;
  /** Desktop-notification sink (pi: notifyDesktop; opencode: console). */
  notify?: (title: string, body: string) => void;
}

/** Desktop notification (OSC 777/99 — Ghostty, iTerm2, WezTerm, Kitty, rxvt).
 *  Tool-agnostic; control chars stripped so OSC sequences stay well-formed. */
export function notifyDesktop(title: string, body: string): void {
  try {
    const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, " ");
    process.stdout.write(`\x1b]777;notify;${clean(title)};${clean(body)}\x07`);
    process.stdout.write(`\x1b]99;i=1:d=0;${clean(title)}\x1b\\`);
  } catch {
    // silent
  }
}

export function defaultReviewsLog(): string {
  return process.env.AGENT_FEEDBACK_REVIEWS_DIR ?? join(homedir(), ".local/state/orchestrator/reviews.jsonl");
}

export function flagForReview(params: FlagReviewParams, sinks: FlagReviewSinks = {}): { deliveryNote: string } {
  const logPath = sinks.logPath ?? defaultReviewsLog();
  const entry = {
    ts: new Date().toISOString(),
    event: "flag_for_review",
    summary: params.summary,
    risk: params.risk,
    blast_radius: params.blast_radius,
    review_targets: params.review_targets,
    self_reviewed: params.self_reviewed,
    review_method: params.review_method,
    ...(params.action_needed ? { action_needed: params.action_needed } : {}),
    ...(params.residual_risks ? { residual_risks: params.residual_risks } : {}),
    ...(params.queue_key ? { queue_key: params.queue_key } : {}),
  };
  try {
    mkdirSync(join(logPath, ".."), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
  } catch {
    // silent
  }

  (sinks.notify ?? notifyDesktop)(
    `review ready (${params.risk})${params.review_targets.length ? ` · ${params.review_targets.length} target${params.review_targets.length > 1 ? "s" : ""}` : ""}`,
    `${params.summary.slice(0, 120)}${params.review_targets[0] ? `
${params.review_targets[0].slice(0, 80)}` : ""}`,
  );

  // The tool RESULT shows the CONTENTS, not a summary of the flag: the user
  // sees what was done + where to look right in the result. (The desktop
  // notification stays short — title + one-liner.)
  const targetLines = params.review_targets.length
    ? params.review_targets.map((t) => `  - ${t}`).join("\n")
    : "  (none — name the files!)";
  const lines = [
    `Flagged for review. Risk: ${params.risk}.${params.self_reviewed ? " Self-reviewed (" + params.review_method + ")." : " NOT self-reviewed — verify before relying."}`,
    "",
    `Summary: ${params.summary}`,
    `Blast radius: ${params.blast_radius}`,
    `Review targets (${params.review_targets.length}):`,
    targetLines,
  ];
  if (params.action_needed) lines.push("", `Action needed: ${params.action_needed}`);
  if (params.residual_risks) lines.push("", `Residual risks: ${params.residual_risks}`);
  if (params.queue_key) lines.push("", `Queue item: ${params.queue_key}`);
  const deliveryNote = lines.join("\n");
  return { deliveryNote };
}
