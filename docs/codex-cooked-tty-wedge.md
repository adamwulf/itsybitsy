# Codex "cooked-tty" wedge — symptom, detection, and recovery

**Status:** Symptom, mechanism, detection, no-restart recovery, ROOT CAUSE, and
the fix are all CONFIRMED (live, 2026-09-05) — see "Root cause (confirmed)" and
"The fix" below. A SECOND, unrelated wedge with a near-identical symptom (pane
parked in tmux view-mode by a `run-shell -b` helper notice) was root-caused and
fixed the same day — see "Second, separate failure" under "Detect it". Check
`#{pane_in_mode}` BEFORE `stty`: a RAW tty with an empty composer is that one.

This documents a failure where a codex agent (our `sol` / `codex` types, and the
`agy`/`fugu`/`gemini` codex-family types) silently stops accepting delivered
messages, so `ib send`, watchdog nudges, and manager feedback never reach it.

---

## Symptom (what you see)

- You `ib send <agent> "..."` (or the watchdog/manager does) and the agent never
  responds. In `ib look <agent>` the message text IS visible sitting in codex's
  composer after the `›` prompt, but it was never submitted.
- Pressing Enter (or the outbox's Enter) only adds a **newline** inside the
  composer instead of submitting.
- Raw escape sequences leak in as literal text — e.g. a focus-out `^[[O`, or at
  the very top of the pane the terminal's capability replies `^[[1;1R^[[?1;2;4c`.
- The agent looks `waiting`/idle and healthy; nothing in the logs says "stuck".

## Mechanism (confirmed)

The agent's tmux **pane pty is in COOKED (canonical) mode** instead of the RAW
mode a TUI needs:

- Healthy codex: `stty` shows `-icanon -isig -iexten -echo` and `-icrnl` (crossterm raw).
- Wedged codex: `stty` shows `icanon isig iexten echo` and **`icrnl`**.

The killer flag is **`icrnl`**: it rewrites an incoming CR (`\r`, which tmux's
`Enter` key sends) into LF (`\n`) before codex reads it. Codex treats CR as
"submit" but LF as "insert newline" — so in cooked mode every Enter becomes a
newline and the message is never submitted. `echo` (also on in cooked mode) is
why escape sequences appear as literal text.

It is a **startup race**: codex sets raw ~0.3s after spawn, then the pty gets
re-cooked ~0.45s later, and codex sets raw only once and never re-asserts it — so
whoever writes the termios LAST wins. It is intermittent: agents spawned through
`ib new-agent` (the real spawn path) wedge at a very high rate; a bare
`codex ...` launched by hand almost never wedges.

## Detect it

```sh
# 1) find the agent's tmux session
tmux list-sessions -F '#{session_name}' | grep <agent-name-or-id>

# 2) get the pane's pty (and whether it is stuck in copy-mode)
tmux display-message -p -t <session> 'tty=#{pane_tty} inmode=#{pane_in_mode}'

# 3) read the line discipline — icanon = WEDGED, -icanon = healthy
stty -a -f <pane_tty>
```

`icanon` present (with `icrnl`) = wedged. `-icanon` = healthy. A `^[[1;1R^[[?1;2;4c`
line at the very top of `tmux capture-pane` output is a reliable "came up cooked"
fingerprint.

### Second, separate failure: pane stuck in tmux view-mode (root-caused + fixed 2026-09-05)

This one is NOT codex-specific — it hits any agent (claude, codex, agy) and the
`ib-coordinator` session. It looks like a healthy, idle agent that never
receives messages: the tty is RAW (`-icanon -icrnl`, so the cooked-tty check
above passes), the composer is EMPTY (nothing ever lands in it), and `ib send`
either fails or appears to succeed while the agent never reacts.

**Fingerprint:** `#{pane_in_mode}` is `1` and `#{pane_mode}` is `view-mode`.
Attaching to the session shows a tmux view-mode screen (a `[0/N]` counter in the
top-right corner) holding one line such as:

```
'cd '/Users/…/itsybitsy' && exec 'ib' 'watchdog' 'path-test' >> '…/agents/path-test/watchdog.log' 2>&1' terminated by signal 15
```

— the death notice of ANOTHER agent's watchdog.

**Mechanism (proven live on `package-refactor` + a throwaway-session repro):**

1. `spawnHelperViaTmuxServer` (src/ib-commands.ts) launches every agent's
   watchdog and `generate-summary` worker through `tmux run-shell -b` so they
   are children of the unsandboxed tmux server (SPEC-SANDBOX §4C.2, live on main
   since the sandbox-safety merge 48c52cf, 2026-09-04).
2. A background `run-shell -b` job has no waiting client and no `-t` pane. When
   it prints anything, exits non-zero, or dies by a signal, tmux writes the text
   or a `'<cmd>' returned N` / `'<cmd>' terminated by signal 15` notice into the
   active pane of the session with the newest `activity_time` — i.e. the session
   most recently CREATED or ATTACHED, typically whichever agent the user last
   opened in Ghostty — and switches that pane into **view-mode**.
3. The orphan-kill teardown in `detectAgentStates` (src/agents.ts, `reap("watchdog", …)`)
   SIGTERMs the watchdog of every agent that stops. So stopping agent A wedged
   the pane of some unrelated agent B, on every teardown.
4. In view-mode, `send-keys -l <text>` is dispatched through the **copy-mode key
   table** (mode-keys=emacs): Space → page-down, `n` → search-again, `r` →
   refresh-from-pane, `f`/`t`/`F`/`T`/`g` → `command-prompt`, which fails with
   **`no current client`** (exit 1). That prompt error — not `send-keys` itself —
   is the "no current client" failure previously attributed to send-keys. `Enter`
   is unbound in copy-mode and is dropped. `q` / `Escape` → cancel. A message with
   none of `f t F T g` returns exit 0 and is silently eaten (the outbox then
   removes it as delivered = message loss).
5. `drainOutbox` stops on the first failed chunk and keeps the message queued;
   the watchdog retries every tick, so `tmux show-messages` fills with repeated
   `send-keys -X page-down` / `search-again` / `no current client` lines.

**Detect:**

```sh
tmux list-panes -a -F '#{session_name} in_mode=#{pane_in_mode} mode=#{pane_mode}' | grep -v 'in_mode=0'
tmux show-messages | grep -E 'send-keys -X|no current client'
```

**Recover (no restart):** `tmux send-keys -t '=<session>:' -X cancel` (only when
`pane_in_mode` is 1; otherwise it errors "not in a mode"). A message still in the
outbox is delivered on the next watchdog tick by itself.

**The fix (src/ib-commands.ts):**

- `buildTmuxHelperScript` wraps every `run-shell -b` helper so tmux never has
  anything to report: the wrapper's own stdio goes to `/dev/null`, the helper runs
  as a backgrounded CHILD with its stdio redirected to its log, the wrapper `wait`s
  for it, logs a non-zero status as `[helper] exited rc=N` into that log, and
  always `exit 0`s. A signal aimed at the wrapper itself (tmux `kill-server`) is
  trapped, forwarded as SIGTERM to the helper, and still reported as 0. The
  orphan-kill SIGTERM still targets the helper's own PID (the watchdog records
  `process.pid`), so teardown semantics are unchanged.
