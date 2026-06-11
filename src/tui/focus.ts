/**
 * Focus management for the TUI dashboard.
 *
 * Tracks which panel currently has focus and provides cycling (Tab / Shift+Tab).
 * See SPEC.md §13 for the full specification.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import { RESET, BOLD, DIM, DIM_GRAY, REVERSE, BG_DIM_GRAY } from "./colors";

/** The focusable panels in the dashboard. */
export type FocusTarget =
  | "agent-tree"
  | "teams-tree"
  | "info"
  | "coordinator"
  | "active-agent"
  | "right-pane"
  | "repo-coordinator";

/** Sub-focus states for panels with input fields (active-agent, coordinator). */
export type SubFocus = "pane" | "input" | "send";

/** Ordered list of focus targets for cycling when `sidebarMode === "agents"`.
 *  In agents mode, the sidebar shows the Agents tree, so `agent-tree` is the
 *  head of the cycle (§17.1). `teams-tree` is NOT in this order. */
const FOCUS_ORDER: readonly FocusTarget[] = [
  "agent-tree",
  "info",
  "active-agent",
  "right-pane",
  "repo-coordinator",
] as const;

/** Ordered list of focus targets for cycling when `sidebarMode === "teams"`.
 *  In teams mode, the sidebar shows the Teams tree, so `teams-tree` is the
 *  head of the cycle (§17.1 Phase 3). `repo-coordinator` is omitted because
 *  repo headers cannot exist as team selections. The middle pane stop
 *  (`active-agent`) is shared with agents mode — it represents "the main-area
 *  pane" regardless of whether it currently renders an agent tmux pane or a
 *  team channel. */
const TEAMS_FOCUS_ORDER: readonly FocusTarget[] = [
  "teams-tree",
  "info",
  "active-agent",
  "right-pane",
] as const;

/** Restricted focus order when system coordinator is selected.
 *  Includes info (sidebar) and coordinator (main area tmux pane).
 *  Trumps `sidebarMode` — coordinator mode wins over teams mode. */
const COORDINATOR_FOCUS_ORDER: readonly FocusTarget[] = [
  "agent-tree",
  "info",
  "coordinator",
] as const;

/**
 * Manages which panel has keyboard focus.
 *
 * - `cycle(+1)` moves forward through the focus order (Tab)
 * - `cycle(-1)` moves backward (Shift+Tab)
 * - `setFocus(target)` jumps directly to a panel
 * - `current()` returns the currently focused panel
 */
export class FocusManager {
  private focus: FocusTarget;
  /** Sub-focus state for panels with input fields. */
  subFocus: SubFocus = "pane";
  /** When true, only cycle between agent-tree and coordinator. Trumps
   *  `sidebarMode` — coordinator mode wins. */
  coordinatorMode = false;
  /** Which sidebar tree is visible. Determines which Tab cycling order is
   *  active when not in coordinator mode. Mirrors `DashboardComponent.sidebarMode`
   *  (§17.1 Phase 3) — the dashboard writes this whenever it flips sidebar
   *  visibility (`0`/`1` keys). Defaults to `"agents"`. */
  sidebarMode: "agents" | "teams" = "agents";
  /** Targets to skip when cycling (e.g., repo-coordinator when not in REPO mode) */
  skipTargets: Set<FocusTarget> = new Set(["repo-coordinator"]);

  constructor(initial: FocusTarget = "agent-tree") {
    this.focus = initial;
  }

  /** Returns the currently focused panel. */
  current(): FocusTarget {
    return this.focus;
  }

  /** Returns true if the given panel has an input field (supports sub-focus). */
  static panelHasInput(target: FocusTarget): boolean {
    return target === "active-agent" || target === "coordinator" || target === "repo-coordinator";
  }

  /** Set the sub-focus state (pane, input, or send). */
  setSubFocus(sf: SubFocus): void {
    this.subFocus = sf;
  }

  /** Cycle focus forward (+1) or backward (-1), wrapping around. Skips targets in skipTargets.
   *  Mode precedence (§17.1 Phase 3): coordinator > teams > agents. When
   *  `coordinatorMode === true`, uses `COORDINATOR_FOCUS_ORDER` regardless of
   *  `sidebarMode`. Otherwise, `sidebarMode === "teams"` uses
   *  `TEAMS_FOCUS_ORDER`; the agents-mode `FOCUS_ORDER` is the default. */
  cycle(delta: 1 | -1): void {
    const order = this.coordinatorMode
      ? COORDINATOR_FOCUS_ORDER
      : this.sidebarMode === "teams"
      ? TEAMS_FOCUS_ORDER
      : FOCUS_ORDER;
    const idx = order.indexOf(this.focus);
    // If current focus is not in the active order, reset to first
    const currentIdx = idx === -1 ? 0 : idx;
    let next = (currentIdx + delta + order.length) % order.length;
    // Skip targets that are in the skip set (guard against infinite loop)
    for (let i = 0; i < order.length; i++) {
      if (!this.skipTargets.has(order[next]!)) break;
      next = (next + delta + order.length) % order.length;
    }
    this.focus = order[next]!;
    this.subFocus = "pane";
  }

