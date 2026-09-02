/**
 * Dispatcher for the three agy hook subcommands (SPEC-ANTIGRAVITY-CLI.md §4.4).
 *
 * agy's hook contract is FAIL-CLOSED: a crash / non-JSON / `{}` / timeout all
 * deny the tool call. That is safe by default, but the dispatcher still wraps
 * argv parsing + the lazy handler import so a thrown ENOENT during `await
 * import()` (or a missing / invalid `<agent-id>`) becomes an explicit deny (for
 * PreToolUse) or a valid no-op (for PreInvocation / Stop) instead of an
 * uncaught throw — and ALWAYS exits 0 in production. Only `--dry-run` may exit
 * non-zero, so the spawn-time precheck can refuse a launch cleanly.
 *
 * Mirrors codex-dispatcher.ts; the only differences are the event set and the
 * agy output shapes.
 */

import { isValidAgentId } from "../validation";
import { buildAgyDenyOutput, AGY_EMPTY_OUTPUT } from "./agy-tools";

export type AgyDispatcherEvent = "pre-tool-use" | "pre-invocation" | "stop";

export interface AgyDispatcherDeps {
  /** Where to write the response payload. Defaults to `process.stdout.write`. */
  write?: (chunk: string) => unknown;
  /** Resolve+invoke the actual handler. Overridable for tests. */
  invokeHandler?: (event: AgyDispatcherEvent, agentId: string) => Promise<void>;
  /** Resolve+invoke the dry-run companion. Defaults to dynamic import. */
  invokeDryRun?: (event: AgyDispatcherEvent, agentId: string) => Promise<void>;
}

/**
 * Pick the right failure payload. PreToolUse is a gate — the only safe
 * fail-closed response is a deny. PreInvocation / Stop are not gates, so `{}`
 * is the correct no-op.
 */
function dispatcherFailureOutput(event: AgyDispatcherEvent, reason: string): string {
  if (event === "pre-tool-use") return buildAgyDenyOutput(reason);
  return AGY_EMPTY_OUTPUT;
}

async function defaultInvokeHandler(
  event: AgyDispatcherEvent,
  agentId: string,
): Promise<void> {
  if (event === "pre-tool-use") {
    const { hookAgyPreToolUse } = await import("./agy-pre-tool-use");
    return hookAgyPreToolUse(agentId);
  }
  if (event === "pre-invocation") {
    const { hookAgyPreInvocation } = await import("./agy-pre-invocation");
    return hookAgyPreInvocation(agentId);
  }
  const { hookAgyStop } = await import("./agy-stop");
  return hookAgyStop(agentId);
}

async function defaultInvokeDryRun(
  event: AgyDispatcherEvent,
  agentId: string,
): Promise<void> {
  if (event === "pre-tool-use") {
    const { hookAgyPreToolUseDryRun } = await import("./agy-pre-tool-use");
    return hookAgyPreToolUseDryRun(agentId);
  }
  if (event === "pre-invocation") {
    const { hookAgyPreInvocationDryRun } = await import("./agy-pre-invocation");
    return hookAgyPreInvocationDryRun(agentId);
  }
  const { hookAgyStopDryRun } = await import("./agy-stop");
  return hookAgyStopDryRun(agentId);
}

/**
 * Run an agy hook dispatcher. Never rejects. Returns `{ exitCode }` so the
 * caller decides whether to `process.exit`. Production exitCode is always 0;
 * the dry-run path returns 1 on failure so the spawn caller can refuse.
 */
export async function runAgyDispatcher(
  event: AgyDispatcherEvent,
  rawAgentId: string | undefined,
  options: { dryRun?: boolean; deps?: AgyDispatcherDeps } = {},
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
