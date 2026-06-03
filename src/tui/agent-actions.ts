/**
 * Agent action handlers — extracted from DashboardComponent.
 * Each function takes a context object that provides access to dashboard state.
 */

import { existsSync } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { agentWorktreePath } from "../agents";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import type { RepoEntry } from "../registry";
import { addRepo, listRepos, renameRepo, removeRepo, repoDisplayName } from "../registry";
import {
  killAgent, nukeAgent, nukeAllAgents, resumeAgent, pauseAgent, reassignAgent, renameAgent,
  mergeCheckAgent, mergeAgent, sendMessage, newAgent,
  acknowledgeQuestion, hooksStatus, interceptHooksStatus,
  installSafetyHooks, uninstallSafetyHooks,
  installInterceptHook, uninstallInterceptHook,
  teamCreate, teamAdd, teamDelete, teamRemove,
} from "../ib-commands";
import { sanitizeAgentNameInput } from "../validation";
import type { NewAgentOptions, IbCommandResult } from "../ib-commands";
import { captureTmuxOutput, resizeTmuxWindow, killTmuxSession, sendTmuxEscape } from "../tmux-poller";
import { parseStateForCli } from "../parse-state";
import { parseModel } from "../agent-cli";
import type { AgentCli } from "../agent-cli";
import { openInGhostty, openPathInGhostty } from "../ghostty";
import { buildFolderItems } from "./folder-browser";
import { listSpawnableTypeNamesSync } from "../agent-types";
import { resolveDefaultAgentType } from "./default-agent-type";
import type { DialogState, SetupItem, ConfigDialogItem } from "./dialog-handler";
import { TextBuffer } from "./text-buffer";
import { readConfig, writeConfig, CONFIG_KEYS, defaultUserConfigPath } from "../config";
import type { ConfigResult } from "../config";
import { fuzzyFilterIndices } from "./dialog-handler";
import { displayState, computeStateColWidth, AGE_COL_WIDTH } from "./agent-tree";
import type { PaneMode } from "./pane-manager";
import { RESET, BOLD, DIM, RED } from "./colors";

function classifyAgentCli(model: string | undefined | null): AgentCli {
  if (!model) return "claude";
  try {
    return parseModel(model).cli;
  } catch {
    return "claude";
  }
}
import { clampLeftWidthAbsolute } from "./widths";
import type { RepoHealthReport } from "../health-check";
import { getResolvableWarnings, resolveHealthWarnings } from "../health-check";
import { IB_COORDINATOR_SESSION, sanitizeTmuxInput, restartSystemCoordinator, checkCoordinatorExists, getLastCoordinatorSpawnMode, discardSystemCoordinator } from "../coordinator";
import { isValidToolList } from "../validation";
import { listTeams, getTeam } from "../teams";

const SCROLL_STEP = 10;

/** Track active diff tool process so we can kill it before relaunching */
let activeDiffProc: { proc: ReturnType<typeof Bun.spawn>; agentId: string } | null = null;

let diffToolLaunching = false;

/**
 * UI-layer in-flight guard for the per-repo coordinator SPAWN path only.
 * Keyed on `repo:${repo.path}`. WHY this exists despite the durable op-guard:
 * when no coordinator exists yet, there is no agent dir (and no
 * meta.transient.json) to mark, so acquireAgentOperation() structurally can't
 * cover the spawn — two rapid 'R' presses both async-resolve `exists:false`
 * and both call newAgent() at the same deterministic dir, producing a
 * partial/failed duplicate spawn. This small set serializes that one path
 * within the process. The reset case is already covered by resumeAgent()'s
 * durable guard; this is intentionally NOT the old broad resumingAgentIds set.
 */
const coordinatorSpawnsInFlight = new Set<string>();

/** Test helpers for activeDiffProc */
export function getActiveDiffProc() { return activeDiffProc; }
export function setActiveDiffProc(v: typeof activeDiffProc) { activeDiffProc = v; }
export function getDiffToolLaunching() { return diffToolLaunching; }
export function setDiffToolLaunching(v: boolean) { diffToolLaunching = v; }

/** Test helpers for coordinatorSpawnsInFlight */
export function getCoordinatorSpawnsInFlight() { return coordinatorSpawnsInFlight; }
export function clearCoordinatorSpawnsInFlight() { coordinatorSpawnsInFlight.clear(); }

/** Resolve the settings.local.json path for an agent.
 * Coordinator agents use <agentDir>/.claude/; everyone else uses <agentDir>/repo/.claude/. */
export function agentSettingsLocalPath(agent: Agent): string {
  const dir = agent.archived ? "archive" : "agents";
  const agentDir = join(agent.repoPath, ".ittybitty", dir, agent.id);
  const base = agent.meta.agentType === "coordinator" ? agentDir : join(agentDir, "repo");
  return join(base, ".claude", "settings.local.json");
}

/** Append an entry to the permissions.allow array in a settings.local.json file.
 *  Returns { added: true } on success, { added: false, reason: "duplicate" } if the
 *  entry is already present, or { added: false, reason: "error", message } on failure.
 *  Preserves deny list and any other keys. If the file is missing, creates a new one.
 *  If the file exists but is malformed, aborts without overwriting. */
export type AddPermissionResult =
  | { added: true }
  | { added: false; reason: "duplicate" }
  | { added: false; reason: "error"; message: string };

