import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeAgent, makeFlatAgent, makeFlatRepoHeader } from "../test-utils";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import type { RepoEntry } from "../registry";
import type { ActionCtx } from "./agent-actions";
import type { DialogState } from "./dialog-handler";
import type { PaneMode } from "./pane-manager";
import { assertDialog } from "./test-helpers";
import {
  handleKill, handleNuke, handleNukeAll, handleResume, handlePause,
  handleSend, handleNewAgent, handleScrollUp, handleScrollDown,
  handleHelp, handleResizeLeft, handleFuzzyAgent, handleRename,
  handleOpenDiffTool, getActiveDiffProc, setActiveDiffProc, killActiveDiffProc,
  getDiffToolLaunching, setDiffToolLaunching,
  handleAddPermission, addPermissionToSettings, agentSettingsLocalPath,
  getCoordinatorSpawnsInFlight, clearCoordinatorSpawnsInFlight,
} from "./agent-actions";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";
import {
  setKillPauseSpawnRunner, resetKillPauseSpawnRunner,
  setNukeResumeSpawnRunner, resetNukeResumeSpawnRunner,
  setSendSpawnRunner, resetSendSpawnRunner,
  setNewAgentSpawnRunner, resetNewAgentSpawnRunner,
} from "../ib-commands";
import { spawnCtx as lifecycleSpawnCtx } from "../agent-lifecycle";
import type { SpawnResult } from "../types";

/** Noop spawn runner that always succeeds */
function noopSpawnRunner(): SpawnResult {
  return {
    stdout: new Response("").body!,
    stderr: new Response("").body!,
    exited: Promise.resolve(0),
  } as SpawnResult;
}

/** Build a mock ActionCtx. Returns the ctx plus trackers for calls. */
function makeMockCtx(overrides?: {
  agent?: Agent | null;
  repoHeader?: string | null;
  repos?: RepoEntry[];
  flatList?: FlatEntry[];
  leftWidth?: number;
  errors?: string[];
  questions?: PendingQuestion[];
  orphanedTmuxSessions?: string[];
  mode?: PaneMode;
}): {
  ctx: ActionCtx;
  dialogs: NonNullable<DialogState>[];
  notices: string[];
  refreshCalls: number[];
  scrollUpCalls: number[];
  scrollDownCalls: number[];
  loadAgentLogIfNeededCalls: number[];
  /** Await every executeAndRefresh action kicked off so far — deterministic
   *  alternative to a fixed Bun.sleep for fire-and-forget send paths. */
  flushActions: () => Promise<void>;
} {
  const dialogs: NonNullable<DialogState>[] = [];
  const notices: string[] = [];
  const refreshCalls: number[] = [];
  const scrollUpCalls: number[] = [];
  const scrollDownCalls: number[] = [];
  const loadAgentLogIfNeededCalls: number[] = [];
  const pendingActions: Promise<void>[] = [];
  let leftWidth = overrides?.leftWidth ?? 60;

  const ctx: ActionCtx = {
    agentTree: {
      selectedAgent: overrides?.agent ?? null,
      selectedRepoHeader: overrides?.repoHeader ?? null,
      isSystemCoordinatorSelected: false,
      flatList: overrides?.flatList ?? [],
      visibleList: overrides?.flatList ?? [],
      selectAgentById: () => true,
      selectByRepoPath: () => true,
    },
    rightPane: {
      mode: overrides?.mode ?? "AGENT LOG",
      repoCoordinatorAgent: null,
      filteredQuestions: overrides?.questions ?? [],
      questionsSelectedIndex: 0,
      scrollOffset: 5,
      repoCoordinatorScrollBack: 0,
      errors: overrides?.errors ?? [],
      orphanedTmuxSessions: overrides?.orphanedTmuxSessions ?? [],
      updateContent: () => {},
    },
    tmuxPane: {
      scrollUp: (n?: number) => scrollUpCalls.push(n ?? 10),
      scrollDown: (n?: number) => scrollDownCalls.push(n ?? 10),
    },
    coordinatorPane: {
      scrollUp: () => {},
      scrollDown: () => {},
      resetForAgent: () => {},
    },
    systemDashboard: {
      scrollUp: () => {},
      scrollDown: () => {},
    },
    splitPane: {
      getLeftWidth: () => leftWidth,
      setLeftWidth: (w: number) => { leftWidth = w; },
    },
    tui: { requestRender: () => {} },
    repos: overrides?.repos ?? [],
    watcher: { refresh: () => refreshCalls.push(1), updateRepos: () => {}, recheckHealth: () => {}, lastAgents: [] },
    diffTool: undefined,
    pendingSelectNewestInRepo: null,
    showDialog: (d: NonNullable<DialogState>) => { dialogs.push(d); },
    closeDialog: () => {},
    setNotice: (text: string) => { notices.push(text); },
    executeAndRefresh: (fn: () => Promise<void>) => {
      // Capture the in-flight action so tests can await it deterministically
      // (flushActions) instead of racing a fixed sleep against the inline
      // outbox drain. Swallow errors here to mirror the real wrapper's
      // try/catch and avoid unhandled rejections leaking across tests.
      const p = (async () => { try { await fn(); } catch { /* ignore */ } })();
      pendingActions.push(p);
      return p;
    },
    syncSelectedAgent: () => {},
    jumpToMode: () => {},
    loadAgentLogIfNeeded: () => {
      loadAgentLogIfNeededCalls.push(1);
    },
    setQuestionsFocused: () => {},
    healthReport: undefined,
  };
  const flushActions = async () => { await Promise.all(pendingActions); };
  return { ctx, dialogs, notices, refreshCalls, scrollUpCalls, scrollDownCalls, loadAgentLogIfNeededCalls, flushActions };
}

