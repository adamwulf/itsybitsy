/**
 * Dispatcher-layer fail-open hardening for the three codex hook subcommands.
 *
 * Codex's hook contract is FAIL-OPEN: any non-zero exit, malformed JSON, or
 * unsupported decision string means the tool call PROCEEDS. The argv parsing
 * + lazy-import scaffolding in src/index.ts therefore has to be just as
 * defensive as the handler bodies themselves: a thrown ENOENT during the
 * `await import()` of a handler module must NOT propagate, and a missing or
 * invalid `<agent-id>` must NOT trigger `process.exit(1)` (which codex would
 * treat as "proceed"). Both paths must emit a valid no-op or deny payload
 * and exit 0.
 *
 * This module owns:
 *   - Three dispatcher functions (one per event) returning a Promise that
 *     never rejects. Each unconditionally writes a valid stdout payload.
 *   - A test-only `runCodexDispatcher` entry point that takes the writer +
 *     loader as dependencies so the wiring is exercised end-to-end without
 *     spawning a subprocess.
 *
 * The matching cases in src/index.ts call these dispatchers and exit 0
 * regardless of outcome. See SPEC §5.4 step 7 / §5.5 fail-open mitigation.
 */

import { isValidAgentId } from "../validation";
import { buildCodexDenyOutput } from "./shared";

const SESSION_START_NOOP = JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
});
// Stop uses the common-output-fields shape (continue / stopReason / systemMessage /
// suppressOutput — all optional), NOT a hookSpecificOutput envelope. An empty
// object is a valid no-op. The earlier hookSpecificOutput shape triggered
// `Stop hook (failed) — error: hook returned invalid stop hook JSON output`.
// See developers.openai.com/codex/hooks#stop.
const STOP_NOOP = "{}";

export type CodexDispatcherEvent = "pre-tool-use" | "session-start" | "stop";

export interface CodexDispatcherDeps {
  /** Where to write the response payload. Defaults to `process.stdout.write`. */
  write?: (chunk: string) => unknown;
  /**
   * Resolve+invoke the actual handler. Overridable so the test can simulate
   * an import failure (rejected promise) without juggling fake module paths.
   */
  invokeHandler?: (event: CodexDispatcherEvent, agentId: string) => Promise<void>;
  /** Resolve+invoke the dry-run companion. Defaults to dynamic import. */
  invokeDryRun?: (event: CodexDispatcherEvent, agentId: string) => Promise<void>;
}

/**
 * Pick the right no-op payload for SessionStart/Stop. PreToolUse has no
 * meaningful no-op — the only safe codex-side fail-open response is a
 * deny payload via `buildCodexDenyOutput`.
 */
function dispatcherFailureOutput(event: CodexDispatcherEvent, reason: string): string {
  if (event === "pre-tool-use") return buildCodexDenyOutput(reason);
  if (event === "session-start") return SESSION_START_NOOP;
  return STOP_NOOP;
}

async function defaultInvokeHandler(
  event: CodexDispatcherEvent,
  agentId: string,
): Promise<void> {
  if (event === "pre-tool-use") {
    const { hookCodexPreToolUse } = await import("./codex-pre-tool-use");
    return hookCodexPreToolUse(agentId);
  }
  if (event === "session-start") {
    const { hookCodexSessionStart } = await import("./codex-session-start");
    return hookCodexSessionStart(agentId);
  }
  const { hookCodexStop } = await import("./codex-stop");
  return hookCodexStop(agentId);
}

async function defaultInvokeDryRun(
  event: CodexDispatcherEvent,
  agentId: string,
): Promise<void> {
  if (event === "pre-tool-use") {
    const { hookCodexPreToolUseDryRun } = await import("./codex-pre-tool-use");
    return hookCodexPreToolUseDryRun(agentId);
  }
  if (event === "session-start") {
    const { hookCodexSessionStartDryRun } = await import("./codex-session-start");
    return hookCodexSessionStartDryRun(agentId);
  }
  const { hookCodexStopDryRun } = await import("./codex-stop");
  return hookCodexStopDryRun(agentId);
}

/**
 * Run a codex hook dispatcher. Never rejects. Returns `{ exitCode }` so the
 * caller decides whether to `process.exit(exitCode)` — for the FAIL-OPEN
 * production path, exitCode is always 0. The dry-run path returns exitCode
 * 1 on failure so the spawn caller can refuse the launch (SPEC §5.4 step 7).
 */
export async function runCodexDispatcher(
  event: CodexDispatcherEvent,
  rawAgentId: string | undefined,
  options: { dryRun?: boolean; deps?: CodexDispatcherDeps } = {},
): Promise<{ exitCode: number; wrote: string }> {
  const deps = options.deps ?? {};
  const write = deps.write ?? ((chunk: string) => process.stdout.write(chunk));
  const invokeHandler = deps.invokeHandler ?? defaultInvokeHandler;
  const invokeDryRun = deps.invokeDryRun ?? defaultInvokeDryRun;

  if (!rawAgentId) {
    const payload = dispatcherFailureOutput(event, "missing agent-id");
    write(payload);
    return { exitCode: 0, wrote: payload };
  }
  if (!isValidAgentId(rawAgentId)) {
    const payload = dispatcherFailureOutput(event, "invalid agent-id");
    write(payload);
    return { exitCode: 0, wrote: payload };
  }

  if (options.dryRun) {
    try {
      await invokeDryRun(event, rawAgentId);
      return { exitCode: 0, wrote: "" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // dry-run is consumed by the spawn-time caller, not by codex itself —
      // exit code 1 is the correct fail signal here. write to stderr via the
      // process.stderr default (callers route this elsewhere).
      process.stderr.write(msg + "\n");
      return { exitCode: 1, wrote: "" };
    }
  }

  try {
    await invokeHandler(event, rawAgentId);
    return { exitCode: 0, wrote: "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const payload = dispatcherFailureOutput(event, `dispatcher load failed: ${msg}`);
    try {
      write(payload);
    } catch { /* even stdout failed; exit 0 silently */ }
    return { exitCode: 0, wrote: payload };
  }
}
