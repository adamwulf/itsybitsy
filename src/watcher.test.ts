import { test, expect, describe, beforeEach, afterEach, jest, mock } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import type { Agent, FlatEntry, PendingQuestion } from "./agents";
import { makeAgent as _makeAgent, makeFlatAgent } from "./test-utils";
import type { RepoEntry } from "./registry";

// --- Mock agents module ---
const mockReadAllAgents = jest.fn<() => Promise<{ agents: Agent[]; errors: any[] }>>();
const mockDetectAgentStates = jest.fn<(agents: Agent[]) => Promise<void>>();
const mockBuildAgentTree = jest.fn<(agents: Agent[]) => Agent[]>();
const mockFlattenAgentTree = jest.fn<(roots: Agent[]) => FlatEntry[]>();
const mockReadPendingQuestions = jest.fn<(repoPath: string) => Promise<PendingQuestion[]>>();

mock.module("./agents", () => ({
  readAllAgents: mockReadAllAgents,
  detectAgentStates: mockDetectAgentStates,
  buildAgentTree: mockBuildAgentTree,
  flattenAgentTree: mockFlattenAgentTree,
  readPendingQuestions: mockReadPendingQuestions,
  computeAge: (epoch: number) => `${Math.floor((Date.now() / 1000 - epoch) / 60)}m`,
  isCompacting: (output: string) => {
    const lines = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\n");
    return lines.slice(-5).join("\n").includes("Compacting conversation");
  },
  isRateLimited: (output: string) => {
    const text = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\n").slice(-15).join("\n");
    if (text.includes("rate_limit_error")) return true;
    const lower = text.toLowerCase();
    return lower.includes("usage limit reached") || lower.includes("limit will reset at") ||
      lower.includes("hit your limit") || lower.includes("rate limit");
  },
}));

// --- Mock fs.watch to capture registered callbacks ---
// watcher.ts does `import { watch } from "fs"`. We wrap the REAL watch so it
// still behaves normally (real FSWatcher, real close(), real onError for a
// missing dir) but additionally records each registered change-callback. Tests
// can then invoke that captured callback DIRECTLY to drive the fs-event path
// deterministically — without waiting on macOS FSEvents delivery, whose latency
// is unbounded under CPU load and made the old fixed-deadline polls flaky.
const watchCallbacks: Array<(eventType: string, filename: string | null) => void> = [];
function clearWatchCallbacks() { watchCallbacks.length = 0; }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realFs = require("fs");
mock.module("fs", () => ({
  ...realFs,
  watch: (path: string, options: any, listener?: any) => {
    // fs.watch supports watch(path, listener) and watch(path, options, listener)
    const cb = typeof options === "function" ? options : listener;
    if (typeof cb === "function") watchCallbacks.push(cb);
    return realFs.watch(path, options, listener);
  },
}));

// Import after mocking agents + fs modules
const { AgentWatcher } = await import("./watcher");
// Import coordinatorSpawnCtx to inject noop (prevents real tmux calls in getCoordinatorInfo)
const { coordinatorSpawnCtx } = await import("./coordinator");
// Import tmux-poller spawnCtx for tests that exercise captureTmuxOutput / display-message
const { spawnCtx: tmuxPollerSpawnCtx } = await import("./tmux-poller");

function makeAgent(id: string, archived = false): Agent {
  return _makeAgent({ id, archived });
}

