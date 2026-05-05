import { test, expect, describe, beforeEach } from "bun:test";
import {
  isPasteData,
  extractBracketedPaste,
  insertTextIntoLines,
  resolvePasteText,
  resetPasteState,
  isPasteInProgress,
  cancelPaste,
} from "./clipboard";

describe("isPasteData", () => {
  test("single character is not paste", () => {
    expect(isPasteData("a")).toBe(false);
  });

  test("empty string is not paste", () => {
    expect(isPasteData("")).toBe(false);
  });

  test("multi-char printable text is paste", () => {
    expect(isPasteData("hello world")).toBe(true);
  });

  test("escape sequence is not paste", () => {
    expect(isPasteData("\x1b[A")).toBe(false); // arrow key
    expect(isPasteData("\x1b[200~text\x1b[201~")).toBe(false); // bracketed paste
  });

  test("control character at start is not paste", () => {
    expect(isPasteData("\x01hello")).toBe(false);
    expect(isPasteData("\x16abc")).toBe(false); // Ctrl+V prefix
  });

  test("text with newlines is paste", () => {
    expect(isPasteData("line1\nline2")).toBe(true);
  });

  test("text with tabs is paste", () => {
    expect(isPasteData("col1\tcol2")).toBe(true);
  });

  test("unicode text is paste", () => {
    expect(isPasteData("héllo wörld")).toBe(true);
  });
});

describe("extractBracketedPaste", () => {
  test("extracts text from bracketed paste", () => {
    expect(extractBracketedPaste("\x1b[200~hello world\x1b[201~")).toBe("hello world");
  });

  test("handles missing end marker", () => {
    expect(extractBracketedPaste("\x1b[200~hello world")).toBe("hello world");
  });

  test("returns null for non-bracketed data", () => {
    expect(extractBracketedPaste("hello")).toBeNull();
    expect(extractBracketedPaste("\x1b[A")).toBeNull();
  });

  test("extracts empty paste", () => {
    expect(extractBracketedPaste("\x1b[200~\x1b[201~")).toBe("");
  });

  test("extracts multiline paste", () => {
    expect(extractBracketedPaste("\x1b[200~line1\nline2\x1b[201~")).toBe("line1\nline2");
  });
});

describe("resolvePasteText", () => {
  beforeEach(() => {
    // Module-level paste state must be reset between tests so a leak from one
    // test cannot poison the next.
    resetPasteState();
  });

  test("bracketed paste returns extracted text", () => {
    const cb = () => {};
    expect(resolvePasteText("\x1b[200~hello\x1b[201~", cb)).toBe("hello");
    expect(isPasteInProgress()).toBe(false);
  });

  test("multi-char printable text returns the data", () => {
    const cb = () => {};
    expect(resolvePasteText("pasted text", cb)).toBe("pasted text");
  });

  test("single printable char returns null (not paste)", () => {
    const cb = () => {};
    expect(resolvePasteText("a", cb)).toBeNull();
  });

  test("escape sequence returns null", () => {
    const cb = () => {};
    expect(resolvePasteText("\x1b[A", cb)).toBeNull();
  });

  test("Ctrl+V returns null and triggers async callback", () => {
    let called = false;
    const cb = () => { called = true; };
    const result = resolvePasteText("\x16", cb);
    expect(result).toBeNull();
    // Async callback is triggered via readClipboard().then() — can't easily assert synchronously
  });
});

