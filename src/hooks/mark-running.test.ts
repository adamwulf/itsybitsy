import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, rm, readFile } from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { setUserHome, resetUserHome } from "../home";
import {
  resetBoundNoWorktreeCallerResolver,
  resetNoWorktreeRepoRootsLoader,
  setBoundNoWorktreeCallerResolver,
  setNoWorktreeRepoRootsLoader,
} from "./agent-context";

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
 * `setCoordinatorHome` is set alongside the user-home seam so the two resolvers cannot
 * disagree: `coordinator.ts` honors the override while `hooks/shared.ts`
 * resolves through `userHome()`.
 */
let testHome: string;

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "ib-mark-running-home-"));
  setUserHome(testHome);
  setCoordinatorHome(join(testHome, ".itsybitsy"));
});

afterAll(() => {
  resetCoordinatorHome();
  resetUserHome();
  rmSync(testHome, { recursive: true, force: true });
});

describe("hookMarkRunning", () => {
  let tempDir: string;
  let agentDir: string;
  let agentId: string;
  let worktreeCwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "mark-running-test-"));
    agentId = "agent-test1234";
    agentDir = join(tempDir, ".ittybitty", "agents", agentId);
    worktreeCwd = join(agentDir, "repo");
    await mkdir(worktreeCwd, { recursive: true });
    setNoWorktreeRepoRootsLoader(async () => [tempDir]);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    resetBoundNoWorktreeCallerResolver();
    resetNoWorktreeRepoRootsLoader();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes state='running' when current state is 'waiting'", async () => {
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({ id: agentId, worktree: true, state: "waiting" }),
    );
    process.chdir(worktreeCwd);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning(agentId);

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

  test.each([".", "packages/app"])(
    "worktree:false explicit identity writes running from %s",
    async (relativeCwd) => {
      const sharedRoot = await mkdtemp(join(tmpdir(), "mark-running-no-worktree-"));
      try {
        const noWorktreeId = "agent-shared123";
        const noWorktreeDir = join(sharedRoot, ".ittybitty", "agents", noWorktreeId);
        const cwd = relativeCwd === "." ? sharedRoot : join(sharedRoot, relativeCwd);
        await mkdir(cwd, { recursive: true });
        await mkdir(noWorktreeDir, { recursive: true });
        await Bun.write(
          join(noWorktreeDir, "meta.json"),
          JSON.stringify({ id: noWorktreeId, worktree: false, state: "waiting" }),
        );
        setNoWorktreeRepoRootsLoader(async () => [sharedRoot]);
        setBoundNoWorktreeCallerResolver(async () => ({
          meta: { id: noWorktreeId, worktree: false },
          agentDir: noWorktreeDir,
          repoPath: sharedRoot,
        }));
        process.chdir(cwd);

        const { hookMarkRunning } = await import("./mark-running");
        await hookMarkRunning(noWorktreeId);

        const meta = JSON.parse(await readFile(join(noWorktreeDir, "meta.json"), "utf-8"));
        expect(meta.state).toBe("running");
      } finally {
        process.chdir(originalCwd);
        await rm(sharedRoot, { recursive: true, force: true });
      }
    },
  );

  test("existing system-coordinator identity remains supported with the @system sentinel", async () => {
    const coordHome = join(testHome, ".itsybitsy");
    await mkdir(coordHome, { recursive: true });
    await Bun.write(join(coordHome, "meta.json"), JSON.stringify({ state: "waiting" }));
    process.chdir(coordHome);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning("@system");

    const meta = JSON.parse(await readFile(join(coordHome, "meta.json"), "utf-8"));
    expect(meta.state).toBe("running");
    await rm(join(coordHome, "meta.json"), { force: true });
  });

  test("registered no-worktree identity wins over a standalone fake cwd and cannot mutate a sibling", async () => {
    const callerId = "agent-markcaller1";
    const siblingId = "agent-marksibling1";
    const callerDir = join(tempDir, ".ittybitty", "agents", callerId);
    const siblingDir = join(tempDir, ".ittybitty", "agents", siblingId);
    const fakeRoot = await mkdtemp(join(tmpdir(), "mark-running-fake-"));
    try {
      const fakeDir = join(fakeRoot, ".ittybitty", "agents", siblingId);
      const fakeCwd = join(fakeDir, "repo");
      await mkdir(callerDir, { recursive: true });
      await mkdir(siblingDir, { recursive: true });
      await mkdir(fakeCwd, { recursive: true });
      await Bun.write(join(callerDir, "meta.json"), JSON.stringify({ id: callerId, worktree: false, state: "waiting" }));
      await Bun.write(join(siblingDir, "meta.json"), JSON.stringify({ id: siblingId, worktree: false, state: "waiting" }));
      await Bun.write(join(fakeDir, "meta.json"), JSON.stringify({ id: siblingId, worktree: true, state: "running" }));
      setBoundNoWorktreeCallerResolver(async () => ({
        meta: { id: callerId, worktree: false },
        agentDir: callerDir,
        repoPath: tempDir,
      }));
      process.chdir(fakeCwd);

      const { hookMarkRunning } = await import("./mark-running");
      await hookMarkRunning(callerId);
      await hookMarkRunning(siblingId);

      expect(JSON.parse(await readFile(join(callerDir, "meta.json"), "utf-8")).state).toBe("running");
      expect(JSON.parse(await readFile(join(siblingDir, "meta.json"), "utf-8")).state).toBe("waiting");
      expect(JSON.parse(await readFile(join(fakeDir, "meta.json"), "utf-8")).state).toBe("running");
    } finally {
      process.chdir(originalCwd);
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  test("unvalidated explicit identity remains a no-op", async () => {
    process.chdir(tempDir);

    const { hookMarkRunning } = await import("./mark-running");
    await hookMarkRunning("agent-missing123");

    expect(await Bun.file(join(tempDir, ".ittybitty", "agents", "agent-missing123", "meta.json")).exists()).toBe(false);
  });
});
