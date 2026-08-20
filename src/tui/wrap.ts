/**
 * ANSI-aware line wrapping for terminal output.
 * Wraps long lines at a given visible width, preserving ANSI escape codes.
 */

import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { stripAnsi, isCodexStatusLine } from "../parse-state";

/**
 * A "separator" line is a full-width visual divider, not prose — Claude's
 * input-box separators and codex's content dividers between output blocks. At
 * the pinned tmux width these are single ~1000-col logical lines, and
 * word-wrapping one would explode it into ~N/width full-width separator rows that
 * swallow the pane. Truncating a divider to the pane width is semantically
 * correct at any width, so the word-wrap path special-cases them (see
 * wordWrapSingleLine).
 *
 * Two shapes qualify:
 *
 *  1. A bare rule — the entire visible content is a run of ─ box-drawing chars
 *     (`────…`).
 *  2. A TITLED rule — a run of ─ on each side with a short inline label between
 *     them (`─ Worked for 3m 50s ────…`). Codex emits these after each turn.
 *     Because the label breaks the pure-─ run, the bare-rule test alone lets the
 *     line fall through to word-wrapping and it explodes into many rows at narrow
 *     display widths — the exact bug this branch handles.
 *
 * The titled-rule test requires the trimmed line to both start AND end with ─
 * and to contain a run of at least four consecutive ─ (a length prose never
 * produces). Those three structural signals together are what no ordinary
 * sentence satisfies — prose does not simultaneously begin and end with a
 * box-drawing char while also carrying a 4+ run of them — so the label between
 * the runs may be any text (ASCII or not) without risking a false match.
 */
function isSeparatorLine(line: string): boolean {
  const stripped = stripAnsi(line).trim();
  if (stripped.length === 0) return false;
  // Bare rule: entirely ─.
  if (/^─+$/.test(stripped)) return true;
  // Titled rule: ─-run … short label … ─-run.
  return (
    stripped.startsWith("─") &&
    stripped.endsWith("─") &&
    /─{4,}/.test(stripped)
  );
}

/**
 * A box-chrome line is one physical edge of a box-drawing frame: the bordered
 * welcome box Claude prints at session start (`╭─── Claude Code … ───╮`, `│ … │`
 * rows, `╰───…───╯`) and the table frames it renders for markdown tables
 * (`┌──┬──┐`, `├──┼──┤`, `│ … │`, `└──┴──┘`). Like the ─ separators above,
 * these are single ~pinned-width logical lines that word-wrap would explode
 * into many garbled rows. Unlike a bare rule, they carry a closing border char
 * that plain truncation would cut off — so the wrap path clips them to the pane
 * width and re-attaches that closing char, keeping the frame's right edge
 * straight at the pane edge (a horizontal viewport onto the box).
 *
 * Returns the border char to re-attach (truncateToWidth's "ellipsis", counted
 * inside the width and preceded by a reset so styling can't leak into it), or
 * null when the line is not box chrome.
 *
 * Two shapes qualify:
 *
 *  1. A border rule — opens with a corner/tee (╭ ╰ ┌ └ ├), closes with one
 *     (╮ ╯ ┐ ┘ ┤), and carries a 4+ run of ─ (same structural signal as the
 *     titled-rule test above; prose never opens AND closes with box-drawing
 *     chars while also carrying a 4+ ─ run).
 *  2. A content row — opens and closes with │. Prose essentially never starts
 *     and ends with │; boxes and tables always do.
 */
function boxClipSuffix(line: string): string | null {
  const stripped = stripAnsi(line).trim();
  if (stripped.length < 2) return null;
  const first = stripped[0]!;
  const last = stripped[stripped.length - 1]!;
  if ("╭╰┌└├".includes(first) && "╮╯┐┘┤".includes(last) && /─{4,}/.test(stripped)) {
    return last;
  }
  if (first === "│" && last === "│") return "│";
  return null;
}

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

  // A full-width ─ separator/divider is a visual element, not prose — truncate
  // it to the pane width (one row) instead of word-wrapping it into many rows.
  // This one rule collapses every over-width separator on every display surface:
  // untrimmed system/repo coordinator panes, the center agent pane's native
  // chrome, and codex's content dividers inside the (trimmed) main transcript.
  if (isSeparatorLine(line)) return [truncateToWidth(line, width, "")];

  // A box-drawing frame line (welcome box border/row, table border/row) is
  // likewise a visual element — clip it to the pane width and re-attach its
  // closing border char so the frame's right edge stays straight. Content past
  // the pane edge is clipped, exactly like a narrow terminal viewport.
  const borderSuffix = boxClipSuffix(line);
  if (borderSuffix !== null) return [truncateToWidth(line, width, borderSuffix)];

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

