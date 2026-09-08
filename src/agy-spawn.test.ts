/**
 * Unit tests for src/agy-spawn.ts — the pure builders + helpers behind the agy
 * branch of newAgent() / resumeAgent() (SPEC-ANTIGRAVITY-CLI.md §4.5, Phase 2).
 *
 * These assert invariants on the generated SHELL STRING and the on-disk /
 * teardown helpers. End-to-end spawn coverage is the manual gate in the SPEC;
 * we DO NOT boot a real agy / tmux session here. Trust-file mutations always
 * run against a temp HOME so the real ~/.gemini is never touched.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { sandboxDenialExecPrefix, sandboxDenialScriptPreamble } from "./sandbox-log-launch";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildAgyStartContent,
  buildAgyResumeContent,
  writeAgyWorktreeFiles,
  refuseIfTracked,
  untrustAgyWorkspaceForTeardown,
} from "./agy-spawn";
import { agySettingsPath } from "./agy-config";
import type { SessionContext } from "./hooks/session-start";
import { setUserHome, resetUserHome } from "./home";

// Enabled-mode wrapper fixtures. Builders require the complete pair only when
// sandboxEnabled is true and ignore both when it is false.
const SANDBOX_PREAMBLE = "\n# test proxy preamble\nexport http_proxy=\"http://localhost:54321\"\n";
const SANDBOX_PREFIX = "sandbox-exec -f '/tmp/test/sandbox.sb' -D 'AGENTDIR=/tmp/test'";
const sandboxFields = () => ({
  sandboxEnabled: true,
  sandboxScriptPreamble: SANDBOX_PREAMBLE,
  sandboxExecPrefix: SANDBOX_PREFIX,
});

// ── buildAgyStartContent — launch line ───────────────────────────────────────

describe("buildAgyStartContent — launch line", () => {
  const baseInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    agyModel: "gemini-3.7-flash-low",
    absPromptFile: "/tmp/test/prompt.txt",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });

  test("starts collection before both gated agy launch arms", () => {
    const content = buildAgyStartContent({ ...baseInput(),
      sandboxScriptPreamble: sandboxDenialScriptPreamble("/tmp/test"),
      sandboxExecPrefix: sandboxDenialExecPrefix("/usr/bin/sandbox-exec -f /tmp/test/sandbox.sb") });
    expect(content.indexOf("ib sandbox-log-watch")).toBeLessThan(content.indexOf("setsid /bin/sh -c"));
    expect(content.match(/sandbox-log-gate \/usr\/bin\/sandbox-exec[^\n]* agy /g)?.length).toBe(2);
  });

  test("contains the canonical D2 flags with a shell-quoted model", () => {
    const content = buildAgyStartContent(baseInput());
    expect(content).toContain("agy --dangerously-skip-permissions --mode=accept-edits --model 'gemini-3.7-flash-low'");
  });

  test("passes the prompt via -i \"$(cat <promptfile>)\" (interactive)", () => {
    const content = buildAgyStartContent(baseInput());
    expect(content).toContain(`-i "$(cat '/tmp/test/prompt.txt')"`);
  });

  test("points --log-file at <agentDir>/agy.log (shell-quoted)", () => {
    const content = buildAgyStartContent(baseInput());
    expect(content).toContain("--log-file '/tmp/test/agy.log'");
  });

  test("captures the PID into CLAUDE_PID (kept for back-compat with the watchdog)", () => {
    const content = buildAgyStartContent(baseInput());
    expect(content).toContain("CLAUDE_PID=$!");
    // write-pid routed through the absolute ib path.
    expect(content).toContain(`'/usr/local/bin/ib' write-pid 'agent-abc12345' "$CLAUDE_PID"`);
  });

  test("includes the SIGHUP-ignore trap + setsid/bare launch arms (sandbox-wrapped)", () => {
    const content = buildAgyStartContent(baseInput());
    expect(content).toContain("trap '' HUP");
    // Both arms wrap agy under our sandbox-exec prefix (mandatory sandbox).
    expect(content).toContain(`setsid ${SANDBOX_PREFIX} agy --dangerously-skip-permissions`);
    // Bare (non-setsid) arm also present — 4-space indent + prefix, no `setsid`.
    expect(content).toContain(`\n    ${SANDBOX_PREFIX} agy --dangerously-skip-permissions`);
  });

  test("re-inherits the pty stdin via <&0 on both launch arms", () => {
    const content = buildAgyStartContent(baseInput());
    const armCount = content.split(`<&0 2> "$STDERR_LOG" &`).length - 1;
    expect(armCount).toBe(2);
  });

  test("does NOT pass --effort when the slug already carries an effort suffix (D1)", () => {
    // gemini-3.7-flash-low ends in -low → the slug owns the effort; passing
    // --effort too would be ambiguous, so it is omitted even with an effort.
    const content = buildAgyStartContent({ ...baseInput(), effort: "xhigh" });
    expect(content).not.toContain("--effort");
  });

  test("passes --effort (mapped) when the slug has NO effort suffix (D1)", () => {
    const content = buildAgyStartContent({
      ...baseInput(),
      agyModel: "claude-sonnet-4-6",
      effort: "xhigh", // maps down to agy 'high'
    });
    expect(content).toContain("--model 'claude-sonnet-4-6' --effort 'high'");
    expect(content).not.toContain("'xhigh'");
  });

  test("maps effort low/medium/high straight through for a suffix-less slug", () => {
    for (const [ib, agy] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "high"]] as const) {
      const content = buildAgyStartContent({ ...baseInput(), agyModel: "claude-sonnet-4-6", effort: ib });
      expect(content).toContain(`--effort '${agy}'`);
    }
  });

  test("omits --effort entirely when no effort is given (suffix-less slug)", () => {
    const content = buildAgyStartContent({ ...baseInput(), agyModel: "claude-sonnet-4-6" });
    expect(content).not.toContain("--effort");
  });

  test("the start.sh log line names the model + agent id but NOT the prompt", () => {
    const content = buildAgyStartContent(baseInput());
    const startingLine = content
      .split("\n")
      .find((l) => l.includes('log "Starting agy'))!;
    expect(startingLine).toContain("--model gemini-3.7-flash-low");
    expect(startingLine).toContain("agy agent id=agent-abc12345");
    // The prompt is read via $(cat ...) on the launch line, never logged.
    expect(startingLine).not.toContain("cat");
    expect(startingLine).not.toContain("prompt.txt");
  });

  test("is an agy launcher — not claude, not codex", () => {
    const content = buildAgyStartContent(baseInput());
    expect(content).not.toMatch(/\bclaude --/);
    expect(content).not.toContain("codex");
    expect(content).not.toContain("--session-id");
    expect(content).not.toContain("--conversation");
  });

  test("agy:default suppresses BOTH --model and --effort (agy uses its own default)", () => {
    // Even with an explicit effort, the `default` sentinel omits both flags.
    const content = buildAgyStartContent({ ...baseInput(), agyModel: "default", effort: "high" });
    expect(content).not.toContain("--model");
    expect(content).not.toContain("--effort");
    // The rest of the canonical D2 launch line is intact (no dangling flag).
    expect(content).toContain(
      "agy --dangerously-skip-permissions --mode=accept-edits --log-file '/tmp/test/agy.log' -i",
    );
  });

  test("agy:default start.sh log line names the default model, never a phantom --model", () => {
    const content = buildAgyStartContent({ ...baseInput(), agyModel: "default" });
    const startingLine = content.split("\n").find((l) => l.includes('log "Starting agy'))!;
    expect(startingLine).toContain("default model (no model flag)");
    expect(startingLine).not.toContain("--model");
  });

  test("rejects an unsafe ib binary path", () => {
    expect(() =>
      buildAgyStartContent({ ...baseInput(), ibBinaryPath: "/usr/local/bin/ib'; rm -rf /" }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects an invalid agent id", () => {
    expect(() => buildAgyStartContent({ ...baseInput(), agentId: "agent bad id" })).toThrow(/Invalid agent id/);
  });

  test("rejects an unsafe model slug", () => {
    expect(() => buildAgyStartContent({ ...baseInput(), agyModel: "gemini$(whoami)" })).toThrow(/Invalid agy model slug/);
  });
});

// ── buildAgyResumeContent — launch line ──────────────────────────────────────

describe("buildAgyResumeContent — launch line", () => {
  const baseInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    agyModel: "gemini-3.7-flash-low",
    conversationId: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });

  test("resumes collection before both gated agy launch arms", () => {
    const content = buildAgyResumeContent({ ...baseInput(),
      sandboxScriptPreamble: sandboxDenialScriptPreamble("/tmp/test"),
      sandboxExecPrefix: sandboxDenialExecPrefix("/usr/bin/sandbox-exec -f /tmp/test/sandbox.sb") });
    expect(content.indexOf("ib sandbox-log-watch")).toBeLessThan(content.indexOf("setsid /bin/sh -c"));
    expect(content.match(/sandbox-log-gate \/usr\/bin\/sandbox-exec[^\n]* agy /g)?.length).toBe(2);
  });

  test("carries --conversation <uuid> (shell-quoted) and re-passes --model", () => {
    const content = buildAgyResumeContent(baseInput());
    expect(content).toContain("--model 'gemini-3.7-flash-low'");
    expect(content).toContain("--conversation '019e7b21-cb7d-7f23-8674-11036ed141ef'");
  });

  test("does NOT pass -i or read the prompt on resume", () => {
    const content = buildAgyResumeContent(baseInput());
    expect(content).not.toContain("-i ");
    expect(content).not.toContain("$(cat ");
  });

  test("keeps the same D2 skip-permissions + accept-edits flags and CLAUDE_PID", () => {
    const content = buildAgyResumeContent(baseInput());
    expect(content).toContain("agy --dangerously-skip-permissions --mode=accept-edits --model");
    expect(content).toContain("CLAUDE_PID=$!");
    expect(content).toContain("--log-file '/tmp/test/agy.log'");
  });

  test("applies the same D1 effort rule as start (suffix slug → no --effort)", () => {
    const content = buildAgyResumeContent({ ...baseInput(), effort: "high" });
    expect(content).not.toContain("--effort");
  });

  test("applies --effort for a suffix-less slug on resume too", () => {
    const content = buildAgyResumeContent({ ...baseInput(), agyModel: "claude-sonnet-4-6", effort: "max" });
    expect(content).toContain("--effort 'high'");
  });

  test("agy:default omits --model/--effort on resume too, keeping --conversation", () => {
    const content = buildAgyResumeContent({ ...baseInput(), agyModel: "default", effort: "high" });
    expect(content).not.toContain("--model");
    expect(content).not.toContain("--effort");
    // --conversation is still re-passed so the prior conversation reattaches.
    expect(content).toContain(
      "agy --dangerously-skip-permissions --mode=accept-edits --log-file '/tmp/test/agy.log' --conversation '019e7b21-cb7d-7f23-8674-11036ed141ef'",
    );
  });

  test("the resume.sh log line names conversation + model but NOT any prompt", () => {
    const content = buildAgyResumeContent(baseInput());
    const line = content.split("\n").find((l) => l.includes('log "Resuming agy'))!;
    expect(line).toContain("--conversation 019e7b21-cb7d-7f23-8674-11036ed141ef");
    expect(line).toContain("--model gemini-3.7-flash-low");
    expect(line).not.toContain("cat");
  });

  test("rejects unsafe ib path / agent id / model slug", () => {
    expect(() => buildAgyResumeContent({ ...baseInput(), ibBinaryPath: "/x'y" })).toThrow(/Unsafe ib binary path/);
    expect(() => buildAgyResumeContent({ ...baseInput(), agentId: "bad id" })).toThrow(/Invalid agent id/);
    expect(() => buildAgyResumeContent({ ...baseInput(), agyModel: "a b" })).toThrow(/Invalid agy model slug/);
  });

  test("rejects an unsafe conversation id (belt-and-suspenders — it is embedded RAW in a log line)", () => {
    expect(() =>
      buildAgyResumeContent({ ...baseInput(), conversationId: "abc; rm -rf /" }),
    ).toThrow(/Invalid agy conversation id/);
    // A well-formed UUID is accepted.
    expect(() =>
      buildAgyResumeContent({ ...baseInput(), conversationId: "019e7b21-cb7d-7f23-8674-11036ed141ef" }),
    ).not.toThrow();
  });
});

// ── optional sandbox wrapper ─────────────────────────────────────────────────

describe("buildAgy{Start,Resume}Content — optional sandbox wrapper", () => {
  const startBase = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    agyModel: "gemini-3.7-flash-low",
    absPromptFile: "/tmp/test/prompt.txt",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });
  const resumeBase = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    agyModel: "gemini-3.7-flash-low",
    conversationId: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });

  test("start.sh splices the proxy preamble after log() and wraps agy on both arms", () => {
    const content = buildAgyStartContent(startBase());
    // Preamble sits immediately after the log() definition.
    expect(content).toContain(`[start.sh] $1" >> "$AGENT_LOG"; }${SANDBOX_PREAMBLE}`);
    expect(content).toContain('export http_proxy="http://localhost:54321"');
    // Both launch arms carry the sandbox-exec prefix ahead of agy.
    expect(content).toContain(`setsid ${SANDBOX_PREFIX} agy --dangerously-skip-permissions`);
    expect(content).toContain(`\n    ${SANDBOX_PREFIX} agy --dangerously-skip-permissions`);
  });

  test("resume.sh splices the proxy preamble after log() and wraps agy on both arms", () => {
    const content = buildAgyResumeContent(resumeBase());
    expect(content).toContain(`[resume.sh] $1" >> "$AGENT_LOG"; }${SANDBOX_PREAMBLE}`);
    expect(content).toContain('export http_proxy="http://localhost:54321"');
    expect(content).toContain(`setsid ${SANDBOX_PREFIX} agy --dangerously-skip-permissions`);
    expect(content).toContain(`\n    ${SANDBOX_PREFIX} agy --dangerously-skip-permissions`);
  });

  test("start.sh REFUSES an absent wrapper when enabled", () => {
    expect(() => buildAgyStartContent({ ...startBase(), sandboxScriptPreamble: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildAgyStartContent({ ...startBase(), sandboxExecPrefix: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
  });

  test("resume.sh REFUSES an absent wrapper when enabled", () => {
    expect(() => buildAgyResumeContent({ ...resumeBase(), sandboxScriptPreamble: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildAgyResumeContent({ ...resumeBase(), sandboxExecPrefix: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
  });

  test("disabled start and resume omit yolo flags and kernel helpers", () => {
    const start = buildAgyStartContent({ ...startBase(), sandboxEnabled: false });
    const resume = buildAgyResumeContent({ ...resumeBase(), sandboxEnabled: false });
    for (const content of [start, resume]) {
      expect(content).toMatch(/agy(?: --model| --log-file)/);
      expect(content).not.toContain("--dangerously-skip-permissions");
      expect(content).not.toContain("--mode=accept-edits");
      expect(content).not.toContain("sandbox-exec");
      expect(content).not.toContain("sandbox-proxy-launch");
      expect(content).not.toContain("sandbox-log-watch");
      expect(content).not.toContain("export http_proxy=");
    }
  });
});

// ── refuseIfTracked (D7) ─────────────────────────────────────────────────────

describe("refuseIfTracked", () => {
  test("returns the first file that git ls-files reports as tracked", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => {
      calls.push(cmd);
      // Pretend the second file is tracked (exit 0), the first is not.
      const tracked = cmd[cmd.length - 1] === ".agents/rules/ittybitty-agent.md";
      return { stdout: "", stderr: "", exitCode: tracked ? 0 : 1 };
    };
    const result = await refuseIfTracked(
      "/wt",
      [".agents/hooks.json", ".agents/rules/ittybitty-agent.md"],
      run,
    );
    expect(result).toBe(".agents/rules/ittybitty-agent.md");
    // Uses `git -C <worktree> ls-files --error-unmatch <file>`.
    expect(calls[0]).toEqual(["git", "-C", "/wt", "ls-files", "--error-unmatch", ".agents/hooks.json"]);
  });

  test("returns null when no file is tracked", async () => {
    const run = async () => ({ stdout: "", stderr: "not tracked", exitCode: 1 });
    const result = await refuseIfTracked("/wt", [".agents/hooks.json"], run);
    expect(result).toBeNull();
  });
});

// ── writeAgyWorktreeFiles + untrustAgyWorkspaceForTeardown (temp HOME) ────────

describe("writeAgyWorktreeFiles / untrust (temp HOME)", () => {
  let tempDir: string;
  let fakeHome: string;
  let worktree: string;

  function ctxFor(overrides: Partial<SessionContext> = {}): SessionContext {
    return {
      role: "worker",
      agentId: "agent-wtf01",
      agentManager: "agent-mgr01",
      parentBranch: "main",
      branchName: "agent/agent-wtf01",
      worktreePath: worktree,
      rootRepoPath: tempDir,
      agentType: "worker",
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-spawn-test-"));
    fakeHome = join(tempDir, "home");
    await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
    setUserHome(fakeHome);
    await (await import("./agent-types")).ensureAgentTypesDir();
    worktree = join(tempDir, "wt");
    await mkdir(worktree, { recursive: true });
  });

  afterEach(async () => {
    resetUserHome();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes .agents/hooks.json and .agents/rules/ittybitty-agent.md, creating dirs", async () => {
    const { hooksPath, rulesPath } = await writeAgyWorktreeFiles(worktree, ctxFor(), {
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-wtf01",
    });
    expect(hooksPath).toBe(join(worktree, ".agents", "hooks.json"));
    expect(rulesPath).toBe(join(worktree, ".agents", "rules", "ittybitty-agent.md"));

    const hooks = JSON.parse(await Bun.file(hooksPath).text());
    expect(hooks.ittybitty.PreToolUse[0].hooks[0].command).toBe(
      "/usr/local/bin/ib hooks agy-pre-tool-use agent-wtf01",
    );
    const rules = await Bun.file(rulesPath).text();
    expect(rules.startsWith("---\ntrigger: always_on")).toBe(true);
    expect(rules).toContain("agent-wtf01");
  });

  test("untrust removes an agy agent's worktree from trustedWorkspaces before teardown", async () => {
    const agentDir = join(tempDir, "agent");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-wtf01", model: "agy:gemini-3.7-flash-low" }));
    // Seed the trust file with the worktree realpath (what spawn stored).
    const real = realpathSync(worktree);
    await mkdir(join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    await Bun.write(agySettingsPath(), JSON.stringify({ keepKey: 1, trustedWorkspaces: ["/other", real] }));

    await untrustAgyWorkspaceForTeardown(agentDir, worktree);

    const settings = JSON.parse(await Bun.file(agySettingsPath()).text());
    expect(settings.keepKey).toBe(1);
    expect(settings.trustedWorkspaces).toEqual(["/other"]);
  });

  test("untrust is a no-op for a claude agent (does not touch the trust file)", async () => {
    const agentDir = join(tempDir, "agent-claude");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "c1", model: "claude:sonnet" }));
    const real = realpathSync(worktree);
    await mkdir(join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    const before = JSON.stringify({ trustedWorkspaces: [real] });
    await Bun.write(agySettingsPath(), before);

    await untrustAgyWorkspaceForTeardown(agentDir, worktree);

    // Untouched — a claude teardown must never mutate ~/.gemini.
    expect(await Bun.file(agySettingsPath()).text()).toBe(before);
  });

  test("untrust never throws when meta.json is missing", async () => {
    const agentDir = join(tempDir, "no-meta");
    await mkdir(agentDir, { recursive: true });
    await untrustAgyWorkspaceForTeardown(agentDir, worktree); // must not throw
    expect(true).toBe(true);
  });

  test("untrust never throws for an agy agent with no trust file present", async () => {
    const agentDir = join(tempDir, "agent-notrust");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "a1", model: "agy:gemini-3.7-flash-low" }));
    await untrustAgyWorkspaceForTeardown(agentDir, worktree); // must not throw
    expect(await Bun.file(agySettingsPath()).exists()).toBe(false);
  });
});
