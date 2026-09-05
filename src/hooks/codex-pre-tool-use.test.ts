import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { setUserHome, resetUserHome } from "../home";
import {
  checkCodexPreToolUse,
  captureCodexSessionId,
  hookCodexPreToolUse,
  hookCodexPreToolUseDryRun,
} from "./codex-pre-tool-use";
import type { PathCheckContext } from "./agent-path";
import { agentProtectedWritePaths } from "./agent-path";
import { prepareAccessTable, type PathsConfig, type PreparedAccessTable } from "../sandbox";
import { agentPathAccessTable } from "./paths-table";

/**
 * Build a prepared access table for the fixture agent. Empty paths lists by
 * default (strict: only the worktree + runtime roots pass); pass a partial
 * paths config to widen it.
 */
function makeAccess(
  paths: Partial<PathsConfig> = {},
  opts: { canSpawnChildren?: boolean } = {},
): PreparedAccessTable {
  return prepareAccessTable(
    agentPathAccessTable({
      paths: { allowRead: [], allowWrite: [], deny: [], ...paths },
      agentDir: "/repo/.ittybitty/agents/agent-abc123",
      worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
      agentsDir: "/repo/.ittybitty/agents",
      rootRepo: "/repo",
      gitDir: "/repo/.git",
      tmuxSock: "/private/tmp/tmux-501",
      canSpawnChildren: opts.canSpawnChildren ?? false,
    }),
  );
}

function makeCtx(overrides: Partial<PathCheckContext> = {}): PathCheckContext {
  return {
    agentId: "agent-abc123",
    agentDir: "/repo/.ittybitty/agents/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    agentsDir: "/repo/.ittybitty/agents",
    rootRepo: "/repo",
    allowList: ["Read", "Write", "Edit", "Bash"],
    access: makeAccess(),
    protectedWritePaths: agentProtectedWritePaths("/repo/.ittybitty/agents/agent-abc123"),
    ...overrides,
  };
}

// ── (c) allow/deny matches the merged lists for Bash + apply_patch ──────────

