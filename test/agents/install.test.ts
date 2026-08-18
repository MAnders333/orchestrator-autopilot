// install.test.ts — the framework-owned reviewer installer. Hermetic: temp
// dirs only, never touches ~/.pi. Covers: file shape (frontmatter + markers +
// body + version stamp), shared-dir + mode-symlink convention, idempotency,
// version-bump re-install, force, and the opencode/claude dialect builders.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readlinkSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  REVIEWER_AGENT_NAME,
  canonicalBody,
  canonicalVersion,
  buildPiFile,
  buildOpenCodeFile,
  buildClaudeFile,
  installPiReviewer,
  installOpenCodeWorker,
  piReviewerCurrent,
} from "../../src/agents/install.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "orch-reviewer-install-"));
}

const NAME = `${REVIEWER_AGENT_NAME}.md`;

describe("canonical body + version", () => {
  test("canonical.md exists with a version stamp and the verdict contract", () => {
    const body = canonicalBody();
    expect(canonicalVersion(body)).toBeGreaterThanOrEqual(1);
    expect(body).toContain("Verdict: PASS");
    expect(body).toContain("Verdict: FAIL");
    expect(body).toContain("FIRST non-empty line");
  });
});

describe("dialect builders", () => {
  const body = canonicalBody();

  test("pi file: frontmatter + markers + body + name", () => {
    const f = buildPiFile(body);
    expect(f).toContain(`name: ${REVIEWER_AGENT_NAME}`);
    expect(f).toContain("tools: read, grep, find, ls, bash");
    expect(f).toContain("systemPromptMode: replace");
    expect(f).toContain("orchestrator-reviewer: framework-managed canonical body");
    expect(f).toContain("<!-- /canonical-prompt -->");
    expect(f).toContain("Verdict: PASS");
    expect(canonicalVersion(f)).toBe(canonicalVersion(body)); // stamp survives projection
  });

  test("opencode file: read-only permission block", () => {
    const f = buildOpenCodeFile(body);
    expect(f).toContain(`description: Orchestrator framework review agent`);
    expect(f).toContain('"*": deny');
    expect(f).toContain("grep: allow");
    expect(f).toContain("Verdict: FAIL");
  });

  test("claude file: read-only tools", () => {
    const f = buildClaudeFile(body);
    expect(f).toContain("tools: Read, Grep, Glob, LS");
    expect(f).toContain("Verdict: PASS");
  });
});

