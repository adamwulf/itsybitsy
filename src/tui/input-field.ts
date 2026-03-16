/**
 * Input field component for message composition.
 *
 * Renders 3 lines: top separator, input line with cursor, bottom separator.
 * Supports basic line editing: backspace, Ctrl-A (home), Ctrl-E (end), Ctrl-U (clear).
 * See SPEC.md §13.4.
 */

import { truncateToWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { DIM_GRAY, RESET } from "./colors";

export class InputFieldComponent implements Component {
  private text = "";
  private cursor = 0;
  onSubmit: ((text: string) => void) | null = null;
  onCancel: (() => void) | null = null;

  invalidate(): void {}

  /** Get the current input text (for testing). */
  getText(): string {
    return this.text;
  }

  /** Get the current cursor position (for testing). */
  getCursor(): number {
    return this.cursor;
  }

  /** Clear the input field text and reset cursor. */
  clear(): void {
    this.text = "";
    this.cursor = 0;
  }

  /**
   * Handle keyboard input. Returns true if the input was consumed.
   */
  handleInput(data: string): boolean {
    // Enter: submit
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      const submitted = this.text;
      this.onSubmit?.(submitted);
      this.text = "";
      this.cursor = 0;
      return true;
    }

    // Escape: cancel
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.onCancel?.();
      return true;
    }

    // Backspace
    if (data === "\x7f" || data === "\b") {
      if (this.cursor > 0) {
        this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
        this.cursor--;
      }
      return true;
    }

    // Ctrl-A: move cursor to start
    if (data === "\x01") {
      this.cursor = 0;
      return true;
    }

    // Ctrl-E: move cursor to end
    if (data === "\x05") {
      this.cursor = this.text.length;
      return true;
    }

    // Ctrl-U: clear line
    if (data === "\x15") {
      this.text = "";
      this.cursor = 0;
      return true;
    }

    // Tab / Shift-Tab: not consumed (let dashboard handle focus cycling)
    if (data === "\t" || matchesKey(data, Key.tab) || data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) {
      return false;
    }

    // Printable characters (single char, code >= 32)
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.text = this.text.slice(0, this.cursor) + data + this.text.slice(this.cursor);
      this.cursor++;
      return true;
    }

    // Unhandled (e.g., arrow keys, other control sequences)
    return false;
  }

  render(width: number): string[] {
    const sep = `${DIM_GRAY}${"─".repeat(width)}${RESET}`;
    // Build input line: "> text" with cursor block at cursor position
    const before = this.text.slice(0, this.cursor);
    const after = this.text.slice(this.cursor);
    const inputContent = `> ${before}█${after}`;
    const inputLine = truncateToWidth(inputContent, width, "");
    return [sep, inputLine, sep];
  }
}
