import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync } from "fs";
import { chmod, mkdtemp, mkdir, readdir, rm, symlink } from "fs/promises";
import { tmpdir } from "os";
import {
  cloneDestination,
  cloneEnv,
  cloneRepo,
  cloneRepoSpawnCtx,
  cloneRootRelPath,
  isAllowedCloneUrl,
  readRepoCloneInfo,
  resolveCloneRoot,
} from "./clone-repo";
import { writeConfig, defaultUserConfigPath } from "./config";
import { loadRegistry, saveRegistry } from "./registry";
import { setUserHome, resetUserHome } from "./home";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import type { SpawnFn } from "./types";

describe("cloneDestination", () => {
  test("mirrors the peer's folders under the clone root, in a folder named after the registry name", () => {
    expect(cloneDestination("/Users/me/Developer", "foo", "swift-packages/Foo")).toBe("/Users/me/Developer/swift-packages/foo");
    expect(cloneDestination("/Users/me/Developer", "foo", "html/sites/Foo")).toBe("/Users/me/Developer/html/sites/foo");
    expect(cloneDestination("/Users/me/Developer", "foo", "Foo")).toBe("/Users/me/Developer/foo");
    expect(cloneDestination("/Users/me/Developer", "foo", null)).toBe("/Users/me/Developer/foo");
  });
});

describe("isAllowedCloneUrl", () => {
  test.each([
    "git@github.com:owner/repo.git",
    "user@host.example:path/to/repo",
    "ssh://git@github.com/owner/repo.git",
    "ssh://host.example:2222/srv/repo",
    "https://github.com/owner/repo.git",
    "https://token@github.com/owner/repo",
  ])("allows %p", (url) => {
    expect(isAllowedCloneUrl(url)).toBe(true);
  });

  test.each([
    "",
    "ext::sh -c touch% /tmp/pwned",
    "ext::ssh",
    "file:///tmp/repo",
    "/tmp/repo",
    "../repo",
    "repo",
    "C:\\repos\\app",
    "http://github.com/owner/repo.git",
    "git://github.com/owner/repo.git",
    "ftp://host/repo",
    "-uhelp",
    "--upload-pack=touch /tmp/pwned",
    "-x@host:path",
    "ssh://-oProxyCommand=touch/repo",
    "ssh://git@-oProxyCommand=x/repo",
    "ssh://",
    "https:///path",
    "git@-host:path",
    "git@host:",
    "host:path",
    "git@github.com:owner/repo name",
    "https://github.com/owner/repo\n",
    "https://github.com/owner/\x1b[31mrepo",
    "git@github.com:owner/repo\0",
  ])("refuses %p", (url) => {
    expect(isAllowedCloneUrl(url)).toBe(false);
  });
});

