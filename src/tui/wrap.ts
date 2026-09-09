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
 * Three shapes qualify:
 *
 *  1. A bare rule — the entire visible content is a run of light (`─`) or heavy
 *     (`━`) box-drawing chars. Codex uses the heavy form for table header rules.
 *  2. A segmented heavy rule — heavy runs separated by the two spaces Codex
 *     uses between table columns (`━━━━  ━━━━━`).
 *  3. A titled light rule — a run of ─ on each side with a short inline label
 *     between them (`─ Worked for 3m 50s ────…`). Codex emits these after each
 *     turn. Because the middle breaks the pure run, the bare-rule test alone
 *     lets the line fall through to word-wrapping and it explodes into many rows
 *     at narrow display widths.
 *
 * Heavy rules deliberately accept only runs and two-space column gaps; unlike
 * the light rule, they do not accept inline labels. That keeps heavy-bar prose
 * visible instead of misclassifying and truncating it.
 */
function isSeparatorLine(line: string): boolean {
  const stripped = stripAnsiForWrap(line).trim();
  if (stripped.length === 0) return false;
  // Bare light or heavy rule.
  if (/^─+$/.test(stripped) || /^━+$/.test(stripped)) return true;
  // Heavy table-header rule: one run per column, separated by two spaces.
  if (/^━+(?: {2}━+)+$/.test(stripped)) return true;
  // Titled light rule: ─-run … short label … ─-run.
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
  const stripped = stripAnsiForWrap(line).trim();
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

  // Parse into rule / cells-group entries. Adjacent │…│ lines group together:
  // when a table's NATURAL width exceeds the pinned tmux width, Claude Code
  // wraps cell text itself, so one logical row spans several adjacent physical
  // lines with rules only between logical rows. What a group means is decided
  // after the parse (below).
  type Group = { kind: "rule" } | { kind: "cells"; fragments: string[][] };
  const groups: Group[] = [];
  let innerRules = 0;
  for (const line of lines.slice(1, -1)) {
    const s = strippedTrimmed(line);
    if (TABLE_MID_RE.test(s)) {
      if (s.slice(1, -1).split("┼").length !== ncols) return null;
      groups.push({ kind: "rule" });
      innerRules++;
      continue;
    }
    // Split the row into cells on │. A mismatched count means a │ inside cell
    // text or a misaligned frame — bail rather than re-render wrong data.
    const parts = s.slice(1, -1).split("│");
    if (parts.length !== ncols) return null;
    const cells = parts.map((c) => c.trim());
    const last = groups[groups.length - 1];
    if (last && last.kind === "cells") last.fragments.push(cells);
    else groups.push({ kind: "cells", fragments: [cells] });
  }

  // Decide what an adjacent-line group means. With rules between every logical
  // row (Claude Code's own table style — ≥2 inner rules), adjacent lines are
  // wrap FRAGMENTS of one logical row: merge them column-wise (space-joined)
  // so each cell re-wraps as one flowing text. With a single inner rule
  // (console.table style: one rule after the header, all body rows adjacent),
  // adjacent lines are DISTINCT data rows — merging would fuse them, so they
  // stay separate. A one-logical-row Claude table that wrapped has the same
  // shape as the latter and also stays unmerged: its fragments still render
  // adjacently and aligned, just without re-flowing text across the fragment
  // boundary. (The space join can split a token Claude hard-broke mid-word at
  // the pinned width — harmless next to the alternative of gluing two words
  // together.)
  const mergeFragments = innerRules >= 2;
  type Row = { kind: "rule" } | { kind: "cells"; cells: string[] };
  const rows: Row[] = [];
  for (const group of groups) {
    if (group.kind === "rule") {
      rows.push({ kind: "rule" });
      continue;
    }
    if (mergeFragments && group.fragments.length > 1) {
      const cells = group.fragments[0]!.map((_, i) =>
        group.fragments
          .map((f) => f[i]!)
          .filter((c) => c.length > 0)
          .join(" "),
      );
      rows.push({ kind: "cells", cells });
    } else {
      for (const cells of group.fragments) rows.push({ kind: "cells", cells });
    }
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

// ── Borderless Codex table reflow ───────────────────────────────────────────
//
// Codex renders markdown tables without an outer frame. Each column is marked
// by a heavy header-rule segment and logical body rows are separated by matching
// light-rule segments:
//
//    Header A      Header B
//   ━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━
//    short         long cell text
//   ───────────  ─────────────────
//
// At the pinned tmux width, those rows are much wider than a dashboard pane.
// Treating a row as prose moves wrapped text back to column zero. The helpers
// below recover the column geometry from the rule, then reuse the same fair
// width allocation as framed tables so every cell wraps within its own column.

interface BorderlessRuleLayout {
  indent: string;
  indentWidth: number;
  widths: number[];
  starts: number[];
  totalWidth: number;
}

interface BorderlessTableBlock {
  end: number;
  layout: BorderlessRuleLayout;
  rows: string[][];
  rowAffixes: TerminalAffixes[];
  heavyRule: StyledBorderlessRule;
  dividerBefore: Array<StyledBorderlessRule | null>;
  alignments: CellAlignment[];
}

type CellAlignment = "left" | "center" | "right";

interface ParsedBorderlessRow {
  cells: string[];
  alignmentHints: Array<CellAlignment | null>;
  affixes: TerminalAffixes;
}

interface TerminalAffixes {
  prefix: string;
  suffix: string;
}

interface TerminalLineParts {
  inner: string;
  affixes: TerminalAffixes;
}

interface StyledBorderlessRule {
  affixes: TerminalAffixes;
  segments: string[];
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface TerminalToken {
  raw: string;
  width: number;
  text: string;
  escape: boolean;
  embeddedEscapes?: string[];
}

function terminalEscapeEnd(text: string, cursor: number): number {
  if (cursor + 1 >= text.length) return cursor + 1;
  const kind = text[cursor + 1]!;
  let end = cursor + 2;
  if (kind === "[") {
    while (end < text.length && !isCsiTerminator(text.charCodeAt(end))) end++;
    return end < text.length ? end + 1 : end;
  }
  if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
    while (
      end < text.length &&
      text[end] !== "\x07" &&
      !(text[end] === "\x1b" && text[end + 1] === "\\")
    ) {
      end++;
    }
    return end + (text[end] === "\x07" ? 1 : end < text.length ? 2 : 0);
  }
  if (kind === "(" || kind === ")") return Math.min(text.length, cursor + 3);
  const code = kind.charCodeAt(0);
  // Other valid ESC Fe/Fs sequences are two ASCII bytes. For malformed input,
  // consume only ESC so a following surrogate pair remains an intact grapheme.
  return code >= 0x30 && code <= 0x7e ? cursor + 2 : cursor + 1;
}

function terminalTokens(text: string): TerminalToken[] {
  interface PositionedEscape {
    offset: number;
    raw: string;
  }
  const escapes: PositionedEscape[] = [];
  let plain = "";
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === "\x1b") {
      const end = terminalEscapeEnd(text, cursor);
      escapes.push({ offset: plain.length, raw: text.slice(cursor, end) });
      cursor = end;
    } else {
      const nextEscape = text.indexOf("\x1b", cursor);
      const end = nextEscape < 0 ? text.length : nextEscape;
      plain += text.slice(cursor, end);
      cursor = end;
    }
  }

  const tokens: TerminalToken[] = [];
  let escapeIndex = 0;
  for (const part of GRAPHEME_SEGMENTER.segment(plain)) {
    const start = part.index;
    const end = start + part.segment.length;
    while (escapeIndex < escapes.length && escapes[escapeIndex]!.offset <= start) {
      tokens.push({
        raw: escapes[escapeIndex]!.raw,
        width: 0,
        text: "",
        escape: true,
      });
      escapeIndex++;
    }
    let raw = "";
    let innerCursor = start;
    const embeddedEscapes: string[] = [];
    while (escapeIndex < escapes.length && escapes[escapeIndex]!.offset < end) {
      const embedded = escapes[escapeIndex]!;
      raw += plain.slice(innerCursor, embedded.offset) + embedded.raw;
      embeddedEscapes.push(embedded.raw);
      innerCursor = embedded.offset;
      escapeIndex++;
    }
    raw += plain.slice(innerCursor, end);
    tokens.push({
      raw,
      width: visibleWidth(part.segment),
      text: part.segment,
      escape: false,
      embeddedEscapes,
    });
  }
  while (escapeIndex < escapes.length) {
    tokens.push({
      raw: escapes[escapeIndex]!.raw,
      width: 0,
      text: "",
      escape: true,
    });
    escapeIndex++;
  }
  return tokens;
}

