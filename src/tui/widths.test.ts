import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import {
  mainWidth, leftPaneWidth, rightPaneWidth, maxLeftPaneWidth,
  clampLeftWidth, clampSidebarWidth, tmuxWidthForAgent,
  getLiveMainWidth, getLiveLeftPaneWidth, getLiveRightPaneWidth,
  getSavedTmuxWidth, getSavedSidebarWidth, getSavedMainWidth, getTmuxWidthForAgent,
  DEFAULT_TMUX_WIDTH,
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

  test("tmuxWidthForAgent returns left pane for non-coordinator", () => {
    const layout = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 90 };
    expect(tmuxWidthForAgent(layout, false)).toBe(90);
  });

  test("tmuxWidthForAgent returns mainWidth for coordinator", () => {
    const layout = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 90 };
    expect(tmuxWidthForAgent(layout, true)).toBe(139);
  });

  test("tmuxWidthForAgent for non-coordinator clamps to [MIN_LEFT_WIDTH, MAX_LEFT_WIDTH] only", () => {
    const layout = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 9999 };
    expect(tmuxWidthForAgent(layout, false)).toBe(MAX_LEFT_WIDTH);
    const layoutSmall = { terminalWidth: 200, sidebarWidth: 60, splitPaneLeftWidth: 1 };
    expect(tmuxWidthForAgent(layoutSmall, false)).toBe(MIN_LEFT_WIDTH);
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

  test("getSavedTmuxWidth returns DEFAULT_TMUX_WIDTH when no layout saved", async () => {
    expect(await getSavedTmuxWidth()).toBe(80);
  });

  test("getSavedTmuxWidth clamps extreme saved values", async () => {
    await saveLayout({ ...sample, splitPaneLeftWidth: 99999 });
    expect(await getSavedTmuxWidth()).toBe(MAX_LEFT_WIDTH);
    await saveLayout({ ...sample, splitPaneLeftWidth: 1 });
    expect(await getSavedTmuxWidth()).toBe(MIN_LEFT_WIDTH);
  });

  test("getSavedMainWidth = terminalWidth - savedSidebar - 1", async () => {
    await saveLayout({ ...sample, sidebarWidth: 70 });
    const expected = (process.stdout.columns ?? 80) - 70 - 1;
    expect(await getSavedMainWidth()).toBe(Math.max(1, expected));
  });

  test("getTmuxWidthForAgent: non-coordinator returns saved tmux width", async () => {
    await saveLayout(sample);
    expect(await getTmuxWidthForAgent(false)).toBe(await getSavedTmuxWidth());
  });

  test("getTmuxWidthForAgent: coordinator returns saved main width", async () => {
    await saveLayout(sample);
    expect(await getTmuxWidthForAgent(true)).toBe(await getSavedMainWidth());
  });

  test("DEFAULT_TMUX_WIDTH is 80", () => {
    expect(DEFAULT_TMUX_WIDTH).toBe(80);
  });
});
