#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
# Suppress the "How is Claude doing?" feedback survey for spawned agents
export CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1

AGENT_LOG='<AGENTSDIR>/claude-snapshot/agent.log'
STDERR_LOG='<AGENTSDIR>/claude-snapshot/claude.stderr.log'
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start.sh] $1" >> "$AGENT_LOG"; }
# Start the per-agent proxy outside Seatbelt. The launcher detaches/unrefs the
# proxy before returning; the agent CLI alone is wrapped below. Fail closed if the
# actual bind loses the small race after the parent-process port preflight.
PROXY_PORT=<PORT>
PROXY_PID_FILE='<AGENTSDIR>/claude-snapshot/sandbox-proxy.pid'
PROXY_READY_FILE='<AGENTSDIR>/claude-snapshot/sandbox-proxy.ready'
rm -f "$PROXY_PID_FILE" "$PROXY_READY_FILE"
if ! ib sandbox-proxy-launch --port "$PROXY_PORT" --domains '<AGENTSDIR>/claude-snapshot/sandbox-domains.txt' --log '<AGENTSDIR>/claude-snapshot/sandbox-proxy.log' --pid-file "$PROXY_PID_FILE" --ready-file "$PROXY_READY_FILE"; then
    log "sandbox refused: proxy could not bind localhost:$PROXY_PORT"
    exit 1
fi
cleanup_sandbox_proxy() {
    local proxy_pid
    proxy_pid=$(cat "$PROXY_PID_FILE" 2>/dev/null || true)
    if [[ "$proxy_pid" =~ ^[1-9][0-9]*$ ]]; then kill "$proxy_pid" 2>/dev/null || true; fi
    rm -f "$PROXY_PID_FILE" "$PROXY_READY_FILE"
}
trap cleanup_sandbox_proxy EXIT
PROXY_PID=$(cat "$PROXY_PID_FILE")
ib write-proxy-pid 'claude-snapshot' "$PROXY_PID" "$PROXY_PORT" || log "write-proxy-pid failed (exit=$?)"
export http_proxy="http://localhost:$PROXY_PORT"
export https_proxy="$http_proxy"
export HTTP_PROXY="$http_proxy"
export HTTPS_PROXY="$http_proxy"
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"

# This launch owns its collector outside Seatbelt, independent of watch/watchdog.
# Each invocation allocates new artifacts, including when the script is reused.
IB_SANDBOX_LOG_DIR=""
IB_SANDBOX_LOG_STOP_OPEN=0
if (umask 077; mkdir -p '<SANDBOX-LOG-ROOT>/<AGENT-HASH>') && chmod 700 '<SANDBOX-LOG-ROOT>' '<SANDBOX-LOG-ROOT>/<AGENT-HASH>'; then
    IB_SANDBOX_LOG_DIR=$(mktemp -d '<SANDBOX-LOG-ROOT>/<AGENT-HASH>/sandbox-log.XXXXXXXX') || IB_SANDBOX_LOG_DIR=""
fi
# Reserve fd 9 for this launch's stop inode. The CLI gate closes it before exec.
if [[ -n "$IB_SANDBOX_LOG_DIR" ]] && exec 9>"$IB_SANDBOX_LOG_DIR/stop"; then
    IB_SANDBOX_LOG_STOP_OPEN=1
else
    if [[ -n "$IB_SANDBOX_LOG_DIR" ]]; then rmdir "$IB_SANDBOX_LOG_DIR" 2>/dev/null; fi
    IB_SANDBOX_LOG_DIR=""
fi
export IB_SANDBOX_LOG_DIR
export IB_SANDBOX_LOG_AGENT_LOG="$AGENT_LOG"
cleanup_sandbox_log() {
    if [[ "$IB_SANDBOX_LOG_STOP_OPEN" == 1 ]]; then
        printf 'stop\n' >&9
        exec 9>&-
        IB_SANDBOX_LOG_STOP_OPEN=0
    fi
}
trap 'cleanup_sandbox_log; cleanup_sandbox_proxy' EXIT
if [[ -n "$IB_SANDBOX_LOG_DIR" ]]; then
    (
        trap '' HUP
        ib sandbox-log-watch --dir "$IB_SANDBOX_LOG_DIR" --owner "$$" --agent-log "$AGENT_LOG" </dev/null 9>&-
        collector_exit=$?
        if [[ "$collector_exit" -ne 0 ]]; then
            printf '[%s] [SandboxCollector] ERROR: launch=%s collector exited %s; kernel enforcement remains required\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${IB_SANDBOX_LOG_DIR##*/}" "$collector_exit" >> "$AGENT_LOG"
            if [[ -d "$IB_SANDBOX_LOG_DIR" ]]; then : > "$IB_SANDBOX_LOG_DIR/failed"; fi
        fi
        # Only the supervisor removes this directory. Until now it remains
        # reserved by mktemp; a late EXIT write uses fd 9, never this path.
        if [[ "$IB_SANDBOX_LOG_DIR" == '<SANDBOX-LOG-ROOT>/<AGENT-HASH>'"/sandbox-log."* && "${IB_SANDBOX_LOG_DIR##*/}" =~ ^sandbox-log\.[a-zA-Z0-9]+$ ]]; then
            rm -rf -- "$IB_SANDBOX_LOG_DIR"
        fi
    ) </dev/null >/dev/null 2>>"$AGENT_LOG" &
    collector_wait=0
    while [[ ! -f "$IB_SANDBOX_LOG_DIR/ready" && ! -f "$IB_SANDBOX_LOG_DIR/failed" && -d "$IB_SANDBOX_LOG_DIR" && "$collector_wait" -lt 100 ]]; do
        sleep 0.05
        collector_wait=$((collector_wait + 1))
    done