function stripTerminalAnsi(text: string): string {
  return terminalTokens(text)
    .filter((token) => !token.escape)
    .map((token) => token.text)
    .join("");
}

function stripAnsiForWrap(text: string): string {
  // The shared parser's fast regex handles ordinary CSI/OSC but not colon-form
  // SGR. Pay for grapheme tokenization only on the uncommon extended form.
  return /\x1b\[[0-9;:]*:/.test(text) ? stripTerminalAnsi(text) : stripAnsi(text);
}

function sliceTerminalColumnRanges(
  text: string,
  ranges: Array<{ start: number; end: number }>,
): string[] {
  const output = ranges.map(() => "");
  const begun = ranges.map(() => false);
  const state: TerminalStyleState = { sgr: new Map(), osc8: null, osc8Active: false };
  let rangeIndex = 0;
  let column = 0;
  const begin = () => {
    if (!begun[rangeIndex]) {
      output[rangeIndex] += terminalStylePrefix(state);
      begun[rangeIndex] = true;
    }
  };
  const finish = () => {
    if (begun[rangeIndex]) output[rangeIndex] += terminalStyleSuffix(state);
    rangeIndex++;
  };
  for (const token of terminalTokens(text)) {
    if (token.escape) {
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.end < column) finish();
      const range = ranges[rangeIndex];
      if (range && column >= range.start && column <= range.end) {
        begin();
        output[rangeIndex] += token.raw;
      }
      applyTerminalEscape(state, token.raw);
      continue;
    }
    const nextColumn = column + token.width;
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= column) finish();
    const range = ranges[rangeIndex];
    if (range && column >= range.start && nextColumn <= range.end) {
      begin();
      output[rangeIndex] += token.raw;
    }
    for (const escape of token.embeddedEscapes ?? []) applyTerminalEscape(state, escape);
    column = nextColumn;
  }
  while (rangeIndex < ranges.length) finish();
  return output;
}