describe("checkCodexPreToolUse — allow/deny matcher applies to Bash AND apply_patch (gate (c))", () => {
  test("Bash: command in allow list is allowed", () => {
    const ctx = makeCtx({ allowList: ["Bash(ls:*)"] });
    const decision = checkCodexPreToolUse(
      { toolName: "Bash", toolInput: { command: "ls -la" }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("allow");
  });

  test("Bash: command NOT in allow list is denied", () => {
    const ctx = makeCtx({ allowList: ["Bash(ls:*)"] });
    const decision = checkCodexPreToolUse(
      { toolName: "Bash", toolInput: { command: "curl https://evil" }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("Tool not in allow list");
  });

  test("Bash: cd outside worktree is denied via path isolation", () => {
    const ctx = makeCtx({ allowList: ["Bash"] });
    const decision = checkCodexPreToolUse(
      {
        toolName: "Bash",
        toolInput: { command: "cd /repo/.ittybitty/agents/agent-other/repo" },
        cwd: ctx.worktreePath,
      },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("other agents");
  });

  test("Bash reaches the advisory scanner for ordinary absolute paths", () => {
    const ctx = makeCtx({ allowList: ["Bash"] });
    const decision = checkCodexPreToolUse(
      { toolName: "Bash", toolInput: { command: "cat /etc/passwd" }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("read");
    expect(decision.reason).toContain("passwd");
    expect(decision.reason).toContain("paths.allowRead/allowWrite");
  });

  test("quoted screenshot path is denied through the Codex hook", () => {
    const ctx = makeCtx({ allowList: ["Bash(head:*)"] });
    const path = "/Users/adamwulf/Downloads/Screenshot 2026-09-05 at 4.23.29\u202fPM.png";
    const decision = checkCodexPreToolUse(
      { toolName: "Bash", toolInput: { command: `head -c 8 '${path}'` }, cwd: ctx.worktreePath }, ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain(path);
    expect(decision.reason).toContain("paths.allowRead/allowWrite");
  });

  test("apply_patch: target inside worktree is allowed", () => {
    const ctx = makeCtx();
    const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch\n";
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: patch }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("allow");
  });

  test("apply_patch: target in another agent's worktree is denied", () => {
    const ctx = makeCtx();
    const patch =
      "*** Begin Patch\n*** Add File: /repo/.ittybitty/agents/agent-other/repo/x.ts\n+x\n*** End Patch\n";
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: patch }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("apply_patch target rejected");
    expect(decision.reason).toContain("other agents");
  });

  test("apply_patch: target in the main repo (outside worktree) is denied", () => {
    const ctx = makeCtx();
    const patch = "*** Begin Patch\n*** Update File: /repo/src/index.ts\n*** End Patch\n";
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: patch }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("work in your worktree");
  });

  test("apply_patch: target absolute /private/tmp path is DENIED (SPEC §3.2 path-isolation)", () => {
    const ctx = makeCtx();
    const patch =
      "*** Begin Patch\n*** Add File: /private/tmp/codex-escape.txt\n+I escaped\n*** End Patch\n";
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: patch }, cwd: ctx.worktreePath },
      ctx,
    );
    // SPEC §3.2: codex's `-s workspace-write` sandbox leaks /tmp, $TMPDIR, and
    // ~/.codex/memories. The hook MUST do path-isolation independently of the
    // sandbox; each apply_patch target is a synthesized Write resolved through
    // ctx.access (deny by default), so with empty paths /private/tmp is denied.
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("apply_patch target rejected");
    expect(decision.reason).toContain("/private/tmp/codex-escape.txt");
  });

  test("apply_patch: target in /private/tmp is allowed when paths.allowWrite includes it", () => {
    const ctx = makeCtx({ access: makeAccess({ allowWrite: ["/private/tmp"] }) });
    const patch =
      "*** Begin Patch\n*** Add File: /private/tmp/whitelisted.txt\n+ok\n*** End Patch\n";
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: patch }, cwd: ctx.worktreePath },
      ctx,
    );
    // If the agent's paths block declares /private/tmp as writable, the resolver
    // honors it — same shared table as the claude-side hookCheckPath.
    expect(decision.decision).toBe("allow");
  });

  test("apply_patch: rejects an empty patch body (no targets)", () => {
    const ctx = makeCtx();
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: "*** Begin Patch\n*** End Patch\n" }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("no Add/Update/Delete File directives");
  });

  test("apply_patch: denies when ANY target is unsafe (mixed)", () => {
    const ctx = makeCtx();
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/ok.ts",
      "*** Update File: /repo/src/forbidden.ts",
      "*** End Patch",
    ].join("\n");
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: patch }, cwd: ctx.worktreePath },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("/repo/src/forbidden.ts");
  });
});

// ── (d) codex JSON contract is correct ───────────────────────────────────────

