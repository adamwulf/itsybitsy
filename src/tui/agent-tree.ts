/**
 * Agent tree component — displays agents in a scrollable tree with status indicators.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { computeAge, resolveAgentIcon, isRunningState, isVisibleUnderRunningFilter, subtreeHasNonStopped, type Agent, type FlatEntry, type RemoteEntry } from "../agents";
import type { RepoHealthReport } from "../health-check";
import type { Selection } from "./selection";
import { getStateColors } from "./color-scheme";
import { RESET, BOLD, DIM, ITALIC, REVERSE, RED, UNDERLINE, YELLOW } from "./colors";
import { collectPeerRepos, favoriteRemoteAgents, peerEntryKey, remoteDisplayName, truncatePeerField, visibleRemoteAgents, type PeerRepo } from "./peer-repos";
import { repoDisplayName, type RepoEntry } from "../registry";
import { peerLinkStatus, type PeerLinkState } from "../peers/poller";
import { localAgentKey, repoRowKey } from "./row-keys";
import { PEER_LINK_WORD_WIDTH, peerLinkStateText } from "./peers-dialog";
import { FALLBACK_MACHINE_NAME } from "../machine-name";

export const MAX_TREE_HEIGHT = 7;
const MIN_STATE_COL_WIDTH = 8; // minimum: length of "complete"
/** Widest state column for remote agents: a remote state is the other install's text. */
const MAX_REMOTE_STATE_COL_WIDTH = 16;
export const AGE_COL_WIDTH = 3; // max age length: e.g. "27m"
/** The connector of the last peer coordinator row; "├── " has the same width. */
const PEER_BRANCH_LAST = "└── ";

/**
 * The largest useful scroll offset for `rowCount` rows in a `maxHeight`-line
 * tree: 0 when every row fits, else the offset whose window ends at the last
 * row (a "▲ N more" line plus maxHeight - 1 rows). A larger offset only hides
 * rows above and leaves blank lines below. Shared by the Agents and Teams trees.
 */
export function maxScrollOffset(rowCount: number, maxHeight: number): number {
  return rowCount > maxHeight ? rowCount - maxHeight + 1 : 0;
}

/**
 * Tri-state filter for the agent tree, cycled by the V key:
 *  - "all"          — every repo header is shown
 *  - "non-empty"    — only repos that have at least one agent
 *  - "running-only" — only repos with at least one non-stopped agent, and
 *                     within those repos only the non-stopped agents (i.e.
 *                     hides 'stopped' agents and repos whose agents are all
 *                     stopped). Selected-row and pinned-repo carve-outs still
 *                     force-keep their rows visible.
 */
export type RepoFilter = "all" | "non-empty" | "running-only";

/** Next state in the V-key cycle. */
export function nextRepoFilter(current: RepoFilter): RepoFilter {
  if (current === "all") return "non-empty";
  if (current === "non-empty") return "running-only";
  return "all";
}

/** Map agent state for display: 'unknown' shows as 'running' */
export function displayState(state: string): string {
  return state === "unknown" ? "running" : state;
}

/**
 * Compute state column width from the rows being displayed. A peer
 * coordinator puts its link word in this column, counted as the widest link
 * word (PEER_LINK_WORD_WIDTH) so the tree does not shift when a link
 * connects or drops;
 * a remote agent its state, capped at MAX_REMOTE_STATE_COL_WIDTH because
 * that is the other install's text.
 */
export function computeStateColWidth(agents: FlatEntry[]): number {
  let maxLen = MIN_STATE_COL_WIDTH;
  for (const f of agents) {
    if (f.kind === "agent") {
      maxLen = Math.max(maxLen, displayState(f.agent.state).length);
    } else if (f.kind === "system-coordinator") {
      maxLen = Math.max(maxLen, displayState(f.state).length);
    } else if (f.kind === "remote-coordinator") {
      maxLen = Math.max(maxLen, PEER_LINK_WORD_WIDTH);
    } else if (f.kind === "remote-agent") {
      maxLen = Math.max(maxLen, Math.min(MAX_REMOTE_STATE_COL_WIDTH, visibleWidth(displayState(f.remote.state))));
    }
  }
  return maxLen;
}

/** Get the icon for an agent based on its type or role */
function agentIcon(agent: Agent): string {
  return resolveAgentIcon(agent.meta);
}

/**
 * The name shown for an agent in the (≤60-col) sidebar tree: its nickname if
 * set, else its id. Single shared helper used by BOTH agentNamePrefixWidth and
 * formatAgentRow's namePrefix so the width calc and the rendered text always
 * agree (otherwise the state/age columns misalign). Compact tree shows the
 * nickname ALONE — the full id stays visible in the info panel.
 */
export function agentDisplayName(agent: Agent): string {
  return agent.meta.nickname ?? agent.id;
}

/**
 * The yellow ★ (plus its trailing space) that marks a favorite agent. Every
 * agent-row renderer (this tree, the Teams tree's member rows, and the
 * pane-manager TREE/REPO rows) puts it between the icon and the name —
 * `<icon> ★ <name>` — and includes it in its width math. Empty for a
 * non-favorite. On a selected (REVERSE) row the star is uncolored: reversed
 * yellow would paint a gold cell, so it takes the row's own colors instead.
 */
export function favoriteStar(isFavorite: boolean, selected: boolean = false): string {
  if (!isFavorite) return "";
  return selected ? "★ " : `${YELLOW}★${RESET} `;
}

/** Compute the visible width of the name prefix (connector + icon + star + repo/id) for an agent row */
function agentNamePrefixWidth(agent: Agent, connector: string, isFavorite: boolean): number {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agentIcon(agent);
  return visibleWidth(`${connector}${orphanedPrefix}${icon} ${favoriteStar(isFavorite)}${agentDisplayName(agent)}`);
}

/** Width threshold at or below which compact mode is used */
export const COMPACT_WIDTH_THRESHOLD = 60;

/** Format agent row for the tree.
 *  Compact mode (width <= COMPACT_WIDTH_THRESHOLD): icon [★] agent-id  state  age
 *  Full mode: icon [★] agent-id  state  age  model  prompt/summary
 *  The yellow ★ appears only for a favorite (`isFavorite`); nameColWidth must
 *  come from agentNamePrefixWidth with the same flag so the columns align.
 */
export function formatAgentRow(
  agent: Agent,
  connector: string,
  selected: boolean,
  width: number,
  nameColWidth: number,
  stateColWidth: number = MIN_STATE_COL_WIDTH,
  hasQuestion: boolean = false,
  isFavorite: boolean = false,
): string {
  const compact = width <= COMPACT_WIDTH_THRESHOLD;
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agentIcon(agent);
  const state = displayState(agent.state);
  const stateColor = getStateColors()[state] ?? getStateColors().unknown;

  const nameColor = hasQuestion ? RED : "";
  const nameEnd = hasQuestion ? RESET : "";
  const namePrefix = `${connector}${orphanedPrefix}${icon} ${favoriteStar(isFavorite, selected)}${nameColor}${agentDisplayName(agent)}${nameEnd}`;
  const namePad = Math.max(0, nameColWidth - visibleWidth(namePrefix));
  const coloredState = `${stateColor}${state}${RESET}${" ".repeat(Math.max(0, stateColWidth - state.length))}`;
  const paddedAge = agent.age.padStart(AGE_COL_WIDTH);

  let line: string;
  if (compact) {
    line = `${namePrefix}${" ".repeat(namePad)}  ${coloredState}  ${paddedAge}`;
  } else {
    const promptText = (agent.meta.summary ?? agent.meta.prompt).replace(/\n/g, " ");
    line = `${namePrefix}${" ".repeat(namePad)}  ${coloredState}  ${paddedAge}  ${agent.meta.model}  ${promptText}`;
  }

  const truncated = truncateToWidth(line, width, "");
  if (selected) {
    const pad = Math.max(0, width - visibleWidth(truncated));
    const highlighted = truncated.replaceAll(RESET, RESET + REVERSE);
    return `${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`;
  }
  return truncated;
}

/** Format system coordinator row for the tree */
export function formatCoordinatorRow(
  state: string,
  age: string,
  selected: boolean,
  width: number,
  nameColWidth: number,
  stateColWidth: number = MIN_STATE_COL_WIDTH,
): string {
  const displayedState = displayState(state);
  const stateColor = getStateColors()[displayedState] ?? getStateColors().unknown;
  const namePrefix = "◆ coordinator";
  const namePad = Math.max(0, nameColWidth - visibleWidth(namePrefix));
  const coloredState = `${stateColor}${displayedState}${RESET}${" ".repeat(Math.max(0, stateColWidth - displayedState.length))}`;
  const paddedAge = age.padStart(AGE_COL_WIDTH);

  const line = `${namePrefix}${" ".repeat(namePad)}  ${coloredState}  ${paddedAge}`;
  const truncated = truncateToWidth(line, width, "");
  if (selected) {
    const pad = Math.max(0, width - visibleWidth(truncated));
    const highlighted = truncated.replaceAll(RESET, RESET + REVERSE);
    return `${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`;
  }
  return truncated;
}

/** Sentinel ID used to persist selection on the system coordinator */
const SYSTEM_COORDINATOR_ID = "__system-coordinator__";

/**
 * The selection key of a row on the machine named `machine`, or null for an
 * inert one (parent-header). Every agent row is keyed by its fully qualified
 * id `<machine>/<repo>/<agent>` and a repo header by `/<lowercased repo>`
 * (src/tui/row-keys.ts); a remote agent uses its peer's name as the
 * machine (peerEntryKey). The system coordinator keeps its sentinel.
 */
