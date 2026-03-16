/**
 * Focus management for the TUI dashboard.
 *
 * Tracks which panel currently has focus and provides cycling (Tab / Shift+Tab).
 * See SPEC.md §13 for the full specification.
 */

import { RESET, BOLD, DIM, DIM_GRAY, REVERSE } from "./colors";

/** The three focusable panels in the dashboard. */
export type FocusTarget = "agent-tree" | "coordinator" | "active-agent";

/** Ordered list of focus targets for cycling. */
const FOCUS_ORDER: readonly FocusTarget[] = [
  "agent-tree",
  "coordinator",
  "active-agent",
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

  constructor(initial: FocusTarget = "agent-tree") {
    this.focus = initial;
  }

  /** Returns the currently focused panel. */
  current(): FocusTarget {
    return this.focus;
  }

  /** Cycle focus forward (+1) or backward (-1), wrapping around. */
  cycle(delta: 1 | -1): void {
    const idx = FOCUS_ORDER.indexOf(this.focus);
    const next = (idx + delta + FOCUS_ORDER.length) % FOCUS_ORDER.length;
    this.focus = FOCUS_ORDER[next]!;
  }

  /** Set focus directly to a specific panel. */
  setFocus(target: FocusTarget): void {
    this.focus = target;
  }
}

/**
 * Render a section separator line with focus-aware styling.
 *
 * - Focused: reverse video header text
 * - Unfocused: dim header text
 *
 * The format matches the existing `buildSectionSeparator` in sidebar.ts:
 *   ──── Title ────
 */
export function buildFocusSeparator(
  title: string,
  width: number,
  focused: boolean,
): string {
  const titleStr = ` ${title} `;
  const totalDashes = Math.max(0, width - titleStr.length);
  const leftPad = Math.floor(totalDashes / 2);
  const rightPad = totalDashes - leftPad;

  if (focused) {
    return (
      `${REVERSE}${DIM_GRAY}${"─".repeat(leftPad)}${BOLD}${titleStr}${RESET}${REVERSE}${DIM_GRAY}${"─".repeat(rightPad)}${RESET}`
    );
  }

  // Unfocused: dim
  return (
    `${DIM}${DIM_GRAY}${"─".repeat(leftPad)}${RESET}${DIM}${titleStr}${RESET}${DIM}${DIM_GRAY}${"─".repeat(rightPad)}${RESET}`
  );
}
