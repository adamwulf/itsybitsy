/**
 * SplitPane — custom pi-tui component that renders two children side-by-side.
 * pi-tui's Box only does vertical layout, so we manually merge rendered lines.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { RESET } from "./colors";

export const MIN_LEFT_WIDTH = 40;
export const MAX_LEFT_WIDTH = 160;

export class SplitPane implements Component {
  private left: Component;
  private right: Component;
  private leftWidth: number;
  private separator: string;
  fullWidth = false;

  constructor(left: Component, right: Component, leftWidth: number, separator = "│") {
    this.left = left;
    this.right = right;
    this.leftWidth = leftWidth;
    this.separator = separator;
  }

  setLeft(c: Component) { this.left = c; }
  setRight(c: Component) { this.right = c; }
  setLeftWidth(w: number) { this.leftWidth = w; }
  getLeftWidth(): number { return this.leftWidth; }

  invalidate(): void {
    this.left.invalidate();
    this.right.invalidate();
  }

  render(width: number): string[] {
    if (this.fullWidth) {
      return this.right.render(width);
    }

    const sepWidth = visibleWidth(this.separator);
    const lw = Math.min(this.leftWidth, width - sepWidth - 1);
    const rw = width - lw - sepWidth;

    const leftLines = this.left.render(lw);
    const rightLines = this.right.render(rw);

    const maxLines = Math.max(leftLines.length, rightLines.length);
    const result: string[] = [];

    for (let i = 0; i < maxLines; i++) {
      const ll: string = i < leftLines.length ? leftLines[i]! : "";
      const rl: string = i < rightLines.length ? rightLines[i]! : "";

      // Pad left to exact width; insert RESET before padding so styled content
      // from the last left-pane character doesn't bleed into the separator.
      const leftVisible = visibleWidth(ll);
      const needsReset = ll.includes("\x1b[");
      const leftPadded = leftVisible >= lw
        ? truncateToWidth(ll, lw, "")
        : ll + (needsReset ? RESET : "") + " ".repeat(lw - leftVisible);

      // Truncate right to fit
      const rightTruncated = truncateToWidth(rl, rw, "");

      result.push(leftPadded + this.separator + rightTruncated);
    }

    return result;
  }
}
