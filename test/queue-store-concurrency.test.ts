// queue-store-concurrency.test.ts — the LOST-UPDATE race (KEY: AUTOPILOT-30).
//
// saveStore is atomic per write (tmp + rename), so files are never torn. The
// bug was the READ-MODIFY-WRITE WINDOW: loadStore → mutate → saveStore with no
// serialization, so a writer that loaded before another's rename erased it
// whole-file. It cost a fully-specified proposal (with a success receipt) and
// handed the same key out twice.
//
// The writers live in DIFFERENT PROCESSES (pi host, opencode host, tools), so
// these tests use REAL child processes — an in-process simulation could not
// distinguish a cross-process fix from an in-process mutex. The `legacyLoses`
// test is the harness's own control: it runs the PRE-FIX pattern through the
// exact same child-process machinery and asserts the write IS lost. If that
// test ever stops failing-by-design, the concurrency here has gone fake.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  loadStore,
  loadStoreOrNew,
  saveStore,
  newStore,
  addItem,
  updateItem,
  mutateStore,
  storePath,
  type QueueItem,
  type QueueStore,
} from "../src/queue-store.ts";
import { queueAdd, type QueueOpsCtx } from "../src/tools/queue-ops.ts";

const SRC = join(import.meta.dir, "..", "src");

