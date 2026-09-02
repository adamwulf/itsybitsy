/**
 * Antigravity CLI (`agy`) spawn-path helpers — pure builders that the
 * `newAgent()` / `resumeAgent()` agy branches (SPEC-ANTIGRAVITY-CLI.md §4.5,
 * Phase 2) compose into the start.sh / resume.sh scripts, plus the three
 * on-disk / teardown helpers those branches drive:
 *
 *   1. `buildAgyStartContent` / `buildAgyResumeContent` — render the launch
 *      scripts. Same setsid + SIGHUP-ignore + pid-capture + meta-write + wait
 *      + exit-check skeleton as the codex builders (`src/codex-spawn.ts`), so
 *      the watchdog and every reader of `claude_pid` keep working unchanged.
 *      Launch line per D2:
 *        agy --dangerously-skip-permissions --mode=accept-edits \
 *            --model <slug> [--effort <e>] --log-file <agentDir>/agy.log \
 *            -i "$(cat <promptfile>)"
 *      Resume is the same flags with `--conversation <uuid>` and NO `-i`.
 *   2. `writeAgyWorktreeFiles` — write `.agents/hooks.json` and
 *      `.agents/rules/ittybitty-agent.md` into the worktree (D3 + D6).
 *   3. `refuseIfTracked` — the D7 guard: refuse the spawn if either boundary
 *      file is already tracked in the repo.
 *   4. `untrustAgyWorkspaceForTeardown` — the D5 teardown counterpart: remove
 *      the worktree from agy's `trustedWorkspaces` (best effort, never throws).
 *
 * No subprocesses are spawned from this module. The dispatcher precheck and
 * pre-trust that the spawn path also runs live in `ib-commands.ts` so they can
 * share `newAgentSpawnCtx` / `codexDryRunSpawnCtx` with the rest of the flow.
 */

import { join, dirname } from "path";
import { realpathSync } from "fs";
import { mkdir } from "fs/promises";
import { shellQuote, isValidModel, isValidAgentId } from "./validation";
import { isCodexSafeBinaryPath } from "./codex-config";
import { parseModel, agySlugHasEffort, mapEffortForAgy } from "./agent-cli";
import type { SessionContext } from "./hooks/session-start";
import { buildAgyHooksJson, buildAgyRulesFile, removeAgyTrustedWorkspace } from "./agy-config";
import { AGY_WORKTREE_FILES } from "./agy-worktree-files";

/**
 * Render the ` --effort <e>` fragment for an agy launch line per D1. `--effort`
 * is passed ONLY when the model slug does NOT already encode an effort as a
 * trailing `-low`/`-medium`/`-high` segment — Gemini slugs bake the effort into
 * the name, and passing both would be ambiguous. The itsybitsy 5-level `effort`
 * is mapped down to agy's `low|medium|high` set by `mapEffortForAgy`. Returns
 * "" (no flag) when the effort is empty (legacy agents) or the slug already
 * carries an effort suffix. The value is shell-quoted.
 */
function agyEffortFlag(agyModel: string, effort: string | undefined): string {
  if (!effort) return "";
  if (agySlugHasEffort(agyModel)) return "";
  return ` --effort ${shellQuote(mapEffortForAgy(effort))}`;
}

/**
 * Validate the pieces of an agy launch line that are interpolated into the
 * shell script. Throws a descriptive error rather than returning a malformed
 * script — callers turn that into a clean spawn/resume rejection.
 */
function assertAgyLaunchPreconditions(ibBinaryPath: string, agentId: string, agyModel: string, context: string): void {
  if (!isCodexSafeBinaryPath(ibBinaryPath)) {
    throw new Error(
      `Unsafe ib binary path for agy ${context}: ${JSON.stringify(ibBinaryPath)} contains quotes, backslashes, or control characters. ` +
        `Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
    );
  }
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for agy ${context}: ${JSON.stringify(agentId)}`);
  }
  // The slug is the model half of `agy:<slug>`; validate it with the same
  // shell-safety allowlist used for every model string before it reaches the
  // launch line (it is also shell-quoted below — belt and suspenders).
  if (!isValidModel(agyModel)) {
    throw new Error(`Invalid agy model slug for ${context}: ${JSON.stringify(agyModel)}`);
  }
}

