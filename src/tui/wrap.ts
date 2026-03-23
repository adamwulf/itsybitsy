/**
 * ANSI-aware line wrapping for terminal output.
 * Wraps long lines at a given visible width, preserving ANSI escape codes.
 */

import { visibleWidth } from "@mariozechner/pi-tui";
import { stripAnsi } from "../parse-state";

/**
 * Check if a byte is a CSI sequence terminator (0x40-0x7E per ECMA-48).
 * This includes letters (A-Z, a-z) and symbols like @, [, \, ], ^, _, `, {, |, }, ~.
 */
function isCsiTerminator(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Wrap a single line to the given width, preserving ANSI codes.
 * Handles wide characters (CJK, emoji) by measuring each character's
 * visible width rather than assuming width 1.
 * Returns an array of wrapped line segments.
 */
export function wrapSingleLine(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (visibleWidth(line) <= width) return [line];

  const chunks: string[] = [];
  let current = "";
  let visWidth = 0;

  // Use Array.from to split into Unicode codepoints (not UTF-16 code units),
  // so surrogate pairs and multi-codepoint emoji are kept intact.
  const codepoints = Array.from(line);
  let i = 0;

  while (i < codepoints.length) {
    // Check for ANSI escape sequence: ESC [ ... terminator
    // ANSI sequences are pure ASCII, so codepoint indexing works fine here.
    if (codepoints[i] === "\x1b" && i + 1 < codepoints.length && codepoints[i + 1] === "[") {
      let j = i + 2;
      while (j < codepoints.length && !isCsiTerminator(codepoints[j]!.codePointAt(0)!)) {
        j++;
      }
      if (j < codepoints.length) j++; // include terminating byte
      current += codepoints.slice(i, j).join("");
      i = j;
      continue;
    }

    // Measure the visible width of this character (full codepoint)
    const char = codepoints[i]!;
    const charWidth = visibleWidth(char);

    // Check if adding this character would exceed the width
    if (visWidth + charWidth > width) {
      chunks.push(current);
      current = "";
      visWidth = 0;
    }

    current += char;
    visWidth += charWidth;
    i++;
  }

  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Wrap all lines in a multi-line string to the given width.
 * Splits on newlines first, then wraps each line individually.
 */
export function wrapLines(text: string, width: number): string[] {
  const result: string[] = [];
  for (const line of text.split("\n")) {
    result.push(...wrapSingleLine(line, width));
  }
  return result;
}

/**
 * Word-wrap a single line to the given width, breaking at spaces when possible.
 * Falls back to character-level wrapping for words longer than width.
 * ANSI-aware: escape sequences don't count toward visible width.
 */
export function wordWrapSingleLine(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (visibleWidth(line) <= width) return [line];

  const chunks: string[] = [];
  // Split into tokens: sequences of non-space chars and individual spaces
  const tokens: string[] = [];
  let current = "";
  for (const ch of Array.from(line)) {
    if (ch === " ") {
      if (current) { tokens.push(current); current = ""; }
      tokens.push(" ");
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  let lineStr = "";
  let lineWidth = 0;

  for (const token of tokens) {
    const tokenW = visibleWidth(token);

    // Skip spaces at the start of a new line
    if (token === " " && lineWidth === 0) continue;

    // If adding this token would exceed width
    if (lineWidth + tokenW > width) {
      // If this is a space, just skip it (acts as the break point)
      if (token === " ") {
        if (lineStr) { chunks.push(lineStr.trimEnd()); lineStr = ""; lineWidth = 0; }
        continue;
      }
      // Flush current line if it has content
      if (lineStr) { chunks.push(lineStr.trimEnd()); lineStr = ""; lineWidth = 0; }
      // If the word itself is wider than width, hard-wrap it
      if (tokenW > width) {
        const hardWrapped = wrapSingleLine(token, width);
        for (let i = 0; i < hardWrapped.length - 1; i++) {
          chunks.push(hardWrapped[i]!);
        }
        lineStr = hardWrapped[hardWrapped.length - 1]!;
        lineWidth = visibleWidth(lineStr);
        continue;
      }
    }

    lineStr += token;
    lineWidth += tokenW;
  }
  if (lineStr || chunks.length === 0) chunks.push(lineStr.trimEnd());
  return chunks;
}

/**
 * Word-wrap all lines in a multi-line string.
 * Splits on newlines first, then word-wraps each line.
 */
export function wordWrapLines(text: string, width: number): string[] {
  const result: string[] = [];
  for (const line of text.split("\n")) {
    result.push(...wordWrapSingleLine(line, width));
  }
  return result;
}

/**
 * Find the last two ─ separator lines from the bottom of wrapped tmux output.
 * Returns indices of the upper (first found going up) and lower (last found) separators.
 * Both are -1 if fewer than two separators are found.
 */
export function findLastTwoSeparators(wrapped: string[]): { upperIndex: number; lowerIndex: number } {
  let separatorCount = 0;
  let upperIndex = -1;
  let lowerIndex = -1;
  for (let i = wrapped.length - 1; i >= 0; i--) {
    const stripped = stripAnsi(wrapped[i]!).trim();
    if (stripped.length > 0 && /^─+$/.test(stripped)) {
      separatorCount++;
      if (separatorCount === 1) {
        lowerIndex = i;
      }
      upperIndex = i;
      if (separatorCount >= 2) break;
    }
  }
  if (separatorCount < 2) return { upperIndex: -1, lowerIndex: -1 };
  return { upperIndex, lowerIndex };
}

/** Pad or trim a lines array to an exact height by appending empty strings or slicing. */
export function padLines(lines: string[], height: number): string[] {
  while (lines.length < height) {
    lines.push("");
  }
  return lines.slice(0, height);
}
