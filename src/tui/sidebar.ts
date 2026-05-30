/**
 * SidebarComponent — resizable vertical stack (default 60 columns, range 30–120)
 * with two sections: agent tree (top), info panel (bottom).
 * The system coordinator is never shown in the sidebar — it only appears in the main
 * area when selected in the agent tree.
 */

import type { Component } from "@mariozechner/pi-tui";
import { AgentTreeComponent, MAX_TREE_HEIGHT } from "./agent-tree";
import { TeamsTreeComponent } from "./teams-tree";
import { InfoPanelComponent } from "./info-panel";
import type { TmuxPaneComponent } from "./dashboard";
import type { InputFieldComponent } from "./input-field";
import { buildFocusSeparator, buildTabbedFocusSeparator } from "./focus";
import type { FocusTarget } from "./focus";

export const SIDEBAR_WIDTH = 60;

/** Minimum sidebar width (columns). */
export const MIN_SIDEBAR = 30;

/** Maximum sidebar width (columns). */
export const MAX_SIDEBAR = 120;

/**
 * Compute sidebar section heights.
 * The sidebar has two sections: tree (top) and info (bottom).
 * coordinatorHeight is always 0 — the coordinator is shown in the main area, not the sidebar.
 *
 * @param available - total rows available for the sidebar content
 * @param itemCount - number of visible items in the agent tree (agents + repo headers)
 */
export function computeSidebarHeights(
  available: number,
  itemCount: number,
): { treeHeight: number; infoHeight: number; coordinatorHeight: number } {
  const treeHeight = Math.min(MAX_TREE_HEIGHT, Math.max(1, itemCount));

  const agentsHeaderLine = 1;
  const infoHeaderLine = 1;
  const remaining = available - agentsHeaderLine - treeHeight;
  if (remaining <= 0) {
    return { treeHeight: Math.max(1, available - agentsHeaderLine), infoHeight: 0, coordinatorHeight: 0 };
  }

  const infoHeight = Math.max(1, remaining - infoHeaderLine);
  return { treeHeight, infoHeight, coordinatorHeight: 0 };
}

/**
 * Clamp sidebar height offsets so no panel drops below 1 row.
 * Mutates `offsets` in place. Safe to call at both load time and render time.
 */
export function clampSidebarOffsets(
  base: { treeHeight: number; infoHeight: number; coordinatorHeight: number },
  offsets: { tree: number; info: number; coordinator: number },
): void {
  if (base.treeHeight + offsets.tree < 1) {
    offsets.tree = 1 - base.treeHeight;
  }
  if (base.infoHeight > 0 && base.infoHeight + offsets.info < 1) {
    offsets.info = 1 - base.infoHeight;
  }
}

export class SidebarComponent implements Component {
  agentTree: AgentTreeComponent;
  /**
   * Teams tree component (§17.1). Shares the SAME tree region with `agentTree`
   * — only one renders at a time, chosen by `focusTarget`. The two panels hold
   * independent selection state (§17.1 independent-selection invariant); the
   * sidebar never resets either when focus toggles.
   */
  teamsTree: TeamsTreeComponent;
  infoPanel: InfoPanelComponent;
  /** Coordinator tmux pane component — used by the dashboard main area when coordinator is selected */
  coordinatorPane: TmuxPaneComponent | null = null;
  /** Coordinator input field — used by the dashboard main area when coordinator is selected */
  coordinatorInputField: InputFieldComponent | null = null;
  /** Total available height for the sidebar (set by dashboard before render) */
  displayHeight = 30;
  /** Which panel currently has focus (set by dashboard before render) */
  focusTarget: FocusTarget = "agent-tree";
  /** Height offsets for sidebar panels — positive grows, negative shrinks */
  heightOffsets: { tree: number; info: number; coordinator: number } = { tree: 0, info: 0, coordinator: 0 };
  /** When true, sidebar hides the agent tree and gives all space to the info panel.
   *  Used in TREE mode where the full tree is rendered in the main area, so the
   *  sidebar tree would just duplicate it. */
  hideTree = false;

