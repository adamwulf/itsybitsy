/**
 * Codex spawn-path helpers — pure functions that the `newAgent()` codex
 * branch (SPEC-CODEX-MODEL.md §6 Phase 4) composes into the start.sh script
 * and the worktree on disk. Splitting them out keeps the codex-specific
 * spawn logic unit-testable without booting a real codex / tmux session.
 *
 * Three responsibilities:
 *   1. Render the codex launch line that goes into start.sh — shell-quoted
 *      argv per SPEC §3.3, with the inline `-c hooks.*=[...]` flags from
 *      `buildCodexLaunchArgs()` already in place.
 *   2. Append `.codex/` to the worktree's `.gitignore` so any incidental
 *      files codex itself drops don't end up tracked.
 *   3. Build the per-agent role instructions codex receives as
 *      `-c developer_instructions="…"` — the codex analog of the Claude
 *      `session-start.ts` injection. We delegate to `generateInstructions()`
 *      from `src/hooks/session-start.ts` and strip the Claude-specific
 *      `<ittybitty>...</ittybitty>` wrapper (codex doesn't read that tag).
 *      itsybitsy never writes an `AGENTS.md`: codex reads the repo's own
 *      `AGENTS.md` natively, next to these instructions.
 *
 * No subprocesses are spawned from this module — the precheck that runs
 * `ib hooks codex-* --dry-run` lives in `ib-commands.ts` so it can share
 * `newAgentSpawnCtx` with the rest of the spawn flow.
 */

import { shellQuote } from "./validation";
import { buildCodexLaunchArgs, FUGU_CODEX_CONFIG_OVERRIDES, isCodexSafeBinaryPath } from "./codex-config";
import type { SessionContext } from "./hooks/session-start";
import { stripIttybittyWrapper, buildSkillsSection, buildAgentRoleBody } from "./agent-instructions-shared";
import { appendGitignoreEntries, type GitignoreEntryOutcome } from "./worktree-gitignore";

// Re-exported so existing importers (codex-spawn.test.ts, ib-commands.ts) keep
// resolving these from "./codex-spawn". The implementations now live in the
// shared, CLI-agnostic module so agy-config.ts can reuse them without copy-paste.
export { stripIttybittyWrapper, buildSkillsSection };

/**
 * Resolve the absolute path to the `ib` binary suitable for codex hook
 * dispatch. Codex runs hooks in an unpredictable environment — we MUST give
 * it an absolute path; bare `ib` may not resolve to the current install.
 *
 * Prefers `Bun.which("ib")` (PATH lookup) so dev-mode `ib` shell wrappers
 * resolve correctly; falls back to `process.execPath` only when `which`
 * comes up empty. Returns null when nothing resolves — caller fails the
 * spawn rather than guess.
 */
export function resolveIbBinaryPath(
  whichFn: (cmd: string) => string | null = Bun.which.bind(Bun),
): string | null {
  const fromWhich = whichFn("ib");
  if (fromWhich && typeof fromWhich === "string") return fromWhich;
  // execPath is the running interpreter; for the compiled `ib` binary it IS
  // the binary, so this is a reasonable fallback before we give up entirely.
  if (process.execPath && process.execPath.endsWith("/ib")) {
    return process.execPath;
  }
  return null;
}

