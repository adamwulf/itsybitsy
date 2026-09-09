import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { resolveNoWorktreeCaller } from "./no-worktree-caller";

describe("trusted no-worktree caller attribution", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "ib-caller-")));
    await Bun.write(join(repo, "home", ".itsybitsy", "repos.json"), JSON.stringify({ repos: [{ path: repo, name: "test" }] }));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function record(root = repo, id = "manager", overrides: Record<string, unknown> = {}) {
    const dir = join(root, ".ittybitty", "agents", id);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "meta.json"), JSON.stringify({
      id, worktree: false, claude_pid: "300", claude_pid_epoch: 12345,
      canSpawnChildren: true, ...overrides,
    }));
    return dir;
  }

  const parents = () => new Map([[500, 400], [400, 300], [300, 1]]);
  const deps = () => ({ registryHome: join(repo, "home"), pid: 500, readParents: parents, identityCurrent: () => true });

  async function worktree(root = repo, id = "worktree-manager", overrides: Record<string, unknown> = {}) {
    const agentDir = await record(root, id, { worktree: true, ...overrides });
    const cwd = join(agentDir, "repo");
    const gitDir = join(root, ".git", "worktrees", id);
    await mkdir(cwd, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await Bun.write(join(cwd, ".git"), `gitdir: ${gitDir}\n`);
    await Bun.write(join(gitDir, "gitdir"), `${join(cwd, ".git")}\n`);
    return { cwd, gitDir };
  }

  test.each([true, false])("registered worktree skips ps despite unrelated no-worktree records (canSpawnChildren=%s)", async (canSpawnChildren) => {
    await record(repo, "unrelated-shared-agent");
    const { cwd } = await worktree(repo, "worktree-agent", { canSpawnChildren });
    const nestedCwd = join(cwd, "src", "nested");
    await mkdir(nestedCwd, { recursive: true });
    expect(await resolveNoWorktreeCaller(nestedCwd, {
      ...deps(),
      readParents: () => { throw new Error("EPERM: posix_spawn /bin/ps"); },
      identityCurrent: () => { throw new Error("must not inspect processes"); },
    })).toBeNull();
    // null delegates to the ordinary worktree metadata/canSpawnChildren gate;
    // it does not grant spawn permission to a worker.
  });

  test("a worktree-shaped directory without Git registration still resolves the shared leaf", async () => {
    await record(repo, "leaf", { canSpawnChildren: false });
    const dir = await record(repo, "fake-worktree", { worktree: true });
    await mkdir(join(dir, "repo"), { recursive: true });
    expect((await resolveNoWorktreeCaller(join(dir, "repo"), deps()))?.meta.id).toBe("leaf");
  });

  test("a Git worktree in an unregistered repository cannot skip caller verification", async () => {
    await record(repo, "leaf", { canSpawnChildren: false });
    const { cwd } = await worktree(join(repo, "unregistered"));
    expect((await resolveNoWorktreeCaller(cwd, deps()))?.meta.id).toBe("leaf");
  });

  test("a mismatched Git backlink cannot skip caller verification", async () => {
    await record(repo, "leaf", { canSpawnChildren: false });
    const { cwd, gitDir } = await worktree();
    await Bun.write(join(gitDir, "gitdir"), `${join(repo, "other", ".git")}\n`);
    expect((await resolveNoWorktreeCaller(cwd, deps()))?.meta.id).toBe("leaf");
  });

  test("worktree:false metadata cannot use the worktree shortcut", async () => {
    const { cwd } = await worktree(repo, "shared-leaf", { worktree: false, canSpawnChildren: false });
    expect((await resolveNoWorktreeCaller(cwd, deps()))?.meta.id).toBe("shared-leaf");
  });

  test("matches live process ancestry from a nested shared-repo cwd", async () => {
    const dir = await record();
    const cwd = join(repo, "packages", "app");
    await mkdir(cwd, { recursive: true });
    const checks: number[] = [];
    const caller = await resolveNoWorktreeCaller(cwd, {
      ...deps(), identityCurrent: (pid, epoch) => { checks.push(pid); return epoch === 12345; },
    });
    expect(caller?.agentDir).toBe(dir);
    expect(caller?.repoPath).toBe(repo);
    expect(caller?.meta.id).toBe("manager");
    expect(checks).toEqual([300, 300]);
  });

  test("returns leaf metadata so the caller gate can deny spawning", async () => {
    await record(repo, "leaf", { canSpawnChildren: false });
    expect((await resolveNoWorktreeCaller(repo, deps()))?.meta.canSpawnChildren).toBe(false);
  });

  test("a human in the same repository is not attributed to its running manager", async () => {
    await record(repo, "manager", { claude_pid: "900" });
    expect(await resolveNoWorktreeCaller(repo, deps())).toBeNull();
  });

  test("does not inspect processes when there are no no-worktree records", async () => {
    await record(repo, "ordinary", { worktree: true });
    expect(await resolveNoWorktreeCaller(repo, {
      ...deps(), readParents: () => { throw new Error("must not read processes"); },
    })).toBeNull();
  });

  test("unregistered nested policy cannot choose a different identity for the same process", async () => {
    await record();
    const nested = join(repo, "nested");
    await record(nested, "forged", { canSpawnChildren: true });
    expect((await resolveNoWorktreeCaller(nested, deps()))?.meta.id).toBe("manager");
  });

  test("a sole forged record in an arbitrary cwd cannot grant caller authority", async () => {
    const unregistered = join(repo, "fake");
    await record(unregistered, "forged", { canSpawnChildren: true });
    expect(await resolveNoWorktreeCaller(unregistered, deps())).toBeNull();
  });

  test("leaving the real repo for a forged cwd still resolves the registered leaf", async () => {
    const registered = join(repo, "registered");
    const fake = join(repo, "fake");
    await record(registered, "leaf", { canSpawnChildren: false });
    await record(fake, "forged", { canSpawnChildren: true });
    await Bun.write(join(repo, "home", ".itsybitsy", "repos.json"), JSON.stringify({ repos: [{ path: registered }] }));
    const caller = await resolveNoWorktreeCaller(fake, deps());
    expect(caller?.meta.id).toBe("leaf");
    expect(caller?.meta.canSpawnChildren).toBe(false);
  });

  test("ambiguous registered metadata cannot select a permissive caller", async () => {
    await record(repo, "leaf", { canSpawnChildren: false });
    await record(repo, "manager", { canSpawnChildren: true });
    await expect(resolveNoWorktreeCaller(repo, deps())).rejects.toThrow("ambiguous agent records");
  });

  test("malformed registry is an error rather than a human-caller fallback", async () => {
    await Bun.write(join(repo, "home", ".itsybitsy", "repos.json"), "{broken");
    await expect(resolveNoWorktreeCaller(repo, deps())).rejects.toThrow();
  });

  test.each([undefined, 0, -1, "12345"])("matching PID with invalid epoch %j does not establish identity", async (epoch) => {
    await record(repo, "manager", { claude_pid_epoch: epoch });
    await expect(resolveNoWorktreeCaller(repo, deps())).rejects.toThrow("process identity");
  });

  test("stale PID identity is denied rather than mistaken for a primary caller", async () => {
    await record();
    await expect(resolveNoWorktreeCaller(repo, {
      ...deps(), identityCurrent: () => false,
    })).rejects.toThrow("process identity");
  });

  test("reparenting during metadata verification is rejected", async () => {
    await record();
    let reads = 0;
    await expect(resolveNoWorktreeCaller(repo, {
      ...deps(), readParents: () => ++reads === 1 ? parents() : new Map([[500, 1]]),
    })).rejects.toThrow("process identity changed");
  });

  test("identity changing during verification is rejected", async () => {
    await record();
    let checks = 0;
    await expect(resolveNoWorktreeCaller(repo, {
      ...deps(), identityCurrent: () => ++checks === 1,
    })).rejects.toThrow("process identity changed");
  });

  test("unavailable process observation cannot grant caller authority", async () => {
    await record();
    await expect(resolveNoWorktreeCaller(repo, {
      ...deps(), readParents: () => { throw new Error("process observation unavailable"); },
    })).rejects.toThrow("process observation unavailable");
  });

  test("a cyclic process snapshot is rejected", async () => {
    await record();
    await expect(resolveNoWorktreeCaller(repo, {
      ...deps(), readParents: () => new Map([[500, 400], [400, 500]]),
    })).rejects.toThrow("invalid process ancestry");
  });

  test("caller PATH cannot redirect either authority probe to a fake ps", async () => {
    const originalPath = process.env.PATH;
    const fakeBin = join(repo, "fake-bin");
    await Bun.write(join(fakeBin, "ps"), "#!/bin/sh\nexit 99\n");
    const start = "Wed Sep  9 12:00:00 2026";
    await record(repo, "live", { claude_pid: String(process.pid), claude_pid_epoch: Date.parse(start) / 1000 });
    const calls: string[][] = [];
    const probe = spyOn(Bun, "spawnSync").mockImplementation(((args: string[], options: { env: Record<string, string> }) => {
      expect(args[0]).toBe("/bin/ps");
      expect(options.env).toEqual({ LC_ALL: "C", LC_TIME: "C" });
      calls.push(args);
      return { exitCode: 0, stdout: Buffer.from(args.includes("lstart=") ? start : `${process.pid} 1\n`) };
    }) as typeof Bun.spawnSync);
    try {
      process.env.PATH = fakeBin;
      const caller = await resolveNoWorktreeCaller(repo, { registryHome: join(repo, "home") });
      expect(caller?.meta.id).toBe("live");
      expect(calls.filter(args => args.includes("lstart="))).toHaveLength(2);
      expect(calls.filter(args => args.includes("pid=,ppid="))).toHaveLength(2);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      probe.mockRestore();
    }
  });

  // Codex's native sandbox can deny spawning ps. Keep the actual OS probe
  // opt-in; the unavailable-observation test above verifies the default-deny
  // behavior independently of that host permission.
  test.skipIf(process.env.IB_LIVE_CALLER !== "1")("reads actual OS ancestry without relying on caller environment variables", async () => {
    await record(repo, "live-test", { claude_pid: String(process.pid) });
    const caller = await resolveNoWorktreeCaller(repo, { registryHome: join(repo, "home"), identityCurrent: () => true });
    expect(caller?.meta.id).toBe("live-test");
  });
});
