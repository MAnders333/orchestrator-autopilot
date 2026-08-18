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
- **Autopilot toggle**: opencode plugins cannot register commands — the toggle
  is the plugin's `autopilot` TOOL (on | off | status | capacity <n>); a
  consumer may add a `/autopilot` command FILE telling the agent to call it
  (the package does not ship one). Per-session, like pi's registered command.
  The host marker in the queue-tool descriptions (`(opencode host)`) is the
  opencode detection signal.
