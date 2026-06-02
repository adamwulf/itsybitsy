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
  prepareAndRunCleanup,
  isItsybitsyTmuxSession,
  looksLikeClaudeArgv,
  isClaudeAgentProcess,
  isWatchdogProcess,
  isIbWatchProcess,
  sanitizeForDisplay,
  cleanupSleepCtx,
  readProcessCwdCtx,
  type OrphanReport,
  type TrackedSets,
} from "./state-command";
import type { Agent } from "./agents";
import { isPidAliveCtx, killPidCtx } from "./agents";
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
      { match: (c) => c[0] === "tmux" && c[1] === "has-session" && c[3] === "=ib-test01", result: makeSpawnResult(0) },
      { match: (c) => c[0] === "tmux" && c[1] === "list-panes" && c[3] === "=ib-test01", result: makeSpawnResult(0, "3000\n") },
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

describe("looksLikeClaudeArgv", () => {
  test("matches `claude --resume <id>` invocations", () => {
    expect(looksLikeClaudeArgv("claude --resume abc123 --model sonnet")).toBe(true);
  });
  test("matches `/usr/local/bin/claude --session-id <uuid>`", () => {
    expect(looksLikeClaudeArgv("/usr/local/bin/claude --session-id 11111111-2222-3333-4444-555555555555 --foo")).toBe(true);
  });
  test("rejects bare `claude` without --resume / --session-id", () => {
    expect(looksLikeClaudeArgv("claude")).toBe(false);
    expect(looksLikeClaudeArgv("claude --help")).toBe(false);
  });
  test("rejects unrelated processes that merely contain `claude`", () => {
    expect(looksLikeClaudeArgv("vim claude.txt")).toBe(false);
    expect(looksLikeClaudeArgv("/Users/claude/some-app")).toBe(false);
  });
});

describe("isClaudeAgentProcess (cwd-anchored, repo-path-cross-referenced)", () => {
  // The cwd must be under one of the registered repos' .ittybitty/agents/
  // — both the cwd anchor AND the repo-path cross-reference are required.
  const REPOS = ["/Users/me/Code/repo"];

  afterEach(() => {
    readProcessCwdCtx.reset();
  });

  test("returns true when argv looks right AND cwd is inside a registered repo's worktree", async () => {
    readProcessCwdCtx.set(async () => "/Users/me/Code/repo/.ittybitty/agents/agent-foo/repo");
    expect(await isClaudeAgentProcess(1234, "claude --resume abc", REPOS)).toBe(true);
  });

  test("rejects when cwd is OUTSIDE every registered repo (user's own claude)", async () => {
    readProcessCwdCtx.set(async () => "/Users/me/Documents/notes");
    expect(await isClaudeAgentProcess(1234, "claude --resume abc", REPOS)).toBe(false);
  });

  test("rejects when cwd looks itsybitsy-shaped but is under an UNREGISTERED repo (stray .ittybitty/)", async () => {
    // R2 polish: a stray/backup `.ittybitty/agents/` directory anywhere on
    // disk used to flag user processes as orphans. Repo-path cross-reference
    // closes that hole.
    readProcessCwdCtx.set(async () => "/Users/me/Backup/old-clone/.ittybitty/agents/agent-x/repo");
    expect(await isClaudeAgentProcess(1234, "claude --resume abc", REPOS)).toBe(false);
  });

  test("rejects when cwd lookup returns empty (lsof failure / permission)", async () => {
    // SAFETY-CRITICAL: an unknown cwd must NOT count as itsybitsy-owned.
    readProcessCwdCtx.set(async () => "");
    expect(await isClaudeAgentProcess(1234, "claude --resume abc", REPOS)).toBe(false);
  });

  test("rejects when no repos are registered (empty repoPaths)", async () => {
    readProcessCwdCtx.set(async () => "/Users/me/Code/repo/.ittybitty/agents/agent-foo/repo");
    expect(await isClaudeAgentProcess(1234, "claude --resume abc", [])).toBe(false);
  });

  test("rejects when argv doesn't look like claude even if cwd is in a worktree", async () => {
    readProcessCwdCtx.set(async () => "/Users/me/Code/repo/.ittybitty/agents/agent-foo/repo");
    expect(await isClaudeAgentProcess(1234, "vim notes.txt", REPOS)).toBe(false);
  });

  test("matches when cwd is the agent dir itself (no /repo subpath)", async () => {
    // start.sh runs claude from the worktree, but during certain failure modes
    // the cwd may briefly be the agent dir itself. Both shapes pass as long
    // as the prefix is a registered repo's `.ittybitty/agents/`.
    readProcessCwdCtx.set(async () => "/Users/me/Code/repo/.ittybitty/agents/agent-foo");
    expect(await isClaudeAgentProcess(1234, "claude --resume abc", REPOS)).toBe(true);
  });

  test("matches across multiple registered repos", async () => {
    const repos = ["/repo-a", "/repo-b"];
    readProcessCwdCtx.set(async () => "/repo-b/.ittybitty/agents/agent-x/repo");
    expect(await isClaudeAgentProcess(1234, "claude --resume abc", repos)).toBe(true);
  });
});

