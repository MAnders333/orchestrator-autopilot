// shipping.ts — the SHIPPING LANE / merge-finisher (KEY: AUTO-SHIP-ON-DONE).
//
// `done` means human-approved, NOT merged: moving approved work into a base
// branch is the SEPARATE post-approval step this module owns, and it is gated
// by a PER-REPO SHIPPING POLICY (autopilot.config.json → `shipping.repos`,
// keyed by origin-slug or repo basename). NO FALLBACK — the msf incident root
// was a guess; a repo without a policy NEVER gets a guessed flow/base. The
// shipping pass NOTICES, asks the user ONCE (a pending intercom inquiry +
// ticket naming flow/baseBranches + detection-based hints), stays paused, and
// resumes on the sweep AFTER the orchestrator writes the one-time answer.
//
// Deterministic by construction — the lane is framework-owned git, never an
// LLM's judgment:
//   - flow 'mrs'   → for each baseBranch IN ORDER push the approved work's
//                    tip to origin and record an MR entry (base → MR URL /
//                    push ref). Requires a remote; never `--force`.
//   - flow 'merge' → merge the approved work into the LOCAL base branch
//                    (default main). No remote involved.
//   - skip when nothing new (tip already an ancestor of the base).
//   - conflicts → failure + escalation, never a forced merge.
//   - the item's `shippedAt` marker prevents re-merge; clearing it (a human
//     re-open leaves done) re-arms the lane.
//
// The runner calls runShippingPass on every reconcile sweep — one lane, one
// wiring point, both hosts (pi + opencode).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { loadStore, saveStore, updateItem } from "../queue-store.ts";
import { loadAutopilotConfig, type ShippingConfig, type ShippingRepoPolicy, type ShippingFlow } from "../config.ts";
import { reviewPointersFor } from "./worktree-preservation.ts";
import { recordExpectedMainWrite } from "./main-write-guard.ts";

export type { ShippingConfig, ShippingRepoPolicy, ShippingFlow };

// ---------------------------------------------------------------------------
// Policy resolution — NO FALLBACK (never guess flow/baseBranches; the msf
// incident root).
// ---------------------------------------------------------------------------

/** Validate a raw policy entry: flow ∈ {mrs, merge} and a non-empty
 *  baseBranches string array (ANY strings — order is the MR sequence). An
 *  invalid entry resolves as NO policy — the inquiry fires instead of a guess. */
export function normalizePolicy(raw: unknown): ShippingRepoPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const flow = r.flow;
  if (flow !== "mrs" && flow !== "merge") return null;
  const bases = Array.isArray(r.baseBranches) ? r.baseBranches : [];
  if (!bases.length || !bases.every((b) => typeof b === "string" && b.trim().length > 0)) return null;
  return { flow, baseBranches: bases.map((b) => String(b).trim()) };
}

