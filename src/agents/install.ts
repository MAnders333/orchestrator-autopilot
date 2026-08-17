// agents/install.ts — the framework's AGENT registry + installer. The
// framework SHIPS the agents it depends on (queue_review spawns the reviewer,
// queue_dispatch spawns the worker) — each agent is a canonical body
// (agents/<name>/canonical.md, version-stamped) projected into each backend's
// agent directory with that backend's frontmatter dialect. The prompt is
// canonical; the frontmatter/settings are per-backend.
//
// Projections: opencode gets BOTH agents (no builtin worker/reviewer of ours —
// 'worker' is free, the reviewer is orchestrator-reviewer to avoid clobbering
// pi-subagents' builtin reviewer). pi gets ONLY the reviewer (the framework
// uses pi-subagents' builtin worker). claude builders are ready for the port.
//
// Idempotent + version-stamped: activation re-installs on framework upgrades,
// skips when current. Consumers may edit per-backend frontmatter freely; the
// canonical BODY is framework-managed between markers. Never throws.

import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

interface AgentDef {
  /** Agent file name (frontmatter `name:` + file name). */
  name: string;
  /** Directory under agents/ holding canonical.md. */
  dir: string;
  description: string;
  /** pi-subagents tools allowlist (projectToPi agents only). */
  piTools: string;
  opencodeMode: "all" | "subagent" | "primary";
  /** opencode permission block, YAML body ALREADY indented two spaces. */
  opencodePermission: string;
  /** Project to pi (~/.pi/shared/agents + mode symlinks)? Reviewer yes; the
   *  worker is pi-subagents' builtin — no collision there, no projection. */
  projectToPi: boolean;
}

const REVIEWER_DESC =
  "Orchestrator framework review agent — gates worker completion with an evidence-based Verdict: PASS/FAIL contract. Read-only.";
const WORKER_DESC =
  "Orchestrator framework implementation agent — executes queue-dispatched tasks with worktree isolation + commit-early discipline. Full tools.";

const AGENTS: Record<string, AgentDef> = {
  reviewer: {
    name: "orchestrator-reviewer",
    dir: "reviewer",
    description: REVIEWER_DESC,
    piTools: "read, grep, find, ls",
    opencodeMode: "subagent",
    opencodePermission: `  "*": deny
  read:
    "*": "allow"
    "*.env": "deny"
    "*.env.*": "deny"
    "*.env.template": "allow"
    "*.env.example": "allow"
  list: allow
  glob: allow
  grep: allow
  bash:
    "git status": allow
    "git diff*": allow
    "git log*": allow
    "git show*": allow
    "*": deny`,
    projectToPi: true,
  },
  worker: {
    name: "worker",
    dir: "worker",
    description: WORKER_DESC,
    piTools: "",
    opencodeMode: "all",
    // Full allow: headless `oc run` workers cannot answer interactive
    // permission prompts — 'ask' would stall the run. The task prompt is the
    // behavioral contract (worktree isolation, commit-early). external_directory
    // lets the worker create its private worktree (../<key>-work) + scratch in
    // /tmp — the repo itself comes from queue_dispatch's cwd.
    opencodePermission: `  read: allow
  list: allow
  glob: allow
  grep: allow
  webfetch: allow
  bash: allow
  edit: allow
  write: allow
  todoread: allow
  todowrite: allow
  task: allow
  external_directory:
    "*": allow`,
    projectToPi: false,
  },
};

// ---------------------------------------------------------------------------
// Canonical bodies + version stamps
// ---------------------------------------------------------------------------

const VERSION_RE = /<!--\s*orchestrator-(\w+)-version:\s*(\d+)\s*-->/;

/** The canonical body of a framework agent (agents/<name>/canonical.md). */
export function canonicalBody(agent: keyof typeof AGENTS | string = "reviewer"): string {
  return readFileSync(join(__dirname, AGENTS[agent]?.dir ?? agent, "canonical.md"), "utf8");
}

/** Parse the version stamp out of a canonical body or an installed file. */
export function canonicalVersion(text: string): number {
  const m = text.match(VERSION_RE);
  return m ? Number(m[2]) : 0;
}