describe("sanitizeForDisplay", () => {
  test("strips full ANSI/CSI sequences (no leftover [31m noise)", () => {
    expect(sanitizeForDisplay("hello\x1b[31mred\x1b[0mworld")).toBe("helloredworld");
  });
  test("replaces non-CSI control chars with ?", () => {
    expect(sanitizeForDisplay("a\x00b\x07c")).toBe("a?b?c");
  });
  test("strips both CSI and bare control chars in one pass", () => {
    expect(sanitizeForDisplay("\x1b[1;31mfoo\x00bar")).toBe("foo?bar");
  });
  test("leaves regular printable text alone", () => {
    expect(sanitizeForDisplay("ittybitty-abc-foo")).toBe("ittybitty-abc-foo");
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

// Helper: install a `readProcessCwdCtx` fake that reports each PID as living
// inside an itsybitsy worktree at `/tmp/repo` — used by tests that want
// claude detection to succeed (cwd anchor + repo cross-reference are
// required). Pair with `FAKE_REPOS` when calling gatherOrphans/cleanupOrphans.
function fakeCwdInsideWorktree(): void {
  readProcessCwdCtx.set(async (pid) => `/tmp/repo/.ittybitty/agents/agent-${pid}/repo`);
}
const FAKE_REPOS = ["/tmp/repo"];

describe("gatherOrphans", () => {
  afterEach(() => {
    spawnCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    cleanupSleepCtx.reset();
    readProcessCwdCtx.reset();
  });

  test("clean state — no orphans of any kind", async () => {
    fakeCwdInsideWorktree();
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator", "ittybitty-deadbeef-agent-aaaa"]),
      claudePids: new Set([1111]),
      watchdogPids: new Set([2222]),
    };

    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 1111, command: "claude --resume abc --model sonnet" },
          { pid: 2222, command: "ib watchdog agent-aaaa" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(
      tracked,
      new Set(["ib-coordinator", "ittybitty-deadbeef-agent-aaaa"]),
      FAKE_REPOS,
    );
    expect(orphans.tmux_sessions).toEqual([]);
    expect(orphans.claude_processes).toEqual([]);
    expect(orphans.watchdog_processes).toEqual([]);
    expect(orphans.ib_watch_processes).toEqual([]);
  });

  test("falls back to `tmux list-sessions` when liveTmuxSessions is null", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator"]),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    let listSessionsCalled = false;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
        listSessionsCalled = true;
        return makeSpawnResult(0, "ib-coordinator\nittybitty-stale-foo\n");
      }
      if (cmd[0] === "ps") return makeSpawnResult(0, "");
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked, null);
    expect(listSessionsCalled).toBe(true);
    expect(orphans.tmux_sessions).toEqual(["ittybitty-stale-foo"]);
  });

  test("detects orphan tmux session matching ittybitty- pattern", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator"]),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps") return makeSpawnResult(0, "");
      return makeSpawnResult(1);
    });

    const live = new Set(["ib-coordinator", "ittybitty-aabbccdd-agent-stale", "user-session"]);
    const orphans = await gatherOrphans(tracked, live);
    expect(orphans.tmux_sessions).toEqual(["ittybitty-aabbccdd-agent-stale"]);
    // user-session is NOT itsybitsy-shaped, must not be flagged
    expect(orphans.tmux_sessions).not.toContain("user-session");
  });

  test("detects orphan claude process — bare claude is ignored, only --resume/--session-id flagged", async () => {
    fakeCwdInsideWorktree();
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set([1111]),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
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

    const orphans = await gatherOrphans(tracked, new Set(), FAKE_REPOS);
    expect(orphans.claude_processes).toEqual([
      { pid: 9999, command: "claude --resume orphan-id" },
    ]);
  });

  test("does NOT flag claude process whose cwd is OUTSIDE every itsybitsy worktree (user's own claude)", async () => {
    // SAFETY-CRITICAL: a user running `claude --resume <id>` in a regular
    // terminal must NEVER be classified as an itsybitsy orphan.
    readProcessCwdCtx.set(async () => "/Users/me/Documents/notes");
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 9999, command: "claude --resume my-personal-session" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked, new Set(), FAKE_REPOS);
    expect(orphans.claude_processes).toEqual([]);
  });

  test("does NOT flag claude process when cwd lookup is empty (lsof permission denied)", async () => {
    readProcessCwdCtx.set(async () => "");
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 9999, command: "claude --resume something" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked, new Set(), FAKE_REPOS);
    expect(orphans.claude_processes).toEqual([]);
  });

  test("does NOT flag claude process whose cwd is in a stray .ittybitty/agents/ NOT under any registered repo", async () => {
    // R2 polish: this is the "user has a backup .ittybitty/agents/ from an
    // un-registered project" scenario. Repo cross-reference is what closes it.
    readProcessCwdCtx.set(async () => "/Users/me/Backup/old-clone/.ittybitty/agents/agent-x/repo");
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set(),
      watchdogPids: new Set(),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 9999, command: "claude --resume something" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked, new Set(), FAKE_REPOS);
    expect(orphans.claude_processes).toEqual([]);
  });

  test("detects orphan watchdog process", async () => {
    const tracked: TrackedSets = {
      tmuxSessions: new Set(),
      claudePids: new Set(),
      watchdogPids: new Set([2222]),
    };
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 2222, command: "ib watchdog agent-foo" },           // tracked
          { pid: 9999, command: "ib watchdog agent-orphan" },        // orphan
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked, new Set());
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
      if (cmd[0] === "ps") {
        return makeSpawnResult(0, fakePsOutput([
          { pid: 5555, command: "ib watch" },
          { pid: 5556, command: "/usr/local/bin/ib watch" },
        ]));
      }
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked, new Set());
    expect(orphans.ib_watch_processes.length).toBe(2);
    expect(orphans.ib_watch_processes.map((p) => p.pid).sort()).toEqual([5555, 5556]);
  });

  test("multiple orphan types together", async () => {
    fakeCwdInsideWorktree();
    const tracked: TrackedSets = {
      tmuxSessions: new Set(["ib-coordinator", "ittybitty-aaaa-agent-good"]),
      claudePids: new Set([1111]),
      watchdogPids: new Set([2222]),
    };
    spawnCtx.set((cmd: string[]) => {
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

    const live = new Set(["ib-coordinator", "ittybitty-aaaa-agent-good", "ittybitty-bbbb-agent-stale"]);
    const orphans = await gatherOrphans(tracked, live, FAKE_REPOS);
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
      if (cmd[0] === "ps") return makeSpawnResult(0, "");
      return makeSpawnResult(1);
    });

    const orphans = await gatherOrphans(tracked, new Set(["ittybitty-aaaa-agent-tracked"]));
    expect(orphans.tmux_sessions).toEqual([]);
  });

  test("agent in repo A is NOT flagged when running ib state from repo B (cross-repo)", async () => {
    // Simulate: registry has repo A and repo B. Agent in repo A has a tmux
    // session and claude PID. The tracked set built from BOTH repos must
    // include repo A's agent — otherwise running `ib state` from anywhere
    // would mis-flag it.
    fakeCwdInsideWorktree();
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

      const orphans = await gatherOrphans(
        tracked,
        new Set(["ittybitty-aaaa-agent-a", "ittybitty-bbbb-agent-b"]),
        [repoADir, repoBDir],
      );
      expect(orphans.tmux_sessions).toEqual([]);
      expect(orphans.claude_processes).toEqual([]);
      expect(orphans.watchdog_processes).toEqual([]);
    } finally {
      await rm(repoADir, { recursive: true, force: true });
      await rm(repoBDir, { recursive: true, force: true });
    }
  });
});

