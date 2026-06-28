/**
 * Telegram Bot API client — `getUpdates` long-poll and `sendMessage` POST.
 *
 * Pure transport layer. No dispatcher, no wiring into `ib watch`. Phase 5
 * instantiates this and runs the main inbound loop.
 *
 * Key invariants:
 *   - Outer retry loop wraps every `getUpdates` call: on any error (network,
 *     429, 409, 5xx) we sleep with exponential backoff and continue. A
 *     successful poll resets the backoff. The loop must not exit on a single
 *     transient failure (mirrors official plugin server.ts:999-1038).
 *   - 429 with `Retry-After` and 409 mid-poll both retry with backoff.
 *   - One warning per unique error class per `getUpdates` streak — five
 *     consecutive ETIMEDOUTs produce one log line, not five, and an
 *     ETIMEDOUT/ECONNRESET alternation produces two lines (one per class),
 *     not one per attempt. The set is cleared on every successful poll so a
 *     recovery resets logging fresh.
 *   - Never log URLs verbatim. They embed the bot token.
 *   - The base URL is hardcoded to https://api.telegram.org per Phase 0
 *     decision. No env override.
 *
 * Used by:
 *   - Phase 5 dispatcher (inbound long-poll → coordinator).
 *   - Phase 6 `ib tgsend` (outbound chunked sendMessage).
 */

import { InjectionContext } from "../types";
import type { FetchLike } from "../types";
import type { TelegramUpdate, TelegramMessage, TelegramApiResponse, TelegramFile } from "./types";

/** Hardcoded Bot API base URL. No env override (Phase 0 decision). */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Outbound message chunk size — leaves a safety margin under Telegram's
 *  4096-char hard cap. Used by both `sendMessage` chunking in Phase 6
 *  and the dispatcher fallback. */
export const TELEGRAM_CHUNK_LIMIT = 4000;

/** Exponential backoff bounds. Initial = 1s, capped at 30s. */
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** Per-request fetch timeouts. A dead TCP socket (e.g. after a Wi-Fi switch)
 *  otherwise hangs the request indefinitely while the OS waits to surface a
 *  TCP keepalive failure. The hard timeouts surface the disconnect as an
 *  AbortError within seconds so the retry loop wakes up. */
const GETUPDATES_TIMEOUT_BUFFER_MS = 10_000;
const PROBE_TIMEOUT_MS = 10_000;
const SENDMESSAGE_TIMEOUT_MS = 15_000;
// The typing indicator only lasts ~5s server-side; a longer timeout adds no
// value because the indicator would expire before the response mattered.
const SENDCHATACTION_TIMEOUT_MS = 5_000;
// getFile is a small JSON POST — same one-shot ceiling as sendMessage.
const GETFILE_TIMEOUT_MS = 15_000;
// Downloads and uploads can be megabytes over a slow link, so they need a
// far more generous deadline than the small JSON methods. 120s is well above
// what the 20 MB download / 50 MB upload caps need on a normal connection
// while still surfacing a dead socket eventually.
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SENDFILE_TIMEOUT_MS = 120_000;

/** Bot API `getFile` download ceiling. The standard Bot API refuses to serve
 *  files larger than 20 MB via `getFile` (a local Bot API server would be
 *  required for larger files). The dispatcher guards on this BEFORE attempting
 *  a download where the size is known, and again on the downloaded byte count. */
export const TELEGRAM_GETFILE_LIMIT_BYTES = 20 * 1024 * 1024;

/** Outbound `sendPhoto` size ceiling for bots (~10 MB). Photos above this are
 *  rejected locally with a clear message rather than an opaque API failure.
 *  (Telegram recompresses photos anyway — large originals should be sent as a
 *  document to preserve bytes.) */
export const TELEGRAM_SENDPHOTO_LIMIT_BYTES = 10 * 1024 * 1024;

/** Outbound `sendDocument` size ceiling for bots (~50 MB). */
export const TELEGRAM_SENDDOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;

/** Injectable fetch — defaults to globalThis.fetch. */
export const fetchCtx = new InjectionContext<FetchLike>(globalThis.fetch);

/** Injectable sleep — defaults to setTimeout. Tests fast-forward through it. */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sleepCtx = new InjectionContext<SleepFn>(defaultSleep);

