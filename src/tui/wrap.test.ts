import { test, expect, describe } from "bun:test";
import { wrapSingleLine, wrapLines } from "./wrap";
import { visibleWidth } from "@mariozechner/pi-tui";

describe("wrapSingleLine", () => {
  test("returns short line unchanged", () => {
    expect(wrapSingleLine("hello", 10)).toEqual(["hello"]);
  });

  test("wraps a long line into multiple segments", () => {
    const result = wrapSingleLine("abcdefghij", 4);
    expect(result).toEqual(["abcd", "efgh", "ij"]);
  });

  test("wraps exactly at width boundary", () => {
    const result = wrapSingleLine("abcdef", 3);
    expect(result).toEqual(["abc", "def"]);
  });

  test("handles empty string", () => {
    expect(wrapSingleLine("", 10)).toEqual([""]);
  });

  test("preserves ANSI codes without counting them toward width", () => {
    const line = "\x1b[31mred text here\x1b[0m";
    const result = wrapSingleLine(line, 8);
    // "red text" = 8 chars, " here" = 5 chars + reset
    expect(result.length).toBe(2);
    // First chunk should contain the red ANSI code
    expect(result[0]).toContain("\x1b[31m");
    expect(visibleWidth(result[0]!)).toBe(8);
    expect(visibleWidth(result[1]!)).toBe(5);
  });

  test("ANSI code at wrap boundary stays with current chunk", () => {
    // 4 visible chars, then ANSI, then 4 more visible chars
    const line = "abcd\x1b[32mefgh";
    const result = wrapSingleLine(line, 4);
    expect(result.length).toBe(2);
    expect(visibleWidth(result[0]!)).toBe(4);
    expect(visibleWidth(result[1]!)).toBe(4);
    // The ANSI code is consumed into the first chunk (after its 4 visible chars)
    expect(result[0]).toContain("\x1b[32m");
  });

  test("multiple ANSI codes in a single line", () => {
    const line = "\x1b[1m\x1b[31mbold red\x1b[0m normal";
    const result = wrapSingleLine(line, 10);
    // "bold red n" = 10 visible, "ormal" = 5
    // Actually: "bold red" = 8, " normal" = 7, total = 15
    expect(result.length).toBe(2);
    expect(result[0]).toContain("\x1b[1m");
    expect(result[0]).toContain("\x1b[31m");
  });

  test("returns original line when width is 0", () => {
    expect(wrapSingleLine("hello", 0)).toEqual(["hello"]);
  });

  test("wraps single-character width", () => {
    const result = wrapSingleLine("abc", 1);
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("handles wide characters (CJK) that take 2 columns", () => {
    // Each CJK character is 2 columns wide
    const line = "你好世界"; // 4 chars, 8 visible columns
    const result = wrapSingleLine(line, 4);
    // Should wrap at 4 visible columns = 2 CJK chars per line
    expect(result.length).toBe(2);
    expect(visibleWidth(result[0]!)).toBe(4);
    expect(visibleWidth(result[1]!)).toBe(4);
  });

  test("does not split a wide character across wrap boundary", () => {
    // "ab" = 2 cols, "你" = 2 cols. Width = 3 means "ab" fits (2), but adding "你" (2) would be 4 > 3
    const line = "ab你c";
    const result = wrapSingleLine(line, 3);
    expect(result.length).toBe(2);
    expect(visibleWidth(result[0]!)).toBe(2); // "ab" fits, "你" would exceed
    expect(result[1]).toContain("你");
  });

  test("handles non-letter CSI terminators (e.g. \\x1b[@)", () => {
    // CSI @ (0x40) is a valid CSI terminator per ECMA-48.
    // wrapSingleLine skips the sequence for width counting.
    // "abc" = 3 visible chars, then \x1b[@ (0 visible), then "def" = 3 visible.
    const line = "abc\x1b[@def";
    const result = wrapSingleLine(line, 3);
    // Wrap should treat it as 6 visible chars total → 2 chunks of 3
    expect(result.length).toBe(2);
    expect(result[0]).toContain("abc");
    expect(result[1]).toBe("def");
  });
});

describe("wrapLines", () => {
  test("splits on newlines and wraps each", () => {
    const text = "short\nabcdefghij";
    const result = wrapLines(text, 6);
    expect(result).toEqual(["short", "abcdef", "ghij"]);
  });

  test("handles empty text", () => {
    expect(wrapLines("", 10)).toEqual([""]);
  });

  test("preserves empty lines", () => {
    const text = "line1\n\nline3";
    const result = wrapLines(text, 20);
    expect(result).toEqual(["line1", "", "line3"]);
  });

  test("wraps multiple long lines", () => {
    const text = "aabbcc\nxxyyzz";
    const result = wrapLines(text, 4);
    expect(result).toEqual(["aabb", "cc", "xxyy", "zz"]);
  });

  test("handles ANSI codes across multiple lines", () => {
    const text = "\x1b[31mred\x1b[0m\n\x1b[32mgreen\x1b[0m";
    const result = wrapLines(text, 20);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("\x1b[31m");
    expect(result[1]).toContain("\x1b[32m");
  });
});
