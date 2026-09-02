import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkAgyPreToolUse,
  captureAgyConversationId,
  hookAgyPreToolUse,
  hookAgyPreToolUseDryRun,
} from "./agy-pre-tool-use";
import type { PathCheckContext } from "./agent-path";

function makeCtx(overrides: Partial<PathCheckContext> = {}): PathCheckContext {
  return {
    agentId: "agent-abc123",
    agentDir: "/repo/.ittybitty/agents/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    agentsDir: "/repo/.ittybitty/agents",
    rootRepo: "/repo",
    allowList: ["Read", "Write", "Edit", "LS", "Glob", "Grep", "Bash"],
    ...overrides,
  };
}

const SIBLING = "/repo/.ittybitty/agents/agent-other/repo";

// ── checkAgyPreToolUse — path isolation (SPEC §5) ────────────────────────────

describe("checkAgyPreToolUse — path isolation", () => {
  test("view_file of a sibling worktree is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "view_file", toolArgs: { AbsolutePath: `${SIBLING}/secret.txt` } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("other agents");
  });

  test("write_to_file under /tmp is denied (forced worktree isolation)", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "write_to_file", toolArgs: { TargetFile: "/tmp/agy-escape.txt", CodeContent: "x" } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    // With no meta.allowedPaths, allowedPaths is forced to [worktree] so step 12
    // denies /tmp rather than falling through to the legacy permissive branch.
    expect(d.reason).toContain("allowedPaths");
  });

  test("run_command referencing a sibling agent path is denied by the Bash scanner", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: `cat ${SIBLING}/secret`, Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("other agents");
  });

  test("run_command cat into a sibling worktree is a PATH-ISOLATION deny under the default allow list", () => {
    // cat IS allow-listed (bare Bash). The denial must come from path isolation,
    // not the allow list — this fails before boundary-review fix 1 and passes
    // after. ../../agent-other/repo/secret resolves to a sibling under agentsDir.
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "cat ../../agent-other/repo/secret", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("other agents");
    expect(d.reason).not.toBe("Tool not in allow list");
  });

  test("in-worktree view_file (Read) is allowed", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "view_file", toolArgs: { AbsolutePath: `${ctx.worktreePath}/src/a.ts` } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });

  test("in-worktree write_to_file (Write) is allowed", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "write_to_file", toolArgs: { TargetFile: `${ctx.worktreePath}/src/new.ts`, CodeContent: "x" } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });

  test("allow-listed run_command git status is allowed", () => {
    const ctx = makeCtx({ allowList: ["Bash(git status:*)"] });
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "git status", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });

  test("write_to_file under a type's allowedPaths is allowed", () => {
    const ctx = makeCtx({ allowedPaths: ["/private/tmp/agy-shared"] });
    const d = checkAgyPreToolUse(
      { toolName: "write_to_file", toolArgs: { TargetFile: "/private/tmp/agy-shared/out.txt", CodeContent: "x" } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });

  test("sub-agent tool is denied", () => {
    const ctx = makeCtx({ allowList: [...makeCtx().allowList, "invoke_subagent"] });
    const d = checkAgyPreToolUse(
      { toolName: "invoke_subagent", toolArgs: { Subagents: [] } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("ib new-agent");
  });

  test("unknown tool not in the allow list is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse({ toolName: "some_new_tool", toolArgs: {} }, ctx);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("not in allow list");
  });

  test("a required-path file tool with no path is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse({ toolName: "view_file", toolArgs: {} }, ctx);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("path argument missing");
  });

  test("multi_replace_file_content (MultiEdit) on .claude/settings.local.json is denied (self-escalation)", () => {
    // Boundary review fix 3: MultiEdit is now in WRITE_TOOLS, so agy's
    // multi_replace_file_content cannot rewrite the settings file that
    // loadAgyEffectivePermissions reads.
    const ctx = makeCtx({ allowList: [...makeCtx().allowList, "MultiEdit"] });
    const d = checkAgyPreToolUse(
      {
        toolName: "multi_replace_file_content",
        toolArgs: { TargetFile: `${ctx.worktreePath}/.claude/settings.local.json` },
      },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("cannot modify their own .claude/settings");
  });
});

// ── run_command Cwd is model-controlled and must be isolated (manager fix 1) ─

describe("checkAgyPreToolUse — run_command Cwd isolation", () => {
  test("Cwd = main repo is denied even with an allow-listed command", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "ls", Cwd: "/repo" } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("Cwd rejected");
  });

  test("Cwd = a main-repo subdir is denied with the main-repo reason", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "ls", Cwd: "/repo/src" } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("Cwd rejected");
    expect(d.reason).toContain("main repo");
  });

  test("Cwd = a sibling worktree is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "ls", Cwd: SIBLING } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("Cwd rejected");
    expect(d.reason).toContain("other agents");
  });

  test("Cwd = /tmp is denied (forced worktree isolation)", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "ls", Cwd: "/tmp" } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("Cwd rejected");
  });

  test("Cwd = a worktree subdir is allowed", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "ls", Cwd: `${ctx.worktreePath}/src` } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });

  test("Cwd absent falls back to the worktree and is allowed", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "ls" } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });
});

