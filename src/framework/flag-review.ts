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
  self_reviewed: boolean;
  review_method: ReviewMethod;
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
    self_reviewed: params.self_reviewed,
    review_method: params.review_method,
  };
  try {
    mkdirSync(join(logPath, ".."), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
  } catch {
    // silent
  }

  (sinks.notify ?? notifyDesktop)(
    `review ready (${params.risk})`,
    `${params.summary.slice(0, 120)}${params.self_reviewed ? " · self-reviewed" : " · not self-reviewed"}`,
  );

  const deliveryNote = params.self_reviewed
    ? "The user will review the summary, risk, and blast radius."
    : "Not self-reviewed — the user should verify the work before relying on it.";
  return { deliveryNote };
}
