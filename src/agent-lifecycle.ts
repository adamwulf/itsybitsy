/**
 * Shared agent lifecycle helpers used by multiple ib commands.
 * Mirrors the behavior of the ib bash script's teardown, archive,
 * kill, and utility functions.
 */

import { join, dirname, resolve } from "path";
import {
  readdir,
  mkdir,
  cp,
  rm,
  rename,
  appendFile,
  lstat,
  readlink,
  symlink,
} from "fs/promises";
import { SpawnContext } from "./types";
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
import { pruneAgentFromAllTeams } from "./teams";
import { logWarning } from "./watch-log";

/** Spawn context for agent lifecycle operations */
export const spawnCtx = new SpawnContext();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a date as YYYY-MM-DD HH:MM:SS in local time */
function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

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
      raw.headRef !== `refs/ittybitty/retired/${raw.archiveKey}/head`
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
  const archivePath = join(repoPath, ".ittybitty", "archive", archiveKey);
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

      headRef = `refs/ittybitty/retired/${archiveKey}/head`;
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
  const archiveRoot = join(repoPath, ".ittybitty", "archive");
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
    const line = `[${formatTimestamp()}] ${message}\n`;
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
 * Remove entries for the given agent from .ittybitty/user-questions.json.
 */
export async function removeAgentQuestions(repoPath: string, agentId: string): Promise<void> {
  const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");
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
  /** Archive folder path, or null if there were no artifacts to archive. */
  archivePath: string | null;
  /** `(team, id)` pairs this agent was pruned from (empty if it was in no team). */
  prunedTeams: Array<{ team: string; id: string }>;
}

/**
 * Archive agent artifacts to .ittybitty/archive/YYYYMMDD-HHMMSS-<id>/.
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

  const archiveDir = join(repoPath, ".ittybitty", "archive");
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
      pendingHeadRef ===
        `refs/ittybitty/retired/${pendingArchiveKey}/head`
    ) {
      await spawnCtx.run([
        "git", "-C", repoPath, "update-ref", "-d", pendingHeadRef,
      ]).catch(() => {});
    }
  }

  if (!hasOutput && !hasLog && !hasMeta && !preparedRetirement) {
    return { archivePath: null, prunedTeams };
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
  if (hasMeta) {
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
  // best-effort rmdir's the per-agent outbox subdir.
  await deleteAgentOutbox(agentOutboxDir(agentId));

  return { archivePath: archiveFolder, prunedTeams };
}

// ── teardownAgent ────────────────────────────────────────────────────────────

export interface TeardownMeta {
  tmux_session: string;
  claude_pid?: string;
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
): Promise<{ ok: boolean; prunedTeams: Array<{ team: string; id: string }> }> {
  const tmuxSession = meta.tmux_session;

  if (!isValidTmuxSession(tmuxSession)) {
    // §16.5 makes the eager team prune UNCONDITIONAL. archiveAgent (which
    // normally runs the prune) is skipped on this early-return path, so prune
    // here directly — otherwise an agent with a corrupt tmux_session would be
    // silently left in its teams until a later lazy prune self-healed it.
    const prunedTeams = await pruneAgentFromAllTeams(agentId);
    logWarning(`[agent-lifecycle] Invalid tmux session name in meta for agent ${agentId}: ${tmuxSession}`);
    return { ok: false, prunedTeams };
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
  const { prunedTeams } = await archiveAgent(
    repoPath,
    agentId,
    agentDir,
    preparedRetirement,
  );

  // 9. Remove agent directory
  try {
    await rm(agentDir, { recursive: true, force: true });
    return { ok: true, prunedTeams };
  } catch {
    return { ok: false, prunedTeams };
  }
}

// ── scanAndKillOrphans ───────────────────────────────────────────────────────

/**
 * Find orphaned Claude processes whose cwd is in a deleted agent directory.
 * On macOS, uses lsof to get process cwd.
 * Returns count of killed orphans.
 */
