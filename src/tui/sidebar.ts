/**
 * SidebarComponent — resizable vertical stack (default 60 columns, range 30–120)
 * with two sections: agent tree (top), info panel (bottom).
 * The system coordinator has no section of its own: it is a row in the agent
 * tree, and its tmux output shows in the main area when that row is selected.
 */

import type { Component } from "@mariozechner/pi-tui";
import { AgentTreeComponent, MAX_TREE_HEIGHT } from "./agent-tree";
import { TeamsTreeComponent } from "./teams-tree";
import { InfoPanelComponent } from "./info-panel";
import type { TmuxPaneComponent } from "./dashboard";
import type { InputFieldComponent } from "./input-field";
import { buildFocusSeparator, buildTabbedFocusSeparator } from "./focus";
import type { FocusTarget } from "./focus";

/**
 * Which tab the sidebar shows in its tree region. Independent of focus
 * (Phase 1 of the three-axis model — see SPEC §17.1). Controlled by the
 * `1` / `2` / `3` keys at the dashboard level; Tab cycling never changes it.
 * `"favorites"` is a VIEW of the Agents tree (the same `AgentTreeComponent`
 * with its favorites filter on), not a separate tree.
 */
export type SidebarMode = "agents" | "teams" | "favorites";

/**
 * Which tree owns the GLOBAL selection (SPEC §17.1 axis 3). Only two trees
 * exist — the Favorites tab navigates the Agents tree, so it maps to
 * `"agents"`.
 */
export type SelectionSource = "agents" | "teams";

export const SIDEBAR_WIDTH = 60;

/** Minimum sidebar width (columns). */
export const MIN_SIDEBAR = 30;

/** Maximum sidebar width (columns). */
export const MAX_SIDEBAR = 120;

/**
 * Compute sidebar section heights.
 * The sidebar has two sections: tree (top) and info (bottom).
 * coordinatorHeight is always 0 — the coordinator has no sidebar section (it is
 * a tree row; its tmux output shows in the main area).
 *
 * @param available - total rows available for the sidebar content
 * @param itemCount - rows the visible tab's tree wants (SidebarComponent.treeItemCount)
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
 * Clamp sidebar height offsets so no panel drops below 1 row. The `{`/`}`
 * resize moves a row between the tree and info, so the offsets are a pair
 * (info = -tree): the clamp bounds the tree offset from both sides (the tree
 * keeps ≥ 1 row, and info keeps ≥ 1 row when it has room at all) and sets
 * info to match. That also mends an unpaired pair from an old layout.json.
 * Mutates `offsets` in place. render() clamps a COPY: `base` changes with the
 * visible tab's row count and the terminal height, so writing the clamp back
 * would lose the user's resize (a tree shrunk in the Agents tab would come
 * back taller after a visit to a short Favorites view). The `{`/`}` resize
 * also works on the clamped copy (SidebarComponent.clampedHeights), so each
 * keypress changes the rendered height at once, and stores it only when the
 * key changes a height.
 */
export function clampSidebarOffsets(
  base: { treeHeight: number; infoHeight: number; coordinatorHeight: number },
  offsets: { tree: number; info: number; coordinator: number },
): void {
  const minTree = 1 - base.treeHeight;
  const maxTree = base.infoHeight > 0 ? base.infoHeight - 1 : 0;
  offsets.tree = Math.min(maxTree, Math.max(minTree, offsets.tree));
  offsets.info = -offsets.tree;
}

export class SidebarComponent implements Component {
  agentTree: AgentTreeComponent;
  /**
   * Teams tree component (§17.1). Shares the SAME tree region with `agentTree`
   * — only one renders at a time, chosen by `sidebarMode` (Phase 1 three-axis
   * model; the Agents and Favorites tabs both render `agentTree`). The two
   * trees hold independent selection state (§17.1 independent-selection
   * invariant); the sidebar never resets either when `sidebarMode` toggles.
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
  /**
   * Which tab to render in the sidebar tree region (Phase 1 of the three-axis
   * model — see SPEC §17.1). Independent of focus; controlled by the
   * `1`/`2`/`3` keys at the dashboard level. Set by the dashboard before
   * render. The dashboard also turns `agentTree.favoritesOnly` on for
   * `"favorites"` — this component only picks which tree renders.
   */
  sidebarMode: SidebarMode = "agents";
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

  /**
   * The rows the tree region wants for `mode`'s tab: the Agents tree's rows
   * (with the Favorites hint row) for Agents and Favorites, the Teams tree's
   * rows for Teams. render() sizes the tree from it, and the dashboard's
   * `{`/`}` resize uses it too so its guards match what renders.
   */
  treeItemCount(mode: SidebarMode): number {
    return mode === "teams" ? this.teamsTree.flatList.length : this.agentTree.renderRowCount;
  }

  /**
   * The base heights for `mode`'s tab and a COPY of `heightOffsets` clamped
   * to them (see clampSidebarOffsets). render() lays out from these, and the
   * dashboard's `{`/`}` resize computes its guards from them, so the two
   * always agree. The stored offsets are left alone.
   */
  clampedHeights(mode: SidebarMode): {
    base: ReturnType<typeof computeSidebarHeights>;
    offsets: SidebarComponent["heightOffsets"];
  } {
    const base = computeSidebarHeights(this.displayHeight, this.treeItemCount(mode));
    const offsets = { ...this.heightOffsets };
    clampSidebarOffsets(base, offsets);
    return { base, offsets };
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

    // §17.1 (Phase 1 three-axis model): which tree renders is driven by
    // `sidebarMode` (switched by `1`/`2`/`3`), NOT by focus. The trees share
    // the same height budget — only one is visible at a time. The Favorites
    // tab renders the Agents tree with its favorites filter on.
    const showTeams = this.sidebarMode === "teams";
    // Apply height offsets: grow focused panel, shrink the other.
    // Render-path clamping (BUG-3/§7.7): lay out from a clamped copy of the
    // offsets so they stay valid for the current terminal size and row count,
    // without losing the user's resize (see clampSidebarOffsets).
    const { base, offsets } = this.clampedHeights(this.sidebarMode);
    let treeHeight = Math.max(1, base.treeHeight + offsets.tree);
    let infoHeight = Math.max(0, base.infoHeight + offsets.info);

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

    // Tree section header: a side-by-side Agents/Teams/Favorites tab line. The
    // active tab (matching `sidebarMode`) is always marked; inactive tabs are
    // DIM. Only ONE tree renders below — the header reflects which tab is
    // currently VISIBLE (i.e., `sidebarMode`), not which panel has focus.
    // After Phase 1 (§17.1) focus and sidebar visibility are independent
    // axes. The `paneFocused` flag drives the active tab's contrast:
    // REVERSE+BOLD when the tree pane holds keyboard focus, underline
    // otherwise — so the dark high-contrast highlight follows the focus,
    // while the selected tab stays visible.
    const treePaneFocused =
      this.focusTarget === "agent-tree" || this.focusTarget === "teams-tree";
    const tabs = [
      { label: "Agents", focused: this.sidebarMode === "agents" },
      { label: "Teams", focused: this.sidebarMode === "teams" },
      { label: "Favorites", focused: this.sidebarMode === "favorites" },
    ];
    lines.push(buildTabbedFocusSeparator(tabs, w, treePaneFocused));
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