export async function addPermissionToSettings(
  settingsPath: string,
  entry: string,
): Promise<AddPermissionResult> {
  const file = Bun.file(settingsPath);
  let settings: Record<string, unknown> = {};
  if (await file.exists()) {
    try {
      settings = (await file.json()) as Record<string, unknown>;
    } catch (err) {
      return { added: false, reason: "error", message: `Malformed JSON: ${(err as Error).message}` };
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      return { added: false, reason: "error", message: "settings.local.json is not an object" };
    }
  }
  const existingPerms = (settings.permissions as Record<string, unknown> | undefined) ?? {};
  if (typeof existingPerms !== "object" || existingPerms === null || Array.isArray(existingPerms)) {
    return { added: false, reason: "error", message: "permissions is not an object" };
  }
  const rawAllow = existingPerms.allow;
  const allow = Array.isArray(rawAllow) ? [...(rawAllow as unknown[])].filter((v): v is string => typeof v === "string") : [];
  const rawDeny = existingPerms.deny;
  const deny = Array.isArray(rawDeny) ? [...(rawDeny as unknown[])].filter((v): v is string => typeof v === "string") : [];
  if (allow.includes(entry)) {
    return { added: false, reason: "duplicate" };
  }
  const dedupedAllow = Array.from(new Set([...allow, entry]));
  const newSettings = {
    ...settings,
    permissions: {
      ...existingPerms,
      allow: dedupedAllow,
      deny,
    },
  };
  try {
    await Bun.write(settingsPath, JSON.stringify(newSettings, null, 2));
  } catch (err) {
    return { added: false, reason: "error", message: (err as Error).message };
  }
  return { added: true };
}

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
    selectByRepoPath(repoPath: string): boolean;
  };
  /**
   * §17.3a / §17.3: handlers that need to gate on the FOCUSED PANEL (the
   * team-send branch, the `@`-jump's "always force-select in Agents" rule) read
   * focus through this handle. Structurally satisfied by the dashboard's
   * `FocusManager`. The `setFocus`/`current` surface is intentionally narrow —
   * the handlers only need to know "is the Teams panel focused?" and how to
   * jump to the Agents panel.
   */
  focusManager: {
    current(): import("./focus").FocusTarget;
    setFocus(target: import("./focus").FocusTarget): void;
  };
  /**
   * §17.1 (Phase 1 three-axis model): which tree the sidebar currently shows.
   * Independent of focus and of the active selection. The source of truth for
   * "is the Teams panel visible in the sidebar?". The `@`-fuzzy jump writes
   * this back to "agents" so the user sees the agent it just jumped to.
   */
  sidebarMode: import("./sidebar").SidebarMode;
  /**
   * §17.1 (Phase 2 three-axis model): which tree owns the GLOBAL selection.
   * Independent of `sidebarMode`. `handleSend`'s team-target branch reads
   * this — only a team that is the active selection counts as a `@<team>`
   * target. The `@`-fuzzy jump writes this back to "agents" so the jumped-to
   * agent becomes the active selection.
   */
  activeSelectionSource: import("./sidebar").SidebarMode;
  /**
   * §17.1 Phase 2: setter — flips `activeSelectionSource` on the host
   * dashboard. The `@`-fuzzy jump uses this; tests inject a recording stub.
   */
  setActiveSelectionSource: (source: import("./sidebar").SidebarMode) => void;
  /**
   * §17.1 Phase 2: setter — flips `sidebarMode` on the host dashboard. Used by
   * the `@`-fuzzy jump (forces visibility to "agents" so the user sees the
   * jumped-to agent in the visible tree). Tests inject a recording stub.
   */
  setSidebarMode: (mode: import("./sidebar").SidebarMode) => void;
  /**
   * §17.3 / §17.3a: the Teams-tree handle. Lets `handleSend` read the team
   * anchor (`{ kind: "team", teamName }`) selected in the Teams panel, since
   * the team-target dialog and `teamSend` fan-out only fire on that selection.
   */
  teamsTree: {
    selection: import("./selection").Selection;
  };
  /**
   * §16.4 fan-out from the dashboard's `s`-key when a team is selected. We
   * accept `teamSend` as a function-typed ctx field so tests can inject a
   * stub without dragging in `ib-commands.ts`'s real I/O. The dashboard wires
   * the real `teamSend`.
   */
  teamSend: (
    teamName: string,
    members: Agent[],
    message: string,
    opts: { fromAgent?: string } | undefined,
  ) => Promise<IbCommandResult>;
  rightPane: {
    mode: PaneMode;
    repoCoordinatorAgent: Agent | null;
    filteredQuestions: PendingQuestion[];
    questionsSelectedIndex: number;
    scrollOffset: number;
    repoCoordinatorScrollBack: number;
    errors: string[];
    orphanedTmuxSessions: string[];
    updateContent(): void;
  };
  tmuxPane: { scrollUp(n?: number): void; scrollDown(n?: number): void };
  coordinatorPane: { scrollUp(n?: number): void; scrollDown(n?: number): void; resetForAgent(): void };
  /**
   * §17.4: the main-area channel chat box. The shared scroll keys (`;`/`l`)
   * scroll it alongside tmuxPane/coordinatorPane/right-pane so a team-channel
   * selection scrolls naturally.
   */
  channelPane: { scrollUp(n?: number): void; scrollDown(n?: number): void };
  /**
   * §17.4 companion: the right-side team log pane. Scrolled alongside the chat
   * box so the side-by-side Teams view stays in sync.
   */
  teamLogPane: { scrollUp(n?: number): void; scrollDown(n?: number): void };
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
  /**
   * Reload the AGENT LOG tail-window for the currently selected agent if the
   * cached window no longer covers the visible area (after scrolling, agent
   * change, or terminal resize). Cache hits short-circuit without I/O.
   */
  loadAgentLogIfNeeded(): void;
  setQuestionsFocused(value: boolean): void;
  healthReport: RepoHealthReport | undefined;
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

/**
 * Kill the system coordinator and write the cleared marker so the next
 * launch ignores its transcripts and starts fresh. Distinct from `R`
 * (which resumes).
 */
export function handleKillSystemCoordinator(ctx: ActionCtx) {
  ctx.showDialog({
    type: "confirm",
    prompt: "Discard saved session and kill system coordinator? (will not auto-relaunch)",
    confirmLabel: "Kill",
    focusedButton: "cancel",
    confirmColor: RED,
    onYes: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        await discardSystemCoordinator();
        ctx.setNotice("System coordinator killed (next launch will be fresh)");
      });
    },
  });
}

/**
 * Restart the system coordinator: kill the tmux session and respawn. The
 * respawn resumes the newest non-cleared transcript when one is available;
 * otherwise it falls back to a fresh launch (with the system prompt paste).
 *
 * Single source of truth for the `R`-on-coordinator flow — both the dashboard
 * key handler and `handleResume`'s system-coordinator branch delegate here so
 * the notice text and tmux pane reset stay in sync.
 */
