/**
 * PermissionRequest hook — logs denied tool requests.
 *
 * Fires when Claude requests permission for a tool that isn't auto-allowed.
 * Simply logs the event; PermissionRequest hooks can't override permissions.
 */

import { join } from "path";
import { logAgent } from "../agent-lifecycle";

/**
 * CLI entry for hook-permission-denied subcommand.
 * Reads stdin JSON, logs the denied tool, exits 0.
 */
export async function hookPermissionDenied(agentId: string): Promise<void> {
  // Read JSON from stdin
  let toolName = "unknown";
  try {
    const raw = await new Response(Bun.stdin.stream()).text();
    const json = JSON.parse(raw);
    toolName = json.tool_name ?? "unknown";
  } catch {
    // If stdin parsing fails, log with "unknown"
  }

  // Derive agentDir from cwd pattern or process.cwd()
  const cwd = process.cwd();
  const match = cwd.match(/(.*\/.ittybitty\/agents\/[^/]+)/);
  let agentDir: string;
  if (match) {
    agentDir = match[1]!;
  } else {
    // Fallback: assume standard agent directory layout
    const agentsDirMatch = cwd.match(/(.*\/.ittybitsy\/agents)/);
    agentDir = agentsDirMatch
      ? join(agentsDirMatch[1]!, agentId)
      : join(cwd, ".ittybitsy", "agents", agentId);
  }

  await logAgent(agentDir, `[PermissionRequest] Tool denied: ${toolName}`);

  // Exit 0, no stdout output needed
}
