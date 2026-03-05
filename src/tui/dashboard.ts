/**
 * Main TUI dashboard — agent tree + live tmux pane.
 * Phase 5.2: right pane content for all modes.
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
import type { RepoEntry } from "../registry";
import { AgentWatcher } from "../watcher";
import { TmuxPoller } from "../tmux-poller";
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
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

// Dialog types for agent actions
type DialogState =
  | { type: "confirm"; prompt: string; onYes: () => void }
  | { type: "input"; prompt: string; value: string; onSubmit: (value: string) => void }
  | { type: "select"; prompt: string; items: string[]; selectedIndex: number; onSelect: (index: number) => void }
  | { type: "message"; text: string }
  | null;

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

// Denials time filter levels
const DENIAL_FILTERS = ["all", "1h", "10m"] as const;
type DenialFilter = (typeof DENIAL_FILTERS)[number];

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
      return visible[this.selectedIndex]!.agent;
    }
    return null;
  }

  /** Select agent by ID. Returns true if found. */
  selectAgentById(agentId: string): boolean {
    const visible = this.visibleList;
    const idx = visible.findIndex((f) => f.agent.id === agentId);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.ensureSelectedVisible();
      return true;
    }
    return false;
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
      const { agent, depth } = visible[i]!;
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
export class RightPaneComponent implements Component {
  mode: PaneMode = "AGENT LOG";
  agent: Agent | null = null;
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

