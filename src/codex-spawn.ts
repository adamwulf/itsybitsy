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
 *   3. Generate the per-agent `AGENTS.md` body codex reads natively at
 *      session start — the codex analog of the Claude `session-start.ts`
 *      injection. For Phase 4 we delegate to `generateInstructions()` from
 *      `src/hooks/session-start.ts` and strip the Claude-specific
 *      `<ittybitty>...</ittybitty>` wrapper (codex doesn't read that tag).
 *
 * No subprocesses are spawned from this module — the precheck that runs
 * `ib hooks codex-* --dry-run` lives in `ib-commands.ts` so it can share
 * `newAgentSpawnCtx` with the rest of the spawn flow.
 */

import { join } from "path";
import { mkdir } from "fs/promises";
import { shellQuote } from "./validation";
import { buildCodexLaunchArgs, isCodexSafeBinaryPath } from "./codex-config";
import type { SessionContext } from "./hooks/session-start";
import { generateInstructions } from "./hooks/session-start";

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
  /** Model half from `parseModel(model).model` — e.g. `gpt-5.4-mini`. */
  codexModel: string;
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
}

/**
 * Render the codex start.sh body for an agent. Mirrors the claude start.sh
 * skeleton (setsid + SIGHUP ignore + pid capture + meta-json write + wait
 * + exit-check) but launches codex with:
 *   - `-m <model> -a never -s workspace-write --dangerously-bypass-hook-trust`
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

  const { args: hookFlags } = buildCodexLaunchArgs({
    ibBinaryPath: input.ibBinaryPath,
    agentId: input.agentId,
  });

  // Shell-quote each codex argv element so the resulting `codex ... ` line is
  // robust against an attacker-controlled model string or path component. The
  // hookFlags array already alternates `-c` then the payload; quote both
  // halves uniformly.
  const qModel = shellQuote(input.codexModel);
  const qFlagArgs = hookFlags.map(shellQuote).join(" ");
  const qAbsPromptFile = shellQuote(input.absPromptFile);
  const qStartMetaJson = shellQuote(input.absMetaJson);
  const qStartExitScript = shellQuote(input.absExitScript);
  const qStartAgentLog = shellQuote(input.absAgentLog);
  const qStartStderrLog = shellQuote(input.absStderrLog);

  // The launch line. Per SPEC §3.3:
  //   codex -m <MODEL> -a never -s workspace-write --dangerously-bypass-hook-trust \
  //         <inline -c flags> "<prompt>"
  // We log only the model + sentinel rather than the prompt content so a leak
  // of agent.log doesn't disclose the prompt.
  return `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qStartAgentLog}
STDERR_LOG=${qStartStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start.sh] $1" >> "$AGENT_LOG"; }

log "Starting codex -m ${input.codexModel} -a never -s workspace-write (codex agent id=${input.agentId})"
log "PWD=$(pwd) which_codex=$(which codex 2>&1)"

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
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid codex -m ${qModel} -a never -s workspace-write --dangerously-bypass-hook-trust ${qFlagArgs} "$(cat ${qAbsPromptFile})" 2> "$STDERR_LOG" &
else
    codex -m ${qModel} -a never -s workspace-write --dangerously-bypass-hook-trust ${qFlagArgs} "$(cat ${qAbsPromptFile})" 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "Codex PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to Codex PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Codex PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json
META_JSON=${qStartMetaJson}
if [[ -f "$META_JSON" ]]; then
    bun -e "const f=process.argv[1];const m=JSON.parse(require('fs').readFileSync(f,'utf8'));m.claude_pid=String(process.argv[2]);require('fs').writeFileSync(f,JSON.stringify(m,null,2))" "$META_JSON" "$CLAUDE_PID"
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
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib kill / pause)" ;;
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

/**
 * Append `.codex/` to <worktree>/.gitignore if not already present. Idempotent:
 * a worktree whose .gitignore already lists `.codex/` (or `.codex` without
 * trailing slash) is left untouched. The file is created with mode 644 if
 * missing — `mkdir -p` is the caller's responsibility (worktree must exist).
 *
 * Returns true if anything was written (file created or line appended),
 * false if the file already had the entry.
 */
