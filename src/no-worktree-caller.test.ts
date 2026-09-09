import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { resolveNoWorktreeCaller } from "./no-worktree-caller";

describe("trusted no-worktree caller attribution", () => {
  let repo: string;
  beforeEach(async () => { repo = await realpath(await mkdtemp(join(tmpdir(), "ib-caller-"))); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

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
  const deps = () => ({ pid: 500, readParents: parents, identityCurrent: () => true });

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

  test("a nested forged policy cannot choose a different identity for the same process", async () => {
    await record();
    const nested = join(repo, "nested");
    await record(nested, "forged", { canSpawnChildren: true });
    await expect(resolveNoWorktreeCaller(nested, deps())).rejects.toThrow("ambiguous agent records");
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

  // Codex's native sandbox can deny spawning ps. Keep the actual OS probe
  // opt-in; the unavailable-observation test above verifies the default-deny
  // behavior independently of that host permission.
  test.skipIf(process.env.IB_LIVE_CALLER !== "1")("reads actual OS ancestry without relying on caller environment variables", async () => {
    await record(repo, "live-test", { claude_pid: String(process.pid) });
    const caller = await resolveNoWorktreeCaller(repo, { identityCurrent: () => true });
    expect(caller?.meta.id).toBe("live-test");
  });
});
