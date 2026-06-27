/**
 * Telegram outbox — file-drop queue between `ib tgsend` (per-shell process)
 * and `ib watch` (long-running TUI).
 *
 * Phase B refactor: `ib tgsend` no longer talks to Telegram. It writes the
 * message text to a directory and waits up to 1s for a result file. `ib watch`
 * watches that directory and, for every queued message, calls
 * `client.sendMessage` (chunked, with the same one-shot 429-retry the old
 * `tgsend` did) and writes back a result file.
 *
 * Layout under `~/.itsybitsy/channels/telegram/outbox/`:
 *
 *   - `<unix-ms>-<6-hex-rand>.txt`              — message text (UTF-8)
 *   - `<unix-ms>-<6-hex-rand>.txt.tmp`          — partial write (cleaned on sweep)
 *   - `<unix-ms>-<6-hex-rand>.txt.result`       — JSON `{ok, message}` written by us
 *   - `<unix-ms>-<6-hex-rand>.react.json`       — reaction descriptor (see below)
 *   - `<unix-ms>-<6-hex-rand>.react.json.tmp`   — partial write (cleaned on sweep)
 *   - `<unix-ms>-<6-hex-rand>.react.json.result`— JSON `{ok, message}` written by us
 *
 * A reaction descriptor is JSON `{ message_id: number, emoji: string | null }`
 * dropped by `ib tgreact`; we call `client.setMessageReaction` for it (a null
 * emoji clears the bot's reaction). It flows through the same serialized send
 * chain, fs.watch, sweep, and 5s-retained-result machinery as text messages —
 * only the per-file processing differs (`processReaction` vs `process`).
 *
 * Atomic writes use `<path>.tmp` + `rename`. Result files are kept for ~5s
 * after writing so the sender process can read them, then both files are
 * unlinked.
 *
 * On `start()` we sweep the directory: any stale `.tmp`/`.result` is unlinked,
 * any orphan `.txt` is enqueued in alphabetical (=chronological) order. Once
 * the sweep is awaited, we install an `fs.watch` on the dir and process
 * every `.txt` rename as it appears. Sends are serialized through a single
 * Promise chain (mirrors the dispatcher's `mutexChain` pattern) so two
 * back-to-back drops never interleave on the wire.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { watch, type FSWatcher } from "node:fs";
import type { TelegramClient } from "./telegram-client";
import { classifyError } from "./telegram-client";

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
    join(process.env.HOME ?? homedir(), ".itsybitsy", "channels", "telegram", "outbox")
  );
}

export interface OutboxOptions {
  client: TelegramClient;
  /** Resolved chat id from the boot's step 2. The outbox sends every queued
   *  message to this chat — `ib tgsend` is single-target by design. */
  chatId: string;
  /** Log sink — defaults to stderr. Tests inject a capture array. */
  log?: (line: string) => void;
}

const DEFAULT_LOG = (line: string): void => {
  process.stderr.write(line + "\n");
};

/** Time to keep a `.result` file around after writing it, so `tgsend` (a
 *  separate process) has a window to read it before we clean up. */
const RESULT_RETENTION_MS = 5_000;

/** Periodic safety rescan. fs.watch on macOS occasionally drops events
 *  (especially on rapid create+rename), so we poll the dir at this cadence
 *  as a backup. The poll is cheap — readdir on a normally-empty dir. */
const SAFETY_RESCAN_MS = 500;

/** TelegramOutbox — owns the directory watch + serialized send queue. Construction
 *  does no I/O; call `start()` and `stop()` to control the lifecycle. */
export class TelegramOutbox {
  private readonly client: TelegramClient;
  private readonly chatId: string;
  private readonly log: (line: string) => void;
  private readonly dir: string;

  /** Single Promise chain for serialized sends. Each enqueue appends to this
   *  chain; the next send waits for the previous to finish. Mirrors the
   *  dispatcher's `mutexChain` shape but only ever has one slot since the
   *  outbox has a single chat target. */
  private sendChain: Promise<void> = Promise.resolve();

  /** Stems already enqueued, so the macOS no-filename rename event can
   *  re-scan the dir without double-processing. Cleared once the send
   *  completes (and the `.result` file is written). */
  private readonly inFlight: Set<string> = new Set();

  /** Active cleanup timeouts, keyed by stem. `stop()` clears these and
   *  unlinks immediately rather than leaving stale files for the next
   *  startup sweep — we wrote them, we know exactly what to clean. */
  private readonly cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** fs.watch handle. Created in `start()`, closed in `stop()`. */
  private watcher: FSWatcher | null = null;

