import { test, expect, describe } from "bun:test";
import { SplitPane } from "./split-pane";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

/** Minimal component that returns fixed lines */
function stubComponent(lines: string[]): Component {
  return {
    invalidate() {},
    render(_width: number) {
      return [...lines];
    },
  };
}

describe("SplitPane", () => {
  test("renders two components side-by-side with separator", () => {
    const left = stubComponent(["AAA", "BBB"]);
    const right = stubComponent(["111", "222"]);
    const sp = new SplitPane(left, right, 5, "|");

    const result = sp.render(20);
    expect(result.length).toBe(2);
    // Left should be padded to width 5, then separator, then right
    for (const line of result) {
      expect(line).toContain("|");
    }
    // First line: "AAA" padded to 5 chars + "|" + "111..."
    expect(result[0].startsWith("AAA  |")).toBe(true);
    expect(result[1].startsWith("BBB  |")).toBe(true);
  });

  test("left pane padded to exact leftWidth", () => {
    const left = stubComponent(["Hi"]);
    const right = stubComponent(["X"]);
    const sp = new SplitPane(left, right, 10, "|");

    const result = sp.render(30);
    // Left part should be exactly 10 visible chars before the separator
    const sepIdx = result[0].indexOf("|");
    const leftPart = result[0].slice(0, sepIdx);
    expect(visibleWidth(leftPart)).toBe(10);
  });

  test("right pane fills remainder after left and separator", () => {
    const left = stubComponent(["A"]);
    const right = stubComponent(["ABCDEFGHIJKLMNOPQRSTUVWXYZ"]);
    const totalWidth = 20;
    const leftWidth = 5;
    const sp = new SplitPane(left, right, leftWidth, "|");

    const result = sp.render(totalWidth);
    // Total visible width of each line should not exceed totalWidth
    expect(visibleWidth(result[0])).toBeLessThanOrEqual(totalWidth);
  });

  test("handles left having more lines than right", () => {
    const left = stubComponent(["L1", "L2", "L3"]);
    const right = stubComponent(["R1"]);
    const sp = new SplitPane(left, right, 5, "|");

    const result = sp.render(20);
    expect(result.length).toBe(3);
    // Lines 2 and 3 should have empty right side
    expect(result[2]).toContain("|");
    // Right side of line 3 should be empty/spaces
    const parts = result[2].split("|");
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  test("handles right having more lines than left", () => {
    const left = stubComponent(["L1"]);
    const right = stubComponent(["R1", "R2", "R3"]);
    const sp = new SplitPane(left, right, 5, "|");

    const result = sp.render(20);
    expect(result.length).toBe(3);
    // Lines 2 and 3 should still have separator
    for (const line of result) {
      expect(line).toContain("|");
    }
  });

  test("single-line components", () => {
    const left = stubComponent(["only"]);
    const right = stubComponent(["one"]);
    const sp = new SplitPane(left, right, 8, "|");

    const result = sp.render(30);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("|");
  });

  test("uses box-drawing separator by default", () => {
    const left = stubComponent(["A"]);
    const right = stubComponent(["B"]);
    const sp = new SplitPane(left, right, 5);

    const result = sp.render(20);
    expect(result[0]).toContain("│");
  });

  test("setLeft and setRight replace child components", () => {
    const left1 = stubComponent(["OLD"]);
    const right1 = stubComponent(["OLD"]);
    const sp = new SplitPane(left1, right1, 5, "|");

    sp.setLeft(stubComponent(["NEW"]));
    sp.setRight(stubComponent(["NEW"]));

    const result = sp.render(20);
    expect(result[0]).toContain("NEW");
    expect(result[0]).not.toContain("OLD");
  });

  test("setLeftWidth changes left column width", () => {
    const left = stubComponent(["A"]);
    const right = stubComponent(["B"]);
    const sp = new SplitPane(left, right, 5, "|");

    sp.setLeftWidth(12);
    const result = sp.render(30);
    const sepIdx = result[0].indexOf("|");
    const leftPart = result[0].slice(0, sepIdx);
    expect(visibleWidth(leftPart)).toBe(12);
  });

  test("left content wider than leftWidth gets truncated", () => {
    const left = stubComponent(["ABCDEFGHIJ"]); // 10 chars
    const right = stubComponent(["R"]);
    const sp = new SplitPane(left, right, 5, "|");

    const result = sp.render(20);
    const sepIdx = result[0].indexOf("|");
    const leftPart = result[0].slice(0, sepIdx);
    expect(visibleWidth(leftPart)).toBe(5);
  });

  test("empty components produce separator-only line", () => {
    const left = stubComponent([""]);
    const right = stubComponent([""]);
    const sp = new SplitPane(left, right, 5, "|");

    const result = sp.render(20);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("|");
    // Left part should be 5 spaces
    const sepIdx = result[0].indexOf("|");
    expect(sepIdx).toBe(5);
  });

  test("zero-length render arrays produce no output", () => {
    const left = stubComponent([]);
    const right = stubComponent([]);
    const sp = new SplitPane(left, right, 5, "|");

    const result = sp.render(20);
    expect(result.length).toBe(0);
  });
});
