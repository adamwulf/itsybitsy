/**
 * "Clone here" for a repo only a peer has registered (SPEC §20.5): clone it
 * from the remote URL the peer reports and register it under the peer's
 * registry name, so its header joins the peer's on its own. Also the sending
 * side of that URL: each registered repo's origin URL and its path relative
 * to the clone root, which `ib watch` caches for the peer snapshot (SPEC
 * §20.4). Lives outside the TUI, like create-repo.ts, so it can be tested on
 * its own.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { mkdir, realpath, stat } from "fs/promises";
import { SpawnContext } from "./types";
import { readConfig } from "./config";
import { userHome } from "./home";
import { addRepo, checkNewRepoEntry, readRegistryStrict } from "./registry";
import { hasGitEntry } from "./create-repo";

/**
 * Runs git: `git clone`, and `git config --get remote.origin.url` for both the
 * existing-folder check and the peer snapshot's cache. Tests swap in a fake
 * git; the test preload makes its reset baseline a no-op stub, since every
 * dashboard `setRepos` reads each repo's origin through it.
 */
export const cloneRepoSpawnCtx = new SpawnContext();

/** What the peer snapshot sends for one registered repo (RemoteRepo's clone fields). */
export interface RepoCloneInfo {
  /** `remote.origin.url` as configured, minus credentials ({@link stripUrlCredentials}), or null when there is none. */
  remoteUrl: string | null;
  /** The repo's path under this install's clone root, e.g. `swift-packages/Foo`, or null when it is not inside it. */
  relPath: string | null;
}

/** Expand a leading `~` against userHome(), then make the path absolute and normal. */
function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) return resolve(userHome(), path.slice(2));
  return resolve(path);
}

/** `repos.cloneRoot` as an absolute path; unset or blank means `~/Developer`. */
export async function resolveCloneRoot(): Promise<string> {
  const value = (await readConfig())["repos.cloneRoot"]?.value;
  return expandHome(typeof value === "string" && value.trim() ? value.trim() : "~/Developer");
}

/**
 * Where a peer's repo is cloned: under the same folders below the clone root
 * as on the peer (`swift/…`, `html/…`), in a folder named after the registry
 * name, since the registry and coordinator naming rules key on the folder name.
 */
export function cloneDestination(cloneRoot: string, registryName: string, relPath: string | null): string {
  return relPath ? join(cloneRoot, dirname(relPath), registryName) : join(cloneRoot, registryName);
}

/** A clone URL's user (null when it has none) and host, as git will connect to them. */
export interface CloneUrlParts {
  user: string | null;
  host: string;
}

// The positive grammar of the URLs "Clone here" passes to git. Git takes the
// ssh host from the first "@[" anywhere in a URL (path included, and after
// %-decoding an ssh:// URL) and unwraps brackets before it splits the user
// from the host, so nothing outside these parts may hold "@", "[" or "]".
const USER = String.raw`[A-Za-z0-9_][A-Za-z0-9._-]*`;
const HOST = String.raw`[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\]`;
const PORT = String.raw`(?::[0-9]{1,5})?`;
const PATH = String.raw`[^@\[\]\\\s\p{Cc}\p{Cf}]+`;
const SSH_PATH = String.raw`[^@\[\]\\\s\p{Cc}\p{Cf}%]+`;
const SCP_URL = new RegExp(String.raw`^(?:(${USER})@)?(${HOST}):(?!:)${PATH}$`, "u");
const SSH_URL = new RegExp(String.raw`^ssh://(?:(${USER})@)?(${HOST})${PORT}/${SSH_PATH}$`, "u");
const HTTPS_URL = new RegExp(String.raw`^https://(${HOST})${PORT}/${PATH}$`, "u");

/**
 * Parse a URL "Clone here" may pass to git, or null when it is refused. Only
 * these forms are accepted:
 *
 *   [user@]host:path                    scp-style; the colon is not followed by another
 *   ssh://[user@]host[:port]/path
 *   https://host[:port]/path            no user at all
 *
 * - user: `[A-Za-z0-9._-]+`, not starting with `-` or `.`.
 * - host: `[A-Za-z0-9.-]+` not starting with `-` or `.`, or a bracketed IPv6
 *   address `[0-9A-Fa-f:.]`; brackets appear nowhere else.
 * - port: 1 to 5 digits.
 * - path: no `@`, `[`, `]`, backslash, whitespace, control or format
 *   character; an ssh:// URL has no `%` anywhere (git decodes it), while an
 *   https:// or scp-style path may hold one (Azure's `%20`).
 *
 * Any other `scheme://` is refused, so `ext::`, `file://` and `http://` stay
 * out. An email-style ssh user (`jane@corp.com@host`) is refused too.
 */
