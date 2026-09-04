/**
 * Watch each repo's .ittybitty/agents/ directory (shallow / non-recursive) with
 * fs.watch, so the watch stays off macOS fseventsd — see the rationale at the
 * watch() call in setupWatchersAsync (recursive watching pegged fseventsd at
 * ~100% CPU and cost ~27s at startup). NOTE: on Bun 1.3.10 / macOS a
 * non-recursive DIRECTORY watch does not fire on entry changes, so the way the
 * dashboard actually stays current is the polling below: a 3s structural refresh
 * (readAllAgents — catches spawn / retire and out-of-band meta.json edits) plus a
 * 2s state poll. The agents/ watch is kept as a cheap, dormant fast-path for
 * platforms / Bun versions that do dispatch directory events; dashboard-initiated
 * edits refresh immediately via executeAndRefresh regardless.
 * Captures tmux output and feeds it through parseState() for each active agent.
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { readAllAgents, buildAgentTree, flattenAgentTree, readPendingQuestions, detectAgentStates, computeAge } from "./agents";
import type { Agent, FlatEntry, PendingQuestion, ReadAgentsResult } from "./agents";
import { repoDisplayName } from "./registry";
import type { RepoEntry } from "./registry";
import { checkRepoHealth, checkGlobalHealth } from "./health-check";
import type { RepoHealthReport, RepoHealthWarning } from "./health-check";
import { pollSystemCoordinator, IB_COORDINATOR_SESSION } from "./coordinator";
import { spawnCtx as tmuxSpawnCtx } from "./tmux-poller";
import { InjectionContext } from "./types";
import { tmuxSessionTarget } from "./validation";
import { logToWatchLog } from "./watch-log";

/**
 * Map `items` through `fn` with at most `chunkSize` calls in flight at once,
 * preserving input order in the returned results. Each chunk fully settles
 * before the next begins, so peak concurrency never exceeds `chunkSize`. Used
 * to bound the per-repo `git` spawn burst in health checks (a big Promise.all
 * over ~50 repos would launch 150+ processes in one tick). A non-positive
 * `chunkSize` degrades to a single all-at-once Promise.all.
 */
export async function mapInChunks<T, R>(
  items: readonly T[],
  chunkSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (chunkSize <= 0) return Promise.all(items.map((item, i) => fn(item, i)));
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const settled = await Promise.all(chunk.map((item, j) => fn(item, i + j)));
    results.push(...settled);
  }
  return results;
}

/**
 * Injectable bundle of the ./agents functions AgentWatcher consumes. Defaults
 * to the real implementations; tests inject fakes via `agentsCtx.set(...)` and
 * restore with `agentsCtx.reset()`. This replaces the old per-file
 * `mock.module("./agents", ...)` in watcher.test.ts — bun's mock.module is a
 * PROCESS-GLOBAL registry that is never auto-restored, so stubbing ./agents
 * there leaked into any later-loading test file whose ./agents binding resolved
 * afterward (it would receive the mockReset()-emptied stubs and get `undefined`
 * back from readAllAgents/buildAgentTree). Scoping the seam to this context
 * keeps the swap local to the watcher and off the global module registry.
 * Mirrors the SpawnContext pattern in types.ts (tmux-poller's spawnCtx,
 * coordinator's coordinatorSpawnCtx).
 */
export interface WatcherAgentsApi {
  readAllAgents: (repos: Array<{ path: string; name: string }>, includeArchived: boolean) => Promise<ReadAgentsResult>;
  detectAgentStates: (
    agents: Agent[],
    opts?: { reap?: boolean; confirmTmuxMissingAcrossPolls?: boolean }
  ) => Promise<void>;
  buildAgentTree: (agents: Agent[]) => Agent[];
  flattenAgentTree: (roots: Agent[], repos?: string[] | { name: string; path: string }[], coordinator?: { state: string; age: string }, groupByParent?: boolean) => FlatEntry[];
  readPendingQuestions: (repoPath: string) => Promise<PendingQuestion[]>;
}

