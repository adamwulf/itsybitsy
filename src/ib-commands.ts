/**
 * Async wrappers for ib mutation commands.
 * Git operations target the agent's repo via `git -C <repoPath>` rather than
 * relying on process-wide cwd; a handful of subprocess calls set `cwd` explicitly.
 * All commands are implemented natively — no ib CLI dependency.
 */

import { join, dirname, resolve, basename } from "path";
import { readdir, chmod, rm, mkdir, rename, stat } from "fs/promises";
import { realpathSync } from "fs";
import { homedir } from "node:os";
import type { Agent, SpawnedBy } from "./agents";
import { writeAgentState, isRecentlyCreated } from "./agents";
import {
  logAgent,
  logSpawn,
  removeAgentQuestions,
  killAgentProcess,
  teardownAgent,
  scanAndKillOrphans,
  getDescendantsRecursive,
  resolveGitRoot,
  archiveAgent,
  captureTmuxOutputToFile,
  isRunningAsAgent,
} from "./agent-lifecycle";
import { readConfig } from "./config";
import { listTmuxSessions } from "./tmux-poller";
import { SpawnContext } from "./types";
import type { SpawnFn } from "./types";
import { isValidModel, isValidToolList, isValidTmuxSession, isValidSessionId, isValidShellPath, isValidAgentId, shellQuote } from "./validation";
import { getTmuxWidthForAgent } from "./tui/widths";
import { buildPerRepoCoordinatorSettings, checkCoordinatorExists, getCoordinatorAgentId, getCoordinatorHome } from "./coordinator";
import { loadAgentType, agentTypeExists } from "./agent-types";
import {
  buildHooksBlock,
  COORDINATOR_INTERCEPT_MATCHER,
  REGULAR_AGENT_INTERCEPT_MATCHER,
} from "./settings-builder";
import { listRepos, repoDisplayName } from "./registry";
import { timed } from "./perf";

export interface IbCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}


/**
 * Write meta.json atomically (write .tmp + rename). Mirrors the pattern in
 * writeAgentState() — used during newAgent() to publish the initial meta.json
 * before slow steps (worktree-add) so the dashboard does not flag the in-progress
 * agent dir as orphaned.
 */
async function writeMetaJsonAtomic(agentDir: string, meta: Record<string, unknown>): Promise<void> {
  const metaPath = join(agentDir, "meta.json");
  const tmpPath = metaPath + ".tmp";
  await Bun.write(tmpPath, JSON.stringify(meta, null, 2) + "\n");
  await rename(tmpPath, metaPath);
}

/** Spawn context for kill/pause operations */
export const killPauseSpawnCtx = new SpawnContext();

/** Override the kill/pause spawn runner (for testing) */
export function setKillPauseSpawnRunner(runner: SpawnFn): void {
  killPauseSpawnCtx.set(runner);
}

/** Reset the kill/pause spawn runner */
export function resetKillPauseSpawnRunner(): void {
  killPauseSpawnCtx.reset();
}

/**
 * Native kill implementation — replaces `ib kill <id> --force`.
 *
 * Sequence (mirrors do_kill in ib bash):
 * 1. Verify agent exists (directory or tmux session)
 * 2. Remove questions from user-questions.json
 * 3. teardownAgent() — log, capture tmux, kill claude, kill tmux, copy settings,
 *    remove worktree, delete branch, archive, remove dir
 * 4. scanAndKillOrphans()
 */
export async function killAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");
  const tmuxSession = agent.meta.tmux_session;

  // Check if agent exists (directory or tmux session)
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  let sessionExists = false;
  if (tmuxSession) {
    try {
      const proc = killPauseSpawnCtx.runner(
        ["tmux", "has-session", "-t", tmuxSession],
        { stdout: "pipe", stderr: "pipe" }
      );
      await new Response(proc.stderr).text(); // drain
      sessionExists = (await proc.exited) === 0;
    } catch { /* ignore */ }
  }

  if (!dirExists && !sessionExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // Remove questions
  await removeAgentQuestions(agent.repoPath, agent.id);

  // Teardown (log, capture, kill process, kill tmux, worktree, branch, archive, remove)
  await teardownAgent(agent.repoPath, agent.id, agentDir, {
    tmux_session: tmuxSession,
    claude_pid: agent.meta.claude_pid,
  }, "Agent killed");

  // Scan for orphaned Claude processes
  await scanAndKillOrphans(agentsDir);

  return { ok: true, exitCode: 0, stdout: `Closed agent: ${agent.id}`, stderr: "" };
}

/** Spawn context for nuke/resume operations */
export const nukeResumeSpawnCtx = new SpawnContext();
/** Override delay for resume tests (null = use real delay) */
let resumeDelayOverrideMs: number | null = null;

/** Override the nuke/resume spawn runner (for testing). Sets delay to 0 by default. */
export function setNukeResumeSpawnRunner(runner: SpawnFn): void {
  nukeResumeSpawnCtx.set(runner);
  resumeDelayOverrideMs = 0;
}

/** Reset the nuke/resume spawn runner */
export function resetNukeResumeSpawnRunner(): void {
  nukeResumeSpawnCtx.reset();
  resumeDelayOverrideMs = null;
}

/**
 * Clean up orphaned tmux sessions — sessions with the ittybitty- prefix
 * that don't correspond to any remaining agent directory.
 */
async function cleanupOrphanedTmuxSessions(agentsDir: string): Promise<number> {
  let cleaned = 0;

  // Build list of remaining agent IDs
  const knownIds: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) knownIds.push(e.name);
    }
  } catch { /* agents dir may not exist */ }

  // List tmux sessions
  const listResult = await nukeResumeSpawnCtx.run(["tmux", "list-sessions", "-F", "#{session_name}"]);
  if (listResult.exitCode !== 0 || !listResult.stdout) return 0;

  const sessions = listResult.stdout.split("\n").filter((s) => s.trim());
  for (const session of sessions) {
    if (!session.startsWith("ittybitty-")) continue;

    // Extract agent ID: strip prefix (ittybitty-<repoid>-<agentid>)
    // The session format is: ittybitty-<8hex>-<agentid>
    // We need to match the agent ID portion against known IDs
    const parts = session.split("-");
    // Session: "ittybitty-<repoid>-agent-<hex>" or "ittybitty-<repoid>-<name>"
    // The repo ID is parts[1], agent ID is everything after "ittybitty-<repoid>-"
    if (parts.length < 3) continue;
    const agentId = parts.slice(2).join("-");

    const isKnown = knownIds.includes(agentId);
    if (!isKnown) {
      const killResult = await nukeResumeSpawnCtx.run(["tmux", "kill-session", "-t", session]);
      if (killResult.exitCode === 0) cleaned++;
    }
  }

  return cleaned;
}

/**
 * Shared teardown loop for nukeAgent and nukeAllAgents.
 * Iterates agent IDs, tears each down, then cleans up orphans.
 */
async function nukeAgentList(
  repoPath: string,
  agentsDir: string,
  agentIds: string[],
): Promise<{ killed: number; failed: number; orphansKilled: number }> {
  let killed = 0;
  let failed = 0;

  for (const id of agentIds) {
    const agentDir = join(agentsDir, id);
    // Skip if directory doesn't exist
    try {
      await readdir(agentDir);
    } catch { /* expected: agent dir already removed */
      continue;
    }

    // Remove questions
    await removeAgentQuestions(repoPath, id);

    // Read meta for teardown
    let meta = { tmux_session: "", claude_pid: "" };
    try {
      const metaData = await Bun.file(join(agentDir, "meta.json")).json();
      meta = {
        tmux_session: metaData.tmux_session || "",
        claude_pid: metaData.claude_pid || "",
      };
    } catch { /* ignore */ }

    // Teardown
    try {
      await teardownAgent(repoPath, id, agentDir, meta, "Agent nuked");
      killed++;
    } catch { /* teardown error — count as failure */
      failed++;
    }
  }

  // Clean up orphaned tmux sessions
  const orphansKilled = await cleanupOrphanedTmuxSessions(agentsDir);

  // Scan for orphaned Claude processes
  if (killed > 0 || orphansKilled > 0) {
    await scanAndKillOrphans(agentsDir);
  }

  return { killed, failed, orphansKilled };
}

/**
 * Native nuke implementation — replaces `ib nuke <id> --force`.
 *
 * Sequence (mirrors do_nuke in ib bash):
 * 1. Check if target is a worker with no children → error
 * 2. Get all descendants via getDescendantsRecursive()
 * 3. For each: removeAgentQuestions() then teardownAgent()
 * 4. Clean up orphaned tmux sessions
 * 5. scanAndKillOrphans()
 */
export async function nukeAgent(agent: Agent): Promise<IbCommandResult> {
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");

  // Get all descendants (includes the agent itself)
  const descendants = await getDescendantsRecursive(agentsDir, agent.id);

  // Check if this is a worker with no children — reject
  if (agent.meta.worker && descendants.length <= 1) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Error: '${agent.id}' is a worker agent with no descendants. Use 'ib kill ${agent.id}' instead.`,
    };
  }

  const { killed, failed, orphansKilled } = await nukeAgentList(agent.repoPath, agentsDir, descendants);

  if (failed > 0 && killed === 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `All ${failed} agent(s) failed to kill` };
  }

  let stdout = `Nuked ${killed} agent(s)`;
  if (orphansKilled > 0) stdout += `, cleaned ${orphansKilled} orphaned session(s)`;
  if (failed > 0) stdout += ` (${failed} failed)`;

  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Native nuke-all implementation — replaces `ib nuke --force`.
 *
 * Kills ALL agents in the agents directory.
 */
export async function nukeAllAgents(repoPath: string): Promise<IbCommandResult> {
  const agentsDir = join(repoPath, ".ittybitty", "agents");

  // Collect all agents with meta.json
  const agentsToKill: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaExists = await Bun.file(join(agentsDir, e.name, "meta.json")).exists().catch(() => false);
      if (metaExists) agentsToKill.push(e.name);
    }
  } catch { /* agents dir may not exist */ }

  const { killed, failed, orphansKilled } = await nukeAgentList(repoPath, agentsDir, agentsToKill);

  if (failed > 0 && killed === 0 && agentsToKill.length > 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `All ${failed} agent(s) failed to kill` };
  }

  let stdout = `Nuked ${killed} agent(s)`;
  if (orphansKilled > 0) stdout += `, cleaned ${orphansKilled} orphaned session(s)`;
  if (failed > 0) stdout += ` (${failed} failed)`;

  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Reset (kill + respawn) a per-repo coordinator.
 *
 * Tears down the existing coordinator and immediately spawns a fresh one.
 * The new coordinator's settings.local.json is rebuilt from current sources
 * (hardcoded constants + _all.md + coordinator.md), so any edits to those
 * files are picked up. Hooks block is rebuilt fresh too. Agent ID stays the
 * same (it's keyed to the repo basename).
 *
 * Caller must have already verified `agent.meta.agentType === "coordinator"`.
 */
async function resetCoordinator(agent: Agent): Promise<IbCommandResult> {
  // Tear down the existing coordinator: kill tmux session, claude process,
  // watchdog, and remove the agent dir. nukeAgent recurses through descendants,
  // so any workers the coordinator has spawned will be torn down too — that is
  // intentional. A coordinator reset abandons its in-flight work; the new
  // coordinator starts with a clean slate and no inherited child agents.
  const nukeResult = await nukeAgent(agent);
  if (!nukeResult.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Reset failed during teardown: ${nukeResult.stderr || nukeResult.stdout}` };
  }

  // Spawn a fresh coordinator. newAgent's coordinator path generates the
  // agent ID from the repo basename, so it lands at the same ID we just
  // tore down.
  const spawnResult = await newAgent(
    agent.repoPath,
    "You are the per-repo coordinator. Await instructions.",
    { type: "coordinator" },
  );
  if (!spawnResult.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Reset failed during respawn: ${spawnResult.stderr || spawnResult.stdout}` };
  }

  return { ok: true, exitCode: 0, stdout: `Reset coordinator ${agent.id}`, stderr: "" };
}

/**
 * Native resume implementation — replaces `ib resume <id>`.
 *
 * Resume eligibility is determined by tmux liveness, NOT by `meta.state`.
 * Pre-Phase-42 paused agents may have a stale state like "complete" that
 * the old pause path never overwrote; trusting `meta.state` would refuse to
 * resume those stuck agents forever. Checking tmux directly lets them
 * self-heal: if no live tmux session exists, resume proceeds.
 *
 * Refusal cases:
 * - tmux session is alive — resuming would clobber a running agent.
 * - agent is in the 6s creating-grace-period with no tmux yet — don't race
 *   with the spawn pipeline.
 *
 * Sequence (mirrors cmd_resume in ib bash):
 * 1. Read session_id, model from meta.json
 * 2. Check yolo mode from start.sh
 * 3. Create resume.sh script
 * 4. Determine work dir
 * 5. Start tmux session
 * 6. Auto-accept workspace trust if not yolo
 * 7. Send resume nudge
 * 8. Log result
 * 9. Auto-spawn per-agent watchdog
 */
export async function resumeAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);

  // Check agent directory exists
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // Per-repo coordinators: R triggers a full reset rather than a session resume.
  // The coordinator's settings.local.json is assembled from three sources at
  // spawn time (hardcoded constants, _all.md, coordinator.md), and its hooks
  // template is rebuilt then. Resuming the existing session would reuse stale
  // permissions and hooks, so we tear the coordinator down and respawn it
  // — fresher, simpler, and matches the user's mental model of "R to reset".
  if (agent.meta.agentType === "coordinator") {
    return await resetCoordinator(agent);
  }

  // Resume is allowed when no live tmux session exists for the agent. We don't
  // trust meta.state here because legacy paused agents (pre-Phase 42) may have a
  // stale state like "complete" or "waiting" that pause never overwrote. Checking
  // tmux directly lets those stuck agents self-heal.
  //
  // Two refusal cases:
  // 1. tmux session is alive — agent is running, resuming would clobber it.
  // 2. agent is in the 6s creating-grace-period and hasn't started tmux yet —
  //    don't race with the spawn pipeline.
  const tmuxSessionForGuard = agent.meta.tmux_session;
  if (tmuxSessionForGuard) {
    if (!isValidTmuxSession(tmuxSessionForGuard)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid tmux session name: ${tmuxSessionForGuard}` };
    }
    const hasSession = await nukeResumeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSessionForGuard]);
    if (hasSession.exitCode === 0) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has a live tmux session ('${tmuxSessionForGuard}') — refuse to resume a running agent` };
    }
  } else if (isRecentlyCreated(agent.meta.created_epoch)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is still being created — wait for spawn to complete before resuming` };
  }

  // Read session_id from meta.json
  const sessionId = agent.meta.session_id;
  if (!sessionId || sessionId === "null") {
    return { ok: false, exitCode: 1, stdout: "", stderr: "No session_id found in meta.json" };
  }

  // Validate session_id before shell interpolation
  if (!isValidSessionId(sessionId)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid session ID: ${sessionId}` };
  }

  // Read model
  const model = agent.meta.model && agent.meta.model !== "null" ? agent.meta.model : "";

  // Validate model if present
  if (model && !isValidModel(model)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid model name: ${model}` };
  }

  // Tmux session was validated at the top of resumeAgent (liveness guard).
  const tmuxSession = agent.meta.tmux_session;

  // Detect yolo mode from start.sh
  let yoloMode = false;
  try {
    const startSh = await Bun.file(join(agentDir, "start.sh")).text();
    if (startSh.includes("dangerously-skip-permissions")) {
      yoloMode = true;
    }
  } catch { /* start.sh may not exist */ }

  // Build claude args
  let claudeArgs = "";
  if (yoloMode) {
    claudeArgs = "--dangerously-skip-permissions --permission-mode bypassPermissions";
  }
  if (model) {
    claudeArgs = claudeArgs ? `${claudeArgs} --model ${model}` : `--model ${model}`;
  }

  // Note: per-repo coordinators never reach this point — the early branch at
  // the top of resumeAgent routes them to resetCoordinator instead. So no
  // need to re-thread --settings to the (no-longer-relevant) saved coordinator
  // settings file here.

  // Validate paths for shell script interpolation
  if (!isValidShellPath(agentDir)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent directory path contains characters unsafe for shell scripts: ${agentDir}` };
  }

  // Determine work dir
  const repoDir = join(agentDir, "repo");
  let workPath = repoDir;
  try {
    await readdir(repoDir);
  } catch {
    workPath = agent.repoPath;
  }

  // Build exit script path
  const absExitScript = join(agentDir, "exit-check.sh");

  // Shell-quote all paths for safe interpolation
  const qAgentDir = shellQuote(agentDir);
  const qAbsExitScript = shellQuote(absExitScript);

  // Write resume.sh
  const resumeScript = join(agentDir, "resume.sh");
  const qMetaJson = shellQuote(join(agentDir, "meta.json"));
  const qAgentLog = shellQuote(join(agentDir, "agent.log"));
  const qResumeStderrLog = shellQuote(join(agentDir, "claude.stderr.log"));
  const resumeContent = `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qAgentLog}
STDERR_LOG=${qResumeStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resume.sh] $1" >> "$AGENT_LOG"; }

log "Starting claude --resume ${sessionId} ${claudeArgs}"
log "PWD=$(pwd) which_claude=$(which claude 2>&1)"

