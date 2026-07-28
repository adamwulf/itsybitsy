/**
 * Tests for the in-memory Telegram message-text cache.
 *
 * The cache does no IO, so there's no tmpdir setup here — only
 * `resetMessageCache()` between tests, since the store is a module-level
 * singleton shared by the dispatcher and the outbox.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  recordMessage,
  recordInboundMessage,
  recordOutboundMessage,
  lookupMessage,
  resetMessageCache,
  messageCacheSize,
  truncateCodePoints,
  MAX_RECORDS,
  MAX_TEXT_CHARS,
} from "./message-cache";

/** A 2-code-unit astral character — the case where a code-unit cap silently
 *  stops measuring what it claims to. */
const EMOJI = "\u{1F600}";

/** Count CODE POINTS. `String.prototype.length` counts code units and would
 *  make every cap assertion below vacuous for astral text. */
function cpLength(s: string): number {
  return Array.from(s).length;
}

beforeEach(() => {
  resetMessageCache();
});

afterEach(() => {
  resetMessageCache();
});

describe("record + lookup", () => {
  test("round-trips an outbound message", () => {
    recordOutboundMessage("100", 1584, "Ready to merge?");
    const found = lookupMessage("100", 1584);
    expect(found).not.toBeNull();
    expect(found!.text).toBe("Ready to merge?");
    expect(found!.direction).toBe("out");
    expect(found!.chatId).toBe("100");
    expect(found!.messageId).toBe(1584);
  });

  test("round-trips an inbound message", () => {
    recordInboundMessage("100", 42, "hi there");
    expect(lookupMessage("100", 42)!.direction).toBe("in");
  });

  test("unknown id returns null, does not throw", () => {
    recordOutboundMessage("100", 1, "a");
    expect(lookupMessage("100", 999)).toBeNull();
  });

  test("chat id scopes the lookup — same message id in another chat misses", () => {
    recordOutboundMessage("100", 7, "chat one");
    expect(lookupMessage("200", 7)).toBeNull();
    expect(lookupMessage("100", 7)!.text).toBe("chat one");
  });

  test("a numeric chat id is coerced, so it matches its string form", () => {
    // The casts are the point — the signature says `string`, so only a cast
    // reaches the runtime coercion. (Passing `String(100)` would just be
    // another string round-trip, proving nothing beyond the test above.)
    recordOutboundMessage(100 as unknown as string, 7, "x");
    expect(lookupMessage("100", 7)).not.toBeNull();
    expect(lookupMessage(100 as unknown as string, 7)).not.toBeNull();
    // The lookups alone would pass even without the explicit
    // `String(chatId ?? "")`, because `keyFor` builds its key with a template
    // literal and that coerces on its own. THIS is the assertion that pins the
    // explicit coercion: the stored field must be a string, not the number.
    expect(lookupMessage("100", 7)!.chatId).toBe("100");
  });

  test("re-recording the same id overwrites the text", () => {
    recordOutboundMessage("100", 5, "first");
    recordOutboundMessage("100", 5, "second");
    expect(lookupMessage("100", 5)!.text).toBe("second");
    expect(messageCacheSize()).toBe(1);
  });

  test("re-recording moves the entry to the young end (survives eviction)", () => {
    recordOutboundMessage("100", 1, "oldest");
    for (let i = 2; i <= MAX_RECORDS; i++) recordOutboundMessage("100", i, `m${i}`);
    // Cache is exactly full and id 1 is the oldest. Re-record it, then push one
    // more: id 1 must survive and id 2 must be the one evicted.
    recordOutboundMessage("100", 1, "refreshed");
    recordOutboundMessage("100", MAX_RECORDS + 1, "newest");
    expect(lookupMessage("100", 1)!.text).toBe("refreshed");
    expect(lookupMessage("100", 2)).toBeNull();
  });
});

