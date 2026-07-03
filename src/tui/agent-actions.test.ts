import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { makeAgent, makeFlatAgent, makeFlatRepoHeader, makeSpawnResult } from "../test-utils";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import type { RepoEntry } from "../registry";
import type { ActionCtx } from "./agent-actions";
import type { DialogState } from "./dialog-handler";
import type { PaneMode } from "./pane-manager";
import { assertDialog } from "./test-helpers";
import {
  handleRetire, handleNuke, handleNukeAll, handleResume, handlePause,
  handleSend, handleNewAgent, handleScrollUp, handleScrollDown,
  handleHelp, handleResizeLeft, handleFuzzyAgent, handleRename,
  handleSnapshot,
  handleOpenDiffTool, getActiveDiffProc, setActiveDiffProc, killActiveDiffProc,
  getDiffToolLaunching, setDiffToolLaunching,
  handleAddPermission, addPermissionToSettings, agentSettingsLocalPath,
  getCoordinatorSpawnsInFlight, clearCoordinatorSpawnsInFlight,
  handleCreateTeam, handleAddAgentToTeam, handleDisbandTeam, handleManageTeam,
  handleFolderBrowser,
} from "./agent-actions";
import { setCoordinatorHome, resetCoordinatorHome } from "../coordinator";
import { readTeams, createTeam, addMember, deleteTeam } from "../teams";
import { teamLogPath, channelPath, appendChannelMessage, appendTeamLog } from "../team-channel";
import { existsSync } from "node:fs";
import { saveRegistry, loadRegistry } from "../registry";
import {
  writeAgentTransient,
  isPidAliveCtx,
  resetReadAgentMetaCache,
} from "../agents";
import { setUserConfigPath, resetUserConfigPath } from "../config";
import { mkdir } from "fs/promises";
import { basename } from "path";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";
import {
  setKillPauseSpawnRunner, resetKillPauseSpawnRunner,
  setNukeResumeSpawnRunner, resetNukeResumeSpawnRunner,
  setSendSpawnRunner, resetSendSpawnRunner,
  setNewAgentSpawnRunner, resetNewAgentSpawnRunner,
} from "../ib-commands";
import { spawnCtx as lifecycleSpawnCtx } from "../agent-lifecycle";
import { spawnCtx as tmuxSpawnCtx } from "../tmux-poller";
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
  /** §17: focused panel — defaults to "agent-tree". */
  focus?: import("./focus").FocusTarget;
  /** §17.1 Phase 1: sidebar mode — defaults to "agents". */
  sidebarMode?: import("./sidebar").SidebarMode;
  /** §17.1 Phase 2: active selection source — defaults to "agents". */
  activeSelectionSource?: import("./sidebar").SidebarMode;
  /** §17: teams-tree selection — defaults to null. */
  teamsSelection?: import("./selection").Selection;
  /** §17: teamSend stub override. */
  teamSend?: ActionCtx["teamSend"];
  /** §17.3 manage-team: lastAgents on the watcher handle, used by handlers
   *  that look up live Agent records by id (e.g. handleManageTeam for the
   *  <repo>/<id> member labels). Defaults to []. */
  lastAgents?: Agent[];
}): {
  ctx: ActionCtx;
  dialogs: NonNullable<DialogState>[];
  notices: string[];
  refreshCalls: number[];
  scrollUpCalls: number[];
  scrollDownCalls: number[];
  loadAgentLogIfNeededCalls: number[];
  /** §17: focus targets passed to focusManager.setFocus, in order. */
  setFocusCalls: import("./focus").FocusTarget[];
  /** §17: teamSend invocations the handler made. */
  teamSendCalls: Array<{ teamName: string; members: Agent[]; message: string; fromAgent: string | undefined }>;
  /** §17.1 Phase 2: activeSelectionSource values passed to the ctx setter. */
  setActiveSelectionSourceCalls: import("./sidebar").SidebarMode[];
  /** §17.1 Phase 2: sidebarMode values passed to the ctx setter. */
  setSidebarModeCalls: import("./sidebar").SidebarMode[];
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
  const setFocusCalls: import("./focus").FocusTarget[] = [];
  const teamSendCalls: Array<{ teamName: string; members: Agent[]; message: string; fromAgent: string | undefined }> = [];
  const setActiveSelectionSourceCalls: import("./sidebar").SidebarMode[] = [];
  const setSidebarModeCalls: import("./sidebar").SidebarMode[] = [];
  let currentFocus: import("./focus").FocusTarget = overrides?.focus ?? "agent-tree";
  let currentSidebarMode: import("./sidebar").SidebarMode = overrides?.sidebarMode ?? "agents";
  let currentActiveSelectionSource: import("./sidebar").SidebarMode =
    overrides?.activeSelectionSource ?? "agents";
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
    // §17 ActionCtx additions: a focus handle, a teams-tree selection handle,
    // and a teamSend ctx field. Defaults: focus on agent-tree, no teams
    // selection, teamSend stub that returns OK.
    focusManager: {
      current: () => currentFocus,
      setFocus: (t) => { setFocusCalls.push(t); currentFocus = t; },
    },
    get sidebarMode() { return currentSidebarMode; },
    get activeSelectionSource() { return currentActiveSelectionSource; },
    setActiveSelectionSource: (source) => {
      setActiveSelectionSourceCalls.push(source);
      currentActiveSelectionSource = source;
    },
    setSidebarMode: (mode) => {
      setSidebarModeCalls.push(mode);
      currentSidebarMode = mode;
    },
    teamsTree: {
      selection: overrides?.teamsSelection ?? null,
    },
    teamSend: overrides?.teamSend
      ?? (async (teamName, members, message, opts) => {
        teamSendCalls.push({ teamName, members, message, fromAgent: opts?.fromAgent });
        return { ok: true, stdout: `sent to @${teamName}`, stderr: "", exitCode: 0 };
      }),
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
    channelPane: {
      scrollUp: () => {},
      scrollDown: () => {},
    },
    teamLogPane: {
      scrollUp: () => {},
      scrollDown: () => {},
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
    watcher: { refresh: () => refreshCalls.push(1), updateRepos: () => {}, recheckHealth: () => {}, lastAgents: overrides?.lastAgents ?? [] },
    diffTool: undefined,
    pendingSelectNewestInRepo: null,
    showDialog: (d: NonNullable<DialogState>) => { dialogs.push(d); },
    closeDialog: () => {},
    setNotice: (text: string, _kind: "info" | "error") => { notices.push(text); },
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
    getSnapshotPaneWidth: () => leftWidth,
  };
  const flushActions = async () => { await Promise.all(pendingActions); };
  return { ctx, dialogs, notices, refreshCalls, scrollUpCalls, scrollDownCalls, loadAgentLogIfNeededCalls, setFocusCalls, teamSendCalls, setActiveSelectionSourceCalls, setSidebarModeCalls, flushActions };
}

