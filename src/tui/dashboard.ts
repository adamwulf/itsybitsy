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
import { loadRegistry, setRepoDefaultAgentType, setRepoNotes } from "../registry";
import { readConfig, checkDeprecatedConfigKeys } from "../config";
import { validateAllAgentTypes, ensureAgentTypesDir, listSpawnableTypeNamesSync } from "../agent-types";
import type { RepoEntry } from "../registry";
import { AgentWatcher } from "../watcher";
import { TmuxPoller, hasAttachedClient, resizeTmuxWindow } from "../tmux-poller";
import { parseModel } from "../agent-cli";
import {
  IB_COORDINATOR_SESSION,
  acquireSystemCoordinator,
  ensureSystemCoordinator,
  releaseSystemCoordinator,
  resizeCoordinatorTmux,
  sanitizeTmuxInput,
} from "../coordinator";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import { isCodexStatusLine, stripAnsi } from "../parse-state";
import { SplitPane } from "./split-pane";
import { wrapLines, wordWrapLines, padLines, findLastTwoSeparators } from "./wrap";
import { fetchCodexUsage, fetchUsage } from "../usage";
import type { UsageData } from "../usage";
import { getStateColors, setupColorSchemeDetection } from "./color-scheme";
import { AgentTreeComponent } from "./agent-tree";
import { TeamsTreeComponent, flattenTeamsTree } from "./teams-tree";
import { ChannelPaneComponent } from "./channel-pane";
import { TeamLogPaneComponent } from "./team-log-pane";
import { SidebarComponent, SIDEBAR_WIDTH, computeSidebarHeights, clampSidebarOffsets } from "./sidebar";
import type { SidebarMode } from "./sidebar";
import { InfoPanelComponent } from "./info-panel";
import { listTeams, getTeam } from "../teams";
import type { Team } from "../teams";
import type { DialogState } from "./dialog-handler";
import {
  wrapTextareaLines, TEXTAREA_VISIBLE_HEIGHT,
  handleDialogInput, renderTextareaBlock, buildFolderBrowserContent, buildNewAgentFormContent,
  buildSetupContent, buildPermissionsEditorContent, buildMultiSelectContent,
} from "./dialog-handler";
import {
  RightPaneComponent, colorizeDiff, colorizeLog,
  PANE_MODES, FULL_WIDTH_MODES,
  cyclePaneMode, jumpToMode, triggerAsyncLoadIfNeeded,
  loadAgentLog, loadAgentPrompt,
} from "./pane-manager";
import type { PaneMode } from "./pane-manager";
import * as agentActions from "./agent-actions";
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, DIM_GRAY, REVERSE } from "./colors";
import { FocusManager } from "./focus";
import type { FocusTarget, SubFocus } from "./focus";
import { SystemDashboardComponent } from "./system-dashboard";
import { loadLayout, saveLayoutDebounced, cancelPendingSave, flushPendingSave } from "./layout";
import {
  DEFAULT_TMUX_WIDTH,
  getLiveMainWidth, getLiveLeftPaneWidth, getLiveRightPaneWidth,
  clampLeftWidth, clampLeftWidthAbsolute, clampSidebarWidth,
} from "./widths";
import { cancelPaste } from "./clipboard";
import type { LayoutState } from "./layout";
import { InputFieldComponent } from "./input-field";
import { sendMessage, pauseAgent, teamSend as ibTeamSend } from "../ib-commands";
import type { IbCommandResult } from "../ib-commands";
import { getResolvableWarnings } from "../health-check";
import { logToWatchLog } from "../watch-log";

// Re-export for test compatibility
export { AgentTreeComponent, formatAgentRow } from "./agent-tree";
export { RightPaneComponent, colorizeDiff, colorizeLog } from "./pane-manager";
export { SidebarComponent, SIDEBAR_WIDTH } from "./sidebar";
export { InfoPanelComponent } from "./info-panel";
export { FocusManager } from "./focus";
export type { FocusTarget } from "./focus";
export { InputFieldComponent } from "./input-field";
export { SystemDashboardComponent } from "./system-dashboard";
export type { Selection } from "./selection";

const DIALOG_WIDTH = 80;
const LEFT_WIDTH_STEP = 5;

