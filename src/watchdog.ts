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
import { readRepoAgents, readAllAgents, isCompacting, isRateLimited, isApiError, readAgentState, hasBackgroundTasks, anyChildActive, writeAgentTransient } from "./agents";
import type { Agent, TransientState } from "./agents";
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
  /** Number of "please retry" nudges sent for the current api_error episode */
  apiErrorRetries: number;
  /** Wall-clock ms of the last "please retry" nudge (0 = never sent) */
  apiErrorLastAtMs: number;
}

/**
 * Sentinel sender ID for watchdog-originated messages. Recipients see
 * `[sent by watchdog]: ...` so they can distinguish auto-injected nudges
 * (rate-limit recovery, api_error retries, manager/spawner notifications)
 * from human user sends, which would otherwise look identical because the
 * watchdog's cwd is the agent's root repo (not an agent worktree) and so
 * falls through to the user-prefix branch in sendMessage.
 *
 * The constant value retains the `@` prefix because sendMessage's prefix
 * formatter uses `startsWith("@")` to discriminate sentinels from real agent
 * IDs (so the literal word "agent" is omitted). The displayed `@` is then
 * stripped via the `BARE_RENDERED_SENTINELS` allow-list in ib-commands.ts —
 * `@watchdog` deliberately renders without the `@` to avoid being misread as
 * the routable `@<repo-name>` coordinator namespace.
 */
export const WATCHDOG_SENTINEL = "@watchdog";

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

/**
 * Lazy thunk so handlers that don't need allAgents skip the disk read;
 * per-tick memoized + TTL-cached (ALL_AGENTS_TTL_MS).
 */
export type GetAllAgents = () => Promise<Agent[]>;

