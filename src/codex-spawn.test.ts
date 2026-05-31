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
  buildCodexResumeContent,
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
    // The meta.json write routes through `ib write-pid` (HIGH 2 fix from
    // the Phase 4 review) so the claude_pid write does not race with
    // concurrent codex SessionStart meta mutations.
    expect(content).toContain(`'/usr/local/bin/ib' write-pid 'agent-abc12345' "$CLAUDE_PID"`);
    // Must NOT use the old race-prone inline read-modify-write.
    expect(content).not.toContain("m.claude_pid=String(process.argv[2])");
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

describe("buildCodexResumeContent — launch line (SPEC §5.8 + §6 Phase 7)", () => {
  const baseInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    codexSessionId: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
  });

  test("launches `codex resume <UUID>` (subcommand form, not the --resume flag)", () => {
    const content = buildCodexResumeContent(baseInput());
    // The UUID is shell-quoted by shellQuote (no metacharacters in a UUID, so
    // single-quoting is the form bun's shellQuote produces).
    expect(content).toContain("setsid codex resume '019e7b21-cb7d-7f23-8674-11036ed141ef'");
    expect(content).toContain("codex resume '019e7b21-cb7d-7f23-8674-11036ed141ef'"); // bare-launch arm
    // MUST NOT use claude's --resume flag pattern.
    expect(content).not.toContain("--resume");
  });

  test("re-passes -a never -s workspace-write --dangerously-bypass-hook-trust on resume (Phase 7 Q2)", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("-a never");
    expect(content).toContain("-s workspace-write");
    expect(content).toContain("--dangerously-bypass-hook-trust");
  });

  test("re-passes one inline `-c` flag per registered hook event on resume (Phase 7 Q1)", () => {
    const content = buildCodexResumeContent(baseInput());
    for (const event of CODEX_REGISTERED_EVENTS) {
      expect(content).toContain(`'hooks.${event}=[`);
    }
  });

  test("each -c payload interpolates the agent id and absolute ib path", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("/usr/local/bin/ib hooks codex-pre-tool-use agent-abc12345");
    expect(content).toContain("/usr/local/bin/ib hooks codex-session-start agent-abc12345");
    expect(content).toContain("/usr/local/bin/ib hooks codex-stop agent-abc12345");
  });

  test("captures the PID into CLAUDE_PID (kept for back-compat with the watchdog)", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("CLAUDE_PID=$!");
    // PID writeback routes through `ib write-pid` (Phase 4 HIGH 2 — same as start.sh).
    expect(content).toContain(`'/usr/local/bin/ib' write-pid 'agent-abc12345' "$CLAUDE_PID"`);
  });

  test("includes the SIGHUP-ignore trap (mirrors the claude resume.sh insulation)", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("trap '' HUP");
  });

  test("offers both setsid and bare-launch paths", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("setsid codex resume");
    expect(content).toMatch(/else\s*\n\s*codex resume/);
  });

  test("includes the exit-code annotation table (matches start.sh)", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("exit=0 → clean exit");
    expect(content).toContain("exit=127 → command not found");
    expect(content).toContain("exit=129 → SIGHUP");
    expect(content).toContain("exit=143 → SIGTERM");
  });

  test("dumps codex stderr tail into agent.log on non-clean exit", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain('"$EXIT_CODE" -ne 0 && -s "$STDERR_LOG"');
    expect(content).toContain("tail -n 50");
  });

  test("does NOT pass `-m <model>` on resume — model is bound to the rollout", () => {
    const content = buildCodexResumeContent(baseInput());
    // `codex resume` re-attaches an existing session; no -m needed.
    // The shell-quoted form would be `-m '<model>'` (with quotes), so the
    // bare `-m ` (with trailing space) suffices to assert absence.
    expect(content).not.toMatch(/\bcodex resume[^\n]* -m /);
  });

  test("does NOT pass a positional prompt — resume continues an existing session", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).not.toContain("$(cat ");
  });

  test("rejects an unsafe ib binary path", () => {
    expect(() =>
      buildCodexResumeContent({
        ...baseInput(),
        ibBinaryPath: "/Users/o'malley/bin/ib",
      }),
    ).toThrow(/Unsafe ib binary path for codex resume/);
  });

  test("rejects an invalid agent id (caught via buildCodexLaunchArgs)", () => {
    expect(() =>
      buildCodexResumeContent({
        ...baseInput(),
        agentId: "bad agent id with spaces",
      }),
    ).toThrow(/Invalid agent id/);
  });

  test("the resume.sh log line names the codex agent id (not the prompt)", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("Resuming codex resume 019e7b21-cb7d-7f23-8674-11036ed141ef");
    expect(content).toContain("codex agent id=agent-abc12345");
  });

  test("does NOT call out to `claude` — it's a codex resume launcher", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).not.toMatch(/setsid claude/);
    expect(content).not.toMatch(/^claude /m);
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
    const result = await appendCodexGitignoreEntry(tempDir);
    expect(result).toBe("appended");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain(".codex/");
  });

  test("appends .codex/ when .gitignore exists without it", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/\n.env\n");
    const result = await appendCodexGitignoreEntry(tempDir);
    expect(result).toBe("appended");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain("node_modules/");
    expect(text).toContain(".env");
    expect(text).toContain(".codex/");
  });

  test("is idempotent — already-present .codex/ is a no-op", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/\n.codex/\n");
    const result = await appendCodexGitignoreEntry(tempDir);
    expect(result).toBe("already-present");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe("node_modules/\n.codex/\n");
  });

  test("recognizes .codex without trailing slash as the equivalent entry", async () => {
    await Bun.write(join(tempDir, ".gitignore"), ".codex\n");
    const result = await appendCodexGitignoreEntry(tempDir);
    expect(result).toBe("already-present");
  });

  test("appends a leading newline when existing content does not end with one", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/");
    await appendCodexGitignoreEntry(tempDir);
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe("node_modules/\n.codex/\n");
  });

  // MED 3 from Phase 4 review: respect explicit `!.codex/` negation.
  test("MED 3: respects !.codex/ negation — leaves file untouched", async () => {
    const before = "node_modules/\n!.codex/\n";
    await Bun.write(join(tempDir, ".gitignore"), before);
    const result = await appendCodexGitignoreEntry(tempDir);
    expect(result).toBe("negation-respected");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe(before);
    expect(text).not.toContain("\n.codex/\n");
  });

  test("MED 3: respects !.codex (no slash) negation — leaves file untouched", async () => {
    const before = "node_modules/\n!.codex\n";
    await Bun.write(join(tempDir, ".gitignore"), before);
    const result = await appendCodexGitignoreEntry(tempDir);
    expect(result).toBe("negation-respected");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe(before);
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

  // HIGH 4 from Phase 4 review: AGENTS.md for codex manager must not
  // reference Claude-only tools like TodoWrite.
  test("HIGH 4: codex manager AGENTS.md does not reference TodoWrite", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const ctx = {
      role: "manager" as const,
      agentId: "agent-mgr-test",
      agentManager: "",
      parentBranch: "main",
      branchName: "agent/agent-mgr-test",
      worktreePath: join(tempDir, "wt"),
      rootRepoPath: tempDir,
      agentType: "manager",
    };
    const body = await buildCodexAgentsMd(ctx);
    expect(body).not.toContain("TodoWrite");
    // Replacement phrasing should be present.
    expect(body).toContain("Track progress with measurable criteria");
  });

  test("HIGH 4: codex worker AGENTS.md does not contain Write(...) tool reference", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const ctx = {
      role: "worker" as const,
      agentId: "agent-w-test",
      agentManager: "agent-mgr",
      parentBranch: "main",
      branchName: "agent/agent-w-test",
      worktreePath: join(tempDir, "wt"),
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const body = await buildCodexAgentsMd(ctx);
    // The original _non_coordinator.md had `Write(/tmp/commit-msg.txt, ...)`
    // which references the Claude `Write` tool. After the HIGH 4 fix, this
    // exact snippet must be gone.
    expect(body).not.toContain('Write(/tmp/commit-msg.txt');
  });
});