// Per-test isolated repo root + coordinator home. sendMessage now writes a
// real outbox.jsonl + .outbox.lock under the CENTRAL outbox dir
// (`agentOutboxDir(id)` → `<coordinatorHome>/agents/<id>/`), so send-path
// tests MUST pin both: a fresh repoPath (the agent's worktree, used for
// log/state writes) AND a fresh coordinator home (so the central queue dir
// resolves into the sandbox instead of the developer's real ~/.itsybitsy/).
// Without coordinator-home isolation, a queued message from one test can
// drain inline in the NEXT test (sendMessage has no live watchdog in this
// suite), inflating call counts and corrupting target-id assertions.
let sendRepoDir: string;

beforeEach(async () => {
  setKillPauseSpawnRunner(noopSpawnRunner);
  setNukeResumeSpawnRunner(noopSpawnRunner);
  setSendSpawnRunner(noopSpawnRunner);
  setNewAgentSpawnRunner(noopSpawnRunner);
  lifecycleSpawnCtx.set(noopSpawnRunner);
  sendRepoDir = await mkdtemp(join(tmpdir(), "agent-actions-send-"));
  const { setCoordinatorHome } = await import("../coordinator");
  setCoordinatorHome(join(sendRepoDir, "coord-home"));
});

afterEach(async () => {
  resetKillPauseSpawnRunner();
  resetNukeResumeSpawnRunner();
  resetSendSpawnRunner();
  resetNewAgentSpawnRunner();
  lifecycleSpawnCtx.reset();
  tmuxSpawnCtx.reset();
  const { resetCoordinatorHome } = await import("../coordinator");
  resetCoordinatorHome();
  await rm(sendRepoDir, { recursive: true, force: true });
});

