// -------------------------------------------------------------------------
// Spec completeness (AUTOPILOT-26) — an ADVISORY signal, not a gate.
//
// `approvalReady(scope, cwd)` (src/tools/queue-ops.ts) is and stays a binary
// PRESENCE check: non-empty scope + cwd. It conflates "specified" with
// "non-empty", which is exactly why an under-specified proposal is only
// discovered at the moment someone tries to approve it.
//
// This module answers a DIFFERENT question — "what is missing from this
// scope?" — and answers it with a bounded list of missing elements, never a
// score, never a percentage, never a model call. Every check below is a plain
// regex or a length compare so a reviewer can predict the output by reading
// the function.
//
// THIS NEVER BLOCKS. Nothing here is wired into approvalReady, and it must
// not be: a thin-but-non-empty scope that a human decides to approve is that
// human's call. Do not "improve" this into a second approval gate — the
// point of the queue is that approving stays cheap. The tag is information at
// triage time; the decision stays where it was.
//
// A heuristic that flags GOOD scopes is worse than no heuristic at all, so
// every check is biased toward SILENCE: it fires only when the element is
// entirely absent, and any ambiguous token counts as present.
// -------------------------------------------------------------------------

/** The missing elements this module can report — a closed set, in report
 *  order. The list returned by specCompleteness is bounded by construction:
 *  at most one entry per id, at most 5 entries total. */
export type SpecGapId = "no-scope" | "no-cwd" | "no-artifact" | "no-acceptance" | "thin-scope";

/** The human-facing wording for each gap — ONE spelling per concept, shared
 *  by both panel renderers and the /autopilot status line. */
export const SPEC_GAP_LABEL: Record<SpecGapId, string> = {
  "no-scope": "no scope",
  "no-cwd": "no repo (cwd)",
  "no-artifact": "no file/symbol named",
  "no-acceptance": "no acceptance criteria",
  "thin-scope": "scope is one-liner short",
};

/** THIN-SCOPE THRESHOLD, justified: the shortest scope that can actually
 *  carry the template's minimum — a problem statement, one `file:line`
 *  evidence reference, the change, and how we know it worked — runs about
 *  110-130 characters in practice, e.g.
 *    "src/framework/runner.ts:374 fleetStatus() throws and kills the sweep;
 *     wrap it in try/catch — test: a throwing backend still dispatches."  (≈130)
 *  Below 120 characters a "scope" is a TITLE restated, not a worker prompt.
 *  This is deliberately not tuned finer: it is a smell threshold whose only
 *  job is to catch the one-line capture note, and both AUTOPILOT-20 and
 *  AUTOPILOT-24 (the reference scopes) clear it by more than an order of
 *  magnitude. */
export const THIN_SCOPE_CHARS = 120;

/** Concrete-artifact evidence: does the scope NAME something a worker can
 *  open? Any ONE of these counts (biased toward silence — an ambiguous token
 *  is treated as an artifact, so a good scope is never flagged). */
