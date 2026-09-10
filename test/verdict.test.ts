// test/verdict.test.ts — the verdict contract: strict format, tolerant position
// (reviewers occasionally preamble — the P3 reviewer's verdict sat at line 47).
import { describe, test, expect } from "bun:test";
import { parseVerdict } from "../src/verdict.ts";

describe("parseVerdict", () => {
  test("first-line verdict still parses", () => {
    expect(parseVerdict({ results: [{ agent: "orchestrator-reviewer", output: "Verdict: PASS\n\nok" }] })).toBe("PASS");
    expect(parseVerdict({ results: [{ agent: "orchestrator-reviewer", output: "Verdict: FAIL — schema wrong" }] })).toBe("FAIL");
  });

  test("a long preamble before the verdict still parses (line-anchored, exact format)", () => {
    const preamble = Array.from({ length: 46 }, (_, i) => `line ${i + 1} of context`).join("\n");
    const output = `${preamble}\n\nVerdict: PASS.\n\nThe review body...`;
    expect(parseVerdict({ results: [{ agent: "orchestrator-reviewer", output }] })).toBe("PASS");
  });

  test("prose mentions of the format do NOT parse (no silent wrong flips)", () => {
    const output = "I considered whether Verdict: FAIL applies here but decided against it.\nNo standalone verdict line.";
    expect(parseVerdict({ results: [{ agent: "orchestrator-reviewer", output }] })).toBeNull();
  });

  test("no verdict anywhere → null (the manual path)", () => {
    expect(parseVerdict({ results: [{ agent: "orchestrator-reviewer", output: "Just a summary." }] })).toBeNull();
  });

  // The ev.summary fallback: no backend in-tree populates it today (pi's
  // normalizer spreads a payload documented as {id,success,state,asyncDir,
  // sessionId}; opencode's builder writes results[] only), but the branch is
  // live for any event that carries text there — and it threw ReferenceError
  // (firstLine was never defined) until this was pinned.
  describe("the ev.summary fallback (no results output)", () => {
    test("a verdict line in the summary parses — PASS and FAIL", () => {
      expect(parseVerdict({ summary: "Verdict: PASS\n\nThe work is correct." })).toBe("PASS");
      expect(parseVerdict({ summary: "Verdict: FAIL — schema wrong" })).toBe("FAIL");
    });

    test("summary with no verdict line → null (the manual path, never a guess)", () => {
      expect(parseVerdict({ summary: "Did the thing; it looks fine to me." })).toBeNull();
      expect(parseVerdict({ summary: "I nearly wrote Verdict: PASS but there is no verdict line." })).toBeNull();
    });

    test("the summary is only consulted when no result output carries a verdict", () => {
      expect(parseVerdict({ results: [{ agent: "r", output: "Verdict: FAIL" }], summary: "Verdict: PASS" }, ["r"])).toBe("FAIL");
    });
  });

  test("never throws for any completion-event shape it can legitimately receive", () => {
    const shapes: Array<Record<string, unknown>> = [
      {},
      { summary: "Verdict: PASS" },
      { summary: "" },
      { summary: undefined },
      { summary: null },
      { summary: 42 },
      { summary: { text: "Verdict: PASS" } },
      { summary: ["Verdict: PASS"] },
      { results: [] },
      { results: null },
      { results: "not-an-array" },
      { results: [{}] },
      { results: [{ agent: 7, output: 9 }] },
      { results: [{ agent: "r" }], summary: "Verdict: FAIL" },
      { runId: "abc", agent: "workflow", success: true, status: "completed", sessionFile: "/tmp/s.jsonl" },
    ];
    for (const ev of shapes) {
      expect(() => parseVerdict(ev as never, ["orchestrator-reviewer"])).not.toThrow();
      expect(["PASS", "FAIL", null]).toContain(parseVerdict(ev as never, ["orchestrator-reviewer"]));
    }
  });
});
