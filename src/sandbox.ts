import { realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";

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
  runtimeRoots: RuntimePathRoot[];
}

export interface SandboxProfileParams {
  AGENTDIR: string;
  WORKTREE: string;
  GITDIR: string;
  REPOAGENTS: string;
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

type CompiledPath =
  | { kind: "plain"; canonical: string; value: string }
  | { kind: "glob"; canonical: string; value: string };

interface ProfileRuntimePathRoot extends RuntimePathRoot {
  parameterName: keyof SandboxProfileParams;
}

interface OrderedPathEntry {
  canonical: string;
  compiled: CompiledPath;
  kind: "plain" | "glob";
  op: PathOperation;
  specificity: number;
  parameterName?: string;
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
  return explicitHome ?? process.env.HOME ?? homedir();
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

/**
 * Apply the write-wins exact-tie rule without mutating the authored config.
 * Canonically identical entries in allowWrite are removed from allowRead;
 * within-list order and all other entries remain unchanged.
 */
export function normalizePathsConfig(paths: PathsConfig, home?: string): PathsConfig {
  const writeKeys = new Set(paths.allowWrite.map((entry) => compiledPathKey(entry, home)));
  return {
    allowRead: paths.allowRead.filter((entry) => !writeKeys.has(compiledPathKey(entry, home))),
    allowWrite: [...paths.allowWrite],
    deny: [...paths.deny],
  };
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
  };
}

function profileRuntimeRoots(params: SandboxProfileParams): ProfileRuntimePathRoot[] {
  return [
    { path: canonicalizeSandboxPath(params.AGENTDIR), op: "write", parameterName: "AGENTDIR" },
    { path: canonicalizeSandboxPath(params.WORKTREE), op: "write", parameterName: "WORKTREE" },
    { path: canonicalizeSandboxPath(params.GITDIR), op: "write", parameterName: "GITDIR" },
    { path: canonicalizeSandboxPath(params.REPOAGENTS), op: "read", parameterName: "REPOAGENTS" },
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
    runtimeRoots: profileRuntimeRoots(params).map(({ path, op }) => ({ path, op })),
  };
}

function sortedAllowEntries(
  table: PathAccessTable,
  profileRoots: ProfileRuntimePathRoot[] = [],
): OrderedPathEntry[] {
  const writeKeys = new Set(table.allowWrite.map((path) => {
    const compiled = compileCanonicalPath(path);
    return `${compiled.kind}\0${compiled.value}`;
  }));
  const normalizedRead = table.allowRead.filter((path) => {
    const compiled = compileCanonicalPath(path);
    return !writeKeys.has(`${compiled.kind}\0${compiled.value}`);
  });
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

function sortedDenyEntries(entries: string[]): OrderedPathEntry[] {
  return entries
    .map((path) => orderedPathEntry(path, "read"))
    .sort(compareOrderedPathEntries);
}

function compiledPathMatches(compiled: CompiledPath, absolutePath: string): boolean {
  if (compiled.kind === "glob") return new RegExp(compiled.value).test(absolutePath);
  if (compiled.value === "/") return absolutePath.startsWith("/");
  return absolutePath === compiled.value || absolutePath.startsWith(`${compiled.value}/`);
}

/**
 * Resolve access from the same sorted table that drives SBPL emission.
 * Inputs are canonical absolute paths/patterns; deny wins at every depth.
 */
export function resolvePathAccess(
  absolutePath: string,
  op: PathOperation,
  table: PathAccessTable,
): "allow" | "deny" {
  if (!absolutePath.startsWith("/")) {
    throw new Error(`resolvePathAccess requires a canonical absolute path, got "${absolutePath}"`);
  }

  if (sortedDenyEntries(table.deny)
    .some((entry) => compiledPathMatches(entry.compiled, absolutePath))) {
    return "deny";
  }

  const matching = sortedAllowEntries(table)
    .filter((entry) => compiledPathMatches(entry.compiled, absolutePath));
  const winner = matching.at(-1);
  if (!winner) return "deny";
  if (op === "read") return "allow";
  return winner.op === "write" ? "allow" : "deny";
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
  const roots = profileRuntimeRoots(params);
  const table = sandboxPathAccessTable(paths, params);
  const values: Record<string, string> = {};

  sortedAllowEntries(table, roots).forEach((entry, index) => {
    if (entry.parameterName) {
      values[entry.parameterName] = entry.compiled.value;
    } else if (entry.compiled.kind === "plain" && !isSafeInlineSubpath(entry.compiled.value)) {
      values[`ALLOW_${index}`] = entry.compiled.value;
    }
  });
  sortedDenyEntries(table.deny).forEach((entry, index) => {
    if (entry.compiled.kind === "plain" && !isSafeInlineSubpath(entry.compiled.value)) {
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
): SandboxValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      errors: ["paths must be an object with allowRead, allowWrite, and deny list fields"],
      warnings: [],
    };
  }

  const resolvedHome = sandboxHome(home);
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
        compileSandboxPath(entry, resolvedHome);
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
    const canonicalRead = canonicalizeGlobPrefix(expandHome(readEntry, resolvedHome));
    const readPrefix = canonicalRead.slice(0, canonicalRead.search(/[*?]/));
    for (const writeEntry of writeGlobs) {
      const canonicalWrite = canonicalizeGlobPrefix(expandHome(writeEntry, resolvedHome));
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
  const roots = profileRuntimeRoots(params);
  const table = sandboxPathAccessTable(paths, params);
  const lines = [
    "(version 1)",
    "(deny default)",
  ];

  sortedAllowEntries(table, roots).forEach((entry, index) => {
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

  // Configured filesystem denies are always last: Seatbelt is last-match-wins.
  sortedDenyEntries(table.deny).forEach((entry, index) => {
    const matcher = profileMatcher(entry, `DENY_${index}`);
    lines.push(`(deny file-read* ${matcher})`);
    lines.push(`(deny file-write* ${matcher})`);
  });

  return `${lines.join("\n")}\n`;
}
