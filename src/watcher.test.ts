import { test, expect, describe, beforeEach, afterEach, jest, mock } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import type { Agent, FlatEntry, PendingQuestion, ReadAgentsResult } from "./agents";
import { makeAgent as _makeAgent, makeFlatAgent, waitFor } from "./test-utils";
import type { RepoEntry } from "./registry";

// --- Inject fake ./agents functions via the watcher's agentsCtx ---
// AgentWatcher consumes readAllAgents/detectAgentStates/buildAgentTree/
// flattenAgentTree/readPendingQuestions through an InjectionContext
// (`agentsCtx`, defined in watcher.ts and mirroring tmux-poller's spawnCtx).
// We inject these jest.fn fakes via agentsCtx.set() in beforeEach and restore
// the real implementations via agentsCtx.reset() in afterEach.
//
// This deliberately AVOIDS `mock.module("./agents", ...)`: bun's mock.module is
// a PROCESS-GLOBAL registry that is never auto-restored, so stubbing ./agents
// here used to leak into any later-loading test file whose ./agents binding
// resolved afterward — that file received the mockReset()-emptied stubs and got
// `undefined` back from the real readAllAgents/buildAgentTree it expected.
// Scoping the seam to agentsCtx keeps the swap local to this file and off the
// global module registry, so test load order no longer matters.
const mockReadAllAgents = jest.fn<(repos: Array<{ path: string; name: string }>, includeArchived?: boolean) => Promise<ReadAgentsResult>>();
const mockDetectAgentStates = jest.fn<(agents: Agent[]) => Promise<void>>();
const mockBuildAgentTree = jest.fn<(agents: Agent[]) => Agent[]>();
const mockFlattenAgentTree = jest.fn<(roots: Agent[]) => FlatEntry[]>();
const mockReadPendingQuestions = jest.fn<(repoPath: string) => Promise<PendingQuestion[]>>();

// Build a full ReadAgentsResult from the fields a given test cares about.
// readAllAgents always returns four fields; every watcher test only varies
// `agents`/`errors`, so default the two tmux-session fields to empty. (The old
// global mock let tests resolve a partial `{agents, errors}` and the watcher
// silently took `undefined` for the rest — this keeps the fakes structurally
// valid against the real return type without churning every call site.)
function readResult(partial: { agents?: Agent[]; errors?: any[] } = {}): ReadAgentsResult {
  return {
    agents: partial.agents ?? [],
    errors: partial.errors ?? [],
    orphanedTmuxSessions: [],
    liveTmuxSessions: new Set<string>(),
  };
}

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

// Import after mocking the fs module. agentsCtx is the watcher's injection seam
// for the ./agents functions — fakes are wired in via agentsCtx.set() below.
const { AgentWatcher, agentsCtx, mapInChunks } = await import("./watcher");
// Import coordinatorSpawnCtx to inject noop (prevents real tmux calls in getCoordinatorInfo)
const { coordinatorSpawnCtx } = await import("./coordinator");
// Import tmux-poller spawnCtx for tests that exercise captureTmuxOutput / display-message
const { spawnCtx: tmuxPollerSpawnCtx } = await import("./tmux-poller");

function makeAgent(id: string, archived = false): Agent {
  return _makeAgent({ id, archived });
}

