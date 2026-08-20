import { test, expect, describe } from "bun:test";
import {
  wrapSingleLine, wrapLines, wordWrapSingleLine, wordWrapLines,
  computeChromeSlice, findCodexInputChromeLogical, findLastTwoSeparators,
  matchTableBlockEnd, reflowTable,
} from "./wrap";
import { stripAnsi } from "../parse-state";
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

  // F2: leading indentation on the FIRST physical row survives the wrap WHEN
  // the indent plus the first word fit the width. Continuation rows keep the old
  // behavior (leading spaces after a wrap point are still consumed). This is not
  // an absolute guarantee: if the indent plus a first token wider than the width
  // overflows row 1, the token hard-wraps from the left and the indent is not
  // carried — same as the pre-reflow code. The panes this reflow targeted
  // (indented code, "  ⎿ " tool-result lines) always have a short-enough prefix
  // to fit, so they preserve their indent; the exception is covered below.
  describe("preserves leading indentation on the first row when the indent+first word fit", () => {
    test("over-width indented code keeps its 4-space indent on row 1", () => {
      const line = "    const foo = bar + baz + qux + longer;";
      const result = wordWrapSingleLine(line, 20);
      expect(result.length).toBeGreaterThan(1);
      // Row 1 keeps the original 4-space indent.
      expect(result[0]!.startsWith("    ")).toBe(true);
      expect(result[0]).toBe("    const foo = bar");
    });

    test("over-width '  ⎿ '-style tool-result line keeps its indent on row 1", () => {
      const line = "  ⎿  Read src/tui/wrap.ts and confirmed the leading indent is preserved on row one";
      const result = wordWrapSingleLine(line, 30);
      expect(result.length).toBeGreaterThan(1);
      // The left margin ("  ⎿ ") is intact on the first row.
      expect(result[0]!.startsWith("  ⎿")).toBe(true);
    });

    test("continuation rows do not accumulate stray leading spaces", () => {
      const line = "    const foo = bar + baz + qux + longer;";
      const result = wordWrapSingleLine(line, 20);
      // Every row after the first was produced at a wrap point; none of them
      // should start with a space (leading spaces consumed on continuations).
      for (const row of result.slice(1)) {
        expect(row.startsWith(" ")).toBe(false);
      }
    });

    test("a fitting (short) indented line is returned verbatim", () => {
      const line = "    short indented line";
      const result = wordWrapSingleLine(line, 40);
      expect(result).toEqual([line]);
    });

    test("indent is NOT preserved when indent + an over-width first token overflows row 1", () => {
      // Documents the boundary of the row-1 guarantee (CLEANUP 3): when the
      // leading indent plus a first token wider than the width overflows, that
      // token hard-wraps from the left and the indent is dropped — the same
      // behavior as the pre-reflow code, not a regression. The targeted panes
      // ("  ⎿ ", indented code) never hit this because their prefix fits.
      const line = "      supercalifragilisticexpialidocious tail";
      const result = wordWrapSingleLine(line, 12);
      expect(result.length).toBeGreaterThan(1);
      // Row 1 does NOT keep the 6-space indent — the over-width token wraps left.
      expect(result[0]!.startsWith("      ")).toBe(false);
    });
  });
});

