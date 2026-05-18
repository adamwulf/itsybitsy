import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, readdir } from "fs/promises";
import { tmpdir } from "os";
import {
  EMBEDDED_SLASH_COMMANDS,
  ensureSlashCommands,
  getGlobalClaudeCommandsDir,
} from "./slash-commands";

describe("slash-commands", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "slash-commands-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  test("EMBEDDED_SLASH_COMMANDS includes respawn and restart", () => {
    expect(Object.keys(EMBEDDED_SLASH_COMMANDS).sort()).toEqual(["respawn", "restart"]);
  });

  test("each embedded command has frontmatter with description", () => {
    for (const [name, content] of Object.entries(EMBEDDED_SLASH_COMMANDS)) {
      expect(content.startsWith("---")).toBe(true);
      expect(content).toContain("description:");
      // The respawn flow is the actionable instruction — both commands
      // should mention it so an agent reading either knows what to run.
      expect(content).toContain("ib respawn");
      // Sanity — guard against accidentally writing an empty file.
      expect(content.length).toBeGreaterThan(50);
      // Suppress unused-variable warning by referencing name in failure path
      void name;
    }
  });

  test("getGlobalClaudeCommandsDir honors HOME", () => {
    const dir = getGlobalClaudeCommandsDir();
    expect(dir).toBe(join(tempHome, ".claude", "commands"));
  });

  test("ensureSlashCommands writes both commands when none exist", async () => {
    const created = await ensureSlashCommands();
    expect(created.sort()).toEqual(["respawn.md", "restart.md"]);

    const dir = getGlobalClaudeCommandsDir();
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["respawn.md", "restart.md"]);

    // Content sanity
    const respawnContent = await Bun.file(join(dir, "respawn.md")).text();
    expect(respawnContent).toBe(EMBEDDED_SLASH_COMMANDS.respawn!);
    const restartContent = await Bun.file(join(dir, "restart.md")).text();
    expect(restartContent).toBe(EMBEDDED_SLASH_COMMANDS.restart!);
  });

  test("ensureSlashCommands is idempotent — repeat calls write nothing", async () => {
    await ensureSlashCommands();
    const second = await ensureSlashCommands();
    expect(second).toEqual([]);
  });

  test("ensureSlashCommands does NOT overwrite an existing file (preserves user edits)", async () => {
    const dir = getGlobalClaudeCommandsDir();
    await mkdir(dir, { recursive: true });
    const customBody = "---\ndescription: my customized respawn\n---\nmy stuff\n";
    await Bun.write(join(dir, "respawn.md"), customBody);

    // Only restart.md should be created; respawn.md is left alone
    const created = await ensureSlashCommands();
    expect(created).toEqual(["restart.md"]);

    const respawnContent = await Bun.file(join(dir, "respawn.md")).text();
    expect(respawnContent).toBe(customBody);
  });

  test("ensureSlashCommands creates the parent directory if missing", async () => {
    // tempHome exists but ~/.claude does not — ensureSlashCommands must mkdir -p.
    const created = await ensureSlashCommands();
    expect(created.length).toBe(2);
    const { stat } = await import("fs/promises");
    const dirStat = await stat(join(tempHome, ".claude", "commands"));
    expect(dirStat.isDirectory()).toBe(true);
  });
});
