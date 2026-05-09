import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeAgent, makeSpawnResult } from "./test-utils";
import {
  gatherAgentState,
  formatPidComponent,
  gatherOrphans,
  buildTrackedSets,
  cleanupOrphans,
  isItsybitsyTmuxSession,
  isClaudeAgentProcess,
  isWatchdogProcess,
  isIbWatchProcess,
  sendSignalCtx,
  cleanupSleepCtx,
  type OrphanReport,
  type TrackedSets,
} from "./state-command";
import { isPidAliveCtx } from "./agents";
import { spawnCtx } from "./agent-lifecycle";
import type { TransientState } from "./agents";
import type { SpawnResult } from "./types";

/** Helper: build a fake spawn router keyed on argv prefix. */
function makeSpawnRouter(handlers: { match: (cmd: string[]) => boolean; result: SpawnResult }[]) {
  return (cmd: string[]) => {
    for (const h of handlers) {
      if (h.match(cmd)) return h.result;
    }
    // Default: exit 1 with empty stdout — caller treats as not found.
    return makeSpawnResult(1, "", "");
  };
}

describe("formatPidComponent", () => {
  test("renders alive PID with checkmark", () => {
    expect(formatPidComponent("claude", 12345, true)).toBe("claude:12345 ✓");
  });
  test("renders dead PID with X mark", () => {
    expect(formatPidComponent("claude", 12345, false)).toBe("claude:12345 ✗");
  });
  test("renders missing PID with em-dash", () => {
    expect(formatPidComponent("claude", null, null)).toBe("claude:— —");
  });
});