// ── run_command RELATIVE traversal escapes (boundary review fix 1) ───────────

describe("checkAgyPreToolUse — run_command relative traversal", () => {
  test("relative cat into a sibling worktree is denied even under the default allow list", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "cat ../../agent-other/repo/.env", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("other agents");
  });

  test("ls -la ../.. (listing the agents dir) is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "ls -la ../..", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
  });

  test("relative traversal into the main checkout is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "cat ../../../../SPEC.md", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("main repo");
  });

  test("relative path staying inside the worktree is allowed", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "cat src/../lib/x.ts", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });

  // Glued-prefix traversal (boundary review round 3): --flag=, ${IFS}, ~.
  test("git --output=../../sibling/file (glued flag) is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "git diff --output=../../agent-other/repo/file HEAD", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("other agents");
  });

  test("cat ${IFS}../../sibling/.env (IFS-glued) is denied as shell-noise", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "cat ${IFS}../../agent-other/repo/.env", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("shell expansion or quoting");
  });

  test("glued flag with a non-escaping value (--output=./x) is allowed", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "git diff --output=./out.txt HEAD", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });
});

// ── agy boundary files are write-protected (boundary review B) ───────────────

describe("checkAgyPreToolUse — agy boundary-file write protection", () => {
  const HOOKS_REL = ".agents/hooks.json";
  const RULES_REL = ".agents/rules/ittybitty-agent.md";

  test("write_to_file on .agents/hooks.json is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "write_to_file", toolArgs: { TargetFile: `${ctx.worktreePath}/${HOOKS_REL}`, CodeContent: "x" } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("agy hook/rule files");
  });

  test("replace_file_content on the rule file is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "replace_file_content", toolArgs: { TargetFile: `${ctx.worktreePath}/${RULES_REL}` } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("agy hook/rule files");
  });

  test("multi_replace_file_content on .agents/hooks.json is denied", () => {
    const ctx = makeCtx({ allowList: [...makeCtx().allowList, "MultiEdit"] });
    const d = checkAgyPreToolUse(
      { toolName: "multi_replace_file_content", toolArgs: { TargetFile: `${ctx.worktreePath}/${HOOKS_REL}` } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("agy hook/rule files");
  });

  test("run_command sed -i on the rule file is denied", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: `sed -i 's/x/y/' ${RULES_REL}`, Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("agy hook/rule files");
  });

  test("reads of .agents/hooks.json (view_file) are allowed", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "view_file", toolArgs: { AbsolutePath: `${ctx.worktreePath}/${HOOKS_REL}` } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });

  test("write_to_file on an unrelated worktree file is allowed (regression)", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "write_to_file", toolArgs: { TargetFile: `${ctx.worktreePath}/src/index.ts`, CodeContent: "x" } },
      ctx,
    );
    expect(d.decision).toBe("allow");
  });
});

