// types.ts — shared event/result shapes for the orchestrator lifecycle.
// The engine (core.ts), verdict parsing (verdict.ts) and run-id collection
// (run-ids.ts) all speak these types; keeping them here avoids import cycles.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TickReason = "dispatch" | "intake" | "review";

export interface Tick {
  reason: TickReason;
  /** Human/LLM-readable tick message (the orchestrator consumes this). */
  message: string;
  /** Machine-readable facts the orchestrator can use without re-deriving. */
  facts: Record<string, unknown>;
}

export interface CompletionEvent {
  runId?: string;
  id?: string;
  agent?: string | null;
  success?: boolean;
  status?: string;          // "completed" | "failed" | "stopped" | "detached" | ...
  timedOut?: boolean;
  stopped?: boolean;
  summary?: string;
  sessionFile?: string;
  results?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface DomainEvent {
  name: string;
  data: Record<string, unknown>;
}

export interface AutopilotResult {
  tick: Tick | null;
  /** Structured domain events (orch:item-completed, orch:verdict, ...) — the
   *  only machine channel; the adapter publishes them on the platform bus. */
  domainEvents: DomainEvent[];
  /** true when the completion was attributed to a store item and flipped. */
  flipped: boolean;
  /** true when the completed run freed a worker slot (flipped or ledger-tracked). */
  freedSlot: boolean;
  /** true when the completed run was a REVIEWER (its verdict needs routing). */
  reviewerCompleted: boolean;
}
