import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { checkPathAccess, toolMatchesPattern, parseIbCommand, checkIbCommandAccess, claudeProjectDirFor, hookCheckPath, META_WRITE_DENY_REASON, META_UNREADABLE_DENY_REASON, agentProtectedWritePaths, systemProtectedWritePaths, protectedConfigWriteDenyReason, matchProtectedWrite } from "./agent-path";
import type { PathCheckInput, PathCheckContext } from "./agent-path";
import { join } from "path";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "fs/promises";
import { tmpdir } from "os";
import { setUserHome, resetUserHome } from "../home";
import { parseDenials } from "../agents";
import { canonicalizeSandboxPath, prepareAccessTable, resolvePreparedAccess, type PathsConfig, type PreparedAccessTable } from "../sandbox";
import { agentPathAccessTable, claudeScratchpadDirFor } from "./paths-table";

const UID = process.getuid?.() ?? 0;

/**
 * Build a prepared access table for a given agent layout. Empty paths lists by
 * default (strict: only the worktree + runtime roots pass). This is the shared
 * table both the hook and the kernel resolve against.
 */
function buildAccessFor(opts: {
  paths?: Partial<PathsConfig>;
  agentDir: string;
  worktreePath: string;
  agentsDir: string;
  rootRepo: string;
  canSpawnChildren?: boolean;
}): PreparedAccessTable {
  return prepareAccessTable(
    agentPathAccessTable({
      paths: { allowRead: [], allowWrite: [], deny: [], ...(opts.paths ?? {}) },
      agentDir: opts.agentDir,
      worktreePath: opts.worktreePath,
      agentsDir: opts.agentsDir,
      rootRepo: opts.rootRepo,
      gitDir: join(opts.rootRepo, ".git"),
      tmuxSock: "/private/tmp/tmux-501",
      canSpawnChildren: opts.canSpawnChildren ?? false,
    }),
  );
}

/** The access table for the default `/repo` fixture agent. */
function makeAccess(paths: Partial<PathsConfig> = {}, opts: { canSpawnChildren?: boolean } = {}): PreparedAccessTable {
  return buildAccessFor({
    paths,
    agentDir: "/repo/.ittybitty/agents/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    agentsDir: "/repo/.ittybitty/agents",
    rootRepo: "/repo",
    canSpawnChildren: opts.canSpawnChildren,
  });
}

