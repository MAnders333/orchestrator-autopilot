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
- **Per-session toggle**: `/autopilot on|off|status|capacity` gates ticks per
  session; the queue tools are always available.
- **The `/autopilot` command is the pi detection signal** (the opencode plugin
  registers no commands).