export interface BuildCodexStartContentInput {
  /** Agent id — used by the inline `-c` hook payloads. */
  agentId: string;
  /** Absolute, path-safe path to the `ib` binary. */
  ibBinaryPath: string;
  /**
   * Absolute path to the agent's directory (parent of meta.json / agent.log
   * etc.). Threaded through `buildCodexLaunchArgs` so codex's `log_dir`
   * lands at `<agentDir>/codex`. Quote-safety is enforced inside that helper.
   */
  agentDir: string;
  /** Model half from `parseModel(model).model` — e.g. `gpt-5.4-mini`. */
  codexModel: string;
  /**
   * Already-mapped codex reasoning-effort value (`low`/`medium`/`high`) from
   * `mapEffortForCodex`. Threaded into `buildCodexLaunchArgs` so codex launches
   * with `-c model_reasoning_effort="…"`. Optional — absent means no override.
   */
  codexEffort?: string;
  /**
   * The agent's role instructions from `buildCodexDeveloperInstructions`,
   * launched as `-c developer_instructions="…"` (TOML-escaped, then
   * shell-quoted). Required so a caller cannot launch a codex agent that
   * silently has no role context.
   */
  developerInstructions: string;
  /** Absolute path to prompt.txt — passed as `"$(cat <quoted>)"`. */
  absPromptFile: string;
  /** Absolute path to meta.json — pid is written here. */
  absMetaJson: string;
  /** Absolute path to exit-check.sh. */
  absExitScript: string;
  /** Absolute path to agent.log. */
  absAgentLog: string;
  /** Absolute path to claude.stderr.log (sidecar; reused name for back-compat). */
  absStderrLog: string;
  /** Extra directories passed to codex as `--add-dir` writable roots. */
  extraWritableRoots?: string[];
  /** Configure Codex to use Sakana Fugu and load its key at launch. */
  fugu?: boolean;
  /** Whether itsybitsy's kernel sandbox wraps this launch. */
  sandboxEnabled: boolean;
  /**
   * Proxy startup + environment exports rendered by the shared sandbox wiring.
   * Required when `sandboxEnabled` is true and omitted when it is false.
   */
  sandboxScriptPreamble?: string;
  /** `sandbox-exec -f ... -D ...` prefix; required only in enabled mode. */
  sandboxExecPrefix?: string;
}

/**
 * Render the codex start.sh body for an agent. Mirrors the claude start.sh
 * skeleton (setsid + SIGHUP ignore + pid capture + meta-json write + wait
 * + exit-check) but launches codex with:
 *   - `-m <model> -a never --dangerously-bypass-hook-trust`, with `-s
 *     danger-full-access` beneath itsybitsy's Seatbelt profile and explicit
 *     `-s workspace-write` when that outer wrapper is disabled
 *   - inline `-c 'hooks.<Event>=[...]'` flags from buildCodexLaunchArgs
 *   - the prompt as a positional `"$(cat <prompt-file>)"`
 *
 * The PID variable is kept as `CLAUDE_PID` (and stored as `claude_pid` in
 * meta.json) intentionally — renaming touches the watchdog, dashboard, and
 * every reader of `claude_pid`. That cleanup is out of Phase 4 scope.
 *
 * Throws if the launch-args builder rejects the binary path or agent id.
 */
