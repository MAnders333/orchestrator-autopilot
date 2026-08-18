// test/framework/flag-review.test.ts — the human-handover signal: log shape
// + notification + the review targets. Hermetic (temp log path, no notify).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flagForReview } from "../../src/framework/flag-review.ts";

describe("flagForReview", () => {
  test("appends the full record (summary, risk, targets, method) to the reviews log", () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "orch-flag-")), "reviews.jsonl");
    const note = flagForReview(
      {
        summary: "Implemented the flag-review targets.",
        risk: "medium",
        blast_radius: "The tool schema changed — callers must pass review_targets.",
        review_targets: ["src/framework/flag-review.ts", "src/hosts/pi-extension.ts:440-460", "https://github.com/MAnders333/orchestrator-autopilot/pull/1"],
        self_reviewed: true,
        review_method: "reviewer-subagent",
        action_needed: "Review the diff + merge the PR.",
        residual_risks: "The opencode schema was not exercised live.",
        queue_key: "FLAG-IMPROVE-1",
      },
      { logPath, notify: () => {} },
    );
    expect(note.deliveryNote).toContain("3 review target(s)");
    const entry = JSON.parse(readFileSync(logPath, "utf8"));
    expect(entry.event).toBe("flag_for_review");
    expect(entry.review_targets).toHaveLength(3);
    expect(entry.action_needed).toBe("Review the diff + merge the PR.");
    expect(entry.residual_risks).toContain("opencode schema");
    expect(entry.queue_key).toBe("FLAG-IMPROVE-1");
    expect(entry.self_reviewed).toBe(true);
    rmSync(join(logPath, ".."), { recursive: true, force: true });
  });

  test("defaults: no optionals → only the core fields; a missing log still works", () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "orch-flag-")), "reviews.jsonl");
    const r = flagForReview(
      { summary: "x", risk: "low", blast_radius: "y", review_targets: [], self_reviewed: false, review_method: "none" },
      { logPath, notify: () => {} },
    );
    const entry = JSON.parse(readFileSync(logPath, "utf8"));
    expect(entry.action_needed).toBeUndefined();
    expect(entry.review_targets).toEqual([]);
    expect(r.deliveryNote).toContain("Not self-reviewed");
  });
});