function trimTerminalCell(text: string): string {
  const tokens = terminalTokens(text);
  const state: TerminalStyleState = { sgr: new Map(), osc8: null, osc8Active: false };
  const nonWhitespace: number[] = [];
  const styledWhitespace: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.escape) {
      applyTerminalEscape(state, token.raw);
      continue;
    }
    let styled = hasTerminalStyle(state);
    for (const escape of token.embeddedEscapes ?? []) {
      applyTerminalEscape(state, escape);
      styled ||= hasTerminalStyle(state);
    }
    if (token.text.trim().length > 0) nonWhitespace.push(index);
    else if (styled) styledWhitespace.push(index);
  }
  // Alignment padding is discarded whenever the cell has real text, even if a
  // link/style spans that padding. A cell containing only styled whitespace is
  // itself visual content (for example, a background-color swatch) and stays.
  const content = nonWhitespace.length > 0 ? nonWhitespace : styledWhitespace;
  if (content.length === 0) return "";
  const first = content[0]!;
  const last = content.at(-1)!;
  return tokens
    .filter((token, index) => token.escape || (index >= first && index <= last))
    .map((token) => token.raw)
    .join("");
}

function terminalLineParts(line: string): TerminalLineParts {
  const tokens = terminalTokens(line);
  const content = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => !token.escape && token.text.trim().length > 0);
  if (content.length === 0) {
    return { inner: line, affixes: { prefix: "", suffix: "" } };
  }
  const first = content[0]!.index;
  const last = content.at(-1)!.index;
  const prefixTokens = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => token.escape && index < first);
  const suffixTokens = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => token.escape && index > last);
  // Only lift semantic pairs of outer style/link metadata. Merely having an
  // escape at both ends is insufficient: the opener may belong to the first
  // cell while an unrelated reset belongs to the last.
  if (prefixTokens.length === 0 || suffixTokens.length === 0) {
    return { inner: line, affixes: { prefix: "", suffix: "" } };
  }
  const prefixState: TerminalStyleState = { sgr: new Map(), osc8: null, osc8Active: false };
  for (const { token } of prefixTokens) applyTerminalEscape(prefixState, token.raw);
  const closedState = copyTerminalStyle(prefixState);
  for (const { token } of suffixTokens) applyTerminalEscape(closedState, token.raw);
  const closesPrefixSgr = prefixState.sgr.size === 0 || closedState.sgr.size === 0;
  const closesPrefixLink = !prefixState.osc8Active || !closedState.osc8Active;
  const replayablePrefixLink = !prefixState.osc8Active || prefixState.osc8 !== null;
  if (
    !hasTerminalStyle(prefixState) ||
    !replayablePrefixLink ||
    !closesPrefixSgr ||
    !closesPrefixLink
  ) {
    return { inner: line, affixes: { prefix: "", suffix: "" } };
  }
  const extracted = new Set([
    ...prefixTokens.map(({ index }) => index),
    ...suffixTokens.map(({ index }) => index),
  ]);
  return {
    inner: tokens
      .filter((_token, index) => !extracted.has(index))
      .map((token) => token.raw)
      .join(""),
    affixes: {
      prefix: prefixTokens.map(({ token }) => token.raw).join(""),
      suffix: suffixTokens.map(({ token }) => token.raw).join(""),
    },
  };
}

function styledBorderlessRule(
  line: string,
  layout: BorderlessRuleLayout,
): StyledBorderlessRule {
  const parts = terminalLineParts(line);
  return {
    affixes: parts.affixes,
    segments: sliceTerminalColumnRanges(
      parts.inner,
      layout.starts.map((start, index) => ({
        start,
        end: start + layout.widths[index]!,
      })),
    ),
  };
}

function parseBorderlessRule(line: string, ruleChar: "━" | "─"): BorderlessRuleLayout | null {
  const plain = stripAnsiForWrap(line);
  const indent = /^ */.exec(plain)![0];
  const body = plain.slice(indent.length).trimEnd();
  const segments = body.split("  ");
  if (
    segments.length < 2 ||
    segments.some((segment) => segment.length < 3 || Array.from(segment).some((c) => c !== ruleChar))
  ) {
    return null;
  }

  const indentWidth = visibleWidth(indent);
  const widths = segments.map((segment) => visibleWidth(segment));
  const starts: number[] = [];
  let column = indentWidth;
  for (const segmentWidth of widths) {
    starts.push(column);
    column += segmentWidth + 2;
  }
  return {
    indent,
    indentWidth,
    widths,
    starts,
    totalWidth: column - 2,
  };
}

function sameBorderlessLayout(
  left: BorderlessRuleLayout,
  right: BorderlessRuleLayout,
): boolean {
  return (
    left.indent === right.indent &&
    left.widths.length === right.widths.length &&
    left.widths.every((width, i) => width === right.widths[i])
  );
}

/**
 * Resolve terminal-column boundaries to UTF-16 string indices in one
 * grapheme-aware pass. Returns null when a requested table boundary cuts
 * through a grapheme cluster, which means the line cannot match the rule's
 * column geometry safely.
 */