describe("gatherAgentState", () => {
  let repoPath: string;
  let agentDir: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "ib-state-test-"));
    agentDir = join(repoPath, ".ittybitty", "agents", "agent-test01");
    await mkdir(agentDir, { recursive: true });
  });

  afterEach(async () => {
    spawnCtx.reset();
    isPidAliveCtx.reset();
    await rm(repoPath, { recursive: true, force: true });
  });

  test("returns null PIDs when meta has no claude_pid and no transient file", async () => {
    const agent = makeAgent({
      id: "agent-test01",
      repoPath,
      repoName: "test-repo",
      meta: {
        id: "agent-test01",
        session_id: "x",
        tmux_session: "",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "",
      },
    });

    isPidAliveCtx.set(() => true);
    spawnCtx.set(makeSpawnRouter([]));

    const row = await gatherAgentState(agent);
    expect(row.id).toBe("agent-test01");
    expect(row.repo).toBe("test-repo");
    expect(row.tmux_session).toBeNull();
    expect(row.tmux_pane_pid).toBeNull();
    expect(row.tmux_pane_alive).toBeNull();
    expect(row.claude_pid).toBeNull();
    expect(row.claude_alive).toBeNull();
    expect(row.watchdog_pid).toBeNull();
    expect(row.watchdog_alive).toBeNull();
    expect(row.unexpected_children).toEqual([]);
  });

  test("populates tmux pane PID, claude liveness, watchdog liveness, and orphans", async () => {
    // Write a transient file with watchdog_pid=2222
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 2222,
    };
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const agent = makeAgent({
      id: "agent-test01",
      repoPath,
      repoName: "test-repo",
      meta: {
        id: "agent-test01",
        session_id: "x",
        tmux_session: "ib-test01",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "1111",
      },
    });

    // Liveness: claude(1111) + watchdog(2222) + tmux pane(3000) alive; orphan(9999) alive too.
    const aliveSet = new Set([1111, 2222, 3000, 9999]);
    isPidAliveCtx.set((pid: number) => aliveSet.has(pid));

    // Spawn router:
    //   tmux has-session -> 0
    //   tmux list-panes  -> "3000\n"
    //   pgrep -P 3000    -> "1111\n9999\n"  (claude + one stranger)
    //   ps -p 9999       -> "node weird-process"
    spawnCtx.set(makeSpawnRouter([
      { match: (c) => c[0] === "tmux" && c[1] === "has-session" && c[3] === "ib-test01", result: makeSpawnResult(0) },
      { match: (c) => c[0] === "tmux" && c[1] === "list-panes" && c[3] === "ib-test01", result: makeSpawnResult(0, "3000\n") },
      { match: (c) => c[0] === "pgrep" && c[2] === "3000", result: makeSpawnResult(0, "1111\n9999\n") },
      { match: (c) => c[0] === "ps" && c[c.length - 1] === "9999", result: makeSpawnResult(0, "node weird-process\n") },
    ]));

    const row = await gatherAgentState(agent);

    expect(row.tmux_session).toBe("ib-test01");
    expect(row.tmux_pane_pid).toBe(3000);
    expect(row.tmux_pane_alive).toBe(true);
    expect(row.claude_pid).toBe(1111);
    expect(row.claude_alive).toBe(true);
    expect(row.watchdog_pid).toBe(2222);
    expect(row.watchdog_alive).toBe(true);
    expect(row.unexpected_children).toEqual([{ pid: 9999, command: "node weird-process" }]);
  });

  test("dead claude_pid is reported as alive=false, no orphans gathered when pane PID is dead", async () => {
    const agent = makeAgent({
      id: "agent-test01",
      repoPath,
      repoName: "test-repo",
      meta: {
        id: "agent-test01",
        session_id: "x",
        tmux_session: "ib-test01",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "1111",
      },
    });

    // Nothing is alive.
    isPidAliveCtx.set(() => false);

    spawnCtx.set(makeSpawnRouter([
      { match: (c) => c[0] === "tmux" && c[1] === "has-session", result: makeSpawnResult(0) },
      { match: (c) => c[0] === "tmux" && c[1] === "list-panes", result: makeSpawnResult(0, "3000\n") },
    ]));

    const row = await gatherAgentState(agent);
    expect(row.claude_pid).toBe(1111);
    expect(row.claude_alive).toBe(false);
    expect(row.tmux_pane_pid).toBe(3000);
    expect(row.tmux_pane_alive).toBe(false);
    // pane dead -> we don't pgrep for orphans (avoid noise on dead processes)
    expect(row.unexpected_children).toEqual([]);
  });

  test("invalid tmux session name skips tmux lookup entirely", async () => {
    const agent = makeAgent({
      id: "agent-test01",
      repoPath,
      repoName: "test-repo",
      meta: {
        id: "agent-test01",
        session_id: "x",
        tmux_session: "bad session;name",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "1111",
      },
    });

    isPidAliveCtx.set(() => true);

    let tmuxCalled = false;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux") tmuxCalled = true;
      return makeSpawnResult(1);
    });

    const row = await gatherAgentState(agent);
    expect(tmuxCalled).toBe(false);
    expect(row.tmux_pane_pid).toBeNull();
    expect(row.tmux_pane_alive).toBeNull();
    // tmux_session string is preserved verbatim for debugging
    expect(row.tmux_session).toBe("bad session;name");
  });

  test("excludes claude_pid from unexpected children even if pgrep returns it", async () => {
    const agent = makeAgent({
      id: "agent-test01",
      repoPath,
      repoName: "test-repo",
      meta: {
        id: "agent-test01",
        session_id: "x",
        tmux_session: "ib-test01",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "1111",
      },
    });

    isPidAliveCtx.set(() => true);
    spawnCtx.set(makeSpawnRouter([
      { match: (c) => c[0] === "tmux" && c[1] === "has-session", result: makeSpawnResult(0) },
      { match: (c) => c[0] === "tmux" && c[1] === "list-panes", result: makeSpawnResult(0, "3000\n") },
      // Only the claude PID under the pane — should produce zero orphans.
      { match: (c) => c[0] === "pgrep", result: makeSpawnResult(0, "1111\n") },
    ]));

    const row = await gatherAgentState(agent);
    expect(row.unexpected_children).toEqual([]);
  });
});