function entryKey(f: FlatEntry, machine: string): string | null {
  switch (f.kind) {
    case "system-coordinator":
      return SYSTEM_COORDINATOR_ID;
    case "repo-header":
      return repoRowKey(f.repoRegistryName);
    case "parent-header":
      return null;
    case "agent":
      return localAgentKey(machine, f.agent);
    case "remote-coordinator":
    case "remote-repo-header":
    case "remote-agent":
      return peerEntryKey(f);
  }
}

/**
 * The color of a state the other install sent (already through displayState).
 * Only a state's own entry counts: indexing the color table with remote text
 * such as `constructor` or `toString` would otherwise draw an inherited
 * function's source on the row.
 */
export function remoteStateColor(state: string): string {
  const colors = getStateColors();
  return Object.hasOwn(colors, state) ? colors[state]! : colors.unknown!;
}

/** Reverse-video a selected row across its full width, as the local rows do. */
function highlightRow(truncated: string, selected: boolean, width: number): string {
  if (!selected) return truncated;
  const pad = Math.max(0, width - visibleWidth(truncated));
  return `${REVERSE}${truncated.replaceAll(RESET, RESET + REVERSE)}${" ".repeat(pad)}${RESET}`;
}

export function formatRemoteRepoRow(
  entry: Extract<RemoteEntry, { kind: "remote-repo-header" }>,
  selected: boolean,
  width: number,
  pinned = false,
): string {
  const triangle = pinned ? "⚲" : entry.agentCount ? "▾" : "▸";
  const name = truncatePeerField(entry.repoName, width - 2);
  return highlightRow(truncateToWidth(`${BOLD}${triangle} ${name}${RESET}`, width, ""), selected, width);
}

/**
 * A remote agent row: `<connector><name>  <state>`, indented under its repo
 * header. nameColWidth and stateColWidth are the tree's shared columns, so
 * the state lines up with the local rows' state. The caller caps
 * nameColWidth to the width, and the name and the state are cut to their
 * columns, so a long remote value cannot push the state off the row. Dimmed
 * while the peer is not connected. The name is red while the agent has a
 * pending question, as on a local row.
 */
export function formatRemoteAgentRow(
  entry: Extract<RemoteEntry, { kind: "remote-agent" }>,
  selected: boolean,
  width: number,
  nameColWidth: number,
  stateColWidth: number,
  isFavorite = false,
  hasQuestion = false,
): string {
  const offline = entry.linkStatus !== "connected";
  const style = offline ? ITALIC + DIM : ITALIC;
  const prefix = entry.connector + favoriteStar(isFavorite, selected).replace(RESET, RESET + style);
  const name = truncatePeerField(remoteDisplayName(entry.remote), Math.max(1, nameColWidth - visibleWidth(prefix)));
  const namePad = " ".repeat(Math.max(0, nameColWidth - visibleWidth(prefix) - visibleWidth(name)));
  const fullState = displayState(entry.remote.state);
  const state = truncatePeerField(fullState, stateColWidth);
  const statePad = " ".repeat(Math.max(0, stateColWidth - visibleWidth(state)));
  // The styling ends at the state word, before its padding, as on a local row:
  // under a selected row's REVERSE the state color becomes the background, so
  // a color left on through the padding would paint past the word.
  const stateColor = offline ? "" : remoteStateColor(fullState);
  const coloredName = hasQuestion ? `${RED}${name}${RESET}${style}` : name;
  const line = `${style}${prefix}${coloredName}${namePad}  ${stateColor}${state}${RESET}${statePad}`;
  return highlightRow(truncateToWidth(line, width, ""), selected, width);
}

/**
 * A paired machine's coordinator row, under the local coordinator:
 * `<branch><name>  <link>  <age>[  <state>]`. The link word sits in the
 * tree's state column and the age in its age column, so the row lines up
 * with the local rows. Connected: how long the link has been up. Otherwise:
 * when the peer last answered (`2m ago`), then the last reported coordinator
 * state. The caller caps nameColWidth so the link and age fit the width.
 * Dimmed while offline.
 */
export function formatPeerCoordinatorRow(
  entry: Extract<RemoteEntry, { kind: "remote-coordinator" }>,
  branch: string,
  selected: boolean,
  width: number,
  nameColWidth: number,
  stateColWidth: number,
): string {
  const nameWidth = Math.max(1, nameColWidth - visibleWidth(branch));
  const name = truncatePeerField(entry.peerName, nameWidth);
  const namePad = " ".repeat(Math.max(0, nameWidth - visibleWidth(name)));
  const since = entry.connectedAt ?? entry.lastOkAt;
  const age = since === null ? "" : computeAge(Math.floor(since / 1000)).padStart(AGE_COL_WIDTH);
  const ago = entry.connectedAt === null && entry.lastOkAt !== null ? " ago" : "";
  // A connected row needs only the link word; the info panel shows the coordinator's state.
  const state = entry.linkStatus === "connected" || !entry.state ? ""
    : `  ${truncatePeerField(entry.state, MAX_REMOTE_STATE_COL_WIDTH)}`;
  const linkPad = " ".repeat(Math.max(0, stateColWidth - entry.linkStatus.length));
  const tail = age || state ? `${linkPad}  ${age || " ".repeat(AGE_COL_WIDTH)}${ago}${state}` : "";
  const dim = entry.linkStatus === "offline" ? DIM : "";
  const line = `${dim}${branch}${ITALIC}${name}${RESET}${dim}${namePad}  ${peerLinkStateText(entry.linkStatus)}${dim}${tail}${RESET}`;
  return highlightRow(truncateToWidth(line, width, ""), selected, width);
}

/**
 * Rebuild box-drawing connectors (├──, └──, │) for the visible agents in
 * `entries`. Used when a filter hides intermediate agents — the connectors
 * computed at flatten time reference now-hidden ancestors, so each visible
 * agent's effective parent is the nearest visible ancestor in its
 * meta.manager chain, and "is last sibling" is recomputed against the
 * visible siblings only. Repo headers and the system coordinator pass
 * through untouched; order of entries is preserved. `allAgents` maps every
 * agent's fully qualified id (on the machine named `machine`) to the agent,
 * so the chain can walk past hidden ancestors. Every map here is keyed by
 * fully qualified id, so the same agent id in two repos never mixes.
 */
function recomputeConnectorsForVisible(entries: FlatEntry[], allAgents: Map<string, Agent>, machine: string): FlatEntry[] {
  const hasRepoHeaders = entries.some((e) => e.kind === "repo-header");
  // Visible agent keys — to decide which managers in the chain are kept.
  const visibleKeys = new Set<string>();
  for (const e of entries) {
    if (e.kind === "agent") visibleKeys.add(localAgentKey(machine, e.agent));
  }

  // For each visible agent, compute its effective parent (nearest visible
  // ancestor in its meta.manager chain) and its visible-ancestor chain (root
  // → A's parent), preserving the original meta.manager order. A manager is
  // always in its agent's own repo (`ib new-agent` resolves it in that repo's
  // agents dir), so each manager is looked up under the agent's repo; one the
  // lookup does not find ends the chain, and the agent is an effective root
  // of its repo. A visited set guards against meta.manager cycles
  // (self-reference, A→B→A); without it the loop would hang the TUI on every
  // render.
  const effectiveParentKey = new Map<string, string | null>();
  const ancestorChain = new Map<string, string[]>();
  for (const e of entries) {
    if (e.kind !== "agent") continue;
    const chain: string[] = [];
    const visited = new Set<string>([e.agent.id]);
    let mgr = e.agent.meta.manager;
    while (mgr) {
      if (visited.has(mgr)) break;
      visited.add(mgr);
      const mgrKey = localAgentKey(machine, { repoRegistryName: e.agent.repoRegistryName, id: mgr });
      const parentAgent = allAgents.get(mgrKey);
      if (!parentAgent) break;
      // Only include managers that are visible.
      if (visibleKeys.has(mgrKey)) chain.push(mgrKey);
      mgr = parentAgent.meta.manager;
    }
    chain.reverse();
    const key = localAgentKey(machine, e.agent);
    ancestorChain.set(key, chain);
    effectiveParentKey.set(key, chain.length > 0 ? chain[chain.length - 1]! : null);
  }

  // Per repo group, determine each visible agent's "is last visible sibling"
  // bit. Siblings share an effective parent id (null for visible roots).
  // Repo group boundaries: each repo-header starts a new group; absent any
  // repo headers, the whole `entries` list is one group.
  const isLastSibling = new Map<string, boolean>();
  let groupStart = 0;
  for (let i = 0; i <= entries.length; i++) {
    const atBoundary = i === entries.length || entries[i]!.kind === "repo-header";
    if (!atBoundary) continue;
    // Process the previous group [groupStart, i).
    const lastByParent = new Map<string | null, string>();
    for (let j = groupStart; j < i; j++) {
      const e = entries[j]!;
      if (e.kind !== "agent") continue;
      const key = localAgentKey(machine, e.agent);
      lastByParent.set(effectiveParentKey.get(key) ?? null, key);
    }
    for (let j = groupStart; j < i; j++) {
      const e = entries[j]!;
      if (e.kind !== "agent") continue;
      const key = localAgentKey(machine, e.agent);
      isLastSibling.set(key, lastByParent.get(effectiveParentKey.get(key) ?? null) === key);
    }
    groupStart = i + 1;
  }

  // Count visible roots once — used by the single-repo no-header carve-out
  // below (a sole visible root gets an empty connector, matching
  // flattenAgentTree's `multiRoot ? [isLast] : []`). Hoisted out of the
  // per-agent loop to keep this O(N) instead of O(N²).
  let visibleRootCount = 0;
  for (const p of effectiveParentKey.values()) if (p === null) visibleRootCount++;

  // Build connector strings from the ancestor chain + per-node last-sibling
  // bits. Matches flattenAgentTree's connector format exactly.
  const result: FlatEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "agent") {
      result.push(e);
      continue;
    }
    const key = localAgentKey(machine, e.agent);
    const chain = ancestorChain.get(key) ?? [];
    const ancestorIsLast: boolean[] = [];
    for (const ancestorKey of chain) ancestorIsLast.push(isLastSibling.get(ancestorKey) ?? true);
    ancestorIsLast.push(isLastSibling.get(key) ?? true);
    // Roots: when there's no repo header (single-repo mode), a sole visible
    // root gets no connector — matches flattenAgentTree's `multiRoot ? [isLast] : []`.
    if (chain.length === 0 && !hasRepoHeaders && visibleRootCount <= 1) {
      result.push({ ...e, connector: "" });
      continue;
    }
    let connector = "";
    for (let k = 0; k < ancestorIsLast.length - 1; k++) {
      connector += ancestorIsLast[k] ? "    " : "│   ";
    }
    connector += ancestorIsLast[ancestorIsLast.length - 1] ? "└── " : "├── ";
    result.push({ ...e, connector });
  }
  return result;
}