/** Injectable logger — defaults to stderr. Tests capture invocations. */
export type LogFn = (line: string) => void;
const defaultLog: LogFn = (line) => process.stderr.write(line + "\n");
export const logCtx = new InjectionContext<LogFn>(defaultLog);

/** Hard chunk a string at `limit` chars. No paragraph awareness — v1 keeps it
 *  simple. Returns one chunk if the input fits, otherwise N hard-cut chunks.
 *
 *  Shape borrowed from official plugin server.ts:357-376; the `mode` param is
 *  dropped (no `newline` mode in v1). */
export function chunk(text: string, limit: number = TELEGRAM_CHUNK_LIMIT): string[] {
  if (limit <= 0) throw new Error("chunk limit must be > 0");
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    out.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest) out.push(rest);
  return out;
}

/** Classify an error into a stable string for one-warning-per-class dedup.
 *  We don't try to be exhaustive — just stable enough that a streak of
 *  identical errors collapses to one log line. Exported so callers logging
 *  network failures elsewhere (e.g. the dispatcher's probe path) can avoid
 *  surfacing raw `err.message`, which may embed URL fragments. */
export function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (code) return `errno:${code}`;
    if (err.name === "AbortError") return "AbortError";
    if (err.name && err.name !== "Error") return err.name;
    // Match grammy-style messages best-effort.
    const msg = err.message ?? "";
    if (msg.includes("ETIMEDOUT")) return "errno:ETIMEDOUT";
    if (msg.includes("ECONNRESET")) return "errno:ECONNRESET";
    if (msg.includes("ENOTFOUND")) return "errno:ENOTFOUND";
    if (msg.includes("EAI_AGAIN")) return "errno:EAI_AGAIN";
    return `Error:${msg.slice(0, 40)}`;
  }
  return `unknown:${String(err).slice(0, 40)}`;
}

/** Callback fired by `getUpdates` after each attempt. Used by the dispatcher's
 *  health state machine to track success/failure transitions without coupling
 *  the client to dispatcher internals. `'success'` fires after a 2xx response;
 *  the retry variant fires before the backoff sleep with the same `reason`
 *  string the client already emits to its log. */
export type PollOutcome =
  | "success"
  | { kind: "retry"; reason: string };

export type PollOutcomeFn = (outcome: PollOutcome) => void;

export interface GetUpdatesOptions {
  /** Last `update_id + 1` confirmed. Telegram drops everything strictly less. */
  offset?: number;
  /** Max updates per response (1-100). Default 100. */
  limit?: number;
  /** Long-poll seconds the server holds the request. Default 25. */
  timeout?: number;
  /** Update kinds to receive. Defaults to `["message", "message_reaction"]` —
   *  `message` for inbound text/attachments and `message_reaction` so the
   *  dispatcher learns when the user reacts to a message. Other kinds
   *  (edited_message, callback_query, etc.) are still excluded to cut payload
   *  noise. NOTE: `message_reaction` is NOT delivered by default by Telegram;
   *  it is only sent when explicitly listed here. */
  allowed_updates?: string[];
  /** AbortSignal from the caller — used by Phase 5 dispatcher to cancel
   *  in-flight long-poll on TUI exit. */
  signal?: AbortSignal;
  /** Optional hook fired after each attempt. Lets the dispatcher track
   *  success/failure state without re-implementing log parsing. */
  onPollOutcome?: PollOutcomeFn;
}

export interface SendMessageOptions {
  chat_id: number | string;
  text: string;
}

export interface SendChatActionOptions {
  chat_id: number | string;
  /** Telegram chat action — `"typing"` for the indicator we use. */
  action: string;
}

export interface SetMessageReactionOptions {
  chat_id: number | string;
  /** The message to react to. Per-chat identifier. */
  message_id: number;
  /** Reaction emoji to set. Must be from Telegram's documented reaction set
   *  (validated by the caller via {@link validateReactionEmoji}). An empty
   *  array clears the bot's reaction on the message. v1 only sends a single
   *  emoji or clears. */
  emoji: string | null;
}

/** Result of a single `setMessageReaction` POST. Mirrors {@link SendMessageResult}
 *  so callers honoring 429 backoff get the same `retryAfterSec` shape. The
 *  success result has no useful body (the API returns `true`), so we don't
 *  surface one. */