const EMPTY_TRACKED: TrackedSets = {
  tmuxSessions: new Set(),
  claudePids: new Set(),
  watchdogPids: new Set(),
};

describe("cleanupOrphans", () => {
  afterEach(() => {
    spawnCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    cleanupSleepCtx.reset();
    readProcessCwdCtx.reset();
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
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED);

    expect(calls.filter((c) => c[0] === "tmux" && c[1] === "kill-session" && c[3] === "=ittybitty-stale-foo").length).toBe(1);
    expect(calls.filter((c) => c[0] === "tmux" && c[1] === "kill-session" && c[3] === "=ittybitty-stale-bar").length).toBe(1);
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
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED);
    expect(killSessionCalled).toBe(false);
    expect(cleanup.actions[0]!.killed).toBe(false);
    expect(cleanup.actions[0]!.error).toContain("invalid");
  });

  test("SIGTERM then SIGKILL after grace when process refuses to die", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => true);
    const signals: { pid: number; signal: NodeJS.Signals | number }[] = [];
    killPidCtx.set((pid, signal) => {
      signals.push({ pid, signal });
      return true;
    });
    // PID-reuse re-check: ps command lookup must return the original cmd
    // so killProcessGracefully proceeds to SIGKILL.
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "command=") {
        return makeSpawnResult(0, "claude --resume x\n");
      }
      return makeSpawnResult(1);
    });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [{ pid: 4242, command: "claude --resume x" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED);
    expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals.every((s) => s.pid === 4242)).toBe(true);
    expect(cleanup.actions[0]!.killed).toBe(false);
    expect(cleanup.actions[0]!.error).toContain("still alive");
  });

  test("SIGTERM only, when process exits during grace period", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    let aliveCalls = 0;
    isPidAliveCtx.set(() => {
      aliveCalls++;
      return aliveCalls === 1;
    });
    const signals: (NodeJS.Signals | number)[] = [];
    killPidCtx.set((_pid, signal) => {
      signals.push(signal);
      return true;
    });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [],
      watchdog_processes: [{ pid: 4242, command: "ib watchdog agent-x" }],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED);
    expect(signals).toEqual(["SIGTERM"]);
    expect(cleanup.actions[0]!.killed).toBe(true);
    expect(cleanup.actions[0]!.kind).toBe("watchdog_process");
  });

  test("does NOT signal a process that is already dead", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => false);
    let signalCalls = 0;
    killPidCtx.set(() => { signalCalls++; return true; });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [{ pid: 9999, command: "claude --resume foo" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED);
    expect(signalCalls).toBe(0);
    expect(cleanup.actions[0]!.killed).toBe(true);
  });

  test("only kills entries in the orphan report — never touches anything outside it", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    let aliveCalls = 0;
    isPidAliveCtx.set(() => { aliveCalls++; return aliveCalls === 1; });
    const tmuxKills: string[] = [];
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
        tmuxKills.push(cmd[3]!);
        return makeSpawnResult(0);
      }
      return makeSpawnResult(1);
    });
    const signaled = new Set<number>();
    killPidCtx.set((pid) => { signaled.add(pid); return true; });

    const report: OrphanReport = {
      tmux_sessions: ["ittybitty-orphan-only"],
      claude_processes: [{ pid: 7777, command: "claude --resume only" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    await cleanupOrphans(report, EMPTY_TRACKED);

    // Only the explicit orphan entries get killed.
    expect(tmuxKills).toEqual(["=ittybitty-orphan-only"]);
    expect([...signaled]).toEqual([7777]);
  });

  test("RACE GUARD: skips kill when target became tracked between gather and cleanup", async () => {
    // Scenario: gather flagged ittybitty-late-foo and PID 4242 as orphans;
    // between gather and cleanup, a new agent was spawned that owns those.
    // cleanupOrphans must skip both.
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => true);
    let killSessionCalled = false;
    let signalled = 0;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
        killSessionCalled = true;
        return makeSpawnResult(0);
      }
      return makeSpawnResult(1);
    });
    killPidCtx.set(() => { signalled++; return true; });

    const report: OrphanReport = {
      tmux_sessions: ["ittybitty-late-foo"],
      claude_processes: [{ pid: 4242, command: "claude --resume late" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const trackedNow: TrackedSets = {
      tmuxSessions: new Set(["ittybitty-late-foo"]),
      claudePids: new Set([4242]),
      watchdogPids: new Set(),
    };
    const cleanup = await cleanupOrphans(report, trackedNow);

    expect(killSessionCalled).toBe(false);
    expect(signalled).toBe(0);
    expect(cleanup.actions.length).toBe(2);
    expect(cleanup.actions.every((a) => a.skipped === true)).toBe(true);
    for (const action of cleanup.actions) {
      expect(action.error).toContain("raced");
    }
  });

  test("PID-REUSE GUARD: refuses SIGKILL if cmd no longer matches", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => true);
    const signals: NodeJS.Signals[] = [];
    killPidCtx.set((_pid, signal) => {
      signals.push(signal as NodeJS.Signals);
      return true;
    });
    // After SIGTERM, the PID was reused by `vim` — kernel recycled it.
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "command=") {
        return makeSpawnResult(0, "vim some-other-file.txt\n");
      }
      return makeSpawnResult(1);
    });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [{ pid: 4242, command: "claude --resume x" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED);
    expect(signals).toEqual(["SIGTERM"]);  // No SIGKILL
    expect(cleanup.actions[0]!.killed).toBe(false);
    expect(cleanup.actions[0]!.error).toContain("PID reuse");
  });

  test("PID-REUSE GUARD: refuses SIGKILL when ps -o command= returns empty (verification couldn't happen)", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => true);
    const signals: NodeJS.Signals[] = [];
    killPidCtx.set((_pid, signal) => {
      signals.push(signal as NodeJS.Signals);
      return true;
    });
    // After SIGTERM, ps fails to look up the command line (transient
    // permission / race). Safer default: refuse SIGKILL.
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "command=") {
        return makeSpawnResult(1, "");
      }
      return makeSpawnResult(1);
    });

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [{ pid: 4242, command: "claude --resume x" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED);
    expect(signals).toEqual(["SIGTERM"]);
    expect(cleanup.actions[0]!.killed).toBe(false);
    expect(cleanup.actions[0]!.error).toContain("could not verify");
  });

  test("PID-REUSE GUARD (claude): re-verifies cwd, not just argv — recycled PID into user's own claude is refused", async () => {
    // The dangerous case the cwd anchor was added for, in the PID-reuse
    // window: SIGTERM fires; PID is recycled; new process is the user's own
    // `claude --resume`. argv-only matching would let SIGKILL through —
    // claudeVerify must re-run isClaudeAgentProcess (cwd-anchored).
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => true);
    const signals: NodeJS.Signals[] = [];
    killPidCtx.set((_pid, signal) => {
      signals.push(signal as NodeJS.Signals);
      return true;
    });
    // ps reports a different (but still claude --resume) cmd — argv matcher
    // would say "still claude, fine" but cwd is OUTSIDE every registered repo.
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "command=") {
        return makeSpawnResult(0, "claude --resume my-personal\n");
      }
      return makeSpawnResult(1);
    });
    readProcessCwdCtx.set(async () => "/Users/me/Documents/notes");

    const report: OrphanReport = {
      tmux_sessions: [],
      claude_processes: [{ pid: 4242, command: "claude --resume orphan" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED, { repoPaths: FAKE_REPOS });
    expect(signals).toEqual(["SIGTERM"]);  // No SIGKILL
    expect(cleanup.actions[0]!.killed).toBe(false);
    expect(cleanup.actions[0]!.error).toContain("PID reuse");
  });

  test("DRY-RUN: does not issue any kills, returns skipped actions", async () => {
    let killCalls = 0;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") killCalls++;
      return makeSpawnResult(0);
    });
    killPidCtx.set(() => { killCalls++; return true; });

    const report: OrphanReport = {
      tmux_sessions: ["ittybitty-dryrun-foo"],
      claude_processes: [{ pid: 9999, command: "claude --resume x" }],
      watchdog_processes: [],
      ib_watch_processes: [],
    };
    const cleanup = await cleanupOrphans(report, EMPTY_TRACKED, { dryRun: true });

    expect(killCalls).toBe(0);
    expect(cleanup.actions.length).toBe(2);
    expect(cleanup.actions.every((a) => a.skipped === true)).toBe(true);
    expect(cleanup.actions.every((a) => a.error === "dry-run")).toBe(true);
  });

  test("--cleanup style end-to-end: gather then cleanup, then re-gather sees nothing", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    fakeCwdInsideWorktree();
    let killedSession: string | null = null;
    let aliveCalls = 0;
    isPidAliveCtx.set(() => {
      aliveCalls++;
      return aliveCalls === 1;
    });
    killPidCtx.set(() => true);

    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
        killedSession = cmd[3] ?? null;
        return makeSpawnResult(0);
      }
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "command=") {
        return makeSpawnResult(0, "claude --resume stale\n");
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

    const liveBefore = new Set(["ib-coordinator", "ittybitty-aaaa-agent-good", "ittybitty-bbbb-stale"]);
    const before = await gatherOrphans(tracked, liveBefore, FAKE_REPOS);
    expect(before.tmux_sessions).toEqual(["ittybitty-bbbb-stale"]);
    expect(before.claude_processes.map((p) => p.pid)).toEqual([9999]);

    const cleanup = await cleanupOrphans(before, tracked, { repoPaths: FAKE_REPOS });
    expect(cleanup.actions.length).toBe(2);
    expect(cleanup.actions.every((a) => a.killed)).toBe(true);

    isPidAliveCtx.set(() => false);
    const liveAfter = new Set(["ib-coordinator", "ittybitty-aaaa-agent-good"]);
    const after = await gatherOrphans(tracked, liveAfter, FAKE_REPOS);
    expect(after.tmux_sessions).toEqual([]);
    expect(after.claude_processes).toEqual([]);
  });
});

