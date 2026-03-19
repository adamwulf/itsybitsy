/**
 * System coordinator configuration, prompt, permissions, and lifecycle.
 * See SPEC.md §12.1 for the full specification.
 */

import { join } from "path";
import { homedir } from "os";
import { readConfig } from "./config";
import { captureTmuxOutput } from "./tmux-poller";
import { isCompacting, isRateLimited } from "./agents";
import { SpawnContext } from "./types";

export const IB_COORDINATOR_SESSION = "ib-coordinator";

/** Spawn context for coordinator operations — injectable for testing. */
export const coordinatorSpawnCtx = new SpawnContext();

/** Sleep function — injectable for testing. */
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

export function setCoordinatorSleepFn(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

export function resetCoordinatorSleepFn(): void {
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
}

/** Override the itsybitsy home directory for testing. */
let overrideHome: string | undefined;

export function setCoordinatorHome(path: string): void {
  overrideHome = path;
}

export function resetCoordinatorHome(): void {
  overrideHome = undefined;
}

function itsybitsynHome(): string {
  return overrideHome ?? join(process.env.HOME ?? homedir(), ".itsybitsy");
}

function refsPath(): string {
  return join(itsybitsynHome(), "coordinator.refs");
}

/**
 * Initial prompt text for the system coordinator (SPEC §12.1.5).
 * Sent via tmux send-keys after the Claude session starts.
 */
export const SYSTEM_COORDINATOR_PROMPT = `You are the itsybitsy system coordinator. You manage agents across all registered repos using \`ib\` commands. You can list agents (\`ib list\`), send messages to agents (\`ib send <agent-id> "message"\`), merge (\`ib merge\`), kill (\`ib kill\`), create agents (\`ib new-agent\`), and check status (\`ib status\`, \`ib diff\`). You do NOT have access to Read, Write, Edit, or any file tools — only \`ib\` Bash commands. You coordinate work at the system level — for repo-specific coordination, delegate to per-repo coordinators. To send messages to per-repo coordinators, use \`ib send <repo-name> "message"\` (e.g., \`ib send itsybitsy "review the latest PR"\`). Do NOT use \`ib send coordinator\` — that routes back to you. Periodically check \`ib inbox count\` for notifications from watchdogs and agents; process with \`ib inbox list\` / \`ib inbox read\` / \`ib inbox ack\`.`;

/**
 * Hardcoded allow list for the system coordinator.
 * Only ib commands are permitted.
 */
const SYSTEM_COORDINATOR_ALLOW = ["Bash(ib:*)"];

/**
 * Hardcoded deny list for the system coordinator.
 * Blocks all file access, web access, and agent spawning tools.
 * Unqualified Bash is denied to prevent sandbox bypass.
 */
const SYSTEM_COORDINATOR_DENY = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "Agent",
  "KillShell",
  "EnterPlanMode",
  "ExitPlanMode",
];

/**
 * Build the settings.local.json content for the system coordinator.
 * The system coordinator's permissions are fixed — config allow/deny
 * keys (permissions.coordinator.*) apply only to per-repo coordinators.
 */
export function buildSystemCoordinatorSettings(): {
  permissions: { allow: string[]; deny: string[] };
} {
  return {
    permissions: {
      allow: [...SYSTEM_COORDINATOR_ALLOW],
      deny: [...SYSTEM_COORDINATOR_DENY],
    },
  };
}

/**
 * Strip control characters that could inject tmux key sequences.
 * Removes all chars with code points < 0x20 (C0 controls) and 0x7F (DEL).
 * This prevents Ctrl-C/D/Escape injection via tmux send-keys -l.
 */
export function sanitizeTmuxInput(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      result += text[i];
    }
  }
  return result;
}

/** Check if the ib-coordinator tmux session exists. */
async function tmuxSessionExists(): Promise<boolean> {
  const { exitCode } = await coordinatorSpawnCtx.run([
    "tmux", "has-session", "-t", IB_COORDINATOR_SESSION,
  ]);
  return exitCode === 0;
}

/**
 * Ensure ~/.itsybitsy/ exists and is a git repo.
 * Creates directory, runs git init, writes .gitignore with '*'.
 */
async function ensureHomeRepo(): Promise<void> {
  const home = itsybitsynHome();
  const { mkdir } = await import("fs/promises");
  await mkdir(home, { recursive: true });

  // Check if already a git repo
  const { exitCode } = await coordinatorSpawnCtx.run([
    "git", "-C", home, "rev-parse", "--git-dir",
  ]);
  if (exitCode !== 0) {
    await coordinatorSpawnCtx.run(["git", "init", home]);
  }

  // Write .gitignore with '*' to prevent accidental commits
  const gitignorePath = join(home, ".gitignore");
  await Bun.write(gitignorePath, "*\n");
}

/**
 * Write settings.local.json and coordinator-prompt.txt to ~/.itsybitsy/.
 */
async function writeCoordinatorFiles(): Promise<void> {
  const home = itsybitsynHome();
  const { mkdir } = await import("fs/promises");

  // Write .claude/settings.local.json
  const claudeDir = join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");
  const settings = buildSystemCoordinatorSettings();
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // Write coordinator-prompt.txt
  const promptPath = join(home, "coordinator-prompt.txt");
  await Bun.write(promptPath, SYSTEM_COORDINATOR_PROMPT + "\n");
}

