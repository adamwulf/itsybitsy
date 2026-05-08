/**
 * `ib state` — read-only diagnostic command that lists agents (like `ib list`)
 * but augmented with PID liveness for tmux pane, claude process, and watchdog,
 * plus a count of unexpected child processes under the tmux pane.
 *
 * Pure data-gathering lives here so it can be unit-tested with injected
 * spawn/PID-liveness contexts. The CLI plumbing in src/index.ts handles
 * input parsing and human/JSON rendering.
 */

import { join } from "path";
import type { Agent } from "./agents";
import { isPidAliveCtx, readAgentTransient } from "./agents";
import { spawnCtx } from "./agent-lifecycle";
import { isValidTmuxSession } from "./validation";

/** A child process under the tmux pane that is NOT the recorded claude_pid. */
export interface UnexpectedChild {
  pid: number;
  command: string;
}

/**
 * One row of `ib state` output. PID fields are `null` when missing/invalid;
 * liveness booleans are `null` when there is no PID to check.
 */
export interface AgentStateRow {
  id: string;
  state: string;
  age: string;
  repo: string;
  tmux_session: string | null;
  tmux_pane_pid: number | null;
  tmux_pane_alive: boolean | null;
  claude_pid: number | null;
  claude_alive: boolean | null;
  watchdog_pid: number | null;
  watchdog_alive: boolean | null;
  unexpected_children: UnexpectedChild[];
}

/**
 * Parse a possibly-empty / possibly-non-numeric PID string into a positive
 * integer, or null. Mirrors how the rest of the codebase treats meta.claude_pid.
 */
function parsePid(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Look up the tmux pane's pid via `tmux list-panes -t <session> -F '#{pane_pid}'`.
 * Returns null if the session is invalid, missing, or tmux returns nothing.
 */
async function readTmuxPanePid(tmuxSession: string): Promise<number | null> {
  if (!tmuxSession || !isValidTmuxSession(tmuxSession)) return null;
  const has = await spawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
  if (has.exitCode !== 0) return null;
  const result = await spawnCtx.run([
    "tmux", "list-panes", "-t", tmuxSession, "-F", "#{pane_pid}",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return null;
  const first = result.stdout.split("\n")[0]?.trim();
  return parsePid(first);
}

/**
 * Collect child PIDs of `panePid` that are NOT the recorded claudePid, and
 * resolve each to its command string via `ps -o command=`. A child whose
 * `ps` lookup fails is skipped (process raced and exited, or insufficient
 * permission — neither is interesting for diagnostics).
 */
async function readUnexpectedChildren(
  panePid: number,
  claudePid: number | null,
): Promise<UnexpectedChild[]> {
  const pgrep = await spawnCtx.run(["pgrep", "-P", String(panePid)]);
  if (pgrep.exitCode !== 0 || !pgrep.stdout) return [];
  const children = pgrep.stdout
    .split("\n")
    .map((line) => parsePid(line))
    .filter((n): n is number => n !== null && n !== claudePid);
  if (children.length === 0) return [];
  const out: UnexpectedChild[] = [];
  for (const pid of children) {
    const ps = await spawnCtx.run(["ps", "-o", "command=", "-p", String(pid)]);
    if (ps.exitCode !== 0) continue;
    const command = ps.stdout.split("\n")[0]?.trim() ?? "";
    if (!command) continue;
    out.push({ pid, command });
  }
  return out;
}

/**
 * Gather the diagnostic row for a single agent. All PID fields become `null`
 * when missing or non-numeric. Liveness fields are `null` exactly when their
 * PID is `null` so callers can distinguish "no PID recorded" from "PID dead".
 */
export async function gatherAgentState(agent: Agent): Promise<AgentStateRow> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);

  const claudePid = parsePid(agent.meta.claude_pid);
  const tmuxSession = agent.meta.tmux_session || null;

  const [transient, panePid] = await Promise.all([
    readAgentTransient(agentDir),
    tmuxSession ? readTmuxPanePid(tmuxSession) : Promise.resolve<number | null>(null),
  ]);

  const watchdogPid = parsePid(transient?.watchdog_pid);

  const claudeAlive = claudePid === null ? null : isPidAliveCtx.fn(claudePid);
  const watchdogAlive = watchdogPid === null ? null : isPidAliveCtx.fn(watchdogPid);
  const panePidAlive = panePid === null ? null : isPidAliveCtx.fn(panePid);

  const unexpectedChildren = panePid !== null && panePidAlive === true
    ? await readUnexpectedChildren(panePid, claudePid)
    : [];

  return {
    id: agent.id,
    state: agent.state,
    age: agent.age,
    repo: agent.repoName,
    tmux_session: tmuxSession,
    tmux_pane_pid: panePid,
    tmux_pane_alive: panePidAlive,
    claude_pid: claudePid,
    claude_alive: claudeAlive,
    watchdog_pid: watchdogPid,
    watchdog_alive: watchdogAlive,
    unexpected_children: unexpectedChildren,
  };
}

/**
 * Format a single PID/liveness component as `name:<pid> <mark>`. Uses the
 * provided color writer for the mark. Returns the plain (un-colored) text
 * when `colorize` is null — keeps tests readable.
 */
export function formatPidComponent(
  name: string,
  pid: number | null,
  alive: boolean | null,
): string {
  if (pid === null) return `${name}:— —`;
  const mark = alive ? "✓" : "✗";
  return `${name}:${pid} ${mark}`;
}
