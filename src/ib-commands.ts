/**
 * Async wrappers for ib mutation commands.
 * Git operations target the agent's repo via `git -C <repoPath>` rather than
 * relying on process-wide cwd; a handful of subprocess calls set `cwd` explicitly.
 * All commands are implemented natively — no ib CLI dependency.
 */

import { join, dirname, resolve, basename } from "path";
import { readdir, chmod, rm, mkdir, rename, stat } from "fs/promises";
import { realpathSync } from "fs";
import { homedir } from "node:os";
import type { Agent, SpawnedBy, AgentOperationKind } from "./agents";
import {
  writeAgentState,
  isRecentlyCreated,
  isPidAliveCtx,
  nowMsCtx,
  OP_STUCK_TIMEOUT_MS,
  readAgentTransient,
  setAgentOperation,
  clearAgentOperation,
  TRANSIENT_FRESH_MS,
  readAllAgents,
  detectAgentStates,
} from "./agents";
import {
  enqueueOutbox,
  readOutbox,
  rewriteOutboxRemoving,
  acquireOutboxLock,
  releaseOutboxLock,
  agentOutboxDir,
  type OutboxMessage,
  type AcquireLockOpts,
} from "./outbox";
import {
  logAgent,
  logSpawn,
  removeAgentQuestions,
  killAgentProcess,
  teardownAgent,
  scanAndKillOrphans,
  getDescendantsRecursive,
  resolveGitRoot,
  archiveAgent,
  captureTmuxOutputToFile,
  isRunningAsAgent,
} from "./agent-lifecycle";
import { readConfig } from "./config";
import { listTmuxSessions } from "./tmux-poller";
import { logToWatchLog } from "./watch-log";
import { SpawnContext, InjectionContext } from "./types";
import type { SpawnFn } from "./types";
import { isValidModel, isValidToolList, isValidTmuxSession, isValidSessionId, isValidShellPath, isValidAgentId, shellQuote } from "./validation";
import { getTmuxWidthForAgent } from "./tui/widths";
import { buildPerRepoCoordinatorSettings, checkCoordinatorExists, getCoordinatorAgentId, getCoordinatorHome } from "./coordinator";
import { loadAgentType, agentTypeExists } from "./agent-types";
import type { AgentType } from "./agent-types";
import { parseModel } from "./agent-cli";
import { isKnownModel, listKnownSelectorsForCli } from "./known-models";
import {
  buildHooksBlock,
  COORDINATOR_INTERCEPT_MATCHER,
  REGULAR_AGENT_DEFAULT_ALLOW,
  REGULAR_AGENT_DEFAULT_DENY,
  REGULAR_AGENT_INTERCEPT_MATCHER,
} from "./settings-builder";
import { listRepos, repoDisplayName, type RepoEntry } from "./registry";
import {
  type Team,
  normalizeTeamName,
  isValidTeamName,
  isReservedTeamName,
  getTeam,
  listTeams,
  createTeam,
  deleteTeam,
  addMember,
  removeMember,
  pruneDeadMembers,
} from "./teams";
import {
  appendChannelMessage,
  appendChannelSystemMessage,
  appendTeamLog,
  deleteChannelFiles,
} from "./team-channel";
import { timed } from "./perf";

export interface IbCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `@`-prefixed sentinels whose displayed `[sent by ...]:` label drops the `@`.
 * These senders are still routed/detected by their `@<name>` form (so the
 * sentinel allow-list in sendMessage still recognises them as non-agent IDs
 * and omits the literal "agent " word), but the recipient-visible prefix
 * renders as `[sent by <name>]` rather than `[sent by @<name>]`. The intent
 * is to avoid the `@` namespace shared with routable coordinator addressing
 * (`@system`, `@<repo-name>`) for sentinels that can never be a `ib send`
 * target — `@watchdog` is the canonical example.
 */
export const BARE_RENDERED_SENTINELS: ReadonlySet<string> = new Set(["@watchdog"]);

/**
 * Shared syntactic + reservation validator for a user-supplied agent NAME.
 * Used for both new-agent custom ids and `ib nickname` aliases so the two share
 * one definition of "valid". Returns an error string when the name is invalid,
 * or `null` when it passes. Does NOT check id/nickname collisions against other
 * agents — those are global readAllAgents() scans the callers run separately.
 *
 * The repo list is a parameter because the repo-collision check needs it;
 * new-agent already has `repos` in scope, and renameAgent must `await
 * listRepos()` and pass it in.
 *
 * Checks (mirrors the original inline new-agent checks):
 *   - allowlist `/^[a-zA-Z0-9_\-]+$/` (bars `@`, `.`, spaces, etc.)
 *   - reserved `coordinator` / `system` (used for coordinator addressing)
 *   - collision against any registered repo's display name OR basename. NOTE:
 *     `repoDisplayName(r)` is the repo's own nickname-or-name (a pre-existing,
 *     DISTINCT concept from an agent's meta.nickname); agent names must not
 *     collide with either form.
 */
export function validateAgentName(name: string, repos: RepoEntry[]): string | null {
  if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
    return "agent name may only contain letters, digits, hyphens, and underscores";
  }
  if (name === "coordinator") {
    return '"coordinator" is a reserved name (used for system coordinator addressing)';
  }
  if (name === "system") {
    return '"system" is a reserved name (used for system coordinator addressing)';
  }
  const collision = repos.find((r) => repoDisplayName(r) === name || r.name === name);
  if (collision) {
    return `agent name "${name}" collides with registered repo name`;
  }
  return null;
}


/**
 * Write meta.json atomically (write .tmp + rename). Mirrors the pattern in
 * writeAgentState() — used during newAgent() to publish the initial meta.json
 * before slow steps (worktree-add) so the dashboard does not flag the in-progress
 * agent dir as orphaned.
 */
async function writeMetaJsonAtomic(agentDir: string, meta: Record<string, unknown>): Promise<void> {
  const metaPath = join(agentDir, "meta.json");
  const tmpPath = metaPath + ".tmp";
  await Bun.write(tmpPath, JSON.stringify(meta, null, 2) + "\n");
  await rename(tmpPath, metaPath);
}

/** Human-readable verb for an op kind, used in the guard refusal message. */
function humanizeOpKind(kind: AgentOperationKind): string {
  switch (kind) {
    case "merge_check":
      return "merge-checking";
    case "merging":
      return "merging";
    case "restarting":
      return "restarting";
  }
}

/**
 * Result of acquiring the long-running-op guard. On refusal, `stderr` carries
 * a user-facing "Agent is currently …" message that the dashboard surfaces.
 */
type AcquireOpResult = { ok: true } | { ok: false; stderr: string };

/**
 * Shared preflight for the three slow agent ops (merge-check, merge, restart).
 * Reads the durable, cross-process op marker from meta.transient.json:
 *  - if an op is in flight AND its holder process is alive AND it has not run
 *    past OP_STUCK_TIMEOUT_MS → refuse.
 *  - otherwise (no op, the holder has died → crash reclaim, or the op is older
 *    than the stuck timeout → age reclaim) → take the marker for `kind` and
 *    proceed.
 *
 * The age-reclaim branch keeps this consistent with detectAgentStates, which
 * paints `op_stuck` on `holderDead || tooOld`. Without it, a crash followed by
 * OS PID-reuse (the dead holder's pid now belongs to an unrelated live process)
 * would make this guard refuse retries forever while the dashboard shows
 * op_stuck — the two would disagree about the same marker.
 *
 * The marker is cleared in the op's `finally`; a crash mid-op leaves it behind
 * so the next acquire reclaims it (dead-holder or too-old) and detectAgentStates
 * can paint `op_stuck`. Uses the injectable isPidAliveCtx/nowMsCtx so tests can
 * stub liveness and time.
 *
 * kill/nuke/pause/reassign deliberately do NOT call this — they are the
 * recovery path for a wedged op and must never be blocked by the guard.
 */
async function acquireAgentOperation(
  agentDir: string,
  kind: AgentOperationKind,
): Promise<AcquireOpResult> {
  const t = await readAgentTransient(agentDir);
  const op = t?.operation;
  if (op && op.pid > 0 && isPidAliveCtx.fn(op.pid)) {
    const tooOld = nowMsCtx.fn() - op.started_at_ms > OP_STUCK_TIMEOUT_MS;
    if (!tooOld) {
      return {
        ok: false,
        stderr: `Agent is currently ${humanizeOpKind(op.kind)} (pid ${op.pid}) — try again when it finishes`,
      };
    }
    // live holder but op ran past the stuck timeout → age reclaim.
  }
  // op absent, holder dead, or op too old → reclaim and proceed.
  await setAgentOperation(agentDir, { kind, pid: process.pid, started_at_ms: nowMsCtx.fn() });
  return { ok: true };
}

/** Spawn context for kill/pause operations */
export const killPauseSpawnCtx = new SpawnContext();

/** Override the kill/pause spawn runner (for testing) */
export function setKillPauseSpawnRunner(runner: SpawnFn): void {
  killPauseSpawnCtx.set(runner);
}

/** Reset the kill/pause spawn runner */
export function resetKillPauseSpawnRunner(): void {
  killPauseSpawnCtx.reset();
}

// ===========================================================================
// Teardown leave-notices (§16.4.2 / §16.5). These are owned by THIS layer (the
// command layer has `listRepos()`); `agent-lifecycle.ts` only performs the
// membership write and threads the pruned `(team, id)` pairs up. There are TWO
// notice shapes, chosen by WHICH COMMAND drove the departure (not a runtime
// flag):
//   - PER-AGENT  (ib kill, ib merge): `left the team`, `fromAgent` = departed id.
//   - COALESCED  (any ib nuke): one `N member(s) left @team` per team, system
//                sender — avoids an O(N²) notice storm on bulk teardown.
// Both snapshot the SURVIVING members from the POST-prune roster (the departed
// ids are already absent) and are BEST-EFFORT — a delivery failure can never
// throw out of the driving command. An empty survivor set sends nothing
// (empty-survivor carve-out, §16.5).
// ===========================================================================

/**
 * PER-AGENT leave notice (§16.4.2) for `ib kill` / `ib merge`. For each pruned
 * `(team, departedId)` pair, snapshot the team's SURVIVING members (post-prune
 * via `getTeam`, so the departed id is already gone), resolve each to an Agent,
 * and send `left the team` with `fromAgent` stamped EXPLICITLY to the departed
 * id (§16.5 — never cwd-auto-detected; the departed worktree is gone). A team
 * with no survivors sends nothing. Best-effort: all failures are swallowed.
 */
async function emitPerAgentLeaveNotice(
  prunedTeams: Array<{ team: string; id: string }>,
  repos: RepoEntry[],
): Promise<void> {
  if (prunedTeams.length === 0) return;
  try {
    const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const { team: teamName, id: departedId } of prunedTeams) {
      // Audit the departure in the team's <team>.log (§17.4). Best-effort.
      await appendTeamLog(teamName, `agent ${departedId} left (kill/merge)`).catch(() => {});
      // Mirror the leave into the team's channel.jsonl as a SYSTEM record so
      // the chat box renders it inline with chat, dimmed (§17.4 design update).
      // Additive to the audit log above — both paths fire on every departure.
      await appendChannelSystemMessage(teamName, departedId, "left the team").catch(() => {});
      // Post-prune survivors (departed id already removed from teams.json).
      const team = await getTeam(teamName);
      if (!team) continue;
      for (const memberId of team.members) {
        const member = byId.get(memberId);
        if (!member) continue;
        await sendMessage(member, "left the team", { fromAgent: departedId, team: teamName }).catch(() => {});
      }
    }
  } catch {
    // Best-effort — a notice failure must never fail the driving command (§16.5).
  }
}

/**
 * COALESCED leave notice (§16.4.2) for ANY `ib nuke` (single or bulk — they all
 * route through `nukeAgentList`). Groups the accumulated pruned `(team, id)`
 * pairs by team; for each affected team, snapshots its SURVIVING members
 * (post-prune via `getTeam`) and sends exactly ONE `N member(s) left @team`
 * notice to those survivors, stamped as a SYSTEM send (`fromAgent: "@system"`),
 * not any one departed id. This collapses an N-departure storm into one notice
 * per team. A team with no survivors sends nothing (empty-survivor carve-out,
 * §16.5). Best-effort: all failures are swallowed.
 */
async function emitCoalescedLeaveNotice(
  prunedTeams: Array<{ team: string; id: string }>,
  repos: RepoEntry[],
): Promise<void> {
  if (prunedTeams.length === 0) return;
  try {
    // Count departures per team (insertion-ordered so notices are deterministic).
    const departuresByTeam = new Map<string, number>();
    for (const { team: teamName } of prunedTeams) {
      departuresByTeam.set(teamName, (departuresByTeam.get(teamName) ?? 0) + 1);
    }

    const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
    const byId = new Map(agents.map((a) => [a.id, a]));

    for (const [teamName, count] of departuresByTeam) {
      // Audit the coalesced departure in the team's <team>.log (§17.4). Logged
      // for every affected team, BEFORE the empty-survivor carve-out below, so a
      // nuke that empties a team still records the event. Best-effort.
      await appendTeamLog(teamName, `${count} member${count === 1 ? "" : "s"} left (nuke)`).catch(() => {});
      // Mirror the coalesced departure into the channel.jsonl as a SYSTEM
      // record so the chat box renders it dimmed (§17.4). DROP the `@<team>`
      // suffix here — the channel pane already shows which team the user is
      // looking at, so repeating it is redundant; the audit-log line keeps the
      // suffix because that log is consumed cross-team.
      await appendChannelSystemMessage(
        teamName,
        "@system",
        `${count} member${count === 1 ? "" : "s"} left`,
      ).catch(() => {});
      // Post-prune survivors (all this op's departures already removed).
      const team = await getTeam(teamName);
      if (!team || team.members.length === 0) continue; // empty-survivor carve-out
      const body = `${count} member${count === 1 ? "" : "s"} left @${teamName}`;
      for (const memberId of team.members) {
        const member = byId.get(memberId);
        if (!member) continue;
        await sendMessage(member, body, { fromAgent: "@system", team: teamName }).catch(() => {});
      }
    }
  } catch {
    // Best-effort — a notice failure must never fail the driving nuke (§16.5).
  }
}

/**
 * Native kill implementation — replaces `ib kill <id> --force`.
 *
 * Sequence (mirrors do_kill in ib bash):
 * 1. Verify agent exists (directory or tmux session)
 * 2. Remove questions from user-questions.json
 * 3. teardownAgent() — log, capture tmux, kill claude, kill tmux, copy settings,
 *    remove worktree, delete branch, archive, remove dir
 * 4. scanAndKillOrphans()
 */
export async function killAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");
  const tmuxSession = agent.meta.tmux_session;

  // Check if agent exists (directory or tmux session)
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  let sessionExists = false;
  if (tmuxSession) {
    try {
      const proc = killPauseSpawnCtx.runner(
        ["tmux", "has-session", "-t", tmuxSession],
        { stdout: "pipe", stderr: "pipe" }
      );
      await new Response(proc.stderr).text(); // drain
      sessionExists = (await proc.exited) === 0;
    } catch { /* ignore */ }
  }

  if (!dirExists && !sessionExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // Remove questions
  await removeAgentQuestions(agent.repoPath, agent.id);

  // Teardown (log, capture, kill process, kill tmux, worktree, branch, archive,
  // remove). The teardown prunes this agent from every team and returns the
  // pruned (team, id) pairs so we can fan out the leave notice (§16.5).
  const { prunedTeams } = await teardownAgent(agent.repoPath, agent.id, agentDir, {
    tmux_session: tmuxSession,
    claude_pid: agent.meta.claude_pid,
  }, "Agent killed");

  // Scan for orphaned Claude processes
  await scanAndKillOrphans(agentsDir);

  // kill = single-agent departure → per-agent leave notice to surviving
  // teammates, `fromAgent` = the departed id (§16.5). Best-effort.
  await emitPerAgentLeaveNotice(prunedTeams, await listRepos());

  logToWatchLog(
    `[kill] agent=${agent.repoName ? `${agent.repoName}/` : ""}${agent.id} ` +
    `tmux=${tmuxSession || "<none>"} pid=${agent.meta.claude_pid || "<none>"}`
  );

  return { ok: true, exitCode: 0, stdout: `Closed agent: ${agent.id}`, stderr: "" };
}

/** Spawn context for nuke/resume operations */
export const nukeResumeSpawnCtx = new SpawnContext();
/** Override delay for resume tests (null = use real delay) */
let resumeDelayOverrideMs: number | null = null;

/** Override the nuke/resume spawn runner (for testing). Sets delay to 0 by default. */
export function setNukeResumeSpawnRunner(runner: SpawnFn): void {
  nukeResumeSpawnCtx.set(runner);
  resumeDelayOverrideMs = 0;
}

/** Reset the nuke/resume spawn runner */
export function resetNukeResumeSpawnRunner(): void {
  nukeResumeSpawnCtx.reset();
  resumeDelayOverrideMs = null;
}

function resolveGitRevParsePath(worktreePath: string, rawPath: string): string {
  const trimmed = rawPath.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const absPath = trimmed.startsWith("/") ? trimmed : resolve(worktreePath, trimmed);
  try {
    return realpathSync(absPath);
  } catch {
    return absPath;
  }
}

/**
 * Clean up orphaned tmux sessions — sessions with the ittybitty- prefix
 * that don't correspond to any remaining agent directory.
 */
async function cleanupOrphanedTmuxSessions(agentsDir: string): Promise<number> {
  let cleaned = 0;

  // Build list of remaining agent IDs
  const knownIds: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) knownIds.push(e.name);
    }
  } catch { /* agents dir may not exist */ }

  // List tmux sessions
  const listResult = await nukeResumeSpawnCtx.run(["tmux", "list-sessions", "-F", "#{session_name}"]);
  if (listResult.exitCode !== 0 || !listResult.stdout) return 0;

  const sessions = listResult.stdout.split("\n").filter((s) => s.trim());
  for (const session of sessions) {
    if (!session.startsWith("ittybitty-")) continue;

    // Extract agent ID: strip prefix (ittybitty-<repoid>-<agentid>)
    // The session format is: ittybitty-<8hex>-<agentid>
    // We need to match the agent ID portion against known IDs
    const parts = session.split("-");
    // Session: "ittybitty-<repoid>-agent-<hex>" or "ittybitty-<repoid>-<name>"
    // The repo ID is parts[1], agent ID is everything after "ittybitty-<repoid>-"
    if (parts.length < 3) continue;
    const agentId = parts.slice(2).join("-");

    const isKnown = knownIds.includes(agentId);
    if (!isKnown) {
      const killResult = await nukeResumeSpawnCtx.run(["tmux", "kill-session", "-t", session]);
      if (killResult.exitCode === 0) cleaned++;
    }
  }

  return cleaned;
}

/**
 * Shared teardown loop for nukeAgent and nukeAllAgents.
 * Iterates agent IDs, tears each down, then cleans up orphans.
 */
async function nukeAgentList(
  repoPath: string,
  agentsDir: string,
  agentIds: string[],
): Promise<{ killed: number; failed: number; orphansKilled: number }> {
  let killed = 0;
  let failed = 0;

  // Accumulate pruned (team, id) pairs across the WHOLE loop so we can emit ONE
  // coalesced leave notice per affected team afterward — never a per-agent storm
  // (§16.5). Every `ib nuke` (single leaf, manager + descendants, or nuke-all)
  // flows through here, so this is ALWAYS the coalesced path.
  const allPruned: Array<{ team: string; id: string }> = [];

  for (const id of agentIds) {
    const agentDir = join(agentsDir, id);
    // Skip if directory doesn't exist
    try {
      await readdir(agentDir);
    } catch { /* expected: agent dir already removed */
      continue;
    }

    // Remove questions
    await removeAgentQuestions(repoPath, id);

    // Read meta for teardown
    let meta = { tmux_session: "", claude_pid: "" };
    try {
      const metaData = await Bun.file(join(agentDir, "meta.json")).json();
      meta = {
        tmux_session: metaData.tmux_session || "",
        claude_pid: metaData.claude_pid || "",
      };
    } catch { /* ignore */ }

    // Teardown — captures the pruned (team, id) pairs even on the failure path
    // (the prune ran inside archiveAgent regardless of the final dir-removal).
    try {
      const { prunedTeams } = await teardownAgent(repoPath, id, agentDir, meta, "Agent nuked");
      allPruned.push(...prunedTeams);
      killed++;
    } catch { /* teardown error — count as failure */
      failed++;
    }
  }

  // Clean up orphaned tmux sessions
  const orphansKilled = await cleanupOrphanedTmuxSessions(agentsDir);

  // Scan for orphaned Claude processes
  if (killed > 0 || orphansKilled > 0) {
    await scanAndKillOrphans(agentsDir);
  }

  // nuke = coalesced departure → ONE `N member(s) left @team` notice per team,
  // system sender, to surviving teammates only (§16.5). Best-effort.
  await emitCoalescedLeaveNotice(allPruned, await listRepos());

  return { killed, failed, orphansKilled };
}

/**
 * Native nuke implementation — replaces `ib nuke <id> --force`.
 *
 * Sequence (mirrors do_nuke in ib bash):
 * 1. Check if target is a worker with no children → error
 * 2. Get all descendants via getDescendantsRecursive()
 * 3. For each: removeAgentQuestions() then teardownAgent()
 * 4. Clean up orphaned tmux sessions
 * 5. scanAndKillOrphans()
 */
