/**
 * Main TUI dashboard — agent tree + live tmux pane + all keybindings.
 * Composes AgentTree, TmuxPane, RightPane, StatusBar, and dialog system.
 */

import {
  TUI,
  ProcessTerminal,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  fuzzyFilter,
  isKeyRelease,
} from "@mariozechner/pi-tui";
import type { Component, OverlayHandle } from "@mariozechner/pi-tui";
import { loadRegistry } from "../registry";
import type { RepoEntry } from "../registry";
import { AgentWatcher } from "../watcher";
import { TmuxPoller, captureTmuxOutput } from "../tmux-poller";
import { stripAnsi, parseState } from "../parse-state";
import { stat } from "node:fs/promises";
import { readAgentLog, readAgentPrompt, parseDenials } from "../agents";
import type { Agent, FlatAgent, PendingQuestion, DenialEntry } from "../agents";
import { SplitPane } from "./split-pane";
import { wrapLines } from "./wrap";
import {
  killAgent,
  nukeAgent,
  resumeAgent,
  reassignAgent,
  mergeCheckAgent,
  mergeAgent,
  sendMessage,
  newAgent,
  diffAgent,
  statusAgent,
  acknowledgeQuestion,
} from "../ib-commands";
import type { NewAgentOptions } from "../ib-commands";
import { openInGhostty } from "../ghostty";
import { fetchUsage } from "../usage";
import type { UsageData } from "../usage";
import { buildFolderItems } from "./folder-browser";
import type { FolderItem } from "./folder-browser";
import { addRepo } from "../registry";

const MAX_TREE_HEIGHT = 7;
const TEXTAREA_VISIBLE_HEIGHT = 5;
const DIALOG_WIDTH = 60;

/** Wrap logical lines into visual lines of at most `width` characters each.
 *  Adds a trailing empty line when the last logical line fills exactly to the width
 *  boundary, so the cursor block has room to render. */
function wrapTextareaLines(lines: string[], width: number): string[] {
  const result: string[] = [];
  for (const raw of lines) {
    if (raw.length === 0) {
      result.push("");
    } else {
      for (let col = 0; col < raw.length; col += width) {
        result.push(raw.slice(col, col + width));
      }
    }
  }
  // Ensure cursor has room on the last visual line
  if (result.length > 0 && result[result.length - 1]!.length === width) {
    result.push("");
  }
  return result;
}

// ANSI escape constants
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const REVERSE = "\x1b[7m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const DIM_GRAY = "\x1b[90m";
const BRIGHT_BLUE = "\x1b[94m";
const BRIGHT_MAGENTA = "\x1b[95m";

// --- Minimal light/dark terminal detection ---

type ColorScheme = "dark" | "light";
let colorScheme: ColorScheme = "dark";

function getStateColors(): Record<string, string> {
  if (colorScheme === "light") {
    return {
      creating: YELLOW,
      running: GREEN,
      waiting: CYAN,
      complete: BLUE,
      compacting: MAGENTA,
      rate_limited: RED,
      stopped: DIM_GRAY,
      unknown: WHITE,
    };
  }
  // Dark mode: use bright variants for readability
  return {
    creating: YELLOW,
    running: GREEN,
    waiting: CYAN,
    complete: BRIGHT_BLUE,
    compacting: BRIGHT_MAGENTA,
    rate_limited: RED,
    stopped: DIM_GRAY,
    unknown: WHITE,
  };
}

/** Parse an OSC 11 response to extract normalized RGB (0-1). */
function parseOSC11Response(data: string): { r: number; g: number; b: number } | null {
  const match = data.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
  if (!match) return null;
  function normalize(hex: string): number {
    const val = parseInt(hex, 16);
    const max = hex.length <= 2 ? 0xff : 0xffff;
    return val / max;
  }
  return { r: normalize(match[1]!), g: normalize(match[2]!), b: normalize(match[3]!) };
}

/** Compute relative luminance (ITU-R BT.709). */
function computeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Ghostty mode 2031 escape sequences
const GHOSTTY_ENABLE = "\x1b[?2031h";
const GHOSTTY_DISABLE = "\x1b[?2031l";
const GHOSTTY_DARK = "\x1b[?2031;1m";
const GHOSTTY_LIGHT = "\x1b[?2031;2m";
// Focus reporting
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";

/**
 * Set up color scheme detection. Returns:
 * - inputFilter: call before other key handling; returns true if data was consumed
 * - queryColorScheme: send OSC 11 query (call after tui.start() when stdin is raw)
 * - cleanup: disable notifications
 */
function setupColorSchemeDetection(
  onSchemeChange: () => void
): { inputFilter: (data: string) => boolean; queryColorScheme: () => void; cleanup: () => void } {
  let pendingDetection = false;
  let detectionTimer: ReturnType<typeof setTimeout> | null = null;

  function applyScheme(scheme: ColorScheme): void {
    if (scheme !== colorScheme) {
      colorScheme = scheme;
      onSchemeChange();
    }
  }

  function queryColorScheme(): void {
    pendingDetection = true;
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      if (pendingDetection) {
        pendingDetection = false;
      }
    }, 500);
    process.stdout.write("\x1b]11;?\x07");
  }

  process.stdout.write(GHOSTTY_ENABLE);
  process.stdout.write(FOCUS_ENABLE);

  const inputFilter = (data: string): boolean => {
    // OSC 11 response
    if (data.includes("\x1b]11;")) {
      const match = data.match(/\x1b\]11;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
      if (match) {
        const rgb = parseOSC11Response(match[1]!);
        if (rgb) {
          const lum = computeLuminance(rgb.r, rgb.g, rgb.b);
          pendingDetection = false;
          if (detectionTimer) clearTimeout(detectionTimer);
          applyScheme(lum < 0.5 ? "dark" : "light");
        }
      }
      return true;
    }
    // Ghostty dark/light notifications
    if (data === GHOSTTY_DARK || data.includes(GHOSTTY_DARK)) {
      applyScheme("dark");
      return true;
    }
    if (data === GHOSTTY_LIGHT || data.includes(GHOSTTY_LIGHT)) {
      applyScheme("light");
      return true;
    }
    // Focus-in: re-detect
    if (data === FOCUS_IN || data.includes(FOCUS_IN)) {
      queryColorScheme();
      return false; // don't consume — other handlers may want focus events
    }
    return false;
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (detectionTimer) clearTimeout(detectionTimer);
    process.stdout.write(GHOSTTY_DISABLE);
    process.stdout.write(FOCUS_DISABLE);
  };

  return { inputFilter, queryColorScheme, cleanup };
}

// Dialog types for agent actions
type DialogState =
  | { type: "confirm"; prompt: string; onYes: () => void }
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
      addFocused: boolean;
      scrollOffset: number;
      onSelect: (path: string) => void;
    }
  | null;

// Right pane modes
const PANE_MODES = [
  "AGENT LOG",
  "INITIAL PROMPT",
  "DENIALS",
  "TREE",
  "ERRORS",
  "DIFF",
  "QUESTIONS",
  "STATUS",
] as const;
type PaneMode = (typeof PANE_MODES)[number];

const FULL_WIDTH_MODES: Set<PaneMode> = new Set(["DENIALS", "ERRORS", "DIFF", "QUESTIONS"]);

// Denials time filter levels
const DENIAL_FILTERS = ["all", "24h", "7d"] as const;
type DenialFilter = (typeof DENIAL_FILTERS)[number];

const TOP_ANCHORED_MODES: Set<PaneMode> = new Set(["DIFF", "ERRORS", "STATUS", "QUESTIONS"]);

const SCROLL_STEP = 10;
const FOLDER_BROWSER_HEIGHT = 15;

/** Colorize diff output lines */
export function colorizeDiff(lines: string[]): string[] {
  return lines.map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")) {
      return `${DIM}${line}${RESET}`;
    } else if (line.startsWith("+")) {
      return `${GREEN}${line}${RESET}`;
    } else if (line.startsWith("-")) {
      return `${RED}${line}${RESET}`;
    }
    return line;
  });
}

/** Colorize agent log lines — dim timestamps, cyan bracket markers */
export function colorizeLog(lines: string[]): string[] {
  return lines.map((line) => {
    // Dim timestamp prefix like [2026-03-06 12:00:00]
    let result = line.replace(/^(\[\d{4}-[^\]]*\])/, `${DIM}$1${RESET}`);
    // Cyan bracket markers like [PreToolUse], [PostToolUse], etc. (but not the timestamp we already handled)
    result = result.replace(new RegExp(`(?<=${escapeForRegex(RESET)}.*)(\\[[^\\]]+\\])`, "g"), `${CYAN}$1${RESET}`);
    return result;
  });
}

/** Escape a string for use in a RegExp */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps items with original indices, filters via pi-tui fuzzyFilter, returns original indices */
type IndexedItem = { text: string; index: number };
function fuzzyFilterIndices(items: string[], query: string): number[] {
  if (!query) return items.map((_, i) => i);
  const indexed: IndexedItem[] = items.map((text, index) => ({ text, index }));
  const filtered = fuzzyFilter(indexed, query, (item) => item.text);
  return filtered.map((item) => item.index);
}

/** Compute the visible width of the name prefix (connector + icon + repo/id) for an agent row */
function agentNamePrefixWidth(agent: Agent, connector: string): number {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agent.meta.worker ? "⚙" : "◆";
  return visibleWidth(`${connector}${orphanedPrefix}${icon} ${agent.repoName}/${agent.id}`);
}

/** Format agent row for the tree */
function formatAgentRow(
  agent: Agent,
  connector: string,
  selected: boolean,
  width: number,
  nameColWidth: number
): string {
  const orphanedPrefix = agent.orphaned ? "⚠ " : "";
  const icon = agent.meta.worker ? "⚙" : "◆";
  const stateColor = getStateColors()[agent.state] ?? getStateColors().unknown;

  const namePrefix = `${connector}${orphanedPrefix}${icon} ${agent.repoName}/${agent.id}`;
  const namePad = Math.max(0, nameColWidth - visibleWidth(namePrefix));
  const promptText = agent.meta.prompt.replace(/\n/g, " ");
  const line = `${namePrefix}${" ".repeat(namePad)}  ${stateColor}${agent.state}${RESET}  ${agent.age}  ${agent.meta.model}  ${promptText}`;

  const truncated = truncateToWidth(line, width, "");
  if (selected) {
    const pad = width - visibleWidth(truncated);
    return `${REVERSE}${truncated}${RESET}${REVERSE}${pad > 0 ? " ".repeat(pad) : ""}${RESET}`;
  }
  return truncated;
}

/** Agent tree component with height constraint and scrolling */
class AgentTreeComponent implements Component {
  private _flatList: FlatAgent[] = [];
  private selectedIndex = 0;
  maxHeight = MAX_TREE_HEIGHT;
  private scrollOffset = 0;
  private selectedId: string | null = null;

