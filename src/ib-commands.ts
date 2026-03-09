/**
 * Async wrappers for ib mutation commands.
 * Every command runs with cwd set to the agent's repoPath.
 * kill, pause, and sendMessage are implemented natively; others delegate to ib CLI.
 */

import { join } from "path";
import type { Agent } from "./agents";
import {
  logAgent,
  removeAgentQuestions,
  killAgentProcess,
  teardownAgent,
  scanAndKillOrphans,
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

export async function nukeAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["nuke", agent.id, "--force"], agent.repoPath);
}

export async function nukeAllAgents(repoPath: string): Promise<IbCommandResult> {
  return runIb(["nuke", "--force"], repoPath);
}

export async function resumeAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["resume", agent.id], agent.repoPath);
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

export async function mergeAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["merge", agent.id, "--force"], agent.repoPath);
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

