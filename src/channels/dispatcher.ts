/**
 * Telegram inbound dispatcher.
 *
 * Long-polls Telegram via {@link TelegramClient.getUpdates}, filters each
 * batch through the allowlist, wraps the surviving messages in a
 * channel-reminder block, and delivers them to the system coordinator via
 * `sendToSystemCoordinator(..., { fromAgent: "@telegram", raw: true })`.
 *
 * Key invariants:
 *   - Wrapped `<channel>` sends use raw mode (`raw: true`), so `sendMessage`
 *     does NOT prepend a `[sent by @telegram]:` line. The
 *     `<channel source="telegram" user="...">` opening tag already carries the
 *     sender attribution, so a prefix would be redundant double-attribution
 *     (and would push the `<channel>` tag out of column 1). Every wrapped send
 *     — normal batch delivery, the offline retry, the /context and /compact
 *     follow-up notes, and reaction notices — passes `raw: true` for this
 *     reason. (The slash-command passthrough at `/context` etc. also uses raw
 *     mode, but for a different reason: its body is the bare command, not a
 *     `<channel>` block, and must reach Claude Code verbatim.)
 *   - Startup probe (`probeOnce`) detects a 409 Conflict and returns without
 *     starting the loop. Any other probe outcome (network error, auth fail,
 *     2xx) lets the loop start; the loop's own retry handling absorbs further
 *     transient failures.
 *   - Allowlisted senders only. Drops are silent except for one log line per
 *     chat_id per hour (see `dropLogger`).
 *   - Updates from the same chat in one batch are coalesced into a single
 *     wrapped block with `count="N"` + `---` separators. Single-update
 *     batches skip the count/separator noise.
 *   - The wrapped block contains real `\n` characters; `sendMessage` passes
 *     them through `tmux send-keys -l` as-is. (Phase 3 was dropped after
 *     confirming the existing send dialog already handles multi-line buffers.)
 *   - Per-coordinator-session mutex (in-process Promise chain) serializes
 *     `sendToSystemCoordinator` calls so two batches arriving rapidly never
 *     interleave on the coordinator tmux pipe.
 *   - Attachments are DOWNLOADED: a message carrying a photo/document/voice/
 *     etc. is fetched via `getFile` + `downloadFile` into
 *     `~/.itsybitsy/channels/telegram/inbound/<chat>/<unix-ms>-<safeName>` and
 *     surfaced to the coordinator as a local path,
 *     e.g. `[user sent photo: /abs/path/file.jpg (123 KB)]`. A caption, if
 *     present, is surfaced alongside the path. Files over the Bot API's 20 MB
 *     `getFile` ceiling are NOT downloaded — the user gets a "file too big"
 *     Telegram reply and the coordinator sees a clear note instead of a path.
 *     A download failure (network, API) likewise surfaces a note, not a path.
 *     (Historically a bare attachment produced a "text only supported" reply
 *     and no download — that reply is gone now that real handling landed.)
 *   - Coordinator-offline: one retry after 2s; on failure the batch is
 *     dropped, the chat is marked "awaiting confirmation", and the user
 *     is prompted via Telegram: "The coordinator is offline. Start the
 *     coordinator? (y/n)". The next inbound from that chat is intercepted
 *     before any forwarding attempt: "y"/"yes" (case-insensitive, trimmed)
 *     calls `ensureSystemCoordinator()` and replies "online" or a failure
 *     message; "n"/"no" replies "leaving offline"; anything else (including
 *     any coalesced multi-message batch) re-prompts and keeps the chat in
 *     awaiting state. The y/n message itself is never forwarded.
 *   - `</channel>` substrings are stripped from inbound text/caption before
 *     wrapping (defense against forged closing tags).
 *   - Reaction notices carry a TEXT PREVIEW of the reacted-to message when we
 *     can resolve it, plus whose message it was — `Reacted 👍 to message 1584
 *     (your message): "..."`. Resolution goes through the in-memory
 *     `message-cache` (see that module for why it is memory-only), seeded by
 *     `deliver()` for inbound and by the outbox for outbound. A MISS IS
 *     NORMAL — after an `ib watch` restart the cache is empty — and must
 *     produce the id-only form: the reaction summary line and the `<channel>`
 *     block body are byte-identical to the pre-feature output. (The trailing
 *     reply hint is not, and shares the same returned string — it gained one
 *     sentence about the echoed id.) The restart-proof complement is
 *     `ib tgsend` echoing the sent `message_id` back to the coordinator,
 *     which puts the id in its own history.
 *   - Telegram slash-command passthrough: an inbound message whose trimmed
 *     body is exactly `/context`, `/clear`, or starts with `/compact`
 *     (optionally followed by arguments) is sent raw (no `<channel>`
 *     wrapper, no `[sent by ...]:` prefix) so the coordinator's Claude Code
 *     session recognizes it as a slash command. `/context` is followed by
 *     a wrapped channel-reminder note asking the coordinator to summarize
 *     context usage and reply via `ib tgsend`; `/compact` is followed by a
 *     wrapped note telling the coordinator to notify the user it's ready
 *     once compaction completes; `/clear` gets no coordinator follow-up
 *     (it's a context reset, not a user question) but the dispatcher
 *     replies on Telegram with "Coordinator context is cleared." so the
 *     user sees an acknowledgement. `/restart` and `/respawn` are also
 *     recognized but do NOT pass through to the coordinator's Claude Code
 *     input at all — sending the slash command as raw text proved
 *     unreliable (Claude often treated it as a normal user prompt rather
 *     than a slash command). Instead the dispatcher itself kills the
 *     coordinator tmux session, writes the cleared-marker so the new
 *     session is FRESH (not a resume), starts a new coordinator, waits
 *     for the ready marker, and replies on Telegram with an ack. On
 *     failure the user sees a "Coordinator restart failed/did not reach
 *     ready marker" reply — these commands never enter the offline-prompt
 *     y/n flow. `/usage` is NOT in this set — it opens an interactive
 *     menu the coordinator can't escape, so it flows through the normal
 *     wrapped path like any other message.
 *     When a batch contains both a slash command and other text from the
 *     same chat, the slash command fires first, then the remaining
 *     messages flow through the normal coalesced path. Slash commands are
 *     NOT recognized while a chat is in the offline-prompt y/n flow —
 *     there they count as "anything else" and re-prompt.
 *   - `stop()` aborts the in-flight long-poll via AbortController and waits
 *     for the loop to exit (caller wraps in a 2s timeout race).
 */

import { InjectionContext } from "../types";
import { TelegramClient, classifyError, TELEGRAM_GETFILE_LIMIT_BYTES } from "./telegram-client";
import type { PollOutcome } from "./telegram-client";
import type {
  TelegramMessage,
  TelegramUpdate,
  MessageReactionUpdated,
  ReactionType,
  PhotoSize,
  TelegramUser,
} from "./types";
import { clearCachedChatId } from "./chat-id-cache";
import { writeLastMessage } from "./last-message-cache";
import {
  lookupMessage,
  recordInboundMessage,
  truncateCodePoints,
  type CachedMessage,
  type MessageDirection,
} from "./message-cache";
import { storeInboundFile } from "./inbound-store";

/** Delivery hook the dispatcher calls per coalesced batch. Defaults to
 *  the real `sendToSystemCoordinator` from src/index.ts; tests inject a
 *  mock to capture call order without booting tmux. `opts.raw` bypasses the
 *  `[sent by @telegram]:` prefix. ALL wrapped `<channel>` sends pass
 *  `raw: true` so the prefix is never stacked on top of the
 *  `<channel source="telegram" user="...">` tag (which already carries the
 *  sender attribution — the prefix would be redundant double-attribution).
 *  Raw mode is also how slash commands like `/context` and `/clear` reach the
 *  coordinator verbatim, without a `<channel>` wrapper. */
export type SendToCoordinatorFn = (
  message: string,
  opts?: { fromAgent?: string; cwd?: string; raw?: boolean },
) => Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }>;

const defaultSendToCoordinator: SendToCoordinatorFn = async (msg, opts) => {
  const { sendToSystemCoordinator } = await import("../index");
  return sendToSystemCoordinator(msg, opts);
};

export const sendCtx = new InjectionContext<SendToCoordinatorFn>(defaultSendToCoordinator);

/** Injectable sleep — defaults to setTimeout. Tests fast-forward by injecting
 *  a near-instant resolver. */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sleepCtx = new InjectionContext<SleepFn>(defaultSleep);

/** Injectable clock — defaults to Date.now. Tests can stub to control the
 *  channel-reminder timestamp and the rate-limited drop logger. */
export type NowFn = () => number;
const defaultNow: NowFn = () => Date.now();
export const nowCtx = new InjectionContext<NowFn>(defaultNow);

/** Injectable logger — defaults to stderr. Tests capture invocations. */
export type LogFn = (line: string) => void;
const defaultLog: LogFn = (line) => process.stderr.write(line + "\n");
export const logCtx = new InjectionContext<LogFn>(defaultLog);

/** Injectable bootstrapper for the system coordinator — used when a user
 *  confirms 'y' to start the coordinator after an offline-prompt. Defaults to
 *  the real `ensureSystemCoordinator` from src/coordinator.ts; tests inject a
 *  stub. */
export type EnsureCoordinatorFn = () => Promise<string>;
const defaultEnsureCoordinator: EnsureCoordinatorFn = async () => {
  const { ensureSystemCoordinator } = await import("../coordinator");
  return ensureSystemCoordinator();
};
export const ensureCoordinatorCtx = new InjectionContext<EnsureCoordinatorFn>(defaultEnsureCoordinator);

/** Injectable restart-coordinator hook. Used by the /restart and /respawn
 *  slash commands to tear down the system coordinator and bring up a FRESH
 *  session (cleared marker written so the prior transcript is not resumed).
 *  Resolves to `true` once the new coordinator's Claude UI is ready, or
 *  `false` if the new session never reaches the ready marker. Defaults to a
 *  wrapper that calls `discardSystemCoordinator()` then
 *  `ensureSystemCoordinator()` then `waitForCoordinatorReady()`. Tests
 *  inject a stub. */
export type RestartCoordinatorFn = () => Promise<boolean>;
const defaultRestartCoordinator: RestartCoordinatorFn = async () => {
  const { discardSystemCoordinator, ensureSystemCoordinator, waitForCoordinatorReady } = await import("../coordinator");
  await discardSystemCoordinator();
  await ensureSystemCoordinator();
  return await waitForCoordinatorReady();
};
export const restartCoordinatorCtx = new InjectionContext<RestartCoordinatorFn>(defaultRestartCoordinator);