// findLastTwoSeparators moved to wrap.ts — re-exported for external consumers
export { findLastTwoSeparators } from "./wrap";

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
  /** Whether to trim Claude's input separator from the bottom of output */
  trimInputSeparator = false;
  /** Lines below the last separator (status line), populated by parseStatusLines() */
  statusLines: string[] = [];
  /** When true, render output without requiring an agent (used for coordinator) */
  agentless = false;

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

  /**
   * Pre-compute status lines from rawOutput without rendering.
   * Extracts lines after the last ────────── separator in tmux output.
   * Call before render() so the dashboard can account for statusLines height.
   */
  parseStatusLines(width: number): void {
    this.statusLines = [];
    if (!this.trimInputSeparator || !this.rawOutput) return;

    const wrapped = wrapLines(this.rawOutput, width);

    // Codex emits full-width ─ section dividers between output blocks, so
    // findLastTwoSeparators (designed for Claude's input chrome) routinely
    // matches content dividers instead of the input box. For codex agents,
    // prefer the codex-specific detector — it anchors on the status bar and
    // the › prompt, which together unambiguously identify the input chrome.
    if (isCodexAgent(this.agent)) {
      const codexChrome = findCodexInputChrome(wrapped);
      if (codexChrome) {
        this.statusLines = wrapped.slice(codexChrome.statusIndex, codexChrome.endIndex + 1).map(
          (line) => truncateToWidth(line, width, "")
        );
      }
      return;
    }

    const { lowerIndex } = findLastTwoSeparators(wrapped);
    // Extract lines after the lower separator
    if (lowerIndex >= 0 && lowerIndex < wrapped.length - 1) {
      this.statusLines = wrapped.slice(lowerIndex + 1).map(
        (line) => truncateToWidth(line, width, "")
      );
      // Trim trailing blank lines — tmux capture-pane pads output to fill the pane height
      while (this.statusLines.length > 0 && this.statusLines[this.statusLines.length - 1]!.trim() === "") {
        this.statusLines.pop();
      }
    }
  }

  render(width: number): string[] {
    if (!this.agent && !this.agentless) {
      return padLines([truncateToWidth(`${DIM}No agent selected${RESET}`, width, "")], this.displayHeight);
    }

    // Agentless mode: simplified state handling (no clientAttached/stopped display)
    if (this.agentless) {
      if (!this.hasPolled) {
        return padLines([
          truncateToWidth(`${DIM}Waiting for output...${RESET}`, width, ""),
        ], this.displayHeight);
      }
      if (!this.rawOutput) {
        return padLines([
          truncateToWidth(`${YELLOW}Session stopped${RESET}`, width, ""),
          truncateToWidth(`${DIM}Press R to restart${RESET}`, width, ""),
        ], this.displayHeight);
      }
      // Fall through to normal output rendering below
    }

    // Show centered message when agent's tmux session is opened in an external terminal
    if (this.clientAttached && this.agent) {
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
    if (this.hasPolled && !this.rawOutput && this.agent) {
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

    if (!this.rawOutput && this.agent) {
      return padLines([
        truncateToWidth(`${BOLD}${this.agent.id}${RESET} ${DIM}(${this.agent.meta.tmux_session})${RESET}`, width, ""),
        truncateToWidth(`${DIM}Waiting for tmux output...${RESET}`, width, ""),
      ], this.displayHeight);
    }

    // Wrap lines to pane width
    let wrapped = wrapLines(this.rawOutput, width);

    // When showing our own input field, trim the CLI's native input area.
    // Claude's input area has two separator lines made of ─ characters, so we
    // find the last two ─ separators and slice at the upper one. Codex doesn't
    // use that double-separator chrome — it emits full-width ─ section
    // dividers between output blocks, so the Claude detector would mis-match
    // there. For codex, anchor on the › prompt + status bar instead.
    if (this.trimInputSeparator) {
      if (isCodexAgent(this.agent)) {
        const codexChrome = findCodexInputChrome(wrapped);
        if (codexChrome) {
          wrapped = wrapped.slice(0, codexChrome.promptIndex);
        }
      } else {
        const { upperIndex } = findLastTwoSeparators(wrapped);
        if (upperIndex >= 0 && upperIndex < wrapped.length) {
          wrapped = wrapped.slice(0, upperIndex);
        }
      }
    }

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

function isCodexAgent(agent: Agent | null): boolean {
  if (!agent) return false;
  try {
    return parseModel(agent.meta.model).cli === "codex";
  } catch {
    return false;
  }
}

function findCodexInputChrome(wrapped: string[]): { promptIndex: number; statusIndex: number; endIndex: number } | null {
  let endIndex = wrapped.length - 1;
  while (endIndex >= 0 && stripAnsi(wrapped[endIndex]!).trim() === "") {
    endIndex--;
  }
  if (endIndex < 0) return null;

  let promptIndex = -1;
  for (let i = endIndex; i >= 0; i--) {
    const line = stripAnsi(wrapped[i]!).trimStart();
    if (/^›(?:\s|$)/.test(line)) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex < 0) return null;

  let statusIndex = -1;
  for (let i = endIndex; i > promptIndex; i--) {
    if (isCodexStatusLine(stripAnsi(wrapped[i]!))) {
      statusIndex = i;
      break;
    }
  }
  if (statusIndex < 0) return null;

  return { promptIndex, statusIndex, endIndex };
}

/** Merge sidebar lines and main area lines side by side with a separator */
function mergeSidebarAndMain(
  sidebarLines: string[],
  mainLines: string[],
  height: number,
  mainWidth: number,
  sidebarWidth = SIDEBAR_WIDTH,
): string[] {
  const result: string[] = [];
  const count = Math.max(sidebarLines.length, mainLines.length, height);
  for (let i = 0; i < count; i++) {
    const sl = i < sidebarLines.length ? sidebarLines[i]! : "";
    const ml = i < mainLines.length ? mainLines[i]! : "";
    const leftPadded = padToWidth(sl, sidebarWidth);
    result.push(leftPadded + `${DIM_GRAY}│${RESET}` + truncateToWidth(ml, mainWidth, ""));
  }
  return result;
}

/** Pad a string to exact visible width, inserting RESET before padding if it has ANSI */
function padToWidth(str: string, width: number): string {
  const vw = visibleWidth(str);
  if (vw >= width) return truncateToWidth(str, width, "");
  const needsReset = str.includes("\x1b[");
  return str + (needsReset ? RESET : "") + " ".repeat(width - vw);
}

/** Status bar component */
class StatusBarComponent implements Component {
  pendingQuestions = 0;
  errorCount = 0;
  claudeUsage: UsageData | null = null;
  claudeUsageError = false;
  codexUsage: UsageData | null = null;
  codexUsageError = false;
  version = "";
  repoHeaderSelected = false;
  hasResolvableWarnings = false;

  invalidate(): void {}

  render(width: number): string[] {
    const qLabel = this.pendingQuestions > 0
      ? `q: questions (${this.pendingQuestions})`
      : "q: questions";
    const errBadge = this.errorCount > 0
      ? `  ${BOLD}${RED}[${this.errorCount} errors]${RESET}${DIM}`
      : "";
    const claudeUsageStr = this.formatUsage("claude", this.claudeUsage, this.claudeUsageError);
    const codexUsageStr = this.formatUsage("codex", this.codexUsage, this.codexUsageError);
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const versionStr = this.version ? `v${this.version}` : "";
    const row2Right = this.composeRight(codexUsageStr, versionStr ? `${DIM}${versionStr}${RESET}` : "");

    let row1Left: string;
    let row2Left: string;
    if (this.repoHeaderSelected) {
      const fixHint = this.hasResolvableWarnings ? "    f: fix" : "";
      row1Left = `${DIM}j/k: select    J/K: repo    ;/l: scroll    p/n: pane    ${qLabel}${errBadge}${RESET}`;
      row2Left = `${DIM}${timeStr}  @: jump    /: commands    a: new agent    ?: help    h: setup    A: add repo${fixHint}${RESET}`;
    } else {
      row1Left = `${DIM}j/k: select    J/K: repo    ;/l: scroll    p/n: pane    ${qLabel}    s: send    m: merge${errBadge}${RESET}`;
      row2Left = `${DIM}${timeStr}  @: jump    /: commands    a: new agent    ?: help    h: setup    x: kill${RESET}`;
    }

    const row1 = this.composeLine(row1Left, claudeUsageStr, width);
    const row2 = this.composeLine(row2Left, row2Right, width);

    return [row1, row2];
  }

  private composeLine(left: string, right: string, width: number): string {
    if (!right) return truncateToWidth(left, width, "");
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(right);
    const gap = Math.max(2, width - leftW - rightW - 1);
    return truncateToWidth(left + " ".repeat(gap) + right, width, "");
  }

  private composeRight(primary: string, secondary: string): string {
    if (primary && secondary) return `${primary}  ${secondary}`;
    return primary || secondary;
  }

  private formatUsage(label: "claude" | "codex", usage: UsageData | null, usageError: boolean): string {
    const prefix = usageError ? "⚠️  " : "";
    if (!usage) {
      return usageError ? `${YELLOW}⚠️  ${label} usage unavailable${RESET}` : "";
    }
    const parts: string[] = [];
    if (usage.sessionPct !== null) {
      const pct = usage.sessionPct;
      const color = pct > 90 ? RED : pct > 80 ? YELLOW : DIM;
      const reset = usage.sessionReset ? ` (${usage.sessionReset})` : "";
      parts.push(`${color}session:${pct}%${reset}${RESET}`);
    }
    if (usage.weeklyPct !== null) {
      const pct = usage.weeklyPct;
      const color = pct > 90 ? RED : pct > 80 ? YELLOW : DIM;
      const reset = usage.weeklyReset ? ` (${usage.weeklyReset})` : "";
      parts.push(`${color}weekly:${pct}%${reset}${RESET}`);
    }
    if (parts.length === 0) return "";
    return `${prefix}${label} ${parts.join("  ")}`;
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
        const wrapped = wordWrapLines(dialog.prompt, innerWidth);
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
      case "multi-select": {
        return buildMultiSelectContent(dialog, innerWidth);
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
        const { outputLines, hasScrollIndicator } = renderTextareaBlock(dialog.buffer, innerWidth, dialog.focusedButton === "text");
        lines.push(...outputLines);
        if (hasScrollIndicator) { lines.push(`${DIM}↑${RESET}`); }
        const sendLabel = dialog.focusedButton === "send" ? `${BOLD}${GREEN}[ Send ]${RESET}` : `[ Send ]`;
        const cancelLabel = dialog.focusedButton === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `[ Cancel ]`;
        const leftSide = `  ${cancelLabel}   ${sendLabel}`;
        if (dialog.onSendEsc) {
          const escLabel = dialog.focusedButton === "esc" ? `${BOLD}${GREEN}[ Send Esc ]${RESET}` : `[ Send Esc ]`;
          const rightPad = 2;
          const used = visibleWidth(leftSide) + visibleWidth(escLabel) + rightPad;
          const pad = Math.max(1, innerWidth - used);
          lines.push(`${leftSide}${" ".repeat(pad)}${escLabel}${" ".repeat(rightPad)}`);
        } else {
          lines.push(leftSide);
        }
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
      case "permissions-editor": {
        return buildPermissionsEditorContent(dialog, innerWidth);
      }
    }
  }
}

/** Minimum terminal width for sidebar layout */
export const MIN_TERMINAL_WIDTH = 140;
/** Minimum terminal height */
export const MIN_TERMINAL_HEIGHT = 24;

/** Main dashboard component that composes everything */
export class DashboardComponent implements Component {
  agentTree: AgentTreeComponent;
  /**
   * Teams tree component (§17.1) — shares the sidebar tree region with the
   * Agents tree, chosen by the current focus. Owns its OWN selection state
   * independent of the Agents tree (§17.1 independent-selection invariant).
   */
  teamsTree: TeamsTreeComponent;
  /**
   * Channel pane (§17.4) — the main-area chat box rendered when a team anchor
   * is the effective selection. `teamName` is null until selection-sync sets
   * it; the dashboard calls `channelPane.load()` on the refresh tick to keep
   * the chat current while the team stays selected.
   */
  channelPane: ChannelPaneComponent;
  /**
   * Team log pane — the right-side companion to `channelPane` in the Teams
   * view. Renders `<team>.log` (lifecycle/audit) while the chat box renders
   * `<team>.channel.jsonl`. Refreshed on the same tick as `channelPane`.
   */
  teamLogPane: TeamLogPaneComponent;
  rightPane: RightPaneComponent;
  tmuxPane: TmuxPaneComponent;
  splitPane: SplitPane;
  sidebar: SidebarComponent;
  infoPanel: InfoPanelComponent;
  private statusBar: StatusBarComponent;
  tui: TUI | null = null;
  modeIndex = 0;
  savedModeIndex = 0;
  private tmuxPoller: TmuxPoller;
  coordinatorPane: TmuxPaneComponent;
  private coordinatorPoller: TmuxPoller;
  /** Poller for per-repo coordinator tmux output. Active when a repo header is selected (REPO mode), captures into `rightPane.repoCoordinatorOutput` for full-main-width rendering. */
  private repoCoordinatorPoller: TmuxPoller;
  /** The tmux session currently being polled for repo coordinator */
  repoCoordinatorSession: string | null = null;
  currentAgentId: string | null = null;
  /** Repo path whose notes are currently loaded into the info-panel notes editor. */
  private notesEditorRepoPath: string | null = null;
  /** Snapshot of notes text taken when the user entered the notes sub-field — used to revert on Escape. */
  private notesEditorOriginal: string = "";
  _dialog: DialogState = null;
  private overlayHandle: OverlayHandle | null = null;
  private dialogOverlay: DialogOverlayComponent;
  watcher: AgentWatcher | null = null;
  repos: RepoEntry[] = [];
  private noticeCounter = 0;
  diffTool: string | undefined;
  /** Health report for the currently selected repo — used by ActionCtx */
  get healthReport(): import("../health-check").RepoHealthReport | undefined {
    const repoPath = this.agentTree.selectedRepoPath ?? (this.agentTree.selectedAgent?.repoPath ?? null);
    return repoPath && this.watcher ? this.watcher.healthReports.get(repoPath) : undefined;
  }
  private lastSentNotice: string | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Periodic channel-pane refresh timer (§17.4). Mirrors the TmuxPoller cadence
   * (~1s): when a team is selected (channelPane.teamName !== null) the timer
   * re-reads `<team>.channel.jsonl` + user.name and requests a render. Driving
   * this off a timer — NOT off render() — is what keeps the render path pure;
   * a load() inside render() would call requestRender on completion and spin.
   */
  private channelRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private telegramStatus: "red" | "yellow" | "green" | null = null;
  telegramStatusTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks in-flight executeAndRefresh promises — used by tests to await completion */
  private _pendingActions: Set<Promise<void>> = new Set();
  pendingSelectNewestInRepo: string | null = null;
  /**
   * Focus manager — public so structural-typed callers (the agent-actions
   * `ActionCtx` team-send branch and `@`-jump's `setFocus("agent-tree")`) can
   * read/write it through ctx without going through dashboard internals.
   */
  focusManager = new FocusManager();
  inputField: InputFieldComponent;
  coordinatorInputField: InputFieldComponent;
  repoCoordinatorInputField: InputFieldComponent;
  systemDashboard: SystemDashboardComponent;
  /** Which view to show in the main area when coordinator is selected */
  coordinatorViewMode: "TMUX" | "DASHBOARD" = "TMUX";
  /** Dynamic sidebar width — adjustable via [ ] when sidebar panel is focused */
  sidebarWidth = SIDEBAR_WIDTH;
  /**
   * Which tree the sidebar renders in its tree region — Phase 1 of the
   * three-axis model (see SPEC §17.1). Independent of focus and of the global
   * selection (Phase 2). Toggled exclusively by the `0` (teams) and `1`
   * (agents) keys; Tab cycling never changes it. Phase 3 makes Tab cycling
   * depend on `sidebarMode` — the dashboard mirrors this field into
   * `focusManager.sidebarMode` whenever it changes, so `FocusManager.cycle()`
   * picks the correct order (agents | teams).
   */
  sidebarMode: SidebarMode = "agents";
  /**
   * Which tree owns the GLOBAL selection — Phase 2 of the three-axis model
   * (see SPEC §17.1). Independent of `sidebarMode`. Updated whenever the user
   * navigates the visible tree (j/k/J/K) so that the navigated tree becomes
   * the active source. `0`/`1` (sidebar toggles) NEVER change this — the
   * global selection persists across visibility flips.
   *
   * `syncSelectedAgent` reads selection from whichever tree this names; the
   * info / main / right panes therefore follow the global selection rather
   * than the visible tree.
   *
   * Mirroring: on a `0`/`1` flip, the dashboard tries to mirror the agent
   * selection across trees for visual continuity (see
   * `mirrorSelectionToVisibleTree`). That is a VISUAL mirror only — it does
   * NOT change `activeSelectionSource`. The active source flips only when
   * the user navigates the visible tree.
   */
  activeSelectionSource: SidebarMode = "agents";
  /** When true, saved layout was applied — suppress onWidth overrides from tmux poller */
  private layoutRestored = false;
  /** Skip the next N tmux width reports to handle round-trip latency after resize */
  private skipWidthReports = 0;
  /** When true, resize all agent tmux sessions on next onUpdate (after layout restore) */
  private pendingTmuxResize = false;
  /**
   * One-time guard for the startup auto-select (§17.1, user-confirmed startup
   * behavior). On the FIRST populate where the flat list is non-empty, the
   * dashboard selects the first row (the old `ib watch` behavior). After it
   * fires once this stays true forever, so later refreshes never re-assert a
   * selection, and a panel focus toggle (Agents<->Teams) — which is NOT a
   * populate and does not call onUpdate — never trips it. The no-selection
   * state (§17.1) remains reachable via the panel toggle / @-jump.
   */
  private hasAutoSelectedFirstAgent = false;
  private _questionsFocused = false;
  /** Cache of which agents have an attached tmux client */
  private _clientAttached: Map<string, boolean> = new Map();
  private clientCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Read-only access to current focus target (for testing) */
  get focus(): FocusTarget {
    return this.focusManager.current();
  }

  /** Read-only access to current sub-focus state (for testing) */
  get subFocus(): SubFocus {
    return this.focusManager.subFocus;
  }

  /** Read-only access to whether questions list has focus (for testing) */
  get questionsFocused(): boolean {
    return this._questionsFocused;
  }

  /** Read-only access to whether the system-coordinator poller is running (for testing) */
  get coordinatorPollerRunning(): boolean {
    return this.coordinatorPoller.isRunning();
  }

  /** Read-only access to whether the per-repo coordinator poller is running (for testing) */
  get repoCoordinatorPollerRunning(): boolean {
    return this.repoCoordinatorPoller.isRunning();
  }

  /**
   * Inputs for the widths module — built fresh on each call so every field stays
   * current. Pass `termWidth` from `render(width)` so a TUI test that overrides
   * the width drives the same computation.
   */
  liveLayout(termWidth?: number): import("./widths").LayoutWidths {
    return {
      terminalWidth: termWidth ?? process.stdout.columns ?? 80,
      sidebarWidth: this.sidebarWidth,
      splitPaneLeftWidth: this.splitPane.getLeftWidth(),
    };
  }

  /** Width of the main area (middle + inner-separator + right). */
  getMainWidth(): number {
    return getLiveMainWidth(this.liveLayout());
  }

  /**
   * Width at which a per-repo coordinator should render and be sized — the full
   * main area, matching the system coordinator's behavior.
   */
  getRepoCoordinatorWidth(): number {
    return this.getMainWidth();
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
    this.teamsTree = new TeamsTreeComponent();
    this.channelPane = new ChannelPaneComponent();
    this.teamLogPane = new TeamLogPaneComponent();
    this.rightPane = new RightPaneComponent();
    this.tmuxPane = new TmuxPaneComponent();
    this.infoPanel = new InfoPanelComponent();
    this.statusBar = new StatusBarComponent();
    this.dialogOverlay = new DialogOverlayComponent(() => this._dialog, () => new Set(this.repos.map((r) => r.path)));

    this.coordinatorPane = new TmuxPaneComponent();
    this.systemDashboard = new SystemDashboardComponent();
    this.sidebar = new SidebarComponent(this.agentTree, this.infoPanel, this.teamsTree);
    this.sidebar.coordinatorPane = this.coordinatorPane;
    this.splitPane = new SplitPane(this.tmuxPane, this.rightPane, DEFAULT_TMUX_WIDTH, `${DIM_GRAY}│${RESET}`);
    this.inputField = new InputFieldComponent();
    this.inputField.onSubmit = (text: string) => {
      const agent = this.agentTree.selectedAgent;
      if (!agent || !text.trim()) return;
      this.executeAndRefresh(async () => {
        const result = await sendMessage(agent, text.trim(), { cwd: "/" });
        this.setNotice(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
      });
    };
    this.inputField.onCancel = () => {
      // clear() already called by InputFieldComponent before firing onCancel
      this.focusManager.setFocus("agent-tree");
      this.tui?.requestRender();
    };
    this.inputField.onAsyncRender = () => {
      this.tui?.requestRender();
    };

    this.coordinatorInputField = new InputFieldComponent();
    this.coordinatorInputField.onSubmit = (text: string) => {
      if (!text.trim()) return;
      const sanitized = sanitizeTmuxInput(text.trim());
      this.executeAndRefresh(async () => {
        // Route the inline coordinator input through sendToSystemCoordinator so
        // it shares the coordinator-home outbox queue + per-session lock with
        // `ib send @system`, watchdog @system notifications, and the `s`-key
        // dialog (handleSendToCoordinator) — concurrent writes to the single
        // ib-coordinator tmux session can no longer interleave. raw=true keeps
        // the historical verbatim send (no `[sent by ...]` prefix); cwd:"/" so
        // the sender isn't auto-stamped.
        const { sendToSystemCoordinator } = await import("../index");
        const sendResult = await sendToSystemCoordinator(sanitized, { raw: true, cwd: "/" });
        this.setNotice(sendResult.ok ? "Sent to coordinator" : "Failed to send to coordinator");
      });
    };
    this.coordinatorInputField.onCancel = () => {
      this.focusManager.setFocus("agent-tree");
      this.tui?.requestRender();
    };
    this.coordinatorInputField.onAsyncRender = () => {
      this.tui?.requestRender();
    };
    this.sidebar.coordinatorInputField = this.coordinatorInputField;

    this.repoCoordinatorInputField = new InputFieldComponent();
    this.repoCoordinatorInputField.onSubmit = (text: string) => {
      const agent = this.rightPane.repoCoordinatorAgent;
      if (!agent || !text.trim()) return;
      this.executeAndRefresh(async () => {
        const result = await sendMessage(agent, text.trim(), { cwd: "/" });
        this.setNotice(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
      });
    };
    this.repoCoordinatorInputField.onCancel = () => {
      this.focusManager.setFocus("agent-tree");
      this.tui?.requestRender();
    };
    this.repoCoordinatorInputField.onAsyncRender = () => {
      this.tui?.requestRender();
    };
    this.infoPanel.notesEditor.onAsyncRender = () => {
      this.tui?.requestRender();
    };

    this.tmuxPoller = new TmuxPoller({
      onOutput: (raw, _stripped) => {
        this.tmuxPane.rawOutput = raw;
        this.tmuxPane.hasPolled = true;
        this.tui?.requestRender();
      },
      onWidth: (width) => {
        // When the system coordinator is selected, the tmux poller polls the
        // coordinator session which runs at full mainWidth. Ignore its width
        // reports — they would corrupt the agent splitPaneLeftWidth.
        if (this.agentTree.isSystemCoordinatorSelected) return;
        // Skip stale width reports during tmux resize round-trip
        if (this.skipWidthReports > 0) {
          this.skipWidthReports--;
          return;
        }
        // When a saved layout was restored, the dashboard width is authoritative.
        // Skip tmux-reported width to avoid overriding the saved value during the
        // race window before resizeTmuxWindow takes effect on the agent's session.
        if (this.layoutRestored) return;
        const clamped = clampLeftWidthAbsolute(width);
        if (clamped !== this.splitPane.getLeftWidth()) {
          this.splitPane.setLeftWidth(clamped);
          this.tui?.requestRender();
          this.persistLayout();
        }
      },
    });

    // System coordinator poller — continuously polls the ib-coordinator tmux session
    this.coordinatorPoller = new TmuxPoller({
      onOutput: (raw, _stripped) => {
        this.coordinatorPane.rawOutput = raw;
        this.coordinatorPane.hasPolled = true;
        this.tui?.requestRender();
      },
    });
    this.coordinatorPoller.setAgent(IB_COORDINATOR_SESSION);

    // Per-repo coordinator poller — polls the coordinator agent's tmux session
    // when a repo header is selected (REPO mode). The captured output renders
    // at full main width, same as the system coordinator (not right-pane-only).
    this.repoCoordinatorPoller = new TmuxPoller({
      onOutput: (raw, _stripped) => {
        this.rightPane.repoCoordinatorOutput = raw;
        this.rightPane.repoCoordinatorHasPolled = true;
        this.tui?.requestRender();
      },
    });
  }

  setTui(tui: TUI) {
    this.tui = tui;
  }

  /** Apply a saved layout state to restore panel sizes, clamping to valid ranges. */
  applyLayout(layout: LayoutState) {
    this.sidebarWidth = clampSidebarWidth(layout.sidebarWidth);
    resizeCoordinatorTmux(this.getMainWidth());
    this.splitPane.setLeftWidth(clampLeftWidthAbsolute(layout.splitPaneLeftWidth));
    this.sidebar.heightOffsets = { ...layout.heightOffsets };
    if (layout.repoCoordinatorHeightOffset !== undefined) {
      this.rightPane.repoCoordinatorHeightOffset = layout.repoCoordinatorHeightOffset;
    }
    // §7.7 load-time safety net: use process.stdout.rows as a proxy for displayHeight to
    // reject grossly invalid offsets from corrupted or oversized-terminal layout files.
    // computeSidebarHeights needs actual displayHeight, but we don't have it yet, so use
    // terminal rows as an approximation (slightly higher than actual displayHeight).
    const approxHeight = process.stdout.rows ?? 24;
    const approxBase = computeSidebarHeights(approxHeight, 1);
    clampSidebarOffsets(approxBase, this.sidebar.heightOffsets);
    this.layoutRestored = true;
    this.pendingTmuxResize = true;
  }

  /** Persist current layout via debounced write. */
  persistLayout() {
    saveLayoutDebounced({
      sidebarWidth: this.sidebarWidth,
      splitPaneLeftWidth: this.splitPane.getLeftWidth(),
      heightOffsets: { ...this.sidebar.heightOffsets },
      repoCoordinatorHeightOffset: this.rightPane.repoCoordinatorHeightOffset,
    });
  }

  /** Set the terminal window title via OSC 0. Extracted for testability. */
  setTerminalTitle(title: string) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }

  startPolling() {
    // The selected-agent poller is always running — its output drives the main
    // tmux pane in normal mode (and the coordinator session when the system
    // coordinator is selected, via setAgent in syncSelectedAgent).
    this.tmuxPoller.start();
    // The coordinator and repo-coordinator pollers only spawn `tmux capture-pane`
    // when their panes are actually visible. updatePollerVisibility() starts the
    // ones that should be live now and leaves the rest stopped (saves a tmux
    // spawn/sec per hidden pane).
    this.updatePollerVisibility();
    this.refreshUsage();
    this.usageTimer = setInterval(() => this.refreshUsage(), 240_000);
    // §17.4 channel-pane refresh tick (~1s, matches TmuxPoller cadence). Only
    // does work when a team is selected (refreshChannel returns immediately on
    // null teamName), so the cost when not on the Teams tab is one no-op call.
    this.channelRefreshTimer = setInterval(() => {
      void this.refreshChannel();
    }, 1000);
  }

  stopPolling() {
    this.tmuxPoller.stop();
    this.coordinatorPoller.stop();
    this.repoCoordinatorPoller.stop();
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
    if (this.channelRefreshTimer) {
      clearInterval(this.channelRefreshTimer);
      this.channelRefreshTimer = null;
    }
    if (this.clientCheckTimer) {
      clearInterval(this.clientCheckTimer);
      this.clientCheckTimer = null;
    }
    if (this.telegramStatusTimer) {
      clearInterval(this.telegramStatusTimer);
      this.telegramStatusTimer = null;
    }
    // Watchdog runs as standalone process — do NOT stop it when TUI closes
  }

  /**
   * Pause/resume the coordinator pollers based on whether their panes are
   * actually on screen. Each TmuxPoller spawns `tmux capture-pane` every ~1s
   * while running, so a poller whose output isn't visible is pure waste — it
   * burns a posix_spawn/sec for a pane the user can't see.
   *
   * - The system-coordinator pane (`coordinatorPoller`) is only shown when the
   *   system coordinator is selected AND its view mode is TMUX (the DASHBOARD
   *   view renders a static agent table, not tmux output).
   * - The per-repo coordinator pane (`repoCoordinatorPoller`) is only shown in
   *   REPO mode when the selected repo has a coordinator agent.
   *
   * resume() fires an immediate poll, so a pane that just became visible is not
   * stale for up to 1s. The always-on selected-agent `tmuxPoller` is untouched.
   */
  private updatePollerVisibility() {
    // §17.1 Phase 2: gate the system coordinator poller on the active source
    // matching the render path. A stale coord pointer in the (inactive)
    // Agents tree must not keep the coordinator tmux poller running while
    // the Teams tree is driving the main area — the coordinator pane is not
    // visible, so polling it is wasted work (and would also fight the team
    // channel for the main area in the render-aware paths).
    const coordinatorVisible =
      this.activeSelectionSource === "agents"
      && this.agentTree.isSystemCoordinatorSelected
      && this.coordinatorViewMode === "TMUX";
    if (coordinatorVisible) {
      this.coordinatorPoller.resume();
    } else if (this.coordinatorPoller.isRunning()) {
      this.coordinatorPoller.stop();
    }

    const repoCoordinatorVisible =
      this.rightPane.mode === "REPO" && this.rightPane.repoCoordinatorAgent != null;
    if (repoCoordinatorVisible) {
      this.repoCoordinatorPoller.resume();
    } else if (this.repoCoordinatorPoller.isRunning()) {
      this.repoCoordinatorPoller.stop();
    }
  }

  private refreshUsage() {
    fetchUsage()
      .then((result) => {
        this.statusBar.claudeUsage = result.data;
        this.statusBar.claudeUsageError = result.error;
        this.tui?.requestRender();
      })
      .catch(() => {
        this.statusBar.claudeUsageError = true;
        this.tui?.requestRender();
      });

    fetchCodexUsage()
      .then((result) => {
        this.statusBar.codexUsage = result.data;
        this.statusBar.codexUsageError = result.error;
        this.tui?.requestRender();
      })
      .catch(() => {
        this.statusBar.codexUsageError = true;
        this.tui?.requestRender();
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

  setTelegramStatus(status: "red" | "yellow" | "green" | null): void {
    this.telegramStatus = status;
    this.tui?.requestRender();
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
    const width = dialog.width
      ?? (dialog.type === "help" ? 72
        : (dialog.type === "folder-browser" || dialog.type === "new-agent-form" || dialog.type === "setup" || dialog.type === "permissions-editor" || dialog.type === "multi-select") ? 70
        : DIALOG_WIDTH);
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
    const p = (async () => {
      try {
        await fn();
      } catch (err) {
        this.setNotice(`Error: ${err}`);
      }
      this.watcher?.refresh();
    })();
    this._pendingActions.add(p);
    p.finally(() => this._pendingActions.delete(p));
    await p;
  }

  /** Wait for all in-flight executeAndRefresh calls to complete. For use in tests. */
  async flushPendingActions(): Promise<void> {
    while (this._pendingActions.size > 0) {
      await Promise.allSettled(this._pendingActions);
    }
  }

  // --- Pane management (delegates to pane-manager.ts) ---

  jumpToMode(mode: PaneMode, forceRefresh = false) {
    jumpToMode(this, mode, forceRefresh);
    // Entering/leaving REPO mode changes whether the per-repo coordinator pane
    // is visible — pause/resume its poller to match.
    this.updatePollerVisibility();
  }

  /** Reload AGENT LOG tail-window (or skip via cache) — called from scroll/resize handlers. */
  loadAgentLogIfNeeded() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    void loadAgentLog(this, agent);
  }

  private cyclePaneMode(delta: number) {
    cyclePaneMode(this, delta);
    // cyclePaneMode skips REPO (only entered via repo-header selection), but
    // keep the visibility sync here for symmetry with jumpToMode in case the
    // active mode changed.
    this.updatePollerVisibility();
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
      { label: "nickname agent — N", action: () => agentActions.handleRename(this) },
      { label: "new agent — a", action: () => agentActions.handleNewAgent(this) },
      { label: "open worktree — w", action: () => agentActions.handleOpenWorktree(this) },
      { label: "open diff in tool — o", action: () => agentActions.handleOpenDiffTool(this) },
      { label: "open in Ghostty (repo/worktree) — G", action: () => agentActions.handleOpenGhostty(this) },
      { label: "open in Ghostty (Claude tmux) — C", action: () => agentActions.handleOpenGhosttyTmux(this) },
      { label: "debug snapshot — S", action: () => agentActions.handleSnapshot(this) },
      { label: "fuzzy jump to agent/repo — @", action: () => agentActions.handleFuzzyAgent(this) },
      { label: "add repo — A", action: () => agentActions.handleAddRepo(this) },
      { label: "remove repo — D", action: () => this.executeAndRefresh(() => agentActions.handleRemoveRepoSafe(this)) },
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
    // §17.1 (user-confirmed startup behavior): on the VERY FIRST populate with a
    // non-empty list, auto-select the first row — the old `ib watch` default.
    // One-time guard: after it fires, later refreshes preserve the user's
    // selection (or no-selection), and a panel focus toggle (Agents<->Teams) —
    // which is not a populate — never auto-selects.
    if (!this.hasAutoSelectedFirstAgent && flatList.length > 0) {
      this.agentTree.selectFirstRow();
      this.hasAutoSelectedFirstAgent = true;
    }
    this.systemDashboard.flatList = flatList;
    this.rightPane.questions = questions;
    this.rightPane.allAgents = flatList;
    this.rightPane.orphanedTmuxSessions = orphanedTmuxSessions;
    this.statusBar.pendingQuestions = questions.length;
    this.statusBar.errorCount = this.rightPane.errors.length + orphanedTmuxSessions.length;

    // §17.2: rebuild the Teams tree's flat list from the already-state-detected
    // agents (reuse the watcher's pass — no second detect). listTeams() is async;
    // schedule the load and apply when ready (selection-sync still runs sync).
    void this.refreshTeamsTree(agents);

    // §17.4: feed channel-pane the current id → repoName map so chat lines
    // render `[sent by <repoName>/<agentId>]:` for real-agent senders. Built
    // from `agents` (not `flatList`, which interleaves repo-header rows) so the
    // lookup is uniform across teams. Agents absent from the map (archived,
    // cross-coordinator, unknown) fall through to the bare-id form in the
    // pane's renderer — no crash, no stray slash.
    const repoByAgent = new Map<string, string>();
    for (const agent of agents) repoByAgent.set(agent.id, agent.repoName);
    this.channelPane.agentRepoById = repoByAgent;

    // Wire health reports to agent tree
    if (this.watcher) {
      this.agentTree.healthReports = this.watcher.healthReports;
    }

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

    // After layout restore, resize all agent tmux sessions to match the restored splitPaneLeftWidth
    if (this.pendingTmuxResize && flatList.length > 0) {
      this.pendingTmuxResize = false;
      // Re-validate splitPaneLeftWidth against current terminal width via the
      // widths module so a too-large saved value can't push the right pane off-screen.
      const validWidth = clampLeftWidth(this.getMainWidth(), this.splitPane.getLeftWidth());
      if (validWidth !== this.splitPane.getLeftWidth()) {
        this.splitPane.setLeftWidth(validWidth);
      }
      const width = validWidth;
      for (const entry of flatList) {
        if (entry.kind === "agent" && entry.agent.meta.tmux_session) {
          resizeTmuxWindow(entry.agent.meta.tmux_session, width);
        }
      }
      // Clear layoutRestored after resize is issued. Skip the next 2 width reports to handle
      // round-trip latency: one may catch the pre-resize width, the next catches post-resize.
      this.layoutRestored = false;
      this.skipWidthReports = 2;
    }

    this.syncSelectedAgent();
    this.tui?.requestRender();
  }

  syncSelectedAgent() {
    // §17.1 Phase 2 (refined): before the effective-selection resolver runs,
    // push the active source's selection into the INACTIVE tree (or deselect
    // it when there's no counterpart). This keeps both trees pointing at the
    // same effective selection whenever possible, so the render layer can
    // highlight matched-mirror rows in BOTH trees without a separate
    // suppression flag. Called here (the single dashboard-wide "selection
    // changed" chokepoint) so every entry point — j/k, 0/1, @-fuzzy, g-go-
    // to-question — re-mirrors automatically.
    this.mirrorSelectionToVisibleTree();
    // §17.3: effective-selection resolver. Phase 2 of the three-axis model
    // (SPEC §17.1): the EFFECTIVE selection is sourced from whichever tree
    // owns the GLOBAL selection (`activeSelectionSource === "teams"` → Teams
    // tree, otherwise the Agents tree). This is INDEPENDENT of `sidebarMode`
    // (which tree is currently visible). Toggling `0`/`1` flips visibility but
    // not selection; navigating the visible tree (j/k) flips active source to
    // that tree. The downstream routing runs on this single effective
    // selection — so a `{ kind: "agent" }` selected in the Teams tree (a team
    // member) behaves identically to selecting that same agent in the Agents
    // tree (§17.3 child-agent-indistinguishable). The Agents-tree-only
    // concepts (repo header, system coordinator) are routed from the Agents
    // tree only — they are not reachable through the Teams tree.
    const teamsActive = this.activeSelectionSource === "teams";
    const teamSelection = teamsActive ? this.teamsTree.selection : null;
    const teamAnchor = teamSelection?.kind === "team" ? teamSelection.teamName : null;
    const teamMemberAgent = teamSelection?.kind === "agent" ? teamSelection.agent : null;
    // The Agents-tree-only properties (repo header, system coordinator) are
    // unreachable from the Teams panel. When the Teams tree owns the active
    // selection we suppress them so a leftover repo-header selection in the
    // (inactive) Agents tree doesn't bleed into the main area.
    const selected = teamsActive
      ? teamMemberAgent
      : this.agentTree.selectedAgent;
    const isCoordinator = !teamsActive && this.agentTree.isSystemCoordinatorSelected;
    const selectedRepoHeader = teamsActive ? null : this.agentTree.selectedRepoHeader;
    const selectedRepoPath = teamsActive ? null : this.agentTree.selectedRepoPath;

    // Update focus cycling for coordinator mode
    this.focusManager.coordinatorMode = isCoordinator;

    // When entering coordinator mode (transition, not every tick), reset view and focus
    const wasCoordinator = this.currentAgentId === "__coordinator__";
    if (isCoordinator && !wasCoordinator) {
      this.coordinatorViewMode = "TMUX";
      const focus = this.focusManager.current();
      if (focus !== "agent-tree" && focus !== "info" && focus !== "coordinator") {
        this.focusManager.setFocus("agent-tree");
      }
      // Reassert coordinator tmux width on selection (mirrors the agent path
      // at the bottom of this method). tmux can drift the window size when
      // clients with different terminal sizes attach/detach; agents get
      // re-resized on every selection change, so without this the system
      // coordinator was the only session whose drift wasn't corrected on
      // selection.
      resizeCoordinatorTmux(this.getMainWidth());
    }

    this.rightPane.agent = selected;
    this.rightPane.selectedRepoHeader = selectedRepoHeader;
    this.tmuxPane.agent = selected;
    this.statusBar.repoHeaderSelected = !selected && !isCoordinator && selectedRepoHeader !== null;

    // Wire info panel
    this.infoPanel.agent = selected;
    this.infoPanel.isSystemCoordinatorSelected = isCoordinator;
    this.infoPanel.selectedRepoHeader = selectedRepoHeader;
    this.infoPanel.selectedRepoPath = selectedRepoPath;
    this.infoPanel.allAgents = this.agentTree.flatList;
    if (this.watcher) {
      this.infoPanel.liveTmuxSessions = this.watcher.lastLiveTmuxSessions;
    }

    // §17.3c / §17.4 team-mode wiring. On a team-anchor effective selection
    // (only reachable via the Teams panel) populate `infoPanel.selectedTeam`
    // and `channelPane.teamName` from the Team record; on ANY non-team
    // effective selection (agent, repo header, system coord, null) clear both
    // so no stale team metadata or channel lingers.
    if (teamAnchor) {
      const previousTeam = this.channelPane.teamName;
      this.channelPane.teamName = teamAnchor;
      this.teamLogPane.teamName = teamAnchor;
      if (previousTeam !== teamAnchor) {
        this.channelPane.resetForTeam();
        this.teamLogPane.resetForTeam();
        // Fire an immediate channel refresh so the chat box appears instantly
        // on selection rather than waiting up to one channelRefreshTimer tick.
        // The same refresh tick reloads the team log via refreshChannel().
        void this.refreshChannel();
      }
      // Async fetch the Team record for the info panel. Fire-and-forget so the
      // sync path stays sync; on completion we set the field and request a
      // render. If the team is gone between the tree build and here, clear.
      void this.refreshSelectedTeamInfo(teamAnchor);
    } else {
      this.infoPanel.selectedTeam = null;
      this.channelPane.teamName = null;
      this.teamLogPane.teamName = null;
    }

    // Wire default-agent-type
    this.infoPanel.availableAgentTypes = listSpawnableTypeNamesSync();
    const repoForDefault = selectedRepoPath
      ? this.repos.find((r) => r.path === selectedRepoPath)
      : undefined;
    this.infoPanel.selectedRepoDefaultAgentType = repoForDefault?.defaultAgentType;

    // Wire notes editor — if the selected repo changed, flush any pending edits
    // for the previous repo, then load the new repo's notes.
    const newNotesRepoPath = selectedRepoPath ?? null;
    if (newNotesRepoPath !== this.notesEditorRepoPath) {
      if (this.notesEditorRepoPath) {
        const pending = this.infoPanel.notesEditor.getText();
        if (pending !== this.notesEditorOriginal) {
          void this.persistNotes(this.notesEditorRepoPath, pending);
        }
      }
      this.notesEditorRepoPath = newNotesRepoPath;
      const initial = repoForDefault?.notes ?? "";
      this.infoPanel.notesEditor.setText(initial);
      this.notesEditorOriginal = initial;
      // If the new selection isn't a repo header, drop notes sub-focus.
      if (!newNotesRepoPath && this.infoPanel.subField === "notes") {
        this.infoPanel.subField = "default-type";
      }
    }

    // Wire health data to info panel and right pane
    const healthRepoPath = selectedRepoPath ?? (selected?.repoPath ?? null);
    const healthReport = healthRepoPath && this.watcher ? this.watcher.healthReports.get(healthRepoPath) : undefined;
    this.infoPanel.healthReport = healthReport;
    this.rightPane.healthReport = healthReport;
    this.statusBar.hasResolvableWarnings = !!(healthReport && getResolvableWarnings(healthReport.warnings).length > 0);

    // Find and wire per-repo coordinator for the selected repo
    const repoPathForCoordinator = selectedRepoPath;
    if (repoPathForCoordinator && !selected && !isCoordinator) {
      // Repo header is selected — find coordinator agent from the full agent list
      // (coordinators are filtered out of flatList, so search lastAgents directly)
      const coordAgent = this.watcher?.lastAgents.find(
        a => a.repoPath === repoPathForCoordinator && a.meta.agentType === "coordinator"
      );
      this.rightPane.repoCoordinatorAgent = coordAgent ?? null;
      this.infoPanel.repoCoordinatorAgent = coordAgent ?? null;
      const tmuxSession = coordAgent?.meta.tmux_session ?? null;
      if (tmuxSession !== this.repoCoordinatorSession) {
        this.repoCoordinatorSession = tmuxSession;
        this.rightPane.repoCoordinatorOutput = null;
        this.rightPane.repoCoordinatorHasPolled = false;
        this.rightPane.repoCoordinatorScrollBack = 0;
        this.repoCoordinatorPoller.setAgent(tmuxSession);
        // Resize repo coordinator tmux to mainWidth — per-repo coordinators render
        // full-pane (same behavior as the system coordinator), not right-pane-only.
        if (tmuxSession) {
          const w = this.getRepoCoordinatorWidth();
          if (w > 0) resizeTmuxWindow(tmuxSession, w);
        }
      }
    } else {
      // Not a repo header — clear coordinator state
      this.rightPane.repoCoordinatorAgent = null;
      this.infoPanel.repoCoordinatorAgent = null;
      if (this.repoCoordinatorSession) {
        this.repoCoordinatorSession = null;
        this.rightPane.repoCoordinatorOutput = null;
        this.rightPane.repoCoordinatorHasPolled = false;
        this.rightPane.repoCoordinatorScrollBack = 0;
        this.repoCoordinatorPoller.setAgent(null);
      }
    }

    // Auto-switch to/from REPO mode based on selection.
    // TREE mode is preserved across selection changes so the user can browse the
    // full agent tree regardless of what's selected.
    const currentMode = PANE_MODES[this.modeIndex];
    if (!selected && !isCoordinator && selectedRepoHeader && currentMode !== "TREE") {
      // Repo header selected — save current mode and switch to REPO
      if (currentMode !== "REPO") {
        this.savedModeIndex = this.modeIndex;
      }
      jumpToMode(this, "REPO");
    } else if ((selected || isCoordinator) && currentMode === "REPO") {
      // Agent or coordinator selected while in REPO mode — restore previous mode
      // Fall back to AGENT LOG if saved mode would be empty (ERRORS/QUESTIONS with no content)
      const savedMode = PANE_MODES[this.savedModeIndex]!;
      const wouldSkip =
        (savedMode === "ERRORS" && this.rightPane.errors.length === 0 && this.rightPane.orphanedTmuxSessions.length === 0) ||
        (savedMode === "QUESTIONS" && this.rightPane.questions.length === 0);
      jumpToMode(this, wouldSkip ? "AGENT LOG" : savedMode);
    }

    // Update skip targets: repo-coordinator is only available in REPO mode with a coordinator
    const repoCoordAvailable = this.rightPane.mode === "REPO" && this.rightPane.repoCoordinatorAgent != null;
    if (repoCoordAvailable) {
      this.focusManager.skipTargets.delete("repo-coordinator");
    } else {
      this.focusManager.skipTargets.add("repo-coordinator");
      // If currently focused on repo-coordinator but it's no longer available, move to agent-tree
      if (this.focusManager.current() === "repo-coordinator") {
        this.focusManager.setFocus("agent-tree");
      }
    }
    // Switch repo coordinator input field agent
    this.repoCoordinatorInputField.switchAgent(
      this.rightPane.repoCoordinatorAgent?.id ?? null
    );

    // Determine the effective ID for change detection
    const newId = isCoordinator ? "__coordinator__" : (selected?.id ?? null);
    if (newId !== this.currentAgentId) {
      this.currentAgentId = newId;
      this.setTerminalTitle(isCoordinator ? "ib: coordinator" : (selected ? `ib: ${selected.id}` : "ib"));
      this.tmuxPane.resetForAgent();
      this.inputField.switchAgent(newId);
      this.coordinatorInputField.switchAgent(isCoordinator ? "__coordinator__" : null);
      this.rightPane.agentLogContent = null;
      this.rightPane.loadedLogWindow = null;
      this.rightPane.agentLogLoading = false;
      this.rightPane.promptContent = null;
      this.rightPane.denialsContent = null;
      this.rightPane.denialsLoading = false;
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
        // Resize the newly selected agent's tmux to match the current middle pane.
        resizeTmuxWindow(selected.meta.tmux_session, getLiveLeftPaneWidth(this.liveLayout()));
      }
    }

    this.rightPane.updateContent();
    triggerAsyncLoadIfNeeded(this);
    // Route tmux poller: system coordinator uses IB_COORDINATOR_SESSION
    const tmuxSession = isCoordinator
      ? IB_COORDINATOR_SESSION
      : (selected?.meta.tmux_session ?? null);
    this.tmuxPoller.setAgent(tmuxSession);
    // Selection (and the REPO-mode auto-switch above) may have changed which
    // coordinator pane is visible — pause/resume those pollers accordingly so
    // we don't spawn `tmux capture-pane` for off-screen panes.
    this.updatePollerVisibility();
  }

  /**
   * §17.3a `teamSend` ctx field — bound to the dashboard's `this.repos`. This
   * is the function the `s`-send team-target branch in agent-actions calls; we
   * wrap `ibTeamSend` so handlers don't need a repos handle of their own. Use
   * an arrow property so `this` is preserved when invoked through the ctx.
   */
  teamSend = (
    teamName: string,
    members: Agent[],
    message: string,
    opts: { fromAgent?: string } | undefined,
  ): Promise<IbCommandResult> => {
    return ibTeamSend(teamName, members, message, opts, this.repos);
  };

  /**
   * §17.1 Phase 2: ctx setters bound to the dashboard. Arrow properties so
   * `this` is preserved when invoked through the ctx. They write to the
   * dashboard's `activeSelectionSource` / `sidebarMode` fields and are used
   * by the `@`-fuzzy jump and `g`-go-to-question-agent handlers (which need
   * to force the Agents tree into the active-selection role + visible).
   */
  setActiveSelectionSource = (source: SidebarMode): void => {
    this.activeSelectionSource = source;
  };

  setSidebarMode = (mode: SidebarMode): void => {
    this.sidebarMode = mode;
    // §17.1 Phase 3: keep the FocusManager's sidebarMode in sync so Tab
    // cycling picks the correct order. The `0`/`1` handlers do this too;
    // mirroring it here covers the `@`-fuzzy jump and `g`-go-to-question-agent
    // paths that flip sidebarMode through this setter.
    this.focusManager.sidebarMode = mode;
  };

  /**
   * §17.1 Phase 2 mirror — visual continuity across a sidebar toggle.
   *
   * When the user flips `sidebarMode` (`0`/`1`), the global selection
   * (`activeSelectionSource`) is preserved unchanged. To keep the user
   * oriented, we ALSO try to mirror the active agent into the newly visible
   * tree so it lights up the same row visually. The active selection itself
   * still lives in the original tree — this is a *visual* mirror, not a
   * source-of-truth change.
   *
   * Rules (per the user's Phase 2 spec, refined):
   *  - Active selection is an AGENT:
   *      * The ACTIVE tree already holds the canonical selection (j/k set it).
   *      * The INACTIVE tree: try to find the SAME agent and select it there
   *        too (so both trees light up the same row when possible). When the
   *        agent has no counterpart row (e.g. it's not a member of any team
   *        on the Teams side, or its row hasn't been built on the Agents side
   *        yet), `deselect()` the inactive tree so no stale highlight lingers.
   *      * Visually: BOTH trees highlight the same agent when it appears in
   *        both; only the active tree highlights when it appears in just one.
   *  - Active selection is a TEAM anchor: the Agents tree has no team-anchor
   *    row, so the inactive Agents tree is `deselect()`ed.
   *  - Active selection is a REPO HEADER or SYSTEM COORDINATOR: lives only in
   *    the Agents tree; the inactive Teams tree is `deselect()`ed.
   *  - Null active selection: deselect the inactive tree too.
   *
   * Called from BOTH the `0`/`1` sidebar-toggle handlers AND the j/k/J/K
   * navigation handlers — every path that changes the effective selection
   * re-mirrors so the inactive tree never holds a stale pointer (which used
   * to be papered over by suppressing its highlight; now we keep the trees
   * actually in sync instead).
   */
  private mirrorSelectionToVisibleTree(): void {
    if (this.activeSelectionSource === "agents") {
      // Agents tree owns the active selection; mirror into the Teams tree.
      const sel = this.agentTree.selection;
      if (sel?.kind === "agent") {
        if (!this.teamsTree.selectMemberByAgentId(sel.agent.id)) {
          this.teamsTree.deselect();
        }
      } else {
        // Repo header, system coordinator, or null — no Teams counterpart.
        this.teamsTree.deselect();
      }
      return;
    }
    // activeSelectionSource === "teams" — Teams tree owns selection.
    const sel = this.teamsTree.selection;
    if (sel?.kind === "agent") {
      if (!this.agentTree.selectAgentById(sel.agent.id)) {
        this.agentTree.deselect();
      }
    } else {
      // Team anchor or null — no Agents counterpart.
      this.agentTree.deselect();
    }
  }

  /**
   * §17.2: rebuild the Teams tree from the team registry + the already-state-
   * detected agents passed to onUpdate (no second detect pass — the watcher
   * already ran it). listTeams() is async, so this is fire-and-forget; on
   * completion it sets the flat list and triggers a re-render.
   */
  private async refreshTeamsTree(agents: Agent[]): Promise<void> {
    try {
      const teams = await listTeams();
      const agentsById = new Map<string, Agent>();
      for (const a of agents) agentsById.set(a.id, a);
      const list = flattenTeamsTree(teams, agentsById);
      this.teamsTree.setFlatList(list);
      // If we currently render the Teams panel, request a re-render so the
      // refreshed list shows up immediately. (Cheap no-op when not focused.)
      this.tui?.requestRender();
    } catch {
      // Best-effort: a teams-registry read failure must never break the dashboard
      // refresh loop. Leave the tree's last list in place.
    }
  }

  /**
   * §17.3c: async-fetch the Team record for a team-anchor selection and populate
   * `infoPanel.selectedTeam`. Fire-and-forget from syncSelectedAgent so the
   * sync path stays sync. If the team has vanished by the time the read lands,
   * clears the field — but only if the user is still on the same team anchor
   * (a fast-toggle race shouldn't blow away a freshly-selected team's metadata).
   */
  private async refreshSelectedTeamInfo(teamName: string): Promise<void> {
    let team: Team | null = null;
    try {
      team = await getTeam(teamName);
    } catch {
      // ignore — leave stale (or absent) team info untouched
      return;
    }
    // Race guard: if the user has navigated away from this team, do nothing.
    if (this.channelPane.teamName !== teamName) return;
    if (team) {
      // §17.2/§17.3c: show the LIVE (resolvable) member count, matching the
      // tree badge. team.members is the raw roster (which can include
      // not-yet-pruned dead ids); the teams-tree header row already carries the
      // live count via flattenTeamsTree, so reuse it. Fall back to the raw
      // count only if the team isn't in the tree (transient, between rebuilds).
      let liveCount = team.members.length;
      for (const row of this.teamsTree.flatList) {
        if (row.kind === "team-header" && row.teamName === teamName) {
          liveCount = row.memberCount;
          break;
        }
      }
      this.infoPanel.selectedTeam = {
        name: teamName,
        createdEpoch: team.created_epoch,
        createdBy: team.created_by,
        memberCount: liveCount,
      };
    } else {
      this.infoPanel.selectedTeam = null;
    }
    this.tui?.requestRender();
  }

  /**
   * Refresh the channel pane's cached messages + user.name (§17.4). Driven off
   * `channelRefreshTimer` (and a one-shot on team-selection change) — NOT off
   * render(), which would create a load→requestRender→render loop. No-op when
   * no team is selected. Snapshots `teamName` at entry so a fast team-switch
   * during the await won't request a render that no longer matches the user's
   * selection (the channelPane.load itself also race-guards internally).
   */
  private async refreshChannel(): Promise<void> {
    const teamName = this.channelPane.teamName;
    if (!teamName) return;
    try {
      // Load chat + log in parallel — both feed the side-by-side Teams view.
      await Promise.all([
        this.channelPane.load(),
        this.teamLogPane.load(),
      ]);
    } catch {
      return;
    }
    if (this.channelPane.teamName !== teamName) return;
    this.tui?.requestRender();
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

  /** Persist a new default-agent-type for the currently selected repo header. */
  private async persistDefaultAgentType(newType: string | null): Promise<void> {
    const repoPath = this.agentTree.selectedRepoPath;
    if (!repoPath) return;
    const repo = this.repos.find((r) => r.path === repoPath);
    if (!repo) return;
    const result = await setRepoDefaultAgentType(repoPath, newType);
    if (!result.ok) {
      this.setNotice(result.message);
      return;
    }
    if (newType && newType.trim()) {
      repo.defaultAgentType = newType.trim();
    } else {
      delete repo.defaultAgentType;
    }
    this.infoPanel.selectedRepoDefaultAgentType = repo.defaultAgentType;
    this.tui?.requestRender();
  }

  /** Save notes for a repo to the registry and update the in-memory copy. */
  private async persistNotes(repoPath: string, notes: string): Promise<void> {
    const repo = this.repos.find((r) => r.path === repoPath);
    if (!repo) return;
    const result = await setRepoNotes(repoPath, notes);
    if (!result.ok) {
      this.setNotice(result.message);
      return;
    }
    if (notes.length > 0) {
      repo.notes = notes;
    } else {
      delete repo.notes;
    }
  }

  /**
   * If the notes editor's text differs from its original snapshot, persist
   * the change. Updates the snapshot so subsequent blurs are no-ops.
   */
  private commitNotesIfChanged(): void {
    if (!this.notesEditorRepoPath) return;
    const current = this.infoPanel.notesEditor.getText();
    if (current === this.notesEditorOriginal) return;
    const repoPath = this.notesEditorRepoPath;
    this.notesEditorOriginal = current;
    void this.persistNotes(repoPath, current);
  }

  /** Revert notes editor to its original value (used by Escape inside notes). */
  private revertNotes(): void {
    this.infoPanel.notesEditor.setText(this.notesEditorOriginal);
  }

  /** Cycle the info-panel Default Agent Type field to the next available type. */
  private handleInfoCycleAgentType(): void {
    const next = this.infoPanel.computeNextAgentType();
    if (next === null) {
      this.setNotice("No agent types available");
      return;
    }
    void this.persistDefaultAgentType(next);
  }

  /** Clear the info-panel Default Agent Type field back to '(default)'. */
  private handleInfoClearAgentType(): void {
    void this.persistDefaultAgentType(null);
  }

  // --- Input handling ---

  handleInput(data: string): void {
    // Dialog input takes priority
    if (this._dialog && handleDialogInput(this, data)) return;

    // When active-agent panel is focused, use three-level sub-focus: pane → input → send.
    // In 'pane' sub-focus, dashboard shortcuts work normally. In 'input', the input field
    // captures all input. In 'send', Enter submits and other keys fall through. (SPEC §13.4)
    if (this.focusManager.current() === "active-agent" && this.agentTree.selectedAgent) {
      const sf = this.focusManager.subFocus;

      // Tab navigation through sub-focus states
      if (data === "\t" || matchesKey(data, Key.tab)) {
        if (sf === "pane") { this.focusManager.setSubFocus("input"); }
        else if (sf === "input") { this.focusManager.setSubFocus("send"); }
        else { this.focusManager.cycle(1); } // send → next panel
        this.tui?.requestRender();
        return;
      }
      if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
        if (sf === "send") { this.focusManager.setSubFocus("input"); }
        else if (sf === "input") { this.focusManager.setSubFocus("pane"); }
        else { this.focusManager.cycle(-1); } // pane → prev panel
        this.tui?.requestRender();
        return;
      }

      // Input sub-focus: capture everything
      if (sf === "input") {
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          // Discard any in-progress chunked paste so its prefix can't leak
          // into the next input context.
          cancelPaste();
          this.inputField.clear();
          this.focusManager.setSubFocus("pane");
          this.tui?.requestRender();
          return;
        }
        this.inputField.handleInput(data);
        this.tui?.requestRender();
        return;
      }

      // Send sub-focus: Enter submits
      if (sf === "send") {
        if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
          const text = this.inputField.getText();
          if (text.trim()) {
            this.inputField.clear();
            this.focusManager.setSubFocus("pane");
            this.inputField.onSubmit?.(text);
          }
          this.tui?.requestRender();
          return;
        }
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          cancelPaste();
          this.focusManager.setSubFocus("pane");
          this.tui?.requestRender();
          return;
        }
        // Fall through to normal dashboard handling (resize, scroll, etc.)
      }

      // Pane sub-focus and Send sub-focus: fall through to normal dashboard key handling
    }

    // When coordinator panel is focused, use same three-level sub-focus as active-agent.
    // Only requires the coordinator to have polled (session is running), not that it's
    // selected in the agent tree — the sidebar coordinator panel should accept input
    // regardless of which agent is selected.
    if (this.focusManager.current() === "coordinator" && this.coordinatorPane.hasPolled) {
      const sf = this.focusManager.subFocus;

      // Tab navigation through sub-focus states
      if (data === "\t" || matchesKey(data, Key.tab)) {
        if (sf === "pane") { this.focusManager.setSubFocus("input"); }
        else if (sf === "input") { this.focusManager.setSubFocus("send"); }
        else { this.focusManager.cycle(1); } // send → next panel
        this.tui?.requestRender();
        return;
      }
      if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
        if (sf === "send") { this.focusManager.setSubFocus("input"); }
        else if (sf === "input") { this.focusManager.setSubFocus("pane"); }
        else { this.focusManager.cycle(-1); } // pane → prev panel
        this.tui?.requestRender();
        return;
      }

      // Input sub-focus: capture everything
      if (sf === "input") {
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          cancelPaste();
          this.coordinatorInputField.clear();
          this.focusManager.setSubFocus("pane");
          this.tui?.requestRender();
          return;
        }
        this.coordinatorInputField.handleInput(data);
        this.tui?.requestRender();
        return;
      }

      // Send sub-focus: Enter submits
      if (sf === "send") {
        if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
          const text = this.coordinatorInputField.getText();
          if (text.trim()) {
            this.coordinatorInputField.clear();
            this.focusManager.setSubFocus("pane");
            this.coordinatorInputField.onSubmit?.(text);
          }
          this.tui?.requestRender();
          return;
        }
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          cancelPaste();
          this.focusManager.setSubFocus("pane");
          this.tui?.requestRender();
          return;
        }
        // Fall through to normal dashboard handling
      }

      // Pane sub-focus and Send sub-focus: fall through to normal dashboard key handling
    }

    // When repo-coordinator panel is focused, use same three-level sub-focus as coordinator.
    // Only active when in REPO mode with a coordinator agent.
    if (this.focusManager.current() === "repo-coordinator" && this.rightPane.repoCoordinatorAgent) {
      const sf = this.focusManager.subFocus;

      // Tab navigation through sub-focus states
      if (data === "\t" || matchesKey(data, Key.tab)) {
        if (sf === "pane") { this.focusManager.setSubFocus("input"); }
        else if (sf === "input") { this.focusManager.setSubFocus("send"); }
        else { this.focusManager.cycle(1); } // send → next panel
        this.tui?.requestRender();
        return;
      }
      if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
        if (sf === "send") { this.focusManager.setSubFocus("input"); }
        else if (sf === "input") { this.focusManager.setSubFocus("pane"); }
        else { this.focusManager.cycle(-1); } // pane → prev panel
        this.tui?.requestRender();
        return;
      }

      // Input sub-focus: capture everything
      if (sf === "input") {
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          cancelPaste();
          this.repoCoordinatorInputField.clear();
          this.focusManager.setSubFocus("pane");
          this.tui?.requestRender();
          return;
        }
        this.repoCoordinatorInputField.handleInput(data);
        this.tui?.requestRender();
        return;
      }

      // Send sub-focus: Enter submits
      if (sf === "send") {
        if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
          const text = this.repoCoordinatorInputField.getText();
          if (text.trim()) {
            this.repoCoordinatorInputField.clear();
            this.focusManager.setSubFocus("pane");
            this.repoCoordinatorInputField.onSubmit?.(text);
          }
          this.tui?.requestRender();
          return;
        }
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          cancelPaste();
          this.focusManager.setSubFocus("pane");
          this.tui?.requestRender();
          return;
        }
        // Fall through to normal dashboard handling
      }

      // Pane sub-focus and Send sub-focus: fall through to normal dashboard key handling
    }

    // Info panel: when a repo header is selected, Tab cycles between
    // sub-fields (default-type → notes → next panel). Shift-Tab cycles back.
    // When the notes sub-field is leaving focus, save any edits.
    if (
      this.focusManager.current() === "info"
      && this.agentTree.selectedRepoHeader != null
    ) {
      if (data === "\t" || matchesKey(data, Key.tab)) {
        if (this.infoPanel.subField === "default-type") {
          this.infoPanel.subField = "notes";
          this.notesEditorOriginal = this.infoPanel.notesEditor.getText();
          this.tui?.requestRender();
          return;
        }
        // notes → leave panel: save then cycle to next panel
        this.commitNotesIfChanged();
        this.infoPanel.subField = "default-type";
        this.focusManager.cycle(1);
        this.tui?.requestRender();
        return;
      }
      if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
        if (this.infoPanel.subField === "notes") {
          this.commitNotesIfChanged();
          this.infoPanel.subField = "default-type";
          this.tui?.requestRender();
          return;
        }
        // default-type → leave panel backwards
        this.focusManager.cycle(-1);
        this.tui?.requestRender();
        return;
      }
    }

    // Tab / Shift-Tab: cycle focus between panels
    if (data === "\t" || matchesKey(data, Key.tab)) {
      this.focusManager.cycle(1);
      this.tui?.requestRender();
      return;
    }
    if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
      this.focusManager.cycle(-1);
      this.tui?.requestRender();
      return;
    }

    // §17.1 (Phase 3 three-axis model): '0' / '1' switch the sidebar tree
    // visibility (`sidebarMode`). They do NOT change the GLOBAL selection
    // (`activeSelectionSource`, set by j/k navigation). Focus moves only when
    // the current focus target is the HEAD of one cycle and would not exist
    // in the other cycle: `agent-tree` ↔ `teams-tree` (natural mirror), and
    // `repo-coordinator` (agents-only) → `teams-tree` when entering teams
    // mode. Other targets (`info` / `active-agent` / `right-pane`) are
    // present in BOTH orders, so focus stays where it is. We also mirror the
    // active selection into the newly-visible tree (visual only —
    // `activeSelectionSource` is unchanged) and re-run selection sync so the
    // info / main / right panes update immediately instead of waiting a
    // tmux-poll tick. Gated by the dialog/input-field returns above.
    if (data === "0") {
      this.sidebarMode = "teams";
      this.focusManager.sidebarMode = "teams";
      const focus = this.focusManager.current();
      if (focus === "agent-tree" || focus === "repo-coordinator") {
        this.focusManager.setFocus("teams-tree");
      }
      // syncSelectedAgent() runs the inactive-tree mirror at its top.
      this.syncSelectedAgent();
      this.tui?.requestRender();
      return;
    }
    if (data === "1") {
      this.sidebarMode = "agents";
      this.focusManager.sidebarMode = "agents";
      if (this.focusManager.current() === "teams-tree") {
        this.focusManager.setFocus("agent-tree");
      }
      // syncSelectedAgent() runs the inactive-tree mirror at its top.
      this.syncSelectedAgent();
      this.tui?.requestRender();
      return;
    }

    // Info panel: Default Agent Type cycle/clear when the row is the focused
    // sub-field. selectedRepoHeader != null implies neither agent nor
    // system-coordinator is selected (discriminated union in agent-tree).
    if (
      this.focusManager.current() === "info"
      && this.agentTree.selectedRepoHeader != null
    ) {
      // Notes sub-field: Escape reverts to the snapshot taken on entry,
      // any other key is routed to the multi-line editor.
      if (this.infoPanel.subField === "notes") {
        if (matchesKey(data, Key.escape) || data === "\x1b") {
          cancelPaste();
          this.revertNotes();
          this.infoPanel.subField = "default-type";
          this.tui?.requestRender();
          return;
        }
        if (this.infoPanel.notesEditor.handleInput(data)) {
          this.tui?.requestRender();
          return;
        }
        // Editor didn't consume — fall through to normal dashboard handling.
      } else {
        if (data === " ") {
          this.handleInfoCycleAgentType();
          return;
        }
        if (matchesKey(data, Key.backspace) || data === "\x7f" || matchesKey(data, Key.delete)) {
          this.handleInfoClearAgentType();
          return;
        }
      }
    }

    // Navigation. §17.1 (Phase 2 three-axis model): j/k and shift+j/k navigate
    // whichever tree is currently VISIBLE in the sidebar (`sidebarMode`). After
    // any navigation, the navigated tree becomes the active selection source
    // (`activeSelectionSource = sidebarMode`) — the user just declared what they
    // are selecting by moving the cursor in this tree. QUESTIONS-mode j/k
    // retains its agent-tree-only special case below and does NOT touch
    // activeSelectionSource (it's a right-pane question selector, not a
    // sidebar-tree navigation).
    const navigatesTeams = this.sidebarMode === "teams";
    if (data === "J") {
      if (navigatesTeams) {
        this.teamsTree.navigateAnchor(1);
      } else {
        this.agentTree.moveToRepo(1);
      }
      this.activeSelectionSource = this.sidebarMode;
      this.syncSelectedAgent();
      this.tui?.requestRender();
    } else if (data === "K") {
      if (navigatesTeams) {
        this.teamsTree.navigateAnchor(-1);
      } else {
        this.agentTree.moveToRepo(-1);
      }
      this.activeSelectionSource = this.sidebarMode;
      this.syncSelectedAgent();
      this.tui?.requestRender();
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.rightPane.mode === "QUESTIONS" && this._questionsFocused && this.rightPane.filteredQuestions.length > 0) {
        this.rightPane.questionsSelectedIndex = Math.min(
          this.rightPane.filteredQuestions.length - 1,
          this.rightPane.questionsSelectedIndex + 1
        );
        this.rightPane.updateContent();
        this.tui?.requestRender();
      } else {
        if (navigatesTeams) {
          this.teamsTree.navigate(1);
        } else {
          this.agentTree.moveSelection(1);
        }
        this.activeSelectionSource = this.sidebarMode;
        this.syncSelectedAgent();
        this.tui?.requestRender();
      }
    } else if (matchesKey(data, Key.up) || data === "k") {
      if (this.rightPane.mode === "QUESTIONS" && this._questionsFocused && this.rightPane.filteredQuestions.length > 0) {
        this.rightPane.questionsSelectedIndex = Math.max(0, this.rightPane.questionsSelectedIndex - 1);
        this.rightPane.updateContent();
        this.tui?.requestRender();
      } else {
        if (navigatesTeams) {
          this.teamsTree.navigate(-1);
        } else {
          this.agentTree.moveSelection(-1);
        }
        this.activeSelectionSource = this.sidebarMode;
        this.syncSelectedAgent();
        this.tui?.requestRender();
      }
    }
    // Right pane cycling. Suppressed entirely when a team is the GLOBAL
    // selection (`activeSelectionSource === "teams"` + a team in channelPane)
    // — the team view fixes the right pane to the team log, and cycling here
    // would silently mutate the underlying right-pane mode that re-appears
    // when the active selection returns to an agent. Phase 2 (§17.1): keyed
    // on the active source, not on sidebar visibility.
    else if (data === "p" || matchesKey(data, Key.left)) {
      if (this.activeSelectionSource === "teams" && this.channelPane.teamName !== null) {
        // no-op in teams view
      } else if (this.agentTree.isSystemCoordinatorSelected) {
        this.coordinatorViewMode = this.coordinatorViewMode === "TMUX" ? "DASHBOARD" : "TMUX";
        // Switching to DASHBOARD hides the coordinator tmux output; switching
        // back to TMUX shows it again. Pause/resume the poller to match.
        this.updatePollerVisibility();
      } else {
        this.cyclePaneMode(1);
      }
      this.tui?.requestRender();
    } else if (data === "n" || matchesKey(data, Key.right)) {
      if (this.activeSelectionSource === "teams" && this.channelPane.teamName !== null) {
        // no-op in teams view (see "p" branch above)
      } else if (this.agentTree.isSystemCoordinatorSelected) {
        this.coordinatorViewMode = this.coordinatorViewMode === "TMUX" ? "DASHBOARD" : "TMUX";
        this.updatePollerVisibility();
      } else {
        this.cyclePaneMode(-1);
      }
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
      // §17.3 manage-team: when a team ANCHOR is the GLOBAL selection
      // (active source = teams), `x` opens the manage-team picker (disband or
      // remove a single member, each gated by a second confirm dialog). A
      // team MEMBER selection (kind:"agent") falls through to the agent-kill
      // path so killing a team member from the Teams tree behaves identically
      // to killing from the Agents tree (child-agent-indistinguishable).
      // Phase 2 (§17.1) keys this off `activeSelectionSource` — the same
      // source of truth as syncSelectedAgent — so the effective selection
      // stays consistent.
      const teamsActive = this.activeSelectionSource === "teams";
      const teamSel = teamsActive ? this.teamsTree.selection : null;
      if (teamSel?.kind === "team") {
        agentActions.handleManageTeam(this, teamSel.teamName);
      } else if (this.agentTree.isSystemCoordinatorSelected) {
        agentActions.handleKillSystemCoordinator(this);
      } else if (!this.agentTree.selectedAgent && this.agentTree.selectedRepoHeader) {
        this.executeAndRefresh(() => agentActions.handleRemoveRepoSafe(this));
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
    // Nickname the selected agent (distinct from `r`=reassign and `n`=pane-cycle)
    else if (data === "N") { agentActions.handleRename(this); }
    else if (data === "m") { agentActions.handleMerge(this); }
    else if (data === "s") { agentActions.handleSend(this); }
    // Team actions: T = create a new team, t = add selected agent to a team
    // (or manage roster when a team anchor in the Teams tree is the active
    // selection). Phase 2 (§17.1): keyed off `activeSelectionSource` — the
    // same source-of-truth the `x`-on-team-anchor dispatch uses (line ~2349)
    // — so a visible-but-not-active Teams panel doesn't mis-fire the roster
    // path. The Teams panel must own the global selection for `t` to route
    // to the manage-roster dialog.
    else if (data === "T") { agentActions.handleCreateTeam(this); }
    else if (data === "t") {
      const teamSel = this.activeSelectionSource === "teams" ? this.teamsTree.selection : null;
      if (teamSel?.kind === "team") {
        agentActions.handleManageRoster(this, teamSel.teamName);
      } else {
        agentActions.handleAddAgentToTeam(this);
      }
    }
    // Add permission to selected agent's settings.local.json allow list
    else if (data === "b") { agentActions.handleAddPermission(this); }
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
    // Re-check repo health
    else if (data === "H") {
      this.setNotice("Re-checking repo health...");
      this.watcher?.recheckHealth();
    }
    // V — toggle hide-empty-repos
    else if (data === "V") {
      const next = !this.agentTree.hideEmptyRepos;
      this.agentTree.setHideEmptyRepos(next);
      this.setNotice(next ? "Hiding empty repos" : "Showing all repos");
      this.tui?.requestRender();
    }
    // Fix resolvable health warnings (REPO mode only)
    else if (data === "f") { agentActions.handleResolveHealth(this); }
    // Ghostty — repo/worktree
    else if (data === "G") { agentActions.handleOpenGhostty(this); }
    // Ghostty — Claude tmux session
    else if (data === "C") { agentActions.handleOpenGhosttyTmux(this); }
    // Cross-repo send
    else if (data === "E") { agentActions.handleCrossRepoSend(this); }
    // Snapshot
    else if (data === "S") { agentActions.handleSnapshot(this); }
    // Width resize — focus-aware (SPEC §13.3.1)
    else if (data === "[" || data === "]") {
      const delta = data === "]" ? LEFT_WIDTH_STEP : -LEFT_WIDTH_STEP;
      const focus = this.focusManager.current();
      if (focus === "agent-tree" || focus === "teams-tree" || focus === "info" || focus === "coordinator") {
        // Sidebar panel focused: adjust sidebar width.
        // teams-tree shares the sidebar region with agent-tree (§17.3), so width
        // changes apply to the sidebar exactly as they do when agent-tree is focused.
        this.sidebarWidth = clampSidebarWidth(this.sidebarWidth + delta);
        resizeCoordinatorTmux(this.getMainWidth());
        // Per-repo coordinator renders full-pane like the system coordinator,
        // so resize its tmux to the new mainWidth.
        if (this.repoCoordinatorSession) {
          const w = this.getRepoCoordinatorWidth();
          if (w > 0) resizeTmuxWindow(this.repoCoordinatorSession, w);
        }
        this.tui?.requestRender();
      } else if (focus === "right-pane") {
        // Right pane focused: ] grows right (shrinks middle) = negative delta to handleResizeLeft
        agentActions.handleResizeLeft(this, -delta);
      } else {
        // active-agent: ] grows middle (shrinks right) = positive delta
        agentActions.handleResizeLeft(this, delta);
      }
      this.persistLayout();
    }
    // Height resize — sidebar panels only (SPEC §13.3.1)
    else if (data === "{" || data === "}") {
      const delta = data === "}" ? 1 : -1;
      const focus = this.focusManager.current();
      if (focus === "agent-tree" || focus === "teams-tree") {
        // Grow tree, shrink info; give back to info when shrinking.
        // teams-tree shares the sidebar tree region (and heightOffsets.tree)
        // with agent-tree (§17.3), so height changes behave identically.
        const base = computeSidebarHeights(this.sidebar.displayHeight, this.agentTree.visibleList.length);
        const effectiveInfo = Math.max(0, base.infoHeight + this.sidebar.heightOffsets.info);
        if (delta > 0) {
          // Growing tree: steal from info (§7.7 guard: donor must stay ≥ 1)
          if (effectiveInfo > 1) {
            this.sidebar.heightOffsets.tree += delta;
            this.sidebar.heightOffsets.info -= delta;
          }
        } else {
          // Shrinking tree: give back to info
          const effectiveTree = Math.max(1, base.treeHeight + this.sidebar.heightOffsets.tree);
          if (effectiveTree > 1) {
            this.sidebar.heightOffsets.tree += delta;
            this.sidebar.heightOffsets.info -= delta;
          }
        }
        this.tui?.requestRender();
      } else if (focus === "info") {
        // Grow info, shrink tree; give back to tree when shrinking (§7.7 guard: donor must stay ≥ 1)
        const base = computeSidebarHeights(this.sidebar.displayHeight, this.agentTree.visibleList.length);
        const effectiveInfo = Math.max(0, base.infoHeight + this.sidebar.heightOffsets.info);
        const effectiveTree = Math.max(1, base.treeHeight + this.sidebar.heightOffsets.tree);
        if (delta > 0 && effectiveTree > 1) {
          this.sidebar.heightOffsets.info += delta;
          this.sidebar.heightOffsets.tree -= delta;
        } else if (delta < 0 && effectiveInfo > 1) {
          this.sidebar.heightOffsets.info += delta;
          this.sidebar.heightOffsets.tree -= delta;
        }
        this.tui?.requestRender();
      }
      else if ((focus === "right-pane" || focus === "repo-coordinator") && this.rightPane.mode === "REPO" && this.rightPane.repoCoordinatorAgent) {
        // Resize repo coordinator split: } grows coordinator, { shrinks it.
        // computeRepoCoordinatorSplit() normalizes the offset in-place to the clamped value (BUG-10),
        // so no separate revert check is needed — the render path enforces valid bounds.
        this.rightPane.repoCoordinatorHeightOffset += delta;
        this.rightPane.computeRepoCoordinatorSplit();
        this.tui?.requestRender();
      }
      this.persistLayout();
    }
    // Folder browser / add repo
    else if (data === "A") { agentActions.handleAddRepo(this); }
    // Remove repo (safe — requires repo header selected and zero agents)
    else if (data === "D") { this.executeAndRefresh(() => agentActions.handleRemoveRepoSafe(this)); }
  }

  // --- Rendering ---


  invalidate(): void {
    this.agentTree.invalidate();
    this.splitPane.invalidate();
    this.sidebar.invalidate();
    this.statusBar.invalidate();
  }

  render(width: number): string[] {
    // Minimum terminal size check
    const termRows = process.stdout.rows || 24;
    if (termRows < MIN_TERMINAL_HEIGHT || width < MIN_TERMINAL_WIDTH) {
      return [`${BOLD}${YELLOW}[Terminal too small — resize to at least ${MIN_TERMINAL_WIDTH}×${MIN_TERMINAL_HEIGHT}]${RESET}`];
    }

    const lines: string[] = [];
    const terminalRows = process.stdout.rows || 24;
    // §17.1 Phase 2: a leftover system-coordinator selection in the (inactive)
    // Agents tree must NOT bleed into the team-active render path. When the
    // Teams tree owns the global selection the main area renders the team
    // channel, regardless of what the Agents tree's pointer happens to be on.
    // Mirrors the same gate `syncSelectedAgent` uses (`!teamsActive &&
    // agentTree.isSystemCoordinatorSelected`).
    const isCoordinatorView =
      this.activeSelectionSource === "agents" && this.agentTree.isSystemCoordinatorSelected;
    const isTreeMode = this.rightPane.mode === "TREE";
    const isFullWidth = isCoordinatorView || FULL_WIDTH_MODES.has(this.rightPane.mode);

    // Header
    const subtitle = this.lastSentNotice
      ? `${DIM}—${RESET} ${YELLOW}${this.lastSentNotice}${RESET}`
      : `${DIM}— agent dashboard${RESET}`;
    const left = `${BOLD}ib${RESET} ${subtitle}`;
    if (this.telegramStatus) {
      const tgColor =
        this.telegramStatus === "green" ? GREEN
        : this.telegramStatus === "yellow" ? YELLOW
        : RED;
      const right = `${tgColor}●${RESET} Telegram`;
      const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 1);
      lines.push(truncateToWidth(left + " ".repeat(pad) + right, width, ""));
    } else {
      lines.push(truncateToWidth(left, width, ""));
    }

    // Compute available height for the main content area.
    // Chrome lines: header(1) + main title separator(1) +
    //               bottom separator(1) + status bar(2) = 5.
    const chromeLines = 5;
    const availableHeight = Math.max(5, terminalRows - chromeLines);

    // Width math comes from the widths module — never inline.
    const renderLayout = this.liveLayout(width);
    const sidebarW = renderLayout.sidebarWidth;
    const mainWidth = getLiveMainWidth(renderLayout);
    this.sidebar.displayHeight = availableHeight + 1; // sidebar gets the title separator row too

    // Build main area title separator (agent-id left, pane-mode right).
    // Pass leftPaneWidth so the junction lines up with the SplitPane's seam.
    const leftPaneW = getLiveLeftPaneWidth(renderLayout);
    // §17.1 Phase 2: main-area title-bar follows the GLOBAL selection
    // (`activeSelectionSource`), not sidebar visibility. The title belongs to
    // whatever drives the main pane (agent vs team channel); that's the active
    // selection, not whichever tree the sidebar happens to be showing.
    const teamsActiveForTitle = this.activeSelectionSource === "teams";
    const teamSelectedForTitle =
      teamsActiveForTitle && !isCoordinatorView && this.channelPane.teamName !== null;
    const mainTitleSep = isCoordinatorView
      ? this.buildCoordinatorTitleSeparator(mainWidth)
      : teamSelectedForTitle
        ? this.buildTeamTitleSeparator(mainWidth, leftPaneW, this.channelPane.teamName!)
        : this.buildMainTitleSeparator(mainWidth, leftPaneW, isTreeMode, isFullWidth);

    let mainLines: string[];
    // Reset agentless before branching; only the TMUX branch sets it true
    this.coordinatorPane.agentless = false;
    // §17.3 / §17.4: when a team anchor is the EFFECTIVE selection (Teams panel
    // focused + a team header selected), the main area renders the team CHAT on
    // the left and the team LOG on the right — using the existing split-pane
    // seam math so the title separator junction lines up. The user's normal
    // right-pane mode (AGENT LOG / DENIALS / etc.) is preserved; only the
    // visual is overridden while the team is selected. Also covers the Teams
    // no-selection state (channelPane.teamName === null + teams sidebar mode),
    // which renders the channel pane's placeholder full-width.
    // §17.1 Phase 2: main-area branching follows the GLOBAL selection
    // (`activeSelectionSource`), not sidebar visibility. The main area shows
    // the team channel when a team is the active selection (regardless of
    // which sidebar tree is currently rendered); for any other active
    // selection (agent, repo header, system coord, or null in the Agents
    // tree) the main area falls through to the agent / coordinator / repo
    // branches below.
    const teamsActiveRender = this.activeSelectionSource === "teams";
    const showChannelPane =
      teamsActiveRender
      && !isCoordinatorView
      && (this.channelPane.teamName !== null || this.teamsTree.selection === null);
    if (showChannelPane) {
      // §17.4 refresh cadence: the chat box + log are refreshed by
      // `channelRefreshTimer` (set up in startPolling) and by a one-shot
      // `refreshChannel()` on team-selection change. render() is PURE here — it
      // must NOT call load(), because load completes by calling requestRender(),
      // which would re-enter render() and spin a load→render loop.
      if (this.channelPane.teamName === null) {
        // Teams no-selection placeholder: full main width, channel pane only.
        this.channelPane.displayHeight = availableHeight;
        mainLines = [mainTitleSep, ...this.channelPane.render(mainWidth)];
      } else {
        // Team selected → side-by-side chat | log using the split-pane geometry.
        const sepWidth = 1;
        const lw = Math.max(1, Math.min(leftPaneW, mainWidth - sepWidth - 1));
        const rw = Math.max(1, mainWidth - lw - sepWidth);
        this.channelPane.displayHeight = availableHeight;
        this.teamLogPane.displayHeight = availableHeight;
        const leftLines = this.channelPane.render(lw);
        const rightLines = this.teamLogPane.render(rw);
        const sepChar = `${DIM_GRAY}│${RESET}`;
        const merged: string[] = [];
        const maxLines = Math.max(leftLines.length, rightLines.length);
        for (let i = 0; i < maxLines; i++) {
          const ll = i < leftLines.length ? leftLines[i]! : "";
          const rl = i < rightLines.length ? rightLines[i]! : "";
          const leftVisible = visibleWidth(ll);
          const needsReset = ll.includes("\x1b[");
          const leftPadded = leftVisible >= lw
            ? truncateToWidth(ll, lw, "")
            : ll + (needsReset ? RESET : "") + " ".repeat(lw - leftVisible);
          merged.push(leftPadded + sepChar + truncateToWidth(rl, rw, ""));
        }
        mainLines = [mainTitleSep, ...merged];
      }
    } else if (isCoordinatorView && this.coordinatorViewMode === "TMUX") {
      // System coordinator TMUX view: full-width coordinator tmux output in main area.
      // Reuses coordinatorPane (agentless TmuxPaneComponent) for rendering.
      const isCoordFocused = this.focusManager.current() === "coordinator";
      const coordSf = this.focusManager.subFocus;
      const showCoordInput = isCoordFocused && coordSf !== "pane";

      // Set coordinator input field state for main area rendering
      this.coordinatorInputField.active = showCoordInput;
      if (isCoordFocused) {
        this.coordinatorInputField.setFocusState(coordSf === "send" ? "send" : "text");
      }

      // Configure coordinatorPane for main area rendering
      this.coordinatorPane.agentless = true;
      this.coordinatorPane.trimInputSeparator = showCoordInput;
      if (showCoordInput) {
        this.coordinatorPane.parseStatusLines(mainWidth);
      } else {
        this.coordinatorPane.statusLines = [];
      }

      const statusLinesCount = this.coordinatorPane.statusLines.length;
      const inputFieldHeight = showCoordInput ? this.coordinatorInputField.getHeight(mainWidth) + statusLinesCount : 0;
      this.coordinatorPane.displayHeight = Math.max(0, availableHeight - inputFieldHeight);
      // Match tmuxPane: only capture as much scrollback as the pane will actually render.
      this.coordinatorPoller.setLines(
        Math.max(200, this.coordinatorPane.displayHeight + this.coordinatorPane.scrollBack + 10)
      );

      const tmuxLines = this.coordinatorPane.render(mainWidth);

      if (showCoordInput) {
        const inputLines = this.coordinatorInputField.render(mainWidth);
        tmuxLines.push(...inputLines, ...this.coordinatorPane.statusLines);
      }

      // Pad to available height
      while (tmuxLines.length < availableHeight) tmuxLines.push("");

      mainLines = [mainTitleSep, ...tmuxLines.slice(0, availableHeight)];
    } else if (isCoordinatorView) {
      // System coordinator DASHBOARD view: full-width agent overview table
      this.coordinatorInputField.active = false;
      this.systemDashboard.displayHeight = availableHeight;
      mainLines = [mainTitleSep, ...this.systemDashboard.render(mainWidth)];
    } else if (isTreeMode) {
      // TREE mode: full-height tree in the main area.
      // IMPORTANT: The sidebar renders the same AgentTreeComponent in compact mode.
      // The main area render below runs FIRST to set maxHeight for the full tree,
      // then the sidebar render (inside mergeSidebarAndMain) resets maxHeight for compact.
      // This order is safe because sidebar.render() sets agentTree.maxHeight internally.
      this.agentTree.maxHeight = availableHeight;
      mainLines = [mainTitleSep, ...this.agentTree.render(mainWidth)];
    } else {
      // Normal/full-width mode: split-pane(tmux | right-pane)
      const showInputField = this.agentTree.selectedAgent != null && !isFullWidth;

      // Compute leftW early — needed for input field height calculation
      const leftW = getLiveLeftPaneWidth(renderLayout);

      // Set active state on input field based on focus and sub-focus
      const isAgentFocused = this.focusManager.current() === "active-agent";
      const agentSf = this.focusManager.subFocus;
      this.inputField.active = isAgentFocused && agentSf !== "pane";
      if (isAgentFocused) {
        this.inputField.setFocusState(agentSf === "send" ? "send" : "text");
      }

      // Pre-compute status lines from tmux output before rendering
      this.tmuxPane.trimInputSeparator = showInputField;
      if (showInputField) {
        this.tmuxPane.parseStatusLines(leftW);
      } else {
        this.tmuxPane.statusLines = [];
      }

      const statusLinesCount = this.tmuxPane.statusLines.length;
      const inputFieldHeight = showInputField ? this.inputField.getHeight(leftW) + statusLinesCount : 0;
      this.tmuxPane.displayHeight = showInputField ? availableHeight - inputFieldHeight : availableHeight;
      this.rightPane.displayHeight = availableHeight;
      // Cap tmux capture-pane scrollback to what's actually visible (+10 padding
      // for trimInputSeparator). Keeps a 200-line floor so parseStatusLines
      // separator detection always has plenty of context.
      this.tmuxPoller.setLines(
        Math.max(200, this.tmuxPane.displayHeight + this.tmuxPane.scrollBack + 10)
      );
      // Per-repo coordinator capture: size scrollback to the coordinator
      // section's height in REPO mode. The section renders within the
      // full-main-width REPO view (vertical split: repo info on top,
      // coordinator tmux on bottom).
      if (this.rightPane.repoCoordinatorAgent) {
        const { coordinatorHeight } = this.rightPane.computeRepoCoordinatorSplit();
        this.repoCoordinatorPoller.setLines(
          Math.max(200, coordinatorHeight + this.rightPane.repoCoordinatorScrollBack + 10)
        );
      }
      this.splitPane.fullWidth = isFullWidth;
      const splitLines = this.splitPane.render(mainWidth);

      if (showInputField) {
        // Replace the last N lines' left portion with input field + status lines.
        // The tmux pane rendered N fewer lines, so the split pane padded the
        // left side with empty strings for those positions. We rebuild those
        // lines with input field content on the left + right pane content on
        // the right.
        const sepChar = `${DIM_GRAY}│${RESET}`;
        const rw = getLiveRightPaneWidth(renderLayout);
        const inputLines = this.inputField.render(leftW);
        // Append status lines below the input field
        const overlayLines = [...inputLines, ...this.tmuxPane.statusLines];
        // Re-render right pane at the correct width to get the last N lines
        const rightLines = this.rightPane.render(rw);

        for (let i = 0; i < inputFieldHeight; i++) {
          const splitIdx = splitLines.length - inputFieldHeight + i;
          if (splitIdx < 0) continue;
          const overlayLine = overlayLines[i] ?? "";
          const rightIdx = availableHeight - inputFieldHeight + i;
          const rightLine = rightIdx >= 0 && rightIdx < rightLines.length
            ? truncateToWidth(rightLines[rightIdx]!, rw, "")
            : "";
          // Pad overlay line to left width
          const overlayVW = visibleWidth(overlayLine);
          const needsReset = overlayLine.includes("\x1b[");
          const leftPadded = overlayVW >= leftW
            ? truncateToWidth(overlayLine, leftW, "")
            : overlayLine + (needsReset ? RESET : "") + " ".repeat(leftW - overlayVW);
          splitLines[splitIdx] = leftPadded + sepChar + rightLine;
        }
      }

      mainLines = [mainTitleSep, ...splitLines];
    }

    // Render sidebar and merge with main area
    this.sidebar.focusTarget = this.focusManager.current();
    // §17.1 Phase 1: sidebar visibility is a separate axis from focus.
    this.sidebar.sidebarMode = this.sidebarMode;
    // §17.1 Phase 2 (updated): the visible tree highlights its selection
    // unconditionally, whether or not it owns the active source. When the
    // user toggles sidebarMode, `mirrorSelectionToVisibleTree` already
    // points the inactive tree at the same effective selection (or
    // `deselect()`s it when there's no counterpart — e.g. a team anchor
    // has no row in the Agents tree). Highlighting the mirror gives the
    // user a clear "same agent" visual cue across both trees. The
    // `suppressSelection` flag remains as the dimming hook for QUESTIONS
    // mode on the Agents tree; the Teams tree has no question-focused
    // sub-state.
    this.agentTree.suppressSelection = this._questionsFocused;
    this.teamsTree.suppressSelection = false;
    // In TREE mode the full tree renders in the main area, so hide the
    // sidebar tree to avoid duplication and let the info panel take all space.
    this.sidebar.hideTree = isTreeMode;
    // Info-panel focus must follow Tab navigation, which changes focus without
    // calling syncSelectedAgent.
    const wasInfoFocused = this.infoPanel.focused;
    const wasNotesSubField = this.infoPanel.subField === "notes";
    this.infoPanel.focused = this.focusManager.current() === "info";
    if (wasInfoFocused && !this.infoPanel.focused && wasNotesSubField) {
      // Lost info focus while editing notes (e.g. focus jumped via shortcut).
      // Save edits and reset to the default sub-field.
      this.commitNotesIfChanged();
      this.infoPanel.subField = "default-type";
    } else if (!this.infoPanel.focused && this.infoPanel.subField === "notes") {
      this.infoPanel.subField = "default-type";
    }
    // Coordinator input field activation is handled in the TMUX render branch above
    // when coordinator is in the main area. For sidebar rendering, only activate when
    // coordinator is NOT selected (i.e., shown in sidebar's coordinator section).
    if (!isCoordinatorView) {
      const isCoordFocused = this.focusManager.current() === "coordinator";
      const coordSf = this.focusManager.subFocus;
      this.coordinatorInputField.active = isCoordFocused && coordSf !== "pane";
      if (isCoordFocused) {
        this.coordinatorInputField.setFocusState(coordSf === "send" ? "send" : "text");
      }
    }

    // Set repo coordinator input field state
    const isRepoCoordFocused = this.focusManager.current() === "repo-coordinator";
    const repoCoordSf = this.focusManager.subFocus;
    this.repoCoordinatorInputField.active = isRepoCoordFocused && repoCoordSf !== "pane";
    if (isRepoCoordFocused) {
      this.repoCoordinatorInputField.setFocusState(repoCoordSf === "send" ? "send" : "text");
    }
    this.rightPane.repoCoordinatorInputField = this.repoCoordinatorInputField;
    this.rightPane.repoCoordinatorFocused = isRepoCoordFocused;
    const sidebarLines = this.sidebar.render(sidebarW);
    lines.push(...mergeSidebarAndMain(sidebarLines, mainLines, availableHeight + 1, mainWidth, sidebarW));

    // Bottom separator with junction characters
    const rightPaneW = getLiveRightPaneWidth(renderLayout);
    const bottomSep = this.buildBottomSeparator(mainWidth, sidebarW, leftPaneW, rightPaneW, isTreeMode, isFullWidth);
    lines.push(truncateToWidth(`${DIM_GRAY}${bottomSep}${RESET}`, width, ""));

    // Status bar
    const statusLines = this.statusBar.render(width);
    lines.push(...statusLines);

    return lines;
  }

  /** Build titled separator at the top of the main area showing agent-id and pane-mode */
  private buildMainTitleSeparator(mainWidth: number, leftPaneW: number, isTreeMode: boolean, isFullWidth: boolean): string {
    const selAgent = this.agentTree.selectedAgent;
    const repoHeader = this.agentTree.selectedRepoHeader;
    const isRepoMode = this.rightPane.mode === "REPO";
    const leftTitle = isRepoMode ? ` ${repoHeader ?? ""} ` : (selAgent ? ` ${selAgent.id} ` : "");
    const rightTitle = isRepoMode ? " REPO "
      : isTreeMode ? " TREE "
      : repoHeader ? ` ${repoHeader} `
      : ` ${this.rightPane.mode} `;

    const leftPad = 3;
    const rightPad = 3;
    const currentFocus = this.focusManager.current();
    const leftFocused = currentFocus === "active-agent";
    const rightFocused = currentFocus === "right-pane";

    // Dash color is always DIM_GRAY — never reverse (Bug 3)
    const leftDashColor = DIM_GRAY;
    const rightDashColor = DIM_GRAY;
    const leftTitleStyle = leftFocused ? `${REVERSE}${BOLD}` : BOLD;
    const rightTitleStyle = rightFocused ? `${REVERSE}${BOLD}` : BOLD;

    if (!isTreeMode && !isFullWidth && leftTitle) {
      // Show junction at inner split position (one beyond the left pane).
      const splitAt = leftPaneW + 1;
      const leftHalfDashes = Math.max(1, splitAt - leftPad - leftTitle.length);
      const rightHalfDashes = Math.max(1, mainWidth - splitAt - rightTitle.length - rightPad);
      const leftDashStr = "─".repeat(Math.max(0, leftHalfDashes - 1)) + "┬";
      const sep =
        `${leftDashColor}${"─".repeat(leftPad)}${RESET}${leftTitleStyle}${leftTitle}${RESET}` +
        `${leftDashColor}${leftDashStr}${RESET}` +
        `${rightTitleStyle}${rightTitle}${RESET}` +
        `${rightDashColor}${"─".repeat(rightHalfDashes)}${"─".repeat(rightPad)}${RESET}`;
      return truncateToWidth(sep, mainWidth, "");
    }

    const fixedChars = leftPad + leftTitle.length + rightTitle.length + rightPad;
    const fillCount = Math.max(1, mainWidth - fixedChars);
    const sep = `${leftDashColor}${"─".repeat(leftPad)}${RESET}${leftTitleStyle}${leftTitle}${RESET}${rightTitleStyle}${rightTitle}${RESET}${leftDashColor}${"─".repeat(fillCount)}${RESET}${rightDashColor}${"─".repeat(rightPad)}${RESET}`;
    return truncateToWidth(sep, mainWidth, "");
  }

  /**
   * Build the team-mode title separator: `@<team> CHAT  ┬  @<team> LOG`. Uses
   * the same split-pane junction math as `buildMainTitleSeparator` so the `┬`
   * lines up with the chat | log seam.
   */
  private buildTeamTitleSeparator(mainWidth: number, leftPaneW: number, teamName: string): string {
    const leftTitle = ` @${teamName} CHAT `;
    const rightTitle = ` @${teamName} LOG `;
    const leftPad = 3;
    const rightPad = 3;
    const leftDashColor = DIM_GRAY;
    const rightDashColor = DIM_GRAY;
    const leftTitleStyle = BOLD;
    const rightTitleStyle = BOLD;

    const splitAt = leftPaneW + 1;
    const leftHalfDashes = Math.max(1, splitAt - leftPad - leftTitle.length);
    const rightHalfDashes = Math.max(1, mainWidth - splitAt - rightTitle.length - rightPad);
    const leftDashStr = "─".repeat(Math.max(0, leftHalfDashes - 1)) + "┬";
    const sep =
      `${leftDashColor}${"─".repeat(leftPad)}${RESET}${leftTitleStyle}${leftTitle}${RESET}` +
      `${leftDashColor}${leftDashStr}${RESET}` +
      `${rightTitleStyle}${rightTitle}${RESET}` +
      `${rightDashColor}${"─".repeat(rightHalfDashes)}${"─".repeat(rightPad)}${RESET}`;
    return truncateToWidth(sep, mainWidth, "");
  }

  /** Build title separator for system coordinator full-width view */
  private buildCoordinatorTitleSeparator(mainWidth: number): string {
    const leftTitle = " System Coordinator ";
    const rightTitle = this.coordinatorViewMode === "TMUX" ? " TMUX " : " DASHBOARD ";
    const leftPad = 3;
    const rightPad = 3;
    const currentFocus = this.focusManager.current();
    const coordFocused = currentFocus === "coordinator";
    const leftTitleStyle = coordFocused ? `${REVERSE}${BOLD}` : BOLD;
    const fillCount = Math.max(1, mainWidth - leftPad - leftTitle.length - rightTitle.length - rightPad);
    return truncateToWidth(
      `${DIM_GRAY}${"─".repeat(leftPad)}${RESET}${leftTitleStyle}${leftTitle}${RESET}` +
      `${BOLD}${rightTitle}${RESET}` +
      `${DIM_GRAY}${"─".repeat(fillCount)}${"─".repeat(rightPad)}${RESET}`,
      mainWidth,
      "",
    );
  }

  /** Build bottom separator with appropriate junction characters */
  private buildBottomSeparator(mainWidth: number, sidebarW: number, leftPaneW: number, rightPaneW: number, isTreeMode: boolean, isFullWidth: boolean): string {
    // Sidebar junction at position sidebarWidth
    const sidebarJunction = "┴";
    const leftPart = "─".repeat(sidebarW) + sidebarJunction;

    if (!isTreeMode && !isFullWidth) {
      // Add inner split-pane junction at the left pane boundary, then right pane width.
      const innerSep = "─".repeat(leftPaneW) + "┴" + "─".repeat(Math.max(0, rightPaneW));
      return leftPart + innerSep;
    }

    return leftPart + "─".repeat(Math.max(0, mainWidth));
  }
}