// ── Orphan detection ─────────────────────────────────────────────────────────

describe("isItsybitsyTmuxSession", () => {
  test("recognizes the system coordinator session by exact name", () => {
    expect(isItsybitsyTmuxSession("ib-coordinator")).toBe(true);
  });
  test("recognizes ittybitty-prefixed agent sessions", () => {
    expect(isItsybitsyTmuxSession("ittybitty-abcdef01-agent-foo")).toBe(true);
  });
  test("rejects unrelated session names", () => {
    expect(isItsybitsyTmuxSession("dev-server")).toBe(false);
    expect(isItsybitsyTmuxSession("workzone")).toBe(false);
    expect(isItsybitsyTmuxSession("")).toBe(false);
  });
  test("does NOT match ib-coord-* patterns (those are test fixtures only)", () => {
    // Real codebase has no `ib-coord-<repo>` pattern — only `ib-coordinator`
    // exact + `ittybitty-…`. Guards against accidental over-matching.
    expect(isItsybitsyTmuxSession("ib-coord-myrepo")).toBe(false);
  });
});

describe("isClaudeAgentProcess", () => {
  test("matches `claude --resume <id>` invocations", () => {
    expect(isClaudeAgentProcess("claude --resume abc123 --model sonnet")).toBe(true);
  });
  test("matches `/usr/local/bin/claude --session-id <uuid>`", () => {
    expect(isClaudeAgentProcess("/usr/local/bin/claude --session-id 11111111-2222-3333-4444-555555555555 --foo")).toBe(true);
  });
  test("rejects bare `claude` without --resume / --session-id", () => {
    expect(isClaudeAgentProcess("claude")).toBe(false);
    expect(isClaudeAgentProcess("claude --help")).toBe(false);
  });
  test("rejects unrelated processes that merely contain `claude`", () => {
    expect(isClaudeAgentProcess("vim claude.txt")).toBe(false);
    expect(isClaudeAgentProcess("/Users/claude/some-app")).toBe(false);
  });
});

describe("isWatchdogProcess", () => {
  test("matches `ib watchdog <agent-id>`", () => {
    expect(isWatchdogProcess("ib watchdog agent-abcd1234")).toBe(true);
  });
  test("matches absolute path to ib", () => {
    expect(isWatchdogProcess("/usr/local/bin/ib watchdog agent-foo")).toBe(true);
  });
  test("rejects ib commands that are not watchdog", () => {
    expect(isWatchdogProcess("ib watch")).toBe(false);
    expect(isWatchdogProcess("ib status agent-x")).toBe(false);
  });
});

describe("isIbWatchProcess", () => {
  test("matches `ib watch`", () => {
    expect(isIbWatchProcess("ib watch")).toBe(true);
    expect(isIbWatchProcess("/usr/local/bin/ib watch")).toBe(true);
  });
  test("rejects `ib watchdog` (different command)", () => {
    expect(isIbWatchProcess("ib watchdog agent-foo")).toBe(false);
  });
});

