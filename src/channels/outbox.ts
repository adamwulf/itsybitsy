/**
 * Telegram outbox — file-drop queue between `ib tgsend` (per-shell process)
 * and `ib watch` (long-running TUI).
 *
 * `ib tgsend` does not talk to Telegram. It writes the message to a directory
 * and waits a few seconds for a result file. `ib watch` watches that directory,
 * sends every queued item to Telegram, and writes back a result file.
 *
 * Layout under `~/.itsybitsy/channels/telegram/outbox/` (`<base>` is the full
 * dropped filename, e.g. `<unix-ms>-<6-hex-rand>.txt`):
 *
 *   - `<stem>.txt`              — message text (UTF-8)
 *   - `<stem>.react.json`       — reaction descriptor (see below)
 *   - `<stem>.file.json`        — file-send descriptor (see below)
 *   - `<base>.tmp`              — partial write by the client (cleaned on sweep)
 *   - `<base>.result`           — JSON written by us (see "Result file")
 *   - `<base>.progress`         — JSON `{sent, message_ids}`: how many chunks of
 *                                 a multi-chunk text are already delivered
 *
 * A reaction descriptor is JSON `{ message_id: number, emoji: string | null }`
 * dropped by `ib tgreact`; we call `client.setMessageReaction` for it (a null
 * emoji clears the bot's reaction).
 *
 * A file descriptor is JSON `{ path: string, caption?: string, kind: "photo" |
 * "document" }` dropped by `ib tgsendfile`; we call `client.sendPhoto` /
 * `client.sendDocument` for it (multipart upload of the local file at `path`).
 *
 * Delivery rules:
 *
 *   - Strict FIFO in filename order (filenames start with `<unix-ms>`) across
 *     texts, reactions and files. One drain loop sends one item at a time.
 *   - A failure is TRANSIENT (fetch throw, status 0, 429, 5xx — see
 *     `isTransientStatus`) or PERMANENT (any other 4xx, or a local validation
 *     failure: empty text, bad descriptor, file missing/unreadable/too large).
 *   - A transient failure is retried inline, up to {@link INLINE_ATTEMPTS}
 *     attempts per API call, with capped backoff (`backoffDelayMs`; on a 429 the
 *     wait is at least the server's `retry_after`, and a `retry_after` above
 *     the inline cap stalls the queue at once instead of sleeping inline).
 *   - When the inline retries are exhausted the item STAYS ON DISK, the outbox
 *     is marked stalled (`getHealth()`), and the queue is held: no later item is
 *     sent before it. The head is retried forever with capped, jittered backoff
 *     ({@link STALL_BACKOFF}), or right away on `kick()`. The stall is logged
 *     once per streak; the first answer from Telegram ends it (one
 *     `send recovered` line) and the queue keeps draining in order.
 *   - A permanent failure writes `{ok:false}` and the item is cleaned up, as
 *     before; the queue moves on.
 *   - Reading the item file: only ENOENT means it is gone. Any other read
 *     error (EMFILE, EACCES, EIO) holds the item like a transient failure.
 *   - An upload (`sendPhoto`/`sendDocument`) whose inline attempts ALL time
 *     out fails permanently: it cannot finish on this link, and holding it
 *     would block every later item.
 *   - A stalled head that leaves the queue without a Telegram answer (gone,
 *     revalidation failed, upload timed out) ends the stall too.
 *
 * No duplicates:
 *
 *   - A multi-chunk text records its progress in `<base>.progress` (atomic
 *     write after every delivered chunk). A retry, in-process or after an
 *     `ib watch` restart, resumes after the last delivered chunk, and the final
 *     result lists the message ids of every chunk across resumes.
 *   - An item stays in `known` until its `.result` is unlinked, and rescans
 *     are serialized, so a rescan can never re-enqueue an item that is being
 *     cleaned up (the old `failed to read <stem>.txt: ENOENT` 5s after a send).
 *   - `known` also stops fs.watch, the safety rescan and the startup sweep from
 *     enqueuing one item twice; `kick()` and the stall timer only wake the
 *     single drain loop, they never enqueue.
 *   - CAVEAT: a request that times out AFTER Telegram received it is still
 *     retried, and `sendMessage` has no idempotency key, so that one case can
 *     deliver a message twice. We accept a rare duplicate over a lost message.
 *
 * Result file. A final result is `{ok, message}`. The `message` of a text send
 * echoes the Telegram message id(s) — `ok (message_id 1584)`, or `ok (3 parts,
 * message_ids 1584, 1585, 1586)` for a chunked send. `ib tgsend` prints that
 * string verbatim, so the coordinator has the id in its own conversation history
 * next to the text it sent and can correlate a later reaction with no cache and
 * across an `ib watch` restart. When no id can be determined (a 2xx body with
 * no `result`), the message degrades to `ok` / `ok (N parts)`. See
 * `formatSendOk`.
 *
 * On the first transient failure of an item we also write an INTERIM result
 * `{ok:true, queued:true, message:"queued: ..."}` so a waiting client can say
 * why the item has not gone out yet. The interim result never ends the item: the
 * final result overwrites it later, and only a final result schedules cleanup.
 * Clients keep polling past an interim result and report it only if no final
 * result arrives in their wait window.
 *
 * Each sent chunk is also recorded in the in-memory `message-cache` so the
 * dispatcher can render a text preview when the user reacts to it. That cache
 * is memory-only and best-effort — nothing about it can fail or alter a send.
 *
 * Atomic writes use `<path>.tmp` + `rename`. When an item finishes, its final
 * result is written and the item and its `.progress` are unlinked at once, so
 * a crash or restart can never send it again; the `.result` is kept for ~5s
 * so the sender process can read it, then unlinked.
 *
 * On `start()` we sweep the directory: an item whose `.result` is final was
 * already finished and is unlinked, not sent; stale `.tmp`/`.result` files are
 * unlinked, a `.progress` whose item is gone is unlinked (a `.progress` beside a
 * queued item is kept), and every queued item is enqueued in filename order.
 * Then we install an `fs.watch` plus a 0.5s safety rescan.
 */

