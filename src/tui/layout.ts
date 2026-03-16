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

const LAYOUT_DIR = join(homedir(), ".itsybitsy");
const LAYOUT_PATH = join(LAYOUT_DIR, "layout.json");

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

/**
 * Debounced save — waits 500ms after the last call before writing.
 */
export function saveLayoutDebounced(state: LayoutState): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
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
}
