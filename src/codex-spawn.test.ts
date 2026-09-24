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
import { chmod, mkdtemp, rm, mkdir, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildCodexStartContent,
  buildCodexResumeContent,
  appendCodexGitignoreEntry,
  stripIttybittyWrapper,
  resolveIbBinaryPath,
  buildSkillsSection,
  removeLegacyCodexAgentsMd,
} from "./codex-spawn";
import {
  CODEX_DEVELOPER_INSTRUCTIONS_MAX_BYTES,
  CODEX_REGISTERED_EVENTS,
  renderCodexDeveloperInstructionsPayload,
  tomlBasicString,
} from "./codex-config";
import { setUserHome, resetUserHome } from "./home";
import { shellQuote } from "./validation";
import {
  codexDeveloperInstructionsFromScript,
  decodeCodexStringOverride,
  hasPythonTomllib,
  pythonTomlDecodeBasicString,
} from "./test-utils";
import { sandboxDenialExecPrefix, sandboxDenialScriptPreamble } from "./sandbox-log-launch";

// Enabled-mode wrapper fixtures. Builders require the complete pair only when
// sandboxEnabled is true and ignore both when it is false.
const SANDBOX_PREAMBLE = "\n# test proxy preamble\nexport http_proxy=\"http://localhost:54321\"\n";
const SANDBOX_PREFIX = "sandbox-exec -f '/tmp/test/sandbox.sb' -D 'AGENTDIR=/tmp/test'";
const sandboxFields = () => ({
  sandboxEnabled: true,
  sandboxScriptPreamble: SANDBOX_PREAMBLE,
  sandboxExecPrefix: SANDBOX_PREFIX,
});

// Role instructions the launch-line fixtures pass as developer_instructions.
const ROLE_TEXT = "## Role\n\nYou are worker agent `agent-abc12345`.\n";

