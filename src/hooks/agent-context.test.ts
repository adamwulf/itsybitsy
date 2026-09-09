import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import {
  findNoWorktreeAgentsDir,
  resetBoundNoWorktreeCallerResolver,
  resetNoWorktreeRepoRootsLoader,
  resolveBoundHookAgent,
  setBoundNoWorktreeCallerResolver,
  setNoWorktreeRepoRootsLoader,
} from "./agent-context";

const temporaryRoots: string[] = [];

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "bound-hook-agent-"));
  temporaryRoots.push(repo);
  return repo;
}

async function writeAgent(
  repo: string,
  id: string,
  worktree: boolean,
): Promise<{ agentDir: string; worktreePath: string; meta: Record<string, unknown> }> {
  const agentDir = join(repo, ".ittybitty", "agents", id);
  const worktreePath = join(agentDir, "repo");
  const meta = { id, worktree, claude_pid: "123", claude_pid_epoch: 100 };
  await mkdir(worktreePath, { recursive: true });
  await Bun.write(join(agentDir, "meta.json"), JSON.stringify(meta));
  return { agentDir, worktreePath, meta };
}

afterEach(async () => {
  resetNoWorktreeRepoRootsLoader();
  resetBoundNoWorktreeCallerResolver();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("registered hook agent binding", () => {
  test("shared-repo identity follows the verified process, not a forged cwd", async () => {
    const repo = await makeRepo();
    const agent = await writeAgent(repo, "agent-real", false);
    setNoWorktreeRepoRootsLoader(async () => [repo]);
    setBoundNoWorktreeCallerResolver(async () => ({
      meta: agent.meta,
      agentDir: agent.agentDir,
      repoPath: repo,
    }));

    const bound = await resolveBoundHookAgent(
      "agent-real",
      join(repo, "fake", ".ittybitty", "agents", "agent-real", "repo"),
    );
    expect(bound.agentDir).toBe(await realpath(agent.agentDir));
    expect(bound.worktreePath).toBe(await realpath(repo));
  });

  test("agent A cannot claim registered agent B", async () => {
    const repo = await makeRepo();
    const agentA = await writeAgent(repo, "agent-a", false);
    await writeAgent(repo, "agent-b", false);
    setNoWorktreeRepoRootsLoader(async () => [repo]);
    setBoundNoWorktreeCallerResolver(async () => ({
      meta: agentA.meta,
      agentDir: agentA.agentDir,
      repoPath: repo,
    }));

    await expect(resolveBoundHookAgent("agent-b", repo)).rejects.toThrow("another agent");
  });

  test("a stolen legacy environment token supplies no hook authority", async () => {
    const repo = await makeRepo();
    await writeAgent(repo, "agent-b", false);
    setNoWorktreeRepoRootsLoader(async () => [repo]);
    setBoundNoWorktreeCallerResolver(async () => null);
    const previous = process.env.ITSYBITSY_HOOK_AUTH_TOKEN;
    process.env.ITSYBITSY_HOOK_AUTH_TOKEN = "a".repeat(64);
    try {
      await expect(resolveBoundHookAgent("agent-b", repo)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.ITSYBITSY_HOOK_AUTH_TOKEN;
      else process.env.ITSYBITSY_HOOK_AUTH_TOKEN = previous;
    }
  });

  test("registered worktree identity requires cwd membership", async () => {
    const repo = await makeRepo();
    const agent = await writeAgent(repo, "agent-worktree", true);
    setNoWorktreeRepoRootsLoader(async () => [repo]);

    await expect(resolveBoundHookAgent("agent-worktree", agent.worktreePath)).resolves.toMatchObject({
      agentDir: await realpath(agent.agentDir),
      worktreePath: await realpath(agent.worktreePath),
    });
    await expect(resolveBoundHookAgent("agent-worktree", repo)).rejects.toThrow("outside its worktree");
  });

  test("duplicate ids across registered repos bind to the matching worktree cwd", async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();
    await writeAgent(repoA, "agent-duplicate", true);
    const agentB = await writeAgent(repoB, "agent-duplicate", true);
    setNoWorktreeRepoRootsLoader(async () => [repoA, repoB]);

    await expect(resolveBoundHookAgent("agent-duplicate", agentB.worktreePath)).resolves.toMatchObject({
      agentDir: await realpath(agentB.agentDir),
      repoPath: await realpath(repoB),
    });
  });

  test("duplicate ids across registered repos bind to verified no-worktree process evidence", async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();
    await writeAgent(repoA, "agent-duplicate", false);
    const agentB = await writeAgent(repoB, "agent-duplicate", false);
    setNoWorktreeRepoRootsLoader(async () => [repoA, repoB]);
    setBoundNoWorktreeCallerResolver(async () => ({
      meta: agentB.meta,
      agentDir: agentB.agentDir,
      repoPath: repoB,
    }));

    await expect(resolveBoundHookAgent("agent-duplicate", repoB)).resolves.toMatchObject({
      agentDir: await realpath(agentB.agentDir),
      repoPath: await realpath(repoB),
    });
  });

  test("duplicate ids with no matching authenticated evidence fail closed", async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();
    await writeAgent(repoA, "agent-duplicate", false);
    await writeAgent(repoB, "agent-duplicate", false);
    setNoWorktreeRepoRootsLoader(async () => [repoA, repoB]);
    setBoundNoWorktreeCallerResolver(async () => null);

    await expect(resolveBoundHookAgent("agent-duplicate", await makeRepo())).rejects.toThrow();
  });

  test("an unregistered standalone same-id tree supplies no authority", async () => {
    const registeredRepo = await makeRepo();
    const fakeRepo = await makeRepo();
    const fake = await writeAgent(fakeRepo, "agent-fake", true);
    setNoWorktreeRepoRootsLoader(async () => [registeredRepo]);

    await expect(resolveBoundHookAgent("agent-fake", fake.worktreePath)).rejects.toThrow("no registered record");
  });

  test("the compatibility lookup uses registered roots, never cwd ancestry", async () => {
    const registeredRepo = await makeRepo();
    const registered = await writeAgent(registeredRepo, "agent-shared", false);
    const fakeRepo = await makeRepo();
    const fake = await writeAgent(fakeRepo, "agent-shared", false);
    setNoWorktreeRepoRootsLoader(async () => [registeredRepo]);

    await expect(findNoWorktreeAgentsDir("agent-shared", fake.worktreePath)).resolves.toBe(
      join(await realpath(registeredRepo), ".ittybitty", "agents"),
    );
    expect(fake.agentDir).not.toBe(registered.agentDir);
  });
});
