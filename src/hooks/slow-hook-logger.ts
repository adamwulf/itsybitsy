/**
 * Logs every hook execution to the agent's debug-logs directory.
 *
 * Writes: debug-logs/<hookName>-<datetime>-<ok|error>.log
 * Contains: raw stdin input, captured stdout output, and total elapsed time.
 *
 * TODO: In the future, only log hooks that take >1s or error.
 */

import { join } from "path";
import { mkdir, writeFile } from "fs/promises";

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
 * Format a timestamp as YYYYMMDD-HHmmss.mmm for filenames (includes milliseconds).
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const padMs = (n: number) => String(n).padStart(3, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `.${padMs(date.getMilliseconds())}`
  );
}

/**
 * Write a hook debug log file.
 * Failures are silently ignored — debug logging must never break a hook.
 */
async function writeHookDebugLog(
  hookName: string,
  rawStdin: string,
  elapsedMs: number,
  agentDir: string,
  capturedOutput: string,
  error?: unknown,
): Promise<void> {
  try {
    const debugDir = join(agentDir, "debug-logs");
    await mkdir(debugDir, { recursive: true });

    const timestamp = formatTimestamp(new Date());
    const suffix = error ? "error" : "ok";
    const filename = `${timestamp}-${hookName}-${suffix}.log`;
    const logPath = join(debugDir, filename);

    const lines: string[] = [];
    lines.push(`hook: ${hookName}`);
    lines.push(`result: ${error ? "ERROR" : "ok"}`);
    lines.push(`elapsed: ${(elapsedMs / 1000).toFixed(3)}s`);
    lines.push(`timestamp: ${new Date().toISOString()}`);
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
    lines.push("--- stdout ---");
    lines.push(capturedOutput || "(empty)");
    lines.push("");
    lines.push("--- raw stdin ---");
    lines.push(rawStdin || "(empty)");

    await writeFile(logPath, lines.join("\n"));
  } catch {
    /* ignore — debug logging must never break hooks */
  }
}

/**
 * Intercept process.stdout.write to capture hook output.
 * Returns a restore function and a getter for the captured text.
 * The original stdout still receives the data so hook behavior is unchanged.
 */
function interceptStdout(): { restore: () => void; getCaptured: () => string } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = function (chunk: any, ...rest: any[]): boolean {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    chunks.push(text);
    return originalWrite(chunk, ...rest);
  } as typeof process.stdout.write;

  return {
    restore: () => { process.stdout.write = originalWrite; },
    getCaptured: () => chunks.join(""),
  };
}

/**
 * Log a hook execution (success or error) to the agent's debug-logs.
 */
export async function logHookCall(
  hookName: string,
  rawStdin: string,
  elapsedMs: number,
  agentDir: string | null,
  capturedOutput: string,
  error?: unknown,
): Promise<void> {
  if (!agentDir) return;
  await writeHookDebugLog(hookName, rawStdin, elapsedMs, agentDir, capturedOutput, error);
}

/**
 * Wrap a hook execution with timing, stdout capture, and debug logging.
 *
 * - Captures all stdout written by the hook.
 * - Logs every call with timing, input, and output.
 * - On error: logs the error, then re-throws so hook exit behavior is preserved.
 */
export async function withHookLogging(
  hookName: string,
  agentDir: string | null,
  rawStdin: string,
  hookFn: () => Promise<void>,
): Promise<void> {
  const { restore, getCaptured } = interceptStdout();
  const start = performance.now();
  try {
    await hookFn();
    const elapsed = performance.now() - start;
    restore();
    await logHookCall(hookName, rawStdin, elapsed, agentDir, getCaptured());
  } catch (error) {
    const elapsed = performance.now() - start;
    restore();
    await logHookCall(hookName, rawStdin, elapsed, agentDir, getCaptured(), error);
    throw error;
  }
}