describe("buildTrackedSets", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "ib-tracked-"));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    isPidAliveCtx.reset();
    spawnCtx.reset();
  });

  test("collects tmux sessions, claude PIDs, watchdog PIDs across multiple agents", async () => {
    const agentDirA = join(repoPath, ".ittybitty", "agents", "agent-aaaa");
    const agentDirB = join(repoPath, ".ittybitty", "agents", "agent-bbbb");
    await mkdir(agentDirA, { recursive: true });
    await mkdir(agentDirB, { recursive: true });

    // Agent B has a transient watchdog_pid that differs from meta.watchdog_pid —
    // both should land in the tracked set.
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 8888,
    };
    await writeFile(join(agentDirB, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-aaaa",
      repoPath,
      meta: {
        id: "agent-aaaa",
        session_id: "x",
        tmux_session: "ittybitty-deadbeef-agent-aaaa",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "1001",
        watchdog_pid: 2001,
      },
    });
    const b = makeAgent({
      id: "agent-bbbb",
      repoPath,
      meta: {
        id: "agent-bbbb",
        session_id: "y",
        tmux_session: "ittybitty-deadbeef-agent-bbbb",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "1002",
        watchdog_pid: 2002,
      },
    });

    const tracked = await buildTrackedSets([a, b]);
    expect(tracked.tmuxSessions.has("ib-coordinator")).toBe(true);
    expect(tracked.tmuxSessions.has("ittybitty-deadbeef-agent-aaaa")).toBe(true);
    expect(tracked.tmuxSessions.has("ittybitty-deadbeef-agent-bbbb")).toBe(true);
    expect(tracked.claudePids.has(1001)).toBe(true);
    expect(tracked.claudePids.has(1002)).toBe(true);
    expect(tracked.watchdogPids.has(2001)).toBe(true);
    expect(tracked.watchdogPids.has(2002)).toBe(true);
    // Transient watchdog_pid for agent B
    expect(tracked.watchdogPids.has(8888)).toBe(true);
  });

  test("ignores empty tmux sessions and missing/invalid PIDs", async () => {
    const agentDir = join(repoPath, ".ittybitty", "agents", "agent-empty");
    await mkdir(agentDir, { recursive: true });
    const a = makeAgent({
      id: "agent-empty",
      repoPath,
      meta: {
        id: "agent-empty",
        session_id: "z",
        tmux_session: "",
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: "",
      },
    });
    const tracked = await buildTrackedSets([a]);
    // Only ib-coordinator (added unconditionally)
    expect(tracked.tmuxSessions.size).toBe(1);
    expect(tracked.claudePids.size).toBe(0);
    expect(tracked.watchdogPids.size).toBe(0);
  });
});

/**
 * Helper: build a fake `ps -o pid=,command= -A` stdout from an array of
 * { pid, command } entries. Mimics the formatting `ps` produces (pid then
 * single-space then command).
 */
function fakePsOutput(entries: { pid: number; command: string }[]): string {
  return entries.map((e) => `${e.pid} ${e.command}`).join("\n") + "\n";
}

