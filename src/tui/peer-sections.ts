/**
 * The Agents tree's peer sections (SPEC.md §20.5; docs/plans/iroh-peering.md,
 * "First connected feature"): one section per paired install, built from the
 * poller's in-memory state (src/peers/poller.ts) and drawn below the local
 * tree by AgentTreeComponent. Read-only: nothing here acts on a remote agent.
 *
 * - A section is a `peer-header`, then the install's repos (`remote-repo-header`,
 *   grouped on `repoPath`, sorted by name) and their agents (`remote-agent`),
 *   nested by `manager` within a repo the way local agents nest.
 * - A peer that has never answered has no list: its section is the header only.
 *   A peer that is not connected keeps its last list, marked `stale` (dimmed).
 * - Rows are keyed like local ones (src/tui/row-keys.ts), with the peer's name
 *   as the machine and the remote repo's registry name as the repo: a remote
 *   agent by `<peer>/<repo>/<agent>`, a remote repo by `<peer>/<repo>`, a peer
 *   header by `<peer>`. A remote id that equals a local
 *   one, one on another peer, or one in another repo of the same peer is a row
 *   of its own, since the pairing name prompt keeps peer names apart from each
 *   other and from this machine's name.
 */

import type { PeerSectionEntry } from "../agents";
import { REPO_COORDINATOR_TYPE } from "../coordinator-type-names";
import type { RemoteAgent } from "../peers/peer-link";
import type { PeerLinkState } from "../peers/poller";
import { fullyQualifiedAgentId, repoRowKey } from "./row-keys";

/**
 * Deepest manager nesting drawn. A remote list is the other install's to
 * shape, so a long manager chain must not cost a connector per level on every
 * row; agents deeper than this are drawn at this depth.
 */
export const MAX_REMOTE_DEPTH = 8;

/**
 * The selection key of a peer-section row: its fully qualified id, with the
 * peer's name as the machine (src/tui/row-keys.ts).
 */
export function peerEntryKey(entry: PeerSectionEntry): string {
  switch (entry.kind) {
    case "peer-header":
      return entry.peerName;
    case "remote-repo-header":
      return repoRowKey(entry.peerName, entry.repoRegistryName);
    case "remote-agent":
      return fullyQualifiedAgentId(entry.peerName, entry.remote.repoRegistryName, entry.remote.id);
  }
}

/** Whether `kind` is one of the peer-section row kinds. */
export function isPeerSectionKind(kind: string): kind is PeerSectionEntry["kind"] {
  return kind === "peer-header" || kind === "remote-repo-header" || kind === "remote-agent";
}

/** The name a remote agent is shown by: its nickname, else its id (as local rows). */
export function remoteDisplayName(remote: RemoteAgent): string {
  return remote.nickname ?? remote.id;
}

/**
 * The peer's sections, in `links` order (peers.json order). A remote repo's
 * coordinator (agentType `repo-coordinator`) is left out, as the local tree
 * leaves out local ones: the agents it manages become roots of their repo, a
 * repo whose only agent is its coordinator gets no header, and the counts
 * count only the rows drawn. The list on the wire is unchanged.
 */
export function flattenPeerSections(links: readonly PeerLinkState[]): PeerSectionEntry[] {
  const out: PeerSectionEntry[] = [];
  for (const link of links) {
    const drawn = link.agents === null ? null : link.agents.filter((agent) => agent.agentType !== REPO_COORDINATOR_TYPE);
    const repos = drawn === null ? [] : groupByRepo(drawn);
    out.push({
      kind: "peer-header",
      peerId: link.id,
      peerName: link.name,
      connected: link.connected,
      lastOkAt: link.lastOkAt,
      lastError: link.lastError,
      repoCount: drawn === null ? null : repos.length,
      agentCount: drawn === null ? null : drawn.length,
    });
    const stale = !link.connected;
    for (const repo of repos) {
      out.push({
        kind: "remote-repo-header",
        peerId: link.id,
        peerName: link.name,
        repoName: repo.repoName,
        repoRegistryName: repo.repoRegistryName,
        repoPath: repo.repoPath,
        agentCount: repo.agents.length,
        stale,
      });
      for (const { remote, connector } of nestByManager(repo.agents)) {
        out.push({ kind: "remote-agent", peerId: link.id, peerName: link.name, remote, connector, stale });
      }
    }
  }
  return out;
}

