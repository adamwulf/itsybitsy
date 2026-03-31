/**
 * Layout persistence — saves and restores panel width/height offsets
 * across ib watch sessions via ~/.itsybitsy/layout.json.
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";

export interface LayoutState {
  sidebarWidth: number;
  splitPaneLeftWidth: number;
  heightOffsets: {
    tree: number;
    info: number;
    coordinator: number;
  };
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
    return {
      sidebarWidth: data.sidebarWidth,
      splitPaneLeftWidth: data.splitPaneLeftWidth,
      heightOffsets: {
        tree: data.heightOffsets.tree,
        info: data.heightOffsets.info,
        coordinator: data.heightOffsets.coordinator,
      },
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
  await Bun.write(layoutPath, JSON.stringify(state, null, 2) + "\n");
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
    pendingState = null;
    saveLayout(state).catch(() => {
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

/** Default tmux width when no layout has been saved. */
export const DEFAULT_TMUX_WIDTH = 80;

/**
 * Read the saved main agent tmux pane width from layout.json.
 * Returns DEFAULT_TMUX_WIDTH if no layout is saved or the value is invalid.
 */
export async function getSavedTmuxWidth(): Promise<number> {
  const layout = await loadLayout();
  return layout?.splitPaneLeftWidth ?? DEFAULT_TMUX_WIDTH;
}

/** Default sidebar width when no layout has been saved. */
export const DEFAULT_SIDEBAR_WIDTH = 60;

/**
 * Read the saved sidebar width from layout.json.
 * Used by the system coordinator to create its tmux session at the correct width.
 * Returns DEFAULT_SIDEBAR_WIDTH if no layout is saved or the value is invalid.
 */
export async function getSavedSidebarWidth(): Promise<number> {
  const layout = await loadLayout();
  return layout?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH;
}
