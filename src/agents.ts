/**
 * Read .ittybitty/agents/ directory directly to get agent data.
 * Also reads user-questions.json for pending questions.
 */

import { join } from "path";
import { readdir, rename, stat } from "fs/promises";
import type { AgentState } from "./parse-state";
import { parseState, stripAnsi, STARTUP_MARKERS } from "./parse-state";
import { captureTmuxOutput, listTmuxSessions } from "./tmux-poller";
import { InjectionContext } from "./types";

/** States that can be written to meta.json */
export type MetaState = "running" | "waiting" | "complete";

export interface AgentMeta {
  id: string;
  session_id: string;
  tmux_session: string;
  prompt: string;
  manager: string | null;
  created: string;
  created_epoch: number;
  worktree: boolean;
  worker: boolean;
  yolo: boolean;
  model: string;
  claude_pid: string;
  summary?: string;
  watchdog_pid?: number;
  state?: MetaState;
  state_updated_at?: number;
}

export interface Agent {
  id: string;
  repoPath: string;
  repoName: string;
  meta: AgentMeta;
  state: AgentState;
  age: string;
  archived: boolean;
  orphaned?: boolean;
  children: Agent[];
}

export interface PendingQuestion {
  id: string;
  agent: string;
  question: string;
  timestamp: string;
  status: "pending" | "acknowledged";
}

/** Grace period for newly created agents before treating missing tmux as "stopped" (ms) */
export const CREATING_GRACE_PERIOD_MS = 6_000;

/** Check if an agent was created recently (within the grace period).
 * Uses created_epoch (seconds since epoch) from meta.json. */
export function isRecentlyCreated(createdEpoch: number): boolean {
  if (!createdEpoch) return false;
  const ageMs = Date.now() - createdEpoch * 1000;
  return ageMs < CREATING_GRACE_PERIOD_MS;
}

/**
 * Check if an agent directory was recently created (within the grace period).
 * Uses the directory's filesystem birthtime. Used to suppress read errors for
 * directories that are still being set up by `ib new-agent`.
 *
 * Injectable via `isRecentlyCreatedDirCtx` for testing.
 */
async function _isRecentlyCreatedDir(dirPath: string): Promise<boolean> {
  try {
    const dirStat = await stat(dirPath);
    const ageMs = Date.now() - dirStat.birthtimeMs;
    return ageMs < CREATING_GRACE_PERIOD_MS;
  } catch {
    return false;
  }
}

export const isRecentlyCreatedDirCtx = new InjectionContext<(dirPath: string) => Promise<boolean>>(_isRecentlyCreatedDir);

/**
 * Write agent state to meta.json atomically (write .tmp, rename over original).
 * Only "running", "waiting", or "complete" are valid values.
 * No-op if meta.json doesn't exist.
 */
export async function writeAgentState(agentDir: string, state: MetaState): Promise<void> {
  const metaPath = join(agentDir, "meta.json");
  const file = Bun.file(metaPath);
  if (!(await file.exists())) return;

  try {
    const data = await file.json();
    data.state = state;
    data.state_updated_at = Math.floor(Date.now() / 1000);
    const tmpPath = metaPath + ".tmp";
    await Bun.write(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, metaPath);
  } catch {
    /* best-effort — don't crash on write failures */
  }
}

/**
 * Read agent state from meta.json.
 * Returns the state string or undefined if not present.
 */
export async function readAgentState(agentDir: string): Promise<MetaState | undefined> {
  const metaPath = join(agentDir, "meta.json");
  try {
    const file = Bun.file(metaPath);
    if (!(await file.exists())) return undefined;
    const data = await file.json();
    return data.state;
  } catch {
    return undefined;
  }
}

/**
 * Check if tmux output indicates context compaction in progress.
 * Checks for "Compacting conversation" in last 5 lines.
 */
export function isCompacting(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last5 = lines.slice(-5).join("\n");
  return last5.includes("Compacting conversation");
}

/**
 * Check if tmux output indicates rate limiting.
 * Checks for rate limit patterns in last 15 lines.
 */
export function isRateLimited(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last15 = lines.slice(-15).join("\n");

  if (last15.includes("rate_limit_error")) return true;
  const lower = last15.toLowerCase();
  return (
    lower.includes("usage limit reached") ||
    lower.includes("limit will reset at") ||
    lower.includes("hit your limit") ||
    lower.includes("/upgrade to increase your usage limit")
  );
}

