/**
 * ANSI-aware line wrapping for terminal output.
 * Wraps long lines at a given visible width, preserving ANSI escape codes.
 */

import { visibleWidth } from "@mariozechner/pi-tui";
import { stripAnsi, isCodexStatusLine } from "../parse-state";

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

    // Skip spaces at the start of a CONTINUATION line (after a wrap point).
    // On the FIRST physical row (chunks.length === 0) we do NOT skip leading
    // spaces, so row 1 preserves its original leading indent WHEN the indent
    // plus the first word fit the width. (Dropping the indent would strip the
    // left margin off indented code and Claude's "  ⎿ " tool-result lines — the
    // panes this reflow set out to fix; those short-prefix lines always fit.)
    // This is not an absolute guarantee: if the indent plus a first token wider
    // than the width overflows row 1, that token still hard-wraps from the left
    // (below) and the indent is not carried onto its wrapped rows — the same
    // behavior as the pre-reflow code. An all-spaces line, or an indent >= width,
    // falls out the same way.
    if (token === " " && lineWidth === 0 && chunks.length > 0) continue;

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
 * Small memoized word-wrap cache shared by the tmux panes (the center
 * TmuxPaneComponent and the per-repo coordinator pane). rawOutput is the
 * UNWRAPPED logical capture (tmux -J); word-wrapping it to the pane width is
 * the per-poll cost. Render passes run several times between polls, so we
 * cache the wrapped form keyed on (raw identity, width). Each poll assigns a
 * fresh string to the source, so an identity check on `raw` is a correct
 * cache-invalidation key.
 */
export class WordWrapCache {
  private cache: { raw: string; width: number; wrapped: string[] } | null = null;

  /**
   * Word-wrap `raw` to `width`, reusing the memoized result when neither the
   * raw output nor the width changed since the last call. Uses word-wrap (break
   * at spaces, hard-wrap over-width tokens) so the whole -J logical buffer
   * renders at one consistent width — the same path as the center pane.
   */
  get(raw: string, width: number): string[] {
    const cache = this.cache;
    if (cache && cache.raw === raw && cache.width === width) {
      return cache.wrapped;
    }
    const wrapped = wordWrapLines(raw, width);
    this.cache = { raw, width, wrapped };
    return wrapped;
  }

  /** Drop the memoized result (call when the source is reset/cleared). */
  reset(): void {
    this.cache = null;
  }
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

/**
 * Result of slicing a CLI's input-box chrome off a tmux capture.
 *
 * `transcriptRaw` is the transcript above the input box, re-joined with `\n` so
 * it can be word-wrapped to the display width. `statusLines` are the CLI's chrome
 * BELOW the input separator (Claude's status bar, or codex's status bar + prompt
 * block) as UNWRAPPED logical lines — the caller truncates them to width, never
 * word-wraps them (a wrapped status bar would overflow the reserved overlay
 * rows).
 */
export interface ChromeSlice {
  transcriptRaw: string;
  statusLines: string[];
}

/**
 * Locate codex's input-box chrome within UNWRAPPED logical lines.
 * Anchors on the `›` prompt and the status bar (which together unambiguously
 * identify the interactive input area), returning the prompt line index plus the
 * status-bar..end span. Mirrors the previous wrapped-line detector, but operates
 * on logical lines so a pinned-width status bar / divider doesn't wrap into many
 * rows and confuse the anchors. Returns null when the chrome isn't present.
 */
export function findCodexInputChromeLogical(
  lines: string[],
): { promptIndex: number; statusIndex: number; endIndex: number } | null {
  let endIndex = lines.length - 1;
  while (endIndex >= 0 && stripAnsi(lines[endIndex]!).trim() === "") {
    endIndex--;
  }
  if (endIndex < 0) return null;

  let promptIndex = -1;
  for (let i = endIndex; i >= 0; i--) {
    if (/^›(?:\s|$)/.test(stripAnsi(lines[i]!).trimStart())) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex < 0) return null;

  let statusIndex = -1;
  for (let i = endIndex; i > promptIndex; i--) {
    if (isCodexStatusLine(stripAnsi(lines[i]!))) {
      statusIndex = i;
      break;
    }
  }
  if (statusIndex < 0) return null;

  return { promptIndex, statusIndex, endIndex };
}

/**
 * Split a tmux capture into its transcript and the CLI's input-box chrome,
 * detecting the chrome on the UNWRAPPED logical lines (NOT on wrapped rows).
 *
 * This is the crux of the pinned-width design: at the pinned tmux width an
 * input-box separator is a single ~1000-col logical line, but word-wrapping it
 * to a narrow display pane explodes it into many consecutive full-width
 * separator rows. Detecting chrome AFTER wrapping therefore mis-counts
 * separators (findLastTwoSeparators) or loses the `›`/status anchors
 * (findCodexInputChrome). Detecting on logical lines is width-independent and
 * exact.
 *
 * - Codex: anchor on the `›` prompt + status bar; transcript = everything above
 *   the prompt, statusLines = status-bar..end.
 * - Claude: find the last two `─` separators; transcript = everything above the
 *   upper separator, statusLines = everything below the lower separator (trailing
 *   blank padding stripped).
 * - No chrome found: the whole capture is the transcript, no status lines.
 */
export function computeChromeSlice(raw: string, isCodex: boolean): ChromeSlice {
  const lines = raw.split("\n");

  if (isCodex) {
    const chrome = findCodexInputChromeLogical(lines);
    if (!chrome) return { transcriptRaw: raw, statusLines: [] };
    return {
      transcriptRaw: lines.slice(0, chrome.promptIndex).join("\n"),
      statusLines: lines.slice(chrome.statusIndex, chrome.endIndex + 1),
    };
  }

  const { upperIndex, lowerIndex } = findLastTwoSeparators(lines);
  if (upperIndex < 0) return { transcriptRaw: raw, statusLines: [] };
  const statusLines = lowerIndex >= 0 && lowerIndex < lines.length - 1
    ? lines.slice(lowerIndex + 1)
    : [];
  // Strip trailing blank padding tmux appends below the live chrome.
  while (statusLines.length > 0 && stripAnsi(statusLines[statusLines.length - 1]!).trim() === "") {
    statusLines.pop();
  }
  return {
    transcriptRaw: lines.slice(0, upperIndex).join("\n"),
    statusLines,
  };
}
