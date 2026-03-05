/**
 * Main TUI dashboard — agent tree + live tmux pane.
 * Phase 4: improved tmux rendering with line wrapping, scroll, agent.log reading.
 */

import {
  TUI,
  ProcessTerminal,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { join } from "path";
import { listRepos } from "../registry";
import { AgentWatcher } from "../watcher";
import { TmuxPoller } from "../tmux-poller";
import type { Agent, FlatAgent, PendingQuestion } from "../agents";
import { SplitPane } from "./split-pane";
import { wrapLines } from "./wrap";

const MAX_TREE_HEIGHT = 7;

// State color map
const STATE_COLORS: Record<string, string> = {
  creating: "\x1b[33m",    // yellow
  running: "\x1b[32m",     // green
  waiting: "\x1b[36m",     // cyan
  complete: "\x1b[34m",    // blue
  compacting: "\x1b[35m",  // magenta
  rate_limited: "\x1b[31m",// red
  stopped: "\x1b[90m",     // dim
  unknown: "\x1b[37m",     // white
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// Right pane modes
const PANE_MODES = [
  "AGENT LOG",
  "INITIAL PROMPT",
  "DENIALS",
  "TREE",
  "ERRORS",
  "DIFF",
  "STATUS",
  "QUESTIONS",
] as const;
type PaneMode = (typeof PANE_MODES)[number];

/** Format agent row for the tree */
function formatAgentRow(
  agent: Agent,
  depth: number,
  selected: boolean,
  width: number
): string {
  const indent = depth === 0 ? "" : "  ".repeat(depth) + "↳ ";
  const icon = agent.meta.worker ? "⚙" : "◆";
  const stateColor = STATE_COLORS[agent.state] ?? STATE_COLORS.unknown;
  const archived = agent.archived ? `${DIM}[archived]${RESET} ` : "";
  const sel = selected ? `${BOLD}\x1b[7m` : "";
  const selEnd = selected ? `${RESET}` : "";

  const shortPrompt = agent.meta.prompt.replace(/\n/g, " ").slice(0, 40);
  const line = `${indent}${icon} ${agent.repoName}/${agent.id}  ${stateColor}${agent.state}${RESET}  ${agent.age}  ${agent.meta.model}  ${archived}${shortPrompt}`;

  return `${sel}${truncateToWidth(line, width, "")}${selEnd}`;
}

/**
 * Read agent.log file for a given agent.
 * Returns the log content as an array of lines, or a placeholder message.
 */
export async function readAgentLog(agent: Agent): Promise<string[]> {
  const dir = agent.archived ? "archive" : "agents";
  const logPath = join(agent.repoPath, ".ittybitty", dir, agent.id, "agent.log");
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      return [`${DIM}No agent.log found${RESET}`];
    }
    const text = await file.text();
    if (!text.trim()) {
      return [`${DIM}agent.log is empty${RESET}`];
    }
    return text.split("\n");
  } catch {
    return [`${DIM}Failed to read agent.log${RESET}`];
  }
}

/** Agent tree component with height constraint and scrolling */
class AgentTreeComponent implements Component {
  flatList: FlatAgent[] = [];
  selectedIndex = 0;
  showArchived = false;
  private scrollOffset = 0;

  get visibleList(): FlatAgent[] {
    if (this.showArchived) return this.flatList;
    return this.flatList.filter((f) => !f.agent.archived);
  }

  get selectedAgent(): Agent | null {
    const visible = this.visibleList;
    if (this.selectedIndex >= 0 && this.selectedIndex < visible.length) {
      return visible[this.selectedIndex].agent;
    }
    return null;
  }

  toggleArchived() {
    this.showArchived = !this.showArchived;
    // Clamp selection after toggling
    const visible = this.visibleList;
    if (this.selectedIndex >= visible.length) {
      this.selectedIndex = Math.max(0, visible.length - 1);
    }
    this.ensureSelectedVisible();
  }

  moveSelection(delta: number) {
    const visible = this.visibleList;
    if (visible.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(visible.length - 1, this.selectedIndex + delta));
    this.ensureSelectedVisible();
  }