function marker(agent: AgentDef): { open: string; close: string } {
  return {
    open: `<!-- ${agent.name}: framework-managed canonical body (src/agents/${agent.dir}/canonical.md); do not hand-edit -->`,
    close: "<!-- /canonical-prompt -->",
  };
}

// ---------------------------------------------------------------------------
// Dialect builders (frontmatter per backend + synced canonical body)
// ---------------------------------------------------------------------------

/** pi-subagents dialect. */
export function buildPiFile(body: string, agentName = "orchestrator-reviewer"): string {
  const def = Object.values(AGENTS).find((a) => a.name === agentName) ?? AGENTS.reviewer;
  return `---
name: ${def.name}
description: ${def.description}
tools: ${def.piTools}
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

${marker(def).open}
${body.trim()}
${marker(def).close}
`;
}

/** OpenCode dialect (mode + permission per agent). */
export function buildOpenCodeFile(body: string, agentName = "orchestrator-reviewer"): string {
  const def = Object.values(AGENTS).find((a) => a.name === agentName) ?? AGENTS.reviewer;
  return `---
description: ${def.description}
mode: ${def.opencodeMode}
permission:
${def.opencodePermission}
---

${marker(def).open}
${body.trim()}
${marker(def).close}
`;
}

/** Claude Code dialect. */
export function buildClaudeFile(body: string, agentName = "orchestrator-reviewer"): string {
  const def = Object.values(AGENTS).find((a) => a.name === agentName) ?? AGENTS.reviewer;
  const tools = def.projectToPi ? "Read, Grep, Glob, LS" : "Read, Grep, Glob, LS, Bash, Edit, Write";
  return `---
description: ${def.description}
tools: ${tools}
---

${marker(def).open}
${body.trim()}
${marker(def).close}
`;
}

/** Where each backend's agent files live (documented for the portability
 *  story; pi resolves relative to the pi config dir at install time). */
export const reviewerPaths = {
  opencode: join(homedir(), ".config/opencode/agents", `${AGENTS.reviewer.name}.md`),
  claude: join(homedir(), ".claude/agents", `${AGENTS.reviewer.name}.md`),
};

export interface InstallOptions {
  /** e.g. ~/.pi/shared/agents — real file + symlinks from mode dirs (dotfiles
   *  convention). When absent, writes a real file into modeAgentsDirs[0]. */
  sharedAgentsDir?: string;
  /** e.g. [~/.pi/work/agents, ~/.pi/personal/agents]. Default: both pi mode
   *  agent dirs that exist. */
  modeAgentsDirs?: string[];
  force?: boolean;
  log?: (line: string) => void;
}

export interface InstallResult {
  installed: boolean; // wrote/updated the file (false when current or unable)
  skipped: boolean;   // already current (no write) or no target dir
  path: string;       // where the real agent file lives
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

function writeFile(content: string, file: string, agentName: string, log: (l: string) => void): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  log(`${agentName}: installed v${canonicalVersion(content)} → ${file}`);
}

/** True when a file-system entry exists at the path (symlink included — do
 *  not follow). */
function linkEntryExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Install (or refresh) the PI reviewer agent. Idempotent + version-stamped.
 *  Never throws — callers (extension activation) must not break the host. */
