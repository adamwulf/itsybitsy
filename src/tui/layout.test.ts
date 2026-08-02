import { test, expect, describe, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { waitForValue } from "../test-utils";
import {
  loadLayout, saveLayout, saveLayoutDebounced, cancelPendingSave, flushPendingSave,
  setLayoutPath, resetLayoutPath, getLayoutPath,
  MIN_SIDEBAR, MAX_SIDEBAR,
} from "./layout";
import type { LayoutState } from "./layout";
import {
  getSavedSidebarWidth, getTmuxWidthForAgent, PINNED_TMUX_WIDTH,
} from "./widths";

// Two tests here wait out a real 500ms debounce timer and then a real file
// write. `waitForValue` defaults to a 4s bound, chosen in b54bd0f to fire just
// under bun's 5s default so a stuck wait reports WHAT it awaited instead of
// losing to a generic timeout — but that pairing leaves this file only 4s of
// headroom over a 500ms debounce, and a loaded machine eats it. Both were
// observed failing that way during this branch's load runs: once as
// "waitForValue timed out after 4000ms waiting for: debounced layout write",
// once as the whole test dying at 10.2s.
//
// Raising the per-test bound is only half the fix: at bun's 5s default the 4s
// wait still fires FIRST, so the extra headroom would be unreachable. The two
// waits below therefore carry an explicit DEBOUNCE_WAIT_MS that sits under this
// bound. Both numbers are FAILURE bounds, not waits — a wait returns the
// instant its value appears, so passing tests are unaffected and no assertion
// changes; they only decide how long a genuinely stuck write is tolerated.
setDefaultTimeout(30_000);

/** Failure bound for the debounce waits. Under the 30s per-test bound above. */
const DEBOUNCE_WAIT_MS = 20_000;

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
    // Not written yet. Checked SYNCHRONOUSLY: a debounce timer can only fire
    // once control returns to the event loop, so a synchronous check proves
    // "no write was scheduled inline" without racing the 500ms timer. The old
    // `await file.exists()` yielded first, so on a loaded machine the timer
    // could fire during that yield and the file could legitimately exist.
    expect(existsSync(path)).toBe(false);
    // Wait for the debounce timer AND the write it kicks off. The timer
    // callback calls saveLayout() without awaiting it, so "500ms have passed"
    // does not imply "the bytes are on disk" — wait for the real condition.
    const loaded = await waitForValue(() => loadLayout(), {
      timeoutMs: DEBOUNCE_WAIT_MS,
      message: "debounced layout write",
    });
    expect(loaded).toEqual(sampleLayout);
  });

  test("saveLayoutDebounced coalesces multiple calls", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 50 });
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 55 });
    saveLayoutDebounced({ ...sampleLayout, sidebarWidth: 60 });
    const loaded = await waitForValue(() => loadLayout(), {
      timeoutMs: DEBOUNCE_WAIT_MS,
      message: "coalesced layout write",
    });
    expect(loaded!.sidebarWidth).toBe(60);
  });

  test("cancelPendingSave prevents write", async () => {
    const path = join(tmpDir, "layout.json");
    setLayoutPath(path);
    saveLayoutDebounced(sampleLayout);
    cancelPendingSave();
    // Negative assertion — a fixed wait is correct here (there is no condition
    // to wait for, only the absence of one). Waiting longer than the 500ms
    // debounce can only make this stricter, so load cannot break it.
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

  test("pinnedRepoPaths round-trips through save then load", async () => {
    const withPins: LayoutState = {
      ...sampleLayout,
      pinnedRepoPaths: ["/repos/alpha", "/repos/beta"],
    };
    await saveLayout(withPins);
    const loaded = await loadLayout();
    expect(loaded).not.toBeNull();
    expect(loaded!.pinnedRepoPaths).toEqual(["/repos/alpha", "/repos/beta"]);
  });

  test("loadLayout tolerates a MISSING pinnedRepoPaths (rest of layout preserved)", async () => {
    // Simulates an old layout.json written before pins were persisted.
    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({
      sidebarWidth: 65,
      splitPaneLeftWidth: 85,
      heightOffsets: { tree: 1, info: 0, coordinator: 0 },
    }));
    const loaded = await loadLayout();
    expect(loaded).not.toBeNull();
    // The rest of the layout survives...
    expect(loaded!.sidebarWidth).toBe(65);
    expect(loaded!.splitPaneLeftWidth).toBe(85);
    // ...and the optional field is simply absent (not [] , not a rejection).
    expect(loaded!.pinnedRepoPaths).toBeUndefined();
  });

  test("loadLayout drops a MALFORMED pinnedRepoPaths without discarding the layout", async () => {
    // Non-array and array-with-non-strings are both rejected for the field
    // only — the valid rest of the layout must still load.
    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({
      sidebarWidth: 60,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
      pinnedRepoPaths: "not-an-array",
    }));
    const loadedA = await loadLayout();
    expect(loadedA).not.toBeNull();
    expect(loadedA!.sidebarWidth).toBe(60);
    expect(loadedA!.pinnedRepoPaths).toBeUndefined();

    await Bun.write(join(tmpDir, "layout.json"), JSON.stringify({
      sidebarWidth: 60,
      splitPaneLeftWidth: 80,
      heightOffsets: { tree: 0, info: 0, coordinator: 0 },
      pinnedRepoPaths: ["/repos/ok", 42, { nope: true }],
    }));
    const loadedB = await loadLayout();
    expect(loadedB).not.toBeNull();
    expect(loadedB!.sidebarWidth).toBe(60);
    expect(loadedB!.pinnedRepoPaths).toBeUndefined();
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