function visibleBoundaryIndices(text: string, boundaries: number[]): Map<number, number> | null {
  const pending = [...new Set(boundaries)].sort((a, b) => a - b);
  const indices = new Map<number, number>();
  let boundaryIndex = 0;
  let column = 0;
  for (const part of GRAPHEME_SEGMENTER.segment(text)) {
    while (boundaryIndex < pending.length && pending[boundaryIndex]! <= column) {
      if (pending[boundaryIndex]! < column) return null;
      indices.set(pending[boundaryIndex]!, part.index);
      boundaryIndex++;
    }
    const nextColumn = column + visibleWidth(part.segment);
    if (
      boundaryIndex < pending.length &&
      pending[boundaryIndex]! > column &&
      pending[boundaryIndex]! < nextColumn
    ) {
      return null;
    }
    column = nextColumn;
  }
  while (boundaryIndex < pending.length) {
    if (pending[boundaryIndex]! < column) return null;
    indices.set(pending[boundaryIndex]!, text.length);
    boundaryIndex++;
  }
  return indices;
}

function inferCellAlignment(rawCell: string): CellAlignment | null {
  if (rawCell.trim().length === 0) return null;
  const leading = rawCell.length - rawCell.trimStart().length;
  const trailing = rawCell.length - rawCell.trimEnd().length;
  if (leading === 0 && trailing === 0) return null;
  if (leading > trailing) return "right";
  if (leading > 0 && trailing > 0 && Math.abs(leading - trailing) <= 1) return "center";
  return "left";
}

function parseBorderlessCells(
  line: string,
  layout: BorderlessRuleLayout,
): ParsedBorderlessRow | null {
  const parts = terminalLineParts(line);
  const { inner, affixes } = parts;
  const plain = stripAnsiForWrap(inner);
  const boundaries = [0, layout.indentWidth, layout.totalWidth, visibleWidth(plain)];
  for (let i = 0; i < layout.widths.length; i++) {
    const start = layout.starts[i]!;
    const segmentWidth = layout.widths[i]!;
    boundaries.push(start, start + 1, start + segmentWidth - 1, start + segmentWidth);
    if (i + 1 < layout.widths.length) boundaries.push(layout.starts[i + 1]!);
  }
  const indices = visibleBoundaryIndices(plain, boundaries);
  if (!indices) return null;
  const slice = (start: number, end: number) =>
    plain.slice(indices.get(start)!, indices.get(end)!);

  const leading = slice(0, layout.indentWidth);
  const outside = slice(layout.totalWidth, visibleWidth(plain));
  if (leading.trim().length > 0 || outside.trim().length > 0) return null;

  const cells: string[] = [];
  const alignmentHints: Array<CellAlignment | null> = [];
  const styledCells = sliceTerminalColumnRanges(
    inner,
    layout.starts.map((start, index) => ({
      start: start + 1,
      end: start + layout.widths[index]! - 1,
    })),
  );
  for (let i = 0; i < layout.widths.length; i++) {
    const start = layout.starts[i]!;
    const segmentWidth = layout.widths[i]!;
    const leftPad = slice(start, start + 1);
    const rightPad = slice(start + segmentWidth - 1, start + segmentWidth);
    const gap =
      i + 1 < layout.widths.length
        ? slice(start + segmentWidth, layout.starts[i + 1]!)
        : "";
    if (leftPad.trim().length > 0 || rightPad.trim().length > 0 || gap.trim().length > 0) {
      return null;
    }
    const rawCell = slice(start + 1, start + segmentWidth - 1);
    const styledCell = trimTerminalCell(styledCells[i]!);
    if (stripAnsiForWrap(styledCell).trim() !== rawCell.trim()) return null;
    cells.push(styledCell);
    alignmentHints.push(inferCellAlignment(rawCell));
  }
  return cells.some((cell) => cell.length > 0) ? { cells, alignmentHints, affixes } : null;
}

/**
 * Match a complete borderless Codex table beginning at its header row. The
 * heavy rule is the unambiguous anchor; matching light rules split body rows.
 * Source-wrapped cell fragments remain separate physical rows. This retains
 * their exact word boundaries without guessing whether the renderer wrapped at
 * whitespace or in the middle of a token. Light rules are recorded separately
 * and reproduced only where Codex placed them.
 */
