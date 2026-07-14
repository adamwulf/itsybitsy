/**
 * Agent tree component — displays agents in a scrollable tree with status indicators.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { resolveAgentIcon, isVisibleUnderRunningFilter, subtreeHasNonStopped, type Agent, type FlatEntry } from "../agents";
import type { RepoHealthReport } from "../health-check";
import type { Selection } from "./selection";
import { getStateColors } from "./color-scheme";
import { RESET, BOLD, DIM, REVERSE, RED } from "./colors";

export const MAX_TREE_HEIGHT = 7;
const MIN_STATE_COL_WIDTH = 8; // minimum: length of "complete"
export const AGE_COL_WIDTH = 3; // max age length: e.g. "27m"

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

/** Compute state column width from the agents being displayed */
export function computeStateColWidth(agents: FlatEntry[]): number {
  let maxLen = MIN_STATE_COL_WIDTH;
  for (const f of agents) {
    if (f.kind === "agent") {
      maxLen = Math.max(maxLen, displayState(f.agent.state).length);
    } else if (f.kind === "system-coordinator") {
      maxLen = Math.max(maxLen, displayState(f.state).length);
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

/** Compute the visible width of the name prefix (connector + icon + repo/id) for an agent row */
function agentNamePrefixWidth(agent: Agent, connector: string): number {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agentIcon(agent);
  return visibleWidth(`${connector}${orphanedPrefix}${icon} ${agentDisplayName(agent)}`);
}

/** Width threshold at or below which compact mode is used */
export const COMPACT_WIDTH_THRESHOLD = 60;

/** Format agent row for the tree.
 *  Compact mode (width <= COMPACT_WIDTH_THRESHOLD): icon agent-id  state  age
 *  Full mode: icon agent-id  state  age  model  prompt/summary
 */
export function formatAgentRow(
  agent: Agent,
  connector: string,
  selected: boolean,
  width: number,
  nameColWidth: number,
  stateColWidth: number = MIN_STATE_COL_WIDTH,
  hasQuestion: boolean = false
): string {
  const compact = width <= COMPACT_WIDTH_THRESHOLD;
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agentIcon(agent);
  const state = displayState(agent.state);
  const stateColor = getStateColors()[state] ?? getStateColors().unknown;

  const nameColor = hasQuestion ? RED : "";
  const nameEnd = hasQuestion ? RESET : "";
  const namePrefix = `${connector}${orphanedPrefix}${icon} ${nameColor}${agentDisplayName(agent)}${nameEnd}`;
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
 * Rebuild box-drawing connectors (├──, └──, │) for the visible agents in
 * `entries`. Used when a filter hides intermediate agents — the connectors
 * computed at flatten time reference now-hidden ancestors, so each visible
 * agent's effective parent is the nearest visible ancestor in its
 * meta.manager chain, and "is last sibling" is recomputed against the
 * visible siblings only. Repo headers and the system coordinator pass
 * through untouched; order of entries is preserved. `allAgents` provides
 * the full agent lookup so the chain can walk past hidden ancestors.
 */
function recomputeConnectorsForVisible(entries: FlatEntry[], allAgents: Map<string, Agent>): FlatEntry[] {
  const hasRepoHeaders = entries.some((e) => e.kind === "repo-header");
  // Visible agent ids — to decide which managers in the chain are kept.
  const visibleIds = new Set<string>();
  for (const e of entries) {
    if (e.kind === "agent") visibleIds.add(e.agent.id);
  }

  // For each visible agent, compute its effective parent id (nearest visible
  // ancestor in its meta.manager chain) and its visible-ancestor chain (root
  // → A's parent), preserving the original meta.manager order. The chain is
  // constrained to the same repoName as the agent (ib supports cross-repo
  // spawn, but the agent tree groups agents by repo — a cross-repo manager
  // would point at a parent that isn't in the same group's sibling pool, so
  // we treat the agent as an effective root of its own repo). A visited set
  // guards against meta.manager cycles (self-reference, A→B→A); without it
  // the loop would hang the TUI on every render.
  const effectiveParentId = new Map<string, string | null>();
  const ancestorChain = new Map<string, string[]>();
  for (const e of entries) {
    if (e.kind !== "agent") continue;
    const chain: string[] = [];
    const visited = new Set<string>([e.agent.id]);
    let mgr = e.agent.meta.manager;
    while (mgr) {
      if (visited.has(mgr)) break;
      visited.add(mgr);
      const parentAgent = allAgents.get(mgr);
      // Only include managers that are visible AND in the same repo.
      if (parentAgent && parentAgent.repoName === e.agent.repoName && visibleIds.has(mgr)) {
        chain.push(mgr);
      }
      if (!parentAgent) break;
      mgr = parentAgent.meta.manager;
    }
    chain.reverse();
    ancestorChain.set(e.agent.id, chain);
    effectiveParentId.set(e.agent.id, chain.length > 0 ? chain[chain.length - 1]! : null);
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
      const parent = effectiveParentId.get(e.agent.id) ?? null;
      lastByParent.set(parent, e.agent.id);
    }
    for (let j = groupStart; j < i; j++) {
      const e = entries[j]!;
      if (e.kind !== "agent") continue;
      const parent = effectiveParentId.get(e.agent.id) ?? null;
      isLastSibling.set(e.agent.id, lastByParent.get(parent) === e.agent.id);
    }
    groupStart = i + 1;
  }

  // Count visible roots once — used by the single-repo no-header carve-out
  // below (a sole visible root gets an empty connector, matching
  // flattenAgentTree's `multiRoot ? [isLast] : []`). Hoisted out of the
  // per-agent loop to keep this O(N) instead of O(N²).
  let visibleRootCount = 0;
  for (const p of effectiveParentId.values()) if (p === null) visibleRootCount++;

  // Build connector strings from the ancestor chain + per-node last-sibling
  // bits. Matches flattenAgentTree's connector format exactly.
  const result: FlatEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "agent") {
      result.push(e);
      continue;
    }
    const chain = ancestorChain.get(e.agent.id) ?? [];
    const ancestorIsLast: boolean[] = [];
    for (const ancestorId of chain) ancestorIsLast.push(isLastSibling.get(ancestorId) ?? true);
    ancestorIsLast.push(isLastSibling.get(e.agent.id) ?? true);
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
  private selectedIndex = 0;
  maxHeight = MAX_TREE_HEIGHT;
  private scrollOffset = 0;
  private selectedId: string | null = null;
  /**
   * Whether the Agents panel currently has a selected row (§17.1). The panel
   * STARTS in no-selection and only enters the selected state via j/k
   * (moveSelection), shift+j/k (moveToRepo), selectAgentById (the @-jump), or
   * selectByRepoPath. selectedIndex is kept as a non-negative value for the
   * scroll math even when nothing is selected; hasSelection is the single
   * source of truth for "is anything selected". When false, `selection`
   * returns null and no row renders in reverse video.
   */
  private hasSelection = false;
  questionAgentIds: Set<string> = new Set();
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
   *                     api_terms, merging, restarting, op_stuck, unknown) is
   *                     shown. See `isVisibleUnderRunningFilter`.
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

  get flatList(): FlatEntry[] {
    return this._flatList;
  }

  setFlatList(list: FlatEntry[]) {
    const wasEmpty = this._flatList.length === 0;
    this._flatList = list;
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

  get visibleList(): FlatEntry[] {
    const base = this.flatList.filter((f) =>
      f.kind === "repo-header" || f.kind === "system-coordinator" || !f.agent.archived
    );
    if (this.repoFilter === "all") return base;
    const sticky = this._stickyRevealedRepoPath;
    const selectedAgentId = this.hasSelection && this.selectedId !== null && !this.selectedId.startsWith("repopath:") && this.selectedId !== SYSTEM_COORDINATOR_ID
      ? this.selectedId
      : null;
    const filtered = base.filter((f) => {
      if (f.kind === "system-coordinator") return true;
      if (f.kind === "repo-header") {
        // non-empty gates on any agents at all; running-only gates on any
        // NON-STOPPED agent (a repo whose agents are all stopped is hidden).
        const passes = this.repoFilter === "non-empty" ? f.hasAgents : f.hasNonStoppedAgents;
        if (passes) return true;
        if (this.pinnedRepoPaths.has(f.repoPath)) return true;
        return sticky !== null && f.repoPath === sticky;
      }
      // f.kind === "agent": only hide individual agents in running-only mode.
      if (this.repoFilter !== "running-only") return true;
      // running-only hides ONLY stopped agents; every other state is shown.
      if (isVisibleUnderRunningFilter(f.agent.state)) return true;
      // Keep an agent visible if any descendant in its subtree is non-stopped,
      // so managers retain their hierarchical context instead of having their
      // surviving children orphaned under a hidden (stopped) parent.
      if (subtreeHasNonStopped(f.agent)) return true;
      // Keep the currently-selected agent visible even if it is stopped, so a
      // filter flip doesn't yank the selection out from under the user.
      return selectedAgentId !== null && f.agent.id === selectedAgentId;
    });
    if (this.repoFilter !== "running-only") return filtered;
    // In running-only mode, intermediate agents in the original tree may now be
    // hidden. The precomputed connectors reference those hidden ancestors, so
    // rebuild them against only the visible subset.
    const allAgents = new Map<string, Agent>();
    for (const e of this._flatList) {
      if (e.kind === "agent") allAgents.set(e.agent.id, e.agent);
    }
    return recomputeConnectorsForVisible(filtered, allAgents);
  }

  /**
   * Recompute _stickyRevealedRepoPath from the current selectedId. Called after
   * every selection mutation so the filter has a stable input across the rest
   * of the operation. No-op when repoFilter === "all" (filter ignores sticky
   * anyway), but we still null it out so a later toggle starts clean.
   */
  private updateStickyReveal(): void {
    if (this.repoFilter === "all" || !this.hasSelection || this.selectedId === null) {
      this._stickyRevealedRepoPath = null;
      return;
    }
    let repoPath: string | null = null;
    if (this.selectedId.startsWith("repopath:")) {
      repoPath = this.selectedId.slice("repopath:".length);
    } else if (this.selectedId !== SYSTEM_COORDINATOR_ID) {
      const found = this._flatList.find(
        (f) => f.kind === "agent" && f.agent.id === this.selectedId
      );
      if (found && found.kind === "agent") repoPath = found.agent.repoPath;
    }
    if (repoPath === null) {
      this._stickyRevealedRepoPath = null;
      return;
    }
    // Only stick if the matching repo-header would otherwise be filtered
    // out by the active filter — otherwise it's already visible on its own
    // merits and sticky would just hide stale state on the next toggle.
    const header = this._flatList.find(
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
    if (this.hasSelection) {
      this.resolveSelection();
    } else {
      // Clamp scrollOffset/index so the render math stays valid even with no
      // active selection (regardless of whether visibleList is empty now).
      const len = this.visibleList.length;
      this.selectedIndex = len > 0 ? Math.min(this.selectedIndex, len - 1) : 0;
      this.scrollOffset = len > 0 ? Math.min(this.scrollOffset, len - 1) : 0;
    }
  }

  /** Toggle whether the repo at repoPath is pinned (always-visible under V). */
  togglePinnedRepo(repoPath: string): boolean {
    const nowPinned = !this.pinnedRepoPaths.has(repoPath);
    if (nowPinned) this.pinnedRepoPaths.add(repoPath);
    else this.pinnedRepoPaths.delete(repoPath);
    // Selection indices are computed against visibleList, which just changed
    // for this repo; re-resolve so selectedIndex stays consistent.
    if (this.hasSelection) {
      this.resolveSelection();
    } else {
      // Clamp scrollOffset/index so the render math stays valid even with no
      // active selection (regardless of whether visibleList is empty now).
      const len = this.visibleList.length;
      this.selectedIndex = len > 0 ? Math.min(this.selectedIndex, len - 1) : 0;
      this.scrollOffset = len > 0 ? Math.min(this.scrollOffset, len - 1) : 0;
    }
    return nowPinned;
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
      return { kind: "agent", agent: item.agent };
    }
    return null;
  }

  get selectedAgent(): Agent | null {
    const sel = this.selection;
    return sel?.kind === "agent" ? sel.agent : null;
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

  /** Select agent by ID. Returns true if found. Force-selects (§17.1/§17.3). */
  selectAgentById(agentId: string): boolean {
    // An agent's repo by definition has agents, so sticky-reveal clears when
    // landing on one. Update selectedId+hasSelection first, then refresh sticky,
    // then re-find the index against the post-sticky visibleList — same
    // ordering used by updateSelectedId so the cursor never drifts.
    const found = this._flatList.find((f) => f.kind === "agent" && f.agent.id === agentId);
    if (!found || found.kind !== "agent") return false;
    this.selectedId = agentId;
    this.hasSelection = true;
    this.updateStickyReveal();
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.kind === "agent" && f.agent.id === agentId);
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
    const headerExists = this._flatList.some(
      (f) => f.kind === "repo-header" && f.repoPath === repoPath
    );
    if (!headerExists) return false;
    this.selectedId = `repopath:${repoPath}`;
    this.hasSelection = true;
    this.updateStickyReveal();
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.kind === "repo-header" && f.repoPath === repoPath);
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
    if (!this.hasSelection) {
      this.hasSelection = true;
      this.selectedIndex = delta < 0 ? len - 1 : 0;
      this.updateSelectedId();
      this.ensureSelectedVisible();
      return;
    }
    this.selectedIndex = ((this.selectedIndex + delta) % len + len) % len;
    this.updateSelectedId();
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

    const current = visible[this.selectedIndex];
    const isRepoHeader = !fromNoSelection && current?.kind === "repo-header";

    if (isRepoHeader) {
      // Original behavior: cycle through repo headers only.
      const repoIndices = visible.map((f, i) => (f.kind === "repo-header" ? i : -1)).filter((i) => i !== -1);
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
    const anchors: { kind: "system-coordinator" | "repo-header"; index: number }[] = [];
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      if (item.kind === "system-coordinator" || item.kind === "repo-header") {
        anchors.push({ kind: item.kind, index: i });
      }
    }
    if (anchors.length === 0) return;

    // Helper: get agent indices for the repo anchor at anchors[ai]. When
    // skipStopped is set, stopped agents are excluded so jumping always lands
    // on a live (non-stopped) agent.
    const agentsForAnchor = (ai: number, skipStopped: boolean): number[] => {
      const anchor = anchors[ai]!;
      if (anchor.kind !== "repo-header") return [];
      const nextAnchor = anchors[ai + 1];
      const endPos = nextAnchor ? nextAnchor.index : visible.length;
      const result: number[] = [];
      for (let i = anchor.index + 1; i < endPos; i++) {
        const item = visible[i];
        if (item?.kind !== "agent") continue;
        if (skipStopped && item.agent.state === "stopped") continue;
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
   */
  private updateSelectedId() {
    const visible = this.visibleList;
    if (this.selectedIndex < 0 || this.selectedIndex >= visible.length) return;
    const item = visible[this.selectedIndex]!;
    if (item.kind === "system-coordinator") {
      this.selectedId = SYSTEM_COORDINATOR_ID;
    } else if (item.kind === "repo-header") {
      this.selectedId = `repopath:${item.repoPath}`;
    } else {
      this.selectedId = item.agent.id;
    }
    this.updateStickyReveal();
    // Re-resolve selectedIndex inline (NOT via resolveSelection, which would
    // call back into updateSelectedId on a miss). The sticky update above may
    // have changed visibleList's shape; selectedIndex must follow.
    const updatedVisible = this.visibleList;
    const idx = updatedVisible.findIndex((f) => {
      if (f.kind === "system-coordinator") return this.selectedId === SYSTEM_COORDINATOR_ID;
      if (f.kind === "repo-header") return `repopath:${f.repoPath}` === this.selectedId;
      return f.agent.id === this.selectedId;
    });
    if (idx !== -1) this.selectedIndex = idx;
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
    const idx = visible.findIndex((f) => {
      if (f.kind === "system-coordinator") return this.selectedId === SYSTEM_COORDINATOR_ID;
      if (f.kind === "repo-header") return `repopath:${f.repoPath}` === this.selectedId;
      return f.agent.id === this.selectedId;
    });
    if (idx !== -1) {
      this.selectedIndex = idx;
    } else {
      // Selected item gone — clamp to valid range
      this.selectedIndex = Math.min(this.selectedIndex, visible.length - 1);
      this.updateSelectedId();
    }
    this.ensureSelectedVisible();
  }

  /** Keep selected index within the visible scroll window with 1-row scroll buffer */
  private ensureSelectedVisible() {
    const lastIndex = this.visibleList.length - 1;

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
  }

  invalidate(): void {}

  render(width: number): string[] {
    const visible = this.visibleList;
    if (visible.length === 0) {
      return [truncateToWidth(`${DIM}  No agents found${RESET}`, width, "")];
    }

    const lines: string[] = [];
    let start = this.scrollOffset;

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

    // Compute max name prefix width and state column width across all visible agent rows
    let maxNameWidth = 0;
    for (const item of visible) {
      if (item.kind === "agent") {
        maxNameWidth = Math.max(maxNameWidth, agentNamePrefixWidth(item.agent, item.connector));
      } else if (item.kind === "system-coordinator") {
        maxNameWidth = Math.max(maxNameWidth, visibleWidth("◆ coordinator"));
      }
    }
    const stateColWidth = computeStateColWidth(visible);

    // Scroll indicator at top
    if (start > 0) {
      lines.push(truncateToWidth(`${DIM}  ▲ ${start} more${RESET}`, width, ""));
    }

    for (let i = start; i < end; i++) {
      const item = visible[i]!;
      if (item.kind === "system-coordinator") {
        lines.push(formatCoordinatorRow(
          item.state, item.age,
          selectionActive && i === this.selectedIndex,
          width, maxNameWidth, stateColWidth,
        ));
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
        const truncated = truncateToWidth(`${BOLD}${triangle} ${item.repoName}${healthIndicator}${RESET}`, width, "");
        if (selected) {
          const pad = Math.max(0, width - visibleWidth(truncated));
          const highlighted = truncated.replaceAll(RESET, RESET + REVERSE);
          lines.push(`${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`);
        } else {
          lines.push(truncated);
        }
      } else {
        const hasQ = this.questionAgentIds.has(item.agent.id);
        lines.push(formatAgentRow(item.agent, item.connector, selectionActive && i === this.selectedIndex, width, maxNameWidth, stateColWidth, hasQ));
      }
    }

    // Scroll indicator at bottom
    if (remaining > 0) {
      lines.push(truncateToWidth(`${DIM}  ▼ ${remaining} more${RESET}`, width, ""));
    }

    return lines;
  }
}
