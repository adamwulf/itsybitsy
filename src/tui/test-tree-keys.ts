/**
 * Test helpers: reach an Agents-tree row by an agent's bare id. The tree keys
 * agent rows by fully qualified id (`<machine>/<repo>/<agent>`, SPEC §17.1);
 * fixtures that give every agent a unique id can name it by that id alone.
 */

import type { AgentTreeComponent } from "./agent-tree";

/**
 * The row key of the first agent row (in `flatList`) with this bare id. An id
 * with no row gives a key that matches none; a test about an agent that is
 * gone from the list builds its key with localAgentKey instead.
 */
export function keyOf(tree: AgentTreeComponent, id: string): string {
  const row = tree.flatList.find((f) => f.kind === "agent" && f.agent.id === id);
  return row?.kind === "agent" ? tree.agentKey(row.agent) : `${tree.machineName}/(no row)/${id}`;
}

/** Select the first agent row with this bare id (selectAgentByKey). */
export function selectById(tree: AgentTreeComponent, id: string): boolean {
  return tree.selectAgentByKey(keyOf(tree, id));
}