function matchBorderlessTableBlock(lines: string[], start: number): BorderlessTableBlock | null {
  if (start + 2 >= lines.length) return null;
  const layout = parseBorderlessRule(lines[start + 1]!, "━");
  if (!layout) return null;
  const header = parseBorderlessCells(lines[start]!, layout);
  if (!header) return null;

  const rows = [header.cells];
  const rowAffixes = [header.affixes];
  const heavyRule = styledBorderlessRule(lines[start + 1]!, layout);
  const dividerBefore: Array<StyledBorderlessRule | null> = [null];
  // A rendered markdown header is commonly left-aligned even when its body
  // column is numeric/right-aligned, so prefer the first body-row signal over
  // a merely left-aligned header. Explicit centered/right headers still win.
  const alignmentHints = header.alignmentHints.map((hint) => {
    const values = new Set<CellAlignment>();
    if (hint && hint !== "left") values.add(hint);
    return values;
  });
  let end = start + 1;
  let cursor = start + 2;
  let nextHasDivider = false;
  let nextDivider: StyledBorderlessRule | null = null;
  while (cursor < lines.length) {
    if (stripAnsiForWrap(lines[cursor]!).trim().length === 0) break;
    const divider = parseBorderlessRule(lines[cursor]!, "─");
    if (divider && sameBorderlessLayout(layout, divider)) {
      if (rows.length === 1 || nextHasDivider) return null;
      nextHasDivider = true;
      nextDivider = styledBorderlessRule(lines[cursor]!, layout);
      end = cursor;
      cursor++;
      continue;
    }
    const row = parseBorderlessCells(lines[cursor]!, layout);
    if (!row) break;
    const onlyFirstColumn = row.cells
      .slice(1)
      .every((cell) => stripAnsiForWrap(cell).trim().length === 0);
    const followingDivider =
      cursor + 1 < lines.length ? parseBorderlessRule(lines[cursor + 1]!, "─") : null;
    // Without a following divider, an undivided first-column-only row is
    // byte-for-byte indistinguishable from ordinary three-space-indented prose.
    // Prefer the conservative false negative: keep the text visible as prose
    // rather than silently absorbing unrelated content into the table.
    const confirmedFirstColumnContinuation =
      followingDivider && sameBorderlessLayout(layout, followingDivider);
    if (
      rows.length > 1 &&
      !nextHasDivider &&
      onlyFirstColumn &&
      !confirmedFirstColumnContinuation
    ) {
      break;
    }
    rows.push(row.cells);
    rowAffixes.push(row.affixes);
    dividerBefore.push(nextHasDivider ? nextDivider : null);
    nextHasDivider = false;
    nextDivider = null;
    for (let column = 0; column < alignmentHints.length; column++) {
      const hint = row.alignmentHints[column];
      if (hint) alignmentHints[column]!.add(hint);
    }
    end = cursor;
    cursor++;
  }
  if (rows.length < 2 || nextHasDivider) return null;
  return {
    end,
    layout,
    rows,
    rowAffixes,
    heavyRule,
    dividerBefore,
    alignments: alignmentHints.map((hints) =>
      hints.size === 1 ? hints.values().next().value! : "left",
    ),
  };
}

interface TerminalStyleState {
  sgr: Map<string, string>;
  osc8: string | null;
  osc8Active: boolean;
}

// Replaying an arbitrarily long hyperlink target on every wrapped row would
// amplify an O(n)-byte input to O(n²). Typical terminal URLs fit comfortably.
const MAX_REPLAYABLE_OSC8_LENGTH = 256;

function hasTerminalStyle(state: TerminalStyleState): boolean {
  return state.sgr.size > 0 || state.osc8Active;
}

function copyTerminalStyle(state: TerminalStyleState): TerminalStyleState {
  return {
    sgr: new Map(state.sgr),
    osc8: state.osc8,
    osc8Active: state.osc8Active,
  };
}

function setSgr(state: TerminalStyleState, key: string, params: string[]): void {
  state.sgr.set(key, `\x1b[${params.join(";")}m`);
}

function applySgrEscape(state: TerminalStyleState, raw: string): void {
  const values = raw.slice(2, -1).split(";").map((value) => value || "0");
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    const colonCode = Number(value.split(":", 1)[0]);
    if (value.includes(":")) {
      if (colonCode === 38 || colonCode === 48 || colonCode === 58) {
        setSgr(
          state,
          colonCode === 38 ? "fg" : colonCode === 48 ? "bg" : "underline-color",
          [value],
        );
      } else if (colonCode === 4) {
        if (value.split(":")[1] === "0") state.sgr.delete("underline");
        else setSgr(state, "underline", [value]);
      } else {
        setSgr(state, "unknown", [value]);
      }
      continue;
    }
    const code = Number(value);
    if (!Number.isFinite(code)) {
      setSgr(state, "unknown", [value]);
      continue;
    }
    if (code === 0) {
      state.sgr.clear();
      continue;
    }
    if (code === 38 || code === 48 || code === 58) {
      const mode = values[i + 1];
      const length = mode === "5" ? 3 : mode === "2" ? 5 : 1;
      const params = values.slice(i, i + length);
      setSgr(state, code === 38 ? "fg" : code === 48 ? "bg" : "underline-color", params);
      i += params.length - 1;
      continue;
    }
    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      setSgr(state, "fg", [value]);
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      setSgr(state, "bg", [value]);
    } else if (code === 39) {
      state.sgr.delete("fg");
    } else if (code === 49) {
      state.sgr.delete("bg");
    } else if (code === 59) {
      state.sgr.delete("underline-color");
    } else if (code === 1 || code === 2) {
      setSgr(state, code === 1 ? "bold" : "faint", [value]);
    } else if (code === 22) {
      state.sgr.delete("bold");
      state.sgr.delete("faint");
    } else if (code === 3 || code === 20) {
      setSgr(state, code === 3 ? "italic" : "fraktur", [value]);
    } else if (code === 23) {
      state.sgr.delete("italic");
      state.sgr.delete("fraktur");
    } else if (code === 4 || code === 21) {
      setSgr(state, "underline", [value]);
    } else if (code === 24) {
      state.sgr.delete("underline");
    } else if (code === 5 || code === 6) {
      setSgr(state, "blink", [value]);
    } else if (code === 25) {
      state.sgr.delete("blink");
    } else if (code >= 7 && code <= 9) {
      setSgr(state, code === 7 ? "inverse" : code === 8 ? "conceal" : "strike", [value]);
    } else if (code >= 27 && code <= 29) {
      state.sgr.delete(code === 27 ? "inverse" : code === 28 ? "conceal" : "strike");
    } else if (code >= 10 && code <= 19) {
      setSgr(state, "font", [value]);
    } else if (code === 26 || code === 50) {
      if (code === 26) setSgr(state, "proportional", [value]);
      else state.sgr.delete("proportional");
    } else if (code === 51 || code === 52) {
      setSgr(state, "frame", [value]);
    } else if (code === 54) {
      state.sgr.delete("frame");
    } else if (code === 53 || code === 55) {
      if (code === 53) setSgr(state, "overline", [value]);
      else state.sgr.delete("overline");
    } else if (code >= 60 && code <= 64) {
      setSgr(state, "ideogram", [value]);
    } else if (code === 65) {
      state.sgr.delete("ideogram");
    } else if (code === 73 || code === 74) {
      setSgr(state, "script", [value]);
    } else if (code === 75) {
      state.sgr.delete("script");
    } else {
      // Unknown extensions share one bounded slot. Replaying the most recent
      // value is safer than retaining an unbounded history of vendor codes.
      setSgr(state, "unknown", [value]);
    }
  }
}

