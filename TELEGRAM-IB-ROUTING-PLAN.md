# Telegram via ib send/ask/acknowledge — implementation plan

## Why

Claude Code's MCP channel mechanism — the thing that makes `<channel
source="telegram" ...>` blocks appear in a session and route the bot's
`reply` tool — has constraints that don't fit our use case:

- **Research-preview status** with allowlist gating; custom channels need
  `--dangerously-load-development-channels` and the org-policy
  `channelsEnabled` flag.
- **Stdio-only transport in practice**, per the channel-reference docs.
  Stdio MCP servers are killed by Claude Code's wall-clock SIGTERM timer
  ([anthropics/claude-code#40207](https://github.com/anthropics/claude-code/issues/40207))
  and never auto-reconnected
  ([#43177](https://github.com/anthropics/claude-code/issues/43177)),
  which is the bug the Telegram bot has been hitting all along.
- **claude.ai login required**; not API key.
- **Per-session lifetime**: a channel is bound to one Claude Code session.
  When that session ends, the channel ends. There's no persistence across
  sessions and no routing to the right session if multiple are open.

Instead, treat Telegram as a **transport for ittybitty's existing
inter-agent comms** (`ib send`, `ib ask`, `ib acknowledge`). The bot runs
independently of any Claude session. Inbound messages reach the system
coordinator the same way any other agent would talk to it (via tmux
send-keys from `sendToSystemCoordinator()` — the same path `ib send
@system` uses). The coordinator asks questions back via `ib ask`, which
the dispatcher routes to Telegram. User replies on Telegram; the
dispatcher correlates them to the open question, marks it acknowledged
via `ib acknowledge <qid>`, and delivers the actual reply text via
`ib send <agent-id> "<reply>"`. (`ib acknowledge` only flips status —
the answer is a separate `ib send`.)

This is independent of Claude Code's channel mechanism, transport
limitations, and research-preview status. It also generalizes naturally to
iMessage, Slack, Discord — any channel becomes "another transport for `ib
ask`/`ib send`."

## Non-goals

- **Replacing the official Telegram channel plugin's behavior at the MCP
  layer.** This plan deliberately doesn't try to be a drop-in for the
  channel system. The channel-reminder framing and permission-relay flow
  are reimplemented at the ib layer, where they belong.
- **Multi-channel support in v1.** The dispatcher should be designed so
  that adding iMessage/Slack later is straightforward, but only Telegram
  ships in v1.
- **Pairing UX in v1.** Use static config (a single allowlisted Telegram
  user ID) to start. The interactive pairing flow the official plugins
  ship can come later.
- **Sandbox / cross-repo agent routing.** v1 routes only to the system
  coordinator. Routing to per-repo coordinators or named agents
  (`ib send @itsybitsy "..."`) is a v2 concern.
- **External bot processes / bridges.** v1 owns the entire transport:
  `ib watch` polls Telegram directly via the Bot API. The official
  Telegram MCP plugin is no longer attached to the coordinator session.
- **Web-hook / MTProto transport.** The Bot API supports webhooks, but
  that requires a public URL on the user's machine. MTProto (user-mode
  protocol) gets you websocket-style streaming but is overkill and out
  of scope. v1 uses HTTP long-polling (`getUpdates`).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Telegram cloud (Bot API over HTTPS)                    │
└────────────────┬─────────────────────────▲──────────────┘
                 │ getUpdates (long-poll)  │ sendMessage
                 ▼                         │
┌─────────────────────────────────────────────────────────┐
│  ib watch (the dispatcher — new code in src/channels/)  │
│   ┌─────────────────────────────────────────────────┐   │
│   │ telegram-client.ts                              │   │
│   │   getUpdates loop, sendMessage, fetch-based     │   │
│   └─────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────┐   │
│   │ inbound dispatcher                              │   │
│   │   allowlist filter → chat_id → agent_id         │   │
│   │   wraps in channel-reminder block               │   │
│   │   sendToSystemCoordinator(wrapped)              │   │
│   └─────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────┐   │
│   │ outbound dispatcher                             │   │
│   │   watches user-questions.json for new pending   │   │
│   │     qids assigned to @system                    │   │
│   │   forwards to Telegram with qid alias           │   │
│   │   handles ib telegram-reply (fire-and-forget)   │   │
│   └─────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────┐   │
│   │ reply correlator                                │   │
│   │   matches Telegram replies to pending aliases   │   │
│   │   sendToSystemCoordinator(answer) THEN          │   │
│   │   acknowledgeQuestion(qid)                      │   │
│   └─────────────────────────────────────────────────┘   │
└────────────────┬─────────────────────────▲──────────────┘
                 │ tmux send-keys          │ writes user-questions.json
                 ▼                         │
┌─────────────────────────────────────────────────────────┐
│  System coordinator (Claude Code session in tmux)       │
│  receives messages via tmux send-keys                   │
│  asks user questions via `ib ask` (writes file)         │
│  sends one-off Telegram messages via                    │
│    `ib telegram-reply <chat_id> "<text>"`               │
│  has no MCP plugin / no awareness of Telegram           │
└─────────────────────────────────────────────────────────┘
```

