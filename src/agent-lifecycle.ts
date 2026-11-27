import * as runtimeNames from "./runtime-names";
/**
 * Shared agent lifecycle helpers used by multiple ib commands.
 * Mirrors the behavior of the ib bash script's teardown, archive,
 * kill, and utility functions.
 */

import { basename, join, dirname, resolve } from "path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import {
  readdir,
  mkdir,
  cp,
  rm,
  rename,
  appendFile,
  lstat,
  readlink,
  stat,
  symlink,
} from "fs/promises";
import { SpawnContext, type SpawnResult } from "./types";
import {
  isValidAgentId,
  isValidTmuxSession,
  tmuxSessionTarget,
} from "./validation";
import {
  deleteAgentTransient,
  readAgentMeta,
  terminateProcess,
  type AgentMeta,
} from "./agents";
import { deleteAgentOutbox, agentOutboxDir } from "./outbox";
import { deleteClaudeRateLimits } from "./claude-rate-limits";
import { pruneAgentFromAllTeams } from "./teams";
import { logWarning } from "./watch-log";
import { formatLogTimestamp } from "./log-timestamp";

/** Spawn context for agent lifecycle operations */
export const spawnCtx = new SpawnContext();

/** Prefer new retirements; the legacy namespace is consulted only if absent. */
export async function resolveRetainedHeadRef(
  repoPath: string,
  archiveKey: string,
  context: SpawnContext = spawnCtx,
): Promise<{ ref: string; gitHead: string }> {
  const refs = [runtimeNames.retiredHeadRef(archiveKey), runtimeNames.legacyRetiredHeadRef(archiveKey)];
  for (const ref of refs) {
    const result = await context.run(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result.exitCode === 0) return { ref, gitHead: result.stdout.trim() };
    if (result.exitCode !== 1) {
      throw new Error(`Cannot resolve retained HEAD ${ref}: ${result.stderr.trim() || `git exited ${result.exitCode}`}`);
    }
  }
  throw new Error(`Retained HEAD not found: neither ${refs[0]} nor ${refs[1]}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a date as YYYYMMDD-HHMMSS for archive folder names */
function formatArchiveTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const RETIREMENT_PAYLOAD_DIR = ".retirement";
const RETIREMENT_MANIFEST_FILE = "retirement.json";
const WORKTREE_PATCH_FILE = "worktree.patch";
const UNTRACKED_DIR = "untracked";
const RUNTIME_DIR = "runtime";
const PREPARED_RETIREMENT_FILE = "prepared-retirement.json";

export interface RetirementManifestV1 {
  version: 1;
  agentId: string;
  retiredAt: string;
  repoPath: string;
  archiveKey: string;
  worktree: boolean;
  gitHead: string | null;
  headRef: string | null;
  untrackedFiles: string[];
  prunedTeams: Array<{ team: string; id: string }>;
}

export interface PreparedRetirement {
  archiveKey: string;
  payloadDir: string;
  manifest: Omit<RetirementManifestV1, "prunedTeams">;
}

export interface RetiredAgentArchive {
  repoPath: string;
  archiveDir: string;
  archiveKey: string;
  meta: AgentMeta;
  manifest: RetirementManifestV1 | null;
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function isSafeArchiveKey(value: unknown, agentId: string): value is string {
  return (
    typeof value === "string" &&
    value.endsWith(`-${agentId}`) &&
    /^\d{8}-\d{6}-[a-zA-Z0-9_-]+$/.test(value)
  );
}

/** Validate a path stored in a retirement manifest before filesystem use. */
export function isSafeRetirementRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  const parts = value.split(/[\\/]/);
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function parseRetirementManifest(
  value: unknown,
  expectedAgentId?: string,
): RetirementManifestV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (typeof raw.agentId !== "string" || !isValidAgentId(raw.agentId)) return null;
  if (expectedAgentId !== undefined && raw.agentId !== expectedAgentId) return null;
  if (typeof raw.retiredAt !== "string" || Number.isNaN(Date.parse(raw.retiredAt))) return null;
  if (typeof raw.repoPath !== "string" || raw.repoPath.length === 0) return null;
  if (!isSafeArchiveKey(raw.archiveKey, raw.agentId)) return null;
  if (typeof raw.worktree !== "boolean") return null;
  if (raw.worktree) {
    if (!isGitObjectId(raw.gitHead)) return null;
    if (
      typeof raw.headRef !== "string" ||
      !runtimeNames.isRetiredHeadRef(raw.headRef, raw.archiveKey)
    ) return null;
  } else if (raw.gitHead !== null || raw.headRef !== null) {
    return null;
  }
  if (
    !Array.isArray(raw.untrackedFiles) ||
    !raw.untrackedFiles.every(isSafeRetirementRelativePath)
  ) return null;
  if (
    !Array.isArray(raw.prunedTeams) ||
    !raw.prunedTeams.every((entry) => (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as { team?: unknown }).team === "string" &&
      (entry as { id?: unknown }).id === raw.agentId
    ))
  ) return null;
  return raw as unknown as RetirementManifestV1;
}

async function runRawBytes(
  cmd: string[],
): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }> {
  const proc = spawnCtx.runner(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

async function copySnapshotEntry(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  await mkdir(dirname(destination), { recursive: true });
  if (sourceStat.isSymbolicLink()) {
    const target = await readlink(source);
    await symlink(target, destination);
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`unsupported untracked file type: ${source}`);
  }
  await cp(source, destination, {
    dereference: false,
    preserveTimestamps: true,
  });
}

/**
 * Capture every recoverable bit of an agent before teardown mutates it.
 *
 * Worktree agents retain their exact HEAD through a hidden ref, a binary patch
 * for tracked changes, and copies of non-ignored untracked files. The payload
 * stays under the agent directory until archiveAgent moves it into the final
 * timestamped archive.
 */
export async function prepareAgentRetirement(
  repoPath: string,
  agentId: string,
  agentDir: string,
  worktree: boolean,
): Promise<PreparedRetirement> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`invalid agent id: ${agentId}`);
  }

  const archiveKey = `${formatArchiveTimestamp()}-${agentId}`;
  const archivePath = join(runtimeNames.runtimeDir(repoPath), "archive", archiveKey);
  if (await lstat(archivePath).then(() => true).catch(() => false)) {
    throw new Error(`retirement archive already exists: ${archiveKey}`);
  }

  const payloadDir = join(agentDir, RETIREMENT_PAYLOAD_DIR);
  if (await lstat(payloadDir).then(() => true).catch(() => false)) {
    const pending = await Bun.file(
      join(payloadDir, PREPARED_RETIREMENT_FILE),
    ).json().catch(() => null) as Record<string, unknown> | null;
    const retainedRef =
      typeof pending?.headRef === "string"
        ? ` and retained ref ${pending.headRef}`
        : "";
    throw new Error(
      `unfinished retirement payload already exists: ${payloadDir}${retainedRef}. ` +
      `Preserve or remove that recovery state before retrying, or use ` +
      `'ib nuke ${agentId}' to discard the agent`,
    );
  }
  await mkdir(payloadDir, { recursive: true });

  let headRef: string | null = null;
  try {
    const runtimeDir = join(payloadDir, RUNTIME_DIR);
    await mkdir(runtimeDir, { recursive: true });
    const metaSource = join(agentDir, "meta.json");
    if (!(await lstat(metaSource)).isFile()) {
      throw new Error("agent meta.json is not a regular file");
    }
    await cp(metaSource, join(runtimeDir, "meta.json"));
    for (const fileName of ["agent.log", "prompt.txt", "start.sh", "exit-check.sh"]) {
      const source = join(agentDir, fileName);
      if (await Bun.file(source).exists().catch(() => false)) {
        if (!(await lstat(source)).isFile()) {
          throw new Error(`${fileName} is not a regular file`);
        }
        await cp(source, join(runtimeDir, fileName));
      }
    }
    const coordinatorSettings = join(agentDir, ".claude", "settings.local.json");
    if (await Bun.file(coordinatorSettings).exists().catch(() => false)) {
      if (!(await lstat(coordinatorSettings)).isFile()) {
        throw new Error("coordinator settings.local.json is not a regular file");
      }
      await mkdir(join(runtimeDir, ".claude"), { recursive: true });
      await cp(
        coordinatorSettings,
        join(runtimeDir, ".claude", "settings.local.json"),
      );
    }

    let gitHead: string | null = null;
    const untrackedFiles: string[] = [];

    if (worktree) {
      const worktreePath = join(agentDir, "repo");
      const worktreeExists = await lstat(worktreePath)
        .then((value) => value.isDirectory())
        .catch(() => false);
      if (!worktreeExists) {
        throw new Error(`agent worktree is missing: ${worktreePath}`);
      }

      const worktreeSettings = join(worktreePath, ".claude", "settings.local.json");
      if (await Bun.file(worktreeSettings).exists().catch(() => false)) {
        if (!(await lstat(worktreeSettings)).isFile()) {
          throw new Error("worktree settings.local.json is not a regular file");
        }
        await cp(worktreeSettings, join(runtimeDir, "settings.local.json"));
      }

      const headResult = await spawnCtx.run(["git", "-C", worktreePath, "rev-parse", "HEAD"]);
      if (headResult.exitCode !== 0 || !isGitObjectId(headResult.stdout)) {
        throw new Error(headResult.stderr || "could not resolve agent worktree HEAD");
      }
      gitHead = headResult.stdout;

      const patchResult = await runRawBytes([
        "git", "-C", worktreePath, "diff", "--binary", "--full-index", "HEAD", "--",
      ]);
      if (patchResult.exitCode !== 0) {
        throw new Error(patchResult.stderr.trim() || "could not snapshot tracked worktree changes");
      }
      await Bun.write(join(payloadDir, WORKTREE_PATCH_FILE), patchResult.stdout);

      const untrackedResult = await runRawBytes([
        "git", "-C", worktreePath, "ls-files", "--others", "--exclude-standard", "-z",
      ]);
      if (untrackedResult.exitCode !== 0) {
        throw new Error(untrackedResult.stderr.trim() || "could not enumerate untracked files");
      }
      let untrackedOutput: string;
      try {
        untrackedOutput = new TextDecoder("utf-8", { fatal: true }).decode(
          untrackedResult.stdout,
        );
      } catch {
        throw new Error(
          "untracked filenames must be valid UTF-8 to create a recoverable retirement",
        );
      }
      for (const relativePath of untrackedOutput.split("\0")) {
        if (!relativePath) continue;
        if (!isSafeRetirementRelativePath(relativePath)) {
          throw new Error(`unsafe untracked path reported by git: ${JSON.stringify(relativePath)}`);
        }
        const source = resolve(worktreePath, relativePath);
        if (source !== worktreePath && !source.startsWith(worktreePath + "/")) {
          throw new Error(`untracked path escapes worktree: ${relativePath}`);
        }
        const sourceStat = await lstat(source);
        if (sourceStat.isSymbolicLink()) {
          const target = await readlink(source);
          const resolvedTarget = resolve(dirname(source), target);
          if (
            (resolvedTarget !== worktreePath &&
              !resolvedTarget.startsWith(worktreePath + "/"))
          ) {
            throw new Error(`untracked symlink escapes worktree: ${relativePath}`);
          }
        }
        await copySnapshotEntry(
          source,
          join(payloadDir, UNTRACKED_DIR, relativePath),
        );
        untrackedFiles.push(relativePath);
      }

      headRef = runtimeNames.retiredHeadRef(archiveKey);
      const refResult = await spawnCtx.run([
        "git", "-C", repoPath, "update-ref", headRef, gitHead,
      ]);
      if (refResult.exitCode !== 0) {
        throw new Error(refResult.stderr || `could not retain agent HEAD at ${headRef}`);
      }
    }

    const manifest = {
      version: 1 as const,
      agentId,
      retiredAt: new Date().toISOString(),
      repoPath,
      archiveKey,
      worktree,
      gitHead,
      headRef,
      untrackedFiles,
    };
    await Bun.write(
      join(payloadDir, PREPARED_RETIREMENT_FILE),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return {
      archiveKey,
      payloadDir,
      manifest,
    };
  } catch (err) {
    if (headRef) {
      await spawnCtx.run(["git", "-C", repoPath, "update-ref", "-d", headRef]).catch(() => {});
    }
    await rm(payloadDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function cleanupPreparedRetirement(
  repoPath: string,
  prepared: PreparedRetirement,
): Promise<void> {
  if (prepared.manifest.headRef) {
    await spawnCtx.run([
      "git", "-C", repoPath, "update-ref", "-d", prepared.manifest.headRef,
    ]).catch(() => {});
  }
  await rm(prepared.payloadDir, { recursive: true, force: true }).catch(() => {});
}

/** Scan timestamped archive folders and resolve immutable exact agent IDs. */
export async function findRetiredAgentArchives(
  repoPath: string,
  agentId: string,
): Promise<RetiredAgentArchive[]> {
  if (!isValidAgentId(agentId)) return [];
  const archiveRoot = runtimeNames.archiveDir(repoPath);
  const entries = await readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
  const matches: RetiredAgentArchive[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const archiveDir = join(archiveRoot, entry.name);
    const { meta } = await readAgentMeta(archiveDir);
    if (!meta || meta.id !== agentId) continue;
    const rawManifest = await Bun.file(join(archiveDir, RETIREMENT_MANIFEST_FILE))
      .json()
      .catch(() => null);
    const parsedManifest = parseRetirementManifest(rawManifest, agentId);
    matches.push({
      repoPath,
      archiveDir,
      archiveKey: entry.name,
      meta,
      manifest:
        parsedManifest?.archiveKey === entry.name ? parsedManifest : null,
    });
  }
  return matches.sort((a, b) => b.archiveKey.localeCompare(a.archiveKey));
}

// ── logAgent ─────────────────────────────────────────────────────────────────

/**
 * Append a timestamped line to an agent's agent.log.
 * Format: [YYYY-MM-DD HH:MM:SS] message
 * Only writes if the agent directory exists.
 */
export async function logAgent(agentDir: string, message: string): Promise<void> {
  try {
    const logFile = join(agentDir, "agent.log");
    const line = `[${formatLogTimestamp()}] ${message}\n`;
    await appendFile(logFile, line);
  } catch { /* agent dir may not exist */ }
}

// ── logSpawn ─────────────────────────────────────────────────────────────────

/** Log a spawn event to the spawnee and (if detected) spawner agent.log, tagged distinctly. */
export async function logSpawn(
  spawneeDir: string,
  spawnerDir: string | null,
  spawneeId: string,
  message: string,
): Promise<void> {
  await Promise.all([
    logAgent(spawneeDir, `[spawn] ${message}`),
    spawnerDir ? logAgent(spawnerDir, `[spawn child=${spawneeId}] ${message}`) : Promise.resolve(),
  ]);
}

// ── removeAgentQuestions ─────────────────────────────────────────────────────

/**
 * Remove entries for the given agent from .itsybitsy/user-questions.json.
 */
export async function removeAgentQuestions(repoPath: string, agentId: string): Promise<void> {
  const questionsPath = runtimeNames.userQuestionsFile(repoPath);
  try {
    const file = Bun.file(questionsPath);
    if (!(await file.exists())) return;
    const data = await file.json();
    if (!data || !Array.isArray(data.questions)) return;
    data.questions = data.questions.filter(
      (q: { agent?: string }) => q.agent !== agentId
    );
    await Bun.write(questionsPath, JSON.stringify(data, null, 2));
  } catch { /* ignore — file may not exist or be malformed */ }
}

// ── killAgentProcess ─────────────────────────────────────────────────────────

export interface KillAgentMeta {
  claude_pid?: string;
}

/** Optional log-enrichment context for {@link killAgentProcess}. Threaded
 *  through to {@link terminateProcess} so the resulting `[terminate]` line
 *  carries agent/repo provenance. All callers SHOULD pass this when known —
 *  the optional shape is purely for backward compatibility with the test
 *  surface that already exercises the function without an agent.
 */
export interface KillAgentLogContext {
  agentId?: string;
  repoName?: string;
}

/**
 * Kill the Claude process for an agent.
 *
 * Strategy 1: tmux list-panes pane_pid -> pgrep -P for claude
 * Strategy 2: claude_pid from meta
 *
 * Delegates the SIGTERM → wait → SIGKILL escalation to the canonical
 * {@link terminateProcess} funnel in src/agents.ts, which writes a
 * `[terminate] label=claude …` line to watch.log per call and uses the
 * EPERM-aware liveness probe (so a sandboxed view of an unsignal-able PID is
 * not misread as already-dead, the bug that originally motivated this
 * refactor).
 *
 * Returns true if the process was killed (or was already dead), false if no
 * PID could be resolved or the kill failed.
 */
export async function killAgentProcess(
  tmuxSession: string,
  meta: KillAgentMeta,
  logCtx: KillAgentLogContext = {}
): Promise<boolean> {
  if (!isValidTmuxSession(tmuxSession)) {
    logWarning(`[agent-lifecycle] Invalid tmux session name: ${tmuxSession}`);
    return false;
  }

  let pid: string | null = null;

  // Strategy 1: Dynamic lookup from tmux
  const hasSession = await spawnCtx.run(["tmux", "has-session", "-t", tmuxSessionTarget(tmuxSession)]);
  if (hasSession.exitCode === 0) {
    const paneResult = await spawnCtx.run([
      "tmux", "list-panes", "-t", tmuxSessionTarget(tmuxSession), "-F", "#{pane_pid}",
    ]);
    if (paneResult.exitCode === 0 && paneResult.stdout) {
      const panePid = paneResult.stdout.split("\n")[0]!.trim();
      if (panePid) {
        const pgrepResult = await spawnCtx.run(["pgrep", "-P", panePid, "-f", "claude"]);
        if (pgrepResult.exitCode === 0 && pgrepResult.stdout) {
          pid = pgrepResult.stdout.split("\n")[0]!.trim();
        }
      }
    }
  }

  // Strategy 2: Fallback to meta.json PID
  if (!pid && meta.claude_pid && meta.claude_pid !== "null") {
    pid = meta.claude_pid;
  }

  if (!pid) return false;

  const numPid = parseInt(pid, 10);
  if (isNaN(numPid)) return false;

  const result = await terminateProcess({
    pid: numPid,
    label: "claude",
    agentId: logCtx.agentId,
    repoName: logCtx.repoName,
    tmuxSession,
  });
  return result.killed;
}

// ── captureTmuxOutputToFile ──────────────────────────────────────────────────

/**
 * Capture tmux pane output and write it to a file.
 * Equivalent to: tmux capture-pane -t <session> -p -S - > outputPath
 */
export async function captureTmuxOutputToFile(
  tmuxSession: string,
  outputPath: string
): Promise<boolean> {
  if (!isValidTmuxSession(tmuxSession)) {
    logWarning(`[agent-lifecycle] Invalid tmux session name: ${tmuxSession}`);
    return false;
  }
  try {
    const proc = spawnCtx.runner(
      ["tmux", "capture-pane", "-t", tmuxSessionTarget(tmuxSession), "-p", "-S", "-"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const raw = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    await Bun.write(outputPath, raw);
    return true;
  } catch { /* expected: tmux session doesn't exist or permission error */
    return false;
  }
}

// ── archiveAgent ─────────────────────────────────────────────────────────────

/**
 * Result of {@link archiveAgent}. Carries BOTH the historical archive-folder
 * path (`null` when there were no artifacts to archive) AND the set of
 * `(team, removed-agent-id)` pairs this agent was pruned from at teardown
 * (§16.5). The leave-notice fan-out lives in the `ib-commands.ts` command layer,
 * which threads `prunedTeams` up to decide who to notify; `archiveAgent` itself
 * emits NO notice and only performs the membership write.
 */
export interface ArchiveAgentResult {
  warnings: string[];
  /** Archive folder path, or null if there were no artifacts to archive. */
  archivePath: string | null;
  /** `(team, id)` pairs this agent was pruned from (empty if it was in no team). */
  prunedTeams: Array<{ team: string; id: string }>;
}

/**
 * Archive agent artifacts to .itsybitsy/archive/YYYYMMDD-HHMMSS-<id>/.
 * Moves/copies: output.log (move), agent.log (copy), meta.json (copy),
 * settings.local.json (move), debug-logs/ (copy recursive).
 *
 * Also performs the EAGER team-membership prune (§16.5): the agent's id is
 * removed from every team it belonged to, UNCONDITIONALLY — pruning is keyed to
 * teardown, not to whether any artifacts existed, so it runs even on the
 * no-artifacts early-return path. Pruning is by agent id only (no `repos` data
 * needed) and emits NO notice. The pruned `(team, id)` pairs are returned so the
 * command layer can fan out the appropriate leave notice.
 */
export async function archiveAgent(
  repoPath: string,
  agentId: string,
  agentDir: string,
  preparedRetirement?: PreparedRetirement,
): Promise<ArchiveAgentResult> {
  // Eager teardown prune FIRST, unconditionally (§16.5): a torn-down agent must
  // be removed from every team it belonged to even when there are no artifacts
  // to archive. Pruning is by id only and never emits a notice.
  const prunedTeams = await pruneAgentFromAllTeams(agentId);

  const archiveDir = runtimeNames.archiveDir(repoPath);
  const archiveKey =
    preparedRetirement?.archiveKey ?? `${formatArchiveTimestamp()}-${agentId}`;
  const archiveFolder = join(archiveDir, archiveKey);

  // Check if there's anything to archive
  const hasOutput = await Bun.file(join(agentDir, "output.log")).exists().catch(() => false);
  const hasLog = await Bun.file(join(agentDir, "agent.log")).exists().catch(() => false);
  const hasMeta = await Bun.file(join(agentDir, "meta.json")).exists().catch(() => false);

  // A destructive merge/nuke after a previously interrupted retirement also
  // discards the retained hidden ref recorded with that unfinished payload.
  // Explicit retire passes preparedRetirement and keeps the ref as recovery
  // state, so it never enters this cleanup path.
  if (!preparedRetirement) {
    const pending = await Bun.file(
      join(agentDir, RETIREMENT_PAYLOAD_DIR, PREPARED_RETIREMENT_FILE),
    ).json().catch(() => null) as Record<string, unknown> | null;
    const pendingArchiveKey = pending?.archiveKey;
    const pendingHeadRef = pending?.headRef;
    if (
      isSafeArchiveKey(pendingArchiveKey, agentId) &&
      runtimeNames.isRetiredHeadRef(pendingHeadRef, pendingArchiveKey)
    ) {
      await spawnCtx.run([
        "git", "-C", repoPath, "update-ref", "-d", pendingHeadRef,
      ]).catch(() => {});
    }
  }

  const warnings: string[] = [];
  const live = await readAgentMeta(agentDir);
  let identity = live;
  if (!live.meta && preparedRetirement) {
    const snapshot = await readAgentMeta(join(preparedRetirement.payloadDir, RUNTIME_DIR));
    // A missing snapshot adds no information about the live metadata.
    if (!snapshot.missing) identity = snapshot;
  }
  let queueDir: string | undefined;
  try {
    if (!identity.meta) throw new Error(identity.error ?? "No readable agent metadata");
    queueDir = agentOutboxDir({ id: agentId, meta: identity.meta });
  } catch (err) {
    warnings.push(`Warning: skipped queue cleanup for '${agentId}': ${(err as Error).message}`);
  }
  if (!hasOutput && !hasLog && live.missing && !preparedRetirement) {
    return { archivePath: null, prunedTeams, warnings };
  }
  await mkdir(archiveFolder, { recursive: true });

  // output.log — move
  if (hasOutput) {
    try {
      await rename(join(agentDir, "output.log"), join(archiveFolder, "output.log"));
    } catch {
      // Fallback: copy then delete
      try {
        await cp(join(agentDir, "output.log"), join(archiveFolder, "output.log"));
        await rm(join(agentDir, "output.log"));
      } catch { /* ignore */ }
    }
  }

  // agent.log — copy
  if (hasLog) {
    try {
      await cp(join(agentDir, "agent.log"), join(archiveFolder, "agent.log"));
    } catch { /* ignore */ }
  }

  // meta.json — copy
  if (hasMeta && identity === live) {
    try {
      await cp(join(agentDir, "meta.json"), join(archiveFolder, "meta.json"));
    } catch { /* ignore */ }
  }

  for (const fileName of ["prompt.txt", "start.sh", "exit-check.sh"]) {
    const source = join(agentDir, fileName);
    if (await Bun.file(source).exists().catch(() => false)) {
      await cp(source, join(archiveFolder, fileName));
    }
  }

  // Coordinators keep isolated settings in the agent directory.
  try {
    await readdir(join(agentDir, ".claude"));
    await cp(join(agentDir, ".claude"), join(archiveFolder, ".claude"), {
      recursive: true,
    });
  } catch { /* absent for ordinary agents */ }

  // settings.local.json — move
  const hasSettings = await Bun.file(join(agentDir, "settings.local.json")).exists().catch(() => false);
  if (hasSettings) {
    try {
      await rename(join(agentDir, "settings.local.json"), join(archiveFolder, "settings.local.json"));
    } catch {
      try {
        await cp(join(agentDir, "settings.local.json"), join(archiveFolder, "settings.local.json"));
        await rm(join(agentDir, "settings.local.json"));
      } catch { /* ignore */ }
    }
  }

  // debug-logs/ — copy recursive (use readdir to check existence; Bun.file().exists() doesn't work on dirs)
  try {
    const debugLogsDir = join(agentDir, "debug-logs");
    await readdir(debugLogsDir);
    await cp(debugLogsDir, join(archiveFolder, "debug-logs"), { recursive: true });
  } catch { /* dir doesn't exist or copy failed */ }

  if (preparedRetirement) {
    const runtimeDir = join(preparedRetirement.payloadDir, RUNTIME_DIR);
    for (const fileName of [
      "meta.json",
      "agent.log",
      "prompt.txt",
      "start.sh",
      "exit-check.sh",
      "settings.local.json",
    ]) {
      const source = join(runtimeDir, fileName);
      const destination = join(archiveFolder, fileName);
      if (
        !(await Bun.file(destination).exists().catch(() => false)) &&
        await Bun.file(source).exists().catch(() => false)
      ) {
        await cp(source, destination);
      }
    }
    const coordinatorSettings = join(runtimeDir, ".claude", "settings.local.json");
    const archivedCoordinatorSettings = join(
      archiveFolder,
      ".claude",
      "settings.local.json",
    );
    if (
      !(await Bun.file(archivedCoordinatorSettings).exists().catch(() => false)) &&
      await Bun.file(coordinatorSettings).exists().catch(() => false)
    ) {
      await mkdir(join(archiveFolder, ".claude"), { recursive: true });
      await cp(coordinatorSettings, archivedCoordinatorSettings);
    }

    const patchSource = join(preparedRetirement.payloadDir, WORKTREE_PATCH_FILE);
    if (await Bun.file(patchSource).exists().catch(() => false)) {
      await rename(patchSource, join(archiveFolder, WORKTREE_PATCH_FILE));
    }
    try {
      await readdir(join(preparedRetirement.payloadDir, UNTRACKED_DIR));
      await rename(
        join(preparedRetirement.payloadDir, UNTRACKED_DIR),
        join(archiveFolder, UNTRACKED_DIR),
      );
    } catch { /* no untracked files */ }

    const manifest: RetirementManifestV1 = {
      ...preparedRetirement.manifest,
      prunedTeams,
    };
    await Bun.write(
      join(archiveFolder, RETIREMENT_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await rm(preparedRetirement.payloadDir, { recursive: true, force: true });
  }

  // meta.transient.json has no historical value — explicitly delete it
  // (rather than copying) so any future archive flow that doesn't rm-rf
  // the agent directory still cleans it up. Current callers (mergeAgent,
  // teardownAgent, nukeAllAgents) all rm-rf afterwards, so this is
  // defensive insurance.
  await deleteAgentTransient(agentDir);

  // The outbox queue + its lock are runtime delivery state — no historical
  // value, so delete (not archive) alongside meta.transient.json. Any
  // not-yet-delivered messages are intentionally dropped: the agent is being
  // torn down, so there is no live tmux session to deliver to. The outbox
  // now lives under the CENTRAL coordinator-home root (agentOutboxDir), not
  // beside meta.json in the per-worktree agent dir; deleteAgentOutbox also
  // removes the per-agent outbox subdir. The statusline's Claude
  // rate-limit record lives in the same folder and must go first, or the
  // rmdir fails and the folder stays for good.
  if (queueDir) {
    warnings.push(...await deleteClaudeRateLimits(queueDir));
    warnings.push(...await deleteAgentOutbox(queueDir));
  }

  return { archivePath: archiveFolder, prunedTeams, warnings };
}

// ── teardownAgent ────────────────────────────────────────────────────────────

/** Surface cleanup failures after the agent's artifacts have been archived. */
export async function removeArchivedAgentDirectory(agentDir: string): Promise<string | undefined> {
  try {
    await rm(agentDir, { recursive: true, force: true });
  } catch (err) {
    return `Warning: could not remove agent directory ${agentDir}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface TeardownMeta {
  tmux_session: string;
  claude_pid?: string;
  sandbox_proxy_pid?: number;
}

let sandboxProxyKillFn = (pid: number): void => { process.kill(pid, "SIGTERM"); };

export function setSandboxProxyKillForTesting(fn: (pid: number) => void): void {
  sandboxProxyKillFn = fn;
}

export function resetSandboxProxyKillForTesting(): void {
  sandboxProxyKillFn = (pid) => { process.kill(pid, "SIGTERM"); };
}

/**
 * Full teardown of an agent:
 * 1. Log the action
 * 2. Capture tmux output before killing
 * 3. Kill Claude process
 * 4. Kill tmux session
 * 5. Copy settings.local.json from worktree
 * 6. Remove git worktree
 * 7. Delete git branch
 * 8. Archive artifacts
 * 9. Remove agent directory
 */
export async function teardownAgent(
  repoPath: string,
  agentId: string,
  agentDir: string,
  meta: TeardownMeta,
  logMsg: string = "Agent killed",
  preparedRetirement?: PreparedRetirement,
  beforeRemove?: () => Promise<void>,
): Promise<{ ok: boolean; prunedTeams: Array<{ team: string; id: string }>; warnings: string[] }> {
  const tmuxSession = meta.tmux_session;

  if (!isValidTmuxSession(tmuxSession)) {
    // §16.5 makes the eager team prune UNCONDITIONAL. archiveAgent (which
    // normally runs the prune) is skipped on this early-return path, so prune
    // here directly — otherwise an agent with a corrupt tmux_session would be
    // silently left in its teams until a later lazy prune self-healed it.
    const prunedTeams = await pruneAgentFromAllTeams(agentId);
    logWarning(`[agent-lifecycle] Invalid tmux session name in meta for agent ${agentId}: ${tmuxSession}`);
    return { ok: false, prunedTeams, warnings: [] };
  }

  // 1. Log
  await logAgent(agentDir, logMsg);

  // 2. Capture tmux output
  const hasSession = await spawnCtx.run(["tmux", "has-session", "-t", tmuxSessionTarget(tmuxSession)]);
  if (hasSession.exitCode === 0) {
    await captureTmuxOutputToFile(tmuxSession, join(agentDir, "output.log"));
  }

  // 3. Kill Claude process
  const killed = await killAgentProcess(tmuxSession, meta, { agentId });
  if (killed) {
    await logAgent(agentDir, "Terminated Claude process");
  }

  // The proxy is deliberately outside Claude's Seatbelt profile and process
  // group. Tear it down explicitly; start.sh's EXIT trap is the natural-exit
  // backstop, while this covers retire/pause/nuke and abrupt pane loss.
  const proxyPids = new Set<number>();
  if (typeof meta.sandbox_proxy_pid === "number") proxyPids.add(meta.sandbox_proxy_pid);
  try {
    const pidText = (await Bun.file(join(agentDir, "sandbox-proxy.pid")).text()).trim();
    if (/^[1-9][0-9]*$/.test(pidText)) proxyPids.add(Number(pidText));
  } catch { /* no proxy pid file */ }
  for (const pid of proxyPids) {
    try { sandboxProxyKillFn(pid); } catch { /* already exited */ }
  }
  if (proxyPids.size > 0) await logAgent(agentDir, "Terminated sandbox proxy");

  // 4. Kill tmux session
  const hasSession2 = await spawnCtx.run(["tmux", "has-session", "-t", tmuxSessionTarget(tmuxSession)]);
  if (hasSession2.exitCode === 0) {
    await spawnCtx.run(["tmux", "kill-session", "-t", tmuxSessionTarget(tmuxSession)]);
    await logAgent(agentDir, "Killed tmux session");
  }

  // 5. Copy settings.local.json before removing worktree
  const settingsPath = join(agentDir, "repo", ".claude", "settings.local.json");
  try {
    if (await Bun.file(settingsPath).exists()) {
      const content = await Bun.file(settingsPath).text();
      await Bun.write(join(agentDir, "settings.local.json"), content);
    }
  } catch { /* ignore */ }

  // D5 teardown (SPEC-ANTIGRAVITY-CLI.md): drop the worktree from agy's
  // trustedWorkspaces BEFORE it is removed (so realpath still resolves). The
  // helper reads meta.model and is a no-op — and never throws — for
  // claude/codex agents, so teardown can't fail on it.
  try {
    const { untrustAgyWorkspaceForTeardown } = await import("./agy-spawn");
    await untrustAgyWorkspaceForTeardown(agentDir, join(agentDir, "repo"));
  } catch {
    /* a module-load failure must never abort a teardown */
  }

  // 6. Remove git worktree
  const repoDir = join(agentDir, "repo");
  try {
    const entries = await readdir(repoDir).catch(() => null);
    if (entries !== null) {
      const result = await spawnCtx.run([
        "git", "-C", repoPath, "worktree", "remove", repoDir, "--force",
      ]);
      if (result.exitCode !== 0) {
        await rm(repoDir, { recursive: true, force: true });
      }
      // 7. Delete git branch
      const branchResult = await spawnCtx.run(["git", "-C", repoPath, "branch", "-D", `agent/${agentId}`]);
      if (branchResult.exitCode === 0) {
        await logAgent(agentDir, `Deleted branch agent/${agentId}`);
      }
    }
  } catch { /* ignore */ }

  // 8. Archive — also performs the eager team-membership prune (§16.5) and
  // returns the pruned (team, id) pairs, which we thread up to the command
  // layer so it can fan out the leave notice.
  const { prunedTeams, warnings } = await archiveAgent(
    repoPath,
    agentId,
    agentDir,
    preparedRetirement,
  );

  // 9. Finish external lifecycle cleanup while agentDir/meta still exist. A
  // checked seal deletion uses this boundary so failure leaves a retryable
  // stopped/archive state instead of silently orphaning protected state.
  if (beforeRemove) await beforeRemove();

  // 10. Remove agent directory
  const removalWarning = await removeArchivedAgentDirectory(agentDir);
  if (removalWarning) warnings.push(removalWarning);
  return { ok: !removalWarning, prunedTeams, warnings };
}

// ── scanAndKillOrphans ───────────────────────────────────────────────────────

/**
 * Spawn context for the orphan scan's two commands: the process listing (`ps`)
 * and the cwd read (`lsof`). It is separate from {@link spawnCtx} so the
 * `bun test` preload (test-preload.ts) can make a no-op runner its baseline: a
 * test that forgets to stub it lists no processes, so no test can run the scan
 * against the live process table, where it would kill real processes.
 */
export const orphanScanSpawnCtx = new SpawnContext();

/** The scan's process listing: every process, its whole command line. */
const ORPHAN_SCAN_PS_ARGV = ["ps", "-A", "-ww", "-o", "pid=,command="];

/** A process's cwd as the scan reads it. */
interface ProcessCwd {
  path: string;
  /** The cwd directory's inode, or null when it could not be read. */
  inode: bigint | null;
}

/** Parse `ps -o pid=,command=` output into pid + command line pairs. */
function parsePsCommands(stdout: string): Array<{ pid: number; command: string }> {
  const out: Array<{ pid: number; command: string }> = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*\S)/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    if (pid > 0) out.push({ pid, command: m[2]! });
  }
  return out;
}