/** Build a default context for testing */
function makeCtx(overrides: Partial<PathCheckContext> = {}): PathCheckContext {
  return {
    agentId: "agent-abc123",
    agentDir: "/repo/.ittybitty/agents/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    agentsDir: "/repo/.ittybitty/agents",
    rootRepo: "/repo",
    allowList: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    access: makeAccess(),
    protectedWritePaths: agentProtectedWritePaths("/repo/.ittybitty/agents/agent-abc123"),
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
    expect(result.reason).toContain("permitted by paths");
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

  test("block the exact main repo root even when paths.allowRead grants it", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/repo"] }) });
    const result = checkPathAccess(makeInput({
      toolName: "LS",
      toolInput: { path: "/repo" },
    }), { ...ctx, allowList: [...ctx.allowList, "LS"] });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("work in your worktree");
  });

  test("cd to the exact main repo root is structurally denied", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/repo"] }) });
    const result = checkPathAccess(makeInput({
      toolName: "Bash",
      toolInput: { command: "cd /repo" },
    }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("work in your worktree");
  });

  test("system paths (/tmp/foo) are DENIED with empty paths (no permissive mode)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/tmp/foo/bar.txt" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("allow own agent.log", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/agent.log" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
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

  test("cd empty target → resolves to home, DENIED under empty paths", () => {
    // An empty cd resolves to the home directory and is checked like any path;
    // home is not a runtime root, so a strict agent is denied (the invariant).
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cd " },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("cd with just 'cd' → resolves to home, DENIED under empty paths", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cd" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
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
    expect(result.reason).toContain("permitted by paths");
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

  test("required-path tool with no file_path or path → deny", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { pattern: "*.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("requires a path argument");
  });

  test("uses path field when file_path is absent", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Glob",
      toolInput: { path: "/repo/.ittybitty/agents/agent-abc123/repo/src", pattern: "*.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("Bash cd with quoted path", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: 'cd "/repo/.ittybitty/agents/agent-abc123/repo/src"' },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("worktree path exact match (not just prefix)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
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
    expect(result.reason).toContain("permitted by paths");
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

  test("bash exact main repo root is caught with a real token boundary", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/repo"] }) });
    for (const command of ["ls /repo", "ls '/repo'", 'ls --directory="/repo"']) {
      const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("bash command references main repo");
    }
  });

  test("bash main repo scanner preserves worktree exclusions and prefix collisions", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/repo-copy"] }) });
    expect(checkPathAccess(makeInput({
      toolName: "Bash",
      toolInput: { command: "ls /repo/.ittybitty/agents/agent-abc123/repo" },
    }), ctx).decision).toBe("allow");
    expect(checkPathAccess(makeInput({
      toolName: "Bash",
      toolInput: { command: "ls /repo-copy" },
    }), ctx).decision).toBe("allow");
  });

  // ── relative-path traversal escaping the worktree (boundary review fix 1) ───

  test("bash RELATIVE cat ../../x from the worktree is denied (escapes to agents dir)", () => {
    const ctx = makeCtx();
    // ../../x from the worktree resolves to /repo/.ittybitty/agents/x — under
    // agentsDir, outside this agent's own dir.
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat ../../x" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("other agents");
  });

  test("bash RELATIVE cat into a sibling worktree is denied", () => {
    const ctx = makeCtx();
    // ../../agent-other/repo/.env resolves to a sibling agent's worktree.
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat ../../agent-other/repo/.env" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("other agents");
  });

  test("bash RELATIVE traversal into the main checkout is denied", () => {
    const ctx = makeCtx();
    // ../../../../SPEC.md resolves up out of .ittybitty into /repo (the main checkout).
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat ../../../../SPEC.md" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("main repo");
  });

  test("git range syntax HEAD..main is NOT flagged as traversal (allowed)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git log HEAD..main" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("git double-dot range with slashes (origin/main..origin/dev) is allowed", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git log origin/main..origin/dev" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("bash ls .. (resolving to the agent's own dir) is allowed", () => {
    const ctx = makeCtx();
    // .. from the worktree lands on agentDir — the agent's own directory.
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "ls .." },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("bash relative path staying inside the worktree is allowed", () => {
    const ctx = makeCtx();
    // src/../lib normalizes back into the worktree.
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat src/../lib/util.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("bash backslash-in-.. token (cat ..\\/..\\/x) is denied as shell-noise", () => {
    const ctx = makeCtx();
    // A `..` token containing a backslash can't be resolved safely, so it is
    // denied outright rather than emulated.
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat ..\\/..\\/x" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("shell expansion or quoting");
  });

  // ── glued-prefix traversal (boundary review round 3) ──────────────────────

  test("git --output=../../sibling/file (glued flag prefix) is denied", () => {
    const ctx = makeCtx();
    // path.resolve would treat `--output=..` as a directory name and normalize
    // back into the worktree; the suffix-from-first-`..` form catches the escape.
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git diff --output=../../agent-other/repo/file HEAD" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("other agents");
  });

  test("${IFS}-glued traversal (cat ${IFS}../../sibling/.env) is denied as shell-noise", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat ${IFS}../../agent-other/repo/.env" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("shell expansion or quoting");
  });

  test("~-leading traversal (cat ~/../../sibling/.env) is denied as shell-noise", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat ~/../../agent-other/repo/.env" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("shell expansion or quoting");
  });

  test("glued flag with a non-escaping value (--output=./x) is allowed", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git diff --output=./out.txt HEAD" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("glued flag whose value normalizes back into the worktree (--flag=src/../lib) is allowed", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "git diff --flag=src/../lib HEAD" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  // ── glued-SUFFIX shell noise after a `..` (boundary review round 4) ────────

  test.each([
    ["empty single quotes", "cat ../..''/agent-other/repo/.env"],
    ["empty double quotes", 'cat ../..""/agent-other/repo/.env'],
    ["parameter default", "cat ${FOO:-../..}/agent-other/repo/.env"],
    ["brace expansion", "cat ../..{,}/agent-other/repo/.env"],
  ])("a `..` token with %s is denied as shell-noise", (_label, command) => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("shell expansion or quoting");
  });

  test("printf '..\\n' is denied (documented over-deny — a quoted `..` with a backslash)", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "printf '..\\n'" } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("shell expansion or quoting");
  });

  test("a `..` token with glob chars is denied (cat ../../../../../itsyb*/SPEC.md)", () => {
    // The glob matches the repo dir name at runtime but resolves to a literal,
    // non-escaping segment here — so glob chars are treated as noise.
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "cat ../../../../../itsyb*/SPEC.md" } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("shell expansion or quoting");
  });

  test.each([
    ["cat ../foo?"],
    ["cat ../../[abc]/x"],
  ])("a `..` token with other glob chars (%s) is denied", (command) => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("shell expansion or quoting");
  });

  test("git ranges with ~ / ^ mid-token are NOT noise (allowed)", () => {
    const ctx = makeCtx();
    expect(checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "git log HEAD~2..HEAD^" } }), ctx).decision).toBe("allow");
    expect(checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "git log origin/main..origin/dev" } }), ctx).decision).toBe("allow");
  });

  test("heredoc BODY lines containing `..` and apostrophes are data (allowed)", () => {
    const ctx = makeCtx();
    // The body line `see ../docs, it's fine` legitimately contains `..` and an
    // apostrophe; masking heredoc bodies keeps it from tripping the scanner.
    const command = "git commit -F - <<'EOF'\nsee ../docs, it's fine\nEOF";
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("allow");
  });

  test("arithmetic `<<` does not mask the following line from the traversal scanner", () => {
    const ctx = makeCtx();
    // `((1<< y ))` is a shift, not a heredoc — the `cat ../../agent-other` line
    // after it must still be scanned and denied.
    const command = "((1<< y ))\ncat ../../agent-other/repo/.env\ny";
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("other agents");
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
    // `-C` is only a git directory-changing flag; on `ls` it is a column flag
    // and must pass checkGitDirectoryFlags. The /tmp argument is granted here so
    // the advisory path scanner (which now resolves absolute Bash args) does not
    // mask what this test is really checking.
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/tmp"] }) });
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

// ── advisory Bash path scanner ───────────────────────────────────────────────

describe("checkPathAccess — advisory Bash path scanner", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "bash-path-scanner-home-"));
    setUserHome(home);
  });

  afterEach(async () => {
    resetUserHome();
    await rm(home, { recursive: true, force: true });
  });

  const run = (command: string, paths: Partial<PathsConfig> = {}) =>
    checkPathAccess(
      makeInput({ toolName: "Bash", toolInput: { command } }),
      makeCtx({ access: makeAccess(paths) }),
    );

  test("absolute reads are denied by empty paths and allowed by allowRead", () => {
    const denied = run("cat /etc/passwd");
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("read");
    expect(denied.reason).toContain("passwd");
    expect(run("cat /etc/passwd", { allowRead: ["/etc"] }).decision).toBe("allow");
  });

  test("home paths expand before resolving, including glob directory prefixes", () => {
    const ssh = run("cat ~/.ssh/id_rsa");
    expect(ssh.decision).toBe("deny");
    expect(ssh.reason).toContain(join(home, ".ssh", "id_rsa"));

    const deniedGlob = run("ls ~/Documents/*.md");
    expect(deniedGlob.decision).toBe("deny");
    expect(deniedGlob.reason).toContain(join(home, "Documents"));
    expect(run("ls ~/Documents/*.md", { allowRead: [join(home, "Documents")] }).decision).toBe("allow");
    expect(run("cat $HOME/Documents/x", { allowRead: [join(home, "Documents")] }).decision).toBe("allow");
    expect(run("cat ${HOME}/Documents/x", { allowRead: [join(home, "Documents")] }).decision).toBe("allow");
  });

  test("redirect targets are writes, whether separate, fd-prefixed, or glued", () => {
    expect(run("echo x > /tmp/out", { allowRead: ["/tmp"] }).decision).toBe("deny");
    expect(run("echo x > /tmp/out", { allowWrite: ["/tmp"] }).decision).toBe("allow");

    // The embedded floor grants /dev as allowWrite. With an empty table the
    // same stderr redirect is denied, proving it is classified as a write.
    expect(run("cat missing 2>/dev/null").decision).toBe("deny");
    expect(run("cat missing 2>/dev/null", { allowWrite: ["/dev"] }).decision).toBe("allow");
    expect(run("echo x 1>|/tmp/out", { allowWrite: ["/tmp"] }).decision).toBe("allow");

    expect(run('echo x >"/tmp/out"', { allowRead: ["/tmp"] }).decision).toBe("deny");
    expect(run('echo x >"/tmp/out"', { allowWrite: ["/tmp"] }).decision).toBe("allow");
    expect(run('cat missing 2>"/dev/null"').decision).toBe("deny");
    expect(run('cat missing 2>"/dev/null"', { allowWrite: ["/dev"] }).decision).toBe("allow");
  });

  test("cp and mv classify only their last argument as a write", () => {
    expect(run("cp a /Users/me/x", { allowRead: ["/Users/me"] }).decision).toBe("deny");
    expect(run("cp a /Users/me/x", { allowWrite: ["/Users/me"] }).decision).toBe("allow");
    expect(run("mv a /Users/me/x", { allowRead: ["/Users/me"] }).decision).toBe("deny");
  });

  test.each(["cp", "mv"])("%s destination remains a write when followed by a redirect", (verb) => {
    const command = `${verb} src /read-only/dest > /allowed/log`;
    const denied = run(command, {
      allowRead: ["/read-only"],
      allowWrite: ["/allowed"],
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("write");
    expect(denied.reason).toContain("/read-only/dest");

    expect(run(command, { allowWrite: ["/read-only", "/allowed"] }).decision).toBe("allow");
  });

  test("tee and sed in-place path arguments are writes", () => {
    expect(run("tee ~/notes.txt", { allowRead: [home] }).decision).toBe("deny");
    expect(run("tee ~/notes.txt", { allowWrite: [home] }).decision).toBe("allow");
    expect(run("sed -i s/x/y/ ~/notes.txt", { allowRead: [home] }).decision).toBe("deny");
    expect(run("sed --in-place=.bak s/x/y/ ~/notes.txt", { allowWrite: [home] }).decision).toBe("allow");
  });

  test.each(["mkdir", "touch", "rm", "rmdir", "chmod 600"])(
    "%s path arguments are writes",
    (verb) => {
      const command = `${verb} ${home}/target`;
      expect(run(command, { allowRead: [home] }).decision).toBe("deny");
      expect(run(command, { allowWrite: [home] }).decision).toBe("allow");
    },
  );

  test("long and one-character short flag path suffixes are scanned", () => {
    expect(run("tool --output=/etc/passwd").decision).toBe("deny");
    expect(run("tool -I/etc").decision).toBe("deny");
    expect(run("tool -abc/etc").decision).toBe("allow");
  });

  test.each([
    "git log HEAD..main",
    "git diff origin/main...HEAD",
    "curl https://example.com/x",
  ])("non-path token %s is ignored", (command) => {
    expect(run(command).decision).toBe("allow");
  });

  test("quoted command-line prose with a path fails closed, while a quoted heredoc body is ignored", () => {
    const noisy = run('ib send other "see /etc/passwd"', { allowRead: ["/etc"] });
    expect(noisy.decision).toBe("deny");
    expect(noisy.reason).toContain("/etc/passwd");
    expect(noisy.reason).toContain("quoted-delimiter heredoc");

    const heredoc = "ib send other <<'EOF'\nsee /etc/passwd\nEOF";
    expect(run(heredoc).decision).toBe("allow");
  });

  test("runtime roots pass: the worktree and Claude scratchpad", () => {
    const ctx = makeCtx();
    const worktreeFile = `${ctx.worktreePath}/src/index.ts`;
    const scratchpad = `${claudeScratchpadDirFor(ctx.worktreePath, UID)}/note.txt`;
    expect(run(`cat ${worktreeFile}`).decision).toBe("allow");
    expect(run(`touch ${scratchpad}`).decision).toBe("allow");
  });

  test("structural traversal and absolute needles fire before the advisory resolver", () => {
    const traversal = run("cat ../../agent-other/repo/.env");
    expect(traversal.reason).toContain("other agents");
    expect(traversal.reason).not.toContain("paths.allowRead/allowWrite");

    const sibling = run("cat /repo/.ittybitty/agents/agent-other/repo/.env");
    expect(sibling.reason).toContain("other agents' directory");
    expect(sibling.reason).not.toContain("paths.allowRead/allowWrite");

    const main = run("cat /repo/src/index.ts");
    expect(main.reason).toContain("main repo");
    expect(main.reason).not.toContain("paths.allowRead/allowWrite");
  });

  test("canonical Bash aliases cannot enter main or sibling roots through an allow entry", async () => {
    const rootRepo = canonicalizeSandboxPath(join(home, "main"));
    const agentsDir = join(rootRepo, ".ittybitty", "agents");
    const agentDir = join(agentsDir, "agent-abc123");
    const worktreePath = join(agentDir, "repo");
    const sibling = join(agentsDir, "agent-other", "repo");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const aliases = [
      { path: join(home, "main-alias"), target: rootRepo, expected: "deny" },
      { path: join(home, "sibling-alias"), target: sibling, expected: "deny" },
      { path: join(home, "own-alias"), target: worktreePath, expected: "allow" },
    ] as const;
    for (const alias of aliases) await symlink(alias.target, alias.path);
    const layout = { agentDir, worktreePath, agentsDir, rootRepo };
    const access = buildAccessFor({ ...layout, paths: { allowWrite: aliases.map((alias) => alias.path) } });
    const ctx = makeCtx({ ...layout, access });
    for (const alias of aliases) {
      // The table itself permits these authored grants. Structural checks must
      // still reject main/sibling aliases for reads and nonexistent write leaves.
      expect(resolvePreparedAccess(access, alias.target, "write")).toBe("allow");
      for (const command of [`ls ${alias.path}`, `touch ${alias.path}/new.txt`]) {
        const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command }, cwd: worktreePath }), ctx);
        expect(result.decision).toBe(alias.expected);
        if (alias.expected === "deny") expect(result.reason).not.toContain("paths.allowRead/allowWrite");
      }
    }
  });
});

