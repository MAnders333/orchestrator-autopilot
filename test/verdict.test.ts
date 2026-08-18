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
});
