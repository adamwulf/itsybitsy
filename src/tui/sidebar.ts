/**
 * SidebarComponent — fixed 60-column vertical stack with three sections:
 * agent tree (top), info panel (middle), coordinator placeholder (bottom).
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { AgentTreeComponent, MAX_TREE_HEIGHT } from "./agent-tree";
import { InfoPanelComponent } from "./info-panel";
import { RESET, BOLD, DIM, DIM_GRAY } from "./colors";

export const SIDEBAR_WIDTH = 60;

/** Minimum rows for the coordinator section */
const MIN_COORDINATOR_HEIGHT = 5;
/** Minimum rows for the coordinator before it disappears */
const COORDINATOR_SHRINK_MIN = 3;

/**
 * Compute the height allocation for the three sidebar sections.
 * Returns { treeHeight, infoHeight, coordinatorHeight }.
 */
export function computeSidebarHeights(
  available: number,
  agentCount: number,
): { treeHeight: number; infoHeight: number; coordinatorHeight: number } {
  // Tree height: min of MAX_TREE_HEIGHT and actual item count
  const treeHeight = Math.min(MAX_TREE_HEIGHT, Math.max(1, agentCount));

  // 2 separators between sections
  const separators = 2;
  const remaining = available - treeHeight - separators;

  if (remaining <= 0) {
    return { treeHeight: Math.max(1, available), infoHeight: 0, coordinatorHeight: 0 };
  }

  // Coordinator gets 40% of remaining, minimum 5
  let coordinatorHeight = Math.max(MIN_COORDINATOR_HEIGHT, Math.floor(remaining * 0.4));
  let infoHeight = Math.max(1, remaining - coordinatorHeight);

  // If not enough space, shrink coordinator first
  if (coordinatorHeight + infoHeight > remaining) {
    coordinatorHeight = Math.max(COORDINATOR_SHRINK_MIN, remaining - 1);
    infoHeight = Math.max(0, remaining - coordinatorHeight);
  }

  // If still too tight, remove info panel
  if (infoHeight <= 0) {
    infoHeight = 0;
    coordinatorHeight = Math.min(coordinatorHeight, remaining);
  }

  return { treeHeight, infoHeight, coordinatorHeight };
}

export class SidebarComponent implements Component {
  agentTree: AgentTreeComponent;
  infoPanel: InfoPanelComponent;
  /** Total available height for the sidebar (set by dashboard before render) */
  displayHeight = 30;

  constructor(agentTree: AgentTreeComponent, infoPanel: InfoPanelComponent) {
    this.agentTree = agentTree;
    this.infoPanel = infoPanel;
  }

  invalidate(): void {
    this.agentTree.invalidate();
    this.infoPanel.invalidate();
  }

  render(width: number): string[] {
    const w = Math.min(width, SIDEBAR_WIDTH);
    const lines: string[] = [];

    const agentCount = this.agentTree.visibleList.length;
    const { treeHeight, infoHeight, coordinatorHeight } = computeSidebarHeights(
      this.displayHeight,
      agentCount,
    );

    // Agent tree section
    this.agentTree.maxHeight = treeHeight;
    const treeLines = this.agentTree.render(w);
    lines.push(...treeLines);
    // Pad tree to exact height
    while (lines.length < treeHeight) {
      lines.push("");
    }

    // Info separator + info panel
    if (infoHeight > 0) {
      lines.push(buildSectionSeparator("Info", w));
      this.infoPanel.displayHeight = infoHeight;
      const infoLines = this.infoPanel.render(w);
      lines.push(...infoLines);
    }

    // Coordinator separator + placeholder
    if (coordinatorHeight > 0) {
      lines.push(buildSectionSeparator("Coordinator", w));
      const coordLines = renderCoordinatorPlaceholder(w, coordinatorHeight);
      lines.push(...coordLines);
    }

    // Ensure total output matches displayHeight
    while (lines.length < this.displayHeight) {
      lines.push("");
    }
    return lines.slice(0, this.displayHeight);
  }
}

/** Build a section separator: ──── Title ──── */
function buildSectionSeparator(title: string, width: number): string {
  const leftPad = 4;
  const titleStr = ` ${title} `;
  const rightPad = Math.max(1, width - leftPad - titleStr.length);
  return truncateToWidth(
    `${DIM_GRAY}${"─".repeat(leftPad)}${RESET}${BOLD}${titleStr}${RESET}${DIM_GRAY}${"─".repeat(rightPad)}${RESET}`,
    width,
    "",
  );
}

/** Render coordinator placeholder (Phase 47 will replace this) */
function renderCoordinatorPlaceholder(width: number, height: number): string[] {
  const lines: string[] = [];
  lines.push(truncateToWidth(`${DIM}[coordinator — not yet active]${RESET}`, width, ""));
  while (lines.length < height) {
    lines.push("");
  }
  return lines;
}