export function buildCodexStartContent(input: BuildCodexStartContentInput): string {
  if (!isCodexSafeBinaryPath(input.ibBinaryPath)) {
    throw new Error(
      `Unsafe ib binary path for codex launch: ${JSON.stringify(input.ibBinaryPath)} contains quotes, backslashes, or control characters. ` +
        `Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  // buildCodexLaunchArgs silently omits the flag for empty text; a launch
  // script must never do that, or the agent starts with no role context.
  if (!input.developerInstructions.trim()) {
    throw new Error("Codex launch requires non-empty developer instructions (the agent's role text)");
  }

  const { args: hookFlags } = buildCodexLaunchArgs({
    ibBinaryPath: input.ibBinaryPath,
    agentId: input.agentId,
    agentDir: input.agentDir,
    effort: input.codexEffort,
    extraWritableRoots: input.extraWritableRoots,
    developerInstructions: input.developerInstructions,
  });

  // Shell-quote each codex argv element so the resulting `codex ... ` line is
  // robust against an attacker-controlled model string or path component — and
  // so the free-text developer_instructions payload (quotes, `$(...)`,
  // newline escapes) reaches codex byte-for-byte. The hookFlags array already
  // alternates `-c` then the payload; quote both halves uniformly.
  const qModel = shellQuote(input.codexModel);
  const providerFlags = input.fugu
    ? FUGU_CODEX_CONFIG_OVERRIDES.flatMap((override) => ["-c", override])
    : [];
  const qFlagArgs = [...providerFlags, ...hookFlags].map(shellQuote).join(" ");
  const qAbsPromptFile = shellQuote(input.absPromptFile);
  const qStartMetaJson = shellQuote(input.absMetaJson);
  const qStartExitScript = shellQuote(input.absExitScript);
  const qStartAgentLog = shellQuote(input.absAgentLog);
  const qStartStderrLog = shellQuote(input.absStderrLog);
  if (input.sandboxEnabled && (!input.sandboxScriptPreamble?.trim() || !input.sandboxExecPrefix?.trim())) {
    throw new Error("Sandbox-enabled codex launch requires the proxy preamble and sandbox-exec prefix");
  }
  // Codex agents run unattended, so native approval prompts are suppressed in
  // both modes while the generated hooks remain the permission boundary. Our
  // outer Seatbelt wrapper replaces Codex's sandbox only when enabled; when it
  // is disabled we explicitly retain Codex's native workspace-write sandbox.
  const nativeProtectionOverrides = input.sandboxEnabled
    ? " -a never -s danger-full-access"
    : " -a never -s workspace-write";
  const sandboxPreamble = input.sandboxEnabled ? input.sandboxScriptPreamble! : "";
  const sandboxLaunchPrefix = input.sandboxEnabled ? `${input.sandboxExecPrefix} ` : "";

  // The launch line. Per SPEC §3.3:
  //   codex -m <MODEL> -a never -s <danger-full-access|workspace-write> \
  //         --dangerously-bypass-hook-trust \
  //         <inline -c flags> "<prompt>"
  // We log only the model + sentinel rather than the prompt content so a leak
  // of agent.log doesn't disclose the prompt.
  return `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qStartAgentLog}
STDERR_LOG=${qStartStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start.sh] $1" >> "$AGENT_LOG"; }${sandboxPreamble}

log "Starting codex -m ${input.codexModel}${nativeProtectionOverrides} (codex agent id=${input.agentId})"
log "PWD=$(pwd) which_codex=$(which codex 2>&1)"

${input.fugu ? `# Read the Fugu key only at launch time. It stays in the owner-only
# ~/.itsybitsy/config.json file and this shell environment; it is never written
# into the agent directory, logs, or Codex argv.
SAKANA_API_KEY="$( ${shellQuote(input.ibBinaryPath)} config get providers.fugu.api_key )"
if [[ -z "$SAKANA_API_KEY" ]]; then
    log "Fugu launch refused: providers.fugu.api_key is not configured"
    exit 1
fi
export SAKANA_API_KEY
` : ""}

# Ignore SIGHUP for the lifetime of this script. When spawn is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash. SIG_IGN is inherited by the codex child,
# so this protects both halves. setsid (below) is the belt to this suspenders —
# it gives codex its own session so the pty SIGHUP can't reach it at all, but
# the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (spawn insulated from launcher pane teardown)"

# Start codex in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
# Launch under setsid when present so codex leads its own session, fully
# detached from the launcher's controlling terminal.
#
# <&0: explicitly re-inherit the tmux pane pty as stdin; bash bg-jobs without
# job-control silently redirect stdin to /dev/null otherwise, which makes codex
# bail with "stdin is not a terminal". Using <&0 instead of </dev/tty avoids
# the "no controlling terminal" risk after setsid detaches the process group.
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid ${sandboxLaunchPrefix}codex -m ${qModel}${nativeProtectionOverrides} --dangerously-bypass-hook-trust ${qFlagArgs} "$(cat ${qAbsPromptFile})" <&0 2> "$STDERR_LOG" &
else
    ${sandboxLaunchPrefix}codex -m ${qModel}${nativeProtectionOverrides} --dangerously-bypass-hook-trust ${qFlagArgs} "$(cat ${qAbsPromptFile})" <&0 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "Codex PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to Codex PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Codex PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock so the write does not lose a concurrent
# codex SessionStart write of codex_session_id (HIGH 2 from the Phase 4
# review). The absolute ib path is used because codex's PATH may not match
# the spawn shell's.
#
# CRITICAL: write-pid runs with stdin redirected from /dev/null so it NEVER
# touches the tmux pane pty. write-pid is a bun process; codex was backgrounded
# just above and switches the pane pty to RAW mode shortly after spawn. bun
# snapshots the tty settings (still COOKED) when it starts and restores them on
# exit — if write-pid ran on the pane tty that restore would land AFTER codex
# went raw, putting the pty back into COOKED mode, so Enter inserts a newline
# instead of submitting and the agent wedges. </dev/null keeps write-pid off the
# tty entirely; its stdout/stderr go to the agent log so nothing is lost.
META_JSON=${qStartMetaJson}
if [[ -f "$META_JSON" ]]; then
    ${shellQuote(input.ibBinaryPath)} write-pid ${shellQuote(input.agentId)} "$CLAUDE_PID" </dev/null >> "$AGENT_LOG" 2>&1 || log "write-pid failed (exit=$?); meta.json claude_pid not set"
fi

# Wait for codex to complete
wait $CLAUDE_PID
EXIT_CODE=$?
SIGNAL=$(kill -l $EXIT_CODE 2>/dev/null || echo "none")
log "Codex exited: code=$EXIT_CODE signal=$SIGNAL"

# Annotate common exit codes so the cause is obvious in agent.log.
case $EXIT_CODE in
    0)   log "exit=0 → clean exit" ;;
    1)   log "exit=1 → generic codex error (check stderr tail below)" ;;
    2)   log "exit=2 → codex usage / argument error" ;;
    127) log "exit=127 → command not found ('codex' missing from PATH?)" ;;
    129) log "exit=129 → SIGHUP (tmux pane closed or controlling terminal lost)" ;;
    130) log "exit=130 → SIGINT (Ctrl-C)" ;;
    137) log "exit=137 → SIGKILL (likely OOM kill or 'kill -9'; check Console.app for 'low memory')" ;;
    139) log "exit=139 → SIGSEGV (codex segfault)" ;;
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib retire / pause)" ;;
    *)   log "exit=$EXIT_CODE → unrecognized; SIGNAL=$SIGNAL" ;;
