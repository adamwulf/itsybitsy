/**
 * Phase 3 (SPEC-ANTIGRAVITY-CLI.md D10 / §5.4) — runPerAgentWatchdog behaviour
 * for `agy` agents:
 *
 *  1. The claude permission auto-accept block does NOT fire for agy (its trust
 *     card uses different wording); agy has its own fallback answers instead.
 *  2. agy trust card ("Do you trust the contents of this project?") → bare Enter
 *     (fallback only; logged loudly because pre-trust should have suppressed it).
 *  3. agy survey overlay ("How's the CLI experience so far?") → literal `0`.
 *  4. Liveness: if `agy-hook-heartbeat` never appears within AGY_HEARTBEAT_GRACE_MS
 *     of spawn, the watchdog logs the warning ONCE and notifies the manager once
 *     (no kill). It does not warn when the heartbeat exists or before the grace.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  runPerAgentWatchdog,
  AGY_HEARTBEAT_GRACE_MS,
  setPerAgentExistsSync,
  resetPerAgentExistsSync,
  setPerAgentCaptureTmux,
  resetPerAgentCaptureTmux,
  setPerAgentProbeTmuxPane,
  resetPerAgentProbeTmuxPane,
  setPerAgentReadMeta,
  resetPerAgentReadMeta,
  setPerAgentReadState,
  resetPerAgentReadState,
  setPerAgentSleep,
  resetPerAgentSleep,
  setPerAgentDrain,
  resetPerAgentDrain,
  setWatchdogSpawnRunner,
  resetWatchdogSpawnRunner,
  setWatchdogNow,
  resetWatchdogNow,
  setWatchdogReadConfig,
  resetWatchdogReadConfig,
  setWatchdogListRepos,
  resetWatchdogListRepos,
  setWatchdogReadAllAgents,
  resetWatchdogReadAllAgents,
  clearAllAgentsCache,
} from "./watchdog";
import {
  setSendSpawnRunner,
  resetSendSpawnRunner,
} from "./ib-commands";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import { OUTBOX_FILENAME, agentOutboxDir } from "./outbox";
import { AGY_HEARTBEAT_FILENAME } from "./hooks/agy-pre-invocation";

const NOW = 1_800_000_000_000;

function agyMeta(id: string, extra?: Record<string, unknown>) {
  return {
    meta: {
      id,
      session_id: `sid-${id}`,
      tmux_session: `tmux-${id}`,
      prompt: "test",
      manager: null,
      created: "2026-09-01T00:00:00Z",
      // Recent by default so the heartbeat check is skipped (within grace).
      created_epoch: Math.floor(NOW / 1000),
      worktree: true,
      worker: false,
      model: "agy:gemini-3.7-flash-low",
      claude_pid: "4242",
      ...extra,
    },
  };
}

/** Records every tmux command the watchdog's own spawn runner issues. */
function recordingRunner(sink: string[][]) {
  return (cmd: string[], _opts?: unknown) => {
    sink.push([...cmd]);
    return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
  };
}