export const agentsCtx = new InjectionContext<WatcherAgentsApi>({
  readAllAgents,
  detectAgentStates,
  buildAgentTree,
  flattenAgentTree,
  readPendingQuestions,
});

export interface WatcherEvents {
  onUpdate: (agents: Agent[], flatList: FlatEntry[], questions: PendingQuestion[], orphanedTmuxSessions: string[]) => void;
  onError?: (error: Error) => void;
}

export class AgentWatcher {
  private repos: RepoEntry[];
  private events: WatcherEvents;
  private watchers: FSWatcher[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false;
  private refreshing = false;
  private refreshQueued = false;
  private hasCompletedInitialRefresh = false;
  private _lastAgents: Agent[] = [];
  private lastOrphanedSessions: string[] = [];
  private _lastLiveTmuxSessions: Set<string> = new Set();
  /** Cached coordinator tmux session_created epoch — immutable for the session
   * lifetime, so we query tmux display-message once and reuse. Cleared when
   * pollSystemCoordinator() reports 'stopped' (session ended). */
  private coordinatorSessionEpoch: number | null = null;

  /**
   * Whether flattenAgentTree groups repos under a shared parent-directory
   * header (the `tree.groupByParent` display preference). Owned here so the
   * flag flows into every flatten call (both refresh() and pollStates()); the
   * dashboard flips it live via setGroupByParent(), which re-flattens on the
   * next refresh with NO `ib watch` restart required.
   */
  private groupByParent = false;

  /** Health check results per repo path */
  healthReports: Map<string, RepoHealthReport> = new Map();
  /** Global health warnings (e.g. missing hooks in ~/.claude/settings.json) */
  globalHealthWarnings: RepoHealthWarning[] = [];
  /** Timestamp of last health check run (for cooldown) */
  private lastHealthCheckAt = 0;

  /** Public read-only access to the most recently loaded agents list */
  get lastAgents(): Agent[] {
    return this._lastAgents;
  }

  /** Public read-only access to the most recent live tmux session set. */
  get lastLiveTmuxSessions(): Set<string> {
    return this._lastLiveTmuxSessions;
  }

  constructor(repos: RepoEntry[], events: WatcherEvents) {
    this.repos = repos;
    this.events = events;
  }

  async start(): Promise<void> {
    this.running = true;

    // Initial load
    await this.refresh();

    // Run health checks asynchronously (non-blocking — don't delay first render)
    this.runHealthChecks();

    // Set up fs.watch on each repo's .ittybitty/agents/, archive/, and user-questions.json
    this.setupWatchers();

    // Structural poll every 3s. On Bun 1.3.10 / macOS the non-recursive agents/
    // watch does not fire on spawn/retire, so this refresh() is the primary way
    // new and removed agents (and out-of-band meta.json edits) reach the
    // dashboard. Shortened from 10s to keep that responsive without the recursive
    // watch. readAllAgents is cheap (~30ms), and refresh() is serialized with the
    // 2s state poll below (the refreshing/polling flags) so the two never overlap.
    this.pollTimer = setInterval(() => {
      if (this.running) this.refresh();
    }, 3_000);

    // Background state poll every 2s — keeps agent states fresh between fs.watch events
    this.stateTimer = setInterval(() => {
      if (this.running) this.pollStates();
    }, 2_000);
  }

  /** Cooldown period for health checks (5 min) — avoids re-running on every
   *  fs.watch event. Raised from 30s: each pass fans out 3 `git` spawns per
   *  repo, so on a large repo set (~50 repos ≈ 150 processes) a 30s cooldown
   *  retriggered by every refresh was a steady background spawn storm. Health
   *  data is slow-moving; 5 min is ample. The `H` keybinding
   *  (recheckHealth → force=true) still bypasses this for an on-demand refresh. */
  static readonly HEALTH_CHECK_COOLDOWN_MS = 300_000;

  /** Max repos health-checked concurrently — bounds the `git` spawn burst so a
   *  large repo set can't launch 150+ processes in one tick. */
  static readonly HEALTH_CHECK_CHUNK_SIZE = 8;

  /** Run health checks for all repos and global config.
   *  Skips if the last check was within the cooldown period (unless force=true). */
  private async runHealthChecks(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastHealthCheckAt < AgentWatcher.HEALTH_CHECK_COOLDOWN_MS) return;
    this.lastHealthCheckAt = now;
    try {
      // Cap concurrency: process repos in fixed-size chunks instead of one big
      // Promise.all, so the per-repo `git` spawns (3 each) never exceed
      // HEALTH_CHECK_CHUNK_SIZE * 3 in flight at once.
      const [repoResults, globalWarnings] = await Promise.all([
        mapInChunks(
          this.repos,
          AgentWatcher.HEALTH_CHECK_CHUNK_SIZE,
          (r) => checkRepoHealth(r.path),
        ),
        checkGlobalHealth(),
      ]);
      for (const report of repoResults) {
        this.healthReports.set(report.repoPath, report);
      }
      this.globalHealthWarnings = globalWarnings;
    } catch {
      // Health checks are non-critical — silently ignore errors
    }
  }

