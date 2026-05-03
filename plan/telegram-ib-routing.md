# Telegram via ib tgsend + sendToSystemCoordinator — implementation plan

## Overview

Telegram becomes a transport for ittybitty's existing inbound comms
(`sendToSystemCoordinator`, the same path `ib send @system` uses)
plus one new outbound subcommand (`ib tgsend`). This document covers v1;
v2 may add other channels (Slack, iMessage, Discord).

- **Inbound:** a dispatcher in `ib watch` (or `ib tgdaemon`) long-polls
  Telegram, wraps each message in a channel-reminder block, and
  delivers it to the system coordinator via tmux send-keys.
- **Outbound:** the coordinator runs `ib tgsend "..."` and the
  subcommand posts to Telegram directly.

Plain text both ways. No question/answer correlation, no qid aliasing,
no `ib ask` interception — the coordinator's normal session scrollback
is the conversational context. The same dispatcher pattern generalizes
later to iMessage, Slack, Discord.

## Non-goals

The following are explicitly out of scope and deferred:

- **Multi-channel support.** The dispatcher should be designed so
  that adding iMessage/Slack later is straightforward, but only Telegram
  ships in v1.
- **Pairing UX.** Use static config (a single allowlisted Telegram
  user ID) to start. The bot's `/start` command and pairing dance can
  be ported later.
- **`ib ask` / question-answer correlation.** No qid handling.
  If the coordinator wants a structured Q&A flow, it just types the
  question into `ib tgsend` and treats whatever the user replies with
  as the answer (visible in its own scrollback). Real `ib ask`
  integration would require restructuring `askQuestion()` (`src/ib-commands.ts:3057`)
  and `PendingQuestion` to handle the in-memory `@system` agent
  (no `meta.json` on disk), threading `repoPath` into `PendingQuestion`,
  and bypassing the `activeAgentIds` filter in `readQuestionsInternal()`.
  Not justified for the marginal UX win — the coordinator can ask
  questions in plain text and the user replies in plain text.
- **Webhook / MTProto transport.** Webhooks need a public URL on the
  user's Mac (no thanks); MTProto is overkill. HTTP long-polling
  (`getUpdates`) is what ships.
- **Permission relay.** Defer to a later round.
- **Group chat support, mention-detection, multi-chat routing.**
  Single-user, single-chat only.
- **File / image attachments outbound.** Inbound attachments get a
  reasonable degraded behavior (notice on both sides). Outbound
  attachments would mean uploading files via the Bot API.
- **Multi-machine / multi-user scenarios.**

## Architecture

```
       Telegram cloud (Bot API)
         │                ▲
   getUpdates       sendMessage
         ▼                │
   ┌──────────────┐  ┌────┴──────┐
   │ ib watch  or │  │ ib tgsend │
   │ ib tgdaemon  │  └────▲──────┘
   └──────┬───────┘       │
          │ tmux          │ subprocess
          ▼               │
       ┌─────────────────────┐
       │ System coordinator  │
       └─────────────────────┘
```

Key properties:
1. **Two clients hit the Telegram API**: the long-running dispatcher
   for inbound, and one-shot `ib tgsend` invocations for outbound.
   The Bot API serializes per-chat; concurrent calls just queue.
2. **The dispatcher runs in either `ib watch` (foreground TUI) or a
   dedicated `ib tgdaemon` (headless background)** — both ship so the
   user can pick. Don't run both simultaneously against the same bot.

## Pieces to build

Three pieces, in suggested implementation order. See "Estimated scope"
at the bottom for the consolidated file-touch list.

### 1. Telegram transport — direct integration in `ib watch`

`ib watch` talks to Telegram's HTTP API directly using the bot token
from itsybitsy config. The dispatcher long-polls `getUpdates` for
inbound and calls `sendMessage` for outbound.

**Why long-polling:** an HTTPS GET that hangs for ~30s waiting for
new messages, returning an offset for the next call. No persistent
connection bookkeeping; reconnects are just the next HTTP call.
Webhooks would be cleaner but require a public URL on the user's
Mac (no thanks). Telegram doesn't expose websockets for bots.

