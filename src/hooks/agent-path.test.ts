import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { checkPathAccess, toolMatchesPattern, parseIbCommand, checkIbCommandAccess } from "./agent-path";
import type { PathCheckInput, PathCheckContext } from "./agent-path";
import { join } from "path";
import { mkdir, rm } from "fs/promises";

/** Build a default context for testing */
function makeCtx(overrides: Partial<PathCheckContext> = {}): PathCheckContext {
  return {
    agentId: "agent-abc123",
    agentDir: "/repo/.ittybitty/agents/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    agentsDir: "/repo/.ittybitty/agents",
    rootRepo: "/repo",
    isWorker: false,
    allowList: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    ...overrides,
  };
}

/** Shorthand to build input */
function makeInput(overrides: Partial<PathCheckInput> = {}): PathCheckInput {
  return {
    toolName: "Read",
    toolInput: {},
    cwd: "/repo/.ittybitty/agents/agent-abc123/repo",
    ...overrides,
  };
}

// ── toolMatchesPattern ───────────────────────────────────────────────────────

describe("toolMatchesPattern", () => {
  test("exact tool name match", () => {
    expect(toolMatchesPattern("Read", {}, "Read")).toBe(true);
    expect(toolMatchesPattern("Read", {}, "Write")).toBe(false);
  });

  test("Bash(prefix:*) matches command starting with prefix", () => {
    expect(
      toolMatchesPattern("Bash", { command: "ib send foo" }, "Bash(ib:*)")
    ).toBe(true);
  });

  test("Bash(prefix:*) matches exact prefix", () => {
    expect(
      toolMatchesPattern("Bash", { command: "ib" }, "Bash(ib:*)")
    ).toBe(true);
  });

  test("Bash(prefix:*) does not match different prefix", () => {
    expect(
      toolMatchesPattern("Bash", { command: "git status" }, "Bash(ib:*)")
    ).toBe(false);
  });

  test("Bash(prefix:*) only matches Bash tool", () => {
    expect(
      toolMatchesPattern("Read", { command: "ib send" }, "Bash(ib:*)")
    ).toBe(false);
  });

  test("Bash(exact command) matches exact command", () => {
    expect(
      toolMatchesPattern("Bash", { command: "git remote -v" }, "Bash(git remote -v)")
    ).toBe(true);
  });

  test("Bash(exact command) does not match different command", () => {
    expect(
      toolMatchesPattern("Bash", { command: "git remote add origin foo" }, "Bash(git remote -v)")
    ).toBe(false);
  });

  test("Bash(exact command) does not match prefix of command", () => {
    expect(
      toolMatchesPattern("Bash", { command: "git remote -v --verbose" }, "Bash(git remote -v)")
    ).toBe(false);
  });

  test("Bash(exact command) only matches Bash tool", () => {
    expect(
      toolMatchesPattern("Read", { command: "git remote -v" }, "Bash(git remote -v)")
    ).toBe(false);
  });

  test("Bash(exact command) works for simple commands", () => {
    expect(
      toolMatchesPattern("Bash", { command: "swift package resolve" }, "Bash(swift package resolve)")
    ).toBe(true);
  });
});

// ── checkPathAccess ──────────────────────────────────────────────────────────