function item(key: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    key,
    status: "approved",
    blocker: null,
    title: `t-${key}`,
    scope: "s",
    cwd: "/repo/x",
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    notes: "",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

// A store big enough that JSON parse+stringify takes REAL milliseconds — that
// is what makes the read-modify-write window wide enough for the race to be
// deterministic rather than a coin flip (the live store is smaller, but the
// window is the same shape; the size only removes the flake).
function seedBigStore(dir: string, items = 400, padBytes = 3000): void {
  const store = newStore();
  const pad = "x".repeat(padBytes);
  // proposals: a big realistic backlog that the auto-dispatch lane leaves alone
  for (let i = 1; i <= items; i++) store.items[`SEED-${i}`] = item(`SEED-${i}`, { status: "proposal", scope: pad, notes: pad });
  saveStore(dir, store);
}

/** One child process = one independent writer, exactly like a second host. All
 *  children busy-wait to the same `startAt` epoch so their windows overlap. */
function writerScript(body: string): string {
  return [
    `import { loadStore, loadStoreOrNew, saveStore, newStore, addItem, updateItem, mutateStore } from ${JSON.stringify(join(SRC, "queue-store.ts"))};`,
    `import { queueAdd } from ${JSON.stringify(join(SRC, "tools", "queue-ops.ts"))};`,
    `const [dir, arg, startAtRaw] = process.argv.slice(2);`,
    `const startAt = Number(startAtRaw);`,
    `while (Date.now() < startAt) {}`, // spin barrier — sub-ms alignment
    body,
  ].join("\n");
}

async function runWriters(dir: string, script: string, args: string[], leadMs = 250): Promise<Array<{ code: number; out: string }>> {
  const scriptPath = join(dir, "writer.ts");
  writeFileSync(scriptPath, script, "utf8");
  const startAt = Date.now() + leadMs;
  const procs = args.map((a) =>
    Bun.spawn([process.execPath, scriptPath, dir, a, String(startAt)], { stdout: "pipe", stderr: "pipe" }),
  );
  return await Promise.all(
    procs.map(async (p) => {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const code = await p.exited;
      return { code, out: `${out}${err}`.trim() };
    }),
  );
}

describe("queue store — concurrent writers (cross-process)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-conc-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("CONTROL: the pre-fix loadStore→mutate→saveStore pattern LOSES a concurrent write", async () => {
    seedBigStore(dir);
    // The exact shape of every writer before this fix: read the whole store,
    // mutate in memory, write the whole store back.
    const results = await runWriters(
      dir,
      writerScript(`
        const store = loadStoreOrNew(dir);
        store.items[arg] = { key: arg, status: "proposal", blocker: null, title: arg, scope: "s", cwd: null,
          evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null, timeoutMs: null,
          attempts: 0, notes: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        saveStore(dir, store);
        console.log("wrote " + arg);
      `),
      ["LOST-A", "LOST-B", "LOST-C", "LOST-D"],
    );
    for (const r of results) expect(r.code).toBe(0); // every writer reported success…
    const items = loadStore(dir)!.items;
    const survived = ["LOST-A", "LOST-B", "LOST-C", "LOST-D"].filter((k) => items[k]);
    expect(survived.length).toBeLessThan(4); // …and at least one write vanished anyway
  });

  test("two concurrent queue_add calls: BOTH items survive, with DISTINCT keys", async () => {
    seedBigStore(dir);
    const results = await runWriters(
      dir,
      writerScript(`
        const r = await queueAdd({ stateDir: dir, storeOrNew: () => loadStoreOrNew(dir) }, { series: "CONC", title: arg });
        console.log(r.text);
      `),
      ["one", "two", "three", "four"],
    );
    for (const r of results) expect(r.out).toContain("added 'CONC-");
    const keys = Object.keys(loadStore(dir)!.items).filter((k) => k.startsWith("CONC-"));
    expect(keys.sort()).toEqual(["CONC-1", "CONC-2", "CONC-3", "CONC-4"]); // no loss, no key REUSE
    const titles = keys.map((k) => loadStore(dir)!.items[k].title).sort();
    expect(titles).toEqual(["four", "one", "three", "two"]);
  });

  test("concurrent add + update: both effects survive", async () => {
    seedBigStore(dir);
    const store = loadStore(dir)!;
    addItem(store, item("TARGET-1", { status: "approved" }));
    saveStore(dir, store);
    const results = await runWriters(
      dir,
      writerScript(`
        if (arg === "add") {
          const r = await queueAdd({ stateDir: dir, storeOrNew: () => loadStoreOrNew(dir) }, { key: "ADDED-1", title: "added by the tool" });
          console.log(r.text);
        } else {
          mutateStore(dir, (s) => updateItem(s, "TARGET-1", { notes: "updated by the other writer" }));
          console.log("updated");
        }
      `),
      ["add", "update"],
    );
    for (const r of results) expect(r.code).toBe(0);
    const items = loadStore(dir)!.items;
    expect(items["ADDED-1"]).toBeDefined();
    expect(items["TARGET-1"].notes).toBe("updated by the other writer");
  });

  test("harness-style status flip racing a tool-style write drops NEITHER change", async () => {
    seedBigStore(dir);
    const store = loadStore(dir)!;
    addItem(store, item("HARNESS-1", { status: "active", runId: "run-1" }));
    addItem(store, item("TOOL-1", { status: "proposal" }));
    saveStore(dir, store);
    const results = await runWriters(
      dir,
      writerScript(`
        if (arg === "harness") {
          // what core.handleAsyncComplete does on a worker completion
          mutateStore(dir, (s) => updateItem(s, "HARNESS-1", { status: "ai-review" }));
        } else {
          mutateStore(dir, (s) => updateItem(s, "TOOL-1", { status: "approved", scope: "s", cwd: "/repo/x" }));
        }
        console.log("ok " + arg);
      `),
      ["harness", "tool"],
    );
    for (const r of results) expect(r.code).toBe(0);
    const items = loadStore(dir)!.items;
    expect(items["HARNESS-1"].status).toBe("ai-review");
    expect(items["TOOL-1"].status).toBe("approved");
  });

  test("THE LIVE INCIDENT: queue_add racing the harness dispatch lane — both survive", async () => {
    // "A queue_add was issued in the SAME parallel tool block as a
    // queue_dispatch": the add returned success and the item never existed.
    // Real entry points on both sides — the tool and the harness lane.
    seedBigStore(dir);
    const store = loadStore(dir)!;
    addItem(store, item("DISPATCH-ME", { status: "approved", risk: "low" }));
    saveStore(dir, store);
    const results = await runWriters(
      dir,
      [
        `import { autoDispatchEligible } from ${JSON.stringify(join(SRC, "framework", "auto-dispatch.ts"))};`,
        writerScript(`
          if (arg === "add") {
            const r = await queueAdd({ stateDir: dir, storeOrNew: () => loadStoreOrNew(dir) }, { key: "PROPOSAL-1", title: "the proposal that vanished" });
            console.log(r.text);
          } else {
            const backend = { spawn: async () => "run-abcdef12", fleetStatus: async () => null };
            const d = await autoDispatchEligible(dir, backend, 3, 0);
            console.log("dispatched " + JSON.stringify(d));
          }
        `),
      ].join("\n"),
      ["add", "dispatch"],
    );
    for (const r of results) expect(r.code).toBe(0);
    const items = loadStore(dir)!.items;
    expect(items["PROPOSAL-1"]).toBeDefined(); // the receipt told the truth
    expect(items["DISPATCH-ME"].status).toBe("active"); // and the dispatch was recorded
    expect(items["DISPATCH-ME"].runId).toBe("run-abcdef12");
  });

  test("a lock STOLEN from a LIVE holder loses no write — every stealer's item survives", async () => {
    // The riskiest branch: the lock is BROKEN OPEN while a live writer holds it,
    // so several writers sit inside the read-modify-write window at the SAME
    // revision. A rev-only compare-and-swap cannot tell their stamps apart —
    // each one re-reads `rev === baseRev + 1` after its write (a COMPETITOR's
    // stamp of the same number satisfies it) and reports success, while only
    // the last rename survives. That is the original incident, reproduced.
    //
    // The steal is FORCED, not hoped for: a planted lock held by a live pid on
    // a FOREIGN host defeats both cheap release checks (fresh timestamp, so not
    // stale; wrong machine, so the pid-liveness test is skipped). Every writer
    // therefore burns its whole wait budget and then breaks the lock open, and
    // the short hold inside the first `apply` lines their writes up.
    seedBigStore(dir);
    writeFileSync(
      `${storePath(dir)}.lock`,
      JSON.stringify({ pid: process.pid, host: `foreign-${hostname()}`, at: Date.now(), nonce: "planted-live-foreign-holder" }),
      "utf8",
    );
    const keys = ["STEAL-A", "STEAL-B", "STEAL-C", "STEAL-D"];
    const results = await runWriters(
      dir,
      writerScript(`
        let held = false;
        mutateStore(dir, (s) => {
          if (!held) {                        // ONLY the first attempt holds the window
            held = true;                      // open — retries must not re-pay it, or the
            const until = Date.now() + 250;   // later writers time out waiting for the lock
            while (Date.now() < until) {}
          }
          s.items[arg] = { key: arg, status: "proposal", blocker: null, title: arg, scope: "", cwd: null,
            evidence: "", value: "", urgency: "", risk: "low", runId: null, reviewerRunId: null,
            timeoutMs: null, attempts: 0, notes: "",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        }, { lockWaitMs: 1_000 });
        console.log("ok " + arg);
      `),
      keys,
    );
    for (const r of results) expect(r.code).toBe(0); // every writer reported success…
    const items = loadStore(dir)!.items;
    expect(keys.filter((k) => items[k])).toEqual(keys); // …and every write is actually on disk
  });

  test("a slow mutation (window held open) still cannot be clobbered by a second process", async () => {
    seedBigStore(dir, 50, 100);
    const results = await runWriters(
      dir,
      writerScript(`
        mutateStore(dir, (s) => {
          const until = Date.now() + Number(arg.split(":")[1]);
          while (Date.now() < until) {}       // hold the read-modify-write window open
          s.items[arg.split(":")[0]] = { key: arg.split(":")[0], status: "proposal", blocker: null, title: "t",
            scope: "", cwd: null, evidence: "", value: "", urgency: "", risk: "low", runId: null,
            reviewerRunId: null, timeoutMs: null, attempts: 0, notes: "",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        });
        console.log("ok " + arg);
      `),
      ["SLOW-A:400", "SLOW-B:400"],
    );
    for (const r of results) expect(r.code).toBe(0);
    const items = loadStore(dir)!.items;
    expect(items["SLOW-A"]).toBeDefined();
    expect(items["SLOW-B"]).toBeDefined();
  });
});

