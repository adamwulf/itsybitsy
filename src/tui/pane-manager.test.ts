import { test, expect, describe } from "bun:test";
import { makeAgent } from "../test-utils";
import type { Agent, FlatEntry, PendingQuestion } from "../agents";
import {
  RightPaneComponent, PANE_MODES, FULL_WIDTH_MODES,
  cyclePaneMode, jumpToMode, triggerAsyncLoadIfNeeded,
  colorizeDiff, colorizeLog,
  closeOsc8, OSC8_OPEN, OSC8_CLOSE,
} from "./pane-manager";
import type { PaneCtx, PaneMode } from "./pane-manager";
import { stripAnsi } from "../parse-state";

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
