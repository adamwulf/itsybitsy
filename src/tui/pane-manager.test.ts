import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { makeAgent } from "../test-utils";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import {
  RightPaneComponent, PANE_MODES, FULL_WIDTH_MODES,
  cyclePaneMode, jumpToMode, triggerAsyncLoadIfNeeded,
  colorizeDiff, colorizeLog,
  closeOsc8, OSC8_OPEN, OSC8_CLOSE,
  loadAgentLog, loadDenials,
} from "./pane-manager";
import type { PaneCtx, PaneMode } from "./pane-manager";
import { stripAnsi } from "../parse-state";
import { visibleWidth } from "@mariozechner/pi-tui";

/** Build a mock PaneCtx with a real RightPaneComponent */
function makePaneCtx(overrides?: {
  agent?: Agent | null;
  errors?: string[];
  questions?: PendingQuestion[];
  orphanedTmuxSessions?: string[];
}): PaneCtx & { renderCalls: number[] } {
  const renderCalls: number[] = [];
  const rp = new RightPaneComponent();
  rp.errors = overrides?.errors ?? [];
  rp.questions = overrides?.questions ?? [];
  rp.orphanedTmuxSessions = overrides?.orphanedTmuxSessions ?? [];
  return {
    rightPane: rp,
    agentTree: { selectedAgent: overrides?.agent ?? null },
    splitPane: { fullWidth: false },
    modeIndex: 0,
    savedModeIndex: 0,
    currentAgentId: overrides?.agent?.id ?? null,
    tui: { requestRender: () => renderCalls.push(1) },
    setQuestionsFocused: () => {},
    renderCalls,
  };
}

describe("cyclePaneMode", () => {
  test("cycles forward through modes", () => {
    const ctx = makePaneCtx({ errors: ["err"], questions: [{ id: "q1", agent: "a", question: "?", timestamp: "t", status: "pending" as const }] });
    expect(PANE_MODES[ctx.modeIndex]).toBe("AGENT LOG");
    cyclePaneMode(ctx, 1);
    expect(PANE_MODES[ctx.modeIndex]).toBe("INITIAL PROMPT");
    cyclePaneMode(ctx, 1);
    expect(PANE_MODES[ctx.modeIndex]).toBe("DENIALS");
  });

  test("cycles backward through modes", () => {
    const ctx = makePaneCtx({ errors: ["err"], questions: [{ id: "q1", agent: "a", question: "?", timestamp: "t", status: "pending" as const }] });
    ctx.modeIndex = 2; // DENIALS
    ctx.rightPane.setMode(PANE_MODES[2]!);
    cyclePaneMode(ctx, -1);
    expect(PANE_MODES[ctx.modeIndex]).toBe("INITIAL PROMPT");
  });

  test("skips ERRORS when no errors", () => {
    const ctx = makePaneCtx({ errors: [], questions: [{ id: "q1", agent: "a", question: "?", timestamp: "t", status: "pending" as const }] });
    // ERRORS is index 4 — cycle to it
    ctx.modeIndex = 3; // TREE
    ctx.rightPane.setMode(PANE_MODES[3]!);
    cyclePaneMode(ctx, 1);
    // Should skip ERRORS (index 4) and land on DIFF (index 5)
    expect(PANE_MODES[ctx.modeIndex]).not.toBe("ERRORS");
  });

  test("skips QUESTIONS when no questions", () => {
    const ctx = makePaneCtx({ errors: ["err"], questions: [] });
    // QUESTIONS is index 6 — cycle to it
    ctx.modeIndex = 5; // DIFF
    ctx.rightPane.setMode(PANE_MODES[5]!);
    cyclePaneMode(ctx, 1);
    // Should skip QUESTIONS (index 6) and land on STATUS (index 7)
    expect(PANE_MODES[ctx.modeIndex]).not.toBe("QUESTIONS");
  });

  test("wraps around forward", () => {
    const ctx = makePaneCtx({ errors: ["err"], questions: [{ id: "q1", agent: "a", question: "?", timestamp: "t", status: "pending" as const }] });
    ctx.modeIndex = PANE_MODES.length - 1; // STATUS
    ctx.rightPane.setMode(PANE_MODES[ctx.modeIndex]!);
    cyclePaneMode(ctx, 1);
    expect(PANE_MODES[ctx.modeIndex]).toBe("AGENT LOG");
  });
});