/**
 * Ensure the system coordinator tmux session is running.
 * If a session already exists, returns immediately.
 * Otherwise creates the session, starts Claude, and sends the initial prompt.
 * Returns the session name.
 *
 * TOCTOU: If two instances race, tmux new-session will fail for the loser —
 * we catch that and fall through.
 */
export async function ensureSystemCoordinator(): Promise<string> {
  // Check for existing session
  if (await tmuxSessionExists()) {
    return IB_COORDINATOR_SESSION;
  }

  const home = itsybitsynHome();

  // Set up the directory and files
  await ensureHomeRepo();
  await writeCoordinatorFiles();

  // Create tmux session — may fail if another instance raced us
  const { exitCode } = await coordinatorSpawnCtx.run([
    "tmux", "new-session", "-d", "-s", IB_COORDINATOR_SESSION, "-c", home,
  ]);

  if (exitCode !== 0) {
    // TOCTOU: another instance created the session — that's fine
    if (await tmuxSessionExists()) {
      return IB_COORDINATOR_SESSION;
    }
    throw new Error("Failed to create system coordinator tmux session");
  }

  // Read coordinator model from config
  const config = await readConfig();
  const model = (config["coordinator.model"]?.value as string) ?? "opus";

  // Start Claude in interactive mode
  await coordinatorSpawnCtx.run([
    "tmux", "send-keys", "-t", IB_COORDINATOR_SESSION,
    `claude --model ${model}`, "Enter",
  ]);

  // Wait for Claude to start up
  await sleepFn(3000);

  // Send the initial prompt (sanitized) via send-keys -l then Enter
  const sanitizedPrompt = sanitizeTmuxInput(SYSTEM_COORDINATOR_PROMPT);
  await coordinatorSpawnCtx.run([
    "tmux", "send-keys", "-t", IB_COORDINATOR_SESSION, "-l", sanitizedPrompt,
  ]);
  await coordinatorSpawnCtx.run([
    "tmux", "send-keys", "-t", IB_COORDINATOR_SESSION, "Enter",
  ]);

  return IB_COORDINATOR_SESSION;
}

/**
 * Read live PIDs from the coordinator.refs file.
 * Returns an array of PIDs that are currently alive.
 */
async function readLivePids(): Promise<number[]> {
  const path = refsPath();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const content = await file.text();
    const pids = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => parseInt(l, 10))
      .filter((n) => !isNaN(n));

    // Prune stale PIDs
    return pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Atomically write PIDs to the refs file (write temp → rename).
 */
async function writePidsAtomic(pids: number[]): Promise<void> {
  const path = refsPath();
  const tmpPath = path + ".tmp." + process.pid;
  const content = pids.map((p) => String(p)).join("\n") + "\n";
  await Bun.write(tmpPath, content);
  const { rename } = await import("fs/promises");
  await rename(tmpPath, path);
}

/**
 * Acquire a reference to the system coordinator.
 * Appends the current process PID to coordinator.refs after pruning stale PIDs.
 */
export async function acquireSystemCoordinator(): Promise<void> {
  const livePids = await readLivePids();
  const myPid = process.pid;
  if (!livePids.includes(myPid)) {
    livePids.push(myPid);
  }
  await writePidsAtomic(livePids);
}

/**
 * Release a reference to the system coordinator.
 * Removes the current process PID from coordinator.refs.
 * If no live PIDs remain, calls onLastRef (if provided) then kills the tmux session.
 */
export async function releaseSystemCoordinator(
  onLastRef?: () => Promise<void>
): Promise<void> {
  const livePids = await readLivePids();
  const myPid = process.pid;
  const remaining = livePids.filter((pid) => pid !== myPid);
  await writePidsAtomic(remaining);

  if (remaining.length === 0) {
    if (onLastRef) {
      await onLastRef();
    }
    // Kill the tmux session
    await coordinatorSpawnCtx.run([
      "tmux", "kill-session", "-t", IB_COORDINATOR_SESSION,
    ]);
  }
}

/**
 * Restart the system coordinator — kill session and re-create.
 */
export async function restartSystemCoordinator(): Promise<void> {
  // Kill existing session if present
  await coordinatorSpawnCtx.run([
    "tmux", "kill-session", "-t", IB_COORDINATOR_SESSION,
  ]);
  await ensureSystemCoordinator();
}

export type CoordinatorState = "stopped" | "compacting" | "rate_limited" | "running";

/**
 * Detect the system coordinator's current state from tmux output.
 * See SPEC.md §12.1.6 for priority order.
 */
export async function detectSystemCoordinatorState(): Promise<CoordinatorState> {
  // No session → stopped
  if (!(await tmuxSessionExists())) {
    return "stopped";
  }

  // Capture tmux output
  const output = await captureTmuxOutput(IB_COORDINATOR_SESSION);
  if (output === null) {
    return "stopped";
  }

  // Compacting in last 5 lines
  if (isCompacting(output)) {
    return "compacting";
  }

  // Rate limited in last 15 lines
  if (isRateLimited(output)) {
    return "rate_limited";
  }

  return "running";
}