export function handleRestartSystemCoordinator(ctx: ActionCtx) {
  // DELIBERATE: this path has NO double-press guard. The old in-memory
  // `resumingAgentIds` set was removed with the rest of the in-memory guards,
  // and the durable op-guard (acquireAgentOperation) can't replace it here —
  // the system coordinator has no agent dir / meta.transient.json to mark. We
  // accept the gap rather than reintroduce an in-memory set for this one path,
  // because restartSystemCoordinator() is an idempotent kill+relaunch: a rapid
  // double-press (rare) simply re-runs it, with no partial/duplicate-spawn
  // hazard. (Contrast the per-repo coordinator SPAWN path, which DID need the
  // narrow `coordinatorSpawnsInFlight` guard because two presses there race to
  // newAgent() into the same deterministic dir.) The immediate notice gives
  // feedback.
  ctx.setNotice("Restarting system coordinator…");
  ctx.executeAndRefresh(async () => {
    await restartSystemCoordinator();
    ctx.coordinatorPane.resetForAgent();
    const mode = getLastCoordinatorSpawnMode();
    ctx.setNotice(
      mode === "resumed"
        ? "System coordinator resumed"
        : "System coordinator restarted (fresh)",
    );
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
  if (ctx.agentTree.isSystemCoordinatorSelected) {
    handleRestartSystemCoordinator(ctx);
    return;
  }

  // Repo header selected: spawn or reset per-repo coordinator
  const repoHeader = ctx.agentTree.selectedRepoHeader;
  if (!ctx.agentTree.selectedAgent && repoHeader) {
    const repo = ctx.repos.find((r) => repoDisplayName(r) === repoHeader);
    if (!repo) return;

    // UI-layer in-flight guard for the SPAWN path. The durable op-guard inside
    // resumeAgent() covers the reset case, but a first-time coordinator spawn
    // has no agent dir / meta.transient.json yet, so nothing durable can mark
    // it. Without this, two rapid 'R' presses both see `exists:false` and both
    // newAgent() into the same deterministic dir → partial/duplicate spawn.
    // Keyed per-repo and released in the finally below; intentionally narrow.
    const spawnKey = `repo:${repo.path}`;
    if (coordinatorSpawnsInFlight.has(spawnKey)) {
      ctx.setNotice(`Coordinator action already in progress for ${repoDisplayName(repo)}…`);
      return;
    }
    coordinatorSpawnsInFlight.add(spawnKey);

    ctx.setNotice(`Resetting coordinator for ${repoDisplayName(repo)}…`);
    ctx.executeAndRefresh(async () => {
      try {
        const coordStatus = await checkCoordinatorExists(repo.path);
        if (coordStatus.exists) {
          // Coordinator exists — full reset (kill + respawn). Allowed regardless
          // of state: a running coordinator with stale permissions/hooks is the
          // primary case this command is for. resumeAgent() detects coordinators
          // and routes to the reset path. The durable op-guard inside
          // resumeAgent() (kind `restarting`) refuses a concurrent reset and
          // surfaces "Agent is currently restarting…" as the failure stderr.
          const agent = (ctx.watcher?.lastAgents ?? [])
            .find(a => a.id === coordStatus.agentId);
          if (agent) {
            const result = await resumeAgent(agent);
            ctx.setNotice(result.ok ? `Reset coordinator ${agent.id}` : `Reset failed: ${result.stderr || result.stdout}`);
          } else {
            ctx.setNotice(`Coordinator ${coordStatus.agentId} not found in agent tree`);
          }
        } else {
          // No coordinator — spawn one
          const result = await newAgent(repo.path, "You are the per-repo coordinator. Await instructions.", { type: "coordinator" });
          ctx.setNotice(result.ok ? `Spawned coordinator ${result.stdout}` : `Spawn failed: ${result.stderr || result.stdout}`);
        }
      } finally {
        coordinatorSpawnsInFlight.delete(spawnKey);
      }
    });
    return;
  }

  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;

  // No state gate here: we defer to resumeAgent()'s authoritative tmux-liveness
  // check (src/ib-commands.ts) rather than the racy 2s agent.state snapshot from
  // detectAgentStates(). A genuinely-finished agent reads "stopped" (a "complete"
  // agent only shows "complete" while its tmux session is alive), and a live
  // agent's resume is correctly refused by resumeAgent()'s `tmux has-session`
  // guard. That liveness check is the single source of truth for refusing.
  //
  // Concurrent-press protection is now durable, not in-memory: resumeAgent()
  // takes the cross-process op-guard (kind `restarting`) at its top, so a
  // mashed 'R' (or a shell `ib resume`, or a second `ib watch`) gets a refusal
  // whose stderr ("Agent is currently restarting…") we surface verbatim below.

  // Immediate feedback — resumeAgent() can block for several seconds.
  ctx.setNotice(`Resuming ${agent.id}…`);
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

/**
 * 'N' — set or clear the selected agent's nickname. Mirrors handleRenameRepo:
 * an input dialog pre-filled with the current nickname (or the id when none is
 * set). Submitting empty clears the nickname; a value sets it. Selection is
 * id-keyed and unaffected by the nickname change, so no re-selection is needed.
 */
export function handleRename(ctx: ActionCtx) {
  if (ctx.agentTree.isSystemCoordinatorSelected) return;
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  ctx.showDialog({
    type: "input",
    prompt: `Nickname for ${agent.id} (empty to clear):`,
    // Pre-fill the current nickname (so it can be edited), or EMPTY when none
    // is set. Empty is deliberate: the field is for a NEW nickname, and an
    // empty Enter already means "clear" (a no-op when none exists) — pre-filling
    // the id would make Enter-unchanged submit nickname==id, which is rejected.
    value: agent.meta.nickname ?? "",
    sanitize: sanitizeAgentNameInput,
    onSubmit: (value: string) => {
      ctx.closeDialog();
      const trimmed = value.trim();
      // Empty submission clears; a value sets. renameAgent runs the full
      // validation + global collision checks.
      const nickname: string | null = trimmed.length === 0 ? null : trimmed;
      ctx.executeAndRefresh(async () => {
        const result = await renameAgent(agent, nickname);
        if (result.ok) {
          ctx.setNotice(nickname === null ? `Cleared nickname for ${agent.id}` : `Nicknamed ${agent.id} "${nickname}"`);
        } else {
          ctx.setNotice(`Nickname failed: ${result.stderr || result.stdout}`);
        }
      });
    },
  });
}

/**
 * 'T' — prompt for a name and create a new team (§16). The notice loop is
 * intentionally light: validate the name client-side (allowlist + reserved-word
 * collision), then call `createTeam`. On success the notice quotes the
 * @-prefixed name so the user can read it back. On failure (rare — only the
 * already-exists race makes it past validation) the notice surfaces the error.
 *
 * `createdBy` is the SELECTED agent's id when one is selected (mirroring
 * `ib team create --created-by <agent>` from a worker), else the literal
 * `"user"` to match how the CLI's audit log records human creations.
 */
export function handleCreateTeam(ctx: ActionCtx) {
  runCreateTeam(ctx, /*initialValue*/ "", /*alsoAddSelectedAgent*/ false);
}

/**
 * 't' — add the selected agent to a team. If teams exist, open a picker with
 * an extra "+ Create new team…" entry at the bottom. If no teams exist, skip
 * the picker and go straight to the create-team input dialog (which will also
 * add the selected agent to the new team on success). Coordinator-selected and
 * no-agent states are both no-ops.
 */
export function handleAddAgentToTeam(ctx: ActionCtx) {
  if (ctx.agentTree.isSystemCoordinatorSelected) return;
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) return;
  // Load teams asynchronously, then show the appropriate dialog. Errors here
  // are non-fatal — fall back to the create-team flow so the user still has a
  // path forward without first having to debug `teams.json`.
  listTeams().then((teams) => {
    if (teams.length === 0) {
      runCreateTeam(ctx, "", /*alsoAddSelectedAgent*/ true);
      return;
    }
    showTeamPicker(ctx, agent, teams.map((t) => t.name));
  }).catch((err) => {
    ctx.setNotice(`Failed to list teams: ${(err as Error).message}`);
  });
}

/**
 * Show a fuzzy picker for an existing team, with a trailing "+ Create new
 * team…" entry that transitions into the same input dialog used by 'T'. On
 * selecting an existing team, calls `addMember` and shows a notice. On
 * selecting "+ Create new team…", opens the create dialog and joins the
 * agent to the new team on success.
 */
function showTeamPicker(ctx: ActionCtx, agent: Agent, teamNames: string[]) {
  const CREATE_LABEL = "+ Create new team…";
  // Distinct trailing entry: the picker is fuzzy-filterable, but the create
  // entry is always selectable (its label is unique enough to survive any
  // partial query unless the user types `+` or `Create`, which is fine).
  const items = [...teamNames, CREATE_LABEL];
  ctx.showDialog({
    type: "fuzzy",
    prompt: `Add ${agent.id} to team:`,
    query: "",
    allItems: items,
    filteredIndices: items.map((_, i) => i),
    filteredItems: [...items],
    selectedIndex: 0,
    onSelect: (originalIndex: number) => {
      ctx.closeDialog();
      const choice = items[originalIndex];
      if (choice === undefined) return;
      if (choice === CREATE_LABEL) {
        runCreateTeam(ctx, "", /*alsoAddSelectedAgent*/ true);
        return;
      }
      runAddMember(ctx, agent, choice);
    },
  });
}

/**
 * Shared helper for the 'T' create flow and the 't' "create new team…" branch.
 * Drives the 3-step wizard: name → member multi-select → optional first
 * message. Members get ONE inbound message (the user's first message, if any),
 * NOT N join notices — see `teamAdd`'s `suppressJoinNotice` opt.
 *
 * Step 1 (name): an `input` dialog seeded with `initialValue`. Empty submit
 *   silently aborts. Routes through `teamCreate` so the audit log + channel
 *   system record fire exactly as the CLI does.
 * Step 2 (members): a `multi-select` dialog over the watcher's live agents
 *   formatted as `<repo>/<id> (<state>)`. The currently-selected agent (if
 *   `alsoAddSelectedAgent` is true) is pre-checked. Each checked member is
 *   added via `teamAdd` with `suppressJoinNotice: true` so members do NOT
 *   receive an inbound "joined the team" message — the audit + channel
 *   system records still fire. Esc rolls back step 1 via `teamDelete`. If
 *   there are no live agents at all, the picker is skipped.
 * Step 3 (first message): a `textarea` dialog. Submitting with a non-empty
 *   buffer fans out via `ctx.teamSend` to every live member. Esc here does
 *   NOT roll back — the team and its members persist with no inbound message.
 */
function runCreateTeam(ctx: ActionCtx, initialValue: string, alsoAddSelectedAgent: boolean) {
  // Capture the selected agent at dialog-open time so step 2's pre-check
  // targets the agent the user intended at the start of the wizard, even if
  // they navigate the tree between steps.
  const preCheckAgent = alsoAddSelectedAgent && !ctx.agentTree.isSystemCoordinatorSelected
    ? ctx.agentTree.selectedAgent
    : null;
  const createdBy = ctx.agentTree.selectedAgent?.id ?? "user";

  ctx.showDialog({
    type: "input",
    prompt: "Team name:",
    value: initialValue,
    onSubmit: (value: string) => {
      ctx.closeDialog();
      const trimmed = value.trim();
      if (!trimmed) return; // empty → no-op
      ctx.executeAndRefresh(async () => {
        const createResult = await teamCreate(trimmed, { createdBy });
        if (!createResult.ok) {
          // teamCreate already produced a user-readable message (invalid name,
          // reserved-word collision, or already-exists). Surface it verbatim.
          ctx.setNotice(createResult.stderr || createResult.stdout || "Create team failed");
          return;
        }
        // Hand off to step 2 (member picker). The picker takes ownership of
        // status-bar notice production from here on so we can emit a single
        // combined notice at the END of the full wizard.
        openMemberPicker(ctx, trimmed, preCheckAgent);
      });
    },
  });
}

/**
 * Step 2 of the team-creation wizard: a multi-select over live agents. Esc
 * rolls back step 1 via `teamDelete`. If there are no live agents, skips
 * straight to step 3.
 */
function openMemberPicker(ctx: ActionCtx, teamName: string, preCheckAgent: Agent | null) {
  const liveAgents = ctx.watcher?.lastAgents ?? [];
  if (liveAgents.length === 0) {
    // No agents available — skip the picker entirely and hand off straight to
    // step 3, which still opens the textarea so the user can decide whether to
    // type a first message (it'll fan out to zero recipients, but the team
    // exists and the user might want to type the message anyway).
    openFirstMessagePrompt(ctx, teamName, /*addedCount*/ 0, /*addFailures*/ 0);
    return;
  }

  const items = liveAgents.map((a) => `${a.repoName}/${a.id} (${displayState(a.state)})`);
  const checked = liveAgents.map((a) => preCheckAgent?.id === a.id);

  ctx.showDialog({
    type: "multi-select",
    prompt: `Add members to @${teamName}:`,
    items,
    checked,
    selectedIndex: 0,
    onCancel: () => {
      // Roll back: delete the team we just created so a cancelled wizard
      // leaves no orphan. Emit a notice in both branches so the user can see
      // the cancel actually happened — the dialog vanishing alone is silent.
      //
      // NOTE on rollback race: this is fire-and-forget under executeAndRefresh.
      // If a user re-opens the wizard and recreates a team with the SAME name
      // before this teamDelete commits, the rollback could silently nuke the
      // recreated team. The window is sub-second (one syscall) and the
      // recreate path is at least three keypresses — extremely unlikely in
      // practice. Awaiting before close was rejected as a UI block. Document,
      // don't fix.
      ctx.executeAndRefresh(async () => {
        const delResult = await teamDelete(teamName);
        if (delResult.ok) {
          ctx.setNotice(`Cancelled — team @${teamName} rolled back`);
        } else {
          ctx.setNotice(`Cancelled; rollback failed: ${delResult.stderr || delResult.stdout}`);
        }
      });
    },
    onSubmit: (checkedIndices: number[]) => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        let addedCount = 0;
        let addFailures = 0;
        for (const i of checkedIndices) {
          const agent = liveAgents[i];
          if (!agent) continue;
          const addResult = await teamAdd(teamName, agent.id, ctx.repos, { suppressJoinNotice: true });
          if (addResult.ok) addedCount++;
          else addFailures++;
        }
        // Hand off to step 3 (optional first message). It owns the final
        // notice so all three steps roll up into one status line.
        openFirstMessagePrompt(ctx, teamName, addedCount, addFailures);
      });
    },
  });
}

