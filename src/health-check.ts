/**
 * Repo configuration health check — detects configuration inconsistencies.
 * See SPEC.md §14 for full specification.
 *
 * Checks (§14.3):
 *  1. Leaked agent hooks in repo settings.local.json (error)
 *  2. Missing global hooks in ~/.claude/settings.json (warning)
 *  3. Orphaned agent directories (warning/error)
 *  4. Malformed meta.json (error)
 *  5. Orphaned git worktrees (warning)
 *  6. Orphaned git branches (info)
 *  7. Stale manager references in meta.json (warning)
 *  8. Agent hooks referencing wrong agent ID (warning)
 */

import { join, basename } from "path";
import { homedir } from "os";
import { readdir, rm } from "fs/promises";
import { SpawnContext } from "./types";
import { isValidAgentId } from "./validation";

export interface RepoHealthWarning {
  repoPath: string;
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  agentId?: string;
  fix?: string;
}

export interface RepoHealthReport {
  repoPath: string;
  checkedAt: number;
  warnings: RepoHealthWarning[];
}

/** Default spawn context for git operations */
export const healthSpawnCtx = new SpawnContext();

// Agent-specific hook command patterns (these reference a specific agent ID)
const AGENT_HOOK_PATTERNS = [
  /ib\s+hook-check-path\s+(\S+)/,
  /ib\s+hook-status\s+(\S+)/,
  /ib\s+hook-permission-denied\s+(\S+)/,
];

/** Read and parse a JSON file, returning null on failure */
async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      return await file.json();
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Extract all hook commands from a settings.json hooks object.
 * Returns an array of command strings.
 */
function extractHookCommands(hooks: unknown): string[] {
  if (!hooks || typeof hooks !== "object") return [];
  const commands: string[] = [];
  for (const hookType of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(hookType)) continue;
    for (const entry of hookType) {
      const entryHooks = (entry as Record<string, unknown>)?.hooks;
      if (!Array.isArray(entryHooks)) continue;
      for (const h of entryHooks) {
        const cmd = (h as Record<string, unknown>)?.command;
        if (typeof cmd === "string") commands.push(cmd);
      }
    }
  }
  return commands;
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

// ── Individual check functions ──────────────────────────────────────────────

/**
 * §14.3.1 — Leaked agent hooks in repo settings.local.json (error)
 */
export async function checkLeakedAgentHooks(repoPath: string): Promise<RepoHealthWarning[]> {
  const settingsPath = join(repoPath, ".claude", "settings.local.json");
  const settings = await readJsonFile(settingsPath);
  if (!settings || typeof settings !== "object") return [];

  const hooks = (settings as Record<string, unknown>).hooks;
  const commands = extractHookCommands(hooks);
  const warnings: RepoHealthWarning[] = [];

  for (const cmd of commands) {
    for (const pattern of AGENT_HOOK_PATTERNS) {
      const match = cmd.match(pattern);
      if (match) {
        const agentId = match[1]!;
        if (isValidAgentId(agentId)) {
          warnings.push({
            repoPath,
            severity: "error",
            category: "leaked-hooks",
            message: `Leaked agent hook in .claude/settings.local.json: ${cmd} — this will block tool calls in your Claude session. Remove the hook entry or restore settings from version control.`,
            agentId,
            fix: "Remove the hook entry from .claude/settings.local.json",
          });
        }
      }
    }
  }
  return warnings;
}

/**
 * §14.3.2 — Missing global hooks in ~/.claude/settings.json (warning)
 */