describe("Phase 3 — agy watchdog fallback keystrokes", () => {
  let sentKeys: string[][];

  beforeEach(() => {
    sentKeys = [];
    setWatchdogSpawnRunner(recordingRunner(sentKeys));
    setPerAgentProbeTmuxPane(async () => ({ status: "live" }));
    setWatchdogNow(() => NOW);
    setPerAgentSleep(async () => {});
    setPerAgentDrain(async () => {});
    setWatchdogReadConfig(async () => ({} as any));
    setPerAgentReadState(async () => undefined);
    clearAllAgentsCache();
  });

  afterEach(() => {
    resetWatchdogSpawnRunner();
    resetPerAgentProbeTmuxPane();
    resetPerAgentCaptureTmux();
    resetPerAgentExistsSync();
    resetPerAgentReadMeta();
    resetPerAgentReadState();
    resetPerAgentSleep();
    resetPerAgentDrain();
    resetWatchdogReadConfig();
    resetWatchdogNow();
    clearAllAgentsCache();
  });

  /** Run for exactly one tick: worktree exists on the first check, gone after. */
  function runOneTick(id: string): Promise<void> {
    let checks = 0;
    setPerAgentExistsSync((path: string) => {
      // Heartbeat path (only consulted when past grace) → treat as present so
      // the liveness branch never fires in these keystroke tests.
      if (path.endsWith(AGY_HEARTBEAT_FILENAME)) return true;
      checks++;
      return checks <= 1;
    });
    return runPerAgentWatchdog(id, "/tmp/agy-test");
  }

  test("agy trust card → sends bare Enter (fallback)", async () => {
    setPerAgentReadMeta(async () => agyMeta("agy-trust"));
    setPerAgentCaptureTmux(async () =>
      "Accessing workspace:\n\n/some/path\n\nDo you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit",
    );
    await runOneTick("agy-trust");
    const enters = sentKeys.filter((c) => c.includes("send-keys") && c.includes("Enter") && !c.includes("-l"));
    expect(enters.length).toBeGreaterThanOrEqual(1);
  });

  test("agy survey overlay → sends literal 0", async () => {
    setPerAgentReadMeta(async () => agyMeta("agy-survey"));
    setPerAgentCaptureTmux(async () =>
      "▸ Thought for 1s\n\nHow's the CLI experience so far? Help us improve:  [1] Good  [2] Fine  [3] Bad  [0] Skip",
    );
    await runOneTick("agy-survey");
    const zeroKeys = sentKeys.filter((c) => c.includes("send-keys") && c.includes("-l") && c.includes("0"));
    expect(zeroKeys.length).toBeGreaterThanOrEqual(1);
    // And NOT a bare Enter for the survey.
    const enters = sentKeys.filter((c) => c.includes("send-keys") && c.includes("Enter") && !c.includes("-l"));
    expect(enters.length).toBe(0);
  });

  test("claude permission-modal wording does NOT trigger the claude auto-accept on an agy agent", async () => {
    setPerAgentReadMeta(async () => agyMeta("agy-noclaude"));
    // Claude's phrasing ("Do you trust the files" + "Enter to confirm"), which
    // the agy trust regex does NOT match — so no keystroke should be sent.
    setPerAgentCaptureTmux(async () =>
      "Do you trust the files in this folder?\n\nEnter to confirm · Esc to cancel",
    );
    await runOneTick("agy-noclaude");
    const enters = sentKeys.filter((c) => c.includes("send-keys") && c.includes("Enter"));
    expect(enters.length).toBe(0);
  });
});