describe("hookCodexPreToolUse — codex JSON contract (gate (d))", () => {
  let tempHome: string;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-hook-d-"));
    setUserHome(tempHome);
    // Populate a minimal agent-types dir so loadMergedAgentTypePermissions
    // can return a deterministic allow list.
    const typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(
      join(typesDir, "_all.md"),
      "---\nname: _all\ndescription: shared\npermissions:\n  allow:\n    - Bash(ls:*)\n  deny: []\n---\n",
    );

    // Build a fake agent directory with a meta.json.
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
        created: "2026-05-30",
        created_epoch: 1780000000,
        worktree: true,
        worker: false,
        model: "codex:gpt-5.4-mini",
        claude_pid: "",
        agentType: "worker",
      }),
    );
  });

  afterEach(async () => {
    resetUserHome();
    await rm(tempHome, { recursive: true, force: true });
  });

  async function runPayload(payload: unknown): Promise<{
    hookSpecificOutput: {
      permissionDecision: string;
      permissionDecisionReason?: string;
      updatedInput?: Record<string, unknown>;
    };
  }> {
    let captured = "";
    await hookCodexPreToolUse("agent-test01", {
      rawStdin: JSON.stringify(payload),
      agentDirOverride: agentDir,
      skipSessionIdCapture: true,
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    return JSON.parse(captured);
  }

  test("malformed nested tool_input arrays are denied instead of becoming pathless calls", async () => {
    const parsed = await runPayload({
      tool_name: "Read",
      tool_input: [],
      cwd: join(agentDir, "repo"),
    });
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Invalid stdin schema");
  });

  test("non-string cwd is denied instead of falling back to process.cwd", async () => {
    const parsed = await runPayload({
      tool_name: "Read",
      tool_input: { file_path: join(agentDir, "repo", "README.md") },
      cwd: 42,
    });
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Invalid stdin schema");
  });

  test("invalid and missing required file paths are denied", async () => {
    for (const tool_input of [{ file_path: 42 }, {}]) {
      const parsed = await runPayload({
        tool_name: "Read",
        tool_input,
        cwd: join(agentDir, "repo"),
      });
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("path");
    }
  });

  test("valid pathless Glob and Grep calls use the hook cwd", async () => {
    for (const [tool_name, tool_input] of [
      ["Glob", { pattern: "*.ts" }],
      ["Grep", { pattern: "needle" }],
    ] as const) {
      const parsed = await runPayload({
        tool_name,
        tool_input,
        cwd: join(agentDir, "repo"),
      });
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
      expect(parsed.hookSpecificOutput.updatedInput).toEqual(tool_input);
    }
  });

  test("deny includes permissionDecisionReason", async () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "curl https://evil" },
      cwd: join(agentDir, "repo"),
    });
    let captured = "";
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await hookCodexPreToolUse("agent-test01", {
        rawStdin: stdin,
        agentDirOverride: agentDir,
        skipSessionIdCapture: true,
      });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(captured);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(typeof parsed.hookSpecificOutput.permissionDecisionReason).toBe("string");
    expect(parsed.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });

  test("deny logs a PreToolUse Permission denied line for the denial panel", async () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "curl https://evil" },
      cwd: join(agentDir, "repo"),
    });
    await hookCodexPreToolUse("agent-test01", {
      rawStdin: stdin,
      agentDirOverride: agentDir,
      skipSessionIdCapture: true,
      write: () => true,
    });

    const log = await readFile(join(agentDir, "agent.log"), "utf-8");
    expect(log).toContain("[PreToolUse] Permission denied: Bash");
    expect(log).toContain("command=curl https://evil");
  });

  test("allow includes updatedInput echoing the original tool_input verbatim", async () => {
    // Any allow-listed command works; the point is verbatim updatedInput echo.
    // A worktree-relative `ls src` avoids the advisory path scanner, which now
    // resolves absolute Bash args against the (empty-floor) fixture table.
    const toolInput = { command: "ls src", extra: "meta" };
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: toolInput,
      cwd: join(agentDir, "repo"),
    });
    let captured = "";
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await hookCodexPreToolUse("agent-test01", {
        rawStdin: stdin,
        agentDirOverride: agentDir,
        skipSessionIdCapture: true,
      });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(captured);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.updatedInput).toEqual(toolInput);
  });

  test("allows the shared regular-agent default permissions for fresh codex agents", async () => {
    const toolInput = { command: "git status --short" };
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: toolInput,
      cwd: join(agentDir, "repo"),
    });
    let captured = "";
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await hookCodexPreToolUse("agent-test01", {
        rawStdin: stdin,
        agentDirOverride: agentDir,
        skipSessionIdCapture: true,
      });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(captured);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.updatedInput).toEqual(toolInput);
  });

  test("loads _all, _non_coordinator, and concrete agent-type permissions", async () => {
    const typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await writeFile(
      join(typesDir, "_all.md"),
      "---\nname: _all\ndescription: shared\npermissions:\n  allow:\n    - Bash(from-all:*)\n  deny: []\n---\n",
    );
    await writeFile(
      join(typesDir, "_non_coordinator.md"),
      "---\nname: _non_coordinator\ndescription: shared\npermissions:\n  allow:\n    - Bash(from-noncoord:*)\n  deny: []\n---\n",
    );
    await writeFile(
      join(typesDir, "worker.md"),
      "---\nname: worker\ndescription: worker\npermissions:\n  allow:\n    - Bash(from-worker:*)\n  deny: []\n---\n",
    );

    for (const command of ["from-all ok", "from-noncoord ok", "from-worker ok"]) {
      const toolInput = { command };
      const stdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: toolInput,
        cwd: join(agentDir, "repo"),
      });
      let captured = "";
      const orig = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
        return true;
      }) as typeof process.stdout.write;
      try {
        await hookCodexPreToolUse("agent-test01", {
          rawStdin: stdin,
          agentDirOverride: agentDir,
          skipSessionIdCapture: true,
        });
      } finally {
        process.stdout.write = orig;
      }
      const parsed = JSON.parse(captured);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
      expect(parsed.hookSpecificOutput.updatedInput).toEqual(toolInput);
    }
  });

  test("allows Bash grants added by ib watch to .claude/settings.local.json", async () => {
    await mkdir(join(agentDir, "repo", ".claude"), { recursive: true });
    await writeFile(
      join(agentDir, "repo", ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(ib look:*)"],
          deny: [],
        },
      }),
    );

    const toolInput = { command: "ib look codex-input-line" };
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: toolInput,
      cwd: join(agentDir, "repo"),
    });
    let captured = "";
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await hookCodexPreToolUse("agent-test01", {
        rawStdin: stdin,
        agentDirOverride: agentDir,
        skipSessionIdCapture: true,
      });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(captured);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.updatedInput).toEqual(toolInput);
  });
});

