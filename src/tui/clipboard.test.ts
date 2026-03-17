import { test, expect, describe } from "bun:test";
import { isPasteData, extractBracketedPaste, insertTextIntoLines, resolvePasteText } from "./clipboard";

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
  test("bracketed paste returns extracted text", () => {
    const cb = () => {};
    expect(resolvePasteText("\x1b[200~hello\x1b[201~", cb)).toBe("hello");
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
});