describe("Phase 3 — agy heartbeat liveness", () => {
  let tempRepo: string;
  let tempHome: string;
  let agentId: string;
  let agentDir: string;

  beforeEach(async () => {
    tempRepo = await mkdtemp(join(tmpdir(), "agy-wd-repo-"));
    tempHome = await mkdtemp(join(tmpdir(), "agy-wd-home-"));
    setCoordinatorHome(tempHome);
    agentId = "agy-hb";
    agentDir = join(tempRepo, ".ittybitty", "agents", agentId);
    await mkdir(agentDir, { recursive: true });

    setWatchdogSpawnRunner(recordingRunner([]));
    setPerAgentProbeTmuxPane(async () => ({ status: "live" }));
    setPerAgentCaptureTmux(async () => "some benign agy pane output");
    setWatchdogNow(() => NOW);
    setPerAgentSleep(async () => {});
    setPerAgentDrain(async () => {});
    setWatchdogReadConfig(async () => ({} as any));
    setPerAgentReadState(async () => undefined);
    clearAllAgentsCache();
  });

  afterEach(async () => {
    resetWatchdogSpawnRunner();
    resetPerAgentProbeTmuxPane();
    resetPerAgentCaptureTmux();
    resetPerAgentExistsSync();
    resetPerAgentReadMeta();
    resetPerAgentReadState();
    resetPerAgentSleep();
    resetPerAgentDrain();
    resetWatchdogReadConfig();
    resetWatchdogNow();
    resetWatchdogListRepos();
    resetWatchdogReadAllAgents();
    resetSendSpawnRunner();
    resetCoordinatorHome();
    clearAllAgentsCache();
    await rm(tempRepo, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });

  /** Run the watchdog for `ticks` iterations, then let the worktree disappear. */
  function runForTicks(ticks: number, opts: { heartbeatExists: boolean }): Promise<void> {
    let worktreeChecks = 0;
    setPerAgentExistsSync((path: string) => {
      if (path.endsWith(AGY_HEARTBEAT_FILENAME)) return opts.heartbeatExists;
      worktreeChecks++;
      return worktreeChecks <= ticks;
    });
    return runPerAgentWatchdog(agentId, tempRepo);
  }

  async function readLog(): Promise<string> {
    try { return await readFile(join(agentDir, "agent.log"), "utf8"); }
    catch { return ""; }
  }

  test("no heartbeat past the grace → logs the warning exactly once", async () => {
    // created_epoch is (grace + 30s) ago → well past the grace window.
    const createdEpoch = Math.floor((NOW - AGY_HEARTBEAT_GRACE_MS - 30_000) / 1000);
    setPerAgentReadMeta(async () => agyMeta(agentId, { created_epoch: createdEpoch }));
    await runForTicks(3, { heartbeatExists: false });
    const log = await readLog();
    const matches = log.match(/agy hooks never fired/g) ?? [];
    expect(matches.length).toBe(1); // one-shot latch — not once per tick
  });

  test("heartbeat present → no warning", async () => {
    const createdEpoch = Math.floor((NOW - AGY_HEARTBEAT_GRACE_MS - 30_000) / 1000);
    setPerAgentReadMeta(async () => agyMeta(agentId, { created_epoch: createdEpoch }));
    await runForTicks(3, { heartbeatExists: true });
    const log = await readLog();
    expect(log).not.toContain("agy hooks never fired");
  });

  test("within the grace window → no warning yet", async () => {
    const createdEpoch = Math.floor((NOW - 10_000) / 1000); // 10s ago
    setPerAgentReadMeta(async () => agyMeta(agentId, { created_epoch: createdEpoch }));
    await runForTicks(3, { heartbeatExists: false });
    const log = await readLog();
    expect(log).not.toContain("agy hooks never fired");
  });

  test("notifies the manager once when hooks never fired", async () => {
    const createdEpoch = Math.floor((NOW - AGY_HEARTBEAT_GRACE_MS - 30_000) / 1000);
    const managerId = "mgr-1";
    // self carries a manager; both are returned by the notification snapshot.
    const self = agyMeta(agentId, { created_epoch: createdEpoch, manager: managerId }).meta;
    const manager = {
      id: managerId,
      session_id: "sid-mgr",
      tmux_session: "tmux-mgr-1",
      prompt: "manage",
      manager: null,
      created: "2026-09-01T00:00:00Z",
      created_epoch: createdEpoch,
      worktree: true,
      worker: false,
      model: "claude:opus",
      claude_pid: "111",
    };
    const managerDir = join(tempRepo, ".ittybitty", "agents", managerId);
    await mkdir(managerDir, { recursive: true });
    // Give the manager a LIVE watchdog so sendMessage just ENQUEUES to its
    // outbox and returns — no inline chunked delivery (which has real inter-key
    // sleeps and would make this test slow/flaky). We then read the queued file.
    await writeFile(
      join(managerDir, "meta.transient.json"),
      JSON.stringify({
        tmux_compacting: false,
        tmux_rate_limited: false,
        has_background_tasks: false,
        watchdog_pid: process.pid,
        updated_at_ms: Date.now(),
      }),
    );
    setPerAgentReadMeta(async () => ({ meta: self } as any));
    setWatchdogListRepos(async () => [{ path: tempRepo, name: "repo" } as any]);
    setWatchdogReadAllAgents(async () => ({
      agents: [
        { id: agentId, repoPath: tempRepo, repoName: "repo", meta: self, state: "running", age: "", archived: false, children: [] },
        { id: managerId, repoPath: tempRepo, repoName: "repo", meta: manager, state: "running", age: "", archived: false, children: [] },
      ],
    } as any));

    setSendSpawnRunner((cmd: string[]) => {
      return { stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) } as any;
    });

    await runForTicks(3, { heartbeatExists: false });

    // The warning was enqueued to the manager's outbox exactly once.
    const outboxPath = join(agentOutboxDir(managerId), OUTBOX_FILENAME);
    const outbox = await readFile(outboxPath, "utf8").catch(() => "");
    expect(outbox).toContain("hooks never fired");
    const lines = outbox.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    // The warning was logged exactly once for the self agent too.
    const log = await readLog();
    expect((log.match(/agy hooks never fired/g) ?? []).length).toBe(1);
  });
});