describe("checkPathAccess", () => {
  test("allow own worktree path", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/src/index.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("path in worktree");
  });

  test("block other agent directory", () => {
    const ctx = makeCtx({
      agentsDir: "/repo/.ittybitty/agents",
    });
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-other/repo/secret.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot access other agents");
  });

  test("block main repo path", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/src/index.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("work in your worktree");
  });

  test("allow system paths (/tmp/foo)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/tmp/foo/bar.txt" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Tool in allow list");
  });

  test("allow own agent.log", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/agent.log" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("accessing own log");
  });

  test("tool not in allow list", () => {
    const ctx = makeCtx({ allowList: ["Read", "Write"] });
    const input = makeInput({ toolName: "Bash", toolInput: { command: "ls" } });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("Tool not in allow list");
  });

  test("Bash cd extraction — blocks cd to other agent", () => {
    const ctx = makeCtx({
      agentsDir: "/repo/.ittybitty/agents",
    });
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cd /repo/.ittybitty/agents/agent-other/repo" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot cd into other agents");
  });

  test("Bash non-cd command → allow", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "ls -la" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Tool in allow list");
  });

  test("cd empty target → allow", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cd " },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Tool in allow list");
  });

  test("cd with just 'cd' → allow (non-cd path since no space)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cd" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Tool in allow list");
  });

  test("relative path resolution", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "src/foo.ts" },
      cwd: "/repo/.ittybitty/agents/agent-abc123/repo",
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("path in worktree");
  });

  test("relative path with .. that escapes worktree → block", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "../../../../src/index.ts" },
      cwd: "/repo/.ittybitty/agents/agent-abc123/repo",
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("work in your worktree");
  });

  test("no file_path or path in toolInput → allow", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { pattern: "*.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Tool in allow list");
  });

  test("uses path field when file_path is absent", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Glob",
      toolInput: { path: "/repo/.ittybitty/agents/agent-abc123/repo/src", pattern: "*.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("path in worktree");
  });

  test("Bash cd with quoted path", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: 'cd "/repo/.ittybitty/agents/agent-abc123/repo/src"' },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("path in worktree");
  });

  test("worktree path exact match (not just prefix)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("path in worktree");
  });

  test("notebook_path field is checked", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Edit",
      toolInput: { notebook_path: "/repo/.ittybitty/agents/agent-other/repo/notebook.ipynb" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot access other agents");
  });

  test("notebook_path allows own worktree", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Edit",
      toolInput: { notebook_path: "/repo/.ittybitty/agents/agent-abc123/repo/notebook.ipynb" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("path in worktree");
  });

  test("path with .. traversal is normalized and blocked", () => {
    const ctx = makeCtx();
    // Goes up from repo → agent-abc123 → agents → .ittybitty, then into agent-other
    // Resolves to /repo/.ittybitty/agent-other/repo/secret.ts which is under rootRepo
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/../../../agent-other/repo/secret.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("work in your worktree");
  });

  test("bash command referencing other agents directory is caught", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat /repo/.ittybitty/agents/agent-other/repo/secret.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bash command references other agents");
  });

  test("bash command referencing own agent directory is allowed", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat /repo/.ittybitty/agents/agent-abc123/repo/src/index.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("bash command referencing main repo is caught", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat /repo/src/index.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bash command references main repo");
  });

  // ── git -C / --git-dir / --work-tree blocking ──────────────────────────────

  test("blocks git -C (bypasses path isolation)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git -C /some/other/repo status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("-C flag is not allowed");
  });

  test("blocks git -C even with own worktree path", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git -C /repo/.ittybitty/agents/agent-abc123/repo status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("-C flag is not allowed");
  });

  test("blocks git --git-dir (bypasses path isolation)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git --git-dir /other/.git log" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("--git-dir flag is not allowed");
  });

  test("blocks git --git-dir= with equals syntax", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git --git-dir=/other/.git log" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("--git-dir flag is not allowed");
  });

  test("blocks git --work-tree (bypasses path isolation)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git --work-tree /other/repo status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("--work-tree flag is not allowed");
  });

  test("blocks git --work-tree= with equals syntax", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git --work-tree=/other/repo status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("--work-tree flag is not allowed");
  });

  test("allows normal git commands without -C", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("allows git log, commit, etc. without directory flags", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git log --oneline -10" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("non-git commands with -C are not blocked", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "ls -C /tmp" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("blocks git -C after other global flags (e.g., git --bare -C /path)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git --bare -C /other/repo status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("-C flag is not allowed");
  });

  test("blocks git --no-pager -C /path (global flag before -C)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git --no-pager -C /other/repo log" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("-C flag is not allowed");
  });

  test("blocks git -c key=val -C /path (value-consuming flag before -C)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git -c user.name=test -C /other/repo status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("-C flag is not allowed");
  });

  test("blocks git -C/path (no space after -C)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git -C/other/repo status" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("-C flag is not allowed");
  });

  test("allows git commit -C HEAD (subcommand flag, not global -C)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git commit -C HEAD" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("allows git diff -C (copy detection flag)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git diff -C" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("allows git blame -C -C (moved/copied lines detection)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git blame -C -C src/index.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("allows git log -C (copy detection in log)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git log -C --oneline" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });
});

// ── parseIbCommand ───────────────────────────────────────────────────────────

describe("parseIbCommand", () => {
  test("parses ib kill <id>", () => {
    const result = parseIbCommand("ib kill agent-abc12345");
    expect(result).toEqual({ subcommand: "kill", targetId: "agent-abc12345" });
  });

  test("parses ib merge <id> with flags", () => {
    const result = parseIbCommand("ib merge agent-abc12345 --force");
    expect(result).toEqual({ subcommand: "merge", targetId: "agent-abc12345" });
  });

  test("parses ib merge-check <id> (merge-check is unrestricted/read-only)", () => {
    const result = parseIbCommand("ib merge-check agent-abc12345");
    expect(result).toEqual({ subcommand: "merge-check", targetId: "agent-abc12345" });
  });

  test("parses ib resume <id>", () => {
    const result = parseIbCommand("ib resume agent-abc12345");
    expect(result).toEqual({ subcommand: "resume", targetId: "agent-abc12345" });
  });

  test("skips flags before agent id", () => {
    const result = parseIbCommand("ib kill --force agent-abc12345");
    expect(result).toEqual({ subcommand: "kill", targetId: "agent-abc12345" });
  });

  test("parses ib send (send is parsed but unrestricted in access check)", () => {
    const result = parseIbCommand("ib send agent-abc12345 hello");
    expect(result).toEqual({ subcommand: "send", targetId: "agent-abc12345" });
  });

  test("returns null for non-ib command", () => {
    const result = parseIbCommand("git status");
    expect(result).toBeNull();
  });

  test("returns null for ib without subcommand", () => {
    const result = parseIbCommand("ib");
    expect(result).toBeNull();
  });

  test("returns null for ib without target id", () => {
    const result = parseIbCommand("ib kill");
    expect(result).toBeNull();
  });

  test("returns null for invalid agent id (contains special chars)", () => {
    const result = parseIbCommand("ib kill not/an/agent");
    expect(result).toBeNull();
  });
});

// ── checkIbCommandAccess ─────────────────────────────────────────────────────

describe("checkIbCommandAccess", () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    tmpDir = await import("fs/promises").then((fs) => fs.mkdtemp("/tmp/ib-test-ib-access-"));
    agentsDir = join(tmpDir, ".ittybitty", "agents");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeAgentMeta(id: string, meta: object): Promise<void> {
    const agentDir = join(agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
  }

  test("allows kill when calling agent is the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib kill agent-target1", "agent-manager1", agentsDir);
    expect(result).toBeNull();
  });

  test("denies kill when calling agent is NOT the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib kill agent-target1", "agent-other111", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
    expect(result!.reason).toContain("only the manager");
  });

  test("denies kill when agent has no manager set", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1" });
    const result = await checkIbCommandAccess("ib kill agent-target1", "agent-manager1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("denies kill when target agent not found in any repo", async () => {
    const result = await checkIbCommandAccess("ib kill agent-target1", "agent-manager1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
    expect(result!.reason).toContain("not found in any registered repo");
  });

  test("allows merge when calling agent is the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib merge agent-target1 --force", "agent-manager1", agentsDir);
    expect(result).toBeNull();
  });

  test("allows nuke when calling agent is the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib nuke agent-target1", "agent-manager1", agentsDir);
    expect(result).toBeNull();
  });

  test("merge-check is unrestricted — returns null even for non-manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib merge-check agent-target1", "agent-other111", agentsDir);
    expect(result).toBeNull();
  });

  test("send is unrestricted — returns null even for non-manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib send agent-target1 hello", "agent-other111", agentsDir);
    expect(result).toBeNull();
  });

  test("look is unrestricted — returns null for non-manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib look agent-target1", "agent-other111", agentsDir);
    expect(result).toBeNull();
  });

  test("diff is unrestricted — returns null for non-manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib diff agent-target1", "agent-other111", agentsDir);
    expect(result).toBeNull();
  });

  test("non-ib command is ignored — returns null", async () => {
    const result = await checkIbCommandAccess("git status", "agent-manager1", agentsDir);
    expect(result).toBeNull();
  });

  test("denies cross-repo kill: target in different repo not found in agentsDir", async () => {
    // Target only exists in a different agentsDir, not the caller's
    const result = await checkIbCommandAccess("ib kill agent-target1", "agent-manager1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("denies resume when not the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib resume agent-target1", "agent-sibling1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });
});
