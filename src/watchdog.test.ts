import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { makeAgent } from "./test-utils";
import type { Agent } from "./agents";
import type { AgentState } from "./parse-state";
import {
  tick,
  getTracker,
  clearTrackers,
  createTracker,
  registerStateHandler,
  notifyManager,
  startWatchdog,
  stopWatchdog,
  isWatchdogRunning,
  getAllTrackers,
  INITIAL_NOTIFY_TICKS,
  MAX_NOTIFY_TICKS,
  POLL_INTERVAL_MS,
  setWatchdogSpawnRunner,
  resetWatchdogSpawnRunner,
  setWatchdogFetchUsage,
  resetWatchdogFetchUsage,
  acquireWatchdogLock,
  releaseWatchdogLock,
  readLockPid,
  setLockFilePath,
  resetLockFilePath,
  createDiskAgentProvider,
  setDiskProviderReadAllAgents,
  resetDiskProviderReadAllAgents,
  setDiskProviderDetectAgentStates,
  resetDiskProviderDetectAgentStates,
  type AgentTracker,
  type StateHandler,
} from "./watchdog";
import {
  setSendSpawnRunner,
  resetSendSpawnRunner,
} from "./ib-commands";
import type { SpawnResult } from "./types";

/** Create a mock spawn runner that records calls and succeeds */
function mockSpawnRunner() {
  const calls: Array<{ args: any[]; opts: any }> = [];
  const runner = (args: any[], opts?: any): any => {
    calls.push({ args: [...args], opts });
    // Return a mock process object
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(""));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(""));
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
    };
  };
  return { runner: runner as any, calls };
}

function agent(id: string, state: AgentState, manager: string | null = null): Agent {
  return makeAgent({
    id,
    state,
    meta: {
      id,
      session_id: `sess-${id}`,
      tmux_session: `tmux-${id}`,
      prompt: "test",
      manager,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "12345",
    },
  });
}