export async function nukeAgent(agent: Agent): Promise<IbCommandResult> {
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");

  // Get all descendants (includes the agent itself)
  const descendants = await getDescendantsRecursive(agentsDir, agent.id);

  // Check if this is a worker with no children — reject
  if (agent.meta.worker && descendants.length <= 1) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Error: '${agent.id}' is a worker agent with no descendants. Use 'ib kill ${agent.id}' instead.`,
    };
  }

  const { killed, failed, orphansKilled } = await nukeAgentList(agent.repoPath, agentsDir, descendants);

  if (failed > 0 && killed === 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `All ${failed} agent(s) failed to kill` };
  }

  let stdout = `Nuked ${killed} agent(s)`;
  if (orphansKilled > 0) stdout += `, cleaned ${orphansKilled} orphaned session(s)`;
  if (failed > 0) stdout += ` (${failed} failed)`;

  logToWatchLog(
    `[nuke] root=${agent.repoName ? `${agent.repoName}/` : ""}${agent.id} ` +
    `killed=${killed} failed=${failed} orphans=${orphansKilled}`
  );

  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Native nuke-all implementation — replaces `ib nuke --force`.
 *
 * Kills ALL agents in the agents directory.
 */
export async function nukeAllAgents(repoPath: string): Promise<IbCommandResult> {
  const agentsDir = join(repoPath, ".ittybitty", "agents");

  // Collect all agents with meta.json
  const agentsToKill: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaExists = await Bun.file(join(agentsDir, e.name, "meta.json")).exists().catch(() => false);
      if (metaExists) agentsToKill.push(e.name);
    }
  } catch { /* agents dir may not exist */ }

  const { killed, failed, orphansKilled } = await nukeAgentList(repoPath, agentsDir, agentsToKill);

  if (failed > 0 && killed === 0 && agentsToKill.length > 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `All ${failed} agent(s) failed to kill` };
  }

  let stdout = `Nuked ${killed} agent(s)`;
  if (orphansKilled > 0) stdout += `, cleaned ${orphansKilled} orphaned session(s)`;
  if (failed > 0) stdout += ` (${failed} failed)`;

  logToWatchLog(
    `[nuke-all] repo=${repoPath} killed=${killed} failed=${failed} orphans=${orphansKilled}`
  );

  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Reset (kill + respawn) a per-repo coordinator.
 *
 * Tears down the existing coordinator and immediately spawns a fresh one.
 * The new coordinator's settings.local.json is rebuilt from current sources
 * (hardcoded constants + _all.md + coordinator.md), so any edits to those
 * files are picked up. Hooks block is rebuilt fresh too. Agent ID stays the
 * same (it's keyed to the repo basename).
 *
 * Caller must have already verified `agent.meta.agentType === "coordinator"`.
 */
async function resetCoordinator(agent: Agent): Promise<IbCommandResult> {
  // Tear down the existing coordinator: kill tmux session, claude process,
  // watchdog, and remove the agent dir. nukeAgent recurses through descendants,
  // so any workers the coordinator has spawned will be torn down too — that is
  // intentional. A coordinator reset abandons its in-flight work; the new
  // coordinator starts with a clean slate and no inherited child agents.
  const nukeResult = await nukeAgent(agent);
  if (!nukeResult.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Reset failed during teardown: ${nukeResult.stderr || nukeResult.stdout}` };
  }

  // Spawn a fresh coordinator. newAgent's coordinator path generates the
  // agent ID from the repo basename, so it lands at the same ID we just
  // tore down.
  const spawnResult = await newAgent(
    agent.repoPath,
    "You are the per-repo coordinator. Await instructions.",
    { type: "coordinator" },
  );
  if (!spawnResult.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Reset failed during respawn: ${spawnResult.stderr || spawnResult.stdout}` };
  }

  return { ok: true, exitCode: 0, stdout: `Reset coordinator ${agent.id}`, stderr: "" };
}

/**
 * Native resume implementation — replaces `ib resume <id>`.
 *
 * Resume eligibility is determined by tmux liveness, NOT by `meta.state`.
 * Pre-Phase-42 paused agents may have a stale state like "complete" that
 * the old pause path never overwrote; trusting `meta.state` would refuse to
 * resume those stuck agents forever. Checking tmux directly lets them
 * self-heal: if no live tmux session exists, resume proceeds.
 *
 * Refusal cases:
 * - tmux session is alive — resuming would clobber a running agent.
 * - agent is in the 6s creating-grace-period with no tmux yet — don't race
 *   with the spawn pipeline.
 *
 * Sequence (mirrors cmd_resume in ib bash):
 * 1. Read session_id, model from meta.json
 * 2. Check yolo mode from start.sh
 * 3. Create resume.sh script
 * 4. Determine work dir
 * 5. Start tmux session
 * 6. Auto-accept workspace trust if not yolo
 * 7. Send resume nudge
 * 8. Log result
 * 9. Auto-spawn per-agent watchdog
 */
export async function resumeAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);

  // Check agent directory exists
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // Ensure the central per-agent outbox dir exists before the agent starts so
  // the first enqueue doesn't race a missing-dir append. Idempotent — no-op
  // when the dir already exists.
  await mkdir(agentOutboxDir(agent.id), { recursive: true });

  // Acquire the long-running-op guard at the VERY TOP — above the coordinator
  // early-return below — so coordinator resets are guarded against a double-R
  // too. Op kind `restarting` covers both the resume and coordinator-reset
  // paths. Refusal `stderr` is surfaced verbatim by the dashboard handler.
  const acquired = await acquireAgentOperation(agentDir, "restarting");
  if (!acquired.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: acquired.stderr };
  }

  try {
    // Per-repo coordinators: R triggers a full reset rather than a session resume.
    // The coordinator's settings.local.json is assembled from three sources at
    // spawn time (hardcoded constants, _all.md, coordinator.md), and its hooks
    // template is rebuilt then. Resuming the existing session would reuse stale
    // permissions and hooks, so we tear the coordinator down and respawn it
    // — fresher, simpler, and matches the user's mental model of "R to reset".
    if (agent.meta.agentType === "coordinator") {
      return await resetCoordinator(agent);
    }

    // Parse the qualified `<cli>:<model>` form (D1) EARLY so we can reject
    // codex resume before issuing any tmux / shell-script work (MED 1 from
    // the Phase 4 review). parseModel throws on missing/malformed/unknown
    // cli — surface as a resume failure (D6).
    const rawModel = agent.meta.model && agent.meta.model !== "null" ? agent.meta.model : "";
    if (rawModel && !isValidModel(rawModel)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid model name: ${rawModel}` };
    }
    let modelFlagValue = "";
    let resumeCli: ReturnType<typeof parseModel>["cli"] = "claude";
    if (rawModel) {
      try {
        const parsedResume = parseModel(rawModel);
        modelFlagValue = parsedResume.model;
        resumeCli = parsedResume.cli;
      } catch (err) {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Resume is allowed when no live tmux session exists for the agent. We don't
    // trust meta.state here because legacy paused agents (pre-Phase 42) may have a
    // stale state like "complete" or "waiting" that pause never overwrote. Checking
    // tmux directly lets those stuck agents self-heal.
    //
    // Two refusal cases:
    // 1. tmux session is alive — agent is running, resuming would clobber it.
    // 2. agent is in the 6s creating-grace-period and hasn't started tmux yet —
    //    don't race with the spawn pipeline.
    const tmuxSessionForGuard = agent.meta.tmux_session;
    if (tmuxSessionForGuard) {
      if (!isValidTmuxSession(tmuxSessionForGuard)) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid tmux session name: ${tmuxSessionForGuard}` };
      }
      const hasSession = await nukeResumeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSessionForGuard]);
      if (hasSession.exitCode === 0) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has a live tmux session ('${tmuxSessionForGuard}') — refuse to resume a running agent` };
      }
    } else if (isRecentlyCreated(agent.meta.created_epoch)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is still being created — wait for spawn to complete before resuming` };
    }

    // Tmux session was validated at the top of resumeAgent (liveness guard).
    const tmuxSession = agent.meta.tmux_session;

    // Validate paths for shell script interpolation
    if (!isValidShellPath(agentDir)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent directory path contains characters unsafe for shell scripts: ${agentDir}` };
    }

    // Determine work dir
    const repoDir = join(agentDir, "repo");
    let workPath = repoDir;
    try {
      await readdir(repoDir);
    } catch {
      workPath = agent.repoPath;
    }

    // Build exit script path
    const absExitScript = join(agentDir, "exit-check.sh");
    const resumeScript = join(agentDir, "resume.sh");

    let yoloMode = false;
    if (resumeCli === "codex") {
      // ── Codex resume branch (SPEC §5.8 + §6 Phase 7) ─────────────────────────
      // Read codex's rollout/session id (NOT the claude session_id UUID).
      // Captured by SessionStart/PreToolUse hooks on first launch.
      const codexSessionId = agent.meta.codex_session_id;
      if (!codexSessionId || codexSessionId === "null" || codexSessionId.trim() === "") {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `Cannot resume codex agent '${agent.id}': codex_session_id not yet captured (SessionStart hook never fired). Try nuking + respawning instead.`,
        };
      }
      if (!isValidSessionId(codexSessionId)) {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `Invalid codex_session_id for agent '${agent.id}': ${codexSessionId}`,
        };
      }

      // Resolve the absolute `ib` binary path (codex hook dispatch needs it).
      // Same path-safety check that gates the spawn-side codex launch.
      const { resolveIbBinaryPath } = await import("./codex-spawn");
      const { isCodexSafeBinaryPath } = await import("./codex-config");
      const codexIbBinaryPath = resolveIbBinaryPath();
      if (!codexIbBinaryPath) {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Error: codex resume requires an absolute path to the `ib` binary, but `ib` is not on PATH. Install ib and ensure it is reachable via PATH before resuming a codex agent.",
        };
      }
      if (!isCodexSafeBinaryPath(codexIbBinaryPath)) {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `Error: Unsafe ib binary path for codex resume: ${JSON.stringify(codexIbBinaryPath)} contains quotes, backslashes, or control characters. Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
        };
      }

      // Resume-time dispatcher precheck (SPEC §5.5 fail-open mitigation).
      // Same guard as the Phase 4 spawn-time precheck: if our hook dispatcher
      // is missing/broken (e.g. `ib` was rebuilt between spawn and resume),
      // every PreToolUse call would silently fail-open and the codex agent
      // would lose its path-isolation + permission gate. Re-running the dry-run
      // on resume catches that case before we hand off to tmux.
      //
      // On precheck failure: refuse the resume cleanly. Do NOT touch the
      // worktree — it is the user's existing agent state, not ours to nuke.
      const codexPrecheckEvents = ["codex-pre-tool-use", "codex-session-start", "codex-stop"];
      for (const event of codexPrecheckEvents) {
        // Route through codexDryRunSpawnCtx with cwd=workPath so the dry-run
        // subprocess's process.cwd() lands inside the agent's worktree —
        // identical reason to the newAgent path above (resolveAgentDir's
        // cwd regex must match `/\.ittybitty\/agents/`).
        const result = await codexDryRunSpawnCtx.run(
          [codexIbBinaryPath, "hooks", event, agent.id, "--dry-run"],
          workPath,
        );
        if (result.exitCode !== 0) {
          const errMsg = result.stderr.trim() || `dispatcher precheck failed with exit code ${result.exitCode}`;
          await logAgent(agentDir, `[resume] codex dispatcher precheck failed for ${event}: ${errMsg}`);
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: `Error: codex dispatcher precheck failed (${event}): ${errMsg}`,
          };
        }
      }

      const gitCommonDirResult = await nukeResumeSpawnCtx.run([
        "git", "-C", workPath, "rev-parse", "--git-common-dir",
      ]);
      if (gitCommonDirResult.exitCode !== 0 || !gitCommonDirResult.stdout.trim()) {
        const errMsg = gitCommonDirResult.stderr.trim() || `git rev-parse --git-common-dir failed with exit code ${gitCommonDirResult.exitCode}`;
        await logAgent(agentDir, `[resume] could not resolve git common dir for codex writable root: ${errMsg}`);
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `Error: could not resolve git common dir for codex writable root: ${errMsg}`,
        };
      }
      const codexExtraWritableRoots = [
        resolveGitRevParsePath(workPath, gitCommonDirResult.stdout),
      ];

      // Build resume.sh via the shared codex builder (mirrors start.sh).
      const { buildCodexResumeContent } = await import("./codex-spawn");
      const codexResumeContent = buildCodexResumeContent({
        agentId: agent.id,
        ibBinaryPath: codexIbBinaryPath,
        agentDir,
        codexSessionId,
        absMetaJson: join(agentDir, "meta.json"),
        absExitScript,
        absAgentLog: join(agentDir, "agent.log"),
        absStderrLog: join(agentDir, "claude.stderr.log"),
        extraWritableRoots: codexExtraWritableRoots,
      });
      await Bun.write(resumeScript, codexResumeContent);
      await chmod(resumeScript, 0o755);
    } else {
      // ── Claude resume branch (unchanged) ─────────────────────────────────────
      // Read session_id from meta.json
      const sessionId = agent.meta.session_id;
      if (!sessionId || sessionId === "null") {
        return { ok: false, exitCode: 1, stdout: "", stderr: "No session_id found in meta.json" };
      }

      // Validate session_id before shell interpolation
      if (!isValidSessionId(sessionId)) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid session ID: ${sessionId}` };
      }

      // Detect yolo mode from start.sh
      try {
        const startSh = await Bun.file(join(agentDir, "start.sh")).text();
        if (startSh.includes("dangerously-skip-permissions")) {
          yoloMode = true;
        }
      } catch { /* start.sh may not exist */ }

      // Build claude args
      let claudeArgs = "";
      if (yoloMode) {
        claudeArgs = "--dangerously-skip-permissions --permission-mode bypassPermissions";
      }
      if (modelFlagValue) {
        claudeArgs = claudeArgs ? `${claudeArgs} --model ${modelFlagValue}` : `--model ${modelFlagValue}`;
      }

      // Note: per-repo coordinators never reach this point — the early branch at
      // the top of resumeAgent routes them to resetCoordinator instead. So no
      // need to re-thread --settings to the (no-longer-relevant) saved coordinator
      // settings file here.

      // Shell-quote all paths for safe interpolation
      const qAbsExitScript = shellQuote(absExitScript);

      // Write resume.sh
      const qMetaJson = shellQuote(join(agentDir, "meta.json"));
      const qAgentLog = shellQuote(join(agentDir, "agent.log"));
      const qResumeStderrLog = shellQuote(join(agentDir, "claude.stderr.log"));
      const resumeContent = `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qAgentLog}
STDERR_LOG=${qResumeStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resume.sh] $1" >> "$AGENT_LOG"; }

log "Starting claude --resume ${sessionId} ${claudeArgs}"
log "PWD=$(pwd) which_claude=$(which claude 2>&1)"

# Ignore SIGHUP for the lifetime of this script. When resume is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash-resume loop. SIG_IGN is inherited by the
# claude child, so this protects both halves. setsid (below) is the belt to this
# suspenders — it gives claude its own session so the pty SIGHUP can't reach it
# at all, but the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (resume insulated from launcher pane teardown)"

# Start Claude in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
# Launch under setsid when present so claude leads its own session, fully
# detached from the launcher's controlling terminal. setsid execs in place
# (no fork) when it is not already a process-group leader — which holds here:
# this script runs non-interactively with job control off (no \`set -m\`), so the
# backgrounded setsid stays in the script's process group rather than leading
# its own. So \$! still refers to claude and wait/kill behave identically to the
# bare launch. Fall back to a plain background launch on hosts lacking setsid
# (e.g. macOS, where setsid is absent — the inherited SIG_IGN above covers it).
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid claude --resume "${sessionId}" ${claudeArgs} 2> "$STDERR_LOG" &
else
    claude --resume "${sessionId}" ${claudeArgs} 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "Claude PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to Claude PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Claude PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock (HIGH 2 from the Phase 4 review).
META_JSON=${qMetaJson}
if [[ -f "$META_JSON" ]]; then
    ib write-pid ${shellQuote(agent.id)} "$CLAUDE_PID" || log "write-pid failed (exit=$?); meta.json claude_pid not set"
fi

# Wait for Claude to complete
wait $CLAUDE_PID
EXIT_CODE=$?
SIGNAL=$(kill -l $EXIT_CODE 2>/dev/null || echo "none")
log "Claude exited: code=$EXIT_CODE signal=$SIGNAL"

# Annotate common exit codes so the cause is obvious in agent.log.
case $EXIT_CODE in
    0)   log "exit=0 → clean exit" ;;
    1)   log "exit=1 → generic claude error (check stderr tail below)" ;;
    2)   log "exit=2 → claude usage / argument error" ;;
    127) log "exit=127 → command not found ('claude' missing from PATH?)" ;;
    129) log "exit=129 → SIGHUP (tmux pane closed or controlling terminal lost)" ;;
    130) log "exit=130 → SIGINT (Ctrl-C)" ;;
    137) log "exit=137 → SIGKILL (likely OOM kill or 'kill -9'; check Console.app for 'low memory')" ;;
    139) log "exit=139 → SIGSEGV (claude segfault)" ;;
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib kill / pause)" ;;
    *)   log "exit=$EXIT_CODE → unrecognized; SIGNAL=$SIGNAL" ;;
esac

# If Claude exited non-cleanly and wrote anything to stderr, dump the tail into
# agent.log so the post-mortem doesn't depend on the (now-dying) tmux pane.
if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]; then
    log "── claude stderr (last 50 lines) ──"
    tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"
    log "── end claude stderr ──"
fi

# Run exit check
${qAbsExitScript}
`;
      await Bun.write(resumeScript, resumeContent);
      await chmod(resumeScript, 0o755);
    }

    // Ensure tmux server is running
    const startServerResult = await nukeResumeSpawnCtx.run(["tmux", "start-server"]);
    if (startServerResult.exitCode !== 0) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "Could not start tmux server" };
    }

    await logAgent(agentDir, `[resume] Creating tmux session '${tmuxSession}' in ${workPath}`);

    // Start tmux session — use saved layout width so it matches the dashboard pane.
    // Per-repo coordinators are routed to resetCoordinator earlier (see line 382),
    // so only non-coordinator agents reach here — pass false for clarity. Route
    // through getTmuxWidthForAgent so all agent-tmux sizing flows through one helper.
    const resumeTmuxWidth = await getTmuxWidthForAgent(false);
    const tmuxResult = await nukeResumeSpawnCtx.run([
      "tmux", "new-session", "-d", "-x", String(resumeTmuxWidth), "-s", tmuxSession, "-c", workPath, shellQuote(resumeScript),
    ]);
    if (tmuxResult.exitCode !== 0) {
      await logAgent(agentDir, `[resume] tmux new-session failed: exit=${tmuxResult.exitCode} stderr=${tmuxResult.stderr}`);
      return { ok: false, exitCode: 1, stdout: "", stderr: `Could not create tmux session '${tmuxSession}'` };
    }
    await nukeResumeSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "history-limit", "50000"]);
    await nukeResumeSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "remain-on-exit", "on"]);
    // window-size manual prevents tmux from auto-resizing the window to the
    // latest attached client's terminal size. The dashboard sizes the session
    // to the saved pane width; the default ("latest") would silently shrink
    // it back when other clients attach/detach.
    await nukeResumeSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "window-size", "manual"]);
    // pane-died hook fires on every pane termination (graceful or otherwise)
    // as a backstop for the case where resume.sh itself dies before reaching
    // its exit-log line. See the new-agent path for the matching comment.
    const resumePaneDiedHook = `run-shell "echo '[tmux pane-died] session=#{session_name} pane_dead_status=#{pane_dead_status} pane_dead_signal=#{pane_dead_signal}' >> ${shellQuote(join(agentDir, "agent.log"))}"`;
    await nukeResumeSpawnCtx.run(["tmux", "set-hook", "-t", tmuxSession, "pane-died", resumePaneDiedHook]);

    await logAgent(agentDir, "[resume] tmux session created, running autoAcceptWorkspaceTrust");

    // Auto-accept workspace trust if not yolo (poll tmux for trust prompts)
    // Must complete before sending nudge to avoid corrupting the permissions flow
    if (!yoloMode) {
      await autoAcceptWorkspaceTrust(tmuxSession);
    }

    await logAgent(agentDir, "[resume] autoAcceptWorkspaceTrust completed, sending nudge");

    // Verify tmux session still exists before sending nudge
    const verifyResult = await nukeResumeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
    if (verifyResult.exitCode !== 0) {
      await logAgent(agentDir, "[resume] tmux session gone before nudge — Claude likely exited immediately");
      return { ok: true, exitCode: 0, stdout: `Use 'ib look ${agent.id}' to view output`, stderr: "" };
    }

    // Send resume nudge after short delay
    const nudgeDelayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 100;
    if (nudgeDelayMs > 0) await Bun.sleep(nudgeDelayMs);

    const nudgePrompt = "Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line.";
    // `--` stops tmux flag parsing so a payload that begins with `-` (e.g. YAML
    // frontmatter `---`) isn't mistaken for an option.
    await nukeResumeSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "-l", "--", nudgePrompt]);

    const nudgeSleepMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 100;
    if (nudgeSleepMs > 0) await Bun.sleep(nudgeSleepMs);

    await nukeResumeSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

    // Log
    await logAgent(agentDir, "[resume] Agent resumed, nudge sent");

    // Write state: "running" to meta.json
    await writeAgentState(agentDir, "running");

    // Note: a freshly-resumed agent whose prior transcript already exceeds
    // `autoCompactThreshold` won't receive `/compact` on the per-agent watchdog's
    // first tick because `createTracker()` initializes `lastCompactCheckMs` to
    // `nowFn()`, giving every new tracker a `COMPACT_CHECK_COOLDOWN_MS` grace
    // period before the first eligibility check.

    // Auto-spawn per-agent watchdog
    try {
      const watchdogLog = join(agentDir, "watchdog.log");
      let watchdogPid: number | undefined;

      if (watchdogSpawnOverride) {
        const result = watchdogSpawnOverride(agent.id, agent.repoPath, watchdogLog);
        watchdogPid = result?.pid;
      } else {
        const watchdogProc = Bun.spawn(["ib", "watchdog", agent.id], {
          cwd: agent.repoPath,
          stdout: Bun.file(watchdogLog),
          stderr: Bun.file(watchdogLog),
        });
        watchdogProc.unref();
        watchdogPid = watchdogProc.pid;
      }

      if (watchdogPid !== undefined) {
        const metaPath = join(agentDir, "meta.json");
        const metaContent = await Bun.file(metaPath).json().catch(() => null);
        if (metaContent) {
          metaContent.watchdog_pid = watchdogPid;
          await Bun.write(metaPath, JSON.stringify(metaContent, null, 2));
        }
      }
    } catch { /* ignore */ }

    return { ok: true, exitCode: 0, stdout: `Use 'ib look ${agent.id}' to view output`, stderr: "" };
  } finally {
    // Clear the op marker on every return path (the body above has many early
    // returns). On most paths the dir exists and the marker — if it's still
    // ours — is cleared. Safe regardless of the dir's fate: clearAgentOperation
    // is ENOENT-safe (updateAgentTransient's best-effort try/catch no-ops on a
    // missing dir) AND compare-and-swap (it only nulls a marker whose pid is
    // ours). So the coordinator path — where resetCoordinator removes the dir
    // and the success path respawns it — clears safely whether the dir was
    // removed, recreated, or its marker was age-reclaimed by another op.
    await clearAgentOperation(agentDir);
  }
}

/** Override the respawn detach runner (for testing) */
let respawnDetachOverride: ((agent: Agent) => Promise<void>) | null = null;

/** Override for testing — sets a synchronous in-process executor instead of detaching */
export function setRespawnDetachRunner(fn: (agent: Agent) => Promise<void>): void {
  respawnDetachOverride = fn;
}

/** Reset the respawn detach runner */
export function resetRespawnDetachRunner(): void {
  respawnDetachOverride = null;
}

/**
 * Native respawn implementation — used by the `/respawn` and `/restart`
 * slash commands.
 *
 * The agent runs `ib respawn` from inside its own Claude session. We CAN'T
 * do the kill-and-restart inline because killing this agent's tmux session
 * would kill the very process executing the command. Instead we launch a
 * detached worker — a fresh, untracked tmux session that runs
 * `ib respawn-self <id>`. That worker survives the agent's session being
 * torn down, performs the kill-and-restart, then exits.
 *
 * For coordinators: the worker calls the existing reset path (full nuke +
 * `newAgent` with `type: "coordinator"`). The new coordinator's
 * `settings.local.json` is rebuilt from current sources (hardcoded constants
 * + `_all.md` + `coordinator.md`), so edits to those files take effect.
 *
 * For non-coordinator agents: the worker calls `pauseAgent` (which kills
 * the existing claude process and tmux session) then `resumeAgent` (which
 * starts a fresh `claude --resume <session-id>` in the same worktree).
 * SessionStart fires on the resumed session and re-reads the current
 * agent-type `.md` body, so edits to `worker.md`, `manager.md`, etc. take
 * effect.
 *
 * For `@system` (system coordinator): the worker calls
 * `restartSystemCoordinator()`. This is rare — the system coordinator can
 * already be restarted from the dashboard `R` key — but supporting it from
 * the slash command keeps the UX uniform.
 */
export async function respawnAgent(agent: Agent): Promise<IbCommandResult> {
  // Confirm the agent's directory still exists; respawning a stale ID is a
  // common mistake and returning a clear error beats a hanging detached
  // worker.
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  await logAgent(agentDir, "[respawn] scheduling detached restart");

  // Test override path: tests want to drive respawnSelf synchronously to
  // observe the kill-and-restart steps without spawning a real subprocess.
  if (respawnDetachOverride) {
    await respawnDetachOverride(agent);
    return { ok: true, exitCode: 0, stdout: `Respawn scheduled for ${agent.id}`, stderr: "" };
  }

  // Validate the agent ID before interpolating it into a shell command.
  // `isValidAgentId` accepts alphanumeric + hyphens + underscores, which is
  // a subset of safe shell tokens — no quoting needed below.
  if (!isValidAgentId(agent.id)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid agent ID: ${agent.id}` };
  }

  // Spawn a detached worker by asking tmux to start a fresh, untracked
  // session. The worker runs `ib respawn-self <id>` and inherits no file
  // descriptors from the agent's tmux pane, so when the agent's session is
  // killed the worker is untouched. A short sleep before the actual work
  // gives this Claude turn time to finish rendering its tool result so the
  // user sees the "scheduled" message before the pane disappears.
  //
  // We name the detached session deterministically (`ib-respawn-<id>`) so a
  // stuck worker is easy to find. `-d` keeps it backgrounded; the worker
  // exits when the shell command completes.
  const detachSession = `ib-respawn-${agent.id}`;
  const command = `sleep 1; ib respawn-self ${agent.id}`;
  const result = await nukeResumeSpawnCtx.run([
    "tmux", "new-session", "-d", "-s", detachSession, command,
  ]);
  if (result.exitCode !== 0) {
    await logAgent(agentDir, `[respawn] failed to launch detached worker: ${result.stderr.trim()}`);
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to schedule respawn: ${result.stderr.trim() || "tmux new-session failed"}` };
  }

  // remain-on-exit off so the detached session disappears the moment the
  // worker exits — no zombie session cluttering `tmux ls`.
  await nukeResumeSpawnCtx.run([
    "tmux", "set-option", "-t", detachSession, "remain-on-exit", "off",
  ]);

  return {
    ok: true,
    exitCode: 0,
    stdout: `Respawn scheduled for ${agent.id} — this session will exit shortly`,
    stderr: "",
  };
}

/**
 * The "worker half" of respawn — runs in a detached tmux session spawned
 * by `respawnAgent`. Performs the actual kill-and-restart so it survives
 * its own target's tmux session being torn down.
 *
 * For coordinators, delegates to `resetCoordinator`. For non-coordinator
 * agents, pauses then resumes — `resumeAgent` re-execs `claude --resume`
 * which re-fires the SessionStart hook so the latest agent-type `.md`
 * content is injected into the new conversation.
 */
export async function respawnSelf(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);

  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  await logAgent(agentDir, "[respawn-self] starting kill-and-restart");

  // Per-repo coordinator: full reset. resetCoordinator() handles teardown
  // and respawn via newAgent, which rebuilds settings.local.json from
  // current `_all.md` + `coordinator.md` sources.
  if (agent.meta.agentType === "coordinator") {
    const result = await resetCoordinator(agent);
    await logAgent(agentDir, `[respawn-self] coordinator reset complete: ${result.ok ? "ok" : "failed: " + result.stderr}`);
    if (result.ok) {
      // Telegram ack so a user who triggered /respawn from their phone sees
      // confirmation. Writes to the outbox; the dispatcher running in
      // `ib watch` picks it up and forwards. No-op if Telegram isn't
      // configured. We await it so the file write completes before the
      // detached `respawn-self` worker exits — telegramSend caps at ~1s.
      //
      // The ack lives here (in respawnSelf, the detached `/respawn` worker)
      // rather than in resetCoordinator so the dashboard `R` key — which
      // calls resetCoordinator directly via resumeAgent — does NOT trigger
      // a Telegram ping. A user pressing R is already looking at the
      // dashboard and doesn't need the notification.
      try {
        await telegramSend("Coordinator has been respawned with a clean session.");
      } catch (err) {
        await logAgent(agentDir, `[respawn-self] telegram ack failed: ${err}`);
      }
    }
    return result;
  }

  // Non-coordinator agent: pause (kills tmux + claude) then resume (starts
  // fresh claude --resume in the same worktree, re-firing SessionStart).
  //
  // pauseAgent rejects already-stopped agents. That's fine — if a previous
  // respawn attempt failed mid-flight and left the agent stopped, we fall
  // through to resumeAgent directly.
  if (agent.state !== "stopped") {
    const pauseResult = await pauseAgent(agent);
    if (!pauseResult.ok) {
      await logAgent(agentDir, `[respawn-self] pause failed: ${pauseResult.stderr}`);
      return { ok: false, exitCode: 1, stdout: "", stderr: `Respawn pause failed: ${pauseResult.stderr}` };
    }
  } else {
    await logAgent(agentDir, "[respawn-self] agent already stopped, skipping pause");
  }

  const resumeResult = await resumeAgent(agent);
  if (!resumeResult.ok) {
    await logAgent(agentDir, `[respawn-self] resume failed: ${resumeResult.stderr}`);
    return { ok: false, exitCode: 1, stdout: "", stderr: `Respawn resume failed: ${resumeResult.stderr}` };
  }

  await logAgent(agentDir, "[respawn-self] respawn complete");
  return { ok: true, exitCode: 0, stdout: `Respawned ${agent.id}`, stderr: "" };
}

/**
 * Auto-accept workspace trust dialog by polling tmux output.
 * Mirrors auto_accept_workspace_trust in ib bash.
 * Runs asynchronously — does not block the caller.
 */
async function autoAcceptWorkspaceTrust(tmuxSession: string): Promise<void> {
  const maxAttempts = 5;
  const maxWaitHalfSecs = 30; // 15 seconds total for initial wait

  // Wait for Claude to start (logo or permissions screen)
  let startedWith = "";
  for (let i = 0; i < maxWaitHalfSecs; i++) {
    const delayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 500;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await nukeResumeSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const output = captureResult.stdout;
    // Check for logo or [USER TASK]
    if (output.includes("Claude Code v") || output.includes("[USER TASK]")) {
      startedWith = "logo";
      break;
    }
    // Check for permissions screens (workspace trust, external imports, MCP servers)
    if (/enter to confirm/i.test(output)) {
      if (
        /trust/i.test(output) ||
        /Allow external CLAUDE\.md file imports/i.test(output) ||
        /New MCP server found/i.test(output) ||
        /\d+ new MCP servers? found/i.test(output)
      ) {
        startedWith = "permissions";
        break;
      }
    }
  }

  // If logo appeared directly, no permissions needed
  if (startedWith !== "permissions") return;

  // Accept permissions (may need multiple Enter presses)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await nukeResumeSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

    const delayMs = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 4000;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await nukeResumeSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const recent = captureResult.stdout;

    // Check if permissions prompt is still active
    let hasPermissions = false;
    if (/enter to confirm/i.test(recent)) {
      if (
        /trust/i.test(recent) ||
        /Allow external CLAUDE\.md file imports/i.test(recent) ||
        /New MCP server found/i.test(recent) ||
        /\d+ new MCP servers? found/i.test(recent)
      ) {
        hasPermissions = true;
      }
    }

    if (!hasPermissions) {
      // Wait for logo to confirm success
      for (let j = 0; j < maxWaitHalfSecs; j++) {
        const logoDelay = resumeDelayOverrideMs !== null ? resumeDelayOverrideMs : 500;
        if (logoDelay > 0) await Bun.sleep(logoDelay);

        const logoCapture = await nukeResumeSpawnCtx.run([
          "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
        ]);
        if (logoCapture.exitCode !== 0) continue;
        if (logoCapture.stdout.includes("Claude Code v") || logoCapture.stdout.includes("[USER TASK]")) {
          return; // Success
        }
      }
    }
  }
}