fi
if [[ -z "$IB_SANDBOX_LOG_DIR" || ! -f "$IB_SANDBOX_LOG_DIR/ready" ]]; then
    printf '[%s] [SandboxCollector] ERROR: collector unavailable before CLI launch; kernel enforcement remains required\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$AGENT_LOG"
    cleanup_sandbox_log
    IB_SANDBOX_LOG_DIR=""
fi


log "Starting claude --session-id <SESSION-UUID> --model sonnet --effort xhigh --dangerously-skip-permissions"
log "PWD=$(pwd) which_claude=$(which claude 2>&1)"

# Ignore SIGHUP for the lifetime of this script. When spawn is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash. SIG_IGN is inherited by the claude child,
# so this protects both halves. setsid (below) is the belt to this suspenders —
# it gives claude its own session so the pty SIGHUP can't reach it at all, but
# the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (spawn insulated from launcher pane teardown)"

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
    setsid /bin/sh -c 'if [ -n "$IB_SANDBOX_LOG_DIR" ] && [ -d "$IB_SANDBOX_LOG_DIR" ]; then printf '\''%s\n'\'' "$$" > "$IB_SANDBOX_LOG_DIR/root-request.tmp" && mv -f "$IB_SANDBOX_LOG_DIR/root-request.tmp" "$IB_SANDBOX_LOG_DIR/root-request"; n=0; while [ ! -f "$IB_SANDBOX_LOG_DIR/root-ready" ] && [ -d "$IB_SANDBOX_LOG_DIR" ] && [ "$n" -lt 100 ]; do sleep 0.02; n=$((n + 1)); done; if [ ! -f "$IB_SANDBOX_LOG_DIR/root-ready" ]; then printf '\''[%s] [SandboxCollector] ERROR: CLI identity registration unavailable; kernel enforcement remains required\n'\'' "$(date -u '\''+%Y-%m-%dT%H:%M:%SZ'\'')" >> "$IB_SANDBOX_LOG_AGENT_LOG"; fi; fi; exec 9>&-; unset IB_SANDBOX_LOG_DIR IB_SANDBOX_LOG_AGENT_LOG IB_SANDBOX_LOG_STOP_OPEN; exec "$@"' sandbox-log-gate '/usr/bin/sandbox-exec' -f '<PROFILE>' -D 'SCRATCHPAD=<VALUE>' -D 'PARENTCLAUDE=<VALUE>' -D 'REPOAGENTS=<VALUE>' -D 'AGENTDIR=<VALUE>' -D 'WORKTREE=<VALUE>' -D 'PROJECTDIR=<VALUE>' -D 'GITDIR=<VALUE>' claude --session-id "<SESSION-UUID>" --model sonnet --effort xhigh --dangerously-skip-permissions "$(cat '<AGENTSDIR>/claude-snapshot/prompt.txt')" 2> "$STDERR_LOG" &
else
    /bin/sh -c 'if [ -n "$IB_SANDBOX_LOG_DIR" ] && [ -d "$IB_SANDBOX_LOG_DIR" ]; then printf '\''%s\n'\'' "$$" > "$IB_SANDBOX_LOG_DIR/root-request.tmp" && mv -f "$IB_SANDBOX_LOG_DIR/root-request.tmp" "$IB_SANDBOX_LOG_DIR/root-request"; n=0; while [ ! -f "$IB_SANDBOX_LOG_DIR/root-ready" ] && [ -d "$IB_SANDBOX_LOG_DIR" ] && [ "$n" -lt 100 ]; do sleep 0.02; n=$((n + 1)); done; if [ ! -f "$IB_SANDBOX_LOG_DIR/root-ready" ]; then printf '\''[%s] [SandboxCollector] ERROR: CLI identity registration unavailable; kernel enforcement remains required\n'\'' "$(date -u '\''+%Y-%m-%dT%H:%M:%SZ'\'')" >> "$IB_SANDBOX_LOG_AGENT_LOG"; fi; fi; exec 9>&-; unset IB_SANDBOX_LOG_DIR IB_SANDBOX_LOG_AGENT_LOG IB_SANDBOX_LOG_STOP_OPEN; exec "$@"' sandbox-log-gate '/usr/bin/sandbox-exec' -f '<PROFILE>' -D 'SCRATCHPAD=<VALUE>' -D 'PARENTCLAUDE=<VALUE>' -D 'REPOAGENTS=<VALUE>' -D 'AGENTDIR=<VALUE>' -D 'WORKTREE=<VALUE>' -D 'PROJECTDIR=<VALUE>' -D 'GITDIR=<VALUE>' claude --session-id "<SESSION-UUID>" --model sonnet --effort xhigh --dangerously-skip-permissions "$(cat '<AGENTSDIR>/claude-snapshot/prompt.txt')" 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "Claude PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to Claude PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Claude PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock so the write does not lose a concurrent
# mutation (e.g. the watchdog setting watchdog_pid). The naive inline
# bun -e read-modify-write it replaces had a real lost-write race window
# whose symptom is benign on claude today but matters symmetrically with
# the codex side (HIGH 2 from the Phase 4 review).
META_JSON='<AGENTSDIR>/claude-snapshot/meta.json'
if [[ -f "$META_JSON" ]]; then
    ib write-pid 'claude-snapshot' "$CLAUDE_PID" || log "write-pid failed (exit=$?); meta.json claude_pid not set"
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
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib retire / pause)" ;;
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
'<AGENTSDIR>/claude-snapshot/exit-check.sh'
