import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
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
  getAllTrackers,
  INITIAL_NOTIFY_TICKS,
  MAX_NOTIFY_TICKS,
  POLL_INTERVAL_MS,
  COMPACT_CHECK_COOLDOWN_MS,
  TMUX_GONE_GRACE_MS,
  setWatchdogSpawnRunner,
  resetWatchdogSpawnRunner,
  setWatchdogFetchUsage,
  resetWatchdogFetchUsage,
  setWatchdogReadConfig,
  resetWatchdogReadConfig,
  setWatchdogNow,
  resetWatchdogNow,
  runPerAgentWatchdog,
  setPerAgentExistsSync,
  resetPerAgentExistsSync,
  setPerAgentCaptureTmux,
  resetPerAgentCaptureTmux,
  setPerAgentReadMeta,
  resetPerAgentReadMeta,
  setPerAgentSleep,
  resetPerAgentSleep,
  setPerAgentReadState,
  resetPerAgentReadState,
  setWatchdogSleep,
  resetWatchdogSleep,
  setWatchdogCaptureTmux,
  resetWatchdogCaptureTmux,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_RETRY_DELAY_MS,
  type AgentTracker,
  type StateHandler,
} from "./watchdog";
import {
  setSendSpawnRunner,
  resetSendSpawnRunner,
} from "./ib-commands";
import {
  setUsageReader,
  resetUsageReader,
  setCompactSpawnRunner,
  resetCompactSpawnRunner,
} from "./auto-compact";
import {
  spawnCtx as tmuxPollerSpawnCtx,
} from "./tmux-poller";
import type { SpawnResult } from "./types";
import type { ConfigResult } from "./config";

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
    clearTrackers();
    resetSendSpawnRunner();
    resetWatchdogSpawnRunner();
    tmuxPollerSpawnCtx.reset();
    resetWatchdogFetchUsage();
    resetWatchdogReadConfig();
    resetWatchdogNow();
    resetUsageReader();
    resetCompactSpawnRunner();
    resetWatchdogSleep();
    resetWatchdogCaptureTmux();
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

    test("saves debug log on first transition to unknown state", async () => {
      const tmpDir = join(tmpdir(), `watchdog-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });

      // Create agent with repoPath pointing to our temp dir
      const a1 = agent("a1", "unknown", "mgr");
      a1.repoPath = tmpDir;
      const mgr = agent("mgr", "running");

      // Mock tmux-poller to return fake output
      const tmuxMock = mockSpawnRunner();
      // Override the stdout to return tmux output
      const origRunner = tmuxMock.runner;
      const tmuxRunner = (args: any[], opts?: any): any => {
        const result = origRunner(args, opts);
        if (args[0] === "tmux" && args[1] === "capture-pane") {
          return {
            ...result,
            stdout: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("fake tmux output for debug"));
                controller.close();
              },
            }),
          };
        }
        return result;
      };
      tmuxPollerSpawnCtx.set(tmuxRunner as any);

      // First tick: transition from null to unknown — should save debug log
      await tick([mgr, a1]);

      const debugDir = join(tmpDir, ".ittybitty", "agents", "a1", "debug-logs");
      const files = await Array.fromAsync(new Bun.Glob("watchdog-*-unknown.txt").scan(debugDir));
      expect(files.length).toBe(1);

      const content = await Bun.file(join(debugDir, files[0]!)).text();
      expect(content).toContain("fake tmux output for debug");

      // Second tick: still unknown — should NOT create another debug file
      await tick([mgr, a1]);
      const files2 = await Array.fromAsync(new Bun.Glob("watchdog-*-unknown.txt").scan(debugDir));
      expect(files2.length).toBe(1);

      // Clean up
      const { rmSync } = require("fs");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("does not save debug log when no tmux session", async () => {
      const a1 = agent("a1", "unknown", "mgr");
      a1.meta.tmux_session = "";
      const mgr = agent("mgr", "running");

      // Should not throw even without tmux session
      await tick([mgr, a1]);
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
        // For rate_limited retry loop
        setWatchdogSleep(async () => {});
        setWatchdogCaptureTmux(async () => "running some task (Esc to interrupt)");

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
    test("sends Enter to tmux on first detection with retry loop", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      // After first Enter, still rate limited; after second, resolved
      let captureCount = 0;
      setWatchdogCaptureTmux(async () => {
        captureCount++;
        if (captureCount === 1) return "rate_limit_error: usage limit reached";
        return "running some task (Esc to interrupt)";
      });

      const a1 = agent("a1", "rate_limited");
      await tick([a1]);

      const enterCalls = spawnMock.calls.filter((c) =>
        c.args.includes("send-keys") && c.args.includes("Enter") && c.args.includes("tmux-a1")
      );
      // Should have sent Enter twice (first attempt still rate limited, second resolves)
      expect(enterCalls.length).toBe(2);
      expect(getTracker("a1").rateLimitBypassed).toBe(true);
    });

    test("retries up to 3 times if still rate limited", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      // Always return rate limited
      setWatchdogCaptureTmux(async () => "rate_limit_error: usage limit reached");

      const a1 = agent("a1", "rate_limited");
      await tick([a1]);

      const enterCalls = spawnMock.calls.filter((c) =>
        c.args.includes("send-keys") && c.args.includes("Enter") && c.args.includes("tmux-a1")
      );
      expect(enterCalls.length).toBe(RATE_LIMIT_MAX_RETRIES);
      expect(getTracker("a1").rateLimitBypassed).toBe(true);
    });

    test("breaks retry loop early when state clears", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      // First capture: resolved immediately
      setWatchdogCaptureTmux(async () => "running some task (Esc to interrupt)");

      const a1 = agent("a1", "rate_limited");
      await tick([a1]);

      const enterCalls = spawnMock.calls.filter((c) =>
        c.args.includes("send-keys") && c.args.includes("Enter") && c.args.includes("tmux-a1")
      );
      // Only 1 Enter — first attempt resolved it
      expect(enterCalls.length).toBe(1);
      expect(getTracker("a1").rateLimitBypassed).toBe(true);
    });

    test("waits 2s between retry attempts", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      const sleepCalls: number[] = [];
      setWatchdogSleep(async (ms) => { sleepCalls.push(ms); });
      setWatchdogCaptureTmux(async () => "rate_limit_error: usage limit reached");

      const a1 = agent("a1", "rate_limited");
      await tick([a1]);

      expect(sleepCalls.length).toBe(RATE_LIMIT_MAX_RETRIES);
      for (const ms of sleepCalls) {
        expect(ms).toBe(RATE_LIMIT_RETRY_DELAY_MS);
      }
    });

    test("does not re-send Enter on subsequent ticks", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      setWatchdogCaptureTmux(async () => "running some task (Esc to interrupt)");

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
      setWatchdogSleep(async () => {});
      setWatchdogCaptureTmux(async () => "running some task (Esc to interrupt)");

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
      setWatchdogSleep(async () => {});
      setWatchdogCaptureTmux(async () => "running some task (Esc to interrupt)");

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

  describe("unknown handler debug log", () => {
    test("saves debug log only on first transition to unknown", async () => {
      // saveUnknownDebugLog is called when previousState !== "unknown"
      // It silently handles missing tmux sessions, so no crash expected
      const a1 = agent("a1", "unknown");
      const tracker = getTracker("a1");

      // First tick: previousState is null, should trigger saveUnknownDebugLog
      await tick([a1]);
      expect(tracker.previousState).toBe("unknown");

      // Second tick: previousState is "unknown", should NOT trigger saveUnknownDebugLog
      await tick([a1]);
      expect(tracker.previousState).toBe("unknown");
    });

    test("does not throw for non-existent repoPath", async () => {
      const a1 = makeAgent({
        id: "nonexistent-agent",
        state: "unknown" as AgentState,
        repoPath: "/nonexistent/path",
      });

      // Should not throw — error is caught silently
      await tick([a1]);
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
  // Auto-compact integration
  // =========================================================================

  describe("auto-compact integration", () => {
    function mockConfig(threshold: number | undefined): ConfigResult {
      return {
        autoCompactThreshold: { value: threshold, source: threshold != null ? "user" : "default" },
      };
    }

    let compactCalls: Array<{ args: any[] }>;

    beforeEach(() => {
      compactCalls = [];
      setCompactSpawnRunner((cmd) => {
        compactCalls.push({ args: [...cmd] });
        return { exited: Promise.resolve(0) };
      });
      // Set time to a large value so cooldown is satisfied on first tick
      setWatchdogNow(() => 100_000);
    });

    afterEach(() => {
      resetCompactSpawnRunner();
      resetUsageReader();
      resetWatchdogReadConfig();
      resetWatchdogNow();
    });

    test("sends /compact when usage exceeds threshold for running agent", async () => {
      setUsageReader(async () => 85);
      setWatchdogReadConfig(async () => mockConfig(80));

      const a1 = agent("a1", "running");
      await tick([a1]);

      const compactSendKeys = compactCalls.filter((c) =>
        c.args.includes("/compact")
      );
      expect(compactSendKeys.length).toBe(1);
      expect(getTracker("a1").compactState.compactSent).toBe(true);
    });

    test("sends /compact when usage exceeds threshold for waiting agent", async () => {
      setUsageReader(async () => 90);
      setWatchdogReadConfig(async () => mockConfig(80));

      const a1 = agent("a1", "waiting");
      await tick([a1]);

      const compactSendKeys = compactCalls.filter((c) =>
        c.args.includes("/compact")
      );
      expect(compactSendKeys.length).toBe(1);
    });

    test("does not send /compact when usage is below threshold", async () => {
      setUsageReader(async () => 50);
      setWatchdogReadConfig(async () => mockConfig(80));

      const a1 = agent("a1", "running");
      await tick([a1]);

      const compactSendKeys = compactCalls.filter((c) =>
        c.args.includes("/compact")
      );
      expect(compactSendKeys.length).toBe(0);
      expect(getTracker("a1").compactState.compactSent).toBe(false);
    });

    test("does not check when autoCompactThreshold is undefined", async () => {
      let usageChecked = false;
      setUsageReader(async () => {
        usageChecked = true;
        return 90;
      });
      setWatchdogReadConfig(async () => mockConfig(undefined));

      const a1 = agent("a1", "running");
      await tick([a1]);

      expect(usageChecked).toBe(false);
    });

    test("does not check for non-running/non-waiting states", async () => {
      let usageChecked = false;
      setUsageReader(async () => {
        usageChecked = true;
        return 90;
      });
      setWatchdogReadConfig(async () => mockConfig(80));

      for (const state of ["complete", "stopped", "creating", "compacting"] as const) {
        usageChecked = false;
        clearTrackers();
        const a1 = agent("a1", state);
        await tick([a1]);
        expect(usageChecked).toBe(false);
      }
    });

    test("respects per-agent cooldown — skips check within cooldown period", async () => {
      let usageCheckCount = 0;
      setUsageReader(async () => {
        usageCheckCount++;
        return 50;
      });
      setWatchdogReadConfig(async () => mockConfig(80));

      let currentTime = 100_000;
      setWatchdogNow(() => currentTime);

      const a1 = agent("a1", "running");
      await tick([a1]);
      expect(usageCheckCount).toBe(1);

      // Second tick 5s later — should be within cooldown
      currentTime += 5_000;
      await tick([a1]);
      expect(usageCheckCount).toBe(1);

      // Third tick 60s after first — cooldown expired
      currentTime = 100_000 + COMPACT_CHECK_COOLDOWN_MS;
      await tick([a1]);
      expect(usageCheckCount).toBe(2);
    });

    test("does not re-send /compact once compactSent is true", async () => {
      setUsageReader(async () => 90);
      setWatchdogReadConfig(async () => mockConfig(80));

      let currentTime = 100_000;
      setWatchdogNow(() => currentTime);

      const a1 = agent("a1", "running");
      await tick([a1]);
      expect(compactCalls.filter((c) => c.args.includes("/compact")).length).toBe(1);

      // Advance past cooldown
      currentTime += COMPACT_CHECK_COOLDOWN_MS;
      await tick([a1]);
      // checkAndCompact should not send again because compactSent is true
      expect(compactCalls.filter((c) => c.args.includes("/compact")).length).toBe(1);
    });

    test("resets compactSent when usage drops below threshold", async () => {
      let usagePct = 90;
      setUsageReader(async () => usagePct);
      setWatchdogReadConfig(async () => mockConfig(80));

      let currentTime = 100_000;
      setWatchdogNow(() => currentTime);

      const a1 = agent("a1", "running");
      await tick([a1]);
      expect(getTracker("a1").compactState.compactSent).toBe(true);

      // Usage drops
      usagePct = 50;
      currentTime += COMPACT_CHECK_COOLDOWN_MS;
      await tick([a1]);
      expect(getTracker("a1").compactState.compactSent).toBe(false);
    });

    test("COMPACT_CHECK_COOLDOWN_MS is 60 seconds", () => {
      expect(COMPACT_CHECK_COOLDOWN_MS).toBe(60_000);
    });

    test("tracker initializes with compactState and lastCompactCheckMs", () => {
      const tracker = createTracker();
      expect(tracker.compactState).toEqual({ compactSent: false });
      expect(tracker.lastCompactCheckMs).toBe(0);
    });

    test("gracefully handles config read errors", async () => {
      setUsageReader(async () => 90);
      setWatchdogReadConfig(async () => {
        throw new Error("config read failed");
      });

      const a1 = agent("a1", "running");
      // Should not throw
      await tick([a1]);
      expect(compactCalls.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Per-agent watchdog tests
// ---------------------------------------------------------------------------

describe("runPerAgentWatchdog", () => {
  let worktreeExists: boolean;
  let tmuxOutput: string | null;
  let pollCount: number;
  let currentTime: number;

  // Use a real Bun.sleep override by controlling when the loop exits
  // via worktreeExists and tmuxOutput

  beforeEach(() => {
    worktreeExists = true;
    tmuxOutput = "I HAVE COMPLETED THE GOAL"; // default: complete state
    pollCount = 0;
    currentTime = 1000000;

    setPerAgentExistsSync((_path: string) => worktreeExists);
    setPerAgentCaptureTmux(async (_session: string) => {
      pollCount++;
      return tmuxOutput;
    });
    setPerAgentReadMeta(async (_dir: string) => ({
      meta: {
        id: "agent-test1",
        session_id: "sid-123",
        tmux_session: "tmux-test1",
        prompt: "test",
        manager: "agent-mgr",
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "999",
      },
    }));
    setWatchdogNow(() => currentTime);
    // No-op sleep for fast tests
    setPerAgentSleep(async () => {});
    // Stub sendMessage spawn runner to no-op
    setSendSpawnRunner(() => ({ stdout: "", exitCode: 0 }) as any);
    // Disable auto-compact
    setWatchdogReadConfig(async () => ({} as any));
  });

  afterEach(() => {
    resetPerAgentExistsSync();
    resetPerAgentCaptureTmux();
    resetPerAgentReadMeta();
    resetPerAgentSleep();
    resetWatchdogNow();
    resetSendSpawnRunner();
    resetWatchdogReadConfig();
    resetWatchdogSpawnRunner();
    resetPerAgentReadState();
  });

  test("auto-accepts MCP server permissions prompt", async () => {
    const sentKeys: string[][] = [];
    setWatchdogSpawnRunner((cmd, _opts) => {
      sentKeys.push(cmd);
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
    });

    let captureCalls = 0;
    setPerAgentCaptureTmux(async (_session: string) => {
      captureCalls++;
      if (captureCalls <= 2) {
        // First two captures: MCP prompt visible
        return [
          "New MCP server found in .mcp.json: activepieces",
          "",
          "  ❯ 1. Use this and all future MCP servers in this project",
          "    2. Use this MCP server",
          "    3. Continue without using this MCP server",
          "",
          "  Enter to confirm · Esc to cancel",
        ].join("\n");
      }
      // Third capture: prompt dismissed, show logo
      return "Claude Code v1.0.0\n[USER TASK]";
    });

    // Exit after 3 captures
    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return existsChecks <= 3;
    });

    // readAgentState returns undefined (no state set yet, brand new agent)
    setPerAgentReadState(async (_dir: string) => undefined);

    await runPerAgentWatchdog("agent-test1", "/tmp/test");

    // Should have sent Enter via tmux send-keys at least once
    const enterCmds = sentKeys.filter(
      (cmd) => cmd.includes("send-keys") && cmd.includes("Enter"),
    );
    expect(enterCmds.length).toBeGreaterThanOrEqual(1);
  });

  test("auto-accepts multi-MCP server permissions prompt", async () => {
    const sentKeys: string[][] = [];
    setWatchdogSpawnRunner((cmd, _opts) => {
      sentKeys.push(cmd);
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
    });

    let captureCalls = 0;
    setPerAgentCaptureTmux(async (_session: string) => {
      captureCalls++;
      if (captureCalls <= 2) {
        // First two captures: multi-MCP checklist prompt visible
        return [
          "3 new MCP servers found in .mcp.json",
          "Select any you wish to enable.",
          "",
          "MCP servers may execute code or access system resources. All tool calls require approval.",
          "",
          "  ❯ [✔] granola",
          "    [✔] activepieces",
          "    [✔] essential-mcp",
          "",
          " Space to select · Enter to confirm · Esc to reject all",
        ].join("\n");
      }
      // Third capture: prompt dismissed, show logo
      return "Claude Code v1.0.0\n[USER TASK]";
    });

    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return existsChecks <= 3;
    });

    setPerAgentReadState(async (_dir: string) => undefined);

    await runPerAgentWatchdog("agent-test1", "/tmp/test");

    const enterCmds = sentKeys.filter(
      (cmd) => cmd.includes("send-keys") && cmd.includes("Enter"),
    );
    expect(enterCmds.length).toBeGreaterThanOrEqual(1);
  });

  test("auto-accepts workspace trust prompt", async () => {
    const sentKeys: string[][] = [];
    setWatchdogSpawnRunner((cmd, _opts) => {
      sentKeys.push(cmd);
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
    });

    let captureCalls = 0;
    setPerAgentCaptureTmux(async (_session: string) => {
      captureCalls++;
      if (captureCalls <= 1) {
        return "Do you trust the files in this folder?\n\nEnter to confirm · Esc to cancel";
      }
      return "Claude Code v1.0.0\n[USER TASK]";
    });

    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return existsChecks <= 2;
    });

    setPerAgentReadState(async (_dir: string) => undefined);

    await runPerAgentWatchdog("agent-test1", "/tmp/test");

    const enterCmds = sentKeys.filter(
      (cmd) => cmd.includes("send-keys") && cmd.includes("Enter"),
    );
    expect(enterCmds.length).toBeGreaterThanOrEqual(1);
  });

  test("exits when worktree directory is removed", async () => {
    // After first poll, remove worktree
    const origExists = (_path: string) => worktreeExists;
    let checkCount = 0;
    setPerAgentExistsSync((_path: string) => {
      checkCount++;
      // Let first check pass, then fail
      return checkCount <= 1;
    });

    await runPerAgentWatchdog("agent-test1", "/tmp/test");
    // Should have exited after first poll when worktree was "removed"
    expect(checkCount).toBe(2);
  });

  test("exits when tmux session missing for >10s grace period", async () => {
    // Tmux session is gone from the start
    tmuxOutput = null;

    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return true; // worktree always exists
    });

    // Advance time past grace period on second check
    let captureCalls = 0;
    setPerAgentCaptureTmux(async (_session: string) => {
      captureCalls++;
      if (captureCalls >= 2) {
        currentTime += TMUX_GONE_GRACE_MS + 1;
      }
      return null; // tmux always gone
    });

    await runPerAgentWatchdog("agent-test1", "/tmp/test");
    // Should have polled at least twice (first sets goneSince, second exceeds grace)
    expect(captureCalls).toBeGreaterThanOrEqual(2);
  });

  test("resets tmux grace period when session reappears", async () => {
    let captureCalls = 0;
    setPerAgentCaptureTmux(async (_session: string) => {
      captureCalls++;
      if (captureCalls === 1) return null; // first: gone
      if (captureCalls === 2) return "I HAVE COMPLETED THE GOAL"; // second: back
      if (captureCalls === 3) return null; // third: gone again
      // fourth: advance time past grace and still gone → should exit
      currentTime += TMUX_GONE_GRACE_MS + 1;
      return null;
    });

    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return true;
    });

    await runPerAgentWatchdog("agent-test1", "/tmp/test");
    // Grace period was reset when session reappeared, so we need 4+ captures
    expect(captureCalls).toBeGreaterThanOrEqual(4);
  });

  test("exits immediately when meta cannot be read", async () => {
    setPerAgentReadMeta(async (_dir: string) => ({ meta: null, error: "not found" }));

    // Should return without entering the loop
    await runPerAgentWatchdog("agent-test1", "/tmp/test");
    expect(pollCount).toBe(0);
  });

  test("exits immediately when no tmux session in meta", async () => {
    setPerAgentReadMeta(async (_dir: string) => ({
      meta: {
        id: "agent-test1",
        session_id: "sid-123",
        tmux_session: "", // empty
        prompt: "test",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "999",
      },
    }));

    await runPerAgentWatchdog("agent-test1", "/tmp/test");
    expect(pollCount).toBe(0);
  });

  test("TMUX_GONE_GRACE_MS is 10 seconds", () => {
    expect(TMUX_GONE_GRACE_MS).toBe(10_000);
  });

  test("exits early when meta has invalid tmux session name", async () => {
    setPerAgentReadMeta(async (_dir: string) => ({
      meta: {
        id: "agent-test1",
        session_id: "sid-123",
        tmux_session: "bad;inject",
        prompt: "test",
        manager: "",
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        yolo: false,
        claude_pid: "",
        model: "opus",
        role: "worker",
        permissions: { allow: [], deny: [] },
      },
    }));

    await runPerAgentWatchdog("agent-test1", "/tmp/test");
    expect(pollCount).toBe(0);
  });
});
