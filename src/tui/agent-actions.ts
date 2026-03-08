/**
 * Agent action handlers — extracted from DashboardComponent.
 * Each function takes a context object that provides access to dashboard state.
 */

import { visibleWidth } from "@mariozechner/pi-tui";
import { stat } from "node:fs/promises";
import type { Agent, FlatAgent, PendingQuestion } from "../agents";
import type { RepoEntry } from "../registry";
import { addRepo } from "../registry";
import {
  killAgent, nukeAgent, resumeAgent, pauseAgent, reassignAgent,
  mergeCheckAgent, mergeAgent, sendMessage, newAgent, diffAgent,
  acknowledgeQuestion,
} from "../ib-commands";
import type { NewAgentOptions } from "../ib-commands";
import { captureTmuxOutput, resizeTmuxWindow } from "../tmux-poller";
import { stripAnsi, parseState } from "../parse-state";
import { openInGhostty } from "../ghostty";
import { buildFolderItems } from "./folder-browser";
import type { DialogState } from "./dialog-handler";
import { fuzzyFilterIndices } from "./dialog-handler";
import { displayState, computeStateColWidth, AGE_COL_WIDTH } from "./agent-tree";
import type { PaneMode } from "./pane-manager";

// ANSI escape constants
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

const SCROLL_STEP = 10;

/** Context interface — DashboardComponent satisfies this structurally */
export interface ActionCtx {
  agentTree: {
    selectedAgent: Agent | null;
    selectedRepoHeader: string | null;
    flatList: FlatAgent[];
    visibleList: FlatAgent[];
    selectAgentById(id: string): boolean;
  };
  rightPane: {
    mode: PaneMode;
    filteredQuestions: PendingQuestion[];
    questionsSelectedIndex: number;
    scrollOffset: number;
    errors: string[];
    updateContent(): void;
  };
  tmuxPane: { scrollUp(n?: number): void; scrollDown(n?: number): void };
  splitPane: { getLeftWidth(): number; setLeftWidth(w: number): void };
  tui: { requestRender(): void } | null;
  repos: RepoEntry[];
  watcher: { refresh(): void } | null;
  diffTool: string | undefined;
  pendingSelectNewestInRepo: string | null;
  showDialog(dialog: NonNullable<DialogState>): void;
  closeDialog(): void;
  setNotice(text: string): void;
  executeAndRefresh(fn: () => Promise<void>): Promise<void>;
  syncSelectedAgent(): void;
  jumpToMode(mode: PaneMode, forceRefresh?: boolean): void;
  setQuestionsFocused(value: boolean): void;
}

export function handleKill(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  ctx.showDialog({
    type: "confirm",
    prompt: `Kill agent ${agent.id}?`,
    confirmLabel: "Kill",
    focusedButton: "cancel",
    confirmColor: RED,
    onYes: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        const result = await killAgent(agent);
        ctx.setNotice(result.ok ? `Killed ${agent.id}` : `Kill failed: ${result.stderr || result.stdout}`);
      });
    },
  });
}

export function handleNuke(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  ctx.showDialog({
    type: "confirm",
    prompt: `${RED}FORCE KILL ${agent.id}? This cannot be undone.${RESET}`,
    confirmLabel: "Nuke",
    focusedButton: "confirm",
    onYes: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        const result = await nukeAgent(agent);
        ctx.setNotice(result.ok ? `Nuked ${agent.id}` : `Nuke failed: ${result.stderr || result.stdout}`);
      });
    },
  });
}

export function handleResume(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  if (agent.state !== "stopped" && agent.state !== "complete") {
    ctx.setNotice("Can only resume stopped or complete agents");
    return;
  }
  ctx.executeAndRefresh(async () => {
    const result = await resumeAgent(agent);
    ctx.setNotice(result.ok ? `Resumed ${agent.id}` : `Resume failed: ${result.stderr || result.stdout}`);
  });
}

export function handlePause(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  if (agent.state === "stopped" || agent.state === "complete" || agent.archived) {
    ctx.setNotice("Can only pause running or waiting agents");
    return;
  }
  ctx.showDialog({
    type: "confirm",
    prompt: `Pause agent ${agent.id}?`,
    confirmLabel: "Pause",
    focusedButton: "cancel",
    onYes: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        const result = await pauseAgent(agent);
        ctx.setNotice(result.ok ? `Paused ${agent.id}` : `Pause failed: ${result.stderr || result.stdout}`);
      });
    },
  });
}

export function handleReassign(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  ctx.showDialog({
    type: "input",
    prompt: `Reassign ${agent.id} to manager:`,
    value: "",
    onSubmit: (newManager: string) => {
      ctx.closeDialog();
      if (!newManager.trim()) { ctx.setNotice("Reassign cancelled"); return; }
      ctx.executeAndRefresh(async () => {
        const result = await reassignAgent(agent, newManager.trim());
        ctx.setNotice(result.ok ? `Reassigned ${agent.id} → ${newManager.trim()}` : `Reassign failed: ${result.stderr || result.stdout}`);
      });
    },
  });
}

