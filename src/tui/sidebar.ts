/**
 * SidebarComponent — resizable vertical stack (default 60 columns, range 30–120)
 * with three sections: agent tree (top), info panel (middle), coordinator placeholder (bottom).
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { AgentTreeComponent, MAX_TREE_HEIGHT } from "./agent-tree";
import { InfoPanelComponent } from "./info-panel";
import type { TmuxPaneComponent } from "./dashboard";
import type { InputFieldComponent } from "./input-field";
import { RESET, BOLD, DIM, DIM_GRAY, YELLOW } from "./colors";
import { wrapLines, findLastTwoSeparators } from "./wrap";
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
  /** Coordinator tmux pane component — renders live coordinator output in the sidebar */
  coordinatorPane: TmuxPaneComponent | null = null;
  /** Coordinator input field — shown at bottom of coordinator section when focused */
  coordinatorInputField: InputFieldComponent | null = null;
  /** Total available height for the sidebar (set by dashboard before render) */
  displayHeight = 30;
  /** Which panel currently has focus (set by dashboard before render) */
  focusTarget: FocusTarget = "agent-tree";
  /** Height offsets for sidebar panels — positive grows, negative shrinks */
  heightOffsets: { tree: number; info: number; coordinator: number } = { tree: 0, info: 0, coordinator: 0 };
  /** When true, hide info panel and give coordinator all remaining space */
  coordinatorFullWidth = false;

  constructor(agentTree: AgentTreeComponent, infoPanel: InfoPanelComponent) {
    this.agentTree = agentTree;
    this.infoPanel = infoPanel;
  }

  invalidate(): void {
    this.agentTree.invalidate();
    this.infoPanel.invalidate();
  }

  render(width: number): string[] {
    if (this.coordinatorFullWidth) {
      return this.renderCoordinatorLayout(width);
    }
    return this.renderNormalLayout(width);
  }

  /** Normal three-section layout: tree + info + coordinator */
  private renderNormalLayout(width: number): string[] {
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

    // System Coordinator separator + content
    if (coordinatorHeight > 0) {
      lines.push(buildFocusSeparator("System Coordinator", w, this.focusTarget === "coordinator"));
      this.renderCoordinatorContent(lines, w, coordinatorHeight);
    }

    // Ensure total output matches displayHeight
    while (lines.length < this.displayHeight) {
      lines.push("");
    }
    return lines.slice(0, this.displayHeight);
  }

  /**
   * Two-section layout when system coordinator is selected:
   * tree (top) + coordinator tmux output (bottom, all remaining space).
   * Info panel is hidden.
   */
  private renderCoordinatorLayout(width: number): string[] {
    const w = width;
    const lines: string[] = [];

    const itemCount = this.agentTree.visibleList.length;
    const treeHeight = Math.min(MAX_TREE_HEIGHT, Math.max(1, itemCount));

    // Agents section header + tree
    lines.push(buildFocusSeparator("Agents", w, this.focusTarget === "agent-tree"));
    this.agentTree.maxHeight = treeHeight;
    const treeLines = this.agentTree.render(w);
    lines.push(...treeLines);
    // Pad tree to exact height (header + treeHeight)
    while (lines.length < treeHeight + 1) {
      lines.push("");
    }

    // Coordinator gets all remaining space: available - tree_height - 1 (tree header) - 1 (coordinator header)
    const coordinatorHeight = Math.max(1, this.displayHeight - treeHeight - 2);

    lines.push(buildFocusSeparator("System Coordinator", w, this.focusTarget === "coordinator"));
    this.renderCoordinatorContent(lines, w, coordinatorHeight);

    // Ensure total output matches displayHeight
    while (lines.length < this.displayHeight) {
      lines.push("");
    }
    return lines.slice(0, this.displayHeight);
  }

  /** Render coordinator content (shared by both layouts) */
  private renderCoordinatorContent(lines: string[], w: number, height: number): void {
    // Compute input field height when active
    const showInputField = this.coordinatorInputField?.active === true;
    const inputFieldHeight = showInputField ? this.coordinatorInputField!.getHeight(w) : 0;
    const outputHeight = Math.max(1, height - inputFieldHeight);

    if (this.coordinatorPane) {
      if (this.coordinatorPane.hasPolled && !this.coordinatorPane.rawOutput) {
        const stoppedLines = renderCoordinatorStopped(w, outputHeight);
        lines.push(...stoppedLines);
      } else if (!this.coordinatorPane.hasPolled) {
        const loadingLines: string[] = [];
        // Bottom-pin loading message
        while (loadingLines.length < outputHeight - 1) loadingLines.push("");
        loadingLines.push(truncateToWidth(`${DIM}Starting system coordinator...${RESET}`, w, ""));
        lines.push(...loadingLines);
      } else {
        this.coordinatorPane.displayHeight = outputHeight;
        const coordLines = renderCoordinatorOutput(this.coordinatorPane.rawOutput, w, outputHeight, showInputField);
        lines.push(...coordLines);
      }
    } else {
      const coordLines = renderCoordinatorPlaceholder(w, outputHeight);
      lines.push(...coordLines);
    }

    // Append input field at the bottom when active
    if (showInputField) {
      const inputLines = this.coordinatorInputField!.render(w);
      lines.push(...inputLines);
    }
  }
}

/** Render coordinator placeholder (Phase 47 will replace this) */
function renderCoordinatorPlaceholder(width: number, height: number): string[] {
  // Bottom-pin: pad at top so content sticks to bottom
  const lines: string[] = [];
  while (lines.length < height - 1) lines.push("");
  lines.push(truncateToWidth(`${DIM}[coordinator — not yet active]${RESET}`, width, ""));
  return lines;
}

/** Render coordinator stopped message with restart hint */
function renderCoordinatorStopped(width: number, height: number): string[] {
  // Bottom-pin: pad at top so content sticks to bottom
  const contentLines = [
    truncateToWidth(`${YELLOW}System coordinator stopped${RESET}`, width, ""),
    truncateToWidth(`${DIM}Press R to restart${RESET}`, width, ""),
  ];
  const lines: string[] = [];
  const padCount = Math.max(0, height - contentLines.length);
  for (let i = 0; i < padCount; i++) lines.push("");
  lines.push(...contentLines);
  return lines;
}

/** Render coordinator output directly (bypasses TmuxPaneComponent's agent check) */
function renderCoordinatorOutput(rawOutput: string, width: number, height: number, trimInput: boolean = false): string[] {
  let wrapped = wrapLines(rawOutput, width);

  // When showing our own input field, trim Claude's native input area.
  // Same logic as TmuxPaneComponent: find the last two ─ separators and trim at the upper one.
  if (trimInput) {
    const { upperIndex } = findLastTwoSeparators(wrapped);
    if (upperIndex >= 0 && upperIndex < wrapped.length) {
      wrapped = wrapped.slice(0, upperIndex);
    }
  }

  // Show the last `height` lines (follow newest output)
  const start = Math.max(0, wrapped.length - height);
  const visible = wrapped.slice(start, start + height);
  const contentLines = visible.map((line) => truncateToWidth(line, width, ""));

  // Bottom-pin: pad at the top so content sticks to the bottom
  const padCount = Math.max(0, height - contentLines.length);
  const lines: string[] = [];
  for (let i = 0; i < padCount; i++) lines.push("");
  lines.push(...contentLines);
  return lines;
}
