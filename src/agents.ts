/**
 * Read .ittybitty/agents/ directory directly to get agent data.
 * Also reads user-questions.json for pending questions.
 */

import { join } from "path";
import { readdir, rename, stat, unlink } from "fs/promises";
import type { AgentState } from "./parse-state";
import { parseState, stripAnsi, STARTUP_MARKERS } from "./parse-state";
import { captureTmuxOutput, listTmuxSessions } from "./tmux-poller";
import { InjectionContext } from "./types";
import { logToWatchLog } from "./watch-log";

/** States that can be written to meta.json */
export type MetaState = "creating" | "running" | "waiting" | "complete" | "stopped";

/** Cross-repo spawner provenance — records which agent created this one.
 *
 * `agent_id` may be a real agent ID (e.g. "agent-1234abcd") or an `@`-prefixed
 * sentinel that resolves through `resolveTarget`:
 *   - `@system` — system coordinator (notifications routed via
 *     sendToSystemCoordinator → tmux send-keys to the ib-coordinator session)
 *   - `@<repo-name>` — that repo's per-repo coordinator (basename-based; see
 *     getCoordinatorAgentId)
 *   - `@telegram` — Phase 5 inbound dispatcher. Never appears as an actual
 *     spawner (the dispatcher does not own agents); it is used purely as
 *     `sendMessage`'s `fromAgent` label so coordinator-bound messages render
 *     as `[sent by @telegram]: ...`. Listed here so future readers don't
 *     wonder where it comes from.
 *
 * `repo_path` is the spawner's repo when the spawner is a real agent or a
 * per-repo coordinator. It is `null` for the `@system` sentinel because the
 * system coordinator does not live inside a registered repo. (The same would
 * apply to `@telegram` if it ever appeared here.)
 *
 * KNOWN MAINTENANCE FOOTGUN: this is a conceptually N-way union (real ID |
 * @system | @<repo-name> | @telegram for sendMessage labels) packed into a
 * single string. A future caller that does `findAgent(spawned_by.agent_id)`
 * directly will silently no-op for any sentinel. If you add a new reader,
 * route through the watchdog notify path (or build a discriminated union)
 * rather than open-coding the lookup. Reviewers flagged a discriminated-union
 * refactor as the eventual fix; deferred for scope.
 */
export interface SpawnedBy {
  agent_id: string;
  repo_path: string | null;
}

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
  summary?: string;
  watchdog_pid?: number;
  coordinator?: boolean;
  agentType?: string;
  agentIcon?: string;
  state?: MetaState;
  state_updated_at?: number;
  spawned_by?: SpawnedBy | null;
}

/** Resolve the display icon for an agent from meta fields with legacy fallback */
export function resolveAgentIcon(meta: AgentMeta): string {
  if (meta.agentIcon) return meta.agentIcon;
  if (meta.coordinator) return "◇";
  if (meta.worker) return "⚙";
  return "◆";
}

/**
 * Resolve a single-character icon for text-only contexts (e.g. inject-status).
 * Uses agentIcon if single char, else derives from agentType name or legacy booleans.
 */
export function resolveAgentIconChar(meta: AgentMeta): string {
  if (meta.agentIcon && meta.agentIcon.length === 1) return meta.agentIcon;
  if (meta.agentType) {
    if (meta.agentType === "coordinator") return "c";
    if (meta.agentType === "worker") return "w";
    return meta.agentType[0] ?? "m";
  }
  if (meta.coordinator) return "c";
  if (meta.worker) return "w";
  return "m";
}

export interface Agent {
  id: string;
  repoPath: string;
  repoName: string;
  meta: AgentMeta;
  state: AgentState;
  age: string;
  archived: boolean;
  orphaned?: boolean;
  children: Agent[];
}

export interface PendingQuestion {
  id: string;
  agent: string;
  question: string;
  timestamp: string;
  status: "pending" | "acknowledged";
}

/** Grace period for newly created agents before treating missing tmux as "stopped" (ms) */
export const CREATING_GRACE_PERIOD_MS = 6_000;

/** Check if an agent was created recently (within the grace period).
 * Uses created_epoch (seconds since epoch) from meta.json. */
export function isRecentlyCreated(createdEpoch: number): boolean {
  if (!createdEpoch) return false;
  const ageMs = Date.now() - createdEpoch * 1000;
  return ageMs < CREATING_GRACE_PERIOD_MS;
}

/**
 * Check if an agent directory was recently created (within the grace period).
 * Uses the directory's filesystem birthtime. Used to suppress read errors for
 * directories that are still being set up by `ib new-agent`.
 *
 * Injectable via `isRecentlyCreatedDirCtx` for testing.
 */
async function _isRecentlyCreatedDir(dirPath: string): Promise<boolean> {
  try {
    const dirStat = await stat(dirPath);
    const ageMs = Date.now() - dirStat.birthtimeMs;
    return ageMs < CREATING_GRACE_PERIOD_MS;
  } catch {
    return false;
  }
}

export const isRecentlyCreatedDirCtx = new InjectionContext<(dirPath: string) => Promise<boolean>>(_isRecentlyCreatedDir);

/** Window during which a `[spawn] start` log line without a terminating
 * `spawn OK` / `spawn FAILED` is treated as an in-progress spawn rather than
 * an orphaned agent dir. Tuned for slow `git worktree add` on large repos
 * (60–90s checkouts), with headroom. */
export const SPAWN_IN_PROGRESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * Result of inspecting agent.log to classify a missing-meta.json directory.
 * - "in_progress": [spawn] start within window, no terminating line → render as creating
 * - "orphan": no start line, or stale, or terminated → existing orphan behavior
 */
export type SpawnLogStatus =
  | { kind: "in_progress"; startEpochMs: number }
  | { kind: "orphan" };

/**
 * Parse an agent.log to determine whether a spawn is currently in progress.
 * Used by readAgentsFromDir() to differentiate slow-but-running spawns (which
 * the dashboard should render as state='creating') from truly orphaned dirs.
 *
 * Looks for the most recent `[spawn] start` line and checks that no
 * `spawn OK` or `spawn FAILED` line appears after it within the window.
 */