export function handleMerge(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  ctx.setNotice(`Running merge-check for ${agent.id}...`);
  mergeCheckAgent(agent).then((checkResult) => {
    const checkOutput = checkResult.stdout || checkResult.stderr || "(no output)";
    if (!checkResult.ok) {
      ctx.setNotice(`Merge-check failed for ${agent.id}: ${checkOutput}`);
      return;
    }
    ctx.showDialog({
      type: "confirm",
      prompt: `Merge ${agent.id}?\n${checkOutput}`,
      confirmLabel: "Merge",
      focusedButton: "confirm",
      onYes: () => {
        ctx.closeDialog();
        ctx.executeAndRefresh(async () => {
          const result = await mergeAgent(agent);
          ctx.setNotice(result.ok ? `Merged ${agent.id}` : `Merge failed: ${result.stderr || result.stdout}`);
        });
      },
    });
  }).catch((err) => {
    ctx.setNotice(`Merge-check error: ${err}`);
  });
}

export function handleSend(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  ctx.showDialog({
    type: "textarea",
    prompt: `Send message to ${agent.id}:`,
    lines: [""],
    focusedButton: "text",
    onSubmit: (message: string) => {
      ctx.closeDialog();
      if (!message.trim()) { ctx.setNotice("Send cancelled"); return; }
      ctx.executeAndRefresh(async () => {
        const result = await sendMessage(agent, message.trim());
        ctx.setNotice(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
      });
    },
  });
}

/** 'a' — always show repo picker (when >1 repo) */
export function handleNewAgent(ctx: ActionCtx) {
  if (ctx.repos.length === 0) { ctx.setNotice("No repos registered"); return; }
  if (ctx.repos.length === 1) { showNewAgentFormDialog(ctx, ctx.repos[0]!); return; }
  showRepoPicker(ctx);
}

/** 'A' — skip picker, infer repo from current selection */
export function handleNewAgentInCurrentRepo(ctx: ActionCtx) {
  if (ctx.repos.length === 0) { ctx.setNotice("No repos registered"); return; }
  if (ctx.repos.length === 1) { showNewAgentFormDialog(ctx, ctx.repos[0]!); return; }
  const selectedAgent = ctx.agentTree.selectedAgent;
  const selectedRepoHeader = ctx.agentTree.selectedRepoHeader;
  if (selectedAgent) {
    const repo = ctx.repos.find((r) => r.path === selectedAgent.repoPath);
    if (repo) { showNewAgentFormDialog(ctx, repo); return; }
  } else if (selectedRepoHeader) {
    const repo = ctx.repos.find((r) => r.name === selectedRepoHeader);
    if (repo) { showNewAgentFormDialog(ctx, repo); return; }
  }
  showRepoPicker(ctx);
}

function showRepoPicker(ctx: ActionCtx) {
  ctx.showDialog({
    type: "select",
    prompt: "Select repo for new agent:",
    items: ctx.repos.map((r) => `${r.name} (${r.path})`),
    selectedIndex: 0,
    onSelect: (repoIndex: number) => {
      showNewAgentFormDialog(ctx, ctx.repos[repoIndex]!);
    },
  });
}

function showNewAgentFormDialog(ctx: ActionCtx, repo: RepoEntry) {
  // Auto-set manager to the currently selected agent (if any, and in same repo)
  const selected = ctx.agentTree.selectedAgent;
  const managerId = selected && selected.repoPath === repo.path ? selected.id : undefined;
  ctx.showDialog({
    type: "new-agent-form",
    repoName: repo.name,
    name: "",
    worker: false,
    lines: [""],
    focused: "name",
    onSubmit: (name: string, worker: boolean, prompt: string) => {
      ctx.closeDialog();
      const opts: NewAgentOptions = {};
      if (name.trim()) opts.name = name.trim();
      if (worker) opts.worker = true;
      if (managerId) opts.manager = managerId;
      ctx.executeAndRefresh(async () => {
        const result = await newAgent(repo.path, prompt, opts);
        if (result.ok) {
          ctx.pendingSelectNewestInRepo = repo.path;
          ctx.setNotice(`Created new agent in ${repo.name}`);
        } else {
          ctx.setNotice(`New agent failed: ${result.stderr || result.stdout}`);
        }
      });
    },
  });
}

export function handleAnswerQuestion(ctx: ActionCtx) {
  const questions = ctx.rightPane.filteredQuestions;
  const idx = ctx.rightPane.questionsSelectedIndex;
  if (idx < 0 || idx >= questions.length) return;
  const q = questions[idx]!;
  const agentEntry = ctx.agentTree.flatList.find((f) => f.agent.id === q.agent);
  if (!agentEntry) { ctx.setNotice(`Agent ${q.agent} not found`); return; }
  ctx.showDialog({
    type: "textarea",
    prompt: `Answer ${q.agent}'s question:`,
    lines: [""],
    focusedButton: "text",
    onSubmit: (answer: string) => {
      ctx.closeDialog();
      if (!answer.trim()) { ctx.setNotice("Answer cancelled"); return; }
      ctx.executeAndRefresh(async () => {
        const ackResult = await acknowledgeQuestion(agentEntry.agent.repoPath, q.id);
        if (!ackResult.ok) { ctx.setNotice(`Acknowledge failed: ${ackResult.stderr || ackResult.stdout}`); return; }
        const sendResult = await sendMessage(agentEntry.agent, answer.trim());
        ctx.setNotice(sendResult.ok ? `Answered ${q.agent}` : `Send failed: ${sendResult.stderr || sendResult.stdout}`);
      });
    },
  });
}

export function handleAcknowledgeQuestion(ctx: ActionCtx) {
  const questions = ctx.rightPane.filteredQuestions;
  const idx = ctx.rightPane.questionsSelectedIndex;
  if (idx < 0 || idx >= questions.length) return;
  const q = questions[idx]!;
  const agentEntry = ctx.agentTree.flatList.find((f) => f.agent.id === q.agent);
  if (!agentEntry) { ctx.setNotice(`Agent ${q.agent} not found`); return; }
  ctx.executeAndRefresh(async () => {
    const result = await acknowledgeQuestion(agentEntry.agent.repoPath, q.id);
    ctx.setNotice(result.ok ? `Acknowledged ${q.id}` : `Acknowledge failed: ${result.stderr || result.stdout}`);
  });
}

export function handleGoToQuestionAgent(ctx: ActionCtx) {
  const questions = ctx.rightPane.filteredQuestions;
  const idx = ctx.rightPane.questionsSelectedIndex;
  if (idx < 0 || idx >= questions.length) return;
  const q = questions[idx]!;
  if (ctx.agentTree.selectAgentById(q.agent)) {
    ctx.syncSelectedAgent();
    ctx.jumpToMode("AGENT LOG");
    ctx.tui?.requestRender();
  } else {
    ctx.setNotice(`Agent ${q.agent} not found in tree`);
  }
}

export function handleFuzzyAgent(ctx: ActionCtx) {
  const visible = ctx.agentTree.visibleList;
  if (visible.length === 0) { ctx.setNotice("No agents to search"); return; }
  const fuzzyStateColWidth = computeStateColWidth(visible);
  const allItems = visible.map((f) => {
    const promptText = f.agent.meta.prompt.replace(/\n/g, " ");
    const state = displayState(f.agent.state);
    return `${f.agent.repoName}/${f.agent.id}  ${state.padEnd(fuzzyStateColWidth)}  ${f.agent.age.padStart(AGE_COL_WIDTH)}  ${promptText}`;
  });
  ctx.showDialog({
    type: "fuzzy",
    prompt: "Jump to agent",
    query: "",
    allItems,
    filteredIndices: allItems.map((_, i) => i),
    filteredItems: [...allItems],
    selectedIndex: 0,
    onSelect: (originalIndex: number) => {
      ctx.closeDialog();
      const agent = visible[originalIndex]!;
      ctx.agentTree.selectAgentById(agent.agent.id);
      ctx.syncSelectedAgent();
      ctx.jumpToMode("AGENT LOG");
      ctx.tui?.requestRender();
    },
  });
}

export function handleScrollUp(ctx: ActionCtx) {
  ctx.tmuxPane.scrollUp(SCROLL_STEP);
  ctx.rightPane.scrollOffset += SCROLL_STEP;
  ctx.rightPane.updateContent();
  ctx.tui?.requestRender();
}

export function handleScrollDown(ctx: ActionCtx) {
  ctx.tmuxPane.scrollDown(SCROLL_STEP);
  ctx.rightPane.scrollOffset = Math.max(0, ctx.rightPane.scrollOffset - SCROLL_STEP);
  ctx.rightPane.updateContent();
  ctx.tui?.requestRender();
}

export function handleOpenWorktree(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) { ctx.setNotice("No agent selected"); return; }
  const dir = agent.archived ? "archive" : "agents";
  let worktreePath: string;
  if (agent.meta.worktree === false) {
    worktreePath = agent.repoPath;
  } else {
    worktreePath = `${agent.repoPath}/.ittybitty/${dir}/${agent.id}/repo`;
  }
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
      ctx.setNotice(`Opened ${pathToOpen}`);
    } catch (err) {
      ctx.setNotice(`Failed to open worktree: ${err}`);
    }
  })();
}