import { join } from "path";
import { userHome } from "../home";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { readdirSync, watch, type FSWatcher } from "node:fs";
import type { TelegramClient } from "./telegram-client";
import { classifyError, isAbortError, isTransientStatus, sleepCtx } from "./telegram-client";
import { backoffDelayMs, type BackoffOptions } from "./backoff";
import { recordOutboundMessage } from "./message-cache";

let overrideOutboxDir: string | undefined;

/** Override the outbox directory. Tests use this to point at a tmpdir. */
export function setOutboxDir(dir: string): void {
  overrideOutboxDir = dir;
}

/** Reset the outbox directory override. Tests call this in afterEach. */
export function resetOutboxDir(): void {
  overrideOutboxDir = undefined;
}

/** Resolve the active outbox directory. Honors `setOutboxDir` for tests; in
 *  production it lives under `$HOME/.itsybitsy/channels/telegram/outbox`. */
export function defaultOutboxDir(): string {
  return (
    overrideOutboxDir ??
    join(userHome(), ".itsybitsy", "channels", "telegram", "outbox")
  );
}

export interface OutboxOptions {
  client: TelegramClient;
  /** Resolved chat id from the boot's step 2. The outbox sends every queued
   *  message to this chat — `ib tgsend` is single-target by design. */
  chatId: string;
  /** Log sink — defaults to stderr. Tests inject a capture array. */
  log?: (line: string) => void;
  /** Backoff between retries of a stalled head item. Defaults to
   *  {@link STALL_BACKOFF}. Tests set a long one (only `kick()` retries) or a
   *  short one (the timer retries quickly). Uses a real timer, not `sleepCtx`,
   *  so a fast-forwarded `sleepCtx` cannot turn the stall into a busy loop. */
  stallBackoff?: BackoffOptions;
}

const DEFAULT_LOG = (line: string): void => {
  process.stderr.write(line + "\n");
};

/** Outbound connection health, read by `ib watch` for the header light, the
 *  `?` help Telegram row and the status file (connection-status.ts). */
export interface OutboxHealth {
  /** Queued items (texts, reactions, files) not yet delivered, including the
   *  one being sent. */
  pending: number;
  /** True while the head item failed transiently and the queue is waiting to
   *  retry it (later items wait behind it to keep send order). */
  stalled: boolean;
  /** Token-safe label of the transient failure that stalled the queue (e.g.
   *  `HTTP 502`, `errno:ETIMEDOUT`), or null once Telegram answers again (or
   *  the stalled item leaves the queue without an answer). Inline retries
   *  that recover on their own do not set it. */
  lastError: string | null;
  /** Epoch ms of `lastError`, or null. */
  lastErrorAt: number | null;
}

export type OutboxHealthChangeFn = (health: OutboxHealth) => void;

/** Time to keep a final `.result` file around after writing it, so `tgsend`
 *  (a separate process) has a window to read it before we clean up. */
const RESULT_RETENTION_MS = 5_000;

/** Periodic safety rescan. fs.watch on macOS occasionally drops events
 *  (especially on rapid create+rename), so we poll the dir at this cadence
 *  as a backup. The poll is cheap — readdir on a normally-empty dir. */
const SAFETY_RESCAN_MS = 500;

/** Attempts per Bot API call before the item stalls the queue. 3 rides out
 *  short 502 bursts and a single timed-out request without holding a healthy
 *  queue long. (The `errno:23` lines in watch.log 2026-11-20 were not fast
 *  socket errors: they were sends that hung for the full `sendMessageMs` on a
 *  pooled keep-alive socket that died while idle, labelled by the timeout's
 *  DOMException code. The client now opens a fresh connection per outbound
 *  call — see `OUTBOUND_FETCH_INIT` in telegram-client.ts — and `classifyError`
 *  labels a timeout `errno:ETIMEDOUT`.) */
export const INLINE_ATTEMPTS = 3;

/** Delays between inline attempts: ~1s, then ~2s (cap 8s). */
export const INLINE_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 8_000 };

/** Delays between retries of a stalled head: ~2s doubling to a 60s cap, with
 *  jitter so the outbox and the poll loop do not retry in lockstep. */
export const STALL_BACKOFF: BackoffOptions = { initialMs: 2_000, maxMs: 60_000 };

/** Failure shape every client send method returns (sendMessage,
 *  setMessageReaction, sendPhoto, sendDocument). */
interface ClientFailure {
  ok: false;
  status: number;
  error_code?: number;
  description?: string;
  retryAfterSec: number | null;
  /** sendPhoto/sendDocument: the fetch throw was the client's own timer. */
  timedOut?: boolean;
}

/** One failed Bot API call, normalized. */
interface CallFailure {
  ok: false;
  /** Worth retrying: fetch throw, status 0, 429 or 5xx. */
  transient: boolean;
  /** This attempt got no answer before the client's own timeout fired. */
  timedOut: boolean;
  /** Set by `callWithRetry`: all {@link INLINE_ATTEMPTS} attempts timed
   *  out. An upload that times out every time cannot finish on this link
   *  and fails permanently rather than holding the queue forever. */
  everyAttemptTimedOut?: boolean;
  /** Short token-safe label for health and the status file: `HTTP 502`,
   *  `errno:ETIMEDOUT`, `errno:ConnectionRefused`. */
  label: string;
  /** Per-item message, e.g. `sendMessage failed: Bad Gateway`. Written to the
   *  result file on a permanent failure and to the log. */
  message: string;
  retryAfterSec: number | null;
}

type CallResult<R> = { ok: true; value: R } | CallFailure;

/** What processing one item came to. `finished` = a final result was written
 *  (sent, or failed permanently); `vanished` = the item file is gone;
 *  `transient` = inline retries exhausted (or the item could not be read),
 *  the item stays queued; `interrupted` = `stop()` was called between
 *  chunks. */
type ItemOutcome =
  | { kind: "finished" }
  | { kind: "vanished" }
  | { kind: "transient"; failure: CallFailure }
  | { kind: "interrupted" };

/** Reading an item file: its content, gone (ENOENT), or a read error that
 *  says nothing about whether the item is still there (EMFILE, EACCES, EIO,
 *  ...), which holds the item like a transient send failure. */