// ── (e) deny on uncaught exception (fail-OPEN mitigation) ────────────────────

describe("hookCodexPreToolUse — fail-open hardening (gate (e))", () => {
  test("emits deny on malformed stdin JSON", async () => {
    let captured = "";
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await hookCodexPreToolUse("agent-abc", {
        rawStdin: "{not json",
        skipSessionIdCapture: true,
      });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(captured);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("not valid JSON");
  });

  test("emits deny on invalid agent id (argv-validation failure)", async () => {
    let captured = "";
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await hookCodexPreToolUse("bad id with spaces", {
        rawStdin: "{}",
        skipSessionIdCapture: true,
      });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(captured);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Invalid agent id");
  });

  test("always exits 0 and emits valid JSON (smoke test against any uncaught exception)", async () => {
    // The handler must NEVER throw — codex's documented failure mode is FAIL-OPEN.
    // Even with a clearly-pathological input set, the call should resolve cleanly.
    let captured = "";
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stdout.write;
    try {
      await hookCodexPreToolUse("agent-okzz", {
        rawStdin: "",
        skipSessionIdCapture: true,
      });
    } finally {
      process.stdout.write = orig;
    }
    // Must be parseable JSON
    expect(() => JSON.parse(captured)).not.toThrow();
  });
});

// ── (f)+(g) covered in codex-session-start.test.ts ───────────────────────────
// The PreToolUse handler's defensive capture path is exercised below.