The transport client is a thin wrapper around the Bot API
(`getUpdates`, `sendMessage`) using `fetch()` with an
`AbortController` so the long-poll can be cancelled cleanly on
shutdown. The update-id offset is managed in memory; persist to disk
only if we discover a reason to (we don't yet).

**Deployment lifetime — two ways to run the dispatcher:**

1. **Inside `ib watch` (foreground TUI).** Started by `launchDashboard()`
   alongside `AgentWatcher`; stopped on TUI exit via the
   `AbortController` so the in-flight long-poll cancels within ~1s.
2. **As `ib tgdaemon` (headless background).** A separate CLI entry
   that constructs the same dispatcher class but skips the TUI.
   Designed to be supervised by launchd. This is the "always on"
   path — required for the personal-assistant use case where the
   user wants the assistant reachable when the dashboard isn't open.

Both ship. The two are mutually exclusive against the same bot
token (long-polling against the same bot from two clients splits
updates unpredictably). On startup, the dispatcher does a single
`getUpdates(offset=-1, limit=1, timeout=0)` to clear any held update
and detect a 409 Conflict (which means a webhook is set or another
poller is active) — log loudly and exit if 409.

The dispatcher itself owns the long-poll loop, allowlist check,
channel-reminder wrapping, and per-coordinator serialization mutex.
`launchDashboard()` (`src/tui/dashboard.ts:1961` — the body of
`ib watch`) starts and stops the dispatcher alongside the
`AgentWatcher`. The dispatcher is not coupled to TUI rendering; it
just runs in the same process.

The `coordinator.telegram` config flag and the
`--channels plugin:telegram@...` registration in
`src/coordinator.ts:296-301` are removed. Per user: the plugin is
installed but should not be used at all. The system coordinator no
longer gets the Telegram channel passed to its claude session.

**Failure modes to handle:**
- Telegram API unreachable on startup (no network): log warning,
  retry on exponential backoff capped at ~30s. Don't crash the host
  process (`ib watch` keeps its TUI; `ib tgdaemon` keeps trying).
- Mid-poll HTTP failure: log, retry with backoff. The `getUpdates`
  offset is in memory; on retry, the next call sends the same offset
  — Telegram is idempotent for the same offset. No durable state
  needed for offset.
- HTTP 429 (rate limited): parse `Retry-After`, sleep that long,
  resume.
- Bot token missing or invalid: log "Telegram routing disabled: bot
  token not configured" / "Telegram API rejected token, check
  `channels.telegram.bot_token`." Don't crash.
- 409 Conflict on startup probe: another poller is active or a
  webhook is set. Log and exit (in `ib tgdaemon`) or skip Telegram
  startup entirely (in `ib watch`) so the rest of the TUI works.

### 2. Inbound dispatcher (Telegram → coordinator)

When the long-poll loop returns one or more new Telegram updates, the
dispatcher needs to:

1. Filter to allowlisted chat IDs / user IDs (drop everything else
   silently).
2. Resolve which agent this Telegram chat is bound to. Hardcoded to
   the system coordinator (`@system` sentinel).
3. Wrap the message text with a channel-reminder block so the
   coordinator knows it's a Telegram message and how to reply.
4. Call `sendToSystemCoordinator(wrapped, { fromAgent: "@telegram", multiline: true })`.

The wrapping format:

```text
<channel source="telegram" user="alice" ts="2026-05-03T01:26:30Z">
Hey, can you check on the build?
</channel>

To reply on Telegram, run `ib tgsend "<your message>"`.
```

The trailing instruction sentence is the critical UX piece: it tells
Claude (in the coordinator session) the one outbound verb to Telegram.
Only `ib tgsend` ships (no chat ID arg — it routes to the single
configured chat). No `chat_id` or `message_id` shown in the wrapper
— they're not needed by the coordinator and would just be noise.

Subcommand naming uses single-word verbs (`ib tgsend`, `ib tgallow`,
`ib tgdeny`, `ib tgcheck`, `ib tgdaemon`) — consistent with how the
rest of itsybitsy spells commands (`ib new-agent`, `ib merge-check`,
`ib hook-status`, etc., where each command is one shell argv entry).
Avoids subcommand parsing logic in `src/index.ts`.

**Critical: tmux newline handling.** `sendMessage` (`src/ib-commands.ts:1241`)
does NOT call `sanitizeTmuxInput`. It chunks the message and ships
each chunk via `tmux send-keys -t <sess> -l <chunk>`. Literal `\n`
bytes inside the chunk are sent as raw newline keystrokes, which
Claude Code's TUI treats as Submit. A multi-line `<channel>...</channel>`
block would submit each line as a separate user turn — breaking the
inbound flow.

**Mitigation:** the dispatcher must collapse newlines before calling
`sendToSystemCoordinator`. Pick one of:
1. **Replace `\n` with literal `\\n` (two chars).** The coordinator
   sees a single line containing `\n` escapes, which Claude can
   interpret. Simple, lossless on read-back, but cosmetically ugly.
2. **Add a `multiline` mode to `sendMessage`** that joins lines with
   tmux's `Enter` key sent through send-keys (not `-l`) using the
   "literal-then-Enter" pattern that the existing newAgent flow uses
   (`src/ib-commands.ts:2665`). Cleaner; touches `sendMessage`'s
   public API.
3. **Render the channel-reminder block as a single line** using `|` or
   `␤` glyphs as visual separators. Loses the natural line breaks in
   user-typed Telegram messages — bad for screenshots-of-stack-traces
   etc.

**Recommendation: option 2.** Add a `{ multiline: true }` opt to
`sendMessage`. When set, the function chunks on newlines and uses
`tmux send-keys -l <chunk>; tmux send-keys Enter` between chunks
(without the trailing submit-Enter that today fires after the loop).
Final submit happens after the last newline-chunk. Touches one
function but preserves the channel-reminder format. Falls back
cleanly for callers that don't pass the opt.

**Reuse, don't add:** `sendToSystemCoordinator(message, opts)`
already exists at `src/index.ts:166`. The dispatcher calls it
directly (no subprocess overhead, structured errors). Pass
`fromAgent: "@telegram"` — the leading `@` marks it as a sentinel
so `sendMessage` formats it as `[sent by @telegram]: ...` rather
than `[sent by agent telegram]: ...` (per the existing sentinel
handling at `src/ib-commands.ts:1294`). Document `@telegram`
alongside `@system` in `src/agents.ts`'s `SpawnedBy` comments.

The allowlist file lives at `~/.itsybitsy/channels/telegram/access.json`.
`ib tgallow <chat_id>` adds entries (single-line file edit; no full
pairing-flow yet); see "Configuration" below for the schema.

**Burst / coalescing:** Telegram's `getUpdates` returns up to 100
updates per call. If the user sends 5 messages in quick succession
(text + screenshot + caption + follow-up text + correction),
forwarding each one as a separate `sendToSystemCoordinator` call is:
(a) ~30s of serialized tmux I/O given `sendMessage`'s ~0.2-3s
per-message settling sleep, and (b) interleaved with any other
sender hitting the same tmux session. The dispatcher handles this
by **batching within one poll cycle**: all updates from the same
chat returned by the same `getUpdates` call are merged into one
wrapped block:

```text
<channel source="telegram" chat_id="…" user="…" first_ts="…" count="3">
  Hey can you check the build?
  ---
  Looks like step 4 failed.
  ---
  Also: should we revert?
</channel>
```

The coordinator gets one turn instead of three. Single-message bursts
(common case) render without the `count`/separators noise. The
dispatcher must serialize calls to `sendToSystemCoordinator` per
coordinator session — two parallel callers writing the same tmux
session would interleave keystrokes. A simple in-process mutex on the
coordinator's tmux session name suffices.

**Group-chat caveat:** intended for 1:1 DMs only. Group chats
deliver every member's message with the same `chat_id`, so
allowlisting a group ID effectively trusts the whole group. Document
explicitly in the access.json schema that `allowed_chat_ids` should
hold 1:1 DM IDs only; group support requires a per-message `from.id`
check that doesn't ship in this round.

**Failure modes:**
- Coordinator not running when message arrives:
  `sendToSystemCoordinator()` returns `{ ok: false, ... }` with a
  message saying so. Reply on Telegram with "coordinator offline,
  message dropped — start it with `ib watch`." Don't queue.
- Sender not in allowlist: drop silently on the user side, write a
  rate-limited dispatcher-log entry (one entry per `chat_id` per hour)
  so the user can debug "why doesn't the bot answer?" Do not echo back
  on Telegram (prompt-injection vector).
- Update without `message.text` (image, voice, sticker, document):
  reply on Telegram with "Received attachment — text only supported.
  Please describe in text." Surface to the coordinator anyway as
  `<channel source="telegram" ...>[user sent <type>: <caption or
  filename>]</channel>` so the coordinator at least knows something
  arrived. Defensively check `update.message?.text` before
  destructuring; a missing text field must not crash the loop.
- Single-update payload with both an image and a caption: fold the
  caption into the channel-reminder text and keep the attachment-
  notice for the image part.

### 3. Outbound: `ib tgsend "<text>"`

One subcommand. The coordinator runs `ib tgsend "<text>"` to send a
message to the configured Telegram chat. No chat ID arg (routes to
the single chat in config). No reply correlation — the next inbound
Telegram message lands on the coordinator's stdin via §2; if it's a
reply to the coordinator's last `ib tgsend`, the coordinator sees the
context in its own scrollback. Structured Q&A via `ib ask` is
deferred — see Non-goals.

**Behavior:**
1. Read `channels.telegram.bot_token` and `channels.telegram.chat_id`
   from config. If either is missing, exit with an error.
2. POST to Telegram's `sendMessage` endpoint.
3. Print `ok` on success or the API error on failure.

**Concurrency with `ib watch`:** both `ib tgsend` (one-shot
subprocess) and `ib watch` (long-running dispatcher) can hit the
Telegram Bot API concurrently. The Bot API serializes per-chat at
~1 message/sec for non-broadcast; concurrent calls just queue.
Acceptable. The dispatcher does not need to know `ib tgsend` ran.

**Failure modes:**
- Bot token missing: `ib tgsend` exits 1 with "Telegram not
  configured: set channels.telegram.bot_token in config."
- Telegram API error (4xx/5xx): print the response and exit non-zero.
  The coordinator sees the error and can decide whether to retry.
- Telegram rate-limited (HTTP 429): parse `Retry-After` from the
  response, sleep, retry once. If still 429, give up and exit non-zero.
- Network down: same as 5xx — print, exit non-zero.

## Configuration

New config keys (defined in `src/config.ts`):

| Key | Type | Description |
|---|---|---|
| `channels.telegram.bot_token` | string | The Telegram Bot API token (e.g., `123456:ABC-DEF...`). When unset or empty, Telegram routing is disabled (the dispatcher logs and skips the loop). |
| `channels.telegram.chat_id` | string | The Telegram chat ID this bot routes inbound messages from and outbound `ib tgsend` to. Single chat only. |

The `channels.*` namespace is new; mirrors the directory layout
(`~/.itsybitsy/channels/telegram/`). The bot token isn't really
"coordinator-owned" — the dispatcher in `ib watch`/`ib tgdaemon`
reads it, not the coordinator's claude session. (Compare with
`coordinator.imessage`, which legitimately is a coordinator-side
flag because the coordinator's claude session loads the iMessage
plugin.)

