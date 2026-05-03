/**
 * Telegram inbound dispatcher.
 *
 * Long-polls Telegram via {@link TelegramClient.getUpdates}, filters each
 * batch through the allowlist, wraps the surviving messages in a
 * channel-reminder block, and delivers them to the system coordinator via
 * `sendToSystemCoordinator(..., { fromAgent: "@telegram" })`.
 *
 * Key invariants:
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
 *   - Attachment fallback: messages without text/caption produce both a
 *     "Received attachment" Telegram reply AND a `[user sent <type>]`
 *     channel-reminder so the coordinator sees the event.
 *   - Coordinator-offline: one retry after 2s, then a Telegram reply
 *     ("coordinator offline, message dropped — start it with `ib watch`")
 *     and the batch is dropped.
 *   - `</channel>` substrings are stripped from inbound text/caption before
 *     wrapping (defense against forged closing tags).
 *   - `stop()` aborts the in-flight long-poll via AbortController and waits
 *     for the loop to exit (caller wraps in a 2s timeout race).
 */

import { InjectionContext } from "../types";
import { TelegramClient, classifyError } from "./telegram-client";
import type { TelegramMessage, TelegramUpdate } from "./types";

/** Delivery hook the dispatcher calls per coalesced batch. Defaults to
 *  the real `sendToSystemCoordinator` from src/index.ts; tests inject a
 *  mock to capture call order without booting tmux. */