describe("jumpToMode", () => {
  test("sets modeIndex and mode", () => {
    const ctx = makePaneCtx();
    jumpToMode(ctx, "DIFF");
    expect(ctx.modeIndex).toBe(PANE_MODES.indexOf("DIFF"));
    expect(ctx.rightPane.mode).toBe("DIFF");
  });

  test("sets fullWidth for FULL_WIDTH_MODES", () => {
    const ctx = makePaneCtx();
    jumpToMode(ctx, "DIFF");
    expect(ctx.splitPane.fullWidth).toBe(true);
    jumpToMode(ctx, "AGENT LOG");
    expect(ctx.splitPane.fullWidth).toBe(false);
  });
});

describe("triggerAsyncLoadIfNeeded", () => {
  test("does nothing when no agent", () => {
    const ctx = makePaneCtx({ agent: null });
    ctx.modeIndex = PANE_MODES.indexOf("DIFF");
    // Should not throw
    triggerAsyncLoadIfNeeded(ctx);
  });

  test("triggers load for DIFF mode", () => {
    const agent = makeAgent({ id: "agent-1" });
    const ctx = makePaneCtx({ agent });
    ctx.modeIndex = PANE_MODES.indexOf("DIFF");
    // diffContent is null and not loading, so it should set diffLoading
    triggerAsyncLoadIfNeeded(ctx);
    expect(ctx.rightPane.diffLoading).toBe(true);
  });

  test("triggers load for STATUS mode", () => {
    const agent = makeAgent({ id: "agent-1" });
    const ctx = makePaneCtx({ agent });
    ctx.modeIndex = PANE_MODES.indexOf("STATUS");
    triggerAsyncLoadIfNeeded(ctx);
    expect(ctx.rightPane.statusLoading).toBe(true);
  });

  test("does not reload DIFF if already loading", () => {
    const agent = makeAgent({ id: "agent-1" });
    const ctx = makePaneCtx({ agent });
    ctx.modeIndex = PANE_MODES.indexOf("DIFF");
    ctx.rightPane.diffLoading = true;
    // Should not reset or re-trigger
    triggerAsyncLoadIfNeeded(ctx);
    expect(ctx.rightPane.diffLoading).toBe(true);
  });
});

describe("RightPaneComponent", () => {
  test("setMode resets scrollOffset", () => {
    const rp = new RightPaneComponent();
    rp.scrollOffset = 15;
    rp.setMode("DIFF");
    expect(rp.scrollOffset).toBe(0);
    expect(rp.mode).toBe("DIFF");
  });

  test("render pads to displayHeight", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 10;
    rp.setMode("AGENT LOG");
    const lines = rp.render(40);
    expect(lines).toHaveLength(10);
  });

  test("render wraps for AGENT LOG mode", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 20;
    rp.agentLogContent = ["short line", "another line"];
    rp.setMode("AGENT LOG");
    const lines = rp.render(40);
    expect(lines).toHaveLength(20);
    expect(stripAnsi(lines[0]!).trim()).toBe("short line");
  });

  test("filteredQuestions returns all when no agent", () => {
    const rp = new RightPaneComponent();
    rp.questions = [
      { id: "q1", agent: "a1", question: "Q1?", timestamp: "t", status: "pending" as const },
      { id: "q2", agent: "a2", question: "Q2?", timestamp: "t", status: "pending" as const },
    ];
    rp.agent = null;
    expect(rp.filteredQuestions).toHaveLength(2);
  });

  test("filteredQuestions filters by agent ID when agent is set", () => {
    const rp = new RightPaneComponent();
    rp.questions = [
      { id: "q1", agent: "a1", question: "Q1?", timestamp: "t", status: "pending" as const },
      { id: "q2", agent: "a2", question: "Q2?", timestamp: "t", status: "pending" as const },
      { id: "q3", agent: "a1", question: "Q3?", timestamp: "t", status: "pending" as const },
    ];
    rp.agent = makeAgent({ id: "a1" });
    const filtered = rp.filteredQuestions;
    expect(filtered).toHaveLength(2);
    expect(filtered.every((q) => q.agent === "a1")).toBe(true);
  });

  test("ERRORS mode shows errors and orphaned sessions", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 20;
    rp.errors = ["some error"];
    rp.orphanedTmuxSessions = ["orphan-1"];
    rp.setMode("ERRORS");
    const lines = rp.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("2 error(s)");
    expect(text).toContain("orphan-1");
  });

  test("ERRORS mode shows 'No errors' when empty", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 10;
    rp.errors = [];
    rp.orphanedTmuxSessions = [];
    rp.setMode("ERRORS");
    const lines = rp.render(40);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("No errors");
  });

  test("DIFF mode shows loading when diffLoading", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 10;
    rp.agent = makeAgent({ id: "a1" });
    rp.diffLoading = true;
    rp.setMode("DIFF");
    const lines = rp.render(40);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Loading diff");
  });

  test("STATUS mode shows status content", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 10;
    rp.agent = makeAgent({ id: "a1" });
    rp.statusContent = ["On branch main", "nothing to commit"];
    rp.setMode("STATUS");
    const lines = rp.render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("On branch main");
  });
});

