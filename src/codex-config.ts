/**
 * Builds the codex CLI launch argument array per SPEC-CODEX-MODEL.md §5.4.
 *
 * Codex has no `permissions.allow/deny` array equivalent and no on-disk
 * config layer that itsybitsy uses: per the Phase 2 spike, the only reliable
 * way to register a PreToolUse hook in a per-agent worktree is via inline
 * `-c hooks.PreToolUse=[...]` CLI overrides. This module emits exactly those
 * `-c` flags for the three events itsybitsy wires (PreToolUse, SessionStart,
 * Stop), each pointing at an `ib hooks codex-<event> <agentId>` dispatcher.
 *
 * This module is INTENTIONALLY scoped to launch-flag construction. The
 * mandatory `--dangerously-bypass-hook-trust` flag, the model flags
 * (`-m`/`-a`/`-s`), and the actual spawn-time integration with `start.sh` are
 * Phase 4 work.
 */

import { isValidAgentId } from "./validation";

/** Hook events codex fires that itsybitsy registers a handler for. */
export type CodexHookEvent = "PreToolUse" | "SessionStart" | "Stop";

/** Default hook timeout in seconds; matches the Phase 2 spike's verified value. */
export const DEFAULT_CODEX_HOOK_TIMEOUT_SECS = 30;

/** Map each hook event to the ib subcommand that handles it. */
const HOOK_DISPATCHER: Record<CodexHookEvent, string> = {
  PreToolUse: "codex-pre-tool-use",
  SessionStart: "codex-session-start",
  Stop: "codex-stop",
};

/**
 * Hook events registered on every codex agent spawn, in stable order.
 * The order is documented (PreToolUse first, then state hooks) so the
 * resulting CLI line is deterministic across runs.
 */
export const CODEX_REGISTERED_EVENTS: readonly CodexHookEvent[] = [
  "PreToolUse",
  "SessionStart",
  "Stop",
];

export interface BuildCodexLaunchArgsInput {
  /** Absolute path to the `ib` binary used to dispatch hook calls. */
  ibBinaryPath: string;
  /** Agent ID — must satisfy `isValidAgentId`. Interpolated into the hook command. */
  agentId: string;
  /** Optional override for the per-hook timeout in seconds. */
  timeoutSecs?: number;
}

export interface CodexLaunchArgs {
  /** Final flat argv suffix (already includes the `-c flag` pairs). */
  args: string[];
}

/**
 * Reject ib-binary paths that would break the TOML-in-shell quoting in the
 * inline `-c` payload. The path lives inside a TOML double-quoted string,
 * which itself sits inside a shell single-quoted argument. A `'` would close
 * the shell argument; a `"` or `\` would corrupt the TOML; control characters
 * are rejected as defense-in-depth.
 *
 * itsybitsy's default install paths are safe; this guards user-customized
 * installs in paths with apostrophes or quotes.
 */
export function isCodexSafeBinaryPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("'") || path.includes('"') || path.includes("\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Render a single inline `-c hooks.<event>=[...]` flag payload (without the
 * leading `-c` token). Splitting this out lets the tests parse-and-inspect
 * the TOML body for each event independently.
 */
export function renderCodexHookFlagPayload(
  event: CodexHookEvent,
  ibBinaryPath: string,
  agentId: string,
  timeoutSecs: number,
): string {
  const cmd = `${ibBinaryPath} hooks ${HOOK_DISPATCHER[event]} ${agentId}`;
  return `hooks.${event}=[{matcher=".*",hooks=[{type="command",command="${cmd}",timeout=${timeoutSecs}}]}]`;
}

/**
 * Build the `-c` flag array that codex consumes to register itsybitsy's
 * PreToolUse + SessionStart + Stop hooks for a given agent.
 *
 * Per SPEC §5.4:
 *   - One `-c 'hooks.<Event>=[{...}]'` flag per registered event.
 *   - `command` interpolates the absolute path to `ib` with the agent ID.
 *   - `<abs ib>` MUST be path-safe (no apostrophes/quotes/backslashes/control chars).
 *   - `<agentId>` MUST satisfy `isValidAgentId` (no shell-metachar risk).
 *
 * Throws a descriptive error rather than returning a malformed flag list when
 * any precondition fails — callers handle the spawn rejection.
 */
export function buildCodexLaunchArgs(input: BuildCodexLaunchArgsInput): CodexLaunchArgs {
  const { ibBinaryPath, agentId } = input;
  const timeoutSecs = input.timeoutSecs ?? DEFAULT_CODEX_HOOK_TIMEOUT_SECS;

  if (!isCodexSafeBinaryPath(ibBinaryPath)) {
    throw new Error(
      `Unsafe ib binary path for codex launch: ${JSON.stringify(ibBinaryPath)} contains quotes, backslashes, or control characters. ` +
        `Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for codex launch: ${JSON.stringify(agentId)}`);
  }
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0 || !Number.isInteger(timeoutSecs)) {
    throw new Error(`Invalid codex hook timeout: ${timeoutSecs}`);
  }

  const args: string[] = [];
  for (const event of CODEX_REGISTERED_EVENTS) {
    args.push("-c", renderCodexHookFlagPayload(event, ibBinaryPath, agentId, timeoutSecs));
  }
  return { args };
}