/** State handler function signature — called on each tick for each agent */
export type StateHandler = (
  agent: Agent,
  tracker: AgentTracker,
  getAllAgents: GetAllAgents,
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

/**
 * Create a fresh tracker for a newly-seen agent.
 *
 * `lastCompactCheckMs` is initialized to `nowFn()` so the cooldown gate
 * (`now - lastCompactCheckMs >= COMPACT_CHECK_COOLDOWN_MS`) is NOT satisfied
 * on the very first tick after a tracker is created. This gives every newly-
 * tracked agent a `COMPACT_CHECK_COOLDOWN_MS` grace period before the first
 * eligibility check — important for freshly-resumed agents whose prior
 * transcript may already exceed `autoCompactThreshold`.
 */
export function createTracker(): AgentTracker {
  return {
    previousState: null,
    waitCounter: 0,
    notifyInterval: INITIAL_NOTIFY_TICKS,
    completionNotified: false,
    rateLimitBypassed: false,
    compactState: { compactSent: false },
    lastCompactCheckMs: nowFn(),
    apiErrorRetries: 0,
    apiErrorLastAtMs: 0,
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
 *
 * Returns `true` only when a real notification reached the manager.
 * Returns `false` if the agent has no manager, the manager cannot be found
 * in the snapshot, or `sendMessage` reported failure. Callers MUST gate
 * any state advance (counter reset, backoff doubling, completionNotified
 * flag-set) on this result so a transient delivery failure does not get
 * silently swallowed.
 */
export async function notifyManager(
  agent: Agent,
  message: string,
  allAgents: Agent[],
): Promise<boolean> {
  const managerId = agent.meta.manager;
  if (!managerId) return false;

  const manager = findAgent(allAgents, managerId);
  if (!manager) return false;

  const result = await sendMessage(manager, message, { fromAgent: WATCHDOG_SENTINEL });
  return result.ok;
}

/**
 * Send a watchdog notification to the agent's spawner.
 *
 * Routing:
 *   - `@system` → deliver to the system coordinator's tmux session via
 *     sendToSystemCoordinator (the same direct-tmux path `ib send @system` uses)
 *   - `@<repo-name>` → look up the repo, find its per-repo coordinator, sendMessage
 *   - real agent_id → findAgent + sendMessage (existing path)
 *
 * Returns `true` only when a real notification was delivered.
 * Returns `false` if the agent has no spawned_by, the spawner === manager,
 * the spawner cannot be resolved, the underlying delivery reported failure,
 * or any unexpected error was thrown during routing. Callers MUST gate
 * state advance on this result so a transient delivery failure does not get
 * silently swallowed.
 *
 * Error policy: all three branches behave the same — never throw, always
 * return a boolean. Wrap each branch in try/catch so an unexpected disk
 * error in one branch can never crash the watchdog or be mistaken for
 * "delivered".
 */
export async function notifySpawner(
  agent: Agent,
  message: string,
  allAgents: Agent[],
): Promise<boolean> {
  const spawner = agent.meta.spawned_by;
  if (!spawner) return false;
  // Defense-in-depth: callers in handleWaiting/handleUnknown/handleComplete
  // already enforce mutual exclusivity by skipping notifySpawner when manager
  // is set. This guard remains so direct callers (and tests) still get the
  // same dedupe semantics as before.
  if (spawner.agent_id === agent.meta.manager) return false;

  // @system → deliver via the same direct-tmux path `ib send @system` uses.
  if (spawner.agent_id === "@system") {
    try {
      const { sendToSystemCoordinator } = await import("./index");
      const result = await sendToSystemCoordinator(message, { fromAgent: WATCHDOG_SENTINEL });
      return result.ok;
    } catch { /* swallowed unexpected error counts as delivery failure */
      return false;
    }
  }

  // @<repo-name> → resolve to that repo's per-repo coordinator.
  if (spawner.agent_id.startsWith("@")) {
    const repoName = spawner.agent_id.slice(1);
    try {
      const { basename: pathBasename } = await import("path");
      const repos = await listReposFn();
      // Match by `basename(repo.path)`, NOT repo.name or repoDisplayName.
      // This is the same invariant `getCoordinatorAgentId()` uses for the
      // coordinator's actual agent ID. ib-commands stamps the @<repo-name>
      // sentinel with basename(cwd) for the same reason. Any other lookup
      // here (registry name, nickname) silently breaks for repos whose
      // user-overridden name differs from the directory basename.
      const repo = repos.find((r) => pathBasename(r.path) === repoName);
      if (!repo) return false;
      const { checkCoordinatorExists } = await import("./coordinator");
      const coordStatus = await checkCoordinatorExists(repo.path);
      if (!coordStatus.exists || !coordStatus.agentId) return false;
      const coordinator = findAgent(allAgents, coordStatus.agentId);
      if (!coordinator) return false;
      const result = await sendMessage(coordinator, message, { fromAgent: WATCHDOG_SENTINEL });
      return result.ok;
    } catch { /* swallowed unexpected error counts as delivery failure */
      return false;
    }
  }

  // Real agent ID — existing path.
  try {
    const spawnerAgent = findAgent(allAgents, spawner.agent_id);
    if (!spawnerAgent) return false;
    const result = await sendMessage(spawnerAgent, message, { fromAgent: WATCHDOG_SENTINEL });
    return result.ok;
  } catch {
    return false;
  }
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
 *
 * Work-in-flight suppression (SPEC §8.5.1):
 *   If the agent has a direct background shell OR at least one direct child
 *   that is actively doing work (meta.state === "running" OR recently created),
 *   suppress BOTH notifyManager and notifySpawner AND pause the counter.
 *
 *   The background-shell check here is deliberately redundant: the resolver
 *   override in resolveWatchdogState() already reclassifies waiting+bg as
 *   "running", so handleWaiting typically isn't dispatched to in that case.
 *   This belt-and-braces check guards against a future refactor that
 *   removes the resolver override — do NOT delete it as dead code.
 *
 *   Counter is checked BEFORE `waitCounter++` so suppression pauses the
 *   counter at its previous value; it resumes when suppression lifts,
 *   preserving any in-flight backoff (`notifyInterval`).
 */
async function handleWaiting(agent: Agent, tracker: AgentTracker, getAllAgents: GetAllAgents): Promise<void> {
  const tmuxSession = agent.meta.tmux_session;
  let bgActive = false;
  if (tmuxSession && isValidTmuxSession(tmuxSession)) {
    try {
      const output = await watchdogCaptureTmuxFn(tmuxSession);
      bgActive = output !== null && hasBackgroundTasks(output);
    } catch { /* treat capture failures as not-bg-active */ }
  }

  // Fast path: bg-active waiters are common steady state — return before
  // touching the snapshot to keep the per-tick cost at ~0 disk reads.
  if (bgActive) return;

  // Flat-filter on meta.manager — see loadAllAgentsForNotification: the
  // per-agent watchdog does NOT call buildAgentTree(), so agent.children is
  // empty. A future maintainer must not replace this with an agent.children
  // walk or the CLI watchdog path will silently break.
  const allAgents = await getAllAgents();
  if (anyChildActive(agent.id, allAgents)) return;

  tracker.waitCounter++;

  if (tracker.waitCounter >= tracker.notifyInterval) {
    // Mutually-exclusive precedence: manager wins if present; otherwise the
    // spawner is notified; otherwise nothing. Previously we notified both
    // when they differed, which led to duplicate noise for cross-repo spawns.
    let notified = false;
    if (agent.meta.manager) {
      notified = await notifyManager(
        agent,
        `[watchdog]: Your subtask ${agent.id} recently started waiting for input`,
        allAgents,
      );
    } else if (agent.meta.spawned_by) {
      notified = await notifySpawner(
        agent,
        `[watchdog]: Agent ${agent.id} you spawned recently started waiting for input`,
        allAgents,
      );
    } else {
      // No recipient at all — there is no point retrying every tick.
      // Treat as "fully handled" so the backoff still kicks in.
      notified = true;
    }

    // Only reset counter and advance backoff on successful (or no-op)
    // delivery. A transient delivery failure must not silently advance
    // the backoff — we want to keep nagging until delivery succeeds.
    if (notified) {
      tracker.waitCounter = 0;
      tracker.notifyInterval = Math.min(tracker.notifyInterval * 2, MAX_NOTIFY_TICKS);
    } else {
      // Hold the counter just below the threshold so we retry on the next
      // tick instead of waiting for the (now-doubled) interval.
      tracker.waitCounter = Math.max(0, tracker.notifyInterval - 1);
    }
  }
}

/**
 * Handler for "unknown" state.
 * Same exponential backoff as waiting — agent may need attention.
 * On first transition into unknown, saves tmux output to debug-logs/ (matches bash watchdog).
 */
async function handleUnknown(agent: Agent, tracker: AgentTracker, getAllAgents: GetAllAgents): Promise<void> {
  // Save debug log on transition into unknown state (not on every tick)
  if (tracker.previousState !== "unknown") {
    await saveUnknownDebugLog(agent);
  }

  tracker.waitCounter++;

  if (tracker.waitCounter >= tracker.notifyInterval) {
    // Only resolve allAgents when we actually need to notify — most ticks in
    // unknown state increment the counter without notifying.
    const allAgents = await getAllAgents();
    // Mutually-exclusive precedence — see handleWaiting for rationale.
    let notified = false;
    if (agent.meta.manager) {
      notified = await notifyManager(
        agent,
        `[watchdog]: Your subtask ${agent.id} state is unknown - may need attention`,
        allAgents,
      );
    } else if (agent.meta.spawned_by) {
      notified = await notifySpawner(
        agent,
        `[watchdog]: Agent ${agent.id} you spawned has an unknown state - may need attention`,
        allAgents,
      );
    } else {
      notified = true;
    }

    // Backoff only advances on successful delivery — see handleWaiting.
    if (notified) {
      tracker.waitCounter = 0;
      tracker.notifyInterval = Math.min(tracker.notifyInterval * 2, MAX_NOTIFY_TICKS);
    } else {
      tracker.waitCounter = Math.max(0, tracker.notifyInterval - 1);
    }
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
async function handleComplete(agent: Agent, tracker: AgentTracker, getAllAgents: GetAllAgents): Promise<void> {
  if (!tracker.completionNotified) {
    // Only resolve allAgents on the one-shot notification — subsequent ticks
    // in complete state hit the early return and never load the snapshot.
    const allAgents = await getAllAgents();
    // Mutually-exclusive precedence — see handleWaiting for rationale.
    let notified = false;
    if (agent.meta.manager) {
      notified = await notifyManager(
        agent,
        `[watchdog]: Your subtask ${agent.id} recently completed`,
        allAgents,
      );
    } else if (agent.meta.spawned_by) {
      notified = await notifySpawner(
        agent,
        `[watchdog]: Agent ${agent.id} you spawned recently completed`,
        allAgents,
      );
    } else {
      // No recipient — flag-set immediately so we don't retry forever.
      notified = true;
    }
    // Only set the one-shot flag when delivery actually succeeded. A
    // transient delivery failure must not silently swallow the
    // completion notification — we want the next tick to retry.
    if (notified) {
      tracker.completionNotified = true;
    }
  }
}

/**
 * Handler for "running" state.
 * Resets counters (done by processAgents for all non-backoff states).
 * Only running clears completionNotified — matches ib bash (lines 14573-14578).
 */
async function handleRunning(_agent: Agent, tracker: AgentTracker, _getAllAgents: GetAllAgents): Promise<void> {
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
async function handleCreating(_agent: Agent, tracker: AgentTracker, _getAllAgents: GetAllAgents): Promise<void> {
  tracker.rateLimitBypassed = false;
}

/**
 * Handler for "compacting" state.
 * Agent is compacting context — normal operation, just reset rate limit bypass flag.
 * Does NOT clear completionNotified (matches ib bash).
 */
async function handleCompacting(_agent: Agent, tracker: AgentTracker, _getAllAgents: GetAllAgents): Promise<void> {
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
async function handleRateLimited(agent: Agent, tracker: AgentTracker, _getAllAgents: GetAllAgents): Promise<void> {
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
      { fromAgent: WATCHDOG_SENTINEL },
    );
    // Reset bypass flag so next rate-limit episode will re-bypass
    tracker.rateLimitBypassed = false;
  }
}

/**
 * Handler for "stopped" state.
 * No-op — counter reset is handled by processAgents for all non-backoff states.
 */
async function handleStopped(_agent: Agent, _tracker: AgentTracker, _getAllAgents: GetAllAgents): Promise<void> {
  // No-op
}

/** Maximum number of "please retry" nudges per api_error episode */
export const API_ERROR_MAX_RETRIES = 5;

/** Minimum wall-clock interval between "please retry" nudges, in milliseconds */
export const API_ERROR_RETRY_INTERVAL_MS = 10_000;

/**
 * Handler for "api_error" state.
 *
 * Claude has displayed a transient API error (e.g. "Stream idle timeout",
 * 5xx, connection error) and is idling waiting for the user to type
 * "please retry". We do that automatically, capped at API_ERROR_MAX_RETRIES
 * per episode and rate-limited to one nudge per API_ERROR_RETRY_INTERVAL_MS
 * so we don't loop hot on a persistent outage.
 *
 * Counter reset for this state happens in processAgents: when any non-api_error
 * state is observed, we clear the retry counters so a successful recovery
 * (or a different transient state) starts the next episode from zero.
 */
async function handleApiError(agent: Agent, tracker: AgentTracker, _getAllAgents: GetAllAgents): Promise<void> {
  if (tracker.apiErrorRetries >= API_ERROR_MAX_RETRIES) {
    // One-shot log on the tick we hit the cap so user knows we backed off.
    if (tracker.previousState !== "api_error") {
      const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
      try {
        await logAgent(agentDir, `[watchdog] api_error: hit MAX_RETRIES (${API_ERROR_MAX_RETRIES}) — leaving agent for user intervention`);
      } catch { /* best-effort */ }
    }
    return;
  }

  const now = nowFn();
  if (tracker.apiErrorLastAtMs > 0 && now - tracker.apiErrorLastAtMs < API_ERROR_RETRY_INTERVAL_MS) {
    // Too soon since last retry — skip this tick.
    return;
  }

  tracker.apiErrorLastAtMs = now;
  tracker.apiErrorRetries++;
  await sendMessage(agent, "please retry", { fromAgent: WATCHDOG_SENTINEL });
}

// Register built-in handlers
registerStateHandler("waiting", handleWaiting);
registerStateHandler("unknown", handleUnknown);
registerStateHandler("complete", handleComplete);
registerStateHandler("running", handleRunning);
registerStateHandler("creating", handleCreating);
registerStateHandler("compacting", handleCompacting);
registerStateHandler("rate_limited", handleRateLimited);
registerStateHandler("api_error", handleApiError);
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
  const getAllAgents: GetAllAgents = async () => allAgents;
  for (const agent of agents) {
    const tracker = getTracker(agent.id);
    const handler = stateHandlers.get(agent.state);

    if (handler) {
      await handler(agent, tracker, getAllAgents);
    }

    // Reset wait counter and backoff when transitioning away from backoff states.
    if (!BACKOFF_STATES.has(agent.state)) {
      tracker.waitCounter = 0;
      tracker.notifyInterval = INITIAL_NOTIFY_TICKS;
    }

    // Reset api_error retry tracking when state has moved off api_error.
    // Any non-api_error tick clears the slate so the next episode starts fresh.
    if (agent.state !== "api_error") {
      tracker.apiErrorRetries = 0;
      tracker.apiErrorLastAtMs = 0;
    }

    // Update previous state after handler runs
    tracker.previousState = agent.state;

    // Auto-compact check with per-agent cooldown
    if (agent.state === "running" || agent.state === "waiting") {
      const now = nowFn();
      if (now - tracker.lastCompactCheckMs >= COMPACT_CHECK_COOLDOWN_MS) {
        const priorCheckMs = tracker.lastCompactCheckMs;
        tracker.lastCompactCheckMs = now;
        try {
          const config = await readConfigFn();
          const thresholdEntry = config["autoCompactThreshold"];
          const threshold = thresholdEntry?.value as number | undefined;
          if (threshold != null && threshold > 0) {
            await checkAndCompact(agent, threshold, tracker.compactState, priorCheckMs);
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
export function resolveWatchdogState(tmuxOutput: string, metaState: MetaState | undefined): AgentState {
  // Step 1: transient tmux overrides.
  // Order among compacting / rate_limited / api_error is mostly cosmetic — they are
  // mutually exclusive in practice (an agent showing "Compacting conversation" does
  // not also show "API Error:"). Compacting is checked first because it is the
  // most narrowly scoped (last 5 lines) and the cheapest signal to validate.
  if (isCompacting(tmuxOutput)) return "compacting";
  if (isRateLimited(tmuxOutput)) return "rate_limited";
  if (isApiError(tmuxOutput)) return "api_error";
  // Background-shell override: waiting agents with a live background shell
  // are actually still doing work. Scoped strictly to meta.state === "waiting" —
  // we do NOT override "complete" (intentional sign-off) or "running" (already
  // correct). This is the primary Case 1 suppression; the handleWaiting
  // bg-shell check is belt-and-braces redundancy after this.
  if (metaState === "waiting" && hasBackgroundTasks(tmuxOutput)) return "running";
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
        if (
          /trust/i.test(output) ||
          /Allow external CLAUDE\.md file imports/i.test(output) ||
          /New MCP server found/i.test(output) ||
          /\d+ new MCP servers? found/i.test(output)
        ) {
          await logAgent(agentDir, "[watchdog] Detected permissions prompt — sending Enter to accept");
          await sendTmuxEnter(tmuxSession);
          await sleepFn(POLL_INTERVAL_MS);
          continue;
        }
      }

      // Persist transient observations so ib watch can skip its own
      // tmux capture for this agent. Single writer (this watchdog), so
      // no lock is needed; readers gate on watchdog liveness + freshness.
      const transientSnapshot: TransientState = {
        tmux_compacting: isCompacting(output),
        tmux_rate_limited: isRateLimited(output),
        tmux_api_error: isApiError(output),
        has_background_tasks: hasBackgroundTasks(output),
        updated_at_ms: nowFn(),
        watchdog_pid: process.pid,
      };
      await writeAgentTransient(agentDir, transientSnapshot);

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
          const getAllAgents = makeLazyAllAgents();
          await handler(agent, tracker, getAllAgents);
        } catch { /* don't crash */ }
      }

      // Reset backoff for non-backoff states
      if (!BACKOFF_STATES.has(resolvedState)) {
        tracker.waitCounter = 0;
        tracker.notifyInterval = INITIAL_NOTIFY_TICKS;
      }

      // Reset api_error retry tracking when state has moved off api_error.
      if (resolvedState !== "api_error") {
        tracker.apiErrorRetries = 0;
        tracker.apiErrorLastAtMs = 0;
      }

      tracker.previousState = resolvedState;

      // Auto-compact check
      if (resolvedState === "running" || resolvedState === "waiting") {
        const now = nowFn();
        if (now - tracker.lastCompactCheckMs >= COMPACT_CHECK_COOLDOWN_MS) {
          const priorCheckMs = tracker.lastCompactCheckMs;
          tracker.lastCompactCheckMs = now;
          try {
            const config = await readConfigFn();
            const thresholdEntry = config["autoCompactThreshold"];
            const threshold = thresholdEntry?.value as number | undefined;
            if (threshold != null && threshold > 0) {
              await checkAndCompact(agent, threshold, tracker.compactState, priorCheckMs);
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
 * 10s — covers two 5s POLL_INTERVAL_MS ticks; bounded staleness vs. the 30s
 * INITIAL_NOTIFY_TICKS threshold so a manager spawned mid-window is still
 * visible before the first notification fires.
 */
export const ALL_AGENTS_TTL_MS = 10_000;

type ListReposFn = typeof listRepos;
type ReadAllAgentsFn = typeof readAllAgents;
let listReposFn: ListReposFn = listRepos;
let readAllAgentsFn: ReadAllAgentsFn = readAllAgents;

export function setWatchdogListRepos(fn: ListReposFn): void {
  listReposFn = fn;
}

export function resetWatchdogListRepos(): void {
  listReposFn = listRepos;
}

export function setWatchdogReadAllAgents(fn: ReadAllAgentsFn): void {
  readAllAgentsFn = fn;
}

export function resetWatchdogReadAllAgents(): void {
  readAllAgentsFn = readAllAgents;
}

/** TTL cache for the cross-repo agent snapshot. */
let allAgentsCache: { snapshot: Agent[]; expiresAtMs: number } | null = null;

export function clearAllAgentsCache(): void {
  allAgentsCache = null;
}

/**
 * Best-effort load of all agents across registered repos for notifications
 * (manager/spawner lookup). Empty result on failure is NOT cached, so a
 * transient disk error doesn't hide newly-spawned managers for the full TTL.
 */
async function loadAllAgentsForNotification(): Promise<Agent[]> {
  const now = nowFn();
  if (allAgentsCache && now < allAgentsCache.expiresAtMs) {
    return allAgentsCache.snapshot;
  }

  try {
    // Read all registered repos so cross-repo spawners can be found by findAgent().
    // The previous implementation only read the agent's own repo, which made
    // cross-repo notifySpawner impossible since findAgent can't locate the spawner.
    const repos = await listReposFn();
    const { agents } = await readAllAgentsFn(repos.map(r => ({ path: r.path, name: r.name })));
    // Note: buildAgentTree() is NOT called here. findAgent() iterates the flat
    // array first (exact ID match) so tree structure is unnecessary for notifications.
    // Also note: detectAgentStates() is intentionally omitted — sendMessage() sends
    // tmux keys directly and does not check agent state, so state detection adds
    // overhead with no benefit on the notification path.
    // Snapshot is shared by reference — handlers MUST treat it as read-only.
    allAgentsCache = { snapshot: agents, expiresAtMs: now + ALL_AGENTS_TTL_MS };
    return agents;
  } catch {
    return [];
  }
}

/** Per-tick memoization layer over the TTL cache. Exported for tests. */
export function makeLazyAllAgents(): GetAllAgents {
  let cached: Promise<Agent[]> | null = null;
  return () => {
    if (!cached) {
      cached = loadAllAgentsForNotification();
    }
    return cached;
  };
}