async function _classifySpawnLog(agentDir: string): Promise<SpawnLogStatus> {
  const logPath = join(agentDir, "agent.log");
  let text: string;
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) return { kind: "orphan" };
    text = await file.text();
  } catch {
    return { kind: "orphan" };
  }

  // Lines look like:  [2026-04-28 15:45:57] [spawn] start id=agent-xxx ...
  // Walk from the end so we find the most recent start.
  const lines = text.split("\n");
  let startIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes("[spawn] start ")) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return { kind: "orphan" };

  // Any terminator AFTER the start line means the spawn is no longer in progress.
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes("spawn OK") || line.includes("spawn FAILED")) {
      return { kind: "orphan" };
    }
  }

  // Parse timestamp from the start line: [YYYY-MM-DD HH:MM:SS]
  const startLine = lines[startIdx]!;
  const tsMatch = startLine.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/);
  if (!tsMatch) return { kind: "orphan" };
  // logAgent() writes timestamps in local time, so parse as local.
  const [, y, mo, d, h, mi, s] = tsMatch;
  const startEpochMs = new Date(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(s),
  ).getTime();
  if (!Number.isFinite(startEpochMs)) return { kind: "orphan" };

  if (nowMsCtx.fn() - startEpochMs > SPAWN_IN_PROGRESS_WINDOW_MS) {
    return { kind: "orphan" };
  }
  return { kind: "in_progress", startEpochMs };
}

export const classifySpawnLogCtx = new InjectionContext<(agentDir: string) => Promise<SpawnLogStatus>>(_classifySpawnLog);

/**
 * Write agent state to meta.json atomically (write .tmp, rename over original).
 * No-op if meta.json doesn't exist.
 */
export async function writeAgentState(agentDir: string, state: MetaState): Promise<void> {
  const metaPath = join(agentDir, "meta.json");
  const file = Bun.file(metaPath);
  if (!(await file.exists())) return;

  try {
    const data = await file.json();
    data.state = state;
    data.state_updated_at = Math.floor(Date.now() / 1000);
    const tmpPath = metaPath + ".tmp";
    await Bun.write(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, metaPath);
  } catch {
    /* best-effort — don't crash on write failures */
  }
}

/**
 * Transient observations about an agent, owned by the per-agent watchdog.
 * Persisted to meta.transient.json (sibling of meta.json) so ib watch can
 * read the watchdog's classification instead of running its own tmux capture.
 *
 * The watchdog is the single writer — no locks needed. Readers must check
 * watchdog liveness (process.kill(pid, 0)) and freshness (updated_at_ms)
 * before trusting these fields, and fall back to live capture otherwise.
 */
export interface TransientState {
  tmux_compacting: boolean;
  tmux_rate_limited: boolean;
  tmux_api_error: boolean;
  has_background_tasks: boolean;
  updated_at_ms: number;
  watchdog_pid: number;
}

/**
 * Read meta.transient.json for an agent. Returns null if missing or malformed.
 */
export async function readAgentTransient(agentDir: string): Promise<TransientState | null> {
  const path = join(agentDir, "meta.transient.json");
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const data = await file.json();
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.tmux_compacting !== "boolean" ||
      typeof data.tmux_rate_limited !== "boolean" ||
      typeof data.has_background_tasks !== "boolean" ||
      typeof data.updated_at_ms !== "number" ||
      typeof data.watchdog_pid !== "number"
    ) {
      return null;
    }
    return {
      tmux_compacting: data.tmux_compacting,
      tmux_rate_limited: data.tmux_rate_limited,
      // Field added later — older transient files default to false on read.
      tmux_api_error: typeof data.tmux_api_error === "boolean" ? data.tmux_api_error : false,
      has_background_tasks: data.has_background_tasks,
      updated_at_ms: data.updated_at_ms,
      watchdog_pid: data.watchdog_pid,
    };
  } catch {
    return null;
  }
}

/**
 * Write meta.transient.json atomically (.tmp + rename).
 * Best-effort: silently swallows write errors so a failing watchdog write
 * does not crash the watchdog loop.
 */
export async function writeAgentTransient(agentDir: string, data: TransientState): Promise<void> {
  const path = join(agentDir, "meta.transient.json");
  try {
    const tmpPath = path + ".tmp";
    await Bun.write(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, path);
  } catch {
    /* best-effort */
  }
}

/**
 * Delete meta.transient.json. Used when archiving — transient state has no
 * historical value. Best-effort: any error (including ENOENT) is ignored.
 */
export async function deleteAgentTransient(agentDir: string): Promise<void> {
  const path = join(agentDir, "meta.transient.json");
  try {
    await unlink(path);
  } catch {
    /* best-effort */
  }
}

/**
 * Read agent state from meta.json.
 * Returns the state string or undefined if not present.
 */
export async function readAgentState(agentDir: string): Promise<MetaState | undefined> {
  const metaPath = join(agentDir, "meta.json");
  try {
    const file = Bun.file(metaPath);
    if (!(await file.exists())) return undefined;
    const data = await file.json();
    return data.state;
  } catch {
    return undefined;
  }
}

/**
 * Check if tmux output indicates context compaction in progress.
 * Checks for "Compacting conversation" in last 5 lines.
 */
export function isCompacting(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last5 = lines.slice(-5).join("\n");
  return last5.includes("Compacting conversation");
}

/**
 * Check if tmux output indicates rate limiting.
 * Checks for rate limit patterns in last 15 lines.
 */
export function isRateLimited(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last15 = lines.slice(-15).join("\n");

  if (last15.includes("rate_limit_error")) return true;
  const lower = last15.toLowerCase();
  return (
    lower.includes("usage limit reached") ||
    lower.includes("limit will reset at") ||
    lower.includes("hit your limit") ||
    lower.includes("/upgrade to increase your usage limit")
  );
}