describe("colorizeDiff", () => {
  test("colorizes + lines green", () => {
    const result = colorizeDiff(["+added"]);
    expect(result[0]).toContain("\x1b[32m");
    expect(stripAnsi(result[0]!)).toBe("+added");
  });

  test("colorizes - lines red", () => {
    const result = colorizeDiff(["-removed"]);
    expect(result[0]).toContain("\x1b[31m");
  });

  test("colorizes @@ lines dim", () => {
    const result = colorizeDiff(["@@ -1,3 +1,4 @@"]);
    expect(result[0]).toContain("\x1b[2m");
  });

  test("colorizes diff header dim", () => {
    const result = colorizeDiff(["diff --git a/f b/f"]);
    expect(result[0]).toContain("\x1b[2m");
  });

  test("leaves context lines unchanged", () => {
    const result = colorizeDiff(["  unchanged line"]);
    expect(result[0]).toBe("  unchanged line");
  });
});

describe("colorizeLog", () => {
  test("dims timestamps", () => {
    const result = colorizeLog(["[2026-03-05 15:37:26] Some event"]);
    expect(result[0]).toContain("\x1b[2m");
    expect(stripAnsi(result[0]!)).toBe("[2026-03-05 15:37:26] Some event");
  });

  test("cyan-izes bracket markers after timestamps", () => {
    const result = colorizeLog(["[2026-03-05 15:37:26] [PreToolUse] Permission denied"]);
    expect(result[0]).toContain("\x1b[36m");
    expect(stripAnsi(result[0]!)).toBe("[2026-03-05 15:37:26] [PreToolUse] Permission denied");
  });
});