export async function checkMissingGlobalHooks(): Promise<RepoHealthWarning[]> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = await readJsonFile(settingsPath);
  if (!settings || typeof settings !== "object") {
    return [{
      repoPath: "global",
      severity: "warning",
      category: "missing-global-hooks",
      message: "Missing global safety hooks in ~/.claude/settings.json — run setup (h) to install",
      fix: "Press h in the dashboard to run setup",
    }];
  }

  const warnings: RepoHealthWarning[] = [];
  const hooks = (settings as Record<string, unknown>).hooks as Record<string, unknown> | undefined;

  // Check safety hooks as a group
  const hasMainPath = hookArrayHasCommand(hooks?.PreToolUse, "ib hooks main-path");
  const hasSessionStart = hookArrayHasCommand(hooks?.SessionStart, "ib hooks session-start");
  const hasInjectStatus =
    hookArrayHasCommand(hooks?.UserPromptSubmit, "ib hooks inject-status") ||
    hookArrayHasCommand(hooks?.PostToolUse, "ib hooks inject-status");

  if (!hasMainPath || !hasSessionStart || !hasInjectStatus) {
    warnings.push({
      repoPath: "global",
      severity: "warning",
      category: "missing-global-hooks",
      message: "Missing global safety hooks in ~/.claude/settings.json — run setup (h) to install",
      fix: "Press h in the dashboard to run setup",
    });
  }

  // Check intercept-task separately
  const hasIntercept = hookArrayHasCommand(hooks?.PreToolUse, "ib hooks intercept-task");
  if (!hasIntercept) {
    warnings.push({
      repoPath: "global",
      severity: "warning",
      category: "missing-global-hooks",
      message: "Missing intercept-task hook in ~/.claude/settings.json — run setup (h) to install",
      fix: "Press h in the dashboard to run setup",
    });
  }

  return warnings;
}

/**
 * §14.3.3 & §14.3.4 — Orphaned agent directories and malformed meta.json
 * Combined because both need to iterate agent directories and read meta.json.
 */
export async function checkAgentDirectories(repoPath: string): Promise<RepoHealthWarning[]> {
  const agentsDir = join(repoPath, ".ittybitty", "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return []; // No agents directory — nothing to check
  }

  const warnings: RepoHealthWarning[] = [];
  const now = Date.now();

  for (const dirName of entries) {
    if (!isValidAgentId(dirName)) continue;

    const agentDir = join(agentsDir, dirName);
    const metaPath = join(agentDir, "meta.json");
    const meta = await readJsonFile(metaPath);

    // §14.3.4 — Malformed meta.json
    if (meta === null) {
      // meta.json doesn't exist or isn't valid JSON
      const metaFile = Bun.file(metaPath);
      const exists = await metaFile.exists();
      if (exists) {
        warnings.push({
          repoPath,
          severity: "error",
          category: "malformed-meta",
          message: `Malformed meta.json for agent ${dirName}: invalid JSON`,
          agentId: dirName,
        });
      } else {
        // §14.3.3 — No meta.json at all = orphaned
        warnings.push({
          repoPath,
          severity: "error",
          category: "orphaned-dir",
          message: `Orphaned agent directory: ${dirName} — no valid meta.json`,
          agentId: dirName,
        });
      }
      continue;
    }

    // Validate required fields
    const m = meta as Record<string, unknown>;
    const issues: string[] = [];
    if (typeof m.id !== "string") issues.push("missing or invalid 'id'");
    if (typeof m.tmux_session !== "string") issues.push("missing or invalid 'tmux_session'");
    if (typeof m.created_epoch !== "number") issues.push("missing or invalid 'created_epoch'");
    if (typeof m.id === "string" && m.id !== dirName) issues.push(`id '${m.id}' doesn't match directory '${dirName}'`);

    if (issues.length > 0) {
      warnings.push({
        repoPath,
        severity: "error",
        category: "malformed-meta",
        message: `Malformed meta.json for agent ${dirName}: ${issues.join(", ")}`,
        agentId: dirName,
      });
      continue;
    }

    // §14.3.3 — Check for orphaned directory (valid meta but no tmux session)
    const createdEpoch = m.created_epoch as number;
    const ageMs = now - createdEpoch * 1000;
    if (ageMs > 30_000) {
      // Check if tmux session exists
      const tmuxSession = m.tmux_session as string;
      try {
        const result = await healthSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
        if (result.exitCode !== 0) {
          // No tmux session — check for worktree
          const worktreePath = join(agentDir, "repo");
          const worktreeFile = Bun.file(join(worktreePath, ".git"));
          const hasWorktree = await worktreeFile.exists();
          if (!hasWorktree) {
            warnings.push({
              repoPath,
              severity: "warning",
              category: "orphaned-dir",
              message: `Agent ${dirName} has no tmux session and no worktree — stale directory`,
              agentId: dirName,
            });
          }
          // If worktree exists, it's a stopped agent — normal state, don't flag
        }
      } catch {
        // tmux not available or other error — skip this check
      }
    }
  }

  return warnings;
}

/**
 * §14.3.5 — Orphaned git worktrees (warning)
 */