describe("prepareAndRunCleanup (CLI race-guard integration)", () => {
  afterEach(() => {
    spawnCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    cleanupSleepCtx.reset();
    readProcessCwdCtx.reset();
  });

  /** Helper to build a minimal Agent fixture with given tmux_session + PIDs. */
  function makeRaceAgent(opts: {
    id: string;
    tmuxSession: string;
    claudePid: string;
    watchdogPid?: number;
  }): Agent {
    return makeAgent({
      id: opts.id,
      meta: {
        id: opts.id,
        session_id: "x",
        tmux_session: opts.tmuxSession,
        prompt: "",
        manager: null,
        created: "",
        created_epoch: 0,
        worktree: false,
        worker: false,
        yolo: false,
        model: "sonnet",
        claude_pid: opts.claudePid,
        watchdog_pid: opts.watchdogPid,
      },
    });
  }

  test("BLOCKER FIX: re-reads agents from disk so a freshly-spawned agent is NOT killed", async () => {
    // Scenario timeline:
    //   T=0:  initial readAllAgents — returns [agent-good]. Orphans gather
    //         finds session "ittybitty-late-foo" + claude PID 4242 +
    //         watchdog PID 8888 as orphans (not yet tracked).
    //   T=10: another terminal spawns `agent-late` whose meta.json contains
    //         tmux_session=ittybitty-late-foo, claude_pid=4242,
    //         watchdog_pid=8888.
    //   T=50: prepareAndRunCleanup is invoked. It MUST re-read from disk
    //         (refreshAgents callback returns [agent-good, agent-late]) and
    //         skip all three orphans.
    cleanupSleepCtx.set(async () => { /* skip */ });
    isPidAliveCtx.set(() => true);
    let killSessionCalled = false;
    let signalled = 0;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
        killSessionCalled = true;
        return makeSpawnResult(0);
      }
      return makeSpawnResult(1);
    });
    killPidCtx.set(() => { signalled++; return true; });

    // Orphans built at T=0 — before agent-late existed.
    const orphans: OrphanReport = {
      tmux_sessions: ["ittybitty-late-foo"],
      claude_processes: [{ pid: 4242, command: "claude --resume late" }],
      watchdog_processes: [{ pid: 8888, command: "ib watchdog agent-late" }],
      ib_watch_processes: [],
    };

    // refreshAgents fake — returns the FRESH snapshot (with agent-late now
    // present). This is what readAllAgents() would do at T=50.
    const refreshAgents = async (): Promise<{ agents: Agent[] }> => ({
      agents: [
        makeRaceAgent({
          id: "agent-good",
          tmuxSession: "ittybitty-aaaa-agent-good",
          claudePid: "1111",
          watchdogPid: 2222,
        }),
        makeRaceAgent({
          id: "agent-late",
          tmuxSession: "ittybitty-late-foo",
          claudePid: "4242",
          watchdogPid: 8888,
        }),
      ],
    });

    const result = await prepareAndRunCleanup(orphans, refreshAgents);

    // CRITICAL: nothing should have been killed — every orphan target became
    // tracked between gather and cleanup, so the race guard skipped all three.
    expect(killSessionCalled).toBe(false);
    expect(signalled).toBe(0);
    expect(result.cleanupReport.actions.length).toBe(3);
    for (const action of result.cleanupReport.actions) {
      expect(action.skipped).toBe(true);
      expect(action.error).toContain("raced");
    }

    // Sanity: trackedNow contains the freshly-spawned agent's identifiers.
    expect(result.trackedNow.tmuxSessions.has("ittybitty-late-foo")).toBe(true);
    expect(result.trackedNow.claudePids.has(4242)).toBe(true);
    expect(result.trackedNow.watchdogPids.has(8888)).toBe(true);
  });

  test("kills orphans that are still genuinely orphans after the disk re-read", async () => {
    cleanupSleepCtx.set(async () => { /* skip */ });
    let aliveCalls = 0;
    isPidAliveCtx.set(() => { aliveCalls++; return aliveCalls === 1; });
    let killSessions = 0;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
        killSessions++;
        return makeSpawnResult(0);
      }
      return makeSpawnResult(1);
    });
    killPidCtx.set(() => true);

    const orphans: OrphanReport = {
      tmux_sessions: ["ittybitty-truly-stale"],
      claude_processes: [],
      watchdog_processes: [{ pid: 9000, command: "ib watchdog stale-agent" }],
      ib_watch_processes: [],
    };
    // refreshAgents returns no new agents — orphans are still orphans.
    const refreshAgents = async (): Promise<{ agents: Agent[] }> => ({ agents: [] });

    const result = await prepareAndRunCleanup(orphans, refreshAgents, { dryRun: false });
    expect(killSessions).toBe(1);
    expect(result.cleanupReport.actions.length).toBe(2);
    expect(result.cleanupReport.actions.every((a) => a.killed)).toBe(true);
  });

  test("respects dryRun option end-to-end", async () => {
    let kills = 0;
    spawnCtx.set((cmd: string[]) => {
      if (cmd[0] === "tmux" && cmd[1] === "kill-session") kills++;
      return makeSpawnResult(0);
    });
    killPidCtx.set(() => { kills++; return true; });

    const orphans: OrphanReport = {
      tmux_sessions: ["ittybitty-dryrun"],
      claude_processes: [],
      watchdog_processes: [{ pid: 1234, command: "ib watchdog x" }],
      ib_watch_processes: [],
    };
    const refreshAgents = async (): Promise<{ agents: Agent[] }> => ({ agents: [] });
    const result = await prepareAndRunCleanup(orphans, refreshAgents, { dryRun: true });

    expect(kills).toBe(0);
    expect(result.cleanupReport.actions.every((a) => a.skipped === true)).toBe(true);
  });
});
