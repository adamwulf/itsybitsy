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
import { isPidAliveCtx, killPidCtx, readAgentTransient } from "./agents";
import { spawnCtx } from "./agent-lifecycle";
import { isValidTmuxSession } from "./validation";
import { IB_COORDINATOR_SESSION } from "./coordinator";
import { InjectionContext } from "./types";

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
  const has = await spawnCtx.run(["tmux", "has-session", "-t", "=" + tmuxSession]);
  if (has.exitCode !== 0) return null;
  const result = await spawnCtx.run([
    "tmux", "list-panes", "-t", "=" + tmuxSession, "-F", "#{pane_pid}",
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
 * Strip control characters and ANSI escape sequences from a string before
 * printing it. tmux itself rejects most metacharacters, but a session name or
 * `ps` command line could in theory contain ANSI escapes that bleed into the
 * rendered output.
 *
 * Two-step strip:
 *   1. Remove complete CSI sequences (ESC [ … letter) so no broken `[31m`
 *      tail remains as visible noise after step 2 mangles the leading ESC.
 *   2. Replace any remaining control char (C0 + DEL + C1) with `?` so any
 *      non-CSI control byte still cannot escape its line.
 */
export function sanitizeForDisplay(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

/**
 * Parse the output of `ps -o pid=,command= -A` into a list of `{ pid, command }`
 * entries. Each line has the pid (possibly left-padded by `ps`), one or more
 * spaces, then the command tail. Blank or unparseable lines are skipped.
 */
function parsePsLines(stdout: string): OrphanProcess[] {
  const out: OrphanProcess[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/^\s+/, "");
    if (!line) continue;
    // `ps -o pid=,command=` always emits PID, then whitespace, then command.
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parsePid(m[1]!);
    if (pid === null) continue;
    const command = m[2]!.trim();
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

/**
 * Resolve a process's current working directory via `lsof -a -d cwd -p <pid>
 * -Fn` (macOS). Returns the empty string on Linux fallback failure or when
 * lsof isn't available — callers must treat empty as "unknown" and refuse to
 * flag the process as an itsybitsy orphan.
 */
async function readProcessCwd(pid: number): Promise<string> {
  // macOS: lsof
  if (process.platform === "darwin") {
    const result = await spawnCtx.run(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
    if (result.exitCode !== 0) return "";
    const nLine = result.stdout.split("\n").find((l) => l.startsWith("n"));
    return nLine ? nLine.slice(1) : "";
  }
  // Linux: /proc/<pid>/cwd readlink. Direct fs call (not via spawnCtx) so the
  // synthetic-path fakes spawnCtx tests install for other commands don't leak
  // here. Tests should override `readProcessCwdCtx` directly rather than rely
  // on the real `/proc/<pid>/cwd`.
  try {
    const { readlink } = await import("fs/promises");
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

/** Injectable cwd lookup for tests. */
export const readProcessCwdCtx = new InjectionContext<(pid: number) => Promise<string>>(
  readProcessCwd,
);

/** Lookup a process's current command line via `ps -o command= -p <pid>`. */
async function readProcessCommand(pid: number): Promise<string> {
  const result = await spawnCtx.run(["ps", "-o", "command=", "-p", String(pid)]);
  if (result.exitCode !== 0) return "";
  return (result.stdout.split("\n")[0] ?? "").trim();
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
 * Decide whether a `ps` command line LOOKS LIKE a Claude CLI invocation. The
 * argv shape `claude --resume <id>` and `claude --session-id <uuid>` is shared
 * between the user's own terminal sessions and itsybitsy's start.sh template
 * — argv alone is NOT enough to claim the process is ours. Use this only as a
 * narrow PRE-FILTER before checking cwd via `isClaudeAgentProcess`.
 */
export function looksLikeClaudeArgv(command: string): boolean {
  if (!command) return false;
  if (!/(?:^|\/|\s)claude(?:\s|$)/.test(command)) return false;
  return /\s--(?:resume|session-id)\b/.test(command);
}

/**
 * Decide whether a process IS a Claude agent spawned by itsybitsy. Combines
 * the argv shape pre-filter with a positive cwd check: the process's cwd must
 * be inside `<repoPath>/.ittybitty/agents/...` for at least one REGISTERED
 * repo. Anchoring on the registered repo paths (rather than just the
 * `.ittybitty/agents/` substring) closes the hole where a user has a stray
 * or backup `.ittybitty/agents/` directory somewhere on disk and runs
 * claude from there — only paths under a repo we own count.
 *
 * Why: `claude --resume` / `claude --session-id` are STANDARD Claude CLI
 * flags. A user running `claude --resume <id>` in a regular terminal must
 * NEVER be classified as an orphan we kill. The cwd anchor + repo-path
 * cross-reference closes that hole — itsybitsy-spawned claude processes
 * always run from inside an agent worktree under a registered repo (see
 * start.sh template), and user sessions don't.
 *
 * `repoPaths` should be the absolute paths from `listRepos()`. Pass an empty
 * array to disable anchoring entirely (returns false — used by callers that
 * have no repo context, e.g. some test paths).
 */
export async function isClaudeAgentProcess(
  pid: number,
  command: string,
  repoPaths: string[],
): Promise<boolean> {
  if (!looksLikeClaudeArgv(command)) return false;
  if (repoPaths.length === 0) return false;
  const cwd = await readProcessCwdCtx.fn(pid);
  if (!cwd) return false;
  for (const repoPath of repoPaths) {
    if (!repoPath) continue;
    const prefix = repoPath.endsWith("/")
      ? `${repoPath}.ittybitty/agents/`
      : `${repoPath}/.ittybitty/agents/`;
    if (cwd === prefix.slice(0, -1) || cwd.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Build the complete tracked set used to subtract from running processes /
 * sessions. Includes every tmux_session, claude_pid, and watchdog_pid across
 * ALL agents in ALL registered repos. The `ib-coordinator` session is added
 * unconditionally — it's the system coordinator's tmux session and never
 * belongs in the orphan list.
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
 * Gather all four orphan categories.
 *
 * `tracked` is the result of `buildTrackedSets(agents)`. `liveTmuxSessions`
 * is the live session set from `readAllAgents()` — passing it in (instead of
 * calling `tmux list-sessions` again) keeps this in sync with the rest of the
 * codebase's view of live sessions. Pass `null` when the caller doesn't have
 * the set handy and `gatherOrphans` will fetch it itself.
 *
 * `repoPaths` are the absolute paths of registered repos — used to verify
 * that a `claude` process's cwd lives under an itsybitsy worktree of one of
 * OUR repos (defense against stray/backup `.ittybitty/agents/` directories
 * elsewhere on disk). When no repos are registered, no claude process can
 * be classified as an orphan.
 *
 * The tmux-session match is intentionally narrow (`isItsybitsyTmuxSession`).
 * The process matches require both the binary AND the expected argv shape AND
 * (for claude) a cwd under a registered repo — argv alone is not enough.
 */
export async function gatherOrphans(
  tracked: TrackedSets,
  liveTmuxSessions: Set<string> | null = null,
  repoPaths: string[] = [],
): Promise<OrphanReport> {
  const sessions = liveTmuxSessions !== null
    ? Array.from(liveTmuxSessions)
    : await (async (): Promise<string[]> => {
      const result = await spawnCtx.run(["tmux", "list-sessions", "-F", "#{session_name}"]);
      if (result.exitCode !== 0 || !result.stdout) return [];
      return result.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    })();
  const processes = await listAllProcesses();

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
    if (isWatchdogProcess(proc.command)) {
      if (!tracked.watchdogPids.has(proc.pid)) watchdogOrphans.push(proc);
      continue;
    }
    if (isIbWatchProcess(proc.command)) {
      ibWatchAll.push(proc);
      continue;
    }
    // Claude check is async (cwd lookup) so it goes last — the cheap matchers
    // above short-circuit common processes first.
    if (looksLikeClaudeArgv(proc.command)) {
      if (tracked.claudePids.has(proc.pid)) continue;
      const isOurs = await isClaudeAgentProcess(proc.pid, proc.command, repoPaths);
      if (isOurs) claudeOrphans.push(proc);
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
  /** True when this kill was skipped — see `error` for the reason (e.g. dry-run, raced). */
  skipped?: boolean;
  /** Diagnostic — present when killed=false. */
  error?: string;
}

export interface CleanupReport {
  actions: CleanupAction[];
}

/**
 * Tests-only injection seam for the post-SIGTERM grace sleep. Default 200ms
 * — kept short because cleanup is interactive. Not a project-wide convention:
 * `agent-lifecycle.ts` uses raw `Bun.sleep` and stays untestable in this
 * dimension. Tests override this to a no-op so suites stay snappy.
 */
export const cleanupSleepCtx = new InjectionContext<(ms: number) => Promise<void>>(
  async (ms: number) => { await Bun.sleep(ms); },
);

/** Grace period (ms) between SIGTERM and SIGKILL during cleanup. */
const CLEANUP_GRACE_MS = 200;

/**
 * SIGTERM, sleep `CLEANUP_GRACE_MS`, then SIGKILL if still alive. Mirrors the
 * shape of `killAgentProcess` in src/agent-lifecycle.ts but tighter (interactive
 * cleanup vs. the longer 2s wait used during teardown). Returns
 * `{ killed: true }` when the process is gone, `{ killed: false, error }` on
 * any failure including "still alive after SIGKILL".
 *
 * `verifyCommand` is the original command line we observed for the orphan.
 * `verifyMatcher` decides whether the CURRENT process at `pid` still belongs
 * to the same itsybitsy category that flagged it (async because the claude
 * matcher re-runs the cwd check via `isClaudeAgentProcess`).
 *
 * Before SIGKILL we re-resolve `ps -o command= -p <pid>` and require either
 * an exact-match command line (no PID reuse) or a still-matching pattern
 * via `verifyMatcher`. Two safety rules:
 *   - If `ps` returns empty (transient permission/race failure), we REFUSE
 *     SIGKILL — verification couldn't happen, so we can't be sure the PID
 *     still belongs to us.
 *   - If the command line changed AND the matcher rejects the new value,
 *     somebody else owns this PID and we must NOT SIGKILL it.
 */
async function killProcessGracefully(
  pid: number,
  verifyCommand: string,
  verifyMatcher: (pid: number, cmd: string) => Promise<boolean>,
): Promise<{ killed: boolean; error?: string }> {
  // Already dead?
  if (!isPidAliveCtx.fn(pid)) return { killed: true };

  if (!killPidCtx.fn(pid, "SIGTERM")) {
    return { killed: false, error: "SIGTERM failed (already dead or no permission)" };
  }

  await cleanupSleepCtx.fn(CLEANUP_GRACE_MS);
  if (!isPidAliveCtx.fn(pid)) return { killed: true };

  // PID-reuse defense: confirm the PID still belongs to a matching itsybitsy
  // process before escalating.
  const currentCommand = await readProcessCommand(pid);
  if (!currentCommand) {
    return {
      killed: false,
      error: "could not verify PID still matches — refused to SIGKILL",
    };
  }
  if (currentCommand !== verifyCommand) {
    const stillOurs = await verifyMatcher(pid, currentCommand);
    if (!stillOurs) {
      return {
        killed: false,
        error: `PID reuse detected — refused to SIGKILL (was: ${verifyCommand}, now: ${currentCommand})`,
      };
    }
  }

  if (!killPidCtx.fn(pid, "SIGKILL")) {
    return { killed: false, error: "SIGKILL failed (already dead or no permission)" };
  }

  await cleanupSleepCtx.fn(CLEANUP_GRACE_MS);
  if (!isPidAliveCtx.fn(pid)) return { killed: true };
  return { killed: false, error: "still alive after SIGKILL" };
}

/**
 * Options controlling cleanupOrphans. `dryRun` reports actions without
 * issuing any kill commands — required by `--dry-run` so users can preview
 * what `--cleanup` would do. `repoPaths` is the absolute paths from
 * `listRepos()`; used by the claude PID-reuse re-check so a recycled PID
 * that's now a user's own `claude --resume` (cwd outside every registered
 * repo) is correctly refused for SIGKILL.
 */
export interface CleanupOptions {
  dryRun?: boolean;
  repoPaths?: string[];
}

/**
 * Kill every orphan in `report` — tmux sessions via `tmux kill-session`,
 * processes via SIGTERM/SIGKILL. Returns a CleanupReport with one action per
 * orphan, in the same order as the input. The caller is responsible for
 * presenting the report to the user.
 *
 * SAFETY: `tracked` is checked AGAIN before each kill, defending against the
 * race where a new agent was spawned between `gatherOrphans` and now. Any
 * target that has appeared in the tracked set since gather is silently
 * skipped (action.killed=false, action.skipped=true).
 *
 * The caller must pass a report from `gatherOrphans()` (or equivalent) —
 * never construct one by hand without re-running the orphan match against the
 * tracked set.
 */
export async function cleanupOrphans(
  report: OrphanReport,
  tracked: TrackedSets,
  opts: CleanupOptions = {},
): Promise<CleanupReport> {
  const repoPaths = opts.repoPaths ?? [];
  const actions: CleanupAction[] = [];
  const dryRun = opts.dryRun === true;

  for (const session of report.tmux_sessions) {
    // Race re-check: tracked could have grown since gather (a new agent was
    // spawned between gather and cleanup).
    if (tracked.tmuxSessions.has(session)) {
      actions.push({
        kind: "tmux_session",
        target: session,
        killed: false,
        skipped: true,
        error: "raced with new agent — session is now tracked",
      });
      continue;
    }
    if (!isValidTmuxSession(session)) {
      actions.push({
        kind: "tmux_session",
        target: session,
        killed: false,
        error: "invalid tmux session name — refused to kill",
      });
      continue;
    }
    if (dryRun) {
      actions.push({
        kind: "tmux_session",
        target: session,
        killed: false,
        skipped: true,
        error: "dry-run",
      });
      continue;
    }
    const result = await spawnCtx.run(["tmux", "kill-session", "-t", "=" + session]);
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

  // Helper: kill all processes in a list, gated by a per-kill tracked-set
  // re-check + an async verifying matcher used for PID-reuse defense.
  const killEach = async (
    list: OrphanProcess[],
    kind: CleanupAction["kind"],
    trackedPids: Set<number>,
    verifyMatcher: (pid: number, cmd: string) => Promise<boolean>,
  ): Promise<void> => {
    for (const proc of list) {
      if (trackedPids.has(proc.pid)) {
        actions.push({
          kind,
          target: String(proc.pid),
          command: proc.command,
          killed: false,
          skipped: true,
          error: "raced with new agent — PID is now tracked",
        });
        continue;
      }
      if (dryRun) {
        actions.push({
          kind,
          target: String(proc.pid),
          command: proc.command,
          killed: false,
          skipped: true,
          error: "dry-run",
        });
        continue;
      }
      const result = await killProcessGracefully(proc.pid, proc.command, verifyMatcher);
      actions.push({
        kind,
        target: String(proc.pid),
        command: proc.command,
        killed: result.killed,
        error: result.error,
      });
    }
  };

  // Per-kind verify matchers. These run only on a CHANGED command line — they
  // decide whether the new owner of the PID is still an itsybitsy process of
  // the same category (i.e. true → safe to SIGKILL, false → refuse).
  //   - claude: re-run isClaudeAgentProcess so the cwd anchor is re-verified.
  //     argv-only matching here would re-introduce R1#1's false-positive
  //     hole during PID reuse.
  //   - watchdog / ib watch: argv check is sufficient; no cwd anchor exists
  //     for these (the original orphan classification didn't use one either).
  const claudeVerify = (pid: number, cmd: string): Promise<boolean> =>
    isClaudeAgentProcess(pid, cmd, repoPaths);
  const watchdogVerify = async (_pid: number, cmd: string): Promise<boolean> =>
    isWatchdogProcess(cmd);
  const ibWatchVerify = async (_pid: number, cmd: string): Promise<boolean> =>
    isIbWatchProcess(cmd);

  // For ib watch processes there is no tracked PID set — pass an empty Set so
  // every process in the list gets a kill attempt (or skipped only if we
  // start tracking these in the future).
  await killEach(report.claude_processes, "claude_process", tracked.claudePids, claudeVerify);
  await killEach(report.watchdog_processes, "watchdog_process", tracked.watchdogPids, watchdogVerify);
  await killEach(report.ib_watch_processes, "ib_watch_process", new Set<number>(), ibWatchVerify);

  return { actions };
}

/**
 * Race-safe cleanup entrypoint. Re-reads agents from DISK via `refreshAgents`
 * (so a freshly-spawned agent that landed in the registry between the initial
 * `gatherOrphans` and now is visible), rebuilds `tracked` from that fresh
 * snapshot, and calls `cleanupOrphans`.
 *
 * The race this guards against: `ib state --cleanup` builds an `agents`
 * snapshot at T=0, gathers orphans at T=10ms, and cleans up at T=50ms. If
 * another terminal runs `ib new-agent` at T=20ms, that new agent's PID and
 * tmux session are written to disk by T=30ms — but the in-memory `agents`
 * snapshot from T=0 doesn't contain them. Without a re-read, `cleanupOrphans`
 * would skip its tracked-set guard for the new agent and kill it.
 *
 * `refreshAgents` is injected (rather than imported directly from agents.ts)
 * so unit tests can simulate the "new agent appears between gather and
 * cleanup" race without touching the filesystem.
 */
export async function prepareAndRunCleanup(
  orphans: OrphanReport,
  refreshAgents: () => Promise<{ agents: Agent[] }>,
  opts: CleanupOptions = {},
): Promise<{ trackedNow: TrackedSets; cleanupReport: CleanupReport }> {
  const { agents } = await refreshAgents();
  const trackedNow = await buildTrackedSets(agents);
  const cleanupReport = await cleanupOrphans(orphans, trackedNow, opts);
  return { trackedNow, cleanupReport };
}