function git(repo: string, args: string[]): string | null {
  try {
    // stderr swallowed (captured into the error) — "error: No such remote"
    // for repos without origin is an EXPECTED probe result, not noise
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** The repo's origin slug `owner/repo` (structural parse of `git remote get-url
 *  origin`), or null. Solely for policy key matching — never a web guess. */
export function originSlug(repo: string): string | null {
  const url = git(repo, ["remote", "get-url", "origin"]);
  if (!url) return null;
  let path = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "ssh:") return null;
    path = u.pathname.replace(/^\/+/, "");
  } catch {
    // scp-style git@host:owner/repo.git — the explicit fallback shape
    const scp = url.replace(/^[^@]+@/, "");
    const i = scp.indexOf(":");
    if (i <= 0) return null;
    path = scp.slice(i + 1);
  }
  const clean = path.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) return null; // a bare repo path has no forge slug
  return parts.slice(-2).join("/");
}

/** The config-key candidates for a repo, most specific first: the origin slug
 *  (exact) → the slug's bare repo name → the local basename. */
export function repoPolicyKeys(repo: string): string[] {
  const keys: string[] = [];
  const slug = originSlug(repo);
  if (slug) {
    keys.push(slug);
    const bare = slug.split("/").pop();
    if (bare && !keys.includes(bare)) keys.push(bare);
  }
  const base = basename(repo);
  if (base && !keys.includes(base)) keys.push(base);
  return keys;
}

/** The display/policy key suggested in the inquiry (slug when derivable, else
 *  the repo basename). */
export function suggestedPolicyKey(repo: string): string {
  return originSlug(repo) ?? basename(repo);
}

export interface ResolvedPolicy {
  /** The config key that matched (`repos[<key>]`). */
  key: string;
  policy: ShippingRepoPolicy;
}

/** Resolve the policy for one repo. NULL on a policy-less repo — the caller
 *  fires the policy-inquiry instead of shipping anything (NO FALLBACK). */
export function resolveRepoPolicy(stateDir: string, repo: string, cfg?: ReturnType<typeof loadAutopilotConfig>): ResolvedPolicy | null {
  const shipping = (cfg ?? loadAutopilotConfig(stateDir)).shipping;
  const repos = shipping?.repos ?? {};
  for (const key of repoPolicyKeys(repo)) {
    const policy = normalizePolicy(key in repos ? repos[key] : undefined);
    if (policy) return { key, policy };
  }
  return null;
}

/** The merge mode (auto/manual). Default auto. `manual` suppresses the lane —
 *  batch finishers stay an explicit orchestrator act (the tick nudges). */
export function mergeModeOf(cfg: Pick<ReturnType<typeof loadAutopilotConfig>, "shipping">): "auto" | "manual" {
  return cfg.shipping?.mergeMode === "manual" ? "manual" : "auto";
}

// ---------------------------------------------------------------------------
// Policy-inquiry state (the one-time intercom ask; the run stays paused until
// the orchestrator writes the answer).
// ---------------------------------------------------------------------------

export interface PolicyInquiry {
  key: string;         // the config key suggested for `repos`
  repo: string;
  question: string;
  hints: string[];
  ts: string;
}

interface ShippingState {
  version: 1;
  /** Pending per-repo policy inquiries (one-time intercom asks). A present
   *  entry means the question is already out — no re-ask, no shipping. */
  inquiries: Record<string, PolicyInquiry>;
/** One-time suppression for non-shipping nudges (manual-mode nudges, failure
 *  floors). The value is the item's `updatedAt` at notify time — RE-ARMED when
 *  the item is re-approved (a status change re-stamps updatedAt, so a fresh
 *  done cycle gets ONE new escalation instead of a permanent silence). */
  notified: Record<string, string>;
}

export function shippingStatePath(stateDir: string): string {
  return join(stateDir, "shipping.json");
}

function readShippingState(stateDir: string): ShippingState {
  try {
    const p = shippingStatePath(stateDir);
    if (!existsSync(p)) return { version: 1, inquiries: {}, notified: {} };
    const raw = JSON.parse(readFileSync(p, "utf8")) as ShippingState;
    return { version: 1, inquiries: raw?.inquiries ?? {}, notified: raw?.notified ?? {} };
  } catch {
    return { version: 1, inquiries: {}, notified: {} };
  }
}

function writeShippingState(stateDir: string, s: ShippingState): void {
  try {
    const p = shippingStatePath(stateDir);
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch {
    // best-effort — shipping still proceeds on the next sweep after a policy lands
  }
}

/** Detection-based candidate hints for the policy ask (setup help ONLY — what
 *  the repo offers, never a recommendation): the remote default branch
 *  (refs/remotes/origin/HEAD), local + origin branch names. Branch protection
 *  is not detectable locally — named so the orchestrator knows it is a blind
 *  spot, not a guess. */
export function detectionHints(repo: string): string[] {
  const hints: string[] = [];
  const head = git(repo, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  if (head) hints.push(`remote default branch: ${head.replace(/^origin\//, "")}`);
  const local = (git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]) ?? "")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (local.length) hints.push(`local branches: ${local.slice(0, 8).join(", ")}`);
  const remote = (git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"]) ?? "")
    .split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/HEAD")).map((s) => s.replace(/^origin\//, ""));
  if (remote.length) hints.push(`origin branches: ${remote.slice(0, 8).join(", ")}`);
  hints.push("branch protection is NOT detectable locally — supply it yourself if it matters (setup help only)");
  return hints;
}

/** The one-time inquiry question — the exact phrasing the contract names. */
export function policyQuestion(repo: string, key: string): string {
  return `shipping policy for ${key}? flow (mrs|merge), baseBranches (order = MR sequence) — repo: ${repo}, config key: shipping.repos['${key}']`;
}

/** Write the pending one-time inquiry (idempotent: re-asking until the policy
 *  lands is suppressed by the existing entry). Returns the inquiry + whether
 *  it is FRESH (the caller emits the ask once). */
export function ensurePolicyInquiry(stateDir: string, repo: string, now = new Date().toISOString()): { inquiry: PolicyInquiry; fresh: boolean } {
  const s = readShippingState(stateDir);
  const key = suggestedPolicyKey(repo);
  const existing = s.inquiries[key];
  if (existing) return { inquiry: existing, fresh: false };
  const inquiry: PolicyInquiry = { key, repo, question: policyQuestion(repo, key), hints: detectionHints(repo), ts: now };
  s.inquiries[key] = inquiry;
  writeShippingState(stateDir, s);
  return { inquiry, fresh: true };
}

/** Clear a policy inquiry once the policy exists — the run RESUMES. */
export function clearPolicyInquiry(stateDir: string, repoKey: string): void {
  const s = readShippingState(stateDir);
  if (s.inquiries[repoKey]) {
    delete s.inquiries[repoKey];
    writeShippingState(stateDir, s);
  }
}

/** True when the nudge is still fresh; a STALE entry (the item was re-stamped
 *  since — a new approval cycle) is cleared and re-armed. */
function nudgeSuppressed(stateDir: string, id: string, itemUpdatedAt: string): boolean {
  const s = readShippingState(stateDir);
  const mark = s.notified[id];
  if (mark === undefined) return false;
  if (mark !== itemUpdatedAt) {
    delete s.notified[id]; // the item was re-approved — re-arm the one-time nudge
    writeShippingState(stateDir, s);
    return false;
  }
  return true;
}

function markNotified(stateDir: string, id: string, itemUpdatedAt: string): void {
  const s = readShippingState(stateDir);
  s.notified[id] = itemUpdatedAt;
  writeShippingState(stateDir, s);
}

// ---------------------------------------------------------------------------
// The shipping lane (deterministic git; merge-finisher semantics)
// ---------------------------------------------------------------------------

export interface WorkTip {
  branch: string;
  sha: string;
}

/** The approved work's tip for one item: the latest journaled parallel-branch
 *  tip (worktree-preservation). Null when nothing was captured — the work is
 *  already on the base / a direct deliverable; nothing to ship. */
export function resolveWorkTip(stateDir: string, key: string, repo: string): WorkTip | null {
  try {
    const pointers = reviewPointersFor(stateDir, key);
    if (!pointers.length) return null;
    const last = pointers[pointers.length - 1]; // newest branch; its tip is the delivered state
    if (git(repo, ["cat-file", "-e", `${last.tipSha}^{commit}`]) === null) return null; // gone — nothing to ship
    return { branch: last.branch, sha: last.tipSha };
  } catch {
    return null;
  }
}

function isAncestor(repo: string, tip: string, ref: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", tip, ref], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface ShipMerge {
  base: string;
  sha: string;
}

export interface ShipMr {
  /** The MR target base branch (ORDER = the declared baseBranches sequence). */
  base: string;
  /** The pushed source branch (the approved work's branch). */
  source: string;
  /** The pushed tip. */
  sha: string;
  /** MR/create URL when the remote's web layout is derivable, else null (the
   *  push ref is the pointer). */
  url: string | null;
}

export interface ShipResult {
  ok: boolean;
  flow: ShippingFlow;
  /** flow 'merge': the local base merges applied (after a successful ship). */
  merges?: ShipMerge[];
  /** flow 'mrs': one entry per baseBranch, in order. */
  mrs?: ShipMr[];
  /** true when nothing new (tip already on the base / already pushed) — a
   *  legitimate no-op, marked shipped. */
  skipped?: boolean;
  /** failure reason (never forced): conflict, checkout/base missing, no
   *  remote, non-fast-forward push, … */
  reason?: string;
  /** true when the failure was a merge conflict (the never-force case). */
  conflict?: boolean;
}

/** Best-effort MR-create URL for a known forge layout; null when the remote's
 *  web layout would be a guess (local/file remotes, unknown hosts). Never
 *  fabricated — the push ref remains the pointer. */
export function mrCreateUrl(repo: string, source: string, base: string): string | null {
  const slug = originSlug(repo);
  if (!slug) return null;
  const url = git(repo, ["remote", "get-url", "origin"]);
  if (!url) return null;
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.port) return null;
    host = u.hostname;
  } catch {
    const scp = url.replace(/^[^@]+@/, "");
    const i = scp.indexOf(":");
    if (i <= 0) return null;
    host = scp.slice(0, i);
  }
  const enc = (p: string): string => encodeURIComponent(p);
  if (/gitlab/i.test(host)) {
    return `https://${host}/${slug}/-/merge_requests/new?merge_request[source_branch]=${enc(source)}&merge_request[target_branch]=${enc(base)}`;
  }
  // github + the generic compare layout
  return `https://${host}/${slug}/compare/${enc(base)}...${enc(source)}?expand=1`;
}

