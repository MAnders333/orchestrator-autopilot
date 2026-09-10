// test/backends/pi-rpc.test.ts — AUTOPILOT-31: the pi backend's rpc() must
// never leave an ARMED TIMER behind, and its timer callback must never touch a
// binding that might not be initialized.
//
// THE BUG: `const timer = setTimeout(() => { unsub(); ... })` was armed BEFORE
// `const unsub = pi.events.on(...)` existed. A bus whose `on` throws left the
// timer armed; timeoutMs later it fired and hit `unsub` in its temporal dead
// zone → `ReferenceError: Cannot access 'unsub' before initialization` thrown
// FROM A TIMER CALLBACK — outside the promise chain, so neither the caller's
// `.catch` nor the runner's fleet guard could contain it and the HOST PROCESS
// died instead of degrading.
//
// The timeout SHAPE is load-bearing and unchanged: a genuine timeout RESOLVES
// `{success:false, error}` (fleetStatus → null); it must never start rejecting,
// because the runner's degraded-episode logic (AUTOPILOT-24) distinguishes a
// null answer from a throw.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiBackend } from "../../src/backends/pi.ts";
import type { PiLike } from "../../src/backends/types.ts";

/** Records every timer the code under test arms, so "no armed timer survives a
 *  failed subscribe" is asserted directly instead of waited out. Nothing real
 *  is scheduled while installed — a captured callback is fired by hand. */
function installTimerRecorder() {
  type Armed = { id: number; fn: (...args: unknown[]) => void; delay: number; cleared: boolean };
  const armed: Armed[] = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let nextId = 1;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number) => {
    const rec: Armed = { id: nextId++, fn, delay: delay ?? 0, cleared: false };
    armed.push(rec);
    return rec.id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const rec = armed.find((a) => a.id === handle);
    if (rec) rec.cleared = true;
    else realClear(handle as ReturnType<typeof setTimeout>);
  }) as unknown as typeof clearTimeout;
  return {
    armed,
    /** timers armed and never cleared — each one WILL fire on a real clock */
    pending: (): Armed[] => armed.filter((a) => !a.cleared),
    fireAll: (): void => {
      for (const a of armed.filter((x) => !x.cleared)) {
        a.cleared = true;
        a.fn();
      }
    },
    restore: (): void => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

/** A bus that replies to the status RPC (the healthy path). */
function replyingPi(totalActive: number): PiLike {
  const handlers: Record<string, Array<(data: unknown) => void>> = {};
  return {
    events: {
      on: (ch: string, h: (data: unknown) => void) => {
        (handlers[ch] ??= []).push(h);
        return () => {
          handlers[ch] = (handlers[ch] ?? []).filter((x) => x !== h);
        };
      },
      emit: (ch: string, payload: unknown) => {
        if (ch !== "subagents:rpc:v1:request") return;
        const req = payload as { requestId: string; method: string };
        for (const h of handlers[`subagents:rpc:v1:reply:${req.requestId}`] ?? []) {
          h({ success: true, data: { fleet: { totalActive } } });
        }
      },
    },
    on: () => {},
  } as unknown as PiLike;
}

/** A bus that accepts the subscription but NEVER replies — the genuine-timeout
 *  path (a pi-subagents runtime that is wedged or not listening). */
function silentPi(): PiLike {
  return {
    events: { on: () => () => {}, emit: () => {} },
    on: () => {},
  } as unknown as PiLike;
}

/** A BROKEN bus: subscribing throws synchronously (the AUTOPILOT-31 trigger —
 *  observed while probing the fleet RPC with a stub bus). */
function subscribeThrowsPi(): PiLike {
  return {
    events: {
      on: () => {
        throw new Error("event bus is down");
      },
      emit: () => {},
    },
    on: () => {},
  } as unknown as PiLike;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-rpc-"));
}

describe("pi backend rpc() — timer safety (AUTOPILOT-31)", () => {
  test("the healthy path still resolves the reply and clears its timer", async () => {
    const root = tempRoot();
    const rec = installTimerRecorder();
    try {
      const backend = createPiBackend(replyingPi(2), { asyncDirRoot: root });
      expect((await backend.fleetStatus())?.totalActive).toBe(2);
      expect(rec.pending()).toEqual([]); // the reply cleared the timeout
    } finally {
      rec.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a genuine timeout still RESOLVES {success:false} — fleetStatus answers null, it never rejects", async () => {
    const root = tempRoot();
    const rec = installTimerRecorder();
    try {
      const backend = createPiBackend(silentPi(), { asyncDirRoot: root });
      const pending = backend.fleetStatus();
      expect(rec.pending().length).toBe(1); // the status RPC armed its timeout…
      expect(rec.pending()[0].delay).toBe(2500);
      rec.fireAll(); // …and firing it is a genuine timeout
      expect(await pending).toBeNull(); // resolve-shape preserved: null, NOT a throw
    } finally {
      rec.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a genuine spawn timeout surfaces the timed-out error message (resolve-shape → caller throw)", async () => {
    const root = tempRoot();
    const rec = installTimerRecorder();
    try {
      const backend = createPiBackend(silentPi(), { asyncDirRoot: root });
      const pending = backend.spawn("task", {});
      expect(rec.pending()[0].delay).toBe(30_000);
      rec.fireAll();
      await expect(pending).rejects.toThrow("spawn RPC timed out");
    } finally {
      rec.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a subscribe that THROWS settles the promise and leaves NO armed timer behind", async () => {
    const root = tempRoot();
    const rec = installTimerRecorder();
    try {
      const backend = createPiBackend(subscribeThrowsPi(), { asyncDirRoot: root });
      await expect(backend.fleetStatus()).rejects.toThrow("event bus is down");
      // the invariant: nothing is left to fire into a dead request later
      expect(rec.pending()).toEqual([]);
      expect(rec.armed.length).toBe(1); // it WAS armed — and it was cleared
      // and even if a timer did survive, its callback must not reference an
      // uninitialized binding (the ReferenceError that killed the host)
      for (const a of rec.armed) expect(() => a.fn()).not.toThrow();
    } finally {
      rec.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an emit that THROWS after a successful subscribe unsubscribes and clears its timer", async () => {
    const root = tempRoot();
    const rec = installTimerRecorder();
    let unsubbed = 0;
    try {
      const pi = {
        events: {
          on: () => () => {
            unsubbed += 1;
          },
          emit: () => {
            throw new Error("emit failed");
          },
        },
        on: () => {},
      } as unknown as PiLike;
      const backend = createPiBackend(pi, { asyncDirRoot: root });
      await expect(backend.fleetStatus()).rejects.toThrow("emit failed");
      expect(rec.pending()).toEqual([]);
      expect(unsubbed).toBe(1); // no orphan subscription either
    } finally {
      rec.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REAL CLOCK: no stray timer kills the host after a failed subscribe (past the 2.5s status window)", async () => {
    const root = tempRoot();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => {
      uncaught.push(e);
    };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
    try {
      const backend = createPiBackend(subscribeThrowsPi(), { asyncDirRoot: root });
      await backend.fleetStatus().then(
        () => expect.unreachable("a broken bus must not answer"),
        (e: unknown) => expect((e as Error).message).toContain("event bus is down"),
      );
      // wait PAST the status RPC's 2500ms window: pre-fix, the orphaned timer
      // fired here with `ReferenceError: Cannot access 'unsub' before
      // initialization` — from a timer callback, i.e. process-fatal.
      await new Promise((r) => setTimeout(r, 2800));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUncaught);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
