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
 *   - One warning per error class per call site — five consecutive ETIMEDOUTs
 *     produce one log line, not five.
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
import type { TelegramUpdate, TelegramMessage, TelegramApiResponse } from "./types";

/** Hardcoded Bot API base URL. No env override (Phase 0 decision). */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Outbound message chunk size — leaves a safety margin under Telegram's
 *  4096-char hard cap. Used by both `sendMessage` chunking in Phase 6
 *  and the dispatcher fallback. */
export const TELEGRAM_CHUNK_LIMIT = 4000;

/** Exponential backoff bounds. Initial = 1s, capped at 30s. */
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

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
 *  identical errors collapses to one log line. */
function classifyError(err: unknown): string {
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

export interface GetUpdatesOptions {
  /** Last `update_id + 1` confirmed. Telegram drops everything strictly less. */
  offset?: number;
  /** Max updates per response (1-100). Default 100. */
  limit?: number;
  /** Long-poll seconds the server holds the request. Default 25. */
  timeout?: number;
  /** Update kinds to receive. Defaults to `["message"]` to cut payload noise
   *  (no edited_message, no callback_query, etc.). */
  allowed_updates?: string[];
  /** AbortSignal from the caller — used by Phase 5 dispatcher to cancel
   *  in-flight long-poll on TUI exit. */
  signal?: AbortSignal;
}

export interface SendMessageOptions {
  chat_id: number | string;
  text: string;
}

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

  /** Tracks the last error class seen by `getUpdates` so consecutive errors
   *  of the same class log only once. Reset on every successful poll. */
  private lastGetUpdatesErrorClass: string | null = null;

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
    const allowed = opts.allowed_updates ?? ["message"];
    const params: Record<string, unknown> = {
      timeout: opts.timeout ?? 25,
      limit: opts.limit ?? 100,
      allowed_updates: allowed,
    };
    if (opts.offset !== undefined) params.offset = opts.offset;

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
      );

      if (outcome.kind === "ok") {
        this.lastGetUpdatesErrorClass = null;
        return outcome.result;
      }
      if (outcome.kind === "abort") {
        throw new DOMException("getUpdates aborted", "AbortError");
      }

      // Retry path: log once per error class, then sleep with backoff.
      if (this.lastGetUpdatesErrorClass !== outcome.reason) {
        this.lastGetUpdatesErrorClass = outcome.reason;
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

  /** POST `sendMessage`. No retry loop — outbound is one-shot from the caller's
   *  perspective. Phase 6 (`ib tgsend`) wraps this with one 429-retry of its
   *  own; the dispatcher (Phase 5) doesn't retry on outbound failures. */
  async sendMessage(opts: SendMessageOptions): Promise<TelegramApiResponse<TelegramMessage>> {
    const body = JSON.stringify({ chat_id: opts.chat_id, text: opts.text });
    const url = this.urlFor("sendMessage");
    const resp = await fetchCtx.fn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const status = resp.status;
    const parsed = (await resp.json().catch(() => null)) as TelegramApiResponse<TelegramMessage> | null;
    if (!resp.ok || !parsed?.ok) {
      logCtx.fn(`telegram sendMessage: status=${status}`);
      // Surface the parsed body when present so callers can decide retry/exit;
      // the v1 contract is "return what we got, let the caller branch."
      return parsed ?? { ok: false, error_code: status, description: `HTTP ${status}` };
    }
    return parsed;
  }

  /** Single attempt at a Bot API method. Maps HTTP / parse outcomes onto the
   *  `AttemptOutcome` discriminated union the retry loop reads. */
  private async attemptOnce<T>(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<AttemptOutcome<T>> {
    const url = this.urlFor(method);
    let raw: RawResponse<T>;
    try {
      const resp = await fetchCtx.fn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
      raw = await readRaw<T>(resp);
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        return { kind: "abort" };
      }
      // Network/DNS/timeout — sleep with exponential backoff.
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
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
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