  get flatList(): FlatAgent[] {
    return this._flatList;
  }

  setFlatList(list: FlatAgent[]) {
    this._flatList = list;
    this.resolveSelection();
  }

  get visibleList(): FlatAgent[] {
    return this.flatList.filter((f) => !f.agent.archived);
  }

  get selectedAgent(): Agent | null {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      const item = visible[this.selectedIndex]!;
      if (item.repoHeader) return null;
      return item.agent;
    }
    return null;
  }

  get selectedRepoHeader(): string | null {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      return visible[this.selectedIndex]!.repoHeader ?? null;
    }
    return null;
  }

  /** Select agent by ID. Returns true if found. */
  selectAgentById(agentId: string): boolean {
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.agent.id === agentId);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.selectedId = agentId;
      this.ensureSelectedVisible();
      return true;
    }
    return false;
  }

  moveSelection(delta: number) {
    const visible = this.visibleList;
    if (visible.length === 0) return;
    const len = visible.length;
    this.selectedIndex = ((this.selectedIndex + delta) % len + len) % len;
    this.updateSelectedId();
  }

  /** Update selectedId from current selectedIndex */
  private updateSelectedId() {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      const item = visible[this.selectedIndex]!;
      this.selectedId = item.repoHeader ? `repo:${item.repoHeader}` : item.agent.id;
    }
  }

  /** Re-resolve selectedIndex from selectedId after flatList changes */
  private resolveSelection() {
    const visible = this.visibleList;
    if (visible.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedId === null) {
      this.selectedIndex = 0;
      this.updateSelectedId();
      this.ensureSelectedVisible();
      return;
    }
    const idx = visible.findIndex((f) =>
      f.repoHeader ? `repo:${f.repoHeader}` === this.selectedId : f.agent.id === this.selectedId,
    );
    if (idx !== -1) {
      this.selectedIndex = idx;
    } else {
      // Selected item gone — clamp to valid range
      this.selectedIndex = Math.min(this.selectedIndex, visible.length - 1);
      this.updateSelectedId();
    }
    this.ensureSelectedVisible();
  }

  /** Keep selected index within the visible scroll window with 1-row scroll buffer */
  private ensureSelectedVisible() {
    const lastIndex = this.visibleList.length - 1;

    // Scroll up: keep at least 1 row above selected (unless selected is at very top of list)
    if (this.selectedIndex > 0 && this.selectedIndex - 1 < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex - 1;
    } else if (this.selectedIndex === 0) {
      this.scrollOffset = 0;
    }

    // Scroll down: keep at least 1 row below selected (unless selected is at very bottom of list)
    if (this.selectedIndex < lastIndex && this.selectedIndex + 1 >= this.scrollOffset + this.maxHeight) {
      this.scrollOffset = this.selectedIndex - this.maxHeight + 2;
    } else if (this.selectedIndex === lastIndex && this.selectedIndex >= this.scrollOffset + this.maxHeight) {
      this.scrollOffset = this.selectedIndex - this.maxHeight + 1;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const visible = this.visibleList;
    if (visible.length === 0) {
      return [truncateToWidth(`${DIM}  No agents found${RESET}`, width, "")];
    }

    const lines: string[] = [];
    let start = this.scrollOffset;
    let end = Math.min(visible.length, start + this.maxHeight);

    // If only 1 hidden above, show it instead of a scroll indicator
    if (start === 1) {
      start = 0;
    }

    // If only 1 hidden below, show it instead of a scroll indicator
    if (visible.length - end === 1 && end - start < this.maxHeight) {
      end = visible.length;
    }

    // Compute max name prefix width across all visible agent rows for column alignment
    let maxNameWidth = 0;
    for (const item of visible) {
      if (!item.repoHeader) {
        maxNameWidth = Math.max(maxNameWidth, agentNamePrefixWidth(item.agent, item.connector));
      }
    }

    // Scroll indicator at top
    if (start > 0) {
      lines.push(truncateToWidth(`${DIM}  ▲ ${start} more${RESET}`, width, ""));
    }

    for (let i = start; i < end; i++) {
      const item = visible[i]!;
      if (item.repoHeader) {
        const selected = i === this.selectedIndex;
        const truncated = truncateToWidth(`${BOLD}◆ ${item.repoHeader}${RESET}`, width, "");
        if (selected) {
          const pad = width - visibleWidth(truncated);
          lines.push(`${REVERSE}${truncated}${RESET}${REVERSE}${pad > 0 ? " ".repeat(pad) : ""}${RESET}`);
        } else {
          lines.push(truncated);
        }
      } else {
        lines.push(formatAgentRow(item.agent, item.connector, i === this.selectedIndex, width, maxNameWidth));
      }
    }

    // Scroll indicator at bottom
    const remaining = visible.length - end;
    if (remaining > 0) {
      lines.push(truncateToWidth(`${DIM}  ▼ ${remaining} more${RESET}`, width, ""));
    }

    return lines;
  }
}

/** Right pane content component */
export class RightPaneComponent implements Component {
  mode: PaneMode = "AGENT LOG";
  agent: Agent | null = null;
  selectedRepoHeader: string | null = null;
  questions: PendingQuestion[] = [];
  allAgents: FlatAgent[] = [];
  scrollOffset = 0;
  displayHeight = 20;
  agentLogContent: string[] | null = null;
  promptContent: string[] | null = null;
  denialsContent: DenialEntry[] | null = null;
  denialFilter: DenialFilter = "all";
  errors: string[] = [];
  diffContent: string[] | null = null;
  diffLoading = false;
  statusContent: string[] | null = null;
  statusLoading = false;
  questionsSelectedIndex = 0;
  private content: string[] = [];

  invalidate(): void {}

  setMode(mode: PaneMode) {
    this.mode = mode;
    this.scrollOffset = 0;
    this.updateContent();
  }

  private buildRepoSummary(): string[] {
    const repoName = this.selectedRepoHeader!;
    const repoAgents = this.allAgents.filter(
      (f) => !f.repoHeader && f.agent.repoName === repoName
    );
    const stateCounts = new Map<string, number>();
    for (const { agent } of repoAgents) {
      stateCounts.set(agent.state, (stateCounts.get(agent.state) ?? 0) + 1);
    }

    const lines: string[] = [];
    lines.push(`${BOLD}◆ ${repoName}${RESET}`);
    lines.push("");

    // Find repo path from first agent
    if (repoAgents.length > 0) {
      lines.push(`${DIM}Path:${RESET} ${repoAgents[0]!.agent.repoPath}`);
      lines.push("");
    }

    lines.push(`${BOLD}Agents: ${repoAgents.length}${RESET}`);
    if (stateCounts.size > 0) {
      for (const [state, count] of stateCounts) {
        const stateColor = getStateColors()[state] ?? getStateColors().unknown;
        lines.push(`  ${stateColor}${state}${RESET}: ${count}`);
      }
    }
    return lines;
  }

  updateContent() {
    // When a repo header is selected, show repo summary for agent-specific modes
    if (this.selectedRepoHeader && !this.agent) {
      const agentSpecificModes: Set<PaneMode> = new Set(["AGENT LOG", "INITIAL PROMPT", "DENIALS", "DIFF", "STATUS"]);
      if (agentSpecificModes.has(this.mode)) {
        this.content = this.buildRepoSummary();
        return;
      }
    }

    switch (this.mode) {
      case "AGENT LOG":
        this.content = this.agentLogContent
          ?? (this.agent
            ? [`${DIM}Loading agent.log...${RESET}`]
            : [`${DIM}No agent selected${RESET}`]);
        break;
      case "INITIAL PROMPT":
        if (!this.agent) {
          this.content = [`${DIM}No agent selected${RESET}`];
        } else if (this.promptContent) {
          this.content = [`${BOLD}Prompt:${RESET}`, "", ...this.promptContent];
        } else {
          this.content = [`${DIM}Loading prompt.txt...${RESET}`];
        }
        break;
      case "DENIALS":
        if (!this.agent) {
          this.content = [`${DIM}No agent selected${RESET}`];
        } else if (!this.denialsContent) {
          this.content = [`${DIM}Loading denials...${RESET}`];
        } else {
          const filtered = this.filterDenials(this.denialsContent);
          const filterLabel = this.denialFilter === "all" ? "all time" : `last ${this.denialFilter}`;
          this.content = [`${DIM}Filter: ${filterLabel} (t to cycle)  ${filtered.length} denial(s)${RESET}`];
          if (filtered.length === 0) {
            this.content.push(`${DIM}No denials found${RESET}`);
          } else {
            for (const d of filtered) {
              // Strip timestamp and [PreToolUse] prefix from the line for cleaner display
              const stripped = d.line.replace(/^\[.*?\] \[PreToolUse\] /, "");
              this.content.push(`${DIM}[${d.timestamp}]${RESET} ${stripped}`);
            }
          }
        }
        break;
      case "TREE":
        this.content = this.allAgents.map(({ agent, connector }) => {
          const icon = agent.meta.worker ? "⚙" : "◆";
          const stateColor = getStateColors()[agent.state] ?? getStateColors().unknown;
          const promptText = agent.meta.prompt.replace(/\n/g, " ");
          return `${connector}${icon} ${agent.repoName}/${agent.id}  ${stateColor}${agent.state}${RESET}  ${agent.age}  ${agent.meta.model}  ${promptText}`;
        });
        if (this.content.length === 0) this.content = [`${DIM}No agents${RESET}`];
        break;
      case "ERRORS":
        if (this.errors.length === 0) {
          this.content = [`${DIM}No errors${RESET}`];
        } else {
          this.content = [`${DIM}${this.errors.length} error(s) — press 'c' to clear${RESET}`, ""];
          this.content.push(...this.errors);
        }
        break;
      case "DIFF":
        if (!this.agent) {
          this.content = [`${DIM}No agent selected${RESET}`];
        } else if (this.diffLoading) {
          this.content = [`${DIM}Loading diff...${RESET}`];
        } else if (this.diffContent) {
          this.content = this.diffContent;
        } else {
          this.content = [`${DIM}Loading diff...${RESET}`];
        }
        break;
      case "STATUS":
        if (!this.agent) {
          this.content = [`${DIM}No agent selected${RESET}`];
        } else if (this.statusLoading) {
          this.content = [`${DIM}Loading status...${RESET}`];
        } else if (this.statusContent) {
          this.content = this.statusContent;
        } else {
          this.content = [`${DIM}Loading status...${RESET}`];
        }
        break;
      case "QUESTIONS":
        if (this.questions.length === 0) {
          this.content = [`${DIM}No pending questions${RESET}`];
        } else {
          this.content = [];
          for (let i = 0; i < this.questions.length; i++) {
            const q = this.questions[i]!;
            const sel = i === this.questionsSelectedIndex ? `${GREEN}> ` : "  ";
            const selEnd = i === this.questionsSelectedIndex ? RESET : "";
            const prefix = `${sel}${BOLD}${q.agent}:${RESET} `;
            // First line has the prefix; continuation lines are indented to align
            const indent = "    "; // visual width of "> " or "  " + 2 more
            const selStart = i === this.questionsSelectedIndex ? GREEN : "";
            const fullText = `${prefix}${q.question}${selEnd}`;
            // Split on existing newlines and add as separate content lines
            const textLines = fullText.split("\n");
            this.content.push(textLines[0]!);
            for (let j = 1; j < textLines.length; j++) {
              this.content.push(`${selStart}${indent}${textLines[j]}${selEnd}`);
            }
          }
          this.content.push("", `${DIM}Enter:answer  Esc:acknowledge  g:go to agent${RESET}`);
        }
        break;
    }
  }

