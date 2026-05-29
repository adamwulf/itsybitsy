import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  getStateColors,
  setupColorSchemeDetection,
  parseOSC11Response,
  computeLuminance,
  writerCtx,
  resetColorScheme,
} from "./color-scheme";
import { BRIGHT_BLUE, BRIGHT_MAGENTA, BLUE, MAGENTA, YELLOW, RED } from "./colors";

/* ── helpers ────────────────────────────────────────────────── */

/** Collect all stdout writes during setup & interactions. */
function withCapture(fn: (writes: string[]) => void): string[] {
  const writes: string[] = [];
  writerCtx.set((d) => { writes.push(d); return true; });
  fn(writes);
  return writes;
}

beforeEach(() => {
  resetColorScheme();
  writerCtx.set(() => true); // suppress stdout by default
});

afterEach(() => {
  writerCtx.reset();
  resetColorScheme();
});

/* ── parseOSC11Response ─────────────────────────────────────── */

describe("parseOSC11Response", () => {
  test("parses 16-bit hex components", () => {
    const rgb = parseOSC11Response("rgb:ffff/ffff/ffff");
    expect(rgb).toEqual({ r: 1, g: 1, b: 1 });
  });

  test("parses 8-bit hex components", () => {
    const rgb = parseOSC11Response("rgb:00/00/00");
    expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
  });

  test("parses mixed-case hex", () => {
    const rgb = parseOSC11Response("rgb:FfFf/0000/8080");
    expect(rgb).not.toBeNull();
    expect(rgb!.r).toBeCloseTo(1, 2);
    expect(rgb!.g).toBe(0);
    expect(rgb!.b).toBeCloseTo(0x8080 / 0xffff, 4);
  });

  test("parses 8-bit mid-range values", () => {
    const rgb = parseOSC11Response("rgb:80/80/80");
    expect(rgb).not.toBeNull();
    expect(rgb!.r).toBeCloseTo(128 / 255, 3);
  });

  test("returns null for malformed input", () => {
    expect(parseOSC11Response("")).toBeNull();
    expect(parseOSC11Response("not-a-color")).toBeNull();
    expect(parseOSC11Response("rgb:zzzz/0000/0000")).toBeNull();
    expect(parseOSC11Response("rgb:ffff/ffff")).toBeNull();
  });
});

/* ── computeLuminance ───────────────────────────────────────── */

describe("computeLuminance", () => {
  test("black has luminance 0", () => {
    expect(computeLuminance(0, 0, 0)).toBe(0);
  });

  test("white has luminance 1", () => {
    expect(computeLuminance(1, 1, 1)).toBeCloseTo(1, 5);
  });

  test("pure green has highest weight (BT.709)", () => {
    const lr = computeLuminance(1, 0, 0);
    const lg = computeLuminance(0, 1, 0);
    const lb = computeLuminance(0, 0, 1);
    expect(lg).toBeGreaterThan(lr);
    expect(lg).toBeGreaterThan(lb);
  });

  test("mid-gray is ~0.5", () => {
    expect(computeLuminance(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 2);
  });
});

/* ── getStateColors ─────────────────────────────────────────── */

describe("getStateColors", () => {
  test("returns dark-scheme colors by default", () => {
    const colors = getStateColors();
    expect(colors.complete).toBe(BRIGHT_BLUE);
    expect(colors.compacting).toBe(BRIGHT_MAGENTA);
  });

  test("returns light-scheme colors after switching to light", () => {
    const { inputFilter } = setupColorSchemeDetection(() => {});
    // Feed a bright OSC 11 response (luminance > 0.5 → light)
    inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07");
    const colors = getStateColors();
    expect(colors.complete).toBe(BLUE);
    expect(colors.compacting).toBe(MAGENTA);
  });

  test("op states resolve to colors (dark): merging/restarting=YELLOW, op_stuck=RED", () => {
    const colors = getStateColors();
    expect(colors.merging).toBe(YELLOW);
    expect(colors.restarting).toBe(YELLOW);
    expect(colors.op_stuck).toBe(RED);
  });

  test("op states resolve to colors (light): merging/restarting=YELLOW, op_stuck=RED", () => {
    const { inputFilter } = setupColorSchemeDetection(() => {});
    inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07");
    const colors = getStateColors();
    expect(colors.merging).toBe(YELLOW);
    expect(colors.restarting).toBe(YELLOW);
    expect(colors.op_stuck).toBe(RED);
  });
});

/* ── setupColorSchemeDetection ──────────────────────────────── */

describe("setupColorSchemeDetection", () => {
  test("enables Ghostty mode 2031 on setup", () => {
    const writes = withCapture(() => {
      setupColorSchemeDetection(() => {});
    });
    expect(writes).toContain("\x1b[?2031h");
  });

  test("queryColorScheme writes OSC 11 query", () => {
    const writes: string[] = [];
    writerCtx.set((d) => { writes.push(d); return true; });
    const { queryColorScheme } = setupColorSchemeDetection(() => {});
    writes.length = 0; // clear setup writes
    queryColorScheme();
    expect(writes).toContain("\x1b]11;?\x07");
  });

  test("cleanup writes Ghostty disable and is idempotent", () => {
    const writes: string[] = [];
    writerCtx.set((d) => { writes.push(d); return true; });
    const { cleanup } = setupColorSchemeDetection(() => {});
    writes.length = 0;
    cleanup();
    expect(writes).toContain("\x1b[?2031l");
    writes.length = 0;
    cleanup(); // second call should be no-op
    expect(writes).toHaveLength(0);
  });
});

/* ── inputFilter: OSC 11 parsing ────────────────────────────── */

describe("inputFilter - OSC 11", () => {
  test("detects dark scheme from dark background (BEL terminator)", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    // Dark background: rgb:0000/0000/0000 → luminance 0 → dark (already default, no change callback)
    const consumed = inputFilter("\x1b]11;rgb:0000/0000/0000\x07");
    expect(consumed).toBe(true);
    expect(called).toBe(false); // dark→dark, no change
  });

  test("detects light scheme from bright background", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    const consumed = inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
    expect(getStateColors().complete).toBe(BLUE); // light scheme
  });

  test("detects dark scheme from dark background (ST terminator)", () => {
    const { inputFilter } = setupColorSchemeDetection(() => {});
    // First switch to light
    inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07");
    let called = false;
    const { inputFilter: filter2 } = setupColorSchemeDetection(() => { called = true; });
    // ST terminator: ESC backslash
    const consumed = filter2("\x1b]11;rgb:1010/1010/1010\x1b\\");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
    expect(getStateColors().complete).toBe(BRIGHT_BLUE); // dark scheme
  });

  test("handles 8-bit OSC 11 response", () => {
    let changed = false;
    const { inputFilter } = setupColorSchemeDetection(() => { changed = true; });
    inputFilter("\x1b]11;rgb:ff/ff/ff\x07");
    expect(changed).toBe(true);
    expect(getStateColors().complete).toBe(BLUE); // light
  });

  test("ignores malformed OSC 11 response", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    // Missing a component
    const consumed = inputFilter("\x1b]11;rgb:ffff/ffff\x07");
    expect(consumed).toBe(true); // still consumed (contains OSC 11 marker)
    expect(called).toBe(false); // but no scheme change
  });

  test("returns false for non-OSC data", () => {
    const { inputFilter } = setupColorSchemeDetection(() => {});
    expect(inputFilter("hello")).toBe(false);
    expect(inputFilter("\x1b[A")).toBe(false); // arrow key
  });
});

