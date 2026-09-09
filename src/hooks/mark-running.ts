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
  // guard: don't resurrect terminal states if this hook fires late
  let current: string | undefined;
  try {
    const meta = await Bun.file(join(resolved.agentDir, "meta.json")).json();
    current = typeof meta?.state === "string" ? meta.state : undefined;
  } catch {
    return;
  }
  if (current === "complete" || current === "stopped") return;
  await writeAgentState(resolved.agentDir, "running");
}