  private filterDenials(denials: DenialEntry[]): DenialEntry[] {
    if (this.denialFilter === "all") return denials;
    const now = Math.floor(Date.now() / 1000);
    const cutoff = this.denialFilter === "24h" ? now - 86400 : now - 604800;
    return denials.filter((d) => d.epoch >= cutoff);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = width - 1;

    // Available lines
    const available = Math.max(1, this.displayHeight);
    const maxOffset = Math.max(0, this.content.length - available);
    if (this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }
    let start: number;
    if (TOP_ANCHORED_MODES.has(this.mode)) {
      // Top-anchored: scrollOffset moves view down from top
      start = this.scrollOffset;
    } else {
      // Bottom-anchored: scrollOffset moves view up from tail (0 = tail-snapped)
      start = Math.max(0, this.content.length - available - this.scrollOffset);
    }
    const visible = this.content.slice(start, start + available);
    if (this.mode === "QUESTIONS" || this.mode === "AGENT LOG" || this.mode === "INITIAL PROMPT") {
      // Wrap long lines instead of truncating, but cap to available height
      for (const line of visible) {
        if (lines.length >= this.displayHeight) break;
        const wrapped = wrapLines(line, innerWidth);
        for (const wl of wrapped) {
          if (lines.length >= this.displayHeight) break;
          lines.push(" " + truncateToWidth(wl, innerWidth, ""));
        }
      }
    } else {
      for (const line of visible) {
        lines.push(" " + truncateToWidth(line, innerWidth, ""));
      }
    }

    // Pad to displayHeight so both panes are same height
    while (lines.length < this.displayHeight) {
      lines.push(" ");
    }

    return lines;
  }
}

/**
 * Tmux output pane — shows live tmux capture for the selected agent.
 * Wraps long lines to pane width, supports scroll-back from bottom.
 */
export class TmuxPaneComponent implements Component {
  agent: Agent | null = null;
  rawOutput: string = "";
  /** Whether at least one poll has completed for the current agent */
  hasPolled = false;
  /** Lines scrolled back from the bottom. 0 = following newest output. */
  scrollBack = 0;
  /** Available display height, set by dashboard before render */
  displayHeight = 20;

  invalidate(): void {}

  /** Reset state when switching agents */
  resetForAgent() {
    this.rawOutput = "";
    this.hasPolled = false;
    this.scrollBack = 0;
  }

  scrollUp(amount = 1) {
    this.scrollBack += amount;
  }

  scrollDown(amount = 1) {
    this.scrollBack = Math.max(0, this.scrollBack - amount);
  }

  render(width: number): string[] {
    if (!this.agent) {
      return padLines([truncateToWidth(`${DIM}No agent selected${RESET}`, width, "")], this.displayHeight);
    }

    // Graceful display for stopped/orphaned agents (no tmux session)
    if (this.hasPolled && !this.rawOutput) {
      const stateColor = getStateColors()[this.agent.state] ?? getStateColors().unknown;
      const lines = [
        truncateToWidth(`${BOLD}${this.agent.id}${RESET}`, width, ""),
        truncateToWidth(`${stateColor}${this.agent.state}${RESET}`, width, ""),
        "",
        truncateToWidth(`${DIM}No active tmux session${RESET}`, width, ""),
      ];
      if (this.agent.state === "stopped") {
        lines.push(truncateToWidth(`${DIM}Agent has stopped or been archived.${RESET}`, width, ""));
      } else {
        lines.push(truncateToWidth(`${DIM}Session: ${this.agent.meta.tmux_session}${RESET}`, width, ""));
      }
      return padLines(lines, this.displayHeight);
    }

    if (!this.rawOutput) {
      return padLines([
        truncateToWidth(`${BOLD}${this.agent.id}${RESET} ${DIM}(${this.agent.meta.tmux_session})${RESET}`, width, ""),
        truncateToWidth(`${DIM}Waiting for tmux output...${RESET}`, width, ""),
      ], this.displayHeight);
    }

    // Wrap lines to pane width
    const wrapped = wrapLines(this.rawOutput, width);

    // Clamp scrollBack to valid range
    const maxScrollBack = Math.max(0, wrapped.length - this.displayHeight);
    if (this.scrollBack > maxScrollBack) {
      this.scrollBack = maxScrollBack;
    }

    // Slice visible window from the bottom.
    // Reserve one line for the scroll indicator when scrolled back.
    const contentHeight = this.scrollBack > 0 ? this.displayHeight - 1 : this.displayHeight;
    const end = wrapped.length - this.scrollBack;
    const start = Math.max(0, end - contentHeight);
    const visible = wrapped.slice(start, end);

    // Truncate each line (wrap should already fit, but ensure safety)
    const lines = visible.map((line) => truncateToWidth(line, width, ""));

    // Append scroll indicator when scrolled back (fits within displayHeight)
    if (this.scrollBack > 0) {
      lines.push(truncateToWidth(
        `${DIM}── ↓ ${this.scrollBack} lines below ──${RESET}`,
        width,
        ""
      ));
    }

    return padLines(lines, this.displayHeight);
  }
}

/** Pad lines array to exact height */
function padLines(lines: string[], height: number): string[] {
  while (lines.length < height) {
    lines.push("");
  }
  return lines;
}

/** Status bar component */
class StatusBarComponent implements Component {
  pendingQuestions = 0;
  errorCount = 0;
  usage: UsageData | null = null;
  version = "";

  // FPS tracking: rolling 1-second window
  private renderTimestamps: number[] = [];

  invalidate(): void {}

  /** Record a render timestamp and return current FPS */
  private trackFps(): number {
    const now = Date.now();
    this.renderTimestamps.push(now);
    // Keep only timestamps within the last 1 second
    const cutoff = now - 1000;
    while (this.renderTimestamps.length > 0 && this.renderTimestamps[0]! < cutoff) {
      this.renderTimestamps.shift();
    }
    return this.renderTimestamps.length;
  }

  render(width: number): string[] {
    const fps = this.trackFps();

    // Row 1 left: navigation keys with inline context
    const qLabel = this.pendingQuestions > 0
      ? `q: questions (${this.pendingQuestions})`
      : "q: questions";
    const errBadge = this.errorCount > 0
      ? `  ${BOLD}${RED}[${this.errorCount} errors]${RESET}${DIM}`
      : "";
    const row1Left = `${DIM}j/k: select    ;/l: scroll    p/n: pane    ${qLabel}    s: send    m: merge    Ctrl-C: quit${errBadge}${RESET}`;

    // Row 1 right: usage stats
    const usageStr = this.formatUsage();

    // Row 2 left: secondary/app keys
    const row2Left = `${DIM}@: jump    /: commands    a: new agent    h: help    x: kill    R: resume    r: reassign    w: worktree    G: ghostty${RESET}`;

    // Row 2 right: fps · time · version
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const versionStr = this.version ? `v${this.version}` : "";
    const row2Right = `${DIM}fps: ${fps}  ${timeStr}  ${versionStr}${RESET}`;

    // Compose row 1
    const row1 = this.composeLine(row1Left, usageStr, width);
    // Compose row 2
    const row2 = this.composeLine(row2Left, row2Right, width);

    return [row1, row2];
  }

  private composeLine(left: string, right: string, width: number): string {
    if (!right) return truncateToWidth(left, width, "");
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(right);
    const gap = Math.max(2, width - leftW - rightW);
    return truncateToWidth(left + " ".repeat(gap) + right, width, "");
  }

  private formatUsage(): string {
    if (!this.usage) return "";
    const parts: string[] = [];
    if (this.usage.sessionPct !== null) {
      const pct = this.usage.sessionPct;
      const color = pct > 90 ? RED : pct > 80 ? YELLOW : DIM;
      const reset = this.usage.sessionReset ? ` (${this.usage.sessionReset})` : "";
      parts.push(`${color}session:${pct}%${reset}${RESET}`);
    }
    if (this.usage.weeklyPct !== null) {
      const pct = this.usage.weeklyPct;
      const color = pct > 90 ? RED : pct > 80 ? YELLOW : DIM;
      const reset = this.usage.weeklyReset ? ` (${this.usage.weeklyReset})` : "";
      parts.push(`${color}weekly:${pct}%${reset}${RESET}`);
    }
    return parts.length > 0 ? parts.join("  ") : "";
  }
}

/** Draws the current dialog as a centered bordered box overlay */
class DialogOverlayComponent implements Component {
  private getDialog: () => DialogState;

  constructor(getDialog: () => DialogState) {
    this.getDialog = getDialog;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const dialog = this.getDialog();
    if (!dialog) return [];

    const innerWidth = width - 4; // 2 border + 2 padding
    const { title, contentLines } = this.buildContent(dialog, innerWidth);

    // Build the box
    const lines: string[] = [];
    // Top border with title
    const titleStr = ` ${title} `;
    const topPadding = Math.max(0, width - 3 - visibleWidth(titleStr));
    lines.push(`┌─${BOLD}${titleStr}${RESET}${"─".repeat(topPadding)}┐`);

    // Content lines
    for (const cl of contentLines) {
      const pad = Math.max(0, innerWidth - visibleWidth(cl));
      lines.push(`│  ${cl}${" ".repeat(pad)}│`);
    }

    // Bottom border
    lines.push(`└${"─".repeat(width - 2)}┘`);

    return lines;
  }