/** Agent tree component with height constraint and scrolling */
export class AgentTreeComponent implements Component {
  private _flatList: FlatEntry[] = [];
  private visibleCache: { inputs: unknown[]; rows: FlatEntry[] } | null = null;
  private peerCoordinators: Extract<RemoteEntry, { kind: "remote-coordinator" }>[] = [];
  private peerRepos = new Map<string, PeerRepo>();
  /** Local single-repo trees normally omit their header. Peering needs its registration, even when empty. */
  registeredRepos: readonly RepoEntry[] = [];
  private selectedIndex = 0;
  private _maxHeight = MAX_TREE_HEIGHT;
  private scrollOffset = 0;
  /** The selected row's key (entryKey): what keeps the selection on its row as the list changes. */
  private selectedId: string | null = null;
  /**
   * The selected local row's repo path (a repo header's own, an agent's); null
   * for the system coordinator, a remote row or no selection. Set with
   * selectedId. Rows share a key only for duplicate registry names from before
   * names were unique (SPEC §17.1 Row keys); the key plus this path names the
   * one row the user chose (matchesSelection), through refreshes, rows added
   * or removed above it, and the V filter's sticky reveal.
   */
  private selectedRowRepo: string | null = null;
  /**
   * Whether the Agents panel currently has a selected row (§17.1). The panel
   * STARTS in no-selection and only enters the selected state via j/k
   * (moveSelection), shift+j/k (moveToRepo), selectAgent/selectAgentByKey (the @-jump),
   * selectByRepoPath, or selectSystemCoordinator. selectedIndex is kept as a non-negative value for the
   * scroll math even when nothing is selected; hasSelection is the single
   * source of truth for "is anything selected". When false, `selection`
   * returns null and no row renders in reverse video.
   */
  private hasSelection = false;
  /**
   * Fully qualified ids of the agents with a pending question: their names
   * render red. A local agent's is its agentKey, a remote agent's its peerEntryKey.
   */
  questionAgentKeys: Set<string> = new Set();
  healthReports: Map<string, RepoHealthReport> = new Map();
  suppressSelection = false;
  /**
   * Tri-state view filter cycled by the dashboard's V key:
   *  - "all"          — show every repo header (current default)
   *  - "non-empty"    — hide repo headers whose repo has no agents
   *  - "running-only" — hide ONLY `stopped` agents, and hide repo headers
   *                     whose agents are ALL stopped. Every non-stopped state
   *                     (running/waiting/complete plus every transient state:
   *                     creating, compacting, rate_limited, api_error,
   *                     api_terms, api_safeguard, merging, restarting, op_stuck,
   *                     unknown) is shown. See `isVisibleUnderRunningFilter`.
   * The currently-selected row's repo (and the selected agent itself, even if
   * stopped) are always force-kept visible via `_stickyRevealedRepoPath`, and
   * pinned repos stay visible, so a stricter filter never yanks the selection
   * or a pinned repo out from under the user.
   * System-coordinator entries are a separate FlatEntry kind and unaffected. */
  repoFilter: RepoFilter = "all";
  /**
   * Repo path that is force-kept visible even though it would otherwise be
   * filtered out — the "the user is sitting on this row, so don't yank it
   * out from under them" carve-out. Set when the selection lands on an
   * empty repo header ("non-empty"/"running-only") or on a non-running
   * agent inside an otherwise-no-running-agents repo ("running-only").
   * Explicitly set by selection-changing methods (NOT derived from selectedId
   * on every getter call) so visibleList stays stable across intra-action
   * selectedId mutations. Cleared when selection moves to a non-filtered
   * row, the coordinator, or no-selection. Only meaningful when
   * repoFilter !== "all".
   */
  private _stickyRevealedRepoPath: string | null = null;

  /** Repo paths the user has pinned via '.'. A pinned repo header is always
   * kept visible regardless of repoFilter; its children still filter normally.
   * Persisted across sessions in ~/.itsybitsy/layout.json (LayoutState
   * .pinnedRepoPaths) — the dashboard restores it in applyLayout() and writes
   * it in persistLayout() after each toggle. (repoFilter itself stays
   * session-only.) */
  pinnedRepoPaths: Set<string> = new Set();
  /** Remote-only pins follow the case-insensitive registry name across peers. */
  pinnedRemoteRepoNames: Set<string> = new Set();

  /**
   * This machine's name (src/machine-name.ts): the first segment of every
   * local agent key (SPEC §17.1, src/tui/row-keys.ts). The dashboard sets it at
   * startup, before any row is selected or favorited.
   */
  machineName: string = FALLBACK_MACHINE_NAME;

  /** Fully qualified ids (`<machine>/<repo>/<agent>`, like selection) of the
   * agents the user has favorited via '.', plus agents made from the
   * Favorites tab. Drives the Favorites view filter below and the yellow ★ on
   * agent rows in every tab. Persisted across sessions in
   * ~/.itsybitsy/layout.json (LayoutState.favoriteAgentIds) — the dashboard
   * restores it in applyLayout() and writes it in persistLayout() after each
   * change. Ids of agents that no longer exist are kept (never pruned). */
  favoriteAgentIds: Set<string> = new Set();

  /**
   * Favorites view (sidebarMode === "favorites", SPEC §17.1). The Favorites
   * tab is a VIEW of this same tree, not a separate tree: selection and focus
   * are shared with the Agents tab. When on, visibleList shows only favorite
   * agents and every same-repo descendant of a favorite (walking
   * meta.manager; agents it spawned in other repos are not shown), the repo
   * headers that still have a shown agent, and their
   * parent-headers; favoriteless repos (pinned or not) are hidden. The system
   * coordinator always shows (it cannot be a favorite). The selected row is
   * always kept visible until the selection moves away. Composes with
   * repoFilter: favorites first, then V.
   * Set via setFavoritesOnly() so the selection re-resolves.
   */
  favoritesOnly = false;

  /**
   * Lines this tree may render. The dashboard sets it before each render: the
   * sidebar tree height normally, the main-area height in TREE mode (where the
   * sidebar hides the tree). A change re-runs ensureSelectedVisible so the
   * stored offset fits the new height — otherwise an offset computed for the
   * tall TREE-mode pane can hide the selected row in the sidebar.
   */
  get maxHeight(): number {
    return this._maxHeight;
  }

  set maxHeight(value: number) {
    if (value === this._maxHeight) return;
    this._maxHeight = value;
    if (this.hasSelection) this.ensureSelectedVisible();
  }

  get flatList(): FlatEntry[] {
    return this._flatList;
  }

  setFlatList(list: FlatEntry[]) {
    const wasEmpty = this._flatList.length === 0;
    this._flatList = list;
    this.visibleCache = null;
    // §17.1: setFlatList must NOT silently (re-)assert a selection. On first
    // populate (and any repopulate) the panel STAYS in whatever selection state
    // it was already in. Repopulating while in no-selection keeps it in
    // no-selection; the user must press j/k or trigger an @-jump to select.
    if (wasEmpty && list.length > 0) {
      this.scrollOffset = 0;
      // Keep selectedIndex at a valid value for the scroll math, but do not
      // flip hasSelection on — startup begins in no-selection.
      this.selectedIndex = 0;
    }
    if (this.hasSelection) {
      // Only re-anchor a real selection to its row after the list changed.
      this.resolveSelection();
    }
    // Guard: if maxHeight hasn't been set yet (still default 1 from sidebar),
    // ensureSelectedVisible may have computed a bogus scrollOffset. Reset it.
    if (wasEmpty && list.length > 0) {
      this.scrollOffset = 0;
    }
  }

  /** A local agent's row key: its fully qualified id on this machine. */
  agentKey(agent: Agent): string {
    return localAgentKey(this.machineName, agent);
  }

  /** The selection key of a row (see entryKey), or null for a parent-header. */
  private rowKey(f: FlatEntry): string | null {
    return entryKey(f, this.machineName);
  }

  /** Whether `key` is a local row's: this machine's, or the system coordinator's. */
  private isLocalKey(key: string): boolean {
    return key === SYSTEM_COORDINATOR_ID || key.startsWith(`${this.machineName}/`);
  }

