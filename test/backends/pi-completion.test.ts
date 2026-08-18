// test/backends/pi-completion.test.ts — the pi backend's completion-event
// enrichment: the raw async-complete payload is flat (no per-child agent or
// output), so the reviewer attribution NEVER fired (queue_review wedged on
// its first reviewer run — P3, MI-4455, P2, COOP). The backend normalizes
// from the run record into the same shape the opencode backend builds.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiBackend, readLastAssistantText } from "../../src/backends/pi.ts";
import type { PiLike } from "../../src/backends/types.ts";

const mockPi = { events: { emit: () => {} }, on: () => {}, sendUserMessage: async () => undefined } as unknown as PiLike;

describe("pi completion-event enrichment (the wedge fix)", () => {
  test("a flat async-complete payload gets the reviewer agent + verdict output from the run record", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-comp-"));
    const asyncDir = join(root, "run-1");
    const childSession = join(root, "child/session.jsonl");
    mkdirSync(join(asyncDir), { recursive: true });
    mkdirSync(join(root, "child"), { recursive: true });
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: "run-1",
      steps: [{ agent: "orchestrator-reviewer", sessionFile: childSession }],
    }));
    writeFileSync(childSession, JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working..." }] } }) + "\n" +
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Verdict: PASS\n\nEverything checks out." }] } }) + "\n");

    const backend = createPiBackend(mockPi);
    const ev = backend.buildCompletionEvent({ id: "run-1", success: true, state: "complete", asyncDir }) as Record<string, unknown>;
    expect(ev.agent).toBe("orchestrator-reviewer");
    expect((ev.results as Array<{ agent?: string; output?: string }>)[0].agent).toBe("orchestrator-reviewer");
    expect((ev.results as Array<{ agent?: string; output?: string }>)[0].output).toContain("Verdict: PASS");
    rmSync(root, { recursive: true, force: true });
  });

  test("no run record → the raw payload survives unchanged (tests / cleaned-up dirs)", () => {
    const backend = createPiBackend(mockPi);
    const ev = backend.buildCompletionEvent({ runId: "x", success: true, results: [{ agent: "worker", output: "w" }] }) as Record<string, unknown>;
    expect((ev.results as Array<{ agent?: string }>)[0].agent).toBe("worker"); // preserved
  });

  test("readLastAssistantText returns the final deliverable", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-comp-"));
    const f = join(root, "s.jsonl");
    writeFileSync(f, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "u" }] } }) + "\n" +
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "draft" }] } }) + "\n" +
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Verdict: FAIL — schema" }] } }) + "\n");
    expect(readLastAssistantText(f)).toContain("Verdict: FAIL");
    rmSync(root, { recursive: true, force: true });
  });
});
