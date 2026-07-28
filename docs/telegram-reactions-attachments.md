# Telegram: Reaction Emojis & Attachments — Scoping Report

**Date:** 2026-06-27
**Status:** Reactions (both directions) IMPLEMENTED 2026-06-27 (see §7). Attachments (both directions) IMPLEMENTED 2026-06-27 (see §8).
**Author:** investigation agent `agent-d5e9eeb8`

## TL;DR

| Feature | Feasible? | Effort | Main catch |
|---|---|---|---|
| **React to a msg (bot → 👍)** | Yes | Small (~½ day) | Must retain `message_id` per message — dispatcher currently drops it. |
| **Receive reactions (user reacts → agent sees)** | Yes | Small–Medium (~1 day) | Needs `allowed_updates` to include `message_reaction` (private chat works without admin). |
| **Inbound attachments (download + give to agent)** | Yes | Medium (~1–2 days) | `getFile` download + 20 MB Bot-API limit + where to store + how agent consumes. This is why Adam's test came through text-only. |
| **Outbound attachments (agent → image/file)** | Yes | Medium (~1–2 days) | New outbox file-drop schema + `sendPhoto`/`sendDocument` (multipart upload). |

---

## 0. Which repo owns the Telegram code?

**`itsybitsy`** (the Bun/TypeScript rewrite — this repo) owns ALL of it, under `src/channels/`.

The sibling bash repo `~/Developer/bash/ittybitty` (the legacy reference `ib`) has **zero** Telegram code — `grep -ri telegram` over it returns nothing. It is the bash reference implementation that predates the Telegram bridge. Do not look for tgsend/getUpdates there.

All file:line references below are in `itsybitsy`.

---

## 1. Current architecture

The Telegram subsystem is a self-contained module under `src/channels/`. It is a **hand-rolled Bot API client** — no grammy, no external Telegram library. Base URL is hardcoded to `https://api.telegram.org` (no env override).

| Concern | File |
|---|---|
| Bot API transport (`getUpdates` long-poll, `sendMessage`, `sendChatAction`, `probeOnce`) | `src/channels/telegram-client.ts` |
| Inbound dispatcher (long-poll loop → coordinator) | `src/channels/dispatcher.ts` |
| Outbound queue (`ib tgsend` ↔ `ib watch`) | `src/channels/outbox.ts` |
| Boot / chat-id resolution | `src/channels/boot.ts` |
| Allowlist (`ib tgallow` / `ib tgdeny`) | `src/channels/access.ts` |
| On-disk chat-id cache | `src/channels/chat-id-cache.ts` |
| Hand-rolled API types | `src/channels/types.ts` |
| CLI wiring (`tgsend`, `tgallow`, `tgdeny`, `tgtyping`) | `src/index.ts:2600-2649` |
| `telegramSend` (file-drop client) | `src/ib-commands.ts:5531` |

### 1.1 Transport — `telegram-client.ts`

`TelegramClient` (`telegram-client.ts:186`) wraps exactly the Bot API methods in use today:

- `getUpdates()` (`:215`) — resilient long-poll with exponential backoff. **Hardcodes `allowed_updates` default to `["message"]`** (`:216`). This is the single most important fact for reactions: the bot is currently told to receive ONLY `message` updates, so reaction updates never arrive.
- `probeOnce()` (`:287`) — one-shot non-retrying probe used at boot.
- `sendMessage()` (`:329`) — JSON POST, the only outbound path. 4096-char hard cap handled by `chunk()` (`:72`, limit 4000).
- `sendChatAction()` (`:361`) — typing indicator, best-effort.

There is **no** `setMessageReaction`, no `getFile`, no `sendPhoto`/`sendDocument` today. The client speaks **`application/json` only** — every request is `JSON.stringify(params)`. File upload (sendPhoto/sendDocument with a local file) requires **`multipart/form-data`**, which the client cannot currently produce.

### 1.2 Inbound flow — `dispatcher.ts`

1. `runLoop()` (`:508`) calls `getUpdates({ allowed_updates: ["message"], ... })` (`:512`) — again, message-only.
2. `processBatch()` (`:560`) filters each update through the allowlist, groups by chat, calls `normalize()`.
3. **`normalize()` (`:900`)** extracts the channel-reminder body. **It keeps only: `chatId`, `userId`, `username`, `ts`, `body`, `attachmentType`.** It does **NOT retain `message_id`** (the `NormalizedMessage` interface at `:245` has no message_id field). This is a blocker for reactions — `setMessageReaction` needs `chat_id` + `message_id`.
4. `normalize()` reads `msg.text ?? msg.caption ?? ""` (`:910`). **If a message is a bare photo/document with no caption, body becomes `[user sent <type>]`** (`:924`) and `attachmentType` is set.
5. `deliver()` (`:773`) wraps the batch and sends it to the system coordinator. **If any message was a bare attachment, it replies on Telegram: `"Received attachment — text only supported"` (`:809`).**

**This is exactly why Adam's attachment test came through as text-only.** The code deliberately recognizes attachments (`attachmentTypeOf()` at `:1023` already detects `photo`/`document`/`voice`/`audio`/`video`/`video_note`/`sticker`) but intentionally does NOT download them — it surfaces a placeholder `[user sent photo]` to the agent and a "text only supported" reply to the user. The `types.ts` comment (`:36-40`) confirms this is by design: *"Loosely typed since v1 doesn't download files."*

### 1.3 Outbound flow — `outbox.ts` + `ib tgsend`

Outbound is a **file-drop queue** so per-shell `ib tgsend` processes don't each open a Telegram connection:

1. `ib tgsend "text"` → `telegramSend()` (`ib-commands.ts:5531`) writes `<unix-ms>-<hex>.txt` into `~/.itsybitsy/channels/telegram/outbox/`, then polls up to 1s for a `.txt.result` file.
2. `ib watch` runs `TelegramOutbox` (`outbox.ts:81`), which `fs.watch`es that dir, reads each `.txt`, chunks it, calls `client.sendMessage()` per chunk (`:309`), and writes the `.result` JSON.

The outbox schema is **plain text only** — `<stem>.txt` holds UTF-8 message text. There is no concept of an attachment payload in the queue.

### 1.4 Bot setup specifics (relevant to both features)

