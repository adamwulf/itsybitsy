import {
  peerAttachmentCandidates, stagePeerAttachments, type PeerAttachmentCandidate, type StagedPeerAttachments,
} from "../peers/dashboard-attachments";
import { repoRowKey } from "./row-keys";
import { lifecyclePast, type RemoteLifecycleRequest } from "../peers/remote-lifecycle";
import type { RemotePermissionOutcome, RemotePermissionRequest } from "../peers/remote-permissions";
import { pushFailedNotice } from "../push-failure";
import { remoteLifecycleDenial, remotePermissionDenial, remoteSendDenial } from "../peers/remote-start-caller";
/**
 * Main TUI dashboard — agent tree + live tmux pane + all keybindings.
 * Composes AgentTree, TmuxPane, RightPane, StatusBar, and dialog system.
 *
 * Sub-modules:
 *   agent-tree.ts     — AgentTreeComponent + formatAgentRow
 *   color-scheme.ts   — terminal color scheme detection + getStateColors
 *   dialog-handler.ts — DialogState type + dialog input routing
 *   agent-actions.ts  — agent action handlers (retire, merge, send, etc.)
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
import { listRepos, loadRegistry, setRepoDefaultAgentType, setRepoNotes } from "../registry";
import { claimScheduledRun, readScheduledTasks, recordScheduledRunResult } from "../scheduled-tasks";
import { Scheduler, startLocalScheduledAgent } from "../scheduler";
import { scanAndKillOrphans } from "../agent-lifecycle";
import { startOrphanScanTimer, type OrphanScanTimer } from "../orphan-scan-timer";
import { shortPeerId } from "../peers/store";
import { readConfig, checkDeprecatedConfigKeys } from "../config";
import { validateAllAgentTypes, ensureAgentTypesDir, listSpawnableTypeNamesSync } from "../agent-types";
import { REPO_COORDINATOR_TYPE } from "../coordinator-type-names";
import { peerSnapshot } from "../peers/peer-link";
import type { RepoEntry } from "../registry";
import { readRepoCloneInfo, resolveCloneRoot, type RepoCloneInfo } from "../clone-repo";
import { AgentWatcher } from "../watcher";
import { TmuxPoller, hasAttachedClient, resizeTmuxWindow, expandTabs } from "../tmux-poller";
import { isCodexBackedCli, parseModel } from "../agent-cli";
import {
  BOUNCE_QUIT_DELAY_MS,
  BOUNCE_SIGNAL,
  IB_COORDINATOR_SESSION,
  acquireSystemCoordinator,
  takeCoordinatorPaneWarning,
  ensureSystemCoordinator,
  releaseSystemCoordinator,
  sanitizeTmuxInput,
  isCoordinatorRestartCommand,
  restartSystemCoordinatorFresh,
} from "../coordinator";
import type { Agent, FlatEntry, RemoteEntry, PendingQuestion } from "../agents";
import { agentWorktreePath } from "../agents";
import { captureAgentDiff } from "../peers/agent-diff";
import { checkWorktreeCleanliness, getCommitsSinceParent, getWorktreeHead } from "../git-status";
import { SplitPane } from "./split-pane";
import { TypePickerKeyboard } from "./type-picker-keyboard";
import { installTerminalCleanup } from "./terminal-cleanup";
import { installWatchCrashHandlers, type WatchCrashHandlers } from "./watch-crash";
import { wrapSingleLine, wordWrapLines, wordWrapSingleLine, padLines, WordWrapCache, computeChromeSlice } from "./wrap";
import { RemotePane } from "./remote-pane";
import { RemotePrompt } from "./remote-prompt";
import { closeOsc8 } from "../hyperlinks";
import type { ChromeSlice } from "./wrap";
import { codexUsageResult, fetchGeminiUsage, newerCodexReading, passedCodexResets, readCodexLogUsage } from "../usage";
import type { CodexUsageReading, UsageData } from "../usage";
import { fetchCodexLiveUsage } from "../codex-live-usage";
import { readClaudeUsage } from "../claude-rate-limits";
import { InjectionContext } from "../types";
import { getStateColors, setupColorSchemeDetection } from "./color-scheme";
import { AgentTreeComponent, nextRepoFilter, agentDisplayName } from "./agent-tree";
import { TeamsTreeComponent, flattenTeamsTree } from "./teams-tree";
import { ChannelPaneComponent } from "./channel-pane";
import { TeamLogPaneComponent } from "./team-log-pane";
import { SidebarComponent, SIDEBAR_WIDTH } from "./sidebar";
import type { SidebarMode, SelectionSource } from "./sidebar";
import { InfoPanelComponent } from "./info-panel";
import { listTeams, getTeam } from "../teams";
import type { Team } from "../teams";
import type { DialogState } from "./dialog-handler";
import {
  wrapTextareaLines, TEXTAREA_VISIBLE_HEIGHT, DIALOG_WIDTH, MULTI_SELECT_WIDTH, dialogTitleMaxWidth,
  handleDialogInput, syncNewAgentMachine, renderTextareaBlock, buildFolderBrowserContent, buildNewAgentFormContent,
  PEERS_TAB, buildSetupContent, buildPermissionsEditorContent, buildMultiSelectContent,
} from "./dialog-handler";
import {
  RightPaneComponent, colorizeDiff, colorizeLog,
  PANE_MODES, FULL_WIDTH_MODES, DEFAULT_MODE_INDEX,
  cyclePaneMode, jumpToMode, triggerAsyncLoadIfNeeded,
  loadAgentLog, loadTailLog, isTailLogMode, loadAgentPrompt,
} from "./pane-manager";
import type { PaneMode, TailLogMode } from "./pane-manager";
import * as agentActions from "./agent-actions";
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, DIM_GRAY, REVERSE } from "./colors";
import { FocusManager } from "./focus";
import type { FocusTarget, SubFocus } from "./focus";
import { SystemDashboardComponent } from "./system-dashboard";
import { loadLayout, saveLayoutDebounced, cancelPendingSave, flushPendingSave } from "./layout";
import { initializeMachineName } from "../machine-name";
import {
  DEFAULT_TMUX_WIDTH, PINNED_TMUX_WIDTH,
  getLiveMainWidth, getLiveLeftPaneWidth, getLiveRightPaneWidth,
  clampLeftWidthAbsolute, clampSidebarWidth,
} from "./widths";
import { cancelPaste } from "./clipboard";
import type { LayoutState } from "./layout";
import { textHeader } from "../peers/peer-outbox";
import type { SendTarget } from "../peers/send-frame";
import { InputFieldComponent } from "./input-field";
import { newAgent, pauseAgent, teamSend as ibTeamSend } from "../ib-commands";
import { sendStagedMessage } from "./message-send";
import type { StagedTeamSendOptions, TeamSendResult } from "./message-send";
import { choosePaths, peerAttachmentPrompt, promptAndStageAttachmentsIfNeeded } from "./attachment-prompt";
import { getResolvableWarnings } from "../health-check";
import { logToWatchLog, logWarning, setWatchRunning } from "../watch-log";
import { sandboxCollectorHealth, type CollectorHealth } from "../sandbox-collector-light";
import { SANDBOX_DENIAL_COLLECTOR_ENABLED } from "../sandbox-log-launch";
import {
  readRemoteControlFiles, remoteControlStatus,
  type RemoteControlFiles, type RemoteControlFilesOptions, type RemoteControlStatus,
} from "../remote-control-light";
import { telegramLight, type TelegramConnectionView } from "../channels/connection-view";
import { syncPeersDialog, type PeersDialogService } from "./peers-dialog";
import { buildScheduledTaskFormContent } from "./scheduled-dialog";
import { captureAgentPane, readAgentPromptText } from "../peers/agent-pane";
import { PeerService, defaultPeerServiceDeps, type PeerServiceView } from "../peers/service";
import { localTerminalHost } from "../peers/terminal-host";
import { peerLinkStatus, type PeerLinkState } from "../peers/poller";
import { peerEntryKey, remoteDisplayName, remoteMessageTarget, remoteTitle, type RemoteMessageEntry } from "./peer-repos";

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

const LEFT_WIDTH_STEP = 5;

/**
 * The usage fetchers behind the status-bar poll. Tests swap them so that a
 * dashboard test never runs `agy` or `codex app-server`, or reads the real
 * ~/.itsybitsy and ~/.codex.
 */
export const usageFetchCtx = new InjectionContext({
  readClaudeUsage,
  fetchGeminiUsage,
  readCodexLogUsage,
  fetchCodexLiveUsage,
});

/** How often `ib watch` probes live Codex usage (`codex app-server`) after the probe at start. */
export const CODEX_LIVE_PROBE_INTERVAL_MS = 8 * 60 * 60_000;

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
  /**
   * Called by resetForAgent(). The dashboard points it at the feeding poller's
   * redeliverNext(): the poller only delivers changed output, so after a reset
   * on the same session it must re-deliver an unchanged capture.
   */
  onReset?: () => void;
  /**
   * Memoized word-wrap keyed on (raw identity, width). The raw we wrap is the
   * chrome-SLICED transcript (input-box chrome removed on the UNWRAPPED logical
   * lines first — see chromeSlice), not the full capture, so wrapping never sees
   * the input separators. Both render() and parseStatusLines() run several times
   * between polls (input-field height, status-line count, then the actual
   * render), so caching keeps repeated renders O(1). onOutput assigns a fresh
   * string every poll, so an identity check invalidates correctly.
   */
  private wrapCache = new WordWrapCache();
  /**
   * Memoized chrome slice of rawOutput. Chrome detection now runs on the
   * UNWRAPPED logical lines (rawOutput.split("\n")), NOT on wrapped rows: at the
   * pinned tmux width an input-box separator is a single ~1000-col logical line,
   * but after word-wrapping to a narrow pane it becomes many consecutive
   * full-width separator rows, which made findLastTwoSeparators / findCodexInput-
   * Chrome mis-slice. Detecting on logical lines is width-independent, so this
   * memo keys on rawOutput identity alone.
   */
  private chromeCache: { raw: string; slice: ChromeSlice } | null = null;

  invalidate(): void {}

  /**
   * Split rawOutput into logical lines, detect the CLI's input-box chrome there,
   * and return the transcript (everything above the chrome) plus the status
   * lines (chrome below the input separator). Width-independent — memoized on
   * rawOutput identity. See ChromeSlice / computeChromeSlice.
   */
  private chromeSlice(): ChromeSlice {
    const cached = this.chromeCache;
    if (cached && cached.raw === this.rawOutput) return cached.slice;
    const slice = computeChromeSlice(this.rawOutput, isCodexAgent(this.agent), isAgyAgent(this.agent));
    this.chromeCache = { raw: this.rawOutput, slice };
    return slice;
  }

  /**
   * Word-wrap the transcript to `width`. When trimInputSeparator is set we wrap
   * the chrome-sliced transcript (input box removed on the logical lines first);
   * otherwise we wrap the full capture. Reuses the memoized result when neither
   * the (sliced) raw nor the width changed. Word-wrap (break at spaces,
   * hard-wrap over-width tokens) renders the whole buffer at one consistent
   * width.
   */
  getWrapped(width: number): string[] {
    const raw = this.trimInputSeparator ? this.chromeSlice().transcriptRaw : this.rawOutput;
    return this.wrapCache.get(raw, width);
  }

  /** Reset state when switching agents */
  resetForAgent() {
    this.rawOutput = "";
    this.hasPolled = false;
    this.scrollBack = 0;
    this.clientAttached = false;
    this.wrapCache.reset();
    this.chromeCache = null;
    this.onReset?.();
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

    // Status lines are the CLI's chrome below the input separator (Claude's
    // status bar, or codex's status bar + prompt). They are detected on the
    // UNWRAPPED logical lines (chromeSlice) so a pinned-width separator doesn't
    // wrap into many rows and mis-slice. Status lines are chrome: TRUNCATE each
    // logical line to width — never word-wrap them (a wrapped status bar would
    // spill onto extra rows the overlay didn't reserve).
    this.statusLines = this.chromeSlice().statusLines.map(
      (line) => closeOsc8(truncateToWidth(line, width, ""))
    );
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

    // Word-wrap the transcript to pane width (memoized). getWrapped already
    // returns the chrome-SLICED transcript when trimInputSeparator is set — the
    // CLI's input box is removed on the UNWRAPPED logical lines first
    // (chromeSlice), so wrapping never sees the input separators and there is no
    // per-width re-slice to do here. rawOutput is tmux -J output (soft-wrapped
    // continuation rows already rejoined), so this is the single place the whole
    // transcript gets word-wrapped to the current width.
    const wrapped = this.getWrapped(width);

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
    return isCodexBackedCli(parseModel(agent.meta.model).cli);
  } catch {
    return false;
  }
}

/** Whether the agent is an Antigravity CLI (`agy`) agent (for chrome detection). */
function isAgyAgent(agent: Agent | null): boolean {
  if (!agent) return false;
  try {
    return parseModel(agent.meta.model).cli === "agy";
  } catch {
    return false;
  }
}

/**
 * Whether the agent is an agy agent that is not stopped or archived — the
 * only case in which the status bar polls `agy -p /usage`.
 */
function isLiveAgyAgent(agent: Agent): boolean {
  return !agent.archived && agent.state !== "stopped" && isAgyAgent(agent);
}
// Codex input-chrome detection moved to wrap.ts (findCodexInputChromeLogical,
// used by computeChromeSlice) — it now runs on UNWRAPPED logical lines.

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

/** The right pane's text for a selected remote row, in every mode but INITIAL PROMPT on an agent (SPEC §20.5). */
export const REMOTE_RIGHT_PANE_TEXT = "Not available for remote agents";

/**
 * A pending peer request's header status after its `…` (SPEC §20.5): the
 * bytes written to the link for attachments, then, once all are written, the
 * wait for the peer's reply, since written bytes can still be in flight.
 */
function transferStatus(progress: agentActions.TransferProgress): string {
  if (progress.sent) return ` waiting for ${progress.peerName} to confirm`;
  return progress.total === undefined ? "" : ` ${progress.bytes} / ${progress.total} bytes`;
}

/** A remote agent's key: `currentAgentKey` and its draft while it is selected. */
function remoteAgentKey(row: Extract<RemoteEntry, { kind: "remote-agent" }>): string {
  return `${row.peerId}/${row.remote.repoRegistryName}/${row.remote.id}`;
}

/**
 * The selected remote agent's capture (or a repo header's placeholder)
 * and the right pane's "not available" placeholder, side by side
 * on the split layout's seam, `height` rows. Each is word-wrapped to its pane
 * (the right pane is often narrow), and a word longer than the pane is broken.
 * `input` renders the message editor and the CLI's status lines at the center
 * pane's width; they sit at the bottom of the center pane, as on a local
 * agent's tmux pane. `rightPane`, when given, renders the right pane in place
 * of the placeholder.
 */
function renderRemotePanes(entry: RemoteEntry, pane: RemotePane, mainWidth: number, leftPaneW: number, height: number, input?: (width: number) => string[], rightPane?: (width: number, rows: number) => string[]): string[] {
  const lw = Math.max(1, Math.min(leftPaneW, mainWidth - 2));
  const rw = Math.max(1, mainWidth - lw - 1);
  const editor = input?.(lw) ?? [];
  const placeholder = (text: string, width: number, rows: number) =>
    padLines(wordWrapSingleLine(text, width).map((line) => `${DIM}${truncateToWidth(line, width, "")}${RESET}`), rows);
  const bodyHeight = Math.max(0, height - editor.length);
  const body = entry.kind === "remote-repo-header" ? placeholder(`Remote repo on ${entry.peerName} (read-only)`, lw, bodyHeight) : pane.render(lw, bodyHeight);
  // Clamped like the coordinator's view: the peer's status lines can be long (a `/` menu).
  const center = [...body, ...editor].slice(0, height);
  const right = rightPane?.(rw, height) ?? placeholder(REMOTE_RIGHT_PANE_TEXT, rw, height);
  const sep = `${DIM_GRAY}│${RESET}`;
  return center.map((line, i) => closeOsc8(padToWidth(line, lw)) + sep + (right[i] ?? ""));
}

/**
 * Footer clock format: 24-hour HH:MM. Built once and reused — toLocaleTimeString()
 * builds a new formatter on every call, which was ~5% of an idle `ib watch`
 * profile. No seconds, so the clock only needs a render once a minute
 * (DashboardComponent.scheduleClockRender). hourCycle "h23" keeps midnight at 00.
 */