describe("buildCodexStartContent — launch line", () => {
  const baseInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    codexModel: "gpt-5.4-mini",
    developerInstructions: ROLE_TEXT,
    absPromptFile: "/tmp/test/prompt.txt",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });

  test("enabled mode disables Codex native protections beneath the shared Seatbelt wrapper", () => {
    const content = buildCodexStartContent(baseInput());
    // The model is shell-quoted, so it ends up wrapped in single quotes.
    expect(content).toContain("-m 'gpt-5.4-mini'");
    expect(content).toContain("-a never");
    expect(content).toContain("-s danger-full-access");
    expect(content).not.toContain("-s workspace-write");
    expect(content).toContain("--dangerously-bypass-hook-trust");
  });

  test("uses our sandbox wrapper, proxy exports, and danger-full-access on both launch arms", () => {
    const content = buildCodexStartContent({
      ...baseInput(),
      sandboxScriptPreamble: "\nexport HTTPS_PROXY=\"http://localhost:43123\"\n",
      sandboxExecPrefix: "sandbox-exec -f '/tmp/test/sandbox.sb' -D 'AGENTDIR=/tmp/test'",
    });
    expect(content).toContain("export HTTPS_PROXY=\"http://localhost:43123\"");
    expect(content).toContain("setsid sandbox-exec -f '/tmp/test/sandbox.sb'");
    expect(content).toMatch(/^    sandbox-exec -f '\/tmp\/test\/sandbox\.sb'.* codex -m/m);
    expect(content).toContain("-a never -s danger-full-access --dangerously-bypass-hook-trust");
    expect(content).not.toContain("-s workspace-write");
    expect(content).toMatch(/sandbox-exec [^\n]* codex [^\n]* <&0 2> "\$STDERR_LOG" &/);
  });

  test.each([false, true])("start owns collection before both CLI launch arms (fugu=%p)", fugu => {
    const content = buildCodexStartContent({ ...baseInput(), fugu,
      sandboxScriptPreamble: SANDBOX_PREAMBLE + sandboxDenialScriptPreamble("/tmp/test"),
      sandboxExecPrefix: sandboxDenialExecPrefix(SANDBOX_PREFIX) });
    expect(content.indexOf("ib sandbox-log-watch")).toBeLessThan(content.indexOf("setsid /bin/sh -c"));
    expect(content.match(/sandbox-log-gate sandbox-exec[^\n]* codex -m/g)?.length).toBe(2);
    expect(content).toContain("trap 'cleanup_sandbox_log; cleanup_sandbox_proxy' EXIT");
  });

  test("REFUSES an enabled launch without the complete wrapper", () => {
    expect(() => buildCodexStartContent({ ...baseInput(), sandboxScriptPreamble: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildCodexStartContent({ ...baseInput(), sandboxExecPrefix: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildCodexStartContent({ ...baseInput(), sandboxScriptPreamble: " \n\t" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildCodexStartContent({ ...baseInput(), sandboxExecPrefix: " \t" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
  });

  test.each([false, true])("disabled launch keeps native workspace-write and hooks, and omits kernel helpers (fugu=%s)", (fugu) => {
    const content = buildCodexStartContent({
      ...baseInput(),
      sandboxEnabled: false,
      fugu,
    });
    expect(content.match(/codex -m [^\n]* -a never -s workspace-write --dangerously-bypass-hook-trust/g)?.length).toBe(2);
    expect(content).toContain("--dangerously-bypass-hook-trust");
    expect(content).not.toContain("-s danger-full-access");
    expect(content).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(content).toContain("hooks.PreToolUse");
    expect(content).not.toContain("sandbox-exec");
    expect(content).not.toContain("sandbox-proxy-launch");
    expect(content).not.toContain("sandbox-log-watch");
    expect(content).not.toContain("export http_proxy=");
  });

  test("disabled launch ignores stale wrapper fields instead of partially enabling the kernel sandbox", () => {
    const content = buildCodexStartContent({
      ...baseInput(),
      sandboxEnabled: false,
      sandboxScriptPreamble: "STALE-PREAMBLE",
      sandboxExecPrefix: "STALE-PREFIX",
    });
    expect(content).not.toContain("STALE-PREAMBLE");
    expect(content).not.toContain("STALE-PREFIX");
    expect(content).toContain("-a never -s workspace-write");
    expect(content).toContain("hooks.PreToolUse");
  });

  test("threads codexEffort into the -c model_reasoning_effort override", () => {
    const content = buildCodexStartContent({ ...baseInput(), codexEffort: "high" });
    // Each `-c` payload is shell-quoted, so it appears single-quoted.
    expect(content).toContain(`'model_reasoning_effort="high"'`);
  });

  test("omits model_reasoning_effort when codexEffort is absent", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).not.toContain("model_reasoning_effort");
  });

  test("adds the Sakana Responses provider and loads its key only into the child environment for Fugu", () => {
    const content = buildCodexStartContent({ ...baseInput(), codexModel: "fugu-ultra", fugu: true });
    expect(content).toContain("'model_provider=\"sakana\"'");
    expect(content).toContain("'model_providers.sakana.base_url=\"https://api.sakana.ai/v1\"'");
    expect(content).toContain("'model_providers.sakana.wire_api=\"responses\"'");
    expect(content).toContain("config get providers.fugu.api_key");
    expect(content).toContain("export SAKANA_API_KEY");
    expect(content).not.toContain("fish_");
  });

  test("disables Codex's API-typed built-in tools for Fugu (Sakana accepts only function/custom)", () => {
    // Sakana's Responses API rejects any tool whose `type` is not `function`
    // or `custom`. Codex's default `image_generation` and `web_search` tools
    // use such API types and abort the whole request, so the Fugu provider
    // overrides must turn both off. Each `-c` payload is shell-quoted, so it
    // appears single-quoted in the launch line.
    const content = buildCodexStartContent({ ...baseInput(), codexModel: "fugu-ultra", fugu: true });
    expect(content).toContain("'features.image_generation=false'");
    expect(content).toContain("'web_search=\"disabled\"'");
    // multi_agent (the `namespace` tool group) is already disabled for every
    // codex agent via buildCodexLaunchArgs(), so it appears on the Fugu line too.
    expect(content).toContain("'features.multi_agent=false'");
  });

  test("does NOT emit the Fugu tool-disabling overrides for a regular codex (OpenAI) agent", () => {
    // The image_generation / web_search overrides are scoped strictly to the
    // Fugu/Sakana path. A plain `codex:` agent (no `fugu` flag) must keep
    // Codex's default built-in tools, so neither override may appear, and the
    // Sakana provider block must be absent entirely.
    const content = buildCodexStartContent(baseInput());
    expect(content).not.toContain("features.image_generation=false");
    expect(content).not.toContain('web_search="disabled"');
    expect(content).not.toContain("model_provider=\"sakana\"");
  });

  test("passes extra writable roots through as --add-dir flags", () => {
    const content = buildCodexStartContent({
      ...baseInput(),
      extraWritableRoots: ["/repo/.git"],
    });
    expect(content).toContain("'--add-dir' '/repo/.git'");
  });

  test("always grants --add-dir <coordinatorHome> so codex can write centralized state", async () => {
    // Per-agent outboxes (`<coordinatorHome>/agents/<id>/outbox.jsonl`),
    // team channels (`<coordinatorHome>/teams/...`), and `teams.json` all
    // live under the coordinator home. The --add-dir flags are emitted on every
    // codex spawn regardless of sandbox mode, so the entire coordinator home
    // appears as an --add-dir — otherwise `ib send <other-id>` and `ib send
    // @<team>` fail with EPERM trying to append to centralized state.
    const { setCoordinatorHome, resetCoordinatorHome } = await import("./coordinator");
    const fakeHome = "/tmp/codex-spawn-test-home";
    setCoordinatorHome(fakeHome);
    try {
      const content = buildCodexStartContent(baseInput());
      expect(content).toContain(`'--add-dir' '${fakeHome}'`);
    } finally {
      resetCoordinatorHome();
    }
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

  test("offers both setsid and bare-launch paths (sandbox-wrapped)", () => {
    const content = buildCodexStartContent(baseInput());
    // Both arms wrap codex under our sandbox-exec prefix (mandatory sandbox).
    expect(content).toMatch(/setsid sandbox-exec [^\n]* codex -m/);
    // Bare-launch arm: an indented `sandbox-exec … codex -m` line in the else branch.
    expect(content).toMatch(/else\s*\n\s*sandbox-exec [^\n]* codex -m/);
  });

  test("redirects stdin from <&0 on both launch arms (codex enforces isatty(0); bash bg-jobs default stdin to /dev/null)", () => {
    const content = buildCodexStartContent(baseInput());
    // setsid arm (sandbox-wrapped)
    expect(content).toMatch(/setsid sandbox-exec [^\n]* codex -m [^\n]* <&0 2> "\$STDERR_LOG" &/);
    // bare arm (sandbox-wrapped)
    expect(content).toMatch(/^    sandbox-exec [^\n]* codex -m [^\n]* <&0 2> "\$STDERR_LOG" &$/m);
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

  test("disables codex's native multi-agent feature on every spawn", () => {
    // `-c features.multi_agent=false` is shell-quoted by shellQuote, so it
    // appears as `'-c' 'features.multi_agent=false'` in the launch line.
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain("'features.multi_agent=false'");
  });

  test("disables codex's commit_attribution trailer on every spawn", () => {
    const content = buildCodexStartContent(baseInput());
    // The TOML empty-string literal is `""` (two double quotes). After
    // shellQuote, the apostrophe wrapping makes this `'commit_attribution=""'`.
    expect(content).toContain(`'commit_attribution=""'`);
  });

  test("sets codex's log_dir to <agentDir>/codex on every spawn", () => {
    // shellQuote wraps the payload in apostrophes; the TOML string literal
    // inside uses double quotes around the path.
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain(`'log_dir="/tmp/test/codex"'`);
  });

  test("suppresses codex's onboarding tooltips on every spawn", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain("'tui.show_tooltips=false'");
  });

  test("rejects an unsafe agentDir (apostrophe would break TOML+shell quoting)", () => {
    expect(() =>
      buildCodexStartContent({
        ...baseInput(),
        agentDir: "/Users/o'malley/work/.ittybitty/agents/agent-abc12345",
      }),
    ).toThrow(/Unsafe agent directory path/);
  });

  test("rejects unsafe extra writable roots", () => {
    expect(() =>
      buildCodexStartContent({
        ...baseInput(),
        extraWritableRoots: ["/Users/o'malley/repo/.git"],
      }),
    ).toThrow(/Unsafe extra writable root/);
  });
});

describe("buildCodexResumeContent — launch line (SPEC §5.8 + §6 Phase 7)", () => {
  const baseInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    codexSessionId: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    developerInstructions: ROLE_TEXT,
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });

  test("launches `codex resume <UUID>` (subcommand form, not the --resume flag)", () => {
    const content = buildCodexResumeContent(baseInput());
    // The UUID is shell-quoted by shellQuote (no metacharacters in a UUID, so
    // single-quoting is the form bun's shellQuote produces). The launch is
    // sandbox-wrapped, so the setsid arm carries our prefix ahead of `codex`.
    expect(content).toContain(`setsid ${SANDBOX_PREFIX} codex resume '019e7b21-cb7d-7f23-8674-11036ed141ef'`);
    expect(content).toContain("codex resume '019e7b21-cb7d-7f23-8674-11036ed141ef'"); // bare-launch arm
    // MUST NOT use claude's --resume flag pattern.
    expect(content).not.toContain("--resume");
  });

  test("enabled resume disables Codex native protections beneath the shared Seatbelt wrapper", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("-a never");
    expect(content).toContain("-s danger-full-access");
    expect(content).not.toContain("-s workspace-write");
    expect(content).toContain("--dangerously-bypass-hook-trust");
  });

  test("uses our sandbox wrapper, proxy exports, and danger-full-access on both resume arms", () => {
    const content = buildCodexResumeContent({
      ...baseInput(),
      sandboxScriptPreamble: "\nexport HTTPS_PROXY=\"http://localhost:43124\"\n",
      sandboxExecPrefix: "sandbox-exec -f '/tmp/test/sandbox.sb' -D 'AGENTDIR=/tmp/test'",
    });
    expect(content).toContain("export HTTPS_PROXY=\"http://localhost:43124\"");
    expect(content).toContain("setsid sandbox-exec -f '/tmp/test/sandbox.sb'");
    expect(content).toMatch(/^    sandbox-exec -f '\/tmp\/test\/sandbox\.sb'.* codex resume/m);
    expect(content).toContain("-a never -s danger-full-access --dangerously-bypass-hook-trust");
    expect(content).not.toContain("-s workspace-write");
    expect(content).toMatch(/sandbox-exec [^\n]* codex resume [^\n]* <&0 2> "\$STDERR_LOG" &/);
  });

  test.each([false, true])("resume owns collection before both CLI launch arms (fugu=%p)", fugu => {
    const content = buildCodexResumeContent({ ...baseInput(), fugu,
      sandboxScriptPreamble: SANDBOX_PREAMBLE + sandboxDenialScriptPreamble("/tmp/test"),
      sandboxExecPrefix: sandboxDenialExecPrefix(SANDBOX_PREFIX) });
    expect(content.indexOf("ib sandbox-log-watch")).toBeLessThan(content.indexOf("setsid /bin/sh -c"));
    expect(content.match(/sandbox-log-gate sandbox-exec[^\n]* codex resume/g)?.length).toBe(2);
  });

  test("REFUSES an enabled resume without the complete wrapper", () => {
    expect(() => buildCodexResumeContent({ ...baseInput(), sandboxScriptPreamble: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildCodexResumeContent({ ...baseInput(), sandboxExecPrefix: "" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildCodexResumeContent({ ...baseInput(), sandboxScriptPreamble: " \n\t" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
    expect(() => buildCodexResumeContent({ ...baseInput(), sandboxExecPrefix: " \t" }))
      .toThrow(/requires the proxy preamble and sandbox-exec prefix/);
  });

  test.each([false, true])("disabled resume keeps native workspace-write and hooks, and omits kernel helpers (fugu=%s)", (fugu) => {
    const content = buildCodexResumeContent({
      ...baseInput(),
      sandboxEnabled: false,
      fugu,
    });
    expect(content.match(/codex resume [^\n]* -a never -s workspace-write --dangerously-bypass-hook-trust/g)?.length).toBe(2);
    expect(content).toContain("--dangerously-bypass-hook-trust");
    expect(content).not.toContain("-s danger-full-access");
    expect(content).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(content).toContain("hooks.PreToolUse");
    expect(content).not.toContain("sandbox-exec");
    expect(content).not.toContain("sandbox-proxy-launch");
    expect(content).not.toContain("sandbox-log-watch");
    expect(content).not.toContain("export http_proxy=");
  });

  test("disabled resume ignores stale wrapper fields instead of partially enabling the kernel sandbox", () => {
    const content = buildCodexResumeContent({
      ...baseInput(),
      sandboxEnabled: false,
      sandboxScriptPreamble: "STALE-PREAMBLE",
      sandboxExecPrefix: "STALE-PREFIX",
    });
    expect(content).not.toContain("STALE-PREAMBLE");
    expect(content).not.toContain("STALE-PREFIX");
    expect(content).toContain("-a never -s workspace-write");
    expect(content).toContain("hooks.PreToolUse");
  });

  test("re-passes extra writable roots through as --add-dir flags on resume", () => {
    const content = buildCodexResumeContent({
      ...baseInput(),
      extraWritableRoots: ["/repo/.git"],
    });
    expect(content).toContain("'--add-dir' '/repo/.git'");
  });

  test("re-applies the -c model_reasoning_effort override on resume (a -c config override, unlike rollout-bound -m)", () => {
    const content = buildCodexResumeContent({ ...baseInput(), codexEffort: "medium" });
    expect(content).toContain(`'model_reasoning_effort="medium"'`);
    // The model flag is NOT re-passed on resume (bound to the rollout).
    expect(content).not.toContain("-m ");
  });

  test("omits model_reasoning_effort on resume when codexEffort is absent (legacy agents)", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).not.toContain("model_reasoning_effort");
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

  test("offers both setsid and bare-launch paths (sandbox-wrapped)", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toMatch(/setsid sandbox-exec [^\n]* codex resume/);
    expect(content).toMatch(/else\s*\n\s*sandbox-exec [^\n]* codex resume/);
  });

  test("redirects stdin from <&0 on both launch arms (codex enforces isatty(0); bash bg-jobs default stdin to /dev/null)", () => {
    const content = buildCodexResumeContent(baseInput());
    // setsid arm (sandbox-wrapped)
    expect(content).toMatch(/setsid sandbox-exec [^\n]* codex resume [^\n]* <&0 2> "\$STDERR_LOG" &/);
    // bare arm (sandbox-wrapped)
    expect(content).toMatch(/^    sandbox-exec [^\n]* codex resume [^\n]* <&0 2> "\$STDERR_LOG" &$/m);
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

  test("re-passes features.multi_agent=false on resume", () => {
    // Resume goes through buildCodexLaunchArgs (same path as start.sh), so the
    // disable flag propagates. Verifying explicitly because resume.sh is the
    // resurrection path — if the flag were lost here, a resumed agent would
    // regain access to the codex native multi-agent tools.
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("'features.multi_agent=false'");
  });

  test("re-passes the Fugu tool-disabling overrides on resume", () => {
    // resume.sh is the resurrection path: a resumed Fugu agent must keep the
    // image_generation / web_search tools disabled or it would re-trip Sakana's
    // "Supported values are: 'function' and 'custom'" rejection on its first turn.
    const content = buildCodexResumeContent({ ...baseInput(), fugu: true });
    expect(content).toContain("'features.image_generation=false'");
    expect(content).toContain("'web_search=\"disabled\"'");
  });

  test("does NOT emit the Fugu tool-disabling overrides on resume for a regular codex agent", () => {
    // Scope guard: the overrides ride on FUGU_CODEX_CONFIG_OVERRIDES, gated on
    // `fugu === true`. A plain `codex:` resume must keep Codex's defaults.
    const content = buildCodexResumeContent(baseInput());
    expect(content).not.toContain("features.image_generation=false");
    expect(content).not.toContain('web_search="disabled"');
  });

  test("re-passes commit_attribution=\"\" on resume", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain(`'commit_attribution=""'`);
  });

  test("re-passes log_dir=\"<agentDir>/codex\" on resume", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain(`'log_dir="/tmp/test/codex"'`);
  });

  test("re-passes tui.show_tooltips=false on resume", () => {
    const content = buildCodexResumeContent(baseInput());
    expect(content).toContain("'tui.show_tooltips=false'");
  });

  test("rejects an unsafe agentDir on resume", () => {
    expect(() =>
      buildCodexResumeContent({
        ...baseInput(),
        agentDir: "/Users/o'malley/work/.ittybitty/agents/agent-abc12345",
      }),
    ).toThrow(/Unsafe agent directory path/);
  });

  test("rejects unsafe extra writable roots on resume", () => {
    expect(() =>
      buildCodexResumeContent({
        ...baseInput(),
        extraWritableRoots: ["/Users/o'malley/repo/.git"],
      }),
    ).toThrow(/Unsafe extra writable root/);
  });
});

describe("write-pid stdin is redirected off the pane tty (codex COOKED-mode wedge fix)", () => {
  // Regression guard for the codex tty-cook wedge. `ib write-pid` is a bun
  // process that runs in the foreground AFTER codex has been backgrounded and
  // has switched the pane pty to RAW mode. If write-pid inherits the pane tty as
  // stdin, bun's tty save/restore restores the COOKED settings it snapshotted at
  // startup, undoing codex's raw-mode setup so Enter never submits and the agent
  // wedges. Redirecting stdin from /dev/null keeps write-pid off the tty; its
  // stdout/stderr go to the agent log so nothing is lost. Both templates spawn
  // codex the same way, so BOTH must carry the redirect.
  const startInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    codexModel: "gpt-5.4-mini",
    developerInstructions: ROLE_TEXT,
    absPromptFile: "/tmp/test/prompt.txt",
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });
  const resumeInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
    codexSessionId: "019e7b21-cb7d-7f23-8674-11036ed141ef",
    developerInstructions: ROLE_TEXT,
    absMetaJson: "/tmp/test/meta.json",
    absExitScript: "/tmp/test/exit-check.sh",
    absAgentLog: "/tmp/test/agent.log",
    absStderrLog: "/tmp/test/claude.stderr.log",
    ...sandboxFields(),
  });
  // The full line the fix must produce in both templates: stdin off the tty,
  // stdout/stderr appended to the agent log, and the OR-log fallback preserved
  // so it still fires only on write-pid failure.
  const EXPECTED_WRITE_PID_LINE =
    `'/usr/local/bin/ib' write-pid 'agent-abc12345' "$CLAUDE_PID" </dev/null >> "$AGENT_LOG" 2>&1 || log "write-pid failed (exit=$?); meta.json claude_pid not set"`;

  test("start.sh redirects write-pid stdin from /dev/null", () => {
    const content = buildCodexStartContent(startInput());
    // Indispensable part: stdin comes from /dev/null, not the pane tty.
    expect(content).toContain(`write-pid 'agent-abc12345' "$CLAUDE_PID" </dev/null`);
    // Full form, including log capture and preserved OR-log fallback.
    expect(content).toContain(EXPECTED_WRITE_PID_LINE);
  });

  test("resume.sh redirects write-pid stdin from /dev/null", () => {
    const content = buildCodexResumeContent(resumeInput());
    expect(content).toContain(`write-pid 'agent-abc12345' "$CLAUDE_PID" </dev/null`);
    expect(content).toContain(EXPECTED_WRITE_PID_LINE);
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

describe("buildCodexDeveloperInstructions", () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-dev-instructions-test-"));
    // Provide a fake HOME so generateInstructions() can resolve agent-types
    // without polluting the developer's real ~/.itsybitsy.
    fakeHome = join(tempDir, "home");
    await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
    setUserHome(fakeHome);
    await (await import("./agent-types")).ensureAgentTypesDir();
  });

  afterEach(async () => {
    resetUserHome();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("strips the <ittybitty> wrapper", async () => {
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
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
    const body = await buildCodexDeveloperInstructions(ctx);
    expect(body.startsWith("<ittybitty>")).toBe(false);
    expect(body.endsWith("</ittybitty>")).toBe(false);
    expect(body.endsWith("</ittybitty>\n")).toBe(false);
  });

  test("contains the agent id (interpolated from template)", async () => {
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
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
    const body = await buildCodexDeveloperInstructions(ctx);
    expect(body).toContain("agent-test01");
  });

  test("writes nothing into the worktree (codex reads the repo's own AGENTS.md)", async () => {
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
    const worktree = join(tempDir, "wt");
    await mkdir(worktree, { recursive: true });
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
    await buildCodexDeveloperInstructions(ctx);
    expect(await Bun.file(join(worktree, "AGENTS.md")).exists()).toBe(false);
  });

  // HIGH 4 from Phase 4 review: codex manager instructions must not
  // reference Claude-only tools like TodoWrite.
  test("HIGH 4: codex manager instructions do not reference TodoWrite", async () => {
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
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
    const body = await buildCodexDeveloperInstructions(ctx);
    expect(body).not.toContain("TodoWrite");
    // Replacement phrasing should be present.
    expect(body).toContain("Track progress with measurable criteria");
  });

  test("HIGH 4: codex worker instructions do not contain Write(...) tool reference", async () => {
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
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
    const body = await buildCodexDeveloperInstructions(ctx);
    // The original _non_coordinator.md had `Write(/tmp/commit-msg.txt, ...)`
    // which references the Claude `Write` tool. After the HIGH 4 fix, this
    // exact snippet must be gone.
    expect(body).not.toContain('Write(/tmp/commit-msg.txt');
  });

  test("copies in no project or user-wide instruction file — each CLI reads its own natively", async () => {
    // Codex reads the repo's AGENTS.md itself and its user-wide text from
    // ~/.codex/AGENTS.md; copying any of these in would give the agent two
    // copies (or, for CLAUDE.md, text the other CLIs never see).
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
    const worktree = join(tempDir, "wt");
    await mkdir(join(worktree, ".claude"), { recursive: true });
    await Bun.write(join(worktree, "CLAUDE.md"), "project-claude-marker-3141\n");
    await Bun.write(join(worktree, ".claude", "CLAUDE.md"), "dot-claude-marker-2718\n");
    await Bun.write(join(worktree, "AGENTS.md"), "project-agents-marker-1618\n");
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    await Bun.write(join(fakeHome, ".claude", "CLAUDE.md"), "user-global-marker-1414\n");
    const ctx = {
      role: "worker" as const,
      agentId: "agent-noinline",
      agentManager: "agent-mgr",
      parentBranch: "main",
      branchName: "agent/agent-noinline",
      worktreePath: worktree,
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const body = await buildCodexDeveloperInstructions(ctx);
    for (const marker of [
      "project-claude-marker-3141",
      "dot-claude-marker-2718",
      "project-agents-marker-1618",
      "user-global-marker-1414",
      "## Project CLAUDE.md",
      "## User-global CLAUDE.md",
      "@./CLAUDE.md",
    ]) {
      expect(body).not.toContain(marker);
    }
  });
});

describe("developer_instructions reaches codex byte-for-byte through the real start.sh / resume.sh", () => {
  // End-to-end over the shell layer: render the scripts, run them with bash
  // against a stub `codex` that records its argv NUL-separated, then decode
  // the recorded developer_instructions argument the way codex does.
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "codex-argv-")));
    await mkdir(join(dir, "bin"), { recursive: true });
    // Stub codex: each argv element exactly as received, NUL-terminated.
    await Bun.write(
      join(dir, "bin", "codex"),
      `#!/bin/bash\nprintf '%s\\0' "$@" > ${shellQuote(join(dir, "argv.bin"))}\n`,
    );
    await Bun.write(join(dir, "bin", "ib"), "#!/bin/bash\nexit 0\n");
    await Bun.write(join(dir, "exit-check.sh"), "#!/bin/bash\nexit 0\n");
    await Bun.write(join(dir, "prompt.txt"), "do the task");
    for (const exe of [join(dir, "bin", "codex"), join(dir, "bin", "ib"), join(dir, "exit-check.sh")]) {
      await chmod(exe, 0o755);
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const common = () => ({
    agentId: "agent-argv01",
    ibBinaryPath: join(dir, "bin", "ib"),
    agentDir: dir,
    absMetaJson: join(dir, "no-meta.json"), // absent → write-pid is skipped
    absExitScript: join(dir, "exit-check.sh"),
    absAgentLog: join(dir, "agent.log"),
    absStderrLog: join(dir, "stderr.log"),
    sandboxEnabled: false,
  });

  // Hostile at every layer, plus live shell expansions that would create
  // files if bash ever evaluated them.
  const hostileText = () => [
    "## Role",
    "it's O'Brien's \"quoted\" text; back\\slash and trailing \\",
    `\`touch ${dir}/pwned-backtick\` $(touch ${dir}/pwned-subst) \${HOME} $HOME !! $'ansi'`,
    "tab\there\r\ncrlf, controls \x00\x01\x1b[31m\x7f, bell \x07",
    "unicode: é 日本語 🎉 👩‍💻 \u{2028} \u{2029} \u{FEFF}",
    'toml: """ \'\'\' [table] key = "v" # not a comment',
  ].join("\n");

  async function runAndReadArgv(script: string): Promise<string[]> {
    const scriptPath = join(dir, "launch.sh");
    await Bun.write(scriptPath, script);
    const proc = Bun.spawn(["bash", scriptPath], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const bytes = await Bun.file(join(dir, "argv.bin")).bytes();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const args: string[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        args.push(decoder.decode(bytes.subarray(start, i)));
        start = i + 1;
      }
    }
    return args;
  }

  function developerInstructionsArg(args: string[]): string {
    const matches = args.filter((a, i) => a.startsWith("developer_instructions=") && args[i - 1] === "-c");
    expect(matches.length).toBe(1);
    return matches[0]!;
  }

  async function expectExactDelivery(args: string[], text: string): Promise<void> {
    const payload = developerInstructionsArg(args);
    const { key, value } = decodeCodexStringOverride(payload);
    expect(key).toBe("developer_instructions");
    expect(value).toBe(text);
    if (hasPythonTomllib()) {
      expect(pythonTomlDecodeBasicString(payload.slice("developer_instructions=".length))).toBe(text);
    }
    // No shell expansion ran.
    expect(await Bun.file(join(dir, "pwned-backtick")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "pwned-subst")).exists()).toBe(false);
  }

  test("start.sh: the argument codex receives decodes to the exact role text", async () => {
    const text = hostileText();
    const script = buildCodexStartContent({
      ...common(),
      codexModel: "gpt-5.4-mini",
      developerInstructions: text,
      absPromptFile: join(dir, "prompt.txt"),
    });
    // The generated script decodes to the same text as well (used by the
    // ib-commands integration tests to inspect role content).
    expect(codexDeveloperInstructionsFromScript(script)).toBe(text);
    const args = await runAndReadArgv(script);
    expect(args.slice(0, 2)).toEqual(["-m", "gpt-5.4-mini"]);
    expect(args.at(-1)).toBe("do the task");
    await expectExactDelivery(args, text);
  });

  test("resume.sh: the argument codex receives decodes to the exact role text", async () => {
    const text = hostileText();
    const script = buildCodexResumeContent({
      ...common(),
      codexSessionId: "019e7b21-cb7d-7f23-8674-11036ed141ef",
      developerInstructions: text,
    });
    expect(codexDeveloperInstructionsFromScript(script)).toBe(text);
    const args = await runAndReadArgv(script);
    expect(args.slice(0, 2)).toEqual(["resume", "019e7b21-cb7d-7f23-8674-11036ed141ef"]);
    await expectExactDelivery(args, text);
  });

  test("a payload near the size limit still launches as one argument", async () => {
    // ~110 KiB after escaping: every line holds characters that grow when
    // escaped (quotes, backslashes, newlines) plus multi-byte text.
    const line = "\"q\" \\b\\ é日 $(x) `y`\n";
    const text = line.repeat(Math.floor((110 * 1024) / Buffer.byteLength(tomlBasicString(line), "utf8")));
    const payloadBytes = Buffer.byteLength(renderCodexDeveloperInstructionsPayload(text), "utf8");
    expect(payloadBytes).toBeGreaterThan(100 * 1024);
    expect(payloadBytes).toBeLessThanOrEqual(CODEX_DEVELOPER_INSTRUCTIONS_MAX_BYTES);
    const script = buildCodexStartContent({
      ...common(),
      codexModel: "gpt-5.4-mini",
      developerInstructions: text,
      absPromptFile: join(dir, "prompt.txt"),
    });
    const args = await runAndReadArgv(script);
    expect(Buffer.byteLength(developerInstructionsArg(args), "utf8")).toBe(payloadBytes);
    expect(decodeCodexStringOverride(developerInstructionsArg(args)).value).toBe(text);
  });

  test("rendering refuses role text over the limit instead of writing a script codex cannot launch", () => {
    expect(() =>
      buildCodexStartContent({
        ...common(),
        codexModel: "gpt-5.4-mini",
        developerInstructions: "x".repeat(CODEX_DEVELOPER_INSTRUCTIONS_MAX_BYTES),
        absPromptFile: join(dir, "prompt.txt"),
      }),
    ).toThrow(/too large/);
  });
});

describe("removeLegacyCodexAgentsMd — pre-2026-09 generated AGENTS.md cleanup", () => {
  let worktree: string;
  const NOT_TRACKED = {
    stdout: "",
    stderr: "error: pathspec 'AGENTS.md' did not match any file(s) known to git\n",
    exitCode: 1,
  };
  const runner = (result: { stdout: string; stderr: string; exitCode: number }) => {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => {
      calls.push(cmd);
      return result;
    };
    return { run, calls };
  };

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "codex-legacy-agents-md-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  test("removes an untracked file with an old generator section", async () => {
    await Bun.write(join(worktree, "AGENTS.md"), "## State Management\n\n## Project CLAUDE.md\n\n@./CLAUDE.md\n");
    const { run, calls } = runner(NOT_TRACKED);
    expect(await removeLegacyCodexAgentsMd(worktree, "agent-old01", run)).toBe("removed");
    expect(await Bun.file(join(worktree, "AGENTS.md")).exists()).toBe(false);
    expect(calls).toEqual([["git", "-C", worktree, "ls-files", "--error-unmatch", "AGENTS.md"]]);
  });

  test("removes an untracked file carrying the agent's identity line", async () => {
    await Bun.write(
      join(worktree, "AGENTS.md"),
      "You are worker agent `agent-old02` in the ittybitty multi-agent orchestration system.\n",
    );
    expect(await removeLegacyCodexAgentsMd(worktree, "agent-old02", runner(NOT_TRACKED).run)).toBe("removed");
  });

  test("keeps a TRACKED AGENTS.md even when it looks generated (the repo's own file)", async () => {
    await Bun.write(join(worktree, "AGENTS.md"), "## Skills (read-on-demand workflow guides)\n");
    const tracked = runner({ stdout: "AGENTS.md\n", stderr: "", exitCode: 0 });
    expect(await removeLegacyCodexAgentsMd(worktree, "agent-old03", tracked.run)).toBe("tracked");
    expect(await Bun.file(join(worktree, "AGENTS.md")).exists()).toBe(true);
  });

  test("keeps an untracked AGENTS.md that itsybitsy did not generate", async () => {
    await Bun.write(join(worktree, "AGENTS.md"), "# Build\n\nRun `make`.\n");
    expect(await removeLegacyCodexAgentsMd(worktree, "agent-old04", runner(NOT_TRACKED).run)).toBe("kept");
    expect(await Bun.file(join(worktree, "AGENTS.md")).text()).toBe("# Build\n\nRun `make`.\n");
  });

  test("leaves the file alone when git fails without a clear 'not tracked' answer", async () => {
    await Bun.write(join(worktree, "AGENTS.md"), "## Skills (read-on-demand workflow guides)\n");
    const broken = runner({ stdout: "", stderr: "fatal: not a git repository\n", exitCode: 128 });
    expect(await removeLegacyCodexAgentsMd(worktree, "agent-old05", broken.run)).toBe("unknown");
    expect(await Bun.file(join(worktree, "AGENTS.md")).exists()).toBe(true);
  });

  test("does nothing (and runs no git) when there is no AGENTS.md", async () => {
    const { run, calls } = runner(NOT_TRACKED);
    expect(await removeLegacyCodexAgentsMd(worktree, "agent-old06", run)).toBe("absent");
    expect(calls).toEqual([]);
  });
});

describe("buildSkillsSection — skills catalog", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-skills-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper: write a skill <name>/SKILL.md with the given file contents.
  async function writeSkill(
    skillsDir: string,
    name: string,
    contents: string,
  ): Promise<string> {
    const dir = join(skillsDir, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    await Bun.write(path, contents);
    return path;
  }

  test("lists 2+ skills alphabetically, each with absolute SKILL.md path + raw frontmatter", async () => {
    const skillsDir = join(tempDir, "skills");
    // Write out of alphabetical order to prove the function sorts.
    const zebraPath = await writeSkill(
      skillsDir,
      "zebra",
      "---\nname: zebra\ndescription: Zebra skill\n---\n\n# Zebra body\nkey: not-frontmatter\n",
    );
    const alphaPath = await writeSkill(
      skillsDir,
      "alpha",
      "---\nname: alpha\ndescription: Alpha skill\n---\n\n# Alpha body\n",
    );

    const section = await buildSkillsSection(skillsDir);

    expect(section).toContain("## Skills (read-on-demand workflow guides)");
    // Both skills listed.
    expect(section).toContain("### alpha");
    expect(section).toContain("### zebra");
    // Absolute SKILL.md paths present.
    expect(section).toContain(`Path: ${alphaPath}`);
    expect(section).toContain(`Path: ${zebraPath}`);
    // Raw frontmatter reproduced verbatim.
    expect(section).toContain("name: alpha");
    expect(section).toContain("description: Alpha skill");
    expect(section).toContain("name: zebra");
    expect(section).toContain("description: Zebra skill");
    // Skill BODY is NOT inlined — only the frontmatter region is shown.
    expect(section).not.toContain("# Alpha body");
    expect(section).not.toContain("# Zebra body");
    // The body's `key:`-looking line must NOT leak into the frontmatter (it is
    // after the closing `---`, so the first-block parse never sees it).
    expect(section).not.toContain("key: not-frontmatter");
    // Alphabetical order: alpha's header appears before zebra's.
    expect(section.indexOf("### alpha")).toBeLessThan(
      section.indexOf("### zebra"),
    );
  });

  test("skips a subdirectory that has no SKILL.md", async () => {
    const skillsDir = join(tempDir, "skills");
    await writeSkill(
      skillsDir,
      "real",
      "---\nname: real\ndescription: Real skill\n---\n",
    );
    // A subdir with no SKILL.md inside.
    await mkdir(join(skillsDir, "empty"), { recursive: true });

    const section = await buildSkillsSection(skillsDir);
    expect(section).toContain("### real");
    expect(section).not.toContain("### empty");
  });

  test("still lists a SKILL.md that has no frontmatter (name only, empty block, no throw)", async () => {
    const skillsDir = join(tempDir, "skills");
    await writeSkill(
      skillsDir,
      "noheader",
      "# Just a body\nThere is no frontmatter here.\nkey: value\n",
    );

    const section = await buildSkillsSection(skillsDir);
    expect(section).toContain("### noheader");
    // The body content must not be inlined as frontmatter.
    expect(section).not.toContain("Just a body");
    expect(section).not.toContain("key: value");
  });

  test("frontmatter containing a ``` run is wrapped in a >=4-backtick fence and not corrupted", async () => {
    const skillsDir = join(tempDir, "skills");
    // A description whose value embeds a literal triple-backtick fenced example.
    // With a naive 3-backtick wrapper this inner ``` would close the fence
    // early and leak everything after it into the rendered AGENTS.md.
    const fmDescription =
      'description: "Use ```code``` blocks in your output"';
    await writeSkill(
      skillsDir,
      "fenced",
      "---\nname: fenced\n" + fmDescription + "\n---\n\n# body\n",
    );
    // A second skill AFTER it alphabetically — if the fence leaked, this skill's
    // header would be swallowed into the previous code block.
    await writeSkill(
      skillsDir,
      "later",
      "---\nname: later\ndescription: Later skill\n---\n",
    );

    const section = await buildSkillsSection(skillsDir);

    // The opening fence for the fenced skill must be >= 4 backticks (the inner
    // run is 3, so fenceFor returns 4). Assert the >=4 fence appears.
    expect(section).toContain("````");
    // The inner triple-backtick frontmatter is reproduced verbatim.
    expect(section).toContain(fmDescription);
    // The block after it is NOT corrupted: the later skill's header survives.
    expect(section).toContain("### later");
    expect(section).toContain("description: Later skill");
    // Sanity: alphabetical order preserved (fenced before later).
    expect(section.indexOf("### fenced")).toBeLessThan(
      section.indexOf("### later"),
    );
  });

  test("CRLF-line-ended SKILL.md does not leak \\r into the emitted frontmatter", async () => {
    const skillsDir = join(tempDir, "skills");
    // Author the file with Windows CRLF line endings throughout.
    const crlf =
      "---\r\nname: crlfskill\r\ndescription: CRLF skill\r\n---\r\n\r\n# body\r\n";
    await writeSkill(skillsDir, "crlfskill", crlf);

    const section = await buildSkillsSection(skillsDir);
    expect(section).toContain("### crlfskill");
    expect(section).toContain("name: crlfskill");
    expect(section).toContain("description: CRLF skill");
    // No carriage return must survive into the rendered output.
    expect(section).not.toContain("\r");
  });

  test("returns '' when the skills dir does not exist", async () => {
    const section = await buildSkillsSection(join(tempDir, "does-not-exist"));
    expect(section).toBe("");
  });

  test("returns '' when the skills dir exists but contains no skills", async () => {
    const skillsDir = join(tempDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    const section = await buildSkillsSection(skillsDir);
    expect(section).toBe("");
  });

  test("buildCodexDeveloperInstructions integration: output contains the Skills header when a skills dir exists", async () => {
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
    // buildCodexDeveloperInstructions reads ~/.claude/skills via the default param, so point
    // HOME at a temp dir holding a single skill. generateInstructions() also
    // resolves agent-types from HOME, so build the full fake-home layout.
    try {
      const fakeHome = join(tempDir, "home");
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      setUserHome(fakeHome);
      await (await import("./agent-types")).ensureAgentTypesDir();
      await writeSkill(
        join(fakeHome, ".claude", "skills"),
        "demo",
        "---\nname: demo\ndescription: Demo skill\n---\n",
      );

      const ctx = {
        role: "worker" as const,
        agentId: "agent-skilltest",
        agentManager: "agent-mgr",
        parentBranch: "main",
        branchName: "agent/agent-skilltest",
        worktreePath: join(tempDir, "wt"),
        rootRepoPath: tempDir,
        agentType: "worker",
      };
      const body = await buildCodexDeveloperInstructions(ctx);
      expect(body).toContain("## Skills (read-on-demand workflow guides)");
      expect(body).toContain("### demo");
      expect(body).toContain("description: Demo skill");
    } finally {
      resetUserHome();
    }
  });

  test("buildCodexDeveloperInstructions integration: no Skills header when the skills dir is absent", async () => {
    const { buildCodexDeveloperInstructions } = await import("./codex-spawn");
    try {
      // Fake home WITHOUT a .claude/skills dir.
      const fakeHome = join(tempDir, "home-noskills");
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      setUserHome(fakeHome);
      await (await import("./agent-types")).ensureAgentTypesDir();

      const ctx = {
        role: "worker" as const,
        agentId: "agent-noskill",
        agentManager: "agent-mgr",
        parentBranch: "main",
        branchName: "agent/agent-noskill",
        worktreePath: join(tempDir, "wt"),
        rootRepoPath: tempDir,
        agentType: "worker",
      };
      const body = await buildCodexDeveloperInstructions(ctx);
      expect(body).not.toContain("## Skills (read-on-demand workflow guides)");
    } finally {
      resetUserHome();
    }
  });
});
