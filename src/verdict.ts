// verdict.ts — strict Verdict: PASS/FAIL parsing (the queue_review reviewer
// contract: the FIRST non-empty line is exactly `Verdict: PASS`/`Verdict: FAIL`;
// anything else → null → the manual path, never a silent wrong flip).

import type { CompletionEvent } from "./types.ts";

// Verdict parsing (strict — the queue_review reviewer contract mandates a
// 'Verdict: PASS'/'Verdict: FAIL' FIRST line; anything else → manual path)
// ---------------------------------------------------------------------------

const VERDICT_RE = /^Verdict:\s*(PASS|FAIL)\b/;

/** First non-empty line of a text (the verdict contract anchors there). */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/**
 * Strict verdict parse: the queue_review reviewer contract mandates the FIRST
 * non-empty line is exactly `Verdict: PASS`/`Verdict: FAIL`. Anything else →
 * null → the manual path (no silent wrong flips).
 */
export function parseVerdict(ev: CompletionEvent, reviewerAgents: string[] = []): "PASS" | "FAIL" | null {
  const results = Array.isArray(ev.results) ? ev.results : [];
  const reviewerSet = new Set(reviewerAgents);
  const pick = (out: unknown): "PASS" | "FAIL" | null => {
    if (typeof out !== "string") return null;
    const m = firstLine(out).match(VERDICT_RE);
    return m ? (m[1] === "PASS" ? "PASS" : "FAIL") : null;
  };
  // reviewer children first — a fan-out may include non-reviewer results
  for (const r of results) {
    const agent = (r as { agent?: unknown }).agent;
    if (typeof agent === "string" && reviewerSet.has(agent)) {
      const v = pick((r as { output?: unknown }).output);
      if (v) return v;
    }
  }
  for (const r of results) {
    const v = pick((r as { output?: unknown }).output);
    if (v) return v;
  }
  if (typeof ev.summary === "string") {
    const m = firstLine(ev.summary).match(VERDICT_RE);
    if (m) return m[1] === "PASS" ? "PASS" : "FAIL";
  }
  return null;
}
