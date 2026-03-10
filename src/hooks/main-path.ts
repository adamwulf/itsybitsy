/**
 * Global PreToolUse hook: blocks primary Claude from cd-ing into agent worktrees.
 *
 * Installed in the PRIMARY Claude's ~/.claude/settings.json.
 * Reads stdin JSON from Claude Code (tool_name, tool_input, cwd),
 * and blocks Bash cd commands that target agent worktree paths.
 */

import { resolve, join } from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MainPathInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
}

export interface MainPathResult {
  action: "allow" | "block";
  reason?: string;
}

// ── Pattern ──────────────────────────────────────────────────────────────────

const AGENT_WORKTREE_PATTERN = /\.ittybitty\/agents\/[^/]+\/repo(\/|$)/;

// ── Pure decision logic ──────────────────────────────────────────────────────

/**
 * Determine whether a tool invocation should be blocked.
 * Pure function — no I/O, fully testable.
 */
export function checkMainPath(input: MainPathInput): MainPathResult {
  const { tool_name, tool_input, cwd } = input;

  // Only care about Bash tool
  if (tool_name !== "Bash") {
    return { action: "allow" };
  }

  const command = String(tool_input.command ?? "");

  // Only care about cd commands
  if (!command.startsWith("cd ") && command !== "cd") {
    return { action: "allow" };
  }

  // Extract cd target — strip everything after compound operators (&&, ||, ;, |)
  let cdTarget = command.slice(3).trim();

  // Strip compound command suffixes: && || ; |
  const compoundMatch = cdTarget.match(/^([^&|;]*?)(\s*&&|\s*\|\||\s*;\s*|\s*\|)/);
  if (compoundMatch) {
    cdTarget = compoundMatch[1]!.trim();
  }

  // Strip shell comments (# ...)
  const commentMatch = cdTarget.match(/^(.*?)\s+#/);
  if (commentMatch) {
    cdTarget = commentMatch[1]!.trim();
  }

  // Remove surrounding quotes if present
  if (
    (cdTarget.startsWith('"') && cdTarget.endsWith('"')) ||
    (cdTarget.startsWith("'") && cdTarget.endsWith("'"))
  ) {
    cdTarget = cdTarget.slice(1, -1);
  }

  // Empty cd (go home) — allow
  if (!cdTarget) {
    return { action: "allow" };
  }

  // Resolve relative paths using cwd from the JSON
  let resolved = cdTarget;
  if (!cdTarget.startsWith("/")) {
    resolved = join(cwd, cdTarget);
  }
  resolved = resolve(resolved);

  // Check if resolved path is inside an agent worktree
  if (AGENT_WORKTREE_PATTERN.test(resolved)) {
    return {
      action: "block",
      reason: `Blocked: cannot cd into agent worktree (${resolved})`,
    };
  }

  return { action: "allow" };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI entry point for `ib hooks main-path`.
 * Reads stdin JSON, checks for cd into agent worktrees, outputs decision.
 */
export async function hookMainPath(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    // Invalid JSON — allow (don't break Claude)
    process.exit(0);
    return;
  }

  const input: MainPathInput = {
    tool_name: String(data.tool_name ?? ""),
    tool_input: (data.tool_input as Record<string, unknown>) ?? {},
    cwd: String(data.cwd ?? process.cwd()),
  };

  const result = checkMainPath(input);

  if (result.action === "block") {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(2);
  }

  // Allow — exit 0 with no output
  process.exit(0);
}
