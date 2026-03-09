/**
 * Shared agent lifecycle helpers used by multiple ib commands.
 * Mirrors the behavior of the ib bash script's teardown, archive,
 * kill, and utility functions.
 */

import { join, dirname } from "path";
import { readdir, mkdir, cp, rm, rename } from "fs/promises";
import type { SpawnFn } from "./types";

/** Pluggable spawn runner — defaults to Bun.spawn, overridable for tests */
let spawnRunner: SpawnFn = Bun.spawn as SpawnFn;

/** Override the spawn runner (for testing) */
export function setSpawnRunner(runner: SpawnFn): void {
  spawnRunner = runner;
}

/** Reset to the default Bun.spawn runner */
export function resetSpawnRunner(): void {
  spawnRunner = Bun.spawn as SpawnFn;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a date as YYYY-MM-DD HH:MM:SS in local time */
function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Format a date as YYYYMMDD-HHMMSS for archive folder names */
function formatArchiveTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Run a spawned command and return { stdout, exitCode } */
async function runCmd(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = spawnRunner(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

// ── logAgent ─────────────────────────────────────────────────────────────────

/**
 * Append a timestamped line to an agent's agent.log.
 * Format: [YYYY-MM-DD HH:MM:SS] message
 * Only writes if the agent directory exists.
 */
export async function logAgent(agentDir: string, message: string): Promise<void> {
  try {
    const logFile = join(agentDir, "agent.log");
    const line = `[${formatTimestamp()}] ${message}\n`;
    const file = Bun.file(logFile);
    let existing = "";
    try {
      if (await file.exists()) {
        existing = await file.text();
      }
    } catch { /* ignore */ }
    await Bun.write(logFile, existing + line);
  } catch { /* agent dir may not exist */ }
}

// ── removeAgentQuestions ─────────────────────────────────────────────────────

/**
 * Remove entries for the given agent from .ittybitty/user-questions.json.
 */
export async function removeAgentQuestions(repoPath: string, agentId: string): Promise<void> {
  const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");
  try {
    const file = Bun.file(questionsPath);
    if (!(await file.exists())) return;
    const data = await file.json();
    if (!data || !Array.isArray(data.questions)) return;
    data.questions = data.questions.filter(
      (q: { agent?: string }) => q.agent !== agentId
    );
    await Bun.write(questionsPath, JSON.stringify(data, null, 2));
  } catch { /* ignore — file may not exist or be malformed */ }
}

// ── killAgentProcess ─────────────────────────────────────────────────────────

export interface KillAgentMeta {
  claude_pid?: string;
}

/**
 * Kill the Claude process for an agent.
 *
 * Strategy 1: tmux list-panes pane_pid -> pgrep -P for claude
 * Strategy 2: claude_pid from meta
 *
 * SIGTERM + wait up to 2s + SIGKILL if still alive.
 * Returns true if killed (or already dead), false if no PID found.
 */
export async function killAgentProcess(
  tmuxSession: string,
  meta: KillAgentMeta
): Promise<boolean> {
  let pid: string | null = null;

  // Strategy 1: Dynamic lookup from tmux
  const hasSession = await runCmd(["tmux", "has-session", "-t", tmuxSession]);
  if (hasSession.exitCode === 0) {
    const paneResult = await runCmd([
      "tmux", "list-panes", "-t", tmuxSession, "-F", "#{pane_pid}",
    ]);
    if (paneResult.exitCode === 0 && paneResult.stdout) {
      const panePid = paneResult.stdout.split("\n")[0]!.trim();
      if (panePid) {
        const pgrepResult = await runCmd(["pgrep", "-P", panePid, "-f", "claude"]);
        if (pgrepResult.exitCode === 0 && pgrepResult.stdout) {
          pid = pgrepResult.stdout.split("\n")[0]!.trim();
        }
      }
    }
  }

  // Strategy 2: Fallback to meta.json PID
  if (!pid && meta.claude_pid && meta.claude_pid !== "null") {
    pid = meta.claude_pid;
  }

  if (!pid) return false;

  const numPid = parseInt(pid, 10);
  if (isNaN(numPid)) return false;

  // Check if process is still running
  try {
    process.kill(numPid, 0);
  } catch {
    return true; // Already dead
  }

  // SIGTERM
  try {
    process.kill(numPid, "SIGTERM");
  } catch {
    return false;
  }

  // Wait up to 2 seconds (20 × 100ms)
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    try {
      process.kill(numPid, 0);
    } catch {
      return true; // Dead
    }
  }

  // SIGKILL if still alive
  try {
    process.kill(numPid, "SIGKILL");
    await Bun.sleep(100);
  } catch { /* ignore */ }

  // Final check
  try {
    process.kill(numPid, 0);
    return false; // Still alive somehow
  } catch {
    return true;
  }
}

// ── captureTmuxOutputToFile ──────────────────────────────────────────────────

/**
 * Capture tmux pane output and write it to a file.
 * Equivalent to: tmux capture-pane -t <session> -p -S - > outputPath
 */
export async function captureTmuxOutputToFile(
  tmuxSession: string,
  outputPath: string
): Promise<boolean> {
  try {
    const proc = spawnRunner(
      ["tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    await Bun.write(outputPath, raw);
    return true;
  } catch {
    return false;
  }
}

// ── archiveAgent ─────────────────────────────────────────────────────────────

/**
 * Archive agent artifacts to .ittybitty/archive/YYYYMMDD-HHMMSS-<id>/.
 * Moves/copies: output.log (move), agent.log (copy), meta.json (copy),
 * settings.local.json (move), debug-logs/ (copy recursive).
 */
export async function archiveAgent(
  repoPath: string,
  agentId: string,
  agentDir: string
): Promise<string | null> {
  const archiveDir = join(repoPath, ".ittybitty", "archive");
  const timestamp = formatArchiveTimestamp();
  const archiveFolder = join(archiveDir, `${timestamp}-${agentId}`);

  // Check if there's anything to archive
  const hasOutput = await Bun.file(join(agentDir, "output.log")).exists().catch(() => false);
  const hasLog = await Bun.file(join(agentDir, "agent.log")).exists().catch(() => false);
  const hasMeta = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);

  if (!hasOutput && !hasLog && !hasMeta) return null;

  await mkdir(archiveFolder, { recursive: true });

  // output.log — move
  if (hasOutput) {
    try {
      await rename(join(agentDir, "output.log"), join(archiveFolder, "output.log"));
    } catch {
      // Fallback: copy then delete
      try {
        await cp(join(agentDir, "output.log"), join(archiveFolder, "output.log"));
        await rm(join(agentDir, "output.log"));
      } catch { /* ignore */ }
    }
  }

  // agent.log — copy
  if (hasLog) {
    try {
      await cp(join(agentDir, "agent.log"), join(archiveFolder, "agent.log"));
    } catch { /* ignore */ }
  }

  // meta.json — copy
  if (hasMeta) {
    try {
      await cp(join(agentDir, "meta.json"), join(archiveFolder, "meta.json"));
    } catch { /* ignore */ }
  }

  // settings.local.json — move
  const hasSettings = await Bun.file(join(agentDir, "settings.local.json")).exists().catch(() => false);
  if (hasSettings) {
    try {
      await rename(join(agentDir, "settings.local.json"), join(archiveFolder, "settings.local.json"));
    } catch {
      try {
        await cp(join(agentDir, "settings.local.json"), join(archiveFolder, "settings.local.json"));
        await rm(join(agentDir, "settings.local.json"));
      } catch { /* ignore */ }
    }
  }

  // debug-logs/ — copy recursive (use readdir to check existence; Bun.file().exists() doesn't work on dirs)
  try {
    const debugLogsDir = join(agentDir, "debug-logs");
    await readdir(debugLogsDir);
    await cp(debugLogsDir, join(archiveFolder, "debug-logs"), { recursive: true });
  } catch { /* dir doesn't exist or copy failed */ }

  return archiveFolder;
}

// ── teardownAgent ────────────────────────────────────────────────────────────

export interface TeardownMeta {
  tmux_session: string;
  claude_pid?: string;
}

/**
 * Full teardown of an agent:
 * 1. Log the action
 * 2. Capture tmux output before killing
 * 3. Kill Claude process
 * 4. Kill tmux session
 * 5. Copy settings.local.json from worktree
 * 6. Remove git worktree
 * 7. Delete git branch
 * 8. Archive artifacts
 * 9. Remove agent directory
 */
export async function teardownAgent(
  repoPath: string,
  agentId: string,
  agentDir: string,
  meta: TeardownMeta,
  logMsg: string = "Agent killed"
): Promise<boolean> {
  const tmuxSession = meta.tmux_session;

  // 1. Log
  await logAgent(agentDir, logMsg);

  // 2. Capture tmux output
  const hasSession = await runCmd(["tmux", "has-session", "-t", tmuxSession]);
  if (hasSession.exitCode === 0) {
    await captureTmuxOutputToFile(tmuxSession, join(agentDir, "output.log"));
  }

  // 3. Kill Claude process
  const killed = await killAgentProcess(tmuxSession, meta);
  if (killed) {
    await logAgent(agentDir, "Terminated Claude process");
  }

  // 4. Kill tmux session
  const hasSession2 = await runCmd(["tmux", "has-session", "-t", tmuxSession]);
  if (hasSession2.exitCode === 0) {
    await runCmd(["tmux", "kill-session", "-t", tmuxSession]);
    await logAgent(agentDir, "Killed tmux session");
  }

  // 5. Copy settings.local.json before removing worktree
  const settingsPath = join(agentDir, "repo", ".claude", "settings.local.json");
  try {
    if (await Bun.file(settingsPath).exists()) {
      const content = await Bun.file(settingsPath).text();
      await Bun.write(join(agentDir, "settings.local.json"), content);
    }
  } catch { /* ignore */ }

  // 6. Remove git worktree
  const repoDir = join(agentDir, "repo");
  try {
    const entries = await readdir(repoDir).catch(() => null);
    if (entries !== null) {
      const result = await runCmd([
        "git", "-C", repoPath, "worktree", "remove", repoDir, "--force",
      ]);
      if (result.exitCode !== 0) {
        await rm(repoDir, { recursive: true, force: true });
      }
      // 7. Delete git branch
      const branchResult = await runCmd(["git", "-C", repoPath, "branch", "-D", `agent/${agentId}`]);
      if (branchResult.exitCode === 0) {
        await logAgent(agentDir, `Deleted branch agent/${agentId}`);
      }
    }
  } catch { /* ignore */ }

  // 8. Archive
  await archiveAgent(repoPath, agentId, agentDir);

  // 9. Remove agent directory
  try {
    await rm(agentDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ── scanAndKillOrphans ───────────────────────────────────────────────────────

/**
 * Find orphaned Claude processes whose cwd is in a deleted agent directory.
 * On macOS, uses lsof to get process cwd.
 * Returns count of killed orphans.
 */
export async function scanAndKillOrphans(agentsDir: string): Promise<number> {
  let killedCount = 0;

  // Get all Claude PIDs
  const pgrepResult = await runCmd(["pgrep", "-f", "claude"]);
  if (pgrepResult.exitCode !== 0 || !pgrepResult.stdout) return 0;

  const pids = pgrepResult.stdout.split("\n").filter((p) => p.trim());

  for (const pidStr of pids) {
    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) continue;

    // Get process cwd (macOS)
    let procCwd = "";
    if (process.platform === "darwin") {
      const lsofResult = await runCmd(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
      if (lsofResult.exitCode === 0) {
        const nLine = lsofResult.stdout.split("\n").find((l) => l.startsWith("n"));
        if (nLine) procCwd = nLine.slice(1);
      }
    } else {
      try {
        const { readlink } = await import("fs/promises");
        procCwd = await readlink(`/proc/${pid}/cwd`);
      } catch { /* ignore */ }
    }

    if (!procCwd) continue;

    // Safety check 1: Must contain "/.ittybitty/agents/"
    if (!procCwd.includes("/.ittybitty/agents/")) continue;

    // Safety check 2: Extract agent dir and verify it doesn't exist
    const match = procCwd.match(/(.*\/.ittybitty\/agents\/[^/]+)/);
    if (!match) continue;
    const agentPath = match[1]!;

    // Skip if directory still exists
    try {
      await readdir(agentPath);
      continue; // Dir exists — not an orphan
    } catch { /* dir doesn't exist — orphan confirmed */ }

    // Kill the orphan
    try {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(100);
        try {
          process.kill(pid, 0);
        } catch {
          killedCount++;
          break;
        }
        if (i === 19) {
          try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
          await Bun.sleep(100);
          try {
            process.kill(pid, 0);
          } catch {
            killedCount++;
          }
        }
      }
    } catch { /* ignore */ }
  }

  return killedCount;
}

// ── getDescendantsRecursive ──────────────────────────────────────────────────

/**
 * Depth-first descendant collection.
 * Returns all descendants including the manager itself as first element.
 */
export async function getDescendantsRecursive(
  agentsDir: string,
  managerId: string
): Promise<string[]> {
  const result: string[] = [managerId];

  let entries: string[];
  try {
    const dirEntries = await readdir(agentsDir, { withFileTypes: true });
    entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const metaPath = join(agentsDir, entry, "meta.json");
    try {
      const file = Bun.file(metaPath);
      if (!(await file.exists())) continue;
      const meta = await file.json();
      if (meta.manager === managerId) {
        const children = await getDescendantsRecursive(agentsDir, entry);
        result.push(...children);
      }
    } catch { /* skip malformed meta */ }
  }

  return result;
}

// ── isRunningAsAgent ─────────────────────────────────────────────────────────

/**
 * Check if we're running inside an agent context.
 * True if cwd matches agent worktree path pattern
 * OR if inside an ittybitty tmux session.
 */
export async function isRunningAsAgent(cwd?: string): Promise<boolean> {
  const dir = cwd ?? process.cwd();

  // Primary check: worktree path pattern
  if (/\/.ittybitty\/agents\/[^/]+\/repo/.test(dir)) {
    return true;
  }

  // Secondary check: ib-spawned tmux session name
  if (process.env.TMUX) {
    try {
      const result = await runCmd(["tmux", "display-message", "-p", "#{session_name}"]);
      if (result.exitCode === 0 && result.stdout.startsWith("ittybitty-")) {
        return true;
      }
    } catch { /* ignore */ }
  }

  return false;
}

// ── resolveGitRoot ───────────────────────────────────────────────────────────

/**
 * Resolve the root repository path (handles worktrees).
 * Uses git -C repoPath rev-parse --show-toplevel, with git-common-dir
 * fallback for worktree resolution.
 */
export async function resolveGitRoot(repoPath: string): Promise<string | null> {
  try {
    // Get the common git directory (shared across all worktrees)
    const commonResult = await runCmd(["git", "-C", repoPath, "rev-parse", "--git-common-dir"]);
    if (commonResult.exitCode !== 0) {
      // Fallback
      const topResult = await runCmd(["git", "-C", repoPath, "rev-parse", "--show-toplevel"]);
      return topResult.exitCode === 0 ? topResult.stdout : null;
    }

    const commonDir = commonResult.stdout;
    const gitDirResult = await runCmd(["git", "-C", repoPath, "rev-parse", "--git-dir"]);

    // If common_dir is ".git" or matches --git-dir, we're in the main repo
    if (commonDir === ".git" || commonDir === gitDirResult.stdout) {
      const topResult = await runCmd(["git", "-C", repoPath, "rev-parse", "--show-toplevel"]);
      return topResult.exitCode === 0 ? topResult.stdout : null;
    }

    // common_dir points to the shared .git directory — go up one level
    return dirname(commonDir);
  } catch {
    return null;
  }
}

// ── Exported for testing ─────────────────────────────────────────────────────

/** @internal Exposed for testing only */
export { formatTimestamp as _formatTimestamp, formatArchiveTimestamp as _formatArchiveTimestamp };
