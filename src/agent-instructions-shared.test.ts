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

  test("warns when the repo has CLAUDE.md but no AGENTS.md", async () => {
    await Bun.write(join(worktree, "CLAUDE.md"), "rules\n");
    const warning = await missingAgentsMdWarning(worktree, "codex", "agent-w1");
    expect(warning).toContain("codex agent 'agent-w1' starts without the project instructions");
    expect(warning).toContain("codex does not read CLAUDE.md");
    expect(warning).toContain("git mv CLAUDE.md AGENTS.md");
  });

  test("warns for .claude/CLAUDE.md too, naming that path", async () => {
    await mkdir(join(worktree, ".claude"), { recursive: true });
    await Bun.write(join(worktree, ".claude", "CLAUDE.md"), "rules\n");
    const warning = await missingAgentsMdWarning(worktree, "agy", "agent-w2");
    expect(warning).toContain("agy agent 'agent-w2'");
    expect(warning).toContain(`git mv ${join(".claude", "CLAUDE.md")} AGENTS.md`);
  });

  test("no warning when AGENTS.md exists, even beside CLAUDE.md", async () => {
    await Bun.write(join(worktree, "CLAUDE.md"), "legacy\n");
    await Bun.write(join(worktree, "AGENTS.md"), "rules\n");
    expect(await missingAgentsMdWarning(worktree, "codex", "agent-w3")).toBeNull();
  });

  test("a symlinked AGENTS.md counts as present", async () => {
    await Bun.write(join(worktree, "CLAUDE.md"), "rules\n");
    await symlink("CLAUDE.md", join(worktree, "AGENTS.md"));
    expect(await missingAgentsMdWarning(worktree, "codex", "agent-w4")).toBeNull();
  });

  test("no warning when the repo has no instruction file at all", async () => {
    expect(await missingAgentsMdWarning(worktree, "codex", "agent-w5")).toBeNull();
  });
});
