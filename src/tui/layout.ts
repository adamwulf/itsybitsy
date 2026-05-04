/**
 * Layout persistence — saves and restores panel width/height offsets
 * across ib watch sessions via ~/.itsybitsy/layout.json.
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { mkdir, rename } from "fs/promises";
import { MIN_SIDEBAR, MAX_SIDEBAR } from "./sidebar";

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
  /**
   * Height offset for the per-repo coordinator split in REPO mode. REPO mode
   * renders at full main width (`mainWidth`), with the repo info on top and
   * the coordinator tmux on the bottom — this offset shifts the boundary
   * between those two sections.
   */
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

// Width math (DEFAULT_TMUX_WIDTH, getSavedTmuxWidth, getSavedSidebarWidth,
// getSavedMainWidth, getTmuxWidthForAgent) lives in ./widths.ts. All pane
// width derivations must go through that module — never inline.

