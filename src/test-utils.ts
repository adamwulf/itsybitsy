/**
 * Shared test utilities for itsybitsy tests.
 */

import type { Agent, AgentMeta, FlatEntry } from "./agents";
import type { AgentState } from "./parse-state";
import type { SpawnResult, FetchLike } from "./types";

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
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      tmux_session: `tmux-${overrides.id}`,
      prompt: "test prompt",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model: "claude:sonnet",
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
export function makeFlatRepoHeader(repoName: string, repoPath: string = "", hasAgents: boolean = false, hasRunningAgents: boolean = false, hasNonStoppedAgents: boolean = false): Extract<FlatEntry, { kind: "repo-header" }> {
  return { kind: "repo-header", repoName, repoPath, hasAgents, hasRunningAgents, hasNonStoppedAgents };
}

/** Create a FlatEntry of kind "system-coordinator" for tests */
export function makeFlatSystemCoordinator(state = "running", age = "5m"): Extract<FlatEntry, { kind: "system-coordinator" }> {
  return { kind: "system-coordinator", state, age };
}

/**
 * Set an agent's state field. Centralizes the type assertion needed because
 * AgentState is a string-literal union but tests often assign arbitrary state strings.
 */
export function setAgentState(agent: Agent, state: string): void {
  agent.state = state as AgentState;
}

/**
 * Create a SpawnResult that resolves with the given exit code and optional stdout/stderr content.
 * Eliminates repetitive `{ stdout: new Response("").body!, stderr: ... } as SpawnResult` in tests.
 */
export function makeSpawnResult(exitCode = 0, stdout = "", stderr = ""): SpawnResult {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: Promise.resolve(exitCode),
  };
}

/**
 * Create a mock FetchLike function that returns the given response data.
 * Eliminates `(async () => ({ ok, json: async () => data })) as any` casts.
 */
export function mockFetch(data: unknown, ok = true, status = 200): FetchLike {
  return (async () => ({
    ok,
    status,
    json: async () => data,
  })) as unknown as FetchLike;
}

/**
 * Poll `condition` until it returns true, then resolve. Throws if it never
 * becomes true within `timeoutMs`.
 *
 * Use this instead of a fixed `Bun.sleep(n)` whenever a test needs to observe
 * the result of fire-and-forget async work (a debounced write, a detached
 * promise, a spawned subprocess). A fixed sleep encodes a guess about how long
 * that work takes on an idle machine; when the machine is busy the work takes
 * longer, the sleep expires early, and the test fails for reasons that have
 * nothing to do with the behaviour under test.
 *
 * Waiting on the real condition is both more robust AND faster: it returns as
 * soon as the condition holds rather than always burning the full sleep. The
 * timeout only bounds the failure case, so it can be generous without slowing
 * down the passing path.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 5, message = "condition" }: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for: ${message}`);
    }
    await Bun.sleep(intervalMs);
  }
}

/**
 * Poll `produce` until it returns a non-null/non-undefined value, then return
 * it. Throws on timeout. The value-returning companion to {@link waitFor} —
 * for "wait until this file parses / this record appears" style waits.
 */
export async function waitForValue<T>(
  produce: () => T | null | undefined | Promise<T | null | undefined>,
  { timeoutMs = 5000, intervalMs = 5, message = "value" }: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitForValue timed out after ${timeoutMs}ms waiting for: ${message}`);
    }
    await Bun.sleep(intervalMs);
  }
}
