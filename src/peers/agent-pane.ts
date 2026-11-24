import { readAgentPrompt, type Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { captureLiveDisplayPane } from "../tmux-poller";
import type { PeerPane } from "./peer-link";

/** The receiver alone selects the agent, from the same registered agents and
 * metadata that supply its local dashboard. */
function findAgent(agents: readonly Agent[], repo: string, id: string): Agent {
  const agent = agents.find(a => a.id === id && a.repoRegistryName.toLowerCase() === repo.toLowerCase()
    && a.meta.agentType !== SYSTEM_COORDINATOR_TYPE);
  if (!agent) throw new Error("Agent not found");
  return agent;
}

export async function captureAgentPane(agents: readonly Agent[], repo: string, id: string, lines: number): Promise<PeerPane> {
  const agent = findAgent(agents, repo, id);
  const session = agent.meta.tmux_session;
  const text = session ? await captureLiveDisplayPane(session, lines) : null;
  if (text === null) throw new Error("Agent session is unavailable");
  return { text, state: agent.state };
}

/** The agent's prompt as its local INITIAL PROMPT pane shows it (prompt.txt, else meta.prompt). */
export async function readAgentPromptText(agents: readonly Agent[], repo: string, id: string): Promise<string> {
  return (await readAgentPrompt(findAgent(agents, repo, id))).join("\n");
}