# Start Claude in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
: > "$STDERR_LOG"
claude --resume "${sessionId}" ${claudeArgs} 2> "$STDERR_LOG" &
CLAUDE_PID=$!
log "Claude PID: $CLAUDE_PID"
trap 'log "script received SIGHUP — tmux pane killed or closed; sending SIGTERM to Claude PID=$CLAUDE_PID"; log "── SIGHUP diagnostics ──"; log "self ps: $(ps -o pid,ppid,pgid,sess,stat,command -p $$ 2>&1 | paste -sd "|" -)"; log "parent ps: $(ps -o pid,ppid,pgid,sess,stat,command -p $PPID 2>&1 | paste -sd "|" -)"; log "tmux processes: $(pgrep -lf tmux 2>&1 | head -20 | paste -sd "|" -)"; log "tmux list-sessions: $(tmux list-sessions 2>&1 | head -20 | paste -sd "|" -)"; log "── end SIGHUP diagnostics ──"; kill $CLAUDE_PID 2>/dev/null' HUP
trap 'log "script received SIGTERM; sending SIGTERM to Claude PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Claude PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json
META_JSON=${qMetaJson}
if [[ -f "$META_JSON" ]]; then
    bun -e "const f=process.argv[1];const m=JSON.parse(require('fs').readFileSync(f,'utf8'));m.claude_pid=String(process.argv[2]);require('fs').writeFileSync(f,JSON.stringify(m,null,2))" "$META_JSON" "$CLAUDE_PID"
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
${qAbsExitScript}
`;
  await Bun.write(resumeScript, resumeContent);
  await chmod(resumeScript, 0o755);

  // Ensure tmux server is running
  const startServerResult = await nukeResumeSpawnCtx.run(["tmux", "start-server"]);
  if (startServerResult.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Could not start tmux server" };
  }

  await logAgent(agentDir, `[resume] Creating tmux session '${tmuxSession}' in ${workPath}`);

  // Start tmux session — use saved layout width so it matches the dashboard pane.
  // Per-repo coordinators are routed to resetCoordinator earlier (see line 382),
  // so only non-coordinator agents reach here — pass false for clarity. Route
  // through getTmuxWidthForAgent so all agent-tmux sizing flows through one helper.
  const resumeTmuxWidth = await getTmuxWidthForAgent(false);
  const tmuxResult = await nukeResumeSpawnCtx.run([
    "tmux", "new-session", "-d", "-x", String(resumeTmuxWidth), "-s", tmuxSession, "-c", workPath, shellQuote(resumeScript),
  ]);
  if (tmuxResult.exitCode !== 0) {
    await logAgent(agentDir, `[resume] tmux new-session failed: exit=${tmuxResult.exitCode} stderr=${tmuxResult.stderr}`);
    return { ok: false, exitCode: 1, stdout: "", stderr: `Could not create tmux session '${tmuxSession}'` };
  }
  await nukeResumeSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "history-limit", "50000"]);
  await nukeResumeSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "remain-on-exit", "on"]);
  // window-size manual prevents tmux from auto-resizing the window to the
  // latest attached client's terminal size. The dashboard sizes the session
  // to the saved pane width; the default ("latest") would silently shrink
  // it back when other clients attach/detach.
  await nukeResumeSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "window-size", "manual"]);
  // pane-died hook fires on every pane termination (graceful or otherwise)
  // as a backstop for the case where resume.sh itself dies before reaching
  // its exit-log line. See the new-agent path for the matching comment.
  const resumePaneDiedHook = `run-shell "echo '[tmux pane-died] session=#{session_name} pane_dead_status=#{pane_dead_status} pane_dead_signal=#{pane_dead_signal}' >> ${shellQuote(join(agentDir, "agent.log"))}"`;
  await nukeResumeSpawnCtx.run(["tmux", "set-hook", "-t", tmuxSession, "pane-died", resumePaneDiedHook]);

  await logAgent(agentDir, "[resume] tmux session created, running autoAcceptWorkspaceTrust");

  // Auto-accept workspace trust if not yolo (poll tmux for trust prompts)
  // Must complete before sending nudge to avoid corrupting the permissions flow
  if (!yoloMode) {
    await autoAcceptWorkspaceTrust(tmuxSession);
  }

  await logAgent(agentDir, "[resume] autoAcceptWorkspaceTrust completed, sending nudge");

  // Verify tmux session still exists before sending nudge
  const verifyResult = await nukeResumeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
  if (verifyResult.exitCode !== 0) {
    await logAgent(agentDir, "[resume] tmux session gone before nudge — Claude likely exited immediately");
    return { ok: true, exitCode: 0, stdout: `Use 'ib look ${agent.id}' to view output`, stderr: "" };
  }

  // Send resume nudge after short delay
  const nudgeDelayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 100;
  if (nudgeDelayMs > 0) await Bun.sleep(nudgeDelayMs);

  const nudgePrompt = "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line.";
  await nukeResumeSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "-l", nudgePrompt]);

  const nudgeSleepMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 100;
  if (nudgeSleepMs > 0) await Bun.sleep(nudgeSleepMs);

  await nukeResumeSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

  // Log
  await logAgent(agentDir, "[resume] Agent resumed, nudge sent");

  // Write state: "running" to meta.json
  await writeAgentState(agentDir, "running");

  // Note: a freshly-resumed agent whose prior transcript already exceeds
  // `autoCompactThreshold` won't receive `/compact` on the per-agent watchdog's
  // first tick because `createTracker()` initializes `lastCompactCheckMs` to
  // `nowFn()`, giving every new tracker a `COMPACT_CHECK_COOLDOWN_MS` grace
  // period before the first eligibility check.

  // Auto-spawn per-agent watchdog
  try {
    const watchdogLog = join(agentDir, "watchdog.log");
    let watchdogPid: number | undefined;

    if (watchdogSpawnOverride) {
      const result = watchdogSpawnOverride(agent.id, agent.repoPath, watchdogLog);
      watchdogPid = result?.pid;
    } else {
      const watchdogProc = Bun.spawn(["ib", "watchdog", agent.id], {
        cwd: agent.repoPath,
        stdout: Bun.file(watchdogLog),
        stderr: Bun.file(watchdogLog),
      });
      watchdogProc.unref();
      watchdogPid = watchdogProc.pid;
    }

    if (watchdogPid !== undefined) {
      const metaPath = join(agentDir, "meta.json");
      const metaContent = await Bun.file(metaPath).json().catch(() => null);
      if (metaContent) {
        metaContent.watchdog_pid = watchdogPid;
        await Bun.write(metaPath, JSON.stringify(metaContent, null, 2));
      }
    }
  } catch { /* ignore */ }

  return { ok: true, exitCode: 0, stdout: `Use 'ib look ${agent.id}' to view output`, stderr: "" };
}

/** Override the respawn detach runner (for testing) */
let respawnDetachOverride: ((agent: Agent) => Promise<void>) | null = null;

/** Override for testing — sets a synchronous in-process executor instead of detaching */
export function setRespawnDetachRunner(fn: (agent: Agent) => Promise<void>): void {
  respawnDetachOverride = fn;
}

/** Reset the respawn detach runner */
export function resetRespawnDetachRunner(): void {
  respawnDetachOverride = null;
}

/**
 * Native respawn implementation — used by the `/respawn` and `/restart`
 * slash commands.
 *
 * The agent runs `ib respawn` from inside its own Claude session. We CAN'T
 * do the kill-and-restart inline because killing this agent's tmux session
 * would kill the very process executing the command. Instead we launch a
 * detached worker — a fresh, untracked tmux session that runs
 * `ib respawn-self <id>`. That worker survives the agent's session being
 * torn down, performs the kill-and-restart, then exits.
 *
 * For coordinators: the worker calls the existing reset path (full nuke +
 * `newAgent` with `type: "coordinator"`). The new coordinator's
 * `settings.local.json` is rebuilt from current sources (hardcoded constants
 * + `_all.md` + `coordinator.md`), so edits to those files take effect.
 *
 * For non-coordinator agents: the worker calls `pauseAgent` (which kills
 * the existing claude process and tmux session) then `resumeAgent` (which
 * starts a fresh `claude --resume <session-id>` in the same worktree).
 * SessionStart fires on the resumed session and re-reads the current
 * agent-type `.md` body, so edits to `worker.md`, `manager.md`, etc. take
 * effect.
 *
 * For `@system` (system coordinator): the worker calls
 * `restartSystemCoordinator()`. This is rare — the system coordinator can
 * already be restarted from the dashboard `R` key — but supporting it from
 * the slash command keeps the UX uniform.
 */
export async function respawnAgent(agent: Agent): Promise<IbCommandResult> {
  // Confirm the agent's directory still exists; respawning a stale ID is a
  // common mistake and returning a clear error beats a hanging detached
  // worker.
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  await logAgent(agentDir, "[respawn] scheduling detached restart");

  // Test override path: tests want to drive respawnSelf synchronously to
  // observe the kill-and-restart steps without spawning a real subprocess.
  if (respawnDetachOverride) {
    await respawnDetachOverride(agent);
    return { ok: true, exitCode: 0, stdout: `Respawn scheduled for ${agent.id}`, stderr: "" };
  }

  // Validate the agent ID before interpolating it into a shell command.
  // `isValidAgentId` accepts alphanumeric + hyphens + underscores, which is
  // a subset of safe shell tokens — no quoting needed below.
  if (!isValidAgentId(agent.id)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid agent ID: ${agent.id}` };
  }

  // Spawn a detached worker by asking tmux to start a fresh, untracked
  // session. The worker runs `ib respawn-self <id>` and inherits no file
  // descriptors from the agent's tmux pane, so when the agent's session is
  // killed the worker is untouched. A short sleep before the actual work
  // gives this Claude turn time to finish rendering its tool result so the
  // user sees the "scheduled" message before the pane disappears.
  //
  // We name the detached session deterministically (`ib-respawn-<id>`) so a
  // stuck worker is easy to find. `-d` keeps it backgrounded; the worker
  // exits when the shell command completes.
  const detachSession = `ib-respawn-${agent.id}`;
  const command = `sleep 1; ib respawn-self ${agent.id}`;
  const result = await nukeResumeSpawnCtx.run([
    "tmux", "new-session", "-d", "-s", detachSession, command,
  ]);
  if (result.exitCode !== 0) {
    await logAgent(agentDir, `[respawn] failed to launch detached worker: ${result.stderr.trim()}`);
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to schedule respawn: ${result.stderr.trim() || "tmux new-session failed"}` };
  }

  // remain-on-exit off so the detached session disappears the moment the
  // worker exits — no zombie session cluttering `tmux ls`.
  await nukeResumeSpawnCtx.run([
    "tmux", "set-option", "-t", detachSession, "remain-on-exit", "off",
  ]);

  return {
    ok: true,
    exitCode: 0,
    stdout: `Respawn scheduled for ${agent.id} — this session will exit shortly`,
    stderr: "",
  };
}

/**
 * The "worker half" of respawn — runs in a detached tmux session spawned
 * by `respawnAgent`. Performs the actual kill-and-restart so it survives
 * its own target's tmux session being torn down.
 *
 * For coordinators, delegates to `resetCoordinator`. For non-coordinator
 * agents, pauses then resumes — `resumeAgent` re-execs `claude --resume`
 * which re-fires the SessionStart hook so the latest agent-type `.md`
 * content is injected into the new conversation.
 */
export async function respawnSelf(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);

  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  await logAgent(agentDir, "[respawn-self] starting kill-and-restart");

  // Per-repo coordinator: full reset. resetCoordinator() handles teardown
  // and respawn via newAgent, which rebuilds settings.local.json from
  // current `_all.md` + `coordinator.md` sources.
  if (agent.meta.agentType === "coordinator") {
    const result = await resetCoordinator(agent);
    await logAgent(agentDir, `[respawn-self] coordinator reset complete: ${result.ok ? "ok" : "failed: " + result.stderr}`);
    if (result.ok) {
      // Telegram ack so a user who triggered /respawn from their phone sees
      // confirmation. Writes to the outbox; the dispatcher running in
      // `ib watch` picks it up and forwards. No-op if Telegram isn't
      // configured. We await it so the file write completes before the
      // detached `respawn-self` worker exits — telegramSend caps at ~1s.
      //
      // The ack lives here (in respawnSelf, the detached `/respawn` worker)
      // rather than in resetCoordinator so the dashboard `R` key — which
      // calls resetCoordinator directly via resumeAgent — does NOT trigger
      // a Telegram ping. A user pressing R is already looking at the
      // dashboard and doesn't need the notification.
      try {
        await telegramSend("Coordinator has been respawned with a clean session.");
      } catch (err) {
        await logAgent(agentDir, `[respawn-self] telegram ack failed: ${err}`);
      }
    }
    return result;
  }

  // Non-coordinator agent: pause (kills tmux + claude) then resume (starts
  // fresh claude --resume in the same worktree, re-firing SessionStart).
  //
  // pauseAgent rejects already-stopped agents. That's fine — if a previous
  // respawn attempt failed mid-flight and left the agent stopped, we fall
  // through to resumeAgent directly.
  if (agent.state !== "stopped") {
    const pauseResult = await pauseAgent(agent);
    if (!pauseResult.ok) {
      await logAgent(agentDir, `[respawn-self] pause failed: ${pauseResult.stderr}`);
      return { ok: false, exitCode: 1, stdout: "", stderr: `Respawn pause failed: ${pauseResult.stderr}` };
    }
  } else {
    await logAgent(agentDir, "[respawn-self] agent already stopped, skipping pause");
  }

  const resumeResult = await resumeAgent(agent);
  if (!resumeResult.ok) {
    await logAgent(agentDir, `[respawn-self] resume failed: ${resumeResult.stderr}`);
    return { ok: false, exitCode: 1, stdout: "", stderr: `Respawn resume failed: ${resumeResult.stderr}` };
  }

  await logAgent(agentDir, "[respawn-self] respawn complete");
  return { ok: true, exitCode: 0, stdout: `Respawned ${agent.id}`, stderr: "" };
}

/**
 * Auto-accept workspace trust dialog by polling tmux output.
 * Mirrors auto_accept_workspace_trust in ib bash.
 * Runs asynchronously — does not block the caller.
 */
async function autoAcceptWorkspaceTrust(tmuxSession: string): Promise<void> {
  const maxAttempts = 5;
  const maxWaitHalfSecs = 30; // 15 seconds total for initial wait

  // Wait for Claude to start (logo or permissions screen)
  let startedWith = "";
  for (let i = 0; i < maxWaitHalfSecs; i++) {
    const delayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 500;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await nukeResumeSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const output = captureResult.stdout;
    // Check for logo or [USER TASK]
    if (output.includes("Claude Code v") || output.includes("[USER TASK]")) {
      startedWith = "logo";
      break;
    }
    // Check for permissions screens (workspace trust, external imports, MCP servers)
    if (/enter to confirm/i.test(output)) {
      if (
        /trust/i.test(output) ||
        /Allow external CLAUDE\.md file imports/i.test(output) ||
        /New MCP server found/i.test(output) ||
        /\d+ new MCP servers? found/i.test(output)
      ) {
        startedWith = "permissions";
        break;
      }
    }
  }

  // If logo appeared directly, no permissions needed
  if (startedWith !== "permissions") return;

  // Accept permissions (may need multiple Enter presses)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await nukeResumeSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

    const delayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 4000;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await nukeResumeSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const recent = captureResult.stdout;

    // Check if permissions prompt is still active
    let hasPermissions = false;
    if (/enter to confirm/i.test(recent)) {
      if (
        /trust/i.test(recent) ||
        /Allow external CLAUDE\.md file imports/i.test(recent) ||
        /New MCP server found/i.test(recent) ||
        /\d+ new MCP servers? found/i.test(recent)
      ) {
        hasPermissions = true;
      }
    }

    if (!hasPermissions) {
      // Wait for logo to confirm success
      for (let j = 0; j < maxWaitHalfSecs; j++) {
        const logoDelay = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 500;
        if (logoDelay > 0) await Bun.sleep(logoDelay);

        const logoCapture = await nukeResumeSpawnCtx.run([
          "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
        ]);
        if (logoCapture.exitCode !== 0) continue;
        if (logoCapture.stdout.includes("Claude Code v") || logoCapture.stdout.includes("[USER TASK]")) {
          return; // Success
        }
      }
    }
  }
}

/**
 * Native reassign implementation — replaces `ib reassign <id> <new-manager>`.
 *
 * 1. Read agent's meta.json to get old manager
 * 2. If newManager is null: clear manager field
 * 3. If newManager provided: validate exists, not worker, not circular
 * 4. Update agent's meta.json
 * 5. Log the change
 * 6. Send notifications (skip if tmux session doesn't exist)
 */
export async function reassignAgent(agent: Agent, newManager: string | null): Promise<IbCommandResult> {
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");
  const agentDir = join(agentsDir, agent.id);
  const metaPath = join(agentDir, "meta.json");

  // Self-reassign check (before reading meta — just compare IDs)
  if (newManager === agent.id) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Cannot reassign agent to itself" };
  }

  // Read agent's meta.json
  let meta: Record<string, unknown>;
  try {
    const file = Bun.file(metaPath);
    if (!(await file.exists())) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
    }
    meta = await file.json();
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read meta.json for '${agent.id}'` };
  }

  const oldManager = (meta.manager as string | null) ?? "";

  // Same-parent check: no-op if already has the requested parent
  const oldManagerNorm = oldManager || null;
  const newManagerNorm = newManager || null;
  if (oldManagerNorm === newManagerNorm) {
    if (newManager) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "Agent already has this manager" };
    }
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent is already top-level" };
  }

  if (newManager !== null) {
    // Validate new parent exists
    const newManagerMetaPath = join(agentsDir, newManager, "meta.json");
    try {
      const file = Bun.file(newManagerMetaPath);
      if (!(await file.exists())) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `New manager '${newManager}' not found` };
      }
      const parentMeta = await file.json();
      // Validate not a worker
      if (parentMeta.worker) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Cannot reassign to worker agent '${newManager}'` };
      }
    } catch {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read meta.json for '${newManager}'` };
    }

    // Check circular: newManager must not be a descendant of agent
    const descendants = await getDescendantsRecursive(agentsDir, agent.id);
    if (descendants.includes(newManager)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Circular dependency: '${newManager}' is a descendant of '${agent.id}'` };
    }
  }

  // Update meta.json
  meta.manager = newManager ?? null;
  try {
    await Bun.write(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch (err) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to write meta.json: ${err}` };
  }

  // Log change
  const newLabel = newManager ?? "(none)";
  const oldLabel = oldManager || "(none)";
  await logAgent(agentDir, `Reassigned from ${oldLabel} to ${newLabel}`);

  // Send notifications (skip if tmux session doesn't exist)
  const notifyAgent = async (targetId: string, msg: string) => {
    const targetMetaPath = join(agentsDir, targetId, "meta.json");
    try {
      const file = Bun.file(targetMetaPath);
      if (!(await file.exists())) return;
      const targetMeta = await file.json();
      if (!targetMeta.tmux_session) return;
      // Use sendMessage for notification — construct a minimal Agent-like object
      const targetAgent: Agent = {
        id: targetId,
        repoPath: agent.repoPath,
        repoName: agent.repoName,
        meta: targetMeta as Agent["meta"],
        state: "running",
        age: "",
        archived: false,
        children: [],
      };
      await sendMessage(targetAgent, msg, { fromAgent: agent.id });
    } catch { /* skip notification errors */ }
  };

  // Notify old parent
  if (oldManager) {
    const toLabel = newManager ? `to manager '${newManager}'` : "to top-level";
    await notifyAgent(oldManager, `[watchdog for ${agent.id}]: Agent reassigned ${toLabel}`);
  }
  // Notify new parent
  if (newManager) {
    const fromLabel = oldManager ? `was under ${oldManager}` : "was top-level";
    await notifyAgent(newManager, `[watchdog for ${agent.id}]: Agent reassigned to you (${fromLabel})`);
  }
  // Notify the agent itself
  await notifyAgent(agent.id, `[watchdog]: You've been reassigned from ${oldLabel} to ${newLabel}`);

  return {
    ok: true,
    exitCode: 0,
    stdout: `Reassigned ${agent.id} from ${oldLabel} to ${newLabel}`,
    stderr: "",
  };
}