export type SetMessageReactionResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      error_code?: number;
      description?: string;
      retryAfterSec: number | null;
    };

/** Result of a single `sendMessage` POST. The failure variant exposes
 *  `retryAfterSec` parsed from BOTH the `Retry-After` HTTP header and the
 *  `parameters.retry_after` body field (header wins, body is the fallback)
 *  so callers can honor the server's actual backoff hint instead of guessing. */
export type SendMessageResult =
  | { ok: true; result: TelegramMessage }
  | {
      ok: false;
      status: number;
      error_code?: number;
      description?: string;
      retryAfterSec: number | null;
    };

/** Result of a `getFile` POST. The success variant carries the `file_path`
 *  needed to build the download URL; the failure variant mirrors
 *  {@link SendMessageResult} so callers can read status/description. */
export type GetFileResult =
  | { ok: true; file: TelegramFile }
  | {
      ok: false;
      status: number;
      error_code?: number;
      description?: string;
      retryAfterSec: number | null;
    };

/** Result of a `downloadFile` GET. On success the bytes are returned as a
 *  Uint8Array. The failure variant never includes the download URL (it embeds
 *  the token) — only a bounded status/reason. */
export type DownloadFileResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: number; reason: string };

export interface SendPhotoOptions {
  chat_id: number | string;
  /** Absolute path to a local file to upload as a photo (multipart). */
  path: string;
  /** Optional caption shown under the photo. */
  caption?: string;
}

export interface SendDocumentOptions {
  chat_id: number | string;
  /** Absolute path to a local file to upload as a document (multipart). */
  path: string;
  /** Optional caption shown under the document. */
  caption?: string;
}

/** Result of `sendPhoto` / `sendDocument`. Mirrors {@link SendMessageResult}
 *  so the outbox's 429-retry logic reads the same shape. */
export type SendFileResult =
  | { ok: true; result: TelegramMessage }
  | {
      ok: false;
      status: number;
      error_code?: number;
      description?: string;
      retryAfterSec: number | null;
    };

export interface TelegramClientOptions {
  /** Bot token from `~/.itsybitsy/config.json:channels.telegram.bot_token`. */
  token: string;
  /** Override base URL — reserved for tests. Production uses TELEGRAM_API_BASE. */
  baseUrl?: string;
}

/** HTTP response shape that pairs the parsed body with status + headers, so
 *  the retry logic can read `Retry-After` without re-parsing the response. */
interface RawResponse<T> {
  status: number;
  retryAfterSec: number | null;
  body: TelegramApiResponse<T> | null;
}

/** Categorical decision the retry loop makes about a single attempt. */
type AttemptOutcome<T> =
  | { kind: "ok"; result: T }
  | { kind: "abort" }
  | { kind: "retry"; reason: string; sleepMs: number | null };

/** TelegramClient — thin wrapper around the two Bot API methods we use.
 *
 *  Construction does not start any work; methods are lazy. Tests can spin up
 *  many clients with no side effects. Phase 5 owns instantiation. */
