// scheduled-off.test.ts — "/autopilot off in <duration>" framework module:
// parser, command semantics through the shared toggle, the due-check backstop
// (injected clock), and the ScheduleManager lifecycle (injected fake timers —
// zero real timers).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDurationMs, MAX_SCHEDULE_MS, scheduledOffDue, createScheduleManager, type TimerPort } from "../../src/framework/scheduled-off.ts";
import { autopilotCommand, readScheduledOffAt, isAutopilotOn, readSessionAutopilotState } from "../../src/config.ts";

describe("parseDurationMs — '<n>s|m|h' + compounds", () => {
  test("valid units and compounds convert to ms", () => {
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("30m")).toBe(1_800_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1h30m")).toBe(5_400_000);
    expect(parseDurationMs("1h30m10s")).toBe(5_410_000);
    expect(parseDurationMs("1.5h")).toBe(5_400_000);
    expect(parseDurationMs(" 45M ")).toBe(2_700_000); // case + whitespace tolerated
    expect(parseDurationMs("24h")).toBe(MAX_SCHEDULE_MS); // cap is inclusive
  });

  test("invalid / zero / negative / over-cap rejected", () => {
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("banana")).toBeNull();
    expect(parseDurationMs("30")).toBeNull(); // missing unit
    expect(parseDurationMs("30x")).toBeNull();
    expect(parseDurationMs("-30m")).toBeNull();
    expect(parseDurationMs("0m")).toBeNull();
    expect(parseDurationMs("0s")).toBeNull();
    expect(parseDurationMs("m30")).toBeNull();
    expect(parseDurationMs("24h1m")).toBeNull(); // over the cap
    expect(parseDurationMs("1h;rm -rf")).toBeNull();
  });
});

describe("autopilotCommand off-in — ONE shared toggle, scheduling semantics", () => {
  let dir: string;
  const SID = "sched-sess";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-schedoff-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("schedule keeps ON + persists the deadline; never reports mode 'off'", () => {
    const now = 1_700_000_000_000;
    const r = autopilotCommand("off", "in 30m", { stateDir: dir, sessionId: SID, now: () => now });
    expect(r.ok).toBe(true);
    expect(r.mode).toBeUndefined(); // DISTINCT signal — scheduling is not an immediate off
    expect(r.scheduledOffAt).toBe(now + 1_800_000);
    expect(isAutopilotOn(dir, SID)).toBe(true); // still ON until the deadline
    expect(readScheduledOffAt(dir, SID)).toBe(r.scheduledOffAt); // rides the EXISTING session entry
    expect(r.message).toContain(new Date(r.scheduledOffAt!).toISOString()); // absolute time visible
    // bare duration value also parses (the opencode tool's value arg)
    const r2 = autopilotCommand("off", "90s", { stateDir: dir, sessionId: SID, now: () => now });
    expect(r2.ok).toBe(true);
    expect(r2.scheduledOffAt).toBe(now + 90_000);
  });

  test("invalid duration rejected without touching state", () => {
    autopilotCommand("on", undefined, { stateDir: dir, sessionId: SID });
    for (const bad of ["in banana", "0m", "25h", "in -5m"]) {
      const r = autopilotCommand("off", bad, { stateDir: dir, sessionId: SID });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("Usage");
    }
    expect(isAutopilotOn(dir, SID)).toBe(true); // untouched
    expect(readScheduledOffAt(dir, SID)).toBeNull();
  });

  test("explicit on/off CLEARS a pending schedule", () => {
    autopilotCommand("off", "in 30m", { stateDir: dir, sessionId: SID });
    expect(readScheduledOffAt(dir, SID)).not.toBeNull();
    autopilotCommand("on", undefined, { stateDir: dir, sessionId: SID });
    expect(readScheduledOffAt(dir, SID)).toBeNull();
    expect(isAutopilotOn(dir, SID)).toBe(true);
    autopilotCommand("off", "in 30m", { stateDir: dir, sessionId: SID });
    expect(readScheduledOffAt(dir, SID)).not.toBeNull();
    autopilotCommand("off", undefined, { stateDir: dir, sessionId: SID });
    expect(readScheduledOffAt(dir, SID)).toBeNull();
    expect(isAutopilotOn(dir, SID)).toBe(false);
  });

  test("re-schedule REPLACES (one deadline per session)", () => {
    const now = 1_700_000_000_000;
    autopilotCommand("off", "in 1h", { stateDir: dir, sessionId: SID, now: () => now });
    const r2 = autopilotCommand("off", "in 15m", { stateDir: dir, sessionId: SID, now: () => now + 60_000 });
    expect(readScheduledOffAt(dir, SID)).toBe(r2.scheduledOffAt);
    expect(r2.scheduledOffAt).toBe(now + 60_000 + 900_000);
  });

  test("status appends the pending deadline; plain status does not", () => {
    const now = 1_700_000_000_000;
    const plain = autopilotCommand("status", undefined, { stateDir: dir, sessionId: SID });
    expect(plain.message).not.toContain("Scheduled OFF");
    autopilotCommand("off", "in 45m", { stateDir: dir, sessionId: SID, now: () => now });
    const st = autopilotCommand("status", undefined, { stateDir: dir, sessionId: SID });
    expect(st.message).toContain("Autopilot ON");
    expect(st.message).toContain(`Scheduled OFF at ${new Date(now + 2_700_000).toISOString()}`);
  });

  test("bare 'off' still takes effect immediately (back-compat)", () => {
    autopilotCommand("off", "in 30m", { stateDir: dir, sessionId: SID });
    const r = autopilotCommand("off", undefined, { stateDir: dir, sessionId: SID });
    expect(r.mode).toBe("off");
    expect(r.scheduledOffAt).toBeUndefined();
    expect(isAutopilotOn(dir, SID)).toBe(false);
  });
});

