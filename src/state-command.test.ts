import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeAgent, makeSpawnResult } from "./test-utils";
import { gatherAgentState, formatPidComponent } from "./state-command";
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
