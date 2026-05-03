# Telegram routing — post-merge sanity check

Run through this after merging the Telegram phases to main and rebuilding
the binary. The full unit-test suite (2568 tests) covers the implementation
with mocked `fetch`, but only a live bot can validate the wire format,
the actual coordinator-tmux interaction, and graceful shutdown.

## 1. Build the binary

```sh
bun build --compile --minify --sourcemap index.ts --outfile ib
```

Phase 5 added new dynamic imports (`./channels/dispatcher`,
`./channels/access`, `./channels/telegram-client`). Tests run from source,
so they can't catch a missed-bundling failure. If the build fails or the
binary throws "Cannot find module" at runtime, that's the first thing to
fix.

Optional: install the rebuilt binary to your PATH (`sudo cp ib /usr/local/bin/ib`)
if that's how you run it.

## 2. Telegram setup

One-time setup if you don't already have a bot:

1. Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`,
   follow the prompts, save the token it gives you (looks like
   `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`).
2. Find your chat ID: from your own Telegram account, send any message to
   your new bot, then visit
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Look for
   `chat.id` in the response (a positive integer for 1:1 DMs).

## 3. Configure

Edit `~/.itsybitsy/config.json`:

```json
{
  "channels": {
    "telegram": {
      "bot_token": "<TOKEN_FROM_BOTFATHER>",
      "chat_id": "<YOUR_CHAT_ID>"
    }
  }
}
```

Then allowlist your chat ID and confirm the bot is reachable:

```sh
ib tgallow <YOUR_CHAT_ID>
ib tgcheck
```

`ib tgcheck` should print "OK: bot reachable" along with the configured
chat_id and the allowlist contents. If it warns about a group-shaped
chat_id (negative integer), you've configured a group ID — group chats
aren't supported in v1, use a 1:1 DM ID instead.

## 4. Smoke tests

Run these in order. Each catches a different failure class — if step N
fails, fix it before moving on.

### 4.1. Outbound (catches token/chat_id misconfiguration)

```sh
ib tgsend "hello from ib"
```

Expected: prints `ok`, the message arrives in your Telegram chat from the
bot.

If this fails, your token or chat_id is wrong — nothing else will work
until this does.

### 4.2. Inbound, single message (catches dispatcher startup, allowlist,
channel-reminder format)

```sh
ib watch
```

Then text your bot `ping` from your Telegram account.

The system coordinator should receive a message wrapped like:

```
<channel source="telegram" user="<your_username>" ts="...">
ping
</channel>

To reply on Telegram, run `ib tgsend "<your message>"`.
```

If the coordinator doesn't see anything:
- Look at `ib watch`'s stderr for "Telegram routing disabled" — means the
  token wasn't set or the dispatcher didn't start.
- Look for "Telegram routing disabled: another poller or webhook is
  active" — means a webhook is set or another process is polling. See
  step 4.8.
- Check that `ib tgallow <YOUR_CHAT_ID>` was run with the right ID.

### 4.3. Multi-line inbound (validates Phase 3-was-dropped assumption)

Text your bot a 3-line message:

```
line one
line two
line three
```

Expected: the coordinator receives ONE turn with the newlines preserved
inside the `<channel>` block. If you see three separate coordinator turns
with `line one`, `line two`, `line three` each as its own turn, then
`tmux send-keys -l` is NOT preserving `\n` after all and we need to bring
back the dropped Phase 3 (`multiline` mode for `sendMessage`). Report the
symptom — easy fix, but a fix.

### 4.4. Burst coalesce

Text 3 messages within ~25s of each other (the long-poll window):

```
hey
quick question
nevermind, figured it out
```

Expected: the coordinator receives ONE turn wrapped like:

```
<channel source="telegram" chat_id="..." user="..." first_ts="..." count="3">
hey
---
quick question
---
nevermind, figured it out
</channel>

To reply on Telegram, run `ib tgsend "<your message>"`.
```

If you see 3 separate coordinator turns instead of one coalesced block,
the burst coalescing didn't fire — possibly the messages arrived in
separate `getUpdates` polls (try sending them faster).

### 4.5. Round-trip

In the coordinator session, run:

```sh
ib tgsend "got it, working on it"
```

Expected: the message arrives in your Telegram chat. The coordinator
already saw your inbound message in step 4.4; this confirms the outbound
path works in the same session.

### 4.6. Attachment fallback

From Telegram, send your bot an image with no caption.

Expected:
- Telegram replies (from your bot) with "Received attachment — text only
  supported."
- The coordinator receives `<channel ...>[user sent photo]</channel>`.

Then send another image WITH a caption (e.g. "what is this?"). Expected:
- The coordinator receives the caption as the body of the channel-reminder
  block (not the bare attachment-notice).
- No "Received attachment" reply — the caption already gave the
  coordinator something to work with.

### 4.7. Graceful shutdown

While `ib watch` is running and a long-poll is in flight, quit it
(`q` from the dashboard, or Ctrl+C).

Expected: process exits within ~1-2s. The AbortController cancels the
in-flight `getUpdates` fetch, the dispatcher loop unwinds, and the TUI
exits.

If it hangs for more than ~3s, the AbortController plumbing has a bug
that the unit tests didn't catch. Report the symptom.

### 4.8. 409 Conflict (only if you have a way to trigger it)

Start a second poller against the same bot token (e.g. open
`https://api.telegram.org/bot<TOKEN>/getUpdates?timeout=30` in a browser
tab and reload it repeatedly), then `ib watch`.

Expected: `ib watch`'s stderr logs "Telegram routing disabled: another
poller or webhook is active" and the rest of the TUI works normally.
You can still use the dashboard, spawn agents, etc. — just no Telegram
routing.

This is also what you'll see if a stray webhook was left configured on
the bot. To clear a webhook:

```sh
curl https://api.telegram.org/bot<TOKEN>/deleteWebhook
```

## 5. Things to watch in early use

These aren't pre-merge blockers — they're things to keep an eye on as you
use the integration day-to-day.

- **Coordinator session restarts.** If you trigger
  `restartSystemCoordinator` while messages are in flight, the dispatcher
  hits its "retry once after 2s, then reply 'coordinator offline'" path.
  Worth confirming this looks reasonable when it happens.
- **Long polls during sleep/network change.** Close laptop → reopen → the
  in-flight fetch fails (ETIMEDOUT or similar) → the outer retry loop
  should backoff and recover. Watch `ib watch`'s stderr; one log line per
  unique error class is expected, not one per attempt.
- **Token in `config.json`.** Phase 2 added `ensureConfigFilePerms` to
  chmod the file to 0600 on every write. The token is sensitive — if you
  ever back up or share `~/.itsybitsy/config.json`, the bot token goes
  with it.

## 6. Rollback options

If something goes sideways and you need to disable Telegram routing
without reverting:

```sh
# In ~/.itsybitsy/config.json, set bot_token to "" or remove the key.
```

The Phase 0 auto-start gate skips dispatcher startup when the token is
unset. No other side effects — `ib watch` boots normally, just without
Telegram.

If you need to fully revert the work:

```sh
git revert <commit-range>
```

The 7 Telegram commits are independently revertable. Phase 1's removal of
the `coordinator.telegram` config key + `plugin:telegram` channel
registration is in `fdc1314` — reverting that one alone restores the
official Telegram plugin path if you want it back temporarily.

## 7. Reporting issues

If a smoke test fails:
- Capture the exact symptom (what you did, what the coordinator saw, what
  Telegram showed, any stderr from `ib watch`).
- Note which step failed and which steps succeeded before it.
- That's enough context to dispatch a fix-worker against the specific
  failure class.