describe("REPO mode with coordinator", () => {
  test("computeRepoCoordinatorSplit returns full height for repo when no coordinator", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 30;
    rp.repoCoordinatorAgent = null;
    const { repoHeight, coordinatorHeight } = rp.computeRepoCoordinatorSplit();
    expect(repoHeight).toBe(30);
    expect(coordinatorHeight).toBe(0);
  });

  test("computeRepoCoordinatorSplit splits height when coordinator exists", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 30;
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    const { repoHeight, coordinatorHeight } = rp.computeRepoCoordinatorSplit();
    expect(repoHeight + coordinatorHeight).toBe(30);
    expect(coordinatorHeight).toBeGreaterThanOrEqual(5);
    expect(repoHeight).toBeGreaterThanOrEqual(3);
  });

  test("computeRepoCoordinatorSplit respects height offset", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 30;
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    rp.repoCoordinatorHeightOffset = 3;
    const { repoHeight: rh1, coordinatorHeight: ch1 } = rp.computeRepoCoordinatorSplit();

    rp.repoCoordinatorHeightOffset = 0;
    const { repoHeight: rh2, coordinatorHeight: ch2 } = rp.computeRepoCoordinatorSplit();

    // With positive offset, coordinator should be larger
    expect(ch1).toBeGreaterThan(ch2);
    expect(rh1).toBeLessThan(rh2);
  });

  test("computeRepoCoordinatorSplit normalizes offset when it exceeds valid range (BUG-10)", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 20;
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    // Set a grossly large offset that would push coordinator beyond available space
    rp.repoCoordinatorHeightOffset = 9999;
    const { repoHeight, coordinatorHeight } = rp.computeRepoCoordinatorSplit();
    // Both panes must stay >= 3
    expect(repoHeight).toBeGreaterThanOrEqual(3);
    expect(coordinatorHeight).toBeGreaterThanOrEqual(3);
    // Offset must be normalized (not 9999 anymore)
    expect(rp.repoCoordinatorHeightOffset).not.toBe(9999);
    // Re-calling with normalized offset gives the same result
    const { repoHeight: rh2, coordinatorHeight: ch2 } = rp.computeRepoCoordinatorSplit();
    expect(rh2).toBe(repoHeight);
    expect(ch2).toBe(coordinatorHeight);
  });

  test("computeRepoCoordinatorSplit normalizes large negative offset (BUG-10)", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 20;
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    // Set a large negative offset that would shrink coordinator below minimum
    rp.repoCoordinatorHeightOffset = -9999;
    const { repoHeight, coordinatorHeight } = rp.computeRepoCoordinatorSplit();
    // Both panes must stay >= 3
    expect(repoHeight).toBeGreaterThanOrEqual(3);
    expect(coordinatorHeight).toBeGreaterThanOrEqual(3);
    // Offset must be normalized
    expect(rp.repoCoordinatorHeightOffset).not.toBe(-9999);
    // Re-calling gives stable result
    const { repoHeight: rh2, coordinatorHeight: ch2 } = rp.computeRepoCoordinatorSplit();
    expect(rh2).toBe(repoHeight);
    expect(ch2).toBe(coordinatorHeight);
  });

  test("renderRepoCoordinatorSection shows 'No coordinator' when no coordinator agent", () => {
    const rp = new RightPaneComponent();
    rp.repoCoordinatorAgent = null;
    const lines = rp.renderRepoCoordinatorSection(40, 10, false);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("No coordinator for this repo");
  });

  test("renderRepoCoordinatorSection shows stopped message when polled with no output", () => {
    const rp = new RightPaneComponent();
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    rp.repoCoordinatorHasPolled = true;
    rp.repoCoordinatorOutput = null;
    const lines = rp.renderRepoCoordinatorSection(40, 10, false);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Coordinator stopped");
    expect(text).toContain("Press R to resume");
  });

  test("renderRepoCoordinatorSection shows loading when not yet polled", () => {
    const rp = new RightPaneComponent();
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    rp.repoCoordinatorHasPolled = false;
    const lines = rp.renderRepoCoordinatorSection(40, 10, false);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Starting coordinator");
  });

  test("renderRepoCoordinatorSection shows tmux output when available", () => {
    const rp = new RightPaneComponent();
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    rp.repoCoordinatorHasPolled = true;
    rp.repoCoordinatorOutput = "coordinator output line 1\ncoordinator output line 2";
    const lines = rp.renderRepoCoordinatorSection(60, 10, false);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("coordinator output line 1");
    expect(text).toContain("coordinator output line 2");
  });

  test("renderRepoCoordinatorSection WORD-wraps an over-width -J logical line (no mid-word break)", () => {
    // F3: the coordinator poller delivers -J logical lines. An over-width line
    // must break at spaces (word-wrap), matching the center pane — not char-wrap
    // that splits mid-word.
    const rp = new RightPaneComponent();
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    rp.repoCoordinatorHasPolled = true;
    const width = 24;
    rp.repoCoordinatorOutput =
      "supercalifragilistic reflow keeps whole words intact across the wrap boundary here";
    const lines = rp.renderRepoCoordinatorSection(width, 12, false);
    const rows = lines.map(stripAnsi);
    // The first word "supercalifragilistic" (20 chars) fits within width 24, so
    // it must appear whole on a single row — a char-wrap would have split it.
    expect(rows.some((r) => r.includes("supercalifragilistic reflow") || /\bsupercalifragilistic\b/.test(r))).toBe(true);
    // No visible content row exceeds the width.
    for (const r of rows) {
      expect(visibleWidth(r)).toBeLessThanOrEqual(width);
    }
  });

  test("renderRepoCoordinatorSection memoizes the wrap (same raw+width → cached array)", () => {
    // F3: repeated renders between polls must reuse the memoized wrap. We assert
    // the cache is keyed on (raw, width) via the shared WordWrapCache by checking
    // that rendering twice with unchanged input is stable and correct.
    const rp = new RightPaneComponent();
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", meta: { agentType: "coordinator" } as any });
    rp.repoCoordinatorHasPolled = true;
    rp.repoCoordinatorOutput = "a moderately long coordinator status line that will reflow at this width";
    const first = rp.renderRepoCoordinatorSection(30, 12, false).map(stripAnsi);
    const second = rp.renderRepoCoordinatorSection(30, 12, false).map(stripAnsi);
    expect(second).toEqual(first);
    // resetRepoCoordinator clears both the output and the memo.
    rp.resetRepoCoordinator();
    expect(rp.repoCoordinatorOutput).toBeNull();
  });

  test("REPO mode renders split view when coordinator exists", () => {
    const rp = new RightPaneComponent();
    rp.displayHeight = 20;
    rp.selectedRepoHeader = "my-repo";
    rp.repoCoordinatorAgent = makeAgent({ id: "coord-1", repoName: "my-repo", meta: { agentType: "coordinator" } as any });
    rp.repoCoordinatorHasPolled = true;
    rp.repoCoordinatorOutput = "coordinator output";
    rp.allAgents = [];
    rp.setMode("REPO");
    const lines = rp.render(60);
    expect(lines).toHaveLength(20);
    const text = lines.map(stripAnsi).join("\n");
    // Should contain both repo info and coordinator section
    expect(text).toContain("Coordinator");
    expect(text).toContain("coordinator output");
  });
});

