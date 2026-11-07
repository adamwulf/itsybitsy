import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, mkdir, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { createRepo, createRepoSpawnCtx } from "./create-repo";
import { loadRegistry, saveRegistry } from "./registry";
import { setUserHome, resetUserHome } from "./home";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import { createTeam } from "./teams";
import { makeGitIdentity, type GitIdentity } from "./test-git-identity";

// repos.json lives at userHome()/.itsybitsy and teams.json in the coordinator
// home, so both seams point into one temp dir; the real ~/.itsybitsy is never
// touched. Git runs for real, with a throwaway identity from makeGitIdentity.
describe("createRepo", () => {
  let baseDir: string;
  let parent: string;
  let identity: GitIdentity;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ib-create-repo-" + crypto.randomUUID() + "-"));
    const homeDir = join(baseDir, ".itsybitsy");
    await mkdir(homeDir, { recursive: true });
    setUserHome(baseDir);
    setCoordinatorHome(homeDir);
    parent = join(baseDir, "projects");
    await mkdir(parent);
    identity = await makeGitIdentity(baseDir);
    createRepoSpawnCtx.set(identity.spawn);
  });

  afterEach(async () => {
    createRepoSpawnCtx.reset();
    resetCoordinatorHome();
    resetUserHome();
    await rm(baseDir, { recursive: true, force: true });
  });

  test("creates the folder, inits git with one empty commit, and registers it", async () => {
    const result = await createRepo(parent, "My Project");
    const target = join(parent, "My Project");
    expect(result.ok).toBe(true);
    expect(result.path).toBe(target);
    expect(result.message).toContain("my-project");

    expect((await stat(join(target, ".git"))).isDirectory()).toBe(true);
    const log = (await Bun.$`git log --format=%s%x09%an`.cwd(target).env(identity.env).quiet().text())
      .trim().split("\n");
    // One commit; its author proves the test identity reached git.
    expect(log).toEqual(["Initial commit\tTest User"]);

    // The registry name uses the folder browser's sanitization.
    const repos = (await loadRegistry()).repos;
    expect(repos).toEqual([{ path: target, name: "my-project" }]);
  });

  test("refuses a folder that already exists and leaves it alone", async () => {
    await mkdir(join(parent, "taken"));
    const result = await createRepo(parent, "taken");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Already exists");
    expect(await readdir(join(parent, "taken"))).toEqual([]);
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test("refuses a parent that is a git repo", async () => {
    await mkdir(join(parent, ".git"));
    const result = await createRepo(parent, "child");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already a git repo");
    expect(await readdir(parent)).toEqual([".git"]);
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test.each([
    ["", "empty"],
    ["   ", "empty"],
    [".", "not a folder name"],
    ["..", "not a folder name"],
    ["a/b", "not a folder name"],
    ["../escape", "not a folder name"],
    ["!!!", "Cannot derive a valid name"],
  ])("refuses the name %p without creating anything", async (name, expected) => {
    const result = await createRepo(parent, name);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(expected);
    expect(result.path).toBeUndefined();
    expect(await readdir(parent)).toEqual([]);
    expect((await readdir(baseDir)).sort()).toEqual([".itsybitsy", "projects", "test-gitconfig"]);
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test("refuses the reserved name 'coordinator' before creating the folder", async () => {
    const result = await createRepo(parent, "coordinator");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("reserved name");
    expect(await readdir(parent)).toEqual([]);
  });

  test("refuses a name that matches an existing team before creating the folder", async () => {
    await createTeam("backend", "@system", 100);
    const result = await createRepo(parent, "backend");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already a team name");
    expect(await readdir(parent)).toEqual([]);
  });

  test("refuses a path that is already registered before creating the folder", async () => {
    const target = join(parent, "ghost");
    await saveRegistry({ repos: [{ path: target, name: "ghost" }] });
    const result = await createRepo(parent, "ghost");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Already registered");
    expect(await readdir(parent)).toEqual([]);
  });

  test("a git failure after the folder exists reports the path and git's stderr, and keeps the folder", async () => {
    // Real `git init`, then a commit that fails the way git does with no identity.
    createRepoSpawnCtx.set((cmd, opts) => cmd.includes("commit")
      ? {
          stdout: new Response("").body,
          stderr: new Response("Author identity unknown\n\n*** Please tell me who you are.\n").body,
          exited: Promise.resolve(128),
        }
      : identity.spawn(cmd, opts));
    const result = await createRepo(parent, "half");
    const target = join(parent, "half");
    expect(result.ok).toBe(false);
    expect(result.path).toBe(target);
    expect(result.message).toBe(`Created ${target}, but git commit failed: Author identity unknown *** Please tell me who you are.`);
    expect((await stat(join(target, ".git"))).isDirectory()).toBe(true);
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test("a git that cannot be launched is reported, and the folder is kept", async () => {
    createRepoSpawnCtx.set(() => { throw new Error('Executable not found in $PATH: "git"'); });
    const result = await createRepo(parent, "nogit");
    const target = join(parent, "nogit");
    expect(result.ok).toBe(false);
    expect(result.path).toBe(target);
    expect(result.message).toContain("git init failed");
    expect(result.message).toContain("Executable not found");
    expect(await readdir(target)).toEqual([]);
    expect((await loadRegistry()).repos).toEqual([]);
  });
});
