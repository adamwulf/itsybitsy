/**
 * `ib state` — read-only diagnostic command that lists agents (like `ib list`)
 * but augmented with PID liveness for tmux pane, claude process, and watchdog,
 * plus a count of unexpected child processes under the tmux pane.
 *
 * Also surfaces ORPHANS — tmux sessions and processes that match itsybitsy's
 * naming/format but are not tied to any tracked agent. With `--cleanup`,
 * orphans are killed (and only orphans — tracked PIDs/sessions are never
 * touched).
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
import { IB_COORDINATOR_SESSION } from "./coordinator";

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
 * Format a single PID/liveness component as `name:<pid> <mark>`. ✓ marks an
 * alive PID, ✗ a dead one. When the PID is null (missing/empty/non-numeric)
 * both slots render as em-dashes: `name:— —`.
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

// ── Orphan detection ────────────────────────────────────────────────────────

/** A running process that matches our naming pattern but isn't tracked. */
export interface OrphanProcess {
  pid: number;
  command: string;
}

/**
 * The four orphan categories surfaced by `ib state`. Each array contains only
 * entries that are positively identified as orphans (matched a known itsybitsy
 * naming pattern AND are not in the tracked set built from registered repos).
 */
export interface OrphanReport {
  tmux_sessions: string[];
  claude_processes: OrphanProcess[];
  watchdog_processes: OrphanProcess[];
  ib_watch_processes: OrphanProcess[];
}

/**
 * Returns true when the given tmux session name matches a pattern itsybitsy
 * itself produces. We deliberately keep this narrow — anything outside these
 * shapes is somebody else's tmux session and must never be considered an
 * orphan we own.
 *
 * Patterns recognized:
 *   - `ib-coordinator` — the system coordinator (exact match)
 *   - `ittybitty-<repoId>-<agentId>` — every spawned agent and per-repo
 *     coordinator (newAgent in src/ib-commands.ts builds this name)
 */
export function isItsybitsyTmuxSession(name: string): boolean {
  if (!name) return false;
  if (name === IB_COORDINATOR_SESSION) return true;
  return name.startsWith("ittybitty-");
}

/**
 * Parse the output of `ps -o pid=,command= -A` into a list of `{ pid, command }`
 * entries. Each line has the pid left-padded by `ps`, then a single space, then
 * the command tail. Blank or unparseable lines are skipped.
 */
function parsePsLines(stdout: string): OrphanProcess[] {
  const out: OrphanProcess[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx <= 0) continue;
    const pidStr = line.slice(0, spaceIdx);
    const command = line.slice(spaceIdx + 1).trim();
    const pid = parsePid(pidStr);
    if (pid === null) continue;
    if (!command) continue;
    out.push({ pid, command });
  }
  return out;
}

