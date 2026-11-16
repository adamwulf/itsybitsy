/**
 * Pairing codes (docs/plans/iroh-peering.md, "Pairing" → "Code" and "Expiry").
 *
 * - 8 characters from the Crockford base32 alphabet, drawn with
 *   `crypto.getRandomValues`: 40 bits. `byte & 31` is unbiased because 256 is
 *   a multiple of 32.
 * - Shown as `XXXX-XXXX`.
 * - Input ignores case, dashes and spaces, and reads O as 0 and I or L as 1.
 * - Compared in constant time.
 * - Valid for 2 minutes, and for one attempt (the responder discards it).
 */

import { timingSafeEqual } from "node:crypto";

export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_CODE_LENGTH = 8;
/** How long a code is valid after it is shown. */
export const PAIR_CODE_TTL_MS = 2 * 60 * 1000;

const WELL_FORMED = new RegExp(`^[${PAIR_CODE_ALPHABET}]{${PAIR_CODE_LENGTH}}$`);

/**
 * A new random code: {@link PAIR_CODE_LENGTH} characters of
 * {@link PAIR_CODE_ALPHABET}. `fillRandom` is injectable for tests.
 */
export function generatePairCode(
  fillRandom: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = fillRandom(new Uint8Array(PAIR_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) code += PAIR_CODE_ALPHABET[byte & 31];
  return code;
}

/** A code as it is shown: `XXXX-XXXX`. */
export function formatPairCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Typed input as a code: uppercased, dashes and spaces dropped, O read as 0, I and L as 1. */
export function normalizePairCode(input: string): string {
  return input.toUpperCase().replace(/[-\s]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Whether a normalized code has the right length and alphabet. */
export function isWellFormedPairCode(code: string): boolean {
  return WELL_FORMED.test(code);
}

/** Constant-time equality of two codes. Codes of different lengths are not equal. */
export function pairCodesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** When a code shown at `shownAt` (epoch ms) stops being valid. */
export function pairCodeExpiresAt(shownAt: number): number {
  return shownAt + PAIR_CODE_TTL_MS;
}

/** Whether a code that expires at `expiresAt` has expired at `now`. */
export function isPairCodeExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}
