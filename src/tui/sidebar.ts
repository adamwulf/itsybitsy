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

  // Budget remaining after Agents header (always present) and tree content.
  // NOTE: SPEC §11.2 uses separators(2) but the implementation has 3 section header lines
  // (Agents, Info, Coordinator) per PLAN §45a which specifies a header for each section.
  const agentsHeaderLine = 1;
  const remaining = available - agentsHeaderLine - treeHeight;
  if (remaining <= 0) {
    return { treeHeight: Math.max(1, available - agentsHeaderLine), infoHeight: 0, coordinatorHeight: 0 };
  }

  // Coordinator gets 40% of (available - tree_height) per spec, accounting for its header
  const coordinatorHeaderLine = 1;
  let coordinatorHeight = Math.max(MIN_COORDINATOR_HEIGHT, Math.floor(remaining * 0.4));

  // Info gets what's left, minus its own header line and the coordinator header line
  const infoHeaderLine = 1;
  const infoAvailable = remaining - coordinatorHeight - coordinatorHeaderLine - infoHeaderLine;
  let infoHeight = Math.max(1, infoAvailable);

  // If terminal is too short for info to fit (< 1 row), hide info panel entirely
  if (infoAvailable < 1) {
    infoHeight = 0;
    // Reclaim info header space; coordinator gets remaining minus its own header
    coordinatorHeight = Math.max(COORDINATOR_SHRINK_MIN, remaining - coordinatorHeaderLine);
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