export function handleOpenDiffTool(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) { ctx.setNotice("No agent selected"); return; }
  if (!ctx.diffTool) { ctx.setNotice("No diff tool configured — set diffTool in ~/.itsybitsy.json"); return; }
  const tool = ctx.diffTool;
  ctx.setNotice("Loading diff...");
  diffAgent(agent).then(async (result) => {
    try {
      const output = result.stdout || result.stderr || "(no output)";
      const tmpPath = `/tmp/itsybitsy-diff-${agent.id}.txt`;
      await Bun.write(tmpPath, output);
      // Pass both tool and path as positional params to handle spaces safely
      Bun.spawn(["bash", "-c", '"$1" "$2"', "--", tool, tmpPath], { cwd: agent.repoPath });
      ctx.setNotice(`Opened diff in ${tool}`);
    } catch (err) {
      ctx.setNotice(`Failed to open diff: ${err}`);
    }
  }).catch((err) => {
    ctx.setNotice(`Diff error: ${err}`);
  });
}

export function handleHelp(ctx: ActionCtx) {
  const pad = (key: string, w: number) => key + " ".repeat(Math.max(0, w - key.length));
  const kw = 18;
  const row = (key: string, desc: string) => `  ${BOLD}${pad(key, kw)}${RESET}${desc}`;
  const header = (title: string) => `${BOLD}${title}${RESET}`;
  ctx.showDialog({
    type: "help",
    lines: [
      header("Navigation"),
      row("j / k / ↑↓", "select agent"),
      row("@", "fuzzy jump to agent"),
      row("/", "fuzzy mode picker"),
      row("+", "add repo folder"),
      "",
      header("Panes"),
      row("p / n / ←→", "cycle pane left/right"),
      row("[ / ]", "resize left pane"),
      row("d / g / e / q", "diff / status / errors / questions"),
      "",
      header("Scroll"),
      row(";", "scroll up"),
      row("l", "scroll down"),
      "",
      header("Actions"),
      row("s", "send message"),
      row("m", "merge"),
      row("x / !", "kill / nuke"),
      row("R", "resume"),
      row("r", "reassign"),
      row("a / A", "new agent (pick repo / current repo)"),
      "",
      header("Open"),
      row("w", "worktree"),
      row("o", "diff tool"),
      row("G", "Ghostty"),
      row("S", "snapshot"),
      "",
      header("App"),
      row("h", "help"),
      row("Ctrl-C", "quit"),
      "",
      `${DIM}Press any key to dismiss${RESET}`,
    ],
  });
}