describe("scheduledOffDue — the backstop due-check (injected clock)", () => {
  let dir: string;
  const SID = "due-sess";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-due-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("past deadline flips OFF + clears the schedule; future is a no-op", () => {
    const now = 1_700_000_000_000;
    autopilotCommand("off", "in 30m", { stateDir: dir, sessionId: SID, now: () => now });
    // before the deadline: nothing happens
    expect(scheduledOffDue(dir, SID, () => now + 29 * 60_000)).toBe(false);
    expect(readSessionAutopilotState(dir, SID)).toBe("on");
    expect(readScheduledOffAt(dir, SID)).not.toBeNull();
    // at/after the deadline: flips OFF + clears
    expect(scheduledOffDue(dir, SID, () => now + 30 * 60_000)).toBe(true);
    expect(readSessionAutopilotState(dir, SID)).toBe("off");
    expect(readScheduledOffAt(dir, SID)).toBeNull();
    // idempotent: already fired → false
    expect(scheduledOffDue(dir, SID, () => now + 31 * 60_000)).toBe(false);
  });

  test("no schedule / no session id → false (never throws)", () => {
    expect(scheduledOffDue(dir, SID)).toBe(false);
    expect(scheduledOffDue(dir, "")).toBe(false);
    expect(scheduledOffDue(join(dir, "does-not-exist"), SID)).toBe(false);
  });
});

describe("createScheduleManager — timer lifecycle (fake timers)", () => {
  /** Deterministic fake timer port: jobs fire only when advance() is called. */
  function fakeTimers() {
    let nowMs = 1_700_000_000_000;
    let seq = 0;
    const jobs = new Map<number, { at: number; fire: () => void }>();
    const port: TimerPort = {
      set(delayMs, fire) {
        const id = ++seq;
        jobs.set(id, { at: nowMs + Math.max(0, delayMs), fire });
        return id;
      },
      clear(handle) {
        jobs.delete(handle as number);
      },
    };
    return {
      timers: port,
      now: () => nowMs,
      tickTo(ms: number) {
        nowMs = ms;
        for (const [id, job] of [...jobs]) {
          if (job.at <= nowMs) {
            jobs.delete(id); // self-disarm first — exactly-once even if fire() reschedules
            job.fire();
          }
        }
      },
      count: () => jobs.size,
    };
  }

  test("arms exactly one timer and fires onFire exactly once at the deadline", () => {
    const ft = fakeTimers();
    const fired: string[] = [];
    const mgr = createScheduleManager({ timers: ft.timers, now: ft.now, onFire: (sid) => fired.push(sid) });
    mgr.schedule("s1", ft.now() + 1_000);
    expect(ft.count()).toBe(1);
    ft.tickTo(ft.now() + 999);
    expect(fired).toEqual([]); // not yet
    ft.tickTo(ft.now() + 1); // deadline reached
    expect(fired).toEqual(["s1"]);
    expect(ft.count()).toBe(0); // self-disarmed
    ft.tickTo(ft.now() + 60_000);
    expect(fired).toEqual(["s1"]); // never twice
  });

  test("replace semantics: re-scheduling clears the old timer", () => {
    const ft = fakeTimers();
    const fired: string[] = [];
    const mgr = createScheduleManager({ timers: ft.timers, now: ft.now, onFire: (sid) => fired.push(sid) });
    mgr.schedule("s1", ft.now() + 1_000);
    mgr.schedule("s1", ft.now() + 5_000); // replaces
    expect(ft.count()).toBe(1); // exactly-one-timer invariant
    ft.tickTo(ft.now() + 1_000);
    expect(fired).toEqual([]); // the OLD deadline did not survive
    ft.tickTo(ft.now() + 4_000);
    expect(fired).toEqual(["s1"]);
  });

  test("cancel disarms; sessions are independent; dispose leaks nothing", () => {
    const ft = fakeTimers();
    const fired: string[] = [];
    const mgr = createScheduleManager({ timers: ft.timers, now: ft.now, onFire: (sid) => fired.push(sid) });
    mgr.schedule("s1", ft.now() + 1_000);
    mgr.schedule("s2", ft.now() + 2_000);
    expect(ft.count()).toBe(2);
    mgr.cancel("s1"); // explicit on/off path
    expect(ft.count()).toBe(1);
    ft.tickTo(ft.now() + 60_000);
    expect(fired).toEqual(["s2"]); // s1 never fired
    mgr.schedule("s3", ft.now() + 1_000);
    mgr.dispose();
    expect(ft.count()).toBe(0);
    ft.tickTo(ft.now() + 60_000);
    expect(fired).toEqual(["s2"]); // s3 never fired either
    expect(mgr.pendingCount()).toBe(0);
  });

  test("an onFire throw is contained; a past deadline fires on the next tick", () => {
    const ft = fakeTimers();
    const mgr = createScheduleManager({
      timers: ft.timers,
      now: ft.now,
      onFire: () => {
        throw new Error("host delivery failed");
      },
    });
    mgr.schedule("s1", ft.now() - 500); // clock skew / restart race
    expect(() => ft.tickTo(ft.now())).not.toThrow(); // contained
    expect(ft.count()).toBe(0);
    // the manager keeps working after a throwing host callback
    mgr.schedule("s2", ft.now() + 100);
    expect(ft.count()).toBe(1);
  });
});