// ── Table reflow ──────────────────────────────────────────────────────────────
//
// Claude Code renders markdown tables as box-drawing frames sized to their
// content — at the pinned tmux width nothing forces cell wrapping, so a table
// with long cells becomes a set of ~pinned-width logical lines. The clip rule
// above keeps such a table readable (straight right edge) but hides everything
// past the pane edge. Reflow does better: it re-lays the table out at the pane
// width — shrinking the widest columns and word-wrapping their cell text into
// multi-row cells — so all cell content stays visible.
//
// Reflow only runs when the table overflows the pane; a fitting table passes
// through byte-identical (colors and all). A reflowed table is re-rendered from
// ANSI-stripped cell text — acceptable, since the alternative is a clipped or
// exploded frame. Malformed blocks (a │ inside cell text, mismatched column
// counts) bail out to the per-line clip rule.

const TABLE_TOP_RE = /^┌[─┬]+┐$/;
const TABLE_MID_RE = /^├[─┼]+┤$/;
const TABLE_BOT_RE = /^└[─┴]+┘$/;

/** Narrowest a shrunken column's text area may get before reflow gives up. */
const MIN_CELL_WIDTH = 3;

function strippedTrimmed(line: string): string {
  return stripAnsi(line).trim();
}

/**
 * If lines[start] opens a table frame (┌──┬──┐), scan forward for the matching
 * bottom rule. Every line between them must be a row (│…│) or an inner rule
 * (├──┼──┤), and at least one row must be present. Returns the bottom-rule
 * index, or -1 when the block is not a well-formed table.
 */
export function matchTableBlockEnd(lines: string[], start: number): number {
  if (!TABLE_TOP_RE.test(strippedTrimmed(lines[start]!))) return -1;
  let sawRow = false;
  for (let i = start + 1; i < lines.length; i++) {
    const s = strippedTrimmed(lines[i]!);
    if (TABLE_BOT_RE.test(s)) return sawRow ? i : -1;
    if (TABLE_MID_RE.test(s)) continue;
    if (s.length >= 2 && s.startsWith("│") && s.endsWith("│")) {
      sawRow = true;
      continue;
    }
    return -1;
  }
  return -1;
}

/**
 * Distribute `avail` columns of text width across `natural` column widths.
 * Columns already narrower than a fair share keep their natural width; the
 * remaining (wide) columns split what's left evenly. Returns null when the
 * split would drive a shrunken column below MIN_CELL_WIDTH.
 */
function shrinkColumnWidths(natural: number[], avail: number): number[] | null {
  const n = natural.length;
  const widths: number[] = new Array(n).fill(0);
  const fixed: boolean[] = new Array(n).fill(false);
  let remaining = avail;
  let flexible = n;
  // Iteratively fix columns whose natural width fits under the current fair
  // share — each fix frees width, which can let further columns fit whole.
  let changed = true;
  while (changed && flexible > 0) {
    changed = false;
    const share = Math.floor(remaining / flexible);
    for (let i = 0; i < n; i++) {
      if (!fixed[i] && natural[i]! <= share) {
        widths[i] = natural[i]!;
        fixed[i] = true;
        remaining -= natural[i]!;
        flexible--;
        changed = true;
      }
    }
  }
  if (flexible > 0) {
    const share = Math.floor(remaining / flexible);
    if (share < MIN_CELL_WIDTH) return null;
    let extra = remaining - share * flexible;
    for (let i = 0; i < n; i++) {
      if (!fixed[i]) {
        widths[i] = share + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
      }
    }
  }
  return widths;
}

