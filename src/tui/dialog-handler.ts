/**
 * Dialog state types, input handling, and shared text-editing helpers.
 * Extracted from dashboard.ts — handles all dialog-type input routing.
 */

import { matchesKey, Key, fuzzyFilter, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { wrapSingleLine } from "./wrap";
import { buildFolderItems } from "./folder-browser";
import type { FolderItem } from "./folder-browser";
import { RESET, BOLD, DIM, REVERSE, GREEN, DIM_GRAY } from "./colors";
import { resolvePasteText, cancelPaste, sanitizePasteForSingleLine } from "./clipboard";
import { TextBuffer, deleteWord } from "./text-buffer";
import { sanitizeAgentNameInput } from "../validation";

export const TEXTAREA_VISIBLE_HEIGHT = 5;
export const FOLDER_BROWSER_HEIGHT = 15;

// Common optional properties shared across all dialog types
type DialogCommon = { width?: number };

// Dialog types for agent actions
export type DialogState =
  | ({ type: "confirm"; prompt: string; confirmLabel: string; focusedButton: "confirm" | "cancel"; confirmColor?: string; onYes: () => void } & DialogCommon)
  | ({ type: "input"; prompt: string; value: string; onSubmit: (value: string) => void; sanitize?: (text: string) => string } & DialogCommon)
  | ({ type: "select"; prompt: string; items: string[]; selectedIndex: number; onSelect: (index: number) => void } & DialogCommon)
  | ({
      type: "multi-select";
      prompt: string;
      items: string[];
      /** Parallel to `items`, same length. true = checked. */
      checked: boolean[];
      selectedIndex: number;
      onSubmit: (checkedIndices: number[]) => void;
      /** Optional callback fired when the dialog is cancelled via Escape (used to
       *  roll back side effects already committed by an earlier wizard step). */
      onCancel?: () => void;
    } & DialogCommon)
  | ({ type: "fuzzy"; prompt: string; query: string; allItems: string[]; filteredIndices: number[]; filteredItems: string[]; selectedIndex: number; onSelect: (originalIndex: number) => void } & DialogCommon)
  | ({ type: "help"; lines: string[] } & DialogCommon)
  | ({
      type: "textarea";
      prompt: string;
      buffer: TextBuffer;
      focusedButton: "text" | "send" | "cancel" | "esc";
      sendAll?: boolean;
      onSubmit: (value: string) => void;
      /** Optional: when set, an extra right-aligned "[ Send Esc ]" button is
       *  rendered. Activating it (Enter while focused) invokes this callback,
       *  which typically sends the Escape key to the agent's tmux session to
       *  interrupt a stuck task. */
      onSendEsc?: () => void;
      /** Optional: invoked when the dialog is cancelled via Escape. Used by
       *  multi-step wizards that need to emit a final status notice on cancel
       *  (the wizard's step-3 "first message" textarea is silent on Esc
       *  otherwise, leaving the user wondering whether the team persisted). */
      onCancel?: () => void;
    } & DialogCommon)
  | ({
      type: "folder-browser";
      currentPath: string;
      items: FolderItem[];
      selectedIndex: number;
      focused: "list" | "add" | "cancel";
      scrollOffset: number;
      onSelect: (path: string) => void;
    } & DialogCommon)
  | ({
      type: "new-agent-form";
      repoName: string;
      name: string;
      agentType: string;
      availableTypes: string[];
      buffer: TextBuffer;
      focused: "name" | "agentType" | "prompt" | "create" | "cancel";
      onSubmit: (name: string, agentType: string, prompt: string) => void;
    } & DialogCommon)
  | ({
      type: "setup";
      tab: number; // 0=Hooks, 1=Config
      items: SetupItem[];
      selectedIndex: number;
      configItems?: ConfigDialogItem[];
      configSelectedIndex?: number;
      onAction: (item: SetupItem) => void;
      onTabChange: (tab: number) => void;
      onConfigAction?: (item: ConfigDialogItem) => void;
    } & DialogCommon)
  | ({
      type: "permissions-editor";
      roleKey: string; // e.g., "permissions.repo"
      tab: 0 | 1; // 0=Allow, 1=Deny
      allowList: string[];
      denyList: string[];
      focus: number; // index in current list; list.length = Add btn; list.length+1 = Done
      inputMode: boolean;
      inputValue: string;
      scrollOffset: number;
      onSave: (allowList: string[], denyList: string[]) => void;
    } & DialogCommon)
  | null;

export type SetupItem = {
  label: string;
  description: string;
  value: string;
  actionable: boolean;
  kind: "safety-hooks" | "intercept-hook";
};

export type ConfigDialogItem = {
  key: string;
  type: "number" | "boolean" | "string" | "string[]";
  value: unknown;
  source: "user" | "default";
  default: unknown;
};

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

/** Wraps items with original indices, filters via pi-tui fuzzyFilter, returns original indices */
type IndexedItem = { text: string; index: number };
export function fuzzyFilterIndices(items: string[], query: string): number[] {
  if (!query) return items.map((_, i) => i);
  const indexed: IndexedItem[] = items.map((text, index) => ({ text, index }));
  const filtered = fuzzyFilter(indexed, query, (item) => item.text);
  return filtered.map((item) => item.index);
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

  // Escape: permissions-editor in input mode exits input mode first.
  // Discard any in-progress chunked paste so its prefix can't leak.
  if (matchesKey(data, Key.escape) && dialog.type === "permissions-editor" && dialog.inputMode) {
    cancelPaste();
    dialog.inputMode = false;
    dialog.inputValue = "";
    ctx.tui?.requestRender();
    return true;
  }

  // Escape cancels any dialog. Discard any in-progress chunked bracketed paste
  // so its buffered prefix can't leak into the next dialog or input field.
  if (matchesKey(data, Key.escape)) {
    cancelPaste();
    // multi-select / textarea support an optional onCancel callback so a
    // wizard step can roll back side effects already committed by an earlier
    // step (the team-creation wizard deletes the just-created team on Esc
    // from step 2) or emit a final status notice on Esc (step 3 textarea —
    // otherwise the wizard vanishes silently after a save the user can't
    // observe).
    if (dialog.type === "multi-select" || dialog.type === "textarea") {
      const onCancel = dialog.onCancel;
      ctx.closeDialog();
      onCancel?.();
      return true;
    }
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
    } else {
      const sanitize = dialog.sanitize;
      const pasteApply = (text: string) => {
        const cleaned = sanitizePasteForSingleLine(text);
        dialog.value += sanitize ? sanitize(cleaned) : cleaned;
        ctx.tui?.requestRender();
      };
      const pasteText = resolvePasteText(data, pasteApply);
      if (pasteText !== null) {
        pasteApply(pasteText);
      } else if (data.length === 1 && data >= " ") {
        dialog.value += sanitize ? sanitize(data) : data;
        ctx.tui?.requestRender();
      }
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

  if (dialog.type === "multi-select") {
    if (matchesKey(data, Key.down) || data === "j") {
      dialog.selectedIndex = Math.min(dialog.items.length - 1, dialog.selectedIndex + 1);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.up) || data === "k") {
      dialog.selectedIndex = Math.max(0, dialog.selectedIndex - 1);
      ctx.tui?.requestRender();
    } else if (data === " ") {
      if (dialog.checked.length > dialog.selectedIndex) {
        dialog.checked[dialog.selectedIndex] = !dialog.checked[dialog.selectedIndex];
        ctx.tui?.requestRender();
      }
    } else if (matchesKey(data, Key.enter)) {
      const indices: number[] = [];
      for (let i = 0; i < dialog.checked.length; i++) {
        if (dialog.checked[i]) indices.push(i);
      }
      dialog.onSubmit(indices);
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

  if (dialog.type === "setup") {
    return handleSetupDialog(ctx, dialog, data);
  }

  if (dialog.type === "permissions-editor") {
    return handlePermissionsEditorDialog(ctx, dialog, data);
  }

  return false;
}

// --- Textarea dialog ---

function handleTextareaDialog(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "textarea" }>,
  data: string
): boolean {
  // Ctrl+A toggles sendAll from any focus position
  if (d.sendAll !== undefined && matchesKey(data, Key.ctrl("a"))) {
    d.sendAll = !d.sendAll;
    ctx.tui?.requestRender();
    return true;
  }

  const onAsyncRender = () => ctx.tui?.requestRender();

  // Forward cycle: text → cancel → send → (esc if enabled) → text
  // Reverse cycle: text → (esc if enabled) → send → cancel → text
  const hasEsc = d.onSendEsc !== undefined;
  const cycleForward: Array<typeof d.focusedButton> = hasEsc
    ? ["text", "cancel", "send", "esc"]
    : ["text", "cancel", "send"];
  const nextFocus = (current: typeof d.focusedButton, dir: 1 | -1): typeof d.focusedButton => {
    const idx = cycleForward.indexOf(current);
    const len = cycleForward.length;
    return cycleForward[((idx + dir) % len + len) % len]!;
  };

  if (d.focusedButton === "text") {
    if (matchesKey(data, Key.tab)) {
      d.focusedButton = nextFocus("text", 1);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.shift("tab"))) {
      d.focusedButton = nextFocus("text", -1);
      ctx.tui?.requestRender();
    } else if (d.buffer.handleInput(data, onAsyncRender)) {
      ctx.tui?.requestRender();
    }
  } else if (d.focusedButton === "send") {
    if (matchesKey(data, Key.enter)) {
      d.onSubmit(d.buffer.getText());
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      d.focusedButton = nextFocus("send", 1);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      d.focusedButton = nextFocus("send", -1);
      ctx.tui?.requestRender();
    } else if (d.buffer.handleInput(data, onAsyncRender)) {
      d.focusedButton = "text";
      ctx.tui?.requestRender();
    }
  } else if (d.focusedButton === "cancel") {
    if (matchesKey(data, Key.enter)) {
      // Same shape as the global Esc branch — close first, THEN invoke
      // onCancel. Required so a wizard step (e.g. step-3 textarea) can emit
      // a final notice on user cancel instead of vanishing silently.
      const onCancel = d.onCancel;
      ctx.closeDialog();
      onCancel?.();
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      d.focusedButton = nextFocus("cancel", 1);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      d.focusedButton = nextFocus("cancel", -1);
      ctx.tui?.requestRender();
    } else if (d.buffer.handleInput(data, onAsyncRender)) {
      d.focusedButton = "text";
      ctx.tui?.requestRender();
    }
  } else if (d.focusedButton === "esc") {
    if (matchesKey(data, Key.enter)) {
      d.onSendEsc?.();
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      d.focusedButton = nextFocus("esc", 1);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      d.focusedButton = nextFocus("esc", -1);
      ctx.tui?.requestRender();
    } else if (d.buffer.handleInput(data, onAsyncRender)) {
      d.focusedButton = "text";
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
  const focusOrder: Array<typeof d.focused> = ["name", "agentType", "prompt", "cancel", "create"];
  const promptEmpty = () => d.buffer.getText().trim().length === 0;
  const onAsyncRender = () => ctx.tui?.requestRender();
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
    } else {
      const namePasteApply = (text: string) => {
        d.name += sanitizeAgentNameInput(text.replace(/[\r\n]/g, "-"));
        ctx.tui?.requestRender();
      };
      const namePaste = resolvePasteText(data, namePasteApply);
      if (namePaste !== null) {
        namePasteApply(namePaste);
      } else if (data.length === 1 && data >= " ") {
        d.name += sanitizeAgentNameInput(data);
        ctx.tui?.requestRender();
      }
    }
  } else if (d.focused === "agentType") {
    if (matchesKey(data, Key.tab)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab"))) { prevFocus(); }
    else if (matchesKey(data, Key.enter) || data === " ") {
      // Cycle through the available agent types
      if (d.availableTypes.length > 0) {
        const currentIdx = d.availableTypes.indexOf(d.agentType);
        const nextIdx = (currentIdx + 1) % d.availableTypes.length;
        d.agentType = d.availableTypes[nextIdx]!;
        ctx.tui?.requestRender();
      }
    }
  } else if (d.focused === "prompt") {
    if (matchesKey(data, Key.tab)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab"))) { prevFocus(); }
    else if (d.buffer.handleInput(data, onAsyncRender)) {
      ctx.tui?.requestRender();
    }
  } else if (d.focused === "create") {
    if (matchesKey(data, Key.enter)) {
      const promptText = d.buffer.getText().trim();
      if (promptText.length > 0) {
        d.onSubmit(d.name, d.agentType, promptText);
      }
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) { prevFocus(); }
    else if (d.buffer.handleInput(data, onAsyncRender)) {
      d.focused = "prompt";
      ctx.tui?.requestRender();
    }
  } else if (d.focused === "cancel") {
    if (matchesKey(data, Key.enter)) { ctx.closeDialog(); }
    else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { nextFocus(); }
    else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) { prevFocus(); }
    else if (d.buffer.handleInput(data, onAsyncRender)) {
      d.focused = "prompt";
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

// --- Setup dialog ---

function handleSetupDialog(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "setup" }>,
  data: string
): boolean {
  // Tab switching: 1/2 number keys, Tab/Shift+Tab
  const TAB_COUNT = 2;
  if (data === "1" && d.tab !== 0) { d.onTabChange(0); return true; }
  if (data === "2" && d.tab !== 1) { d.onTabChange(1); return true; }
  if (data === "\t") { d.onTabChange((d.tab + 1) % TAB_COUNT); return true; }
  if (data === "\x1b[Z") { d.onTabChange((d.tab - 1 + TAB_COUNT) % TAB_COUNT); return true; }

  // Tab 0: existing setup behavior
  if (d.tab === 0) {
    return handleSetupTab0(ctx, d, data);
  }

  // Tab 1: config editing
  return handleSetupConfigTab(ctx, d, data);
}

function handleSetupTab0(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "setup" }>,
  data: string
): boolean {
  const actionableIndices = d.items.map((item, i) => item.actionable ? i : -1).filter((i) => i !== -1);
  if (actionableIndices.length === 0) return true;

  // Find nearest actionable index when current selection isn't actionable
  const snapToNearest = (): number => {
    let best = actionableIndices[0]!;
    for (const idx of actionableIndices) {
      if (Math.abs(idx - d.selectedIndex) < Math.abs(best - d.selectedIndex)) best = idx;
    }
    return best;
  };

  if (matchesKey(data, Key.down) || data === "j") {
    const currentPos = actionableIndices.indexOf(d.selectedIndex);
    if (currentPos === -1) {
      d.selectedIndex = snapToNearest();
    } else if (currentPos < actionableIndices.length - 1) {
      d.selectedIndex = actionableIndices[currentPos + 1]!;
    }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.up) || data === "k") {
    const currentPos = actionableIndices.indexOf(d.selectedIndex);
    if (currentPos === -1) {
      d.selectedIndex = snapToNearest();
    } else if (currentPos > 0) {
      d.selectedIndex = actionableIndices[currentPos - 1]!;
    }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.enter)) {
    const item = d.items[d.selectedIndex];
    if (item && item.actionable) {
      d.onAction(item);
    }
  }
  return true;
}

function handleSetupConfigTab(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "setup" }>,
  data: string
): boolean {
  const items = d.configItems ?? [];
  if (items.length === 0) return true;
  const idx = d.configSelectedIndex ?? 0;

  if (matchesKey(data, Key.down) || data === "j") {
    d.configSelectedIndex = Math.min(items.length - 1, idx + 1);
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.up) || data === "k") {
    d.configSelectedIndex = Math.max(0, idx - 1);
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.enter)) {
    const item = items[idx];
    if (item) {
      d.onConfigAction?.(item);
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
  } else {
    const fuzzyPasteApply = (text: string) => {
      d.query += sanitizePasteForSingleLine(text);
      refilter();
      ctx.tui?.requestRender();
    };
    const fuzzyPaste = resolvePasteText(data, fuzzyPasteApply);
    if (fuzzyPaste !== null) {
      fuzzyPasteApply(fuzzyPaste);
    } else if (data.length === 1 && data >= " ") {
      d.query += data;
      refilter();
      ctx.tui?.requestRender();
    }
  }
  return true;
}