/**
 * Native merge-check implementation — replaces `ib merge-check <id>`.
 *
 * 1. Check worktree directory exists
 * 2. Check no uncommitted changes in worktree
 * 3. Check main branch exists
 * 4. Check agent branch exists
 * 5. Run checkRebaseConflicts for conflict detection
 */
export async function mergeCheckAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const worktreePath = join(agentDir, "repo");
  const branchName = `agent/${agent.id}`;

  // 1. Check worktree exists + no uncommitted changes
  const worktreeCheck = await timed("merge-check", "worktree-check", async () => {
    try {
      await readdir(worktreePath);
    } catch {
      return { ok: false as const, stderr: `Agent '${agent.id}' has no worktree` };
    }
    const worktreeStatus = await mergeSpawnCtx.run(["git", "-C", worktreePath, "status", "--porcelain"]);
    if (worktreeStatus.exitCode === 0 && worktreeStatus.stdout.trim()) {
      return { ok: false as const, stderr: `Agent '${agent.id}' has uncommitted changes` };
    }
    return { ok: true as const };
  });
  if (!worktreeCheck.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: worktreeCheck.stderr };
  }

  // 2. Check main + agent branches exist
  const branchCheck = await timed("merge-check", "branch-resolve", async () => {
    const mainRef = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "show-ref", "--verify", "refs/heads/main"]);
    if (mainRef.exitCode !== 0) {
      return { ok: false as const, stderr: "Main branch not found" };
    }
    const branchRef = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "show-ref", "--verify", `refs/heads/${branchName}`]);
    if (branchRef.exitCode !== 0) {
      return { ok: false as const, stderr: `Branch '${branchName}' does not exist` };
    }
    return { ok: true as const };
  });
  if (!branchCheck.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: branchCheck.stderr };
  }

  // 3. Pre-rebase conflict check
  const conflictResult = await timed("merge-check", "conflict-detect", () =>
    checkRebaseConflicts(agent.repoPath, "main", branchName)
  );
  if (!conflictResult.ok) {
    return {
      ok: false, exitCode: 1, stdout: "",
      stderr: `Rebase conflict detected between '${branchName}' and 'main'`,
    };
  }

  // 4. Count commits
  const commitCount = await timed("merge-check", "commit-count", async () => {
    const logResult = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "log", `main..${branchName}`, "--oneline"]);
    return logResult.stdout.trim() ? logResult.stdout.trim().split("\n").length : 0;
  });

  return {
    ok: true, exitCode: 0,
    stdout: `Merge check passed: ${commitCount} commit(s), no conflicts, no uncommitted changes`,
    stderr: "",
  };
}

/** Pluggable spawn runner for merge — defaults to Bun.spawn, overridable for tests */
/** Spawn context for merge operations */
export const mergeSpawnCtx = new SpawnContext();

/** Override the merge spawn runner (for testing) */
export function setMergeSpawnRunner(runner: SpawnFn): void {
  mergeSpawnCtx.set(runner);
}

/** Reset the merge spawn runner */
export function resetMergeSpawnRunner(): void {
  mergeSpawnCtx.reset();
}

/**
 * Pre-rebase conflict check: creates a temp branch/worktree, attempts rebase,
 * and cleans up. Returns { ok: true } if no conflicts, { ok: false, output } if conflicts.
 * Mirrors check_rebase_conflicts() in ib bash.
 */
async function checkRebaseConflicts(
  repoPath: string,
  targetBranch: string,
  sourceBranch: string
): Promise<{ ok: boolean; output: string }> {
  const tempBranch = `temp-rebase-check-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const tempDir = `/tmp/ib-rebase-check-${tempBranch}`;

  // Create temp branch from source
  const createBranch = await mergeSpawnCtx.run(["git", "-C", repoPath, "branch", tempBranch, sourceBranch]);
  if (createBranch.exitCode !== 0) {
    return { ok: false, output: "Could not create temp branch for conflict check" };
  }

  // Create temp worktree
  const createWorktree = await mergeSpawnCtx.run(["git", "-C", repoPath, "worktree", "add", tempDir, tempBranch, "--quiet"]);
  if (createWorktree.exitCode !== 0) {
    await mergeSpawnCtx.run(["git", "-C", repoPath, "branch", "-D", tempBranch]);
    return { ok: false, output: "Could not create temp worktree for conflict check" };
  }

  // Attempt rebase in temp worktree
  const rebaseResult = await mergeSpawnCtx.run(["git", "-C", tempDir, "rebase", targetBranch]);
  let result: { ok: boolean; output: string };

  if (rebaseResult.exitCode !== 0) {
    // Abort the failed rebase
    await mergeSpawnCtx.run(["git", "-C", tempDir, "rebase", "--abort"]);
    result = { ok: false, output: rebaseResult.stdout };
  } else {
    result = { ok: true, output: "" };
  }

  // Clean up: remove temp worktree and branch (with rm -rf fallback)
  const worktreeRemove = await mergeSpawnCtx.run(["git", "-C", repoPath, "worktree", "remove", tempDir, "--force"]);
  if (worktreeRemove.exitCode !== 0) {
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  await mergeSpawnCtx.run(["git", "-C", repoPath, "branch", "-D", tempBranch]);

  return result;
}

/**
 * Native merge implementation — replaces `ib merge <id> --force`.
 *
 * Sequence (mirrors cmd_merge + do_merge in ib bash):
 * 1. Verify agent directory exists
 * 2. Verify worktree exists
 * 3. Check worktree has no uncommitted changes
 * 4. Detect target branch (current branch → main → master → error)
 * 5. Verify agent branch exists
 * 6. Check current dir has no uncommitted changes
 * 7. Pre-rebase conflict check
 * 8. Rebase agent branch onto target
 * 9. Checkout target branch
 * 10. Merge (ff-only if agent, --no-ff if user)
 * 11. Capture tmux output
 * 12. Kill Claude process
 * 13. Kill tmux session
 * 14. Copy settings.local.json from worktree
 * 15. Remove worktree
 * 16. Delete branch
 * 17. Archive artifacts
 * 18. Remove questions
 * 19. Remove agent directory
 * 20. Scan for orphaned processes
 */
export async function mergeAgent(agent: Agent, targetDir: string): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");
  const branchName = `agent/${agent.id}`;
  const worktreePath = join(agentDir, "repo");
  const tmuxSession = agent.meta.tmux_session;

  // 1-6. Preflight: agent dir, worktree, statuses, target branch, branch existence
  const preflight = await timed("merge", "preflight", async () => {
    // 1. Agent dir must exist
    const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
    if (!dirExists) {
      return { ok: false as const, stderr: `Agent '${agent.id}' not found` };
    }

    // 2. Agent must have a worktree
    try {
      await readdir(worktreePath);
    } catch {
      return { ok: false as const, stderr: `Agent '${agent.id}' has no worktree (was created with --no-worktree?)` };
    }

    // 2b. Cannot merge from within the agent's own worktree
    const currentDir = process.cwd();
    if (currentDir.startsWith(worktreePath)) {
      return { ok: false as const, stderr: "Cannot merge agent from within its own worktree" };
    }

    // 3. Agent worktree must have no uncommitted changes
    const worktreeStatus = await mergeSpawnCtx.run(["git", "-C", worktreePath, "status", "--porcelain"]);
    if (worktreeStatus.exitCode === 0 && worktreeStatus.stdout.trim()) {
      return { ok: false as const, stderr: `Agent '${agent.id}' has uncommitted changes` };
    }

    // 4. Detect target branch from targetDir
    let targetBranch = "";
    const currentBranch = await mergeSpawnCtx.run(["git", "-C", targetDir, "branch", "--show-current"]);
    if (currentBranch.exitCode === 0 && currentBranch.stdout.trim()) {
      targetBranch = currentBranch.stdout.trim();
    }
    if (!targetBranch) {
      const mainRef = await mergeSpawnCtx.run(["git", "show-ref", "--verify", "refs/heads/main"]);
      if (mainRef.exitCode === 0) {
        targetBranch = "main";
      } else {
        const masterRef = await mergeSpawnCtx.run(["git", "show-ref", "--verify", "refs/heads/master"]);
        if (masterRef.exitCode === 0) {
          targetBranch = "master";
        } else {
          return { ok: false as const, stderr: "Could not determine target branch (detached HEAD with no main/master)" };
        }
      }
    }

    // 5. Agent branch must exist
    const branchRef = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "show-ref", "--verify", `refs/heads/${branchName}`]);
    if (branchRef.exitCode !== 0) {
      return { ok: false as const, stderr: `Branch '${branchName}' does not exist` };
    }

    // 6. Target directory must have no uncommitted changes
    const repoStatus = await mergeSpawnCtx.run(["git", "-C", targetDir, "status", "--porcelain"]);
    if (repoStatus.exitCode === 0 && repoStatus.stdout.trim()) {
      return { ok: false as const, stderr: "Target directory has uncommitted changes" };
    }

    return { ok: true as const, targetBranch };
  });
  if (!preflight.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: preflight.stderr };
  }
  const targetBranch = preflight.targetBranch;

  // 7. Pre-rebase conflict check
  const conflictResult = await timed("merge", "conflict-check", () =>
    checkRebaseConflicts(agent.repoPath, targetBranch, branchName)
  );
  if (!conflictResult.ok) {
    await logAgent(agentDir, `Pre-rebase conflict check failed - conflicts detected with ${targetBranch}`);
    return {
      ok: false, exitCode: 1, stdout: "",
      stderr: `Rebase conflict detected between '${branchName}' and '${targetBranch}'`,
    };
  }

  // Count commits to merge
  const logResult = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "log", `${targetBranch}..${branchName}`, "--oneline"]);
  const commitCount = logResult.stdout.trim() ? logResult.stdout.trim().split("\n").length : 0;

  await logAgent(agentDir, `Starting rebase of ${branchName} onto ${targetBranch} (${commitCount} commits)`);

  if (commitCount > 0) {
    // 8. Rebase agent branch onto target (in agent's worktree)
    const rebaseOk = await timed("merge", "git-rebase", async () => {
      await logAgent(agentDir, `Rebasing ${branchName} onto ${targetBranch}...`);
      const rebaseResult = await mergeSpawnCtx.run(["git", "-C", worktreePath, "rebase", targetBranch]);
      if (rebaseResult.exitCode !== 0) {
        return { ok: false as const, stderr: `Rebase failed: ${rebaseResult.stderr || rebaseResult.stdout}` };
      }
      await logAgent(agentDir, "Rebase completed successfully");
      return { ok: true as const };
    });
    if (!rebaseOk.ok) {
      return { ok: false, exitCode: 1, stdout: "", stderr: rebaseOk.stderr };
    }

    // 9-10. Checkout target branch + merge
    const mergeOk = await timed("merge", "git-merge", async () => {
      await logAgent(agentDir, `Checking out ${targetBranch}...`);
      const checkoutResult = await mergeSpawnCtx.run(["git", "-C", targetDir, "checkout", targetBranch]);
      if (checkoutResult.exitCode !== 0) {
        return { ok: false as const, stderr: `Could not checkout ${targetBranch}: ${checkoutResult.stderr || checkoutResult.stdout}` };
      }

      const runningAsAgent = await isRunningAsAgent();
      if (runningAsAgent) {
        await logAgent(agentDir, `Fast-forwarding ${targetBranch} to ${branchName}...`);
        const ffResult = await mergeSpawnCtx.run(["git", "-C", targetDir, "merge", "--ff-only", branchName]);
        if (ffResult.exitCode !== 0) {
          return { ok: false as const, stderr: `Fast-forward failed: ${ffResult.stderr || ffResult.stdout}` };
        }
        await logAgent(agentDir, "Fast-forward merge completed successfully");
      } else {
        await logAgent(agentDir, `Merging ${branchName} with --no-ff...`);
        const noFFResult = await mergeSpawnCtx.run(["git", "-C", targetDir, "merge", "--no-ff", branchName, "-m", `Merge agent ${agent.id} work`]);
        if (noFFResult.exitCode !== 0) {
          return { ok: false as const, stderr: `Merge failed: ${noFFResult.stderr || noFFResult.stdout}` };
        }
        await logAgent(agentDir, "Merge completed successfully");
      }
      return { ok: true as const };
    });
    if (!mergeOk.ok) {
      return { ok: false, exitCode: 1, stdout: "", stderr: mergeOk.stderr };
    }
  }

  // 11. Capture tmux output before killing
  await timed("merge", "tmux-capture", async () => {
    await logAgent(agentDir, "Capturing tmux output...");
    if (tmuxSession) {
      const hasSession = await mergeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
      if (hasSession.exitCode === 0) {
        await captureTmuxOutputToFile(tmuxSession, join(agentDir, "output.log"));
      }
    }
  });

  // 12-13. Kill Claude process + tmux session
  await timed("merge", "tmux-cleanup", async () => {
    await logAgent(agentDir, "Terminating Claude process...");
    const killed = await killAgentProcess(tmuxSession, { claude_pid: agent.meta.claude_pid });
    if (killed) {
      await logAgent(agentDir, "Claude process terminated");
    }
    if (tmuxSession) {
      const hasSession2 = await mergeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
      if (hasSession2.exitCode === 0) {
        await mergeSpawnCtx.run(["tmux", "kill-session", "-t", tmuxSession]);
        await logAgent(agentDir, "Tmux session stopped");
      }
    }
  });

  // 14-16. Copy settings, remove worktree, delete branch
  await timed("merge", "worktree-cleanup", async () => {
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    try {
      if (await Bun.file(settingsPath).exists()) {
        const content = await Bun.file(settingsPath).text();
        await Bun.write(join(agentDir, "settings.local.json"), content);
      }
    } catch { /* ignore */ }

    await logAgent(agentDir, "Removing worktree...");
    const removeResult = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "worktree", "remove", worktreePath, "--force"]);
    if (removeResult.exitCode !== 0) {
      try { await rm(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    await logAgent(agentDir, "Worktree removed");

    await logAgent(agentDir, `Deleting branch ${branchName}...`);
    const deleteBranch = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "branch", "-D", branchName]);
    if (deleteBranch.exitCode === 0) {
      await logAgent(agentDir, `Branch deleted: ${branchName}`);
    }
  });

  // 17-19. Archive artifacts, remove questions, remove agent dir
  await timed("merge", "archive", async () => {
    await logAgent(agentDir, "Merge complete - archiving and closing agent");
    await archiveAgent(agent.repoPath, agent.id, agentDir);
    await removeAgentQuestions(agent.repoPath, agent.id);
    try { await rm(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // 20. Scan for orphaned Claude processes
  await timed("merge", "orphan-scan", () => scanAndKillOrphans(agentsDir));

  return { ok: true, exitCode: 0, stdout: `Closed agent: ${agent.id}`, stderr: "" };
}

/** Spawn context for send operations */
export const sendSpawnCtx = new SpawnContext();
/** Override delay for tests (null = use calculated delay) */
let sendDelayOverrideMs: number | null = null;

/** Override the send spawn runner (for testing). Sets delay to 0 by default. */
export function setSendSpawnRunner(runner: SpawnFn): void {
  sendSpawnCtx.set(runner);
  sendDelayOverrideMs = 0;
}

/** Reset the send spawn runner */
export function resetSendSpawnRunner(): void {
  sendSpawnCtx.reset();
  sendDelayOverrideMs = null;
}

/**
 * Send a message to an agent's tmux session (native implementation).
 *
 * Steps:
 * 1. Read tmux_session from agent meta
 * 2. Verify tmux session exists
 * 3. Auto-detect sender from cwd if applicable (agent worktree → agent ID;
 *    system coordinator home → `@system` sentinel)
 * 4. Format message with [sent by ...] prefix if sender detected
 *    (`agent <id>` for real agent IDs, bare sentinel for `@`-prefixed senders)
 * 5. Calculate delay: 0.1 + (msg_len / 100) * 0.5, clamped to [0.2, 3.0]
 * 6. Send via tmux send-keys, sleep, Enter
 * 7. Log to recipient's agent.log
 *
 * When `opts.raw` is true, the `[sent by ...]:` prefix is suppressed and the
 * message is delivered verbatim. The recipient's agent.log records this as a
 * "Received raw message" line (no sender attribution) and the sender's
 * agent.log (if any) records "Sent raw message". Sender auto-detection is
 * still performed so the sender log line is reachable, but the prefix never
 * lands on the recipient pane.
 */
export async function sendMessage(
  agent: Agent,
  message: string,
  opts?: { fromAgent?: string; cwd?: string; raw?: boolean }
): Promise<IbCommandResult> {
  const tmuxSession = agent.meta.tmux_session;
  if (!tmuxSession) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent has no tmux session" };
  }

  // Verify session exists
  const hasSessionProc = sendSpawnCtx.runner(
    ["tmux", "has-session", "-t", tmuxSession],
    { stdout: "pipe", stderr: "pipe" }
  );
  await new Response(hasSessionProc.stderr).text(); // drain
  const hasSessionExit = await hasSessionProc.exited;
  if (hasSessionExit !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is not running` };
  }

  // Auto-detect sender from cwd
  let fromId = opts?.fromAgent ?? "";
  if (!fromId) {
    const cwd = opts?.cwd ?? process.cwd();
    const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/(?:[^/]+)\/repo/);
    if (worktreeMatch) {
      // Read the sender's meta.json to get their ID
      const senderAgentDir = cwd.replace(/(\/\.ittybitty\/agents\/[^/]+)\/repo.*/, "$1");
      try {
        const senderMeta = await Bun.file(join(senderAgentDir, "meta.json")).json();
        if (senderMeta?.id) fromId = senderMeta.id;
      } catch { /* ignore */ }
    } else {
      // System coordinator runs from ~/.itsybitsy/ — no worktree match.
      // If cwd is the coordinator home (or under it), stamp as @system.
      // Both paths are compared as raw strings (no realpath resolution): we
      // assume process.cwd() and getCoordinatorHome() return paths in the
      // same un-resolved form. If $HOME is itself a symlink and a caller
      // resolved it before chdir'ing, this match would silently miss — in
      // practice the coordinator session is launched with an un-resolved
      // home so the assumption holds.
      const coordHome = getCoordinatorHome();
      if (cwd === coordHome || cwd.startsWith(coordHome + "/")) {
        fromId = "@system";
      }
    }
  }

  // Format message with sender prefix. `@`-prefixed sender IDs (e.g. @system)
  // are sentinels, not agent IDs, so omit the literal "agent " word for them.
  // Raw mode (used by Telegram slash-command passthrough) skips the prefix
  // entirely — the recipient pane sees the message verbatim.
  const raw = opts?.raw === true;
  let fullMessage = message;
  if (fromId && !raw) {
    const label = fromId.startsWith("@") ? fromId : `agent ${fromId}`;
    fullMessage = `[sent by ${label}]: ${message}`;
  }

  // Calculate delay: 0.1 + (len / 100) * 0.5, clamped [0.2, 3.0]
  const msgLen = fullMessage.length;
  let delay = 0.1 + (msgLen / 100) * 0.5;
  if (delay < 0.2) delay = 0.2;
  if (delay > 3.0) delay = 3.0;

  // Send via tmux send-keys, chunked to avoid silent truncation when the
  // recipient TUI cannot ingest a large -l payload fast enough.
  const CHUNK_SIZE = 500;
  const INTER_CHUNK_SLEEP_MS = 50;
  const interChunkSleepMs = sendDelayOverrideMs !== null ? sendDelayOverrideMs : INTER_CHUNK_SLEEP_MS;
  for (let i = 0; i < fullMessage.length; i += CHUNK_SIZE) {
    const chunk = fullMessage.slice(i, i + CHUNK_SIZE);
    const chunkProc = sendSpawnCtx.runner(
      ["tmux", "send-keys", "-t", tmuxSession, "-l", chunk],
      { stdout: "pipe", stderr: "pipe" }
    );
    const chunkStderr = await new Response(chunkProc.stderr).text();
    const chunkExit = await chunkProc.exited;
    if (chunkExit !== 0) {
      return { ok: false, exitCode: chunkExit, stdout: "", stderr: chunkStderr.trim() };
    }
    const isLastChunk = i + CHUNK_SIZE >= fullMessage.length;
    if (!isLastChunk && interChunkSleepMs > 0) await Bun.sleep(interChunkSleepMs);
  }

  // Sleep for calculated delay (skippable in tests)
  const actualDelayMs = sendDelayOverrideMs !== null ? sendDelayOverrideMs : delay * 1000;
  if (actualDelayMs > 0) await Bun.sleep(actualDelayMs);

  // Send Enter
  const enterProc = sendSpawnCtx.runner(
    ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
    { stdout: "pipe", stderr: "pipe" }
  );
  await new Response(enterProc.stderr).text(); // drain
  await enterProc.exited;

  // Log to recipient's agent.log. Raw sends omit sender attribution from the
  // recipient line since the recipient pane saw the message without any
  // [sent by ...] prefix — surfacing the sender only in the log would be
  // confusing.
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  if (raw) {
    await logAgent(agentDir, `Received raw message: ${message}`);
  } else if (fromId) {
    await logAgent(agentDir, `Received message from ${fromId}: ${message}`);
  } else {
    await logAgent(agentDir, `Received message: ${message}`);
  }

  // Log to sender's agent.log if applicable
  if (fromId) {
    const senderDir = join(agent.repoPath, ".ittybitty", "agents", fromId);
    const verb = raw ? "Sent raw message" : "Sent message";
    await logAgent(senderDir, `${verb} to ${agent.id}: ${message}`);
  }

  // Write state: "running" to meta.json (agent just received input)
  await writeAgentState(agentDir, "running");

  const stdout = fromId ? "" : `Sent to ${agent.id}`;
  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

