/**
 * Boot of the Telegram subsystem.
 *
 * `ib watch` calls {@link bootTelegramSubsystem} during launch. Each step
 * gates the next; a permanent failure logs one stderr line and leaves the rest
 * of the dashboard running normally:
 *
 *   1. Connect — token must be set, and a non-consuming probe must succeed.
 *      A 409 Conflict means another poller/webhook is active; 401/403 mean
 *      the token is rejected; any other 4xx is logged as `probe failed`.
 *      These are permanent: routing stays off until `ib watch` restarts.
 *      A TRANSIENT failure — a fetch throw or timeout, status 0, 429, any
 *      5xx ({@link isTransientStatus}), or a 2xx whose body could not be read
 *      (`HTTP 200 (bad body)`) — is NOT: the probe is retried with
 *      capped, jittered backoff (1 s doubling to 60 s; a 429 waits at least
 *      its `Retry-After`) until it succeeds or `signal` fires. A Telegram
 *      outage at `ib watch` start used to disable routing for the whole
 *      session (watch.log 2026-11-20: `probe failed (The operation timed
 *      out.)` during a run of 502s). The first failure and each new error
 *      class are logged once (`Telegram connect failed (HTTP 502); retrying
 *      with backoff`), recovery once (`Telegram connected after 40s`), and
 *      `onRetry` reports every retry so the dashboard can show `connecting`.
 *      A wake from sleep (`wake`) cancels the in-flight probe or backoff wait
 *      and probes again at once with a fresh backoff.
 *   1.5. Cache lookup — read the on-disk chat-id cache (see
 *      {@link "./chat-id-cache"}). If a cached id is present AND that id is
 *      still in the allowlist, skip step 2 entirely and proceed with the
 *      cached id (no `initialOffset` is computed in this path; the
 *      dispatcher's own startup probe seeds its offset). The allowlist
 *      check guards against the user removing the chat between runs.
 *      Cache invalidation: a 401/403 startup probe in the dispatcher
 *      clears the cache so the next boot re-resolves.
 *   2. Resolve chat ID — call probeOnce again with limit=100 and walk the
 *      returned updates (same transient-retry rule as step 1). Two paths:
 *
 *        - **Configured allowlist** (any chat or user id present): pick the
 *          first private-chat update whose chat.id is in `allowed_chat_ids`.
 *
 *        - **Trust-on-first-use** (both lists empty — i.e. never configured):
 *          gather distinct private chat ids from the probe. Exactly one ⇒
 *          auto-add it via {@link addChat} and use it. Two or more ⇒ refuse
 *          to guess (returns `ambiguous-first-use`); the user must run
 *          `ib tgallow <id>` to disambiguate. Zero ⇒ same outcome as the
 *          configured-but-no-match case (returns `no-allowlisted-inbound`).
 *
 *      The resolved id is written to the cache so the next `ib watch` start
 *      skips this step entirely. Runs only on a cache miss.
 *   3. Start subsystem — instantiate {@link TelegramDispatcher} with the
 *      resolved chat id and (on the resolve path only) an offset hint =
 *      max(consumed update_id) + 1, and instantiate {@link TelegramOutbox}
 *      with the same client and chat id. The dispatcher's first long-poll
 *      skips updates step 2 already saw; the outbox owns the file-drop
 *      queue from `ib tgsend`.
 *
 * Returns a {@link BootResult} describing the outcome. The caller owns both
 * dispatcher and outbox lifecycles (start/stop). When `ok` is false neither
 * is constructed — caller skips shutdown.
 */

import type { TelegramClient } from "./telegram-client";
import { abortableSleep, classifyError, isAbortError, isTransientStatus } from "./telegram-client";
import type { TelegramDispatcher, DispatcherOptions } from "./dispatcher";
import type { TelegramOutbox, OutboxOptions } from "./outbox";
import type { AccessState } from "./access";
import type { TelegramUpdate } from "./types";
import type { WakeSource } from "./wake-detector";
import { addChat } from "./access";
import { readCachedChatId, writeCachedChatId } from "./chat-id-cache";
import { backoffDelayMs, type BackoffOptions } from "./backoff";

