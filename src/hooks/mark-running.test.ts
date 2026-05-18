import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";

describe("hookMarkRunning", () => {
  let tempDir: string;
  let repoRoot: string;
  let agentId: string;
  let agentDir: string;
  let worktreeCwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "mark-running-test-"));
    repoRoot = tempDir;
    agentId = "agent-test1234";
    agentDir = join(repoRoot, ".ittybitty", "agents", agentId);
    worktreeCwd = join(agentDir, "repo");
    await mkdir(worktreeCwd, { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes state='running' to meta.json", async () => {
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ agentId, state: "waiting" }),
    );
    process.chdir(worktreeCwd);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning();

    const meta = JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
  });

  test("is a no-op when meta.json is missing", async () => {
    process.chdir(worktreeCwd);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning();

    const exists = await Bun.file(join(agentDir, "meta.json")).exists();
    expect(exists).toBe(false);
  });
});
