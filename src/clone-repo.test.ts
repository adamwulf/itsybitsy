import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { chmod, mkdtemp, mkdir, readdir, realpath, rm, symlink } from "fs/promises";
import { tmpdir } from "os";
import {
  checkCloneUrl,
  cloneDestination,
  cloneEnv,
  cloneRepo,
  cloneRepoSpawnCtx,
  cloneRootRelPath,
  readRepoCloneInfo,
  resolveCloneRoot,
  stripUrlCredentials,
} from "./clone-repo";
import { writeConfig, defaultUserConfigPath } from "./config";
import { loadRegistry, saveRegistry } from "./registry";
import { setUserHome, resetUserHome } from "./home";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import type { SpawnFn } from "./types";

/** Whether the grammar accepts `url`. */
const parses = (url: string) => "parts" in checkCloneUrl(url);
/** The notice for a refused `url`, or null. */
const refusalOf = (url: string) => {
  const checked = checkCloneUrl(url);
  return "refusal" in checked ? checked.refusal : null;
};
/** A `git -C / clone --quiet -- <url> <target>` command. */
const isClone = (cmd: string[]) => cmd[3] === "clone";

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

describe("checkCloneUrl", () => {
  test.each([
    "git@github.com:o/r.git",
    "user@host.example:path/to/repo",
    // User-less scp-style: an SSH-config alias, or a host with the user in ~/.ssh/config.
    "gh-work:org/repo.git",
    "github_work:org/repo.git",
    "host.example:path/to/repo",
    "localhost:/srv/repo.git",
    "git@[::1]:srv/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "ssh://git@host:2222/p",
    "ssh://git@[::1]:22/x",
    "ssh://host.example/srv/repo",
    "https://github.com/o/r.git",
    "https://host:8443/x",
    // Azure DevOps v3: %20 in a project name, scp-style and https.
    "git@ssh.dev.azure.com:v3/org/My%20Project/repo",
    "https://dev.azure.com/org/My%20Project/_git/repo",
    // AWS CodeCommit: an SSH key id as the user.
    "ssh://APKAEIBAERJR2EXAMPLE@git-codecommit.us-east-2.amazonaws.com/v1/repos/MyDemoRepo",
    "APKAEIBAERJR2EXAMPLE@git-codecommit.us-east-2.amazonaws.com:v1/repos/MyDemoRepo",
  ])("allows %p", (url) => {
    expect(parses(url)).toBe(true);
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
    // No user or host starts with "-" (or "."), bracketed or not.
    "-x@host:path",
    "ssh://-oProxyCommand=touch/repo",
    "ssh://git@-oProxyCommand=x/repo",
    "ssh://-oProxyCommand=x@host/repo",
    "https://-host/repo",
    "git@-host:path",
    "-host:path",
    ".user@host:path",
    "git@.host:path",
    "[-oProxyCommand=x]:repo",
    "git@[-oProxyCommand=x]:repo",
    "ssh://[-oProxyCommand=x]/repo",
    "ssh://git@[-oProxyCommand=x]/repo",
    "https://[-x]/repo",
    // Git takes the ssh host from the first "@[" anywhere (path included, after
    // %-decoding an ssh:// URL) and unwraps brackets before splitting off the
    // user: "@", "[" and "]" appear only around the user and host, brackets
    // only around an IPv6 host, and an ssh:// URL has no "%" at all.
    "git@github.com:o/r@[evil.example]:x",
    "ssh://git@github.com/o%40%5Bevil.example%5D/r",
    "[evil.example]@github.com:o/r",
    "[-oProxyCommand=x@host]:repo",
    "ssh://[-oProxyCommand=x@host]/repo",
    "[host.example]:repo",
    "ssh://%2DoProxyCommand=x/repo",
    "ssh://git@%2Dhost/repo",
    "ssh://%2Doops@host/repo",
    "ssh://git@host/My%20Project/repo",
    "git@github.com:o/r]",
    // A user's insteadOf rule can turn an https:// or scp-style URL into an
    // ssh:// one, which git %-decodes: no %40, %5B or %5D in any form or case.
    "https://github.com/o%40%5Bevil.example%5D/r",
    "https://github.com/o%40evil.example/r",
    "https://github.com/o/%5bx%5d",
    "git@github.com:o%40%5Bevil.example%5D/r",
    "gh-work:o/%5Dr",
    // Brackets wrap only a real IPv6 address: git reads a trailing :digits
    // inside them as the port.
    "git@[cafe.de:22]:o/r",
    "ssh://git@[fade.be:2222]/o/r",
    "[1:22]:o/r",
    "https://[cafe.de]/o/r",
    "git@[::1%en0]:o/r",
    "ssh://[::1]x/o/r",
    // A host the title could misread: https userinfo, an email-style or
    // hostname-looking ssh user with no path, a %-encoded https host.
    "https://token@github.com/owner/repo",
    "https://-x@host/repo",
    "https://github.com@evil.example/owner/repo",
    "https://github.com?@evil.example/owner/repo",
    "https://github.com%2eevil.example/owner/repo",
    "ssh://git@github.com@evil.example/owner/repo",
    "ssh://github.com@evil.example/",
    "ssh://jane@corp.com@gerrit.corp.com/project",
    "ssh://",
    "https:///path",
    "https://github.com",
    "ssh://host/",
    "ssh://host:123456/repo",
    "git@host:",
    "host:",
    // <transport>::<address> remote helpers, and other schemes (git's is_url), stay out.
    "fd::17",
    "host::path",
    "git+ssh://host/repo",
    "ssh+git://host/repo",
    "1host://x/y",
    // A slash or an "@" before the colon is not a host.
    "./dir:path",
    "dir/sub:path",
    "a@b@host:path",
    "git@github.com:owner/repo name",
    "host:owner\\repo",
    "https://github.com/owner/repo\n",
    "https://github.com/owner/\x1b[31mrepo",
    "https://github.com/owner/\u202erepo",
    "git@github.com:owner/repo\0",
  ])("refuses %p", (url) => {
    expect(parses(url)).toBe(false);
  });

  test("checkCloneUrl gives the host git connects to and the path, which the dialog title shows", () => {
    expect(checkCloneUrl("git@github.com:o/r.git")).toEqual({ parts: { host: "github.com", path: "o/r.git" } });
    expect(checkCloneUrl("gh-work:org/repo.git")).toEqual({ parts: { host: "gh-work", path: "org/repo.git" } });
    expect(checkCloneUrl("ssh://git@[::1]:22/x")).toEqual({ parts: { host: "[::1]", path: "x" } });
    expect(checkCloneUrl("https://host:8443/o/r")).toEqual({ parts: { host: "host", path: "o/r" } });
    expect(checkCloneUrl("localhost:/srv/repo.git")).toEqual({ parts: { host: "localhost", path: "/srv/repo.git" } });
    // A user that looks like a host is allowed; the host shown is the real one.
    expect(checkCloneUrl("ssh://github.com@evil.example/o/r")).toEqual({ parts: { host: "evil.example", path: "o/r" } });
  });

  test.each([
    ["ftp://host/repo", "not an ssh://, https:// or [user@]host:path URL"],
    ["ext::sh -c id", "not an ssh://, https:// or [user@]host:path URL"],
    ["repo", "not an ssh://, https:// or [user@]host:path URL"],
    ["https://github.com/o%40%5Bevil.example%5D/r", "it holds %40, %5B or %5D"],
    ["ssh://git@host/My%20Project/repo", "an ssh:// URL may not hold %"],
    ["https://token@github.com/o/r", "an https:// URL may not name a user"],
    // One rule each, with no contradiction for an email-style user.
    ["ssh://jane@corp.com@gerrit.corp.com/project", "an email-style ssh user is not supported"],
    ["-x@host:path", `the user may hold only letters, digits, ".", "_" and "-", not leading "-" or "."`],
    ["git@-host:path", `the host may hold only letters, digits, ".", "_" and "-", not leading "-" or "."`],
    ["https://github.com%2eevil.example/o/r", `the host may hold only letters, digits, ".", "_" and "-", not leading "-" or "."`],
    ["git@[cafe.de:22]:o/r", "a bracketed host must be an IPv6 address"],
    ["git@:o/r", "it has no host"],
    ["ssh://git@host:123456/repo", "the port must be 1 to 5 digits"],
    ["ssh://host/", "it has no path"],
    ["https://github.com", "it has no path"],
    ["git@github.com:o/r@[evil.example]:x", "the path may not hold @, [, ], a backslash, spaces or control characters"],
  ])("the refusal of %p names the rule first and the URL last", (url, rule) => {
    expect(refusalOf(url)).toBe(`Will not clone: ${rule} (${url})`);
  });

  test("the URL in a refusal is escaped, so a notice stays one line", () => {
    expect(refusalOf("https://github.com/o/r\nx")).toBe(String.raw`Will not clone: the path may not hold @, [, ], a backslash, spaces or control characters (https://github.com/o/r\nx)`);
    expect(refusalOf("git@github.com:o/r.git")).toBeNull();
  });
});

