import { test, expect, describe, beforeEach, afterEach } from "bun:test";
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
  handleHelp, handleResizeLeft,
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
} {
  const dialogs: NonNullable<DialogState>[] = [];
  const notices: string[] = [];
  const refreshCalls: number[] = [];
  const scrollUpCalls: number[] = [];
  const scrollDownCalls: number[] = [];
  let leftWidth = overrides?.leftWidth ?? 60;

  const ctx: ActionCtx = {
    agentTree: {
      selectedAgent: overrides?.agent ?? null,
      selectedRepoHeader: overrides?.repoHeader ?? null,
      flatList: overrides?.flatList ?? [],
      visibleList: overrides?.flatList ?? [],
      selectAgentById: () => true,
    },
    rightPane: {
      mode: overrides?.mode ?? "AGENT LOG",
      filteredQuestions: overrides?.questions ?? [],
      questionsSelectedIndex: 0,
      scrollOffset: 5,
      errors: overrides?.errors ?? [],
      orphanedTmuxSessions: overrides?.orphanedTmuxSessions ?? [],
      updateContent: () => {},
    },
    tmuxPane: {
      scrollUp: (n?: number) => scrollUpCalls.push(n ?? 10),
      scrollDown: (n?: number) => scrollDownCalls.push(n ?? 10),
    },
    splitPane: {
      getLeftWidth: () => leftWidth,
      setLeftWidth: (w: number) => { leftWidth = w; },
    },
    tui: { requestRender: () => {} },
    repos: overrides?.repos ?? [],
    watcher: { refresh: () => refreshCalls.push(1), updateRepos: () => {}, recheckHealth: () => {} },
    diffTool: undefined,
    pendingSelectNewestInRepo: null,
    showDialog: (d: NonNullable<DialogState>) => { dialogs.push(d); },
    closeDialog: () => {},
    setNotice: (text: string) => { notices.push(text); },
    executeAndRefresh: async (fn: () => Promise<void>) => { await fn(); },
    syncSelectedAgent: () => {},
    jumpToMode: () => {},
    setQuestionsFocused: () => {},
    healthReport: undefined,
  };
  return { ctx, dialogs, notices, refreshCalls, scrollUpCalls, scrollDownCalls };
}

beforeEach(() => {
  setKillPauseSpawnRunner(noopSpawnRunner);
  setNukeResumeSpawnRunner(noopSpawnRunner);
  setSendSpawnRunner(noopSpawnRunner);
  setNewAgentSpawnRunner(noopSpawnRunner);
  lifecycleSpawnCtx.set(noopSpawnRunner);
});

afterEach(() => {
  resetKillPauseSpawnRunner();
  resetNukeResumeSpawnRunner();
  resetSendSpawnRunner();
  resetNewAgentSpawnRunner();
  lifecycleSpawnCtx.reset();
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

  test("shows notice for running agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "running" });
    const { ctx, notices } = makeMockCtx({ agent });
    handleResume(ctx);
    expect(notices).toEqual(["Can only resume stopped or complete agents"]);
  });

  test("shows notice for waiting agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "waiting" });
    const { ctx, notices } = makeMockCtx({ agent });
    handleResume(ctx);
    expect(notices).toEqual(["Can only resume stopped or complete agents"]);
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
    expect(notices).toEqual(["Can only pause running or waiting agents"]);
  });

  test("shows notice for complete agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "complete" });
    const { ctx, notices } = makeMockCtx({ agent });
    handlePause(ctx);
    expect(notices).toEqual(["Can only pause running or waiting agents"]);
  });

  test("shows notice for archived agent", () => {
    const agent = makeAgent({ id: "agent-1", state: "running", archived: true });
    const { ctx, notices } = makeMockCtx({ agent });
    handlePause(ctx);
    expect(notices).toEqual(["Can only pause running or waiting agents"]);
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
    const agent = makeAgent({ id: "agent-1" });
    const { ctx, dialogs, notices } = makeMockCtx({ agent });
    handleSend(ctx);
    const d = assertDialog(dialogs[0]!, "textarea");
    d.onSubmit("Hello agent");
    await Bun.sleep(10);
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
});

describe("handleHelp", () => {
  test("shows help dialog", () => {
    const { ctx, dialogs } = makeMockCtx();
    handleHelp(ctx);
    expect(dialogs).toHaveLength(1);
    const d = assertDialog(dialogs[0]!, "help");
    expect(d.lines.length).toBeGreaterThan(5);
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