type ItemRead =
  | { kind: "ok"; content: string }
  | { kind: "vanished" }
  | { kind: "transient"; failure: CallFailure };

/** Persisted progress of a multi-chunk text (`<base>.progress`). */
interface TextProgress {
  /** Chunks already delivered, from the start. */
  sent: number;
  /** Message ids of the delivered chunks (best-effort; may be shorter than
   *  `sent`, see `noteSentChunk`). */
  message_ids: number[];
}

/** The `queued:` message for an item held back by a transient failure. Shared
 *  by the outbox's interim result and the `ib tgsend` status-file fallback so
 *  both say the same thing. */
export function queuedTelegramUnreachable(label: string | null): string {
  if (label !== null && /\b429\b/.test(label)) {
    return `queued: Telegram is rate-limiting this bot (${label}); ib watch will send it automatically when the limit clears`;
  }
  const why = label !== null && label !== "" ? ` (${label})` : "";
  return `queued: Telegram is unreachable${why}; ib watch will send it automatically when the connection recovers`;
}

/** TelegramOutbox — owns the directory watch and the serialized send queue.
 *  Construction does no I/O; call `start()` and `stop()` to control the
 *  lifecycle. */
export class TelegramOutbox {
  private readonly client: TelegramClient;
  private readonly chatId: string;
  private readonly log: (line: string) => void;
  private readonly dir: string;
  private readonly stallBackoff: BackoffOptions;

  /** Items not yet delivered, in filename order. `queue[0]` is the head: the
   *  item being sent, or the stalled item being retried. */
  private readonly queue: string[] = [];

  /** Every item we track: queued, being sent, or finished and waiting for its
   *  cleanup timer. An item leaves this set only after its files are unlinked,
   *  so a rescan can never enqueue it twice. */
  private readonly known: Set<string> = new Set();

  /** True while the drain loop runs. Set and cleared synchronously so an
   *  enqueue never sees a loop that is about to exit. */
  private drainRunning = false;
  /** The running drain loop, awaited by `stop()`. */
  private drainDone: Promise<void> = Promise.resolve();

  /** Serialized rescans. A rescan that starts while one runs sets
   *  `rescanAgain` and returns; the running one loops once more. */
  private rescanRunning = false;
  private rescanAgain = false;
  /** Items cleaned up while a rescan was running. A rescan's readdir may have
   *  listed them before the unlink, so they stay in `known` until it ends. */
  private readonly forgetAfterRescan: string[] = [];

  /** Active cleanup timeouts, keyed by the dropped filename. `stop()` clears
   *  these and unlinks immediately rather than leaving stale files for the
   *  next startup sweep — we wrote them, we know exactly what to clean. */
  private readonly cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** fs.watch handle. Created in `start()`, closed in `stop()`. */
  private watcher: FSWatcher | null = null;

  /** setInterval handle for the safety rescan. Cleared in `stop()`. */
  private rescanTimer: ReturnType<typeof setInterval> | null = null;

  /** Set to true once `start()` returns, false at `stop()`. */
  private started = false;

  /** Resolved by `stop()` so an inline retry wait ends at once. */
  private stopSignal: Promise<void> = new Promise(() => {});
  private resolveStop: () => void = () => {};

  /** Ends the current stall wait early (`kick()` and `stop()`). Null while
   *  the drain loop is not waiting out a stall. */
  private wakeStall: (() => void) | null = null;

  /** Retries of the stalled head so far in this streak (drives the backoff).
   *  0 when not stalled. */
  private stallStreak = 0;

  /** Epoch ms before which `kick()` must not retry: a 429's `retry_after`. */
  private retryNotBefore = 0;

  /** The item an interim `queued:` result was written for, so it is written
   *  once per item rather than once per failed attempt. */
  private interimWrittenFor: string | null = null;

  private health: OutboxHealth = { pending: 0, stalled: false, lastError: null, lastErrorAt: null };

  /** Listeners for {@link onHealthChange}. */
  private readonly healthListeners: Set<OutboxHealthChangeFn> = new Set();

  constructor(opts: OutboxOptions) {
    this.client = opts.client;
    this.chatId = String(opts.chatId);
    this.log = opts.log ?? DEFAULT_LOG;
    this.stallBackoff = opts.stallBackoff ?? STALL_BACKOFF;
    // Snapshot the dir at construction time so a mid-run setOutboxDir() in
    // tests doesn't shift our target. Same convention as boot.ts captures
    // the chat id once.
    this.dir = defaultOutboxDir();
  }

  /** Snapshot of outbound health. */
  getHealth(): OutboxHealth {
    return { ...this.health };
  }

  /** Subscribe to health changes. Fires only when `pending`, `stalled` or
   *  `lastError` change. Returns an unsubscribe function. */
  onHealthChange(callback: OutboxHealthChangeFn): () => void {
    this.healthListeners.add(callback);
    return () => {
      this.healthListeners.delete(callback);
    };
  }

  /** The connection looks healthy again (the poll loop recovered, or the
   *  machine woke from sleep): retry a stalled head item now instead of
   *  waiting out its backoff. No-op unless the head is stalled and waiting, or
   *  while a 429's `retry_after` has not yet passed. */
  kick(): void {
    if (!this.health.stalled || this.wakeStall === null) return;
    if (Date.now() < this.retryNotBefore) return;
    this.wakeStall();
  }

