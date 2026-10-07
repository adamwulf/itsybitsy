import { dirname, join } from "node:path";
import { shellQuote } from "./validation";
import { sandboxLogParent } from "./sandbox-log-paths";

/**
 * The kernel denial collector is ON, through ONE shared per-user collector: each
 * sandboxed spawn/resume runs `ib sandbox-collector attach`, which registers the
 * launch and its profile's attribution tag with `ib sandbox-collector serve` and
 * its single `log stream --level default` (docs/SANDBOX-SHARED-COLLECTOR.md). It
 * copies `[Sandbox]` lines into agent.log for the DENIALS pane. It was off for a
 * while because the earlier design ran one `log stream --level debug` per
 * launch: with 10 agents that cost about 3-4 cores (each `log` ~17-26% plus
 * diagnosticd ~150%). Seatbelt enforcement and the proxy do not depend on it.
 *
 * To turn it off, set this to false: both helpers below then add nothing (no
 * collector, no readiness handshake, the plain sandbox-exec prefix) to new spawns
 * and resumes. Running agents keep their scripts until resumed; `ib
 * sandbox-collector stop` ends collection for them now.
 */
export const SANDBOX_DENIAL_COLLECTOR_ENABLED = true;

/** Append AFTER the proxy preamble, which installs cleanup_sandbox_proxy. */
export function sandboxDenialScriptPreamble(agentDir: string, home?: string, enabled = SANDBOX_DENIAL_COLLECTOR_ENABLED): string {
  if (!enabled) return "";
  const parent = sandboxLogParent(agentDir, home);
  return `
# This launch attaches to the shared collector outside Seatbelt, independent of
# watch/watchdog. Each invocation allocates new artifacts, even on script reuse.
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
        ib sandbox-collector attach --dir "$IB_SANDBOX_LOG_DIR" --owner "$$" --agent-log "$AGENT_LOG" </dev/null 9>&-
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
        # The namespace holds the agent's profile while the agent exists, so this
        # succeeds only after a teardown removed it.
        rmdir ${shellQuote(parent)} 2>/dev/null
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
fi
`;
}

/** The gate in front of the CLI closes fd 9 (this launch's `stop` file) so the
 * sandboxed CLI cannot end its own collection, then execs the exact required
 * Seatbelt wrapper, never the CLI alone. Attribution needs nothing from it: the
 * profile's tag marks every denial of the CLI and all its descendants.
 */
export function sandboxDenialExecPrefix(sandboxPrefix: string, enabled = SANDBOX_DENIAL_COLLECTOR_ENABLED): string {
  if (!enabled) return sandboxPrefix;
  return `/bin/sh -c ${shellQuote('exec 9>&-; exec "$@"')} sandbox-log-gate ${sandboxPrefix}`;
}
