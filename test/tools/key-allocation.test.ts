// test/tools/key-allocation.test.ts — Jira-style sequential queue ids.
// The hand-allocation era produced duplicate series numbers ("multiple
// B-49 items"): humans eyeball counters and miss the suffixed keys
// (B5-NAME, B20-REMAINING). The harness allocates instead: PREFIX-<max+1>
// scanning ALL keys of the series, guaranteed free.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStore, addItem, saveStore, loadStore } from "../../src/queue-store.ts";
import type { QueueStore, QueueItem } from "../../src/queue-store.ts";
import { nextKeyFor, queueAdd, type QueueOpsCtx } from "../../src/tools/queue-ops.ts";

function item(key: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    status: "approved",
    blocker: null,
    title: "t",
    scope: "",
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    attempts: 0,
    notes: "",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...over,
    key,
  };
}

describe("nextKeyFor — sequential series allocation", () => {
  test("first item in a series → PREFIX-1", () => {
    expect(nextKeyFor(newStore(), "B")).toBe("B-1");
  });

  test("counts SUFFIXED keys of the series (B5-NAME counts as 5) — the duplicate-B-49 class", () => {
    const s = newStore();
    for (const k of ["B1-SETUP", "B5-TRADEMARK-KNOCKOUT", "B20-REMAINING"]) addItem(s, item(k));
    expect(nextKeyFor(s, "B")).toBe("B-21");
  });

  test("plain-numbered keys count too, and gaps close", () => {
    const s = newStore();
    for (const k of ["B-4", "B-7"]) addItem(s, item(k));
    expect(nextKeyFor(s, "B")).toBe("B-8");
  });

  test("series are independent — EVAL-EXPT does not inflate B", () => {
    const s = newStore();
    addItem(s, item("B3-THING"));
    addItem(s, item("EVAL-EXPT-M9"));
    expect(nextKeyFor(s, "B")).toBe("B-4");
    // allocated keys are PLAIN sequential — preserving exotic M-milestone letters is what explicit keys are for
    expect(nextKeyFor(s, "EVAL-EXPT")).toBe("EVAL-EXPT-10");
  });

  test("result is guaranteed free even after a manual PREFIX-N claim", () => {
    const s = newStore();
    addItem(s, item("B-7"));
    addItem(s, item("B-8"));
    expect(nextKeyFor(s, "B")).toBe("B-9");
  });

  test("prefix characters are sanitized (no regex injection through the series name)", () => {
    const s = newStore();
    addItem(s, item("Q1-WEIRD"));
    // "Q(.*)" sanitizes to series Q — and Q1-WEIRD legitimately counts as 1
    expect(nextKeyFor(s, "Q(.*)")).toBe("Q-2");
    expect(nextKeyFor(s, "R")).toBe("R-1"); // other series untouched
  });
});

describe("queue_add — key auto-allocation", () => {
  let dir: string;
  let ctx: QueueOpsCtx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keyalloc-"));
    ctx = {
      stateDir: dir,
      backend: {} as never,
      storeOrNew: () => loadStore(dir) ?? newStore(),
      autopilot: () => null as never,
      cfg: () => null as never,
      emit: () => {},
      repoCheck: async () => ({ ok: true }),
      sessionCwd: tmpdir(),
    } as unknown as QueueOpsCtx;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const store = (): QueueStore => JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as QueueStore;

  test("omitted key + series → sequential PREFIX-N; repeated adds increment", async () => {
    const r1 = await queueAdd(ctx, { series: "B", title: "first" });
    expect(r1.text).toContain("B-1");
    const r2 = await queueAdd(ctx, { series: "B", title: "second" });
    expect(r2.text).toContain("B-2");
    expect(store().items["B-1"]).toBeDefined();
    expect(store().items["B-2"]).toBeDefined();
  });

  test("omitted key with no series → default Q series", async () => {
    const r = await queueAdd(ctx, { title: "generic" });
    expect(r.text).toContain("Q-1");
  });

  test("explicit key still wins and must be unique; collision errors mention auto-allocation", async () => {
    const ok = await queueAdd(ctx, { key: "MY-SEMANTIC-KEY", title: "x" });
    expect(ok.text).toContain("MY-SEMANTIC-KEY");
    const dup = await queueAdd(ctx, { key: "MY-SEMANTIC-KEY", title: "y" });
    expect(dup.text).toContain("already exists");
    expect(dup.text).toContain("auto-allocate");
  });

  test("allocation counts existing suffixed keys of the series (the live-store scenario)", async () => {
    const s = ctx.storeOrNew();
    addItem(s, item("B48-EARLIER"));
    saveStore(dir, s);
    const r = await queueAdd(ctx, { series: "B", title: "next in line" });
    expect(r.text).toContain("B-49"); // singular — the duplicate-B-49 era is over
  });
});
