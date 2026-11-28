/**
 * Row keys of the `ib watch` Agents tree (SPEC §17.1). Every agent row, local
 * or remote, is keyed by its fully qualified id `<machine>/<repo>/<agent>`, so
 * agents with the same id in two repos, or on two machines, are two rows. A
 * repo header is keyed by the lowercased registry name, and the system coordinator by its own sentinel (agent-tree.ts).
 *
 * - machine: this machine's clean name (src/machine-name.ts) for a local row,
 *   or the peer's stored name (the one typed when pairing) for a remote one.
 *   A remote key is therefore not always the address commands take: that uses
 *   the peer's clean name (cleanPeerName), as the info panel's Full id does.
 * - repo: the repo's registry name (`Agent.repoRegistryName`, RepoEntry.name),
 *   never its nickname, so a nickname rename re-keys nothing. A remote row
 *   uses the `repoRegistryName` the other install sent (SPEC §20.4).
 * - agent: the agent's id.
 *
 * No local segment holds a `/`: machine names are cleaned and peer names
 * refused when set, repo names and agent ids are validated
 * (isValidRepoName, isValidAgentId). A remote repo or id is the other side's
 * text, cleaned like every remote field; whatever it holds, the key still
 * starts with that peer's name, so it can only blur that peer's own rows.
 * The screen shows only the agent's name; the info panel shows the full id.
 */

import type { Agent } from "../agents";

/** `<machine>/<repo>/<agent>`. */
export function fullyQualifiedAgentId(machine: string, repo: string, agentId: string): string {
  return `${machine}/${repo}/${agentId}`;
}

/** A local agent's fully qualified id, on the machine named `machine`. */
export function localAgentKey(machine: string, agent: Pick<Agent, "repoRegistryName" | "id">): string {
  return fullyQualifiedAgentId(machine, agent.repoRegistryName, agent.id);
}

/** A leading slash keeps repo keys separate from qualified agent ids. */
export function repoRowKey(repo: string): string {
  return `/${repo.toLowerCase()}`;
}

/**
 * Whether `value` is shaped like a fully qualified agent id: three non-empty
 * segments. Favorites in layout.json that are not (an old bare id) are dropped.
 */
export function isFullyQualifiedAgentId(value: string): boolean {
  const segments = value.split("/");
  return segments.length === 3 && segments.every((segment) => segment !== "");
}
