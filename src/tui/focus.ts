/**
 * Focus management for the TUI dashboard.
 *
 * Tracks which panel currently has focus and provides cycling (Tab / Shift+Tab).
 * See SPEC.md §13 for the full specification.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import { RESET, BOLD, DIM, DIM_GRAY, REVERSE } from "./colors";

/** The six focusable panels in the dashboard. */
export type FocusTarget = "agent-tree" | "info" | "coordinator" | "active-agent" | "right-pane" | "repo-coordinator";

/** Sub-focus states for panels with input fields (active-agent, coordinator). */
export type SubFocus = "pane" | "input" | "send";

/** Ordered list of focus targets for cycling (normal mode). */
const FOCUS_ORDER: readonly FocusTarget[] = [
  "agent-tree",
  "info",
  "coordinator",
  "active-agent",
  "right-pane",
  "repo-coordinator",
] as const;

/** Restricted focus order when system coordinator is selected.
 *  Includes info (sidebar) and coordinator (main area tmux pane). */
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
  /** When true, only cycle between agent-tree and coordinator */
  coordinatorMode = false;
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

  /** Cycle focus forward (+1) or backward (-1), wrapping around. Skips targets in skipTargets. */
  cycle(delta: 1 | -1): void {
    const order = this.coordinatorMode ? COORDINATOR_FOCUS_ORDER : FOCUS_ORDER;
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
