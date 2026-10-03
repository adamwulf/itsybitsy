/**
 * `ib hooks statusline <agentId>` — the Claude Code `statusLine` command of
 * every Claude session ib launches (see `buildStatusLine` in
 * src/settings-builder.ts). It is not a hook event: Claude Code runs it on its
 * own statusline schedule and shows its stdout in the footer.
 *
 * 1. Records the input's `rate_limits` for the `ib watch` status bar and the
 *    watchdog (src/claude-rate-limits.ts). This is ib's only source of Claude
 *    plan usage, so ib never reads the macOS keychain.
 * 2. Runs the statusline the session would show without ib (the project's or
 *    the user's `statusLine` command) with the same input and passes its
 *    output through, so the footer looks the same as before.
 *
 * A statusline must never fail visibly: an invalid agent ID or a failed write
 * only skips the record, and the user's statusline still runs.
 */

import { isValidAgentId } from "../validation";
import { InjectionContext } from "../types";
import { parseStatuslineRateLimits, recordClaudeRateLimits } from "../claude-rate-limits";
import { resolveUserStatusLine } from "../settings-builder";
import { SYSTEM_AGENT_ID } from "./shared";

/** Runs a statusline command with `input` on stdin; returns its stdout and exit code. */
export type StatuslineRunner = (command: string, input: string) => Promise<{ stdout: string; exitCode: number }>;

async function runStatuslineCommand(command: string, input: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

/** Injection point for the user's statusline command (tests never run a real one). */
export const statuslineRunnerCtx = new InjectionContext<StatuslineRunner>(runStatuslineCommand);

/** The session's project directory from a statusline input, for project settings lookup. */
function projectDirOf(input: unknown): string | null {
  const value = input as { workspace?: { project_dir?: unknown }; cwd?: unknown } | null;
  if (typeof value?.workspace?.project_dir === "string") return value.workspace.project_dir;
  if (typeof value?.cwd === "string") return value.cwd;
  return null;
}

/**
 * Record the rate limits, then run the user's statusline. Returns the text to
 * print and the exit code; the CLI entry point writes and exits.
 */
export async function hookStatusline(
  stdin: string,
  agentId: string | undefined,
  now: number = Date.now(),
): Promise<{ output: string; exitCode: number }> {
  let input: unknown = null;
  try {
    input = JSON.parse(stdin);
  } catch {
    // Not JSON: nothing to record, but the user's statusline still runs.
  }

  if (agentId !== undefined && (isValidAgentId(agentId) || agentId === SYSTEM_AGENT_ID)) {
    const windows = parseStatuslineRateLimits(input);
    if (windows) {
      try {
        await recordClaudeRateLimits(agentId, windows, now);
      } catch {
        // Best effort: a failed write only skips this reading.
      }
    }
  }

  const inner = await resolveUserStatusLine(projectDirOf(input));
  if (!inner) return { output: "", exitCode: 0 };
  try {
    const { stdout, exitCode } = await statuslineRunnerCtx.fn(inner.command, stdin);
    return { output: stdout, exitCode };
  } catch {
    return { output: "", exitCode: 0 };
  }
}
