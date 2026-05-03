# Telegram routing — phased implementation plan

Derived from [`telegram-ib-routing.md`](./telegram-ib-routing.md) (the design)
and [`telegram-implementation-notes.md`](./telegram-implementation-notes.md)
(plugin-derived refinements). Each phase is independently testable, mergeable,
and rollback-able. Phases are ordered so the system is never left in a half-broken
state — Telegram routing simply goes offline between Phase 1 and Phase 6.

---

## Phase 0 — Prep & decisions (no code)

Settle the few open questions that affect schema/wire format before anyone
writes code. Output is a short addendum to the plan, not a PR.

**Decisions to lock:**
- **Bot token storage location.** Plan puts it in `~/.itsybitsy/config.json`.
  Confirm that file is mode 0600. If not, either chmod it on touch or follow
  the official plugin's pattern of a separate `.env` file at
  `~/.itsybitsy/channels/telegram/.env` (mode 0600). Decide before Phase 2.
- **`TELEGRAM_API_BASE` env override.** Recommend yes, defaults to
  `https://api.telegram.org`. Cheap to add now, expensive to retrofit.
- **Auto-start vs `--no-telegram` flag.** Recommend auto-start when token
  present; add `--no-telegram` to `ib watch` for the escape hatch.
- **Channel-reminder text — final wording.** Pick one phrasing and stick with
  it; the inline reply hint vs. one-shot orientation block tradeoff is called
  out in implementation-notes §7.

**Exit criteria:** decisions documented (append to `telegram-ib-routing.md`
under a "Decisions" heading or inline in §"Open questions").

---

## Phase 1 — Cutover prerequisite: remove the official plugin wiring

Single goal: stop the official Telegram plugin from being attached to the
coordinator, so there's no risk of two pollers hitting the same bot token
once Phase 5 lands.

**Changes:**
- `src/coordinator.ts:ensureSystemCoordinator` — drop the `telegram` push
  into the `channels` array and the surrounding config read.
- `src/config.ts` — remove the `coordinator.telegram` config key (and any
  default).
- Verify: with `coordinator.imessage=true` and no telegram, the coordinator
  still launches with `claude --model opus --channels plugin:imessage@...`.

**Tests:**
- Update existing coordinator-launch tests to drop telegram cases.
- Add a regression test: `ensureSystemCoordinator()` does not include
  `plugin:telegram` in its argv under any config.

**State after:** Telegram routing is offline. iMessage routing unaffected.
Everything else works.

**Exit criteria:** `bun test` green, `bunx tsc --noEmit` clean, manual
confirmation that `ib watch` starts the coordinator without a Telegram
plugin attached.

---

## Phase 2 — Config + access.json + admin subcommands

Pure plumbing. No network, no dispatcher, no message flow yet. Establishes
the config keys, the allowlist file, and the admin verbs the user needs to
configure things in Phase 5.

**New files:**
- `src/channels/types.ts` — minimal hand-rolled subset of Bot API types
  (`TelegramUpdate`, `TelegramMessage`, `TelegramChat`). No grammy.
- `src/channels/access.ts` — read/write
  `~/.itsybitsy/channels/telegram/access.json` with:
  - Atomic write: `tmp + rename` (implementation-notes §8.3).
  - Corrupt-file recovery: rename aside to `.corrupt-<timestamp>` and start
    with empty allowlist (implementation-notes §8.2).
  - `mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })`
    (implementation-notes §8.4).
  - Group-shape detection: `chat_id` starting with `-` is a group →
    warning helper exposed for `ib tgcheck`.

**Modified:**
- `src/config.ts` — add `channels.telegram.bot_token` and
  `channels.telegram.chat_id` keys. Defaults: empty strings → "disabled".
- `src/index.ts` — add `tgallow`, `tgdeny`, `tgcheck` subcommand cases.
  - `ib tgallow <chat_id>` — adds entry, idempotent.
  - `ib tgdeny <chat_id>` — removes entry, idempotent.
  - `ib tgcheck` — prints config status (token set? chat_id set?
    allowlist contents?), warns on group-shaped IDs. Does NOT hit the
    network in this phase (live probe lands with Phase 4).