/** Probe retry bounds: 1 s doubling to a 60 s cap, jittered (backoff.ts). */
const BOOT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 60_000 };

/** Successful boot — dispatcher and outbox are constructed (not yet started). */
export interface BootSuccess {
  ok: true;
  chatId: string;
  dispatcher: TelegramDispatcher;
  outbox: TelegramOutbox;
}

/** Subsystem disabled — log line was emitted, no dispatcher.
 *
 *  `probe-other` covers a probe 4xx other than 401/403/409/429 (e.g. 404 for a
 *  malformed token) and a failed allowlist write. `aborted` means `signal`
 *  fired while boot was still retrying a transient failure (ib watch quit).
 *  There is no network-failure reason: a network failure is retried, never
 *  returned. */
export interface BootDisabled {
  ok: false;
  reason:
    | "no-token"
    | "probe-409"
    | "probe-auth"
    | "probe-other"
    | "no-allowlisted-inbound"
    | "ambiguous-first-use"
    | "aborted";
  /** The exact stderr line that was logged. Surfaced for tests/observability. */
  message: string;
}

/** One transient probe failure, reported through {@link BootOptions.onRetry}
 *  before boot waits to probe again. */
export interface BootRetryInfo {
  /** Token-safe label: `HTTP 502`, `429 Too Many Requests`, `errno:ETIMEDOUT`,
   *  or another `classifyError()` label. Never a URL. */
  reason: string;
  /** Consecutive failures in this streak, 1-indexed. */
  attempt: number;
  /** How long boot waits before the next probe. */
  delayMs: number;
}

export type BootResult = BootSuccess | BootDisabled;

/** Injected log function — defaults to stderr. Tests capture invocations. */
export type LogFn = (line: string) => void;
const defaultLog: LogFn = (line) => process.stderr.write(line + "\n");

/** Factory for the dispatcher. Tests inject a fake constructor to capture
 *  the options passed in step 3 without booting a real long-poll loop. */
export type DispatcherFactory = (opts: DispatcherOptions) => TelegramDispatcher;

/** Factory for the outbox. Tests inject a fake to capture options without
 *  installing a real fs.watch. */
export type OutboxFactory = (opts: OutboxOptions) => TelegramOutbox;

export interface BootOptions {
  /** Bot token from config. Empty/unset → returns "no-token" disabled result. */
  token: string;
  /** Allowlist read once at boot. The dispatcher receives both lists; chat-id
   *  resolution only consults `allowed_chat_ids` (an inferred chat is by
   *  definition the chat the bot is talking with — user-id allowlisting is a
   *  separate path). */
  access: AccessState;
  /** Construct a {@link TelegramClient} from the token. Injected so tests
   *  can pass a client wired to a mock fetch without booting real network. */
  buildClient: (token: string) => TelegramClient;
  /** Construct a {@link TelegramDispatcher}. Injected for tests. Defaults
   *  to `new TelegramDispatcher(opts)` in production. */
  buildDispatcher: DispatcherFactory;
  /** Construct a {@link TelegramOutbox}. Injected for tests. Defaults to
   *  `new TelegramOutbox(opts)` in production. */
  buildOutbox: OutboxFactory;
  /** Log sink — defaults to stderr. */
  log?: LogFn;
  /** Aborted when `ib watch` quits. A boot still retrying a transient probe
   *  failure cancels its in-flight probe or backoff wait and returns
   *  `aborted`. */
  signal?: AbortSignal;
  /** Called after each transient probe failure, before the backoff wait.
   *  The dashboard shows `connecting` with the reason. */
  onRetry?: (info: BootRetryInfo) => void;
  /** Wake-from-sleep events (wake-detector.ts). A wake while boot is retrying
   *  cuts the in-flight probe or backoff wait short and probes again at once
   *  with a fresh backoff. */
  wake?: WakeSource;
  /** Clock for the `connected after Ns` line. Defaults to `Date.now`. */
  now?: () => number;
}

