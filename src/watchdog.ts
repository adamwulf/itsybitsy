/**
 * Built-in watchdog for itsybitsy.
 * Monitors all agents across all repos, detects state transitions,
 * and notifies managers when agents need attention.
 *
 * Runs as a standalone background process (`ib watchdog`).
 * Uses a PID lock file at ~/.itsybitsy/watchdog.lock for single-instance.
 *
 * Phase 15-A: Core loop + waiting/unknown handler with exponential backoff.
 * Phase 15-B: complete/running/creating/compacting/stopped/rate_limited handlers.
 * Phase 20: Standalone watchdog process with lock file management.
 */

import { join } from "path";
import { homedir } from "os";
import { readFileSync, unlinkSync, mkdirSync, openSync, closeSync, writeSync, constants as fsConstants } from "fs";
import { readAllAgents, readRepoAgents, detectAgentStates } from "./agents";
import type { Agent } from "./agents";
import { captureTmuxOutput } from "./tmux-poller";
import { logAgent } from "./agent-lifecycle";
import { parseState } from "./parse-state";
import type { AgentState } from "./parse-state";
import { sendMessage } from "./ib-commands";
import { fetchUsage } from "./usage";
import type { UsageData, UsageResult } from "./usage";
import { SpawnContext } from "./types";
import type { SpawnFn } from "./types";
import type { RepoEntry } from "./registry";
import { checkAndCompact } from "./auto-compact";
import type { CompactState } from "./auto-compact";
import { readConfig } from "./config";

/** Function that returns the current list of agents. Used by the watchdog loop.
 * Can be sync (TUI watcher cache) or async (disk-based standalone watchdog). */
export type AgentProvider = () => Agent[] | Promise<Agent[]>;

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

