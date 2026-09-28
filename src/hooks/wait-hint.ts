/**
 * Shared WAITING guidance for rejected wait attempts (SPEC §6.1 / §6.4).
 *
 * Agents often try to wait for a background command or a sub-agent by calling
 * Claude's Monitor tool, or by sleeping / polling in Bash. Those calls are
 * usually rejected (Monitor is not in agent allow lists; `sleep` and polling
 * loops are denied by intercept-task and are not allow-listed either). A bare
 * "Tool not in allow list" leaves the agent polling by hand with Read/tail, so
 * every hook that rejects a wait attempt adds this hint. Both PreToolUse hooks
 * carry it because Claude surfaces only one deny reason when both deny.
 */

/** What an agent should do instead of polling. */
export const WAIT_HINT =
  "To wait, don't poll: make 'WAITING' the LAST line of your message and stop. " +
  "A command you started with run_in_background wakes you when it exits, and the " +
  "watchdog notifies you when a sub-agent completes or needs input.";

/**
 * A Bash command whose purpose is to busy-wait. Matched conservatively so a
 * command that merely mentions "sleep" (`grep sleep file`) is not a match:
 *  - the command IS or STARTS WITH `sleep <number>`, or
 *  - a `while`/`until` loop (anchored at start) whose body contains `sleep`.
 */
export function isBusyWaitBashCommand(command: string): boolean {
  // `sleep 45`, `sleep 5 && ib list`, `sleep 30 ; ib status x`.
  if (/^\s*sleep\s+[0-9.]+/i.test(command)) return true;
  // `until …; do sleep 5; done`, `while …; do sleep 2; done`.
  return /^\s*(while|until)\b/i.test(command) && /\bsleep\b/i.test(command);
}

/** A tool call whose purpose is to wait: Monitor, or a busy-wait Bash command. */
export function isWaitAttempt(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName === "Monitor") return true;
  return toolName === "Bash"
    && typeof toolInput.command === "string"
    && isBusyWaitBashCommand(toolInput.command);
}

/** Append WAIT_HINT to a deny reason when the denied call was a wait attempt. */
export function withWaitHint(
  reason: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  return isWaitAttempt(toolName, toolInput) ? `${reason} — ${WAIT_HINT}` : reason;
}
