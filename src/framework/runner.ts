// runner.ts — the framework RUNNER: host-agnostic TRIGGER ROUTING + tick
// delivery. Both hosts (pi extension + opencode plugin) wire their tool events
// to these methods; everything about WHAT a trigger does (fleet reconcile →
// sweep → tick → reviewTick fallback → gate → deliver) lives here ONCE.
//
// The hosts keep only the WIRING:
//   - their event sources (pi: async-complete/agent_settled/timer//autopilot;
//     opencode: backend process-exit/session.idle/timer)
//   - their gate-state semantics (interactive/loaded/busy/compacting)
//   - their delivery mechanism (pi: sendMessage; opencode: promptAsync)

import type { SubagentBackend } from "../backends/types.ts";
import type { Autopilot } from "../core.ts";
import type { CompletionEvent } from "../types.ts";
import { loadAutopilotConfig } from "../config.ts";
import { createTickRouter, type TickHostState } from "./tick-router.ts";
import { autoDispatchEligible, autoRedispatch, autoReview } from "./auto-dispatch.ts";

export interface RunnerOptions {
  stateDir: string;
  autopilot: Autopilot;
  backend: SubagentBackend;
  /** The tick delivery gate state (what interactive/loaded/busy/compacting
   *  mean in this host). */
  host: TickHostState;
  /** The host's delivery mechanism (pi sendMessage / opencode promptAsync). */
  deliver: (message: string) => void;
  /** Optional user-message delivery for deferred DIRECT sends (the pi host's
   *  /orchestrate injection + toggle messages; opencode has none). */
  deliverUserMessage?: (message: string, options?: Record<string, unknown>) => void;
  /** Host gate: should triggers run at all right now (pi: autopilot-on for
   *  this session; opencode: always). */
  enabled?: () => boolean;
  /** Domain-event sink (orch:item-completed, orch:verdict, ...). */
  emit?: (events: Array<{ name: string; data?: Record<string, unknown> }>) => void;
  cooldownMs?: number; // min gap between delivered ticks (default 1500)
  /** Periodic sweep interval; 0 disables the timer. */
  sweepIntervalMs: number;
  /** Auto-dispatch + auto re-dispatch (default true; AUTOPILOT_AUTO_DISPATCH=0
   *  disables — a real, working opt-out). The framework fills free slots + re-dispatches FAIL items
   *  itself — the orchestrator keeps the judgment (intake, approval,
   *  high-risk checkpoints). */
  autoDispatch?: boolean;
}

export interface FrameworkRunner {
  /** A run completed (worker done / reviewer done / any session subagent).
   *  pi: subagent:async-complete; opencode: backend process-exit. */
  onCompletion(ev: CompletionEvent): void;
  /** The orchestrator's own turn settled (queue may have changed).
   *  pi: agent_settled; opencode: session.idle. Hash-gated sweep. */
  onSettled(): void;
  /** Periodic re-nudge (bypasses the hash — re-ticks a persistent gap). */
  onTimer(): void;
  /** One activation nudge (pi: /autopilot on; opencode: plugin start). */
  onActivate(): void;
  start(): void;
  stop(): void;
}

