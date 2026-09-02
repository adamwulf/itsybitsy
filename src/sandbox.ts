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
  | { kind: "subpath"; value: string }
  | { kind: "regex"; value: string };

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
  const validation = validatePathsFrontmatter(paths);
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
    return { kind: "regex", value: globToSandboxRegex(entry, home) };
  }

  if (entry === "~" || entry.startsWith("~/")) {
    return {
      kind: "subpath",
      value: canonicalizeSandboxPath(expandHome(entry, sandboxHome(home))),
    };
  }

  if (entry.startsWith("/")) {
    return { kind: "subpath", value: canonicalizeSandboxPath(entry) };
  }

  throw new Error(
    `Invalid sandbox path entry "${entry}": bare names are not allowed; use "**/${entry}" or an absolute path`,
  );
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
  if (compiled.kind === "regex") return `(regex #"${compiled.value}")`;
  return `(subpath "${escapeSbplString(compiled.value)}")`;
}

function isSafeInlineSubpath(value: string): boolean {
  // Quotes/control characters can terminate an SBPL string. Use a -D param for
  // those paths so the user-controlled bytes never enter the profile source.
  return !/["\\\n\r\0]/.test(value);
}

function profileMatcher(
  entry: string,
  home: string,
  parameterName: string,
): string {
  const compiled = compilePath(entry, home);
  if (compiled.kind === "regex") return `(regex #"${compiled.value}")`;
  if (!isSafeInlineSubpath(compiled.value)) {
    return `(subpath (param "${parameterName}"))`;
  }
  // Tightening hook: the verified baseline can represent allowRead "/" as
  // `(literal "/")` under file-read-data. Keep the ordinary subtree form for
  // v1 correctness until that op-class special case is deliberately adopted.
  return `(subpath "${escapeSbplString(compiled.value)}")`;
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
  const home = sandboxHome(params.HOME);
  const normalizedPaths = normalizePathsConfig(paths, home);
  const values: Record<string, string> = {
    AGENTDIR: canonicalizeSandboxPath(params.AGENTDIR),
    WORKTREE: canonicalizeSandboxPath(params.WORKTREE),
    GITDIR: canonicalizeSandboxPath(params.GITDIR),
    REPOAGENTS: canonicalizeSandboxPath(params.REPOAGENTS),
  };

  const collect = (entries: string[], prefix: string): void => {
    entries.forEach((entry, index) => {
      const compiled = compilePath(entry, home);
      if (compiled.kind === "subpath" && !isSafeInlineSubpath(compiled.value)) {
        values[`${prefix}_${index}`] = compiled.value;
      }
    });
  };

  collect(normalizedPaths.allowRead, "ALLOW_R");
  collect(normalizedPaths.allowWrite, "ALLOW_W");
  collect(normalizedPaths.deny, "DENY");
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
export function validatePathsFrontmatter(value: unknown): SandboxValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      errors: ["paths must be an object with allowRead, allowWrite, and deny list fields"],
      warnings: [],
    };
  }

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
        compileSandboxPath(entry);
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
    const readPrefix = readEntry.slice(0, readEntry.search(/[*?]/));
    for (const writeEntry of writeGlobs) {
      if (readEntry === writeEntry) continue;
      const writePrefix = writeEntry.slice(0, writeEntry.search(/[*?]/));
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
  const home = sandboxHome(params.HOME);
  const normalizedPaths = normalizePathsConfig(paths, home);
  const lines = [
    "(version 1)",
    "(deny default)",
    '(allow file-read* (subpath (param "AGENTDIR")))',
    '(allow file-write* (subpath (param "AGENTDIR")))',
    '(allow file-read* (subpath (param "GITDIR")))',
    '(allow file-write* (subpath (param "GITDIR")))',
    '(allow file-read* (subpath (param "REPOAGENTS")))',
    '(allow file-write* (subpath (param "WORKTREE")))',
  ];

  normalizedPaths.allowRead.forEach((entry, index) => {
    lines.push(`(allow file-read* ${profileMatcher(entry, home, `ALLOW_R_${index}`)})`);
  });
  normalizedPaths.allowWrite.forEach((entry, index) => {
    lines.push(`(allow file-read* ${profileMatcher(entry, home, `ALLOW_W_${index}`)})`);
    lines.push(`(allow file-write* ${profileMatcher(entry, home, `ALLOW_W_${index}`)})`);
  });

  config.rawAllow.forEach((entry, index) => {
    if (!isBalancedSandboxExpression(entry)) {
      throw new Error(`sandbox.rawAllow[${index}] must be a balanced parenthesized s-expression`);
    }
    // rawAllow is intentionally the one verbatim SBPL escape hatch.
    lines.push(entry);
  });

  // Configured filesystem denies are always last: Seatbelt is last-match-wins.
  normalizedPaths.deny.forEach((entry, index) => {
    const matcher = profileMatcher(entry, home, `DENY_${index}`);
    lines.push(`(deny file-read* ${matcher})`);
    lines.push(`(deny file-write* ${matcher})`);
  });

  return `${lines.join("\n")}\n`;
}
