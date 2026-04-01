/**
 * Logs slow hook executions (>1s) to the agent's debug-logs directory.
 *
 * Writes: debug-logs/<hookName>-<datetime>.log
 * Contains: raw stdin input + total elapsed time.
 */

import { join } from "path";
import { mkdir, writeFile } from "fs/promises";

/** Threshold in milliseconds — only log hooks slower than this. */
const SLOW_THRESHOLD_MS = 1000;

/**
 * Derive the agent directory from an explicit agentId or from the cwd.
 * Returns null if the agent directory cannot be determined (e.g. global hooks).
 */
export function resolveAgentDir(
  cwd: string,
  agentId?: string,
): string | null {
  // If we have an agentId, look for the agents dir in cwd
  const agentsMatch = cwd.match(/(.*\/.ittybitty\/agents)/);
  if (agentId && agentsMatch) {
    return join(agentsMatch[1]!, agentId);
  }

  // Try to extract full agent dir from cwd pattern
  const agentMatch = cwd.match(/(.*\/.ittybitty\/agents\/[^/]+)/);
  if (agentMatch) {
    return agentMatch[1]!;
  }

  return null;
}

/**
 * Format a timestamp as YYYYMMDD-HHmmss for filenames.
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Write a debug log for a slow hook or a hook error.
 * Failures are silently ignored — debug logging must never break a hook.
 */
async function writeHookDebugLog(
  hookName: string,
  rawStdin: string,
  elapsedMs: number,
  agentDir: string,
  error?: unknown,
): Promise<void> {
  try {
    const debugDir = join(agentDir, "debug-logs");
    await mkdir(debugDir, { recursive: true });

    const timestamp = formatTimestamp(new Date());
    const suffix = error ? "error" : "slow";
    const filename = `${hookName}-${timestamp}-${suffix}.log`;
    const logPath = join(debugDir, filename);

    const lines: string[] = [];
    lines.push(`hook: ${hookName}`);
    lines.push(`elapsed: ${(elapsedMs / 1000).toFixed(3)}s`);
    lines.push(`timestamp: ${new Date().toISOString()}`);
    if (error) {
      lines.push(`result: ERROR`);
    }
    lines.push("");
    if (error) {
      lines.push("--- error ---");
      if (error instanceof Error) {
        lines.push(`${error.name}: ${error.message}`);
        if (error.stack) {
          lines.push(error.stack);
        }
      } else {
        lines.push(String(error));
      }
      lines.push("");
    }
    lines.push("--- raw stdin ---");
    lines.push(rawStdin || "(empty)");

    await writeFile(logPath, lines.join("\n"));
  } catch {
    /* ignore — debug logging must never break hooks */
  }
}

/**
 * If elapsed > threshold, write a debug log file.
 * Failures are silently ignored — debug logging must never break a hook.
 */
export async function logSlowHook(
  hookName: string,
  rawStdin: string,
  elapsedMs: number,
  agentDir: string | null,
): Promise<void> {
  if (elapsedMs <= SLOW_THRESHOLD_MS) return;
  if (!agentDir) return;
  await writeHookDebugLog(hookName, rawStdin, elapsedMs, agentDir);
}

/**
 * Log a hook error unconditionally (regardless of timing threshold).
 */
export async function logHookError(
  hookName: string,
  rawStdin: string,
  elapsedMs: number,
  agentDir: string | null,
  error: unknown,
): Promise<void> {
  if (!agentDir) return;
  await writeHookDebugLog(hookName, rawStdin, elapsedMs, agentDir, error);
}

/**
 * Wrap a hook execution with timing, slow-hook logging, and error logging.
 *
 * - If the hook takes >1s, writes a slow-hook debug log.
 * - If the hook throws, writes an error debug log (always, regardless of timing).
 * - Errors are re-thrown after logging so the hook's exit behavior is preserved.
 */
export async function withSlowHookLogging(
  hookName: string,
  agentDir: string | null,
  rawStdin: string,
  hookFn: () => Promise<void>,
): Promise<void> {
  const start = performance.now();
  try {
    await hookFn();
    const elapsed = performance.now() - start;
    await logSlowHook(hookName, rawStdin, elapsed, agentDir);
  } catch (error) {
    const elapsed = performance.now() - start;
    await logHookError(hookName, rawStdin, elapsed, agentDir, error);
    throw error;
  }
}