/**
 * Check if tmux output indicates a transient API error from Claude Code.
 *
 * Claude renders these errors as a tool-result line beginning with `⎿  API Error: …`
 * and then idles waiting for the user to type "please retry". We detect a small,
 * conservative family of patterns in the last 15 lines (ANSI-stripped).
 *
 * The leading `⎿` (tool-result connector) is required so we don't false-positive
 * on a watchdog nudge that quotes the phrase "API Error:" inside a sentence.
 */
export function isApiError(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last15 = lines.slice(-15).join("\n");

  // Require the tool-result connector ⎿ followed by "API Error:" — anchor strictly
  // so quoted occurrences in a watchdog nudge ("…the message 'API Error:'…") don't match.
  if (!/⎿\s*API Error:/.test(last15)) return false;

  // Conservative family of recovery-eligible variants. Easier to add patterns
  // later than debug false positives.
  if (/Stream idle timeout/i.test(last15)) return true;
  if (/partial response/i.test(last15)) return true;
  if (/\b5\d{2}\b/.test(last15)) return true; // 500/502/503/...
  if (/Connection error/i.test(last15)) return true;
  if (/fetch failed/i.test(last15)) return true;
  if (/Request was aborted/i.test(last15)) return true;
  if (/ETIMEDOUT/.test(last15)) return true;
  if (/ECONNRESET/.test(last15)) return true;

  return false;
}

/**
 * Check if tmux output indicates background tasks are running.
 * Checks for ⏵⏵ pattern in last 15 lines.
 */
export function hasBackgroundTasks(tmuxOutput: string): boolean {
  const stripped = stripAnsi(tmuxOutput);
  const lines = stripped.split("\n");
  const last15 = lines.slice(-15).join("\n");
  return /⏵⏵.*·\s\d+\s/.test(last15);
}

/**
 * Predicate: does any agent in `allAgents` represent an "active" direct child
 * of `parentId`?
 *
 * "Active" means `meta.manager === parentId` AND `!archived` AND
 * (stored `meta.state === "running"` OR `isRecentlyCreated(meta.created_epoch)`).
 *
 * Deliberately excludes children in `waiting` (would create transitive-waiting
 * deadlock — the top of a parked chain must still be notified) and `complete`
 * (the user needs to merge/kill those). `compacting` and `rate_limited` are
 * transient tmux overrides; the child's stored `meta.state` remains `"running"`
 * in those cases, so they are counted as active without per-child tmux calls.
 *
 * Used for notification suppression in both the stop hook and the watchdog.
 */
export function anyChildActive(parentId: string, allAgents: Agent[]): boolean {
  return allAgents.some((a) =>
    a.meta.manager === parentId &&
    !a.archived &&
    (a.meta.state === "running" || isRecentlyCreated(a.meta.created_epoch))
  );
}

/** Get the worktree path for an agent, or the repo root if worktree is false. */
export function agentWorktreePath(agent: Agent): string {
  if (agent.meta.worktree === false) return agent.repoPath;
  const dir = agent.archived ? "archive" : "agents";
  return join(agent.repoPath, ".ittybitty", dir, agent.id, "repo");
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

/**
 * mtime-keyed cache for parsed meta.json. Invalidates naturally because
 * meta.json mtime only changes on real lifecycle events (Stop hook,
 * sendMessage, resumeAgent, pauseAgent, newAgent). Transient observations
 * live in meta.transient.json — they don't bump meta.json's mtime.
 *
 * Map key: absolute meta.json path. Value: { mtimeMs, meta }.
 * Cache stores a single canonical reference; readers receive a deep copy
 * via structuredClone() so caller mutations to nested objects (e.g.
 * spawned_by) cannot pollute the cache. The shallow-spread alternative
 * leaves spawned_by shared by reference.
 */
const metaCache = new Map<string, { mtimeMs: number; meta: AgentMeta }>();

/** Reset the meta.json mtime cache. Exported for tests. */
export function resetReadAgentMetaCache(): void {
  metaCache.clear();
}

/** Read a single agent's meta.json. Returns meta or an error description.
 * Uses an mtime-keyed cache to avoid re-parsing on every refresh tick when
 * meta.json hasn't changed. */
export async function readAgentMeta(agentDir: string): Promise<{ meta: AgentMeta | null; error?: string }> {
  const metaPath = join(agentDir, "meta.json");

  // Single syscall: stat() returns mtimeMs and confirms existence.
  // Replaces the previous Bun.file().exists() + file.json() pair.
  let mtimeMs: number;
  try {
    const st = await stat(metaPath);
    mtimeMs = st.mtimeMs;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      metaCache.delete(metaPath);
      return { meta: null, error: `Missing ${metaPath}` };
    }
    return { meta: null, error: `Failed to read ${metaPath}: ${err}` };
  }

  const cached = metaCache.get(metaPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { meta: structuredClone(cached.meta) };
  }

  try {
    const file = Bun.file(metaPath);
    const data = await file.json();
    // Basic validation: id is required
    if (!data || typeof data.id !== "string") {
      metaCache.delete(metaPath);
      return { meta: null, error: `Malformed ${metaPath}: missing or invalid 'id'` };
    }
    // Apply sensible defaults for all fields with wrong types
    if (typeof data.session_id !== "string") data.session_id = "";
    if (typeof data.tmux_session !== "string") data.tmux_session = "";
    if (typeof data.prompt !== "string") data.prompt = "";
    if (data.manager !== null && typeof data.manager !== "string") data.manager = null;
    if (typeof data.created !== "string") data.created = "";
    if (typeof data.created_epoch !== "number") data.created_epoch = 0;
    if (typeof data.worktree !== "boolean") data.worktree = true;
    if (typeof data.worker !== "boolean") data.worker = false;
    if (typeof data.yolo !== "boolean") data.yolo = false;
    if (typeof data.model !== "string") data.model = "unknown";
    if (typeof data.claude_pid !== "string") data.claude_pid = "";
    if (data.summary !== undefined && typeof data.summary !== "string") delete data.summary;
    if (data.coordinator !== undefined && typeof data.coordinator !== "boolean") delete data.coordinator;
    if (data.agentType !== undefined && typeof data.agentType !== "string") delete data.agentType;
    if (data.agentIcon !== undefined && typeof data.agentIcon !== "string") delete data.agentIcon;
    // Validate spawned_by: must be an object with string agent_id; repo_path
    // is either a string or null (null is reserved for the @system sentinel
    // whose spawner is not a registered repo).
    if (data.spawned_by !== undefined && data.spawned_by !== null) {
      const sb = data.spawned_by;
      const repoPathOk =
        typeof sb.repo_path === "string" || sb.repo_path === null;
      if (
        typeof sb !== "object" ||
        Array.isArray(sb) ||
        typeof sb.agent_id !== "string" ||
        !repoPathOk
      ) {
        delete data.spawned_by;
      }
    }
    const meta = data as AgentMeta;
    metaCache.set(metaPath, { mtimeMs, meta });
    return { meta: structuredClone(meta) };
  } catch (err) {
    metaCache.delete(metaPath);
    return { meta: null, error: `Failed to read ${metaPath}: ${err}` };
  }
}