export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;

  /** Tracks every error class seen by `getUpdates` since the last successful
   *  poll, so a streak of errors logs at most one line per unique class.
   *  Cleared on every successful poll — a poll that recovers resets so the
   *  next streak can log fresh. (A `Set` rather than a single-slot tracker
   *  because alternating ETIMEDOUT/ECONNRESET would otherwise log every
   *  attempt instead of one line per class.) */
  private seenGetUpdatesErrorClasses: Set<string> = new Set();

  constructor(opts: TelegramClientOptions) {
    if (!opts.token) throw new Error("TelegramClient: token is required");
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? TELEGRAM_API_BASE;
  }

  /** Long-poll for updates with built-in resilience.
   *
   *  Wraps the Bot API `getUpdates` call in a `for(;;) try { ... } catch`
   *  loop. On any error — network, 429, 409, 5xx — we sleep with exponential
   *  backoff capped at 30s and continue. A successful poll resets the
   *  backoff. The loop only exits when the call succeeds or the caller's
   *  AbortSignal fires.
   *
   *  Returns the parsed `TelegramUpdate[]` array (possibly empty if the
   *  long-poll timed out with no updates). Throws only if the AbortSignal
   *  fires before any successful response. */
  async getUpdates(opts: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
    const allowed = opts.allowed_updates ?? ["message", "message_reaction"];
    const longPollSec = opts.timeout ?? 25;
    const params: Record<string, unknown> = {
      timeout: longPollSec,
      limit: opts.limit ?? 100,
      allowed_updates: allowed,
    };
    if (opts.offset !== undefined) params.offset = opts.offset;

    // The per-request timeout has to outlive the long-poll's server-side wait.
    // Telegram holds the request for `timeout` seconds; we add 10s buffer for
    // network latency + response framing. Past that, the socket is presumed
    // dead and we abort the fetch so the retry loop can wake up.
    const fetchTimeoutMs = longPollSec * 1_000 + GETUPDATES_TIMEOUT_BUFFER_MS;

    let attempt = 0;

    for (;;) {
      if (opts.signal?.aborted) {
        throw new DOMException("getUpdates aborted", "AbortError");
      }
      attempt += 1;

      const outcome = await this.attemptOnce<TelegramUpdate[]>(
        "getUpdates",
        params,
        opts.signal,
        fetchTimeoutMs,
      );

      if (outcome.kind === "ok") {
        this.seenGetUpdatesErrorClasses.clear();
        opts.onPollOutcome?.("success");
        return outcome.result;
      }
      if (outcome.kind === "abort") {
        throw new DOMException("getUpdates aborted", "AbortError");
      }

      // Retry path: notify the dispatcher hook (if any) and log once per
      // error class, then sleep with backoff.
      opts.onPollOutcome?.({ kind: "retry", reason: outcome.reason });
      if (!this.seenGetUpdatesErrorClasses.has(outcome.reason)) {
        this.seenGetUpdatesErrorClasses.add(outcome.reason);
        logCtx.fn(`telegram getUpdates: ${outcome.reason}, retrying with backoff`);
      }
      const sleepMs =
        outcome.sleepMs !== null ? outcome.sleepMs : computeBackoff(attempt);
      // Sleep is also abort-aware: fire abort during a long backoff and we
      // bail out of the loop instead of waking up to send another request.
      try {
        await abortableSleep(sleepMs, opts.signal);
      } catch {
        throw new DOMException("getUpdates aborted", "AbortError");
      }
    }
  }

  /** One-shot `getUpdates` probe used by the dispatcher's startup check.
   *
   *  Unlike `getUpdates()`, this does NOT retry — it surfaces HTTP errors as
   *  a `{ status }` outcome so the dispatcher can detect a 409 Conflict
   *  ("another poller or webhook is active") and skip starting the loop
   *  rather than retrying forever. Network throws are surfaced as-is.
   *
   *  Returns `{ ok: true, updates }` on a successful 2xx response with a
   *  parseable Telegram envelope, or `{ ok: false, status }` on any other
   *  HTTP status. The dispatcher only branches on 409 — other failures are
   *  logged via the API description and treated as "probe failed but go
   *  ahead and start the loop", since the loop has its own retry handling.
   */
  async probeOnce(
    opts: { offset?: number; limit?: number; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<
    | { ok: true; updates: TelegramUpdate[] }
    | { ok: false; status: number; description?: string }
  > {
    const params: Record<string, unknown> = {
      timeout: opts.timeout ?? 0,
      limit: opts.limit ?? 1,
      allowed_updates: ["message"],
    };
    if (opts.offset !== undefined) params.offset = opts.offset;

    const url = this.urlFor("getUpdates");
    // 10s timeout — the probe uses `timeout: 0` server-side so it should return
    // promptly. A dead socket otherwise hangs forever.
    const composedSignal = composeAbortSignal(opts.signal, PROBE_TIMEOUT_MS);
    const resp = await fetchCtx.fn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: composedSignal,
    });
    const raw = await readRaw<TelegramUpdate[]>(resp);
    if (raw.status >= 200 && raw.status < 300 && raw.body?.ok === true) {
      return { ok: true, updates: (raw.body.result ?? []) as TelegramUpdate[] };
    }
    const description = raw.body?.description;
    if (description !== undefined) {
      return { ok: false, status: raw.status, description };
    }
    return { ok: false, status: raw.status };
  }

  /** POST `sendMessage`. No retry loop — outbound is one-shot from the caller's
   *  perspective. Phase 6 (`ib tgsend`) wraps this with one 429-retry of its
   *  own; the dispatcher (Phase 5) doesn't retry on outbound failures.
   *
   *  Goes through `readRaw` so the `Retry-After` HTTP header is read alongside
   *  the body's `parameters.retry_after`. Callers honoring 429 backoff should
   *  prefer the returned `retryAfterSec` over `parameters?.retry_after`, since
   *  Telegram occasionally sends the header without a body parameter. */
  async sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
    const body = JSON.stringify({ chat_id: opts.chat_id, text: opts.text });
    const url = this.urlFor("sendMessage");
    // 15s per-attempt timeout — outbound is one-shot; a dead socket otherwise
    // stalls the outbox queue indefinitely.
    const composedSignal = composeAbortSignal(undefined, SENDMESSAGE_TIMEOUT_MS);
    const resp = await fetchCtx.fn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: composedSignal,
    });
    const raw = await readRaw<TelegramMessage>(resp);
    if (raw.status >= 200 && raw.status < 300 && raw.body?.ok === true) {
      return { ok: true, result: (raw.body.result ?? {}) as TelegramMessage };
    }
    logCtx.fn(`telegram sendMessage: status=${raw.status}`);
    return {
      ok: false,
      status: raw.status,
      error_code: raw.body?.error_code ?? raw.status,
      description: raw.body?.description ?? `HTTP ${raw.status}`,
      retryAfterSec: raw.retryAfterSec,
    };
  }

  /** POST `sendChatAction`. Best-effort and silent: never throws, never logs.
   *
   *  The typing indicator is cosmetic — re-armed by hooks on prompt submit and
   *  after every tool use — so a flaky network or misconfigured token must not
   *  spam the agent log. We swallow every error class (network throw, non-2xx,
   *  malformed body) and return void. */
  async sendChatAction(opts: SendChatActionOptions): Promise<void> {
    try {
      const body = JSON.stringify({ chat_id: opts.chat_id, action: opts.action });
      const url = this.urlFor("sendChatAction");
      const composedSignal = composeAbortSignal(undefined, SENDCHATACTION_TIMEOUT_MS);
      await fetchCtx.fn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: composedSignal,
      });
    } catch {
      // Cosmetic indicator — never surface failures.
    }
  }

  /** POST `setMessageReaction`. No retry loop — outbound is one-shot from the
   *  caller's perspective, same contract as {@link sendMessage}. The outbox
   *  wraps this with a single 429-retry of its own.
   *
   *  `emoji` is sent as a one-element `reaction` array `[{type:"emoji",emoji}]`;
   *  passing `null` sends an empty `reaction` array, which clears the bot's
   *  reaction. The caller is responsible for validating the emoji against
   *  Telegram's documented set (see `validateReactionEmoji`) — this method
   *  sends whatever it is handed.
   *
   *  Goes through `readRaw` so `Retry-After` is read from both the HTTP header
   *  and `parameters.retry_after`. */
  async setMessageReaction(opts: SetMessageReactionOptions): Promise<SetMessageReactionResult> {
    const reaction =
      opts.emoji === null ? [] : [{ type: "emoji", emoji: opts.emoji }];
    const body = JSON.stringify({
      chat_id: opts.chat_id,
      message_id: opts.message_id,
      reaction,
    });
    const url = this.urlFor("setMessageReaction");
    const composedSignal = composeAbortSignal(undefined, SENDMESSAGE_TIMEOUT_MS);
    const resp = await fetchCtx.fn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: composedSignal,
    });
    const raw = await readRaw<boolean>(resp);
    if (raw.status >= 200 && raw.status < 300 && raw.body?.ok === true) {
      return { ok: true };
    }
    logCtx.fn(`telegram setMessageReaction: status=${raw.status}`);
    return {
      ok: false,
      status: raw.status,
      error_code: raw.body?.error_code ?? raw.status,
      description: raw.body?.description ?? `HTTP ${raw.status}`,
      retryAfterSec: raw.retryAfterSec,
    };
  }

  /** POST `getFile`. Resolves a `file_id` to a {@link TelegramFile} carrying the
   *  `file_path` needed for {@link downloadFile}. No retry loop — the dispatcher
   *  treats a failure as "skip this attachment" rather than retrying.
   *
   *  Goes through `readRaw`, so `Retry-After` is available on a 429 (though the
   *  inbound path doesn't currently retry it). Never logs the URL. */
  async getFile(fileId: string): Promise<GetFileResult> {
    const body = JSON.stringify({ file_id: fileId });
    const url = this.urlFor("getFile");
    const composedSignal = composeAbortSignal(undefined, GETFILE_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetchCtx.fn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: composedSignal,
      });
    } catch (err) {
      // Consistent with downloadFile / sendMultipartFile: surface a stable,
      // token-safe label rather than letting a network throw (whose message
      // could embed the bot-token URL) propagate to the dispatcher.
      return { ok: false, status: 0, error_code: 0, description: classifyError(err), retryAfterSec: null };
    }
    const raw = await readRaw<TelegramFile>(resp);
    if (raw.status >= 200 && raw.status < 300 && raw.body?.ok === true) {
      return { ok: true, file: (raw.body.result ?? {}) as TelegramFile };
    }
    logCtx.fn(`telegram getFile: status=${raw.status}`);
    return {
      ok: false,
      status: raw.status,
      error_code: raw.body?.error_code ?? raw.status,
      description: raw.body?.description ?? `HTTP ${raw.status}`,
      retryAfterSec: raw.retryAfterSec,
    };
  }

  /** GET the file bytes from `https://api.telegram.org/file/bot<token>/<file_path>`.
   *
   *  CRITICAL: the download URL embeds the bot token. It is NEVER logged — on
   *  any failure we surface only an HTTP status or a `classifyError()` label,
   *  never the URL or a raw `err.message` (which could contain the URL). The
   *  caller (dispatcher) is responsible for the 20 MB size guard; this method
   *  also refuses to buffer a body whose `Content-Length` already exceeds the
   *  limit so a malicious/oversized response can't blow up memory.
   *
   *  Returns the bytes as a Uint8Array on success. */
  async downloadFile(filePath: string): Promise<DownloadFileResult> {
    const url = this.fileUrlFor(filePath);
    const composedSignal = composeAbortSignal(undefined, DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetchCtx.fn(url, { method: "GET", signal: composedSignal });
    } catch (err) {
      // classifyError, never err.message — the latter could embed the
      // token-bearing URL.
      return { ok: false, status: 0, reason: classifyError(err) };
    }
    if (resp.status < 200 || resp.status >= 300) {
      logCtx.fn(`telegram downloadFile: status=${resp.status}`);
      return { ok: false, status: resp.status, reason: `HTTP ${resp.status}` };
    }
    // Guard on the advertised length before buffering — refuse oversized bodies
    // up front so a 20 MB+ file never lands in memory.
    const lenHeader = resp.headers.get("content-length");
    if (lenHeader !== null) {
      const len = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > TELEGRAM_GETFILE_LIMIT_BYTES) {
        return {
          ok: false,
          status: resp.status,
          reason: `file too large (${len} bytes > ${TELEGRAM_GETFILE_LIMIT_BYTES} limit)`,
        };
      }
    }
    let buf: ArrayBuffer;
    try {
      buf = await resp.arrayBuffer();
    } catch (err) {
      return { ok: false, status: resp.status, reason: classifyError(err) };
    }
    // Second guard on the actual byte count — a chunked response may omit
    // Content-Length, so we re-check after buffering.
    if (buf.byteLength > TELEGRAM_GETFILE_LIMIT_BYTES) {
      return {
        ok: false,
        status: resp.status,
        reason: `file too large (${buf.byteLength} bytes > ${TELEGRAM_GETFILE_LIMIT_BYTES} limit)`,
      };
    }
    return { ok: true, bytes: new Uint8Array(buf) };
  }

  /** POST `sendPhoto` with a LOCAL file uploaded as multipart/form-data.
   *
   *  Telegram recompresses photos sent this way — callers wanting exact bytes
   *  (e.g. a PNG diff) should use {@link sendDocument} instead. No retry loop;
   *  the outbox wraps this with a single 429-retry. Never logs the URL. */
  async sendPhoto(opts: SendPhotoOptions): Promise<SendFileResult> {
    return this.sendMultipartFile("sendPhoto", "photo", opts.chat_id, opts.path, opts.caption);
  }

  /** POST `sendDocument` with a LOCAL file uploaded as multipart/form-data.
   *  Preserves the exact bytes (no recompression). Same contract as
   *  {@link sendPhoto}. */
  async sendDocument(opts: SendDocumentOptions): Promise<SendFileResult> {
    return this.sendMultipartFile("sendDocument", "document", opts.chat_id, opts.path, opts.caption);
  }

  /** Shared multipart upload for sendPhoto / sendDocument. Builds a `FormData`
   *  with `Bun.file(path)` (no new dependency, no manual boundary handling) and
   *  POSTs it. The `Content-Type: multipart/form-data` boundary header is set
   *  by the runtime from the FormData body — we must NOT set it ourselves.
   *
   *  Never logs the URL. On a fetch throw we surface `classifyError()` so a
   *  token-bearing URL can't leak via `err.message`. */
  private async sendMultipartFile(
    method: string,
    field: "photo" | "document",
    chatId: number | string,
    path: string,
    caption: string | undefined,
  ): Promise<SendFileResult> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption !== undefined && caption !== "") form.append("caption", caption);
    // Bun.file is lazy — the bytes stream from disk into the request body.
    form.append(field, Bun.file(path));

    const url = this.urlFor(method);
    const composedSignal = composeAbortSignal(undefined, SENDFILE_TIMEOUT_MS);
    let resp: Response;
    try {
      // No explicit content-type header: the runtime derives the multipart
      // boundary from the FormData body. Setting it manually breaks parsing.
      resp = await fetchCtx.fn(url, { method: "POST", body: form, signal: composedSignal });
    } catch (err) {
      // Surface as a non-2xx-shaped failure so the outbox formats it uniformly.
      // classifyError, never err.message (token-bearing URL safety).
      logCtx.fn(`telegram ${method}: ${classifyError(err)}`);
      return {
        ok: false,
        status: 0,
        error_code: 0,
        description: classifyError(err),
        retryAfterSec: null,
      };
    }
    const raw = await readRaw<TelegramMessage>(resp);
    if (raw.status >= 200 && raw.status < 300 && raw.body?.ok === true) {
      return { ok: true, result: (raw.body.result ?? {}) as TelegramMessage };
    }
    logCtx.fn(`telegram ${method}: status=${raw.status}`);
    return {
      ok: false,
      status: raw.status,
      error_code: raw.body?.error_code ?? raw.status,
      description: raw.body?.description ?? `HTTP ${raw.status}`,
      retryAfterSec: raw.retryAfterSec,
    };
  }

  /** Single attempt at a Bot API method. Maps HTTP / parse outcomes onto the
   *  `AttemptOutcome` discriminated union the retry loop reads.
   *
   *  `timeoutMs` adds a per-request hard deadline composed with the user's
   *  signal. We distinguish the timer firing from the user firing the user's
   *  own signal by checking `signal.aborted` after a catch — only the user's
   *  abort terminates the loop. The timer-fired abort is reported as a
   *  retryable timeout so the loop wakes up and tries again. */
  private async attemptOnce<T>(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<AttemptOutcome<T>> {
    const url = this.urlFor(method);
    const composedSignal = composeAbortSignal(signal, timeoutMs);
    let raw: RawResponse<T>;
    try {
      const resp = await fetchCtx.fn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: composedSignal,
      });
      raw = await readRaw<T>(resp);
    } catch (err) {
      // Distinguish a user-fired abort (terminate the loop) from a timer-fired
      // abort (retry as a transient timeout). Only the user's own signal — not
      // the composed signal — should end the loop. AbortSignal.timeout firing
      // looks identical at the AbortError level, so we have to check whose
      // signal it was.
      if (signal?.aborted) {
        return { kind: "abort" };
      }
      if (isAbortError(err)) {
        // Timer-fired: surface as a retryable timeout so the outer loop sleeps
        // and tries again.
        return { kind: "retry", reason: "errno:ETIMEDOUT", sleepMs: null };
      }
      // Network/DNS — sleep with exponential backoff.
      return { kind: "retry", reason: classifyError(err), sleepMs: null };
    }

    if (raw.status === 429) {
      const sleepMs = (raw.retryAfterSec ?? 1) * 1000;
      return { kind: "retry", reason: "429 Too Many Requests", sleepMs };
    }
    if (raw.status === 409) {
      // Mid-poll 409: another poller is fighting for the token. Plan calls
      // for backoff-and-retry here (different from startup-probe 409, which
      // Phase 5 handles by returning early — we never see that here).
      return { kind: "retry", reason: "409 Conflict", sleepMs: null };
    }
    if (raw.status >= 500) {
      return { kind: "retry", reason: `HTTP ${raw.status}`, sleepMs: null };
    }
    if (raw.status < 200 || raw.status >= 300) {
      // 4xx other than 429 — surface and retry. A persistent 401 (bad token)
      // will spam the log; we accept that for v1, since the user's escape
      // hatch is "unset the token in config and restart ib watch."
      return { kind: "retry", reason: `HTTP ${raw.status}`, sleepMs: null };
    }
    if (!raw.body || raw.body.ok !== true) {
      const desc = raw.body?.description ?? "no body";
      return { kind: "retry", reason: `bad envelope: ${desc.slice(0, 40)}`, sleepMs: null };
    }
    return { kind: "ok", result: (raw.body.result as T) ?? ([] as unknown as T) };
  }

  /** Build the per-method URL. Never logged verbatim — it embeds the token. */
  private urlFor(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  /** Build the file-download URL. The download endpoint is `/file/bot<token>/...`
   *  (note the `/file/` prefix, distinct from the method URL). Like `urlFor`,
   *  it embeds the token and must NEVER be logged. */
  private fileUrlFor(filePath: string): string {
    return `${this.baseUrl}/file/bot${this.token}/${filePath}`;
  }
}