export function parseCloneUrl(url: string): CloneUrlParts | null {
  const ssh = SSH_URL.exec(url);
  if (ssh) return { user: ssh[1] ?? null, host: ssh[2]! };
  const https = HTTPS_URL.exec(url);
  if (https) return { user: null, host: https[1]! };
  // Any other scheme:// is a URL git would not read as scp-style.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  const scp = SCP_URL.exec(url);
  return scp ? { user: scp[1] ?? null, host: scp[2]! } : null;
}

/** Whether "Clone here" may pass `url` to git ({@link parseCloneUrl}). */
export function isAllowedCloneUrl(url: string): boolean {
  return parseCloneUrl(url) !== null;
}

/** Why `url` will not be cloned, or null when {@link isAllowedCloneUrl} allows it. */
export function cloneUrlRefusal(url: string): string | null {
  return isAllowedCloneUrl(url)
    ? null
    : `Will not clone ${JSON.stringify(url)}: only ssh://, https:// and [user@]host:path URLs are allowed`;
}

/**
 * `url` without the credentials an origin can carry, so none reach a peer:
 * a `scheme://` URL loses its userinfo (`https://user:token@host/…` and
 * `https://token@host/…` become `https://host/…`), except that an ssh URL
 * keeps its user and loses only the password (`ssh://user:pass@host/…`
 * becomes `ssh://user@host/…`). An scp-style `user@host:path` has no password
 * and is unchanged, as is anything else.
 */
