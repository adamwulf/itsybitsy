/**
 * Dialog state types, input handling, and shared text-editing helpers.
 * Extracted from dashboard.ts — handles all dialog-type input routing.
 */

import { matchesKey, Key, fuzzyFilter, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { wrapSingleLine } from "./wrap";
import { buildFolderItems } from "./folder-browser";
import type { FolderItem } from "./folder-browser";

// ANSI escape constants for dialog rendering
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const REVERSE = "\x1b[7m";
const GREEN = "\x1b[32m";
const DIM_GRAY = "\x1b[90m";

export const TEXTAREA_VISIBLE_HEIGHT = 5;
export const FOLDER_BROWSER_HEIGHT = 15;

// Dialog types for agent actions
export type DialogState =
  | { type: "confirm"; prompt: string; confirmLabel: string; focusedButton: "confirm" | "cancel"; confirmColor?: string; onYes: () => void }
  | { type: "input"; prompt: string; value: string; onSubmit: (value: string) => void }
  | { type: "select"; prompt: string; items: string[]; selectedIndex: number; onSelect: (index: number) => void }
  | { type: "fuzzy"; prompt: string; query: string; allItems: string[]; filteredIndices: number[]; filteredItems: string[]; selectedIndex: number; onSelect: (originalIndex: number) => void }
  | { type: "help"; lines: string[] }
  | {
      type: "textarea";
      prompt: string;
      lines: string[];
      focusedButton: "text" | "send" | "cancel";
      onSubmit: (value: string) => void;
    }
  | {
      type: "folder-browser";
      currentPath: string;
      items: FolderItem[];
      selectedIndex: number;
      focused: "list" | "add" | "cancel";
      scrollOffset: number;
      onSelect: (path: string) => void;
    }
  | {
      type: "new-agent-form";
      repoName: string;
      name: string;
      worker: boolean;
      lines: string[];
      focused: "name" | "worker" | "prompt" | "create" | "cancel";
      onSubmit: (name: string, worker: boolean, prompt: string) => void;
    }
  | null;

/** Wrap logical textarea lines into visual lines using ANSI-aware wrapping.
 *  Adds a trailing empty line when the last visual line fills exactly to the width
 *  boundary, so the cursor block has room to render. */
export function wrapTextareaLines(lines: string[], width: number): string[] {
  const result: string[] = [];
  for (const raw of lines) {
    result.push(...wrapSingleLine(raw, width));
  }
  // Ensure cursor has room on the last visual line
  if (result.length > 0 && visibleWidth(result[result.length - 1]!) === width) {
    result.push("");
  }
  return result;
}

/** Delete the last word (or trailing whitespace) from a string. */
export function deleteWord(s: string): string {
  return s.replace(/(?:\s+|\S+)\s*$/, "");
}

/** Wraps items with original indices, filters via pi-tui fuzzyFilter, returns original indices */
type IndexedItem = { text: string; index: number };
export function fuzzyFilterIndices(items: string[], query: string): number[] {
  if (!query) return items.map((_, i) => i);
  const indexed: IndexedItem[] = items.map((text, index) => ({ text, index }));
  const filtered = fuzzyFilter(indexed, query, (item) => item.text);
  return filtered.map((item) => item.index);
}

/**
 * Shared text-editing handler for multiline textarea-like inputs.
 * Handles Enter (new line), backspace (delete char or join lines),
 * Alt-backspace (word delete), and printable character input.
 * Returns true if the input was handled.
 */
export function handleTextEdit(data: string, lines: string[]): boolean {
  if (matchesKey(data, Key.enter) || matchesKey(data, Key.shift("enter"))) {
    lines.push("");
    return true;
  }
  if (matchesKey(data, Key.alt("backspace"))) {
    const lastIdx = lines.length - 1;
    const lastLine = lines[lastIdx] ?? "";
    const trimmed = deleteWord(lastLine);
    if (trimmed.length < lastLine.length) {
      lines[lastIdx] = trimmed;
    } else if (lastIdx > 0) {
      lines.pop();
    }
    return true;
  }
  if (matchesKey(data, Key.backspace) || data === "\x7f") {
    const lastIdx = lines.length - 1;
    const lastLine = lines[lastIdx] ?? "";
    if (lastLine.length > 0) {
      lines[lastIdx] = lastLine.slice(0, -1);
    } else if (lastIdx > 0) {
      lines.pop();
    }
    return true;
  }
  if (data.length === 1 && data >= " ") {
    const lastIdx = lines.length - 1;
    lines[lastIdx] = (lines[lastIdx] ?? "") + data;
    return true;
  }
  return false;
}

/** Minimal context interface for dialog input handling */
export interface DialogCtx {
  _dialog: DialogState;
  repos: ReadonlyArray<{ path: string }>;
  tui: { requestRender(): void } | null;
  closeDialog(): void;
}

/** Handle input when a dialog is active. Returns true if input was consumed. */
export function handleDialogInput(ctx: DialogCtx, data: string): boolean {
  const dialog = ctx._dialog;
  if (!dialog) return false;

  if (dialog.type === "help") {
    // Any key dismisses help
    ctx.closeDialog();
    return true;
  }

  // Escape cancels any dialog
  if (matchesKey(data, Key.escape)) {
    ctx.closeDialog();
    return true;
  }

  if (dialog.type === "confirm") {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      dialog.focusedButton = dialog.focusedButton === "confirm" ? "cancel" : "confirm";
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      if (dialog.focusedButton === "confirm") {
        dialog.onYes();
      } else {
        ctx.closeDialog();
      }
    }
    return true;
  }

  if (dialog.type === "input") {
    if (matchesKey(data, Key.enter)) {
      dialog.onSubmit(dialog.value);
    } else if (matchesKey(data, Key.alt("backspace"))) {
      dialog.value = deleteWord(dialog.value);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      dialog.value = dialog.value.slice(0, -1);
      ctx.tui?.requestRender();
    } else if (data.length === 1 && data >= " ") {
      dialog.value += data;
      ctx.tui?.requestRender();
    }
    return true;
  }

  if (dialog.type === "select") {
    if (matchesKey(data, Key.down) || data === "j") {
      dialog.selectedIndex = Math.min(dialog.items.length - 1, dialog.selectedIndex + 1);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.up) || data === "k") {
      dialog.selectedIndex = Math.max(0, dialog.selectedIndex - 1);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      dialog.onSelect(dialog.selectedIndex);
    }
    return true;
  }

  if (dialog.type === "textarea") {
    return handleTextareaDialog(ctx, dialog, data);
  }

  if (dialog.type === "new-agent-form") {
    return handleNewAgentFormDialog(ctx, dialog, data);
  }

  if (dialog.type === "folder-browser") {
    return handleFolderBrowserDialog(ctx, dialog, data);
  }

  if (dialog.type === "fuzzy") {
    return handleFuzzyDialog(ctx, dialog, data);
  }

  return false;
}

