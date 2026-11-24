/** Registered peer repos and their per-machine manager trees (SPEC §20.5). */
import { truncateToWidth } from "@mariozechner/pi-tui";
import { RESET } from "./colors";
import type { RemoteEntry } from "../agents";
import { REPO_COORDINATOR_TYPE } from "../coordinator-type-names";
import type { RemoteAgent } from "../peers/peer-link";
import type { SendTarget } from "../peers/send-frame";
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

/** A remote row the dashboard can message: an agent or a peer's system coordinator. */
export type RemoteMessageEntry = Exclude<RemoteEntry, { kind: "remote-repo-header" }>;

/** The wire target for messaging a remote row; none for a repo header. */
export function remoteMessageTarget(entry: RemoteMessageEntry): SendTarget;
export function remoteMessageTarget(entry: RemoteEntry | null): SendTarget | undefined;
export function remoteMessageTarget(entry: RemoteEntry | null): SendTarget | undefined {
  if (entry?.kind === "remote-coordinator") return { kind: "system" };
  if (entry?.kind === "remote-agent") return { kind: "agent", repo: entry.remote.repoRegistryName, agent: entry.remote.id };
}

/** The main-area title for a selected remote row: `<peer>/<agent or repo>`, or the peer. */
export function remoteTitle(entry: RemoteEntry): string {
  switch (entry.kind) {
    case "remote-coordinator":
      return `${entry.peerName}/@system`;
    case "remote-agent":
      return `${entry.peerName}/${remoteDisplayName(entry.remote)}`;
    case "remote-repo-header":
      return `${entry.peerName}/${entry.repoName}`;
  }
}

/** One root of a machine's tree, with that machine's child lists and drawn agents. */
interface MachineRoot {
  link: PeerLinkState;
  root: RemoteAgent;
  children: Map<RemoteAgent, RemoteAgent[]>;
  visited: Set<RemoteAgent>;
}

/** First peer supplies the display name and placeholder for a remote-only repo. */
export function collectPeerRepos(links: readonly PeerLinkState[]): Map<string, PeerRepo> {
  const repos = new Map<string, PeerRepo>();
  const roots = new Map<string, MachineRoot[]>();
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
      const { roots: machineRoots, children } = machineForest(agents);
      const visited = new Set<RemoteAgent>();
      const list = roots.get(key) ?? [];
      for (const root of machineRoots) list.push({ link, root, children, visited });
      roots.set(key, list);
    }
  }
  for (const [key, repo] of repos) {
    // Every machine's roots in one spawn order, oldest first, so the peers' trees interleave.
    const list = (roots.get(key) ?? []).sort((a, b) => a.root.createdEpoch - b.root.createdEpoch);
    appendTrees(repo, list);
    repo.header.agentCount = repo.nodes.length;
  }
  return new Map([...repos].sort(([, a], [, b]) => a.header.repoName.localeCompare(b.header.repoName)
    || a.header.repoRegistryName.localeCompare(b.header.repoRegistryName)));
}

/** Favorites and their descendants, using the same per-machine tree as the Agents tab. */
export function favoriteRemoteAgents(repo: PeerRepo, favorites: ReadonlySet<string>): Set<AgentRow> {
  const shown = new Set<AgentRow>();
  for (const { row, parent } of repo.nodes) {
    const { manager, repoRegistryName } = row.remote;
    if (favorites.has(peerEntryKey(row)) || (parent >= 0 && shown.has(repo.nodes[parent]!.row))
      || (manager !== null && favorites.has(fullyQualifiedAgentId(row.peerName, repoRegistryName, manager)))) {
      shown.add(row);
    }
  }
  return shown;
}

/**
 * Each agent's tree root's spawn time, even when a filter hides that root:
 * what its rows sort by beside the local agents.
 */
export function rootSpawnEpochs(repo: PeerRepo): Map<RemoteAgent, number> {
  const epochs: number[] = [];
  const byAgent = new Map<RemoteAgent, number>();
  for (const { row, parent } of repo.nodes) {
    const epoch = parent < 0 ? row.remote.createdEpoch : epochs[parent]!;
    epochs.push(epoch);
    byAgent.set(row.remote, epoch);
  }
  return byAgent;
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

/** One machine's agents in a repo as roots and child lists, siblings in spawn order. */
function machineForest(agents: RemoteAgent[]): { roots: RemoteAgent[]; children: Map<RemoteAgent, RemoteAgent[]> } {
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
  for (const siblings of children.values()) siblings.sort((a, b) => a.createdEpoch - b.createdEpoch);
  return { roots, children };
}

function appendTrees(repo: PeerRepo, roots: readonly MachineRoot[]): void {
  // A cycle can revisit a node, but the parent always precedes its child.
  for (const { link, root, children, visited } of roots) {
    const stack = [{ agent: root, parent: -1 }];
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
}
