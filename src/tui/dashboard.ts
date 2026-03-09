/**
 * Main TUI dashboard — agent tree + live tmux pane + all keybindings.
 * Composes AgentTree, TmuxPane, RightPane, StatusBar, and dialog system.
 *
 * Sub-modules:
 *   agent-tree.ts     — AgentTreeComponent + formatAgentRow
 *   color-scheme.ts   — terminal color scheme detection + getStateColors
 *   dialog-handler.ts — DialogState type + dialog input routing
 *   agent-actions.ts  — agent action handlers (kill, merge, send, etc.)
 *   pane-manager.ts   — RightPaneComponent + pane mode cycling + async loading
 */

import {
  TUI,
  ProcessTerminal,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  isKeyRelease,
} from "@mariozechner/pi-tui";
import type { Component, OverlayHandle } from "@mariozechner/pi-tui";
import { loadRegistry } from "../registry";
import type { RepoEntry } from "../registry";
import { AgentWatcher } from "../watcher";
import { TmuxPoller, hasAttachedClient } from "../tmux-poller";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import { SplitPane } from "./split-pane";
import { wrapLines } from "./wrap";
import { fetchUsage } from "../usage";
import { startWatchdog, stopWatchdog, isWatchdogRunning } from "../watchdog";
import type { UsageData } from "../usage";
import { getStateColors, setupColorSchemeDetection } from "./color-scheme";
import { AgentTreeComponent } from "./agent-tree";
import type { DialogState } from "./dialog-handler";
import {
  wrapTextareaLines, TEXTAREA_VISIBLE_HEIGHT,
  handleDialogInput, renderTextareaBlock, buildFolderBrowserContent, buildNewAgentFormContent,
  buildSetupContent,
} from "./dialog-handler";
import {
  RightPaneComponent, colorizeDiff, colorizeLog,
  PANE_MODES, FULL_WIDTH_MODES,
  DENIAL_FILTERS,
  cyclePaneMode, jumpToMode, triggerAsyncLoadIfNeeded,
  loadAgentLog, loadAgentPrompt,
} from "./pane-manager";
import type { PaneMode, DenialFilter } from "./pane-manager";
import * as agentActions from "./agent-actions";
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, DIM_GRAY } from "./colors";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";

// Re-export for test compatibility
export { AgentTreeComponent, formatAgentRow } from "./agent-tree";
export { RightPaneComponent, colorizeDiff, colorizeLog } from "./pane-manager";

