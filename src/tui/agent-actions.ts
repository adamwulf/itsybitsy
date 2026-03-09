/**
 * Agent action handlers — extracted from DashboardComponent.
 * Each function takes a context object that provides access to dashboard state.
 */

import { stat } from "node:fs/promises";
import type { Agent, FlatAgent, PendingQuestion } from "../agents";
import type { RepoEntry } from "../registry";
import { addRepo, loadRegistry, saveRegistry, renameRepo, removeRepo, repoDisplayName } from "../registry";
import {
  killAgent, nukeAgent, nukeAllAgents, resumeAgent, pauseAgent, reassignAgent,
  mergeCheckAgent, mergeAgent, sendMessage, newAgent,
  acknowledgeQuestion, hooksStatus, interceptHooksStatus,
  installSafetyHooks, uninstallSafetyHooks,
  installInterceptHook, uninstallInterceptHook,
} from "../ib-commands";
import type { NewAgentOptions } from "../ib-commands";
import { captureTmuxOutput, resizeTmuxWindow, killTmuxSession } from "../tmux-poller";
import { parseState } from "../parse-state";
import { openInGhostty } from "../ghostty";
import { buildFolderItems } from "./folder-browser";
import type { DialogState, SetupItem, ConfigDialogItem } from "./dialog-handler";
import { readConfig, writeConfig, CONFIG_KEYS, projectConfigPath, defaultUserConfigPath } from "../config";
import type { ConfigResult } from "../config";
import { fuzzyFilterIndices } from "./dialog-handler";
import { displayState, computeStateColWidth, AGE_COL_WIDTH } from "./agent-tree";
import type { PaneMode } from "./pane-manager";

// ANSI escape constants
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";

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
    orphanedTmuxSessions: string[];
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
  if (!agent) {
    // No agent selected — offer nuke-all (emergency stop for entire repo)
    handleNukeAll(ctx);
    return;
  }
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

