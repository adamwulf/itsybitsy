/**
 * Shared test utilities for itsybitsy tests.
 */

import type { Agent, AgentMeta, FlatEntry } from "./agents";

/** Create a test Agent with sensible defaults. All fields can be overridden. */
export function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    repoPath: "/tmp/test",
    repoName: "test",
    state: "unknown",
    age: "1m",
    archived: false,
    children: [],
    meta: {
      id: overrides.id,
      session_id: "sess-1",
      tmux_session: `tmux-${overrides.id}`,
      prompt: "test prompt",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "12345",
      ...(overrides.meta ?? {}),
    } as AgentMeta,
    ...overrides,
  };
}

/** Create a FlatEntry of kind "agent" for tests */
export function makeFlatAgent(agent: Agent, overrides?: { depth?: number; connector?: string }): Extract<FlatEntry, { kind: "agent" }> {
  return {
    kind: "agent",
    agent,
    depth: overrides?.depth ?? 0,
    connector: overrides?.connector ?? "",
  };
}

/** Create a FlatEntry of kind "repo-header" for tests */
export function makeFlatRepoHeader(repoName: string, repoPath: string = "", hasAgents: boolean = false): Extract<FlatEntry, { kind: "repo-header" }> {
  return { kind: "repo-header", repoName, repoPath, hasAgents };
}
