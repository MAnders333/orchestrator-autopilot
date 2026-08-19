// tick-router.ts — the tick DELIVERY GATE, host-agnostic. Both hosts (the pi
// extension + the opencode plugin) route their ticks through this so the
// machinery is IDENTICAL: same gate conditions (interactive/loaded/busy/
// compacting), same cooldown, same message format. The host supplies what
// each state means in that tool + the deliver mechanism (pi: sendMessage;
// opencode: promptAsync injection).
//
// The MESSAGE is delivered as-is — core.ts's ticks already carry the
// `[orch-tick: <reason>]` prefix (dispatch | intake | review); hosts must not
// add another.

export interface TickHostState {
  /** A live orchestrator session exists (pi: interactive TUI; opencode: a
   *  persistent session, NOT a headless one-shot run). */
  interactive(): boolean;
  /** The orchestrator context is loaded (pi: /orchestrate injected; opencode:
   *  the plugin IS the orchestrator context — always true). */
  loaded(): boolean;
  /** The agent is mid-turn — a tick must wait for idle. */
  busy(): boolean;
  /** Compaction in progress (pi only; opencode reports false). */
  compacting(): boolean;
}

export function createTickRouter(
  host: TickHostState,
  deliver: (message: string) => void,
  cooldownMs = 1500,
): { send(message: string, opts?: { bypassCooldown?: boolean }): "delivered" | "dropped" | "deferred" } {
  let lastSentAt = 0;
  return {
    /** Apply the shared gate; deliver when it passes.
     *  "delivered" — the host accepted the message.
     *  "dropped"   — PERMANENT (interactive/loaded) or a cooldown nudge: the
     *                nudges re-fire on the next sweep; do not hold.
     *  "deferred"  — TRANSIENT (busy/compacting, or the host's deliver threw —
     *                the runtime rejected the send in the busy-not-streaming
     *                window). The runner holds it + flushes at the host's
     *                settle/idle event. */
    send(message: string, opts?: { bypassCooldown?: boolean }): "delivered" | "dropped" | "deferred" {
      if (!host.interactive() || !host.loaded()) return "dropped"; // permanent
      if (host.busy() || host.compacting()) return "deferred"; // transient — hold + flush at settle
      const now = Date.now();
      if (!opts?.bypassCooldown && now - lastSentAt < cooldownMs) return "dropped"; // nudge — re-fires
      lastSentAt = now;
      try {
        deliver(message);
        return "delivered";
      } catch {
        return "deferred"; // the runtime rejected the send — hold + flush at settle
      }
    },
  };
}
