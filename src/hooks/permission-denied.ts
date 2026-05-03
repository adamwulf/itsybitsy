/**
 * PermissionRequest hook — logs denied tool requests.
 *
 * Fires when Claude requests permission for a tool that isn't auto-allowed.
 * Simply logs the event; PermissionRequest hooks can't override permissions.
 */

import { join } from "path";
import { logAgent } from "../agent-lifecycle";
import { resolveAgentFromCwd } from "./shared";

/**
 * CLI entry for hook-permission-denied subcommand.
 * Reads stdin JSON, logs the denied tool, exits 0.
 *
 * The `agentId` arg is supplied by Claude Code's hook configuration (e.g.,
 * the `agentId` written into `settings.local.json` at agent creation). It
 * is now a fallback for callers whose cwd doesn't resolve via
 * `resolveAgentFromCwd` — when the cwd does resolve (worktree agents and
 * @system), the resolved agentDir wins so logs land in the right place
 * even if the literal arg drifts (e.g., a stale settings file).
 */
export async function hookPermissionDenied(agentId: string, rawStdin?: string): Promise<void> {
  // Read JSON from stdin (use pre-read value if provided)
  let toolName = "unknown";
  try {
    const raw = rawStdin ?? await new Response(Bun.stdin.stream()).text();
    const json = JSON.parse(raw);
    toolName = json.tool_name ?? "unknown";
  } catch {
    // If stdin parsing fails, log with "unknown"
  }

  // Derive agentDir from cwd. resolveAgentFromCwd handles both worktree
  // agents (cwd inside `<repo>/.ittybitty/agents/<id>/repo`) and the
  // system coordinator (cwd inside `~/.itsybitsy/`). For the system
  // coordinator this routes the log to `~/.itsybitsy/agent.log`.
  const cwd = process.cwd();
  const resolved = resolveAgentFromCwd(cwd);
  let agentDir: string;
  if (resolved) {
    agentDir = resolved.agentDir;
  } else {
    // Fallback: assume standard agent directory layout, using the
    // settings-supplied agentId arg.
    const agentsDirMatch = cwd.match(/(.*\/.ittybitty\/agents)/);
    agentDir = agentsDirMatch
      ? join(agentsDirMatch[1]!, agentId)
      : join(cwd, ".ittybitty", "agents", agentId);
  }

  await logAgent(agentDir, `[PermissionRequest] Tool denied: ${toolName}`);

  // Exit 0, no stdout output needed
}