  /** Set focus directly to a specific panel. */
  setFocus(target: FocusTarget): void {
    this.focus = target;
    this.subFocus = "pane";
  }
}

/**
 * Render a section separator line with focus-aware styling.
 *
 * Fixed 4-dash left pad, title, remaining dashes on the right, truncated
 * to width.
 *
 * - Focused: title text in reverse+bold, dashes in dim gray (SPEC §13.3)
 * - Unfocused: dim
 */
export function buildFocusSeparator(
  title: string,
  width: number,
  focused: boolean,
): string {
  const leftPad = 4;
  const titleStr = ` ${title} `;
  const rightPad = Math.max(1, width - leftPad - titleStr.length);

  if (focused) {
    return truncateToWidth(
      `${DIM_GRAY}${"─".repeat(leftPad)}${RESET}${REVERSE}${BOLD}${titleStr}${RESET}${DIM_GRAY}${"─".repeat(rightPad)}${RESET}`,
      width,
      "",
    );
  }

  // Unfocused: dim
  return truncateToWidth(
    `${DIM}${DIM_GRAY}${"─".repeat(leftPad)}${RESET}${DIM}${titleStr}${RESET}${DIM}${DIM_GRAY}${"─".repeat(rightPad)}${RESET}`,
    width,
    "",
  );
}

/**
 * Render a tabbed section separator line with multiple labels side-by-side.
 *
 * Layout: 4-dash left pad, then each tab as ` label ` separated by a single
 * dash, with remaining dashes filling to `width`.
 *
 * The `focused` flag on each tab marks which tab is currently SELECTED (the
 * tree being shown). The `paneFocused` argument indicates whether the
 * containing pane currently holds keyboard focus.
 *
 * - Active tab + pane has focus: ` label ` in REVERSE+BOLD (high-contrast).
 * - Active tab + pane unfocused: ` label ` in BG_DIM_GRAY (muted grey
 *   background) so the active tab is still distinguishable from the inactive
 *   one without competing with the dark focus highlight elsewhere.
 * - Inactive tab: ` label ` in DIM.
 * - Dashes (both pads and separators): DIM_GRAY.
 * - When the pane is unfocused: the entire line is wrapped in DIM to match the
 *   unfocused look of buildFocusSeparator (so the header doesn't visually
 *   dominate when focus is elsewhere).
 */
export function buildTabbedFocusSeparator(
  tabs: ReadonlyArray<{ label: string; focused: boolean }>,
  width: number,
  paneFocused: boolean = true,
): string {
  const leftPad = 4;
  // Each tab string takes ` label `. Between tabs we render a single dash.
  // Compute consumed width: leftPad + sum(tab widths) + (tabs.length-1) separators.
  let consumed = leftPad;
  for (let i = 0; i < tabs.length; i++) {
    consumed += tabs[i]!.label.length + 2; // ` label `
    if (i < tabs.length - 1) consumed += 1; // separator dash
  }
  const rightPad = Math.max(1, width - consumed);

  // Build dashes. Dashes are DIM_GRAY in both modes; the outer DIM wrap (when
  // the pane is unfocused) is applied to the entire line for parity with the
  // unfocused buildFocusSeparator look.
  const dashSegment = (n: number) => `${DIM_GRAY}${"─".repeat(n)}${RESET}`;

  const parts: string[] = [];
  parts.push(dashSegment(leftPad));
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const labelStr = ` ${tab.label} `;
    if (tab.focused) {
      // Active tab: high-contrast when the pane has focus, muted grey
      // background when it does not — so the selected tab is still
      // distinguishable without claiming keyboard-focus styling.
      if (paneFocused) {
        parts.push(`${REVERSE}${BOLD}${labelStr}${RESET}`);
      } else {
        parts.push(`${BG_DIM_GRAY}${labelStr}${RESET}`);
      }
    } else {
      parts.push(`${DIM}${labelStr}${RESET}`);
    }
    if (i < tabs.length - 1) {
      parts.push(dashSegment(1));
    }
  }
  parts.push(dashSegment(rightPad));

  const line = parts.join("");
  if (!paneFocused) {
    return truncateToWidth(`${DIM}${line}${RESET}`, width, "");
  }
  return truncateToWidth(line, width, "");
}