/**
 * Check if tmux output indicates background tasks are running.
 * Checks for ⏵⏵ pattern in last 15 lines.
 */
export function hasBackgroundTasks(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last15 = lines.slice(-15).join("\n");
  return /⏵⏵.*·\s\d+\s/.test(last15);
}

/** Get the worktree path for an agent, or the repo root if worktree is false. */
export function agentWorktreePath(agent: Agent): string {
  if (agent.meta.worktree === false) return agent.repoPath;
  const dir = agent.archived ? "archive" : "agents";
  return join(agent.repoPath, ".ittybitty", dir, agent.id, "repo");
}

/** Compute human-readable age from epoch timestamp */
export function computeAge(createdEpoch: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - createdEpoch;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export interface AgentReadError {
  agentDir: string;
  error: string;
}

/** Read a single agent's meta.json. Returns meta or an error description.
 * Exported as _readAgentMeta for testing only. */
export async function readAgentMeta(agentDir: string): Promise<{ meta: AgentMeta | null; error?: string }> {
  try {
    const metaPath = join(agentDir, "meta.json");
    const file = Bun.file(metaPath);
    if (!(await file.exists())) return { meta: null, error: `Missing ${metaPath}` };
    const data = await file.json();
    // Basic validation: id is required
    if (!data || typeof data.id !== "string") {
      return { meta: null, error: `Malformed ${metaPath}: missing or invalid 'id'` };
    }
    // Apply sensible defaults for all fields with wrong types
    if (typeof data.session_id !== "string") data.session_id = "";
    if (typeof data.tmux_session !== "string") data.tmux_session = "";
    if (typeof data.prompt !== "string") data.prompt = "";
    if (data.manager !== null && typeof data.manager !== "string") data.manager = null;
    if (typeof data.created !== "string") data.created = "";
    if (typeof data.created_epoch !== "number") data.created_epoch = 0;
    if (typeof data.worktree !== "boolean") data.worktree = true;
    if (typeof data.worker !== "boolean") data.worker = false;
    if (typeof data.yolo !== "boolean") data.yolo = false;
    if (typeof data.model !== "string") data.model = "unknown";
    if (typeof data.claude_pid !== "string") data.claude_pid = "";
    if (data.summary !== undefined && typeof data.summary !== "string") delete data.summary;
    return { meta: data as AgentMeta };
  } catch (err) {
    return { meta: null, error: `Failed to read ${join(agentDir, "meta.json")}: ${err}` };
  }
}

export interface ReadAgentsResult {
  agents: Agent[];
  errors: AgentReadError[];
  orphanedTmuxSessions: string[];
}

/** Read agents from a single directory (agents/ or archive/) */
async function readAgentsFromDir(
  dir: string,
  repoPath: string,
  repoName: string,
  archived: boolean
): Promise<ReadAgentsResult> {
  const agents: Agent[] = [];
  const errors: AgentReadError[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(dir, entry.name);
      const { meta, error } = await readAgentMeta(agentDir);
      if (error) {
        // Suppress errors for newly-created agent directories — during creation,
        // the directory exists but meta.json may not be written yet.
        const isNewDir = await isRecentlyCreatedDirCtx.fn(agentDir);
        if (!isNewDir) {
          errors.push({ agentDir, error });
        }
      }
      if (!meta) continue;

      agents.push({
        id: meta.id,
        repoPath,
        repoName,
        meta,
        state: "unknown", // Updated by watcher via parseState()
        age: computeAge(meta.created_epoch),
        archived,
        children: [],
      });
    }
  } catch (err: unknown) {
    // ENOENT is expected — archive/ or agents/ may not exist yet
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push({ agentDir: dir, error: `Failed to read directory: ${err.message}` });
    }
  }
  return { agents, errors, orphanedTmuxSessions: [] };
}

