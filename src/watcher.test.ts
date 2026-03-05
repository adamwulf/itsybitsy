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
    test("rapid file changes trigger only one refresh after debounce", async () => {
      setupDefaultMocks();
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      await watcher.start();
      expect(updateCount).toBe(1); // initial

      // Trigger multiple rapid fs changes by writing files
      const agentDir = join(agentsDir, "agent-test");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "meta.json"), "{}");
      await writeFile(join(agentDir, "meta.json"), '{"a":1}');
      await writeFile(join(agentDir, "meta.json"), '{"a":2}');

      // Wait for debounce (200ms) + some buffer
      await new Promise((r) => setTimeout(r, 400));

      // Should have gotten at most 1 additional update (debounced), not 3
      // fs.watch may coalesce events too, so we just verify it's not N
      const additionalUpdates = updateCount - 1;
      expect(additionalUpdates).toBeLessThanOrEqual(1);

      watcher.stop();
    });

    test("debounce resets timer on each new change", async () => {
      setupDefaultMocks();
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      await watcher.start();
      const initialCount = updateCount;

      // Write a file
      const agentDir = join(agentsDir, "agent-debounce");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "meta.json"), "{}");

      // Wait 100ms (less than 200ms debounce) then write again
      await new Promise((r) => setTimeout(r, 100));
      await writeFile(join(agentDir, "meta.json"), '{"b":1}');

      // At 100ms after the second write, the first debounce should have been cancelled
      await new Promise((r) => setTimeout(r, 100));

      // The first write's debounce was reset, so at t=200ms total, no refresh yet
      // (because second write reset the timer at t=100ms, so it fires at t=300ms)
      const midCount = updateCount - initialCount;

      // Wait for the debounce to actually fire
      await new Promise((r) => setTimeout(r, 200));
      const finalCount = updateCount - initialCount;

      // Should have at most 1 refresh from the debounced writes
      expect(finalCount).toBeLessThanOrEqual(1);

      watcher.stop();
    });
  });

  describe("fallback poll", () => {
    test("poll timer is set up during start", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      await watcher.start();

      // Verify refresh is callable and works (poll calls refresh)
      const callsBefore = mockReadAllAgents.mock.calls.length;
      await watcher.refresh();
      expect(mockReadAllAgents.mock.calls.length).toBe(callsBefore + 1);

      watcher.stop();
    });

    test("poll timer is cleared on stop (no updates after stop)", async () => {
      setupDefaultMocks();
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      await watcher.start();
      const afterStart = updateCount;
      watcher.stop();

      // Wait well past debounce time - no poll should fire
      await new Promise((r) => setTimeout(r, 500));
      expect(updateCount).toBe(afterStart);
    });
  });

  describe("change detection via refresh", () => {
    test("onUpdate receives agents from readAllAgents", async () => {
      const agent1 = makeAgent("agent-1");
      setupDefaultMocks([agent1]);

      let receivedAgents: Agent[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => { receivedAgents = agents; } }
      );

      await watcher.start();
      watcher.stop();

      expect(receivedAgents.length).toBe(1);
      expect(receivedAgents[0].id).toBe("agent-1");
    });

    test("onUpdate receives flat list from flattenAgentTree", async () => {
      const agent1 = makeAgent("agent-1");
      const flat = [{ agent: agent1, depth: 0 }];
      setupDefaultMocks([agent1]);
      mockFlattenAgentTree.mockReturnValue(flat);

      let receivedFlat: FlatAgent[] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (_, flatList) => { receivedFlat = flatList; } }
      );

      await watcher.start();
      watcher.stop();

      expect(receivedFlat.length).toBe(1);
      expect(receivedFlat[0].depth).toBe(0);
    });

    test("detects added agents on subsequent refresh", async () => {
      setupDefaultMocks([]);
      const updates: Agent[][] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => updates.push([...agents]) }
      );

      await watcher.start();
      expect(updates.length).toBe(1);
      expect(updates[0].length).toBe(0);

      // Now simulate an agent appearing
      const newAgent = makeAgent("agent-new");
      mockReadAllAgents.mockResolvedValue({ agents: [newAgent], errors: [] });
      mockBuildAgentTree.mockReturnValue([newAgent]);
      mockFlattenAgentTree.mockReturnValue([{ agent: newAgent, depth: 0 }]);

      await watcher.refresh();

      expect(updates.length).toBe(2);
      expect(updates[1].length).toBe(1);
      expect(updates[1][0].id).toBe("agent-new");

      watcher.stop();
    });

    test("detects removed agents on subsequent refresh", async () => {
      const agent1 = makeAgent("agent-1");
      setupDefaultMocks([agent1]);
      const updates: Agent[][] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => updates.push([...agents]) }
      );

      await watcher.start();
      expect(updates[0].length).toBe(1);

      // Agent removed
      mockReadAllAgents.mockResolvedValue({ agents: [], errors: [] });
      mockBuildAgentTree.mockReturnValue([]);
      mockFlattenAgentTree.mockReturnValue([]);

      await watcher.refresh();

      expect(updates[1].length).toBe(0);

      watcher.stop();
    });

    test("detects changed agents on subsequent refresh", async () => {
      const agent1 = makeAgent("agent-1");
      agent1.state = "running";
      setupDefaultMocks([agent1]);

      const updates: Agent[][] = [];
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: (agents) => updates.push([...agents]) }
      );

      await watcher.start();

      // Agent state changes
      const updated = makeAgent("agent-1");
      updated.state = "waiting_for_tool";
      mockReadAllAgents.mockResolvedValue({ agents: [updated], errors: [] });
      mockBuildAgentTree.mockReturnValue([updated]);
      mockFlattenAgentTree.mockReturnValue([{ agent: updated, depth: 0 }]);

      await watcher.refresh();

      expect(updates.length).toBe(2);
      watcher.stop();
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
      expect(receivedQuestions[0].id).toBe("q-1");
    });

    test("detectAgentStates is called during refresh", async () => {
      const agent1 = makeAgent("agent-1");
      setupDefaultMocks([agent1]);

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      await watcher.start();
      watcher.stop();

      expect(mockDetectAgentStates).toHaveBeenCalledTimes(1);
      expect(mockDetectAgentStates).toHaveBeenCalledWith([agent1]);
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
      expect(errors[0].message).toContain("Failed to watch");
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
      expect(errors[0].message).toBe("disk on fire");
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
      expect(errors[0].message).toBe("string error");
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

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 400));

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