function setupDefaultMocks(agents: Agent[] = []) {
  mockReadAllAgents.mockResolvedValue(readResult({ agents }));
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
    // Inject the jest.fn fakes into the watcher's ./agents seam. Done per-test
    // (after resetMocks) so each test starts from clean stubs; restored to the
    // real implementations in afterEach via agentsCtx.reset().
    agentsCtx.set({
      readAllAgents: mockReadAllAgents,
      detectAgentStates: mockDetectAgentStates,
      buildAgentTree: mockBuildAgentTree,
      flattenAgentTree: mockFlattenAgentTree,
      readPendingQuestions: mockReadPendingQuestions,
    });
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
    agentsCtx.reset();
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

  describe("periodic refresh", () => {
    // refresh() is the watcher's only timer: one full pass (readAllAgents +
    // detectAgentStates + coordinator + questions + onUpdate) every
    // REFRESH_INTERVAL_MS. There is no separate state-only poll.
    // Enough microtask turns for one whole refresh() chain to settle.
    const flushMicrotasks = async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };

    test("runs exactly one periodic pass every 2s", async () => {
      setupDefaultMocks([makeAgent("agent-1")]);
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );
      // Every stage of a pass, so a stage that ran on its own (the old
      // state-only poll ran detection without readAllAgents) shows up as a
      // mismatch.
      const passes = () => ({
        reads: mockReadAllAgents.mock.calls.length,
        detects: mockDetectAgentStates.mock.calls.length,
        questions: mockReadPendingQuestions.mock.calls.length,
        updates: updateCount,
      });
      const expectPasses = (n: number) =>
        expect(passes()).toEqual({ reads: n, detects: n, questions: n, updates: n });

      expect(AgentWatcher.REFRESH_INTERVAL_MS).toBe(2_000);

      jest.useFakeTimers();
      try {
        await watcher.start();
        expectPasses(1); // the initial load

        // Just under 2s — no pass yet.
        jest.advanceTimersByTime(1_999);
        await flushMicrotasks();
        expectPasses(1);

        // At 2s — exactly one pass.
        jest.advanceTimersByTime(1);
        await flushMicrotasks();
        expectPasses(2);

        // One more pass per 2s, and nothing in between.
        for (let n = 3; n <= 6; n++) {
          jest.advanceTimersByTime(1_000);
          await flushMicrotasks();
          expectPasses(n - 1);
          jest.advanceTimersByTime(1_000);
          await flushMicrotasks();
          expectPasses(n);
        }

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("periodic pass runs even when no agents are known (discovers new spawns)", async () => {
      setupDefaultMocks([]);
      let updateCount = 0;
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => { updateCount++; } }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        expect(mockReadAllAgents.mock.calls.length).toBe(1);
        expect(updateCount).toBe(1);

        // An agent spawned after start appears on the next tick.
        const spawned = makeAgent("agent-new");
        setupDefaultMocks([spawned]);
        jest.advanceTimersByTime(2_000);
        await flushMicrotasks();

        expect(mockReadAllAgents.mock.calls.length).toBe(2);
        expect(updateCount).toBe(2);
        expect(mockDetectAgentStates.mock.calls.at(-1)![0]).toEqual([spawned]);

        watcher.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    test("refresh requests that land mid-pass coalesce into one queued pass", async () => {
      // Every refresh entry point — the 2s tick, the fs.watch debounce,
      // setGroupByParent, recheckHealth and a direct refresh() (the dashboard's
      // executeAndRefresh) — goes through refresh(). While a pass runs, each
      // one only sets refreshQueued, so exactly one more pass follows and two
      // passes never run at once.
      setupDefaultMocks([makeAgent("agent-1")]);
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();

        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        let inFlight = 0;
        let maxInFlight = 0;
        mockDetectAgentStates.mockImplementation(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await blocked;
          } finally {
            inFlight--;
          }
        });

        // The 2s tick starts a pass that blocks in detectAgentStates.
        jest.advanceTimersByTime(2_000);
        await flushMicrotasks();
        expect(mockReadAllAgents.mock.calls.length).toBe(2);
        expect(inFlight).toBe(1);

        // Every entry point lands while that pass is blocked.
        jest.advanceTimersByTime(2_000);     // next periodic tick
        (watcher as any).debounceRefresh();  // fs.watch event
        jest.advanceTimersByTime(200);
        watcher.setGroupByParent(true);      // 'h' settings toggle
        await watcher.recheckHealth();       // 'H' keybinding
        // executeAndRefresh. Not awaited yet: a queued refresh() returns at
        // once, but one that wrongly started a second pass would block on the
        // same gate, and fake timers would keep the test timeout from firing.
        const direct = watcher.refresh();
        await flushMicrotasks();
        expect(mockReadAllAgents.mock.calls.length).toBe(2);

        // Releasing the blocked pass runs exactly one queued pass.
        release();
        await direct;
        await flushMicrotasks();
        expect(mockReadAllAgents.mock.calls.length).toBe(3);
        expect(mockDetectAgentStates.mock.calls.length).toBe(3);
        expect(maxInFlight).toBe(1);
        // The queued pass carries the grouping change.
        expect((mockFlattenAgentTree.mock.calls.at(-1) as unknown[])[3]).toBe(true);

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

        // Advance well past the 2s poll interval — no poll should fire
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
      mockReadAllAgents.mockResolvedValueOnce(readResult({ agents: [agentA, agentB] }));
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB]);
      mockFlattenAgentTree.mockReturnValueOnce([
        makeFlatAgent(agentA),
        makeFlatAgent(agentB),
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A, B, C] — C was added
      mockReadAllAgents.mockResolvedValueOnce(readResult({ agents: [agentA, agentB, agentC] }));
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
      mockReadAllAgents.mockResolvedValueOnce(readResult({ agents: [agentA, agentB] }));
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB]);
      mockFlattenAgentTree.mockReturnValueOnce([
        makeFlatAgent(agentA),
        makeFlatAgent(agentB),
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A] — B removed
      mockReadAllAgents.mockResolvedValueOnce(readResult({ agents: [agentA] }));
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
      mockReadAllAgents.mockResolvedValueOnce(readResult({ agents: [agentA, agentB] }));
      mockDetectAgentStates.mockResolvedValueOnce(undefined);
      mockBuildAgentTree.mockReturnValueOnce([agentA, agentB]);
      mockFlattenAgentTree.mockReturnValueOnce([
        makeFlatAgent(agentA),
        makeFlatAgent(agentB),
      ]);
      mockReadPendingQuestions.mockResolvedValue([]);

      // Second snapshot: [A, C] — B removed, C added
      mockReadAllAgents.mockResolvedValueOnce(readResult({ agents: [agentA, agentC] }));
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

      mockReadAllAgents.mockResolvedValue(readResult({ agents: [agent1] }));
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
      expect(mockDetectAgentStates).toHaveBeenCalledWith([agent1], {
        reap: true,
        confirmTmuxMissingAcrossPolls: true,
      });
    });

    test("detectAgentStates changes state between refreshes", async () => {
      const agent1 = makeAgent("agent-1");

      let callNum = 0;
      mockReadAllAgents.mockImplementation(async () => {
        // Return a fresh agent each time so state starts at "unknown"
        const a = makeAgent("agent-1");
        return readResult({ agents: [a] });
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

      mockReadAllAgents.mockResolvedValue(readResult({ agents: [agent1, agent2] }));
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
      mockReadAllAgents.mockResolvedValue(readResult({
        agents: [],
        errors: [{ agentDir: "/tmp/bad", error: "bad meta.json" }],
      }));
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
        return readResult();
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

    test("does not register an fs.watch on archive/ even when archive/ exists", async () => {
      setupDefaultMocks();

      // setupWatchers() registers one fs.watch per target and pushes each
      // resulting FSWatcher into `this.watchers`, guarded by try/catch (a
      // watch() on a missing path throws and is skipped). To make the count
      // deterministic and meaningful, create ALL THREE candidate targets up
      // front: agents/ (already made in beforeEach), archive/, and
      // user-questions.json — so all three are watchable. Only agents/ and
      // user-questions.json should actually be watched; archive/ must be skipped.
      //
      // Before the archive-skip change this registered 3 watchers per repo; now
      // it registers 2. Asserting exactly 2 (with archive/ present on disk and
      // watchable) proves the archive dir is deliberately not watched and FAILS
      // if anyone re-adds a watch(archiveDir) call. The `.watchers` accessor is
      // the same one the updateRepos tests below already use.
      await mkdir(join(tempDir, ".ittybitty", "archive"), { recursive: true });
      await writeFile(join(tempDir, ".ittybitty", "user-questions.json"), "{}");

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );
      await watcher.start();
      const watcherCount = (watcher as any).watchers.length;
      watcher.stop();

      // Exactly 2 (agents/ + user-questions.json), NOT 3 — archive/ exists on
      // disk and would be watchable, yet must not be watched.
      expect(watcherCount).toBe(2);
    });
  });

  describe("archived agents", () => {
    test("refresh() passes includeArchived=false to readAllAgents", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "test" }],
        { onUpdate: () => {} }
      );

      await watcher.refresh();

      // The hot refresh path must skip the archive dir entirely. readRepoAgents
      // never touches archive/ when its includeArchived arg is false.
      expect(mockReadAllAgents).toHaveBeenCalled();
      const lastCall = mockReadAllAgents.mock.calls.at(-1)!;
      expect(lastCall[1]).toBe(false);
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

    test("updateRepos does not affect the poll timer", async () => {
      setupDefaultMocks();

      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );

      jest.useFakeTimers();
      try {
        await watcher.start();
        const pollTimer = (watcher as any).pollTimer;
        expect(pollTimer).not.toBeNull();

        watcher.updateRepos([{ path: tempDir, name: "repo1-renamed" }]);

        // Poll timer should be unchanged
        expect((watcher as any).pollTimer).toBe(pollTimer);

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

  describe("setGroupByParent (live grouping toggle)", () => {
    // The mock's declared type only takes `roots`, but the watcher passes 4
    // args at runtime — read the 4th positional arg off the recorded call.
    const lastGroupByParentArg = (): unknown => {
      const calls = mockFlattenAgentTree.mock.calls;
      return calls.length ? (calls[calls.length - 1] as unknown[])[3] : undefined;
    };

    test("defaults to false — flattenAgentTree receives groupByParent=false", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );
      await watcher.start();
      watcher.stop();
      expect(lastGroupByParentArg()).toBe(false);
    });

    test("setGroupByParent(true) re-flattens with groupByParent=true (live, no restart)", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );
      await watcher.start();
      const callsBefore = mockFlattenAgentTree.mock.calls.length;

      watcher.setGroupByParent(true);
      // setGroupByParent kicks a refresh(); wait for that refresh to land
      // rather than for 10ms to pass. The assertions below are positive ("a
      // fresh flatten happened"), so an early wake-up fails the test.
      await waitFor(
        () => mockFlattenAgentTree.mock.calls.length > callsBefore,
        { message: "refresh triggered by setGroupByParent" },
      );
      watcher.stop();

      // A fresh flatten happened and it carried groupByParent=true.
      expect(mockFlattenAgentTree.mock.calls.length).toBeGreaterThan(callsBefore);
      expect(lastGroupByParentArg()).toBe(true);
    });

    test("setGroupByParent to the same value is a no-op (no extra refresh)", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );
      await watcher.start();
      const readCallsBefore = mockReadAllAgents.mock.calls.length;

      // Already false → setting false again must not trigger refresh().
      watcher.setGroupByParent(false);
      await new Promise((r) => setTimeout(r, 10));
      watcher.stop();

      expect(mockReadAllAgents.mock.calls.length).toBe(readCallsBefore);
    });

    test("setGroupByParent before start() does not refresh (not running)", async () => {
      setupDefaultMocks();
      const watcher = new AgentWatcher(
        [{ path: tempDir, name: "repo1" }],
        { onUpdate: () => {} }
      );
      // Not started yet — flipping the flag must not spawn a refresh.
      watcher.setGroupByParent(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(mockReadAllAgents.mock.calls.length).toBe(0);

      // But once started, the stored flag flows into the flatten call.
      await watcher.start();
      watcher.stop();
      expect(lastGroupByParentArg()).toBe(true);
    });
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

describe("health-check throttling (D2)", () => {
  test("HEALTH_CHECK_COOLDOWN_MS is raised to 5 minutes", () => {
    expect(AgentWatcher.HEALTH_CHECK_COOLDOWN_MS).toBe(300_000);
  });

  test("HEALTH_CHECK_CHUNK_SIZE bounds the per-tick spawn burst", () => {
    expect(AgentWatcher.HEALTH_CHECK_CHUNK_SIZE).toBe(8);
  });

  describe("mapInChunks", () => {
    test("never runs more than chunkSize calls concurrently, preserving order", async () => {
      let inFlight = 0;
      let peak = 0;
      const items = Array.from({ length: 20 }, (_, i) => i);
      const results = await mapInChunks(items, 8, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Yield twice so overlapping calls within a chunk genuinely coexist
        // before any of them decrements.
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return n * 2;
      });
      // First chunk fills to exactly the cap; no chunk boundary is ever crossed.
      expect(peak).toBe(8);
      expect(results).toEqual(items.map((n) => n * 2));
    });

    test("empty input performs no calls and returns []", async () => {
      let calls = 0;
      const results = await mapInChunks<number, number>([], 8, async (x) => {
        calls++;
        return x;
      });
      expect(results).toEqual([]);
      expect(calls).toBe(0);
    });

    test("chunkSize >= length runs everything in one chunk", async () => {
      let inFlight = 0;
      let peak = 0;
      await mapInChunks([1, 2, 3], 8, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return n;
      });
      expect(peak).toBe(3);
    });

    test("passes the correct absolute index across chunk boundaries", async () => {
      const seen: number[] = [];
      const items = ["a", "b", "c", "d", "e"];
      const out = await mapInChunks(items, 2, async (item, idx) => {
        seen.push(idx);
        return `${idx}:${item}`;
      });
      expect(seen.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
      expect(out).toEqual(["0:a", "1:b", "2:c", "3:d", "4:e"]);
    });
  });
});