export async function appendCodexGitignoreEntry(worktreePath: string): Promise<boolean> {
  const gitignorePath = join(worktreePath, ".gitignore");
  const file = Bun.file(gitignorePath);
  let existing = "";
  if (await file.exists()) {
    existing = await file.text();
  }
  // Normalize line check: strip leading/trailing whitespace per line; match
  // `.codex/` OR `.codex` (both are valid gitignore entries that exclude the
  // directory).
  const hasEntry = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === ".codex/" || l === ".codex");
  if (hasEntry) return false;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const appended = (needsLeadingNewline ? "\n" : "") + ".codex/\n";
  await Bun.write(gitignorePath, existing + appended);
  return true;
}

/**
 * Generate a per-agent `AGENTS.md` body for a codex agent. Codex reads
 * `AGENTS.md` in the worktree natively at session start (SPEC §3.1) — this
 * is the codex analog of the Claude session-start injection.
 *
 * For Phase 4 we reuse `generateInstructions()` from `session-start.ts` so
 * the codex agent gets the same role-shaped context (path isolation, bash
 * rules, ib-send guidance, commands table, worker/manager-specific blocks,
 * team-awareness) as the claude agent of the same type. We strip the
 * `<ittybitty>` XML wrapper because codex doesn't recognize it; the rest is
 * portable markdown.
 *
 * Tools that don't exist in codex (Task, ExitPlanMode) are not referenced
 * by the current agent-type templates — they're embedded in Claude's
 * hardcoded fallback paths, not in the worker/manager `.md` bodies. So the
 * template path is safe to reuse verbatim.
 */
export async function buildCodexAgentsMd(ctx: SessionContext): Promise<string> {
  const wrapped = await generateInstructions(ctx);
  // generateInstructions wraps its body in <ittybitty>...</ittybitty>. Codex
  // doesn't read that tag (it's a Claude convention) — strip the outermost
  // wrapper so the markdown reads naturally in codex's session-start context.
  // The body inside may still contain <ittybitty>-related text but the
  // wrapping XML tags are what we drop.
  return stripIttybittyWrapper(wrapped);
}

/**
 * Remove a single outer `<ittybitty>...</ittybitty>` wrapper. If the input
 * doesn't start with the open tag (or doesn't have a matching close tag),
 * returns the input unchanged — Claude-side templating may evolve, but a
 * codex agent's AGENTS.md should never embed an XML tag that codex won't
 * recognize.
 */
export function stripIttybittyWrapper(body: string): string {
  const openTag = "<ittybitty>";
  const closeTag = "</ittybitty>";
  const openIdx = body.indexOf(openTag);
  if (openIdx === -1) return body;
  // Use lastIndexOf so we drop the outer wrapper even if the body contains
  // an inner reference to <ittybitty> (templates do mention the tag in some
  // commentary).
  const closeIdx = body.lastIndexOf(closeTag);
  if (closeIdx === -1 || closeIdx <= openIdx) return body;
  const inner = body.slice(openIdx + openTag.length, closeIdx).trim();
  // Preserve any text before the open tag (rare) and after the close tag
  // (also rare) so we don't accidentally drop trailing team-awareness blocks
  // that were spliced before the close tag.
  const before = body.slice(0, openIdx).trim();
  const after = body.slice(closeIdx + closeTag.length).trim();
  return [before, inner, after].filter((s) => s.length > 0).join("\n\n") + "\n";
}

/**
 * Write the codex AGENTS.md to the agent's worktree. Returns the absolute
 * path written so the caller can log it.
 *
 * The parent directory is created if missing (defensive — the worktree
 * itself should exist by the time this runs, but a stale residual dir
 * could be in flight).
 */
export async function writeCodexAgentsMd(
  worktreePath: string,
  ctx: SessionContext,
): Promise<string> {
  await mkdir(worktreePath, { recursive: true });
  const agentsMdPath = join(worktreePath, "AGENTS.md");
  const body = await buildCodexAgentsMd(ctx);
  await Bun.write(agentsMdPath, body);
  return agentsMdPath;
}