describe("captureCodexSessionId — idempotent session id capture", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-sid-"));
    agentDir = join(tempDir, "agent-dir");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: "agent-x", model: "codex:gpt-5.4-mini" }),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes codex_session_id on first call", async () => {
    const written = await captureCodexSessionId(agentDir, "session-aaa");
    expect(written).toBe(true);
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.codex_session_id).toBe("session-aaa");
  });

  test("is idempotent — second call with different id leaves the first value in place", async () => {
    await captureCodexSessionId(agentDir, "session-aaa");
    const written = await captureCodexSessionId(agentDir, "session-bbb");
    expect(written).toBe(false);
    const meta = JSON.parse(await Bun.file(join(agentDir, "meta.json")).text());
    expect(meta.codex_session_id).toBe("session-aaa");
  });

  test("does nothing when meta.json is missing (best-effort)", async () => {
    const missingDir = join(tempDir, "missing");
    const written = await captureCodexSessionId(missingDir, "session-zzz");
    expect(written).toBe(false);
  });

  test("does nothing when sessionId is empty", async () => {
    const written = await captureCodexSessionId(agentDir, "");
    expect(written).toBe(false);
  });
});

// ── HIGH 3 from Phase 4 review: dry-run must actually exercise the handler ──
describe("hookCodexPreToolUseDryRun — exercises real handler with synthetic payload", () => {
  let tempHome: string;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-hook-dryrun-"));
    setUserHome(tempHome);
    const typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(
      join(typesDir, "_all.md"),
      "---\nname: _all\ndescription: shared\npermissions:\n  allow:\n    - Bash(ls:*)\n  deny: []\n---\n",
    );
    // Use cwd resolution that resolveAgentContext expects: cwd contains
    // ".ittybitty/agents/<id>" — we use process.cwd() in the dry-run, so
    // put the agent dir under the current cwd's .ittybitty/agents/...
    // Easier: pre-resolve by chdir'ing? No — use realpath default. Place
    // the agent dir under tempHome and rely on dir-resolution.
    agentDir = join(tempHome, ".ittybitty", "agents", "agent-dryrun01");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-dryrun01",
        worktree: true,
        worker: true,
        model: "codex:gpt-5.4-mini",
        agentType: "worker",
      }),
    );
  });

  afterEach(async () => {
    resetUserHome();
    await rm(tempHome, { recursive: true, force: true });
  });

  test("succeeds when meta.json exists and the handler resolves cleanly", async () => {
    const origCwd = process.cwd();
    process.chdir(join(tempHome));
    try {
      await hookCodexPreToolUseDryRun("agent-dryrun01");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when meta.json is missing", async () => {
    const origCwd = process.cwd();
    process.chdir(join(tempHome));
    try {
      await expect(hookCodexPreToolUseDryRun("agent-missing")).rejects.toThrow(/meta\.json not found/);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("throws when agent id is invalid", async () => {
    await expect(hookCodexPreToolUseDryRun("bad agent id")).rejects.toThrow(/Invalid agent id/);
  });
});

// ── Phase B invariant: missing meta / malformed stdin → DENY ─────────────────

describe("hookCodexPreToolUse — deny by default (Phase B invariant)", () => {
  let tempHome: string;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-deny-default-"));
    setUserHome(tempHome);
    const typesDir = join(tempHome, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(
      join(typesDir, "_all.md"),
      "---\nname: _all\ndescription: shared\npermissions:\n  allow:\n    - Bash(ls:*)\n  deny: []\n---\n",
    );
    agentDir = join(tempHome, "fake-repo", ".ittybitty", "agents", "agent-nometa");
    await mkdir(join(agentDir, "repo"), { recursive: true });
    // Deliberately NO meta.json.
  });

  afterEach(async () => {
    resetUserHome();
    await rm(tempHome, { recursive: true, force: true });
  });

  async function run(stdin: string): Promise<Record<string, unknown>> {
    let captured = "";
    await hookCodexPreToolUse("agent-nometa", {
      rawStdin: stdin,
      agentDirOverride: agentDir,
      skipSessionIdCapture: true,
      write: (chunk: string) => { captured += chunk; return chunk.length; },
    });
    return JSON.parse(captured);
  }

  test("missing meta.json → deny", async () => {
    const parsed = await run(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      cwd: join(agentDir, "repo"),
    })) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("meta.json");
  });

  test("malformed stdin → deny", async () => {
    const parsed = await run("not json") as { hookSpecificOutput: { permissionDecision: string } };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