// --- Permissions editor dialog ---

const PERMS_VISIBLE_ROWS = 8;

function handlePermissionsEditorDialog(
  ctx: DialogCtx,
  d: Extract<NonNullable<DialogState>, { type: "permissions-editor" }>,
  data: string
): boolean {
  const currentList = d.tab === 0 ? d.allowList : d.denyList;
  const listCount = currentList.length;
  const maxFocus = listCount + 1; // items + Add + Done

  if (d.inputMode) {
    // Input mode: typing a new tool name
    if (matchesKey(data, Key.enter)) {
      if (d.inputValue.trim()) {
        currentList.push(d.inputValue.trim());
        d.inputValue = "";
      }
      d.inputMode = false;
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.alt("backspace"))) {
      d.inputValue = deleteWord(d.inputValue);
      ctx.tui?.requestRender();
    } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      d.inputValue = d.inputValue.slice(0, -1);
      ctx.tui?.requestRender();
    } else {
      const permPasteApply = (text: string) => {
        d.inputValue += sanitizePasteForSingleLine(text);
        ctx.tui?.requestRender();
      };
      const permPaste = resolvePasteText(data, permPasteApply);
      if (permPaste !== null) {
        permPasteApply(permPaste);
      } else if (data.length === 1 && data >= " ") {
        d.inputValue += data;
        ctx.tui?.requestRender();
      }
    }
    return true;
  }

  // List/navigation mode
  if (matchesKey(data, Key.left)) {
    // Switch to Allow tab
    if (d.tab !== 0) {
      d.tab = 0;
      d.focus = 0;
      d.scrollOffset = 0;
      ctx.tui?.requestRender();
    }
  } else if (matchesKey(data, Key.right)) {
    // Switch to Deny tab
    if (d.tab !== 1) {
      d.tab = 1;
      d.focus = 0;
      d.scrollOffset = 0;
      ctx.tui?.requestRender();
    }
  } else if (matchesKey(data, Key.down) || data === "j") {
    d.focus = Math.min(maxFocus, d.focus + 1);
    // Scroll if needed
    if (d.focus < listCount && d.focus >= d.scrollOffset + PERMS_VISIBLE_ROWS) {
      d.scrollOffset = d.focus - PERMS_VISIBLE_ROWS + 1;
    }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.up) || data === "k") {
    d.focus = Math.max(0, d.focus - 1);
    if (d.focus < d.scrollOffset) {
      d.scrollOffset = d.focus;
    }
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.enter)) {
    if (d.focus < listCount) {
      // Delete item
      currentList.splice(d.focus, 1);
      if (d.focus > 0 && d.focus >= currentList.length) {
        d.focus = Math.max(0, d.focus - 1);
      }
      // Clamp scroll offset after deletion
      d.scrollOffset = Math.min(d.scrollOffset, Math.max(0, currentList.length - PERMS_VISIBLE_ROWS));
      ctx.tui?.requestRender();
    } else if (d.focus === listCount) {
      // Add button — switch to input mode
      d.inputMode = true;
      d.inputValue = "";
      ctx.tui?.requestRender();
    } else {
      // Done button — save and close
      d.onSave(d.allowList, d.denyList);
    }
  } else if (matchesKey(data, Key.tab)) {
    d.focus = (d.focus + 1) % (maxFocus + 1);
    ctx.tui?.requestRender();
  } else if (matchesKey(data, Key.shift("tab"))) {
    d.focus = (d.focus - 1 + maxFocus + 1) % (maxFocus + 1);
    ctx.tui?.requestRender();
  }
  return true;
}

