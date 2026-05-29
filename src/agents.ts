/**
 * Read .ittybitty/agents/ directory directly to get agent data.
 * Also reads user-questions.json for pending questions.
 */

import { join } from "path";
import { readdir, rename, stat, unlink } from "fs/promises";
import type { AgentState } from "./parse-state";
import { parseState, stripAnsi, STARTUP_MARKERS } from "./parse-state";
import { captureTmuxOutput, killTmuxSession, listTmuxSessions } from "./tmux-poller";
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
  agentType?: string;
  agentIcon?: string;
  state?: MetaState;
  state_updated_at?: number;
  spawned_by?: SpawnedBy | null;
}

/** Resolve the display icon for an agent from meta fields with legacy fallback */
export function resolveAgentIcon(meta: AgentMeta): string {
  if (meta.agentIcon) return meta.agentIcon;
  if (meta.agentType === "coordinator") return "◇";
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
/**
 * The three slow agent operations that take out a durable, cross-process
 * marker so a second conflicting op is refused while one is in flight.
 * `merge_check` and `merging` are distinct on disk (so the refusal message
 * can say "merge-checking" vs "merging") but collapse to a single `merging`
 * render label in detectAgentStates.
 */
export type AgentOperationKind = "merge_check" | "merging" | "restarting";

/**
 * A long-running op marker, present only while the op is in flight. Written
 * by mergeCheckAgent/mergeAgent/resumeAgent (via acquireAgentOperation) and
 * cleared in their `finally`. A crash mid-op leaves the marker behind, which
 * is what enables dead-holder reclaim and stuck detection.
 */
export interface AgentOperation {
  kind: AgentOperationKind;
  pid: number; // process running the op (process.pid of the caller)
  started_at_ms: number;
}

export interface TransientState {
  tmux_compacting: boolean;
  tmux_rate_limited: boolean;
  tmux_api_error: boolean;
  has_background_tasks: boolean;
  updated_at_ms: number;
  watchdog_pid: number;
  // Present only while a long-running op (merge-check/merge/restart) is in
  // flight. Absent on older files; a malformed value is treated as absent.
  operation?: AgentOperation | null;
}

/** Allowed values for AgentOperation.kind — used to validate on read. */
const AGENT_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "merge_check",
  "merging",
  "restarting",
]);

/**
 * Validate a raw `operation` value read from disk. Returns the typed
 * AgentOperation when well-formed (object with kind in the allowed set,
 * numeric pid > 0, numeric started_at_ms > 0); otherwise undefined so the
 * field is treated as absent without rejecting the whole transient read.
 */
function parseAgentOperation(raw: unknown): AgentOperation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const op = raw as Record<string, unknown>;
  if (typeof op.kind !== "string" || !AGENT_OPERATION_KINDS.has(op.kind)) return undefined;
  if (typeof op.pid !== "number" || !(op.pid > 0)) return undefined;
  if (typeof op.started_at_ms !== "number" || !(op.started_at_ms > 0)) return undefined;
  return {
    kind: op.kind as AgentOperationKind,
    pid: op.pid,
    started_at_ms: op.started_at_ms,
  };
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
      // Field added later — absent on older files; a malformed value is
      // ignored (treated as absent) rather than rejecting the whole read.
      operation: parseAgentOperation(data.operation) ?? null,
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

/** A zeroed transient used as the read-modify-write base when none exists. */
function emptyTransient(): TransientState {
  return {
    tmux_compacting: false,
    tmux_rate_limited: false,
    tmux_api_error: false,
    has_background_tasks: false,
    updated_at_ms: 0,
    watchdog_pid: 0,
    operation: null,
  };
}

/**
 * Single read-modify-write primitive for meta.transient.json. Reads the
 * current transient (or a zeroed default when missing/malformed), applies
 * `fn`, and writes the result atomically (.tmp + rename).
 *
 * ALL transient writers route through this so that adding merge/resume as
 * writers (alongside the watchdog) doesn't clobber each other's fields via
 * last-write-wins on the whole file. The watchdog preserves an in-flight
 * `operation` it didn't set, and the op writers preserve the watchdog's tmux
 * snapshot. Worst case is a lost write that degrades to today's behavior
 * (guard didn't engage), never corruption.
 *
 * Best-effort: silently swallows write errors (including a missing dir on the
 * post-merge clear path) so a failing write does not crash the caller — same
 * idiom as writeAgentTransient/deleteAgentTransient.
 */
