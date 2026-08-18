# opencode backend notes (the plugin)

- **Worktree isolation**: no native worktree — enforce by instruction: tell the
  worker to `git worktree add` a private branch location before editing and to
  work only there, leaving the main checkout untouched.
- **Ticks**: `promptAsync` injection into the orchestrator session — delivered
  ONLY in a persistent session (interactive TUI or serve-based). A headless
  one-shot `oc run` never processes injected prompts (they queue into a void) —
  in headless runs the gate blocks ticks entirely.
- **Steering**: NOT available for headless runs (injected prompts queue into a
  void; `session.abort` is unreachable without a persistent server). Stop +
  re-dispatch instead.
- **Flagging**: `flag_for_review` is registered by the plugin (reviews log;
  notification best-effort).
- **No command registration** — the absence of `/autopilot` is the opencode
  detection signal (pi-only command).