**Removed config:** `coordinator.telegram` (bool). It currently gates
appending `--channels plugin:telegram@claude-plugins-official` to the
coordinator's `claude` command (`src/coordinator.ts:296-301`). Per
the user, the official Telegram plugin should not be used at all.
Remove both the config key (`src/config.ts`) and the
`--channels plugin:telegram@...` branch.

**Verification step:** after removing the `telegram` push from the
`channels` array in `src/coordinator.ts:296-301`, the `if
(channels.length > 0)` branch (line 299) will fire only when
`coordinator.imessage` is true. Confirm `coordinator.imessage=true`,
no telegram, still produces the correct
`claude --model opus --channels plugin:imessage@...` invocation.

**Unchanged config:** `coordinator.imessage` stays exactly as-is.
This plan does not touch iMessage routing.

**Allowlist file:** `~/.itsybitsy/channels/telegram/access.json`. Schema:
```json
{
  "allowed_chat_ids": ["8766474645"],
  "allowed_user_ids": []
}
```
Either list non-empty grants access; both empty means deny-all.
`ib tgallow <chat_id>` and `ib tgdeny <chat_id>` edit this file
(atomic write, idempotent). `ib tgcheck` is a dry-run that prints
what's configured and tries a sample `getUpdates` call to confirm
the bot is reachable.

