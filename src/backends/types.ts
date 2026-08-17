// backends/types.ts — the subagent-runtime seam contract. The queue tools and
// the extension depend on THIS interface, never on a backend's internals, so
// pi / opencode / claude implementations can be swapped without touching the
// queue logic.
//
// One backend is active per framework instance. The pi backend (backends/pi.ts)
// uses pi-subagents' in-process RPC spawn + file control channel; the opencode
// backend (backends/opencode.ts) spawns detached `oc run` child processes.

export interface SubagentBackend {
  /** Spawn a detached async run. Resolves the run id (known immediately; the
   *  backend owns completion detection — process exit for opencode, the
   *  async-complete bus event for pi). `cwd` targets the repo the worker
   *  operates on (worktree isolation + the worker's shell starts there);
   *  defaults to the session cwd when omitted. */
  spawn(task: string, opts: { agent?: string; timeoutMs?: number; worktree?: boolean; cwd?: string }): Promise<string>;
  /**
   * Reconcile-only fleet view — the number of runs the backend currently
   * considers active. The engine's store/ledger decides occupancy; this is a
   * cross-check (and the authoritative count for opencode, where every run is
   * a real child process).
   */
  fleetStatus(): Promise<{ totalActive: number } | null>;
  /** Steer a running run. Backends that cannot deliver (headless) throw a
   *  clear error — never claim delivery. */
  steer(runId: string, message: string, mode?: "steer" | "follow_up", ackTimeoutMs?: number): Promise<string>;
  /** Resolve the run's state dir (or null if the run is gone). */
  asyncDirFor(runId: string): string | null;
}

/** The pi-subagents surface the pi backend needs (events bus for RPC). */
export interface PiLike {
  events: {
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  };
}

/** The opencode backend's options. `runsDir` is the state root where each
 *  run's status.json + output live — injectable (tests use temp dirs). */
export interface OpenCodeBackendOptions {
  /** State root for run records (default ~/.local/state/orchestrator-opencode/runs). */
  runsDir: string;
  /** The opencode launcher to exec (default "opencode"; local setups
   *  override via AUTOPILOT_OPENCODE_BIN, e.g. the oc wrapper). Injectable. */
  ocBin?: string;
  /** Best-effort window to capture the opencode session id from the output
   *  stream (default 30s). Not required for correctness — the run id is our
   *  own uuid. */
  sessionIdTimeoutMs?: number;
  /** Fired when a run's process exits (completion signal for the extension). */
  onComplete?: (runId: string, record: OpenCodeRunRecord) => void;
  now?: () => number;
}

export interface OpenCodeRunRecord {
  runId: string;
  agent: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  pid: number;
  logPath: string;
  sessionId?: string;
}
