/**
 * Watch .ittybitty/agents/ directories for changes using fs.watch.
 * Emits events when agents are added, changed, or removed.
 * Includes a fallback poll every 10s for macOS FSEvents reliability.
 * Captures tmux output and feeds it through parseState() for each active agent.
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { readAllAgents, buildAgentTree, flattenAgentTree, readPendingQuestions } from "./agents";
import type { Agent, FlatAgent, PendingQuestion } from "./agents";
import type { RepoEntry } from "./registry";
import { parseState } from "./parse-state";
import { captureTmuxOutput } from "./tmux-poller";

export type { FlatAgent } from "./agents";

export interface WatcherEvents {
  onUpdate: (agents: Agent[], flatList: FlatAgent[], questions: PendingQuestion[]) => void;
  onError?: (error: Error) => void;
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

  /** Detect agent state by capturing tmux output and running parseState() */
  private async detectAgentStates(agents: Agent[]): Promise<void> {
    // Only detect state for non-archived agents (archived are implicitly stopped)
    const active = agents.filter((a) => !a.archived);

    await Promise.all(
      active.map(async (agent) => {
        const tmuxSession = agent.meta.tmux_session;
        if (!tmuxSession) {
          agent.state = "unknown";
          return;
        }

        const output = await captureTmuxOutput(tmuxSession);
        if (output === null) {
          // tmux session doesn't exist → stopped
          agent.state = "stopped";
          return;
        }

        const result = parseState(output);
        agent.state = result.state;
      })
    );

    // Archived agents are always stopped
    for (const agent of agents) {
      if (agent.archived) {
        agent.state = "stopped";
      }
    }
  }

  /** Read all agents, detect states, and emit update */
  async refresh(): Promise<void> {
    try {
      const { agents, errors } = await readAllAgents(this.repos);

      // Report any read errors
      for (const err of errors) {
        this.events.onError?.(new Error(err.error));
      }

      // Detect state for each agent via tmux capture + parseState
      await this.detectAgentStates(agents);

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
