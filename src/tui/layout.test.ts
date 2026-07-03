import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir, homedir } from "os";
import {
  loadLayout, saveLayout, saveLayoutDebounced, cancelPendingSave, flushPendingSave,
  setLayoutPath, resetLayoutPath, getLayoutPath,
  MIN_SIDEBAR, MAX_SIDEBAR,
} from "./layout";
import type { LayoutState } from "./layout";
import {
  getSavedTmuxWidth, getSavedSidebarWidth, getTmuxWidthForAgent, PINNED_TMUX_WIDTH,
} from "./widths";
import { MIN_LEFT_WIDTH, MAX_LEFT_WIDTH } from "./split-pane";

const sampleLayout: LayoutState = {
  sidebarWidth: 70,
  splitPaneLeftWidth: 90,
  heightOffsets: { tree: 2, info: -1, coordinator: -1 },
  repoCoordinatorHeightOffset: 0,
};

describe("layout persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "itsybitsy-layout-"));
    setLayoutPath(join(tmpDir, "layout.json"));
  });

  afterEach(async () => {
    cancelPendingSave();
    resetLayoutPath();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("loadLayout returns null when file does not exist", async () => {
    expect(await loadLayout()).toBeNull();
  });

  test("default layout path under bun test is NOT the real ~/.itsybitsy/layout.json", () => {
    // Regression: dashboard tests fire persistLayout() via simulated resize
    // keystrokes; before the NODE_ENV=test guard in layout.ts, those debounced
    // saves overwrote the user's real layout preferences on every `bun test`
    // run. The default (reset) path must point somewhere disposable.
    resetLayoutPath();
    expect(getLayoutPath()).not.toBe(join(homedir(), ".itsybitsy", "layout.json"));
  });

  test("saveLayout then loadLayout round-trips", async () => {
    await saveLayout(sampleLayout);
    const loaded = await loadLayout();
    expect(loaded).toEqual(sampleLayout);
  });

  test("loadLayout returns null for invalid JSON", async () => {
    await Bun.write(join(tmpDir, "layout.json"), "not json");
    expect(await loadLayout()).toBeNull();
  });

  test("loadLayout returns null for missing fields", async () => {
    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({ sidebarWidth: 60 }));
    expect(await loadLayout()).toBeNull();
  });

  test("loadLayout returns null for wrong types", async () => {
    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({
      sidebarWidth: "not a number",
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    }));
    expect(await loadLayout()).toBeNull();
  });

  test("loadLayout returns null for NaN values", async () => {
    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({
      sidebarWidth: NaN,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    }));
    expect(await loadLayout()).toBeNull();
  });

  test("loadLayout returns null for Infinity values", async () => {
    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({
      sidebarWidth: 60,
      splitPaneLeftWidth: Infinity,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
    }));
    expect(await loadLayout()).toBeNull();
  });

  test("saveLayout creates parent directory if needed", async () => {
    const nested = join(tmpDir, "sub", "dir", "layout.json");
    setLayoutPath(nested);
    await saveLayout(sampleLayout);
    const loaded = await loadLayout();
    expect(loaded).toEqual(sampleLayout);
  });

  test("saveLayoutDebounced writes after delay", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    saveLayoutDebounced(sampleLayout);
    // Not written yet
    const file = Bun.file(path);
    expect(await file.exists()).toBe(false);
    // Wait for debounce
    await new Promise((r) => setTimeout(r, 600));
    const loaded = await loadLayout();
    expect(loaded).toEqual(sampleLayout);
  });

  test("saveLayoutDebounced coalesces multiple calls", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 50 });
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 55 });
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 60 });
    await new Promise((r) => setTimeout(r, 600));
    const loaded = await loadLayout();
    expect(loaded!.sidebarWidth).toBe(60);
  });

  test("cancelPendingSave prevents write", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    saveLayoutDebounced(sampleLayout);
    cancelPendingSave();
    await new Promise((r) => setTimeout(r, 600));
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("flushPendingSave writes immediately without waiting for debounce", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    saveLayoutDebounced(sampleLayout);
    // Flush immediately — should write without waiting 500ms
    await flushPendingSave();
    const loaded = await loadLayout();
    expect(loaded).toEqual(sampleLayout);
  });

  test("flushPendingSave writes the latest state when multiple debounced calls", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 50 });
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 75 });
    await flushPendingSave();
    const loaded = await loadLayout();
    expect(loaded!.sidebarWidth).toBe(75);
  });

  test("flushPendingSave is a no-op when nothing is pending", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    // No saveLayoutDebounced call — flush should do nothing
    await flushPendingSave();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("loadLayout rounds fractional numeric fields", async () => {
    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({
      sidebarWidth: 60.7,
      splitPaneLeftWidth: 80.3,
      heightOffsets: { tree: 2.9, info: -1.1, coordinator: 0.5 },
      repoCoordinatorHeightOffset: 1.6,
    }));
    const loaded = await loadLayout();
    expect(loaded).not.toBeNull();
    expect(loaded!.sidebarWidth).toBe(61);
    expect(loaded!.splitPaneLeftWidth).toBe(80);
    expect(loaded!.heightOffsets.tree).toBe(3);
    expect(loaded!.heightOffsets.info).toBe(-1);
    expect(loaded!.heightOffsets.coordinator).toBe(1);
    expect(loaded!.repoCoordinatorHeightOffset).toBe(2);
  });

  test("getSavedTmuxWidth returns DEFAULT_TMUX_WIDTH when no layout saved", async () => {
    const width = await getSavedTmuxWidth();
    expect(width).toBe(80);
  });

  test("getSavedTmuxWidth clamps extreme saved values", async () => {
    await saveLayout({ ...sampleLayout, splitPaneLeftWidth: 99999 });
    expect(await getSavedTmuxWidth()).toBe(MAX_LEFT_WIDTH);
    await saveLayout({ ...sampleLayout, splitPaneLeftWidth: 1 });
    expect(await getSavedTmuxWidth()).toBe(MIN_LEFT_WIDTH);
  });

  test("getSavedSidebarWidth returns default when no layout saved", async () => {
    const width = await getSavedSidebarWidth();
    expect(width).toBe(60);
  });

  test("getSavedSidebarWidth clamps extreme saved values", async () => {
    await saveLayout({ ...sampleLayout, sidebarWidth: 99999 });
    expect(await getSavedSidebarWidth()).toBe(MAX_SIDEBAR);
    await saveLayout({ ...sampleLayout, sidebarWidth: 1 });
    expect(await getSavedSidebarWidth()).toBe(MIN_SIDEBAR);
  });

  test("getTmuxWidthForAgent returns PINNED_TMUX_WIDTH for a non-coordinator (window is pinned, never follows the pane)", async () => {
    await saveLayout({ ...sampleLayout, splitPaneLeftWidth: 90, sidebarWidth: 70 });
    expect(await getTmuxWidthForAgent(false)).toBe(PINNED_TMUX_WIDTH);
  });

  test("getTmuxWidthForAgent returns PINNED_TMUX_WIDTH for coordinators too", async () => {
    await saveLayout({ ...sampleLayout, splitPaneLeftWidth: 90, sidebarWidth: 70 });
    expect(await getTmuxWidthForAgent(true)).toBe(PINNED_TMUX_WIDTH);
  });
});