export async function checkOrphanedWorktrees(repoPath: string): Promise<RepoHealthWarning[]> {
  let result;
  try {
    result = await healthSpawnCtx.run(["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  if (result.exitCode !== 0) return [];

  const warnings: RepoHealthWarning[] = [];
  const lines = result.stdout.split("\n");

  let currentWorktreePath: string | null = null;
  let currentBranch: string | null = null;

  /** Check the current worktree entry and emit a warning if orphaned */
  const checkEntry = async () => {
    if (!currentBranch || !currentWorktreePath) return;
    // currentBranch is the capture from refs/heads/agent/(.+), e.g., "agent-a1b2c3d4"
    const agentDirForId = join(repoPath, ".ittybitty", "agents", currentBranch);

    let exists = false;
    try {
      // Check for meta.json as evidence the agent dir exists
      const file = Bun.file(join(agentDirForId, "meta.json"));
      exists = await file.exists();
    } catch { /* ignore */ }

    if (!exists) {
      warnings.push({
        repoPath,
        severity: "warning",
        category: "orphaned-worktree",
        message: `Orphaned git worktree for agent/${currentBranch} — no agent directory exists. Clean up with: git worktree remove ${currentWorktreePath}`,
        fix: `git worktree remove ${currentWorktreePath}`,
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentWorktreePath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const branchRef = line.slice("branch ".length);
      const match = branchRef.match(/^refs\/heads\/agent\/(.+)$/);
      if (match) {
        currentBranch = match[1]!;
      }
    } else if (line === "") {
      await checkEntry();
      currentWorktreePath = null;
      currentBranch = null;
    }
  }

  // Handle the last entry if stdout was trimmed (no trailing empty line)
  await checkEntry();

  return warnings;
}

/**
 * §14.3.6 — Orphaned git branches (info)
 */
export async function checkOrphanedBranches(repoPath: string): Promise<RepoHealthWarning[]> {
  let branchResult;
  let worktreeResult;
  try {
    [branchResult, worktreeResult] = await Promise.all([
      healthSpawnCtx.run(["git", "-C", repoPath, "branch", "--list", "agent/*"]),
      healthSpawnCtx.run(["git", "-C", repoPath, "worktree", "list", "--porcelain"]),
    ]);
  } catch {
    return [];
  }
  if (branchResult.exitCode !== 0) return [];

  // Build set of branches that have active worktrees
  const worktreeBranches = new Set<string>();
  if (worktreeResult.exitCode === 0) {
    for (const line of worktreeResult.stdout.split("\n")) {
      if (line.startsWith("branch refs/heads/")) {
        worktreeBranches.add(line.slice("branch refs/heads/".length));
      }
    }
  }

  const warnings: RepoHealthWarning[] = [];
  const branchLines = branchResult.stdout.split("\n");

  for (const line of branchLines) {
    const trimmed = line.trim().replace(/^\* /, "");
    if (!trimmed.startsWith("agent/")) continue;

    const branchName = trimmed; // e.g., "agent/agent-abc123"
    const agentId = branchName.slice("agent/".length); // e.g., "agent-abc123"

    // Check if agent directory exists
    const agentDir = join(repoPath, ".ittybitty", "agents", agentId);
    let agentExists = false;
    try {
      const file = Bun.file(join(agentDir, "meta.json"));
      agentExists = await file.exists();
    } catch { /* ignore */ }

    // Check if a worktree is checked out on this branch
    const hasWorktree = worktreeBranches.has(branchName);

    if (!agentExists && !hasWorktree) {
      warnings.push({
        repoPath,
        severity: "info",
        category: "orphaned-branch",
        message: `Orphaned git branch: ${branchName} — no agent or worktree exists`,
        fix: `git branch -D ${branchName}`,
      });
    }
  }

  return warnings;
}

/**
 * §14.3.7 — Stale manager references in meta.json (warning)
 */
export async function checkStaleManagerRefs(repoPath: string): Promise<RepoHealthWarning[]> {
  const agentsDir = join(repoPath, ".ittybitty", "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }

  // Build set of existing agent IDs
  const existingAgentIds = new Set<string>();
  const agentMetas: Array<{ id: string; manager?: string }> = [];

  for (const dirName of entries) {
    if (!isValidAgentId(dirName)) continue;
    existingAgentIds.add(dirName);

    const metaPath = join(agentsDir, dirName, "meta.json");
    const meta = await readJsonFile(metaPath);
    if (meta && typeof meta === "object") {
      const m = meta as Record<string, unknown>;
      if (typeof m.id === "string") {
        agentMetas.push({
          id: m.id,
          manager: typeof m.manager === "string" ? m.manager : undefined,
        });
      }
    }
  }

  const warnings: RepoHealthWarning[] = [];
  for (const agent of agentMetas) {
    if (agent.manager && !existingAgentIds.has(agent.manager)) {
      warnings.push({
        repoPath,
        severity: "warning",
        category: "stale-manager-ref",
        message: `Agent ${agent.id} references non-existent manager ${agent.manager}`,
        agentId: agent.id,
      });
    }
  }

  return warnings;
}

/**
 * §14.3.8 — Agent hooks referencing wrong agent ID (warning)
 */
export async function checkAgentHookIds(repoPath: string): Promise<RepoHealthWarning[]> {
  const agentsDir = join(repoPath, ".ittybitty", "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }

  const warnings: RepoHealthWarning[] = [];

  for (const dirName of entries) {
    if (!isValidAgentId(dirName)) continue;

    const settingsPath = join(agentsDir, dirName, "repo", ".claude", "settings.local.json");
    const settings = await readJsonFile(settingsPath);
    if (!settings || typeof settings !== "object") continue;

    const hooks = (settings as Record<string, unknown>).hooks;
    const commands = extractHookCommands(hooks);

    for (const cmd of commands) {
      for (const pattern of AGENT_HOOK_PATTERNS) {
        const match = cmd.match(pattern);
        if (match) {
          const referencedId = match[1]!;
          if (isValidAgentId(referencedId) && referencedId !== dirName) {
            warnings.push({
              repoPath,
              severity: "warning",
              category: "wrong-agent-hooks",
              message: `Agent ${dirName} has hooks referencing wrong agent ${referencedId} in settings.local.json`,
              agentId: dirName,
            });
            break; // One warning per agent is enough
          }
        }
      }
    }
  }

  return warnings;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Check a single repo for configuration health issues */
export async function checkRepoHealth(repoPath: string): Promise<RepoHealthReport> {
  // Run all per-repo checks in parallel
  const [leaked, agentDirs, worktrees, branches, staleRefs, hookIds] = await Promise.all([
    checkLeakedAgentHooks(repoPath),
    checkAgentDirectories(repoPath),
    checkOrphanedWorktrees(repoPath),
    checkOrphanedBranches(repoPath),
    checkStaleManagerRefs(repoPath),
    checkAgentHookIds(repoPath),
  ]);

  return {
    repoPath,
    checkedAt: Date.now(),
    warnings: [...leaked, ...agentDirs, ...worktrees, ...branches, ...staleRefs, ...hookIds],
  };
}

/** Check global configuration health (e.g. ~/.claude/settings.json) */
export async function checkGlobalHealth(): Promise<RepoHealthWarning[]> {
  return checkMissingGlobalHooks();
}

// ── Auto-resolve ────────────────────────────────────────────────────────────

const RESOLVABLE_CATEGORIES = new Set([
  "leaked-hooks",
  "orphaned-dir",
  "orphaned-worktree",
  "orphaned-branch",
  "stale-manager-ref",
]);

/** Filter warnings to only those that can be auto-resolved. */
export function getResolvableWarnings(warnings: RepoHealthWarning[]): RepoHealthWarning[] {
  return warnings.filter((w) => RESOLVABLE_CATEGORIES.has(w.category));
}

export interface ResolveDetail {
  warning: RepoHealthWarning;
  success: boolean;
  error?: string;
}

export interface ResolveResult {
  resolved: number;
  failed: number;
  details: ResolveDetail[];
}

/** Auto-resolve the given warnings. Only processes resolvable categories. */
export async function resolveHealthWarnings(warnings: RepoHealthWarning[]): Promise<ResolveResult> {
  const details: ResolveDetail[] = [];
  let resolved = 0;
  let failed = 0;

  for (const w of warnings) {
    if (!RESOLVABLE_CATEGORIES.has(w.category)) {
      // Skip non-resolvable
      continue;
    }
    try {
      await resolveOne(w);
      details.push({ warning: w, success: true });
      resolved++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      details.push({ warning: w, success: false, error: msg });
      failed++;
    }
  }

  return { resolved, failed, details };
}

async function resolveOne(w: RepoHealthWarning): Promise<void> {
  switch (w.category) {
    case "leaked-hooks":
      await resolveLeakedHooks(w);
      break;
    case "orphaned-dir":
      await resolveOrphanedDir(w);
      break;
    case "orphaned-worktree":
      await resolveOrphanedWorktree(w);
      break;
    case "orphaned-branch":
      await resolveOrphanedBranch(w);
      break;
    case "stale-manager-ref":
      await resolveStaleManagerRef(w);
      break;
  }
}

/** Remove leaked agent hook entries from .claude/settings.local.json */
async function resolveLeakedHooks(w: RepoHealthWarning): Promise<void> {
  const settingsPath = join(w.repoPath, ".claude", "settings.local.json");
  const settings = await readJsonFile(settingsPath);
  if (!settings || typeof settings !== "object") return;

  const s = settings as Record<string, unknown>;
  const hooks = s.hooks;
  if (!hooks || typeof hooks !== "object") return;

  let modified = false;
  const hooksObj = hooks as Record<string, unknown>;

  for (const hookType of Object.keys(hooksObj)) {
    const hookArray = hooksObj[hookType];
    if (!Array.isArray(hookArray)) continue;

    const filtered = hookArray.filter((entry: unknown) => {
      const entryHooks = (entry as Record<string, unknown>)?.hooks;
      if (!Array.isArray(entryHooks)) return true;
      // Remove entry if ANY of its hooks match an agent-specific pattern with this warning's agentId
      const hasLeaked = entryHooks.some((h: unknown) => {
        const cmd = (h as Record<string, unknown>)?.command;
        if (typeof cmd !== "string") return false;
        return AGENT_HOOK_PATTERNS.some((pattern) => {
          const match = cmd.match(pattern);
          return match && w.agentId && match[1] === w.agentId;
        });
      });
      return !hasLeaked;
    });

    if (filtered.length !== hookArray.length) {
      modified = true;
      if (filtered.length === 0) {
        delete hooksObj[hookType];
      } else {
        hooksObj[hookType] = filtered;
      }
    }
  }

  // Clean up empty hooks object
  if (Object.keys(hooksObj).length === 0) {
    delete s.hooks;
  }

  if (modified) {
    await Bun.write(settingsPath, JSON.stringify(s, null, 2) + "\n");
  }
}

/** Remove a stale agent directory */
async function resolveOrphanedDir(w: RepoHealthWarning): Promise<void> {
  if (!w.agentId) return;
  const agentDir = join(w.repoPath, ".ittybitty", "agents", w.agentId);
  await rm(agentDir, { recursive: true, force: true });
}

/** Remove an orphaned git worktree */
async function resolveOrphanedWorktree(w: RepoHealthWarning): Promise<void> {
  // Extract worktree path from the fix field
  const match = w.fix?.match(/git worktree remove (.+)/);
  if (!match) return;
  const worktreePath = match[1]!;
  const result = await healthSpawnCtx.run(["git", "-C", w.repoPath, "worktree", "remove", worktreePath, "--force"]);
  if (result.exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${result.stderr}`);
  }
}

/** Delete an orphaned git branch */
async function resolveOrphanedBranch(w: RepoHealthWarning): Promise<void> {
  // Extract branch name from fix field
  const match = w.fix?.match(/git branch -D (agent\/\S+)/);
  if (!match) return;
  const branchName = match[1]!;
  const result = await healthSpawnCtx.run(["git", "-C", w.repoPath, "branch", "-D", branchName]);
  if (result.exitCode !== 0) {
    throw new Error(`git branch -D failed: ${result.stderr}`);
  }
}

/** Remove stale manager field from meta.json */
async function resolveStaleManagerRef(w: RepoHealthWarning): Promise<void> {
  if (!w.agentId) return;
  const metaPath = join(w.repoPath, ".ittybitty", "agents", w.agentId, "meta.json");
  const meta = await readJsonFile(metaPath);
  if (!meta || typeof meta !== "object") return;

  const m = meta as Record<string, unknown>;
  delete m.manager;
  await Bun.write(metaPath, JSON.stringify(m, null, 2) + "\n");
}
