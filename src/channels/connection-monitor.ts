/**
 * The `ib watch` side of the Telegram connection state.
 *
 * `ib watch` (src/tui/dashboard.ts) creates one monitor at launch and feeds it
 * the boot's progress; after a successful boot it attaches the dispatcher and
 * outbox. The monitor then:
 *
 *   - derives one {@link TelegramConnectionView} (connection-view.ts) on every
 *     change and hands it to `onChange` (the header light and `?` help row);
 *   - writes it to the status file (connection-status.ts) on every change —
 *     edge-triggered, never per poll — through one promise chain so writes
 *     never interleave, and removes the file on `dispose()` (a clean quit);
 *   - logs the dispatcher's transitions to watch.log, unchanged from before:
 *     `telegram: disconnected (<reason>)` and `telegram: reconnected after Ns`;
 *   - kicks the outbox when the poll loop recovers (retrying → polling), so a
 *     stalled queue is retried at once rather than after its backoff;
 *   - on a wake from sleep (wake-detector.ts) logs `telegram: wake from sleep
 *     detected (slept ~Ns); reconnecting`, makes the dispatcher drop its
 *     in-flight poll or backoff (`reconnectNow`) and kicks the outbox. While
 *     boot is still retrying, boot hears the same wake and cuts its own
 *     backoff short.
 *
 * `refresh()` re-derives from the dispatcher's and outbox's `getHealth()`;
 * `ib watch` also calls it from its 5 s status timer as a backstop for any
 * change that did not fire an event.
 */

import {
  clearTelegramStatus,
  writeTelegramStatus,
  type TelegramConnectionStatus,
} from "./connection-status";
import {
  deriveTelegramConnection,
  disabledReason,
  sameTelegramConnection,
  type TelegramConnectionInputs,
  type TelegramConnectionView,
} from "./connection-view";
import type { DispatcherStateChange, TelegramDispatcher } from "./dispatcher";
import type { OutboxHealth, TelegramOutbox } from "./outbox";
import type { WakeEvent, WakeSource } from "./wake-detector";

export interface ConnectionMonitorOptions {
  /** watch.log sink. */
  log: (line: string) => void;
  /** Called with each new view (not with repeats). */
  onChange?: (view: TelegramConnectionView) => void;
  /** Wake-from-sleep events. */
  wake?: WakeSource;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** pid recorded in the status file. Defaults to `process.pid`. */
  pid?: number;
  /** Status file writer. Defaults to `writeTelegramStatus`. */
  writeStatus?: (status: TelegramConnectionStatus) => Promise<void>;
  /** Status file remover. Defaults to `clearTelegramStatus`. */
  clearStatus?: (ownerPid: number) => Promise<void>;
}

/** Boot progress; `running` carries what boot built. */
type BootPhase =
  | { phase: "connecting"; lastError: string | null; lastErrorAt: number | null }
  | { phase: "disabled"; reason: string; at: number }
  | { phase: "running"; dispatcher: TelegramDispatcher; outbox: TelegramOutbox };

export class TelegramConnectionMonitor {
  private readonly log: (line: string) => void;
  private readonly onChange: ((view: TelegramConnectionView) => void) | undefined;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly writeStatus: (status: TelegramConnectionStatus) => Promise<void>;
  private readonly clearStatus: (ownerPid: number) => Promise<void>;

  private boot: BootPhase = { phase: "connecting", lastError: null, lastErrorAt: null };
  private dispatcherStarted = false;
  /** When the outbox's current stall label first appeared. See
   *  `outboxHealth()`. */
  private outboxErrorSince: { label: string; at: number | null } | null = null;
  private readonly unsubscribes: Array<() => void> = [];
  private current: TelegramConnectionView | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private disposing: Promise<void> | null = null;

  constructor(opts: ConnectionMonitorOptions) {
    this.log = opts.log;
    this.onChange = opts.onChange;
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
    this.writeStatus = opts.writeStatus ?? writeTelegramStatus;
    this.clearStatus = opts.clearStatus ?? clearTelegramStatus;
    if (opts.wake) this.unsubscribes.push(opts.wake.onWake((event) => this.handleWake(event)));
  }

  /** The last published view, or null before the first `refresh()`. */
  view(): TelegramConnectionView | null {
    return this.current;
  }

  /** Boot hit a transient failure and is backing off (`BootOptions.onRetry`).
   *  A repeat of the same reason keeps its first time. */
  bootRetry(reason: string): void {
    const prev = this.boot;
    const at = prev.phase === "connecting" && prev.lastError === reason ? prev.lastErrorAt : this.now();
    this.boot = { phase: "connecting", lastError: reason, lastErrorAt: at };
    this.refresh();
  }

