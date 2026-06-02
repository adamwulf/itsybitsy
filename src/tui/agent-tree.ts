/**
 * Agent tree component — displays agents in a scrollable tree with status indicators.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { resolveAgentIcon } from "../agents";
import type { Agent, FlatEntry } from "../agents";
import type { RepoHealthReport } from "../health-check";
import type { Selection } from "./selection";
import { getStateColors } from "./color-scheme";
import { RESET, BOLD, DIM, REVERSE, RED } from "./colors";

export const MAX_TREE_HEIGHT = 7;
const MIN_STATE_COL_WIDTH = 8; // minimum: length of "complete"
export const AGE_COL_WIDTH = 3; // max age length: e.g. "27m"

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
  /** When true, hide empty repo headers from visibleList unless their repo
   * contains the current selection. Toggled by the dashboard's Option+Shift+.
   * key. System-coordinator entries are a separate FlatEntry kind and unaffected. */
  hideEmptyRepos = false;

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
    if (!this.hideEmptyRepos) return base;

    // Resolve the selected entry's repoPath (if any) so its repo-header stays
    // visible. We read from selectedId + _flatList (NOT selection/visibleList)
    // to avoid recursion.
    let selectedRepoPath: string | null = null;
    if (this.hasSelection && this.selectedId !== null) {
      if (this.selectedId.startsWith("repopath:")) {
        selectedRepoPath = this.selectedId.slice("repopath:".length);
      } else if (this.selectedId !== SYSTEM_COORDINATOR_ID) {
        const found = this._flatList.find(
          (f) => f.kind === "agent" && f.agent.id === this.selectedId
        );
        if (found && found.kind === "agent") selectedRepoPath = found.agent.repoPath;
      }
    }

    return base.filter((f) => {
      if (f.kind !== "repo-header") return true;
      if (f.hasAgents) return true;
      if (selectedRepoPath !== null && f.repoPath === selectedRepoPath) return true;
      return false;
    });
  }

  /**
   * Toggle the hide-empty-repos flag. Re-resolves the selection so
   * selectedIndex/scrollOffset stay in sync with the (now possibly shorter)
   * visibleList — without this, hidden rows above the selection would leave
   * selectedIndex pointing past the new end.
   */
  setHideEmptyRepos(value: boolean): void {
    if (this.hideEmptyRepos === value) return;
    this.hideEmptyRepos = value;
    if (this.hasSelection) {
      this.resolveSelection();
    } else if (this.visibleList.length > 0) {
      // Clamp scrollOffset/index so the render math stays valid even with no
      // active selection.
      this.selectedIndex = Math.min(this.selectedIndex, this.visibleList.length - 1);
      this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.visibleList.length - 1));
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
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.kind === "agent" && f.agent.id === agentId);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.selectedId = agentId;
      this.hasSelection = true;
      this.ensureSelectedVisible();
      return true;
    }
    return false;
  }

  /** Select repo header by repoPath. Returns true if found. Force-selects (§17.1). */
  selectByRepoPath(repoPath: string): boolean {
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.kind === "repo-header" && f.repoPath === repoPath);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.selectedId = `repopath:${repoPath}`;
      this.hasSelection = true;
      this.ensureSelectedVisible();
      return true;
    }
    return false;
  }

  /**
   * Return the tree to the no-selection state (§17.1): `selection` becomes null
   * and no row renders in reverse video. selectedIndex/scrollOffset are kept as
   * valid values for the render math; only hasSelection (and selectedId) clear.
   */
  deselect(): void {
    this.hasSelection = false;
    this.selectedId = null;
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

  /** Update selectedId from current selectedIndex */
  private updateSelectedId() {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      const item = visible[this.selectedIndex]!;
      if (item.kind === "system-coordinator") {
        this.selectedId = SYSTEM_COORDINATOR_ID;
      } else if (item.kind === "repo-header") {
        this.selectedId = `repopath:${item.repoPath}`;
      } else {
        this.selectedId = item.agent.id;
      }
    }
  }

  /** Re-resolve selectedIndex from selectedId after flatList changes */
  private resolveSelection() {
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
        const triangle = item.hasAgents ? "▾" : "▸";
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
