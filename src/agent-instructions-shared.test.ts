import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { missingAgentsMdWarning } from "./agent-instructions-shared";

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

    test("agy: .gemini/GEMINI.md suppresses the warning", async () => {
      await write("CLAUDE.md");
      await write(".gemini/GEMINI.md");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n4")).toBeNull();
    });

    test("agy: a repo-owned .agents/rules/*.md suppresses the warning", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/project.md");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n5")).toBeNull();
    });

    test("agy: itsybitsy's own rule file alone does not count (it holds only role text)", async () => {
      await write("CLAUDE.md");
      await write(".agents/rules/ittybitty-agent.md", "---\ntrigger: always_on\n---\nrole\n");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n6")).toContain("but no AGENTS.md (or GEMINI.md / an .agents/rules file)");
    });

    test("agy: AGENTS.override.md is NOT an agy file — still warns", async () => {
      await write("CLAUDE.md");
      await write("AGENTS.override.md");
      expect(await missingAgentsMdWarning(worktree, "agy", "agent-n7")).toContain("starts without");
    });
  });
});