describe("stripUrlCredentials", () => {
  const stripCases: [string, string][] = [
    ["https://user:token@github.com/owner/repo.git", "https://github.com/owner/repo.git"],
    ["https://ghp_token@github.com/owner/repo", "https://github.com/owner/repo"],
    ["https://user:p@ss@github.com/owner/repo", "https://github.com/owner/repo"],
    ["https://user:token@host:8443/repo?x=1", "https://host:8443/repo?x=1"],
    ["https://org@dev.azure.com/org/My%20Project/_git/repo", "https://dev.azure.com/org/My%20Project/_git/repo"],
    ["ssh://git:secret@github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"],
    ["ssh://git:secret@host:2222/srv/repo", "ssh://git@host:2222/srv/repo"],
    ["ssh://:secret@host/repo", "ssh://host/repo"],
  ];
  test.each([
    ...stripCases,
    // Not clone URLs, but stripped all the same.
    ["https://user:token@github.com", "https://github.com"],
    ["http://token@host/repo", "http://host/repo"],
    ["git+ssh://git:secret@host/repo", "git+ssh://git@host/repo"],
  ])("strips %p", (url, stripped) => {
    expect(stripUrlCredentials(url)).toBe(stripped);
  });

  test.each(stripCases)("what the sender sends for %p is a URL the receiver will clone", (url) => {
    expect(parses(stripUrlCredentials(url))).toBe(true);
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
      PATH: "/bin", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "ssh:https", GIT_SSH_COMMAND: "ssh -i ~/.ssh/work -o BatchMode=yes",
    });
    expect(reads).toEqual([]);
  });

  test("else core.sshCommand: it becomes GIT_SSH_COMMAND with BatchMode, ahead of GIT_SSH", async () => {
    coreSshCommand("ssh -i ~/.ssh/config-key\n");
    expect(await cloneEnv({ PATH: "/bin", GIT_SSH: "/usr/bin/plink" })).toEqual({
      PATH: "/bin", GIT_SSH: "/usr/bin/plink", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "ssh:https", GIT_SSH_COMMAND: "ssh -i ~/.ssh/config-key -o BatchMode=yes",
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
      PATH: "/bin", GIT_SSH: "/usr/bin/plink", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "ssh:https",
    });
  });

  test("else plain ssh in batch mode; a blank GIT_SSH_COMMAND or a failed config read counts as unset", async () => {
    coreSshCommand(null);
    expect(await cloneEnv({ PATH: "/bin", SSH_AUTH_SOCK: "/tmp/agent" })).toEqual({
      PATH: "/bin", SSH_AUTH_SOCK: "/tmp/agent", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "ssh:https", GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
    expect((await cloneEnv({ GIT_SSH_COMMAND: " " })).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    coreSshCommand("");
    expect((await cloneEnv({})).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    cloneRepoSpawnCtx.set(() => { throw new Error('Executable not found in $PATH: "git"'); });
    expect(await cloneEnv({})).toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "ssh:https", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
  });

  test("the fixed keys override the user's own values", async () => {
    coreSshCommand(null);
    const env = await cloneEnv({ GIT_ALLOW_PROTOCOL: "ext:file:http", GIT_TERMINAL_PROMPT: "1" });
    expect(env.GIT_ALLOW_PROTOCOL).toBe("ssh:https");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
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
    if (isClone(cmd)) {
      mkdirSync(join(cmd.at(-1)!, ".git"), { recursive: true });
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
    const clones = calls.filter((c) => isClone(c.cmd));
    expect(clones.map((c) => c.cmd)).toEqual([["git", "-C", "/", "clone", "--quiet", "--", url, dest]]);
    // cloneEnv's environment (its branches are covered above), with the
    // user's own one along with it (PATH, the SSH agent).
    expect(clones[0]!.env).toEqual(await cloneEnv());
    expect(clones[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "ssh:https", PATH: process.env.PATH });
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
    expect(calls.some((c) => isClone(c.cmd))).toBe(false);
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
    expect(calls.some((c) => isClone(c.cmd))).toBe(false);
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
    expect(calls.filter((c) => isClone(c.cmd)).map((c) => c.cmd)).toEqual([["git", "-C", "/", "clone", "--quiet", "--", url, real]]);
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

  test("a URL the grammar refuses is refused without running git", async () => {
    const result = await cloneRepo({ url: "ext::sh -c touch% /tmp/pwned", dest: join(root, "foo"), registryName: "foo" });
    // The same text the dashboard shows when c is pressed.
    expect(result).toEqual({ ok: false, message: "Will not clone: not an ssh://, https:// or [user@]host:path URL (ext::sh -c touch% /tmp/pwned)" });
    expect(result.message).toBe(refusalOf("ext::sh -c touch% /tmp/pwned")!);
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

  test("a hostile server's escapes in git's stderr never reach the notice", async () => {
    // ssh passes the server's stderr through: an OSC 52 clipboard write, a
    // carriage return, a clear-screen, a bidi override, DEL and the C1 CSI.
    cloneRepoSpawnCtx.set(fakeGit((cmd) => isClone(cmd)
      ? { exitCode: 128, stderr: "remote: \x1b]52;c;eA==\x07hello\r\nfatal: \x1b[2Jbad\u202e\x7f\x9b31mz\n" }
      : { exitCode: 1 }));
    const result = await cloneRepo({ url: "git@github.com:owner/foo.git", dest: join(root, "foo"), registryName: "foo" });
    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(result.message).toBe("git clone failed: remote: ]52;c;eA== hello fatal: [2Jbad 31mz");
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