esac

# If codex exited non-cleanly and wrote anything to stderr, dump the tail into
# agent.log so the post-mortem doesn't depend on the (now-dying) tmux pane.
if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]; then
    log "── codex stderr (last 50 lines) ──"
    tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"
    log "── end codex stderr ──"
fi

# Run exit check
${qStartExitScript}
`;
}

export interface BuildCodexResumeContentInput {
  /** Agent id — used by the inline `-c` hook payloads. */
  agentId: string;
  /** Absolute, path-safe path to the `ib` binary. */
  ibBinaryPath: string;
  /**
   * Absolute path to the agent's directory (parent of meta.json / agent.log
   * etc.). Threaded through `buildCodexLaunchArgs` so codex's `log_dir`
   * lands at `<agentDir>/codex` on resume too. Quote-safety is enforced
   * inside that helper.
   */
  agentDir: string;
  /** Codex rollout/session UUID from meta.codex_session_id. Already validated upstream by isValidSessionId. */
  codexSessionId: string;
  /**
   * Already-mapped codex reasoning-effort value (`low`/`medium`/`high`) from
   * `mapEffortForCodex`, re-derived from the persisted meta.effort. Threaded
   * into `buildCodexLaunchArgs` so a resumed codex session re-applies the
   * `-c model_reasoning_effort="…"` override (unlike `-m <model>`, which is
   * bound to the rollout and deliberately dropped). Optional — absent (legacy
   * agents) means no override.
   */
  codexEffort?: string;
  /**
   * The agent's role instructions, regenerated from the current frozen meta
   * and passed again as `-c developer_instructions="…"`. Codex does NOT add a
   * second copy on resume: the resumed rollout already holds the spawn-time
   * copy, and codex re-sends the configured developer instructions only when
   * it rebuilds the full initial context. With a saved reference context in
   * the rollout (the normal case) that is after the next compaction; with none,
   * it is the first resumed turn (SPEC §18.7).
   */
  developerInstructions: string;
  /** Absolute path to meta.json — pid is written here. */
  absMetaJson: string;
  /** Absolute path to exit-check.sh. */
  absExitScript: string;
  /** Absolute path to agent.log. */
  absAgentLog: string;
  /** Absolute path to claude.stderr.log (sidecar; reused name for back-compat). */
  absStderrLog: string;
  /** Extra directories passed to codex as `--add-dir` writable roots. */
  extraWritableRoots?: string[];
  /** Reconfigure Sakana Fugu for the resumed Codex session. */
  fugu?: boolean;
  /** Whether itsybitsy's kernel sandbox wraps this resume. */
  sandboxEnabled: boolean;
  /**
   * Proxy startup + environment exports rendered by the shared sandbox wiring.
   * Required when `sandboxEnabled` is true and omitted when it is false.
   */
  sandboxScriptPreamble?: string;
  /** `sandbox-exec -f ... -D ...` prefix; required only in enabled mode. */
  sandboxExecPrefix?: string;
}

/**
 * Render the codex resume.sh body for an agent. Mirrors `buildCodexStartContent`
 * exactly (same setsid + SIGHUP ignore + pid capture + meta-json write + wait
 * + exit-check skeleton) but the launch line is:
 *   `codex resume "<UUID>" -a never -s <danger-full-access|workspace-write> --dangerously-bypass-hook-trust <inline -c flags>`
 *
 * Differences from start.sh:
 *   - Subcommand form (`codex resume <UUID>`), not the top-level `codex` invocation.
 *   - No `-m <model>` flag — the model is bound to the resumed rollout.
 *   - No positional prompt — `codex resume` continues an existing session.
 *   - Re-passes the inline `-c` hook flags and `--dangerously-bypass-hook-trust`
 *     defensively (Q1 in the Phase 7 prompt): we cannot rely on codex
 *     persisting the original spawn's hook registration across resume; passing
 *     them again is a no-op if codex DOES persist them and safety-critical if
 *     it doesn't (without hooks every PreToolUse silently fail-opens).
 *   - Re-passes `-a never` in both modes so unattended resumes never prompt.
 *     Enabled mode uses `-s danger-full-access` beneath itsybitsy's outer
 *     Seatbelt profile; disabled mode explicitly retains `-s workspace-write`.
 *
 * The PID variable is kept as `CLAUDE_PID` (and stored as `claude_pid` in
 * meta.json) intentionally — see `buildCodexStartContent` rationale.
 *
 * Throws if the launch-args builder rejects the binary path or agent id.
 */
export function buildCodexResumeContent(input: BuildCodexResumeContentInput): string {
  if (!isCodexSafeBinaryPath(input.ibBinaryPath)) {
    throw new Error(
      `Unsafe ib binary path for codex resume: ${JSON.stringify(input.ibBinaryPath)} contains quotes, backslashes, or control characters. ` +
        `Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  // Same guard as buildCodexStartContent: never write a resume.sh that
  // silently drops the role text.
  if (!input.developerInstructions.trim()) {
    throw new Error("Codex resume requires non-empty developer instructions (the agent's role text)");
  }

  const { args: hookFlags } = buildCodexLaunchArgs({
    ibBinaryPath: input.ibBinaryPath,
    agentId: input.agentId,
    agentDir: input.agentDir,
    effort: input.codexEffort,
    extraWritableRoots: input.extraWritableRoots,
    developerInstructions: input.developerInstructions,
  });

  const qSessionId = shellQuote(input.codexSessionId);
  const providerFlags = input.fugu
    ? FUGU_CODEX_CONFIG_OVERRIDES.flatMap((override) => ["-c", override])
    : [];
  const qFlagArgs = [...providerFlags, ...hookFlags].map(shellQuote).join(" ");
  const qResumeMetaJson = shellQuote(input.absMetaJson);
  const qResumeExitScript = shellQuote(input.absExitScript);
  const qResumeAgentLog = shellQuote(input.absAgentLog);
  const qResumeStderrLog = shellQuote(input.absStderrLog);
  if (input.sandboxEnabled && (!input.sandboxScriptPreamble?.trim() || !input.sandboxExecPrefix?.trim())) {
    throw new Error("Sandbox-enabled codex resume requires the proxy preamble and sandbox-exec prefix");
  }
  const nativeProtectionOverrides = input.sandboxEnabled
    ? " -a never -s danger-full-access"
    : " -a never -s workspace-write";
  const sandboxPreamble = input.sandboxEnabled ? input.sandboxScriptPreamble! : "";
  const sandboxLaunchPrefix = input.sandboxEnabled ? `${input.sandboxExecPrefix} ` : "";

  return `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qResumeAgentLog}
STDERR_LOG=${qResumeStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resume.sh] $1" >> "$AGENT_LOG"; }${sandboxPreamble}

log "Resuming codex resume ${input.codexSessionId} (codex agent id=${input.agentId})"
log "PWD=$(pwd) which_codex=$(which codex 2>&1)"

${input.fugu ? `# Read the Fugu key only at resume time. It is not persisted in the
# agent's files, logs, or command arguments.
SAKANA_API_KEY="$( ${shellQuote(input.ibBinaryPath)} config get providers.fugu.api_key )"
if [[ -z "$SAKANA_API_KEY" ]]; then
    log "Fugu resume refused: providers.fugu.api_key is not configured"
    exit 1
