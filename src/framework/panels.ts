// -------------------------------------------------------------------------
// Decision panels — the SHARED, host-agnostic core of the panel feature.
//
// A panel is a VIEW over the queue store fed by buildPanelDoc (one per
// status: proposals, human-review) plus a set of already-validated MUTATIONS
// applied by applyPanelDecision. Panels add a human-scale decision surface
// over the SAME store the queue_* tools use — zero new state, zero new
// transitions. Every action maps 1:1 to an existing validated transition
// (ALLOWED + the approval gate). Hosts (pi TUI overlay, opencode TUI route)
// are thin renderers over this doc and decision result.
//
// Deterministic transitions (approve/reject/defer) are applied directly and
// emit `orch:human-decision` so the orchestrator stays coherent. Anything
// needing judgment (refine scope edits, re-dispatch with findings) records
// the human's words on the item and emits the event — the harness/orchestrator
// consumes it via the normal dispatch path, nothing is auto-sent to a worker
// without that path.
// -------------------------------------------------------------------------

import { loadStoreOrNew, saveStore, updateItem, resolveSeries, type QueueItem } from "../queue-store.ts";
import { approvalReady } from "../tools/queue-ops.ts";
import { humanReviewTargetsFor } from "./worktree-preservation.ts";

export type PanelKind = "proposals" | "human-review";

export type PanelActionId = "approve" | "reject" | "defer" | "refine" | "redispatch";

export interface PanelTarget {
  label: string;
  /** Optional navigation hint (e.g. the branch-scoped view command). */
  hint?: string;
}

/** Full item metadata for the detail view — nothing here is a render;
 *  hosts decide how much of it to draw (and how much to truncate). */
export interface PanelItemMeta {
  createdAt: string;
  updatedAt: string;
  evidence: string;
  value: string;
  urgency: string;
  risk: string;
  blocker: string | null;
  runId: string | null;
  reviewerRunId: string | null;
}

export interface PanelItem {
  key: string;
  title: string;
  status: string;
  risk: string | null;
  cwd: string | null;
  updatedAt: string;
  /** The human-readable summary: scope first line for a proposal, title +
   *  scope head for a review item. */
  summary: string;
  /** Where to navigate to act on this item (repo, branch@tip diffs, files). */
  targets: PanelTarget[];
  /** The actions this item currently supports (derived from its status). */
  actions: PanelActionId[];
  /** Proposals view only — what happens to the key at approval: real-series
   *  keys stay put; provisional Q-<n> handles (repo-less proposals) are
   *  RENAMED into the repo's real series (registry → history → slug). Shown
   *  so an approval-time rename is never a surprise. */
  seriesHint?: string;
  /** The FULL untruncated scope (the worker prompt). Truncation is a RENDER
   *  choice — hosts show this verbatim in detail/expand views. */
  fullScope: string;
  /** The FULL untruncated free-form notes. */
  fullNotes: string;
  /** EVERY navigation target — no caps here; `targets` stays the host's
   *  convenience projection, hosts choose how many to draw. */
  fullTargets: PanelTarget[];
  /** Full item metadata (timestamps + the free-form triage fields). */
  meta: PanelItemMeta;
}

export interface PanelSection {
  title: string;
  items: PanelItem[];
}

export interface PanelDocument {
  kind: PanelKind;
  generatedAt: string;
  sections: PanelSection[];
}

/** The action catalog — one source of labels for both hosts. */
export const PANEL_ACTIONS: Record<PanelActionId, { label: string; description: string; needsInput?: boolean }> = {
  approve: { label: "Approve", description: "proposal → approved (dispatchable) / human-review → done" },
  reject: { label: "Reject", description: "drop the item (proposal/human-review → rejected)" },
  defer: { label: "Defer", description: "park the proposal (blocked) instead of approving it now" },
  refine: { label: "Refine", description: "edit the scope (proposal) — the worker prompt", needsInput: true },
  redispatch: { label: "Re-dispatch", description: "send the reviewed work back with your findings", needsInput: true },
};

/** The actions available per status. Proposals: approve/reject/defer/refine.
 *  Human-review: approve/reject/redispatch (findings = the refine channel). */
export function actionsForStatus(status: string): PanelActionId[] {
  if (status === "proposal") return ["approve", "reject", "defer", "refine"];
  if (status === "human-review") return ["approve", "redispatch", "reject"];
  return [];
}