function applyTerminalEscape(state: TerminalStyleState, raw: string): void {
  if (raw.startsWith("\x1b[") && raw.endsWith("m")) {
    applySgrEscape(state, raw);
    return;
  }
  if (raw.startsWith("\x1b]8;")) {
    const terminatorLength = raw.endsWith("\x07") ? 1 : raw.endsWith("\x1b\\") ? 2 : 0;
    const payload = raw.slice(2, raw.length - terminatorLength);
    const match = /^8;[^;]*;(.*)$/s.exec(payload);
    if (match) {
      state.osc8Active = match[1]!.length > 0;
      state.osc8 =
        state.osc8Active && raw.length <= MAX_REPLAYABLE_OSC8_LENGTH ? raw : null;
    }
  }
}

function terminalStylePrefix(state: TerminalStyleState): string {
  return (state.osc8 ?? "") + [...state.sgr.values()].join("");
}

function terminalStyleSuffix(state: TerminalStyleState): string {
  return (state.sgr.size > 0 ? "\x1b[0m" : "") +
    (state.osc8Active ? "\x1b]8;;\x1b\\" : "");
}

function terminalAffixRestore(affixes: TerminalAffixes): string {
  const state: TerminalStyleState = { sgr: new Map(), osc8: null, osc8Active: false };
  for (const token of terminalTokens(affixes.prefix)) {
    if (token.escape) applyTerminalEscape(state, token.raw);
    else for (const escape of token.embeddedEscapes ?? []) applyTerminalEscape(state, escape);
  }
  return terminalStylePrefix(state);
}

function resizeStyledRuleSegment(
  segment: string,
  ruleChar: "━" | "─",
  width: number,
  closeTruncated = true,
): string {
  const state: TerminalStyleState = { sgr: new Map(), osc8: null, osc8Active: false };
  let output = "";
  let used = 0;
  let truncated = false;
  for (const token of terminalTokens(segment)) {
    if (token.escape) {
      output += token.raw;
      applyTerminalEscape(state, token.raw);
      continue;
    }
    if (used + token.width > width) {
      truncated = true;
      break;
    }
    output += token.raw;
    for (const escape of token.embeddedEscapes ?? []) applyTerminalEscape(state, escape);
    used += token.width;
  }
  if (used < width) output += ruleChar.repeat(width - used);
  if (truncated && closeTruncated) output += terminalStyleSuffix(state);
  return output;
}

function wrapStyledCell(text: string, width: number): string[] {
  if (text.length === 0 || visibleWidth(text) <= width) return [text];

  interface StyledGrapheme {
    raw: string;
    text: string;
    width: number;
    before: TerminalStyleState;
    during: TerminalStyleState;
    after: TerminalStyleState;
  }

  const state: TerminalStyleState = { sgr: new Map(), osc8: null, osc8Active: false };
  const units: StyledGrapheme[] = [];
  let pending = "";
  let beforePending = copyTerminalStyle(state);
  for (const token of terminalTokens(text)) {
    if (token.escape) {
      if (pending.length === 0) beforePending = copyTerminalStyle(state);
      pending += token.raw;
      applyTerminalEscape(state, token.raw);
      continue;
    }
    const before = pending.length > 0 ? beforePending : copyTerminalStyle(state);
    const during = copyTerminalStyle(state);
    for (const escape of token.embeddedEscapes ?? []) applyTerminalEscape(state, escape);
    units.push({
      raw: pending + token.raw,
      text: token.text,
      width: token.width,
      before,
      during,
      after: copyTerminalStyle(state),
    });
    pending = "";
  }
  if (units.length === 0) return [text];

  const output: string[] = [];
  let start = 0;
  while (start < units.length) {
    // A normal word-separator space can land alone at the start of the next
    // chunk when the preceding word exactly filled its cell. Drop that wrap
    // boundary; explicitly styled whitespace remains content and is retained.
    while (
      start > 0 &&
      start < units.length &&
      (units[start]!.text === " " || units[start]!.text === "\t") &&
      !hasTerminalStyle(units[start]!.during)
    ) {
      start++;
    }
    if (start >= units.length) break;
    let end = start;
    let used = 0;
    let lastWhitespace = -1;
    while (end < units.length && used + units[end]!.width <= width) {
      used += units[end]!.width;
      if (units[end]!.text === " " || units[end]!.text === "\t") {
        lastWhitespace = end + 1;
      }
      end++;
    }
    if (end === start) end++;
    else if (end < units.length && lastWhitespace > start) end = lastWhitespace;

    const first = units[start]!;
    const last = units[end - 1]!;
    let rendered = terminalStylePrefix(first.before);
    for (let i = start; i < end; i++) rendered += units[i]!.raw;
    const endState = end === units.length ? state : last.after;
    if (end === units.length) rendered += pending;
    rendered += terminalStyleSuffix(endState);
    output.push(rendered);
    start = end;
  }
  return output;
}