describe("resolvePasteText (chunked bracketed paste)", () => {
  beforeEach(() => {
    resetPasteState();
  });

  test("paste split across two chunks assembles correctly", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    // Chunk 1: start marker + partial content, no end marker.
    const r1 = resolvePasteText("\x1b[200~hello", cb);
    expect(r1).toBeNull();
    expect(isPasteInProgress()).toBe(true);
    expect(delivered).toEqual([]); // not delivered yet

    // Chunk 2: rest of content + end marker.
    const r2 = resolvePasteText("world\x1b[201~", cb);
    expect(r2).toBeNull(); // chunked paste delivers via callback, not return value
    expect(isPasteInProgress()).toBe(false);
    expect(delivered).toEqual(["helloworld"]);
  });

  test("paste split across three chunks assembles correctly", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    expect(resolvePasteText("\x1b[200~one ", cb)).toBeNull();
    expect(isPasteInProgress()).toBe(true);
    expect(resolvePasteText("two ", cb)).toBeNull();
    expect(isPasteInProgress()).toBe(true);
    expect(resolvePasteText("three\x1b[201~", cb)).toBeNull();
    expect(isPasteInProgress()).toBe(false);
    expect(delivered).toEqual(["one two three"]);
  });

  test("split paste preserves shell special characters", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    // Chunk boundary in the middle of a `$(...)` expression.
    expect(resolvePasteText("\x1b[200~$(echo ", cb)).toBeNull();
    expect(resolvePasteText('"hi")\x1b[201~', cb)).toBeNull();
    expect(delivered).toEqual(['$(echo "hi")']);
  });

  test("split paste preserves embedded newlines", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    expect(resolvePasteText("\x1b[200~line1\nline", cb)).toBeNull();
    expect(resolvePasteText("2\nline3\x1b[201~", cb)).toBeNull();
    expect(delivered).toEqual(["line1\nline2\nline3"]);
  });

  test("trailing data after end marker is dropped (consistent with single-chunk)", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    expect(resolvePasteText("\x1b[200~payload", cb)).toBeNull();
    expect(resolvePasteText("done\x1b[201~trailing", cb)).toBeNull();
    expect(delivered).toEqual(["payloaddone"]);
  });

  test("end marker arriving in the same chunk as start marker is single-chunk path", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    const result = resolvePasteText("\x1b[200~complete\x1b[201~", cb);
    expect(result).toBe("complete"); // returned synchronously
    expect(delivered).toEqual([]); // callback NOT invoked
    expect(isPasteInProgress()).toBe(false);
  });

  test("empty paste split where start marker is alone in first chunk", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    expect(resolvePasteText("\x1b[200~", cb)).toBeNull();
    expect(isPasteInProgress()).toBe(true);
    expect(resolvePasteText("\x1b[201~", cb)).toBeNull();
    expect(delivered).toEqual([""]);
  });

  test("cancelPaste discards buffered prefix so subsequent input is not swallowed", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    // Start a paste but never complete it (simulates the user pressing Escape
    // mid-paste, which is caught by the dialog handler before reaching here).
    expect(resolvePasteText("\x1b[200~partial-content", cb)).toBeNull();
    expect(isPasteInProgress()).toBe(true);

    cancelPaste();
    expect(isPasteInProgress()).toBe(false);

    // A subsequent multi-char paste must NOT be appended to the discarded
    // buffer — it should resolve as its own paste.
    const next = resolvePasteText("hello world", cb);
    expect(next).toBe("hello world");
    expect(delivered).toEqual([]); // nothing delivered via callback
  });

  test("back-to-back chunked pastes do not bleed into each other", () => {
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    // Paste A
    expect(resolvePasteText("\x1b[200~aaa", cb)).toBeNull();
    expect(resolvePasteText("AAA\x1b[201~", cb)).toBeNull();
    expect(delivered).toEqual(["aaaAAA"]);
    expect(isPasteInProgress()).toBe(false);

    // Paste B immediately afterwards
    expect(resolvePasteText("\x1b[200~bbb", cb)).toBeNull();
    expect(resolvePasteText("BBB\x1b[201~", cb)).toBeNull();
    expect(delivered).toEqual(["aaaAAA", "bbbBBB"]);
    expect(isPasteInProgress()).toBe(false);
  });

  test("continuation chunks containing escape codes mid-content are buffered verbatim", () => {
    // A bracketed paste content can legitimately contain ESC bytes (e.g. pasted
    // ANSI text). The buffering path must accept them — the only thing that
    // ends a paste is the literal PASTE_END sequence.
    const delivered: string[] = [];
    const cb = (text: string) => { delivered.push(text); };

    expect(resolvePasteText("\x1b[200~before-", cb)).toBeNull();
    expect(resolvePasteText("\x1b[31m-after\x1b[201~", cb)).toBeNull();
    expect(delivered).toEqual(["before-\x1b[31m-after"]);
  });
});

describe("insertTextIntoLines", () => {
  test("appends to last line for single-line text", () => {
    const lines = ["hello"];
    insertTextIntoLines(lines, " world");
    expect(lines).toEqual(["hello world"]);
  });

  test("splits multiline text across lines", () => {
    const lines = ["start"];
    insertTextIntoLines(lines, " end\nnew line\nthird");
    expect(lines).toEqual(["start end", "new line", "third"]);
  });

  test("handles empty initial lines", () => {
    const lines = [""];
    insertTextIntoLines(lines, "pasted");
    expect(lines).toEqual(["pasted"]);
  });

  test("handles text with Windows line endings", () => {
    const lines = [""];
    insertTextIntoLines(lines, "line1\r\nline2");
    expect(lines).toEqual(["line1", "line2"]);
  });

  test("appends to existing content on last line", () => {
    const lines = ["first", "second"];
    insertTextIntoLines(lines, " more");
    expect(lines).toEqual(["first", "second more"]);
  });

  test("strips tab characters from pasted TSV", () => {
    // pi-tui's visibleWidth() reports tab as 3 columns, but a real terminal
    // expands tab to the next 8-col tab stop (variable 1–8). The mismatch
    // breaks pi-tui's render-time width assertion. Sanitize tabs on input.
    const lines = [""];
    insertTextIntoLines(lines, "Role A\tFirst\tLast\tname@example.com");
    for (const line of lines) {
      expect(line).not.toContain("\t");
    }
  });

  test("strips control characters except newline", () => {
    const lines = [""];
    insertTextIntoLines(lines, "a\x01b\x07c\x1bd");
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        expect(code === 0x0a || code >= 0x20).toBe(true);
      }
    }
  });

  test("preserves newlines when splitting multi-line TSV", () => {
    const lines = [""];
    insertTextIntoLines(lines, "a\tb\nc\td");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).not.toContain("\t");
    }
  });
});

describe("wrapTextareaLines width invariant after paste", () => {
  test("pasted TSV does not produce wrapped lines wider than requested width", async () => {
    const { wrapTextareaLines } = await import("./dialog-handler");
    const { visibleWidth } = await import("@mariozechner/pi-tui");
    const lines = [""];
    // Anonymized TSV — placeholders, not real names/emails.
    insertTextIntoLines(lines, [
      "Role A\tFirst1\tLast1\tname1@example.com",
      "Role B\tFirst2\tLast2\tname2@example.com",
      "Role C\tFirst3\tLast3\tname3@example.com",
    ].join("\n"));

    const width = 76;
    const wrapped = wrapTextareaLines(lines, width);
    for (const line of wrapped) {
      // pi-tui's render-time assertion fails when a wrapped line's reported
      // width matches but its actual rendered width exceeds the boundary.
      // Sanitizing tabs on paste keeps reported and rendered widths aligned.
      expect(line).not.toContain("\t");
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
