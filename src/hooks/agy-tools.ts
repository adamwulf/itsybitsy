/**
 * Antigravity CLI (`agy`) tool-translation table (SPEC-ANTIGRAVITY-CLI.md §4.3).
 *
 * The agent-type allow/deny lists stay in Claude vocabulary. Each `agy` tool
 * call is translated to a synthetic Claude call so the existing `checkPathAccess`
 * matcher can gate it deny-by-default. Sub-agent tools are always denied; any
 * tool not in the table is denied unless its raw `agy` name is present in the
 * merged allow list; a file tool whose required path arg is missing is denied
 * rather than failing open.
 *
 * This module is PURE (no I/O). The handler (agy-pre-tool-use.ts) wires the
 * translation into `checkPathAccess` with path-isolation forced, and owns the
 * stdin/stdout contract.
 */

/** The result of translating one agy tool call. */
export type AgyTranslation =
  | { action: "deny"; reason: string }
  | {
      /** Pass the synthesized Claude call through checkPathAccess. */
      action: "check";
      toolName: string;
      toolInput: Record<string, unknown>;
      /**
       * cwd override for path resolution (run_command carries its own `Cwd`).
       * Absent → the handler defaults to the worktree.
       */
      cwd?: string;
    };

/**
 * Sub-agent tools are ALWAYS denied (D8) — spawning must go through
 * `ib new-agent` so the harness owns the lifecycle. agy 1.1.23 honors a hook
 * deny on `invoke_subagent` (issue #640 fixed).
 */
const AGY_SUBAGENT_TOOLS = new Set(["invoke_subagent", "define_subagent", "manage_subagents"]);

/** Deny reason for sub-agent tools — surfaced to the model as tool output. */
export const AGY_SUBAGENT_DENY_REASON = "spawn sub-agents with `ib new-agent`";

interface FileToolSpec {
  /** Synthetic Claude tool name. */
  toolName: string;
  /** agy arg keys holding the path, tried in order. */
  pathKeys: string[];
  /**
   * When true, a missing path is a hard deny ("path argument missing"). When
   * false the path is optional (agy may search the whole workspace) and a
   * missing path means "check with no path" (allow-list-only gate).
   */
  required: boolean;
}

/** File / path tools: translated to a synthetic Claude call carrying `file_path`. */
const AGY_FILE_TOOLS: Record<string, FileToolSpec> = {
  view_file: { toolName: "Read", pathKeys: ["AbsolutePath"], required: true },
  list_dir: { toolName: "LS", pathKeys: ["DirectoryPath"], required: true },
  find_by_name: { toolName: "Glob", pathKeys: ["SearchDirectory", "DirectoryPath"], required: false },
  grep_search: { toolName: "Grep", pathKeys: ["SearchPath"], required: false },
  write_to_file: { toolName: "Write", pathKeys: ["TargetFile"], required: true },
  replace_file_content: { toolName: "Edit", pathKeys: ["TargetFile"], required: true },
  multi_replace_file_content: { toolName: "MultiEdit", pathKeys: ["TargetFile"], required: true },
};

/** Non-path tools: allow-list-gated by their synthetic Claude name only. */
const AGY_NO_PATH_TOOLS: Record<string, string> = {
  read_url_content: "WebFetch",
  search_web: "WebSearch",
  manage_task: "TodoWrite",
};

/** Read a non-empty string arg by trying each key in order. */
function firstStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Translate an agy tool call to a synthetic Claude call, or a deny.
 *
 * @param name       agy `toolCall.name`
 * @param rawArgs    agy `toolCall.args`
 * @param allowList  the merged agent-type allow list (Claude vocabulary), used
 *                   only for the "unknown tool" escape hatch (raw agy name).
 */
export function translateAgyTool(
  name: string,
  rawArgs: unknown,
  allowList: string[],
): AgyTranslation {
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  // Sub-agent tools: always denied (D8).
  if (AGY_SUBAGENT_TOOLS.has(name)) {
    return { action: "deny", reason: AGY_SUBAGENT_DENY_REASON };
  }

  // run_command → Bash. The command runs in `Cwd`; pass it as the cwd for
  // path resolution and let the shared Bash path scanner gate it.
  if (name === "run_command") {
    const command = args.CommandLine;
    if (typeof command !== "string") {
      return { action: "deny", reason: "run_command missing CommandLine argument" };
    }
    const cwd = typeof args.Cwd === "string" && args.Cwd.length > 0 ? args.Cwd : undefined;
    return { action: "check", toolName: "Bash", toolInput: { command }, cwd };
  }

  // File / path tools.
  const fileSpec = AGY_FILE_TOOLS[name];
  if (fileSpec) {
    const path = firstStringArg(args, fileSpec.pathKeys);
    if (!path) {
      if (fileSpec.required) {
        return { action: "deny", reason: `path argument missing for agy tool '${name}'` };
      }
      // Optional-path tool (find_by_name / grep_search) with no path: gate on
      // the tool name alone (checkPathAccess allows when no file_path present).
      return { action: "check", toolName: fileSpec.toolName, toolInput: {} };
    }
    return { action: "check", toolName: fileSpec.toolName, toolInput: { file_path: path } };
  }

  // Non-path tools.
  const noPathTool = AGY_NO_PATH_TOOLS[name];
  if (noPathTool) {
    return { action: "check", toolName: noPathTool, toolInput: {} };
  }

  // Unknown tool: denied unless the agent-type allow list names the raw agy
  // tool verbatim. When it does, route it through checkPathAccess under its own
  // name (which will find it in the allow list and allow — no path to gate).
  if (allowList.includes(name)) {
    return { action: "check", toolName: name, toolInput: {} };
  }
  return { action: "deny", reason: `Unknown agy tool '${name}' not in allow list` };
}

// ── Output contract (SPEC §4.4) ──────────────────────────────────────────────

/** PreToolUse allow: `{"decision":"allow","reason":"..."}`. */
export function buildAgyAllowOutput(reason: string): string {
  return JSON.stringify({ decision: "allow", reason });
}

/** PreToolUse deny: `{"decision":"deny","reason":"..."}`. */
export function buildAgyDenyOutput(reason: string): string {
  return JSON.stringify({ decision: "deny", reason });
}

/** PreInvocation and Stop no-op: an empty object. */
export const AGY_EMPTY_OUTPUT = "{}";

/** Stop continuation: `{"decision":"continue","reason":"..."}` (D9 nudge). */
export function buildAgyStopContinue(reason: string): string {
  return JSON.stringify({ decision: "continue", reason });
}