/** Run `ps -o pid=,command= -A` once and return parsed entries. */
async function listAllProcesses(): Promise<OrphanProcess[]> {
  const result = await spawnCtx.run(["ps", "-o", "pid=,command=", "-A"]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  return parsePsLines(result.stdout);
}

/** List all tmux sessions on the host (returns empty when tmux is not running). */
async function listAllTmuxSessions(): Promise<string[]> {
  const result = await spawnCtx.run(["tmux", "list-sessions", "-F", "#{session_name}"]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Decide whether a `ps` command line belongs to a Claude process spawned by
 * itsybitsy. The agent start scripts launch `claude --resume <id> ...` or
 * `claude --session-id <uuid> ...` (see start.sh templates in
 * src/ib-commands.ts). We match on the `claude` token followed by either of
 * those flags so unrelated binaries that merely contain "claude" in their path
 * (e.g. a user editor session named claude.txt) are not misclassified.
 *
 * The match is intentionally lenient about the path prefix — Bun.which / PATH
 * resolution may render the binary as `claude`, `/usr/local/bin/claude`, or
 * similar. We anchor on the basename token via a word boundary.
 */
export function isClaudeAgentProcess(command: string): boolean {
  if (!command) return false;
  if (!/(?:^|\/|\s)claude(?:\s|$)/.test(command)) return false;
  return /\s--(?:resume|session-id)\b/.test(command);
}

/**
 * Decide whether a `ps` command line is an `ib watchdog <agent-id>` invocation.
 * Agent spawn auto-spawns `Bun.spawn(["ib", "watchdog", agentId], ...)` so the
 * argv preserves these positional tokens. We anchor on the `ib` token (so an
 * unrelated binary in someone's PATH whose name contains "watchdog" is not
 * matched) and require `watchdog` as the next arg.
 */
export function isWatchdogProcess(command: string): boolean {
  if (!command) return false;
  return /(?:^|\/|\s)ib\s+watchdog(?:\s|$)/.test(command);
}

/**
 * Decide whether a `ps` command line is an `ib watch` TUI invocation. We do
 * NOT have a "tracked" set for ib watch — every such process is reported as
 * informational so the user can see how many dashboards are open.
 */
export function isIbWatchProcess(command: string): boolean {
  if (!command) return false;
  return /(?:^|\/|\s)ib\s+watch(?:\s|$)/.test(command);
}

/**
 * Build the complete tracked set used to subtract from running processes /
 * sessions. Includes every tmux_session, claude_pid, and watchdog_pid across
 * ALL agents in ALL registered repos plus the system coordinator and per-repo
 * coordinator sessions for registered repos.
 *
 * `agents` should be the flat list returned by `readAllAgents()`.
 * `repoBasenames` is the set of repo basenames (used to compute tracked
 * coordinator session names — see notes on per-repo coordinator naming in
 * src/coordinator.ts:getCoordinatorAgentId). The coordinator's tmux session is
 * already covered by the per-agent loop because per-repo coordinators have a
 * meta.json entry with `agentType: "coordinator"`. We still add
 * `ib-coordinator` explicitly because the system coordinator has no agent dir.
 */
export interface TrackedSets {
  tmuxSessions: Set<string>;
  claudePids: Set<number>;
  watchdogPids: Set<number>;
}

export async function buildTrackedSets(agents: Agent[]): Promise<TrackedSets> {
  const tmuxSessions = new Set<string>();
  const claudePids = new Set<number>();
  const watchdogPids = new Set<number>();

  // System coordinator session is always tracked (whether running or not).
  tmuxSessions.add(IB_COORDINATOR_SESSION);

  for (const agent of agents) {
    const session = agent.meta.tmux_session;
    if (session) tmuxSessions.add(session);

    const claudePid = parsePid(agent.meta.claude_pid);
    if (claudePid !== null) claudePids.add(claudePid);

    // Watchdog PIDs live in two places — meta.json and meta.transient.json.
    // Read both so a stale-but-still-tracked watchdog is not flagged as an orphan.
    if (typeof agent.meta.watchdog_pid === "number") {
      const wp = parsePid(agent.meta.watchdog_pid);
      if (wp !== null) watchdogPids.add(wp);
    }
    const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
    const transient = await readAgentTransient(agentDir);
    if (transient) {
      const wp = parsePid(transient.watchdog_pid);
      if (wp !== null) watchdogPids.add(wp);
    }
  }

  return { tmuxSessions, claudePids, watchdogPids };
}

/**
 * Gather all four orphan categories. Pure data-gathering: shells out via
 * `spawnCtx.run` so tests can inject a fake. Caller supplies the tracked
 * sets (see `buildTrackedSets`). Anything matching an itsybitsy pattern but
 * not in the tracked set is an orphan.
 *
 * The tmux-session match is intentionally narrow (`isItsybitsyTmuxSession`),
 * and the process matches require both the binary AND the expected argv shape
 * — a bare `claude` with no `--resume`/`--session-id` is NOT flagged.
 */
export async function gatherOrphans(tracked: TrackedSets): Promise<OrphanReport> {
  const [sessions, processes] = await Promise.all([
    listAllTmuxSessions(),
    listAllProcesses(),
  ]);

  const tmuxOrphans: string[] = [];
  for (const name of sessions) {
    if (!isItsybitsyTmuxSession(name)) continue;
    if (tracked.tmuxSessions.has(name)) continue;
    tmuxOrphans.push(name);
  }

  const claudeOrphans: OrphanProcess[] = [];
  const watchdogOrphans: OrphanProcess[] = [];
  const ibWatchAll: OrphanProcess[] = [];
  for (const proc of processes) {
    if (isClaudeAgentProcess(proc.command)) {
      if (!tracked.claudePids.has(proc.pid)) claudeOrphans.push(proc);
      continue;
    }
    if (isWatchdogProcess(proc.command)) {
      if (!tracked.watchdogPids.has(proc.pid)) watchdogOrphans.push(proc);
      continue;
    }
    if (isIbWatchProcess(proc.command)) {
      ibWatchAll.push(proc);
      continue;
    }
  }

  return {
    tmux_sessions: tmuxOrphans,
    claude_processes: claudeOrphans,
    watchdog_processes: watchdogOrphans,
    ib_watch_processes: ibWatchAll,
  };
}

// ── Orphan cleanup ──────────────────────────────────────────────────────────

/** One row in the cleanup report — describes a kill attempt and its outcome. */
export interface CleanupAction {
  kind: "tmux_session" | "claude_process" | "watchdog_process" | "ib_watch_process";
  /** Session name or PID (as string for uniform JSON shape). */
  target: string;
  /** Original command line for processes, otherwise undefined. */
  command?: string;
  /** Whether the kill succeeded (process gone / session gone). */
  killed: boolean;
  /** Diagnostic — present when killed=false. */
  error?: string;
}

export interface CleanupReport {
  actions: CleanupAction[];
}

/**
 * Injection seam for `process.kill` so tests can verify which signals are sent
 * without actually killing anything. Default delegates to the real
 * `process.kill`. Keep separate from `isPidAliveCtx` because that one is
 * read-only and reused widely.
 */
export const sendSignalCtx = {
  fn: (pid: number, signal: NodeJS.Signals | 0): void => {
    process.kill(pid, signal);
  },
  set(fn: (pid: number, signal: NodeJS.Signals | 0) => void) {
    this.fn = fn;
  },
  reset() {
    this.fn = (pid: number, signal: NodeJS.Signals | 0): void => {
      process.kill(pid, signal);
    };
  },
};

/**
 * Injection seam for the post-SIGTERM grace sleep. Default 200ms (kept short —
 * cleanup is interactive and we don't want to block the user for a full second
 * per orphan). Tests override to 0 so suites stay snappy.
 */
export const cleanupSleepCtx = {
  fn: async (ms: number): Promise<void> => {
    await Bun.sleep(ms);
  },
  set(fn: (ms: number) => Promise<void>) {
    this.fn = fn;
  },
  reset() {
    this.fn = async (ms: number): Promise<void> => {
      await Bun.sleep(ms);
    };
  },
};

/** Grace period (ms) between SIGTERM and SIGKILL during cleanup. */
const CLEANUP_GRACE_MS = 200;

/**
 * SIGTERM, sleep `CLEANUP_GRACE_MS`, then SIGKILL if still alive. Mirrors the
 * shape of `killAgentProcess` in src/agent-lifecycle.ts but tighter (interactive
 * cleanup vs. the longer 2s wait used during teardown). Returns
 * `{ killed: true }` when the process is gone, `{ killed: false, error }` on
 * any failure including "still alive after SIGKILL".
 */
async function killProcessGracefully(pid: number): Promise<{ killed: boolean; error?: string }> {
  // Already dead?
  if (!isPidAliveCtx.fn(pid)) return { killed: true };

  try {
    sendSignalCtx.fn(pid, "SIGTERM");
  } catch (e) {
    return { killed: false, error: `SIGTERM failed: ${(e as Error).message}` };
  }

  await cleanupSleepCtx.fn(CLEANUP_GRACE_MS);
  if (!isPidAliveCtx.fn(pid)) return { killed: true };

  try {
    sendSignalCtx.fn(pid, "SIGKILL");
  } catch (e) {
    return { killed: false, error: `SIGKILL failed: ${(e as Error).message}` };
  }

  await cleanupSleepCtx.fn(CLEANUP_GRACE_MS);
  if (!isPidAliveCtx.fn(pid)) return { killed: true };
  return { killed: false, error: "still alive after SIGKILL" };
}

/**
 * Kill every orphan in `report` — tmux sessions via `tmux kill-session`,
 * processes via SIGTERM/SIGKILL. Returns a CleanupReport with one action per
 * orphan, in the same order as the input. The caller is responsible for
 * presenting the report to the user.
 *
 * SAFETY: Only entries already in `report` are touched. The caller must pass a
 * report from `gatherOrphans()` (or equivalent) — never construct one by hand
 * without re-running the orphan match against the tracked set.
 */
export async function cleanupOrphans(report: OrphanReport): Promise<CleanupReport> {
  const actions: CleanupAction[] = [];

  for (const session of report.tmux_sessions) {
    if (!isValidTmuxSession(session)) {
      actions.push({
        kind: "tmux_session",
        target: session,
        killed: false,
        error: "invalid tmux session name — refused to kill",
      });
      continue;
    }
    const result = await spawnCtx.run(["tmux", "kill-session", "-t", session]);
    if (result.exitCode === 0) {
      actions.push({ kind: "tmux_session", target: session, killed: true });
    } else {
      actions.push({
        kind: "tmux_session",
        target: session,
        killed: false,
        error: result.stderr || `kill-session exit ${result.exitCode}`,
      });
    }
  }

  const killEach = async (
    list: OrphanProcess[],
    kind: CleanupAction["kind"],
  ): Promise<void> => {
    for (const proc of list) {
      const result = await killProcessGracefully(proc.pid);
      actions.push({
        kind,
        target: String(proc.pid),
        command: proc.command,
        killed: result.killed,
        error: result.error,
      });
    }
  };

  await killEach(report.claude_processes, "claude_process");
  await killEach(report.watchdog_processes, "watchdog_process");
  await killEach(report.ib_watch_processes, "ib_watch_process");

  return { actions };
}
