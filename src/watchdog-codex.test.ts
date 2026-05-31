/**
 * Phase 6 regression tests — runPerAgentWatchdog + the rate-limited / api-error
 * handlers must skip their claude-specific bare-Enter / "please retry" / Anthropic
 * usage-API behaviors when the agent's `meta.model` parses as a codex CLI.
 *
 * Coverage:
 *  1. runPerAgentWatchdog never sends bare Enter for a codex agent even when the
 *     captured tmux output contains the literal "Enter to confirm" + "trust"
 *     phrases (claude's permission-modal signature).
 *  2. handleRateLimited (via tick) is a no-op for a codex agent — no
 *     `sendTmuxEnter`, no fetchUsage call.
 *  3. handleApiError (via tick) is a no-op for a codex agent — no
 *     "please retry" sendMessage.
 *  4. Claude regression: handleRateLimited still sends Enter for a claude:opus
 *     agent (sanity check the gate doesn't over-fire).
 *  5. Malformed / legacy `meta.model` (bare name, empty string, unknown prefix)
 *     falls back to "claude" behavior — preserves pre-Phase-1 back-compat.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { makeAgent } from "./test-utils";
import type { Agent } from "./agents";
import type { AgentState } from "./parse-state";
import {
  tick,
  clearTrackers,
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
  setPerAgentDrain,
  resetPerAgentDrain,
  setWatchdogSpawnRunner,
  resetWatchdogSpawnRunner,
  setWatchdogFetchUsage,
  resetWatchdogFetchUsage,
  setWatchdogSleep,
  resetWatchdogSleep,
  setWatchdogCaptureTmux,
  resetWatchdogCaptureTmux,
  setWatchdogNow,
  resetWatchdogNow,
  setWatchdogReadConfig,
  resetWatchdogReadConfig,
  clearAllAgentsCache,
  getTracker,
} from "./watchdog";
import {
  setSendSpawnRunner,
  resetSendSpawnRunner,
} from "./ib-commands";
import {
  spawnCtx as tmuxPollerSpawnCtx,
} from "./tmux-poller";

/** Build a recording spawn runner — same shape as src/watchdog.test.ts. */
function mockSpawnRunner() {
  const calls: Array<{ args: any[]; opts: any }> = [];
  const runner = (args: any[], opts?: any): any => {
    calls.push({ args: [...args], opts });
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

/** Build a test agent with an explicit model (used to vary cli per test). */
function agentWithModel(id: string, state: AgentState, model: string): Agent {
  return makeAgent({
    id,
    state,
    meta: {
      id,
      session_id: `sess-${id}`,
      tmux_session: `tmux-${id}`,
      prompt: "test",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      yolo: false,
      model,
      claude_pid: "12345",
    },
  });
}

/** Count bare-Enter send-keys calls (no -l flag → no payload, just Enter). */
function countEnterCalls(spawnMock: ReturnType<typeof mockSpawnRunner>, tmuxSession: string): number {
  return spawnMock.calls.filter((c) =>
    c.args.includes("send-keys") &&
    c.args.includes("Enter") &&
    c.args.includes(tmuxSession)
  ).length;
}

/** Count "please retry" sendMessage calls (chunked send-keys -l with payload). */
function countRetryCalls(spawnMock: ReturnType<typeof mockSpawnRunner>): number {
  return spawnMock.calls.filter((c) => {
    if (!c.args.includes("send-keys") || !c.args.includes("-l")) return false;
    return c.args.some((a: unknown) => typeof a === "string" && a.includes("please retry"));
  }).length;
}

describe("Phase 6 — handler-level cli gating", () => {
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
    resetWatchdogNow();
    resetWatchdogSleep();
    resetWatchdogCaptureTmux();
    clearTrackers();
  });

  describe("handleRateLimited — codex agents skip the bypass loop + fetchUsage", () => {
    test("codex agent: no bare Enter sent, no fetchUsage call", async () => {
      let fetchUsageCalls = 0;
      setWatchdogFetchUsage(async () => {
        fetchUsageCalls++;
        return { data: { sessionPct: 3, weeklyPct: 30, sessionReset: "now", weeklyReset: "2d" }, error: false };
      });
      setWatchdogSleep(async () => {});
      setWatchdogCaptureTmux(async () => "rate_limit_error: usage limit reached");

      const a1 = agentWithModel("a1", "rate_limited", "codex:gpt-5.4-mini");
      await tick([a1]);

      expect(countEnterCalls(spawnMock, "tmux-a1")).toBe(0);
      expect(fetchUsageCalls).toBe(0);
      // The tracker's bypass flag stays untouched — the codex early-return runs
      // before any state mutation in the handler body.
      expect(getTracker("a1").rateLimitBypassed).toBe(false);
    });

    test("claude:opus agent: still sends bare Enter (regression — gate must not over-fire)", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      // Always rate limited so the bypass loop fires its full retry budget.
      setWatchdogCaptureTmux(async () => "rate_limit_error: usage limit reached");

      const a1 = agentWithModel("a1", "rate_limited", "claude:opus");
      await tick([a1]);

      // At least one Enter — confirms the claude branch still runs.
      expect(countEnterCalls(spawnMock, "tmux-a1")).toBeGreaterThanOrEqual(1);
      expect(getTracker("a1").rateLimitBypassed).toBe(true);
    });

    test("legacy bare 'sonnet' model: parseModel throws, falls back to claude (still sends Enter)", async () => {
      // Pre-Phase-1 meta has bare names like "sonnet"/"opus". parseModel throws
      // on those, and our try/catch fallback classifies them as claude — so the
      // bypass behavior stays identical for any agent whose meta predates the
      // qualified-model requirement.
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      setWatchdogCaptureTmux(async () => "rate_limit_error: usage limit reached");

      const a1 = agentWithModel("a1", "rate_limited", "sonnet");
      await tick([a1]);

      expect(countEnterCalls(spawnMock, "tmux-a1")).toBeGreaterThanOrEqual(1);
    });

    test("empty model string: falls back to claude (still sends Enter)", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      setWatchdogCaptureTmux(async () => "rate_limit_error: usage limit reached");

      const a1 = agentWithModel("a1", "rate_limited", "");
      await tick([a1]);

      expect(countEnterCalls(spawnMock, "tmux-a1")).toBeGreaterThanOrEqual(1);
    });

    test("unknown cli prefix 'gemini:foo': parseModel throws, falls back to claude (still sends Enter)", async () => {
      setWatchdogFetchUsage(async () => ({ data: { sessionPct: 80, weeklyPct: 50, sessionReset: "1h", weeklyReset: "2d" }, error: false }));
      setWatchdogSleep(async () => {});
      setWatchdogCaptureTmux(async () => "rate_limit_error: usage limit reached");

      const a1 = agentWithModel("a1", "rate_limited", "gemini:foo");
      await tick([a1]);

      expect(countEnterCalls(spawnMock, "tmux-a1")).toBeGreaterThanOrEqual(1);
    });
  });

  describe("handleApiError — codex agents skip 'please retry'", () => {
    test("codex agent: no 'please retry' sent", async () => {
      setWatchdogNow(() => 1_000_000);

      const a1 = agentWithModel("a1", "api_error", "codex:gpt-5.4-mini");
      await tick([a1]);

      expect(countRetryCalls(spawnMock)).toBe(0);
      // Tracker fields untouched — early return runs before mutation.
      expect(getTracker("a1").apiErrorRetries).toBe(0);
      expect(getTracker("a1").apiErrorLastAtMs).toBe(0);
    });

    test("claude:opus agent: still sends 'please retry' (regression)", async () => {
      setWatchdogNow(() => 1_000_000);

      const a1 = agentWithModel("a1", "api_error", "claude:opus");
      await tick([a1]);

      expect(countRetryCalls(spawnMock)).toBe(1);
      expect(getTracker("a1").apiErrorRetries).toBe(1);
    });

    test("legacy bare 'opus' model: parseModel throws, falls back to claude (still sends retry)", async () => {
      setWatchdogNow(() => 1_000_000);

      const a1 = agentWithModel("a1", "api_error", "opus");
      await tick([a1]);

      expect(countRetryCalls(spawnMock)).toBe(1);
    });
  });
});