/** Read a Response into the shape the retry loop wants. Tolerates a
 *  non-JSON body; downstream callers treat a missing body as "retry." */
async function readRaw<T>(resp: Response): Promise<RawResponse<T>> {
  const status = resp.status;
  const retryAfterHeader = resp.headers.get("retry-after");
  let body: TelegramApiResponse<T> | null = null;
  try {
    body = (await resp.json()) as TelegramApiResponse<T>;
  } catch {
    body = null;
  }
  let retryAfterSec: number | null = null;
  if (retryAfterHeader !== null && retryAfterHeader !== "") {
    const n = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(n) && n >= 0) retryAfterSec = n;
  }
  // Telegram also encodes Retry-After in `parameters.retry_after` on 429 bodies.
  if (retryAfterSec === null && body?.parameters?.retry_after !== undefined) {
    retryAfterSec = body.parameters.retry_after;
  }
  return { status, retryAfterSec, body };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    // `AbortSignal.timeout` surfaces as TimeoutError; an AbortController-fired
    // abort surfaces as AbortError. Both indicate a cancelled fetch.
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  }
  return false;
}

/** Compose a user-supplied AbortSignal with a per-request timeout into one
 *  signal that fires on whichever happens first. The caller still owns the
 *  user-supplied signal and can inspect `userSignal?.aborted` after a catch
 *  to distinguish "user cancelled" from "timeout fired" — they look identical
 *  at the AbortError level but one ends the loop and the other retries.
 *
 *  Uses `AbortSignal.any` (Bun >=1.0) when both inputs exist; if only the
 *  timer is needed we use `AbortSignal.timeout` directly to avoid the wrapper. */
function composeAbortSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timer;
  return AbortSignal.any([userSignal, timer]);
}

/** Standard exponential backoff capped at BACKOFF_MAX_MS. */
function computeBackoff(attempt: number): number {
  // attempt is 1-indexed in the retry loop. 1->1s, 2->2s, 3->4s ... cap 30s.
  const exp = Math.min(BACKOFF_INITIAL_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  return exp;
}

/** Sleep that resolves on the AbortSignal too. Throws on abort so callers can
 *  unwind cleanly. */
async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await sleepCtx.fn(ms);
    return;
  }
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  // Race the injected sleep against an abort listener. We always honor the
  // injected sleep so tests can fast-forward.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleepCtx
      .fn(ms)
      .then(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}
