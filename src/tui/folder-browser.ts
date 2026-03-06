/**
 * Folder browser for adding repos — builds the navigable item list
 * from ancestors, current folder, and child directories.
 */

import { join, dirname, sep } from "path";
import { readdirSync, existsSync, statSync } from "fs";

export interface FolderItem {
  path: string;
  name: string;
  depth: number;
  isGit: boolean;
  isAncestor: boolean;
  isCurrent: boolean;
}

/**
 * Build the list of navigable folder items for the folder browser dialog.
 * Returns: ancestors (from / down to parent), current folder, then sorted child dirs.
 */
export function buildFolderItems(currentPath: string): FolderItem[] {
  const items: FolderItem[] = [];

  // Build ancestor chain from root down to parent
  const segments: string[] = [];
  let p = currentPath;
  while (p !== dirname(p)) {
    segments.unshift(p);
    p = dirname(p);
  }
  // Add root
  segments.unshift(p);

  // Ancestors (all except the last, which is currentPath)
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    items.push({
      path: seg,
      name: seg === sep ? sep : seg.split(sep).pop()!,
      depth: i,
      isGit: checkIsGit(seg),
      isAncestor: true,
      isCurrent: false,
    });
  }

  // Current folder
  const currentDepth = segments.length - 1;
  items.push({
    path: currentPath,
    name: currentPath === sep ? sep : currentPath.split(sep).pop()!,
    depth: currentDepth,
    isGit: checkIsGit(currentPath),
    isAncestor: false,
    isCurrent: true,
  });

  // Children: directories only, no hidden, sorted alphabetically
  try {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    const childDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of childDirs) {
      const childPath = join(currentPath, child.name);
      items.push({
        path: childPath,
        name: child.name,
        depth: currentDepth + 1,
        isGit: checkIsGit(childPath),
        isAncestor: false,
        isCurrent: false,
      });
    }
  } catch {
    // Permission denied or unreadable directory — no children
  }

  return items;
}

function checkIsGit(itemPath: string): boolean {
  return existsSync(join(itemPath, ".git"));
}
