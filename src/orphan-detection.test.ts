/**
 * Tests for orphaned tmux session detection in readAllAgents().
 * Uses mock.module to control listTmuxSessions output.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";

// --- Mock tmux-poller to control listTmuxSessions ---
// Re-export all real exports and only override listTmuxSessions
const realModule = await import("./tmux-poller");
const mockListTmuxSessions = mock(() => Promise.resolve([] as string[]));

mock.module("./tmux-poller", () => ({
  ...realModule,
  listTmuxSessions: mockListTmuxSessions,
}));

// Import after mocking
const { readAllAgents, resetListTmuxSessionsCache } = await import("./agents");

describe("orphaned tmux session detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-orphan-test-"));
    mockListTmuxSessions.mockReset();
    // Clear the listTmuxSessions TTL cache so each test sees fresh mock results
    resetListTmuxSessionsCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createAgent(id: string, tmuxSession: string) {
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id, session_id: "s1", tmux_session: tmuxSession,
      prompt: "test", manager: null, created: "2026-03-05",
      created_epoch: Date.now() / 1000,
      worktree: true, worker: false, model: "sonnet", claude_pid: "1",
    }));
  }

  test("no tmux sessions → no orphans", async () => {
    mockListTmuxSessions.mockResolvedValue([]);
    await createAgent("agent-a", "ittybitty-repo1-agent-a");

    const { orphanedTmuxSessions } = await readAllAgents([{ path: tempDir, name: "test" }], false);
    expect(orphanedTmuxSessions).toEqual([]);
  });

  test("all tmux sessions match agents → no orphans", async () => {
    await createAgent("agent-a", "ittybitty-repo1-agent-a");
    await createAgent("agent-b", "ittybitty-repo1-agent-b");
    mockListTmuxSessions.mockResolvedValue([
      "ittybitty-repo1-agent-a",
      "ittybitty-repo1-agent-b",
    ]);

    const { orphanedTmuxSessions } = await readAllAgents([{ path: tempDir, name: "test" }], false);
    expect(orphanedTmuxSessions).toEqual([]);
  });

  test("tmux session without matching agent is orphaned", async () => {
    await createAgent("agent-a", "ittybitty-repo1-agent-a");
    mockListTmuxSessions.mockResolvedValue([
      "ittybitty-repo1-agent-a",
      "ittybitty-repo1-agent-deleted",
    ]);

    const { orphanedTmuxSessions } = await readAllAgents([{ path: tempDir, name: "test" }], false);
    expect(orphanedTmuxSessions).toEqual(["ittybitty-repo1-agent-deleted"]);
  });

  test("non-ittybitty tmux sessions are ignored", async () => {
    mockListTmuxSessions.mockResolvedValue([
      "my-dev-session",
      "other-project",
      "0",
    ]);

    const { orphanedTmuxSessions } = await readAllAgents([{ path: tempDir, name: "test" }], false);
    expect(orphanedTmuxSessions).toEqual([]);
  });

  test("multiple orphans from different repos", async () => {
    await createAgent("agent-a", "ittybitty-repo1-agent-a");
    mockListTmuxSessions.mockResolvedValue([
      "ittybitty-repo1-agent-a",
      "ittybitty-repo1-stale1",
      "ittybitty-repo2-stale2",
      "not-ittybitty-session",
    ]);

    const { orphanedTmuxSessions } = await readAllAgents([{ path: tempDir, name: "test" }], false);
    expect(orphanedTmuxSessions).toEqual(["ittybitty-repo1-stale1", "ittybitty-repo2-stale2"]);
  });

  test("no agents at all — all ittybitty sessions are orphans", async () => {
    // Create agents dir but no agents
    await mkdir(join(tempDir, ".ittybitty", "agents"), { recursive: true });
    mockListTmuxSessions.mockResolvedValue([
      "ittybitty-repo1-orphan1",
      "ittybitty-repo1-orphan2",
    ]);

    const { orphanedTmuxSessions } = await readAllAgents([{ path: tempDir, name: "test" }], false);
    expect(orphanedTmuxSessions).toEqual(["ittybitty-repo1-orphan1", "ittybitty-repo1-orphan2"]);
  });

  test("agent with empty tmux_session does not match anything", async () => {
    await createAgent("agent-a", "");
    mockListTmuxSessions.mockResolvedValue([
      "ittybitty-repo1-stale",
    ]);

    const { orphanedTmuxSessions } = await readAllAgents([{ path: tempDir, name: "test" }], false);
    expect(orphanedTmuxSessions).toEqual(["ittybitty-repo1-stale"]);
  });
});
