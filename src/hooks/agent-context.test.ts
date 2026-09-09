import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import {
  findNoWorktreeAgentsDir,
  HOOK_AUTH_TOKEN_FILE,
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
  includePid = true,
): Promise<{ agentDir: string; worktreePath: string; meta: Record<string, unknown> }> {
  const agentDir = join(repo, ".ittybitty", "agents", id);
  const worktreePath = join(agentDir, "repo");
  const meta: Record<string, unknown> = { id, worktree };
  if (includePid) {
    meta.claude_pid = "123";
    meta.claude_pid_epoch = 100;
  }
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
  test("launch token authenticates SessionStart before pid metadata exists", async () => {
    const repo = await makeRepo();
    const agent = await writeAgent(repo, "agent-starting", false, false);
    const token = "a".repeat(64);
    await Bun.write(join(agent.agentDir, HOOK_AUTH_TOKEN_FILE), token);
    setNoWorktreeRepoRootsLoader(async () => [repo]);

    const bound = await resolveBoundHookAgent("agent-starting", repo, {
      hookAuthToken: token,
      noWorktreeCallerResolver: async () => {
        throw new Error("pid is not recorded yet");
      },
    });

    expect(bound.agentDir).toBe(await realpath(agent.agentDir));
    expect(bound.worktreePath).toBe(await realpath(repo));
  });

  test("one launch token cannot authenticate a sibling during shutdown", async () => {
    const repo = await makeRepo();
    const agentA = await writeAgent(repo, "agent-a", false);
    const agentB = await writeAgent(repo, "agent-b", false);
    const tokenA = "a".repeat(64);
    await Bun.write(join(agentA.agentDir, HOOK_AUTH_TOKEN_FILE), tokenA);
    await Bun.write(join(agentB.agentDir, HOOK_AUTH_TOKEN_FILE), "b".repeat(64));
    setNoWorktreeRepoRootsLoader(async () => [repo]);

    await expect(resolveBoundHookAgent("agent-a", repo, {
      hookAuthToken: tokenA,
      noWorktreeCallerResolver: async () => {
        throw new Error("claude is exiting");
      },
    })).resolves.toMatchObject({ agentDir: await realpath(agentA.agentDir) });
    await expect(resolveBoundHookAgent("agent-b", repo, {
      hookAuthToken: tokenA,
      noWorktreeCallerResolver: async () => {
        throw new Error("claude is exiting");
      },
    })).rejects.toThrow("claude is exiting");
  });

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