// Per-test isolated repo root. sendMessage now writes a real outbox.jsonl +
// .outbox.lock under <repoPath>/.ittybitty/agents/<id>/, so send-path tests
// MUST use a fresh, isolated repoPath — the old shared "/tmp/test" default
// (test-utils makeAgent) is reused across ~16 files, and a stale fresh
// .outbox.lock there makes the inline drain block ~5s on the lock while these
// tests only wait 10ms → flake. Each test gets its own dir, cleaned afterward.
let sendRepoDir: string;

beforeEach(async () => {
  setKillPauseSpawnRunner(noopSpawnRunner);
  setNukeResumeSpawnRunner(noopSpawnRunner);
  setSendSpawnRunner(noopSpawnRunner);
  setNewAgentSpawnRunner(noopSpawnRunner);
  lifecycleSpawnCtx.set(noopSpawnRunner);
  sendRepoDir = await mkdtemp(join(tmpdir(), "agent-actions-send-"));
});

afterEach(async () => {
  resetKillPauseSpawnRunner();
  resetNukeResumeSpawnRunner();
  resetSendSpawnRunner();
  resetNewAgentSpawnRunner();
  lifecycleSpawnCtx.reset();
  await rm(sendRepoDir, { recursive: true, force: true });
});

describe("handleKill", () => {
  test("does nothing when no agent selected", () => {
    const { ctx, dialogs } = makeMockCtx({ agent: null });
    handleKill(ctx);
    expect(dialogs).toHaveLength(0);
  });

  test("shows confirm dialog", () => {
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handleKill(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "confirm");
    expect(d.prompt).toContain("agent-1");
    expect(d.confirmLabel).toBe("Kill");
  });

  test("onYes calls executeAndRefresh with killAgent", async () => {
    const agent = makeAgent({ id: "agent-1" });
    let executeCalled = false;
    const { ctx, dialogs } = makeMockCtx({ agent });
    ctx.executeAndRefresh = async (fn) => { executeCalled = true; };
    handleKill(ctx);
    const d = assertDialog(dialogs[0]!, "confirm");
    d.onYes();
    await Bun.sleep(1);
    expect(executeCalled).toBe(true);
  });
});

