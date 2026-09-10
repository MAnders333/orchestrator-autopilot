// main-write-guard.ts — MAIN IMMUTABILITY GUARD (KEY: MAIN-IMMUTABILITY-GUARD).
//
// The rule "nothing merges to main before human approval" is codified in the
// skills + prompts (commit 55ce183) — but guidance alone can lose (a live
// incident: a recovered deliverable was committed to main pre-review). This
// guard makes the rule MECHANICAL, not advisory.
//
// Mechanics: every runner reconcile step (sweep) records the main-branch HEAD
// of every repo the queue references — one `git rev-parse` per repo per sweep
// (lightweight by construction). When a recorded HEAD moves between two
// reconcile steps (i.e. a harness/worker-owned process wrote to main during a
// worker round) WHILE ≥1 item referencing that repo is NOT human-approved
// (pre-`done`), the runner emits the `orch:main-write-pre-approval` WARNING
// domain event + a loud `[orch-tick: main-write]` tick naming the SHA and the
// offending key(s). The new HEAD is recorded regardless, so a legitimate
// post-approval merge-finisher shipping step never re-fires the warning.
//
// Tracked refs: the local `main` branch AND the `origin/main` remote-tracking
// ref (either can carry a main write — merge-to-main without a remote vs a
// push to the remote). Both are compared independently against their own
// baseline; a single pull can legitimately move both.
//
// The ONE legitimate main writer — the post-approval shipping lane — declares
// its own write through `recordExpectedMainWrite` (see below), because that
// merge lands AFTER this sweep's baseline was taken.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadStore, type QueueStore } from "../queue-store.ts";

/** The main refs the guard tracks (short names; rev-parsed fully-qualified). */
export const MAIN_REFS = ["origin/main", "main"] as const;

/** One moving of a tracked main ref between two reconcile steps. */
export interface MainWriteWarning {
  repo: string;
  /** Which main ref moved: `origin/main` (push to the remote) or `main`
   *  (merge-to-main without a remote / local merge). */
  ref: string;
  /** The NEW main HEAD — what landed on main. */
  sha: string;
  /** The baseline recorded at the previous reconcile step. */
  previousSha: string;
  /** The pre-done (not human-approved) item keys referencing this repo. */
  keys: string[];
  ts: string;
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function mainHeadsPath(stateDir: string): string {
  return join(stateDir, "main-heads.json");
}

/** The previous reconcile step's recorded main heads: repo → ref → sha. */
export function readMainHeads(stateDir: string): Record<string, Record<string, string>> {
  try {
    const p = mainHeadsPath(stateDir);
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as { repos?: Record<string, Record<string, string>> };
    return raw?.repos && typeof raw.repos === "object" ? raw.repos : {};
  } catch {
    return {};
  }
}

/** The resolved tip of one tracked main ref (null when absent / not a repo —
 *  a repo without main is invisible to the guard, exactly like a non-repo). */
export function mainRefHead(repo: string, ref: string): string | null {
  if (ref === "origin/main") return git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]);
  if (ref === "main") return git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]);
  return null;
}

/** The keys of the items referencing `repo` that are NOT yet human-approved
 *  (pre-`done`). `done` = human-approved; `rejected` = deliberately dropped —
 *  neither is in-flight queued work, so neither makes a main write suspect. */
export function preDoneKeysFor(store: QueueStore, repo: string): string[] {
  return Object.values(store.items)
    .filter((it) => it.cwd === repo && it.status !== "done" && it.status !== "rejected")
    .map((it) => it.key)
    .sort();
}

/**
 * THE reconcile-step check. Records each queue-referenced repo's main HEAD
 * (baseline for the NEXT step) and returns a warning for every tracked main
 * ref that moved since the previous step while that repo had pre-done items.
 * The recorded HEAD is advanced regardless of the warning so the same write
 * is never flagged twice — and so the legitimate post-approval merge-finisher
 * merge (all items done) advances the baseline silently. Best-effort: git or
 * store failures skip the repo and leave the state untouched — this guard
 * must never break a sweep.
 */
function writeMainHeads(stateDir: string, repos: Record<string, Record<string, string>>): boolean {
  try {
    const p = mainHeadsPath(stateDir);
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, repos }, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE EXPECTED-WRITE HANDSHAKE (KEY: AUTO-SHIP-ON-DONE × MAIN-IMMUTABILITY-GUARD).
 *
 * The post-approval shipping lane is the only legitimate main writer, and its
 * merge lands AFTER this sweep's `checkMainWrites` already recorded the
 * PRE-merge baseline. Without this handshake the NEXT sweep sees the lane's
 * own merge as an unexplained main move — and `preDoneKeysFor` still counts
 * every other in-flight item on that repo — so the guard would fire a FALSE
 * violation on its own shipping step. The lane therefore declares exactly what
 * it wrote and the baseline advances to THAT sha, nothing else.
 *
 * Deliberately NARROW — the baseline is refused (so the violation still fires
 * on the next sweep) unless BOTH hold:
 *   - the ref is at `sha` RIGHT NOW (the lane's own commit, not a later one), and
 *   - the recorded baseline is `sha`'s FIRST PARENT — the exact shape a
 *     `git merge --no-ff` on the base produces. Anything else moved the base
 *     in between, which is precisely the pre-approval write the guard exists
 *     to catch, so that write keeps its baseline and stays reportable.
 *
 * Returns whether the baseline was advanced.
 */
export function recordExpectedMainWrite(stateDir: string, repo: string, branch: string, sha: string): boolean {
  if (!(MAIN_REFS as readonly string[]).includes(branch)) return false; // not a tracked main ref — nothing to exempt
  if (mainRefHead(repo, branch) !== sha) return false; // the ref is not where the lane says it left it
  const heads = readMainHeads(stateDir);
  const prev = heads[repo]?.[branch];
  if (prev === sha) return true; // already the baseline
  if (prev) {
    const firstParent = git(repo, ["rev-parse", "--verify", "--quiet", `${sha}^1`]);
    if (firstParent !== prev) return false; // an unexplained move sits in between — keep the baseline, let the guard fire
  }
  heads[repo] = { ...(heads[repo] ?? {}), [branch]: sha };
  return writeMainHeads(stateDir, heads);
}

export function checkMainWrites(stateDir: string, ts = new Date().toISOString()): MainWriteWarning[] {
  const store = loadStore(stateDir);
  if (!store) return [];
  const repos = new Set(
    Object.values(store.items)
      .map((it) => it.cwd)
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0),
  );
  if (!repos.size) return [];
  const previous = readMainHeads(stateDir);
  const next: Record<string, Record<string, string>> = {};
  for (const [repo, heads] of Object.entries(previous)) next[repo] = { ...heads };
  const warnings: MainWriteWarning[] = [];
  for (const repo of repos) {
    const current: Record<string, string> = {};
    for (const ref of MAIN_REFS) {
      const sha = mainRefHead(repo, ref);
      if (sha) current[ref] = sha;
    }
    if (!Object.keys(current).length) continue; // not a repo / no main to compare
    next[repo] = current;
    const prev = previous[repo];
    const keys = preDoneKeysFor(store, repo);
    for (const ref of MAIN_REFS) {
      const sha = current[ref];
      if (!sha || !prev?.[ref] || prev[ref] === sha) continue; // first sighting or no movement
      if (!keys.length) continue; // everything human-approved — the merge-finisher lane
      warnings.push({ repo, ref, sha, previousSha: prev[ref], keys, ts });
    }
  }
  // best-effort recording — the guard still warns from this call's comparison
  if (Object.keys(next).length) writeMainHeads(stateDir, next);
  return warnings;
}