describe("watchdog", () => {
  let spawnMock: ReturnType<typeof mockSpawnRunner>;

  beforeEach(() => {
    clearTrackers();
    spawnMock = mockSpawnRunner();
    setSendSpawnRunner(spawnMock.runner);
    setWatchdogSpawnRunner(spawnMock.runner);
  });

  afterEach(() => {
    stopWatchdog();
    resetSendSpawnRunner();
    resetWatchdogSpawnRunner();
    resetWatchdogFetchUsage();
    clearTrackers();
  });

  // =========================================================================
  // Phase 15-A: Core loop, tracker management, waiting/unknown handlers
  // =========================================================================

  describe("createTracker", () => {
    test("returns fresh tracker with default values", () => {
      const tracker = createTracker();
      expect(tracker.previousState).toBeNull();
      expect(tracker.waitCounter).toBe(0);
      expect(tracker.notifyInterval).toBe(INITIAL_NOTIFY_TICKS);
      expect(tracker.completionNotified).toBe(false);
      expect(tracker.rateLimitBypassed).toBe(false);
    });
  });

  describe("getTracker", () => {
    test("creates tracker for new agent", () => {
      const tracker = getTracker("agent-1");
      expect(tracker.waitCounter).toBe(0);
    });

    test("returns same tracker on subsequent calls", () => {
      const t1 = getTracker("agent-1");
      t1.waitCounter = 5;
      const t2 = getTracker("agent-1");
      expect(t2.waitCounter).toBe(5);
      expect(t1).toBe(t2);
    });
  });

  describe("state tracking across ticks", () => {
    test("creates trackers for new agents on tick", async () => {
      const agents = [agent("a1", "running"), agent("a2", "waiting", "a1")];
      await tick(agents);
      expect(getAllTrackers().size).toBe(2);
    });

    test("prunes trackers for removed agents", async () => {
      const agents = [agent("a1", "running"), agent("a2", "waiting", "a1")];
      await tick(agents);
      expect(getAllTrackers().size).toBe(2);

      // Remove a2
      await tick([agent("a1", "running")]);
      expect(getAllTrackers().size).toBe(1);
      expect(getAllTrackers().has("a1")).toBe(true);
      expect(getAllTrackers().has("a2")).toBe(false);
    });

    test("tracks previousState after each tick", async () => {
      const agents = [agent("a1", "running")];
      await tick(agents);
      expect(getTracker("a1").previousState).toBe("running");

      agents[0] = agent("a1", "waiting");
      await tick(agents);
      expect(getTracker("a1").previousState).toBe("waiting");
    });

    test("processes children recursively", async () => {
      const child = agent("child", "waiting", "parent");
      const parent = makeAgent({
        id: "parent",
        state: "running",
        children: [child],
        meta: {
          id: "parent",
          session_id: "sess-parent",
          tmux_session: "tmux-parent",
          prompt: "test",
          manager: null,
          created: "2026-03-05T00:00:00Z",
          created_epoch: Math.floor(Date.now() / 1000) - 60,
          worktree: true,
          worker: false,
          yolo: false,
          model: "sonnet",
          claude_pid: "12345",
        },
      });
      await tick([parent]);
      expect(getAllTrackers().has("parent")).toBe(true);
      expect(getAllTrackers().has("child")).toBe(true);
    });
  });

  describe("waiting handler", () => {
    test("increments wait counter on each tick", async () => {
      const a1 = agent("a1", "waiting", "mgr");
      const mgr = agent("mgr", "running");
      const agents = [mgr, a1];

      await tick(agents);
      expect(getTracker("a1").waitCounter).toBe(1);

      await tick(agents);
      expect(getTracker("a1").waitCounter).toBe(2);
    });

    test("notifies manager after initial threshold (6 ticks = 30s)", async () => {
      const a1 = agent("a1", "waiting", "mgr");
      const mgr = agent("mgr", "running");
      const agents = [mgr, a1];

      // Tick 5 times — no notification yet
      for (let i = 0; i < 5; i++) {
        await tick(agents);
      }
      expect(getTracker("a1").waitCounter).toBe(5);

      // Tick 6 — threshold reached, notification sent
      await tick(agents);
      // After notification, counter resets to 0
      expect(getTracker("a1").waitCounter).toBe(0);
    });

    test("doubles notify interval after each notification (exponential backoff)", async () => {
      const a1 = agent("a1", "waiting", "mgr");
      const mgr = agent("mgr", "running");
      const agents = [mgr, a1];

      // First threshold: 6 ticks
      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick(agents);
      }
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS * 2); // 12

      // Second threshold: 12 ticks
      for (let i = 0; i < INITIAL_NOTIFY_TICKS * 2; i++) {
        await tick(agents);
      }
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS * 4); // 24

      // Third threshold: 24 ticks
      for (let i = 0; i < INITIAL_NOTIFY_TICKS * 4; i++) {
        await tick(agents);
      }
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS * 8); // 48
    });

    test("caps backoff at MAX_NOTIFY_TICKS (64 minutes)", async () => {
      const a1 = agent("a1", "waiting", "mgr");
      const mgr = agent("mgr", "running");
      const agents = [mgr, a1];

      // Manually set interval near the cap
      const tracker = getTracker("a1");
      tracker.notifyInterval = MAX_NOTIFY_TICKS / 2; // 384
      tracker.waitCounter = MAX_NOTIFY_TICKS / 2; // trigger notification

      await tick(agents);
      expect(getTracker("a1").notifyInterval).toBe(MAX_NOTIFY_TICKS);

      // Beyond the cap — stays at MAX
      tracker.waitCounter = MAX_NOTIFY_TICKS;
      await tick(agents);
      expect(getTracker("a1").notifyInterval).toBe(MAX_NOTIFY_TICKS);
    });

    test("does not notify if agent has no manager", async () => {
      const a1 = agent("a1", "waiting", null); // no manager
      const agents = [a1];

      // Run past threshold
      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick(agents);
      }
      // Counter should still reset (handler ran), but no sendMessage call
      expect(getTracker("a1").waitCounter).toBe(0);
      // Only tmux has-session calls if any — filter for "send" args
      const sendCalls = spawnMock.calls.filter((c) =>
        c.args.some((a: string) => typeof a === "string" && a.includes("send-keys"))
      );
      expect(sendCalls.length).toBe(0);
    });
  });

  describe("unknown handler", () => {
    test("increments wait counter on each tick", async () => {
      const a1 = agent("a1", "unknown", "mgr");
      const mgr = agent("mgr", "running");
      const agents = [mgr, a1];

      await tick(agents);
      expect(getTracker("a1").waitCounter).toBe(1);

      await tick(agents);
      expect(getTracker("a1").waitCounter).toBe(2);
    });

    test("notifies manager with 'unknown' message after threshold", async () => {
      const a1 = agent("a1", "unknown", "mgr");
      const mgr = agent("mgr", "running");
      const agents = [mgr, a1];

      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick(agents);
      }
      expect(getTracker("a1").waitCounter).toBe(0); // reset after notification

      // Verify the message contains "unknown"
      const sendKeysCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("unknown");
      });
      expect(sendKeysCalls.length).toBeGreaterThan(0);
    });

    test("uses same exponential backoff as waiting", async () => {
      const a1 = agent("a1", "unknown", "mgr");
      const mgr = agent("mgr", "running");
      const agents = [mgr, a1];

      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick(agents);
      }
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS * 2);
    });
  });

  describe("counter reset on state transitions", () => {
    test("running resets wait counter and backoff interval", async () => {
      const a1 = agent("a1", "waiting", "mgr");
      const mgr = agent("mgr", "running");

      // Build up backoff state
      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick([mgr, a1]);
      }
      // After first notification, interval doubled
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS * 2);

      // Transition to running
      const a1Running = agent("a1", "running", "mgr");
      await tick([mgr, a1Running]);
      expect(getTracker("a1").waitCounter).toBe(0);
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS);
    });

    test("waiting->running->waiting resets backoff completely", async () => {
      const mgr = agent("mgr", "running");

      // First waiting episode: build up backoff
      const a1Waiting = agent("a1", "waiting", "mgr");
      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick([mgr, a1Waiting]);
      }
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS * 2);

      // Transition to running
      await tick([mgr, agent("a1", "running", "mgr")]);
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS);

      // Second waiting episode: should start fresh
      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick([mgr, a1Waiting]);
      }
      // Should be 12 (doubled once from 6), not continuing from 24
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS * 2);
    });

    test("all non-backoff states reset counters", async () => {
      const nonBackoffStates: AgentState[] = ["running", "creating", "complete", "stopped", "compacting", "rate_limited"];

      for (const state of nonBackoffStates) {
        clearTrackers();
        spawnMock = mockSpawnRunner();
        setSendSpawnRunner(spawnMock.runner);
        setWatchdogSpawnRunner(spawnMock.runner);
        // For rate_limited, provide a mock fetchUsage that returns high usage
        setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));

        const tracker = getTracker("a1");
        tracker.waitCounter = 10;
        tracker.notifyInterval = INITIAL_NOTIFY_TICKS * 8;

        await tick([agent("a1", state)]);
        expect(getTracker("a1").waitCounter).toBe(0);
        expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS);
      }
    });

    test("waiting and unknown do NOT reset their own counters mid-backoff", async () => {
      const mgr = agent("mgr", "running");
      const a1 = agent("a1", "waiting", "mgr");

      // Tick 3 times
      for (let i = 0; i < 3; i++) {
        await tick([mgr, a1]);
      }
      expect(getTracker("a1").waitCounter).toBe(3);
      // Interval stays at initial since we haven't hit threshold
      expect(getTracker("a1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS);
    });

    test("running state does not increment wait counter", async () => {
      const a1 = agent("a1", "running");
      await tick([a1]);
      expect(getTracker("a1").waitCounter).toBe(0);
    });

    test("stopped state does not increment wait counter", async () => {
      const a1 = agent("a1", "stopped");
      await tick([a1]);
      expect(getTracker("a1").waitCounter).toBe(0);
    });

    test("creating state does not increment wait counter", async () => {
      const a1 = agent("a1", "creating");
      await tick([a1]);
      expect(getTracker("a1").waitCounter).toBe(0);
    });
  });

  describe("registerStateHandler", () => {
    test("custom handler is called for registered state", async () => {
      let called = false;
      // Override the stopped handler (effectively a no-op) temporarily
      registerStateHandler("stopped", async (_agent, _tracker) => {
        called = true;
      });

      const a1 = agent("a1", "stopped");
      await tick([a1]);
      expect(called).toBe(true);

      // Restore — register the real stopped handler (no-op)
      registerStateHandler("stopped", async () => {});
    });
  });

  describe("notifyManager", () => {
    test("sends message to manager agent", async () => {
      const mgr = agent("mgr", "running");
      const worker = agent("w1", "waiting", "mgr");

      await notifyManager(worker, "[watchdog]: test message", [mgr, worker]);

      // Should have calls to tmux (has-session check + send-keys)
      const hasSessionCalls = spawnMock.calls.filter((c) =>
        c.args.includes("has-session")
      );
      expect(hasSessionCalls.length).toBeGreaterThan(0);
    });

    test("no-op when agent has no manager", async () => {
      const a1 = agent("a1", "waiting", null);
      await notifyManager(a1, "test", [a1]);
      expect(spawnMock.calls.length).toBe(0);
    });

    test("no-op when manager not found in agent list", async () => {
      const a1 = agent("a1", "waiting", "nonexistent");
      await notifyManager(a1, "test", [a1]);
      expect(spawnMock.calls.length).toBe(0);
    });

    test("finds manager in nested children", async () => {
      const grandchild = agent("gc", "waiting", "child");
      const child = makeAgent({
        id: "child",
        state: "running",
        children: [grandchild],
        meta: {
          id: "child",
          session_id: "sess-child",
          tmux_session: "tmux-child",
          prompt: "test",
          manager: "root",
          created: "2026-03-05T00:00:00Z",
          created_epoch: Math.floor(Date.now() / 1000) - 60,
          worktree: true,
          worker: false,
          yolo: false,
          model: "sonnet",
          claude_pid: "12345",
        },
      });
      const root = makeAgent({
        id: "root",
        state: "running",
        children: [child],
        meta: {
          id: "root",
          session_id: "sess-root",
          tmux_session: "tmux-root",
          prompt: "test",
          manager: null,
          created: "2026-03-05T00:00:00Z",
          created_epoch: Math.floor(Date.now() / 1000) - 60,
          worktree: true,
          worker: false,
          yolo: false,
          model: "sonnet",
          claude_pid: "12345",
        },
      });

      await notifyManager(grandchild, "test", [root]);
      // Should find "child" as manager in nested tree
      const hasSessionCalls = spawnMock.calls.filter((c) =>
        c.args.includes("has-session")
      );
      expect(hasSessionCalls.length).toBeGreaterThan(0);
    });
  });

  describe("startWatchdog / stopWatchdog", () => {
    test("startWatchdog is idempotent (no double-start)", () => {
      startWatchdog(() => []);
      // Second call should be no-op (doesn't throw)
      startWatchdog(() => []);
      stopWatchdog();
    });

    test("stopWatchdog clears trackers", () => {
      startWatchdog(() => []);
      getTracker("test-agent");
      expect(getAllTrackers().size).toBe(1);
      stopWatchdog();
      expect(getAllTrackers().size).toBe(0);
    });
  });

  describe("constants", () => {
    test("POLL_INTERVAL_MS is 5 seconds", () => {
      expect(POLL_INTERVAL_MS).toBe(5000);
    });

    test("INITIAL_NOTIFY_TICKS is 6 (30s at 5s/tick)", () => {
      expect(INITIAL_NOTIFY_TICKS).toBe(6);
    });

    test("MAX_NOTIFY_TICKS is 768 (64 minutes at 5s/tick)", () => {
      expect(MAX_NOTIFY_TICKS).toBe(768);
    });

    test("backoff sequence matches ib: 30s, 1m, 2m, 4m, 8m, 16m, 32m, 64m", () => {
      // Verify the doubling sequence in seconds
      const ticksToSeconds = (ticks: number) => ticks * (POLL_INTERVAL_MS / 1000);
      let interval = INITIAL_NOTIFY_TICKS;
      const sequence: number[] = [];

      for (let i = 0; i < 8; i++) {
        sequence.push(ticksToSeconds(interval));
        interval = Math.min(interval * 2, MAX_NOTIFY_TICKS);
      }

      expect(sequence).toEqual([30, 60, 120, 240, 480, 960, 1920, 3840]);
    });
  });

  describe("full backoff integration", () => {
    test("waiting agent goes through full backoff cycle", async () => {
      const mgr = agent("mgr", "running");
      const a1 = agent("a1", "waiting", "mgr");
      const agents = [mgr, a1];

      const tracker = getTracker("a1");
      const notifications: number[] = []; // tick numbers when notifications fire

      let totalTicks = 0;

      // First notification at tick 6
      for (let i = 0; i < INITIAL_NOTIFY_TICKS; i++) {
        await tick(agents);
        totalTicks++;
      }
      notifications.push(totalTicks);
      expect(tracker.waitCounter).toBe(0); // reset

      // Second at tick 6 + 12 = 18
      for (let i = 0; i < INITIAL_NOTIFY_TICKS * 2; i++) {
        await tick(agents);
        totalTicks++;
      }
      notifications.push(totalTicks);
      expect(tracker.waitCounter).toBe(0);

      // Third at tick 18 + 24 = 42
      for (let i = 0; i < INITIAL_NOTIFY_TICKS * 4; i++) {
        await tick(agents);
        totalTicks++;
      }
      notifications.push(totalTicks);
      expect(tracker.waitCounter).toBe(0);

      expect(notifications).toEqual([6, 18, 42]);
    });
  });

  // =========================================================================
  // Phase 15-B: complete/running/creating/compacting/stopped/rate_limited handlers
  // =========================================================================

  describe("complete handler", () => {
    test("sends one-time notification to manager via tick", async () => {
      const mgr = agent("mgr", "running");
      const w1 = agent("w1", "complete", "mgr");

      await tick([mgr, w1]);

      expect(getTracker("w1").completionNotified).toBe(true);
      const sendKeysCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("recently completed");
      });
      expect(sendKeysCalls.length).toBeGreaterThan(0);
    });

    test("does not re-notify on subsequent ticks", async () => {
      const mgr = agent("mgr", "running");
      const w1 = agent("w1", "complete", "mgr");

      await tick([mgr, w1]);
      await tick([mgr, w1]);
      await tick([mgr, w1]);

      const completedCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("recently completed");
      });
      expect(completedCalls.length).toBe(1);
    });

    test("skips notification when no manager", async () => {
      const w1 = agent("w1", "complete", null);

      await tick([w1]);

      expect(getTracker("w1").completionNotified).toBe(true);
      const sendKeysCalls = spawnMock.calls.filter((c) =>
        c.args.some((a: string) => typeof a === "string" && a.includes("send-keys"))
      );
      expect(sendKeysCalls.length).toBe(0);
    });
  });

  describe("running handler (completionNotified clearing)", () => {
    test("clears completionNotified when transitioning from complete to running", async () => {
      const mgr = agent("mgr", "running");
      const w1 = agent("w1", "complete", "mgr");

      await tick([mgr, w1]);
      expect(getTracker("w1").completionNotified).toBe(true);

      const w1Running = agent("w1", "running", "mgr");
      await tick([mgr, w1Running]);
      expect(getTracker("w1").completionNotified).toBe(false);
    });

    test("complete -> running -> complete sends two notifications", async () => {
      const mgr = agent("mgr", "running");

      await tick([mgr, agent("w1", "complete", "mgr")]);
      const firstCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("recently completed");
      }).length;
      expect(firstCalls).toBe(1);

      await tick([mgr, agent("w1", "running", "mgr")]);

      await tick([mgr, agent("w1", "complete", "mgr")]);
      const totalCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("recently completed");
      }).length;
      expect(totalCalls).toBe(2);
    });

    test("clears rateLimitBypassed flag on running", async () => {
      const a1 = agent("a1", "running");
      const tracker = getTracker("a1");
      tracker.rateLimitBypassed = true;

      await tick([a1]);

      expect(tracker.rateLimitBypassed).toBe(false);
    });
  });

  describe("creating handler", () => {
    test("does NOT clear completionNotified", async () => {
      const a1 = agent("a1", "creating");
      const tracker = getTracker("a1");
      tracker.completionNotified = true;

      await tick([a1]);

      expect(tracker.completionNotified).toBe(true);
    });

    test("clears rateLimitBypassed flag", async () => {
      const a1 = agent("a1", "creating");
      const tracker = getTracker("a1");
      tracker.rateLimitBypassed = true;

      await tick([a1]);

      expect(tracker.rateLimitBypassed).toBe(false);
    });
  });

  describe("compacting handler", () => {
    test("does NOT clear completionNotified", async () => {
      const a1 = agent("a1", "compacting");
      const tracker = getTracker("a1");
      tracker.completionNotified = true;

      await tick([a1]);

      expect(tracker.completionNotified).toBe(true);
    });

    test("clears rateLimitBypassed flag", async () => {
      const a1 = agent("a1", "compacting");
      const tracker = getTracker("a1");
      tracker.rateLimitBypassed = true;

      await tick([a1]);

      expect(tracker.rateLimitBypassed).toBe(false);
    });
  });

  describe("rate_limited handler", () => {
    test("sends Enter to tmux on first detection", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));

      const a1 = agent("a1", "rate_limited");
      await tick([a1]);

      const enterCalls = spawnMock.calls.filter((c) =>
        c.args.includes("send-keys") && c.args.includes("Enter") && c.args.includes("tmux-a1")
      );
      expect(enterCalls.length).toBe(1);
      expect(getTracker("a1").rateLimitBypassed).toBe(true);
    });

    test("does not re-send Enter on subsequent ticks", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));

      const a1 = agent("a1", "rate_limited");
      await tick([a1]);
      const firstEnterCalls = spawnMock.calls.filter((c) =>
        c.args.includes("send-keys") && c.args.includes("Enter") && c.args.includes("tmux-a1")
      ).length;

      await tick([a1]);
      const secondEnterCalls = spawnMock.calls.filter((c) =>
        c.args.includes("send-keys") && c.args.includes("Enter") && c.args.includes("tmux-a1")
      ).length;

      expect(secondEnterCalls).toBe(firstEnterCalls);
    });

    test("nudges agent when usage drops below 5% threshold", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 3, weeklyPct: 30, sessionReset: "now", weeklyReset: "2d" }, error: false }));

      const a1 = agent("a1", "rate_limited");
      await tick([a1]);

      const nudgeCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("Usage has refreshed");
      });
      expect(nudgeCalls.length).toBeGreaterThan(0);
      expect(getTracker("a1").rateLimitBypassed).toBe(false);
    });

    test("does not nudge when usage is still high", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 50, weeklyPct: 30, sessionReset: "1h", weeklyReset: "2d" }, error: false }));

      const a1 = agent("a1", "rate_limited");
      const tracker = getTracker("a1");
      tracker.rateLimitBypassed = true;

      await tick([a1]);

      const nudgeCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("Usage has refreshed");
      });
      expect(nudgeCalls.length).toBe(0);
    });

    test("handles null usage gracefully", async () => {
      setWatchdogFetchUsage(async () => ({ data: null, error: true }));

      const a1 = agent("a1", "rate_limited");
      const tracker = getTracker("a1");
      tracker.rateLimitBypassed = true;

      await tick([a1]);

      const nudgeCalls = spawnMock.calls.filter((c) => {
        const joined = c.args.join(" ");
        return joined.includes("send-keys") && joined.includes("Usage has refreshed");
      });
      expect(nudgeCalls.length).toBe(0);
    });

    test("resets wait counters", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));

      const a1 = agent("a1", "rate_limited");
      const tracker = getTracker("a1");
      tracker.waitCounter = 10;
      tracker.notifyInterval = INITIAL_NOTIFY_TICKS * 8;

      await tick([a1]);

      expect(tracker.waitCounter).toBe(0);
      expect(tracker.notifyInterval).toBe(INITIAL_NOTIFY_TICKS);
    });
  });

  describe("stopped handler", () => {
    test("resets counters via non-backoff reset", async () => {
      const a1 = agent("a1", "stopped");
      const tracker = getTracker("a1");
      tracker.waitCounter = 10;
      tracker.notifyInterval = INITIAL_NOTIFY_TICKS * 8;

      await tick([a1]);

      expect(tracker.waitCounter).toBe(0);
      expect(tracker.notifyInterval).toBe(INITIAL_NOTIFY_TICKS);
    });

    test("does not send any notifications", async () => {
      const a1 = agent("a1", "stopped");
      await tick([a1]);

      const sendKeysCalls = spawnMock.calls.filter((c) =>
        c.args.some((a: string) => typeof a === "string" && a.includes("send-keys"))
      );
      expect(sendKeysCalls.length).toBe(0);
    });
  });

  // =========================================================================
  // Full lifecycle integration tests
  // =========================================================================

  describe("lifecycle integration", () => {
    test("waiting accumulates across ticks then resets on running", async () => {
      const mgr = agent("mgr", "running");

      for (let i = 0; i < 3; i++) {
        await tick([mgr, agent("w1", "waiting", "mgr")]);
      }
      expect(getTracker("w1").waitCounter).toBe(3);

      await tick([mgr, agent("w1", "running", "mgr")]);
      expect(getTracker("w1").waitCounter).toBe(0);
      expect(getTracker("w1").notifyInterval).toBe(INITIAL_NOTIFY_TICKS);

      for (let i = 0; i < 5; i++) {
        await tick([mgr, agent("w1", "waiting", "mgr")]);
      }
      expect(getTracker("w1").waitCounter).toBe(5);

      await tick([mgr, agent("w1", "waiting", "mgr")]);
      expect(getTracker("w1").waitCounter).toBe(0);
    });
  });

  // =========================================================================
  // Phase 20: Lock file management
  // =========================================================================

  describe("lock file management", () => {
    let tmpLockFile: string;

    beforeEach(() => {
      const tmpDir = join(tmpdir(), `watchdog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
      tmpLockFile = join(tmpDir, "watchdog.lock");
      setLockFilePath(tmpLockFile);
    });

    afterEach(() => {
      try { unlinkSync(tmpLockFile); } catch { /* ok */ }
      resetLockFilePath();
    });

    test("acquireWatchdogLock() writes PID and returns true when no lock exists", () => {
      expect(acquireWatchdogLock()).toBe(true);
      const content = readFileSync(tmpLockFile, "utf-8").trim();
      expect(parseInt(content, 10)).toBe(process.pid);
    });

    test("acquireWatchdogLock() returns false when lock is held by a live PID", () => {
      // Acquire first
      expect(acquireWatchdogLock()).toBe(true);
      // Try to acquire again from same process — PID is alive
      expect(acquireWatchdogLock()).toBe(false);
    });

    test("acquireWatchdogLock() returns true for stale PID (dead process)", () => {
      // Write a PID that definitely doesn't exist
      writeFileSync(tmpLockFile, "999999999", "utf-8");
      expect(acquireWatchdogLock()).toBe(true);
      const content = readFileSync(tmpLockFile, "utf-8").trim();
      expect(parseInt(content, 10)).toBe(process.pid);
    });

    test("releaseWatchdogLock() removes lock file when it contains our PID", () => {
      acquireWatchdogLock();
      expect(existsSync(tmpLockFile)).toBe(true);
      releaseWatchdogLock();
      expect(existsSync(tmpLockFile)).toBe(false);
    });

    test("releaseWatchdogLock() does NOT remove lock file with different PID", () => {
      writeFileSync(tmpLockFile, "999999999", "utf-8");
      releaseWatchdogLock();
      expect(existsSync(tmpLockFile)).toBe(true);
    });

    test("readLockPid() returns PID from lock file", () => {
      writeFileSync(tmpLockFile, "12345", "utf-8");
      expect(readLockPid()).toBe(12345);
    });

    test("readLockPid() returns null when no lock file", () => {
      expect(readLockPid()).toBeNull();
    });

    test("isWatchdogRunning() returns true when lock has live PID", () => {
      acquireWatchdogLock();
      expect(isWatchdogRunning()).toBe(true);
      releaseWatchdogLock();
    });

    test("isWatchdogRunning() returns false when no lock file", () => {
      expect(isWatchdogRunning()).toBe(false);
    });

    test("isWatchdogRunning() returns false when lock has dead PID", () => {
      writeFileSync(tmpLockFile, "999999999", "utf-8");
      expect(isWatchdogRunning()).toBe(false);
    });
  });

  // =========================================================================
  // Phase 20: Disk-based agent provider
  // =========================================================================

  describe("createDiskAgentProvider", () => {
    afterEach(() => {
      resetDiskProviderReadAllAgents();
      resetDiskProviderDetectAgentStates();
    });

    test("returns agents from readAllAgents after detectAgentStates", async () => {
      const mockAgents = [agent("a1", "unknown"), agent("a2", "unknown")];
      setDiskProviderReadAllAgents(async () => ({
        agents: mockAgents,
        errors: [],
        orphanedTmuxSessions: [],
      }));
      setDiskProviderDetectAgentStates(async (agents) => {
        for (const a of agents) a.state = "running";
      });

      const provider = createDiskAgentProvider([{ path: "/repos/test", name: "test" }]);
      const result = await provider();
      expect(result.length).toBe(2);
      expect(result[0]!.state).toBe("running");
      expect(result[1]!.state).toBe("running");
    });

    test("returns empty array when no agents found", async () => {
      setDiskProviderReadAllAgents(async () => ({
        agents: [],
        errors: [],
        orphanedTmuxSessions: [],
      }));

      const provider = createDiskAgentProvider([{ path: "/repos/test", name: "test" }]);
      const result = await provider();
      expect(result.length).toBe(0);
    });

    test("does not call detectAgentStates when no agents", async () => {
      let detectCalled = false;
      setDiskProviderReadAllAgents(async () => ({
        agents: [],
        errors: [],
        orphanedTmuxSessions: [],
      }));
      setDiskProviderDetectAgentStates(async () => {
        detectCalled = true;
      });

      const provider = createDiskAgentProvider([{ path: "/repos/test", name: "test" }]);
      await provider();
      expect(detectCalled).toBe(false);
    });
  });
});
