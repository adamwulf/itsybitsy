/**
 * Agent tree component — displays agents in a scrollable tree with status indicators.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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
  if (agent.meta.agentIcon) return agent.meta.agentIcon;
  if (agent.meta.coordinator) return "◇";
  if (agent.meta.worker) return "⚙";
  return "◆";
}

/** Compute the visible width of the name prefix (connector + icon + repo/id) for an agent row */
function agentNamePrefixWidth(agent: Agent, connector: string): number {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agentIcon(agent);
  return visibleWidth(`${connector}${orphanedPrefix}${icon} ${agent.id}`);
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
  const namePrefix = `${connector}${orphanedPrefix}${icon} ${nameColor}${agent.id}${nameEnd}`;
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
  questionAgentIds: Set<string> = new Set();
  healthReports: Map<string, RepoHealthReport> = new Map();
  suppressSelection = false;

  get flatList(): FlatEntry[] {
    return this._flatList;
  }

  setFlatList(list: FlatEntry[]) {
    const wasEmpty = this._flatList.length === 0;
    this._flatList = list;
    if (wasEmpty && list.length > 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.selectedId = null;
    }
    this.resolveSelection();
    // Guard: if maxHeight hasn't been set yet (still default 1 from sidebar),
    // ensureSelectedVisible may have computed a bogus scrollOffset. Reset it.
    if (wasEmpty && list.length > 0) {
      this.scrollOffset = 0;
    }
  }

  get visibleList(): FlatEntry[] {
    return this.flatList.filter((f) =>
      f.kind === "repo-header" || f.kind === "system-coordinator" || !f.agent.archived
    );
  }

  /** Discriminated union selection — the canonical way to query what is selected */
  get selection(): Selection {
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

  /** Select agent by ID. Returns true if found. */
  selectAgentById(agentId: string): boolean {
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.kind === "agent" && f.agent.id === agentId);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.selectedId = agentId;
      this.ensureSelectedVisible();
      return true;
    }
    return false;
  }

  moveSelection(delta: number) {
    const visible = this.visibleList;
    if (visible.length === 0) return;
    const len = visible.length;
    this.selectedIndex = ((this.selectedIndex + delta) % len + len) % len;
    this.updateSelectedId();
    this.ensureSelectedVisible();
  }

  /**
   * Jump to next (delta=1) or previous (delta=-1) repo.
   *
   * If a repo-header is selected: move to the next/prev repo-header.
   * If an agent is selected: skip repos with no agents, always land on an agent.
   * If system-coordinator is selected: treat as before first repo (J goes to first repo header/agent).
   */
  moveToRepo(delta: 1 | -1) {
    const visible = this.visibleList;
    if (visible.length === 0) return;

    const current = visible[this.selectedIndex];
    const isRepoHeader = current?.kind === "repo-header";
    const isCoordinator = current?.kind === "system-coordinator";

    // Find all repo-header indices
    const repoIndices = visible.map((f, i) => (f.kind === "repo-header" ? i : -1)).filter((i) => i !== -1);
    if (repoIndices.length === 0) return;

    // System coordinator: J goes to first repo header, K wraps to last
    if (isCoordinator) {
      if (delta === 1) {
        this.selectedIndex = repoIndices[0]!;
      } else {
        this.selectedIndex = repoIndices[repoIndices.length - 1]!;
      }
      this.updateSelectedId();
      this.ensureSelectedVisible();
      return;
    }

    // Helper: get agent indices for repo at repoIndices[ri]
    const agentsForRepo = (ri: number): number[] => {
      const headerPos = repoIndices[ri]!;
      const nextHeaderPos = repoIndices[ri + 1] ?? visible.length;
      const result: number[] = [];
      for (let i = headerPos + 1; i < nextHeaderPos; i++) {
        if (visible[i]?.kind === "agent") result.push(i);
      }
      return result;
    };

    // Find which repo we are currently in
    let currentRepoIdx: number;
    if (isRepoHeader) {
      currentRepoIdx = repoIndices.indexOf(this.selectedIndex);
      if (currentRepoIdx === -1) currentRepoIdx = 0;
    } else {
      let found = -1;
      for (let i = repoIndices.length - 1; i >= 0; i--) {
        if (repoIndices[i]! <= this.selectedIndex) {
          found = i;
          break;
        }
      }
      currentRepoIdx = found === -1 ? 0 : found;
    }

    if (isRepoHeader) {
      // Repo-header selected: simply move to the next/prev repo-header
      const targetRepoIdx = ((currentRepoIdx + delta) % repoIndices.length + repoIndices.length) % repoIndices.length;
      this.selectedIndex = repoIndices[targetRepoIdx]!;
    } else {
      // Agent selected: scan for the next/prev repo that has agents, skipping empty ones
      let targetRepoIdx = currentRepoIdx;
      for (let step = 0; step < repoIndices.length; step++) {
        targetRepoIdx = ((targetRepoIdx + delta) % repoIndices.length + repoIndices.length) % repoIndices.length;
        const agents = agentsForRepo(targetRepoIdx);
        if (agents.length > 0) {
          this.selectedIndex = delta === 1 ? agents[0]! : agents[agents.length - 1]!;
          break;
        }
      }
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
          i === this.selectedIndex && !this.suppressSelection,
          width, maxNameWidth, stateColWidth,
        ));
      } else if (item.kind === "repo-header") {
        const selected = i === this.selectedIndex && !this.suppressSelection;
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
        lines.push(formatAgentRow(item.agent, item.connector, i === this.selectedIndex && !this.suppressSelection, width, maxNameWidth, stateColWidth, hasQ));
      }
    }

    // Scroll indicator at bottom
    if (remaining > 0) {
      lines.push(truncateToWidth(`${DIM}  ▼ ${remaining} more${RESET}`, width, ""));
    }

    return lines;
  }
}
