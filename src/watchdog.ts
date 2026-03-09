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
 * Phase 15-B will add complete/running/stopped/rate_limited handlers.
 * Phase 15-C will add auto-compact support.
 */

import type { Agent } from "./agents";
import type { AgentState } from "./parse-state";
import { sendMessage } from "./ib-commands";

/** Function that returns the current list of agents. Used by the watchdog loop. */
export type AgentProvider = () => Agent[];

/** Per-agent tracking state managed by the watchdog */
export interface AgentTracker {
  previousState: AgentState | null;
  waitCounter: number;
  notifyInterval: number; // in ticks (each tick = POLL_INTERVAL_MS)
  completionNotified: boolean;
}

/** How often the watchdog polls, in milliseconds */
export const POLL_INTERVAL_MS = 5_000;

/** Initial notification threshold in ticks (6 ticks * 5s = 30s) */
export const INITIAL_NOTIFY_TICKS = 6;

/** Maximum notification interval in ticks (768 ticks * 5s = 3840s = 64 minutes) */
export const MAX_NOTIFY_TICKS = 768;

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

/** Create a fresh tracker for a newly-seen agent */
export function createTracker(): AgentTracker {
  return {
    previousState: null,
    waitCounter: 0,
    notifyInterval: INITIAL_NOTIFY_TICKS,
    completionNotified: false,
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

// ---------------------------------------------------------------------------
// Built-in state handlers
// ---------------------------------------------------------------------------

/**
 * Handler for "waiting" state.
 * Increments wait counter. After threshold, notifies manager with exponential backoff.
 * Backoff: 30s → 1m → 2m → 4m → 8m → 16m → 32m → 64m cap.
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

// Register built-in handlers
registerStateHandler("waiting", handleWaiting);
registerStateHandler("unknown", handleUnknown);

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