// --- Textarea dialog ---

function handleTextareaDialog(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "textarea" }>,
  data: string
): boolean {
  if (d.focusedButton === "text") {
    if (matchesKey(data, Key.escape)) {
      ctx.closeDialog();
    } else if (matchesKey(data, Key.tab)) {
      d.focusedButton = "cancel";
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.shift("tab"))) {
      d.focusedButton = "send";
      ctx.tui?.requestRender();
    } else if (handleTextEdit(data, d.lines)) {
      ctx.tui?.requestRender();
    }
  } else if (d.focusedButton === "send") {
    if (matchesKey(data, Key.enter)) {
      d.onSubmit(d.lines.join("\n"));
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      d.focusedButton = "text";
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      d.focusedButton = "cancel";
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.escape)) {
      ctx.closeDialog();
    } else if (data.length === 1 && data >= " ") {
      d.focusedButton = "text";
      handleTextEdit(data, d.lines);
      ctx.tui?.requestRender();
    }
  } else if (d.focusedButton === "cancel") {
    if (matchesKey(data, Key.enter)) {
      ctx.closeDialog();
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      d.focusedButton = "send";
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      d.focusedButton = "text";
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.escape)) {
      ctx.closeDialog();
    } else if (data.length === 1 && data >= " ") {
      d.focusedButton = "text";
      handleTextEdit(data, d.lines);
      ctx.tui?.requestRender();
    }
  }
  return true;
}

// --- New agent form dialog ---

