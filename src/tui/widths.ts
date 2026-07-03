/**
 * Pane width math — single source of truth for the 3-column TUI layout.
 *
 * Layout: [sidebar] │ [middle (split-pane left)] │ [right (split-pane right)]
 *                  ^                            ^
 *                  +-- sidebar separator        +-- inner separator
 *
 * mainWidth = terminalWidth - sidebarWidth - 1   (one separator between sidebar and main area)
 * mainWidth contains: leftPaneWidth + 1 (inner separator) + rightPaneWidth
 *
 * Coordinators (system + per-repo) span the full main area (mainWidth).
 * Regular agents fit in the middle pane only (leftPaneWidth).
 *
 * All pane width math in the codebase MUST go through this module.
 * Never compute widths inline.
 *
 * Naming convention: pure math takes raw arguments and has no prefix
 * (`mainWidth`, `leftPaneWidth`, `rightPaneWidth`, `maxLeftPaneWidth`) —
 * except `tmuxWidthForAgent`, which takes a `LayoutWidths` object so it can
 * serve both saved and live callers via a single dispatch.
 * `getSaved*` is the async, disk-backed family. `getLive*` is the sync,
 * dashboard-state family. Both wrap the same pure math via `LayoutWidths`.
 */
import { SIDEBAR_WIDTH, MIN_SIDEBAR, MAX_SIDEBAR } from "./sidebar";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";
import { loadLayout } from "./layout";

/** Default tmux (split-pane left / middle pane) width when no layout has been saved. */
export const DEFAULT_TMUX_WIDTH = 80;

/**
 * Pinned tmux window width for every agent and coordinator session.
 *
 * Claude Code and codex are full-screen TUIs that hard-wrap their transcript at
 * the tmux WINDOW width with real newlines. `tmux capture-pane -J` can only
 * rejoin tmux's own soft-wraps — it cannot un-wrap a program's hard `\n`. So
 * every time the tmux window width changes, the TUI repaints its whole
 * transcript at the new width, baking duplicate + wrong-width frames into
 * scrollback forever.
 *
 * We break the cycle by pinning the tmux window VERY WIDE and NEVER resizing it
 * to follow the display pane. At this width the TUIs almost never wrap their own
 * prose, so our word-wrap (`src/tui/wrap.ts`) is the single thing that reflows
 * the logical lines to the on-screen pane width at display time. Dragging the
 * middle-pane divider changes only `splitPaneLeftWidth` (the DISPLAY split
 * position); it never touches the tmux window.
 *
 * 1000 was verified as a width claude renders its TUI at without capping (the
 * echoed prompt + reply lines stay single physical rows and the input-box
 * separator chrome spans the full width). If a future CLI is found to cap its
 * render width below this, lower the constant to the measured cap.
 */
export const PINNED_TMUX_WIDTH = 1000;

/** Inputs needed for every layout calculation. */
export interface LayoutWidths {
  /** Full terminal width in columns. */
  terminalWidth: number;
  /** Configured sidebar width. */
  sidebarWidth: number;
  /** Configured split-pane left (middle pane) width. */
  splitPaneLeftWidth: number;
}

// ---------- pure math ----------

/**
 * Width of the main area (middle + inner separator + right combined).
 * Formula: terminalWidth - sidebarWidth - 1 (the sidebar separator).
 */
export function mainWidth(terminalWidth: number, sidebarWidth: number): number {
  return Math.max(1, terminalWidth - sidebarWidth - 1);
}

/**
 * Width of the middle (split-pane left) pane.
 * Clamped so the right pane gets at least 1 column.
 */
export function leftPaneWidth(mw: number, splitPaneLeftWidth: number): number {
  return Math.max(1, Math.min(splitPaneLeftWidth, mw - 2));
}

/**
 * Width of the right pane.
 * Formula: mainWidth - effective leftPaneWidth - 1 (the inner separator).
 */
export function rightPaneWidth(mw: number, splitPaneLeftWidth: number): number {
  return Math.max(1, mw - leftPaneWidth(mw, splitPaneLeftWidth) - 1);
}

/**
 * Maximum permissible split-pane left width given the current mainWidth.
 * Equal to mainWidth - 2 (must leave room for the inner separator and ≥ 1 column for the right pane).
 */