export function handleNukeAll(ctx: ActionCtx) {
  if (ctx.repos.length === 0) { ctx.setNotice("No repos registered"); return; }
  if (ctx.repos.length === 1) {
    const repo = ctx.repos[0]!;
    ctx.showDialog({
      type: "confirm",
      prompt: `${RED}NUKE ALL agents in ${repoDisplayName(repo)}? This cannot be undone.${RESET}`,
      confirmLabel: "Nuke All",
      focusedButton: "cancel",
      confirmColor: RED,
      onYes: () => {
        ctx.closeDialog();
        ctx.executeAndRefresh(async () => {
          const result = await nukeAllAgents(repo.path);
          ctx.setNotice(result.ok ? `Nuked all agents in ${repoDisplayName(repo)}` : `Nuke-all failed: ${result.stderr || result.stdout}`);
        });
      },
    });
    return;
  }
  // Multiple repos — show picker first
  ctx.showDialog({
    type: "select",
    prompt: "Nuke ALL agents in which repo?",
    items: ctx.repos.map((r) => `${repoDisplayName(r)} (${r.path})`),
    selectedIndex: 0,
    onSelect: (repoIndex: number) => {
      const repo = ctx.repos[repoIndex]!;
      ctx.showDialog({
        type: "confirm",
        prompt: `${RED}NUKE ALL agents in ${repoDisplayName(repo)}? This cannot be undone.${RESET}`,
        confirmLabel: "Nuke All",
        focusedButton: "cancel",
        confirmColor: RED,
        onYes: () => {
          ctx.closeDialog();
          ctx.executeAndRefresh(async () => {
            const result = await nukeAllAgents(repo.path);
            ctx.setNotice(result.ok ? `Nuked all agents in ${repoDisplayName(repo)}` : `Nuke-all failed: ${result.stderr || result.stdout}`);
          });
        },
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

/** Collect all descendant IDs of an agent (recursive). */
function getDescendantIds(agent: Agent): Set<string> {
  const ids = new Set<string>();
  function walk(a: Agent) {
    for (const child of a.children) {
      ids.add(child.id);
      walk(child);
    }
  }
  walk(agent);
  return ids;
}

const NO_PARENT_LABEL = "(No parent - make root)";

export function handleReassign(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;

  // Collect all agents in the same repo, excluding:
  // - the agent being reassigned
  // - its descendants (circular dependency prevention)
  // - worker agents (can't be managers)
  // - archived agents
  const descendantIds = getDescendantIds(agent);
  const candidates = ctx.agentTree.flatList
    .filter((f) =>
      f.agent.repoPath === agent.repoPath &&
      f.agent.id !== agent.id &&
      !descendantIds.has(f.agent.id) &&
      !f.agent.meta.worker &&
      !f.agent.archived
    );

  // Build display items: "(No parent)" first, then candidate agents
  const allItems = [
    NO_PARENT_LABEL,
    ...candidates.map((f) => f.agent.id),
  ];

  ctx.showDialog({
    type: "fuzzy",
    prompt: `Reassign ${agent.id} to:`,
    query: "",
    allItems,
    filteredIndices: allItems.map((_, i) => i),
    filteredItems: [...allItems],
    selectedIndex: 0,
    onSelect: (originalIndex: number) => {
      ctx.closeDialog();
      const newManager = originalIndex === 0 ? null : candidates[originalIndex - 1]!.agent.id;
      const desc = newManager ?? "root";
      ctx.executeAndRefresh(async () => {
        const result = await reassignAgent(agent, newManager);
        ctx.setNotice(result.ok ? `Reassigned ${agent.id} → ${desc}` : `Reassign failed: ${result.stderr || result.stdout}`);
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
  const dialog: Extract<NonNullable<DialogState>, { type: "textarea" }> = {
    type: "textarea",
    prompt: `Send message to ${agent.id}:`,
    lines: [""],
    focusedButton: "text",
    sendAll: false,
    onSubmit: (message: string) => {
      ctx.closeDialog();
      if (!message.trim()) { ctx.setNotice("Send cancelled"); return; }
      const trimmed = message.trim();
      if (dialog.sendAll) {
        // Send to all non-archived agents with active tmux sessions
        const targets = ctx.agentTree.flatList.filter(
          (f) => !f.agent.archived && f.agent.meta.tmux_session
        );
        if (targets.length === 0) { ctx.setNotice("No active agents to send to"); return; }
        ctx.executeAndRefresh(async () => {
          let sent = 0;
          let failed = 0;
          for (const f of targets) {
            const result = await sendMessage(f.agent, trimmed);
            if (result.ok) sent++; else failed++;
          }
          const notice = failed > 0
            ? `Sent to ${sent} agents, ${failed} failed`
            : `Sent to ${sent} agents`;
          ctx.setNotice(notice);
        });
      } else {
        ctx.executeAndRefresh(async () => {
          const result = await sendMessage(agent, trimmed);
          ctx.setNotice(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
        });
      }
    },
  };
  ctx.showDialog(dialog);
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
    const repo = ctx.repos.find((r) => repoDisplayName(r) === selectedRepoHeader);
    if (repo) { showNewAgentFormDialog(ctx, repo); return; }
  }
  showRepoPicker(ctx);
}

function showRepoPicker(ctx: ActionCtx) {
  ctx.showDialog({
    type: "select",
    prompt: "Select repo for new agent:",
    items: ctx.repos.map((r) => `${repoDisplayName(r)} (${r.path})`),
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
    repoName: repoDisplayName(repo),
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
          ctx.setNotice(`Created new agent in ${repoDisplayName(repo)}`);
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

  // Determine worktree path (same logic as handleOpenWorktree)
  const dir = agent.archived ? "archive" : "agents";
  let cwd: string;
  if (agent.meta.worktree === false) {
    cwd = agent.repoPath;
  } else {
    cwd = `${agent.repoPath}/.ittybitty/${dir}/${agent.id}/repo`;
  }

  // Run diff tool in the worktree, showing changes since merge-base with main.
  // Tool string is unquoted so multi-word tools (e.g. "git webdiff") are word-split correctly.
  const proc = Bun.spawn(
    ["bash", "-c", '$1 $(git merge-base HEAD main)', "--", tool],
    { cwd, stdout: "ignore", stderr: "pipe" },
  );
  ctx.setNotice(`Opened diff in ${tool}`);

  // Report errors asynchronously, stripping newlines for single-line status bar display
  (async () => {
    try {
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        const msg = (stderr || `exit code ${exitCode}`).split("\n")[0]!.trim();
        ctx.setNotice(`Diff tool error: ${msg}`);
      }
    } catch (err) {
      const msg = String(err).split("\n")[0]!.trim();
      ctx.setNotice(`Diff tool error: ${msg}`);
    }
  })();
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
      row("x / !", "kill / nuke (all if none selected)"),
      row("R", "resume"),
      row("P", "pause"),
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
      row("?", "help"),
      row("h", "setup"),
      row("Ctrl-C", "quit"),
      "",
      `${DIM}Press any key to dismiss${RESET}`,
    ],
  });
}

export function handleSetup(ctx: ActionCtx) {
  // Determine repo path: selected agent's repo, or single repo, or show picker
  if (ctx.repos.length === 0) { ctx.setNotice("No repos registered"); return; }

  if (ctx.repos.length === 1) {
    loadSetupDialog(ctx, ctx.repos[0]!.path).catch((err) => ctx.setNotice(`Setup error: ${err}`));
    return;
  }

  // Try to infer from selected agent
  const selected = ctx.agentTree.selectedAgent;
  if (selected) {
    const repo = ctx.repos.find((r) => r.path === selected.repoPath);
    if (repo) { loadSetupDialog(ctx, repo.path).catch((err) => ctx.setNotice(`Setup error: ${err}`)); return; }
  }

  // Show repo picker
  ctx.showDialog({
    type: "select",
    prompt: "Setup for which repo?",
    items: ctx.repos.map((r) => `${repoDisplayName(r)} (${r.path})`),
    selectedIndex: 0,
    onSelect: (repoIndex: number) => {
      loadSetupDialog(ctx, ctx.repos[repoIndex]!.path).catch((err) => ctx.setNotice(`Setup error: ${err}`));
    },
  });
}

async function checkGitignoreHasIttybitty(repoPath: string): Promise<boolean> {
  try {
    const gitignoreFile = Bun.file(`${repoPath}/.gitignore`);
    if (await gitignoreFile.exists()) {
      const content = await gitignoreFile.text();
      return content.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === ".ittybitty" || trimmed === ".ittybitty/" || trimmed === "/.ittybitty" || trimmed === "/.ittybitty/";
      });
    }
  } catch { /* ignore */ }
  return false;
}

async function toggleGitignore(repoPath: string, currentlyInstalled: boolean): Promise<{ ok: boolean; message: string }> {
  const gitignorePath = `${repoPath}/.gitignore`;
  try {
    if (currentlyInstalled) {
      // Remove .ittybitty from .gitignore
      const file = Bun.file(gitignorePath);
      if (await file.exists()) {
        const content = await file.text();
        const filtered = content.split("\n").filter((line) => {
          const trimmed = line.trim();
          return trimmed !== ".ittybitty" && trimmed !== ".ittybitty/" && trimmed !== "/.ittybitty" && trimmed !== "/.ittybitty/";
        }).join("\n");
        await Bun.write(gitignorePath, filtered);
        return { ok: true, message: ".ittybitty removed from .gitignore" };
      }
      return { ok: true, message: ".gitignore not found" };
    } else {
      // Add .ittybitty/ to .gitignore
      const file = Bun.file(gitignorePath);
      let content = "";
      if (await file.exists()) {
        content = await file.text();
        if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      }
      content += ".ittybitty/\n";
      await Bun.write(gitignorePath, content);
      return { ok: true, message: ".ittybitty/ added to .gitignore" };
    }
  } catch (err) {
    return { ok: false, message: `Failed: ${err}` };
  }
}

async function createDefaultConfigFile(repoPath: string): Promise<{ ok: boolean; message: string }> {
  const configPath = `${repoPath}/.ittybitty.json`;
  try {
    const file = Bun.file(configPath);
    if (await file.exists()) return { ok: true, message: ".ittybitty.json already exists" };
    const defaultConfig = {
      maxAgents: 10,
      model: "sonnet",
      permissions: {
        manager: { allow: [], deny: [] },
        worker: { allow: [], deny: [] },
      },
    };
    await Bun.write(configPath, JSON.stringify(defaultConfig, null, 2) + "\n");
    return { ok: true, message: "Created .ittybitty.json with default settings" };
  } catch (err) {
    return { ok: false, message: `Failed: ${err}` };
  }
}

async function loadSetupDialog(ctx: ActionCtx, repoPath: string, initialTab = 0) {
  // Fetch all statuses in parallel
  const [safetyResult, interceptResult, gitignoreInstalled, configExists] = await Promise.all([
    hooksStatus(repoPath),
    interceptHooksStatus(repoPath),
    checkGitignoreHasIttybitty(repoPath),
    Bun.file(`${repoPath}/.ittybitty.json`).exists().catch(() => false),
  ]);

  const safetyInstalled = safetyResult.ok && (safetyResult.stdout === "installed");
  const interceptInstalled = interceptResult.ok && (interceptResult.stdout === "installed");

  const items: SetupItem[] = [
    {
      label: "Safety hooks",
      description: "Block cd into worktrees + inject status + session context",
      value: safetyInstalled ? "installed" : "not installed",
      actionable: true,
      kind: "safety-hooks",
    },
    {
      label: "Task interception",
      description: "Redirect Task tool calls to spawn ib agents",
      value: interceptInstalled ? "installed" : "not installed",
      actionable: true,
      kind: "intercept-hook",
    },
    {
      label: "Gitignore",
      description: "Add .ittybitty/ to .gitignore",
      value: gitignoreInstalled ? "installed" : "not installed",
      actionable: true,
      kind: "gitignore",
    },
    {
      label: "Config file",
      description: configExists ? ".ittybitty.json exists" : "Create .ittybitty.json",
      value: configExists ? "installed" : "not installed",
      actionable: !configExists,
      kind: "config-file",
    },
    {
      label: "Diff tool",
      description: "Command for 'o' key in diff view",
      value: ctx.diffTool ?? "",
      actionable: true,
      kind: "difftool",
    },
  ];

  // Load config for tabs 1 & 2
  const config = await readConfig(repoPath);

  const buildConfigItems = (): ConfigDialogItem[] => {
    return CONFIG_KEYS.map((def) => {
      const entry = config[def.key]!;
      return {
        key: def.key,
        type: def.type,
        value: entry.value,
        source: entry.source,
        default: def.default,
      };
    });
  };

  const showSetupDialogForTab = (tab: number) => {
    ctx.showDialog({
      type: "setup",
      tab,
      items,
      selectedIndex: 0,
      repoPath,
      configItems: tab > 0 ? buildConfigItems() : undefined,
      configSelectedIndex: tab > 0 ? 0 : undefined,
      onAction: handleSetupItemAction(ctx, repoPath),
      onTabChange: (newTab: number) => {
        showSetupDialogForTab(newTab);
      },
      onConfigAction: tab > 0 ? handleConfigItemAction(ctx, repoPath, tab, config, showSetupDialogForTab) : undefined,
    });
  };

  showSetupDialogForTab(initialTab);
}

function handleSetupItemAction(ctx: ActionCtx, repoPath: string) {
  return (item: SetupItem) => {
    if (item.kind === "safety-hooks") {
      const shouldInstall = item.value !== "installed";
      const fn = shouldInstall ? installSafetyHooks : uninstallSafetyHooks;
      fn(repoPath).then((res) => {
        if (res.ok) {
          item.value = shouldInstall ? "installed" : "not installed";
          ctx.setNotice(`${shouldInstall ? "Installed" : "Uninstalled"} safety hooks`);
        } else {
          ctx.setNotice(`Failed: ${res.stderr || res.stdout}`);
        }
        ctx.tui?.requestRender();
      });
    } else if (item.kind === "intercept-hook") {
      const shouldInstall = item.value !== "installed";
      const fn = shouldInstall ? installInterceptHook : uninstallInterceptHook;
      fn(repoPath).then((res) => {
        if (res.ok) {
          item.value = shouldInstall ? "installed" : "not installed";
          ctx.setNotice(`${shouldInstall ? "Installed" : "Uninstalled"} task interception`);
        } else {
          ctx.setNotice(`Failed: ${res.stderr || res.stdout}`);
        }
        ctx.tui?.requestRender();
      });
    } else if (item.kind === "gitignore") {
      const isInstalled = item.value === "installed";
      toggleGitignore(repoPath, isInstalled).then((result) => {
        if (result.ok) {
          item.value = isInstalled ? "not installed" : "installed";
        }
        ctx.setNotice(result.message);
        ctx.tui?.requestRender();
      });
    } else if (item.kind === "config-file") {
      createDefaultConfigFile(repoPath).then((result) => {
        if (result.ok) {
          item.value = "installed";
          item.actionable = false;
          item.description = ".ittybitty.json exists";
        }
        ctx.setNotice(result.message);
        ctx.tui?.requestRender();
      });
    } else if (item.kind === "difftool") {
      ctx.closeDialog();
      ctx.showDialog({
        type: "input",
        prompt: "Diff tool command:",
        value: ctx.diffTool ?? "",
        onSubmit: (value: string) => {
          ctx.closeDialog();
          const newTool = value.trim() || undefined;
          ctx.diffTool = newTool;
          loadRegistry().then((reg) => {
            reg.diffTool = newTool;
            return saveRegistry(reg);
          }).then(() => {
            ctx.setNotice(newTool ? `Diff tool set to: ${newTool}` : "Diff tool cleared");
          }).catch((err) => {
            ctx.setNotice(`Failed to save: ${err}`);
          });
        },
      });
    }
  };
}

function handleConfigItemAction(
  ctx: ActionCtx,
  repoPath: string,
  tab: number,
  config: ConfigResult,
  showSetupDialogForTab: (tab: number) => void,
) {
  const configFilePath = tab === 1 ? projectConfigPath(repoPath) : defaultUserConfigPath();

  return (item: ConfigDialogItem) => {
    if (item.type === "boolean") {
      // Toggle immediately
      const newValue = !item.value;
      writeConfig(configFilePath, item.key, newValue).then(() => {
        // Update in-memory config and refresh dialog
        config[item.key] = { value: newValue, source: tab === 1 ? "project" : "user" };
        showSetupDialogForTab(tab);
        ctx.setNotice(`${item.key} = ${newValue}`);
      }).catch((err) => {
        ctx.setNotice(`Failed to save: ${err}`);
      });
    } else {
      // Open input dialog
      const currentStr = item.type === "string[]"
        ? (item.value as string[] ?? []).join(", ")
        : String(item.value ?? "");
      ctx.closeDialog();
      ctx.showDialog({
        type: "input",
        prompt: `${item.key} (${item.type}):`,
        value: currentStr,
        onSubmit: (value: string) => {
          ctx.closeDialog();
          let parsed: unknown;
          if (item.type === "number") {
            const num = Number(value);
            if (value.trim() === "" || isNaN(num)) {
              ctx.setNotice("Invalid number");
              return;
            }
            parsed = num;
          } else if (item.type === "string[]") {
            parsed = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          } else {
            parsed = value;
          }
          writeConfig(configFilePath, item.key, parsed).then(() => {
            config[item.key] = { value: parsed, source: tab === 1 ? "project" : "user" };
            ctx.setNotice(`${item.key} updated`);
            // Re-open setup dialog on the same tab
            loadSetupDialog(ctx, repoPath, tab).catch((err) => ctx.setNotice(`Setup error: ${err}`));
          }).catch((err) => {
            ctx.setNotice(`Failed to save: ${err}`);
          });
        },
      });
    }
  };
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
  captureTmuxOutput(agent.meta.tmux_session).then(async (strippedOutput) => {
    try {
      if (!strippedOutput) { ctx.setNotice("No tmux output captured"); return; }
      const result = parseState(strippedOutput);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `snapshot-${timestamp}-${result.state}.txt`;
      const dir = agent.archived ? "archive" : "agents";
      const debugDir = `${agent.repoPath}/.ittybitty/${dir}/${agent.id}/debug-logs`;
      await Bun.$`mkdir -p ${debugDir}`.quiet();
      await Bun.write(
        `${debugDir}/${filename}`,
        `State: ${result.state}\nReason: ${result.reason}\n\n${strippedOutput}`
      );
      ctx.setNotice(`Snapshot saved: ${filename} (state: ${result.state})`);
    } catch (err) {
      ctx.setNotice(`Snapshot error: ${err}`);
    }
  }).catch((err) => {
    ctx.setNotice(`Snapshot error: ${err}`);
  });
}

export function handleKillOrphanedSessions(ctx: ActionCtx) {
  const sessions = ctx.rightPane.orphanedTmuxSessions;
  if (sessions.length === 0) return;
  if (sessions.length === 1) {
    handleKillOrphanedSession(ctx, sessions[0]!);
    return;
  }
  ctx.showDialog({
    type: "select",
    prompt: "Kill orphaned tmux session:",
    items: sessions,
    selectedIndex: 0,
    onSelect: (index: number) => {
      handleKillOrphanedSession(ctx, sessions[index]!);
    },
  });
}

export function handleKillOrphanedSession(ctx: ActionCtx, session: string) {
  ctx.showDialog({
    type: "confirm",
    prompt: `Kill orphaned tmux session "${session}"?`,
    confirmLabel: "Kill",
    focusedButton: "cancel",
    confirmColor: RED,
    onYes: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        const ok = await killTmuxSession(session);
        ctx.setNotice(ok ? `Killed session: ${session}` : `Failed to kill session: ${session}`);
      });
    },
  });
}

/** Find the repo matching the currently selected repo header */
function findRepoByHeader(ctx: ActionCtx): RepoEntry | null {
  const header = ctx.agentTree.selectedRepoHeader;
  if (!header) return null;
  return ctx.repos.find((r) => repoDisplayName(r) === header) ?? null;
}

export function handleRenameRepo(ctx: ActionCtx) {
  const repo = findRepoByHeader(ctx);
  if (!repo) { ctx.setNotice("No repo selected"); return; }
  ctx.showDialog({
    type: "input",
    prompt: `Rename ${repoDisplayName(repo)}:`,
    value: repo.nickname ?? "",
    onSubmit: (value: string) => {
      ctx.closeDialog();
      renameRepo(repo.path, value).then((result) => {
        ctx.setNotice(result.message);
        if (result.ok) {
          // Update in-memory state so the UI reflects the change immediately
          const trimmed = value.trim();
          if (trimmed) { repo.nickname = trimmed; } else { delete repo.nickname; }
          ctx.watcher?.refresh();
        }
      }).catch((err) => {
        ctx.setNotice(`Error renaming: ${err}`);
      });
    },
  });
}

export function handleRemoveRepo(ctx: ActionCtx) {
  const repo = findRepoByHeader(ctx);
  if (!repo) { ctx.setNotice("No repo selected"); return; }
  ctx.showDialog({
    type: "confirm",
    prompt: `Remove ${repoDisplayName(repo)} from registry?\n(${repo.path})`,
    confirmLabel: "Remove",
    focusedButton: "cancel",
    confirmColor: RED,
    onYes: () => {
      ctx.closeDialog();
      removeRepo(repo.path).then((result) => {
        ctx.setNotice(result.message);
        if (result.ok) {
          // Remove from in-memory repos so the UI reflects the change immediately
          const idx = ctx.repos.findIndex((r) => r.path === repo.path);
          if (idx !== -1) { ctx.repos.splice(idx, 1); }
          ctx.watcher?.refresh();
        }
      }).catch((err) => {
        ctx.setNotice(`Error removing: ${err}`);
      });
    },
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