export interface ReadAgentsResult {
  agents: Agent[];
  errors: AgentReadError[];
  orphanedTmuxSessions: string[];
  /** Set of all live tmux sessions at refresh time (full list, including non-orphaned). */
  liveTmuxSessions: Set<string>;
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
        // Defense-in-depth: when meta.json is missing on a non-archived dir,
        // check agent.log for an in-progress [spawn] start line. A slow
        // `git worktree add` (large repo, 60-90s) leaves the dir without
        // meta.json briefly. After Fix 1 (early meta.json write) this is
        // rare, but still possible if the early write itself failed.
        if (!archived) {
          const status = await classifySpawnLogCtx.fn(agentDir);
          if (status.kind === "in_progress") {
            // Synthesize a placeholder agent in the "creating" state so the
            // dashboard renders the in-progress spawn instead of treating
            // the dir as orphaned. Fields not knowable yet are left empty.
            const startEpochSec = Math.floor(status.startEpochMs / 1000);
            const placeholderMeta: AgentMeta = {
              id: entry.name,
              session_id: "",
              tmux_session: "",
              prompt: "",
              manager: null,
              created: new Date(status.startEpochMs).toISOString(),
              created_epoch: startEpochSec,
              worktree: false,
              worker: false,
              yolo: false,
              model: "",
              claude_pid: "",
              state: "creating",
              state_updated_at: startEpochSec,
            };
            agents.push({
              id: entry.name,
              repoPath,
              repoName,
              meta: placeholderMeta,
              state: "creating",
              age: computeAge(startEpochSec),
              archived: false,
              children: [],
            });
            continue;
          }
        }
        // Suppress errors for newly-created agent directories — during creation,
        // the directory exists but meta.json may not be written yet.
        const isNewDir = await isRecentlyCreatedDirCtx.fn(agentDir);
        if (!isNewDir) {
          errors.push({ agentDir, error });
        }
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
  } catch (err: unknown) {
    // ENOENT is expected — archive/ or agents/ may not exist yet
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push({ agentDir: dir, error: `Failed to read directory: ${err.message}` });
    }
  }
  return { agents, errors, orphanedTmuxSessions: [], liveTmuxSessions: new Set() };
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
    orphanedTmuxSessions: [],
    liveTmuxSessions: new Set(),
  };
}

/** Internal helper: read questions for a repo, optionally filtering to pending-only */
async function readQuestionsInternal(repoPath: string, pendingOnly: boolean): Promise<PendingQuestion[]> {
  try {
    const questionsPath = join(repoPath, ".ittybitty", "user-questions.json");
    const file = Bun.file(questionsPath);
    if (!(await file.exists())) return [];
    const data = await file.json();
    if (!data || !Array.isArray(data.questions)) return [];

    // Read active agent IDs from the agents directory
    const agentsDir = join(repoPath, ".ittybitty", "agents");
    let activeAgentIds: Set<string>;
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      activeAgentIds = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch (err: unknown) {
      // ENOENT expected when agents/ dir doesn't exist; other errors are unexpected
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(`Warning: failed to read agents directory: ${(err as Error).message}\n`);
      }
      activeAgentIds = new Set();
    }

    return data.questions.filter((q: PendingQuestion) =>
      activeAgentIds.has(q.agent) && (!pendingOnly || q.status === "pending")
    );
  } catch (err: unknown) {
    // Expected: file missing (ENOENT), malformed JSON, etc. — silently return empty
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`Warning: failed to read questions: ${(err as Error).message}\n`);
    }
    return [];
  }
}

/** Read pending questions for a repo, filtering out questions from non-existent agents */
export async function readPendingQuestions(repoPath: string): Promise<PendingQuestion[]> {
  return readQuestionsInternal(repoPath, true);
}

/** Read all questions (pending + acknowledged) for a repo, filtering out questions from non-existent agents */
export async function readAllQuestions(repoPath: string): Promise<PendingQuestion[]> {
  return readQuestionsInternal(repoPath, false);
}

/** Compare agents by created_epoch (chronological — oldest first) */
function byCreatedEpoch(a: Agent, b: Agent): number {
  return a.meta.created_epoch - b.meta.created_epoch;
}

/**
 * Build agent tree: set children arrays based on manager field.
 * Returns only root agents (those with no manager, or whose manager isn't in the list).
 * Siblings at each level are sorted by created_epoch (oldest first).
 */