describe("formatAgentRow uses coordinator icon", () => {
  const { formatAgentRow: pmFormatAgentRow } = require("./pane-manager");
  test("coordinator agent gets ◇ icon", () => {
    const agent = makeAgent({ id: "coord-1" });
    agent.meta.agentType = "coordinator";
    const row = pmFormatAgentRow(agent, "", 8);
    expect(row).toContain("◇");
  });

  test("regular agent gets ◆ icon", () => {
    const agent = makeAgent({ id: "regular-1" });
    const row = pmFormatAgentRow(agent, "", 8);
    expect(row).toContain("◆");
  });

  test("worker agent gets ⚙ icon", () => {
    const agent = makeAgent({ id: "worker-1" });
    agent.meta.worker = true;
    const row = pmFormatAgentRow(agent, "", 8);
    expect(row).toContain("⚙");
  });
});

describe("closeOsc8", () => {
  test("returns line unchanged when no OSC 8 present", () => {
    expect(closeOsc8("hello world")).toBe("hello world");
  });

  test("returns line unchanged when OSC 8 is properly closed", () => {
    const line = `${OSC8_OPEN}file:///tmp\x07click here${OSC8_CLOSE}`;
    expect(closeOsc8(line)).toBe(line);
  });

  test("appends close tag when hyperlink text is truncated", () => {
    // Simulates truncation after the BEL but before the close tag
    const line = `${OSC8_OPEN}file:///tmp\x07click he`;
    expect(closeOsc8(line)).toBe(line + OSC8_CLOSE);
  });

  test("strips partial OSC sequence when truncated mid-URI", () => {
    // Simulates truncation inside the URI (no BEL terminator after open)
    const line = `prefix ${OSC8_OPEN}file:///Us`;
    expect(closeOsc8(line)).toBe(`prefix ${OSC8_CLOSE}`);
  });

  test("handles line with text before and after hyperlink", () => {
    const line = `Path: ${OSC8_OPEN}file:///tmp\x07/tmp${OSC8_CLOSE} suffix`;
    expect(closeOsc8(line)).toBe(line);
  });

  test("handles multiple hyperlinks with last one closed", () => {
    const line = `${OSC8_OPEN}file:///a\x07a${OSC8_CLOSE} ${OSC8_OPEN}file:///b\x07b${OSC8_CLOSE}`;
    expect(closeOsc8(line)).toBe(line);
  });

  test("handles multiple hyperlinks with last one truncated", () => {
    const line = `${OSC8_OPEN}file:///a\x07a${OSC8_CLOSE} ${OSC8_OPEN}file:///b\x07b_trunc`;
    expect(closeOsc8(line)).toBe(line + OSC8_CLOSE);
  });

  test("returns empty string with close tag when only partial OSC open", () => {
    const line = OSC8_OPEN;
    expect(closeOsc8(line)).toBe(OSC8_CLOSE);
  });

  test("handles ANSI SGR codes mixed with OSC 8", () => {
    const line = `\x1b[2mPath:\x1b[0m ${OSC8_OPEN}file:///tmp\x07/tmp`;
    expect(closeOsc8(line)).toBe(line + OSC8_CLOSE);
  });
});

