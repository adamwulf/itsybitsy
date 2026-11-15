/**
 * `toolsIgnoringPaths:` — the agent-type frontmatter list of MCP tools whose
 * calls skip the PreToolUse path checks (SPEC-PATH-ALLOWLIST.md, "Tools that
 * skip path checks").
 *
 * The path checks treat a `path` / `file_path` / `notebook_path` key on ANY tool
 * as a local filesystem path. Some MCP tools use those keys for something else
 * (sosumi's `fetchAppleDocumentation` takes `path: "/documentation/..."`, a page
 * on Apple's site), so the hook would deny them. A listed tool skips only the
 * path checks: it must still pass the deny list and the allow list.
 *
 * Only MCP tools can be listed. An entry is either an exact tool name,
 * `mcp__<server>__<tool>`, or a server-wide prefix, `mcp__<server>__*` (one
 * trailing `*`, nothing else). Built-in tools (`Read`, `Bash`, `Write`, ...)
 * can never be listed, and the matcher re-checks both the entry and the tool
 * name, so a malformed entry that reaches the hook still cannot widen a
 * built-in tool.
 *
 * Pure module with no imports, so `agent-types.ts` (validation, inheritance)
 * and the hooks (matching) can both use it without an import cycle.
 */

/**
 * A server name as Claude Code and codex spell it in an MCP tool name. Claude
 * Code normalizes server names to `[A-Za-z0-9_-]` (e.g. `claude-in-chrome`).
 */
const SERVER = "[A-Za-z0-9_-]";

/**
 * An MCP tool name, `mcp__<server>__<tool>`, with a non-empty server and tool
 * and no whitespace or `*`. Used both to validate an exact entry and to decide
 * whether a tool call is an MCP tool at all. The server group is lazy so the
 * first `__` after a non-empty server name separates server from tool.
 */
const MCP_TOOL_NAME_RE = new RegExp(`^mcp__${SERVER}+?__[^\\s*]+$`);

/** A server-wide prefix entry, `mcp__<server>__*`, with a non-empty server. */
const MCP_SERVER_GLOB_RE = new RegExp(`^mcp__${SERVER}+__\\*$`);

/** Accepted shapes, quoted in every validation error. */
const ACCEPTED_SHAPES = "mcp__<server>__<tool> or mcp__<server>__*";

/** True when `toolName` is an MCP tool name (`mcp__<server>__<tool>`). */
export function isMcpToolName(toolName: string): boolean {
  return MCP_TOOL_NAME_RE.test(toolName);
}

/**
 * Why `entry` is not a valid `toolsIgnoringPaths` entry, or null when it is.
 * Used by `validateAllAgentTypes`; the loader and the matcher use
 * {@link isValidToolsIgnoringPathsEntry} to drop the same entries.
 */
export function toolsIgnoringPathsEntryError(entry: unknown): string | null {
  if (typeof entry !== "string") {
    return `entries must be strings; got ${typeof entry}`;
  }
  if (MCP_TOOL_NAME_RE.test(entry) || MCP_SERVER_GLOB_RE.test(entry)) return null;

  const shown = JSON.stringify(entry);
  if (entry === "*") {
    return `${shown} would skip path checks for every tool; list MCP tools only (${ACCEPTED_SHAPES})`;
  }
  if (!entry.startsWith("mcp__")) {
    return `${shown} is not an MCP tool; built-in tools always get path checks, so only ${ACCEPTED_SHAPES} is allowed`;
  }
  if (/^mcp__(?:\*|__|$)/.test(entry)) {
    return `${shown} has no server name; use ${ACCEPTED_SHAPES}`;
  }
  if (entry.includes("*")) {
    return `${shown} has a * in the wrong place; * is allowed only as the whole tool name, mcp__<server>__*`;
  }
  return `${shown} is not ${ACCEPTED_SHAPES}`;
}

/** True when `entry` is an exact MCP tool name or a `mcp__<server>__*` prefix. */
export function isValidToolsIgnoringPathsEntry(entry: unknown): entry is string {
  return toolsIgnoringPathsEntryError(entry) === null;
}

/**
 * Keep only the valid entries of a frontmatter or metadata value, deduplicated
 * in first-seen order. Anything that is not an array yields []. Invalid entries
 * are dropped rather than honored, so a bad file or a corrupt meta.json can only
 * narrow the list (fail closed).
 */
export function sanitizeToolsIgnoringPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isValidToolsIgnoringPathsEntry))];
}

/**
 * Union the lists of several layers (`_all`, `_non_coordinator`, the type),
 * dropping invalid entries and duplicates. Missing layers contribute nothing.
 */
export function unionToolsIgnoringPaths(
  lists: ReadonlyArray<readonly string[] | undefined>,
): string[] {
  return sanitizeToolsIgnoringPaths(lists.flatMap((list) => list ?? []));
}

/**
 * True when `toolName` matches an entry: an exact entry matches that one tool,
 * and `mcp__<server>__*` matches every tool of that server. A tool name that is
 * not an MCP tool name never matches, and invalid entries are skipped, so a
 * built-in tool keeps its path checks even if `Read` or `*` reached the list.
 */
export function toolIgnoresPaths(
  toolName: string,
  entries: readonly string[] | undefined,
): boolean {
  if (!entries || entries.length === 0 || !isMcpToolName(toolName)) return false;
  for (const entry of entries) {
    if (!isValidToolsIgnoringPathsEntry(entry)) continue;
    if (entry.endsWith("__*")) {
      // `mcp__sosumi__*` → prefix `mcp__sosumi__`.
      if (toolName.startsWith(entry.slice(0, -1))) return true;
    } else if (entry === toolName) {
      return true;
    }
  }
  return false;
}

/**
 * The list frozen into `meta.toolsIgnoringPaths` at spawn, sanitized. Absent or
 * malformed metadata yields [] (no tool skips path checks).
 */
export function metaToolsIgnoringPaths(meta: Record<string, unknown>): string[] {
  return sanitizeToolsIgnoringPaths(meta.toolsIgnoringPaths);
}
