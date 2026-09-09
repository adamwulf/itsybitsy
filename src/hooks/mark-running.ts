import { join } from "path";
import { writeAgentState } from "../agents";
import { isValidAgentId } from "../validation";
import { findNoWorktreeAgentsDir } from "./agent-context";
import { resolveAgentFromCwd } from "./shared";

export async function hookMarkRunning(agentId = process.argv[3] ?? ""): Promise<void> {
  const cwd = process.cwd();
  let resolved = null;
  // UserPromptSubmit hooks for worktree:false Claude sessions run at the shared
  // repo root (or a nested cwd), so the path-shaped resolver cannot identify
  // them. The CLI already supplies the agent id on argv; use it only through
  // the bounded, metadata-validating no-worktree ancestor resolver. Prefer the
  // validated outermost boundary over any nested worktree-shaped path an agent
  // could create; otherwise preserve existing worktree/system resolution.
  if (isValidAgentId(agentId)) {
    const agentsDir = await findNoWorktreeAgentsDir(agentId, cwd);
    if (agentsDir) {
      resolved = { agentId, agentDir: join(agentsDir, agentId) };
    }
  }
  resolved ??= resolveAgentFromCwd(cwd);
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