export function buildAgentTree(agents: Agent[]): Agent[] {
  const byId = new Map<string, Agent>();
  for (const agent of agents) {
    agent.children = [];
    agent.orphaned = false;
    // Non-archived agents take priority over archived ones with the same ID
    const existing = byId.get(agent.id);
    if (!existing || existing.archived) {
      byId.set(agent.id, agent);
    }
  }

  const roots: Agent[] = [];
  for (const agent of agents) {
    const manager = agent.meta.manager ? byId.get(agent.meta.manager) : undefined;
    if (manager && !manager.archived) {
      manager.children.push(agent);
    } else {
      // If manager is set but not found or is archived, mark as orphaned
      if (agent.meta.manager) {
        agent.orphaned = true;
      }
      roots.push(agent);
    }
  }

  // Sort siblings at each level by creation date (oldest first)
  roots.sort(byCreatedEpoch);
  for (const agent of agents) {
    if (agent.children.length > 1) {
      agent.children.sort(byCreatedEpoch);
    }
  }

  return roots;
}

export type FlatEntry =
  | { kind: "agent"; agent: Agent; depth: number; connector: string }
  | { kind: "repo-header"; repoName: string; repoPath: string; hasAgents: boolean }
  | { kind: "system-coordinator"; state: string; age: string };

/**
 * Flatten agent tree into display order (depth-first), with indentation level.
 * Computes box-drawing connector strings (├──, └──, │) for tree display.
 * When repos has > 1 entry, inserts repo header rows and groups agents under them.
 * Empty repos (in repos but with no agents) get a header with repoHasAgents=false.
 *
 * Accepts either string[] (display names, legacy) or {name, path}[] (with paths for selection persistence).
 */
export function flattenAgentTree(
  roots: Agent[],
  repos: string[] | { name: string; path: string }[] = [],
  coordinator?: { state: string; age: string },
): FlatEntry[] {
  // Normalize to {name, path} format
  const repoInfos: { name: string; path: string }[] = repos.map((r) =>
    typeof r === "string" ? { name: r, path: "" } : r
  );
  const repoNames = repoInfos.map((r) => r.name);
  // Build a map from name → path for repo headers
  const repoPathByName = new Map<string, string>();
  for (const r of repoInfos) repoPathByName.set(r.name, r.path);
  const result: FlatEntry[] = [];

  // Prepend system coordinator entry before all repo headers
  if (coordinator) {
    result.push({ kind: "system-coordinator", state: coordinator.state, age: coordinator.age });
  }

  function walk(agent: Agent, depth: number, ancestorIsLast: boolean[]) {
    if (agent.archived) return;

    let connector = "";
    if (ancestorIsLast.length > 0) {
      // Build prefix from ancestors: "│   " if ancestor has more siblings, "    " if last
      for (let i = 0; i < ancestorIsLast.length - 1; i++) {
        connector += ancestorIsLast[i] ? "    " : "│   ";
      }
      // Current level connector
      connector += ancestorIsLast[ancestorIsLast.length - 1] ? "└── " : "├── ";
    }

    result.push({ kind: "agent", agent, depth, connector });
    const nonArchivedChildren = agent.children.filter((c) => !c.archived);
    for (let i = 0; i < nonArchivedChildren.length; i++) {
      const isLast = i === nonArchivedChildren.length - 1;
      walk(nonArchivedChildren[i]!, depth + 1, [...ancestorIsLast, isLast]);
    }
  }

  const nonArchivedRoots = roots.filter((r) => !r.archived);

  if (repoNames.length > 1) {
    // Group roots by repo name
    const repoGroups = new Map<string, Agent[]>();
    for (const agent of nonArchivedRoots) {
      const group = repoGroups.get(agent.repoName) ?? [];
      group.push(agent);
      repoGroups.set(agent.repoName, group);
    }

    // Collect all repo names: from agents + from repoNames (for empty repos)
    const allNames = new Set<string>(repoGroups.keys());
    for (const name of repoNames) allNames.add(name);

    // Sort alphabetically
    const sortedNames = [...allNames].sort((a, b) => a.localeCompare(b));

    for (const repoName of sortedNames) {
      const agents = repoGroups.get(repoName);
      if (agents && agents.length > 0) {
        // Filter out per-repo coordinators — they don't appear in the agent tree
        const nonCoordinators = agents.filter(a => !a.meta.coordinator);
        // Repo with agents — emit repo header then walk agents
        result.push({ kind: "repo-header", repoName, repoPath: repoPathByName.get(repoName) ?? "", hasAgents: nonCoordinators.length > 0 });
        for (let i = 0; i < nonCoordinators.length; i++) {
          const isLast = i === nonCoordinators.length - 1;
          walk(nonCoordinators[i]!, 0, [isLast]);
        }
      } else {
        // Empty repo — just a header
        result.push({ kind: "repo-header", repoName, repoPath: repoPathByName.get(repoName) ?? "", hasAgents: false });
      }
    }
  } else {
    // Filter out per-repo coordinators — they don't appear in the agent tree
    const nonCoordRoots = nonArchivedRoots.filter(a => !a.meta.coordinator);
    const multiRoot = nonCoordRoots.length > 1;
    for (let ri = 0; ri < nonCoordRoots.length; ri++) {
      const isLast = ri === nonCoordRoots.length - 1;
      walk(nonCoordRoots[ri]!, 0, multiRoot ? [isLast] : []);
    }
  }
  return result;
}

/** TTL (ms) for the listTmuxSessions() cache used by readAllAgents(). */
const LIST_TMUX_SESSIONS_TTL_MS = 5_000;

/** Cached result of listTmuxSessions() — debounced fs.watch refreshes can fire
 * many times per second, but the orphan list rarely changes that fast. */
let listTmuxSessionsCache: { value: string[]; expiresAt: number } | null = null;

/** Reset the listTmuxSessions cache. Exported for tests. */
export function resetListTmuxSessionsCache(): void {
  listTmuxSessionsCache = null;
}

/** Fetch the live tmux session list, using the shared TTL cache.
 *  Used by readAllAgents (orphan detection) and detectAgentStates
 *  (verifying tmux is still alive for `complete` agents). */
function getCachedTmuxSessions(): Promise<string[]> {
  const now = Date.now();
  const cached = listTmuxSessionsCache;
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value);
  }
  return listTmuxSessions().then((value) => {
    listTmuxSessionsCache = { value, expiresAt: Date.now() + LIST_TMUX_SESSIONS_TTL_MS };
    return value;
  });
}

