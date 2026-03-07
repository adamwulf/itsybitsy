/**
 * Read .ittybitty/agents/ directory directly to get agent data.
 * Also reads user-questions.json for pending questions.
 */

import { join } from "path";
import { readdir } from "fs/promises";
import type { AgentState } from "./parse-state";
import { parseState, STARTUP_MARKERS } from "./parse-state";
import { captureTmuxOutput } from "./tmux-poller";

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

/** Read a single agent's meta.json. Returns meta or an error description. */
async function readAgentMeta(agentDir: string): Promise<{ meta: AgentMeta | null; error?: string }> {
  try {
    const metaPath = join(agentDir, "meta.json");
    const file = Bun.file(metaPath);
    if (!(await file.exists())) return { meta: null };
    const data = await file.json();
    // Basic validation: id is required
    if (!data || typeof data.id !== "string") {
      return { meta: null, error: `Malformed ${metaPath}: missing or invalid 'id'` };
    }
    // Default tmux_session to empty string if missing
    if (typeof data.tmux_session !== "string") {
      data.tmux_session = "";
    }
    return { meta: data as AgentMeta };
  } catch (err) {
    return { meta: null, error: `Failed to read ${join(agentDir, "meta.json")}: ${err}` };
  }
}

export interface ReadAgentsResult {
  agents: Agent[];
  errors: AgentReadError[];
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
        errors.push({ agentDir, error });
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
  } catch {
    // Directory doesn't exist — not an error (archive/ may be absent)
  }
  return { agents, errors };
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
  };
}

/** Read pending questions for a repo, filtering out questions from non-existent agents */
export async function readPendingQuestions(repoPath: string): Promise<PendingQuestion[]> {
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
    } catch {
      activeAgentIds = new Set();
    }

    return data.questions.filter(
      (q: PendingQuestion) => q.status === "pending" && activeAgentIds.has(q.agent)
    );
  } catch {
    return [];
  }
}

/**
 * Build agent tree: set children arrays based on manager field.
 * Returns only root agents (those with no manager, or whose manager isn't in the list).
 */
export function buildAgentTree(agents: Agent[]): Agent[] {
  const byId = new Map<string, Agent>();
  for (const agent of agents) {
    agent.children = [];
    agent.orphaned = false;
    byId.set(agent.id, agent);
  }

  const roots: Agent[] = [];
  for (const agent of agents) {
    if (agent.meta.manager && byId.has(agent.meta.manager)) {
      byId.get(agent.meta.manager)!.children.push(agent);
    } else {
      // If manager is set but not found in the agent list, mark as orphaned
      if (agent.meta.manager) {
        agent.orphaned = true;
      }
      roots.push(agent);
    }
  }
  return roots;
}

export interface FlatAgent {
  agent: Agent;
  depth: number;
  connector: string;
  /** When set, this row is a repo header (shown only in multi-repo mode) */
  repoHeader?: string;
}

/**
 * Flatten agent tree into display order (depth-first), with indentation level.
 * Computes box-drawing connector strings (├──, └──, │) for tree display.
 * When repoCount > 1, inserts non-selectable repo header rows and groups agents under them.
 */
export function flattenAgentTree(roots: Agent[], repoCount = 1): FlatAgent[] {
  const result: FlatAgent[] = [];

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

    result.push({ agent, depth, connector });
    const nonArchivedChildren = agent.children.filter((c) => !c.archived);
    for (let i = 0; i < nonArchivedChildren.length; i++) {
      const isLast = i === nonArchivedChildren.length - 1;
      walk(nonArchivedChildren[i]!, depth + 1, [...ancestorIsLast, isLast]);
    }
  }

  const nonArchivedRoots = roots.filter((r) => !r.archived);

  if (repoCount > 1) {
    // Group roots by repo name
    const repoGroups = new Map<string, Agent[]>();
    for (const agent of nonArchivedRoots) {
      const group = repoGroups.get(agent.repoName) ?? [];
      group.push(agent);
      repoGroups.set(agent.repoName, group);
    }

    for (const [repoName, agents] of repoGroups) {
      // Insert repo header row (uses first agent as placeholder, marked with repoHeader)
      result.push({ agent: agents[0]!, depth: 0, connector: "", repoHeader: repoName });
      // Each root agent under this repo gets ├── or └── connector
      for (let i = 0; i < agents.length; i++) {
        const isLast = i === agents.length - 1;
        walk(agents[i]!, 0, [isLast]);
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
 */
export async function readAllAgents(
  repos: Array<{ path: string; name: string }>
): Promise<ReadAgentsResult> {
  const results = await Promise.all(
    repos.map((r) => readRepoAgents(r.path, r.name))
  );
  return {
    agents: results.flatMap((r) => r.agents),
    errors: results.flatMap((r) => r.errors),
  };
}


/**
 * Pre-parseState check: if the output has very few non-empty lines and no
 * Claude startup markers, the agent is still being created (tmux session exists
 * but Claude hasn't rendered yet).
 * Returns "creating" or null (null = fall through to parseState).
 */
export function computeStateFromContent(stripped: string): AgentState | null {
  const nonEmptyLines = stripped.split("\n").filter((l) => l.trim() !== "").length;
  if (nonEmptyLines < 10 && !STARTUP_MARKERS.some((m) => stripped.includes(m))) {
    return "creating";
  }
  return null;
}

/**
 * Detect agent state for each agent by capturing tmux output and running parseState().
 * Archived agents are set to "stopped". Mutates agent.state in place.
 */
export async function detectAgentStates(agents: Agent[]): Promise<void> {
  const active = agents.filter((a) => !a.archived);

  await Promise.all(
    active.map(async (agent) => {
      const tmuxSession = agent.meta.tmux_session;
      if (!tmuxSession) {
        agent.state = "unknown";
        return;
      }
      const output = await captureTmuxOutput(tmuxSession);
      if (output === null) {
        agent.state = "stopped";
        return;
      }
      const preCheck = computeStateFromContent(output);
      agent.state = preCheck ?? parseState(output).state;
    })
  );

  for (const agent of agents) {
    if (agent.archived) {
      agent.state = "stopped";
    }
  }
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
