import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { captureLiveDisplayPane } from "../tmux-poller";
import type { PeerPane } from "./peer-link";

/** The receiver alone selects the tmux session, from the same registered
 * agents and metadata that supply its local dashboard. */
export async function captureAgentPane(agents: readonly Agent[], repo: string, id: string, lines: number): Promise<PeerPane> {
  const agent = agents.find(a => a.id === id && a.repoRegistryName.toLowerCase() === repo.toLowerCase()
    && a.meta.agentType !== SYSTEM_COORDINATOR_TYPE);
  if (!agent) throw new Error("Agent not found");
  const session = agent.meta.tmux_session;
  const text = session ? await captureLiveDisplayPane(session, lines) : null;
  if (text === null) throw new Error("Agent session is unavailable");
  return { text, state: agent.state };
}