  constructor(agentTree: AgentTreeComponent, infoPanel: InfoPanelComponent, teamsTree?: TeamsTreeComponent) {
    this.agentTree = agentTree;
    this.infoPanel = infoPanel;
    this.teamsTree = teamsTree ?? new TeamsTreeComponent();
  }

  invalidate(): void {
    this.agentTree.invalidate();
    this.teamsTree.invalidate();
    this.infoPanel.invalidate();
  }

  render(width: number): string[] {
    return this.renderNormalLayout(width);
  }

  /** Normal two-section layout: tree + info */
  private renderNormalLayout(width: number): string[] {
    const w = width;
    const lines: string[] = [];

    if (this.hideTree) {
      // Info panel takes the whole sidebar (header + content).
      lines.push(buildFocusSeparator("Info", w, this.focusTarget === "info"));
      const infoHeight = Math.max(0, this.displayHeight - 1);
      this.infoPanel.displayHeight = infoHeight;
      lines.push(...this.infoPanel.render(w));
      while (lines.length < this.displayHeight) lines.push("");
      return lines.slice(0, this.displayHeight);
    }

    // §17.1: when focus is on the Teams tree, render the Teams tree into the
    // shared tree region; otherwise render the Agents tree. The two panels share
    // the same height budget — only one is visible at a time.
    const showTeams = this.focusTarget === "teams-tree";
    const treeItemCount = showTeams
      ? this.teamsTree.flatList.length
      : this.agentTree.visibleList.length;
    const base = computeSidebarHeights(this.displayHeight, treeItemCount);
    // Apply height offsets: grow focused panel, shrink the other.
    // Render-path clamping (BUG-3/§7.7): normalize offsets so they stay valid
    // for the current terminal size and agent count.
    clampSidebarOffsets(base, this.heightOffsets);
    let treeHeight = Math.max(1, base.treeHeight + this.heightOffsets.tree);
    let infoHeight = Math.max(0, base.infoHeight + this.heightOffsets.info);

    // Clamp so total content + headers fits within displayHeight.
    // Headers: 1 (tree title) + 1 (Info, if shown)
    const headerCount = 1 + (infoHeight > 0 ? 1 : 0);
    const budget = this.displayHeight - headerCount;
    if (budget > 0 && treeHeight + infoHeight > budget) {
      // Shrink from bottom up: info first, then tree
      const excess = treeHeight + infoHeight - budget;
      const infoShrink = Math.min(infoHeight, excess);
      infoHeight -= infoShrink;
      const leftover = excess - infoShrink;
      if (leftover > 0) {
        treeHeight = Math.max(1, treeHeight - leftover);
      }
    }

    // Tree section header: a side-by-side Agents/Teams tab line. The active
    // tab is highlighted (REVERSE+BOLD); the inactive tab is DIM. Only ONE
    // tree (the active one) renders below — the header reflects which is
    // visible AND which has focus.
    const tabs = [
      { label: "Agents", focused: this.focusTarget === "agent-tree" },
      { label: "Teams", focused: this.focusTarget === "teams-tree" },
    ];
    lines.push(buildTabbedFocusSeparator(tabs, w));
    if (showTeams) {
      this.teamsTree.maxHeight = treeHeight;
      const treeLines = this.teamsTree.render(w);
      lines.push(...treeLines);
    } else {
      this.agentTree.maxHeight = treeHeight;
      const treeLines = this.agentTree.render(w);
      lines.push(...treeLines);
    }
    // Pad tree to exact height (header + treeHeight)
    while (lines.length < treeHeight + 1) {
      lines.push("");
    }

    // Info separator + info panel
    if (infoHeight > 0) {
      lines.push(buildFocusSeparator("Info", w, this.focusTarget === "info"));
      this.infoPanel.displayHeight = infoHeight;
      const infoLines = this.infoPanel.render(w);
      lines.push(...infoLines);
    }

    // Ensure total output matches displayHeight
    while (lines.length < this.displayHeight) {
      lines.push("");
    }
    return lines.slice(0, this.displayHeight);
  }

}