// --- Dialog rendering helpers (used by DialogOverlayComponent) ---

type DialogContent = { title: string; contentLines: string[] };

/** Render the textarea portion shared by textarea and new-agent-form dialogs. */
export function renderTextareaBlock(
  buffer: TextBuffer, innerWidth: number, showCursor: boolean
): { outputLines: string[]; hasScrollIndicator: boolean } {
  const lines = buffer.getLines();
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

/** Max visible rows in the multi-select sliding window. Chosen larger than the
 *  fuzzy dialog's 5 because the user must navigate the full list here, but
 *  small enough that the dialog still fits a typical terminal even with the
 *  scroll indicators. */
export const MULTI_SELECT_MAX_VISIBLE = 10;

/** Build content for the multi-select dialog. Mirrors the `select` rendering
 *  but adds a `[x]` / `[ ]` checkbox prefix to each row so the user can see
 *  which entries are toggled. The highlighted row uses the same `> ` arrow
 *  prefix `select` does so the navigation cue is identical.
 *
 *  A sliding window of at most MULTI_SELECT_MAX_VISIBLE rows is shown, keeping
 *  the selectedIndex visible. When items are hidden above/below, dimmed
 *  `↑ N more` / `↓ N more` indicators render in their place — mirrors the
 *  folder-browser convention. */
export function buildMultiSelectContent(
  dialog: Extract<NonNullable<DialogState>, { type: "multi-select" }>,
  innerWidth: number
): DialogContent {
  const lines: string[] = [`${DIM}(j/k, Space toggles, Enter submits, Esc cancels)${RESET}`];
  const total = dialog.items.length;
  const maxVisible = MULTI_SELECT_MAX_VISIBLE;
  // Sliding window: clamp start so selectedIndex stays in range, and so we
  // don't waste rows past the end when the list is shorter than the window.
  let start = 0;
  if (total > maxVisible) {
    start = Math.max(0, Math.min(dialog.selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
  }
  const end = Math.min(total, start + maxVisible);
  if (start > 0) {
    lines.push(`${DIM}  ↑ ${start} more${RESET}`);
  }
  for (let i = start; i < end; i++) {
    const selected = i === dialog.selectedIndex;
    const arrow = selected ? `${GREEN}> ` : "  ";
    const reset = selected ? RESET : "";
    const box = dialog.checked[i] ? "[x]" : "[ ]";
    lines.push(truncateToWidth(`${arrow}${box} ${dialog.items[i]}${reset}`, innerWidth, ""));
  }
  const remaining = total - end;
  if (remaining > 0) {
    lines.push(`${DIM}  ↓ ${remaining} more${RESET}`);
  }
  return { title: dialog.prompt, contentLines: lines };
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

  const cycleHint = dialog.availableTypes.length > 1
    ? ` ${DIM}[Enter/Space to cycle]${RESET}`
    : "";
  const typeValue = dialog.agentType || "manager";
  const typeLabel = dialog.focused === "agentType"
    ? `${BOLD}${GREEN}Type: ${typeValue}${RESET}${cycleHint}`
    : `${DIM}Type:${RESET} ${typeValue}`;
  lines.push(typeLabel);
  lines.push("");

  const promptLabel = dialog.focused === "prompt" ? `${BOLD}Prompt:${RESET} ${DIM}(required)${RESET}` : `${DIM}Prompt: (required)${RESET}`;
  lines.push(promptLabel);

  const { outputLines, hasScrollIndicator } = renderTextareaBlock(dialog.buffer, innerWidth, dialog.focused === "prompt");
  lines.push(...outputLines);
  if (hasScrollIndicator) { lines.push(`${DIM}↑${RESET}`); }

  const promptText = dialog.buffer.getText().trim();
  const createEnabled = promptText.length > 0;
  const createLabel = dialog.focused === "create"
    ? (createEnabled ? `${BOLD}${GREEN}[ Create ]${RESET}` : `${BOLD}${DIM}[ Create ]${RESET}`)
    : (createEnabled ? `[ Create ]` : `${DIM}[ Create ]${RESET}`);
  const cancelLabel = dialog.focused === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `[ Cancel ]`;
  lines.push(`  ${cancelLabel}   ${createLabel}`);

  return { title: `New Agent (${dialog.repoName})`, contentLines: lines };
}

const SETUP_TAB_NAMES = ["Hooks", "Config"];

/** Build the tab bar for the setup dialog */
function buildTabBar(activeTab: number, innerWidth: number): string {
  const parts: string[] = [];
  for (let i = 0; i < SETUP_TAB_NAMES.length; i++) {
    const name = SETUP_TAB_NAMES[i]!;
    if (i === activeTab) {
      parts.push(`${BOLD}${GREEN}[${name}]${RESET}`);
    } else {
      parts.push(`${DIM}[${name}]${RESET}`);
    }
  }
  return truncateToWidth(parts.join("  "), innerWidth, "");
}

/** Build content for the setup dialog */
export function buildSetupContent(
  dialog: Extract<NonNullable<DialogState>, { type: "setup" }>,
  innerWidth: number
): DialogContent {
  const lines: string[] = [];
  lines.push(buildTabBar(dialog.tab, innerWidth));
  lines.push(`${DIM}(1/2/Tab: tabs, j/k: navigate, Enter: toggle/edit, Esc: close)${RESET}`);
  lines.push("");

  if (dialog.tab === 0) {
    buildSetupTab0Content(dialog, lines, innerWidth);
  } else {
    buildConfigTabContent(dialog, lines, innerWidth);
  }

  return { title: SETUP_TAB_NAMES[dialog.tab] ?? "Setup", contentLines: lines };
}

function buildSetupTab0Content(
  dialog: Extract<NonNullable<DialogState>, { type: "setup" }>,
  lines: string[],
  innerWidth: number
): void {
  for (let i = 0; i < dialog.items.length; i++) {
    const item = dialog.items[i]!;
    const isSelected = i === dialog.selectedIndex;

    // Checkbox items (safety-hooks, intercept-hook)
    const installed = item.value === "installed";
    const partial = item.value === "partial";
    const checkbox = installed ? "[x]" : partial ? "[~]" : "[ ]";
    const label = `${checkbox} ${item.label}`;
    if (isSelected) {
      lines.push(truncateToWidth(`${GREEN}> ${BOLD}${label}${RESET}`, innerWidth, ""));
    } else {
      lines.push(truncateToWidth(`  ${label}`, innerWidth, ""));
    }
    lines.push(truncateToWidth(`  ${DIM}${item.description}${RESET}`, innerWidth, ""));
    lines.push("");
  }
}

function buildConfigTabContent(
  dialog: Extract<NonNullable<DialogState>, { type: "setup" }>,
  lines: string[],
  innerWidth: number
): void {
  const items = dialog.configItems ?? [];
  const selectedIdx = dialog.configSelectedIndex ?? 0;

  if (items.length === 0) {
    lines.push(`${DIM}No configuration keys found${RESET}`);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isSelected = i === selectedIdx;

    let valueStr: string;
    if (item.value === undefined || item.value === null) {
      valueStr = `${DIM}(not set)${RESET}`;
    } else if (item.type === "boolean") {
      valueStr = item.value ? `${GREEN}true${RESET}` : "false";
    } else if (item.type === "string[]") {
      const arr = item.value as string[];
      valueStr = arr.length > 0 ? arr.join(", ") : `${DIM}[]${RESET}`;
    } else {
      valueStr = String(item.value);
    }

    const sourceStr = item.source !== "default"
      ? `${DIM}(${item.source})${RESET}`
      : `${DIM}(default)${RESET}`;

    const label = `${item.key}: ${valueStr} ${sourceStr}`;
    if (isSelected) {
      lines.push(truncateToWidth(`${GREEN}> ${BOLD}${item.key}${RESET}: ${valueStr} ${sourceStr}`, innerWidth, ""));
    } else {
      lines.push(truncateToWidth(`  ${label}`, innerWidth, ""));
    }
  }
}

/** Build content for the permissions editor dialog */
export function buildPermissionsEditorContent(
  dialog: Extract<NonNullable<DialogState>, { type: "permissions-editor" }>,
  innerWidth: number
): DialogContent {
  const lines: string[] = [];

  // Title from roleKey: "permissions.repo" → "Repo Permissions"
  const roleName = dialog.roleKey.split(".").pop() ?? "";
  const title = `${roleName.charAt(0).toUpperCase()}${roleName.slice(1)} Permissions`;

  // Tab bar: Allow / Deny
  const allowTab = dialog.tab === 0
    ? `${BOLD}${GREEN}[Allow]${RESET}`
    : `${DIM}[Allow]${RESET}`;
  const denyTab = dialog.tab === 1
    ? `${BOLD}${GREEN}[Deny]${RESET}`
    : `${DIM}[Deny]${RESET}`;
  lines.push(truncateToWidth(`  ${allowTab}    ${denyTab}    ${DIM}(←/→: switch)${RESET}`, innerWidth, ""));
  lines.push(`${DIM}${"─".repeat(innerWidth)}${RESET}`);

  const currentList = dialog.tab === 0 ? dialog.allowList : dialog.denyList;
  const listCount = currentList.length;

  // Visible window of list items
  let start = dialog.scrollOffset;
  const end = Math.min(listCount, start + PERMS_VISIBLE_ROWS);

  for (let i = start; i < end; i++) {
    const item = currentList[i]!;
    const isFocused = !dialog.inputMode && dialog.focus === i;
    const maxItemWidth = innerWidth - 8;
    const displayItem = item.length > maxItemWidth ? item.slice(0, maxItemWidth - 2) + ".." : item;
    const pad = Math.max(0, innerWidth - displayItem.length - 10);
    if (isFocused) {
      lines.push(truncateToWidth(`${GREEN}> ${BOLD}${displayItem}${RESET}${" ".repeat(pad)}${DIM}[Del]${RESET}`, innerWidth, ""));
    } else {
      lines.push(truncateToWidth(`  ${displayItem}${" ".repeat(pad + 2)}${DIM}[Del]${RESET}`, innerWidth, ""));
    }
  }

  // Pad empty rows
  for (let i = end - start; i < PERMS_VISIBLE_ROWS; i++) {
    lines.push("");
  }

  // Add input field
  const addFocused = !dialog.inputMode && dialog.focus === listCount;
  if (dialog.inputMode) {
    const displayInput = `${dialog.inputValue}█`;
    lines.push(truncateToWidth(`  Add: ${BOLD}${displayInput}${RESET}`, innerWidth, ""));
  } else {
    const addLabel = addFocused
      ? `${GREEN}> ${BOLD}Add:${RESET} ${DIM}(press Enter to type)${RESET}  ${GREEN}${BOLD}[+]${RESET}`
      : `  Add: ${DIM}(press Enter to type)${RESET}  [+]`;
    lines.push(truncateToWidth(addLabel, innerWidth, ""));
  }

  lines.push("");

  // Done button
  const doneFocused = !dialog.inputMode && dialog.focus === listCount + 1;
  const doneLabel = doneFocused
    ? `${BOLD}${GREEN}[ Done ]${RESET}`
    : `[ Done ]`;
  const donePad = Math.max(0, Math.floor((innerWidth - 8) / 2));
  lines.push(`${" ".repeat(donePad)}${doneLabel}`);

  return { title, contentLines: lines };
}