  /** Run the startup sweep and install the fs.watch. Returns once the watcher
   *  is established; queued items are already being sent. */
  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.dir, { recursive: true });
    this.stopSignal = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
    await this.sweep();
    // Install the watcher AFTER the sweep so any file that appears during
    // the sweep window is also picked up by the rescan path below.
    this.watcher = watch(this.dir, (eventType) => {
      if (eventType !== "rename") return;
      // macOS sometimes fires rename with no filename. Either way, rescan
      // the dir and pick up any unseen items. Cheap — readdir on a small dir.
      void this.rescan();
    });
    // Backup poll: fs.watch on macOS can silently drop a rename event when
    // the create + rename of `.tmp` → `.txt` happens within the same
    // kernel tick. Poll the dir on a coarse cadence so a missed event
    // results in at most a 0.5s delay rather than a stuck queue.
    this.rescanTimer = setInterval(() => {
      void this.rescan();
    }, SAFETY_RESCAN_MS);
    this.started = true;
    this.ensureDraining();
  }

  /** Close the watcher, end any retry wait, and let the in-flight request
   *  finish. Unfinished items stay on disk for the next start. Caller wraps in
   *  a 2s timeout race (mirrors dispatcher.stop). */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.resolveStop();
    this.wakeStall?.();
    // Finished items first: the in-flight request can outlast the caller's
    // 2s race (a hung send waits out its timeout), and the process may exit
    // before it settles.
    await this.cleanupFinished();
    try {
      await this.drainDone;
    } catch {
      /* swallow — the loop logs its own errors */
    }
    // Anything that finished while we waited.
    await this.cleanupFinished();
  }

  /** Cancel the pending cleanup timeouts and unlink those items' files now.
   *  We wrote their results ourselves; the sender process either already
   *  read the result or has given up by now. */
  private async cleanupFinished(): Promise<void> {
    const timers = Array.from(this.cleanupTimers.entries());
    this.cleanupTimers.clear();
    for (const [base, timer] of timers) {
      clearTimeout(timer);
      await this.cleanupItem(base);
    }
  }

  /** Sweep the outbox dir at startup. Drops leftover `.tmp` / `.result` files
   *  and any `.progress` whose item is gone, then enqueues every queued item.
   *  A `.progress` beside a queued item is kept: it is how a restarted
   *  `ib watch` resumes a multi-chunk text without resending chunks. An item
   *  whose `.result` is FINAL (not the interim `queued` one) was already
   *  finished — the previous run stopped between writing the result and
   *  unlinking the item — so it is unlinked, never sent again. */
  private async sweep(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    entries.sort();
    const present = new Set(entries);
    const done = new Set<string>();
    for (const entry of entries) {
      if (isQueuedFile(entry) && present.has(`${entry}.result`) && (await this.hasFinalResult(entry))) {
        done.add(entry);
      }
    }
    for (const entry of entries) {
      if (entry.endsWith(".tmp") || entry.endsWith(".result")) {
        await unlinkSafe(join(this.dir, entry));
        continue;
      }
      if (entry.endsWith(".progress")) {
        const item = entry.slice(0, -".progress".length);
        if (!present.has(item) || done.has(item)) {
          await unlinkSafe(join(this.dir, entry));
        }
        continue;
      }
      if (!isQueuedFile(entry)) continue;
      if (done.has(entry)) {
        this.log(`telegram outbox: ${entry} already finished before the restart; not sending it again`);
        await unlinkSafe(join(this.dir, entry));
        continue;
      }
      this.enqueue(entry);
    }
  }

  /** True when `<base>.result` holds a final result (one without
   *  `queued: true`). An unreadable or malformed result is not final. */
  private async hasFinalResult(base: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, `${base}.result`), "utf8")) as Record<string, unknown>;
      return typeof parsed.ok === "boolean" && parsed.queued !== true;
    } catch {
      return false;
    }
  }

  /** Re-scan the dir on a rename event or the safety timer. Skips items we
   *  already track. Serialized: a scan requested while one runs makes the
   *  running one go round again. */
  private async rescan(): Promise<void> {
    if (this.rescanRunning) {
      this.rescanAgain = true;
      return;
    }
    this.rescanRunning = true;
    try {
      do {
        this.rescanAgain = false;
        let entries: string[];
        try {
          entries = await readdir(this.dir);
        } catch {
          return;
        }
        if (!this.started) return;
        entries.sort();
        for (const entry of entries) {
          if (isQueuedFile(entry)) this.enqueue(entry);
        }
      } while (this.rescanAgain);
    } finally {
      this.rescanRunning = false;
      for (const base of this.forgetAfterRescan.splice(0)) this.known.delete(base);
    }
  }

  /** Track a newly seen item and make sure the drain loop runs. Idempotent:
   *  an item already in `known` is ignored. */
  private enqueue(base: string): void {
    if (this.known.has(base)) return;
    this.known.add(base);
    // Keep the queue in filename order, but never ahead of the head while
    // the drain loop is working on it.
    const floor = this.drainRunning ? 1 : 0;
    let i = this.queue.length;
    while (i > floor && this.queue[i - 1]! > base) i--;
    this.queue.splice(i, 0, base);
    this.setHealth({ pending: this.queue.length });
    this.ensureDraining();
  }

  /** Start the drain loop unless it is already running. */
  private ensureDraining(): void {
    if (this.drainRunning || !this.started) return;
    if (this.queue.length === 0) return;
    this.drainRunning = true;
    this.drainDone = this.drainLoop();
  }

  /** Send the head item until it finishes, then the next, in order. A head
   *  that fails transiently stalls the queue and is retried after a backoff
   *  (or on `kick()`); nothing behind it is sent meanwhile. */
  private async drainLoop(): Promise<void> {
    try {
      while (this.started && this.queue.length > 0) {
        const base = this.queue[0]!;
        let outcome: ItemOutcome;
        try {
          outcome = await this.processItem(base);
        } catch (err) {
          // processItem catches its own errors; this is a safety net so an
          // unexpected throw holds the item instead of killing the loop.
          const label = classifyError(err);
          outcome = {
            kind: "transient",
            failure: { ok: false, transient: true, timedOut: false, label, message: `outbox error: ${label}`, retryAfterSec: null },
          };
        }
        if (!this.started || outcome.kind === "interrupted") break;
        if (outcome.kind === "transient") {
          this.markStalled(outcome.failure);
          await this.stallWait(outcome.failure);
          continue;
        }
        // finished or vanished: the head is done with.
        this.queue.shift();
        this.setHealth({ pending: this.queue.length, ...this.endStallWithoutAnswer(base) });
      }
    } finally {
      this.drainRunning = false;
    }
  }

  /** Dispatch one item by its extension. */
  private processItem(base: string): Promise<ItemOutcome> {
    if (base.endsWith(".react.json")) return this.processReaction(base);
    if (base.endsWith(".file.json")) return this.processFile(base);
    return this.processText(base);
  }

  /** Read and send one text message, chunk by chunk, resuming after any
   *  chunks a `.progress` file records as delivered. `base` is the full
   *  dropped filename, e.g. `123-abc.txt`. */
  private async processText(base: string): Promise<ItemOutcome> {
    const read = await this.readItem(base);
    if (read.kind !== "ok") return read;
    const text = read.content;

    if (text.trim() === "") {
      await this.finish(base, { ok: false, message: "empty message" });
      this.log(`telegram outbox: 0 chars -> chat ${this.chatId}: failed (empty message)`);
      return { kind: "finished" };
    }

    const { chunk: chunkFn } = await import("./telegram-client");
    const chunks = chunkFn(text);
    const progress = await this.readProgress(base, chunks.length);
    if (progress.sent > 0 && progress.sent < chunks.length) {
      this.log(`telegram outbox: resuming ${base} at part ${progress.sent + 1} of ${chunks.length}`);
    }

    for (let i = progress.sent; i < chunks.length; i++) {
      if (!this.started) return { kind: "interrupted" };
      const piece = chunks[i]!;
      const r = await this.callWithRetry(base, "sendMessage", () =>
        this.client.sendMessage({ chat_id: this.chatId, text: piece }),
      );
      if (!r.ok) {
        if (r.transient) return { kind: "transient", failure: r };
        const already =
          progress.sent > 0 ? ` (${progress.sent} of ${chunks.length} parts were already sent)` : "";
        await this.finish(base, { ok: false, message: `${r.message}${already}` });
        this.log(`telegram outbox: ${text.length} chars -> chat ${this.chatId}: failed (${r.message})${already}`);
        return { kind: "finished" };
      }
      this.noteSentChunk(r.value.result, piece, progress.message_ids);
      progress.sent = i + 1;
      await this.writeProgress(base, progress);
    }

    await this.finish(base, { ok: true, message: formatSendOk(chunks.length, progress.message_ids) });
    this.log(`telegram outbox: ${text.length} chars -> chat ${this.chatId}: ok`);
    return { kind: "finished" };
  }

  /** Read and send one reaction descriptor. `base` is the full dropped
   *  filename, e.g. `123-abc.react.json`, holding JSON `{ message_id, emoji }`. */
  private async processReaction(base: string): Promise<ItemOutcome> {
    const read = await this.readItem(base);
    if (read.kind !== "ok") return read;
    const raw = read.content;

    let descriptor: { message_id: number; emoji: string | null };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const messageId = parsed.message_id;
      const emoji = parsed.emoji;
      if (typeof messageId !== "number" || !Number.isFinite(messageId)) {
        throw new Error("missing or invalid message_id");
      }
      if (emoji !== null && typeof emoji !== "string") {
        throw new Error("emoji must be a string or null");
      }
      descriptor = { message_id: messageId, emoji };
    } catch (err) {
      await this.finish(base, { ok: false, message: `bad reaction descriptor: ${describeErr(err)}` });
      this.log(`telegram outbox: bad reaction descriptor in ${base}: ${describeErr(err)}`);
      return { kind: "finished" };
    }

    const r = await this.callWithRetry(base, "setMessageReaction", () =>
      this.client.setMessageReaction({
        chat_id: this.chatId,
        message_id: descriptor.message_id,
        emoji: descriptor.emoji,
      }),
    );
    if (!r.ok && r.transient) return { kind: "transient", failure: r };
    const target = descriptor.emoji === null ? "(cleared)" : descriptor.emoji;
    const where = `react ${target} -> msg ${descriptor.message_id} chat ${this.chatId}`;
    if (r.ok) {
      await this.finish(base, { ok: true, message: "ok" });
      this.log(`telegram outbox: ${where}: ok`);
    } else {
      await this.finish(base, { ok: false, message: r.message });
      this.log(`telegram outbox: ${where}: failed (${r.message})`);
    }
    return { kind: "finished" };
  }

  /** Read, validate and upload one file descriptor. `base` is the full
   *  dropped filename, e.g. `123-abc.file.json`, holding JSON
   *  `{ path: string, caption?: string, kind: "photo" | "document" }`.
   *
   *  Validates the descriptor shape, then that the local `path` exists, is a
   *  regular file, is readable, and is within the per-kind send limit BEFORE
   *  attempting the upload — a clear `ok:false` result is far friendlier than a
   *  cryptic API failure. These checks rerun on every retry of a stalled item,
   *  so a file deleted meanwhile fails permanently instead of retrying. */
  private async processFile(base: string): Promise<ItemOutcome> {
    const read = await this.readItem(base);
    if (read.kind !== "ok") return read;
    const raw = read.content;

    let descriptor: { path: string; caption?: string; kind: "photo" | "document" };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const filePath = parsed.path;
      const kind = parsed.kind;
      const caption = parsed.caption;
      if (typeof filePath !== "string" || filePath === "") {
        throw new Error("missing or invalid path");
      }
      if (kind !== "photo" && kind !== "document") {
        throw new Error('kind must be "photo" or "document"');
      }
      if (caption !== undefined && typeof caption !== "string") {
        throw new Error("caption must be a string when present");
      }
      descriptor = { path: filePath, kind, caption: caption as string | undefined };
    } catch (err) {
      await this.finish(base, { ok: false, message: `bad file descriptor: ${describeErr(err)}` });
      this.log(`telegram outbox: bad file descriptor in ${base}: ${describeErr(err)}`);
      return { kind: "finished" };
    }

    const where = `${descriptor.kind} ${descriptor.path} -> chat ${this.chatId}`;
    const validation = await this.validateOutgoingFile(descriptor.path, descriptor.kind);
    if (!validation.ok) {
      await this.finish(base, { ok: false, message: validation.message });
      this.log(`telegram outbox: ${where}: failed (${validation.message})`);
      return { kind: "finished" };
    }

    const method = descriptor.kind === "photo" ? "sendPhoto" : "sendDocument";
    const r = await this.callWithRetry(base, method, () =>
      descriptor.kind === "photo"
        ? this.client.sendPhoto({ chat_id: this.chatId, path: descriptor.path, caption: descriptor.caption })
        : this.client.sendDocument({ chat_id: this.chatId, path: descriptor.path, caption: descriptor.caption }),
    );
    if (!r.ok && r.transient && r.everyAttemptTimedOut) {
      // Every attempt ran out of `sendFileMs` mid-upload: this file cannot
      // finish on this link (e.g. 50 MB on a slow uplink), and each retry
      // re-uploads all of it. Holding it would block every later item
      // forever, so fail it and let the queue move on. Other transient
      // failures (5xx, refused, 429) still stall.
      const message = `${method} timed out ${INLINE_ATTEMPTS} times (upload too slow?); not retrying`;
      await this.finish(base, { ok: false, message });
      this.log(`telegram outbox: ${where}: failed (${message})`);
      return { kind: "finished" };
    }
    if (!r.ok && r.transient) return { kind: "transient", failure: r };
    if (r.ok) {
      await this.finish(base, { ok: true, message: "ok" });
      this.log(`telegram outbox: ${where}: ok`);
    } else {
      await this.finish(base, { ok: false, message: r.message });
      this.log(`telegram outbox: ${where}: failed (${r.message})`);
    }
    return { kind: "finished" };
  }

  /** Validate an outgoing local file before upload. Checks existence, that it's
   *  a regular file, readability, and the per-kind size ceiling
   *  (~10 MB photo / ~50 MB document for bots). Returns a clear message on
   *  failure so the sender sees why rather than a cryptic API error. */
  private async validateOutgoingFile(
    filePath: string,
    kind: "photo" | "document",
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { stat, access } = await import("fs/promises");
    const { constants } = await import("fs");
    const { TELEGRAM_SENDPHOTO_LIMIT_BYTES, TELEGRAM_SENDDOCUMENT_LIMIT_BYTES } = await import(
      "./telegram-client"
    );
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return { ok: false, message: `file not found: ${filePath}` };
    }
    if (!st.isFile()) {
      return { ok: false, message: `not a regular file: ${filePath}` };
    }
    try {
      await access(filePath, constants.R_OK);
    } catch {
      return { ok: false, message: `file is not readable: ${filePath}` };
    }
    const limit =
      kind === "photo" ? TELEGRAM_SENDPHOTO_LIMIT_BYTES : TELEGRAM_SENDDOCUMENT_LIMIT_BYTES;
    if (st.size > limit) {
      const limitMb = Math.round(limit / (1024 * 1024));
      const sizeMb = (st.size / (1024 * 1024)).toFixed(1);
      const hint =
        kind === "photo"
          ? " (try --document for larger files; sendPhoto is capped lower)"
          : "";
      return {
        ok: false,
        message: `file too large for ${kind}: ${sizeMb} MB exceeds the ~${limitMb} MB limit${hint}`,
      };
    }
    return { ok: true };
  }

  /** One Bot API call with bounded inline retry on transient failures:
   *  up to {@link INLINE_ATTEMPTS} attempts, waiting `backoffDelayMs` between
   *  them (at least `retry_after` on a 429). Returns the success, a permanent
   *  failure, or the last transient failure once the attempts run out (or
   *  `stop()` is called) — with `everyAttemptTimedOut` when all
   *  {@link INLINE_ATTEMPTS} attempts timed out. Any answer from Telegram,
   *  good or permanent, ends a stall. */
  private async callWithRetry<T extends { ok: true } | ClientFailure>(
    base: string,
    method: string,
    call: () => Promise<T>,
  ): Promise<CallResult<Extract<T, { ok: true }>>> {
    let timeouts = 0;
    for (let attempt = 1; ; attempt++) {
      const r = await attemptCall(method, call);
      if (r.ok || !r.transient) {
        this.noteTelegramAnswered();
        return r;
      }
      if (r.timedOut) timeouts += 1;
      await this.writeInterimResult(base, r);
      if (attempt >= INLINE_ATTEMPTS) return { ...r, everyAttemptTimedOut: timeouts === attempt };
      if (!this.started) return r;
      const delayMs = retryDelayMs(attempt, INLINE_BACKOFF, r.retryAfterSec);
      // A 429 asking for longer than the inline cap holds the queue right
      // away: the stall wait honors retry_after too, and unlike `sleepCtx` its
      // timer is cancelled by stop().
      if (delayMs > INLINE_BACKOFF.maxMs) return r;
      // While stalled, each stall retry runs this loop again; the stall line
      // already covers those failures, so only a healthy queue logs retries.
      if (!this.health.stalled) {
        this.log(`telegram outbox: ${r.message}; retrying (attempt ${attempt + 1} of ${INLINE_ATTEMPTS})`);
      }
      await Promise.race([sleepCtx.fn(delayMs), this.stopSignal]);
      if (!this.started) return r;
    }
  }

  /** Mark the queue stalled on the head's exhausted transient failure. Logs
   *  once per streak; every call refreshes `lastError`/`lastErrorAt`. */
  private markStalled(failure: CallFailure): void {
    const firstOfStreak = !this.health.stalled;
    this.stallStreak += 1;
    if (firstOfStreak) {
      this.log(
        `telegram outbox: send stalled (${failure.message}); holding ${this.queue.length} queued item(s) in order, retrying with backoff`,
      );
    }
    this.setHealth({ stalled: true, lastError: failure.label, lastErrorAt: Date.now() });
  }

  /** Telegram answered (2xx or a permanent 4xx): the connection works, so a
   *  stall is over. */
  private noteTelegramAnswered(): void {
    if (!this.health.stalled) return;
    const retries = this.stallStreak;
    this.stallStreak = 0;
    this.retryNotBefore = 0;
    this.log(`telegram outbox: send recovered after ${retries} stalled retr${retries === 1 ? "y" : "ies"}`);
    this.setHealth({ stalled: false, lastError: null, lastErrorAt: null });
  }

  /** The head left the queue (finished or vanished). If the queue is still
   *  marked stalled, the head left WITHOUT a Telegram answer — an answer
   *  clears the stall first (`noteTelegramAnswered`): its file vanished, its
   *  revalidation failed, or an upload timed out every time. Nothing proved
   *  Telegram is unreachable now, so end the streak: otherwise the light and
   *  status file would say `reconnecting` with nothing queued until some
   *  later send succeeded, and the next item would inherit a long backoff.
   *  Returns the health patch (empty when not stalled). */
  private endStallWithoutAnswer(base: string): Partial<OutboxHealth> {
    if (!this.health.stalled) return {};
    this.log(`telegram outbox: stalled item ${base} left the queue without a Telegram answer; clearing the stall`);
    this.stallStreak = 0;
    this.retryNotBefore = 0;
    return { stalled: false, lastError: null, lastErrorAt: null };
  }

  /** Wait before retrying a stalled head: capped, jittered backoff on the
   *  streak length (at least `retry_after` on a 429). Ends early on `kick()`
   *  or `stop()`. Uses a real timer so a test's fast-forwarded `sleepCtx`
   *  does not spin the loop. */
  private stallWait(failure: CallFailure): Promise<void> {
    const ms = retryDelayMs(this.stallStreak, this.stallBackoff, failure.retryAfterSec);
    this.retryNotBefore =
      failure.retryAfterSec !== null ? Date.now() + failure.retryAfterSec * 1000 : 0;
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        if (this.wakeStall === finish) this.wakeStall = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeStall = finish;
    });
  }

  /** Apply a health patch and notify listeners if `pending`, `stalled` or
   *  `lastError` changed. */
  private setHealth(patch: Partial<OutboxHealth>): void {
    const prev = this.health;
    const next = { ...prev, ...patch };
    this.health = next;
    if (next.pending === prev.pending && next.stalled === prev.stalled && next.lastError === prev.lastError) {
      return;
    }
    for (const listener of this.healthListeners) {
      try {
        listener({ ...next });
      } catch (err) {
        this.log(`telegram outbox: health listener threw: ${describeErr(err)}`);
      }
    }
  }

  /** Read an item file. Only ENOENT means the item is gone (it is dropped).
   *  Any other error (EMFILE, EACCES, EIO, ...) holds the item: the queue
   *  stalls and retries it, and nothing is unlinked — a read error must never
   *  delete a message that was not sent. */
  private async readItem(base: string): Promise<ItemRead> {
    try {
      return { kind: "ok", content: await readFile(join(this.dir, base), "utf8") };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.log(`telegram outbox: failed to read ${base}: ${describeErr(err)}`);
        await this.cleanupItem(base);
        return { kind: "vanished" };
      }
      const why = code ?? classifyError(err);
      return {
        kind: "transient",
        failure: {
          ok: false,
          transient: true,
          timedOut: false,
          label: `outbox read failed (${why})`,
          message: `failed to read ${base}: ${why}`,
          retryAfterSec: null,
        },
      };
    }
  }

  /** Load a text's `.progress`, or a fresh one when there is none (or it does
   *  not fit this text). */
  private async readProgress(base: string, chunkCount: number): Promise<TextProgress> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, `${base}.progress`), "utf8");
    } catch {
      return { sent: 0, message_ids: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const sent = parsed.sent;
      const ids = parsed.message_ids;
      if (
        typeof sent === "number" && Number.isInteger(sent) && sent >= 0 && sent <= chunkCount &&
        Array.isArray(ids) && ids.every((id) => typeof id === "number")
      ) {
        return { sent, message_ids: ids as number[] };
      }
    } catch {
      /* fall through */
    }
    this.log(`telegram outbox: ignoring unreadable ${base}.progress; sending from part 1`);
    return { sent: 0, message_ids: [] };
  }

  /** Atomically record a text's progress after a delivered chunk. */
  private async writeProgress(base: string, progress: TextProgress): Promise<void> {
    const finalPath = join(this.dir, `${base}.progress`);
    const tmpPath = `${finalPath}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(progress));
      await rename(tmpPath, finalPath);
    } catch (err) {
      await unlinkSafe(tmpPath);
      this.log(`telegram outbox: failed to record progress for ${base}: ${describeErr(err)}`);
    }
  }

  /** Record one successfully-sent chunk: collect its `message_id` and cache the
   *  chunk's own text for reaction previews.
   *
   *  Per-CHUNK rather than per-message is the correct granularity: Telegram
   *  splits a long `ib tgsend` into several real messages, the user reacts to
   *  one specific chunk, and that chunk's text is what they actually saw.
   *
   *  Defensive on both halves. `result` is typed as a TelegramMessage but is
   *  really `raw.body.result ?? {}` from the client — a 2xx `{ok:true}` body
   *  with no `result` yields an empty object, so `message_id` can genuinely be
   *  absent or non-numeric at runtime. And the cache write is best-effort: a
   *  failure here must never fail or alter a send that already landed. */
  private noteSentChunk(result: unknown, text: string, into: number[]): void {
    const messageId = extractMessageId(result);
    if (messageId === null) return;
    into.push(messageId);
    try {
      recordOutboundMessage(this.chatId, messageId, text);
    } catch (err) {
      // Cache is a nicety; the message is already delivered. Log and move on.
      this.log(`telegram outbox: message cache write failed: ${describeErr(err)}`);
    }
  }

  /** Write the interim `queued:` result for the head's first transient
   *  failure, once per item. */
  private async writeInterimResult(base: string, failure: CallFailure): Promise<void> {
    if (this.interimWrittenFor === base) return;
    this.interimWrittenFor = base;
    await this.writeResult(base, { ok: true, queued: true, message: queuedTelegramUnreachable(failure.label) });
  }

  /** Write the final result, unlink the item and its `.progress` right away,
   *  and schedule the `.result`'s cleanup. A finished item must never be sent
   *  again: if it stayed on disk for the retention window, a crash or a quick
   *  restart in that window would re-enqueue it (a file re-uploaded, a
   *  reaction re-sent). Only the `.result` is kept, for the waiting client;
   *  `known` keeps the name until the cleanup timer, so no rescan can enqueue
   *  it meanwhile. A crash between the result write and the unlink is caught
   *  by the startup sweep (an item with a FINAL `.result` is done). */
  private async finish(base: string, body: { ok: boolean; message: string }): Promise<void> {
    await this.writeResult(base, body);
    await unlinkSafe(join(this.dir, base));
    await unlinkSafe(join(this.dir, `${base}.progress`));
    this.scheduleCleanup(base);
  }

  /** Atomic-write `<base>.result`. */
  private async writeResult(
    base: string,
    body: { ok: boolean; message: string; queued?: boolean },
  ): Promise<void> {
    const finalPath = join(this.dir, `${base}.result`);
    const tmpPath = `${finalPath}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(body));
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort cleanup of the .tmp; we still log so the operator sees
      // why the result never appeared from the sender's perspective.
      await unlinkSafe(tmpPath);
      this.log(`telegram outbox: failed to write result for ${base}: ${describeErr(err)}`);
    }
  }

  /** Schedule the finished item's `.result` for deletion ~5s out (the item
   *  and its `.progress` are already gone, see `finish`). The retention
   *  window gives the sender (`tgsend`/`tgreact`) time to read the result
   *  before it disappears. The item stays in `known` until then, so a rescan
   *  that listed it before the unlink cannot enqueue it again. */
  private scheduleCleanup(base: string): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(base);
      void this.cleanupItem(base);
    }, RESULT_RETENTION_MS);
    this.cleanupTimers.set(base, timer);
  }

  /** Unlink the item, its `.progress` and its `.result`, then stop tracking
   *  it. The item goes first: once it is gone no scan can read it. Ignores
   *  ENOENT — shutdown can race us, and we just want them gone. */
  private async cleanupItem(base: string): Promise<void> {
    await unlinkSafe(join(this.dir, base));
    await unlinkSafe(join(this.dir, `${base}.progress`));
    await unlinkSafe(join(this.dir, `${base}.result`));
    if (this.rescanRunning) {
      this.forgetAfterRescan.push(base);
    } else {
      this.known.delete(base);
    }
  }
}