  /** Whether the local agent is a favorite. */
  isFavorite(agent: Agent): boolean {
    return this.favoriteAgentIds.has(this.agentKey(agent));
  }

  setPeerLinks(links: readonly PeerLinkState[], peers: readonly { id: string; name: string }[] = links): void {
    const selected = this.selectedRemote;
    const byId = new Map(links.map(link => [link.id, link]));
    this.peerCoordinators = peers.map(peer => {
      const link = byId.get(peer.id);
      return {
        kind: "remote-coordinator", peerId: peer.id, peerName: peer.name, state: link?.coordinator?.state ?? null,
        linkStatus: peerLinkStatus(link), connectedAt: link?.connected ? link.connectedAt : null,
        lastOkAt: link?.connected ? null : link?.lastOkAt ?? null,
      };
    });
    this.peerRepos = collectPeerRepos(links);
    this.visibleCache = null;
    if (selected?.kind === "remote-coordinator" && !peers.some(peer => peer.id === selected.peerId)) {
      this.selectSystemCoordinator();
    }
    this.resyncAfterFilterChange();
  }

  private localRows(): FlatEntry[] {
    const rows = this.flatList.filter((f) => f.kind !== "agent" || !f.agent.archived);
    const repo = this.registeredRepos.length === 1 ? this.registeredRepos[0] : undefined;
    if (!repo || (!this.peerRepos.size && this.selectedId !== repoRowKey(repo.name))
        || rows.some((row) => row.kind === "repo-header")) return rows;
    const agents = rows.filter((row) => row.kind === "agent");
    const header: FlatEntry = { kind: "repo-header", repoName: repoDisplayName(repo), repoRegistryName: repo.name,
      repoPath: repo.path, hasAgents: agents.length > 0, hasRunningAgents: agents.some((r) => isRunningState(r.agent.state)),
      hasNonStoppedAgents: agents.some((r) => isVisibleUnderRunningFilter(r.agent.state)) };
    const coordinator = rows.filter((r) => r.kind === "system-coordinator");
    // A single root in the headerless layout has no leading connector.
    const oneRoot = agents.filter((r) => r.depth === 0).length === 1;
    return [...coordinator, header, ...agents.map((r) => oneRoot
      ? { ...r, connector: r.depth === 0 ? "└── " : "    " + r.connector } : r)];
  }

  /** Insert each peer forest after its local agents. Unmatched repos follow in display order. */
  private unifiedRows(local: FlatEntry[]): FlatEntry[] {
    if (!this.peerRepos.size && !this.peerCoordinators.length) return local;
    const remaining = new Map(this.peerRepos);
    const rows: FlatEntry[] = [];
    const agentsFor = (repo: PeerRepo) => {
      const favorites = this.favoritesOnly ? favoriteRemoteAgents(repo, this.favoriteAgentIds) : null;
      return visibleRemoteAgents(repo, row => this.isSelectedRow(row) || (
        (favorites === null || favorites.has(row))
        && (this.repoFilter !== "running-only" || isVisibleUnderRunningFilter(row.remote.state))
      ));
    };
    for (let i = 0; i < local.length; i++) {
      const header = local[i]!;
      const repo = header.kind === "repo-header" ? remaining.get(repoRowKey(header.repoRegistryName)) : undefined;
      if (header.kind !== "repo-header" || !repo) {
        rows.push(header);
        if (header.kind === "system-coordinator") {
          for (const row of this.peerCoordinators) {
            if (!this.favoritesOnly || this.isSelectedRow(row)) rows.push(row);
          }
        }
        continue;
      }
      remaining.delete(repoRowKey(header.repoRegistryName));
      const agents = agentsFor(repo);
      rows.push(agents.length > 0 && !header.hasAgents ? { ...header, hasAgents: true } : header);
      while (local[i + 1]?.kind === "agent") rows.push(local[++i]!);
      for (const agent of agents) rows.push(agent);
    }
    for (const repo of remaining.values()) {
      rows.push(repo.header);
      for (const agent of agentsFor(repo)) rows.push(agent);
    }
    return rows;
  }

  get visibleList(): FlatEntry[] {
    // Local lists can be edited in place before the watcher publishes them.
    // Cache the merged view for one published pair of local and peer snapshots.
    if (this.peerRepos.size === 0) return this.buildVisibleList();
    const single = this.registeredRepos.length === 1 ? this.registeredRepos[0] : undefined;
    const inputs: unknown[] = [single?.name, single?.nickname, single?.path, this.repoFilter, this.favoritesOnly];
    if (this.repoFilter !== "all" || this.favoritesOnly) {
      inputs.push(this.machineName, this.hasSelection, this.selectedId, this.selectedRowRepo, this._stickyRevealedRepoPath);
    }
    // These public sets can change in place. Only the active filters depend on them.
    if (this.repoFilter !== "all") {
      inputs.push(this.pinnedRepoPaths.size);
      for (const path of this.pinnedRepoPaths) inputs.push(path);
      inputs.push(this.pinnedRemoteRepoNames.size);
      for (const name of this.pinnedRemoteRepoNames) inputs.push(name);
    }
    if (this.favoritesOnly) {
      for (const id of this.favoriteAgentIds) inputs.push(id);
    }
    const cached = this.visibleCache;
    if (cached && inputs.length === cached.inputs.length && inputs.every((v, i) => v === cached.inputs[i])) {
      return cached.rows;
    }
    const rows = this.buildVisibleList();
    this.visibleCache = { inputs, rows };
    return rows;
  }

  private buildVisibleList(): FlatEntry[] {
    const base = this.unifiedRows(this.localRows());
    if (!this.peerRepos.size && this.repoFilter === "all" && !this.favoritesOnly) return base;
    // Running-only and the Favorites view can hide intermediate agents, so
    // they need a key → agent lookup over the whole flat list (the favorites
    // ancestor walk and the connector rebuild). Build it once per read —
    // visibleList is read many times per render.
    const needsLookup = this.favoritesOnly || this.repoFilter === "running-only";
    const allAgents = needsLookup ? this.buildAgentLookup() : new Map<string, Agent>();
    // Favorites first, then the V filter (they compose).
    let entries = this.favoritesOnly ? this.applyFavoritesFilter(base, allAgents) : base;
    if (this.repoFilter !== "all") entries = this.applyRepoFilter(entries);
    if (this.favoritesOnly) entries = this.dropAgentlessRepoHeaders(entries);
    entries = this.pruneEmptyParentHeaders(entries);

    // The precomputed connectors reference hidden ancestors, so rebuild them
    // against only the visible subset.
    if (needsLookup) entries = recomputeConnectorsForVisible(entries, allAgents, this.machineName);
    if (this.peerRepos.size > 0) {
      // A following remote root continues the local roots' outermost branch.
      let remoteFollows = false;
      for (let i = entries.length - 1; i >= 0; i--) {
        const row = entries[i]!;
        if (row.kind !== "agent") remoteFollows = row.kind === "remote-agent";
        else if (remoteFollows) entries[i] = { ...row, connector: row.connector.replace(/^└/, "├").replace(/^    /, "│   ") };
      }
    }
    return entries;
  }

  /** Map every agent's fully qualified id in the flat list to the agent. */
  private buildAgentLookup(): Map<string, Agent> {
    const byKey = new Map<string, Agent>();
    for (const e of this._flatList) {
      if (e.kind === "agent") byKey.set(this.agentKey(e.agent), e.agent);
    }
    return byKey;
  }

  /**
   * Favorites view, first pass: keep an agent iff it is a favorite, has a
   * favorite ancestor, or is the selected row. The system coordinator and the
   * headers pass through — dropAgentlessRepoHeaders and
   * pruneEmptyParentHeaders remove the empty headers after the V filter ran.
   * `byKey` maps every agent's fully qualified id in the flat list to it.
   */
  private applyFavoritesFilter(entries: FlatEntry[], byKey: Map<string, Agent>): FlatEntry[] {
    return entries.filter((f) => {
      if (f.kind !== "agent") return true;
      return this.isSelectedRow(f) || this.hasFavoriteInChain(f.agent, byKey);
    });
  }

  /**
   * True if `agent` or any ancestor in its meta.manager chain is a favorite.
   * A manager is always in its agent's own repo (`ib new-agent` resolves it in
   * that repo's agents dir), so each one is looked up, and checked, under the
   * agent's repo: the same id in another repo is another agent. A manager that
   * is gone from the flat list (retired/merged — ib does not cascade) still
   * counts if it is a favorite, so the orphans of a gone favorite manager keep
   * showing; the walk ends there because the gone manager's own manager is
   * unknown. Agents a favorite spawns in other repos record only
   * meta.spawned_by, never meta.manager, and are not followed. A visited set
   * guards against meta.manager cycles.
   */
  private hasFavoriteInChain(agent: Agent, byKey: Map<string, Agent>): boolean {
    if (this.isFavorite(agent)) return true;
    const visited = new Set<string>([agent.id]);
    let mgr = agent.meta.manager;
    while (mgr) {
      if (visited.has(mgr)) return false;
      visited.add(mgr);
      const mgrKey = localAgentKey(this.machineName, { repoRegistryName: agent.repoRegistryName, id: mgr });
      if (this.favoriteAgentIds.has(mgrKey)) return true;
      const parent = byKey.get(mgrKey);
      if (!parent) return false;
      mgr = parent.meta.manager;
    }
    return false;
  }

