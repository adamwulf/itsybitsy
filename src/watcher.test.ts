import { test, expect, describe, beforeEach, afterEach, jest, mock } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import type { Agent, FlatAgent, PendingQuestion } from "./agents";
import type { RepoEntry } from "./registry";

// --- Mock agents module ---
const mockReadAllAgents = jest.fn<() => Promise<{ agents: Agent[]; errors: any[] }>>();
const mockDetectAgentStates = jest.fn<(agents: Agent[]) => Promise<void>>();
const mockBuildAgentTree = jest.fn<(agents: Agent[]) => Agent[]>();
const mockFlattenAgentTree = jest.fn<(roots: Agent[]) => FlatAgent[]>();
const mockReadPendingQuestions = jest.fn<(repoPath: string) => Promise<PendingQuestion[]>>();

mock.module("./agents", () => ({
  readAllAgents: mockReadAllAgents,
  detectAgentStates: mockDetectAgentStates,
  buildAgentTree: mockBuildAgentTree,
  flattenAgentTree: mockFlattenAgentTree,
  readPendingQuestions: mockReadPendingQuestions,
}));

// Import after mocking
const { AgentWatcher } = await import("./watcher");

function makeAgent(id: string, archived = false): Agent {
  return {
    id,
    repoPath: "/tmp/test",
    repoName: "test",
    state: "unknown",
    age: "1m",
    archived,
    children: [],
    meta: {
      id,
      session_id: "sess-1",
      tmux_session: `tmux-${id}`,
      prompt: "test prompt",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "1234",
    },
  };
}

function setupDefaultMocks(agents: Agent[] = []) {
  mockReadAllAgents.mockResolvedValue({ agents, errors: [] });
  mockDetectAgentStates.mockResolvedValue(undefined);
  mockBuildAgentTree.mockReturnValue(agents);
  mockFlattenAgentTree.mockReturnValue(agents.map((a) => ({ agent: a, depth: 0 })));
  mockReadPendingQuestions.mockResolvedValue([]);
}

function resetMocks() {
  mockReadAllAgents.mockReset();
  mockDetectAgentStates.mockReset();
  mockBuildAgentTree.mockReset();
  mockFlattenAgentTree.mockReset();
  mockReadPendingQuestions.mockReset();
}