/** Run one client call and normalize its outcome. A fetch throw is transient
 *  and labelled with `classifyError` (never `err.message`, which can embed the
 *  bot-token URL); a timer abort is `errno:ETIMEDOUT` and `timedOut`. An
 *  HTTP failure is transient when `isTransientStatus` says so; its label is
 *  `HTTP <status>` (or the client's token-safe description for status 0). */
async function attemptCall<T extends { ok: true } | ClientFailure>(
  method: string,
  call: () => Promise<T>,
): Promise<CallResult<Extract<T, { ok: true }>>> {
  let resp: T;
  try {
    resp = await call();
  } catch (err) {
    const label = classifyError(err);
    return {
      ok: false,
      transient: true,
      // The outbound calls take no caller signal, so an abort is their timer.
      timedOut: isAbortError(err),
      label,
      message: `${method} failed: ${label}`,
      retryAfterSec: null,
    };
  }
  if (resp.ok) return { ok: true, value: resp as Extract<T, { ok: true }> };
  const failure = resp as ClientFailure;
  const desc = failure.description ?? `HTTP ${failure.error_code ?? failure.status}`;
  return {
    ok: false,
    transient: isTransientStatus(failure.status),
    timedOut: failure.timedOut === true,
    label: failure.status === 0 ? desc : `HTTP ${failure.status}`,
    message: `${method} failed: ${desc}`,
    retryAfterSec: failure.retryAfterSec,
  };
}

