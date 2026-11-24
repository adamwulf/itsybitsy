import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { chmod, mkdtemp, mkdir, readdir, realpath, rm, symlink } from "fs/promises";
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
  stripUrlCredentials,
} from "./clone-repo";
import { writeConfig, defaultUserConfigPath } from "./config";
import { loadRegistry, saveRegistry } from "./registry";
import { setUserHome, resetUserHome } from "./home";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import type { SpawnFn } from "./types";

/** Whether the temp volume ignores case (the APFS default), so a typed `myapp` names an existing `MyApp`. */
const caseInsensitiveTmp = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ib-case-probe-"));
  try {
    mkdirSync(join(dir, "Probe"));
    return existsSync(join(dir, "probe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

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
    // User-less scp-style: an SSH-config alias, or a host with the user in ~/.ssh/config.
    "gh-work:org/repo.git",
    "host.example:path/to/repo",
    "localhost:/srv/repo.git",
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
    // The authority, userinfo included, may not start with "-" either.
    "ssh://-oProxyCommand=x@host/repo",
    "https://-x@host/repo",
    "ssh://",
    "https:///path",
    "git@-host:path",
    "-host:path",
    "git@host:",
    "host:",
    // <transport>::<address> remote helpers, and other schemes, stay out.
    "fd::17",
    "host::path",
    "git+ssh://host/repo",
    "ssh+git://host/repo",
    // A slash or an "@" before the colon is not a host.
    "./dir:path",
    "dir/sub:path",
    "a@b@host:path",
    "git@github.com:owner/repo name",
    "host:owner\\repo",
    "https://github.com/owner/repo\n",
    "https://github.com/owner/\x1b[31mrepo",
    "git@github.com:owner/repo\0",
  ])("refuses %p", (url) => {
    expect(isAllowedCloneUrl(url)).toBe(false);
  });
});

describe("stripUrlCredentials", () => {
  test.each([
    ["https://user:token@github.com/owner/repo.git", "https://github.com/owner/repo.git"],
    ["https://ghp_token@github.com/owner/repo", "https://github.com/owner/repo"],
    ["https://user:p@ss@github.com/owner/repo", "https://github.com/owner/repo"],
    ["https://user:token@github.com", "https://github.com"],
    ["https://user:token@host:8443/repo?x=1", "https://host:8443/repo?x=1"],
    ["http://token@host/repo", "http://host/repo"],
    ["ssh://git:secret@github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"],
    ["ssh://git:secret@host:2222/srv/repo", "ssh://git@host:2222/srv/repo"],
    ["git+ssh://git:secret@host/repo", "git+ssh://git@host/repo"],
    ["ssh://:secret@host/repo", "ssh://host/repo"],
  ])("strips %p", (url, stripped) => {
    expect(stripUrlCredentials(url)).toBe(stripped);
  });

  test.each([
    "ssh://git@github.com/owner/repo.git",
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo@v1",
    "git@github.com:owner/repo.git",
    "user@host.example:path/to/repo",
    "/local/path",
  ])("leaves %p alone", (url) => {
    expect(stripUrlCredentials(url)).toBe(url);
  });
});

