/**
 * SidebarComponent — fixed 60-column vertical stack with three sections:
 * agent tree (top), info panel (middle), coordinator placeholder (bottom).
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { AgentTreeComponent, MAX_TREE_HEIGHT } from "./agent-tree";
import { InfoPanelComponent } from "./info-panel";
import { RESET, BOLD, DIM, DIM_GRAY } from "./colors";
import { buildFocusSeparator } from "./focus";
import type { FocusTarget } from "./focus";

export const SIDEBAR_WIDTH = 60;

/** Minimum rows for the coordinator section */
const MIN_COORDINATOR_HEIGHT = 5;
/** Minimum rows for the coordinator before it disappears */
const COORDINATOR_SHRINK_MIN = 3;

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
  /** Which panel currently has focus (set by dashboard before render) */
  focusTarget: FocusTarget = "agent-tree";
  /** Height offsets for sidebar panels — positive grows, negative shrinks */
  heightOffsets: { tree: number; info: number; coordinator: number } = { tree: 0, info: 0, coordinator: 0 };

  constructor(agentTree: AgentTreeComponent, infoPanel: InfoPanelComponent) {
    this.agentTree = agentTree;
    this.infoPanel = infoPanel;
  }

  invalidate(): void {
    this.agentTree.invalidate();
    this.infoPanel.invalidate();
  }

  render(width: number): string[] {
    const w = width;
    const lines: string[] = [];

    const itemCount = this.agentTree.visibleList.length;
    const base = computeSidebarHeights(this.displayHeight, itemCount);
    // Apply height offsets: grow focused panel, shrink panel below
    let treeHeight = Math.max(1, base.treeHeight + this.heightOffsets.tree);
    let infoHeight = Math.max(0, base.infoHeight + this.heightOffsets.info);
    let coordinatorHeight = Math.max(0, base.coordinatorHeight + this.heightOffsets.coordinator);

    // Clamp so total content + headers fits within displayHeight.
    // Headers: 1 (Agents) + 1 (Info, if shown) + 1 (Coordinator, if shown)
    const headerCount = 1 + (infoHeight > 0 ? 1 : 0) + (coordinatorHeight > 0 ? 1 : 0);
    const budget = this.displayHeight - headerCount;
    if (budget > 0 && treeHeight + infoHeight + coordinatorHeight > budget) {
      // Shrink from bottom up: coordinator first, then info, then tree
      const excess = treeHeight + infoHeight + coordinatorHeight - budget;
      const coordShrink = Math.min(coordinatorHeight, excess);
      coordinatorHeight -= coordShrink;
      const remaining = excess - coordShrink;
      if (remaining > 0) {
        const infoShrink = Math.min(infoHeight, remaining);
        infoHeight -= infoShrink;
        const leftover = remaining - infoShrink;
        if (leftover > 0) {
          treeHeight = Math.max(1, treeHeight - leftover);
        }
      }
    }

    // Agents section header + tree
    lines.push(buildFocusSeparator("Agents", w, this.focusTarget === "agent-tree"));
    this.agentTree.maxHeight = treeHeight;
    const treeLines = this.agentTree.render(w);
    lines.push(...treeLines);
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

    // Coordinator separator + placeholder
    if (coordinatorHeight > 0) {
      lines.push(buildFocusSeparator("Coordinator", w, this.focusTarget === "coordinator"));
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

/** Render coordinator placeholder (Phase 47 will replace this) */
function renderCoordinatorPlaceholder(width: number, height: number): string[] {
  const lines: string[] = [];
  lines.push(truncateToWidth(`${DIM}[coordinator — not yet active]${RESET}`, width, ""));
  while (lines.length < height) {
    lines.push("");
  }
  return lines;
}