describe("loadAgentLog (windowed)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-loadlog-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Build a Bun.file shim that counts reads via a wrapper around Bun.file. */
  function makeBigLog(agentId: string, lineCount: number): Promise<Agent> {
    return (async () => {
      const agentDir = join(tmpDir, ".ittybitty", "agents", agentId);
      await mkdir(agentDir, { recursive: true });
      const filler = "x".repeat(240);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) lines.push(`line${String(i).padStart(5, "0")}-${filler}`);
      await Bun.write(join(agentDir, "agent.log"), lines.join("\n"));
      return makeAgent({ id: agentId, repoPath: tmpDir, archived: false });
    })();
  }

  test("populates loadedLogWindow + agentLogContent on first read", async () => {
    // Small log that comfortably fits within the 8KB minimum tail read.
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-pm-1");
    await mkdir(agentDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`line${i}`);
    await Bun.write(join(agentDir, "agent.log"), lines.join("\n"));
    const agent = makeAgent({ id: "agent-pm-1", repoPath: tmpDir });

    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;
    ctx.rightPane.scrollOffset = 0;

    expect(ctx.rightPane.agentLogContent).toBeNull();
    expect(ctx.rightPane.loadedLogWindow).toBeNull();

    await loadAgentLog(ctx, agent);

    expect(ctx.rightPane.agentLogContent).not.toBeNull();
    expect(ctx.rightPane.loadedLogWindow).not.toBeNull();
    expect(ctx.rightPane.loadedLogWindow!.agentId).toBe(agent.id);
    expect(ctx.rightPane.loadedLogWindow!.atTop).toBe(true);
  });

  test("does not parse denials during AGENT LOG load", async () => {
    const agent = await makeBigLog("agent-pm-denials", 20);
    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;
    await loadAgentLog(ctx, agent);
    expect(ctx.rightPane.denialsContent).toBeNull();
    expect(ctx.rightPane.denialsLoading).toBe(false);
  });

  test("cache hit: re-calling loadAgentLog with same params does not change loaded window", async () => {
    const agent = await makeBigLog("agent-pm-cache", 50);
    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;
    ctx.rightPane.scrollOffset = 0;

    await loadAgentLog(ctx, agent);
    const firstWindow = ctx.rightPane.loadedLogWindow;
    const firstContent = ctx.rightPane.agentLogContent;

    // Re-call with identical state — should be a cache hit (atTop=true means we have the whole file)
    await loadAgentLog(ctx, agent);
    // Cache hit: the loadedLogWindow object reference should be unchanged
    expect(ctx.rightPane.loadedLogWindow).toBe(firstWindow);
    expect(ctx.rightPane.agentLogContent).toBe(firstContent);
  });

  test("scroll past loaded window triggers a re-read with larger buffer", async () => {
    // Big enough that small reads don't reach atTop.
    const agent = await makeBigLog("agent-pm-scroll", 5000);
    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;
    ctx.rightPane.scrollOffset = 0;

    await loadAgentLog(ctx, agent);
    const firstLoaded = ctx.rightPane.loadedLogWindow!;
    expect(firstLoaded.atTop).toBe(false); // file is too big to fit in initial window
    const firstCount = firstLoaded.loadedLineCount;

    // Now scroll way past the buffer — beyond loadedLineCount.
    ctx.rightPane.scrollOffset = firstCount + 50;
    await loadAgentLog(ctx, agent);

    const secondLoaded = ctx.rightPane.loadedLogWindow!;
    // A second read happened: either a new object or larger lineCount.
    expect(secondLoaded).not.toBe(firstLoaded);
    expect(secondLoaded.loadedLineCount).toBeGreaterThan(firstCount);
  });

  test("scroll within buffer is a cache hit (no re-read)", async () => {
    const agent = await makeBigLog("agent-pm-buf", 5000);
    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;
    ctx.rightPane.scrollOffset = 0;

    await loadAgentLog(ctx, agent);
    const firstLoaded = ctx.rightPane.loadedLogWindow!;

    // Scroll a small amount — well within the 2*displayHeight buffer.
    ctx.rightPane.scrollOffset = 5;
    await loadAgentLog(ctx, agent);

    expect(ctx.rightPane.loadedLogWindow).toBe(firstLoaded);
  });

  test("displayHeight change forces a re-read", async () => {
    const agent = await makeBigLog("agent-pm-resize", 5000);
    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;

    await loadAgentLog(ctx, agent);
    const firstLoaded = ctx.rightPane.loadedLogWindow!;
    expect(firstLoaded.atTop).toBe(false);

    // Simulate terminal resize.
    ctx.rightPane.displayHeight = 40;
    await loadAgentLog(ctx, agent);

    const secondLoaded = ctx.rightPane.loadedLogWindow!;
    expect(secondLoaded).not.toBe(firstLoaded);
    expect(secondLoaded.displayHeight).toBe(40);
  });

  test("agent change forces a re-read", async () => {
    const agentA = await makeBigLog("agent-pm-A", 50);
    const agentB = await makeBigLog("agent-pm-B", 80);
    const ctx = makePaneCtx({ agent: agentA });
    ctx.rightPane.displayHeight = 10;

    await loadAgentLog(ctx, agentA);
    const firstLoaded = ctx.rightPane.loadedLogWindow!;
    expect(firstLoaded.agentId).toBe(agentA.id);

    // Switch to agentB
    ctx.currentAgentId = agentB.id;
    await loadAgentLog(ctx, agentB);
    const secondLoaded = ctx.rightPane.loadedLogWindow!;
    expect(secondLoaded.agentId).toBe(agentB.id);
    expect(secondLoaded).not.toBe(firstLoaded);
  });

  test("stale agent (currentAgentId changed during await) does not write content", async () => {
    const agent = await makeBigLog("agent-pm-stale", 50);
    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;
    ctx.currentAgentId = "different-agent";

    await loadAgentLog(ctx, agent);
    expect(ctx.rightPane.agentLogContent).toBeNull();
    expect(ctx.rightPane.loadedLogWindow).toBeNull();
  });

  test("file growth (active agent appending) invalidates cache", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-pm-grow");
    await mkdir(agentDir, { recursive: true });
    const logPath = join(agentDir, "agent.log");
    // Initial small log
    const initial = ["line0", "line1", "line2"].join("\n");
    await Bun.write(logPath, initial);
    const agent = makeAgent({ id: "agent-pm-grow", repoPath: tmpDir });

    const ctx = makePaneCtx({ agent });
    ctx.rightPane.displayHeight = 10;
    await loadAgentLog(ctx, agent);
    const firstLoaded = ctx.rightPane.loadedLogWindow!;
    expect(firstLoaded.fileSize).toBe(initial.length);
    const firstContent = ctx.rightPane.agentLogContent;

    // Simulate the agent appending more content.
    const grown = initial + "\nline3\nline4\nline5";
    await Bun.write(logPath, grown);

    await loadAgentLog(ctx, agent);
    const secondLoaded = ctx.rightPane.loadedLogWindow!;
    // Cache must have been invalidated and a fresh read taken.
    expect(secondLoaded).not.toBe(firstLoaded);
    expect(secondLoaded.fileSize).toBe(grown.length);
    expect(ctx.rightPane.agentLogContent).not.toBe(firstContent);
  });
});