Key property: **the system coordinator has no MCP transport for
Telegram.** It learns about Telegram only via the channel-reminder
text we inject inbound (which tells it `ib telegram-reply` and
`ib ask` are the routes back) and via the new `ib telegram-reply`
subcommand. All actual transport — connection management, polling,
allowlist enforcement — lives in `ib watch`.

## Pieces to build

Four pieces, in suggested implementation order.

### 1. Telegram transport — direct integration in `ib watch`

`ib watch` talks to Telegram's HTTP API directly. The Telegram Bot API
token lives in itsybitsy config; the dispatcher uses it to long-poll
`getUpdates` and to call `sendMessage` for outbound. No external bot
process, no bridge, no MCP layer.

**Why direct:**
- The official Telegram plugin is currently registered for the system
  coordinator (via `--channels plugin:telegram@claude-plugins-official`
  in `src/coordinator.ts:298`), but the user has decided not to use it.
  Removing that registration eliminates the entire MCP transport stack.
- Long-polling `getUpdates` is straightforward: an HTTPS GET that hangs
  for ~30s waiting for new messages, returning an offset for the next
  call. No persistent connection bookkeeping; reconnects are just the
  next HTTP call.
- Telegram does not expose websockets for bots in the public Bot API
  (websocket-style bidirectional comms are available only through
  user-mode MTProto clients, which is overkill and out of scope).
  Long-polling is the right primitive.