**Group-chat caveat:** `allowed_chat_ids` is intended for 1:1
DMs only. Group chats deliver every member's message with the same
group `chat_id`, so allowlisting one trusts everyone in the group.
A future round may add a per-message `from.id` check; for now,
document the restriction in the schema docstring and `ib tgcheck`
warns if a configured `chat_id` looks group-shaped (negative integer).

## Cutover plan

This is the order to ship without breaking anything mid-flight.

1. **Add config keys + access.json schema + `ib tgallow`/`ib tgdeny`/
   `ib tgcheck` subcommands.** No behavior change yet — just config
   and validation plumbing. Tests verify atomic writes, schema
   validation, deny-all default.
2. **Add the `multiline` mode to `sendMessage`.** Self-contained
   refactor with its own tests. No callers use it yet.
3. **Land §1: the Telegram transport client.** The `getUpdates` /
   `sendMessage` wrapper with `AbortController` and 429 handling. No
   wiring yet — just the client class and its tests.
4. **Land §2: the inbound dispatcher wired to `launchDashboard()`.**
   Allowlist filter, channel-reminder wrapping, burst coalescing,
   per-coordinator mutex, calls into `sendToSystemCoordinator`. The
   `--channels plugin:telegram@...` registration on the coordinator
   stays in place during this step — the user can verify the new
   path without losing the old one. Document that running both
   simultaneously will cause Telegram to split updates between them.
