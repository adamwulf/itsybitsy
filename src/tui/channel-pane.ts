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
 * Sender-prefix grammar (§17.4 in-pane form): the chat box already lives under
 * the selected team's view (the team name is the panel context), so the in-pane
 * prefix OMITS the ` in @<team>` clause that the tmux-delivery form uses. The
 * on-disk record stores the RAW message with NO `[sent by …]` prefix; here we
 * reconstruct a SHORTENED version of the §16.4 grammar:
 *   - agent sender (real id, not `@`-prefixed, not `""`):
 *       `[sent by <repoName>/<id>]: <msg>` WHEN the agent's repo is known
 *       (cross-repo disambiguation — many teams span repos),
 *       `[sent by <id>]: <msg>` WHEN the repo lookup misses (archived /
 *       unknown / cross-coordinator agent). The literal word "agent" is
 *       still dropped in both forms (the chat-box context already
 *       establishes the sender is an agent). The lookup is dashboard-driven:
 *       `ChannelPaneComponent.agentRepoById` is populated by the dashboard's
 *       `onUpdate` from the current `Agent[]`.
 *   - `@`-sentinel sender (e.g. `@system`):
 *       `[sent by @system]: <msg>` — the sentinel is kept verbatim.
 *   - human/CLI sender (`fromAgent === ""`):
 *       `[sent by user <name>]: <msg>` WHEN a `user.name` is configured,
 *       `[sent by user]: <msg>` WHEN it is not (the bare "user" form is ONLY
 *       the no-`user.name` case).
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { readChannel, type ChannelMessage } from "../team-channel";
import { readConfig } from "../config";
import { wrapLines, padLines } from "./wrap";
import { RESET, BOLD, DIM, CYAN, BRIGHT_BLUE, BRIGHT_MAGENTA } from "./colors";

/**
 * Render one channel record as a sender-prefixed line in the team chat box
 * (no tmux mechanics). Exported so tests can assert the prefix grammar
 * directly.
 *
 * The in-pane grammar drops the ` in @<team>` clause from the §16.4
 * tmux-delivery form because the chat box already lives under the selected
 * team's view — the team name is the panel context, so repeating it on every
 * line is noise. `teamName` is retained in the signature for forward use
 * (and so callers don't have to thread context through differently for chat
 * vs. delivery prefixes) but is no longer interpolated.
 *
 * @param record   the stored channel message (raw text, no prefix)
 * @param teamName the bare team name (no `@`) — reserved for forward use; not rendered
 * @param userName the configured `user.name`, or null/empty if unset — drives the
 *                 human-form prefix (`user <name>` vs bare `user`)
 * @param agentRepoById optional map from agent id → repo name; when provided and
 *                 the record's `fromAgent` is a real agent id with an entry in
 *                 the map, the rendered label is prefixed `<repoName>/<id>` so
 *                 chat lines disambiguate cross-repo participants. Map miss is a
 *                 graceful fallback to the bare agent id (no stray slash, no
 *                 throw). Does NOT affect `@`-sentinel or human senders.
 */
export function formatChannelLine(
  record: ChannelMessage,
  _teamName: string,
  userName: string | null,
  agentRepoById?: Map<string, string> | null,
): string {
  let label: string;
  let color: string;
  if (record.fromAgent === "") {
    // Human/CLI sender — match deliverMessage's user form: `user <name>` when a
    // user.name is configured, bare `user` when it is not (§16.4 / §17.4 EDIT9).
    label =
      typeof userName === "string" && userName.length > 0 ? `user ${userName}` : "user";
    color = BRIGHT_BLUE;
  } else if (record.fromAgent.startsWith("@")) {
    // @-sentinel sender (e.g. `@system`) — kept verbatim (the bracket shape
    // already distinguishes it; for the chat box @system is the common case).
    label = record.fromAgent;
    color = BRIGHT_MAGENTA;
  } else {
    // Real agent id — render `<repoName>/<id>` when the dashboard-supplied
    // lookup map has an entry for this agent (cross-repo disambiguation —
    // many teams span repos), falling back to the bare id on map miss
    // (archived / unknown / cross-coordinator). The literal word "agent" is
    // DROPPED in both forms (the panel's team context already establishes
    // the sender is an agent in this room — §16.4 delivery-prefix divergence).
    const repoName = agentRepoById?.get(record.fromAgent);
    label = repoName ? `${repoName}/${record.fromAgent}` : record.fromAgent;
    color = CYAN;
  }
  // The bracketed sender prefix is BOLD + color so it visually separates from
  // the message body in the chat box.
  const prefix = `${BOLD}${color}[sent by ${label}]:${RESET}`;
  return `${prefix} ${record.message}`;
}

/**
 * Render one SYSTEM (lifecycle) record as a dimmed `── … ──` separator-style
 * line. System records carry join/leave/team-create notices that are written to
 * `<team>.channel.jsonl` alongside chat (§17.4 design update); this renders
 * them in a visually distinct, deliberately quieter form so they don't compete
 * with the chat grammar. Exported so tests can assert directly.
 *
 * Actor shapes:
 *   - real agent id (not `@`-prefixed, not `""`) → `── <agentId> <message> ──`
 *     (e.g. `── agent-abc123 joined the team ──`)
 *   - `@`-sentinel actor (e.g. `@system`) → `── <message> ──`
 *     (the sentinel is dropped — `@system created the team` is noise; the
 *     bare separator form already reads as a system event)
 *
 * The whole line is wrapped in `DIM`/`RESET` so the chat box renders it dimmed.
 */
export function formatChannelSystemLine(record: ChannelMessage): string {
  const isSentinel = record.fromAgent.startsWith("@");
  const isHuman = record.fromAgent === "";
  const body =
    isSentinel || isHuman
      ? record.message
      : `${record.fromAgent} ${record.message}`;
  return `${DIM}── ${body} ──${RESET}`;
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

  /**
   * Map from agent id → repo name, refreshed by the dashboard's `onUpdate` from
   * the current `Agent[]`. The render pass threads it into `formatChannelLine`
   * so real-agent-id chat lines render as `<repoName>/<agentId>` (map miss →
   * bare id; archived / unknown / cross-repo agents fall through gracefully).
   * Empty map → every line falls through to the bare-id form (the no-data form).
   */
  agentRepoById: Map<string, string> = new Map();

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
    // becomes a `HH:MM` dim gutter + the per-kind formatted body, then is
    // hard-wrapped to the pane width (ANSI-aware) like the tmux pane does.
    // The gutter shape is identical for chat and system records (the clock-
    // time is useful context for both); only the body changes — chat uses the
    // §16.4 sender-prefixed grammar, system uses the dimmed `── … ──` form.
    const wrapped: string[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const rec = this.messages[i]!;
      const gutter = `${DIM}${formatClockGutter(rec.ts)}${RESET} `;
      const body =
        rec.kind === "system"
          ? formatChannelSystemLine(rec)
          : formatChannelLine(rec, this.teamName, this.userName, this.agentRepoById);
      wrapped.push(...wrapLines(gutter + body, width));
      // Insert a blank visual separator BETWEEN messages (not after the
      // newest) so chat reads less like a wall of text. The blank line counts
      // toward the scrollback window like any other rendered row.
      if (i < this.messages.length - 1) {
        wrapped.push("");
      }
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