function setupDefaultMocks(agents: Agent[] = []) {
  mockReadAllAgents.mockResolvedValue({ agents, errors: [] });
  mockDetectAgentStates.mockResolvedValue(undefined);
  mockBuildAgentTree.mockReturnValue(agents);
  mockFlattenAgentTree.mockReturnValue(agents.map((a) => makeFlatAgent(a)));
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
    // Prevent real tmux calls from coordinatorSpawnCtx (exit code 1 → "stopped")
    coordinatorSpawnCtx.set(() => ({
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(1),
    }) as any);
    // detectSystemCoordinatorState now derives "stopped" from captureTmuxOutput
    // returning null (the redundant `tmux has-session` probe was removed), and
    // captureTmuxOutput spawns via the tmux-poller spawnCtx — not
    // coordinatorSpawnCtx. Stub it to a non-zero exit so the coordinator
    // resolves to "stopped" by default, matching the pre-existing baseline the
    // polling/lifecycle tests assume.
    tmuxPollerSpawnCtx.set(() => ({
      stdout: new Response("").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(1),
    }) as any);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    coordinatorSpawnCtx.reset();
    tmuxPollerSpawnCtx.reset();
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
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart + 1);

        // Advance another 10s — second poll fires
        jest.advanceTimersByTime(10_000);
        for (let i = 0; i < 10; i++) await Promise.resolve();

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
        makeFlatAgent(agentA),
        makeFlatAgent(agentB),
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A, B, C] — C was added
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentB, agentC], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB, agentC]);
      mockFlattenAgentTree.mockReturnValueOnce([
        makeFlatAgent(agentA),
        makeFlatAgent(agentB),
        makeFlatAgent(agentC),
      ]);

      const updates: Agent[][] = [];
      const flatUpdates: FlatEntry[][] = [];
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
        makeFlatAgent(agentA),
        makeFlatAgent(agentB),
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A] — B removed
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA]);
      mockFlattenAgentTree.mockReturnValueOnce([
        makeFlatAgent(agentA),
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
        makeFlatAgent(agentA),
        makeFlatAgent(agentB),
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A, C] — B removed, C added
      mockReadAllAgents.mockResolvedValueOnce({ agents: [agentA, agentC], errors: [] });
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentC]);
      mockFlattenAgentTree.mockReturnValueOnce([
        makeFlatAgent(agentA),
        makeFlatAgent(agentC),
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
        roots.map((a) => (makeFlatAgent(a)))
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
        roots.map((a) => (makeFlatAgent(a)))
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
        roots.map((a) => (makeFlatAgent(a)))
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
        // (extra ticks needed for coordinator info detection)
        for (let i = 0; i < 30; i++) await Promise.resolve();

        expect(updateCount).toBe(afterStart + 1);
        // readAllAgents should NOT have been called again (state poll skips disk read)
        expect(mockReadAllAgents.mock.calls.length).toBe(readsAfterStart);
        // detectAgentStates should have been called again
        expect(mockDetectAgentStates.mock.calls.length).toBe(2); // 1 from refresh + 1 from state poll

        // Advance another 2s — second state poll
        jest.advanceTimersByTime(2_000);
        for (let i = 0; i < 30; i++) await Promise.resolve();

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
        roots.map((a) => (makeFlatAgent(a)))
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
        for (let i = 0; i < 30; i++) await Promise.resolve();

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

      clearWatchCallbacks();
      jest.useFakeTimers();
      try {
        await watcher.start();
        const callsAfterStart = mockReadAllAgents.mock.calls.length;

        // setupWatchers() registered real fs.watch change-callbacks (captured by
        // the fs mock above). Invoke them directly to simulate a file change,
        // rather than writing a file and waiting for macOS FSEvents to deliver —
        // FSEvents latency is unbounded under CPU load, which made the old
        // fixed-deadline poll flaky (it timed out even at 8s under contention).
        // This drives the exact same wiring (watcher callback → debounceRefresh)
        // deterministically.
        expect(watchCallbacks.length).toBeGreaterThan(0);
        for (const cb of watchCallbacks) cb("change", "meta.json");

        // Advance past the 200ms debounce window; assert the debounced refresh
        // fired (one more readAllAgents). We check the refresh entry point rather
        // than the onUpdate tail because refresh() awaits several async stages —
        // matching the deterministic "rapid debounceRefresh" tests above.
        jest.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();

        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterStart + 1);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
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

  describe("updateRepos", () => {
    test("refresh uses new repos list after updateRepos", async () => {
      setupDefaultMocks();

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );

      await watcher.start();

      // Verify internal repos has repo1
      expect((watcher as any).repos).toEqual([{ path: tempDir, name: "repo1" }]);

      // Create a second temp dir for the new repo
      const tempDir2 = await mkdtemp(join(tmpdir(), "itsybitsy-watcher-test2-"));
      await mkdir(join(tempDir2, ".ittybitty", "agents"), { recursive: true });

      // Update repos to include both
      const newRepos = [
        { path: tempDir, name: "repo1" },
        { path: tempDir2, name: "repo2" },
      ];
      watcher.updateRepos(newRepos);

      // Verify internal repos was updated
      expect((watcher as any).repos).toEqual(newRepos);

      // readPendingQuestions is called per-repo during refresh — use call count to verify
      mockReadPendingQuestions.mockReset();
      mockReadPendingQuestions.mockResolvedValue([]);

      await watcher.refresh();
      watcher.stop();

      // readPendingQuestions should have been called for both repos
      expect(mockReadPendingQuestions.mock.calls.length).toBe(2);

      await rm(tempDir2, { recursive: true, force: true });
    });

    test("updateRepos tears down old watchers and sets up new ones", async () => {
      setupDefaultMocks();

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );

      await watcher.start();
      // Should have watchers for repo1
      const watchersAfterStart = (watcher as any).watchers.length;
      expect(watchersAfterStart).toBeGreaterThan(0);

      // Create second temp dir
      const tempDir2 = await mkdtemp(join(tmpdir(), "itsybitsy-watcher-test2-"));
      await mkdir(join(tempDir2, ".ittybitty", "agents"), { recursive: true });

      watcher.updateRepos([
        { path: tempDir, name: "repo1" },
        { path: tempDir2, name: "repo2" },
      ]);

      // After updateRepos, watchers should exist for both repos
      const watchersAfterUpdate = (watcher as any).watchers.length;
      expect(watchersAfterUpdate).toBeGreaterThan(watchersAfterStart);

      watcher.stop();
      await rm(tempDir2, { recursive: true, force: true });
    });

    test("updateRepos to empty list clears all watchers", async () => {
      setupDefaultMocks();

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );

      await watcher.start();
      expect((watcher as any).watchers.length).toBeGreaterThan(0);

      watcher.updateRepos([]);
      expect((watcher as any).watchers.length).toBe(0);

      watcher.stop();
    });

    test("updateRepos does not affect poll timers", async () => {
      setupDefaultMocks();

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const pollTimer = (watcher as any).pollTimer;
        const stateTimer = (watcher as any).stateTimer;
        expect(pollTimer).not.toBeNull();
        expect(stateTimer).not.toBeNull();

        watcher.updateRepos([{ path: tempDir, name: "repo1-renamed" }]);

        // Poll timers should be unchanged
        expect((watcher as any).pollTimer).toBe(pollTimer);
        expect((watcher as any).stateTimer).toBe(stateTimer);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("fs.watch on original repo still triggers refresh after updateRepos", async () => {
      setupDefaultMocks();
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => { updateCount++; } }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();

        // Clear callbacks captured during start(), then updateRepos (tears down
        // + re-creates watchers). Only the FRESH, post-updateRepos callbacks are
        // now in watchCallbacks — invoking them proves the recreated watchers are
        // still wired to debounceRefresh, which is the exact regression this test
        // guards. Driving the captured callback directly (vs. writing a file and
        // waiting for macOS FSEvents) removes the OS-timing race that made the old
        // fixed 5s poll flaky under CPU load.
        clearWatchCallbacks();
        watcher.updateRepos([{ path: tempDir, name: "repo1" }]);
        const callsAfterUpdate = mockReadAllAgents.mock.calls.length;

        expect(watchCallbacks.length).toBeGreaterThan(0);
        for (const cb of watchCallbacks) cb("change", "meta.json");

        // Advance past the 200ms debounce window; assert the debounced refresh
        // fired (one more readAllAgents) via the freshly-recreated watcher.
        jest.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();

        expect(mockReadAllAgents.mock.calls.length).toBe(callsAfterUpdate + 1);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("removed repo fs.watch does not trigger refresh after updateRepos", async () => {
      setupDefaultMocks();

      // Create a second temp dir
      const tempDir2 = await mkdtemp(join(tmpdir(), "itsybitsy-watcher-test2-"));
      const agentsDir2 = join(tempDir2, ".ittybitty", "agents");
      await mkdir(agentsDir2, { recursive: true });

      let updateCount = 0;
      const watcher = new AgentWatcher(
        [
          { path: tempDir, name: "repo1" },
          { path: tempDir2, name: "repo2" },
        ],
        { onUpdate: () => { updateCount++; } }
      );

      await watcher.start();

      // Remove repo2 from the watcher
      watcher.updateRepos([{ path: tempDir, name: "repo1" }]);
      const afterUpdate = updateCount;

      // Write to the removed repo's agents dir — should NOT trigger refresh
      // since the old watcher was torn down
      const newAgentDir = join(agentsDir2, "agent-new");
      await mkdir(newAgentDir, { recursive: true });
      await writeFile(join(newAgentDir, "meta.json"), '{"id":"agent-new"}');

      // Wait a bit to verify no refresh fires
      await new Promise((r) => setTimeout(r, 500));
      expect(updateCount).toBe(afterUpdate);

      watcher.stop();
      await rm(tempDir2, { recursive: true, force: true });
    }, 10_000);
  });

  describe("getCoordinatorInfo session_created cache (Change C)", () => {
    test("display-message is invoked only once across two refreshes when session is alive", async () => {
      setupDefaultMocks();
      // coordinatorSpawnCtx handles `tmux has-session` — return exit 0 (alive)
      coordinatorSpawnCtx.set(((cmd: string[]) => {
        if (cmd.includes("has-session")) {
          return {
            stdout: new Response("").body!,
            stderr: new Response("").body!,
            exited: Promise.resolve(0),
          };
        }
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        };
      }) as any);

      // tmux-poller spawnCtx handles capture-pane and display-message
      let displayMessageCalls = 0;
      tmuxPollerSpawnCtx.set(((cmd: string[]) => {
        if (cmd.includes("capture-pane")) {
          return {
            stdout: new Response("normal output").body!,
            stderr: new Response("").body!,
            exited: Promise.resolve(0),
          };
        }
        if (cmd.includes("display-message")) {
          displayMessageCalls++;
          return {
            stdout: new Response("1700000000\n").body!,
            stderr: new Response("").body!,
            exited: Promise.resolve(0),
          };
        }
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        };
      }) as any);

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      await watcher.start(); // first refresh — should call display-message
      await watcher.refresh(); // second refresh — should reuse cached value
      watcher.stop();

      expect(displayMessageCalls).toBe(1);

      tmuxPollerSpawnCtx.reset();
    });

    test("cache is invalidated when coordinator state becomes 'stopped'", async () => {
      setupDefaultMocks();

      // Phase 1: session alive — display-message returns 1700000000.
      // detectSystemCoordinatorState now signals "stopped" via captureTmuxOutput
      // returning null (capture-pane non-zero exit), not via `tmux has-session`,
      // so the alive/stopped toggle lives on the capture-pane branch below.
      coordinatorSpawnCtx.set((() => ({
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      })) as any);

      let captureExit = 0;
      let displayMessageCalls = 0;
      tmuxPollerSpawnCtx.set(((cmd: string[]) => {
        if (cmd.includes("capture-pane")) {
          return {
            stdout: new Response("normal output").body!,
            stderr: new Response("").body!,
            exited: Promise.resolve(captureExit),
          };
        }
        if (cmd.includes("display-message")) {
          displayMessageCalls++;
          return {
            stdout: new Response("1700000000\n").body!,
            stderr: new Response("").body!,
            exited: Promise.resolve(0),
          };
        }
        return {
          stdout: new Response("").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
        };
      }) as any);

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      await watcher.start();
      expect(displayMessageCalls).toBe(1);

      // Phase 2: session reported stopped — capture-pane fails → null →
      // "stopped" → cache invalidates
      captureExit = 1;
      await watcher.refresh();
      // display-message NOT called when stopped
      expect(displayMessageCalls).toBe(1);

      // Phase 3: session alive again — display-message called again because cache cleared
      captureExit = 0;
      await watcher.refresh();
      expect(displayMessageCalls).toBe(2);

      watcher.stop();
      tmuxPollerSpawnCtx.reset();
    });
  });
});