export interface BuildAgyStartContentInput {
  /** Agent id — interpolated into the write-pid call and the start.sh log line. */
  agentId: string;
  /** Absolute, path-safe path to the `ib` binary (used by `ib write-pid`). */
  ibBinaryPath: string;
  /**
   * Absolute path to the agent's directory. agy's own `--log-file` lands at
   * `<agentDir>/agy.log` (the log line that confirms hook registration —
   * ANTIGRAVITY-CLI-NOTES.md §17.1 — is written there).
   */
  agentDir: string;
  /** agy model slug from `parseModel(model).model` — passed verbatim to `--model`. */
  agyModel: string;
  /**
   * Raw itsybitsy effort level (`low|medium|high|xhigh|max`), or empty. The D1
   * slug-suffix rule + `mapEffortForAgy` down-mapping is applied internally, so
   * the caller passes the unmapped value.
   */
  effort?: string;
  /** Absolute path to prompt.txt — passed as `-i "$(cat <quoted>)"`. */
  absPromptFile: string;
  /** Absolute path to meta.json — pid is written here via `ib write-pid`. */
  absMetaJson: string;
  /** Absolute path to exit-check.sh. */
  absExitScript: string;
  /** Absolute path to agent.log. */
  absAgentLog: string;
  /** Absolute path to claude.stderr.log (sidecar; reused name for back-compat). */
  absStderrLog: string;
}

/**
 * Render the agy start.sh body for an agent. Mirrors `buildCodexStartContent`'s
 * skeleton exactly (setsid + SIGHUP ignore + pid capture + meta-json write +
 * wait + exit-code annotation + exit-check) but launches agy with the D2 line:
 *
 *   agy --dangerously-skip-permissions --mode=accept-edits --model <slug> \
 *       [--effort <e>] --log-file <agentDir>/agy.log -i "$(cat <prompt>)"
 *
 * The PID variable stays `CLAUDE_PID` (and is stored as `claude_pid` in
 * meta.json) intentionally — the watchdog, dashboard, and every reader of
 * `claude_pid` depend on it. Only the model + agent id are logged, never the
 * prompt content, so a leak of agent.log does not disclose the prompt.
 *
 * Throws (via `assertAgyLaunchPreconditions`) if the binary path, agent id, or
 * model slug is unsafe.
 */
