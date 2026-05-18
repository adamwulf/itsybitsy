/**
 * PostToolUse + UserPromptSubmit hook — flips meta.state to 'running'.
 *
 * Without this, an agent that receives a tmux send-keys message (e.g. a
 * notify_manager from another agent) or finishes a background tool stays
 * labeled 'waiting' until its next Stop hook fires.
 */

import { writeAgentState } from "../agents";
import { resolveAgentFromCwd } from "./shared";

export async function hookMarkRunning(): Promise<void> {
  const resolved = resolveAgentFromCwd(process.cwd());
  if (!resolved) return;
  await writeAgentState(resolved.agentDir, "running");
}
