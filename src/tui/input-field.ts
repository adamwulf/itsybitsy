/**
 * Multi-line input field component for message composition.
 *
 * Renders: top separator, content lines with cursor, bottom separator with [Send] button.
 * Uses handleTextEdit() for text editing (Enter = new line, Alt+Backspace = word delete, paste support).
 * Tab moves focus to [Send] button; Enter on [Send] submits. Escape clears and defocuses.
 * Per-agent input buffers: each agent's typed text is preserved when switching agents.
 * See SPEC.md §13.4.
 */

import { truncateToWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { DIM_GRAY, RESET, BOLD, GREEN, DIM } from "./colors";
import { handleTextEdit } from "./dialog-handler";

/** Maximum number of visible content lines before scrolling */
const MAX_VISIBLE_LINES = 5;

export class InputFieldComponent implements Component {
  private lines: string[] = [""];
  private focused: "text" | "send" = "text";
  /** Per-agent input buffers: agentId → lines array */
  private agentBuffers = new Map<string, string[]>();
  private currentAgentId: string | null = null;
  onSubmit: ((text: string) => void) | null = null;
  onCancel: (() => void) | null = null;

  invalidate(): void {}

  /** Get the current input text (for testing). */
  getText(): string {
    return this.lines.join("\n");
  }

  /** Get the lines array (for testing). */
  getLines(): string[] {
    return [...this.lines];
  }

  /** Get the current focus target (for testing). */
  getFocus(): "text" | "send" {
    return this.focused;
  }

  /** Clear the input field text and reset to default state. */
  clear(): void {
    this.lines = [""];
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
      const hasContent = this.lines.length > 1 || this.lines[0] !== "";
      if (hasContent) {
        this.agentBuffers.set(this.currentAgentId, [...this.lines]);
      } else {
        this.agentBuffers.delete(this.currentAgentId);
      }
    }

    this.currentAgentId = agentId;

    // Load target agent's buffer
    if (agentId && this.agentBuffers.has(agentId)) {
      this.lines = [...this.agentBuffers.get(agentId)!];
    } else {
      this.lines = [""];
    }
    this.focused = "text";
  }

  /** Get the number of lines this component will render. */
  getHeight(): number {
    const contentLines = Math.min(Math.max(1, this.lines.length), MAX_VISIBLE_LINES);
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
        this.lines = [""];
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

      // Delegate to handleTextEdit for text editing
      if (handleTextEdit(data, this.lines)) {
        this.saveCurrentBuffer();
        return true;
      }

      return false;
    }

    // focused === "send"
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      const text = this.lines.join("\n");
      this.lines = [""];
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
    if (handleTextEdit(data, this.lines)) {
      this.focused = "text";
      this.saveCurrentBuffer();
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    const sep = `${DIM_GRAY}${"─".repeat(width)}${RESET}`;

    // Build content lines with scroll if needed
    const totalLines = this.lines.length;
    const visibleCount = Math.min(Math.max(1, totalLines), MAX_VISIBLE_LINES);
    const scrollOffset = Math.max(0, totalLines - visibleCount);

    const contentLines: string[] = [];
    for (let vi = 0; vi < visibleCount; vi++) {
      const li = scrollOffset + vi;
      const lineText = this.lines[li] ?? "";
      const isLastLine = li === totalLines - 1;
      const prefix = li === 0 ? "> " : "  ";
      if (isLastLine && this.focused === "text") {
        contentLines.push(truncateToWidth(`${prefix}${lineText}█`, width, ""));
      } else {
        contentLines.push(truncateToWidth(`${prefix}${lineText}`, width, ""));
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
    const bottomSep = `${DIM_GRAY}${"─".repeat(leftDashes)}${RESET} ${sendLabel} ${DIM_GRAY}${"─".repeat(rightDashes)}${RESET}`;

    return [sep, ...contentLines, truncateToWidth(bottomSep, width, "")];
  }

  /** Save current lines to the per-agent buffer map. */
  private saveCurrentBuffer(): void {
    if (this.currentAgentId) {
      const hasContent = this.lines.length > 1 || this.lines[0] !== "";
      if (hasContent) {
        this.agentBuffers.set(this.currentAgentId, [...this.lines]);
      } else {
        this.agentBuffers.delete(this.currentAgentId);
      }
    }
  }
}
