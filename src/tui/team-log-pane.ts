/**
 * TeamLogPaneComponent — the right-pane "team log" view (SPEC §17.4 audit log).
 *
 * Renders the contents of a team's `<team>.log` (lifecycle/audit log). When a
 * team is selected in the dashboard's Teams panel, the channel chat box renders
 * on the LEFT (middle pane) and this component renders on the RIGHT — replacing
 * the agent-oriented right-pane mode (AGENT LOG / DENIALS / etc.) for the
 * duration of the team selection. The user's right-pane mode is preserved; only
 * the visual override is in effect.
 *
 * Modeled on `ChannelPaneComponent`: pure render off a cached lines array, with
 * an async `load()` driven by the dashboard's existing channel-refresh tick.
 * Reads ONLY `<team>.log` (via `teamLogPath`) — never `<team>.channel.jsonl`.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { readFile } from "fs/promises";
import { teamLogPath } from "../team-channel";
import { expandTabs } from "../tmux-poller";
import { wrapLines, padLines } from "./wrap";
import { RESET, DIM } from "./colors";

/** Colorize a `[YYYY-MM-DD HH:MM:SS]` timestamp prefix DIM, the rest plain. */
function colorizeLogLine(line: string): string {
  return line.replace(/^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\])/, `${DIM}$1${RESET}`);
}

export class TeamLogPaneComponent implements Component {
  /** Which team's `<team>.log` to render (bare name, no `@`). `null` → placeholder. */
  teamName: string | null = null;

  /** Cached log lines (FIFO / append order), refreshed by `load()`. */
  lines: string[] = [];

  /** Lines scrolled back from the bottom. 0 = following newest. */
  scrollBack = 0;

  /** Available display height, set by the dashboard before each render. */
  displayHeight = 20;

  invalidate(): void {}

  /** Reset scroll/cache when switching teams. */
  resetForTeam(): void {
    this.lines = [];
    this.scrollBack = 0;
  }

  scrollUp(amount = 1): void {
    this.scrollBack += amount;
  }

  scrollDown(amount = 1): void {
    this.scrollBack = Math.max(0, this.scrollBack - amount);
  }

  /**
   * Async refresh — re-read `<team>.log`. Mirrors ChannelPaneComponent.load()'s
   * snapshot-and-discard guard so a fast team-switch A→B can't leave A's log
   * lines under B's header.
   */
  async load(): Promise<void> {
    const t = this.teamName;
    let content: string;
    if (!t) {
      this.lines = [];
      return;
    }
    try {
      content = await readFile(teamLogPath(t), "utf-8");
    } catch {
      // Missing log file → empty (no lifecycle events yet).
      if (this.teamName !== t) return;
      this.lines = [];
      return;
    }
    if (this.teamName !== t) return;
    // Expand tabs at the boundary so downstream pi-tui slicing/wrapping
    // doesn't crash on files containing literal \t — same pi-tui v0.56.0
    // asymmetry handled by TmuxPoller; see expandTabs() docstring.
    const split = expandTabs(content).split("\n");
    // Drop a trailing empty string from the final newline.
    if (split.length > 0 && split[split.length - 1] === "") split.pop();
    this.lines = split;
  }

  render(width: number): string[] {
    if (!this.teamName) {
      return padLines(
        [truncateToWidth(`${DIM}Select a team to view its log${RESET}`, width, "")],
        this.displayHeight,
      );
    }

    if (this.lines.length === 0) {
      return padLines(
        [truncateToWidth(`${DIM}No log entries for @${this.teamName} yet${RESET}`, width, "")],
        this.displayHeight,
      );
    }

    // Wrap each log line at the pane width, ANSI-aware, mirroring the chat box.
    const wrapped: string[] = [];
    for (const line of this.lines) {
      wrapped.push(...wrapLines(colorizeLogLine(line), width));
    }

    // Clamp scrollBack to valid range.
    const maxScrollBack = Math.max(0, wrapped.length - this.displayHeight);
    if (this.scrollBack > maxScrollBack) {
      this.scrollBack = maxScrollBack;
    }

    // Reserve one row for the scroll indicator when scrolled back.
    const contentHeight = this.scrollBack > 0 ? this.displayHeight - 1 : this.displayHeight;
    const end = wrapped.length - this.scrollBack;
    const start = Math.max(0, end - contentHeight);
    const visible = wrapped.slice(start, end);

    const out = visible.map((l) => truncateToWidth(l, width, ""));

    if (this.scrollBack > 0) {
      out.push(
        truncateToWidth(`${DIM}── ↓ ${this.scrollBack} lines below ──${RESET}`, width, ""),
      );
    }

    return padLines(out, this.displayHeight);
  }
}