export function handleResizeLeft(ctx: ActionCtx, delta: number) {
  const MIN_LEFT_WIDTH = 40;
  const MAX_LEFT_WIDTH = 160;
  const current = ctx.splitPane.getLeftWidth();
  const newWidth = Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, current + delta));
  if (newWidth === current) return;
  ctx.splitPane.setLeftWidth(newWidth);
  const agent = ctx.agentTree.selectedAgent;
  if (agent?.meta.tmux_session) {
    resizeTmuxWindow(agent.meta.tmux_session, newWidth);
  }
  ctx.tui?.requestRender();
}

export function handleOpenGhostty(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) { ctx.setNotice("No agent selected"); return; }
  if (!agent.meta.tmux_session) { ctx.setNotice("No active tmux session"); return; }
  const session = agent.meta.tmux_session;
  openInGhostty(session).then((result) => {
    ctx.setNotice(result.message);
  }).catch((err) => {
    ctx.setNotice(`Ghostty error: ${err}`);
  });
}

export function handleSnapshot(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) { ctx.setNotice("No agent selected"); return; }
  captureTmuxOutput(agent.meta.tmux_session).then(async (rawOutput) => {
    try {
      if (!rawOutput) { ctx.setNotice("No tmux output captured"); return; }
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
      ctx.setNotice(`Snapshot saved: ${filename} (state: ${result.state})`);
    } catch (err) {
      ctx.setNotice(`Snapshot error: ${err}`);
    }
  }).catch((err) => {
    ctx.setNotice(`Snapshot error: ${err}`);
  });
}

export async function handleFolderBrowser(ctx: ActionCtx) {
  const startPath = process.cwd();
  const items = await buildFolderItems(startPath);
  const currentIdx = items.findIndex((i) => i.isCurrent);
  ctx.showDialog({
    type: "folder-browser",
    currentPath: startPath,
    items,
    selectedIndex: currentIdx !== -1 ? currentIdx : 0,
    focused: "list",
    scrollOffset: Math.max(0, (currentIdx !== -1 ? currentIdx : 0) - 7),
    onSelect: (path: string) => {
      addRepo(path).then((result) => {
        ctx.setNotice(result.message);
        if (result.ok) { ctx.watcher?.refresh(); }
      }).catch((err) => {
        ctx.setNotice(`Error adding repo: ${err}`);
      });
    },
  });
}
