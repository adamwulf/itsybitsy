import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import {
  mainWidth, leftPaneWidth, rightPaneWidth, maxLeftPaneWidth,
  clampLeftWidth, clampSidebarWidth, tmuxWidthForAgent,
  getLiveMainWidth, getLiveLeftPaneWidth, getLiveRightPaneWidth,
  getSavedSidebarWidth, getSavedMainWidth, getTmuxWidthForAgent,
  DEFAULT_TMUX_WIDTH, PINNED_TMUX_WIDTH,
} from "./widths";
import { saveLayout, setLayoutPath, resetLayoutPath, cancelPendingSave } from "./layout";
import type { LayoutState } from "./layout";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";
import { MIN_SIDEBAR, MAX_SIDEBAR, SIDEBAR_WIDTH } from "./sidebar";

describe("widths — pure math", () => {
  test("mainWidth = terminalWidth - sidebarWidth - 1", () => {
    expect(mainWidth(200, 60)).toBe(139);
    expect(mainWidth(140, 60)).toBe(79);
  });

  test("mainWidth clamps to >= 1 for tiny terminals", () => {
    expect(mainWidth(60, 60)).toBe(1);
    expect(mainWidth(50, 60)).toBe(1);
  });

  test("leftPaneWidth honors splitPaneLeftWidth when room", () => {
    expect(leftPaneWidth(139, 80)).toBe(80);
  });

  test("leftPaneWidth clamps to mainWidth - 2 (must leave 1col for right pane + 1col for inner sep)", () => {
    expect(leftPaneWidth(50, 100)).toBe(48);
  });

  test("leftPaneWidth never returns < 1", () => {
    expect(leftPaneWidth(1, 100)).toBe(1);
    expect(leftPaneWidth(2, 100)).toBe(1);
  });

  test("rightPaneWidth = mainWidth - leftPaneWidth - 1", () => {
    expect(rightPaneWidth(139, 80)).toBe(58);
  });

  test("rightPaneWidth gets at least 1 column when split is at the boundary", () => {
    expect(rightPaneWidth(50, 100)).toBe(1);
  });

  test("maxLeftPaneWidth = mainWidth - 2", () => {
    expect(maxLeftPaneWidth(139)).toBe(137);
    expect(maxLeftPaneWidth(2)).toBe(1);
    expect(maxLeftPaneWidth(1)).toBe(1);
  });

  test("clampLeftWidth respects MIN_LEFT_WIDTH, MAX_LEFT_WIDTH, and maxLeftPaneWidth", () => {
    expect(clampLeftWidth(200, 100)).toBe(100);
    expect(clampLeftWidth(200, 9999)).toBe(MAX_LEFT_WIDTH);
    expect(clampLeftWidth(200, 1)).toBe(MIN_LEFT_WIDTH);
    expect(clampLeftWidth(50, 100)).toBe(48); // mainWidth - 2 wins
  });

  test("clampSidebarWidth respects MIN_SIDEBAR / MAX_SIDEBAR", () => {
    expect(clampSidebarWidth(60)).toBe(60);
    expect(clampSidebarWidth(0)).toBe(MIN_SIDEBAR);
    expect(clampSidebarWidth(9999)).toBe(MAX_SIDEBAR);
  });

  test("tmuxWidthForAgent returns PINNED_TMUX_WIDTH for a non-coordinator (never follows the pane)", () => {
    const layout = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 90 };
    expect(tmuxWidthForAgent(layout, false)).toBe(PINNED_TMUX_WIDTH);
  });

  test("tmuxWidthForAgent returns PINNED_TMUX_WIDTH for a coordinator too", () => {
    const layout = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 90 };
    expect(tmuxWidthForAgent(layout, true)).toBe(PINNED_TMUX_WIDTH);
  });

  test("tmuxWidthForAgent ignores splitPaneLeftWidth entirely (pin is independent of layout)", () => {
    const wide = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 9999 };
    const narrow = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 1 };
    expect(tmuxWidthForAgent(wide, false)).toBe(PINNED_TMUX_WIDTH);
    expect(tmuxWidthForAgent(narrow, false)).toBe(PINNED_TMUX_WIDTH);
    expect(tmuxWidthForAgent(wide, true)).toBe(PINNED_TMUX_WIDTH);
  });
});

describe("widths — live wrappers", () => {
  test("getLive* wrappers compose mainWidth, leftPaneWidth, rightPaneWidth", () => {
    const input = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 80 };
    expect(getLiveMainWidth(input)).toBe(139);
    expect(getLiveLeftPaneWidth(input)).toBe(80);
    expect(getLiveRightPaneWidth(input)).toBe(58);
  });

  test("getLiveLeftPaneWidth + 1 + getLiveRightPaneWidth == getLiveMainWidth", () => {
    const input = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 80 };
    const mw = getLiveMainWidth(input);
    const lw = getLiveLeftPaneWidth(input);
    const rw = getLiveRightPaneWidth(input);
    expect(lw + 1 + rw).toBe(mw);
  });
});

describe("widths — saved (disk-backed) wrappers", () => {
  let tmpDir: string;
  const sample: LayoutState = {
    sidebarWidth: 70,
    splitPaneLeftWidth: 90,
    heightOffsets: { tree: 2, info: -1, coordinator: -1 },
    repoCoordinatorHeightOffset: 0,
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-widths-"));
    setLayoutPath(join(tmpDir, "layout.json"));
  });

  afterEach(async () => {
    cancelPendingSave();
    resetLayoutPath();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("getSavedSidebarWidth returns default when no layout", async () => {
    expect(await getSavedSidebarWidth()).toBe(SIDEBAR_WIDTH);
  });

  test("getSavedSidebarWidth clamps extreme values", async () => {
    await saveLayout({ ...sample, sidebarWidth: 99999 });
    expect(await getSavedSidebarWidth()).toBe(MAX_SIDEBAR);
    await saveLayout({ ...sample, sidebarWidth: 1 });
    expect(await getSavedSidebarWidth()).toBe(MIN_SIDEBAR);
  });

  test("getSavedMainWidth = terminalWidth - savedSidebar - 1", async () => {
    await saveLayout({ ...sample, sidebarWidth: 70 });
    const expected = (process.stdout.columns ?? 80) - 70 - 1;
    expect(await getSavedMainWidth()).toBe(Math.max(1, expected));
  });

  test("getTmuxWidthForAgent: non-coordinator returns PINNED_TMUX_WIDTH", async () => {
    await saveLayout(sample);
    expect(await getTmuxWidthForAgent(false)).toBe(PINNED_TMUX_WIDTH);
  });

  test("getTmuxWidthForAgent: coordinator also returns PINNED_TMUX_WIDTH", async () => {
    await saveLayout(sample);
    expect(await getTmuxWidthForAgent(true)).toBe(PINNED_TMUX_WIDTH);
  });

  test("getTmuxWidthForAgent ignores saved layout — pin is layout-independent", async () => {
    await saveLayout({ ...sample, splitPaneLeftWidth: 40, sidebarWidth: 100 });
    expect(await getTmuxWidthForAgent(false)).toBe(PINNED_TMUX_WIDTH);
    expect(await getTmuxWidthForAgent(true)).toBe(PINNED_TMUX_WIDTH);
  });

  test("DEFAULT_TMUX_WIDTH is 80", () => {
    expect(DEFAULT_TMUX_WIDTH).toBe(80);
  });

  test("PINNED_TMUX_WIDTH is 1000 (verified safe: claude renders its TUI at 1000 without capping)", () => {
    expect(PINNED_TMUX_WIDTH).toBe(1000);
  });
});
