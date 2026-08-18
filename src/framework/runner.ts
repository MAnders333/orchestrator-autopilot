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
  const sendTick = (t: { message?: string } | null | undefined): void => {
    if (t?.message) router.send(t.message);
  };

  // The auto-actions opt-out: env (AUTOPILOT_AUTO_DISPATCH=0) or the option.
  const autoDispatchOn = opts.autoDispatch ?? process.env.AUTOPILOT_AUTO_DISPATCH !== "0";
  const cfg = () => loadAutopilotConfig(opts.stateDir);
  // ONE consolidated informational tick per pass — the orchestrator learns
  // what the harness DID (dispatched / reviewed / re-dispatched), not one
  // message per action. The router's gate + cooldown still apply.
  const harnessTick = (parts: string[], fleetTotalActive?: number): void => {
    if (!parts.length) return;
    const fleet = fleetTotalActive !== undefined ? ` — fleet ${fleetTotalActive}` : "";
    // priority: the harness event tick is a state update the orchestrator must
    // see — it bypasses the cooldown (still gated on interactive/loaded/busy).
    router.send(
      `[orch-tick: harness] auto: ${parts.join("; ")}${fleet}. Your calls: approvals, high-risk checkpoints, review overrides, flag_for_review. Not a user request; respond ≤2 lines.`,
      { priority: true },
    );
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
    onSettled() {
      void sweep("settled");
    },
    onTimer() {
      try {
        void sweep("timer");
      } catch {
        // never let the timer break the host
      }
    },
    onActivate() {
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
