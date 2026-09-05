import { realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { userHome } from "./home";

/** Fully-resolved, spawn-time sandbox configuration. */
export interface SandboxConfig {
  enabled: boolean;
  rawAllow: string[];
  domains: string[];
}

/** Filesystem policy authored in the top-level `paths:` frontmatter block. */
export interface PathsConfig {
  allowRead: string[];
  allowWrite: string[];
  deny: string[];
}

export type PathOperation = "read" | "write";

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
  HOME?: string;
}

export interface SandboxValidationResult {
  errors: string[];
  warnings: string[];
}

export interface SandboxConfigSource {
  sandbox?: SandboxConfig;
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
}

/**
 * Resolve the kernel-only sandbox policy without touching spawn wiring.
 * Filesystem policy lives independently in `PathsConfig`.
 */
export function resolveSandboxConfig(source: SandboxConfigSource): SandboxConfig {
  if (source.sandbox) {
    return {
      enabled: source.sandbox.enabled,
      rawAllow: [...source.sandbox.rawAllow],
      domains: [...source.sandbox.domains],
    };
  }

  return {
    enabled: false,
    rawAllow: [],
    domains: [],
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
  const tmux = process.env.TMUX;
  const raw = (() => {
    if (tmux && tmux.length > 0) {
      const socketPath = tmux.split(",")[0];
      if (socketPath && socketPath.length > 0) return dirname(socketPath);
    }
    const base = process.env.TMUX_TMPDIR && process.env.TMUX_TMPDIR.length > 0
      ? process.env.TMUX_TMPDIR
      : "/tmp";
    return join(base, `tmux-${uid}`);
  })();
  return canonicalizeSandboxPath(raw);
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
  };
}

/**
 * Runtime ALLOW roots, keyed on the resolved spawn capability. AGENTDIR,
 * WORKTREE, and GITDIR are always read+write boot roots. REPOAGENTS is a write
 * root for a spawner (it writes its child's agent dir) and read-only otherwise.
 * PARENTCLAUDE (`<repo>/.claude`, where a child's settings.local.json is
 * written) is added only for a spawner. This table is extensible: a later root
 * (scratchpad, project dir) adds a row rather than a new emission phase.
 */
function profileRuntimeAllowRoots(params: SandboxProfileParams): ProfileRuntimePathRoot[] {
  const roots: ProfileRuntimePathRoot[] = [
    { path: canonicalizeSandboxPath(params.AGENTDIR), op: "write", parameterName: "AGENTDIR" },
    { path: canonicalizeSandboxPath(params.WORKTREE), op: "write", parameterName: "WORKTREE" },
    { path: canonicalizeSandboxPath(params.GITDIR), op: "write", parameterName: "GITDIR" },
    {
      path: canonicalizeSandboxPath(params.REPOAGENTS),
      op: params.canSpawnChildren ? "write" : "read",
      parameterName: "REPOAGENTS",
    },
  ];
  if (params.canSpawnChildren) {
    roots.push({
      path: canonicalizeSandboxPath(params.PARENTCLAUDE),
      op: "write",
      parameterName: "PARENTCLAUDE",
    });
  }
  // Optional Phase B write roots (project dir, scratchpad). Each is emitted only
  // when the caller supplies it, so a profile that omits both is byte-identical
  // to the pre-Phase-B output. When present they are ordinary write roots and
  // sort into the specificity table like any other runtime root.
  if (params.PROJECTDIR) {
    roots.push({
      path: canonicalizeSandboxPath(params.PROJECTDIR),
      op: "write",
      parameterName: "PROJECTDIR",
    });
  }
  if (params.SCRATCHPAD) {
    roots.push({
      path: canonicalizeSandboxPath(params.SCRATCHPAD),
      op: "write",
      parameterName: "SCRATCHPAD",
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
function profileRuntimeDenyRoots(params: SandboxProfileParams): ProfileRuntimePathRoot[] {
  if (params.canSpawnChildren) return [];
  return [
    { path: canonicalizeSandboxPath(params.TMUXSOCK), op: "read", parameterName: "TMUXSOCK" },
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
    runtimeRoots: profileRuntimeAllowRoots(params).map(({ path, op }) => ({ path, op })),
    runtimeDenyRoots: profileRuntimeDenyRoots(params).map(({ path, op }) => ({ path, op })),
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

/**
 * Resolve access against an already-prepared table. The input must be absolute;
 * it is canonicalized here the same way table entries are (longest existing
 * prefix via canonicalizeSandboxPath), so a caller passing `/tmp/x` resolves
 * identically to `/private/tmp/x` and the canonical-input contract is enforced,
 * not merely documented. Deny wins at every depth. Read-only of `prepared`:
 * resolving never mutates the sorted entries, so one prepared table serves any
 * number of lookups.
 */
export function resolvePreparedAccess(
  prepared: PreparedAccessTable,
  absolutePath: string,
  op: PathOperation,
): "allow" | "deny" {
  if (!absolutePath.startsWith("/")) {
    throw new Error(`resolvePreparedAccess requires an absolute path, got "${absolutePath}"`);
  }
  const canonical = canonicalizeSandboxPath(absolutePath);

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

/** Validate the raw, flat `sandbox:` frontmatter object. */
export function validateSandboxFrontmatter(value: unknown): SandboxValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      errors: ["sandbox must be an object with enabled and list fields"],
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
    errors.push(`sandbox.enabled must be true or false, got "${String(sandbox.enabled)}"`);
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
      } else if (isCatchAllRawAllow(entry)) {
        warnings.push(`sandbox.rawAllow[${index}] is a catch-all rule that defeats deny-by-default sandboxing: ${entry}`);
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
 * permissions. All non-runtime holes come only from the resolved config.
 */
export function generateProfile(
  config: SandboxConfig,
  paths: PathsConfig,
  params: SandboxProfileParams,
): string {
  const allowRoots = profileRuntimeAllowRoots(params);
  const denyRoots = profileRuntimeDenyRoots(params);
  const table = sandboxPathAccessTable(paths, params);
  const lines = [
    "(version 1)",
    "(deny default)",
  ];

  sortedAllowEntries(table, allowRoots).forEach((entry, index) => {
    const matcher = profileMatcher(entry, `ALLOW_${index}`);
    lines.push(`(allow file-read* ${matcher})`);
    lines.push(`(${entry.op === "write" ? "allow" : "deny"} file-write* ${matcher})`);
  });

  config.rawAllow.forEach((entry, index) => {
    if (!isBalancedSandboxExpression(entry)) {
      throw new Error(`sandbox.rawAllow[${index}] must be a balanced parenthesized s-expression`);
    }
    // rawAllow is intentionally the one verbatim SBPL escape hatch.
    lines.push(entry);
  });

  // Configured filesystem denies plus the runtime tmux-socket deny are always
  // last: Seatbelt is last-match-wins, so they carve holes the allow table
  // cannot re-open.
  sortedDenyEntries(table, denyRoots).forEach((entry, index) => {
    const matcher = profileMatcher(entry, `DENY_${index}`);
    lines.push(`(deny file-read* ${matcher})`);
    lines.push(`(deny file-write* ${matcher})`);
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
    lines.push(`(deny network-outbound (remote unix-socket (subpath (param "${root.parameterName}"))))`);
  });

  return `${lines.join("\n")}\n`;
}