- The bot talks to Adam in a **private 1:1 chat** (boot resolves a single private chat via `chat.type === "private"`, `boot.ts:223`). **This is good news for reactions** — Telegram's admin-required restriction on `message_reaction` updates applies to **groups/channels**, not private chats. In a private chat the bot receives reaction updates without being an admin.
- Allowlist is enforced on every inbound update (`isAllowed()`, `dispatcher.ts:881`). Any new update type (reactions, attachments) must pass the same allowlist filter — `message_reaction` updates carry the chat/user differently (see §3).
- Bot token is read from config key `channels.telegram.bot_token` (`ib-commands.ts:5593`). Never logged — `classifyError()` (`telegram-client.ts:90`) exists specifically to keep the token-bearing URL out of logs. Any new code must preserve this discipline.

---

## 2. Feature A — Reaction emojis

### A1. Bot reacts to a message (e.g. agent sends 👍)

**API:** `setMessageReaction(chat_id, message_id, reaction)`. JSON POST, fits the existing client perfectly.

**What's needed:**
1. Add `setMessageReaction()` to `TelegramClient` (~15 lines, mirrors `sendMessage`).
2. **Retain `message_id`** through the dispatcher: add a field to `NormalizedMessage` (`dispatcher.ts:245`) and set it in `normalize()` (`:900`). Currently dropped.
3. **Surface `message_id` to the agent** so it knows what to react to. Today the channel-reminder block (`wrapChannelReminder()`, `:966`) exposes `user`, `ts`, `chat_id`, `count` — not `message_id`. Add `message_id` as an attribute (e.g. `<channel ... message_id="123">`).
4. A way for the agent to *invoke* a reaction. Cleanest: a new CLI verb `ib tgreact <message_id> <emoji>` routed through the same outbox file-drop pattern (so it doesn't fight the long-poll connection), OR a richer outbox payload (see §B2). For v1, a dedicated `ib tgreact` is simplest.

**Effort:** Small (~½ day) IF we only need the bot to react. The client method is trivial; the real work is threading `message_id` end-to-end and adding the CLI verb + outbox handling.

**Gotchas:**
- `setMessageReaction` accepts only a small set of emoji by default (Telegram's allowed reaction set, e.g. 👍 👎 ❤️ 🔥 …); arbitrary emoji are rejected unless the chat allows custom reactions. Validate/allowlist the emoji.
- Reactions are addressed by `message_id`, which is per-chat. Single private chat keeps this simple.

### A2. Bot receives reactions (Adam reacts → agent is told)

**API:** `message_reaction` update type. The bot must request it via `allowed_updates`.

**What's needed:**
1. Add `"message_reaction"` (and optionally `"message_reaction_count"`) to the `allowed_updates` arrays — **two places**: `getUpdates` default (`telegram-client.ts:216`) and the dispatcher's call site (`dispatcher.ts:512`). Also the `probeOnce` calls (`:296`) if probes should see them.
2. Add `MessageReactionUpdated` to `types.ts` (`TelegramUpdate` at `:49` gains `message_reaction?`).
3. Handle the new update kind in `processBatch()` (`dispatcher.ts:566`) — it currently does `update.message` only and `continue`s on anything else. A reaction update has `update.message_reaction` with `chat`, `user`, `old_reaction`, `new_reaction`, and the reacted `message_id`.
4. Decide delivery: surface to the coordinator as a channel-reminder note, e.g. `[user reacted 👍 to message 123]`. Apply the same allowlist filter (the reaction update carries `user`/`actor_chat` — confirm which the allowlist should match; for a private chat it's the user).

**Effort:** Small–Medium (~1 day). Mostly plumbing a second update shape through `processBatch` + a new wrap path.

**Gotchas:**
- **`allowed_updates` is sticky on Telegram's side** per `getUpdates` call — but ours is passed every call, so just changing the arrays is enough. No `setWebhook` involved (we long-poll).
- **Admin requirement:** `message_reaction` updates in **groups/supergroups** require the bot to be an admin. **Adam's chat is a private 1:1, so this does NOT apply** — reactions flow without admin rights. Worth a one-line note in the PR.
- Anonymous reactions in big chats come as `message_reaction_count` (no user). Not relevant for a private chat, but if we ever support groups, handle both.
- Reaction updates can be noisy (every react/un-react fires one). Fine for a private chat; consider debouncing only if it becomes chatty.

---

## 3. Feature B — Attachments

### B1. Inbound (Adam sends a photo/file → agent can use it)

This is the gap Adam hit. The infrastructure to *detect* attachments already exists (`attachmentTypeOf()`); what's missing is **download + handoff**.

**API:** Two-step. (1) From the update, pick the `file_id` (for photos, the largest size in the `photo[]` array; for documents, `document.file_id`). (2) `getFile(file_id)` returns a `file_path`; download from `https://api.telegram.org/file/bot<token>/<file_path>`.

**What's needed:**
1. **Properly type the attachment fields** in `types.ts` (currently `photo?: unknown` etc. at `:40-46`). Need `PhotoSize[]`, `Document`, `Voice`, etc. with `file_id`, `file_unique_id`, `file_size`, `mime_type`, `file_name`.
2. Add `getFile()` to `TelegramClient` (JSON POST) + a `downloadFile(file_path)` helper that GETs the `/file/bot<token>/...` URL. **The download URL embeds the token** — keep it out of logs (reuse the existing discipline).
3. In the dispatcher, when an attachment is present, download it to a known location and surface a **local file path** to the agent. Recommended storage: `~/.itsybitsy/channels/telegram/inbound/<chat>/<unix-ms>-<safeName>` (there's already a `safeName()` helper at `dispatcher.ts:1017`). Local path beats base64 — agents are file-oriented and base64 would blow up the coordinator prompt.
4. Change the channel-reminder body from `[user sent photo]` to something actionable, e.g. `[user sent photo: /path/to/file.jpg (123 KB)]`, and **drop the "text only supported" reply** (`dispatcher.ts:809`) once real handling lands.
5. Decide a retention/cleanup policy for downloaded files (the outbox already has a 5s cleanup pattern to borrow from, though inbound files probably want a longer or manual TTL).

**Effort:** Medium (~1–2 days). The detection scaffolding exists; the work is `getFile` + download + storage + wiring + tests. The download path needs careful token handling and a size guard.

**Gotchas:**
- **Bot API download limit is 20 MB** (`getFile`). Larger files can't be fetched via the standard Bot API at all (would need a local Bot API server). Guard the size and tell the user when a file is too big.
- **Photos arrive as multiple `PhotoSize` entries** — pick the largest (last element) for full resolution.
- **Voice/video** are downloadable the same way but may be large; same 20 MB ceiling.
- **Security:** never trust `file_name` from Telegram — sanitize via `safeName()` and never let it escape the inbound dir (path traversal). Store under a generated stem, not the raw name.
- A single Telegram "media group" (album) arrives as several updates with the same `media_group_id`; v1 can treat each as a separate file, or coalesce later.

### B2. Outbound (agent shares a rendered image/file with Adam)

**API:** `sendPhoto` / `sendDocument`. Two modes: pass a URL/`file_id` (simple JSON) OR upload a local file (**`multipart/form-data`**).

**What's needed:**
1. Add `sendPhoto()` / `sendDocument()` to `TelegramClient`. **If we want to send local files, the client must learn multipart** (today it only does JSON). Bun's `FormData` + `Bun.file()` makes this straightforward — no new dependency.
2. **Extend the outbox file-drop schema.** Today `<stem>.txt` is plain text. To send a file we need to convey "send this local file with optional caption". Options:
   - Add a sidecar JSON: `<stem>.json` describing `{ type: "photo", path, caption }` alongside or instead of `.txt`. `TelegramOutbox.process()` (`outbox.ts:239`) branches on which exists.
   - Or a new CLI verb `ib tgsendfile <path> [caption]` that drops a JSON descriptor; `ib tgsend` stays text-only.
3. Update `TelegramOutbox` to call `sendPhoto`/`sendDocument` for file payloads instead of `sendMessage` (`outbox.ts:309`).
4. New CLI verb (`ib tgsendfile`) wired in `index.ts` alongside `tgsend` (`:2629`), and a `telegramSendFile()` in `ib-commands.ts` mirroring `telegramSend()` (`:5531`).

**Effort:** Medium (~1–2 days). Multipart upload + outbox schema extension + new CLI verb + tests. Slightly more than inbound because it touches the queue format.

**Gotchas:**
- **Send limits:** `sendPhoto` ~10 MB, `sendDocument` ~50 MB for bots. Photos are recompressed by Telegram; to preserve exact bytes (e.g. a PNG diff), send as a **document**, not a photo.
- The outbox's chunking/4096 logic is for text and doesn't apply to files — keep the file path separate from the text-chunk path.
- The agent must produce a real local file the `ib watch` process can read (same machine — fine today since outbox is local file-drop).

---

## 4. Recommended order

1. **Reactions (A1 + A2) first** — smallest, lowest-risk, mostly plumbing, no new transport mode (all JSON), and immediately useful (Adam 👍s a message; agent reacts to acknowledge). Threading `message_id` through the dispatcher also pays forward.
2. **Inbound attachments (B1)** — directly fixes the bug Adam hit. Detection already exists; needs `getFile` + download + storage. Self-contained.
3. **Outbound attachments (B2)** — last, because it's the only piece needing a new transport mode (multipart) AND an outbox schema change. Highest blast radius on the queue format.

A1+A2 and B1 are independent and could be done in parallel by two workers. B2 should follow B1 (shares the multipart/type work conceptually, and the outbox change wants careful review).

## 5. Cross-cutting checklist

- **General agent functionality:** new CLI verbs (`ib tgreact`, `ib tgsendfile`) and a richer channel-reminder format (adds `message_id`, real file paths). No meta.json/lifecycle change.
- **Hooks:** none required. `ib tgtyping` (hook-driven) is unaffected. The agent learns the new verbs via the channel-reminder body text (same mechanism as the existing `ib tgsend` hint at `dispatcher.ts:979`).
- **Watchdog:** unaffected — the dispatcher health state machine (`polling`/`retrying`/`down`) doesn't care about update *content*. Adding `allowed_updates` kinds doesn't change health semantics.
- **`ib watch` / dashboard:** unaffected for v1 (no new display). Optional later: show an indicator when inbound media is downloaded. Note the dashboard already reads dispatcher health (`getHealth()`), which is untouched.

## 6. Key file:line index

- `allowed_updates` default (message-only): `src/channels/telegram-client.ts:216`
- Dispatcher's `getUpdates` call: `src/channels/dispatcher.ts:512`
- `normalize()` drops `message_id`; `NormalizedMessage` shape: `src/channels/dispatcher.ts:245`, `:900`
- Attachment detection (already present): `src/channels/dispatcher.ts:1023` (`attachmentTypeOf`)
- "Received attachment — text only supported" reply: `src/channels/dispatcher.ts:809`
- `[user sent <type>]` placeholder body: `src/channels/dispatcher.ts:924`
- Channel-reminder wrap (where to add `message_id`): `src/channels/dispatcher.ts:966`
- `safeName()` filename sanitizer: `src/channels/dispatcher.ts:1017`
- Loosely-typed attachment fields: `src/channels/types.ts:36-47`
- `sendMessage` (JSON-only client): `src/channels/telegram-client.ts:329`
- Outbox text-only schema + `process()`: `src/channels/outbox.ts:14`, `:239`, `:309`
- `ib tgsend` client (`telegramSend`): `src/ib-commands.ts:5531`
- CLI command wiring: `src/index.ts:2629` (tgsend), `:2600` (tgallow), `:2618` (tgdeny)
- Token read from config: `src/ib-commands.ts:5593` (`channels.telegram.bot_token`)

---

## 7. IMPLEMENTED — Reactions, both directions (2026-06-27)

Reactions were implemented on branch `agent/agent-d5e9eeb8`. Attachments remain
scoped-only (§3) — not built. This section is the behavioral source-of-truth for
the reaction feature.

### 7.1 Outbound — the agent/bot reacts (`ib tgreact`)

New CLI verb:

```
ib tgreact <emoji> [--message-id <id>]    # react to a message
ib tgreact --clear  [--message-id <id>]   # remove the bot's reaction
```

- Without `--message-id`, it reacts to the **most recent inbound message** (see
  the last-message cache, §7.3).
- The emoji is validated locally against Telegram's documented reaction set
  before anything is sent — a typo/unsupported emoji fails with a clear message
  (`src/channels/reactions.ts`), not an opaque `REACTION_INVALID` from the API.
  A heart typed with a variation selector (`❤️`) is canonicalized to the
  documented bare form (`❤`).
- Routing mirrors `ib tgsend`: `tgreact` does NOT talk to Telegram directly. It
  drops a `<stem>.react.json` descriptor `{ message_id, emoji }` into the outbox
  and polls ≤1s for the result. `ib watch`'s `TelegramOutbox` picks it up and
  calls `client.setMessageReaction` (one 429-retry, same as text sends). If
  `ib watch` isn't running, the descriptor waits on disk and is processed on the
  next start (`tgreact` returns ok-but-queued, exit 0).
- `setMessageReaction(chat_id, message_id, [{type:"emoji",emoji}])`; an empty
  `reaction` array clears the reaction (`emoji: null`).

### 7.2 Inbound — the system receives the user's reactions

- `message_reaction` is added to `allowed_updates` (client default AND the
  dispatcher's `getUpdates` call). Telegram only delivers reaction updates when
  this is explicitly listed. The bot's chat with Adam is a private 1:1, so the
  group-admin requirement does NOT apply.
- The dispatcher parses `message_reaction` updates (`normalizeReaction`),
  applies the **same allowlist** as text, diffs `old_reaction` vs `new_reaction`
  into added/removed emoji, and delivers a distinct channel-reminder event to
  the coordinator — e.g.:
  `<channel source="telegram" kind="reaction" ... message_id="50">Reacted 👍 to message 50</channel>`.
  Removals read `Removed reaction 👍 from message 50`.
- Reactions are NOT coalesced with text and never enter the coordinator-offline
  y/n flow (a reaction is informational; if the coordinator is offline the
  notice is logged and dropped). Custom-emoji-only changes are skipped (no
  documented emoji to surface).

### 7.3 message_id retention + last-message cache

- `NormalizedMessage` now carries `messageId`; `wrapChannelReminder` surfaces
  `message_id="…"` (single) / `last_message_id="…"` (coalesced burst) so the
  agent can target a specific message.
- On every successful delivery, `deliver()` persists the newest inbound
  `{chat_id, message_id}` to `~/.itsybitsy/channels/telegram/last-message.json`
  (`src/channels/last-message-cache.ts`, modeled on `chat-id-cache.ts`). This is
  how `ib tgreact` (a separate short-lived process) finds "the latest message".
- **The cache tracks the latest inbound text/attachment message, NOT reactions.**
  An inbound `message_reaction` event does not update the cache. So if the
  coordinator runs bare `ib tgreact 👍` in response to a reaction event, it
  targets the last *message*, not the message that was reacted to. That's
  intentional: `wrapReactionReminder` surfaces the exact `message_id="…"` and
  the reply hint shows `--message-id <id>`, so the coordinator can always target
  the precise message when reacting to a reaction.

### 7.4 Files touched

- `src/channels/reactions.ts` (new) — emoji allowlist + validation.
- `src/channels/last-message-cache.ts` (new) — latest inbound message persistence.
- `src/channels/types.ts` — `ReactionType`, `MessageReactionUpdated`, `TelegramUpdate.message_reaction`.
- `src/channels/telegram-client.ts` — `setMessageReaction`; default `allowed_updates` now `["message","message_reaction"]`.
- `src/channels/dispatcher.ts` — `messageId` in `NormalizedMessage`; inbound reaction parse/deliver; `wrapReactionReminder`; last-message cache write; richer reply hint.
- `src/channels/outbox.ts` — `.react.json` descriptor processing (`processReaction`/`sendReaction`); queue keyed on the full dropped filename.
- `src/ib-commands.ts` — `telegramReact()` file-drop client.
- `src/index.ts` — `tgreact` CLI verb + usage.
- Tests: `reactions.test.ts`, `last-message-cache.test.ts` (new); additions to `telegram-client.test.ts`, `dispatcher.test.ts`, `outbox.test.ts`, `ib-commands.test.ts`.

### 7.5 Cross-cutting review (per CLAUDE.md checklist)

- **General agent functionality:** new `ib tgreact` verb; richer channel-reminder format. No meta.json/lifecycle change.
- **Hooks:** none changed. The coordinator learns `tgreact` via the channel-reminder reply hint (same mechanism as the `ib tgsend` hint).
- **Watchdog:** unaffected — health state machine is content-agnostic; new `allowed_updates` kinds don't change it.
- **`ib watch` / dashboard:** unaffected — no new display; dispatcher health (`getHealth()`) untouched.

---

## 8. IMPLEMENTED — Attachments, both directions (2026-06-27)

Attachments were implemented on branch `agent/agent-d7d2d546`, on top of the
reactions feature (§7). This section is the behavioral source-of-truth for the
attachment feature. It builds on the §7 outbox descriptor pattern (full-filename
keying, `<base>.result`, 5s retention, one 429-retry) and the dispatcher's
`getUpdates`/`normalize` flow.

### 8.1 Inbound — Adam sends a photo/file, the agent gets a local path

This fixes the bug §3 called out: a bare attachment used to come through as a
`[user sent photo]` placeholder + a "Received attachment — text only supported"
reply, with NO download. Now the file is downloaded and a real local path is
surfaced.

- **Typed attachments** (`types.ts`): `PhotoSize[]`, `Document`, `Voice`,
  `Audio`, `Video`, `VideoNote`, `Sticker` (each with `file_id`,
  `file_unique_id`, and where applicable `file_size`, `mime_type`, `file_name`),
  plus `TelegramFile` for the `getFile` result. Replaces the old `photo?: unknown`
  stubs.
- **Client** (`telegram-client.ts`): `getFile(file_id)` (JSON POST → `file_path`)
  and `downloadFile(file_path)` (GET `https://api.telegram.org/file/bot<token>/<file_path>`).
  **The download URL embeds the bot token and is NEVER logged** — failures
  surface only an HTTP status or a `classifyError()` label, never `err.message`
  (which could contain the URL). `downloadFile` guards the 20 MB ceiling twice:
  on the advertised `Content-Length` (refuses before buffering) and on the actual
  byte count after buffering (chunked responses omit the header).
- **Dispatcher** (`dispatcher.ts`): `describeAttachment(msg)` extracts a
  descriptor (kind, file_id, advertised size, sanitized display name). For photos
  it picks the **LARGEST `PhotoSize`** (by area, defaulting to the last element
  per Telegram convention). `resolveAttachment()` runs inside `processBatch`
  BEFORE grouping/wrapping so the wrapped body carries the resolved path:
  1. **Pre-download size guard** — if the advertised `file_size` already exceeds
     20 MB, skip the download, reply "too large" on Telegram, and surface a
     coordinator note (no path). Re-guarded with the authoritative `getFile`
     size when the message omitted it.
  2. `getFile` → `file_path`; on failure, a note (no path).
  3. `downloadFile` (re-guards size on the wire); too-big → reply + note,
     other failure → note.
  4. `storeInboundFile()` writes to
     `~/.itsybitsy/channels/telegram/inbound/<chat>/<unix-ms>-<safeName>` and the
     body becomes `[user sent photo: /abs/path/file.jpg (123 KB)]`. A **caption,
     if present, is prepended** to the body (own line), so the coordinator sees
     both the user's words and the file.
- **Path safety**: the on-disk name is ALWAYS a generated `<unix-ms>-<safeName>`
  stem. Telegram's `file_name` is never trusted for the path — it's run through
  the dispatcher's `safeName()` for display, and `storeInboundFile` applies a
  final path-traversal guard (strips separators, NUL, `..`) regardless of caller.
  The chat segment is likewise sanitized.
- **The "text only supported" reply is GONE** — real handling replaced it.
- **Retention** (`inbound-store.ts`): inbound files are kept **INDEFINITELY** by
  default (unlike the outbox's 5s result retention) because the agent may still
  need a file long after the message that delivered it. A best-effort, opt-in
  `pruneInboundOlderThan(ttl, now)` is provided for an operator/housekeeping pass
  (suggested `INBOUND_DEFAULT_TTL_MS` = 30 days), but nothing calls it on the hot
  path — we never auto-delete a file the agent might need.

### 8.2 Outbound — the agent shares a rendered image/file with Adam

New CLI verb:

```
ib tgsendfile <path> [caption]               # send a local file (default: document)
ib tgsendfile <path> [caption] --photo       # send as an inline photo (recompressed)
ib tgsendfile <path> [caption] --document    # send as a document (exact bytes; default)
```

- **Default is DOCUMENT** to preserve exact bytes — `sendPhoto` recompresses
  (the §3 gotcha), which would corrupt e.g. a PNG diff. `--photo` opts into the
  recompressed inline form.
- **Client** (`telegram-client.ts`): `sendPhoto()` / `sendDocument()` upload a
  LOCAL file via **`multipart/form-data`** using Bun's `FormData` + `Bun.file()`
  (no new dependency; the runtime sets the multipart boundary, so we must NOT set
  `Content-Type` ourselves). Optional caption. Same token-safety discipline as
  the JSON methods. Size limits: `TELEGRAM_SENDPHOTO_LIMIT_BYTES` (~10 MB),
  `TELEGRAM_SENDDOCUMENT_LIMIT_BYTES` (~50 MB).
- **Routing mirrors `ib tgsend`/`ib tgreact`**: `tgsendfile` does NOT talk to
  Telegram directly. `telegramSendFile()` (ib-commands.ts) resolves the path to
  absolute, does a fast local existence check, then drops a `<stem>.file.json`
  descriptor `{ path, caption?, kind: "photo" | "document" }` into the outbox and
  polls ≤1s for the `<base>.result`. If `ib watch` isn't running, the descriptor
  waits on disk (ok-but-queued, exit 0).
- **Outbox** (`outbox.ts`): `isQueuedFile` recognizes `.file.json`; `enqueue`
  dispatches it to `processFile` (full-filename keying, same as `.txt` /
  `.react.json`). `processFile` validates the descriptor shape, then that the
  local file **exists, is a regular file, is readable, and is within the per-kind
  size limit BEFORE uploading** — a clear `ok:false` result beats a cryptic API
  failure. `sendFile` calls `sendPhoto`/`sendDocument` with one 429-retry (same
  failure-mode strings as text/reactions). 5s result retention.

### 8.3 Files touched

- `src/channels/types.ts` — typed attachment interfaces + `TelegramFile`.
- `src/channels/telegram-client.ts` — `getFile`, `downloadFile`, `sendPhoto`,
  `sendDocument`, `sendMultipartFile`, `fileUrlFor`, size-limit constants.
- `src/channels/inbound-store.ts` (new) — inbound file storage + retention.
- `src/channels/dispatcher.ts` — `describeAttachment`, `resolveAttachment`,
  `AttachmentDescriptor`, `humanSize`; download wired into `processBatch`;
  "text only supported" reply removed.
- `src/channels/outbox.ts` — `.file.json` processing (`processFile`/`sendFile`/
  `validateOutgoingFile`), `isQueuedFile` recognizes `.file.json`.
- `src/ib-commands.ts` — `telegramSendFile()` file-drop client.
- `src/index.ts` — `tgsendfile` CLI verb + usage.
- Tests: `inbound-store.test.ts` (new); additions to `telegram-client.test.ts`,
  `dispatcher.test.ts`, `outbox.test.ts`, `ib-commands.test.ts`.

### 8.4 Cross-cutting review (per CLAUDE.md checklist)

- **General agent functionality:** new `ib tgsendfile` verb; inbound attachment
  bodies now carry real local paths (and captions). No meta.json/lifecycle change.
- **Hooks:** none changed. The coordinator learns `tgsendfile` via the usage text
  / docs; the channel-reminder reply hint (`ib tgsend`/`ib tgreact`) is unchanged.
- **Watchdog:** unaffected — the dispatcher health state machine is
  content-agnostic; downloading an attachment doesn't change poll outcomes or
  health semantics.
- **`ib watch` / dashboard:** unaffected — no new display. The outbox/dispatcher
  it hosts gained file paths internally, but `getHealth()` and the TUI are
  untouched. (A future enhancement could surface an "inbound media downloaded"
  indicator, as §5 noted; not built here.)

---

## 9. IMPLEMENTED — Reaction context (2026-07-27)

### 9.0 The problem

§7.2 shipped reaction delivery, but the block carries only an emoji and an id:

```
<channel source="telegram" kind="reaction" user="Adam" ts="..." message_id="1584">Reacted 👍 to message 1584</channel>
```

No message-text store existed anywhere — in memory or on disk — so the
coordinator could not resolve that id to any text. It guessed which message was
reacted to from sequence and timing: usually right, occasionally wrong, and
silently degrading whenever messages cross or one queues and arrives late.

The failure that motivated this: the coordinator asked Adam a direct either/or
question, he replied 👍, and the coordinator had to ask again — because even a
correctly-identified message doesn't say which branch a 👍 means. Seeing the
text makes that recoverable.

**Adam mostly reacts to messages the COORDINATOR sent**, so resolving OUTBOUND
messages is the real feature; inbound is the easy half.

Two complementary mechanisms shipped. They are not redundant: A is durable but
thin, B is rich but dies with the process.

### 9.1 Half A (durable) — `ib tgsend` echoes the sent message id

**`ib tgsend`'s output contract changed.** It used to print `ok` / `ok (2 parts)`
/ `queued …`. It now prints the Telegram message id when one is known:

| Situation | Output |
|---|---|
| Single message | `ok (message_id 1584)` |
| Chunked send | `ok (3 parts, message_ids 1584, 1585, 1586)` |
| Sent, but no id determinable | `ok` |
| Chunked, no ids determinable | `ok (3 parts)` |
| `ib watch` not running / >1s | `queued (ib watch may not be running, or Telegram is not configured)` |

The last two rows are the pre-existing strings verbatim — a send whose id we
can't name degrades to the OLD contract rather than to something new.

Why this is the more durable half: the coordinator then has the id **in its own
conversation history, right next to the text it sent**, so it can correlate a
reaction with no cache at all — surviving any `ib watch` restart.

Mechanics: `TelegramClient.sendMessage` always returned
`{ ok: true, result: TelegramMessage }`, but `TelegramOutbox.sendChunks` did
`if (resp.ok) continue;` and threw `resp.result` away. It now collects each
chunk's `message_id` — **including on the post-429 retry path**, which is a
separate call site and easy to miss — and `formatSendOk` folds them into the
existing `.result` `message` field. No new plumbing: the ids ride the channel
`tgsend` already polls for.

Two limits worth knowing:

- **The `queued` path genuinely has no id to report.** `telegramSend` polls ≤1s
  for the `.result`; if `ib watch` is down the message legitimately waits on
  disk and no send has happened yet. We keep returning the existing `queued`
  string — we do not invent an id and do not block longer waiting for one.
- `extractMessageId` is defensive because the client does
  `raw.body.result ?? {}` — a 2xx `{ok:true}` body with no `result` yields an
  empty object, so `message_id` can be absent at runtime despite the static
  type. Anything not a finite positive integer is treated as absent.

`ib tgsendfile` was NOT changed — its result is still a bare `ok`. Sent
photos/documents therefore have no echoed id and no cached preview. Deliberate
scope call, not an oversight; see §9.6.

### 9.2 Half B (rich) — in-memory id→text cache

`src/channels/message-cache.ts` (new) maps `(chatId, messageId)` → recent
message text, and the dispatcher uses it to add a text preview to reaction
blocks.

**NOTHING IS WRITTEN TO DISK.** This is a hard constraint, not an
implementation detail. Chat transcripts are the user's private content, and a
nicer reaction notice does not justify a durable transcript on disk (backup
surface, review surface, retention questions). If a future change starts
wanting persistence here, change the design instead. Note this is a *different*
decision from `last-message-cache.ts`, which persists a single `{chat_id,
message_id}` — an id, no text — because `ib tgreact` runs as a separate process
and has no other way to find it.

- **Module-level singleton**, not an injected dependency. The dispatcher
  (inbound) and outbox (outbound) are separate objects constructed side by side
  in `boot.ts` step 3, but they live in the SAME process and target the SAME
  resolved chat id, so a singleton lets both reach one cache without threading a
  handle through boot and two constructors. `resetMessageCache()` restores test
  isolation.
- **Bounded**: `MAX_RECORDS = 200`, oldest-first eviction; text capped at
  `MAX_TEXT_CHARS = 300` CODE POINTS on insert. Re-recording an id moves it to
  the young end rather than refreshing in place at its soon-to-be-evicted
  position.
- **The cap must COPY, and must count code points** — `truncateCodePoints`.
  Both properties are load-bearing and were both wrong in the first cut:
  - `String.prototype.slice` returns a **view that retains the parent buffer**.
    A record count bound then bounds nothing: measured, 200 records sliced to
    300 chars out of 1 MB parents pinned ~103 MB, and ~348 MB at 4 MB parents —
    it tracks PARENT size. This bites hardest outbound, because `sendChunks`
    slices each chunk out of the full `ib tgsend` payload and `tgsend` has no
    size cap before chunking, so one piped diff pinned its whole payload for the
    next 200 messages. `join()` is what releases it. `"" + s`, `s.repeat(1)` and
    `s.slice()` look like copies and are engine-folded no-ops — do not
    "simplify" to them.
  - Cutting on code units severs surrogate pairs (U+FFFD in the coordinator's
    transcript). The obvious fix is a trap:
    `Array.from(s.slice(0, MAX)).join("")` repairs **nothing** — the pair is
    already severed before `Array.from` runs, so the result is byte-identical to
    doing nothing. The correct form pre-slices to `MAX * 2` units, THEN slices
    to `MAX` code points, then joins. Right order fixes both defects in one
    expression; wrong order fixes neither.
  - The helper owns the length COMPARISON as well as the cut. A code-unit guard
    with a code-point cut moves the bug: 160 emoji is 160 code points but 320
    code units, so a unit guard appends `…` to a string it never truncated.
  - **Applied at BOTH caps, storage and display.** Not redundant:
    `formatMessagePreview` shrinks (drops all but 2 lines, collapses whitespace)
    BEFORE it measures, so a 300-unit stored string can arrive there at ~51 units
    and the display cap never fires — a storage-site severance would reach the
    coordinator untouched.
- **Total lookup**: unknown or malformed key → `null`, never a throw. Does no
  IO, so it can't fail on IO.

Seeding:

- **Outbound** — `TelegramOutbox.noteSentChunk`, **per chunk**. Per-chunk is the
  correct granularity: Telegram splits a long `tgsend` into several real
  messages, the user reacts to one specific chunk, and that chunk's text is what
  they actually saw.
- **Inbound** — `deliver()`, right beside the existing `writeLastMessage` call
  and with the same best-effort try/catch. **Every** message in a coalesced
  batch is recorded (`messageId > 0`), not just the newest — the user can react
  to any of them.

Both writes are best-effort: a cache failure must never fail or alter a
send/delivery.

### 9.3 Rendering the preview

`deliverReaction()` does the lookup and passes the result in;
`wrapReactionReminder(reaction, preview?)` stays **sync and pure**, so it
remains directly testable and IO/state stays out of the formatter.

```
<channel source="telegram" kind="reaction" user="Adam" ts="..." message_id="1584">Reacted 👍 to message 1584 (your message): "Ready to merge — want me to squash first, or keep the history as-is?"</channel>
```

`formatMessagePreview` takes the first 1-2 non-empty lines (coordinator
messages lead with the headline), joins them with a space so the block stays on
one line, collapses whitespace runs, normalizes `\r` / U+2028 / U+2029, runs
`stripChannelClose` (inbound text is the user's — treat it as untrusted), and
truncates to **160 chars with an explicit `…`** so truncation is visible rather
than silently misleading.

Whose message it was is surfaced because it changes the meaning entirely:

- `(your message)` — outbound; a 👍 here is an **answer** to what the
  coordinator asked.
- `(their own message)` — inbound; a 👍 here is an **acknowledgement**.

The suffix is appended once to the joined body, so the changed-reaction variant
reads `Reacted 🎉 to message 3; Removed reaction 👍 from message 3 (your
message): "…"` rather than repeating the preview per clause.

### 9.4 Degrading gracefully — the important part

**If the id isn't in the cache, the reaction summary line and the `<channel>`
block body are byte-identical to what they were before this feature.** No empty
quotes, no `(unknown)`, no error. Reaction delivery must never break because of
this.

Precisely: the `<channel>…</channel>` payload is unchanged. The trailing hint is
NOT — a reaction block gets `REACTION_REPLY_HINT`, one sentence longer (§9.5),
and it is part of the same returned string, so "the whole output is
byte-for-byte identical" would be false. The property that matters is that
nothing about a cache miss leaks into what the coordinator reads as the event.

A miss is the EXPECTED case, not an edge case: `ib watch` restarted (the common
one — it goes down and outbound messages queue for a stretch), the record was
evicted from the 200-entry ring, or the message predates this feature. That
restart gap is exactly why Half A exists.

On what the tests actually prove, since this is easy to overstate:
`dispatcher.test.ts` ("degrades byte-for-byte when there is no preview")
compares the CURRENT implementation against ITSELF — no-arg vs `null` vs
`undefined` preview — and pins the first three lines of the block explicitly. It
does NOT diff against the pre-feature implementation; nothing in the suite can,
since that code no longer exists. The pre/post equivalence of the block body was
established by review, not by the suite. `reaction-context.test.ts`
("RESTART GAP") covers the same property end-to-end by wiping the cache
mid-test.

### 9.5 `REPLY_HINT` / `REACTION_REPLY_HINT`

`REPLY_HINT` is unchanged from pre-feature — ordinary message blocks are
byte-identical to what they were. The extra sentence lives in
`REACTION_REPLY_HINT`, which is `REPLY_HINT` plus:

``` `ib tgsend` echoes the sent `message_id`; keep it to match later reactions. ```

`REACTION_REPLY_HINT` is derived from `REPLY_HINT` in code, not spelled out
again, so the two cannot drift. Reaction blocks are the only thing that uses
it: on the shared base the sentence would be a permanent ~75-character context
tax on every inbound Telegram message, paid to serve the rare reaction case.

The trade this makes: the coordinator learns the id is worth keeping only AFTER
a reaction arrives, never before it sends. Acceptable, because `ib tgsend`
prints `ok (message_id 1584)` regardless (§9.1) — the id is already in the
coordinator's context either way. The sentence is a nudge to RETAIN it, not the
mechanism that delivers it.

### 9.6 Deliberately NOT built

- **`ib tgsendfile` id echo / caching.** `sendFile` still returns bare `{ok:true}`,
  so a reaction to a sent photo or document gets no preview. Adding it means
  changing `tgsendfile`'s result contract too, which was outside this change's
  scope. Straightforward follow-up if reactions to sent files come up.
- **Reactions to reactions.** Unchanged from §7.3 — a `message_reaction` event
  does not update either cache.

### 9.7 Files touched

- `src/channels/message-cache.ts` (new) — the in-memory bounded ring, plus
  `truncateCodePoints` (shared by both caps).
- `src/channels/outbox.ts` — `sendChunks` returns `messageIds`; `noteSentChunk`,
  `extractMessageId`, `formatSendOk`.
- `src/channels/dispatcher.ts` — `ReactionPreview`, `resolveReactionPreview`,
  `formatMessagePreview` (named `formatReactionPreview` until §10 gave it a
  second caller), `whoseMessage`; `wrapReactionReminder` takes an
  optional preview; `deliver()` seeds the cache; `REACTION_REPLY_HINT`
  (`REPLY_HINT` itself is untouched).
- Tests: `message-cache.test.ts`, `reaction-context.test.ts` (new); additions to
  `dispatcher.test.ts`, `outbox.test.ts`.
- No change to `ib-commands.ts` or `index.ts` — `telegramSend` already returns
  the outbox's `message` verbatim and `index.ts` already prints it, which is why
  the id needed no new plumbing.

### 9.8 Verification status

- `bun test`: 4500 pass / 0 fail. `bunx tsc --noEmit`: 0 errors.
- `reaction-context.test.ts` drives the REAL `TelegramDispatcher` and
  `TelegramOutbox`, wired as `boot.ts` step 3 wires them, through the full loop:
  outbox sends → faked API returns `message_id: N` → `telegramSend`'s return
  value carries N → a `message_reaction` for N arrives → the coordinator's block
  quotes that message's text.
- **NOT verified end-to-end against Telegram.** No bot token, no real chat, no
  real HTTP round trip. The tests prove our components are wired correctly and
  what we'd send has the right shape; they cannot prove Telegram returns
  `message_id` where we expect, or that a real reaction update carries the
  fields we read. Those two assumptions are inherited from the already-shipped
  §7 code paths, but the *new* reliance on `sendMessage`'s response body is
  unproven against the live API.

### 9.9 Cross-cutting review (per CLAUDE.md checklist)

- **General agent functionality:** `ib tgsend`'s stdout contract changed (see
  the §9.1 table) and reaction blocks carry more text. No new CLI verb, no
  meta.json/lifecycle change. Any consumer parsing `tgsend` output for an exact
  `"ok"` would need updating — **none exists in this repo.** Audited all three
  `telegramSend` callers: `index.ts` (the `tgsend` verb) branches on `.ok` and
  prints `.message` verbatim; `ib-commands.ts` respawn-ack and
  `askQuestionTelegramCtx` both discard the result entirely. External/human
  consumers see a strictly more informative string.
- **Hooks:** none changed. `ib tgtyping` is unaffected. The coordinator learns
  about the echoed id through the channel-reminder reply hint — the same
  mechanism that taught it `tgreact` and `tgsend`.
- **Watchdog:** unaffected. The dispatcher health state machine is
  content-agnostic; a richer reaction body doesn't change poll outcomes,
  `getHealth()`, or nudge timing. The cache is not consulted by any state
  detection.
- **`ib watch` / dashboard:** no display change. `ib watch` hosts the process
  that now owns the cache, so its memory footprint grows by a bounded worst case
  of ~240 KB of text (200 × 300 CODE POINTS, each up to 2 UTF-16 units when
  astral) plus Map and record overhead — call it under ~300 KB. The 2x over the
  naive 120 KB is the deliberate price of code-point-correct truncation. That
  ceiling holds only because the cap COPIES rather than retaining a slice view;
  see §9.2. No new mode, focus, or layout behavior.

## 10. IMPLEMENTED — Reply context (2026-07-27)

### 10.0 The problem

Same ambiguity as §9, with text instead of an emoji. When Adam swipe-replies to
a specific message and types an actual reply, Telegram tells us exactly which
message he meant — and until now we threw that away. `reply_to_message` appeared
NOWHERE in the codebase, so the coordinator saw only the new text and had to
infer the referent from sequence and timing. "yes, do that" three messages later
is a guess.

### 10.1 Why this one is durable and the reaction path is not

`reply_to_message` is a **full Message object, including its `text`**, not a
bare id. So the replied-to text arrives IN the update:

- No cache lookup on the happy path.
- Works after an `ib watch` restart (the §9.4 RESTART GAP simply does not apply).
- Works for a message far older than the 200-record ring — months old, even.

That is a structural difference, not a tuning difference. `reaction-context.test.ts`
pins it from both sides: RESTART GAP shows a reaction losing its preview to an
empty cache, and "RESTART GAP does not exist for replies" shows a reply keeping
its preview across the identical wipe.

### 10.2 Resolution order

`extractReplyContext(msg, chatId)` in dispatcher.ts:

1. `reply_to_message.text` — authoritative, always preferred.
2. `reply_to_message.caption` — a reply to a photo/document carries a caption
   instead of text.
3. The in-memory `message-cache` (`lookupMessage`) — LAST resort, for a reply to
   something with no text at all (bare photo, sticker, poll). Expected to miss
   often; that is fine.
4. Nothing resolvable → `text: ""` → the id-only form.

The cache is probed at most once per reply, and only when steps 1-2 came up
empty or the direction could not be read off `from`.

Whose message it was comes from `reply_to_message.from.is_bot` (everything the
coordinator sends goes out through the bot), falling back to the cache's
recorded direction when `from` is absent. When neither can say, the
whose-message clause is OMITTED — a confident wrong attribution reads as fact
and would send the coordinator down the wrong path, while no clause merely says
less.

### 10.3 Output shape

    <channel source="telegram" user="Adam" ts="..." message_id="1590" in_reply_to="1584">
    Replying to (your message): "Ready to merge — squash first, or keep the history?…"
    yes, squash it
    </channel>

The preview goes in the BODY, not an attribute: it can contain quotes and
arbitrary user text, and the body is already the `stripChannelClose`-defended
place for that. `in_reply_to` follows the existing `messageIdAttr` convention —
omitted entirely when the id is not a usable target, exactly like `message_id`.

Degradation ladder, in order:

    Replying to (your message): "Ready to merge…"   ← ideal
    Replying to: "Ready to merge…"                  ← whose unknown
    Replying to message 1584 (your message)         ← text unresolvable
    Replying to message 1584                        ← neither
    (no line at all)                                ← no usable id AND no text

Never empty quotes: no text means no `: "…"` clause.

A reply to Adam's OWN earlier message is surfaced too, not suppressed —
reactions surface both directions and replies match.

### 10.4 The coalesced branch

`wrapChannelReminder` has a multi-message path where a batch is joined with
`---`. One header serves N messages there, so a block-level `in_reply_to` would
be ambiguous about which of the N it described. Instead:

- The reply line sits immediately ABOVE the body it belongs to, binding it to
  that message rather than to the block.
- It spells the id out inline (`Replying to message 1584 (your message): "…"`),
  because that is the only place left to carry it.

So the body line differs slightly between the two branches — the single-message
form omits the id (its header already has the attribute), the coalesced form
includes it. That is deliberate, and the single-message shape is the one Adam
approved.

### 10.5 An ordinary message gains NOTHING

The hard constraint. `replyTo` is `undefined` for a message that did not reply,
and every rendering addition is gated on it, so an ordinary block is
byte-identical to its pre-feature output — no attribute, no line, not one byte.
Pinned in `dispatcher.test.ts` against hardcoded literals of the WHOLE block
(single and coalesced), and end-to-end in `reaction-context.test.ts`.

### 10.6 Deliberately NOT built

- **Reply chains.** `reply_to_message` is not nested by Telegram in practice and
  we never walk it recursively. One hop is what the user pointed at.
- **Outbound replies.** `ib tgsend` still sends a plain message; there is no
  `--reply-to`. The coordinator answers in the chat, as before.
- **`reply_to_story` / `external_reply` / quoted fragments.** Telegram's newer
  reply variants are untouched; only `reply_to_message` is read.

### 10.7 Files touched

- `src/channels/types.ts` — `reply_to_message?: TelegramMessage` on
  `TelegramMessage`.
- `src/channels/dispatcher.ts` — `ReplyContext`, `extractReplyContext`,
  `resolveReplyDirection`, `firstNonEmptyString`, `formatReplyLine`,
  `replyToAttr`; `NormalizedMessage.replyTo`; `normalize()` populates it;
  `wrapChannelReminder` renders it in both branches. `formatReactionPreview` →
  `formatMessagePreview` and `REACTION_PREVIEW_MAX_CHARS` →
  `MESSAGE_PREVIEW_MAX_CHARS`, since one formatter now serves both context
  features (one truncation path, and the same text can never render two ways).
- Tests: `dispatcher.test.ts` (`extractReplyContext`, `wrapChannelReminder with
  a reply`), `reaction-context.test.ts` (three integration tests at the bottom;
  its header comment now covers both features).
- No change to the outbox, the message cache, `ib-commands.ts`, or `index.ts` —
  the reply path reads the update and needs no new plumbing.

### 10.8 Verification status

- `bun test`: 4541 pass / 0 fail. `bunx tsc --noEmit`: 0 errors.
- **NOT verified against real Telegram.** No bot token, no real chat, no real
  HTTP. Every reply fixture in the suite is hand-built from the documented
  shape, so the suite cannot prove that a real swipe-reply populates
  `reply_to_message`, that `from.is_bot` is `true` on the bot's own messages, or
  that a reply to media really carries `caption` rather than `text`. Those are
  the three live-API assumptions this feature rests on; see the §4 sanity-check
  step added for exercising them.

### 10.9 Cross-cutting review (per CLAUDE.md checklist)

- **General agent functionality:** unchanged. No new CLI verb, no meta.json or
  lifecycle change. The coordinator sees a richer block on replies only.
- **Hooks:** none changed. Nothing reads `reply_to_message` outside the
  dispatcher.
- **Watchdog:** unaffected. State detection is content-agnostic; the reply path
  adds no timing, no IO, and no cache writes.
- **`ib watch` / dashboard:** no display change and no new memory cost — the
  reply text comes from the update and is never stored; the cache is only ever
  READ by this path.
