/**
 * Built-in watchdog for itsybitsy.
 * Monitors all agents across all repos via the AgentWatcher,
 * detects state transitions, and notifies managers when agents
 * need attention (waiting, unknown, complete, rate_limited).
 *
 * Coexists with ib's per-agent bash watchdog — duplicate notifications
 * are harmless since managers already handle repeated messages.
 *
 * Phase 15-A: Core loop + waiting/unknown handler with exponential backoff.
 * Phase 15-B: complete/running/creating/compacting/stopped/rate_limited handlers.
 * Phase 15-C will add auto-compact support.
 */

import type { Agent } from "./agents";
import type { AgentState } from "./parse-state";
import { sendMessage } from "./ib-commands";
import { fetchUsage } from "./usage";
import type { UsageData } from "./usage";
import type { SpawnFn } from "./types";

/** Function that returns the current list of agents. Used by the watchdog loop. */
export type AgentProvider = () => Agent[];

/** Per-agent tracking state managed by the watchdog */
export interface AgentTracker {
  previousState: AgentState | null;
  waitCounter: number;
  notifyInterval: number; // in ticks (each tick = POLL_INTERVAL_MS)
  completionNotified: boolean;
  rateLimitBypassed: boolean;
}

/** How often the watchdog polls, in milliseconds */
export const POLL_INTERVAL_MS = 5_000;

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

let spawnRunner: SpawnFn = Bun.spawn as SpawnFn;

/** Override spawn runner for testing (used by rate limit bypass). */
export function setWatchdogSpawnRunner(runner: SpawnFn): void {
  spawnRunner = runner;
}

/** Reset spawn runner to default. */
export function resetWatchdogSpawnRunner(): void {
  spawnRunner = Bun.spawn as SpawnFn;
}

/** Overridable fetchUsage for testing. */
let fetchUsageFn: () => Promise<UsageData | null> = fetchUsage;

/** Override fetchUsage for testing. */
export function setWatchdogFetchUsage(fn: () => Promise<UsageData | null>): void {
  fetchUsageFn = fn;
}

/** Reset fetchUsage to default. */
export function resetWatchdogFetchUsage(): void {
  fetchUsageFn = fetchUsage;
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
    const proc = spawnRunner(
      ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
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
 */
async function handleUnknown(agent: Agent, tracker: AgentTracker, allAgents: Agent[]): Promise<void> {
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
  const usage = await fetchUsageFn();
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
    const agents = agentProvider?.() ?? [];
    if (agents.length > 0) {
      await tick(agents);
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

/** Check if the watchdog is currently running */
export function isWatchdogRunning(): boolean {
  return watchdogTimer !== null;
}
