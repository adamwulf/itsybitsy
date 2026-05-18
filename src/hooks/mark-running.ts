import { join } from "path";
import { writeAgentState } from "../agents";
import { resolveAgentFromCwd } from "./shared";

export async function hookMarkRunning(): Promise<void> {
  const resolved = resolveAgentFromCwd(process.cwd());
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