5. **Land the `ib tgsend` subcommand.** Outbound path, reusing the
   transport client from step 3.
6. **Add `ib tgdaemon`.** Same dispatcher class, headless entry.
   Useful immediately for the personal-assistant use case where the
   user wants 24/7 routing.
7. **Remove the `--channels plugin:telegram@...` branch and the
   `coordinator.telegram` config key.** Edit `src/coordinator.ts:296-301`
   to drop the `telegram` push and the surrounding config read.
   Remove the key from `src/config.ts`. After this step, the
   official Telegram plugin is no longer attached to the coordinator
   session.

Each step is independently testable and rollback-able.

## Testing strategy

### Unit tests

- **Allowlist filter**: returns true/false correctly for allowlisted
  vs. non-allowlisted chat/user IDs; deny-all when both lists empty;
  warns on group-shaped (negative) chat IDs in `ib tgcheck`.
- **Channel-reminder wrapping**: given chat metadata + body, produces
  the expected `<channel ...>...</channel>` block; multi-line bodies
  preserved when `multiline: true` is propagated.
- **Burst coalescing**: 3 updates in one `getUpdates` payload
  produce a single wrapped block with `count="3"` and `---`
  separators; 1 update produces a clean single-message wrap (no
  `count`, no separators).
- **Newline handling in `sendMessage`**: with `multiline: true`,
  embedded `\n` characters become `Enter` keystrokes via
  `tmux send-keys` (no `-l`), with one final Enter to submit.
  Without `multiline`, the function behaves exactly as today.
- **`ib tgsend` config validation**: missing token → exit 1 with
  clear error; missing chat ID → same; both present → calls the
  client.
- **Attachment handling**: `update.message` without `text` (image,
  voice, sticker, document) does not throw; produces an
  attachment-notice channel-reminder + a Telegram reply.
- **Sentinel labelling**: `sendMessage(..., { fromAgent: "@telegram" })`
  formats the prefix as `[sent by @telegram]: ...` (not `[sent by
  agent telegram]: ...`).

### Integration tests

- **End-to-end inbound (text)**: feed a fake `getUpdates` response
  to a mocked Telegram client; verify `sendToSystemCoordinator` was
  called with the wrapped text and `multiline: true`, and the
  resulting tmux send-keys sequence (captured via
  `coordinatorSpawnCtx`) contains alternating chunk/Enter calls
  with one final Enter.
- **End-to-end outbound**: invoke `ib tgsend "hello"` as a
  subprocess; verify the Telegram client's `sendMessage` was called
  with the configured chat ID and the literal text.
- **Coordinator offline**: dispatcher receives a message while
  `tmux has-session -t ib-coordinator` returns non-zero; verify the
  dispatcher replies on Telegram with "coordinator offline" and
  does not retry-storm.
- **Per-coordinator serialization**: simulate two updates arriving
  in rapid succession from two different chats; verify the
  dispatcher serializes the two `sendToSystemCoordinator` calls
  rather than interleaving keystrokes.
- **fs.watch reliability for `user-questions.json`**: verify the
  watcher fires when `acknowledgeQuestion` rewrites the file via
  `Bun.write`. (Sanity check; not strictly needed by the new
  dispatcher since it doesn't watch `user-questions.json`, but
  worth confirming for any future round.)
- **Telegram unreachable**: mock `getUpdates` to throw; verify
  exponential-backoff retry loop runs and the host process does not
  crash. Verify a single warning is emitted, not one per attempt.
- **HTTP 429**: mock a `Retry-After: 5` response; verify the client
  sleeps 5s then resumes.
- **409 Conflict on startup probe**: mock the initial probe to
  return 409; verify `ib tgdaemon` exits with a clear error and
  `ib watch` skips Telegram startup but keeps the rest of the TUI
  alive.

### Manual / live tests (gated on local Telegram bot token)

- Send a text message → see it wrapped and forwarded to the
  coordinator session.
- Send a multi-line text message (real `\n` characters) → see the
  whole thing arrive as one coordinator turn (no early submit).