describe("handleNuke", () => {
  test("no agent delegates to handleNukeAll", () => {
    const repos: RepoEntry[] = [{ path: "/tmp/repo", name: "repo" }];
    const { ctx, dialogs } = makeMockCtx({ agent: null, repos });
    handleNuke(ctx);
    // Should show nuke-all confirm for the single repo
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "confirm");
    expect(d.prompt).toContain("NUKE ALL");
  });

  test("with agent shows confirm dialog", () => {
    const agent = makeAgent({ id: "agent-2" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handleNuke(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "confirm");
    expect(d.prompt).toContain("FORCE KILL");
    expect(d.prompt).toContain("agent-2");
  });
});

describe("handleNukeAll", () => {
  test("no repos shows notice", () => {
    const { ctx, notices } = makeMockCtx({ repos: [] });
    handleNukeAll(ctx);
    expect(notices).toEqual(["No repos registered"]);
  });

  test("single repo shows confirm directly", () => {
    const repos: RepoEntry[] = [{ path: "/tmp/repo", name: "repo" }];
    const { ctx, dialogs } = makeMockCtx({ repos });
    handleNukeAll(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "confirm");
  });

  test("multiple repos shows select picker first", () => {
    const repos: RepoEntry[] = [{ path: "/tmp/repo1", name: "repo1" }, { path: "/tmp/repo2", name: "repo2" }];
    const { ctx, dialogs } = makeMockCtx({ repos });
    handleNukeAll(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "select");
  });
});

describe("handleResume", () => {
  test("does nothing when no agent selected", () => {
    const { ctx, notices } = makeMockCtx({ agent: null });
    handleResume(ctx);
    expect(notices).toHaveLength(0);
  });

  // The old behavior rejected non-stopped/complete agents with
  // "Can only resume stopped or complete agents". That racy state gate was
  // removed — handleResume now defers to resumeAgent()'s tmux-liveness check,
  // so a running/waiting agent still goes through to a resume attempt.
  test("attempts resume for running agent (defers to liveness check)", async () => {
    const agent = makeAgent({ id: "agent-1", state: "running" });
    const { ctx, notices } = makeMockCtx({ agent });
    handleResume(ctx);
    await Bun.sleep(10);
    expect(notices.some((n) => n.includes("Can only resume"))).toBe(false);
    expect(notices.some((n) => n.includes("Resuming") || n.includes("Resumed") || n.includes("Resume failed"))).toBe(true);
  });

  test("attempts resume for waiting agent (defers to liveness check)", async () => {
    const agent = makeAgent({ id: "agent-1", state: "waiting" });
    const { ctx, notices } = makeMockCtx({ agent });
    handleResume(ctx);
    await Bun.sleep(10);
    expect(notices.some((n) => n.includes("Can only resume"))).toBe(false);
    expect(notices.some((n) => n.includes("Resuming") || n.includes("Resumed") || n.includes("Resume failed"))).toBe(true);
  });

  test("resumes stopped agent", async () => {
    const agent = makeAgent({ id: "agent-1", state: "stopped" });
    const { ctx, notices } = makeMockCtx({ agent });
    handleResume(ctx);
    await Bun.sleep(10);
    expect(notices.some((n) => n.includes("Resumed") || n.includes("Resume failed"))).toBe(true);
  });

  test("resumes complete agent", async () => {
    const agent = makeAgent({ id: "agent-1", state: "complete" });
    const { ctx, notices } = makeMockCtx({ agent });
    handleResume(ctx);
    await Bun.sleep(10);
    expect(notices.some((n) => n.includes("Resumed") || n.includes("Resume failed"))).toBe(true);
  });

  test("shows immediate 'Resuming…' notice synchronously on press", () => {
    const agent = makeAgent({ id: "agent-1", state: "stopped" });
    const { ctx, notices } = makeMockCtx({ agent });
    handleResume(ctx);
    // The "Resuming…" notice must appear synchronously, before resumeAgent
    // resolves — no await here.
    expect(notices[0]).toBe("Resuming agent-1…");
  });

  // The old in-memory `resumingAgentIds` double-press guard has been removed.
  // Concurrent-press protection is now durable: resumeAgent() takes the
  // cross-process op-guard (acquireAgentOperation, kind `restarting`) and a
  // second concurrent attempt is refused with "Agent is currently restarting…",
  // which handleResume surfaces as "Resume failed: …". That refusal is tested
  // at the resumeAgent level in ib-commands.test.ts; here we only verify the
  // handler still issues a single resume per press and surfaces the result.
  test("each press issues one resume and surfaces its result", async () => {
    const agent = makeAgent({ id: "agent-1", state: "stopped" });
    let resumeAttempts = 0;
    const { ctx, notices } = makeMockCtx({ agent });
    ctx.executeAndRefresh = (fn) => {
      resumeAttempts++;
      void fn();
      return Promise.resolve();
    };
    handleResume(ctx);
    expect(resumeAttempts).toBe(1);
    expect(notices).toContain("Resuming agent-1…");
    await Bun.sleep(10);
  });

  // ── coordinator SPAWN double-press guard (UI-layer, FIX 2) ──────────────────
  //
  // When no coordinator exists yet there is no agent dir / meta.transient.json,
  // so the durable op-guard inside resumeAgent() structurally can't cover the
  // first-time spawn. A small per-repo in-flight set serializes the spawn path
  // so two rapid 'R' presses don't both newAgent() into the same dir.
  describe("coordinator-spawn in-flight guard", () => {
    afterEach(() => {
      clearCoordinatorSpawnsInFlight();
    });

    test("double-press only fires one coordinator spawn", async () => {
      // Non-existent repo path → checkCoordinatorExists() returns exists:false,
      // so handleResume takes the SPAWN branch (the path the durable guard
      // can't cover).
      const repos: RepoEntry[] = [{ path: "/tmp/ib-no-coord-doublepress", name: "my-repo" }];
      const { ctx } = makeMockCtx({ repoHeader: "my-repo", repos });

      // Hold each executeAndRefresh body pending so the in-flight key stays set
      // across the second synchronous press (mirrors the real race: the first
      // press's async spawn hasn't finished when the second press lands).
      let entered = 0;
      const pending: Array<() => Promise<void>> = [];
      ctx.executeAndRefresh = (fn) => {
        entered++;
        pending.push(fn); // capture, do NOT run → key stays held
        return Promise.resolve();
      };

      handleResume(ctx); // first press: takes the in-flight key, queues the spawn
      handleResume(ctx); // second press: blocked synchronously by the in-flight key

      // Only the first press entered the spawn path.
      expect(entered).toBe(1);
      expect(getCoordinatorSpawnsInFlight().has("repo:/tmp/ib-no-coord-doublepress")).toBe(true);
    });

    test("in-flight key is released after the spawn body completes", async () => {
      const repos: RepoEntry[] = [{ path: "/tmp/ib-no-coord-release", name: "my-repo" }];
      const { ctx, flushActions } = makeMockCtx({ repoHeader: "my-repo", repos });

      // The default makeMockCtx executeAndRefresh runs the body to completion
      // (checkCoordinatorExists → exists:false → newAgent stubbed by the noop
      // spawn runner from beforeEach) AND registers the promise so flushActions
      // can await it. Awaiting the real completion is deterministic — the old
      // fixed Bun.sleep(20) raced the spawn body and flaked under CPU load.
      handleResume(ctx);
      await flushActions();

      // finally cleared the key, so the path is open for a subsequent press.
      expect(getCoordinatorSpawnsInFlight().has("repo:/tmp/ib-no-coord-release")).toBe(false);
    });

    test("in-flight key is released even when the spawn body THROWS", async () => {
      const repos: RepoEntry[] = [{ path: "/tmp/ib-no-coord-throw", name: "my-repo" }];
      const { ctx, flushActions } = makeMockCtx({ repoHeader: "my-repo", repos });

      // Force the spawn body to throw: checkCoordinatorExists → exists:false →
      // newAgent rejects because its spawn runner throws. The body's `finally`
      // must still release the in-flight key. The default makeMockCtx
      // executeAndRefresh already swallows the rejection (mirrors the real
      // wrapper) and registers the promise, so flushActions awaits the real
      // completion deterministically instead of racing a fixed Bun.sleep(20).
      setNewAgentSpawnRunner(() => { throw new Error("boom: spawn failed"); });

      handleResume(ctx);
      await flushActions();

      // Despite the throw, the finally released the key — no stuck guard.
      expect(getCoordinatorSpawnsInFlight().has("repo:/tmp/ib-no-coord-throw")).toBe(false);
    });
  });
});

describe("handlePause", () => {
  test("does nothing when no agent selected", () => {
    const { ctx, notices, dialogs } = makeMockCtx({ agent: null });
    handlePause(ctx);
    expect(notices).toHaveLength(0);
    expect(dialogs).toHaveLength(0);
  });

  test("shows notice for stopped agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "stopped" });
    const { ctx, notices } = makeMockCtx({ agent });
    handlePause(ctx);
    expect(notices).toEqual(["Can only pause running, waiting, or complete agents"]);
  });

  test("shows confirm for complete agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "complete" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handlePause(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "confirm");
  });

  test("shows notice for archived agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "running", archived: true });
    const { ctx, notices } = makeMockCtx({ agent });
    handlePause(ctx);
    expect(notices).toEqual(["Can only pause running, waiting, or complete agents"]);
  });

  test("shows confirm for running agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "running" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handlePause(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "confirm");
  });

  test("shows confirm for waiting agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "waiting" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handlePause(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "confirm");
  });
});

