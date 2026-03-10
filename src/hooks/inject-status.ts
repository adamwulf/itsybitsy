/**
 * Global UserPromptSubmit hook: injects agent status into primary Claude's context.
 *
 * Installed in the PRIMARY Claude's ~/.claude/settings.json.
 * Reads stdin JSON from Claude Code (cwd, etc.), and if cwd is NOT inside
 * an agent worktree (i.e., this is primary Claude), outputs a status summary
 * of all registered repos and their agents.
 */

import { listRepos, repoDisplayName } from "../registry";
import type { RepoEntry } from "../registry";
import type { Agent } from "../agents";

// ── Types ────────────────────────────────────────────────────────────────────

export interface InjectStatusInput {
  cwd: string;
}

// ── Pattern ──────────────────────────────────────────────────────────────────

const AGENT_CWD_PATTERN = /\.ittybitty\/agents\/[^/]+\/repo(\/|$)/;

// ── Pure decision logic ──────────────────────────────────────────────────────

/**
 * Determine whether status injection should be skipped (agent context)
 * or whether we should inject (primary Claude context).
 */
export function shouldInjectStatus(input: InjectStatusInput): boolean {
  // If cwd is inside an agent worktree, skip injection
  return !AGENT_CWD_PATTERN.test(input.cwd);
}

/**
 * Format agent status for injection into Claude's context.
 * Returns a formatted string suitable for the additionalContext field.
 */
export function formatAgentStatus(
  repos: RepoEntry[],
  agentsByRepo: Map<string, Agent[]>
): string {
  if (repos.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push("<ittybitty-status>");

  for (const repo of repos) {
    const name = repoDisplayName(repo);
    const agents = agentsByRepo.get(repo.path) ?? [];
    const active = agents.filter((a) => !a.archived);

    if (active.length === 0) {
      lines.push(`${name}: (no agents)`);
      continue;
    }

    lines.push(`${name}:`);
    for (const agent of active) {
      const state = agent.state === "unknown" ? "running" : agent.state;
      const icon = agent.meta.worker ? "w" : "m";
      const prompt = agent.meta.prompt.slice(0, 80).replace(/\n/g, " ");
      lines.push(`  ${icon} ${agent.id} [${state}] ${agent.age} — ${prompt}`);
    }
  }

  lines.push("</ittybitty-status>");
  return lines.join("\n");
}

// ── Load agents helper ───────────────────────────────────────────────────────

export interface AgentProvider {
  getRepos(): Promise<RepoEntry[]>;
  getAgents(repos: RepoEntry[]): Promise<{ agents: Agent[] }>;
  detectStates(agents: Agent[]): Promise<void>;
}

/**
 * Default agent provider that reads from disk.
 */
export function createDiskAgentProvider(): AgentProvider {
  return {
    async getRepos() {
      return listRepos();
    },
    async getAgents(repos) {
      const { readAllAgents } = await import("../agents");
      const { agents } = await readAllAgents(repos);
      return { agents };
    },
    async detectStates(agents) {
      const { detectAgentStates } = await import("../agents");
      await detectAgentStates(agents);
    },
  };
}

/**
 * Build the full status text using the given provider.
 */
export async function buildStatusText(provider: AgentProvider): Promise<string> {
  const repos = await provider.getRepos();
  if (repos.length === 0) return "";

  const { agents } = await provider.getAgents(repos);
  await provider.detectStates(agents);

  // Group agents by repo path
  const agentsByRepo = new Map<string, Agent[]>();
  for (const agent of agents) {
    const list = agentsByRepo.get(agent.repoPath) ?? [];
    list.push(agent);
    agentsByRepo.set(agent.repoPath, list);
  }

  return formatAgentStatus(repos, agentsByRepo);
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI entry point for `ib hooks inject-status`.
 * Reads stdin JSON, checks cwd, and outputs agent status if primary Claude.
 */
export async function hookInjectStatus(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  const cwd = String(data.cwd ?? process.cwd());

  // If this is an agent's Claude, skip injection
  if (!shouldInjectStatus({ cwd })) {
    process.exit(0);
    return;
  }

  // Build status text
  const provider = createDiskAgentProvider();
  const statusText = await buildStatusText(provider);

  if (!statusText) {
    process.exit(0);
    return;
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: statusText,
    },
  };
  process.stdout.write(JSON.stringify(output));
}
