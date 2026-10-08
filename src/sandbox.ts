import { randomBytes } from "crypto";
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { userHome } from "./home";

/** Fully-resolved, spawn-time sandbox configuration. */
export interface SandboxConfig {
  enabled: boolean;
  rawAllow: string[];
  domains: string[];
}

/** Type-layer policy before the default is applied at final resolution. */
export type SandboxConfigInput = Omit<SandboxConfig, "enabled"> & { enabled?: boolean };

/** Filesystem policy authored in the top-level `paths:` frontmatter block. */
export interface PathsConfig {
  allowRead: string[];
  allowWrite: string[];
  deny: string[];
}

export type PathOperation = "read" | "write";

/**
 * Result directories used by the privileged seal helper. They are direct
 * children of the OS-owned /private/tmp directory, so there is no
 * caller-writable ancestor that can be swapped while a result is in flight.
 * The generated profile makes this reserved namespace read-only even when a
 * type uses raw `(allow file-write*)` rules; the unsandboxed tmux child is the
 * only process allowed to create, publish, rename, or remove these paths.
 */
export const SEAL_HELPER_RESULT_ROOT = "/private/tmp";
export const SEAL_HELPER_RESULT_PREFIX = ".ib-seal-helper-";
const SEAL_HELPER_RESULT_MATCHER =
  '(regex #"^/private/tmp/\\.ib-seal-helper-[0-9a-f-]+(/.*)?$")';

/**
 * The attribution tag of one launch's profile. Every deny in the profile carries
 * it as `(with message "<tag>")`, and the kernel then appends it as the LAST line
 * of each denial report, so the shared collector attributes a report by its tag
 * alone (docs/SANDBOX-SHARED-COLLECTOR.md). The 128-bit nonce is new for every
 * spawn and resume; the tagged profile lives in the sealed tree, which no
 * sandboxed agent can read, so another process cannot forge a known tag.
 */
export const SANDBOX_TAG = /^ib-agent:[0-9a-f]{32}$/;

export function newSandboxTag(): string {
  return `ib-agent:${randomBytes(16).toString("hex")}`;
}

/** The one way a deny rule enters a profile: always with the launch's tag. */
function denyRule(body: string, tag: string): string {
  return `(deny ${body} (with message "${tag}"))`;
}

/**
 * rawAllow is verbatim SBPL, so its denies get the tag here. A top-level
 * `(deny …)` is re-emitted through denyRule. A deny anywhere else (nested in
 * another form, or already carrying a message) cannot be tagged, so it is
 * refused: no untagged deny can reach a profile.
 */