/**
 * Native reassign implementation — replaces `ib reassign <id> <new-manager>`.
 *
 * 1. Read agent's meta.json to get old manager
 * 2. If newManager is null: clear manager field
 * 3. If newManager provided: validate exists, not worker, not circular
 * 4. Update agent's meta.json
 * 5. Log the change
 * 6. Send notifications (skip if tmux session doesn't exist)
 */
export async function reassignAgent(agent: Agent, newManager: string | null): Promise<IbCommandResult> {
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");
  const agentDir = join(agentsDir, agent.id);
  const metaPath = join(agentDir, "meta.json");

  // Self-reassign check (before reading meta — just compare IDs)
  if (newManager === agent.id) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Cannot reassign agent to itself" };
  }

  // Read agent's meta.json
  let meta: Record<string, unknown>;
  try {
    const file = Bun.file(metaPath);
    if (!(await file.exists())) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
    }
    meta = await file.json();
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read meta.json for '${agent.id}'` };
  }

  const oldManager = (meta.manager as string | null) ?? "";

  // Same-parent check: no-op if already has the requested parent
  const oldManagerNorm = oldManager || null;
  const newManagerNorm = newManager || null;
  if (oldManagerNorm === newManagerNorm) {
    if (newManager) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "Agent already has this manager" };
    }
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent is already top-level" };
  }

  if (newManager !== null) {
    // Validate new parent exists
    const newManagerMetaPath = join(agentsDir, newManager, "meta.json");
    try {
      const file = Bun.file(newManagerMetaPath);
      if (!(await file.exists())) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `New manager '${newManager}' not found` };
      }
      const parentMeta = await file.json();
      // Validate not a worker
      if (parentMeta.worker) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Cannot reassign to worker agent '${newManager}'` };
      }
    } catch {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read meta.json for '${newManager}'` };
    }

    // Check circular: newManager must not be a descendant of agent
    const descendants = await getDescendantsRecursive(agentsDir, agent.id);
    if (descendants.includes(newManager)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Circular dependency: '${newManager}' is a descendant of '${agent.id}'` };
    }
  }

  // Update meta.json
  meta.manager = newManager ?? null;
  try {
    await Bun.write(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch (err) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to write meta.json: ${err}` };
  }

  // Log change
  const newLabel = newManager ?? "(none)";
  const oldLabel = oldManager || "(none)";
  await logAgent(agentDir, `Reassigned from ${oldLabel} to ${newLabel}`);

  // Send notifications (skip if tmux session doesn't exist)
  const notifyAgent = async (targetId: string, msg: string) => {
    const targetMetaPath = join(agentsDir, targetId, "meta.json");
    try {
      const file = Bun.file(targetMetaPath);
      if (!(await file.exists())) return;
      const targetMeta = await file.json();
      if (!targetMeta.tmux_session) return;
      // Use sendMessage for notification — construct a minimal Agent-like object
      const targetAgent: Agent = {
        id: targetId,
        repoPath: agent.repoPath,
        repoName: agent.repoName,
        meta: targetMeta as Agent["meta"],
        state: "running",
        age: "",
        archived: false,
        children: [],
      };
      await sendMessage(targetAgent, msg, { fromAgent: agent.id });
    } catch { /* skip notification errors */ }
  };

  // Notify old parent
  if (oldManager) {
    const toLabel = newManager ? `to manager '${newManager}'` : "to top-level";
    await notifyAgent(oldManager, `[watchdog for ${agent.id}]: Agent reassigned ${toLabel}`);
  }
  // Notify new parent
  if (newManager) {
    const fromLabel = oldManager ? `was under ${oldManager}` : "was top-level";
    await notifyAgent(newManager, `[watchdog for ${agent.id}]: Agent reassigned to you (${fromLabel})`);
  }
  // Notify the agent itself
  await notifyAgent(agent.id, `[watchdog]: You've been reassigned from ${oldLabel} to ${newLabel}`);

  return {
    ok: true,
    exitCode: 0,
    stdout: `Reassigned ${agent.id} from ${oldLabel} to ${newLabel}`,
    stderr: "",
  };
}

/**
 * Set or clear an agent's friendly NICKNAME — backs `ib nickname <id> [name]`.
 *
 * A nickname is a pure input alias: the agent's immutable `id` is unchanged, no
 * directories/branches/tmux sessions move, Claude state is untouched, and no
 * references break. So this is a small, mostly-validation command — no pause,
 * no git, no file moves, NO notifications.
 *
 * `nickname === null` CLEARS (deletes the field — never writes ""). A non-null
 * value SETS it (validating + collision-checking first).
 *
 * Collision checks are GLOBAL (readAllAgents over every registered repo)
 * because resolution spans all repos. A nickname must not equal:
 *   - any existing agent's `id` (global) — ids aren't globally unique,
 *   - any OTHER agent's `nickname` (global, incl. cross-repo),
 *   - this agent's own `id` (a no-op alias; use --clear to remove instead).
 * Re-setting THIS agent's own existing nickname to a new value is allowed.
 */
export async function renameAgent(agent: Agent, nickname: string | null): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const metaPath = join(agentDir, "meta.json");

  // ── Clear path ──────────────────────────────────────────────────────────
  // Skips validateAgentName entirely (there's no name to validate) and just
  // deletes the field. Idempotent: clearing an already-unset nickname is fine.
  if (nickname === null) {
    let meta: Record<string, unknown>;
    try {
      const file = Bun.file(metaPath);
      if (!(await file.exists())) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
      }
      meta = await file.json();
    } catch {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read meta.json for '${agent.id}'` };
    }
    delete meta.nickname; // delete the field, never write ""
    try {
      // Reuse the shared atomic writer (tmp+rename + trailing newline) so
      // `ib nickname` writes meta.json identically to every other meta writer.
      await writeMetaJsonAtomic(agentDir, meta);
    } catch (err) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to write meta.json: ${err}` };
    }
    await logAgent(agentDir, `Cleared nickname (id ${agent.id})`);
    return { ok: true, exitCode: 0, stdout: `Cleared nickname for ${agent.id}`, stderr: "" };
  }

  // ── Set path ────────────────────────────────────────────────────────────
  const repos = await listRepos();

  // 1. Syntactic + reservation validation (shared with new-agent).
  const nameError = validateAgentName(nickname, repos);
  if (nameError) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: ${nameError}` };
  }

  // 2. A nickname equal to this agent's own id is a no-op alias — reject and
  //    point at --clear (which is how you remove a nickname).
  if (nickname === agent.id) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: nickname "${nickname}" is already this agent's id; use --clear to remove a nickname` };
  }

  // 3. Global collision scan across ALL registered repos.
  const { agents: allAgents } = await readAllAgents(
    repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })),
  );
  for (const other of allAgents) {
    // Reject if the nickname equals any existing agent's id (ids aren't
    // globally unique, so this must scan every repo).
    if (other.id === nickname) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: nickname "${nickname}" collides with an existing agent id` };
    }
    // Reject if the nickname equals ANOTHER agent's nickname. Skip THIS agent
    // (re-setting its own nickname is allowed).
    if (other.id !== agent.id && other.meta.nickname === nickname) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: nickname "${nickname}" is already used by agent ${other.id}` };
    }
  }

  // 4. Write the nickname (whole-object round-trip, like writeAgentState —
  //    every meta writer preserves unknown fields, so this is safe). Cache is
  //    mtime-keyed and auto-invalidates on the rename().
  let meta: Record<string, unknown>;
  try {
    const file = Bun.file(metaPath);
    if (!(await file.exists())) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
    }
    meta = await file.json();
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read meta.json for '${agent.id}'` };
  }
  meta.nickname = nickname;
  try {
    // Reuse the shared atomic writer (tmp+rename + trailing newline) so
    // `ib nickname` writes meta.json identically to every other meta writer.
    await writeMetaJsonAtomic(agentDir, meta);
  } catch (err) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to write meta.json: ${err}` };
  }

  await logAgent(agentDir, `Nicknamed "${nickname}" (id ${agent.id})`);
  return { ok: true, exitCode: 0, stdout: `Nicknamed ${agent.id} "${nickname}"`, stderr: "" };
}

/**
 * Native merge-check implementation — replaces `ib merge-check <id>`.
 *
 * 1. Check worktree directory exists
 * 2. Check no uncommitted changes in worktree
 * 3. Check main branch exists
 * 4. Check agent branch exists
 * 5. Run checkRebaseConflicts for conflict detection
 */
export async function mergeCheckAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const worktreePath = join(agentDir, "repo");
  const branchName = `agent/${agent.id}`;

  // Long-running-op guard: refuse if another op (check/merge/restart) is in
  // flight with a live holder; reclaim on a dead holder. Cleared in `finally`.
  const acquired = await acquireAgentOperation(agentDir, "merge_check");
  if (!acquired.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: acquired.stderr };
  }

  try {
    // 1. Check worktree exists + no uncommitted changes
    const worktreeCheck = await timed("merge-check", "worktree-check", async () => {
      try {
        await readdir(worktreePath);
      } catch {
        return { ok: false as const, stderr: `Agent '${agent.id}' has no worktree` };
      }
      const worktreeStatus = await mergeSpawnCtx.run(["git", "-C", worktreePath, "status", "--porcelain"]);
      if (worktreeStatus.exitCode === 0 && worktreeStatus.stdout.trim()) {
        return { ok: false as const, stderr: `Agent '${agent.id}' has uncommitted changes` };
      }
      return { ok: true as const };
    });
    if (!worktreeCheck.ok) {
      return { ok: false, exitCode: 1, stdout: "", stderr: worktreeCheck.stderr };
    }

    // 2. Check main + agent branches exist
    const branchCheck = await timed("merge-check", "branch-resolve", async () => {
      const mainRef = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "show-ref", "--verify", "refs/heads/main"]);
      if (mainRef.exitCode !== 0) {
        return { ok: false as const, stderr: "Main branch not found" };
      }
      const branchRef = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "show-ref", "--verify", `refs/heads/${branchName}`]);
      if (branchRef.exitCode !== 0) {
        return { ok: false as const, stderr: `Branch '${branchName}' does not exist` };
      }
      return { ok: true as const };
    });
    if (!branchCheck.ok) {
      return { ok: false, exitCode: 1, stdout: "", stderr: branchCheck.stderr };
    }

    // 3. Pre-rebase conflict check
    const conflictResult = await timed("merge-check", "conflict-detect", () =>
      checkRebaseConflicts(agent.repoPath, "main", branchName)
    );
    if (!conflictResult.ok) {
      return {
        ok: false, exitCode: 1, stdout: "",
        stderr: `Rebase conflict detected between '${branchName}' and 'main'`,
      };
    }

    // 4. Count commits
    const commitCount = await timed("merge-check", "commit-count", async () => {
      const logResult = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "log", `main..${branchName}`, "--oneline"]);
      return logResult.stdout.trim() ? logResult.stdout.trim().split("\n").length : 0;
    });

    return {
      ok: true, exitCode: 0,
      stdout: `Merge check passed: ${commitCount} commit(s), no conflicts, no uncommitted changes`,
      stderr: "",
    };
  } finally {
    await clearAgentOperation(agentDir);
  }
}

/** Pluggable spawn runner for merge — defaults to Bun.spawn, overridable for tests */
/** Spawn context for merge operations */
export const mergeSpawnCtx = new SpawnContext();

/** Override the merge spawn runner (for testing) */
export function setMergeSpawnRunner(runner: SpawnFn): void {
  mergeSpawnCtx.set(runner);
}

/** Reset the merge spawn runner */
export function resetMergeSpawnRunner(): void {
  mergeSpawnCtx.reset();
}

/**
 * Pre-rebase conflict check: creates a temp branch/worktree, attempts rebase,
 * and cleans up. Returns { ok: true } if no conflicts, { ok: false, output } if conflicts.
 * Mirrors check_rebase_conflicts() in ib bash.
 */
async function checkRebaseConflicts(
  repoPath: string,
  targetBranch: string,
  sourceBranch: string
): Promise<{ ok: boolean; output: string }> {
  const tempBranch = `temp-rebase-check-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const tempDir = `/tmp/ib-rebase-check-${tempBranch}`;

  // Create temp branch from source
  const createBranch = await mergeSpawnCtx.run(["git", "-C", repoPath, "branch", tempBranch, sourceBranch]);
  if (createBranch.exitCode !== 0) {
    return { ok: false, output: "Could not create temp branch for conflict check" };
  }

  // Create temp worktree
  const createWorktree = await mergeSpawnCtx.run(["git", "-C", repoPath, "worktree", "add", tempDir, tempBranch, "--quiet"]);
  if (createWorktree.exitCode !== 0) {
    await mergeSpawnCtx.run(["git", "-C", repoPath, "branch", "-D", tempBranch]);
    return { ok: false, output: "Could not create temp worktree for conflict check" };
  }

  // Attempt rebase in temp worktree
  const rebaseResult = await mergeSpawnCtx.run(["git", "-C", tempDir, "rebase", targetBranch]);
  let result: { ok: boolean; output: string };

  if (rebaseResult.exitCode !== 0) {
    // Abort the failed rebase
    await mergeSpawnCtx.run(["git", "-C", tempDir, "rebase", "--abort"]);
    result = { ok: false, output: rebaseResult.stdout };
  } else {
    result = { ok: true, output: "" };
  }

  // Clean up: remove temp worktree and branch (with rm -rf fallback)
  const worktreeRemove = await mergeSpawnCtx.run(["git", "-C", repoPath, "worktree", "remove", tempDir, "--force"]);
  if (worktreeRemove.exitCode !== 0) {
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  await mergeSpawnCtx.run(["git", "-C", repoPath, "branch", "-D", tempBranch]);

  return result;
}

/**
 * Native merge implementation — replaces `ib merge <id> --force`.
 *
 * Sequence (mirrors cmd_merge + do_merge in ib bash):
 * 1. Verify agent directory exists
 * 2. Verify worktree exists
 * 3. Check worktree has no uncommitted changes
 * 4. Detect target branch (current branch → main → master → error)
 * 5. Verify agent branch exists
 * 6. Check current dir has no uncommitted changes
 * 7. Pre-rebase conflict check
 * 8. Rebase agent branch onto target
 * 9. Checkout target branch
 * 10. Merge (ff-only if agent, --no-ff if user)
 * 11. Capture tmux output
 * 12. Kill Claude process
 * 13. Kill tmux session
 * 14. Copy settings.local.json from worktree
 * 15. Remove worktree
 * 16. Delete branch
 * 17. Archive artifacts
 * 18. Remove questions
 * 19. Remove agent directory
 * 20. Scan for orphaned processes
 */
export async function mergeAgent(agent: Agent, targetDir: string): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const agentsDir = join(agent.repoPath, ".ittybitty", "agents");
  const branchName = `agent/${agent.id}`;
  const worktreePath = join(agentDir, "repo");
  const tmuxSession = agent.meta.tmux_session;

  // Long-running-op guard: refuse if another op (check/merge/restart) is in
  // flight with a live holder; reclaim on a dead holder. Cleared in `finally`.
  const acquired = await acquireAgentOperation(agentDir, "merging");
  if (!acquired.ok) {
    return { ok: false, exitCode: 1, stdout: "", stderr: acquired.stderr };
  }

  try {
    // 1-6. Preflight: agent dir, worktree, statuses, target branch, branch existence
    const preflight = await timed("merge", "preflight", async () => {
      // 1. Agent dir must exist
      const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
      if (!dirExists) {
        return { ok: false as const, stderr: `Agent '${agent.id}' not found` };
      }

      // 2. Agent must have a worktree
      try {
        await readdir(worktreePath);
      } catch {
        return { ok: false as const, stderr: `Agent '${agent.id}' has no worktree (was created with --no-worktree?)` };
      }

      // 2b. Cannot merge from within the agent's own worktree
      const currentDir = process.cwd();
      if (currentDir.startsWith(worktreePath)) {
        return { ok: false as const, stderr: "Cannot merge agent from within its own worktree" };
      }

      // 3. Agent worktree must have no uncommitted changes
      const worktreeStatus = await mergeSpawnCtx.run(["git", "-C", worktreePath, "status", "--porcelain"]);
      if (worktreeStatus.exitCode === 0 && worktreeStatus.stdout.trim()) {
        return { ok: false as const, stderr: `Agent '${agent.id}' has uncommitted changes` };
      }

      // 4. Detect target branch from targetDir
      let targetBranch = "";
      const currentBranch = await mergeSpawnCtx.run(["git", "-C", targetDir, "branch", "--show-current"]);
      if (currentBranch.exitCode === 0 && currentBranch.stdout.trim()) {
        targetBranch = currentBranch.stdout.trim();
      }
      if (!targetBranch) {
        const mainRef = await mergeSpawnCtx.run(["git", "show-ref", "--verify", "refs/heads/main"]);
        if (mainRef.exitCode === 0) {
          targetBranch = "main";
        } else {
          const masterRef = await mergeSpawnCtx.run(["git", "show-ref", "--verify", "refs/heads/master"]);
          if (masterRef.exitCode === 0) {
            targetBranch = "master";
          } else {
            return { ok: false as const, stderr: "Could not determine target branch (detached HEAD with no main/master)" };
          }
        }
      }

      // 5. Agent branch must exist
      const branchRef = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "show-ref", "--verify", `refs/heads/${branchName}`]);
      if (branchRef.exitCode !== 0) {
        return { ok: false as const, stderr: `Branch '${branchName}' does not exist` };
      }

      // 6. Target directory must have no uncommitted changes
      const repoStatus = await mergeSpawnCtx.run(["git", "-C", targetDir, "status", "--porcelain"]);
      if (repoStatus.exitCode === 0 && repoStatus.stdout.trim()) {
        return { ok: false as const, stderr: "Target directory has uncommitted changes" };
      }

      return { ok: true as const, targetBranch };
    });
    if (!preflight.ok) {
      return { ok: false, exitCode: 1, stdout: "", stderr: preflight.stderr };
    }
    const targetBranch = preflight.targetBranch;

    // 7. Pre-rebase conflict check
    const conflictResult = await timed("merge", "conflict-check", () =>
      checkRebaseConflicts(agent.repoPath, targetBranch, branchName)
    );
    if (!conflictResult.ok) {
      await logAgent(agentDir, `Pre-rebase conflict check failed - conflicts detected with ${targetBranch}`);
      return {
        ok: false, exitCode: 1, stdout: "",
        stderr: `Rebase conflict detected between '${branchName}' and '${targetBranch}'`,
      };
    }

    // Count commits to merge
    const logResult = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "log", `${targetBranch}..${branchName}`, "--oneline"]);
    const commitCount = logResult.stdout.trim() ? logResult.stdout.trim().split("\n").length : 0;

    await logAgent(agentDir, `Starting rebase of ${branchName} onto ${targetBranch} (${commitCount} commits)`);

    if (commitCount > 0) {
      // 8. Rebase agent branch onto target (in agent's worktree)
      const rebaseOk = await timed("merge", "git-rebase", async () => {
        await logAgent(agentDir, `Rebasing ${branchName} onto ${targetBranch}...`);
        const rebaseResult = await mergeSpawnCtx.run(["git", "-C", worktreePath, "rebase", targetBranch]);
        if (rebaseResult.exitCode !== 0) {
          return { ok: false as const, stderr: `Rebase failed: ${rebaseResult.stderr || rebaseResult.stdout}` };
        }
        await logAgent(agentDir, "Rebase completed successfully");
        return { ok: true as const };
      });
      if (!rebaseOk.ok) {
        return { ok: false, exitCode: 1, stdout: "", stderr: rebaseOk.stderr };
      }

      // 9-10. Checkout target branch + merge
      const mergeOk = await timed("merge", "git-merge", async () => {
        await logAgent(agentDir, `Checking out ${targetBranch}...`);
        const checkoutResult = await mergeSpawnCtx.run(["git", "-C", targetDir, "checkout", targetBranch]);
        if (checkoutResult.exitCode !== 0) {
          return { ok: false as const, stderr: `Could not checkout ${targetBranch}: ${checkoutResult.stderr || checkoutResult.stdout}` };
        }

        const runningAsAgent = await isRunningAsAgent();
        if (runningAsAgent) {
          await logAgent(agentDir, `Fast-forwarding ${targetBranch} to ${branchName}...`);
          const ffResult = await mergeSpawnCtx.run(["git", "-C", targetDir, "merge", "--ff-only", branchName]);
          if (ffResult.exitCode !== 0) {
            return { ok: false as const, stderr: `Fast-forward failed: ${ffResult.stderr || ffResult.stdout}` };
          }
          await logAgent(agentDir, "Fast-forward merge completed successfully");
        } else {
          await logAgent(agentDir, `Merging ${branchName} with --no-ff...`);
          const noFFResult = await mergeSpawnCtx.run(["git", "-C", targetDir, "merge", "--no-ff", branchName, "-m", `Merge agent ${agent.id} work`]);
          if (noFFResult.exitCode !== 0) {
            return { ok: false as const, stderr: `Merge failed: ${noFFResult.stderr || noFFResult.stdout}` };
          }
          await logAgent(agentDir, "Merge completed successfully");
        }
        return { ok: true as const };
      });
      if (!mergeOk.ok) {
        return { ok: false, exitCode: 1, stdout: "", stderr: mergeOk.stderr };
      }
    }

    // 11. Capture tmux output before killing
    await timed("merge", "tmux-capture", async () => {
      await logAgent(agentDir, "Capturing tmux output...");
      if (tmuxSession) {
        const hasSession = await mergeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
        if (hasSession.exitCode === 0) {
          await captureTmuxOutputToFile(tmuxSession, join(agentDir, "output.log"));
        }
      }
    });

    // 12-13. Kill Claude process + tmux session
    await timed("merge", "tmux-cleanup", async () => {
      await logAgent(agentDir, "Terminating Claude process...");
      const killed = await killAgentProcess(tmuxSession, { claude_pid: agent.meta.claude_pid });
      if (killed) {
        await logAgent(agentDir, "Claude process terminated");
      }
      if (tmuxSession) {
        const hasSession2 = await mergeSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
        if (hasSession2.exitCode === 0) {
          await mergeSpawnCtx.run(["tmux", "kill-session", "-t", tmuxSession]);
          await logAgent(agentDir, "Tmux session stopped");
        }
      }
    });

    // 14-16. Copy settings, remove worktree, delete branch
    await timed("merge", "worktree-cleanup", async () => {
      const settingsPath = join(worktreePath, ".claude", "settings.local.json");
      try {
        if (await Bun.file(settingsPath).exists()) {
          const content = await Bun.file(settingsPath).text();
          await Bun.write(join(agentDir, "settings.local.json"), content);
        }
      } catch { /* ignore */ }

      await logAgent(agentDir, "Removing worktree...");
      const removeResult = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "worktree", "remove", worktreePath, "--force"]);
      if (removeResult.exitCode !== 0) {
        try { await rm(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      await logAgent(agentDir, "Worktree removed");

      await logAgent(agentDir, `Deleting branch ${branchName}...`);
      const deleteBranch = await mergeSpawnCtx.run(["git", "-C", agent.repoPath, "branch", "-D", branchName]);
      if (deleteBranch.exitCode === 0) {
        await logAgent(agentDir, `Branch deleted: ${branchName}`);
      }
    });

    // 17-19. Archive artifacts, remove questions, remove agent dir. archiveAgent
    // also prunes this agent from every team (§16.5); hoist the pruned pairs out
    // of the timed block so the leave-notice fan-out below can see them.
    let prunedTeams: Array<{ team: string; id: string }> = [];
    await timed("merge", "archive", async () => {
      await logAgent(agentDir, "Merge complete - archiving and closing agent");
      const res = await archiveAgent(agent.repoPath, agent.id, agentDir);
      prunedTeams = res.prunedTeams;
      await removeAgentQuestions(agent.repoPath, agent.id);
      try { await rm(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // 20. Scan for orphaned Claude processes
    await timed("merge", "orphan-scan", () => scanAndKillOrphans(agentsDir));

    // merge = single-agent departure → per-agent leave notice to surviving
    // teammates, `fromAgent` = the departed id (§16.5). Best-effort.
    await emitPerAgentLeaveNotice(prunedTeams, await listRepos());

    return { ok: true, exitCode: 0, stdout: `Closed agent: ${agent.id}`, stderr: "" };
  } finally {
    // Clear the op marker on every return path. On the SUCCESS path the agent
    // dir was already removed at step 17-19, so this writes into a now-gone
    // dir — ENOENT-safe via updateAgentTransient's best-effort try/catch. On a
    // FAILED merge the dir still exists and the marker is cleared so a retry
    // (or kill) is not blocked. Single clear point — no double-clear.
    await clearAgentOperation(agentDir);
  }
}

/** Spawn context for send operations */
export const sendSpawnCtx = new SpawnContext();
/** Override delay for tests (null = use calculated delay) */
let sendDelayOverrideMs: number | null = null;

/** Override the send spawn runner (for testing). Sets delay to 0 by default. */
export function setSendSpawnRunner(runner: SpawnFn): void {
  sendSpawnCtx.set(runner);
  sendDelayOverrideMs = 0;
}

/** Reset the send spawn runner */
export function resetSendSpawnRunner(): void {
  sendSpawnCtx.reset();
  sendDelayOverrideMs = null;
}

/**
 * Resolve the sender ID for a send, performing cwd-based auto-detection.
 *
 * This MUST happen at ENQUEUE time (not drain time): it depends on the SENDER
 * process's `opts.cwd`/`process.cwd()`, which is gone by the time a watchdog
 * drains the queue. The resolved id (real agent id, `@system` sentinel, or ""
 * for the human user) is stored in the queued record.
 */
function resolveSenderId(agentRepoPath: string, opts?: { fromAgent?: string; cwd?: string }): string {
  let fromId = opts?.fromAgent ?? "";
  if (fromId) return fromId;

  const cwd = opts?.cwd ?? process.cwd();
  const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/(?:[^/]+)\/repo/);
  if (worktreeMatch) {
    // Read the sender's meta.json to get their ID (synchronously here is fine —
    // this runs at enqueue time in the sender process).
    const senderAgentDir = cwd.replace(/(\/\.ittybitty\/agents\/[^/]+)\/repo.*/, "$1");
    try {
      const senderMeta = JSON.parse(require("fs").readFileSync(join(senderAgentDir, "meta.json"), "utf-8"));
      if (senderMeta?.id) fromId = senderMeta.id;
    } catch { /* ignore */ }
  } else {
    // System coordinator runs from ~/.itsybitsy/ — no worktree match.
    // If cwd is the coordinator home (or under it), stamp as @system.
    // Both paths are compared as raw strings (no realpath resolution): we
    // assume process.cwd() and getCoordinatorHome() return paths in the
    // same un-resolved form. If $HOME is itself a symlink and a caller
    // resolved it before chdir'ing, this match would silently miss — in
    // practice the coordinator session is launched with an un-resolved
    // home so the assumption holds.
    const coordHome = getCoordinatorHome();
    if (cwd === coordHome || cwd.startsWith(coordHome + "/")) {
      fromId = "@system";
    }
  }
  return fromId;
}

/**
 * Deliver ONE queued message to an agent's tmux session — the single tmux
 * writer. This is the exact body the historical `sendMessage` ran for one
 * message: has-session check, sender-prefix formatting (including the
 * `user.name` config read), chunked `send-keys -l`, inter-chunk sleep,
 * length-scaled delay, `Enter`, recipient/sender logging, `writeAgentState`.
 *
 * Callers (the watchdog drain and the inline fallback) hold the per-session
 * delivery lock for the whole batch, so two `send-keys`/`Enter` sequences to
 * the same session can never interleave.
 *
 * Returns an IbCommandResult so callers can propagate failures. On failure the
 * message is NOT removed from the outbox (no message loss).
 */
export async function deliverMessage(agent: Agent, queued: OutboxMessage): Promise<IbCommandResult> {
  const tmuxSession = agent.meta.tmux_session;
  if (!tmuxSession) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent has no tmux session" };
  }

  // Verify session exists
  const hasSessionProc = sendSpawnCtx.runner(
    ["tmux", "has-session", "-t", tmuxSession],
    { stdout: "pipe", stderr: "pipe" }
  );
  await new Response(hasSessionProc.stderr).text(); // drain
  const hasSessionExit = await hasSessionProc.exited;
  if (hasSessionExit !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is not running` };
  }

  const fromId = queued.fromAgent;
  const message = queued.message;

  // Format message with sender prefix. `@`-prefixed sender IDs (e.g. @system)
  // are sentinels, not agent IDs, so omit the literal "agent " word for them.
  // Sentinels listed in `BARE_RENDERED_SENTINELS` additionally render without
  // the leading `@` (e.g. `@watchdog` → `[sent by watchdog]`) to avoid being
  // misread as the routable `@<repo-name>` coordinator namespace — the bracket
  // shape already distinguishes auto-injected nudges from agent messages, so
  // the `@` carries no information for these senders.
  // No fromId means the send originates from a human-driven path (CLI, TUI,
  // etc.) — prefix as a user send so the recipient can distinguish user vs
  // agent messages. Raw mode (used by Telegram slash-command passthrough)
  // skips the prefix entirely — the recipient pane sees the message verbatim.
  // A human-originated message (no fromId) that begins with `/` or `!` is a
  // passthrough: the user is sending a slash command or a `!`-bang shell command
  // meant to land in the agent's terminal verbatim, exactly as if they had typed
  // it directly. Such messages skip the `[sent by user ...]` prefix (which would
  // otherwise push the `/`/`!` off the first column and stop the command from
  // firing). Only applies to user sends — an agent-relayed message keeps its
  // `[sent by agent ...]` attribution even when it starts with `/` or `!`, so the
  // recipient still knows who sent it.
  const raw = queued.raw === true;
  const userPassthrough = !raw && !fromId && (message.startsWith("/") || message.startsWith("!"));
  // A team fan-out (§16.4) carries the team name on the queued message; the
  // delivery prefix gains an ` in @<team>` clause so the recipient learns the
  // reply target by example. The stored team name is BARE (no `@`), so we add a
  // literal `@` in the rendered prefix. Raw mode (no prefix at all) is unchanged.
  // Composes naturally with `userPassthrough`: a `/` or `!` user message skips the
  // whole `[sent by ... in @<team>]:` block (the `if (!raw && !userPassthrough)`
  // guard below), so a passthrough lands in the recipient terminal verbatim even
  // for a team send — which is the intended behavior (the prefix would push the
  // command off the first column and stop it from firing).
  const teamClause = !raw && typeof queued.team === "string" && queued.team.length > 0
    ? ` in @${queued.team}`
    : "";
  let fullMessage = message;
  let userLabel = "";
  if (!raw && !userPassthrough) {
    if (fromId) {
      let label: string;
      if (fromId.startsWith("@")) {
        label = BARE_RENDERED_SENTINELS.has(fromId) ? fromId.slice(1) : fromId;
      } else {
        // In a team context the ` in @<team>` clause already establishes that
        // the sender is an agent in a room, so the literal "agent " word is
        // dropped (§16.4 delivery-prefix divergence). Outside a team it stays.
        label = teamClause ? fromId : `agent ${fromId}`;
      }
      fullMessage = `[sent by ${label}${teamClause}]: ${message}`;
    } else {
      const config = await readConfig();
      const userName = config["user.name"]?.value;
      userLabel = typeof userName === "string" && userName.length > 0 ? `user ${userName}` : "user";
      fullMessage = `[sent by ${userLabel}${teamClause}]: ${message}`;
    }
  }

  // Calculate delay: 0.1 + (len / 100) * 0.5, clamped [0.2, 3.0]
  const msgLen = fullMessage.length;
  let delay = 0.1 + (msgLen / 100) * 0.5;
  if (delay < 0.2) delay = 0.2;
  if (delay > 3.0) delay = 3.0;

  // Send via tmux send-keys, chunked to avoid silent truncation when the
  // recipient TUI cannot ingest a large -l payload fast enough.
  const CHUNK_SIZE = 500;
  const INTER_CHUNK_SLEEP_MS = 50;
  const interChunkSleepMs = sendDelayOverrideMs !== null ? sendDelayOverrideMs : INTER_CHUNK_SLEEP_MS;
  for (let i = 0; i < fullMessage.length; i += CHUNK_SIZE) {
    const chunk = fullMessage.slice(i, i + CHUNK_SIZE);
    // `--` stops tmux flag parsing so a chunk that begins with `-` (e.g. YAML
    // frontmatter `---`) isn't mistaken for an option.
    const chunkProc = sendSpawnCtx.runner(
      ["tmux", "send-keys", "-t", tmuxSession, "-l", "--", chunk],
      { stdout: "pipe", stderr: "pipe" }
    );
    const chunkStderr = await new Response(chunkProc.stderr).text();
    const chunkExit = await chunkProc.exited;
    if (chunkExit !== 0) {
      return { ok: false, exitCode: chunkExit, stdout: "", stderr: chunkStderr.trim() };
    }
    const isLastChunk = i + CHUNK_SIZE >= fullMessage.length;
    if (!isLastChunk && interChunkSleepMs > 0) await Bun.sleep(interChunkSleepMs);
  }

  // Sleep for calculated delay (skippable in tests)
  const actualDelayMs = sendDelayOverrideMs !== null ? sendDelayOverrideMs : delay * 1000;
  if (actualDelayMs > 0) await Bun.sleep(actualDelayMs);

  // Send Enter
  const enterProc = sendSpawnCtx.runner(
    ["tmux", "send-keys", "-t", tmuxSession, "Enter"],
    { stdout: "pipe", stderr: "pipe" }
  );
  await new Response(enterProc.stderr).text(); // drain
  await enterProc.exited;

  // Log to recipient's agent.log. Raw sends omit sender attribution from the
  // recipient line since the recipient pane saw the message without any
  // [sent by ...] prefix — surfacing the sender only in the log would be
  // confusing.
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  if (raw) {
    await logAgent(agentDir, `Received raw message: ${message}`);
  } else if (userPassthrough) {
    // Delivered verbatim (no prefix) — a user slash/bang command passthrough.
    await logAgent(agentDir, `Received command from user: ${message}`);
  } else if (fromId) {
    await logAgent(agentDir, `Received message from ${fromId}: ${message}`);
  } else {
    await logAgent(agentDir, `Received message from ${userLabel}: ${message}`);
  }

  // Log to sender's agent.log if applicable
  if (fromId) {
    const senderDir = join(agent.repoPath, ".ittybitty", "agents", fromId);
    const verb = raw ? "Sent raw message" : "Sent message";
    await logAgent(senderDir, `${verb} to ${agent.id}: ${message}`);
  }

  // Write state: "running" to meta.json (agent just received input)
  await writeAgentState(agentDir, "running");

  const stdout = fromId ? "" : `Sent to ${agent.id}`;
  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/** Settle gap between consecutive messages in one drain so they land as distinct prompts. */
