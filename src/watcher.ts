/**
 * Watch .ittybitty/agents/ directories for changes using fs.watch.
 * Emits events when agents are added, changed, or removed.
 * Includes a fallback poll every 10s for macOS FSEvents reliability.
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { readAllAgents, buildAgentTree, flattenAgentTree, readPendingQuestions } from "./agents";
import type { Agent, PendingQuestion } from "./agents";
import type { RepoEntry } from "./registry";

export interface WatcherEvents {
  onUpdate: (agents: Agent[], flatList: FlatAgent[], questions: PendingQuestion[]) => void;
  onError?: (error: Error) => void;
}

export interface FlatAgent {
  agent: Agent;
  depth: number;
}

export class AgentWatcher {
  private repos: RepoEntry[];
  private events: WatcherEvents;
  private watchers: FSWatcher[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(repos: RepoEntry[], events: WatcherEvents) {
    this.repos = repos;
    this.events = events;
  }

  async start(): Promise<void> {
    this.running = true;

    // Initial load
    await this.refresh();

    // Set up fs.watch on each repo's .ittybitty/agents/ dir
    for (const repo of this.repos) {
      const agentsDir = join(repo.path, ".ittybitty", "agents");
      try {
        const watcher = watch(agentsDir, { recursive: true }, () => {
          this.debounceRefresh();
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.events.onError?.(new Error(`Failed to watch ${agentsDir}: ${err}`));
      }
    }

    // Fallback poll every 10s for FSEvents reliability
    this.pollTimer = setInterval(() => {
      if (this.running) this.refresh();
    }, 10_000);
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

  /** Read all agents and emit update */
  async refresh(): Promise<void> {
    try {
      const agents = await readAllAgents(this.repos);
      const roots = buildAgentTree(agents);
      const flatList = flattenAgentTree(roots);

      // Read pending questions from all repos
      const questionResults = await Promise.all(
        this.repos.map((r) => readPendingQuestions(r.path))
      );
      const questions = questionResults.flat();

      this.events.onUpdate(agents, flatList, questions);
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
