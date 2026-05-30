/**
 * Per-team channel + log persistence (SPEC §17.4 — the chat box's backing store).
 *
 * The dashboard's main-area "team channel" view (§17.4) needs a real history to
 * tail. `ib send @<team>` already fans a message out to each member's tmux
 * scrollback (§16.4), but that delivery is ephemeral — once it scrolls off a
 * pane it is gone, and a newly-selected team in the dashboard would have nothing
 * to render. This module adds the persistent room history (and a separate
 * audit/lifecycle log) the chat box reads.
 *
 * TWO files per team, both under `~/.itsybitsy/teams/` (a new `teams/`
 * subdirectory beside `teams.json`, located via `getCoordinatorHome()` so the
 * `setCoordinatorHome` test override is honored, exactly like `teams.ts`):
 *
 *   1. `<team>.channel.jsonl` — the persistent CHAT HISTORY the chat box tails.
 *      One JSON line per `ib send @<team>` (and per dashboard team-send):
 *        { "ts": 1780166606, "fromAgent": "agent-a1b2c3d4", "message": "ship it" }
 *      `ts` is epoch SECONDS (to match `Team.created_epoch` and the §16 `_epoch`
 *      convention — the channel is a *display* log, so it reads consistently with
 *      the rest of the team data). `fromAgent` is the RESOLVED sender id (a real
 *      agent id, an `@`-sentinel like `@system`, or `""` for a human/CLI sender).
 *      `message` is the RAW text with NO `[sent by …]` prefix — the prefix is a
 *      tmux-delivery concern reconstructed at render time by the chat box from
 *      `fromAgent`.
 *
 *   2. `<team>.log` — a free-form per-team interaction LOG for lifecycle/system
 *      events (join, leave, "N members left", create/delete). One timestamped
 *      line per event, the same shape `agent.log` uses. This is the AUDIT/DEBUG
 *      log and is NEVER shown in the chat box — the chat box renders ONLY
 *      `<team>.channel.jsonl` (the negative constraint in §17.4: messages and
 *      lifecycle notices are deliberately separate; do not merge them).
 *
 * Append/read discipline — MIRRORS `src/outbox.ts` (§4.1.1) precisely, because
 * that discipline is already proven for exactly this shape of jsonl file:
 *   - APPEND is a single-line `appendFile(JSON.stringify(record) + "\n")` after a
 *     `mkdir(teamsDir, { recursive: true })` no-message-loss safeguard.
 *   - READ splits on "\n", skips blank/malformed lines (tolerant — NEVER throws),
 *     and reconstructs each record FIELD-BY-FIELD (not by spread) so a future
 *     field can't silently round-trip-drop (§16.4 trap). A missing file → [].
 *
 * Concurrency — NO LOCK (deliberately, §17.4). Unlike `teams.json` (which needs
 * `.teams.lock` because it is READ-MODIFY-WRITE and so has a lost-update race),
 * the channel is APPEND-ONLY. A single-line `appendFile` of a sub-`PIPE_BUF`
 * record is ATOMIC on POSIX (O_APPEND), so concurrent appenders never interleave
 * a half-written line — the same rationale `outbox.ts`/§4.1.1 relies on for
 * `enqueueOutbox`. There is nothing to lose-update, so there is nothing to lock.
 * Do NOT add a `.channel.lock`. The tolerant read (skip a torn final line) covers
 * the vanishingly rare partial-write case, identical to `readOutbox`.
 */

import { join } from "path";
import { appendFile, readFile, mkdir, unlink } from "fs/promises";
import { getCoordinatorHome } from "./coordinator";

/**
 * One persisted channel message — the on-disk shape of a `<team>.channel.jsonl`
 * line. Field names mirror `OutboxMessage` (`fromAgent`, `message`) so the two
 * records read alike.
 */