describe("separator collapse (─ divider truncation, pinned-width fix)", () => {
  // truncateToWidth preserves/closes ANSI styling, so a collapsed separator row
  // can carry a trailing reset — strip ANSI before matching the ─ run.
  const isSepRow = (r: string) => /^─+$/.test(stripAnsi(r).trim());

  test("a 1000-col ─ separator truncates to exactly ONE row at a narrow width", () => {
    const sep = "─".repeat(1000);
    const rows = wordWrapSingleLine(sep, 80);
    expect(rows.length).toBe(1);
    expect(visibleWidth(rows[0]!)).toBe(80);
    expect(isSepRow(rows[0]!)).toBe(true);
  });

  test("wordWrapLines collapses each of several logical separators to one row", () => {
    const sep = "─".repeat(1000);
    const text = ["content above", sep, "content between", sep, "content below"].join("\n");
    const rows = wordWrapLines(text, 40);
    // 3 content rows (each fits) + 2 collapsed separators = 5 rows total.
    expect(rows.length).toBe(5);
    expect(rows.filter(isSepRow).length).toBe(2);
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(40);
  });

  test("a separator already within width is returned unchanged (single row)", () => {
    const sep = "─".repeat(20);
    expect(wordWrapSingleLine(sep, 80)).toEqual([sep]);
  });

  test("ANSI-styled separator collapses to one row and stays within width", () => {
    // Dim-styled 1000-col separator (ANSI must not count toward width, and the
    // styling must be preserved through truncation).
    const styledSep = `\x1b[2m${"─".repeat(1000)}\x1b[0m`;
    const rows = wordWrapSingleLine(styledSep, 60);
    expect(rows.length).toBe(1);
    expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(60);
    expect(stripAnsi(rows[0]!).trim()).toMatch(/^─+$/);
  });

  test("prose around a separator is unaffected (only the ─ line collapses)", () => {
    const sep = "─".repeat(1000);
    const prose = "this is a normal long prose line that should still word-wrap across several rows as usual";
    const text = [prose, sep, prose].join("\n");
    const rows = wordWrapLines(text, 30);
    // Exactly one collapsed separator; the prose wrapped to multiple rows on both sides.
    expect(rows.filter(isSepRow).length).toBe(1);
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(30);
    // The prose words survive in order (joining all non-separator rows).
    const proseRows = rows.filter((r) => !isSepRow(r));
    expect(proseRows.join(" ").replace(/\s+/g, " ").trim()).toBe(`${prose} ${prose}`);
  });

  test("a heading with only SHORT (<4) ─ bookends is NOT treated as a separator (still wraps)", () => {
    // Guard on the titled-rule boundary: a bare ─ run collapses, and so does a
    // TITLED rule whose dash runs are long (≥4) — codex's "─ Worked for … ────…"
    // line. But a short-bookended heading like "── Section … ──" (2-dash ends, no
    // 4+ run) is prose, not a full-width rule, so it must still word-wrap.
    const notSep = "── Section: a long heading that keeps going well past the pane width ──";
    const rows = wordWrapSingleLine(notSep, 20);
    expect(rows.length).toBeGreaterThan(1);
  });

  describe("titled rule (codex '─ Worked for … ────…' divider)", () => {
    // Codex emits a horizontal rule with an inline title after each turn:
    //   ─ Worked for 3m 50s ───────────────…  (a 1-dash prefix, the label, then a
    // long dash run padding to the pinned tmux width). Because the label breaks
    // the pure-─ run, the bare-rule test alone lets it word-wrap into many rows at
    // a narrow display pane. It should collapse to one row like any other rule.
    const titled = "─ Worked for 3m 50s " + "─".repeat(195);

    test("collapses to exactly ONE row at a narrow width", () => {
      const rows = wordWrapSingleLine(titled, 80);
      expect(rows.length).toBe(1);
      expect(visibleWidth(rows[0]!)).toBe(80);
    });

    test("the collapsed row starts and ends with ─ (still reads as a rule)", () => {
      const rows = wordWrapSingleLine(titled, 80);
      const s = stripAnsi(rows[0]!).trim();
      expect(s.startsWith("─")).toBe(true);
      expect(s.endsWith("─")).toBe(true);
    });

    test("a titled rule already within width is returned unchanged", () => {
      const shortTitled = "─ done " + "─".repeat(10);
      expect(wordWrapSingleLine(shortTitled, 80)).toEqual([shortTitled]);
    });

    test("prose that merely starts and ends with a dash (no 4+ run) is NOT collapsed", () => {
      // Boundary: the 4+ ─-run requirement is what distinguishes a rule from a
      // sentence. This line begins and ends with a single ─ but has no long run,
      // so it wraps as normal prose rather than truncating.
      const prose =
        "─ this is a long sentence that happens to be bracketed by single dashes on each end ─";
      const rows = wordWrapSingleLine(prose, 20);
      expect(rows.length).toBeGreaterThan(1);
    });

    test("an ANSI-styled titled rule collapses and preserves styling", () => {
      const styled = `\x1b[2m─ Worked for 1m 2s ${"─".repeat(300)}\x1b[0m`;
      const rows = wordWrapSingleLine(styled, 60);
      expect(rows.length).toBe(1);
      expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(60);
      expect(stripAnsi(rows[0]!).trim().startsWith("─")).toBe(true);
    });
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

  // The tmux display path now feeds -J logical lines (long, unwrapped) into
  // wordWrapLines. These tests assert the reflow is correct for that shape.
  describe("-J logical-line reflow (tmux display path)", () => {
    test("re-wraps a long logical line to the target width, every output row bounded", () => {
      // A single logical line as tmux -J would return it — far wider than the
      // pane. We reflow it to width 40; nothing scrolls past that width.
      const logical =
        "The agent is currently editing the project file and has produced a very long status line that would previously have been hard-wrapped by tmux at the old window width and then displayed verbatim at the new width.";
      const width = 40;
      const result = wordWrapLines(logical, width);
      expect(result.length).toBeGreaterThan(1);
      for (const row of result) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
      // No word is split when it fits — joining rows back with spaces recovers
      // the original words in order (word-wrap, not char-wrap).
      expect(result.join(" ").replace(/\s+/g, " ").trim()).toBe(logical);
    });

    test("short newline-separated logical lines stay on their own rows (no rejoin)", () => {
      // -J keeps program-emitted newlines separate. Short lines under the width
      // must NOT be merged by the wrapper.
      const text = "line one\nline two\nline three";
      const result = wordWrapLines(text, 80);
      expect(result).toEqual(["line one", "line two", "line three"]);
    });

    test("an over-width unbroken token still hard-wraps and stays bounded", () => {
      // A path/URL with no spaces (worst case) must fall back to char-wrapping
      // so no output row exceeds the width.
      const token = "/Users/agent/very/deep/path/without/any/spaces/that/exceeds/the/pane/width/segment";
      const width = 20;
      const result = wordWrapLines(token, width);
      expect(result.length).toBeGreaterThan(1);
      for (const row of result) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
      // All the characters survive (no data lost during hard-wrap).
      expect(result.join("")).toBe(token);
    });

    test("wraps a realistic 200-logical-line buffer with every row within width", () => {
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(
          `logical line ${i}: ` +
          "some moderately long content that will need to reflow ".repeat(3),
        );
      }
      const width = 100;
      const result = wordWrapLines(lines.join("\n"), width);
      expect(result.length).toBeGreaterThan(200);
      for (const row of result) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    });
  });
});

describe("computeChromeSlice — chrome detection on UNWRAPPED logical lines", () => {
  const PIN = 1000; // pinned tmux width — separators are single ~PIN-col logical lines
  const sep = "─".repeat(PIN); // one Claude input-box separator as ONE logical line

  describe("Claude input chrome", () => {
    // A realistic Claude capture at the pinned width: transcript, then the
    // input box (separator, prompt line, separator), then the status bar.
    const claudeRaw = [
      "assistant: here is a reply line",
      "assistant: and a second reply line",
      sep,
      "> ",
      sep,
      "  ? for shortcuts",
    ].join("\n");

    test("slices the transcript at the upper separator (logical), status bar below the lower", () => {
      const slice = computeChromeSlice(claudeRaw, false);
      expect(slice.transcriptRaw).toBe(
        "assistant: here is a reply line\nassistant: and a second reply line"
      );
      expect(slice.statusLines).toEqual(["  ? for shortcuts"]);
    });

    test("a PIN-width separator does NOT leak into the wrapped transcript at a narrow pane", () => {
      // The bug this design fixes: detecting chrome AFTER wrapping would explode
      // the single 1000-col separator into ~13 rows at width 80 and mis-slice.
      // Detecting on logical lines first means the transcript never contains it.
      const slice = computeChromeSlice(claudeRaw, false);
      const wrapped = wordWrapLines(slice.transcriptRaw, 80);
      for (const row of wrapped) {
        expect(/^─+$/.test(row.trim())).toBe(false);
        expect(visibleWidth(row)).toBeLessThanOrEqual(80);
      }
    });

    test("finds the last two separators among many logical separators (input box, not content dividers)", () => {
      // Claude output can contain ─ dividers higher up; the input box is always
      // the LAST two, so the transcript keeps the earlier divider + its content.
      const raw = [
        "intro",
        sep,          // a content divider higher up
        "middle content",
        sep,          // input-box upper
        "> type here",
        sep,          // input-box lower
        "  status bar line",
      ].join("\n");
      const slice = computeChromeSlice(raw, false);
      expect(slice.transcriptRaw).toBe("intro\n" + sep + "\nmiddle content");
      expect(slice.statusLines).toEqual(["  status bar line"]);
    });

    test("strips trailing blank padding tmux appends below the status bar", () => {
      const raw = ["reply", sep, "> ", sep, "  status", "", "   ", ""].join("\n");
      const slice = computeChromeSlice(raw, false);
      expect(slice.statusLines).toEqual(["  status"]);
    });

    test("no separators found → whole capture is transcript, no status lines", () => {
      const raw = "just some output\nwith no input box at all";
      const slice = computeChromeSlice(raw, false);
      expect(slice.transcriptRaw).toBe(raw);
      expect(slice.statusLines).toEqual([]);
    });

    test("findLastTwoSeparators matches a PIN-width single logical separator", () => {
      const { upperIndex, lowerIndex } = findLastTwoSeparators([
        "content", sep, "prompt", sep,
      ]);
      expect(upperIndex).toBe(1);
      expect(lowerIndex).toBe(3);
    });
  });

  describe("Codex input chrome", () => {
    // Codex status bar (matches isCodexStatusLine) + the › prompt, at pin width.
    const codexStatus = "gpt-5-codex · ~/proj · Context 42% · 3h left";
    const codexRaw = [
      "codex: some transcript output",
      "codex: more output",
      "─".repeat(PIN), // codex content divider (must NOT be mistaken for input box)
      "› ",
      codexStatus,
    ].join("\n");

    test("anchors on the › prompt + status bar; transcript above the prompt", () => {
      const slice = computeChromeSlice(codexRaw, true);
      // Transcript is everything ABOVE the › prompt (including the content
      // divider, which is not the input box). The prompt line itself is dropped;
      // statusLines run from the status bar to the end — matching the historical
      // codex chrome slice (statusIndex..endIndex).
      expect(slice.transcriptRaw).toBe(
        "codex: some transcript output\ncodex: more output\n" + "─".repeat(PIN)
      );
      expect(slice.statusLines).toEqual([codexStatus]);
    });

    test("codex chrome status lines don't reintroduce a divider when wrapped at a narrow pane", () => {
      const slice = computeChromeSlice(codexRaw, true);
      const wrapped = wordWrapLines(slice.transcriptRaw, 60);
      // The content divider stays IN the transcript (it's above the prompt), so
      // it wraps — that's fine; what matters is the status/prompt are sliced off.
      expect(slice.statusLines).toContain(codexStatus);
      // Every transcript row is bounded to the pane width.
      for (const row of wrapped) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
    });

    test("findCodexInputChromeLogical returns null when no › prompt is present", () => {
      const noPrompt = ["output", "more output", codexStatus].join("\n");
      expect(findCodexInputChromeLogical(noPrompt.split("\n"))).toBeNull();
    });

    test("no codex chrome found → whole capture is transcript", () => {
      const raw = "codex output with no prompt or status bar";
      const slice = computeChromeSlice(raw, true);
      expect(slice.transcriptRaw).toBe(raw);
      expect(slice.statusLines).toEqual([]);
    });
  });
});

describe("wordWrapLines performance", () => {
  // This test exists to catch a wordWrapLines that stops scaling linearly —
  // "a regression that makes wrapping super-linear", as the original put it.
  //
  // It used to check that for a proxy: wrap 5000 lines, assert the elapsed
  // wall-clock was under 80ms. A duration budget cannot express that property
  // on a shared machine, because duration measures the machine as much as the
  // code. Measured here on identical work:
  //
  //   wall-clock, machine busy   59 - 263 ms   (4.4x spread, same work)
  //   CPU time,   machine busy   89 -  96 ms
  //   CPU time,   machine quiet  29 -  33 ms
  //
  // CPU time is the better instrument — it excludes time the scheduler took
  // the process away — but it is still not machine-invariant: the same wrap
  // costs 3x more CPU under memory pressure (page faults, cache thrashing,
  // frequency scaling). The old budget failed at 344ms of wall-clock in one
  // loaded run, and a CPU-time version of it still failed at 96ms in another.
  //
  // The ratio between two sizes, however, IS invariant, because both halves
  // are measured microseconds apart under whatever conditions currently hold.
  // Across the same busy/quiet swing above it moved only 1.98 -> 2.07.
  //
  // So the shape of the assertion changed: it now measures the thing the test
  // was always trying to protect (the growth rate) rather than a duration that
  // happens to correlate with it on an idle machine. Linear is ~2.0, an O(n^2)
  // regression is ~4.0, and the bound sits between them. bun's per-test
  // timeout remains the backstop for a catastrophic constant-factor blow-up.
  test("word-wraps a 5000-logical-line buffer at width 120 without super-linear growth", () => {
    // 5000 logical lines each ~1.7x the target width — representative of a full
    // scrollback of moderately-wrapped agent output. The memo in
    // TmuxPaneComponent keeps per-render cost O(1) between polls, but the first
    // wrap after each poll must still be fast enough for a ~1s cadence.
    // Half that size is wrapped alongside it purely to establish the slope.
    const build = (n: number): string => {
      const lines: string[] = [];
      for (let i = 0; i < n; i++) {
        lines.push(
          `row ${i} ` +
          "word ".repeat(40), // ~200 chars, ~1.7x width 120
        );
      }
      return lines.join("\n");
    };
    const width = 120;
    const halfText = build(2500);
    const fullText = build(5000);

    let fullRows: string[] = [];
    const cpuMs = (text: string): number => {
      const before = process.cpuUsage();
      const rows = wordWrapLines(text, width);
      const after = process.cpuUsage(before);
      if (text === fullText) fullRows = rows;
      return (after.user + after.system) / 1000;
    };

    // Warm up the JIT before measuring — the first passes run interpreted and
    // cost several times steady state, which is a property of the runtime
    // rather than of the algorithm.
    for (let i = 0; i < 2; i++) { cpuMs(halfText); cpuMs(fullText); }

    // Sanity: every output row of the full-size wrap is bounded.
    for (const row of fullRows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }

    // Best of N at each size: preemption, GC and page faults can only ever ADD
    // cost to a sample, so the minimum is the closest estimate of the true
    // cost. A super-linear regression inflates the full-size samples far more
    // than the half-size ones, so it survives this and trips the bound.
    let half = Infinity;
    let full = Infinity;
    for (let i = 0; i < 3; i++) {
      half = Math.min(half, cpuMs(halfText));
      full = Math.min(full, cpuMs(fullText));
    }

    // Doubling the input should roughly double the work. Linear ~2.0,
    // quadratic ~4.0 — fail in between.
    expect(full / half).toBeLessThan(3);

    // The ratio is blind to constant factors: a wordWrapLines that got 10x
    // slower while staying perfectly linear still measures ~2.0 and sails
    // through the check above. bun's per-test timeout is NOT a usable backstop
    // for that — this file sets no setDefaultTimeout, so the bound is 5s, and a
    // 10x regression costs ~2.5s of CPU across the whole test. It would take
    // roughly a 20x regression before anything failed.
    //
    // So keep an absolute bound too, sized from measurement rather than from
    // the nominal cost — sizing against the quiet number is exactly why the old
    // 80ms bound flaked. Measured `full` on this machine:
    //
    //   quiet                         33 - 35 ms
    //   14 CPU burners                32 - 36 ms   (CPU time excludes
    //                                               descheduling, so pure CPU
    //                                               contention barely moves it)
    //   pathological run, per 4449ed0 89 - 96 ms   (memory pressure — page
    //                                               faults and cache thrashing
    //                                               are real work charged to us)
    //
    // 300ms is ~8.5x nominal and ~3.1x the worst figure ever observed. The old
    // 80ms bound had only ~2.3x over nominal and did not clear the 96ms
    // pathological case AT ALL — it sat below it, which is exactly how it
    // failed a run that contained no regression.
    //
    // It still catches the case the ratio cannot: a 10x linear regression costs
    // ~330-360ms even on a quiet machine, and far more on a busy one. Measured
    // cutoff on this hardware is ~9x (8x lands at 285-310ms, right at the knee).
    // Constant-factor regressions below that remain uncaught by design — that
    // band cannot be distinguished from machine variance by any wall-clock or
    // CPU budget, which is what the ratio check above is for.
    //
    // Unlike the ratio, this bound IS machine-dependent: nominal is ~33ms here,
    // so on hardware ~3x slower nominal approaches 100ms and the margin is gone.
    // Re-measure before trusting 300 anywhere but a developer machine.
    expect(full).toBeLessThan(300);
  });
});

describe("box-chrome clip (╭╮╰╯ corners and │ rows, welcome-box fix)", () => {
  // Claude's session-start welcome box at the pinned width: a rounded-corner
  // titled top border, │-bordered content rows (with an interior │ column
  // divider), and a rounded bottom border. Each is ONE over-width logical line.
  const W = 1000;
  const topBorder = "╭─── Claude Code v2.1.237 " + "─".repeat(W - 27) + "╮";
  const row = "│ left cell content " + " ".repeat(200) + "│ right cell content" + " ".repeat(W - 240) + "│";
  const bottomBorder = "╰" + "─".repeat(W - 2) + "╯";

  test("rounded top border clips to ONE row ending in ╮", () => {
    const rows = wordWrapSingleLine(topBorder, 80);
    expect(rows.length).toBe(1);
    expect(visibleWidth(rows[0]!)).toBe(80);
    const s = stripAnsi(rows[0]!);
    expect(s.startsWith("╭─── Claude Code")).toBe(true);
    expect(s.endsWith("╮")).toBe(true);
  });

  test("rounded bottom border clips to ONE row ending in ╯", () => {
    const rows = wordWrapSingleLine(bottomBorder, 80);
    expect(rows.length).toBe(1);
    expect(visibleWidth(rows[0]!)).toBe(80);
    expect(stripAnsi(rows[0]!).endsWith("╯")).toBe(true);
  });

  test("│-bordered content row clips to ONE row ending in │", () => {
    const rows = wordWrapSingleLine(row, 80);
    expect(rows.length).toBe(1);
    expect(visibleWidth(rows[0]!)).toBe(80);
    const s = stripAnsi(rows[0]!);
    expect(s.startsWith("│")).toBe(true);
    expect(s.endsWith("│")).toBe(true);
  });

  test("the whole welcome box keeps one row per logical line", () => {
    const box = [topBorder, row, row, bottomBorder].join("\n");
    const rows = wordWrapLines(box, 80);
    expect(rows.length).toBe(4);
    for (const r of rows) expect(visibleWidth(r)).toBe(80);
  });

  test("a box line already within width is returned unchanged", () => {
    const small = "╭────── title ──────╮";
    expect(wordWrapSingleLine(small, 80)).toEqual([small]);
    const smallRow = "│ fits │";
    expect(wordWrapSingleLine(smallRow, 80)).toEqual([smallRow]);
  });

  test("ANSI-styled border clips to one row within width", () => {
    const styled = `\x1b[2m${topBorder}\x1b[0m`;
    const rows = wordWrapSingleLine(styled, 60);
    expect(rows.length).toBe(1);
    expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(60);
    expect(stripAnsi(rows[0]!).endsWith("╮")).toBe(true);
  });

  test("corner-bounded prose WITHOUT a 4+ ─ run still word-wraps (guard)", () => {
    // The ─{4,} requirement is what separates a box border from decorated
    // prose. A ╭…╮-bounded sentence with no dash run must keep wrapping.
    const prose = "╭ a decorated heading that keeps going well past the pane width and then some more ╮";
    const rows = wordWrapSingleLine(prose, 20);
    expect(rows.length).toBeGreaterThan(1);
  });

  test("square table rule lines (┌┬┐ / ├┼┤ / └┴┘) clip when over width", () => {
    // Table frames normally reflow as a block (see table reflow below); this
    // covers the per-line fallback for stray/malformed frame lines.
    const top = "┌" + "─".repeat(500) + "┬" + "─".repeat(500) + "┐";
    const mid = "├" + "─".repeat(500) + "┼" + "─".repeat(500) + "┤";
    const bot = "└" + "─".repeat(500) + "┴" + "─".repeat(500) + "┘";
    for (const [line, suffix] of [[top, "┐"], [mid, "┤"], [bot, "┘"]] as const) {
      const rows = wordWrapSingleLine(line, 40);
      expect(rows.length).toBe(1);
      expect(visibleWidth(rows[0]!)).toBe(40);
      expect(stripAnsi(rows[0]!).endsWith(suffix)).toBe(true);
    }
  });
});

describe("table reflow (┌┬┐ frames re-laid out at pane width)", () => {
  // Build a table the way Claude Code renders one at the pinned width: two-space
  // indent, columns sized to content, one space of padding per side.
  function renderTable(rows: string[][], widths: number[]): string[] {
    const rule = (l: string, m: string, r: string) =>
      "  " + l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
    const out = [rule("┌", "┬", "┐")];
    rows.forEach((cells, ri) => {
      if (ri > 0) out.push(rule("├", "┼", "┤"));
      out.push(
        "  │" + cells.map((c, i) => " " + c + " ".repeat(widths[i]! - c.length) + " │").join(""),
      );
    });
    out.push(rule("└", "┴", "┘"));
    return out;
  }

  const longA =
    "This deliberately long sentence keeps going well past two hundred characters so the rendered table grows very wide and stresses the reflow logic with plenty of words to redistribute across narrow wrapped cell rows.";
  const longB =
    "A second long cell engineered the same way so that two columns compete for the remaining width and the fair-share shrink has to split what is left between them evenly.";
  const wideTable = renderTable(
    [
      ["ID", "Description", "Notes", "Status"],
      ["1", longA, longB, "Open"],
      ["2", "Short.", "Short.", "Done"],
    ],
    [2, longA.length, longB.length, 6],
  );

  test("matchTableBlockEnd finds a full frame and rejects broken ones", () => {
    expect(matchTableBlockEnd(wideTable, 0)).toBe(wideTable.length - 1);
    // Not a top rule at start.
    expect(matchTableBlockEnd(wideTable, 1)).toBe(-1);
    // No bottom rule → not a table.
    expect(matchTableBlockEnd(wideTable.slice(0, -1), 0)).toBe(-1);
    // Prose interrupting the frame → not a table.
    const broken = [wideTable[0]!, "prose line", ...wideTable.slice(1)];
    expect(matchTableBlockEnd(broken, 0)).toBe(-1);
    // Rules only, no rows → not a table.
    expect(matchTableBlockEnd(["  ┌────┐", "  └────┘"], 0)).toBe(-1);
  });

  test("an over-width table reflows: every row fits, all cell words survive", () => {
    const W = 100;
    const rows = wordWrapLines(wideTable.join("\n"), W);
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(W);
    // The frame survives as a frame.
    expect(stripAnsi(rows[0]!).trim()).toMatch(/^┌[─┬]+┐$/);
    expect(stripAnsi(rows[rows.length - 1]!).trim()).toMatch(/^└[─┴]+┘$/);
    // Column count is preserved on the top rule.
    expect(stripAnsi(rows[0]!).trim().split("┬").length).toBe(4);
    // Every word of the long cells is still present (nothing clipped away).
    const joined = rows.join(" ");
    for (const word of `${longA} ${longB}`.split(" ")) {
      expect(joined).toContain(word.length > 20 ? word.slice(0, 20) : word);
    }
    // The two-space indent survives.
    expect(rows[0]!.startsWith("  ┌")).toBe(true);
  });

  test("a fitting table passes through byte-identical (colors intact)", () => {
    const small = renderTable(
      [
        ["Name", "Type"],
        ["Alpha", "Int"],
      ],
      [5, 4],
    ).map((l) => `\x1b[2m${l}\x1b[0m`);
    expect(wordWrapLines(small.join("\n"), 80)).toEqual(small);
  });

  test("narrow columns keep their natural width; only wide ones shrink", () => {
    const rows = wordWrapLines(wideTable.join("\n"), 100);
    // "ID", "Status", their cells: short columns render on one line unwrapped.
    expect(rows.some((r) => stripAnsi(r).includes("│ ID │"))).toBe(true);
    expect(rows.some((r) => stripAnsi(r).includes("│ Status │"))).toBe(true);
  });

  test("a long unbroken token hard-wraps inside its cell", () => {
    const url =
      "https://example.com/api/v1/resources/items?category=widgets&sort=descending&filter=active&page=42&limit=100&token=abcdefghijklmnopqrstuvwxyz0123456789";
    const table = renderTable(
      [
        ["Key", "Value"],
        ["endpoint", url],
      ],
      [8, url.length],
    );
    const W = 60;
    const rows = wordWrapLines(table.join("\n"), W);
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(W);
    // The URL is split across multiple cell rows but fully present.
    const rejoined = rows
      .map((r) => stripAnsi(r))
      .filter((r) => r.includes("│"))
      .map((r) => r.split("│")[2]?.trim() ?? "")
      .join("");
    expect(rejoined).toContain("token=abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("a │ inside cell text bails out to per-line clip (no explosion, no wrong table)", () => {
    const table = [
      "  ┌" + "─".repeat(500) + "┬────┐",
      "  │ cell with a │ pipe" + " ".repeat(480) + "│ ok │",
      "  └" + "─".repeat(500) + "┴────┘",
    ];
    const rows = wordWrapLines(table.join("\n"), 40);
    // One row per logical line — clipped, not word-wrapped into many rows.
    expect(rows.length).toBe(3);
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(40);
  });

  test("a pane too narrow for the column count bails out to per-line clip", () => {
    const rows = wordWrapLines(wideTable.join("\n"), 20);
    // 4 columns need ≥ 12 chars of text budget plus 15 of frame — 20 is too
    // narrow to reflow, so every logical line clips to one row.
    expect(rows.length).toBe(wideTable.length);
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(20);
  });

  test("reflowTable preserves inner rules between every row", () => {
    const reflowed = reflowTable(wideTable, 100)!;
    const rules = reflowed.filter((r) => /^├[─┼]+┤$/.test(stripAnsi(r).trim()));
    // The source has a rule between each of the 3 rows → 2 inner rules.
    expect(rules.length).toBe(2);
  });

  test("prose containing ┌ mid-line does not trigger table matching", () => {
    const prose = "the char ┌ appears here " + "x".repeat(200);
    const rows = wordWrapLines(prose, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join(" ")).toContain("appears here");
  });
});
