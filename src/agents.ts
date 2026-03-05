/**
 * Read .ittybitty/agents/ directory directly to get agent data.
 * Also reads user-questions.json for pending questions.
 */

import { join } from "path";
import { readdir } from "fs/promises";
import type { AgentState } from "./parse-state";

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
      return { meta: null, error: `Malformed meta.json in ${agentDir}: missing or invalid 'id'` };
    }
    return { meta: data as AgentMeta };
  } catch (err) {
    return { meta: null, error: `Failed to read meta.json in ${agentDir}: ${err}` };
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

/** Read pending questions for a repo */
export async function readPendingQuestions(repoPath: string): Promise<PendingQuestion[]> {
  try {
    const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");
    const file = Bun.file(questionsPath);
    if (!(await file.exists())) return [];
    const data = await file.json();
    if (!data || !Array.isArray(data.questions)) return [];
    return data.questions.filter((q: PendingQuestion) => q.status === "pending");
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
    byId.set(agent.id, agent);
  }

  const roots: Agent[] = [];
  for (const agent of agents) {
    if (agent.meta.manager && byId.has(agent.meta.manager)) {
      byId.get(agent.meta.manager)!.children.push(agent);
    } else {
      roots.push(agent);
    }
  }
  return roots;
}

export interface FlatAgent {
  agent: Agent;
  depth: number;
}

/**
 * Flatten agent tree into display order (depth-first), with indentation level.
 */
export function flattenAgentTree(roots: Agent[]): FlatAgent[] {
  const result: FlatAgent[] = [];

  function walk(agent: Agent, depth: number) {
    result.push({ agent, depth });
    for (const child of agent.children) {
      walk(child, depth + 1);
    }
  }

  for (const root of roots) {
    walk(root, 0);
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
