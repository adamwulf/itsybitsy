import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadRegistry, saveRegistry, addRepo, removeRepo, renameRepo, listRepos, repoDisplayName } from "./registry";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";

// Override registry path for tests
const originalHome = process.env.HOME;
let tempDir: string;

describe("registry", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("loadRegistry returns empty when no file exists", async () => {
    const data = await loadRegistry();
    expect(data.repos).toEqual([]);
  });

  test("saveRegistry and loadRegistry roundtrip", async () => {
    const data = { repos: [{ path: "/tmp/test", name: "test" }] };
    await saveRegistry(data);
    const loaded = await loadRegistry();
    expect(loaded.repos).toEqual(data.repos);
  });

  test("addRepo adds a new repo", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos.length).toBe(1);
    expect(repos[0]!.name).toBe("myrepo");
  });

  test("addRepo rejects duplicates", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Already registered");
  });

  test("removeRepo removes by path", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await removeRepo(repoDir);
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos.length).toBe(0);
  });

  test("removeRepo returns error for unknown path", async () => {
    const result = await removeRepo("/nonexistent");
    expect(result.ok).toBe(false);
  });

  test("listRepos returns all registered repos", async () => {
    const repo1 = join(tempDir, "repo1");
    const repo2 = join(tempDir, "repo2");
    await mkdir(repo1, { recursive: true });
    await mkdir(repo2, { recursive: true });
    await addRepo(repo1);
    await addRepo(repo2);
    const repos = await listRepos();
    expect(repos.length).toBe(2);
  });

  test("renameRepo sets nickname", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "my-nick");
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos[0]!.nickname).toBe("my-nick");
    expect(repos[0]!.name).toBe("myrepo"); // name unchanged
  });

  test("renameRepo with empty string clears nickname", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await renameRepo(repoDir, "nick1");
    const result = await renameRepo(repoDir, "");
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos[0]!.nickname).toBeUndefined();
  });

  test("renameRepo returns error for unknown path", async () => {
    const result = await renameRepo("/nonexistent", "foo");
    expect(result.ok).toBe(false);
  });

  test("renameRepo rejects nickname that collides with another repo's display name", async () => {
    const repo1 = join(tempDir, "repo1");
    const repo2 = join(tempDir, "repo2");
    await mkdir(repo1, { recursive: true });
    await mkdir(repo2, { recursive: true });
    await addRepo(repo1);
    await addRepo(repo2);
    // repo2's display name is "repo2" (basename). Setting repo1's nickname to "repo2" should fail.
    const result = await renameRepo(repo1, "repo2");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already used");
  });

  test("renameRepo rejects nickname that collides with another repo's basename even if it has a nickname", async () => {
    const repo1 = join(tempDir, "repo1");
    const repo2 = join(tempDir, "repo2");
    await mkdir(repo1, { recursive: true });
    await mkdir(repo2, { recursive: true });
    await addRepo(repo1);
    await addRepo(repo2);
    // Give repo2 a nickname so its display name differs from its basename
    await renameRepo(repo2, "custom-nick");
    // Setting repo1's nickname to "repo2" (repo2's basename) should still fail
    const result = await renameRepo(repo1, "repo2");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already used");
  });

  test("renameRepo allows nickname that doesn't collide", async () => {
    const repo1 = join(tempDir, "repo1");
    const repo2 = join(tempDir, "repo2");
    await mkdir(repo1, { recursive: true });
    await mkdir(repo2, { recursive: true });
    await addRepo(repo1);
    await addRepo(repo2);
    const result = await renameRepo(repo1, "unique-name");
    expect(result.ok).toBe(true);
  });

  test("repoDisplayName returns nickname when set", () => {
    expect(repoDisplayName({ path: "/tmp/test", name: "test", nickname: "nick" })).toBe("nick");
  });

  test("repoDisplayName falls back to name when no nickname", () => {
    expect(repoDisplayName({ path: "/tmp/test", name: "test" })).toBe("test");
  });

  test("saveRegistry persists nickname field", async () => {
    const data = { repos: [{ path: "/tmp/test", name: "test", nickname: "nick" }] };
    await saveRegistry(data);
    const loaded = await loadRegistry();
    expect(loaded.repos[0]!.nickname).toBe("nick");
  });
});