  updateContent() {
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
              this.content.push(`${DIM}[${d.timestamp}]${RESET} ${d.line.replace(/^\[.*?\] /, "")}`);
            }
          }
        }
        break;
      case "TREE":
        this.content = this.allAgents.map(({ agent, depth }) => {
          const indent = "  ".repeat(depth);
          const icon = agent.meta.worker ? "⚙" : "◆";
          const stateColor = STATE_COLORS[agent.state] ?? STATE_COLORS.unknown;
          return `${indent}${icon} ${agent.repoName}/${agent.id}  ${stateColor}${agent.state}${RESET}  ${agent.age}  ${agent.meta.model}`;
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
          this.content = [`${DIM}Press 'd' to load diff${RESET}`];
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
          this.content = [`${DIM}Press 'g' to load status${RESET}`];
        }
        break;
      case "QUESTIONS":
        if (this.questions.length === 0) {
          this.content = [`${DIM}No pending questions${RESET}`];
        } else {
          this.content = this.questions.map(
            (q, i) => {
              const sel = i === this.questionsSelectedIndex ? `${GREEN}> ` : "  ";
              const selEnd = i === this.questionsSelectedIndex ? RESET : "";
              return `${sel}${BOLD}${q.agent}:${RESET} ${q.question}${selEnd}`;
            }
          );
          this.content.push("", `${DIM}Enter:answer  Esc:acknowledge  g:go to agent${RESET}`);
        }
        break;
    }
  }

  private filterDenials(denials: DenialEntry[]): DenialEntry[] {
    if (this.denialFilter === "all") return denials;
    const now = Math.floor(Date.now() / 1000);
    const cutoff = this.denialFilter === "1h" ? now - 3600 : now - 600;
    return denials.filter((d) => d.epoch >= cutoff);
  }

  render(width: number): string[] {
    const header = `${BOLD}${DIM}── ${this.mode} ──${RESET}`;
    const lines = [truncateToWidth(header, width, "")];

    // Available lines after header
    const available = Math.max(1, this.displayHeight - 1);
    // Clamp scrollOffset to valid range
    const maxOffset = Math.max(0, this.content.length - available);
    if (this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }
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
  currentMode: PaneMode = "AGENT LOG";
  modeIndex = 0;

  invalidate(): void {}

  render(width: number): string[] {
    const questionBadge =
      this.pendingQuestions > 0
        ? ` ${BOLD}\x1b[33m[${this.pendingQuestions} questions]${RESET}`
        : "";

    const keys = `${DIM}j/k:nav  ;/l:scroll  p/n:pane  s:send  m:merge  x:kill  a:new  r:reassign  R:resume  A:archive  Ctrl-C:quit${RESET}`;
    const modeLine = `${DIM}[${this.modeIndex}] ${this.currentMode}${RESET}${questionBadge}`;
    return [
      truncateToWidth(modeLine, width, ""),
      truncateToWidth(keys, width, ""),
    ];
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
  private watcher: AgentWatcher | null = null;
  private repos: RepoEntry[] = [];
  private messageCounter = 0;

  /** Read-only access to dialog state (for testing) */
  get dialog(): DialogState {
    return this._dialog;
  }

  /** Read-only access to errors (for testing) */
  get errors(): string[] {
    return this.rightPane.errors;
  }

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

  setWatcher(watcher: AgentWatcher) {
    this.watcher = watcher;
  }

  setRepos(repos: RepoEntry[]) {
    this.repos = repos;
  }

  /** Add an error to the errors list (called from watcher onError) */
  addError(message: string) {
    const ts = new Date().toLocaleTimeString();
    this.rightPane.errors.push(`${DIM}[${ts}]${RESET} ${message}`);
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  /** Clear all errors */
  clearErrors() {
    this.rightPane.errors = [];
    this.rightPane.updateContent();
    this.tui?.requestRender();
  }

  private showMessage(text: string) {
    const id = ++this.messageCounter;
    this._dialog = { type: "message", text };
    this.tui?.requestRender();
    setTimeout(() => {
      if (this._dialog?.type === "message" && this.messageCounter === id) {
        this._dialog = null;
        this.tui?.requestRender();
      }
    }, 3000);
  }

  private async executeAndRefresh(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.showMessage(`Error: ${err}`);
    }
    this.watcher?.refresh();
  }

  private handleKill() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this._dialog = {
      type: "confirm",
      prompt: `Kill agent ${agent.id}? (y/n)`,
      onYes: () => {
        this._dialog = null;
        this.executeAndRefresh(async () => {
          const result = await killAgent(agent);
          this.showMessage(result.ok ? `Killed ${agent.id}` : `Kill failed: ${result.stderr || result.stdout}`);
        });
      },
    };
    this.tui?.requestRender();
  }

  private handleNuke() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this._dialog = {
      type: "confirm",
      prompt: `${RED}FORCE KILL ${agent.id}? This cannot be undone. (y/n)${RESET}`,
      onYes: () => {
        this._dialog = null;
        this.executeAndRefresh(async () => {
          const result = await nukeAgent(agent);
          this.showMessage(result.ok ? `Nuked ${agent.id}` : `Nuke failed: ${result.stderr || result.stdout}`);
        });
      },
    };
    this.tui?.requestRender();
  }

  private handleResume() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    if (agent.state !== "stopped" && agent.state !== "complete") {
      this.showMessage("Can only resume stopped or complete agents");
      return;
    }
    this.executeAndRefresh(async () => {
      const result = await resumeAgent(agent);
      this.showMessage(result.ok ? `Resumed ${agent.id}` : `Resume failed: ${result.stderr || result.stdout}`);
    });
  }

  private handleReassign() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this._dialog = {
      type: "input",
      prompt: `Reassign ${agent.id} to manager:`,
      value: "",
      onSubmit: (newManager: string) => {
        this._dialog = null;
        if (!newManager.trim()) {
          this.showMessage("Reassign cancelled");
          return;
        }
        this.executeAndRefresh(async () => {
          const result = await reassignAgent(agent, newManager.trim());
          this.showMessage(result.ok ? `Reassigned ${agent.id} → ${newManager.trim()}` : `Reassign failed: ${result.stderr || result.stdout}`);
        });
      },
    };
    this.tui?.requestRender();
  }

  private handleMerge() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this.showMessage(`Running merge-check for ${agent.id}...`);
    mergeCheckAgent(agent).then((checkResult) => {
      const checkOutput = checkResult.stdout || checkResult.stderr || "(no output)";
      if (!checkResult.ok) {
        this.showMessage(`Merge-check failed for ${agent.id}: ${checkOutput}`);
        return;
      }
      this._dialog = {
        type: "confirm",
        prompt: `Merge ${agent.id}?\n${checkOutput}\n(y/n)`,
        onYes: () => {
          this._dialog = null;
          this.executeAndRefresh(async () => {
            const result = await mergeAgent(agent);
            this.showMessage(result.ok ? `Merged ${agent.id}` : `Merge failed: ${result.stderr || result.stdout}`);
          });
        },
      };
      this.tui?.requestRender();
    }).catch((err) => {
      this.showMessage(`Merge-check error: ${err}`);
    });
  }

  private handleSend() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    this._dialog = {
      type: "input",
      prompt: `Send message to ${agent.id}:`,
      value: "",
      onSubmit: (message: string) => {
        this._dialog = null;
        if (!message.trim()) {
          this.showMessage("Send cancelled");
          return;
        }
        this.executeAndRefresh(async () => {
          const result = await sendMessage(agent, message.trim());
          this.showMessage(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
        });
      },
    };
    this.tui?.requestRender();
  }

  private handleNewAgent() {
    if (this.repos.length === 0) {
      this.showMessage("No repos registered");
      return;
    }
    // Single-repo shortcut: skip repo selection
    if (this.repos.length === 1) {
      this.showNewAgentPromptDialog(this.repos[0]!);
      return;
    }
    // Step 1: select repo
    this._dialog = {
      type: "select",
      prompt: "Select repo for new agent:",
      items: this.repos.map((r) => `${r.name} (${r.path})`),
      selectedIndex: 0,
      onSelect: (repoIndex: number) => {
        this.showNewAgentPromptDialog(this.repos[repoIndex]!);
      },
    };
    this.tui?.requestRender();
  }

  private showNewAgentPromptDialog(repo: RepoEntry) {
    this._dialog = {
      type: "input",
      prompt: `New agent prompt (repo: ${repo.name}):`,
      value: "",
      onSubmit: (prompt: string) => {
        if (!prompt.trim()) {
          this._dialog = null;
          this.showMessage("New agent cancelled");
          return;
        }
        this.showNewAgentFlagsDialog(repo, prompt.trim());
      },
    };
    this.tui?.requestRender();
  }

  private showNewAgentFlagsDialog(repo: RepoEntry, prompt: string) {
    this._dialog = {
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
        this._dialog = null;
        const opts: NewAgentOptions = {};
        if (flagIndex === 1 || flagIndex === 3) opts.worker = true;
        if (flagIndex === 2 || flagIndex === 3) opts.yolo = true;
        this.executeAndRefresh(async () => {
          const result = await newAgent(repo.path, prompt, opts);
          this.showMessage(result.ok ? `Created new agent in ${repo.name}` : `New agent failed: ${result.stderr || result.stdout}`);
        });
      },
    };
    this.tui?.requestRender();
  }

  private handleAnswerQuestion() {
    const questions = this.rightPane.questions;
    const idx = this.rightPane.questionsSelectedIndex;
    if (idx < 0 || idx >= questions.length) return;
    const q = questions[idx]!;
    // Find the agent for this question to get repoPath
    const agentEntry = this.agentTree.flatList.find((f) => f.agent.id === q.agent);
    if (!agentEntry) {
      this.showMessage(`Agent ${q.agent} not found`);
      return;
    }
    this._dialog = {
      type: "input",
      prompt: `Answer ${q.agent}'s question:`,
      value: "",
      onSubmit: (answer: string) => {
        this._dialog = null;
        if (!answer.trim()) {
          this.showMessage("Answer cancelled");
          return;
        }
        this.executeAndRefresh(async () => {
          const ackResult = await acknowledgeQuestion(agentEntry.agent.repoPath, q.id);
          if (!ackResult.ok) {
            this.showMessage(`Acknowledge failed: ${ackResult.stderr || ackResult.stdout}`);
            return;
          }
          const sendResult = await sendMessage(agentEntry.agent, answer.trim());
          this.showMessage(sendResult.ok ? `Answered ${q.agent}` : `Send failed: ${sendResult.stderr || sendResult.stdout}`);
        });
      },
    };
    this.tui?.requestRender();
  }

  private handleAcknowledgeQuestion() {
    const questions = this.rightPane.questions;
    const idx = this.rightPane.questionsSelectedIndex;
    if (idx < 0 || idx >= questions.length) return;
    const q = questions[idx]!;
    const agentEntry = this.agentTree.flatList.find((f) => f.agent.id === q.agent);
    if (!agentEntry) {
      this.showMessage(`Agent ${q.agent} not found`);
      return;
    }
    this.executeAndRefresh(async () => {
      const result = await acknowledgeQuestion(agentEntry.agent.repoPath, q.id);
      this.showMessage(result.ok ? `Acknowledged ${q.id}` : `Acknowledge failed: ${result.stderr || result.stdout}`);
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
      this.showMessage(`Agent ${q.agent} not found in tree`);
    }
  }

  private handleDialogInput(data: string): boolean {
    if (!this._dialog) return false;

    if (this._dialog.type === "message") {
      // Any key dismisses message
      this._dialog = null;
      this.tui?.requestRender();
      return true;
    }

    // Escape cancels any dialog
    if (matchesKey(data, Key.escape)) {
      this._dialog = null;
      this.tui?.requestRender();
      return true;
    }

    if (this._dialog.type === "confirm") {
      if (data === "y" || data === "Y") {
        this._dialog.onYes();
      } else if (data === "n" || data === "N") {
        this._dialog = null;
        this.tui?.requestRender();
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

    return false;
  }

  onUpdate(agents: Agent[], flatList: FlatAgent[], questions: PendingQuestion[]) {
    this.agentTree.flatList = flatList;
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
    this.tmuxPane.agent = selected;

    // If agent changed, reset tmux pane state and reload agent data
    const newId = selected?.id ?? null;
    if (newId !== this.currentAgentId) {
      this.currentAgentId = newId;
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

    // Update tmux poller target
    this.tmuxPoller.setAgent(selected?.meta.tmux_session ?? null);
  }

  private async loadAgentLog(agent: Agent) {
    const content = await readAgentLog(agent);
    // Only apply if we're still looking at the same agent
    if (this.currentAgentId === agent.id) {
      this.rightPane.agentLogContent = content;
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

  private async loadDiff(agent: Agent) {
    if (this.rightPane.diffLoading) return;
    this.rightPane.diffLoading = true;
    this.rightPane.updateContent();
    this.tui?.requestRender();
    try {
      const result = await diffAgent(agent);
      if (this.currentAgentId === agent.id) {
        const output = result.stdout || result.stderr || "(no output)";
        this.rightPane.diffContent = output.split("\n");
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

  private async loadStatus(agent: Agent) {
    if (this.rightPane.statusLoading) return;
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
    this.modeIndex = (this.modeIndex + PANE_MODES.length + delta) % PANE_MODES.length;
    this.rightPane.setMode(PANE_MODES[this.modeIndex]!);
    this.statusBar.currentMode = PANE_MODES[this.modeIndex]!;
    this.statusBar.modeIndex = this.modeIndex;
    this.triggerAsyncLoadIfNeeded();
  }

  private jumpToMode(mode: PaneMode) {
    const idx = PANE_MODES.indexOf(mode);
    if (idx !== -1) {
      this.modeIndex = idx;
      this.rightPane.setMode(mode);
      this.statusBar.currentMode = mode;
      this.statusBar.modeIndex = idx;
      this.triggerAsyncLoadIfNeeded();
    }
  }

  /** Trigger async loading for modes that need it */
  private triggerAsyncLoadIfNeeded() {
    const agent = this.agentTree.selectedAgent;
    if (!agent) return;
    const mode = PANE_MODES[this.modeIndex]!;
    if (mode === "DIFF" && !this.rightPane.diffContent && !this.rightPane.diffLoading) {
      this.loadDiff(agent);
    } else if (mode === "STATUS" && !this.rightPane.statusContent && !this.rightPane.statusLoading) {
      this.loadStatus(agent);
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
    // Direct pane jumps
    else if (data === "d") {
      this.jumpToMode("DIFF");
      this.tui?.requestRender();
    } else if (data === "g") {
      if (this.rightPane.mode === "QUESTIONS") {
        this.handleGoToQuestionAgent();
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
    // Toggle archived agents
    else if (data === "A") {
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
    const bottomHeight = this._dialog ? this.dialogHeight() : 2;
    const separatorHeight = 1; // bottom separator before status
    const usedHeight = lines.length + separatorHeight + bottomHeight;
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

    // Dialog or status bar
    if (this._dialog) {
      const dialogLines = this.renderDialog(width);
      lines.push(...dialogLines);
    } else {
      const statusLines = this.statusBar.render(width);
      lines.push(...statusLines);
    }

    return lines;
  }

  private dialogHeight(): number {
    if (!this._dialog) return 2;
    if (this._dialog.type === "confirm") {
      const maxLines = 8;
      const promptLines = this._dialog.prompt.split("\n").length;
      const capped = Math.min(promptLines, maxLines) + (promptLines > maxLines ? 1 : 0);
      return Math.max(2, capped);
    }
    return 2; // message, input, select all use 2 lines
  }

  private renderDialog(width: number): string[] {
    if (!this._dialog) return [];

    if (this._dialog.type === "message") {
      return [
        truncateToWidth(`${YELLOW}${this._dialog.text}${RESET}`, width, ""),
        truncateToWidth(`${DIM}Press any key to dismiss${RESET}`, width, ""),
      ];
    }

    if (this._dialog.type === "confirm") {
      const promptLines = this._dialog.prompt.split("\n");
      const maxLines = 8; // Cap to avoid overflowing the terminal
      const lines: string[] = [];
      for (const pl of promptLines.slice(0, maxLines)) {
        lines.push(truncateToWidth(`${BOLD}${pl}${RESET}`, width, ""));
      }
      if (promptLines.length > maxLines) {
        lines.push(truncateToWidth(`${DIM}... ${promptLines.length - maxLines} more lines${RESET}`, width, ""));
      }
      // Ensure at least 2 lines
      while (lines.length < 2) lines.push("");
      return lines;
    }

    if (this._dialog.type === "input") {
      return [
        truncateToWidth(`${BOLD}${this._dialog.prompt}${RESET}`, width, ""),
        truncateToWidth(`> ${this._dialog.value}█`, width, ""),
      ];
    }

    if (this._dialog.type === "select") {
      const sel = this._dialog.selectedIndex;
      const lines: string[] = [
        truncateToWidth(`${BOLD}${this._dialog.prompt}${RESET} ${DIM}(j/k, Enter, Esc)${RESET}`, width, ""),
      ];
      const itemStrs = this._dialog.items.map((item, i) => {
        const prefix = i === sel ? `${GREEN}> ` : "  ";
        const suffix = i === sel ? RESET : "";
        return `${prefix}${item}${suffix}`;
      });
      lines.push(truncateToWidth(itemStrs.join("  |  "), width, ""));
      return lines;
    }

    return ["", ""];
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
  dashboard.setRepos(repos);
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

  tui.start();
  dashboard.startPolling();
  await watcher.start();
}