/** Read all agents for a repo (both active and archived) */
export async function readRepoAgents(repoPath: string, repoName: string): Promise<ReadAgentsResult> {
  const agentsDir = join(repoPath, ".ittybitty", "agents");
  const archiveDir = join(repoPath, ".ittybitty", "archive");

  const [active, archived] = await Promise.all([
    readAgentsFromDir(agentsDir, repoPath, repoName, false),
    readAgentsFromDir(archiveDir, repoPath, repoName, true),
  ]);

  return {
    agents: [...active.agents, ...archived.agents],
    errors: [...active.errors, ...archived.errors],
    orphanedTmuxSessions: [],
  };
}

/** Internal helper: read questions for a repo, optionally filtering to pending-only */
async function readQuestionsInternal(repoPath: string, pendingOnly: boolean): Promise<PendingQuestion[]> {
  try {
    const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");
    const file = Bun.file(questionsPath);
    if (!(await file.exists())) return [];
    const data = await file.json();
    if (!data || !Array.isArray(data.questions)) return [];

    // Read active agent IDs from the agents directory
    const agentsDir = join(repoPath, ".ittybitty", "agents");
    let activeAgentIds: Set<string>;
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      activeAgentIds = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch (err: unknown) {
      // ENOENT expected when agents/ dir doesn't exist; other errors are unexpected
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(`Warning: failed to read agents directory: ${(err as Error).message}\n`);
      }
      activeAgentIds = new Set();
    }

    return data.questions.filter((q: PendingQuestion) =>
      activeAgentIds.has(q.agent) && (!pendingOnly || q.status === "pending")
    );
  } catch (err: unknown) {
    // Expected: file missing (ENOENT), malformed JSON, etc. — silently return empty
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`Warning: failed to read questions: ${(err as Error).message}\n`);
    }
    return [];
  }
}

/** Read pending questions for a repo, filtering out questions from non-existent agents */
export async function readPendingQuestions(repoPath: string): Promise<PendingQuestion[]> {
  return readQuestionsInternal(repoPath, true);
}

/** Read all questions (pending + acknowledged) for a repo, filtering out questions from non-existent agents */
export async function readAllQuestions(repoPath: string): Promise<PendingQuestion[]> {
  return readQuestionsInternal(repoPath, false);
}

/** Compare agents by created_epoch (chronological — oldest first) */
function byCreatedEpoch(a: Agent, b: Agent): number {
  return a.meta.created_epoch - b.meta.created_epoch;
}

/**
 * Build agent tree: set children arrays based on manager field.
 * Returns only root agents (those with no manager, or whose manager isn't in the list).
 * Siblings at each level are sorted by created_epoch (oldest first).
 */
export function buildAgentTree(agents: Agent[]): Agent[] {
  const byId = new Map<string, Agent>();
  for (const agent of agents) {
    agent.children = [];
    agent.orphaned = false;
    // Non-archived agents take priority over archived ones with the same ID
    const existing = byId.get(agent.id);
    if (!existing || existing.archived) {
      byId.set(agent.id, agent);
    }
  }

  const roots: Agent[] = [];
  for (const agent of agents) {
    const manager = agent.meta.manager ? byId.get(agent.meta.manager) : undefined;
    if (manager && !manager.archived) {
      manager.children.push(agent);
    } else {
      // If manager is set but not found or is archived, mark as orphaned
      if (agent.meta.manager) {
        agent.orphaned = true;
      }
      roots.push(agent);
    }
  }

  // Sort siblings at each level by creation date (oldest first)
  roots.sort(byCreatedEpoch);
  for (const agent of agents) {
    if (agent.children.length > 1) {
      agent.children.sort(byCreatedEpoch);
    }
  }

  return roots;
}

export type FlatEntry =
  | { kind: "agent"; agent: Agent; depth: number; connector: string }
  | { kind: "repo-header"; repoName: string; repoPath: string; hasAgents: boolean }
  | { kind: "system-coordinator"; state: string; age: string };

/**
 * Flatten agent tree into display order (depth-first), with indentation level.
 * Computes box-drawing connector strings (├──, └──, │) for tree display.
 * When repos has > 1 entry, inserts repo header rows and groups agents under them.
 * Empty repos (in repos but with no agents) get a header with repoHasAgents=false.
 *
 * Accepts either string[] (display names, legacy) or {name, path}[] (with paths for selection persistence).
 */
