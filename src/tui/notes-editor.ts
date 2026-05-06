/**
 * NotesEditorComponent — multi-line notes editor for the Info panel.
 *
 * Reuses TextBuffer for editing (Enter = newline, Backspace, Alt+Backspace,
 * paste). Renders wrapped lines with append-only cursor at the end, scrolling
 * when content exceeds visibleLines. No [Send] button — saves are blur-driven
 * by the dashboard.
 */

import { truncateToWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { RESET, DIM } from "./colors";
import { TextBuffer } from "./text-buffer";

/** Default maximum number of visible content lines before scrolling. */
const DEFAULT_VISIBLE_LINES = 5;

export class NotesEditorComponent implements Component {
  private buffer = new TextBuffer();
  /** Whether the editor is the focused sub-field (drives cursor visibility/styling). */
  active = false;
  /** Maximum visible content lines before vertical scrolling kicks in. */
  visibleLines = DEFAULT_VISIBLE_LINES;
  /** Optional callback fired when the buffer changes asynchronously (e.g. paste). */
  onAsyncRender?: () => void;

  invalidate(): void {}

  /** Replace the buffer's contents. Used when switching repos or reverting on Escape. */
  setText(text: string): void {
    this.buffer = new TextBuffer(text === "" ? [""] : text.split("\n"));
  }

  /** Get the current text content. */
  getText(): string {
    return this.buffer.getText();
  }

  /**
   * Handle keyboard input. Returns true if consumed.
   * Tab and Escape are NOT consumed — the dashboard handles blur/cancel.
   */
  handleInput(data: string): boolean {
    // Don't swallow Tab / Shift-Tab — dashboard owns sub-field cycling.
    if (data === "\t" || matchesKey(data, Key.tab)) return false;
    if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) return false;
    // Don't swallow Escape — dashboard handles revert.
    if (matchesKey(data, Key.escape) || data === "\x1b") return false;

    return this.buffer.handleInput(data, this.onAsyncRender);
  }

  /** Number of rendered lines for the current text and width. Caller pads/clips. */
  getHeight(width: number): number {
    const wrapped = this.wrapAllLines(Math.max(1, width - 2));
    return Math.min(Math.max(1, wrapped.length), this.visibleLines);
  }

  render(width: number): string[] {
    const textWidth = Math.max(1, width - 2);
    const allWrapped = this.wrapAllLines(textWidth);
    const totalWrapped = allWrapped.length;
    const visibleCount = Math.min(Math.max(1, totalWrapped), this.visibleLines);
    const scrollOffset = Math.max(0, totalWrapped - visibleCount);

    const showCursor = this.active;
    const out: string[] = [];
    for (let vi = 0; vi < visibleCount; vi++) {
      const entry = allWrapped[scrollOffset + vi];
      if (!entry) continue;
      const isLast = (scrollOffset + vi) === totalWrapped - 1;
      const placeholderEmpty = !this.active && totalWrapped === 1 && entry.text.length === 0;
      if (placeholderEmpty) {
        out.push(truncateToWidth(`${entry.prefix}${DIM}(no notes)${RESET}`, width, ""));
      } else if (isLast && showCursor) {
        out.push(truncateToWidth(`${entry.prefix}${entry.text}█`, width, ""));
      } else {
        out.push(truncateToWidth(`${entry.prefix}${entry.text}`, width, ""));
      }
    }
    return out;
  }

  private wrapAllLines(textWidth: number): Array<{ prefix: string; text: string }> {
    const lines = this.buffer.getLines();
    const result: Array<{ prefix: string; text: string }> = [];
    for (let li = 0; li < lines.length; li++) {
      const lineText = lines[li] ?? "";
      const firstPrefix = li === 0 ? "│ " : "  ";
      if (lineText.length <= textWidth) {
        result.push({ prefix: firstPrefix, text: lineText });
      } else {
        for (let offset = 0; offset < lineText.length; offset += textWidth) {
          const chunk = lineText.slice(offset, offset + textWidth);
          const prefix = offset === 0 ? firstPrefix : "  ";
          result.push({ prefix, text: chunk });
        }
      }
    }
    if (result.length === 0) {
      result.push({ prefix: "│ ", text: "" });
    }
    return result;
  }
}
