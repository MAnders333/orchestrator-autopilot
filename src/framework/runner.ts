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
import type { Autopilot, CompletionEvent } from "../core.ts";
import { createTickRouter, type TickHostState } from "./tick-router.ts";

export interface RunnerOptions {
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

  const sweep = async (source: "settled" | "activate" | "timer" | "worker-done"): Promise<void> => {
    if (!enabled()) return;
    const fleet = await opts.backend.fleetStatus();
    const result = autopilot.sweep(source, Date.now(), fleet ? { totalActive: fleet.totalActive } : undefined);
    if (result.tick) sendTick(result.tick);
    // timer/activate safety net: stuck reviewing items get a review nudge
    else if (source === "timer" || source === "activate") sendTick(autopilot.reviewTick());
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    onCompletion(ev) {
      const result = autopilot.handleAsyncComplete(ev);
      if (opts.emit) opts.emit(result.domainEvents);
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
