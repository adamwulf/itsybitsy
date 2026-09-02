import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildAgyHooksJson,
  buildAgyRulesFile,
  AGY_WORKTREE_FILES,
  DEFAULT_AGY_HOOK_TIMEOUT_SECS,
  appendGitignoreEntries,
  ensureAgyTrustedWorkspace,
  removeAgyTrustedWorkspace,
  agySettingsPath,
} from "./agy-config";
import type { SessionContext } from "./hooks/session-start";

// ── buildAgyHooksJson ────────────────────────────────────────────────────────

describe("buildAgyHooksJson", () => {
  test("parses as JSON and registers the ittybitty named hook with the three events", () => {
    const text = buildAgyHooksJson({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
    });
    const doc = JSON.parse(text);
    expect(doc.ittybitty).toBeDefined();
    expect(Array.isArray(doc.ittybitty.PreToolUse)).toBe(true);
    expect(Array.isArray(doc.ittybitty.PreInvocation)).toBe(true);
    expect(Array.isArray(doc.ittybitty.Stop)).toBe(true);
  });

  test("PreToolUse carries a matcher '*' and points at agy-pre-tool-use", () => {
    const doc = JSON.parse(
      buildAgyHooksJson({ ibBinaryPath: "/usr/local/bin/ib", agentId: "agent-abc123" }),
    );
    const pre = doc.ittybitty.PreToolUse[0];
    expect(pre.matcher).toBe("*");
    expect(pre.hooks[0].type).toBe("command");
    expect(pre.hooks[0].command).toBe("/usr/local/bin/ib hooks agy-pre-tool-use agent-abc123");
    expect(pre.hooks[0].timeout).toBe(DEFAULT_AGY_HOOK_TIMEOUT_SECS);
  });

  test("PreInvocation and Stop are direct command entries pointing at their dispatchers", () => {
    const doc = JSON.parse(
      buildAgyHooksJson({ ibBinaryPath: "/opt/ib", agentId: "agent-xyz" }),
    );
    expect(doc.ittybitty.PreInvocation[0].command).toBe("/opt/ib hooks agy-pre-invocation agent-xyz");
    expect(doc.ittybitty.PreInvocation[0].type).toBe("command");
    expect(doc.ittybitty.Stop[0].command).toBe("/opt/ib hooks agy-stop agent-xyz");
    expect(doc.ittybitty.Stop[0].type).toBe("command");
  });

  test("honors a custom timeout", () => {
    const doc = JSON.parse(
      buildAgyHooksJson({ ibBinaryPath: "/opt/ib", agentId: "agent-xyz", timeoutSecs: 45 }),
    );
    expect(doc.ittybitty.PreToolUse[0].hooks[0].timeout).toBe(45);
    expect(doc.ittybitty.Stop[0].timeout).toBe(45);
  });

  test("throws on an unsafe ib binary path (apostrophe)", () => {
    expect(() =>
      buildAgyHooksJson({ ibBinaryPath: "/home/o'brien/ib", agentId: "agent-abc123" }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("throws on an invalid agent id", () => {
    expect(() =>
      buildAgyHooksJson({ ibBinaryPath: "/usr/local/bin/ib", agentId: "bad id with spaces" }),
    ).toThrow(/Invalid agent id/);
  });

  test("throws on a non-integer timeout", () => {
    expect(() =>
      buildAgyHooksJson({ ibBinaryPath: "/opt/ib", agentId: "agent-xyz", timeoutSecs: 0 }),
    ).toThrow(/Invalid agy hook timeout/);
  });
});

// ── AGY_WORKTREE_FILES ───────────────────────────────────────────────────────

describe("AGY_WORKTREE_FILES", () => {
  test("names the hooks.json and always-on rule file", () => {
    expect(AGY_WORKTREE_FILES).toEqual([
      ".agents/hooks.json",
      ".agents/rules/ittybitty-agent.md",
    ]);
  });
});

// ── buildAgyRulesFile ────────────────────────────────────────────────────────

describe("buildAgyRulesFile", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let worktree: string;

  function ctxFor(overrides: Partial<SessionContext> = {}): SessionContext {
    return {
      role: "worker",
      agentId: "agent-rules01",
      agentManager: "agent-mgr01",
      parentBranch: "main",
      branchName: "agent/agent-rules01",
      worktreePath: worktree,
      rootRepoPath: tempDir,
      agentType: "worker",
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-rules-test-"));
    originalHome = process.env.HOME;
    const fakeHome = join(tempDir, "home");
    await mkdir(join(fakeHome, ".itsybitsy"), { recursive: true });
    process.env.HOME = fakeHome;
    await (await import("./agent-types")).ensureAgentTypesDir();
    worktree = join(tempDir, "wt");
    await mkdir(worktree, { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("starts with the trigger: always_on frontmatter", async () => {
    const body = await buildAgyRulesFile(ctxFor());
    expect(body.startsWith("---\ntrigger: always_on\ndescription: itsybitsy agent instructions\n---\n")).toBe(true);
  });

  test("strips the <ittybitty> wrapper from the instruction body", async () => {
    const body = await buildAgyRulesFile(ctxFor());
    expect(body).not.toContain("<ittybitty>");
    expect(body).not.toContain("</ittybitty>");
  });

  test("interpolates the agent id from the template", async () => {
    const body = await buildAgyRulesFile(ctxFor());
    expect(body).toContain("agent-rules01");
  });

  test("INLINES the project CLAUDE.md verbatim (no @./CLAUDE.md import)", async () => {
    await Bun.write(join(worktree, "CLAUDE.md"), "# project rules\nUnique-project-marker-9271\n");
    const body = await buildAgyRulesFile(ctxFor());
    expect(body).toContain("Unique-project-marker-9271");
    // agy has no @file import — the project doc must be inlined, not referenced.
    expect(body).not.toContain("@./CLAUDE.md");
  });

  test("INLINES the user-global ~/.claude/CLAUDE.md when present", async () => {
    const userClaudeDir = join(process.env.HOME!, ".claude");
    await mkdir(userClaudeDir, { recursive: true });
    await Bun.write(join(userClaudeDir, "CLAUDE.md"), "Unique-user-marker-5502\n");
    const body = await buildAgyRulesFile(ctxFor());
    expect(body).toContain("Unique-user-marker-5502");
    expect(body).toContain("User-global CLAUDE.md");
  });

  test("inlines BOTH CLAUDE.md files together", async () => {
    await Bun.write(join(worktree, "CLAUDE.md"), "proj-marker-A\n");
    const userClaudeDir = join(process.env.HOME!, ".claude");
    await mkdir(userClaudeDir, { recursive: true });
    await Bun.write(join(userClaudeDir, "CLAUDE.md"), "user-marker-B\n");
    const body = await buildAgyRulesFile(ctxFor());
    expect(body).toContain("proj-marker-A");
    expect(body).toContain("user-marker-B");
  });
});

// ── appendGitignoreEntries ───────────────────────────────────────────────────

describe("appendGitignoreEntries", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agy-gitignore-test-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates .gitignore and appends both worktree files", async () => {
    const results = await appendGitignoreEntries(tempDir, AGY_WORKTREE_FILES);
    expect(results[".agents/hooks.json"]).toBe("appended");
    expect(results[".agents/rules/ittybitty-agent.md"]).toBe("appended");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain(".agents/hooks.json");
    expect(text).toContain(".agents/rules/ittybitty-agent.md");
  });

  test("is idempotent — a second call reports already-present and does not rewrite", async () => {
    await appendGitignoreEntries(tempDir, AGY_WORKTREE_FILES);
    const before = await Bun.file(join(tempDir, ".gitignore")).text();
    const results = await appendGitignoreEntries(tempDir, AGY_WORKTREE_FILES);
    expect(results[".agents/hooks.json"]).toBe("already-present");
    expect(results[".agents/rules/ittybitty-agent.md"]).toBe("already-present");
    const after = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(after).toBe(before);
  });

  test("respects an explicit negation for one entry while appending the other", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/\n!.agents/hooks.json\n");
    const results = await appendGitignoreEntries(tempDir, AGY_WORKTREE_FILES);
    expect(results[".agents/hooks.json"]).toBe("negation-respected");
    expect(results[".agents/rules/ittybitty-agent.md"]).toBe("appended");
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toContain("!.agents/hooks.json");
    expect(text).not.toContain("\n.agents/hooks.json\n");
    expect(text).toContain(".agents/rules/ittybitty-agent.md");
  });

  test("adds a leading newline when the existing file lacks a trailing one", async () => {
    await Bun.write(join(tempDir, ".gitignore"), "node_modules/");
    await appendGitignoreEntries(tempDir, [".agents/hooks.json"]);
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe("node_modules/\n.agents/hooks.json\n");
  });

  test("does not double-append a duplicate input entry", async () => {
    await appendGitignoreEntries(tempDir, [".codex/", ".codex/"]);
    // The second occurrence sees the first as already present in the batch, so
    // the file gets exactly one entry (the per-entry map only records the last
    // outcome for a repeated key, which is why we assert on file content here).
    const text = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(text).toBe(".codex/\n");
  });
});

// ── ensureAgyTrustedWorkspace / removeAgyTrustedWorkspace ─────────────────────

describe("agy trusted-workspace settings (temp HOME)", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "agy-trust-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await Bun.file(agySettingsPath()).text());
  }

  test("ensure creates the settings file with the worktree in trustedWorkspaces", async () => {
    const wt = "/private/tmp/wt-real";
    await ensureAgyTrustedWorkspace(wt);
    const settings = await readSettings();
    expect(settings.trustedWorkspaces).toEqual([wt]);
  });

  test("ensure is idempotent — a second call does not duplicate the entry", async () => {
    const wt = "/private/tmp/wt-real";
    await ensureAgyTrustedWorkspace(wt);
    await ensureAgyTrustedWorkspace(wt);
    const settings = await readSettings();
    expect(settings.trustedWorkspaces).toEqual([wt]);
  });

  test("ensure preserves all other keys and pre-existing trusted paths", async () => {
    await mkdir(join(tempHome, ".gemini", "antigravity-cli"), { recursive: true });
    await Bun.write(
      agySettingsPath(),
      JSON.stringify({
        altScreenMode: "auto",
        showFeedbackSurvey: true,
        trustedWorkspaces: ["/existing/path"],
        nested: { keep: 1 },
      }),
    );
    const wt = "/private/tmp/wt-real";
    await ensureAgyTrustedWorkspace(wt);
    const settings = await readSettings();
    expect(settings.altScreenMode).toBe("auto");
    expect(settings.showFeedbackSurvey).toBe(true);
    expect(settings.nested).toEqual({ keep: 1 });
    expect(settings.trustedWorkspaces).toEqual(["/existing/path", wt]);
  });

  test("remove takes only the given path out, preserving other keys and paths", async () => {
    await mkdir(join(tempHome, ".gemini", "antigravity-cli"), { recursive: true });
    await Bun.write(
      agySettingsPath(),
      JSON.stringify({
        keepKey: "value",
        trustedWorkspaces: ["/keep/me", "/private/tmp/wt-real"],
      }),
    );
    await removeAgyTrustedWorkspace("/private/tmp/wt-real");
    const settings = await readSettings();
    expect(settings.keepKey).toBe("value");
    expect(settings.trustedWorkspaces).toEqual(["/keep/me"]);
  });

  test("remove is a no-op when the settings file does not exist", async () => {
    await removeAgyTrustedWorkspace("/private/tmp/wt-real");
    expect(await Bun.file(agySettingsPath()).exists()).toBe(false);
  });

  test("ensure creates {} base then trustedWorkspaces when file is missing (no other keys invented)", async () => {
    await ensureAgyTrustedWorkspace("/w");
    const settings = await readSettings();
    expect(Object.keys(settings)).toEqual(["trustedWorkspaces"]);
  });

  // ── clobber protection (manager fix 3) ─────────────────────────────────────

  test("ensure THROWS on an existing unparseable settings file and leaves it untouched", async () => {
    await mkdir(join(tempHome, ".gemini", "antigravity-cli"), { recursive: true });
    const garbage = "{ this is not: json ]]]";
    await Bun.write(agySettingsPath(), garbage);
    await expect(ensureAgyTrustedWorkspace("/private/tmp/wt")).rejects.toThrow(/not valid JSON|refusing to overwrite/);
    // The user's file must be byte-for-byte untouched.
    expect(await Bun.file(agySettingsPath()).text()).toBe(garbage);
  });

  test("ensure THROWS when the existing settings file is a JSON array, not an object", async () => {
    await mkdir(join(tempHome, ".gemini", "antigravity-cli"), { recursive: true });
    const arr = "[1,2,3]";
    await Bun.write(agySettingsPath(), arr);
    await expect(ensureAgyTrustedWorkspace("/private/tmp/wt")).rejects.toThrow(/not a JSON object|refusing to overwrite/);
    expect(await Bun.file(agySettingsPath()).text()).toBe(arr);
  });

  test("ensure treats a genuinely empty file as {} (nothing to preserve)", async () => {
    await mkdir(join(tempHome, ".gemini", "antigravity-cli"), { recursive: true });
    await Bun.write(agySettingsPath(), "   \n");
    await ensureAgyTrustedWorkspace("/private/tmp/wt");
    const settings = await readSettings();
    expect(settings.trustedWorkspaces).toEqual(["/private/tmp/wt"]);
  });

  test("remove is a no-op (no throw) on an unparseable file and leaves it untouched", async () => {
    await mkdir(join(tempHome, ".gemini", "antigravity-cli"), { recursive: true });
    const garbage = "not json at all";
    await Bun.write(agySettingsPath(), garbage);
    // Must not throw.
    await removeAgyTrustedWorkspace("/private/tmp/wt");
    expect(await Bun.file(agySettingsPath()).text()).toBe(garbage);
  });
});