export async function updateAgentTransient(
  agentDir: string,
  fn: (cur: TransientState) => TransientState,
): Promise<void> {
  const path = join(agentDir, "meta.transient.json");
  try {
    // Skip if the agent dir is gone. Bun.write auto-creates parent dirs, so
    // without this guard the post-merge clear path (dir removed at step 17-19,
    // then clearAgentOperation runs in `finally`) would RESURRECT the deleted
    // agent dir with a stray meta.transient.json. The stat throws ENOENT on a
    // missing dir, which the outer catch swallows — a genuine no-op.
    await stat(agentDir);
    const cur = (await readAgentTransient(agentDir)) ?? emptyTransient();
    const next = fn(cur);
    // Per-process tmp name: multiple writers (the watchdog + a merge/resume op)
    // can run concurrently, and a shared ".tmp" lets their writes interleave
    // bytes into the same file before the rename publishes it. A pid-suffixed
    // tmp gives each writer its own scratch file so the atomic rename only ever
    // publishes complete content.
    const tmpPath = `${path}.tmp.${process.pid}`;
    await Bun.write(tmpPath, JSON.stringify(next, null, 2));
    await rename(tmpPath, path);
  } catch {
    /* best-effort — ENOENT-safe, mirrors writeAgentTransient */
  }
}

/**
 * Mark a long-running op as in flight. Thin wrapper over updateAgentTransient
 * touching only the `operation` field; preserves the watchdog's tmux snapshot.
 */
export async function setAgentOperation(agentDir: string, op: AgentOperation): Promise<void> {
  await updateAgentTransient(agentDir, (cur) => ({ ...cur, operation: op }));
}

/**
 * Clear the in-flight op marker — but only if it still belongs to THIS process
 * (compare-and-swap on `operation.pid === process.pid`). Thin wrapper over
 * updateAgentTransient; ENOENT-safe (the post-merge success path removes the
 * agent dir before this runs, and the best-effort try/catch swallows the
 * resulting missing-dir error).
 *
 * The compare-and-swap matters because acquireAgentOperation can age-reclaim a
 * marker older than OP_STUCK_TIMEOUT_MS even while its original holder is still
 * alive. Without the CAS, this interleaving would wipe a DIFFERENT op's marker:
 *   op A hangs >300s (still alive) → op B age-reclaims (marker now has B's pid)
 *   → A un-hangs, its `finally` runs clearAgentOperation → would wipe B's marker.
 * By clearing only when the marker is still ours, A's late clear no-ops and B's
 * marker survives. When the marker isn't ours, return `cur` unchanged.
 */
