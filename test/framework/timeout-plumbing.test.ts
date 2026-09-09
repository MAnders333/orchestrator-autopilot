// test/framework/timeout-plumbing.test.ts — the timeout-budget regression
// tests (KEY: AUTOPILOT-WORKTREE-PRESERVATION, fix 2). The historical gap:
// queue_dispatch documented passing timeoutMs to the spawned run, and the
// manual lane did forward it — but a budget had NOWHERE to live on the item,
// so every harness lane (auto-dispatch, review-FAIL re-dispatch, auto-review)
// spawned at the runtime default instead of the requested budget (observed
// 2026-08-23: children died at 1800000ms/28800000ms defaults; 43200000ms was
// requested). These tests assert effective budget == request on EVERY lane,
// end to end through backend.spawn — plus the pi backend's workflowScript
// embedding (the last hop into the runtime child).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Autopilot } from "../../src/core.ts";
import { loadAutopilotConfig } from "../../src/config.ts";
import { newStore, addItem, loadStoreOrNew, saveStore, updateItem } from "../../src/queue-store.ts";
import type { QueueStore } from "../../src/queue-store.ts";
import {
  queueAdd,
  queueUpdate,
  queueDispatch,
  queueReview,
  normalizeTimeoutMs,
  type QueueOpsCtx,
} from "../../src/tools/queue-ops.ts";
import { autoDispatchEligible, autoRedispatch, autoReview } from "../../src/framework/auto-dispatch.ts";
import { createPiBackend } from "../../src/backends/pi.ts";
import type { PiLike, SubagentBackend } from "../../src/backends/types.ts";

const REQUESTED = 43_200_000; // the observed incident request (12h)

function capturingBackend(runId = "run-timeout-1"): { backend: SubagentBackend; calls: Array<{ task: string; opts: Record<string, unknown> }> } {
  const calls: Array<{ task: string; opts: Record<string, unknown> }> = [];
  return {
    calls,
    backend: {
      spawn: async (task, opts) => {
        calls.push({ task, opts: opts as Record<string, unknown> });
        return runId;
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

function seedStore(stateDir: string, over: Record<string, unknown>): void {
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
    timeoutMs: null,
    attempts: 0,
    notes: "",
    ...over,
  });
  saveStore(stateDir, store);
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "orch-timeout-"));
}