export type SendToCoordinatorFn = (
  message: string,
  opts?: { fromAgent?: string; cwd?: string },
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

/** Coordinator-offline retry delay (ms). Plan: "retry once after 2s." */
const COORDINATOR_OFFLINE_RETRY_MS = 2_000;

/** Drop-log throttle: one line per chat_id per hour. */
const DROP_LOG_INTERVAL_MS = 60 * 60 * 1_000;

/** Fixed sentinel routed by sendMessage as "[sent by @telegram]:". */
export const TELEGRAM_SENTINEL = "@telegram";

/** Tag on the per-coordinator mutex. Phase 5 only ever has one (the system
 *  coordinator) but the structure allows future per-repo coordinators to
 *  serialize independently. */
const SYSTEM_COORDINATOR_MUTEX_KEY = "system";

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

/** What we extract from one TelegramMessage for the channel-reminder body. */
interface NormalizedMessage {
  chatId: string;
  userId: string | null;
  username: string;
  ts: string;
  body: string;
  /** Set when the original message had no text/caption — used to drive the
   *  attachment-fallback Telegram reply. */
  attachmentType: string | null;
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
      return;
    }

    if (!probe.ok) {
      const desc = "description" in probe && probe.description ? `: ${probe.description}` : "";
      logCtx.fn(`Telegram startup probe got HTTP ${probe.status}${desc}; starting main loop anyway`);
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
    this.loopDone = this.runLoop(this.abortController.signal).catch((err) => {
      logCtx.fn(`Telegram dispatcher loop exited: ${err instanceof Error ? err.message : String(err)}`);
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
  }

  /** The actual long-poll loop. Exits when the abort signal fires. */
  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.client.getUpdates({
          offset: this.nextOffset,
          allowed_updates: ["message"],
          signal,
        });
      } catch (err) {
        // getUpdates only throws on abort. Any other transient failure is
        // absorbed by the client's own retry loop.
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        logCtx.fn(
          `Telegram dispatcher: unexpected getUpdates throw: ${err instanceof Error ? err.message : String(err)}; continuing`,
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

    for (const update of updates) {
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
      const existing = byChat.get(normalized.chatId);
      if (existing) {
        existing.push(normalized);
      } else {
        byChat.set(normalized.chatId, [normalized]);
      }
    }

    // Deliver each chat's coalesced batch through the mutex. We run them
    // sequentially via the same mutex chain so two chats' messages never
    // interleave on the coordinator pipe.
    for (const [chatId, messages] of byChat.entries()) {
      // Mutex acquisition inside this for-await loop is redundant with the
      // sequential iteration — the loop already serializes per-chat batches
      // within a single getUpdates result. Kept as defense-in-depth: a
      // future refactor that parallelizes batches across chats (e.g. via
      // Promise.all) must still serialize keystrokes to a single coordinator
      // tmux session, and the mutex is the contract that enforces it.
      // Capture for the closure — TS narrows `messages` correctly.
      await this.withMutex(SYSTEM_COORDINATOR_MUTEX_KEY, async () => {
        await this.deliver(chatId, messages);
      });
    }
  }

  /** Wrap and deliver one chat's worth of coalesced messages, plus any
   *  attachment-fallback Telegram reply. */
  private async deliver(chatId: string, messages: NormalizedMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const wrapped = wrapChannelReminder(chatId, messages);
    const sendResult = await sendCtx.fn(wrapped, { fromAgent: TELEGRAM_SENTINEL });

    let delivered = sendResult.ok;
    if (!sendResult.ok) {
      // Coordinator-offline retry: wait 2s and try once more.
      await sleepCtx.fn(COORDINATOR_OFFLINE_RETRY_MS);
      const retry = await sendCtx.fn(wrapped, { fromAgent: TELEGRAM_SENTINEL });
      delivered = retry.ok;
      if (!delivered) {
        await this.replyOnTelegram(
          "coordinator offline, message dropped — start it with `ib watch`.",
        );
      }
    }

    // Attachment-fallback Telegram reply: fires only when the batch contained
    // at least one bare attachment (no text and no caption). When a caption
    // was present we already surfaced it as the body, so no notice is needed.
    // `normalize()` sets `attachmentType` to non-null only for bare attachments;
    // captioned messages have it cleared back to null.
    if (delivered && messages.some((m) => m.attachmentType !== null)) {
      await this.replyOnTelegram("Received attachment — text only supported");
    }
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
   *  Returns null on malformed input (no chat_id). */
  private normalize(msg: TelegramMessage): NormalizedMessage | null {
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return null;
    const userId = msg.from?.id !== undefined ? String(msg.from.id) : null;
    const username = msg.from?.username ?? msg.from?.first_name ?? "unknown";
    const tsEpoch = msg.date !== undefined ? msg.date * 1000 : nowCtx.fn();
    const ts = new Date(tsEpoch).toISOString();

    // Defensive: text or caption, whichever is present. Strip </channel> so
    // a user can't forge an early closing tag in the wrapped block.
    const rawText = msg.text ?? msg.caption ?? "";
    const safeText = stripChannelClose(rawText);

    let body: string;
    let attachmentType: string | null = attachmentTypeOf(msg);
    if (safeText !== "") {
      body = safeText;
      // attachmentType still set if the message had both an attachment AND
      // a caption — caller doesn't need to send the "received attachment"
      // reply in that case (we surface the caption as content), so clear it.
      if (attachmentType !== null) {
        attachmentType = null;
      }
    } else if (attachmentType !== null) {
      body = `[user sent ${attachmentType}]`;
    } else {
      // Defensive only — upstream normalize() guarantees text/caption/
      // attachment-notice via the rawText fallback (`text ?? caption ?? ""`)
      // plus attachmentTypeOf(), so reaching this branch requires a future
      // refactor that changes normalize()'s contract. Kept as a paranoia
      // fallback so the coordinator at least sees something arrived rather
      // than silently dropping the update.
      body = "[user sent message with no text]";
    }

    return { chatId, userId, username, ts, body, attachmentType };
  }
}

/** Wrap a coalesced per-chat batch in the channel-reminder block format
 *  defined in Phase 0. */
export function wrapChannelReminder(chatId: string, messages: NormalizedMessage[]): string {
  if (messages.length === 0) {
    throw new Error("wrapChannelReminder: messages is empty");
  }
  const safeChatId = String(chatId);

  if (messages.length === 1) {
    const m = messages[0]!;
    return [
      `<channel source="telegram" user="${escapeAttr(m.username)}" ts="${escapeAttr(m.ts)}">`,
      m.body,
      `</channel>`,
      ``,
      `To reply on Telegram, run \`ib tgsend "<your message>"\`.`,
    ].join("\n");
  }

  const first = messages[0]!;
  const lines: string[] = [];
  lines.push(
    `<channel source="telegram" chat_id="${escapeAttr(safeChatId)}" user="${escapeAttr(first.username)}" first_ts="${escapeAttr(first.ts)}" count="${messages.length}">`,
  );
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) lines.push("---");
    lines.push(messages[i]!.body);
  }
  lines.push(`</channel>`);
  lines.push(``);
  lines.push(`To reply on Telegram, run \`ib tgsend "<your message>"\`.`);
  return lines.join("\n");
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

/** Identify which attachment kind a message carries (photo, document, etc.).
 *  Returns null if the message has no recognized attachment field. */
function attachmentTypeOf(msg: TelegramMessage): string | null {
  if (msg.photo !== undefined && msg.photo !== null) return "photo";
  if (msg.document !== undefined && msg.document !== null) return "document";
  if (msg.voice !== undefined && msg.voice !== null) return "voice";
  if (msg.audio !== undefined && msg.audio !== null) return "audio";
  if (msg.video !== undefined && msg.video !== null) return "video";
  if (msg.video_note !== undefined && msg.video_note !== null) return "video_note";
  if (msg.sticker !== undefined && msg.sticker !== null) return "sticker";
  return null;
}