export interface ChannelMessage {
  /**
   * Creation time in epoch SECONDS (`Math.floor(Date.now() / 1000)`) to match
   * `Team.created_epoch` and the §16 `_epoch` convention. (The outbox uses ms;
   * the channel is a display log, so it matches the seconds convention here.)
   */
  ts: number;
  /**
   * The RESOLVED sender id: a real agent id, an `@`-sentinel (e.g. `@system`),
   * or `""` for a human/CLI sender. This is the same value `teamSend` resolves
   * via `resolveTeamSenderId` (§16.4).
   */
  fromAgent: string;
  /**
   * The RAW message text — NO `[sent by …]` prefix. The prefix is a tmux-delivery
   * concern reconstructed at render time by the chat box from `fromAgent`.
   */
  message: string;
  /**
   * Record kind. Defaults to "chat" when missing (existing records on disk
   * have no kind field and must continue to render as chat). New lifecycle
   * notices are written with kind: "system" and rendered dimmed in the chat box.
   * The §17.4 channel pane dispatches its render path off this field.
   */
  kind?: "chat" | "system";
}

/** Absolute path to `~/.itsybitsy/teams/`. Honors the `setCoordinatorHome` test override. */
function teamsDir(): string {
  return join(getCoordinatorHome(), "teams");
}

/**
 * Path to a team's persistent chat-history file (`<team>.channel.jsonl`).
 * Honors the `setCoordinatorHome` test override via `teamsDir()`.
 */
export function channelPath(teamName: string): string {
  return join(teamsDir(), `${teamName}.channel.jsonl`);
}

/**
 * Path to a team's free-form lifecycle/audit log (`<team>.log`).
 * Honors the `setCoordinatorHome` test override via `teamsDir()`.
 */
export function teamLogPath(teamName: string): string {
  return join(teamsDir(), `${teamName}.log`);
}

/**
 * Format a date as `YYYY-MM-DD HH:MM:SS` in local time — the SAME shape
 * `agent.log` uses via `agent-lifecycle.ts`'s `formatTimestamp`. Duplicated here
 * (rather than imported) to keep `team-channel.ts` free of an `agent-lifecycle`
 * dependency; the format is intentionally identical so the two logs read alike.
 */
function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Append ONE chat record to a team's `<team>.channel.jsonl`. Best-effort: callers
 * (`teamSend`, §17.4) treat a throw as non-fatal, but this function may surface
 * errors — its OWN internals are guarded so a missing dir can't throw (the
 * `mkdir` recursive runs first, a no-op when the dir already exists, the same
 * no-message-loss safeguard `enqueueOutbox` uses).
 *
 * A single-line `appendFile` is atomic on POSIX (O_APPEND), so concurrent
 * appends never interleave — NO LOCK is needed (§17.4; see the module doc). The
 * trailing newline keeps each record on its own line so a partial write
 * (vanishingly unlikely for a sub-`PIPE_BUF` line) is detected as an unparseable
 * trailing fragment by `readChannel` and skipped, never merged into another.
 */
export async function appendChannelMessage(teamName: string, record: ChannelMessage): Promise<void> {
  // Ensure `~/.itsybitsy/teams/` exists before appending. In production it is
  // created on the first append; `mkdir` recursive is a no-op once it exists.
  await mkdir(teamsDir(), { recursive: true });
  // Write `kind` VERBATIM if present, but DROP it when undefined so existing
  // chat records stay bit-identical on disk — we don't want a `kind: undefined`
  // (or worse, a hard-coded `kind: "chat"`) churning every historical channel
  // file just because the field was added.
  const payload: ChannelMessage =
    record.kind === undefined
      ? { ts: record.ts, fromAgent: record.fromAgent, message: record.message }
      : record;
  await appendFile(channelPath(teamName), JSON.stringify(payload) + "\n");
}

/**
 * Append a SYSTEM lifecycle record to a team's `<team>.channel.jsonl`. Used by
 * the team join / leave / create notice paths so the channel pane can render
 * lifecycle events inline with chat (rendered dimmed per §17.4 design update).
 *
 * The `fromAgent` is the ACTOR: `@system` for create / coalesced-nuke notices,
 * a real agent id for per-agent join / leave notices. `ts` is stamped to the
 * current epoch SECONDS internally so callers don't have to thread a clock.
 *
 * Best-effort like `appendChannelMessage` — the `mkdir` recursive runs first so
 * a missing dir can't throw, but callers should still `.catch(() => {})` so a
 * failed channel write never breaks the driving command (matches the
 * `appendTeamLog` discipline at every fire-point).
 */