function allocateBorderlessWidths(
  natural: number[],
  minimum: number[],
  available: number,
): number[] | null {
  const widths = [...minimum];
  let remaining = available - widths.reduce((sum, value) => sum + value, 0);
  if (remaining < 0) return null;
  while (remaining > 0) {
    let candidate = -1;
    for (let i = 0; i < widths.length; i++) {
      if (
        widths[i]! < natural[i]! &&
        (candidate < 0 || widths[i]! < widths[candidate]!)
      ) {
        candidate = i;
      }
    }
    if (candidate < 0) break;
    widths[candidate]!++;
    remaining--;
  }
  return widths;
}

function stackBorderlessTable(block: BorderlessTableBlock, width: number): string[] | null {
  if (width <= 0) return null;
  const output: string[] = [];
  const decorate = (line: string, affixes: TerminalAffixes) =>
    affixes.prefix + line + affixes.suffix;
  const pushCell = (cell: string, affixes: TerminalAffixes) => {
    if (visibleWidth(cell) === 0) return;
    const restore = terminalAffixRestore(affixes);
    for (const line of wrapStyledCell(cell, width)) {
      const bounded =
        visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
      output.push(decorate(bounded + restore, affixes));
    }
  };
  for (let i = 0; i < block.rows.length; i++) {
    if (i === 1) {
      output.push(decorate(
        resizeStyledRuleSegment(
          block.heavyRule.segments[0] ?? "",
          "━",
          width,
          block.heavyRule.affixes.suffix.length === 0,
        ) + terminalAffixRestore(block.heavyRule.affixes),
        block.heavyRule.affixes,
      ));
    } else if (block.dividerBefore[i]) {
      const divider = block.dividerBefore[i]!;
      output.push(decorate(
        resizeStyledRuleSegment(
          divider.segments[0] ?? "",
          "─",
          width,
          divider.affixes.suffix.length === 0,
        ) + terminalAffixRestore(divider.affixes),
        divider.affixes,
      ));
    }
    for (const cell of block.rows[i]!) pushCell(cell, block.rowAffixes[i]!);
  }
  return output;
}

function reflowBorderlessTable(block: BorderlessTableBlock, width: number): string[] | null {
  const ncols = block.layout.widths.length;
  const natural: number[] = new Array(ncols).fill(1);
  const minimum: number[] = new Array(ncols).fill(1);
  for (const row of block.rows) {
    for (let i = 0; i < ncols; i++) {
      natural[i] = Math.max(natural[i]!, visibleWidth(row[i]!));
      for (const token of terminalTokens(row[i]!)) {
        if (!token.escape) minimum[i] = Math.max(minimum[i]!, token.width);
      }
    }
  }

  // Each column has one space of padding per side; neighboring columns have a
  // two-space gutter. The source indent sits outside that table geometry.
  const overhead = block.layout.indentWidth + 2 * ncols + 2 * (ncols - 1);
  const avail = width - overhead;
  if (avail < minimum.reduce((sum, value) => sum + value, 0)) {
    return stackBorderlessTable(block, width);
  }
  const widths =
    natural.reduce((sum, value) => sum + value, 0) <= avail
      ? natural
      : allocateBorderlessWidths(natural, minimum, avail);
  if (!widths) return null;

  const decorate = (line: string, affixes: TerminalAffixes) =>
    affixes.prefix + line + affixes.suffix;
  const rule = (styled: StyledBorderlessRule, char: "━" | "─") =>
    decorate(
      block.layout.indent + widths
        .map((cellWidth, index) =>
          resizeStyledRuleSegment(
            styled.segments[index] ?? "",
            char,
            cellWidth + 2,
            index + 1 < widths.length || styled.affixes.suffix.length === 0,
          ) + terminalAffixRestore(styled.affixes),
        )
        .join("  "),
      styled.affixes,
    );
  const renderRow = (cells: string[], affixes: TerminalAffixes): string[] => {
    const restore = terminalAffixRestore(affixes);
    const cellLines = cells.map((cell, i) => wrapStyledCell(cell, widths[i]!));
    const height = Math.max(...cellLines.map((cell) => cell.length));
    const rendered: string[] = [];
    for (let row = 0; row < height; row++) {
      const columns = cellLines.map((cell, i) => {
        const text = cell[row] ?? "";
        const extra = Math.max(0, widths[i]! - visibleWidth(text));
        const alignment = block.alignments[i]!;
        const left =
          alignment === "right"
            ? extra
            : alignment === "center"
              ? Math.floor(extra / 2)
              : 0;
        return " " + " ".repeat(left) + text + restore + " ".repeat(extra - left + 1);
      });
      rendered.push(decorate(block.layout.indent + columns.join("  "), affixes));
    }
    return rendered;
  };

  const output = [
    ...renderRow(block.rows[0]!, block.rowAffixes[0]!),
    rule(block.heavyRule, "━"),
  ];
  for (let i = 1; i < block.rows.length; i++) {
    if (block.dividerBefore[i]) {
      output.push(rule(block.dividerBefore[i]!, "─"));
    }
    output.push(...renderRow(block.rows[i]!, block.rowAffixes[i]!));
  }
  return output;
}

