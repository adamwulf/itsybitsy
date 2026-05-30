/**
 * ChannelPaneComponent — the main-area "team channel" chat box (SPEC §17.4).
 *
 * This is a pure RENDER component, modeled on `TmuxPaneComponent`
 * (`src/tui/dashboard.ts`): it does NOT decide *what* to show — the dashboard's
 * selection-sync (Phase 3) drives that by setting the `teamName` field on a
 * team-anchor selection (clearing it to `null` on any non-team / no selection).
 * This component owns the read + format + scroll: it tails a team's
 * `<team>.channel.jsonl` (via `readChannel`, §17.4) and renders the last N lines
 * newest-at-bottom, sender-prefixed, with tmux-pane-style scroll-back.
 *
 * Refresh contract (§17.4): `render(width)` is SYNCHRONOUS and renders from the
 * cached `messages` array. The dashboard calls the async `load()` on its EXISTING
 * per-tick / `TmuxPoller`-style refresh cadence (the same loop that re-reads the
 * selected agent's tmux pane), THEN calls `render(width)`. `load()` re-reads
 * `readChannel(teamName)` AND the `user.name` config (so the sync render can
 * reconstruct the human-form prefix without an await). Re-reading on every tick
 * — not just on selection-change — is what keeps the chat box current: a new
 * `ib send @<team>` line appears while the team stays selected.
 *
 * NEGATIVE CONSTRAINT (§17.4): the chat box reads ONLY `<team>.channel.jsonl`
 * (via `readChannel`). It NEVER reads or interleaves `<team>.log` (the lifecycle/
 * audit log) — messages and notices are deliberately separate. This module does
 * not import `teamLogPath` and does not touch the `.log` in any way.
 *
 * Sender-prefix grammar (reconstructed from the bare stored `message`, §16.4): the
 * on-disk record stores the RAW message with NO `[sent by …]` prefix; the prefix
 * is a tmux-delivery concern reconstructed here so the chat box reads IDENTICALLY
 * to what each member saw in their pane (`deliverMessage`, `ib-commands.ts`):
 *   - agent sender (real id, not `@`-prefixed, not `""`):
 *       `[sent by <id> in @<team>]: <msg>`  — the literal word "agent" is DROPPED
 *       inside a team context (the ` in @<team>` clause already establishes it).
 *   - `@`-sentinel sender (e.g. `@system`):
 *       `[sent by @system in @<team>]: <msg>` — the sentinel is kept verbatim.
 *   - human/CLI sender (`fromAgent === ""`):
 *       `[sent by user <name> in @<team>]: <msg>` WHEN a `user.name` is configured,
 *       `[sent by user in @<team>]: <msg>` WHEN it is not (the bare "user" form is
 *       ONLY the no-`user.name` case).
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { readChannel, type ChannelMessage } from "../team-channel";
import { readConfig } from "../config";
import { wrapLines, padLines } from "./wrap";
import { RESET, DIM } from "./colors";

/**
 * Render one channel record as a §16.4-grammar sender-prefixed line (no tmux
 * mechanics). Exported so tests can assert the prefix grammar directly.
 *
 * @param record   the stored channel message (raw text, no prefix)
 * @param teamName the bare team name (no `@`); a literal `@` is added in the prefix
 * @param userName the configured `user.name`, or null/empty if unset — drives the
 *                 human-form prefix (`user <name>` vs bare `user`)
 */
export function formatChannelLine(
  record: ChannelMessage,
  teamName: string,
  userName: string | null,
): string {
  const teamClause = ` in @${teamName}`;
  let label: string;
  if (record.fromAgent === "") {
    // Human/CLI sender — match deliverMessage's user form: `user <name>` when a
    // user.name is configured, bare `user` when it is not (§16.4 / §17.4 EDIT9).
    label =
      typeof userName === "string" && userName.length > 0 ? `user ${userName}` : "user";
  } else if (record.fromAgent.startsWith("@")) {
    // @-sentinel sender (e.g. `@system`) — kept verbatim (the bracket shape
    // already distinguishes it; for the chat box @system is the common case).
    label = record.fromAgent;
  } else {
    // Real agent id — the literal word "agent" is DROPPED in a team context
    // because the ` in @<team>` clause already establishes the sender is an
    // agent in a room (§16.4 delivery-prefix divergence).
    label = record.fromAgent;
  }
  return `[sent by ${label}${teamClause}]: ${record.message}`;
}