const ARTIFACT_PATTERNS: RegExp[] = [
  /[\w./-]+\.[A-Za-z]{1,6}:\d+/, //            file:line — "src/tools/queue-ops.ts:76"
  /[\w.-]+\/[\w.-]+/, //                       path-like token — "src/framework/panels.ts", "docs/queue-model.md"
  /`[^`\n]+`/, //                              a backticked symbol, path or command
  /[A-Za-z_$][\w$]*\(/, //                     a call-looking identifier — "approvalReady("
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/, //    camelCase identifier — "reviewerRunId"
  /\b[a-z][a-z0-9]*_[a-z][\w]*\b/, //          snake_case identifier — "queue_add"
];

/** Acceptance evidence: does the scope say how we know it worked? Again any
 *  ONE hit is enough. Deliberately vocabulary-based — no attempt to parse
 *  structure, because a parser here would be unpredictable.
 *
 *  The second half of the vocabulary (deliverable/output/suite/green/success/
 *  verdict) is not decoration: replaying this check over the real queue showed
 *  a test-only vocabulary flagging perfectly good NON-CODE scopes — research
 *  and writing tasks state acceptance as a named DELIVERABLE or verdict, and a
 *  landing task states it as "run the full suite, leave main green". Flagging
 *  those is the exact heuristic-theatre failure this signal must avoid. */
const ACCEPTANCE_PATTERN =
  /\b(tests?|testing|tested|verify|verifies|verified|verification|assert|asserts|asserted|assertion|expect|expects|expected|acceptance|prove|proves|proven|repro|reproduce|reproduces|regression|deliverables?|outputs?|suite|green|success|verdict|done when)\b/i;

/** The SHAPE of a complete scope — headings only. The PROCEDURE (how to fill
 *  each one, and when it is worth the effort) lives in prompts/orchestrate.md
 *  and skills/orchestrator-operations/SKILL.md, per facts-in-config /
 *  procedure-in-prompts; this constant exists so the panel's refine editor can
 *  offer the skeleton as prefill without a renderer inventing its own wording.
 *  Harvested from the AUTOPILOT-20 and AUTOPILOT-24 scopes (both dispatched
 *  and completed off exactly this structure).
 *
 *  Note it names no path and no symbol, and its `file:line` wording is prose
 *  rather than a real reference — so a skeleton submitted unfilled is still
 *  tagged (no-artifact) instead of passing the checks on template text alone.
 *  Keep it that way if the headings are ever reworded. */
export const SCOPE_SKELETON = [
  "PROBLEM: what is broken or missing, and where it was observed",
  "EVIDENCE: the file:line references that prove the problem is real",
  "THE CHANGE: what a worker actually does, per file",
  "JUDGMENT CALLS: decisions that must not be silently inverted, and why",
  "TESTS / ACCEPTANCE: how we know it worked (hermetic where possible)",
  "CONSTRAINTS: branch-only, gates that must stay green, what must not change",
].join("\n");
// Six lines, no blank separators: the panel's refine editor shows a limited
// viewport, and the skeleton's whole job is to be READ at a glance (the field
// opens with select-all armed, so the first keystroke replaces it wholesale).
// A skeleton that scrolls its own first heading out of view fails at that.

/** The missing elements of one item's specification, in report order.
 *
 *  PURE: no store, no config, no clock, no I/O — it sees exactly the two
 *  fields it judges. An empty result means "nothing obviously missing", NOT
 *  "good": this is a floor, never a quality score.
 *
 *  When there is no scope at all, the content checks are SKIPPED — reporting
 *  "no artifact + no acceptance + too short" about a scope that does not
 *  exist is noise; "no scope" already says it. */
export function specCompleteness(item: { scope?: string | null; cwd?: string | null }): SpecGapId[] {
  const gaps: SpecGapId[] = [];
  const scope = (item.scope ?? "").trim();
  if (!scope) gaps.push("no-scope");
  if (!(item.cwd ?? "").trim()) gaps.push("no-cwd");
  if (!scope) return gaps;

  if (!ARTIFACT_PATTERNS.some((re) => re.test(scope))) gaps.push("no-artifact");
  if (!ACCEPTANCE_PATTERN.test(scope)) gaps.push("no-acceptance");
  if (scope.length < THIN_SCOPE_CHARS) gaps.push("thin-scope");
  return gaps;
}

/** The ONE tag wording for a gap list — shared by both panel renderers so the
 *  two hosts can never word the same signal differently. Returns null when
 *  nothing is missing (no tag is drawn). */
export function specGapTag(gaps: readonly SpecGapId[]): string | null {
  if (!gaps.length) return null;
  const labels = gaps.map((g) => SPEC_GAP_LABEL[g]).join(", ");
  return gaps.includes("no-scope") ? `NEEDS SPEC: ${labels}` : `thin spec: ${labels}`;
}
