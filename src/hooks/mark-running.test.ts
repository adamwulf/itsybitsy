import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, rm, readFile } from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";

/**
 * Per-process itsybitsy home for the whole file.
 *
 * `hookMarkRunning` resolves its identity through `resolveAgentFromCwd`, whose
 * first branch stats `$HOME/.itsybitsy` to decide whether the cwd belongs to the
 * system coordinator. These tests chdir into a temp worktree so that branch does
 * not match and nothing is written — but the check still reads the developer's
 * real home, which is a machine dependency this file has no reason to carry, and
 * it is one production edit away from becoming a write. Pointing HOME at a
 * per-process temp dir removes the dependency outright.
 *
 * `setCoordinatorHome` is set alongside HOME so the two resolvers cannot
 * disagree: `coordinator.ts` honors the override while `hooks/shared.ts`
 * deliberately does not, and reads only `process.env.HOME`.
 */
let testHome: string;
let realHome: string | undefined;

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "ib-mark-running-home-"));
  realHome = process.env.HOME;
  process.env.HOME = testHome;
  setCoordinatorHome(join(testHome, ".itsybitsy"));
});

afterAll(() => {
  resetCoordinatorHome();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe("hookMarkRunning", () => {
  let tempDir: string;
  let agentDir: string;
  let worktreeCwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "mark-running-test-"));
    const agentId = "agent-test1234";
    agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    worktreeCwd = join(agentDir, "repo");
    await mkdir(worktreeCwd, { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes state='running' when current state is 'waiting'", async () => {
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ state: "waiting" }),
    );
    process.chdir(worktreeCwd);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning();

    const meta = JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
  });

  test("no-op when meta.json is missing", async () => {
    process.chdir(worktreeCwd);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning();

    const exists = await Bun.file(join(agentDir, "meta.json")).exists();
    expect(exists).toBe(false);
  });

  test("guard: keeps state='complete' (does not resurrect terminal state)", async () => {
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ state: "complete" }),
    );
    process.chdir(worktreeCwd);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning();

    const meta = JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("complete");
  });

  test("guard: keeps state='stopped' (does not resurrect terminal state)", async () => {
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ state: "stopped" }),
    );
    process.chdir(worktreeCwd);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning();

    const meta = JSON.parse(await readFile(join(agentDir, "meta.json"), "utf-8"));
    expect(meta.state).toBe("stopped");
  });
});