function handleNewAgentFormDialog(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "new-agent-form" }>,
  data: string
): boolean {
  const focusOrder: Array<typeof d.focused> = ["name", "worker", "prompt", "cancel", "create"];
  const promptEmpty = () => d.lines.join("\n").trim().length === 0;
  const nextFocus = () => {
    const idx = focusOrder.indexOf(d.focused);
    let next = (idx + 1) % focusOrder.length;
    if (focusOrder[next] === "create" && promptEmpty()) next = (next + 1) % focusOrder.length;
    d.focused = focusOrder[next]!;
    ctx.tui?.requestRender();
  };
  const prevFocus = () => {
    const idx = focusOrder.indexOf(d.focused);
    let prev = (idx - 1 + focusOrder.length) % focusOrder.length;
    if (focusOrder[prev] === "create" && promptEmpty()) prev = (prev - 1 + focusOrder.length) % focusOrder.length;
    d.focused = focusOrder[prev]!;
    ctx.tui?.requestRender();
  };

  if (d.focused === "name") {
    if (matchesKey(data, Key.tab)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab"))) { prevFocus(); }
    else if (matchesKey(data, Key.enter)) { nextFocus(); }
    else if (matchesKey(data, Key.alt("backspace"))) {
      d.name = deleteWord(d.name);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      d.name = d.name.slice(0, -1);
      ctx.tui?.requestRender();
    } else if (data.length === 1 && data >= " ") {
      // Allow only alphanumeric and '-'; replace anything else with '-'
      d.name += /^[a-zA-Z0-9-]$/.test(data) ? data : "-";
      ctx.tui?.requestRender();
    }
  } else if (d.focused === "worker") {
    if (matchesKey(data, Key.tab)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab"))) { prevFocus(); }
    else if (matchesKey(data, Key.enter) || data === " ") {
      d.worker = !d.worker;
      ctx.tui?.requestRender();
    }
  } else if (d.focused === "prompt") {
    if (matchesKey(data, Key.tab)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab"))) { prevFocus(); }
    else if (handleTextEdit(data, d.lines)) {
      ctx.tui?.requestRender();
    }
  } else if (d.focused === "create") {
    if (matchesKey(data, Key.enter)) {
      const promptText = d.lines.join("\n").trim();
      if (promptText.length > 0) {
        d.onSubmit(d.name, d.worker, promptText);
      }
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) { prevFocus(); }
    else if (data.length === 1 && data >= " ") {
      d.focused = "prompt";
      handleTextEdit(data, d.lines);
      ctx.tui?.requestRender();
    }
  } else if (d.focused === "cancel") {
    if (matchesKey(data, Key.enter)) { ctx.closeDialog(); }
    else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) { prevFocus(); }
    else if (data.length === 1 && data >= " ") {
      d.focused = "prompt";
      handleTextEdit(data, d.lines);
      ctx.tui?.requestRender();
    }
  }
  return true;
}

// --- Folder browser dialog ---

function handleFolderBrowserDialog(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "folder-browser" }>,
  data: string
): boolean {
  const registeredPaths = new Set(ctx.repos.map((r) => r.path));
  const selectedItem = d.items[d.selectedIndex];
  const addEnabled = selectedItem?.isGit && !registeredPaths.has(selectedItem.path);

  if (matchesKey(data, Key.down) || data === "j") {
    if (d.focused === "list") {
      d.selectedIndex = Math.min(d.items.length - 1, d.selectedIndex + 1);
      const maxVisible = FOLDER_BROWSER_HEIGHT;
      if (d.selectedIndex >= d.scrollOffset + maxVisible) {
        d.scrollOffset = d.selectedIndex - maxVisible + 1;
      }
    }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.up) || data === "k") {
    if (d.focused === "list") {
      d.selectedIndex = Math.max(0, d.selectedIndex - 1);
      if (d.selectedIndex < d.scrollOffset) {
        d.scrollOffset = d.selectedIndex;
      }
    }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.tab)) {
    if (d.focused === "list") { d.focused = "cancel"; }
    else if (d.focused === "cancel") { d.focused = addEnabled ? "add" : "list"; }
    else { d.focused = "list"; }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.shift("tab"))) {
    if (d.focused === "list") { d.focused = addEnabled ? "add" : "cancel"; }
    else if (d.focused === "add") { d.focused = "cancel"; }
    else { d.focused = "list"; }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.enter)) {
    if (d.focused === "cancel") {
      ctx.closeDialog();
    } else if (d.focused === "add") {
      if (selectedItem?.isGit && !registeredPaths.has(selectedItem.path)) {
        ctx.closeDialog();
        d.onSelect(selectedItem.path);
      }
    } else {
      // Navigate into selected folder
      if (selectedItem) {
        buildFolderItems(selectedItem.path).then((newItems) => {
          const newIdx = newItems.findIndex((i) => i.path === selectedItem.path);
          d.currentPath = selectedItem.path;
          d.items = newItems;
          d.selectedIndex = newIdx !== -1 ? newIdx : 0;
          d.focused = "list";
          d.scrollOffset = Math.max(0, d.selectedIndex - 7);
          ctx.tui?.requestRender();
        });
      }
    }
  }
  return true;
}