const DRAIN_SETTLE_GAP_MS = 250;

/**
 * Drain the outbox for `agent` under the per-session lock: pop queued messages
 * one at a time and `deliverMessage` each, with a short settle gap between
 * consecutive messages so they land as DISTINCT prompts.
 *
 * Correctness guarantees:
 *   - Only the lock holder delivers, so two drains can never interleave their
 *     `send-keys`/`Enter` sequences to the same session.
 *   - A delivered message is removed from the outbox only AFTER its Enter
 *     succeeds and it is logged (the rewrite happens after `deliverMessage`
 *     returns ok), so a crash mid-batch never redelivers an earlier message.
 *   - On delivery failure the message REMAINS in the outbox and the drain
 *     stops (it will be retried on the next tick / call). No message loss.
 *
 * `lockOpts.steal` is set by the inline fallback so a crashed holder can't
 * wedge delivery; the watchdog leaves it false and simply retries next tick.
 * Returns the IbCommandResult of the FIRST delivered message (so the inline
 * `sendMessage` path can return the historical success/failure shape), or a
 * synthetic ok result when the queue was empty / lock unavailable.
 */
export async function drainOutbox(
  agent: Agent,
  dir: string,
  lockOpts?: AcquireLockOpts,
): Promise<IbCommandResult> {
  const lock = await acquireOutboxLock(dir, lockOpts);
  if (!lock) {
    // Could not acquire — messages stay enqueued, another drainer will get them.
    return { ok: true, exitCode: 0, stdout: `Sent to ${agent.id}`, stderr: "" };
  }

  const delivered = new Set<string>();
  let firstResult: IbCommandResult | null = null;
  try {
    const batch = await readOutbox(dir);
    for (let i = 0; i < batch.length; i++) {
      const queued = batch[i]!;
      const settleGap = sendDelayOverrideMs !== null ? sendDelayOverrideMs : DRAIN_SETTLE_GAP_MS;
      if (i > 0 && settleGap > 0) await Bun.sleep(settleGap);

      const result = await deliverMessage(agent, queued);
      if (firstResult === null) firstResult = result;
      if (!result.ok) {
        // Stop the drain — leave this message (and the rest) enqueued.
        break;
      }
      delivered.add(queued.id);
      // Remove just-delivered messages now, before delivering the next one, so
      // a crash mid-batch never redelivers an already-sent message.
      await rewriteOutboxRemoving(dir, delivered);
    }
  } finally {
    await releaseOutboxLock(lock);
  }

  return firstResult ?? { ok: true, exitCode: 0, stdout: `Sent to ${agent.id}`, stderr: "" };
}

/**
 * Detect whether a live watchdog is going to drain this agent's outbox. A
 * watchdog is "live" when meta.transient.json records a watchdog_pid that is
 * fresh (updated within TRANSIENT_FRESH_MS) and whose process is alive.
 */
async function hasLiveWatchdog(agentDir: string): Promise<boolean> {
  const transient = await readAgentTransient(agentDir);
  if (!transient) return false;
  const fresh = transient.updated_at_ms > 0 && Date.now() - transient.updated_at_ms < TRANSIENT_FRESH_MS;
  if (!fresh) return false;
  return isPidAliveCtx.fn(transient.watchdog_pid);
}

/**
 * Send a message to an agent's tmux session (native implementation).
 *
 * Behavior (per the per-agent outbox design):
 * 1. Resolve the sender id via cwd auto-detection (must happen here, in the
 *    sender process — see `resolveSenderId`).
 * 2. ENQUEUE the message to the agent's `outbox.jsonl`.
 * 3. If a live watchdog exists, RETURN immediately — the watchdog drains the
 *    queue under the per-session lock. Otherwise drain inline under the lock
 *    (the sender becomes the drainer for this batch). This preserves the
 *    historical behavior of `ib send` to a stopped/complete agent (which
 *    restarts it) and the coordinator path.
 *
 * The public signature and return shape are unchanged: returns an
 * IbCommandResult with `stdout === "Sent to <id>"` when no sender is set and
 * `""` when a sender is set, so existing tests and callers keep working. When
 * no transient file exists (the common unit-test scenario), the inline drain
 * delivers synchronously within this call, producing the SAME observable tmux
 * spawn calls in the SAME order as before this refactor.
 *
 * When `opts.raw` is true, the `[sent by ...]:` prefix is suppressed and the
 * message is delivered verbatim (see `deliverMessage`).
 */
