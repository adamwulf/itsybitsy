import { test, expect, describe, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { loadRegistry, saveRegistry, addRepo, removeRepo, renameRepo, listRepos, repoDisplayName, setRepoDefaultAgentType, setRepoNotes, checkNewRepoEntry, readRegistryStrict } from "./registry";
import { join } from "path";
import { chmod, mkdtemp, open, stat, rm, mkdir, symlink } from "fs/promises";
import { tmpdir } from "os";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import { createTeam } from "./teams";
import { setUserHome, resetUserHome } from "./home";
import { createCliFixture, runIsolatedCli } from "./test-cli-runner";
import { spawnCtx as lifecycleSpawnCtx } from "./agent-lifecycle";

// The CLI tests below launch several `ib` subprocesses each; 5 s is not enough under load.
setDefaultTimeout(60_000);

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

  test("a reader holding the old registry sees a complete snapshot across a save", async () => {
    const oldRegistry = { repos: [{ path: "/repo/a", name: "first" }] };
    const newRegistry = { repos: [{ path: "/repo/b", name: "second" }] };
    await saveRegistry(oldRegistry);
    const reader = await open(join(tempDir, ".itsybitsy", "repos.json"), "r");
    try {
      await saveRegistry(newRegistry);
      expect(JSON.parse(await reader.readFile("utf8"))).toEqual(oldRegistry);
      expect(await loadRegistry()).toEqual(newRegistry);
    } finally {
      await reader.close();
    }
  });

  test("atomic saves create a private file and preserve existing permissions", async () => {
    const path = join(tempDir, ".itsybitsy", "repos.json");
    await saveRegistry({ repos: [] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o640);
    await saveRegistry({ repos: [{ name: "new", path: "/new" }] });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  test("all registry mutations refuse malformed input and preserve its bytes", async () => {
    const path = join(tempDir, ".itsybitsy", "repos.json");
    const bytes = '{"repos":[{"path":"/existing","name":"one"},';
    await Bun.write(path, bytes);
    const changes = [
      () => addRepo("/new", "two"), () => removeRepo("/existing"),
      () => renameRepo("/existing", "renamed"), () => setRepoNotes("/existing", "notes"),
      () => setRepoDefaultAgentType("/existing", "worker"),
    ];
    for (const change of changes) {
      await expect(change()).rejects.toThrow("Cannot read repo registry");
      expect(await Bun.file(path).text()).toBe(bytes);
    }
  });

  test("a registry I/O error prevents a mutation", async () => {
    const path = join(tempDir, ".itsybitsy", "repos.json");
    // A directory in place of the file reliably makes the read fail, even as root.
    await mkdir(path, { recursive: true });
    const marker = join(path, "original");
    await Bun.write(marker, "original contents");
    await expect(addRepo("/new", "new")).rejects.toThrow("Cannot read repo registry");
    expect(await Bun.file(marker).text()).toBe("original contents");
  });

  test("refuses a nickname matching another registered name or nickname in a different case", async () => {
    const repos = [{ path: "/one", name: "One", nickname: "First" }, { path: "/two", name: "Two" }];
    await saveRegistry({ repos });
    for (const nickname of ["ONE", "fIrSt"]) {
      expect((await renameRepo("/two", nickname)).ok).toBe(false);
      expect(await listRepos()).toEqual(repos);
    }
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
    const first = join(tempDir, "a", "website");
    const second = join(tempDir, "b", "App");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    expect((await addRepo(first, "app")).ok).toBe(true);
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

  test("a symlink to a second git repo collides with a registered subdirectory by root basename", async () => {
    const first = join(tempDir, "client-a", "app");
    const registered = join(first, "src");
    const second = join(tempDir, "client-b", "App");
    const alias = join(tempDir, "mobile");
    await mkdir(registered, { recursive: true });
    await mkdir(second, { recursive: true });
    await Bun.$`git init --quiet`.cwd(first);
    await Bun.$`git init --quiet`.cwd(second);
    await symlink(second, alias);

    expect((await addRepo(registered, "website")).ok).toBe(true);
    const result = await addRepo(alias, "phone");
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`coordinator id "App" (from repo root folder name "App") matches, ignoring case, the coordinator id "app" of registered repo "website" (${registered})`);
    expect(await listRepos()).toEqual([{ path: registered, name: "website" }]);
  });

  test("refuses a second folder whose name gives the same coordinator id, case-insensitively", async () => {
    const dotted = join(tempDir, "one", "a.b");
    const underscored = join(tempDir, "two", "a_b");
    const spaced = join(tempDir, "three", "A B");
    for (const dir of [dotted, underscored, spaced]) await mkdir(dir, { recursive: true });

    expect((await addRepo(dotted, "first")).ok).toBe(true);
    const registry = await readRegistryStrict();
    expect(await checkNewRepoEntry(underscored, "second", registry)).toContain(
      `coordinator id "a_b" (from repo root folder name "a_b") matches, ignoring case, the coordinator id "a_b" of registered repo "first" (${dotted})`,
    );
    expect(await checkNewRepoEntry(spaced, "third", registry)).toContain(
      `coordinator id "A_B" (from repo root folder name "A B") matches, ignoring case, the coordinator id "a_b" of registered repo "first" (${dotted})`,
    );
    expect((await addRepo(underscored, "second")).ok).toBe(false);
    expect(await listRepos()).toEqual([{ path: dotted, name: "first" }]);
  });

  test("a stalled git root lookup is killed and falls back to the registered folder basename", async () => {
    const existing = { path: join(tempDir, "offline", "app"), name: "website" };
    await saveRegistry({ repos: [existing] });
    const signals: (number | string | undefined)[] = [];
    const cancelled: string[] = [];
    const started = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<number>();
    const deadline = new AbortController();
    const timer = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    lifecycleSpawnCtx.set((cmd) => {
      if (cmd[2] !== existing.path) return { stdout: null, stderr: null, exited: Promise.resolve(128) };
      started.resolve();
      return {
        stdout: new ReadableStream({ cancel() { cancelled.push("stdout"); } }),
        stderr: new ReadableStream({ cancel() { cancelled.push("stderr"); } }),
        exited: exit.promise,
        kill: (signal) => { signals.push(signal); },
      };
    });
    try {
      const registration = addRepo(join(tempDir, "App"), "mobile");
      await started.promise;
      expect(timer.mock.calls).toEqual([[2_000], [2_000]]);
      deadline.abort();
      const result = await registration;
      expect(signals).toEqual(["SIGKILL"]);
      expect(cancelled.sort()).toEqual(["stderr", "stdout"]);
      expect(Bun.peek(exit.promise)).toBe(exit.promise);
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`coordinator id "App" (from repo root folder name "App") matches, ignoring case, the coordinator id "app" of registered repo "website" (${existing.path})`);
      expect(await listRepos()).toEqual([existing]);
    } finally {
      exit.resolve(137);
      timer.mockRestore();
      lifecycleSpawnCtx.reset();
    }
  });

  test("adding a different basename preserves existing duplicate names and folder basenames", async () => {
    const existing = [{ path: "/x/one", name: "app" }, { path: "/y/one", name: "app" }];
    await saveRegistry({ repos: existing });
    expect(await listRepos()).toEqual(existing);
    const dir = join(tempDir, "other");
    await mkdir(dir);
    expect((await addRepo(dir)).ok).toBe(true);
    expect(await listRepos()).toEqual([...existing, { path: dir, name: "other" }]);
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

describe("ib add [path] [name] (CLI)", () => {
  test("a taken registry name is refused with the way forward, and the name argument registers it", async () => {
    const cli = await createCliFixture();
    try {
      const first = join(cli.root, "website");
      const second = join(cli.root, "elsewhere", "app");
      const options = { allowedProcesses: [first, second].map(path => ["git", "-C", path, "rev-parse"]) };
      expect((await cli.run(["add", first, "app"], options)).exitCode).toBe(0);
      await mkdir(second, { recursive: true });

      const refused = await cli.run(["add", second], options);
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toContain(`"app" is already the name of a registered repo`);
      expect(refused.stdout).toContain("use ib add <path> <name>");

      const added = await cli.run(["add", second, "app-two"], options);
      expect(added.exitCode).toBe(0);
      expect(added.stdout).toContain(`Added: app-two (${second})`);
      const registry = await Bun.file(join(cli.home, ".itsybitsy", "repos.json")).json();
      expect(registry.repos.map((r: { name: string }) => r.name)).toEqual(["app", "app-two"]);
    } finally {
      await cli.cleanup();
    }
  });

  test("a folder basename already registered at another path is refused with or without a custom name", async () => {
    const cli = await createCliFixture();
    try {
      const first = join(cli.root, "app");
      const second = join(cli.root, "elsewhere", "App");
      const options = { allowedProcesses: [first, second].map(path => ["git", "-C", path, "rev-parse"]) };
      await mkdir(first);
      await mkdir(second, { recursive: true });
      expect((await cli.run(["add", first, "website"], options)).exitCode).toBe(0);

      for (const args of [["add", second], ["add", second, "app-two"]]) {
        const result = await cli.run(args, options);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain(`coordinator id "App" (from repo root folder name "App") matches, ignoring case, the coordinator id "app" of registered repo "website" (${first})`);
      }
      const registry = await Bun.file(join(cli.home, ".itsybitsy", "repos.json")).json();
      expect(registry.repos).toEqual([{ path: first, name: "website" }]);
    } finally {
      await cli.cleanup();
    }
  });

  test("a flag-like name or a third argument is refused with the usage text, and nothing is registered", async () => {
    const cli = await createCliFixture();
    try {
      const folder = join(cli.root, "folder");
      await mkdir(folder, { recursive: true });
      for (const args of [
        ["add", folder, "--name", "app-two"], ["add", folder, "--name"], ["add", folder, "-x"], ["add", folder, "one", "two"],
        // A flag where the path goes: it would register a nonexistent <cwd>/--name.
        ["add", "--name", "app-two"], ["add", "-x"],
      ]) {
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

describe("ib notes show|set|clear <repo> (CLI)", () => {
  const registryFile = (home: string) => join(home, ".itsybitsy", "repos.json");
  const storedNotes = async (home: string, path: string): Promise<string | undefined> =>
    ((await Bun.file(registryFile(home)).json()).repos as { path: string; notes?: string }[])
      .find((r) => r.path === path)?.notes;

  test("show, set, show and clear one repo by name", async () => {
    const cli = await createCliFixture();
    try {
      const app = await cli.addRepo("app");

      const empty = await cli.run(["notes", "show", "app"]);
      expect(empty.exitCode).toBe(0);
      expect(empty.stdout).toBe("");
      expect(empty.stderr).toContain("No notes for app");

      const set = await cli.run(["notes", "set", "app", "run", "the tests first"]);
      expect(set.exitCode).toBe(0);
      expect(set.stdout).toContain("Set notes for app");
      expect(await storedNotes(cli.home, app)).toBe("run the tests first");

      const shown = await cli.run(["notes", "show", "app"]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toBe("run the tests first\n");

      const cleared = await cli.run(["notes", "clear", "app"]);
      expect(cleared.exitCode).toBe(0);
      expect(cleared.stdout).toContain("Cleared notes for app");
      const entry = (await Bun.file(registryFile(cli.home)).json()).repos[0];
      expect(entry).toEqual({ path: app, name: "app" });
    } finally {
      await cli.cleanup();
    }
  }, 30_000);

  test("set with no text reads multi-line notes from stdin, by nickname or path; a repo named set is a repo", async () => {
    const cli = await createCliFixture();
    try {
      const lib = await cli.addRepo("lib", { nickname: "web" });
      const named = await cli.addRepo("set");

      const heredoc = await cli.run(["notes", "set", "web"], { stdin: "line one\n  indented $(not run)\n\n" });
      expect(heredoc.exitCode).toBe(0);
      expect(heredoc.stdout).toContain("Set notes for lib");
      expect(await storedNotes(cli.home, lib)).toBe("line one\n  indented $(not run)");

      const byPath = await cli.run(["notes", "show", lib]);
      expect(byPath.stdout).toBe("line one\n  indented $(not run)\n");

      const repoNamedSet = await cli.run(["notes", "set", "set", "hello"]);
      expect(repoNamedSet.exitCode).toBe(0);
      expect(await storedNotes(cli.home, named)).toBe("hello");
      expect(await storedNotes(cli.home, lib)).toBe("line one\n  indented $(not run)");
    } finally {
      await cli.cleanup();
    }
  }, 30_000);

  test("an unknown or ambiguous repo fails with exit 1 and changes nothing", async () => {
    const cli = await createCliFixture();
    try {
      await cli.addRepo("app");
      await cli.addRepo("lib", { nickname: "App" });
      const before = await Bun.file(registryFile(cli.home)).text();

      for (const args of [["notes", "show", "nope"], ["notes", "set", "nope", "x"], ["notes", "clear", "nope"]]) {
        const run = await cli.run(args);
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("Repo not found: nope");
      }
      const ambiguous = await cli.run(["notes", "set", "app", "x"]);
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.stderr).toContain('Ambiguous repo "app" matches multiple registered repos');
      expect(await Bun.file(registryFile(cli.home)).text()).toBe(before);
    } finally {
      await cli.cleanup();
    }
  }, 30_000);

  test("usage errors exit 1 with the usage text and change nothing", async () => {
    const cli = await createCliFixture();
    try {
      await cli.addRepo("app");
      const before = await Bun.file(registryFile(cli.home)).text();

      for (const [args, usage, stdin] of [
        [["notes"], "Usage: ib notes <subcommand>"],
        [["notes", "bogus", "app"], "Error: unknown notes subcommand 'bogus'"],
        [["notes", "show"], "Usage: ib notes show <repo>"],
        [["notes", "show", "app", "extra"], "Usage: ib notes show <repo>"],
        [["notes", "clear", "app", "extra"], "Usage: ib notes clear <repo>"],
        [["notes", "set"], "Usage: ib notes set <repo>"],
        [["notes", "set", "app"], "Error: no notes given"],
        [["notes", "set", "app"], "Error: no notes given", "  \n\n"],
      ] as [string[], string, string?][]) {
        const run = await cli.run(args, stdin === undefined ? {} : { stdin });
        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain(usage);
      }
      expect(await Bun.file(registryFile(cli.home)).text()).toBe(before);
    } finally {
      await cli.cleanup();
    }
  }, 60_000);

  test("-h and --help after the repo are note text, not a help request", async () => {
    const cli = await createCliFixture();
    try {
      const app = await cli.addRepo("app");
      const short = await cli.run(["notes", "set", "app", "run", "ib", "list", "-h", "first"]);
      expect(short.exitCode).toBe(0);
      expect(short.stdout).toContain("Set notes for app");
      expect(await storedNotes(cli.home, app)).toBe("run ib list -h first");

      const long = await cli.run(["notes", "set", "app", "--help"]);
      expect(long.exitCode).toBe(0);
      expect(await storedNotes(cli.home, app)).toBe("--help");
    } finally {
      await cli.cleanup();
    }
  }, 30_000);

  test("--help prints the outer and per-subcommand help", async () => {
    const outer = await runIsolatedCli(["notes", "--help"]);
    expect(outer.exitCode).toBe(0);
    expect(outer.stdout).toContain("Usage: ib notes <subcommand> <repo>");
    expect(outer.stdout).toContain("may run show; only coordinators");
    expect(outer.stdout).toContain("may run set and clear.");
    const set = await runIsolatedCli(["notes", "set", "--help"]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("Usage: ib notes set <repo> [text...]");
    expect(set.stdout).toContain("ib notes set <repo> <<'EOF'");
  }, 30_000);
});

describe("ib list-repos [--json | --md] (CLI)", () => {
  test("prints each registered repo's name, path and notes, and none of its agents", async () => {
    const cli = await createCliFixture();
    try {
      const app = await cli.addRepo("app");
      await cli.addAgent(app, "agent-hidden");
      const site = join(cli.root, "website");
      const notes = "Deploys from main.\n\nStaging first.\n";
      await cli.writeRegistry({ version: 1, repos: [
        { path: app, name: "app" },
        { path: site, name: "website", nickname: "site", notes },
      ] });

      for (const command of ["list-repos", "repos"]) {
        const run = await cli.run([command]);
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toBe(`app   ${app}\nsite  ${site}\n      Deploys from main.\n\n      Staging first.\n`);
      }

      const json = await cli.run(["list-repos", "--json"]);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([
        { name: "app", nickname: null, path: app, notes: null },
        { name: "website", nickname: "site", path: site, notes },
      ]);

      const md = await cli.run(["list-repos", "--md"]);
      expect(md.exitCode).toBe(0);
      expect(md.stdout).toBe(
        "| Name | Path | Notes |\n| --- | --- | --- |\n" +
          `| app | ${app} |  |\n| site | ${site} | Deploys from main.<br><br>Staging first. |\n`,
      );
    } finally {
      await cli.cleanup();
    }
  });

  test("--md escapes a | in a cell, and --json with --md is refused with the usage text", async () => {
    const cli = await createCliFixture();
    try {
      await cli.writeRegistry({ repos: [{ path: "/tmp/a|b", name: "pipe", notes: "x|y" }] });
      const md = await cli.run(["list-repos", "--md"]);
      expect(md.stdout).toBe("| Name | Path | Notes |\n| --- | --- | --- |\n| pipe | /tmp/a\\|b | x\\|y |\n");

      const both = await cli.run(["list-repos", "--json", "--md"]);
      expect(both.exitCode).toBe(1);
      expect(both.stdout).toBe("");
      expect(both.stderr).toContain("Usage: ib list-repos [--json | --md]");
    } finally {
      await cli.cleanup();
    }
  });

  test("an empty registry says how to add a repo, or prints [] with --json", async () => {
    const cli = await createCliFixture();
    try {
      for (const args of [["list-repos"], ["list-repos", "--md"]]) {
        const text = await cli.run(args);
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toBe("No repos registered. Use 'ib add <path>' to add one.\n");
      }

      const json = await cli.run(["list-repos", "--json"]);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
    } finally {
      await cli.cleanup();
    }
  });
});
