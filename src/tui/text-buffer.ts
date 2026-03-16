/**
 * Reusable multi-line text editing buffer.
 *
 * Encapsulates a string[] lines buffer and all editing operations:
 * Enter, backspace, alt-backspace (word delete), paste (Ctrl+V, bracketed, multi-char),
 * and printable character insertion.
 *
 * Used by InputFieldComponent and dialog textarea/new-agent-form states.
 */

import { matchesKey, Key } from "@mariozechner/pi-tui";
import { resolvePasteText, insertTextIntoLines } from "./clipboard";

/** Delete the last word (or trailing whitespace) from a string. */
export function deleteWord(s: string): string {
  return s.replace(/(?:\s+|\S+)\s*$/, "");
}

export class TextBuffer {
  private lines: string[];

  constructor(initial?: string[]) {
    this.lines = initial ? [...initial] : [""];
  }

  /** Get the full text content as a single string. */
  getText(): string {
    return this.lines.join("\n");
  }

  /** Get a copy of the lines array. */
  getLines(): string[] {
    return [...this.lines];
  }

  /** Get a direct reference to the internal lines array (for rendering).
   *  Warning: clear() and setLines() replace the internal array, so do not
   *  hold this reference across mutations — use it only within a single render pass. */
  getLinesRef(): readonly string[] {
    return this.lines;
  }

  /** Reset the buffer to empty. */
  clear(): void {
    this.lines = [""];
  }

  /** Replace the buffer contents with the given lines. */
  setLines(lines: string[]): void {
    this.lines = [...lines];
  }

  /** Check if the buffer has any content. */
  hasContent(): boolean {
    return this.lines.length > 1 || this.lines[0] !== "";
  }

  /**
   * Handle keyboard input for text editing.
   * Handles Enter (new line), backspace (delete char or join lines),
   * Alt-backspace (word delete), paste (Ctrl+V, bracketed, multi-char),
   * and printable character input.
   * @param onAsyncRender Optional callback for async paste operations (e.g., Ctrl+V clipboard read).
   * @returns true if the input was handled.
   */
  handleInput(data: string, onAsyncRender?: () => void): boolean {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.shift("enter"))) {
      this.lines.push("");
      return true;
    }
    if (matchesKey(data, Key.alt("backspace"))) {
      const lastIdx = this.lines.length - 1;
      const lastLine = this.lines[lastIdx] ?? "";
      const trimmed = deleteWord(lastLine);
      if (trimmed.length < lastLine.length) {
        this.lines[lastIdx] = trimmed;
      } else if (lastIdx > 0) {
        this.lines.pop();
      }
      return true;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      const lastIdx = this.lines.length - 1;
      const lastLine = this.lines[lastIdx] ?? "";
      if (lastLine.length > 0) {
        this.lines[lastIdx] = lastLine.slice(0, -1);
      } else if (lastIdx > 0) {
        this.lines.pop();
      }
      return true;
    }
    // Paste support: Ctrl+V, bracketed paste, or multi-char printable data
    const pasteApply = (text: string) => {
      insertTextIntoLines(this.lines, text);
      onAsyncRender?.();
    };
    const pasteText = resolvePasteText(data, pasteApply);
    if (pasteText !== null) {
      insertTextIntoLines(this.lines, pasteText);
      return true;
    }
    // Ctrl+V: resolvePasteText already dispatched async clipboard read above; consume the input
    if (data === "\x16") return true;

    if (data.length === 1 && data >= " ") {
      const lastIdx = this.lines.length - 1;
      this.lines[lastIdx] = (this.lines[lastIdx] ?? "") + data;
      return true;
    }
    return false;
  }
}