- Webhook mode is an alternative — Telegram POSTs to a public URL
  whenever a message arrives. Not viable here (no public URL on the
  user's local Mac without tunnelling). Long-polling is the v1 path.

**Files to touch:**
- New: `src/channels/telegram-client.ts` — thin wrapper around the
  Bot API (`getUpdates`, `sendMessage`). Uses `fetch()`. Manages the
  update-id offset in memory; persists to disk only if we discover a
  reason to (we don't yet).
- New: `src/channels/dispatcher.ts` — the long-poll loop, allowlist
  check, inbound routing, outbound qid table.
- Removed: `coordinator.telegram` config flag (the
  `--channels plugin:telegram@...` registration in
  `src/coordinator.ts:296-301`). Per user: the plugin is installed but
  should not be used at all. The system coordinator no longer gets the
  Telegram channel passed to its claude session.

**Files to touch (transport layer only):**
- New: `src/channels/telegram-client.ts` — see above.
- New: `src/channels/types.ts` — shared interfaces. `ChannelMessage`,
  `ChannelClient`, etc.
- New: `src/channels/dispatcher.ts` — owns the lifecycle of the
  Telegram client and the outbound/inbound flow. `launchDashboard()`
  (`src/tui/dashboard.ts:1961` — the body of `ib watch`) starts and
  stops the dispatcher alongside the `AgentWatcher`. The dispatcher is
  not coupled to TUI rendering; it just runs in the same process.

**Deployment-lifetime note:** Today, `ib watch` is the foreground TUI
process — when the user quits, the watcher (and our new dispatcher)
goes with it. If the user wants Telegram routing while the dashboard
is closed, the dispatcher needs to live in a longer-lived process.
Options for v1:
1. Accept the limitation: Telegram works only while `ib watch` is
   running. Document and move on.
2. Add a separate `ib telegram-daemon` (or similar) command that runs
   only the dispatcher, no TUI. The user supervises it via launchd or
   any other process manager.
3. Detach the dispatcher into a child process when `ib watch` starts.
   Complicated; defer.

**Recommendation: option 1 for v1.** It mirrors the user's actual
workflow (the dashboard is usually open) and keeps the implementation
local to one process. If real-world use shows the dashboard is closed
too often, ship option 2 in a follow-up.

**Failure modes to handle:**
- Telegram API unreachable on startup (no network): log warning, retry
  on a backoff. Don't crash `ib watch`.
- Mid-poll HTTP failure: log, retry with exponential backoff capped at
  ~30s. The `getUpdates` offset is in memory; on retry, the next call
  sends the same offset — Telegram responds with the same updates
  (idempotent). No durable state required for offset.
- Bot token missing or invalid: log a clear warning ("Telegram routing
  disabled: bot token not configured" / "Telegram API rejected token,
  check `coordinator.telegram_bot_token`"). Don't crash; the rest of
  `ib watch` keeps working.
- Two `ib watch` instances polling the same bot: Telegram serves each
  poller a disjoint subset of updates depending on whose request lands
  first, so messages get split unpredictably. Document as
  "don't run two `ib watch` against the same bot." Detection is hard
  without server-side state; punt for v1.

### 2. Inbound dispatcher (Telegram → coordinator)

When the long-poll loop returns one or more new Telegram updates, the
dispatcher needs to:

1. Filter to allowlisted chat IDs / user IDs (drop everything else
   silently).
2. Resolve which agent this Telegram chat is bound to. v1: hardcoded to
   the system coordinator (`@system` sentinel).
3. Wrap the message text with a channel-reminder block so the
   coordinator knows it's a Telegram message and how to reply.
4. Call `sendToSystemCoordinator(wrapped, { fromAgent: "telegram" })`.

The wrapping format mirrors the channel-system convention but is
ours to define since we are no longer interoperating with the MCP
channel mechanism:

```text
<channel source="telegram" chat_id="8766474645" message_id="47" user="alice" ts="2026-05-03T01:26:30Z">
Hey, can you check on the build?
</channel>

To respond on Telegram, run `ib telegram-reply <chat_id> "<your message>"`
(or `ib ask "<question>"` if you want to ask the user a question and
correlate their reply). The ib-watch dispatcher relays both to this chat.
```

The trailing instruction sentence is the critical UX piece: it tells
Claude (in the coordinator session) which `ib` commands route to
Telegram. Two distinct verbs:
- `ib ask` — for the existing question-asking flow; the dispatcher
  forwards the question and correlates the user's reply via the qid.
- `ib telegram-reply <chat_id> "<text>"` — for plain coordinator-to-user
  messages that don't expect a structured reply (e.g., status updates,
  acknowledgements, "done"). This is a new ib subcommand (see §3).

**Files to touch:**
- New: `src/channels/dispatcher.ts` — the dispatcher itself. Single class
  or module that owns chat-id → agent-id mapping, the wrapping function,
  and the inbound side.
- New: `src/channels/access.ts` — read/write the allowlist file
  (`~/.itsybitsy/channels/telegram/access.json`, mirroring the official
  plugin's location and schema). v1: read-only allowlist; pairing-flow
  comes later.
- **Reuse, don't add:** `sendToSystemCoordinator(message, opts)`
  already exists at `src/index.ts:166`. It validates the coordinator
  tmux session is alive, then calls `sendMessage()` with a synthetic
  agent. The dispatcher should call this directly (not shell out to
  `ib send @system`) — same path, no subprocess overhead, structured
  errors. Pass `fromAgent: "telegram"` (or similar sentinel) so the
  message tag in the coordinator session reflects its origin.

**Failure modes:**
- Coordinator not running when message arrives:
  `sendToSystemCoordinator()` returns `{ ok: false, ... }` with a
  message saying so. Reply on Telegram with "coordinator offline,
  message dropped." Don't queue — keeps state minimal in v1.
- Sender not in allowlist: drop silently. Do not echo back; that's a
  prompt-injection vector.

### 3. Outbound dispatcher (coordinator → Telegram)

Two outbound paths from the coordinator's perspective:

**3a. `ib telegram-reply <chat_id> "<text>"` — fire-and-forget.**

A new ib subcommand. The coordinator runs it to send a plain message
to a Telegram chat without expecting a structured reply (status
updates, "done", "ok, working on it"). Dispatch:

1. `ib telegram-reply` runs as a normal subprocess from the coordinator.
2. It writes the request to a small on-disk file or unix-domain socket
   that the dispatcher in `ib watch` is watching, OR — simpler — it
   just makes the Telegram API call itself.

Picking between those two: **the subcommand should make the API call
itself.** Reasons:
- Keeps `ib telegram-reply` working even if `ib watch` is closed
  (sometimes the user runs the coordinator's claude session via an
  attach-to-tmux without the dashboard up).
- The bot token is already in config; both `ib watch` and
  `ib telegram-reply` can read it.
- No new IPC primitive to design.

The downside: two processes can hit the Telegram API concurrently if
`ib watch`'s outbound qid-formatted question and an
`ib telegram-reply` race. Telegram handles this fine (rate-limited per
bot, but our throughput is human-scale). Acceptable.

**Naming:** `telegram-reply` is explicit but verbose. Alternatives:
`tg-reply`, `tg`, `reply-telegram`. Pick during implementation; the
plan keeps `telegram-reply` for clarity. Add an alias if the long form
proves annoying.

**3b. `ib ask "..."` interception — question/answer with correlation.**

When the system coordinator calls `ib ask "..."`, we want the question
to flow to Telegram (not just sit in `user-questions.json`) and the
user's reply to flow back via `ib send <coordinator-id> "..."`.

`ib ask` today writes the question to
`<repo>/.ittybitty/user-questions.json` and exits. The dispatcher in
`ib watch` is already watching that file via the `AgentWatcher` (it
notices new pending questions for sidebar display via
`readPendingQuestions()` in `src/agents.ts`). The cleanest way to
intercept:

1. **Detect** new pending questions where the asking agent is the
   system coordinator. (The `Agent` synthesized for `@system` carries a
   distinguishing marker; if not, the dispatcher can match by tmux
   session name.)
2. **Forward** the question text to Telegram, prepended with the qid:
   ```text
   ❓ Question (reply `abc12: <answer>`):

   Should I deploy to staging?
   ```
3. **Track** the qid in an in-memory table keyed by qid, with the
   `chat_id` and the asking agent's coordinator session name as values.

**No code changes to `askQuestion()` itself.** The dispatcher works
purely off the existing on-disk state. This is the load-bearing
simplification: there is no fallback path to design (the local prompt
flow doesn't apply — the coordinator runs in a tmux session with no
human at a TTY for prompts), and there is no coupling between
`src/ib-commands.ts` and the channels code.

**Question identification:** the question record in
`user-questions.json` already has `id`, `agent`, `question`, `timestamp`,
`status`. The dispatcher checks `agent` against the `@system`
coordinator and sees `status: "pending"` to know it's a fresh question.
Once forwarded, the dispatcher remembers the qid in its in-memory
table; on the next file refresh it should *not* re-forward already-seen
qids — guard against double-send.

**Files to touch:**
- New: `src/channels/dispatcher.ts` — outbound side: hook into the
  watcher's `onUpdate` callback (or read `user-questions.json` on the
  same poll cycle), forward newly-pending qids for `@system`.
- Modified: `src/index.ts` — add the `case "telegram-reply":` dispatch
  for the new subcommand.
- New: `src/ib-commands.ts` — `telegramReply(chatId, text): Promise<IbCommandResult>`
  — reads token from config, calls the Telegram client, returns the
  standard result type.

**Question for design discussion:**

Where does the qid ↔ chat_id mapping live? Two choices:

1. **In-memory in `ib watch`.** Simple. Loses correlation if `ib watch`
   restarts, but the question itself survives in `user-questions.json`,
   so on restart the dispatcher re-forwards (with a warning to the user
   on Telegram so they know).
2. **On disk** (e.g., `~/.itsybitsy/channels/pending-questions.json`).
   Survives `ib watch` restarts but adds complexity.

**Recommendation: in-memory for v1, with re-forward on restart.** Add
a "since-startup-seen" flag to in-memory entries; on the first refresh
after startup, forward any pending question and mark it seen. The user
gets the question once, possibly twice if they restart `ib watch`
mid-pending-question. Acceptable for v1.

**Failure modes:**
- Telegram unreachable when forwarding `ib ask`: leave the question
  pending in `user-questions.json` (it's already there), retry on the
  next poll cycle. Log the failure to the coordinator's view if
  practical. The user can also see the question via `ib q` from any
  shell.
- User answers on Telegram but `ib watch` has restarted and lost the
  qid table: handle in §4 below.

### 4. Reply correlator

When a Telegram message arrives that matches a known qid pattern, the
dispatcher should:

1. Look up the qid in the pending-questions table.
2. If found:
   a. Call `acknowledgeQuestion(repoPath, qid)` (in `src/ib-commands.ts:3139`)
      — this only flips `status: "acknowledged"` on the question record.
   b. Call `sendToSystemCoordinator(replyText, { fromAgent: "telegram" })`
      with the qid prefix stripped — this is the actual answer text the
      coordinator session needs to see on its stdin.
   c. Drop the qid from the in-memory table.
3. If not found: treat it as a normal inbound message (route via §2).
   The user may have meant to answer a question that's no longer
   pending, or they typed a qid-shaped message by accident; either way,
   falling through to the chat-route is the conservative behavior.

**Important correction vs. the original draft:** `ib acknowledge` does
*not* accept a reply argument. Its signature is `acknowledgeQuestion(
repoPath, questionId)` — it just marks the question acknowledged in
`user-questions.json` so the TUI's pending-questions list updates. The
*answer* must be delivered separately via `sendMessage` /
`sendToSystemCoordinator`. The dispatcher must call both.

**Two-step caveat:** there is a brief window between `acknowledgeQuestion`
and `sendToSystemCoordinator` where the question is acknowledged but
the answer hasn't been delivered. If `sendToSystemCoordinator` fails,
the user thinks their reply was received but the coordinator never
sees it. Mitigation:
- Call `sendToSystemCoordinator` *first*, then `acknowledgeQuestion`
  only if the send succeeded. (Reverses the order vs. above.)
- On send failure, reply on Telegram with "delivery failed, your reply
  was: <quoted>". The user can re-send or fall back to `ib q` /
  `ib send` from a shell.

The qid format: itsybitsy's existing `askQuestion()` generates qids of
the form `q-<unix-epoch>-<6-char-md5-hex>` (see `src/ib-commands.ts:3115`).
That's far too long to type on a phone. Two ways to handle this:

1. **Generate a Telegram-friendly short alias.** When the dispatcher
   forwards a question, allocate a short alias (5 lowercase letters,
   the channel-reference convention) and map alias → real qid in
   memory. Show the alias on Telegram; the user replies `alias: text`,
   the dispatcher resolves to the real qid.
2. **Use the real qid suffix.** Show the last 6 hex chars of the qid as
   the user-visible token. Less robust against collisions but no
   in-memory mapping needed (just scan pending questions for one whose
   id ends with the token).

**Recommendation: option 1.** Six hex chars are still tedious, and the
in-memory mapping is one line of code. Use the channel-reference regex
for parsing user replies:

```ts
const QID_REPLY_RE = /^\s*([a-km-z]{5})\s*[:.]?\s*(.+)$/i
```

**Files to touch:**
- Modified: `src/channels/dispatcher.ts` — adds the regex check at the
  top of the inbound handler before falling through to the chat-route.
  Also owns the alias → qid map.

**Permission-relay parallels:**

The same correlator pattern handles permission requests if/when we want
them. v1 doesn't need this; flag it for v2.

## Configuration

New config keys (defined in `src/config.ts`):

| Key | Type | Description |
|---|---|---|
| `coordinator.telegram_bot_token` | string | The Telegram Bot API token (e.g., `123456:ABC-DEF...`). When unset or empty, Telegram routing is disabled. |
| `coordinator.telegram_chat_id` | string | The Telegram chat ID this bot routes inbound messages from and outbound replies to. v1 supports a single chat. |

These follow the existing `coordinator.*` namespace (`coordinator.model`,
`coordinator.imessage`). The bot token replaces the
`coordinator.telegram: bool` flag entirely — its presence/absence is
the enable signal.

**Removed config:** `coordinator.telegram` (bool). It currently gates
appending `--channels plugin:telegram@claude-plugins-official` to the
coordinator's `claude` command (`src/coordinator.ts:296-301`). Per the
user, the official Telegram plugin should not be used at all. Remove
both the config key and the `--channels plugin:telegram@...` branch.

**Unchanged config:** `coordinator.imessage` stays exactly as-is. It
serves a separate per-repo coordinator / iMessage use case
(see project memory) and is wired through Claude's plugin channels,
not through the new ib-layer dispatcher. This plan does not touch
iMessage routing.

**Allowlist file:** `~/.itsybitsy/channels/telegram/access.json`
(itsybitsy-owned, separate from any `~/.claude/channels/...` path the
removed plugin used). Schema for v1:
```json
{
  "allowed_chat_ids": ["8766474645"],
  "allowed_user_ids": []
}
```
Either list non-empty grants access; both empty means deny-all.

**No `.mcp.json` writer to remove:** the original draft mentioned
`writeCoordinatorMcpConfig` in `src/coordinator.ts`. That function
does not exist in the current codebase. The MCP-server approach was
introduced and reverted (commits `b4e042f` → `97874c6`); today the
Telegram integration is exclusively the `--channels plugin:...` flag
above. There is nothing else to delete on the MCP side.

## Cutover plan

This is the order to ship without breaking anything mid-flight.

1. **Add config keys** (`coordinator.telegram_bot_token`,
   `coordinator.telegram_chat_id`) and the new
   `~/.itsybitsy/channels/telegram/access.json` schema. No behavior
   change yet — just config plumbing and validation.
2. **Land §1 (Telegram client) and §2 (inbound dispatcher).**
   `ib watch` long-polls Telegram and routes inbound messages to the
   system coordinator via `sendToSystemCoordinator()`. The
   `--channels plugin:telegram@...` registration on the coordinator
   stays in place during this step — the user gets messages two ways
   if they keep both enabled. Verify the new path works.
3. **Land §3 (outbound dispatcher) and §4 (reply correlator).** New
   `ib telegram-reply` subcommand ships; the dispatcher forwards `ib
   ask` questions to Telegram and correlates replies via aliases.
4. **Remove the `--channels plugin:telegram@...` branch and the
   `coordinator.telegram` config key.** Edit `src/coordinator.ts:296-301`
   to drop the `telegram` push to the `channels` array and the
   surrounding `const telegram = config["coordinator.telegram"]?.value`
   read. Drop the key from `src/config.ts`. After this step, the
   official Telegram plugin is no longer attached to the coordinator
   session.

Each step is independently testable and rollback-able.

## Testing strategy

### Unit tests

- **Allowlist filter**: given a Telegram update, returns true/false
  correctly for allowlisted vs. non-allowlisted chat/user IDs.
- **Channel-reminder wrapping**: given chat metadata + body, produces
  the expected `<channel ...>...</channel>` block.
- **Outbound qid mapping**: forwarding a question allocates a unique
  alias; the alias resolves back to the qid. Re-forwarding the same
  qid in a second poll cycle does not produce a duplicate forward.
- **Reply correlator regex**: `QID_REPLY_RE` matches `abc12: yes`,
  `abc12 yes`, `ABC12: YES`, but not `12345: text` (digits) or
  `abcde fghij` (no separator + extra word).
- **Two-step ack ordering**: simulated `sendToSystemCoordinator`
  failure leaves the question in `pending` (not acknowledged), and the
  dispatcher generates the user-facing "delivery failed" reply.

### Integration tests

- **End-to-end inbound**: feed a fake `getUpdates` response to a
  mocked Telegram client, verify `sendToSystemCoordinator` was called
  with the wrapped text. Use the existing `coordinatorSpawnCtx`
  mocking pattern to capture the resulting tmux send-keys.
- **End-to-end outbound**: simulate `askQuestion()` writing a new
  pending question for the coordinator agent; verify the dispatcher
  detects it on its next refresh and calls
  `telegramClient.sendMessage(chatId, formattedText)`.
- **Roundtrip**: question goes out → reply arrives → `acknowledgeQuestion`
  flips status → `sendToSystemCoordinator` delivers stripped reply.
  Use a mock Telegram client and the existing watcher refresh hook.
- **Telegram unreachable**: mock `getUpdates` to throw; verify backoff
  retry loop runs and `ib watch` does not crash.

### Manual / live tests (gated on local Telegram bot token)

- Send a message → see it in the coordinator session.
- Coordinator runs `ib ask "..."` → see it on Telegram with an alias.
- Reply `alias: text` → see the question acknowledged in `ib q` and
  the answer arrive on the coordinator's stdin.
- Coordinator runs `ib telegram-reply <chat_id> "done"` → see the plain
  message arrive on Telegram.
- Send a non-alias message while a question is pending → it goes to
  chat route, question stays pending.
- Restart `ib watch` mid-pending-question → on the next refresh, the
  question is re-forwarded once with a new alias.

## Open questions

These should be settled during implementation, not before:

- **One Telegram chat per coordinator, or many?** v1: one. Future:
  configurable.
- **What does the channel-reminder text look like exactly?** The
  example above is a starting point; refine on first user-feedback
  pass.
- **Auto-start vs. opt-in dispatch.** When `ib watch` starts, should
  the dispatcher run automatically if `coordinator.telegram_bot_token`
  is set, or does it need a separate `coordinator.telegram_enabled`
  flag? Recommend: automatic — token presence is the enable signal.
  Add a `--no-telegram` `ib watch` flag for the rare case the user
  wants to start the dashboard without polling.
- **What if the coordinator session restarts mid-pending-question?**
  The coordinator's view of the question goes away (its own state
  resets), but the question record in `user-questions.json` does not.
  When the user replies on Telegram, we'll deliver the answer to the
  fresh coordinator session via `sendToSystemCoordinator`, but the
  coordinator will have no context for what the answer is responding
  to. v1: include the original question text alongside the answer
  when delivering, so the coordinator can pick up the thread:
  `[answer to "Should I deploy to staging?"] yes`.
- **Multi-machine / multi-user scenarios.** Out of scope for v1.

## Migration from current state

Today:
- The system coordinator's `claude` command optionally includes
  `--channels plugin:telegram@claude-plugins-official` when
  `coordinator.telegram` is true (`src/coordinator.ts:298`).
- The official plugin handles bot polling and exposes a `reply` tool
  inside the coordinator's claude session.
- The user has decided not to use this path. (An alternative
  MCP-server experiment via a `.mcp.json` writer was tried and
  reverted in commits `b4e042f` → `97874c6`.)

After v1:
- `ib watch` long-polls Telegram directly using the bot token from
  `coordinator.telegram_bot_token`.
- The dispatcher relays inbound messages to the system coordinator via
  `sendToSystemCoordinator`. Coordinator outbound goes via either
  `ib ask` (correlated Q&A) or `ib telegram-reply` (fire-and-forget).
- The `--channels plugin:telegram@...` registration is removed; the
  coordinator's claude session has no Telegram awareness at all.

The user-visible difference: messages arrive in the coordinator wrapped
in our channel-reminder block (no MCP `<channel>` injection), and
outbound goes through `ib` subcommands rather than a `reply` MCP tool.

## What this is *not* tackling

- Permission relay (per-tool approval prompts on Telegram). The
  channel-reference covers this; we'd reimplement it on top of
  `ib acknowledge`. Defer to v2.
- Group chat support, mention-detection, multi-chat routing. v1 is
  single-user, single-chat.
- Pairing flow / out-of-band ID capture. v1 uses static config. The
  pairing flow the official plugin ships can be ported later.
- File / image attachments inbound or outbound. v1 is text-only. The
  bot already handles attachments correctly (downloads to inbox); the
  dispatcher just needs to surface the local path in the channel-reminder
  block. Probably a small v1.5 follow-up rather than v1 scope.
- iMessage / Slack / Discord parity. Designed to generalize, but v1
  ships only Telegram.

## Estimated scope

Rough sizing, not a commitment:

| Piece | Lines | Confidence |
|---|---|---|
| §1 Telegram client (`fetch`-based getUpdates/sendMessage) | ~120 | high — small, well-defined HTTP API |
| §2 inbound dispatcher (poll loop + allowlist + wrapping) | ~200 | medium — wrapping format and lifecycle inside `launchDashboard` to nail down |
| §3 outbound dispatcher + `ib telegram-reply` subcommand | ~250 | medium — pending-question polling, alias allocation |
| §4 reply correlator (regex + two-step ack/send) | ~100 | high — small isolated logic |
| Config keys + access.json plumbing | ~80 | high |
| Tests for all of above | ~600 | matches existing test density |
| Cutover (remove `coordinator.telegram` config + plugin registration) | ~30 lines deleted | trivial |
| **Total** | **~1350 net new, ~30 deleted** | — |

For comparison, the merged "Telegram MCP server entry" change was
~160 lines. This is meaningfully bigger but localized to
`src/channels/` plus surgical edits in `src/index.ts` (add
`telegram-reply` case), `src/ib-commands.ts` (add `telegramReply()`),
`src/coordinator.ts` (remove plugin registration), `src/config.ts` (new
keys), and `src/tui/dashboard.ts` (start/stop dispatcher in
`launchDashboard()`).

## See also

- [Telegram Bot API](https://core.telegram.org/bots/api) —
  `getUpdates` and `sendMessage` endpoints used by the Telegram client.
- [Channels reference](https://code.claude.com/docs/en/channels-reference) —
  the official MCP channel-server contract. We are *not* implementing
  it, but the wrapping/permission-relay conventions are useful priors
  for the channel-reminder format and qid-alias regex.
- `src/index.ts:166` — `sendToSystemCoordinator()`, the existing helper
  the inbound dispatcher reuses.
- `src/ib-commands.ts:3048` — `askQuestion()`, which writes
  `user-questions.json` (the dispatcher reads it).
- `src/ib-commands.ts:3139` — `acknowledgeQuestion()`, which the
  reply-correlator calls to flip status.
- `src/coordinator.ts:296-301` — current Telegram plugin registration;
  removed in §4 of the cutover plan.