export async function sendMessage(
  agent: Agent,
  message: string,
  opts?: { fromAgent?: string; cwd?: string; raw?: boolean; outboxDir?: string; team?: string }
): Promise<IbCommandResult> {
  const tmuxSession = agent.meta.tmux_session;
  if (!tmuxSession) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent has no tmux session" };
  }

  // The outbox queue + lock live in `outboxDir` when provided (the system
  // coordinator has no agent dir, so its queue/lock live in the coordinator
  // home directly so all coordinator senders serialize against ONE queue).
  // Otherwise the per-agent queue lives under the CENTRAL outbox root
  // (`agentOutboxDir(id)` → `~/.itsybitsy/agents/<id>/`) so codex agents
  // running under `-s workspace-write` can write to other agents' outboxes.
  // Log/state writes still target the per-worktree agent dir
  // (`deliverMessage`), which is correct for both cases.
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const queueDir = opts?.outboxDir ?? agentOutboxDir(agent.id);

  // Resolve sender at ENQUEUE time (depends on the sender process's cwd).
  const fromId = resolveSenderId(agent.repoPath, opts);
  const raw = opts?.raw === true;

  // Enqueue. The agent dir is created by spawn; for the rare case it is
  // missing, enqueueOutbox mkdir's the queue dir so a queued message is never
  // silently dropped. A genuine write failure surfaces as an error rather than
  // an unhandled rejection.
  try {
    await enqueueOutbox(queueDir, { message, fromAgent: fromId, raw, team: opts?.team });
  } catch (err) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to enqueue message: ${err}` };
  }

  const stdout = fromId ? "" : `Sent to ${agent.id}`;

  // If a live watchdog will drain, just return — it owns delivery. (The system
  // coordinator has no per-agent watchdog, so a coordinator send always drains
  // inline below.)
  if (await hasLiveWatchdog(agentDir)) {
    return { ok: true, exitCode: 0, stdout, stderr: "" };
  }

  // No live watchdog — the sender becomes the drainer for this batch. Steal a
  // stale lock so a crashed holder can't wedge delivery forever.
  const result = await drainOutbox(agent, queueDir, { steal: true });
  // Preserve the historical stdout shape (drainOutbox returns deliverMessage's
  // result, whose stdout already matches; but on empty/lock-skip it returns a
  // generic success — normalize the success stdout to the sender-aware value).
  if (result.ok) {
    return { ok: true, exitCode: 0, stdout, stderr: "" };
  }
  return result;
}

// ===========================================================================
// Teams — fan-out + command layer (SPEC §16.3/§16.4). The registry primitives
// live in `./teams` (frozen API: getTeam/listTeams/createTeam/deleteTeam/
// addMember/removeMember/pruneDeadMembers + name validation). This layer owns
// the resolver-side fan-out (`teamSend`), the `ib team` subcommands, the
// `ib roster` listing, and the JOIN / per-agent-team-REMOVE leave notices
// (§16.4.1/§16.4.2). Notices are best-effort: a delivery failure never fails
// the command (§16.4.1).
// ===========================================================================

/** Format `name` as a non-zero IbCommandResult error line (stderr + exit 1). */
function teamErr(message: string): IbCommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr: message };
}

/** Format `name` as a success IbCommandResult (stdout + exit 0). */
function teamOk(stdout: string): IbCommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Build the set of all live agent ids across every registered repo. Used to
 * decide membership liveness for lazy pruning (§16.5): a member is "alive" iff
 * its agent still resolves to a real agent directory. `readAllAgents` only
 * returns agents whose `meta.json` exists, so membership in this set is the
 * authoritative "agent still exists" signal.
 */
async function liveAgentIds(repos: RepoEntry[]): Promise<Set<string>> {
  const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
  return new Set(agents.map((a) => a.id));
}

/**
 * Resolve the sender id for a team send the SAME way `sendMessage` does:
 * explicit `--from` wins, else cwd auto-detection (`resolveSenderId`). Returns
 * `""` when no sender can be detected (human/CLI from outside a worktree),
 * which excludes nobody — the correct behavior for a human-driven team send.
 * `resolveSenderId`'s `repoPath` argument is only used for logging context, so
 * any member's repoPath (or `""`) is fine here; we only need the resolved id.
 */
function resolveTeamSenderId(repos: RepoEntry[], opts: { fromAgent?: string } | undefined): string {
  if (opts?.fromAgent) return opts.fromAgent;
  return resolveSenderId("", opts);
}

/**
 * Fan a message out to a team (§16.4). The caller (`ib send @<team>`) has
 * already resolved the `@`-target to a team via `resolveTarget`; `members` is
 * that resolved set, but this function re-derives the authoritative recipient
 * set itself so it can LAZY-PRUNE dead members from the stored roster at send
 * time (§16.5) — the resolver's snapshot may include ids that have since died.
 *
 * Sequence:
 *   1. Resolve the sender id (cwd/`--from`, same as `sendMessage`) for exclusion.
 *   2. Lazy-prune the roster: any stored member whose agent no longer exists is
 *      removed from `teams.json` (under the lock, by `pruneDeadMembers`).
 *   3. Fan out to each surviving member EXCEPT the sender, via `sendMessage`
 *      with the `team` opt set (so the delivery prefix renders `in @<team>`).
 *   4. Empty recipient set (no members / only-sender / all-pruned) is a no-op
 *      SUCCESS printing `no recipients in @<team>` (§16.4 empty-set no-op).
 *
 * Per-member sends are best-effort: a single failure is recorded but does not
 * abort the rest, and the aggregate result is non-zero only if EVERY attempted
 * send failed (mirrors §16.4.1 best-effort notices).
 */
export async function teamSend(
  teamName: string,
  members: Agent[],
  message: string,
  opts: { fromAgent?: string } | undefined,
  repos: RepoEntry[],
): Promise<IbCommandResult> {
  const name = normalizeTeamName(teamName);
  const senderId = resolveTeamSenderId(repos, opts);

  // Lazy-prune dead members from the stored roster (§16.5): a member is alive
  // iff it resolves to a still-existing agent directory. The predicate RECOMPUTES
  // the live set on each call rather than closing over a pre-lock snapshot —
  // pruneDeadMembers invokes it during BOTH its unlocked pre-scan AND its in-lock
  // re-scan, and the in-lock pass MUST see fresh state. A frozen Set snapshotted
  // before the lock would mis-prune a member added in the race window (e.g.
  // `ib team add` committing concurrently): the in-lock re-test would not find
  // the just-joined id in the stale Set and would silently drop it. Recomputing
  // fresh each call closes that window.
  const isAlive = async (id: string) => (await liveAgentIds(repos)).has(id);
  const pruneRes = await pruneDeadMembers(name, isAlive);
  if (!pruneRes.team) {
    // Team vanished between resolveTarget and here — treat as not found.
    return teamErr(`Error: team @${name} not found`);
  }

  // Build the recipient Agent list from the SURVIVING roster, excluding the
  // sender. Map ids back to Agents via the resolved `members` first (fast),
  // falling back to a fresh readAllAgents lookup for any survivor not in the
  // resolver's snapshot (it pruned members it couldn't resolve, but a survivor
  // is by definition resolvable).
  const byId = new Map(members.map((m) => [m.id, m]));
  const survivors = pruneRes.team.members.filter((id) => id !== senderId);
  let lookupAgents: Agent[] | null = null;
  const recipients: Agent[] = [];
  for (const id of survivors) {
    let agent = byId.get(id);
    if (!agent) {
      if (!lookupAgents) {
        const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
        lookupAgents = agents;
      }
      agent = lookupAgents.find((a) => a.id === id);
    }
    if (agent) recipients.push(agent);
  }

  // Persist ONE channel record per send to the shared team channel (§17.4) — the
  // chat box's backing history. Placed AFTER the not-found check (so a nonexistent
  // team writes no channel file) but BEFORE the empty-recipient early return, so a
  // self-only / zero-survivor send to an EXISTING team still records the message
  // in the room's history (the §17.4 recommended default: append when the team
  // exists and the message is non-empty, even with an empty recipient set). It is
  // ONE record per send (NOT inside the per-recipient loop, which would write N
  // duplicate lines) and records the message regardless of per-recipient delivery
  // success — the channel is the room's history, not a delivery receipt.
  // Best-effort: a channel-append failure must never fail the send (§17.4).
  if (message) {
    await appendChannelMessage(name, {
      ts: Math.floor(Date.now() / 1000),
      fromAgent: senderId,
      message,
    }).catch(() => {});
  }

  if (recipients.length === 0) {
    // No one to deliver to — empty team, self-only, or all-pruned. No-op success.
    return teamOk(`no recipients in @${name}`);
  }

  const fromAgent = senderId || undefined;
  let failures = 0;
  const failureLines: string[] = [];
  for (const recipient of recipients) {
    const res = await sendMessage(recipient, message, { fromAgent, team: name });
    if (!res.ok) {
      failures++;
      failureLines.push(`  ${recipient.id}: ${res.stderr || "delivery failed"}`);
    }
  }

  const delivered = recipients.length - failures;
  if (failures === recipients.length) {
    // Every send failed — surface as an error so the caller exits non-zero.
    return teamErr(`Error: failed to deliver to all ${recipients.length} member(s) of @${name}:\n${failureLines.join("\n")}`);
  }
  let stdout = `Sent to ${delivered} member(s) of @${name}`;
  if (failures > 0) {
    stdout += `\n(${failures} delivery failure(s):\n${failureLines.join("\n")}\n)`;
  }
  return teamOk(stdout);
}

/**
 * Deliver the JOIN notice (§16.4.1) after a successful `ib team add` (persist-
 * then-notify: the membership write already happened under the lock). The
 * EXISTING members (post-write roster minus the newly-added id) each receive a
 * `joined the team` fan-out; the NEWLY-ADDED agent instead receives a one-time
 * instruction teaching the room reply protocol (since session-start may have
 * fired before it joined). Best-effort — any delivery failure is swallowed so
 * the command never fails (§16.4.1).
 */
async function fireJoinNotice(
  name: string,
  team: Team,
  addedId: string,
  repos: RepoEntry[],
): Promise<void> {
  // Audit the lifecycle event in the team's <team>.log (§17.4). Best-effort and
  // additive — never changes the notice fan-out below.
  await appendTeamLog(name, `agent ${addedId} joined`).catch(() => {});
  // Mirror the join into the team's channel.jsonl as a SYSTEM record so the
  // chat box renders it inline with chat, dimmed (§17.4 design update). Additive
  // to the audit log; both paths fire on every join.
  await appendChannelSystemMessage(name, addedId, "joined the team").catch(() => {});
  try {
    const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
    const byId = new Map(agents.map((a) => [a.id, a]));

    // Existing members (everyone in the post-write roster except the new joiner).
    for (const memberId of team.members) {
      if (memberId === addedId) continue;
      const member = byId.get(memberId);
      if (!member) continue;
      await sendMessage(member, "joined the team", { fromAgent: addedId, team: name }).catch(() => {});
    }

    // The newly-added agent gets the reply-protocol instruction (§16.4.1). It is
    // stamped from `@system` so it reads as a system instruction, not a peer
    // message. Carrying `team` keeps the `in @<team>` clause for consistency.
    const newAgent = byId.get(addedId);
    if (newAgent) {
      const instruction =
        `You were added to team @${name}. Messages in this room arrive as ` +
        `"[sent by <agent-id> in @${name}]: ...". The <agent-id> is who spoke; ` +
        `@${name} is where to reply. To reply to the room, run: ib send @${name} "<message>". ` +
        `See your teammates with: ib roster @${name}.`;
      await sendMessage(newAgent, instruction, { fromAgent: "@system", team: name }).catch(() => {});
    }
  } catch {
    // Best-effort — a notice failure must never fail `ib team add` (§16.4.1).
  }
}

/**
 * Deliver the per-agent LEAVE notice (§16.4.2) after a successful
 * `ib team remove` (persist-then-notify). The post-write members (the departed
 * id is already absent) each receive a `left the team` fan-out, with `fromAgent`
 * stamped EXPLICITLY to the departed id (§16.5 — never cwd-auto-detected).
 * Best-effort. (Leave notices for `ib kill`/`ib merge`/`ib nuke` belong to the
 * teardown path, owned by another module — NOT here.)
 */
async function fireRemoveLeaveNotice(
  name: string,
  team: Team,
  removedId: string,
  repos: RepoEntry[],
): Promise<void> {
  // Audit the lifecycle event in the team's <team>.log (§17.4). Best-effort and
  // additive — never changes the notice fan-out below.
  await appendTeamLog(name, `agent ${removedId} left`).catch(() => {});
  // Mirror the leave into the team's channel.jsonl as a SYSTEM record so the
  // chat box renders it inline with chat, dimmed (§17.4 design update).
  await appendChannelSystemMessage(name, removedId, "left the team").catch(() => {});
  try {
    const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const memberId of team.members) {
      const member = byId.get(memberId);
      if (!member) continue;
      await sendMessage(member, "left the team", { fromAgent: removedId, team: name }).catch(() => {});
    }
  } catch {
    // Best-effort — a notice failure must never fail `ib team remove` (§16.4.1).
  }
}

/**
 * Resolve a possibly-partial agent id/nickname to its FULL id, using the same
 * matcher as `ib send` (`matchAgentById`). Returns `{ id }` on a unique match,
 * or `{ error }` describing not-found / ambiguity. Used by `ib team add/remove`.
 */
async function resolveFullAgentId(
  partial: string,
  repos: RepoEntry[],
): Promise<{ id: string } | { error: string }> {
  const { matchAgentById } = await import("./index");
  const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
  const { match, ambiguous } = matchAgentById(partial, agents);
  if (ambiguous.length > 0) {
    return { error: `Error: ambiguous agent id "${partial}" matches: ${ambiguous.join(", ")}` };
  }
  if (!match) {
    return { error: `Error: agent not found: ${partial}` };
  }
  return { id: match.id };
}

/**
 * `ib team create <name>` (§16.3). Validates the name (allowlist + reserved-word
 * collision per §16.1), then creates an empty team. Idempotency is NOT silent:
 * a duplicate name is an error, not a no-op (§16.3 — `create` errors when the
 * name already exists).
 */
export async function teamCreate(name: string, opts?: { createdBy?: string }): Promise<IbCommandResult> {
  const n = normalizeTeamName(name);
  if (!isValidTeamName(n)) {
    return teamErr(`Error: invalid team name "${n}" — team names must match [A-Za-z0-9_-]+`);
  }
  if (await isReservedTeamName(n)) {
    return teamErr(`Error: team name @${n} is reserved (collides with a coordinator/system/repo name)`);
  }
  try {
    await createTeam(n, opts?.createdBy ?? "", Math.floor(Date.now() / 1000));
  } catch {
    // createTeam throws only on the already-exists race/collision (§teams.ts).
    return teamErr(`Error: team @${n} already exists`);
  }
  // Audit the creation in the team's <team>.log (§17.4). Best-effort.
  await appendTeamLog(n, `team created by ${opts?.createdBy || "user"}`).catch(() => {});
  // Mirror the creation into the team's channel.jsonl as a SYSTEM record so
  // the chat box renders it inline with chat, dimmed (§17.4 design update).
  // DROP the `by <user>` suffix here — it's noise in the chat box; the full
  // attribution stays in the audit log above.
  await appendChannelSystemMessage(n, "@system", "team created").catch(() => {});
  return teamOk(`Created team @${n}`);
}

/**
 * `ib team add <name> <agent-id>` (§16.3). Errors if the team does not exist;
 * resolves `<agent-id>` via the same partial matcher as `ib send`; no-op success
 * if already a member; fires the JOIN notice (§16.4.1) on a real add.
 */
export async function teamAdd(name: string, agentIdOrPartial: string, repos: RepoEntry[]): Promise<IbCommandResult> {
  const n = normalizeTeamName(name);
  if (!(await getTeam(n))) {
    return teamErr(`Error: team @${n} not found`);
  }
  const resolved = await resolveFullAgentId(agentIdOrPartial, repos);
  if ("error" in resolved) return teamErr(resolved.error);
  const id = resolved.id;

  const { added, team } = await addMember(n, id);
  if (!team) {
    // Team was deleted between our check and the locked write.
    return teamErr(`Error: team @${n} not found`);
  }
  if (!added) {
    return teamOk(`agent ${id} is already in @${n}`);
  }
  // Persist-then-notify (§16.4.1): membership write committed under the lock;
  // fan the join notice to the post-write snapshot. Best-effort.
  await fireJoinNotice(n, team, id, repos);
  return teamOk(`Added ${id} to @${n}`);
}

/**
 * `ib team remove <name> <agent-id>` (§16.3). Errors if the team does not exist;
 * resolves `<agent-id>` via the same partial matcher as `ib send`; no-op success
 * if not a member; fires the per-agent LEAVE notice (§16.4.2) on a real removal.
 */
export async function teamRemove(name: string, agentIdOrPartial: string, repos: RepoEntry[]): Promise<IbCommandResult> {
  const n = normalizeTeamName(name);
  if (!(await getTeam(n))) {
    return teamErr(`Error: team @${n} not found`);
  }
  const resolved = await resolveFullAgentId(agentIdOrPartial, repos);
  if ("error" in resolved) return teamErr(resolved.error);
  const id = resolved.id;

  const { removed, team } = await removeMember(n, id);
  if (!team) {
    return teamErr(`Error: team @${n} not found`);
  }
  if (!removed) {
    return teamOk(`agent ${id} was not in @${n}`);
  }
  // Persist-then-notify (§16.4.2): leave notice to the post-write snapshot
  // (the departed id is already absent). Best-effort.
  await fireRemoveLeaveNotice(n, team, id, repos);
  return teamOk(`Removed ${id} from @${n}`);
}

/**
 * `ib team list` (§16.3). One line per team with its member count, sorted by
 * name for stable output. Empty → `No teams.`
 */
export async function teamList(): Promise<IbCommandResult> {
  const teams = await listTeams();
  if (teams.length === 0) {
    return teamOk("No teams.");
  }
  const lines = teams
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `@${t.name}  ${t.members.length} member(s)`);
  return teamOk(lines.join("\n"));
}

/**
 * `ib team delete <name>` (§16.3). Removes the `teams.json` entry. Errors if the
 * team did not exist. Does NOT notify (the team is gone).
 */
export async function teamDelete(name: string): Promise<IbCommandResult> {
  const n = normalizeTeamName(name);
  const ok = await deleteTeam(n);
  if (!ok) {
    return teamErr(`Error: team @${n} not found`);
  }
  // Cleanup the team's channel + log files (§17.4 cleanup default) so a deleted
  // team leaves no orphaned files and a later `ib team create` of the same name
  // starts with a clean channel. Best-effort, in the COMMAND wrapper (not the
  // locked `deleteTeam` registry primitive). Placed after the successful delete.
  await deleteChannelFiles(n).catch(() => {});
  return teamOk(`Deleted team @${n}`);
}

/**
 * `ib roster <name>` (§16.3). Errors if the team does not exist. LAZY-prunes
 * dead members first (§16.5), then lists the surviving members one per line
 * with repo and current state where resolvable. Header `@<name> (<count> members):`.
 */
export async function roster(name: string, repos: RepoEntry[]): Promise<IbCommandResult> {
  const n = normalizeTeamName(name);
  if (!(await getTeam(n))) {
    return teamErr(`Error: team @${n} not found`);
  }
  // Lazy-prune dead members (§16.5), then list survivors with repo/state.
  // detectAgentStates mutates `agents` in place so `agent.state` reflects the
  // live detected state (§16.3: "state read via detectAgentStates()") instead of
  // the uniform "unknown" readAllAgents assigns.
  const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })));
  // Read-only display: explicitly opt out of reaping. detectAgentStates
  // defaults to reap-disabled, but pass {reap: false} to make intent
  // unambiguous — `roster` must never side-effect agents.
  await detectAgentStates(agents, { reap: false });
  const byId = new Map(agents.map((a) => [a.id, a]));
  // The liveness predicate RECOMPUTES the live set on each call rather than
  // closing over a pre-lock snapshot. pruneDeadMembers invokes it during both its
  // unlocked pre-scan and its in-lock re-scan; the in-lock pass MUST see fresh
  // state so a member added in the race window (e.g. a concurrent `ib team add`)
  // is not mis-pruned against a stale Set. See teamSend for the same fix.
  const isAlive = async (id: string) => (await liveAgentIds(repos)).has(id);
  const pruneRes = await pruneDeadMembers(n, isAlive);
  if (!pruneRes.team) {
    // Deleted between the existence check and the prune.
    return teamErr(`Error: team @${n} not found`);
  }
  const survivors = pruneRes.team.members;
  if (survivors.length === 0) {
    return teamOk(`@${n} (0 members)`);
  }
  const lines = [`@${n} (${survivors.length} members):`];
  for (const id of survivors) {
    const agent = byId.get(id);
    if (agent) {
      lines.push(`  ${id}  ${agent.repoName}  ${agent.state}`);
    } else {
      lines.push(`  ${id}`);
    }
  }
  return teamOk(lines.join("\n"));
}

export interface NewAgentOptions {
  name?: string;
  type?: string;
  yolo?: boolean;
  model?: string;
  manager?: string;
  noWorktree?: boolean;
  allowTools?: string;
  denyTools?: string;
  print?: boolean;
  spawnedBy?: SpawnedBy;
  /** Override cwd for auto-detect manager (used in tests). */
  _cwd?: string;
}

/** Spawn context for newAgent operations */
export const newAgentSpawnCtx = new SpawnContext();
/** Override delay for newAgent tests (null = use real delay) */
let newAgentDelayOverrideMs: number | null = null;

/** Override the newAgent spawn runner (for testing). Sets delay to 0 by default. */
export function setNewAgentSpawnRunner(runner: SpawnFn): void {
  newAgentSpawnCtx.set(runner);
  newAgentDelayOverrideMs = 0;
}

/** Reset the newAgent spawn runner */
export function resetNewAgentSpawnRunner(): void {
  newAgentSpawnCtx.reset();
  newAgentDelayOverrideMs = null;
}

/**
 * Injectable spawn function for the codex dispatcher dry-run precheck.
 * Takes an explicit `cwd` so the spawned `ib hooks <event> <id> --dry-run`
 * subprocess inherits the agent's worktree path — without this, the dry-run
 * resolves agentsDir relative to the parent process's cwd, which is wrong
 * when the spawn caller (e.g. system coordinator) lives outside any worktree.
 *
 * Kept separate from SpawnContext/SpawnFn so we don't have to widen the
 * shared signature; tests can inject via setCodexDryRunSpawnRunner.
 */
export type CodexDryRunFn = (
  cmd: string[],
  cwd: string,
) => import("./types").SpawnResult;

const defaultCodexDryRunFn: CodexDryRunFn = (cmd, cwd) =>
  Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd }) as import("./types").SpawnResult;

class CodexDryRunContext {
  private _fn: CodexDryRunFn = defaultCodexDryRunFn;

  set(fn: CodexDryRunFn): void {
    this._fn = fn;
  }

  reset(): void {
    this._fn = defaultCodexDryRunFn;
  }

  async run(
    cmd: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = this._fn(cmd, cwd);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }
}

/** Spawn context for the codex spawn-time dispatcher dry-run precheck. */
export const codexDryRunSpawnCtx = new CodexDryRunContext();

/** Override the codex dry-run spawn runner (for testing). */
export function setCodexDryRunSpawnRunner(fn: CodexDryRunFn): void {
  codexDryRunSpawnCtx.set(fn);
}

/** Reset the codex dry-run spawn runner. */
export function resetCodexDryRunSpawnRunner(): void {
  codexDryRunSpawnCtx.reset();
}

/** Injectable watchdog spawn for testing — returns PID or undefined */
type WatchdogSpawnFn = (id: string, repoPath: string, logPath: string) => { pid?: number } | null;
let watchdogSpawnOverride: WatchdogSpawnFn | null = null;

/** Override watchdog spawn for testing */
export function setWatchdogSpawnFn(fn: WatchdogSpawnFn): void {
  watchdogSpawnOverride = fn;
}

/** Reset watchdog spawn to default */
export function resetWatchdogSpawnFn(): void {
  watchdogSpawnOverride = null;
}

/**
 * Read custom prompts from .ittybitty/prompts/ directory.
 * Mirrors load_custom_prompts() in ib bash.
 */
async function loadCustomPrompts(repoPath: string): Promise<{
  all: string;
  manager: string;
  worker: string;
}> {
  const promptsDir = join(repoPath, ".ittybitty", "prompts");
  const result = { all: "", manager: "", worker: "" };

  for (const [key, filename] of [
    ["all", "all.md"],
    ["manager", "manager.md"],
    ["worker", "worker.md"],
  ] as const) {
    try {
      const file = Bun.file(join(promptsDir, filename));
      if (await file.exists()) {
        result[key] = await file.text();
      }
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Count active agents (directories with meta.json in agents dir).
 * Mirrors count_agents() in ib bash.
 */
async function countAgents(agentsDir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaExists = await Bun.file(join(agentsDir, entry.name, "meta.json")).exists().catch(() => false);
      if (metaExists) count++;
    }
  } catch { /* directory may not exist */ }
  return count;
}

/**
 * Read the repo-id from .ittybitty/repo-id (or create one).
 * Mirrors get_repo_id() in ib bash.
 */
async function getRepoId(repoPath: string): Promise<string> {
  const repoIdFile = join(repoPath, ".ittybitty", "repo-id");
  try {
    const file = Bun.file(repoIdFile);
    if (await file.exists()) {
      const id = (await file.text()).trim();
      if (id) return id;
    }
  } catch { /* ignore */ }

  // Generate new 8 hex char ID
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const newId = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  await mkdir(join(repoPath, ".ittybitty"), { recursive: true });
  await Bun.write(repoIdFile, newId + "\n");
  return newId;
}

/**
 * Build settings.local.json content for an agent worktree.
 * Mirrors build_agent_settings() + build_settings_json() in ib bash.
 */
async function buildAgentSettings(
  repoPath: string,
  agentType: "manager" | "worker",
  agentId: string,
  configAllow: string[],
  configDeny: string[]
): Promise<string> {
  // Start with existing project settings if available.
  // We read settings.json (the version-controlled project settings), NOT settings.local.json.
  // The .local file may belong to a coordinator or have repo-specific overrides that should
  // not propagate to spawned agents.
  let baseSettings: Record<string, unknown> = {};
  try {
    const settingsFile = Bun.file(join(repoPath, ".claude", "settings.json"));
    if (await settingsFile.exists()) {
      baseSettings = await settingsFile.json();
    }
  } catch { /* ignore */ }

  // Initialize permissions
  // Note: we inherit existing allow entries from settings.json (harmless — more
  // permissions don't hurt), but NOT existing deny entries. The base settings.json
  // may have deny entries that should not propagate to agents. Agent deny lists come
  // from config and agent type frontmatter only.
  const perms = (baseSettings.permissions ?? {}) as Record<string, unknown>;
  const existingAllow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];

  // Merge and deduplicate
  const allAllow = [...new Set([...existingAllow, ...REGULAR_AGENT_DEFAULT_ALLOW, ...configAllow])];
  const allDeny = [...new Set([...REGULAR_AGENT_DEFAULT_DENY, ...configDeny])];

  // Check if intercept hook should be added (reuse already-parsed baseSettings)
  let addIntercept = false;
  if (agentType === "manager") {
    const hooksObj = baseSettings.hooks as Record<string, unknown> | undefined;
    const preToolUse = hooksObj?.PreToolUse;
    if (Array.isArray(preToolUse)) {
      for (const entry of preToolUse) {
        const hooks = entry?.hooks;
        if (Array.isArray(hooks)) {
          for (const h of hooks) {
            if (typeof h?.command === "string" && h.command.includes("hooks intercept-task")) {
              addIntercept = true;
            }
          }
        }
      }
    }
  }

  const result = {
    ...baseSettings,
    spinnerTipsEnabled: false,
    permissions: {
      allow: allAllow,
      deny: allDeny,
    },
    hooks: buildHooksBlock({
      agentId,
      includeStop: true,
      interceptMatcher: addIntercept ? REGULAR_AGENT_INTERCEPT_MATCHER : null,
      sessionStartIncludesAgentId: false,
      includeTimestamp: true,
    }),
  };

  return JSON.stringify(result, null, 2);
}

/**
 * Native newAgent implementation — replaces `ib new-agent`.
 *
 * Sequence (mirrors cmd_new_agent in ib bash):
 * 1.  Validate prompt (required)
 * 2.  Ensure .ittybitty/agents/ and .ittybitty/archive/ dirs exist
 * 3.  Auto-detect manager from cwd if not provided
 * 4.  Validate manager (resolve partial ID, check not a worker)
 * 5.  Yolo escalation check
 * 6.  Load config for model, maxAgents, permissions, prompts
 * 7.  Model fallback: --model > config.model > 'claude:opus'
 * 8.  Max agents check
 * 9.  Generate agent ID (--name or agent-<8 hex chars>)
 * 10. Uniqueness check (dir + tmux session)
 * 11. Create agent directory + write initial meta.json (state="creating")
 * 12. Create git worktree + branch (if worktree mode)
 * 13. Write settings.local.json in worktree
 * 14. (formerly meta.json — now written in step 11 before slow worktree add)
 * 15. Write prompt.txt
 * 16. Write start.sh + exit-check.sh
 * 17. Init agent.log
 * 18. Start tmux session
 * 19. Verify tmux session created
 * 20. Output agent ID
 * 21. Post-create-agent hook
 * 22. Auto-accept workspace trust (if not yolo)
 * 23. Auto-spawn watchdog
 */
export async function newAgent(
  repoPath: string,
  prompt: string,
  opts?: NewAgentOptions
): Promise<IbCommandResult> {
  // 1. Validate prompt
  if (!prompt || !prompt.trim()) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Error: prompt required" };
  }

  // Resolve the root repo path (handles worktrees)
  const rootRepoPath = (await resolveGitRoot(repoPath)) || repoPath;

  // Validate path for shell script interpolation
  if (!isValidShellPath(rootRepoPath)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Repository path contains characters unsafe for shell scripts (null bytes or newlines): ${rootRepoPath}` };
  }

  const agentsDir = join(rootRepoPath, ".ittybitty", "agents");
  const archiveDir = join(rootRepoPath, ".ittybitty", "archive");

  // 2. Ensure dirs exist
  await mkdir(agentsDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });

  // Configuration
  let useWorktree = opts?.noWorktree !== true;
  const yoloMode = opts?.yolo === true;

  // Ensure agent types directory is initialized + load the requested type.
  const { ensureAgentTypesDir } = await import("./agent-types");
  try {
    await timed("new-agent", "type-init", () => ensureAgentTypesDir());
  } catch (err) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error initializing agent types: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Resolve agent type: --type <name> or default to 'manager'
  const typeName = opts?.type ?? "manager";

  // Validate --type exists before proceeding
  const typeExists = await timed("new-agent", "type-exists", () => agentTypeExists(typeName));
  if (!typeExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: unknown agent type '${typeName}'. Run 'ib init-types' to restore default type files, or create ~/.itsybitsy/agent-types/${typeName}.md` };
  }

  // Determine if this is a coordinator type
  const agentTypeDef = await timed("new-agent", "type-load", () => loadAgentType(typeName));

  // Reject layer-only types (spawnable: false) — these are merge layers, not spawnable agents
  if (agentTypeDef.spawnable === false) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: type ${typeName} is not spawnable (used only as a permissions/prompt layer)` };
  }

  // Repo restriction check (see PLAN-INHERITS.md §Part 2). Must run after
  // `loadAgentType` so an inherited `repos` list is honored, and before any
  // worktree/tmux/agent-dir allocation so a rejection leaves no residue. Also
  // before the coordinator idempotency check below — a restricted coordinator
  // spawned in the wrong repo should fail with the repo error, not silently
  // succeed via idempotency.
  if (agentTypeDef.repos !== undefined) {
    const allKnownRepos = await listRepos();
    const entry = allKnownRepos.find((r) => r.path === rootRepoPath);
    const basenameOnly = basename(rootRepoPath);
    // Trim whitespace on the candidates as a defensive parallel to the
    // `allowed` list's .trim() — a nickname with trailing whitespace in
    // repos.json should still match a clean entry in the type's repos list.
    const candidates = (entry
      ? [entry.name, entry.nickname].filter((s): s is string => typeof s === "string" && s.length > 0)
      : [basenameOnly]
    ).map((s) => s.trim()).filter(Boolean);
    const allowed = agentTypeDef.repos.map((s) => s.trim()).filter(Boolean);
    const matches = candidates.some((c) => allowed.includes(c));
    if (!matches) {
      const display = entry ? repoDisplayName(entry) : basenameOnly;
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `Error: agent type '${typeName}' is restricted to repos [${allowed.join(", ")}]; current repo '${display}' (path: ${rootRepoPath}) is not in that list`,
      };
    }
  }

  const coordinatorMode = typeName === "coordinator";

  // Coordinators never use worktrees (SPEC §12.2.3)
  if (coordinatorMode) {
    useWorktree = false;
  }

  // Coordinator one-per-repo check
  if (coordinatorMode) {
    const coordStatus = await checkCoordinatorExists(rootRepoPath);
    if (coordStatus.exists) {
      // Idempotent no-op per SPEC §12.2.3
      const repoName = rootRepoPath.split("/").pop() ?? rootRepoPath;
      return { ok: true, exitCode: 0, stdout: coordStatus.agentId, stderr: `Coordinator already exists for ${repoName}` };
    }
  }
  const printMode = opts?.print === true;
  const allowTools = opts?.allowTools ?? "";
  const denyTools = opts?.denyTools ?? "";

  // Validate CLI-originated values before bash interpolation
  if (allowTools && !isValidToolList(allowTools)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid --allow tools value: ${allowTools}` };
  }
  if (denyTools && !isValidToolList(denyTools)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid --deny tools value: ${denyTools}` };
  }

  let manager = opts?.manager ?? "";

  // 3. Auto-detect manager from cwd (only if cwd is in the same repo)
  //    Coordinators are top-level agents — never auto-detect a manager (SPEC §12.2.3)
  if (!manager && !coordinatorMode) {
    const cwd = opts?._cwd ?? process.cwd();
    const agentPattern = /\/.ittybitty\/agents\/([^/]+)\/repo/;
    const match = cwd.match(agentPattern);
    if (match && (cwd === rootRepoPath || cwd.startsWith(rootRepoPath + "/"))) {
      const agentDirPath = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
      try {
        const metaFile = Bun.file(join(agentDirPath, "meta.json"));
        if (await metaFile.exists()) {
          const meta = await metaFile.json();
          if (meta.id) manager = meta.id;
        }
      } catch { /* ignore */ }
    }
  }

  // 3.5. Auto-detect spawned_by from CWD (works cross-repo, unlike manager auto-detect)
  let spawnedBy: SpawnedBy | undefined = opts?.spawnedBy;
  if (!spawnedBy) {
    const cwd = opts?._cwd ?? process.cwd();

    // Case 1: Worktree agent — CWD matches /.ittybitty/agents/<id>/repo
    const agentPattern = /\/.ittybitty\/agents\/([^/]+)\/repo/;
    const worktreeMatch = cwd.match(agentPattern);
    if (worktreeMatch) {
      const spawnerDir = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
      try {
        const spawnerMeta = await Bun.file(join(spawnerDir, "meta.json")).json();
        if (spawnerMeta.id) {
          const spawnerRepoPath = cwd.substring(0, cwd.indexOf("/.ittybitty/agents/"));
          spawnedBy = {
            agent_id: spawnerMeta.id,
            repo_path: spawnerRepoPath,
          };
        }
      } catch { /* ignore */ }
    }

    // Case 2A: System coordinator — CWD is the system coordinator home
    // (~/.itsybitsy/). The system coordinator is not a registered repo so the
    // Case 2B per-repo lookup below would never match. Tag with the @system
    // sentinel so the watchdog can route notifications via
    // sendToSystemCoordinator() (direct tmux delivery to the ib-coordinator
    // session). Like Case 2B, this is gated on CLAUDE_SESSION_ID so a human
    // running `ib new-agent` from the system coordinator dir does not get tagged.
    if (!spawnedBy && !worktreeMatch && process.env.CLAUDE_SESSION_ID) {
      let systemHome: string | null = null;
      try {
        systemHome = realpathSync(getCoordinatorHome());
      } catch {
        systemHome = resolve(getCoordinatorHome());
      }
      let resolvedCwd: string;
      try {
        resolvedCwd = realpathSync(cwd);
      } catch {
        resolvedCwd = resolve(cwd);
      }
      if (systemHome && resolvedCwd === systemHome) {
        spawnedBy = {
          agent_id: "@system",
          repo_path: null,
        };
      }
    }

    // Case 2B: Non-worktree per-repo coordinator — CWD is a registered repo root.
    // Coordinators run from the repo root, so CWD won't match the worktree pattern.
    // Detect by checking if CWD is a registered repo with a coordinator agent.
    // Only fires when CLAUDE_SESSION_ID is set, which means the caller is a Claude agent
    // session (e.g. a coordinator). Human users running ib watch or ib new-agent from the
    // command line won't have this variable, so they won't get auto-assigned a coordinator
    // as spawner.
    //
    // The stored agent_id is the `@<repo-name>` sentinel (not the coordinator's
    // actual agent_id) so the watchdog routes notifications through resolveTarget,
    // which is robust to the coordinator being killed and re-created.
    if (!spawnedBy && !worktreeMatch && process.env.CLAUDE_SESSION_ID) {
      try {
        const repos = await listRepos();
        const repoMatch = repos.find(r => r.path === cwd);
        if (repoMatch) {
          const coordStatus = await checkCoordinatorExists(cwd);
          if (coordStatus.exists && coordStatus.agentId) {
            // Stamp with `basename(cwd)` — the same invariant that
            // `getCoordinatorAgentId()` uses for the coordinator's actual
            // agent ID. The access checks in agent-path.ts and the
            // routing in notifySpawner @<repo-name> both compare the
            // sentinel suffix against the coordinator's agent ID, so
            // they must use the same source of truth. Using the registry
            // `name` (or worse, the nickname) would silently break access
            // any time a user passed a custom name via `ib add <path>
            // <custom-name>` or set a nickname.
            spawnedBy = {
              agent_id: `@${basename(cwd)}`,
              repo_path: cwd,
            };
          }
        }
      } catch { /* ignore */ }
    }
  }

  // 4. Validate manager
  if (manager) {
    // Resolve partial ID
    const resolveResult = await resolveAgentId(agentsDir, manager);
    if ("error" in resolveResult) {
      const suffix = resolveResult.matches.length > 0
        ? `: ${resolveResult.matches.join(", ")}`
        : "";
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: ${resolveResult.error} for '${manager}'${suffix}` };
    }
    manager = resolveResult.resolved;

    // Check manager is not a worker
    try {
      const managerMeta = await Bun.file(join(agentsDir, manager, "meta.json")).json();
      if (managerMeta.worker === true) {
        return { ok: false, exitCode: 1, stdout: "", stderr: `Error: '${manager}' is a worker agent and cannot manage sub-agents` };
      }
    } catch { /* ignore */ }
  }

  // 5. Yolo escalation check (only if cwd is in the same repo)
  if (yoloMode) {
    const cwd = opts?._cwd ?? process.cwd();
    if (/\/.ittybitty\/agents\/[^/]+\/repo/.test(cwd) && (cwd === rootRepoPath || cwd.startsWith(rootRepoPath + "/"))) {
      const parentAgentDir = cwd.replace(/(\/.ittybitty\/agents\/[^/]*)\/repo.*/, "$1");
      let parentIsYolo = false;

      try {
        const parentMeta = await Bun.file(join(parentAgentDir, "meta.json")).json();
        if (parentMeta.yolo === true) parentIsYolo = true;
      } catch { /* ignore */ }

      if (!parentIsYolo) {
        try {
          const startSh = await Bun.file(join(parentAgentDir, "start.sh")).text();
          if (startSh.includes("dangerously-skip-permissions")) parentIsYolo = true;
        } catch { /* ignore */ }
      }

      if (!parentIsYolo) {
        return { ok: false, exitCode: 1, stdout: "", stderr: "Error: Yolo mode denied - permission escalation not allowed" };
      }
    }
  }

  // 6. Load config
  const config = await readConfig();
  const customPrompts = await loadCustomPrompts(rootRepoPath);

  // Leaf agents can't spawn children (worker-like behavior)
  const isLeafAgent = !agentTypeDef.canSpawnChildren;

  // Load the agent-type layer files once, up front, so BOTH the model
  // resolution (step 7) and the permissions merge (step 7.1) read from the
  // same objects. This mirrors the permissions-layer set exactly:
  //   - `_all.md` — applied to every spawned agent
  //   - `_non_coordinator.md` — applied to non-coordinator agents only
  //   - `<type>.md` (already loaded above as `agentTypeDef`) — per-type
  // Each is loaded defensively (a missing/broken layer warns but doesn't throw,
  // matching the legacy permissions code). `loadAgentType(...).model` is either
  // a non-empty string or `undefined` — `parseAgentTypeFile` collapses a blank
  // `model:` value to `undefined` (see agent-types.ts:538), so a layer that
  // declares `model:` with no value contributes nothing to the precedence chain.
  let allLayer: AgentType | undefined;
  try {
    allLayer = await loadAgentType("_all");
  } catch (err) {
    console.error(`Warning: failed to load _all agent type layer: ${err instanceof Error ? err.message : String(err)}`);
  }

  let nonCoordLayer: AgentType | undefined;
  if (!coordinatorMode) {
    try {
      nonCoordLayer = await loadAgentType("_non_coordinator");
    } catch (err) {
      console.error(`Warning: failed to load _non_coordinator agent type layer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 7. Model precedence (most-specific wins, where 'more specific' overrides
  //    'less specific'):
  //      --model (CLI flag)
  //        > <type>.md model
  //        > _non_coordinator.md model (non-coordinator agents only)
  //        > _all.md model
  //        > config.model (or coordinator.model for coordinators)
  //        > 'claude:opus'
  //    The agent-type layers (least→most specific: _all < _non_coordinator <
  //    <type>) all override the user's config.model; config.model is the final
  //    fallback before 'claude:opus'. A blank `model:` in a more-specific layer
  //    is `undefined` after parsing and so does NOT clobber a real value set by
  //    a less-specific layer. All model strings are the qualified
  //    `<cli>:<model>` form (D1/D5); parseModel below rejects bare names + unknown CLI.
  let model = opts?.model ?? "";
  if (!model) {
    // Walk layers from most-specific to least; first non-empty wins.
    const layerChain: Array<string | undefined> = [
      agentTypeDef.model,
      coordinatorMode ? undefined : nonCoordLayer?.model,
      allLayer?.model,
    ];
    for (const layerModel of layerChain) {
      if (layerModel) { model = layerModel; break; }
    }
  }
  if (!model) {
    if (coordinatorMode) {
      const coordModel = config["coordinator.model"]?.value as string | undefined;
      if (coordModel) model = coordModel;
    } else {
      const configModel = config.model?.value as string | undefined;
      if (configModel) model = configModel;
    }
  }
  if (!model) model = "claude:opus";

  // Validate model name before bash interpolation (syntactic / shell-safety).
  if (!isValidModel(model)) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid model name: ${model}` };
  }

  // Parse the qualified `<cli>:<model>` form (SPEC-CODEX-MODEL.md §5.1, D1).
  // parseModel throws on a missing/malformed/unknown cli — the spawn is rejected
  // with the D6 message ("Unknown CLI '<x>' in model '<x>:<...>'; known: claude, codex").
  let parsed: ReturnType<typeof parseModel>;
  try {
    parsed = parseModel(model);
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
  const agentCli = parsed.cli;
  const modelFlagValue = parsed.model;

  // Codex spawn-path preconditions (SPEC §5.4 step 2 + §7 risk 14). Run
  // BEFORE any worktree/tmux work so a fail here doesn't leave residual
  // state behind. The path-safety check guards the TOML-in-shell quoting
  // in the inline `-c` payload; the binary lookup gives codex an absolute
  // path so its spawn env's PATH cannot break hook dispatch. The dispatcher
  // precheck is deferred until after agentDir is created so we can clean
  // it up uniformly with the rest of the spawn-failure paths.
  //
  // Codex + per-repo coordinator is rejected up-front (SPEC §D9 stub).
  // The system coordinator path (coordinator.ts:spawnCoordinator) has the
  // same guard, but per-repo coordinators reach `newAgent` directly with
  // coordinatorMode=true, so we need a guard HERE — without it the spawn
  // would skip the useWorktree branch (AGENTS.md, .gitignore, precheck)
  // and produce a broken half-codex coordinator.
  let codexIbBinaryPath: string | null = null;
  if (agentCli === "codex") {
    if (coordinatorMode) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `codex coordinators not yet implemented (per SPEC D9 stub); coordinator.model must use a claude:<model> form. Pending Phase 9 coordinator support.`,
      };
    }
    // Reject codex models not in our static allow-list before the codex CLI
    // is launched. Without this, an unsupported model (e.g. gpt-5.3-codex
    // on a ChatGPT-plan account) starts the agent, hits an HTTP 400 after
    // the first prompt, and leaves the user with a stuck "unknown"-state
    // agent that has to be nuked manually. KNOWN_MODELS is the source of
    // truth — update it when codex adds new models that are reachable on
    // the typical ChatGPT-plan account. See src/known-models.ts.
    if (!isKnownModel(parsed)) {
      const valid = listKnownSelectorsForCli("codex");
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr:
          `Codex model '${modelFlagValue}' is not supported. Valid models: ${valid.join(", ")}. ` +
          `Note: ChatGPT-plan and API-key codex accounts expose different model sets; ` +
          `if the model you want is missing here, it may not be reachable on a ChatGPT plan. ` +
          `Run 'ib list-models' for the full list.`,
      };
    }
    const { resolveIbBinaryPath } = await import("./codex-spawn");
    const { isCodexSafeBinaryPath } = await import("./codex-config");
    codexIbBinaryPath = resolveIbBinaryPath();
    if (!codexIbBinaryPath) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "Error: codex spawn requires an absolute path to the `ib` binary, but `ib` is not on PATH. Install ib and ensure it is reachable via PATH before spawning a codex agent.",
      };
    }
    if (!isCodexSafeBinaryPath(codexIbBinaryPath)) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `Error: Unsafe ib binary path for codex launch: ${JSON.stringify(codexIbBinaryPath)} contains quotes, backslashes, or control characters. Reinstall ib to a path made of printable ASCII with no apostrophes, quotes, or backslashes.`,
      };
    }
  }

  // 7.1. Permissions are assembled in three layers (SPEC §2.3):
  //   1. `_all.md` frontmatter — applied to every spawned agent
  //   2. `_non_coordinator.md` frontmatter — applied to non-coordinator agents only
  //   3. `<type>.md` frontmatter — per-type permissions
  // The layers are merged (allow/deny deduplicated via Set). Config-level
  // `permissions.all.*` / `permissions.repo.*` keys have been deprecated —
  // their contents have moved into the `_all.md` and `_non_coordinator.md` files.
  // Reuses the layer objects loaded above for the model precedence chain.
  const allLayerAllow = allLayer?.permissions?.allow ?? [];
  const allLayerDeny = allLayer?.permissions?.deny ?? [];
  const nonCoordAllow = nonCoordLayer?.permissions?.allow ?? [];
  const nonCoordDeny = nonCoordLayer?.permissions?.deny ?? [];

  const typeAllow = agentTypeDef.permissions?.allow ?? [];
  const typeDeny = agentTypeDef.permissions?.deny ?? [];
  const configAllow = [...new Set([...allLayerAllow, ...nonCoordAllow, ...typeAllow])];
  const configDeny = [...new Set([...allLayerDeny, ...nonCoordDeny, ...typeDeny])];

  // 8. Max agents check — coordinators bypass this (SPEC §12.4.3)
  if (!coordinatorMode) {
    const maxAgents = (config.maxAgents?.value as number | undefined) ?? 10;
    const currentCount = await countAgents(agentsDir);
    if (currentCount >= maxAgents) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: Maximum agent limit reached (${currentCount}/${maxAgents} agents)` };
    }
  }

  // 9. Generate agent ID
  const repos = await listRepos();
  let id: string;
  if (coordinatorMode) {
    id = getCoordinatorAgentId(rootRepoPath);
    // Collision handling: if a non-coordinator agent already has the basename,
    // append a random 4-char hex suffix
    const coordCheck = await checkCoordinatorExists(rootRepoPath);
    if (!coordCheck.exists && coordCheck.collision) {
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
        .map(b => b.toString(16).padStart(2, "0")).join("");
      id = `${id}-${suffix}`;
    }
  } else if (opts?.name) {
    // Shared validator: regex allowlist, reserved coordinator/system, and
    // repo-name/basename collision — same checks nicknames go through.
    const nameError = validateAgentName(opts.name, repos);
    if (nameError) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: ${nameError}` };
    }
    id = opts.name;
  } else {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    id = `agent-${Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  }

  // Reserved names check — applies to all ID generation paths (the named path
  // already rejected these via validateAgentName; this also guards the
  // coordinator/random paths).
  if (id === "coordinator") {
    return { ok: false, exitCode: 1, stdout: "", stderr: 'Error: "coordinator" is a reserved name (used for system coordinator addressing)' };
  }
  if (id === "system") {
    return { ok: false, exitCode: 1, stdout: "", stderr: 'Error: "system" is a reserved name (used for system coordinator addressing)' };
  }

  // Repo display name collision check
  if (coordinatorMode) {
    // For coordinator agents, check against OTHER repos' display names
    // (the ID IS the repo basename by design, which is the current repo)
    const otherRepos = repos.filter(r => r.path !== rootRepoPath);
    const collision = otherRepos.find(r => repoDisplayName(r) === id);
    if (collision) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent name "${id}" collides with registered repo name` };
    }
  } else {
    // For random agents (and a defensive re-check of named agents), check
    // against ALL repos' display names and basenames.
    const collision = repos.find(r => repoDisplayName(r) === id || r.name === id);
    if (collision) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent name "${id}" collides with registered repo name` };
    }
  }

  // Get repo-id for session naming
  const repoId = await getRepoId(rootRepoPath);
  const tmuxSession = `ittybitty-${repoId}-${id}`;

  // 10. Uniqueness check
  const agentDir = join(agentsDir, id);
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent '${id}' already exists` };
  }
  // Check tmux session
  const hasSessionResult = await newAgentSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]);
  if (hasSessionResult.exitCode === 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent '${id}' already exists` };
  }
  // Nickname collision: a new agent's id must not equal any existing agent's
  // nickname (symmetric with the nickname validator rejecting nickname == id).
  // The id-collision check above is filesystem/tmux-based per repo; nicknames
  // aren't directory names, so this needs a fresh GLOBAL readAllAgents scan.
  {
    const { agents: existingAgents } = await readAllAgents(
      repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })),
    );
    const nickCollision = existingAgents.find((a) => a.meta.nickname === id);
    if (nickCollision) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: agent name "${id}" collides with an existing agent nickname (${nickCollision.id})` };
    }
  }

  // 11. Create agent directory
  await mkdir(agentDir, { recursive: true });
  // The per-agent outbox now lives under the CENTRAL coordinator-home root
  // (so codex agents under `-s workspace-write` can write to other agents'
  // outboxes — see agentOutboxDir). mkdir it before the agent starts so the
  // first enqueue doesn't race a missing-dir append.
  await mkdir(agentOutboxDir(id), { recursive: true });

  // Prefer spawnedBy; fall back to --manager flag.
  // @-prefixed sentinels (e.g. @system, @<repo-name>) and null repo_path are
  // skipped here — the spawner is not a real agent directory we can log into,
  // so logSpawn writes only to the spawnee's log.
  const spawnerAgentDir: string | null =
    spawnedBy && spawnedBy.repo_path !== null && !spawnedBy.agent_id.startsWith("@")
      ? join(spawnedBy.repo_path, ".ittybitty", "agents", spawnedBy.agent_id)
      : manager
        ? join(agentsDir, manager)
        : null;

  // Working directory defaults to root repo
  let workPath = rootRepoPath;
  let codexExtraWritableRoots: string[] = [];

  // Compute fields needed for the early meta.json write below. These were
  // previously computed just before the late meta.json write (post worktree-add),
  // but slow worktree checkouts (60-90s on large repos) leave the agent dir
  // without meta.json — the dashboard's readAllAgents() then flags it as an
  // orphan. Writing meta.json with state='creating' before any slow step gives
  // the dashboard something to render and avoids the orphan-detection race.
  const sessionUuid = crypto.randomUUID();

  // Normalize and validate spawned_by repo_path before writing to meta.json.
  // Skip when repo_path is null — that path is reserved for the @system
  // sentinel whose spawner has no repo.
  if (spawnedBy && spawnedBy.repo_path !== null) {
    // Normalize: resolve symlinks so stored path matches registry's canonical form.
    // realpathSync resolves symlinks; resolve() only normalizes .. and trailing slashes.
    // Registry's addRepo stores resolve()-d paths, but the user may pass a symlinked path
    // via --spawned-by-repo. realpathSync ensures consistency.
    try {
      spawnedBy.repo_path = realpathSync(spawnedBy.repo_path);
    } catch {
      // Path doesn't exist yet — fall back to resolve() normalization
      spawnedBy.repo_path = resolve(spawnedBy.repo_path);
    }
  }

  // If spawned_by wasn't auto-detected and we have a same-repo manager,
  // set spawned_by to match the manager for consistency
  if (!spawnedBy && manager) {
    spawnedBy = {
      agent_id: manager,
      repo_path: rootRepoPath,
    };
  }

  // Resolve and normalize allowedPaths from agent type
  let resolvedAllowedPaths: string[] | undefined = undefined;
  if (agentTypeDef.allowedPaths !== undefined) {
    resolvedAllowedPaths = agentTypeDef.allowedPaths.map(p => {
      // Expand ~ to home directory
      let expanded: string;
      if (p === "~") {
        expanded = homedir();
      } else if (p.startsWith("~/")) {
        expanded = join(homedir(), p.slice(2));
      } else {
        expanded = p;
      }
      // Resolve to absolute path
      expanded = resolve(expanded);
      // Try to resolve symlinks, fall back to resolve() result if path doesn't exist
      try {
        return realpathSync(expanded);
      } catch {
        return expanded;
      }
    });
  }

  // Build the initial meta.json. Subsequent writes (start.sh setting claude_pid,
  // watchdog spawn setting watchdog_pid, generate-summary setting summary, the
  // post-worktree refresh below) all read-modify-write so they merge cleanly
  // with these fields.
  const createdAt = new Date();
  const initialMetaJson: Record<string, unknown> = {
    id,
    session_id: sessionUuid,
    tmux_session: tmuxSession,
    prompt,
    manager: manager || null,
    created: createdAt.toISOString(),
    created_epoch: Math.floor(createdAt.getTime() / 1000),
    worktree: useWorktree,
    worker: isLeafAgent,
    agentType: typeName,
    agentIcon: agentTypeDef.icon || undefined,
    yolo: yoloMode,
    model: model || null,
    spawned_by: spawnedBy ?? null,
    state: "creating",
    state_updated_at: Math.floor(createdAt.getTime() / 1000),
  };
  if (resolvedAllowedPaths !== undefined) {
    initialMetaJson.allowedPaths = resolvedAllowedPaths;
  }
  await timed("new-agent", "meta-write", () => writeMetaJsonAtomic(agentDir, initialMetaJson));

  // 12. Create git worktree if requested
  // Note: coordinator branch format retained for backward compatibility with
  // session-start.ts and health-check.ts, even though coordinators no longer use worktrees.
  const branchName = coordinatorMode ? `agent/${id}-${repoId}` : `agent/${id}`;

  // Centralised cleanup helper. Defined here (above the codex precheck and
  // every subsequent spawn-failure path) so the codex dispatcher precheck
  // can share the same exact unwind logic as later failures — see MED 2
  // from the Phase 4 review. Captures `agentDir`, `useWorktree`,
  // `rootRepoPath`, `branchName` by reference.
  async function cleanupOnFailure() {
    await rm(agentDir, { recursive: true, force: true });
    if (useWorktree) {
      await newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "worktree", "remove", join(agentDir, "repo"), "--force"]);
      await newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "branch", "-D", branchName]);
    }
  }

  const baseRefForLog = manager ? `agent/${manager}` : "HEAD";
  await logSpawn(
    agentDir,
    spawnerAgentDir,
    id,
    `start id=${id} repo=${rootRepoPath} worktree=${useWorktree} coordinator=${coordinatorMode} worker=${isLeafAgent} manager=${manager || "null"} baseRef=${useWorktree ? baseRefForLog : "n/a"}`,
  );
  if (useWorktree) {
    // Self-healing: discard stale worktree metadata pointing at paths that no longer exist.
    // The branch --list enumeration is independent of prune (prune cleans worktree refs;
    // branch --list reads the branch ref store), so run them concurrently.
    const [pruneResult, branchList] = await Promise.all([
      newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "worktree", "prune"]),
      newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "branch", "--list", branchName]),
    ]);
    await logSpawn(agentDir, spawnerAgentDir, id, `git worktree prune → exit=${pruneResult.exitCode}${pruneResult.exitCode !== 0 && pruneResult.stderr ? ` stderr="${pruneResult.stderr.trim()}"` : ""}`);

    // If a same-name branch lingers from a prior failed/killed spawn, drop it —
    // but only when no worktree is checked out on it. If a worktree holds the
    // branch, surface a clear error instead of silently failing later.
    const branchExists = branchList.stdout.trim().length > 0;
    await logSpawn(agentDir, spawnerAgentDir, id, `git branch --list ${branchName} → exit=${branchList.exitCode} exists=${branchExists}`);
    if (branchExists) {
      const worktreeList = await newAgentSpawnCtx.run([
        "git", "-C", rootRepoPath, "worktree", "list", "--porcelain",
      ]);
      // Anchor the match so `agent/foo` does not match inside `agent/foo-extra`.
      // Porcelain format places each `branch refs/heads/<name>` on its own line.
      const needle = `branch refs/heads/${branchName}`;
      const worktreeHoldsBranch =
        worktreeList.stdout.includes(needle + "\n") || worktreeList.stdout.endsWith(needle);
      await logSpawn(agentDir, spawnerAgentDir, id, `git worktree list → exit=${worktreeList.exitCode} holdsBranch=${worktreeHoldsBranch}`);
      if (worktreeHoldsBranch) {
        await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: branch ${branchName} is already checked out in another worktree`);
        await rm(agentDir, { recursive: true, force: true });
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `Error: branch ${branchName} is already checked out in another worktree`,
        };
      }
      const branchDelResult = await newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "branch", "-D", branchName]);
      await logSpawn(agentDir, spawnerAgentDir, id, `self-heal: deleted orphan branch ${branchName} → exit=${branchDelResult.exitCode}${branchDelResult.exitCode !== 0 && branchDelResult.stderr ? ` stderr="${branchDelResult.stderr.trim()}"` : ""}`);
    }

    // If <agentDir>/repo exists from an earlier aborted run, remove it so
    // `git worktree add` can create a fresh directory there.
    const repoPath = join(agentDir, "repo");
    const residualExisted = await stat(repoPath).then(() => true).catch(() => false);
    await rm(repoPath, { recursive: true, force: true });
    if (residualExisted) {
      await logSpawn(agentDir, spawnerAgentDir, id, `self-heal: removed residual repo dir ${repoPath}`);
    }

    const baseRef = manager ? `agent/${manager}` : "HEAD";
    // Bracket-log the slow worktree-add. On large repos this can take 60-90s,
    // and if the spawn process crashes or hangs, the LAST log line is what
    // tells us where it died. The "completes" line below logs after.
    await logSpawn(agentDir, spawnerAgentDir, id, `git worktree add starting: ${repoPath} -b ${branchName} ${baseRef}`);
    const worktreeResult = await timed("new-agent", "worktree-create", () =>
      newAgentSpawnCtx.run([
        "git", "-C", rootRepoPath, "worktree", "add", repoPath, "-b", branchName, baseRef,
      ])
    );
    await logSpawn(agentDir, spawnerAgentDir, id, `git worktree add ${repoPath} -b ${branchName} ${baseRef} → exit=${worktreeResult.exitCode}${worktreeResult.exitCode !== 0 && worktreeResult.stderr ? ` stderr="${worktreeResult.stderr.trim()}"` : ""}`);
    if (worktreeResult.exitCode !== 0) {
      const gitErr = worktreeResult.stderr.trim();
      await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: could not create worktree${gitErr ? `: ${gitErr}` : ""}`);
      await rm(agentDir, { recursive: true, force: true });
      const suffix = gitErr ? `: ${gitErr}` : "";
      return { ok: false, exitCode: 1, stdout: "", stderr: `Error: could not create worktree${suffix}` };
    }
    workPath = join(agentDir, "repo");

    if (agentCli === "codex") {
      // Codex agents do not launch with Claude settings; their hook
      // registration is inline via `-c` flags built in `buildCodexLaunchArgs`
      // (SPEC §3.3 + §5.4). The codex PreToolUse hook itself reads the shared
      // dynamic grant file at <worktree>/.claude/settings.local.json so ib
      // watch's permission-grant flow works for running agents. Per Phase 4:
      //   1. Append `.codex/` to <worktree>/.gitignore (covers any incidental
      //      files codex itself drops — hook logs, sentinels, scratch).
      //   2. Generate a per-agent <worktree>/AGENTS.md — codex reads this
      //      natively at session start (the codex analog of the claude
      //      session-start prompt injection).
      // Coordinator+codex was rejected up-front in the codex precondition
      // block above (SPEC §D9 stub) — both the system coordinator (handled
      // in coordinator.ts) and the per-repo coordinator (handled here in
      // newAgent) refuse codex models before any side-effects.
      const { appendCodexGitignoreEntry, writeCodexAgentsMd } = await import("./codex-spawn");
      const { detectRole } = await import("./hooks/session-start");
      try {
        const giResult = await appendCodexGitignoreEntry(workPath);
        if (giResult === "negation-respected") {
          // MED 3 from the Phase 4 review: user has an explicit `!.codex/`
          // negation — we deferred to their intent. Surface this so they know
          // codex's incidental files (hook logs, sentinels) may end up tracked.
          await logSpawn(
            agentDir,
            spawnerAgentDir,
            id,
            `codex .gitignore: explicit negation present (!.codex/ or !.codex); deferring — codex incidental files may be tracked.`,
          );
        }
      } catch (err) {
        await logSpawn(agentDir, spawnerAgentDir, id, `codex .gitignore append failed: ${(err as Error)?.message ?? String(err)}`);
      }
      const sessionCtx = detectRole(workPath, {
        id,
        manager: manager || null,
        worker: isLeafAgent,
        agentType: typeName,
        spawned_by: spawnedBy ?? undefined,
        allowedPaths: resolvedAllowedPaths,
      }, id);
      try {
        await writeCodexAgentsMd(workPath, sessionCtx);
      } catch (err) {
        await logSpawn(agentDir, spawnerAgentDir, id, `codex AGENTS.md write failed: ${(err as Error)?.message ?? String(err)}`);
      }

      const gitCommonDirResult = await newAgentSpawnCtx.run([
        "git", "-C", workPath, "rev-parse", "--git-common-dir",
      ]);
      if (gitCommonDirResult.exitCode !== 0 || !gitCommonDirResult.stdout.trim()) {
        const errMsg = gitCommonDirResult.stderr.trim() || `git rev-parse --git-common-dir failed with exit code ${gitCommonDirResult.exitCode}`;
        await logSpawn(
          agentDir,
          spawnerAgentDir,
          id,
          `spawn FAILED: could not resolve git common dir for codex writable root: ${errMsg}`,
        );
        await cleanupOnFailure();
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `Error: could not resolve git common dir for codex writable root: ${errMsg}`,
        };
      }
      codexExtraWritableRoots = [
        resolveGitRevParsePath(workPath, gitCommonDirResult.stdout),
      ];
      await logSpawn(
        agentDir,
        spawnerAgentDir,
        id,
        `codex writable git root: ${codexExtraWritableRoots[0]}`,
      );

      // Codex hook-dispatcher precheck (SPEC §5.4 step 7 + §5.5 fail-open
      // mitigation). Codex treats any non-zero hook exit as fail-open — if
      // our dispatcher is missing or its module-import throws at runtime,
      // every PreToolUse call would be allowed through. The `--dry-run`
      // flag returns exit 1 on failure so we can refuse the spawn before
      // creating the tmux session. On failure we reuse `cleanupOnFailure()`
      // (see MED 2 from the Phase 4 review) so any future cleanup additions
      // (e.g. tmux session kill) are inherited automatically.
      const codexPrecheckEvents = ["codex-pre-tool-use", "codex-session-start", "codex-stop"];
      for (const event of codexPrecheckEvents) {
        // Route through codexDryRunSpawnCtx with cwd=workPath so the dry-run
        // subprocess's process.cwd() lands inside the agent's worktree. The
        // hook handlers' resolveAgentContext / resolveAgentDir regex matches
        // `/\.ittybitty\/agents/` in cwd; without this, callers whose cwd is
        // outside any worktree (e.g. system coordinator at ~/.itsybitsy/repo)
        // would fall back to `<cwd>/.ittybitty/agents/<id>` and the dry-run
        // would fail with `meta.json not found`.
        const result = await codexDryRunSpawnCtx.run(
          [codexIbBinaryPath!, "hooks", event, id, "--dry-run"],
          workPath,
        );
        if (result.exitCode !== 0) {
          const errMsg = result.stderr.trim() || `dispatcher precheck failed with exit code ${result.exitCode}`;
          await logSpawn(
            agentDir,
            spawnerAgentDir,
            id,
            `spawn FAILED: codex dispatcher precheck failed for ${event}: ${errMsg}`,
          );
          await cleanupOnFailure();
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: `Error: codex dispatcher precheck failed (${event}): ${errMsg}`,
          };
        }
      }
    } else {
      // 13. Write settings.local.json (worktree mode only).
      // Coordinators force useWorktree=false above (SPEC §12.2.3), so we never
      // reach here in coordinator mode — only regular agents need settings here.
      await mkdir(join(agentDir, "repo", ".claude"), { recursive: true });
      const managerOrWorker: "manager" | "worker" = isLeafAgent ? "worker" : "manager";
      const settingsContent = await buildAgentSettings(rootRepoPath, managerOrWorker, id, configAllow, configDeny);
      await Bun.write(join(agentDir, "repo", ".claude", "settings.local.json"), settingsContent);
    }
  } else if (coordinatorMode) {
    // Per-repo coordinator: write settings (permissions + hooks) into the
    // coordinator's own agent dir, NOT the repo's .claude/settings.local.json.
    // Writing into the repo would pollute every non-coordinator Claude session
    // opened in that repo with coordinator-specific hooks.
    // The coordinator's claude process is launched with --settings pointing at
    // this file (see start.sh generation below).
    try {
      const coordSettings = await buildPerRepoCoordinatorSettings();
      const coordSettingsObj = {
        ...coordSettings,
        spinnerTipsEnabled: false,
        hooks: buildHooksBlock({
          agentId: id,
          includeStop: true,
          interceptMatcher: COORDINATOR_INTERCEPT_MATCHER,
          sessionStartIncludesAgentId: true,
        }),
      };
      await mkdir(join(agentDir, ".claude"), { recursive: true });
      await Bun.write(
        join(agentDir, ".claude", "settings.local.json"),
        JSON.stringify(coordSettingsObj, null, 2),
      );
    } catch { /* ignore */ }
  } else {
    // Non-worktree mode (non-coordinator): ensure ib permissions in root repo settings
    const rootSettingsPath = join(rootRepoPath, ".claude", "settings.local.json");
    try {
      const rootSettingsFile = Bun.file(rootSettingsPath);
      const settings = await rootSettingsFile.exists() ? await rootSettingsFile.json() : {};
      const allow = (settings?.permissions?.allow as string[]) ?? [];
      if (!allow.includes("Bash(ib:*)")) {
        allow.push("Bash(ib:*)");
      }
      settings.permissions = { ...settings.permissions, allow };
      await mkdir(join(rootRepoPath, ".claude"), { recursive: true });
      await Bun.write(rootSettingsPath, JSON.stringify(settings, null, 2));
    } catch { /* ignore */ }
  }

  // 14. meta.json was written early (before mkdir worktree) so the dashboard
  // does not flag the in-progress agent dir as orphaned during a slow
  // git worktree add. See the "Compute fields needed for the early meta.json
  // write" block above. Subsequent writers (start.sh → claude_pid, watchdog
  // spawn → watchdog_pid, generate-summary → summary, hook-status → state)
  // do read-modify-write so they merge cleanly with the early fields.

  // Log agent creation
  if (manager) {
    await logAgent(agentDir, `Agent created (manager: ${manager}, prompt: ${prompt})`);
    const managerDir = join(agentsDir, manager);
    await logAgent(managerDir, `Spawned ${typeName} subagent: ${id} (prompt: ${prompt})`);
  } else {
    await logAgent(agentDir, `Agent created (prompt: ${prompt})`);
  }

  // 16. Build prompt.txt
  const createPRs = config.createPullRequests?.value === true;
  let completionInstructions = "";

  if (useWorktree && !isLeafAgent) {
    // Check for gh and remote — independent probes, run concurrently
    const [hasGhResult, hasRemoteResult] = await Promise.all([
      newAgentSpawnCtx.run(["which", "gh"]),
      newAgentSpawnCtx.run(["git", "-C", rootRepoPath, "remote"]),
    ]);
    const hasGh = hasGhResult.exitCode === 0;
    const hasRemote = hasRemoteResult.stdout.trim().length > 0;

    if (createPRs && hasGh && hasRemote) {
      completionInstructions = `\nWhen completing: after merging all sub-agents, create a pull request with \`gh pr create --title "<title>" --body "<description>"\`.`;
    }
  } else if (!useWorktree) {
    completionInstructions = `You are running as agent ${id} in the main repository (no worktree).
When your task is complete:
1. Commit any changes you made (git add && git commit)
2. Exit normally`;
  }

  // Custom prompts
  let customAllPrompt = "";
  if (customPrompts.all) {
    customAllPrompt = `[CUSTOM INSTRUCTIONS]\n${customPrompts.all}\n\n`;
  }

  // Custom role prompts are keyed by spawn capability: leaf agents (canSpawnChildren=false)
  // get worker prompts, non-leaf agents get manager prompts — regardless of custom type name
  let customRolePrompt = "";
  if (isLeafAgent && customPrompts.worker) {
    customRolePrompt = `[CUSTOM WORKER INSTRUCTIONS]\n${customPrompts.worker}\n\n`;
  } else if (!isLeafAgent && customPrompts.manager) {
    customRolePrompt = `[CUSTOM MANAGER INSTRUCTIONS]\n${customPrompts.manager}\n\n`;
  }

  const promptPrefix = `${completionInstructions ? completionInstructions + "\n" : ""}${customAllPrompt}${customRolePrompt}${prompt}`;

  const promptFile = join(agentDir, "prompt.txt");
  await Bun.write(promptFile, promptPrefix);

  // Build claude args
  let claudeArgs = "";
  if (yoloMode) {
    claudeArgs = "--dangerously-skip-permissions --permission-mode bypassPermissions";
  }
  if (printMode) {
    claudeArgs = claudeArgs ? `${claudeArgs} --print` : "--print";
  }
  if (allowTools) {
    claudeArgs = claudeArgs ? `${claudeArgs} --allowedTools ${allowTools}` : `--allowedTools ${allowTools}`;
  }
  if (denyTools) {
    claudeArgs = claudeArgs ? `${claudeArgs} --disallowedTools ${denyTools}` : `--disallowedTools ${denyTools}`;
  }
  if (modelFlagValue) {
    claudeArgs = claudeArgs ? `${claudeArgs} --model ${modelFlagValue}` : `--model ${modelFlagValue}`;
  }
  if (coordinatorMode) {
    // Load permissions + hooks from the coordinator's isolated settings file
    // so they don't pollute the repo's .claude/settings.local.json.
    const coordSettingsArg = shellQuote(join(agentDir, ".claude", "settings.local.json"));
    claudeArgs = claudeArgs ? `${claudeArgs} --settings ${coordSettingsArg}` : `--settings ${coordSettingsArg}`;
  }

  // 16. Write exit-check.sh
  const exitScript = join(agentDir, "exit-check.sh");
  const exitCheckContent = `#!/bin/bash
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Agent session ended - checking for uncommitted work..."
echo "═══════════════════════════════════════════════════════════"

# Check for uncommitted changes
if [[ -n $(git status --porcelain 2>/dev/null) ]]; then
    echo ""
    echo "⚠️  UNCOMMITTED CHANGES DETECTED"
    echo ""
    git status --short
    echo ""
    read -p "Commit these changes? [y/N] " commit_confirm
    if [[ "$commit_confirm" == [yY] || "$commit_confirm" == [yY][eE][sS] ]]; then
        read -p "Commit message: " commit_msg
        if [[ -n "$commit_msg" ]]; then
            git add -A && git commit -m "$commit_msg"
        else
            echo "No message provided, skipping commit."
        fi
    fi
fi

# Check for unpushed commits (only if remote exists)
if git remote | grep -q .; then
    local_commits=$(git log @{u}..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$local_commits" -gt 0 ]]; then
        echo ""
        echo "⚠️  UNPUSHED COMMITS: $local_commits commit(s) not pushed to remote"
        echo ""
        git log @{u}..HEAD --oneline
        echo ""
        read -p "Push to remote? [y/N] " push_confirm
        if [[ "$push_confirm" == [yY] || "$push_confirm" == [yY][eE][sS] ]]; then
            git push
        fi
    fi
fi

echo ""
echo "Agent session complete. Branch: $(git branch --show-current)"
echo "To merge this work: git checkout main && git merge $(git branch --show-current)"
echo ""
`;
  await Bun.write(exitScript, exitCheckContent);
  await chmod(exitScript, 0o755);

  // Write start.sh
  const absPromptFile = join(agentDir, "prompt.txt");
  const absExitScript = join(agentDir, "exit-check.sh");
  const startScript = join(agentDir, "start.sh");

  const qAbsPromptFile = shellQuote(absPromptFile);
  const qStartMetaJson = shellQuote(join(agentDir, "meta.json"));
  const qStartExitScript = shellQuote(absExitScript);
  const qStartAgentLog = shellQuote(join(agentDir, "agent.log"));
  const qStartStderrLog = shellQuote(join(agentDir, "claude.stderr.log"));

  let startContent: string;
  if (agentCli === "codex") {
    // Codex spawn branch — SPEC §6 Phase 4. The launch line is the canonical
    // §3.3 form: `codex -m <model> -a never -s workspace-write
    // --dangerously-bypass-hook-trust <inline -c flags> "<prompt>"`. The
    // path-safety + dispatcher precheck guarantees ran above (we wouldn't
    // be here on failure). PID variable + meta-field stay `CLAUDE_PID` /
    // `claude_pid` so the watchdog and other readers don't break — renaming
    // is its own follow-up.
    const { buildCodexStartContent } = await import("./codex-spawn");
    startContent = buildCodexStartContent({
      agentId: id,
      ibBinaryPath: codexIbBinaryPath!,
      agentDir,
      codexModel: modelFlagValue,
      absPromptFile,
      absMetaJson: join(agentDir, "meta.json"),
      absExitScript,
      absAgentLog: join(agentDir, "agent.log"),
      absStderrLog: join(agentDir, "claude.stderr.log"),
      extraWritableRoots: codexExtraWritableRoots,
    });
  } else {
    startContent = `#!/bin/bash
# Clear Claude Code nesting detection so agents can start their own claude process
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

AGENT_LOG=${qStartAgentLog}
STDERR_LOG=${qStartStderrLog}
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start.sh] $1" >> "$AGENT_LOG"; }

log "Starting claude --session-id ${sessionUuid} ${claudeArgs}"
log "PWD=$(pwd) which_claude=$(which claude 2>&1)"

# Ignore SIGHUP for the lifetime of this script. When spawn is triggered from
# inside another tmux pane (the ib-coordinator, another agent, or a watchdog
# spawned from one), that launcher pane's pty can deliver a SIGHUP to this fresh
# process group as it churns/redraws/closes. The old kill-on-HUP trap turned that
# stray signal into an exit-129 crash. SIG_IGN is inherited by the claude child,
# so this protects both halves. setsid (below) is the belt to this suspenders —
# it gives claude its own session so the pty SIGHUP can't reach it at all, but
# the trap stands alone on hosts where setsid is unavailable.
trap '' HUP
log "SIGHUP ignored (spawn insulated from launcher pane teardown)"

# Start Claude in background and capture PID. Stderr is redirected to a sidecar
# file so we can tail it into agent.log on exit (helps diagnose crashes / 429s).
# Launch under setsid when present so claude leads its own session, fully
# detached from the launcher's controlling terminal. setsid execs in place
# (no fork) when it is not already a process-group leader — which holds here:
# this script runs non-interactively with job control off (no \`set -m\`), so the
# backgrounded setsid stays in the script's process group rather than leading
# its own. So \$! still refers to claude and wait/kill behave identically to the
# bare launch. Fall back to a plain background launch on hosts lacking setsid
# (e.g. macOS, where setsid is absent — the inherited SIG_IGN above covers it).
: > "$STDERR_LOG"
if command -v setsid >/dev/null 2>&1; then
    SETSID=setsid
else
    SETSID=none
fi
if [[ "$SETSID" == "setsid" ]]; then
    setsid claude --session-id "${sessionUuid}" ${claudeArgs} "$(cat ${qAbsPromptFile})" 2> "$STDERR_LOG" &
else
    claude --session-id "${sessionUuid}" ${claudeArgs} "$(cat ${qAbsPromptFile})" 2> "$STDERR_LOG" &
fi
CLAUDE_PID=$!
log "Claude PID: $CLAUDE_PID (setsid=$SETSID)"
trap 'log "script received SIGTERM; sending SIGTERM to Claude PID=$CLAUDE_PID"; kill $CLAUDE_PID 2>/dev/null' TERM
trap 'log "script received SIGINT; sending SIGINT to Claude PID=$CLAUDE_PID"; kill -INT $CLAUDE_PID 2>/dev/null' INT

# Store PID in meta.json — route through "ib write-pid" which uses
# mutateAgentMeta + the meta-lock so the write does not lose a concurrent
# mutation (e.g. the watchdog setting watchdog_pid). The naive inline
# bun -e read-modify-write it replaces had a real lost-write race window
# whose symptom is benign on claude today but matters symmetrically with
# the codex side (HIGH 2 from the Phase 4 review).
META_JSON=${qStartMetaJson}
if [[ -f "$META_JSON" ]]; then
    ib write-pid ${shellQuote(id)} "$CLAUDE_PID" || log "write-pid failed (exit=$?); meta.json claude_pid not set"
fi

# Wait for Claude to complete
wait $CLAUDE_PID
EXIT_CODE=$?
SIGNAL=$(kill -l $EXIT_CODE 2>/dev/null || echo "none")
log "Claude exited: code=$EXIT_CODE signal=$SIGNAL"

# Annotate common exit codes so the cause is obvious in agent.log.
case $EXIT_CODE in
    0)   log "exit=0 → clean exit" ;;
    1)   log "exit=1 → generic claude error (check stderr tail below)" ;;
    2)   log "exit=2 → claude usage / argument error" ;;
    127) log "exit=127 → command not found ('claude' missing from PATH?)" ;;
    129) log "exit=129 → SIGHUP (tmux pane closed or controlling terminal lost)" ;;
    130) log "exit=130 → SIGINT (Ctrl-C)" ;;
    137) log "exit=137 → SIGKILL (likely OOM kill or 'kill -9'; check Console.app for 'low memory')" ;;
    139) log "exit=139 → SIGSEGV (claude segfault)" ;;
    143) log "exit=143 → SIGTERM (graceful kill, e.g. ib kill / pause)" ;;
    *)   log "exit=$EXIT_CODE → unrecognized; SIGNAL=$SIGNAL" ;;
esac

# If Claude exited non-cleanly and wrote anything to stderr, dump the tail into
# agent.log so the post-mortem doesn't depend on the (now-dying) tmux pane.
if [[ "$EXIT_CODE" -ne 0 && -s "$STDERR_LOG" ]]; then
    log "── claude stderr (last 50 lines) ──"
    tail -n 50 "$STDERR_LOG" >> "$AGENT_LOG"
    log "── end claude stderr ──"
fi

# Run exit check
${qStartExitScript}
`;
  }
  await Bun.write(startScript, startContent);
  await chmod(startScript, 0o755);

  // 17. Init agent.log (already done via logAgent above)
  // 18. Ensure tmux server is running
  const startServerResult = await timed("new-agent", "tmux-start-server", () =>
    newAgentSpawnCtx.run(["tmux", "start-server"])
  );
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux start-server → exit=${startServerResult.exitCode}${startServerResult.exitCode !== 0 && startServerResult.stderr ? ` stderr="${startServerResult.stderr.trim()}"` : ""}`);
  if (startServerResult.exitCode !== 0) {
    const err = startServerResult.stderr.trim();
    await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: could not start tmux server${err ? `: ${err}` : ""}`);
    await cleanupOnFailure();
    const suffix = err ? `: ${err}` : "";
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: could not start tmux server${suffix}` };
  }

  // Start tmux session — use saved layout width so it matches the dashboard pane.
  // Coordinators (system + per-repo) span middle+right and use mainWidth; regular
  // agents use the middle-pane width. The helper picks the right one.
  const absStartScript = join(agentDir, "start.sh");
  const newTmuxWidth = await getTmuxWidthForAgent(coordinatorMode);
  // Bracket-log the tmux session creation so a hang here is identifiable from
  // the agent.log alone (the "starting" line is the last entry on hang).
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux new-session starting: -s ${tmuxSession} -x ${newTmuxWidth}`);
  const tmuxResult = await timed("new-agent", "tmux-spawn", () =>
    newAgentSpawnCtx.run([
      "tmux", "new-session", "-d", "-x", String(newTmuxWidth), "-s", tmuxSession, "-c", workPath, shellQuote(absStartScript),
    ])
  );
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux new-session -s ${tmuxSession} -x ${newTmuxWidth} → exit=${tmuxResult.exitCode}${tmuxResult.exitCode !== 0 && tmuxResult.stderr ? ` stderr="${tmuxResult.stderr.trim()}"` : ""}`);
  if (tmuxResult.exitCode !== 0) {
    const err = tmuxResult.stderr.trim();
    await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: could not create tmux session '${tmuxSession}'${err ? `: ${err}` : ""}`);
    await cleanupOnFailure();
    const suffix = err ? `: ${err}` : "";
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: could not create tmux session '${tmuxSession}'${suffix}` };
  }
  // The two set-option calls, the pane-died hook, and the has-session verify
  // all depend on the session existing (above), but are independent of each
  // other — run together. The pane-died hook fires on every pane termination
  // (graceful or otherwise) and acts as a backstop for the case where the
  // bash wrapper itself dies before reaching its exit-log line. On normal
  // shutdowns it produces a redundant log line next to start.sh's "Claude
  // exited" — that's expected, not a sign of trouble.
  //
  // No timestamp is included in the message — the previous log line in
  // agent.log carries one, and embedding $(date) inside tmux's run-shell
  // argument requires fragile double-escaping. tmux only expands #{...}
  // format strings inside the run-shell body; the echo'd literal goes
  // straight to sh -c. agentDir is constrained by isValidShellPath so
  // shellQuote's single-quote wrapping is safe inside tmux's double quotes.
  const paneDiedHook = `run-shell "echo '[tmux pane-died] session=#{session_name} pane_dead_status=#{pane_dead_status} pane_dead_signal=#{pane_dead_signal}' >> ${shellQuote(join(agentDir, "agent.log"))}"`;
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux has-session verify starting: -t ${tmuxSession}`);
  const [, , , , verifyResult] = await Promise.all([
    newAgentSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "history-limit", "50000"]),
    newAgentSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "remain-on-exit", "on"]),
    // window-size manual prevents tmux from auto-resizing the window to the
    // latest attached client's terminal size. The dashboard sizes the session
    // to the saved pane width; the default ("latest") would silently shrink
    // it back when other clients attach/detach.
    newAgentSpawnCtx.run(["tmux", "set-option", "-w", "-t", tmuxSession, "window-size", "manual"]),
    newAgentSpawnCtx.run(["tmux", "set-hook", "-t", tmuxSession, "pane-died", paneDiedHook]),
    // 19. Verify tmux session created
    newAgentSpawnCtx.run(["tmux", "has-session", "-t", tmuxSession]),
  ]);
  await logSpawn(agentDir, spawnerAgentDir, id, `tmux has-session verify → exit=${verifyResult.exitCode}`);
  if (verifyResult.exitCode !== 0) {
    const err = verifyResult.stderr.trim();
    await logSpawn(agentDir, spawnerAgentDir, id, `spawn FAILED: tmux session '${tmuxSession}' failed to start${err ? `: ${err}` : ""}`);
    await cleanupOnFailure();
    const suffix = err ? `: ${err}` : "";
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: tmux session '${tmuxSession}' failed to start${suffix}` };
  }

  await logSpawn(agentDir, spawnerAgentDir, id, `spawn OK: agent ${id} running (tmux=${tmuxSession} workPath=${workPath})`);

  // 20. Output agent ID
  const stdout = id;

  // 21. Auto-accept workspace trust (if not yolo) — in background
  if (!yoloMode) {
    // Run async without awaiting — fire and forget
    autoAcceptWorkspaceTrustForNewAgent(tmuxSession).catch(() => {});
  }

  // 22. Auto-spawn per-agent watchdog
  await timed("new-agent", "watchdog-spawn", async () => {
    try {
      const watchdogLog = join(agentDir, "watchdog.log");
      let watchdogPid: number | undefined;

      if (watchdogSpawnOverride) {
        const result = watchdogSpawnOverride(id, rootRepoPath, watchdogLog);
        watchdogPid = result?.pid;
      } else {
        const watchdogProc = Bun.spawn(["ib", "watchdog", id], {
          cwd: rootRepoPath,
          stdout: Bun.file(watchdogLog),
          stderr: Bun.file(watchdogLog),
        });
        watchdogProc.unref();
        watchdogPid = watchdogProc.pid;
      }

      if (watchdogPid !== undefined) {
        const metaPath = join(agentDir, "meta.json");
        const metaContent = await Bun.file(metaPath).json().catch(() => null);
        if (metaContent) {
          metaContent.watchdog_pid = watchdogPid;
          await Bun.write(metaPath, JSON.stringify(metaContent, null, 2));
        }
        await logSpawn(agentDir, spawnerAgentDir, id, `watchdog spawned pid=${watchdogPid}`);
      }
    } catch (err) {
      await logSpawn(agentDir, spawnerAgentDir, id, `watchdog spawn failed: ${(err as Error)?.message ?? String(err)}`);
    }
  });

  // 23. Generate prompt summary in background (fire-and-forget)
  generatePromptSummary(agentDir).catch(() => {});

  logToWatchLog(
    `[spawn] agent=${id} type=${typeName} cli=${agentCli} model=${modelFlagValue ?? "<default>"} ` +
    `tmux=${tmuxSession} repo=${rootRepoPath}`
  );

  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

/**
 * Spawn a detached subprocess to generate the prompt summary.
 * Uses the same pattern as the watchdog spawn (line ~1794): `ib generate-summary`
 * runs as a standalone subcommand so it survives after the parent calls process.exit().
 *
 * In test mode, calls a test override directly so tests can verify behavior
 * without a real subprocess.
 */
async function generatePromptSummary(agentDir: string): Promise<void> {
  // Test mode: call the override directly so tests can verify via mock
  if (summaryGeneratorOverride) {
    await summaryGeneratorOverride(agentDir);
    return;
  }

  // Production: spawn detached subprocess (survives parent process.exit())
  const proc = Bun.spawn(["ib", "generate-summary", agentDir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
}

/** Override for testing — set via setNewAgentSummaryGenerator / resetNewAgentSummaryGenerator */
let summaryGeneratorOverride: ((agentDir: string) => Promise<void>) | null = null;

/** Override the summary generator for testing. */
export function setNewAgentSummaryGenerator(fn: (agentDir: string) => Promise<void>): void {
  summaryGeneratorOverride = fn;
}

/** Reset the summary generator override. */
export function resetNewAgentSummaryGenerator(): void {
  summaryGeneratorOverride = null;
}

/**
 * Auto-accept workspace trust for newly created agents.
 * Uses the newAgent spawn runner for testability.
 */
async function autoAcceptWorkspaceTrustForNewAgent(tmuxSession: string): Promise<void> {
  const maxAttempts = 5;
  const maxWaitHalfSecs = 30;

  let startedWith = "";
  for (let i = 0; i < maxWaitHalfSecs; i++) {
    const delayMs = newAgentDelayOverrideMs !== null ? newAgentDelayOverrideMs : 500;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await newAgentSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const output = captureResult.stdout;
    if (output.includes("Claude Code v") || output.includes("[USER TASK]")) {
      startedWith = "logo";
      break;
    }
    if (/enter to confirm/i.test(output)) {
      if (
        /trust/i.test(output) ||
        /Allow external CLAUDE\.md file imports/i.test(output) ||
        /New MCP server found/i.test(output) ||
        /\d+ new MCP servers? found/i.test(output)
      ) {
        startedWith = "permissions";
        break;
      }
    }
  }

  if (startedWith !== "permissions") return;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await newAgentSpawnCtx.run(["tmux", "send-keys", "-t", tmuxSession, "Enter"]);

    const delayMs = newAgentDelayOverrideMs !== null ? newAgentDelayOverrideMs : 4000;
    if (delayMs > 0) await Bun.sleep(delayMs);

    const captureResult = await newAgentSpawnCtx.run([
      "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
    ]);
    if (captureResult.exitCode !== 0) continue;

    const recent = captureResult.stdout;
    let hasPermissions = false;
    if (/enter to confirm/i.test(recent)) {
      if (
        /trust/i.test(recent) ||
        /Allow external CLAUDE\.md file imports/i.test(recent) ||
        /New MCP server found/i.test(recent) ||
        /\d+ new MCP servers? found/i.test(recent)
      ) {
        hasPermissions = true;
      }
    }

    if (!hasPermissions) {
      for (let j = 0; j < maxWaitHalfSecs; j++) {
        const logoDelay = newAgentDelayOverrideMs !== null ? newAgentDelayOverrideMs : 500;
        if (logoDelay > 0) await Bun.sleep(logoDelay);

        const logoCapture = await newAgentSpawnCtx.run([
          "tmux", "capture-pane", "-t", tmuxSession, "-p", "-S", "-",
        ]);
        if (logoCapture.exitCode !== 0) continue;
        if (logoCapture.stdout.includes("Claude Code v") || logoCapture.stdout.includes("[USER TASK]")) {
          return;
        }
      }
    }
  }
}

/** Result of resolveAgentId */
export type ResolveAgentResult =
  | { resolved: string }
  | { error: string; matches: string[] };

/** Extract agent ID from a tmux session name (format: ittybitty-<repoid>-<agentid>) */
function extractAgentIdFromTmuxSession(sessionName: string): string | null {
  if (!sessionName.startsWith("ittybitty-")) return null;
  // Format: ittybitty-<8hexchars>-<agentid>
  // repoId is always exactly 8 hex characters (4 random bytes)
  const match = sessionName.match(/^ittybitty-[a-f0-9]{8}-(.+)$/);
  return match ? match[1]! : null;
}

/**
 * Resolve a partial agent ID to a full ID.
 * Mirrors resolve_agent_id() in ib bash.
 * Scans both agent directories and tmux sessions.
 *
 * @param tmuxLister - injectable for testing; defaults to listTmuxSessions
 */
export async function resolveAgentId(
  agentsDir: string,
  partial: string,
  tmuxLister: () => Promise<string[]> = listTmuxSessions,
): Promise<ResolveAgentResult> {
  // Exact match: check directory
  const exactDir = join(agentsDir, partial);
  if (await Bun.file(join(exactDir, "meta.json")).exists().catch(() => false)) {
    return { resolved: partial };
  }

  // Exact match: check tmux sessions for ittybitty-*-<partial>
  const sessions = await tmuxLister();
  for (const session of sessions) {
    const agentId = extractAgentIdFromTmuxSession(session);
    if (agentId === partial) {
      return { resolved: partial };
    }
  }

  // Partial/substring match: scan directories
  const matches = new Set<string>();
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.includes(partial)) {
        matches.add(entry.name);
      }
    }
  } catch { /* ignore */ }

  // Partial/substring match: scan tmux sessions
  for (const session of sessions) {
    if (!session.startsWith("ittybitty-")) continue;
    const agentId = extractAgentIdFromTmuxSession(session);
    if (agentId && agentId.includes(partial)) {
      matches.add(agentId);
    }
  }

  if (matches.size === 1) return { resolved: [...matches][0]! };
  if (matches.size === 0) return { error: "No matching agent found", matches: [] };
  return { error: "Ambiguous agent ID — multiple matches", matches: [...matches].sort() };
}

/** Pluggable spawn runner for diff/status — defaults to Bun.spawn, overridable for tests */
/** Spawn context for diff/status operations */
export const diffStatusSpawnCtx = new SpawnContext();

/** Override the diff/status spawn runner (for testing) */
export function setDiffStatusSpawnRunner(runner: SpawnFn): void {
  diffStatusSpawnCtx.set(runner);
}

/** Reset the diff/status spawn runner */
export function resetDiffStatusSpawnRunner(): void {
  diffStatusSpawnCtx.reset();
}

/**
 * Native diff implementation — replaces `ib diff <id>`.
 * Runs git merge-base HEAD main, then git diff <merge-base> in the agent worktree.
 */
export async function diffAgent(agent: Agent, opts?: { stat?: boolean }): Promise<IbCommandResult> {
  const worktreePath = join(agent.repoPath, ".ittybitty", "agents", agent.id, "repo");
  try {
    await readdir(worktreePath);
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has no worktree` };
  }

  const parentBranch = agent.meta.manager ? `agent/${agent.meta.manager}` : "main";
  const agentBranch = `agent/${agent.id}`;

  const mergeBase = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "merge-base", parentBranch, agentBranch]);
  if (mergeBase.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to find merge-base between ${parentBranch} and ${agentBranch}: ${mergeBase.stderr}` };
  }

  const diffCmd = opts?.stat
    ? ["git", "-C", worktreePath, "diff", "--stat", `${mergeBase.stdout}..${agentBranch}`]
    : ["git", "-C", worktreePath, "diff", `${mergeBase.stdout}..${agentBranch}`];
  const diff = await diffStatusSpawnCtx.run(diffCmd);
  return { ok: diff.exitCode === 0, exitCode: diff.exitCode, stdout: diff.stdout, stderr: diff.stderr };
}

/**
 * Diff the current working directory's branch against its merge-base.
 * Used when `ib diff` is run without an agent ID and outside an agent worktree.
 * Finds the merge-base of HEAD vs the default branch (main/master) and diffs against it.
 */
export async function diffCwd(opts?: { stat?: boolean }): Promise<IbCommandResult> {
  const cwd = process.cwd();

  // Determine the default branch (try main, then master)
  const symbolicRef = await diffStatusSpawnCtx.run(["git", "-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"]);
  let baseBranch = "main";
  if (symbolicRef.exitCode === 0 && symbolicRef.stdout) {
    const ref = symbolicRef.stdout.replace("refs/remotes/origin/", "");
    if (ref) baseBranch = ref;
  }

  // Get the current branch
  const headRef = await diffStatusSpawnCtx.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (headRef.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to determine current branch: ${headRef.stderr}` };
  }
  const currentBranch = headRef.stdout;

  // Find merge-base
  const mergeBase = await diffStatusSpawnCtx.run(["git", "-C", cwd, "merge-base", baseBranch, currentBranch]);
  if (mergeBase.exitCode !== 0) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to find merge-base between ${baseBranch} and ${currentBranch}: ${mergeBase.stderr}` };
  }

  const diffCmd = opts?.stat
    ? ["git", "-C", cwd, "diff", "--stat", `${mergeBase.stdout}..HEAD`]
    : ["git", "-C", cwd, "diff", `${mergeBase.stdout}..HEAD`];
  const diff = await diffStatusSpawnCtx.run(diffCmd);
  return { ok: diff.exitCode === 0, exitCode: diff.exitCode, stdout: diff.stdout, stderr: diff.stderr };
}

/**
 * Native status implementation — replaces `ib status <id>`.
 * Shows header, commits vs parent branch, uncommitted changes, and file change summary.
 */
export async function statusAgent(agent: Agent): Promise<IbCommandResult> {
  const worktreePath = join(agent.repoPath, ".ittybitty", "agents", agent.id, "repo");
  try {
    await readdir(worktreePath);
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' has no worktree` };
  }

  const agentBranch = `agent/${agent.id}`;
  const parentBranch = agent.meta.manager ? `agent/${agent.meta.manager}` : "main";
  const parts: string[] = [];

  // Header
  parts.push(`Agent: ${agent.id}`);
  parts.push(`Branch: ${agentBranch}`);
  parts.push(`Worktree: ${worktreePath}`);
  parts.push("");

  // Get merge-base
  const mb = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "merge-base", parentBranch, agentBranch]);
  if (mb.exitCode === 0 && mb.stdout) {
    // Commits
    const log = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "log", "--oneline", `${mb.stdout}..${agentBranch}`]);
    const commitLines = log.stdout ? log.stdout.split("\n") : [];
    const commitCount = commitLines.length;
    if (commitCount > 0) {
      parts.push(`═══ Commits (${commitCount}) vs ${parentBranch} ═══`);
      const formatted = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "log", "--format=  %h %s", `${mb.stdout}..${agentBranch}`]);
      if (formatted.stdout) parts.push(formatted.stdout);
      parts.push("");
    } else {
      parts.push(`═══ No commits vs ${parentBranch} ═══`);
      parts.push("");
    }
  }

  // Uncommitted changes
  const porcelain = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "status", "--porcelain"]);
  if (porcelain.stdout) {
    parts.push("═══ Uncommitted Changes ═══");
    const short = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "status", "--short"]);
    if (short.stdout) parts.push(short.stdout);
    parts.push("");
  }

  // File change summary
  if (mb.exitCode === 0 && mb.stdout) {
    const stat = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "diff", "--stat", `${mb.stdout}..${agentBranch}`]);
    if (stat.stdout) {
      const statLines = stat.stdout.split("\n");
      const summaryLine = statLines[statLines.length - 1]?.trim() ?? "";
      if (summaryLine && !summaryLine.includes("0 files changed")) {
        parts.push("═══ Files Changed ═══");
        parts.push(`  ${summaryLine}`);

        // Per-file details: numstat for line counts, name-status for status labels
        // Use a single combined call isn't possible, so run both with consistent filters
        const numstatResult = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "diff", "--numstat", "-M", `${mb.stdout}..${agentBranch}`]);
        const fileStats = new Map<string, { added: string; deleted: string }>();
        if (numstatResult.stdout) {
          for (const line of numstatResult.stdout.split("\n")) {
            if (!line.trim()) continue;
            // numstat format: <added>\t<deleted>\t<file>
            // For renames with -M: <added>\t<deleted>\t<old>{...=> ...}<new>
            const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
            if (match) {
              let filename = match[3]!;
              // Handle rename format: old/path/{old.ts => new.ts} or {old.ts => new.ts}
              const renameMatch = filename.match(/^(.*?)\{.+ => (.+?)\}(.*)$/);
              if (renameMatch) {
                filename = renameMatch[1]! + renameMatch[2]! + renameMatch[3]!;
              }
              fileStats.set(filename, { added: match[1]!, deleted: match[2]! });
            }
          }
        }

        const nameStatusResult = await diffStatusSpawnCtx.run(["git", "-C", worktreePath, "diff", "--name-status", "-M", `${mb.stdout}..${agentBranch}`]);
        const statusLabels = new Map<string, string>();
        if (nameStatusResult.stdout) {
          for (const line of nameStatusResult.stdout.split("\n")) {
            if (!line.trim()) continue;
            // name-status format: <code>[score]\t<file> or <code>[score]\t<old>\t<new>
            const renameMatch = line.match(/^[RC]\d*\t.+?\t(.+)$/);
            if (renameMatch) {
              statusLabels.set(renameMatch[1]!, line[0] === "R" ? "renamed" : "copied");
              continue;
            }
            const match = line.match(/^([ADMT])\d*\t(.+)$/);
            if (match) {
              const code = match[1]!;
              const label = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
              statusLabels.set(match[2]!, label);
            }
          }
        }

        if (fileStats.size > 0) {
          parts.push("");
          const files = [...fileStats.keys()].sort();
          const maxFileLen = Math.max(...files.map(f => f.length));
          for (const file of files) {
            const nums = fileStats.get(file)!;
            const label = statusLabels.get(file) ?? "modified";
            const added = nums.added !== "-" && nums.added !== "0" ? `+${nums.added}` : "";
            const deleted = nums.deleted !== "-" && nums.deleted !== "0" ? `-${nums.deleted}` : "";
            const counts = [added, deleted].filter(Boolean).join("/");
            const paddedFile = counts ? file.padEnd(maxFileLen) : file;
            parts.push(`  ${label.padEnd(8)} ${paddedFile}${counts ? ` (${counts})` : ""}`);
          }
        }
      }
    }
  }

  return { ok: true, exitCode: 0, stdout: parts.join("\n"), stderr: "" };
}