// --- Fuzzy dialog ---

function handleFuzzyDialog(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "fuzzy" }>,
  data: string
): boolean {
  const refilter = () => {
    const indices = fuzzyFilterIndices(d.allItems, d.query);
    d.filteredIndices = indices;
    d.filteredItems = indices.map((i) => d.allItems[i]!);
    d.selectedIndex = 0;
  };
  if (matchesKey(data, Key.enter)) {
    if (d.filteredItems.length > 0) {
      const originalIndex = d.filteredIndices[d.selectedIndex] ?? 0;
      d.onSelect(originalIndex);
    }
  } else if (matchesKey(data, Key.down)) {
    if (d.filteredItems.length > 0) {
      d.selectedIndex = Math.min(d.filteredItems.length - 1, d.selectedIndex + 1);
    }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.up)) {
    d.selectedIndex = Math.max(0, d.selectedIndex - 1);
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.alt("backspace"))) {
    d.query = deleteWord(d.query);
    refilter();
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
    d.query = d.query.slice(0, -1);
    refilter();
    ctx.tui?.requestRender();
  } else if (data.length === 1 && data >= " ") {
    d.query += data;
    refilter();
    ctx.tui?.requestRender();
  }
  return true;
}

// --- Dialog rendering helpers (used by DialogOverlayComponent) ---

type DialogContent = { title: string; contentLines: string[] };

/** Render the textarea portion shared by textarea and new-agent-form dialogs */
export function renderTextareaBlock(
  lines: string[], innerWidth: number, showCursor: boolean
): { outputLines: string[]; hasScrollIndicator: boolean } {
  const visibleHeight = TEXTAREA_VISIBLE_HEIGHT;
  const textWidth = innerWidth - 2;
  const visualLines = wrapTextareaLines(lines, textWidth);
  const scrollOffset = Math.max(0, visualLines.length - visibleHeight);
  const outputLines: string[] = [];

  for (let i = 0; i < visibleHeight; i++) {
    const vlIdx = scrollOffset + i;
    if (vlIdx >= visualLines.length) {
      outputLines.push(" ".repeat(innerWidth));
      continue;
    }
    let lineText = visualLines[vlIdx]!;
    if (vlIdx === visualLines.length - 1 && showCursor) {
      lineText = lineText + "█";
    }
    lineText = truncateToWidth(lineText, innerWidth, "");
    const pad = Math.max(0, innerWidth - visibleWidth(lineText));
    outputLines.push(lineText + " ".repeat(pad));
  }

  return { outputLines, hasScrollIndicator: scrollOffset > 0 };
}

