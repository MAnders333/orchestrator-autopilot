// run-ids.ts — collect run-id candidates from an async-complete payload
// (top-level workflow id, per-child run ids, session-path ids).

import type { CompletionEvent } from "./types.ts";

// Run-id collection (async payload → candidate ids)
// ---------------------------------------------------------------------------

const SESSION_PATH_RUN_RE = /\/([0-9a-f]{6,})\/run-\d+\//i;

/**
 * Collect every run-id candidate from an async-complete payload: the top-level
 * workflow id, per-child run ids, and ids extracted from session paths.
 */
export function collectRunIds(ev: CompletionEvent): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  push(ev.runId);
  push(ev.id);
  push(ev.sessionFile);
  if (Array.isArray(ev.results)) {
    for (const r of ev.results) {
      push(r.runId);
      push(r.sessionPath);
      push(r.sessionFile);
    }
  }
  for (const p of [...out]) {
    if (p.includes("/")) {
      const m = p.match(SESSION_PATH_RUN_RE);
      if (m) out.push(m[1]);
    }
  }
  return [...new Set(out.filter((v) => v.length >= 6))];
}