/**
 * Native pause implementation — replaces `ib pause <id>`.
 *
 * Sequence (mirrors cmd_pause in ib bash):
 * 1. Verify agent directory exists
 * 2. Kill Claude process (killAgentProcess)
 * 3. Kill tmux session
 * 4. Log 'Agent paused' to agent.log
 * Does NOT archive, remove worktree, or delete directory.
 */
export async function pauseAgent(agent: Agent): Promise<IbCommandResult> {
  const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);
  const tmuxSession = agent.meta.tmux_session;

  // Check if agent directory exists
  const dirExists = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);
  if (!dirExists) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' not found` };
  }

  // Check if agent is already stopped (mirrors bash cmd_pause validation)
  if (agent.state === "stopped") {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is already stopped` };
  }

  // Kill Claude process
  await logAgent(agentDir, `Pausing agent (state=${agent.state}, pid=${agent.meta.claude_pid ?? "none"}, tmux=${tmuxSession ?? "none"})`);
  const killed = await killAgentProcess(tmuxSession, { claude_pid: agent.meta.claude_pid });
  if (killed) {
    await logAgent(agentDir, "Terminated Claude process");
  } else {
    await logAgent(agentDir, "Claude process not running");
  }

  // Kill tmux session
  if (tmuxSession) {
    const proc = killPauseSpawnCtx.runner(
      ["tmux", "has-session", "-t", tmuxSession],
      { stdout: "pipe", stderr: "pipe" }
    );
    await new Response(proc.stderr).text(); // drain
    const hasSession = (await proc.exited) === 0;
    if (hasSession) {
      const killProc = killPauseSpawnCtx.runner(
        ["tmux", "kill-session", "-t", tmuxSession],
        { stdout: "pipe", stderr: "pipe" }
      );
      await new Response(killProc.stderr).text(); // drain
      await killProc.exited;
      await logAgent(agentDir, "Killed tmux session");
    } else {
      await logAgent(agentDir, "Tmux session already gone");
    }
  } else {
    await logAgent(agentDir, "No tmux session configured");
  }

  // Persist stopped state so resume's `state === "stopped"` guard is satisfied
  // and the fast-path in detectAgentStates() doesn't keep reporting the
  // pre-pause state (e.g. "complete") forever.
  await writeAgentState(agentDir, "stopped");

  // Log the pause
  await logAgent(agentDir, "Agent paused");

  logToWatchLog(
    `[pause] agent=${agent.repoName ? `${agent.repoName}/` : ""}${agent.id} ` +
    `tmux=${tmuxSession || "<none>"} pid=${agent.meta.claude_pid || "<none>"}`
  );

  return {
    ok: true,
    exitCode: 0,
    stdout: `Agent paused. Use 'ib resume ${agent.id}' to continue.`,
    stderr: "",
  };
}

/**
 * Injection context for the macOS `say` invocation in askQuestion(). Tests
 * swap this out to capture the args without actually spawning a process.
 * The runner is fire-and-forget — it must not throw and must not block.
 */
export type SayRunner = (cmd: string[]) => void;

function defaultSayRunner(cmd: string[]): void {
  try {
    const proc = Bun.spawn(cmd, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
  } catch { /* swallow: notification is best-effort */ }
}

export const sayCtx = new InjectionContext<SayRunner>(defaultSayRunner);

export function setSayRunner(runner: SayRunner): void {
  sayCtx.set(runner);
}

export function resetSayRunner(): void {
  sayCtx.reset();
}

/**
 * Injection context for the Telegram send call in askQuestion(). Tests
 * swap this out to observe the message text without going through the outbox.
 */
export type TelegramSendFn = (text: string) => Promise<{ ok: boolean; message: string }>;

export const askQuestionTelegramCtx = new InjectionContext<TelegramSendFn>(
  (text: string) => telegramSend(text)
);

export function setAskQuestionTelegramRunner(runner: TelegramSendFn): void {
  askQuestionTelegramCtx.set(runner);
}

export function resetAskQuestionTelegramRunner(): void {
  askQuestionTelegramCtx.reset();
}

/**
 * Native ask implementation — replaces `ib ask "question"`.
 * Top-level agents (no manager, or manager merged/killed) can ask the user a question.
 */
export async function askQuestion(repoPath: string, agentId: string, question: string): Promise<IbCommandResult> {
  // Verify agent exists
  const agentsDir = join(repoPath, ".ittybitty", "agents");
  const agentDir = join(agentsDir, agentId);
  const metaPath = join(agentDir, "meta.json");

  let meta: Record<string, unknown>;
  try {
    const file = Bun.file(metaPath);
    if (!(await file.exists())) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agentId}' not found` };
    }
    meta = await file.json();
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Failed to read agent metadata` };
  }

  // Top-level check: only agents with no manager (or whose manager is gone) may ask
  const managerId = meta.manager as string | undefined;
  if (managerId) {
    // Check if the manager's directory still exists (non-archived)
    const managerDir = join(agentsDir, managerId);
    const managerMetaFile = Bun.file(join(managerDir, "meta.json"));
    if (await managerMetaFile.exists()) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `Agent has a manager (${managerId}). Use 'ib send ${managerId} "message"' to communicate with your manager.`,
      };
    }
    // Manager dir doesn't exist → merged/killed/archived, allow asking
  }

  // Config check: allowAgentQuestions must be true
  const config = await readConfig();
  const allowQuestions = config.allowAgentQuestions?.value as boolean | undefined;
  if (allowQuestions === false) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent questions are disabled (allowAgentQuestions=false)" };
  }

  // Read or initialize user-questions.json
  const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");
  let data: { questions: any[] } = { questions: [] };
  try {
    const file = Bun.file(questionsPath);
    if (await file.exists()) {
      const parsed = await file.json();
      if (parsed && Array.isArray(parsed.questions)) {
        data = parsed;
      }
    }
  } catch { /* start fresh */ }

  // Clean up stale questions (agents whose directories no longer exist)
  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    const activeIds = new Set(agentEntries.filter(e => e.isDirectory()).map(e => e.name));
    data.questions = data.questions.filter((q: any) => activeIds.has(q.agent));
  } catch { /* ignore readdir failure */ }

  // Generate question ID: q-<unix-epoch>-<6-char-hash>
  const epoch = Math.floor(Date.now() / 1000);
  const hashInput = `${agentId}-${question}\n`;
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(hashInput);
  const hashHex = hasher.digest("hex");
  const questionId = `q-${epoch}-${hashHex.slice(0, 6)}`;

  // Append question
  data.questions.push({
    id: questionId,
    agent: agentId,
    question,
    timestamp: new Date().toISOString(),
    status: "pending",
  });

  await mkdir(join(repoPath, ".ittybitty"), { recursive: true });
  await Bun.write(questionsPath, JSON.stringify(data, null, 2) + "\n");

  // Log to agent's log
  await logAgent(agentDir, `Asked question: ${question} (${questionId})`);

  // Fire-and-forget notifications. Both branches swallow all errors — the
  // question has already been submitted at this point, so a failed
  // notification must never affect the return value or timing.
  try {
    const metaName = typeof meta.name === "string" && meta.name.length > 0 ? meta.name : agentId;
    const repoName = basename(repoPath);

    // 1. macOS `say` — gated by config.
    const sayEnabled = config["notifications.sayOnQuestion"]?.value as boolean | undefined;
    if (sayEnabled !== false && process.platform === "darwin") {
      const line = `Agent ${metaName} in ${repoName} has a question`;
      try {
        sayCtx.fn(["/usr/bin/say", line]);
      } catch { /* swallow: notification is best-effort */ }
    }

    // 2. Telegram — always attempted; harmlessly queues if `ib watch` isn't running.
    const tgMsg = `Agent ${metaName} in ${repoName} has a question:\n${question}`;
    try {
      void askQuestionTelegramCtx.fn(tgMsg).catch(() => { /* swallow */ });
    } catch { /* swallow synchronous throws */ }
  } catch { /* defensive: never let notification setup affect the return */ }

  return { ok: true, exitCode: 0, stdout: `Question submitted (${questionId})`, stderr: "" };
}

/**
 * Native acknowledge implementation — replaces `ib acknowledge <questionId>`.
 * Reads user-questions.json, marks the question as acknowledged, writes back.
 */
export async function acknowledgeQuestion(repoPath: string, questionId: string): Promise<IbCommandResult> {
  const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");

  let data: { questions: any[] };
  try {
    const file = Bun.file(questionsPath);
    if (!(await file.exists())) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "No questions file found" };
    }
    data = await file.json();
    if (!data || !Array.isArray(data.questions)) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "Malformed questions file" };
    }
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Failed to read questions file" };
  }

  const question = data.questions.find((q: any) => q.id === questionId);
  if (!question) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Question '${questionId}' not found` };
  }

  question.acknowledged_at = new Date().toISOString();
  question.status = "acknowledged";

  await Bun.write(questionsPath, JSON.stringify(data, null, 2) + "\n");

  return { ok: true, exitCode: 0, stdout: `Question acknowledged. Use 'ib send ${question.agent} "answer"' to respond.`, stderr: "" };
}

