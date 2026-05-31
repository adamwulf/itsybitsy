import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkCodexPreToolUse,
  captureCodexSessionId,
  hookCodexPreToolUse,
  hookCodexPreToolUseDryRun,
} from "./codex-pre-tool-use";
import type { PathCheckContext } from "./agent-path";

function makeCtx(overrides: Partial<PathCheckContext> = {}): PathCheckContext {
  return {
    agentId: "agent-abc123",
    agentDir: "/repo/.ittybitty/agents/agent-abc123",
    worktreePath: "/repo/.ittybitty/agents/agent-abc123/repo",
    agentsDir: "/repo/.ittybitty/agents",
    rootRepo: "/repo",
    allowList: ["Read", "Write", "Edit", "Bash"],
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
    // sandbox; checkCodexPreToolUse forces step 12 of checkPathAccess to fire
    // (allowedPaths = [worktreePath] when none configured) so the legacy
    // permissive fallback can't allow apply_patch escapes.
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("apply_patch target rejected");
    expect(decision.reason).toContain("/private/tmp/codex-escape.txt");
  });

  test("apply_patch: target in /private/tmp is allowed when agent.allowedPaths includes it", () => {
    const ctx = makeCtx({ allowedPaths: ["/private/tmp"] });
    const patch =
      "*** Begin Patch\n*** Add File: /private/tmp/whitelisted.txt\n+ok\n*** End Patch\n";
    const decision = checkCodexPreToolUse(
      { toolName: "apply_patch", toolInput: { command: patch }, cwd: ctx.worktreePath },
      ctx,
    );
    // If the agent's meta.json declares allowedPaths, we honor that list
    // verbatim (do NOT override it with [worktreePath]) — same contract as
    // claude-side hookCheckPath.
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
  let originalHome: string | undefined;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-hook-d-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
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
        yolo: false,
        model: "codex:gpt-5.4-mini",
        claude_pid: "",
        agentType: "worker",
      }),
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
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

  test("allow includes updatedInput echoing the original tool_input verbatim", async () => {
    const toolInput = { command: "ls /tmp", extra: "meta" };
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
  let originalHome: string | undefined;
  let agentDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "codex-hook-dryrun-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
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
    process.env.HOME = originalHome;
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
