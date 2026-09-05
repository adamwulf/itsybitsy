# Codex "cooked-tty" wedge — symptom, detection, and recovery

**Status:** Symptom, mechanism, detection, no-restart recovery, ROOT CAUSE, and
the fix are all CONFIRMED (live, 2026-09-05) — see "Root cause (confirmed)" and
"The fix" below.

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

### Secondary, separate failure: pane stuck in tmux copy-mode

If `#{pane_in_mode}` is `1` (view-mode / copy-mode), `tmux send-keys` to that pane
fails with `no current client` and delivers **nothing** — a delivery failure
distinct from the cooked-tty one. Exit copy-mode first (see recovery step 3).

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