- `cancelTmuxPaneModeIfActive`, called by `deliverMessage` after the
  `has-session` check, probes `#{pane_in_mode}` and sends `send-keys -X cancel`
  only when it is `1` (logged to the recipient's agent.log). This also covers the
  other way a detached pane ends up in copy-mode: a user who mouse-scrolled the
  pane in an attached client and then closed the window.

Verified with a live probe on the ib tmux server: old shape → the most recently
created session's pane enters view-mode with the signal notice; new wrapper →
helper SIGTERM'd (orphan-kill) and wrapper SIGTERM'd (job kill) both leave every
pane out of mode, and the helper log carries `[helper] exited rc=143`.

## Recover it (NO restart needed)

Restoring raw mode is enough — the process does not need to be killed or resumed.

```sh
SESSION=<agent tmux session>          # e.g. ittybitty-<repo>-<agent>
TTY=$(tmux display-message -p -t "$SESSION" '#{pane_tty}')

# 1) if the pane is in copy-mode (pane_in_mode=1), exit it first.
#    -X cancel is a COPY-MODE command, NOT the Escape key: it does not reach
#    codex and does NOT clear the composer. It errors "not in a mode" (harmless)
#    if the pane was not in copy-mode.
tmux send-keys -t "$SESSION" -X cancel

# 2) put the pty back into raw mode. NOTE: on macOS, -f <tty> must come FIRST.
stty -f "$TTY" -icanon -echo -icrnl

# 3) submit whatever message is already sitting in the composer.
tmux send-keys -t "$SESSION" Enter

# 4) verify: the composer clears to "Ask Codex to do anything" and codex starts
#    processing the message.
tmux capture-pane -p -t "$SESSION" -S -6
```

Proven live on multiple agents (e.g. unstuck `empty-lists` on 2026-09-05: a
reviewer's message that had been stuck unsubmitted in the composer was delivered
and processed immediately after this sequence).

`codex resume` (restart in the same worktree) also recovers, but it is heavier
and can lose whatever was sitting in the composer.

## Root cause (confirmed)

**`ib write-pid` — the bun subprocess `start.sh` runs on the pane tty right after
backgrounding codex — clobbers codex's raw-mode setup.**

`start.sh` launches codex as a background job (`codex ... <&0 &`, so codex's stdin
is the pane tty), then runs `ib write-pid <id> <pid>` in the FOREGROUND (inheriting
the pane tty as its stdin), then `wait`s. The bun runtime saves the tty's termios
when it starts and restores it on exit for a tty stdin. `write-pid` starts while
the tty is still COOKED (before codex's raw-set) and restores COOKED on exit —
which lands AFTER codex set raw (~0.3s), overwriting it. codex sets raw once and
never re-asserts, so the tty stays cooked. This is in `ib`'s wrapper + the bun
runtime, so it is version-independent (matches "~a week+"). The single
discriminator is codex-background's neighbor process's STDIN: a tty stdin cooks;
`</dev/null` does not.

Evidence (each arm many trials, `stty` sampled across startup):

| Experiment | Setup | Result |
|---|---|---|
| A/B via real `ib new-agent` | BEFORE helpers kept / AFTER helpers disabled | 15/15 cooked / ~15/15 cooked → helpers NOT the cooker |
| direct codex + hooks (helpers off) | bare / +trivial / +real `ib` hook / +all 3 `ib` hooks | 6/6 RAW each → hooks NOT the cooker |
| wrapper `BG` | `codex ... <&0 & wait` | 8/8 RAW |
| wrapper `BGWRITE` | `codex ... <&0 &` ; `ib list` (stdin=tty) ; `wait` | 8/8 COOKED |
| wrapper `BGWRITENULL` | `codex ... <&0 &` ; `ib list </dev/null` ; `wait` | 10/10 RAW |

## The fix

Give `ib write-pid` its stdin off the pane tty in BOTH `start.sh` and `resume.sh`
(both rendered in `src/codex-spawn.ts` — `buildCodexStartContent` and
`buildCodexResumeContent`):

```sh
ib write-pid <id> "$CLAUDE_PID" </dev/null >>"$AGENT_LOG" 2>&1 || log "write-pid failed ..."
```

The essential part is `</dev/null` on stdin (proven: `BGWRITENULL` = 10/10 raw vs
`BGWRITE` = 8/8 cooked). Redirecting stdout/stderr to the log is good hygiene but
not what stops the cook. Also audit any OTHER foreground bun/`ib` call that runs
between codex being backgrounded and `wait` (today there is only `write-pid`).

**Verified end-to-end (2026-09-05):** a real before/after A/B through
`ib new-agent` (15 spawns each, tty sampled across startup) — installed/buggy `ib`
**15/15 wedged**, locally-built `ib` with this fix **0/15 wedged**. Implemented on
branch `agent/codex-debug`: revert `9bb7816` (drops the ineffective computer-use
flags), fix `a30ea1e` (both templates + regression tests; `bun test` 5385 pass,
`tsc` clean). Deploy by merging to main, rebuilding + reinstalling the `ib` binary,
and restarting `ib watch`. Already-wedged agents still need the manual recovery
above (the fix only prevents the wedge on newly-spawned agents).

## Ruled out (kept for the record)

- **NOT the computer-use helpers.** Disabling them (`-c
  plugins.unified-computer-use@openai-bundled.enabled=false -c
  mcp_servers.node_repl.enabled=false`; plugin key must be UNQUOTED on the CLI —
  codex splits the key on `.` and does not strip TOML quotes) removes the helper
  processes but the tty is still cooked (A/B above).
- **NOT the codex hooks** (SessionStart/PreToolUse/Stop) — adding them to a direct
  codex launch leaves it raw.
- **NOT `setsid`** (not installed here) and **NOT the codex 0.153.2 upgrade**
  (version-independent).

## Related

- Session memory: `project_codex_completed_cooked_mode_wedge.md` (fuller live log).
- Family: codex can also wedge "unsent reports under a Create-a-plan nudge"
  (`project_codex_hang_create_plan_nudge.md`) — restart-to-recover cases.