/** Backoff for retry number `attempt`, but never shorter than a 429's
 *  `retry_after`. */
function retryDelayMs(attempt: number, opts: BackoffOptions, retryAfterSec: number | null): number {
  const backoff = backoffDelayMs(attempt, opts);
  return retryAfterSec !== null ? Math.max(retryAfterSec * 1000, backoff) : backoff;
}

/** True for a dropped file the outbox should process: a `.txt` message, a
 *  `.react.json` reaction descriptor, or a `.file.json` file-send descriptor.
 *  Sidecars (`.tmp`, `.result`, `.progress`) are not queued items. */
function isQueuedFile(name: string): boolean {
  return name.endsWith(".txt") || name.endsWith(".react.json") || name.endsWith(".file.json");
}

/** Count the queued items (`.txt`, `.react.json`, `.file.json`) in the outbox
 *  dir; 0 when it cannot be read. `ib watch` uses it while there is no
 *  `TelegramOutbox` yet (boot still connecting, or routing disabled), so the
 *  status file and `?` help can still say how many messages wait. One cheap
 *  readdir of a normally-empty dir. */
export function countQueuedOutboxItems(dir: string = defaultOutboxDir()): number {
  try {
    return readdirSync(dir).filter(isQueuedFile).length;
  } catch {
    return 0;
  }
}