// ─── runPerAgentWatchdog — permission auto-accept gate ──────────────────────
//
// The "Enter to confirm" + "trust" auto-accept block in runPerAgentWatchdog
// must NOT fire for a codex agent, even if the captured tmux output happens
// to include those phrases (e.g. an echoed file path, terminal art, a custom
// prompt). Codex never surfaces these modals — they would only be a false
// positive — so the gate exists for intent clarity + defense in depth.

describe("Phase 6 — runPerAgentWatchdog permission-accept gating", () => {
  let worktreeExists: boolean;
  let tmuxOutput: string | null;
  let currentTime: number;

  beforeEach(() => {
    worktreeExists = true;
    // Default: a string that would TRIGGER the claude permission-accept block.
    tmuxOutput = "Do you trust the files in this folder?\n\nEnter to confirm · Esc to cancel";
    currentTime = 1_000_000;

    setPerAgentExistsSync((_path: string) => worktreeExists);
    setPerAgentCaptureTmux(async (_session: string) => tmuxOutput);
    setWatchdogNow(() => currentTime);
    setPerAgentSleep(async () => {});
    setSendSpawnRunner(() => ({ stdout: "", exitCode: 0 }) as any);
    setPerAgentDrain(async () => {});
    setWatchdogReadConfig(async () => ({} as any));
    clearAllAgentsCache();
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
    resetPerAgentDrain();
    clearAllAgentsCache();
  });

  test("codex agent: 'Enter to confirm · trust' in output does NOT trigger bare Enter", async () => {
    const sentKeys: string[][] = [];
    setWatchdogSpawnRunner((cmd, _opts) => {
      sentKeys.push(cmd);
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
    });

    setPerAgentReadMeta(async (_dir: string) => ({
      meta: {
        id: "agent-codex1",
        session_id: "sid-codex",
        tmux_session: "tmux-codex1",
        prompt: "test",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        yolo: false,
        model: "codex:gpt-5.4-mini",
        claude_pid: "999",
        codex_session_id: "codex-uuid-abc",
      },
    }));

    // Exit after 2 ticks (worktree disappears on the 3rd existsSync).
    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return existsChecks <= 2;
    });

    setPerAgentReadState(async (_dir: string) => undefined);

    await runPerAgentWatchdog("agent-codex1", "/tmp/test");

    // CRITICAL: zero bare-Enter sends despite the "Enter to confirm · trust"
    // signature being present in every captured frame.
    const enterCmds = sentKeys.filter(
      (cmd) => cmd.includes("send-keys") && cmd.includes("Enter"),
    );
    expect(enterCmds.length).toBe(0);
  });

  test("claude agent: same output DOES trigger bare Enter (regression — gate must not over-fire)", async () => {
    const sentKeys: string[][] = [];
    setWatchdogSpawnRunner((cmd, _opts) => {
      sentKeys.push(cmd);
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
    });

    setPerAgentReadMeta(async (_dir: string) => ({
      meta: {
        id: "agent-claude1",
        session_id: "sid-claude",
        tmux_session: "tmux-claude1",
        prompt: "test",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        yolo: false,
        model: "claude:opus",
        claude_pid: "999",
      },
    }));

    // Switch capture so the prompt clears after one accept (otherwise the
    // 'continue' branch loops indefinitely).
    let captureCalls = 0;
    setPerAgentCaptureTmux(async (_session: string) => {
      captureCalls++;
      if (captureCalls <= 1) return tmuxOutput;
      return "Claude Code v1.0.0\n[USER TASK]";
    });

    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return existsChecks <= 2;
    });

    setPerAgentReadState(async (_dir: string) => undefined);

    await runPerAgentWatchdog("agent-claude1", "/tmp/test");

    const enterCmds = sentKeys.filter(
      (cmd) => cmd.includes("send-keys") && cmd.includes("Enter"),
    );
    expect(enterCmds.length).toBeGreaterThanOrEqual(1);
  });

  test("legacy bare 'sonnet' model in meta: falls back to claude (still triggers Enter)", async () => {
    const sentKeys: string[][] = [];
    setWatchdogSpawnRunner((cmd, _opts) => {
      sentKeys.push(cmd);
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
    });

    setPerAgentReadMeta(async (_dir: string) => ({
      meta: {
        id: "agent-legacy1",
        session_id: "sid-legacy",
        tmux_session: "tmux-legacy1",
        prompt: "test",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        yolo: false,
        model: "sonnet", // pre-Phase-1 bare name — parseModel throws, falls back to claude
        claude_pid: "999",
      },
    }));

    let captureCalls = 0;
    setPerAgentCaptureTmux(async (_session: string) => {
      captureCalls++;
      if (captureCalls <= 1) return tmuxOutput;
      return "Claude Code v1.0.0\n[USER TASK]";
    });

    let existsChecks = 0;
    setPerAgentExistsSync((_path: string) => {
      existsChecks++;
      return existsChecks <= 2;
    });

    setPerAgentReadState(async (_dir: string) => undefined);

    await runPerAgentWatchdog("agent-legacy1", "/tmp/test");

    const enterCmds = sentKeys.filter(
      (cmd) => cmd.includes("send-keys") && cmd.includes("Enter"),
    );
    expect(enterCmds.length).toBeGreaterThanOrEqual(1);
  });
});
