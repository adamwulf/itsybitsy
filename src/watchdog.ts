/**
 * Built-in watchdog for itsybitsy.
 * Monitors agents, detects state transitions, and notifies managers.
 *
 * Per-agent watchdog: runs as a standalone background process (`ib watchdog <id>`).
 * Each agent gets its own watchdog process — no global lock file needed.
 *
 * Phase 15-A: Core loop + waiting/unknown handler with exponential backoff.
 * Phase 15-B: complete/running/creating/compacting/stopped/rate_limited handlers.
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { readRepoAgents, readAllAgents, isCompacting, isRateLimited, readAgentState } from "./agents";
import type { Agent } from "./agents";
import { captureTmuxOutput } from "./tmux-poller";
import { logAgent } from "./agent-lifecycle";
import { parseState } from "./parse-state";
import type { AgentState } from "./parse-state";
import type { MetaState } from "./agents";
import { sendMessage } from "./ib-commands";
import { fetchUsage } from "./usage";
import type { UsageResult } from "./usage";
import { SpawnContext } from "./types";
import type { SpawnFn } from "./types";
import { checkAndCompact } from "./auto-compact";
import type { CompactState } from "./auto-compact";
import { readConfig } from "./config";
import { isValidTmuxSession } from "./validation";
import { listRepos } from "./registry";

/** Per-agent tracking state managed by the watchdog */
export interface AgentTracker {
  previousState: AgentState | null;
  waitCounter: number;
  notifyInterval: number; // in ticks (each tick = POLL_INTERVAL_MS)
  completionNotified: boolean;
  rateLimitBypassed: boolean;
  compactState: CompactState;
  lastCompactCheckMs: number;
}

/** How often the watchdog polls, in milliseconds */
export const POLL_INTERVAL_MS = 5_000;

/** Minimum interval between auto-compact checks per agent, in milliseconds (60s) */
export const COMPACT_CHECK_COOLDOWN_MS = 60_000;

/** Initial notification threshold in ticks (6 ticks * 5s = 30s) */
export const INITIAL_NOTIFY_TICKS = 6;

/** Maximum notification interval in ticks (768 ticks * 5s = 3840s = 64 minutes) */
export const MAX_NOTIFY_TICKS = 768;

/** Recovery threshold for rate limits — matches ib bash's recovery_threshold (5%) */
const RATE_LIMIT_RECOVERY_THRESHOLD = 5;

/** State handler function signature — called on each tick for each agent */
export type StateHandler = (
  agent: Agent,
  tracker: AgentTracker,
  allAgents: Agent[],
) => Promise<void>;

/** Registry of state handlers keyed by AgentState */
const stateHandlers = new Map<AgentState, StateHandler>();

/** Register a handler for a given agent state */
export function registerStateHandler(state: AgentState, handler: StateHandler): void {
  stateHandlers.set(state, handler);
}

// ---------------------------------------------------------------------------
// Test injection
// ---------------------------------------------------------------------------

/** Spawn context for watchdog operations */
export const spawnCtx = new SpawnContext();

/** Override spawn runner for testing (used by rate limit bypass). */
export function setWatchdogSpawnRunner(runner: SpawnFn): void {
  spawnCtx.set(runner);
}

/** Reset spawn runner to default. */
export function resetWatchdogSpawnRunner(): void {
  spawnCtx.reset();
}

/** Overridable fetchUsage for testing. */
let fetchUsageFn: () => Promise<UsageResult> = fetchUsage;

/** Override fetchUsage for testing. */
export function setWatchdogFetchUsage(fn: () => Promise<UsageResult>): void {
  fetchUsageFn = fn;
}

/** Reset fetchUsage to default. */
export function resetWatchdogFetchUsage(): void {
  fetchUsageFn = fetchUsage;
}

/** Overridable readConfig for testing. */
type ReadConfigFn = typeof readConfig;
let readConfigFn: ReadConfigFn = readConfig;

/** Override readConfig for testing. */
export function setWatchdogReadConfig(fn: ReadConfigFn): void {
  readConfigFn = fn;
}

/** Reset readConfig to default. */
export function resetWatchdogReadConfig(): void {
  readConfigFn = readConfig;
}

