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
/**
 * Compute sidebar section heights per SPEC §11.2:
 *   coordinator_height = max(5, floor((available - tree_height) * 0.4))
 *   info_height = max(1, available - tree_height - coordinator_height - section_headers(3))
 *
 * Section headers: "Agents" (top), "Info" (middle), "Coordinator" (bottom) = 3 lines.
 *
 * @param available - total rows available for the sidebar content
 * @param itemCount - number of visible items in the agent tree (agents + repo headers)
 */
export function computeSidebarHeights(
  available: number,
  itemCount: number,
): { treeHeight: number; infoHeight: number; coordinatorHeight: number } {
  const treeHeight = Math.min(MAX_TREE_HEIGHT, Math.max(1, itemCount));

  // Coordinator gets 40% of (available - tree_height), per spec
  const afterTree = available - treeHeight;
  if (afterTree <= 0) {
    return { treeHeight: Math.max(1, available), infoHeight: 0, coordinatorHeight: 0 };
  }

  let coordinatorHeight = Math.max(MIN_COORDINATOR_HEIGHT, Math.floor(afterTree * 0.4));

  // Info gets what's left after tree + coordinator + 3 section headers (min 1 row per spec)
  const sectionHeaders = 3; // Agents, Info, Coordinator
  let infoHeight = Math.max(1, afterTree - coordinatorHeight - sectionHeaders);

  // If terminal is too short for info to fit, shrink coordinator first (down to 3), then hide info
  if (afterTree - coordinatorHeight - sectionHeaders < 1) {
    infoHeight = 0;
    // Only 2 headers when info is hidden (Agents + Coordinator)
    coordinatorHeight = Math.max(COORDINATOR_SHRINK_MIN, afterTree - 2);
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

    const itemCount = this.agentTree.visibleList.length;
    const { treeHeight, infoHeight, coordinatorHeight } = computeSidebarHeights(
      this.displayHeight,
      itemCount,
    );

    // Agents section header + tree
    lines.push(buildSectionSeparator("Agents", w));
    this.agentTree.maxHeight = treeHeight;
    const treeLines = this.agentTree.render(w);
    lines.push(...treeLines);
    // Pad tree to exact height (header + treeHeight)
    while (lines.length < treeHeight + 1) {
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
