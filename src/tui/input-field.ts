/**
 * Multi-line input field component for message composition.
 *
 * Renders: top separator, content lines with cursor, bottom separator with [Send] button.
 * Uses TextBuffer for text editing (Enter = new line, Alt+Backspace = word delete, paste support).
 * Tab moves focus to [Send] button; Enter on [Send] submits. Escape clears and defocuses.
 * Per-agent input buffers: each agent's typed text is preserved when switching agents.
 * See SPEC.md §13.4.
 */

import { truncateToWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { DIM_GRAY, RESET, BOLD, GREEN, DIM } from "./colors";
import { TextBuffer } from "./text-buffer";

/** Maximum number of visible content lines before scrolling */
const MAX_VISIBLE_LINES = 5;

export class InputFieldComponent implements Component {
  private buffer = new TextBuffer();
  private focused: "text" | "send" = "text";
  /** Per-agent input buffers: agentId → lines snapshot */
  private agentBuffers = new Map<string, string[]>();
  private currentAgentId: string | null = null;
  /** Whether the input field is active (focused panel). Controls cursor visibility. */
  active = true;
  onSubmit: ((text: string) => void) | null = null;
  onCancel: (() => void) | null = null;

  invalidate(): void {}

  /** Get the current input text (for testing). */
  getText(): string {
    return this.buffer.getText();
  }

  /** Get the lines array (for testing). */
  getLines(): string[] {
    return this.buffer.getLines();
  }

  /** Get the current focus target (for testing). */
  getFocus(): "text" | "send" {
    return this.focused;
  }

  /** Clear the input field text and reset to default state. */
  clear(): void {
    this.buffer.clear();
    this.focused = "text";
    // Also clear from per-agent buffer
    if (this.currentAgentId) {
      this.agentBuffers.delete(this.currentAgentId);
    }
  }

  /**
   * Switch to a different agent's input buffer.
   * Saves the current buffer and loads the target agent's cached buffer.
   */
  switchAgent(agentId: string | null): void {
    // Save current buffer
    if (this.currentAgentId) {
      if (this.buffer.hasContent()) {
        this.agentBuffers.set(this.currentAgentId, this.buffer.getLines());
      } else {
        this.agentBuffers.delete(this.currentAgentId);
      }
    }

    this.currentAgentId = agentId;

    // Load target agent's buffer
    if (agentId && this.agentBuffers.has(agentId)) {
      this.buffer.setLines(this.agentBuffers.get(agentId)!);
    } else {
      this.buffer.clear();
    }
    this.focused = "text";
  }

  /** Get the number of lines this component will render, accounting for text wrapping. */
  getHeight(width: number): number {
    const wrappedCount = this.computeWrappedLineCount(width);
    const contentLines = Math.min(Math.max(1, wrappedCount), MAX_VISIBLE_LINES);
    return 2 + contentLines; // top separator + content + bottom separator
  }

  /**
   * Handle keyboard input. Returns true if the input was consumed.
   */
  handleInput(data: string): boolean {
    // Escape: cancel (clear and defocus)
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.clear();
      this.onCancel?.();
      return true;
    }

    if (this.focused === "text") {
      // Tab: move to [Send] button
      if (data === "\t" || matchesKey(data, Key.tab)) {
        this.focused = "send";
        return true;
      }

      // Shift-Tab: not consumed (let dashboard cycle backwards)
      if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
        return false;
      }

      // Ctrl-U: clear all lines
      if (data === "\x15") {
        this.buffer.clear();
        return true;
      }

      // Ctrl-A: move to start of current line (no-op with append-only cursor)
      if (data === "\x01") {
        return true;
      }

      // Ctrl-E: move to end of current line (no-op with append-only cursor)
      if (data === "\x05") {
        return true;
      }

      // Delegate to TextBuffer for text editing
      if (this.buffer.handleInput(data)) {
        this.saveCurrentBuffer();
        return true;
      }

      return false;
    }

    // focused === "send"
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      const text = this.buffer.getText();
      this.buffer.clear();
      this.focused = "text";
      // Clear per-agent buffer on submit
      if (this.currentAgentId) {
        this.agentBuffers.delete(this.currentAgentId);
      }
      this.onSubmit?.(text);
      return true;
    }

    // Tab: not consumed (let dashboard cycle forward)
    if (data === "\t" || matchesKey(data, Key.tab)) {
      return false;
    }

    // Shift-Tab: back to text
    if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
      this.focused = "text";
      return true;
    }

    // If user starts typing while on Send, switch back to text mode
    if (this.buffer.handleInput(data)) {
      this.focused = "text";
      this.saveCurrentBuffer();
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const sepStyle = this.active ? BOLD : `${DIM}${DIM_GRAY}`;
    const sep = `${sepStyle}${"─".repeat(width)}${RESET}`;

    // Build wrapped content lines with scroll if needed
    const textWidth = Math.max(1, width - 2); // 2-char prefix
    const allWrapped = this.wrapAllLines(textWidth);
    const totalWrapped = allWrapped.length;
    const visibleCount = Math.min(Math.max(1, totalWrapped), MAX_VISIBLE_LINES);
    const scrollOffset = Math.max(0, totalWrapped - visibleCount);

    const showCursor = this.active && this.focused === "text";
    const contentLines: string[] = [];
    for (let vi = 0; vi < visibleCount; vi++) {
      const entry = allWrapped[scrollOffset + vi];
      if (!entry) continue;
      const isLast = (scrollOffset + vi) === totalWrapped - 1;
      if (isLast && showCursor) {
        contentLines.push(truncateToWidth(`${entry.prefix}${entry.text}█`, width, ""));
      } else {
        contentLines.push(truncateToWidth(`${entry.prefix}${entry.text}`, width, ""));
      }
    }

    // Build bottom separator with [Send] button
    const sendLabel = this.focused === "send"
      ? `${BOLD}${GREEN}[Send]${RESET}`
      : `${DIM}[Send]${RESET}`;
    const sendTextLen = "[Send]".length;
    const dashesAvailable = width - sendTextLen - 2; // 2 for spaces around label
    if (dashesAvailable < 2) {
      // Too narrow — just show send label
      return [sep, ...contentLines, truncateToWidth(sendLabel, width, "")];
    }
    const leftDashes = Math.max(1, Math.floor(dashesAvailable / 2));
    const rightDashes = Math.max(1, dashesAvailable - leftDashes);
    const bottomSep = `${sepStyle}${"─".repeat(leftDashes)}${RESET} ${sendLabel} ${sepStyle}${"─".repeat(rightDashes)}${RESET}`;

    return [sep, ...contentLines, truncateToWidth(bottomSep, width, "")];
  }

  /**
   * Compute the total number of wrapped physical lines across all logical lines.
   * Input text is plain text (no ANSI), so string.length is used for width.
   */
  private computeWrappedLineCount(width: number): number {
    const textWidth = Math.max(1, width - 2); // 2-char prefix
    let count = 0;
    for (const line of this.buffer.getLinesRef()) {
      count += Math.max(1, Math.ceil(line.length / textWidth) || 1);
    }
    return count;
  }

  /**
   * Wrap all logical lines into physical line entries with prefix info.
   * Each entry has { prefix, text } where prefix is '> ' for first logical line's first chunk,
   * '  ' for continuation lines.
   */
  private wrapAllLines(textWidth: number): Array<{ prefix: string; text: string }> {
    const lines = this.buffer.getLinesRef();
    const result: Array<{ prefix: string; text: string }> = [];
    for (let li = 0; li < lines.length; li++) {
      const lineText = lines[li] ?? "";
      const firstPrefix = li === 0 ? "> " : "  ";
      if (lineText.length <= textWidth) {
        result.push({ prefix: firstPrefix, text: lineText });
      } else {
        // Split into chunks of textWidth
        for (let offset = 0; offset < lineText.length; offset += textWidth) {
          const chunk = lineText.slice(offset, offset + textWidth);
          const prefix = offset === 0 ? firstPrefix : "  ";
          result.push({ prefix, text: chunk });
        }
      }
    }
    if (result.length === 0) {
      result.push({ prefix: "> ", text: "" });
    }
    return result;
  }

  /** Save current lines to the per-agent buffer map. */
  private saveCurrentBuffer(): void {
    if (this.currentAgentId) {
      if (this.buffer.hasContent()) {
        this.agentBuffers.set(this.currentAgentId, this.buffer.getLines());
      } else {
        this.agentBuffers.delete(this.currentAgentId);
      }
    }
  }
}