export interface NewAgentOptions {
  name?: string;
  type?: string;
  yolo?: boolean;
  model?: string;
  manager?: string;
  noWorktree?: boolean;
  allowTools?: string;
  denyTools?: string;
  print?: boolean;
  spawnedBy?: SpawnedBy;
  /** Override cwd for auto-detect manager (used in tests). */
  _cwd?: string;
}

/** Spawn context for newAgent operations */
export const newAgentSpawnCtx = new SpawnContext();
/** Override delay for newAgent tests (null = use real delay) */
let newAgentDelayOverrideMs: number | null = null;

/** Override the newAgent spawn runner (for testing). Sets delay to 0 by default. */
export function setNewAgentSpawnRunner(runner: SpawnFn): void {
  newAgentSpawnCtx.set(runner);
  newAgentDelayOverrideMs = 0;
}

/** Reset the newAgent spawn runner */
export function resetNewAgentSpawnRunner(): void {
  newAgentSpawnCtx.reset();
  newAgentDelayOverrideMs = null;
}

/** Injectable watchdog spawn for testing — returns PID or undefined */
type WatchdogSpawnFn = (id: string, repoPath: string, logPath: string) => { pid?: number } | null;
let watchdogSpawnOverride: WatchdogSpawnFn | null = null;

/** Override watchdog spawn for testing */
export function setWatchdogSpawnFn(fn: WatchdogSpawnFn): void {
  watchdogSpawnOverride = fn;
}

/** Reset watchdog spawn to default */
export function resetWatchdogSpawnFn(): void {
  watchdogSpawnOverride = null;
}

/**
 * Read custom prompts from .ittybitty/prompts/ directory.
 * Mirrors load_custom_prompts() in ib bash.
 */
async function loadCustomPrompts(repoPath: string): Promise<{
  all: string;
  manager: string;
  worker: string;
}> {
  const promptsDir = join(repoPath, ".ittybitty", "prompts");
  const result = { all: "", manager: "", worker: "" };

  for (const [key, filename] of [
    ["all", "all.md"],
    ["manager", "manager.md"],
    ["worker", "worker.md"],
  ] as const) {
    try {
      const file = Bun.file(join(promptsDir, filename));
      if (await file.exists()) {
        result[key] = await file.text();
      }
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Count active agents (directories with meta.json in agents dir).
 * Mirrors count_agents() in ib bash.
 */
async function countAgents(agentsDir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaExists = await Bun.file(join(agentsDir, entry.name, "meta.json")).exists().catch(() => false);
      if (metaExists) count++;
    }
  } catch { /* directory may not exist */ }
  return count;
}

/**
 * Read the repo-id from .ittybitty/repo-id (or create one).
 * Mirrors get_repo_id() in ib bash.
 */
async function getRepoId(repoPath: string): Promise<string> {
  const repoIdFile = join(repoPath, ".ittybitty", "repo-id");
  try {
    const file = Bun.file(repoIdFile);
    if (await file.exists()) {
      const id = (await file.text()).trim();
      if (id) return id;
    }
  } catch { /* ignore */ }

  // Generate new 8 hex char ID
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const newId = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  await mkdir(join(repoPath, ".ittybitty"), { recursive: true });
  await Bun.write(repoIdFile, newId + "\n");
  return newId;
}

/**
 * Build settings.local.json content for an agent worktree.
 * Mirrors build_agent_settings() + build_settings_json() in ib bash.
 */
async function buildAgentSettings(
  repoPath: string,
  agentType: "manager" | "worker",
  agentId: string,
  configAllow: string[],
  configDeny: string[]
): Promise<string> {
  // Start with existing project settings if available.
  // We read settings.json (the version-controlled project settings), NOT settings.local.json.
  // The .local file may belong to a coordinator or have repo-specific overrides that should
  // not propagate to spawned agents.
  let baseSettings: Record<string, unknown> = {};
  try {
    const settingsFile = Bun.file(join(repoPath, ".claude", "settings.json"));
    if (await settingsFile.exists()) {
      baseSettings = await settingsFile.json();
    }
  } catch { /* ignore */ }

  // Mandatory permissions that are always added
  const ibPerms = [
    "Bash(ib:*)",
    "Bash(git status:*)", "Bash(git add:*)", "Bash(git commit:*)",
    "Bash(git diff:*)", "Bash(git show:*)", "Bash(git log:*)",
    "Bash(git ls-files:*)", "Bash(git grep:*)", "Bash(git rm:*)",
    "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git checkout:*)",
    "Bash(git restore:*)", "Bash(git reset:*)",
    "Bash(pwd:*)", "Bash(ls:*)", "Bash(head:*)", "Bash(tail:*)",
    "Bash(cat:*)", "Bash(grep:*)",
    "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS",
    "TodoWrite", "Task", "TaskCreate", "Agent", "TaskOutput", "KillShell", "NotebookEdit",
    "WebFetch", "WebSearch", "ToolSearch",
  ];
  const blockedTools = ["EnterPlanMode", "ExitPlanMode"];

  // Initialize permissions
  // Note: we inherit existing allow entries from settings.json (harmless — more
  // permissions don't hurt), but NOT existing deny entries. The base settings.json
  // may have deny entries that should not propagate to agents. Agent deny lists come
  // from config and agent type frontmatter only.
  const perms = (baseSettings.permissions ?? {}) as Record<string, unknown>;
  const existingAllow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];

  // Merge and deduplicate
  const allAllow = [...new Set([...existingAllow, ...ibPerms, ...configAllow])];
  const allDeny = [...new Set([...blockedTools, ...configDeny])];

  // Check if intercept hook should be added (reuse already-parsed baseSettings)
  let addIntercept = false;
  if (agentType === "manager") {
    const hooksObj = baseSettings.hooks as Record<string, unknown> | undefined;
    const preToolUse = hooksObj?.PreToolUse;
    if (Array.isArray(preToolUse)) {
      for (const entry of preToolUse) {
        const hooks = entry?.hooks;
        if (Array.isArray(hooks)) {
          for (const h of hooks) {
            if (typeof h?.command === "string" && h.command.includes("hooks intercept-task")) {
              addIntercept = true;
            }
          }
        }
      }
    }
  }

  const result = {
    ...baseSettings,
    spinnerTipsEnabled: false,
    permissions: {
      allow: allAllow,
      deny: allDeny,
    },
    hooks: buildHooksBlock({
      agentId,
      includeStop: true,
      interceptMatcher: addIntercept ? REGULAR_AGENT_INTERCEPT_MATCHER : null,
      sessionStartIncludesAgentId: false,
    }),
  };

  return JSON.stringify(result, null, 2);
}

/**
 * Native newAgent implementation — replaces `ib new-agent`.
 *
 * Sequence (mirrors cmd_new_agent in ib bash):
 * 1.  Validate prompt (required)
 * 2.  Ensure .ittybitty/agents/ and .ittybitty/archive/ dirs exist
 * 3.  Auto-detect manager from cwd if not provided
 * 4.  Validate manager (resolve partial ID, check not a worker)
 * 5.  Yolo escalation check
 * 6.  Load config for model, maxAgents, permissions, prompts
 * 7.  Model fallback: --model > config.model > 'opus'
 * 8.  Max agents check
 * 9.  Generate agent ID (--name or agent-<8 hex chars>)
 * 10. Uniqueness check (dir + tmux session)
 * 11. Create agent directory + write initial meta.json (state="creating")
 * 12. Create git worktree + branch (if worktree mode)
 * 13. Write settings.local.json in worktree
 * 14. (formerly meta.json — now written in step 11 before slow worktree add)
 * 15. Write prompt.txt
 * 16. Write start.sh + exit-check.sh
 * 17. Init agent.log
 * 18. Start tmux session
 * 19. Verify tmux session created
 * 20. Output agent ID
 * 21. Post-create-agent hook
 * 22. Auto-accept workspace trust (if not yolo)
 * 23. Auto-spawn watchdog
 */
