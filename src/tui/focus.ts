/**
 * Focus management for the TUI dashboard.
 *
 * Tracks which panel currently has focus and provides cycling (Tab / Shift+Tab).
 * See SPEC.md §13 for the full specification.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import { RESET, BOLD, DIM, DIM_GRAY, REVERSE } from "./colors";

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

/** Ordered list of focus targets for cycling (normal mode).
 *  `teams-tree` sits between `agent-tree` and `info` (§17.1) and is ALWAYS an
 *  active stop in normal mode — it is intentionally NOT in `skipTargets`
 *  (toggling into an empty teams registry is still valid; the Teams tree renders
 *  an empty-state line). It is omitted from `COORDINATOR_FOCUS_ORDER` (§17.1). */
const FOCUS_ORDER: readonly FocusTarget[] = [
  "agent-tree",
  "teams-tree",
  "info",
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

/**
 * Render a tabbed section separator line with multiple labels side-by-side.
 *
 * Layout: 4-dash left pad, then each tab as ` label ` separated by a single
 * dash, with remaining dashes filling to `width`.
 *
 * - Focused tab: ` label ` in REVERSE+BOLD (mirrors buildFocusSeparator's
 *   focused branch).
 * - Unfocused tab: ` label ` in DIM.
 * - Dashes (both pads and separators): DIM_GRAY.
 * - When NO tab is focused: the entire line is wrapped in DIM to match the
 *   unfocused look of buildFocusSeparator (so the header doesn't visually
 *   dominate when focus is elsewhere).
 */
export function buildTabbedFocusSeparator(
  tabs: ReadonlyArray<{ label: string; focused: boolean }>,
  width: number,
): string {
  const anyFocused = tabs.some((t) => t.focused);
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
  // no tab is focused) is applied to the entire line for parity with the
  // unfocused buildFocusSeparator look.
  const dashSegment = (n: number) => `${DIM_GRAY}${"─".repeat(n)}${RESET}`;

  const parts: string[] = [];
  parts.push(dashSegment(leftPad));
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const labelStr = ` ${tab.label} `;
    if (tab.focused) {
      parts.push(`${REVERSE}${BOLD}${labelStr}${RESET}`);
    } else {
      parts.push(`${DIM}${labelStr}${RESET}`);
    }
    if (i < tabs.length - 1) {
      parts.push(dashSegment(1));
    }
  }
  parts.push(dashSegment(rightPad));

  const line = parts.join("");
  if (!anyFocused) {
    return truncateToWidth(`${DIM}${line}${RESET}`, width, "");
  }
  return truncateToWidth(line, width, "");
}