fi
export SAKANA_API_KEY
` : ""}

# Ignore SIGHUP for the lifetime of this script. When resume is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash-resume loop. SIG_IGN is inherited by the
# codex child, so this protects both halves. setsid (below) is the belt to this
# suspenders — it gives codex its own session so the pty SIGHUP can't reach it
# at all, but the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (resume insulated from launcher pane teardown)"

# Start codex in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
# Launch under setsid when present so codex leads its own session, fully
# detached from the launcher's controlling terminal.
#
# <&0: explicitly re-inherit the tmux pane pty as stdin; bash bg-jobs without
# job-control silently redirect stdin to /dev/null otherwise, which makes codex
# bail with "stdin is not a terminal". Using <&0 instead of </dev/tty avoids
# the "no controlling terminal" risk after setsid detaches the process group.
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid ${sandboxLaunchPrefix}codex resume ${qSessionId}${nativeProtectionOverrides} --dangerously-bypass-hook-trust ${qFlagArgs} <&0 2> "$STDERR_LOG" &
else
    ${sandboxLaunchPrefix}codex resume ${qSessionId}${nativeProtectionOverrides} --dangerously-bypass-hook-trust ${qFlagArgs} <&0 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "Codex PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to Codex PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Codex PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock so the write does not lose a concurrent
# codex SessionStart write of codex_session_id (HIGH 2 from the Phase 4
# review). The absolute ib path is used because codex's PATH may not match
# the spawn shell's.
#
# CRITICAL: write-pid runs with stdin redirected from /dev/null so it NEVER
# touches the tmux pane pty. write-pid is a bun process; codex was backgrounded
# just above and switches the pane pty to RAW mode shortly after spawn. bun
# snapshots the tty settings (still COOKED) when it starts and restores them on
# exit — if write-pid ran on the pane tty that restore would land AFTER codex
# went raw, putting the pty back into COOKED mode, so Enter inserts a newline
# instead of submitting and the agent wedges. </dev/null keeps write-pid off the
# tty entirely; its stdout/stderr go to the agent log so nothing is lost.
META_JSON=${qResumeMetaJson}
if [[ -f "$META_JSON" ]]; then
    ${shellQuote(input.ibBinaryPath)} write-pid ${shellQuote(input.agentId)} "$CLAUDE_PID" </dev/null >> "$AGENT_LOG" 2>&1 || log "write-pid failed (exit=$?); meta.json claude_pid not set"
fi

# Wait for codex to complete
wait $CLAUDE_PID
EXIT_CODE=$?
SIGNAL=$(kill -l $EXIT_CODE 2>/dev/null || echo "none")
log "Codex exited: code=$EXIT_CODE signal=$SIGNAL"

# Annotate common exit codes so the cause is obvious in agent.log.
case $EXIT_CODE in
    0)   log "exit=0 → clean exit" ;;
    1)   log "exit=1 → generic codex error (check stderr tail below)" ;;
    2)   log "exit=2 → codex usage / argument error" ;;
    127) log "exit=127 → command not found ('codex' missing from PATH?)" ;;
    129) log "exit=129 → SIGHUP (tmux pane closed or controlling terminal lost)" ;;
    130) log "exit=130 → SIGINT (Ctrl-C)" ;;
    137) log "exit=137 → SIGKILL (likely OOM kill or 'kill -9'; check Console.app for 'low memory')" ;;
    139) log "exit=139 → SIGSEGV (codex segfault)" ;;
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib retire / pause)" ;;
    *)   log "exit=$EXIT_CODE → unrecognized; SIGNAL=$SIGNAL" ;;
esac

# If codex exited non-cleanly and wrote anything to stderr, dump the tail into
# agent.log so the post-mortem doesn't depend on the (now-dying) tmux pane.
if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]; then
    log "── codex stderr (last 50 lines) ──"
    tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"
    log "── end codex stderr ──"
fi

# Run exit check
${qResumeExitScript}
`;
}