export async function newAgent(
  repoPath: string,
  prompt: string,
  opts?: NewAgentOptions
): Promise<IbCommandResult> {
  // 1. Validate prompt
  if (!prompt || !prompt.trim()) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Error: prompt required" };
  }

  // Resolve the root repo path (handles worktrees)
  const rootRepoPath = (await resolveGitRoot(repoPath)) || repoPath;

  // Validate path for shell script interpolation
  if (!isValidShellPath(rootRepoPath)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Repository path contains characters unsafe for shell scripts (null bytes or newlines): ${rootRepoPath}` };
  }

  const agentsDir = join(rootRepoPath, ".ittybitty", "agents");
  const archiveDir = join(rootRepoPath, ".ittybitty", "archive");

  // 2. Ensure dirs exist
  await mkdir(agentsDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });

  // Configuration
  let useWorktree = opts?.noWorktree !== true;
  const yoloMode = opts?.yolo === true;

  // Ensure agent types directory is initialized + load the requested type.
  const { ensureAgentTypesDir } = await import("./agent-types");
  try {
    await timed("new-agent", "type-init", () => ensureAgentTypesDir());
  } catch (err) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error initializing agent types: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Resolve agent type: --type <name> or default to 'manager'
  const typeName = opts?.type ?? "manager";

  // Validate --type exists before proceeding
  const typeExists = await timed("new-agent", "type-exists", () => agentTypeExists(typeName));
  if (!typeExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: unknown agent type '${typeName}'. Run 'ib init-types' to restore default type files, or create ~/.itsybitsy/agent-types/${typeName}.md` };
  }

  // Determine if this is a coordinator type
  const agentTypeDef = await timed("new-agent", "type-load", () => loadAgentType(typeName));

  // Reject layer-only types (spawnable: false) — these are merge layers, not spawnable agents
  if (agentTypeDef.spawnable === false) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: type ${typeName} is not spawnable (used only as a permissions/prompt layer)` };
  }

  // Repo restriction check (see PLAN-INHERITS.md §Part 2). Must run after
  // `loadAgentType` so an inherited `repos` list is honored, and before any
  // worktree/tmux/agent-dir allocation so a rejection leaves no residue. Also
  // before the coordinator idempotency check below — a restricted coordinator
  // spawned in the wrong repo should fail with the repo error, not silently
  // succeed via idempotency.
  if (agentTypeDef.repos !== undefined) {
    const allKnownRepos = await listRepos();
    const entry = allKnownRepos.find((r) => r.path === rootRepoPath);
    const basenameOnly = basename(rootRepoPath);
    // Trim whitespace on the candidates as a defensive parallel to the
    // `allowed` list's .trim() — a nickname with trailing whitespace in
    // repos.json should still match a clean entry in the type's repos list.
    const candidates = (entry
      ? [entry.name, entry.nickname].filter((s): s is string => typeof s === "string" && s.length > 0)
      : [basenameOnly]
    ).map((s) => s.trim()).filter(Boolean);
    const allowed = agentTypeDef.repos.map((s) => s.trim()).filter(Boolean);
    const matches = candidates.some((c) => allowed.includes(c));
    if (!matches) {
      const display = entry ? repoDisplayName(entry) : basenameOnly;
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `Error: agent type '${typeName}' is restricted to repos [${allowed.join(", ")}]; current repo '${display}' (path: ${rootRepoPath}) is not in that list`,
      };
    }
  }

  const coordinatorMode = typeName === "coordinator";

  // Coordinators never use worktrees (SPEC §12.2.3)
  if (coordinatorMode) {
    useWorktree = false;
  }

  // Coordinator one-per-repo check
  if (coordinatorMode) {
    const coordStatus = await checkCoordinatorExists(rootRepoPath);
    if (coordStatus.exists) {
      // Idempotent no-op per SPEC §12.2.3
      const repoName = rootRepoPath.split("/").pop() ?? rootRepoPath;
      return { ok: true, exitCode: 0, stdout: coordStatus.agentId, stderr: `Coordinator already exists for ${repoName}` };
    }
  }
  const printMode = opts?.print === true;
  const allowTools = opts?.allowTools ?? "";
  const denyTools = opts?.denyTools ?? "";

  // Validate CLI-originated values before bash interpolation
  if (allowTools && !isValidToolList(allowTools)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid --allow tools value: ${allowTools}` };
  }
  if (denyTools && !isValidToolList(denyTools)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid --deny tools value: ${denyTools}` };
  }

  let manager = opts?.manager ?? "";

  // 3. Auto-detect manager from cwd (only if cwd is in the same repo)
  //    Coordinators are top-level agents — never auto-detect a manager (SPEC §12.2.3)
  if (!manager && !coordinatorMode) {
    const cwd = opts?._cwd ?? process.cwd();
    const agentPattern = /\/.ittybitty\/agents\/([^/]+)\/repo/;
    const match = cwd.match(agentPattern);
    if (match && (cwd === rootRepoPath || cwd.startsWith(rootRepoPath + "/"))) {
      const agentDirPath = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
      try {
        const metaFile = Bun.file(join(agentDirPath, "meta.json"));
        if (await metaFile.exists()) {
          const meta = await metaFile.json();
          if (meta.id) manager = meta.id;
        }
      } catch { /* ignore */ }
    }
  }

  // 3.5. Auto-detect spawned_by from CWD (works cross-repo, unlike manager auto-detect)
  let spawnedBy: SpawnedBy | undefined = opts?.spawnedBy;
  if (!spawnedBy) {
    const cwd = opts?._cwd ?? process.cwd();

    // Case 1: Worktree agent — CWD matches /.ittybitty/agents/<id>/repo
    const agentPattern = /\/.ittybitty\/agents\/([^/]+)\/repo/;
    const worktreeMatch = cwd.match(agentPattern);
    if (worktreeMatch) {
      const spawnerDir = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
      try {
        const spawnerMeta = await Bun.file(join(spawnerDir, "meta.json")).json();
        if (spawnerMeta.id) {
          const spawnerRepoPath = cwd.substring(0, cwd.indexOf("/.ittybitty/agents/"));
          spawnedBy = {
            agent_id: spawnerMeta.id,
            repo_path: spawnerRepoPath,
          };
        }
      } catch { /* ignore */ }
    }

    // Case 2A: System coordinator — CWD is the system coordinator home
    // (~/.itsybitsy/). The system coordinator is not a registered repo so the
    // Case 2B per-repo lookup below would never match. Tag with the @system
    // sentinel so the watchdog can route notifications via
    // sendToSystemCoordinator() (direct tmux delivery to the ib-coordinator
    // session). Like Case 2B, this is gated on CLAUDE_SESSION_ID so a human
    // running `ib new-agent` from the system coordinator dir does not get tagged.
    if (!spawnedBy && !worktreeMatch && process.env.CLAUDE_SESSION_ID) {
      let systemHome: string | null = null;
      try {
        systemHome = realpathSync(getCoordinatorHome());
      } catch {
        systemHome = resolve(getCoordinatorHome());
      }
      let resolvedCwd: string;
      try {
        resolvedCwd = realpathSync(cwd);
      } catch {
        resolvedCwd = resolve(cwd);
      }
      if (systemHome && resolvedCwd === systemHome) {
        spawnedBy = {
          agent_id: "@system",
          repo_path: null,
        };
      }
    }

    // Case 2B: Non-worktree per-repo coordinator — CWD is a registered repo root.
    // Coordinators run from the repo root, so CWD won't match the worktree pattern.
    // Detect by checking if CWD is a registered repo with a coordinator agent.
    // Only fires when CLAUDE_SESSION_ID is set, which means the caller is a Claude agent
    // session (e.g. a coordinator). Human users running ib watch or ib new-agent from the
    // command line won't have this variable, so they won't get auto-assigned a coordinator
    // as spawner.
    //
    // The stored agent_id is the `@<repo-name>` sentinel (not the coordinator's
    // actual agent_id) so the watchdog routes notifications through resolveTarget,
    // which is robust to the coordinator being killed and re-created.
    if (!spawnedBy && !worktreeMatch && process.env.CLAUDE_SESSION_ID) {
      try {
        const repos = await listRepos();
        const repoMatch = repos.find(r => r.path === cwd);
        if (repoMatch) {
          const coordStatus = await checkCoordinatorExists(cwd);
          if (coordStatus.exists && coordStatus.agentId) {
            // Stamp with `basename(cwd)` — the same invariant that
            // `getCoordinatorAgentId()` uses for the coordinator's actual
            // agent ID. The access checks in agent-path.ts and the
            // routing in notifySpawner @<repo-name> both compare the
            // sentinel suffix against the coordinator's agent ID, so
            // they must use the same source of truth. Using the registry
            // `name` (or worse, the nickname) would silently break access
            // any time a user passed a custom name via `ib add <path>
            // <custom-name>` or set a nickname.
            spawnedBy = {
              agent_id: `@${basename(cwd)}`,
              repo_path: cwd,
            };
          }
        }
      } catch { /* ignore */ }
    }
  }

  // 4. Validate manager
  if (manager) {
    // Resolve partial ID
    const resolveResult = await resolveAgentId(agentsDir, manager);
    if ("error" in resolveResult) {
      const suffix = resolveResult.matches.length > 0
        ? `: ${resolveResult.matches.join(", ")}`
        : "";
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: ${resolveResult.error} for '${manager}'${suffix}` };
    }
    manager = resolveResult.resolved;

    // Check manager is not a worker
    try {
      const managerMeta = await Bun.file(join(agentsDir, manager, "meta.json")).json();
      if (managerMeta.worker === true) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Error: '${manager}' is a worker agent and cannot manage sub-agents` };
      }
    } catch { /* ignore */ }
  }

  // 5. Yolo escalation check (only if cwd is in the same repo)
  if (yoloMode) {
    const cwd = opts?._cwd ?? process.cwd();
    if (/\/.ittybitty\/agents\/[^/]+\/repo/.test(cwd) && (cwd === rootRepoPath || cwd.startsWith(rootRepoPath + "/"))) {
      const parentAgentDir = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
      let parentIsYolo = false;

      try {
        const parentMeta = await Bun.file(join(parentAgentDir, "meta.json")).json();
        if (parentMeta.yolo === true) parentIsYolo = true;
      } catch { /* ignore */ }

      if (!parentIsYolo) {
        try {
          const startSh = await Bun.file(join(parentAgentDir, "start.sh")).text();
          if (startSh.includes("dangerously-skip-permissions")) parentIsYolo = true;
        } catch { /* ignore */ }
      }

      if (!parentIsYolo) {
        return { ok: false, exitCode: 1, stdout: "", stderr: "Error: Yolo mode denied - permission escalation not allowed" };
      }
    }
  }

  // 6. Load config
  const config = await readConfig();
  const customPrompts = await loadCustomPrompts(rootRepoPath);

  // Leaf agents can't spawn children (worker-like behavior)
  const isLeafAgent = !agentTypeDef.canSpawnChildren;

  // 7. Model fallback: --model > type.model > config.model > 'opus'
  //    For coordinators: --model > type.model > coordinator.model > 'opus'
  let model = opts?.model ?? "";
  if (!model && agentTypeDef.model) {
    model = agentTypeDef.model;
  }
  if (!model) {
    if (coordinatorMode) {
      const coordModel = config["coordinator.model"]?.value as string | undefined;
      if (coordModel) model = coordModel;
    } else {
      const configModel = config.model?.value as string | undefined;
      if (configModel) model = configModel;
    }
  }
  if (!model) model = "opus";

  // Validate model name before bash interpolation
  if (!isValidModel(model)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid model name: ${model}` };
  }

  // Permissions are assembled in three layers (SPEC §2.3):
  //   1. `_all.md` frontmatter — applied to every spawned agent
  //   2. `_non_coordinator.md` frontmatter — applied to non-coordinator agents only
  //   3. `<type>.md` frontmatter — per-type permissions
  // The layers are merged (allow/deny deduplicated via Set). Config-level
  // `permissions.all.*` / `permissions.repo.*` keys have been deprecated —
  // their contents have moved into the `_all.md` and `_non_coordinator.md` files.
  let allLayerAllow: string[] = [];
  let allLayerDeny: string[] = [];
  try {
    const allLayer = await loadAgentType("_all");
    allLayerAllow = allLayer.permissions?.allow ?? [];
    allLayerDeny = allLayer.permissions?.deny ?? [];
  } catch (err) {
    console.error(`Warning: failed to load _all agent type layer: ${err instanceof Error ? err.message : String(err)}`);
  }

  let nonCoordAllow: string[] = [];
  let nonCoordDeny: string[] = [];
  if (!coordinatorMode) {
    try {
      const nonCoordLayer = await loadAgentType("_non_coordinator");
      nonCoordAllow = nonCoordLayer.permissions?.allow ?? [];
      nonCoordDeny = nonCoordLayer.permissions?.deny ?? [];
    } catch (err) {
      console.error(`Warning: failed to load _non_coordinator agent type layer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const typeAllow = agentTypeDef.permissions?.allow ?? [];
  const typeDeny = agentTypeDef.permissions?.deny ?? [];
  const configAllow = [...new Set([...allLayerAllow, ...nonCoordAllow, ...typeAllow])];
  const configDeny = [...new Set([...allLayerDeny, ...nonCoordDeny, ...typeDeny])];

  // 8. Max agents check — coordinators bypass this (SPEC §12.4.3)
  if (!coordinatorMode) {
    const maxAgents = (config.maxAgents?.value as number | undefined) ?? 10;
    const currentCount = await countAgents(agentsDir);
    if (currentCount >= maxAgents) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: Maximum agent limit reached (${currentCount}/${maxAgents} agents)` };
    }
  }

  // 9. Generate agent ID
  let id: string;
  if (coordinatorMode) {
    id = getCoordinatorAgentId(rootRepoPath);
    // Collision handling: if a non-coordinator agent already has the basename,
    // append a random 4-char hex suffix
    const coordCheck = await checkCoordinatorExists(rootRepoPath);
    if (!coordCheck.exists && coordCheck.collision) {
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
        .map(b => b.toString(16).padStart(2, "0")).join("");
      id = `${id}-${suffix}`;
    }
  } else if (opts?.name) {
    if (!/^[a-zA-Z0-9_\-]+$/.test(opts.name)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "Error: agent name may only contain letters, digits, hyphens, and underscores" };
    }
    if (opts.name === "coordinator") {
      return { ok: false, exitCode: 1, stdout: "", stderr: 'Error: "coordinator" is a reserved name (used for system coordinator addressing)' };
    }
    id = opts.name;
  } else {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    id = `agent-${Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  }

  // Reserved names check — applies to all ID generation paths
  if (id === "coordinator") {
    return { ok: false, exitCode: 1, stdout: "", stderr: 'Error: "coordinator" is a reserved name (used for system coordinator addressing)' };
  }
  if (id === "system") {
    return { ok: false, exitCode: 1, stdout: "", stderr: 'Error: "system" is a reserved name (used for system coordinator addressing)' };
  }

  // Repo display name collision check
  const repos = await listRepos();
  if (coordinatorMode) {
    // For coordinator agents, check against OTHER repos' display names
    // (the ID IS the repo basename by design, which is the current repo)
    const thisRepo = repos.find(r => r.path === rootRepoPath);
    const otherRepos = repos.filter(r => r.path !== rootRepoPath);
    const collision = otherRepos.find(r => repoDisplayName(r) === id);
    if (collision) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent name "${id}" collides with registered repo name` };
    }
  } else {
    // For named and random agents, check against ALL repos' display names and basenames
    const collision = repos.find(r => repoDisplayName(r) === id || r.name === id);
    if (collision) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent name "${id}" collides with registered repo name` };
    }
  }

  // Get repo-id for session naming
  const repoId = await getRepoId(rootRepoPath);
  const tmuxSession = `ittybitty-${repoId}-${id}`;

  // 10. Uniqueness check
  const agentDir = join(agentsDir, id);
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent '${id}' already exists` };
  }
  // Check tmux session
  const hasSessionResult = await newAgentSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
  if (hasSessionResult.exitCode === 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent '${id}' already exists` };
  }

  // 11. Create agent directory
  await mkdir(agentDir, { recursive: true });

  // Prefer spawnedBy; fall back to --manager flag.
  // @-prefixed sentinels (e.g. @system, @<repo-name>) and null repo_path are
  // skipped here — the spawner is not a real agent directory we can log into,
  // so logSpawn writes only to the spawnee's log.
  const spawnerAgentDir: string | null =
    spawnedBy && spawnedBy.repo_path !== null && !spawnedBy.agent_id.startsWith("@")
      ? join(spawnedBy.repo_path, ".ittybitty", "agents", spawnedBy.agent_id)
      : manager
        ? join(agentsDir, manager)
        : null;

  // Working directory defaults to root repo
  let workPath = rootRepoPath;

  // Compute fields needed for the early meta.json write below. These were
  // previously computed just before the late meta.json write (post worktree-add),
  // but slow worktree checkouts (60-90s on large repos) leave the agent dir
  // without meta.json — the dashboard's readAllAgents() then flags it as an
  // orphan. Writing meta.json with state='creating' before any slow step gives
  // the dashboard something to render and avoids the orphan-detection race.
  const sessionUuid = crypto.randomUUID();

  // Normalize and validate spawned_by repo_path before writing to meta.json.
  // Skip when repo_path is null — that path is reserved for the @system
  // sentinel whose spawner has no repo.
  if (spawnedBy && spawnedBy.repo_path !== null) {
    // Normalize: resolve symlinks so stored path matches registry's canonical form.
    // realpathSync resolves symlinks; resolve() only normalizes .. and trailing slashes.
    // Registry's addRepo stores resolve()-d paths, but the user may pass a symlinked path
    // via --spawned-by-repo. realpathSync ensures consistency.
    try {
      spawnedBy.repo_path = realpathSync(spawnedBy.repo_path);
    } catch {
      // Path doesn't exist yet — fall back to resolve() normalization
      spawnedBy.repo_path = resolve(spawnedBy.repo_path);
    }
  }

  // If spawned_by wasn't auto-detected and we have a same-repo manager,
  // set spawned_by to match the manager for consistency
  if (!spawnedBy && manager) {
    spawnedBy = {
      agent_id: manager,
      repo_path: rootRepoPath,
    };
  }

  // Resolve and normalize allowedPaths from agent type
  let resolvedAllowedPaths: string[] | undefined = undefined;
  if (agentTypeDef.allowedPaths !== undefined) {
    resolvedAllowedPaths = agentTypeDef.allowedPaths.map(p => {
      // Expand ~ to home directory
      let expanded: string;
      if (p === "~") {
        expanded = homedir();
      } else if (p.startsWith("~/")) {
        expanded = join(homedir(), p.slice(2));
      } else {
        expanded = p;
      }
      // Resolve to absolute path
      expanded = resolve(expanded);
      // Try to resolve symlinks, fall back to resolve() result if path doesn't exist
      try {
        return realpathSync(expanded);
      } catch {
        return expanded;
      }
    });
  }

  // Build the initial meta.json. Subsequent writes (start.sh setting claude_pid,
  // watchdog spawn setting watchdog_pid, generate-summary setting summary, the
  // post-worktree refresh below) all read-modify-write so they merge cleanly
  // with these fields.
  const createdAt = new Date();
  const initialMetaJson: Record<string, unknown> = {
    id,
    session_id: sessionUuid,
    tmux_session: tmuxSession,
    prompt,
    manager: manager || null,
    created: createdAt.toISOString(),
    created_epoch: Math.floor(createdAt.getTime() / 1000),
    worktree: useWorktree,
    worker: isLeafAgent,
    agentType: typeName,
    agentIcon: agentTypeDef.icon || undefined,
    yolo: yoloMode,
    model: model || null,
    spawned_by: spawnedBy ?? null,
    state: "creating",
    state_updated_at: Math.floor(createdAt.getTime() / 1000),
  };
  if (resolvedAllowedPaths !== undefined) {
    initialMetaJson.allowedPaths = resolvedAllowedPaths;
  }
  await timed("new-agent", "meta-write", () => writeMetaJsonAtomic(agentDir, initialMetaJson));

  // 12. Create git worktree if requested
  // Note: coordinator branch format retained for backward compatibility with
  // session-start.ts and health-check.ts, even though coordinators no longer use worktrees.
  const branchName = coordinatorMode ? `agent/${id}-${repoId}` : `agent/${id}`;
  const baseRefForLog = manager ? `agent/${manager}` : "HEAD";
  await logSpawn(
    agentDir,
    spawnerAgentDir,
    id,
    `start id=${id} repo=${rootRepoPath} worktree=${useWorktree} coordinator=${coordinatorMode} worker=${isLeafAgent} manager=${manager || "null"} baseRef=${useWorktree ? baseRefForLog : "n/a"}`,
  );
  if (useWorktree) {
    // Self-healing: discard stale worktree metadata pointing at paths that no longer exist.
    // The branch --list enumeration is independent of prune (prune cleans worktree refs;
    // branch --list reads the branch ref store), so run them concurrently.
    const [pruneResult, branchList] = await Promise.all([
      newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "worktree", "prune"]),
      newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "branch", "--list", branchName]),
    ]);
    await logSpawn(agentDir, spawnerAgentDir, id, `git worktree prune → exit=${pruneResult.exitCode}${pruneResult.exitCode !== 0 && pruneResult.stderr ? ` stderr="${pruneResult.stderr.trim()}"` : ""}`);

    // If a same-name branch lingers from a prior failed/killed spawn, drop it —
    // but only when no worktree is checked out on it. If a worktree holds the
    // branch, surface a clear error instead of silently failing later.
    const branchExists = branchList.stdout.trim().length > 0;
    await logSpawn(agentDir, spawnerAgentDir, id, `git branch --list ${branchName} → exit=${branchList.exitCode} exists=${branchExists}`);
    if (branchExists) {
      const worktreeList = await newAgentSpawnCtx.run([
        "git", "-C", rootRepoPath, "worktree", "list", "--porcelain",
      ]);
      // Anchor the match so `agent/foo` does not match inside `agent/foo-extra`.
      // Porcelain format places each `branch refs/heads/<name>` on its own line.
      const needle = `branch refs/heads/${branchName}`;
      const worktreeHoldsBranch =
        worktreeList.stdout.includes(needle + "\n") || worktreeList.stdout.endsWith(needle);
      await logSpawn(agentDir, spawnerAgentDir, id, `git worktree list → exit=${worktreeList.exitCode} holdsBranch=${worktreeHoldsBranch}`);
      if (worktreeHoldsBranch) {
        await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: branch ${branchName} is already checked out in another worktree`);
        await rm(agentDir, { recursive: true, force: true });
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `Error: branch ${branchName} is already checked out in another worktree`,
        };
      }
      const branchDelResult = await newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "branch", "-D", branchName]);
      await logSpawn(agentDir, spawnerAgentDir, id, `self-heal: deleted orphan branch ${branchName} → exit=${branchDelResult.exitCode}${branchDelResult.exitCode !== 0 && branchDelResult.stderr ? ` stderr="${branchDelResult.stderr.trim()}"` : ""}`);
    }

    // If <agentDir>/repo exists from an earlier aborted run, remove it so
    // `git worktree add` can create a fresh directory there.
    const repoPath = join(agentDir, "repo");
    const residualExisted = await stat(repoPath).then(() => true).catch(() => false);
    await rm(repoPath, { recursive: true, force: true });
    if (residualExisted) {
      await logSpawn(agentDir, spawnerAgentDir, id, `self-heal: removed residual repo dir ${repoPath}`);
    }

    const baseRef = manager ? `agent/${manager}` : "HEAD";
    // Bracket-log the slow worktree-add. On large repos this can take 60-90s,
    // and if the spawn process crashes or hangs, the LAST log line is what
    // tells us where it died. The "completes" line below logs after.
    await logSpawn(agentDir, spawnerAgentDir, id, `git worktree add starting: ${repoPath} -b ${branchName} ${baseRef}`);
    const worktreeResult = await timed("new-agent", "worktree-create", () =>
      newAgentSpawnCtx.run([
        "git", "-C", rootRepoPath, "worktree", "add", repoPath, "-b", branchName, baseRef,
      ])
    );
    await logSpawn(agentDir, spawnerAgentDir, id, `git worktree add ${repoPath} -b ${branchName} ${baseRef} → exit=${worktreeResult.exitCode}${worktreeResult.exitCode !== 0 && worktreeResult.stderr ? ` stderr="${worktreeResult.stderr.trim()}"` : ""}`);
    if (worktreeResult.exitCode !== 0) {
      const gitErr = worktreeResult.stderr.trim();
      await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: could not create worktree${gitErr ? `: ${gitErr}` : ""}`);
      await rm(agentDir, { recursive: true, force: true });
      const suffix = gitErr ? `: ${gitErr}` : "";
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: could not create worktree${suffix}` };
    }
    workPath = join(agentDir, "repo");

    // 13. Write settings.local.json (worktree mode only).
    // Coordinators force useWorktree=false above (SPEC §12.2.3), so we never
    // reach here in coordinator mode — only regular agents need settings here.
    await mkdir(join(agentDir, "repo", ".claude"), { recursive: true });
    const managerOrWorker: "manager" | "worker" = isLeafAgent ? "worker" : "manager";
    const settingsContent = await buildAgentSettings(rootRepoPath, managerOrWorker, id, configAllow, configDeny);
    await Bun.write(join(agentDir, "repo", ".claude", "settings.local.json"), settingsContent);
  } else if (coordinatorMode) {
    // Per-repo coordinator: write settings (permissions + hooks) into the
    // coordinator's own agent dir, NOT the repo's .claude/settings.local.json.
    // Writing into the repo would pollute every non-coordinator Claude session
    // opened in that repo with coordinator-specific hooks.
    // The coordinator's claude process is launched with --settings pointing at
    // this file (see start.sh generation below).
    try {
      const coordSettings = await buildPerRepoCoordinatorSettings();
      const coordSettingsObj = {
        ...coordSettings,
        spinnerTipsEnabled: false,
        hooks: buildHooksBlock({
          agentId: id,
          includeStop: true,
          interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
          sessionStartIncludesAgentId: true,
        }),
      };
      await mkdir(join(agentDir, ".claude"), { recursive: true });
      await Bun.write(
        join(agentDir, ".claude", "settings.local.json"),
        JSON.stringify(coordSettingsObj, null, 2),
      );
    } catch { /* ignore */ }
  } else {
    // Non-worktree mode (non-coordinator): ensure ib permissions in root repo settings
    const rootSettingsPath = join(rootRepoPath, ".claude", "settings.local.json");
    try {
      const rootSettingsFile = Bun.file(rootSettingsPath);
      const settings = await rootSettingsFile.exists() ? await rootSettingsFile.json() : {};
      const allow = (settings?.permissions?.allow as string[]) ?? [];
      if (!allow.includes("Bash(ib:*)")) {
        allow.push("Bash(ib:*)");
      }
      settings.permissions = { ...settings.permissions, allow };
      await mkdir(join(rootRepoPath, ".claude"), { recursive: true });
      await Bun.write(rootSettingsPath, JSON.stringify(settings, null, 2));
    } catch { /* ignore */ }
  }

  // 14. meta.json was written early (before mkdir worktree) so the dashboard
  // does not flag the in-progress agent dir as orphaned during a slow
  // git worktree add. See the "Compute fields needed for the early meta.json
  // write" block above. Subsequent writers (start.sh → claude_pid, watchdog
  // spawn → watchdog_pid, generate-summary → summary, hook-status → state)
  // do read-modify-write so they merge cleanly with the early fields.

  // Log agent creation
  if (manager) {
    await logAgent(agentDir, `Agent created (manager: ${manager}, prompt: ${prompt})`);
    const managerDir = join(agentsDir, manager);
    await logAgent(managerDir, `Spawned ${typeName} subagent: ${id} (prompt: ${prompt})`);
  } else {
    await logAgent(agentDir, `Agent created (prompt: ${prompt})`);
  }

  // 16. Build prompt.txt
  const createPRs = config.createPullRequests?.value === true;
  let completionInstructions = "";

  if (useWorktree && !isLeafAgent) {
    // Check for gh and remote — independent probes, run concurrently
    const [hasGhResult, hasRemoteResult] = await Promise.all([
      newAgentSpawnCtx.run(["which", "gh"]),
      newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "remote"]),
    ]);
    const hasGh = hasGhResult.exitCode === 0;
    const hasRemote = hasRemoteResult.stdout.trim().length > 0;

    if (createPRs && hasGh && hasRemote) {
      completionInstructions = `\nWhen completing: after merging all sub-agents, create a pull request with \`gh pr create --title "<title>" --body "<description>"\`.`;
    }
  } else if (!useWorktree) {
    completionInstructions = `You are running as agent ${id} in the main repository (no worktree).
When your task is complete:
1. Commit any changes you made (git add && git commit)
2. Exit normally`;
  }

  // Custom prompts
  let customAllPrompt = "";
  if (customPrompts.all) {
    customAllPrompt = `[CUSTOM INSTRUCTIONS]\n${customPrompts.all}\n\n`;
  }

  // Custom role prompts are keyed by spawn capability: leaf agents (canSpawnChildren=false)
  // get worker prompts, non-leaf agents get manager prompts — regardless of custom type name
  let customRolePrompt = "";
  if (isLeafAgent && customPrompts.worker) {
    customRolePrompt = `[CUSTOM WORKER INSTRUCTIONS]\n${customPrompts.worker}\n\n`;
  } else if (!isLeafAgent && customPrompts.manager) {
    customRolePrompt = `[CUSTOM MANAGER INSTRUCTIONS]\n${customPrompts.manager}\n\n`;
  }

  const promptPrefix = `${completionInstructions ? completionInstructions + "\n" : ""}${customAllPrompt}${customRolePrompt}${prompt}`;

  const promptFile = join(agentDir, "prompt.txt");
  await Bun.write(promptFile, promptPrefix);

  // Build claude args
  let claudeArgs = "";
  if (yoloMode) {
    claudeArgs = "--dangerously-skip-permissions --permission-mode bypassPermissions";
  }
  if (printMode) {
    claudeArgs = claudeArgs ? `${claudeArgs} --print` : "--print";
  }
  if (allowTools) {
    claudeArgs = claudeArgs ? `${claudeArgs} --allowedTools ${allowTools}` : `--allowedTools ${allowTools}`;
  }
  if (denyTools) {
    claudeArgs = claudeArgs ? `${claudeArgs} --disallowedTools ${denyTools}` : `--disallowedTools ${denyTools}`;
  }
  if (model) {
    claudeArgs = claudeArgs ? `${claudeArgs} --model ${model}` : `--model ${model}`;
  }
  if (coordinatorMode) {
    // Load permissions + hooks from the coordinator's isolated settings file
    // so they don't pollute the repo's .claude/settings.local.json.
    const coordSettingsArg = shellQuote(join(agentDir, ".claude", "settings.local.json"));
    claudeArgs = claudeArgs ? `${claudeArgs} --settings ${coordSettingsArg}` : `--settings ${coordSettingsArg}`;
  }

  // 16. Write exit-check.sh
  const exitScript = join(agentDir, "exit-check.sh");
  const exitCheckContent = `#!/bin/bash
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Agent session ended - checking for uncommitted work..."
echo "═══════════════════════════════════════════════════════════"

# Check for uncommitted changes
if [[ -n $(git status --porcelain 2>/dev/null) ]]; then
    echo ""
    echo "⚠️  UNCOMMITTED CHANGES DETECTED"
    echo ""
    git status --short
    echo ""
    read -p "Commit these changes? [y/N] " commit_confirm
    if [[ "$commit_confirm" == [yY] || "$commit_confirm" == [yY][eE][sS] ]]; then
        read -p "Commit message: " commit_msg
        if [[ -n "$commit_msg" ]]; then
            git add -A && git commit -m "$commit_msg"
        else
            echo "No message provided, skipping commit."
        fi
    fi
fi

# Check for unpushed commits (only if remote exists)
if git remote | grep -q .; then
    local_commits=$(git log @{u}..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$local_commits" -gt 0 ]]; then
        echo ""
        echo "⚠️  UNPUSHED COMMITS: $local_commits commit(s) not pushed to remote"
        echo ""
        git log @{u}..HEAD --oneline
        echo ""
        read -p "Push to remote? [y/N] " push_confirm
        if [[ "$push_confirm" == [yY] || "$push_confirm" == [yY][eE][sS] ]]; then
            git push
        fi
    fi
fi

echo ""
echo "Agent session complete. Branch: $(git branch --show-current)"
echo "To merge this work: git checkout main && git merge $(git branch --show-current)"
echo ""
`;
  await Bun.write(exitScript, exitCheckContent);
  await chmod(exitScript, 0o755);

  // Write start.sh
  const absPromptFile = join(agentDir, "prompt.txt");
  const absExitScript = join(agentDir, "exit-check.sh");
  const startScript = join(agentDir, "start.sh");

  const qAbsPromptFile = shellQuote(absPromptFile);
  const qStartMetaJson = shellQuote(join(agentDir, "meta.json"));
  const qStartExitScript = shellQuote(absExitScript);
  const qStartAgentLog = shellQuote(join(agentDir, "agent.log"));
  const qStartStderrLog = shellQuote(join(agentDir, "claude.stderr.log"));
  const startContent = `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qStartAgentLog}
STDERR_LOG=${qStartStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start.sh] $1" >> "$AGENT_LOG"; }

log "Starting claude --session-id ${sessionUuid} ${claudeArgs}"
log "PWD=$(pwd) which_claude=$(which claude 2>&1)"

# Start Claude in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
: > "$STDERR_LOG"
claude --session-id "${sessionUuid}" ${claudeArgs} "$(cat ${qAbsPromptFile})" 2> "$STDERR_LOG" &
CLAUDE_PID=$!
log "Claude PID: $CLAUDE_PID"
trap 'log "script received SIGHUP — tmux pane killed or closed; sending SIGTERM to Claude PID=$CLAUDE_PID"; log "── SIGHUP diagnostics ──"; log "self ps: $(ps -o pid,ppid,pgid,sess,stat,command -p $$ 2>&1 | paste -sd "|" -)"; log "parent ps: $(ps -o pid,ppid,pgid,sess,stat,command -p $PPID 2>&1 | paste -sd "|" -)"; log "tmux processes: $(pgrep -lf tmux 2>&1 | head -20 | paste -sd "|" -)"; log "tmux list-sessions: $(tmux list-sessions 2>&1 | head -20 | paste -sd "|" -)"; log "── end SIGHUP diagnostics ──"; kill $CLAUDE_PID 2>/dev/null' HUP
trap 'log "script received SIGTERM; sending SIGTERM to Claude PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Claude PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json
META_JSON=${qStartMetaJson}
if [[ -f "$META_JSON" ]]; then
    bun -e "const f=process.argv[1];const m=JSON.parse(require('fs').readFileSync(f,'utf8'));m.claude_pid=String(process.argv[2]);require('fs').writeFileSync(f,JSON.stringify(m,null,2))" "$META_JSON" "$CLAUDE_PID"
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
${qStartExitScript}
`;
  await Bun.write(startScript, startContent);
  await chmod(startScript, 0o755);

  // 17. Init agent.log (already done via logAgent above)

  // Helper: clean up agent dir, worktree, and branch on failure
  async function cleanupOnFailure() {
    await rm(agentDir, { recursive: true, force: true });
    if (useWorktree) {
      await newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "worktree", "remove", join(agentDir, "repo"), "--force"]);
      await newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "branch", "-D", branchName]);
    }
  }

  // 18. Ensure tmux server is running
  const startServerResult = await timed("new-agent", "tmux-start-server", () =>
    newAgentSpawnCtx.run(["tmux", "start-server"])
  );
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux start-server → exit=${startServerResult.exitCode}${startServerResult.exitCode !== 0 && startServerResult.stderr ? ` stderr="${startServerResult.stderr.trim()}"` : ""}`);
  if (startServerResult.exitCode !== 0) {
    const err = startServerResult.stderr.trim();
    await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: could not start tmux server${err ? `: ${err}` : ""}`);
    await cleanupOnFailure();
    const suffix = err ? `: ${err}` : "";
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: could not start tmux server${suffix}` };
  }

  // Start tmux session — use saved layout width so it matches the dashboard pane.
  // Coordinators (system + per-repo) span middle+right and use mainWidth; regular
  // agents use the middle-pane width. The helper picks the right one.
  const absStartScript = join(agentDir, "start.sh");
  const newTmuxWidth = await getTmuxWidthForAgent(coordinatorMode);
  // Bracket-log the tmux session creation so a hang here is identifiable from
  // the agent.log alone (the "starting" line is the last entry on hang).
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux new-session starting: -s ${tmuxSession} -x ${newTmuxWidth}`);
  const tmuxResult = await timed("new-agent", "tmux-spawn", () =>
    newAgentSpawnCtx.run([
      "tmux", "new-session", "-d", "-x", String(newTmuxWidth), "-s", tmuxSession, "-c", workPath, shellQuote(absStartScript),
    ])
  );
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux new-session -s ${tmuxSession} -x ${newTmuxWidth} → exit=${tmuxResult.exitCode}${tmuxResult.exitCode !== 0 && tmuxResult.stderr ? ` stderr="${tmuxResult.stderr.trim()}"` : ""}`);
  if (tmuxResult.exitCode !== 0) {
    const err = tmuxResult.stderr.trim();
    await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: could not create tmux session '${tmuxSession}'${err ? `: ${err}` : ""}`);
    await cleanupOnFailure();
    const suffix = err ? `: ${err}` : "";
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: could not create tmux session '${tmuxSession}'${suffix}` };
  }
  // The two set-option calls, the pane-died hook, and the has-session verify
  // all depend on the session existing (above), but are independent of each
  // other — run together. The pane-died hook fires on every pane termination
  // (graceful or otherwise) and acts as a backstop for the case where the
  // bash wrapper itself dies before reaching its exit-log line. On normal
  // shutdowns it produces a redundant log line next to start.sh's "Claude
  // exited" — that's expected, not a sign of trouble.
  //
  // No timestamp is included in the message — the previous log line in
  // agent.log carries one, and embedding $(date) inside tmux's run-shell
  // argument requires fragile double-escaping. tmux only expands #{...}
  // format strings inside the run-shell body; the echo'd literal goes
  // straight to sh -c. agentDir is constrained by isValidShellPath so
  // shellQuote's single-quote wrapping is safe inside tmux's double quotes.
  const paneDiedHook = `run-shell "echo '[tmux pane-died] session=#{session_name} pane_dead_status=#{pane_dead_status} pane_dead_signal=#{pane_dead_signal}' >> ${shellQuote(join(agentDir, "agent.log"))}"`;
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux has-session verify starting: -t ${tmuxSession}`);
  const [, , , , verifyResult] = await Promise.all([
    newAgentSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "history-limit", "50000"]),
    newAgentSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "remain-on-exit", "on"]),
    // window-size manual prevents tmux from auto-resizing the window to the
    // latest attached client's terminal size. The dashboard sizes the session
    // to the saved pane width; the default ("latest") would silently shrink
    // it back when other clients attach/detach.
    newAgentSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "window-size", "manual"]),
    newAgentSpawnCtx.run(["tmux", "set-hook", "-t", tmuxSession, "pane-died", paneDiedHook]),
    // 19. Verify tmux session created
    newAgentSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]),
  ]);
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux has-session verify → exit=${verifyResult.exitCode}`);
  if (verifyResult.exitCode !== 0) {
    const err = verifyResult.stderr.trim();
    await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: tmux session '${tmuxSession}' failed to start${err ? `: ${err}` : ""}`);
    await cleanupOnFailure();
    const suffix = err ? `: ${err}` : "";
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: tmux session '${tmuxSession}' failed to start${suffix}` };
  }

  await logSpawn(agentDir, spawnerAgentDir, id, `spawn OK: agent ${id} running (tmux=${tmuxSession} workPath=${workPath})`);

  // 20. Output agent ID
  const stdout = id;

  // 21. Auto-accept workspace trust (if not yolo) — in background
  if (!yoloMode) {
    // Run async without awaiting — fire and forget
    autoAcceptWorkspaceTrustForNewAgent(tmuxSession).catch(() => {});
  }

  // 22. Auto-spawn per-agent watchdog
  await timed("new-agent", "watchdog-spawn", async () => {
    try {
      const watchdogLog = join(agentDir, "watchdog.log");
      let watchdogPid: number | undefined;

      if (watchdogSpawnOverride) {
        const result = watchdogSpawnOverride(id, rootRepoPath, watchdogLog);
        watchdogPid = result?.pid;
      } else {
        const watchdogProc = Bun.spawn(["ib", "watchdog", id], {
          cwd: rootRepoPath,
          stdout: Bun.file(watchdogLog),
          stderr: Bun.file(watchdogLog),
        });
        watchdogProc.unref();
        watchdogPid = watchdogProc.pid;
      }

      if (watchdogPid !== undefined) {
        const metaPath = join(agentDir, "meta.json");
        const metaContent = await Bun.file(metaPath).json().catch(() => null);
        if (metaContent) {
          metaContent.watchdog_pid = watchdogPid;
          await Bun.write(metaPath, JSON.stringify(metaContent, null, 2));
        }
        await logSpawn(agentDir, spawnerAgentDir, id, `watchdog spawned pid=${watchdogPid}`);
      }
    } catch (err) {
      await logSpawn(agentDir, spawnerAgentDir, id, `watchdog spawn failed: ${(err as Error)?.message ?? String(err)}`);
    }
  });

  // 23. Generate prompt summary in background (fire-and-forget)
  generatePromptSummary(agentDir).catch(() => {});

  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Spawn a detached subprocess to generate the prompt summary.
 * Uses the same pattern as the watchdog spawn (line ~1794): `ib generate-summary`
 * runs as a standalone subcommand so it survives after the parent calls process.exit().
 *
 * In test mode, calls a test override directly so tests can verify behavior
 * without a real subprocess.
 */
async function generatePromptSummary(agentDir: string): Promise<void> {
  // Test mode: call the override directly so tests can verify via mock
  if (summaryGeneratorOverride) {
    await summaryGeneratorOverride(agentDir);
    return;
  }

  // Production: spawn detached subprocess (survives parent process.exit())
  const proc = Bun.spawn(["ib", "generate-summary", agentDir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
}

/** Override for testing — set via setNewAgentSummaryGenerator / resetNewAgentSummaryGenerator */
let summaryGeneratorOverride: ((agentDir: string) => Promise<void>) | null = null;

/** Override the summary generator for testing. */
export function setNewAgentSummaryGenerator(fn: (agentDir: string) => Promise<void>): void {
  summaryGeneratorOverride = fn;
}

/** Reset the summary generator override. */
export function resetNewAgentSummaryGenerator(): void {
  summaryGeneratorOverride = null;
}

/**
 * Auto-accept workspace trust for newly created agents.
 * Uses the newAgent spawn runner for testability.
 */
async function autoAcceptWorkspaceTrustForNewAgent(tmuxSession: string): Promise<void> {
  const maxAttempts = 5;
  const maxWaitHalfSecs = 30;

  let startedWith = "";
  for (let i = 0; i < maxWaitHalfSecs; i++) {
    const delayMs = newAgentDelayOverrideMs !== null ? newAgentDelayOverrideMs : 500;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await newAgentSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const output = captureResult.stdout;
    if (output.includes("Claude Code v") || output.includes("[USER TASK]")) {
      startedWith = "logo";
      break;
    }
    if (/enter to confirm/i.test(output)) {
      if (
        /trust/i.test(output) ||
        /Allow external CLAUDE\.md file imports/i.test(output) ||
        /New MCP server found/i.test(output) ||
        /\d+ new MCP servers? found/i.test(output)
      ) {
        startedWith = "permissions";
        break;
      }
    }
  }

  if (startedWith !== "permissions") return;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await newAgentSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

    const delayMs = newAgentDelayOverrideMs !== null ? newAgentDelayOverrideMs : 4000;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await newAgentSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const recent = captureResult.stdout;
    let hasPermissions = false;
    if (/enter to confirm/i.test(recent)) {
      if (
        /trust/i.test(recent) ||
        /Allow external CLAUDE\.md file imports/i.test(recent) ||
        /New MCP server found/i.test(recent) ||
        /\d+ new MCP servers? found/i.test(recent)
      ) {
        hasPermissions = true;
      }
    }

    if (!hasPermissions) {
      for (let j = 0; j < maxWaitHalfSecs; j++) {
        const logoDelay = newAgentDelayOverrideMs !== null ? newAgentDelayOverrideMs : 500;
        if (logoDelay > 0) await Bun.sleep(logoDelay);

        const logoCapture = await newAgentSpawnCtx.run([
          "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
        ]);
        if (logoCapture.exitCode !== 0) continue;
        if (logoCapture.stdout.includes("Claude Code v") || logoCapture.stdout.includes("[USER TASK]")) {
          return;
        }
      }
    }
  }
}

/** Result of resolveAgentId */
export type ResolveAgentResult =
  | { resolved: string }
  | { error: string; matches: string[] };

/** Extract agent ID from a tmux session name (format: ittybitty-<repoid>-<agentid>) */
function extractAgentIdFromTmuxSession(sessionName: string): string | null {
  if (!sessionName.startsWith("ittybitty-")) return null;
  // Format: ittybitty-<8hexchars>-<agentid>
  // repoId is always exactly 8 hex characters (4 random bytes)
  const match = sessionName.match(/^ittybitty-[a-f0-9]{8}-(.+)$/);
  return match ? match[1]! : null;
}

/**
 * Resolve a partial agent ID to a full ID.
 * Mirrors resolve_agent_id() in ib bash.
 * Scans both agent directories and tmux sessions.
 *
 * @param tmuxLister - injectable for testing; defaults to listTmuxSessions
 */
export async function resolveAgentId(
  agentsDir: string,
  partial: string,
  tmuxLister: () => Promise<string[]> = listTmuxSessions,
): Promise<ResolveAgentResult> {
  // Exact match: check directory
  const exactDir = join(agentsDir, partial);
  if (await Bun.file(join(exactDir, "meta.json")).exists().catch(() => false)) {
    return { resolved: partial };
  }

  // Exact match: check tmux sessions for ittybitty-*-<partial>
  const sessions = await tmuxLister();
  for (const session of sessions) {
    const agentId = extractAgentIdFromTmuxSession(session);
    if (agentId === partial) {
      return { resolved: partial };
    }
  }

  // Partial/substring match: scan directories
  const matches = new Set<string>();
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.includes(partial)) {
        matches.add(entry.name);
      }
    }
  } catch { /* ignore */ }

  // Partial/substring match: scan tmux sessions
  for (const session of sessions) {
    if (!session.startsWith("ittybitty-")) continue;
    const agentId = extractAgentIdFromTmuxSession(session);
    if (agentId && agentId.includes(partial)) {
      matches.add(agentId);
    }
  }

  if (matches.size === 1) return { resolved: [...matches][0]! };
  if (matches.size === 0) return { error: "No matching agent found", matches: [] };
  return { error: "Ambiguous agent ID — multiple matches", matches: [...matches].sort() };
}

/** Pluggable spawn runner for diff/status — defaults to Bun.spawn, overridable for tests */
/** Spawn context for diff/status operations */
export const diffStatusSpawnCtx = new SpawnContext();

/** Override the diff/status spawn runner (for testing) */
export function setDiffStatusSpawnRunner(runner: SpawnFn): void {
  diffStatusSpawnCtx.set(runner);
}

/** Reset the diff/status spawn runner */
export function resetDiffStatusSpawnRunner(): void {
  diffStatusSpawnCtx.reset();
}

/**
 * Native diff implementation — replaces `ib diff <id>`.
 * Runs git merge-base HEAD main, then git diff <merge-base> in the agent worktree.
 */
export async function diffAgent(agent: Agent, opts?: { stat?: boolean }): Promise<IbCommandResult> {
  const worktreePath = join(agent.repoPath, ".ittybitty", "agents", agent.id, "repo");
  try {
    await readdir(worktreePath);
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has no worktree` };
  }

  const parentBranch = agent.meta.manager ? `agent/${agent.meta.manager}` : "main";
  const agentBranch = `agent/${agent.id}`;

  const mergeBase = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "merge-base", parentBranch, agentBranch]);
  if (mergeBase.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to find merge-base between ${parentBranch} and ${agentBranch}: ${mergeBase.stderr}` };
  }

  const diffCmd = opts?.stat
    ? ["git", "-C", worktreePath, "diff", "--stat", `${mergeBase.stdout}..${agentBranch}`]
    : ["git", "-C", worktreePath, "diff", `${mergeBase.stdout}..${agentBranch}`];
  const diff = await diffStatusSpawnCtx.run(diffCmd);
  return { ok: diff.exitCode === 0, exitCode: diff.exitCode, stdout: diff.stdout, stderr: diff.stderr };
}

/**
 * Diff the current working directory's branch against its merge-base.
 * Used when `ib diff` is run without an agent ID and outside an agent worktree.
 * Finds the merge-base of HEAD vs the default branch (main/master) and diffs against it.
 */
export async function diffCwd(opts?: { stat?: boolean }): Promise<IbCommandResult> {
  const cwd = process.cwd();

  // Determine the default branch (try main, then master)
  const symbolicRef = await diffStatusSpawnCtx.run(["git", "-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"]);
  let baseBranch = "main";
  if (symbolicRef.exitCode === 0 && symbolicRef.stdout) {
    const ref = symbolicRef.stdout.replace("refs/remotes/origin/", "");
    if (ref) baseBranch = ref;
  }

  // Get the current branch
  const headRef = await diffStatusSpawnCtx.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (headRef.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to determine current branch: ${headRef.stderr}` };
  }
  const currentBranch = headRef.stdout;

  // Find merge-base
  const mergeBase = await diffStatusSpawnCtx.run(["git", "-C", cwd, "merge-base", baseBranch, currentBranch]);
  if (mergeBase.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to find merge-base between ${baseBranch} and ${currentBranch}: ${mergeBase.stderr}` };
  }

  const diffCmd = opts?.stat
    ? ["git", "-C", cwd, "diff", "--stat", `${mergeBase.stdout}..HEAD`]
    : ["git", "-C", cwd, "diff", `${mergeBase.stdout}..HEAD`];
  const diff = await diffStatusSpawnCtx.run(diffCmd);
  return { ok: diff.exitCode === 0, exitCode: diff.exitCode, stdout: diff.stdout, stderr: diff.stderr };
}

/**
 * Native status implementation — replaces `ib status <id>`.
 * Shows header, commits vs parent branch, uncommitted changes, and file change summary.
 */
export async function statusAgent(agent: Agent): Promise<IbCommandResult> {
  const worktreePath = join(agent.repoPath, ".ittybitty", "agents", agent.id, "repo");
  try {
    await readdir(worktreePath);
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has no worktree` };
  }

  const agentBranch = `agent/${agent.id}`;
  const parentBranch = agent.meta.manager ? `agent/${agent.meta.manager}` : "main";
  const parts: string[] = [];

  // Header
  parts.push(`Agent: ${agent.id}`);
  parts.push(`Branch: ${agentBranch}`);
  parts.push(`Worktree: ${worktreePath}`);
  parts.push("");

  // Get merge-base
  const mb = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "merge-base", parentBranch, agentBranch]);
  if (mb.exitCode === 0 && mb.stdout) {
    // Commits
    const log = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "log", "--oneline", `${mb.stdout}..${agentBranch}`]);
    const commitLines = log.stdout ? log.stdout.split("\n") : [];
    const commitCount = commitLines.length;
    if (commitCount > 0) {
      parts.push(`═══ Commits (${commitCount}) vs ${parentBranch} ═══`);
      const formatted = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "log", "--format=  %h %s", `${mb.stdout}..${agentBranch}`]);
      if (formatted.stdout) parts.push(formatted.stdout);
      parts.push("");
    } else {
      parts.push(`═══ No commits vs ${parentBranch} ═══`);
      parts.push("");
    }
  }

  // Uncommitted changes
  const porcelain = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "status", "--porcelain"]);
  if (porcelain.stdout) {
    parts.push("═══ Uncommitted Changes ═══");
    const short = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "status", "--short"]);
    if (short.stdout) parts.push(short.stdout);
    parts.push("");
  }

  // File change summary
  if (mb.exitCode === 0 && mb.stdout) {
    const stat = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "diff", "--stat", `${mb.stdout}..${agentBranch}`]);
    if (stat.stdout) {
      const statLines = stat.stdout.split("\n");
      const summaryLine = statLines[statLines.length - 1]?.trim() ?? "";
      if (summaryLine && !summaryLine.includes("0 files changed")) {
        parts.push("═══ Files Changed ═══");
        parts.push(`  ${summaryLine}`);

        // Per-file details: numstat for line counts, name-status for status labels
        // Use a single combined call isn't possible, so run both with consistent filters
        const numstatResult = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "diff", "--numstat", "-M", `${mb.stdout}..${agentBranch}`]);
        const fileStats = new Map<string, { added: string; deleted: string }>();
        if (numstatResult.stdout) {
          for (const line of numstatResult.stdout.split("\n")) {
            if (!line.trim()) continue;
            // numstat format: <added>\t<deleted>\t<file>
            // For renames with -M: <added>\t<deleted>\t<old>{...=> ...}<new>
            const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
            if (match) {
              let filename = match[3]!;
              // Handle rename format: old/path/{old.ts => new.ts} or {old.ts => new.ts}
              const renameMatch = filename.match(/^(.*?)\{.+ => (.+?)\}(.*)$/);
              if (renameMatch) {
                filename = renameMatch[1]! + renameMatch[2]! + renameMatch[3]!;
              }
              fileStats.set(filename, { added: match[1]!, deleted: match[2]! });
            }
          }
        }

        const nameStatusResult = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "diff", "--name-status", "-M", `${mb.stdout}..${agentBranch}`]);
        const statusLabels = new Map<string, string>();
        if (nameStatusResult.stdout) {
          for (const line of nameStatusResult.stdout.split("\n")) {
            if (!line.trim()) continue;
            // name-status format: <code>[score]\t<file> or <code>[score]\t<old>\t<new>
            const renameMatch = line.match(/^[RC]\d*\t.+?\t(.+)$/);
            if (renameMatch) {
              statusLabels.set(renameMatch[1]!, line[0] === "R" ? "renamed" : "copied");
              continue;
            }
            const match = line.match(/^([ADMT])\d*\t(.+)$/);
            if (match) {
              const code = match[1]!;
              const label = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
              statusLabels.set(match[2]!, label);
            }
          }
        }

        if (fileStats.size > 0) {
          parts.push("");
          const files = [...fileStats.keys()].sort();
          const maxFileLen = Math.max(...files.map(f => f.length));
          for (const file of files) {
            const nums = fileStats.get(file)!;
            const label = statusLabels.get(file) ?? "modified";
            const added = nums.added !== "-" && nums.added !== "0" ? `+${nums.added}` : "";
            const deleted = nums.deleted !== "-" && nums.deleted !== "0" ? `-${nums.deleted}` : "";
            const counts = [added, deleted].filter(Boolean).join("/");
            const paddedFile = counts ? file.padEnd(maxFileLen) : file;
            parts.push(`  ${label.padEnd(8)} ${paddedFile}${counts ? ` (${counts})` : ""}`);
          }
        }
      }
    }
  }

  return { ok: true, exitCode: 0, stdout: parts.join("\n"), stderr: "" };
}