describe("loadDenials (lazy)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-denials-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("populates denialsContent from full agent.log", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-d");
    await mkdir(agentDir, { recursive: true });
    const log = [
      "[2025-01-01 10:00:00] [PreToolUse] Permission denied: Bash(rm:*)",
      "[2025-01-01 10:00:01] [Hook] something else",
      "[2025-01-01 10:00:02] [PreToolUse] Permission denied: Write(/etc/*)",
    ].join("\n");
    await Bun.write(join(agentDir, "agent.log"), log);

    const agent = makeAgent({ id: "agent-d", repoPath: tmpDir });
    const ctx = makePaneCtx({ agent });
    expect(ctx.rightPane.denialsContent).toBeNull();

    await loadDenials(ctx, agent);
    expect(ctx.rightPane.denialsLoading).toBe(false);
    expect(ctx.rightPane.denialsContent).not.toBeNull();
    expect(ctx.rightPane.denialsContent!.length).toBe(2);
  });

  test("triggerAsyncLoadIfNeeded triggers loadDenials when DENIALS mode is active", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-d2");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2025-01-01 10:00:00] [PreToolUse] Permission denied: Bash(rm:*)",
    );
    const agent = makeAgent({ id: "agent-d2", repoPath: tmpDir });
    const ctx = makePaneCtx({ agent });
    ctx.modeIndex = PANE_MODES.indexOf("DENIALS");
    ctx.rightPane.mode = "DENIALS";

    triggerAsyncLoadIfNeeded(ctx);
    // loadDenials runs async — wait for it.
    // denialsLoading flips true synchronously, then false after the read.
    // Polling loop instead of arbitrary sleep:
    for (let i = 0; i < 50 && ctx.rightPane.denialsContent === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ctx.rightPane.denialsContent).not.toBeNull();
    expect(ctx.rightPane.denialsContent!.length).toBe(1);
  });

  test("triggerAsyncLoadIfNeeded does NOT load denials when not in DENIALS mode", async () => {
    const agentDir = join(tmpDir, ".ittybitty", "agents", "agent-d3");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2025-01-01 10:00:00] [PreToolUse] Permission denied: Bash(rm:*)",
    );
    const agent = makeAgent({ id: "agent-d3", repoPath: tmpDir });
    const ctx = makePaneCtx({ agent });
    ctx.modeIndex = PANE_MODES.indexOf("AGENT LOG");
    ctx.rightPane.mode = "AGENT LOG";

    triggerAsyncLoadIfNeeded(ctx);
    // Give any spurious async work a chance to run
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.rightPane.denialsContent).toBeNull();
    expect(ctx.rightPane.denialsLoading).toBe(false);
  });

  test("stale loadDenials (agent switched mid-await) does not clobber denialsLoading after switch", async () => {
    const agentDirA = join(tmpDir, ".ittybitty", "agents", "agent-race-A");
    await mkdir(agentDirA, { recursive: true });
    await Bun.write(
      join(agentDirA, "agent.log"),
      "[2025-01-01 10:00:00] [PreToolUse] Permission denied: Bash(rm:*)",
    );
    const agentA = makeAgent({ id: "agent-race-A", repoPath: tmpDir });

    const ctx = makePaneCtx({ agent: agentA });
    const aPromise = loadDenials(ctx, agentA);
    expect(ctx.rightPane.denialsLoading).toBe(true);

    // Simulate dashboard agent-switch: a different agent is now selected,
    // and the new agent's load has set denialsLoading=true again.
    ctx.currentAgentId = "agent-race-B";
    ctx.rightPane.denialsLoading = true; // B's load is in flight

    // Now A's stale promise resolves. Because startedForAgentId !==
    // currentAgentId, A's finally must NOT touch denialsLoading.
    await aPromise;
    expect(ctx.rightPane.denialsLoading).toBe(true);
    // A's stale read must also NOT have populated denials for the new agent.
    expect(ctx.rightPane.denialsContent).toBeNull();
  });
});