// ── Settings JSON helpers for hooks management ─────────────────────────────

/** Default global settings path: ~/.claude/settings.json */
function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Read and parse settings JSON, returning {} on missing/invalid */
async function readSettingsJson(settingsPath?: string): Promise<Record<string, unknown>> {
  const p = settingsPath ?? defaultSettingsPath();
  try {
    const file = Bun.file(p);
    if (await file.exists()) {
      return await file.json();
    }
  } catch { /* ignore */ }
  return {};
}

/** Write settings JSON back to the given path (or global default) */
async function writeSettingsJson(settings: Record<string, unknown>, settingsPath?: string): Promise<void> {
  const p = settingsPath ?? defaultSettingsPath();
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, JSON.stringify(settings, null, 2) + "\n");
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

/** Filter a hook array to remove entries whose command contains any of the given substrings */
function filterHookArray(hookArray: unknown, substrings: string[]): unknown[] {
  if (!Array.isArray(hookArray)) return [];
  return hookArray.filter((entry: unknown) => {
    const hooks = (entry as Record<string, unknown>)?.hooks;
    if (!Array.isArray(hooks)) return true;
    // Keep entry only if NONE of its hooks match any substring
    return hooks.every((h: unknown) => {
      const cmd = (h as Record<string, unknown>)?.command;
      if (typeof cmd !== "string") return true;
      return !substrings.some((sub) => cmd.includes(sub));
    });
  });
}