/* ── inputFilter: Ghostty mode 2031 ────────────────────────── */

describe("inputFilter - Ghostty mode 2031", () => {
  test("detects dark via Ghostty notification", () => {
    const { inputFilter } = setupColorSchemeDetection(() => {});
    // First switch to light
    inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07");
    let called = false;
    const { inputFilter: filter2 } = setupColorSchemeDetection(() => { called = true; });
    const consumed = filter2("\x1b[?2031;1m");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
    expect(getStateColors().complete).toBe(BRIGHT_BLUE);
  });

  test("detects light via Ghostty notification", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    const consumed = inputFilter("\x1b[?2031;2m");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
    expect(getStateColors().complete).toBe(BLUE);
  });

  test("handles Ghostty sequence embedded in other data", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    const consumed = inputFilter("prefix\x1b[?2031;2msuffix");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
  });
});

/* ── onSchemeChange callback ────────────────────────────────── */

describe("onSchemeChange callback", () => {
  test("not called when scheme stays the same", () => {
    let count = 0;
    const { inputFilter } = setupColorSchemeDetection(() => { count++; });
    // default is dark, send dark
    inputFilter("\x1b]11;rgb:0000/0000/0000\x07");
    expect(count).toBe(0);
  });

  test("called once per actual change", () => {
    let count = 0;
    const { inputFilter } = setupColorSchemeDetection(() => { count++; });
    inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07"); // dark→light
    inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07"); // light→light (no change)
    inputFilter("\x1b]11;rgb:0000/0000/0000\x07"); // light→dark
    expect(count).toBe(2);
  });
});

/* ── queryColorScheme timer behavior ────────────────────────── */

describe("queryColorScheme timer", () => {
  test("can be called multiple times without error", () => {
    const { queryColorScheme } = setupColorSchemeDetection(() => {});
    queryColorScheme();
    queryColorScheme();
    queryColorScheme();
    // No throw — previous timers are cleared on each call
  });

  test("each call writes OSC 11 query", () => {
    const writes: string[] = [];
    writerCtx.set((d) => { writes.push(d); return true; });
    const { queryColorScheme } = setupColorSchemeDetection(() => {});
    writes.length = 0;
    queryColorScheme();
    queryColorScheme();
    const queryCount = writes.filter((w) => w === "\x1b]11;?\x07").length;
    expect(queryCount).toBe(2);
  });

  test("cleanup cancels pending detection timer", () => {
    const { queryColorScheme, cleanup } = setupColorSchemeDetection(() => {});
    queryColorScheme();
    cleanup(); // should clear the detection timer without error
  });
});