export function installPiReviewer(opts: InstallOptions = {}): InstallResult {
  try {
    const def = AGENTS.reviewer;
    const body = canonicalBody("reviewer");
    const version = canonicalVersion(body);
    const content = buildPiFile(body, def.name);

    const shared = opts.sharedAgentsDir ?? join(homedir(), ".pi/shared/agents");
    const modeDirs = opts.modeAgentsDirs !== undefined
      ? opts.modeAgentsDirs
      : ["work", "personal"].map((m) => join(homedir(), `.pi/${m}/agents`)).filter((d) => existsSync(d));

    const log = opts.log ?? (() => {});
    const isCurrent = (file: string): boolean =>
      existsSync(file) && !opts.force && canonicalVersion(readFileSync(file, "utf8")) >= version;
    const ensureSymlinks = (realFile: string): void => {
      for (const modeDir of modeDirs) {
        const link = join(modeDir, `${def.name}.md`);
        if (linkEntryExists(link)) continue; // existing file/link — leave it
        mkdirSync(modeDir, { recursive: true });
        symlinkSync(relative(dirname(link), realFile), link);
      }
    };

    if (existsSync(shared)) {
      const sharedFile = join(shared, `${def.name}.md`);
      ensureSymlinks(sharedFile);
      if (isCurrent(sharedFile)) return { installed: false, skipped: true, path: sharedFile };
      writeFile(content, sharedFile, def.name, log);
      return { installed: true, skipped: false, path: sharedFile };
    }

    const modeDir = modeDirs[0];
    if (!modeDir) return { installed: false, skipped: true, path: "" };
    const file = join(modeDir, `${def.name}.md`);
    if (isCurrent(file)) return { installed: false, skipped: true, path: file };
    writeFile(content, file, def.name, log);
    return { installed: true, skipped: false, path: file };
  } catch (err) {
    opts.log?.(`orchestrator-reviewer: install failed: ${err instanceof Error ? err.message : String(err)}`);
    return { installed: false, skipped: true, path: "" };
  }
}

/** Install (or refresh) an OPENCODE agent projection (reviewer + worker).
 *  Real files in ~/.config/opencode/agents/ (opencode reads the dir directly;
 *  no symlink convention). Idempotent + version-stamped. Never throws. */
export function installOpenCodeAgent(agent: keyof typeof AGENTS, opts: { agentsDir?: string; force?: boolean; log?: (line: string) => void } = {}): InstallResult {
  try {
    const def = AGENTS[agent];
    const body = canonicalBody(agent);
    const version = canonicalVersion(body);
    const content = buildOpenCodeFile(body, def.name);
    const agentsDir = opts.agentsDir ?? join(homedir(), ".config/opencode/agents");
    const file = join(agentsDir, `${def.name}.md`);
    if (existsSync(file) && !opts.force && canonicalVersion(readFileSync(file, "utf8")) >= version) {
      return { installed: false, skipped: true, path: file };
    }
    writeFile(content, file, def.name, opts.log ?? (() => {}));
    return { installed: true, skipped: false, path: file };
  } catch (err) {
    opts.log?.(`${agent}: opencode install failed: ${err instanceof Error ? err.message : String(err)}`);
    return { installed: false, skipped: true, path: "" };
  }
}

/** Backward-compat aliases. */
export function installOpenCodeReviewer(opts: { agentsDir?: string; force?: boolean; log?: (line: string) => void } = {}): InstallResult {
  return installOpenCodeAgent("reviewer", opts);
}
export function installOpenCodeWorker(opts: { agentsDir?: string; force?: boolean; log?: (line: string) => void } = {}): InstallResult {
  return installOpenCodeAgent("worker", opts);
}

/** True when the installed pi reviewer already carries the current body —
 *  used by tests and by the queue_review fail-closed check. The optional
 *  modeAgentsDirs overrides the real ~/.pi mode dirs (tests inject temp
 *  dirs so a live install on this machine doesn't mask results). */
export function piReviewerCurrent(sharedAgentsDir?: string, modeAgentsDirs?: string[]): boolean {
  const name = AGENTS.reviewer.name;
  const shared = sharedAgentsDir ?? join(homedir(), ".pi/shared/agents");
  const modes = modeAgentsDirs ?? ["work", "personal"].map((m) => join(homedir(), `.pi/${m}/agents`));
  const candidates = [join(shared, `${name}.md`), ...modes.map((d) => join(d, `${name}.md`))];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && canonicalVersion(readFileSync(candidate, "utf8")) >= canonicalVersion(canonicalBody("reviewer"))) return true;
    } catch {
      // unreadable candidate — skip
    }
  }
  return false;
}

export const REVIEWER_AGENT_NAME = AGENTS.reviewer.name;
export const WORKER_AGENT_NAME = AGENTS.worker.name;