/** Boot. See module-level docstring. */
export async function bootTelegramSubsystem(opts: BootOptions): Promise<BootResult> {
  const log = opts.log ?? defaultLog;

  // Step 1 — connect.
  if (opts.token === "") {
    const message = "Telegram routing disabled: no bot token configured";
    log(message);
    return { ok: false, reason: "no-token", message };
  }

  const client = opts.buildClient(opts.token);
  const prober = new RetryingProber(client, log, opts);
  const unsubscribeWake = opts.wake?.onWake(() => prober.wake());
  try {
    return await bootWithProber(opts, log, client, prober);
  } finally {
    unsubscribeWake?.();
  }
}

/** Steps 1 (probe result) through 3. Split out so the wake subscription is
 *  released on every return path. */
async function bootWithProber(
  opts: BootOptions,
  log: LogFn,
  client: TelegramClient,
  prober: RetryingProber,
): Promise<BootResult> {
  // limit:1, timeout:0 — a non-consuming probe (no offset, so Telegram
  // returns the oldest pending update without acknowledging it). We only
  // care about HTTP success here; the inferred-chat-id step does its own
  // probe with a higher limit.
  const probe = await prober.probe({ timeout: 0, limit: 1 });
  if (probe.kind === "aborted") return abortedResult(log);
  if (probe.kind === "permanent") return permanentProbeFailure(probe.status, log);

  const allowedChats = new Set(opts.access.allowed_chat_ids.map(String));
  // Trust-on-first-use only fires when the allowlist has never been configured
  // — both lists empty. Once a single id has been added (manually or
  // auto-added by a previous boot), this flag goes false and the boot falls
  // back to strict matching forever after.
  const firstUse =
    opts.access.allowed_chat_ids.length === 0 && opts.access.allowed_user_ids.length === 0;
  // The dispatcher receives the (possibly mutated) allowlist; we re-read it
  // from this slot rather than `opts.access` so an auto-allow in step 2 is
  // visible to the dispatcher's incoming-update filter.
  let dispatcherAllowedChatIds = opts.access.allowed_chat_ids;

  // Step 1.5 — cache lookup. If a cached id exists AND it's still in the
  // allowlist, skip the inbound walk. We don't compute an `initialOffset` in
  // this path: the dispatcher's own startup probe seeds its offset from the
  // first long-poll. The allowlist check guards against the user removing
  // the chat between runs. First-use boots have an empty allowlist by
  // definition — `allowedChats.has(...)` is always false — so the cache is
  // skipped and we always fall through to the inbound walk.
  let resolvedChatId: string | null = null;
  let initialOffset: number | undefined;
  const cachedId = await readCachedChatId();
  if (cachedId !== null && allowedChats.has(cachedId)) {
    resolvedChatId = cachedId;
  }

  if (resolvedChatId === null) {
    // Step 2 — resolve chat ID via inbound inference. Use a fresh probe with
    // limit=100 so we walk a meaningful slice of pending updates. We pass no
    // offset so we don't acknowledge anything — the dispatcher's first
    // getUpdates call will use the offset hint we hand it to skip past what
    // we've already seen.
    const resolveProbe = await prober.probe({ timeout: 0, limit: 100 });
    if (resolveProbe.kind === "aborted") return abortedResult(log);
    // Same classification as step 1's probe — a follow-up failure is
    // surfaced the same way. Should be rare given step 1 just succeeded.
    if (resolveProbe.kind === "permanent") return permanentProbeFailure(resolveProbe.status, log);

    // Single pass over updates: track the highest consumed id (for the
    // dispatcher offset hint), the first match against an existing
    // allowlist (the configured-allowlist path), and the set of distinct
    // private chat ids seen (the first-use path).
    let maxConsumedId = -1;
    const distinctPrivateChats = new Set<string>();
    for (const update of resolveProbe.updates) {
      if (update.update_id > maxConsumedId) maxConsumedId = update.update_id;
      const msg = update.message;
      if (!msg) continue;
      if (msg.chat?.type !== "private") continue;
      const chatId = msg.chat?.id;
      if (chatId === undefined || chatId === null) continue;
      const chatIdStr = String(chatId);
      distinctPrivateChats.add(chatIdStr);
      if (resolvedChatId === null && allowedChats.has(chatIdStr)) {
        resolvedChatId = chatIdStr;
      }
    }

    if (resolvedChatId === null && firstUse) {
      // Trust-on-first-use. Exactly one private chat ⇒ adopt it. Anything
      // else (zero or 2+) leaves resolvedChatId null and falls through to
      // the per-case error below.
      if (distinctPrivateChats.size === 1) {
        const onlyId = distinctPrivateChats.values().next().value as string;
        try {
          await addChat(onlyId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const message = `Telegram routing disabled: failed to write allowlist (${shortReason(reason)})`;
          log(message);
          return { ok: false, reason: "probe-other", message };
        }
        log(
          `Telegram first-use auto-allowlist: added chat ${onlyId} (only inbound private chat). Use \`ib tgdeny ${onlyId}\` to revoke.`,
        );
        resolvedChatId = onlyId;
        dispatcherAllowedChatIds = [onlyId];
      } else if (distinctPrivateChats.size >= 2) {
        const sample = Array.from(distinctPrivateChats).slice(0, 3).join(", ");
        const more = distinctPrivateChats.size > 3 ? `, +${distinctPrivateChats.size - 3} more` : "";
        const message = `Telegram routing disabled: ${distinctPrivateChats.size} private chats are pending (${sample}${more}); refusing to guess. Run \`ib tgallow <chat_id>\` to pick one.`;
        log(message);
        return { ok: false, reason: "ambiguous-first-use", message };
      }
      // size === 0: fall through to no-allowlisted-inbound below.
    }

    if (resolvedChatId === null) {
      const message =
        "Telegram routing disabled: no recent inbound from an allowlisted private chat. DM your bot, then restart ib watch.";
      log(message);
      return { ok: false, reason: "no-allowlisted-inbound", message };
    }

    initialOffset = maxConsumedId >= 0 ? maxConsumedId + 1 : undefined;

    // Persist the resolved chat id so the next boot can skip step 2. Best
    // effort — a write failure is logged but does not fail the boot.
    try {
      await writeCachedChatId(resolvedChatId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`Telegram chat-id cache write failed: ${shortReason(reason)}`);
    }
  }

  // Step 3 — construct dispatcher and outbox. Both share the resolved chat id;
  // the caller starts each independently.
  const dispatcher = opts.buildDispatcher({
    client,
    allowedChatIds: dispatcherAllowedChatIds,
    allowedUserIds: opts.access.allowed_user_ids,
    chatId: resolvedChatId,
    initialOffset,
  });
  const outbox = opts.buildOutbox({
    client,
    chatId: resolvedChatId,
  });

  return { ok: true, chatId: resolvedChatId, dispatcher, outbox };
}

/** A probe outcome boot acts on. Transient failures never surface here: the
 *  prober retries them. */
type ProbeOutcome =
  | { kind: "ok"; updates: TelegramUpdate[] }
  | { kind: "permanent"; status: number }
  | { kind: "aborted" };

/** Disabled result for a non-transient probe status. Messages and reasons
 *  are unchanged from before the transient retry existed. */
function permanentProbeFailure(status: number, log: LogFn): BootDisabled {
  if (status === 409) {
    const message = "Telegram routing disabled: another poller or webhook is active";
    log(message);
    return { ok: false, reason: "probe-409", message };
  }
  if (status === 401 || status === 403) {
    const message = `Telegram routing disabled: bot token rejected (HTTP ${status})`;
    log(message);
    return { ok: false, reason: "probe-auth", message };
  }
  const message = `Telegram routing disabled: probe failed (HTTP ${status})`;
  log(message);
  return { ok: false, reason: "probe-other", message };
}

function abortedResult(log: LogFn): BootDisabled {
  const message = "Telegram routing disabled: boot aborted before Telegram answered";
  log(message);
  return { ok: false, reason: "aborted", message };
}

/**
 * `probeOnce` wrapped in the transient-failure retry. One instance serves
 * both boot probes, so a streak's log de-duplication and backoff carry over
 * from step 1 to step 2; a successful probe ends the streak.
 */
class RetryingProber {
  /** Consecutive transient failures in the current streak. */
  private attempt = 0;
  /** Error classes already logged in the current streak. */
  private readonly loggedReasons = new Set<string>();
  /** When the current streak's first failure happened, or null. */
  private streakStartedAt: number | null = null;
  /** Aborts the in-flight probe or backoff wait on a wake. */
  private attemptAbort: AbortController | null = null;
  private readonly now: () => number;

  constructor(
    private readonly client: TelegramClient,
    private readonly log: LogFn,
    private readonly opts: Pick<BootOptions, "signal" | "onRetry" | "now">,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** A wake from sleep: reset the backoff and cut the current probe or wait
   *  short so the next probe starts at once. No-op between probes. */
  wake(): void {
    this.attempt = 0;
    this.attemptAbort?.abort();
  }

  async probe(params: { timeout: number; limit: number }): Promise<ProbeOutcome> {
    const stop = this.opts.signal;
    for (;;) {
      if (stop?.aborted) return { kind: "aborted" };
      const attemptAbort = new AbortController();
      this.attemptAbort = attemptAbort;
      const signal = stop ? AbortSignal.any([stop, attemptAbort.signal]) : attemptAbort.signal;

      let reason: string;
      let retryAfterMs: number | null = null;
      try {
        const probe = await this.client.probeOnce({ ...params, signal });
        if (probe.ok) {
          this.endStreak();
          return { kind: "ok", updates: probe.updates };
        }
        // A 2xx without an `ok:true` envelope (body truncated or reset
        // mid-read) is transient: Telegram answers 2xx only with ok:true, so
        // the answer was cut short, not refused.
        const twoXx = probe.status >= 200 && probe.status < 300;
        if (!twoXx && !isTransientStatus(probe.status)) return { kind: "permanent", status: probe.status };
        reason =
          probe.status === 429
            ? "429 Too Many Requests"
            : twoXx
              ? `HTTP ${probe.status} (bad body)`
              : `HTTP ${probe.status}`;
        if (probe.retryAfterSec !== null) retryAfterMs = probe.retryAfterSec * 1_000;
      } catch (err) {
        if (stop?.aborted) return { kind: "aborted" };
        // Woken mid-probe: the socket may be dead. Probe again now.
        if (attemptAbort.signal.aborted) continue;
        // The probe's own timer fired (dead socket, outage): errno:ETIMEDOUT,
        // the label the getUpdates loop uses. classifyError gives the same
        // for a TimeoutError; the isAbortError check also covers an
        // AbortError that no stop or wake caused. Never err.message: it can
        // embed the token-bearing URL.
        reason = isAbortError(err) ? "errno:ETIMEDOUT" : classifyError(err);
      }

      this.attempt += 1;
      const backoff = backoffDelayMs(this.attempt, BOOT_BACKOFF);
      const delayMs = retryAfterMs !== null ? Math.max(retryAfterMs, backoff) : backoff;
      this.noteFailure(reason, delayMs);
      try {
        await abortableSleep(delayMs, signal);
      } catch {
        if (stop?.aborted) return { kind: "aborted" };
        // Woken during the wait: probe again now.
      }
    }
  }

  private noteFailure(reason: string, delayMs: number): void {
    if (this.streakStartedAt === null) this.streakStartedAt = this.now();
    if (!this.loggedReasons.has(reason)) {
      this.loggedReasons.add(reason);
      this.log(`Telegram connect failed (${reason}); retrying with backoff`);
    }
    this.opts.onRetry?.({ reason, attempt: this.attempt, delayMs });
  }

  private endStreak(): void {
    if (this.streakStartedAt !== null) {
      const seconds = Math.max(1, Math.round((this.now() - this.streakStartedAt) / 1_000));
      this.log(`Telegram connected after ${seconds}s`);
    }
    this.attempt = 0;
    this.loggedReasons.clear();
    this.streakStartedAt = null;
  }
}

/** Trim to a bounded length so a stray exception message can't dump arbitrary
 *  content (or URL fragments from a leaky fetch error) into stderr. */
function shortReason(reason: string): string {
  const single = reason.replace(/\s+/g, " ").trim();
  return single.length > 80 ? single.slice(0, 77) + "..." : single;
}
