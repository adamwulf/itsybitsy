import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { loadRegistry, saveRegistry, addRepo, removeRepo, renameRepo, listRepos, repoDisplayName, setRepoDefaultAgentType, setRepoNotes } from "./registry";
import { join } from "path";
import { mkdtemp, rm, mkdir, symlink } from "fs/promises";
import { tmpdir } from "os";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import { createTeam } from "./teams";
import { setUserHome, resetUserHome } from "./home";
import { createCliFixture } from "./test-cli-runner";

// Override registry path for tests
let tempDir: string;

describe("registry", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-test-"));
    setUserHome(tempDir);
  });

  afterEach(async () => {
    resetUserHome();
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

  test("addRepo refuses HOME and a symlink to HOME, but accepts a subdirectory", async () => {
    const alias = join(tempDir, "home-alias");
    await symlink(tempDir, alias);
    for (const path of [tempDir, alias]) {
      const result = await addRepo(path, "home");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("$HOME");
    }
    expect(await listRepos()).toEqual([]);
    const child = join(tempDir, "project");
    await mkdir(child);
    expect((await addRepo(child)).ok).toBe(true);
  });

  test("addRepo rejects duplicates", async () => {
    const repoDir = join(tempDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Already registered");
  });

  test("ib add (addRepo, basename) refuses a name already registered, case-insensitively", async () => {
    const first = join(tempDir, "a", "app");
    const second = join(tempDir, "b", "App");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    expect((await addRepo(first)).ok).toBe(true);
    const result = await addRepo(second);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`"App" is already the name of a registered repo (${first}) — repo names must be unique; use ib add <path> <name>`);
    expect((await listRepos()).map((r) => r.path)).toEqual([first]);
    // The way forward the refusal names: the same folder under another name.
    const named = await addRepo(second, "app-two");
    expect(named.ok).toBe(true);
    expect((await listRepos()).map((r) => r.name)).toEqual(["app", "app-two"]);
  });

  test("folder browser [ Add ] (addRepo with a name) refuses a registered name or nickname, case-insensitively", async () => {
    await saveRegistry({ repos: [{ path: "/x/one", name: "one" }, { path: "/x/two", name: "two", nickname: "web" }] });
    const dir = join(tempDir, "folder");
    await mkdir(dir);
    const refusal = (await addRepo(dir, "ONE")).message;
    expect(refusal).toContain("already the name of a registered repo (/x/one)");
    // [ Add ] shows the same hint: register it from the CLI under another name.
    expect(refusal).toEndWith("use ib add <path> <name>");
    expect((await addRepo(dir, "Web")).message).toContain("already the name of a registered repo (/x/two)");
    expect((await addRepo(dir, "three")).ok).toBe(true);
  });

  test("duplicate names already registered are left alone", async () => {
    await saveRegistry({ repos: [{ path: "/x/one", name: "app" }, { path: "/y/one", name: "app" }] });
    expect((await listRepos()).length).toBe(2);
    const dir = join(tempDir, "other");
    await mkdir(dir);
    expect((await addRepo(dir)).ok).toBe(true);
    expect((await listRepos()).map((r) => r.name)).toEqual(["app", "app", "other"]);
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

  test("addRepo rejects a name with a space", async () => {
    const repoDir = join(tempDir, "Rice Teaching");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a valid repo name");
  });

  test("addRepo rejects an empty custom name", async () => {
    const repoDir = join(tempDir, "myrepo3");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir, "");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a valid repo name");
  });

  test("addRepo rejects a name with disallowed characters", async () => {
    const repoDir = join(tempDir, "myrepo4");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir, "foo!bar");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a valid repo name");
  });

  test("addRepo accepts a name with allowed characters", async () => {
    const repoDir = join(tempDir, "myrepo5");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir, "foo-bar_baz123");
    expect(result.ok).toBe(true);
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

  test("renameRepo rejects a nickname with a space", async () => {
    const repoDir = join(tempDir, "myrepo-rename");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "Rice Teaching");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a valid repo name");
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
    await setRepoDefaultAgentType(repoDir, "repo-coordinator");
    const reloaded = await loadRegistry();
    expect(reloaded.repos[0]!.defaultAgentType).toBe("repo-coordinator");
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

// Bidirectional repo↔team name-collision refusal (SPEC §16.1). The repo side:
// adding/renaming a repo whose basename/nickname collides with an EXISTING team
// is hard-refused. Both repos.json (userHome()/.itsybitsy) and teams.json
// (coordinator home) must share the test dir, so set BOTH home seams and the
// coordinator-home override at <tmp>/.itsybitsy — mirrors teams.test.ts.
describe("registry team-name collision refusal", () => {
  let baseDir: string;
  let homeDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ib-registry-teams-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    await mkdir(homeDir, { recursive: true });
    setUserHome(baseDir);
    setCoordinatorHome(homeDir);
  });

  afterEach(async () => {
    resetCoordinatorHome();
    resetUserHome();
    await rm(baseDir, { recursive: true, force: true });
  });

  test("addRepo refuses a basename that matches an existing team", async () => {
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "backend");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already a team name");
    // Nothing was registered.
    const repos = await listRepos();
    expect(repos.length).toBe(0);
  });

  test("addRepo refuses a custom name that matches an existing team", async () => {
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "some-dir");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir, "backend");
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`"backend" is already a team name — choose a different repo name; use ib add <path> <name>`);
  });

  test("addRepo allows a name with no team collision", async () => {
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "frontend");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos.length).toBe(1);
    expect(repos[0]!.name).toBe("frontend");
  });

  test("addRepo team collision is case-SENSITIVE", async () => {
    // A team "backend" must NOT block a repo named "Backend".
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "Backend");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir);
    expect(result.ok).toBe(true);
  });

  test("addRepo rejects a leading @ outright (allowlist rejects before team check)", async () => {
    // Repo names won't normally have a leading @, and the new repo-name
    // allowlist (^[A-Za-z0-9_-]+$) rejects it before any team-collision check.
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "weird-dir");
    await mkdir(repoDir, { recursive: true });
    const result = await addRepo(repoDir, "@backend");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a valid repo name");
  });

  test("renameRepo refuses a nickname matching an existing team", async () => {
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "backend");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already a team name");
    // Nickname was not set.
    const repos = await listRepos();
    expect(repos[0]!.nickname).toBeUndefined();
  });

  test("renameRepo allows a nickname that doesn't collide with a team", async () => {
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "frontend");
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos[0]!.nickname).toBe("frontend");
  });

  test("renameRepo team collision is case-SENSITIVE", async () => {
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    const result = await renameRepo(repoDir, "Backend");
    expect(result.ok).toBe(true);
  });

  test("renameRepo clearing a nickname needs no team check (empty branch)", async () => {
    await createTeam("backend", "@system", 100);
    const repoDir = join(baseDir, "myrepo");
    await mkdir(repoDir, { recursive: true });
    await addRepo(repoDir);
    await renameRepo(repoDir, "frontend");
    const result = await renameRepo(repoDir, "");
    expect(result.ok).toBe(true);
    const repos = await listRepos();
    expect(repos[0]!.nickname).toBeUndefined();
  });
});