/**
 * Step 3 of the team-creation wizard: an optional `textarea` for the first
 * message. Esc / empty submit skip the send. The single combined notice for
 * the whole wizard is emitted from here.
 *
 * NOTE on lastAgents snapshot: step 2 and step 3 each read
 * `ctx.watcher?.lastAgents` independently — if an agent is killed between
 * step-2 add and step-3 send, the recipient count we surface could be lower
 * than the added count. Acceptable for now; the watcher tick is ~1s and the
 * user spends much longer reading the textarea.
 */
function openFirstMessagePrompt(ctx: ActionCtx, teamName: string, addedCount: number, addFailures: number) {
  // The notice for steps 1 + 2 only — appended to in step 3 if a message gets
  // sent. Each branch below sets it as the final status-bar line.
  const memberPlural = addedCount === 1 ? "member" : "members";
  const baseNotice = addedCount > 0
    ? `created team @${teamName} with ${addedCount} ${memberPlural}`
    : `created team @${teamName}`;
  const withFailures = (suffix: string = "") =>
    addFailures > 0
      ? `${baseNotice}${suffix} (${addFailures} add failure${addFailures === 1 ? "" : "s"})`
      : `${baseNotice}${suffix}`;

  ctx.showDialog({
    type: "textarea",
    prompt: `First message to @${teamName}:`,
    buffer: new TextBuffer(),
    focusedButton: "text",
    // Esc on this textarea — treat as "skip the send" rather than silently
    // vanishing. Without this hook the global Esc handler just closes the
    // dialog and the user sees no confirmation that the team + members were
    // actually saved.
    onCancel: () => {
      ctx.setNotice(withFailures());
    },
    onSubmit: (message: string) => {
      ctx.closeDialog();
      const trimmed = message.trim();
      if (!trimmed) {
        // Empty submit — treat like skip; team stays, no send.
        ctx.setNotice(withFailures());
        return;
      }
      // Fan-out via teamSend to every live member of the team. The snapshot
      // is the watcher's last batch (same source we used to populate the
      // multi-select), consistent with what the user saw a moment ago.
      const live = ctx.watcher?.lastAgents ?? [];
      ctx.executeAndRefresh(async () => {
        const sendResult = await ctx.teamSend(teamName, live, trimmed, undefined);
        if (sendResult.ok) {
          // teamSend's stdout typically reads "Sent to N member(s) of @<team>".
          // We surface a recipient count if we can parse it; otherwise we fall
          // back to the addedCount (the wizard's own tally).
          const match = sendResult.stdout.match(/Sent to (\d+) member/);
          const recipients = match?.[1] ?? String(addedCount);
          // Numeric compare so a leading-zero match (e.g. "01") still pluralizes.
          const recipientPlural = Number(recipients) === 1 ? "recipient" : "recipients";
          ctx.setNotice(`${withFailures("")}, sent first message to ${recipients} ${recipientPlural}`);
        } else {
          ctx.setNotice(`${withFailures("")} (send failed: ${sendResult.stderr || sendResult.stdout})`);
        }
      });
    },
  });
}

/**
 * Add an agent to an existing team via `teamAdd` (the CLI path). Routing
 * through teamAdd ensures the join notice fan-out + audit-log entry fire,
 * matching `ib team add <name> <agent-id>` exactly (§16.4.1).
 */
function runAddMember(ctx: ActionCtx, agent: Agent, teamName: string) {
  ctx.executeAndRefresh(async () => {
    const result = await teamAdd(teamName, agent.id, ctx.repos);
    ctx.setNotice(result.ok
      ? (result.stdout || `Added ${agent.id} to @${teamName}`)
      : (result.stderr || result.stdout || `Add to team failed`));
  });
}

/**
 * 't' on a TEAM anchor in the Teams panel — open a multi-select roster
 * editor listing every live agent. Members already in `team.members` are
 * pre-toggled ON; others OFF. On confirm we diff the new selection against
 * the current roster and call `teamAdd`/`teamRemove` for each change.
 *
 * Routes through `teamAdd`/`teamRemove` so the audit log (§17.4 <team>.log),
 * the channel SYSTEM record (§17.4 channel.jsonl), the §16.4.1 @system
 * reply-protocol onboarding instruction to the newly-added agent, and the
 * per-existing-member join/leave fan-out all fire — same effective behavior
 * as running `ib team add`/`ib team remove` once per change. A batch edit
 * is a UI ergonomic over the dialog, NOT a way to silence notices: a user
 * who toggles N members on should still expect each new member to receive
 * onboarding and each existing member to receive a join notice.
 *
 * Roster constraint: only ids that appear in the dialog (live agents) are
 * eligible for removal. A stale id in `team.members` that has no live
 * Agent record (archived-but-not-pruned, missing meta dir) won't be shown,
 * won't be checked, and must NOT be force-removed on confirm — that would
 * confuse "user did not check" with "row didn't exist."
 */