**Tests:**
- `access.ts` round-trip: write → read → equality.
- Atomic write: kill mid-write, file is either old or new (never partial).
- Corrupt-file recovery: malformed JSON → renamed aside, empty allowlist.
- Allowlist filter: empty lists = deny-all; one entry = allow that one.
- `ib tgallow`/`tgdeny` idempotency: running twice is a no-op.
- `tgcheck` group-shape warning fires on negative chat_id.

**Exit criteria:** All admin commands work, no network code yet,
`bun test` + `tsc --noEmit` green.

---

## Phase 3 — `multiline` mode for `sendMessage`

Self-contained refactor of `src/ib-commands.ts:sendMessage`. No callers use
`multiline: true` yet — added in Phase 5. Lands as its own change so the
diff stays reviewable.

**Changes:**
- Add `{ multiline?: boolean }` opt to `sendMessage`.
- When `multiline: true`: chunk on `\n`, use `tmux send-keys -l <chunk>`
  per chunk with `tmux send-keys Enter` between chunks (the
  literal-then-Enter pattern from
  `autoAcceptWorkspaceTrustForNewAgent`). One final Enter to submit.
- When `multiline` is absent or false: behavior is byte-identical to today.
- Sentinel handling for `fromAgent` starting with `@` already exists; no
  change needed for `@telegram` to be formatted as
  `[sent by @telegram]: ...` (verify with a test).

**Tests:**
- `multiline: true` with embedded `\n` → captured tmux call sequence has
  alternating chunk/Enter calls + one final Enter.
- `multiline: false` → byte-identical capture vs. baseline (regression).
- `fromAgent: "@telegram"` formats prefix as `[sent by @telegram]: ...`.

**Exit criteria:** New opt is fully tested, no behavior change for
existing callers, `bun test` + `tsc --noEmit` green.

---

## Phase 4 — Telegram transport client

The `getUpdates` + `sendMessage` HTTP wrapper. Network code, but no
dispatcher and no wiring into `ib watch` yet. Pure library — exercised
only by tests in this phase.

**New file:**
- `src/channels/telegram-client.ts`:
  - `getUpdates({ offset, limit, timeout, allowed_updates, signal })` —
    long-poll via `fetch()` with `AbortController`. Pass
    `allowed_updates: ["message"]` by default to cut payload noise
    (implementation-notes open-question 2).
  - `sendMessage({ chat_id, text })` — POST.
  - Base URL from `TELEGRAM_API_BASE` env or
    `https://api.telegram.org` default (Phase 0 decision).
  - **Outer retry loop pattern** (implementation-notes §3): wrap the
    long-poll in `for(;;) try { ... } catch { backoff; continue }`.
    Reset backoff on a successful poll. Exponential backoff capped at
    ~30s.
  - **429 handling:** parse `Retry-After`, sleep, retry.
  - **409 handling:** retry with backoff during normal polling
    (implementation-notes §2 — different from startup-probe 409, which
    Phase 5 handles by skipping).
  - **One-warning-per-error-class** logging (implementation-notes §3).
  - Never log URLs verbatim — they embed the bot token.

**Tests:**
- `getUpdates` happy path (mocked fetch).
- `getUpdates` 429 → sleeps `Retry-After` then retries.
- `getUpdates` 409 mid-poll → retries with backoff.
- `getUpdates` network throw → backoff, retry, no crash.
- `getUpdates` AbortController → cancels in-flight fetch within ~1s.
- `sendMessage` happy path.
- `sendMessage` chunking at 4000 chars (implementation-notes §5):
  4500-char input produces two `sendMessage` calls. **Add the chunk
  helper here** (copy from official plugin `server.ts:357-376`,
  drop the `mode` param for v1).
- One-warning-per-error-class: 5 consecutive ETIMEDOUTs → 1 log line,
  not 5.

**Exit criteria:** Client class is fully testable in isolation, no
caller wires it up yet.

---

## Phase 5 — Inbound dispatcher wired to `ib watch`

The big phase. This is where Telegram routing comes back online.

