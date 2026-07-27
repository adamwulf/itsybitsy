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
  MAX_RECORDS,
  MAX_TEXT_CHARS,
} from "./message-cache";

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

  test("numeric chat id looks up the same as its string form", () => {
    recordOutboundMessage(String(100), 7, "x");
    expect(lookupMessage("100", 7)).not.toBeNull();
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

  test("truncates stored text at MAX_TEXT_CHARS", () => {
    const huge = "x".repeat(MAX_TEXT_CHARS * 5);
    recordOutboundMessage("100", 1, huge);
    expect(lookupMessage("100", 1)!.text.length).toBe(MAX_TEXT_CHARS);
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

  test("empty text records fine — an empty preview is the caller's problem", () => {
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
