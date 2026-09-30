import { join } from "path";
import { writeAgentState } from "../agents";
import { isValidAgentId } from "../validation";
import { resolveBoundHookAgent } from "./agent-context";
import { resolveAgentFromCwd, SYSTEM_AGENT_ID } from "./shared";

export async function hookMarkRunning(agentId = process.argv[3] ?? ""): Promise<void> {
  const cwd = process.cwd();
  let resolved = agentId ? null : resolveAgentFromCwd(cwd);
  if (agentId === SYSTEM_AGENT_ID) {
    const system = resolveAgentFromCwd(cwd);
    if (system?.agentId === SYSTEM_AGENT_ID) resolved = system;
  } else if (isValidAgentId(agentId)) {
    try {
      const bound = await resolveBoundHookAgent(agentId, cwd);
      resolved = { agentId, agentDir: bound.agentDir };
    } catch {
      return;
    }
  }
  if (!resolved) return;
  await markRunningOnPrompt(resolved.agentDir);
}

/**
 * The prompt-submit state rule, shared by Claude's UserPromptSubmit hook and
 * codex's (SPEC §6.6): a submitted prompt starts a turn, so write `running` —
 * which also ends a manager's `ib ack` (SPEC §8.5.2). That includes a
 * `complete` agent a human types into directly. Only `stopped` is left alone.
 * No-op when meta.json is missing or unreadable.
 */
export async function markRunningOnPrompt(agentDir: string): Promise<void> {
  let current: string | undefined;
  try {
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    current = typeof meta?.state === "string" ? meta.state : undefined;
  } catch {
    return;
  }
  if (current === "stopped") return;
  await writeAgentState(agentDir, "running");
}