export function buildAgyStartContent(input: BuildAgyStartContentInput): string {
  assertAgyLaunchPreconditions(input.ibBinaryPath, input.agentId, input.agyModel, "launch");

  const qModel = shellQuote(input.agyModel);
  const effortFlag = agyEffortFlag(input.agyModel, input.effort);
  const qAgyLog = shellQuote(join(input.agentDir, "agy.log"));
  const qAbsPromptFile = shellQuote(input.absPromptFile);
  const qStartMetaJson = shellQuote(input.absMetaJson);
  const qStartExitScript = shellQuote(input.absExitScript);
  const qStartAgentLog = shellQuote(input.absAgentLog);
  const qStartStderrLog = shellQuote(input.absStderrLog);
  const qIbPath = shellQuote(input.ibBinaryPath);

  const launch =
    `agy --dangerously-skip-permissions --mode=accept-edits --model ${qModel}${effortFlag} --log-file ${qAgyLog} -i "$(cat ${qAbsPromptFile})"`;

  return `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own agy process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qStartAgentLog}
STDERR_LOG=${qStartStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start.sh] $1" >> "$AGENT_LOG"; }

log "Starting agy --model ${input.agyModel} --mode=accept-edits (agy agent id=${input.agentId})"
log "PWD=$(pwd) which_agy=$(which agy 2>&1)"

# Ignore SIGHUP for the lifetime of this script. When spawn is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash. SIG_IGN is inherited by the agy child,
# so this protects both halves. setsid (below) is the belt to this suspenders —
# it gives agy its own session so the pty SIGHUP can't reach it at all, but
# the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (spawn insulated from launcher pane teardown)"

# Start agy in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
# Launch under setsid when present so agy leads its own session, fully detached
# from the launcher's controlling terminal.
#
# <&0: explicitly re-inherit the tmux pane pty as stdin; bash bg-jobs without
# job-control silently redirect stdin to /dev/null otherwise, which makes the
# interactive agy TUI bail. Using <&0 instead of </dev/tty avoids the "no
# controlling terminal" risk after setsid detaches the process group.
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid ${launch} <&0 2> "$STDERR_LOG" &
else
    ${launch} <&0 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "agy PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to agy PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to agy PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock so the write does not lose a concurrent
# mutation (e.g. the agy PreInvocation hook setting agy_conversation_id). The
# absolute ib path is used because agy's spawn env's PATH may not match the
# spawn shell's.
META_JSON=${qStartMetaJson}
if [[ -f "$META_JSON" ]]; then
    ${qIbPath} write-pid ${shellQuote(input.agentId)} "$CLAUDE_PID" || log "write-pid failed (exit=$?); meta.json claude_pid not set"
fi

# Wait for agy to complete
wait $CLAUDE_PID
EXIT_CODE=$?
SIGNAL=$(kill -l $EXIT_CODE 2>/dev/null || echo "none")
log "agy exited: code=$EXIT_CODE signal=$SIGNAL"

# Annotate common exit codes so the cause is obvious in agent.log.
case $EXIT_CODE in
    0)   log "exit=0 → clean exit" ;;
    1)   log "exit=1 → generic agy error (check stderr tail below)" ;;
    2)   log "exit=2 → agy usage / argument error" ;;
    127) log "exit=127 → command not found ('agy' missing from PATH?)" ;;
    129) log "exit=129 → SIGHUP (tmux pane closed or controlling terminal lost)" ;;
    130) log "exit=130 → SIGINT (Ctrl-C)" ;;
    137) log "exit=137 → SIGKILL (likely OOM kill or 'kill -9'; check Console.app for 'low memory')" ;;
    139) log "exit=139 → SIGSEGV (agy segfault)" ;;
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib retire / pause)" ;;
    *)   log "exit=$EXIT_CODE → unrecognized; SIGNAL=$SIGNAL" ;;
esac

# If agy exited non-cleanly and wrote anything to stderr, dump the tail into
# agent.log so the post-mortem doesn't depend on the (now-dying) tmux pane.
if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]; then
    log "── agy stderr (last 50 lines) ──"
    tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"
    log "── end agy stderr ──"
fi

# Run exit check
${qStartExitScript}
`;
}

export interface BuildAgyResumeContentInput {
  /** Agent id — interpolated into the write-pid call and the resume.sh log line. */
  agentId: string;
  /** Absolute, path-safe path to the `ib` binary (used by `ib write-pid`). */
  ibBinaryPath: string;
  /** Absolute path to the agent's directory (agy `--log-file` → `<agentDir>/agy.log`). */
  agentDir: string;
  /**
   * agy model slug from `parseModel(meta.model).model`. Unlike codex — which
   * binds the model to the rollout and drops `-m` on resume — agy resume does
   * NOT carry the model (ANTIGRAVITY-CLI-NOTES.md §17.6), so it MUST be re-passed
   * with `--model` here.
   */
  agyModel: string;
  /** Raw itsybitsy effort level (`low|medium|high|xhigh|max`), or empty — same D1 rule as start. */
  effort?: string;
  /** agy conversation UUID from meta.agy_conversation_id. Validated upstream by isValidSessionId. */
  conversationId: string;
  /** Absolute path to meta.json — pid is written here via `ib write-pid`. */
  absMetaJson: string;
  /** Absolute path to exit-check.sh. */
  absExitScript: string;
  /** Absolute path to agent.log. */
  absAgentLog: string;
  /** Absolute path to claude.stderr.log (sidecar; reused name for back-compat). */
  absStderrLog: string;
}

/**
 * Render the agy resume.sh body for an agent. Identical skeleton to
 * `buildAgyStartContent`; the launch line differs only in that it carries
 * `--conversation <uuid>` (to reattach the prior conversation) and has NO `-i`
 * / prompt. `--model` and the effort flag ARE re-passed — agy resume does not
 * remember either (§17.6). Only the conversation id + agent id are logged,
 * never any prompt content.
 *
 * Throws (via `assertAgyLaunchPreconditions`) if the binary path, agent id, or
 * model slug is unsafe.
 */
