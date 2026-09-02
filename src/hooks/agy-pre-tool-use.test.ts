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

  test("run_command cat ../other is denied when cat is not allow-listed", () => {
    const ctx = makeCtx({ allowList: ["Bash(git status:*)"] });
    const d = checkAgyPreToolUse(
      { toolName: "run_command", toolArgs: { CommandLine: "cat ../other", Cwd: ctx.worktreePath } },
      ctx,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("Tool not in allow list");
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
