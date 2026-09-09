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
// Deterministic transitions (approve/reject/defer) are applied directly,
// emit `orch:human-decision` (reused by the decision-tick builder below), and
// result in a one-line `[orch-tick: decision] <key> <action>: <from> → <to>`
// so the orchestrator always knows the move — fresh at application time. Anything
// needing judgment (refine scope edits, re-dispatch with findings) records
// the human's words on the item and emits the event — the harness/orchestrator
// consumes it via the normal dispatch path, nothing is auto-sent to a worker
// without that path.
// -------------------------------------------------------------------------

import { loadStoreOrNew, saveStore, updateItem, resolveSeries, type QueueItem } from "../queue-store.ts";
import { approvalReady, renameProvisionalKey } from "../tools/queue-ops.ts";
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
  /** Budget-governance row facts: the item's recorded wall-clock budget
   *  (timeoutMs, null = unset → runtime default) and whether a previous run
   *  FAILED because it hit that budget (failCause budget-capped) rather than
   *  on a verdict. Rows render these so a bigger-budget re-dispatch is the
   *  obvious next step, never a silent uniform cap. */
  timeoutMs: number | null;
  budgetCapped: boolean;
  /** Where to navigate to act on this item (repo, branch@tip diffs, files). */
  targets: PanelTarget[];
  /** The actions this item currently supports (derived from its status). */
  actions: PanelActionId[];
  /** Proposal view only: what happens to the item's KEY. Provisional Q-<n>
   *  handles are renamed at approval into the repo's real series (resolved
   *  registry → history → slug once a cwd is set); non-provisional keys carry
   *  no hint. Hosts render it so the human sees the rename coming.
   *  Absent (undefined) on the human-review view — keys there are final. */
  seriesHint?: string | null;
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

/** The destined-series hint for the proposals feed — resolved against the
 *  SAME store + registry the approved transition renames with, so the panel
 *  can never predict a different series than the one the rename produces.
 *  - provisional key with no repo yet: the rename is coming — announced up
 *    front (and the hint resolves live once a cwd is set, because the panel
 *    rebuilds from the store after every decision).
 *  - cwd-bearing item: real-series keys stay put (allocated from cwd at
 *    queue_add); provisional keys rename into the resolved series.
 *  - otherwise (legacy/odd items): no hint. */
export function seriesHintFor(stateDir: string, item: QueueItem): string | null {
  if (item.provisionalKey) {
    if (!item.cwd) {
      return `${item.key} is a provisional handle (repo-less proposal — no cwd yet): at approval the key is renamed into the repo's real series (registry → history → slug). Expect the key to change.`;
    }
    const series = resolveSeries(stateDir, item.cwd, { excludeKey: item.key });
    return `repo set — approval renames ${item.key} into series ${series}`;
  }
  if (item.cwd) {
    const series = resolveSeries(stateDir, item.cwd);
    return `real series key — cwd ${item.cwd} resolves to series ${series || "Q"} (registry → history → slug); approval does NOT rename.`;
  }
  return null;
}

function toTargets(lines: string[]): PanelTarget[] {
  return lines.map((l) => {
    const label = l; // targets carry their navigation hint in prose (diff/view commands)
    return { label };
  });
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
      items: items.map((i) => ({
        key: i.key,
        title: i.title,
        status: i.status,
        risk: i.risk,
        cwd: i.cwd,
        updatedAt: i.updatedAt,
        summary: scopeHead(i.scope) || i.title,
        timeoutMs: i.timeoutMs ?? null,
        budgetCapped: i.failCause === "budget-capped",
        targets: [{ label: i.cwd ?? "no repo yet — refine to set cwd" }],
        seriesHint: seriesHintFor(stateDir, i),
        actions: actionsForStatus(i.status),
        fullScope: i.scope ?? "",
        fullNotes: i.notes ?? "",
        fullTargets: [{ label: i.cwd ?? "no repo yet — refine to set cwd" }],
        meta: metaFor(i),
      })),
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
          timeoutMs: i.timeoutMs ?? null,
          budgetCapped: i.failCause === "budget-capped",
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
    /** set when the decision renamed a provisional key (approve) — the event
     *  carries the FINAL key so consumers dispatch the live item. */
    renamedFrom?: string;
    /** Short annotation the decision tick appends to the target — e.g.
     *  "dispatchable" (approve a proposal) or the defer blocker
     *  ("decision", "parked"). */
    note?: string;
  };
}