export async function scanAndKillOrphans(agentsDir: string): Promise<number> {
  let killedCount = 0;

  // Get all Claude PIDs
  const pgrepResult = await spawnCtx.run(["pgrep", "-f", "claude"]);
  if (pgrepResult.exitCode !== 0 || !pgrepResult.stdout) return 0;

  const pids = pgrepResult.stdout.split("\n").filter((p) => p.trim());

  for (const pidStr of pids) {
    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) continue;

    // Get process cwd (macOS)
    let procCwd = "";
    if (process.platform === "darwin") {
      const lsofResult = await spawnCtx.run(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
      if (lsofResult.exitCode === 0) {
        const nLine = lsofResult.stdout.split("\n").find((l) => l.startsWith("n"));
        if (nLine) procCwd = nLine.slice(1);
      }
    } else {
      try {
        const { readlink } = await import("fs/promises");
        procCwd = await readlink(`/proc/${pid}/cwd`);
      } catch { /* ignore */ }
    }

    if (!procCwd) continue;

    // Safety check 1: Must contain "/.ittybitty/agents/"
    if (!procCwd.includes("/.ittybitty/agents/")) continue;

    // Safety check 2: Extract agent dir and verify it doesn't exist
    const match = procCwd.match(/(.*\/.ittybitty\/agents\/[^/]+)/);
    if (!match) continue;
    const agentPath = match[1]!;

    // Skip if directory still exists
    try {
      await readdir(agentPath);
      continue; // Dir exists — not an orphan
    } catch { /* dir doesn't exist — orphan confirmed */ }

    // Kill the orphan via the canonical funnel — extract the agent id from
    // the cwd path so the watch.log line carries provenance.
    const idMatch = agentPath.match(/\/agents\/([^/]+)$/);
    const orphanAgentId = idMatch ? idMatch[1] : undefined;
    const result = await terminateProcess({
      pid,
      label: "lifecycle-orphan",
      agentId: orphanAgentId,
      reason: "agent-dir-deleted",
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
 * OR if inside an ittybitty tmux session.
 */
export async function isRunningAsAgent(cwd?: string): Promise<boolean> {
  const dir = cwd ?? process.cwd();

  // Primary check: worktree path pattern
  if (/\/.ittybitty\/agents\/[^/]+\/repo/.test(dir)) {
    return true;
  }

  // Secondary check: ib-spawned tmux session name
  if (process.env.TMUX) {
    try {
      const result = await spawnCtx.run(["tmux", "display-message", "-p", "#{session_name}"]);
      if (result.exitCode === 0 && result.stdout.startsWith("ittybitty-")) {
        return true;
      }
    } catch { /* ignore */ }
  }

  return false;
}

// ── resolveGitRoot ───────────────────────────────────────────────────────────

/**
 * Resolve the root repository path (handles worktrees).
 * Uses git -C repoPath rev-parse --show-toplevel, with git-common-dir
 * fallback for worktree resolution.
 */
export async function resolveGitRoot(repoPath: string): Promise<string | null> {
  try {
    // Get the common git directory (shared across all worktrees)
    const commonResult = await spawnCtx.run(["git", "-C", repoPath, "rev-parse", "--git-common-dir"]);
    if (commonResult.exitCode !== 0) {
      // Fallback
      const topResult = await spawnCtx.run(["git", "-C", repoPath, "rev-parse", "--show-toplevel"]);
      return topResult.exitCode === 0 ? topResult.stdout : null;
    }

    const commonDir = commonResult.stdout;
    const gitDirResult = await spawnCtx.run(["git", "-C", repoPath, "rev-parse", "--git-dir"]);

    // If common_dir is ".git" or matches --git-dir, we're in the main repo
    if (commonDir === ".git" || commonDir === gitDirResult.stdout) {
      const topResult = await spawnCtx.run(["git", "-C", repoPath, "rev-parse", "--show-toplevel"]);
      return topResult.exitCode === 0 ? topResult.stdout : null;
    }

    // common_dir points to the shared .git directory — resolve to absolute, then go up one level
    return dirname(resolve(repoPath, commonDir));
  } catch {
    return null;
  }
}

// ── Exported for testing ─────────────────────────────────────────────────────

/** @internal Exposed for testing only */
export { formatTimestamp as _formatTimestamp, formatArchiveTimestamp as _formatArchiveTimestamp };