describe("bounds", () => {
  test("evicts oldest-first past MAX_RECORDS", () => {
    for (let i = 1; i <= MAX_RECORDS + 10; i++) {
      recordOutboundMessage("100", i, `msg ${i}`);
    }
    expect(messageCacheSize()).toBe(MAX_RECORDS);
    // The first 10 are gone...
    expect(lookupMessage("100", 1)).toBeNull();
    expect(lookupMessage("100", 10)).toBeNull();
    // ...the rest survive.
    expect(lookupMessage("100", 11)).not.toBeNull();
    expect(lookupMessage("100", MAX_RECORDS + 10)!.text).toBe(`msg ${MAX_RECORDS + 10}`);
  });

  /* The cap counts CODE POINTS, so every assertion here must count code points
   * too. `.length` is code UNITS and would silently stop measuring the cap the
   * moment astral characters are involved — which is exactly where the
   * truncation bug lives. */
  test("truncates stored text at MAX_TEXT_CHARS (ascii)", () => {
    const huge = "x".repeat(MAX_TEXT_CHARS * 5);
    recordOutboundMessage("100", 1, huge);
    expect(cpLength(lookupMessage("100", 1)!.text)).toBe(MAX_TEXT_CHARS);
  });

  test("truncates astral text on code points, not code units", () => {
    // 5x the cap in emoji: 2 UTF-16 units each, so a code-unit cap would keep
    // only half as many characters as it should.
    recordOutboundMessage("100", 2, EMOJI.repeat(MAX_TEXT_CHARS * 5));
    const stored = lookupMessage("100", 2)!.text;
    expect(cpLength(stored)).toBe(MAX_TEXT_CHARS);
    // ...and the 2x code-unit cost of that is expected, not a bug.
    expect(stored.length).toBe(MAX_TEXT_CHARS * 2);
  });

  test("never severs a surrogate pair at the cap boundary", () => {
    // Emoji straddling the boundary: a code-unit cut keeps its leading
    // surrogate and renders as U+FFFD.
    recordOutboundMessage("100", 3, "a".repeat(MAX_TEXT_CHARS - 1) + EMOJI + "tail");
    const stored = lookupMessage("100", 3)!.text;
    expect(stored.isWellFormed()).toBe(true);
    expect(cpLength(stored)).toBe(MAX_TEXT_CHARS);
    expect(stored.endsWith(EMOJI)).toBe(true);
  });

  test("keeps grapheme-heavy text well-formed (ZWJ, flags)", () => {
    recordOutboundMessage("100", 4, "\u{1F468}‍\u{1F469}‍\u{1F467}".repeat(200));
    recordOutboundMessage("100", 5, "\u{1F1FA}\u{1F1F8}".repeat(400));
    expect(lookupMessage("100", 4)!.text.isWellFormed()).toBe(true);
    expect(lookupMessage("100", 5)!.text.isWellFormed()).toBe(true);
    expect(cpLength(lookupMessage("100", 4)!.text)).toBe(MAX_TEXT_CHARS);
    expect(cpLength(lookupMessage("100", 5)!.text)).toBe(MAX_TEXT_CHARS);
  });

  test("text exactly at the cap in astral chars is NOT truncated", () => {
    const exact = EMOJI.repeat(MAX_TEXT_CHARS);
    recordOutboundMessage("100", 6, exact);
    expect(lookupMessage("100", 6)!.text).toBe(exact);
  });
});

describe("truncateCodePoints", () => {
  test("returns truncated=false when the input is within the cap", () => {
    expect(truncateCodePoints("short", 10)).toEqual({ text: "short", truncated: false });
    expect(truncateCodePoints("", 10).truncated).toBe(false);
  });

  test("astral input at exactly the cap reports truncated=false", () => {
    // The false-ellipsis case: 160 emoji is 160 code points but 320 code units.
    // A code-unit guard would claim it truncated something it did not.
    const exact = EMOJI.repeat(160);
    expect(truncateCodePoints(exact, 160)).toEqual({ text: exact, truncated: false });
  });

  test("one code point past the cap reports truncated=true", () => {
    expect(truncateCodePoints(EMOJI.repeat(161), 160).truncated).toBe(true);
    expect(cpLength(truncateCodePoints(EMOJI.repeat(161), 160).text)).toBe(160);
  });

  /* NOTHING BELOW ASSERTS THE RETENTION PROPERTY, and nothing can.
   *
   * Whether a string is a view onto a parent buffer or a fresh copy is not
   * observable from JS: primitives compare by VALUE, so `===`, `Object.is`, and
   * `toBe` all report true for a view and a copy of the same characters.
   * `p.slice(0,3) === Array.from(p.slice(0,6)).slice(0,3).join("")` is true.
   * There is no assertion to write here — which is precisely why the heap probe
   * had to exist.
   *
   * Measured out of band instead: 200 records sliced from 1 MB parents pinned
   * ~103 MB with `.slice`, ~348 MB once the parents grew to 4 MB (i.e. tracking
   * PARENT size), and stopped tracking parent size once the result was rebuilt
   * via `join`. If you change `truncateCodePoints`, re-run that probe — the
   * suite will stay green either way. */
  test("preserves the value when nothing is truncated", () => {
    const source = "abc";
    const out = truncateCodePoints(source, 100);
    expect(out.text).toBe(source);
    expect(out.truncated).toBe(false);
  });
});

describe("bad input is ignored, never thrown", () => {
  test("blank chat id is not recorded", () => {
    recordOutboundMessage("", 5, "x");
    expect(messageCacheSize()).toBe(0);
  });

  test("non-positive message id is not recorded", () => {
    recordOutboundMessage("100", 0, "x");
    recordOutboundMessage("100", -3, "x");
    expect(messageCacheSize()).toBe(0);
  });

  test("non-finite message id is not recorded", () => {
    recordOutboundMessage("100", NaN, "x");
    recordOutboundMessage("100", Infinity, "x");
    expect(messageCacheSize()).toBe(0);
  });

  test("lookup with a bad key returns null rather than throwing", () => {
    expect(lookupMessage("", 1)).toBeNull();
    expect(lookupMessage("100", 0)).toBeNull();
    expect(lookupMessage("100", NaN)).toBeNull();
  });

  // Empty TEXT is recorded (unlike a bad chat id or message id, which are
  // dropped) — rendering an empty preview is the caller's call, not the
  // cache's. That downstream behavior is asserted in dispatcher.test.ts, not
  // here; this only checks the record survives.
  test("empty text is still recorded", () => {
    recordMessage("100", 1, "in", "");
    expect(lookupMessage("100", 1)!.text).toBe("");
  });
});

describe("resetMessageCache", () => {
  test("clears everything", () => {
    recordOutboundMessage("100", 1, "a");
    recordInboundMessage("100", 2, "b");
    expect(messageCacheSize()).toBe(2);
    resetMessageCache();
    expect(messageCacheSize()).toBe(0);
    expect(lookupMessage("100", 1)).toBeNull();
  });
});