const FOOTER_CLOCK_FORMAT = new Intl.DateTimeFormat("en-US", {
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

/** Footer clock text for `date` (HH:MM, 24-hour). */
export function formatFooterClock(date: Date): string {
  return FOOTER_CLOCK_FORMAT.format(date);
}

/** True when two usage readings render the same status-bar text. */
function sameUsage(a: UsageData | null, b: UsageData | null): boolean {
  if (a === null || b === null) return a === b;
  return a.sessionPct === b.sessionPct && a.weeklyPct === b.weeklyPct
    && a.sessionReset === b.sessionReset && a.weeklyReset === b.weeklyReset
    && a.sessionWindowEnded === b.sessionWindowEnded;
}

/** Status bar component */
class StatusBarComponent implements Component {
  pendingQuestions = 0;
  errorCount = 0;
  claudeUsage: UsageData | null = null;
  claudeUsageError = false;
  geminiUsage: UsageData | null = null;
  geminiUsageError = false;
  /** An agy usage run looked like a login prompt; gemini polling is off until restart. */
  geminiLoginNeeded = false;
  codexUsage: UsageData | null = null;
  codexUsageError = false;
  version = "";
  repoHeaderSelected = false;
  /**
   * A remote row is selected (SPEC §20.5): the footer lists only keys
   * the read-only guard allows (isRemoteAllowedKey), not the agent actions it
   * would refuse.
   */
  remoteSelected = false;
  remoteCoordinatorVisible = false;
  remoteRepoSelected = false;
  remoteAgentSelected = false;
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
    const geminiUsageStr = this.geminiLoginNeeded
      ? `${YELLOW}⚠️  gemini: agy login needed${RESET}`
      : this.formatUsage("gemini", this.geminiUsage, this.geminiUsageError);
    const codexUsageStr = this.formatUsage("codex", this.codexUsage, this.codexUsageError);
    const timeStr = formatFooterClock(new Date());
    const versionStr = this.version ? `v${this.version}` : "";
    const rightUsage = this.composeRight(geminiUsageStr, codexUsageStr);
    const row2Right = this.composeRight(rightUsage, versionStr ? `${DIM}${versionStr}${RESET}` : "");

    let row1Left: string;
    let row2Left: string;
    if (this.remoteSelected) {
      const markHint = this.remoteRepoSelected ? "    .: pin" : this.remoteAgentSelected ? "    .: favorite" : "";
      // `q` works on every remote agent row, whatever its type (isRemoteAllowedKey).
      const questionsHint = this.remoteRepoSelected || this.remoteCoordinatorVisible ? "" : `${qLabel}    `;
      row1Left = `${DIM}j/k: select    J/K: repo    ${this.remoteRepoSelected ? "" : ";/l: scroll    "}${this.remoteCoordinatorVisible ? "" : "p/n: pane    "}${questionsHint}1/2/3: tab    V: filter${this.remoteCoordinatorVisible ? "" : "    [ ] { }: resize"}${this.remoteAgentSelected ? "    C: terminal" : ""}${errBadge}${RESET}`;
      let row2 = `${DIM}${timeStr}  @: jump    /: commands    ?: help    I: peers tab${this.remoteAgentSelected ? "    o: diff    m: merge    x: retire    R/P: resume/pause" : ""}${this.remoteRepoSelected ? "    c: clone here" : "    s: send"}${markHint}`;
      // `a` and `h` come last, and only whole: on a narrow terminal the row's
      // own actions and the usage/version on the right matter more than the
      // two global dialogs, and a hint cut in half is noise. The room kept
      // for the right text is composeLine's minimum: a 2-column gap plus 1.
      const rightRoom = row2Right ? visibleWidth(row2Right) + 3 : 0;
      for (const hint of ["a: new agent", "h: setup"]) {
        if (visibleWidth(`${row2}    ${hint}`) + rightRoom > width) break;
        row2 += `    ${hint}`;
      }
      row2Left = `${row2}${RESET}`;
    } else if (this.repoHeaderSelected) {
      const fixHint = this.hasResolvableWarnings ? "    f: fix" : "";
      row1Left = `${DIM}j/k: select    J/K: repo    ;/l: scroll    p/n: pane    ${qLabel}${errBadge}${RESET}`;
      row2Left = `${DIM}${timeStr}  @: jump    /: commands    a: new agent    ?: help    h: setup    A: add repo${fixHint}${RESET}`;
    } else {
      row1Left = `${DIM}j/k: select    J/K: repo    ;/l: scroll    p/n: pane    ${qLabel}    s: send    m: merge${errBadge}${RESET}`;
      row2Left = `${DIM}${timeStr}  @: jump    /: commands    a: new agent    ?: help    h: setup    x: retire${RESET}`;
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

  private formatUsage(label: "claude" | "codex" | "gemini", usage: UsageData | null, usageError: boolean): string {
    const prefix = usageError ? "⚠️  " : "";
    if (!usage) {
      return usageError ? `${YELLOW}⚠️  ${label} usage unavailable${RESET}` : "";
    }
    const parts: string[] = [];
    if (usage.sessionPct !== null && !usage.sessionWindowEnded) {
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
    // The dialog is the overlay itself; see DashboardComponent.render's return.
    return lines.map(expandTabs);
  }

  private buildContent(dialog: NonNullable<DialogState>, innerWidth: number): { title: string; contentLines: string[] } {
    switch (dialog.type) {
      case "confirm": {
        const wrapped = wordWrapLines(dialog.prompt, innerWidth);
        const btnColor = dialog.confirmColor ?? GREEN;
        const confirmBtn = dialog.focusedButton === "confirm" ? `${BOLD}${btnColor}[ ${dialog.confirmLabel} ]${RESET}` : `[ ${dialog.confirmLabel} ]`;
        const cancelBtn = dialog.focusedButton === "cancel" ? `${BOLD}${GREEN}[ Cancel ]${RESET}` : `[ Cancel ]`;
        const contentLines = [...wrapped, "", `  ${cancelBtn}   ${confirmBtn}`];
        if (dialog.checkbox) {
          const label = `[${dialog.checkbox.checked ? "x" : " "}] ${dialog.checkbox.label}`;
          const checkbox = dialog.focusedButton === "checkbox" ? `${BOLD}${REVERSE}${label}${RESET}` : label;
          contentLines.push("", `  ${checkbox}  ${DIM}(Space to toggle)${RESET}`);
        }
        return { title: "Confirm", contentLines };
      }
      case "input": {
        return {
          // A built title gets this render's width: the overlay narrows with the terminal.
          title: typeof dialog.prompt === "string" ? dialog.prompt : dialog.prompt(dialogTitleMaxWidth(innerWidth + 4)),
          contentLines: [...(dialog.hint ? wordWrapLines(dialog.hint, innerWidth) : []), truncateToWidth(`> ${dialog.value}█`, innerWidth, "")],
        };
      }
      case "add-permission": {
        const inputLine = dialog.focused === "input"
          ? truncateToWidth(`> ${dialog.value}█`, innerWidth, "")
          : truncateToWidth(`> ${dialog.value}`, innerWidth, "");
        const toggleText = dialog.canSpawnChildren
          ? "[ Turn OFF subagent spawning ]"
          : "[ Turn ON subagent spawning ]";
        const toggleBtn = dialog.focused === "toggle"
          ? `${BOLD}${GREEN}${toggleText}${RESET}`
          : toggleText;
        return {
          title: dialog.prompt,
          contentLines: [
            inputLine,
            `${DIM}(Tab to toggle spawn permission)${RESET}`,
            "",
            `  ${toggleBtn}`,
          ],
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
      case "cleanup-warnings": {
        const rows = dialog.text.split("\n").flatMap(line => wrapSingleLine(line, innerWidth));
        const height = Math.max(1, (process.stdout.rows || 24) - 4);
        dialog.offset = Math.min(dialog.offset, Math.max(0, rows.length - height));
        const content = rows.slice(dialog.offset, dialog.offset + height);
        const hint = rows.length > height ? "↑/↓ scroll · Esc close" : "Esc close";
        content.push(`${DIM}${truncateToWidth(hint, innerWidth, "")}${RESET}`);
        return { title: "Cleanup warnings", contentLines: content };
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
        if (dialog.inFlight && (dialog.inFlightNote || dialog.onCancelInFlight)) lines.push(`${DIM}${dialog.inFlightNote ?? "Sending… Esc: cancel"}${RESET}`);
        return { title: dialog.prompt, contentLines: lines };
      }
      case "folder-browser": {
        return buildFolderBrowserContent(dialog, innerWidth, this.getRepoPaths());
      }
      case "new-agent-form": {
        return buildNewAgentFormContent(dialog, innerWidth);
      }
      case "scheduled-task-form": {
        return buildScheduledTaskFormContent(dialog, innerWidth);
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

/** The notice for a key refused on a remote row (SPEC §20.5). */
export const REMOTE_READ_ONLY_NOTICE = "Read-only remote agent";

/**
 * The read-only guard's allowlist (SPEC §20.5): the only keys that work while
 * the effective selection is a remote row. Every other key, including
 * any key added to the dashboard later, is refused, so no action can reach a
 * remote row by default.
 *
 * - navigation and focus: j/k, J/K, the arrows, Tab and Shift+Tab, `[` `]` `{` `}`;
 * - the sidebar tabs 1, 2 and 3 and the tree filter V;
 * - pane cycling: p and n (and ←/→, their arrow forms), and the direct
 *   jumps d, e and g to modes that cycling reaches (the palette's mode jumps
 *   pass as `p`);
 * - the `@` jump: it lists only local rows (handleFuzzyAgent keeps only local
 *   kinds), so it is the quick way back from a remote row;
 * - help `?`, the command palette `/` (whose commands pass this same guard) and Peers `I`;
 * - the dialogs and actions that do not act on the selected row: new agent `a`
 *   (handleNewAgent picks the remote row's repo), setup `h`, add repo `A`,
 *   create team `T`, cross-repo send `E` and the repo health re-check `H`;
 * - quit (Ctrl+C, which the TUI's input listener handles before the dashboard);
 * - on a remote agent, `q` for its questions (refuseOnRemoteRow then allows
 *   Enter, Esc and `g` while they are shown).
 *
 * The footer's remote hints (StatusBarComponent.remoteSelected) list these keys.
 */
export function isRemoteAllowedKey(data: string, row?: RemoteEntry): boolean {
  if (data === ".") return row?.kind === "remote-agent" || row?.kind === "remote-repo-header" || row?.kind === "remote-coordinator";
  if (data === "q") return row?.kind === "remote-agent";
  if (data === "o" || data === "m" || data === "x" || data === "R" || data === "P" || data === "b") return row?.kind === "remote-agent" && row.remote.agentType !== REPO_COORDINATOR_TYPE;
  // A terminal on the agent's tmux session (SPEC §20.4 "Remote terminal").
  if (data === "C") return row?.kind === "remote-agent";
  switch (data) {
    case "j": case "k": case "J": case "K":
    case "\t": case "\x1b[Z":
    case "[": case "]": case "{": case "}":
    case "1": case "2": case "3": case "V":
    case "p": case "n": case "d": case "e": case "g":
    case "@":
    case "?": case "/": case "I":
    case "a": case "h": case "A": case "T": case "E": case "H":
      return true;
  }
  return matchesKey(data, Key.up) || matchesKey(data, Key.down)
    || matchesKey(data, Key.left) || matchesKey(data, Key.right)
    || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))
    || matchesKey(data, Key.ctrl("c"));
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
  modeIndex = DEFAULT_MODE_INDEX;
  savedModeIndex = DEFAULT_MODE_INDEX;
  private tmuxPoller: TmuxPoller;
  coordinatorPane: TmuxPaneComponent;
  private coordinatorPoller: TmuxPoller;
  /** Poller for per-repo coordinator tmux output. Active when a repo header is selected (REPO mode), captures into `rightPane.repoCoordinatorOutput` for full-main-width rendering. */
  private repoCoordinatorPoller: TmuxPoller;
  /** The tmux session currently being polled for repo coordinator */
  repoCoordinatorSession: string | null = null;
  /**
   * The effective selection's agent as its fully qualified id (SPEC §17.1),
   * `"__coordinator__"` for the system coordinator, null otherwise. A change of
   * it is a selection change (syncSelectedAgent), so moving between two agents
   * with the same bare id in two repos resets and reloads the panes.
   */
  currentAgentKey: string | null = null;
  /** Repo path whose notes are currently loaded into the info-panel notes editor. */
  private notesEditorRepoPath: string | null = null;
  /** Snapshot of notes text taken when the user entered the notes sub-field — used to revert on Escape. */
  private notesEditorOriginal: string = "";
  _dialog: DialogState = null;
  private pendingCleanupWarnings: Array<Extract<DialogState, { type: "cleanup-warnings" }>> = [];
  private overlayHandle: OverlayHandle | null = null;
  private dialogOverlay: DialogOverlayComponent;
  /**
   * The iroh endpoint service behind the Peers tab (`I`). launchDashboard
   * sets the real one (src/peers/service.ts); a dashboard built in a test has
   * none unless the test sets a fake, so no test can bind a real endpoint.
   */
  remoteStartPending = false;
  /** The pending remote start (agent-actions.ts): shutdown aborts it with the pending sends. */
  remoteStart: NonNullable<agentActions.ActionCtx["remoteStart"]> | null = null;
  peerService: PeersDialogService | null = null;
  /** The poller state the Agents tree's remote rows were last built from. */
  private peerLinks: readonly PeerLinkState[] = [];
  private pairedPeers: PeerServiceView["peers"] = [];
  /** The watcher's questions from its last update, and their agents' keys (the red names). */
  private localQuestions: PendingQuestion[] = [];
  private localQuestionKeys = new Set<string>();
  /**
   * `<peer id>\0<question id>` of each peer question acknowledged from here: it
   * leaves the list at once, not at the next poll, and is forgotten once no
   * snapshot lists it.
   */
  private readonly acknowledgedPeerQuestions = new Set<string>();
  private readonly remotePane = new RemotePane(
    (peerId, target, lines) => this.peerService!.fetchPane(peerId, target, lines),
    () => this.tui?.requestRender(),
  );
  private readonly remotePrompt = new RemotePrompt(
    (peerId, repo, id) => this.peerService!.fetchAgentPrompt(peerId, repo, id),
    (key, lines) => {
      // As in loadAgentPrompt: a read for an agent no longer selected is only cached.
      if (key !== this.currentAgentKey) return;
      this.rightPane.promptContent = lines;
      this.rightPane.updateContent();
      this.tui?.requestRender();
    },
  );

  private syncRemotePane(): void {
    const row = this.remoteSelection;
    const visible = this._dialog === null && !this.expandedAgentsTreeVisible;
    if (row && row.kind !== "remote-repo-header" && this.tmuxPoller.isRunning() && this.peerService) {
      this.remotePane.displayHeight = Math.max(0, this.availableMainHeight() - this.inputField.getHeight(this.getMainWidth()));
      this.remotePane.select(row.kind === "remote-agent"
        ? { peerId: row.peerId, target: { op: "agent-pane", repo: row.remote.repoRegistryName, id: row.remote.id }, model: row.remote.model }
        : { peerId: row.peerId, target: { op: "coordinator-pane" } },
      this.peerService.remoteStartDenial, visible && !this.remoteQuestionsVisible);
    } else {
      this.remotePane.select(null);
    }
    // Read a remote agent's prompt only while INITIAL PROMPT shows it.
    this.remotePrompt.select(row?.kind === "remote-agent" && this.rightPane.mode === "INITIAL PROMPT" && visible
      && this.tmuxPoller.isRunning() && this.peerService
      ? { key: remoteAgentKey(row), peerId: row.peerId, repo: row.remote.repoRegistryName, id: row.remote.id }
      : null);
  }
  watcher: AgentWatcher | null = null;
  repos: RepoEntry[] = [];
  /**
   * Each registered repo's origin URL and clone-root-relative path, by repo
   * path: what the peer snapshot sends with it (SPEC §20.4). setRepos re-reads
   * it in the background, so answering a peer costs no IO.
   */
  repoCloneInfo: ReadonlyMap<string, RepoCloneInfo> = new Map();
  /** Bumped by each re-read: only the newest one's result is kept. */
  private repoCloneInfoGeneration = 0;
  private noticeCounter = 0;
  diffTool: string | undefined;
  /**
   * Local copy of the `tree.groupByParent` display preference. The watcher owns
   * the authoritative flag; this mirror lets setWatcher() re-apply the value if
   * the startup config read happened before the watcher was wired.
   */
  private groupByParent = false;
  /** Health report for the currently selected repo — used by ActionCtx */
  get healthReport(): import("../health-check").RepoHealthReport | undefined {
    const repoPath = this.agentTree.selectedRepoPath ?? (this.agentTree.selectedAgent?.repoPath ?? null);
    return repoPath && this.watcher ? this.watcher.healthReports.get(repoPath) : undefined;
  }
  private selectedReceipt: string | undefined;
  private pendingLifecycle = new Map<string, string>();
  private pendingRemoteSends = new Map<string, agentActions.TransferProgress & { id: string; peerId: string; target: SendTarget; label: string; controller: AbortController; done: Promise<void> }>();
  private lastSentNotice: string | null = null;
  private lastSentNoticeKind: "info" | "error" = "info";
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether the latest agent update had a live agy agent; gates the agy usage poll. */
  private hasLiveAgyAgent = false;
  /**
   * Set when an agy usage run looks like a login prompt. Each such run opens
   * another browser login window, so agy usage polling stays off until
   * `ib watch` restarts. Per process only.
   */
  private agyUsageAuthLatched = false;
  private geminiUsageInFlight = false;
  /** Newest Codex usage record in the session logs, read on every usage tick. */
  private codexLogReading: CodexUsageReading | null = null;
  /** Last successful live Codex probe. A failed probe leaves it as it was. */
  private codexLiveReading: CodexUsageReading | null = null;
  /** The 8-hour live Codex probe timer; set while polling runs. */
  private codexLiveTimer: ReturnType<typeof setInterval> | null = null;
  private codexLiveProbeInFlight = false;
  /**
   * Reset times (epoch ms) that already triggered a live probe. A shown reset
   * time that has passed probes once, so a probe that still reports the same
   * reset cannot start another.
   */
  private codexResetsProbed = new Set<number>();
  /**
   * Periodic channel-pane refresh timer (§17.4). Mirrors the TmuxPoller cadence
   * (~1s): when a team is selected (channelPane.teamName !== null) the timer
   * re-reads `<team>.channel.jsonl` + user.name and requests a render. Driving
   * this off a timer — NOT off render() — is what keeps the render path pure;
   * a load() inside render() would call requestRender on completion and spin.
   */
  private channelRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Periodic "Git Status" stoplight refresh (SPEC §11.4). Every tick probes
   * the SELECTED agent's worktree via `refreshGitStatus` with three git
   * processes — `status --porcelain`, `rev-parse --short HEAD`, and
   * `rev-list --count <parent>..HEAD` — and writes the answers to
   * `infoPanel.gitCleanliness` / `gitHead` / `gitCommitCount`.
   * Driven off a timer (plus a one-shot on selection change) — NOT off
   * render() — for the same reason as `channelRefreshTimer`: a probe inside
   * render() would call requestRender on completion and spin.
   */
  private gitStatusTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight guard so a slow `git status` never stacks up behind itself. */
  private gitStatusInFlight = false;
  /**
   * One-shot timer for the next wall-clock minute boundary (see
   * scheduleClockRender). Renders are otherwise driven only by input and data
   * changes, so without it the HH:MM footer clock would stall while idle.
   */
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private telegramStatus: "red" | "yellow" | "green" | null = null;
  /** Latest Telegram connection view (header light + help panel); null when
   *  no bot token is configured. Set through `setTelegramConnection`. */
  telegramConnection: TelegramConnectionView | null = null;
  /** 5 s backstop tick that re-derives the Telegram connection state. */
  telegramStatusTimer: ReturnType<typeof setInterval> | null = null;
  /** Latest shared sandbox denial collector probe (top bar + help panel). */
  collectorStatus: CollectorHealth | null = null;
  /** Latest system coordinator Remote Control light (top bar + help panel). */
  remoteControlStatus: RemoteControlStatus | null = null;
  /** The last read of the Remote Control files; null until the first read. */
  private remoteControlFiles: RemoteControlFiles | null = null;
  /** Where `refreshRemoteControlStatus` reads the files; a test seam. */
  remoteControlProbe: RemoteControlFilesOptions = {};
  /** A read in flight, and whether another was asked for meanwhile. */
  private remoteControlInFlight = false;
  private remoteControlQueued = false;
  /** Watcher updates in a row that reported the system coordinator stopped
   *  (see isSystemCoordinatorStopped). */
  private coordinatorStoppedUpdates = 0;
  /** The 5s tick that refreshes the Collector and Remote Control lights. */
  statusLightTimer: ReturnType<typeof setInterval> | null = null;
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
   * Which tab the sidebar renders in its tree region — Phase 1 of the
   * three-axis model (see SPEC §17.1). Independent of focus and of the global
   * selection (Phase 2). Switched by the `1` (agents), `2` (teams) and `3`
   * (favorites) keys; Tab cycling never changes it. Write it through
   * `setSidebarMode`, which also mirrors it into `focusManager.sidebarMode`
   * (Phase 3: Tab cycling depends on it) and turns the Agents tree's
   * Favorites view on or off.
   */
  sidebarMode: SidebarMode = "agents";
  /**
   * Which tree owns the GLOBAL selection — Phase 2 of the three-axis model
   * (see SPEC §17.1). Independent of `sidebarMode`. Updated whenever the user
   * navigates the visible tree (j/k/J/K) so that the navigated tree becomes
   * the active source (the Favorites tab navigates the Agents tree, so it
   * sets `"agents"`). `1`/`2`/`3` (sidebar tabs) NEVER change this — the
   * global selection persists across visibility flips.
   *
   * `syncSelectedAgent` reads selection from whichever tree this names; the
   * info / main / right panes therefore follow the global selection rather
   * than the visible tree.
   *
   * Mirroring: on a tab switch, the dashboard tries to mirror the agent
   * selection across trees for visual continuity (see
   * `mirrorSelectionToVisibleTree`). That is a VISUAL mirror only — it does
   * NOT change `activeSelectionSource`. The active source flips only when
   * the user navigates the visible tree.
   */
  activeSelectionSource: SelectionSource = "agents";
  /**
   * When true, run the one-time re-pin migration on the next populated onUpdate:
   * resize every existing agent + coordinator tmux window to PINNED_TMUX_WIDTH.
   * Live agents spawned before the pin (or by an older binary) may still be at an
   * old narrow width; this brings them up to the pin once. New spawns/resumes
   * already start at PINNED_TMUX_WIDTH via tmuxWidthForAgent.
   */
  private pendingTmuxResize = false;

  /**
   * Arm the one-time re-pin migration so the next populated onUpdate resizes
   * every existing agent + coordinator tmux window to PINNED_TMUX_WIDTH. Called
   * from the boot path (and implicitly by applyLayout) so pre-pin sessions are
   * brought up to the pin regardless of whether a saved layout was restored.
   */
  requestTmuxRepin(): void {
    this.pendingTmuxResize = true;
  }
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
  /** Cache of which agents have an attached tmux client, by fully qualified id (SPEC §17.1) */
  private _clientAttached: Map<string, boolean> = new Map();
  private clientCheckTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Coordinator-session attach cache (session name → attached), separate from the
   * agent cache. Coordinators (system + per-repo) can be opened in Ghostty too;
   * on the attached→detached transition we re-pin their window to
   * PINNED_TMUX_WIDTH, mirroring the agent mechanism. Coordinator panes render
   * agentless, so this drives no display state — only the re-pin side-effect.
   */
  private _coordClientAttached: Map<string, boolean> = new Map();
  private coordClientCheckTimer: ReturnType<typeof setInterval> | null = null;

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
   * Width the center tmux pane renders at — the split's left-pane width. The `S`
   * snapshot (agentActions.handleSnapshot) uses this to word-wrap the captured
   * output to the same width the user sees on screen.
   */
  getSnapshotPaneWidth(): number {
    return getLiveLeftPaneWidth(this.liveLayout());
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
      const trimmed = text.trim();
      const remote = this.remoteSelection;
      if (remote && remote.kind !== "remote-repo-header" && trimmed) {
        return this.submitRemoteMessage(remote, trimmed);
      }
      if (!agent || !trimmed) return;
      return promptAndStageAttachmentsIfNeeded({
        text: trimmed,
        baseDir: agent.repoPath,
        showDialog: (d) => this.showDialog(d),
        closeDialog: () => this.closeDialog(),
        setNotice: (msg, kind) => this.setNotice(msg, kind),
        onConfirm: (processedText) => {
          return this.executeSendAndRefresh(async () => {
            const result = await sendStagedMessage(agent, processedText, { cwd: "/", attachmentBaseDir: agent.repoPath });
            if (result.ok) { this.setNotice(`Sent to ${agent.id}`, "info"); return true; }
            this.setNotice(`Send failed: ${result.stderr || result.stdout}`, "error");
            return false;
          });
        },
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
      const trimmed = text.trim();
      if (!trimmed) return;
      // /restart and /respawn tear down and rebuild the system coordinator with
      // a FRESH session (cleared marker) rather than being typed into Claude's
      // prompt — parity with the Telegram dispatch. Intercept before the
      // verbatim send. (The resume-based `R` key is intentionally separate.)
      if (isCoordinatorRestartCommand(trimmed)) {
        this.setNotice("Restarting coordinator (fresh)…", "info");
        this.executeAndRefresh(async () => {
          const ready = await restartSystemCoordinatorFresh();
          this.coordinatorPane.resetForAgent();
          this.setNotice(
            ready
              ? "Coordinator restarted with a fresh session"
              : "Coordinator restart did not reach ready marker",
            ready ? "info" : "error",
          );
        });
        return;
      }
      const sanitized = sanitizeTmuxInput(trimmed);
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
        if (sendResult.ok) this.setNotice("Sent to coordinator", "info");
        else this.setNotice("Failed to send to coordinator", "error");
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
      const trimmed = text.trim();
      if (!agent || !trimmed) return;
      return promptAndStageAttachmentsIfNeeded({
        text: trimmed,
        baseDir: agent.repoPath,
        showDialog: (d) => this.showDialog(d),
        closeDialog: () => this.closeDialog(),
        setNotice: (msg, kind) => this.setNotice(msg, kind),
        onConfirm: (processedText) => {
          return this.executeSendAndRefresh(async () => {
            const result = await sendStagedMessage(agent, processedText, { cwd: "/", attachmentBaseDir: agent.repoPath });
            if (result.ok) { this.setNotice(`Sent to ${agent.id}`, "info"); return true; }
            this.setNotice(`Send failed: ${result.stderr || result.stdout}`, "error");
            return false;
          });
        },
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

    // No onWidth handler: tmux windows are pinned to PINNED_TMUX_WIDTH and never
    // follow the display pane, so a tmux-reported width must never mutate
    // splitPaneLeftWidth or layout.json. splitPaneLeftWidth is purely the DISPLAY
    // split position now (divider drag + persistence). Omitting onWidth also
    // stops the poller from querying window width every agent switch.
    this.tmuxPoller = new TmuxPoller({
      onOutput: (raw, _stripped) => {
        this.tmuxPane.rawOutput = raw;
        this.tmuxPane.hasPolled = true;
        this.tui?.requestRender();
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

    // The pollers deliver only changed output. A pane reset that keeps the same
    // session (e.g. resetForAgent() after a coordinator restart) must still get
    // the next capture, or the pane waits until the output changes. The repo
    // coordinator pane is only reset together with a session change.
    this.tmuxPane.onReset = () => this.tmuxPoller.redeliverNext();
    this.coordinatorPane.onReset = () => this.coordinatorPoller.redeliverNext();
  }

  setTui(tui: TUI) {
    this.tui = tui;
  }

  /** Apply a saved layout state to restore panel sizes, clamping the widths to valid ranges. */
  applyLayout(layout: LayoutState) {
    this.sidebarWidth = clampSidebarWidth(layout.sidebarWidth);
    // No coordinator tmux resize here: the system coordinator's window is pinned
    // to PINNED_TMUX_WIDTH and never follows mainWidth. Its pane reflows to
    // mainWidth at display time via WordWrapCache. The one-time re-pin migration
    // (pendingTmuxResize below) brings any pre-pin coordinator window up to the pin.
    this.splitPane.setLeftWidth(clampLeftWidthAbsolute(layout.splitPaneLeftWidth));
    this.sidebar.heightOffsets = { ...layout.heightOffsets };
    if (layout.repoCoordinatorHeightOffset !== undefined) {
      this.rightPane.repoCoordinatorHeightOffset = layout.repoCoordinatorHeightOffset;
    }
    if (layout.pinnedRepoPaths !== undefined) {
      this.agentTree.pinnedRepoPaths = new Set(layout.pinnedRepoPaths);
    }
    if (layout.pinnedRemoteRepoNames !== undefined) {
      this.agentTree.pinnedRemoteRepoNames = new Set(layout.pinnedRemoteRepoNames.map(name => name.toLowerCase()));
    }
    if (layout.favoriteAgentIds !== undefined) {
      this.agentTree.favoriteAgentIds = new Set(layout.favoriteAgentIds);
    }
    // No load-time clamp of heightOffsets: the base heights are not known yet
    // (they depend on the tab's row count), and a clamp against a guess would
    // undo a saved tree shrink. The sidebar render and the `{`/`}` resize
    // both use a clamped copy (SidebarComponent.clampedHeights), so an offset
    // from layout.json never drops a panel below 1 row.
    this.pendingTmuxResize = true;
  }

  /**
   * This machine's name (src/machine-name.ts), the first segment of every
   * local row key (SPEC §17.1). launchDashboard sets it before the first list
   * arrives; every component that keys or shows a local agent gets it.
   */
  setMachineName(name: string) {
    this.agentTree.machineName = name;
    this.teamsTree.machineName = name;
    this.rightPane.machineName = name;
    this.infoPanel.machineName = name;
  }

  /**
   * Mark the agent with this fully qualified id as a favorite (no toggle). The
   * new-agent form calls this for an agent made while the Favorites tab shows
   * (SPEC §17.1).
   */
  addFavorite(key: string) {
    this.agentTree.addFavorite(key);
    this.favoritesChanged();
  }

  /** Follow-up after the favorites set changed (the `.` key, addFavorite). */
  private favoritesChanged() {
    // The REPO/TREE pane rows carry the ★ too — rebuild them now rather
    // than on the next refresh tick.
    this.rightPane.favoriteAgentIds = this.agentTree.favoriteAgentIds;
    this.rightPane.updateContent();
    // Persist so favorites survive an `ib watch` restart.
    this.persistLayout();
    this.tui?.requestRender();
  }

  /** Persist current layout via debounced write. */
  persistLayout() {
    saveLayoutDebounced({
      sidebarWidth: this.sidebarWidth,
      splitPaneLeftWidth: this.splitPane.getLeftWidth(),
      heightOffsets: { ...this.sidebar.heightOffsets },
      repoCoordinatorHeightOffset: this.rightPane.repoCoordinatorHeightOffset,
      pinnedRepoPaths: Array.from(this.agentTree.pinnedRepoPaths),
      pinnedRemoteRepoNames: Array.from(this.agentTree.pinnedRemoteRepoNames),
      favoriteAgentIds: Array.from(this.agentTree.favoriteAgentIds),
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
    // when their panes are actually visible. updatePaneVisibility() starts the
    // ones that should be live now and leaves the rest stopped (saves a tmux
    // spawn/sec per hidden pane).
    this.updatePaneVisibility();
    this.refreshUsage();
    this.usageTimer = setInterval(() => this.refreshUsage(), 240_000);
    // Live Codex usage (SPEC.md §6.6.3): the session logs go stale when a
    // window resets and no codex session runs, so ask the account directly at
    // start and every 8 hours.
    this.probeCodexLiveUsage();
    this.codexLiveTimer = setInterval(() => this.probeCodexLiveUsage(), CODEX_LIVE_PROBE_INTERVAL_MS);
    // §17.4 channel-pane refresh tick (~1s, matches TmuxPoller cadence). Only
    // does work when a team is selected (refreshChannel returns immediately on
    // null teamName), so the cost when not on the Teams tab is one no-op call.
    this.channelRefreshTimer = setInterval(() => {
      void this.refreshChannel();
    }, 1000);
    // "Git Status" stoplight tick (§11.4). Only does work when an agent is
    // selected (refreshGitStatus returns immediately otherwise). 3s matches
    // the client-attached check cadence — three short git processes (status,
    // rev-parse, rev-list) for the selected agent every few seconds is cheap,
    // and selection changes probe immediately.
    this.gitStatusTimer = setInterval(() => {
      void this.refreshGitStatus();
    }, 3000);
    this.scheduleClockRender();
  }

  /**
   * Render once at the next wall-clock minute boundary, then re-arm. The footer
   * clock shows HH:MM, so this is the only render it needs. One timeout per
   * minute instead of an interval: each delay is measured from the real clock,
   * so the render cannot drift away from the boundary.
   */
  private scheduleClockRender(): void {
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    this.clockTimer = setTimeout(() => {
      this.tui?.requestRender();
      this.scheduleClockRender();
    }, msToNextMinute);
  }

  stopPolling() {
    this.tmuxPoller.stop();
    this.remotePane.select(null);
    this.remotePrompt.select(null);
    this.coordinatorPoller.stop();
    this.repoCoordinatorPoller.stop();
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
    if (this.codexLiveTimer) {
      clearInterval(this.codexLiveTimer);
      this.codexLiveTimer = null;
    }
    if (this.channelRefreshTimer) {
      clearInterval(this.channelRefreshTimer);
      this.channelRefreshTimer = null;
    }
    if (this.gitStatusTimer) {
      clearInterval(this.gitStatusTimer);
      this.gitStatusTimer = null;
    }
    if (this.clockTimer) {
      clearTimeout(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.clientCheckTimer) {
      clearInterval(this.clientCheckTimer);
      this.clientCheckTimer = null;
    }
    if (this.coordClientCheckTimer) {
      clearInterval(this.coordClientCheckTimer);
      this.coordClientCheckTimer = null;
    }
    if (this.telegramStatusTimer) {
      clearInterval(this.telegramStatusTimer);
      this.telegramStatusTimer = null;
    }
    if (this.statusLightTimer) {
      clearInterval(this.statusLightTimer);
      this.statusLightTimer = null;
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
  private updatePaneVisibility() {
    this.syncRemotePane();
    const peerCoordinator = this.remoteSelection?.kind === "remote-coordinator";
    this.statusBar.remoteCoordinatorVisible = peerCoordinator;
    if (peerCoordinator) {
      this.focusManager.skipTargets.add("right-pane");
      const focus = this.focusManager.current();
      if (focus === "right-pane") this.focusManager.setFocus("active-agent");
    } else {
      this.focusManager.skipTargets.delete("right-pane");
    }
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

    // Coordinator windows can be opened in Ghostty (handleOpenGhosttyTmux covers
    // IB_COORDINATOR_SESSION + the per-repo coordinator). Run a client-attach
    // check for whichever coordinator session is currently displayed so we re-pin
    // it to PINNED_TMUX_WIDTH on the attached→detached transition — the agent
    // checkClientAttached path never covers coordinators.
    this.updateCoordinatorClientCheck(coordinatorVisible, repoCoordinatorVisible);
  }

  /**
   * Sessions of the coordinator panes currently displayed in the main area
   * (system coordinator and/or per-repo coordinator). These are the only
   * coordinator windows a Ghostty attach/detach can affect while visible.
   */
  private visibleCoordinatorSessions(coordinatorVisible: boolean, repoCoordinatorVisible: boolean): string[] {
    const sessions: string[] = [];
    if (coordinatorVisible) sessions.push(IB_COORDINATOR_SESSION);
    if (repoCoordinatorVisible && this.repoCoordinatorSession) {
      sessions.push(this.repoCoordinatorSession);
    }
    return sessions;
  }

  /**
   * Start/stop a 3s client-attach check for the visible coordinator session(s),
   * mirroring the agent clientCheckTimer. On the attached→detached transition,
   * re-pin the window to PINNED_TMUX_WIDTH (attaching in Ghostty dropped the pin
   * so the window followed the client). Stops the timer when no coordinator pane
   * is visible.
   */
  private updateCoordinatorClientCheck(coordinatorVisible: boolean, repoCoordinatorVisible: boolean): void {
    const anyVisible = coordinatorVisible || repoCoordinatorVisible;
    if (!anyVisible) {
      if (this.coordClientCheckTimer) {
        clearInterval(this.coordClientCheckTimer);
        this.coordClientCheckTimer = null;
      }
      return;
    }
    if (!this.coordClientCheckTimer) {
      this.coordClientCheckTimer = setInterval(() => this.checkCoordinatorClients(), 3000);
      // Fire one check immediately when a coordinator pane becomes visible
      // (mirrors checkClientAttached on agent re-selection). If the user
      // navigated away, detached Ghostty, and came back, this re-pins on return
      // instead of waiting up to 3s for the first interval tick.
      void this.checkCoordinatorClients();
    }
  }

  /**
   * One tick of the coordinator client-attach check: for each currently-visible
   * coordinator session, re-pin to PINNED_TMUX_WIDTH on the attached→detached
   * transition. Recomputes the visible set each tick so a selection change
   * between ticks is handled. Public for testing (drive one tick directly).
   */
  async checkCoordinatorClients(): Promise<void> {
    const coordinatorVisible =
      this.activeSelectionSource === "agents"
      && this.agentTree.isSystemCoordinatorSelected
      && this.coordinatorViewMode === "TMUX";
    const repoCoordinatorVisible =
      this.rightPane.mode === "REPO" && this.rightPane.repoCoordinatorAgent != null;
    const sessions = this.visibleCoordinatorSessions(coordinatorVisible, repoCoordinatorVisible);
    // Do NOT drop attach state for sessions that are momentarily not visible.
    // The last-observed state must persist across visibility changes, exactly
    // like the agent path (_clientAttached is never deleted on switch-away).
    // Otherwise: open a coordinator in Ghostty (observed attached) → navigate
    // away (delete + timer stop) → detach Ghostty while away → navigate back →
    // wasAttached would read false and the attached→detached transition is never
    // observed, leaving the window stuck at the Ghostty width forever (window-size
    // latest persists after detach). Preserving the state means the next live
    // check on return sees wasAttached=true, attached=false → one re-pin. The
    // guard is safe: `attached` is from the LIVE check, so a still-attached
    // session can't spuriously re-pin, and re-pin is idempotent.
    for (const session of sessions) {
      const attached = await hasAttachedClient(session);
      const wasAttached = this._coordClientAttached.get(session) ?? false;
      this._coordClientAttached.set(session, attached);
      if (wasAttached && !attached) {
        resizeTmuxWindow(session, PINNED_TMUX_WIDTH);
      }
    }
  }

  private refreshUsage() {
    const fetchers = usageFetchCtx.fn;
    // Each update renders only when the status bar would change.
    fetchers.readClaudeUsage()
      .then((result) => {
        if (sameUsage(this.statusBar.claudeUsage, result.data) && this.statusBar.claudeUsageError === result.error) return;
        this.statusBar.claudeUsage = result.data;
        this.statusBar.claudeUsageError = result.error;
        this.tui?.requestRender();
      })
      .catch(() => {
        if (this.statusBar.claudeUsageError) return;
        this.statusBar.claudeUsageError = true;
        this.tui?.requestRender();
      });

    this.refreshGeminiUsage();

    fetchers.readCodexLogUsage()
      .then((reading) => {
        this.codexLogReading = reading;
        this.showCodexUsage();
      })
      .catch(() => {
        if (this.statusBar.codexUsageError) return;
        this.statusBar.codexUsageError = true;
        this.tui?.requestRender();
      });
  }

  /**
   * Show the newer of the session-log and live Codex readings, with reset
   * times formatted against the clock now (the readings keep raw reset
   * times). Renders only when the status bar would change. When a shown reset
   * time has passed, the footer would read "(now)" from a stale reading, so
   * probe once for that reset.
   */
  private showCodexUsage(): void {
    const nowMs = Date.now();
    const reading = newerCodexReading(this.codexLogReading, this.codexLiveReading);
    const result = codexUsageResult(reading, new Date(nowMs));
    if (!sameUsage(this.statusBar.codexUsage, result.data) || this.statusBar.codexUsageError !== result.error) {
      this.statusBar.codexUsage = result.data;
      this.statusBar.codexUsageError = result.error;
      this.tui?.requestRender();
    }
    this.probeCodexAfterReset(reading, nowMs);
  }

  /**
   * Probe live Codex usage once per passed reset time of the shown reading.
   * Only while polling runs, and never while a probe is in flight: that probe
   * answers first, and a reset it still reports gets its own probe later.
   */
  private probeCodexAfterReset(reading: CodexUsageReading | null, nowMs: number): void {
    if (!this.codexLiveTimer || this.codexLiveProbeInFlight) return;
    const unprobed = passedCodexResets(reading, nowMs).filter((resetMs) => !this.codexResetsProbed.has(resetMs));
    if (unprobed.length === 0) return;
    for (const resetMs of unprobed) this.codexResetsProbed.add(resetMs);
    this.probeCodexLiveUsage();
  }

  /**
   * Ask the account for its Codex windows (`codex app-server`). At most one
   * probe runs at a time. A failed probe keeps the previous reading and adds
   * no warning; the session-log reading still shows as before.
   */
  private probeCodexLiveUsage(): void {
    if (this.codexLiveProbeInFlight) return;
    this.codexLiveProbeInFlight = true;
    usageFetchCtx.fn.fetchCodexLiveUsage()
      .then((result) => {
        if (!result.reading) return;
        this.codexLiveReading = result.reading;
        this.showCodexUsage();
      })
      .catch(() => {})
      .finally(() => {
        this.codexLiveProbeInFlight = false;
      });
  }

  /**
   * Poll agy usage, but only while a live agy agent exists: each `agy -p /usage`
   * run can open a browser login window when agy cannot read its stored token.
   * After a run that looks like a login prompt, the auth latch stops all later
   * polls and the status bar shows "agy login needed" until `ib watch` restarts.
   */
  private refreshGeminiUsage() {
    if (this.agyUsageAuthLatched) return;
    if (!this.hasLiveAgyAgent) {
      if (this.statusBar.geminiUsage === null && !this.statusBar.geminiUsageError) return;
      this.statusBar.geminiUsage = null;
      this.statusBar.geminiUsageError = false;
      this.tui?.requestRender();
      return;
    }
    if (this.geminiUsageInFlight) return;
    this.geminiUsageInFlight = true;
    usageFetchCtx.fn.fetchGeminiUsage()
      .then((result) => {
        if (result.authFailed) {
          this.agyUsageAuthLatched = true;
          this.statusBar.geminiUsage = null;
          this.statusBar.geminiUsageError = false;
          this.statusBar.geminiLoginNeeded = true;
        } else if (this.hasLiveAgyAgent) {
          if (sameUsage(this.statusBar.geminiUsage, result.data) && this.statusBar.geminiUsageError === result.error) return;
          this.statusBar.geminiUsage = result.data;
          this.statusBar.geminiUsageError = result.error;
        }
        this.tui?.requestRender();
      })
      .catch(() => {
        if (!this.hasLiveAgyAgent || this.statusBar.geminiUsageError) return;
        this.statusBar.geminiUsageError = true;
        this.tui?.requestRender();
      })
      .finally(() => {
        this.geminiUsageInFlight = false;
      });
  }

  setWatcher(watcher: AgentWatcher) {
    this.watcher = watcher;
    // Re-apply the parent-grouping preference in case the startup config read
    // ran before the watcher was wired (setGroupByParent is a no-op on a null
    // watcher). The watcher's own default is false, so this only matters when
    // the persisted value is true.
    watcher.setGroupByParent(this.groupByParent);
  }

  setRepos(repos: RepoEntry[]) {
    this.repos = repos;
    this.agentTree.registeredRepos = repos;
    void this.refreshRepoCloneInfo();
  }

  /** Re-read {@link repoCloneInfo} for the current repos. A re-read that a newer one overtook is dropped. */
  async refreshRepoCloneInfo(): Promise<void> {
    const generation = ++this.repoCloneInfoGeneration;
    const repos = [...this.repos];
    try {
      const root = await resolveCloneRoot();
      const entries = await Promise.all(repos.map(async (repo) => [repo.path, await readRepoCloneInfo(repo.path, root)] as const));
      if (generation === this.repoCloneInfoGeneration) this.repoCloneInfo = new Map(entries);
    } catch (err) {
      logToWatchLog(`[peers] could not read the repos' remote URLs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  setDiffTool(tool: string | undefined) {
    this.diffTool = tool;
  }

  /**
   * Push the `tree.groupByParent` display preference down to the watcher, which
   * owns the flag and re-flattens the tree on change (LIVE — no `ib watch`
   * restart). Called once at startup with the persisted config value and again
   * from the 'h' settings-menu toggle via onConfigChange(). Safe to call before
   * the watcher exists (setWatcher runs after the startup read); the value is
   * re-applied whenever the watcher is (re)wired below.
   */
  setGroupByParent(value: boolean): void {
    this.groupByParent = value;
    this.watcher?.setGroupByParent(value);
  }

  /**
   * ActionCtx hook: the 'h' settings menu calls this after a successful
   * writeConfig so config keys take effect live. `tree.groupByParent`
   * re-flattens the tree; `repos.cloneRoot` re-reads each repo's `relPath`
   * for the peer snapshot. Other keys are read at their own use sites.
   */
  onConfigChange(key: string, value: unknown): void {
    if (key === "tree.groupByParent") {
      this.setGroupByParent(value === true);
    } else if (key === "repos.cloneRoot") {
      void this.refreshRepoCloneInfo();
    }
  }

  setVersion(version: string) {
    this.statusBar.version = version;
  }

  setTelegramStatus(status: "red" | "yellow" | "green" | null): void {
    // The 5s health tick re-sends the same status; only a change needs a render.
    if (this.telegramStatus === status) return;
    this.telegramStatus = status;
    this.tui?.requestRender();
  }

  /** Apply a Telegram connection view (src/channels/connection-view.ts): the
   *  header light from `telegramLight`, and the view itself for the `?` help
   *  row. Null hides both. */
  setTelegramConnection(view: TelegramConnectionView | null): void {
    this.telegramConnection = view;
    this.setTelegramStatus(view ? telegramLight(view) : null);
  }

  setCollectorStatus(status: CollectorHealth): void {
    // The 5s probe re-sends the same light (its heartbeat age always moves);
    // only a new color needs a render. The label never changes.
    const changed = this.collectorStatus?.light !== status.light;
    this.collectorStatus = status;
    if (changed) this.tui?.requestRender();
  }

  setRemoteControlStatus(status: RemoteControlStatus): void {
    // The 5s probe re-sends the same light; only a new color, or the indicator
    // appearing or disappearing, needs a render. Before the first probe the
    // indicator is hidden, the same as a hidden light.
    const changed = (this.remoteControlStatus?.light ?? null) !== status.light;
    this.remoteControlStatus = status;
    if (changed) this.tui?.requestRender();
  }

  /** Re-read the Remote Control files (src/remote-control-light.ts) and apply
   *  the light. Every call reads them again, so the tick after a coordinator
   *  restart shows the settings file that relaunch wrote. A call while a read
   *  is in flight makes that read run once more when it ends, so a read that
   *  began before a settings rewrite is never the last one. */
  async refreshRemoteControlStatus(): Promise<void> {
    if (this.remoteControlInFlight) {
      this.remoteControlQueued = true;
      return;
    }
    this.remoteControlInFlight = true;
    try {
      do {
        this.remoteControlQueued = false;
        this.remoteControlFiles = await readRemoteControlFiles(this.remoteControlProbe);
      } while (this.remoteControlQueued);
    } finally {
      this.remoteControlInFlight = false;
    }
    this.applyRemoteControlStatus();
  }

  /** Refresh the light once `launch` (the not-awaited startup
   *  `ensureSystemCoordinator()`) settles: a launch rewrites the settings file,
   *  and the first read may have run before it did. */
  async refreshRemoteControlAfterLaunch(launch: Promise<unknown>): Promise<void> {
    await launch.catch(() => {});
    await this.refreshRemoteControlStatus();
  }

  /** Combine the last file read with the coordinator's state. No IO, so every
   *  watcher update can run it; a no-op before the first read. */
  private applyRemoteControlStatus(): void {
    if (!this.remoteControlFiles) return;
    this.setRemoteControlStatus(remoteControlStatus(this.remoteControlFiles, this.isSystemCoordinatorStopped()));
  }

  /** Feed one watcher update's system coordinator state to the light. */
  private noteSystemCoordinatorState(state: string | undefined): void {
    this.coordinatorStoppedUpdates = state === "stopped" ? this.coordinatorStoppedUpdates + 1 : 0;
    this.applyRemoteControlStatus();
  }

  /**
   * Whether the Remote Control light treats the system coordinator as
   * stopped: two watcher updates in a row reported it "stopped" (no tmux
   * session). An absent watcher entry or any other state resets the count.
   * A launch leaves no session for well under a second (a restart kills the
   * old one first; a first launch has not created it yet), and watcher passes
   * run on a 2 s tick, so two stopped updates in a row mean it really is stopped.
   * A stale stopped pass that finishes after a launch is followed by a running
   * pass, which resets the count. This holds for a launch from any process,
   * `ib respawn @system` included.
   */
  isSystemCoordinatorStopped(): boolean {
    return this.coordinatorStoppedUpdates >= 2;
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

  /** A peer's request ran here; `kind` is "error" for a merge whose push then failed. */
  remoteAgentStarted(message: string, kind: "info" | "error" = "info"): void {
    this.setNotice(message, kind);
    void this.watcher?.refresh();
  }

  /** Poll updates can affect the unified tree, a remote selection, and the Peers tab. */
  setPeerService(service: PeersDialogService): void {
    this.peerService = service;
    let receipts = JSON.stringify(service.view().incoming ?? []);
    service.onChange(() => {
      const next = JSON.stringify(service.view().incoming ?? []);
      const receiptsChanged = next !== receipts;
      receipts = next;
      const changed = this.refreshPeerRepos();
      this.syncRemotePane();
      const dialog = this._dialog;
      if (dialog?.type === "setup" && dialog.peers) {
        syncPeersDialog(dialog.peers);
        this.tui?.requestRender();
      } else if (receiptsChanged || changed || this.remoteSelection?.kind === "remote-coordinator" || dialog?.type === "new-agent-form" || dialog?.type === "scheduled-task-form") {
        if (dialog?.type === "new-agent-form") syncNewAgentMachine(dialog);
        this.tui?.requestRender();
      }
    });
    this.refreshPeerRepos();
  }

  private refreshPeerRepos(): boolean {
    const view = this.peerService?.view();
    const links = view?.links ?? [];
    const peers = view?.peers ?? [];
    const samePeers = this.pairedPeers.length === peers.length && peers.every((peer, i) =>
      this.pairedPeers[i]!.id === peer.id && this.pairedPeers[i]!.name === peer.name);
    // Stable snapshot references from the poller make dialog-only changes cheap.
    if (samePeers && links.length === this.peerLinks.length && links.every((link, i) => {
      const old = this.peerLinks[i]!;
      return link.id === old.id && link.name === old.name && link.repos === old.repos && link.agents === old.agents
        && link.questions === old.questions && peerLinkStatus(link) === peerLinkStatus(old) && link.coordinator?.state === old.coordinator?.state
        && link.connectedAt === old.connectedAt && (link.connected || link.lastOkAt === old.lastOkAt);
    })) return false;
    this.peerLinks = links;
    this.pairedPeers = peers;
    const treeVisible = this.sidebarMode !== "teams" || this.rightPane.mode === "TREE";
    const width = this.rightPane.mode === "TREE" ? this.getMainWidth() : this.sidebarWidth;
    const before = treeVisible ? this.agentTree.render(width) : [];
    const previous = this.remoteSelection;
    this.agentTree.setPeerLinks(links, peers);
    const questionsChanged = this.syncQuestions();
    const selected = this.remoteSelection;
    // The connector can change when another root appears. Only the tree displays it.
    const details = (entry: RemoteEntry | null) => entry?.kind === "remote-agent"
      ? [entry.peerName, entry.remote, entry.linkStatus] : entry;
    const selectionChanged = JSON.stringify(details(previous)) !== JSON.stringify(details(selected));
    if (selectionChanged) this.syncSelectedAgent();
    else if (questionsChanged) this.rightPane.updateContent();
    if (selectionChanged || questionsChanged || !treeVisible) return selectionChanged || questionsChanged;
    const after = this.agentTree.render(width);
    return before.length !== after.length || before.some((line, i) => line !== after[i]);
  }

  /**
   * The QUESTIONS list (SPEC §20.5): the local questions, then each connected
   * peer's in peers.json order, only for an agent with a remote row and not
   * acknowledged from here. Also the footer count and the red names. Returns
   * whether the list changed.
   */
  private syncQuestions(): boolean {
    const listed = new Set<string>();
    const peerQuestions: PendingQuestion[] = [];
    const askers = new Set(this.localQuestionKeys);
    for (const link of this.peerLinks) {
      for (const q of link.questions ?? []) {
        const key = `${link.id}\0${q.id}`;
        listed.add(key);
        const row = link.connected && !this.acknowledgedPeerQuestions.has(key)
          ? this.agentTree.remoteAgentRow(link.id, q.repoRegistryName, q.agent) : null;
        if (!row) continue;
        peerQuestions.push({
          id: q.id, agent: q.agent, question: q.question, timestamp: q.timestamp, status: "pending",
          repoPath: row.remote.repoPath, peer: { id: link.id, name: link.name, repo: q.repoRegistryName },
        });
        askers.add(peerEntryKey(row));
      }
    }
    for (const key of this.acknowledgedPeerQuestions) if (!listed.has(key)) this.acknowledgedPeerQuestions.delete(key);
    const questions = [...this.localQuestions, ...peerQuestions];
    const changed = JSON.stringify(questions) !== JSON.stringify(this.rightPane.questions);
    this.rightPane.questions = questions;
    this.statusBar.pendingQuestions = questions.length;
    this.agentTree.questionAgentKeys = askers;
    const filtered = this.rightPane.filteredQuestions;
    if (this.rightPane.questionsSelectedIndex >= filtered.length) {
      this.rightPane.questionsSelectedIndex = Math.max(0, filtered.length - 1);
    }
    return changed;
  }

  /** A remote agent's QUESTIONS replace its split view with the normal full-width pane (SPEC §20.5). */
  private get remoteQuestionsVisible(): boolean {
    return this.remoteSelection?.kind === "remote-agent" && this.rightPane.mode === "QUESTIONS";
  }

  /** Acknowledge a peer question on the machine that owns it. It leaves the list and the red name at once. */
  async acknowledgePeerQuestion(peer: NonNullable<PendingQuestion["peer"]>, id: string): Promise<void> {
    if (!this.peerService) throw new Error("Remote questions are unavailable");
    await this.peerService.acknowledgeRemoteQuestion(peer.id, peer.repo, id);
    this.acknowledgedPeerQuestions.add(`${peer.id}\0${id}`);
    this.syncQuestions();
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  private get teamChannelVisible(): boolean {
    return this.activeSelectionSource === "teams" && (this.channelPane.teamName !== null || this.teamsTree.selection === null);
  }

  private get expandedAgentsTreeVisible(): boolean {
    return this.rightPane.mode === "TREE" && !this.teamChannelVisible
      && !(this.activeSelectionSource === "agents" && this.agentTree.isSystemCoordinatorSelected);
  }

  private get visibleNavigationTree(): "teams-tree" | "agent-tree" {
    return this.sidebarMode === "teams" && !this.expandedAgentsTreeVisible ? "teams-tree" : "agent-tree";
  }

  /** Only the Agents tree can own a remote selection. */
  get remoteSelection(): RemoteEntry | null {
    return this.activeSelectionSource === "agents" ? this.agentTree.selectedRemote : null;
  }

  private escapeSend() {
    if (!this.pendingRemoteSends.size || this._dialog) return;
    if (this.selectedReceipt && this.peerService?.view().incoming?.some(row => row.id === this.selectedReceipt)) return;
    const selected = this.remoteSelection;
    const target = remoteMessageTarget(selected);
    if (!selected || selected.kind === "remote-repo-header" || !target) return;
    return [...this.pendingRemoteSends.values()].reverse().find(send =>
      send.peerId === selected.peerId && JSON.stringify(send.target) === JSON.stringify(target));
  }

  async stopRemoteSends() {
    const sends = [...this.pendingRemoteSends.values(), ...this.remoteStart ? [this.remoteStart] : []];
    for (const { controller } of sends) controller.abort(new Error("Dashboard shutting down"));
    await Promise.allSettled(sends.map(send => send.done));
  }

  async shutdownPeerTransfers(service: Pick<PeerService, "shutdown">) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([this.stopRemoteSends(), service.shutdown()]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async runRemoteRowCommand(row: Extract<RemoteEntry, { kind: "remote-agent" }>, options: Pick<RemoteLifecycleRequest, "action" | "checkOnly" | "keep">) {
    const service = this.peerService;
    if (!service) throw new Error("Remote lifecycle commands are unavailable");
    if (service.remoteStartDenial !== null) throw new Error(remoteLifecycleDenial(service.remoteStartDenial, options.action));
    const { id, repoRegistryName: repo } = row.remote;
    const label = `${row.peerName}/${repo}/${id}`;
    if (this.pendingLifecycle.has(label)) throw new Error(`A remote command is already pending for ${label}`);
    this.pendingLifecycle.set(label, `${options.checkOnly ? "merge-check" : options.action} ${label}…`);
    this.invalidate();
    this.tui?.requestRender();
    try {
      const { output, pushFailure, warnings } = await service.runRemoteLifecycle(row.peerId, { ...options, id, repo });
      if (!options.checkOnly) {
        const verb = lifecyclePast[options.action];
        if (pushFailure) {
          // The peer merged, then its own push failed (merge.pushAfterMerge,
          // read from its config). As for a local merge: a red notice that
          // names the failure, and the teardown warnings, if any, in their
          // own dialog. The output repeats the merge report in full.
          const notice = pushFailedNotice(`${label} ${verb}`, pushFailure);
          this.setNotice(notice, "error");
          if (warnings) this.showDialog({ type: "cleanup-warnings", text: `${notice}\n\n${warnings}`, offset: 0 });
        } else {
          this.setNotice(options.keep ? `${label}: ${output}` : `${label} ${verb}${output ? ": " + output : ""}`, "info");
        }
      }
      return output;
    } finally {
      this.pendingLifecycle.delete(label);
      this.invalidate();
      this.tui?.requestRender();
    }
  }

  /**
   * `b` on a remote agent (SPEC §20.4 "Remote permissions"): with no change,
   * read its spawn capability for the dialog. Pending like a lifecycle command.
   */
  async runRemotePermissions(row: Extract<RemoteEntry, { kind: "remote-agent" }>, change: Pick<RemotePermissionRequest, "allow" | "canSpawnChildren">): Promise<RemotePermissionOutcome> {
    const service = this.peerService;
    if (!service) throw new Error("Remote permissions are unavailable");
    if (service.remoteStartDenial !== null) throw new Error(remotePermissionDenial(service.remoteStartDenial));
    const { id, repoRegistryName: repo } = row.remote;
    const label = `${row.peerName}/${repo}/${id}`;
    if (this.pendingLifecycle.has(label)) throw new Error(`A remote command is already pending for ${label}`);
    this.pendingLifecycle.set(label, `permissions ${label}…`);
    this.invalidate();
    this.tui?.requestRender();
    try {
      return await service.remotePermissions(row.peerId, { ...change, repo, id });
    } finally {
      this.pendingLifecycle.delete(label);
      this.invalidate();
      this.tui?.requestRender();
    }
  }

  /**
   * Send `text` from the user to a remote row (SPEC §20.5), shown as a pending
   * `sending to <target>…` entry in the header alert until the peer accepts it. Resolves true on
   * acceptance; on failure it shows the reason and resolves false. Aborting
   * `controller` cancels the send. When `text` names files the peer can take
   * as attachments, the path dialog asks which to attach first; cancelling it
   * sends nothing and resolves false. `hooks.onPending` runs once the entry
   * shows, and `hooks.onSent` once the request is written and can no longer be
   * cancelled.
   */
  async submitRemoteMessage(remote: RemoteMessageEntry, text: string, controller = new AbortController(), hooks: agentActions.RemoteSendHooks = {}): Promise<boolean> {
    const service = this.peerService;
    const header = textHeader(remoteMessageTarget(remote), text, { kind: "user" });
    const label = remoteTitle(remote);
    const done = Promise.withResolvers<void>();
    const pending = { id: header.id, peerId: remote.peerId, peerName: remote.peerName, target: header.target, label, controller, done: done.promise,
      bytes: 0, total: undefined as number | undefined, sent: false };
    let staged: StagedPeerAttachments | undefined;
    try {
      if (!service) throw new Error("Remote messaging is unavailable");
      if (service.remoteStartDenial !== null) throw new Error(remoteSendDenial(service.remoteStartDenial));
      const repo = remote.kind === "remote-agent" ? remote.remote : undefined;
      const local = repo && this.repos.find(entry => repoRowKey(entry.name) === repoRowKey(repo.repoRegistryName));
      const { candidates, noPassthrough } = await peerAttachmentCandidates(text, local?.path);
      if (noPassthrough) header.noPassthrough = true;
      controller.signal.throwIfAborted();
      let paths: PeerAttachmentCandidate[] = [];
      if (candidates.length) {
        const selected = await this.choosePeerAttachments(candidates, remote.peerName);
        if (!selected) {
          this.setNotice("Send cancelled", "info");
          return false;
        }
        paths = candidates.filter(candidate => selected.has(candidate.argument));
      }
      this.pendingRemoteSends.set(header.id, pending);
      this.invalidate();
      this.tui?.requestRender();
      hooks.onPending?.();
      if (paths.length) {
        staged = await stagePeerAttachments(paths, {
          signal: controller.signal, onCleanupError: err => this.addError(`Outgoing attachment cleanup failed: ${err}`),
        });
        header.files = staged.files;
        pending.total = header.files.reduce((sum, file) => sum + file.size, 0);
      }
      await service.sendRemoteMessage(remote.peerId, header, "dashboard", {
        filesDir: staged?.filesDir, signal: controller.signal, onProgress: bytes => {
          pending.bytes = bytes;
          this.invalidate();
          this.tui?.requestRender();
        }, onSent: () => {
          pending.sent = true;
          hooks.onSent?.();
          this.invalidate();
          this.tui?.requestRender();
        },
      });
      this.setNotice(`Sent to ${label}`, "info");
      return true;
    } catch (err) {
      this.setNotice(err instanceof Error ? err.message : String(err), "error");
      return false;
    } finally {
      try { await staged?.cleanup(); }
      finally { this.pendingRemoteSends.delete(header.id); done.resolve(); }
      this.invalidate();
      this.tui?.requestRender();
    }
  }

  /**
   * The path dialog of a send to `peerName` (SPEC §20.5), every path
   * unchecked at first. The checked paths, or null when the user cancels. It takes the place of the open dialog (the frozen send
   * dialog), which comes back when it closes.
   */
  private choosePeerAttachments(candidates: readonly PeerAttachmentCandidate[], peerName: string): Promise<Set<string> | null> {
    const previous = this._dialog;
    return choosePaths({
      paths: candidates.map(candidate => candidate.argument),
      prompt: peerAttachmentPrompt(peerName),
      showDialog: dialog => this.showDialog(dialog),
      closeDialog: () => {
        this.closeDialog();
        if (previous) this.showDialog(previous);
      },
    });
  }

  /**
   * The read-only guard (SPEC §20.5): while the effective selection is a
   * remote row, refuse `key` with a notice unless isRemoteAllowedKey
   * allows it. Returns true when it refused. The key dispatch (handleInput)
   * and the command palette both go through it.
   */
  refuseOnRemoteRow(key: string): boolean {
    const remote = this.remoteSelection;
    if (remote?.kind === "remote-coordinator" && ["[", "]", "{", "}"].includes(key)) {
      this.setNotice("resize from a local row", "info");
      return true;
    }
    if (remote?.kind === "remote-coordinator" && (["p", "n", "d", "e", "g"].includes(key) || matchesKey(key, Key.left) || matchesKey(key, Key.right))) {
      this.setNotice("view mode is fixed for remote coordinators", "info");
      return true;
    }
    if (key === "s" && remoteMessageTarget(remote)) return false;
    // A remote agent's QUESTIONS: answer, acknowledge, go to the agent.
    if (this.remoteQuestionsVisible && (key === "g" || matchesKey(key, Key.enter) || matchesKey(key, Key.escape))) return false;
    if (remote === null || isRemoteAllowedKey(key, remote)) return false;
    if (remote.kind !== "remote-repo-header" && (key === ";" || key === "l")) return false;
    // A remote-only header also takes Clone here.
    if (remote.kind === "remote-repo-header" && key === "c") return false;
    this.setNotice(REMOTE_READ_ONLY_NOTICE, "error");
    return true;
  }

  private scrollOutput(up: boolean): void {
    // A remote agent's QUESTIONS hide its capture: scroll the list, as for a local agent.
    if (remoteMessageTarget(this.remoteSelection) && !this.remoteQuestionsVisible) {
      this.remotePane.scroll(up ? agentActions.SCROLL_STEP : -agentActions.SCROLL_STEP);
      // As on a local agent, a remote agent's right pane (INITIAL PROMPT) scrolls
      // with the output. A peer coordinator has no right pane.
      if (this.remoteSelection?.kind === "remote-agent") {
        this.rightPane.scrollOffset = Math.max(0, this.rightPane.scrollOffset + (up ? agentActions.SCROLL_STEP : -agentActions.SCROLL_STEP));
      }
    } else if (up) agentActions.handleScrollUp(this);
    else agentActions.handleScrollDown(this);
  }

  showDialog(dialog: NonNullable<DialogState>) {
    if (dialog.type === "cleanup-warnings" && (this._dialog || this.pendingCleanupWarnings.length > 0)) {
      this.pendingCleanupWarnings.push(dialog);
      return;
    }
    this.openDialog(dialog);
  }

  private openDialog(dialog: NonNullable<DialogState>) {
    const previous = this._dialog;
    this._dialog = dialog;
    this.syncRemotePane();
    const width = dialog.width
      ?? (dialog.type === "help" ? 72
        : dialog.type === "multi-select" ? MULTI_SELECT_WIDTH
        : (dialog.type === "folder-browser" || dialog.type === "new-agent-form" || dialog.type === "scheduled-task-form" || dialog.type === "setup" || dialog.type === "permissions-editor") ? 70
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
    this.updatePeersTabVisibility(previous);
  }

  private updatePeersTabVisibility(previous: DialogState): void {
    const before = previous?.type === "setup" ? previous.peers?.service : undefined;
    const after = this._dialog?.type === "setup" ? this._dialog.peers?.service : undefined;
    if (before === after) return;
    if (before) {
      cancelPaste();
      before.closeDialog();
    }
    after?.openDialog();
  }

  closeDialog() {
    const previous = this._dialog;
    this._dialog = null;
    this.syncRemotePane();
    this.updatePeersTabVisibility(previous);
    this.overlayHandle?.hide();
    this.overlayHandle = null;
    this.tui?.requestRender();
    if (this.pendingCleanupWarnings.length > 0) {
      // A dialog may synchronously hand off to another dialog as it closes.
      queueMicrotask(() => {
        if (this._dialog) return;
        const next = this.pendingCleanupWarnings.shift();
        if (next) this.openDialog(next);
      });
    }
  }

  setNotice(text: string, kind: "info" | "error") {
    const id = ++this.noticeCounter;
    // The notice shares the header's single row; a newline (multi-line git
    // output, such as a failed pull before `ib merge`) would spill onto the
    // next row and shift the layout, so the lines are joined.
    this.lastSentNotice = text.trim().replace(/\s*\n\s*/g, " · ");
    this.lastSentNoticeKind = kind;
    this.invalidate();
    this.tui?.requestRender();
    setTimeout(() => {
      if (this.noticeCounter === id) {
        this.lastSentNotice = null;
        this.lastSentNoticeKind = "info";
        this.tui?.requestRender();
      }
    }, 3000);
  }

  async executeAndRefresh(fn: () => Promise<void>) {
    const p = (async () => {
      try {
        await fn();
      } catch (err) {
        this.setNotice(`Error: ${err}`, "error");
      }
      this.watcher?.refresh();
    })();
    this._pendingActions.add(p);
    p.finally(() => this._pendingActions.delete(p));
    await p;
  }

  /**
   * Acceptance-gated variant of {@link executeAndRefresh} for inline send paths.
   * The body reports whether the send was ACCEPTED (ok); that flag flows back to
   * the input field so it clears the draft only on acceptance and keeps it on
   * failure. Errors are surfaced as a notice and reported as NOT accepted, so a
   * throwing send never silently discards the user's draft. Registered with
   * `_pendingActions` (as a void view) so tests can await it via
   * {@link flushPendingActions}.
   */
  executeSendAndRefresh(fn: () => Promise<boolean>): Promise<boolean> {
    const run = (async () => {
      let accepted = false;
      try {
        accepted = await fn();
      } catch (err) {
        this.setNotice(`Error: ${err}`, "error");
        accepted = false;
      }
      this.watcher?.refresh();
      return accepted;
    })();
    const tracked = run.then(() => {});
    this._pendingActions.add(tracked);
    tracked.finally(() => this._pendingActions.delete(tracked));
    return run;
  }

  /** Wait for all in-flight executeAndRefresh calls to complete. For use in tests. */
  async flushPendingActions(): Promise<void> {
    while (this._pendingActions.size > 0) {
      await Promise.allSettled(this._pendingActions);
    }
  }

  // --- Pane management (delegates to pane-manager.ts) ---

  jumpToMode(mode: PaneMode, forceRefresh = false) {
    if (this.remoteSelection?.kind === "remote-coordinator") return;
    jumpToMode(this, mode, forceRefresh);
    // Entering/leaving REPO mode changes whether the per-repo coordinator pane
    // is visible — pause/resume its poller to match.
    this.updatePaneVisibility();
  }

  /** Reload a tail-log mode's window (or skip via cache) — called from scroll/resize handlers. */
  loadTailLogIfNeeded(mode: TailLogMode) {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    void loadTailLog(this, agent, mode);
  }

  private cyclePaneMode(delta: number) {
    cyclePaneMode(this, delta);
    // cyclePaneMode skips REPO (only entered via repo-header selection), but
    // keep the visibility sync here for symmetry with jumpToMode in case the
    // active mode changed.
    this.updatePaneVisibility();
  }

  // --- Command palette ---

  private handleCommandPalette() {
    // `key` is the key the read-only guard checks: the command's own key, and
    // for a mode jump `p`, the pane cycling that reaches the same modes, so a
    // jump works wherever `p`/`n` do (QUESTIONS carries `q`, which a remote
    // agent row allows). A command without a key is refused on a remote row.
    type Command = { label: string; key?: string; action: () => void };
    const modeJump = (label: string, mode: PaneMode, forceRefresh = false): Command =>
      ({ label, key: "p", action: () => this.jumpToMode(mode, forceRefresh) });
    const commands: Command[] = [
      modeJump("AGENT LOG — show agent log", "AGENT LOG"),
      modeJump("WATCHDOG LOG — show watchdog log", "WATCHDOG LOG"),
      modeJump("PROXY LOG — show sandbox proxy log", "PROXY LOG"),
      modeJump("INITIAL PROMPT — show initial prompt", "INITIAL PROMPT"),
      modeJump("DENIALS — show tool denials", "DENIALS"),
      modeJump("TREE — show full agent tree", "TREE"),
      modeJump("ERRORS — show errors", "ERRORS"),
      modeJump("DIFF — run ib diff", "DIFF", true),
      modeJump("STATUS — run ib status", "STATUS", true),
      { label: "QUESTIONS — show pending questions", key: "q", action: () => this.jumpToMode("QUESTIONS") },
      { label: "send message — s", key: "s", action: () => agentActions.handleSend(this) },
      { label: "merge agent — m", key: "m", action: () => agentActions.handleMerge(this) },
      { label: "retire agent — x", key: "x", action: () => agentActions.handleRetire(this) },
      { label: "force kill agent — !", key: "!", action: () => agentActions.handleNuke(this) },
      { label: "resume agent — R", key: "R", action: () => agentActions.handleResume(this) },
      { label: "pause agent — P", key: "P", action: () => agentActions.handlePause(this) },
      { label: "reassign manager — r", key: "r", action: () => agentActions.handleReassign(this) },
      { label: "nickname agent — N", key: "N", action: () => agentActions.handleRename(this) },
      { label: "new agent — a", key: "a", action: () => agentActions.handleNewAgent(this) },
      { label: "clone repo here (peer-only repo) — c", key: "c", action: () => void agentActions.handleCloneHere(this) },
      { label: "open worktree — w", key: "w", action: () => agentActions.handleOpenWorktree(this) },
      { label: "open diff in tool — o", key: "o", action: () => agentActions.handleOpenDiffTool(this) },
      { label: "open diff vs manager in tool — O", key: "O", action: () => agentActions.handleOpenDiffToolVsManager(this) },
      { label: "open in Ghostty (repo/worktree) — G", key: "G", action: () => agentActions.handleOpenGhostty(this) },
      { label: "open in Ghostty (Claude tmux) — C", key: "C", action: () => agentActions.handleOpenGhosttyTmux(this) },
      { label: "debug snapshot — S", key: "S", action: () => agentActions.handleSnapshot(this) },
      { label: "fuzzy jump to agent/repo/coordinator — @", key: "@", action: () => agentActions.handleFuzzyAgent(this) },
      { label: "add repo — A", key: "A", action: () => agentActions.handleAddRepo(this) },
      { label: "remove repo — D", key: "D", action: () => this.executeAndRefresh(() => agentActions.handleRemoveRepoSafe(this)) },
      { label: "help — ?", key: "?", action: () => agentActions.handleHelp(this) },
      { label: "setup (Hooks, Config, Peers, Scheduled) — h", key: "h", action: () => agentActions.handleSetup(this) },
      { label: "setup: Peers tab — I", key: "I", action: () => agentActions.handleSetup(this, PEERS_TAB) },
      { label: "scroll up — ;", key: ";", action: () => this.scrollOutput(true) },
      { label: "scroll down — l", key: "l", action: () => this.scrollOutput(false) },
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
        const command = commands[originalIndex]!;
        // The palette is a second way to press a key: the same read-only guard.
        if (this.refuseOnRemoteRow(command.key ?? "")) return;
        command.action();
        this.tui?.requestRender();
      },
    });
  }

  // --- Data update + agent sync ---

  private hasLoggedFirstOnUpdate = false;

  onUpdate(agents: Agent[], flatList: FlatEntry[], questions: PendingQuestion[], orphanedTmuxSessions: string[] = []) {
    if (!this.hasLoggedFirstOnUpdate) {
      this.hasLoggedFirstOnUpdate = true;
      logToWatchLog(
        `[startup] first onUpdate received: ${flatList.length} rows, ${agents.length} agents, ` +
        `${questions.length} questions, ${orphanedTmuxSessions.length} orphans`,
      );
    }
    this.agentTree.setFlatList(flatList);
    this.noteSystemCoordinatorState(
      flatList.find((e): e is Extract<FlatEntry, { kind: "system-coordinator" }> => e.kind === "system-coordinator")?.state,
    );
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
    this.rightPane.allAgents = flatList;
    this.rightPane.favoriteAgentIds = this.agentTree.favoriteAgentIds;
    this.rightPane.orphanedTmuxSessions = orphanedTmuxSessions;
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

    // The agy usage poll runs only while a live agy agent exists. startPolling()
    // fires its first usage poll before the watcher's first update, so on a
    // change re-poll now instead of on the next 4-minute tick (and clear the
    // gemini status as soon as the last agy agent goes away).
    const hasLiveAgyAgent = agents.some(isLiveAgyAgent);
    if (hasLiveAgyAgent !== this.hasLiveAgyAgent) {
      this.hasLiveAgyAgent = hasLiveAgyAgent;
      if (this.usageTimer) this.refreshGeminiUsage();
    }

    // Wire health reports to agent tree
    if (this.watcher) {
      this.agentTree.healthReports = this.watcher.healthReports;
    }

    // The red name: the full ids of the agents with a pending question. A
    // question names its agent by repo and id; the same id in another repo is
    // another agent.
    const askers = new Set(questions.map((q) => `${q.repoPath}\0${q.agent}`));
    const qKeys = new Set<string>();
    for (const agent of agents) {
      if (askers.has(`${agent.repoPath}\0${agent.id}`)) qKeys.add(this.agentTree.agentKey(agent));
    }
    this.localQuestions = questions;
    this.localQuestionKeys = qKeys;
    // Peer questions follow the local ones (SPEC §20.5).
    this.syncQuestions();

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
        this.agentTree.selectAgent(newest.agent);
      }
    }

    // One-time re-pin migration: bring every existing agent + coordinator tmux
    // window up to PINNED_TMUX_WIDTH. New spawns/resumes already start pinned via
    // tmuxWidthForAgent, but agents/coordinators that were running before the pin
    // (or spawned by an older binary) may still sit at an old narrow width —
    // resize them once so their reflow matches the pinned world. Runs on the
    // FIRST onUpdate regardless of whether any agents exist: an upgrade with a
    // running coordinator but ZERO agents must still re-pin the coordinator
    // windows. Idempotent: resizing an already-pinned (or dead) window is a
    // caught+ignored no-op.
    if (this.pendingTmuxResize) {
      this.pendingTmuxResize = false;
      for (const entry of flatList) {
        if (entry.kind === "agent" && entry.agent.meta.tmux_session) {
          resizeTmuxWindow(entry.agent.meta.tmux_session, PINNED_TMUX_WIDTH);
        }
      }
      // flatList filters out coordinators — re-pin per-repo coordinators from the
      // full agent list, plus the system coordinator's fixed session. These run
      // even when flatList is empty (no agents yet).
      for (const a of this.watcher?.lastAgents ?? []) {
        if (a.meta.agentType === REPO_COORDINATOR_TYPE && a.meta.tmux_session) {
          resizeTmuxWindow(a.meta.tmux_session, PINNED_TMUX_WIDTH);
        }
      }
      resizeTmuxWindow(IB_COORDINATOR_SESSION, PINNED_TMUX_WIDTH);
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
    // changed" chokepoint) so every entry point — j/k, 1/2/3, @-fuzzy, g-go-
    // to-question — re-mirrors automatically.
    this.mirrorSelectionToVisibleTree();
    // §17.3: effective-selection resolver. Phase 2 of the three-axis model
    // (SPEC §17.1): the EFFECTIVE selection is sourced from whichever tree
    // owns the GLOBAL selection (`activeSelectionSource === "teams"` → Teams
    // tree, otherwise the Agents tree). This is INDEPENDENT of `sidebarMode`
    // (which tree is currently visible). Switching tabs (`1`/`2`/`3`) flips visibility but
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
    const selection = teamsActive ? null : this.agentTree.selection;
    const selected = selection?.kind === "agent" ? selection.agent : teamMemberAgent;
    const isCoordinator = selection?.kind === "system-coordinator";
    const repo = selection?.kind === "repo-header" ? selection : null;
    const selectedRepoHeader = repo?.repoName ?? null;
    const selectedRepoPath = repo?.repoPath ?? null;
    // A remote row (SPEC §20.5). It is none of the above: `selected`,
    // `isCoordinator` and the repo header are all empty for it, so every local
    // path below (tmux pollers, git probe, right-pane loaders, the per-repo
    // coordinator) sees no selection. Only the info panel, render() and the
    // remote pane and prompt readers (syncRemotePane) use it.
    const remote = this.remoteSelection;
    const peerCoordinator = remote?.kind === "remote-coordinator";
    const leftPeerCoordinator = !peerCoordinator && this.infoPanel.remote?.kind === "remote-coordinator";
    const remoteDraft = remote?.kind === "remote-agent" ? remoteAgentKey(remote)
      : peerCoordinator ? remote.peerId + "/@system" : null;
    const enteredFromTree = this.rightPane.mode === "TREE" && (peerCoordinator || (remoteDraft !== null && remoteDraft !== this.currentAgentKey));
    if (enteredFromTree || (peerCoordinator && this.modeIndex !== DEFAULT_MODE_INDEX)) {
      jumpToMode(this, PANE_MODES[DEFAULT_MODE_INDEX]!);
    }

    // Update focus cycling for coordinator mode
    this.focusManager.coordinatorMode = isCoordinator;

    // When entering coordinator mode (transition, not every tick), reset view and focus
    const wasCoordinator = this.currentAgentKey === "__coordinator__";
    const visibleTree = this.sidebarMode === "teams" ? "teams-tree" : "agent-tree";
    if (leftPeerCoordinator || enteredFromTree || (!isCoordinator && this.focusManager.current() === "coordinator")) {
      this.focusManager.setFocus(visibleTree);
    }
    if (isCoordinator && !wasCoordinator) {
      this.coordinatorViewMode = "TMUX";
      const focus = this.focusManager.current();
      if (focus !== visibleTree && focus !== "info" && focus !== "coordinator") {
        this.focusManager.setFocus(visibleTree);
      }
      // No resize on coordinator selection: the ib-coordinator tmux window is
      // pinned to PINNED_TMUX_WIDTH and never follows mainWidth. The startup
      // re-pin migration corrects any pre-pin drift once; there is no display
      // width for it to chase, so selection no longer repaints its TUI.
    }

    this.rightPane.agent = selected;
    this.rightPane.remoteAgent = remote?.kind === "remote-agent" ? remote : null;
    this.rightPane.selectedRepo = repo;
    this.tmuxPane.agent = selected;
    this.statusBar.repoHeaderSelected = !selected && !isCoordinator && selectedRepoHeader !== null;
    this.statusBar.remoteSelected = remote !== null;
    this.statusBar.remoteAgentSelected = remote?.kind === "remote-agent" && remote.remote.agentType !== REPO_COORDINATOR_TYPE;
    this.statusBar.remoteRepoSelected = remote?.kind === "remote-repo-header";

    // Wire info panel
    this.infoPanel.agent = selected;
    this.infoPanel.remote = remote;
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
        a => a.repoPath === repoPathForCoordinator && a.meta.agentType === REPO_COORDINATOR_TYPE
      );
      this.rightPane.repoCoordinatorAgent = coordAgent ?? null;
      this.infoPanel.repoCoordinatorAgent = coordAgent ?? null;
      const tmuxSession = coordAgent?.meta.tmux_session ?? null;
      if (tmuxSession !== this.repoCoordinatorSession) {
        this.repoCoordinatorSession = tmuxSession;
        this.rightPane.resetRepoCoordinator();
        this.repoCoordinatorPoller.setAgent(tmuxSession);
        // No resize: the per-repo coordinator's tmux window is pinned to
        // PINNED_TMUX_WIDTH like every other TUI session. REPO mode reflows its
        // captured logical lines to mainWidth at display time via WordWrapCache,
        // so selecting a repo header never repaints the coordinator TUI at a new
        // width.
      }
    } else {
      // Not a repo header — clear coordinator state
      this.rightPane.repoCoordinatorAgent = null;
      this.infoPanel.repoCoordinatorAgent = null;
      if (this.repoCoordinatorSession) {
        this.repoCoordinatorSession = null;
        this.rightPane.resetRepoCoordinator();
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
    } else if ((selected || isCoordinator || remote) && currentMode === "REPO") {
      // Agent, coordinator or remote row selected while in REPO mode — restore previous mode
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
    // Switch repo coordinator input field agent. Its draft is keyed by full id
    // (SPEC §17.1): a per-repo coordinator's id comes from its folder's name
    // (getCoordinatorAgentId), so two repos whose folder names give one id
    // have coordinators with one id.
    const repoCoordinator = this.rightPane.repoCoordinatorAgent;
    this.repoCoordinatorInputField.switchAgent(
      repoCoordinator ? this.agentTree.agentKey(repoCoordinator) : null
    );

    // Determine the effective key for change detection: the agent's fully
    // qualified id, so the same bare id in another repo is a change too.
    const newKey = remoteDraft ?? (isCoordinator ? "__coordinator__" : (selected ? this.agentTree.agentKey(selected) : null));
    if (newKey !== this.currentAgentKey) {
      this.currentAgentKey = newKey;
      this.setTerminalTitle(isCoordinator ? "ib: coordinator" : (selected ? `ib: ${selected.id}` : "ib"));
      this.tmuxPane.resetForAgent();
      // Drafts are kept per agent, by full id.
      this.inputField.switchAgent(newKey);
      this.coordinatorInputField.switchAgent(isCoordinator ? "__coordinator__" : null);
      this.rightPane.resetTailLogs();
      this.rightPane.promptContent = null;
      this.rightPane.denialsContent = null;
      this.rightPane.loadedDenialsLog = null;
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

      // "Git Status" stoplight (§11.4): drop the previous agent's answer so the
      // light goes grey (unknown) rather than showing a stale colour for the
      // new selection, then probe the new agent's worktree right away instead
      // of waiting up to one gitStatusTimer tick.
      this.infoPanel.gitCleanliness = null;
      this.infoPanel.gitHead = null;
      this.infoPanel.gitCommitCount = null;
      void this.refreshGitStatus();

      // Client detection: clear previous timer, check new agent
      if (this.clientCheckTimer) {
        clearInterval(this.clientCheckTimer);
        this.clientCheckTimer = null;
      }
      if (selected?.meta.tmux_session) {
        this.checkClientAttached(selected);
        // No resize on selection: the agent's tmux window stays pinned to
        // PINNED_TMUX_WIDTH regardless of which agent is selected or how wide the
        // middle pane is. The center pane reflows the captured logical lines to
        // its display width via WordWrapCache, so selection never repaints the
        // TUI at a new width.
      }
    }

    // On a remote row the right pane is a placeholder, so j/k must move the
    // tree, never a hidden QUESTIONS cursor. A remote agent's QUESTIONS are shown.
    if (remote && !this.remoteQuestionsVisible) this.setQuestionsFocused(false);

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
    this.updatePaneVisibility();
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
    opts: StagedTeamSendOptions | undefined,
  ): Promise<TeamSendResult> => {
    // Forward the send-time staging + retry opts (stageAttachments /
    // skipRecipientIds / attachmentBaseDir) through to the team fan-out.
    return ibTeamSend(teamName, members, message, opts, this.repos);
  };

  /**
   * §17.1 Phase 2: ctx setters bound to the dashboard. Arrow properties so
   * `this` is preserved when invoked through the ctx. They write to the
   * dashboard's `activeSelectionSource` / `sidebarMode` fields and are used
   * by the `@`-fuzzy jump and `g`-go-to-question-agent handlers (which need
   * to force the Agents tree into the active-selection role + visible — the
   * Favorites tab already shows the Agents tree, so it is kept). The
   * `1`/`2`/`3` keys also write `sidebarMode` through `setSidebarMode`.
   */
  setActiveSelectionSource = (source: SelectionSource): void => {
    this.activeSelectionSource = source;
  };

  setSidebarMode = (mode: SidebarMode): void => {
    this.sidebarMode = mode;
    // §17.1 Phase 3: keep the FocusManager's sidebarMode in sync so Tab
    // cycling picks the correct order. Every writer goes through this setter:
    // the `1`/`2`/`3` keys, the `@`-fuzzy jump and `g`-go-to-question-agent.
    this.focusManager.sidebarMode = mode;
    // The Favorites tab is a view of the Agents tree. Flip the filter here
    // (not at render time) so j/k right after the key press already walk the
    // filtered list; setFavoritesOnly re-resolves the selection.
    this.agentTree.setFavoritesOnly(mode === "favorites");
  };

  /**
   * §17.1 Phase 2 mirror — visual continuity across a sidebar toggle.
   *
   * When the user switches `sidebarMode` (`1`/`2`/`3`), the global selection
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
   * Called from BOTH the `1`/`2`/`3` sidebar-tab handlers AND the j/k/J/K
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
        if (!this.teamsTree.selectMemberByKey(this.agentTree.agentKey(sel.agent))) {
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
      if (!this.agentTree.selectAgent(sel.agent)) {
        this.agentTree.deselect();
      }
    } else {
      // Team anchor or null — no Agents counterpart.
      this.agentTree.deselect();
    }
  }

  /**
   * The team-member row `x` opens the team-member picker for (§17.3): the
   * member row selected in the Teams tree, while the Teams tab is showing.
   *
   * When the Teams tree owns the selection, that row IS the selection. When
   * the Agents tree owns it, the row is only the mirror's highlight
   * (`selectMemberByKey`, by fully qualified id), which can be stale: the
   * Teams list is rebuilt asynchronously and a failed mirror leaves the old
   * row. So a mirrored row counts only when it is the very agent the Agents
   * tree has selected (same id AND repo). Otherwise this returns null and `x`
   * acts on the Agents-tree selection, as it did before the picker existed.
   */
  private teamMemberRowForX(): { teamName: string; agent: Agent } | null {
    if (this.sidebarMode !== "teams") return null;
    const row = this.teamsTree.selectedMember;
    if (!row || this.activeSelectionSource === "teams") return row;
    const active = this.agentTree.selectedAgent;
    return active && active.id === row.agent.id && active.repoPath === row.agent.repoPath ? row : null;
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
      // Render only when the Teams tree can be on screen: the Teams tab is
      // visible, or the Teams tree owns the selection (the main area reads its
      // selection). Otherwise nothing visible changed — this runs after every
      // watcher update — and switching to the Teams tab renders the new list.
      if (this.sidebarMode === "teams" || this.activeSelectionSource === "teams") {
        this.tui?.requestRender();
      }
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
      // This runs after every watcher update while a team is selected; skip
      // the render when the info panel would show the same values.
      const prev = this.infoPanel.selectedTeam;
      if (prev && prev.name === teamName && prev.createdEpoch === team.created_epoch &&
          prev.createdBy === team.created_by && prev.memberCount === liveCount) return;
      this.infoPanel.selectedTeam = {
        name: teamName,
        createdEpoch: team.created_epoch,
        createdBy: team.created_by,
        memberCount: liveCount,
      };
    } else {
      if (this.infoPanel.selectedTeam === null) return;
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

  /**
   * Refresh the info panel's "Git Status" stoplight for the SELECTED agent
   * (§11.4). Driven off `gitStatusTimer` and a one-shot on selection change —
   * NOT off render(). No-op when no agent is selected or a probe is already in
   * flight. Reads the effective selection from `infoPanel.agent` (set by
   * `syncSelectedAgent`, so a team-member selection works the same as an
   * Agents-tree one) and snapshots the id so a selection change during the
   * await discards the result instead of colouring the wrong agent's light.
   */
  private async refreshGitStatus(): Promise<void> {
    const agent = this.infoPanel.agent;
    if (!agent || this.gitStatusInFlight) return;
    this.gitStatusInFlight = true;
    let cleanliness: Awaited<ReturnType<typeof checkWorktreeCleanliness>>;
    let head: string | null;
    let commitCount: number | null;
    try {
      const worktreePath = agentWorktreePath(agent);
      // Same parent rule as `ib status` / `ib diff`.
      const parentBranch = agent.meta.manager ? `agent/${agent.meta.manager}` : "main";
      [cleanliness, head, commitCount] = await Promise.all([
        checkWorktreeCleanliness(worktreePath),
        getWorktreeHead(worktreePath),
        getCommitsSinceParent(worktreePath, parentBranch),
      ]);
    } finally {
      this.gitStatusInFlight = false;
    }
    // The same id in another repo has another worktree, so this is per agent.
    if (this.infoPanel.agent?.id !== agent.id ||
        agentWorktreePath(this.infoPanel.agent) !== agentWorktreePath(agent)) return;
    if (this.infoPanel.gitCleanliness === cleanliness && this.infoPanel.gitHead === head &&
        this.infoPanel.gitCommitCount === commitCount) return;
    this.infoPanel.gitCleanliness = cleanliness;
    this.infoPanel.gitHead = head;
    this.infoPanel.gitCommitCount = commitCount;
    this.tui?.requestRender();
  }

  /** Check if the selected agent's tmux session has an attached client, start/stop polling accordingly */
  private checkClientAttached(agent: Agent) {
    // By fully qualified id: the same bare id in another repo is another agent.
    const agentKey = this.agentTree.agentKey(agent);
    const session = agent.meta.tmux_session;

    const doCheck = async () => {
      const attached = await hasAttachedClient(session);

      // Discard result if the agent changed while we were awaiting
      const current = this.agentTree.selectedAgent;
      if (!current || this.agentTree.agentKey(current) !== agentKey) return;

      const wasAttached = this._clientAttached.get(agentKey) ?? false;
      this._clientAttached.set(agentKey, attached);

      if (attached && !this.clientCheckTimer) {
        // Start polling every 3s to detect disconnect
        this.clientCheckTimer = setInterval(() => {
          const sel = this.agentTree.selectedAgent;
          if (!sel || this.agentTree.agentKey(sel) !== agentKey) {
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
        // When an external client (e.g. Ghostty) DETACHES, re-pin the window to
        // PINNED_TMUX_WIDTH. openInGhostty attaches with `tmux set-option
        // window-size latest` (src/ghostty.ts), so tmux re-fit the window to the
        // client's terminal size while attached; on detach we must restore the
        // pin, otherwise the window would stay at the client's width and the
        // dashboard's reflow (which assumes a wide pinned window) would see a
        // too-narrow capture.
        if (wasAttached && !attached) {
          resizeTmuxWindow(session, PINNED_TMUX_WIDTH);
        }
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
    const result = await setRepoDefaultAgentType(repoPath, newType).catch((err: Error) => ({ ok: false, message: err.message }));
    if (!result.ok) {
      this.setNotice(result.message, "error");
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
    const result = await setRepoNotes(repoPath, notes).catch((err: Error) => ({ ok: false, message: err.message }));
    if (!result.ok) {
      this.setNotice(result.message, "error");
      return;
    }
    if (this.notesEditorRepoPath === repoPath) this.notesEditorOriginal = notes;
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
      this.setNotice("No agent types available", "error");
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

    const incoming = this.peerService?.view().incoming ?? [];
    if (incoming.length && matchesKey(data, Key.ctrl("t"))) {
      const index = incoming.findIndex(row => row.id === this.selectedReceipt);
      this.selectedReceipt = incoming[(index + 1) % incoming.length]!.id;
      this.invalidate();
      this.tui?.requestRender();
      return;
    }
    if (incoming.some(row => row.id === this.selectedReceipt) && matchesKey(data, Key.escape)) {
      this.peerService?.cancelReceipt?.(this.selectedReceipt!);
      this.selectedReceipt = undefined;
      return;
    }
    this.selectedReceipt = undefined;
    if (matchesKey(data, Key.escape)) {
      const send = this.escapeSend();
      if (send) {
        // A written request cannot be cancelled: aborting it would only leave its outcome unknown.
        if (send.sent) this.setNotice(`Cannot cancel: waiting for ${send.peerName} to confirm`, "info");
        else send.controller.abort(new Error("Send cancelled"));
        return;
      }
    }

    // When active-agent panel is focused, use three-level sub-focus: pane → input → send.
    // In 'pane' sub-focus, dashboard shortcuts work normally. In 'input', the input field
    // captures all input. In 'send', Enter submits and other keys fall through. (SPEC §13.4)
    const editingRemote = this.rightPane.mode !== "TREE" && !!remoteMessageTarget(this.remoteSelection);
    if (this.focusManager.current() === "active-agent" && (editingRemote || (!this.remoteSelection && this.agentTree.selectedAgent))) {
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
          if (this.inputField.getText().trim()) {
            this.focusManager.setSubFocus("pane");
            // Acceptance-gated: submit() keeps the draft on screen until the send
            // is accepted (so a staged-attachment failure preserves it for
            // correction) and guards a duplicate submit while one is in flight.
            // The draft is cleared only on acceptance — never before the send.
            this.inputField.submit();
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

    // Editor keystrokes above are consumed as text. Every action, including the
    // fallthrough from Send sub-focus, must still pass the remote-row guard.
    if (this.refuseOnRemoteRow(data)) return;

    // The coordinator editor belongs only to the effective local coordinator selection.
    if (this.focusManager.current() === "coordinator" && this.activeSelectionSource === "agents"
        && this.agentTree.isSystemCoordinatorSelected && this.coordinatorPane.hasPolled) {
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

      // Send sub-focus: Enter submits. The GLOBAL @system coordinator is
      // deliberately excluded from send-time attachment staging (Adam's rule:
      // auto-copy only for human submissions to repository agents), so this path
      // keeps the legacy clear-then-submit flow rather than the acceptance-gated
      // submit() used by the agent and repo-coordinator chat boxes above.
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
          if (this.repoCoordinatorInputField.getText().trim()) {
            this.focusManager.setSubFocus("pane");
            // Acceptance-gated like the agent chat box: the draft survives a
            // failed staged send and clears only once the send is accepted.
            this.repoCoordinatorInputField.submit();
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

    // Info panel: Default Agent Type cycle/clear when the row is the focused
    // sub-field. selectedRepoHeader != null implies neither agent nor
    // system-coordinator is selected (discriminated union in agent-tree).
    if (
      this.focusManager.current() === "info"
      && this.agentTree.selectedRepoHeader != null
    ) {
      // Notes sub-field: Escape reverts to the last saved notes,
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

    // §17.1 (Phase 3 three-axis model): '1' / '2' / '3' switch the sidebar
    // tab (`sidebarMode`: Agents / Teams / Favorites). They do NOT change the
    // GLOBAL selection (`activeSelectionSource`, set by j/k navigation). Focus
    // moves only when the current focus target would not exist in the new
    // cycle: entering teams moves `agent-tree` and `repo-coordinator`
    // (agents-only) to `teams-tree`; entering agents or favorites (both use
    // the agents cycle) moves `teams-tree` to `agent-tree`. Other targets
    // (`info` / `active-agent` / `right-pane`) are present in BOTH orders, so
    // focus stays where it is. We also mirror the active selection into the
    // newly-visible tree (visual only — `activeSelectionSource` is unchanged)
    // and re-run selection sync so the info / main / right panes update
    // immediately instead of waiting a tmux-poll tick. Gated by the
    // dialog/input-field returns above AND placed after the info-panel notes
    // editor, so digits typed into repo notes reach the editor first.
    const tabMode: SidebarMode | null =
      data === "1" ? "agents" : data === "2" ? "teams" : data === "3" ? "favorites" : null;
    if (tabMode !== null) {
      this.setSidebarMode(tabMode);
      const focus = this.focusManager.current();
      if (focus === "agent-tree" || focus === "teams-tree" || (focus === "repo-coordinator" && tabMode === "teams")) {
        this.focusManager.setFocus(this.visibleNavigationTree);
      }
      // syncSelectedAgent() runs the inactive-tree mirror at its top.
      this.syncSelectedAgent();
      this.tui?.requestRender();
      return;
    }

    // Navigation. §17.1 (Phase 2 three-axis model): j/k and shift+j/k navigate
    // whichever tree is currently VISIBLE in the sidebar (`sidebarMode`; the
    // Favorites tab shows the Agents tree). After any navigation, the
    // navigated tree becomes the active selection source — the user just
    // declared what they are selecting by moving the cursor in this tree.
    // QUESTIONS-mode j/k retains its agent-tree-only special case below and
    // does NOT touch activeSelectionSource (it's a right-pane question
    // selector, not a sidebar-tree navigation).
    const navigatesTeams = this.visibleNavigationTree === "teams-tree";
    const navigatedSource: SelectionSource = navigatesTeams ? "teams" : "agents";
    if (data === "J") {
      if (navigatesTeams) {
        this.teamsTree.navigateAnchor(1);
      } else {
        this.agentTree.moveToRepo(1);
      }
      this.activeSelectionSource = navigatedSource;
      this.syncSelectedAgent();
      this.tui?.requestRender();
    } else if (data === "K") {
      if (navigatesTeams) {
        this.teamsTree.navigateAnchor(-1);
      } else {
        this.agentTree.moveToRepo(-1);
      }
      this.activeSelectionSource = navigatedSource;
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
        this.activeSelectionSource = navigatedSource;
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
        this.activeSelectionSource = navigatedSource;
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
        this.updatePaneVisibility();
      } else {
        this.cyclePaneMode(1);
      }
      this.tui?.requestRender();
    } else if (data === "n" || matchesKey(data, Key.right)) {
      if (this.activeSelectionSource === "teams" && this.channelPane.teamName !== null) {
        // no-op in teams view (see "p" branch above)
      } else if (this.agentTree.isSystemCoordinatorSelected) {
        this.coordinatorViewMode = this.coordinatorViewMode === "TMUX" ? "DASHBOARD" : "TMUX";
        this.updatePaneVisibility();
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
      // Only a list on screen: a remote-only header in QUESTIONS hides it (SPEC §20.5).
      if (this.rightPane.mode === "QUESTIONS" && (!this.remoteSelection || this.remoteQuestionsVisible)) {
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
    // Clone here (on a remote-only repo header), else clear errors
    else if (data === "c") {
      if (this.remoteSelection?.kind === "remote-repo-header") { void agentActions.handleCloneHere(this); }
      else if (this.rightPane.mode === "ERRORS") { this.clearErrors(); }
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
    else if (data === ";") { this.scrollOutput(true); }
    else if (data === "l") { this.scrollOutput(false); }
    // Agent/repo actions — context-sensitive on whether a repo header is selected
    else if (data === "x") {
      // §17.3 manage-team: when a team ANCHOR is the GLOBAL selection
      // (active source = teams), `x` opens the manage-team picker (disband or
      // remove a single member, each gated by a second confirm dialog).
      // Phase 2 (§17.1) keys this off `activeSelectionSource` — the same
      // source of truth as syncSelectedAgent — so the effective selection
      // stays consistent.
      //
      // §17.3 team-member picker: when the Teams tab is SHOWING and a team
      // MEMBER row is selected in it, `x` opens a picker (remove the agent
      // from that row's team, or retire it) instead of the retire confirm.
      // This one is keyed off the visible tab, not the active source: it
      // exists so that `x` on a row the user sees under a team never goes
      // straight to retire, and the row is highlighted the same way whether
      // j/k selected it or the mirror did (§17.1). With the Agents or
      // Favorites tab showing, `x` on an agent is the retire confirm as ever.
      const teamsActive = this.activeSelectionSource === "teams";
      const teamSel = teamsActive ? this.teamsTree.selection : null;
      const memberRow = this.teamMemberRowForX();
      if (this.remoteSelection?.kind === "remote-agent") {
        agentActions.handleRetire(this);
      } else if (teamSel?.kind === "team") {
        agentActions.handleManageTeam(this, teamSel.teamName);
      } else if (memberRow) {
        agentActions.handleManageTeamMember(this, memberRow.teamName, memberRow.agent);
      } else if (this.agentTree.isSystemCoordinatorSelected) {
        agentActions.handleKillSystemCoordinator(this);
      } else if (!this.agentTree.selectedAgent && this.agentTree.selectedRepoHeader) {
        this.executeAndRefresh(() => agentActions.handleRemoveRepoSafe(this));
      } else {
        agentActions.handleRetire(this);
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
    // Team actions: T = create a new team, t = add the selected agent to a
    // team or remove it from one (or manage roster when a team anchor in the
    // Teams tree is the active selection). Phase 2 (§17.1): keyed off
    // `activeSelectionSource` — the same source-of-truth the
    // `x`-on-team-anchor dispatch uses — so a visible-but-not-active Teams
    // panel doesn't mis-fire the roster path. The Teams panel must own the
    // global selection for `t` to route to the manage-roster dialog. A team
    // MEMBER row that owns the selection hands its own agent to the picker,
    // so the picker does not depend on the Agents tree having a row for it.
    else if (data === "T") { agentActions.handleCreateTeam(this); }
    else if (data === "t") {
      const teamSel = this.activeSelectionSource === "teams" ? this.teamsTree.selection : null;
      if (teamSel?.kind === "team") {
        agentActions.handleManageRoster(this, teamSel.teamName);
      } else {
        agentActions.handleAddAgentToTeam(this, teamSel?.kind === "agent" ? teamSel.agent : undefined);
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
    // Open diff vs manager's branch in external tool
    else if (data === "O") { agentActions.handleOpenDiffToolVsManager(this); }
    // Help dialog
    else if (data === "?") { agentActions.handleHelp(this); }
    // Peers tab: this install's id, paired peers, pairing
    else if (data === "I") { agentActions.handleSetup(this, PEERS_TAB); }
    // Setup dialog
    else if (data === "h") { agentActions.handleSetup(this); }
    // Re-check repo health
    else if (data === "H") {
      this.setNotice("Re-checking repo health...", "info");
      this.watcher?.recheckHealth();
    }
    // V — cycle repo filter: all → non-empty → running-only → all
    else if (data === "V") {
      const next = nextRepoFilter(this.agentTree.repoFilter);
      this.agentTree.setRepoFilter(next);
      const notice =
        next === "all" ? "Showing all repos"
        : next === "non-empty" ? "Hiding empty repos"
        : "Hiding stopped agents";
      this.setNotice(notice, "info");
      this.tui?.requestRender();
    }
    // . — on an agent, toggle it as a favorite (★, Favorites tab); on a repo
    // header, toggle its pin (pinned repos stay visible under V). Acts on the
    // EFFECTIVE selection (`activeSelectionSource`), so a team member selected
    // in the Teams tree is favorited too.
    else if (data === ".") {
      const selection = this.activeSelectionSource === "teams"
        ? this.teamsTree.selection
        : this.agentTree.selection;
      const sel = selection?.kind === "remote" ? selection.entry : selection;
      if (sel?.kind === "agent" || sel?.kind === "remote-agent") {
        const key = sel.kind === "agent" ? this.agentTree.agentKey(sel.agent) : peerEntryKey(sel);
        const name = sel.kind === "agent" ? agentDisplayName(sel.agent) : remoteDisplayName(sel.remote);
        const nowFavorite = this.agentTree.toggleFavorite(key);
        this.setNotice(nowFavorite ? `Favorited ${name}` : `Unfavorited ${name}`, "info");
        this.favoritesChanged();
      } else if (sel?.kind === "repo-header" || sel?.kind === "remote-repo-header") {
        const nowPinned = sel.kind === "repo-header"
          ? this.agentTree.togglePinnedRepo(sel.repoPath)
          : this.agentTree.togglePinnedRemoteRepo(sel.repoRegistryName);
        this.setNotice(nowPinned ? `Pinned ${sel.repoName}` : `Unpinned ${sel.repoName}`, "info");
        // Persist the pin change so it survives an `ib watch` restart.
        this.persistLayout();
        this.tui?.requestRender();
      } else {
        this.setNotice("Select an agent or repo header", "info");
      }
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
        // No tmux resize on sidebar-width change: both the system coordinator and
        // per-repo coordinator windows stay pinned to PINNED_TMUX_WIDTH. Their
        // panes reflow to the new mainWidth at display time via WordWrapCache, so
        // resizing the sidebar never repaints a coordinator TUI at a new width.
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
      if (focus === "agent-tree" || focus === "teams-tree" || focus === "info") {
        // `}` grows the focused panel by one row taken from the other, `{`
        // gives one back. teams-tree shares the sidebar tree region (and
        // heightOffsets.tree) with agent-tree (§17.3).
        const treeDelta = focus === "info" ? -delta : delta;
        // Guards and the stored result use the clamped copy the render lays
        // out from, so a keypress always moves the rendered height, and a key
        // the guard stops leaves the stored offsets alone.
        const { base, offsets } = this.sidebar.clampedHeights(this.sidebarMode);
        // §7.7 guard: the donor (info when the tree grows, else the tree) must stay ≥ 1.
        const donorHeight = treeDelta > 0 ? base.infoHeight + offsets.info : base.treeHeight + offsets.tree;
        if (donorHeight > 1) {
          this.sidebar.heightOffsets = { ...offsets, tree: offsets.tree + treeDelta, info: offsets.info - treeDelta };
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


  private availableMainHeight(): number {
    return Math.max(5, (process.stdout.rows || 24) - 5);
  }

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
    // §17.1 Phase 2: a leftover system-coordinator selection in the (inactive)
    // Agents tree must NOT bleed into the team-active render path. When the
    // Teams tree owns the global selection the main area renders the team
    // channel, regardless of what the Agents tree's pointer happens to be on.
    // Mirrors the same gate `syncSelectedAgent` uses (`!teamsActive &&
    // agentTree.isSystemCoordinatorSelected`).
    const isCoordinatorView =
      this.activeSelectionSource === "agents" && this.agentTree.isSystemCoordinatorSelected;
    const isTreeMode = this.expandedAgentsTreeVisible;
    // A selected remote row (SPEC §20.5) draws its peer content in the
    // split layout, whatever the right-pane mode, except TREE: that mode draws
    // the tree itself in the main area (the sidebar hides its own), and it must
    // stay on screen while j/k move through the tree. A remote agent's
    // QUESTIONS use the normal full-width pane too.
    const remote = this.remoteSelection;
    const remoteView = remote !== null && !isTreeMode && !this.remoteQuestionsVisible;
    const remoteCoordinator = remoteView && remote.kind === "remote-coordinator" ? remote : null;
    const isFullWidth = remoteCoordinator !== null || (!remoteView && (isCoordinatorView || FULL_WIDTH_MODES.has(this.rightPane.mode)));

    // Header. Its alert shows the transient notice, then each peer transfer in
    // flight (SPEC §20.5), then each pending remote lifecycle command, so none
    // of them adds a row and shifts the layout. The transfer Esc acts on goes
    // first, so its hint survives a cut header.
    const cancellableSend = this.escapeSend();
    const incoming = this.peerService?.view().incoming ?? [];
    const start = this.remoteStart?.progress;
    const transfers = [
      ...[...this.pendingRemoteSends.values()].map((send) => {
        const esc = send === cancellableSend;
        return { esc, text: `sending to ${send.label}…${transferStatus(send)}${esc && !send.sent ? "  Esc: cancel" : ""}` };
      }),
      ...start ? [{ esc: false, text: `starting agent on ${start.peerName}…${transferStatus(start)}` }] : [],
      ...incoming.map((row) => {
        const esc = row.id === this.selectedReceipt;
        return { esc, text: `${esc ? "› " : ""}receiving ${row.label}  ${row.bytes} / ${row.total} bytes  ${esc ? "Esc: cancel" : "Ctrl-T: select"}` };
      }),
    ].sort((a, b) => Number(b.esc) - Number(a.esc)).map((transfer) => transfer.text);
    const noticeColor = this.lastSentNoticeKind === "error" ? RED : YELLOW;
    const alerts = [
      ...(this.lastSentNotice ? [`${noticeColor}${this.lastSentNotice}${RESET}`] : []),
      ...transfers.map((transfer) => `${YELLOW}${transfer}${RESET}`),
      ...[...this.pendingLifecycle.values()].map((pending) => `${YELLOW}${pending}${RESET}`),
    ];
    const subtitle = alerts.length > 0
      ? `${DIM}—${RESET} ${alerts.join(`${DIM}  ·  ${RESET}`)}`
      : `${DIM}— agent dashboard${RESET}`;
    const left = `${BOLD}ib${RESET} ${subtitle}`;
    const indicators: string[] = [];
    if (this.collectorStatus) {
      // Shared sandbox denial collector (src/sandbox-collector-light.ts). Grey
      // (off or idle) dims the whole indicator.
      const light = this.collectorStatus.light;
      indicators.push(light === "grey"
        ? `${DIM_GRAY}●${RESET} ${DIM}Collector${RESET}`
        : `${light === "green" ? GREEN : light === "yellow" ? YELLOW : RED}●${RESET} Collector`);
    }
    if (this.remoteControlStatus?.light) {
      // System coordinator Remote Control (src/remote-control-light.ts): green
      // when on, yellow when system-coordinator.md and the coordinator disagree
      // (launched the other way, or stopped) until it is (re)started, hidden
      // when both are off.
      indicators.push(`${this.remoteControlStatus.light === "green" ? GREEN : YELLOW}●${RESET} Remote Control`);
    }
    if (this.telegramStatus) {
      const tgColor =
        this.telegramStatus === "green" ? GREEN
        : this.telegramStatus === "yellow" ? YELLOW
        : RED;
      indicators.push(`${tgColor}●${RESET} Telegram`);
    }
    if (indicators.length > 0) {
      const right = indicators.join("  ");
      // A long alert ends in "…" before the indicators rather than cutting them off.
      const fitted = truncateToWidth(left, Math.max(0, width - visibleWidth(right) - 2), "…");
      const pad = Math.max(1, width - visibleWidth(fitted) - visibleWidth(right) - 1);
      lines.push(truncateToWidth(fitted + " ".repeat(pad) + right, width, ""));
    } else {
      lines.push(truncateToWidth(left, width, "…"));
    }

    // Compute available height for the main content area.
    // Chrome lines: header(1) + main title separator(1) +
    //               bottom separator(1) + status bar(2) = 5.
    const availableHeight = this.availableMainHeight();

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
    const mainTitleSep = isCoordinatorView || remoteCoordinator
      ? this.buildCoordinatorTitleSeparator(mainWidth, remoteCoordinator?.peerName)
      : teamSelectedForTitle
        ? this.buildTeamTitleSeparator(mainWidth, leftPaneW, this.channelPane.teamName!)
        : remoteView
          ? this.buildSplitTitleSeparator(
            mainWidth, leftPaneW,
            ` ${truncateToWidth(remoteTitle(remote), Math.max(1, leftPaneW - 8), "…")} `,
            ` ${this.rightPane.mode} `,
          )
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
    if (this.teamChannelVisible) {
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
    } else if (remoteView) {
      const acceptsText = remote.kind !== "remote-repo-header";
      const focused = this.focusManager.current() === "active-agent";
      this.inputField.active = acceptsText && focused && this.focusManager.subFocus !== "pane";
      this.inputField.setFocusState(this.focusManager.subFocus === "send" ? "send" : "text");
      if (remoteCoordinator) {
        // Full width, like the local coordinator's TMUX view: the capture with
        // its input box sliced off, this input field, then the CLI's status lines.
        // Clamped like the local view: the peer's status lines can be long (a `/` menu).
        const input = [...this.inputField.render(mainWidth), ...this.remotePane.statusLines(mainWidth)];
        const body = this.remotePane.render(mainWidth, Math.max(0, availableHeight - input.length));
        mainLines = [mainTitleSep, ...[...body, ...input].slice(0, availableHeight)];
      } else {
        // As on a local agent: the input field, then the CLI's status lines sliced off the capture.
        const input = acceptsText
          ? (width: number) => [...this.inputField.render(width), ...this.remotePane.statusLines(width)]
          : undefined;
        const prompt = remote.kind === "remote-agent" && this.rightPane.mode === "INITIAL PROMPT"
          ? (width: number, rows: number) => {
            this.rightPane.displayHeight = rows;
            return this.rightPane.render(width);
          }
          : undefined;
        mainLines = [mainTitleSep, ...renderRemotePanes(remote, this.remotePane, mainWidth, leftPaneW, availableHeight, input, prompt)];
      }
    } else if (isTreeMode) {
      // TREE mode: full-height tree in the main area. The sidebar hides its
      // tree in this mode (sidebar.hideTree), so this tall maxHeight stays set
      // until a later sidebar render sets the compact height. The maxHeight
      // setter re-runs the selection scroll then, so the sidebar shows the
      // selected row again.
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
    // Team-member rows show the ★ for favorites; the Agents tree owns the set.
    this.teamsTree.favoriteAgentIds = this.agentTree.favoriteAgentIds;
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
    // when the coordinator view is in the main area. Outside that view, it is
    // active only while the coordinator panel has focus past its pane sub-focus.
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

    // Text from files, logs and prompts can carry tabs. pi-tui's visibleWidth()
    // counts a tab as 3 columns, but the slicing that composites an overlay onto
    // a row counts it as 0, so a row with a tab under an overlay comes out wider
    // than the terminal and doRender throws. visibleWidth() measures a tab as
    // exactly 3 spaces, so expanding here, after layout, changes no width.
    // This and DialogOverlayComponent.render are the only roots pi-tui draws.
    return lines.map(expandTabs);
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
    return this.buildSplitTitleSeparator(mainWidth, leftPaneW, ` @${teamName} CHAT `, ` @${teamName} LOG `);
  }

  /**
   * A title separator over the split layout: `leftTitle` over the left pane and
   * `rightTitle` over the right, with the `┬` on the seam. The team view (chat
   * | log) and a remote row's placeholders (SPEC §20.5) use it.
   */
  private buildSplitTitleSeparator(mainWidth: number, leftPaneW: number, leftTitle: string, rightTitle: string): string {
    const leftPad = 3;
    const rightPad = 3;
    const leftDashColor = DIM_GRAY;
    const rightDashColor = DIM_GRAY;
    // Focus-aware highlight, mirroring buildMainTitleSeparator: the LEFT pane
    // is the "active-agent" focus target and the RIGHT pane the "right-pane"
    // target (in the team view, TEAMS_FOCUS_ORDER in focus.ts). The focused
    // tab gets the REVERSE highlight; the other stays plain BOLD.
    const currentFocus = this.focusManager.current();
    const leftFocused = currentFocus === "active-agent";
    const rightFocused = currentFocus === "right-pane";
    const leftTitleStyle = leftFocused ? `${REVERSE}${BOLD}` : BOLD;
    const rightTitleStyle = rightFocused ? `${REVERSE}${BOLD}` : BOLD;

    const splitAt = leftPaneW + 1;
    const leftHalfDashes = Math.max(1, splitAt - leftPad - visibleWidth(leftTitle));
    const rightHalfDashes = Math.max(1, mainWidth - splitAt - visibleWidth(rightTitle) - rightPad);
    const leftDashStr = "─".repeat(Math.max(0, leftHalfDashes - 1)) + "┬";
    const sep =
      `${leftDashColor}${"─".repeat(leftPad)}${RESET}${leftTitleStyle}${leftTitle}${RESET}` +
      `${leftDashColor}${leftDashStr}${RESET}` +
      `${rightTitleStyle}${rightTitle}${RESET}` +
      `${rightDashColor}${"─".repeat(rightHalfDashes)}${"─".repeat(rightPad)}${RESET}`;
    return truncateToWidth(sep, mainWidth, "");
  }

  /** Build title separator for system coordinator full-width view */
  private buildCoordinatorTitleSeparator(mainWidth: number, peer?: string): string {
    const leftTitle = peer === undefined ? " System Coordinator " : ` ${peer}/@system `;
    const rightTitle = peer !== undefined || this.coordinatorViewMode === "TMUX" ? " TMUX " : " DASHBOARD ";
    const leftPad = 3;
    const rightPad = 3;
    const currentFocus = this.focusManager.current();
    const coordFocused = currentFocus === (peer === undefined ? "coordinator" : "active-agent");
    const leftTitleStyle = coordFocused ? `${REVERSE}${BOLD}` : BOLD;
    const fillCount = Math.max(1, mainWidth - leftPad - visibleWidth(leftTitle) - visibleWidth(rightTitle) - rightPad);
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
  const bootStart = Date.now();
  logToWatchLog("[startup] launchDashboard initiated");
  // `ib watch` only (SPEC §8.14): a JS crash writes a [crash] entry to
  // watch.log before exiting, and every JS-level exit writes an [exit] line.
  const crashHandlers = installWatchCrashHandlers();
  try {
    await startDashboard(crashHandlers, bootStart);
  } catch (err) {
    // A startup failure (anything startDashboard awaits) goes on to
    // main().catch, which prints it and exits 1 as before. The TUI may hide
    // that print, so record it in watch.log first.
    crashHandlers.recordFatal("startup", err);
    throw err;
  }
}

/** launchDashboard's body: everything until the TUI is up and the watcher's first scan is done. */
async function startDashboard(crashHandlers: WatchCrashHandlers, bootStart: number): Promise<void> {
  const machine = await initializeMachineName();
  const registry = await loadRegistry();
  const repos = registry.repos;
  logToWatchLog(`[startup] registry loaded: ${repos.length} repos (+${Date.now() - bootStart}ms)`);
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

  await acquireSystemCoordinator();
  // agent-types dir must exist before ensureSystemCoordinator() — it reads system-coordinator.md to resolve its model.
  await ensureAgentTypesDir();
  // Kept so the Remote Control light can re-read the settings file this launch writes.
  const dashboard = new DashboardComponent();
  const coordinatorStartup = ensureSystemCoordinator().catch((err) => {
    // Fires asynchronously — may resolve after the TUI has mounted, so
    // route through logWarning to avoid corrupting the dashboard.
    const message = `System coordinator startup failed: ${err instanceof Error ? err.message : String(err)}`;
    logWarning(message);
    dashboard.setNotice(message, "error");
  });
  logToWatchLog(`[startup] coordinator ref acquired and agent types ensured (+${Date.now() - bootStart}ms)`);

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
  logToWatchLog(`[startup] agent types validated and config read (+${Date.now() - bootStart}ms)`);

  // macOS sleep, display, lock, session and keychain events, as `system: ...`
  // lines in watch.log (src/system-events.ts, SPEC §8.15). Stopped in
  // quitDashboard; its helper also exits on its own when ib watch dies.
  const { SystemEventMonitor } = await import("../system-events");
  const systemEvents = new SystemEventMonitor({ log: logToWatchLog });
  systemEvents.start();

  // Telegram subsystem: three-step boot. Token check → connect probe →
  // resolve chat id from inbound inference → construct dispatcher + outbox.
  // Each step gates the next; on failure we log a single line and continue
  // with the rest of the dashboard (agents, watcher, TUI) running normally.
  // The boot itself is kicked off as a background promise AFTER the TUI is
  // mounted (see below) — a hung Telegram API call must never delay the
  // dashboard from appearing.
  const tgTokenEntry = config["channels.telegram.bot_token"];
  const tgToken = typeof tgTokenEntry?.value === "string" ? tgTokenEntry.value : "";
  const { TelegramClient, logCtx: telegramClientLogCtx } = await import("../channels/telegram-client");
  const { TelegramDispatcher, logCtx: telegramDispatcherLogCtx } = await import("../channels/dispatcher");
  const { TelegramOutbox, defaultOutboxDir } = await import("../channels/outbox");
  const { readAccess } = await import("../channels/access");
  const { bootTelegramSubsystem } = await import("../channels/boot");
  const { TelegramConnectionMonitor } = await import("../channels/connection-monitor");
  const { WakeDetector } = await import("../channels/wake-detector");
  // Redirect telegram-client and dispatcher logs (which default to stderr)
  // into watch.log so they don't corrupt the TUI rendering. Must run BEFORE
  // the telegram boot IIFE so no `getUpdates` retry line can leak in between.
  telegramClientLogCtx.set(logToWatchLog);
  telegramDispatcherLogCtx.set(logToWatchLog);
  const access = await readAccess();
  // One-time cleanup of the Phase A chat-id state file. Phase B holds the
  // chat id in memory only; the on-disk artifact is no longer used. Best
  // effort — ignore ENOENT and any other failure.
  try {
    const { join } = await import("path");
    const { userHome } = await import("../home");
    const { unlink } = await import("fs/promises");
    const stalePath = join(userHome(), ".itsybitsy", "channels", "telegram", "chat-id");
    await unlink(stalePath).catch(() => { /* file already absent */ });
  } catch {
    /* best effort — never block boot on cleanup */
  }
  let telegramDispatcher: import("../channels/dispatcher").TelegramDispatcher | null = null;
  let telegramOutbox: import("../channels/outbox").TelegramOutbox | null = null;
  /** Aborted on quit: a boot still retrying a transient failure gives up. */
  const telegramBootAbort = new AbortController();
  /** Wake-from-sleep detector (src/channels/wake-detector.ts), only with a
   *  token: on a wake the poll loop and a retrying boot reconnect at once. */
  const telegramWake = tgToken !== "" ? new WakeDetector({ log: logToWatchLog }) : null;

  // The first segment of every local agent key (SPEC §17.1): read from
  // ~/.itsybitsy/machine-name, or set once from the computer name. Before the
  // layout, so favorites and the first selection use it.
  dashboard.setMachineName(machine);
  const savedLayout = await loadLayout();
  if (savedLayout) {
    dashboard.applyLayout(savedLayout);
  }
  logToWatchLog(`[startup] layout applied (+${Date.now() - bootStart}ms)`);
  // Always run the one-time re-pin migration on the first populated onUpdate,
  // whether or not a saved layout existed. applyLayout sets pendingTmuxResize
  // when a layout is restored; set it here too so a first-run user (no saved
  // layout) still gets pre-pin agent + coordinator windows re-pinned to
  // PINNED_TMUX_WIDTH. New spawns already start pinned via tmuxWidthForAgent.
  dashboard.requestTmuxRepin();
  dashboard.setTui(tui);
  dashboard.setRepos(repos);
  const diffToolValue = config["externalDiffTool"]?.value;
  dashboard.setDiffTool(typeof diffToolValue === "string" && diffToolValue ? diffToolValue : undefined);
  // Parent-directory grouping preference (tree.groupByParent). The dashboard
  // stores it and re-applies it to the watcher in setWatcher() below, so the
  // ordering of this read vs. watcher construction doesn't matter.
  const groupByParentValue = config["tree.groupByParent"]?.value;
  dashboard.setGroupByParent(groupByParentValue === true);
  dashboard.setVersion(version);
  // Telegram connection state (src/channels/connection-monitor.ts): one view
  // from the boot, the poll loop and the outbox, pushed on every change to
  // the header light + `?` help row (only with a token) and to
  // ~/.itsybitsy/channels/telegram/status.json (always, so `ib tgsend` can
  // tell "no token" from "ib watch is not running"). The 5 s tick re-derives
  // it as a backstop for a change that fired no event.
  const telegramMonitor = new TelegramConnectionMonitor({
    log: logToWatchLog,
    wake: telegramWake ?? undefined,
    onChange: (view) => {
      if (tgToken !== "") dashboard.setTelegramConnection(view);
    },
  });
  if (tgToken !== "") {
    // Show yellow "connecting" until the background boot below reports.
    // Without a token the boot's "disabled" is the first state published.
    telegramMonitor.refresh();
    telegramWake?.start();
    dashboard.telegramStatusTimer = setInterval(() => telegramMonitor.refresh(), 5_000);
  }
  // Peering (src/peers/service.ts): nothing is loaded or bound here. The
  // endpoint binds at boot when peers.json lists a peer (bootIfPaired, started
  // at the end of this function once the watcher's first scan is done), or
  // else the first time the Peers tab (`I`) opens, and stays up until
  // quitDashboard shuts it down; after a failed bind or accept loop the
  // service rebinds on its own with backoff (SPEC §20.3). Logs go to watch.log. That first bind stalls
  // the UI once, for about a third of a second: the dynamic import in
  // src/peers/iroh.ts evaluates the napi addon synchronously on the event loop.
  // The trusted link answers peers from the watcher's last fully detected
  // agents (lastDetectedAgents, what the tree shows), the pending questions
  // of the same refresh and the repos' cached clone info (repoCloneInfo,
  // re-read by setRepos), so an answer costs no IO and never carries a state
  // that detection has not filled in yet.
  const peerDeps = defaultPeerServiceDeps(machine, logToWatchLog, () =>
    peerSnapshot(dashboard.repos, dashboard.watcher?.lastDetectedAgents ?? [], dashboard.watcher?.lastQuestions ?? [],
      dashboard.agentTree.flatList.find(row => row.kind === "system-coordinator")?.state, dashboard.repoCloneInfo),
    (message, kind) => dashboard.remoteAgentStarted(message, kind));
  peerDeps.captureAgent = (repo, id, lines) => captureAgentPane(dashboard.watcher?.lastDetectedAgents ?? [], repo, id, lines);
  peerDeps.captureDiff = (repo, id) => captureAgentDiff(dashboard.watcher?.lastDetectedAgents ?? [], repo, id);
  peerDeps.readPrompt = (repo, id) => readAgentPromptText(dashboard.watcher?.lastDetectedAgents ?? [], repo, id);
  // Remote terminals (SPEC §20.4) attach to the same agents the link reports.
  peerDeps.terminal = localTerminalHost(() => dashboard.watcher?.lastDetectedAgents ?? []);
  const peerService = new PeerService(peerDeps);
  dashboard.setPeerService(peerService);
  // Top-bar status lights, both read in process, never by spawning:
  // - the shared sandbox denial collector: lock probes and a heartbeat read
  //   (src/sandbox-collector-light.ts), not `ib sandbox-collector status`.
  //   While collection is switched off in this build nothing can change, so it
  //   stays grey and the tick skips it.
  // - the system coordinator's Remote Control: system-coordinator.md and the
  //   coordinator's settings.local.json (src/remote-control-light.ts), re-read
  //   every tick so a coordinator restart shows on the next one, and again as
  //   soon as the startup launch above ends, since it may rewrite the settings
  //   file after the first read. Watcher updates add the coordinator's stopped
  //   state (onUpdate).
  dashboard.setCollectorStatus(sandboxCollectorHealth());
  void dashboard.refreshRemoteControlStatus();
  void dashboard.refreshRemoteControlAfterLaunch(coordinatorStartup);
  dashboard.statusLightTimer = setInterval(() => {
    const warning = takeCoordinatorPaneWarning();
    if (warning) dashboard.setNotice(warning, "error");
    if (SANDBOX_DENIAL_COLLECTOR_ENABLED) {
      dashboard.setCollectorStatus(sandboxCollectorHealth({ previous: dashboard.collectorStatus }));
    }
    void dashboard.refreshRemoteControlStatus();
  }, 5_000);
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
  // rather than stderr (which would render the dashboard unreadable). A
  // transient probe failure (outage, timeout, 5xx, 429) is retried inside
  // the boot until it connects or quit aborts it; the light stays yellow
  // "connecting" meanwhile.
  const telegramBootPromise: Promise<void> = (async () => {
    try {
      const bootResult = await bootTelegramSubsystem({
        token: tgToken,
        access,
        buildClient: (token) => new TelegramClient({ token }),
        buildDispatcher: (opts) => new TelegramDispatcher(opts),
        buildOutbox: (opts) => new TelegramOutbox({ ...opts, log: logToWatchLog }),
        log: logToWatchLog,
        signal: telegramBootAbort.signal,
        wake: telegramWake ?? undefined,
        onRetry: (info) => telegramMonitor.bootRetry(info.reason),
      });
      // Quit while the last probe was in flight: start nothing.
      if (telegramBootAbort.signal.aborted) return;
      if (bootResult.ok) {
        telegramDispatcher = bootResult.dispatcher;
        telegramOutbox = bootResult.outbox;
        // Attach before starting so no transition is missed. The monitor
        // logs the dispatcher's transitions (disconnected / reconnected),
        // kicks the outbox when the poll loop recovers, and reconnects both
        // on a wake from sleep.
        telegramMonitor.attach(telegramDispatcher, telegramOutbox);
        // Don't await — start() runs the loop in the background.
        telegramDispatcher.start()
          .catch((err) => {
            logToWatchLog(`Telegram dispatcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => telegramMonitor.dispatcherStartSettled());
        // Outbox start() awaits the sweep + watcher install. We let it run in
        // the background so a stuck filesystem can't block the dashboard.
        telegramOutbox.start().catch((err) => {
          logToWatchLog(`Telegram outbox failed to start at ${defaultOutboxDir()}: ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        // The boot helper already wrote the failure reason to watch.log via
        // the injected `log`; publish it (light, help row, status file).
        telegramMonitor.bootDisabled(bootResult.message);
      }
    } catch (err) {
      // bootTelegramSubsystem itself shouldn't throw — but if a future change
      // adds a path that does, we don't want it to take down launchDashboard.
      logToWatchLog(`Telegram routing disabled: boot threw (${err instanceof Error ? err.message : String(err)})`);
      // A fixed label: the status file must stay token-safe, and a raw
      // exception message carries no such guarantee.
      telegramMonitor.bootDisabled("boot threw unexpectedly (see watch.log)");
    }
  })();

  const colorDetection = setupColorSchemeDetection(() => {
    tui.requestRender();
  });

  const typePickerKeyboard = new TypePickerKeyboard(terminal, () =>
    (dashboard.dialog?.type === "new-agent-form" && (dashboard.dialog.focused === "agentType" || dashboard.dialog.focused === "machine"))
    || (dashboard.dialog?.type === "scheduled-task-form" && ["machine", "repo", "agentType"].includes(dashboard.dialog.focused)));
  const stopTerminal = installTerminalCleanup(() => {
    typePickerKeyboard.stop();
    tui.stop();
  });
  // A crash's terminal teardown: the synchronous terminal steps of
  // quitDashboard below, in its order. The async rest (Telegram, peers, the
  // coordinator release) is skipped, as it was when Bun killed the process.
  crashHandlers.setRestoreTerminal(() => {
    setWatchRunning(false);
    agentActions.killActiveDiffProc();
    colorDetection.cleanup();
    stopTerminal();
    dashboard.setTerminalTitle("");
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[2J\x1b[H");
  });
  // Ctrl+C and `ib bounce` (BOUNCE_SIGNAL) both quit through here. bounce.sh
  // relaunches ib watch within seconds, so a bounce leaves per-repo
  // coordinators running instead of pausing them. The flag keeps a signal
  // that arrives during shutdown from starting a second one.
  let quitting = false;
  /** Scheduled tasks (SPEC §21.2): started at the end of this function, once the watcher and peer service are up. */
  let scheduler: Scheduler | null = null;
  /** The startup + hourly orphan scan (SPEC §8.3): started at the end of this function. */
  let orphanScanTimer: OrphanScanTimer | null = null;
  const quitDashboard = (pauseRepoCoordinators: boolean): void => {
    if (quitting) return;
    quitting = true;
    // The [exit] line process.exit(0) writes below says this was a quit.
    crashHandlers.noteQuit(pauseRepoCoordinators ? "Ctrl+C" : "ib bounce");
    // Re-enable stderr-bound warnings — TUI is going down.
    setWatchRunning(false);
    agentActions.killActiveDiffProc();
    colorDetection.cleanup();
    dashboard.stopPolling();
    watcher.stop();
    // No orphan scan starts from here on; one already running is not waited out.
    orphanScanTimer?.stop();
    // No scheduled run starts from here on; a remote start in flight is
    // aborted. Raced like Telegram: a local spawn in flight is not waited out.
    const stopScheduler = scheduler
      ? Promise.race([scheduler.stop(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
      : Promise.resolve();
    stopTerminal();
    // stopTerminal() restored cooked mode and dropped the SIGINT handler, so
    // another Ctrl-C now arrives as SIGINT. Under bounce.sh that is the
    // natural way to stop the loop, but dying here would skip the release
    // below and orphan the coordinator. Ignore it; bounce.sh stops at its
    // countdown, and SIGTERM still ends a stuck shutdown.
    process.on("SIGINT", () => {});
    dashboard.setTerminalTitle("");
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[2J\x1b[H");
    process.stdout.write("Quitting ib watch…\n");
    // Telegram connection: a boot still retrying gives up, the wake detector
    // stops, and the monitor stops listening and publishing BEFORE the
    // dispatcher stops, so the stop's → down transition neither logs nor
    // writes "disabled". dispose() then waits for queued status writes and
    // removes the status file (a clean quit; a crash leaves it for readers
    // to discard by pid).
    telegramBootAbort.abort();
    telegramWake?.stop();
    systemEvents.stop();
    const disposeTelegramMonitor = Promise.race([
      telegramMonitor.dispose(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
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
    // the Telegram API is hung (the abort above normally ends it at once).
    // After this race resolves the boot promise is "released" — any
    // handlers it has chained will still run, but they won't block process
    // exit because of the .finally(process.exit) below.
    const finishBoot = Promise.race([
      telegramBootPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    // Stop the peer poller, close the iroh endpoint (if boot or the Peers
    // dialog bound it) and release the endpoint lock. Raced like Telegram:
    // under the n0 preset close() can take about a second, and a stuck one
    // must not hold up the exit.
    const stopPeers = dashboard.shutdownPeerTransfers(peerService);
    // Flush layout save to disk before exiting, then release coordinator
    Promise.all([
      flushPendingSave().catch(() => { /* ignore write errors on exit */ }),
      stopTelegram.catch(() => { /* ignore — already raced */ }),
      stopOutbox.catch(() => { /* ignore — already raced */ }),
      finishBoot.catch(() => { /* ignore — boot was best effort */ }),
      disposeTelegramMonitor.catch(() => { /* ignore — already raced */ }),
      stopPeers.catch(() => { /* ignore — already raced */ }),
      stopScheduler.catch(() => { /* ignore — already raced */ }),
    ]).then(() => {
      // Release coordinator ref — if last ref, kills the tmux session
      // and pauses all per-repo coordinators
      return releaseSystemCoordinator(pauseRepoCoordinators ? async () => {
        // Pause all per-repo coordinators when last watcher exits
        const agents = dashboard.watcher?.lastAgents ?? [];
        const coordinators = agents.filter(a => a.meta.agentType === REPO_COORDINATOR_TYPE);
        await Promise.all(coordinators.map(a => pauseAgent(a).catch(() => {})));
      } : undefined);
    }).finally(() => {
      process.exit(0);
    });
  };
  // `ib bounce` is a tool call in the coordinator's Claude session. Waiting
  // lets it return and Claude Code record the result before quitting kills
  // that session.
  process.on(BOUNCE_SIGNAL, () => {
    logToWatchLog(`[bounce] quitting ib watch in ${BOUNCE_QUIT_DELAY_MS}ms`);
    setTimeout(() => quitDashboard(false), BOUNCE_QUIT_DELAY_MS);
  });
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      quitDashboard(true);
      return undefined;
    }
    if (colorDetection.inputFilter(data)) return undefined;
    if (isKeyRelease(data)) return undefined;
    typePickerKeyboard.handleInput(data, input => dashboard.handleInput(input));
    return undefined;
  });

  // Handle terminal resize. No tmux resize here: every agent + coordinator tmux
  // window is pinned to PINNED_TMUX_WIDTH and never follows the terminal. The
  // display panes reflow to the new terminal/pane width at render time via
  // WordWrapCache, so a SIGWINCH only needs a re-render (+ a log-cache refresh).
  process.stdout.on("resize", () => {
    // displayHeight is recomputed inside render() — at the moment the resize
    // event fires it still holds the pre-resize value, so a cache check now
    // would falsely hit. Drop the active tail-log mode's cached window so
    // loadTailLogIfNeeded is forced to re-read once render has updated
    // displayHeight; defer the call via setImmediate so it runs after the next
    // render tick.
    const logMode = dashboard.rightPane.mode;
    if (isTailLogMode(logMode)) {
      dashboard.rightPane.invalidateTailLogWindow(logMode);
      setImmediate(() => {
        if (dashboard.rightPane.mode === logMode) {
          dashboard.loadTailLogIfNeeded(logMode);
        }
      });
    }
    tui.requestRender();
  });

  // Disable terminal mouse reporting so the emulator handles clicks natively
  // (drag-select, double-click word, ⌘C) and we never see mouse bytes on stdin.
  // Without this, a previously-running program can leave Ghostty in a legacy
  // mouse mode that streams \x1b[D (left-arrow) floods on every click.
  // Sequences: ?1000 (X10), ?1002 (button-event), ?1003 (any-event), ?1006 (SGR).
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
  // Re-assert on exit in case anything inside the session re-enabled mouse mode.
  process.on("exit", () => {
    setWatchRunning(false);
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
  });

  // From here on, any stderr/console.error write would corrupt the TUI.
  // logWarning() consults this flag to route warnings to watch.log instead.
  setWatchRunning(true);
  tui.start();
  typePickerKeyboard.start();
  logToWatchLog(`[startup] tui.start() called (+${Date.now() - bootStart}ms)`);
  colorDetection.queryColorScheme();
  dashboard.startPolling();
  logToWatchLog(`[startup] dashboard.startPolling() called, starting watcher (+${Date.now() - bootStart}ms)`);
  await watcher.start();
  logToWatchLog(`[startup] watcher.start() resolved (+${Date.now() - bootStart}ms)`);
  // Peering at boot, in the background like Telegram, once the first agent
  // tree has been drawn: a paired install binds the endpoint (taking the
  // endpoint lock first) and starts polling its peers. Starting it here keeps
  // the one-time addon-load stall out of the watcher's first scan, and means
  // the trusted link never answers with the empty pre-scan list. It never
  // throws; shutdown waits for the bind.
  void peerService.bootIfPaired();
  // Scheduled tasks (SPEC §21.2), once the watcher and the peer service are
  // up. The first tick, 30 s from now, also fires a run due in about the 90 s
  // before this moment (the grace before that tick; the gap of an
  // `ib bounce`), unless the previous `ib watch` claimed it. There is no tick
  // at once, so peer links can reconnect before a remote run. A remote task
  // starts through
  // the peer service as the New Agent form's start does (its human-caller
  // decision and connection checks), but outside the form's one-start slot,
  // so it neither waits for nor blocks a user's remote start.
  if (!quitting) {
    scheduler = new Scheduler({
      now: () => Date.now(),
      readTasks: readScheduledTasks,
      claimRun: claimScheduledRun,
      recordResult: recordScheduledRunResult,
      startLocal: (task, prompt) => startLocalScheduledAgent(task, prompt, { listRepos, newAgent }),
      startRemote: (task, prompt, signal) => peerService.startRemoteAgent(task.machine!, {
        repo: task.repo, type: task.agentType, prompt, autoRetire: task.autoRetire,
      }, { signal }),
      // From the last endpoint-lock outcome, not the status: the 30 s lock
      // poll's bind reads `starting` while it asks the owner's lock again.
      remoteRunsHere: () => !peerService.endpointOwnedElsewhere,
      machineName: machine,
      targetName: (id) => {
        if (id === null) return machine;
        const view = peerService.view();
        return [...view.links, ...view.peers].find(peer => peer.id === id)?.name ?? shortPeerId(id);
      },
      log: logToWatchLog,
      notice: (text, kind) => dashboard.setNotice(text, kind),
      refresh: () => { void dashboard.watcher?.refresh(); },
    });
    scheduler.start();
    // The orphan scan (SPEC §8.3), once 60 s from now and then hourly. One
    // timer for the whole process, not one per repo: the scan reads the whole
    // process table. Off the render path; a failure is logged, never thrown.
    orphanScanTimer = startOrphanScanTimer({ scan: () => scanAndKillOrphans(), log: logToWatchLog });
  }
}