/**
 * Word-wrap all lines in a multi-line string.
 * Splits on newlines first, then word-wraps each line — except framed and
 * borderless tables, which reflow as blocks (see the table sections above).
 */
export function wordWrapLines(text: string, width: number): string[] {
  const lines = text.split("\n");
  if (width <= 0) return lines;
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A borderless Codex markdown table is anchored by the segmented heavy
    // rule immediately after its header. Reflow the whole block so continuation
    // text stays inside its originating cell instead of returning to column 0.
    const borderless = matchBorderlessTableBlock(lines, i);
    if (borderless) {
      const block = lines.slice(i, borderless.end + 1);
      if (block.every((candidate) => visibleWidth(candidate) <= width)) {
        result.push(...block);
      } else {
        const reflowed = reflowBorderlessTable(borderless, width);
        if (reflowed) {
          result.push(...reflowed);
        } else {
          for (const candidate of block) {
            result.push(truncateToWidth(candidate, width, ""));
          }
        }
      }
      i = borderless.end + 1;
      continue;
    }
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
 * Locate agy's input-box chrome within UNWRAPPED logical lines
 * (SPEC-ANTIGRAVITY-CLI.md §4.6). agy's input box is a `>` prompt line between
 * two `────` separators with a bottom status line below them carrying the
 * `? for shortcuts` (idle) / `esc to cancel` (working) hint and the
 * `accept-edits · <model> · <effort>` segment — the same two-separator shape as
 * claude's, so it reuses findLastTwoSeparators. We ADDITIONALLY require an agy
 * status line in the tail so an unrelated pair of separators inside the
 * transcript (e.g. a markdown table) can't be mistaken for the input box; when
 * that guard or the separators are absent, returns null and the caller trims
 * nothing. Returns the upper/lower separator indices.
 */
export function findAgyInputChromeLogical(
  lines: string[],
): { upperIndex: number; lowerIndex: number } | null {
  let endIndex = lines.length - 1;
  while (endIndex >= 0 && stripAnsi(lines[endIndex]!).trim() === "") {
    endIndex--;
  }
  if (endIndex < 0) return null;

  // Require an agy status line in the last few non-blank lines — the bottom-left
  // hint or the right-side accept-edits/plan segment that only agy renders.
  const tailWindow = lines.slice(Math.max(0, endIndex - 3), endIndex + 1);
  const hasAgyStatus = tailWindow.some((l) => {
    const s = stripAnsi(l);
    return (
      /\? for shortcuts\b/.test(s) ||
      /\besc to cancel\b/.test(s) ||
      /\b(?:accept-edits|plan)\s+·/.test(s)
    );
  });
  if (!hasAgyStatus) return null;

  const { upperIndex, lowerIndex } = findLastTwoSeparators(lines);
  if (upperIndex < 0) return null;
  return { upperIndex, lowerIndex };
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
 * - agy: the last two `─` separators (bracketing the `>` prompt) guarded by an
 *   agy status line; transcript = above the upper separator, statusLines = below
 *   the lower separator. Falls back to no trimming when not detectable.
 * - Claude: find the last two `─` separators; transcript = everything above the
 *   upper separator, statusLines = everything below the lower separator (trailing
 *   blank padding stripped).
 * - No chrome found: the whole capture is the transcript, no status lines.
 *
 * `isCodex` / `isAgy` are mutually exclusive (an agent is exactly one CLI); when
 * both are false the claude detector runs. Only the flag matching the agent is
 * set by callers.
 */
export function computeChromeSlice(raw: string, isCodex: boolean, isAgy = false): ChromeSlice {
  const lines = raw.split("\n");

  if (isCodex) {
    const chrome = findCodexInputChromeLogical(lines);
    if (!chrome) return { transcriptRaw: raw, statusLines: [] };
    return {
      transcriptRaw: lines.slice(0, chrome.promptIndex).join("\n"),
      statusLines: lines.slice(chrome.statusIndex, chrome.endIndex + 1),
    };
  }

  if (isAgy) {
    const chrome = findAgyInputChromeLogical(lines);
    if (!chrome) return { transcriptRaw: raw, statusLines: [] };
    const { upperIndex, lowerIndex } = chrome;
    const statusLines = lowerIndex >= 0 && lowerIndex < lines.length - 1
      ? lines.slice(lowerIndex + 1)
      : [];
    while (statusLines.length > 0 && stripAnsi(statusLines[statusLines.length - 1]!).trim() === "") {
      statusLines.pop();
    }
    return { transcriptRaw: lines.slice(0, upperIndex).join("\n"), statusLines };
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