export function createFrameworkRunner(opts: RunnerOptions): FrameworkRunner {
  const autopilot = opts.autopilot;
  const router = createTickRouter(opts.host, opts.deliver, opts.cooldownMs);
  const enabled = opts.enabled ?? (() => true);
  // SHARED deferral: messages the runtime rejected (busy-not-streaming —
  // the host's deliver threw) are held here + flushed at the host's
  // settle/idle event (the agent is idle then). This is framework logic;
  // the hosts only wire their idle event to onSettled + supply delivery.
  const deferred: Array<{ message: string; kind: "tick" | "user"; options?: Record<string, unknown> }> = [];
  const queueDeferred = (message: string, kind: "tick" | "user", options?: Record<string, unknown>): void => {
    deferred.push({ message, kind, options });
    flushDeferred();
  };
  const flushDeferred = (): void => {
    if (!deferred.length) return;
    const hold: typeof deferred = [];
    for (const d of deferred) {
      if (d.kind === "user") {
        if (!opts.deliverUserMessage) continue; // no user-delivery on this host
        try {
          opts.deliverUserMessage(d.message, d.options);
        } catch {
          hold.push(d); // still busy — re-flush at the next settle
        }
        continue;
      }
      const r = router.send(d.message, { bypassCooldown: true });
      if (r === "deferred") hold.push(d); // the runtime still rejected it
      // "dropped" (interactive/loaded) — permanent, drop; "delivered" — done
    }
    deferred.length = 0;
    deferred.push(...hold);
  };
  /** Host-facing: defer a DIRECT user-message send (the /orchestrate injection,
   *  the toggle message) — delivered via deliverUserMessage at the settle. */
  const deferUserMessage = (message: string, options?: Record<string, unknown>): void => {
    queueDeferred(message, "user", options);
  };
  const sendTick = (t: { message?: string } | null | undefined): void => {
    if (!t?.message) return;
    const r = router.send(t.message);
    if (r === "deferred") queueDeferred(t.message, "tick");
  };

  // The auto-actions opt-out: env (AUTOPILOT_AUTO_DISPATCH=0) or the option.
  const autoDispatchOn = opts.autoDispatch ?? process.env.AUTOPILOT_AUTO_DISPATCH !== "0";
  const cfg = () => loadAutopilotConfig(opts.stateDir);
  // QUEUED harness info: auto-actions (dispatched / reviewed / re-dispatched)
  // accumulate into ONE consolidated tick, flushed at the next natural boundary
  // (the agent settles / the timer) instead of interrupting mid-turn. If the
  // router drops the flush (busy / cooldown), the parts are requeued — never
  // lost. The orchestrator learns what the harness DID without any gate bypass.
  let pendingHarness: string[] = [];
  let pendingFleet: number | undefined;
  const harnessTick = (parts: string[], fleetTotalActive?: number): void => {
    pendingHarness.push(...parts);
    if (fleetTotalActive !== undefined) pendingFleet = fleetTotalActive;
    flushHarness();
  };
  const flushHarness = (): void => {
    if (!pendingHarness.length) return;
    const parts = pendingHarness;
    pendingHarness = [];
    const fleet = pendingFleet !== undefined ? ` — fleet ${pendingFleet}` : "";
    const r = router.send(
      `[orch-tick: harness] auto: ${parts.join("; ")}.${fleet} Your calls: approvals, high-risk checkpoints, review overrides, flag_for_review. Not a user request; respond ≤2 lines.`,
      { bypassCooldown: true },
    );
    if (r === "deferred") pendingHarness = [...parts, ...pendingHarness]; // runtime rejected — re-flush at the next settle
  };
  const sweep = async (source: "settled" | "activate" | "timer" | "worker-done"): Promise<void> => {
    if (!enabled()) return;
    // The authoritative fleet, fetched ONCE — both the auto-dispatch (A) and
    // the engine sweep use it (one RPC, and the request is emitted synchronously
    // so hosts/replies see it immediately).
    const fleet = await opts.backend.fleetStatus();
    // A — fill free slots with auto-dispatchable items before deciding ticks,
    // so the dispatch nudge fires only for the MANUAL cases (high-risk or
    // incomplete scope/cwd).
    if (source === "worker-done" && autoDispatchOn) {
      try {
        const dispatched = await autoDispatchEligible(opts.stateDir, opts.backend, cfg().maxSlots, fleet?.totalActive);
        if (dispatched.length) harnessTick([`dispatched ${dispatched.map((d) => d.key).join(", ")}`], fleet?.totalActive);
      } catch {
        // silent — the tick still nudges the manual cases
      }
    }
    const result = autopilot.sweep(source, Date.now(), fleet ? { totalActive: fleet.totalActive } : undefined);
    if (result.tick) sendTick(result.tick);
    // timer/activate safety net: stuck reviewing items get a review nudge —
    // the "stuck" wording (reviewers may still be running; never claim completion)
    else if (source === "timer" || source === "activate") sendTick(autopilot.reviewTick(undefined, "stuck"));
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    onCompletion(ev) {
      // The SHARED autopilot gate: when the toggle is off, the harness ignores
      // completions entirely (no flips, no verdict routing, no auto-actions) —
      // the orchestrator reconciles manually. Both hosts inherit this; they
      // must not re-implement the gate in their own handlers.
      if (!enabled()) return;
      const result = autopilot.handleAsyncComplete(ev);
      if (opts.emit) opts.emit(result.domainEvents);
      // B + C, ONE consolidated harness tick. B — a review FAIL
      // auto-re-dispatches with the findings (up to the cap; the engine
      // already flipped to active when attempts < cap). C — a worker
      // completion (active → reviewing) auto-dispatches its review with the
      // SAME fields the dispatch used (KEY + scope + cwd). The orchestrator
      // learns what happened from the single harness tick and can still
      // queue_review/queue_dispatch to override.
      if (autoDispatchOn) {
        const verdict = result.domainEvents.find((e) => e.name === "orch:verdict" && e.data?.verdict === "FAIL");
        const completed = result.domainEvents.find(
          (e) => e.name === "orch:item-completed" && e.data?.outcome === "reviewing",
        );
        const tasks: Array<Promise<{ part: string; ok: boolean }>> = [];
        if (verdict) {
          const findings = (Array.isArray(ev.results) ? ev.results : [])
            .map((r) => (r as { agent?: string; output?: string })?.output ?? "")
            .filter(Boolean)
            .join("\n\n");
          const key = String(verdict.data?.key ?? "");
          if (key && findings) {
            tasks.push(autoRedispatch(opts.stateDir, opts.backend, key, findings).then((ok) => ({ part: `re-dispatched ${key} with findings`, ok })));
          }
        }
        if (completed) {
          const key = String(completed.data?.key ?? "");
          if (key) {
            tasks.push(
              autoReview(opts.stateDir, opts.backend, cfg().reviewerAgents[0] ?? "orchestrator-reviewer", key).then((runId) => ({
                part: `reviewer for ${key}${runId ? ` (run ${String(runId).slice(0, 8)})` : ""}`,
                ok: !!runId,
              })),
            );
          }
        }
        if (tasks.length) {
          void Promise.all(tasks)
            .then((results) => {
              const parts = results.filter((r) => r.ok).map((r) => r.part);
              if (parts.length) harnessTick(parts);
            })
            .catch(() => {
              // silent — the review tick nudges the orchestrator
            });
        }
      }
      
      sendTick(result.tick);
      if (result.freedSlot) {
        // ANY run completing frees a slot → dispatch sweep with the
        // authoritative fleet count.
        void sweep("worker-done");
      }
      if (result.reviewerCompleted) {
        sendTick(autopilot.reviewTick());
      }
    },
    deferUserMessage,
    onSettled() {
      // flush the shared deferral + the queued harness info FIRST (the agent
      // just settled — the busy gate is clear), then the sweep's nudges.
      flushDeferred();
      flushHarness();
      void sweep("settled");
    },
    onTimer() {
      flushDeferred(); // backstop if the agent never settles
      flushHarness();
      try {
        void sweep("timer");
      } catch {
        // never let the timer break the host
      }
    },
    onActivate() {
      flushDeferred();
      flushHarness();
      void sweep("activate");
    },
    start() {
      if (opts.sweepIntervalMs > 0 && !timer) {
        timer = setInterval(() => this.onTimer(), opts.sweepIntervalMs);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