export async function clearAgentOperation(agentDir: string): Promise<void> {
  await updateAgentTransient(agentDir, (cur) =>
    cur.operation?.pid === process.pid ? { ...cur, operation: null } : cur,
  );
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
 * Detect tmux 'remain-on-exit' dead-pane banner. When a tmux pane is
 * configured with `remain-on-exit on` and its child process exits, tmux
 * renders a literal `Pane is dead (status N, ...)` banner inside the pane
 * — the session is still alive (so list-sessions/has-session pass) but
 * Claude is gone and no further work happens. We treat this case the same
 * as a dead session: the agent is stopped.
 */
export function isDeadPane(tmuxOutput: string): boolean {
  return tmuxOutput.includes("Pane is dead");
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
 * Cache stores a single canonical reference; readers receive an isolated copy
 * via copyAgentMeta() so caller mutations cannot pollute the cache. We do NOT
 * use structuredClone() — it was the 2nd-biggest CPU cost in profiling because
 * it deep-clones every meta on every read, every refresh + every 2s pollStates
 * tick × every agent. AgentMeta is flat primitives/strings except for the one
 * nested mutable object `spawned_by`, so a shallow spread plus a fresh copy of
 * spawned_by is dramatically cheaper while preserving the same isolation
 * guarantee. See copyAgentMeta().
 */
const metaCache = new Map<string, { mtimeMs: number; meta: AgentMeta }>();

/**
 * Return an isolated copy of an AgentMeta cheaply. AgentMeta's fields are all
 * flat primitives/strings EXCEPT `spawned_by`, the only nested mutable object
 * a caller might mutate (notably the watchdog routing notifications). A shallow
 * spread shares the top-level object by value for primitives; we deep-copy
 * `spawned_by` so a caller mutating returned.spawned_by cannot pollute the
 * cached canonical reference. Keep this in sync with the AgentMeta interface:
 * if a new array/object field is added, copy it here too. */
function copyAgentMeta(meta: AgentMeta): AgentMeta {
  return {
    ...meta,
    spawned_by: meta.spawned_by ? { ...meta.spawned_by } : meta.spawned_by,
  };
}

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
    return { meta: copyAgentMeta(cached.meta) };
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
    return { meta: copyAgentMeta(meta) };
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
        const nonCoordinators = agents.filter(a => a.meta.agentType !== "coordinator");
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
    const nonCoordRoots = nonArchivedRoots.filter(a => a.meta.agentType !== "coordinator");
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

/**
 * Memo of tmux session names already torn down by reapOrphanedClaude.
 * detectAgentStates() runs every ~2s over ALL agents, so without this a
 * stopped agent whose meta.json still carries a stale tmux_session would
 * re-spawn `tmux kill-session` on every tick forever, re-killing an
 * already-dead session. Keyed on the session name, which is unique per agent
 * (ittybitty-<repoId>-<agentId>) and never legitimately reused for a different
 * stopped husk — so a one-shot memo is safe. Only the kill-session call is
 * memoized; PID reaping is NOT (a PID could in principle still be alive on a
 * later tick and warrant another SIGTERM). */
const reapedTmuxSessions = new Set<string>();

/** Reset the reaped-tmux-session memo. Exported for tests. */
export function resetReapedTmuxSessions(): void {
  reapedTmuxSessions.clear();
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
  // that don't match any known agent's tmux_session. The "ib-coordinator"
  // session is owned by `ib watch` itself (not by any agent in any repo) and
  // is intentionally NOT counted here — there is no agent meta.json that
  // would mark it as tracked, so flagging it would mean every running ib
  // watch shows up as an orphan to its own ERRORS pane. `ib state`'s orphan
  // detection layer handles `ib-coordinator` separately because it builds
  // its tracked set explicitly (see buildTrackedSets in state-command.ts).
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

/**
 * How long a long-running op (merge-check/merge/restart) may run before
 * detectAgentStates paints it `op_stuck`. 5 minutes — long enough that a big
 * rebase never false-positives. The op's per-step `timed()` durations are
 * already logged to watch.log, so this can be tuned from real data later.
 */
export const OP_STUCK_TIMEOUT_MS = 300_000;

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
 * Also tears down the husk tmux session when resolvedState === "stopped".
 * Once we've decided the agent is stopped, the session is by definition
 * useless — it is either already gone (kill is a no-op), a dead-pane husk
 * still being counted as live by listTmuxSessions, or an orphaned session
 * whose Claude has died. Centralizing the kill here covers all stopped
 * branches uniformly (PID-liveness gate, dead-pane husk, complete-with-
 * missing-session).
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

  // Tear down the husk tmux session for stopped agents. Best-effort: a kill
  // against an already-gone session is a cheap no-op. Memoize on the session
  // name so we kill it AT MOST ONCE — detectAgentStates re-runs every ~2s, and
  // a stopped agent with a stale tmux_session would otherwise re-spawn
  // `tmux kill-session` on every tick forever (see reapedTmuxSessions).
  if (
    resolvedState === "stopped" &&
    agent.meta.tmux_session &&
    !reapedTmuxSessions.has(agent.meta.tmux_session)
  ) {
    reapedTmuxSessions.add(agent.meta.tmux_session);
    await killTmuxSession(agent.meta.tmux_session);
  }
}

/**
 * Detect agent state for each agent using deterministic meta.json state
 * with tmux overrides for transient states. Mutates agent.state in place.
 *
 * Resolution order:
 * 1. Archived agents → stopped
 * 2. No tmux session → creating (if < 6s old) or stopped
 * 3. In-flight long-running op (merge-check/merge/restart) → merging/
 *    restarting, or op_stuck if the holder died or it ran past
 *    OP_STUCK_TIMEOUT_MS. Checked ABOVE the claude_pid gate because a wedged
 *    merge kills claude_pid before removing the dir.
 * 4. claude_pid dead → stopped
 * 5. Tmux exists → check for compacting/rate_limited overrides
 *    - Fast-path: trust meta.transient.json if its watchdog is alive and
 *      the snapshot is fresh; otherwise fall back to a live tmux capture.
 * 6. Read state from meta.json → return stored value or default to running
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

      // Read the transient ONCE, here, above the claude_pid gate below. The
      // op-branch must see the `operation` field before that gate runs: a
      // wedged merge KILLS claude_pid (ib-commands.ts mergeAgent, step 12)
      // well before it removes the agent dir, so if the op-check sat below
      // the gate a stuck merge would resolve to `stopped` and stuck-detection
      // would never fire. The freshness-gated compacting/rate-limited
      // fast-path further down reuses this same `transient` (no second read).
      const transient = await readAgentTransient(agentDir);

      // Op-branch: an in-flight long-running op (merge-check/merge/restart)
      // owns the rendered state. Read straight from disk, unconditionally —
      // NOT gated behind the watchdog-freshness check below, because the
      // `operation` field is written by merge/resume (not the watchdog), and
      // during a merge the watchdog has often already exited. Gating it behind
      // watchdog liveness would hide exactly the stuck merges we care about.
      const op = transient?.operation;
      if (op) {
        const holderDead = op.pid > 0 && !isPidAliveCtx.fn(op.pid);
        const tooOld = nowMsCtx.fn() - op.started_at_ms > OP_STUCK_TIMEOUT_MS;
        if (holderDead || tooOld) {
          agent.state = "op_stuck";
          return;
        }
        agent.state = op.kind === "restarting" ? "restarting" : "merging";
        return;
      }

      // Pid liveness gate: meta.json's stored state is intent, not truth. If
      // the recorded Claude process is gone, the agent is stopped regardless
      // of what state was last written. Without this, a hybrid 'zombie' (live
      // tmux session in remain-on-exit mode + dead claude_pid) would render
      // as 'running' indefinitely while a sibling watchdog kept writing into
      // its log. Skip while the agent is recently created so we don't race a
      // still-spawning agent whose claude_pid hasn't been written yet (legacy
      // / empty claude_pid is also covered by the >0 guard).
      const claudePid = parseInt(agent.meta.claude_pid, 10);
      if (
        claudePid > 0 &&
        !isPidAliveCtx.fn(claudePid) &&
        !isRecentlyCreated(agent.meta.created_epoch)
      ) {
        agent.state = "stopped";
        await reapOrphanedClaude(agent, agentDir, "stopped", "claude_pid not alive");
        return;
      }

      // Fast-path: 'complete' agents have signed off — no transient overrides
      // apply (compacting/rate_limited shouldn't happen post-signoff, and the
      // background-task override is scoped to meta.state === "waiting"). Trust
      // the stored state and skip the tmux capture (saves a posix_spawn +
      // ~20 openat() per agent per 2s tick).
      //
      // Liveness gate: tmux session must still exist. If the tmux server was
      // killed or restarted, Claude can outlive its session as an orphaned
      // process attached to a regular tty — meaning a PID-only check passes
      // while the user sees no working tmux pane. Use the cached
      // list-sessions result (shared with readAllAgents). The claude_pid
      // liveness check happens above (applies to all states).
      if (agent.meta.state === "complete") {
        if (liveTmuxSessionsPromise) {
          const liveSessions = await liveTmuxSessionsPromise;
          if (!liveSessions.has(tmuxSession)) {
            agent.state = "stopped";
            await reapOrphanedClaude(agent, agentDir, "stopped", "complete agent: tmux session gone");
            return;
          }
        }
        agent.state = "complete";
        return;
      }

      // Fast-path: trust meta.transient.json if its watchdog is alive and
      // the snapshot is fresh. The watchdog already runs the same
      // captureTmuxOutput + classify work every 5s — reusing its result
      // saves ~1 posix_spawn + ~20 file opens per agent per tick.
      //
      // Reuses the `transient` read hoisted above the claude_pid gate (for the
      // op-branch) — no second disk read. The disk read is from disk, not a
      // preloaded `agent.transient`, deliberately: the watcher calls
      // pollStates() every 2s using cached _lastAgents from a refresh() that
      // runs every 10s, so a preloaded snapshot would age in memory while the
      // watchdog keeps writing fresh data to disk — we'd hit the staleness
      // threshold and fall back to live capture even when fresh data was on
      // disk. One stat + a small JSON parse is cheap vs. the tmux spawn we
      // avoid.
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
      if (output === null || isDeadPane(output)) {
        const reason = output === null ? "tmux capture returned null" : "tmux pane is dead";
        const resolved: AgentState = isRecentlyCreated(agent.meta.created_epoch) ? "creating" : "stopped";
        agent.state = resolved;
        // reapOrphanedClaude tears down the husk tmux session when
        // resolved === "stopped". Skipped during the creating grace window
        // so a freshly-spawning agent that briefly shows a dead pane during
        // startup is not torn down.
        await reapOrphanedClaude(agent, agentDir, resolved, reason);
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