  private buildContent(dialog: NonNullable<DialogState>, innerWidth: number): { title: string; contentLines: string[] } {
    switch (dialog.type) {
      case "confirm": {
        const wrapped = wrapLines(dialog.prompt, innerWidth);
        return { title: "Confirm", contentLines: [...wrapped, "", `${DIM}(y/n)${RESET}`] };
      }
      case "input": {
        return {
          title: dialog.prompt,
          contentLines: [truncateToWidth(`> ${dialog.value}█`, innerWidth, "")],
        };
      }
      case "select": {
        const lines: string[] = [`${DIM}(j/k, Enter, Esc)${RESET}`];
        for (let i = 0; i < dialog.items.length; i++) {
          const prefix = i === dialog.selectedIndex ? `${GREEN}> ` : "  ";
          const suffix = i === dialog.selectedIndex ? RESET : "";
          lines.push(truncateToWidth(`${prefix}${dialog.items[i]}${suffix}`, innerWidth, ""));
        }
        return { title: dialog.prompt, contentLines: lines };
      }
      case "fuzzy": {
        const matchCount = dialog.filteredItems.length;
        const headerLine = `${DIM}[${matchCount} matches]${RESET}`;
        const queryLine = truncateToWidth(`> ${dialog.query}█`, innerWidth, "");
        const maxVisible = 5;
        const start = Math.max(0, Math.min(dialog.selectedIndex - maxVisible + 1, dialog.filteredItems.length - maxVisible));
        const visible = dialog.filteredItems.slice(start, start + maxVisible);
        const itemLines = visible.map((item, i) => {
          const actualIndex = start + i;
          const prefix = actualIndex === dialog.selectedIndex ? `${GREEN}> ` : "  ";
          const suffix = actualIndex === dialog.selectedIndex ? RESET : "";
          return truncateToWidth(`${prefix}${item}${suffix}`, innerWidth, "");
        });
        return { title: `${dialog.prompt}`, contentLines: [headerLine, queryLine, ...itemLines] };
      }
      case "help": {
        const lines = dialog.lines.map((line) => truncateToWidth(line, innerWidth, ""));
        return { title: "Help", contentLines: lines };
      }
      case "textarea": {
        const visibleHeight = TEXTAREA_VISIBLE_HEIGHT;
        const lines: string[] = [];
        const textWidth = innerWidth - 2; // right padding to match left padding
        const visualLines = wrapTextareaLines(dialog.lines, textWidth);

        // Always follow the bottom (cursor is always at end)
        const scrollOffset = Math.max(0, visualLines.length - visibleHeight);

        for (let i = 0; i < visibleHeight; i++) {
          const vlIdx = scrollOffset + i;
          if (vlIdx >= visualLines.length) {
            lines.push(" ".repeat(innerWidth));
            continue;
          }
          let lineText = visualLines[vlIdx]!;
          // Show cursor block at end of last visual line when text is focused
          if (vlIdx === visualLines.length - 1 && dialog.focusedButton === "text") {
            lineText = lineText + "█";
          }
          lineText = truncateToWidth(lineText, innerWidth, "");
          const pad = Math.max(0, innerWidth - visibleWidth(lineText));
          lines.push(lineText + " ".repeat(pad));
        }

        // Scroll indicator
        if (scrollOffset > 0) {
          lines.push(`${DIM}↑${RESET}`);
        }

        // Button row
        const sendLabel = dialog.focusedButton === "send" ? `${BOLD}${GREEN}[ Send ]${RESET}` : `${DIM}[ Send ]${RESET}`;
        const cancelLabel = dialog.focusedButton === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `${DIM}[ Cancel ]${RESET}`;
        lines.push(`  ${sendLabel}   ${cancelLabel}`);

        return { title: dialog.prompt, contentLines: lines };
      }
      case "folder-browser": {
        const lines: string[] = [];
        const { items, selectedIndex, addFocused, scrollOffset } = dialog;

        // Compute visible window
        const maxVisible = FOLDER_BROWSER_HEIGHT;
        let start = scrollOffset;
        // Ensure selected item is visible
        if (selectedIndex < start) start = selectedIndex;
        if (selectedIndex >= start + maxVisible) start = selectedIndex - maxVisible + 1;
        let end = Math.min(items.length, start + maxVisible);

        // If only 1 hidden above, show it instead of a scroll indicator
        if (start === 1) {
          start = 0;
        }

        // If only 1 hidden below, show it instead of a scroll indicator
        if (items.length - end === 1 && end - start < maxVisible) {
          end = items.length;
        }

        if (start > 0) {
          lines.push(`${DIM}  ▲ ${start} more${RESET}`);
        }

        for (let i = start; i < end; i++) {
          const item = items[i]!;
          const isSelected = i === selectedIndex && !addFocused;

          // Build indentation with tree connectors
          let prefix: string;
          if (item.isAncestor) {
            if (item.depth === 0) {
              prefix = "";
            } else {
              prefix = `${DIM}${"    ".repeat(item.depth - 1)}└── ${RESET}`;
            }
          } else if (item.isCurrent) {
            if (item.depth === 0) {
              prefix = "";
            } else {
              prefix = `${"    ".repeat(item.depth - 1)}└── `;
            }
          } else {
            // Child items
            const isLast = i === items.length - 1;
            const childPrefix = isLast ? "└── " : "├── ";
            prefix = `${"    ".repeat(item.depth - 1)}${childPrefix}`;
          }

          // Git suffix
          const gitSuffix = item.isGit ? ` ${DIM}(git)${RESET} ${GREEN}✓${RESET}` : "";

          // Name with / suffix for directories
          const displayName = item.name + "/";

          // Ancestor styling
          let nameStr: string;
          if (item.isAncestor) {
            nameStr = `${DIM}${displayName}${RESET}`;
          } else {
            nameStr = displayName;
          }

          const line = `${prefix}${nameStr}${gitSuffix}`;

          if (isSelected) {
            lines.push(truncateToWidth(`${BOLD}${REVERSE} ${line} ${RESET}`, innerWidth, ""));
          } else {
            lines.push(truncateToWidth(` ${line}`, innerWidth, ""));
          }
        }

        const remaining = items.length - end;
        if (remaining > 0) {
          lines.push(`${DIM}  ▼ ${remaining} more${RESET}`);
        }

        // Pad to consistent height
        while (lines.length < FOLDER_BROWSER_HEIGHT + (start > 0 ? 1 : 0) + (remaining > 0 ? 1 : 0)) {
          lines.push("");
        }

        // Button row
        const selectedItem = items[selectedIndex];
        const addEnabled = selectedItem?.isGit ?? false;
        const addLabel = addFocused
          ? `${BOLD}${GREEN}[ Add ]${RESET}`
          : addEnabled
            ? `[ Add ]`
            : `${DIM}[ Add ]${RESET}`;
        const cancelLabel = `${DIM}[ Cancel ]${RESET}`;
        lines.push("");
        lines.push(`  ${addLabel}    ${cancelLabel}`);

        return { title: "Add Repository", contentLines: lines };
      }
    }
  }
}

/** Main dashboard component that composes everything */
export class DashboardComponent implements Component {
  private agentTree: AgentTreeComponent;
  private rightPane: RightPaneComponent;
  private tmuxPane: TmuxPaneComponent;
  private splitPane: SplitPane;
  private statusBar: StatusBarComponent;
  private tui: TUI | null = null;
  private modeIndex = 0;
  private tmuxPoller: TmuxPoller;
  private currentAgentId: string | null = null;
  private _dialog: DialogState = null;
  private overlayHandle: OverlayHandle | null = null;
  private dialogOverlay: DialogOverlayComponent;
  private watcher: AgentWatcher | null = null;
  private repos: RepoEntry[] = [];
  private noticeCounter = 0;
  private diffTool: string | undefined;
  private lastSentNotice: string | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;

  /** Read-only access to dialog state (for testing) */
  get dialog(): DialogState {
    return this._dialog;
  }

  /** Read-only access to header notice (for testing) */
  get notice(): string | null {
    return this.lastSentNotice;
  }

  /** Read-only access to errors (for testing) */
  get errors(): string[] {
    return this.rightPane.errors;
  }

  /** Read-only access to current pane mode (for testing) */
  get currentMode(): PaneMode {
    return this.rightPane.mode;
  }

  /** Read-only access to denial filter (for testing) */
  get denialFilter(): DenialFilter {
    return this.rightPane.denialFilter;
  }

  /** Read-only access to questions selected index (for testing) */
  get questionsSelectedIndex(): number {
    return this.rightPane.questionsSelectedIndex;
  }

  /** Read-only access to selected agent (for testing) */
  get selectedAgent(): Agent | null {
    return this.agentTree.selectedAgent;
  }

  constructor() {
    this.agentTree = new AgentTreeComponent();
    this.rightPane = new RightPaneComponent();
    this.tmuxPane = new TmuxPaneComponent();
    this.statusBar = new StatusBarComponent();
    this.dialogOverlay = new DialogOverlayComponent(() => this._dialog);

    // Split pane: tmux left (~60 cols), right pane on right
    this.splitPane = new SplitPane(this.tmuxPane, this.rightPane, 60);

    // Tmux poller for live output of selected agent
    this.tmuxPoller = new TmuxPoller({
      onOutput: (raw, _stripped) => {
        this.tmuxPane.rawOutput = raw;
        this.tmuxPane.hasPolled = true;
        this.tui?.requestRender();
      },
    });
  }

  setTui(tui: TUI) {
    this.tui = tui;
  }

  startPolling() {
    this.tmuxPoller.start();
    this.refreshUsage();
    this.usageTimer = setInterval(() => this.refreshUsage(), 30_000);
  }

  stopPolling() {
    this.tmuxPoller.stop();
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
  }

  private refreshUsage() {
    fetchUsage()
      .then((data) => {
        this.statusBar.usage = data;
        this.tui?.requestRender();
      })
      .catch(() => {
        // Silently ignore usage fetch errors
      });
  }

  setWatcher(watcher: AgentWatcher) {
    this.watcher = watcher;
  }

  setRepos(repos: RepoEntry[]) {
    this.repos = repos;
  }

  setDiffTool(tool: string | undefined) {
    this.diffTool = tool;
  }

  setVersion(version: string) {
    this.statusBar.version = version;
  }

