import { test, expect, describe } from "bun:test";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

describe("ANSI passthrough validation", () => {
  test("visibleWidth ignores ANSI codes", () => {
    const styled = "\x1b[31mred text\x1b[0m";
    expect(visibleWidth(styled)).toBe(8); // "red text"
  });

  test("truncateToWidth preserves ANSI codes", () => {
    const styled = "\x1b[31mred text\x1b[0m";
    const truncated = truncateToWidth(styled, 5, "");
    // Should contain the red color code and first 5 chars
    expect(truncated).toContain("\x1b[31m");
    expect(visibleWidth(truncated)).toBeLessThanOrEqual(5);
  });

  test("pi-tui Text render preserves ANSI in lines", () => {
    // Text component's render returns string[] where each line must fit width
    // ANSI codes are zero-width, so they don't count against the width
    const line = "\x1b[32m✽ Processing\x1b[0m some task";
    const truncated = truncateToWidth(line, 25, "");
    expect(truncated).toContain("\x1b[32m");
    expect(visibleWidth(truncated)).toBeLessThanOrEqual(25);
  });

  test("SplitPane preserves ANSI across panes", async () => {
    const { SplitPane } = await import("./split-pane");

    const leftComponent = {
      render(w: number) { return [truncateToWidth("\x1b[31mleft\x1b[0m", w, "")]; },
      invalidate() {},
    };
    const rightComponent = {
      render(w: number) { return [truncateToWidth("\x1b[32mright\x1b[0m", w, "")]; },
      invalidate() {},
    };

    const split = new SplitPane(leftComponent, rightComponent, 20);
    const lines = split.render(50);
    expect(lines.length).toBe(1);
    // Both ANSI codes should be present
    expect(lines[0]).toContain("\x1b[31m");
    expect(lines[0]).toContain("\x1b[32m");
    // Total visible width should not exceed 50
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(50);
    // Left side is padded to 20, separator is 1, right has content
    expect(visibleWidth(lines[0])).toBeGreaterThanOrEqual(21);
  });
});