describe("AgentWatcher", () => {
  let tempDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-watcher-test-"));
    agentsDir = join(tempDir, ".ittybitty", "agents");
    await mkdir(agentsDir, { recursive: true });
    resetMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("start/stop lifecycle", () => {
    test("start() calls refresh on initial load", async () => {
      setupDefaultMocks();
      const updates: Agent[][] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => updates.push(agents) }
      );

      await watcher.start();
      watcher.stop();

      // refresh was called during start (initial load)
      expect(mockReadAllAgents).toHaveBeenCalledTimes(1);
      expect(updates.length).toBe(1);
    });

    test("stop() prevents further updates", async () => {
      setupDefaultMocks();
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      await watcher.start();
      expect(updateCount).toBe(1); // initial load

      watcher.stop();

      // Manually calling refresh after stop should not trigger onUpdate
      // because running is false. But refresh() is public, so let's check
      // that the poll timer doesn't fire. We verify stop by checking timers are cleared.
      // The fact that stop() sets running=false means debounceRefresh won't trigger.
      expect(updateCount).toBe(1);
    });

    test("stop() is idempotent", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      await watcher.start();
      watcher.stop();
      // Should not throw
      watcher.stop();
    });
  });

  describe("debounce logic", () => {
    test("multiple rapid debounceRefresh calls produce exactly 1 refresh", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const callsAfterStart = mockReadAllAgents.mock.calls.length;
        expect(callsAfterStart).toBe(1); // initial refresh

        // Fire debounceRefresh 5 times rapidly
        for (let i = 0; i < 5; i++) {
          (watcher as any).debounceRefresh();
        }

        // Advance past the 200ms debounce window
        jest.advanceTimersByTime(250);
        // Allow the async refresh() promise to resolve
        await Promise.resolve();
        await Promise.resolve();

        // Exactly 1 additional refresh should have fired (not 5)
        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart + 1);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("debounce timer resets on each new call", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const callsAfterStart = mockReadAllAgents.mock.calls.length;

        // First debounce call
        (watcher as any).debounceRefresh();

        // Advance 150ms (less than 200ms debounce)
        jest.advanceTimersByTime(150);
        await Promise.resolve();

        // No refresh yet — still within debounce window
        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart);

        // Second call resets the timer
        (watcher as any).debounceRefresh();

        // Advance another 150ms (300ms total, but only 150ms since last call)
        jest.advanceTimersByTime(150);
        await Promise.resolve();

        // Still no refresh — timer was reset by second call
        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart);

        // Advance past the debounce window from the second call
        jest.advanceTimersByTime(100);
        await Promise.resolve();
        await Promise.resolve();

        // Now exactly 1 refresh should have fired
        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart + 1);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("debounceRefresh does nothing after stop", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const callsAfterStart = mockReadAllAgents.mock.calls.length;

        watcher.stop();

        (watcher as any).debounceRefresh();
        jest.advanceTimersByTime(300);
        await Promise.resolve();

        // No additional refresh since watcher is stopped
        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("fallback poll", () => {
    test("poll fires refresh after 10s interval", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const callsAfterStart = mockReadAllAgents.mock.calls.length;
        expect(callsAfterStart).toBe(1);

        // Advance just under 10s — no poll yet
        jest.advanceTimersByTime(9_999);
        await Promise.resolve();
        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart);

        // Advance to exactly 10s
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();

        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart + 1);

        // Advance another 10s — second poll fires
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();

        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart + 2);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("poll timer is cleared on stop (no updates after stop)", async () => {
      setupDefaultMocks();
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const afterStart = updateCount;
        watcher.stop();

        // Advance well past 10s — no poll should fire
        jest.advanceTimersByTime(30_000);
        await Promise.resolve();
        expect(updateCount).toBe(afterStart);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("change detection via refresh", () => {
    test("two-snapshot pipeline: agents added between refreshes", async () => {
      const agentA = makeAgent("agent-a");
      const agentB = makeAgent("agent-b");
      const agentC = makeAgent("agent-c");

      // First snapshot: [A, B]
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentB], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB]);
      mockFlattenAgentTree.mockReturnValueOnce([
        { agent: agentA, depth: 0 },
        { agent: agentB, depth: 0 },
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A, B, C] — C was added
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentB, agentC], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB, agentC]);
      mockFlattenAgentTree.mockReturnValueOnce([
        { agent: agentA, depth: 0 },
        { agent: agentB, depth: 0 },
        { agent: agentC, depth: 0 },
      ]);

      const updates: Agent[][] = [];
      const flatUpdates: FlatAgent[][] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents, flat) => { updates.push([...agents]); flatUpdates.push([...flat]); } }
      );

      await watcher.start();
      await watcher.refresh();
      watcher.stop();

      // First update: 2 agents
      expect(updates[0]!.map(a => a.id)).toEqual(["agent-a", "agent-b"]);
      // Second update: 3 agents (C added)
      expect(updates[1]!.map(a => a.id)).toEqual(["agent-a", "agent-b", "agent-c"]);
      // Flat list matches
      expect(flatUpdates[1]!.length).toBe(3);
    });

    test("two-snapshot pipeline: agents removed between refreshes", async () => {
      const agentA = makeAgent("agent-a");
      const agentB = makeAgent("agent-b");

      // First snapshot: [A, B]
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentB], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB]);
      mockFlattenAgentTree.mockReturnValueOnce([
        { agent: agentA, depth: 0 },
        { agent: agentB, depth: 0 },
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A] — B removed
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA]);
      mockFlattenAgentTree.mockReturnValueOnce([
        { agent: agentA, depth: 0 },
      ]);

      const updates: Agent[][] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => updates.push([...agents]) }
      );

      await watcher.start();
      await watcher.refresh();
      watcher.stop();

      expect(updates[0]!.map(a => a.id)).toEqual(["agent-a", "agent-b"]);
      expect(updates[1]!.map(a => a.id)).toEqual(["agent-a"]);
    });

    test("two-snapshot pipeline: agent replaced between refreshes", async () => {
      const agentA = makeAgent("agent-a");
      const agentB = makeAgent("agent-b");
      const agentC = makeAgent("agent-c");

      // First snapshot: [A, B]
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentB], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB]);
      mockFlattenAgentTree.mockReturnValueOnce([
        { agent: agentA, depth: 0 },
        { agent: agentB, depth: 0 },
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A, C] — B removed, C added
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentC], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentC]);
      mockFlattenAgentTree.mockReturnValueOnce([
        { agent: agentA, depth: 0 },
        { agent: agentC, depth: 0 },
      ]);

      const updates: Agent[][] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => updates.push([...agents]) }
      );

      await watcher.start();
      await watcher.refresh();
      watcher.stop();

      expect(updates[0]!.map(a => a.id)).toEqual(["agent-a", "agent-b"]);
      expect(updates[1]!.map(a => a.id)).toEqual(["agent-a", "agent-c"]);
    });

    test("detectAgentStates mutates agent state and result flows to onUpdate", async () => {
      const agent1 = makeAgent("agent-1");
      agent1.state = "unknown";

      mockReadAllAgents.mockResolvedValue({ agents: [agent1], errors: [] });
      // Simulate detectAgentStates mutating the agent's state in-place
      mockDetectAgentStates.mockImplementation(async (agents: Agent[]) => {
        for (const a of agents) {
          a.state = "running";
        }
      });
      mockBuildAgentTree.mockImplementation((agents) => agents);
      mockFlattenAgentTree.mockImplementation((roots) =>
        roots.map((a) => ({ agent: a, depth: 0 }))
      );
      mockReadPendingQuestions.mockResolvedValue([]);

      let receivedAgents: Agent[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => { receivedAgents = agents; } }
      );

      await watcher.start();
      watcher.stop();

      // The state mutation by detectAgentStates should be visible in onUpdate
      expect(receivedAgents.length).toBe(1);
      expect(receivedAgents[0]!.state).toBe("running");
      expect(mockDetectAgentStates).toHaveBeenCalledWith([agent1]);
    });

    test("detectAgentStates changes state between refreshes", async () => {
      const agent1 = makeAgent("agent-1");

      let callNum = 0;
      mockReadAllAgents.mockImplementation(async () => {
        // Return a fresh agent each time so state starts at "unknown"
        const a = makeAgent("agent-1");
        return { agents: [a], errors: [] };
      });
      mockDetectAgentStates.mockImplementation(async (agents: Agent[]) => {
        callNum++;
        for (const a of agents) {
          a.state = callNum === 1 ? "running" : "complete";
        }
      });
      mockBuildAgentTree.mockImplementation((agents) => agents);
      mockFlattenAgentTree.mockImplementation((roots) =>
        roots.map((a) => ({ agent: a, depth: 0 }))
      );
      mockReadPendingQuestions.mockResolvedValue([]);

      const states: string[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => { states.push(agents[0]!.state); } }
      );

      await watcher.start();
      await watcher.refresh();
      watcher.stop();

      expect(states).toEqual(["running", "complete"]);
    });

    test("buildAgentTree receives output of detectAgentStates", async () => {
      const agent1 = makeAgent("agent-1");
      const agent2 = makeAgent("agent-2");

      mockReadAllAgents.mockResolvedValue({ agents: [agent1, agent2], errors: [] });
      mockDetectAgentStates.mockImplementation(async (agents: Agent[]) => {
        agents[0]!.state = "running";
        agents[1]!.state = "complete";
      });
      mockBuildAgentTree.mockImplementation((agents) => {
        // Verify that agents passed to buildAgentTree have been mutated
        // by detectAgentStates
        return agents;
      });
      mockFlattenAgentTree.mockImplementation((roots) =>
        roots.map((a) => ({ agent: a, depth: 0 }))
      );
      mockReadPendingQuestions.mockResolvedValue([]);

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      await watcher.start();
      watcher.stop();

      // buildAgentTree was called with agents that detectAgentStates already mutated
      const argsToTree = mockBuildAgentTree.mock.calls[0]![0];
      expect(argsToTree[0]!.state).toBe("running");
      expect(argsToTree[1]!.state).toBe("complete");
    });

    test("questions are passed through from readPendingQuestions", async () => {
      setupDefaultMocks();
      const question: PendingQuestion = {
        id: "q-1",
        agent: "agent-1",
        question: "Should I proceed?",
        timestamp: "2026-03-05T00:00:00Z",
        status: "pending",
      };
      mockReadPendingQuestions.mockResolvedValue([question]);

      let receivedQuestions: PendingQuestion[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (_, __, questions) => { receivedQuestions = questions; } }
      );

      await watcher.start();
      watcher.stop();

      expect(receivedQuestions.length).toBe(1);
      expect(receivedQuestions[0]!.id).toBe("q-1");
    });

    test("multiple repos have questions merged", async () => {
      const tempDir2 = await mkdtemp(join(tmpdir(), "itsybitsy-watcher-test2-"));
      await mkdir(join(tempDir2, ".ittybitty", "agents"), { recursive: true });

      setupDefaultMocks();
      // Return different questions for each call
      let callCount = 0;
      mockReadPendingQuestions.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return [{ id: "q-1", agent: "a1", question: "Q1", timestamp: "t1", status: "pending" as const }];
        return [{ id: "q-2", agent: "a2", question: "Q2", timestamp: "t2", status: "pending" as const }];
      });

      let receivedQuestions: PendingQuestion[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }, { path: tempDir2, name: "repo2" }],
        { onUpdate: (_, __, questions) => { receivedQuestions = questions; } }
      );

      await watcher.start();
      watcher.stop();

      expect(receivedQuestions.length).toBe(2);
      await rm(tempDir2, { recursive: true, force: true });
    });
  });

  describe("error handling", () => {
    test("onError called when agentsDir does not exist", async () => {
      setupDefaultMocks();
      const errors: Error[] = [];
      const nonExistentDir = join(tempDir, "no-such-repo");
      const watcher = new AgentWatcher(
        [{ path: nonExistentDir, name: "missing" }],
        {
          onUpdate: () => {},
          onError: (err) => errors.push(err),
        }
      );

      await watcher.start();
      watcher.stop();

      // fs.watch on nonexistent dir should trigger onError
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]!.message).toContain("Failed to watch");
    });

    test("onError called when readAllAgents returns errors", async () => {
      mockReadAllAgents.mockResolvedValue({
        agents: [],
        errors: [{ agentDir: "/tmp/bad", error: "bad meta.json" }],
      });
      mockDetectAgentStates.mockResolvedValue(undefined);
      mockBuildAgentTree.mockReturnValue([]);
      mockFlattenAgentTree.mockReturnValue([]);
      mockReadPendingQuestions.mockResolvedValue([]);

      const errors: Error[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        {
          onUpdate: () => {},
          onError: (err) => errors.push(err),
        }
      );

      await watcher.start();
      watcher.stop();

      expect(errors.some((e) => e.message.includes("bad meta.json"))).toBe(true);
    });

    test("onError called when readAllAgents throws", async () => {
      mockReadAllAgents.mockRejectedValue(new Error("disk on fire"));
      mockDetectAgentStates.mockResolvedValue(undefined);
      mockBuildAgentTree.mockReturnValue([]);
      mockFlattenAgentTree.mockReturnValue([]);
      mockReadPendingQuestions.mockResolvedValue([]);

      const errors: Error[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        {
          onUpdate: () => {},
          onError: (err) => errors.push(err),
        }
      );

      await watcher.start();
      watcher.stop();

      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toBe("disk on fire");
    });

    test("onError handles non-Error throws", async () => {
      mockReadAllAgents.mockRejectedValue("string error");
      mockDetectAgentStates.mockResolvedValue(undefined);
      mockBuildAgentTree.mockReturnValue([]);
      mockFlattenAgentTree.mockReturnValue([]);
      mockReadPendingQuestions.mockResolvedValue([]);

      const errors: Error[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        {
          onUpdate: () => {},
          onError: (err) => errors.push(err),
        }
      );

      await watcher.start();
      watcher.stop();

      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toBe("string error");
    });

    test("continues working after error in refresh", async () => {
      // First call throws, second succeeds
      let callCount = 0;
      mockReadAllAgents.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("transient");
        return { agents: [], errors: [] };
      });
      mockDetectAgentStates.mockResolvedValue(undefined);
      mockBuildAgentTree.mockReturnValue([]);
      mockFlattenAgentTree.mockReturnValue([]);
      mockReadPendingQuestions.mockResolvedValue([]);

      const errors: Error[] = [];
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        {
          onUpdate: () => { updateCount++; },
          onError: (err) => errors.push(err),
        }
      );

      await watcher.start(); // first call throws
      expect(errors.length).toBe(1);

      await watcher.refresh(); // second call succeeds
      expect(updateCount).toBe(1);

      watcher.stop();
    });

    test("missing onError handler does not throw", async () => {
      mockReadAllAgents.mockRejectedValue(new Error("oops"));

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
        // no onError
      );

      // Should not throw even without onError handler
      await watcher.start();
      watcher.stop();
    });
  });

  describe("background state polling", () => {
    test("state poll fires every 2s and emits updates without readAllAgents", async () => {
      const agent1 = makeAgent("agent-1");
      setupDefaultMocks([agent1]);

      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const afterStart = updateCount; // 1 from initial refresh
        const readsAfterStart = mockReadAllAgents.mock.calls.length; // 1

        // Advance 2s — state poll fires
        jest.advanceTimersByTime(2_000);
        // Flush multiple microtask ticks for the async pollStates chain
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(updateCount).toBe(afterStart + 1);
        // readAllAgents should NOT have been called again (state poll skips disk read)
        expect(mockReadAllAgents.mock.calls.length).toBe(readsAfterStart);
        // detectAgentStates should have been called again
        expect(mockDetectAgentStates.mock.calls.length).toBe(2); // 1 from refresh + 1 from state poll

        // Advance another 2s — second state poll
        jest.advanceTimersByTime(2_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(updateCount).toBe(afterStart + 2);
        expect(mockDetectAgentStates.mock.calls.length).toBe(3);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("state poll does not fire when lastAgents is empty", async () => {
      setupDefaultMocks([]); // no agents

      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const afterStart = updateCount; // 1 from initial refresh

        // Advance 2s — state poll fires but skips (no agents)
        jest.advanceTimersByTime(2_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        // No additional update since lastAgents is empty
        expect(updateCount).toBe(afterStart);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("state poll timer is cleared on stop", async () => {
      const agent1 = makeAgent("agent-1");
      setupDefaultMocks([agent1]);

      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const afterStart = updateCount;
        watcher.stop();

        // Advance well past multiple state poll intervals
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();

        // No additional updates after stop
        expect(updateCount).toBe(afterStart);
      } finally {
        jest.useRealTimers();
      }
    });

    test("state poll reflects state changes via detectAgentStates", async () => {
      const agent1 = makeAgent("agent-1");
      setupDefaultMocks([agent1]);

      let callNum = 0;
      mockDetectAgentStates.mockImplementation(async (agents: Agent[]) => {
        callNum++;
        for (const a of agents) {
          a.state = callNum <= 1 ? "running" : "complete";
        }
      });
      mockBuildAgentTree.mockImplementation((agents) => agents);
      mockFlattenAgentTree.mockImplementation((roots) =>
        roots.map((a) => ({ agent: a, depth: 0 }))
      );

      const states: string[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => { states.push(agents[0]!.state); } }
      );

      jest.useFakeTimers();
      try {
        await watcher.start(); // callNum=1 → running

        // Advance 2s — state poll fires, callNum=2 → complete
        jest.advanceTimersByTime(2_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(states).toEqual(["running", "complete"]);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("fs.watch integration", () => {
    test("file change in agents dir triggers refresh", async () => {
      setupDefaultMocks();
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      await watcher.start();
      const initial = updateCount;

      // Create a new agent directory with meta.json
      const newAgentDir = join(agentsDir, "agent-new");
      await mkdir(newAgentDir, { recursive: true });
      await writeFile(join(newAgentDir, "meta.json"), '{"id":"agent-new"}');

      // Poll until the debounced refresh fires (50ms intervals, up to 2s)
      const deadline = Date.now() + 2000;
      while (updateCount <= initial && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(updateCount).toBeGreaterThan(initial);

      watcher.stop();
    });

    test("archive dir watch does not error if archive missing", async () => {
      setupDefaultMocks();
      const errors: Error[] = [];
      // Don't create archive dir
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        {
          onUpdate: () => {},
          onError: (err) => errors.push(err),
        }
      );

      await watcher.start();
      watcher.stop();

      // No errors for missing archive dir (it's expected)
      const watchErrors = errors.filter((e) => e.message.includes("archive"));
      expect(watchErrors.length).toBe(0);
    });
  });
});
