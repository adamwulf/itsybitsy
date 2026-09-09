/**
 * PermissionRequest hook — denies and logs unexpected native tool requests.
 *
 * Fires when Claude requests permission for a tool that isn't auto-allowed.
 * PreToolUse normally decides first. If native permission resolution is still
 * reached, return Claude's structured PermissionRequest deny instead of leaving
 * an unattended agent waiting on an approval card.
 * Contract: https://code.claude.com/docs/en/hooks#permissionrequest-decision-control
 */

import { join } from "path";
import { logAgent } from "../agent-lifecycle";
import { resolveAgentFromCwd } from "./shared";
import { isValidAgentId } from "../validation";
import { findNoWorktreeAgentsDir } from "./agent-context";

interface PermissionDeniedDeps {
  write?: (output: string) => unknown;
  log?: typeof logAgent;
}

/**
 * CLI entry for hook-permission-denied subcommand.
 * Reads stdin JSON, logs the denied tool, and emits a structured deny. Malformed
 * input and logging failures must never remove the denial.
 *
 * The `agentId` arg is supplied by Claude Code's hook configuration (e.g.,
 * the `agentId` written into `settings.local.json` at agent creation). It
 * is now a fallback for callers whose cwd doesn't resolve via
 * `resolveAgentFromCwd` — when the cwd does resolve (worktree agents and
 * @system), the resolved agentDir wins so logs land in the right place
 * even if the literal arg drifts (e.g., a stale settings file).
 */
export async function hookPermissionDenied(
  agentId: string,
  rawStdin?: string,
  deps: PermissionDeniedDeps = {},
): Promise<void> {
  // Read JSON from stdin (use pre-read value if provided)
  let toolName = "unknown";
  try {
    const raw = rawStdin ?? await new Response(Bun.stdin.stream()).text();
    const json = JSON.parse(raw);
    if (json && typeof json.tool_name === "string") toolName = json.tool_name;
  } catch {
    // If stdin parsing fails, log with "unknown"
  }

  try {
    // A validated no-worktree boundary wins over nested path-shaped cwd data.
    // Otherwise resolveAgentFromCwd preserves regular worktree and system
    // coordinator routing.
    const cwd = process.cwd();
    const noWorktreeAgentsDir = isValidAgentId(agentId)
      ? await findNoWorktreeAgentsDir(agentId, cwd)
      : null;
    let agentDir: string;
    if (noWorktreeAgentsDir) {
      agentDir = join(noWorktreeAgentsDir, agentId);
    } else {
      const resolved = resolveAgentFromCwd(cwd);
      if (!resolved) throw new Error("unrecognized agent context");
      agentDir = resolved.agentDir;
    }

    await (deps.log ?? logAgent)(agentDir, `[PermissionRequest] Tool denied: ${toolName}`);
  } catch { /* denial remains authoritative even if its diagnostic cannot be written */ }

  const write = deps.write ?? ((output: string) => console.log(output));
  write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: "Permission denied by itsybitsy: tool requests must be authorized by the PreToolUse hook.",
      },
    },
  }));
}
