/**
 * Unit tests for src/codex-spawn.ts — the pure helpers behind the codex
 * branch of newAgent() (SPEC-CODEX-MODEL.md §6 Phase 4).
 *
 * The Phase 4 acceptance gate spans these as unit-level invariants on the
 * SHELL STRING and the generated AGENTS.md. End-to-end spawn coverage is
 * the manual gate documented in the SPEC; we explicitly DO NOT spawn a
 * real codex / tmux session from this file.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildCodexStartContent,
  appendCodexGitignoreEntry,
  stripIttybittyWrapper,
  resolveIbBinaryPath,
} from "./codex-spawn";
import { CODEX_REGISTERED_EVENTS } from "./codex-config";

describe("buildCodexStartContent — launch line", () => {
  const baseInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    codexModel: "gpt-5.4-mini",
    absPromptFile: "/tmp/test/prompt.txt",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
  });

  test("contains the canonical -m / -a / -s / --dangerously-bypass-hook-trust flags (SPEC §3.3)", () => {
    const content = buildCodexStartContent(baseInput());
    // The model is shell-quoted, so it ends up wrapped in single quotes.
    expect(content).toContain("-m 'gpt-5.4-mini'");
    expect(content).toContain("-a never");
    expect(content).toContain("-s workspace-write");
    expect(content).toContain("--dangerously-bypass-hook-trust");
  });

  test("contains one inline `-c` flag per registered hook event", () => {
    const content = buildCodexStartContent(baseInput());
    for (const event of CODEX_REGISTERED_EVENTS) {
      // The `-c` token + payload are each shell-quoted, so they appear as
      // `'-c' 'hooks.<Event>=[...]'`.
      expect(content).toContain(`'hooks.${event}=[`);
    }
  });

  test("each -c payload interpolates the agent id and absolute ib path", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain("/usr/local/bin/ib hooks codex-pre-tool-use agent-abc12345");
    expect(content).toContain("/usr/local/bin/ib hooks codex-session-start agent-abc12345");
    expect(content).toContain("/usr/local/bin/ib hooks codex-stop agent-abc12345");
  });

  test("passes the prompt via $(cat <qAbsPromptFile>) — matches claude convention", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain(`"$(cat '/tmp/test/prompt.txt')"`);
  });

  test("captures the PID into CLAUDE_PID (kept for back-compat with the watchdog)", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain("CLAUDE_PID=$!");
    // The meta.json write also uses m.claude_pid (back-compat).
    expect(content).toContain("m.claude_pid=String(process.argv[2])");
  });

  test("includes the SIGHUP-ignore trap (mirrors the claude start.sh insulation)", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain("trap '' HUP");
  });

  test("offers both setsid and bare-launch paths", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain("setsid codex -m");
    // Bare-launch arm: an unindented `codex -m` line in the else branch.
    expect(content).toMatch(/else\s*\n\s*codex -m/);
  });

  test("rejects an unsafe ib binary path (SPEC §7 risk 14)", () => {
    expect(() =>
      buildCodexStartContent({
        ...baseInput(),
        ibBinaryPath: "/Users/o'malley/bin/ib",
      }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects an invalid agent id", () => {
    expect(() =>
      buildCodexStartContent({
        ...baseInput(),
        agentId: "bad agent id with spaces",
      }),
    ).toThrow(/Invalid agent id/);
  });

  test("does NOT pass --session-id (codex generates its own rollout id)", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).not.toContain("--session-id");
  });

  test("does NOT pass --model (codex uses -m)", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).not.toContain("--model");
  });

  test("does NOT call out to `claude` — it's a codex launcher", () => {
    const content = buildCodexStartContent(baseInput());
    // Several log lines + the exit-handler reference codex; never claude.
    expect(content).not.toMatch(/setsid claude/);
    expect(content).not.toMatch(/^claude /m);
  });

  test("the start.sh log line names the codex model + agent id (not the prompt)", () => {
    const content = buildCodexStartContent(baseInput());
    // The log line names the model + sentinel — prompt content is not leaked
    // to agent.log here.
    expect(content).toContain('log "Starting codex -m gpt-5.4-mini');
    expect(content).toContain("codex agent id=agent-abc12345");
  });
});

describe("appendCodexGitignoreEntry", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-spawn-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates .gitignore with .codex/ when missing", async () => {
    const wrote = await appendCodexGitignoreEntry(tempDir);
    expect(wrote).toBe(true);
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain(".codex/");
  });

  test("appends .codex/ when .gitignore exists without it", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/\n.env\n");
    const wrote = await appendCodexGitignoreEntry(tempDir);
    expect(wrote).toBe(true);
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain("node_modules/");
    expect(text).toContain(".env");
    expect(text).toContain(".codex/");
  });

  test("is idempotent — already-present .codex/ is a no-op", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/\n.codex/\n");
    const wrote = await appendCodexGitignoreEntry(tempDir);
    expect(wrote).toBe(false);
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe("node_modules/\n.codex/\n");
  });

  test("recognizes .codex without trailing slash as the equivalent entry", async () => {
    await Bun.write(join(tempDir, ".gitignore"), ".codex\n");
    const wrote = await appendCodexGitignoreEntry(tempDir);
    expect(wrote).toBe(false);
  });

  test("appends a leading newline when existing content does not end with one", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/");
    await appendCodexGitignoreEntry(tempDir);
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe("node_modules/\n.codex/\n");
  });
});

describe("stripIttybittyWrapper", () => {
  test("removes a clean outer wrapper", () => {
    const input = "<ittybitty>\n## Hello\n\nbody text\n</ittybitty>";
    const out = stripIttybittyWrapper(input);
    expect(out.startsWith("<ittybitty>")).toBe(false);
    expect(out).toContain("## Hello");
    expect(out).toContain("body text");
  });

  test("leaves input unchanged when no wrapper present", () => {
    const input = "## No wrapper here\n\nbody text\n";
    const out = stripIttybittyWrapper(input);
    expect(out).toBe(input);
  });

  test("preserves text before AND after the wrapper (defensive)", () => {
    const input = "preface\n<ittybitty>\ninner\n</ittybitty>\npostscript";
    const out = stripIttybittyWrapper(input);
    expect(out).toContain("preface");
    expect(out).toContain("inner");
    expect(out).toContain("postscript");
  });

  test("uses lastIndexOf for the close tag — survives commentary mentioning the tag", () => {
    const input = `<ittybitty>
## Header

The agent runs inside <ittybitty>...</ittybitty>.
</ittybitty>`;
    const out = stripIttybittyWrapper(input);
    expect(out).toContain("## Header");
    // The inner mention is preserved because we drop the OUTER tags only.
    expect(out).toContain("inside <ittybitty>...");
  });
});

describe("resolveIbBinaryPath", () => {
  test("returns Bun.which result when available", () => {
    const result = resolveIbBinaryPath(() => "/usr/local/bin/ib");
    expect(result).toBe("/usr/local/bin/ib");
  });

  test("returns null when which has no match and execPath is not ib", () => {
    // process.execPath in the test runner is bun, not /ib — so the fallback
    // returns null.
    const result = resolveIbBinaryPath(() => null);
    expect(result).toBe(null);
  });
});

describe("buildCodexAgentsMd / writeCodexAgentsMd", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-agents-md-test-"));
    // Provide a fake HOME so generateInstructions() can resolve agent-types
    // without polluting the developer's real ~/.itsybitsy.
    originalHome = process.env.HOME;
    const fakeHome = join(tempDir, "home");
    await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
    process.env.HOME = fakeHome;
    await (await import("./agent-types")).ensureAgentTypesDir();
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("buildCodexAgentsMd strips the <ittybitty> wrapper", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const ctx = {
      role: "worker" as const,
      agentId: "agent-test01",
      agentManager: "agent-mgr01",
      parentBranch: "main",
      branchName: "agent/agent-test01",
      worktreePath: join(tempDir, "wt"),
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const body = await buildCodexAgentsMd(ctx);
    expect(body.startsWith("<ittybitty>")).toBe(false);
    expect(body.endsWith("</ittybitty>")).toBe(false);
    expect(body.endsWith("</ittybitty>\n")).toBe(false);
  });

  test("buildCodexAgentsMd contains the agent id (interpolated from template)", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const ctx = {
      role: "worker" as const,
      agentId: "agent-test01",
      agentManager: "agent-mgr01",
      parentBranch: "main",
      branchName: "agent/agent-test01",
      worktreePath: join(tempDir, "wt"),
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const body = await buildCodexAgentsMd(ctx);
    expect(body).toContain("agent-test01");
  });

  test("writeCodexAgentsMd writes the file inside the worktree", async () => {
    const { writeCodexAgentsMd } = await import("./codex-spawn");
    const worktree = join(tempDir, "wt");
    const ctx = {
      role: "worker" as const,
      agentId: "agent-test02",
      agentManager: "agent-mgr",
      parentBranch: "main",
      branchName: "agent/agent-test02",
      worktreePath: worktree,
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const written = await writeCodexAgentsMd(worktree, ctx);
    expect(written).toBe(join(worktree, "AGENTS.md"));
    const body = await Bun.file(written).text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("agent-test02");
  });
});