describe("queue store — compare-and-swap and lock recovery (in-process)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-cas-"));
    const store = newStore();
    addItem(store, item("CAS-1"));
    saveStore(dir, store);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A foreign writer that does NOT participate in the protocol (the legacy
   *  loadStore→saveStore pair) writing underneath a pending mutation. */
  function foreignWrite(mutate: (s: QueueStore) => void): void {
    const s = loadStoreOrNew(dir);
    mutate(s);
    s.rev = (s.rev ?? 0) + 1;
    saveStore(dir, s);
  }

  test("a stale read RETRIES against the fresh store instead of clobbering it", () => {
    let attempts = 0;
    const applied = mutateStore(dir, (s) => {
      attempts++;
      if (attempts === 1) foreignWrite((f) => addItem(f, item("FOREIGN-1"))); // written underneath us
      updateItem(s, "CAS-1", { notes: `attempt ${attempts}` });
      return attempts;
    });
    expect(applied).toBe(2); // the first attempt was overtaken and re-applied
    const items = loadStore(dir)!.items;
    expect(items["FOREIGN-1"]).toBeDefined(); // the foreign write SURVIVED
    expect(items["CAS-1"].notes).toBe("attempt 2"); // and ours landed on top of it
  });

  test("bounded-retry exhaustion THROWS instead of silently proceeding", () => {
    let attempts = 0;
    expect(() =>
      mutateStore(
        dir,
        (s) => {
          attempts++;
          foreignWrite((f) => addItem(f, item(`FOREIGN-${attempts}`))); // never lets us win
          updateItem(s, "CAS-1", { notes: "mine" });
        },
        { maxAttempts: 3 },
      ),
    ).toThrow(/ABORTED after 3 attempts/);
    expect(attempts).toBe(3);
    expect(loadStore(dir)!.items["CAS-1"].notes).toBe(""); // nothing of ours was written
  });

  test("rev backfills on read for a pre-rev store and increments per mutation", () => {
    const legacy = { version: 1, items: { OLD: item("OLD") } } as unknown as QueueStore;
    saveStore(dir, legacy);
    expect(loadStore(dir)!.rev).toBe(0); // backfilled, like reviewerRunId
    mutateStore(dir, (s) => updateItem(s, "OLD", { notes: "a" }));
    expect(loadStore(dir)!.rev).toBe(1);
    mutateStore(dir, (s) => updateItem(s, "OLD", { notes: "b" }));
    expect(loadStore(dir)!.rev).toBe(2);
    expect(loadStore(dir)!.items["OLD"].notes).toBe("b"); // item semantics unchanged
  });

  test("a STALE lock (dead pid) is recovered, not waited on", () => {
    const lock = `${storePath(dir)}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 999_999_998, host: hostname(), at: Date.now() }), "utf8");
    const started = Date.now();
    mutateStore(dir, (s) => updateItem(s, "CAS-1", { notes: "after dead-pid lock" }), { lockWaitMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(2_000); // no waiting on a corpse
    expect(loadStore(dir)!.items["CAS-1"].notes).toBe("after dead-pid lock");
    expect(existsSync(lock)).toBe(false);
  });

  test("an ABANDONED lock (old timestamp) is broken open within the stale timeout", () => {
    const lock = `${storePath(dir)}.lock`;
    // a LIVE pid (ours) — only the age says it is abandoned
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() - 60_000 }), "utf8");
    const started = Date.now();
    mutateStore(dir, (s) => updateItem(s, "CAS-1", { notes: "after stale lock" }), { lockStaleMs: 5_000, lockWaitMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(loadStore(dir)!.items["CAS-1"].notes).toBe("after stale lock");
  });

  test("a garbage lock file never wedges the store — but is not broken open on sight either", () => {
    // An UNREADABLE lock is not proof of abandonment (it is also what a lock
    // looks like while it is being created), so it gets a short grace before it
    // is broken open. Without the grace, a contender deletes a lock its live
    // owner is still writing into and two writers share the window.
    writeFileSync(`${storePath(dir)}.lock`, "not json at all", "utf8");
    const started = Date.now();
    mutateStore(dir, (s) => updateItem(s, "CAS-1", { notes: "after garbage lock" }));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(200); // waited out the grace
    expect(elapsed).toBeLessThan(2_000); // and still never wedged
    expect(loadStore(dir)!.items["CAS-1"].notes).toBe("after garbage lock");
  });

  test("a lock STOLEN mid-window is detected: the write is re-applied, never reported as landed", () => {
    // The steal that the wait-budget path performs on a LIVE holder, staged
    // deterministically: a contender replaces our lock while we are inside the
    // read-modify-write window. `rev` alone cannot see this (the thief stamps
    // the same rev+1 we would), so the writer must recognise that the window is
    // no longer its own and re-apply on the fresh store.
    let attempts = 0;
    mutateStore(
      dir,
      (s) => {
        attempts++;
        if (attempts === 1) {
          const lock = `${storePath(dir)}.lock`;
          writeFileSync(
            lock,
            JSON.stringify({ pid: process.pid, host: `foreign-${hostname()}`, at: Date.now(), nonce: "the-thief" }),
            "utf8",
          );
        }
        updateItem(s, "CAS-1", { notes: `attempt ${attempts}` });
      },
      { lockWaitMs: 200 },
    );
    expect(attempts).toBe(2); // the stolen attempt was NOT trusted
    const after = loadStore(dir)!;
    expect(after.rev).toBe(1); // exactly one write landed — the stolen one never wrote
    expect(after.items["CAS-1"].notes).toBe("attempt 2");
    expect(after.revBy).toContain(`${process.pid}@`); // stamped with OUR write identity
  });

  test("a competitor's stamp of the same rev is not accepted as our own write", () => {
    // The bare-rev check `diskRev === baseRev + 1` is satisfied by ANY writer's
    // stamp of that number. The store therefore records WHO wrote the revision,
    // and a foreign nonce at our expected rev reads as a conflict.
    mutateStore(dir, (s) => updateItem(s, "CAS-1", { notes: "ours" }));
    const mine = loadStore(dir)!.revBy!;
    expect(mine).toMatch(/^\d+@.+:[0-9a-f]{16}$/);
    let attempts = 0;
    mutateStore(dir, (s) => {
      attempts++;
      if (attempts === 1) foreignWrite((f) => addItem(f, item("FOREIGN-SAME-REV"))); // rev 2, someone else's nonce
      updateItem(s, "CAS-1", { notes: `attempt ${attempts}` });
    });
    expect(attempts).toBe(2);
    const after = loadStore(dir)!;
    expect(after.revBy).not.toBe(mine); // a fresh identity per write
    expect(after.items["FOREIGN-SAME-REV"]).toBeDefined(); // the competitor's write survived
    expect(after.items["CAS-1"].notes).toBe("attempt 2");
  });

  test("an exception from the mutation propagates and writes NOTHING", () => {
    const before = readFileSync(storePath(dir), "utf8");
    expect(() => mutateStore(dir, () => { throw new Error("boom"); })).toThrow("boom");
    expect(readFileSync(storePath(dir), "utf8")).toBe(before);
    expect(existsSync(`${storePath(dir)}.lock`)).toBe(false); // released in finally
  });
});

describe("queue_add — no false success", () => {
  let dir: string;
  let ctx: QueueOpsCtx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-add-"));
    mkdirSync(dir, { recursive: true });
    ctx = { stateDir: dir, storeOrNew: () => loadStoreOrNew(dir) } as unknown as QueueOpsCtx;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an add that cannot be persisted reports FAILURE, never 'added'", async () => {
    // An unwritable state dir (a FILE where the directory should be) makes the
    // write impossible — the tool must surface that, not hand back a receipt.
    writeFileSync(join(dir, "blocker"), "x", "utf8");
    const r = await queueAdd({ ...ctx, stateDir: join(dir, "blocker", "state") } as QueueOpsCtx, { title: "doomed" });
    expect(r.text).not.toContain("added '");
    expect(r.text).toContain("queue_add failed");
  });

  test("the add path VERIFIES the item is in the persisted store before reporting success", async () => {
    const r = await queueAdd(ctx, { series: "V", title: "verified" });
    expect(r.text).toBe("added 'V-1' (proposal)");
    expect(loadStore(dir)!.items["V-1"]).toBeDefined();
  });
});
