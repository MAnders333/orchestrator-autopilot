// worktree-preservation.ts — WORKTREE HANDOFF PRESERVATION (framework seam).
//
// The managed-worktree lifecycle is the runtime's (pi-subagents creates the
// `pi-parallel-<runid>-*` branch + worktree and DELETES BOTH at run end —
// success AND failure/timeout — inside its own cleanup finally-blocks, before
// any completion event reaches this framework). A worker that committed to its
// parallel branch therefore had those commits deleted with the branch: they
// became dangling objects (three live incidents needed a manual `git fsck`
// rescue). Interception is impossible (deletion happens first), so this
// module preserves PRE-EMPTIVELY:
//
//   1. TIP JOURNAL — every capture appends {runId, key, branch, tipSha, ts}
//      to <stateDir>/handoffs.jsonl and writes the tip into a durable,
//      gc-safe ref `refs/orchestrator/keep/<runId>` (invisible in `git
//      branch` listings; only written AFTER a successful rev-parse). Once
//      commits are reachable from that ref, pi-subagents' later
//      `git branch -D` becomes harmless.
//   2. CAPTURE POINTS ride machinery that already runs (no new timers):
//      the periodic sweep (every sweep source) plus queue-state transitions
//      (dispatch recorded / completion flip / zombie-flip — wired by the
//      runner + queue ops). A worker killed between sweeps still gets its
//      last commits journalled at the state change.
//   3. RETENTION — keep refs are pruned when the queue item reaches a
//      terminal status (done/rejected) OR when the journaled tip becomes
//      reachable from main (origin/main, falling back to the local main),
//      whichever comes first. failed/blocked items keep their ref until then.
//
// All git calls are best-effort: any failure leaves the store untouched and
// returns what was captured so far — preservation must never break a sweep.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadStore } from "../queue-store.ts";

/** Durable keep-ref namespace (gc-safe, hidden from `git branch`). */
export const KEEP_REF_PREFIX = "refs/orchestrator/keep/";

/** The managed-worktree branch prefix the runtime uses. */
export const PARALLEL_BRANCH_PREFIX = "pi-parallel-";

/** One journal line in <stateDir>/handoffs.jsonl. */
export interface HandoffEntry {
  runId: string;
  key: string;
  branch: string;
  tipSha: string;
  ts: string;
}

export function handoffsLogPath(stateDir: string): string {
  return join(stateDir, "handoffs.jsonl");
}

/** Ref-safe component: run ids are uuid-shaped but never trust that. */
export function keepRefFor(runId: string): string {
  const clean = runId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.\./g, "__");
  return `${KEEP_REF_PREFIX}${clean}`;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Escape glob metachars so the runId cannot widen the for-each-ref pattern. */