/**
 * Re-lay a table block out at the pane width. `lines` spans the top rule
 * through the bottom rule inclusive. Returns the re-rendered physical rows, or
 * null when the block can't be parsed confidently or the pane is too narrow —
 * callers then fall back to per-line wrapping (whose clip rule keeps the frame
 * one row per line).
 */
export function reflowTable(lines: string[], width: number): string[] | null {
  const top = strippedTrimmed(lines[0]!);
  // Column count from the top rule's ┬ positions.
  const ncols = top.slice(1, -1).split("┬").length;

  // Preserve the frame's left indent (Claude indents tables two spaces).
  const indent = /^[ \t]*/.exec(stripAnsi(lines[0]!))![0];

  type Row = { kind: "rule" } | { kind: "cells"; cells: string[] };
  const rows: Row[] = [];
  for (const line of lines.slice(1, -1)) {
    const s = strippedTrimmed(line);
    if (TABLE_MID_RE.test(s)) {
      if (s.slice(1, -1).split("┼").length !== ncols) return null;
      rows.push({ kind: "rule" });
      continue;
    }
    // Split the row into cells on │. A mismatched count means a │ inside cell
    // text or a misaligned frame — bail rather than re-render wrong data.
    const parts = s.slice(1, -1).split("│");
    if (parts.length !== ncols) return null;
    rows.push({ kind: "cells", cells: parts.map((c) => c.trim()) });
  }
  const bottom = strippedTrimmed(lines[lines.length - 1]!);
  if (bottom.slice(1, -1).split("┴").length !== ncols) return null;

  // Natural width per column = widest trimmed cell text in that column.
  const natural: number[] = new Array(ncols).fill(1);
  for (const row of rows) {
    if (row.kind !== "cells") continue;
    for (let i = 0; i < ncols; i++) {
      natural[i] = Math.max(natural[i]!, visibleWidth(row.cells[i]!));
    }
  }

  // Frame overhead: indent + ncols+1 border chars + a space of padding on each
  // side of every cell.
  const overhead = indent.length + (ncols + 1) + 2 * ncols;
  const avail = width - overhead;
  if (avail < ncols * MIN_CELL_WIDTH) return null;

  const widths =
    natural.reduce((a, b) => a + b, 0) <= avail ? natural : shrinkColumnWidths(natural, avail);
  if (!widths) return null;

  const rule = (left: string, mid: string, right: string): string =>
    indent + left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;

  const out: string[] = [];
  out.push(rule("┌", "┬", "┐"));
  for (const row of rows) {
    if (row.kind === "rule") {
      out.push(rule("├", "┼", "┤"));
      continue;
    }
    // Word-wrap each cell to its column width; the row's height is its tallest
    // cell, and shorter cells pad with blank rows.
    const cellLines = row.cells.map((c, i) => (c === "" ? [""] : wordWrapSingleLine(c, widths[i]!)));
    const height = Math.max(...cellLines.map((ls) => ls.length));
    for (let r = 0; r < height; r++) {
      let line = indent + "│";
      for (let i = 0; i < ncols; i++) {
        const txt = cellLines[i]![r] ?? "";
        line += " " + txt + " ".repeat(Math.max(0, widths[i]! - visibleWidth(txt))) + " │";
      }
      out.push(line);
    }
  }
  out.push(rule("└", "┴", "┘"));
  return out;
}

/**
 * Word-wrap all lines in a multi-line string.
 * Splits on newlines first, then word-wraps each line — except table frames,
 * which reflow as a block (see "Table reflow" above).
 */
export function wordWrapLines(text: string, width: number): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Cheap pre-filter: only a line containing ┌ can open a table frame.
    if (line.includes("┌")) {
      const end = matchTableBlockEnd(lines, i);
      if (end > i) {
        const block = lines.slice(i, end + 1);
        if (block.every((l) => visibleWidth(l) <= width)) {
          // The whole table fits — pass it through untouched (colors intact).
          result.push(...block);
        } else {
          const reflowed = reflowTable(block, width);
          if (reflowed) {
            result.push(...reflowed);
          } else {
            for (const l of block) result.push(...wordWrapSingleLine(l, width));
          }
        }
        i = end + 1;
        continue;
      }
    }
    result.push(...wordWrapSingleLine(line, width));
    i++;
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
