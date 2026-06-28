import { test, expect, describe } from "bun:test";
import {
  ALLOWED_REACTION_EMOJIS,
  isAllowedReactionEmoji,
  canonicalizeReactionEmoji,
  validateReactionEmoji,
} from "./reactions";

describe("ALLOWED_REACTION_EMOJIS", () => {
  test("contains the common documented reactions", () => {
    for (const e of ["👍", "👎", "🔥", "🎉", "😁", "🤔", "💯"]) {
      expect(ALLOWED_REACTION_EMOJIS.has(e)).toBe(true);
    }
  });

  test("heart is stored in the bare (documented) form", () => {
    // Telegram documents the heart as U+2764 with no variation selector.
    expect(ALLOWED_REACTION_EMOJIS.has("❤")).toBe(true);
  });
});

describe("canonicalizeReactionEmoji", () => {
  test("strips a trailing VS16 when the bare form is documented", () => {
    // "❤️" (heart + VS16) canonicalizes to documented "❤".
    expect(canonicalizeReactionEmoji("❤️")).toBe("❤");
  });

  test("trims surrounding whitespace", () => {
    expect(canonicalizeReactionEmoji("  👍  ")).toBe("👍");
  });

  test("leaves an already-documented emoji untouched", () => {
    expect(canonicalizeReactionEmoji("🔥")).toBe("🔥");
  });

  test("leaves an unknown string as-is (trimmed)", () => {
    expect(canonicalizeReactionEmoji("  zzz ")).toBe("zzz");
  });
});

describe("isAllowedReactionEmoji", () => {
  test("accepts documented emoji", () => {
    expect(isAllowedReactionEmoji("👍")).toBe(true);
    expect(isAllowedReactionEmoji("🎉")).toBe(true);
  });

  test("accepts heart with a variation selector via canonicalization", () => {
    expect(isAllowedReactionEmoji("❤️")).toBe(true);
  });

  test("rejects emoji not in the documented set", () => {
    expect(isAllowedReactionEmoji("🦖")).toBe(false);
    expect(isAllowedReactionEmoji("abc")).toBe(false);
  });
});

describe("validateReactionEmoji", () => {
  test("returns the canonical form on success", () => {
    const r = validateReactionEmoji("👍");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.emoji).toBe("👍");
  });

  test("canonicalizes heart-with-VS16 to the documented form", () => {
    const r = validateReactionEmoji("❤️");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.emoji).toBe("❤");
  });

  test("rejects empty input with a message", () => {
    const r = validateReactionEmoji("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("no emoji");
  });

  test("rejects unsupported emoji and names some supported ones", () => {
    const r = validateReactionEmoji("🦖");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("unsupported");
      expect(r.message).toContain("👍");
    }
  });
});