describe("installPiReviewer (shared + mode dirs)", () => {
  test("writes the shared real file + symlinks mode agent dirs", () => {
    const root = tempDir();
    const shared = join(root, "shared/agents");
    const work = join(root, "work/agents");
    const personal = join(root, "personal/agents");
    mkdirSync(shared, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(personal, { recursive: true });

    const r = installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [work, personal] });
    expect(r.installed).toBe(true);
    expect(r.path).toBe(join(shared, NAME));

    // shared real file: full projection
    const sharedFile = readFileSync(join(shared, NAME), "utf8");
    expect(sharedFile).toContain(`name: ${REVIEWER_AGENT_NAME}`);
    expect(sharedFile).toContain("Verdict: PASS");
    expect(canonicalVersion(sharedFile)).toBe(canonicalVersion(canonicalBody()));

    // mode symlinks → shared (agent-builder convention)
    for (const dir of [work, personal]) {
      const link = join(dir, NAME);
      expect(existsSync(link)).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe("../../shared/agents/" + NAME);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("idempotent: second install with current version skips the write", () => {
    const root = tempDir();
    const shared = join(root, "shared/agents");
    const mode = join(root, "work/agents");
    mkdirSync(shared, { recursive: true });
    mkdirSync(mode, { recursive: true });

    installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode] });
    const before = readFileSync(join(shared, NAME), "utf8");
    const r2 = installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode] });
    expect(r2.installed).toBe(false);
    expect(r2.skipped).toBe(true);
    expect(readFileSync(join(shared, NAME), "utf8")).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });

  test("version bump re-installs; force re-installs", () => {
    const root = tempDir();
    const shared = join(root, "shared/agents");
    const mode = join(root, "work/agents");
    mkdirSync(shared, { recursive: true });
    mkdirSync(mode, { recursive: true });

    installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode] });
    // an installed file stamped newer than the current canonical → skip
    const file = join(shared, NAME);
    writeFileSync(file, readFileSync(file, "utf8").replace("orchestrator-reviewer-version: 1", "orchestrator-reviewer-version: 999"));
    const r = installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode] });
    expect(r.skipped).toBe(true);

    const rf = installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode], force: true });
    expect(rf.installed).toBe(true);
    expect(canonicalVersion(readFileSync(file, "utf8"))).toBe(canonicalVersion(canonicalBody()));
    rmSync(root, { recursive: true, force: true });
  });

  test("symlinks ensured even when the body is already current", () => {
    const root = tempDir();
    const shared = join(root, "shared/agents");
    const mode = join(root, "work/agents");
    mkdirSync(shared, { recursive: true });
    // mode dir does NOT exist yet; shared already has a current file
    writeFileSync(join(shared, NAME), buildPiFile(canonicalBody()));

    const r = installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode] });
    expect(r.skipped).toBe(true); // body current
    expect(existsSync(join(mode, NAME))).toBe(true); // but symlink ensured
    rmSync(root, { recursive: true, force: true });
  });

  test("no shared dir → real file in the mode agents dir", () => {
    const root = tempDir();
    const mode = join(root, "work/agents");
    mkdirSync(mode, { recursive: true });

    const r = installPiReviewer({ sharedAgentsDir: join(root, "nope/agents"), modeAgentsDirs: [mode] });
    expect(r.installed).toBe(true);
    expect(r.path).toBe(join(mode, NAME));
    expect(existsSync(join(mode, NAME))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("piReviewerCurrent reflects an installed current file", () => {
    const root = tempDir();
    const shared = join(root, "shared/agents");
    const mode = join(root, "work/agents");
    mkdirSync(shared, { recursive: true });
    mkdirSync(mode, { recursive: true });
    // inject temp mode dirs so the live install on this machine can't mask results
    expect(piReviewerCurrent(shared, [mode])).toBe(false);
    installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode] });
    expect(piReviewerCurrent(shared, [mode])).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("worker agent (framework-owned, opencode projection)", () => {
  test("worker canonical exists with the contract + version stamp", () => {
    const body = canonicalBody("worker");
    expect(canonicalVersion(body)).toBeGreaterThanOrEqual(1);
    expect(body).toContain("git worktree add");
    expect(body).toContain("KEY:");
    expect(body).toContain("Commit early");
  });

  test("opencode worker file: name worker + FULL-tools permission (headless)", () => {
    const f = buildOpenCodeFile(canonicalBody("worker"), "worker");
    // opencode identifies agents by FILENAME (worker.md), not frontmatter name
    expect(f).toContain("description: Orchestrator framework implementation agent");
    expect(f).toContain("mode: all");
    expect(f).toContain("bash: allow");
    expect(f).toContain("edit: allow");
    expect(f).toContain("task: allow");
    expect(f).not.toContain("Verdict");
    expect(canonicalVersion(f)).toBe(canonicalVersion(canonicalBody("worker")));
  });

  test("installOpenCodeWorker writes the projection (idempotent)", () => {
    const root = tempDir();
    const agentsDir = join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const r = installOpenCodeWorker({ agentsDir });
    expect(r.installed).toBe(true);
    expect(r.path).toBe(join(agentsDir, "worker.md"));
    const file = readFileSync(join(agentsDir, "worker.md"), "utf8");
    expect(file).toContain("description: Orchestrator framework implementation agent");
    expect(file).toContain("git worktree add");
    const r2 = installOpenCodeWorker({ agentsDir });
    expect(r2.skipped).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("the pi reviewer installer is unaffected by the generalization", () => {
    const root = tempDir();
    const shared = join(root, "shared/agents");
    const mode = join(root, "work/agents");
    mkdirSync(shared, { recursive: true });
    mkdirSync(mode, { recursive: true });
    const r = installPiReviewer({ sharedAgentsDir: shared, modeAgentsDirs: [mode] });
    expect(r.installed).toBe(true);
    expect(readFileSync(join(shared, "orchestrator-reviewer.md"), "utf8")).toContain("Verdict: PASS");
    rmSync(root, { recursive: true, force: true });
  });
});
