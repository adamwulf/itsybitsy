#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG='<AGENTSDIR>/.ittybitty/agents/agent-claude-snapshot/agent.log'
STDERR_LOG='<AGENTSDIR>/.ittybitty/agents/agent-claude-snapshot/claude.stderr.log'
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resume.sh] $1" >> "$AGENT_LOG"; }

log "Starting claude --resume <SESSION-UUID> --model sonnet"
log "PWD=$(pwd) which_claude=$(which claude 2>&1)"

# Ignore SIGHUP for the lifetime of this script. When resume is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash-resume loop. SIG_IGN is inherited by the
# claude child, so this protects both halves. setsid (below) is the belt to this
# suspenders — it gives claude its own session so the pty SIGHUP can't reach it
# at all, but the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (resume insulated from launcher pane teardown)"

# Start Claude in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
# Launch under setsid when present so claude leads its own session, fully
# detached from the launcher's controlling terminal. setsid execs in place
# (no fork) when it is not already a process-group leader — which holds here:
# this script runs non-interactively with job control off (no `set -m`), so the
# backgrounded setsid stays in the script's process group rather than leading
# its own. So $! still refers to claude and wait/kill behave identically to the
# bare launch. Fall back to a plain background launch on hosts lacking setsid
# (e.g. macOS, where setsid is absent — the inherited SIG_IGN above covers it).
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid claude --resume "<SESSION-UUID>" --model sonnet 2> "$STDERR_LOG" &
else
    claude --resume "<SESSION-UUID>" --model sonnet 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "Claude PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to Claude PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Claude PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock (HIGH 2 from the Phase 4 review).
META_JSON='<AGENTSDIR>/.ittybitty/agents/agent-claude-snapshot/meta.json'
if [[ -f "$META_JSON" ]]; then
    ib write-pid 'agent-claude-snapshot' "$CLAUDE_PID" || log "write-pid failed (exit=$?); meta.json claude_pid not set"
fi

# Wait for Claude to complete
wait $CLAUDE_PID
EXIT_CODE=$?
SIGNAL=$(kill -l $EXIT_CODE 2>/dev/null || echo "none")
log "Claude exited: code=$EXIT_CODE signal=$SIGNAL"

# Annotate common exit codes so the cause is obvious in agent.log.
case $EXIT_CODE in
    0)   log "exit=0 → clean exit" ;;
    1)   log "exit=1 → generic claude error (check stderr tail below)" ;;
    2)   log "exit=2 → claude usage / argument error" ;;
    127) log "exit=127 → command not found ('claude' missing from PATH?)" ;;
    129) log "exit=129 → SIGHUP (tmux pane closed or controlling terminal lost)" ;;
    130) log "exit=130 → SIGINT (Ctrl-C)" ;;
    137) log "exit=137 → SIGKILL (likely OOM kill or 'kill -9'; check Console.app for 'low memory')" ;;
    139) log "exit=139 → SIGSEGV (claude segfault)" ;;
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib kill / pause)" ;;
    *)   log "exit=$EXIT_CODE → unrecognized; SIGNAL=$SIGNAL" ;;
esac

# If Claude exited non-cleanly and wrote anything to stderr, dump the tail into
# agent.log so the post-mortem doesn't depend on the (now-dying) tmux pane.
if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]; then
    log "── claude stderr (last 50 lines) ──"
    tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"
    log "── end claude stderr ──"
fi

# Run exit check
'<AGENTSDIR>/.ittybitty/agents/agent-claude-snapshot/exit-check.sh'