describe("handleSend", () => {
  test("does nothing when no agent selected", () => {
    const { ctx, dialogs } = makeMockCtx({ agent: null });
    handleSend(ctx);
    expect(dialogs).toHaveLength(0);
  });

  test("shows textarea dialog", () => {
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handleSend(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "textarea");
  });

  test("onSubmit calls sendMessage", async () => {
    const agent = makeAgent({ id: "agent-1", repoPath: sendRepoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ agent });
    handleSend(ctx);
    const d = assertDialog(dialogs[0]!, "textarea");
    d.onSubmit("Hello agent");
    await flushActions();
    expect(notices.some((n) => n.includes("Sent to agent-1") || n.includes("Send failed"))).toBe(true);
  });

  test("empty message cancels send", () => {
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs, notices } = makeMockCtx({ agent });
    handleSend(ctx);
    const d = assertDialog(dialogs[0]!, "textarea");
    d.onSubmit("   ");
    expect(notices).toEqual(["Send cancelled"]);
  });

  test("shows textarea dialog for per-repo coordinator when repo header selected", () => {
    const coordAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    const { ctx, dialogs } = makeMockCtx({ repoHeader: "my-repo" });
    ctx.rightPane.repoCoordinatorAgent = coordAgent;
    handleSend(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "textarea");
    expect(d.prompt).toContain("coord-1");
  });

  test("per-repo coordinator send calls sendMessage", async () => {
    const coordAgent = makeAgent({ id: "coord-1", repoPath: sendRepoDir, meta: { agentType: "coordinator" } as any });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ repoHeader: "my-repo" });
    ctx.rightPane.repoCoordinatorAgent = coordAgent;
    handleSend(ctx);
    const d = assertDialog(dialogs[0]!, "textarea");
    d.onSubmit("Hello coordinator");
    await flushActions();
    expect(notices.some((n) => n.includes("Sent to coord-1") || n.includes("Send failed"))).toBe(true);
  });

  test("does nothing when repo header selected but no coordinator agent", () => {
    const { ctx, dialogs } = makeMockCtx({ repoHeader: "my-repo" });
    // repoCoordinatorAgent is null by default
    handleSend(ctx);
    expect(dialogs).toHaveLength(0);
  });

  test("shows notice and no dialog when repo coordinator is stopped", () => {
    const coordAgent = makeAgent({ id: "coord-1", state: "stopped", meta: { agentType: "coordinator" } as any });
    const { ctx, dialogs, notices } = makeMockCtx({ repoHeader: "my-repo" });
    ctx.rightPane.repoCoordinatorAgent = coordAgent;
    handleSend(ctx);
    expect(dialogs).toHaveLength(0);
    expect(notices).toEqual(["Coordinator coord-1 is not running"]);
  });
});