// The clone's ssh setup follows git's precedence: GIT_SSH_COMMAND, then
// core.sshCommand, then GIT_SSH; each gets BatchMode where it can take it.
describe("cloneEnv", () => {
  let reads: string[][];
  /** A git whose `config --get core.sshCommand` prints `value`, or exits 1 when null. */
  const coreSshCommand = (value: string | null) => {
    reads = [];
    cloneRepoSpawnCtx.set(((cmd: string[]) => {
      reads.push(cmd);
      return { stdout: new Response(value ?? "").body, stderr: new Response("").body, exited: Promise.resolve(value === null ? 1 : 0) };
    }) as SpawnFn);
  };
  afterEach(() => cloneRepoSpawnCtx.reset());

  test("GIT_SSH_COMMAND set: BatchMode is appended to it, and core.sshCommand is not read", async () => {
    coreSshCommand("ssh -i ~/.ssh/config-key");
    expect(await cloneEnv({ PATH: "/bin", GIT_SSH_COMMAND: "ssh -i ~/.ssh/work " })).toEqual({
      PATH: "/bin", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -i ~/.ssh/work -o BatchMode=yes",
    });
    expect(reads).toEqual([]);
  });

  test("else core.sshCommand: it becomes GIT_SSH_COMMAND with BatchMode, ahead of GIT_SSH", async () => {
    coreSshCommand("ssh -i ~/.ssh/config-key\n");
    expect(await cloneEnv({ PATH: "/bin", GIT_SSH: "/usr/bin/plink" })).toEqual({
      PATH: "/bin", GIT_SSH: "/usr/bin/plink", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -i ~/.ssh/config-key -o BatchMode=yes",
    });
    // Read from "/", outside any repo: the user's global and system config,
    // never the local config of a repo ib watch was started in.
    expect(reads).toEqual([["git", "-C", "/", "config", "--get", "core.sshCommand"]]);
  });

  test("with real git, reading from / still finds core.sshCommand in the global config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-clone-env-" + crypto.randomUUID() + "-"));
    try {
      const globalConfig = join(dir, "gitconfig");
      await Bun.write(globalConfig, "[core]\n\tsshCommand = ssh -i /keys/work\n");
      cloneRepoSpawnCtx.set(((cmd: string[], opts?: Parameters<SpawnFn>[1]) => Bun.spawn(cmd, { ...opts })) as SpawnFn);
      const { GIT_SSH_COMMAND: _command, GIT_SSH: _ssh, ...rest } = process.env;
      const env = await cloneEnv({ ...rest, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" });
      expect(env.GIT_SSH_COMMAND).toBe("ssh -i /keys/work -o BatchMode=yes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("else GIT_SSH: the ssh environment is left alone, since plink takes no -o", async () => {
    coreSshCommand(null);
    expect(await cloneEnv({ PATH: "/bin", GIT_SSH: "/usr/bin/plink" })).toEqual({
      PATH: "/bin", GIT_SSH: "/usr/bin/plink", GIT_TERMINAL_PROMPT: "0",
    });
  });

  test("else plain ssh in batch mode; a blank GIT_SSH_COMMAND or a failed config read counts as unset", async () => {
    coreSshCommand(null);
    expect(await cloneEnv({ PATH: "/bin", SSH_AUTH_SOCK: "/tmp/agent" })).toEqual({
      PATH: "/bin", SSH_AUTH_SOCK: "/tmp/agent", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
    expect((await cloneEnv({ GIT_SSH_COMMAND: " " })).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    coreSshCommand("");
    expect((await cloneEnv({})).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    cloneRepoSpawnCtx.set(() => { throw new Error('Executable not found in $PATH: "git"'); });
    expect(await cloneEnv({})).toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
  });
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
    // Real path: the clone registers the on-disk spelling (/var is /private/var on macOS).
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "ib-clone-repo-" + crypto.randomUUID() + "-")));
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

  test("readRepoCloneInfo reads the origin as configured, minus credentials; a failed read is null", async () => {
    const repo = join(root, "html", "site");
    await mkdir(repo, { recursive: true });
    cloneRepoSpawnCtx.set(workingGit("git@github.com:owner/site.git"));
    expect(await readRepoCloneInfo(repo, root)).toEqual({ remoteUrl: "git@github.com:owner/site.git", relPath: "html/site" });
    expect(calls.map((c) => c.cmd)).toEqual([["git", "-C", repo, "config", "--get", "remote.origin.url"]]);
    cloneRepoSpawnCtx.set(workingGit("https://x-access-token:ghp_secret@github.com/owner/site.git"));
    expect(await readRepoCloneInfo(repo, root)).toEqual({ remoteUrl: "https://github.com/owner/site.git", relPath: "html/site" });
    cloneRepoSpawnCtx.set(workingGit("ssh://git:secret@host/site.git"));
    expect((await readRepoCloneInfo(repo, root)).remoteUrl).toBe("ssh://git@host/site.git");
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
    const clones = calls.filter((c) => c.cmd[1] === "clone");
    expect(clones.map((c) => c.cmd)).toEqual([["git", "clone", "--", url, dest]]);
    // cloneEnv's environment (its branches are covered above), with the
    // user's own one along with it (PATH, the SSH agent).
    expect(clones[0]!.env).toEqual(await cloneEnv());
    expect(clones[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", PATH: process.env.PATH });
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

  test("an existing clone whose origin carries a token matches the peer's stripped URL", async () => {
    const dest = join(root, "foo");
    await mkdir(join(dest, ".git"), { recursive: true });
    cloneRepoSpawnCtx.set(workingGit("https://x-access-token:ghp_secret@github.com/owner/foo.git"));
    const result = await cloneRepo({ url: "https://github.com/owner/foo", dest, registryName: "foo" });
    expect(result).toEqual({ ok: true, message: `Added the existing clone: foo (${dest})`, path: dest });
    expect(calls.some((c) => c.cmd[1] === "clone")).toBe(false);
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
    // The refusal names the local origin without its token.
    cloneRepoSpawnCtx.set(workingGit("https://user:ghp_secret@github.com/someone-else/foo.git"));
    const tokened = await cloneRepo({ url: "git@github.com:owner/foo.git", dest, registryName: "foo" });
    expect(tokened.message).toContain("already exists with origin https://github.com/someone-else/foo.git, not");
    expect(tokened.message).not.toContain("ghp_secret");
    cloneRepoSpawnCtx.set(workingGit(null));
    const none = await cloneRepo({ url: "git@github.com:owner/foo.git", dest, registryName: "foo" });
    expect(none.message).toContain("already exists with origin (none)");
    expect(calls.some((c) => c.cmd[1] === "clone")).toBe(false);
    expect(await readdir(dest)).toEqual([".git"]);
    expect((await loadRegistry()).repos).toEqual([]);
  });

  test.if(caseInsensitiveTmp)("a typed myapp that names an existing MyApp registers the on-disk spelling", async () => {
    await mkdir(join(root, "MyApp", ".git"), { recursive: true });
    cloneRepoSpawnCtx.set(workingGit("git@github.com:owner/myapp.git"));
    const result = await cloneRepo({ url: "git@github.com:owner/myapp.git", dest: join(root, "myapp"), registryName: "myapp" });
    const real = join(root, "MyApp");
    expect(result).toEqual({ ok: true, message: `Added the existing clone: myapp (${real})`, path: real });
    expect(calls.map((c) => c.cmd)).toEqual([["git", "-C", real, "config", "--get", "remote.origin.url"]]);
    expect((await loadRegistry()).repos).toEqual([{ path: real, name: "myapp" }]);
  });

  test.if(caseInsensitiveTmp)("a new clone under an existing folder spelled differently uses that folder's spelling", async () => {
    await mkdir(join(root, "Swift"));
    const url = "git@github.com:owner/foo.git";
    const result = await cloneRepo({ url, dest: join(root, "swift", "foo"), registryName: "foo" });
    const real = join(root, "Swift", "foo");
    expect(result.path).toBe(real);
    expect(calls.filter((c) => c.cmd[1] === "clone").map((c) => c.cmd)).toEqual([["git", "clone", "--", url, real]]);
    expect((await loadRegistry()).repos).toEqual([{ path: real, name: "foo" }]);
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
    expect(result).toEqual({ ok: false, message: 'Will not clone "ext::sh -c touch% /tmp/pwned": only ssh://, https:// and [user@]host:path URLs are allowed' });
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
