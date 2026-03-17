import { test, expect, describe } from "bun:test";
import { wrapSingleLine, wrapLines, wordWrapSingleLine, wordWrapLines } from "./wrap";
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

  test("handles emoji at wrap boundary", () => {
    // "abcd" = 4 cols, "🎉" = 2 cols, "efg" = 3 cols. Width 4.
    // First chunk: "abcd" (4), second chunk: "🎉ef" (4), third chunk: "g" (1)
    const line = "abcd🎉efg";
    const result = wrapSingleLine(line, 4);
    expect(result.length).toBe(3);
    expect(result[0]).toBe("abcd");
    expect(result[1]).toBe("🎉ef");
    expect(visibleWidth(result[1]!)).toBe(4);
    expect(result[2]).toBe("g");
  });

  test("handles emoji in middle of line", () => {
    const line = "ab🎉cd";
    const result = wrapSingleLine(line, 4);
    // "ab" = 2, "🎉" = 2, total = 4 for first chunk
    expect(result[0]).toBe("ab🎉");
    expect(visibleWidth(result[0]!)).toBe(4);
  });

  test("handles surrogate pairs (non-BMP characters)", () => {
    // 𝕳 is U+1D573, encoded as surrogate pair in UTF-16
    const line = "a𝕳b𝕳c";
    const result = wrapSingleLine(line, 2);
    // Each character is 1 column wide; should not split surrogate pairs
    expect(result[0]).toBe("a𝕳");
    expect(result[1]).toBe("b𝕳");
    expect(result[2]).toBe("c");
  });

  test("handles CJK characters wrapping correctly", () => {
    // Each CJK char is 2 columns; width 5 fits 2 CJK chars (4 cols) but not 3 (6 cols)
    const line = "你好世界测试";
    const result = wrapSingleLine(line, 5);
    expect(result.length).toBe(3);
    expect(visibleWidth(result[0]!)).toBe(4);
    expect(visibleWidth(result[1]!)).toBe(4);
    expect(visibleWidth(result[2]!)).toBe(4);
  });

  test("handles emoji mixed with ANSI codes", () => {
    const line = "\x1b[31m🎉hello\x1b[0m";
    const result = wrapSingleLine(line, 4);
    // "🎉" = 2 cols, "he" = 2 cols → 4 cols first chunk
    expect(result.length).toBe(2);
    expect(result[0]).toContain("🎉");
    expect(result[0]).toContain("\x1b[31m");
    expect(visibleWidth(result[0]!)).toBe(4);
  });

  test("handles multi-emoji sequence", () => {
    const line = "🎉🎊🎈🎁";
    const result = wrapSingleLine(line, 4);
    // Each emoji is 2 cols wide; 2 per line
    expect(result.length).toBe(2);
    expect(result[0]).toBe("🎉🎊");
    expect(result[1]).toBe("🎈🎁");
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

describe("wordWrapSingleLine", () => {
  test("returns short line unchanged", () => {
    expect(wordWrapSingleLine("hello world", 20)).toEqual(["hello world"]);
  });

  test("wraps at word boundary", () => {
    const result = wordWrapSingleLine("hello world foo", 11);
    expect(result).toEqual(["hello world", "foo"]);
  });

  test("wraps long text at spaces", () => {
    const result = wordWrapSingleLine("one two three four five", 10);
    expect(result).toEqual(["one two", "three four", "five"]);
  });

  test("hard-wraps words longer than width", () => {
    const result = wordWrapSingleLine("abcdefghij short", 6);
    expect(result).toEqual(["abcdef", "ghij", "short"]);
  });

  test("handles empty string", () => {
    expect(wordWrapSingleLine("", 10)).toEqual([""]);
  });

  test("does not leave trailing spaces at wrap point", () => {
    const result = wordWrapSingleLine("hello world", 5);
    expect(result).toEqual(["hello", "world"]);
  });

  test("does not start new line with spaces", () => {
    const result = wordWrapSingleLine("ab   cd", 4);
    // "ab" fits, spaces are consumed at wrap point, "cd" on next line
    expect(result[0]).toBe("ab");
    expect(result[1]).toBe("cd");
  });

  test("handles width 0", () => {
    expect(wordWrapSingleLine("hello", 0)).toEqual(["hello"]);
  });

  test("preserves ANSI codes", () => {
    const line = "\x1b[31mhello world\x1b[0m";
    const result = wordWrapSingleLine(line, 7);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("\x1b[31m");
  });

  test("handles long path-like strings without spaces", () => {
    const path = "/Users/adam/Developer/bun/itsybitsy/.ittybitty/agents/agent-abc123/repo";
    const result = wordWrapSingleLine(path, 40);
    // No spaces, so falls back to character-level wrapping
    expect(result.length).toBe(2);
    expect(visibleWidth(result[0]!)).toBe(40);
  });

  test("wraps emoji-prefixed lines at word boundary", () => {
    const line = "⚠️ Remove stale directory and archive it";
    const result = wordWrapSingleLine(line, 25);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Every line should fit within width
    for (const segment of result) {
      expect(visibleWidth(segment)).toBeLessThanOrEqual(25);
    }
    // Lines should rejoin to original content (spaces consumed at break points)
    expect(result.join(" ")).toBe(line);
  });
});

describe("wordWrapLines", () => {
  test("splits on newlines then word-wraps", () => {
    const text = "short line\nthis is a longer line that should wrap";
    const result = wordWrapLines(text, 20);
    expect(result[0]).toBe("short line");
    expect(result.length).toBeGreaterThan(2);
  });

  test("preserves empty lines", () => {
    const text = "hello\n\nworld";
    const result = wordWrapLines(text, 20);
    expect(result).toEqual(["hello", "", "world"]);
  });
});
