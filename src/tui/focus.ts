/**
 * Focus management for the TUI dashboard.
 *
 * Tracks which panel currently has focus and provides cycling (Tab / Shift+Tab).
 * See SPEC.md §13 for the full specification.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import { RESET, BOLD, DIM, DIM_GRAY, REVERSE } from "./colors";

/** The five focusable panels in the dashboard. */
export type FocusTarget = "agent-tree" | "info" | "coordinator" | "active-agent" | "right-pane";

/** Ordered list of focus targets for cycling (normal mode). */
const FOCUS_ORDER: readonly FocusTarget[] = [
  "agent-tree",
  "info",
  "coordinator",
  "active-agent",
  "right-pane",
] as const;

/** Restricted focus order for full-width system coordinator mode. */
const COORDINATOR_FOCUS_ORDER: readonly FocusTarget[] = [
  "agent-tree",
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
  /** When true, only cycle between agent-tree and coordinator */
  coordinatorMode = false;

  constructor(initial: FocusTarget = "agent-tree") {
    this.focus = initial;
  }

  /** Returns the currently focused panel. */
  current(): FocusTarget {
    return this.focus;
  }

  /** Cycle focus forward (+1) or backward (-1), wrapping around. */
  cycle(delta: 1 | -1): void {
    const order = this.coordinatorMode ? COORDINATOR_FOCUS_ORDER : FOCUS_ORDER;
    const idx = order.indexOf(this.focus);
    // If current focus is not in the active order, reset to first
    const currentIdx = idx === -1 ? 0 : idx;
    const next = (currentIdx + delta + order.length) % order.length;
    this.focus = order[next]!;
  }

  /** Set focus directly to a specific panel. */
  setFocus(target: FocusTarget): void {
    this.focus = target;
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