describe("timeout plumbing — the requested budget reaches the child on every lane", () => {
  test("normalizeTimeoutMs: positive finite passes; 0/negative/NaN/non-number → null", () => {
    expect(normalizeTimeoutMs(43_200_000)).toBe(43_200_000);
    expect(normalizeTimeoutMs(0)).toBeNull();
    expect(normalizeTimeoutMs(-5)).toBeNull();
    expect(normalizeTimeoutMs(Number.NaN)).toBeNull();
    expect(normalizeTimeoutMs("12000")).toBeNull();
    expect(normalizeTimeoutMs(undefined)).toBeNull();
  });

  test("queue_add / queue_update persist a normalized budget", async () => {
    const dir = freshDir();
    const { backend } = capturingBackend();
    const ctx = opsCtx(dir, backend);
    await queueAdd(ctx, { key: "T-1", title: "t", status: "approved", scope: "s", cwd: "/repo", timeoutMs: REQUESTED });
    expect(loadStoreOrNew(dir).items["T-1"].timeoutMs).toBe(REQUESTED);
    // invalid values are treated as unset (null), not stored raw
    await queueUpdate(ctx, { key: "T-1", timeoutMs: 0 });
    expect(loadStoreOrNew(dir).items["T-1"].timeoutMs).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("manual queue_dispatch with timeoutMs: spawn gets the request AND it is persisted for re-dispatch/review", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend();
    seedStore(dir, {});
    const r = await queueDispatch(opsCtx(dir, backend), { key: "K-1", task: "KEY: K-1\nwork", timeoutMs: REQUESTED });
    expect(r.text).toContain("dispatched");
    expect(calls[0].opts.timeoutMs).toBe(REQUESTED);
    expect(loadStoreOrNew(dir).items["K-1"].timeoutMs).toBe(REQUESTED); // recorded at dispatch time
    rmSync(dir, { recursive: true, force: true });
  });

  test("harness-style dispatch without a param inherits the item's recorded budget", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend();
    seedStore(dir, { timeoutMs: REQUESTED });
    await queueDispatch(opsCtx(dir, backend), { key: "K-1", task: "KEY: K-1\nwork" });
    expect(calls[0].opts.timeoutMs).toBe(REQUESTED);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no budget anywhere → undefined passthrough (the runtime DEFAULT_ASYNC_TIMEOUT_MS stays the fallback)", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend();
    seedStore(dir, {});
    await queueDispatch(opsCtx(dir, backend), { key: "K-1", task: "work" });
    expect(calls[0].opts.timeoutMs).toBeUndefined();
    expect("timeoutMs" in calls[0].opts ? calls[0].opts.timeoutMs : undefined).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an explicit dispatch param overrides the item's recorded budget", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend();
    seedStore(dir, { timeoutMs: 1000 });
    await queueDispatch(opsCtx(dir, backend), { key: "K-1", task: "work", timeoutMs: REQUESTED });
    expect(calls[0].opts.timeoutMs).toBe(REQUESTED);
    rmSync(dir, { recursive: true, force: true });
  });

  test("queue_review: explicit param wins, else the item's recorded budget rides to the reviewer", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend("rev-run-1");
    seedStore(dir, { status: "ai-review", timeoutMs: REQUESTED });
    await queueReview(opsCtx(dir, backend), { key: "K-1" });
    expect(calls[0].opts.timeoutMs).toBe(REQUESTED);
    await queueReview(opsCtx(dir, backend), { key: "K-1", task: "re-review" }).catch(() => {}); // already has reviewerRunId — skipped
    rmSync(dir, { recursive: true, force: true });

    // explicit override lane (fresh store, no recorded budget)
    const dir2 = freshDir();
    const b2 = capturingBackend("rev-run-2");
    seedStore(dir2, { status: "ai-review" });
    await queueReview(opsCtx(dir2, b2.backend), { key: "K-1", timeoutMs: 5000 });
    expect(b2.calls[0].opts.timeoutMs).toBe(5000);
    rmSync(dir2, { recursive: true, force: true });
  });

  test("autoDispatchEligible passes the item's budget (the historical drop point)", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend();
    seedStore(dir, { timeoutMs: REQUESTED });
    const dispatched = await autoDispatchEligible(dir, backend, 3, 0);
    expect(dispatched.map((d) => d.key)).toContain("K-1");
    expect(calls[0].opts.timeoutMs).toBe(REQUESTED);
    rmSync(dir, { recursive: true, force: true });
  });

  test("autoRedispatch (review FAIL) passes the item's budget", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend("redo-run-1");
    seedStore(dir, { status: "active", runId: "old-run", timeoutMs: REQUESTED });
    const ok = await autoRedispatch(dir, backend, "K-1", "fix the schema");
    expect(ok).toBe(true);
    expect(calls[0].opts.timeoutMs).toBe(REQUESTED);
    rmSync(dir, { recursive: true, force: true });
  });

  test("autoReview passes the item's budget — the SAME fields the dispatch used", async () => {
    const dir = freshDir();
    const { backend, calls } = capturingBackend("review-auto-1");
    seedStore(dir, { status: "ai-review", timeoutMs: REQUESTED });
    const runId = await autoReview(dir, backend, "orchestrator-reviewer", "K-1");
    expect(runId).toBe("review-auto-1");
    expect(calls[0].opts.agent).toBe("orchestrator-reviewer");
    expect(calls[0].opts.timeoutMs).toBe(REQUESTED);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pi backend workflowScript — the requested budget is embedded in the child launch", () => {
  interface CapturedRequest { requestId: string; params: Record<string, unknown>; }
  function mockPiCapturingRpc() {
    const requests: CapturedRequest[] = [];
    const pending = new Map<string, (reply: unknown) => void>();
    const pi = {
      events: {
        emit: (_name: string, payload: unknown) => {
          const p = payload as { requestId?: string; params?: Record<string, unknown> };
          if (p?.requestId) {
            requests.push({ requestId: p.requestId, params: p.params ?? {} });
            if (pending.has(p.requestId)) {
              const h = pending.get(p.requestId)!;
              pending.delete(p.requestId);
              h({ success: true, data: { runId: "script-run-1" } });
            }
          }
        },
        on: (event: string, handler: (reply: unknown) => void) => {
          const m = event.match(/^subagents:rpc:v1:reply:(.+)$/);
          if (m) pending.set(m[1], handler);
          return () => {};
        },
      },
    } as unknown as PiLike;
    return { pi, requests };
  }

  function childParamsOf(script: string): Record<string, unknown> {
    const m = script.match(/^return runs\.run\("main", (.*)\)$/s);
    expect(m).toBeTruthy();
    return JSON.parse(m![1]) as Record<string, unknown>;
  }

  test("spawn embeds timeoutMs into runs.run childParams when requested", async () => {
    const { pi, requests } = mockPiCapturingRpc();
    const backend = createPiBackend(pi);
    await backend.spawn("the task", { cwd: "/repo", worktree: true, timeoutMs: REQUESTED });
    expect(requests.length).toBe(1);
    const script = requests[0].params.workflowScript as string;
    const child = childParamsOf(script);
    expect(child.timeoutMs).toBe(REQUESTED);
    expect(child.worktree).toBe(true);
    expect(child.cwd).toBe("/repo");
  });

  test("no requested budget → no timeoutMs field in childParams (runtime default applies)", async () => {
    const { pi, requests } = mockPiCapturingRpc();
    const backend = createPiBackend(pi);
    await backend.spawn("the task", { worktree: true });
    const child = childParamsOf(requests[0].params.workflowScript as string);
    expect(child.timeoutMs).toBeUndefined();
  });
});