  /** Add an error to the errors list (called from watcher onError) */
  addError(message: string) {
    const ts = new Date().toLocaleTimeString();
    this.rightPane.errors.push(`${DIM}[${ts}]${RESET} ${message}`);
    this.statusBar.errorCount = this.rightPane.errors.length;
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  /** Clear all errors */
  clearErrors() {
    this.rightPane.errors = [];
    this.statusBar.errorCount = 0;
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  private showDialog(dialog: NonNullable<DialogState>) {
    this._dialog = dialog;
    // Folder browser needs a wider dialog for long paths
    const width = dialog.type === "folder-browser" ? 70 : DIALOG_WIDTH;
    if (width !== DIALOG_WIDTH && this.overlayHandle) {
      // Only recreate overlay when switching to a non-standard width
      this.overlayHandle.hide();
      this.overlayHandle = null;
    }
    if (!this.overlayHandle && this.tui) {
      this.overlayHandle = this.tui.showOverlay(this.dialogOverlay, {
        width,
        anchor: "center",
      });
    }
    this.tui?.requestRender();
  }

  private closeDialog() {
    this._dialog = null;
    this.overlayHandle?.hide();
    this.overlayHandle = null;
    this.tui?.requestRender();
  }

  private setNotice(text: string) {
    const id = ++this.noticeCounter;
    this.lastSentNotice = text;
    this.invalidate();
    this.tui?.requestRender();
    setTimeout(() => {
      if (this.noticeCounter === id) {
        this.lastSentNotice = null;
        this.tui?.requestRender();
      }
    }, 3000);
  }

  private async executeAndRefresh(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.setNotice(`Error: ${err}`);
    }
    this.watcher?.refresh();
  }

  private handleKill() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this.showDialog({
      type: "confirm",
      prompt: `Kill agent ${agent.id}?`,
      onYes: () => {
        this.closeDialog();
        this.executeAndRefresh(async () => {
          const result = await killAgent(agent);
          this.setNotice(result.ok ? `Killed ${agent.id}` : `Kill failed: ${result.stderr || result.stdout}`);
        });
      },
    });
  }