export function handleManageRoster(ctx: ActionCtx, teamName: string) {
  ctx.executeAndRefresh(async () => {
    const team = await getTeam(teamName);
    if (!team) {
      ctx.setNotice(`team @${teamName} no longer exists`);
      return;
    }
    const liveAgents = ctx.watcher?.lastAgents ?? [];
    if (liveAgents.length === 0) {
      ctx.setNotice("No agents to manage");
      return;
    }
    const memberSet = new Set(team.members);
    const liveIds = new Set(liveAgents.map((a) => a.id));
    const items = liveAgents.map((a) => `${a.repoName}/${a.id} (${displayState(a.state)})`);
    const checked = liveAgents.map((a) => memberSet.has(a.id));

    ctx.showDialog({
      type: "multi-select",
      prompt: `Manage roster: @${teamName}`,
      items,
      checked,
      selectedIndex: 0,
      onSubmit: (checkedIndices: number[]) => {
        ctx.closeDialog();
        const nextMemberIds = new Set<string>();
        for (const i of checkedIndices) {
          const a = liveAgents[i];
          if (a) nextMemberIds.add(a.id);
        }
        const toAdd: string[] = [];
        const toRemove: string[] = [];
        for (const id of nextMemberIds) {
          if (!memberSet.has(id)) toAdd.push(id);
        }
        // Only remove ids the dialog actually showed — a stale id in
        // team.members with no live Agent record cannot have been
        // unchecked by the user; treating its absence as "remove" would
        // conflate "row didn't exist" with "user opted out."
        for (const id of memberSet) {
          if (liveIds.has(id) && !nextMemberIds.has(id)) toRemove.push(id);
        }
        if (toAdd.length === 0 && toRemove.length === 0) {
          ctx.setNotice(`Roster unchanged for @${teamName}`);
          return;
        }
        ctx.executeAndRefresh(async () => {
          let added = 0;
          let removed = 0;
          let failures = 0;
          let teamGone = false;
          // The team-gone wrapper signal is the literal `Error: team @<n> not
          // found` stderr line from ib-commands.ts:2727/2755/2763. Detect it
          // explicitly so the disband-mid-dialog race surfaces as "team gone"
          // instead of silently rolling up into the failure count.
          const isTeamGone = (stderr: string): boolean =>
            stderr.includes(`team @${teamName} not found`);
          for (const id of toAdd) {
            const r = await teamAdd(teamName, id, ctx.repos);
            if (r.ok) added++;
            else if (isTeamGone(r.stderr)) { teamGone = true; break; }
            else failures++;
          }
          if (!teamGone) {
            for (const id of toRemove) {
              const r = await teamRemove(teamName, id, ctx.repos);
              if (r.ok) removed++;
              else if (isTeamGone(r.stderr)) { teamGone = true; break; }
              else failures++;
            }
          }
          if (teamGone) {
            ctx.setNotice(`team @${teamName} no longer exists`);
            return;
          }
          const parts: string[] = [];
          if (added > 0) parts.push(`+${added}`);
          if (removed > 0) parts.push(`-${removed}`);
          const summary = parts.length > 0 ? parts.join(" ") : "no changes";
          const failSuffix = failures > 0 ? ` (${failures} failure${failures === 1 ? "" : "s"})` : "";
          ctx.setNotice(`Updated @${teamName}: ${summary}${failSuffix}`);
        });
      },
    });
  });
}

/**
 * 'x' on a TEAM anchor in the Teams panel — show a manage-team picker. The
 * first option disbands the team (falls through to `handleDisbandTeam`); the
 * remaining options remove a single member each. Per-member labels are
 * `<repo>/<id>` (cross-repo disambiguated, matching the Teams-tree row form,
 * §17.2) when the member's live Agent record is resolvable, falling back to
 * the bare member id otherwise. Each destructive choice is gated by a second
 * confirm dialog before any state change.
 *
 * Reads the team via `getTeam` so an empty team (no members) just shows the
 * "Disband team @<name>" option with no remove rows. If the team vanished
 * between display and selection, the underlying handlers (`handleDisbandTeam`
 * for disband, `teamRemove` for member-removal) surface the not-found state
 * exactly as if it had vanished mid-`x`.
 *
 * Note on `x` on a team MEMBER row in the Teams tree: that path is NOT routed
 * here. The dashboard's selection-sync makes a team-member look just like an
 * Agents-panel agent selection, so it falls through to `handleKill` (kill the
 * agent), matching `x` behavior in the Agents tree exactly.
 */
export function handleManageTeam(ctx: ActionCtx, teamName: string) {
  ctx.executeAndRefresh(async () => {
    const team = await getTeam(teamName);
    if (!team) {
      ctx.setNotice(`team @${teamName} no longer exists`);
      return;
    }
    const live = ctx.watcher?.lastAgents ?? [];
    const byId = new Map(live.map((a) => [a.id, a] as const));
    const memberItems = team.members.map((id) => {
      const agent = byId.get(id);
      const label = agent ? `${agent.repoName}/${id}` : id;
      return { memberId: id, label };
    });
    const items = [
      `Disband team @${teamName}`,
      ...memberItems.map((m) => `Remove ${m.label}`),
    ];
    ctx.showDialog({
      type: "select",
      prompt: `Manage team @${teamName}`,
      items,
      selectedIndex: 0,
      onSelect: (index: number) => {
        ctx.closeDialog();
        if (index === 0) {
          handleDisbandTeam(ctx, teamName);
          return;
        }
        const member = memberItems[index - 1]!;
        ctx.showDialog({
          type: "confirm",
          prompt: `Remove ${member.label} from @${teamName}?`,
          confirmLabel: "Remove",
          focusedButton: "cancel",
          confirmColor: RED,
          onYes: () => {
            ctx.closeDialog();
            ctx.executeAndRefresh(async () => {
              const result = await teamRemove(teamName, member.memberId, ctx.repos);
              ctx.setNotice(
                result.ok
                  ? (result.stdout || `Removed ${member.label} from @${teamName}`)
                  : (result.stderr || result.stdout || `Remove failed`),
              );
            });
          },
        });
      },
    });
  });
}

/**
 * Disband flow — fans out a closure notice via `teamSend` (so members get the
 * same delivery prefix/audit treatment as any other team broadcast), then
 * deletes the team via the `teamDelete` CLI wrapper. Order matters: the fan-out
 * reads the roster from `teams.json`, so it MUST happen before the delete.
 *
 * Reached from `handleManageTeam` (the `x`-on-team-anchor entry point) when the
 * user picks the "Disband team @<name>" option, OR from any future call site
 * that wants the bare disband flow. Shows a confirm dialog before the
 * destructive action.
 *
 * Uses the `teamDelete` CLI wrapper (not the bare `deleteTeam` registry
 * primitive) so the registry delete + channel/log cleanup (§17.4 cleanup
 * default) match `ib team delete` exactly — a later `ib team create` of the
 * same name starts with a clean channel rather than inheriting the disbanded
 * predecessor's history (including the closure notice teamSend just appended
 * to the channel file).
 */