  /** Re-run all health checks and refresh the UI (called on demand via H keybinding) */
  async recheckHealth(): Promise<void> {
    await this.runHealthChecks(true);
    // Trigger a full refresh so the UI picks up new health data
    if (this.running) {
      this.refresh();
    }
  }

  stop(): void {
    this.running = false;
    this.teardownWatchers();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.stateTimer) {
      clearInterval(this.stateTimer);
      this.stateTimer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Replace the repos list and reset fs.watch watchers (poll timers keep running) */
  updateRepos(repos: RepoEntry[]): void {
    this.repos = repos;
    this.teardownWatchers();
    this.setupWatchers();
    // Force health checks for new/changed repos (bypass cooldown)
    this.runHealthChecks(true);
  }

  /**
   * Set the parent-directory grouping preference. When the value actually
   * changes, kick a refresh() so the tree re-flattens with (or without) the
   * parent-header rows on the next tick — the live-toggle path used by the 'h'
   * settings menu. A no-op change avoids a redundant refresh.
   */
  setGroupByParent(value: boolean): void {
    if (this.groupByParent === value) return;
    this.groupByParent = value;
    if (this.running) this.refresh();
  }

  /** Close all fs.watch watchers */
  private teardownWatchers(): void {
    this.watcherGeneration++;
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
  }

  private watcherGeneration = 0;
  private hasLoggedInitialWatchers = false;

  /** Set up fs.watch on each repo's .ittybitty/agents/ and user-questions.json */
  private setupWatchers(): void {
    const gen = ++this.watcherGeneration;
    void this.setupWatchersAsync(gen);
  }

  static readonly WATCHER_CHUNK_SIZE = 4;

  private async setupWatchersAsync(gen: number): Promise<void> {
    const t0 = Date.now();
    for (let i = 0; i < this.repos.length; i++) {
      if (i > 0 && i % AgentWatcher.WATCHER_CHUNK_SIZE === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      if (!this.running || gen !== this.watcherGeneration) return;

      const repo = this.repos[i]!;
      const agentsDir = join(repo.path, ".ittybitty", "agents");
      const questionsFile = join(repo.path, ".ittybitty", "user-questions.json");

      // Watch the agents dir NON-RECURSIVELY. We deliberately do NOT recurse:
      // each agent dir holds a full `repo/` worktree (a complete checkout), and a
      // recursive watch descended into every file of every worktree across all
      // repos. That registered huge FSEvents streams (watch.log recorded ~27s to
      // install 93 targets across 56 repos) and pegged macOS `fseventsd` at ~100%
      // CPU as agents churned files in their worktrees — churn the dashboard never
      // reads (readAllAgents only reads each agent's top-level meta.json). A
      // non-recursive watch uses kqueue, not FSEvents, so it stays entirely off
      // fseventsd (verified with lsof on Bun 1.3.10) and fixes both the CPU pin
      // and the ~27s startup.
      //
      // CAVEAT (Bun 1.3.10, macOS): a non-recursive fs.watch on a DIRECTORY does
      // not dispatch entry-change events (create / rename / unlink of children).
      // A watch on a FILE fires; a watch on a DIRECTORY does not — confirmed by an
      // isolated probe. So on this platform THIS WATCH DOES NOT FIRE on
      // spawn / retire. We keep it because it is cheap, harmless when dormant, and
      // correct on platforms / Bun versions that do dispatch directory events.
      // What actually keeps the dashboard current here is the polling below:
      // the structural refresh (readAllAgents re-reads the agent dirs — catches
      // spawn / retire and out-of-band meta.json edits) and the 2s state poll.
      // Dashboard-initiated mutations (rename / model change / retire / etc.)
      // refresh immediately on their own via executeAndRefresh, independent of
      // this watch.
      try {
        const watcher = watch(agentsDir, () => {
          this.debounceRefresh();
        });
        if (!this.running || gen !== this.watcherGeneration) {
          watcher.close();
          return;
        }
        this.watchers.push(watcher);
      } catch (err) {
        this.events.onError?.(new Error(`Failed to watch ${agentsDir}: ${err}`));
      }

      try {
        const watcher = watch(questionsFile, () => {
          this.debounceRefresh();
        });
        if (!this.running || gen !== this.watcherGeneration) {
          watcher.close();
          return;
        }
        this.watchers.push(watcher);
      } catch (err) {
        // user-questions.json may not exist yet — not an error
      }
    }

    if (this.running && gen === this.watcherGeneration && !this.hasLoggedInitialWatchers) {
      this.hasLoggedInitialWatchers = true;
      logToWatchLog(
        `[startup] initial fs.watch setup completed: ${this.watchers.length} targets across ${this.repos.length} repos in ${Date.now() - t0}ms`,
      );
    }
  }

  /** Debounce refresh to avoid rapid successive updates */
  private debounceRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.running) this.refresh();
    }, 200);
  }

  /** Get coordinator info for flattenAgentTree: state + age from tmux session creation time.
   *  pollSystemCoordinator() also drives the continuous permission-prompt
   *  auto-accept and edge-triggered pane-condition logging off its single
   *  capture — see src/coordinator.ts. */
  private async getCoordinatorInfo(): Promise<{ state: string; age: string } | undefined> {
    try {
      const state = await pollSystemCoordinator();
      if (state === "stopped") {
        // Session ended — invalidate cached epoch so a new session re-queries
        this.coordinatorSessionEpoch = null;
        return { state, age: "" };
      }

      // Use the cached session_created epoch when available — it's immutable
      // for the lifetime of the tmux session, so a single display-message
      // call covers every refresh until the session is replaced.
      if (this.coordinatorSessionEpoch !== null) {
        return { state, age: computeAge(this.coordinatorSessionEpoch) };
      }

      const proc = tmuxSpawnCtx.runner(
        ["tmux", "display-message", "-t", tmuxSessionTarget(IB_COORDINATOR_SESSION), "-p", "#{session_created}"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = (await new Response(proc.stdout).text()).trim();
      const exitCode = await proc.exited;
      if (exitCode !== 0 || !output) return { state, age: "" };

      const epoch = parseInt(output, 10);
      if (isNaN(epoch)) return { state, age: "" };
      this.coordinatorSessionEpoch = epoch;
      return { state, age: computeAge(epoch) };
    } catch {
      return undefined;
    }
  }

  /** Poll states for all known agents without re-reading from disk */
  private async pollStates(): Promise<void> {
    const agents = this._lastAgents;
    if (agents.length === 0 || this.polling || this.refreshing) return;
    this.polling = true;
    try {
      const agentsApi = agentsCtx.fn;
      // Lifecycle path: the watcher tick is authorized to reap orphan PIDs
      // and tear down husk tmux sessions for agents detected as stopped.
      const [, coordinatorInfo] = await Promise.all([
        agentsApi.detectAgentStates(agents, {
          reap: true,
          confirmTmuxMissingAcrossPolls: true,
        }),
        this.getCoordinatorInfo(),
      ]);
      // If refresh() swapped lastAgents while we were awaiting, discard stale results
      if (agents !== this._lastAgents) return;
      const roots = agentsApi.buildAgentTree(agents);
      const repoInfos = this.repos.map((r) => ({ name: repoDisplayName(r), path: r.path }));
      const flatList = agentsApi.flattenAgentTree(roots, repoInfos, coordinatorInfo, this.groupByParent);
      const questionResults = await Promise.all(
        this.repos.map((r) => agentsApi.readPendingQuestions(r.path))
      );
      const questions = questionResults.flat();
      if (!this.running) return;
      this.events.onUpdate(agents, flatList, questions, this.lastOrphanedSessions);
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.polling = false;
      if (this.refreshQueued && !this.refreshing) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  /** Read all agents, detect states, and emit update */
  async refresh(): Promise<void> {
    // State detection has destructive authority in both paths. Serialize
    // refresh with the lightweight polling pass so one temporal observation
    // cannot be counted twice and a stale pass cannot race a refresh.
    if (this.refreshing || this.polling) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    const isInitial = !this.hasCompletedInitialRefresh;
    const tRefreshStart = isInitial ? Date.now() : 0;
    try {
      const agentsApi = agentsCtx.fn;
      const reposWithDisplayNames = this.repos.map((r) => ({ path: r.path, name: repoDisplayName(r) }));
      // Skip archived agents: the dashboard never renders them (flattenAgentTree
      // drops every archived row) and re-stat'ing thousands of immutable archived
      // meta.json files on every refresh tick is pure waste. See readAllAgents docs.
      const tReadStart = isInitial ? Date.now() : 0;
      const { agents, errors, orphanedTmuxSessions, liveTmuxSessions } = await agentsApi.readAllAgents(reposWithDisplayNames, false);
      const tReadMs = isInitial ? Date.now() - tReadStart : 0;

      // Report any read errors
      for (const err of errors) {
        this.events.onError?.(new Error(err.error));
      }

      // Save agents and orphaned sessions for background state polling
      this._lastAgents = agents;
      this.lastOrphanedSessions = orphanedTmuxSessions;
      this._lastLiveTmuxSessions = liveTmuxSessions;

      // Detect state for each agent via tmux capture + parseState, and get coordinator info.
      // Lifecycle path: the watcher refresh is authorized to reap orphan PIDs
      // and tear down husk tmux sessions for agents detected as stopped.
      const tDetectStart = isInitial ? Date.now() : 0;
      const [, coordinatorInfo] = await Promise.all([
        agentsApi.detectAgentStates(agents, {
          reap: true,
          confirmTmuxMissingAcrossPolls: true,
        }),
        this.getCoordinatorInfo(),
      ]);
      const tDetectMs = isInitial ? Date.now() - tDetectStart : 0;

      const roots = agentsApi.buildAgentTree(agents);
      const repoInfos = this.repos.map((r) => ({ name: repoDisplayName(r), path: r.path }));
      const flatList = agentsApi.flattenAgentTree(roots, repoInfos, coordinatorInfo, this.groupByParent);

      // Read pending questions from all repos
      const tQuestionsStart = isInitial ? Date.now() : 0;
      const questionResults = await Promise.all(
        this.repos.map((r) => agentsApi.readPendingQuestions(r.path))
      );
      const questions = questionResults.flat();
      const tQuestionsMs = isInitial ? Date.now() - tQuestionsStart : 0;

      if (isInitial) {
        this.hasCompletedInitialRefresh = true;
        logToWatchLog(
          `[startup] initial watcher.refresh completed in ${Date.now() - tRefreshStart}ms ` +
          `(readAllAgents=${tReadMs}ms, detectStates=${tDetectMs}ms, readQuestions=${tQuestionsMs}ms)`,
        );
      }

      // Run health checks (fire-and-forget — results available on next update)
      this.runHealthChecks();

      if (!this.running) return;
      this.events.onUpdate(agents, flatList, questions, orphanedTmuxSessions);
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refresh();
      }
    }
  }
}