function globEscape(s: string): string {
  return s.replace(/[*?[\\]/g, "[$&]");
}

/** The worker's parallel branches for one run (`pi-parallel-<runId>*`). */
export function parallelBranches(repo: string, runId: string): string[] {
  const out = git(repo, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${PARALLEL_BRANCH_PREFIX}${globEscape(runId)}*`,
  ]);
  if (!out) return [];
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function lastJournaledTip(stateDir: string, runId: string, branch: string): string | null {
  try {
    const p = handoffsLogPath(stateDir);
    if (!existsSync(p)) return null;
    let last: string | null = null;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as HandoffEntry;
        if (e.runId === runId && e.branch === branch && typeof e.tipSha === "string") last = e.tipSha;
      } catch {
        // corrupt line — skip
      }
    }
    return last;
  } catch {
    return null;
  }
}

/**
 * Preserve one run's parallel-branch tips: journal each NEW tip + write it
 * into the durable keep ref (ref write only after a successful rev-parse).
 * Returns the entries appended this call (empty when nothing new).
 */
export function preserveRunWorktree(input: {
  stateDir: string;
  repo: string;
  runId: string;
  key: string;
  ts?: string;
}): HandoffEntry[] {
  const ts = input.ts ?? new Date().toISOString();
  const entries: HandoffEntry[] = [];
  for (const branch of parallelBranches(input.repo, input.runId)) {
    // Resolve the commit tip through the branch ref — a successful rev-parse
    // is the gate for everything below (a gone/corrupt branch journals nothing).
    const tipSha = git(input.repo, ["rev-parse", "--verify", `${branch}^{commit}`]);
    if (!tipSha || tipSha === lastJournaledTip(input.stateDir, input.runId, branch)) continue;
    if (git(input.repo, ["update-ref", keepRefFor(input.runId), tipSha]) === null) continue;
    entries.push({ runId: input.runId, key: input.key, branch, tipSha, ts });
  }
  if (entries.length) {
    try {
      mkdirSync(input.stateDir, { recursive: true });
      appendFileSync(handoffsLogPath(input.stateDir), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    } catch {
      // The durable REF already protects the commits; the journal is evidence.
    }
  }
  return entries;
}

/** Preserve every ACTIVE item's run (the sweep's per-tick capture pass). */
export function preserveActiveItems(stateDir: string, ts?: string): HandoffEntry[] {
  const store = loadStore(stateDir);
  if (!store) return [];
  const out: HandoffEntry[] = [];
  for (const it of Object.values(store.items)) {
    if (it.status !== "active" || !it.runId || !it.cwd) continue;
    try {
      out.push(...preserveRunWorktree({ stateDir, repo: it.cwd, runId: it.runId, key: it.key, ts }));
    } catch {
      // best-effort per item — one broken repo must not skip the rest
    }
  }
  return out;
}

/** Is `tip` an ancestor of origin/main (fallback: local main)? Unknown → false. */
export function tipReachableFromMain(repo: string, tip: string): boolean {
  for (const mainRef of ["refs/remotes/origin/main", "refs/heads/main"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", mainRef]) === null) continue;
    // merge-base --is-ancestor exits 0 exactly when reachable
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", tip, mainRef], { cwd: repo, stdio: "ignore" });
      return true;
    } catch {
      return false; // main exists but does not contain the tip — stop at the first existing ref
    }
  }
  return false;
}

function readJournal(stateDir: string): HandoffEntry[] {
  try {
    const p = handoffsLogPath(stateDir);
    if (!existsSync(p)) return [];
    const out: HandoffEntry[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as HandoffEntry;
        if (e.runId && e.key && e.branch && e.tipSha) out.push(e);
      } catch {
        // corrupt line — skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * REVIEW POINTERS for the deterministic human handover: the latest journaled
 * branch@tip per runId for one queue item, as concrete review targets. This is
 * what makes the auto-flag actually REVIEWABLE — the old auto-flag pointed at
 * `item.cwd` + the prose "the reviewed work (queue item K)", which is not a
 * pointer (the user asked for paths/links, and got neither).
 */
export function reviewPointersFor(stateDir: string, key: string): Array<{ branch: string; tipSha: string }> {
  const out: Array<{ branch: string; tipSha: string }> = [];
  for (const e of readJournal(stateDir)) {
    if (e.key !== key) continue;
    const last = out.find((p) => p.branch === e.branch);
    if (last) last.tipSha = e.tipSha; // tips advance — newest wins
    else out.push({ branch: e.branch, tipSha: e.tipSha });
  }
  return out;
}

/** Best-effort web URL for a commit. Parsing is STRUCTURAL, not shape-guessing:
 *  URL-shaped remotes go through the standard URL parser (credentials, ports,
 *  IPv6, tilde owners, nested GitLab subgroups all handled correctly); the one
 *  legacy non-URL shape — scp-style `git@host:path` — is the explicit fallback.
 *  Anything whose web layout would NOT follow the cgit convention
 *  (`https://<host>/<path>/commit/<sha>`) returns null instead of a silently
 *  wrong link: non-http(s) schemes (ssh:// carries a transport port the web UI
 *  doesn't share; file:// is local), explicit ports, Azure-DevOps /_git/ paths.
 *  Those repos still get the LOCAL pointers (path + branch@sha + diff command),
 *  which is why the enrichment is additive, never either/or. */
export function webUrlForCommit(repo: string, tipSha: string): string | null {
  const url = git(repo, ["remote", "get-url", "origin"]);
  if (!url) return null;
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.port) return null; // nonstandard web port — can't guess; local pointers cover it
    if (u.pathname.includes("/_git/")) return null; // Azure-DevOps layout — transform would be silently wrong
    host = u.hostname;
    path = u.pathname.replace(/^\/+/, "");
  } catch {
    // scp-style (the only common non-URL shape): git@host:owner/repo.git
    const scp = url.replace(/^[^@]+@/, "");
    const i = scp.indexOf(":");
    if (i <= 0) return null;
    host = scp.slice(0, i);
    path = scp.slice(i + 1);
  }
  const clean = path.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !clean.includes("/")) return null; // need owner/repo — a bare repo path has no forge convention
  return `https://${host}/${clean}/commit/${tipSha}`;
}

/** Files the worker changed on its parallel branch vs main — the DELIVERABLE
 *  pointers (a document the user must read is a path, not a diff command).
 *  Markdown/docs sort first (they are usually the deliverable); capped so a
 *  100-file code change cannot flood the handover. Best-effort: null on any
 *  git failure. */
export function deliverablePathsFor(repo: string, tipSha: string, base = "main", cap = 6): string[] | null {
  const diff = git(repo, ["diff", "--name-only", `${base}...${tipSha}`]);
  if (!diff) return null;
  const files = diff.split("\n").map((f) => f.trim()).filter(Boolean);
  const docs = files.filter((f) => /\.(md|mdx|txt|rst)$/i.test(f) || /^docs\//.test(f));
  const rest = files.filter((f) => !docs.includes(f));
  return [...docs, ...rest].slice(0, cap);
}

/**
 * RETENTION: delete keep refs whose job is done — the item reached a terminal
 * status (done/rejected) or the journaled tip became reachable from main.
 * Returns the refs deleted this call. Idempotent: already-deleted refs no-op.
 */
export function prunePreservedRefs(stateDir: string): string[] {
  const store = loadStore(stateDir);
  if (!store) return [];
  const deleted: string[] = [];
  const seen = new Set<string>();
  // Newest entry per runId wins (tips advance; the latest is what matters).
  const latest = new Map<string, HandoffEntry>();
  for (const e of readJournal(stateDir)) {
    latest.set(e.runId, e);
    seen.add(e.runId);
  }
  for (const [runId, entry] of latest) {
    const ref = keepRefFor(runId);
    const item = store.items[entry.key];
    const terminal = item?.status === "done" || item?.status === "rejected";
    const merged = terminal ? false : tipReachableFromMain(item?.cwd ?? ".", entry.tipSha);
    if (!terminal && !merged) continue;
    // The ref lives in the item's repo — same place the branch was deleted.
    if (git(item?.cwd ?? ".", ["update-ref", "-d", ref]) !== null || git(item?.cwd ?? ".", ["rev-parse", "--verify", "--quiet", ref]) === null) {
      deleted.push(ref);
    }
  }
  return deleted;
}

/** The pointer-rich review-target list for a human-review handover: cwd first,
 *  then each journaled branch@tip (with its view/diff commands), the
 *  changed-file deliverable paths (branch-scoped), and a best-effort web link.
 *  Shared by the auto-flag (PASS handover) and the decision panel — one
 *  source for "where do I navigate to review this". */
export function humanReviewTargetsFor(stateDir: string, key: string, item: { cwd?: string | null }): string[] {
  const targets: string[] = [];
  if (item.cwd) targets.push(item.cwd);
  try {
    for (const p of reviewPointersFor(stateDir, key)) {
      targets.push(`branch ${p.branch} @ ${p.tipSha.slice(0, 8)} — diff vs main: git diff main...${p.tipSha.slice(0, 8)}`);
      const files = item.cwd ? deliverablePathsFor(item.cwd, p.tipSha) : null;
      if (files?.length) {
        targets.push(...files.map((f) => `${f} — on branch (view: git show ${p.tipSha.slice(0, 8)}:${f})`));
      }
      const web = item.cwd ? webUrlForCommit(item.cwd, p.tipSha) : null;
      if (web) targets.push(web);
    }
  } catch {
    // pointer enrichment must never break the handover / panel
  }
  return targets.length ? targets : [item.cwd ?? "", `the reviewed work (queue item ${key})`];
}