export async function appendChannelSystemMessage(
  teamName: string,
  fromAgent: string,
  message: string,
): Promise<void> {
  await appendChannelMessage(teamName, {
    ts: Math.floor(Date.now() / 1000),
    fromAgent,
    message,
    kind: "system",
  });
}

/**
 * Read all persisted channel messages for a team, in append (FIFO) order.
 *
 * Mirrors `readOutbox` exactly:
 *   - A MISSING file → `[]` (no channel yet → empty chat box).
 *   - Splits on "\n"; blank lines are skipped.
 *   - Each line is parsed in its own try/catch so a malformed line (e.g. a torn
 *     final append) is SKIPPED rather than throwing — NEVER let one bad record
 *     wedge the channel.
 *   - Each record is reconstructed FIELD-BY-FIELD with a type guard per field
 *     (`ts: number`, `fromAgent: string`, `message: string`); a line missing or
 *     mistyping any required field is skipped. This is the §16.4 round-trip-drop
 *     trap guard — done explicitly, not via spread.
 */
export async function readChannel(teamName: string): Promise<ChannelMessage[]> {
  let content: string;
  try {
    content = await readFile(channelPath(teamName), "utf-8");
  } catch {
    return []; // missing file → empty channel
  }
  const out: ChannelMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.ts === "number" &&
        typeof obj.fromAgent === "string" &&
        typeof obj.message === "string"
      ) {
        // `kind` is optional: missing → undefined (treated as "chat" at render
        // time per the §17.4 back-compat contract); explicit "chat" / "system"
        // round-trip verbatim; any OTHER value skips the whole record, matching
        // the existing field-by-field guard discipline (a malformed field, not
        // a malformed line, is still bad data we won't trust).
        let kind: "chat" | "system" | undefined;
        if (obj.kind === undefined) {
          kind = undefined;
        } else if (obj.kind === "chat" || obj.kind === "system") {
          kind = obj.kind;
        } else {
          continue;
        }
        const record: ChannelMessage = {
          ts: obj.ts,
          fromAgent: obj.fromAgent,
          message: obj.message,
        };
        if (kind !== undefined) record.kind = kind;
        out.push(record);
      }
    } catch {
      /* skip malformed line — never let one bad record wedge the channel */
    }
  }
  return out;
}

/**
 * Append one timestamped, free-form line to a team's `<team>.log` audit log.
 * Line shape matches `agent.log` (`[YYYY-MM-DD HH:MM:SS] <text>`). Used by the
 * lifecycle notices (join/leave/create) on their existing emit paths (§17.4).
 * Best-effort: the `mkdir` recursive runs first so a missing dir can't throw.
 *
 * NOTE: this log is the AUDIT/DEBUG log and is NEVER shown in the chat box — the
 * chat box reads only `<team>.channel.jsonl` via `readChannel` (§17.4).
 */
export async function appendTeamLog(teamName: string, text: string): Promise<void> {
  await mkdir(teamsDir(), { recursive: true });
  await appendFile(teamLogPath(teamName), `[${formatTimestamp()}] ${text}\n`);
}

/**
 * Best-effort removal of BOTH a team's channel files (`<team>.channel.jsonl` and
 * `<team>.log`). Used by `teamDelete` (§17.4 cleanup default) so a deleted team
 * leaves no orphaned files and a later `ib team create` of the same name starts
 * with a clean channel rather than inheriting a stale predecessor's history.
 *
 * Ignore-if-missing: any error (including ENOENT) is swallowed per file, so a
 * cleanup failure never fails the driving `ib team delete`. This belongs in the
 * `teamDelete` COMMAND wrapper, not in the locked `deleteTeam` registry primitive
 * (§17.4) — the registry primitive only mutates `teams.json`.
 */
export async function deleteChannelFiles(teamName: string): Promise<void> {
  for (const p of [channelPath(teamName), teamLogPath(teamName)]) {
    try {
      await unlink(p);
    } catch {
      /* best-effort — ignore ENOENT and any other error */
    }
  }
}