export function buildAgyResumeContent(input: BuildAgyResumeContentInput): string {
  assertAgyLaunchPreconditions(input.ibBinaryPath, input.agentId, input.agyModel, "resume");

  const qModel = shellQuote(input.agyModel);
  const effortFlag = agyEffortFlag(input.agyModel, input.effort);
  const qConversation = shellQuote(input.conversationId);
  const qAgyLog = shellQuote(join(input.agentDir, "agy.log"));
  const qResumeMetaJson = shellQuote(input.absMetaJson);
  const qResumeExitScript = shellQuote(input.absExitScript);
  const qResumeAgentLog = shellQuote(input.absAgentLog);
  const qResumeStderrLog = shellQuote(input.absStderrLog);
  const qIbPath = shellQuote(input.ibBinaryPath);

  const launch =
    `agy --dangerously-skip-permissions --mode=accept-edits --model ${qModel}${effortFlag} --log-file ${qAgyLog} --conversation ${qConversation}`;

  return `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own agy process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qResumeAgentLog}
STDERR_LOG=${qResumeStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resume.sh] $1" >> "$AGENT_LOG"; }

log "Resuming agy --conversation ${input.conversationId} --model ${input.agyModel} (agy agent id=${input.agentId})"
log "PWD=$(pwd) which_agy=$(which agy 2>&1)"

# Ignore SIGHUP for the lifetime of this script. When resume is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash-resume loop. SIG_IGN is inherited by the
# agy child, so this protects both halves. setsid (below) is the belt to this
# suspenders — it gives agy its own session so the pty SIGHUP can't reach it at
# all, but the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (resume insulated from launcher pane teardown)"

# Start agy in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
# Launch under setsid when present so agy leads its own session, fully detached
# from the launcher's controlling terminal.
#
# <&0: explicitly re-inherit the tmux pane pty as stdin; bash bg-jobs without
# job-control silently redirect stdin to /dev/null otherwise, which makes the
# interactive agy TUI bail. Using <&0 instead of </dev/tty avoids the "no
# controlling terminal" risk after setsid detaches the process group.
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid ${launch} <&0 2> "$STDERR_LOG" &
else
    ${launch} <&0 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "agy PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to agy PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to agy PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock so the write does not lose a concurrent
# mutation. The absolute ib path is used because agy's env's PATH may not match
# the spawn shell's.
META_JSON=${qResumeMetaJson}
if [[ -f "$META_JSON" ]]; then
    ${qIbPath} write-pid ${shellQuote(input.agentId)} "$CLAUDE_PID" || log "write-pid failed (exit=$?); meta.json claude_pid not set"
fi

# Wait for agy to complete
wait $CLAUDE_PID
EXIT_CODE=$?
SIGNAL=$(kill -l $EXIT_CODE 2>/dev/null || echo "none")
log "agy exited: code=$EXIT_CODE signal=$SIGNAL"

# Annotate common exit codes so the cause is obvious in agent.log.
case $EXIT_CODE in
    0)   log "exit=0 → clean exit" ;;
    1)   log "exit=1 → generic agy error (check stderr tail below)" ;;
    2)   log "exit=2 → agy usage / argument error" ;;
    127) log "exit=127 → command not found ('agy' missing from PATH?)" ;;
    129) log "exit=129 → SIGHUP (tmux pane closed or controlling terminal lost)" ;;
    130) log "exit=130 → SIGINT (Ctrl-C)" ;;
    137) log "exit=137 → SIGKILL (likely OOM kill or 'kill -9'; check Console.app for 'low memory')" ;;
    139) log "exit=139 → SIGSEGV (agy segfault)" ;;
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib retire / pause)" ;;
    *)   log "exit=$EXIT_CODE → unrecognized; SIGNAL=$SIGNAL" ;;
esac

# If agy exited non-cleanly and wrote anything to stderr, dump the tail into
# agent.log so the post-mortem doesn't depend on the (now-dying) tmux pane.
if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]; then
    log "── agy stderr (last 50 lines) ──"
    tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"
    log "── end agy stderr ──"
fi

# Run exit check
${qResumeExitScript}
`;
}