export function stripUrlCredentials(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (!scheme) return url;
  const start = scheme[0].length;
  const end = url.slice(start).search(/[/?#]/);
  const authority = end === -1 ? url.slice(start) : url.slice(start, start + end);
  // The host cannot hold an "@"; a password may, unencoded.
  const at = authority.lastIndexOf("@");
  if (at === -1) return url;
  const userinfo = authority.slice(0, at);
  const isSsh = ["ssh", "git+ssh", "ssh+git"].includes(scheme[1]!.toLowerCase());
  const kept = isSsh && userinfo.split(":")[0] ? `${userinfo.split(":")[0]}@` : "";
  return url.slice(0, start) + kept + url.slice(start + at + 1);
}

/** Two remote URLs name the same repo once credentials, a trailing `/` and `.git` are dropped. */
function sameRemote(a: string, b: string): boolean {
  const trim = (url: string) => stripUrlCredentials(url).replace(/\/+$/, "").replace(/\.git$/, "");
  return trim(a) === trim(b);
}

/** `git -C <dir> config --get <key>`, or null when git fails or prints nothing. */
async function gitConfigGet(key: string, dir: string, env?: Record<string, string | undefined>): Promise<string | null> {
  try {
    const { stdout, exitCode } = await cloneRepoSpawnCtx.run(["git", "-C", dir, "config", "--get", key], env);
    return exitCode === 0 && stdout !== "" ? stdout : null;
  } catch {
    return null;
  }
}

/** `remote.origin.url` of the repo at `repoPath`, as configured, or null when git fails or it is unset. */
export async function readOriginUrl(repoPath: string): Promise<string | null> {
  return gitConfigGet("remote.origin.url", repoPath);
}

/** `repoPath` relative to `cloneRoot`, both after realpath, when it is strictly inside it; else null. */
export async function cloneRootRelPath(repoPath: string, cloneRoot: string): Promise<string | null> {
  let rel: string;
  try {
    rel = relative(await realpath(cloneRoot), await realpath(repoPath));
  } catch {
    return null;
  }
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** The clone fields of one repo's peer snapshot entry, credentials stripped. Never throws. */
export async function readRepoCloneInfo(repoPath: string, cloneRoot: string): Promise<RepoCloneInfo> {
  const [origin, relPath] = await Promise.all([readOriginUrl(repoPath), cloneRootRelPath(repoPath, cloneRoot)]);
  return { remoteUrl: origin === null ? null : stripUrlCredentials(origin), relPath };
}

/**
 * The environment `git clone` runs with: a password prompt, an unknown host
 * key or a missing key fails at once instead of waiting for input nobody can
 * see. `ib watch` is unsandboxed, so the user's SSH agent comes along.
 *
 * It keeps the user's own SSH setup, following git's precedence:
 * `GIT_SSH_COMMAND` gets `-o BatchMode=yes` appended; else a
 * `core.sshCommand` becomes `GIT_SSH_COMMAND` with the option appended; else
 * a `GIT_SSH` is left alone (it may be plink, which takes no `-o`); else ssh
 * runs as `ssh -o BatchMode=yes`. `GIT_TERMINAL_PROMPT=0` is always set.
 * `core.sshCommand` is read from `/`, outside any repo, so only the user's
 * global and system config count, never a repo `ib watch` was started in.
 */
export async function cloneEnv(base: Record<string, string | undefined> = process.env): Promise<Record<string, string | undefined>> {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0" };
  const batch = (ssh: string) => ({ ...env, GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` });
  const own = base.GIT_SSH_COMMAND?.trim();
  if (own) return batch(own);
  const configured = (await gitConfigGet("core.sshCommand", "/", base))?.trim();
  if (configured) return batch(configured);
  if (base.GIT_SSH?.trim()) return env;
  return batch("ssh");
}

/** The way forward from a taken name: the clone must keep the peer's name for its header to join the peer's. */
const CLONE_NAME_HINT = "a clone keeps the peer's repo name";

export interface CloneRepoResult {
  ok: boolean;
  message: string;
  /** Set once the clone exists on disk, even when registering it failed. */
  path?: string;
}

/**
 * Clone `url` into `dest` and register it as `registryName`.
 *
 * Everything that can fail without touching the disk runs first: the URL
 * allowlist and the registry rules addRepo enforces, so a name clash never
 * leaves an orphan clone. A `dest` that is already a clone of `url` is just
 * registered; anything else already at `dest` is refused. A failed clone
 * reports git's stderr (git removes its own partial folder); a clone that
 * cannot be registered is kept and the result names it.
 */
export async function cloneRepo({ url, dest, registryName }: { url: string; dest: string; registryName: string }): Promise<CloneRepoResult> {
  const refusal = cloneUrlRefusal(url);
  if (refusal) return { ok: false, message: refusal };
  if (!dest.trim()) return { ok: false, message: "The destination folder is empty" };
  const target = await onDiskSpelling(expandHome(dest.trim()));

  let entryError: string | null;
  try {
    entryError = await checkNewRepoEntry(target, registryName, await readRegistryStrict(), CLONE_NAME_HINT);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (entryError) return { ok: false, message: entryError };

  if (await stat(target).then(() => true, () => false)) {
    if (!(await hasGitEntry(target))) {
      return { ok: false, message: `${target} already exists and is not a git repo — choose another folder` };
    }
    const origin = await readOriginUrl(target);
    if (origin === null || !sameRemote(origin, url)) {
      const shown = origin === null ? "(none)" : stripUrlCredentials(origin);
      return { ok: false, message: `${target} already exists with origin ${shown}, not ${url} — choose another folder` };
    }
    return register(target, registryName, "Added the existing clone", `Found a clone at ${target}`);
  }

  try {
    await mkdir(dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, message: `Cannot create ${dirname(target)}: ${(err as Error).message}` };
  }
  const clone = await runGit(["git", "clone", "--", url, target]);
  if (!clone.ok) return { ok: false, message: `git clone failed: ${clone.output}` };
  return register(target, registryName, "Cloned and added", `Cloned into ${target}`);
}

/**
 * `path` with its longest existing prefix spelled as on disk (realpath). On a
 * case-insensitive volume (APFS) a typed `myapp` can name an existing `MyApp`;
 * the registry must hold the real spelling, which is what git and the exact
 * path lookups against the git root see. Folders still to be created keep
 * the typed spelling.
 */
async function onDiskSpelling(path: string): Promise<string> {
  const missing: string[] = [];
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      return join(await realpath(dir), ...missing.reverse());
    } catch {
      if (dirname(dir) === dir) return path;
      missing.push(basename(dir));
    }
  }
}

/** addRepo, with `done` naming what happened on success and `onDisk` on a failure. */
async function register(target: string, registryName: string, done: string, onDisk: string): Promise<CloneRepoResult> {
  // addRepo reports a refusal in its result but THROWS when the registry
  // write fails; either way the clone exists, so the error must name it.
  let added: { ok: boolean; message: string };
  try {
    added = await addRepo(target, registryName);
  } catch (err) {
    added = { ok: false, message: (err as Error).message };
  }
  if (!added.ok) return { ok: false, message: `${onDisk}, but could not add it: ${added.message}`, path: target };
  return { ok: true, message: `${done}: ${registryName} (${target})`, path: target };
}

/** Run git with {@link cloneEnv}. `output` is git's stderr (or stdout) folded onto one line for the dashboard's notice. */
async function runGit(cmd: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr, exitCode } = await cloneRepoSpawnCtx.run(cmd, await cloneEnv());
    const text = (stderr || stdout).split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
    return { ok: exitCode === 0, output: text || `exit code ${exitCode}` };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}