/** Build content for the folder-browser dialog */
export function buildFolderBrowserContent(
  dialog: Extract<NonNullable<DialogState>, { type: "folder-browser" }>,
  innerWidth: number,
  registeredPaths: Set<string>
): DialogContent {
  const lines: string[] = [];
  const { items, selectedIndex, focused, scrollOffset } = dialog;

  const maxVisible = FOLDER_BROWSER_HEIGHT;
  let start = scrollOffset;
  if (selectedIndex < start) start = selectedIndex;
  if (selectedIndex >= start + maxVisible) start = selectedIndex - maxVisible + 1;
  let end = Math.min(items.length, start + maxVisible);
  if (start === 1) { start = 0; }
  if (items.length - end === 1 && end - start < maxVisible) { end = items.length; }

  if (start > 0) { lines.push(`${DIM}  ▲ ${start} more${RESET}`); }

  for (let i = start; i < end; i++) {
    const item = items[i]!;
    const isSelected = i === selectedIndex && focused === "list";
    let prefix: string;
    if (item.isAncestor) {
      prefix = item.depth === 0 ? "" : `${DIM}${"    ".repeat(item.depth - 1)}└── ${RESET}`;
    } else if (item.isCurrent) {
      prefix = item.depth === 0 ? "" : `${"    ".repeat(item.depth - 1)}└── `;
    } else {
      const isLast = i === items.length - 1;
      prefix = `${"    ".repeat(item.depth - 1)}${isLast ? "└── " : "├── "}`;
    }
    const isRegistered = registeredPaths.has(item.path);
    const gitSuffix = isRegistered
      ? ` ${DIM}(added)${RESET} ${DIM}✓${RESET}`
      : item.isGit ? ` ${DIM}(git)${RESET} ${GREEN}✓${RESET}` : "";
    const displayName = item.name + "/";
    const nameStr = item.isAncestor ? `${DIM}${displayName}${RESET}` : displayName;
    const line = `${prefix}${nameStr}${gitSuffix}`;

    if (isSelected) {
      const raw = truncateToWidth(`${BOLD} ${line} `, innerWidth, "");
      const pad = Math.max(0, innerWidth - visibleWidth(raw));
      const highlighted = raw.replaceAll(RESET, RESET + REVERSE);
      lines.push(`${REVERSE}${highlighted}${" ".repeat(pad)}${RESET}`);
    } else {
      lines.push(truncateToWidth(` ${line}`, innerWidth, ""));
    }
  }

  const remaining = items.length - end;
  if (remaining > 0) { lines.push(`${DIM}  ▼ ${remaining} more${RESET}`); }
  while (lines.length < FOLDER_BROWSER_HEIGHT + (start > 0 ? 1 : 0) + (remaining > 0 ? 1 : 0)) { lines.push(""); }

  const selectedItem = items[selectedIndex];
  const addEnabled = selectedItem?.isGit && !registeredPaths.has(selectedItem.path);
  const addLabel = focused === "add"
    ? `${BOLD}${GREEN}[ Add ]${RESET}`
    : addEnabled ? `[ Add ]` : `${DIM}[ Add ]${RESET}`;
  const cancelLabel = focused === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `[ Cancel ]`;
  lines.push("");
  lines.push(`  ${cancelLabel}    ${addLabel}`);
  return { title: "Add Repository", contentLines: lines };
}

/** Build content for the new-agent-form dialog */
export function buildNewAgentFormContent(
  dialog: Extract<NonNullable<DialogState>, { type: "new-agent-form" }>,
  innerWidth: number
): DialogContent {
  const lines: string[] = [];

  const nameLabel = dialog.focused === "name" ? `${BOLD}Name:${RESET}` : `${DIM}Name:${RESET}`;
  const nameValue = dialog.focused === "name" ? `${dialog.name}█` : (dialog.name || `${DIM}(optional)${RESET}`);
  lines.push(`${nameLabel}  ${truncateToWidth(nameValue, innerWidth - 8, "")}`);

  const checkbox = dialog.worker ? "[x]" : "[ ]";
  const workerLabel = dialog.focused === "worker"
    ? `${BOLD}${GREEN}${checkbox} Worker${RESET}`
    : `${checkbox} Worker`;
  lines.push(workerLabel);
  lines.push("");

  const promptLabel = dialog.focused === "prompt" ? `${BOLD}Prompt:${RESET} ${DIM}(required)${RESET}` : `${DIM}Prompt: (required)${RESET}`;
  lines.push(promptLabel);

  const { outputLines, hasScrollIndicator } = renderTextareaBlock(dialog.lines, innerWidth, dialog.focused === "prompt");
  lines.push(...outputLines);
  if (hasScrollIndicator) { lines.push(`${DIM}↑${RESET}`); }

  const promptText = dialog.lines.join("\n").trim();
  const createEnabled = promptText.length > 0;
  const createLabel = dialog.focused === "create"
    ? (createEnabled ? `${BOLD}${GREEN}[ Create ]${RESET}` : `${BOLD}${DIM}[ Create ]${RESET}`)
    : (createEnabled ? `[ Create ]` : `${DIM}[ Create ]${RESET}`);
  const cancelLabel = dialog.focused === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `[ Cancel ]`;
  lines.push(`  ${cancelLabel}   ${createLabel}`);

  return { title: `New Agent (${dialog.repoName})`, contentLines: lines };
}