/** Overridable Date.now for testing. */
let nowFn: () => number = () => Date.now();

/** Override Date.now for testing. */
export function setWatchdogNow(fn: () => number): void {
  nowFn = fn;
}

/** Reset Date.now to default. */
export function resetWatchdogNow(): void {
  nowFn = () => Date.now();
}

// ---------------------------------------------------------------------------
// Tracker management
// ---------------------------------------------------------------------------

/** Create a fresh tracker for a newly-seen agent */
export function createTracker(): AgentTracker {
  return {
    previousState: null,
    waitCounter: 0,
    notifyInterval: INITIAL_NOTIFY_TICKS,
    completionNotified: false,
    rateLimitBypassed: false,
    compactState: { compactSent: false },
    lastCompactCheckMs: 0,
  };
}

/** Per-agent tracking map: agentId -> tracker */
const trackers = new Map<string, AgentTracker>();

/** Get the tracker for an agent, creating one if it doesn't exist */
export function getTracker(agentId: string): AgentTracker {
  let tracker = trackers.get(agentId);
  if (!tracker) {
    tracker = createTracker();
    trackers.set(agentId, tracker);
  }
  return tracker;
}

/** Get all current trackers (for testing/inspection) */
export function getAllTrackers(): ReadonlyMap<string, AgentTracker> {
  return trackers;
}