/** Remove empty hook arrays and empty hooks object from settings */
function cleanupHooksObject(settings: Record<string, unknown>): void {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return;
  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key]) && (hooks[key] as unknown[]).length === 0) {
      delete hooks[key];
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
}

// ── Hook detection predicates ───────────────────────────────────────────────

/** Check for main-path PreToolUse hook */
function hasMainPathHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  return hookArrayHasCommand(hooks?.PreToolUse, "ib hooks main-path");
}

/** Check for status injection hooks (UserPromptSubmit + PostToolUse, both must be present) */
function hasStatusHooks(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;
  return (
    hookArrayHasCommand(hooks.UserPromptSubmit, "ib hooks inject-status") &&
    hookArrayHasCommand(hooks.PostToolUse, "ib hooks inject-status")
  );
}

/** Check for session-start hook */
function hasSessionStartHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  return hookArrayHasCommand(hooks?.SessionStart, "ib hooks session-start");
}

/** Check for intercept-task hook */
function hasInterceptHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  return hookArrayHasCommand(hooks?.PreToolUse, "ib hooks intercept-task");
}

// ── Exported hooks management functions ─────────────────────────────────────

/** Returns "installed", "partial", or "not-installed" for safety hooks */
export async function hooksStatus(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);
  const hasMain = hasMainPathHook(settings);
  const hasStatus = hasStatusHooks(settings);
  const hasSession = hasSessionStartHook(settings);

  let status: string;
  if (hasMain && hasStatus && hasSession) {
    status = "installed";
  } else if (hasMain || hasStatus || hasSession) {
    status = "partial";
  } else {
    status = "not-installed";
  }
  return { ok: true, exitCode: 0, stdout: status, stderr: "" };
}

/** Returns "installed" or "not-installed" for the intercept hook */
export async function interceptHooksStatus(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);
  const status = hasInterceptHook(settings) ? "installed" : "not-installed";
  return { ok: true, exitCode: 0, stdout: status, stderr: "" };
}

/**
 * Install all safety hooks (path isolation + status injection + session-start). Idempotent.
 *
 * NOTE: Intentional divergence from bash `ib` — bash writes hooks to
 * `.claude/settings.local.json` (project-local), while this implementation
 * writes to `~/.claude/settings.json` (global). This was a deliberate change
 * in Phase 26c so itsybitsy's safety hooks apply to ALL Claude sessions,
 * not just ones launched from the itsybitsy project directory.
 */
export async function installSafetyHooks(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);
  const hooks = ((settings.hooks as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  settings.hooks = hooks;

  let installed = false;

  // Add main-path hook if not present
  if (!hasMainPathHook(settings)) {
    if (!Array.isArray(hooks.PreToolUse)) hooks.PreToolUse = [];
    (hooks.PreToolUse as unknown[]).push({
      matcher: "Bash",
      hooks: [{ type: "command", command: "ib hooks main-path" }],
    });
    installed = true;
  }

  // Add status hooks if not present
  if (!hasStatusHooks(settings)) {
    if (!Array.isArray(hooks.UserPromptSubmit)) hooks.UserPromptSubmit = [];
    if (!Array.isArray(hooks.PostToolUse)) hooks.PostToolUse = [];
    (hooks.UserPromptSubmit as unknown[]).push({
      hooks: [{ type: "command", command: "ib hooks inject-status --full --visible" }],
    });
    (hooks.PostToolUse as unknown[]).push({
      matcher: "Bash|Task",
      hooks: [{ type: "command", command: "ib hooks inject-status --if-changed --visible" }],
    });
    installed = true;
  }

  // Add session-start hook if not present
  if (!hasSessionStartHook(settings)) {
    if (!Array.isArray(hooks.SessionStart)) hooks.SessionStart = [];
    (hooks.SessionStart as unknown[]).push({
      hooks: [{ type: "command", command: "ib hooks session-start" }],
    });
    installed = true;
  }

  if (!installed) {
    return { ok: true, exitCode: 0, stdout: "Hooks already installed", stderr: "" };
  }

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Hooks installed to ~/.claude/settings.json", stderr: "" };
}

/** Uninstall all safety hooks (removes entries matching hook substrings regardless of prefix). Idempotent. */
export async function uninstallSafetyHooks(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const resolvedPath = settingsPath ?? defaultSettingsPath();
  const file = Bun.file(resolvedPath);
  if (!(await file.exists().catch(() => false))) {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  let settings: Record<string, unknown>;
  try {
    settings = await file.json();
  } catch {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks) {
    // Remove main-path from PreToolUse
    if (hooks.PreToolUse) {
      hooks.PreToolUse = filterHookArray(hooks.PreToolUse, ["hooks main-path"]);
    }
    // Remove inject-status from UserPromptSubmit and PostToolUse
    if (hooks.UserPromptSubmit) {
      hooks.UserPromptSubmit = filterHookArray(hooks.UserPromptSubmit, ["hooks inject-status"]);
    }
    if (hooks.PostToolUse) {
      hooks.PostToolUse = filterHookArray(hooks.PostToolUse, ["hooks inject-status"]);
    }
    // Remove session-start from SessionStart
    if (hooks.SessionStart) {
      hooks.SessionStart = filterHookArray(hooks.SessionStart, ["hooks session-start"]);
    }
    cleanupHooksObject(settings);
  }

  // Delete file if settings is now empty, otherwise write back
  if (Object.keys(settings).length === 0) {
    await rm(resolvedPath).catch(() => {});
    return { ok: true, exitCode: 0, stdout: "Hooks uninstalled, removed empty settings file", stderr: "" };
  }

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Hooks uninstalled from ~/.claude/settings.json", stderr: "" };
}

/** Install task interception hook. Idempotent. */
export async function installInterceptHook(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const settings = await readSettingsJson(settingsPath);

  if (hasInterceptHook(settings)) {
    return { ok: true, exitCode: 0, stdout: "Task interception hook already installed", stderr: "" };
  }

  const hooks = ((settings.hooks as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  settings.hooks = hooks;
  if (!Array.isArray(hooks.PreToolUse)) hooks.PreToolUse = [];
  (hooks.PreToolUse as unknown[]).push({
    matcher: "Task|Agent|TaskCreate|AskUserQuestion",
    hooks: [{ type: "command", command: "ib hooks intercept-task" }],
  });

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Task interception hook installed to ~/.claude/settings.json", stderr: "" };
}

/** Uninstall task interception hook. Idempotent. */
export async function uninstallInterceptHook(_repoPath: string, settingsPath?: string): Promise<IbCommandResult> {
  const resolvedPath = settingsPath ?? defaultSettingsPath();
  const file = Bun.file(resolvedPath);
  if (!(await file.exists().catch(() => false))) {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  let settings: Record<string, unknown>;
  try {
    settings = await file.json();
  } catch {
    return { ok: true, exitCode: 0, stdout: "No settings file found, nothing to uninstall", stderr: "" };
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks && hooks.PreToolUse) {
    hooks.PreToolUse = filterHookArray(hooks.PreToolUse, ["hooks intercept-task"]);
    cleanupHooksObject(settings);
  }

  if (Object.keys(settings).length === 0) {
    await rm(resolvedPath).catch(() => {});
    return { ok: true, exitCode: 0, stdout: "Task interception hook uninstalled, removed empty settings file", stderr: "" };
  }

  await writeSettingsJson(settings, settingsPath);
  return { ok: true, exitCode: 0, stdout: "Task interception hook uninstalled from ~/.claude/settings.json", stderr: "" };
}

/**
 * Outbound `ib tgsend` — file-drop client for the `ib watch` outbox.
 *
 * Phase B refactor: `ib tgsend` no longer talks to Telegram directly. It
 * writes the message text to `~/.itsybitsy/channels/telegram/outbox/` and
 * polls for a `<stem>.txt.result` file containing the JSON outcome from
 * `ib watch`'s outbox processor. If `ib watch` is not running (or Telegram
 * is not configured), no result will appear; we time out after 1s and
 * return an "ok-but-queued" outcome so the caller exits 0 — the message is
 * legitimately waiting on disk and `ib watch` will pick it up next start.
 */
export async function telegramSend(text: string): Promise<{ ok: boolean; message: string }> {
  const { defaultOutboxDir } = await import("./channels/outbox");
  const { mkdir, rename, readFile, unlink } = await import("fs/promises");
  const { randomBytes } = await import("crypto");
  const { join } = await import("path");

  const dir = defaultOutboxDir();
  const stem = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const txtPath = join(dir, `${stem}.txt`);
  const tmpPath = `${txtPath}.tmp`;
  const resultPath = `${txtPath}.result`;

  await mkdir(dir, { recursive: true });
  await Bun.write(tmpPath, text);
  await rename(tmpPath, txtPath);

  // Poll up to 1s for the result file. 100ms cadence keeps the small-message
  // happy path fast (one round trip is typically <100ms) without spinning.
  const POLL_INTERVAL_MS = 100;
  const POLL_ATTEMPTS = 10;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let resultText: string;
    try {
      resultText = await readFile(resultPath, "utf8");
    } catch {
      continue;
    }
    let parsed: { ok: boolean; message: string };
    try {
      parsed = JSON.parse(resultText) as { ok: boolean; message: string };
    } catch {
      // Malformed result — treat as transient and keep polling. The outbox
      // processor writes valid JSON or nothing.
      continue;
    }
    // Best-effort delete of the .result; the outbox cleans up after 5s anyway.
    await unlink(resultPath).catch(() => { /* ignore */ });
    return { ok: !!parsed.ok, message: String(parsed.message ?? "") };
  }

  return {
    ok: true,
    message: "queued (ib watch may not be running, or Telegram is not configured)",
  };
}