  /** Keep selected index within the visible scroll window */
  private ensureSelectedVisible() {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + MAX_TREE_HEIGHT) {
      this.scrollOffset = this.selectedIndex - MAX_TREE_HEIGHT + 1;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const visible = this.visibleList;
    if (visible.length === 0) {
      return [truncateToWidth(`${DIM}  No agents found${RESET}`, width, "")];
    }

    const lines: string[] = [];
    const start = this.scrollOffset;
    const end = Math.min(visible.length, start + MAX_TREE_HEIGHT);

    // Scroll indicator at top
    if (start > 0) {
      lines.push(truncateToWidth(`${DIM}  ▲ ${start} more${RESET}`, width, ""));
    }

    for (let i = start; i < end; i++) {
      const { agent, depth } = visible[i];
      lines.push(formatAgentRow(agent, depth, i === this.selectedIndex, width));
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
class RightPaneComponent implements Component {
  mode: PaneMode = "AGENT LOG";
  agent: Agent | null = null;
  questions: PendingQuestion[] = [];
  allAgents: FlatAgent[] = [];
  scrollOffset = 0;
  displayHeight = 20;
  agentLogContent: string[] | null = null;
  private content: string[] = [];

  invalidate(): void {}

  setMode(mode: PaneMode) {
    this.mode = mode;
    this.scrollOffset = 0;
    this.updateContent();
  }

  updateContent() {
    switch (this.mode) {
      case "AGENT LOG":
        this.content = this.agentLogContent
          ?? (this.agent
            ? [`${DIM}Loading agent.log...${RESET}`]
            : [`${DIM}No agent selected${RESET}`]);
        break;
      case "INITIAL PROMPT":
        this.content = this.agent
          ? [`${BOLD}Prompt:${RESET}`, "", ...this.agent.meta.prompt.split("\n")]
          : [`${DIM}No agent selected${RESET}`];
        break;
      case "DENIALS":
        this.content = [`${DIM}Denials view (Phase 5)${RESET}`];
        break;
      case "TREE":
        this.content = this.allAgents.map(({ agent, depth }) => {
          const indent = "  ".repeat(depth);
          const icon = agent.meta.worker ? "⚙" : "◆";
          const stateColor = STATE_COLORS[agent.state] ?? STATE_COLORS.unknown;
          return `${indent}${icon} ${agent.repoName}/${agent.id}  ${stateColor}${agent.state}${RESET}`;
        });
        if (this.content.length === 0) this.content = [`${DIM}No agents${RESET}`];
        break;
      case "ERRORS":
        this.content = [`${DIM}No errors${RESET}`];
        break;
      case "DIFF":
        this.content = [`${DIM}Diff view (Phase 5: ib diff)${RESET}`];
        break;
      case "STATUS":
        this.content = [`${DIM}Status view (Phase 5: ib status)${RESET}`];
        break;
      case "QUESTIONS":
        if (this.questions.length === 0) {
          this.content = [`${DIM}No pending questions${RESET}`];
        } else {
          this.content = this.questions.map(
            (q) => `${BOLD}${q.agent}:${RESET} ${q.question}`
          );
        }
        break;
    }
  }

  render(width: number): string[] {
    const header = `${BOLD}${DIM}── ${this.mode} ──${RESET}`;
    const lines = [truncateToWidth(header, width, "")];

    // Available lines after header
    const available = Math.max(1, this.displayHeight - 1);
    const start = this.scrollOffset;
    const visible = this.content.slice(start, start + available);
    for (const line of visible) {
      lines.push(truncateToWidth(line, width, ""));
    }

    // Pad to displayHeight so both panes are same height
    while (lines.length < this.displayHeight) {
      lines.push("");
    }

    return lines;
  }
}

/**
 * Tmux output pane — shows live tmux capture for the selected agent.
 * Wraps long lines to pane width, supports scroll-back from bottom.
 */
class TmuxPaneComponent implements Component {
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
      const stateColor = STATE_COLORS[this.agent.state] ?? STATE_COLORS.unknown;
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

    // Slice visible window from the bottom
    const end = wrapped.length - this.scrollBack;
    const start = Math.max(0, end - this.displayHeight);
    const visible = wrapped.slice(start, end);

    // Truncate each line (wrap should already fit, but ensure safety)
    const lines = visible.map((line) => truncateToWidth(line, width, ""));

    // Show scroll indicator if scrolled back
    if (this.scrollBack > 0 && lines.length > 0) {
      lines[lines.length - 1] = truncateToWidth(
        `${DIM}── ↓ ${this.scrollBack} lines below ──${RESET}`,
        width,
        ""
      );
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
  currentMode: PaneMode = "AGENT LOG";
  modeIndex = 0;

  invalidate(): void {}

  render(width: number): string[] {
    const questionBadge =
      this.pendingQuestions > 0
        ? ` ${BOLD}\x1b[33m[${this.pendingQuestions} questions]${RESET}`
        : "";

    const keys = `${DIM}j/k:nav  ;/l:scroll  p/n:pane  d:diff  g:status  e:errors  q:questions  Ctrl-C:quit${RESET}`;
    const modeLine = `${DIM}[${this.modeIndex}] ${this.currentMode}${RESET}${questionBadge}`;
    return [
      truncateToWidth(modeLine, width, ""),
      truncateToWidth(keys, width, ""),
    ];
  }
}

/** Main dashboard component that composes everything */
class DashboardComponent implements Component {
  private agentTree: AgentTreeComponent;
  private rightPane: RightPaneComponent;
  private tmuxPane: TmuxPaneComponent;
  private splitPane: SplitPane;
  private statusBar: StatusBarComponent;
  private tui: TUI | null = null;
  private modeIndex = 0;
  private tmuxPoller: TmuxPoller;
  private currentAgentId: string | null = null;

  constructor() {
    this.agentTree = new AgentTreeComponent();
    this.rightPane = new RightPaneComponent();
    this.tmuxPane = new TmuxPaneComponent();
    this.statusBar = new StatusBarComponent();

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
  }

  stopPolling() {
    this.tmuxPoller.stop();
  }

  onUpdate(agents: Agent[], flatList: FlatAgent[], questions: PendingQuestion[]) {
    this.agentTree.flatList = flatList;
    this.rightPane.questions = questions;
    this.rightPane.allAgents = flatList;
    this.statusBar.pendingQuestions = questions.length;

    // Update selected agent info
    this.syncSelectedAgent();

    this.tui?.requestRender();
  }

  private syncSelectedAgent() {
    const selected = this.agentTree.selectedAgent;
    this.rightPane.agent = selected;
    this.tmuxPane.agent = selected;

    // If agent changed, reset tmux pane state and reload agent log
    const newId = selected?.id ?? null;
    if (newId !== this.currentAgentId) {
      this.currentAgentId = newId;
      this.tmuxPane.resetForAgent();
      this.rightPane.agentLogContent = null;
      this.rightPane.scrollOffset = 0;
      if (selected) {
        this.loadAgentLog(selected);
      }
    }

    this.rightPane.updateContent();

    // Update tmux poller target
    this.tmuxPoller.setAgent(selected?.meta.tmux_session ?? null);
  }

  private async loadAgentLog(agent: Agent) {
    const content = await readAgentLog(agent);
    // Only apply if we're still looking at the same agent
    if (this.currentAgentId === agent.id) {
      this.rightPane.agentLogContent = content;
      this.rightPane.updateContent();
      this.tui?.requestRender();
    }
  }

  private cyclePaneMode(delta: number) {
    this.modeIndex = (this.modeIndex + PANE_MODES.length + delta) % PANE_MODES.length;
    this.rightPane.setMode(PANE_MODES[this.modeIndex]);
    this.statusBar.currentMode = PANE_MODES[this.modeIndex];
    this.statusBar.modeIndex = this.modeIndex;
  }

  private jumpToMode(mode: PaneMode) {
    const idx = PANE_MODES.indexOf(mode);
    if (idx !== -1) {
      this.modeIndex = idx;
      this.rightPane.setMode(mode);
      this.statusBar.currentMode = mode;
      this.statusBar.modeIndex = idx;
    }
  }

  handleInput(data: string): void {
    // Navigation
    if (matchesKey(data, Key.down) || data === "j") {
      this.agentTree.moveSelection(1);
      this.syncSelectedAgent();
      this.tui?.requestRender();
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.agentTree.moveSelection(-1);
      this.syncSelectedAgent();
      this.tui?.requestRender();
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
    // Direct pane jumps
    else if (data === "d") {
      this.jumpToMode("DIFF");
      this.tui?.requestRender();
    } else if (data === "g") {
      if (this.rightPane.mode === "QUESTIONS") {
        // Navigate to agent that asked the question (Phase 5)
      } else {
        this.jumpToMode("STATUS");
        this.tui?.requestRender();
      }
    } else if (data === "e") {
      this.jumpToMode("ERRORS");
      this.tui?.requestRender();
    } else if (data === "q") {
      this.jumpToMode("QUESTIONS");
      this.tui?.requestRender();
    }
    // Toggle archived agents
    else if (data === "a") {
      this.agentTree.toggleArchived();
      this.syncSelectedAgent();
      this.tui?.requestRender();
    }
    // Scroll pane content — scrolls both tmux pane and right pane
    else if (data === ";") {
      this.tmuxPane.scrollUp();
      this.rightPane.scrollOffset++;
      this.rightPane.updateContent();
      this.tui?.requestRender();
    } else if (data === "l") {
      this.tmuxPane.scrollDown();
      this.rightPane.scrollOffset = Math.max(0, this.rightPane.scrollOffset - 1);
      this.rightPane.updateContent();
      this.tui?.requestRender();
    }
  }

  invalidate(): void {
    this.agentTree.invalidate();
    this.splitPane.invalidate();
    this.statusBar.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Header
    lines.push(truncateToWidth(`${BOLD}itsybitsy${RESET} ${DIM}— agent dashboard${RESET}`, width, ""));
    lines.push(truncateToWidth(`${DIM}${"─".repeat(width)}${RESET}`, width, ""));

    // Agent tree (top section)
    const treeLines = this.agentTree.render(width);
    lines.push(...treeLines);

    // Separator
    lines.push(truncateToWidth(`${DIM}${"─".repeat(width)}${RESET}`, width, ""));

    // Compute available height for split pane
    const statusHeight = 2;
    const separatorHeight = 1; // bottom separator before status
    const usedHeight = lines.length + separatorHeight + statusHeight;
    const terminalRows = process.stdout.rows || 24;
    const availableHeight = Math.max(5, terminalRows - usedHeight);

    // Set display heights on sub-components before rendering
    this.tmuxPane.displayHeight = availableHeight;
    this.rightPane.displayHeight = availableHeight;

    // Split pane (tmux left + right pane)
    const splitLines = this.splitPane.render(width);
    lines.push(...splitLines);

    // Separator
    lines.push(truncateToWidth(`${DIM}${"─".repeat(width)}${RESET}`, width, ""));

    // Status bar
    const statusLines = this.statusBar.render(width);
    lines.push(...statusLines);

    return lines;
  }
}

export async function launchDashboard(): Promise<void> {
  const repos = await listRepos();
  if (repos.length === 0) {
    console.log("No repos registered. Use 'itsybitsy add <path>' to add one.");
    process.exit(1);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const dashboard = new DashboardComponent();
  dashboard.setTui(tui);
  tui.addChild(dashboard);

  // Global input handler
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      dashboard.stopPolling();
      watcher.stop();
      tui.stop();
      process.exit(0);
    }
    dashboard.handleInput(data);
    return undefined;
  });

  // Start watcher
  const watcher = new AgentWatcher(repos, {
    onUpdate: (agents, flatList, questions) => {
      dashboard.onUpdate(agents, flatList, questions);
    },
    onError: (err) => {
      // Log to stderr to avoid corrupting TUI output
      process.stderr.write(`Watcher error: ${err.message}\n`);
    },
  });

  tui.start();
  dashboard.startPolling();
  await watcher.start();
}