/** Format an epoch-SECONDS timestamp as a short `HH:MM` clock-time gutter. */
function formatClockGutter(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class ChannelPaneComponent implements Component {
  /**
   * Which team's `<team>.channel.jsonl` to render (bare name, no `@`). Set by the
   * dashboard's selection-sync on a team-anchor selection; cleared to `null` on
   * any non-team / no selection. `null` → the no-selection placeholder.
   */
  teamName: string | null = null;

  /** Cached channel records (FIFO / append order), refreshed by `load()`. */
  messages: ChannelMessage[] = [];

  /**
   * Cached `user.name` from config, read once in `load()` so the sync `render`
   * can build the human-form prefix without awaiting. `null` when unset.
   */
  userName: string | null = null;

  /** Lines scrolled back from the bottom. 0 = following the newest message. */
  scrollBack = 0;

  /** Available display height, set by the dashboard before each render. */
  displayHeight = 20;

  invalidate(): void {}

  /** Reset scroll/cache when switching teams (parallels TmuxPaneComponent.resetForAgent). */
  resetForTeam(): void {
    this.messages = [];
    this.scrollBack = 0;
  }

  scrollUp(amount = 1): void {
    this.scrollBack += amount;
  }

  scrollDown(amount = 1): void {
    this.scrollBack = Math.max(0, this.scrollBack - amount);
  }

  /**
   * Async refresh — re-read the channel and the `user.name` config. The dashboard
   * calls this on its existing per-tick refresh cadence (§17.4) BEFORE `render`.
   * Reads ONLY `<team>.channel.jsonl` (via `readChannel`) — never the `.log`.
   */
  async load(): Promise<void> {
    // Snapshot the target at the top so a fast team-switch A→B can't land A's
    // messages under B's header if A's readChannel happens to resolve AFTER B's
    // (mirrors TmuxPoller's snapshot-and-discard pattern). Display-only race; the
    // next tick self-heals it, but we want to avoid the cross-team flash.
    const t = this.teamName;
    const messages = t ? await readChannel(t) : [];
    const config = await readConfig();
    const name = config["user.name"]?.value;
    const userName = typeof name === "string" && name.length > 0 ? name : null;
    if (this.teamName !== t) return;
    this.messages = messages;
    this.userName = userName;
  }

  render(width: number): string[] {
    // No team selected → the §17.3 Teams no-selection main-area placeholder,
    // parallel to the Agents-panel no-selection placeholder.
    if (!this.teamName) {
      return padLines(
        [truncateToWidth(`${DIM}Select a team to view its channel${RESET}`, width, "")],
        this.displayHeight,
      );
    }

    // Team selected but no channel file yet (empty chat box).
    if (this.messages.length === 0) {
      return padLines(
        [truncateToWidth(`${DIM}No messages in @${this.teamName} yet${RESET}`, width, "")],
        this.displayHeight,
      );
    }

    // Build the full wrapped line list (newest at the bottom). Each record
    // becomes a `HH:MM` dim gutter + the §16.4 sender-prefixed line, then is
    // hard-wrapped to the pane width (ANSI-aware) like the tmux pane does.
    const wrapped: string[] = [];
    for (const rec of this.messages) {
      const gutter = `${DIM}${formatClockGutter(rec.ts)}${RESET} `;
      const body = formatChannelLine(rec, this.teamName, this.userName);
      wrapped.push(...wrapLines(gutter + body, width));
    }

    // Clamp scrollBack to the valid range (mirrors TmuxPaneComponent).
    const maxScrollBack = Math.max(0, wrapped.length - this.displayHeight);
    if (this.scrollBack > maxScrollBack) {
      this.scrollBack = maxScrollBack;
    }

    // Slice the visible window from the bottom (scroll-back-from-end), reserving
    // one row for the scroll indicator when scrolled back — identical to the
    // tmux pane's scroll-back logic.
    const contentHeight = this.scrollBack > 0 ? this.displayHeight - 1 : this.displayHeight;
    const end = wrapped.length - this.scrollBack;
    const start = Math.max(0, end - contentHeight);
    const visible = wrapped.slice(start, end);

    const lines = visible.map((line) => truncateToWidth(line, width, ""));

    if (this.scrollBack > 0) {
      lines.push(
        truncateToWidth(`${DIM}── ↓ ${this.scrollBack} lines below ──${RESET}`, width, ""),
      );
    }

    return padLines(lines, this.displayHeight);
  }
}
