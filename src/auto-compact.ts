/**
 * Auto-compact: reads Claude transcript files to determine context usage %,
 * and sends /compact to agents that exceed the configured threshold.
 *
 * Matches ib's get_agent_context_usage() logic for transcript parsing.
 */

import { join } from "path";
import { homedir } from "os";
import type { Agent } from "./agents";
import { agentWorktreePath } from "./agents";
import { logAgent } from "./agent-lifecycle";
import { isValidTmuxSession } from "./validation";

/**
 * Encode a worktree path into Claude's project directory name.
 * Matches ib's encode_claude_project_path(): replace both / and . with -
 */
export function encodeClaudeProjectPath(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, "-");
}

/**
 * Build the full path to an agent's transcript JSONL file.
 */
export function transcriptPath(agent: Agent): string {
  const worktree = agentWorktreePath(agent);
  const encoded = encodeClaudeProjectPath(worktree);
  const home = process.env.HOME ?? homedir();
  return join(home, ".claude", "projects", encoded, `${agent.meta.session_id}.jsonl`);
}

/** Usage data extracted from a transcript entry */
export interface TranscriptUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

/** Default context window size for unknown models */
const DEFAULT_CONTEXT_SIZE = 200_000;

/**
 * Model context size lookup table.
 * Each entry: [substring to match in model name, context size in tokens].
 * Checked in order — first match wins.
 */
const MODEL_CONTEXT_SIZES: Array<[string, number]> = [
  ["4-5", 1_000_000],  // Sonnet 4.5 / Opus 4.5 — 1M context
  ["4.5", 1_000_000],
  ["4-6", 200_000],    // Claude 4.6 — explicitly 200K (same as default, documented for clarity)
  ["4.6", 200_000],
  ["sonnet", 200_000],  // Common shorthands used by Claude Code — all 200K
  ["opus", 200_000],
  ["haiku", 200_000],
];

/** Set of model substrings we've already warned about */
const warnedModels = new Set<string>();

/**
 * Determine context window size based on model name.
 * Sonnet 4.5 / Opus 4.5 have 1M context; others have 200K.
 * Matches ib's logic: check for "4-5" or "4.5" in model string.
 * Logs a warning (once per model) when falling back to default for an unknown model.
 */
export function contextSizeForModel(model: string): number {
  for (const [substring, size] of MODEL_CONTEXT_SIZES) {
    if (model.includes(substring)) {
      return size;
    }
  }
  // Unknown model — log warning once per unique model string
  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    console.error(`[auto-compact] Unknown model "${model}" — using default context size ${DEFAULT_CONTEXT_SIZE}`);
  }
  return DEFAULT_CONTEXT_SIZE;
}

/** Clear warned models set (for testing) */
export function resetWarnedModels(): void {
  warnedModels.clear();
}

/**
 * Parse a transcript JSONL string and return the usage from the last
 * non-sidechain entry that has message.usage data.
 *
 * Matches ib's json_parse_usage_jsonl() logic exactly.
 */
export function parseTranscriptUsage(jsonlContent: string): TranscriptUsage | null {
  const lines = jsonlContent.split("\n").filter((l) => l.trim() !== "");
  let lastUsage: TranscriptUsage | null = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Skip sidechain entries (matches ib: .isSidechain != true)
      if (obj.isSidechain === true) continue;
      // Must have message.usage
      if (obj.message?.usage) {
        const u = obj.message.usage;
        lastUsage = {
          input_tokens: u.input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
        };
      }
    } catch {
      // Skip malformed lines
    }
  }

  return lastUsage;
}

/**
 * Calculate context usage percentage from usage data and model.
 */
export function calculateUsagePercent(usage: TranscriptUsage, model: string): number {
  const contextSize = contextSizeForModel(model);
  const totalTokens =
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens;
  return Math.floor((totalTokens * 100) / contextSize);
}

/**
 * Read an agent's transcript file and return context usage percentage.
 * Returns null if transcript doesn't exist or can't be parsed.
 */
export async function getAgentContextUsage(agent: Agent): Promise<number | null> {
  if (!agent.meta.session_id) return null;

  const path = transcriptPath(agent);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const content = await file.text();
  const usage = parseTranscriptUsage(content);
  if (!usage) return null;

  return calculateUsagePercent(usage, agent.meta.model);
}

/** Pluggable usage reader for checkAndCompact — allows test injection */
export type UsageReader = (agent: Agent) => Promise<number | null>;
let usageReader: UsageReader = getAgentContextUsage;

/** Override the usage reader (for testing) */
export function setUsageReader(reader: UsageReader): void {
  usageReader = reader;
}

/** Reset the usage reader */
export function resetUsageReader(): void {
  usageReader = getAgentContextUsage;
}

/** Per-agent tracking for compact sends */
export interface CompactState {
  compactSent: boolean;
}

/** Pluggable spawn runner for sendCompact — defaults to Bun.spawn, overridable for tests */
export type CompactSpawnFn = (cmd: string[]) => { exited: Promise<number> };
let compactSpawnRunner: CompactSpawnFn = (cmd) => Bun.spawn(cmd);

/** Override the compact spawn runner (for testing) */
export function setCompactSpawnRunner(runner: CompactSpawnFn): void {
  compactSpawnRunner = runner;
}

/** Reset the compact spawn runner */
export function resetCompactSpawnRunner(): void {
  compactSpawnRunner = (cmd) => Bun.spawn(cmd);
}

/**
 * Send /compact to an agent's tmux session.
 * Returns true if the command was sent successfully.
 */
export async function sendCompact(tmuxSession: string): Promise<boolean> {
  if (!isValidTmuxSession(tmuxSession)) {
    console.error(`[auto-compact] Invalid tmux session name: ${tmuxSession}`);
    return false;
  }
  try {
    const proc = compactSpawnRunner(["tmux", "send-keys", "-t", tmuxSession, "/compact", "Enter"]);
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check a single agent for auto-compact eligibility and send /compact if needed.
 *
 * @param agent - The agent to check
 * @param threshold - The autoCompactThreshold from config (percentage 0-100)
 * @param state - Mutable per-agent compact state
 * @param lastCheckMs - The watchdog's previous compact-check timestamp (ms since epoch),
 *   captured BEFORE the current tick stamped `lastCompactCheckMs = now`. Used purely
 *   for the audit log line so operators can see the cadence of checks. 0 means "first
 *   check for this agent" — no prior interval to report.
 * @returns The current usage percentage (or null if unavailable)
 */
export async function checkAndCompact(
  agent: Agent,
  threshold: number,
  state: CompactState,
  lastCheckMs?: number,
): Promise<number | null> {
  const usagePct = await usageReader(agent);
  if (usagePct === null) return null;

  if (usagePct < threshold) {
    // Context dropped below threshold — clear the flag
    state.compactSent = false;
    return usagePct;
  }

  // Usage exceeds threshold
  if (!state.compactSent) {
    // Only send if agent is in a state where it can safely receive input
    if (agent.state === "running" || agent.state === "waiting") {
      const sent = await sendCompact(agent.meta.tmux_session);
      if (sent) {
        state.compactSent = true;
        const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
        const sinceLast = lastCheckMs && lastCheckMs > 0
          ? `${Date.now() - lastCheckMs}ms`
          : "n/a";
        await logAgent(
          agentDir,
          `[auto-compact] sent /compact: usage=${usagePct}% threshold=${threshold}% timeSinceLastCheck=${sinceLast}`,
        );
      }
    }
  }

  return usagePct;
}