/**
 * Whether a command line is a `bun test` run: argv[0]'s basename is `bun` and
 * the first argument is `test`. ps joins argv with spaces, so the line is
 * split on whitespace. Only the bun process itself matches: not a claude
 * process whose prompt mentions "bun test", and not a `bash -c "bun test"`
 * wrapper, which exits on its own once its bun child dies.
 */
export function isBunTestCommand(command: string): boolean {
  const [argv0, firstArg] = command.trim().split(/\s+/);
  return argv0 !== undefined && basename(argv0) === "bun" && firstArg === "test";
}

/**
 * Parse `lsof -Fpin` output into a pid → cwd map. A `p<pid>` line starts a
 * process set, an `i<inode>` line gives the inode and an `n<path>` line the
 * path of the current process's file; every other field lsof always emits
 * (e.g. `f<fd>`) is ignored. The first `i` and `n` line of a process win. A
 * process with no `n` line is absent from the map.
 */
function parseLsofCwds(stdout: string): Map<number, ProcessCwd> {
  const cwds = new Map<number, ProcessCwd>();
  const inodes = new Map<number, bigint>();
  let currentPid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = parseInt(line.slice(1), 10);
      currentPid = isNaN(pid) ? null : pid;
    } else if (currentPid === null) {
      continue;
    } else if (line.startsWith("i") && /^\d+$/.test(line.slice(1)) && !inodes.has(currentPid)) {
      inodes.set(currentPid, BigInt(line.slice(1)));
    } else if (line.startsWith("n") && !cwds.has(currentPid)) {
      cwds.set(currentPid, { path: line.slice(1), inode: null });
    }
  }
  for (const [pid, cwd] of cwds) cwd.inode = inodes.get(pid) ?? null;
  return cwds;
}