/* ── cross-method detection ────────────────────────────────── */

describe("cross-method detection", () => {
  test("Ghostty notification overrides OSC 11 detection", () => {
    let count = 0;
    const { inputFilter } = setupColorSchemeDetection(() => { count++; });
    // OSC 11 → light
    inputFilter("\x1b]11;rgb:ffff/ffff/ffff\x07");
    expect(count).toBe(1);
    expect(getStateColors().complete).toBe(BLUE);
    // Ghostty → dark
    inputFilter("\x1b[?2031;1m");
    expect(count).toBe(2);
    expect(getStateColors().complete).toBe(BRIGHT_BLUE);
  });

  test("OSC 11 overrides Ghostty detection", () => {
    let count = 0;
    const { inputFilter } = setupColorSchemeDetection(() => { count++; });
    // Ghostty → light
    inputFilter("\x1b[?2031;2m");
    expect(count).toBe(1);
    expect(getStateColors().complete).toBe(BLUE);
    // OSC 11 → dark
    inputFilter("\x1b]11;rgb:0000/0000/0000\x07");
    expect(count).toBe(2);
    expect(getStateColors().complete).toBe(BRIGHT_BLUE);
  });
});

/* ── Ghostty no-op transitions ─────────────────────────────── */

describe("Ghostty no-op transitions", () => {
  test("Ghostty dark when already dark does not trigger callback", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    inputFilter("\x1b[?2031;1m"); // dark → dark
    expect(called).toBe(false);
  });

  test("Ghostty light when already light does not trigger callback", () => {
    let count = 0;
    const { inputFilter } = setupColorSchemeDetection(() => { count++; });
    inputFilter("\x1b[?2031;2m"); // dark → light (triggers)
    expect(count).toBe(1);
    inputFilter("\x1b[?2031;2m"); // light → light (no-op)
    expect(count).toBe(1);
  });
});

/* ── parseOSC11Response edge cases ─────────────────────────── */

describe("parseOSC11Response edge cases", () => {
  test("parses single-digit hex components", () => {
    const rgb = parseOSC11Response("rgb:f/f/f");
    expect(rgb).not.toBeNull();
    expect(rgb!.r).toBe(15 / 255);
    expect(rgb!.g).toBe(15 / 255);
    expect(rgb!.b).toBe(15 / 255);
  });

  test("parses 3-digit hex components", () => {
    const rgb = parseOSC11Response("rgb:fff/000/800");
    expect(rgb).not.toBeNull();
    // 3-digit hex: hex.length > 2, so normalize() uses max 0xffff
    expect(rgb!.r).toBeCloseTo(0xfff / 0xffff, 4);
    expect(rgb!.g).toBe(0);
    expect(rgb!.b).toBeCloseTo(0x800 / 0xffff, 4);
  });

  test("parses 4-digit hex components", () => {
    const rgb = parseOSC11Response("rgb:abcd/1234/5678");
    expect(rgb).not.toBeNull();
    expect(rgb!.r).toBeCloseTo(0xabcd / 0xffff, 4);
    expect(rgb!.g).toBeCloseTo(0x1234 / 0xffff, 4);
    expect(rgb!.b).toBeCloseTo(0x5678 / 0xffff, 4);
  });

  test("returns null for empty rgb values", () => {
    expect(parseOSC11Response("rgb://")).toBeNull();
  });
});

/* ── inputFilter with surrounding data ─────────────────────── */

describe("inputFilter with surrounding data", () => {
  test("OSC 11 response with data before it", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    const consumed = inputFilter("some-prefix\x1b]11;rgb:ffff/ffff/ffff\x07");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
    expect(getStateColors().complete).toBe(BLUE);
  });

  test("OSC 11 response with data before and after it", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    const consumed = inputFilter("pre\x1b]11;rgb:ffff/ffff/ffff\x07post");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
  });

  test("Ghostty exact match sequence", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    // Test the exact equality branch (data === GHOSTTY_LIGHT)
    const consumed = inputFilter("\x1b[?2031;2m");
    expect(consumed).toBe(true);
    expect(called).toBe(true);
  });
});

/* ── luminance threshold boundary ───────────────────────────── */

describe("luminance threshold", () => {
  test("luminance just below 0.5 is dark", () => {
    const { inputFilter } = setupColorSchemeDetection(() => {});
    // 0.49 luminance: need g≈0.49/0.7152≈0.685 → 0x6363/0xffff ≈ 0xafaf
    inputFilter("\x1b]11;rgb:0000/afaf/0000\x07");
    expect(getStateColors().complete).toBe(BRIGHT_BLUE); // dark
  });

  test("luminance at 0.5 is light", () => {
    let called = false;
    const { inputFilter } = setupColorSchemeDetection(() => { called = true; });
    // need luminance >= 0.5: g≈0.5/0.7152≈0.699 → 0xb300/0xffff ≈ 0.7004 → lum ≈ 0.501
    inputFilter("\x1b]11;rgb:0000/b300/0000\x07");
    expect(called).toBe(true);
    expect(getStateColors().complete).toBe(BLUE); // light
  });
});
