/**
 * Async wrappers for ib mutation commands.
 * Every command runs with cwd set to the agent's repoPath.
 * kill, pause, sendMessage, nuke, resume, and merge are implemented natively; others delegate to ib CLI.
 */

import { join } from "path";
import { readdir, chmod, rm } from "fs/promises";
import type { Agent } from "./agents";
import {
  logAgent,
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
import type { SpawnFn } from "./types";

export interface IbCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Pluggable runner — defaults to Bun.spawn, overridable for tests */
export type IbRunner = (args: string[], cwd: string) => Promise<IbCommandResult>;

const defaultRunner: IbRunner = async (args, cwd) => {
  const proc = Bun.spawn(["ib", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

let currentRunner: IbRunner = defaultRunner;

/** Override the runner (for testing) */
export function setRunner(runner: IbRunner) {
  currentRunner = runner;
}

/** Reset to the default Bun.spawn runner */
export function resetRunner() {
  currentRunner = defaultRunner;
}

async function runIb(args: string[], cwd: string): Promise<IbCommandResult> {
  return currentRunner(args, cwd);
}

/** Pluggable spawn runner for kill/pause — defaults to Bun.spawn, overridable for tests */
let killPauseSpawnRunner: SpawnFn = Bun.spawn as SpawnFn;

/** Override the kill/pause spawn runner (for testing) */
export function setKillPauseSpawnRunner(runner: SpawnFn): void {
  killPauseSpawnRunner = runner;
}

/** Reset the kill/pause spawn runner */
export function resetKillPauseSpawnRunner(): void {
  killPauseSpawnRunner = Bun.spawn as SpawnFn;
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
      const proc = killPauseSpawnRunner(
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

/** Pluggable spawn runner for nuke/resume — defaults to Bun.spawn, overridable for tests */
let nukeResumeSpawnRunner: SpawnFn = Bun.spawn as SpawnFn;
/** Override delay for resume tests (null = use real delay) */
let resumeDelayOverrideMs: number | null = null;

/** Override the nuke/resume spawn runner (for testing). Sets delay to 0 by default. */
export function setNukeResumeSpawnRunner(runner: SpawnFn): void {
  nukeResumeSpawnRunner = runner;
  resumeDelayOverrideMs = 0;
}

/** Reset the nuke/resume spawn runner */
export function resetNukeResumeSpawnRunner(): void {
  nukeResumeSpawnRunner = Bun.spawn as SpawnFn;
  resumeDelayOverrideMs = null;
}

/**
 * Helper: run a command via the nuke/resume spawn runner and return { stdout, exitCode }.
 */
async function nukeResumeRunCmd(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = nukeResumeSpawnRunner(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
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
  const listResult = await nukeResumeRunCmd(["tmux", "list-sessions", "-F", "#{session_name}"]);
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
      const killResult = await nukeResumeRunCmd(["tmux", "kill-session", "-t", session]);
      if (killResult.exitCode === 0) cleaned++;
    }
  }

  return cleaned;
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

  let killed = 0;
  let failed = 0;

  for (const id of descendants) {
    const agentDir = join(agentsDir, id);
    // Skip if directory doesn't exist
    try {
      await readdir(agentDir);
    } catch {
      continue;
    }

    // Remove questions
    await removeAgentQuestions(agent.repoPath, id);

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
      await teardownAgent(agent.repoPath, id, agentDir, meta, "Agent nuked");
      killed++;
    } catch {
      failed++;
    }
  }

  // Clean up orphaned tmux sessions
  const orphansKilled = await cleanupOrphanedTmuxSessions(agentsDir);

  // Scan for orphaned Claude processes
  if (killed > 0 || orphansKilled > 0) {
    await scanAndKillOrphans(agentsDir);
  }

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

  let killed = 0;
  let failed = 0;

  for (const id of agentsToKill) {
    const agentDir = join(agentsDir, id);

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
    } catch {
      failed++;
    }
  }

  // Clean up orphaned tmux sessions
  const orphansKilled = await cleanupOrphanedTmuxSessions(agentsDir);

  // Scan for orphaned Claude processes
  if (killed > 0 || orphansKilled > 0) {
    await scanAndKillOrphans(agentsDir);
  }

  if (failed > 0 && killed === 0 && agentsToKill.length > 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `All ${failed} agent(s) failed to kill` };
  }

  let stdout = `Nuked ${killed} agent(s)`;
  if (orphansKilled > 0) stdout += `, cleaned ${orphansKilled} orphaned session(s)`;
  if (failed > 0) stdout += ` (${failed} failed)`;

  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Native resume implementation — replaces `ib resume <id>`.
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
 */
export async function resumeAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);

  // Check agent directory exists
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // Must be stopped
  if (agent.state !== "stopped") {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is not stopped (current state: ${agent.state})` };
  }

  // Read session_id from meta.json
  const sessionId = agent.meta.session_id;
  if (!sessionId || sessionId === "null") {
    return { ok: false, exitCode: 1, stdout: "", stderr: "No session_id found in meta.json" };
  }

  // Read model
  const model = agent.meta.model && agent.meta.model !== "null" ? agent.meta.model : "";

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

  // Get git root for PATH
  const gitRoot = await resolveGitRoot(agent.repoPath) || agent.repoPath;

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

  // Write resume.sh
  const resumeScript = join(agentDir, "resume.sh");
  const resumeContent = `#!/bin/bash
# Add git repo root to PATH so 'ib' is available
export PATH="${gitRoot}:$PATH"

# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

# Start Claude in background and capture PID
claude --resume "${sessionId}" ${claudeArgs} &
CLAUDE_PID=$!

# Store PID in meta.json using sed (no jq dependency)
# This adds claude_pid field to existing JSON
if [[ -f "${agentDir}/meta.json" ]]; then
    # Insert claude_pid before the closing brace
    sed -i '' "s/}$/,\\n  \\"claude_pid\\": \\"$CLAUDE_PID\\"\\n}/" "${agentDir}/meta.json"
fi

# Wait for Claude to complete
wait $CLAUDE_PID

# Run exit check
${absExitScript}
`;
  await Bun.write(resumeScript, resumeContent);
  await chmod(resumeScript, 0o755);

  // Ensure tmux server is running
  const startServerResult = await nukeResumeRunCmd(["tmux", "start-server"]);
  if (startServerResult.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Could not start tmux server" };
  }

  // Start tmux session
  const tmuxSession = agent.meta.tmux_session;
  const tmuxResult = await nukeResumeRunCmd([
    "tmux", "new-session", "-d", "-x", "60", "-s", tmuxSession, "-c", workPath, resumeScript,
  ]);
  if (tmuxResult.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Could not create tmux session '${tmuxSession}'` };
  }

  // Auto-accept workspace trust if not yolo (poll tmux for trust prompts)
  // Must complete before sending nudge to avoid corrupting the permissions flow
  if (!yoloMode) {
    await autoAcceptWorkspaceTrust(tmuxSession);
  }

  // Send resume nudge after short delay
  const nudgeDelayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 100;
  if (nudgeDelayMs > 0) await Bun.sleep(nudgeDelayMs);

  const nudgePrompt = "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line.";
  await nukeResumeRunCmd(["tmux", "send-keys", "-t", tmuxSession, nudgePrompt]);

  const nudgeSleepMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 100;
  if (nudgeSleepMs > 0) await Bun.sleep(nudgeSleepMs);

  await nukeResumeRunCmd(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

  // Log
  await logAgent(agentDir, "Agent resumed");
  await logAgent(agentDir, "Sent resume nudge");

  return { ok: true, exitCode: 0, stdout: `Use 'ib look ${agent.id}' to view output`, stderr: "" };
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

    const captureResult = await nukeResumeRunCmd([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const output = captureResult.stdout;
    // Check for logo or [USER TASK]
    if (output.includes("Claude Code v") || output.includes("[USER TASK]")) {
      startedWith = "logo";
      break;
    }
    // Check for permissions screens
    if (/enter to confirm/i.test(output)) {
      if (/trust/i.test(output) || /Allow external CLAUDE\.md file imports/i.test(output)) {
        startedWith = "permissions";
        break;
      }
    }
  }

  // If logo appeared directly, no permissions needed
  if (startedWith !== "permissions") return;

  // Accept permissions (may need multiple Enter presses)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await nukeResumeRunCmd(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

    const delayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 4000;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await nukeResumeRunCmd([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const recent = captureResult.stdout;

    // Check if permissions prompt is still active
    let hasPermissions = false;
    if (/enter to confirm/i.test(recent)) {
      if (/trust/i.test(recent) || /Allow external CLAUDE\.md file imports/i.test(recent)) {
        hasPermissions = true;
      }
    }

    if (!hasPermissions) {
      // Wait for logo to confirm success
      for (let j = 0; j < maxWaitHalfSecs; j++) {
        const logoDelay = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 500;
        if (logoDelay > 0) await Bun.sleep(logoDelay);

        const logoCapture = await nukeResumeRunCmd([
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

export async function reassignAgent(agent: Agent, newManager: string | null): Promise<IbCommandResult> {
  if (newManager === null) {
    return runIb(["reassign", agent.id, "--none"], agent.repoPath);
  }
  return runIb(["reassign", agent.id, newManager], agent.repoPath);
}

export async function mergeCheckAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["merge-check", agent.id], agent.repoPath);
}

/** Pluggable spawn runner for merge — defaults to Bun.spawn, overridable for tests */
let mergeSpawnRunner: SpawnFn = Bun.spawn as SpawnFn;

/** Override the merge spawn runner (for testing) */
export function setMergeSpawnRunner(runner: SpawnFn): void {
  mergeSpawnRunner = runner;
}

/** Reset the merge spawn runner */
export function resetMergeSpawnRunner(): void {
  mergeSpawnRunner = Bun.spawn as SpawnFn;
}

/**
 * Helper: run a command via the merge spawn runner and return { stdout, exitCode }.
 */
async function mergeRunCmd(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = mergeSpawnRunner(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
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
  const createBranch = await mergeRunCmd(["git", "-C", repoPath, "branch", tempBranch, sourceBranch]);
  if (createBranch.exitCode !== 0) {
    return { ok: false, output: "Could not create temp branch for conflict check" };
  }

  // Create temp worktree
  const createWorktree = await mergeRunCmd(["git", "-C", repoPath, "worktree", "add", tempDir, tempBranch, "--quiet"]);
  if (createWorktree.exitCode !== 0) {
    await mergeRunCmd(["git", "-C", repoPath, "branch", "-D", tempBranch]);
    return { ok: false, output: "Could not create temp worktree for conflict check" };
  }

  // Attempt rebase in temp worktree
  const rebaseResult = await mergeRunCmd(["git", "-C", tempDir, "rebase", targetBranch]);
  let result: { ok: boolean; output: string };

  if (rebaseResult.exitCode !== 0) {
    // Abort the failed rebase
    await mergeRunCmd(["git", "-C", tempDir, "rebase", "--abort"]);
    result = { ok: false, output: rebaseResult.stdout };
  } else {
    result = { ok: true, output: "" };
  }

  // Clean up: remove temp worktree and branch
  await mergeRunCmd(["git", "-C", repoPath, "worktree", "remove", tempDir, "--force"]);
  await mergeRunCmd(["git", "-C", repoPath, "branch", "-D", tempBranch]);

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
export async function mergeAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");
  const branchName = `agent/${agent.id}`;
  const worktreePath = join(agentDir, "repo");
  const tmuxSession = agent.meta.tmux_session;

  // 1. Agent dir must exist
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // 2. Agent must have a worktree
  try {
    await readdir(worktreePath);
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has no worktree (was created with --no-worktree?)` };
  }

  // 3. Agent worktree must have no uncommitted changes
  const worktreeStatus = await mergeRunCmd(["git", "-C", worktreePath, "status", "--porcelain"]);
  if (worktreeStatus.exitCode === 0 && worktreeStatus.stdout.trim()) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has uncommitted changes` };
  }

  // 4. Detect target branch
  let targetBranch = "";
  const currentBranch = await mergeRunCmd(["git", "-C", agent.repoPath, "branch", "--show-current"]);
  if (currentBranch.exitCode === 0 && currentBranch.stdout.trim()) {
    targetBranch = currentBranch.stdout.trim();
  }
  if (!targetBranch) {
    const mainRef = await mergeRunCmd(["git", "-C", agent.repoPath, "show-ref", "--verify", "refs/heads/main"]);
    if (mainRef.exitCode === 0) {
      targetBranch = "main";
    } else {
      const masterRef = await mergeRunCmd(["git", "-C", agent.repoPath, "show-ref", "--verify", "refs/heads/master"]);
      if (masterRef.exitCode === 0) {
        targetBranch = "master";
      } else {
        return { ok: false, exitCode: 1, stdout: "", stderr: "Could not determine target branch (detached HEAD with no main/master)" };
      }
    }
  }

  // 5. Agent branch must exist
  const branchRef = await mergeRunCmd(["git", "-C", agent.repoPath, "show-ref", "--verify", `refs/heads/${branchName}`]);
  if (branchRef.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Branch '${branchName}' does not exist` };
  }

  // 6. Current dir must have no uncommitted changes
  const repoStatus = await mergeRunCmd(["git", "-C", agent.repoPath, "status", "--porcelain"]);
  if (repoStatus.exitCode === 0 && repoStatus.stdout.trim()) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Current directory has uncommitted changes" };
  }

  // 7. Pre-rebase conflict check
  const conflictResult = await checkRebaseConflicts(agent.repoPath, targetBranch, branchName);
  if (!conflictResult.ok) {
    await logAgent(agentDir, `Pre-rebase conflict check failed - conflicts detected with ${targetBranch}`);
    return {
      ok: false, exitCode: 1, stdout: "",
      stderr: `Rebase conflict detected between '${branchName}' and '${targetBranch}'`,
    };
  }

  // Count commits to merge
  const logResult = await mergeRunCmd(["git", "-C", agent.repoPath, "log", `${targetBranch}..${branchName}`, "--oneline"]);
  const commitCount = logResult.stdout.trim() ? logResult.stdout.trim().split("\n").length : 0;

  await logAgent(agentDir, `Starting rebase of ${branchName} onto ${targetBranch} (${commitCount} commits)`);

  if (commitCount > 0) {
    // 8. Rebase agent branch onto target (in agent's worktree)
    await logAgent(agentDir, `Rebasing ${branchName} onto ${targetBranch}...`);
    const rebaseResult = await mergeRunCmd(["git", "-C", worktreePath, "rebase", targetBranch]);
    if (rebaseResult.exitCode !== 0) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Rebase failed: ${rebaseResult.stdout}` };
    }
    await logAgent(agentDir, "Rebase completed successfully");

    // 9. Checkout target branch
    await logAgent(agentDir, `Checking out ${targetBranch}...`);
    const checkoutResult = await mergeRunCmd(["git", "-C", agent.repoPath, "checkout", targetBranch]);
    if (checkoutResult.exitCode !== 0) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Could not checkout ${targetBranch}: ${checkoutResult.stdout}` };
    }

    // 10. Merge — ff-only if agent, --no-ff if user
    const runningAsAgent = await isRunningAsAgent();
    if (runningAsAgent) {
      await logAgent(agentDir, `Fast-forwarding ${targetBranch} to ${branchName}...`);
      const ffResult = await mergeRunCmd(["git", "-C", agent.repoPath, "merge", "--ff-only", branchName]);
      if (ffResult.exitCode !== 0) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Fast-forward failed: ${ffResult.stdout}` };
      }
      await logAgent(agentDir, "Fast-forward merge completed successfully");
    } else {
      await logAgent(agentDir, `Merging ${branchName} with --no-ff...`);
      const noFFResult = await mergeRunCmd(["git", "-C", agent.repoPath, "merge", "--no-ff", branchName, "-m", `Merge agent ${agent.id} work`]);
      if (noFFResult.exitCode !== 0) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Merge failed: ${noFFResult.stdout}` };
      }
      await logAgent(agentDir, "Merge completed successfully");
    }
  }

  // 11. Capture tmux output before killing
  await logAgent(agentDir, "Capturing tmux output...");
  if (tmuxSession) {
    const hasSession = await mergeRunCmd(["tmux", "has-session", "-t", tmuxSession]);
    if (hasSession.exitCode === 0) {
      await captureTmuxOutputToFile(tmuxSession, join(agentDir, "output.log"));
    }
  }

  // 12. Kill Claude process
  await logAgent(agentDir, "Terminating Claude process...");
  const killed = await killAgentProcess(tmuxSession, { claude_pid: agent.meta.claude_pid });
  if (killed) {
    await logAgent(agentDir, "Claude process terminated");
  }

  // 13. Kill tmux session
  if (tmuxSession) {
    const hasSession2 = await mergeRunCmd(["tmux", "has-session", "-t", tmuxSession]);
    if (hasSession2.exitCode === 0) {
      await mergeRunCmd(["tmux", "kill-session", "-t", tmuxSession]);
      await logAgent(agentDir, "Tmux session stopped");
    }
  }

  // 14. Copy settings.local.json from worktree before removing
  const settingsPath = join(worktreePath, ".claude", "settings.local.json");
  try {
    if (await Bun.file(settingsPath).exists()) {
      const content = await Bun.file(settingsPath).text();
      await Bun.write(join(agentDir, "settings.local.json"), content);
    }
  } catch { /* ignore */ }

  // 15. Remove worktree
  await logAgent(agentDir, "Removing worktree...");
  const removeResult = await mergeRunCmd(["git", "-C", agent.repoPath, "worktree", "remove", worktreePath, "--force"]);
  if (removeResult.exitCode !== 0) {
    try { await rm(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  await logAgent(agentDir, "Worktree removed");

  // 16. Delete branch
  await logAgent(agentDir, `Deleting branch ${branchName}...`);
  const deleteBranch = await mergeRunCmd(["git", "-C", agent.repoPath, "branch", "-D", branchName]);
  if (deleteBranch.exitCode === 0) {
    await logAgent(agentDir, `Branch deleted: ${branchName}`);
  }

  // 17. Archive artifacts
  await logAgent(agentDir, "Merge complete - archiving and closing agent");
  await archiveAgent(agent.repoPath, agent.id, agentDir);

  // 18. Remove questions
  await removeAgentQuestions(agent.repoPath, agent.id);

  // 19. Remove agent directory
  try { await rm(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // 20. Scan for orphaned Claude processes
  await scanAndKillOrphans(agentsDir);

  return { ok: true, exitCode: 0, stdout: `Closed agent: ${agent.id}`, stderr: "" };
}

/** Pluggable spawn runner for send — defaults to Bun.spawn, overridable for tests */
let sendSpawnRunner: SpawnFn = Bun.spawn as SpawnFn;
/** Override delay for tests (null = use calculated delay) */
let sendDelayOverrideMs: number | null = null;

/** Override the send spawn runner (for testing). Sets delay to 0 by default. */
export function setSendSpawnRunner(runner: SpawnFn): void {
  sendSpawnRunner = runner;
  sendDelayOverrideMs = 0;
}

/** Reset the send spawn runner */
export function resetSendSpawnRunner(): void {
  sendSpawnRunner = Bun.spawn as SpawnFn;
  sendDelayOverrideMs = null;
}

/**
 * Send a message to an agent's tmux session (native implementation).
 *
 * Steps:
 * 1. Read tmux_session from agent meta
 * 2. Verify tmux session exists
 * 3. Auto-detect sender from cwd if applicable
 * 4. Format message with [sent by agent ...] prefix if sender detected
 * 5. Calculate delay: 0.1 + (msg_len / 100) * 0.5, clamped to [0.2, 3.0]
 * 6. Send via tmux send-keys, sleep, Enter
 * 7. Log to recipient's agent.log
 */
export async function sendMessage(
  agent: Agent,
  message: string,
  opts?: { fromAgent?: string; cwd?: string }
): Promise<IbCommandResult> {
  const tmuxSession = agent.meta.tmux_session;
  if (!tmuxSession) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent has no tmux session" };
  }

  // Verify session exists
  const hasSessionProc = sendSpawnRunner(
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
    }
  }

  // Format message with sender prefix
  let fullMessage = message;
  if (fromId) {
    fullMessage = `[sent by agent ${fromId}]: ${message}`;
  }

  // Calculate delay: 0.1 + (len / 100) * 0.5, clamped [0.2, 3.0]
  const msgLen = fullMessage.length;
  let delay = 0.1 + (msgLen / 100) * 0.5;
  if (delay < 0.2) delay = 0.2;
  if (delay > 3.0) delay = 3.0;

  // Send via tmux send-keys
  const sendProc = sendSpawnRunner(
    ["tmux", "send-keys", "-t", tmuxSession, fullMessage],
    { stdout: "pipe", stderr: "pipe" }
  );
  const sendStderr = await new Response(sendProc.stderr).text();
  const sendExit = await sendProc.exited;
  if (sendExit !== 0) {
    return { ok: false, exitCode: sendExit, stdout: "", stderr: sendStderr.trim() };
  }

  // Sleep for calculated delay (skippable in tests)
  const actualDelayMs = sendDelayOverrideMs !== null ? sendDelayOverrideMs : delay * 1000;
  if (actualDelayMs > 0) await Bun.sleep(actualDelayMs);

  // Send Enter
  const enterProc = sendSpawnRunner(
    ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
    { stdout: "pipe", stderr: "pipe" }
  );
  await new Response(enterProc.stderr).text(); // drain
  await enterProc.exited;

  // Log to recipient's agent.log
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  if (fromId) {
    await logAgent(agentDir, `Received message from ${fromId}: ${message}`);
  } else {
    await logAgent(agentDir, `Received message: ${message}`);
  }

  // Log to sender's agent.log if applicable
  if (fromId) {
    const senderDir = join(agent.repoPath, ".ittybitty", "agents", fromId);
    await logAgent(senderDir, `Sent message to ${agent.id}: ${message}`);
  }

  const stdout = fromId ? "" : `Sent to ${agent.id}`;
  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

export interface NewAgentOptions {
  name?: string;
  worker?: boolean;
  yolo?: boolean;
  model?: string;
  manager?: string;
}

export async function newAgent(
  repoPath: string,
  prompt: string,
  opts?: NewAgentOptions
): Promise<IbCommandResult> {
  const args = ["new-agent"];
  if (opts?.name) args.push("--name", opts.name);
  if (opts?.worker) args.push("--worker");
  if (opts?.yolo) args.push("--yolo");
  if (opts?.model) args.push("--model", opts.model);
  if (opts?.manager) args.push("--manager", opts.manager);
  args.push(prompt);
  return runIb(args, repoPath);
}

export async function diffAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["diff", agent.id], agent.repoPath);
}

export async function statusAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["status", agent.id], agent.repoPath);
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
  const killed = await killAgentProcess(tmuxSession, { claude_pid: agent.meta.claude_pid });
  if (killed) {
    await logAgent(agentDir, "Terminated Claude process");
  }

  // Kill tmux session
  if (tmuxSession) {
    const proc = killPauseSpawnRunner(
      ["tmux", "has-session", "-t", tmuxSession],
      { stdout: "pipe", stderr: "pipe" }
    );
    await new Response(proc.stderr).text(); // drain
    const hasSession = (await proc.exited) === 0;
    if (hasSession) {
      const killProc = killPauseSpawnRunner(
        ["tmux", "kill-session", "-t", tmuxSession],
        { stdout: "pipe", stderr: "pipe" }
      );
      await new Response(killProc.stderr).text(); // drain
      await killProc.exited;
      await logAgent(agentDir, "Killed tmux session");
    }
  }

  // Log the pause
  await logAgent(agentDir, "Agent paused");

  return {
    ok: true,
    exitCode: 0,
    stdout: `Agent paused. Use 'ib resume ${agent.id}' to continue.`,
    stderr: "",
  };
}

export async function acknowledgeQuestion(repoPath: string, questionId: string): Promise<IbCommandResult> {
  return runIb(["acknowledge", questionId], repoPath);
}

/** Returns "installed", "partial", or "not-installed" */
export async function hooksStatus(repoPath: string): Promise<IbCommandResult> {
  return runIb(["hooks", "status"], repoPath);
}

/** Returns "installed" or "not-installed" for the intercept hook */
export async function interceptHooksStatus(repoPath: string): Promise<IbCommandResult> {
  return runIb(["hooks", "status", "--intercept"], repoPath);
}

/** Install all safety hooks (path isolation + status injection + session-start) */
export async function installSafetyHooks(repoPath: string): Promise<IbCommandResult> {
  return runIb(["hooks", "install"], repoPath);
}

/** Uninstall all safety hooks */
export async function uninstallSafetyHooks(repoPath: string): Promise<IbCommandResult> {
  return runIb(["hooks", "uninstall"], repoPath);
}

/** Install task interception hook */
export async function installInterceptHook(repoPath: string): Promise<IbCommandResult> {
  return runIb(["hooks", "install-intercept"], repoPath);
}

/** Uninstall task interception hook */
export async function uninstallInterceptHook(repoPath: string): Promise<IbCommandResult> {
  return runIb(["hooks", "uninstall-intercept"], repoPath);
}

/** Check if .ittybitty is in .gitignore */
export async function checkGitignoreHasIttybitty(repoPath: string): Promise<boolean> {
  try {
    const gitignoreFile = Bun.file(`${repoPath}/.gitignore`);
    if (await gitignoreFile.exists()) {
      const content = await gitignoreFile.text();
      return content.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === ".ittybitty" || trimmed === ".ittybitty/" || trimmed === "/.ittybitty" || trimmed === "/.ittybitty/";
      });
    }
  } catch { /* ignore */ }
  return false;
}

/** Add or remove .ittybitty/ from .gitignore */
export async function toggleGitignore(repoPath: string, currentlyInstalled: boolean): Promise<{ ok: boolean; message: string }> {
  const gitignorePath = `${repoPath}/.gitignore`;
  try {
    if (currentlyInstalled) {
      const file = Bun.file(gitignorePath);
      if (await file.exists()) {
        const content = await file.text();
        const filtered = content.split("\n").filter((line) => {
          const trimmed = line.trim();
          return trimmed !== ".ittybitty" && trimmed !== ".ittybitty/" && trimmed !== "/.ittybitty" && trimmed !== "/.ittybitty/";
        }).join("\n");
        await Bun.write(gitignorePath, filtered);
        return { ok: true, message: ".ittybitty removed from .gitignore" };
      }
      return { ok: true, message: ".gitignore not found" };
    } else {
      const file = Bun.file(gitignorePath);
      let content = "";
      if (await file.exists()) {
        content = await file.text();
        if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      }
      content += ".ittybitty/\n";
      await Bun.write(gitignorePath, content);
      return { ok: true, message: ".ittybitty/ added to .gitignore" };
    }
  } catch (err) {
    return { ok: false, message: `Failed: ${err}` };
  }
}

/** Check if .ittybitty.json config file exists */
export async function configFileExists(repoPath: string): Promise<boolean> {
  try {
    return await Bun.file(`${repoPath}/.ittybitty.json`).exists();
  } catch {
    return false;
  }
}

/** Create default .ittybitty.json config file */
export async function createDefaultConfigFile(repoPath: string): Promise<{ ok: boolean; message: string }> {
  const configPath = `${repoPath}/.ittybitty.json`;
  try {
    const file = Bun.file(configPath);
    if (await file.exists()) return { ok: true, message: ".ittybitty.json already exists" };
    const defaultConfig = {
      maxAgents: 10,
      model: "sonnet",
      permissions: {
        manager: { allow: [], deny: [] },
        worker: { allow: [], deny: [] },
      },
    };
    await Bun.write(configPath, JSON.stringify(defaultConfig, null, 2) + "\n");
    return { ok: true, message: "Created .ittybitty.json with default settings" };
  } catch (err) {
    return { ok: false, message: `Failed: ${err}` };
  }
}