describe("gatherOrphans", () => {
  afterEach(() => {
    spawnCtx.reset();
    isPidAliveCtx.reset();
    sendSignalCtx.reset();
    cleanupSleepCtx.reset();
  });

  test("clean state — no orphans of any kind", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator", "ittybitty-deadbeef-agent-aaaa"]),
      claudePids: new Set([1111]),
      watchdogPids: new Set([2222]),
    };

    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
        return makeSpawnResult(0, "ib-coordinator\nittybitty-deadbeef-agent-aaaa\n");
      }
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 1111, command: "claude --resume abc --model sonnet" },
          { pid: 2222, command: "ib watchdog agent-aaaa" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked);
    expect(orphans.tmux_sessions).toEqual([]);
    expect(orphans.claude_processes).toEqual([]);
    expect(orphans.watchdog_processes).toEqual([]);
    expect(orphans.ib_watch_processes).toEqual([]);
  });

  test("detects orphan tmux session matching ittybitty- pattern", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator"]),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
        return makeSpawnResult(0, "ib-coordinator\nittybitty-aabbccdd-agent-stale\nuser-session\n");
      }
      if (cmd[0] === "ps") return makeSpawnResult(0, "");
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked);
    expect(orphans.tmux_sessions).toEqual(["ittybitty-aabbccdd-agent-stale"]);
    // user-session is NOT itsybitsy-shaped, must not be flagged
    expect(orphans.tmux_sessions).not.toContain("user-session");
  });

  test("detects orphan claude process — bare claude is ignored, only --resume/--session-id flagged", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set([1111]),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") return makeSpawnResult(0, "");
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 1111, command: "claude --resume abc" },           // tracked
          { pid: 9999, command: "claude --resume orphan-id" },     // orphan
          { pid: 8888, command: "claude" },                        // ignored (no --resume/--session-id)
          { pid: 7777, command: "vim claude.txt" },                // ignored (not claude binary)
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked);
    expect(orphans.claude_processes).toEqual([
      { pid: 9999, command: "claude --resume orphan-id" },
    ]);
  });

  test("detects orphan watchdog process", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set(),
      watchdogPids: new Set([2222]),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") return makeSpawnResult(0, "");
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 2222, command: "ib watchdog agent-foo" },           // tracked
          { pid: 9999, command: "ib watchdog agent-orphan" },        // orphan
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked);
    expect(orphans.watchdog_processes).toEqual([
      { pid: 9999, command: "ib watchdog agent-orphan" },
    ]);
  });

  test("reports all ib watch processes (no tracked set — informational)", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") return makeSpawnResult(0, "");
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 5555, command: "ib watch" },
          { pid: 5556, command: "/usr/local/bin/ib watch" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked);
    expect(orphans.ib_watch_processes.length).toBe(2);
    expect(orphans.ib_watch_processes.map((p) => p.pid).sort()).toEqual([5555, 5556]);
  });

  test("multiple orphan types together", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator", "ittybitty-aaaa-agent-good"]),
      claudePids: new Set([1111]),
      watchdogPids: new Set([2222]),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
        return makeSpawnResult(0, "ib-coordinator\nittybitty-aaaa-agent-good\nittybitty-bbbb-agent-stale\n");
      }
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 1111, command: "claude --resume good" },
          { pid: 2222, command: "ib watchdog agent-good" },
          { pid: 3333, command: "claude --resume orphan" },
          { pid: 4444, command: "ib watchdog agent-orphan" },
          { pid: 5555, command: "ib watch" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked);
    expect(orphans.tmux_sessions).toEqual(["ittybitty-bbbb-agent-stale"]);
    expect(orphans.claude_processes).toEqual([
      { pid: 3333, command: "claude --resume orphan" },
    ]);
    expect(orphans.watchdog_processes).toEqual([
      { pid: 4444, command: "ib watchdog agent-orphan" },
    ]);
    expect(orphans.ib_watch_processes.length).toBe(1);
  });

  test("does NOT flag a tmux session belonging to a tracked agent", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator", "ittybitty-aaaa-agent-tracked"]),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
        return makeSpawnResult(0, "ittybitty-aaaa-agent-tracked\n");
      }
      if (cmd[0] === "ps") return makeSpawnResult(0, "");
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked);
    expect(orphans.tmux_sessions).toEqual([]);
  });

  test("agent in repo A is NOT flagged when running ib state from repo B (cross-repo)", async () => {
    // Simulate: registry has repo A and repo B. Agent in repo A has a tmux
    // session and claude PID. The tracked set built from BOTH repos must
    // include repo A's agent — otherwise running `ib state` from anywhere
    // would mis-flag it.
    const repoADir = await mkdtemp(join(tmpdir(), "ib-orphan-repoA-"));
    const repoBDir = await mkdtemp(join(tmpdir(), "ib-orphan-repoB-"));
    try {
      await mkdir(join(repoADir, ".ittybitty", "agents", "agent-a"), { recursive: true });
      await mkdir(join(repoBDir, ".ittybitty", "agents", "agent-b"), { recursive: true });

      const aA = makeAgent({
        id: "agent-a",
        repoPath: repoADir,
        meta: {
          id: "agent-a",
          session_id: "x",
          tmux_session: "ittybitty-aaaa-agent-a",
          prompt: "",
          manager: null,
          created: "",
          created_epoch: 0,
          worktree: false,
          worker: false,
          yolo: false,
          model: "sonnet",
          claude_pid: "1010",
          watchdog_pid: 2010,
        },
      });
      const aB = makeAgent({
        id: "agent-b",
        repoPath: repoBDir,
        meta: {
          id: "agent-b",
          session_id: "y",
          tmux_session: "ittybitty-bbbb-agent-b",
          prompt: "",
          manager: null,
          created: "",
          created_epoch: 0,
          worktree: false,
          worker: false,
          yolo: false,
          model: "sonnet",
          claude_pid: "1020",
          watchdog_pid: 2020,
        },
      });

      const tracked = await buildTrackedSets([aA, aB]);
      spawnCtx.set((cmd: string[]) => {
        if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
          return makeSpawnResult(0, "ittybitty-aaaa-agent-a\nittybitty-bbbb-agent-b\n");
        }
        if (cmd[0] === "ps") {
          return makeSpawnResult(0, fakePsOutput([
            { pid: 1010, command: "claude --resume sa" },
            { pid: 1020, command: "claude --resume sb" },
            { pid: 2010, command: "ib watchdog agent-a" },
            { pid: 2020, command: "ib watchdog agent-b" },
          ]));
        }
        return makeSpawnResult(1);
      });

      const orphans = await gatherOrphans(tracked);
      expect(orphans.tmux_sessions).toEqual([]);
      expect(orphans.claude_processes).toEqual([]);
      expect(orphans.watchdog_processes).toEqual([]);
    } finally {
      await rm(repoADir, { recursive: true, force: true });
      await rm(repoBDir, { recursive: true, force: true });
    }
  });
});

