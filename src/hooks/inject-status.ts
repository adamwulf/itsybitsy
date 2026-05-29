/**
 * Global UserPromptSubmit hook: injects agent status into primary Claude's context.
 *
 * Installed in the PRIMARY Claude's ~/.claude/settings.json.
 * Reads stdin JSON from Claude Code (cwd, etc.), and if cwd is NOT inside
 * an agent worktree (i.e., this is primary Claude), outputs a status summary
 * of all registered repos and their agents.
 *
 * Supports flags: --full (default), --if-changed, --brief, --visible
 */

import { join } from "node:path";
import { listRepos, repoDisplayName } from "../registry";
import type { RepoEntry } from "../registry";
import { resolveAgentIconChar } from "../agents";
import type { Agent } from "../agents";
import { readConfig } from "../config";
import { AGENT_CWD_PATTERN } from "./shared";

// ── Types ────────────────────────────────────────────────────────────────────

export interface InjectStatusInput {
  cwd: string;
}

export type InjectStatusMode = "full" | "if-changed" | "brief";

export interface InjectStatusOptions {
  mode: InjectStatusMode;
  visible: boolean;
}

export interface BuildStatusResult {
  text: string;
  agents: Agent[];
  repos: RepoEntry[];
}

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
      const icon = resolveAgentIconChar(agent.meta);
      const prompt = (agent.meta.summary ?? agent.meta.prompt).slice(0, 80).replace(/\n/g, " ");
      lines.push(`  ${icon} ${agent.id} [${state}] ${agent.age} — ${prompt}`);
    }
  }

  lines.push("</ittybitty-status>");
  return lines.join("\n");
}

// ── Brief summary ───────────────────────────────────────────────────────────

/**
 * Produce a brief one-liner summary of agent states.
 * Format: '2 running, 1 waiting' (skip states with 0 count).
 * Returns 'no agents' if no active agents.
 */
