import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isAlwaysOnAgyRule, missingAgentsMdWarning } from "./agent-instructions-shared";

describe("isAlwaysOnAgyRule", () => {
  test("reads only the leading frontmatter's trigger", () => {
    expect(isAlwaysOnAgyRule("---\ntrigger: always_on\n---\nbody\n")).toBe(true);
    expect(isAlwaysOnAgyRule("---\r\ntrigger: always_on\r\n---\r\nbody\r\n")).toBe(true);
    expect(isAlwaysOnAgyRule("---\ntrigger: 'always_on' # comment\n---\n")).toBe(true);
    expect(isAlwaysOnAgyRule("---\ntrigger: model_decision\n---\n")).toBe(false);
    expect(isAlwaysOnAgyRule("---\ntrigger: always_on_later\n---\n")).toBe(false);
    expect(isAlwaysOnAgyRule("body\n---\ntrigger: always_on\n---\n")).toBe(false);
    expect(isAlwaysOnAgyRule("---\ndescription: x\n---\ntrigger: always_on\n")).toBe(false);
    expect(isAlwaysOnAgyRule("")).toBe(false);
  });
});

describe("missingAgentsMdWarning", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "agents-md-warning-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  async function write(relPath: string, text = "rules\n"): Promise<void> {
    const parts = relPath.split("/");
    if (parts.length > 1) await mkdir(join(worktree, ...parts.slice(0, -1)), { recursive: true });
    await Bun.write(join(worktree, ...parts), text);
  }

  test("warns when the repo has CLAUDE.md but no AGENTS.md", async () => {
    await write("CLAUDE.md");
    const warning = await missingAgentsMdWarning(worktree, "codex", "agent-w1");
    expect(warning).toContain("codex agent 'agent-w1' starts without the project instructions");
    expect(warning).toContain("but no AGENTS.md (or AGENTS.override.md)");
    expect(warning).toContain("codex does not read CLAUDE.md by default");
    expect(warning).toContain("git mv CLAUDE.md AGENTS.md");
  });

  test("warns for .claude/CLAUDE.md too, naming that path", async () => {
    await write(".claude/CLAUDE.md");
    const warning = await missingAgentsMdWarning(worktree, "agy", "agent-w2");
    expect(warning).toContain("agy agent 'agent-w2'");
    expect(warning).toContain("agy does not read CLAUDE.md by default");
    expect(warning).toContain(`git mv ${join(".claude", "CLAUDE.md")} AGENTS.md`);
  });

  test("no warning when AGENTS.md exists, even beside CLAUDE.md", async () => {
    await write("CLAUDE.md", "legacy\n");
    await write("AGENTS.md");
    expect(await missingAgentsMdWarning(worktree, "codex", "agent-w3")).toBeNull();
    expect(await missingAgentsMdWarning(worktree, "agy", "agent-w3")).toBeNull();
  });

  test("a symlinked AGENTS.md counts as present", async () => {
    await write("CLAUDE.md");
    await symlink("CLAUDE.md", join(worktree, "AGENTS.md"));
    expect(await missingAgentsMdWarning(worktree, "codex", "agent-w4")).toBeNull();
  });

  test("no warning when the repo has no instruction file at all", async () => {
    expect(await missingAgentsMdWarning(worktree, "codex", "agent-w5")).toBeNull();
  });

  describe("native alternatives per CLI", () => {
    test("codex (and codex-backed fugu): AGENTS.override.md suppresses the warning", async () => {
      await write("CLAUDE.md");
      await write("AGENTS.override.md");
      expect(await missingAgentsMdWarning(worktree, "codex", "agent-n1")).toBeNull();
      expect(await missingAgentsMdWarning(worktree, "fugu", "agent-n1")).toBeNull();
    });

    test("codex: GEMINI.md is NOT a codex file — still warns", async () => {
      await write("CLAUDE.md");
      await write("GEMINI.md");
      expect(await missingAgentsMdWarning(worktree, "codex", "agent-n2")).toContain("starts without");
    });

    test("agy: GEMINI.md suppresses the warning", async () => {
      await write("CLAUDE.md");
      await write("GEMINI.md");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n3")).toBeNull();
    });

    test("agy: .gemini/GEMINI.md is NOT a directory rule — still warns", async () => {
      // agy's docs list only root GEMINI.md / AGENTS.md as directory rules;
      // .gemini/ holds Gemini CLI settings, not rules.
      await write("CLAUDE.md");
      await write(".gemini/GEMINI.md");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n4")).toContain("starts without");
    });

    const ALWAYS_ON = "---\ntrigger: always_on\ndescription: project rules\n---\nrules\n";

    test("agy: a repo-owned .agents/rules/*.md with trigger: always_on suppresses the warning", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md", ALWAYS_ON);
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n5")).toBeNull();
    });

    test("agy: an always-on rule under each alias root (.agent/, _agents/, _agent/) suppresses the warning", async () => {
      for (const root of [".agent", "_agents", "_agent"]) {
        const dir = await mkdtemp(join(tmpdir(), "agents-md-alias-"));
        try {
          await Bun.write(join(dir, "CLAUDE.md"), "rules\n");
          await mkdir(join(dir, root, "rules"), { recursive: true });
          await Bun.write(join(dir, root, "rules", "project.md"), ALWAYS_ON);
          expect(await missingAgentsMdWarning(dir, "agy", "agent-alias")).toBeNull();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    });

    test("agy: a quoted trigger value counts", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md", "---\ntrigger: \"always_on\"\n---\nrules\n");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n5q")).toBeNull();
    });

    test("agy: a rule file with NO frontmatter still warns (agy ignores it)", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md", "rules\n");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n8")).toContain("starts without");
    });

    test("agy: a trigger: model_decision rule still warns (loaded only on demand)", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md", "---\ntrigger: model_decision\ndescription: x\n---\nrules\n");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n9")).toContain("starts without");
    });

    test("agy: frontmatter without a trigger still warns", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md", "---\ndescription: x\n---\nrules\n");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n10")).toContain("starts without");
    });

    test("agy: 'trigger: always_on' in the BODY (not frontmatter) still warns", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md", "# Rules\n\ntrigger: always_on\n");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n11")).toContain("starts without");
    });

    test("agy: itsybitsy's own rule file alone does not count (it holds only role text)", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/ittybitty-agent.md", "---\ntrigger: always_on\n---\nrole\n");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n6")).toContain("but no AGENTS.md (or GEMINI.md / an always-on .agents/rules file)");
    });

    test("codex: an always-on agy rule is NOT a codex file — still warns", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md", ALWAYS_ON);
      expect(await missingAgentsMdWarning(worktree, "codex", "agent-n12")).toContain("starts without");
    });

    test("agy: AGENTS.override.md is NOT an agy file — still warns", async () => {
      await write("CLAUDE.md");
      await write("AGENTS.override.md");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n7")).toContain("starts without");
    });
  });
});
