/**
 * Watch .ittybitty/agents/ directories for changes using fs.watch.
 * Emits events when agents are added, changed, or removed.
 * Includes a fallback poll every 10s for macOS FSEvents reliability.
 * Captures tmux output and feeds it through parseState() for each active agent.
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { readAllAgents, buildAgentTree, flattenAgentTree, readPendingQuestions, detectAgentStates } from "./agents";
import type { Agent, FlatEntry, PendingQuestion } from "./agents";
import { repoDisplayName } from "./registry";
import type { RepoEntry } from "./registry";
import { checkRepoHealth, checkGlobalHealth } from "./health-check";
import type { RepoHealthReport, RepoHealthWarning } from "./health-check";

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
  private _lastAgents: Agent[] = [];
  private lastOrphanedSessions: string[] = [];

  /** Health check results per repo path */
  healthReports: Map<string, RepoHealthReport> = new Map();
  /** Global health warnings (e.g. missing hooks in ~/.claude/settings.json) */
  globalHealthWarnings: RepoHealthWarning[] = [];

  /** Public read-only access to the most recently loaded agents list */
  get lastAgents(): Agent[] {
    return this._lastAgents;
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

    // Fallback poll every 10s for FSEvents reliability
    this.pollTimer = setInterval(() => {
      if (this.running) this.refresh();
    }, 10_000);

    // Background state poll every 2s — keeps agent states fresh between fs.watch events
    this.stateTimer = setInterval(() => {
      if (this.running) this.pollStates();
    }, 2_000);
  }

  /** Run health checks for all repos and global config, then trigger onUpdate */
  private async runHealthChecks(): Promise<void> {
    try {
      const [repoResults, globalWarnings] = await Promise.all([
        Promise.all(this.repos.map((r) => checkRepoHealth(r.path))),
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
    await this.runHealthChecks();
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
  }

  /** Close all fs.watch watchers */
  private teardownWatchers(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
  }

  /** Set up fs.watch on each repo's .ittybitty/agents/, archive/, and user-questions.json */
  private setupWatchers(): void {
    for (const repo of this.repos) {
      const agentsDir = join(repo.path, ".ittybitty", "agents");
      const archiveDir = join(repo.path, ".ittybitty", "archive");
      const questionsFile = join(repo.path, ".ittybitty", "user-questions.json");

      try {
        const watcher = watch(agentsDir, { recursive: true }, () => {
          this.debounceRefresh();
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.events.onError?.(new Error(`Failed to watch ${agentsDir}: ${err}`));
      }

      try {
        const watcher = watch(archiveDir, { recursive: true }, () => {
          this.debounceRefresh();
        });
        this.watchers.push(watcher);
      } catch (err) {
        // archive/ may not exist yet — not an error
      }

      try {
        const watcher = watch(questionsFile, () => {
          this.debounceRefresh();
        });
        this.watchers.push(watcher);
      } catch (err) {
        // user-questions.json may not exist yet — not an error
      }
    }
  }

  /** Debounce refresh to avoid rapid successive updates */
  private debounceRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.running) this.refresh();
    }, 200);
  }

  /** Poll states for all known agents without re-reading from disk */
  private async pollStates(): Promise<void> {
    const agents = this._lastAgents;
    if (agents.length === 0 || this.polling || this.refreshing) return;
    this.polling = true;
    try {
      await detectAgentStates(agents);
      // If refresh() swapped lastAgents while we were awaiting, discard stale results
      if (agents !== this._lastAgents) return;
      const roots = buildAgentTree(agents);
      const repoInfos = this.repos.map((r) => ({ name: repoDisplayName(r), path: r.path }));
      const flatList = flattenAgentTree(roots, repoInfos);
      const questionResults = await Promise.all(
        this.repos.map((r) => readPendingQuestions(r.path))
      );
      const questions = questionResults.flat();
      if (!this.running) return;
      this.events.onUpdate(agents, flatList, questions, this.lastOrphanedSessions);
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.polling = false;
    }
  }

  /** Read all agents, detect states, and emit update */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      const reposWithDisplayNames = this.repos.map((r) => ({ path: r.path, name: repoDisplayName(r) }));
      const { agents, errors, orphanedTmuxSessions } = await readAllAgents(reposWithDisplayNames);

      // Report any read errors
      for (const err of errors) {
        this.events.onError?.(new Error(err.error));
      }

      // Save agents and orphaned sessions for background state polling
      this._lastAgents = agents;
      this.lastOrphanedSessions = orphanedTmuxSessions;

      // Detect state for each agent via tmux capture + parseState
      await detectAgentStates(agents);

      const roots = buildAgentTree(agents);
      const repoInfos = this.repos.map((r) => ({ name: repoDisplayName(r), path: r.path }));
      const flatList = flattenAgentTree(roots, repoInfos);

      // Read pending questions from all repos
      const questionResults = await Promise.all(
        this.repos.map((r) => readPendingQuestions(r.path))
      );
      const questions = questionResults.flat();

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
