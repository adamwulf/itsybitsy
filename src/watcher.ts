/**
 * Watch .ittybitty/agents/ directories for changes using fs.watch.
 * Emits events when agents are added, changed, or removed.
 * Includes a fallback poll every 10s for macOS FSEvents reliability.
 * Captures tmux output and feeds it through parseState() for each active agent.
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { readAllAgents, buildAgentTree, flattenAgentTree, readPendingQuestions, detectAgentStates } from "./agents";
import type { Agent, FlatAgent, PendingQuestion } from "./agents";
import type { RepoEntry } from "./registry";

export interface WatcherEvents {
  onUpdate: (agents: Agent[], flatList: FlatAgent[], questions: PendingQuestion[]) => void;
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
  private lastAgents: Agent[] = [];

  constructor(repos: RepoEntry[], events: WatcherEvents) {
    this.repos = repos;
    this.events = events;
  }

  async start(): Promise<void> {
    this.running = true;

    // Initial load
    await this.refresh();

    // Set up fs.watch on each repo's .ittybitty/agents/, archive/, and user-questions.json
    for (const repo of this.repos) {
      const agentsDir = join(repo.path, ".ittybitty", "agents");
      const archiveDir = join(repo.path, ".ittybitty", "archive");
      const questionsFile = join(repo.path, ".ittybitty", "user-questions.json");

      // Watch agents/ directory
      try {
        const watcher = watch(agentsDir, { recursive: true }, () => {
          this.debounceRefresh();
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.events.onError?.(new Error(`Failed to watch ${agentsDir}: ${err}`));
      }

      // Watch archive/ directory
      try {
        const watcher = watch(archiveDir, { recursive: true }, () => {
          this.debounceRefresh();
        });
        this.watchers.push(watcher);
      } catch (err) {
        // archive/ may not exist yet — not an error
      }

      // Watch user-questions.json
      try {
        const watcher = watch(questionsFile, () => {
          this.debounceRefresh();
        });
        this.watchers.push(watcher);
      } catch (err) {
        // user-questions.json may not exist yet — not an error
      }
    }

    // Fallback poll every 10s for FSEvents reliability
    this.pollTimer = setInterval(() => {
      if (this.running) this.refresh();
    }, 10_000);

    // Background state poll every 2s — keeps agent states fresh between fs.watch events
    this.stateTimer = setInterval(() => {
      if (this.running) this.pollStates();
    }, 2_000);
  }

  stop(): void {
    this.running = false;
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
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

  /** Debounce refresh to avoid rapid successive updates */
  private debounceRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.running) this.refresh();
    }, 200);
  }

  /** Poll states for all known agents without re-reading from disk */
  private async pollStates(): Promise<void> {
    const agents = this.lastAgents;
    if (agents.length === 0 || this.polling) return;
    this.polling = true;
    try {
      await detectAgentStates(agents);
      // If refresh() swapped lastAgents while we were awaiting, discard stale results
      if (agents !== this.lastAgents) return;
      const roots = buildAgentTree(agents);
      const flatList = flattenAgentTree(roots, this.repos.length);
      const questionResults = await Promise.all(
        this.repos.map((r) => readPendingQuestions(r.path))
      );
      const questions = questionResults.flat();
      this.events.onUpdate(agents, flatList, questions);
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
      const { agents, errors } = await readAllAgents(this.repos);

      // Report any read errors
      for (const err of errors) {
        this.events.onError?.(new Error(err.error));
      }

      // Save agents for background state polling
      this.lastAgents = agents;

      // Detect state for each agent via tmux capture + parseState
      await detectAgentStates(agents);

      const roots = buildAgentTree(agents);
      const flatList = flattenAgentTree(roots, this.repos.length);

      // Read pending questions from all repos
      const questionResults = await Promise.all(
        this.repos.map((r) => readPendingQuestions(r.path))
      );
      const questions = questionResults.flat();

      this.events.onUpdate(agents, flatList, questions);
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