export function maxLeftPaneWidth(mw: number): number {
  return Math.max(1, mw - 2);
}

/**
 * Clamp split-pane left width into [MIN_LEFT_WIDTH, min(MAX_LEFT_WIDTH, maxLeftPaneWidth(mw))].
 * Used after restoring a saved layout against a possibly narrower terminal.
 */
export function clampLeftWidth(mw: number, splitPaneLeftWidth: number): number {
  const upper = Math.min(MAX_LEFT_WIDTH, maxLeftPaneWidth(mw));
  return Math.max(MIN_LEFT_WIDTH, Math.min(upper, splitPaneLeftWidth));
}

/** Clamp a sidebar width to [MIN_SIDEBAR, MAX_SIDEBAR]. */
export function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, width));
}

/**
 * Clamp a saved/incoming split-pane left width to its absolute valid range
 * [MIN_LEFT_WIDTH, MAX_LEFT_WIDTH] without considering current mainWidth. Use
 * `clampLeftWidth(mw, w)` instead when mainWidth is known.
 */
export function clampLeftWidthAbsolute(width: number): number {
  return Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, width));
}

/**
 * Tmux WINDOW width for a spawned/resumed agent OR coordinator.
 *
 * Always `PINNED_TMUX_WIDTH` — every TUI session (regular agent, per-repo
 * coordinator, system coordinator) is pinned to the same very-wide window and is
 * NEVER resized to follow a display pane. See `PINNED_TMUX_WIDTH` for the full
 * rationale. The display split (`splitPaneLeftWidth`) and `mainWidth` govern only
 * how our word-wrap reflows the captured logical lines on screen — they no longer
 * drive the tmux window at all, so the `layout` argument is unused for the width
 * value. It is retained so both saved (`getTmuxWidthForAgent`) and live callers
 * dispatch through one signature.
 */
export function tmuxWidthForAgent(_layout: LayoutWidths, _isCoordinator: boolean): number {
  return PINNED_TMUX_WIDTH;
}

// ---------- saved (disk-backed) wrappers ----------

/** Read terminal width with a sane fallback. */
function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/** Read the saved layout (clamped) for the disk-backed callers. */
async function getSavedLayout(): Promise<LayoutWidths> {
  const layout = await loadLayout();
  return {
    terminalWidth: getTerminalWidth(),
    sidebarWidth: clampSidebarWidth(layout?.sidebarWidth ?? SIDEBAR_WIDTH),
    splitPaneLeftWidth: layout?.splitPaneLeftWidth ?? DEFAULT_TMUX_WIDTH,
  };
}

/** Read the saved sidebar width (clamped). Used by callers outside the dashboard. */
export async function getSavedSidebarWidth(): Promise<number> {
  const l = await getSavedLayout();
  return l.sidebarWidth;
}

// getSavedTmuxWidth was removed with the pinned-tmux-width change: spawn/resume
// no longer read splitPaneLeftWidth for the tmux window (they use
// getTmuxWidthForAgent → PINNED_TMUX_WIDTH). It only lingered as a misleading
// accessor that returned the old clamped split-pane width, not the pin.

/** Read the saved main area width (middle+right combined). */
export async function getSavedMainWidth(): Promise<number> {
  const l = await getSavedLayout();
  return mainWidth(l.terminalWidth, l.sidebarWidth);
}

/**
 * Tmux spawn width for an agent based on saved layout. Coordinators span the
 * full main area; regular agents fit in the middle pane only. All spawn/resume
 * call sites must go through this helper instead of computing tmux widths inline.
 */
export async function getTmuxWidthForAgent(isCoordinator: boolean): Promise<number> {
  const l = await getSavedLayout();
  return tmuxWidthForAgent(l, isCoordinator);
}

// ---------- live (dashboard-state) wrappers ----------

export function getLiveMainWidth(input: LayoutWidths): number {
  return mainWidth(input.terminalWidth, input.sidebarWidth);
}

export function getLiveLeftPaneWidth(input: LayoutWidths): number {
  return leftPaneWidth(getLiveMainWidth(input), input.splitPaneLeftWidth);
}

export function getLiveRightPaneWidth(input: LayoutWidths): number {
  return rightPaneWidth(getLiveMainWidth(input), input.splitPaneLeftWidth);
}
