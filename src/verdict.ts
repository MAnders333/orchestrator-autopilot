// verdict.ts — strict Verdict: PASS/FAIL parsing (the queue_review reviewer
// contract: the FIRST non-empty line is exactly `Verdict: PASS`/`Verdict: FAIL`;
// anything else → null → the manual path, never a silent wrong flip).

import type { CompletionEvent } from "./types.ts";

// Verdict parsing (strict — the queue_review reviewer contract mandates a
// 'Verdict: PASS'/'Verdict: FAIL' FIRST line; anything else → manual path)
// ---------------------------------------------------------------------------

const VERDICT_RE = /^Verdict:\s*(PASS|FAIL)\b/;

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
    // The FIRST line-anchored `Verdict: PASS|FAIL` anywhere in the output —
    // the contract says first line, but reviewers occasionally preamble (the
    // P3 reviewer's verdict sat at line 47). Still strict: the line must be
    // EXACTLY the verdict format (no prose-match risk).
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(VERDICT_RE);
      if (m) return m[1] === "PASS" ? "PASS" : "FAIL";
    }
    return null;
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
