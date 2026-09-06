import { dirname, join } from "node:path";
import { shellQuote } from "./validation";
import { sandboxLogParent } from "./sandbox-log-paths";

/** Append AFTER the proxy preamble, which installs cleanup_sandbox_proxy. */
export function sandboxDenialScriptPreamble(agentDir: string, home?: string): string {
  const parent = sandboxLogParent(agentDir, home);
  return `
# This launch owns its collector outside Seatbelt, independent of watch/watchdog.
# Each invocation allocates new artifacts, including when the script is reused.
trap '' HUP
IB_SANDBOX_LOG_DIR=""
IB_SANDBOX_LOG_STOP_OPEN=0
if (umask 077; mkdir -p ${shellQuote(parent)}) && chmod 700 ${shellQuote(dirname(parent))} ${shellQuote(parent)}; then
    IB_SANDBOX_LOG_DIR=$(mktemp -d ${shellQuote(join(parent, "sandbox-log.XXXXXXXX"))}) || IB_SANDBOX_LOG_DIR=""
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
        printf 'stop\\n' >&9
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
            printf '[%s] [SandboxCollector] ERROR: launch=%s collector exited %s; kernel enforcement remains required\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "\${IB_SANDBOX_LOG_DIR##*/}" "$collector_exit" >> "$AGENT_LOG"
            if [[ -d "$IB_SANDBOX_LOG_DIR" ]]; then : > "$IB_SANDBOX_LOG_DIR/failed"; fi
        fi
        # Only the supervisor removes this directory. Until now it remains
        # reserved by mktemp; a late EXIT write uses fd 9, never this path.
        if [[ "$IB_SANDBOX_LOG_DIR" == ${shellQuote(parent)}"/sandbox-log."* && "\${IB_SANDBOX_LOG_DIR##*/}" =~ ^sandbox-log\\.[a-zA-Z0-9]+$ ]]; then
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
    printf '[%s] [SandboxCollector] ERROR: collector unavailable before CLI launch; kernel enforcement remains required\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$AGENT_LOG"
    cleanup_sandbox_log
    IB_SANDBOX_LOG_DIR=""
fi
`;
}

/** Register a gated process before exec preserves $! across sandbox-exec and CLI.
 * The collector is diagnostic: a failed/timed-out gate still execs the exact
 * required Seatbelt wrapper, never the CLI alone.
 */
export function sandboxDenialExecPrefix(sandboxPrefix: string): string {
  const gate = `if [ -n "$IB_SANDBOX_LOG_DIR" ] && [ -d "$IB_SANDBOX_LOG_DIR" ]; then
    printf '%s\\n' "$$" > "$IB_SANDBOX_LOG_DIR/root-request.tmp" && mv -f "$IB_SANDBOX_LOG_DIR/root-request.tmp" "$IB_SANDBOX_LOG_DIR/root-request";
    n=0;
    while [ ! -f "$IB_SANDBOX_LOG_DIR/root-ready" ] && [ -d "$IB_SANDBOX_LOG_DIR" ] && [ "$n" -lt 100 ]; do
        sleep 0.02;
        n=$((n + 1));
    done;
    if [ ! -f "$IB_SANDBOX_LOG_DIR/root-ready" ]; then
        printf '[%s] [SandboxCollector] ERROR: CLI identity registration unavailable; kernel enforcement remains required\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$IB_SANDBOX_LOG_AGENT_LOG";
    fi;
fi;
exec 9>&-;
unset IB_SANDBOX_LOG_DIR IB_SANDBOX_LOG_AGENT_LOG IB_SANDBOX_LOG_STOP_OPEN;
exec "$@"`.replace(/\n\s*/g, " ");
  return `/bin/sh -c ${shellQuote(gate)} sandbox-log-gate ${sandboxPrefix}`;
}
