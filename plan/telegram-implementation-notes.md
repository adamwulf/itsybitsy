# Telegram routing — implementation notes

Cross-reference of [`plan/telegram-ib-routing.md`](./telegram-ib-routing.md)
against the official Anthropic Telegram plugin
(`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts`).
Use the plugin as a reference for *how* to talk to the Bot API; do **not** port
its surface area wholesale — most of it (MCP, pairing, group support,
permission relay) is explicitly out of scope per
`plan/telegram-ib-routing.md` §"Non-goals".

## What we keep from the plugin

Treat the plugin as a worked example of the Telegram Bot API edge cases.
Borrow the *behaviors*, not the architecture. The plugin runs as an
MCP server using `grammy`; we run inside `ib watch` using raw `fetch()`.

### 1. Borrow `grammy` only if it pulls its weight

The plugin uses `grammy` (a Telegram Bot API client) for `bot.start()`,
`bot.api.sendMessage`, `bot.api.getFile`, `bot.api.setMessageReaction`,
typed Context, and entity parsing. For our v1 surface (`getUpdates` +
`sendMessage`, that's it), `grammy` is overkill. **Recommendation:** stick
with `fetch()` + the two endpoints, per the plan. `grammy` becomes worth
considering only if/when we add reactions, file downloads, or
`sendChatAction`.

The Bot API base URL is `https://api.telegram.org/bot<TOKEN>/<method>`.
File downloads (which we don't do in v1) live at
`https://api.telegram.org/file/bot<TOKEN>/<file_path>` after a `getFile`
call. Note the URL embeds the token — never log these URLs verbatim.

### 2. Single-poller invariant (409 Conflict)

The plugin handles this with a PID file at
`~/.claude/channels/telegram/bot.pid` and SIGTERMs any stale holder before
starting (`server.ts:53-69`). It also retries with backoff capped at 8
attempts when 409 persists (`server.ts:1022-1029`).

For us:

- `plan/telegram-ib-routing.md` already specifies a startup
  `getUpdates(offset=-1, limit=1, timeout=0)` probe to detect 409 and
  skip-with-warning. Keep that approach — we don't need a PID file
  because we run inside the long-lived `ib watch` process. There's
  exactly one `ib watch` per user; the only competing poller would be
  someone leaving the official plugin attached. The plan already removes
  the `--channels plugin:telegram` registration in step 1 of the cutover
  to prevent that conflict.
- **One thing to copy:** the plugin's behavior of *retrying 409 with
  backoff* in case the conflict is transient (the prior process is
  shutting down). The plan currently says "log and skip Telegram
  startup" — that's the right call for a hard 409 on the probe, but
  during normal `getUpdates` polling we should still retry on 409 (with
  the standard exponential backoff capped at ~30s) in case the holder
  is exiting.

### 3. Failure-mode catalog (mid-poll resilience)

The plugin learned the hard way that grammy's default catch handler
calls `bot.stop()` and rethrows, silently killing polling. Their fix:
wrap the entire `bot.start()` call in a `for(;;)` retry loop with
exponential backoff for *any* error — `ETIMEDOUT`, `ECONNRESET`, DNS
failures, 409, etc. (`server.ts:999-1038`). They also install
`process.on('unhandledRejection')` and `process.on('uncaughtException')`
handlers as a last-resort safety net (`server.ts:73-78`).

For us:

- Wrap the long-poll loop in the same outer `for(;;) try { ... } catch
  { backoff; continue }` pattern. A single `fetch()` failure must NOT
  exit the loop. Reset the backoff counter on a successful poll.
- We don't need the unhandled-rejection net at the process level
  (`ib watch` has its own error surfaces) — but we DO need the
  dispatcher loop itself to catch every error. A throw inside the
  `forEach` over updates must not break the next iteration.
- Log warnings *once per error class*, not per attempt. The plan
  already calls this out under §1 failure modes.

### 4. Graceful shutdown via AbortController

The plugin uses `bot.stop()` with a 2-second hard exit timer
(`server.ts:649-660`). Equivalent for us: the plan's
`AbortController` on the in-flight `getUpdates` fetch. The Telegram
API responds promptly to a closed connection — the long-poll cancels
within ~1s.

Actionable: ensure `launchDashboard()`'s teardown code awaits the
dispatcher's `stop()` method (or fires the abort + a timeout race)
before returning. Don't `process.exit()` synchronously — give the
dispatcher its 1-2s window to close cleanly so the next `ib watch`
doesn't hit a stale-connection 409.

### 5. Outbound message chunking

The plugin chunks at 4096 chars with two strategies (`length` or
`newline`), driven by `access.json` config (`server.ts:357-376`). It
uses `lastIndexOf('\n\n', limit)` for paragraph-aware splits, falling
back to `\n`, then space, then hard cut.

For us:

- Telegram's 4096-char hard cap applies — `ib tgsend` MUST chunk.
  Otherwise the API returns 400 and the coordinator gets an
  unrecoverable error.
- For v1, chunk on length only (simpler). The `chunkMode: newline`
  option is nice-to-have polish that doesn't justify the config
  surface yet.
- Plan currently doesn't mention chunking in §3 — **add this** to the
  `ib tgsend` behavior. Recommend: hard chunk at 4000 chars (leaving
  a safety margin) and post each as a separate `sendMessage` call.
  Print one `ok` per chunk, or one `ok (N parts)` summary at the end.
- `chunk()` from the plugin (`server.ts:357-376`) is short and well-
  tested — copy the function shape, drop the `mode` parameter for v1.

### 6. Defensive coding around inbound payloads

The plugin handles every Telegram message type with a dedicated
handler (`message:text`, `message:photo`, `message:document`,
`message:voice`, `message:audio`, `message:video`, `message:video_note`,
`message:sticker`) — `server.ts:787-883`. Each one degrades gracefully
when there's no caption.

The plan already calls out the attachment fallback ("Received
attachment — text only supported"). What to actually copy from the
plugin:

- **`update.message?.text` is optional** — destructuring without the
  `?` will crash on photos, stickers, etc. The plan §2 calls this out
  explicitly. ✅
- **Caption fallback**: `update.message?.text ?? update.message?.caption ?? ""`.
  A photo with a caption has the user's text in `caption`, not
  `text`. Worth surfacing to the coordinator.
- **`message_id` and `chat_id` shapes**: `chat.id` is a number (can be
  negative for groups). Coerce to `String()` everywhere — the plugin
  does this consistently and we should too.
- **Filename sanitization**: the plugin's `safeName()`
  (`server.ts:896-898`) strips `<>[]\r\n;` from uploader-controlled
  filenames before they land in the channel-reminder block. We don't
  surface attachment filenames in the `<channel>` tag (the plan keeps
  the wrapper minimal), but if we ever do, copy this guard.

### 7. Channel-reminder format (what Claude sees)

The plugin's MCP `instructions` block (`server.ts:397-407`) is the gold
standard for telling Claude how to use a channel:

> "The sender reads Telegram, not this session. Anything you want them
> to see must go through the reply tool — your transcript output never
> reaches their chat."
>
> "Messages from Telegram arrive as `<channel source="telegram"
> chat_id="..." message_id="..." user="..." ts="...">`. ... Reply with
> the reply tool — pass chat_id back."

Our equivalent is the trailing instruction sentence in the wrapped
block:

```text
<channel source="telegram" user="alice" ts="2026-05-03T01:26:30Z">
Hey, can you check on the build?
</channel>

To reply on Telegram, run `ib tgsend "<your message>"`.
```

**Differences from the plugin's wrapper:**

- We omit `chat_id` and `message_id` (plan §2): the coordinator only
  ever talks to one chat, no threading.
- We add the trailing reply instruction. The plugin doesn't need it
  because the MCP `reply` tool carries its own description. Our
  coordinator just sees text in its tmux buffer — it needs the
  outbound verb spelled out.
- **Refinement worth considering:** prepend a one-time orientation
  block on first inbound message of a coordinator session (or
  whenever scrollback gets compacted away). The plugin gets this for
  free via the MCP `instructions` field that's loaded once per
  session. Our coordinator might forget the rules across long
  conversations. Cheap mitigation: include a "(reply with `ib
  tgsend`)" suffix on every inbound message rather than relying on
  the coordinator remembering a single instruction line.

### 8. Gotchas the plugin discovered (worth pre-emptively handling)

1. **stdin EOF / orphan watchdog** (`server.ts:649-677`). Their server
   is a child process of `claude`; when claude dies, the bot can
   become a zombie holding the token. They poll for reparenting and
   self-terminate. **For us:** moot. We run inside `ib watch`. When
   the user kills `ib watch`, the dispatcher dies with it. Nothing to
   port.
2. **`access.json` corrupt-file recovery** (`server.ts:162-169`).
   When JSON parse fails, they rename the file aside with a timestamp
   and start fresh. **For us:** worth copying for our
   `~/.itsybitsy/channels/telegram/access.json`. A corrupt allowlist
   shouldn't kill `ib watch`.
3. **Atomic write via `.tmp` + `rename`** (`server.ts:202-208`).
   Standard pattern. The plan calls for "atomic write, idempotent" in
   `ib tgallow`/`ib tgdeny`; this is the recipe.
4. **`mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })`**.
   State dir is mode 700 (owner only). Since we're storing a chat ID
   list (not the bot token — that lives in `config.json`), 0700 is
   defense-in-depth but worth doing.
5. **`chmodSync(ENV_FILE, 0o600)` on the token file**. We're keeping
   the token in `~/.itsybitsy/config.json`, which itself should already
   be 0600. Confirm during implementation; if not, the bot token
   landing in there is a reason to lock it down now.
6. **Permission-reply intercept** (`server.ts:927-943`). They look for
   a regex like `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$` to catch
   "yes abcde" replies as MCP permission grants. We're explicitly
   skipping permission relay for v1 (plan §"Non-goals"). When/if we
   add it, this regex is the established convention from
   `anthropics/claude-cli-internal`.
7. **Photo "best size" selection** (`server.ts:797-799`). Telegram
   sends multiple resolutions per photo; the largest is last in the
   array. We're not downloading photos in v1 (degraded behavior:
   "Received attachment — text only supported"), but if we ever do,
   `photos[photos.length - 1].file_id` is the one to grab.
8. **Reaction whitelist** (`server.ts:476-477`, ACCESS.md whitelist).
   Telegram only accepts a fixed set of reaction emoji. Out of scope
   for v1; relevant if we ever add `ib tgreact`.

## What we deliberately skip from the plugin

| Plugin feature | Why we skip |
|---|---|
| MCP server | We deliver via tmux send-keys to the coordinator, not as a tool exposed to Claude. The whole MCP layer (`Server`, `StdioServerTransport`, `ListToolsRequestSchema`, etc.) is unused. |
| `grammy` dependency | One extra dep just to call two HTTPS endpoints. `fetch()` + `AbortController` is enough. |
| Pairing flow | Plan uses static config; an `ib tgallow <chat_id>` subcommand is the v1 admin path. |
| Group chat support | Plan §"Non-goals". 1:1 DMs only. `allowed_chat_ids` is documented as DM-only. |
| Mention detection | No groups → no mentions to detect. |
| `setMyCommands` (`/start`, `/help`, `/status` bot commands) | We don't run a chat-bot UX. The Telegram side is just a transport — the user types prose, the coordinator types prose. |
| Photo / document / voice / sticker handlers (with download) | Inbound attachments get a "received attachment" notice; no file is downloaded. Coordinator's tmux session can't show images anyway. |
| `setMessageReaction` (`react` tool) | No reactions in v1. |
| `editMessageText` (`edit_message` tool) | No edits in v1. The plan's §3 is a one-shot send. |
| `sendChatAction('typing')` | Nice-to-have; the user can wait. Keeps `ib tgsend` synchronous. |
| Permission relay (callback queries, inline keyboard, "yes abcde" intercept) | Plan §"Non-goals". |
| `replyToMode` / `chunkMode` / `ackReaction` config keys | All UX polish that doesn't ship in v1. |
| MarkdownV2 formatting (`parse_mode`) | Plain text both ways. No risk of formatting-escape bugs. |

## What's missing from `plan/telegram-ib-routing.md` that we should add

These came out of the plugin diff that aren't covered in the plan:

1. **Outbound chunking** (see §5 above). 4096-char hard cap is a real
   API limit; the plan §3 doesn't mention it. Add to `ib tgsend`
   behavior: chunk at 4000 chars, post each separately, summarize
   results.
2. **`access.json` corrupt-file recovery** (see §8.2). Add to the
   §"Configuration" → "Allowlist file" section: on JSON parse error,
   rename aside with `.corrupt-<timestamp>` suffix and proceed with an
   empty allowlist (deny-all). Never crash `ib watch`.
3. **Mode 0700 on `~/.itsybitsy/channels/telegram/`**. Plan implies
   the dir but doesn't specify permissions. Set on creation (in
   `ib tgallow` or wherever the dir is first touched).
4. **Caption-as-text fallback** (see §6). When an inbound update has
   `caption` but no `text` (a photo with a caption), use the caption
   as the body of the channel-reminder block — don't let it become a
   bare "Received attachment" notice when there's actual text the
   user typed.
5. **409 retry policy clarification**. The plan covers 409 only on
   the startup probe ("log and skip"). It should also cover 409
   *during* normal polling: retry with backoff, since the conflict
   may resolve when the other process exits. Mid-poll 409 is
   different from startup 409 — we shouldn't kill the dispatcher
   forever.
6. **Outer try/catch on the dispatcher loop** (see §3). Explicit
   "any throw inside the update-processing loop must not break the
   next iteration" guarantee. This is implicit in "exponential
   backoff capped at ~30s" but worth an explicit unit test.

## Concrete file/function map

The plan's §"Estimated scope" already lists touchpoints. This adds the
plugin-derived implementation hints:

| File (new or modified) | Plugin reference | Notes |
|---|---|---|
| `src/channels/telegram-client.ts` (new) | `server.ts:1002-1016` (`bot.start`), inferred Bot API URLs | `getUpdates` long-poll with `AbortController`, `sendMessage` POST. Both go to `https://api.telegram.org/bot<TOKEN>/<method>`. JSON request/response. |
| `src/channels/dispatcher.ts` (new) | `server.ts:900-986` (`handleInbound`) | Allowlist filter, channel-reminder wrapping, burst coalesce, per-coordinator mutex. Skip the typing indicator + ack reaction (out of scope). |
| `src/channels/access.ts` (new) | `server.ts:147-208` (`readAccessFile`/`saveAccess`/atomic-write) | Copy the corrupt-file recovery and the `tmp + rename` write. Schema is much simpler — just `allowed_chat_ids` + `allowed_user_ids`. |
| `src/channels/types.ts` (new) | n/a | Shared interfaces for `TelegramUpdate`, `TelegramMessage`, etc. Hand-rolled minimal subset of the Bot API types — no need to import grammy's. |
| `src/index.ts` (modified) | n/a | Add `tgsend`/`tgallow`/`tgdeny`/`tgcheck` cases. |
| `src/ib-commands.ts` (modified) | `server.ts:357-376` (`chunk()`) | `telegramSend()` uses the chunking pattern. |
| `src/coordinator.ts` (modified) | `server.ts:295-301` analog | Remove `coordinator.telegram` branch from `ensureSystemCoordinator`. |
| `src/config.ts` (modified) | n/a | Add `channels.telegram.bot_token` and `channels.telegram.chat_id`. Remove `coordinator.telegram`. |
| `src/tui/dashboard.ts` (modified) | `server.ts:649-660` (shutdown) | Start dispatcher in `launchDashboard()`, stop on TUI exit via AbortController. |
| `src/agents.ts` (modified) | n/a | Document `@telegram` sentinel in `SpawnedBy` comments. |

## Open questions surfaced by the plugin diff

1. **Bot API base URL — env-overridable?** The plugin hardcodes
   `https://api.telegram.org`. For local testing or self-hosted Bot
   API instances, an env var like `TELEGRAM_API_BASE` would help.
   Recommend: env-overridable, defaults to the public API. Cheap to
   add now, expensive to retrofit.
2. **`getUpdates` `allowed_updates` parameter.** The plugin doesn't
   set this (defaults to all update types). For v1 we only care about
   `message` updates — passing `allowed_updates: ["message"]` cuts
   noise (no `edited_message`, `callback_query`, etc.) and reduces
   payload size. Worth adding to the client.
3. **HTML / MarkdownV2 escaping when surfacing user text into the
   `<channel>` tag.** The plan wraps the user's literal text in a
   pseudo-XML tag. If the user types `</channel>` in their message,
   the closing tag is forged. Mitigation: strip or escape `</channel>`
   in the inbound text before wrapping. Cheap defense-in-depth.
4. **Where does the bot token actually live?** Plan says
   `channels.telegram.bot_token` in `~/.itsybitsy/config.json`. The
   plugin uses a separate `~/.claude/channels/telegram/.env` file
   chmodded to 600. Confirm during implementation that
   `config.json` is owner-readable only — if not, either lock it down
   or follow the plugin's pattern of a separate token file. The plan
   currently doesn't address this; flagging it now.