/**
 * Write the two agy boundary files into the worktree (D3 + D6):
 *   - `<worktree>/.agents/hooks.json` — the PreToolUse/PreInvocation/Stop
 *     dispatcher registration (the ONLY permission boundary).
 *   - `<worktree>/.agents/rules/ittybitty-agent.md` — the always-on rule file
 *     carrying the agent's role instructions + inlined CLAUDE.md + skills.
 *
 * Both parent directories are created. Returns the two absolute paths so the
 * caller can log them. Regenerated unconditionally on resume so permission
 * edits take effect and a tampered file is overwritten (§4.5).
 */
export async function writeAgyWorktreeFiles(
  worktreePath: string,
  ctx: SessionContext,
  opts: { ibBinaryPath: string; agentId: string },
): Promise<{ hooksPath: string; rulesPath: string }> {
  const hooksPath = join(worktreePath, ".agents", "hooks.json");
  const rulesPath = join(worktreePath, ".agents", "rules", "ittybitty-agent.md");
  await mkdir(dirname(hooksPath), { recursive: true });
  await mkdir(dirname(rulesPath), { recursive: true });
  const hooksJson = buildAgyHooksJson({ ibBinaryPath: opts.ibBinaryPath, agentId: opts.agentId });
  const rulesBody = await buildAgyRulesFile(ctx);
  await Bun.write(hooksPath, hooksJson);
  await Bun.write(rulesPath, rulesBody);
  return { hooksPath, rulesPath };
}

/**
 * D7 guard: return the FIRST of `files` that is already tracked in the repo at
 * `worktreePath`, or `null` when none are. Overwriting a tracked boundary file
 * would dirty the worktree and clobber the repo's own hooks/rules, so the spawn
 * is refused before writing anything.
 *
 * Uses `git ls-files --error-unmatch <file>`, which exits 0 for a tracked path
 * and non-zero otherwise. `run` is the injected spawn-ctx runner (`git -C
 * <worktree>` targets the worktree — the spawn ctx runner has no cwd option).
 */
export async function refuseIfTracked(
  worktreePath: string,
  files: readonly string[],
  run: (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<string | null> {
  for (const file of files) {
    const result = await run(["git", "-C", worktreePath, "ls-files", "--error-unmatch", file]);
    if (result.exitCode === 0) return file;
  }
  return null;
}

/**
 * Teardown counterpart to the D5 pre-trust: remove the worktree's realpath from
 * agy's `trustedWorkspaces`. Called from the shared archive/retire/nuke/merge
 * teardown path BEFORE the worktree is removed (so `realpathSync` still
 * resolves). Reads `meta.model` from `<agentDir>/meta.json` and does nothing
 * unless the agent is an agy agent — a claude/codex teardown must not touch
 * `~/.gemini`. Best effort: NEVER throws, so a teardown can't fail on it.
 */
export async function untrustAgyWorkspaceForTeardown(
  agentDir: string,
  worktreePath: string,
): Promise<void> {
  try {
    const meta = (await Bun.file(join(agentDir, "meta.json"))
      .json()
      .catch(() => null)) as { model?: string } | null;
    const model = meta?.model;
    if (!model || model === "null") return;
    let cli: string;
    try {
      cli = parseModel(model).cli;
    } catch {
      return;
    }
    if (cli !== "agy") return;
    // Match the path agy stored at spawn (realpath of the worktree). If the
    // worktree dir is already gone the resolve throws — fall back to the raw
    // path (a best-effort miss, not a failure).
    let realWorktree = worktreePath;
    try {
      realWorktree = realpathSync(worktreePath);
    } catch {
      /* dir may be gone — untrust the unresolved path as a best-effort attempt */
    }
    await removeAgyTrustedWorkspace(realWorktree);
  } catch {
    /* teardown must never fail because of the untrust step */
  }
}

// Re-exported so the ib-commands.ts agy branches import the file list from the
// spawn module alongside the builders they compose with it.
export { AGY_WORKTREE_FILES };