/** Coordinator-offline retry delay (ms). Plan: "retry once after 2s." */
const COORDINATOR_OFFLINE_RETRY_MS = 2_000;

/** Drop-log throttle: one line per chat_id per hour. */
const DROP_LOG_INTERVAL_MS = 60 * 60 * 1_000;

/** Fixed sentinel routed by sendMessage as "[sent by @telegram]:". */
export const TELEGRAM_SENTINEL = "@telegram";

/** Slash commands recognized on the trimmed body. `/context` and `/clear`
 *  are forwarded to the coordinator verbatim (no `<channel>` wrapper, no
 *  `[sent by ...]:` prefix) — they are Claude Code slash commands the
 *  coordinator session executes directly, and wrapping would break the
 *  recognizer. `/restart` and `/respawn` are recognized here too, but
 *  `dispatchSlashCommand` handles them differently: it tears down the
 *  coordinator session and brings up a FRESH one itself rather than
 *  forwarding the text to Claude (forwarding was unreliable — Claude
 *  often treated the slash as a normal prompt). `/context extra` is NOT
 *  a slash command (exact-match rule). `/usage` is intentionally NOT in
 *  this set — it opens an interactive menu the coordinator can't escape,
 *  so it flows through the normal wrapped path. `/compact` (the other
 *  recognized command) is matched separately via the prefix list below
 *  so users can pass optional compaction instructions (e.g.
 *  `/compact focus on the API work`). */
const TELEGRAM_SLASH_EXACT_COMMANDS = new Set(["/context", "/clear", "/restart", "/respawn"]);
const TELEGRAM_SLASH_PREFIX_COMMANDS = ["/compact"] as const;

/** Returns the canonical command name (e.g. `/compact`) if the trimmed body
 *  matches one of the passthrough slash commands, else null. Exact matches
 *  must equal the command verbatim; prefix matches may be followed by
 *  whitespace and arbitrary arguments. */
function matchSlashCommand(trimmed: string): string | null {
  if (TELEGRAM_SLASH_EXACT_COMMANDS.has(trimmed)) return trimmed;
  for (const cmd of TELEGRAM_SLASH_PREFIX_COMMANDS) {
    if (trimmed === cmd) return cmd;
    if (trimmed.startsWith(cmd + " ") || trimmed.startsWith(cmd + "\t")) return cmd;
  }
  return null;
}

/** Channel-reminder note appended after a raw `/context` send so the
 *  coordinator summarizes context usage back to Telegram. `/clear` gets no
 *  coordinator follow-up — it's a context reset, not a user question — but
 *  the dispatcher does send a "Coordinator context is cleared." reply on
 *  Telegram directly so the user sees the clear was acknowledged. */
const CONTEXT_FOLLOWUP_BODY =
  "[user on telegram requested /context — please summarize context usage and reply via `ib tgsend`]";

/** Channel-reminder note appended after a raw `/compact` send so the
 *  coordinator surfaces its post-compaction status back to the user. Fires
 *  after the `/compact` command lands in the coordinator's input — Claude
 *  Code processes the compact synchronously, so by the time it reads this
 *  note the conversation has already been compacted. */
const COMPACT_FOLLOWUP_BODY =
  "[your conversation just compacted — notify the user via `ib tgsend` with a brief status summary and that you're ready to continue]";

/** Tag on the per-coordinator mutex. Phase 5 only ever has one (the system
 *  coordinator) but the structure allows future per-repo coordinators to
 *  serialize independently. */
const SYSTEM_COORDINATOR_MUTEX_KEY = "system";

/** Health state of the long-poll loop. Drives the dashboard's traffic-light
 *  indicator. The dispatcher transitions through these in response to poll
 *  outcomes:
 *    polling  → last poll succeeded → green
 *    retrying → loop is alive but backing off after a failure → yellow
 *    down     → loop is not running (probe-409, never started, or stopped) → red
 */
export type DispatcherHealthState = "polling" | "retrying" | "down";

export interface DispatcherHealth {
  state: DispatcherHealthState;
  lastSuccessAt: number | null;
  reason: string | null;
}

export interface DispatcherStateChange {
  from: DispatcherHealthState;
  to: DispatcherHealthState;
  reason: string | null;
}

export type DispatcherStateChangeFn = (change: DispatcherStateChange) => void;

export interface DispatcherOptions {
  client: TelegramClient;
  /** Allowed chat IDs as strings. Empty = deny-all-chat (user IDs may still
   *  permit). Same convention as src/channels/access.ts. */
  allowedChatIds: string[];
  /** Allowed user IDs as strings. Empty = deny-all-user (chat IDs may still
   *  permit). */
  allowedUserIds: string[];
  /** chat_id used for outbound replies (attachment notice, coordinator-offline
   *  notice). Required because Telegram chats are not addressable by anything
   *  else; the dispatcher does not invent reply targets. */
  chatId: string;
  /** Optional offset hint for the first `getUpdates` call. The Phase A
   *  three-step boot resolves the chat id by walking a probe response; it
   *  passes `max(consumed update_id) + 1` here so the dispatcher's first
   *  long-poll skips updates the boot already saw. Telegram drops everything
   *  with `update_id < offset`. */
  initialOffset?: number;
}

/** A downloadable attachment extracted from a TelegramMessage. The dispatcher
 *  uses this to call `getFile` + `downloadFile` and surface a local path to the
 *  coordinator. `displayName` is a sanitized, human-readable hint for the
 *  on-disk filename (NEVER trusted for the actual path — `storeInboundFile`
 *  generates the path) and the surfaced `[user sent ...]` note. `fileSize` is
 *  the advertised size (may be undefined; some PhotoSize entries omit it) used
 *  for the 20 MB guard BEFORE downloading where available. */
export interface AttachmentDescriptor {
  kind: string;
  fileId: string;
  fileSize?: number;
  displayName: string;
}

/** What we extract from one TelegramMessage for the channel-reminder body. */
export interface NormalizedMessage {
  chatId: string;
  /** Per-chat message identifier. Retained so the agent can target this exact
   *  message with a reaction (`ib tgreact --message-id <id>`), and so the
   *  dispatcher can persist the latest inbound id for `ib tgreact`'s default
   *  "react to the most recent message" path. */
  messageId: number;
  userId: string | null;
  username: string;
  ts: string;
  body: string;
  /** The kind of attachment this message carried (photo/document/voice/etc.),
   *  or null for a plain text message. Set for BOTH captioned and bare
   *  attachments — the dispatcher downloads either way. (Historically this was
   *  only set for bare attachments to drive a "text only supported" reply;
   *  that reply is gone now that we download.) */
  attachmentType: string | null;
  /** Present when the message carried a downloadable attachment. `resolveAttachment`
   *  consumes this to fetch the file and rewrite `body` with the local path (or
   *  a too-big / failed note). Undefined for plain text. */
  attachment?: AttachmentDescriptor;
  /** The user's caption, if any, surfaced alongside the downloaded file path.
   *  Kept separate from `body` because `body` is provisional until the download
   *  resolves. Undefined when there was no caption. */
  caption?: string;
  /** Present ONLY when this message explicitly replied to another one
   *  (Telegram's swipe-reply). Undefined for ordinary typed messages — which is
   *  precisely what keeps an ordinary block byte-identical to its pre-feature
   *  output, since every reply-related rendering hangs off this field being
   *  set. Built by {@link extractReplyContext}. */
  replyTo?: ReplyContext;
}

/** What we surface about the message a reply targeted.
 *
 *  Resolved once at normalize time and rendered later, so `wrapChannelReminder`
 *  stays a pure formatter (same split as {@link ReactionPreview} /
 *  `resolveReactionPreview` on the reaction side).
 *
 *  `text` is `""` when nothing was resolvable — the id-only form, and the same
 *  graceful degradation rule reactions follow: never throw, never render empty
 *  quotes, never break delivery. `direction` is null when we genuinely cannot
 *  tell whose message it was; the whose-message clause is then OMITTED rather
 *  than guessed, because "(your message)" on the user's own message actively
 *  misleads the coordinator, which is worse than saying nothing. */
export interface ReplyContext {
  /** The replied-to message's id, or 0 when Telegram gave no usable one.
   *  Rendered through `messageIdAttr`, so 0 means no `in_reply_to` attribute. */
  messageId: number;
  /** Preview of the replied-to text, already single-lined, truncated and
   *  `stripChannelClose`-d by {@link formatMessagePreview}. `""` = unresolvable. */
  text: string;
  direction: MessageDirection | null;
}

/** What we extract from one `message_reaction` update for delivery to the
 *  coordinator. The reaction is summarized as added/removed emoji so the
 *  coordinator sees a human-readable event rather than raw reaction arrays. */
export interface NormalizedReaction {
  chatId: string;
  /** The message the reaction was applied to. */
  messageId: number;
  userId: string | null;
  username: string;
  ts: string;
  /** Emoji added in this update (present in new_reaction but not old). */
  added: string[];
  /** Emoji removed in this update (present in old_reaction but not new). */
  removed: string[];
}

/** TelegramDispatcher — owns the long-poll loop. Construction does not start
 *  any work; call `start()` and `stop()` to control the lifecycle. */
export class TelegramDispatcher {
  private readonly client: TelegramClient;
  private readonly allowedChatIds: Set<string>;
  private readonly allowedUserIds: Set<string>;
  private readonly chatId: string;

  /** Per-coordinator-session mutex. Each entry is a Promise chain — to
   *  acquire, append your work to the chain; subsequent acquirers append
   *  after you. */
  private readonly mutexChain: Map<string, Promise<void>> = new Map();

  /** Last drop-log timestamp per chat_id. Throttles the
   *  "non-allowlisted sender" log line to one per hour per chat. */
  private readonly lastDropLog: Map<string, number> = new Map();

  /** Chat IDs currently awaiting a y/n confirmation to start the system
   *  coordinator. Set when the coordinator-offline retry path fires the
   *  prompt; cleared on y/n response or when the user chooses 'n'. */
  private readonly awaitingCoordinatorStart: Set<string> = new Set();

  /** Offset to pass to the next `getUpdates` call. Telegram drops everything
   *  with `update_id < offset`. */
  private nextOffset: number | undefined = undefined;

  /** AbortController fed into `getUpdates`. Created in `start()`, fired by
   *  `stop()`. */
  private abortController: AbortController | null = null;

  /** Promise that resolves when the main loop exits. `stop()` awaits this. */
  private loopDone: Promise<void> | null = null;