describe("handleNewAgent", () => {
  test("no repos shows notice", () => {
    const { ctx, notices } = makeMockCtx({ repos: [] });
    handleNewAgent(ctx);
    expect(notices).toEqual(["No repos registered"]);
  });

  test("single repo shows new-agent-form immediately", () => {
    const repos: RepoEntry[] = [{ path: "/tmp/repo", name: "repo" }];
    const { ctx, dialogs } = makeMockCtx({ repos });
    handleNewAgent(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "new-agent-form");
  });

  test("multiple repos with selected agent infers repo", () => {
    const repos: RepoEntry[] = [{ path: "/tmp/repo1", name: "repo1" }, { path: "/tmp/repo2", name: "repo2" }];
    const agent = makeAgent({ id: "agent-1", repoPath: "/tmp/repo2" });
    const { ctx, dialogs } = makeMockCtx({ agent, repos });
    handleNewAgent(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "new-agent-form");
  });

  test("multiple repos without selection falls back to first repo", () => {
    const repos: RepoEntry[] = [{ path: "/tmp/repo1", name: "repo1" }, { path: "/tmp/repo2", name: "repo2" }];
    const { ctx, dialogs } = makeMockCtx({ repos });
    handleNewAgent(ctx);
    expect(dialogs).toHaveLength(1);
    assertDialog(dialogs[0]!, "new-agent-form");
  });

  test("repo with saved defaultAgentType pre-selects it in dialog", () => {
    const repos: RepoEntry[] = [
      { path: "/tmp/repo", name: "repo", defaultAgentType: "worker" },
    ];
    const { ctx, dialogs } = makeMockCtx({ repos });
    handleNewAgent(ctx);
    const d = assertDialog(dialogs[0]!, "new-agent-form");
    // worker is one of the built-in spawnable types, so it should be valid
    if (d.availableTypes.includes("worker")) {
      expect(d.agentType).toBe("worker");
    }
  });

  test("repo with missing defaultAgentType falls back to manager", () => {
    const repos: RepoEntry[] = [
      { path: "/tmp/repo", name: "repo", defaultAgentType: "this-type-does-not-exist" },
    ];
    const { ctx, dialogs } = makeMockCtx({ repos });
    handleNewAgent(ctx);
    const d = assertDialog(dialogs[0]!, "new-agent-form");
    // "this-type-does-not-exist" is not in availableTypes, so fall back to manager
    expect(d.availableTypes).not.toContain("this-type-does-not-exist");
    if (d.availableTypes.includes("manager")) {
      expect(d.agentType).toBe("manager");
    }
  });

  test("repo without defaultAgentType uses manager fallback", () => {
    const repos: RepoEntry[] = [{ path: "/tmp/repo", name: "repo" }];
    const { ctx, dialogs } = makeMockCtx({ repos });
    handleNewAgent(ctx);
    const d = assertDialog(dialogs[0]!, "new-agent-form");
    if (d.availableTypes.includes("manager")) {
      expect(d.agentType).toBe("manager");
    }
  });
});