/** Injectable tmux-session liveness lookup for tests. Returns the set of
 *  currently live tmux session names. The default implementation calls
 *  getCachedTmuxSessions() lazily and reuses the readAllAgents TTL cache. */
export const liveTmuxSessionsCtx = new InjectionContext<() => Promise<Set<string>>>(
  async () => new Set(await getCachedTmuxSessions())
);

/**
 * Read all agents across multiple repos.
 * Also detects orphaned tmux sessions (sessions matching ittybitty-* pattern
 * that don't correspond to any known agent). The tmux session list is cached
 * for a short TTL so back-to-back refreshes don't each spawn `tmux list-sessions`.
 */
export async function readAllAgents(
  repos: Array<{ path: string; name: string }>
): Promise<ReadAgentsResult> {
  const [results, tmuxSessions] = await Promise.all([
    Promise.all(repos.map((r) => readRepoAgents(r.path, r.name))),
    getCachedTmuxSessions(),
  ]);

  const allAgents = results.flatMap((r) => r.agents);
  const allErrors = results.flatMap((r) => r.errors);

  // Detect orphaned tmux sessions: sessions starting with "ittybitty-"
  // that don't match any known agent's tmux_session
  const knownSessions = new Set(
    allAgents.map((a) => a.meta.tmux_session).filter((s) => s)
  );
  const orphanedTmuxSessions = tmuxSessions.filter(
    (s) => s.startsWith("ittybitty-") && !knownSessions.has(s)
  );

  return {
    agents: allAgents,
    errors: allErrors,
    orphanedTmuxSessions,
    liveTmuxSessions: new Set(tmuxSessions),
  };
}


/**
 * Pre-parseState check: if the output has very few non-empty lines and no
 * Claude startup markers, the agent is still being created (tmux session exists
 * but Claude hasn't rendered yet).
 * Returns "creating" or null (null = fall through to parseState).
 * @deprecated Legacy — retained for backward compatibility. Not used by detectAgentStates().
 */
export function computeStateFromContent(stripped: string): AgentState | null {
  const nonEmptyLines = stripped.split("\n").filter((l) => l.trim() !== "").length;
  if (nonEmptyLines < 10 && !STARTUP_MARKERS.some((m) => stripped.includes(m))) {
    return "creating";
  }
  return null;
}

/**
 * Maximum age (ms) for a meta.transient.json snapshot to be trusted by
 * detectAgentStates(). Set to 3 watchdog ticks (POLL_INTERVAL_MS = 5s).
 * A stale or missing snapshot causes the reader to fall back to a live
 * tmux capture.
 */
export const TRANSIENT_FRESH_MS = 15_000;

/** Default isPidAlive — checks if a process is alive via signal 0. */
function _isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Injectable isPidAlive for tests. */
export const isPidAliveCtx = new InjectionContext<(pid: number) => boolean>(_isPidAlive);

/** Default killPid — sends a signal to a process. Returns true if the kill
 *  syscall succeeded (process existed and we had permission). */
