// Spec completeness (AUTOPILOT-26) — the ADVISORY under-specification signal.
// Pure function: no store, no clock, no host. The fixtures are the two scopes
// that actually dispatched cleanly (AUTOPILOT-20 / AUTOPILOT-24, verbatim in
// test/fixtures/) — a heuristic that flags a GOOD scope is worse than none, so
// their silence is the test that matters most here.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { specCompleteness, specGapTag, SCOPE_SKELETON, SPEC_GAP_LABEL, THIN_SCOPE_CHARS } from "../../src/framework/spec-completeness.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
const REPO = "/tmp/repo";

describe("specCompleteness — the missing-element list", () => {
  test("no scope at all reports no-scope and SKIPS the content checks (the empty scope already said it)", () => {
    expect(specCompleteness({ scope: "", cwd: REPO })).toEqual(["no-scope"]);
    expect(specCompleteness({ scope: "   \n  ", cwd: REPO })).toEqual(["no-scope"]);
    expect(specCompleteness({ scope: null, cwd: REPO })).toEqual(["no-scope"]);
  });

  test("no cwd fires independently of the scope", () => {
    expect(specCompleteness({ scope: fixture("scope-autopilot-20.txt"), cwd: null })).toEqual(["no-cwd"]);
    expect(specCompleteness({ scope: "", cwd: "" })).toEqual(["no-scope", "no-cwd"]);
    expect(specCompleteness({ scope: "", cwd: "  " })).toEqual(["no-scope", "no-cwd"]);
  });

  test("no concrete artifact fires only when NOTHING openable is named", () => {
    const prose =
      "Rewrite the intake pass so proposals stop duplicating each other; it has annoyed the user for weeks and keeps coming up in review, so it is worth doing now.";
    expect(specCompleteness({ scope: prose, cwd: REPO })).toContain("no-artifact");
    // any ONE of these counts as a named artifact (the check is biased to silence)
    const withArtifact = (s: string) => specCompleteness({ scope: `${prose} ${s}`, cwd: REPO });
    expect(withArtifact("src/tools/queue-ops.ts:76")).not.toContain("no-artifact"); // file:line
    expect(withArtifact("see docs/queue-model.md")).not.toContain("no-artifact"); // path
    expect(withArtifact("the `approvalReady` gate")).not.toContain("no-artifact"); // backticked symbol
    expect(withArtifact("call zombieReconcile(undefined)")).not.toContain("no-artifact"); // call form
    expect(withArtifact("the reviewerRunId field")).not.toContain("no-artifact"); // camelCase
    expect(withArtifact("the queue_add tool")).not.toContain("no-artifact"); // snake_case
  });

  test("no acceptance fires when the scope never says how we know it worked", () => {
    const change =
      "src/framework/runner.ts:374 fleetStatus() throws and kills the whole sweep; wrap the call so a throw degrades to null and the sweep continues to auto-dispatch.";
    expect(specCompleteness({ scope: change, cwd: REPO })).toEqual(["no-acceptance"]);
    for (const clause of ["TESTS: a throwing backend still dispatches.", "verify the item reaches active.", "assert one tick lands.", "acceptance: the sweep completes."]) {
      expect(specCompleteness({ scope: `${change} ${clause}`, cwd: REPO })).toEqual([]);
    }
    // NON-CODE work states acceptance as a deliverable/verdict/suite-green, not
    // as a test — those scopes must stay silent too (real-queue false positives)
    for (const clause of ["Deliverable: docs/findings.md.", "Output: the analysis doc.", "Run the full suite, leave main green.", "Verdict per name: CLEAR / RISKY / BLOCKED."]) {
      expect(specCompleteness({ scope: `${change} ${clause}`, cwd: REPO })).toEqual([]);
    }
  });

  test("thin-scope fires below the threshold only — a title restated is not a worker prompt", () => {
    const short = "src/core.ts:12 off-by-one; test it.";
    expect(short.length).toBeLessThan(THIN_SCOPE_CHARS);
    expect(specCompleteness({ scope: short, cwd: REPO })).toEqual(["thin-scope"]);
    const padded = short + " ".padEnd(THIN_SCOPE_CHARS - short.length, "x");
    expect(padded.trim().length).toBeGreaterThanOrEqual(THIN_SCOPE_CHARS);
    expect(specCompleteness({ scope: padded, cwd: REPO })).toEqual([]);
  });

  test("a one-line capture note reports EVERY content gap (bounded, in report order)", () => {
    expect(specCompleteness({ scope: "Fix the parser", cwd: null })).toEqual(["no-cwd", "no-artifact", "no-acceptance", "thin-scope"]);
  });

  test("NO FALSE POSITIVES on the scopes that actually dispatched (AUTOPILOT-20 / AUTOPILOT-24)", () => {
    expect(specCompleteness({ scope: fixture("scope-autopilot-20.txt"), cwd: REPO })).toEqual([]);
    expect(specCompleteness({ scope: fixture("scope-autopilot-24.txt"), cwd: REPO })).toEqual([]);
  });

  test("PURE: same input → same output, and the item is never mutated", () => {
    const item = { scope: "Fix the parser", cwd: REPO };
    const first = specCompleteness(item);
    expect(specCompleteness(item)).toEqual(first);
    expect(item).toEqual({ scope: "Fix the parser", cwd: REPO });
  });
});

describe("specGapTag — the ONE wording both hosts render", () => {
  test("no gaps → no tag; a missing scope leads with NEEDS SPEC; anything else is a thin spec", () => {
    expect(specGapTag([])).toBeNull();
    expect(specGapTag(["no-scope", "no-cwd"])).toBe("NEEDS SPEC: no scope, no repo (cwd)");
    expect(specGapTag(["no-acceptance"])).toBe("thin spec: no acceptance criteria");
    expect(specGapTag(["no-artifact", "thin-scope"])).toBe(`thin spec: ${SPEC_GAP_LABEL["no-artifact"]}, ${SPEC_GAP_LABEL["thin-scope"]}`);
  });
});

describe("SCOPE_SKELETON — the refine prefill", () => {
  test("carries the six template headings in order", () => {
    const heads = SCOPE_SKELETON.split("\n").filter(Boolean).map((l) => l.split(":")[0]);
    expect(heads).toEqual(["PROBLEM", "EVIDENCE", "THE CHANGE", "JUDGMENT CALLS", "TESTS / ACCEPTANCE", "CONSTRAINTS"]);
  });

  test("an UNFILLED skeleton is still reported under-specified (template text alone never passes)", () => {
    // The skeleton deliberately contains no path, no file:line and no symbol,
    // so submitting it verbatim keeps the tag on the item.
    expect(specCompleteness({ scope: SCOPE_SKELETON, cwd: REPO })).toContain("no-artifact");
    expect(specGapTag(specCompleteness({ scope: SCOPE_SKELETON, cwd: REPO }))).toContain("thin spec");
  });

  test("the template headings match the ones documented in the prompt and the skill (defined once, three surfaces)", () => {
    const root = join(import.meta.dir, "..", "..");
    const prompt = readFileSync(join(root, "prompts", "orchestrate.md"), "utf8");
    const skill = readFileSync(join(root, "skills", "orchestrator-operations", "SKILL.md"), "utf8");
    for (const line of SCOPE_SKELETON.split("\n").filter(Boolean)) {
      expect(prompt).toContain(line);
      expect(skill).toContain(line);
    }
  });
});