function scopeHead(scope: string | null | undefined, cap = 120): string {
  return (scope ?? "").split(/\n/)[0].trim().slice(0, cap);
}

function toTargets(lines: string[]): PanelTarget[] {
  return lines.map((l) => {
    const label = l; // targets carry their navigation hint in prose (diff/view commands)
    return { label };
  });
}

/** The destined-series hint for the proposals feed — resolved against the
 *  SAME store + registry the approved transition renames with, so the panel
 *  can never predict a different series than the one the rename produces.
 *  - provisionalKey item (repo-less proposal): the Q-<n> handle is temporary
 *    — approval with a cwd renames it into the repo's real series.
 *  - cwd-bearing item: the key is ALREADY in its real series (allocated at
 *    queue_add from cwd); approval keeps it.
 *  - otherwise (legacy/odd items): no hint. */
export function seriesHintFor(stateDir: string, item: QueueItem): string | null {
  if (item.provisionalKey) {
    return `'${item.key}' is a PROVISIONAL handle (repo-less proposal — no cwd): at approval the key is RENAMED into the repo's real series (registry → history → slug). Expect the key to change.`;
  }
  if (item.cwd) {
    const series = resolveSeries(stateDir, item.cwd);
    return `real series key — cwd ${item.cwd} resolves to series ${series || "Q"} (registry → history → slug); approval does NOT rename.`;
  }
  return null;
}

/** Project the FULL item metadata for the detail view — free-form text is
 *  carried verbatim (evidence/value/urgency/risk/notes are schema-free). */
function metaFor(i: QueueItem): PanelItemMeta {
  return {
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    evidence: i.evidence ?? "",
    value: i.value ?? "",
    urgency: i.urgency ?? "",
    risk: i.risk ?? "",
    blocker: i.blocker ?? null,
    runId: i.runId ?? null,
    reviewerRunId: i.reviewerRunId ?? null,
  };
}

/** Build the panel document for one view, fed directly from queue state. */
export function buildPanelDoc(stateDir: string, kind: PanelKind): PanelDocument {
  const store = loadStoreOrNew(stateDir);
  const items = Object.values(store.items).filter((i) => i.status === (kind === "proposals" ? "proposal" : "human-review"));
  items.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)); // oldest first — the ones waiting longest

  const document: PanelDocument = { kind, generatedAt: new Date().toISOString(), sections: [] };
  if (kind === "proposals") {
    document.sections.push({
      title: "Proposals — awaiting your call (approve / reject / defer / refine)",
      items: items.map((i) => {
        const hint = seriesHintFor(stateDir, i);
        return {
          key: i.key,
          title: i.title,
          status: i.status,
          risk: i.risk,
          cwd: i.cwd,
          updatedAt: i.updatedAt,
          summary: scopeHead(i.scope) || i.title,
          targets: [{ label: i.cwd ?? "no repo yet — refine to set cwd" }],
          actions: actionsForStatus(i.status),
          ...(hint ? { seriesHint: hint } : {}),
          fullScope: i.scope ?? "",
          fullNotes: i.notes ?? "",
          fullTargets: [{ label: i.cwd ?? "no repo yet — refine to set cwd" }],
          meta: metaFor(i),
        };
      }),
    });
  } else {
    document.sections.push({
      title: "Human review — approved work awaiting YOU (approve / re-dispatch with findings / reject)",
      items: items.map((i) => {
        const allTargets = toTargets(humanReviewTargetsFor(stateDir, i.key, i));
        return {
          key: i.key,
          title: i.title,
          status: i.status,
          risk: i.risk,
          cwd: i.cwd,
          updatedAt: i.updatedAt,
          summary: `${scopeHead(i.scope) || i.title}${i.notes ? ` — ${scopeHead(i.notes, 120)}` : ""}`,
          targets: allTargets,
          actions: actionsForStatus(i.status),
          fullScope: i.scope ?? "",
          fullNotes: i.notes ?? "",
          fullTargets: allTargets,
          meta: metaFor(i),
        };
      }),
    });
  }
  return document;
}

export interface HumanDecisionEvent {
  name: "orch:human-decision";
  data: {
    key: string;
    action: PanelActionId;
    from: string;
    to: string | null;
    findings?: string;
  };
}

