/**
 * Main TUI dashboard — agent tree + live tmux pane.
 * Phase 3: basic dashboard with agent tree, state updates, keybindings.
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
import { listRepos } from "../registry";
import { AgentWatcher } from "../watcher";
import { TmuxPoller } from "../tmux-poller";
import type { FlatAgent } from "../watcher";
import type { Agent, PendingQuestion } from "../agents";
import { SplitPane } from "./split-pane";

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
        this.content = this.agent
          ? [`${DIM}Agent log for ${this.agent.id}${RESET}`, `${DIM}(Phase 4: will read agent.log)${RESET}`]
          : [`${DIM}No agent selected${RESET}`];
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

    const start = this.scrollOffset;
    const visible = this.content.slice(start);
    for (const line of visible) {
      lines.push(truncateToWidth(line, width, ""));
    }

    return lines;
  }
}

/** Tmux output pane — shows live tmux capture for the selected agent */
class TmuxPaneComponent implements Component {
  agent: Agent | null = null;
  rawOutput: string = "";

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.agent) {
      return [truncateToWidth(`${DIM}No agent selected${RESET}`, width, "")];
    }
    if (!this.rawOutput) {
      return [
        truncateToWidth(`${BOLD}${this.agent.id}${RESET} ${DIM}(${this.agent.meta.tmux_session})${RESET}`, width, ""),
        truncateToWidth(`${DIM}Waiting for tmux output...${RESET}`, width, ""),
      ];
    }
    // Show raw output with ANSI, truncated per line
    const lines = this.rawOutput.split("\n");
    return lines.map((line) => truncateToWidth(line, width, ""));
  }
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

    const keys = `${DIM}j/k:nav  p/n:pane  d:diff  g:status  e:errors  q:questions  Ctrl-C:quit${RESET}`;
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
    this.rightPane.updateContent();

    // Update tmux poller target
    this.tmuxPoller.setAgent(
      selected?.meta.tmux_session ?? null,
      selected?.repoPath ?? null
    );
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
    // Scroll pane content
    else if (data === ";") {
      this.rightPane.scrollOffset++;
      this.rightPane.updateContent();
      this.tui?.requestRender();
    } else if (data === "l") {
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