describe("handleScrollUp / handleScrollDown", () => {
  test("scrollUp increments scrollOffset and calls tmuxPane.scrollUp", () => {
    const { ctx, scrollUpCalls } = makeMockCtx();
    const before = ctx.rightPane.scrollOffset;
    handleScrollUp(ctx);
    expect(ctx.rightPane.scrollOffset).toBe(before + 10);
    expect(scrollUpCalls).toHaveLength(1);
  });

  test("scrollDown decrements scrollOffset and calls tmuxPane.scrollDown", () => {
    const { ctx, scrollDownCalls } = makeMockCtx();
    ctx.rightPane.scrollOffset = 15;
    handleScrollDown(ctx);
    expect(ctx.rightPane.scrollOffset).toBe(5);
    expect(scrollDownCalls).toHaveLength(1);
  });

  test("scrollDown does not go below 0", () => {
    const { ctx, scrollDownCalls } = makeMockCtx();
    ctx.rightPane.scrollOffset = 3;
    handleScrollDown(ctx);
    expect(ctx.rightPane.scrollOffset).toBe(0);
    expect(scrollDownCalls).toHaveLength(1);
  });

  test("scrollUp triggers loadAgentLogIfNeeded when in AGENT LOG mode", () => {
    const { ctx, loadAgentLogIfNeededCalls } = makeMockCtx({ mode: "AGENT LOG" });
    handleScrollUp(ctx);
    expect(loadAgentLogIfNeededCalls).toHaveLength(1);
  });

  test("scrollDown triggers loadAgentLogIfNeeded when in AGENT LOG mode", () => {
    const { ctx, loadAgentLogIfNeededCalls } = makeMockCtx({ mode: "AGENT LOG" });
    handleScrollDown(ctx);
    expect(loadAgentLogIfNeededCalls).toHaveLength(1);
  });

  test("scrollUp does NOT trigger loadAgentLogIfNeeded when not in AGENT LOG mode", () => {
    const { ctx, loadAgentLogIfNeededCalls } = makeMockCtx({ mode: "DENIALS" });
    handleScrollUp(ctx);
    expect(loadAgentLogIfNeededCalls).toHaveLength(0);
  });
});

describe("handleHelp", () => {
  test("shows help dialog", () => {
    const { ctx, dialogs } = makeMockCtx();
    handleHelp(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "help");
    expect(d.lines.length).toBeGreaterThan(5);
  });

  test("help legend lists the N nickname action", () => {
    const { ctx, dialogs } = makeMockCtx();
    handleHelp(ctx);
    const d = assertDialog(dialogs[0]!, "help");
    const text = d.lines.join("\n");
    expect(text).toContain("nickname agent");
  });
});

describe("handleFuzzyAgent nickname search", () => {
  test("includes the agent's nickname in the searchable item string", () => {
    const agent = makeAgent({ id: "agent-fuzz1" });
    agent.meta.nickname = "pikachu";
    const { ctx, dialogs } = makeMockCtx({ flatList: [makeFlatAgent(agent)] });
    handleFuzzyAgent(ctx);
    const d = assertDialog(dialogs[0]!, "fuzzy");
    // The item that contains the agent id should also contain the nickname so
    // `@` can jump by nickname.
    const item = d.allItems.find((s) => s.includes("agent-fuzz1"));
    expect(item).toBeDefined();
    expect(item!).toContain("pikachu");
  });

  test("agents without a nickname still appear (no extra token)", () => {
    const agent = makeAgent({ id: "agent-fuzz2" });
    const { ctx, dialogs } = makeMockCtx({ flatList: [makeFlatAgent(agent)] });
    handleFuzzyAgent(ctx);
    const d = assertDialog(dialogs[0]!, "fuzzy");
    expect(d.allItems.some((s) => s.includes("agent-fuzz2"))).toBe(true);
  });
});

