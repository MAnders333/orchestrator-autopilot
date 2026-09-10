// test/framework/run-budget.test.ts — AUTOPILOT-47 PROBLEM A. The historical
// gap: an item could carry timeoutMs=7200000, the dispatch could pass 7200000
// to backend.spawn, and the child would STILL be killed at 1800000ms because
// pi-subagents builds the runner STEP budget from the agent's defaultTimeoutMs
// (else its 30-minute DEFAULT_ASYNC_TIMEOUT_MS) and enforces the MINIMUM of
// that and the requested deadline. The plumbing tests (timeout-plumbing.test.ts)
// prove the request reaches the spawn; these prove the DISPATCH RECEIPT tells
// the truth about what the runtime will honour, instead of accepting a budget
// it silently halves.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { loadAutopilotConfig } from "../../src/config.ts";
import { newStore, addItem, loadStoreOrNew, saveStore, type QueueStore } from "../../src/queue-store.ts";
import { queueDispatch, type QueueOpsCtx } from "../../src/tools/queue-ops.ts";
import type { SubagentBackend } from "../../src/backends/types.ts";
import {
  RUNTIME_STEP_BUDGET_CEILING_MS,
  assessRequestedBudget,
  budgetCeilingWarning,
} from "../../src/framework/run-budget.ts";
import { formatDurationMs } from "../../src/duration.ts";

/** The AUTOPILOT-32 incident budget: 2h requested, 30m delivered. */
const INCIDENT_REQUEST_MS = 7_200_000;

function backendStub(): { backend: SubagentBackend; opts: Array<Record<string, unknown>> } {
  const opts: Array<Record<string, unknown>> = [];
  return {
    opts,
    backend: {
      spawn: async (_task, o) => {
        opts.push(o as Record<string, unknown>);
        return "run-budget-1";
      },
      fleetStatus: async () => ({ totalActive: 0 }),
      steer: async () => "req-1",
      asyncDirFor: () => null,
    },
  };
}

function opsCtx(stateDir: string, backend: SubagentBackend): QueueOpsCtx {
  return {
    stateDir,
    backend,
    storeOrNew: () => loadStoreOrNew(stateDir),
    autopilot: () => new Autopilot({ stateDir }),
    cfg: () => loadAutopilotConfig(stateDir),
    emit: () => {},
    repoCheck: async () => ({ ok: true }),
    sessionCwd: tmpdir(),
  };
}

function seed(stateDir: string, timeoutMs: number | null): void {
  const store: QueueStore = newStore();
  addItem(store, {
    key: "K-1",
    title: "k1",
    status: "approved",
    blocker: null,
    scope: "do the thing",
    cwd: tmpdir(),
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    timeoutMs,
    attempts: 0,
    notes: "",
  });
  saveStore(stateDir, store);
}

describe("run budget — a budget the runtime cannot honour is never accepted in silence", () => {
  test("assessRequestedBudget: above the ceiling truncates, at/below it does not, absent is not a promise", () => {
    const over = assessRequestedBudget(INCIDENT_REQUEST_MS);
    expect(over.truncated).toBe(true);
    expect(over.requestedMs).toBe(INCIDENT_REQUEST_MS);
    expect(over.effectiveMs).toBe(RUNTIME_STEP_BUDGET_CEILING_MS);

    expect(assessRequestedBudget(RUNTIME_STEP_BUDGET_CEILING_MS).truncated).toBe(false);
    expect(assessRequestedBudget(600_000).effectiveMs).toBe(600_000);
    for (const absent of [null, undefined, 0, -1, Number.NaN]) {
      const a = assessRequestedBudget(absent as number | null | undefined);
      expect(a.truncated).toBe(false);
      expect(a.effectiveMs).toBeNull();
    }
  });

  test("budgetCeilingWarning: names both numbers and the kill message; empty for an honourable budget", () => {
    const warning = budgetCeilingWarning(assessRequestedBudget(INCIDENT_REQUEST_MS), formatDurationMs);
    expect(warning).toContain("BUDGET NOT HONOURED");
    expect(warning).toContain(String(INCIDENT_REQUEST_MS));
    expect(warning).toContain(String(RUNTIME_STEP_BUDGET_CEILING_MS));
    // the exact string the operator will find in the dead run's status.json
    expect(warning).toContain(`Subagent timed out after ${RUNTIME_STEP_BUDGET_CEILING_MS}ms`);
    expect(budgetCeilingWarning(assessRequestedBudget(600_000), formatDurationMs)).toBe("");
  });

  test("queue_dispatch WARNS LOUDLY when the requested timeoutMs cannot be honoured (AUTOPILOT-32's 2h)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-run-budget-"));
    try {
      seed(dir, INCIDENT_REQUEST_MS);
      const { backend, opts } = backendStub();
      const res = await queueDispatch(opsCtx(dir, backend), { key: "K-1", task: "work" });
      // the request still rides the spawn (plumbing unchanged) …
      expect(opts[0]?.timeoutMs).toBe(INCIDENT_REQUEST_MS);
      // … but the receipt no longer pretends it will be honoured
      expect(res.text).toContain("BUDGET NOT HONOURED");
      expect(res.text).toContain(String(RUNTIME_STEP_BUDGET_CEILING_MS));
      expect(res.details).toMatchObject({
        budgetTruncated: true,
        requestedTimeoutMs: INCIDENT_REQUEST_MS,
        effectiveTimeoutMs: RUNTIME_STEP_BUDGET_CEILING_MS,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("queue_dispatch stays quiet for an honourable budget and for no budget at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-run-budget-ok-"));
    try {
      seed(dir, 900_000);
      const { backend } = backendStub();
      const ok = await queueDispatch(opsCtx(dir, backend), { key: "K-1", task: "work" });
      expect(ok.text).not.toContain("BUDGET NOT HONOURED");
      expect(ok.details).not.toHaveProperty("budgetTruncated");

      const dir2 = mkdtempSync(join(tmpdir(), "orch-run-budget-none-"));
      try {
        seed(dir2, null);
        const none = await queueDispatch(opsCtx(dir2, backendStub().backend), { key: "K-1", task: "work" });
        expect(none.text).not.toContain("BUDGET NOT HONOURED");
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