export async function launchDashboard(): Promise<void> {
  const registry = await loadRegistry();
  const repos = registry.repos;
  if (repos.length === 0) {
    console.log("No repos registered. Use 'ib add <path>' to add one.");
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

  // Acquire coordinator ref synchronously (fast file write), then ensure
  // the coordinator session in the background so the TUI isn't delayed.
  await acquireSystemCoordinator();
  ensureSystemCoordinator().catch((err) => {
    // Surface coordinator startup errors to the dashboard once it exists
    console.error("System coordinator startup failed:", err);
  });

  // Ensure agent types directory is initialized
  await ensureAgentTypesDir();

  // Validate all agent type files before starting
  const typeErrors = await validateAllAgentTypes();
  if (typeErrors.length > 0) {
    console.error("Agent type validation failed:");
    for (const err of typeErrors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  // Warn about deprecated config keys (non-blocking)
  const deprecationWarnings = await checkDeprecatedConfigKeys();
  for (const warning of deprecationWarnings) {
    console.error(`Warning: ${warning}`);
  }

  const config = await readConfig();

  // Telegram subsystem: three-step boot. Token check → connect probe →
  // resolve chat id from inbound inference → construct dispatcher + outbox.
  // Each step gates the next; on failure we log a single line and continue
  // with the rest of the dashboard (agents, watcher, TUI) running normally.
  // The boot itself is kicked off as a background promise AFTER the TUI is
  // mounted (see below) — a hung Telegram API call must never delay the
  // dashboard from appearing.
  const tgTokenEntry = config["channels.telegram.bot_token"];
  const tgToken = typeof tgTokenEntry?.value === "string" ? tgTokenEntry.value : "";
  const { TelegramClient } = await import("../channels/telegram-client");
  const { TelegramDispatcher } = await import("../channels/dispatcher");
  const { TelegramOutbox, defaultOutboxDir } = await import("../channels/outbox");
  const { readAccess } = await import("../channels/access");
  const { bootTelegramSubsystem } = await import("../channels/boot");
  const access = await readAccess();
  // One-time cleanup of the Phase A chat-id state file. Phase B holds the
  // chat id in memory only; the on-disk artifact is no longer used. Best
  // effort — ignore ENOENT and any other failure.
  try {
    const { join } = await import("path");
    const { homedir } = await import("os");
    const { unlink } = await import("fs/promises");
    const stalePath = join(process.env.HOME ?? homedir(), ".itsybitsy", "channels", "telegram", "chat-id");
    await unlink(stalePath).catch(() => { /* file already absent */ });
  } catch {
    /* best effort — never block boot on cleanup */
  }
  let telegramDispatcher: import("../channels/dispatcher").TelegramDispatcher | null = null;
  let telegramOutbox: import("../channels/outbox").TelegramOutbox | null = null;
  let telegramBootOk = false;
  /** Unsubscribe handle for the dispatcher's onStateChange listener.
   *  Cleared on Ctrl+C so we don't leak the closure across the shutdown
   *  promise chain. */
  let telegramStateUnsub: (() => void) | null = null;

  const dashboard = new DashboardComponent();
  const savedLayout = await loadLayout();
  if (savedLayout) {
    dashboard.applyLayout(savedLayout);
  } else {
    // Resize coordinator tmux to match mainWidth when no saved layout exists
    // (applyLayout handles this internally when a layout is restored)
    resizeCoordinatorTmux(dashboard.getMainWidth());
  }
  dashboard.setTui(tui);
  dashboard.setRepos(repos);
  const diffToolValue = config["externalDiffTool"]?.value;
  dashboard.setDiffTool(typeof diffToolValue === "string" && diffToolValue ? diffToolValue : undefined);
  dashboard.setVersion(version);
  if (tgToken !== "") {
    // Start yellow ("boot in progress"). The background boot promise below
    // flips this to green on success or red on failure. The 5 s interval
    // re-reads the closure-captured `telegramDispatcher` / `telegramBootOk`
    // vars, which are populated when the background boot resolves.
    //
    // Health-aware polling: instead of `isRunning()` (a sticky boolean that
    // stays true while the loop hangs on a dead socket), we read the
    // dispatcher's state machine. `polling` → green, `retrying` → yellow,
    // anything else → red.
    dashboard.setTelegramStatus("yellow");
    dashboard.telegramStatusTimer = setInterval(() => {
      if (!telegramDispatcher) {
        dashboard.setTelegramStatus(telegramBootOk ? "yellow" : "red");
        return;
      }
      const health = telegramDispatcher.getHealth();
      if (health.state === "polling") {
        dashboard.setTelegramStatus("green");
      } else if (health.state === "retrying") {
        dashboard.setTelegramStatus("yellow");
      } else {
        dashboard.setTelegramStatus("red");
      }
    }, 5_000);
  }
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

  // Telegram three-step boot — kicked off after the TUI is mounted and the
  // watcher exists. Fire-and-forget: we only `await` it during shutdown (and
  // even then with a short timeout) so a hung Telegram API call cannot stall
  // dashboard startup. Boot diagnostics route through ~/.itsybitsy/watch.log
  // rather than stderr (which would render the dashboard unreadable).
  const telegramBootPromise: Promise<void> = (async () => {
    try {
      const bootResult = await bootTelegramSubsystem({
        token: tgToken,
        access,
        buildClient: (token) => new TelegramClient({ token }),
        buildDispatcher: (opts) => new TelegramDispatcher(opts),
        buildOutbox: (opts) => new TelegramOutbox({ ...opts, log: logToWatchLog }),
        log: logToWatchLog,
      });
      if (bootResult.ok) {
        telegramDispatcher = bootResult.dispatcher;
        telegramOutbox = bootResult.outbox;
        telegramBootOk = true;
        // Subscribe to dispatcher health transitions and pipe them to
        // watch.log. Boot already logged the initial connect status, so the
        // initial down→polling transition (reason=null) is suppressed here.
        // Subsequent transitions:
        //   polling  → retrying  : log "telegram: disconnected (<reason>)"
        //   retrying → polling   : log "telegram: <reason>" (e.g. "reconnected after 12s")
        //   any      → down      : silent (shutdown / 409 are already logged
        //                          via boot or the dispatcher itself)
        telegramStateUnsub = telegramDispatcher.onStateChange((change) => {
          if (change.to === "retrying" && change.reason !== null) {
            logToWatchLog(`telegram: disconnected (${change.reason})`);
          } else if (change.to === "polling" && change.reason !== null) {
            logToWatchLog(`telegram: ${change.reason}`);
          }
        });
        // Don't await — start() runs the loop in the background.
        telegramDispatcher.start().catch((err) => {
          logToWatchLog(`Telegram dispatcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
        });
        // Outbox start() awaits the sweep + watcher install. We let it run in
        // the background so a stuck filesystem can't block the dashboard.
        telegramOutbox.start().catch((err) => {
          logToWatchLog(`Telegram outbox failed to start at ${defaultOutboxDir()}: ${err instanceof Error ? err.message : String(err)}`);
        });
        // Promote to green on the next render.
        if (tgToken !== "") dashboard.setTelegramStatus("green");
      } else {
        // The boot helper already wrote the failure reason to watch.log via
        // the injected `log`; just flip the indicator.
        if (tgToken !== "") dashboard.setTelegramStatus("red");
      }
    } catch (err) {
      // bootTelegramSubsystem itself shouldn't throw — but if a future change
      // adds a path that does, we don't want it to take down launchDashboard.
      logToWatchLog(`Telegram routing disabled: boot threw (${err instanceof Error ? err.message : String(err)})`);
      if (tgToken !== "") dashboard.setTelegramStatus("red");
    }
  })();

  const colorDetection = setupColorSchemeDetection(() => {
    tui.requestRender();
  });

  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      agentActions.killActiveDiffProc();
      colorDetection.cleanup();
      dashboard.stopPolling();
      watcher.stop();
      tui.stop();
      dashboard.setTerminalTitle("");
      process.stdout.write("\x1b[2J\x1b[H");
      // Unsubscribe the state-change listener before stopping so a stop()
      // transition doesn't fire one final logToWatchLog call after we've
      // already torn down the TUI write paths.
      if (telegramStateUnsub) {
        telegramStateUnsub();
        telegramStateUnsub = null;
      }
      // Stop the Telegram dispatcher if it was started. Race against a 2s
      // timeout so a hung getUpdates abort cannot block exit. We don't
      // process.exit() synchronously — give shutdown a chance to flush.
      // The race is a safety net, not a kill: the dispatcher loop is
      // supposed to unwind via AbortController within ~1s, and the timeout
      // just keeps a misbehaving loop from blocking the TUI exit. If the
      // loop somehow ignored the AbortSignal it will keep running until
      // the process actually exits below — but the TUI gets out of the way.
      const stopTelegram = telegramDispatcher
        ? Promise.race([
            telegramDispatcher.stop(),
            new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
          ])
        : Promise.resolve();
      const stopOutbox = telegramOutbox
        ? Promise.race([
            telegramOutbox.stop(),
            new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
          ])
        : Promise.resolve();
      // If the user hits Ctrl+C before the background boot resolves, race it
      // out with a short timeout so the dashboard exits promptly even when
      // the Telegram API is hung. After this race resolves the boot promise
      // is "released" — any handlers it has chained will still run, but they
      // won't block process exit because of the .finally(process.exit) below.
      const finishBoot = Promise.race([
        telegramBootPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      // Flush layout save to disk before exiting, then release coordinator
      Promise.all([
        flushPendingSave().catch(() => { /* ignore write errors on exit */ }),
        stopTelegram.catch(() => { /* ignore — already raced */ }),
        stopOutbox.catch(() => { /* ignore — already raced */ }),
        finishBoot.catch(() => { /* ignore — boot was best effort */ }),
      ]).then(() => {
        // Release coordinator ref — if last ref, kills the tmux session
        // and pauses all per-repo coordinators
        return releaseSystemCoordinator(async () => {
          // Pause all per-repo coordinators when last watcher exits
          const agents = dashboard.watcher?.lastAgents ?? [];
          const coordinators = agents.filter(a => a.meta.agentType === "coordinator");
          await Promise.all(coordinators.map(a => pauseAgent(a).catch(() => {})));
        });
      }).finally(() => {
        process.exit(0);
      });
      return undefined;
    }
    if (colorDetection.inputFilter(data)) return undefined;
    if (isKeyRelease(data)) return undefined;
    dashboard.handleInput(data);
    return undefined;
  });

  // Handle terminal resize to update coordinator tmux width
  process.stdout.on("resize", () => {
    resizeCoordinatorTmux(dashboard.getMainWidth());
    // Per-repo coordinator renders full-pane like the system coordinator,
    // so its tmux width tracks the same mainWidth.
    if (dashboard.repoCoordinatorSession) {
      const w = dashboard.getRepoCoordinatorWidth();
      if (w > 0) resizeTmuxWindow(dashboard.repoCoordinatorSession, w);
    }
    // displayHeight is recomputed inside render() — at the moment the resize
    // event fires it still holds the pre-resize value, so a cache check now
    // would falsely hit. Drop the cached window so loadAgentLogIfNeeded is
    // forced to re-read once render has updated displayHeight; defer the
    // call via setImmediate so it runs after the next render tick.
    if (dashboard.rightPane.mode === "AGENT LOG") {
      dashboard.rightPane.loadedLogWindow = null;
      setImmediate(() => {
        if (dashboard.rightPane.mode === "AGENT LOG") {
          dashboard.loadAgentLogIfNeeded();
        }
      });
    }
    tui.requestRender();
  });

  tui.start();
  colorDetection.queryColorScheme();
  dashboard.startPolling();
  await watcher.start();
}