// `ib add [path] [name]` through the isolated CLI: a folder whose name is
// already registered can still be added, under a name of its own (SPEC §9.3).
describe("ib add [path] [name] (CLI)", () => {
  test("a taken folder name is refused with the way forward, and the name argument registers it", async () => {
    const cli = await createCliFixture();
    try {
      await cli.addRepo("app");
      const second = join(cli.root, "elsewhere", "app");
      await mkdir(second, { recursive: true });

      const refused = await cli.run(["add", second]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toContain(`"app" is already the name of a registered repo`);
      expect(refused.stdout).toContain("use ib add <path> <name>");

      const added = await cli.run(["add", second, "app-two"]);
      expect(added.exitCode).toBe(0);
      expect(added.stdout).toContain(`Added: app-two (${second})`);
      const registry = await Bun.file(join(cli.home, ".itsybitsy", "repos.json")).json();
      expect(registry.repos.map((r: { name: string }) => r.name)).toEqual(["app", "app-two"]);
    } finally {
      await cli.cleanup();
    }
  });

  test("a flag-like name or a third argument is refused with the usage text, and nothing is registered", async () => {
    const cli = await createCliFixture();
    try {
      const folder = join(cli.root, "folder");
      await mkdir(folder, { recursive: true });
      for (const args of [["add", folder, "--name", "app-two"], ["add", folder, "--name"], ["add", folder, "-x"], ["add", folder, "one", "two"]]) {
        const run = await cli.run(args);
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("Usage: ib add [path] [name]");
        expect(run.stdout).not.toContain("Added:");
      }
      expect(await Bun.file(join(cli.home, ".itsybitsy", "repos.json")).exists()).toBe(false);
    } finally {
      await cli.cleanup();
    }
  });
});