describe("handleRename", () => {
  test("does nothing when no agent selected", () => {
    const { ctx, dialogs } = makeMockCtx({ agent: null });
    handleRename(ctx);
    expect(dialogs).toHaveLength(0);
  });

  test("opens an input dialog pre-filled with the current nickname", () => {
    const agent = makeAgent({ id: "agent-ren1" });
    agent.meta.nickname = "pikachu";
    const { ctx, dialogs } = makeMockCtx({ agent });
    handleRename(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    expect(d.value).toBe("pikachu");
    expect(d.prompt).toContain("agent-ren1");
  });

  test("pre-fills EMPTY when no nickname is set (Enter-unchanged is a no-op clear, not nickname==id)", () => {
    const agent = makeAgent({ id: "agent-ren2" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handleRename(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    expect(d.value).toBe("");
  });
});

describe("handleResizeLeft", () => {
  test("increases width by delta", () => {
    const { ctx } = makeMockCtx({ leftWidth: 60 });
    handleResizeLeft(ctx, 5);
    expect(ctx.splitPane.getLeftWidth()).toBe(65);
  });

  test("decreases width by delta", () => {
    const { ctx } = makeMockCtx({ leftWidth: 60 });
    handleResizeLeft(ctx, -5);
    expect(ctx.splitPane.getLeftWidth()).toBe(55);
  });

  test("clamps to MIN_LEFT_WIDTH", () => {
    const { ctx } = makeMockCtx({ leftWidth: MIN_LEFT_WIDTH + 2 });
    handleResizeLeft(ctx, -10);
    expect(ctx.splitPane.getLeftWidth()).toBe(MIN_LEFT_WIDTH);
  });

  test("clamps to MAX_LEFT_WIDTH", () => {
    const { ctx } = makeMockCtx({ leftWidth: MAX_LEFT_WIDTH - 2 });
    handleResizeLeft(ctx, 10);
    expect(ctx.splitPane.getLeftWidth()).toBe(MAX_LEFT_WIDTH);
  });

  test("no-op when already at limit", () => {
    const { ctx } = makeMockCtx({ leftWidth: MIN_LEFT_WIDTH });
    handleResizeLeft(ctx, -5);
    // Width unchanged
    expect(ctx.splitPane.getLeftWidth()).toBe(MIN_LEFT_WIDTH);
  });
});

describe("handleOpenDiffTool", () => {
  afterEach(() => {
    setActiveDiffProc(null);
    setDiffToolLaunching(false);
  });

  test("bails out with notice when diff tool is already launching", async () => {
    setDiffToolLaunching(true);
    const agent = makeAgent({ id: "test-agent" });
    const { ctx, notices } = makeMockCtx({ agent });
    ctx.diffTool = "some-tool";
    await handleOpenDiffTool(ctx);
    expect(notices).toContain("Diff tool is already launching");
    // Flag should still be true — the function bailed without clearing it
    expect(getDiffToolLaunching()).toBe(true);
  });

  test("kills previous diff process before launching new one", async () => {
    let killed = false;
    const fakeProc = {
      kill: () => { killed = true; },
      exited: new Promise<number>(() => {}), // never resolves
      stdout: new Response("").body!,
      stderr: new Response("").body!,
    } as unknown as ReturnType<typeof Bun.spawn>;

    setActiveDiffProc({ proc: fakeProc, agentId: "old-agent" });

    // Call with no agent selected — will bail early after killing previous proc
    const { ctx, notices } = makeMockCtx();
    await handleOpenDiffTool(ctx);

    expect(killed).toBe(true);
    expect(getActiveDiffProc()).toBeNull();
    expect(notices).toContain("No agent selected");
  });

  test("shows notice when no agent is selected", async () => {
    const { ctx, notices } = makeMockCtx();
    await handleOpenDiffTool(ctx);
    expect(notices).toContain("No agent selected");
  });

  test("shows notice when no diff tool configured", async () => {
    const agent = makeAgent({ id: "test-agent" });
    const { ctx, notices } = makeMockCtx({ agent });
    ctx.diffTool = undefined;
    await handleOpenDiffTool(ctx);
    expect(notices).toContain("No diff tool configured — set externalDiffTool in ~/.itsybitsy/config.json");
  });
});

describe("killActiveDiffProc", () => {
  afterEach(() => {
    setActiveDiffProc(null);
  });

  test("kills active diff process and clears state", () => {
    let killed = false;
    const fakeProc = {
      kill: () => { killed = true; },
      exited: new Promise<number>(() => {}),
      stderr: new Response("").body!,
    } as unknown as ReturnType<typeof Bun.spawn>;
    setActiveDiffProc({ proc: fakeProc, agentId: "test-agent" });

    killActiveDiffProc();

    expect(killed).toBe(true);
    expect(getActiveDiffProc()).toBeNull();
  });

  test("is a no-op when no diff process is active", () => {
    setActiveDiffProc(null);
    killActiveDiffProc(); // should not throw
    expect(getActiveDiffProc()).toBeNull();
  });
});

describe("agentSettingsLocalPath", () => {
  test("non-coordinator uses <agentDir>/repo/.claude/settings.local.json", () => {
    const agent = makeAgent({ id: "agent-1", repoPath: "/tmp/myrepo" });
    expect(agentSettingsLocalPath(agent)).toBe(
      "/tmp/myrepo/.ittybitty/agents/agent-1/repo/.claude/settings.local.json",
    );
  });

  test("coordinator uses <agentDir>/.claude/settings.local.json", () => {
    const agent = makeAgent({
      id: "coord-1",
      repoPath: "/tmp/myrepo",
      meta: { agentType: "coordinator" } as any,
    });
    expect(agentSettingsLocalPath(agent)).toBe(
      "/tmp/myrepo/.ittybitty/agents/coord-1/.claude/settings.local.json",
    );
  });

  test("archived non-coordinator uses archive/<id>/repo", () => {
    const agent = makeAgent({ id: "agent-1", repoPath: "/tmp/myrepo", archived: true });
    expect(agentSettingsLocalPath(agent)).toBe(
      "/tmp/myrepo/.ittybitty/archive/agent-1/repo/.claude/settings.local.json",
    );
  });
});

describe("addPermissionToSettings", () => {
  const tmpDir = `/tmp/ib-perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  afterEach(async () => {
    await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow();
  });

  test("creates missing file and appends entry", async () => {
    const p = `${tmpDir}/settings.local.json`;
    const result = await addPermissionToSettings(p, "Bash(git status:*)");
    expect(result).toEqual({ added: true });
    const contents = await Bun.file(p).json();
    expect(contents.permissions.allow).toEqual(["Bash(git status:*)"]);
    expect(contents.permissions.deny).toEqual([]);
  });

  test("appends to existing allow list and preserves deny + other keys", async () => {
    const p = `${tmpDir}/settings.local.json`;
    await Bun.write(p, JSON.stringify({
      extra: "keep-me",
      permissions: {
        allow: ["Bash(ib:*)"],
        deny: ["Bash(rm:*)"],
      },
    }, null, 2));
    const result = await addPermissionToSettings(p, "Bash(git status:*)");
    expect(result).toEqual({ added: true });
    const contents = await Bun.file(p).json();
    expect(contents.extra).toBe("keep-me");
    expect(contents.permissions.allow).toEqual(["Bash(ib:*)", "Bash(git status:*)"]);
    expect(contents.permissions.deny).toEqual(["Bash(rm:*)"]);
  });

  test("duplicate entry is not written twice", async () => {
    const p = `${tmpDir}/settings.local.json`;
    await addPermissionToSettings(p, "Bash(git status:*)");
    const secondResult = await addPermissionToSettings(p, "Bash(git status:*)");
    expect(secondResult).toEqual({ added: false, reason: "duplicate" });
    const contents = await Bun.file(p).json();
    expect(contents.permissions.allow).toEqual(["Bash(git status:*)"]);
  });

  test("malformed JSON returns error and does not overwrite", async () => {
    const p = `${tmpDir}/settings.local.json`;
    await Bun.write(p, "{ not json");
    const result = await addPermissionToSettings(p, "Bash(git status:*)");
    expect(result.added).toBe(false);
    if (!result.added) expect(result.reason).toBe("error");
    // Original file content is preserved
    const raw = await Bun.file(p).text();
    expect(raw).toBe("{ not json");
  });

  test("handles file with no permissions key", async () => {
    const p = `${tmpDir}/settings.local.json`;
    await Bun.write(p, JSON.stringify({ other: "value" }, null, 2));
    const result = await addPermissionToSettings(p, "Bash(git status:*)");
    expect(result).toEqual({ added: true });
    const contents = await Bun.file(p).json();
    expect(contents.other).toBe("value");
    expect(contents.permissions.allow).toEqual(["Bash(git status:*)"]);
  });
});

describe("handleAddPermission", () => {
  test("does nothing when no agent selected and no repo header", () => {
    const { ctx, dialogs, notices } = makeMockCtx({ agent: null });
    handleAddPermission(ctx);
    expect(dialogs).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  test("skipped when system coordinator selected", () => {
    const { ctx, dialogs } = makeMockCtx({ agent: null });
    ctx.agentTree.isSystemCoordinatorSelected = true;
    handleAddPermission(ctx);
    expect(dialogs).toHaveLength(0);
  });

  test("shows input dialog for selected agent", () => {
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handleAddPermission(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "input");
    expect(d.prompt).toContain("agent-1");
  });

  test("archived agent gets notice", () => {
    const agent = makeAgent({ id: "agent-1", archived: true });
    const { ctx, notices, dialogs } = makeMockCtx({ agent });
    handleAddPermission(ctx);
    expect(dialogs).toHaveLength(0);
    expect(notices).toEqual(["Cannot modify archived agent"]);
  });

  test("repo header without coordinator shows notice", () => {
    const { ctx, notices, dialogs } = makeMockCtx({ repoHeader: "my-repo" });
    handleAddPermission(ctx);
    expect(dialogs).toHaveLength(0);
    expect(notices).toEqual(["No coordinator for this repo"]);
  });

  test("repo header with coordinator routes to coordinator", () => {
    const coordAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    const { ctx, dialogs } = makeMockCtx({ repoHeader: "my-repo" });
    ctx.rightPane.repoCoordinatorAgent = coordAgent;
    handleAddPermission(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "input");
    expect(d.prompt).toContain("coord-1");
  });

  test("empty submit cancels", () => {
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs, notices } = makeMockCtx({ agent });
    handleAddPermission(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    d.onSubmit("   ");
    expect(notices).toEqual(["Permission add cancelled"]);
  });

  test("invalid characters rejected", () => {
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs, notices } = makeMockCtx({ agent });
    handleAddPermission(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    d.onSubmit("Bash(foo; rm -rf /)");
    expect(notices.some((n) => n.includes("Invalid permission"))).toBe(true);
  });
});