/**
 * Native pause implementation — replaces `ib pause <id>`.
 *
 * Sequence (mirrors cmd_pause in ib bash):
 * 1. Verify agent directory exists
 * 2. Kill Claude process (killAgentProcess)
 * 3. Kill tmux session
 * 4. Log 'Agent paused' to agent.log
 * Does NOT archive, remove worktree, or delete directory.
 */
export async function pauseAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const tmuxSession = agent.meta.tmux_session;

  // Check if agent directory exists
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // Check if agent is already stopped (mirrors bash cmd_pause validation)
  if (agent.state === "stopped") {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is already stopped` };
  }

  // Kill Claude process
  await logAgent(agentDir, `Pausing agent (state=${agent.state}, pid=${agent.meta.claude_pid ?? "none"}, tmux=${tmuxSession ?? "none"})`);
  const killed = await killAgentProcess(tmuxSession, { claude_pid: agent.meta.claude_pid });
  if (killed) {
    await logAgent(agentDir, "Terminated Claude process");
  } else {
    await logAgent(agentDir, "Claude process not running");
  }

  // Kill tmux session
  if (tmuxSession) {
    const proc = killPauseSpawnCtx.runner(
      ["tmux", "has-session", "-t", tmuxSession],
      { stdout: "pipe", stderr: "pipe" }
    );
    await new Response(proc.stderr).text(); // drain
    const hasSession = (await proc.exited) === 0;
    if (hasSession) {
      const killProc = killPauseSpawnCtx.runner(
        ["tmux", "kill-session", "-t", tmuxSession],
        { stdout: "pipe", stderr: "pipe" }
      );
      await new Response(killProc.stderr).text(); // drain
      await killProc.exited;
      await logAgent(agentDir, "Killed tmux session");
    } else {
      await logAgent(agentDir, "Tmux session already gone");
    }
  } else {
    await logAgent(agentDir, "No tmux session configured");
  }

  // Persist stopped state so resume's `state === "stopped"` guard is satisfied
  // and the fast-path in detectAgentStates() doesn't keep reporting the
  // pre-pause state (e.g. "complete") forever.
  await writeAgentState(agentDir, "stopped");

  // Log the pause
  await logAgent(agentDir, "Agent paused");

  return {
    ok: true,
    exitCode: 0,
    stdout: `Agent paused. Use 'ib resume ${agent.id}' to continue.`,
    stderr: "",
  };
}

/**
 * Native ask implementation — replaces `ib ask "question"`.
 * Top-level agents (no manager, or manager merged/killed) can ask the user a question.
 */
export async function askQuestion(repoPath: string, agentId: string, question: string): Promise<IbCommandResult> {
  // Verify agent exists
  const agentsDir = join(repoPath, ".ittybitty", "agents");
  const agentDir = join(agentsDir, agentId);
  const metaPath = join(agentDir, "meta.json");

  let meta: Record<string, unknown>;
  try {
    const file = Bun.file(metaPath);
    if (!(await file.exists())) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agentId}' not found` };
    }
    meta = await file.json();
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read agent metadata` };
  }

  // Top-level check: only agents with no manager (or whose manager is gone) may ask
  const managerId = meta.manager as string | undefined;
  if (managerId) {
    // Check if the manager's directory still exists (non-archived)
    const managerDir = join(agentsDir, managerId);
    const managerMetaFile = Bun.file(join(managerDir, "meta.json"));
    if (await managerMetaFile.exists()) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `Agent has a manager (${managerId}). Use 'ib send ${managerId} "message"' to communicate with your manager.`,
      };
    }
    // Manager dir doesn't exist → merged/killed/archived, allow asking
  }

  // Config check: allowAgentQuestions must be true
  const config = await readConfig();
  const allowQuestions = config.allowAgentQuestions?.value as boolean | undefined;
  if (allowQuestions === false) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent questions are disabled (allowAgentQuestions=false)" };
  }

  // Read or initialize user-questions.json
  const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");
  let data: { questions: any[] } = { questions: [] };
  try {
    const file = Bun.file(questionsPath);
    if (await file.exists()) {
      const parsed = await file.json();
      if (parsed && Array.isArray(parsed.questions)) {
        data = parsed;
      }
    }
  } catch { /* start fresh */ }

  // Clean up stale questions (agents whose directories no longer exist)
  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    const activeIds = new Set(agentEntries.filter(e => e.isDirectory()).map(e => e.name));
    data.questions = data.questions.filter((q: any) => activeIds.has(q.agent));
  } catch { /* ignore readdir failure */ }

  // Generate question ID: q-<unix-epoch>-<6-char-hash>
  const epoch = Math.floor(Date.now() / 1000);
  const hashInput = `${agentId}-${question}\n`;
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(hashInput);
  const hashHex = hasher.digest("hex");
  const questionId = `q-${epoch}-${hashHex.slice(0, 6)}`;

  // Append question
  data.questions.push({
    id: questionId,
    agent: agentId,
    question,
    timestamp: new Date().toISOString(),
    status: "pending",
  });

  await mkdir(join(repoPath, ".ittybitty"), { recursive: true });
  await Bun.write(questionsPath, JSON.stringify(data, null, 2) + "\n");

  // Log to agent's log
  await logAgent(agentDir, `Asked question: ${question} (${questionId})`);

  return { ok: true, exitCode: 0, stdout: `Question submitted (${questionId})`, stderr: "" };
}

/**
 * Native acknowledge implementation — replaces `ib acknowledge <questionId>`.
 * Reads user-questions.json, marks the question as acknowledged, writes back.
 */
export async function acknowledgeQuestion(repoPath: string, questionId: string): Promise<IbCommandResult> {
  const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");

  let data: { questions: any[] };
  try {
    const file = Bun.file(questionsPath);
    if (!(await file.exists())) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "No questions file found" };
    }
    data = await file.json();
    if (!data || !Array.isArray(data.questions)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "Malformed questions file" };
    }
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Failed to read questions file" };
  }

  const question = data.questions.find((q: any) => q.id === questionId);
  if (!question) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Question '${questionId}' not found` };
  }

  question.acknowledged_at = new Date().toISOString();
  question.status = "acknowledged";

  await Bun.write(questionsPath, JSON.stringify(data, null, 2) + "\n");

  return { ok: true, exitCode: 0, stdout: `Question acknowledged. Use 'ib send ${question.agent} "answer"' to respond.`, stderr: "" };
}