  private handleNuke() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this.showDialog({
      type: "confirm",
      prompt: `${RED}FORCE KILL ${agent.id}? This cannot be undone.${RESET}`,
      onYes: () => {
        this.closeDialog();
        this.executeAndRefresh(async () => {
          const result = await nukeAgent(agent);
          this.setNotice(result.ok ? `Nuked ${agent.id}` : `Nuke failed: ${result.stderr || result.stdout}`);
        });
      },
    });
  }

  private handleResume() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    if (agent.state !== "stopped" && agent.state !== "complete") {
      this.setNotice("Can only resume stopped or complete agents");
      return;
    }
    this.executeAndRefresh(async () => {
      const result = await resumeAgent(agent);
      this.setNotice(result.ok ? `Resumed ${agent.id}` : `Resume failed: ${result.stderr || result.stdout}`);
    });
  }

  private handleReassign() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this.showDialog({
      type: "input",
      prompt: `Reassign ${agent.id} to manager:`,
      value: "",
      onSubmit: (newManager: string) => {
        this.closeDialog();
        if (!newManager.trim()) {
          this.setNotice("Reassign cancelled");
          return;
        }
        this.executeAndRefresh(async () => {
          const result = await reassignAgent(agent, newManager.trim());
          this.setNotice(result.ok ? `Reassigned ${agent.id} → ${newManager.trim()}` : `Reassign failed: ${result.stderr || result.stdout}`);
        });
      },
    });
  }

  private handleMerge() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this.setNotice(`Running merge-check for ${agent.id}...`);
    mergeCheckAgent(agent).then((checkResult) => {
      const checkOutput = checkResult.stdout || checkResult.stderr || "(no output)";
      if (!checkResult.ok) {
        this.setNotice(`Merge-check failed for ${agent.id}: ${checkOutput}`);
        return;
      }
      this.showDialog({
        type: "confirm",
        prompt: `Merge ${agent.id}?\n${checkOutput}`,
        onYes: () => {
          this.closeDialog();
          this.executeAndRefresh(async () => {
            const result = await mergeAgent(agent);
            this.setNotice(result.ok ? `Merged ${agent.id}` : `Merge failed: ${result.stderr || result.stdout}`);
          });
        },
      });
    }).catch((err) => {
      this.setNotice(`Merge-check error: ${err}`);
    });
  }

  private handleSend() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this.showDialog({
      type: "textarea",
      prompt: `Send message to ${agent.id}:`,
      lines: [""],
      focusedButton: "text",
      onSubmit: (message: string) => {
        this.closeDialog();
        if (!message.trim()) {
          this.setNotice("Send cancelled");
          return;
        }
        this.executeAndRefresh(async () => {
          const result = await sendMessage(agent, message.trim());
          this.setNotice(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
        });
      },
    });
  }

  private handleNewAgent() {
    if (this.repos.length === 0) {
      this.setNotice("No repos registered");
      return;
    }
    // Single-repo shortcut: skip repo selection
    if (this.repos.length === 1) {
      this.showNewAgentPromptDialog(this.repos[0]!);
      return;
    }
    // Step 1: select repo
    this.showDialog({
      type: "select",
      prompt: "Select repo for new agent:",
      items: this.repos.map((r) => `${r.name} (${r.path})`),
      selectedIndex: 0,
      onSelect: (repoIndex: number) => {
        this.showNewAgentPromptDialog(this.repos[repoIndex]!);
      },
    });
  }

  private showNewAgentPromptDialog(repo: RepoEntry) {
    this.showDialog({
      type: "input",
      prompt: `New agent prompt (repo: ${repo.name}):`,
      value: "",
      onSubmit: (prompt: string) => {
        if (!prompt.trim()) {
          this.closeDialog();
          this.setNotice("New agent cancelled");
          return;
        }
        this.showNewAgentFlagsDialog(repo, prompt.trim());
      },
    });
  }

  private showNewAgentFlagsDialog(repo: RepoEntry, prompt: string) {
    this.showDialog({
      type: "select",
      prompt: "Agent type:",
      items: [
        "Manager (default)",
        "Worker (--worker)",
        "Manager + YOLO (--yolo)",
        "Worker + YOLO (--worker --yolo)",
      ],
      selectedIndex: 0,
      onSelect: (flagIndex: number) => {
        this.closeDialog();
        const opts: NewAgentOptions = {};
        if (flagIndex === 1 || flagIndex === 3) opts.worker = true;
        if (flagIndex === 2 || flagIndex === 3) opts.yolo = true;
        this.executeAndRefresh(async () => {
          const result = await newAgent(repo.path, prompt, opts);
          this.setNotice(result.ok ? `Created new agent in ${repo.name}` : `New agent failed: ${result.stderr || result.stdout}`);
        });
      },
    });
  }

  private handleAnswerQuestion() {
    const questions = this.rightPane.questions;
    const idx = this.rightPane.questionsSelectedIndex;
    if (idx < 0 || idx >= questions.length) return;
    const q = questions[idx]!;
    // Find the agent for this question to get repoPath
    const agentEntry = this.agentTree.flatList.find((f) => f.agent.id === q.agent);
    if (!agentEntry) {
      this.setNotice(`Agent ${q.agent} not found`);
      return;
    }
    this.showDialog({
      type: "textarea",
      prompt: `Answer ${q.agent}'s question:`,
      lines: [""],
      focusedButton: "text",
      onSubmit: (answer: string) => {
        this.closeDialog();
        if (!answer.trim()) {
          this.setNotice("Answer cancelled");
          return;
        }
        this.executeAndRefresh(async () => {
          const ackResult = await acknowledgeQuestion(agentEntry.agent.repoPath, q.id);
          if (!ackResult.ok) {
            this.setNotice(`Acknowledge failed: ${ackResult.stderr || ackResult.stdout}`);
            return;
          }
          const sendResult = await sendMessage(agentEntry.agent, answer.trim());
          this.setNotice(sendResult.ok ? `Answered ${q.agent}` : `Send failed: ${sendResult.stderr || sendResult.stdout}`);
        });
      },
    });
  }

  private handleAcknowledgeQuestion() {
    const questions = this.rightPane.questions;
    const idx = this.rightPane.questionsSelectedIndex;
    if (idx < 0 || idx >= questions.length) return;
    const q = questions[idx]!;
    const agentEntry = this.agentTree.flatList.find((f) => f.agent.id === q.agent);
    if (!agentEntry) {
      this.setNotice(`Agent ${q.agent} not found`);
      return;
    }
    this.executeAndRefresh(async () => {
      const result = await acknowledgeQuestion(agentEntry.agent.repoPath, q.id);
      this.setNotice(result.ok ? `Acknowledged ${q.id}` : `Acknowledge failed: ${result.stderr || result.stdout}`);
    });
  }

  private handleGoToQuestionAgent() {
    const questions = this.rightPane.questions;
    const idx = this.rightPane.questionsSelectedIndex;
    if (idx < 0 || idx >= questions.length) return;
    const q = questions[idx]!;
    if (this.agentTree.selectAgentById(q.agent)) {
      this.syncSelectedAgent();
      this.jumpToMode("AGENT LOG");
      this.tui?.requestRender();
    } else {
      this.setNotice(`Agent ${q.agent} not found in tree`);
    }
  }

  private handleFuzzyAgent() {
    const visible = this.agentTree.visibleList;
    if (visible.length === 0) {
      this.setNotice("No agents to search");
      return;
    }
    const allItems = visible.map((f) => {
      const promptText = f.agent.meta.prompt.replace(/\n/g, " ");
      return `${f.agent.repoName}/${f.agent.id}  ${f.agent.state}  ${promptText}`;
    });
    this.showDialog({
      type: "fuzzy",
      prompt: "Jump to agent",
      query: "",
      allItems,
      filteredIndices: allItems.map((_, i) => i),
      filteredItems: [...allItems],
      selectedIndex: 0,
      onSelect: (originalIndex: number) => {
        this.closeDialog();
        const agent = visible[originalIndex]!;
        this.agentTree.selectAgentById(agent.agent.id);
        this.syncSelectedAgent();
        this.jumpToMode("AGENT LOG");
        this.tui?.requestRender();
      },
    });
  }

  private handleCommandPalette() {
    type Command = { label: string; action: () => void };
    const commands: Command[] = [
      // Pane modes
      { label: "AGENT LOG — show agent log", action: () => this.jumpToMode("AGENT LOG") },
      { label: "INITIAL PROMPT — show initial prompt", action: () => this.jumpToMode("INITIAL PROMPT") },
      { label: "DENIALS — show tool denials", action: () => this.jumpToMode("DENIALS") },
      { label: "TREE — show full agent tree", action: () => this.jumpToMode("TREE") },
      { label: "ERRORS — show errors", action: () => this.jumpToMode("ERRORS") },
      { label: "DIFF — run ib diff", action: () => this.jumpToMode("DIFF", true) },
      { label: "STATUS — run ib status", action: () => this.jumpToMode("STATUS", true) },
      { label: "QUESTIONS — show pending questions", action: () => this.jumpToMode("QUESTIONS") },
      // Agent actions
      { label: "send message — s", action: () => this.handleSend() },
      { label: "merge agent — m", action: () => this.handleMerge() },
      { label: "kill agent — x", action: () => this.handleKill() },
      { label: "force kill agent — !", action: () => this.handleNuke() },
      { label: "resume agent — R", action: () => this.handleResume() },
      { label: "reassign manager — r", action: () => this.handleReassign() },
      { label: "new agent — a", action: () => this.handleNewAgent() },
      { label: "open worktree — w", action: () => this.handleOpenWorktree() },
      { label: "open diff in tool — o", action: () => this.handleOpenDiffTool() },
      { label: "open in Ghostty — G", action: () => this.handleOpenGhostty() },
      { label: "debug snapshot — S", action: () => this.handleSnapshot() },
      // Navigation
      { label: "fuzzy jump to agent — @", action: () => this.handleFuzzyAgent() },
      { label: "help — h", action: () => this.handleHelp() },
      { label: "scroll up — ;", action: () => this.handleScrollUp() },
      { label: "scroll down — l", action: () => this.handleScrollDown() },
    ];

    const allItems = commands.map((c) => c.label);
    this.showDialog({
      type: "fuzzy",
      prompt: "Command palette",
      query: "",
      allItems,
      filteredIndices: allItems.map((_, i) => i),
      filteredItems: [...allItems],
      selectedIndex: 0,
      onSelect: (originalIndex: number) => {
        this.closeDialog();
        commands[originalIndex]!.action();
        this.tui?.requestRender();
      },
    });
  }

  private handleScrollUp() {
    this.tmuxPane.scrollUp(SCROLL_STEP);
    this.rightPane.scrollOffset += SCROLL_STEP;
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  private handleScrollDown() {
    this.tmuxPane.scrollDown(SCROLL_STEP);
    this.rightPane.scrollOffset = Math.max(0, this.rightPane.scrollOffset - SCROLL_STEP);
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  private handleOpenWorktree() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) {
      this.setNotice("No agent selected");
      return;
    }
    const dir = agent.archived ? "archive" : "agents";
    let worktreePath: string;
    if (agent.meta.worktree === false) {
      worktreePath = agent.repoPath;
    } else {
      worktreePath = `${agent.repoPath}/.ittybitty/${dir}/${agent.id}/repo`;
    }
    // Check if worktree path exists (it's a directory, so use fs.stat), fall back to repoPath
    (async () => {
      try {
        let pathToOpen = worktreePath;
        try {
          const s = await stat(worktreePath);
          if (!s.isDirectory()) pathToOpen = agent.repoPath;
        } catch {
          pathToOpen = agent.repoPath;
        }
        await Bun.$`open ${pathToOpen}`.quiet();
        this.setNotice(`Opened ${pathToOpen}`);
      } catch (err) {
        this.setNotice(`Failed to open worktree: ${err}`);
      }
    })();
  }

  private handleOpenDiffTool() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) {
      this.setNotice("No agent selected");
      return;
    }
    if (!this.diffTool) {
      this.setNotice("No diff tool configured — set diffTool in ~/.itsybitsy.json");
      return;
    }
    const tool = this.diffTool;
    this.setNotice("Loading diff...");
    diffAgent(agent).then(async (result) => {
      try {
        const output = result.stdout || result.stderr || "(no output)";
        const tmpPath = `/tmp/itsybitsy-diff-${agent.id}.txt`;
        await Bun.write(tmpPath, output);
        const parts = tool.split(" ");
        Bun.spawn([...parts, tmpPath], { cwd: agent.repoPath });
        this.setNotice(`Opened diff in ${tool}`);
      } catch (err) {
        this.setNotice(`Failed to open diff: ${err}`);
      }
    }).catch((err) => {
      this.setNotice(`Diff error: ${err}`);
    });
  }

  private handleHelp() {
    this.showDialog({
      type: "help",
      lines: [
        `${BOLD}Keybindings${RESET}`,
        "",
        `${BOLD}Navigation:${RESET} j/k ↑↓ move  ${DIM}|${RESET}  @ fuzzy agent  ${DIM}|${RESET}  / fuzzy mode`,
        `${BOLD}Pane:${RESET} p/n ←→ cycle  ${DIM}|${RESET}  d DIFF  ${DIM}|${RESET}  g STATUS  ${DIM}|${RESET}  e ERRORS  ${DIM}|${RESET}  q QUESTIONS`,
        `${BOLD}Scroll:${RESET} ; scroll up  ${DIM}|${RESET}  l scroll down`,
        `${BOLD}Actions:${RESET} s send  ${DIM}|${RESET}  m merge  ${DIM}|${RESET}  x kill  ${DIM}|${RESET}  ! nuke  ${DIM}|${RESET}  R resume  ${DIM}|${RESET}  r reassign  ${DIM}|${RESET}  a new`,
        `${BOLD}Open:${RESET} w worktree  ${DIM}|${RESET}  o diff tool  ${DIM}|${RESET}  G Ghostty  ${DIM}|${RESET}  S snapshot`,
        `${BOLD}App:${RESET} h help  ${DIM}|${RESET}  Ctrl-C quit`,
        "",
        `${DIM}Press any key to dismiss${RESET}`,
      ],
    });
  }

  private handleOpenGhostty() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) {
      this.setNotice("No agent selected");
      return;
    }
    if (!agent.meta.tmux_session) {
      this.setNotice("No active tmux session");
      return;
    }
    openInGhostty(agent.meta.tmux_session).then((result) => {
      this.setNotice(result.message);
    }).catch((err) => {
      this.setNotice(`Ghostty error: ${err}`);
    });
  }

  private handleSnapshot() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) {
      this.setNotice("No agent selected");
      return;
    }
    captureTmuxOutput(agent.meta.tmux_session).then(async (rawOutput) => {
      try {
        if (!rawOutput) {
          this.setNotice("No tmux output captured");
          return;
        }
        const stripped = stripAnsi(rawOutput);
        const result = parseState(stripped);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `snapshot-${timestamp}-${result.state}.txt`;
        const dir = agent.archived ? "archive" : "agents";
        const debugDir = `${agent.repoPath}/.ittybitty/${dir}/${agent.id}/debug-logs`;
        await Bun.$`mkdir -p ${debugDir}`.quiet();
        await Bun.write(
          `${debugDir}/${filename}`,
          `State: ${result.state}\nReason: ${result.reason}\n\n${rawOutput}`
        );
        this.setNotice(`Snapshot saved: ${filename} (state: ${result.state})`);
      } catch (err) {
        this.setNotice(`Snapshot error: ${err}`);
      }
    }).catch((err) => {
      this.setNotice(`Snapshot error: ${err}`);
    });
  }

  private handleFolderBrowser() {
    const startPath = process.cwd();
    const items = buildFolderItems(startPath);
    const currentIdx = items.findIndex((i) => i.isCurrent);
    this.showDialog({
      type: "folder-browser",
      currentPath: startPath,
      items,
      selectedIndex: currentIdx !== -1 ? currentIdx : 0,
      addFocused: false,
      scrollOffset: Math.max(0, (currentIdx !== -1 ? currentIdx : 0) - 7),
      onSelect: (path: string) => {
        addRepo(path).then((result) => {
          this.setNotice(result.message);
          if (result.ok) {
            this.watcher?.refresh();
          }
        }).catch((err) => {
          this.setNotice(`Error adding repo: ${err}`);
        });
      },
    });
  }

  private handleDialogInput(data: string): boolean {
    if (!this._dialog) return false;

    if (this._dialog.type === "help") {
      // Any key dismisses help
      this.closeDialog();
      return true;
    }

    // Escape cancels any dialog
    if (matchesKey(data, Key.escape)) {
      this.closeDialog();
      return true;
    }

    if (this._dialog.type === "confirm") {
      if (data === "y" || data === "Y") {
        this._dialog.onYes();
      } else if (data === "n" || data === "N") {
        this.closeDialog();
      }
      return true;
    }

    if (this._dialog.type === "input") {
      if (matchesKey(data, Key.enter)) {
        this._dialog.onSubmit(this._dialog.value);
      } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
        this._dialog.value = this._dialog.value.slice(0, -1);
        this.tui?.requestRender();
      } else if (data.length === 1 && data >= " ") {
        this._dialog.value += data;
        this.tui?.requestRender();
      }
      return true;
    }

    if (this._dialog.type === "select") {
      if (matchesKey(data, Key.down) || data === "j") {
        this._dialog.selectedIndex = Math.min(this._dialog.items.length - 1, this._dialog.selectedIndex + 1);
        this.tui?.requestRender();
      } else if (matchesKey(data, Key.up) || data === "k") {
        this._dialog.selectedIndex = Math.max(0, this._dialog.selectedIndex - 1);
        this.tui?.requestRender();
      } else if (matchesKey(data, Key.enter)) {
        this._dialog.onSelect(this._dialog.selectedIndex);
      }
      return true;
    }

    if (this._dialog.type === "textarea") {
      const d = this._dialog;
      const appendChar = (ch: string) => {
        const lastIdx = d.lines.length - 1;
        d.lines[lastIdx] = (d.lines[lastIdx] ?? "") + ch;
        this.tui?.requestRender();
      };

      if (d.focusedButton === "text") {
        if (matchesKey(data, Key.escape)) {
          this.closeDialog();
        } else if (data === "\t") {
          d.focusedButton = "send";
          this.tui?.requestRender();
        } else if (matchesKey(data, Key.enter)) {
          d.lines.push("");
          this.tui?.requestRender();
        } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
          const lastIdx = d.lines.length - 1;
          const lastLine = d.lines[lastIdx] ?? "";
          if (lastLine.length > 0) {
            d.lines[lastIdx] = lastLine.slice(0, -1);
          } else if (lastIdx > 0) {
            d.lines.pop();
          }
          this.tui?.requestRender();
        } else if (data.length === 1 && data >= " ") {
          appendChar(data);
        }
      } else if (d.focusedButton === "send") {
        if (matchesKey(data, Key.enter)) {
          d.onSubmit(d.lines.join("\n"));
        } else if (data === "\t" || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
          d.focusedButton = "cancel";
          this.tui?.requestRender();
        } else if (matchesKey(data, Key.escape)) {
          this.closeDialog();
        } else if (data.length === 1 && data >= " ") {
          d.focusedButton = "text";
          appendChar(data);
        }
      } else if (d.focusedButton === "cancel") {
        if (matchesKey(data, Key.enter)) {
          this.closeDialog();
        } else if (data === "\t" || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
          d.focusedButton = "text";
          this.tui?.requestRender();
        } else if (matchesKey(data, Key.escape)) {
          this.closeDialog();
        } else if (data.length === 1 && data >= " ") {
          d.focusedButton = "text";
          appendChar(data);
        }
      }
      return true;
    }

    if (this._dialog.type === "folder-browser") {
      const d = this._dialog;
      if (matchesKey(data, Key.down) || data === "j") {
        if (!d.addFocused) {
          d.selectedIndex = Math.min(d.items.length - 1, d.selectedIndex + 1);
          // Ensure visible
          const maxVisible = FOLDER_BROWSER_HEIGHT;
          if (d.selectedIndex >= d.scrollOffset + maxVisible) {
            d.scrollOffset = d.selectedIndex - maxVisible + 1;
          }
        }
        this.tui?.requestRender();
      } else if (matchesKey(data, Key.up) || data === "k") {
        if (!d.addFocused) {
          d.selectedIndex = Math.max(0, d.selectedIndex - 1);
          if (d.selectedIndex < d.scrollOffset) {
            d.scrollOffset = d.selectedIndex;
          }
        }
        this.tui?.requestRender();
      } else if (data === "\t") {
        const selectedItem = d.items[d.selectedIndex];
        if (selectedItem?.isGit) {
          d.addFocused = !d.addFocused;
          this.tui?.requestRender();
        }
      } else if (matchesKey(data, Key.enter)) {
        if (d.addFocused) {
          const selectedItem = d.items[d.selectedIndex];
          if (selectedItem?.isGit) {
            this.closeDialog();
            d.onSelect(selectedItem.path);
          }
        } else {
          // Navigate into selected folder
          const selectedItem = d.items[d.selectedIndex];
          if (selectedItem) {
            const newItems = buildFolderItems(selectedItem.path);
            // Find the item that matches the navigated-to path to keep it highlighted
            const newIdx = newItems.findIndex((i) => i.path === selectedItem.path);
            d.currentPath = selectedItem.path;
            d.items = newItems;
            d.selectedIndex = newIdx !== -1 ? newIdx : 0;
            d.addFocused = false;
            d.scrollOffset = Math.max(0, d.selectedIndex - 7);
            this.tui?.requestRender();
          }
        }
      }
      return true;
    }

    if (this._dialog.type === "fuzzy") {
      const refilter = () => {
        const d = this._dialog as Extract<DialogState, { type: "fuzzy" }>;
        const indices = fuzzyFilterIndices(d.allItems, d.query);
        d.filteredIndices = indices;
        d.filteredItems = indices.map((i) => d.allItems[i]!);
        d.selectedIndex = 0;
      };
      if (matchesKey(data, Key.enter)) {
        if (this._dialog.filteredItems.length > 0) {
          const originalIndex = this._dialog.filteredIndices[this._dialog.selectedIndex] ?? 0;
          this._dialog.onSelect(originalIndex);
        }
      } else if (matchesKey(data, Key.down)) {
        if (this._dialog.filteredItems.length > 0) {
          this._dialog.selectedIndex = Math.min(this._dialog.filteredItems.length - 1, this._dialog.selectedIndex + 1);
        }
        this.tui?.requestRender();
      } else if (matchesKey(data, Key.up)) {
        this._dialog.selectedIndex = Math.max(0, this._dialog.selectedIndex - 1);
        this.tui?.requestRender();
      } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
        this._dialog.query = this._dialog.query.slice(0, -1);
        refilter();
        this.tui?.requestRender();
      } else if (data.length === 1 && data >= " ") {
        this._dialog.query += data;
        refilter();
        this.tui?.requestRender();
      }
      return true;
    }

    return false;
  }

  onUpdate(agents: Agent[], flatList: FlatAgent[], questions: PendingQuestion[]) {
    this.agentTree.setFlatList(flatList);
    this.rightPane.questions = questions;
    this.rightPane.allAgents = flatList;
    this.statusBar.pendingQuestions = questions.length;

    // Clamp questions selection
    if (this.rightPane.questionsSelectedIndex >= questions.length) {
      this.rightPane.questionsSelectedIndex = Math.max(0, questions.length - 1);
    }

    // Update selected agent info
    this.syncSelectedAgent();

    this.tui?.requestRender();
  }

  private syncSelectedAgent() {
    const selected = this.agentTree.selectedAgent;
    this.rightPane.agent = selected;
    this.rightPane.selectedRepoHeader = this.agentTree.selectedRepoHeader;
    this.tmuxPane.agent = selected;

    // If agent changed, reset tmux pane state and reload agent data
    const newId = selected?.id ?? null;
    if (newId !== this.currentAgentId) {
      this.currentAgentId = newId;
      // Update terminal title
      if (newId) {
        process.stdout.write(`\x1b]0;itsybitsy: ${newId}\x07`);
      } else {
        process.stdout.write(`\x1b]0;itsybitsy\x07`);
      }
      this.tmuxPane.resetForAgent();
      this.rightPane.agentLogContent = null;
      this.rightPane.promptContent = null;
      this.rightPane.denialsContent = null;
      this.rightPane.diffContent = null;
      this.rightPane.diffLoading = false;
      this.rightPane.statusContent = null;
      this.rightPane.statusLoading = false;
      this.rightPane.scrollOffset = 0;
      if (selected) {
        this.loadAgentLog(selected);
        this.loadAgentPrompt(selected);
      }
    }

    this.rightPane.updateContent();
    // Auto-load async pane content (e.g. DIFF, STATUS) if currently viewing that mode
    this.triggerAsyncLoadIfNeeded();

    // Update tmux poller target
    this.tmuxPoller.setAgent(selected?.meta.tmux_session ?? null);
  }

  private async loadAgentLog(agent: Agent) {
    const content = await readAgentLog(agent);
    // Only apply if we're still looking at the same agent
    if (this.currentAgentId === agent.id) {
      this.rightPane.agentLogContent = colorizeLog(content);
      // Also parse denials from the log
      this.rightPane.denialsContent = parseDenials(content);
      this.rightPane.updateContent();
      this.tui?.requestRender();
    }
  }

  private async loadAgentPrompt(agent: Agent) {
    const content = await readAgentPrompt(agent);
    if (this.currentAgentId === agent.id) {
      this.rightPane.promptContent = content;
      this.rightPane.updateContent();
      this.tui?.requestRender();
    }
  }

  private async loadDiff(agent: Agent, forceRefresh = false) {
    if (this.rightPane.diffLoading) return;
    if (forceRefresh) this.rightPane.diffContent = null;
    this.rightPane.diffLoading = true;
    this.rightPane.updateContent();
    this.tui?.requestRender();
    try {
      const result = await diffAgent(agent);
      if (this.currentAgentId === agent.id) {
        const output = result.stdout || result.stderr || "(no output)";
        this.rightPane.diffContent = colorizeDiff(output.split("\n"));
        this.rightPane.diffLoading = false;
        this.rightPane.updateContent();
        this.tui?.requestRender();
      }
    } catch (err) {
      if (this.currentAgentId === agent.id) {
        this.rightPane.diffContent = [`Error loading diff: ${err}`];
        this.rightPane.diffLoading = false;
        this.rightPane.updateContent();
        this.tui?.requestRender();
      }
    }
  }

  private async loadStatus(agent: Agent, forceRefresh = false) {
    if (this.rightPane.statusLoading) return;
    if (forceRefresh) this.rightPane.statusContent = null;
    this.rightPane.statusLoading = true;
    this.rightPane.updateContent();
    this.tui?.requestRender();
    try {
      const result = await statusAgent(agent);
      if (this.currentAgentId === agent.id) {
        const output = result.stdout || result.stderr || "(no output)";
        this.rightPane.statusContent = output.split("\n");
        this.rightPane.statusLoading = false;
        this.rightPane.updateContent();
        this.tui?.requestRender();
      }
    } catch (err) {
      if (this.currentAgentId === agent.id) {
        this.rightPane.statusContent = [`Error loading status: ${err}`];
        this.rightPane.statusLoading = false;
        this.rightPane.updateContent();
        this.tui?.requestRender();
      }
    }
  }

  private cyclePaneMode(delta: number) {
    const startIndex = this.modeIndex;
    let nextIndex = (this.modeIndex + PANE_MODES.length + delta) % PANE_MODES.length;

    // Skip empty panes (ERRORS when no errors, QUESTIONS when no questions)
    const maxSteps = PANE_MODES.length;
    for (let i = 0; i < maxSteps; i++) {
      const candidate = PANE_MODES[nextIndex]!;
      const skip =
        (candidate === "ERRORS" && this.rightPane.errors.length === 0) ||
        (candidate === "QUESTIONS" && this.rightPane.questions.length === 0);
      if (!skip || nextIndex === startIndex) break;
      nextIndex = (nextIndex + PANE_MODES.length + delta) % PANE_MODES.length;
    }

    this.modeIndex = nextIndex;
    const mode = PANE_MODES[this.modeIndex]!;
    this.rightPane.setMode(mode);
    this.splitPane.fullWidth = FULL_WIDTH_MODES.has(mode);
    this.triggerAsyncLoadIfNeeded();
  }

  private jumpToMode(mode: PaneMode, forceRefresh = false) {
    const idx = PANE_MODES.indexOf(mode);
    if (idx !== -1) {
      this.modeIndex = idx;
      this.rightPane.setMode(mode);
      this.splitPane.fullWidth = FULL_WIDTH_MODES.has(mode);
      this.triggerAsyncLoadIfNeeded(forceRefresh);
    }
  }

  /** Trigger async loading for modes that need it */
  private triggerAsyncLoadIfNeeded(forceRefresh = false) {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    const mode = PANE_MODES[this.modeIndex]!;
    if (mode === "DIFF" && (forceRefresh || (!this.rightPane.diffContent && !this.rightPane.diffLoading))) {
      this.loadDiff(agent, forceRefresh);
    } else if (mode === "STATUS" && (forceRefresh || (!this.rightPane.statusContent && !this.rightPane.statusLoading))) {
      this.loadStatus(agent, forceRefresh);
    }
  }

  handleInput(data: string): void {
    // Dialog input takes priority
    if (this._dialog && this.handleDialogInput(data)) return;

    // Navigation
    if (matchesKey(data, Key.down) || data === "j") {
      if (this.rightPane.mode === "QUESTIONS" && this.rightPane.questions.length > 0) {
        this.rightPane.questionsSelectedIndex = Math.min(
          this.rightPane.questions.length - 1,
          this.rightPane.questionsSelectedIndex + 1
        );
        this.rightPane.updateContent();
        this.tui?.requestRender();
      } else {
        this.agentTree.moveSelection(1);
        this.syncSelectedAgent();
        this.tui?.requestRender();
      }
    } else if (matchesKey(data, Key.up) || data === "k") {
      if (this.rightPane.mode === "QUESTIONS" && this.rightPane.questions.length > 0) {
        this.rightPane.questionsSelectedIndex = Math.max(0, this.rightPane.questionsSelectedIndex - 1);
        this.rightPane.updateContent();
        this.tui?.requestRender();
      } else {
        this.agentTree.moveSelection(-1);
        this.syncSelectedAgent();
        this.tui?.requestRender();
      }
    }
    // Right pane cycling: p = forward/next, n = backward/previous
    // Left arrow maps to p (forward), right arrow maps to n (backward)
    else if (data === "p" || matchesKey(data, Key.left)) {
      this.cyclePaneMode(1);
      this.tui?.requestRender();
    } else if (data === "n" || matchesKey(data, Key.right)) {
      this.cyclePaneMode(-1);
      this.tui?.requestRender();
    }
    // Direct pane jumps — d and g force-refresh to always re-fetch
    else if (data === "d") {
      this.jumpToMode("DIFF", true);
      this.tui?.requestRender();
    } else if (data === "g") {
      if (this.rightPane.mode === "QUESTIONS") {
        this.handleGoToQuestionAgent();
      } else {
        this.jumpToMode("STATUS", true);
        this.tui?.requestRender();
      }
    } else if (data === "e") {
      this.jumpToMode("ERRORS");
      this.tui?.requestRender();
    } else if (data === "q") {
      this.jumpToMode("QUESTIONS");
      this.tui?.requestRender();
    }
    // Denials time filter
    else if (data === "t") {
      if (this.rightPane.mode === "DENIALS") {
        const currentIdx = DENIAL_FILTERS.indexOf(this.rightPane.denialFilter);
        this.rightPane.denialFilter = DENIAL_FILTERS[(currentIdx + 1) % DENIAL_FILTERS.length]!;
        this.rightPane.updateContent();
        this.tui?.requestRender();
      }
    }
    // Clear errors
    else if (data === "c") {
      if (this.rightPane.mode === "ERRORS") {
        this.clearErrors();
      }
    }
    // Enter: answer question in QUESTIONS pane
    else if (matchesKey(data, Key.enter)) {
      if (this.rightPane.mode === "QUESTIONS" && this.rightPane.questions.length > 0) {
        this.handleAnswerQuestion();
      }
    }
    // Escape: acknowledge question in QUESTIONS pane
    else if (matchesKey(data, Key.escape)) {
      if (this.rightPane.mode === "QUESTIONS" && this.rightPane.questions.length > 0) {
        this.handleAcknowledgeQuestion();
      }
    }
    // Scroll pane content — scrolls both tmux pane and right pane
    else if (data === ";") {
      this.handleScrollUp();
    } else if (data === "l") {
      this.handleScrollDown();
    }
    // Agent actions
    else if (data === "x") {
      this.handleKill();
    } else if (data === "!") {
      this.handleNuke();
    } else if (data === "R") {
      this.handleResume();
    } else if (data === "r") {
      this.handleReassign();
    } else if (data === "m") {
      this.handleMerge();
    } else if (data === "s") {
      this.handleSend();
    }
    // New agent
    else if (data === "a") {
      this.handleNewAgent();
    }
    // Fuzzy jump to agent
    else if (data === "@") {
      this.handleFuzzyAgent();
    }
    // Command palette
    else if (data === "/") {
      this.handleCommandPalette();
    }
    // Open worktree in Finder
    else if (data === "w") {
      this.handleOpenWorktree();
    }
    // Open diff in external tool
    else if (data === "o") {
      this.handleOpenDiffTool();
    }
    // Help dialog
    else if (data === "h") {
      this.handleHelp();
    }
    // Open in Ghostty
    else if (data === "G") {
      this.handleOpenGhostty();
    }
    // Debug snapshot
    else if (data === "S") {
      this.handleSnapshot();
    }
    // Folder browser to add repo
    else if (data === "+") {
      this.handleFolderBrowser();
    }
  }

  /**
   * Build a separator line with optional titles.
   * leftTitle appears near the left edge.
   * rightTitle appears at splitAt (left pane width), aligned to start of right pane.
   * If splitAt is 0, rightTitle is right-aligned.
   */
  private buildTitledSeparator(leftTitle: string, rightTitle: string, width: number, splitAt = 0, junctionChar = ""): string {
    const leftPad = 3;
    const rightPad = 3;

    if (splitAt > 0 && rightTitle) {
      // Left half: leftPad + leftTitle + dashes up to splitAt
      const leftHalfDashes = Math.max(1, splitAt - leftPad - leftTitle.length);
      // Right half: rightTitle + dashes to fill rest
      const rightHalfDashes = Math.max(1, width - splitAt - rightTitle.length - rightPad);
      // If junction requested, the last dash of leftHalfDashes becomes the junction char
      let leftDashStr: string;
      if (junctionChar && leftHalfDashes > 0) {
        leftDashStr = "─".repeat(leftHalfDashes - 1) + junctionChar;
      } else {
        leftDashStr = "─".repeat(leftHalfDashes);
      }
      const sep =
        `${DIM}${"─".repeat(leftPad)}${RESET}${BOLD}${leftTitle}${RESET}` +
        `${DIM}${leftDashStr}${RESET}` +
        `${BOLD}${rightTitle}${RESET}` +
        `${DIM}${"─".repeat(rightHalfDashes)}${"─".repeat(rightPad)}${RESET}`;
      return truncateToWidth(sep, width, "");
    }

    const fixedChars = leftPad + leftTitle.length + rightPad + rightTitle.length;
    const fillCount = Math.max(1, width - fixedChars);
    const sep = `${DIM}${"─".repeat(leftPad)}${RESET}${BOLD}${leftTitle}${RESET}${DIM}${"─".repeat(fillCount)}${RESET}${BOLD}${rightTitle}${RESET}${DIM}${"─".repeat(rightPad)}${RESET}`;
    return truncateToWidth(sep, width, "");
  }

  invalidate(): void {
    this.agentTree.invalidate();
    this.splitPane.invalidate();
    this.statusBar.invalidate();
  }

  render(width: number): string[] {
    // Minimum terminal size check
    const termRows = process.stdout.rows || 24;
    if (termRows < 20 || width < 80) {
      return [`${BOLD}${YELLOW}[Terminal too small — resize to at least 80×20]${RESET}`];
    }

    const lines: string[] = [];
    const terminalRows = process.stdout.rows || 24;
    const isTreeMode = this.rightPane.mode === "TREE";

    // Header
    const subtitle = this.lastSentNotice
      ? `${DIM}—${RESET} ${YELLOW}${this.lastSentNotice}${RESET}`
      : `${DIM}— agent dashboard${RESET}`;
    lines.push(truncateToWidth(`${BOLD}itsybitsy${RESET} ${subtitle}`, width, ""));
    lines.push(truncateToWidth(`${DIM}${"─".repeat(width)}${RESET}`, width, ""));

    if (isTreeMode) {
      // TREE mode: full-height navigable tree replaces both top tree and split pane
      // header(2) + separator(1) + separator(1) + statusBar(2) = 6 lines of chrome
      const treeHeight = Math.max(5, terminalRows - 6);
      this.agentTree.maxHeight = treeHeight;

      // Separator with TREE title
      lines.push(this.buildTitledSeparator(" TREE ", "", width));

      const treeLines = this.agentTree.render(width);
      lines.push(...treeLines);

      // Pad to fill available space
      const padNeeded = treeHeight - treeLines.length;
      for (let i = 0; i < padNeeded; i++) {
        lines.push("");
      }
    } else {
      // Normal layout: compact top tree + split pane
      this.agentTree.maxHeight = MAX_TREE_HEIGHT;

      // Agent tree (top section)
      const treeLines = this.agentTree.render(width);
      lines.push(...treeLines);

      // Separator with pane titles — right title at left edge of right pane
      const selAgent = this.agentTree.selectedAgent;
      const leftTitle = selAgent ? ` ${selAgent.id} ` : "";
      const rightTitle = ` ${this.rightPane.mode} `;
      const splitAt = this.splitPane.getLeftWidth() + 1; // +1 for separator char
      lines.push(this.buildTitledSeparator(leftTitle, rightTitle, width, splitAt, FULL_WIDTH_MODES.has(this.rightPane.mode) ? "" : "┬"));

      // Compute available height for split pane
      const bottomHeight = 2; // status bar is always 2 lines
      const separatorHeight = 1; // bottom separator before status
      const usedHeight = lines.length + separatorHeight + bottomHeight;
      const availableHeight = Math.max(5, terminalRows - usedHeight);

      // Set display heights on sub-components before rendering
      this.tmuxPane.displayHeight = availableHeight;
      this.rightPane.displayHeight = availableHeight;

      // Split pane (tmux left + right pane)
      this.splitPane.fullWidth = FULL_WIDTH_MODES.has(this.rightPane.mode);
      const splitLines = this.splitPane.render(width);
      lines.push(...splitLines);
    }

    // Separator — use ┴ junction when split pane has a vertical separator
    const useBottomJunction = !isTreeMode && !FULL_WIDTH_MODES.has(this.rightPane.mode);
    if (useBottomJunction) {
      const jPos = this.splitPane.getLeftWidth();
      const bottomSep = "─".repeat(jPos) + "┴" + "─".repeat(Math.max(0, width - jPos - 1));
      lines.push(truncateToWidth(`${DIM}${bottomSep}${RESET}`, width, ""));
    } else {
      lines.push(truncateToWidth(`${DIM}${"─".repeat(width)}${RESET}`, width, ""));
    }

    // Status bar (always visible — dialogs are overlays now)
    const statusLines = this.statusBar.render(width);
    lines.push(...statusLines);

    return lines;
  }

}

