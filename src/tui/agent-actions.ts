/**
 * Agent action handlers — extracted from DashboardComponent.
 * Each function takes a context object that provides access to dashboard state.
 */

import { existsSync } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { agentWorktreePath } from "../agents";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import type { RepoEntry } from "../registry";
import { addRepo, listRepos, renameRepo, removeRepo, repoDisplayName } from "../registry";
import {
  killAgent, nukeAgent, nukeAllAgents, resumeAgent, pauseAgent, reassignAgent,
  mergeCheckAgent, mergeAgent, sendMessage, newAgent,
  acknowledgeQuestion, hooksStatus, interceptHooksStatus,
  installSafetyHooks, uninstallSafetyHooks,
  installInterceptHook, uninstallInterceptHook,
} from "../ib-commands";
import type { NewAgentOptions, IbCommandResult } from "../ib-commands";
import { captureTmuxOutput, resizeTmuxWindow, killTmuxSession, sendTmuxKeys } from "../tmux-poller";
import { parseState } from "../parse-state";
import { openInGhostty, openPathInGhostty } from "../ghostty";
import { buildFolderItems } from "./folder-browser";
import type { DialogState, SetupItem, ConfigDialogItem } from "./dialog-handler";
import { TextBuffer } from "./text-buffer";
import { readConfig, writeConfig, CONFIG_KEYS, defaultUserConfigPath } from "../config";
import type { ConfigResult } from "../config";
import { fuzzyFilterIndices } from "./dialog-handler";
import { displayState, computeStateColWidth, AGE_COL_WIDTH } from "./agent-tree";
import type { PaneMode } from "./pane-manager";
import { RESET, BOLD, DIM, RED } from "./colors";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";
import type { RepoHealthReport } from "../health-check";
import { getResolvableWarnings, resolveHealthWarnings } from "../health-check";
import { IB_COORDINATOR_SESSION, sanitizeTmuxInput, restartSystemCoordinator, checkCoordinatorExists } from "../coordinator";

const SCROLL_STEP = 10;

/** Track active diff tool process so we can kill it before relaunching */
let activeDiffProc: { proc: ReturnType<typeof Bun.spawn>; agentId: string } | null = null;

let diffToolLaunching = false;

/** Test helpers for activeDiffProc */
export function getActiveDiffProc() { return activeDiffProc; }
export function setActiveDiffProc(v: typeof activeDiffProc) { activeDiffProc = v; }
export function getDiffToolLaunching() { return diffToolLaunching; }
export function setDiffToolLaunching(v: boolean) { diffToolLaunching = v; }

/** Kill any active diff process (used during shutdown to prevent orphans) */
export function killActiveDiffProc() {
  if (activeDiffProc) {
    try { activeDiffProc.proc.kill(); } catch {}
    activeDiffProc = null;
  }
}