  /**
   * Favorites view, last pass: drop a repo header that has no shown agent
   * beneath it. A repo's agents follow its header contiguously, so the header
   * has a shown agent iff the next entry is an agent. The selected header is
   * kept (selected-row carve-out). Pins do not apply here — they are a V-filter
   * concept, so a pinned favoriteless repo is hidden too.
   */
  private dropAgentlessRepoHeaders(entries: FlatEntry[]): FlatEntry[] {
    return entries.filter((f, i) => {
      if (f.kind !== "repo-header" && f.kind !== "remote-repo-header") return true;
      if (this.isSelectedRow(f)) return true;
      const next = entries[i + 1];
      return next?.kind === "agent" || next?.kind === "remote-agent";
    });
  }

  /**
   * The V filter (repoFilter "non-empty" / "running-only") over `entries`.
   * Callers skip it for "all". Parent-header pruning and connector rebuilds
   * happen in visibleList after every filter pass.
   */
  private applyRepoFilter(entries: FlatEntry[]): FlatEntry[] {
    const sticky = this._stickyRevealedRepoPath;
    const agentsVisible = entries.filter((f) => {
      if (f.kind !== "agent" || this.repoFilter !== "running-only") return true;
      // Keep local managers that provide context for a non-stopped descendant.
      return isVisibleUnderRunningFilter(f.agent.state) || subtreeHasNonStopped(f.agent) || this.isSelectedRow(f);
    });
    return agentsVisible.filter((f, i) => {
      if (f.kind !== "repo-header" && f.kind !== "remote-repo-header") return true;
      const next = agentsVisible[i + 1];
      if (next?.kind === "agent" || next?.kind === "remote-agent" || this.isSelectedRow(f)) return true;
      if (f.kind === "remote-repo-header") return this.pinnedRemoteRepoNames.has(f.repoRegistryName.toLowerCase());
      const passes = this.repoFilter === "non-empty" ? f.hasAgents : f.hasNonStoppedAgents;
      return passes || this.pinnedRepoPaths.has(f.repoPath) || f.repoPath === sticky;
    });
  }

  /**
   * Second pass over an already-filtered list: drop any parent-header that has
   * no surviving repo-header beneath it. Parent-headers are a pure display
   * grouping — in the flat list the repos belonging to a parent-header are
   * emitted contiguously right after it, up to the next parent-header (or the
   * end of the list). A parent-header is kept iff at least one repo-header in
   * that span survived the first-pass filter. Entry order is preserved.
   *
   * The survival decision is delegated entirely to the first pass: any
   * repo-header still present here already passed the hasAgents/
   * hasNonStoppedAgents / pinned / sticky checks, so this pass agrees with that
   * logic by construction (it never re-derives survival).
   */
  private pruneEmptyParentHeaders(entries: FlatEntry[]): FlatEntry[] {
    return entries.filter((f, i) => {
      if (f.kind !== "parent-header") return true;
      // Scan forward until the next parent-header; keep this header iff a
      // surviving repo-header appears in that span.
      for (let j = i + 1; j < entries.length; j++) {
        const next = entries[j];
        if (next === undefined || next.kind === "parent-header") break;
        if (next.kind === "repo-header") return true;
      }
      return false;
    });
  }

  /**
   * Recompute _stickyRevealedRepoPath from the current selection. Called after
   * every selection mutation so the filter has a stable input across the rest
   * of the operation. No-op when repoFilter === "all" (filter ignores sticky
   * anyway), but we still null it out so a later toggle starts clean.
   */
  private updateStickyReveal(): void {
    if (this.repoFilter === "all" || !this.hasSelection || this.selectedId === null) {
      this._stickyRevealedRepoPath = null;
      return;
    }
    // The selected local row's repo (a repo header's own, or an agent's),
    // remembered with the key, so a row that shares the key is never revealed
    // in its place.
    const repoPath = this.selectedRowRepo;
    if (repoPath === null) {
      this._stickyRevealedRepoPath = null;
      return;
    }
    // Only stick if the matching repo-header would otherwise be filtered
    // out by the active filter — otherwise it's already visible on its own
    // merits and sticky would just hide stale state on the next toggle.
    const header = this.localRows().find(
      (f) => f.kind === "repo-header" && f.repoPath === repoPath
    );
    if (!header || header.kind !== "repo-header") {
      this._stickyRevealedRepoPath = null;
      return;
    }
    const wouldBeHidden = this.repoFilter === "non-empty"
      ? !header.hasAgents
      : !header.hasNonStoppedAgents;
    this._stickyRevealedRepoPath = wouldBeHidden ? repoPath : null;
  }

  /** The repo of a local row (a repo header's own, an agent's), or null. */
  private static rowRepoPath(f: FlatEntry): string | null {
    return f.kind === "repo-header" ? f.repoPath : f.kind === "agent" ? f.agent.repoPath : null;
  }

  /**
   * Whether `f` is the row named by `key` and the remembered selectedRowRepo:
   * its key, and for a local row its repo too. Rows share a key only for
   * duplicate registry names from before names were unique (SPEC §17.1 Row
   * keys); the repo tells them apart. A remote row has no repo, so its
   * key alone names it.
   */
  private matchesSelection(f: FlatEntry, key: string | null): boolean {
    if (key === null || this.rowKey(f) !== key) return false;
    const repo = AgentTreeComponent.rowRepoPath(f);
    return repo === null || this.selectedRowRepo === null || repo === this.selectedRowRepo;
  }

  /** Whether `f` is the selected row (matchesSelection with the selected key). */
  private isSelectedRow(f: FlatEntry): boolean {
    return this.hasSelection && this.matchesSelection(f, this.selectedId);
  }

  /**
   * Change the repo-filter mode. Updates sticky-reveal based on the current
   * selection, then re-resolves selectedIndex so it stays consistent with
   * the (now possibly shorter) visibleList — without this, hidden rows above
   * the selection would leave selectedIndex pointing past the new end.
   */
  setRepoFilter(value: RepoFilter): void {
    if (this.repoFilter === value) return;
    this.repoFilter = value;
    this.updateStickyReveal();
    this.resyncAfterFilterChange();
  }

  /** Toggle whether the repo at repoPath is pinned (always-visible under V). */
  togglePinnedRepo(repoPath: string): boolean {
    return this.togglePin(this.pinnedRepoPaths, repoPath);
  }

  togglePinnedRemoteRepo(registryName: string): boolean {
    return this.togglePin(this.pinnedRemoteRepoNames, registryName.toLowerCase());
  }

  private togglePin(pins: Set<string>, key: string): boolean {
    const nowPinned = !pins.has(key);
    if (nowPinned) pins.add(key);
    else pins.delete(key);
    // Selection indices are computed against visibleList, which just changed
    // for this repo; re-resolve so selectedIndex stays consistent.
    this.resyncAfterFilterChange();
    return nowPinned;
  }

  /** Turn the Favorites view on or off (see `favoritesOnly`). */
  setFavoritesOnly(value: boolean): void {
    if (this.favoritesOnly === value) return;
    this.favoritesOnly = value;
    this.resyncAfterFilterChange();
  }

  /**
   * Toggle whether the agent with this fully qualified id (agentKey) is a
   * favorite. Returns the new state.
   */
  toggleFavorite(key: string): boolean {
    const nowFavorite = !this.favoriteAgentIds.has(key);
    if (nowFavorite) this.favoriteAgentIds.add(key);
    else this.favoriteAgentIds.delete(key);
    // In the Favorites view this adds or removes rows (the selected row stays
    // by the carve-out), so re-resolve like a pin toggle.
    this.resyncAfterFilterChange();
    return nowFavorite;
  }

  /** Mark the agent with this fully qualified id as a favorite; a no-op when it already is one. */
  addFavorite(key: string): void {
    if (this.favoriteAgentIds.has(key)) return;
    this.favoriteAgentIds.add(key);
    this.resyncAfterFilterChange();
  }

  /**
   * Keep selectedIndex/scrollOffset consistent after visibleList changed shape
   * (a filter flip, a pin, or a favorite toggle).
   */
  private resyncAfterFilterChange(): void {
    if (this.hasSelection) {
      this.resolveSelection();
    } else {
      // Clamp scrollOffset/index so the render math stays valid even with no
      // active selection (regardless of whether visibleList is empty now).
      // Same offset clamp as ensureSelectedVisible: a list that fits shows
      // from its top, and still does after it grows past the pane.
      const len = this.visibleList.length;
      this.selectedIndex = len > 0 ? Math.min(this.selectedIndex, len - 1) : 0;
      this.scrollOffset = Math.min(this.scrollOffset, maxScrollOffset(len, this.maxHeight));
    }
  }

