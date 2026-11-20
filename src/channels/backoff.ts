/**
 * Capped exponential backoff with jitter, shared by every Telegram retry loop:
 * the inbound `getUpdates` loop (telegram-client.ts), the boot probe retry
 * (boot.ts) and the outbox's stalled-queue retry (outbox.ts).
 *
 * Jitter matters because every one of those loops wakes on the same event (a
 * network drop, or a laptop waking from sleep); without it they retry in
 * lockstep. The delay is drawn uniformly from
 * `[base * (1 - jitter), base]`, where `base = min(initialMs * 2^(attempt-1),
 * maxMs)`. The upper bound never exceeds `maxMs`, so the cap stays a cap.
 */

import { InjectionContext } from "../types";

/** Injectable random source in [0, 1). Tests pin it so delays are exact. */
export const randomCtx = new InjectionContext<() => number>(Math.random);

export interface BackoffOptions {
  /** Delay for attempt 1, before jitter. */
  initialMs: number;
  /** Upper bound on the delay, before and after jitter. */
  maxMs: number;
  /** Fraction of the delay that is randomized, 0..1. Default 0.2: attempt 1 of
   *  a 1 s backoff waits between 0.8 s and 1 s. */
  jitter?: number;
}

/** Delay before retry number `attempt` (1-indexed). Attempt 1 → ~initialMs,
 *  doubling each attempt, capped at `maxMs`, then jittered downward. */
export function backoffDelayMs(attempt: number, opts: BackoffOptions): number {
  const n = Math.max(1, Math.floor(attempt));
  const jitter = Math.min(1, Math.max(0, opts.jitter ?? 0.2));
  // 2 ** 60 already dwarfs any cap; clamp the exponent so a very long streak
  // cannot overflow to Infinity.
  const base = Math.min(opts.initialMs * 2 ** Math.min(n - 1, 60), opts.maxMs);
  const r = Math.min(1, Math.max(0, randomCtx.fn()));
  return Math.round(base * (1 - jitter * r));
}