// ── settings*.json write protection ─────────────────────────────────────────

describe("checkPathAccess — .claude/settings*.json write protection", () => {
  // Use a worktree path that exists on disk so realpathSync() doesn't munge
  // our test values. /tmp is a safe root because path-resolution under it is
  // a no-op on macOS/Linux for these test paths (they don't exist; realpath
  // falls back to the resolve() result).
  test("Edit on .claude/settings.local.json → DENIED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Edit",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Write on .claude/settings.json → DENIED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Write",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Write on .claude/settings.foo.json → DENIED (matches settings*.json)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Write",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.foo.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("NotebookEdit on .claude/settings.local.json → DENIED", () => {
    const ctx = makeCtx({ allowList: ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Bash"] });
    const input = makeInput({
      toolName: "NotebookEdit",
      toolInput: { notebook_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("MultiEdit on .claude/settings.local.json → DENIED (boundary review fix 3)", () => {
    // MultiEdit was missing from WRITE_TOOLS, so an agent could self-escalate by
    // rewriting its own settings.local.json (which loadAgyEffectivePermissions
    // reads). Now gated like Write/Edit/NotebookEdit.
    const ctx = makeCtx({ allowList: ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash"] });
    const input = makeInput({
      toolName: "MultiEdit",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Write on .claude/other.json → ALLOWED (not a settings*.json)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Write",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/other.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("Write on .claude/sub/settings.local.json → ALLOWED (not directly in .claude/)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Write",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/sub/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("Read on .claude/settings.local.json → ALLOWED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("Glob on .claude/settings.local.json → ALLOWED (read-style tool)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Glob",
      toolInput: { path: "/repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  // ── Bash redirection / sed -i ────────────────────────────────────────────
  test("Bash: echo {} > .claude/settings.local.json → DENIED (relative)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "echo {} > .claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: echo {} >> .claude/settings.json → DENIED (append, relative)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "echo {} >> .claude/settings.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: cat foo > .claude/settings.local.json → DENIED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat foo > .claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: jq ... > .claude/settings.local.json → DENIED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "jq '.permissions' some.json > .claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: sed -i ... .claude/settings.local.json → DENIED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "sed -i 's/x/y/' .claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: sed -i'.bak' ... .claude/settings.local.json → DENIED (BSD sed)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "sed -i'.bak' 's/x/y/' .claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: cat .claude/settings.local.json → ALLOWED (read-only)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat .claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("Bash: jq . .claude/settings.local.json → ALLOWED (no redirection)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "jq . .claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("Bash: grep foo .claude/settings.json → ALLOWED (read-only)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "grep foo .claude/settings.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  // ── Absolute path variants ──────────────────────────────────────────────
  test("Bash: > <worktree>/.claude/settings.local.json (absolute) → DENIED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "echo {} > /repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: sed -i ... <worktree>/.claude/settings.json (absolute) → DENIED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "sed -i 's/x/y/' /repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot modify their own .claude/settings");
  });

  test("Bash: cat <worktree>/.claude/settings.local.json (absolute, read-only) → ALLOWED", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cat /repo/.ittybitty/agents/agent-abc123/repo/.claude/settings.local.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  // ── Edge cases ──────────────────────────────────────────────────────────
  test("Bash: redirect to .claude/other.json → ALLOWED (not settings*.json)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "echo {} > .claude/other.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("Bash: redirect to .claude/sub/settings.json → ALLOWED (not directly in .claude/)", () => {
    const ctx = makeCtx();
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "echo {} > .claude/sub/settings.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });
});

// ── agy boundary-file write protection (boundary review fix B) ───────────────

describe("checkPathAccess — .agents/ boundary-file write protection", () => {
  const HOOKS = "/repo/.ittybitty/agents/agent-abc123/repo/.agents/hooks.json";
  const RULES = "/repo/.ittybitty/agents/agent-abc123/repo/.agents/rules/ittybitty-agent.md";

  test("Write on .agents/hooks.json → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Write", toolInput: { file_path: HOOKS } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agy hook/rule files");
  });

  test("Edit on the rule file → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Edit", toolInput: { file_path: RULES } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agy hook/rule files");
  });

  test("MultiEdit on .agents/hooks.json → DENIED", () => {
    const ctx = makeCtx({ allowList: ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash"] });
    const result = checkPathAccess(makeInput({ toolName: "MultiEdit", toolInput: { file_path: HOOKS } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agy hook/rule files");
  });

  test("Bash: sed -i on .agents/hooks.json → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "sed -i 's/x/y/' .agents/hooks.json" } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agy hook/rule files");
  });

  test("Bash: sed -i on the rule file (absolute) → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: `sed -i 's/x/y/' ${RULES}` } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agy hook/rule files");
  });

  test("Bash: redirect into .agents/hooks.json → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "echo {} > .agents/hooks.json" } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agy hook/rule files");
  });

  test("Read on .agents/hooks.json → ALLOWED (reads not gated)", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Read", toolInput: { file_path: HOOKS } }), ctx);
    expect(result.decision).toBe("allow");
  });

  test("Write on an unrelated .agents/ file → ALLOWED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/.agents/notes.md" } }),
      ctx,
    );
    expect(result.decision).toBe("allow");
  });

  test("Write on an unrelated worktree file → ALLOWED (regression)", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/src/index.ts" } }),
      ctx,
    );
    expect(result.decision).toBe("allow");
  });

  // ── obfuscated bash write-target spellings (boundary review round 4 fix 2) ──

  const WT = "/repo/.ittybitty/agents/agent-abc123/repo";

  test.each([
    ["sed -i on .agents/rules/../hooks.json (relative, dotdot)", `sed -i 's/x/y/' .agents/rules/../hooks.json`, "agy hook/rule files"],
    ["sed -i on ./.agents/hooks.json (leading ./)", `sed -i 's/x/y/' ./.agents/hooks.json`, "agy hook/rule files"],
    ["sed -i on the absolute dotdot spelling", `sed -i 's/x/y/' ${WT}/.agents/rules/../hooks.json`, "agy hook/rule files"],
    ["sed -i on ./.claude/settings.local.json", `sed -i 's/x/y/' ./.claude/settings.local.json`, "cannot modify their own .claude/settings"],
    ["sed -i on .claude/x/../settings.local.json", `sed -i 's/x/y/' .claude/x/../settings.local.json`, "cannot modify their own .claude/settings"],
  ])("resolves obfuscated write targets: %s → deny", (_label, command, reasonPart) => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain(reasonPart);
  });

  test("redirect to the ../-obfuscated agy hooks path → deny", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "echo {} > .agents/rules/../hooks.json" } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("agy hook/rule files");
  });

  test("a same-named file in a subdirectory (sub/.agents/hooks.json) stays ALLOWED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "sed -i 's/x/y/' sub/.agents/hooks.json" } }), ctx);
    expect(result.decision).toBe("allow");
  });

  test("a same-named settings file in a subdirectory stays ALLOWED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "sed -i 's/x/y/' sub/.claude/settings.local.json" } }), ctx);
    expect(result.decision).toBe("allow");
  });

  // ── fd-prefixed redirects (boundary review round 5 fix 3) ─────────────────

  test.each([
    ["1> spaced onto the agy hooks file", "cat x 1> .agents/hooks.json", "agy hook/rule files"],
    ["1> glued onto the settings file", "cat x 1>.claude/settings.local.json", "cannot modify their own .claude/settings"],
    ["2>> glued onto the agy hooks file", "cat x 2>>.agents/hooks.json", "agy hook/rule files"],
    ["&> glued onto the settings file", "cat x &>.claude/settings.local.json", "cannot modify their own .claude/settings"],
  ])("fd/&-prefixed redirect (%s) → deny", (_label, command, reasonPart) => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain(reasonPart);
  });

  test.each([
    ["cat x 1> src/out.txt"],
    ["cat x 2>>notes.md"],
    ["cat x &>build.log"],
  ])("fd/&-prefixed redirect to an unrelated file (%s) → allow", (command) => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("allow");
  });

  // ── `>|` force-clobber redirect (boundary review round 6 fix 2) ───────────

  test.each([
    [">| glued onto the settings file", "echo x >|.claude/settings.local.json", "cannot modify their own .claude/settings"],
    [">| spaced onto the agy hooks file", "echo x >| .agents/hooks.json", "agy hook/rule files"],
    ["1>| glued onto the settings file", "echo x 1>|.claude/settings.local.json", "cannot modify their own .claude/settings"],
  ])("force-clobber redirect (%s) → deny", (_label, command, reasonPart) => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain(reasonPart);
  });

  test("force-clobber redirect to an unrelated file (>| build.log) → allow", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Bash", toolInput: { command: "echo x >| build.log" } }), ctx);
    expect(result.decision).toBe("allow");
  });
});

// ── parseIbCommand ───────────────────────────────────────────────────────────

describe("parseIbCommand", () => {
  test("parses ib retire <id>", () => {
    const result = parseIbCommand("ib retire agent-abc12345");
    expect(result).toEqual({ subcommand: "retire", targetId: "agent-abc12345" });
  });

  test("parses ib rehire <id>", () => {
    const result = parseIbCommand("ib rehire agent-abc12345");
    expect(result).toEqual({ subcommand: "rehire", targetId: "agent-abc12345" });
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
    const result = parseIbCommand("ib retire --force agent-abc12345");
    expect(result).toEqual({ subcommand: "retire", targetId: "agent-abc12345" });
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
    const result = parseIbCommand("ib retire");
    expect(result).toBeNull();
  });

  test("returns null for invalid agent id (contains special chars)", () => {
    const result = parseIbCommand("ib retire not/an/agent");
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

  async function writeRetiredMeta(id: string, meta: object): Promise<void> {
    const archiveKey = `20260703-120000-${id}`;
    const archiveDir = join(tmpDir, ".ittybitty", "archive", archiveKey);
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(join(archiveDir, "meta.json"), JSON.stringify({ id, ...meta }));
    await Bun.write(join(archiveDir, "retirement.json"), JSON.stringify({
      version: 1,
      agentId: id,
      retiredAt: "2026-07-03T12:00:00.000Z",
      repoPath: tmpDir,
      archiveKey,
      worktree: false,
      gitHead: null,
      headRef: null,
      untrackedFiles: [],
      prunedTeams: [],
    }));
  }

  test("allows rehire when calling agent is the archived target's manager", async () => {
    await writeRetiredMeta("agent-target1", { manager: "agent-manager1" });
    const result = await checkIbCommandAccess(
      "ib rehire agent-target1",
      "agent-manager1",
      agentsDir,
    );
    expect(result).toBeNull();
  });

  test("allows a manager to reach the precise CLI error for a legacy archive", async () => {
    const id = "agent-legacy1";
    await writeRetiredMeta(id, { manager: "agent-manager1" });
    await rm(
      join(
        tmpDir,
        ".ittybitty",
        "archive",
        `20260703-120000-${id}`,
        "retirement.json",
      ),
    );

    const result = await checkIbCommandAccess(
      `ib rehire ${id}`,
      "agent-manager1",
      agentsDir,
    );

    expect(result).toBeNull();
  });

  test("denies rehire when caller is not the archived target's manager", async () => {
    await writeRetiredMeta("agent-target1", { manager: "agent-manager1" });
    const result = await checkIbCommandAccess(
      "ib rehire agent-target1",
      "agent-other111",
      agentsDir,
    );
    expect(result?.decision).toBe("deny");
    expect(result?.reason).toContain("only the manager");
  });

  test("rehire is exact-id-only and denies an archived nickname target", async () => {
    setUserHome(tmpDir);
    try {
      await writeRetiredMeta("agent-target1", {
        manager: "agent-manager1",
        nickname: "old-name",
      });
      const result = await checkIbCommandAccess(
        "ib rehire old-name",
        "agent-manager1",
        agentsDir,
      );
      expect(result?.decision).toBe("deny");
    } finally {
      resetUserHome();
    }
  });

  test("allows retire when calling agent is the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib retire agent-target1", "agent-manager1", agentsDir);
    expect(result).toBeNull();
  });

  test("denies retire when calling agent is NOT the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib retire agent-target1", "agent-other111", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
    expect(result!.reason).toContain("only the manager");
  });

  test("denies retire when agent has no manager set", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1" });
    const result = await checkIbCommandAccess("ib retire agent-target1", "agent-manager1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("denies retire when target agent not found in any repo", async () => {
    const result = await checkIbCommandAccess("ib retire agent-target1", "agent-manager1", agentsDir);
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

  test("denies cross-repo retire: target in different repo not found in agentsDir", async () => {
    // Target only exists in a different agentsDir, not the caller's
    const result = await checkIbCommandAccess("ib retire agent-target1", "agent-manager1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("denies resume when not the manager", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib resume agent-target1", "agent-sibling1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  // ── Per-repo coordinator bypass (SPEC §12.2) ──────────────────────────────

  test("per-repo coordinator CAN retire a non-child regular agent in its own repo", async () => {
    await writeAgentMeta("itsybitsy", { id: "itsybitsy", agentType: "coordinator" });
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-someone" });
    const result = await checkIbCommandAccess("ib retire agent-target1", "itsybitsy", agentsDir);
    expect(result).toBeNull();
  });

  test("per-repo coordinator CAN rehire a retired non-child in its own repo", async () => {
    await writeAgentMeta("itsybitsy", { id: "itsybitsy", agentType: "coordinator" });
    await writeRetiredMeta("agent-target1", { manager: "agent-someone" });
    const result = await checkIbCommandAccess(
      "ib rehire agent-target1",
      "itsybitsy",
      agentsDir,
    );
    expect(result).toBeNull();
  });

  test("per-repo coordinator CAN reassign a non-child regular agent in its own repo", async () => {
    await writeAgentMeta("itsybitsy", { id: "itsybitsy", agentType: "coordinator" });
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-someone" });
    const result = await checkIbCommandAccess("ib reassign agent-target1 agent-newmgr1", "itsybitsy", agentsDir);
    expect(result).toBeNull();
  });

  test("per-repo coordinator CANNOT nuke a non-child regular agent (not in expanded list)", async () => {
    await writeAgentMeta("itsybitsy", { id: "itsybitsy", agentType: "coordinator" });
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-someone" });
    const result = await checkIbCommandAccess("ib nuke agent-target1", "itsybitsy", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("per-repo coordinator CANNOT merge a non-child regular agent", async () => {
    await writeAgentMeta("itsybitsy", { id: "itsybitsy", agentType: "coordinator" });
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-someone" });
    const result = await checkIbCommandAccess("ib merge agent-target1", "itsybitsy", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("per-repo coordinator CANNOT retire another coordinator", async () => {
    await writeAgentMeta("itsybitsy", { id: "itsybitsy", agentType: "coordinator" });
    await writeAgentMeta("other-repo", { id: "other-repo", agentType: "coordinator" });
    const result = await checkIbCommandAccess("ib retire other-repo", "itsybitsy", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("regular (non-coordinator) caller still cannot retire a non-child", async () => {
    // Caller has meta.json but coordinator is not true
    await writeAgentMeta("agent-caller1", { id: "agent-caller1" });
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-someone" });
    const result = await checkIbCommandAccess("ib retire agent-target1", "agent-caller1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  test("missing caller meta.json falls through to existing manager check (denies non-manager)", async () => {
    // No caller meta written — only target
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib retire agent-target1", "agent-nometa1", agentsDir);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
  });

  // ── @system bypass ─────────────────────────────────────────────────────────

  test("@system can run retire on any agent regardless of manager/spawner", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib retire agent-target1", "@system", agentsDir);
    expect(result).toBeNull();
  });

  test("@system can run merge on any agent", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib merge agent-target1 --force", "@system", agentsDir);
    expect(result).toBeNull();
  });

  test("@system can run nuke on any agent", async () => {
    await writeAgentMeta("agent-target1", { id: "agent-target1", manager: "agent-manager1" });
    const result = await checkIbCommandAccess("ib nuke agent-target1", "@system", agentsDir);
    expect(result).toBeNull();
  });

  test("@system can run retire on a target that doesn't exist (no found-in-repo check)", async () => {
    // No target meta written — @system bypass returns null before existence check
    const result = await checkIbCommandAccess("ib retire agent-target1", "@system", agentsDir);
    expect(result).toBeNull();
  });
});

// ── checkPathAccess: the paths access table ──────────────────────────────────

describe("checkPathAccess with the paths access table", () => {
  test("empty paths: a system path is DENIED (no permissive mode — the invariant)", () => {
    const ctx = makeCtx({ access: makeAccess() });
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/usr/local/bin/someapp" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("empty paths: still allows the worktree (a runtime root)", () => {
    const ctx = makeCtx({ access: makeAccess() });
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/src/index.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("allowRead entries: allows matching paths (read)", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/home/user/data", "/var/log"] }) });
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/home/user/data/file.csv" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("allowRead entries: denies non-matching paths", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/home/user/data", "/var/log"] }) });
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/home/user/config/secret.json" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("step 10 (other agents) still blocks even if the path is in allowWrite", () => {
    const ctx = makeCtx({ access: makeAccess({ allowWrite: ["/repo/.ittybitty/agents"] }) });
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/.ittybitty/agents/agent-other/repo/src/index.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("other agents");
  });

  test("step 11 (main repo) still blocks even if the path is in allowWrite", () => {
    const ctx = makeCtx({ access: makeAccess({ allowWrite: ["/repo"] }) });
    const input = makeInput({
      toolName: "Read",
      toolInput: { file_path: "/repo/src/main.ts" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("work in your worktree");
  });

  test("Bash cd into an allowRead path is allowed (cd is a read)", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/home/user/project"] }) });
    const input = makeInput({
      toolName: "Bash",
      toolInput: { command: "cd /home/user/project" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });

  test("Glob path field against an allowRead entry is allowed", () => {
    const ctx = makeCtx({ access: makeAccess({ allowRead: ["/data/files"] }) });
    const input = makeInput({
      toolName: "Glob",
      toolInput: { pattern: "*.txt", path: "/data/files" },
    });
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
  });
});

// ── Claude project dir access (own spilled tool-results / transcripts) ──────

describe("checkPathAccess with own Claude project dir", () => {
  const WORKTREE = "/Users/test/repo/.ittybitty/agents/agent-abc123/repo";
  const OWN_PROJECT_DIR = claudeProjectDirFor(WORKTREE);
  const OTHER_WORKTREE = "/Users/test/repo/.ittybitty/agents/agent-other/repo";
  const OTHER_PROJECT_DIR = claudeProjectDirFor(OTHER_WORKTREE);

  // The project dir is a WRITE runtime root in the access table (appended by
  // agentPathAccessTable), so it is allowed by the resolver with EMPTY paths.
  function makeClaudeCtx(paths: Partial<PathsConfig> = {}): PathCheckContext {
    const agentDir = "/Users/test/repo/.ittybitty/agents/agent-abc123";
    const agentsDir = "/Users/test/repo/.ittybitty/agents";
    return {
      agentId: "agent-abc123",
      agentDir,
      worktreePath: WORKTREE,
      agentsDir,
      rootRepo: "/Users/test/repo",
      allowList: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      access: buildAccessFor({ paths, agentDir, worktreePath: WORKTREE, agentsDir, rootRepo: "/Users/test/repo" }),
      protectedWritePaths: agentProtectedWritePaths(agentDir),
    };
  }

  test("allow own tool-results file", () => {
    const ctx = makeClaudeCtx();
    const input = {
      toolName: "Read",
      toolInput: { file_path: `${OWN_PROJECT_DIR}/abc-session/tool-results/Read-123.txt` },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("allow own transcript file directly under project dir", () => {
    const ctx = makeClaudeCtx();
    const input = {
      toolName: "Read",
      toolInput: { file_path: `${OWN_PROJECT_DIR}/abc-session.jsonl` },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("allow exact match on project dir path", () => {
    const ctx = makeClaudeCtx();
    const input = {
      toolName: "Read",
      toolInput: { file_path: OWN_PROJECT_DIR },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("deny sibling prefix dir with empty paths (boundary guard)", () => {
    const ctx = makeClaudeCtx();
    // A sibling dir whose encoded name is a prefix of ours plus "-extra"
    const input = {
      toolName: "Read",
      toolInput: { file_path: `${OWN_PROJECT_DIR}-extra/file.txt` },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("deny ~/.claude/projects root with empty paths", () => {
    const ctx = makeClaudeCtx();
    const projectsRoot = join(require("os").homedir(), ".claude", "projects");
    const input = {
      toolName: "Read",
      toolInput: { file_path: projectsRoot },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("deny other agent's project dir with empty paths", () => {
    const ctx = makeClaudeCtx();
    const input = {
      toolName: "Read",
      toolInput: { file_path: `${OTHER_PROJECT_DIR}/abc-session/tool-results/Read-123.txt` },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("empty paths does not block own project dir (it is a runtime root)", () => {
    const ctx = makeClaudeCtx();
    const input = {
      toolName: "Read",
      toolInput: { file_path: `${OWN_PROJECT_DIR}/abc-session/tool-results/Read-123.txt` },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("own project dir allowed even with an unrelated allowRead entry", () => {
    const ctx = makeClaudeCtx({ allowRead: ["/var/log"] });
    const input = {
      toolName: "Read",
      toolInput: { file_path: `${OWN_PROJECT_DIR}/abc-session.jsonl` },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("Bash cd into own project dir with empty paths is allowed", () => {
    const ctx = makeClaudeCtx();
    const input = {
      toolName: "Bash",
      toolInput: { command: `cd ${OWN_PROJECT_DIR}` },
      cwd: WORKTREE,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("coordinator case: worktreePath === rootRepo, own project dir allowed", () => {
    const coordRepo = "/Users/test/repo";
    const coordProjectDir = claudeProjectDirFor(coordRepo);
    const agentDir = "/Users/test/repo/.ittybitty/agents/itsybitsy";
    const agentsDir = "/Users/test/repo/.ittybitty/agents";
    const ctx: PathCheckContext = {
      agentId: "itsybitsy",
      agentDir,
      worktreePath: coordRepo,
      agentsDir,
      rootRepo: coordRepo,
      allowList: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      access: buildAccessFor({ agentDir, worktreePath: coordRepo, agentsDir, rootRepo: coordRepo }),
      protectedWritePaths: agentProtectedWritePaths(agentDir),
    };
    const input = {
      toolName: "Read",
      toolInput: { file_path: `${coordProjectDir}/session.jsonl` },
      cwd: coordRepo,
    };
    const result = checkPathAccess(input, ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });
});

// ── Phase B: own meta.json protection + resolver behaviour via the tools ─────

describe("checkPathAccess — own meta.json write protection (Phase B)", () => {
  const META = "/repo/.ittybitty/agents/agent-abc123/meta.json";

  for (const tool of ["Write", "Edit", "MultiEdit"] as const) {
    test(`${tool} on own meta.json → DENIED`, () => {
      const ctx = makeCtx({ allowList: ["Read", "Write", "Edit", "MultiEdit", "Bash"] });
      const result = checkPathAccess(makeInput({ toolName: tool, toolInput: { file_path: META } }), ctx);
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe(META_WRITE_DENY_REASON);
    });
  }

  test("a Bash redirect onto own meta.json → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(
      makeInput({ toolName: "Bash", toolInput: { command: "echo {} > /repo/.ittybitty/agents/agent-abc123/meta.json" } }),
      ctx,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(META_WRITE_DENY_REASON);
  });

  test("a sed -i in-place edit of own meta.json → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(
      makeInput({ toolName: "Bash", toolInput: { command: "sed -i 's/x/y/' /repo/.ittybitty/agents/agent-abc123/meta.json" } }),
      ctx,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(META_WRITE_DENY_REASON);
  });

  test("a redirect onto meta.json addressed relatively (../meta.json) → DENIED", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(
      makeInput({
        toolName: "Bash",
        toolInput: { command: "echo {} > ../meta.json" },
        cwd: "/repo/.ittybitty/agents/agent-abc123/repo",
      }),
      ctx,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(META_WRITE_DENY_REASON);
  });

  test("READING own meta.json is denied by step 10 (own dir), not the meta guard", () => {
    const ctx = makeCtx();
    const result = checkPathAccess(makeInput({ toolName: "Read", toolInput: { file_path: META } }), ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("cannot access other agents' files");
  });
});

describe("checkPathAccess — @system protected config writes (Phase B security)", () => {
  const ITSY = "/Users/test/.itsybitsy";
  // @system's whole ~/.itsybitsy is its worktree root, so the resolver WOULD
  // grant these writes; the protectedWritePaths guard denies them structurally.
  function systemCtx(): PathCheckContext {
    return {
      agentId: "@system",
      agentDir: ITSY,
      worktreePath: ITSY,
      agentsDir: "", // @system has no sibling-agents dir to isolate against
      rootRepo: ITSY,
      allowList: ["Read", "Write", "Edit", "MultiEdit", "Bash"],
      access: buildAccessFor({ agentDir: ITSY, worktreePath: ITSY, agentsDir: join(ITSY, "agents"), rootRepo: ITSY, canSpawnChildren: true }),
      protectedWritePaths: systemProtectedWritePaths(ITSY),
    };
  }
  const ALL_MD = join(ITSY, "agent-types", "_all.md");
  const CONFIG = join(ITSY, "config.json");

  test("the resolver alone WOULD allow the write (control): _all.md is under the worktree root", () => {
    // Prove the guard is doing the work, not the resolver: with no protected
    // list the same path resolves to allow.
    const ctx = { ...systemCtx(), protectedWritePaths: [] };
    expect(checkPathAccess(makeInput({ toolName: "Write", toolInput: { file_path: ALL_MD } }), ctx).decision).toBe("allow");
  });

  for (const tool of ["Write", "Edit"] as const) {
    test(`@system ${tool} on _all.md → DENIED`, () => {
      const result = checkPathAccess(makeInput({ toolName: tool, toolInput: { file_path: ALL_MD } }), systemCtx());
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe(protectedConfigWriteDenyReason(join(ITSY, "agent-types")));
    });
  }

  test("@system redirect onto _all.md → DENIED", () => {
    const result = checkPathAccess(
      makeInput({ toolName: "Bash", toolInput: { command: `echo x > ${ALL_MD}` }, cwd: ITSY }),
      systemCtx(),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(protectedConfigWriteDenyReason(join(ITSY, "agent-types")));
  });

  test("@system protected Bash targets expand supported home anchors before matching", () => {
    setUserHome("/Users/test");
    try {
      const commands = [
        "ib list > ~/.itsybitsy/config.json",
        'ib list >"$HOME/.itsybitsy/config.json"',
        "ib list >> '${HOME}/.itsybitsy/config.json'",
        'sed -i s/x/y/ "~/.itsybitsy/config.json"',
      ];
      for (const command of commands) {
        const result = checkPathAccess(
          makeInput({ toolName: "Bash", toolInput: { command }, cwd: ITSY }),
          systemCtx(),
        );
        expect(result.decision).toBe("deny");
        expect(result.reason).toBe(protectedConfigWriteDenyReason(CONFIG));
      }
    } finally {
      resetUserHome();
    }
  });

  test("@system Read of _all.md → ALLOWED (writes blocked, reads untouched)", () => {
    const result = checkPathAccess(makeInput({ toolName: "Read", toolInput: { file_path: ALL_MD } }), systemCtx());
    expect(result.decision).toBe("allow");
  });

  test("@system Write to config.json → DENIED (naming the file)", () => {
    const result = checkPathAccess(makeInput({ toolName: "Write", toolInput: { file_path: CONFIG } }), systemCtx());
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(protectedConfigWriteDenyReason(CONFIG));
  });

  test("a normal agent is unaffected by @system's protected list (only its own meta.json is protected)", () => {
    // The normal fixture agent has no config.json/agent-types guard; a write to a
    // path outside its worktree is governed by the resolver, not this guard.
    const ctx = makeCtx({ access: makeAccess({ allowWrite: ["/Users/test/.itsybitsy/config.json"] }) });
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: "/Users/test/.itsybitsy/config.json" } }),
      ctx,
    );
    expect(result.decision).toBe("allow"); // allowWrite grants it; no protected-write guard fires
  });

  test("@system's LEGITIMATE writes are NOT in the protected list (teams.json, agents/<id>/meta.json)", () => {
    const list = systemProtectedWritePaths(ITSY);
    expect(matchProtectedWrite(list, join(ITSY, "teams.json"))).toBeNull();
    expect(matchProtectedWrite(list, join(ITSY, "agents", "agent-xyz", "meta.json"))).toBeNull();
    // Sanity: a protected path still matches.
    expect(matchProtectedWrite(list, CONFIG)).not.toBeNull();
  });

  test("@system Write to teams.json is ALLOWED (a legitimate write, not protected)", () => {
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: join(ITSY, "teams.json") } }),
      systemCtx(),
    );
    expect(result.decision).toBe("allow");
  });

  test("@system Write under agents/<id>/ is ALLOWED (a legitimate write, not protected)", () => {
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: join(ITSY, "agents", "agent-xyz", "outbox.json") } }),
      systemCtx(),
    );
    expect(result.decision).toBe("allow");
  });

  test("the guard fires through a SYMLINKED parent dir (protected paths are canonicalized)", async () => {
    // real/.itsybitsy holds a config file; `link` is a symlink to `real`. The
    // agent addresses config.json through the symlink; checkFilePath realpath's
    // the target, so the protected entry must be canonicalized too or the match
    // is defeated. Asserting the SPECIFIC protected reason proves the guard
    // (step 6) fired rather than the resolver.
    const base = await mkdtemp(join(tmpdir(), "protected-symlink-"));
    try {
      const realItsy = join(base, "real", ".itsybitsy");
      await mkdir(realItsy, { recursive: true });
      await writeFile(join(realItsy, "config.json"), "{}");
      const linkRoot = join(base, "link");
      await symlink(join(base, "real"), linkRoot);
      const linkItsy = join(linkRoot, ".itsybitsy");
      const ctx: PathCheckContext = {
        agentId: "@system",
        agentDir: linkItsy,
        worktreePath: linkItsy,
        agentsDir: "",
        rootRepo: linkItsy,
        allowList: ["Write"],
        access: buildAccessFor({ agentDir: linkItsy, worktreePath: linkItsy, agentsDir: join(linkItsy, "agents"), rootRepo: linkItsy, canSpawnChildren: true }),
        protectedWritePaths: systemProtectedWritePaths(linkItsy),
      };
      const result = checkPathAccess(
        makeInput({ toolName: "Write", toolInput: { file_path: join(linkItsy, "config.json") } }),
        ctx,
      );
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("protected coordinator configuration");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("checkPathAccess — runtime roots and deny via the tools (Phase B)", () => {
  test("scratchpad is allowed with EMPTY paths lists", () => {
    const scratch = claudeScratchpadDirFor("/repo/.ittybitty/agents/agent-abc123/repo", UID);
    const ctx = makeCtx();
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: `${scratch}/tmp.txt` } }),
      ctx,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("permitted by paths");
  });

  test("other agents' dir is denied even when listed in allowWrite", () => {
    const ctx = makeCtx({ access: makeAccess({ allowWrite: ["/repo/.ittybitty/agents"] }) });
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: "/repo/.ittybitty/agents/agent-other/repo/x.ts" } }),
      ctx,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("other agents");
  });

  test("main repo is denied even when listed in allowWrite", () => {
    const ctx = makeCtx({ access: makeAccess({ allowWrite: ["/repo"] }) });
    const result = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: "/repo/src/main.ts" } }),
      ctx,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("work in your worktree");
  });

  test("deny **/.env denies <worktree>/.env (Read and Write) but not <worktree>/src/x", () => {
    const ctx = makeCtx({ access: makeAccess({ deny: ["**/.env"] }) });
    const env = "/repo/.ittybitty/agents/agent-abc123/repo/.env";
    const read = checkPathAccess(makeInput({ toolName: "Read", toolInput: { file_path: env } }), ctx);
    const write = checkPathAccess(makeInput({ toolName: "Write", toolInput: { file_path: env } }), ctx);
    expect(read.decision).toBe("deny");
    expect(read.reason).toContain("matches a paths.deny entry");
    expect(write.decision).toBe("deny");
    const src = checkPathAccess(
      makeInput({ toolName: "Write", toolInput: { file_path: "/repo/.ittybitty/agents/agent-abc123/repo/src/x.ts" } }),
      ctx,
    );
    expect(src.decision).toBe("allow");
  });
});

describe("checkPathAccess — Adam's §6.13 examples through Read and Write", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "adam-6-13-")); setUserHome(home); });
  afterEach(async () => { resetUserHome(); await rm(home, { recursive: true, force: true }); });

  // The paths reference the home dir, well outside the worktree/agents/repo, so
  // steps 10/11 never fire and the resolver alone decides.
  function ctxWith(paths: Partial<PathsConfig>): PathCheckContext {
    return makeCtx({ access: makeAccess(paths) });
  }
  const read = (ctx: PathCheckContext, p: string) =>
    checkPathAccess(makeInput({ toolName: "Read", toolInput: { file_path: p } }), ctx);
  const write = (ctx: PathCheckContext, p: string) =>
    checkPathAccess(makeInput({ toolName: "Write", toolInput: { file_path: p } }), ctx);

  test("allowWrite ~/Documents, allowRead ~/Documents/Important: Important is read-only", () => {
    const ctx = ctxWith({ allowWrite: ["~/Documents"], allowRead: ["~/Documents/Important"] });
    const important = join(home, "Documents", "Important", "x");
    expect(read(ctx, important).decision).toBe("allow");
    expect(write(ctx, important).decision).toBe("deny");
    const other = join(home, "Documents", "other", "x");
    expect(read(ctx, other).decision).toBe("allow");
    expect(write(ctx, other).decision).toBe("allow");
  });

  test("allowRead ~, allowWrite ~/Documents: Documents is read-write, Desktop is read-only", () => {
    const ctx = ctxWith({ allowRead: ["~"], allowWrite: ["~/Documents"] });
    const doc = join(home, "Documents", "x");
    expect(read(ctx, doc).decision).toBe("allow");
    expect(write(ctx, doc).decision).toBe("allow");
    const desk = join(home, "Desktop", "x");
    expect(read(ctx, desk).decision).toBe("allow");
    expect(write(ctx, desk).decision).toBe("deny");
  });
});

// ── hookCheckPath with @system ────────────────────────────────────────────────

describe("hookCheckPath with @system", () => {
  let tempHome: string;
  let logged: string[] = [];
  const originalLog = console.log;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "sys-coord-hook-check-"));
    setUserHome(tempHome);
    // Create the system coordinator home with an allow list permitting Bash(ib:*)
    const claudeDir = join(tempHome, ".itsybitsy", ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ib:*)"], deny: [] } }),
    );
    logged = [];
    console.log = (msg: string) => { logged.push(msg); };
  });

  afterEach(async () => {
    console.log = originalLog;
    resetUserHome();
    await rm(tempHome, { recursive: true, force: true });
  });

  test("allows ib commands when called from system coordinator home", async () => {
    const home = join(tempHome, ".itsybitsy");
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ib list" },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    expect(logged.length).toBe(1);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("denies ib redirects to protected config through tilde and HOME anchors", async () => {
    const home = join(tempHome, ".itsybitsy");
    for (const command of [
      "ib list > ~/.itsybitsy/config.json",
      "ib list > $HOME/.itsybitsy/config.json",
    ]) {
      logged = [];
      await hookCheckPath("@system", JSON.stringify({
        tool_name: "Bash",
        tool_input: { command },
        cwd: home,
      }));
      const decision = JSON.parse(logged[0]!);
      expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("protected coordinator configuration");
    }
  });

  test("denies tools not in the system coordinator's allow list", async () => {
    const home = join(tempHome, ".itsybitsy");
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    expect(logged.length).toBe(1);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("not in allow list");
  });

  test("does not crash when worktree/agentsDir do not exist", async () => {
    // Sanity check: even without a real git worktree, the @system path
    // resolution shouldn't throw.
    const home = join(tempHome, ".itsybitsy");
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ib status" },
      cwd: home,
    });
    await expect(hookCheckPath("@system", stdin)).resolves.toBeUndefined();
    expect(logged.length).toBe(1);
  });

  test("allows manager-only ib command (retire) targeting another agent", async () => {
    // Integration check: `ib retire` is a manager-only command that would normally
    // be denied for a non-manager caller. The @system bypass in
    // checkIbCommandAccess should let it through end-to-end via hookCheckPath.
    const home = join(tempHome, ".itsybitsy");
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ib retire agent-foo" },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    expect(logged.length).toBe(1);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("allows manager-only ib command (merge) targeting another agent", async () => {
    const home = join(tempHome, ".itsybitsy");
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ib merge agent-foo --force" },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("Write to agent-types/_all.md is DENIED end-to-end (protected config wired in)", async () => {
    const home = join(tempHome, ".itsybitsy");
    const typesDir = join(home, "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(join(typesDir, "_all.md"), "---\nname: _all\ndescription: shared\n---\n");
    // Allow Write in @system's own settings so the allow-list check passes and
    // the protected-write guard is what denies.
    await writeFile(
      join(home, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Write"], deny: [] } }),
    );
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(typesDir, "_all.md") },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("protected coordinator configuration");
  });

  test("READING agent-types/_all.md is ALLOWED end-to-end", async () => {
    const home = join(tempHome, ".itsybitsy");
    const typesDir = join(home, "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(join(typesDir, "_all.md"), "---\nname: _all\ndescription: shared\n---\n");
    await writeFile(
      join(home, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Read"], deny: [] } }),
    );
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: join(typesDir, "_all.md") },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("Write to teams.json is ALLOWED end-to-end (a legitimate coordinator write)", async () => {
    const home = join(tempHome, ".itsybitsy");
    await writeFile(
      join(home, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Write"], deny: [] } }),
    );
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(home, "teams.json") },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("Write under agents/<id>/ is ALLOWED end-to-end (a legitimate coordinator write)", async () => {
    const home = join(tempHome, ".itsybitsy");
    await mkdir(join(home, "agents", "agent-child"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Write"], deny: [] } }),
    );
    const stdin = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(home, "agents", "agent-child", "outbox.json") },
      cwd: home,
    });
    await hookCheckPath("@system", stdin);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
  });
});

// ── hookCheckPath state-write side effect (worktree agents) ──────────────────

describe("hookCheckPath writes state='running' to meta.json", () => {
  let tempDir: string;
  let agentDir: string;
  let worktreeCwd: string;
  const originalLog = console.log;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mark-running-side-effect-"));
    const agentId = "agent-test99";
    agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    worktreeCwd = join(agentDir, "repo");
    await mkdir(join(worktreeCwd, ".claude"), { recursive: true });
    await writeFile(
      join(worktreeCwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Read"], deny: [] } }),
    );
    console.log = () => {};
  });

  afterEach(async () => {
    console.log = originalLog;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("flips state from 'waiting' to 'running' on PreToolUse", async () => {
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ state: "waiting" }),
    );
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: join(worktreeCwd, "any.txt") },
      cwd: worktreeCwd,
    });

    await hookCheckPath("agent-test99", stdin);

    const meta = JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
  });

  test("flips state to 'running' even when the resolver DENIES the path", async () => {
    // writeAgentState runs before the path decision, so a present-meta agent
    // whose tool is denied still transitions waiting -> running.
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ state: "waiting", worker: true }),
    );
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" }, // outside the worktree → denied
      cwd: worktreeCwd,
    });

    await hookCheckPath("agent-test99", stdin);

    const meta = JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
  });
});

// ── hookCheckPath deny-by-default (Phase B invariant) ────────────────────────

describe("hookCheckPath — deny by default (missing meta, malformed stdin)", () => {
  let tempDir: string;
  let agentDir: string;
  let worktreeCwd: string;
  let logged: string[] = [];
  const originalLog = console.log;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hook-deny-default-"));
    agentDir = join(tempDir, ".ittybitty", "agents", "agent-test77");
    worktreeCwd = join(agentDir, "repo");
    await mkdir(join(worktreeCwd, ".claude"), { recursive: true });
    await writeFile(
      join(worktreeCwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Read", "Bash"], deny: [] } }),
    );
    logged = [];
    console.log = (msg: string) => { logged.push(msg); };
  });

  afterEach(async () => {
    console.log = originalLog;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("malformed stdin → DENY (was fail-open allow)", async () => {
    await hookCheckPath("agent-test77", "not json at all");
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toBe("Failed to parse stdin");
  });

  test("a non-object payload → DENY", async () => {
    await hookCheckPath("agent-test77", JSON.stringify([1, 2, 3]));
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a non-string tool_name → DENY", async () => {
    await hookCheckPath("agent-test77", JSON.stringify({ tool_name: 42, tool_input: {}, cwd: worktreeCwd }));
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("an array tool_input → DENY instead of normalizing to a pathless call", async () => {
    await hookCheckPath("agent-test77", JSON.stringify({ tool_name: "Read", tool_input: [], cwd: worktreeCwd }));
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("Invalid stdin schema");
  });

  test("a non-string cwd → DENY", async () => {
    await hookCheckPath("agent-test77", JSON.stringify({ tool_name: "Read", tool_input: {}, cwd: 42 }));
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("Invalid stdin schema");
  });

  test("invalid or missing required file paths → DENY without throwing", async () => {
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-test77", worker: true }));
    for (const toolInput of [{ file_path: 42 }, {}]) {
      logged = [];
      await expect(hookCheckPath("agent-test77", JSON.stringify({
        tool_name: "Read",
        tool_input: toolInput,
        cwd: worktreeCwd,
      }))).resolves.toBeUndefined();
      const decision = JSON.parse(logged[0]!);
      expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("path");
    }
  });

  test("valid pathless Glob and Grep calls use cwd fallback", async () => {
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-test77", worker: true }));
    await writeFile(
      join(worktreeCwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Glob", "Grep"], deny: [] } }),
    );
    for (const [tool_name, tool_input] of [
      ["Glob", { pattern: "*.ts" }],
      ["Grep", { pattern: "needle" }],
    ] as const) {
      logged = [];
      await hookCheckPath("agent-test77", JSON.stringify({ tool_name, tool_input, cwd: worktreeCwd }));
      const decision = JSON.parse(logged[0]!);
      expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
    }
  });

  test("missing meta.json → DENY with the unreadable-meta reason", async () => {
    // No meta.json is ever written for agent-test77.
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: join(worktreeCwd, "any.txt") },
      cwd: worktreeCwd,
    });
    await hookCheckPath("agent-test77", stdin);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toBe(META_UNREADABLE_DENY_REASON);
  });

  test("with meta present, a path outside the worktree → DENY (deny by default)", async () => {
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-test77", worker: true }));
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
      cwd: worktreeCwd,
    });
    await hookCheckPath("agent-test77", stdin);
    const decision = JSON.parse(logged[0]!);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("is not in paths.allowRead/allowWrite");
  });

  test("a scanner denial is logged in the format consumed by the Denials tab", async () => {
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-test77",
        worker: true,
        paths: { allowRead: [], allowWrite: [], deny: [] },
      }),
    );
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "cat /etc/passwd" },
      cwd: worktreeCwd,
    });

    await hookCheckPath("agent-test77", stdin);

    const logLines = (await readFile(join(agentDir, "agent.log"), "utf-8")).split("\n");
    const denials = parseDenials(logLines);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.line).toContain("Permission denied: Bash");
    expect(denials[0]!.line).toContain("read");
    expect(denials[0]!.line).toContain("passwd");
    expect(denials[0]!.line).toContain("paths.allowRead/allowWrite");
  });
});
