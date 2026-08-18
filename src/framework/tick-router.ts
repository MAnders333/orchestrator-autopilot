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
): { send(message: string, opts?: { bypassCooldown?: boolean }): boolean } {
  let lastSentAt = 0;
  return {
    /** Apply the shared gate; deliver when it passes. Returns true if delivered.
     *  The harness tick is QUEUED by the runner (held + flushed on settle) —
     *  the busy/compacting gates stay intact (never mid-turn). The flush may
     *  bypassCooldown: at the settle boundary the harness STATE update must
     *  not be suppressed by a nudge that just fired. */
    send(message: string, opts?: { bypassCooldown?: boolean }): boolean {
      if (!host.interactive() || !host.loaded() || host.busy() || host.compacting()) return false;
      const now = Date.now();
      if (!opts?.bypassCooldown && now - lastSentAt < cooldownMs) return false;
      lastSentAt = now;
      deliver(message);
      return true;
    },
  };
}
