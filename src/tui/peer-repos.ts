/** Registered peer repos and their per-machine manager trees (SPEC §20.5). */
import { truncateToWidth } from "@mariozechner/pi-tui";
import { RESET } from "./colors";
import type { RemoteEntry } from "../agents";
import { REPO_COORDINATOR_TYPE } from "../coordinator-type-names";
import type { RemoteAgent } from "../peers/peer-link";
import { peerLinkStatus, type PeerLinkState } from "../peers/poller";
import { fullyQualifiedAgentId, repoRowKey } from "./row-keys";

export const MAX_REMOTE_DEPTH = 8;
type AgentRow = Extract<RemoteEntry, { kind: "remote-agent" }>;
export interface PeerRepo {
  header: Extract<RemoteEntry, { kind: "remote-repo-header" }>;
  nodes: { row: AgentRow; parent: number }[];
}

export function peerEntryKey(entry: RemoteEntry): string {
  if (entry.kind === "remote-coordinator") return `${entry.peerId}/@system`;
  return entry.kind === "remote-agent"
    ? fullyQualifiedAgentId(entry.peerName, entry.remote.repoRegistryName, entry.remote.id)
    : repoRowKey(entry.repoRegistryName);
}

/** pi-tui inserts SGR 0 before the ellipsis even when truncating sanitized plain text. */
export function truncatePeerField(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…").replaceAll(RESET, "");
}

export function remoteDisplayName(remote: RemoteAgent): string {
  return remote.nickname ?? remote.id;
}

/** First peer supplies the display name and placeholder for a remote-only repo. */
export function collectPeerRepos(links: readonly PeerLinkState[]): Map<string, PeerRepo> {
  const repos = new Map<string, PeerRepo>();
  for (const link of links) {
    const byRepo = new Map<string, RemoteAgent[]>();
    for (const { registryName, displayName } of link.repos ?? []) {
      const key = repoRowKey(registryName);
      byRepo.set(key, []);
      if (!repos.has(key)) repos.set(key, {
        header: { kind: "remote-repo-header", peerName: link.name, repoName: displayName,
          repoRegistryName: registryName, agentCount: 0 },
        nodes: [],
      });
    }
    for (const agent of link.agents ?? []) {
      if (agent.agentType !== REPO_COORDINATOR_TYPE) byRepo.get(repoRowKey(agent.repoRegistryName))?.push(agent);
    }
    for (const [key, agents] of byRepo) {
      const repo = repos.get(key)!;
      appendMachineTree(repo, agents, link);
      repo.header.agentCount = repo.nodes.length;
    }
  }
  return new Map([...repos].sort(([, a], [, b]) => a.header.repoName.localeCompare(b.header.repoName)
    || a.header.repoRegistryName.localeCompare(b.header.repoRegistryName)));
}

/** Resolve hidden parents in preorder, then draw connectors across all peers. */
export function visibleRemoteAgents(repo: PeerRepo, keep: (row: AgentRow) => boolean): AgentRow[] {
  const nearest: number[] = [];
  const parents: number[] = [];
  const lastChild = new Map<number, number>();
  const rows: AgentRow[] = [];
  for (const { parent, row } of repo.nodes) {
    const visibleParent = parent < 0 ? -1 : nearest[parent]!;
    if (!keep(row)) {
      nearest.push(visibleParent);
      continue;
    }
    nearest.push(rows.length);
    parents.push(visibleParent);
    lastChild.set(visibleParent, rows.length);
    rows.push(row);
  }
  const prefixes: string[] = [];
  return rows.map((row, index) => {
    const parent = parents[index]!;
    const prefix = parent < 0 ? "" : prefixes[parent]!;
    const last = lastChild.get(parent) === index;
    const connector = prefix + (last ? "└── " : "├── ");
    prefixes.push((prefix + (last ? "    " : "│   ")).slice(-4 * (MAX_REMOTE_DEPTH - 1)));
    return { ...row, connector };
  });
}

function appendMachineTree(repo: PeerRepo, agents: RemoteAgent[], link: PeerLinkState): void {
  const byId = new Map<string, RemoteAgent>();
  for (const agent of agents) if (!byId.has(agent.id)) byId.set(agent.id, agent);
  const parentOf = (agent: RemoteAgent): RemoteAgent | undefined => {
    const parent = agent.manager === null ? undefined : byId.get(agent.manager);
    return parent === agent ? undefined : parent;
  };
  const children = new Map<RemoteAgent, RemoteAgent[]>();
  const roots: RemoteAgent[] = [];
  for (const agent of agents) {
    const parent = parentOf(agent);
    if (parent === undefined) {
      roots.push(agent);
      continue;
    }
    const siblings = children.get(parent);
    if (siblings) siblings.push(agent);
    else children.set(parent, [agent]);
  }

  // Agents no root reaches are in a cycle: enter each cycle at its first agent.
  const reached = new Set<RemoteAgent>();
  const reach = (start: RemoteAgent): void => {
    const stack = [start];
    while (stack.length > 0) {
      const agent = stack.pop()!;
      if (reached.has(agent)) continue;
      reached.add(agent);
      for (const child of children.get(agent) ?? []) stack.push(child);
    }
  };
  for (const root of roots) reach(root);
  for (const agent of agents) {
    if (!reached.has(agent)) {
      roots.push(agent);
      reach(agent);
    }
  }

  // A cycle can revisit a node, but the parent always precedes its child.
  const visited = new Set<RemoteAgent>();
  const stack = [...roots].reverse().map((agent) => ({ agent, parent: -1 }));
  while (stack.length > 0) {
    const { agent, parent } = stack.pop()!;
    if (visited.has(agent)) continue;
    visited.add(agent);
    const index = repo.nodes.length;
    repo.nodes.push({
      parent,
      row: { kind: "remote-agent", peerId: link.id, peerName: link.name, remote: agent,
        connector: "", linkStatus: peerLinkStatus(link) },
    });
    const kids = children.get(agent) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ agent: kids[i]!, parent: index });
  }
}