/**
 * Whether two poller snapshots draw the same sections (and the same info
 * panel): the same peers in the same order with the same name, connection,
 * error and agent list. `lastOkAt` counts only while a peer is not connected,
 * where it is shown as "last seen". The poller keeps the same list object
 * while a peer's list is unchanged, so lists compare by reference.
 */
export function samePeerLinks(a: readonly PeerLinkState[], b: readonly PeerLinkState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.name !== y.name || x.connected !== y.connected || x.lastError !== y.lastError || x.agents !== y.agents) {
      return false;
    }
    if (!x.connected && x.lastOkAt !== y.lastOkAt) return false;
  }
  return true;
}

interface RemoteRepo {
  repoName: string;
  repoRegistryName: string;
  repoPath: string;
  agents: RemoteAgent[];
}

/** Group on repoPath (the names are the first agent's); sort by display name, then path. */
function groupByRepo(agents: readonly RemoteAgent[]): RemoteRepo[] {
  const byPath = new Map<string, RemoteRepo>();
  for (const agent of agents) {
    const repo = byPath.get(agent.repoPath);
    if (repo) repo.agents.push(agent);
    else byPath.set(agent.repoPath, { repoName: agent.repoName, repoRegistryName: agent.repoRegistryName, repoPath: agent.repoPath, agents: [agent] });
  }
  return [...byPath.values()].sort(
    (x, y) => x.repoName.localeCompare(y.repoName) || x.repoPath.localeCompare(y.repoPath),
  );
}

/** Box-drawing connector from each ancestor's "is last sibling" bit, as flattenAgentTree draws it. */
function connectorFor(ancestorIsLast: readonly boolean[]): string {
  let connector = "";
  for (let i = 0; i < ancestorIsLast.length - 1; i++) connector += ancestorIsLast[i] ? "    " : "│   ";
  return connector + (ancestorIsLast[ancestorIsLast.length - 1] ? "└── " : "├── ");
}

/**
 * One repo's agents in tree order, each nested under its `manager` when that
 * manager is in the same repo's list (else it is a root, like a local agent
 * whose manager is elsewhere, or is the repo coordinator flattenPeerSections
 * left out). Siblings keep the order the other install sent.
 * The list comes from the other install, so it is not trusted to be a tree: an
 * agent in a manager cycle has no root above it, so each cycle is entered at
 * its first agent in list order, and every agent is drawn exactly once.
 */
function nestByManager(agents: readonly RemoteAgent[]): { remote: RemoteAgent; connector: string }[] {
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

  // Depth-first, iteratively: a chain from the other side must not deepen the stack.
  const out: { remote: RemoteAgent; connector: string }[] = [];
  const visited = new Set<RemoteAgent>();
  const stack: { agent: RemoteAgent; ancestorIsLast: boolean[] }[] = [];
  const pushSiblings = (siblings: RemoteAgent[], ancestorIsLast: boolean[]): void => {
    for (let i = siblings.length - 1; i >= 0; i--) {
      const bits = [...ancestorIsLast, i === siblings.length - 1];
      stack.push({ agent: siblings[i]!, ancestorIsLast: bits.length > MAX_REMOTE_DEPTH ? bits.slice(-MAX_REMOTE_DEPTH) : bits });
    }
  };
  pushSiblings(roots, []);
  while (stack.length > 0) {
    const { agent, ancestorIsLast } = stack.pop()!;
    if (visited.has(agent)) continue;
    visited.add(agent);
    out.push({ remote: agent, connector: connectorFor(ancestorIsLast) });
    // A cycle's entry agent is also its last member's child: it is drawn already.
    pushSiblings((children.get(agent) ?? []).filter((child) => !visited.has(child)), ancestorIsLast);
  }
  return out;
}