export function handleDisbandTeam(ctx: ActionCtx, teamName: string) {
  ctx.showDialog({
    type: "confirm",
    prompt: `Disband team @${teamName}? Members will be notified.`,
    confirmLabel: "Disband",
    focusedButton: "cancel",
    confirmColor: RED,
    onYes: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        const team = await getTeam(teamName);
        if (!team) {
          ctx.setNotice(`team @${teamName} no longer exists`);
          return;
        }
        const members = team.members;
        const closureMessage = `team @${teamName} has been disbanded`;
        // Fan out BEFORE deleting — `teamSend` re-reads the roster from
        // `teams.json` under its own lock and would find an empty roster (or
        // a not-found error) if we deleted first. The `live` list is a hint
        // set; `teamSend`'s lazy-prune resolves the canonical recipients.
        // opts is left undefined to match the 's'-key team-send call shape —
        // resolveTeamSenderId tags a falsy fromAgent with the configured
        // user.name (the CLI/human send path).
        const live = ctx.watcher?.lastAgents ?? [];
        const sendResult = await ctx.teamSend(teamName, live, closureMessage, undefined);
        const deleteResult = await teamDelete(teamName);
        if (!deleteResult.ok) {
          // Team vanished between getTeam and teamDelete — race with another
          // mutator. The fan-out already ran against the live roster, so just
          // surface the unusual state.
          ctx.setNotice(`team @${teamName} no longer exists`);
          return;
        }
        const sendOk = sendResult.ok;
        const sendNote = sendOk ? "" : ` (notify failed: ${sendResult.stderr || sendResult.stdout})`;
        ctx.setNotice(`disbanded team @${teamName} (${members.length} members notified)${sendNote}`);
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
  // §17.3a: team-target branch — when the Teams tree OWNS THE ACTIVE
  // SELECTION (Phase 2, §17.1) AND a team anchor is selected, open a
  // `Send message to @<team>:` dialog and route through `teamSend` (§16.4
  // fan-out). A team MEMBER selection (kind:"agent") is INTENTIONALLY NOT
  // routed here — it falls through to the point-to-point agent-send path
  // below (§17.3 child-agent-indistinguishable). Phase 2 (§17.1) keys this
  // off `activeSelectionSource`, matching the dashboard's effective-selection
  // resolver (`syncSelectedAgent`).
  const teamsActive = ctx.activeSelectionSource === "teams";
  const teamSel = teamsActive ? ctx.teamsTree.selection : null;
  if (teamSel?.kind === "team") {
    handleSendToTeam(ctx, teamSel.teamName);
    return;
  }
  // System coordinator: send via tmux send-keys with sanitizeTmuxInput
  if (ctx.agentTree.isSystemCoordinatorSelected) {
    handleSendToCoordinator(ctx);
    return;
  }
  // Per-repo coordinator: when a repo header is selected and has a coordinator agent
  const repoCoord = ctx.rightPane.repoCoordinatorAgent;
  if (ctx.agentTree.selectedRepoHeader && repoCoord) {
    if (repoCoord.state === "stopped") {
      ctx.setNotice(`Coordinator ${repoCoord.id} is not running`);
      return;
    }
    handleSendToRepoCoordinator(ctx, repoCoord);
    return;
  }
  // §17.3 child-agent-indistinguishable: a team-member selection from the
  // Teams panel is `{ kind: "agent" }` — let it fall through to the same
  // point-to-point send path as an Agents-panel selection. The dashboard's
  // effective-selection resolver (activeSelectionSource-aware after Phase 2,
  // §17.1) has already populated `rightPane.agent`/`tmuxPane.agent`/
  // `infoPanel.agent` from the Teams-tree member selection when the Teams
  // tree is the active source; here we read it back through `teamSel` so the
  // send target is correct without going through the agentTree.
  const agent = teamSel?.kind === "agent" ? teamSel.agent : ctx.agentTree.selectedAgent;
  if (!agent) return;
  const dialog: Extract<NonNullable<DialogState>, { type: "textarea" }> = {
    type: "textarea",
    prompt: `Send message to ${agent.id}:`,
    buffer: new TextBuffer(),
    focusedButton: "text",
    sendAll: false,
    onSendEsc: () => {
      ctx.closeDialog();
      const session = agent.meta.tmux_session;
      if (!session) { ctx.setNotice("No active tmux session"); return; }
      ctx.executeAndRefresh(async () => {
        const ok = await sendTmuxEscape(session);
        ctx.setNotice(ok ? `Sent Esc to ${agent.id}` : `Failed to send Esc to ${agent.id}`);
      });
    },
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

/**
 * §17.3a: open a `Send message to @<team>:` dialog. On submit, resolve the
 * team's members from the dashboard's `lastAgents` (the same source the
 * Teams tree already uses) and call `ctx.teamSend` (the fan-out path, §16.4).
 * The `sendAll`/`Ctrl-A` toggle is intentionally omitted — a team send already
 * fans out, so the all-agents broadcast is a separate, repo-wide concern.
 *
 * fromAgent is left undefined: a `s`-key send from the dashboard is a CLI/
 * human send (resolveTeamSenderId in `teamSend` will tag it with `user.name`
 * when configured). This matches `ib send @<team>` from a non-agent shell.
 */
function handleSendToTeam(ctx: ActionCtx, teamName: string) {
  ctx.showDialog({
    type: "textarea",
    prompt: `Send message to @${teamName}:`,
    buffer: new TextBuffer(),
    focusedButton: "text",
    onSubmit: (message: string) => {
      ctx.closeDialog();
      const trimmed = message.trim();
      if (!trimmed) { ctx.setNotice("Send cancelled"); return; }
      // Resolve member ids → live Agent records from the watcher's last batch
      // (the same source that fed flattenTeamsTree, so the set is consistent
      // with what the user just saw in the Teams panel). `teamSend` re-prunes
      // dead members under its own lock — this is a hint set, not authoritative.
      const live = ctx.watcher?.lastAgents ?? [];
      ctx.executeAndRefresh(async () => {
        const result = await ctx.teamSend(teamName, live, trimmed, undefined);
        ctx.setNotice(result.ok ? (result.stdout || `Sent to @${teamName}`) : `Send failed: ${result.stderr || result.stdout}`);
      });
    },
  });
}

function handleSendToCoordinator(ctx: ActionCtx) {
  ctx.showDialog({
    type: "textarea",
    prompt: "Send message to coordinator:",
    buffer: new TextBuffer(),
    focusedButton: "text",
    onSendEsc: () => {
      ctx.closeDialog();
      ctx.executeAndRefresh(async () => {
        const ok = await sendTmuxEscape(IB_COORDINATOR_SESSION);
        ctx.setNotice(ok ? "Sent Esc to coordinator" : "Failed to send Esc to coordinator");
      });
    },
    onSubmit: (message: string) => {
      ctx.closeDialog();
      if (!message.trim()) { ctx.setNotice("Send cancelled"); return; }
      const sanitized = sanitizeTmuxInput(message.trim());
      ctx.executeAndRefresh(async () => {
        // Route through sendToSystemCoordinator so this send shares the
        // coordinator-home outbox queue + per-session lock with `ib send
        // @system` and watchdog `@system` notifications — concurrent writes to
        // the single `ib-coordinator` tmux session can no longer interleave.
        // raw=true preserves the historical verbatim send (no `[sent by ...]`
        // prefix). cwd:"/" so the sender isn't auto-stamped.
        const { sendToSystemCoordinator } = await import("../index");
        const sendResult = await sendToSystemCoordinator(sanitized, { raw: true, cwd: "/" });
        ctx.setNotice(sendResult.ok ? "Sent to coordinator" : "Failed to send to coordinator");
      });
    },
  });
}

function handleSendToRepoCoordinator(ctx: ActionCtx, agent: Agent) {
  ctx.showDialog({
    type: "textarea",
    prompt: `Send message to ${agent.id} (coordinator):`,
    buffer: new TextBuffer(),
    focusedButton: "text",
    onSendEsc: () => {
      ctx.closeDialog();
      const session = agent.meta.tmux_session;
      if (!session) { ctx.setNotice("No active tmux session"); return; }
      ctx.executeAndRefresh(async () => {
        const ok = await sendTmuxEscape(session);
        ctx.setNotice(ok ? `Sent Esc to ${agent.id}` : `Failed to send Esc to ${agent.id}`);
      });
    },
    onSubmit: (message: string) => {
      ctx.closeDialog();
      if (!message.trim()) { ctx.setNotice("Send cancelled"); return; }
      ctx.executeAndRefresh(async () => {
        const result = await sendMessage(agent, message.trim(), { cwd: "/" });
        ctx.setNotice(result.ok ? `Sent to ${agent.id}` : `Send failed: ${result.stderr || result.stdout}`);
      });
    },
  });
}

/** 'b' — add an entry to the selected agent's settings.local.json allow list. */
export function handleAddPermission(ctx: ActionCtx) {
  if (ctx.agentTree.isSystemCoordinatorSelected) return;

  // Resolve target agent: if a repo header is selected with a coordinator,
  // route to the coordinator; otherwise use the selected agent.
  let target: Agent | null = null;
  if (ctx.agentTree.selectedRepoHeader && !ctx.agentTree.selectedAgent) {
    if (ctx.rightPane.repoCoordinatorAgent) {
      target = ctx.rightPane.repoCoordinatorAgent;
    } else {
      ctx.setNotice("No coordinator for this repo");
      return;
    }
  } else {
    target = ctx.agentTree.selectedAgent;
  }
  if (!target) return;
  if (target.archived) {
    ctx.setNotice("Cannot modify archived agent");
    return;
  }
  const agent = target;

  ctx.showDialog({
    type: "input",
    prompt: `Add permission to ${agent.id}:`,
    value: "",
    onSubmit: (value: string) => {
      ctx.closeDialog();
      const entry = value.trim();
      if (!entry) { ctx.setNotice("Permission add cancelled"); return; }
      if (!isValidToolList(entry)) {
        ctx.setNotice("Invalid permission entry — disallowed characters");
        return;
      }
      const settingsPath = agentSettingsLocalPath(agent);
      addPermissionToSettings(settingsPath, entry).then(async (result) => {
        if (result.added) {
          ctx.setNotice(`Added ${entry} to ${agent.id} allow list`);
          const sendResult = await sendMessage(
            agent,
            `[watchdog]: Permission to '${entry}' has been granted. You may retry the action that was previously denied.`,
            { cwd: "/" },
          );
          if (!sendResult.ok) {
            ctx.setNotice(`Added ${entry}, but notify failed: ${sendResult.stderr || sendResult.stdout}`);
          }
        } else if (result.reason === "duplicate") {
          ctx.setNotice("Already in allow list");
        } else {
          ctx.setNotice(`Failed: ${result.message}`);
        }
      }).catch((err) => {
        ctx.setNotice(`Failed: ${(err as Error).message}`);
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
  // Read the names of available spawnable agent types synchronously so the
  // dialog can open immediately. Layer-only types (e.g. `_all`, `_non_coordinator`)
  // are filtered out — they act only as permission/prompt layers. Falls back to
  // embedded defaults when the on-disk types directory is missing.
  const availableTypes = listSpawnableTypeNamesSync();
  const defaultType = resolveDefaultAgentType(repo.defaultAgentType, availableTypes);

  ctx.showDialog({
    type: "new-agent-form",
    repoName: repoDisplayName(repo),
    name: "",
    agentType: defaultType,
    availableTypes,
    buffer: new TextBuffer(),
    focused: "name",
    onSubmit: (name: string, agentType: string, prompt: string) => {
      ctx.closeDialog();
      const opts: NewAgentOptions = {};
      if (name.trim()) opts.name = name.trim();
      if (agentType) opts.type = agentType;
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
    // §17.1 Phase 2: jumping from the QUESTIONS pane to an agent is an
    // Agents-panel operation — make the Agents tree the active source and
    // ensure the sidebar shows it (parallel to the @-fuzzy jump).
    ctx.setActiveSelectionSource("agents");
    ctx.setSidebarMode("agents");
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
  const repoEntries = visible.filter((f): f is Extract<FlatEntry, { kind: "repo-header" }> => f.kind === "repo-header");
  if (agentEntries.length === 0 && repoEntries.length === 0) { ctx.setNotice("No agents to search"); return; }
  const fuzzyStateColWidth = computeStateColWidth(agentEntries);
  // Build a mixed list: repo headers first, then agents
  type FuzzyEntry = { kind: "agent"; entry: Extract<FlatEntry, { kind: "agent" }> } | { kind: "repo"; entry: Extract<FlatEntry, { kind: "repo-header" }> };
  const entries: FuzzyEntry[] = [
    ...repoEntries.map((e) => ({ kind: "repo" as const, entry: e })),
    ...agentEntries.map((e) => ({ kind: "agent" as const, entry: e })),
  ];
  const allItems = entries.map((e) => {
    if (e.kind === "repo") {
      return `${e.entry.repoName}/  (repo)`;
    }
    const promptText = (e.entry.agent.meta.summary ?? e.entry.agent.meta.prompt).replace(/\n/g, " ");
    const state = displayState(e.entry.agent.state);
    // Include the nickname in the searchable string so `@` can jump by it —
    // otherwise nicknames would be un-findable in the very place they help.
    const nick = e.entry.agent.meta.nickname ? `  ${e.entry.agent.meta.nickname}` : "";
    return `${e.entry.agent.repoName}/${e.entry.agent.id}${nick}  ${state.padEnd(fuzzyStateColWidth)}  ${e.entry.agent.age.padStart(AGE_COL_WIDTH)}  ${promptText}`;
  });
  ctx.showDialog({
    type: "fuzzy",
    prompt: "Jump to agent or repo",
    query: "",
    allItems,
    filteredIndices: allItems.map((_, i) => i),
    filteredItems: [...allItems],
    selectedIndex: 0,
    onSelect: (originalIndex: number) => {
      ctx.closeDialog();
      const selected = entries[originalIndex]!;
      // §17.3: the @-jump ALWAYS lands in the Agents panel — even when the
      // user is currently focused on the Teams panel and the agent they jump
      // to happens to be a team member. This is the ONLY thing that force-
      // selects in the Agents tree from no-selection.
      ctx.focusManager.setFocus("agent-tree");
      // §17.1 Phase 2: the @-jump is the canonical Agents-panel operation —
      // it makes the Agents tree the active selection source AND flips the
      // sidebar to "agents" so the user sees the agent it just jumped to.
      // Both axes are written explicitly so the routing is unambiguous (the
      // user spec: "yes, flip sidebarMode to agents on @-jump").
      ctx.setActiveSelectionSource("agents");
      ctx.setSidebarMode("agents");
      if (selected.kind === "repo") {
        ctx.agentTree.selectByRepoPath(selected.entry.repoPath);
        ctx.syncSelectedAgent();
        ctx.jumpToMode("REPO");
        ctx.tui?.requestRender();
      } else {
        ctx.agentTree.selectAgentById(selected.entry.agent.id);
        ctx.syncSelectedAgent();
        ctx.jumpToMode("AGENT LOG");
        ctx.tui?.requestRender();
      }
    },
  });
}

export function handleScrollUp(ctx: ActionCtx) {
  ctx.tmuxPane.scrollUp(SCROLL_STEP);
  ctx.coordinatorPane.scrollUp(SCROLL_STEP);
  ctx.channelPane.scrollUp(SCROLL_STEP);
  ctx.teamLogPane.scrollUp(SCROLL_STEP);
  ctx.rightPane.scrollOffset += SCROLL_STEP;
  ctx.rightPane.repoCoordinatorScrollBack += SCROLL_STEP;
  ctx.systemDashboard.scrollUp(SCROLL_STEP);
  ctx.rightPane.updateContent();
  // In AGENT LOG mode, scrolling up may reveal lines beyond the cached window.
  // The loader's cache check short-circuits when no read is needed.
  if (ctx.rightPane.mode === "AGENT LOG") {
    ctx.loadAgentLogIfNeeded();
  }
  ctx.tui?.requestRender();
}

export function handleScrollDown(ctx: ActionCtx) {
  ctx.tmuxPane.scrollDown(SCROLL_STEP);
  ctx.coordinatorPane.scrollDown(SCROLL_STEP);
  ctx.channelPane.scrollDown(SCROLL_STEP);
  ctx.teamLogPane.scrollDown(SCROLL_STEP);
  ctx.rightPane.scrollOffset = Math.max(0, ctx.rightPane.scrollOffset - SCROLL_STEP);
  ctx.rightPane.repoCoordinatorScrollBack = Math.max(0, ctx.rightPane.repoCoordinatorScrollBack - SCROLL_STEP);
  ctx.systemDashboard.scrollDown(SCROLL_STEP);
  ctx.rightPane.updateContent();
  // Scrolling down typically uses cached content but call for symmetry —
  // cache hit makes this free.
  if (ctx.rightPane.mode === "AGENT LOG") {
    ctx.loadAgentLogIfNeeded();
  }
  ctx.tui?.requestRender();
}

async function resolveAgentDirPath(agent: Agent): Promise<string> {
  const worktreePath = agentWorktreePath(agent);
  try {
    const s = await stat(worktreePath);
    if (!s.isDirectory()) return agent.repoPath;
  } catch {
    return agent.repoPath;
  }
  return worktreePath;
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
  (async () => {
    const pathToOpen = await resolveAgentDirPath(agent);
    try {
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
      row("0 / 1", "switch sidebar (Teams / Agents)"),
      row("@", "fuzzy jump to agent/repo"),
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
      row("T", "create team"),
      row("t", "add agent to team"),
      row("b", "add permission"),
      row("m", "merge"),
      row("x / !", "kill / nuke (all if none selected)"),
      row("R", "resume"),
      row("P", "pause"),
      row("r", "reassign"),
      row("N", "nickname agent"),
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
      row("G", "Ghostty (repo/worktree)"),
      row("C", "Ghostty (Claude tmux)"),
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
      // Derive the role key (e.g., "permissions.repo") from "permissions.repo.allow"
      const parts = item.key.split(".");
      const roleKey = parts.slice(0, 2).join("."); // e.g. "permissions.all", "permissions.repo"
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
          writeConfig(configFilePath, allowKey, newAllow).then(() =>
            writeConfig(configFilePath, denyKey, newDeny),
          ).then(() => {
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
  // Pre-existing behavior: clamps to absolute MIN/MAX_LEFT_WIDTH only. On a narrow
  // terminal the user can momentarily drag past the visible cap; the dashboard
  // render path re-clamps via `clampLeftWidth(mainWidth, …)`.
  const newWidth = clampLeftWidthAbsolute(current + delta);
  if (newWidth === current) return;
  ctx.splitPane.setLeftWidth(newWidth);
  // Resize ALL agents' tmux sessions so the width is consistent across agents.
  for (const entry of ctx.agentTree.flatList) {
    if (entry.kind === "agent" && entry.agent.meta.tmux_session) {
      resizeTmuxWindow(entry.agent.meta.tmux_session, newWidth);
    }
  }
  // Per-repo coordinators are full-pane (sized by sidebar+terminal, not by the
  // middle/right split), so the inner split-pane resize doesn't change their width.
  ctx.tui?.requestRender();
}

// G and C share the system-coordinator branch: it has no worktree path, so
// "open repo" and "open Claude tmux" both attach to the coordinator's tmux.
function openSystemCoordinatorInGhostty(ctx: ActionCtx) {
  openInGhostty(IB_COORDINATOR_SESSION).then((result) => {
    ctx.setNotice(result.message);
  }).catch((err) => {
    ctx.setNotice(`Ghostty error: ${err}`);
  });
}

export function handleOpenGhostty(ctx: ActionCtx) {
  if (ctx.agentTree.isSystemCoordinatorSelected) {
    openSystemCoordinatorInGhostty(ctx);
    return;
  }
  const agent = ctx.agentTree.selectedAgent;
  if (agent) {
    (async () => {
      const pathToOpen = await resolveAgentDirPath(agent);
      openPathInGhostty(pathToOpen).then((result) => {
        ctx.setNotice(result.message);
      }).catch((err) => {
        ctx.setNotice(`Ghostty error: ${err}`);
      });
    })();
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

export function handleOpenGhosttyTmux(ctx: ActionCtx) {
  if (ctx.agentTree.isSystemCoordinatorSelected) {
    openSystemCoordinatorInGhostty(ctx);
    return;
  }
  const agent = ctx.agentTree.selectedAgent;
  if (agent) {
    if (!agent.meta.tmux_session) { ctx.setNotice("No active tmux session"); return; }
    openInGhostty(agent.meta.tmux_session).then((result) => {
      ctx.setNotice(result.message);
    }).catch((err) => {
      ctx.setNotice(`Ghostty error: ${err}`);
    });
    return;
  }
  // No agent selected — for repo header, open the per-repo coordinator's tmux
  // (parallel to G opening the repo's directory).
  const coordAgent = ctx.rightPane.repoCoordinatorAgent;
  if (coordAgent && coordAgent.meta.tmux_session) {
    openInGhostty(coordAgent.meta.tmux_session).then((result) => {
      ctx.setNotice(result.message);
    }).catch((err) => {
      ctx.setNotice(`Ghostty error: ${err}`);
    });
    return;
  }
  if (ctx.agentTree.selectedRepoHeader) {
    ctx.setNotice("No coordinator tmux for this repo");
    return;
  }
  ctx.setNotice("No agent selected");
}

export function handleSnapshot(ctx: ActionCtx) {
  const agent = ctx.agentTree.selectedAgent;
  if (!agent) { ctx.setNotice("No agent selected"); return; }
  captureTmuxOutput(agent.meta.tmux_session).then(async (strippedOutput) => {
    try {
      if (!strippedOutput) { ctx.setNotice("No tmux output captured"); return; }
      const result = parseStateForCli(strippedOutput, classifyAgentCli(agent.meta.model));
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `snapshot-${timestamp}-${result.state}.txt`;
      const dir = agent.archived ? "archive" : "agents";
      const debugDir = `${agent.repoPath}/.ittybitty/${dir}/${agent.id}/debug-logs`;
      const snapshotPath = `${debugDir}/${filename}`;
      const baseName = filename.replace(/\.txt$/, "");
      const notePath = `${debugDir}/${baseName}-note.txt`;
      const snapshotsDir = join(dirname(defaultUserConfigPath()), "snapshots");
      const mirrorBaseName = `${agent.id}-${baseName}`;
      const mirrorSnapshotPath = join(snapshotsDir, `${mirrorBaseName}.txt`);
      const mirrorNotePath = join(snapshotsDir, `${mirrorBaseName}-note.txt`);
      await Bun.$`mkdir -p ${debugDir}`.quiet();
      await Bun.$`mkdir -p ${snapshotsDir}`.quiet();
      await Bun.write(
        snapshotPath,
        `State: ${result.state}\nReason: ${result.reason}\n\n${strippedOutput}`
      );
      await Bun.write(
        mirrorSnapshotPath,
        `State: ${result.state}\nReason: ${result.reason}\n\n${strippedOutput}`
      );
      ctx.setNotice(`Snapshot saved: ${filename} (state: ${result.state})`);
      ctx.showDialog({
        type: "textarea",
        prompt: `Note for ${filename} (empty to skip):`,
        buffer: new TextBuffer(),
        focusedButton: "text",
        onSubmit: (note: string) => {
          ctx.closeDialog();
          const trimmed = note.trim();
          if (!trimmed) { ctx.setNotice(`Snapshot saved: ${filename} (no note)`); return; }
          ctx.executeAndRefresh(async () => {
            try {
              await Bun.write(notePath, `${trimmed}\n`);
              await Bun.write(mirrorNotePath, `${trimmed}\n`);
              ctx.setNotice(`Snapshot + note saved: ${filename}`);
            } catch (err) {
              ctx.setNotice(`Note save error: ${err}`);
            }
          });
        },
      });
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

/** Count live agent directories under .ittybitty/agents/ (archived agents do not block removal) */
async function countAgentDirs(repoPath: string): Promise<{ count: number; error?: string }> {
  const dir = join(repoPath, ".ittybitty", "agents");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return { count: entries.filter((e) => e.isDirectory()).length };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { count: 0 };
    }
    return { count: 0, error: `Cannot read ${dir}: ${(err as Error).message}` };
  }
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
      const raw = basename(path);
      const sanitized = raw.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
      if (!sanitized) {
        ctx.setNotice(`Cannot derive a valid name from ${raw}`);
        return;
      }
      addRepo(path, sanitized).then(async (result) => {
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