  /** Boot returned ok:false. `message` is `BootDisabled.message`. */
  bootDisabled(message: string): void {
    this.boot = { phase: "disabled", reason: disabledReason(message), at: this.now() };
    this.refresh();
  }

  /** Boot succeeded. Call before starting either, so no transition is missed. */
  attach(dispatcher: TelegramDispatcher, outbox: TelegramOutbox): void {
    this.boot = { phase: "running", dispatcher, outbox };
    this.unsubscribes.push(dispatcher.onStateChange((change) => this.handleDispatcherChange(change)));
    this.unsubscribes.push(outbox.onHealthChange(() => this.refresh()));
    this.refresh();
  }

  /** The dispatcher's `start()` settled. Until then a `down` dispatcher is
   *  still connecting; after, `down` means it will not poll (disabled). */
  dispatcherStartSettled(): void {
    this.dispatcherStarted = true;
    this.refresh();
  }

  /** Re-derive the view and publish it if it changed. */
  refresh(): void {
    if (this.disposing !== null) return;
    const view = deriveTelegramConnection(this.inputs());
    if (sameTelegramConnection(view, this.current)) return;
    this.current = view;
    try {
      this.onChange?.(view);
    } catch (err) {
      this.log(`telegram: status listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.queueWrite(view);
  }

  /** Settles once every status write queued so far has finished. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /** Clean quit: stop listening and publishing, wait for queued writes, then
   *  remove the status file (only if this process wrote it). Idempotent. */
  dispose(): Promise<void> {
    if (this.disposing !== null) return this.disposing;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.disposing = (async () => {
      await this.writeChain;
      try {
        await this.clearStatus(this.pid);
      } catch (err) {
        this.log(`telegram: status file remove failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return this.disposing;
  }

  private inputs(): TelegramConnectionInputs {
    if (this.boot.phase !== "running") return this.boot;
    return {
      phase: "running",
      dispatcherStarted: this.dispatcherStarted,
      dispatcher: this.boot.dispatcher.getHealth(),
      outbox: this.outboxHealth(this.boot.outbox),
    };
  }

  /** The outbox's health with `lastErrorAt` pinned to when its current
   *  `lastError` label first appeared. The outbox refreshes `lastErrorAt` on
   *  every stall retry without firing `onHealthChange`; passed through, every
   *  backstop `refresh()` during a stall would publish (and write) a new view
   *  and the help panel's age would restart at each retry. Pinned, a stall
   *  reads like the dispatcher's `reasonAt`: "HTTP 502 (40s ago)" since the
   *  stall began. */
  private outboxHealth(outbox: TelegramOutbox): OutboxHealth {
    const health = outbox.getHealth();
    if (health.lastError === null) {
      this.outboxErrorSince = null;
      return health;
    }
    if (this.outboxErrorSince === null || this.outboxErrorSince.label !== health.lastError) {
      this.outboxErrorSince = { label: health.lastError, at: health.lastErrorAt };
    }
    return { ...health, lastErrorAt: this.outboxErrorSince.at };
  }

  /** The outbox, once boot succeeded. */
  private attachedOutbox(): TelegramOutbox | null {
    return this.boot.phase === "running" ? this.boot.outbox : null;
  }

  private handleDispatcherChange(change: DispatcherStateChange): void {
    // The initial down → polling (reason null) and the stop's → down are
    // silent: boot already logged the connect, and a stop is normal.
    if (change.to === "retrying" && change.reason !== null) {
      this.log(`telegram: disconnected (${change.reason})`);
    } else if (change.to === "polling" && change.reason !== null) {
      this.log(`telegram: ${change.reason}`);
    }
    // The poll loop reached Telegram again: retry a stalled outbox now.
    if (change.from === "retrying" && change.to === "polling") this.attachedOutbox()?.kick();
    this.refresh();
  }

  private handleWake(event: WakeEvent): void {
    if (this.disposing !== null || this.boot.phase === "disabled") return;
    const seconds = Math.round(event.sleptMs / 1_000);
    this.log(`telegram: wake from sleep detected (slept ~${seconds}s); reconnecting`);
    if (this.boot.phase === "running") {
      this.boot.dispatcher.reconnectNow("wake from sleep");
      this.boot.outbox.kick();
    }
  }

  private queueWrite(view: TelegramConnectionView): void {
    const status: TelegramConnectionStatus = { ...view, pid: this.pid, updatedAt: this.now() };
    this.writeChain = this.writeChain
      .then(() => this.writeStatus(status))
      .catch((err: unknown) => {
        this.log(`telegram: status file write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}