/** Clear all trackers (for testing) */
export function clearTrackers(): void {
  trackers.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find an agent by ID in the agents list.
 * Used to look up a manager agent for sending notifications.
 */
function findAgent(agents: Agent[], id: string): Agent | undefined {
  for (const agent of agents) {
    if (agent.id === id) return agent;
    // Search children recursively
    const found = findAgent(agent.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Send a watchdog notification to the agent's manager.
 * No-op if the agent has no manager or manager isn't found.
 */
export async function notifyManager(
  agent: Agent,
  message: string,
  allAgents: Agent[],
): Promise<void> {
  const managerId = agent.meta.manager;
  if (!managerId) return;

  const manager = findAgent(allAgents, managerId);
  if (!manager) return;

  await sendMessage(manager, message);
}

/**
 * Send a watchdog notification to the agent's spawner (if different from manager).
 * No-op if the agent has no spawned_by, or if spawner === manager, or if
 * spawner agent is not found in any registered repo.
 */
export async function notifySpawner(
  agent: Agent,
  message: string,
  allAgents: Agent[],
): Promise<void> {
  const spawner = agent.meta.spawned_by;
  if (!spawner) return;
  // Don't double-notify if spawner is the same as manager
  if (spawner.agent_id === agent.meta.manager) return;

  const spawnerAgent = findAgent(allAgents, spawner.agent_id);
  if (!spawnerAgent) return;

  await sendMessage(spawnerAgent, message);
}

/** Send Enter to a tmux session to dismiss a dialog. */
async function sendTmuxEnter(tmuxSession: string): Promise<boolean> {
  if (!isValidTmuxSession(tmuxSession)) {
    console.error(`[watchdog] Invalid tmux session name: ${tmuxSession}`);
    return false;
  }
  try {
    const proc = spawnCtx.runner(
      ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch { /* expected: tmux not running or session gone */
    return false;
  }
}

// ---------------------------------------------------------------------------
// Built-in state handlers
// ---------------------------------------------------------------------------

/**
 * Handler for "waiting" state.
 * Increments wait counter. After threshold, notifies manager with exponential backoff.
 * Backoff: 30s -> 1m -> 2m -> 4m -> 8m -> 16m -> 32m -> 64m cap.
 */
async function handleWaiting(agent: Agent, tracker: AgentTracker, allAgents: Agent[]): Promise<void> {
  tracker.waitCounter++;

  if (tracker.waitCounter >= tracker.notifyInterval) {
    await notifyManager(
      agent,
      `[watchdog]: Your subtask ${agent.id} recently started waiting for input`,
      allAgents,
    );
    await notifySpawner(
      agent,
      `[watchdog]: Agent ${agent.id} you spawned recently started waiting for input`,
      allAgents,
    );

    // Reset counter and double interval (exponential backoff)
    tracker.waitCounter = 0;
    tracker.notifyInterval = Math.min(tracker.notifyInterval * 2, MAX_NOTIFY_TICKS);
  }
}

/**
 * Handler for "unknown" state.
 * Same exponential backoff as waiting — agent may need attention.
 * On first transition into unknown, saves tmux output to debug-logs/ (matches bash watchdog).
 */
async function handleUnknown(agent: Agent, tracker: AgentTracker, allAgents: Agent[]): Promise<void> {
  // Save debug log on transition into unknown state (not on every tick)
  if (tracker.previousState !== "unknown") {
    await saveUnknownDebugLog(agent);
  }

  tracker.waitCounter++;

  if (tracker.waitCounter >= tracker.notifyInterval) {
    await notifyManager(
      agent,
      `[watchdog]: Your subtask ${agent.id} state is unknown - may need attention`,
      allAgents,
    );
    await notifySpawner(
      agent,
      `[watchdog]: Agent ${agent.id} you spawned has an unknown state - may need attention`,
      allAgents,
    );

    // Reset counter and double interval (exponential backoff)
    tracker.waitCounter = 0;
    tracker.notifyInterval = Math.min(tracker.notifyInterval * 2, MAX_NOTIFY_TICKS);
  }
}

/**
 * Save tmux output to a debug log file when an agent transitions to unknown state.
 * Matches bash behavior: saves to `debug-logs/watchdog-<timestamp>-unknown.txt`
 * in the agent's directory.
 */
async function saveUnknownDebugLog(agent: Agent): Promise<void> {
  const tmuxSession = agent.meta.tmux_session;
  if (!tmuxSession) return;
  if (!isValidTmuxSession(tmuxSession)) {
    console.error(`[watchdog] Invalid tmux session name for agent ${agent.id}: ${tmuxSession}`);
    return;
  }

  try {
    const output = await captureTmuxOutput(tmuxSession);
    if (output === null) return;

    const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
    const debugDir = join(agentDir, "debug-logs");
    mkdirSync(debugDir, { recursive: true });

    const timestamp = Math.floor(nowFn() / 1000);
    const debugFile = join(debugDir, `watchdog-${timestamp}-unknown.txt`);
    await Bun.write(debugFile, output);

    await logAgent(agentDir, `[watchdog] Debug log saved: debug-logs/watchdog-${timestamp}-unknown.txt`);
  } catch { /* best-effort — don't crash watchdog */ }
}

/**
 * Handler for "complete" state.
 * One-time notification to manager. Sets completionNotified flag; cleared on resume (running only).
 */
async function handleComplete(agent: Agent, tracker: AgentTracker, allAgents: Agent[]): Promise<void> {
  if (!tracker.completionNotified) {
    await notifyManager(
      agent,
      `[watchdog]: Your subtask ${agent.id} recently completed`,
      allAgents,
    );
    await notifySpawner(
      agent,
      `[watchdog]: Agent ${agent.id} you spawned recently completed`,
      allAgents,
    );
    tracker.completionNotified = true;
  }
}

/**
 * Handler for "running" state.
 * Resets counters (done by processAgents for all non-backoff states).
 * Only running clears completionNotified — matches ib bash (lines 14573-14578).
 */
async function handleRunning(_agent: Agent, tracker: AgentTracker, _allAgents: Agent[]): Promise<void> {
  if (tracker.completionNotified) {
    tracker.completionNotified = false;
  }
  tracker.rateLimitBypassed = false;
}

/**
 * Handler for "creating" state.
 * Agent still initializing — just reset rate limit bypass flag.
 * Does NOT clear completionNotified (matches ib bash).
 */
async function handleCreating(_agent: Agent, tracker: AgentTracker, _allAgents: Agent[]): Promise<void> {
  tracker.rateLimitBypassed = false;
}

/**
 * Handler for "compacting" state.
 * Agent is compacting context — normal operation, just reset rate limit bypass flag.
 * Does NOT clear completionNotified (matches ib bash).
 */
async function handleCompacting(_agent: Agent, tracker: AgentTracker, _allAgents: Agent[]): Promise<void> {
  tracker.rateLimitBypassed = false;
}

/** Maximum number of retry attempts for rate limit bypass */
export const RATE_LIMIT_MAX_RETRIES = 3;

/** Delay between retry attempts in milliseconds */
export const RATE_LIMIT_RETRY_DELAY_MS = 2_000;

/**
 * Handler for "rate_limited" state.
 * - 3-attempt retry loop: send Enter, wait 2s, check state, repeat if still rate_limited
 * - Check usage API; when session usage drops below threshold, nudge agent
 */
async function handleRateLimited(agent: Agent, tracker: AgentTracker, _allAgents: Agent[]): Promise<void> {
  const tmuxSession = agent.meta.tmux_session;

  if (tmuxSession && !isValidTmuxSession(tmuxSession)) {
    console.error(`[watchdog] Invalid tmux session name for agent ${agent.id}: ${tmuxSession}`);
    return;
  }

  // Bypass rate limit dialog on first detection with a 3-attempt retry loop
  // matching bash's bypass_rate_limit: send Enter, wait 2s, capture output,
  // check state via parseState, repeat if still rate_limited.
  if (!tracker.rateLimitBypassed && tmuxSession) {
    for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
      await sendTmuxEnter(tmuxSession);
      await watchdogSleepFn(RATE_LIMIT_RETRY_DELAY_MS);

      // Capture tmux output and check if still rate limited
      const output = await watchdogCaptureTmuxFn(tmuxSession);
      if (output !== null) {
        const result = parseState(output);
        if (result.state !== "rate_limited") {
          break; // Successfully dismissed
        }
      }
    }
    tracker.rateLimitBypassed = true;
  }

  // Check usage API to see if usage has dropped enough to resume
  const usageResult = await fetchUsageFn();
  const usage = usageResult.data;
  if (usage && usage.sessionPct !== null && usage.sessionPct < RATE_LIMIT_RECOVERY_THRESHOLD) {
    await sendMessage(
      agent,
      `[watchdog]: Usage has refreshed (${usage.sessionPct}%). Please continue your task.`,
    );
    // Reset bypass flag so next rate-limit episode will re-bypass
    tracker.rateLimitBypassed = false;
  }
}

/**
 * Handler for "stopped" state.
 * No-op — counter reset is handled by processAgents for all non-backoff states.
 */
async function handleStopped(_agent: Agent, _tracker: AgentTracker, _allAgents: Agent[]): Promise<void> {
  // No-op
}

// Register built-in handlers
registerStateHandler("waiting", handleWaiting);
registerStateHandler("unknown", handleUnknown);
registerStateHandler("complete", handleComplete);
registerStateHandler("running", handleRunning);
registerStateHandler("creating", handleCreating);
registerStateHandler("compacting", handleCompacting);
registerStateHandler("rate_limited", handleRateLimited);
registerStateHandler("stopped", handleStopped);

/** States that use the wait counter / backoff system */
const BACKOFF_STATES = new Set<AgentState>(["waiting", "unknown"]);

// ---------------------------------------------------------------------------
// Tick helper (used by state handler tests)
// ---------------------------------------------------------------------------

/** Recursively collect all agent IDs */
function collectIds(agents: Agent[], ids: Set<string>): void {
  for (const agent of agents) {
    ids.add(agent.id);
    collectIds(agent.children, ids);
  }
}

/** Recursively process all agents through their state handlers */
async function processAgents(agents: Agent[], allAgents: Agent[]): Promise<void> {
  for (const agent of agents) {
    const tracker = getTracker(agent.id);
    const handler = stateHandlers.get(agent.state);

    if (handler) {
      await handler(agent, tracker, allAgents);
    }

    // Reset wait counter and backoff when transitioning away from backoff states.
    if (!BACKOFF_STATES.has(agent.state)) {
      tracker.waitCounter = 0;
      tracker.notifyInterval = INITIAL_NOTIFY_TICKS;
    }

    // Update previous state after handler runs
    tracker.previousState = agent.state;

    // Auto-compact check with per-agent cooldown
    if (agent.state === "running" || agent.state === "waiting") {
      const now = nowFn();
      if (now - tracker.lastCompactCheckMs >= COMPACT_CHECK_COOLDOWN_MS) {
        tracker.lastCompactCheckMs = now;
        try {
          const config = await readConfigFn();
          const thresholdEntry = config["autoCompactThreshold"];
          const threshold = thresholdEntry?.value as number | undefined;
          if (threshold != null && threshold > 0) {
            await checkAndCompact(agent, threshold, tracker.compactState);
          }
        } catch {
          // Config read or compact check failed — skip silently
        }
      }
    }

    // Process children
    await processAgents(agent.children, allAgents);
  }
}

/**
 * Process a single tick for a list of agents.
 * Exported for testing — used by state handler tests.
 */
export async function tick(agents: Agent[]): Promise<void> {
  // Build a set of current agent IDs to prune stale trackers
  const currentIds = new Set<string>();
  collectIds(agents, currentIds);

  // Prune trackers for agents that no longer exist
  for (const id of trackers.keys()) {
    if (!currentIds.has(id)) {
      trackers.delete(id);
    }
  }

  // Process each agent
  await processAgents(agents, agents);
}

// ---------------------------------------------------------------------------
// Per-agent watchdog (CLI: `ib watchdog <id>`)
// ---------------------------------------------------------------------------

/** Grace period for missing tmux session before exit (milliseconds) */
export const TMUX_GONE_GRACE_MS = 10_000;

/** Injectable existsSync for testing */
let existsSyncFn: (path: string) => boolean = (p) => {
  try { return require("fs").existsSync(p); } catch { return false; }
};

/** Override existsSync for testing */
export function setPerAgentExistsSync(fn: (path: string) => boolean): void {
  existsSyncFn = fn;
}

/** Reset existsSync to default */
export function resetPerAgentExistsSync(): void {
  existsSyncFn = (p) => {
    try { return require("fs").existsSync(p); } catch { return false; }
  };
}

/** Injectable sleep for testing (per-agent watchdog) */
let sleepFn: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms);

/** Override sleep for testing (per-agent watchdog) */
export function setPerAgentSleep(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

/** Reset sleep to default (per-agent watchdog) */
export function resetPerAgentSleep(): void {
  sleepFn = (ms) => Bun.sleep(ms);
}

/** Injectable sleep for global watchdog testing */
let watchdogSleepFn: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms);

/** Override sleep for global watchdog testing */
export function setWatchdogSleep(fn: (ms: number) => Promise<void>): void {
  watchdogSleepFn = fn;
}

/** Reset sleep to default for global watchdog */
export function resetWatchdogSleep(): void {
  watchdogSleepFn = (ms) => Bun.sleep(ms);
}

/** Injectable captureTmuxOutput for global watchdog testing */
let watchdogCaptureTmuxFn: (session: string) => Promise<string | null> = captureTmuxOutput;

/** Override captureTmuxOutput for global watchdog testing */
export function setWatchdogCaptureTmux(fn: (session: string) => Promise<string | null>): void {
  watchdogCaptureTmuxFn = fn;
}

/** Reset captureTmuxOutput to default for global watchdog */
export function resetWatchdogCaptureTmux(): void {
  watchdogCaptureTmuxFn = captureTmuxOutput;
}

/** Injectable captureTmuxOutput for testing */
let captureTmuxFn: (session: string) => Promise<string | null> = captureTmuxOutput;

/** Override captureTmuxOutput for testing */
export function setPerAgentCaptureTmux(fn: (session: string) => Promise<string | null>): void {
  captureTmuxFn = fn;
}

/** Reset captureTmuxOutput to default */
export function resetPerAgentCaptureTmux(): void {
  captureTmuxFn = captureTmuxOutput;
}

/** Injectable readAgentMeta for testing */
let readAgentMetaFn: (agentDir: string) => Promise<{ meta: import("./agents").AgentMeta | null; error?: string }> = async (dir) => {
  const { readAgentMeta } = await import("./agents");
  return readAgentMeta(dir);
};

/** Override readAgentMeta for testing */
export function setPerAgentReadMeta(fn: typeof readAgentMetaFn): void {
  readAgentMetaFn = fn;
}

/** Reset readAgentMeta to default */
export function resetPerAgentReadMeta(): void {
  readAgentMetaFn = async (dir) => {
    const { readAgentMeta } = await import("./agents");
    return readAgentMeta(dir);
  };
}

/** Injectable readAgentState for per-agent watchdog testing */
let readAgentStateFn: (agentDir: string) => Promise<MetaState | undefined> = readAgentState;

/** Override readAgentState for testing */
export function setPerAgentReadState(fn: typeof readAgentStateFn): void {
  readAgentStateFn = fn;
}

/** Reset readAgentState to default */
export function resetPerAgentReadState(): void {
  readAgentStateFn = readAgentState;
}

/**
 * Resolve agent state for the per-agent watchdog using deterministic meta.json state
 * with tmux overrides for transient states.
 * Resolution: compacting/rate_limited from tmux → meta.json state → fallback to running.
 */
function resolveWatchdogState(tmuxOutput: string, metaState: MetaState | undefined): AgentState {
  // Step 1: transient tmux overrides
  if (isCompacting(tmuxOutput)) return "compacting";
  if (isRateLimited(tmuxOutput)) return "rate_limited";
  // Step 2: meta.json state
  if (metaState) return metaState;
  // Step 3: fallback
  return "running";
}

/**
 * Capture output from a dead tmux pane (remain-on-exit) and write it to debug-logs/.
 * Called on first detection of a missing tmux session to preserve exit context.
 */
async function captureAndLogDeadPane(agentId: string, agentDir: string, tmuxSession: string): Promise<void> {
  if (!isValidTmuxSession(tmuxSession)) return;
  try {
    // Check if the pane is dead (remain-on-exit kept it)
    const deadCheck = spawnCtx.runner(
      ["tmux", "display-message", "-p", "-t", tmuxSession, "#{pane_dead}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const deadExitCode = await deadCheck.exited;
    if (deadExitCode !== 0) return;
    const deadOutput = await new Response(deadCheck.stdout).text();
    if (deadOutput.trim() !== "1") return;

    // Capture the last screen content
    const captureProc = spawnCtx.runner(
      ["tmux", "capture-pane", "-p", "-t", tmuxSession, "-E", "-"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const captureExitCode = await captureProc.exited;
    if (captureExitCode !== 0) return;
    const captureOutput = await new Response(captureProc.stdout).text();

    // Write to debug-logs/
    const debugLogsDir = join(agentDir, "debug-logs");
    mkdirSync(debugLogsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outFile = join(debugLogsDir, `watchdog-${timestamp}-exit.txt`);
    await Bun.write(outFile, captureOutput);

    const relPath = `debug-logs/watchdog-${timestamp}-exit.txt`;
    await logAgent(agentDir, `[watchdog] Captured dead pane output → ${relPath}`);

    // Kill the dead pane so cleanup proceeds normally
    const killProc = spawnCtx.runner(
      ["tmux", "kill-pane", "-t", tmuxSession],
      { stdout: "pipe", stderr: "pipe" },
    );
    await killProc.exited;
  } catch { /* don't crash the watchdog */ }
}

/**
 * Run a self-contained watchdog loop for a single agent.
 * Exits cleanly when:
 *   (a) the agent's worktree directory no longer exists, OR
 *   (b) the agent's tmux session has been missing for >10 consecutive seconds.
 *
 * This is the per-agent CLI entry point (`ib watchdog <id>`), matching
 * the bash watchdog's per-agent model. Does NOT use lock files.
 */
export async function runPerAgentWatchdog(agentId: string, repoPath: string): Promise<void> {
  const agentDir = join(repoPath, ".ittybitty", "agents", agentId);
  const worktreeDir = join(agentDir, "repo");

  // Read agent meta to get tmux session
  const { meta } = await readAgentMetaFn(agentDir);
  if (!meta) {
    console.error(`[watchdog] Cannot read meta for agent ${agentId}`);
    return;
  }

  const tmuxSession = meta.tmux_session;
  if (!tmuxSession) {
    console.error(`[watchdog] No tmux session for agent ${agentId}`);
    return;
  }
  if (!isValidTmuxSession(tmuxSession)) {
    console.error(`[watchdog] Invalid tmux session name for agent ${agentId}: ${tmuxSession}`);
    return;
  }

  const tracker = createTracker();
  let tmuxGoneSince: number | null = null;

  // Poll loop
  while (true) {
    // Exit condition (a): worktree directory removed (kill/merge/nuke)
    if (!existsSyncFn(worktreeDir)) {
      break;
    }

    // Check tmux session
    const output = await captureTmuxFn(tmuxSession);

    if (output === null) {
      // Tmux session missing — start or continue grace period
      if (tmuxGoneSince === null) {
        await logAgent(agentDir, "[watchdog] tmux session disappeared — starting 10s grace period");
        await captureAndLogDeadPane(agentId, agentDir, tmuxSession);
        tmuxGoneSince = nowFn();
      } else if (nowFn() - tmuxGoneSince >= TMUX_GONE_GRACE_MS) {
        // Exit condition (b): tmux gone for >10s
        await logAgent(agentDir, "[watchdog] tmux session gone for >10s — exiting watchdog");
        break;
      }
    } else {
      // Tmux session exists — reset grace period
      tmuxGoneSince = null;

      // Auto-accept permissions prompts (workspace trust, external imports, MCP servers)
      if (/enter to confirm/i.test(output)) {
        if (/trust/i.test(output) || /Allow external CLAUDE\.md file imports/i.test(output) || /New MCP server found/i.test(output)) {
          await logAgent(agentDir, "[watchdog] Detected permissions prompt — sending Enter to accept");
          await sendTmuxEnter(tmuxSession);
          await sleepFn(POLL_INTERVAL_MS);
          continue;
        }
      }

      // Resolve state from meta.json with tmux overrides
      const metaState = await readAgentStateFn(agentDir);
      const resolvedState = resolveWatchdogState(output, metaState);

      const agent: Agent = {
        id: agentId,
        repoPath,
        repoName: "",
        meta,
        state: resolvedState,
        age: "",
        archived: false,
        children: [],
      };

      // Run state handler
      const handler = stateHandlers.get(resolvedState);
      if (handler) {
        try {
          // For notifyManager, we need allAgents — but per-agent watchdog
          // only knows about this agent. Read siblings from disk.
          const allAgents = await loadAllAgentsForNotification(repoPath);
          await handler(agent, tracker, allAgents);
        } catch { /* don't crash */ }
      }

      // Reset backoff for non-backoff states
      if (!BACKOFF_STATES.has(resolvedState)) {
        tracker.waitCounter = 0;
        tracker.notifyInterval = INITIAL_NOTIFY_TICKS;
      }

      tracker.previousState = resolvedState;

      // Auto-compact check
      if (resolvedState === "running" || resolvedState === "waiting") {
        const now = nowFn();
        if (now - tracker.lastCompactCheckMs >= COMPACT_CHECK_COOLDOWN_MS) {
          tracker.lastCompactCheckMs = now;
          try {
            const config = await readConfigFn();
            const thresholdEntry = config["autoCompactThreshold"];
            const threshold = thresholdEntry?.value as number | undefined;
            if (threshold != null && threshold > 0) {
              await checkAndCompact(agent, threshold, tracker.compactState);
            }
          } catch { /* skip */ }
        }
      }
    }

    // Sleep before next poll
    await sleepFn(POLL_INTERVAL_MS);
  }
}

/**
 * Load all agents from all registered repos for notification purposes
 * (finding managers and cross-repo spawners).
 * Best-effort — returns empty array on failure.
 */
async function loadAllAgentsForNotification(_repoPath: string): Promise<Agent[]> {
  try {
    // Read all registered repos so cross-repo spawners can be found by findAgent().
    // The previous implementation only read the agent's own repo, which made
    // cross-repo notifySpawner impossible since findAgent can't locate the spawner.
    const repos = await listRepos();
    const { agents } = await readAllAgents(repos.map(r => ({ path: r.path, name: r.name })));
    // Note: buildAgentTree() is NOT called here. findAgent() iterates the flat
    // array first (exact ID match) so tree structure is unnecessary for notifications.
    // Also note: detectAgentStates() is intentionally omitted — sendMessage() sends
    // tmux keys directly and does not check agent state, so state detection adds
    // overhead with no benefit on the notification path.
    return agents;
  } catch {
    return [];
  }
}

