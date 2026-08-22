# pi backend notes (the extension)

- **Worktree isolation**: native — the runner creates the worktree and delivers
  a handoff artifact (default for every worker dispatch). Workers never touch
  the main checkout.
- **Ticks**: custom-role messages (`sendMessage`, followUp + triggerTurn)
  delivered when the orchestrator is idle — gated on the interactive TUI
  session, `/orchestrate` loaded, not busy, not compacting, plus a cooldown.
- **Steering**: available — the worker publishes steer-capabilities; steers are
  written to its step inbox (`steer-targets/<index>`) and acked. Works for
  headless detached workers.
- **Flagging**: `flag_for_review` is registered by the extension; it appends to
  the reviews log + sends a desktop notification.
- **Per-session toggle**: `/autopilot on|off [in <duration>]|status|capacity`
  gates ticks per session. `off in <duration>` (e.g. `off in 1h30m`, max 24h)
  SCHEDULES the shutdown: autopilot stays ON until the deadline, then flips
  OFF by itself; any explicit on/off cancels; status shows the pending
  deadline; the deadline survives a restart (the enable-gate backstop fires
  it late but never loses it). The queue tools are always available.
- **Detection**: the host marker in the queue-tool descriptions
  (`(pi host)`) is the signal — the `/autopilot` command is just the
  per-session toggle (the opencode plugin registers no commands).