// ── run_command single-command rule: no chaining / escaping (boundary review A) ─

describe("checkAgyPreToolUse — run_command single-command rule", () => {
  function rc(CommandLine: string, ctx = makeCtx()) {
    return checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine, Cwd: ctx.worktreePath } },
      ctx,
    );
  }

  test("chained commands (cat x; cd ..; cd ..; cat sibling) are denied as shell metacharacters", () => {
    const d = rc("cat x; cd ..; cd ..; cat agent-other/repo/.env");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("shell metacharacters");
    expect(d.reason).toContain("; command separator");
  });

  test("chained ib (ls y; ib retire other) is denied as shell metacharacters (skips parseIbCommand)", () => {
    const d = rc("ls y; ib retire agent-victim");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("shell metacharacters");
  });

  test("pipe is denied", () => {
    const d = rc("cat foo | tee /repo/x");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("| pipe");
  });

  test("backslash-in-.. token (cat ..\\/..\\/victim) is denied as shell-noise", () => {
    // A `..` token containing a backslash can't be resolved safely (the shell
    // would unescape \/ to /), so it is denied outright.
    const d = rc("cat ..\\/..\\/agent-victim/meta.json");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("shell expansion or quoting");
  });

  test("cat ..\\/..\\/x (backslash, no chaining) is denied as shell-noise", () => {
    const d = rc("cat ..\\/..\\/x");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("shell expansion or quoting");
  });

  // Glued-SUFFIX shell noise after a `..` (round 4): all pass findShellMetachar
  // but resolve in real bash to a sibling — denied outright by the noise rule.
  test.each([
    ["empty single quotes", "cat ../..''/agent-other/repo/.env"],
    ["empty double quotes", 'cat ../..""/agent-other/repo/.env'],
    ["parameter default", "cat ${FOO:-../..}/agent-other/repo/.env"],
    ["brace expansion", "cat ../..{,}/agent-other/repo/.env"],
  ])("a `..` token with %s is denied as shell-noise", (_label, command) => {
    const d = rc(command);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("shell expansion or quoting");
  });

  // Legit single commands must still allow.
  test.each([
    ["git commit -F /tmp/msg.txt"],
    ['ib send other "a ../b message"'],
    ["git log HEAD..main"],
    ["git log HEAD~2..HEAD^"],
    ["git log origin/main..origin/dev"],
    ["grep -rn foo src"],
    ["bun test src/foo.test.ts"],
    ["git commit -F - <<'EOF'\nmy commit message\nEOF"],
    ["git commit -F - <<'EOF'\nsee ../docs, it's fine\nEOF"],
  ])("allows the legit single command: %j", (command) => {
    const d = rc(command);
    expect(d.decision).toBe("allow");
  });
});

// ── deny list enforcement (manager fix 2) ────────────────────────────────────

describe("checkAgyPreToolUse — deny list wins over allow", () => {
  test("a synthesized-name deny (Write) blocks write_to_file but not view_file", () => {
    const ctx = makeCtx();
    const denied = checkAgyPreToolUse(
      { toolName: "write_to_file", toolArgs: { TargetFile: `${ctx.worktreePath}/x.ts`, CodeContent: "y" } },
      ctx,
      ["Write"],
    );
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("tool denied by agent-type deny list");

    const allowed = checkAgyPreToolUse(
      { toolName: "view_file", toolArgs: { AbsolutePath: `${ctx.worktreePath}/x.ts` } },
      ctx,
      ["Write"],
    );
    expect(allowed.decision).toBe("allow");
  });

  test("a raw agy-name deny (write_to_file) blocks it verbatim", () => {
    const ctx = makeCtx();
    const d = checkAgyPreToolUse(
      { toolName: "write_to_file", toolArgs: { TargetFile: `${ctx.worktreePath}/x.ts`, CodeContent: "y" } },
      ctx,
      ["write_to_file"],
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("tool denied by agent-type deny list");
  });

  test("a Bash(prefix) deny blocks a matching run_command even when allow-listed", () => {
    const ctx = makeCtx({ allowList: ["Bash"] });
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "rm -rf /", Cwd: ctx.worktreePath } },
      ctx,
      ["Bash(rm:*)"],
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("tool denied by agent-type deny list");
  });
});