/** Linux: a process's cwd from /proc/<pid>/cwd, or null when unreadable. */
async function readProcCwd(pid: number): Promise<ProcessCwd | null> {
  try {
    const path = await readlink(`/proc/${pid}/cwd`);
    let inode: bigint | null = null;
    try {
      inode = (await stat(`/proc/${pid}/cwd`, { bigint: true })).ino;
    } catch { /* inode unknown: judged by the path alone */ }
    return { path, inode };
  } catch {
    return null;
  }
}

/**
 * The claude rule: a cwd inside an agent directory that no longer exists.
 * Returns the kill reason, or null to leave the process alone.
 */
async function claudeOrphanReason(cwd: string): Promise<string | null> {
  // Safety check 1: Must contain "/.itsybitsy/agents/"
  if (runtimeNames.firstAgentsMarker(cwd) === -1) return null;
  // Safety check 2: Extract agent dir and verify it doesn't exist
  const match = runtimeNames.matchAgentPrefix(cwd);
  if (!match) return null;
  try {
    await readdir(match[1]!);
    return null; // Dir exists — not an orphan
  } catch {
    return "agent-dir-deleted";
  }
}

/**
 * The `bun test` rule: the cwd directory no longer exists, anywhere on disk.
 * A path that exists but is not the same directory (another inode than the
 * process's cwd, as for an agent re-created under the same name, or not a
 * directory at all) counts as gone. Any other stat failure (EACCES, say)
 * leaves the process alone. Returns the kill reason, or null.
 */