  /** setInterval handle for the safety rescan. Cleared in `stop()`. */
  private rescanTimer: ReturnType<typeof setInterval> | null = null;

  /** Set to true once `start()` returns. Used to gate `stop()`. */
  private started = false;

  /** Edge-transition tracker for send-failure logging. `lastSendOk` is null
   *  until the first send attempt completes. We only log on edge transitions
   *  (success → failure or failure → success) so a streak of failures
   *  produces one line, not one per message. */
  private lastSendOk: boolean | null = null;

  constructor(opts: OutboxOptions) {
    this.client = opts.client;
    this.chatId = String(opts.chatId);
    this.log = opts.log ?? DEFAULT_LOG;
    // Snapshot the dir at construction time so a mid-run setOutboxDir() in
    // tests doesn't shift our target. Same convention as boot.ts captures
    // the chat id once.
    this.dir = defaultOutboxDir();
  }

  /** Run the startup sweep and install the fs.watch. Returns once the watcher
   *  is established and any orphan `.txt` files have been enqueued. */
  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    // Install the watcher AFTER the sweep so any file that appears during
    // the sweep window is also picked up by the rescan path below.
    this.watcher = watch(this.dir, (eventType, filename) => {
      if (eventType !== "rename") return;
      // macOS sometimes fires rename with no filename. Either way, rescan
      // the dir and pick up any unseen .txt files. Cheap — readdir on a
      // small queue dir.
      void this.rescan(filename ? String(filename) : null);
    });
    // Backup poll: fs.watch on macOS can silently drop a rename event when
    // the create + rename of `.tmp` → `.txt` happens within the same
    // kernel tick. Poll the dir on a coarse cadence so a missed event
    // results in at most a 0.5s delay rather than a stuck queue.
    this.rescanTimer = setInterval(() => {
      void this.rescan(null);
    }, SAFETY_RESCAN_MS);
    this.started = true;
  }

  /** Close the watcher and drain any in-flight send. Caller wraps in a 2s
   *  timeout race (mirrors dispatcher.stop). */
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
    // Drain the send chain — wait for whatever is currently sending.
    try {
      await this.sendChain;
    } catch {
      /* swallow — chain errors are logged inline */
    }
    // Cancel pending cleanup timeouts and unlink immediately. We wrote
    // these `.txt` + `.result` pairs ourselves; the `tgsend` process either
    // already read the result or has given up by now.
    const timers = Array.from(this.cleanupTimers.entries());
    this.cleanupTimers.clear();
    for (const [stem, timer] of timers) {
      clearTimeout(timer);
      await this.cleanupPair(stem);
    }
  }

  /** Sweep the outbox dir at startup. Drops any leftover `.tmp` / `.result`
   *  files and enqueues every queued message (`.txt`) and reaction
   *  (`.react.json`) we find. Alphabetical order is chronological because
   *  filenames start with `<unix-ms>`. */
  private async sweep(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    entries.sort();
    const orphans: string[] = [];
    for (const entry of entries) {
      if (entry.endsWith(".tmp") || entry.endsWith(".result")) {
        await unlinkSafe(join(this.dir, entry));
        continue;
      }
      if (isQueuedFile(entry)) {
        orphans.push(entry);
      }
    }
    for (const entry of orphans) {
      this.enqueue(entry);
    }
  }

  /** Re-scan the dir on a rename event. Skips already-enqueued files so a
   *  stray rename burst doesn't double-process. Sorted alphabetically so a
   *  burst of drops processes in chronological order (filenames start with
   *  unix-ms). */
  private async rescan(_hint: string | null): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (!isQueuedFile(entry)) continue;
      if (this.inFlight.has(entry)) continue;
      this.enqueue(entry);
    }
  }

  /** Append a send for one queued file to the serialized chain. The queue key
   *  is the full dropped filename (`<stem>.txt` or `<stem>.react.json`); the
   *  result/cleanup paths append `.result` to it. Dispatches by extension. */
  private enqueue(base: string): void {
    if (this.inFlight.has(base)) return;
    this.inFlight.add(base);
    if (base.endsWith(".react.json")) {
      this.sendChain = this.sendChain.then(() => this.processReaction(base));
    } else {
      this.sendChain = this.sendChain.then(() => this.process(base));
    }
  }

  /** Read, send, write result, schedule cleanup for a text message. Never
   *  throws — all errors are logged and surfaced as a `{ok:false}` result
   *  file. `base` is the full dropped filename, e.g. `123-abc.txt`. */
  private async process(base: string): Promise<void> {
    const txtPath = join(this.dir, base);
    let text: string;
    try {
      text = await readFile(txtPath, "utf8");
    } catch (err) {
      this.log(`telegram outbox: failed to read ${base}: ${describeErr(err)}`);
      this.inFlight.delete(base);
      return;
    }

    const trimmed = text.trim();
    if (trimmed === "") {
      await this.writeResult(base, { ok: false, message: "empty message" });
      this.scheduleCleanup(base);
      this.log(`telegram outbox: 0 chars -> chat ${this.chatId}: failed (empty message)`);
      return;
    }

    const { chunk: chunkFn } = await import("./telegram-client");
    const chunks = chunkFn(text);

    const sendOutcome = await this.sendChunks(chunks);

    if (sendOutcome.ok) {
      const message = chunks.length === 1 ? "ok" : `ok (${chunks.length} parts)`;
      await this.writeResult(base, { ok: true, message });
      this.log(`telegram outbox: ${text.length} chars -> chat ${this.chatId}: ok`);
    } else {
      await this.writeResult(base, { ok: false, message: sendOutcome.message });
      this.log(
        `telegram outbox: ${text.length} chars -> chat ${this.chatId}: failed (${sendOutcome.message})`,
      );
    }
    // Edge-transition tracking: surface a "send failed (reason)" line on the
    // first failure of a streak and a "send recovered" line on the next
    // success. Per-message logs are above; this layer is the network-state
    // signal, not the per-message audit.
    this.recordSendOutcome(sendOutcome);
    this.scheduleCleanup(base);
  }

  /** Read, react, write result, schedule cleanup for a reaction descriptor.
   *  Never throws. `base` is the full dropped filename, e.g.
   *  `123-abc.react.json`, holding JSON `{ message_id, emoji }`. */
  private async processReaction(base: string): Promise<void> {
    const path = join(this.dir, base);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      this.log(`telegram outbox: failed to read ${base}: ${describeErr(err)}`);
      this.inFlight.delete(base);
      return;
    }

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
      await this.writeResult(base, { ok: false, message: `bad reaction descriptor: ${describeErr(err)}` });
      this.scheduleCleanup(base);
      this.log(`telegram outbox: bad reaction descriptor in ${base}: ${describeErr(err)}`);
      return;
    }

    const outcome = await this.sendReaction(descriptor.message_id, descriptor.emoji);
    const target = descriptor.emoji === null ? "(cleared)" : descriptor.emoji;
    if (outcome.ok) {
      await this.writeResult(base, { ok: true, message: "ok" });
      this.log(`telegram outbox: react ${target} -> msg ${descriptor.message_id} chat ${this.chatId}: ok`);
    } else {
      await this.writeResult(base, { ok: false, message: outcome.message });
      this.log(
        `telegram outbox: react ${target} -> msg ${descriptor.message_id} chat ${this.chatId}: failed (${outcome.message})`,
      );
    }
    this.recordSendOutcome(outcome);
    this.scheduleCleanup(base);
  }

  /** Call `setMessageReaction` with a single 429-retry, mirroring `sendChunks`'
   *  failure-mode strings. */
  private async sendReaction(
    messageId: number,
    emoji: string | null,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { sleepCtx } = await import("./telegram-client");
    let resp;
    try {
      resp = await this.client.setMessageReaction({ chat_id: this.chatId, message_id: messageId, emoji });
    } catch (err) {
      return { ok: false, message: `setMessageReaction failed: ${classifyError(err)}` };
    }
    if (resp.ok) return { ok: true };

    if (resp.error_code === 429 || resp.status === 429) {
      const retryAfterSec = resp.retryAfterSec ?? 1;
      await sleepCtx.fn(retryAfterSec * 1000);
      let retryResp;
      try {
        retryResp = await this.client.setMessageReaction({ chat_id: this.chatId, message_id: messageId, emoji });
      } catch (err) {
        return { ok: false, message: `setMessageReaction failed after 429 retry: ${classifyError(err)}` };
      }
      if (retryResp.ok) return { ok: true };
      const desc = retryResp.description ?? `HTTP ${retryResp.error_code ?? "unknown"}`;
      return { ok: false, message: `setMessageReaction failed after 429 retry: ${desc}` };
    }

    const desc = resp.description ?? `HTTP ${resp.error_code ?? "unknown"}`;
    return { ok: false, message: `setMessageReaction failed: ${desc}` };
  }

  /** Track success/failure transitions and log on edge changes only. The
   *  first attempt sets `lastSendOk` without logging — only subsequent
   *  flips log. (Initial failures aren't surprising during boot; the
   *  per-message log already records them. We're tracking the *recovery*
   *  signal here.) */
  private recordSendOutcome(outcome: { ok: true } | { ok: false; message: string }): void {
    if (this.lastSendOk === null) {
      // First send — start the streak silently. The per-message log already
      // recorded the outcome; the state-change log only surfaces transitions.
      this.lastSendOk = outcome.ok;
      return;
    }
    if (this.lastSendOk && !outcome.ok) {
      this.log(`telegram outbox: send failed (${outcome.message})`);
    } else if (!this.lastSendOk && outcome.ok) {
      this.log(`telegram outbox: send recovered`);
    }
    this.lastSendOk = outcome.ok;
  }

  /** Loop the chunks, calling `client.sendMessage` once per chunk with a single
   *  429-retry. Mirrors the old `telegramSend` logic in ib-commands.ts so the
   *  failure-mode strings stay identical. */
  private async sendChunks(chunks: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
    const { sleepCtx } = await import("./telegram-client");
    for (const piece of chunks) {
      let resp;
      try {
        resp = await this.client.sendMessage({ chat_id: this.chatId, text: piece });
      } catch (err) {
        // classifyError, not describeErr: fetch errors can embed the
        // bot-token URL in err.message.
        return { ok: false, message: `sendMessage failed: ${classifyError(err)}` };
      }
      if (resp.ok) continue;

      // 429: honor Retry-After (header preferred, body fallback) and try once
      // more. Past that, give up — same contract as the old in-process tgsend.
      if (resp.error_code === 429 || resp.status === 429) {
        const retryAfterSec = resp.retryAfterSec ?? 1;
        await sleepCtx.fn(retryAfterSec * 1000);
        let retryResp;
        try {
          retryResp = await this.client.sendMessage({ chat_id: this.chatId, text: piece });
        } catch (err) {
          // classifyError, not describeErr — same token-safety reason as above.
          return { ok: false, message: `sendMessage failed after 429 retry: ${classifyError(err)}` };
        }
        if (retryResp.ok) continue;
        const desc = retryResp.description ?? `HTTP ${retryResp.error_code ?? "unknown"}`;
        return { ok: false, message: `sendMessage failed after 429 retry: ${desc}` };
      }

      const desc = resp.description ?? `HTTP ${resp.error_code ?? "unknown"}`;
      return { ok: false, message: `sendMessage failed: ${desc}` };
    }
    return { ok: true };
  }

  /** Atomic-write `<base>.result`, where `base` is the full dropped filename
   *  (`<stem>.txt` or `<stem>.react.json`). */
  private async writeResult(base: string, body: { ok: boolean; message: string }): Promise<void> {
    const finalPath = join(this.dir, `${base}.result`);
    const tmpPath = `${finalPath}.tmp`;
    const json = JSON.stringify(body);
    try {
      await writeFile(tmpPath, json);
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort cleanup of the .tmp; we still log so the operator sees
      // why the result never appeared from the sender's perspective.
      await unlinkSafe(tmpPath);
      this.log(`telegram outbox: failed to write result for ${base}: ${describeErr(err)}`);
    }
  }

  /** Schedule the dropped file + its `.result` for deletion ~5s out. The
   *  retention window gives the sender (`tgsend`/`tgreact`) time to read the
   *  result before it disappears. */
  private scheduleCleanup(base: string): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(base);
      this.inFlight.delete(base);
      void this.cleanupPair(base);
    }, RESULT_RETENTION_MS);
    this.cleanupTimers.set(base, timer);
  }

  /** Unlink both halves of the pair (the dropped file + its `.result`). Ignores
   *  ENOENT — shutdown can race us, and we just want them gone. */
  private async cleanupPair(base: string): Promise<void> {
    await unlinkSafe(join(this.dir, base));
    await unlinkSafe(join(this.dir, `${base}.result`));
    this.inFlight.delete(base);
  }
}

/** True for a dropped file the outbox should process: a `.txt` message or a
 *  `.react.json` reaction descriptor. Excludes `.tmp` / `.result` sidecars
 *  (note `.react.json.result` ends with `.result`, so the caller's `.result`
 *  check must run first — `sweep` does). */
function isQueuedFile(name: string): boolean {
  if (name.endsWith(".tmp") || name.endsWith(".result")) return false;
  return name.endsWith(".txt") || name.endsWith(".react.json");
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