  /** Set to true by `start()` once the probe succeeds and the main loop is
   *  running. Set to false by `stop()`. */
  private running = false;

  /** Health state machine — see `DispatcherHealthState`. Initialized to
   *  `down` since the loop has not started. `start()` transitions to
   *  `polling`, the loop transitions between `polling` and `retrying`
   *  per outcome, and `stop()` transitions back to `down`. */
  private healthState: DispatcherHealthState = "down";
  private lastSuccessAt: number | null = null;
  private lastFailureReason: string | null = null;
  /** Wall-clock at the moment we left "polling" — used to compute the
   *  "reconnected after Ns" message when a streak ends. */
  private disconnectedAt: number | null = null;
  private readonly stateChangeListeners: Set<DispatcherStateChangeFn> = new Set();

  constructor(opts: DispatcherOptions) {
    this.client = opts.client;
    this.allowedChatIds = new Set(opts.allowedChatIds.map(String));
    this.allowedUserIds = new Set(opts.allowedUserIds.map(String));
    this.chatId = String(opts.chatId);
    if (opts.initialOffset !== undefined) {
      this.nextOffset = opts.initialOffset;
    }
  }

  /** Returns true when the main loop is running. False after `stop()` returns,
   *  or if the startup probe detected a 409 and never started the loop. */
  isRunning(): boolean {
    return this.running;
  }

  /** Snapshot of the current health state — safe to call from any thread,
   *  including the dashboard's status-poll timer. */
  getHealth(): DispatcherHealth {
    return {
      state: this.healthState,
      lastSuccessAt: this.lastSuccessAt,
      reason: this.lastFailureReason,
    };
  }

  /** Subscribe to edge-only state transitions. The callback fires once when
   *  the state changes (e.g. `polling → retrying`); it does NOT fire on every
   *  poll outcome. Returns an unsubscribe function. */
  onStateChange(callback: DispatcherStateChangeFn): () => void {
    this.stateChangeListeners.add(callback);
    return () => {
      this.stateChangeListeners.delete(callback);
    };
  }