**New file:**
- `src/channels/dispatcher.ts`:
  - **Startup probe:** single
    `getUpdates(offset=-1, limit=1, timeout=0)`. On 409 Conflict → log
    "Telegram routing disabled: another poller or webhook is active"
    and return without starting the loop. Rest of the TUI keeps
    running.
  - **Main loop:** await client's outer-retry-wrapped `getUpdates`
    polling. Each batch:
    1. Filter to allowlisted `chat_id` / `user_id` (drop others
       silently; rate-limited log entry per chat_id per hour for
       debugging).
    2. **Defensive destructure:** `update.message?.text ?? update.message?.caption ?? ""`
       (implementation-notes §6). A photo with caption = surface the
       caption; missing both = attachment-notice.
    3. **Strip `</channel>` from inbound text** before wrapping
       (implementation-notes open-question 3).
    4. **Coalesce burst:** all updates from same chat in one
       `getUpdates` payload → one wrapped block with `count="N"` +
       `---` separators. Single-update bursts skip the `count`/separator
       noise.
    5. Wrap in channel-reminder block per Phase 0 final wording.
       Coerce all IDs to `String()` (implementation-notes §6).
    6. Acquire per-coordinator-session mutex (in-process); call
       `sendToSystemCoordinator(wrapped, { fromAgent: "@telegram", multiline: true })`.
       Release mutex.
  - **Attachment fallback:** for unsupported message types, reply on
    Telegram with "Received attachment — text only supported" AND
    surface to coordinator as
    `<channel ...>[user sent <type>: <caption or filename>]</channel>`.
    Defensive sanitization (`safeName()` from official plugin
    `server.ts:896-898`) if filename ever surfaces — implementation-notes §6.
  - **Coordinator-offline handling:** if `sendToSystemCoordinator`
    returns `ok: false`, retry once after 2s
    (open-question 2 in plan), then reply on Telegram with
    "coordinator offline, message dropped — start it with `ib watch`."
  - **Graceful shutdown:** `stop()` method aborts the in-flight
    `getUpdates` fetch via `AbortController`. Returns when loop has
    exited.

**Modified:**
- `src/tui/dashboard.ts:launchDashboard` — instantiate dispatcher
  alongside `AgentWatcher`. Await `dispatcher.stop()` (with a 2s
  timeout race) on TUI exit before returning. Don't `process.exit()`
  synchronously — implementation-notes §4.
- `src/agents.ts` — document `@telegram` sentinel alongside `@system`
  in `SpawnedBy` comments. No code change beyond comments.
- `src/index.ts` — wire `ib tgcheck` to actually call the live probe
  via the client (was placeholder in Phase 2).
- `src/tui/dashboard.ts` (or wherever flag parsing lives) — add
  `--no-telegram` flag for `ib watch` per Phase 0 decision.

**Tests:**
- End-to-end inbound (text): mocked `getUpdates` response →
  `sendToSystemCoordinator` called with wrapped text +
  `multiline: true` + `fromAgent: "@telegram"`.
- Resulting `coordinatorSpawnCtx` send-keys sequence has alternating
  chunk/Enter + one final Enter (validates Phase 3 wiring).
- Burst coalescing: 3 updates same chat → 1 wrapped block with
  `count="3"` + `---` separators. 1 update → no count, no separators.
- Per-coordinator serialization: 2 updates from 2 chats arriving
  rapidly → mutex serializes the two `sendToSystemCoordinator` calls.
- Coordinator offline: `tmux has-session` returns non-zero →
  dispatcher retries once, then replies "coordinator offline" on
  Telegram, no retry-storm.
- Allowlist drop: non-allowlisted sender → no
  `sendToSystemCoordinator` call, one log line per hour per chat_id.
- Attachment with caption: `caption` becomes channel-reminder body
  (not bare attachment-notice).
- Bare attachment (no caption): "Received attachment" reply +
  `[user sent photo]` channel-reminder.
- `</channel>` in user text: stripped before wrapping (no forged
  closing tag).
- 409 on startup probe: dispatcher logs and returns; `ib watch` keeps
  running.
- Dispatcher throw inside `forEach` over updates does NOT break the
  next iteration (implementation-notes §3).