describe("handleSnapshot", () => {
  test("saves unwrapped + wrapped snapshots and note to per-agent debug logs and ~/.itsybitsy/snapshots", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "agent-actions-snapshot-"));
    const repoDir = join(baseDir, "repo");
    const homeDir = join(baseDir, "home");
    await mkdir(repoDir, { recursive: true });
    await mkdir(join(homeDir, ".itsybitsy"), { recursive: true });
    setUserConfigPath(join(homeDir, ".itsybitsy", "config.json"));

    try {
      tmuxSpawnCtx.set(() => makeSpawnResult(
        0,
        "› check snapshot mirror\n\n  gpt-5.5 default · /repo\n",
      ));
      const agent = makeAgent({ id: "agent-snap", repoPath: repoDir });
      agent.meta.model = "codex:gpt-5.5";
      agent.meta.tmux_session = "tmux-agent-snap";
      // leftWidth=40 → getSnapshotPaneWidth() returns 40, so the wrapped file
      // uses that width in its header.
      const { ctx, dialogs, notices, flushActions } = makeMockCtx({ agent, leftWidth: 40 });

      handleSnapshot(ctx);
      await Bun.sleep(20);

      expect(dialogs).toHaveLength(1);
      expect(notices.at(-1)).toContain("Snapshot saved:");

      const debugDir = join(repoDir, ".ittybitty", "agents", "agent-snap", "debug-logs");
      const debugFiles = await readdir(debugDir);
      const unwrappedName = debugFiles.find((name) => /^snapshot-.*-waiting-unwrapped\.txt$/.test(name));
      const wrappedName = debugFiles.find((name) => /^snapshot-.*-waiting-wrapped\.txt$/.test(name));
      expect(unwrappedName).toBeDefined();
      expect(wrappedName).toBeDefined();

      const snapshotsDir = join(homeDir, ".itsybitsy", "snapshots");
      const mirrorFiles = await readdir(snapshotsDir);
      const mirrorUnwrappedName = mirrorFiles.find((name) => /^agent-snap-snapshot-.*-waiting-unwrapped\.txt$/.test(name));
      const mirrorWrappedName = mirrorFiles.find((name) => /^agent-snap-snapshot-.*-waiting-wrapped\.txt$/.test(name));
      expect(mirrorUnwrappedName).toBeDefined();
      expect(mirrorWrappedName).toBeDefined();

      const unwrappedText = await Bun.file(join(debugDir, unwrappedName!)).text();
      const wrappedText = await Bun.file(join(debugDir, wrappedName!)).text();
      const mirrorUnwrappedText = await Bun.file(join(snapshotsDir, mirrorUnwrappedName!)).text();
      const mirrorWrappedText = await Bun.file(join(snapshotsDir, mirrorWrappedName!)).text();

      // Debug + mirror copies are byte-identical.
      expect(mirrorUnwrappedText).toBe(unwrappedText);
      expect(mirrorWrappedText).toBe(wrappedText);

      // Both carry the State/Reason header; the wrapped copy notes the pane width.
      expect(unwrappedText).toContain("State: waiting");
      expect(unwrappedText).toContain("check snapshot mirror");
      expect(wrappedText).toContain("State: waiting");
      expect(wrappedText).toContain("Pane width: 40");
      expect(wrappedText).toContain("check snapshot mirror");
      // The unwrapped copy must NOT carry the "Pane width:" line — it's the
      // logical (state-detection) view, not the on-screen view.
      expect(unwrappedText).not.toContain("Pane width:");

      const dialog = assertDialog(dialogs[0]!, "textarea");
      dialog.onSubmit("remember this capture");
      await flushActions();

      // The note base name is the shared prefix (no -unwrapped/-wrapped suffix).
      const baseName = unwrappedName!.replace(/-unwrapped\.txt$/, "");
      const noteText = await Bun.file(join(debugDir, `${baseName}-note.txt`)).text();
      const mirrorNoteText = await Bun.file(join(snapshotsDir, `agent-snap-${baseName}-note.txt`)).text();
      expect(noteText).toBe("remember this capture\n");
      expect(mirrorNoteText).toBe(noteText);
    } finally {
      resetUserConfigPath();
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("handleRetire", () => {
  test("does nothing when no agent selected", () => {
    const { ctx, dialogs } = makeMockCtx({ agent: null });
    handleRetire(ctx);
    expect(dialogs).toHaveLength(0);
  });

  test("shows confirm dialog", () => {
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs } = makeMockCtx({ agent });
    handleRetire(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "confirm");
    expect(d.prompt).toContain("agent-1");
    expect(d.confirmLabel).toBe("Retire");
  });

  test("onYes calls executeAndRefresh with retireAgent", async () => {
    const agent = makeAgent({ id: "agent-1" });
    let executeCalled = false;
    const { ctx, dialogs } = makeMockCtx({ agent });
    ctx.executeAndRefresh = async (fn) => { executeCalled = true; };
    handleRetire(ctx);
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

describe("handleSend — §17.3a team-target branch", () => {
  // §17.1 Phase 2: the team-target branch keys off
  // `activeSelectionSource === "teams"` (the Teams tree OWNS the global
  // selection), not sidebarMode. These tests pass BOTH
  // `sidebarMode: "teams"` AND `activeSelectionSource: "teams"` because the
  // user's "select-then-send" flow puts the Teams tree both visible AND
  // active — that's the only state where `s` should hit the team fan-out.
  test("teams active source + team selection opens an @<team> dialog (no agent dialog)", () => {
    const { ctx, dialogs } = makeMockCtx({
      sidebarMode: "teams",
      activeSelectionSource: "teams",
      teamsSelection: { kind: "team", teamName: "backend" },
    });
    handleSend(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "textarea");
    expect(d.prompt).toContain("@backend");
    // Team send dialog must NOT show a "send to all" toggle (a team send
    // already fans out). The textarea dialog has no sendAll field for team
    // sends — only the agent-send branch sets that.
    expect(("sendAll" in d) ? d.sendAll : undefined).toBeUndefined();
  });

  test("onSubmit routes through ctx.teamSend (not sendMessage)", async () => {
    const { ctx, dialogs, teamSendCalls, flushActions } = makeMockCtx({
      sidebarMode: "teams",
      activeSelectionSource: "teams",
      teamsSelection: { kind: "team", teamName: "backend" },
    });
    handleSend(ctx);
    const d = assertDialog(dialogs[0]!, "textarea");
    d.onSubmit("standup time");
    await flushActions();
    expect(teamSendCalls).toHaveLength(1);
    expect(teamSendCalls[0]!.teamName).toBe("backend");
    expect(teamSendCalls[0]!.message).toBe("standup time");
    // fromAgent is undefined: the dashboard `s`-send is a CLI/human send;
    // teamSend will tag it with user.name (or fall back to "user") itself.
    expect(teamSendCalls[0]!.fromAgent).toBeUndefined();
  });

  test("team-member (kind:agent) selection from Teams panel is NOT a team-target — falls through to agent send", () => {
    // §17.3 child-agent-indistinguishable: selecting a member row in the
    // Teams panel must behave like selecting that agent in the Agents panel.
    const agent = makeAgent({ id: "agent-a" });
    const { ctx, dialogs, teamSendCalls } = makeMockCtx({
      sidebarMode: "teams",
      activeSelectionSource: "teams",
      teamsSelection: { kind: "agent", agent },
    });
    handleSend(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "textarea");
    // Point-to-point dialog prompts for the agent, not the team
    expect(d.prompt).toContain("agent-a");
    expect(d.prompt).not.toContain("@");
    // And teamSend is NOT called
    expect(teamSendCalls).toHaveLength(0);
  });

  test("empty message cancels the team send", async () => {
    const { ctx, dialogs, notices, teamSendCalls, flushActions } = makeMockCtx({
      sidebarMode: "teams",
      activeSelectionSource: "teams",
      teamsSelection: { kind: "team", teamName: "backend" },
    });
    handleSend(ctx);
    const d = assertDialog(dialogs[0]!, "textarea");
    d.onSubmit("   ");
    await flushActions();
    expect(teamSendCalls).toHaveLength(0);
    expect(notices.some((n) => n.includes("Send cancelled"))).toBe(true);
  });

  test("Phase 2: team selected but Agents tree is the active source — `s` does NOT fan out to the team", () => {
    // §17.1 Phase 2: after the user has navigated to a team but then flipped
    // back to the Agents tree (sidebarMode flip + j to select an agent), the
    // active selection lives in the Agents tree. Even though the Teams tree
    // still has a team selected, `s` must NOT open the team dialog — it
    // should drive whatever the Agents tree's selection is.
    const agent = makeAgent({ id: "agent-active" });
    const { ctx, dialogs, teamSendCalls } = makeMockCtx({
      agent,
      sidebarMode: "agents",
      activeSelectionSource: "agents",
      // Teams tree still holds a team selection that pre-dated the flip.
      teamsSelection: { kind: "team", teamName: "backend" },
    });
    handleSend(ctx);
    // The team fan-out branch must NOT have fired.
    expect(teamSendCalls).toHaveLength(0);
    // We expect the agent point-to-point send dialog instead.
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "textarea");
    expect(d.prompt).toContain("agent-active");
    expect(d.prompt).not.toContain("@backend");
  });
});

describe("handleFuzzyAgent — §17.3 @-jump force-select in Agents panel", () => {
  test("selecting an agent ALWAYS calls focusManager.setFocus('agent-tree') first", () => {
    const agent = makeAgent({ id: "agent-x" });
    const { ctx, dialogs, setFocusCalls } = makeMockCtx({
      focus: "teams-tree", // user is on the Teams panel
      flatList: [makeFlatAgent(agent)],
    });
    handleFuzzyAgent(ctx);
    const d = assertDialog(dialogs[0]!, "fuzzy");
    // The single agent entry — fuzzy lists put repo headers first, agents after.
    // Our flatList has just an agent so originalIndex 0 selects it.
    d.onSelect(0);
    expect(setFocusCalls[0]).toBe("agent-tree");
  });

  test("selecting a repo also force-focuses to agent-tree", () => {
    const { ctx, dialogs, setFocusCalls } = makeMockCtx({
      focus: "teams-tree",
      flatList: [makeFlatRepoHeader("/tmp/some/repo")],
    });
    handleFuzzyAgent(ctx);
    const d = assertDialog(dialogs[0]!, "fuzzy");
    d.onSelect(0);
    expect(setFocusCalls[0]).toBe("agent-tree");
  });

  test("§17.1 Phase 2: @-jump flips sidebarMode AND activeSelectionSource to 'agents'", () => {
    const agent = makeAgent({ id: "agent-jumped" });
    // User is on the Teams panel with the Teams tree active — the @-jump
    // must yank both axes back to Agents so the jumped-to agent is the
    // visible, active selection.
    const { ctx, dialogs, setSidebarModeCalls, setActiveSelectionSourceCalls } = makeMockCtx({
      sidebarMode: "teams",
      activeSelectionSource: "teams",
      flatList: [makeFlatAgent(agent)],
    });
    handleFuzzyAgent(ctx);
    const d = assertDialog(dialogs[0]!, "fuzzy");
    d.onSelect(0);
    expect(setSidebarModeCalls).toEqual(["agents"]);
    expect(setActiveSelectionSourceCalls).toEqual(["agents"]);
  });
});

describe("handleScrollUp/Down — §17.4 channel pane scrolls alongside", () => {
  test("scrollUp also scrolls the channel pane", () => {
    let chScrollUp = 0;
    const { ctx } = makeMockCtx();
    ctx.channelPane.scrollUp = () => { chScrollUp++; };
    handleScrollUp(ctx);
    expect(chScrollUp).toBe(1);
  });

  test("scrollDown also scrolls the channel pane", () => {
    let chScrollDown = 0;
    const { ctx } = makeMockCtx();
    ctx.channelPane.scrollDown = () => { chScrollDown++; };
    handleScrollDown(ctx);
    expect(chScrollDown).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Teams handlers — Change 3: 'T' creates a team, 't' adds selected agent to a
// team. Both handlers now route through `teamCreate` / `teamAdd` from
// ib-commands so the audit log (appendTeamLog → channelPath) and the join-
// notice fan-out (fireJoinNotice) run in the TUI path exactly as they do for
// the CLI. The fixtures isolate HOME + coordinator home, register a real repo,
// and plant the selected agent on disk so `teamAdd`'s resolver finds it.
// ---------------------------------------------------------------------------

/** Read the team's audit log (the `<team>.log` file appendTeamLog writes to). */
async function readTeamAuditLog(team: string): Promise<string> {
  try {
    return await Bun.file(teamLogPath(team)).text();
  } catch {
    return "";
  }
}

/**
 * Plant a real agent meta.json + a live-watchdog transient under
 * `<repoDir>/.ittybitty/agents/<id>/`. The transient makes sendMessage DEFER
 * delivery so we don't shell out from tests; the meta is enough for
 * readAllAgents (which teamAdd uses) to surface the id.
 */
async function plantTestAgent(repoDir: string, id: string): Promise<string> {
  const agentDir = join(repoDir, ".ittybitty", "agents", id);
  await mkdir(agentDir, { recursive: true });
  await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id, tmux_session: `t-${id}` }));
  await writeAgentTransient(agentDir, {
    tmux_compacting: false,
    tmux_rate_limited: false,
    tmux_api_error: false, tmux_api_terms: false,
    has_background_tasks: false,
    updated_at_ms: Date.now(),
    watchdog_pid: 4242,
  });
  return agentDir;
}

async function setupTeamsFixture(): Promise<{
  baseDir: string;
  homeDir: string;
  repoDir: string;
  repoEntry: RepoEntry;
  originalHome: string | undefined;
}> {
  const baseDir = await mkdtemp(join(tmpdir(), "agent-actions-teams-" + crypto.randomUUID() + "-"));
  const homeDir = join(baseDir, ".itsybitsy");
  const repoDir = join(baseDir, "repo");
  await mkdir(homeDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = baseDir;
  setCoordinatorHome(homeDir);
  setUserConfigPath(join(homeDir, "config.json"));
  const repoEntry: RepoEntry = { path: repoDir, name: basename(repoDir) };
  await saveRegistry({ repos: [repoEntry] });
  setSendSpawnRunner(() => makeSpawnResult());
  isPidAliveCtx.set(() => true);
  resetReadAgentMetaCache();
  return { baseDir, homeDir, repoDir, repoEntry, originalHome };
}

async function teardownTeamsFixture(fx: {
  baseDir: string;
  originalHome: string | undefined;
}): Promise<void> {
  resetSendSpawnRunner();
  resetUserConfigPath();
  resetCoordinatorHome();
  isPidAliveCtx.reset();
  if (fx.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = fx.originalHome;
  resetReadAgentMetaCache();
  await rm(fx.baseDir, { recursive: true, force: true });
}

describe("handleCreateTeam", () => {
  let fx: Awaited<ReturnType<typeof setupTeamsFixture>>;

  beforeEach(async () => { fx = await setupTeamsFixture(); });
  afterEach(async () => { await teardownTeamsFixture(fx); });

  test("opens an empty input dialog labeled 'Team name:'", () => {
    const { ctx, dialogs } = makeMockCtx({ repos: [fx.repoEntry] });
    handleCreateTeam(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    expect(d.value).toBe("");
    expect(d.prompt).toBe("Team name:");
  });

  test("happy path: a valid name creates a team, drives the wizard to completion, AND writes the audit-log entry the CLI would", async () => {
    // With no live agents the wizard skips the member picker and goes straight
    // to the first-message textarea; an empty submit ends the wizard cleanly.
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleCreateTeam(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    d.onSubmit("backend");
    await flushActions();
    const ta = assertDialog(dialogs[1]!, "textarea");
    ta.onSubmit("");
    await flushActions();
    const reg = await readTeams();
    expect(reg.teams["backend"]).toBeDefined();
    expect(notices.some((n) => n.includes("created team @backend"))).toBe(true);
    // Audit log written via teamCreate → appendTeamLog. The audit log carries
    // "team created by …" — present here means the TUI path runs the same
    // audit as the CLI does (Reviewer Issue A).
    const audit = await readTeamAuditLog("backend");
    expect(audit).toContain("team created by");
  });

  test("invalid name: surfaces teamCreate's error verbatim and does not create the team", async () => {
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleCreateTeam(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    d.onSubmit("has spaces");
    await flushActions();
    const reg = await readTeams();
    expect(Object.keys(reg.teams)).toHaveLength(0);
    // teamCreate's error string: 'Error: invalid team name "has spaces" — …'
    expect(notices.some((n) => n.toLowerCase().includes("invalid team name"))).toBe(true);
  });

  test("empty submission is a silent no-op (no team, no notice)", async () => {
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleCreateTeam(ctx);
    const d = assertDialog(dialogs[0]!, "input");
    d.onSubmit("   ");
    await flushActions();
    const reg = await readTeams();
    expect(Object.keys(reg.teams)).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  // ─── Wizard: 3-step name → members → first-message flow ─────────────────

  test("wizard happy path: name → check 2 of 3 → send first message → teamSend called once, single combined notice", async () => {
    // Plant 3 candidate agents; check 2 of them.
    await plantTestAgent(fx.repoDir, "agent-a");
    await plantTestAgent(fx.repoDir, "agent-b");
    await plantTestAgent(fx.repoDir, "agent-c");
    const a = makeAgent({ id: "agent-a", repoPath: fx.repoDir });
    const b = makeAgent({ id: "agent-b", repoPath: fx.repoDir });
    const c = makeAgent({ id: "agent-c", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, teamSendCalls, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [a, b, c],
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("squad");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    expect(picker.items.length).toBe(3);
    // Check items 0 and 2.
    picker.onSubmit([0, 2]);
    await flushActions();
    const ta = assertDialog(dialogs[2]!, "textarea");
    ta.onSubmit("hello team");
    await flushActions();
    // teamSend was called exactly once with the message.
    expect(teamSendCalls).toHaveLength(1);
    expect(teamSendCalls[0]!.teamName).toBe("squad");
    expect(teamSendCalls[0]!.message).toBe("hello team");
    // The team has both checked agents (teamAdd was called twice).
    const reg = await readTeams();
    expect(reg.teams["squad"]).toBeDefined();
    expect(reg.teams["squad"]!.members.sort()).toEqual(["agent-a", "agent-c"]);
    // Single combined final notice mentioning the recipient count.
    expect(notices.some((n) => n.includes("created team @squad") && n.includes("2 member") && n.includes("recipient"))).toBe(true);
  });

  test("wizard with empty message: name → check 1 → Esc on textarea → teamAdd called once, no teamSend", async () => {
    await plantTestAgent(fx.repoDir, "agent-x");
    const x = makeAgent({ id: "agent-x", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, teamSendCalls, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [x],
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("solo");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    picker.onSubmit([0]);
    await flushActions();
    const ta = assertDialog(dialogs[2]!, "textarea");
    // Empty submission — equivalent to Esc-skip from the wizard's perspective.
    ta.onSubmit("");
    await flushActions();
    expect(teamSendCalls).toHaveLength(0);
    const reg = await readTeams();
    expect(reg.teams["solo"]!.members).toEqual(["agent-x"]);
    expect(notices.some((n) => n.includes("created team @solo") && n.includes("1 member"))).toBe(true);
  });

  test("wizard with no members selected: textarea still appears; teamCreate only, no teamAdd, no teamSend", async () => {
    await plantTestAgent(fx.repoDir, "agent-y");
    const y = makeAgent({ id: "agent-y", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, teamSendCalls, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [y],
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("empty-team");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    // Submit with NO checked indices.
    picker.onSubmit([]);
    await flushActions();
    const ta = assertDialog(dialogs[2]!, "textarea");
    ta.onSubmit("");
    await flushActions();
    expect(teamSendCalls).toHaveLength(0);
    const reg = await readTeams();
    expect(reg.teams["empty-team"]).toBeDefined();
    expect(reg.teams["empty-team"]!.members).toEqual([]);
    expect(notices.some((n) => n.includes("created team @empty-team"))).toBe(true);
  });

  test("wizard Esc on member step: teamDelete is called to roll back the just-created team", async () => {
    await plantTestAgent(fx.repoDir, "agent-z");
    const z = makeAgent({ id: "agent-z", repoPath: fx.repoDir });
    const { ctx, dialogs, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [z],
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("ephemeral");
    await flushActions();
    // Team exists at this point.
    let reg = await readTeams();
    expect(reg.teams["ephemeral"]).toBeDefined();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    // Invoke onCancel (the wizard's rollback hook). Mirrors the dialog-handler
    // Esc path that fires onCancel on a multi-select dialog.
    expect(picker.onCancel).toBeDefined();
    picker.onCancel!();
    await flushActions();
    reg = await readTeams();
    expect(reg.teams["ephemeral"]).toBeUndefined();
  });

  test("wizard pre-checks the selected agent when alsoAddSelectedAgent is true", async () => {
    // T-flow path: alsoAddSelectedAgent=false; t-flow: true.
    // handleCreateTeam uses alsoAddSelectedAgent=false, so the pre-check only
    // fires via handleAddAgentToTeam's empty-teams branch. We exercise it by
    // submitting through the empty-teams path.
    await plantTestAgent(fx.repoDir, "agent-pre");
    await plantTestAgent(fx.repoDir, "agent-other");
    const preChecked = makeAgent({ id: "agent-pre", repoPath: fx.repoDir });
    const other = makeAgent({ id: "agent-other", repoPath: fx.repoDir });
    const { ctx, dialogs, flushActions } = makeMockCtx({
      agent: preChecked,
      repos: [fx.repoEntry],
      lastAgents: [preChecked, other],
    });
    handleAddAgentToTeam(ctx);
    await Bun.sleep(10);
    // Empty-teams → input dialog opens directly.
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("alpha");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    // The selected agent (agent-pre) is pre-checked; the other is NOT.
    const preIdx = picker.items.findIndex((i) => i.includes("agent-pre"));
    const otherIdx = picker.items.findIndex((i) => i.includes("agent-other"));
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(otherIdx).toBeGreaterThanOrEqual(0);
    expect(picker.checked[preIdx]).toBe(true);
    expect(picker.checked[otherIdx]).toBe(false);
  });

  test("wizard Esc on textarea: emits the same notice as empty-submit (team + members persist)", async () => {
    // Reviewer must-fix #1: Esc on step 3 must NOT vanish silently. The
    // wizard's textarea now wires an onCancel that emits the same notice as
    // an empty-submit would.
    await plantTestAgent(fx.repoDir, "agent-keep");
    const keep = makeAgent({ id: "agent-keep", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [keep],
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("persist");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    picker.onSubmit([0]);
    await flushActions();
    const ta = assertDialog(dialogs[2]!, "textarea");
    // Invoke the Esc-cancel hook directly (mirrors the dialog-handler global
    // Esc path that fires onCancel on a textarea with one set).
    expect(ta.onCancel).toBeDefined();
    ta.onCancel!();
    await flushActions();
    // Team + members persisted; final notice fired.
    const reg = await readTeams();
    expect(reg.teams["persist"]!.members).toEqual(["agent-keep"]);
    expect(notices.some((n) => n.includes("created team @persist") && n.includes("1 member"))).toBe(true);
  });

  test("wizard step-2 Esc: success notice mentions rollback (not just silence)", async () => {
    // Reviewer should-fix #4: the onCancel branch now emits a success notice
    // on successful teamDelete, not only on failure.
    await plantTestAgent(fx.repoDir, "agent-tmp");
    const tmp = makeAgent({ id: "agent-tmp", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [tmp],
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("doomed");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    picker.onCancel!();
    await flushActions();
    // Team gone + user-visible notice that the rollback happened.
    const reg = await readTeams();
    expect(reg.teams["doomed"]).toBeUndefined();
    expect(notices.some((n) => n.includes("doomed") && n.toLowerCase().includes("rolled back"))).toBe(true);
  });

  test("wizard teamSend failure: notice includes 'send failed'", async () => {
    // Reviewer should-fix #5a: assert the send-failure branch produces the
    // expected notice format.
    await plantTestAgent(fx.repoDir, "agent-q");
    const q = makeAgent({ id: "agent-q", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [q],
      teamSend: async (teamName) => ({
        ok: false,
        stdout: "",
        stderr: "delivery failed",
        exitCode: 1,
      }),
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("brokerage");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    picker.onSubmit([0]);
    await flushActions();
    const ta = assertDialog(dialogs[2]!, "textarea");
    ta.onSubmit("ping");
    await flushActions();
    expect(notices.some((n) => n.includes("created team @brokerage") && n.includes("send failed") && n.includes("delivery failed"))).toBe(true);
  });

  test("wizard partial add failure: notice includes the add-failure count", async () => {
    // Reviewer should-fix #5b: assert partial-failure path. lastAgents
    // surfaces an entry not planted on disk so teamAdd's resolver errors out
    // — produces ok:false on that one teamAdd while the other succeeds.
    await plantTestAgent(fx.repoDir, "agent-real");
    const real = makeAgent({ id: "agent-real", repoPath: fx.repoDir });
    // ghost is NOT planted — readAllAgents won't surface it, so teamAdd's
    // resolveFullAgentId returns an error and the add fails.
    const ghost = makeAgent({ id: "agent-ghost", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({
      agent: null,
      repos: [fx.repoEntry],
      lastAgents: [real, ghost],
    });
    handleCreateTeam(ctx);
    const nameInput = assertDialog(dialogs[0]!, "input");
    nameInput.onSubmit("mixed");
    await flushActions();
    const picker = assertDialog(dialogs[1]!, "multi-select");
    // Check BOTH — the real one will succeed, the ghost will fail.
    picker.onSubmit([0, 1]);
    await flushActions();
    const ta = assertDialog(dialogs[2]!, "textarea");
    ta.onSubmit("");
    await flushActions();
    expect(notices.some((n) => n.includes("created team @mixed") && n.includes("1 member") && n.includes("1 add failure"))).toBe(true);
  });
});

describe("handleAddAgentToTeam", () => {
  let fx: Awaited<ReturnType<typeof setupTeamsFixture>>;

  beforeEach(async () => { fx = await setupTeamsFixture(); });
  afterEach(async () => { await teardownTeamsFixture(fx); });

  test("no agent selected: does nothing (no dialog)", async () => {
    const { ctx, dialogs } = makeMockCtx({ agent: null, repos: [fx.repoEntry] });
    handleAddAgentToTeam(ctx);
    // listTeams resolves on a microtask — wait a tick.
    await Bun.sleep(5);
    expect(dialogs).toHaveLength(0);
  });

  test("happy path: picking an existing team adds the agent, shows a notice, AND fires the audit-log join entry", async () => {
    await createTeam("backend", "user", 1700000000);
    await plantTestAgent(fx.repoDir, "agent-aaa");
    const agent = makeAgent({ id: "agent-aaa", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ agent, repos: [fx.repoEntry] });
    handleAddAgentToTeam(ctx);
    await Bun.sleep(10);
    const d = assertDialog(dialogs[0]!, "fuzzy");
    // The "+ Create new team…" entry must be the last item.
    expect(d.allItems[d.allItems.length - 1]).toContain("Create new team");
    // The first item is the existing team.
    expect(d.allItems[0]).toBe("backend");
    d.onSelect(0);
    await flushActions();
    const reg = await readTeams();
    expect(reg.teams["backend"]!.members).toContain("agent-aaa");
    expect(notices.some((n) => n.includes("Added agent-aaa to @backend"))).toBe(true);
    // teamAdd → fireJoinNotice → appendTeamLog("agent agent-aaa joined").
    // This is the proof the TUI path runs the SAME audit + notice helpers as
    // the CLI (Reviewer Issue A).
    const audit = await readTeamAuditLog("backend");
    expect(audit).toContain("agent-aaa joined");
  });

  test("empty teams: skips the picker and opens the create-team input directly", async () => {
    await plantTestAgent(fx.repoDir, "agent-bbb");
    const agent = makeAgent({ id: "agent-bbb", repoPath: fx.repoDir });
    const { ctx, dialogs } = makeMockCtx({ agent, repos: [fx.repoEntry] });
    handleAddAgentToTeam(ctx);
    await Bun.sleep(10);
    // No fuzzy picker — went straight to the input.
    const d = assertDialog(dialogs[0]!, "input");
    expect(d.prompt).toBe("Team name:");
    expect(d.value).toBe("");
  });

  test("empty teams: submitting the create input pre-checks the selected agent, then drives the wizard to completion", async () => {
    await plantTestAgent(fx.repoDir, "agent-ccc");
    const agent = makeAgent({ id: "agent-ccc", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({
      agent,
      repos: [fx.repoEntry],
      lastAgents: [agent],
    });
    handleAddAgentToTeam(ctx);
    await Bun.sleep(10);
    const d = assertDialog(dialogs[0]!, "input");
    d.onSubmit("frontend");
    await flushActions();
    // Step 2: multi-select picker opens with the selected agent pre-checked.
    const picker = assertDialog(dialogs[1]!, "multi-select");
    expect(picker.items[0]).toContain("agent-ccc");
    expect(picker.checked[0]).toBe(true);
    picker.onSubmit([0]);
    await flushActions();
    // Step 3: textarea — skip with empty submit.
    const ta = assertDialog(dialogs[2]!, "textarea");
    ta.onSubmit("");
    await flushActions();
    const reg = await readTeams();
    expect(reg.teams["frontend"]).toBeDefined();
    expect(reg.teams["frontend"]!.members).toContain("agent-ccc");
    // BOTH the create-audit and the join-audit must be present.
    const audit = await readTeamAuditLog("frontend");
    expect(audit).toContain("team created by");
    expect(audit).toContain("agent-ccc joined");
  });

  test("picker '+ Create new team…' branch: also drives the wizard with the selected agent pre-checked", async () => {
    await createTeam("existing", "user", 1700000000);
    await plantTestAgent(fx.repoDir, "agent-ddd");
    const agent = makeAgent({ id: "agent-ddd", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({
      agent,
      repos: [fx.repoEntry],
      lastAgents: [agent],
    });
    handleAddAgentToTeam(ctx);
    await Bun.sleep(10);
    const picker = assertDialog(dialogs[0]!, "fuzzy");
    // Select the LAST entry — "+ Create new team…"
    const createIdx = picker.allItems.length - 1;
    expect(picker.allItems[createIdx]).toContain("Create new team");
    picker.onSelect(createIdx);
    // Picker transitions to an input dialog for the new team name.
    const input = assertDialog(dialogs[1]!, "input");
    expect(input.prompt).toBe("Team name:");
    input.onSubmit("brand-new");
    await flushActions();
    // Wizard step 2: multi-select with the selected agent pre-checked.
    const memberPicker = assertDialog(dialogs[2]!, "multi-select");
    expect(memberPicker.checked[0]).toBe(true);
    memberPicker.onSubmit([0]);
    await flushActions();
    // Wizard step 3: textarea — skip.
    const ta = assertDialog(dialogs[3]!, "textarea");
    ta.onSubmit("");
    await flushActions();
    const reg = await readTeams();
    expect(reg.teams["brand-new"]).toBeDefined();
    expect(reg.teams["brand-new"]!.members).toContain("agent-ddd");
  });

  test("already-a-member: picking the same team reports it without re-adding", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-eee");
    await plantTestAgent(fx.repoDir, "agent-eee");
    const agent = makeAgent({ id: "agent-eee", repoPath: fx.repoDir });
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ agent, repos: [fx.repoEntry] });
    handleAddAgentToTeam(ctx);
    await Bun.sleep(10);
    const d = assertDialog(dialogs[0]!, "fuzzy");
    d.onSelect(0);
    await flushActions();
    const reg = await readTeams();
    // Roster is unchanged.
    expect(reg.teams["backend"]!.members.filter((m) => m === "agent-eee")).toHaveLength(1);
    expect(notices.some((n) => n.includes("already in @backend"))).toBe(true);
  });
});

describe("handleDisbandTeam", () => {
  let fx: Awaited<ReturnType<typeof setupTeamsFixture>>;

  beforeEach(async () => { fx = await setupTeamsFixture(); });
  afterEach(async () => { await teardownTeamsFixture(fx); });

  test("opens a confirm dialog with disband prompt", () => {
    const { ctx, dialogs } = makeMockCtx({ repos: [fx.repoEntry] });
    handleDisbandTeam(ctx, "backend");
    const d = assertDialog(dialogs[0]!, "confirm");
    expect(d.prompt).toContain("Disband team @backend");
    expect(d.prompt).toContain("Members will be notified");
    expect(d.confirmLabel).toBe("Disband");
    expect(d.focusedButton).toBe("cancel");
  });

  test("happy path: confirm fans out closure message to members, deletes the team + channel files, and reports success", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    await addMember("backend", "agent-bbb");
    // Plant channel + log files so we can assert they're cleaned up by
    // teamDelete (matching `ib team delete`'s §17.4 cleanup default). The real
    // teamSend would write a channel record during fan-out; the test's stub
    // skips that, so we seed the files directly to verify the post-delete
    // cleanup, not the fan-out's channel append.
    await appendChannelMessage("backend", { ts: 1700000001, fromAgent: "user", message: "hello" });
    await appendTeamLog("backend", "team created by user");
    expect(existsSync(channelPath("backend"))).toBe(true);
    expect(existsSync(teamLogPath("backend"))).toBe(true);
    const { ctx, dialogs, notices, teamSendCalls, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleDisbandTeam(ctx, "backend");
    const d = assertDialog(dialogs[0]!, "confirm");
    d.onYes();
    await flushActions();
    // teamSend was called with the closure message and an undefined opts (a
    // CLI/human send — matches the 's'-key team-send call shape exactly; the
    // resolver tags a falsy fromAgent with the configured user.name).
    expect(teamSendCalls).toHaveLength(1);
    expect(teamSendCalls[0]!.teamName).toBe("backend");
    expect(teamSendCalls[0]!.message).toBe("team @backend has been disbanded");
    expect(teamSendCalls[0]!.fromAgent).toBeUndefined();
    // Team is gone from the registry.
    const reg = await readTeams();
    expect(reg.teams["backend"]).toBeUndefined();
    // Channel + log files cleaned up too (§17.4 cleanup default).
    expect(existsSync(channelPath("backend"))).toBe(false);
    expect(existsSync(teamLogPath("backend"))).toBe(false);
    // Notice reports the count and confirms deletion.
    expect(notices.some((n) => n.includes("disbanded team @backend") && n.includes("2 members notified"))).toBe(true);
  });

  test("cancel: dismissing the confirm dialog does not call teamSend and leaves the team intact", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    const { ctx, dialogs, notices, teamSendCalls, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleDisbandTeam(ctx, "backend");
    // Don't call onYes — just flush any pending actions (there should be none).
    await flushActions();
    // teamSend was never invoked.
    expect(teamSendCalls).toHaveLength(0);
    // Team is still in the registry.
    const reg = await readTeams();
    expect(reg.teams["backend"]).toBeDefined();
    expect(reg.teams["backend"]!.members).toContain("agent-aaa");
    // No success notice was emitted.
    expect(notices.some((n) => n.includes("disbanded"))).toBe(false);
    // The dialog WAS shown though.
    expect(dialogs).toHaveLength(1);
  });

  test("team vanished mid-flight: skips fan-out, sets notice, does not error", async () => {
    // Team is never created — getTeam returns null.
    const { ctx, dialogs, notices, teamSendCalls, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleDisbandTeam(ctx, "ghost");
    const d = assertDialog(dialogs[0]!, "confirm");
    d.onYes();
    await flushActions();
    // No fan-out (we never resolved a team).
    expect(teamSendCalls).toHaveLength(0);
    // Notice reports the vanished state.
    expect(notices.some((n) => n.includes("team @ghost no longer exists"))).toBe(true);
  });

  test("team deleted between getTeam and teamDelete: still reports vanished state", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    // Inject a teamSend stub that deletes the team mid-flight to simulate a race.
    const teamSend: ActionCtx["teamSend"] = async (teamName, _members, _message, _opts) => {
      await deleteTeam(teamName);
      return { ok: true, stdout: `sent to @${teamName}`, stderr: "", exitCode: 0 };
    };
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ repos: [fx.repoEntry], teamSend });
    handleDisbandTeam(ctx, "backend");
    const d = assertDialog(dialogs[0]!, "confirm");
    d.onYes();
    await flushActions();
    // Team is gone (the stub did it).
    const reg = await readTeams();
    expect(reg.teams["backend"]).toBeUndefined();
    // Notice reports the vanished-mid-flight state rather than success — the
    // teamDelete wrapper returned ok:false so we don't claim a successful disband.
    expect(notices.some((n) => n.includes("no longer exists"))).toBe(true);
  });
});

// --- handleManageTeam (§17.3 manage-team picker — x-on-team-anchor) ---------
//
// The picker shows a `select` dialog whose first option disbands the team and
// whose remaining options remove a single member each. Each destructive choice
// is gated by a second confirm dialog before any state change. Member labels
// are `<repo>/<id>` when the member's live Agent record is resolvable, or the
// bare id otherwise (no Agents record yet, e.g. for a recently-added member).

function mkAgent(id: string, repoName: string): Agent {
  return {
    id,
    repoPath: `/repos/${repoName}/${id}`,
    repoName,
    meta: {
      id,
      session_id: `sess-${id}`,
      tmux_session: `ittybitty-${repoName}-${id}`,
      prompt: `Task for ${id}`,
      manager: null,
      created: "2025-01-01T00:00:00Z",
      created_epoch: 1735689600,
      worktree: true,
      worker: false,
      yolo: false,
      model: "sonnet",
      claude_pid: "12345",
    },
    state: "running",
    age: "5m",
    archived: false,
    children: [],
  };
}

describe("handleManageTeam", () => {
  let fx: Awaited<ReturnType<typeof setupTeamsFixture>>;

  beforeEach(async () => { fx = await setupTeamsFixture(); });
  afterEach(async () => { await teardownTeamsFixture(fx); });

  test("opens a select dialog with Disband first then one Remove row per member", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    await addMember("backend", "agent-bbb");
    const lastAgents = [mkAgent("agent-aaa", "api"), mkAgent("agent-bbb", "web")];
    const { ctx, dialogs, flushActions } = makeMockCtx({ repos: [fx.repoEntry], lastAgents });
    handleManageTeam(ctx, "backend");
    await flushActions();
    const d = assertDialog(dialogs[0]!, "select");
    expect(d.prompt).toContain("Manage team @backend");
    // Order: Disband, then members in roster order.
    expect(d.items[0]).toBe("Disband team @backend");
    expect(d.items[1]).toBe("Remove api/agent-aaa");
    expect(d.items[2]).toBe("Remove web/agent-bbb");
    expect(d.items.length).toBe(3);
  });

  test("a member with no live Agent record falls back to the bare id label", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    await addMember("backend", "agent-ghost"); // not in lastAgents
    const lastAgents = [mkAgent("agent-aaa", "api")];
    const { ctx, dialogs, flushActions } = makeMockCtx({ repos: [fx.repoEntry], lastAgents });
    handleManageTeam(ctx, "backend");
    await flushActions();
    const d = assertDialog(dialogs[0]!, "select");
    // Resolvable member is repo-qualified; unresolvable falls back to bare id.
    expect(d.items[1]).toBe("Remove api/agent-aaa");
    expect(d.items[2]).toBe("Remove agent-ghost");
  });

  test("an empty team still opens the dialog with only the Disband option", async () => {
    await createTeam("backend", "user", 1700000000);
    const { ctx, dialogs, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleManageTeam(ctx, "backend");
    await flushActions();
    const d = assertDialog(dialogs[0]!, "select");
    expect(d.items).toEqual(["Disband team @backend"]);
  });

  test("picking index 0 falls through to handleDisbandTeam's confirm dialog", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    const lastAgents = [mkAgent("agent-aaa", "api")];
    const { ctx, dialogs, flushActions } = makeMockCtx({ repos: [fx.repoEntry], lastAgents });
    handleManageTeam(ctx, "backend");
    await flushActions();
    const picker = assertDialog(dialogs[0]!, "select");
    picker.onSelect(0); // Disband
    // The disband confirm dialog is now the next-pushed dialog.
    const confirm = assertDialog(dialogs[1]!, "confirm");
    expect(confirm.prompt).toContain("Disband team @backend");
    expect(confirm.confirmLabel).toBe("Disband");
  });

  test("picking a Remove row opens a confirm dialog with the labelled member", async () => {
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    await addMember("backend", "agent-bbb");
    const lastAgents = [mkAgent("agent-aaa", "api"), mkAgent("agent-bbb", "web")];
    const { ctx, dialogs, flushActions } = makeMockCtx({ repos: [fx.repoEntry], lastAgents });
    handleManageTeam(ctx, "backend");
    await flushActions();
    const picker = assertDialog(dialogs[0]!, "select");
    picker.onSelect(2); // Remove web/agent-bbb
    const confirm = assertDialog(dialogs[1]!, "confirm");
    expect(confirm.prompt).toContain("Remove web/agent-bbb from @backend");
    expect(confirm.confirmLabel).toBe("Remove");
    expect(confirm.focusedButton).toBe("cancel");
  });

  test("confirming Remove calls teamRemove which prunes the roster + fires the leave notice", async () => {
    // teamRemove resolves the member id via readAllAgents, so we plant real
    // agent dirs on disk for both members. The live `lastAgents` is unrelated
    // (it only drives the picker's label format) but we keep it consistent
    // with the planted dirs.
    await plantTestAgent(fx.repoDir, "agent-aaa");
    await plantTestAgent(fx.repoDir, "agent-bbb");
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    await addMember("backend", "agent-bbb");
    const lastAgents = [mkAgent("agent-aaa", "api"), mkAgent("agent-bbb", "web")];
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ repos: [fx.repoEntry], lastAgents });
    handleManageTeam(ctx, "backend");
    await flushActions();
    const picker = assertDialog(dialogs[0]!, "select");
    picker.onSelect(2); // Remove agent-bbb
    const confirm = assertDialog(dialogs[1]!, "confirm");
    confirm.onYes();
    await flushActions();
    // The persist step ran (member is gone from the roster); teamRemove is the
    // CLI wrapper that also fires the leave notice (§16.4.2 — best-effort, may
    // be a no-op in this fixture if the recipient agent has no live tmux pane,
    // which is fine: the registry update is the visible state change).
    const reg = await readTeams();
    expect(reg.teams["backend"]!.members).toEqual(["agent-aaa"]);
    expect(notices.some((n) => n.includes("Removed") && n.includes("backend"))).toBe(true);
  });

  test("cancelling the Remove confirm leaves the roster intact", async () => {
    await plantTestAgent(fx.repoDir, "agent-aaa");
    await createTeam("backend", "user", 1700000000);
    await addMember("backend", "agent-aaa");
    const lastAgents = [mkAgent("agent-aaa", "api")];
    const { ctx, dialogs, flushActions } = makeMockCtx({ repos: [fx.repoEntry], lastAgents });
    handleManageTeam(ctx, "backend");
    await flushActions();
    const picker = assertDialog(dialogs[0]!, "select");
    picker.onSelect(1); // Remove agent-aaa
    // Don't call onYes — just leave the confirm open. The roster is unchanged.
    await flushActions();
    const reg = await readTeams();
    expect(reg.teams["backend"]!.members).toEqual(["agent-aaa"]);
  });

  test("a team that does not exist sets a notice and does NOT open a dialog", async () => {
    const { ctx, dialogs, notices, flushActions } = makeMockCtx({ repos: [fx.repoEntry] });
    handleManageTeam(ctx, "ghost");
    await flushActions();
    expect(dialogs).toHaveLength(0);
    expect(notices.some((n) => n.includes("team @ghost no longer exists"))).toBe(true);
  });
});

describe("handleFolderBrowser", () => {
  let fx: Awaited<ReturnType<typeof setupTeamsFixture>>;

  beforeEach(async () => { fx = await setupTeamsFixture(); });
  afterEach(async () => { await teardownTeamsFixture(fx); });

  test("sanitizes a folder name with a space when adding a repo", async () => {
    // Plant a folder named "Rice Teaching" under the temp base dir. The
    // fixture has already pre-seeded a "repo" entry via saveRegistry —
    // we look up our new entry by its path.
    const repoPath = join(fx.baseDir, "Rice Teaching");
    await mkdir(repoPath, { recursive: true });

    const { ctx, dialogs } = makeMockCtx({ repos: [fx.repoEntry] });
    await handleFolderBrowser(ctx);
    const dialog = assertDialog(dialogs[0]!, "folder-browser");

    // Simulate the user picking the "Rice Teaching" folder. onSelect is
    // fire-and-forget (addRepo runs inside a .then chain); poll the registry
    // until the new entry appears.
    dialog.onSelect(repoPath);
    for (let i = 0; i < 50; i++) {
      const reg = await loadRegistry();
      if (reg.repos.some((r) => r.path === repoPath)) break;
      await Bun.sleep(10);
    }

    const reg = await loadRegistry();
    const added = reg.repos.find((r) => r.path === repoPath);
    expect(added).toBeDefined();
    expect(added!.name).toBe("rice-teaching");
  });
});