  /** Discriminated union selection — the canonical way to query what is selected */
  get selection(): Selection {
    // §17.1: no-selection state — nothing is selected until j/k, shift+j/k, or
    // an @-jump sets hasSelection.
    if (!this.hasSelection) return null;
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      const item = visible[this.selectedIndex]!;
      if (item.kind === "system-coordinator") return { kind: "system-coordinator" };
      if (item.kind === "repo-header") return { kind: "repo-header", repoName: item.repoName, repoPath: item.repoPath };
      // parent-header rows are inert (non-selectable) — nothing is "selected"
      // when the index happens to land on one.
      if (item.kind === "parent-header") return null;
      // A remote row is its own selection kind, never `agent`: nothing
      // that reads a local agent from the selection can be handed a remote one.
      if (item.kind === "remote-repo-header" || item.kind === "remote-agent" || item.kind === "remote-coordinator") {
        return { kind: "remote", entry: item };
      }
      return { kind: "agent", agent: item.agent };
    }
    return null;
  }

  get selectedAgent(): Agent | null {
    const sel = this.selection;
    return sel?.kind === "agent" ? sel.agent : null;
  }

  /** The selected remote row (SPEC §20.5), or null when the selection is local or empty. */
  get selectedRemote(): RemoteEntry | null {
    const sel = this.selection;
    return sel?.kind === "remote" ? sel.entry : null;
  }

  get selectedRepoHeader(): string | null {
    const sel = this.selection;
    return sel?.kind === "repo-header" ? sel.repoName : null;
  }

  get selectedRepoPath(): string | null {
    const sel = this.selection;
    return sel?.kind === "repo-header" ? sel.repoPath : null;
  }

  get isSystemCoordinatorSelected(): boolean {
    return this.selection?.kind === "system-coordinator";
  }

  /**
   * Select the agent row with this fully qualified id: a local agent's
   * agentKey, or a remote agent's peerEntryKey (SPEC §20.5), which the
   * selected-row carve-out keeps visible under every filter. Returns true if
   * found. Force-selects (§17.1/§17.3).
   */
  selectAgentByKey(key: string): boolean {
    const row = this._flatList.find((f) => f.kind === "agent" && this.agentKey(f.agent) === key);
    if (row?.kind === "agent") return this.selectAgentRow(key, row.agent.repoPath);
    const remote = [...this.peerRepos.values()].some((repo) => repo.nodes.some((node) => peerEntryKey(node.row) === key));
    return remote && this.selectAgentRow(key, null);
  }

  /** The remote agent row of this peer's agent (SPEC §20.5), shown or not, or null. */
  remoteAgentRow(peerId: string, repo: string, id: string): Extract<RemoteEntry, { kind: "remote-agent" }> | null {
    for (const peerRepo of this.peerRepos.values()) {
      const node = peerRepo.nodes.find(({ row }) => row.peerId === peerId && row.remote.repoRegistryName === repo && row.remote.id === id);
      if (node) return node.row;
    }
    return null;
  }

  /** Select this local agent's row (its fully qualified id, in its own repo). Returns true if found. */
  selectAgent(agent: Agent): boolean {
    return this.selectAgentRow(this.agentKey(agent), agent.repoPath);
  }

  /** Select the agent row with this key in the repo at `repoPath`, or the remote agent row with it (null). */
  private selectAgentRow(key: string, repoPath: string | null): boolean {
    // An agent's repo by definition has agents, so sticky-reveal clears when
    // landing on one. Update selectedId+hasSelection first, then refresh sticky,
    // then re-find the index against the post-sticky visibleList — same
    // ordering used by updateSelectedId so the cursor never drifts.
    const isRow = (f: FlatEntry) => this.rowKey(f) === key && AgentTreeComponent.rowRepoPath(f) === repoPath;
    if (repoPath !== null && !this._flatList.some(isRow)) return false;
    this.selectedId = key;
    this.selectedRowRepo = repoPath;
    this.hasSelection = true;
    this.updateStickyReveal();
    const idx = this.visibleList.findIndex(isRow);
    if (idx === -1) return false;
    this.selectedIndex = idx;
    this.ensureSelectedVisible();
    return true;
  }

  /** Select repo header by repoPath. Returns true if found. Force-selects (§17.1). */
  selectByRepoPath(repoPath: string): boolean {
    // Repo headers may be filtered out by repoFilter; set selectedId first
    // so updateStickyReveal can decide whether to keep the header visible,
    // then re-find selectedIndex in the post-sticky visibleList.
    const header = this.localRows().find(
      (f) => f.kind === "repo-header" && f.repoPath === repoPath
    );
    if (!header) return false;
    this.selectedId = this.rowKey(header);
    // By path, not key: two headers can share a key (SPEC §17.1 Row keys).
    this.selectedRowRepo = repoPath;
    this.hasSelection = true;
    this.updateStickyReveal();
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.kind === "repo-header" && f.repoPath === repoPath);
    if (idx === -1) return false;
    this.selectedIndex = idx;
    this.ensureSelectedVisible();
    return true;
  }

  /** Select the system coordinator row. Returns true if found. Force-selects (§17.1). */
  selectSystemCoordinator(): boolean {
    // No filter ever hides the coordinator row, so its repo-less selection
    // just clears sticky-reveal before the index is found.
    if (!this._flatList.some((f) => f.kind === "system-coordinator")) return false;
    this.selectedId = SYSTEM_COORDINATOR_ID;
    this.selectedRowRepo = null;
    this.hasSelection = true;
    this.updateStickyReveal();
    const idx = this.visibleList.findIndex((f) => f.kind === "system-coordinator");
    if (idx === -1) return false;
    this.selectedIndex = idx;
    this.ensureSelectedVisible();
    return true;
  }

  /**
   * Return the tree to the no-selection state (§17.1): `selection` becomes null
   * and no row renders in reverse video. selectedIndex/scrollOffset are kept as
   * valid values for the render math; only hasSelection (and selectedId) clear.
   */
  deselect(): void {
    this.hasSelection = false;
    this.selectedId = null;
    this.selectedRowRepo = null;
    this.updateStickyReveal();
  }

  /**
   * Select the first visible row (index 0), entering the selected state.
   * Restores the old `ib watch` startup behavior (row 0 auto-selected on first
   * populate, any kind — agent, repo-header, or system-coordinator). Used by the
   * dashboard's one-time startup auto-select (§17.1, user-confirmed). No-op on an
   * empty list.
   */
  selectFirstRow(): void {
    if (this.visibleList.length === 0) return;
    this.selectedIndex = 0;
    this.hasSelection = true;
    this.updateSelectedId();
    this.ensureSelectedVisible();
  }

  moveSelection(delta: number) {
    const visible = this.visibleList;
    if (visible.length === 0) return;
    const len = visible.length;
    // §17.1: from no-selection, j (delta>0) selects the FIRST visible row and
    // k (delta<0) the LAST, then enters the selected state. Subsequent moves
    // use the existing wrap-around behavior.
    // Skip inert parent-header rows in the direction of travel: k (up) skips
    // upward, j (down) skips downward — so moving up never bounces back down.
    const skipDelta: 1 | -1 = delta < 0 ? -1 : 1;
    if (!this.hasSelection) {
      this.hasSelection = true;
      this.selectedIndex = delta < 0 ? len - 1 : 0;
      this.updateSelectedId(skipDelta);
      this.ensureSelectedVisible();
      return;
    }
    this.selectedIndex = ((this.selectedIndex + delta) % len + len) % len;
    this.updateSelectedId(skipDelta);
    this.ensureSelectedVisible();
  }

  /**
   * Jump to next (delta=1) or previous (delta=-1) repo or agent group.
   *
   * Behavior depends on what is selected:
   *
   * - **Repo header selected**: cycle through repo headers only. The system
   *   coordinator is NOT in this rotation (it has no repo to "jump to next").
   *
   * - **Agent or system-coordinator selected**: cycle through agent groups,
   *   where the coordinator counts as its own group. Repo groups land on the
   *   first/last agent of that repo (empty repos skipped); the coordinator
   *   group lands on the coordinator row itself. `stopped` agents (and a
   *   stopped coordinator) are skipped so jumping always lands on a live agent.
   *   If every candidate is stopped, it falls back to the prior behavior and
   *   still cycles between repos as before.
   */
  moveToRepo(delta: 1 | -1) {
    const visible = this.visibleList;
    if (visible.length === 0) return;

    // §17.1: from no-selection, shift+j lands on the FIRST anchor's landing row
    // and shift+k on the LAST anchor's landing row (the anchor-granularity
    // analogue of j/k's first/last-row rule). We enter the selected state and
    // seed selectedIndex so the existing cycle logic below advances to the
    // intended anchor: for delta=+1 seed at the end (so +1 wraps to the first
    // anchor); for delta=-1 seed at the start (so -1 wraps to the last anchor).
    // We deliberately route through the agent-group anchor path (not the
    // repo-header-cycle path) so the landing matches j/k's row-granularity rule.
    const fromNoSelection = !this.hasSelection;
    if (fromNoSelection) {
      this.hasSelection = true;
      this.selectedIndex = delta === 1 ? visible.length - 1 : 0;
    }

    // J/K treat local and remote-only repo headers as the same navigation anchors.
    const isRepoAnchor = (f: FlatEntry | undefined): boolean => f?.kind === "repo-header" || f?.kind === "remote-repo-header";
    const current = visible[this.selectedIndex];
    const isRepoHeader = !fromNoSelection && isRepoAnchor(current);

    if (isRepoHeader) {
      // Original behavior: cycle through repo headers only.
      const repoIndices = visible.map((f, i) => (isRepoAnchor(f) ? i : -1)).filter((i) => i !== -1);
      if (repoIndices.length === 0) return;
      let currentRepoIdx = repoIndices.indexOf(this.selectedIndex);
      if (currentRepoIdx === -1) currentRepoIdx = 0;
      const targetRepoIdx = ((currentRepoIdx + delta) % repoIndices.length + repoIndices.length) % repoIndices.length;
      this.selectedIndex = repoIndices[targetRepoIdx]!;
      this.updateSelectedId();
      this.ensureSelectedVisible();
      return;
    }

    // Agent or coordinator selected: build agent-group anchor list.
    // Anchors are the system-coordinator (if present) plus each repo-header,
    // ordered by their position in the visible list.
    const anchors: { kind: "system-coordinator" | "repo-header" | "remote-repo-header"; index: number }[] = [];
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      if (item.kind === "system-coordinator" || item.kind === "repo-header" || item.kind === "remote-repo-header") {
        anchors.push({ kind: item.kind, index: i });
      }
    }
    if (anchors.length === 0) return;

    // Helper: get agent indices for the repo anchor at anchors[ai] (its local
    // and remote agents). When skipStopped is set,
    // stopped agents are excluded so jumping always lands on a live
    // (non-stopped) agent.
    const agentsForAnchor = (ai: number, skipStopped: boolean): number[] => {
      const anchor = anchors[ai]!;
      if (anchor.kind === "system-coordinator") return [];
      const nextAnchor = anchors[ai + 1];
      const endPos = nextAnchor ? nextAnchor.index : visible.length;
      const result: number[] = [];
      for (let i = anchor.index + 1; i < endPos; i++) {
        const item = visible[i];
        const state = item?.kind === "agent" ? item.agent.state : item?.kind === "remote-agent" ? item.remote.state : null;
        if (state === null) continue;
        if (skipStopped && state === "stopped") continue;
        result.push(i);
      }
      return result;
    };

    // Find which anchor we are currently at/under. Default 0 is a safe fallback
    // (selectedIndex < anchors[0].index is unreachable since coordinator-when-present
    // and first-repo-header are always at index 0).
    let currentAnchorIdx = 0;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i]!.index <= this.selectedIndex) {
        currentAnchorIdx = i;
        break;
      }
    }

    // Cycle through anchors and return the visible index to land on, or null if
    // no anchor yields a valid landing spot. Coordinator anchors are valid
    // unless skipStopped excludes a stopped coordinator; repo anchors require at
    // least one (non-stopped, when skipStopped) agent — empty repos are skipped.
    const findTarget = (skipStopped: boolean): number | null => {
      let targetAnchorIdx = currentAnchorIdx;
      for (let step = 0; step < anchors.length; step++) {
        targetAnchorIdx = ((targetAnchorIdx + delta) % anchors.length + anchors.length) % anchors.length;
        const target = anchors[targetAnchorIdx]!;
        if (target.kind === "system-coordinator") {
          const coordItem = visible[target.index];
          if (skipStopped && coordItem?.kind === "system-coordinator" && coordItem.state === "stopped") {
            continue;
          }
          return target.index;
        }
        const agents = agentsForAnchor(targetAnchorIdx, skipStopped);
        if (agents.length > 0) {
          return delta === 1 ? agents[0]! : agents[agents.length - 1]!;
        }
      }
      return null;
    };

    // Prefer landing on a non-stopped agent. If every candidate is stopped (or
    // there are none), fall back to the original behavior, which still jumps
    // between repos as before.
    const target = findTarget(true) ?? findTarget(false);
    if (target !== null) {
      this.selectedIndex = target;
    }

    this.updateSelectedId();
    this.ensureSelectedVisible();
  }

  /**
   * Update selectedId from current selectedIndex, refresh sticky-reveal, then
   * re-resolve selectedIndex against the new visibleList. The final re-resolve
   * is what closes HIGH 1: a sticky update can shrink the visible list, and
   * without re-finding selectedIndex it would point past (or to the wrong row
   * in) the post-update list.
   *
   * `skipDelta` is the DIRECTION to skip inert parent-header rows when the
   * index lands on one (index-based navigation can land there). Callers that
   * move UP (k, moveSelection(-1)) pass -1 so the cursor continues upward past
   * the header instead of bouncing back down; everyone else defaults to +1
   * (the natural "skip to the row below the header" behavior). The skip wraps
   * around the list so pressing k on the first selectable row (with a
   * parent-header above it) lands on the LAST row rather than dead-ending.
   */
  private updateSelectedId(skipDelta: 1 | -1 = 1) {
    const visible = this.visibleList;
    if (this.selectedIndex < 0 || this.selectedIndex >= visible.length) return;
    // parent-header rows are inert; if the index landed on one, skip in the
    // direction of travel to the next selectable row (wrapping around the
    // list). -1 only when NOTHING is selectable — leave selectedId untouched.
    if (visible[this.selectedIndex]!.kind === "parent-header") {
      const target = this.nextSelectableIndexWrap(this.selectedIndex, skipDelta);
      if (target === -1) return;
      this.selectedIndex = target;
    }
    // A parent-header has no key: unreachable after the skip above, but keep
    // selectedId sane rather than inventing one.
    const row = visible[this.selectedIndex]!;
    const key = this.rowKey(row);
    if (key === null) return;
    this.selectedId = key;
    this.selectedRowRepo = AgentTreeComponent.rowRepoPath(row);
    this.updateStickyReveal();
    // Re-resolve selectedIndex inline (NOT via resolveSelection, which would
    // call back into updateSelectedId on a miss). The sticky update above may
    // have changed visibleList's shape; selectedIndex must follow.
    const idx = this.indexOfKey(this.visibleList, key, this.selectedIndex);
    if (idx !== -1) this.selectedIndex = idx;
  }

  /**
   * The index in `rows` of the selected row (matchesSelection: `key`, and for a
   * local row the remembered repo): `preferred` when the row there is it, else
   * the first row that is, else -1. Rows share a key only for duplicates
   * registered before names were unique (two repos with one name, two peers
   * with one name; SPEC §17.1 Row keys); for local rows the repo tells them
   * apart, and preferring the current index keeps a remote row in place.
   */
  private indexOfKey(rows: FlatEntry[], key: string, preferred: number): number {
    const at = rows[preferred];
    if (at !== undefined && this.matchesSelection(at, key)) return preferred;
    return rows.findIndex((f) => this.matchesSelection(f, key));
  }

  /**
   * First index at/after `from` (stepping by `delta`) whose row is selectable
   * (anything except a `parent-header`). Returns -1 if none in that direction.
   * Used to skip inert parent-header rows during index-based navigation.
   */
  private nextSelectableIndex(from: number, delta: 1 | -1): number {
    const visible = this.visibleList;
    for (let i = from + delta; i >= 0 && i < visible.length; i += delta) {
      if (visible[i]!.kind !== "parent-header") return i;
    }
    return -1;
  }

  /**
   * Like nextSelectableIndex but WRAPS around the list: from `from`, step by
   * `delta` (mod length) up to `length` times looking for a selectable
   * (non-parent-header) row. Returns -1 only if EVERY row is a parent-header.
   * Used by the parent-header skip so up-navigation past a header at the top of
   * the list continues to the last row instead of dead-ending.
   */
  private nextSelectableIndexWrap(from: number, delta: 1 | -1): number {
    const visible = this.visibleList;
    const len = visible.length;
    if (len === 0) return -1;
    for (let step = 1; step <= len; step++) {
      const i = ((from + delta * step) % len + len) % len;
      if (visible[i]!.kind !== "parent-header") return i;
    }
    return -1;
  }

  /** Re-resolve selectedIndex from selectedId after flatList changes */
  private resolveSelection() {
    // flatList may have changed shape (e.g. a previously-empty repo gained an
    // agent), so refresh sticky-reveal from the current selectedId before
    // computing visibleList.
    this.updateStickyReveal();
    const visible = this.visibleList;
    if (visible.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedId === null) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.updateSelectedId();
      this.ensureSelectedVisible();
      return;
    }
    const selectedId = this.selectedId;
    const idx = this.indexOfKey(visible, selectedId, this.selectedIndex);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.selectedRowRepo = AgentTreeComponent.rowRepoPath(visible[idx]!);
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, visible.length - 1);
      if (this.selectedRowRepo !== null || this.isLocalKey(selectedId)) {
        const local = (row: FlatEntry) => row.kind === "agent" || row.kind === "repo-header" || row.kind === "system-coordinator";
        const previous = visible.slice(0, this.selectedIndex + 1).findLastIndex(local);
        const nearest = previous >= 0 ? previous : visible.findIndex(local);
        if (nearest >= 0) this.selectedIndex = nearest;
      }
      this.updateSelectedId();
    }
    this.ensureSelectedVisible();
  }

  /** Keep selected index within the visible scroll window with 1-row scroll buffer */
  private ensureSelectedVisible() {
    const rowCount = this.visibleList.length;
    const lastIndex = rowCount - 1;

    // Scroll up: keep at least 1 row above selected (unless selected is at very top of list)
    if (this.selectedIndex > 0 && this.selectedIndex - 1 < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex - 1;
    } else if (this.selectedIndex === 0) {
      this.scrollOffset = 0;
    }

    // Scroll down: keep selected visible.
    const effectiveScrollOffset = this.scrollOffset === 1 ? 0 : this.scrollOffset;
    const topSlot = effectiveScrollOffset > 0 ? 1 : 0;
    if (this.selectedIndex < lastIndex && this.selectedIndex + 1 >= effectiveScrollOffset + this.maxHeight - topSlot) {
      this.scrollOffset = Math.max(2, this.selectedIndex - this.maxHeight + 3);
    } else if (this.selectedIndex === lastIndex && this.selectedIndex >= effectiveScrollOffset + this.maxHeight - topSlot) {
      this.scrollOffset = Math.max(2, this.selectedIndex - this.maxHeight + 3);
    }

    // Never scroll past the end. scrollOffset is one value for every view of
    // this tree (the Agents and Favorites tabs, the V filter), so the scroll-up
    // rule above can leave an offset from a longer list: a Favorites list that
    // fits the pane must still show from its top.
    this.scrollOffset = Math.min(this.scrollOffset, maxScrollOffset(rowCount, this.maxHeight));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const visible = this.visibleList;
    if (visible.length === 0) {
      const hint = this.favoritesOnly ? this.favoritesEmptyHint() : "No agents found";
      return [truncateToWidth(`${DIM}  ${hint}${RESET}`, width, "")];
    }

    const lines: string[] = [];
    // Clamp here too, without storing it: with no selection, nothing
    // re-clamps the stored offset when the list shrinks or the pane grows.
    let start = Math.min(this.scrollOffset, maxScrollOffset(visible.length, this.maxHeight));

    // §17.1: no row renders in reverse video unless the panel actually has a
    // selection. suppressSelection (focus-driven dimming) still applies on top.
    const selectionActive = this.hasSelection && !this.suppressSelection;

    // If only 1 hidden above, absorb it: show that row instead of a "▲ 1 more" indicator.
    if (start === 1) start = 0;

    // Top indicator takes 1 slot when 2+ items are hidden above (start >= 2).
    const topSlot = start > 0 ? 1 : 0;
    // Budget: maxHeight minus top slot, with 1 slot reserved for a potential bottom indicator.
    const maxContent = this.maxHeight - topSlot;

    // Compute end with the reserved bottom-indicator slot.
    let end = Math.min(visible.length, start + Math.max(0, maxContent - 1));
    let remaining = visible.length - end;

    if (remaining === 0) {
      // No items below: reclaim the reserved slot and show all remaining items.
      end = Math.min(visible.length, start + maxContent);
      remaining = visible.length - end;
    } else if (remaining === 1) {
      // Exactly 1 item below: absorb it into the reserved slot (no "▼ 1 more" indicator).
      end = visible.length;
      remaining = 0;
    }
    // remaining >= 2: show "▼ N more" indicator using the reserved slot.

    // Grouping is "active" when the flat list carries at least one
    // parent-header (i.e. tree.groupByParent is ON and >1 repo shares a
    // parent). When active, the WHOLE repo subtree (repo-header + its agent
    // rows) is indented 2 spaces so it visibly nests under the parent-directory
    // header, and the parent-header itself sits at column 0 (the top level).
    const groupingActive = visible.some((item) => item.kind === "parent-header");
    const repoIndent = groupingActive ? "  " : "";

    // Remote agents under a local repo header are indented with it; the
    // remote-only repos after the local ones are not.
    const remoteOnlyStart = visible.findIndex((row) => row.kind === "remote-repo-header");
    const remoteIndent = (i: number) => remoteOnlyStart < 0 || i < remoteOnlyStart ? repoIndent : "";

    // Compute max name prefix width and state column width across all visible
    // agent rows, local and remote, so every row's state and age line up.
    // Under grouping, the agent connector is prefixed with repoIndent so the
    // width math and the rendered text agree (otherwise the state/age columns
    // misalign).
    let maxNameWidth = 0;
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      if (item.kind === "agent") {
        const isFavorite = this.isFavorite(item.agent);
        maxNameWidth = Math.max(maxNameWidth, agentNamePrefixWidth(item.agent, repoIndent + item.connector, isFavorite));
      } else if (item.kind === "system-coordinator") {
        maxNameWidth = Math.max(maxNameWidth, visibleWidth("◆ coordinator"));
      } else if (item.kind === "remote-coordinator") {
        maxNameWidth = Math.max(maxNameWidth, visibleWidth(PEER_BRANCH_LAST + item.peerName));
      } else if (item.kind === "remote-agent") {
        const star = favoriteStar(this.favoriteAgentIds.has(peerEntryKey(item)));
        maxNameWidth = Math.max(maxNameWidth, visibleWidth(remoteIndent(i) + item.connector + star + remoteDisplayName(item.remote)));
      }
    }
    const stateColWidth = computeStateColWidth(visible);
    // Remote rows keep their state (and a peer row its age) on screen at a
    // narrow width by cutting the name instead.
    const remoteNameColWidth = Math.min(maxNameWidth, Math.max(1, width - 2 - stateColWidth));
    const peerNameColWidth = Math.min(maxNameWidth, Math.max(visibleWidth(PEER_BRANCH_LAST) + 1, width - 4 - stateColWidth - AGE_COL_WIDTH));

    // Scroll indicator at top (indented with the subtree when grouping so it
    // doesn't float left of the rows it summarizes).
    if (start > 0) {
      lines.push(truncateToWidth(`${DIM}${repoIndent}  ▲ ${start} more${RESET}`, width, ""));
    }

    for (let i = start; i < end; i++) {
      const item = visible[i]!;
      if (item.kind === "remote-repo-header") {
        lines.push(formatRemoteRepoRow(item, selectionActive && i === this.selectedIndex, width,
          this.pinnedRemoteRepoNames.has(item.repoRegistryName.toLowerCase())));
      } else if (item.kind === "remote-coordinator") {
        const branch = visible[i + 1]?.kind === "remote-coordinator" ? "├── " : PEER_BRANCH_LAST;
        lines.push(formatPeerCoordinatorRow(
          item, branch, selectionActive && i === this.selectedIndex, width, peerNameColWidth, stateColWidth,
        ));
      } else if (item.kind === "remote-agent") {
        const key = peerEntryKey(item);
        lines.push(formatRemoteAgentRow(
          { ...item, connector: remoteIndent(i) + item.connector }, selectionActive && i === this.selectedIndex, width,
          remoteNameColWidth, stateColWidth, this.favoriteAgentIds.has(key), this.questionAgentKeys.has(key),
        ));
      } else if (item.kind === "system-coordinator") {
        lines.push(formatCoordinatorRow(
          item.state, item.age,
          selectionActive && i === this.selectedIndex,
          width, maxNameWidth, stateColWidth,
        ));
      } else if (item.kind === "parent-header") {
        // Parent-directory group header: the top level of the tree, sitting at
        // column 0 with the repo subtrees indented beneath it. Rendered BOLD +
        // UNDERLINE (a section-heading style) so it reads as MORE prominent than
        // — and a different LEVEL from — the plain-bold repo-header triangles
        // nested under it. Inert: never rendered selected.
        lines.push(truncateToWidth(`${BOLD}${UNDERLINE}${item.displayName}${RESET}`, width, ""));
      } else if (item.kind === "repo-header") {
        const selected = selectionActive && i === this.selectedIndex;
        const triangle = this.pinnedRepoPaths.has(item.repoPath) ? "⚲" : item.hasAgents ? "▾" : "▸";
        // Append health indicator based on highest severity
        let healthIndicator = "";
        const report = this.healthReports.get(item.repoPath);
        if (report && report.warnings.length > 0) {
          const hasError = report.warnings.some((w) => w.severity === "error");
          healthIndicator = hasError ? " 🔴" : " ⚠️";
        }
        const truncated = truncateToWidth(`${repoIndent}${BOLD}${triangle} ${item.repoName}${healthIndicator}${RESET}`, width, "");
        if (selected) {
          const pad = Math.max(0, width - visibleWidth(truncated));
          const highlighted = truncated.replaceAll(RESET, RESET + REVERSE);
          lines.push(`${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`);
        } else {
          lines.push(truncated);
        }
      } else {
        const hasQ = this.questionAgentKeys.has(this.agentKey(item.agent));
        // Indent the whole agent row with its repo subtree when grouping is
        // active (prefix the box-drawing connector), so agents render UNDER
        // their repo-header instead of left of it.
        const isFavorite = this.isFavorite(item.agent);
        lines.push(formatAgentRow(item.agent, repoIndent + item.connector, selectionActive && i === this.selectedIndex, width, maxNameWidth, stateColWidth, hasQ, isFavorite));
      }
    }

    // Scroll indicator at bottom (indented with the subtree when grouping).
    if (remaining > 0) {
      lines.push(truncateToWidth(`${DIM}${repoIndent}  ▼ ${remaining} more${RESET}`, width, ""));
    }

    if (this.hasFavoritesHintRow(visible) && lines.length < this.maxHeight) {
      lines.push(truncateToWidth(`${DIM}  ${this.favoritesEmptyHint()}${RESET}`, width, ""));
    }

    return lines;
  }

  /**
   * The Favorites view always shows the system coordinator, so it is rarely
   * empty: when rows show but none is an agent, render() puts the hint in an
   * extra row under them.
   */
  private hasFavoritesHintRow(visible: FlatEntry[]): boolean {
    return this.favoritesOnly && visible.length > 0 && !visible.some((f) => f.kind === "agent" || f.kind === "remote-agent");
  }

  /**
   * The rows render() wants: the visible entries plus the favorites hint row.
   * The sidebar and the dashboard's `{`/`}` resize size the tree from this,
   * so the hint row gets room.
   */
  get renderRowCount(): number {
    const visible = this.visibleList;
    return visible.length + (this.hasFavoritesHintRow(visible) ? 1 : 0);
  }

  /**
   * The hint for a Favorites view with no agent row. Same rule as the
   * favorites pass (hasFavoriteInChain over the non-archived agents): if any
   * agent passes it, only the V filter can have hidden it; otherwise the
   * favorites pass has nothing to show (no favorites, or only ids of gone
   * agents with no orphans left here).
   */
  private favoritesEmptyHint(): string {
    const byKey = this.buildAgentLookup();
    const hasFavoriteRow = this._flatList.some(
      (f) => f.kind === "agent" && !f.agent.archived && this.hasFavoriteInChain(f.agent, byKey),
    );
    const hasPeerFavorite = [...this.peerRepos.values()].some(repo => favoriteRemoteAgents(repo, this.favoriteAgentIds).size > 0);
    return hasFavoriteRow || hasPeerFavorite ? "No favorites match the V filter" : "No favorites — press . on an agent";
  }
}
