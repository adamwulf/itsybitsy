# Telegram: Reaction Emojis & Attachments — Scoping Report

**Date:** 2026-06-27
**Status:** Reactions (both directions) IMPLEMENTED 2026-06-27 (see §7). Attachments still scoped, not yet built.
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