// ── hookAgyPreToolUse — JSON contract + fail-CLOSED ──────────────────────────

describe("hookAgyPreToolUse — {decision,reason} contract", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let agentDir: string;

  beforeEach(async () => {
    // realpath so macOS /var → /private/var doesn't cause worktree-path
    // mismatches in the in-worktree allow test (checkPathAccess realpaths the
    // worktree but not the agentDirOverride).
    tempHome = await realpath(await mkdtemp(join(tmpdir(), "agy-hook-")));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    const typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(
      join(typesDir, "_all.md"),
      "---\nname: _all\ndescription: shared\npermissions:\n  allow:\n    - Bash(ls:*)\n    - Read\n    - Write\n  deny: []\n---\n",
    );
    agentDir = join(tempHome, "fake-repo", ".ittybitty", "agents", "agent-test01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-test01",
        session_id: "uuid",
        tmux_session: "ittybitty-x-agent-test01",
        prompt: "do work",
        manager: null,
        created: "2026-09-01",
        created_epoch: 1788306000,
        worktree: true,
        worker: true,
        model: "agy:gemini-3.7-flash-low",
        claude_pid: "",
        agentType: "worker",
      }),
    );
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function run(stdin: string): Promise<Record<string, unknown>> {
    let captured = "";
    await hookAgyPreToolUse("agent-test01", {
      rawStdin: stdin,
      agentDirOverride: agentDir,
      skipMetaWrites: true,
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    return JSON.parse(captured);
  }

  test("deny carries decision:deny and a non-empty reason", async () => {
    const parsed = await run(JSON.stringify({
      toolCall: { name: "run_command", args: { CommandLine: "curl https://evil", Cwd: join(agentDir, "repo") } },
    }));
    expect(parsed.decision).toBe("deny");
    expect(typeof parsed.reason).toBe("string");
    expect((parsed.reason as string).length).toBeGreaterThan(0);
  });

  test("allow carries decision:allow (allow-listed run_command)", async () => {
    const parsed = await run(JSON.stringify({
      toolCall: { name: "run_command", args: { CommandLine: "ls -la", Cwd: join(agentDir, "repo") } },
    }));
    expect(parsed.decision).toBe("allow");
  });

  test("deny logs a [PreToolUse] Permission denied line", async () => {
    await hookAgyPreToolUse("agent-test01", {
      rawStdin: JSON.stringify({
        toolCall: { name: "run_command", args: { CommandLine: "curl https://evil" } },
      }),
      agentDirOverride: agentDir,
      skipMetaWrites: true,
      write: () => true,
    });
    const log = await readFile(join(agentDir, "agent.log"), "utf-8");
    expect(log).toContain("[PreToolUse] Permission denied: run_command");
    expect(log).toContain("CommandLine=curl https://evil");
  });

  test("in-worktree write_to_file (Write) is allowed", async () => {
    const parsed = await run(JSON.stringify({
      toolCall: { name: "write_to_file", args: { TargetFile: join(agentDir, "repo", "new.ts"), CodeContent: "x" } },
    }));
    expect(parsed.decision).toBe("allow");
  });

  test("run_command 'ib retire <other>' is denied when the caller is not the manager (checkIbCommandAccess parity)", async () => {
    // Create a sibling target agent this caller does not manage.
    const agentsDir = join(agentDir, "..");
    const targetDir = join(agentsDir, "agent-target");
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      join(targetDir, "meta.json"),
      JSON.stringify({ id: "agent-target", manager: "some-other-manager", agentType: "worker" }),
    );
    const parsed = await run(JSON.stringify({
      toolCall: { name: "run_command", args: { CommandLine: "ib retire agent-target", Cwd: join(agentDir, "repo") } },
    }));
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("manager or spawner");
  });

  test("an agent-type deny (Write) is loaded and enforced end-to-end", async () => {
    // Re-declare _all so the merged deny list carries Write, then confirm the
    // full hook (which loads permissions.deny via loadAgyEffectivePermissions)
    // blocks an otherwise-allowed in-worktree write_to_file.
    await writeFile(
      join(tempHome, ".itsybitsy", "agent-types", "_all.md"),
      "---\nname: _all\ndescription: shared\npermissions:\n  allow:\n    - Read\n    - Write\n  deny:\n    - Write\n---\n",
    );
    const parsed = await run(JSON.stringify({
      toolCall: { name: "write_to_file", args: { TargetFile: join(agentDir, "repo", "new.ts"), CodeContent: "x" } },
    }));
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("tool denied by agent-type deny list");
  });

  test("fail-CLOSED: malformed stdin JSON denies", async () => {
    const parsed = await run("{not json");
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("not valid JSON");
  });

  test("fail-CLOSED: invalid agent id denies", async () => {
    let captured = "";
    await hookAgyPreToolUse("bad id with spaces", {
      rawStdin: "{}",
      skipMetaWrites: true,
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    const parsed = JSON.parse(captured);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("Invalid agent id");
  });

  test("empty stdin still emits valid JSON (never throws)", async () => {
    let captured = "";
    await hookAgyPreToolUse("agent-okzz", {
      rawStdin: "",
      skipMetaWrites: true,
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    expect(() => JSON.parse(captured)).not.toThrow();
    expect(JSON.parse(captured).decision).toBe("deny");
  });
});

// ── captureAgyConversationId ─────────────────────────────────────────────────

describe("captureAgyConversationId — idempotent capture", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-cid-"));
    agentDir = join(tempDir, "agent-dir");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-x", model: "agy:gemini-3.7-flash-low" }));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes agy_conversation_id on first call", async () => {
    expect(await captureAgyConversationId(agentDir, "conv-aaa")).toBe(true);
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.agy_conversation_id).toBe("conv-aaa");
  });

  test("is idempotent — a different id does not overwrite", async () => {
    await captureAgyConversationId(agentDir, "conv-aaa");
    expect(await captureAgyConversationId(agentDir, "conv-bbb")).toBe(false);
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.agy_conversation_id).toBe("conv-aaa");
  });

  test("no-op for an empty conversation id", async () => {
    expect(await captureAgyConversationId(agentDir, "")).toBe(false);
  });
});

// ── dry-run ──────────────────────────────────────────────────────────────────

describe("hookAgyPreToolUseDryRun", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "agy-dryrun-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    const typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(join(typesDir, "_all.md"), "---\nname: _all\ndescription: shared\npermissions:\n  allow: []\n  deny: []\n---\n");
    agentDir = join(tempHome, ".ittybitty", "agents", "agent-dryrun01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-dryrun01", worktree: true, worker: true, model: "agy:gemini-3.7-flash-low", agentType: "worker" }));
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("succeeds when meta.json exists", async () => {
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await hookAgyPreToolUseDryRun("agent-dryrun01");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when meta.json is missing", async () => {
    const origCwd = process.cwd();
    process.chdir(tempHome);
    try {
      await expect(hookAgyPreToolUseDryRun("agent-missing")).rejects.toThrow(/meta\.json not found/);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when the agent id is invalid", async () => {
    await expect(hookAgyPreToolUseDryRun("bad agent id")).rejects.toThrow(/Invalid agent id/);
  });
});