function _killPid(pid: number, signal: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Injectable killPid for tests. */
export const killPidCtx = new InjectionContext<(pid: number, signal: NodeJS.Signals | number) => boolean>(_killPid);

/** Injectable Date.now for tests. */
export const nowMsCtx = new InjectionContext<() => number>(() => Date.now());

/**
 * Reap an orphaned Claude process AND its watchdog: when an agent's tmux
 * session is gone, the Claude process and its per-agent watchdog are no
 * longer reachable from the dashboard and burn CPU/RAM until manually
 * killed. SIGTERM both (if alive) and write a line per kill to
 * ~/.itsybitsy/watch.log so the user has an audit trail.
 *
 * Sources:
 *  - claude_pid: agent.meta.claude_pid (meta.json)
 *  - watchdog_pid: meta.transient.json (read via readAgentTransient)
 *
 * Skipped when:
 *  - the PID is missing/empty/non-numeric (legacy or not-yet-started agents)
 *  - the PID is already dead
 *  - we're about to render the agent as 'creating' (still spawning — Claude
 *    may not have a tmux session yet)
 *
 * Best-effort: failures are swallowed (logged to watch.log); state detection
 * must never block on a kill.
 */
async function reapOrphanedClaude(
  agent: Agent,
  agentDir: string,
  resolvedState: AgentState,
  reason: string
): Promise<void> {
  if (resolvedState === "creating") return;

  const repoTag = agent.repoName ? `${agent.repoName}/` : "";
  const tmuxLabel = agent.meta.tmux_session || "<none>";

  const reap = (kind: "claude" | "watchdog", pid: number): void => {
    if (!Number.isFinite(pid) || pid <= 0) return;
    if (!isPidAliveCtx.fn(pid)) return;
    const ok = killPidCtx.fn(pid, "SIGTERM");
    const status = ok ? "SIGTERM sent" : "SIGTERM failed";
    logToWatchLog(
      `[orphan-kill] ${status} kind=${kind} pid=${pid} agent=${repoTag}${agent.id} ` +
      `tmux=${tmuxLabel} state=${resolvedState} reason=${reason}`
    );
  };

  reap("claude", parseInt(agent.meta.claude_pid, 10));

  // Watchdog PID lives in meta.transient.json, not meta.json
  const transient = await readAgentTransient(agentDir);
  if (transient) reap("watchdog", transient.watchdog_pid);
}

/**
 * Detect agent state for each agent using deterministic meta.json state
 * with tmux overrides for transient states. Mutates agent.state in place.
 *
 * Resolution order:
 * 1. Archived agents → stopped
 * 2. No tmux session → creating (if < 6s old) or stopped
 * 3. Tmux exists → check for compacting/rate_limited overrides
 *    - Fast-path: trust meta.transient.json if its watchdog is alive and
 *      the snapshot is fresh; otherwise fall back to a live tmux capture.
 * 4. Read state from meta.json → return stored value or default to running
 */
export async function detectAgentStates(agents: Agent[]): Promise<void> {
  // Step 1: archived agents
  for (const agent of agents) {
    if (agent.archived) {
      agent.state = "stopped";
    }
  }

  const active = agents.filter((a) => !a.archived);

  // Lazily resolve the live tmux session set — only fetch if at least one
  // agent has meta.state === "complete" (that's the only fast-path that
  // needs to verify tmux liveness; the running/waiting paths already do a
  // captureTmuxOutput which fails on dead sessions). Reuses the
  // listTmuxSessions TTL cache so back-to-back ticks don't respawn tmux.
  const needsLiveTmuxCheck = active.some(
    (a) => a.meta.state === "complete" && a.meta.tmux_session
  );
  const liveTmuxSessionsPromise: Promise<Set<string>> | null = needsLiveTmuxCheck
    ? liveTmuxSessionsCtx.fn()
    : null;

  await Promise.all(
    active.map(async (agent) => {
      const tmuxSession = agent.meta.tmux_session;
      const agentDir = join(agent.repoPath, ".ittybitty", "agents", agent.id);

      // Step 2: check tmux session existence
      if (!tmuxSession) {
        // meta.json is written before `git worktree add` runs (so the dir
        // isn't flagged as orphaned), but tmux_session is only set later
        // once the worktree finishes and tmux starts. On large repos that
        // window can be 60–90s — well past the 6s creating grace period.
        // Consult the spawn log: if a [spawn] start line is present within
        // SPAWN_IN_PROGRESS_WINDOW_MS with no terminator, render as
        // 'creating'. Falls back to 'stopped' if the spawn died (no log,
        // stale, or terminated).
        const status = await classifySpawnLogCtx.fn(agentDir);
        if (status.kind === "in_progress") {
          agent.state = "creating";
          return;
        }
        const resolved: AgentState = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "stopped";
        agent.state = resolved;
        await reapOrphanedClaude(agent, agentDir, resolved, "no tmux_session in meta");
        return;
      }

      // Fast-path: 'complete' agents have signed off — no transient overrides
      // apply (compacting/rate_limited shouldn't happen post-signoff, and the
      // background-task override is scoped to meta.state === "waiting"). Trust
      // the stored state and skip the tmux capture (saves a posix_spawn +
      // ~20 openat() per agent per 2s tick).
      //
      // Liveness gates:
      //   1. tmux session must still exist. If the tmux server was killed or
      //      restarted, Claude can outlive its session as an orphaned process
      //      attached to a regular tty — meaning a PID-only check passes
      //      while the user sees no working tmux pane. Use the cached
      //      list-sessions result (shared with readAllAgents).
      //   2. claude_pid is still alive via signal 0 (free — pure syscall, no
      //      spawn). If Claude died without archiving the agent, demote to
      //      'stopped'. Empty/invalid claude_pid (legacy agents) skips this
      //      check and trusts the tmux gate alone.
      if (agent.meta.state === "complete") {
        if (liveTmuxSessionsPromise) {
          const liveSessions = await liveTmuxSessionsPromise;
          if (!liveSessions.has(tmuxSession)) {
            agent.state = "stopped";
            await reapOrphanedClaude(agent, agentDir, "stopped", "complete agent: tmux session gone");
            return;
          }
        }
        const claudePid = parseInt(agent.meta.claude_pid, 10);
        if (claudePid > 0 && !isPidAliveCtx.fn(claudePid)) {
          agent.state = "stopped";
          return;
        }
        agent.state = "complete";
        return;
      }

      // Fast-path: trust meta.transient.json if its watchdog is alive and
      // the snapshot is fresh. The watchdog already runs the same
      // captureTmuxOutput + classify work every 5s — reusing its result
      // saves ~1 posix_spawn + ~20 file opens per agent per tick.
      //
      // Always read from disk here (not from a preloaded `agent.transient`):
      // the watcher calls pollStates() every 2s using cached _lastAgents
      // from a refresh() that runs every 10s. A preloaded snapshot would
      // age in memory while the watchdog keeps writing fresh data to disk
      // — we'd hit the staleness threshold and fall back to live capture
      // even when fresh data was available on disk. The disk read here is
      // cheap (one stat + a small JSON parse) compared to the tmux spawn
      // we're avoiding.
      const transient = await readAgentTransient(agentDir);
      if (
        transient &&
        transient.updated_at_ms > 0 &&
        nowMsCtx.fn() - transient.updated_at_ms < TRANSIENT_FRESH_MS &&
        isPidAliveCtx.fn(transient.watchdog_pid)
      ) {
        if (transient.tmux_compacting) {
          agent.state = "compacting";
          return;
        }
        if (transient.tmux_rate_limited) {
          agent.state = "rate_limited";
          return;
        }
        if (transient.tmux_api_error) {
          agent.state = "api_error";
          return;
        }
        if (agent.meta.state === "waiting" && transient.has_background_tasks) {
          agent.state = "running";
          return;
        }
        const metaState = agent.meta.state;
        if (metaState) {
          agent.state = metaState;
          return;
        }
        agent.state = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "running";
        return;
      }

      const output = await captureTmuxOutput(tmuxSession, 50);
      if (output === null) {
        const resolved: AgentState = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "stopped";
        agent.state = resolved;
        await reapOrphanedClaude(agent, agentDir, resolved, "tmux capture returned null");
        return;
      }

      // Step 3: tmux exists — check transient overrides
      if (isCompacting(output)) {
        agent.state = "compacting";
        return;
      }
      if (isRateLimited(output)) {
        agent.state = "rate_limited";
        return;
      }
      if (isApiError(output)) {
        agent.state = "api_error";
        return;
      }
      // Background-shell override: waiting agents with a live background
      // shell are actually still doing work. Scoped strictly to
      // meta.state === "waiting" — we do NOT override "complete" (the agent
      // signed off intentionally) or "running" (already correct).
      if (agent.meta.state === "waiting" && hasBackgroundTasks(output)) {
        agent.state = "running";
        return;
      }

      // Step 4: read state from meta.json
      const metaState = agent.meta.state;
      if (metaState) {
        agent.state = metaState;
        return;
      }

      // Legacy: no state field — derive from created_epoch
      agent.state = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "running";
    })
  );
}

/**
 * Read prompt.txt for a given agent.
 * Falls back to meta.prompt if prompt.txt doesn't exist.
 */
export async function readAgentPrompt(agent: Agent): Promise<string[]> {
  const dir = agent.archived ? "archive" : "agents";
  const promptPath = join(agent.repoPath, ".ittybitty", dir, agent.id, "prompt.txt");
  try {
    const file = Bun.file(promptPath);
    if (!(await file.exists())) {
      // Fall back to meta.json prompt field
      return agent.meta.prompt ? agent.meta.prompt.split("\n") : ["No prompt available"];
    }
    const text = await file.text();
    return text ? text.split("\n") : ["prompt.txt is empty"];
  } catch {
    return agent.meta.prompt ? agent.meta.prompt.split("\n") : ["Failed to read prompt"];
  }
}

export interface DenialEntry {
  timestamp: string;
  epoch: number;
  line: string;
}

/**
 * Parse agent.log for tool denial lines.
 * Format: [YYYY-MM-DD HH:MM:SS] [PreToolUse] Permission denied: ...
 */
export function parseDenials(logLines: string[]): DenialEntry[] {
  const denials: DenialEntry[] = [];
  const pattern = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[PreToolUse\] Permission denied:/;
  for (const line of logLines) {
    const match = pattern.exec(line);
    if (match) {
      const timestamp = match[1]!;
      const epoch = new Date(timestamp.replace(" ", "T")).getTime() / 1000;
      denials.push({ timestamp, epoch, line });
    }
  }
  return denials;
}

/**
 * Read agent.log file for a given agent.
 * Returns the log content as an array of lines, or a placeholder message.
 */
export async function readAgentLog(agent: Agent): Promise<string[]> {
  const dir = agent.archived ? "archive" : "agents";
  const logPath = join(agent.repoPath, ".ittybitty", dir, agent.id, "agent.log");
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      return [`No agent.log found`];
    }
    const text = await file.text();
    if (!text.trim()) {
      return [`agent.log is empty`];
    }
    return text.split("\n");
  } catch {
    return [`Failed to read agent.log`];
  }
}

