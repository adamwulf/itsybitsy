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
 * `wrapReactionReminder` in dispatcher.ts — with a null preview the reaction
 * summary line and the `<channel>` block body are byte-identical to the
 * pre-feature output. (The trailing reply hint is not: it gained one sentence
 * about the echoed message id, and it rides along in the same returned string.)
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
 * record's text capped at {@link MAX_TEXT_CHARS} CODE POINTS on insert. The
 * rendered preview is shorter still (~160) — the extra headroom is free and
 * leaves room to change the preview format without re-plumbing the cache.
 *
 * Worst case: 200 x 300 code points, each of which can be 2 UTF-16 units when
 * astral, so ~240 KB of text plus Map and record overhead — call it under
 * ~300 KB. The 2x over the naive 120 KB is the deliberate cost of
 * code-point-correct truncation. That ceiling only holds because the cap COPIES
 * rather than slicing a view; see {@link truncateCodePoints}, which is the
 * difference between this bound and hundreds of megabytes.
 *
 * This module does no IO, so it cannot fail on IO. Lookup is total anyway: an
 * unknown (or malformed) key returns null rather than throwing, because every
 * caller is on a delivery path that must not break over a missing preview.
 */

/** Maximum records retained. Oldest-first eviction past this. Sized so a busy
 *  day of back-and-forth stays resolvable while the memory cost stays trivial. */
export const MAX_RECORDS = 200;

/** Per-record text cap applied at insert time, so one enormous message can't
 *  sit in memory. Comfortably above the rendered preview length.
 *
 *  Counted in CODE POINTS, not code units — so a record can occupy up to 2x
 *  this many UTF-16 units in the all-astral worst case. That 2x is the
 *  deliberate price of not severing surrogate pairs; see
 *  {@link truncateCodePoints}. Tests asserting the cap must therefore compare
 *  `Array.from(text).length`, never `text.length`. */
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
  /** Message text, truncated to {@link MAX_TEXT_CHARS} CODE POINTS at insert,
   *  and always a fresh string that shares no storage with the caller's. */
  text: string;
  /** Wall-clock ms when the record was inserted. Diagnostic only — eviction is
   *  by insertion ORDER, not by age, so nothing reads this to make a decision. */
  cachedAt: number;
}

/**
 * Truncate to at most `maxCodePoints` CODE POINTS, returning a string that
 * shares no storage with `text`. Both properties are load-bearing and both are
 * easy to get wrong in ways that still look right.
 *
 * **It must COPY.** `String.prototype.slice` returns a VIEW that retains the
 * whole parent buffer — it does not copy. Bound the record COUNT with a view
 * and you have bounded nothing: measured on Bun/JSC, 200 records sliced to 300
 * chars out of 1 MB parents pinned ~103 MB, and ~348 MB once the parents grew
 * to 4 MB — i.e. it tracks PARENT size, not record size. That is not
 * hypothetical here: `sendChunks` slices each chunk out of the full `ib tgsend`
 * payload and `tgsend` has no size cap before chunking, so one piped diff or
 * log would pin its entire payload inside a process designed to run for weeks.
 * `join()` builds a fresh string, which is what actually releases the parent.
 * Idioms that LOOK like copies and are engine-folded no-ops: `"" + s`,
 * `s.repeat(1)`, `s.slice()`. Do not "simplify" this to any of them.
 *
 * **It must count CODE POINTS.** Cutting on code units severs surrogate pairs,
 * so a message ending mid-emoji renders as U+FFFD. Note the trap in the
 * obvious fix:
 *
 *     Array.from(s.slice(0, MAX)).join("")                     // WRONG
 *     Array.from(s.slice(0, MAX * 2)).slice(0, MAX).join("")   // right
 *
 * The first has ALREADY severed the pair before `Array.from` runs; iterating
 * code points then faithfully re-emits the lone surrogate, so the result is
 * byte-identical to doing nothing. Same tokens, opposite outcome — order is
 * everything. Written in the right order it fixes retention AND severance in
 * one expression; in the wrong order it fixes NEITHER.
 *
 * The `* 2` pre-slice keeps the intermediate array bounded for an arbitrarily
 * long input while still being provably sufficient: a pair severed by the
 * pre-slice sits at unit index `2*max - 1`, so at least `max` complete code
 * points precede it and `.slice(0, max)` always drops it.
 *
 * Returns `truncated` so the CALLER decides what a cut means (the display site
 * appends an ellipsis; the storage site doesn't care). The comparison lives
 * here, with the cut, deliberately: a code-unit guard paired with a code-point
 * cut MOVES the bug instead of removing it — 160 emoji is 160 code points but
 * 320 code units, so a unit guard would append "…" to a string it never
 * actually truncated. Guard and cut must count the same unit.
 *
 * Deliberately does NOT call `.toWellFormed()`. A lone surrogate already
 * present in the INPUT survives any truncation strategy, and that is fine: the
 * outbound path self-sanitizes (text round-trips through a UTF-8 file before
 * being cached), the inbound path would need Telegram to emit an escaped
 * unpaired surrogate in its JSON, and the blast radius is one U+FFFD glyph —
 * not worth a second lossy transform on the user's own text.
 */
export function truncateCodePoints(
  text: string,
  maxCodePoints: number,
): { text: string; truncated: boolean } {
  const s = String(text ?? "");
  const points = Array.from(s.slice(0, maxCodePoints * 2));
  // Two ways to be over the cap. If the input exceeded the pre-slice budget it
  // is over by definition (more than 2*max units means more than max code
  // points, since a code point is at most 2 units). Otherwise `points` is the
  // complete decomposition and its length is the exact answer.
  const truncated = s.length > maxCodePoints * 2 || points.length > maxCodePoints;
  const kept = truncated ? points.slice(0, maxCodePoints) : points;
  // `join` unconditionally — including on the not-truncated path — so the
  // return value never shares storage with the caller's string.
  return { text: kept.join(""), truncated };
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
    // Must be `truncateCodePoints`, not `.slice` — see that function for why a
    // view would let one `ib tgsend` payload pin megabytes behind a 300-char
    // record, and why the order of its operations is load-bearing.
    text: truncateCodePoints(text, MAX_TEXT_CHARS).text,
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