/** Send Enter to a tmux session to dismiss a dialog. */
async function sendTmuxEnter(tmuxSession: string): Promise<boolean> {
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

  try {
    const output = await captureTmuxOutput(tmuxSession);
    if (output === null) return;

    const agentDir = join(agent.repoPath, ".ittybitsy", "agents", agent.id);
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

/**
 * Handler for "rate_limited" state.
 * - Send Enter to dismiss the rate limit dialog (once per rate-limit episode)
 * - Check usage API; when session usage drops below threshold, nudge agent
 */
async function handleRateLimited(agent: Agent, tracker: AgentTracker, _allAgents: Agent[]): Promise<void> {
  const tmuxSession = agent.meta.tmux_session;

  // Bypass rate limit dialog on first detection.
  // TODO: ib bash uses a 3-attempt retry loop with 2s sleeps between attempts
  // (bypass_rate_limit). Single Enter suffices since the watchdog re-checks every 5s,
  // but a retry loop would be more robust for edge cases.
  if (!tracker.rateLimitBypassed && tmuxSession) {
    await sendTmuxEnter(tmuxSession);
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

// ---------------------------------------------------------------------------
// Lock file management
// ---------------------------------------------------------------------------

const LOCK_DIR = join(process.env.HOME ?? homedir(), ".itsybitsy");
const LOCK_FILE = join(LOCK_DIR, "watchdog.lock");

/** Override lock file path for testing */
let lockFilePath = LOCK_FILE;

/** Set lock file path (for testing) */
export function setLockFilePath(path: string): void {
  lockFilePath = path;
}

/** Reset lock file path to default */
export function resetLockFilePath(): void {
  lockFilePath = LOCK_FILE;
}

/** Check if a PID is alive */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch { /* expected: process is dead */
    return false;
  }
}

/**
 * Acquire the watchdog lock file.
 * Writes current PID to ~/.itsybitsy/watchdog.lock.
 * Returns true if acquired (no lock, or stale PID). False if another watchdog is running.
 *
 * Uses O_EXCL for atomic lock creation to prevent TOCTOU races where two
 * processes could both read "no lock" and then both write their PID.
 */
/**
 * Atomically create the lock file with O_EXCL and write our PID.
 * Returns true if the file was created, false if it already existed.
 */
function atomicCreateLock(): boolean {
  try {
    const fd = openSync(lockFilePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    writeSync(fd, Buffer.from(String(process.pid), "utf-8"));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function acquireWatchdogLock(): boolean {
  const dir = join(lockFilePath, "..");
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* dir exists */ }

  // Try atomic creation first — O_CREAT | O_EXCL | O_WRONLY fails if file exists
  if (atomicCreateLock()) return true;

  // Lock file exists — check for stale PID
  try {
    const content = readFileSync(lockFilePath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid) && isPidAlive(pid)) {
      return false; // Another live watchdog holds the lock
    }
  } catch { /* Can't read lock file — treat as stale */ }

  // Stale lock — remove and try atomic creation again
  try { unlinkSync(lockFilePath); } catch { /* race with another process */ }
  return atomicCreateLock();
}

/**
 * Release the watchdog lock file.
 * Only removes the file if it contains our PID.
 */
export function releaseWatchdogLock(): void {
  try {
    const content = readFileSync(lockFilePath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (pid === process.pid) {
      unlinkSync(lockFilePath);
    }
  } catch { /* lock file doesn't exist or already removed */ }
}

/**
 * Read the PID from the lock file, or null if no valid lock exists.
 */
export function readLockPid(): number | null {
  try {
    const content = readFileSync(lockFilePath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid)) return pid;
  } catch { /* no lock file */ }
  return null;
}

// ---------------------------------------------------------------------------
// Disk-based agent provider (for standalone watchdog)
// ---------------------------------------------------------------------------

/** Injectable readAllAgents for testing */
type ReadAllAgentsFn = typeof readAllAgents;
let readAllAgentsFn: ReadAllAgentsFn = readAllAgents;

/** Injectable detectAgentStates for testing */
type DetectAgentStatesFn = typeof detectAgentStates;
let detectAgentStatesFn: DetectAgentStatesFn = detectAgentStates;

/** Override readAllAgents for testing */
export function setDiskProviderReadAllAgents(fn: ReadAllAgentsFn): void {
  readAllAgentsFn = fn;
}

/** Reset readAllAgents to default */
export function resetDiskProviderReadAllAgents(): void {
  readAllAgentsFn = readAllAgents;
}

/** Override detectAgentStates for testing */
export function setDiskProviderDetectAgentStates(fn: DetectAgentStatesFn): void {
  detectAgentStatesFn = fn;
}

/** Reset detectAgentStates to default */
export function resetDiskProviderDetectAgentStates(): void {
  detectAgentStatesFn = detectAgentStates;
}

/**
 * Create an AgentProvider that reads agents from disk on every call.
 * Uses readAllAgents() + detectAgentStates() to get fresh state each tick.
 * This is the standalone watchdog's provider — no TUI dependency.
 */
export function createDiskAgentProvider(repos: RepoEntry[]): AgentProvider {
  return async () => {
    const { agents } = await readAllAgentsFn(repos);
    if (agents.length > 0) {
      await detectAgentStatesFn(agents);
    }
    return agents;
  };
}

// ---------------------------------------------------------------------------
// Core watchdog loop
// ---------------------------------------------------------------------------

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let agentProvider: AgentProvider | null = null;

/**
 * Process a single tick of the watchdog loop.
 * Exported for testing — in production, called by setInterval.
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

/** Recursively collect all agent IDs */
function collectIds(agents: Agent[], ids: Set<string>): void {
  for (const agent of agents) {
    ids.add(agent.id);
    collectIds(agent.children, ids);
  }
}

/** States that use the wait counter / backoff system */
const BACKOFF_STATES = new Set<AgentState>(["waiting", "unknown"]);

/** Recursively process all agents through their state handlers */
async function processAgents(agents: Agent[], allAgents: Agent[]): Promise<void> {
  for (const agent of agents) {
    const tracker = getTracker(agent.id);
    const handler = stateHandlers.get(agent.state);

    if (handler) {
      await handler(agent, tracker, allAgents);
    }

    // Reset wait counter and backoff when transitioning away from backoff states.
    // Matches bash watchdog: running/creating/complete/stopped/compacting/rate_limited
    // all reset waiting_counter=0 and notify_interval=6.
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
          const config = await readConfigFn(agent.repoPath);
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
 * Start the watchdog loop.
 * Accepts an AgentProvider function that returns the current agent list
 * on each tick. Typically, the caller passes a closure over the watcher's
 * cached agents (e.g., `() => watcher.lastAgents`).
 */
export function startWatchdog(provider: AgentProvider): void {
  if (watchdogTimer) return; // Already running

  agentProvider = provider;

  // Run the watchdog tick every POLL_INTERVAL_MS
  watchdogTimer = setInterval(async () => {
    try {
      const agents = await Promise.resolve(agentProvider?.() ?? []);
      if (agents.length > 0) {
        await tick(agents);
      }
    } catch (err) {
      // Log but don't crash — unhandled rejections in setInterval are fatal
      console.error("[watchdog] tick error:", err);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the watchdog loop and clean up.
 */
export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  agentProvider = null;
  trackers.clear();
}

/**
 * Check if a watchdog is currently running.
 * Reads the lock file and checks if the PID is alive.
 * Works across processes — the TUI can detect a standalone watchdog.
 */
export function isWatchdogRunning(): boolean {
  const pid = readLockPid();
  if (pid === null) return false;
  return isPidAlive(pid);
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

/** Injectable sleep for testing */
let sleepFn: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms);

/** Override sleep for testing */
export function setPerAgentSleep(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

/** Reset sleep to default */
export function resetPerAgentSleep(): void {
  sleepFn = (ms) => Bun.sleep(ms);
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
  const agentDir = join(repoPath, ".ittybitsy", "agents", agentId);
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
        tmuxGoneSince = nowFn();
      } else if (nowFn() - tmuxGoneSince >= TMUX_GONE_GRACE_MS) {
        // Exit condition (b): tmux gone for >10s
        break;
      }
    } else {
      // Tmux session exists — reset grace period
      tmuxGoneSince = null;

      // Build an Agent object for state detection
      // captureTmuxOutput already returns ANSI-stripped text
      const result = parseState(output);

      const agent: Agent = {
        id: agentId,
        repoPath,
        repoName: "",
        meta,
        state: result.state,
        age: "",
        archived: false,
        children: [],
      };

      // Run state handler
      const handler = stateHandlers.get(result.state);
      if (handler) {
        try {
          // For notifyManager, we need allAgents — but per-agent watchdog
          // only knows about this agent. Read siblings from disk.
          const allAgents = await loadAllAgentsForNotification(repoPath);
          await handler(agent, tracker, allAgents);
        } catch { /* don't crash */ }
      }

      // Reset backoff for non-backoff states
      if (!BACKOFF_STATES.has(result.state)) {
        tracker.waitCounter = 0;
        tracker.notifyInterval = INITIAL_NOTIFY_TICKS;
      }

      tracker.previousState = result.state;

      // Auto-compact check
      if (result.state === "running" || result.state === "waiting") {
        const now = nowFn();
        if (now - tracker.lastCompactCheckMs >= COMPACT_CHECK_COOLDOWN_MS) {
          tracker.lastCompactCheckMs = now;
          try {
            const config = await readConfigFn(repoPath);
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
 * Load all agents from disk for notification purposes (finding the manager).
 * Best-effort — returns empty array on failure.
 */
async function loadAllAgentsForNotification(repoPath: string): Promise<Agent[]> {
  try {
    const repoName = repoPath.split("/").pop() ?? "";
    const { agents } = await readRepoAgents(repoPath, repoName);
    if (agents.length > 0) {
      await detectAgentStates(agents);
    }
    return agents;
  } catch {
    return [];
  }
}