/** The merge-finisher ITSELF. Deterministic git, per the declared policy:
 *  flow 'merge' merges the work into the local base (default main); flow 'mrs'
 *  pushes the work to origin, one MR entry per baseBranch in the declared
 *  order. Skips when the tip is already on the base. NEVER forces: a merge
 *  conflict or a rejected push is a FAILURE with the reason — the item stays
 *  unshipped and the orchestrator is escalated to. */
export function shipItem(input: {
  repo: string;
  key: string;
  branch: string;
  sha: string;
  policy: ShippingRepoPolicy;
}): ShipResult {
  const { repo, sha, policy } = input;
  if (policy.flow === "merge") {
    const base = policy.baseBranches[0] ?? "main"; // 'merge' = merge to main (the declared flow, not a guess)
    if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`]) === null) {
      return { ok: false, flow: "merge", reason: `local base branch '${base}' does not exist — fix the policy baseBranches or create the branch` };
    }
    if (isAncestor(repo, sha, `refs/heads/${base}`)) return { ok: true, flow: "merge", skipped: true }; // nothing new
    // The lane owns the base checkout — post-approval, a clean state is the
    // declared precondition (a dirty tree makes checkout/merge fail → failure).
    if (git(repo, ["checkout", "-q", base]) === null) {
      return { ok: false, flow: "merge", reason: `could not checkout '${base}' (dirty tree or missing ref) — resolve locally, then re-ship` };
    }
    if (git(repo, ["merge", "--no-ff", "-m", `ship ${input.key} (post-approval merge-finisher)`, sha]) === null) {
      git(repo, ["merge", "--abort"]); // never leave a conflicted tree around; never force the merge
      return { ok: false, flow: "merge", reason: `merge conflict on '${base}' — resolve on the branch, then re-ship`, conflict: true };
    }
    const newSha = git(repo, ["rev-parse", "--verify", "refs/heads/" + base]);
    if (!newSha) return { ok: false, flow: "merge", reason: "merge applied but base HEAD unreadable" };
    return { ok: true, flow: "merge", merges: [{ base, sha: newSha }] };
  }
  // flow 'mrs' — a remote is REQUIRED (one MR per baseBranch; no remote = failure, never a merge guess)
  if (git(repo, ["remote", "get-url", "origin"]) === null) {
    return { ok: false, flow: "mrs", reason: "policy flow is 'mrs' but the repo has no 'origin' remote — fix the remote or the policy" };
  }
  const source = input.branch; // the approved work's branch (journaled pi-parallel-*)
  const mrs: ShipMr[] = [];
  for (const base of policy.baseBranches) {
    const baseRef = `refs/remotes/origin/${base}`;
    if (git(repo, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]) !== null && isAncestor(repo, sha, baseRef)) {
      continue; // already on that base — nothing new for THIS MR
    }
    // never --force: a rejected (non-fast-forward) push is a failure
    if (git(repo, ["push", "origin", `${sha}:refs/heads/${source}`]) === null) {
      return { ok: false, flow: "mrs", reason: `push of ${source} to origin rejected (non-fast-forward?) — never forcing; reconcile then re-ship` };
    }
    git(repo, ["fetch", "-q", "origin"]); // keep local tracking refs truthful
    mrs.push({ base, source, sha, url: mrCreateUrl(repo, source, base) });
  }
  if (!mrs.length) return { ok: true, flow: "mrs", skipped: true }; // nothing new anywhere
  return { ok: true, flow: "mrs", mrs };
}

// ---------------------------------------------------------------------------
// The per-sweep pass (runner wiring target)
// ---------------------------------------------------------------------------

export interface ShippingOutcome {
  kind: "shipped" | "skipped" | "policy-inquiry" | "manual" | "failure";
  key: string;
  repo: string;
  message: string;
  event?: { name: string; data?: Record<string, unknown> };
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** One sweep's shipping decisions. Deterministic, side-effectful (git merges /
 *  pushes, store shippedAt markers, inquiry state), returns what the runner
 *  should TICK. Never throws — a shipping failure is an outcome, never a
 *  broken sweep. */
export function runShippingPass(stateDir: string, now = new Date().toISOString()): ShippingOutcome[] {
  const cfg = loadAutopilotConfig(stateDir);
  const mode = mergeModeOf(cfg);
  const store = loadStore(stateDir);
  if (!store) return [];
  const done = Object.values(store.items)
    .filter((i) => i.status === "done" && typeof i.cwd === "string" && i.cwd.trim().length > 0 && !i.shippedAt)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1)); // oldest first
  const outcomes: ShippingOutcome[] = [];
  for (const item of done) {
    const repo = item.cwd as string;
    const resolved = resolveRepoPolicy(stateDir, repo, cfg);
    if (!resolved) {
      // POLICY-INQUIRY: the run NOTICES + ASKS the user once (intercom flag,
      // like OTP) — nothing merges before the policy is set (NO FALLBACK).
      const { inquiry, fresh } = ensurePolicyInquiry(stateDir, repo, now);
      if (!fresh) continue; // already asked — paused, no re-ask, no guess
      const hints = inquiry.hints.length ? ` Hints: ${inquiry.hints.join(" · ")}` : "";
      outcomes.push({
        kind: "policy-inquiry",
        key: item.key,
        repo,
        message:
          `[orch-tick: ship] ${inquiry.question}. ASK THE USER directly (one-time): relay their answer and write it to ` +
          `autopilot.config.json → shipping.repos['${inquiry.key}'] = { flow, baseBranches } (e.g. { flow: "mrs", baseBranches: ["main"] } for one MR, ["dev","master"] for two). ` +
          `Nothing ships and nothing merges until the policy is set.${hints} Not a user request; respond ≤2 lines.`,
        event: { name: "orch:shipping-policy-inquiry", data: { repo, key: item.key, policyKey: inquiry.key, question: inquiry.question, hints: inquiry.hints } },
      });
      continue;
    }
    clearPolicyInquiry(stateDir, resolved.key); // the policy landed — the run resumes
    if (mode === "manual") {
      // mergeMode manual: the lane stays EXPLICIT (batch finishers). Nudge once.
      const id = `manual:${item.key}`;
      if (nudgeSuppressed(stateDir, id, item.updatedAt)) continue;
      markNotified(stateDir, id, item.updatedAt);
      const plan = resolved.policy.flow === "mrs"
        ? resolved.policy.baseBranches.map((b) => `MR into ${b}`).join(" then ")
        : `merge into ${resolved.policy.baseBranches[0] ?? "main"}`;
      outcomes.push({
        kind: "manual",
        key: item.key,
        repo,
        message:
          `[orch-tick: ship] ${item.key} is DONE and ready to ship — mergeMode is manual, so the merge-finisher stays YOUR call: ` +
          `declared policy shipping.repos['${resolved.key}'] = ${JSON.stringify(resolved.policy)} → ${plan}. Ship it explicitly (run the finisher); it will not run itself. Not a user request; respond ≤2 lines.`,
      });
      continue;
    }
    // auto lane
    const tip = resolveWorkTip(stateDir, item.key, repo);
    if (!tip) continue; // nothing captured on a branch — likely already delivered; stay quiet
    const result = shipItem({ repo, key: item.key, branch: tip.branch, sha: tip.sha, policy: resolved.policy });
    if (!result.ok) {
      const id = `fail:${item.key}`;
      if (nudgeSuppressed(stateDir, id, item.updatedAt)) continue; // one escalation per failure floor
      markNotified(stateDir, id, item.updatedAt);
      const neverForce = result.conflict ? " A CONFLICT — never forced." : " Shipping FAILED — never forced.";
      outcomes.push({
        kind: "failure",
        key: item.key,
        repo,
        message:
          `[orch-tick: ship] SHIPPING FAILED ${item.key} (${result.reason ?? "unknown"}).${neverForce} The item stays DONE but unshipped (no shippedAt marker — it will be retried only after you escalate). Resolve on the branch, then re-ship; response ≤2 lines.`,
        event: { name: "orch:ship-failed", data: { key: item.key, repo, reason: result.reason ?? "unknown", conflict: result.conflict ?? false } },
      });
      continue;
    }
    if (result.skipped) {
      // nothing new — the work is already on the base; mark it shipped so the
      // lane never re-evaluates a done item forever.
      updateItem(store, item.key, { shippedAt: now, notes: item.notes ? `${item.notes}\n\n[shipped] ${now} — nothing new to merge (work already on the base).` : `[shipped] ${now} — nothing new to merge (work already on the base).` });
      continue;
    }
    // SHIPPED — mark + announce. The shippedAt marker prevents re-merge.
    //
    // First, the EXPECTED-WRITE HANDSHAKE with the main-immutability guard: a
    // flow 'merge' ship moves the LOCAL base, and this sweep's guard pass
    // already took its baseline before the merge — so the guard must be told
    // about this one write or it flags its own lane on the next sweep. The
    // exemption is narrow by construction: only the exact sha this merge just
    // produced, only for this human-approved item's base (the guard itself
    // refuses anything that is not the ref's current head sitting directly on
    // the recorded baseline).
    for (const m of result.merges ?? []) recordExpectedMainWrite(stateDir, repo, m.base, m.sha);
    const sha = result.flow === "merge" ? result.merges![0].sha : tip.sha;
    const flowNote = result.flow === "merge"
      ? `merged into ${result.merges![0].base} @ ${shortSha(sha)}`
      : `MR(s): ${result.mrs!.map((m) => (m.url ? `${m.url}` : `pushed ${m.source} → ${m.base} (${shortSha(m.sha)})`)).join("; ")}`;
    const note = `[shipped] ${now} — ${flowNote} (flow ${result.flow}, policy shipping.repos['${resolved.key}'])`;
    updateItem(store, item.key, { shippedAt: now, notes: item.notes ? `${item.notes}\n\n${note}` : note });
    const message = result.flow === "merge"
      ? `[orch-tick: ship] merged ${item.key} @ ${shortSha(sha)} (into ${result.merges![0].base}, policy ${resolved.key}, flow merge). Done deterministically shipped via the declared policy. Not a user request; respond ≤2 lines.`
      : `[orch-tick: ship] ${item.key} shipped — ${result.mrs!.map((m) => `MR into ${m.base}: ${m.url ?? `push ${m.source}@${shortSha(m.sha)}`}`).join("; ")} (policy ${resolved.key}, flow mrs). Not a user request; respond ≤2 lines.`;
    outcomes.push({
      kind: "shipped",
      key: item.key,
      repo,
      message,
      event: {
        name: "orch:item-shipped",
        data: {
          key: item.key,
          repo,
          flow: result.flow,
          policyKey: resolved.key,
          sha,
          ...(result.mrs ? { mrs: result.mrs.map((m) => ({ base: m.base, source: m.source, sha: m.sha, url: m.url })) } : {}),
          ...(result.merges ? { merges: result.merges } : {}),
        },
      },
    });
  }
  saveStore(stateDir, store);
  return outcomes;
}

// ---------------------------------------------------------------------------
// The one-time-answer writer (orchestrator writes the policy → the run resumes)
// ---------------------------------------------------------------------------

/** Write (or overwrite) ONE repo's policy in autopilot.config.json, preserving
 *  every other field + repo. This is the "orchestrator writes the one-time
 *  answer" path — the next sweep resolves the policy and ships. */
export function writeShippingPolicy(stateDir: string, repoKey: string, policy: ShippingRepoPolicy): void {
  const p = join(stateDir, "autopilot.config.json");
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const shipping = (raw.shipping && typeof raw.shipping === "object" ? raw.shipping : {}) as Record<string, unknown>;
  const repos = (shipping.repos && typeof shipping.repos === "object" ? shipping.repos : {}) as Record<string, unknown>;
  repos[repoKey] = policy;
  shipping.repos = repos;
  raw.shipping = shipping;
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}