export interface PanelDecisionResult {
  ok: boolean;
  text: string;
  event?: HumanDecisionEvent;
  /** The one-line decision tick (`[orch-tick: decision] <key> <action>:
   *  <from> → <to>`), built AT APPLICATION TIME from the event data — fresh
   *  by construction, never a stale snapshot. Present only for real status
   *  moves (approve/reject/defer): refine/redispatch record words, they
   *  don't flip a status, so they carry no tick. */
  tick?: string;
}

/** The past-tense verbs the decision tick shows per action. */
const DECISION_VERB: Record<PanelActionId, string> = {
  approve: "approved",
  reject: "rejected",
  defer: "deferred",
  refine: "refined",
  redispatch: "re-dispatched",
};

/** Build the one-line decision tick: `[orch-tick: decision] <key> <action>:
 *  <from> → <to>[ (<note>)]`. SHARED by the panel hosts (from the returned
 *  orch:human-decision event) and harness-applied moves (zombie flips pass
 *  their own verb + note — e.g. action "failed", note "zombie"). Returns null
 *  when no status moved (from === to or no target): a non-move is an event,
 *  not a tick. One line, by construction. */
export function decisionTick(input: { key: string; action: string; from: string; to: string | null; note?: string }): string | null {
  if (input.to === null || input.from === input.to) return null;
  const to = input.note ? `${input.to} (${input.note})` : input.to;
  return `[orch-tick: decision] ${input.key} ${input.action}: ${input.from} → ${to}`;
}

function result(text: string, event?: HumanDecisionEvent): PanelDecisionResult {
  if (!event) return { ok: false, text };
  const tick = decisionTick({ key: event.data.key, action: DECISION_VERB[event.data.action], from: event.data.from, to: event.data.to, note: event.data.note });
  return { ok: true, text: `${text} (human decision recorded)`, event, ...(tick ? { tick } : {}) };
}

/** Apply one panel action. Deterministic transitions are applied directly and
 *  validated by the same ALLOWED map + approval gate the queue_* tools use;
 *  re-dispatch records the human's findings (no transition — the harness
 *  moves the item and spawns the redo, exactly like the review-FAIL path). */
export function applyPanelDecision(stateDir: string, key: string, action: PanelActionId, payload?: { scope?: string; cwd?: string; findings?: string; blocker?: string }): PanelDecisionResult {
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
        // A provisional Q-<n> handle gets its REAL series here — the same
        // rename queue_update performs at approval, so the panel and the tool
        // cannot drift. The key stays Q-<n> (identity) until this moment.
        const renamedTo = renameProvisionalKey(stateDir, store, key);
        saveStore(stateDir, store);
        if (renamedTo) {
          const text = `approved '${key}' → renamed to '${renamedTo}' (provisional handle → real series)`;
          return result(text, { name: "orch:human-decision", data: { ...base, key: renamedTo, renamedFrom: key, to: "approved", note: "dispatchable" } });
        }
        return result(`approved '${key}' (proposal → approved, dispatchable)`, { name: "orch:human-decision", data: { ...base, to: "approved", note: "dispatchable" } });
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
      return result(`deferred '${key}' (blocked: ${blocker})`, { name: "orch:human-decision", data: { ...base, to: "blocked", note: blocker } });
    }

    case "refine": {
      if (item.status !== "proposal") return { ok: false, text: `panel: '${key}' is ${item.status} — refine edits a proposal's scope` };
      const scope = (payload?.scope ?? "").trim();
      const cwd = (payload?.cwd ?? "").trim();
      if (!scope && !cwd) return { ok: false, text: `panel: refine needs new scope text or a repo (cwd) for '${key}'` };
      const patch: { scope?: string; cwd?: string } = {};
      if (scope) patch.scope = scope;
      if (cwd) patch.cwd = cwd;
      updateItem(store, key, patch);
      saveStore(stateDir, store);
      const changed = [scope ? "scope" : null, cwd ? "repo (cwd)" : null].filter(Boolean).join(" + ");
      return result(`refined '${key}' ${changed}`, { name: "orch:human-decision", data: { ...base, to: "proposal" } });
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