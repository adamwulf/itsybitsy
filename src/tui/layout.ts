/**
 * Layout persistence — saves and restores panel width/height offsets
 * across ib watch sessions via ~/.itsybitsy/layout.json.
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { mkdir, rename } from "fs/promises";
import { SIDEBAR_WIDTH, MIN_SIDEBAR, MAX_SIDEBAR } from "./sidebar";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";

export { MIN_SIDEBAR, MAX_SIDEBAR };

export interface LayoutState {
  sidebarWidth: number;
  splitPaneLeftWidth: number;
  heightOffsets: {
    tree: number;
    info: number;
    /** @deprecated Coordinator is no longer shown in the sidebar. Preserved for backward compatibility with existing layout.json files. */
    coordinator: number;
  };
  /** Height offset for the repo coordinator split in REPO right pane mode */
  repoCoordinatorHeightOffset?: number;
}

const LAYOUT_PATH = join(homedir(), ".itsybitsy", "layout.json");

/** Overridable path for testing */
let layoutPath = LAYOUT_PATH;

export function setLayoutPath(path: string) {
  layoutPath = path;
}

export function resetLayoutPath() {
  layoutPath = LAYOUT_PATH;
}

export function getLayoutPath(): string {
  return layoutPath;
}

/**
 * Read saved layout from ~/.itsybitsy/layout.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function loadLayout(): Promise<LayoutState | null> {
  try {
    const file = Bun.file(layoutPath);
    if (!(await file.exists())) return null;
    const data = await file.json();
    // Validate shape and reject NaN/Infinity
    const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (
      typeof data !== "object" || data === null ||
      !isFiniteNum(data.sidebarWidth) ||
      !isFiniteNum(data.splitPaneLeftWidth) ||
      typeof data.heightOffsets !== "object" || data.heightOffsets === null ||
      !isFiniteNum(data.heightOffsets.tree) ||
      !isFiniteNum(data.heightOffsets.info) ||
      !isFiniteNum(data.heightOffsets.coordinator)
    ) {
      return null;
    }
    // Optional: repoCoordinatorHeightOffset (added later, may not be in saved file)
    const repoCoordOffset = isFiniteNum(data.repoCoordinatorHeightOffset) ? data.repoCoordinatorHeightOffset : 0;
    return {
      sidebarWidth: Math.round(data.sidebarWidth),
      splitPaneLeftWidth: Math.round(data.splitPaneLeftWidth),
      heightOffsets: {
        tree: Math.round(data.heightOffsets.tree),
        info: Math.round(data.heightOffsets.info),
        coordinator: Math.round(data.heightOffsets.coordinator),
      },
      repoCoordinatorHeightOffset: Math.round(repoCoordOffset),
    };
  } catch {
    return null;
  }
}

/**
 * Save layout to ~/.itsybitsy/layout.json.
 * Creates the directory if it doesn't exist.
 */
export async function saveLayout(state: LayoutState): Promise<void> {
  await mkdir(dirname(layoutPath), { recursive: true });
  const tmpPath = layoutPath + ".tmp";
  await Bun.write(tmpPath, JSON.stringify(state, null, 2) + "\n");
  await rename(tmpPath, layoutPath);
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: LayoutState | null = null;

/**
 * Debounced save — waits 500ms after the last call before writing.
 */
export function saveLayoutDebounced(state: LayoutState): void {
  pendingState = state;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const toSave = pendingState;
    pendingState = null;
    if (toSave) saveLayout(toSave).catch(() => {
      // Silently ignore write errors
    });
  }, 500);
}

/** Cancel any pending debounced save (for cleanup). */
export function cancelPendingSave(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingState = null;
}

/**
 * Flush any pending debounced save immediately (synchronous cancel + async write).
 * Returns a promise that resolves when the write completes.
 * Used on exit to ensure the last layout change is persisted.
 */
export async function flushPendingSave(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingState) {
    const state = pendingState;
    pendingState = null;
    await saveLayout(state);
  }
}

/** Default tmux (split-pane left) width when no layout has been saved. */
export const DEFAULT_TMUX_WIDTH = 80;

/**
 * Read the saved main agent tmux pane width from layout.json.
 * Returns DEFAULT_TMUX_WIDTH if no layout is saved or the value is invalid.
 * Clamps to [MIN_LEFT_WIDTH, MAX_LEFT_WIDTH].
 */
export async function getSavedTmuxWidth(): Promise<number> {
  const layout = await loadLayout();
  const width = layout?.splitPaneLeftWidth ?? DEFAULT_TMUX_WIDTH;
  return Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, width));
}

/**
 * Read the saved sidebar width from layout.json.
 * Returns SIDEBAR_WIDTH if no layout is saved or the value is invalid.
 * Clamps to [MIN_SIDEBAR, MAX_SIDEBAR].
 */
export async function getSavedSidebarWidth(): Promise<number> {
  const layout = await loadLayout();
  const width = layout?.sidebarWidth ?? SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, width));
}

/**
 * Compute the main area width (middle + right panes) based on terminal width
 * and saved sidebar width. Used to size the system coordinator tmux session
 * to match the full width available to the coordinator output.
 * Formula: terminal width - sidebar width - 1 (for separator)
 */
export async function getSavedMainWidth(): Promise<number> {
  const terminalWidth = process.stdout.columns ?? 80;
  const sidebarWidth = await getSavedSidebarWidth();
  return Math.max(1, terminalWidth - sidebarWidth - 1);
}

/**
 * Returns the correct initial tmux `-x` width for a newly spawned (or resumed)
 * agent based on whether it is a coordinator. Coordinators (system + per-repo)
 * span middle + right (`getSavedMainWidth`); regular agents fit in the middle
 * pane only (`getSavedTmuxWidth`). All spawn/resume call sites must go through
 * this helper instead of computing tmux widths inline.
 */
export async function getTmuxWidthForAgent(isCoordinator: boolean): Promise<number> {
  return isCoordinator ? await getSavedMainWidth() : await getSavedTmuxWidth();
}
