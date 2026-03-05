/**
 * ANSI-aware line wrapping for terminal output.
 * Wraps long lines at a given visible width, preserving ANSI escape codes.
 */

import { visibleWidth } from "@mariozechner/pi-tui";

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
  let i = 0;

  while (i < line.length) {
    // Check for ANSI escape sequence: ESC [ ... terminator
    if (line[i] === "\x1b" && i + 1 < line.length && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !isCsiTerminator(line.charCodeAt(j))) {
        j++;
      }
      if (j < line.length) j++; // include terminating byte
      current += line.slice(i, j);
      i = j;
      continue;
    }

    // Measure the visible width of this character
    const char = line[i];
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