export function flattenAgentTree(
  roots: Agent[],
  repos: string[] | { name: string; path: string }[] = [],
  coordinator?: { state: string; age: string },
): FlatEntry[] {
  // Normalize to {name, path} format
  const repoInfos: { name: string; path: string }[] = repos.map((r) =>
    typeof r === "string" ? { name: r, path: "" } : r
  );
  const repoNames = repoInfos.map((r) => r.name);
  // Build a map from name → path for repo headers
  const repoPathByName = new Map<string, string>();
  for (const r of repoInfos) repoPathByName.set(r.name, r.path);
  const result: FlatEntry[] = [];

  // Prepend system coordinator entry before all repo headers
  if (coordinator) {
    result.push({ kind: "system-coordinator", state: coordinator.state, age: coordinator.age });
  }

  function walk(agent: Agent, depth: number, ancestorIsLast: boolean[]) {
    if (agent.archived) return;

    let connector = "";
    if (ancestorIsLast.length > 0) {
      // Build prefix from ancestors: "│   " if ancestor has more siblings, "    " if last
      for (let i = 0; i < ancestorIsLast.length - 1; i++) {
        connector += ancestorIsLast[i] ? "    " : "│   ";
      }
      // Current level connector
      connector += ancestorIsLast[ancestorIsLast.length - 1] ? "└── " : "├── ";
    }

    result.push({ kind: "agent", agent, depth, connector });
    const nonArchivedChildren = agent.children.filter((c) => !c.archived);
    for (let i = 0; i < nonArchivedChildren.length; i++) {
      const isLast = i === nonArchivedChildren.length - 1;
      walk(nonArchivedChildren[i]!, depth + 1, [...ancestorIsLast, isLast]);
    }
  }

  const nonArchivedRoots = roots.filter((r) => !r.archived);

  if (repoNames.length > 1) {
    // Group roots by repo name
    const repoGroups = new Map<string, Agent[]>();
    for (const agent of nonArchivedRoots) {
      const group = repoGroups.get(agent.repoName) ?? [];
      group.push(agent);
      repoGroups.set(agent.repoName, group);
    }

    // Collect all repo names: from agents + from repoNames (for empty repos)
    const allNames = new Set<string>(repoGroups.keys());
    for (const name of repoNames) allNames.add(name);

    // Sort alphabetically
    const sortedNames = [...allNames].sort((a, b) => a.localeCompare(b));

    for (const repoName of sortedNames) {
      const agents = repoGroups.get(repoName);
      if (agents && agents.length > 0) {
        // Repo with agents — emit repo header then walk agents
        result.push({ kind: "repo-header", repoName, repoPath: repoPathByName.get(repoName) ?? "", hasAgents: true });
        for (let i = 0; i < agents.length; i++) {
          const isLast = i === agents.length - 1;
          walk(agents[i]!, 0, [isLast]);
        }
      } else {
        // Empty repo — just a header
        result.push({ kind: "repo-header", repoName, repoPath: repoPathByName.get(repoName) ?? "", hasAgents: false });
      }
    }
  } else {
    const multiRoot = nonArchivedRoots.length > 1;
    for (let ri = 0; ri < nonArchivedRoots.length; ri++) {
      const isLast = ri === nonArchivedRoots.length - 1;
      walk(nonArchivedRoots[ri]!, 0, multiRoot ? [isLast] : []);
    }
  }
  return result;
}

/**
 * Read all agents across multiple repos.
 * Also detects orphaned tmux sessions (sessions matching ittybitty-* pattern
 * that don't correspond to any known agent).
 */
export async function readAllAgents(
  repos: Array<{ path: string; name: string }>
): Promise<ReadAgentsResult> {
  const [results, tmuxSessions] = await Promise.all([
    Promise.all(repos.map((r) => readRepoAgents(r.path, r.name))),
    listTmuxSessions(),
  ]);

  const allAgents = results.flatMap((r) => r.agents);
  const allErrors = results.flatMap((r) => r.errors);

  // Detect orphaned tmux sessions: sessions starting with "ittybitty-"
  // that don't match any known agent's tmux_session
  const knownSessions = new Set(
    allAgents.map((a) => a.meta.tmux_session).filter((s) => s)
  );
  const orphanedTmuxSessions = tmuxSessions.filter(
    (s) => s.startsWith("ittybitty-") && !knownSessions.has(s)
  );

  return {
    agents: allAgents,
    errors: allErrors,
    orphanedTmuxSessions,
  };
}