export async function launchDashboard(): Promise<void> {
  const registry = await loadRegistry();
  const repos = registry.repos;
  if (repos.length === 0) {
    console.log("No repos registered. Use 'itsybitsy add <path>' to add one.");
    process.exit(1);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // Read version from package.json
  let version = "";
  try {
    const pkgFile = Bun.file(new URL("../../package.json", import.meta.url).pathname);
    const pkg = await pkgFile.json();
    version = pkg.version ?? "";
  } catch {
    // Ignore — version will be empty
  }

  const dashboard = new DashboardComponent();
  dashboard.setTui(tui);
  dashboard.setRepos(repos);
  dashboard.setDiffTool(registry.diffTool);
  dashboard.setVersion(version);
  tui.addChild(dashboard);

  // Start watcher (before input listener so dashboard has reference)
  const watcher = new AgentWatcher(repos, {
    onUpdate: (agents, flatList, questions) => {
      dashboard.onUpdate(agents, flatList, questions);
    },
    onError: (err) => {
      dashboard.addError(err.message);
    },
  });

  dashboard.setWatcher(watcher);

  // Set up terminal color scheme detection
  const colorDetection = setupColorSchemeDetection(() => {
    tui.requestRender();
  });

  // Global input handler
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      colorDetection.cleanup();
      dashboard.stopPolling();
      watcher.stop();
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");
      process.exit(0);
    }
    // Intercept color-scheme escape sequences before other handling
    if (colorDetection.inputFilter(data)) return undefined;
    // Filter out key release events (Kitty protocol sends both press and release)
    if (isKeyRelease(data)) return undefined;
    dashboard.handleInput(data);
    return undefined;
  });

  tui.start();
  // Query terminal background color now that stdin is in raw mode
  colorDetection.queryColorScheme();
  dashboard.startPolling();
  await watcher.start();
}