async function bunTestOrphanReason(cwd: ProcessCwd): Promise<string | null> {
  let info;
  try {
    info = await stat(cwd.path, { bigint: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "bun-test-cwd-deleted" : null;
  }
  if (!info.isDirectory()) return "bun-test-cwd-replaced";
  if (cwd.inode !== null && info.ino !== cwd.inode) return "bun-test-cwd-replaced";
  return null;
}

/**
 * Find orphaned processes and kill them through {@link terminateProcess}
 * (SIGTERM, then SIGKILL after the grace period). Two rules, from one `ps`
 * listing of every process:
 *
 *  - a command line containing `claude` (the match `pgrep -f claude` made)
 *    whose cwd is inside a deleted agent directory → `agent-dir-deleted`;
 *  - a `bun test` process ({@link isBunTestCommand}) whose cwd directory no
 *    longer exists anywhere on disk → `bun-test-cwd-deleted`, or whose cwd
 *    path now names another directory → `bun-test-cwd-replaced`.
 *
 * The claude rule is tried first. On macOS, one lsof call reads the cwd and its
 * inode for every candidate PID; elsewhere, /proc/<pid>/cwd is read per PID.
 * The scan is process-wide: it reads no repo or agents directory of its own.
 * Returns count of killed orphans.
 */
export async function scanAndKillOrphans(): Promise<number> {
  const listing = await orphanScanSpawnCtx.run(ORPHAN_SCAN_PS_ARGV);
  if (listing.exitCode !== 0 || !listing.stdout) return 0;

  const candidates = parsePsCommands(listing.stdout)
    .map(({ pid, command }) => ({ pid, claude: command.includes("claude"), bunTest: isBunTestCommand(command) }))
    .filter((c) => c.claude || c.bunTest);
  if (candidates.length === 0) return 0;

  // macOS: read every cwd with ONE lsof call (a per-PID call cost ~80ms each,
  // which held up the post-merge refresh in `ib watch` for seconds). lsof exits
  // non-zero when some PIDs exited after ps but still prints the rest, so
  // the output is parsed whatever the exit code.
  let darwinCwds: Map<number, ProcessCwd> | null = null;
  if (process.platform === "darwin") {
    const lsofResult = await orphanScanSpawnCtx.run([
      "lsof", "-a", "-d", "cwd", "-p", candidates.map((c) => c.pid).join(","), "-Fpin",
    ]);
    darwinCwds = parseLsofCwds(lsofResult.stdout);
    if (darwinCwds.size === 0) return 0;
  }

  let killedCount = 0;
  for (const candidate of candidates) {
    const cwd = darwinCwds !== null
      ? darwinCwds.get(candidate.pid) ?? null
      : await readProcCwd(candidate.pid);
    if (!cwd?.path) continue;

    const reason =
      (candidate.claude ? await claudeOrphanReason(cwd.path) : null) ??
      (candidate.bunTest ? await bunTestOrphanReason(cwd) : null);
    if (!reason) continue;

    // Kill the orphan via the canonical funnel — extract the agent id from
    // the cwd path so the watch.log line carries provenance.
    const agentPath = runtimeNames.matchAgentPrefix(cwd.path)?.[1];
    const orphanAgentId = agentPath?.match(/\/agents\/([^/]+)$/)?.[1];
    const result = await terminateProcess({
      pid: candidate.pid,
      label: "lifecycle-orphan",
      agentId: orphanAgentId,
      reason,
    });
    if (result.killed && result.outcome !== "not-alive") killedCount++;
  }

  return killedCount;
}

// ── getDescendantsRecursive ──────────────────────────────────────────────────

/**
 * Depth-first descendant collection.
 * Returns all descendants including the manager itself as first element.
 */
export async function getDescendantsRecursive(
  agentsDir: string,
  managerId: string
): Promise<string[]> {
  const result: string[] = [managerId];

  let entries: string[];
  try {
    const dirEntries = await readdir(agentsDir, { withFileTypes: true });
    entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const metaPath = join(agentsDir, entry, "meta.json");
    try {
      const file = Bun.file(metaPath);
      if (!(await file.exists())) continue;
      const meta = await file.json();
      if (meta.manager === managerId) {
        const children = await getDescendantsRecursive(agentsDir, entry);
        result.push(...children);
      }
    } catch { /* skip malformed meta */ }
  }

  return result;
}

// ── isRunningAsAgent ─────────────────────────────────────────────────────────

/**
 * Check if we're running inside an agent context.
 * True if cwd matches agent worktree path pattern
 * OR if inside an itsybitsy tmux session.
 */
export async function isRunningAsAgent(cwd?: string): Promise<boolean> {
  const dir = cwd ?? process.cwd();

  // Primary check: worktree path pattern
  if (runtimeNames.AGENT_WORKTREE_PATTERN.test(dir)) {
    return true;
  }

  // Secondary check: ib-spawned tmux session name
  if (process.env.TMUX) {
    try {
      const result = await spawnCtx.run(["tmux", "display-message", "-p", "#{session_name}"]);
      if (result.exitCode === 0 && runtimeNames.isAgentTmuxSession(result.stdout)) {
        return true;
      }
    } catch { /* ignore */ }
  }

  return false;
}

// ── resolveGitRoot ───────────────────────────────────────────────────────────

async function readGitPipe(
  stream: ReadableStream<Uint8Array> | null,
  readers: ReadableStreamDefaultReader<Uint8Array>[],
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  readers.push(reader);
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function runGitRootQuery(repoPath: string, flags: string[], signal?: AbortSignal) {
  const deadline = Promise.withResolvers<never>();
  const onAbort = () => deadline.reject(signal?.reason);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let proc: SpawnResult | undefined;
  try {
    signal?.throwIfAborted();
    signal?.addEventListener("abort", onAbort);
    proc = spawnCtx.runner(
      ["git", "-C", repoPath, "rev-parse", ...flags],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [exitCode, stdout] = await Promise.race([
      Promise.all([proc.exited, readGitPipe(proc.stdout, readers), readGitPipe(proc.stderr, readers)]),
      deadline.promise,
    ]);
    return { exitCode, stdout };
  } catch (err) {
    // A wrapper's descendants can hold the pipes open after the wrapper dies.
    for (const reader of readers) void reader.cancel().catch(() => {});
    try { proc?.kill?.("SIGKILL"); } catch { /* the child may have already exited */ }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Resolve the main repository root, including from inside a linked worktree. */
export async function resolveGitRoot(repoPath: string, signal?: AbortSignal): Promise<string | null> {
  const query = (...flags: string[]) => runGitRootQuery(repoPath, flags, signal);
  try {
    const combined = await query("--git-common-dir", "--git-dir", "--show-toplevel");
    if (combined.exitCode === 0) {
      const fields = combined.stdout.replace(/\n$/, "").split("\n");
      const [commonDir, gitDir, topLevel] = fields.map((field) => field.trim());
      if (fields.length === 3 && commonDir && gitDir && topLevel) {
        return commonDir === ".git" || commonDir === gitDir ? topLevel : dirname(resolve(repoPath, commonDir));
      }
    }

    // A path can contain a newline, and --show-toplevel can fail inside a
    // worktree's admin directory even when its common directory is usable.
    const common = await query("--git-common-dir");
    if (common.exitCode === 0) {
      const commonDir = common.stdout.trim();
      const gitDir = await query("--git-dir");
      if (commonDir !== ".git" && commonDir !== gitDir.stdout.trim()) return dirname(resolve(repoPath, commonDir));
    }
    const top = await query("--show-toplevel");
    return top.exitCode === 0 ? top.stdout.trim() : null;
  } catch {
    return null;
  }
}

// ── Exported for testing ─────────────────────────────────────────────────────

/** @internal Exposed for testing only */
export { formatLogTimestamp as _formatTimestamp, formatArchiveTimestamp as _formatArchiveTimestamp };
