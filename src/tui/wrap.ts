/**
 * ANSI-aware line wrapping for terminal output.
 * Wraps long lines at a given visible width, preserving ANSI escape codes.
 */

import { visibleWidth } from "@mariozechner/pi-tui";

/**
 * Wrap a single line to the given width, preserving ANSI codes.
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
    // Check for ANSI escape sequence: ESC [ ... letter
    if (line[i] === "\x1b" && i + 1 < line.length && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !isLetter(line.charCodeAt(j))) {
        j++;
      }
      if (j < line.length) j++; // include terminating letter
      current += line.slice(i, j);
      i = j;
      continue;
    }

    // Regular character — check if we need to wrap
    if (visWidth >= width) {
      chunks.push(current);
      current = "";
      visWidth = 0;
    }

    current += line[i];
    visWidth++;
    i++;
  }

  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
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
