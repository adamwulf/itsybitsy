import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadRegistry, saveRegistry, addRepo, removeRepo, renameRepo, listRepos, repoDisplayName, setRepoDefaultAgentType, setRepoNotes } from "./registry";
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

  test("addRepo rejects 'coordinator' basename", async () => {
    const repoDir = join(tempDir, "coordinator");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("reserved name");
  });

  test("addRepo rejects 'coordinator' as custom name", async () => {
    const repoDir = join(tempDir, "myrepo2");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir, "coordinator");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("reserved name");
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

  test("renameRepo rejects 'coordinator' as nickname", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "coordinator");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("reserved name");
  });

  // --- Group I: additional addRepo coordinator enforcement ---

  test("I2: addRepo custom name overrides reserved basename", async () => {
    // Path basename is "coordinator" but custom name "api" overrides it
    const repoDir = join(tempDir, "coordinator");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir, "api");
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos[0]!.name).toBe("api");
  });

  test("I4: plural 'coordinators' is allowed (not reserved)", async () => {
    const repoDir = join(tempDir, "coordinators");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("coordinators");
  });

  test("I5: 'system' is NOT blocked by addRepo", async () => {
    const repoDir = join(tempDir, "system");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(true);
  });

  test("addRepo 'Coordinator' (uppercase) passes — case-sensitive", async () => {
    const repoDir = join(tempDir, "Coordinator");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(true);
  });

  // --- Group J: additional renameRepo coordinator enforcement ---

  test("J4: renameRepo whitespace-only nickname clears nickname", async () => {
    const repoDir = join(tempDir, "myrepo-ws");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await renameRepo(repoDir, "some-nick");
    const result = await renameRepo(repoDir, "   ");
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    const entry = repos.find(r => r.path.endsWith("myrepo-ws"));
    expect(entry!.nickname).toBeUndefined();
  });

  test("J5: renameRepo 'system' is NOT blocked", async () => {
    const repoDir = join(tempDir, "myrepo-sys");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "system");
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    const entry = repos.find(r => r.path.endsWith("myrepo-sys"));
    expect(entry!.nickname).toBe("system");
  });

  test("renameRepo 'Coordinator' (uppercase) passes — case-sensitive", async () => {
    const repoDir = join(tempDir, "myrepo-cap");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "Coordinator");
    expect(result.ok).toBe(true);
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

  // --- setRepoDefaultAgentType ---

  test("setRepoDefaultAgentType sets the field and persists", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await setRepoDefaultAgentType(repoDir, "worker");
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBe("worker");
  });

  test("setRepoDefaultAgentType clears with null", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoDefaultAgentType(repoDir, "worker");
    const result = await setRepoDefaultAgentType(repoDir, null);
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBeUndefined();
  });

  test("setRepoDefaultAgentType clears with empty string", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoDefaultAgentType(repoDir, "worker");
    const result = await setRepoDefaultAgentType(repoDir, "");
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBeUndefined();
  });

  test("setRepoDefaultAgentType clears with whitespace-only string", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoDefaultAgentType(repoDir, "manager");
    const result = await setRepoDefaultAgentType(repoDir, "   ");
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBeUndefined();
  });

  test("setRepoDefaultAgentType returns error for unknown path", async () => {
    const result = await setRepoDefaultAgentType("/nonexistent", "worker");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not found");
  });

  test("setRepoDefaultAgentType updates an existing value", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoDefaultAgentType(repoDir, "manager");
    const result = await setRepoDefaultAgentType(repoDir, "worker");
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBe("worker");
  });

  test("loadRegistry preserves defaultAgentType across reload", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoDefaultAgentType(repoDir, "coordinator");
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBe("coordinator");
  });

  // --- setRepoNotes ---

  test("setRepoNotes sets the field and persists", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await setRepoNotes(repoDir, "first line\nsecond line");
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.notes).toBe("first line\nsecond line");
  });

  test("setRepoNotes preserves whitespace verbatim", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await setRepoNotes(repoDir, "  indented  \n\ttabbed\n");
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.notes).toBe("  indented  \n\ttabbed\n");
  });

  test("setRepoNotes clears with empty string", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoNotes(repoDir, "hello");
    const result = await setRepoNotes(repoDir, "");
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.notes).toBeUndefined();
  });

  test("setRepoNotes clears with null", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoNotes(repoDir, "hello");
    const result = await setRepoNotes(repoDir, null);
    expect(result.ok).toBe(true);
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.notes).toBeUndefined();
  });

  test("setRepoNotes returns error for unknown path", async () => {
    const result = await setRepoNotes("/nonexistent", "x");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not found");
  });

  test("setRepoNotes coexists with defaultAgentType", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await setRepoDefaultAgentType(repoDir, "worker");
    await setRepoNotes(repoDir, "TODO: cleanup");
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBe("worker");
    expect(reloaded.repos[0]!.notes).toBe("TODO: cleanup");
  });

  test("registry writes to ~/.itsybitsy/repos.json not ~/.itsybitsy.json", async () => {
    await saveRegistry({ repos: [{ path: "/tmp/test", name: "test" }] });
    const newFile = Bun.file(join(tempDir, ".itsybitsy", "repos.json"));
    const oldFile = Bun.file(join(tempDir, ".itsybitsy.json"));
    expect(await newFile.exists()).toBe(true);
    expect(await oldFile.exists()).toBe(false);
  });

});
