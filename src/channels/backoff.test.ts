import { test, expect, describe, afterEach } from "bun:test";
import { backoffDelayMs, randomCtx } from "./backoff";

describe("backoffDelayMs", () => {
  afterEach(() => randomCtx.reset());

  test("doubles per attempt and caps at maxMs (no jitter draw)", () => {
    randomCtx.set(() => 0);
    const opts = { initialMs: 1_000, maxMs: 30_000 };
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelayMs(a, opts))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  test("jitter lowers the delay by at most the jitter fraction", () => {
    randomCtx.set(() => 0.999999);
    expect(backoffDelayMs(1, { initialMs: 1_000, maxMs: 30_000 })).toBe(800);
    expect(backoffDelayMs(10, { initialMs: 1_000, maxMs: 30_000, jitter: 0.5 })).toBe(15_000);
  });

  test("never exceeds maxMs and never goes negative", () => {
    for (const r of [0, 0.3, 0.7, 0.999]) {
      randomCtx.set(() => r);
      for (let a = 1; a < 200; a++) {
        const d = backoffDelayMs(a, { initialMs: 500, maxMs: 60_000, jitter: 1 });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(60_000);
      }
    }
  });

  test("attempt below 1 is treated as attempt 1", () => {
    randomCtx.set(() => 0);
    expect(backoffDelayMs(0, { initialMs: 1_000, maxMs: 30_000 })).toBe(1_000);
  });
});