- Send 3 messages quickly → see one coalesced coordinator turn with
  3 numbered fragments.
- Send an image with no caption → see "Received attachment" reply
  on Telegram + an `[user sent photo]` channel-reminder on the
  coordinator side.
- Coordinator runs `ib tgsend "done"` → see the plain message
  arrive on Telegram.
- Quit `ib watch` while a long-poll is in flight → verify the
  process exits within ~1s (AbortController cancels the poll).
- Run `ib tgdaemon` and quit `ib watch` → verify Telegram still
  routes through the daemon.

## Open questions

These should be settled during implementation, not before:

- **What does the channel-reminder text look like exactly?** The
  example in §2 is a starting point; refine on first user-feedback
  pass.
- **Auto-start vs. opt-in dispatch.** When `ib watch` starts, should
  the dispatcher run automatically if `channels.telegram.bot_token`
  is set, or does it need a separate `channels.telegram.enabled`
  flag? Recommend: automatic — token presence is the enable signal.
  Add a `--no-telegram` flag to `ib watch` for the rare case where
  the user wants the TUI without polling.
- **Coordinator restart while messages are in flight.** If the user
  sends a message while the coordinator session is being restarted
  (rare but possible during `restartSystemCoordinator()`),
  `sendToSystemCoordinator` may briefly return ok=false. Recommend:
  retry once with a 2s backoff before sending the "coordinator
  offline" reply. Implementer's call.

## Estimated scope

Rough sizing, not a commitment:

| Piece | Lines | Confidence |
|---|---|---|
| Config keys + access.json + `ib tgallow`/`ib tgdeny`/`ib tgcheck` | ~150 | high |
| `multiline` mode for `sendMessage` | ~60 | high — small, well-scoped |
| §1 Telegram client (`fetch` + AbortController + 429 handling) | ~150 | high — small, well-defined HTTP API |
| §2 inbound dispatcher (poll loop + allowlist + wrapping + coalesce + serialize) | ~280 | medium — coalescing and per-coord mutex add complexity |
| §3 `ib tgsend` subcommand | ~80 | high — straightforward |
| `ib tgdaemon` entry | ~50 | high — factor out of `launchDashboard` |
| Tests for all of above | ~700 | matches existing test density |
| Cutover (remove `coordinator.telegram` config + plugin registration) | ~30 lines deleted | trivial |
| **Total** | **~1470 net new, ~30 deleted** | — |

Files to touch, consolidated:

- New: `src/channels/telegram-client.ts` — Bot API wrapper
  (`getUpdates`, `sendMessage`) using `fetch()` + `AbortController`.
- New: `src/channels/types.ts` — shared interfaces.
- New: `src/channels/dispatcher.ts` — long-poll loop, allowlist
  filter, channel-reminder wrapping, per-coordinator mutex.
- New: `src/channels/access.ts` — read/write
  `~/.itsybitsy/channels/telegram/access.json`.
- Modified: `src/index.ts` — add `tgsend`/`tgallow`/`tgdeny`/
  `tgcheck`/`tgdaemon` cases.
- Modified: `src/ib-commands.ts` — add `telegramSend()`, add
  `multiline` option to `sendMessage` (`src/ib-commands.ts:1241`).
- Modified: `src/coordinator.ts:296-301` — remove plugin registration.
- Modified: `src/config.ts` — add `channels.telegram.*`, remove
  `coordinator.telegram`.
- Modified: `src/tui/dashboard.ts` — start/stop dispatcher in
  `launchDashboard()` (`src/tui/dashboard.ts:1961`).
- Modified: `src/agents.ts` — document `@telegram` sentinel
  alongside `@system` in `SpawnedBy` comments.

## See also

- [Telegram Bot API](https://core.telegram.org/bots/api) —
  `getUpdates` and `sendMessage` endpoints used by the Telegram client.
- `src/index.ts:166` — `sendToSystemCoordinator()`, the existing
  helper the inbound dispatcher reuses.
- `src/ib-commands.ts:1241` — `sendMessage()`, gets a `multiline`
  option in step 2 of the cutover.
- `src/ib-commands.ts:1294` — sentinel-prefix handling for
  `fromAgent` IDs starting with `@`; pattern reused for `@telegram`.
- `src/coordinator.ts:168` — `sanitizeTmuxInput()`, the existing
  helper that strips control chars (which is why we can't use it
  on the channel-reminder block — we need newlines preserved).
- `src/coordinator.ts:296-301` — current Telegram plugin
  registration; removed in step 7 of the cutover plan.
