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
  buildSkillsSection,
} from "./codex-spawn";
import { CODEX_REGISTERED_EVENTS } from "./codex-config";

describe("buildCodexStartContent — launch line", () => {
  const baseInput = () => ({
    agentId: "agent-abc12345",
    ibBinaryPath: "/usr/local/bin/ib",
    agentDir: "/tmp/test",
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
    // live under the coordinator home. Codex agents run with `-s workspace-write`,
    // so the entire coordinator home MUST appear as an --add-dir on every
    // codex spawn — otherwise `ib send <other-id>` and `ib send @<team>`
    // fail with EPERM trying to append to centralized state.
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

  test("offers both setsid and bare-launch paths", () => {
    const content = buildCodexStartContent(baseInput());
    expect(content).toContain("setsid codex -m");
    // Bare-launch arm: an unindented `codex -m` line in the else branch.
    expect(content).toMatch(/else\s*\n\s*codex -m/);
  });

  test("redirects stdin from <&0 on both launch arms (codex enforces isatty(0); bash bg-jobs default stdin to /dev/null)", () => {
    const content = buildCodexStartContent(baseInput());
    // setsid arm
    expect(content).toMatch(/setsid codex -m [^\n]* <&0 2> "\$STDERR_LOG" &/);
    // bare arm
    expect(content).toMatch(/^    codex -m [^\n]* <&0 2> "\$STDERR_LOG" &$/m);
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

  test("re-passes extra writable roots through as --add-dir flags on resume", () => {
    const content = buildCodexResumeContent({
      ...baseInput(),
      extraWritableRoots: ["/repo/.git"],
    });
    expect(content).toContain("'--add-dir' '/repo/.git'");
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

  test("redirects stdin from <&0 on both launch arms (codex enforces isatty(0); bash bg-jobs default stdin to /dev/null)", () => {
    const content = buildCodexResumeContent(baseInput());
    // setsid arm
    expect(content).toMatch(/setsid codex resume [^\n]* <&0 2> "\$STDERR_LOG" &/);
    // bare arm
    expect(content).toMatch(/^    codex resume [^\n]* <&0 2> "\$STDERR_LOG" &$/m);
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

  test("project CLAUDE.md is referenced via codex @./CLAUDE.md import when present in the worktree", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const worktree = join(tempDir, "wt");
    await mkdir(worktree, { recursive: true });
    await Bun.write(join(worktree, "CLAUDE.md"), "# project rules\n");
    const ctx = {
      role: "worker" as const,
      agentId: "agent-pclaude",
      agentManager: "agent-mgr",
      parentBranch: "main",
      branchName: "agent/agent-pclaude",
      worktreePath: worktree,
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const body = await buildCodexAgentsMd(ctx);
    expect(body).toContain("## Project CLAUDE.md");
    expect(body).toContain("@./CLAUDE.md");
    // The project CLAUDE.md content must NOT be inlined — it goes through
    // the `@` import so edits to the checked-in file propagate without a
    // regeneration.
    expect(body).not.toContain("# project rules");
  });

  test("user-global ~/.claude/CLAUDE.md is inlined when present (codex @ import can't reach outside the project root)", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const fakeHome = process.env.HOME!;
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    await Bun.write(
      join(fakeHome, ".claude", "CLAUDE.md"),
      "GLOBAL: be terse\n",
    );
    const ctx = {
      role: "worker" as const,
      agentId: "agent-gclaude",
      agentManager: "agent-mgr",
      parentBranch: "main",
      branchName: "agent/agent-gclaude",
      worktreePath: join(tempDir, "wt"),
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const body = await buildCodexAgentsMd(ctx);
    expect(body).toContain("## User-global CLAUDE.md");
    // The global file MUST be inlined — codex `@` import doesn't resolve
    // paths outside the project root.
    expect(body).toContain("GLOBAL: be terse");
  });

  test("no CLAUDE.md section is emitted when neither project nor user-global file exists", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const ctx = {
      role: "worker" as const,
      agentId: "agent-noclaude",
      agentManager: "agent-mgr",
      parentBranch: "main",
      branchName: "agent/agent-noclaude",
      worktreePath: join(tempDir, "wt"),
      rootRepoPath: tempDir,
      agentType: "worker",
    };
    const body = await buildCodexAgentsMd(ctx);
    expect(body).not.toContain("## Project CLAUDE.md");
    expect(body).not.toContain("## User-global CLAUDE.md");
    expect(body).not.toContain("@./CLAUDE.md");
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

  test("buildCodexAgentsMd integration: output contains the Skills header when a skills dir exists", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    // buildCodexAgentsMd reads ~/.claude/skills via the default param, so point
    // HOME at a temp dir holding a single skill. generateInstructions() also
    // resolves agent-types from HOME, so build the full fake-home layout.
    const originalHome = process.env.HOME;
    try {
      const fakeHome = join(tempDir, "home");
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      process.env.HOME = fakeHome;
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
      const body = await buildCodexAgentsMd(ctx);
      expect(body).toContain("## Skills (read-on-demand workflow guides)");
      expect(body).toContain("### demo");
      expect(body).toContain("description: Demo skill");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test("buildCodexAgentsMd integration: no Skills header when the skills dir is absent", async () => {
    const { buildCodexAgentsMd } = await import("./codex-spawn");
    const originalHome = process.env.HOME;
    try {
      // Fake home WITHOUT a .claude/skills dir.
      const fakeHome = join(tempDir, "home-noskills");
      await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
      process.env.HOME = fakeHome;
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
      const body = await buildCodexAgentsMd(ctx);
      expect(body).not.toContain("## Skills (read-on-demand workflow guides)");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