/** Pull a usable `message_id` out of a `sendMessage` success body, or null.
 *
 *  The client hands us `raw.body.result ?? {}` cast to a TelegramMessage, so
 *  the static type promises a number the runtime does not. Anything that isn't
 *  a finite positive integer is treated as absent — a `message_id` of 0 or NaN
 *  is not a reactable target, and echoing one back would be worse than echoing
 *  nothing. */
export function extractMessageId(result: unknown): number | null {
  if (result == null || typeof result !== "object") return null;
  const raw = (result as { message_id?: unknown }).message_id;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/** Render the `ok` result message for a successful text send, folding in the
 *  Telegram message ids so they reach `ib tgsend`'s stdout.
 *
 *      ok                                          (1 part, no id determined)
 *      ok (message_id 1584)                        (1 part)
 *      ok (3 parts)                                (3 parts, no ids)
 *      ok (3 parts, message_ids 1584, 1585, 1586)  (3 parts)
 *
 *  The bare `ok` / `ok (N parts)` shapes are exactly what we emitted before ids
 *  existed, so a send whose id we couldn't determine degrades to the old
 *  contract rather than to something new the coordinator has to parse.
 *
 *  The label is keyed on the ID count, not the part count, so the singular
 *  `message_id` never introduces a lone plural. Ids are best-effort, so a
 *  3-part send with 2 determined ids honestly reports the 2 it has. */
export function formatSendOk(partCount: number, messageIds: number[]): string {
  const partsLabel = partCount === 1 ? "" : `${partCount} parts`;
  const idsLabel =
    messageIds.length === 0
      ? ""
      : messageIds.length === 1
        ? `message_id ${messageIds[0]}`
        : `message_ids ${messageIds.join(", ")}`;
  const inner = [partsLabel, idsLabel].filter((s) => s !== "").join(", ");
  return inner === "" ? "ok" : `ok (${inner})`;
}

async function unlinkSafe(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* file already gone — fine */
  }
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
