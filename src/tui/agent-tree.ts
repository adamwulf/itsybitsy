/**
 * Agent tree component — displays agents in a scrollable tree with status indicators.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Agent, FlatEntry } from "../agents";
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
    }
  }
  return maxLen;
}

/** Compute the visible width of the name prefix (connector + icon + repo/id) for an agent row */
function agentNamePrefixWidth(agent: Agent, connector: string): number {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agent.meta.worker ? "⚙" : "◆";
  return visibleWidth(`${connector}${orphanedPrefix}${icon} ${agent.id}`);
}

/** Format agent row for the tree */
export function formatAgentRow(
  agent: Agent,
  connector: string,
  selected: boolean,
  width: number,
  nameColWidth: number,
  stateColWidth: number = MIN_STATE_COL_WIDTH,
  hasQuestion: boolean = false
): string {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agent.meta.worker ? "⚙" : "◆";
  const state = displayState(agent.state);
  const stateColor = getStateColors()[state] ?? getStateColors().unknown;

  const nameColor = hasQuestion ? RED : "";
  const nameEnd = hasQuestion ? RESET : "";
  const namePrefix = `${connector}${orphanedPrefix}${icon} ${nameColor}${agent.id}${nameEnd}`;
  const namePad = Math.max(0, nameColWidth - visibleWidth(namePrefix));
  const promptText = (agent.meta.summary ?? agent.meta.prompt).replace(/\n/g, " ");
  const coloredState = `${stateColor}${state}${RESET}${" ".repeat(Math.max(0, stateColWidth - state.length))}`;
  const paddedAge = agent.age.padStart(AGE_COL_WIDTH);
  const line = `${namePrefix}${" ".repeat(namePad)}  ${coloredState}  ${paddedAge}  ${agent.meta.model}  ${promptText}`;

  const truncated = truncateToWidth(line, width, "");
  if (selected) {
    const pad = Math.max(0, width - visibleWidth(truncated));
    const highlighted = truncated.replaceAll(RESET, RESET + REVERSE);
    return `${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`;
  }
  return truncated;
}

/** Agent tree component with height constraint and scrolling */
export class AgentTreeComponent implements Component {
  private _flatList: FlatEntry[] = [];
  private selectedIndex = 0;
  maxHeight = MAX_TREE_HEIGHT;
  private scrollOffset = 0;
  private selectedId: string | null = null;
  questionAgentIds: Set<string> = new Set();
  suppressSelection = false;

  get flatList(): FlatEntry[] {
    return this._flatList;
  }

  setFlatList(list: FlatEntry[]) {
    this._flatList = list;
    this.resolveSelection();
  }

  get visibleList(): FlatEntry[] {
    return this.flatList.filter((f) => f.kind === "repo-header" || !f.agent.archived);
  }

  get selectedAgent(): Agent | null {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      const item = visible[this.selectedIndex]!;
      if (item.kind === "repo-header") return null;
      return item.agent;
    }
    return null;
  }

  get selectedRepoHeader(): string | null {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      const item = visible[this.selectedIndex]!;
      if (item.kind === "repo-header") return item.repoName;
      return null;
    }
    return null;
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

  /** Update selectedId from current selectedIndex */
  private updateSelectedId() {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      const item = visible[this.selectedIndex]!;
      this.selectedId = item.kind === "repo-header" ? `repopath:${item.repoPath}` : item.agent.id;
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
      this.updateSelectedId();
      this.ensureSelectedVisible();
      return;
    }
    const idx = visible.findIndex((f) =>
      f.kind === "repo-header" ? `repopath:${f.repoPath}` === this.selectedId : f.agent.id === this.selectedId,
    );
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
      }
    }
    const stateColWidth = computeStateColWidth(visible);

    // Scroll indicator at top
    if (start > 0) {
      lines.push(truncateToWidth(`${DIM}  ▲ ${start} more${RESET}`, width, ""));
    }

    for (let i = start; i < end; i++) {
      const item = visible[i]!;
      if (item.kind === "repo-header") {
        const selected = i === this.selectedIndex && !this.suppressSelection;
        const triangle = item.hasAgents ? "▾" : "▸";
        const truncated = truncateToWidth(`${BOLD}${triangle} ${item.repoName}${RESET}`, width, "");
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