export function briefSummary(agents: Agent[], questionCount?: number): string {
  const active = agents.filter((a) => !a.archived);
  if (active.length === 0) return "no agents";

  const counts = new Map<string, number>();
  for (const agent of active) {
    // Map compacting and unknown to running (same as formatAgentStatus)
    let state: string = agent.state;
    if (state === "compacting" || state === "unknown") state = "running";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  // Ordered state display. op_stuck/merging/restarting are surfaced so the
  // primary Claude's status summary reflects in-flight long-running ops;
  // op_stuck is actionable (kill/nuke the wedged agent) so it leads.
  const order = ["op_stuck", "running", "waiting", "merging", "restarting", "complete", "rate_limited", "api_error", "stopped", "creating"];
  const parts: string[] = [];
  for (const s of order) {
    const n = counts.get(s);
    if (n && n > 0) parts.push(`${n} ${s}`);
  }

  if (questionCount && questionCount > 0) {
    parts.push(`${questionCount} question${questionCount > 1 ? "s" : ""}`);
  }

  return parts.length > 0 ? parts.join(", ") : "no agents";
}

// ── Pending question count ────────────────────────────────────────────────────

/**
 * Count pending questions across all repos, filtering out questions from
 * dead/archived agents.
 */
export async function countPendingQuestions(
  repos: RepoEntry[],
  agents: Agent[]
): Promise<number> {
  const activeAgentIds = new Set(
    agents.filter((a) => !a.archived).map((a) => a.id)
  );
  let count = 0;
  for (const repo of repos) {
    const questionsPath = join(repo.path, ".ittybitty", "user-questions.json");
    try {
      const file = Bun.file(questionsPath);
      if (!(await file.exists())) continue;
      const data = JSON.parse(await file.text());
      const questions = data.questions ?? [];
      for (const q of questions) {
        if (q.status === "pending" && activeAgentIds.has(q.agent)) {
          count++;
        }
      }
    } catch {
      // ignore missing or malformed files
    }
  }
  return count;
}

// ── Load agents helper ───────────────────────────────────────────────────────

export interface AgentDataSource {
  getRepos(): Promise<RepoEntry[]>;
  getAgents(repos: RepoEntry[]): Promise<{ agents: Agent[] }>;
  detectStates(agents: Agent[]): Promise<void>;
}

/**
 * Default agent provider that reads from disk.
 */
export function createDiskAgentProvider(): AgentDataSource {
  return {
    async getRepos() {
      return listRepos();
    },
    async getAgents(repos) {
      const { readAllAgents } = await import("../agents");
      // includeArchived: false — buildStatusText/briefSummary/countPendingQuestions
      // all filter `!a.archived`, so archived agents would be discarded anyway.
      const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
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
 * Also returns the flat agents list for brief summary generation.
 */
export async function buildStatusText(provider: AgentDataSource): Promise<BuildStatusResult> {
  const repos = await provider.getRepos();
  if (repos.length === 0) return { text: "", agents: [], repos: [] };

  const { agents } = await provider.getAgents(repos);
  await provider.detectStates(agents);

  // Group agents by repo path
  const agentsByRepo = new Map<string, Agent[]>();
  for (const agent of agents) {
    const list = agentsByRepo.get(agent.repoPath) ?? [];
    list.push(agent);
    agentsByRepo.set(agent.repoPath, list);
  }

  const text = formatAgentStatus(repos, agentsByRepo);
  return { text, agents, repos };
}

// ── Hash cache for --if-changed ──────────────────────────────────────────────

function safeRepoId(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function hashCachePath(cwd: string): string {
  return `/tmp/ib-status-hash-${safeRepoId(cwd)}`;
}

export async function checkAndUpdateHash(
  content: string,
  cwd: string
): Promise<boolean> {
  const currentHash = new Bun.CryptoHasher("sha256")
    .update(content)
    .digest("hex");
  const cachePath = hashCachePath(cwd);

  try {
    const file = Bun.file(cachePath);
    if (await file.exists()) {
      const cached = (await file.text()).trim();
      if (cached === currentHash) return false; // unchanged
    }
  } catch {
    // No cache file or read error — treat as changed
  }

  await Bun.write(cachePath, currentHash);
  return true; // changed
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI entry point for `ib hooks inject-status`.
 * Reads stdin JSON, checks cwd, and outputs agent status if primary Claude.
 */
export async function hookInjectStatus(
  options: InjectStatusOptions = { mode: "full", visible: false },
  rawStdin?: string,
): Promise<void> {
  const raw = rawStdin ?? await new Response(Bun.stdin.stream()).text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  const cwd = String(data.cwd ?? process.cwd());
  const hookEventName = String(data.hook_event_name ?? "UserPromptSubmit");

  // If this is an agent's Claude, skip injection
  if (!shouldInjectStatus({ cwd })) {
    process.exit(0);
    return;
  }

  // Check config: hooks.injectStatus
  const config = await readConfig();
  if (config["hooks.injectStatus"]?.value === false) {
    process.exit(0);
    return;
  }

  // Build status text
  const provider = createDiskAgentProvider();
  const { text: statusText, agents, repos } = await buildStatusText(provider);

  if (!statusText) {
    process.exit(0);
    return;
  }

  const questionCount = await countPendingQuestions(repos, agents);
  const brief = briefSummary(agents, questionCount);
  let outputContent: string;

  if (options.mode === "brief") {
    outputContent = `Agents: ${brief}`;
  } else if (options.mode === "if-changed") {
    const changed = await checkAndUpdateHash(statusText, cwd);
    if (!changed) {
      process.exit(0);
      return;
    }
    outputContent = `Agents: ${brief}`;
  } else {
    // full mode
    outputContent = statusText;
  }

  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: outputContent,
    },
  };

  // --visible: add systemMessage if config allows
  if (options.visible) {
    const statusVisible = config["hooks.statusVisible"]?.value !== false;
    if (statusVisible && brief !== "no agents") {
      output.systemMessage = `[ib] Agents: ${brief}`;
    }
  }

  process.stdout.write(JSON.stringify(output));
}