export type AppendCodexGitignoreResult = GitignoreEntryOutcome;

/**
 * Append `.codex/` to <worktree>/.gitignore if not already present. Now a thin
 * wrapper over the generalized `appendGitignoreEntries` (worktree-gitignore.ts)
 * — the codex path is just the single-entry `[".codex/"]` case. Idempotent; respects
 * an explicit `!.codex/` / `!.codex` negation (MED 3 from the Phase 4 review).
 *
 * Returns:
 *   - "appended"          file was created or `.codex/` was appended.
 *   - "already-present"   `.codex/` or `.codex` already in the file.
 *   - "negation-respected" the file has an explicit `!.codex/` or `!.codex`
 *                          negation; we did not append.
 */
export async function appendCodexGitignoreEntry(worktreePath: string): Promise<AppendCodexGitignoreResult> {
  const results = await appendGitignoreEntries(worktreePath, [".codex/"]);
  return results[".codex/"]!;
}

/**
 * Build the per-agent role instructions for a codex agent. They are launched
 * as `-c developer_instructions="…"` (see `buildCodexLaunchArgs`), which codex
 * adds to the session as a developer message — the codex analog of the Claude
 * session-start injection.
 *
 * The text is the shared `buildAgentRoleBody()` (agent-instructions-shared.ts):
 * `generateInstructions()` from `session-start.ts`, so the codex agent gets the
 * same role-shaped context (path isolation, bash rules, ib-send guidance,
 * commands table, worker/manager-specific blocks, team-awareness) as the claude
 * agent of the same type, with the `<ittybitty>` wrapper stripped (codex
 * doesn't recognize it), plus the skills catalog. This adapter adds nothing;
 * the codex-specific encoding happens later: TOML string + size cap in
 * `buildCodexLaunchArgs` (via `renderCodexDeveloperInstructionsPayload`), shell
 * quoting in `buildCodexStartContent` / `buildCodexResumeContent`.
 *
 * Project and user-wide instructions are deliberately NOT included. Codex
 * reads the repo's own `AGENTS.md` natively (itsybitsy never writes one), and
 * user-wide instructions come from codex's global `~/.codex/AGENTS.md` — a
 * symlink to `~/.claude/CLAUDE.md` shares one file with Claude.
 *
 * Claude-only tool audit (HIGH 4 from the Phase 4 review):
 *   - `TodoWrite` references — removed in manager.md + the session-start.ts
 *     hardcoded fallback; replaced with "Track progress with measurable
 *     criteria" (CLI-agnostic).
 *   - `Write(...)` snippet in `_non_coordinator.md`'s commit-message
 *     section — rewritten to "Default to writing the message to a temp
 *     file first" so codex agents (whose file-edit tool is apply_patch,
 *     not Write) read CLI-agnostic guidance.
 *   - The Tool Interception block in manager.md (mentions Task, Agent,
 *     TaskCreate) is left in place. Those tools don't exist on codex, so
 *     a codex manager simply won't trigger the deny-on-intercept path
 *     described — the block is harmless but technically Claude-specific.
 *     A future phase should conditionalize this block per-cli once the
 *     agent-type template engine grows {{#if cli == "claude"}} support.
 */
export async function buildCodexDeveloperInstructions(ctx: SessionContext): Promise<string> {
  return buildAgentRoleBody(ctx);
}