  /** Update the health state. Fires listeners (and writes the dispatcher's
   *  own log line) only when the state actually changes — repeated outcomes
   *  in the same state are silent so a streak of 5 ETIMEDOUTs produces one
   *  transition log, not five. */
  private transitionHealth(to: DispatcherHealthState, reason: string | null): void {
    const from = this.healthState;
    if (from === to) {
      // Same state — no transition. Update reason for `getHealth()` callers
      // but don't fire listeners or log.
      if (reason !== null) this.lastFailureReason = reason;
      return;
    }
    this.healthState = to;
    if (reason !== null) this.lastFailureReason = reason;
    if (to === "retrying" && from === "polling") {
      // Edge into retrying: capture the moment so a later success can compute
      // "reconnected after Ns".
      this.disconnectedAt = nowCtx.fn();
    }
    const change: DispatcherStateChange = { from, to, reason };
    for (const listener of this.stateChangeListeners) {
      try {
        listener(change);
      } catch (err) {
        logCtx.fn(`Telegram dispatcher: state-change listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Apply a single poll outcome to the health state machine. Called by the
   *  long-poll loop via the `onPollOutcome` hook on `getUpdates`. */
  private handlePollOutcome(outcome: PollOutcome): void {
    if (outcome === "success") {
      this.lastSuccessAt = nowCtx.fn();
      if (this.healthState !== "polling") {
        let reason: string | null = null;
        if (this.disconnectedAt !== null) {
          const seconds = Math.max(1, Math.round((nowCtx.fn() - this.disconnectedAt) / 1000));
          reason = `reconnected after ${seconds}s`;
        }
        this.transitionHealth("polling", reason);
        this.disconnectedAt = null;
        // Clear the failure reason once we've surfaced the recovery
        // transition — health snapshots after a recovery should reflect
        // the green state, not the prior red.
        this.lastFailureReason = null;
      }
      return;
    }
    // retry-path entry
    if (this.healthState === "polling") {
      this.transitionHealth("retrying", outcome.reason);
    } else {
      // Stay in retrying — no transition, but update the reason so the
      // dashboard's snapshot reflects the most recent failure class.
      this.lastFailureReason = outcome.reason;
    }
  }

  /**
   * Run the startup probe and, if it succeeds (or fails with anything other
   * than 409), start the main long-poll loop. Returns immediately after the
   * probe — the loop runs in the background.
   *
   * On 409: logs "Telegram routing disabled: another poller or webhook is
   * active" and returns without starting the loop. The rest of the TUI is
   * unaffected.
   *
   * On any other probe outcome: logs the failure (if not 2xx) and starts
   * the loop anyway — the loop's own retry handling absorbs further
   * transient failures.
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (this.loopDone) {
      // Stop was called but the loop hasn't fully exited yet. Wait for it
      // before starting a new one to avoid two loops fighting for the same
      // bot token.
      await this.loopDone;
    }

    let probe: Awaited<ReturnType<TelegramClient["probeOnce"]>>;
    try {
      probe = await this.client.probeOnce({ offset: -1, limit: 1, timeout: 0 });
    } catch (err) {
      // Network failure on the probe — let the loop start; it retries.
      // Use classifyError to surface a bounded, stable label rather than the
      // raw message, which could embed URL fragments containing the bot token
      // if fetch ever leaks them into the exception text.
      logCtx.fn(
        `Telegram startup probe failed (network): ${classifyError(err)}; starting main loop anyway`,
      );
      probe = { ok: true, updates: [] };
    }

    if (!probe.ok && probe.status === 409) {
      logCtx.fn("Telegram routing disabled: another poller or webhook is active");
      this.running = false;
      // No transition log — boot already logged via the line above.
      this.transitionHealth("down", "409 Conflict");
      return;
    }

    if (!probe.ok) {
      const desc = "description" in probe && probe.description ? `: ${probe.description}` : "";
      logCtx.fn(`Telegram startup probe got HTTP ${probe.status}${desc}; starting main loop anyway`);
      // Auth failure (401/403) means the cached chat id is stale relative to
      // whatever credentials the user has now (token rotated, bot disabled,
      // etc). Clear the cache so the next boot re-resolves via inbound walk.
      // `clearCachedChatId` is best-effort by contract — it swallows ENOENT
      // and any other error internally, so no wrapper is needed here.
      if (probe.status === 401 || probe.status === 403) {
        await clearCachedChatId();
      }
    } else if (probe.updates.length > 0 && this.nextOffset === undefined) {
      // Seed the offset so we don't re-process anything the probe already
      // surfaced. probe.updates is at most 1 (limit:1). When the caller
      // already supplied an `initialOffset` via constructor (Phase A boot),
      // we leave it alone — that hint is authoritative.
      const max = probe.updates.reduce((m, u) => (u.update_id > m ? u.update_id : m), -1);
      this.nextOffset = max + 1;
    }

    this.abortController = new AbortController();
    this.running = true;
    // Optimistically transition to polling on loop launch — the first
    // successful getUpdates will keep us here, a failure will flip us to
    // retrying. Boot already logged "connected" so we suppress a duplicate
    // here by passing reason=null.
    this.transitionHealth("polling", null);
    this.loopDone = this.runLoop(this.abortController.signal).catch((err) => {
      // Use classifyError instead of err.message — fetch errors can embed
      // URL fragments containing the bot token. classifyError surfaces a
      // bounded, stable label.
      logCtx.fn(`Telegram dispatcher loop exited: ${classifyError(err)}`);
    });
  }

  /**
   * Abort the in-flight long-poll and wait for the loop to exit.
   *
   * The caller is responsible for any timeout race — this method itself
   * waits unconditionally, since `getUpdates` is abort-aware and unwinds
   * within ~1s.
   */
  async stop(): Promise<void> {
    if (!this.running && !this.loopDone) return;
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.loopDone) {
      try {
        await this.loopDone;
      } catch {
        /* swallow — loop errors are logged inline */
      }
      this.loopDone = null;
    }
    this.abortController = null;
    // Stopping is normal shutdown — transition silently to `down`. The
    // dashboard will see the state flip via getHealth(); listeners get one
    // notification; no log line (per spec — shutdown is normal).
    this.transitionHealth("down", null);
  }

  /** The actual long-poll loop. Exits when the abort signal fires. */
  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.client.getUpdates({
          offset: this.nextOffset,
          allowed_updates: ["message", "message_reaction"],
          signal,
          onPollOutcome: (outcome) => this.handlePollOutcome(outcome),
        });
      } catch (err) {
        // getUpdates only throws on abort. Any other transient failure is
        // absorbed by the client's own retry loop.
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        // Use classifyError — err.message could embed the bot-token URL.
        logCtx.fn(
          `Telegram dispatcher: unexpected getUpdates throw: ${classifyError(err)}; continuing`,
        );
        continue;
      }

      if (updates.length === 0) continue;

      // Advance offset BEFORE processing — if a `processBatch` call throws
      // we still want the next loop iteration to skip the failed batch
      // rather than re-deliver it forever.
      const maxId = updates.reduce((m, u) => (u.update_id > m ? u.update_id : m), -1);
      if (maxId >= 0) this.nextOffset = maxId + 1;

      try {
        await this.processBatch(updates);
      } catch (err) {
        // Should never happen (processBatch swallows internally) — but if
        // it does, log and keep polling so one bad batch doesn't kill the
        // dispatcher.
        logCtx.fn(
          `Telegram dispatcher: processBatch threw: ${err instanceof Error ? err.message : String(err)}; continuing`,
        );
      }
    }
  }

  /**
   * Process one batch of updates: filter by allowlist, group by chat,
   * coalesce per-chat into one wrapped block, deliver via the
   * per-coordinator mutex.
   *
   * Each per-message step is wrapped in try/catch so a single malformed
   * update does not break the rest of the batch.
   */
  private async processBatch(updates: TelegramUpdate[]): Promise<void> {
    /** Group surviving messages by chat_id. Map ordering is insertion-order
     *  in JS, so we deliver chats in the order their first allowed message
     *  appeared — preserving roughly the user's submission order. */
    const byChat = new Map<string, NormalizedMessage[]>();

    /** Reaction events surviving the allowlist, in arrival order. Delivered
     *  after the message batches so that a message + its reaction arriving in
     *  the same poll deliver message-then-reaction. */
    const reactions: NormalizedReaction[] = [];

    for (const update of updates) {
      // message_reaction updates carry no `message` field — handle them on
      // their own path, then continue. A single update has at most one of
      // `message` / `message_reaction`.
      let reactionUpdate: MessageReactionUpdated | undefined;
      try {
        reactionUpdate = update.message_reaction;
      } catch {
        reactionUpdate = undefined;
      }
      if (reactionUpdate) {
        const normalizedReaction = this.normalizeReaction(reactionUpdate);
        if (normalizedReaction) reactions.push(normalizedReaction);
        continue;
      }

      let msg: TelegramMessage | undefined;
      try {
        msg = update.message;
      } catch (err) {
        logCtx.fn(`Telegram dispatcher: malformed update: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!msg) continue;

      let chatId: string;
      let userId: string | undefined;
      try {
        chatId = String(msg.chat?.id ?? "");
        userId = msg.from?.id !== undefined ? String(msg.from.id) : undefined;
      } catch {
        continue;
      }
      if (!chatId) continue;

      // Allowlist filter (silent drop, rate-limited log).
      if (!this.isAllowed(chatId, userId)) {
        this.logDrop(chatId, userId);
        continue;
      }

      const normalized = this.normalize(msg);
      if (!normalized) continue;
      // Download any attachment NOW (before grouping/wrapping) so the wrapped
      // body carries the resolved local path instead of the provisional
      // placeholder. resolveAttachment never throws — a failure leaves a clear
      // note in the body. Plain-text messages skip this (no `attachment`).
      if (normalized.attachment) {
        await this.resolveAttachment(normalized);
      }
      const existing = byChat.get(normalized.chatId);
      if (existing) {
        existing.push(normalized);
      } else {
        byChat.set(normalized.chatId, [normalized]);
      }
    }

    // Deliver each chat's batch through the mutex. We run them
    // sequentially via the same mutex chain so two chats' messages never
    // interleave on the coordinator pipe.
    //
    // For chats not in awaiting-confirmation state, we split each chat's
    // messages into slash commands (sent raw, one per command, optionally
    // followed by a wrapped reminder) and non-slash messages (coalesced
    // into a single wrapped block via `deliver()`). Slash commands fire
    // first so the coordinator sees `/context` or `/clear` ahead of any
    // accompanying chatter. If the awaiting branch fires, slash commands
    // are NOT routed as commands — the y/n flow treats them as "anything
    // else" and re-prompts.
    for (const [chatId, messages] of byChat.entries()) {
      // Mutex acquisition inside this for-await loop is redundant with the
      // sequential iteration — the loop already serializes per-chat batches
      // within a single getUpdates result. Kept as defense-in-depth: a
      // future refactor that parallelizes batches across chats (e.g. via
      // Promise.all) must still serialize keystrokes to a single coordinator
      // tmux session, and the mutex is the contract that enforces it.
      const isAwaiting = this.awaitingCoordinatorStart.has(chatId);
      if (isAwaiting) {
        await this.withMutex(SYSTEM_COORDINATOR_MUTEX_KEY, async () => {
          await this.handleAwaitingConfirmation(chatId, messages);
        });
        continue;
      }

      const { slashes, normals } = splitSlashCommands(messages);

      // Slash commands first, each as its own raw send. If a raw send falls
      // into the coordinator-offline prompt path, subsequent slash commands
      // for this chat are skipped (the awaiting flag is set; the next
      // iteration's `isAwaiting` check would catch them anyway, but the
      // explicit guard inside the loop avoids spamming offline prompts).
      for (const slash of slashes) {
        if (this.awaitingCoordinatorStart.has(chatId)) break;
        await this.withMutex(SYSTEM_COORDINATOR_MUTEX_KEY, async () => {
          await this.dispatchSlashCommand(chatId, slash);
        });
      }

      // Then the remaining non-slash messages as a coalesced wrapped block.
      // If the slash-command path put the chat into awaiting state, skip the
      // normal deliver — the user is now in a y/n flow.
      if (normals.length > 0 && !this.awaitingCoordinatorStart.has(chatId)) {
        await this.withMutex(SYSTEM_COORDINATOR_MUTEX_KEY, async () => {
          await this.deliver(chatId, normals);
        });
      }
    }

    // Deliver reaction events last, each through the same coordinator mutex.
    // Reactions are NOT coalesced with text — they're a distinct event class —
    // and they do not enter the offline-prompt y/n flow: a reaction is never a
    // "y"/"n" answer. If the coordinator is offline we drop the reaction
    // notice silently (it's informational; re-prompting the user about a
    // reaction would be noise).
    for (const reaction of reactions) {
      await this.withMutex(SYSTEM_COORDINATOR_MUTEX_KEY, async () => {
        await this.deliverReaction(reaction);
      });
    }
  }

  /** Send one slash-command message to the coordinator.
   *
   *  Two branches:
   *
   *  1. `/restart` and `/respawn` are handled directly by the dispatcher —
   *     they do NOT pass through to the coordinator's Claude Code input
   *     (sending those as raw text was unreliable because Claude often
   *     interpreted the text as a normal user prompt rather than as a slash
   *     command). Instead the dispatcher tears down the coordinator session
   *     via `restartCoordinatorCtx.fn()` (which clears the resume marker so
   *     the new session is fresh, not resumed), waits for the new session
   *     to reach the ready marker, and replies on Telegram with an ack.
   *     These commands do not enter the offline-prompt y/n flow on failure;
   *     a thrown error or a not-ready outcome just produces a Telegram
   *     reply and returns.
   *
   *  2. All other slash commands (`/context`, `/clear`, `/compact`) are sent
   *     raw to the coordinator (no `<channel>` wrapper, no
   *     `[sent by ...]:` prefix). On success a per-command follow-up note
   *     (wrapped channel-reminder) may fire so the coordinator knows to
   *     reply via `ib tgsend`. On send failure the same one-retry-after-2s
   *     + offline-prompt logic as `deliver()` applies. The follow-up is
   *     suppressed when the raw send fails — there's no point telling the
   *     coordinator to reply on Telegram when the coordinator isn't even
   *     up. */
  private async dispatchSlashCommand(
    chatId: string,
    message: NormalizedMessage,
  ): Promise<void> {
    const trimmed = message.body.trim();
    const canonical = matchSlashCommand(trimmed);
    // Defensive — caller already filtered via splitSlashCommands, so this
    // should never be null here. If it is, fall back to the raw trimmed
    // body for command identification.
    const commandName = canonical ?? trimmed;

    // /restart and /respawn: tear down the coordinator and bring up a
    // FRESH session ourselves; never forward the slash command text to the
    // coordinator (Claude treats it as a normal prompt too often). Acks
    // fire on Telegram only after the new session is ready.
    if (commandName === "/restart" || commandName === "/respawn") {
      try {
        const ready = await restartCoordinatorCtx.fn();
        if (ready) {
          await this.replyOnTelegram("Coordinator restarted with a fresh session.");
        } else {
          await this.replyOnTelegram(
            "Coordinator restart did not reach ready marker — check ib watch.",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logCtx.fn(`Telegram dispatcher: ${commandName} failed: ${msg}`);
        await this.replyOnTelegram(`Coordinator restart failed: ${msg}`);
      }
      return;
    }

    const sendResult = await sendCtx.fn(trimmed, { fromAgent: TELEGRAM_SENTINEL, raw: true });
    let delivered = sendResult.ok;
    if (!sendResult.ok) {
      await sleepCtx.fn(COORDINATOR_OFFLINE_RETRY_MS);
      const retry = await sendCtx.fn(trimmed, { fromAgent: TELEGRAM_SENTINEL, raw: true });
      delivered = retry.ok;
      if (!delivered) {
        this.awaitingCoordinatorStart.add(chatId);
        await this.replyOnTelegram(
          "The coordinator is offline. Start the coordinator? (y/n)",
        );
        return;
      }
    }

    // Per-command follow-up:
    //   /context → ask coordinator to summarize context usage
    //   /compact → ask coordinator to surface post-compaction status
    //   /clear   → no coordinator follow-up (context reset, not a user
    //              question), but reply to the user on Telegram confirming
    //              the clear landed. The reply is fire-and-forget via
    //              `replyOnTelegram` — errors are logged, never thrown.
    let followupBody: string | null = null;
    if (commandName === "/context") {
      followupBody = CONTEXT_FOLLOWUP_BODY;
    } else if (commandName === "/compact") {
      followupBody = COMPACT_FOLLOWUP_BODY;
    } else if (commandName === "/clear") {
      await this.replyOnTelegram("Coordinator context is cleared.");
    }

    if (followupBody !== null) {
      const note: NormalizedMessage = {
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.userId,
        username: message.username,
        ts: message.ts,
        body: followupBody,
        attachmentType: null,
      };
      const wrapped = wrapChannelReminder(chatId, [note]);
      // No retry on the follow-up: the raw command already landed, so a
      // transient failure here just means the coordinator missed a hint —
      // it does NOT block the user. Log and move on.
      try {
        const followup = await sendCtx.fn(wrapped, { fromAgent: TELEGRAM_SENTINEL, raw: true });
        if (!followup.ok) {
          logCtx.fn(
            `Telegram dispatcher: ${commandName} follow-up failed: ${followup.stderr || "send returned ok=false"}`,
          );
        }
      } catch (err) {
        logCtx.fn(
          `Telegram dispatcher: ${commandName} follow-up threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Wrap and deliver one chat's worth of coalesced messages, plus any
   *  attachment-fallback Telegram reply. */
  private async deliver(chatId: string, messages: NormalizedMessage[]): Promise<void> {
    if (messages.length === 0) return;

    // If this chat is awaiting a y/n confirmation to start the coordinator,
    // intercept the batch before any send attempt — a 'y' reply must not be
    // forwarded as a normal message.
    if (this.awaitingCoordinatorStart.has(chatId)) {
      await this.handleAwaitingConfirmation(chatId, messages);
      return;
    }

    const wrapped = wrapChannelReminder(chatId, messages);
    const sendResult = await sendCtx.fn(wrapped, { fromAgent: TELEGRAM_SENTINEL, raw: true });

    let delivered = sendResult.ok;
    if (!sendResult.ok) {
      // Coordinator-offline retry: wait 2s and try once more.
      await sleepCtx.fn(COORDINATOR_OFFLINE_RETRY_MS);
      const retry = await sendCtx.fn(wrapped, { fromAgent: TELEGRAM_SENTINEL, raw: true });
      delivered = retry.ok;
      if (!delivered) {
        this.awaitingCoordinatorStart.add(chatId);
        await this.replyOnTelegram(
          "The coordinator is offline. Start the coordinator? (y/n)",
        );
        // Original message is dropped — do not buffer it.
        return;
      }
    }

    // Persist the latest inbound message id so `ib tgreact` (a separate
    // process with no in-memory dispatcher state) can default to reacting to
    // the most recent message. Best-effort: a cache write failure must not
    // affect delivery. Only the most recent message in the batch matters —
    // `messages` is in arrival order, so the last element is newest.
    if (delivered) {
      const newest = messages[messages.length - 1]!;
      if (newest.messageId > 0) {
        try {
          await writeLastMessage(chatId, newest.messageId);
        } catch (err) {
          logCtx.fn(
            `Telegram dispatcher: last-message cache write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Also seed the in-memory message cache so a later reaction to any of
      // these messages can carry a text preview. EVERY message in the batch is
      // recorded, not just the newest: a coalesced batch delivers several
      // messages and the user can react to any one of them. Best-effort, same
      // treatment as the last-message write above — a cache failure must never
      // affect delivery. (Distinct from the last-message cache in every way
      // that matters: that one persists a single id to disk for `ib tgreact`;
      // this one holds recent TEXT in memory only, and dies with the process.)
      for (const m of messages) {
        if (m.messageId <= 0) continue;
        try {
          recordInboundMessage(chatId, m.messageId, m.body);
        } catch (err) {
          logCtx.fn(
            `Telegram dispatcher: message cache write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // No attachment-fallback reply here anymore: attachments are downloaded in
    // `processBatch` (via `resolveAttachment`), which already rewrote the body
    // with the local path and sent any too-big / failed Telegram reply itself.
    // The old "Received attachment — text only supported" notice is gone now
    // that real handling landed.
  }

  /** Handle a batch arriving on a chat that's in awaiting-confirmation state.
   *  A single-message batch is checked for y/yes/n/no (case-insensitive,
   *  trimmed); a coalesced multi-message batch is always treated as
   *  "anything else" and re-prompts. */
  private async handleAwaitingConfirmation(
    chatId: string,
    messages: NormalizedMessage[],
  ): Promise<void> {
    const single = messages.length === 1 ? messages[0]! : null;
    const answer = single ? single.body.trim().toLowerCase() : null;

    if (answer === "y" || answer === "yes") {
      this.awaitingCoordinatorStart.delete(chatId);
      try {
        await ensureCoordinatorCtx.fn();
        await this.replyOnTelegram("The coordinator is now online.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.replyOnTelegram(`Failed to start coordinator: ${msg}`);
      }
      return;
    }

    if (answer === "n" || answer === "no") {
      this.awaitingCoordinatorStart.delete(chatId);
      await this.replyOnTelegram("Okay, leaving the coordinator offline.");
      return;
    }

    // Anything else (including coalesced multi-message batches): drop and
    // re-prompt; keep chat in awaiting state.
    this.awaitingCoordinatorStart.add(chatId);
    await this.replyOnTelegram(
      "The coordinator is offline. Start the coordinator? (y/n)",
    );
  }

  /** Append work to the named mutex chain and await it. The chain stays alive
   *  across calls so subsequent acquirers serialize behind us. The map's key
   *  cardinality is bounded (one key per coordinator session, currently just
   *  the system coordinator), so the map never grows unboundedly. */
  private async withMutex<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.mutexChain.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.mutexChain.set(key, chained);
    try {
      await prev;
      return await work();
    } finally {
      release();
    }
  }

  /** Reply to the configured chat. Errors are logged, never thrown. */
  private async replyOnTelegram(text: string): Promise<void> {
    try {
      await this.client.sendMessage({ chat_id: this.chatId, text });
    } catch (err) {
      logCtx.fn(
        `Telegram dispatcher: replyOnTelegram failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private isAllowed(chatId: string, userId: string | undefined): boolean {
    if (this.allowedChatIds.has(chatId)) return true;
    if (userId !== undefined && this.allowedUserIds.has(userId)) return true;
    return false;
  }

  /** Throttled debug log for non-allowlisted senders. One line per chat per
   *  hour so the user can spot unwanted traffic without the log filling up. */
  private logDrop(chatId: string, userId: string | undefined): void {
    const now = nowCtx.fn();
    const last = this.lastDropLog.get(chatId) ?? 0;
    if (now - last < DROP_LOG_INTERVAL_MS) return;
    this.lastDropLog.set(chatId, now);
    const userPart = userId !== undefined ? ` user_id=${userId}` : "";
    logCtx.fn(`Telegram dispatcher: dropped non-allowlisted sender chat_id=${chatId}${userPart}`);
  }

  /** Extract the channel-reminder body fields from a TelegramMessage.
   *  Returns null on malformed input (no chat_id).
   *
   *  Attachments are NOT downloaded here — `normalize()` stays synchronous.
   *  When the message carries a downloadable attachment we record an
   *  {@link AttachmentDescriptor} on the result and set a PROVISIONAL body
   *  (`[user sent <kind>]`); the async `resolveAttachment()` step (run by
   *  `processBatch`) downloads the file and rewrites the body with the local
   *  path (or a too-big / failed note). A caption, if present, is stored
   *  separately on `caption` so it survives that rewrite. */
  private normalize(msg: TelegramMessage): NormalizedMessage | null {
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return null;
    const messageId = typeof msg.message_id === "number" ? msg.message_id : 0;
    const userId = msg.from?.id !== undefined ? String(msg.from.id) : null;
    const username = msg.from?.username ?? msg.from?.first_name ?? "unknown";
    const tsEpoch = msg.date !== undefined ? msg.date * 1000 : nowCtx.fn();
    const ts = new Date(tsEpoch).toISOString();

    // Defensive: text or caption, whichever is present. Strip </channel> so
    // a user can't forge an early closing tag in the wrapped block.
    const rawText = msg.text ?? msg.caption ?? "";
    const safeText = stripChannelClose(rawText);

    const attachment = describeAttachment(msg) ?? undefined;
    const attachmentType = attachment ? attachment.kind : null;
    // A caption only makes sense paired with an attachment; preserve it for
    // resolveAttachment to surface alongside the file path. (`msg.caption` is
    // set on captioned media; `msg.text` is set on plain text — they never
    // coexist on one message.)
    const caption =
      attachment && typeof msg.caption === "string" && msg.caption !== ""
        ? stripChannelClose(msg.caption)
        : undefined;

    let body: string;
    if (attachment) {
      // Provisional — resolveAttachment() overwrites this once the download
      // resolves. If the download path is never run (it always is for
      // attachments), the coordinator still sees a sensible placeholder.
      body = `[user sent ${attachment.kind}]`;
    } else if (safeText !== "") {
      body = safeText;
    } else {
      // Defensive only — a message with neither text nor a recognized
      // attachment. Kept so the coordinator at least sees something arrived
      // rather than silently dropping the update.
      body = "[user sent message with no text]";
    }

    // Undefined unless the user actually swipe-replied — an ordinary message
    // must gain nothing at all from this feature. Resolved here rather than at
    // wrap time so `wrapChannelReminder` stays pure (the cache probe inside
    // `extractReplyContext` is the state it would otherwise have to touch).
    const replyTo = extractReplyContext(msg, chatId) ?? undefined;

    return { chatId, messageId, userId, username, ts, body, attachmentType, attachment, caption, replyTo };
  }

  /** Download a message's attachment and rewrite its body with the resolved
   *  local path. Mutates `msg.body` in place (and clears the size note on
   *  failure). Best-effort Telegram replies for too-big / failed cases. Never
   *  throws — a failure leaves a clear coordinator note rather than a path.
   *
   *  Flow:
   *   1. Size guard: if the advertised `fileSize` already exceeds the 20 MB
   *      `getFile` ceiling, skip the download, reply "too big", surface a note.
   *   2. `getFile(file_id)` → `file_path`. Failure → note + return.
   *   3. `downloadFile(file_path)` (which re-guards the size on the wire).
   *      Too-big-on-download → reply + note; other failure → note.
   *   4. Store under `inbound/<chat>/<unix-ms>-<safeName>`, rewrite body to
   *      `[user sent <kind>: <path> (<size>)]` with the caption prepended. */
  private async resolveAttachment(msg: NormalizedMessage): Promise<void> {
    const att = msg.attachment;
    if (!att) return;

    const captionPrefix =
      msg.caption !== undefined && msg.caption !== "" ? `${msg.caption}\n` : "";

    // 1. Pre-download size guard (where the size is advertised).
    if (att.fileSize !== undefined && att.fileSize > TELEGRAM_GETFILE_LIMIT_BYTES) {
      const human = humanSize(att.fileSize);
      await this.replyOnTelegram(
        `That ${att.kind} is too large to download (${human}; the bot can only fetch files up to 20 MB).`,
      );
      msg.body = `${captionPrefix}[user sent ${att.kind} (${human}) — too large to download (over the 20 MB Bot API limit), not saved]`;
      return;
    }

    // 2. Resolve the file_id to a file_path.
    let filePath: string;
    let resolvedSize = att.fileSize;
    try {
      const got = await this.client.getFile(att.fileId);
      if (!got.ok) {
        logCtx.fn(`Telegram dispatcher: getFile failed (status=${got.status})`);
        msg.body = `${captionPrefix}[user sent ${att.kind} — could not retrieve it from Telegram (getFile failed), not saved]`;
        return;
      }
      if (got.file.file_path === undefined || got.file.file_path === "") {
        msg.body = `${captionPrefix}[user sent ${att.kind} — Telegram returned no downloadable path, not saved]`;
        return;
      }
      filePath = got.file.file_path;
      if (resolvedSize === undefined) resolvedSize = got.file.file_size;
      // Re-guard with the authoritative size from getFile if the message
      // omitted it.
      if (resolvedSize !== undefined && resolvedSize > TELEGRAM_GETFILE_LIMIT_BYTES) {
        const human = humanSize(resolvedSize);
        await this.replyOnTelegram(
          `That ${att.kind} is too large to download (${human}; the bot can only fetch files up to 20 MB).`,
        );
        msg.body = `${captionPrefix}[user sent ${att.kind} (${human}) — too large to download (over the 20 MB Bot API limit), not saved]`;
        return;
      }
    } catch (err) {
      // classifyError, never err.message (token-bearing URL safety).
      logCtx.fn(`Telegram dispatcher: getFile threw: ${classifyError(err)}`);
      msg.body = `${captionPrefix}[user sent ${att.kind} — could not retrieve it from Telegram, not saved]`;
      return;
    }

    // 3. Download the bytes (re-guards the size on the wire).
    let bytes: Uint8Array;
    try {
      const dl = await this.client.downloadFile(filePath);
      if (!dl.ok) {
        if (dl.reason.startsWith("file too large")) {
          const human = resolvedSize !== undefined ? humanSize(resolvedSize) : "over 20 MB";
          await this.replyOnTelegram(
            `That ${att.kind} is too large to download (${human}; the bot can only fetch files up to 20 MB).`,
          );
          msg.body = `${captionPrefix}[user sent ${att.kind} — too large to download (over the 20 MB Bot API limit), not saved]`;
          return;
        }
        // reason is already a bounded, token-free label from downloadFile.
        logCtx.fn(`Telegram dispatcher: downloadFile failed: ${dl.reason}`);
        msg.body = `${captionPrefix}[user sent ${att.kind} — download failed, not saved]`;
        return;
      }
      bytes = dl.bytes;
    } catch (err) {
      logCtx.fn(`Telegram dispatcher: downloadFile threw: ${classifyError(err)}`);
      msg.body = `${captionPrefix}[user sent ${att.kind} — download failed, not saved]`;
      return;
    }

    // 4. Store and rewrite the body with the local path.
    try {
      // Derive a sanitized display leaf. Prefer the attachment's displayName
      // (already safeName()-d in describeAttachment); fall back to the file_path
      // basename. NEVER use the raw Telegram file_name for the path — storeInboundFile
      // applies a final path-traversal guard regardless.
      const leaf = att.displayName || basenameOf(filePath) || `${att.kind}.bin`;
      const ts = msg.ts ? Date.parse(msg.ts) : nowCtx.fn();
      const unixMs = Number.isFinite(ts) ? ts : nowCtx.fn();
      const stored = await storeInboundFile(msg.chatId, unixMs, leaf, bytes);
      const human = humanSize(bytes.byteLength);
      msg.body = `${captionPrefix}[user sent ${att.kind}: ${stored} (${human})]`;
    } catch (err) {
      logCtx.fn(
        `Telegram dispatcher: failed to store inbound ${att.kind}: ${err instanceof Error ? err.message : String(err)}`,
      );
      msg.body = `${captionPrefix}[user sent ${att.kind} — downloaded but failed to save locally]`;
    }
  }

  /** Extract the fields we deliver from one `message_reaction` update.
   *  Applies the same allowlist filter as inbound messages. Returns null on
   *  malformed input (no chat_id), a non-allowlisted sender, or a no-op update
   *  (neither added nor removed emoji — e.g. a custom_emoji-only change we
   *  don't surface). */
  private normalizeReaction(r: MessageReactionUpdated): NormalizedReaction | null {
    const chatId = String(r.chat?.id ?? "");
    if (!chatId) return null;
    // The actor is `user` in private chats; `actor_chat` covers anonymous
    // group reactions (we don't route groups, but keep the id correct for the
    // allowlist check so a group reaction isn't accidentally allowed via an
    // undefined user).
    const userId =
      r.user?.id !== undefined
        ? String(r.user.id)
        : r.actor_chat?.id !== undefined
          ? String(r.actor_chat.id)
          : undefined;

    if (!this.isAllowed(chatId, userId)) {
      this.logDrop(chatId, userId);
      return null;
    }

    const username = r.user?.username ?? r.user?.first_name ?? "unknown";
    const tsEpoch = r.date !== undefined ? r.date * 1000 : nowCtx.fn();
    const ts = new Date(tsEpoch).toISOString();

    const oldEmojis = emojiSet(r.old_reaction);
    const newEmojis = emojiSet(r.new_reaction);
    const added = [...newEmojis].filter((e) => !oldEmojis.has(e));
    const removed = [...oldEmojis].filter((e) => !newEmojis.has(e));

    // Nothing emoji-shaped changed (e.g. a custom-emoji-only update). Skip —
    // surfacing "reacted with (custom emoji)" adds noise without signal.
    if (added.length === 0 && removed.length === 0) return null;

    const messageId = typeof r.message_id === "number" ? r.message_id : 0;
    return { chatId, messageId, userId: userId ?? null, username, ts, added, removed };
  }

  /** Wrap a reaction event in a channel-reminder block and deliver it to the
   *  coordinator. No retry / offline-prompt: a reaction is informational, so a
   *  send failure is logged and the notice is dropped rather than re-prompting
   *  the user or buffering. */
  private async deliverReaction(reaction: NormalizedReaction): Promise<void> {
    try {
      // Inside the try, not above it: "reaction delivery must never break" is a
      // hard requirement, and this line now runs Array.from/join on
      // user-influenced text via the preview path. Better true by construction
      // than true by argument — a throw here would otherwise escape unlogged.
      const wrapped = wrapReactionReminder(reaction, resolveReactionPreview(reaction));
      const result = await sendCtx.fn(wrapped, { fromAgent: TELEGRAM_SENTINEL, raw: true });
      if (!result.ok) {
        logCtx.fn(
          `Telegram dispatcher: reaction notice not delivered (coordinator offline?): ${result.stderr || "send returned ok=false"}`,
        );
      }
    } catch (err) {
      logCtx.fn(
        `Telegram dispatcher: deliverReaction threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Collect the `emoji` strings from a reaction-type array, ignoring
 *  custom-emoji and paid reactions (we only surface documented emoji). */
function emojiSet(reactions: ReactionType[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(reactions)) return out;
  for (const r of reactions) {
    if (r && typeof r === "object" && (r as { type?: string }).type === "emoji") {
      const emoji = (r as { emoji?: unknown }).emoji;
      if (typeof emoji === "string" && emoji !== "") out.add(emoji);
    }
  }
  return out;
}

/** Partition a per-chat batch into slash commands (raw passthrough) and
 *  ordinary messages (coalesced + wrapped). Order within each bucket is
 *  preserved so the original interleaving of slash and non-slash messages
 *  is reflected — slashes deliver first via the mutex chain, then the
 *  normals deliver as one block. Match is strict for `/context` and
 *  `/clear` (exact trimmed body) and prefix-tolerant for `/compact` (the
 *  command may be followed by whitespace and arbitrary compaction
 *  instructions). `/CONTEXT` or `/context extra` fall through as normals;
 *  `/compactfoo` (no separator) also falls through. */
export function splitSlashCommands(messages: NormalizedMessage[]): {
  slashes: NormalizedMessage[];
  normals: NormalizedMessage[];
} {
  const slashes: NormalizedMessage[] = [];
  const normals: NormalizedMessage[] = [];
  for (const m of messages) {
    if (matchSlashCommand(m.body.trim()) !== null) {
      slashes.push(m);
    } else {
      normals.push(m);
    }
  }
  return { slashes, normals };
}

/** Wrap a coalesced per-chat batch in the channel-reminder block format
 *  defined in Phase 0.
 *
 *  A message that swipe-replied to another one gains an `in_reply_to` attribute
 *  and a leading `Replying to …` line; see {@link formatReplyLine}. A message
 *  that did not — i.e. ordinary typed chatter, the overwhelming majority — is
 *  rendered EXACTLY as it was before replies were handled. That is a hard
 *  requirement, not a nicety: `replyTo` is undefined for those and every
 *  addition below is gated on it. */
export function wrapChannelReminder(chatId: string, messages: NormalizedMessage[]): string {
  if (messages.length === 0) {
    throw new Error("wrapChannelReminder: messages is empty");
  }
  const safeChatId = String(chatId);

  if (messages.length === 1) {
    const m = messages[0]!;
    const lines: string[] = [
      `<channel source="telegram" user="${escapeAttr(m.username)}" ts="${escapeAttr(m.ts)}"${messageIdAttr("message_id", m.messageId)}${replyToAttr(m.replyTo)}>`,
    ];
    // The id lives in the `in_reply_to` attribute here, so the body line omits
    // it — the single-message block has an attribute slot to put it in.
    const reply = formatReplyLine(m.replyTo, false);
    if (reply !== "") lines.push(reply);
    lines.push(m.body, `</channel>`, ``, REPLY_HINT);
    return lines.join("\n");
  }

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const lines: string[] = [];
  lines.push(
    `<channel source="telegram" chat_id="${escapeAttr(safeChatId)}" user="${escapeAttr(first.username)}" first_ts="${escapeAttr(first.ts)}" count="${messages.length}"${messageIdAttr("last_message_id", last.messageId)}>`,
  );
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) lines.push("---");
    // A coalesced batch has ONE header for N messages, so there is no per-message
    // attribute slot: a block-level `in_reply_to` would be ambiguous about which
    // of the N it belonged to. The reply line therefore sits immediately above
    // the body it belongs to (binding it to THAT message, not the block) and
    // spells the id out inline, which is the only place left to carry it.
    const m = messages[i]!;
    const reply = formatReplyLine(m.replyTo, true);
    if (reply !== "") lines.push(reply);
    lines.push(m.body);
  }
  lines.push(`</channel>`);
  lines.push(``);
  lines.push(REPLY_HINT);
  return lines.join("\n");
}

/** The ` in_reply_to="<id>"` attribute, or "" when there is no reply or no
 *  usable id. Same `messageIdAttr` convention as `message_id`: an unusable id
 *  is omitted entirely rather than emitted as `="0"`, so anything the agent
 *  sees here is a valid `ib tgreact --message-id` / reply target. */
function replyToAttr(reply: ReplyContext | undefined): string {
  if (!reply) return "";
  return messageIdAttr("in_reply_to", reply.messageId);
}

/** Render the `Replying to …` line that precedes a replying message's body, or
 *  "" when there is no reply (the ordinary case) or nothing to say about it.
 *
 *  Shapes, in the order they degrade:
 *
 *      Replying to (your message): "Ready to merge — squash first…"   ← ideal
 *      Replying to: "Ready to merge — squash first…"                  ← whose unknown
 *      Replying to message 1584 (your message)                        ← text unresolvable
 *      Replying to message 1584                                       ← neither
 *
 *  `includeId` distinguishes the two call sites: false for a single-message
 *  block, whose header already carries `in_reply_to`, and true inside a
 *  coalesced batch, where there is no per-message attribute. The id is spelled
 *  out inline whenever the TEXT is missing regardless, because "Replying to
 *  (your message)" with no quote and no number identifies nothing.
 *
 *  Never renders empty quotes: no text means no `: "…"` clause at all. */
function formatReplyLine(reply: ReplyContext | undefined, includeId: boolean): string {
  if (!reply) return "";
  const whose = reply.direction ? ` (${whoseMessage(reply.direction)})` : "";
  if (reply.text !== "") {
    const idPart = includeId && reply.messageId > 0 ? ` message ${reply.messageId}` : "";
    return `Replying to${idPart}${whose}: "${reply.text}"`;
  }
  if (reply.messageId > 0) return `Replying to message ${reply.messageId}${whose}`;
  return "";
}

/** Hint appended to every wrapped channel block telling the coordinator how to
 *  reply and react on Telegram. Centralized so the two `wrapChannelReminder`
 *  branches (single + coalesced) and any future caller stay in sync. */
const REPLY_HINT =
  'To reply on Telegram, run `ib tgsend "<your message>"`. ' +
  "To react to the latest message, run `ib tgreact <emoji>` " +
  "(e.g. `ib tgreact 👍`), or target a specific one with " +
  "`ib tgreact <emoji> --message-id <id>`.";

/** {@link REPLY_HINT} plus one sentence about the echoed id, used ONLY on
 *  reaction blocks. Derived from `REPLY_HINT` rather than spelled out a second
 *  time, so the two variants cannot drift.
 *
 *  Reaction-only on purpose. Every inbound Telegram message carries a hint, so
 *  putting this sentence in the shared base would make it a permanent
 *  ~75-character context tax on ordinary chatter, paid to serve the rare
 *  reaction case.
 *
 *  The obvious objection: the coordinator now learns the id is worth keeping
 *  only AFTER a reaction arrives, never before it sends. That's acceptable —
 *  `ib tgsend` prints `ok (message_id 1584)` either way, so the id is already
 *  in the coordinator's context. This sentence is a nudge to RETAIN the id, not
 *  the mechanism that delivers it. */
const REACTION_REPLY_HINT =
  REPLY_HINT + " `ib tgsend` echoes the sent `message_id`; keep it to match later reactions.";

/** Wrap a reaction event in a channel-reminder block. The body is a
 *  human-readable summary, e.g. `Reacted 👍 to message 123` or
 *  `Removed reaction 👍 from message 123`. Distinct `kind="reaction"`
 *  attribute so the coordinator can tell a reaction event apart from a text
 *  message. The reacted-to `message_id` is surfaced so the coordinator can
 *  reply or react back to that exact message.
 *
 *  When `preview` is supplied, the reacted-to message's text and whose it was
 *  are appended:
 *
 *      Reacted 👍 to message 1584 (your message): "Ready to merge — squash?…"
 *
 *  which is the difference between an actionable reaction and an id the
 *  coordinator has to guess at. Omit `preview` (or pass null) and you get the
 *  id-only form — the required behavior on a cache miss. The summary line and
 *  the `<channel>` body are then byte-identical to the pre-feature output; the
 *  trailing hint is not ({@link REACTION_REPLY_HINT} adds a sentence), and it
 *  is part of the same returned string.
 *
 *  SYNC AND PURE ON PURPOSE. The cache lookup lives in `resolveReactionPreview`
 *  and the resolved preview is passed in, so this stays a formatter with no
 *  state or IO — which is what makes it directly testable. */
export function wrapReactionReminder(
  reaction: NormalizedReaction,
  preview?: ReactionPreview | null,
): string {
  const parts: string[] = [];
  // Each emoji is stripped of </channel> defensively (emoji never contain it,
  // but the body is user-influenced data, so we stay consistent). Each clause
  // carries its own preposition so the grammar reads correctly whether the
  // update added, removed, or changed a reaction.
  const msgRef = `message ${reaction.messageId}`;
  if (reaction.added.length > 0) {
    parts.push(`Reacted ${reaction.added.map(stripChannelClose).join(" ")} to ${msgRef}`);
  }
  if (reaction.removed.length > 0) {
    parts.push(`Removed reaction ${reaction.removed.map(stripChannelClose).join(" ")} from ${msgRef}`);
  }
  let body = parts.join("; ");
  // The suffix is appended ONCE to the joined body rather than per clause: both
  // clauses of a changed reaction name the same message, so repeating the
  // preview would be pure noise. `(whose): "text"` binds naturally to the
  // trailing `message N` in every variant — added, removed, and changed.
  //
  // No preview → `body` is untouched, which is exactly the pre-feature output.
  // That is the required fallback, not an incidental one: a cache miss is the
  // EXPECTED case after an `ib watch` restart.
  if (preview) {
    // Trim after stripping, not before: a preview of `" </channel> "` is
    // blank once the tag is gone, and an empty pair of quotes is worse than no
    // preview at all. `formatMessagePreview` already guarantees a trimmed
    // non-empty string, but this function is exported and callable directly, so
    // it enforces its own contract.
    const text = stripChannelClose(preview.text).trim();
    if (text !== "") {
      body += ` (${whoseMessage(preview.direction)}): "${text}"`;
    }
  }
  return [
    `<channel source="telegram" kind="reaction" user="${escapeAttr(reaction.username)}" ts="${escapeAttr(reaction.ts)}"${messageIdAttr("message_id", reaction.messageId)}>`,
    body,
    `</channel>`,
    ``,
    REACTION_REPLY_HINT,
  ].join("\n");
}

/** A resolved text preview of the message a reaction targeted, ready to drop
 *  into the reaction block. `text` is already single-line, truncated, and
 *  `stripChannelClose`-d by {@link formatMessagePreview}. */
export interface ReactionPreview {
  text: string;
  direction: MessageDirection;
}

/** Max rendered preview length in CODE POINTS, before the ellipsis. Long enough
 *  to carry a coordinator's headline question (which is the case that actually
 *  failed: a 👍 on an either/or is unreadable without seeing the branches),
 *  short enough that a reaction notice — or the `Replying to …` line that
 *  precedes a reply's body — stays one tidy line in the transcript.
 *
 *  Code points, so an all-emoji preview can be up to 2x this in UTF-16 units.
 *  Tests asserting this cap must count `Array.from(text).length`. */
const MESSAGE_PREVIEW_MAX_CHARS = 160;

/** Look up the reacted-to message in the in-memory cache and format a preview,
 *  or null when we can't. Null is a NORMAL outcome, not an error — the id is
 *  absent after an `ib watch` restart, after ring eviction, or for any message
 *  sent before this feature existed. Callers render the id-only form then.
 *
 *  Kept as a module function (not a method) so it stays trivially testable and
 *  so `wrapReactionReminder` can remain sync and pure — the state lookup lives
 *  here, the formatting lives there. */
function resolveReactionPreview(reaction: NormalizedReaction): ReactionPreview | null {
  let cached;
  try {
    cached = lookupMessage(reaction.chatId, reaction.messageId);
  } catch {
    // lookupMessage does no IO and is documented as total, but a reaction
    // notice is not worth risking on that promise.
    return null;
  }
  if (!cached) return null;
  const text = formatMessagePreview(cached.text);
  if (text === "") return null;
  return { text, direction: cached.direction };
}

/** Build the {@link ReplyContext} for a message that swipe-replied to another
 *  one, or null when there is nothing worth surfacing (no `reply_to_message`,
 *  or a `reply_to_message` with neither a usable id nor any resolvable text).
 *  Null is what keeps ordinary messages untouched.
 *
 *  TEXT RESOLUTION ORDER — the embedded text wins, always:
 *   1. `reply_to_message.text` — AUTHORITATIVE. Telegram embeds the whole
 *      replied-to Message in the update, so this needs no cache, survives an
 *      `ib watch` restart, and works for a message from months ago. That is the
 *      structural difference from the reaction path, which gets only an id and
 *      must hope the ring still holds it.
 *   2. `reply_to_message.caption` — a reply to a photo/document carries a
 *      caption instead of text.
 *   3. The in-memory cache — LAST resort, for the case where Telegram hands us
 *      an id but no usable text (a reply to a bare photo, a sticker, a poll).
 *      Expected to miss often; that is fine, see 4.
 *   4. Nothing resolvable → `text: ""`, rendered as the id-only form.
 *
 *  Defensive against every field it reads, and UNIFORMLY so — every property
 *  read off the update is inside a guard, not just the ones that felt risky
 *  while writing it. The static type promises a `number` message_id and a
 *  `boolean` is_bot; `extractMessageId` is the standing lesson that Telegram
 *  does not always deliver what the docs imply, and the type checker cannot
 *  help with a value that arrives from `JSON.parse`. A malformed
 *  `reply_to_message` degrades to null or to the id-only form — it never throws
 *  on a delivery path. */
export function extractReplyContext(msg: TelegramMessage, chatId: string): ReplyContext | null {
  let replied: TelegramMessage | undefined;
  try {
    replied = msg?.reply_to_message;
  } catch {
    return null;
  }
  if (!replied || typeof replied !== "object") return null;

  // EVERY property read off the untrusted object happens here, inside one
  // guard; the rest of the function works from these locals. Reading them one
  // at a time at their point of use is what left `replied.from` exposed at the
  // call site of `resolveReplyDirection` while the read INSIDE that function
  // was guarded — two of three reads defended, the one between them not, and no
  // way for a reader to tell whether the gap was deliberate.
  //
  // A throwing getter is unreachable from real Telegram (updates come from
  // `JSON.parse`, which never produces accessors), so this defends against
  // nothing that can actually happen — but that is equally true of the other
  // guards on this path, and a consistent posture is worth more than saving
  // four lines. An object whose property access throws is not a Message, so
  // null (no reply context) is the right answer for all of it.
  let rawId: unknown;
  let rawText: unknown;
  let rawCaption: unknown;
  let from: TelegramUser | undefined;
  try {
    rawId = (replied as { message_id?: unknown }).message_id;
    rawText = (replied as { text?: unknown }).text;
    rawCaption = (replied as { caption?: unknown }).caption;
    from = replied.from;
  } catch {
    return null;
  }

  // `Number.isFinite` is load-bearing, not decoration: without it `Infinity`
  // is `typeof "number"` and `> 0`, and would render as `in_reply_to="Infinity"`
  // and `Replying to message Infinity`. Same for `NaN` via the `> 0` test.
  const messageId =
    typeof rawId === "number" && Number.isFinite(rawId) && rawId > 0 ? rawId : 0;

  // Looked up at most once, and only if step 1/2 came up empty or the direction
  // could not be read off `from` — a cache probe is cheap but pointless when
  // the update already answered both questions.
  let cached: CachedMessage | null | undefined;
  const lookup = (): CachedMessage | null => {
    if (cached === undefined) {
      try {
        cached = lookupMessage(chatId, messageId);
      } catch {
        // lookupMessage is documented total and does no IO, but a reply notice
        // is not worth risking on that promise.
        cached = null;
      }
    }
    return cached;
  };

  const embedded = firstNonEmptyString(rawText, rawCaption);
  const raw = embedded !== "" ? embedded : (lookup()?.text ?? "");
  // One formatter for both paths, so a reply preview and a reaction preview of
  // the same message render identically (and there is only one truncation site
  // to get right).
  const text = formatMessagePreview(raw);

  const direction = resolveReplyDirection(from, lookup);

  // Neither an id to target nor a word of text: there is no line to write and
  // no attribute to emit, so say nothing at all rather than emit a stub.
  if (messageId <= 0 && text === "") return null;
  return { messageId, text, direction };
}

/** First of `values` that is a non-empty string, or `""`. Guards the runtime
 *  type as well as presence — `text` is optional AND not guaranteed to be a
 *  string once it exists. */
function firstNonEmptyString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

/** Whose message the reply targeted, or null when undeterminable.
 *
 *  `from.is_bot` is authoritative: everything the coordinator sends goes out
 *  through the bot, so a bot sender means "your message" and a human sender
 *  means "their own message". The cache's recorded direction is the fallback
 *  for updates that omit `from` entirely.
 *
 *  Returns null rather than guessing when both are unavailable — the caller
 *  drops the clause. A confident wrong attribution reads as fact and would send
 *  the coordinator down the wrong path; no clause merely says less. */
function resolveReplyDirection(
  from: TelegramUser | undefined,
  lookup: () => CachedMessage | null,
): MessageDirection | null {
  let isBot: unknown;
  try {
    isBot = from?.is_bot;
  } catch {
    isBot = undefined;
  }
  if (typeof isBot === "boolean") return isBot ? "out" : "in";
  return lookup()?.direction ?? null;
}

/** Squeeze a message down to a single short line. Shared by both context
 *  paths: the preview of a REACTED-to message (text from the in-memory cache)
 *  and the preview of a REPLIED-to message (text embedded in the update). One
 *  formatter, so the two can never render the same text differently — and one
 *  truncation path, since {@link truncateCodePoints} is delicate enough that a
 *  second copy would be a liability.
 *
 *  Takes the first 1-2 non-empty lines — coordinator messages lead with the
 *  headline, so lines 1-2 carry the signal and everything after is detail —
 *  joins them with a space so the block stays on one line, collapses interior
 *  whitespace runs, then truncates to {@link MESSAGE_PREVIEW_MAX_CHARS} with an
 *  explicit `…` so truncation is visible rather than silently misleading.
 *
 *  `stripChannelClose` runs here because this is where untrusted text enters the
 *  formatter: inbound previews are the user's own words, and this file already
 *  applies that defense to every other user-influenced string. (Outbound
 *  previews are the coordinator's own text, but they get the same treatment —
 *  no reason to have two paths.) Returns "" when nothing survives. */
export function formatMessagePreview(text: string): string {
  const lines = stripChannelClose(String(text ?? ""))
    // Lone \r and the Unicode line/paragraph separators would break out of the
    // one-line shape just like \n does; normalize them all before splitting.
    // Escapes, never literals \u2014 U+2028/U+2029 are invisible in an editor.
    .replace(/[\r\u2028\u2029]/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const head = lines.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
  if (head === "") return "";
  // Code points, not code units, for BOTH the cut and the "did we cut?" test —
  // `truncateCodePoints` owns both so they can't drift apart. A unit-counting
  // guard would append "…" to strings it never truncated (160 emoji is 160 code
  // points but 320 code units), and a unit-counting cut would sever pairs.
  //
  // This cap is applied on top of the storage cap rather than trusting it: the
  // steps above SHRINK before this MEASURES (all but the first two lines are
  // dropped, whitespace runs collapse), so a 300-unit cached string can arrive
  // here well under the limit and this guard would never fire. Truncating
  // correctly at BOTH sites is what keeps a severed pair from reaching the
  // coordinator.
  const { text: cut, truncated } = truncateCodePoints(head, MESSAGE_PREVIEW_MAX_CHARS);
  if (!truncated) return cut;
  return cut.trimEnd() + "…";
}

/** Label identifying whose message a reaction landed on, or which message a
 *  reply targeted. The distinction is the point of surfacing direction at all:
 *  a 👍 on something the coordinator asked is an answer, a 👍 on the user's own
 *  message is an acknowledgement — and the same asymmetry holds for a reply. */
function whoseMessage(direction: MessageDirection): string {
  return direction === "out" ? "your message" : "their own message";
}

/** Render a ` name="id"` channel attribute, or the empty string when the id is
 *  not a usable target (0 — emitted by `normalize()` when a message_id was
 *  missing/non-numeric). Omitting it keeps the agent from being handed an
 *  un-reactable `message_id="0"` (which `ib tgreact --message-id 0` rejects). */
function messageIdAttr(name: string, messageId: number): string {
  if (messageId <= 0) return "";
  return ` ${name}="${messageId}"`;
}

/** Strip every `</channel>` substring from inbound text. Defense against a
 *  user forging an early closing tag. Case-insensitive on the literal tag. */
export function stripChannelClose(text: string): string {
  return text.replace(/<\/channel>/gi, "");
}

/** Escape attribute-value characters that would break the channel-reminder
 *  format. Conservative — only what we actually inject. */
function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Sanitize a filename surfaced from Telegram. Strips characters that could
 *  break out of the channel-reminder block or cause shell mishaps. Mirrors
 *  the official plugin `safeName()` (server.ts:896-898). */
export function safeName(name: string): string {
  return String(name).replace(/[<>\[\]\r\n;]/g, "");
}

/** Inspect a message for a downloadable attachment and return a descriptor
 *  (kind + file_id + advertised size + a sanitized display name), or null if it
 *  carries no recognized attachment field.
 *
 *  For photos, the LARGEST `PhotoSize` (last element) is chosen for full
 *  resolution. `displayName` is run through `safeName()` so a malicious
 *  `file_name` can't inject channel-block or shell metacharacters; the on-disk
 *  path is generated by `storeInboundFile`, which never trusts this name. */
export function describeAttachment(msg: TelegramMessage): AttachmentDescriptor | null {
  if (msg.photo !== undefined && msg.photo !== null) {
    const sizes = msg.photo as PhotoSize[];
    if (Array.isArray(sizes) && sizes.length > 0) {
      const largest = pickLargestPhoto(sizes);
      if (largest && typeof largest.file_id === "string" && largest.file_id !== "") {
        return {
          kind: "photo",
          fileId: largest.file_id,
          fileSize: typeof largest.file_size === "number" ? largest.file_size : undefined,
          // Photos have no file_name; synthesize a stable .jpg leaf.
          displayName: safeName(`${largest.file_unique_id ?? "photo"}.jpg`),
        };
      }
    }
    // Photo field present but unusable (empty array, missing file_id) — fall
    // through to the other kinds in case a future field coexists; otherwise null.
  }
  if (msg.document !== undefined && msg.document !== null) {
    const doc = msg.document;
    if (typeof doc.file_id === "string" && doc.file_id !== "") {
      const name =
        typeof doc.file_name === "string" && doc.file_name !== ""
          ? doc.file_name
          : `${doc.file_unique_id ?? "document"}.bin`;
      return {
        kind: "document",
        fileId: doc.file_id,
        fileSize: typeof doc.file_size === "number" ? doc.file_size : undefined,
        displayName: safeName(name),
      };
    }
  }
  if (msg.voice !== undefined && msg.voice !== null) {
    const v = msg.voice;
    if (typeof v.file_id === "string" && v.file_id !== "") {
      return {
        kind: "voice",
        fileId: v.file_id,
        fileSize: typeof v.file_size === "number" ? v.file_size : undefined,
        displayName: safeName(`${v.file_unique_id ?? "voice"}.ogg`),
      };
    }
  }
  if (msg.audio !== undefined && msg.audio !== null) {
    const a = msg.audio;
    if (typeof a.file_id === "string" && a.file_id !== "") {
      const name =
        typeof a.file_name === "string" && a.file_name !== ""
          ? a.file_name
          : `${a.file_unique_id ?? "audio"}.mp3`;
      return {
        kind: "audio",
        fileId: a.file_id,
        fileSize: typeof a.file_size === "number" ? a.file_size : undefined,
        displayName: safeName(name),
      };
    }
  }
  if (msg.video !== undefined && msg.video !== null) {
    const v = msg.video;
    if (typeof v.file_id === "string" && v.file_id !== "") {
      const name =
        typeof v.file_name === "string" && v.file_name !== ""
          ? v.file_name
          : `${v.file_unique_id ?? "video"}.mp4`;
      return {
        kind: "video",
        fileId: v.file_id,
        fileSize: typeof v.file_size === "number" ? v.file_size : undefined,
        displayName: safeName(name),
      };
    }
  }
  if (msg.video_note !== undefined && msg.video_note !== null) {
    const v = msg.video_note;
    if (typeof v.file_id === "string" && v.file_id !== "") {
      return {
        kind: "video_note",
        fileId: v.file_id,
        fileSize: typeof v.file_size === "number" ? v.file_size : undefined,
        displayName: safeName(`${v.file_unique_id ?? "video_note"}.mp4`),
      };
    }
  }
  if (msg.sticker !== undefined && msg.sticker !== null) {
    const s = msg.sticker;
    if (typeof s.file_id === "string" && s.file_id !== "") {
      // Stickers are .webp (static) / .webm (video) / .tgs (animated). We can't
      // always tell from the type flags, so default to .webp — the bytes are
      // correct regardless; only the extension is a hint.
      const ext = s.is_video ? "webm" : s.is_animated ? "tgs" : "webp";
      return {
        kind: "sticker",
        fileId: s.file_id,
        fileSize: typeof s.file_size === "number" ? s.file_size : undefined,
        displayName: safeName(`${s.file_unique_id ?? "sticker"}.${ext}`),
      };
    }
  }
  return null;
}

/** Pick the largest photo size by area (width*height), falling back to
 *  file_size, then to the last array element (Telegram orders smallest→largest,
 *  so the last element is the safe default per the design doc). */
function pickLargestPhoto(sizes: PhotoSize[]): PhotoSize | undefined {
  if (sizes.length === 0) return undefined;
  let best = sizes[sizes.length - 1]!; // last = largest per Telegram convention
  let bestArea = (best.width ?? 0) * (best.height ?? 0);
  for (const s of sizes) {
    const area = (s.width ?? 0) * (s.height ?? 0);
    if (area > bestArea) {
      best = s;
      bestArea = area;
    }
  }
  return best;
}

/** Human-readable byte size. KB/MB with one decimal where it helps. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Last path segment of a Telegram `file_path` (which uses `/` separators).
 *  Used only as a display fallback; never as an on-disk path component. */
function basenameOf(filePath: string): string {
  const parts = String(filePath).split("/");
  return parts[parts.length - 1] ?? "";
}
