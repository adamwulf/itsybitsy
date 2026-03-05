import { test, expect, describe } from "bun:test";
import { truncateToWidth, visibleWidth, Text, Container } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

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

  test("pi-tui Text component renders ANSI content", () => {
    // Text wraps content with word-wrapping. Verify ANSI codes survive.
    const ansiContent = "\x1b[32m✽ Processing\x1b[0m some task";
    const text = new Text(ansiContent, 0, 0);
    const lines = text.render(80);
    // At least one line should contain our ANSI code
    const hasAnsi = lines.some((l) => l.includes("\x1b[32m"));
    expect(hasAnsi).toBe(true);
  });

  test("custom component with ANSI in render() output", () => {
    // Simulate what dashboard components do — return ANSI-styled lines
    class AnsiComponent implements Component {
      invalidate() {}
      render(width: number): string[] {
        return [
          truncateToWidth("\x1b[1m\x1b[32mrunning\x1b[0m agent-123", width, ""),
          truncateToWidth("\x1b[31mrate_limited\x1b[0m agent-456", width, ""),
        ];
      }
    }

    const comp = new AnsiComponent();
    const lines = comp.render(40);
    expect(lines.length).toBe(2);
    // Bold+green code for "running"
    expect(lines[0]).toContain("\x1b[1m");
    expect(lines[0]).toContain("\x1b[32m");
    // Red code for "rate_limited"
    expect(lines[1]).toContain("\x1b[31m");
    // Visible widths should be within bounds
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(40);
    expect(visibleWidth(lines[1]!)).toBeLessThanOrEqual(40);
  });

  test("Container preserves ANSI from child components", () => {
    // Container renders children vertically — verify ANSI passes through
    const container = new Container();
    const text = new Text("\x1b[34mblue text\x1b[0m", 0, 0);
    container.addChild(text);
    const lines = container.render(80);
    const hasAnsi = lines.some((l) => l.includes("\x1b[34m"));
    expect(hasAnsi).toBe(true);
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
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(50);
    // Left side is padded to 20, separator is 1, right has content
    expect(visibleWidth(lines[0]!)).toBeGreaterThanOrEqual(21);
  });
});