**Exit criteria:** Manual smoke test on a live bot:
- Send text → see one coordinator turn.
- Send multi-line text → arrives as one turn (no early submit).
- Send 3 quick messages → one coalesced turn.
- Send image (no caption) → "Received attachment" reply.
- Quit `ib watch` → exits within ~1s.

---

## Phase 6 — `ib tgsend` outbound subcommand

Smallest phase. Reuses the Phase 4 client.

**Modified:**
- `src/index.ts` — add `tgsend` subcommand case.
- `src/ib-commands.ts` — add `telegramSend(text)`:
  1. Read `channels.telegram.bot_token` and `channels.telegram.chat_id`.
     Missing either → exit 1 with clear error.
  2. Chunk at 4000 chars (Phase 4 chunk helper).
  3. Call client `sendMessage` per chunk.
  4. Print `ok` (single chunk) or `ok (N parts)` (multi-chunk).
  5. On 4xx/5xx: print response, exit non-zero.
  6. On 429: parse `Retry-After`, sleep, retry once. Still 429 →
     give up, exit non-zero.

**Tests:**
- Missing token → exit 1, message mentions
  `channels.telegram.bot_token`.
- Missing chat_id → exit 1, message mentions
  `channels.telegram.chat_id`.
- Both present, short text → one `sendMessage` call, prints `ok`.
- Both present, 5000-char text → two `sendMessage` calls, prints
  `ok (2 parts)`.
- 429 → sleeps `Retry-After`, retries once, prints `ok` if second
  call succeeds.
- 5xx → prints body, exits non-zero.

**Exit criteria:** Manual smoke test:
- Coordinator runs `ib tgsend "hello"` → message appears on Telegram.
- Coordinator runs `ib tgsend` with a 5000-char paste → arrives as
  two messages on Telegram.

---

## Cross-cutting checklist (every phase)

Per `CLAUDE.md`, evaluate each phase against the four perspectives:

1. **General agent functionality.** Phases 1, 5 affect the system
   coordinator's launch and inbound message path. No other agents
   affected.
2. **Hooks.** None of these phases touch hooks. The dispatcher runs
   inside `ib watch`, not as a hook. Confirm in each phase's PR
   description.
3. **Watchdog.** None of these phases touch watchdog state detection
   or nudge logic. Confirm in each phase's PR description.
4. **`ib watch` / dashboard.** Phase 5 touches `launchDashboard()`
   for dispatcher start/stop. Phase 5 may add `--no-telegram` flag
   parsing. Layout/focus/render unchanged.

After every phase: `bun test` + `bunx tsc --noEmit` must be green.

---

## Phase dependency graph

```
Phase 0 (decisions)
   │
   ▼
Phase 1 (remove plugin wiring) ──┐
                                  │
Phase 2 (config + access.json) ──┤
                                  │
Phase 3 (multiline sendMessage) ─┤
                                  │
Phase 4 (transport client) ──────┤
                                  ▼
                        Phase 5 (dispatcher + wiring)
                                  │
                                  ▼
                        Phase 6 (ib tgsend)
```

Phases 1–4 are independent and can land in any order or in parallel
once Phase 0 is done. Phase 5 requires Phases 2, 3, 4. Phase 6 requires
Phase 4 (and benefits from Phase 2 for the config keys).

---

## Out of scope (explicit non-goals from the plan)

These do not appear in any phase. Listed here so reviewers don't ask
"where's X?":

- Multi-channel support (Slack, Discord) — design generalizes, only
  Telegram ships.
- Pairing UX — `ib tgallow` is the v1 admin path.
- `ib ask` / qid correlation — coordinator uses plain prose Q&A.
- Webhook / MTProto — long-polling only.
- Permission relay — deferred.
- Group-chat support, mentions, multi-chat routing — 1:1 DMs only.
- Outbound file/image attachments.
- Reactions (`setMessageReaction`), edits (`editMessageText`),
  typing indicator (`sendChatAction`).
- MarkdownV2 / HTML formatting — plain text both ways.
- Multi-machine / multi-user.

See [`telegram-ib-routing.md`](./telegram-ib-routing.md) §"Non-goals"
and [`telegram-implementation-notes.md`](./telegram-implementation-notes.md)
§"What we deliberately skip from the plugin" for full rationale.