// ── Settings JSON helpers for hooks management ─────────────────────────────

/** Default global settings path: ~/.claude/settings.json */
function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Read and parse settings JSON, returning {} on missing/invalid */
async function readSettingsJson(settingsPath?: string): Promise<Record<string, unknown>> {
  const p = settingsPath ?? defaultSettingsPath();
  try {
    const file = Bun.file(p);
    if (await file.exists()) {
      return await file.json();
    }
  } catch { /* ignore */ }
  return {};
}

/** Write settings JSON back to the given path (or global default) */
async function writeSettingsJson(settings: Record<string, unknown>, settingsPath?: string): Promise<void> {
  const p = settingsPath ?? defaultSettingsPath();
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, JSON.stringify(settings, null, 2) + "\n");
}

/** Check if a hook array contains an entry whose command includes the given substring */
function hookArrayHasCommand(hookArray: unknown, substring: string): boolean {
  if (!Array.isArray(hookArray)) return false;
  for (const entry of hookArray) {
    const hooks = (entry as Record<string, unknown>)?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const cmd = (h as Record<string, unknown>)?.command;
      if (typeof cmd === "string" && cmd.includes(substring)) return true;
    }
  }
  return false;
}

/** Filter a hook array to remove entries whose command contains any of the given substrings */
function filterHookArray(hookArray: unknown, substrings: string[]): unknown[] {
  if (!Array.isArray(hookArray)) return [];
  return hookArray.filter((entry: unknown) => {
    const hooks = (entry as Record<string, unknown>)?.hooks;
    if (!Array.isArray(hooks)) return true;
    // Keep entry only if NONE of its hooks match any substring
    return hooks.every((h: unknown) => {
      const cmd = (h as Record<string, unknown>)?.command;
      if (typeof cmd !== "string") return true;
      return !substrings.some((sub) => cmd.includes(sub));
    });
  });
}