/**
 * Pre-parseState check: if the output has very few non-empty lines and no
 * Claude startup markers, the agent is still being created (tmux session exists
 * but Claude hasn't rendered yet).
 * Returns "creating" or null (null = fall through to parseState).
 * @deprecated Legacy — retained for backward compatibility. Not used by detectAgentStates().
 */
export function computeStateFromContent(stripped: string): AgentState | null {
  const nonEmptyLines = stripped.split("\n").filter((l) => l.trim() !== "").length;
  if (nonEmptyLines < 10 && !STARTUP_MARKERS.some((m) => stripped.includes(m))) {
    return "creating";
  }
  return null;
}

/**
 * Detect agent state for each agent using deterministic meta.json state
 * with tmux overrides for transient states. Mutates agent.state in place.
 *
 * Resolution order:
 * 1. Archived agents → stopped
 * 2. No tmux session → creating (if < 6s old) or stopped
 * 3. Tmux exists → check for compacting/rate_limited overrides
 * 4. Read state from meta.json → return stored value or default to running
 */
export async function detectAgentStates(agents: Agent[]): Promise<void> {
  // Step 1: archived agents
  for (const agent of agents) {
    if (agent.archived) {
      agent.state = "stopped";
    }
  }

  const active = agents.filter((a) => !a.archived);

  await Promise.all(
    active.map(async (agent) => {
      const tmuxSession = agent.meta.tmux_session;

      // Step 2: check tmux session existence
      if (!tmuxSession) {
        agent.state = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "stopped";
        return;
      }
      const output = await captureTmuxOutput(tmuxSession);
      if (output === null) {
        agent.state = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "stopped";
        return;
      }

      // Step 3: tmux exists — check transient overrides
      if (isCompacting(output)) {
        agent.state = "compacting";
        return;
      }
      if (isRateLimited(output)) {
        agent.state = "rate_limited";
        return;
      }

      // Step 4: read state from meta.json
      const metaState = agent.meta.state;
      if (metaState) {
        agent.state = metaState;
        return;
      }

      // Legacy: no state field — derive from created_epoch
      agent.state = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "running";
    })
  );
}

/**
 * Read prompt.txt for a given agent.
 * Falls back to meta.prompt if prompt.txt doesn't exist.
 */
export async function readAgentPrompt(agent: Agent): Promise<string[]> {
  const dir = agent.archived ? "archive" : "agents";
  const promptPath = join(agent.repoPath, ".ittybitty", dir, agent.id, "prompt.txt");
  try {
    const file = Bun.file(promptPath);
    if (!(await file.exists())) {
      // Fall back to meta.json prompt field
      return agent.meta.prompt ? agent.meta.prompt.split("\n") : ["No prompt available"];
    }
    const text = await file.text();
    return text ? text.split("\n") : ["prompt.txt is empty"];
  } catch {
    return agent.meta.prompt ? agent.meta.prompt.split("\n") : ["Failed to read prompt"];
  }
}

export interface DenialEntry {
  timestamp: string;
  epoch: number;
  line: string;
}

/**
 * Parse agent.log for tool denial lines.
 * Format: [YYYY-MM-DD HH:MM:SS] [PreToolUse] Permission denied: ...
 */
export function parseDenials(logLines: string[]): DenialEntry[] {
  const denials: DenialEntry[] = [];
  const pattern = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[PreToolUse\] Permission denied:/;
  for (const line of logLines) {
    const match = pattern.exec(line);
    if (match) {
      const timestamp = match[1]!;
      const epoch = new Date(timestamp.replace(" ", "T")).getTime() / 1000;
      denials.push({ timestamp, epoch, line });
    }
  }
  return denials;
}

/**
 * Read agent.log file for a given agent.
 * Returns the log content as an array of lines, or a placeholder message.
 */
export async function readAgentLog(agent: Agent): Promise<string[]> {
  const dir = agent.archived ? "archive" : "agents";
  const logPath = join(agent.repoPath, ".ittybitty", dir, agent.id, "agent.log");
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      return [`No agent.log found`];
    }
    const text = await file.text();
    if (!text.trim()) {
      return [`agent.log is empty`];
    }
    return text.split("\n");
  } catch {
    return [`Failed to read agent.log`];
  }
}