describe("cleanupOrphans", () => {
  afterEach(() => {
    spawnCtx.reset();
    isPidAliveCtx.reset();
    sendSignalCtx.reset();
    cleanupSleepCtx.reset();
  });

  test("issues tmux kill-session for each orphan tmux session", async () => {
    const calls: string[][] = [];
    spawnCtx.set((cmd: string[]) => {
      calls.push(cmd);
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") return makeSpawnResult(0);
      return makeSpawnResult(1);
    });

    const report: OrphanReport = {
      tmux_sessions: ["ittybitty-stale-foo", "ittybitty-stale-bar"],
      claude_processes: [],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report);

    expect(calls.filter((c) => c[0] === "tmux" && c[1] === "kill-session" && c[3] === "ittybitty-stale-foo").length).toBe(1);
    expect(calls.filter((c) => c[0] === "tmux" && c[1] === "kill-session" && c[3] === "ittybitty-stale-bar").length).toBe(1);
    expect(cleanup.actions.length).toBe(2);
    for (const action of cleanup.actions) {
      expect(action.kind).toBe("tmux_session");
      expect(action.killed).toBe(true);
    }
  });

  test("refuses to kill a tmux session with an invalid name", async () => {
    let killSessionCalled = false;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") killSessionCalled = true;
      return makeSpawnResult(0);
    });
    const report: OrphanReport = {
      tmux_sessions: ["bad name; rm -rf /"],
      claude_processes: [],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report);
    expect(killSessionCalled).toBe(false);
    expect(cleanup.actions[0]!.killed).toBe(false);
    expect(cleanup.actions[0]!.error).toContain("invalid");
  });

  test("SIGTERM then SIGKILL after grace when process refuses to die", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    // Pretend the process never dies even after SIGKILL (worst case path).
    isPidAliveCtx.set(() => true);
    const signals: { pid: number; signal: NodeJS.Signals | 0 }[] = [];
    sendSignalCtx.set((pid, signal) => {
      signals.push({ pid, signal });
    });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [{ pid: 4242, command: "claude --resume x" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report);
    expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals.every((s) => s.pid === 4242)).toBe(true);
    expect(cleanup.actions[0]!.killed).toBe(false);
    expect(cleanup.actions[0]!.error).toContain("still alive");
  });

  test("SIGTERM only, when process exits during grace period", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    // Alive on first check, dead on second (post-SIGTERM).
    let aliveCalls = 0;
    isPidAliveCtx.set(() => {
      aliveCalls++;
      // first call (before SIGTERM): alive; subsequent: dead
      return aliveCalls === 1;
    });
    const signals: NodeJS.Signals[] = [];
    sendSignalCtx.set((_pid, signal) => {
      signals.push(signal as NodeJS.Signals);
    });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [],
      watchdog_processes: [{ pid: 4242, command: "ib watchdog agent-x" }],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report);
    expect(signals).toEqual(["SIGTERM"]);
    expect(cleanup.actions[0]!.killed).toBe(true);
    expect(cleanup.actions[0]!.kind).toBe("watchdog_process");
  });

  test("does NOT signal a process that is already dead", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => false);
    let signalCalls = 0;
    sendSignalCtx.set(() => { signalCalls++; });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [{ pid: 9999, command: "claude --resume foo" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report);
    expect(signalCalls).toBe(0);
    expect(cleanup.actions[0]!.killed).toBe(true);
  });

  test("only kills entries in the orphan report — never touches anything outside it", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => true);
    const tmuxKills: string[] = [];
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
        tmuxKills.push(cmd[3]!);
        return makeSpawnResult(0);
      }
      return makeSpawnResult(1);
    });
    const signaled = new Set<number>();
    sendSignalCtx.set((pid) => { signaled.add(pid); });

    const report: OrphanReport = {
      tmux_sessions: ["ittybitty-orphan-only"],
      claude_processes: [{ pid: 7777, command: "claude --resume only" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    await cleanupOrphans(report);

    // Only the explicit orphan entries get killed.
    expect(tmuxKills).toEqual(["ittybitty-orphan-only"]);
    expect([...signaled]).toEqual([7777]);
  });

  test("--cleanup style end-to-end: gather then cleanup, then re-gather sees nothing", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    // Initially, two ittybitsy sessions exist; only one is tracked. After
    // cleanup, the orphan tmux session is gone so re-gather sees no orphans.
    let killedSession: string | null = null;
    let aliveCalls = 0;
    isPidAliveCtx.set(() => {
      aliveCalls++;
      return aliveCalls === 1; // alive once (pre-SIGTERM), then dead
    });
    sendSignalCtx.set(() => { /* swallow */ });

    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
        const sessions = killedSession
          ? "ib-coordinator\nittybitty-aaaa-agent-good\n"
          : "ib-coordinator\nittybitty-aaaa-agent-good\nittybitty-bbbb-stale\n";
        return makeSpawnResult(0, sessions);
      }
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
        killedSession = cmd[3] ?? null;
        return makeSpawnResult(0);
      }
      if (cmd[0] === "ps") {
        const procs = killedSession
          ? [{ pid: 1111, command: "claude --resume good" }]
          : [
              { pid: 1111, command: "claude --resume good" },
              { pid: 9999, command: "claude --resume stale" },
            ];
        return makeSpawnResult(0, fakePsOutput(procs));
      }
      return makeSpawnResult(1);
    });

    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator", "ittybitty-aaaa-agent-good"]),
      claudePids: new Set([1111]),
      watchdogPids: new Set(),
    };

    const before = await gatherOrphans(tracked);
    expect(before.tmux_sessions).toEqual(["ittybitty-bbbb-stale"]);
    expect(before.claude_processes.map((p) => p.pid)).toEqual([9999]);

    const cleanup = await cleanupOrphans(before);
    expect(cleanup.actions.length).toBe(2);
    expect(cleanup.actions.every((a) => a.killed)).toBe(true);

    // Reset alive-call counter for the post-cleanup pass — it does not run
    // SIGTERM/SIGKILL, only filters orphans.
    isPidAliveCtx.set(() => false);
    const after = await gatherOrphans(tracked);
    expect(after.tmux_sessions).toEqual([]);
    expect(after.claude_processes).toEqual([]);
  });
});