/** Remove empty hook arrays and empty hooks object from settings */
function cleanupHooksObject(settings: Record<string, unknown>): void {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return;
  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key]) && (hooks[key] as unknown[]).length === 0) {
      delete hooks[key];
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
}

// ── Hook detection predicates ───────────────────────────────────────────────

/** Check for main-path PreToolUse hook */
function hasMainPathHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  return hookArrayHasCommand(hooks?.PreToolUse, "ib hooks main-path");
}

/** Check for status injection hooks (UserPromptSubmit + PostToolUse, both must be present) */
function hasStatusHooks(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;
  return (
    hookArrayHasCommand(hooks.UserPromptSubmit, "ib hooks inject-status") &&
    hookArrayHasCommand(hooks.PostToolUse, "ib hooks inject-status")
  );
}

/** Check for session-start hook */
function hasSessionStartHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  return hookArrayHasCommand(hooks?.SessionStart, "ib hooks session-start");
}

/** Check for intercept-task hook */
function hasInterceptHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  return hookArrayHasCommand(hooks?.PreToolUse, "ib hooks intercept-task");
}

// ── Exported hooks management functions ─────────────────────────────────────

/** Returns "installed", "partial", or "not-installed" for safety hooks */
export async function hooksStatus(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);
  const hasMain = hasMainPathHook(settings);
  const hasStatus = hasStatusHooks(settings);
  const hasSession = hasSessionStartHook(settings);

  let status: string;
  if (hasMain && hasStatus && hasSession) {
    status = "installed";
  } else if (hasMain || hasStatus || hasSession) {
    status = "partial";
  } else {
    status = "not-installed";
  }
  return { ok: true, exitCode: 0, stdout: status, stderr: "" };
}

/** Returns "installed" or "not-installed" for the intercept hook */
export async function interceptHooksStatus(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);
  const status = hasInterceptHook(settings) ? "installed" : "not-installed";
  return { ok: true, exitCode: 0, stdout: status, stderr: "" };
}

/**
 * Install all safety hooks (path isolation + status injection + session-start). Idempotent.
 *
 * NOTE: Intentional divergence from bash `ib` — bash writes hooks to
 * `.claude/settings.local.json` (project-local), while this implementation
 * writes to `~/.claude/settings.json` (global). This was a deliberate change
 * in Phase 26c so itsybitsy's safety hooks apply to ALL Claude sessions,
 * not just ones launched from the itsybitsy project directory.
 */
export async function installSafetyHooks(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);
  const hooks = ((settings.hooks as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  settings.hooks = hooks;

  let installed = false;

  // Add main-path hook if not present
  if (!hasMainPathHook(settings)) {
    if (!Array.isArray(hooks.PreToolUse)) hooks.PreToolUse = [];
    (hooks.PreToolUse as unknown[]).push({
      matcher: "Bash",
      hooks: [{ type: "command", command: "ib hooks main-path" }],
    });
    installed = true;
  }

  // Add status hooks if not present
  if (!hasStatusHooks(settings)) {
    if (!Array.isArray(hooks.UserPromptSubmit)) hooks.UserPromptSubmit = [];
    if (!Array.isArray(hooks.PostToolUse)) hooks.PostToolUse = [];
    (hooks.UserPromptSubmit as unknown[]).push({
      hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }],
    });
    (hooks.PostToolUse as unknown[]).push({
      matcher: "Bash|Task",
      hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }],
    });
    installed = true;
  }

  // Add session-start hook if not present
  if (!hasSessionStartHook(settings)) {
    if (!Array.isArray(hooks.SessionStart)) hooks.SessionStart = [];
    (hooks.SessionStart as unknown[]).push({
      hooks: [{ type: "command", command: "ib hooks session-start" }],
    });
    installed = true;
  }

  if (!installed) {
    return { ok: true, exitCode: 0, stdout: "Hooks already installed", stderr: "" };
  }

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Hooks installed to ~/.claude/settings.json", stderr: "" };
}

/** Uninstall all safety hooks (removes entries matching hook substrings regardless of prefix). Idempotent. */
export async function uninstallSafetyHooks(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const resolvedPath = settingsPath ?? defaultSettingsPath();
  const file = Bun.file(resolvedPath);
  if (!(await file.exists().catch(() => false))) {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  let settings: Record<string, unknown>;
  try {
    settings = await file.json();
  } catch {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks) {
    // Remove main-path from PreToolUse
    if (hooks.PreToolUse) {
      hooks.PreToolUse = filterHookArray(hooks.PreToolUse, ["hooks main-path"]);
    }
    // Remove inject-status from UserPromptSubmit and PostToolUse
    if (hooks.UserPromptSubmit) {
      hooks.UserPromptSubmit = filterHookArray(hooks.UserPromptSubmit, ["hooks inject-status"]);
    }
    if (hooks.PostToolUse) {
      hooks.PostToolUse = filterHookArray(hooks.PostToolUse, ["hooks inject-status"]);
    }
    // Remove session-start from SessionStart
    if (hooks.SessionStart) {
      hooks.SessionStart = filterHookArray(hooks.SessionStart, ["hooks session-start"]);
    }
    cleanupHooksObject(settings);
  }

  // Delete file if settings is now empty, otherwise write back
  if (Object.keys(settings).length === 0) {
    await rm(resolvedPath).catch(() => {});
    return { ok: true, exitCode: 0, stdout: "Hooks uninstalled, removed empty settings file", stderr: "" };
  }

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Hooks uninstalled from ~/.claude/settings.json", stderr: "" };
}

/** Install task interception hook. Idempotent. */
export async function installInterceptHook(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);

  if (hasInterceptHook(settings)) {
    return { ok: true, exitCode: 0, stdout: "Task interception hook already installed", stderr: "" };
  }

  const hooks = ((settings.hooks as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  settings.hooks = hooks;
  if (!Array.isArray(hooks.PreToolUse)) hooks.PreToolUse = [];
  (hooks.PreToolUse as unknown[]).push({
    matcher: "Task|Agent|TaskCreate|AskUserQuestion",
    hooks: [{ type: "command", command: "ib hooks intercept-task" }],
  });

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Task interception hook installed to ~/.claude/settings.json", stderr: "" };
}

/** Uninstall task interception hook. Idempotent. */
export async function uninstallInterceptHook(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const resolvedPath = settingsPath ?? defaultSettingsPath();
  const file = Bun.file(resolvedPath);
  if (!(await file.exists().catch(() => false))) {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  let settings: Record<string, unknown>;
  try {
    settings = await file.json();
  } catch {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks && hooks.PreToolUse) {
    hooks.PreToolUse = filterHookArray(hooks.PreToolUse, ["hooks intercept-task"]);
    cleanupHooksObject(settings);
  }

  if (Object.keys(settings).length === 0) {
    await rm(resolvedPath).catch(() => {});
    return { ok: true, exitCode: 0, stdout: "Task interception hook uninstalled, removed empty settings file", stderr: "" };
  }

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Task interception hook uninstalled from ~/.claude/settings.json", stderr: "" };
}

/**
 * Outbound `ib tgsend` — file-drop client for the `ib watch` outbox.
 *
 * Phase B refactor: `ib tgsend` no longer talks to Telegram directly. It
 * writes the message text to `~/.itsybitsy/channels/telegram/outbox/` and
 * polls for a `<stem>.txt.result` file containing the JSON outcome from
 * `ib watch`'s outbox processor. If `ib watch` is not running (or Telegram
 * is not configured), no result will appear; we time out after 1s and
 * return an "ok-but-queued" outcome so the caller exits 0 — the message is
 * legitimately waiting on disk and `ib watch` will pick it up next start.
 */
export async function telegramSend(text: string): Promise<{ ok: boolean; message: string }> {
  const { defaultOutboxDir } = await import("./channels/outbox");
  const { mkdir, rename, readFile, unlink } = await import("fs/promises");
  const { randomBytes } = await import("crypto");
  const { join } = await import("path");

  const dir = defaultOutboxDir();
  const stem = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const txtPath = join(dir, `${stem}.txt`);
  const tmpPath = `${txtPath}.tmp`;
  const resultPath = `${txtPath}.result`;

  await mkdir(dir, { recursive: true });
  await Bun.write(tmpPath, text);
  await rename(tmpPath, txtPath);

  // Poll up to 1s for the result file. 100ms cadence keeps the small-message
  // happy path fast (one round trip is typically <100ms) without spinning.
  const POLL_INTERVAL_MS = 100;
  const POLL_ATTEMPTS = 10;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let resultText: string;
    try {
      resultText = await readFile(resultPath, "utf8");
    } catch {
      continue;
    }
    let parsed: { ok: boolean; message: string };
    try {
      parsed = JSON.parse(resultText) as { ok: boolean; message: string };
    } catch {
      // Malformed result — treat as transient and keep polling. The outbox
      // processor writes valid JSON or nothing.
      continue;
    }
    // Best-effort delete of the .result; the outbox cleans up after 5s anyway.
    await unlink(resultPath).catch(() => { /* ignore */ });
    return { ok: !!parsed.ok, message: String(parsed.message ?? "") };
  }

  return {
    ok: true,
    message: "queued (ib watch may not be running, or Telegram is not configured)",
  };
}

