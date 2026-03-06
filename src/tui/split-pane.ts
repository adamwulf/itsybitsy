/**
 * SplitPane — custom pi-tui component that renders two children side-by-side.
 * pi-tui's Box only does vertical layout, so we manually merge rendered lines.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

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

      // Pad left to exact width
      const leftVisible = visibleWidth(ll);
      const leftPadded = leftVisible >= lw
        ? truncateToWidth(ll, lw, "")
        : ll + " ".repeat(lw - leftVisible);

      // Truncate right to fit
      const rightTruncated = truncateToWidth(rl, rw, "");

      result.push(leftPadded + this.separator + rightTruncated);
    }

    return result;
  }
}
