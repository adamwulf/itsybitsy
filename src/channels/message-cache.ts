/**
 * Telegram message-text cache — IN MEMORY ONLY, bounded, process-lifetime.
 *
 * Why this exists: a `message_reaction` update carries an emoji and a
 * `message_id` and nothing else. Handed only that, the coordinator has to guess
 * WHICH message was reacted to from sequence and timing — a guess that is
 * usually right, occasionally wrong, and silently degrades whenever messages
 * cross or one queues and arrives late. Worse, even a correctly-identified
 * message doesn't disambiguate a 👍 on an either/or question. Seeing the text
 * makes that recoverable, so we keep just enough recent message text around to
 * render a short preview next to the reaction.
 *
 * DELIBERATELY MEMORY-ONLY. Nothing here is written to disk — not the text, not
 * the id→text map, not a lazily-flushed index. Chat transcripts are the user's
 * private content and this feature does not justify persisting them: the value
 * is a nicety (a nicer reaction notice), and the cost of a durable transcript
 * on disk (backup surface, review surface, retention questions) is not. The
 * cache therefore dies with the `ib watch` process, and every consumer MUST
 * degrade cleanly to today's id-only output when a lookup misses. See
 * `wrapReactionReminder` in dispatcher.ts — a null preview reproduces the
 * pre-feature block byte for byte.
 *
 * The durable half of this feature lives elsewhere and on purpose: `ib tgsend`
 * echoes the Telegram `message_id` of what it just sent (see
 * `TelegramOutbox.process`), so the coordinator ends up with the id in its own
 * conversation history right next to the text it sent. That correlation
 * survives an `ib watch` restart with no cache at all; this module is the
 * richer-but-fragile complement, not a replacement.
 *
 * Module-level singleton rather than an injected dependency: the dispatcher
 * (inbound) and the outbox (outbound) are separate objects constructed side by
 * side in `boot.ts` step 3, but they live in the SAME process and target the
 * SAME resolved chat id. A singleton lets both reach one cache without
 * threading a handle through boot and both constructors. Tests call
 * {@link resetMessageCache} to get isolation back.
 *
 * Bounds: at most {@link MAX_RECORDS} records, oldest evicted first, with each
 * record's text capped at {@link MAX_TEXT_CHARS} on insert. The rendered
 * preview is shorter still (~160 chars) — the extra headroom is free and
 * leaves room to change the preview format without re-plumbing the cache. Worst
 * case the whole cache is a few tens of KB.
 *
 * This module does no IO, so it cannot fail on IO. Lookup is total anyway: an
 * unknown (or malformed) key returns null rather than throwing, because every
 * caller is on a delivery path that must not break over a missing preview.
 */

/** Maximum records retained. Oldest-first eviction past this. Sized so a busy
 *  day of back-and-forth stays resolvable while the memory cost stays trivial. */
export const MAX_RECORDS = 200;

/** Per-record text cap applied at insert time, so one enormous message can't
 *  sit in memory. Comfortably above the rendered preview length. */
export const MAX_TEXT_CHARS = 300;

/** Which side of the conversation a cached message came from. `"out"` is a
 *  message the coordinator sent via `ib tgsend`; `"in"` is a message the user
 *  sent that the dispatcher delivered. The distinction matters to the reader:
 *  a reaction to something the coordinator said reads very differently from a
 *  reaction to the user's own message. */
export type MessageDirection = "in" | "out";

export interface CachedMessage {
  chatId: string;
  messageId: number;
  direction: MessageDirection;
  /** Message text, truncated to {@link MAX_TEXT_CHARS} at insert. */
  text: string;
  /** Wall-clock ms when the record was inserted. Diagnostic only — eviction is
   *  by insertion ORDER, not by age, so nothing reads this to make a decision. */
  cachedAt: number;
}

/**
 * Insertion-ordered store. A `Map` gives us both halves cheaply: O(1) lookup by
 * key, and JS's guaranteed insertion-order iteration makes "oldest first" a
 * `keys().next()` away. Re-inserting an existing key deletes-then-sets so the
 * record moves to the young end rather than keeping a stale position.
 */
const records: Map<string, CachedMessage> = new Map();

/** Compose the lookup key. Chat id is stringified because it arrives as a
 *  string from the dispatcher (`String(r.chat.id)`) and from the outbox
 *  (`String(opts.chatId)`), but callers shouldn't have to care. */
function keyFor(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Record one message's text. Silently ignores anything that couldn't be looked
 * up later anyway (blank chat id, non-positive or non-finite message id) — the
 * caller is on a send/deliver path and a bad record is not worth an error.
 */
export function recordMessage(
  chatId: string,
  messageId: number,
  direction: MessageDirection,
  text: string,
): void {
  const chat = String(chatId ?? "");
  if (chat === "") return;
  if (typeof messageId !== "number" || !Number.isFinite(messageId) || messageId <= 0) return;

  const key = keyFor(chat, messageId);
  // Delete first so a re-record moves the entry to the young end of the map
  // rather than refreshing in place at its old (soon-to-be-evicted) position.
  records.delete(key);
  records.set(key, {
    chatId: chat,
    messageId,
    direction,
    text: String(text ?? "").slice(0, MAX_TEXT_CHARS),
    cachedAt: Date.now(),
  });

  // Evict oldest-first until we're back under the bound. `while`, not `if`:
  // MAX_RECORDS could be lowered between builds and this keeps the invariant
  // regardless of how far over we start.
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next();
    if (oldest.done) break;
    records.delete(oldest.value);
  }
}

/** Convenience wrapper for the outbound (coordinator → user) direction. */
export function recordOutboundMessage(chatId: string, messageId: number, text: string): void {
  recordMessage(chatId, messageId, "out", text);
}

/** Convenience wrapper for the inbound (user → coordinator) direction. */
export function recordInboundMessage(chatId: string, messageId: number, text: string): void {
  recordMessage(chatId, messageId, "in", text);
}

/**
 * Look up a cached message. Returns null for an unknown or un-lookup-able key —
 * never throws. A miss is the EXPECTED case after an `ib watch` restart, so
 * callers must treat null as "render the id-only form", not as an error.
 */
export function lookupMessage(chatId: string, messageId: number): CachedMessage | null {
  const chat = String(chatId ?? "");
  if (chat === "") return null;
  if (typeof messageId !== "number" || !Number.isFinite(messageId) || messageId <= 0) return null;
  return records.get(keyFor(chat, messageId)) ?? null;
}

/** Drop every record. Tests call this in beforeEach/afterEach so one test's
 *  cached messages can't leak into another's lookups. */
export function resetMessageCache(): void {
  records.clear();
}

/** Current record count. Exported for tests and eventual diagnostics; nothing
 *  in the delivery path branches on it. */
export function messageCacheSize(): number {
  return records.size;
}
