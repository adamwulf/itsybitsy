/**
 * Wake-from-sleep detector for the Telegram connection in `ib watch`.
 *
 * Timers do not advance while macOS sleeps, so after a wake the poll loop can
 * still be sitting in a 30 s backoff, or waiting out a 35 s fetch timeout on a
 * socket that died with the old network. The wall clock (`Date.now()`) does
 * advance. This detector runs a short interval and compares wall-clock time
 * between ticks: a gap far beyond the interval means the process was not
 * running, i.e. the machine slept. Listeners then reconnect at once instead of
 * waiting the old timers out (connection-monitor.ts, boot.ts).
 *
 * A wall-clock jump (NTP correction, a manual clock change) or an event-loop
 * stall longer than the slack looks the same and also fires. That costs one
 * needless reconnect, which is harmless. A backwards jump never fires.
 *
 * The clock and the timer are injectable for tests. The default timer is
 * `unref`'d, so the detector never keeps a process alive on its own; `stop()`
 * clears it.
 */

/** One detected wake. `sleptMs` is the wall-clock gap minus one interval. */
export interface WakeEvent {
  sleptMs: number;
}

export type WakeListener = (event: WakeEvent) => void;

/** What a consumer needs: a way to hear about wakes. Boot and the connection
 *  monitor take this instead of the class so tests can pass a fake. */
export interface WakeSource {
  /** Subscribe; returns an unsubscribe function. */
  onWake(listener: WakeListener): () => void;
}

/** Injectable interval timer. */
export interface WakeTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WakeDetectorOptions {
  /** How often to compare clocks. Default 5 s. */
  intervalMs?: number;
  /** A gap longer than `intervalMs + slackMs` counts as a wake. Default 15 s. */
  slackMs?: number;
  /** Wall clock. Default `Date.now`. */
  now?: () => number;
  /** Interval timer. Default: `setInterval`, unref'd. */
  timer?: WakeTimer;
  /** Where a throwing listener is reported. Default: dropped. */
  log?: (line: string) => void;
}

export const WAKE_INTERVAL_MS = 5_000;
export const WAKE_SLACK_MS = 15_000;

const defaultTimer: WakeTimer = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export class WakeDetector implements WakeSource {
  private readonly intervalMs: number;
  private readonly slackMs: number;
  private readonly now: () => number;
  private readonly timer: WakeTimer;
  private readonly log: (line: string) => void;
  private readonly listeners: Set<WakeListener> = new Set();
  private handle: unknown = null;
  private lastTickAt = 0;

  constructor(opts: WakeDetectorOptions = {}) {
    this.intervalMs = opts.intervalMs ?? WAKE_INTERVAL_MS;
    this.slackMs = opts.slackMs ?? WAKE_SLACK_MS;
    this.now = opts.now ?? Date.now;
    this.timer = opts.timer ?? defaultTimer;
    this.log = opts.log ?? (() => {});
  }

  /** Start ticking. A second call is a no-op. */
  start(): void {
    if (this.handle !== null) return;
    this.lastTickAt = this.now();
    this.handle = this.timer.setInterval(() => this.tick(), this.intervalMs);
  }

  /** Stop ticking. Safe to call when not started. */
  stop(): void {
    if (this.handle === null) return;
    this.timer.clearInterval(this.handle);
    this.handle = null;
  }

  onWake(listener: WakeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private tick(): void {
    const at = this.now();
    const gap = at - this.lastTickAt;
    this.lastTickAt = at;
    if (gap <= this.intervalMs + this.slackMs) return;
    const event: WakeEvent = { sleptMs: gap - this.intervalMs };
    // Copy so a listener that unsubscribes itself does not skip the next one.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.log(`wake detector: listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