/** Context interface — DashboardComponent satisfies this structurally */
export interface ActionCtx {
  agentTree: {
    selectedAgent: Agent | null;
    selectedRepoHeader: string | null;
    isSystemCoordinatorSelected: boolean;
    flatList: FlatEntry[];
    visibleList: FlatEntry[];
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
  coordinatorPane: { scrollUp(n?: number): void; scrollDown(n?: number): void };
  systemDashboard: { scrollUp(n?: number): void; scrollDown(n?: number): void };
  splitPane: { getLeftWidth(): number; setLeftWidth(w: number): void };
  tui: { requestRender(): void } | null;
  repos: RepoEntry[];
  watcher: { refresh(): void; updateRepos(repos: RepoEntry[]): void; recheckHealth(): void; lastAgents: Agent[] } | null;
  diffTool: string | undefined;
  pendingSelectNewestInRepo: string | null;
  showDialog(dialog: NonNullable<DialogState>): void;
  closeDialog(): void;
  setNotice(text: string): void;
  executeAndRefresh(fn: () => Promise<void>): Promise<void>;
  syncSelectedAgent(): void;
  jumpToMode(mode: PaneMode, forceRefresh?: boolean): void;
  setQuestionsFocused(value: boolean): void;
  healthReport: RepoHealthReport | undefined;
  sidebarWidth: number;
  repoCoordinatorSession: string | null;
}

export function handleKill(ctx: ActionCtx) {
  if (ctx.agentTree.isSystemCoordinatorSelected) return;
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
  if (ctx.agentTree.isSystemCoordinatorSelected) return;
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
    focusedButton: "cancel",
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
  // System coordinator: R restarts the coordinator
  if (ctx.agentTree.isSystemCoordinatorSelected) {
    ctx.executeAndRefresh(async () => {
      await restartSystemCoordinator();
      ctx.setNotice("Restarted system coordinator");
    });
    return;
  }

  // Repo header selected: spawn or resume per-repo coordinator
  const repoHeader = ctx.agentTree.selectedRepoHeader;
  if (!ctx.agentTree.selectedAgent && repoHeader) {
    const repo = ctx.repos.find((r) => repoDisplayName(r) === repoHeader);
    if (!repo) return;
    ctx.executeAndRefresh(async () => {
      const coordStatus = await checkCoordinatorExists(repo.path);
      if (coordStatus.exists) {
        // Coordinator exists — find and resume it
        // Coordinators are filtered out of flatList, so search the full agent list
        const agent = (ctx.watcher?.lastAgents ?? [])
          .find(a => a.id === coordStatus.agentId);
        if (agent && (agent.state === "stopped" || agent.state === "complete")) {
          const result = await resumeAgent(agent);
          ctx.setNotice(result.ok ? `Resumed coordinator ${agent.id}` : `Resume failed: ${result.stderr || result.stdout}`);
        } else if (agent) {
          ctx.setNotice(`Coordinator ${agent.id} is already ${agent.state}`);
        } else {
          ctx.setNotice(`Coordinator ${coordStatus.agentId} not found in agent tree`);
        }
      } else {
        // No coordinator — spawn one
        const result = await newAgent(repo.path, "You are the per-repo coordinator. Await instructions.", { coordinator: true });
        ctx.setNotice(result.ok ? `Spawned coordinator ${result.stdout}` : `Spawn failed: ${result.stderr || result.stdout}`);
      }
    });
    return;
  }

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
  if (agent.state === "stopped" || agent.archived) {
    ctx.setNotice("Can only pause running, waiting, or complete agents");
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
  if (ctx.agentTree.isSystemCoordinatorSelected) return;
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;

  // Collect all agents in the same repo, excluding:
  // - the agent being reassigned
  // - its descendants (circular dependency prevention)
  // - worker agents (can't be managers)
  // - archived agents
  const descendantIds = getDescendantIds(agent);
  const candidates = ctx.agentTree.flatList
    .filter((f): f is Extract<FlatEntry, { kind: "agent" }> =>
      f.kind === "agent" &&
      f.agent.repoPath === agent.repoPath &&
      f.agent.id !== agent.id &&
      !descendantIds.has(f.agent.id) &&
      !f.agent.meta.worker && !(f.agent.meta.type === "worker") &&
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
  if (ctx.agentTree.isSystemCoordinatorSelected) return;
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  ctx.setNotice(`Running merge-check for ${agent.id}...`);
  ctx.executeAndRefresh(async () => {
    let checkResult;
    try {
      checkResult = await mergeCheckAgent(agent);
    } catch (err) {
      ctx.setNotice(`Merge-check error: ${err}`);
      return;
    }
    const checkOutput = checkResult.stdout || checkResult.stderr || "(no output)";
    if (!checkResult.ok) {
      ctx.setNotice(`Merge-check failed for ${agent.id}: ${checkOutput}`);
      return;
    }
    ctx.showDialog({
      type: "confirm",
      prompt: `Merge ${agent.id}?\n${checkOutput}`,
      confirmLabel: "Merge",
      focusedButton: "cancel",
      onYes: () => {
        ctx.closeDialog();
        ctx.executeAndRefresh(async () => {
          const result = await mergeAgent(agent, agent.repoPath);
          ctx.setNotice(result.ok ? `Merged ${agent.id}` : `Merge failed: ${result.stderr || result.stdout}`);
        });
      },
    });
  });
}

export function handleSend(ctx: ActionCtx) {
  // System coordinator: send via tmux send-keys with sanitizeTmuxInput
  if (ctx.agentTree.isSystemCoordinatorSelected) {
    handleSendToCoordinator(ctx);
    return;
  }
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  const dialog: Extract<NonNullable<DialogState>, { type: "textarea" }> = {
    type: "textarea",
    prompt: `Send message to ${agent.id}:`,
    buffer: new TextBuffer(),
    focusedButton: "text",
    sendAll: false,
    onSubmit: (message: string) => {
      ctx.closeDialog();
      if (!message.trim()) { ctx.setNotice("Send cancelled"); return; }
      const trimmed = message.trim();
      if (dialog.sendAll) {
        // Send to all non-archived agents with active tmux sessions
        const targets = ctx.agentTree.flatList.filter(
          (f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent" && !f.agent.archived && !!f.agent.meta.tmux_session
        );
        if (targets.length === 0) { ctx.setNotice("No active agents to send to"); return; }
        ctx.executeAndRefresh(async () => {
          let sent = 0;
          let failed = 0;
          for (const f of targets) {
            const result = await sendMessage(f.agent, trimmed, { cwd: "/" });
            if (result.ok) sent++; else failed++;
          }
          const notice = failed > 0
            ? `Sent to ${sent} agents, ${failed} failed`
            : `Sent to ${sent} agents`;
          ctx.setNotice(notice);
        });
      } else {
        ctx.executeAndRefresh(async () => {
          const result = await sendMessage(agent, trimmed, { cwd: "/" });
          ctx.setNotice(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
        });
      }
    },
  };
  ctx.showDialog(dialog);
}

function handleSendToCoordinator(ctx: ActionCtx) {
  ctx.showDialog({
    type: "textarea",
    prompt: "Send message to coordinator:",
    buffer: new TextBuffer(),
    focusedButton: "text",
    onSubmit: (message: string) => {
      ctx.closeDialog();
      if (!message.trim()) { ctx.setNotice("Send cancelled"); return; }
      const sanitized = sanitizeTmuxInput(message.trim());
      ctx.executeAndRefresh(async () => {
        const sendResult = await sendTmuxKeys(IB_COORDINATOR_SESSION, sanitized);
        ctx.setNotice(sendResult ? "Sent to coordinator" : "Failed to send to coordinator");
      });
    },
  });
}

/** 'a' — infer repo from current selection, fallback to first repo */
export function handleNewAgent(ctx: ActionCtx) {
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
  // Fallback to first repo
  showNewAgentFormDialog(ctx, ctx.repos[0]!);
}

function showNewAgentFormDialog(ctx: ActionCtx, repo: RepoEntry) {
  ctx.showDialog({
    type: "new-agent-form",
    repoName: repoDisplayName(repo),
    name: "",
    worker: false,
    buffer: new TextBuffer(),
    focused: "name",
    onSubmit: (name: string, worker: boolean, prompt: string) => {
      ctx.closeDialog();
      const opts: NewAgentOptions = {};
      if (name.trim()) opts.name = name.trim();
      if (worker) opts.worker = true;
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
  const agentEntry = ctx.agentTree.flatList.find((f) => f.kind === "agent" && f.agent.id === q.agent);
  if (!agentEntry || agentEntry.kind !== "agent") { ctx.setNotice(`Agent ${q.agent} not found`); return; }
  ctx.showDialog({
    type: "textarea",
    prompt: `Answer ${q.agent}'s question:`,
    buffer: new TextBuffer(),
    focusedButton: "text",
    onSubmit: (answer: string) => {
      ctx.closeDialog();
      if (!answer.trim()) { ctx.setNotice("Answer cancelled"); return; }
      ctx.executeAndRefresh(async () => {
        const ackResult = await acknowledgeQuestion(agentEntry.agent.repoPath, q.id);
        if (!ackResult.ok) { ctx.setNotice(`Acknowledge failed: ${ackResult.stderr || ackResult.stdout}`); return; }
        const sendResult = await sendMessage(agentEntry.agent, answer.trim(), { cwd: "/" });
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
  const agentEntry = ctx.agentTree.flatList.find((f) => f.kind === "agent" && f.agent.id === q.agent);
  if (!agentEntry || agentEntry.kind !== "agent") { ctx.setNotice(`Agent ${q.agent} not found`); return; }
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
  const agentEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "agent" }> => f.kind === "agent");
  if (agentEntries.length === 0) { ctx.setNotice("No agents to search"); return; }
  const fuzzyStateColWidth = computeStateColWidth(agentEntries);
  const allItems = agentEntries.map((f) => {
    const promptText = (f.agent.meta.summary ?? f.agent.meta.prompt).replace(/\n/g, " ");
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
      const agent = agentEntries[originalIndex]!;
      ctx.agentTree.selectAgentById(agent.agent.id);
      ctx.syncSelectedAgent();
      ctx.jumpToMode("AGENT LOG");
      ctx.tui?.requestRender();
    },
  });
}

export function handleScrollUp(ctx: ActionCtx) {
  ctx.tmuxPane.scrollUp(SCROLL_STEP);
  ctx.coordinatorPane.scrollUp(SCROLL_STEP);
  ctx.rightPane.scrollOffset += SCROLL_STEP;
  ctx.systemDashboard.scrollUp(SCROLL_STEP);
  ctx.rightPane.updateContent();
  ctx.tui?.requestRender();
}

export function handleScrollDown(ctx: ActionCtx) {
  ctx.tmuxPane.scrollDown(SCROLL_STEP);
  ctx.coordinatorPane.scrollDown(SCROLL_STEP);
  ctx.rightPane.scrollOffset = Math.max(0, ctx.rightPane.scrollOffset - SCROLL_STEP);
  ctx.systemDashboard.scrollDown(SCROLL_STEP);
  ctx.rightPane.updateContent();
  ctx.tui?.requestRender();
}

export function handleOpenWorktree(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) {
    const repo = findRepoByHeader(ctx);
    if (repo) {
      (async () => {
        try {
          await Bun.$`open ${repo.path}`.quiet();
          ctx.setNotice(`Opened ${repo.path}`);
        } catch (err) {
          ctx.setNotice(`Failed to open repo: ${err}`);
        }
      })();
    } else {
      ctx.setNotice("No agent selected");
    }
    return;
  }
  const worktreePath = agentWorktreePath(agent);
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

export async function handleOpenDiffTool(ctx: ActionCtx) {
  // Kill previous diff process before doing anything else
  if (activeDiffProc) {
    try { activeDiffProc.proc.kill(); } catch {}
    activeDiffProc = null;
  }

  if (diffToolLaunching) { ctx.setNotice("Diff tool is already launching"); return; }

  const agent = ctx.agentTree.selectedAgent;
  if (!agent) { ctx.setNotice("No agent selected"); return; }
  if (!ctx.diffTool) { ctx.setNotice("No diff tool configured — set externalDiffTool in ~/.itsybitsy/config.json"); return; }
  const tool = ctx.diffTool;

  const cwd = agentWorktreePath(agent);

  if (!existsSync(cwd)) {
    ctx.setNotice("Worktree no longer exists — agent may have been merged");
    return;
  }

  diffToolLaunching = true;

  // Check for empty diff before launching tool
  const mergeBaseProc = Bun.spawn(["git", "merge-base", "HEAD", "main"], { cwd, stdout: "pipe", stderr: "ignore" });
  const mergeBase = (await new Response(mergeBaseProc.stdout).text()).trim();
  if (!mergeBase) { diffToolLaunching = false; ctx.setNotice("Could not determine merge-base with main"); return; }

  const checkProc = Bun.spawn(["git", "diff", "--quiet", mergeBase], { cwd, stdout: "ignore", stderr: "ignore" });
  const checkCode = await checkProc.exited;
  if (checkCode === 0) { diffToolLaunching = false; ctx.setNotice("No changes to show — diff is empty"); return; }

  // Run diff tool in the worktree, showing changes since merge-base with main.
  // 'exec' replaces bash so kill signals reach the actual process tree.
  // WEBDIFF_RUN_IN_PROCESS=1 prevents webdiff from forking/detaching, keeping
  // the HTTP server under ib's control (harmless for other diff tools).
  const proc = Bun.spawn(
    ["/bin/bash", "-c", 'exec $1 $(git merge-base HEAD main)', "--", tool],
    { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, WEBDIFF_RUN_IN_PROCESS: "1" } },
  );
  activeDiffProc = { proc, agentId: agent.id };
  diffToolLaunching = false;
  ctx.setNotice(`Opened diff in ${tool}`);

  // Report errors asynchronously, stripping newlines for single-line status bar display
  (async () => {
    try {
      const exitCode = await proc.exited;
      if (activeDiffProc?.proc === proc) activeDiffProc = null;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        const msg = (stderr || `exit code ${exitCode}`).split("\n")[0]!.trim();
        ctx.setNotice(`Diff tool error: ${msg}`);
      }
    } catch (err) {
      if (activeDiffProc?.proc === proc) activeDiffProc = null;
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
      "",
      header("Panes"),
      row("p / n / ←→", "cycle pane left/right"),
      row("[ / ]", "resize tmux/right split"),
      row("d / g / e / q", "diff / status / errors / questions"),
      "",
      header("Scroll"),
      row(";", "scroll up"),
      row("l", "scroll down"),
      "",
      header("Actions"),
      row("s", "send message"),
      row("E", "cross-repo send"),
      row("m", "merge"),
      row("x / !", "kill / nuke (all if none selected)"),
      row("R", "resume"),
      row("P", "pause"),
      row("r", "reassign"),
      row("a", "new agent"),
      "",
      header("Repo"),
      row("+ / A", "add repo"),
      row("x / D", "remove repo (on header)"),
      row("r", "rename repo (on header)"),
      row("f", "fix resolvable health warnings"),
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
  loadSetupDialog(ctx).catch((err) => ctx.setNotice(`Setup error: ${err}`));
}

async function loadSetupDialog(ctx: ActionCtx, initialTab = 0) {
  // Use any available repo path for hook operations (they modify ~/.claude/settings.json but reference repo paths)
  const repoPath = ctx.repos[0]?.path ?? "";

  // Fetch hook statuses in parallel
  const [safetyResult, interceptResult] = await Promise.all([
    repoPath ? hooksStatus(repoPath) : Promise.resolve({ ok: false, stdout: "", stderr: "" }),
    repoPath ? interceptHooksStatus(repoPath) : Promise.resolve({ ok: false, stdout: "", stderr: "" }),
  ]);

  // "installed" or "partial" both have hooks present; only "not-installed" means fully absent
  const safetyStatus = safetyResult.ok ? safetyResult.stdout : "not-installed";
  const safetyInstalled = safetyStatus === "installed";
  const safetyPartial = safetyStatus === "partial";
  const interceptInstalled = interceptResult.ok && (interceptResult.stdout === "installed");

  const hooksActionable = repoPath !== "";
  const items: SetupItem[] = [
    {
      label: "Safety hooks",
      description: "Block cd into worktrees + inject status + session context",
      value: safetyInstalled ? "installed" : safetyPartial ? "partial" : "not installed",
      actionable: hooksActionable,
      kind: "safety-hooks",
    },
    {
      label: "Task interception",
      description: "Redirect Task tool calls to spawn ib agents",
      value: interceptInstalled ? "installed" : "not installed",
      actionable: hooksActionable,
      kind: "intercept-hook",
    },
  ];

  // Load config for setup dialog
  const config = await readConfig();

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
      configItems: tab > 0 ? buildConfigItems() : undefined,
      configSelectedIndex: tab > 0 ? 0 : undefined,
      onAction: handleSetupItemAction(ctx, repoPath),
      onTabChange: (newTab: number) => {
        showSetupDialogForTab(newTab);
      },
      onConfigAction: tab > 0 ? handleConfigItemAction(ctx, tab, config, showSetupDialogForTab) : undefined,
    });
  };

  showSetupDialogForTab(initialTab);
}

/** Toggle a hook install/uninstall and update the setup item in-place */
function toggleHook(
  ctx: ActionCtx,
  item: SetupItem,
  repoPath: string,
  installFn: (p: string) => Promise<IbCommandResult>,
  uninstallFn: (p: string) => Promise<IbCommandResult>,
  label: string,
) {
  const shouldInstall = item.value !== "installed";
  const fn = shouldInstall ? installFn : uninstallFn;
  fn(repoPath).then((res) => {
    if (res.ok) {
      item.value = shouldInstall ? "installed" : "not installed";
      ctx.setNotice(`${shouldInstall ? "Installed" : "Uninstalled"} ${label}`);
    } else {
      ctx.setNotice(`Failed: ${res.stderr || res.stdout}`);
    }
    ctx.tui?.requestRender();
  });
}

function handleSetupItemAction(ctx: ActionCtx, repoPath: string) {
  return (item: SetupItem) => {
    if (item.kind === "safety-hooks") {
      toggleHook(ctx, item, repoPath, installSafetyHooks, uninstallSafetyHooks, "safety hooks");
    } else if (item.kind === "intercept-hook") {
      toggleHook(ctx, item, repoPath, installInterceptHook, uninstallInterceptHook, "task interception");
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
          writeConfig(defaultUserConfigPath(), "externalDiffTool", newTool).then(() => {
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
  tab: number,
  config: ConfigResult,
  showSetupDialogForTab: (tab: number) => void,
) {
  const configFilePath = defaultUserConfigPath();

  return (item: ConfigDialogItem) => {
    if (item.type === "boolean") {
      // Toggle immediately
      const newValue = !item.value;
      writeConfig(configFilePath, item.key, newValue).then(() => {
        // Update in-memory config and refresh dialog
        config[item.key] = { value: newValue, source: "user" };
        showSetupDialogForTab(tab);
        ctx.setNotice(`${item.key} = ${newValue}`);
      }).catch((err) => {
        ctx.setNotice(`Failed to save: ${err}`);
      });
    } else if (item.type === "string[]" && item.key.startsWith("permissions.")) {
      // Open permissions editor for allow/deny lists
      // Derive the role key (e.g., "permissions.manager") from "permissions.manager.allow"
      const parts = item.key.split(".");
      const roleKey = parts.slice(0, 2).join("."); // "permissions.manager" or "permissions.worker"
      const allowKey = `${roleKey}.allow`;
      const denyKey = `${roleKey}.deny`;
      const allowEntry = config[allowKey];
      const denyEntry = config[denyKey];
      const allowList = Array.isArray(allowEntry?.value) ? [...(allowEntry.value as string[])] : [];
      const denyList = Array.isArray(denyEntry?.value) ? [...(denyEntry.value as string[])] : [];
      const initialTab = item.key.endsWith(".deny") ? 1 : 0;

      ctx.closeDialog();
      ctx.showDialog({
        type: "permissions-editor",
        roleKey,
        tab: initialTab as 0 | 1,
        allowList,
        denyList,
        focus: 0,
        inputMode: false,
        inputValue: "",
        scrollOffset: 0,
        onSave: (newAllow: string[], newDeny: string[]) => {
          ctx.closeDialog();
          Promise.all([
            writeConfig(configFilePath, allowKey, newAllow),
            writeConfig(configFilePath, denyKey, newDeny),
          ]).then(() => {
            config[allowKey] = { value: newAllow, source: "user" };
            config[denyKey] = { value: newDeny, source: "user" };
            ctx.setNotice(`${roleKey} permissions updated`);
            loadSetupDialog(ctx, tab).catch((err) => ctx.setNotice(`Setup error: ${err}`));
          }).catch((err) => {
            ctx.setNotice(`Failed to save: ${err}`);
          });
        },
      });
    } else {
      // Open input dialog for number, string, or non-permission string[]
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
            config[item.key] = { value: parsed, source: "user" };
            if (item.key === "externalDiffTool") {
              ctx.diffTool = typeof parsed === "string" && parsed ? parsed : undefined;
            }
            ctx.setNotice(`${item.key} updated`);
            // Re-open setup dialog on the same tab
            loadSetupDialog(ctx, tab).catch((err) => ctx.setNotice(`Setup error: ${err}`));
          }).catch((err) => {
            ctx.setNotice(`Failed to save: ${err}`);
          });
        },
      });
    }
  };
}

export function handleResizeLeft(ctx: ActionCtx, delta: number) {
  const current = ctx.splitPane.getLeftWidth();
  const newWidth = Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, current + delta));
  if (newWidth === current) return;
  ctx.splitPane.setLeftWidth(newWidth);
  // Resize ALL agents' tmux sessions so the width is consistent across agents
  for (const entry of ctx.agentTree.flatList) {
    if (entry.kind === "agent" && entry.agent.meta.tmux_session) {
      resizeTmuxWindow(entry.agent.meta.tmux_session, newWidth);
    }
  }
  // Resize repo coordinator tmux to match new right pane width
  if (ctx.repoCoordinatorSession) {
    const mainWidth = process.stdout.columns - ctx.sidebarWidth - 1;
    const rightPaneWidth = mainWidth - newWidth - 1;
    if (rightPaneWidth > 0) {
      resizeTmuxWindow(ctx.repoCoordinatorSession, rightPaneWidth);
    }
  }
  ctx.tui?.requestRender();
}

export function handleOpenGhostty(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (agent) {
    if (!agent.meta.tmux_session) { ctx.setNotice("No active tmux session"); return; }
    const session = agent.meta.tmux_session;
    openInGhostty(session).then((result) => {
      ctx.setNotice(result.message);
    }).catch((err) => {
      ctx.setNotice(`Ghostty error: ${err}`);
    });
    return;
  }
  // No agent selected — check for repo header
  const repoHeader = ctx.agentTree.selectedRepoHeader;
  if (repoHeader) {
    const headerEntry = ctx.agentTree.flatList.find(
      (f): f is Extract<FlatEntry, { kind: "repo-header" }> => f.kind === "repo-header" && f.repoName === repoHeader
    );
    if (headerEntry) {
      openPathInGhostty(headerEntry.repoPath).then((result) => {
        ctx.setNotice(result.message);
      }).catch((err) => {
        ctx.setNotice(`Ghostty error: ${err}`);
      });
      return;
    }
  }
  ctx.setNotice("No agent or repo selected");
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

export function handleCrossRepoSend(ctx: ActionCtx) {
  // Collect repos that have at least one non-archived agent
  const reposWithAgents = ctx.repos.filter((repo) =>
    ctx.agentTree.flatList.some(
      (f) => f.kind === "agent" && f.agent.repoPath === repo.path && !f.agent.archived
    )
  );

  // Need at least 2 repos with agents for cross-repo to make sense
  if (reposWithAgents.length < 2) {
    ctx.setNotice("Cross-repo send requires 2+ repos with active agents");
    return;
  }

  // Exclude the selected agent's own repo if there are other options
  const selectedAgent = ctx.agentTree.selectedAgent;
  const otherRepos = selectedAgent
    ? reposWithAgents.filter((r) => r.path !== selectedAgent.repoPath)
    : reposWithAgents;
  const candidateRepos = otherRepos.length > 0 ? otherRepos : reposWithAgents;

  const showAgentSelect = (repo: RepoEntry) => {
    const agents = ctx.agentTree.flatList
      .filter((f): f is Extract<FlatEntry, { kind: "agent" }> =>
        f.kind === "agent" && f.agent.repoPath === repo.path && !f.agent.archived
      )
      .map((f) => f.agent);
    if (agents.length === 0) { ctx.setNotice("No active agents in that repo"); return; }
    const items = agents.map((a) => `${a.id}  (${a.state})`);
    ctx.showDialog({
      type: "select",
      prompt: `Send to agent in ${repoDisplayName(repo)}:`,
      items,
      selectedIndex: 0,
      onSelect: (agentIndex: number) => {
        const destAgent = agents[agentIndex]!;
        showMessageInput(ctx, repo, destAgent);
      },
    });
  };

  // Step 1: repo select (skip if only 1 candidate)
  if (candidateRepos.length === 1) {
    showAgentSelect(candidateRepos[0]!);
  } else {
    ctx.showDialog({
      type: "select",
      prompt: "Send to agent in which repo?",
      items: candidateRepos.map((r) => `${repoDisplayName(r)} (${r.path})`),
      selectedIndex: 0,
      onSelect: (repoIndex: number) => {
        showAgentSelect(candidateRepos[repoIndex]!);
      },
    });
  }
}

function showMessageInput(ctx: ActionCtx, repo: RepoEntry, destAgent: Agent) {
  ctx.showDialog({
    type: "input",
    prompt: `Send message to ${destAgent.id}:`,
    value: "",
    onSubmit: (message: string) => {
      ctx.closeDialog();
      if (!message.trim()) { ctx.setNotice("Send cancelled"); return; }
      ctx.executeAndRefresh(async () => {
        const result = await sendMessage(destAgent, message.trim(), { cwd: "/" });
        ctx.setNotice(result.ok ? `Sent to ${destAgent.id} in ${repoDisplayName(repo)}` : `Send failed: ${result.stderr || result.stdout}`);
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

function handleRemoveRepo(ctx: ActionCtx, repo?: RepoEntry) {
  const resolved = repo ?? findRepoByHeader(ctx);
  if (!resolved) { ctx.setNotice("No repo selected"); return; }
  ctx.showDialog({
    type: "confirm",
    prompt: `Remove ${repoDisplayName(resolved)} from registry?\n(${resolved.path})`,
    confirmLabel: "Remove",
    focusedButton: "cancel",
    confirmColor: RED,
    onYes: () => {
      ctx.closeDialog();
      removeRepo(resolved.path).then((result) => {
        ctx.setNotice(result.message);
        if (result.ok) {
          // Remove from in-memory repos so the UI reflects the change immediately
          const idx = ctx.repos.findIndex((r) => r.path === resolved.path);
          if (idx !== -1) { ctx.repos.splice(idx, 1); }
          ctx.watcher?.updateRepos(ctx.repos);
          ctx.watcher?.refresh();
        }
      }).catch((err) => {
        ctx.setNotice(`Error removing: ${err}`);
      });
    },
  });
}

/** 'A' — add repo via folder browser (alias for handleFolderBrowser) */
export async function handleAddRepo(ctx: ActionCtx) {
  return handleFolderBrowser(ctx);
}

/** Count agent directories under .ittybitty/agents/ and .ittybitty/archive/ */
async function countAgentDirs(repoPath: string): Promise<{ count: number; error?: string }> {
  let count = 0;
  for (const sub of ["agents", "archive"]) {
    const dir = join(repoPath, ".ittybitty", sub);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      count += entries.filter((e) => e.isDirectory()).length;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      return { count: 0, error: `Cannot read ${dir}: ${(err as Error).message}` };
    }
  }
  return { count };
}

/** 'D' / 'x' on repo header — remove repo with safety check: must have zero agent directories */
export async function handleRemoveRepoSafe(ctx: ActionCtx) {
  const repo = findRepoByHeader(ctx);
  if (!repo) { ctx.setNotice("No repo selected"); return; }

  const { count, error } = await countAgentDirs(repo.path);
  if (error) { ctx.setNotice(error); return; }
  if (count > 0) {
    ctx.setNotice(`Cannot remove: ${count} agent dir${count > 1 ? "s" : ""} still exist in ${repoDisplayName(repo)}`);
    return;
  }

  handleRemoveRepo(ctx, repo);
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
      addRepo(path).then(async (result) => {
        ctx.setNotice(result.message);
        if (result.ok) {
          const freshRepos = await listRepos();
          ctx.repos.length = 0;
          ctx.repos.push(...freshRepos);
          ctx.watcher?.updateRepos(ctx.repos);
          ctx.watcher?.refresh();
        }
      }).catch((err) => {
        ctx.setNotice(`Error adding repo: ${err}`);
      });
    },
  });
}

export function handleResolveHealth(ctx: ActionCtx) {
  if (ctx.rightPane.mode !== "REPO" || !ctx.agentTree.selectedRepoHeader) {
    ctx.setNotice("Fix is only available in REPO mode");
    return;
  }
  const report = ctx.healthReport;
  if (!report || report.warnings.length === 0) {
    ctx.setNotice("No health issues to fix");
    return;
  }
  const resolvable = getResolvableWarnings(report.warnings);
  if (resolvable.length === 0) {
    ctx.setNotice("No auto-resolvable issues");
    return;
  }

  const lines = resolvable.map((w) => {
    const icon = w.severity === "error" ? "🔴" : w.severity === "warning" ? "⚠️" : "ℹ️";
    return `${icon} ${w.fix || w.message}`;
  });

  ctx.showDialog({
    type: "confirm",
    prompt: `Auto-fix ${resolvable.length} issue(s)?\n${lines.join("\n")}`,
    confirmLabel: "Fix",
    focusedButton: "cancel",
    width: 80,
    onYes: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        const result = await resolveHealthWarnings(resolvable);
        const msg = result.failed > 0
          ? `Fixed ${result.resolved}, failed ${result.failed}`
          : `Fixed ${result.resolved} issue(s)`;
        ctx.setNotice(msg);
        ctx.watcher?.recheckHealth();
      });
    },
  });
}
