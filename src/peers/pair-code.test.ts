import { describe, expect, test } from "bun:test";
import {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_CODE_TTL_MS,
  formatPairCode,
  generatePairCode,
  isPairCodeExpired,
  isWellFormedPairCode,
  normalizePairCode,
  pairCodeExpiresAt,
  pairCodesEqual,
} from "./pair-code";

describe("generatePairCode", () => {
  test("the alphabet is Crockford base32: 32 distinct characters without I, L, O or U", () => {
    expect(PAIR_CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(new Set(PAIR_CODE_ALPHABET).size).toBe(32);
    for (const excluded of "ILOU") expect(PAIR_CODE_ALPHABET).not.toContain(excluded);
  });

  test("real codes are 8 characters, all from the alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairCode();
      expect(code.length).toBe(PAIR_CODE_LENGTH);
      expect(isWellFormedPairCode(code)).toBe(true);
    }
  });

  test("each character is alphabet[byte & 31], so every byte value maps evenly", () => {
    expect(generatePairCode((b) => b.fill(0))).toBe("00000000");
    expect(generatePairCode((b) => b.fill(31))).toBe("ZZZZZZZZ");
    expect(generatePairCode((b) => b.fill(32))).toBe("00000000");
    expect(generatePairCode((b) => b.fill(255))).toBe("ZZZZZZZZ");
    const fixed = (b: Uint8Array) => {
      b.set([0, 1, 10, 17, 18, 100, 200, 223]);
      return b;
    };
    // 100 & 31 = 4, 200 & 31 = 8, 223 & 31 = 31.
    expect(generatePairCode(fixed)).toBe("01AHJ48Z");
  });

  test("draws its bytes from crypto.getRandomValues by default", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePairCode()));
    expect(seen.size).toBeGreaterThan(45);
  });
});

describe("formatPairCode", () => {
  test("shows a code as XXXX-XXXX", () => {
    expect(formatPairCode("ABCD1234")).toBe("ABCD-1234");
  });
});

describe("normalizePairCode", () => {
  test("uppercases and drops dashes and spaces", () => {
    expect(normalizePairCode("abcd-1234")).toBe("ABCD1234");
    expect(normalizePairCode(" ab cd - 12 34 ")).toBe("ABCD1234");
    expect(normalizePairCode("ab\tcd-12\n34")).toBe("ABCD1234");
  });

  test("reads O as 0 and I or L as 1, in either case", () => {
    expect(normalizePairCode("oO-iIlL")).toBe("001111");
    expect(normalizePairCode("hell-owor")).toBe("HE110W0R");
  });

  test("leaves other characters alone, so malformed input stays malformed", () => {
    expect(normalizePairCode("ABCD-123U")).toBe("ABCD123U");
    expect(isWellFormedPairCode(normalizePairCode("ABCD-123U"))).toBe(false);
    expect(isWellFormedPairCode(normalizePairCode("ABCD-123"))).toBe(false);
    expect(isWellFormedPairCode(normalizePairCode("ABCD-12345"))).toBe(false);
    expect(isWellFormedPairCode(normalizePairCode("abcd-l234"))).toBe(true);
  });
});

describe("pairCodesEqual", () => {
  test("equal codes match and different codes do not", () => {
    expect(pairCodesEqual("ABCD1234", "ABCD1234")).toBe(true);
    expect(pairCodesEqual("ABCD1234", "ABCD1235")).toBe(false);
  });

  test("a length mismatch is false rather than a throw", () => {
    expect(pairCodesEqual("ABCD1234", "ABCD123")).toBe(false);
    expect(pairCodesEqual("", "ABCD1234")).toBe(false);
    expect(pairCodesEqual("", "")).toBe(true);
  });
});

describe("expiry", () => {
  test("a code lasts 2 minutes and has expired from that instant on", () => {
    expect(PAIR_CODE_TTL_MS).toBe(120_000);
    const expiresAt = pairCodeExpiresAt(1_000);
    expect(expiresAt).toBe(121_000);
    expect(isPairCodeExpired(expiresAt, 120_999)).toBe(false);
    expect(isPairCodeExpired(expiresAt, 121_000)).toBe(true);
  });
});
