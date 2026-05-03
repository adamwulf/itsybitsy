/**
 * Three-step boot of the Telegram subsystem.
 *
 * `ib watch` calls {@link bootTelegramSubsystem} during launch. Each step
 * gates the next; a failure logs one stderr line and leaves the rest of the
 * dashboard running normally:
 *
 *   1. Connect — token must be set, and a non-consuming probe must succeed.
 *      A 409 Conflict means another poller/webhook is active; 401/403 mean
 *      the token is rejected; anything else is logged as a network failure.
 *   2. Resolve chat ID — call probeOnce again with limit=100 and walk the
 *      returned updates for the first private-chat message whose chat.id is
 *      in the allowlist. The id is held in memory and handed to the
 *      dispatcher and outbox; no on-disk persistence (Phase B removed the
 *      `chat-id` state file — `ib tgsend` now drops messages into the outbox
 *      and `ib watch` is the only process that talks to Telegram).
 *   3. Start subsystem — instantiate {@link TelegramDispatcher} with the
 *      cached chat id and an offset hint = max(consumed update_id) + 1, and
 *      instantiate {@link TelegramOutbox} with the same client and chat id.
 *      The dispatcher's first long-poll skips updates step 2 already saw;
 *      the outbox owns the file-drop queue from `ib tgsend`.
 *
 * Returns a {@link BootResult} describing the outcome. The caller owns both
 * dispatcher and outbox lifecycles (start/stop). When `ok` is false neither
 * is constructed — caller skips shutdown.
 */

import type { TelegramClient } from "./telegram-client";
import type { TelegramDispatcher, DispatcherOptions } from "./dispatcher";
import type { TelegramOutbox, OutboxOptions } from "./outbox";
import type { AccessState } from "./access";

/** Successful boot — dispatcher and outbox are constructed (not yet started). */
export interface BootSuccess {
  ok: true;
  chatId: string;
  dispatcher: TelegramDispatcher;
  outbox: TelegramOutbox;
}

/** Subsystem disabled — log line was emitted, no dispatcher. */
export interface BootDisabled {
  ok: false;
  reason:
    | "no-token"
    | "probe-409"
    | "probe-auth"
    | "probe-network"
    | "probe-other"
    | "no-allowlisted-inbound";
  /** The exact stderr line that was logged. Surfaced for tests/observability. */
  message: string;
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
}

/** Three-step boot. See module-level docstring. */
export async function bootTelegramSubsystem(opts: BootOptions): Promise<BootResult> {
  const log = opts.log ?? defaultLog;

  // Step 1 — connect.
  if (opts.token === "") {
    const message = "Telegram routing disabled: no bot token configured";
    log(message);
    return { ok: false, reason: "no-token", message };
  }

  const client = opts.buildClient(opts.token);

  let probe: Awaited<ReturnType<TelegramClient["probeOnce"]>>;
  try {
    // limit:1, timeout:0 — a non-consuming probe (no offset, so Telegram
    // returns the oldest pending update without acknowledging it). We only
    // care about HTTP success here; the inferred-chat-id step does its own
    // probe with a higher limit.
    probe = await client.probeOnce({ timeout: 0, limit: 1 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `Telegram routing disabled: probe failed (${shortReason(reason)})`;
    log(message);
    return { ok: false, reason: "probe-network", message };
  }

  if (!probe.ok) {
    if (probe.status === 409) {
      const message = "Telegram routing disabled: another poller or webhook is active";
      log(message);
      return { ok: false, reason: "probe-409", message };
    }
    if (probe.status === 401 || probe.status === 403) {
      const message = `Telegram routing disabled: bot token rejected (HTTP ${probe.status})`;
      log(message);
      return { ok: false, reason: "probe-auth", message };
    }
    const message = `Telegram routing disabled: probe failed (HTTP ${probe.status})`;
    log(message);
    return { ok: false, reason: "probe-other", message };
  }

  // Step 2 — resolve chat ID via inbound inference. Use a fresh probe with
  // limit=100 so we walk a meaningful slice of pending updates. We pass no
  // offset so we don't acknowledge anything — the dispatcher's first
  // getUpdates call will use the offset hint we hand it to skip past what
  // we've already seen.
  let resolveProbe: Awaited<ReturnType<TelegramClient["probeOnce"]>>;
  try {
    resolveProbe = await client.probeOnce({ timeout: 0, limit: 100 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `Telegram routing disabled: probe failed (${shortReason(reason)})`;
    log(message);
    return { ok: false, reason: "probe-network", message };
  }
  if (!resolveProbe.ok) {
    // Same classification as step 1's probe — a follow-up failure is
    // surfaced the same way. Should be rare given step 1 just succeeded.
    if (resolveProbe.status === 409) {
      const message = "Telegram routing disabled: another poller or webhook is active";
      log(message);
      return { ok: false, reason: "probe-409", message };
    }
    if (resolveProbe.status === 401 || resolveProbe.status === 403) {
      const message = `Telegram routing disabled: bot token rejected (HTTP ${resolveProbe.status})`;
      log(message);
      return { ok: false, reason: "probe-auth", message };
    }
    const message = `Telegram routing disabled: probe failed (HTTP ${resolveProbe.status})`;
    log(message);
    return { ok: false, reason: "probe-other", message };
  }

  const allowedChats = new Set(opts.access.allowed_chat_ids.map(String));
  let resolvedChatId: string | null = null;
  let maxConsumedId = -1;
  for (const update of resolveProbe.updates) {
    if (update.update_id > maxConsumedId) maxConsumedId = update.update_id;
    if (resolvedChatId !== null) continue;
    const msg = update.message;
    if (!msg) continue;
    if (msg.chat?.type !== "private") continue;
    const chatId = msg.chat?.id;
    if (chatId === undefined || chatId === null) continue;
    const chatIdStr = String(chatId);
    if (!allowedChats.has(chatIdStr)) continue;
    resolvedChatId = chatIdStr;
  }

  if (resolvedChatId === null) {
    const message =
      "Telegram routing disabled: no recent inbound from an allowlisted private chat. DM your bot, then restart ib watch.";
    log(message);
    return { ok: false, reason: "no-allowlisted-inbound", message };
  }

  // Step 3 — construct dispatcher and outbox. Both share the resolved chat id;
  // the caller starts each independently.
  const initialOffset = maxConsumedId >= 0 ? maxConsumedId + 1 : undefined;
  const dispatcher = opts.buildDispatcher({
    client,
    allowedChatIds: opts.access.allowed_chat_ids,
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

/** Trim to a bounded length so a stray exception message can't dump arbitrary
 *  content (or URL fragments from a leaky fetch error) into stderr. */
function shortReason(reason: string): string {
  const single = reason.replace(/\s+/g, " ").trim();
  return single.length > 80 ? single.slice(0, 77) + "..." : single;
}