function tagRawRule(entry: string, tag: string): string {
  // String and regex literals may hold any text; only code can be a rule. A
  // symbol ends at whitespace, a paren, a quote or a `;` comment.
  const code = entry.trim().replace(/#?"(?:[^"\\]|\\.)*"/g, '""');
  const denies = code.match(/\(\s*deny(?=[\s()";])/g)?.length ?? 0;
  if (denies === 0) return entry;
  if (denies > 1 || !/^\(\s*deny\s/.test(code) || /\(\s*with\s+message(?=[\s()";])/.test(code)) {
    throw new Error(`a deny in rawAllow must be one top-level (deny …) rule without its own message: ${entry}`);
  }
  const body = entry.trim().replace(/^\(\s*deny\s+/, "").slice(0, -1).trimEnd();
  // A `;` comment runs to the end of its line: start the tag on a new one, or
  // the comment would hide it and the closing paren.
  return denyRule(code.includes(";") ? `${body}\n` : body, tag);
}

/** The tag of a generated profile: its second line is always the tagged default deny. */
export function sandboxProfileTag(profile: string): string | null {
  const match = /^\(deny default \(with message "([^"]*)"\)\)$/.exec(profile.split("\n", 2)[1] ?? "");
  return match && SANDBOX_TAG.test(match[1]!) ? match[1]! : null;
}

export interface RuntimePathRoot {
  /** Canonical absolute path used for specificity and resolver matching. */
  path: string;
  op: PathOperation;
}

/** The complete filesystem access table consumed by the resolver. */
export interface PathAccessTable extends PathsConfig {
  /** Allow runtime roots (agent dir, worktree, git dir, repo agents, parent .claude). */
  runtimeRoots: RuntimePathRoot[];
  /** Deny runtime roots carved after the allow table (the tmux socket for non-spawners). */
  runtimeDenyRoots: RuntimePathRoot[];
}

export interface SandboxProfileParams {
  AGENTDIR: string;
  WORKTREE: string;
  GITDIR: string;
  REPOAGENTS: string;
  /**
   * `<repo>/.claude` — the parent-repo directory `ib new-agent` writes a child's
   * settings.local.json into. A write runtime root ONLY when canSpawnChildren is
   * true; a non-spawner never has it in the table.
   */
  PARENTCLAUDE: string;
  /**
   * Optional READ runtime root, spawner-only: `<repo>/.ittybitty/repo-id`, the
   * 8-hex id `getRepoId` reads to name a child's tmux session
   * (`ittybitty-<repoId>-<agent>`) and to key its sealed record. `ib new-agent`
   * (and rehire / `ib sandbox refresh`) read it from inside the spawner's
   * sandbox; without a read grant the file looks missing and the spawn fails.
   * Read-only on purpose: getRepoId never creates the id from a sandbox (an
   * absent file is created by an unsandboxed `ib`), and a spawner must not be
   * able to rewrite the id every session name and seal is derived from. Emitted
   * only when canSpawnChildren is true; absent → no row (byte-identical profile).
   */
  REPOID?: string;
  /**
   * The tmux server socket DIRECTORY (e.g. `/private/tmp/tmux-<uid>`, derived
   * the way tmux resolves it — see resolveTmuxSocketDir). Reaching the tmux
   * server is a sandbox escape (it runs commands unsandboxed). For a non-spawner
   * the generator emits BOTH a file deny (blocks reads/writes of files in the
   * dir) AND a network-outbound unix-socket deny scoped to the dir (blocks the
   * `connect()` — the file deny alone does NOT). A spawner emits neither and
   * keeps the socket (an accepted escape, SPEC-SANDBOX.md 4C.3).
   */
  TMUXSOCK: string;
  /**
   * Resolved spawn capability (metaCanSpawnChildren). Keys the runtime roots:
   * REPOAGENTS is a WRITE root when true and a READ root when false;
   * PARENTCLAUDE is added only when true; the TMUXSOCK deny is emitted only
   * when false.
   */
  canSpawnChildren: boolean;
  /**
   * Optional WRITE runtime root: the agent's Claude project directory
   * (`~/.claude/projects/<encoded-worktree>`). Emitted by profileRuntimeAllowRoots
   * exactly like the other roots when present. The spawn side (Phase B worker 1)
   * must pass it so the kernel profile grants it too; the hook side computes and
   * appends the same value independently (see buildAgentAccessTable). Absent →
   * no row, so a profile that omits it stays byte-identical.
   */
  PROJECTDIR?: string;
  /**
   * Optional WRITE runtime root: the agent's scratchpad directory
   * (`/private/tmp/claude-<uid>/<encoded-worktree>`). Emitted like the other
   * roots when present. Absent → no row (byte-identical profile).
   */
  SCRATCHPAD?: string;
  /**
   * Optional WRITE runtime root: the agy CLI's state/config directory
   * (`~/.gemini`), where agy reads AND rewrites its own settings.json, trust
   * list, config, transcripts and caches during a session. Supplied ONLY for an
   * agy agent (the spawn side and the hook's agentPathAccessTable both gate it on
   * `cli === "agy"`), so it is the agy analogue of Claude's PROJECTDIR/SCRATCHPAD:
   * emitted by profileRuntimeAllowRoots exactly like those when present, and
   * absent → no row (byte-identical profile for claude/codex/fugu). A
   * `paths.deny` entry still carves holes inside it (deny wins, last-match).
   */
  AGYSTATEDIR?: string;
  HOME?: string;
}

export interface SandboxValidationResult {
  errors: string[];
  warnings: string[];
}

export interface SandboxConfigSource {
  sandbox?: SandboxConfigInput;
}

const SANDBOX_KEYS = new Set([
  "enabled",
  "rawAllow",
  "domains",
]);

const SANDBOX_LIST_KEYS = [
  "rawAllow",
  "domains",
] as const;

const MOVED_SANDBOX_PATH_KEYS = new Set(["allowRead", "allowWrite", "deny"]);

const PATHS_KEYS = ["allowRead", "allowWrite", "deny"] as const;

export type CompiledPath =
  | { kind: "plain"; canonical: string; value: string }
  | { kind: "glob"; canonical: string; value: string };

interface ProfileRuntimePathRoot extends RuntimePathRoot {
  parameterName: keyof SandboxProfileParams;
}

export interface OrderedPathEntry {
  canonical: string;
  compiled: CompiledPath;
  kind: "plain" | "glob";
  op: PathOperation;
  specificity: number;
  parameterName?: string;
  /**
   * Glob matcher compiled once when the entry is built (prepare time), so a
   * resolver never rebuilds a RegExp per lookup. Undefined for plain entries.
   */
  regex?: RegExp;
  /** The same glob matcher ignoring letter case (see mayReadForCanonicalization). */
  regexIgnoreCase?: RegExp;
}

/**
 * Resolve the kernel-only sandbox policy without touching spawn wiring.
 * Filesystem policy lives independently in `PathsConfig`.
 *
 * Default to enabled only when no explicit value was resolved from the type
 * hierarchy. Return fresh lists without mutating the source.
 */
/** Only a literal false opts out; absent or malformed values keep the safe default. */
export function resolveSandboxEnabled(enabled: unknown): boolean {
  return enabled !== false;
}

/**
 * Does the agent with this meta.json run inside the itsybitsy kernel sandbox?
 * Its frozen `meta.sandbox` policy, by the launch's own rule (only a literal
 * false opts out; the sandbox exists only on macOS). The hooks use this, not
 * the kernel check isSandboxedProcess(): that loads bun:ffi, whose compiler
 * opens the macOS SDK directory — itself a kernel denial on every call. The
 * answer only chooses how the hooks canonicalize paths (canonicalizeAccessPath).
 */
export function metaKernelSandboxed(meta: Record<string, unknown>): boolean {
  const sandbox = meta.sandbox as { enabled?: unknown } | undefined;
  return process.platform === "darwin" && resolveSandboxEnabled(sandbox?.enabled);
}

export function resolveSandboxConfig(source: SandboxConfigSource): SandboxConfig {
  return {
    enabled: resolveSandboxEnabled(source.sandbox?.enabled),
    rawAllow: [...(source.sandbox?.rawAllow ?? [])],
    domains: [...(source.sandbox?.domains ?? [])],
  };
}

/** Return an isolated paths value, defaulting an absent block to strict empty lists. */
export function resolvePathsConfig(paths?: PathsConfig): PathsConfig {
  return {
    allowRead: [...(paths?.allowRead ?? [])],
    allowWrite: [...(paths?.allowWrite ?? [])],
    deny: [...(paths?.deny ?? [])],
  };
}

function sandboxHome(explicitHome?: string): string {
  return explicitHome ?? userHome();
}

/**
 * Resolve symlinks in the longest path prefix that exists, then append the
 * unresolved suffix. This preserves canonical Seatbelt matching for paths an
 * agent intends to create later (notably /tmp -> /private/tmp on macOS).
 */
export function canonicalizeSandboxPath(input: string): string {
  const normalized = resolve(input);
  let candidate = normalized;
  const remainder: string[] = [];

  while (true) {
    try {
      const canonicalPrefix = realpathSync(candidate);
      return remainder.length === 0
        ? canonicalPrefix
        : join(canonicalPrefix, ...remainder);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error(`Sandbox path has no resolvable prefix: "${input}"`);
      }
      remainder.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/** macOS MAXSYMLINKS: realpath fails with ELOOP after this many link expansions. */
const MAX_SYMLINK_EXPANSIONS = 32;

/**
 * realpath without opening anything: resolve every symlink of an absolute path
 * with lstat and readlink only, which Seatbelt checks as file-read-metadata
 * (allowed by the `_all.md` floor), never file-read-data. Returns null wherever
 * realpathSync fails: a missing or non-directory component, a dangling link, a
 * loop. Unlike realpathSync it keeps the letter case as spelled.
 */
function metadataRealpath(absolute: string): string | null {
  const pending = absolute.split("/").filter((part) => part.length > 0);
  let resolved = "/";
  let isDirectory = true;
  let expansions = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (!isDirectory) return null;
    if (part === ".") continue;
    if (part === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, part);
    let isLink: boolean;
    try {
      const stats = lstatSync(next);
      isLink = stats.isSymbolicLink();
      isDirectory = stats.isDirectory();
    } catch {
      return null;
    }
    if (!isLink) {
      resolved = next;
      continue;
    }
    if (++expansions > MAX_SYMLINK_EXPANSIONS) return null;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return null;
    }
    if (target.length === 0) return null;
    const targetParts = target.split("/").filter((part) => part.length > 0);
    // A trailing slash requires a directory, like a trailing "/." does.
    if (target.endsWith("/")) targetParts.push(".");
    pending.unshift(...targetParts);
    if (target.startsWith("/")) resolved = "/";
    isDirectory = true;
  }
  return resolved;
}

/**
 * canonicalizeSandboxPath without reading what the agent may not read. Inside a
 * kernel sandbox, realpathSync opens its argument (a file-read-data check), and
 * the walk up to the longest existing prefix then retries each denied ancestor
 * (`/Users/<you>`, `/Users`), so every attempt is a kernel denial. This version
 * resolves the symlinks and the longest existing prefix with lstat/readlink only,
 * and calls realpathSync only on the longest resolved prefix `mayRead` admits,
 * where it corrects the letter case exactly as canonicalizeSandboxPath does.
 * `mayRead` gets the prefix and the full symlink-resolved path (prefix and the
 * rest as spelled). A `mayRead` that is always false gives a pure metadata
 * canonicalization.
 *
 * Components between that prefix and the longest existing prefix were refused
 * by `mayRead` (a deny entry matched them as typed). The first one takes its
 * on-disk spelling from a listing of the prefix realpath just opened (so the
 * listing is allowed too), and the walk runs again: the corrected spelling can
 * change what a deny entry matches. Every pass but the last changes at least
 * one component to its on-disk spelling, and an on-disk spelling never changes
 * again, so there are at most as many passes as components. More means the
 * filesystem did not return stable names: throw (the hooks then deny).
 */
export function canonicalizeSandboxPathWithin(
  input: string,
  mayRead: (prefix: string, fullPath: string) => boolean,
): string {
  let next = canonicalizeWithinOnce(resolve(input), mayRead, input);
  // After the first pass the path has no symlinks, so its depth is fixed.
  let passesLeft = next.path.split("/").filter((part) => part.length > 0).length;
  while (!next.done) {
    if (passesLeft-- === 0) throw new Error(`Sandbox path case did not settle: "${input}"`);
    next = canonicalizeWithinOnce(next.path, mayRead, input);
  }
  return next.path;
}

/**
 * The entry of `dir` that `name` opens, in its on-disk spelling: on a
 * case-insensitive volume the spelling can differ from `name`. Only the same
 * file (same inode) with a name equal ignoring case counts.
 */
function onDiskName(dir: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (entries.includes(name)) return name;
  const folded = name.normalize("NFC").toLowerCase();
  try {
    const target = lstatSync(join(dir, name));
    const matches = entries.filter((entry) => {
      if (entry.normalize("NFC").toLowerCase() !== folded) return false;
      const stats = lstatSync(join(dir, entry));
      return stats.ino === target.ino && stats.dev === target.dev;
    });
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function canonicalizeWithinOnce(
  path: string,
  mayRead: (prefix: string, fullPath: string) => boolean,
  input: string,
): { path: string; done: boolean } {
  let candidate = path;
  const remainder: string[] = [];
  let resolvedPrefix = metadataRealpath(candidate);
  while (resolvedPrefix === null) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Sandbox path has no resolvable prefix: "${input}"`);
    }
    remainder.unshift(basename(candidate));
    candidate = parent;
    resolvedPrefix = metadataRealpath(candidate);
  }

  const fullPath = join(resolvedPrefix, ...remainder);
  const unread: string[] = [];
  for (let readable = resolvedPrefix; readable !== "/"; readable = dirname(readable)) {
    if (mayRead(readable, fullPath)) {
      let corrected: string;
      try {
        corrected = realpathSync(readable);
      } catch {
        // Not readable after all (a rawAllow deny, file modes): keep walking up,
        // as canonicalizeSandboxPath does.
        unread.unshift(basename(readable));
        continue;
      }
      if (unread.length === 0) return { path: join(corrected, ...remainder), done: true };
      const name = onDiskName(corrected, unread[0]!) ?? unread[0]!;
      const changed = corrected !== readable || name !== unread[0];
      unread[0] = name;
      return { path: join(corrected, ...unread, ...remainder), done: !changed };
    }
    unread.unshift(basename(readable));
  }
  return { path: join("/", ...unread, ...remainder), done: true };
}

/**
 * The tmux server socket DIRECTORY as tmux derives it, NOT canonicalized: if
 * `$TMUX` is set, the directory of its first comma-separated field; otherwise
 * `${TMUX_TMPDIR:-/tmp}/tmux-<uid>`. resolveTmuxSocketDir canonicalizes it; the
 * hook-side table builder canonicalizes it without opening it (it is a deny root).
 */
export function tmuxSocketDirPath(uid: number): string {
  const tmux = process.env.TMUX;
  if (tmux && tmux.length > 0) {
    const socketPath = tmux.split(",")[0];
    if (socketPath && socketPath.length > 0) return dirname(socketPath);
  }
  const base = process.env.TMUX_TMPDIR && process.env.TMUX_TMPDIR.length > 0
    ? process.env.TMUX_TMPDIR
    : "/tmp";
  return join(base, `tmux-${uid}`);
}

/**
 * Resolve the tmux server socket DIRECTORY the way tmux itself does, canonical
 * (longest-existing-prefix), ready to hand to the sandbox as `TMUXSOCK`: if
 * `$TMUX` is set (we are inside a tmux server), its first comma-separated field
 * is the socket path, and the directory of that path is the socket dir;
 * otherwise tmux uses `${TMUX_TMPDIR:-/tmp}/tmux-<uid>` (so `/tmp/tmux-<uid>` →
 * `/private/tmp/tmux-<uid>` on macOS). Denying this subtree closes the
 * unix-socket connect() a non-spawner would otherwise use to reach the
 * unsandboxed tmux server. profileRuntimeDenyRoots re-canonicalizes idempotently.
 *
 * Lives here (not in ib-commands.ts) so the PreToolUse hooks can import it
 * without pulling in the heavy ib-commands module; ib-commands re-exports it so
 * existing callers keep working.
 */
export function resolveTmuxSocketDir(uid: number): string {
  return canonicalizeSandboxPath(tmuxSocketDirPath(uid));
}

function expandHome(entry: string, home: string): string {
  if (entry === "~") return home;
  if (entry.startsWith("~/")) return join(home, entry.slice(2));
  return entry;
}

/** Canonicalize the non-glob prefix of an absolute glob without touching its grammar. */
export function canonicalizeGlobPrefix(pattern: string): string {
  if (!pattern.startsWith("/")) return pattern;

  const globIndex = pattern.search(/[?*]/);
  if (globIndex === -1) return canonicalizeSandboxPath(pattern);

  const slashIndex = pattern.lastIndexOf("/", globIndex);
  if (slashIndex < 0) return pattern;

  const prefix = slashIndex === 0 ? "/" : pattern.slice(0, slashIndex);
  const suffix = pattern.slice(slashIndex);
  const canonicalPrefix = canonicalizeSandboxPath(prefix);
  return canonicalPrefix === "/" ? suffix : `${canonicalPrefix}${suffix}`;
}

/**
 * Resolve authored entries for persistence: expand home anchors and
 * canonicalize plain paths/glob prefixes, but preserve list membership and
 * cross-list duplicates so displays retain author intent.
 */
export function canonicalizePathsConfig(
  paths: PathsConfig,
  home?: string,
): PathsConfig {
  const validation = validatePathsFrontmatter(paths, home);
  if (validation.errors.length > 0) {
    throw new Error(validation.errors[0]);
  }
  const resolvedHome = sandboxHome(home);
  const canonicalizeEntry = (entry: string): string => {
    // Validate with the same grammar used by profile generation before doing
    // any canonicalization, including when sandbox.enabled is false.
    compilePath(entry, resolvedHome);
    if (/[*?]/.test(entry)) {
      return canonicalizeGlobPrefix(expandHome(entry, resolvedHome));
    }
    return canonicalizeSandboxPath(expandHome(entry, resolvedHome));
  };
  return {
    allowRead: paths.allowRead.map(canonicalizeEntry),
    allowWrite: paths.allowWrite.map(canonicalizeEntry),
    deny: paths.deny.map(canonicalizeEntry),
  };
}

/**
 * Translate the sandbox path glob grammar to a both-end-anchored regex.
 * A globstar followed by a path separator is an optional directory run, so
 * globstar spans zero or more directories as required by the public grammar.
 */
export function globToSandboxRegex(pattern: string, home?: string): string {
  if (pattern.includes("\0")) {
    throw new Error(`Invalid sandbox path entry: NUL bytes are not allowed`);
  }
  const isAnchoredGlob = pattern.startsWith("/") || pattern.startsWith("~/") || pattern.startsWith("**/");
  if (!isAnchoredGlob) {
    throw new Error(
      `Invalid sandbox glob "${pattern}": relative globs are not allowed; start with "/", "~/", or "**/" for a basename-anywhere pattern`,
    );
  }

  const expanded = expandHome(pattern, sandboxHome(home));
  const canonical = canonicalizeGlobPrefix(expanded);
  return canonicalGlobToSandboxRegex(canonical);
}

/** Translate an already-canonical glob with no further filesystem lookups. */
function canonicalGlobToSandboxRegex(canonical: string): string {
  let regex = "^";

  for (let i = 0; i < canonical.length;) {
    const char = canonical[i]!;
    if (char === "*") {
      if (canonical[i + 1] === "*") {
        if (canonical[i + 2] === "/") {
          regex += "(.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }

    if (char === "/") {
      regex += char;
    } else if (/[.\\+()[\]{}|^$]/.test(char)) {
      regex += `\\${char}`;
    } else if (char === '"') {
      // A quote is literal to regex, but must not terminate SBPL's #"...".
      regex += '\\"';
    } else if (char === "\n") {
      regex += "\\n";
    } else if (char === "\r") {
      regex += "\\r";
    } else {
      regex += char;
    }
    i += 1;
  }

  return `${regex}$`;
}

function escapeSbplString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function compilePath(entry: string, home?: string): CompiledPath {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(
      `Invalid sandbox path entry "${String(entry)}": use an absolute path, a home path, or a glob such as "**/.env"`,
    );
  }

  if (entry.includes("\0")) {
    throw new Error(`Invalid sandbox path entry: NUL bytes are not allowed`);
  }

  // Glob detection intentionally precedes anchor classification.
  if (/[*?]/.test(entry)) {
    // globToSandboxRegex owns the public grammar validation. Keep the
    // canonical pattern as well as the compiled regex because specificity is
    // defined from the pattern's literal prefix, not from regex source text.
    const value = globToSandboxRegex(entry, home);
    const canonical = canonicalizeGlobPrefix(expandHome(entry, sandboxHome(home)));
    return { kind: "glob", canonical, value };
  }

  if (entry === "~" || entry.startsWith("~/")) {
    const canonical = canonicalizeSandboxPath(expandHome(entry, sandboxHome(home)));
    return {
      kind: "plain",
      canonical,
      value: canonical,
    };
  }

  if (entry.startsWith("/")) {
    const canonical = canonicalizeSandboxPath(entry);
    return { kind: "plain", canonical, value: canonical };
  }

  throw new Error(
    `Invalid sandbox path entry "${entry}": bare names are not allowed; use "**/${entry}" or an absolute path`,
  );
}

/** Compile an entry that has already been canonicalized for table evaluation. */
function compileCanonicalPath(entry: string): CompiledPath {
  if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
    throw new Error(`Invalid canonical sandbox path entry "${String(entry)}"`);
  }
  if (/[*?]/.test(entry)) {
    if (!entry.startsWith("/") && !entry.startsWith("**/")) {
      throw new Error(`Invalid canonical sandbox glob "${entry}"`);
    }
    return {
      kind: "glob",
      canonical: entry,
      value: canonicalGlobToSandboxRegex(entry),
    };
  }
  if (!entry.startsWith("/")) {
    throw new Error(`Invalid canonical sandbox path "${entry}"`);
  }
  return { kind: "plain", canonical: entry, value: entry };
}

function compiledPathKey(entry: string, home?: string): string {
  const compiled = compilePath(entry, home);
  return `${compiled.kind}\0${compiled.value}`;
}

/** Dedupe key for an entry that has already been canonicalized for the table. */
function canonicalCompiledPathKey(entry: string): string {
  const compiled = compileCanonicalPath(entry);
  return `${compiled.kind}\0${compiled.value}`;
}

/**
 * The single write-wins exact-tie rule, without mutating any caller list:
 * return allowRead with every entry whose compiled key also appears in
 * allowWrite removed; within-list order and all other entries are unchanged.
 * `keyOf` compiles each entry to its dedupe key, so a caller may pass authored
 * (home-relative) entries via compiledPathKey or already-canonical table
 * entries via canonicalCompiledPathKey. Both the exported normalizePathsConfig
 * (the Phase B consumer) and the production sortedAllowEntries access table
 * route through here so their dedupe can never drift apart.
 */
function writeWinsFilteredRead(
  allowRead: readonly string[],
  allowWrite: readonly string[],
  keyOf: (entry: string) => string,
): string[] {
  const writeKeys = new Set(allowWrite.map(keyOf));
  return allowRead.filter((entry) => !writeKeys.has(keyOf(entry)));
}

/**
 * Apply the write-wins exact-tie rule without mutating the authored config.
 * Canonically identical entries in allowWrite are removed from allowRead;
 * within-list order and all other entries remain unchanged.
 */
export function normalizePathsConfig(paths: PathsConfig, home?: string): PathsConfig {
  return {
    allowRead: writeWinsFilteredRead(
      paths.allowRead,
      paths.allowWrite,
      (entry) => compiledPathKey(entry, home),
    ),
    allowWrite: [...paths.allowWrite],
    deny: [...paths.deny],
  };
}

/**
 * Placeholder absolute anchor used ONLY to validate a relative entry's grammar.
 * A real spawn anchors relative entries at the main repo root the worktree was
 * spawned from (anchorRelativePaths); validation runs before a repo root is
 * known, so it anchors at this fixed absolute path purely to exercise
 * compileSandboxPath's absolute-path grammar.
 */
const RELATIVE_VALIDATION_ANCHOR = "/__anchor__";

/**
 * Anchor one relative (`./` or `../`) entry at an absolute anchor directory,
 * re-appending any glob suffix (from the first `*` or `?` onward) unchanged.
 * Non-relative entries (absolute, home, or globs without a `./`/`../` prefix)
 * are returned untouched.
 *
 * Anchoring is **lexical** (`path.resolve` joins and normalizes without touching
 * the filesystem), so a `../` that crosses a symlinked component of the anchor
 * climbs the *lexical* parent, not the symlink target. In practice the anchor is
 * always a `resolveGitRoot` result — a real (realpath'd) path — so the lexical
 * parent is the real parent and this is not observable at spawn.
 */
function anchorRelativeEntry(entry: string, anchor: string): string {
  if (!entry.startsWith("./") && !entry.startsWith("../")) return entry;
  const globIndex = entry.search(/[*?]/);
  const literalPrefix = globIndex === -1 ? entry : entry.slice(0, globIndex);
  const globSuffix = globIndex === -1 ? "" : entry.slice(globIndex);
  let resolved = resolve(anchor, literalPrefix);
  // resolve() strips a trailing slash; keep it so a `.../**` suffix re-appends
  // as a fresh path segment instead of fusing onto the final directory name.
  if (literalPrefix.endsWith("/") && !resolved.endsWith("/")) {
    resolved += "/";
  }
  return `${resolved}${globSuffix}`;
}

/**
 * Rewrite every relative (`./` or `../`) entry in a PathsConfig to an absolute
 * path anchored at `anchor` (the main repo root the worktree was spawned from),
 * re-appending any glob suffix unchanged. All other entries — absolute, home
 * (`~`), and non-relative globs — pass through untouched, so the profile
 * generator and the kernel never see a relative entry.
 * (SPEC-PATH-ALLOWLIST.md 6.1, 6.2)
 */
export function anchorRelativePaths(paths: PathsConfig, anchor: string): PathsConfig {
  const anchorEntry = (entry: string): string => anchorRelativeEntry(entry, anchor);
  return {
    allowRead: paths.allowRead.map(anchorEntry),
    allowWrite: paths.allowWrite.map(anchorEntry),
    deny: paths.deny.map(anchorEntry),
  };
}

/**
 * Find every relative (`./` or `../`) SOURCE entry that, once anchored, escapes
 * to the filesystem root `/` or to the home directory — i.e. whose anchored
 * literal prefix (the part before its first glob metacharacter, or the whole
 * entry when plain) canonicalizes to `/` or to `home`. Such an entry is a
 * silent filesystem-wide (or whole-home) grant that the single model requires
 * to be written EXPLICITLY (`allowRead: ["/"]` or `["~"]`); the caller turns a
 * non-empty result into a spawn/refresh error naming the entry and its target.
 *
 * All three lists are inspected, not just the allow lists: a relative climb that
 * silently reaches `/` or `home` is almost always a mistake regardless of which
 * list it lands in (a `deny` that reaches `/` would lock the agent out of
 * everything). An EXPLICIT `/` or `~` entry never starts with `./`/`../`, so it
 * is skipped here and stays allowed. Compares canonical forms so `/tmp` vs
 * `/private/tmp` and `~` vs its absolute spelling agree.
 * (SPEC-PATH-ALLOWLIST.md 6.11, review round 1 blocker (a))
 */
export function findRelativeEscapes(
  paths: PathsConfig,
  anchor: string,
  home?: string,
): Array<{ entry: string; resolved: string }> {
  const homeCanonical = canonicalizeSandboxPath(sandboxHome(home));
  const escapes: Array<{ entry: string; resolved: string }> = [];
  const inspect = (entry: string): void => {
    if (typeof entry !== "string") return;
    if (!entry.startsWith("./") && !entry.startsWith("../")) return;
    const anchored = anchorRelativeEntry(entry, anchor);
    const globIndex = anchored.search(/[*?]/);
    const literalPrefix = globIndex === -1 ? anchored : anchored.slice(0, globIndex);
    let canonical: string;
    try {
      canonical = canonicalizeSandboxPath(literalPrefix);
    } catch {
      return; // an unresolvable prefix is the grammar validator's problem
    }
    if (canonical === "/" || canonical === homeCanonical) {
      escapes.push({ entry, resolved: canonical });
    }
  };
  for (const list of [paths.allowRead, paths.allowWrite, paths.deny]) {
    for (const entry of list) inspect(entry);
  }
  return escapes;
}

/** Compile one user-facing path entry to an SBPL matcher. */
export function compileSandboxPath(entry: string, home?: string): string {
  const compiled = compilePath(entry, home);
  if (compiled.kind === "glob") return `(regex #"${compiled.value}")`;
  return `(subpath "${escapeSbplString(compiled.value)}")`;
}

function isSafeInlineSubpath(value: string): boolean {
  // Quotes/control characters can terminate an SBPL string. Use a -D param for
  // those paths so the user-controlled bytes never enter the profile source.
  return !/["\\\n\r\0]/.test(value);
}

function pathSpecificity(compiled: CompiledPath): number {
  const literalPrefix = compiled.kind === "glob"
    ? compiled.canonical.slice(0, compiled.canonical.search(/[*?]/))
    : compiled.canonical;
  return literalPrefix.split("/").filter((segment) => segment.length > 0).length;
}

function compareLexically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * One total, input-order-independent sort key is shared by profile emission
 * and resolver evaluation:
 *
 * 1. canonical path segment count (a glob uses its literal prefix),
 * 2. kind (plain before glob),
 * 3. canonical path/pattern in lexical order,
 * 4. operation (read before write).
 *
 * Seatbelt is last-match-wins, so ascending order makes the most specific
 * matching entry authoritative. Exact semantic duplicates compare equal and
 * emit identical rules; the merge layer already deduplicates authored lists.
 */
function compareOrderedPathEntries(left: OrderedPathEntry, right: OrderedPathEntry): number {
  if (left.specificity !== right.specificity) {
    return left.specificity - right.specificity;
  }
  if (left.kind !== right.kind) return left.kind === "plain" ? -1 : 1;
  const canonicalOrder = compareLexically(left.canonical, right.canonical);
  if (canonicalOrder !== 0) return canonicalOrder;
  if (left.op !== right.op) return left.op === "read" ? -1 : 1;
  return 0;
}

function orderedPathEntry(
  path: string,
  op: PathOperation,
  parameterName?: string,
): OrderedPathEntry {
  const compiled = compileCanonicalPath(path);
  return {
    canonical: compiled.canonical,
    compiled,
    kind: compiled.kind,
    op,
    specificity: pathSpecificity(compiled),
    parameterName,
    regex: compiled.kind === "glob" ? new RegExp(compiled.value) : undefined,
    regexIgnoreCase: compiled.kind === "glob" ? new RegExp(compiled.value, "i") : undefined,
  };
}

/**
 * Runtime ALLOW roots, keyed on the resolved spawn capability. AGENTDIR,
 * WORKTREE, and GITDIR are always read+write boot roots. REPOAGENTS is a write
 * root for a spawner (it writes its child's agent dir) and read-only otherwise.
 * PARENTCLAUDE (`<repo>/.claude`, where a child's settings.local.json is
 * written) is added only for a spawner, as is the read-only REPOID
 * (`<repo>/.ittybitty/repo-id`). This table is extensible: a later root
 * (scratchpad, project dir) adds a row rather than a new emission phase.
 * `canonicalize` is canonicalizeSandboxPath except for the in-sandbox hook
 * table (storedPathAccessTable).
 */
function profileRuntimeAllowRoots(
  params: SandboxProfileParams,
  canonicalize: (path: string) => string = canonicalizeSandboxPath,
): ProfileRuntimePathRoot[] {
  const roots: ProfileRuntimePathRoot[] = [
    { path: canonicalize(params.AGENTDIR), op: "write", parameterName: "AGENTDIR" },
    { path: canonicalize(params.WORKTREE), op: "write", parameterName: "WORKTREE" },
    { path: canonicalize(params.GITDIR), op: "write", parameterName: "GITDIR" },
    {
      path: canonicalize(params.REPOAGENTS),
      op: params.canSpawnChildren ? "write" : "read",
      parameterName: "REPOAGENTS",
    },
  ];
  if (params.canSpawnChildren) {
    roots.push({
      path: canonicalize(params.PARENTCLAUDE),
      op: "write",
      parameterName: "PARENTCLAUDE",
    });
    // The repo id the spawner reads to name and seal its child. Read-only.
    if (params.REPOID) {
      roots.push({
        path: canonicalize(params.REPOID),
        op: "read",
        parameterName: "REPOID",
      });
    }
  }
  // Optional Phase B write roots (project dir, scratchpad). Each is emitted only
  // when the caller supplies it, so a profile that omits both is byte-identical
  // to the pre-Phase-B output. When present they are ordinary write roots and
  // sort into the specificity table like any other runtime root.
  if (params.PROJECTDIR) {
    roots.push({
      path: canonicalize(params.PROJECTDIR),
      op: "write",
      parameterName: "PROJECTDIR",
    });
  }
  if (params.SCRATCHPAD) {
    roots.push({
      path: canonicalize(params.SCRATCHPAD),
      op: "write",
      parameterName: "SCRATCHPAD",
    });
  }
  // Optional agy-only WRITE root (~/.gemini). Emitted exactly like the Claude
  // PROJECTDIR/SCRATCHPAD roots when present; a non-agy profile omits it and
  // stays byte-identical.
  if (params.AGYSTATEDIR) {
    roots.push({
      path: canonicalize(params.AGYSTATEDIR),
      op: "write",
      parameterName: "AGYSTATEDIR",
    });
  }
  return roots;
}

/**
 * Runtime DENY roots, emitted after the allow table so they carve holes that
 * win (Seatbelt is last-match-wins). The tmux socket is denied for a
 * non-spawner — both a file deny (carving it out of the /private/tmp write
 * floor) and a network-outbound unix-socket deny (blocking the connect that the
 * file deny does not); a spawner emits nothing here. The op is nominal — a file
 * deny row emits both read and write denies.
 */
function profileRuntimeDenyRoots(
  params: SandboxProfileParams,
  canonicalize: (path: string) => string = canonicalizeSandboxPath,
): ProfileRuntimePathRoot[] {
  if (params.canSpawnChildren) return [];
  return [
    { path: canonicalize(params.TMUXSOCK), op: "read", parameterName: "TMUXSOCK" },
  ];
}

/** Build the canonical table used by both the profile and hook-side resolver. */
export function sandboxPathAccessTable(
  paths: PathsConfig,
  params: SandboxProfileParams,
): PathAccessTable {
  const canonicalPaths = canonicalizePathsConfig(paths, sandboxHome(params.HOME));
  return {
    ...canonicalPaths,
    ...runtimeRootRows(params, canonicalizeSandboxPath),
  };
}

function runtimeRootRows(
  params: SandboxProfileParams,
  canonicalize: (path: string) => string,
): Pick<PathAccessTable, "runtimeRoots" | "runtimeDenyRoots"> {
  return {
    runtimeRoots: profileRuntimeAllowRoots(params, canonicalize).map(({ path, op }) => ({ path, op })),
    runtimeDenyRoots: profileRuntimeDenyRoots(params, canonicalize).map(({ path, op }) => ({ path, op })),
  };
}

/**
 * The table sandboxPathAccessTable builds, for a PreToolUse hook running inside
 * the agent's kernel sandbox, from the `paths` stored in meta.json. Spawn and
 * `ib sandbox refresh` store canonicalizePathsConfig output, made unsandboxed:
 * the forms their profile was built from (a resume canonicalizes them again
 * when it rebuilds the profile). The stored entries are used as they are:
 * re-canonicalizing a deny entry such as `~/.ssh` in the sandbox opens it and
 * every denied ancestor, a kernel denial each, on every tool call.
 * prepareAccessTable compiles each entry with compileCanonicalPath: an entry
 * that is not absolute (`~/x`, `./x`) throws and the hook denies; an absolute
 * entry is used as written (one that is not canonical, such as `/tmp/x`,
 * matches no canonical path).
 *
 * The runtime roots are canonicalized without opening what the agent may not
 * read: first by metadata only, then against that provisional table. An allow
 * root is readable by definition, so it gets the same realpathSync as in the
 * profile; the tmux deny root is never opened.
 */
export function storedPathAccessTable(
  paths: PathsConfig,
  params: SandboxProfileParams,
): PathAccessTable {
  const stored = resolvePathsConfig(paths);
  const provisional = prepareAccessTable({
    ...stored,
    ...runtimeRootRows(params, (path) => canonicalizeSandboxPathWithin(path, () => false)),
  });
  return {
    ...stored,
    ...runtimeRootRows(params, (path) => canonicalizeWithoutOpeningDenied(provisional, path)),
  };
}

function sortedAllowEntries(
  table: PathAccessTable,
  profileRoots: ProfileRuntimePathRoot[] = [],
): OrderedPathEntry[] {
  const normalizedRead = writeWinsFilteredRead(
    table.allowRead,
    table.allowWrite,
    canonicalCompiledPathKey,
  );
  const entries = [
    ...normalizedRead.map((path) => orderedPathEntry(path, "read")),
    ...table.allowWrite.map((path) => orderedPathEntry(path, "write")),
    ...table.runtimeRoots.map((root, index) => orderedPathEntry(
      root.path,
      root.op,
      profileRoots[index]?.parameterName,
    )),
  ];
  return entries.sort(compareOrderedPathEntries);
}

/**
 * Sort the configured file denies together with the runtime deny roots (the
 * tmux socket for a non-spawner). `denyRoots` only carries parameter names for
 * -D emission and never affects sorting or resolution, so resolvers may omit it;
 * profile emission passes it so the tmux deny emits `(param "TMUXSOCK")`.
 */
function sortedDenyEntries(
  table: PathAccessTable,
  denyRoots: ProfileRuntimePathRoot[] = [],
): OrderedPathEntry[] {
  return [
    ...table.deny.map((path) => orderedPathEntry(path, "read")),
    ...table.runtimeDenyRoots.map((root, index) => orderedPathEntry(
      root.path,
      root.op,
      denyRoots[index]?.parameterName,
    )),
  ].sort(compareOrderedPathEntries);
}

/**
 * Does an ordered entry match a CANONICAL absolute path? Exported so the hook's
 * denial-reason wording (pathDenialReason) tests the same matcher the resolver
 * uses, rather than a duplicate that could drift. Callers must pass an already
 * canonical path (as resolvePreparedAccess does internally).
 */
export function orderedEntryMatches(entry: OrderedPathEntry, absolutePath: string): boolean {
  if (entry.compiled.kind === "glob") return entry.regex!.test(absolutePath);
  const value = entry.compiled.value;
  if (value === "/") return absolutePath.startsWith("/");
  return absolutePath === value || absolutePath.startsWith(`${value}/`);
}

/**
 * A sorted, compiled access table ready for repeated resolution. Produced once
 * by prepareAccessTable so a caller resolving many paths against one table does
 * not re-sort the allow and deny entries on every lookup.
 */
export interface PreparedAccessTable {
  allow: OrderedPathEntry[];
  deny: OrderedPathEntry[];
  /**
   * Set when the resolving process runs inside the agent's kernel sandbox (the
   * PreToolUse hooks): paths are then canonicalized without opening what the
   * profile denies (canonicalizeAccessPath). Unset: canonicalizeSandboxPath.
   */
  kernelSandboxed?: boolean;
}

/**
 * Sort and compile the access table once for repeated resolution. The `roots`
 * only carry parameter names for -D emission and never affect resolution, so
 * resolvers may omit them; profile emission passes them for stable naming.
 */
export function prepareAccessTable(
  table: PathAccessTable,
  allowRoots: ProfileRuntimePathRoot[] = [],
  denyRoots: ProfileRuntimePathRoot[] = [],
): PreparedAccessTable {
  return {
    allow: sortedAllowEntries(table, allowRoots),
    deny: sortedDenyEntries(table, denyRoots),
  };
}

/** orderedEntryMatches, ignoring letter case. */
function orderedEntryMatchesIgnoringCase(entry: OrderedPathEntry, absolutePath: string): boolean {
  if (entry.compiled.kind === "glob") return entry.regexIgnoreCase!.test(absolutePath);
  const value = entry.compiled.value.toLowerCase();
  const path = absolutePath.toLowerCase();
  if (value === "/") return path.startsWith("/");
  return path === value || path.startsWith(`${value}/`);
}

/**
 * Should canonicalization call realpathSync (a file-read-data check in the
 * kernel) on `prefix`, a symlink-free existing prefix of `fullPath` whose letter
 * case is not corrected yet? Not when a deny entry matches the prefix as
 * spelled. Otherwise yes when an allow entry matches the prefix or the full path
 * in any letter case: only then can the corrected case change the decision.
 */
function mayReadForCanonicalization(
  prepared: PreparedAccessTable,
  prefix: string,
  fullPath: string,
): boolean {
  if (prepared.deny.some((entry) => orderedEntryMatches(entry, prefix))) return false;
  return prepared.allow.some((entry) =>
    orderedEntryMatchesIgnoringCase(entry, prefix) || orderedEntryMatchesIgnoringCase(entry, fullPath));
}

/** canonicalizeSandboxPathWithin, opening only where `prepared` may allow a read. */
function canonicalizeWithoutOpeningDenied(prepared: PreparedAccessTable, absolutePath: string): string {
  return canonicalizeSandboxPathWithin(
    absolutePath,
    (prefix, fullPath) => mayReadForCanonicalization(prepared, prefix, fullPath),
  );
}

/**
 * Canonicalize a path for resolution against `prepared`.
 *
 * Unless `prepared.kernelSandboxed` is set this is canonicalizeSandboxPath:
 * outside a kernel sandbox opening a path costs no denial, and the decisions
 * stay exactly what they were.
 *
 * Inside the sandbox it opens no path the agent may not read
 * (canonicalizeSandboxPathWithin): symlinks resolve by lstat/readlink, and
 * realpathSync corrects the letter case of the longest existing prefix that an
 * allow entry matches, or that leads to a path an allow entry matches, in any
 * case, unless a deny entry matches the prefix as spelled; such a refused
 * component takes its on-disk spelling from a listing of its opened parent.
 * Decisions on the result are those on canonicalizeSandboxPath's result,
 * except below a directory it may not open (one a deny entry matches as typed,
 * or the kernel profile does not let the agent read): there a component keeps
 * the typed case, as with canonicalizeSandboxPath inside the sandbox, which
 * also kept a symlink there unresolved; this one resolves it.
 */
export function canonicalizeAccessPath(prepared: PreparedAccessTable, absolutePath: string): string {
  return prepared.kernelSandboxed
    ? canonicalizeWithoutOpeningDenied(prepared, absolutePath)
    : canonicalizeSandboxPath(absolutePath);
}

/**
 * Resolve access against an already-prepared table. The input must be absolute;
 * it is canonicalized here (canonicalizeAccessPath: symlinks and longest
 * existing prefix, as canonicalizeSandboxPath does for table entries), so a
 * caller passing `/tmp/x` resolves identically to `/private/tmp/x` and the
 * canonical-input contract is enforced, not merely documented. Deny wins at
 * every depth. Read-only of `prepared`: resolving never mutates the sorted
 * entries, so one prepared table serves any number of lookups.
 */
export function resolvePreparedAccess(
  prepared: PreparedAccessTable,
  absolutePath: string,
  op: PathOperation,
): "allow" | "deny" {
  if (!absolutePath.startsWith("/")) {
    throw new Error(`resolvePreparedAccess requires an absolute path, got "${absolutePath}"`);
  }
  const canonical = canonicalizeAccessPath(prepared, absolutePath);

  if (prepared.deny.some((entry) => orderedEntryMatches(entry, canonical))) {
    return "deny";
  }

  const matching = prepared.allow
    .filter((entry) => orderedEntryMatches(entry, canonical));
  const winner = matching.at(-1);
  if (!winner) return "deny";
  if (op === "read") return "allow";
  return winner.op === "write" ? "allow" : "deny";
}

/**
 * Resolve access from the same sorted table that drives SBPL emission. A thin
 * wrapper that prepares then resolves; prefer prepareAccessTable +
 * resolvePreparedAccess when resolving many paths against one table. Guards the
 * absolute-path requirement here too, so a relative-path caller of this
 * function gets an error naming this function rather than the delegate.
 */
export function resolvePathAccess(
  absolutePath: string,
  op: PathOperation,
  table: PathAccessTable,
): "allow" | "deny" {
  if (!absolutePath.startsWith("/")) {
    throw new Error(`resolvePathAccess requires an absolute path, got "${absolutePath}"`);
  }
  return resolvePreparedAccess(prepareAccessTable(table), absolutePath, op);
}

function profileMatcher(entry: OrderedPathEntry, parameterName: string): string {
  if (entry.parameterName) {
    return `(subpath (param "${entry.parameterName}"))`;
  }
  if (entry.compiled.kind === "glob") return `(regex #"${entry.compiled.value}")`;
  if (!isSafeInlineSubpath(entry.compiled.value)) {
    return `(subpath (param "${parameterName}"))`;
  }
  // Tightening hook: the verified baseline can represent allowRead "/" as
  // `(literal "/")` under file-read-data. Keep the ordinary subtree form for
  // v1 correctness until that op-class special case is deliberately adopted.
  return `(subpath "${escapeSbplString(entry.compiled.value)}")`;
}

/**
 * Return the -D values required by a generated profile. Runtime roots are
 * always parameters. Unsafe non-glob config paths also become parameters so
 * they cannot inject profile source; safe config paths remain inspectable.
 */
export function sandboxProfileParameterValues(
  paths: PathsConfig,
  params: SandboxProfileParams,
): Record<string, string> {
  const allowRoots = profileRuntimeAllowRoots(params);
  const denyRoots = profileRuntimeDenyRoots(params);
  const table = sandboxPathAccessTable(paths, params);
  const values: Record<string, string> = {};

  sortedAllowEntries(table, allowRoots).forEach((entry, index) => {
    if (entry.parameterName) {
      values[entry.parameterName] = entry.compiled.value;
    } else if (entry.compiled.kind === "plain" && !isSafeInlineSubpath(entry.compiled.value)) {
      values[`ALLOW_${index}`] = entry.compiled.value;
    }
  });
  sortedDenyEntries(table, denyRoots).forEach((entry, index) => {
    if (entry.parameterName) {
      values[entry.parameterName] = entry.compiled.value;
    } else if (entry.compiled.kind === "plain" && !isSafeInlineSubpath(entry.compiled.value)) {
      values[`DENY_${index}`] = entry.compiled.value;
    }
  });
  return values;
}

/** Return true only for one complete, balanced parenthesized s-expression. */
export function isBalancedSandboxExpression(value: string): boolean {
  const expression = value.trim();
  if (!expression.startsWith("(") || !expression.endsWith(")")) return false;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
      if (depth === 0 && expression.slice(i + 1).trim().length > 0) return false;
    }
  }

  return depth === 0 && !inString && !escaped;
}

function isCatchAllRawAllow(value: string): boolean {
  return /^\(\s*allow\s+(?:default|file(?:-[A-Za-z0-9_-]+)?\*)\s*\)$/.test(value.trim());
}

/** Validate a boolean shorthand or the flat `sandbox:` frontmatter object. */
export function validateSandboxFrontmatter(value: unknown): SandboxValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof value === "boolean") return { errors, warnings };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      errors: ["sandbox must be a boolean or an object with enabled, rawAllow and domains fields"],
      warnings,
    };
  }

  const sandbox = value as Record<string, unknown>;
  for (const key of Object.keys(sandbox)) {
    if (MOVED_SANDBOX_PATH_KEYS.has(key)) {
      errors.push(`sandbox.${key} has moved; move it to paths.${key}`);
    } else if (!SANDBOX_KEYS.has(key)) {
      errors.push(`sandbox contains unknown key "${key}"`);
    }
  }

  if (sandbox.enabled !== undefined && typeof sandbox.enabled !== "boolean") {
    errors.push("sandbox.enabled must be a boolean");
  }

  for (const key of SANDBOX_LIST_KEYS) {
    const list = sandbox[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`sandbox.${key} must be a list`);
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      if (typeof list[i] !== "string") {
        errors.push(`sandbox.${key}[${i}] must be a string, got ${typeof list[i]}`);
      }
    }
  }

  if (Array.isArray(sandbox.rawAllow)) {
    sandbox.rawAllow.forEach((entry, index) => {
      if (typeof entry !== "string") return;
      if (!isBalancedSandboxExpression(entry)) {
        errors.push(`sandbox.rawAllow[${index}] must be a balanced parenthesized s-expression`);
        return;
      }
      if (isCatchAllRawAllow(entry)) {
        warnings.push(`sandbox.rawAllow[${index}] is a catch-all rule that defeats deny-by-default sandboxing: ${entry}`);
      }
      try {
        tagRawRule(entry, newSandboxTag());
      } catch (err) {
        errors.push(`sandbox.rawAllow[${index}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  return { errors, warnings };
}

/** Validate the raw, one-level `paths:` frontmatter object. */
export function validatePathsFrontmatter(
  value: unknown,
  home?: string,
  options?: { allowRelative?: boolean },
): SandboxValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      errors: ["paths must be an object with allowRead, allowWrite, and deny list fields"],
      warnings: [],
    };
  }

  const resolvedHome = sandboxHome(home);
  // When allowRelative is set (agent-type frontmatter), a `./` or `../` entry is
  // validated by anchoring it at a fixed placeholder before compileSandboxPath,
  // so the relative grammar passes the absolute-path check. Without the option
  // relative entries stay rejected (the generator/kernel never see one).
  const allowRelative = options?.allowRelative === true;
  const anchorForValidation = (entry: string): string =>
    allowRelative && typeof entry === "string"
      ? anchorRelativeEntry(entry, RELATIVE_VALIDATION_ANCHOR)
      : entry;
  const paths = value as Record<string, unknown>;
  for (const key of Object.keys(paths)) {
    if (!(PATHS_KEYS as readonly string[]).includes(key)) {
      errors.push(`paths contains unknown key "${key}"`);
    }
  }

  for (const key of PATHS_KEYS) {
    const list = paths[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`paths.${key} must be a list`);
      continue;
    }
    list.forEach((entry, index) => {
      if (typeof entry !== "string") {
        errors.push(`paths.${key}[${index}] must be a string, got ${typeof entry}`);
        return;
      }
      try {
        compileSandboxPath(anchorForValidation(entry), resolvedHome);
      } catch (err) {
        errors.push(`paths.${key}[${index}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  const readGlobs = Array.isArray(paths.allowRead)
    ? paths.allowRead.filter((entry): entry is string => typeof entry === "string" && /[*?]/.test(entry))
    : [];
  const writeGlobs = Array.isArray(paths.allowWrite)
    ? paths.allowWrite.filter((entry): entry is string => typeof entry === "string" && /[*?]/.test(entry))
    : [];
  for (const readEntry of readGlobs) {
    const canonicalRead = canonicalizeGlobPrefix(expandHome(anchorForValidation(readEntry), resolvedHome));
    const readPrefix = canonicalRead.slice(0, canonicalRead.search(/[*?]/));
    for (const writeEntry of writeGlobs) {
      const canonicalWrite = canonicalizeGlobPrefix(expandHome(anchorForValidation(writeEntry), resolvedHome));
      if (canonicalRead === canonicalWrite) continue;
      const writePrefix = canonicalWrite.slice(0, canonicalWrite.search(/[*?]/));
      if (readPrefix === writePrefix) {
        errors.push(
          `paths.allowRead entry "${readEntry}" and paths.allowWrite entry "${writeEntry}" are different globs with the same literal prefix "${readPrefix}"`,
        );
      }
    }
  }

  return { errors, warnings: [] };
}

/**
 * Generate a deny-by-default Seatbelt profile without adding static baseline
 * permissions. All non-runtime holes come only from the resolved config. Every
 * deny, including the default deny and the denies in rawAllow, carries `tag`
 * (see SANDBOX_TAG).
 */
export function generateProfile(
  config: SandboxConfig,
  paths: PathsConfig,
  params: SandboxProfileParams,
  tag: string,
): string {
  if (!SANDBOX_TAG.test(tag)) throw new Error(`invalid sandbox attribution tag: ${tag}`);
  const allowRoots = profileRuntimeAllowRoots(params);
  const denyRoots = profileRuntimeDenyRoots(params);
  const table = sandboxPathAccessTable(paths, params);
  const lines = [
    "(version 1)",
    denyRule("default", tag),
  ];

  sortedAllowEntries(table, allowRoots).forEach((entry, index) => {
    const matcher = profileMatcher(entry, `ALLOW_${index}`);
    lines.push(`(allow file-read* ${matcher})`);
    lines.push(entry.op === "write" ? `(allow file-write* ${matcher})` : denyRule(`file-write* ${matcher}`, tag));
  });

  config.rawAllow.forEach((entry, index) => {
    if (!isBalancedSandboxExpression(entry)) {
      throw new Error(`sandbox.rawAllow[${index}] must be a balanced parenthesized s-expression`);
    }
    // rawAllow is intentionally the one verbatim SBPL escape hatch; only its
    // denies change, to carry the tag.
    lines.push(tagRawRule(entry, tag));
  });

  // Configured filesystem denies plus the runtime tmux-socket deny are always
  // last: Seatbelt is last-match-wins, so they carve holes the allow table
  // cannot re-open.
  sortedDenyEntries(table, denyRoots).forEach((entry, index) => {
    const matcher = profileMatcher(entry, `DENY_${index}`);
    lines.push(denyRule(`file-read* ${matcher}`, tag));
    lines.push(denyRule(`file-write* ${matcher}`, tag));
  });

  // A runtime deny root (the tmux socket) must ALSO block a unix-socket
  // connect(): Seatbelt gates that under network-outbound, not file-read*/write*,
  // so the file deny above does NOT stop `nc -U <socket>` reaching the
  // unsandboxed tmux server. _all.md carries a blanket
  // `(allow network-outbound (remote unix-socket))`, so emit a scoped deny here —
  // after rawAllow, so last-match-wins beats that blanket allow. The file deny
  // above stays (it blocks reads/writes of files inside the socket dir). This
  // form was verified LIVE to compile and block (src/sandbox.test.ts).
  denyRoots.forEach((root) => {
    lines.push(denyRule(`network-outbound (remote unix-socket (subpath (param "${root.parameterName}")))`, tag));
  });

  // The ordinary /private/tmp floor lets the parent read the helper's
  // atomically-published status/output, but it must never be able to forge or
  // remove them. Keep this write-only deny last so even rawAllow and a broad
  // authored /private/tmp allow cannot reopen mutation access.
  lines.push(denyRule(`file-write* ${SEAL_HELPER_RESULT_MATCHER}`, tag));
  // Seatbelt treats hard/symbolic-link creation as a distinct operation from
  // file-write*. Deny it explicitly so a protected inode cannot be aliased
  // into an ordinary writable /private/tmp pathname.
  lines.push(denyRule(`file-link ${SEAL_HELPER_RESULT_MATCHER}`, tag));

  return `${lines.join("\n")}\n`;
}
