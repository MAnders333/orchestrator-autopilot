// config-watch.ts — the CHANGE SIGNAL for fleet-wide configuration
// (KEY: AUTOPILOT-48). The queue tools already REPORT config on demand
// (queue_list returns fleet.maxSlots), but a CHANGE produced no event: the
// operator ran `/autopilot capacity 6`, the config file moved, and the
// orchestrator kept reasoning with the cached "3 slots, all occupied" — it
// told the user work was gated seconds after that became false. A long-running
// orchestrator has no reason to re-read a number nothing announced.
//
// This module turns a config EDIT into the same `[orch-tick: …]` channel the
// queue decisions already use. It is deliberately a LEAF (type-only import of
// the config shape; the runner does the delivery) and deliberately
// SNAPSHOT-BASED: the last SURFACED values are persisted next to the other
// harness state, so the notice fires once per change — not on every sweep, and
// not once per host process.
//
// WHICH FIELDS: the ones that change what the orchestrator may DO.
//   - maxSlots        — how many workers may run at all (dispatch math)
//   - workerAgents    — which spawns the isolation guard blocks
//   - shipping        — whether an approved item merges by itself (mergeMode)
//     and which repos have a policy at all (a repo without one PAUSES on done)
// quietPeriodMs is NOT watched: it is a constructor-level Autopilot option
// (config.ts AutopilotConfig), not a field of autopilot.config.json, so no
// operator edit to the state dir can change it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../session-store.ts";
import type { LoadedAutopilotConfig } from "../config.ts";

/** One field that moved: the OLD and the NEW value, both named. */
export interface ConfigChange {
  field: string;
  /** What the field means in orchestrator terms (goes into the tick). */
  label: string;
  from: string;
  to: string;
}

interface WatchedField {
  field: string;
  label: string;
  /** The comparable rendering of this field — also what the tick prints. */
  read(cfg: LoadedAutopilotConfig): string;
}

const WATCHED: WatchedField[] = [
  { field: "maxSlots", label: "fleet capacity", read: (c) => String(c.maxSlots) },
  { field: "workerAgents", label: "worker agents", read: (c) => c.workerAgents.join(",") },
  {
    field: "shipping",
    label: "shipping policy",
    // mergeMode decides whether `done` auto-merges; the repo KEY SET decides
    // which repos ship at all (an unknown repo pauses for the policy inquiry).
    // Both are one-line facts; the per-repo flow/base detail stays in the file.
    read: (c) =>
      c.shipping
        ? `mergeMode ${c.shipping.mergeMode ?? "auto"}, repos [${Object.keys(c.shipping.repos ?? {}).sort().join(",")}]`
        : "none",
  },
];

export function configWatchPath(stateDir: string): string {
  return join(stateDir, "config-seen.json");
}

/** The comparable rendering of every watched field. */
export function configFingerprint(cfg: LoadedAutopilotConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of WATCHED) out[w.field] = w.read(cfg);
  return out;
}

/** Fields that moved since the last SURFACED snapshot. Empty when nothing
 *  changed AND when no snapshot exists yet (a first observation is a baseline,
 *  not a change — a fresh state dir must not announce its own defaults). */
export function detectConfigChanges(stateDir: string, cfg: LoadedAutopilotConfig): ConfigChange[] {
  const seen = loadSnapshot(stateDir);
  if (!seen) return [];
  const now = configFingerprint(cfg);
  const changes: ConfigChange[] = [];
  for (const w of WATCHED) {
    const before = seen[w.field];
    if (before === undefined) continue; // a newly watched field — baseline it silently
    if (before === now[w.field]) continue;
    changes.push({ field: w.field, label: w.label, from: before, to: now[w.field] });
  }
  return changes;
}

/** Persist the values that have now been SURFACED (or baselined). Never
 *  throws — a config notice must not break a sweep. */
export function recordConfigSnapshot(stateDir: string, cfg: LoadedAutopilotConfig): void {
  try {
    writeAtomic(configWatchPath(stateDir), JSON.stringify(configFingerprint(cfg), null, 2) + "\n");
  } catch {
    // silent: the next sweep re-detects and re-announces
  }
}

/** The ONE tick line for a batch of changes — every field names old → new. */
export function configChangeTick(changes: ConfigChange[]): string | null {
  if (!changes.length) return null;
  const parts = changes.map((c) => `${c.label} (${c.field}) ${c.from} → ${c.to}`);
  const capacity = changes.some((c) => c.field === "maxSlots")
    ? " Your slot math is now STALE: re-read the fleet (queue_list) before telling anyone work is gated, and re-check what can start."
    : "";
  return (
    `[orch-tick: config] CONFIG CHANGED: ${parts.join("; ")} — an operator edited autopilot.config.json (e.g. /autopilot capacity <n>).${capacity}` +
    ` Announced once, at the change. Not a user request; respond ≤2 lines.`
  );
}

function loadSnapshot(stateDir: string): Record<string, string> | null {
  try {
    const p = configWatchPath(stateDir);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