/**
 * Stat the agent.log file and return its current size, or null if it does
 * not exist. Used by the AGENT LOG cache layer to detect whether the file
 * has grown since the last tail read.
 */
export async function statAgentLogSize(agent: Agent): Promise<number | null> {
  const dir = agent.archived ? "archive" : "agents";
  const logPath = join(agent.repoPath, ".ittybitty", dir, agent.id, "agent.log");
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) return null;
    return file.size;
  } catch {
    return null;
  }
}

/** Tail-window snapshot of an agent.log */
export interface LogWindow {
  /** Lines in chronological order (newest-last). If start > 0, the partial first line is dropped. */
  lines: string[];
  /** Total file size in bytes (used for cache invalidation). */
  fileSize: number;
  /** True if the read started at byte 0 (the entire file is in `lines`). */
  atTop: boolean;
  /**
   * Whether `lines` contains a placeholder message (file missing/empty/error)
   * rather than real log content. Callers can use this to skip the cache.
   */
  isPlaceholder: boolean;
}

export interface ReadLogWindowOpts {
  /** Visible rows (typically displayHeight) */
  rows: number;
  /** Lines back from bottom; 0 = newest at the bottom */
  scrollOffset: number;
  /** Over-fetch factor; default 2 * rows */
  bufferRows?: number;
}

/** Approximate bytes-per-line — used to size the tail read */
const BYTES_PER_LINE_ESTIMATE = 200;
/** Minimum bytes to read even for very small windows */
const MIN_TAIL_BYTES = 8192;

/**
 * Read only the tail of agent.log needed to display the requested window.
 *
 * The window covers `rows + scrollOffset + bufferRows` lines back from the end
 * of the file. To guarantee we land on a line boundary, the first (potentially
 * partial) line is dropped whenever the read started past byte 0.
 */
export async function readAgentLogWindow(
  agent: Agent,
  opts: ReadLogWindowOpts,
): Promise<LogWindow> {
  const dir = agent.archived ? "archive" : "agents";
  const logPath = join(agent.repoPath, ".ittybitty", dir, agent.id, "agent.log");
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      return { lines: [`No agent.log found`], fileSize: 0, atTop: true, isPlaceholder: true };
    }
    const fileSize = file.size;
    if (fileSize === 0) {
      return { lines: [`agent.log is empty`], fileSize: 0, atTop: true, isPlaceholder: true };
    }

    const rows = Math.max(1, opts.rows);
    const bufferRows = opts.bufferRows ?? rows * 2;
    const desiredLines = rows + Math.max(0, opts.scrollOffset) + bufferRows;
    const desiredBytes = Math.max(MIN_TAIL_BYTES, desiredLines * BYTES_PER_LINE_ESTIMATE);
    const start = Math.max(0, fileSize - desiredBytes);
    const text = await file.slice(start, fileSize).text();
    if (!text) {
      return { lines: [`agent.log is empty`], fileSize, atTop: true, isPlaceholder: true };
    }

    let lines = text.split("\n");
    // If we started past BOF, the first "line" is almost certainly a partial line —
    // drop it so callers always see whole lines.
    const atTop = start === 0;
    if (!atTop && lines.length > 0) {
      lines = lines.slice(1);
    }
    if (lines.length === 0) {
      // The tail window covered exactly one partial line, which we then dropped.
      // The file is non-empty but the last line is longer than the read window —
      // surface that explicitly rather than claiming the file is empty.
      return { lines: [`agent.log line too long to window`], fileSize, atTop, isPlaceholder: true };
    }
    return { lines, fileSize, atTop, isPlaceholder: false };
  } catch {
    return { lines: [`Failed to read agent.log`], fileSize: 0, atTop: true, isPlaceholder: true };
  }
}
