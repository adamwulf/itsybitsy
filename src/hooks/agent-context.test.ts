import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "path";
import * as fsPromises from "fs/promises";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "fs/promises";
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

  test("an unreadable registered repo is skipped, not fatal to other repos' agents", async () => {
    // Mirrors a repo inside another app's ~/Library/Containers after a machine
    // migration: realpath on it fails with EPERM/EACCES, not ENOENT.
    const repo = await realpath(await makeRepo());
    const agent = await writeAgent(repo, "agent-worktree", true);
    const lockedParent = join(repo, "locked");
    const lockedRepo = join(lockedParent, "repo");
    await mkdir(lockedRepo, { recursive: true });
    await Bun.write(join(repo, "home", ".itsybitsy", "repos.json"), JSON.stringify({
      repos: [{ path: lockedRepo, name: "locked" }, { path: repo, name: "readable" }],
    }));
    await chmod(lockedParent, 0o000);
    try {
      await expect(
        resolveBoundHookAgent("agent-worktree", agent.worktreePath, { registryHome: join(repo, "home") }),
      ).resolves.toMatchObject({ agentDir: agent.agentDir, worktreePath: agent.worktreePath });
    } finally {
      await chmod(lockedParent, 0o755);
    }
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

// Inside an agent's kernel sandbox the agent may read its own agent dir (a
// runtime root) but not its repo root. realpath(repo root) used to fail there,
// so the hook found no record and denied every call. A repo root without read
// permission (search only) reproduces that for an unsandboxed test process.
describe("registered hook agent binding when the repo root is not readable", () => {
  async function registryFor(repoPaths: string[]): Promise<string> {
    const home = await makeRepo();
    await Bun.write(join(home, ".itsybitsy", "repos.json"), JSON.stringify({
      repos: repoPaths.map((path, index) => ({ path, name: `repo-${index}` })),
    }));
    return home;
  }

  async function withUnreadableRoot<T>(repo: string, run: () => Promise<T>): Promise<T> {
    await chmod(repo, 0o311);
    try {
      return await run();
    } finally {
      await chmod(repo, 0o755);
    }
  }

  test("a sandboxed worktree agent binds to its own agent (no deny-all)", async () => {
    const repo = await realpath(await makeRepo());
    const agent = await writeAgent(repo, "agent-worktree", true);
    await writeAgent(repo, "agent-sibling", true);
    const registryHome = await registryFor([repo]);
    const bound = await withUnreadableRoot(repo, () =>
      resolveBoundHookAgent("agent-worktree", agent.worktreePath, { registryHome }));
    expect(bound).toMatchObject({
      agentDir: agent.agentDir,
      agentsDir: join(repo, ".ittybitty", "agents"),
      repoPath: repo,
      worktreePath: agent.worktreePath,
    });
  });

  test("a sandboxed shared-repo agent binds through its verified process", async () => {
    const repo = await realpath(await makeRepo());
    const agent = await writeAgent(repo, "agent-shared", false);
    setBoundNoWorktreeCallerResolver(async () => ({ meta: agent.meta, agentDir: agent.agentDir, repoPath: repo }));
    const registryHome = await registryFor([repo]);
    const bound = await withUnreadableRoot(repo, () =>
      resolveBoundHookAgent("agent-shared", repo, { registryHome }));
    expect(bound).toMatchObject({ agentDir: agent.agentDir, repoPath: repo, worktreePath: repo });
  });

  // The OS below the real caller resolver: what `ps` reports and whether the
  // recorded CLI is alive. A native sandbox can deny ps, so the default suite
  // never observes real processes; IB_LIVE_CALLER=1 runs the search against them.
  const FIXTURE_CLI_PID = 4_000_001;
  const FIXTURE_CLI_START = "Wed Sep  9 12:00:00 2026";
  const FIXTURE_CLI_EPOCH = Date.parse(FIXTURE_CLI_START) / 1000;
  const processSpies: { mockRestore(): void }[] = [];

  afterEach(() => {
    for (const spy of processSpies.splice(0)) spy.mockRestore();
  });

  function observeFixtureProcesses(
    parentTable = `${process.pid} ${FIXTURE_CLI_PID}\n${FIXTURE_CLI_PID} 1\n`,
  ): string[][] {
    const psCalls: string[][] = [];
    const realSpawnSync = Bun.spawnSync;
    const realKill = process.kill;
    processSpies.push(
      spyOn(Bun, "spawnSync").mockImplementation(((args: string[], ...rest: unknown[]) => {
        if (args[0] !== "/bin/ps") return (realSpawnSync as (...a: unknown[]) => unknown).call(Bun, args, ...rest);
        psCalls.push(args);
        const stdout = args.includes("lstart=") ? FIXTURE_CLI_START : parentTable;
        return { exitCode: 0, stdout: Buffer.from(stdout) };
      }) as typeof Bun.spawnSync),
      spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) =>
        pid === FIXTURE_CLI_PID ? true : realKill.call(process, pid, signal)) as typeof process.kill),
    );
    return psCalls;
  }

  async function writeSharedAgent(repo: string, id: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const agentDir = join(repo, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id, worktree: false,
      claude_pid: String(FIXTURE_CLI_PID), claude_pid_epoch: FIXTURE_CLI_EPOCH,
      sandbox: { enabled: true, rawAllow: [], domains: [] },
      ...overrides,
    }));
    return agentDir;
  }

  // The real caller resolver (process ancestry through ps), not a mock. Inside
  // the sandbox it must search only the repo of the record already found: no
  // other registered repo is readable there, and each realpath of one is a
  // kernel denial.
  test("a sandboxed shared-repo agent binds through the real caller resolver, touching no other repo", async () => {
    const psCalls = observeFixtureProcesses();
    await expectSearchFollowsSandboxPolicy(FIXTURE_CLI_PID, FIXTURE_CLI_EPOCH);
    // Each bind checks ancestry and identity twice; the observations were used.
    expect(psCalls.filter((args) => args.includes("pid=,ppid="))).toHaveLength(4);
    expect(psCalls.filter((args) => args.includes("lstart="))).toHaveLength(4);
  });

  test.skipIf(process.env.IB_LIVE_CALLER !== "1")("LIVE: the same search through actual OS process ancestry", async () => {
    const lstart = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(process.pid)], {
      env: { LC_ALL: "C", LC_TIME: "C" },
    }).stdout.toString().trim();
    await expectSearchFollowsSandboxPolicy(process.pid, Date.parse(lstart) / 1000);
  });

  test("a process that descends from no recorded CLI is not bound to the record", async () => {
    const repo = await realpath(await makeRepo());
    await writeSharedAgent(repo, "agent-shared");
    const registryHome = await registryFor([repo]);
    const psCalls = observeFixtureProcesses(`${process.pid} 1\n`);
    await expect(resolveBoundHookAgent("agent-shared", repo, { registryHome }))
      .rejects.toThrow("cwd is outside its worktree");
    expect(psCalls.filter((args) => args.includes("lstart="))).toEqual([]);
  });

  test("a recorded CLI whose start time differs is a stale identity, not the agent", async () => {
    const repo = await realpath(await makeRepo());
    await writeSharedAgent(repo, "agent-shared", { claude_pid_epoch: FIXTURE_CLI_EPOCH - 86_400 });
    const registryHome = await registryFor([repo]);
    observeFixtureProcesses();
    await expect(resolveBoundHookAgent("agent-shared", repo, { registryHome }))
      .rejects.toThrow("process identity");
  });

  test("a verified process cannot claim another shared-repo agent", async () => {
    const repo = await realpath(await makeRepo());
    await writeSharedAgent(repo, "agent-a");
    await writeSharedAgent(repo, "agent-b", { claude_pid: String(FIXTURE_CLI_PID + 1) });
    const registryHome = await registryFor([repo]);
    observeFixtureProcesses();
    await expect(resolveBoundHookAgent("agent-b", repo, { registryHome }))
      .rejects.toThrow("process belongs to another agent");
    await expect(resolveBoundHookAgent("agent-a", repo, { registryHome }))
      .resolves.toMatchObject({ agentDir: join(repo, ".ittybitty", "agents", "agent-a"), repoPath: repo });
  });

  /** Enabled metadata searches only the candidate's repo; disabled, every registered repo. */
  async function expectSearchFollowsSandboxPolicy(claudePid: number, claudeEpoch: number): Promise<void> {
    const repo = await realpath(await makeRepo());
    const other = await realpath(await makeRepo());
    const writeMeta = (sandboxEnabled: boolean) => writeSharedAgent(repo, "agent-shared", {
      claude_pid: String(claudePid), claude_pid_epoch: claudeEpoch,
      sandbox: { enabled: sandboxEnabled, rawAllow: [], domains: [] },
    });
    const agentDir = join(repo, ".ittybitty", "agents", "agent-shared");
    const registryHome = await registryFor([other, repo]);
    const touched: string[] = [];
    const realRealpath = fsPromises.realpath;
    const realReaddir = fsPromises.readdir;
    const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation(((path: string, ...rest: unknown[]) => {
      touched.push(String(path));
      return (realRealpath as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fsPromises.realpath);
    const readdirSpy = spyOn(fsPromises, "readdir").mockImplementation(((path: string, ...rest: unknown[]) => {
      touched.push(String(path));
      return (realReaddir as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fsPromises.readdir);
    try {
      await writeMeta(true);
      const bound = await resolveBoundHookAgent("agent-shared", repo, { registryHome });
      expect(bound).toMatchObject({ agentDir, repoPath: repo, worktreePath: repo });
      // Only the candidate lookup's own agent dir path in the other repo (it
      // does not exist: ENOENT comes before any access check, no denial); never
      // its root nor its agents dir.
      expect(touched.filter((path) => path === other || path.startsWith(`${other}/`)))
        .toEqual([join(other, ".ittybitty", "agents", "agent-shared")]);
      // With the agent's kernel sandbox off the search is unchanged: every
      // registered repo.
      await writeMeta(false);
      touched.length = 0;
      await expect(resolveBoundHookAgent("agent-shared", repo, { registryHome }))
        .resolves.toMatchObject({ agentDir, repoPath: repo });
      expect(touched).toContain(other);
    } finally {
      realpathSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  }

  test("a path or id that belongs to no registered agent still resolves to none", async () => {
    const repo = await realpath(await makeRepo());
    const agent = await writeAgent(repo, "agent-worktree", true);
    const fakeRepo = await makeRepo();
    const fake = await writeAgent(fakeRepo, "agent-fake", true);
    const registryHome = await registryFor([repo]);
    await withUnreadableRoot(repo, async () => {
      // The repo root itself cannot even be resolved as a cwd.
      await expect(resolveBoundHookAgent("agent-worktree", repo, { registryHome }))
        .rejects.toThrow("invalid worktree context");
      await expect(resolveBoundHookAgent("agent-worktree", join(agent.agentDir, "outbox"), { registryHome }))
        .rejects.toThrow();
      await expect(resolveBoundHookAgent("agent-worktree", fake.worktreePath, { registryHome }))
        .rejects.toThrow("outside its worktree");
      await expect(resolveBoundHookAgent("agent-fake", fake.worktreePath, { registryHome }))
        .rejects.toThrow("no registered record");
      await expect(resolveBoundHookAgent("agent-missing", agent.worktreePath, { registryHome }))
        .rejects.toThrow("no registered record");
    });
  });
});

describe("registered hook agent binding for an unsandboxed caller is unchanged", () => {
  test("a repo registered through a symlink binds to realpath(repo root) paths", async () => {
    const repo = await realpath(await makeRepo());
    const agent = await writeAgent(repo, "agent-worktree", true);
    const links = await realpath(await makeRepo());
    await symlink(repo, join(links, "repo-link"));
    // The same repo under two spellings is still ONE candidate.
    setNoWorktreeRepoRootsLoader(async () => [join(links, "repo-link"), repo]);
    await expect(resolveBoundHookAgent("agent-worktree", join(links, "repo-link", ".ittybitty", "agents", "agent-worktree", "repo")))
      .resolves.toMatchObject({
        agentDir: agent.agentDir,
        agentsDir: join(repo, ".ittybitty", "agents"),
        repoPath: repo,
        worktreePath: agent.worktreePath,
      });
  });

  test("a repo registered in a different letter case binds to the on-disk spelling", async () => {
    const repo = await realpath(await makeRepo());
    const agent = await writeAgent(repo, "agent-worktree", true);
    const miscased = repo.replace(/bound-hook-agent-/, "BOUND-HOOK-AGENT-");
    if (!(await Bun.file(join(miscased, ".ittybitty", "agents", "agent-worktree", "meta.json")).exists())) {
      return; // case-sensitive volume: the miscased root is a different path
    }
    setNoWorktreeRepoRootsLoader(async () => [miscased]);
    await expect(resolveBoundHookAgent("agent-worktree", agent.worktreePath)).resolves.toMatchObject({
      agentDir: agent.agentDir,
      repoPath: repo,
    });
  });

  test("a symlinked .ittybitty keeps the realpath(repo root) paths, as before", async () => {
    const repo = await realpath(await makeRepo());
    const elsewhere = await realpath(await makeRepo());
    const real = await writeAgent(elsewhere, "agent-worktree", true);
    await symlink(join(elsewhere, ".ittybitty"), join(repo, ".ittybitty"));
    setNoWorktreeRepoRootsLoader(async () => [repo]);
    await expect(resolveBoundHookAgent("agent-worktree", real.worktreePath)).resolves.toMatchObject({
      agentDir: join(repo, ".ittybitty", "agents", "agent-worktree"),
      agentsDir: join(repo, ".ittybitty", "agents"),
      repoPath: repo,
      worktreePath: real.worktreePath,
    });
  });
});