export interface PanelDecisionResult {
  ok: boolean;
  text: string;
  event?: HumanDecisionEvent;
}

function result(text: string, event?: HumanDecisionEvent): PanelDecisionResult {
  return event ? { ok: true, text: `${text} (human decision recorded)`, event } : { ok: false, text };
}

/** Apply one panel action. Deterministic transitions are applied directly and
 *  validated by the same ALLOWED map + approval gate the queue_* tools use;
 *  re-dispatch records the human's findings (no transition — the harness
 *  moves the item and spawns the redo, exactly like the review-FAIL path). */
export function applyPanelDecision(stateDir: string, key: string, action: PanelActionId, payload?: { scope?: string; findings?: string; blocker?: string }): PanelDecisionResult {
  const store = loadStoreOrNew(stateDir);
  const item: QueueItem | undefined = store.items[key];
  if (!item) return { ok: false, text: `panel: no item '${key}'` };

  const base = { key, action, from: item.status };

  switch (action) {
    case "approve": {
      if (item.status === "proposal") {
        if (!approvalReady(item.scope, item.cwd)) {
          return { ok: false, text: `panel: ${key} is not fully specified (scope + cwd) — refine it first` };
        }
        updateItem(store, key, { status: "approved" });
        saveStore(stateDir, store);
        return result(`approved '${key}' (proposal → approved, dispatchable)`, { name: "orch:human-decision", data: { ...base, to: "approved" } });
      }
      if (item.status === "human-review") {
        updateItem(store, key, { status: "done" });
        saveStore(stateDir, store);
        return result(`approved '${key}' (human-review → done)`, { name: "orch:human-decision", data: { ...base, to: "done" } });
      }
      return { ok: false, text: `panel: '${key}' is ${item.status} — approve is only for proposal / human-review items` };
    }

    case "reject": {
      const to = item.status === "proposal" ? "rejected" : item.status === "human-review" ? "rejected" : null;
      if (!to) return { ok: false, text: `panel: '${key}' is ${item.status} — reject is only for proposal / human-review items` };
      updateItem(store, key, { status: to as never });
      saveStore(stateDir, store);
      return result(`rejected '${key}'`, { name: "orch:human-decision", data: { ...base, to } });
    }

    case "defer": {
      if (item.status !== "proposal") return { ok: false, text: `panel: '${key}' is ${item.status} — only proposals can be deferred` };
      const blocker = payload?.blocker && (["parked", "serialized", "merge", "decision"] as const).includes(payload.blocker as never) ? payload.blocker : "decision";
      updateItem(store, key, { status: "blocked", blocker: blocker as never });
      saveStore(stateDir, store);
      return result(`deferred '${key}' (blocked: ${blocker})`, { name: "orch:human-decision", data: { ...base, to: "blocked" } });
    }

    case "refine": {
      if (item.status !== "proposal") return { ok: false, text: `panel: '${key}' is ${item.status} — refine edits a proposal's scope` };
      const scope = (payload?.scope ?? "").trim();
      if (!scope) return { ok: false, text: `panel: refine needs new scope text for '${key}'` };
      updateItem(store, key, { scope });
      saveStore(stateDir, store);
      return result(`refined '${key}' scope`, { name: "orch:human-decision", data: { ...base, to: "proposal" } });
    }

    case "redispatch": {
      if (item.status !== "human-review") return { ok: false, text: `panel: '${key}' is ${item.status} — re-dispatch is only for human-review items` };
      const findings = (payload?.findings ?? "").trim();
      if (!findings) return { ok: false, text: `panel: re-dispatch needs your findings for '${key}'` };
      // Record the findings durably + emit the event. NO transition here: the
      // harness moves human-review → active and spawns the redo with these
      // findings (the same path a review FAIL takes) — the human's words must
      // be IN the re-dispatch task, and nothing is auto-sent without that path.
      const note = item.notes ? `${item.notes}\n\n[human re-dispatch findings] ${findings}` : `[human re-dispatch findings] ${findings}`;
      updateItem(store, key, { notes: note });
      saveStore(stateDir, store);
      return result(`recorded re-dispatch findings for '${key}' — the harness will re-dispatch with them`, { name: "orch:human-decision", data: { ...base, to: item.status, findings } });
    }

    default:
      return { ok: false, text: `panel: unknown action '${String(action)}'` };
  }
}