const DIALOG_WIDTH = 60;
const DEFAULT_LEFT_WIDTH = 80;
const LEFT_WIDTH_STEP = 5;

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
  /** Whether the agent's tmux session has an attached external client */
  clientAttached = false;

  invalidate(): void {}

  /** Reset state when switching agents */
  resetForAgent() {
    this.rawOutput = "";
    this.hasPolled = false;
    this.scrollBack = 0;
    this.clientAttached = false;
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

    // Show centered message when agent's tmux session is opened in an external terminal
    if (this.clientAttached) {
      const lines: string[] = [];
      const midLine = Math.floor(this.displayHeight / 2);
      const idText = `${DIM}${this.agent.id}${RESET}`;
      const sessionText = `${DIM}${this.agent.meta.tmux_session}${RESET}`;
      const msgText = `${DIM}[opened in terminal]${RESET}`;
      for (let i = 0; i < this.displayHeight; i++) {
        if (i === midLine - 1) {
          const pad = Math.max(0, Math.floor((width - visibleWidth(idText)) / 2));
          lines.push(truncateToWidth(" ".repeat(pad) + idText, width, ""));
        } else if (i === midLine) {
          const pad = Math.max(0, Math.floor((width - visibleWidth(sessionText)) / 2));
          lines.push(truncateToWidth(" ".repeat(pad) + sessionText, width, ""));
        } else if (i === midLine + 1) {
          const pad = Math.max(0, Math.floor((width - visibleWidth(msgText)) / 2));
          lines.push(truncateToWidth(" ".repeat(pad) + msgText, width, ""));
        } else {
          lines.push("");
        }
      }
      return lines;
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
    const contentHeight = this.scrollBack > 0 ? this.displayHeight - 1 : this.displayHeight;
    const end = wrapped.length - this.scrollBack;
    const start = Math.max(0, end - contentHeight);
    const visible = wrapped.slice(start, end);

    const lines = visible.map((line) => truncateToWidth(line, width, ""));

    // Append scroll indicator when scrolled back
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
  repoHeaderSelected = false;

  invalidate(): void {}

  render(width: number): string[] {
    const qLabel = this.pendingQuestions > 0
      ? `q: questions (${this.pendingQuestions})`
      : "q: questions";
    const errBadge = this.errorCount > 0
      ? `  ${BOLD}${RED}[${this.errorCount} errors]${RESET}${DIM}`
      : "";
    const usageStr = this.formatUsage();
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const versionStr = this.version ? `v${this.version}` : "";
    const watchdogStr = isWatchdogRunning() ? "[watchdog]  " : "";
    const row2Right = `${DIM}${watchdogStr}${timeStr}  ${versionStr}${RESET}`;

    let row1Left: string;
    let row2Left: string;
    if (this.repoHeaderSelected) {
      row1Left = `${DIM}j/k: select    ;/l: scroll    p/n: pane    ${qLabel}${errBadge}${RESET}`;
      row2Left = `${DIM}@: jump    /: commands    a: new agent    ?: help    h: setup    +: add repo${RESET}`;
    } else {
      row1Left = `${DIM}j/k: select    ;/l: scroll    p/n: pane    ${qLabel}    s: send    m: merge${errBadge}${RESET}`;
      row2Left = `${DIM}@: jump    /: commands    a: new agent    ?: help    h: setup    x: kill${RESET}`;
    }

    const row1 = this.composeLine(row1Left, usageStr, width);
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
  private getRepoPaths: () => Set<string>;

  constructor(getDialog: () => DialogState, getRepoPaths: () => Set<string>) {
    this.getDialog = getDialog;
    this.getRepoPaths = getRepoPaths;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const dialog = this.getDialog();
    if (!dialog) return [];

    const innerWidth = width - 4; // 2 border + 2 padding
    const { title, contentLines } = this.buildContent(dialog, innerWidth);

    const lines: string[] = [];
    const titleStr = ` ${title} `;
    const topPadding = Math.max(0, width - 3 - visibleWidth(titleStr));
    lines.push(`┌─${BOLD}${titleStr}${RESET}${"─".repeat(topPadding)}┐`);

    for (const cl of contentLines) {
      const pad = Math.max(0, innerWidth - visibleWidth(cl));
      lines.push(`│  ${cl}${" ".repeat(pad)}│`);
    }

    lines.push(`└${"─".repeat(width - 2)}┘`);
    return lines;
  }

  private buildContent(dialog: NonNullable<DialogState>, innerWidth: number): { title: string; contentLines: string[] } {
    switch (dialog.type) {
      case "confirm": {
        const wrapped = wrapLines(dialog.prompt, innerWidth);
        const btnColor = dialog.confirmColor ?? GREEN;
        const confirmBtn = dialog.focusedButton === "confirm" ? `${BOLD}${btnColor}[ ${dialog.confirmLabel} ]${RESET}` : `[ ${dialog.confirmLabel} ]`;
        const cancelBtn = dialog.focusedButton === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `[ Cancel ]`;
        return { title: "Confirm", contentLines: [...wrapped, "", `  ${cancelBtn}   ${confirmBtn}`] };
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
        const lines: string[] = [];
        if (dialog.sendAll !== undefined) {
          const allIndicator = dialog.sendAll
            ? `${BOLD}${GREEN}[ALL]${RESET} ${DIM}Ctrl-A: toggle${RESET}`
            : `${DIM}[ALL] Ctrl-A: send to all${RESET}`;
          lines.push(allIndicator);
        }
        const { outputLines, hasScrollIndicator } = renderTextareaBlock(dialog.lines, innerWidth, dialog.focusedButton === "text");
        lines.push(...outputLines);
        if (hasScrollIndicator) { lines.push(`${DIM}↑${RESET}`); }
        const sendLabel = dialog.focusedButton === "send" ? `${BOLD}${GREEN}[ Send ]${RESET}` : `[ Send ]`;
        const cancelLabel = dialog.focusedButton === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `[ Cancel ]`;
        lines.push(`  ${cancelLabel}   ${sendLabel}`);
        return { title: dialog.prompt, contentLines: lines };
      }
      case "folder-browser": {
        return buildFolderBrowserContent(dialog, innerWidth, this.getRepoPaths());
      }
      case "new-agent-form": {
        return buildNewAgentFormContent(dialog, innerWidth);
      }
      case "setup": {
        return buildSetupContent(dialog, innerWidth);
      }
    }
  }
}

/** Main dashboard component that composes everything */
export class DashboardComponent implements Component {
  agentTree: AgentTreeComponent;
  rightPane: RightPaneComponent;
  tmuxPane: TmuxPaneComponent;
  splitPane: SplitPane;
  private statusBar: StatusBarComponent;
  tui: TUI | null = null;
  modeIndex = 0;
  private tmuxPoller: TmuxPoller;
  currentAgentId: string | null = null;
  _dialog: DialogState = null;
  private overlayHandle: OverlayHandle | null = null;
  private dialogOverlay: DialogOverlayComponent;
  watcher: AgentWatcher | null = null;
  repos: RepoEntry[] = [];
  private noticeCounter = 0;
  diffTool: string | undefined;
  private lastSentNotice: string | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  pendingSelectNewestInRepo: string | null = null;
  private _questionsFocused = false;
  /** Cache of which agents have an attached tmux client */
  private _clientAttached: Map<string, boolean> = new Map();
  private clientCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Read-only access to whether questions list has focus (for testing) */
  get questionsFocused(): boolean {
    return this._questionsFocused;
  }

  setQuestionsFocused(value: boolean) {
    this._questionsFocused = value;
    this.agentTree.suppressSelection = value;
    this.rightPane.questionsFocused = value;
  }

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

  /** Read-only access to client-attached cache (for testing) */
  get clientAttachedCache(): Map<string, boolean> {
    return this._clientAttached;
  }

  constructor() {
    this.agentTree = new AgentTreeComponent();
    this.rightPane = new RightPaneComponent();
    this.tmuxPane = new TmuxPaneComponent();
    this.statusBar = new StatusBarComponent();
    this.dialogOverlay = new DialogOverlayComponent(() => this._dialog, () => new Set(this.repos.map((r) => r.path)));

    this.splitPane = new SplitPane(this.tmuxPane, this.rightPane, DEFAULT_LEFT_WIDTH, `${DIM_GRAY}│${RESET}`);

    this.tmuxPoller = new TmuxPoller({
      onOutput: (raw, _stripped) => {
        this.tmuxPane.rawOutput = raw;
        this.tmuxPane.hasPolled = true;
        this.tui?.requestRender();
      },
      onWidth: (width) => {
        const clamped = Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, width));
        if (clamped !== this.splitPane.getLeftWidth()) {
          this.splitPane.setLeftWidth(clamped);
          this.tui?.requestRender();
        }
      },
    });
  }

  setTui(tui: TUI) {
    this.tui = tui;
  }

  /** Set the terminal window title via OSC 0. Extracted for testability. */
  setTerminalTitle(title: string) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }

  startPolling() {
    this.tmuxPoller.start();
    this.refreshUsage();
    this.usageTimer = setInterval(() => this.refreshUsage(), 60_000);
    if (this.watcher) {
      const watcher = this.watcher;
      startWatchdog(() => watcher.lastAgents);
    }
  }

  stopPolling() {
    this.tmuxPoller.stop();
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
    if (this.clientCheckTimer) {
      clearInterval(this.clientCheckTimer);
      this.clientCheckTimer = null;
    }
    stopWatchdog();
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

  /** Add an error to the errors list (called from watcher onError).
   *  Deduplicates: if the same message already exists, updates its timestamp instead of adding a new entry. */
  addError(message: string) {
    const ts = new Date().toLocaleTimeString();
    // Check if this message already exists (ignoring timestamp prefix).
    // Match against the RESET+space separator to avoid false suffix matches.
    const suffix = `${RESET} ${message}`;
    const existingIndex = this.rightPane.errors.findIndex((e) => e.endsWith(suffix));
    if (existingIndex !== -1) {
      // Update the timestamp on the existing error
      this.rightPane.errors[existingIndex] = `${DIM}[${ts}]${RESET} ${message}`;
    } else {
      this.rightPane.errors.push(`${DIM}[${ts}]${RESET} ${message}`);
    }
    this.statusBar.errorCount = this.rightPane.errors.length + this.rightPane.orphanedTmuxSessions.length;
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  /** Clear all errors */
  clearErrors() {
    this.rightPane.errors = [];
    this.statusBar.errorCount = this.rightPane.orphanedTmuxSessions.length;
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  showDialog(dialog: NonNullable<DialogState>) {
    this._dialog = dialog;
    const width = dialog.type === "help" ? 72
      : (dialog.type === "folder-browser" || dialog.type === "new-agent-form" || dialog.type === "setup") ? 70
      : DIALOG_WIDTH;
    if (width !== DIALOG_WIDTH && this.overlayHandle) {
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

  closeDialog() {
    this._dialog = null;
    this.overlayHandle?.hide();
    this.overlayHandle = null;
    this.tui?.requestRender();
  }

  setNotice(text: string) {
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

  async executeAndRefresh(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.setNotice(`Error: ${err}`);
    }
    this.watcher?.refresh();
  }

  // --- Pane management (delegates to pane-manager.ts) ---

  jumpToMode(mode: PaneMode, forceRefresh = false) {
    jumpToMode(this, mode, forceRefresh);
  }

  private cyclePaneMode(delta: number) {
    cyclePaneMode(this, delta);
  }

  // --- Command palette ---

  private handleCommandPalette() {
    type Command = { label: string; action: () => void };
    const commands: Command[] = [
      { label: "AGENT LOG — show agent log", action: () => this.jumpToMode("AGENT LOG") },
      { label: "INITIAL PROMPT — show initial prompt", action: () => this.jumpToMode("INITIAL PROMPT") },
      { label: "DENIALS — show tool denials", action: () => this.jumpToMode("DENIALS") },
      { label: "TREE — show full agent tree", action: () => this.jumpToMode("TREE") },
      { label: "ERRORS — show errors", action: () => this.jumpToMode("ERRORS") },
      { label: "DIFF — run ib diff", action: () => this.jumpToMode("DIFF", true) },
      { label: "STATUS — run ib status", action: () => this.jumpToMode("STATUS", true) },
      { label: "QUESTIONS — show pending questions", action: () => this.jumpToMode("QUESTIONS") },
      { label: "send message — s", action: () => agentActions.handleSend(this) },
      { label: "merge agent — m", action: () => agentActions.handleMerge(this) },
      { label: "kill agent — x", action: () => agentActions.handleKill(this) },
      { label: "force kill agent — !", action: () => agentActions.handleNuke(this) },
      { label: "resume agent — R", action: () => agentActions.handleResume(this) },
      { label: "pause agent — P", action: () => agentActions.handlePause(this) },
      { label: "reassign manager — r", action: () => agentActions.handleReassign(this) },
      { label: "new agent — a", action: () => agentActions.handleNewAgent(this) },
      { label: "open worktree — w", action: () => agentActions.handleOpenWorktree(this) },
      { label: "open diff in tool — o", action: () => agentActions.handleOpenDiffTool(this) },
      { label: "open in Ghostty — G", action: () => agentActions.handleOpenGhostty(this) },
      { label: "debug snapshot — S", action: () => agentActions.handleSnapshot(this) },
      { label: "fuzzy jump to agent — @", action: () => agentActions.handleFuzzyAgent(this) },
      { label: "help — ?", action: () => agentActions.handleHelp(this) },
      { label: "setup — h", action: () => agentActions.handleSetup(this) },
      { label: "scroll up — ;", action: () => agentActions.handleScrollUp(this) },
      { label: "scroll down — l", action: () => agentActions.handleScrollDown(this) },
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

  // --- Data update + agent sync ---

  onUpdate(agents: Agent[], flatList: FlatEntry[], questions: PendingQuestion[], orphanedTmuxSessions: string[] = []) {
    this.agentTree.setFlatList(flatList);
    this.rightPane.questions = questions;
    this.rightPane.allAgents = flatList;
    this.rightPane.orphanedTmuxSessions = orphanedTmuxSessions;
    this.statusBar.pendingQuestions = questions.length;
    this.statusBar.errorCount = this.rightPane.errors.length + orphanedTmuxSessions.length;

    const qIds = new Set<string>();
    for (const q of questions) qIds.add(q.agent);
    this.agentTree.questionAgentIds = qIds;

    const filtered = this.rightPane.filteredQuestions;
    if (this.rightPane.questionsSelectedIndex >= filtered.length) {
      this.rightPane.questionsSelectedIndex = Math.max(0, filtered.length - 1);
    }

    // Auto-select newly created agent if pending
    if (this.pendingSelectNewestInRepo) {
      const repoPath = this.pendingSelectNewestInRepo;
      this.pendingSelectNewestInRepo = null;
      const agentEntries = flatList.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent" && f.agent.repoPath === repoPath);
      const newest = agentEntries.reduce<Extract<FlatEntry, { kind: "agent" }> | null>((best, f) => {
        if (!best || f.agent.meta.created_epoch > best.agent.meta.created_epoch) return f;
        return best;
      }, null);
      if (newest) {
        this.agentTree.selectAgentById(newest.agent.id);
      }
    }

    this.syncSelectedAgent();
    this.tui?.requestRender();
  }

  syncSelectedAgent() {
    const selected = this.agentTree.selectedAgent;
    this.rightPane.agent = selected;
    this.rightPane.selectedRepoHeader = this.agentTree.selectedRepoHeader;
    this.tmuxPane.agent = selected;
    this.statusBar.repoHeaderSelected = !selected && this.agentTree.selectedRepoHeader !== null;

    const newId = selected?.id ?? null;
    if (newId !== this.currentAgentId) {
      this.currentAgentId = newId;
      this.setTerminalTitle(newId ? `itsybitsy: ${newId}` : "itsybitsy");
      this.tmuxPane.resetForAgent();
      this.rightPane.agentLogContent = null;
      this.rightPane.promptContent = null;
      this.rightPane.denialsContent = null;
      this.rightPane.diffContent = null;
      this.rightPane.diffLoading = false;
      this.rightPane.statusContent = null;
      this.rightPane.statusLoading = false;
      this.rightPane.scrollOffset = 0;
      this.rightPane.questionsSelectedIndex = 0;
      if (this.rightPane.filteredQuestions.length === 0) {
        this.setQuestionsFocused(false);
      }
      if (selected) {
        loadAgentLog(this, selected);
        loadAgentPrompt(this, selected);
      }

      // Client detection: clear previous timer, check new agent
      if (this.clientCheckTimer) {
        clearInterval(this.clientCheckTimer);
        this.clientCheckTimer = null;
      }
      if (selected?.meta.tmux_session) {
        this.checkClientAttached(selected);
      }
    }

    this.rightPane.updateContent();
    triggerAsyncLoadIfNeeded(this);
    this.tmuxPoller.setAgent(selected?.meta.tmux_session ?? null);
  }

  /** Check if the selected agent's tmux session has an attached client, start/stop polling accordingly */
  private checkClientAttached(agent: Agent) {
    const agentId = agent.id;
    const session = agent.meta.tmux_session;

    const doCheck = async () => {
      const attached = await hasAttachedClient(session);

      // Discard result if the agent changed while we were awaiting
      const current = this.agentTree.selectedAgent;
      if (!current || current.id !== agentId) return;

      const wasAttached = this._clientAttached.get(agentId) ?? false;
      this._clientAttached.set(agentId, attached);

      if (attached && !this.clientCheckTimer) {
        // Start polling every 3s to detect disconnect
        this.clientCheckTimer = setInterval(() => {
          const sel = this.agentTree.selectedAgent;
          if (!sel || sel.id !== agentId) {
            // Agent switched away, stop polling
            if (this.clientCheckTimer) {
              clearInterval(this.clientCheckTimer);
              this.clientCheckTimer = null;
            }
            return;
          }
          doCheck();
        }, 3000);
      } else if (!attached && this.clientCheckTimer) {
        // Client disconnected, stop polling
        clearInterval(this.clientCheckTimer);
        this.clientCheckTimer = null;
      }

      if (attached !== wasAttached) {
        this.tmuxPane.clientAttached = attached;
        this.tui?.requestRender();
      }
    };

    doCheck();
  }

  // --- Input handling ---

  handleInput(data: string): void {
    // Dialog input takes priority
    if (this._dialog && handleDialogInput(this, data)) return;

    // Tab / Shift-Tab: toggle focus between tree and questions list
    if (data === "\t" || data === "\x1b[Z") {
      if (this.rightPane.mode === "QUESTIONS" && this.rightPane.filteredQuestions.length > 0) {
        this.setQuestionsFocused(!this._questionsFocused);
        this.rightPane.updateContent();
        this.tui?.requestRender();
        return;
      }
    }

    // Navigation
    if (matchesKey(data, Key.down) || data === "j") {
      if (this.rightPane.mode === "QUESTIONS" && this._questionsFocused && this.rightPane.filteredQuestions.length > 0) {
        this.rightPane.questionsSelectedIndex = Math.min(
          this.rightPane.filteredQuestions.length - 1,
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
      if (this.rightPane.mode === "QUESTIONS" && this._questionsFocused && this.rightPane.filteredQuestions.length > 0) {
        this.rightPane.questionsSelectedIndex = Math.max(0, this.rightPane.questionsSelectedIndex - 1);
        this.rightPane.updateContent();
        this.tui?.requestRender();
      } else {
        this.agentTree.moveSelection(-1);
        this.syncSelectedAgent();
        this.tui?.requestRender();
      }
    }
    // Right pane cycling
    else if (data === "p" || matchesKey(data, Key.left)) {
      this.cyclePaneMode(1);
      this.tui?.requestRender();
    } else if (data === "n" || matchesKey(data, Key.right)) {
      this.cyclePaneMode(-1);
      this.tui?.requestRender();
    }
    // Direct pane jumps
    else if (data === "d") {
      this.jumpToMode("DIFF", true);
      this.tui?.requestRender();
    } else if (data === "g") {
      if (this.rightPane.mode === "QUESTIONS") {
        agentActions.handleGoToQuestionAgent(this);
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
      if (this.rightPane.mode === "ERRORS") { this.clearErrors(); }
    }
    // Kill orphaned tmux session (Enter in ERRORS mode)
    else if (matchesKey(data, Key.enter) && this.rightPane.mode === "ERRORS" && this.rightPane.orphanedTmuxSessions.length > 0) {
      agentActions.handleKillOrphanedSessions(this);
      return;
    }
    // Enter: answer question
    else if (matchesKey(data, Key.enter)) {
      if (this.rightPane.mode === "QUESTIONS" && this.rightPane.filteredQuestions.length > 0) {
        agentActions.handleAnswerQuestion(this);
      }
    }
    // Escape: acknowledge question
    else if (matchesKey(data, Key.escape)) {
      if (this.rightPane.mode === "QUESTIONS" && this.rightPane.filteredQuestions.length > 0) {
        agentActions.handleAcknowledgeQuestion(this);
      }
    }
    // Scroll
    else if (data === ";") { agentActions.handleScrollUp(this); }
    else if (data === "l") { agentActions.handleScrollDown(this); }
    // Agent/repo actions — context-sensitive on whether a repo header is selected
    else if (data === "x") {
      if (!this.agentTree.selectedAgent && this.agentTree.selectedRepoHeader) {
        agentActions.handleRemoveRepo(this);
      } else {
        agentActions.handleKill(this);
      }
    }
    else if (data === "!") { agentActions.handleNuke(this); }
    else if (data === "R") { agentActions.handleResume(this); }
    else if (data === "P") { agentActions.handlePause(this); }
    else if (data === "r") {
      if (!this.agentTree.selectedAgent && this.agentTree.selectedRepoHeader) {
        agentActions.handleRenameRepo(this);
      } else {
        agentActions.handleReassign(this);
      }
    }
    else if (data === "m") { agentActions.handleMerge(this); }
    else if (data === "s") { agentActions.handleSend(this); }
    // New agent
    else if (data === "a") { agentActions.handleNewAgent(this); }
    // Fuzzy jump
    else if (data === "@") { agentActions.handleFuzzyAgent(this); }
    // Command palette
    else if (data === "/") { this.handleCommandPalette(); }
    // Open worktree
    else if (data === "w") { agentActions.handleOpenWorktree(this); }
    // Open diff in external tool
    else if (data === "o") { agentActions.handleOpenDiffTool(this); }
    // Help dialog
    else if (data === "?") { agentActions.handleHelp(this); }
    // Setup dialog
    else if (data === "h") { agentActions.handleSetup(this); }
    // Ghostty
    else if (data === "G") { agentActions.handleOpenGhostty(this); }
    // Snapshot
    else if (data === "S") { agentActions.handleSnapshot(this); }
    // Resize left pane
    else if (data === "[") { agentActions.handleResizeLeft(this, -LEFT_WIDTH_STEP); }
    else if (data === "]") { agentActions.handleResizeLeft(this, LEFT_WIDTH_STEP); }
    // Folder browser
    else if (data === "+") { agentActions.handleFolderBrowser(this); }
  }

  // --- Rendering ---

  /**
   * Build a separator line with optional titles.
   */
  private buildTitledSeparator(leftTitle: string, rightTitle: string, width: number, splitAt = 0, junctionChar = ""): string {
    const leftPad = 3;
    const rightPad = 3;

    if (splitAt > 0 && rightTitle) {
      const leftHalfDashes = Math.max(1, splitAt - leftPad - leftTitle.length);
      const rightHalfDashes = Math.max(1, width - splitAt - rightTitle.length - rightPad);
      let leftDashStr: string;
      if (junctionChar && leftHalfDashes > 0) {
        leftDashStr = "─".repeat(leftHalfDashes - 1) + junctionChar;
      } else {
        leftDashStr = "─".repeat(leftHalfDashes);
      }
      const sep =
        `${DIM_GRAY}${"─".repeat(leftPad)}${RESET}${BOLD}${leftTitle}${RESET}` +
        `${DIM_GRAY}${leftDashStr}${RESET}` +
        `${BOLD}${rightTitle}${RESET}` +
        `${DIM_GRAY}${"─".repeat(rightHalfDashes)}${"─".repeat(rightPad)}${RESET}`;
      return truncateToWidth(sep, width, "");
    }

    const fixedChars = leftPad + leftTitle.length + rightPad + rightTitle.length;
    const fillCount = Math.max(1, width - fixedChars);
    const sep = `${DIM_GRAY}${"─".repeat(leftPad)}${RESET}${BOLD}${leftTitle}${RESET}${DIM_GRAY}${"─".repeat(fillCount)}${RESET}${BOLD}${rightTitle}${RESET}${DIM_GRAY}${"─".repeat(rightPad)}${RESET}`;
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

    if (isTreeMode) {
      // title(1) + separator(1) + separator(1) + statusBar(3) = 6 lines of chrome
      const treeHeight = Math.max(5, terminalRows - 6);
      this.agentTree.maxHeight = treeHeight;
      lines.push(this.buildTitledSeparator(" TREE ", "", width));
      const treeLines = this.agentTree.render(width);
      lines.push(...treeLines);
      const padNeeded = treeHeight - treeLines.length;
      for (let i = 0; i < padNeeded; i++) { lines.push(""); }
    } else {
      lines.push(truncateToWidth(`${DIM_GRAY}${"─".repeat(width)}${RESET}`, width, ""));
      this.agentTree.maxHeight = 7;
      const treeLines = this.agentTree.render(width);
      lines.push(...treeLines);

      const selAgent = this.agentTree.selectedAgent;
      const leftTitle = selAgent ? ` ${selAgent.id} ` : "";
      const repoHeader = this.agentTree.selectedRepoHeader;
      const rightTitle = repoHeader ? ` ${repoHeader} ` : ` ${this.rightPane.mode} `;
      const splitAt = this.splitPane.getLeftWidth() + 1;
      lines.push(this.buildTitledSeparator(leftTitle, rightTitle, width, splitAt, FULL_WIDTH_MODES.has(this.rightPane.mode) ? "" : "┬"));

      const bottomHeight = 3; // status bar is always 3 lines
      const separatorHeight = 1;
      const usedHeight = lines.length + separatorHeight + bottomHeight;
      const availableHeight = Math.max(5, terminalRows - usedHeight);

      this.tmuxPane.displayHeight = availableHeight;
      this.rightPane.displayHeight = availableHeight;

      this.splitPane.fullWidth = FULL_WIDTH_MODES.has(this.rightPane.mode);
      const splitLines = this.splitPane.render(width);
      lines.push(...splitLines);
    }

    // Separator
    const useBottomJunction = !isTreeMode && !FULL_WIDTH_MODES.has(this.rightPane.mode);
    if (useBottomJunction) {
      const jPos = this.splitPane.getLeftWidth();
      const bottomSep = "─".repeat(jPos) + "┴" + "─".repeat(Math.max(0, width - jPos - 1));
      lines.push(truncateToWidth(`${DIM_GRAY}${bottomSep}${RESET}`, width, ""));
    } else {
      lines.push(truncateToWidth(`${DIM_GRAY}${"─".repeat(width)}${RESET}`, width, ""));
    }

    // Status bar
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

  let version = "";
  try {
    const pkgFile = Bun.file(new URL("../../package.json", import.meta.url).pathname);
    const pkg = await pkgFile.json();
    version = pkg.version ?? "";
  } catch {
    // Ignore
  }

  const dashboard = new DashboardComponent();
  dashboard.setTui(tui);
  dashboard.setRepos(repos);
  dashboard.setDiffTool(registry.diffTool);
  dashboard.setVersion(version);
  tui.addChild(dashboard);

  const watcher = new AgentWatcher(repos, {
    onUpdate: (agents: Agent[], flatList: FlatEntry[], questions: PendingQuestion[], orphanedTmuxSessions: string[]) => {
      dashboard.onUpdate(agents, flatList, questions, orphanedTmuxSessions);
    },
    onError: (err) => {
      dashboard.addError(err.message);
    },
  });

  dashboard.setWatcher(watcher);

  const colorDetection = setupColorSchemeDetection(() => {
    tui.requestRender();
  });

  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      colorDetection.cleanup();
      dashboard.stopPolling();
      watcher.stop();
      tui.stop();
      dashboard.setTerminalTitle("");
      process.stdout.write("\x1b[2J\x1b[H");
      process.exit(0);
    }
    if (colorDetection.inputFilter(data)) return undefined;
    if (isKeyRelease(data)) return undefined;
    dashboard.handleInput(data);
    return undefined;
  });

  tui.start();
  colorDetection.queryColorScheme();
  dashboard.startPolling();
  await watcher.start();
}