test("cloneEnv turns off git's prompt and runs ssh in batch mode, appending to the user's GIT_SSH_COMMAND", () => {
  expect(cloneEnv({ PATH: "/bin", SSH_AUTH_SOCK: "/tmp/agent" })).toEqual({
    PATH: "/bin",
    SSH_AUTH_SOCK: "/tmp/agent",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  });
  expect(cloneEnv({ GIT_SSH_COMMAND: "ssh -i ~/.ssh/work " }).GIT_SSH_COMMAND).toBe("ssh -i ~/.ssh/work -o BatchMode=yes");
  expect(cloneEnv({ GIT_SSH_COMMAND: "" }).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
});

// repos.json and config.json live at userHome()/.itsybitsy and teams.json in
// the coordinator home, so both seams point into one temp dir; the real
// ~/.itsybitsy is never touched. Git is faked through cloneRepoSpawnCtx, except
// the git root lookup addRepo's checks make, which runs for real on temp paths.
describe("with a temp home", () => {
  let baseDir: string;
  let root: string;
  let calls: { cmd: string[]; env?: Record<string, string | undefined> }[];

  /** A fake git: `answer` sees each command and may act on the disk before it "exits". */
  const fakeGit = (answer: (cmd: string[]) => { exitCode?: number; stdout?: string; stderr?: string }): SpawnFn =>
    ((cmd: string[], opts?: { env?: Record<string, string | undefined> }) => {
      calls.push({ cmd, env: opts?.env });
      const { exitCode = 0, stdout = "", stderr = "" } = answer(cmd);
      return { stdout: new Response(stdout).body, stderr: new Response(stderr).body, exited: Promise.resolve(exitCode) };
    }) as SpawnFn;

  /** `git clone` makes the folder; `git config` reports `origin` (none when null). */
  const workingGit = (origin: string | null = null) => fakeGit((cmd) => {
    if (cmd[1] === "clone") {
      mkdirSync(join(cmd[4]!, ".git"), { recursive: true });
      return {};
    }
    return origin === null ? { exitCode: 1 } : { stdout: `${origin}\n` };
  });

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ib-clone-repo-" + crypto.randomUUID() + "-"));
    const homeDir = join(baseDir, ".itsybitsy");
    await mkdir(homeDir, { recursive: true });
    setUserHome(baseDir);
    setCoordinatorHome(homeDir);
    root = join(baseDir, "Developer");
    await mkdir(root);
    calls = [];
    cloneRepoSpawnCtx.set(workingGit());
  });

  afterEach(async () => {
    cloneRepoSpawnCtx.reset();
    resetCoordinatorHome();
    resetUserHome();
    await rm(baseDir, { recursive: true, force: true });
  });

  test("resolveCloneRoot defaults to ~/Developer and expands a leading ~", async () => {
    expect(await resolveCloneRoot()).toBe(join(baseDir, "Developer"));
    await writeConfig(defaultUserConfigPath(), "repos.cloneRoot", "~/src/");
    expect(await resolveCloneRoot()).toBe(join(baseDir, "src"));
    await writeConfig(defaultUserConfigPath(), "repos.cloneRoot", "/opt/code");
    expect(await resolveCloneRoot()).toBe("/opt/code");
    await writeConfig(defaultUserConfigPath(), "repos.cloneRoot", "  ");
    expect(await resolveCloneRoot()).toBe(join(baseDir, "Developer"));
  });

  test("cloneRootRelPath is set only strictly inside the root, compared after realpath", async () => {
    await mkdir(join(root, "swift-packages", "Foo"), { recursive: true });
    await mkdir(join(baseDir, "Developer2", "Bar"), { recursive: true });
    await symlink(root, join(baseDir, "dev-link"));
    expect(await cloneRootRelPath(join(root, "swift-packages", "Foo"), root)).toBe("swift-packages/Foo");
    // The repo through a symlink, and the root through one: both resolve.
    expect(await cloneRootRelPath(join(baseDir, "dev-link", "swift-packages", "Foo"), root)).toBe("swift-packages/Foo");
    expect(await cloneRootRelPath(join(root, "swift-packages", "Foo"), join(baseDir, "dev-link"))).toBe("swift-packages/Foo");
    expect(await cloneRootRelPath(root, root)).toBeNull();
    expect(await cloneRootRelPath(join(baseDir, "Developer2", "Bar"), root)).toBeNull();
    expect(await cloneRootRelPath(baseDir, root)).toBeNull();
    expect(await cloneRootRelPath(join(root, "missing"), root)).toBeNull();
    expect(await cloneRootRelPath(join(root, "swift-packages"), join(baseDir, "no-root"))).toBeNull();
  });

  test("readRepoCloneInfo reads the origin as configured; a failed read is null", async () => {
    const repo = join(root, "html", "site");
    await mkdir(repo, { recursive: true });
    cloneRepoSpawnCtx.set(workingGit("git@github.com:owner/site.git"));
    expect(await readRepoCloneInfo(repo, root)).toEqual({ remoteUrl: "git@github.com:owner/site.git", relPath: "html/site" });
    expect(calls.map((c) => c.cmd)).toEqual([["git", "-C", repo, "config", "--get", "remote.origin.url"]]);
    cloneRepoSpawnCtx.set(workingGit(null));
    expect(await readRepoCloneInfo(repo, root)).toEqual({ remoteUrl: null, relPath: "html/site" });
    cloneRepoSpawnCtx.set(() => { throw new Error('Executable not found in $PATH: "git"'); });
    expect(await readRepoCloneInfo(join(baseDir, "elsewhere"), root)).toEqual({ remoteUrl: null, relPath: null });
  });

  test("clones into a new folder, creating its parents, with prompts off, then registers it", async () => {
    const dest = join(root, "swift-packages", "foo");
    const url = "git@github.com:owner/Foo.git";
    const result = await cloneRepo({ url, dest, registryName: "foo" });
    expect(result).toEqual({ ok: true, message: `Cloned and added: foo (${dest})`, path: dest });
    expect(calls.map((c) => c.cmd)).toEqual([["git", "clone", "--", url, dest]]);
    expect(calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: expect.stringMatching(/ -o BatchMode=yes$/) });
    // The user's own environment comes along (PATH, the SSH agent).
    expect(calls[0]!.env?.PATH).toBe(process.env.PATH);
    expect((await loadRegistry()).repos).toEqual([{ path: dest, name: "foo" }]);
  });

  test("a leading ~ in the destination is expanded", async () => {
    const result = await cloneRepo({ url: "https://github.com/owner/foo", dest: "~/Developer/foo", registryName: "foo" });
    expect(result.path).toBe(join(root, "foo"));
    expect((await loadRegistry()).repos).toEqual([{ path: join(root, "foo"), name: "foo" }]);
  });

  test("an existing clone of the same origin is registered without cloning", async () => {
    const dest = join(root, "foo");
    await mkdir(join(dest, ".git"), { recursive: true });
    // Same repo once a trailing ".git" and "/" are trimmed.
    cloneRepoSpawnCtx.set(workingGit("https://github.com/owner/foo.git/"));
    const result = await cloneRepo({ url: "https://github.com/owner/foo", dest, registryName: "foo" });
    expect(result).toEqual({ ok: true, message: `Added the existing clone: foo (${dest})`, path: dest });
    expect(calls.map((c) => c.cmd)).toEqual([["git", "-C", dest, "config", "--get", "remote.origin.url"]]);
    expect((await loadRegistry()).repos).toEqual([{ path: dest, name: "foo" }]);
  });

  test("an existing clone of another origin, or with none, is refused and left alone", async () => {
    const dest = join(root, "foo");
    await mkdir(join(dest, ".git"), { recursive: true });
    cloneRepoSpawnCtx.set(workingGit("git@github.com:someone-else/foo.git"));
    const other = await cloneRepo({ url: "git@github.com:owner/foo.git", dest, registryName: "foo" });
    expect(other).toEqual({
      ok: false,
      message: `${dest} already exists with origin git@github.com:someone-else/foo.git, not git@github.com:owner/foo.git — choose another folder`,
    });
    cloneRepoSpawnCtx.set(workingGit(null));
    const none = await cloneRepo({ url: "git@github.com:owner/foo.git", dest, registryName: "foo" });
    expect(none.message).toContain("already exists with origin (none)");
    expect(calls.some((c) => c.cmd[1] === "clone")).toBe(false);
    expect(await readdir(dest)).toEqual([".git"]);
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test("an existing folder that is not a git repo is refused without running git", async () => {
    const dest = join(root, "foo");
    await mkdir(dest);
    const result = await cloneRepo({ url: "git@github.com:owner/foo.git", dest, registryName: "foo" });
    expect(result).toEqual({ ok: false, message: `${dest} already exists and is not a git repo — choose another folder` });
    expect(calls).toEqual([]);
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test("a registry clash is refused before cloning, so no orphan clone is left", async () => {
    await saveRegistry({ repos: [{ path: "/elsewhere/foo-app", name: "FOO" }] });
    const dest = join(root, "foo");
    const result = await cloneRepo({ url: "git@github.com:owner/foo.git", dest, registryName: "foo" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already the name of a registered repo (/elsewhere/foo-app)");
    expect(result.message).toEndWith("a clone keeps the peer's repo name");
    expect(result.path).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  test("a URL outside the allowlist is refused without running git", async () => {
    const result = await cloneRepo({ url: "ext::sh -c touch% /tmp/pwned", dest: join(root, "foo"), registryName: "foo" });
    expect(result).toEqual({ ok: false, message: 'Will not clone "ext::sh -c touch% /tmp/pwned": only ssh://, https:// and user@host:path URLs are allowed' });
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  test("a failed clone reports git's stderr on one line and registers nothing", async () => {
    cloneRepoSpawnCtx.set(fakeGit(() => ({
      exitCode: 128,
      stderr: "Cloning into '/x'...\nHost key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\n",
    })));
    const result = await cloneRepo({ url: "git@github.com:owner/foo.git", dest: join(root, "foo"), registryName: "foo" });
    expect(result).toEqual({
      ok: false,
      message: "git clone failed: Cloning into '/x'... Host key verification failed. fatal: Could not read from remote repository. Please make sure you have the correct access rights",
    });
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test("a registry write that fails after the clone keeps the clone and says so", async () => {
    // A read-only registry dir: the pre-checks only read it, so they pass, and
    // addRepo's saveRegistry then throws EACCES creating repos.json.
    const registryDir = join(baseDir, ".itsybitsy");
    const dest = join(root, "foo");
    await chmod(registryDir, 0o555);
    try {
      const result = await cloneRepo({ url: "git@github.com:owner/foo.git", dest, registryName: "foo" });
      expect(result.ok).toBe(false);
      expect(result.path).toBe(dest);
      expect(result.message).toStartWith(`Cloned into ${dest}, but could not add it: `);
      expect(result.message).toContain("EACCES");
      expect(await readdir(dest)).toEqual([".git"]);
    } finally {
      await chmod(registryDir, 0o755);
    }
    expect((await loadRegistry()).repos).toEqual([]);
  });
});
