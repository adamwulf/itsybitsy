/**
 * Plan usage for the `ib watch` status bar: shared types and helpers, Codex
 * usage (read from local Codex session logs) and Gemini usage (from
 * `agy -p /usage`, cached at ~/.itsybitsy/gemini-usage-cache.json).
 *
 * Claude usage comes from Claude Code's own statusline input, recorded by
 * `ib hooks statusline` — see src/claude-rate-limits.ts. ib never reads the
 * macOS keychain.
 */

import { userHome } from "./home";
import { join } from "node:path";
import { rename, mkdir, stat, writeFile, unlink, readdir, open } from "node:fs/promises";

import { SpawnContext } from "./types";

/** Spawn context for the `agy -p /usage` run */
export const spawnCtx = new SpawnContext();

let ITSYBITSY_DIR = join(userHome(), ".itsybitsy");
let CODEX_SESSIONS_DIR = join(userHome(), ".codex", "sessions");
let GEMINI_CACHE_PATH = join(ITSYBITSY_DIR, "gemini-usage-cache.json");
let GEMINI_LOCK_PATH = join(ITSYBITSY_DIR, "gemini-usage.lock");
const CACHE_TTL_MS = 180_000; // 3 minute normal refresh
const LOCK_MAX_AGE_MS = 30_000; // only one agy run per 30s across processes
const MAX_BACKOFF_MS = 10 * 60_000; // 10 minutes max backoff on failures

/** Override directory paths for testing. */
export function setTestDir(dir: string): void {
  ITSYBITSY_DIR = dir;
  CODEX_SESSIONS_DIR = join(dir, "codex-sessions");
  GEMINI_CACHE_PATH = join(dir, "gemini-usage-cache.json");
  GEMINI_LOCK_PATH = join(dir, "gemini-usage.lock");
}

/** Reset directory paths to defaults. */
export function resetTestDir(): void {
  ITSYBITSY_DIR = join(userHome(), ".itsybitsy");
  CODEX_SESSIONS_DIR = join(userHome(), ".codex", "sessions");
  GEMINI_CACHE_PATH = join(ITSYBITSY_DIR, "gemini-usage-cache.json");
  GEMINI_LOCK_PATH = join(ITSYBITSY_DIR, "gemini-usage.lock");
}

export interface UsageData {
  sessionPct: number | null;
  weeklyPct: number | null;
  sessionReset: string | null;
  weeklyReset: string | null;
}

export interface UsageResult {
  data: UsageData | null;
  error: boolean;
}

interface CodexRateLimitWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface CodexRateLimits {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

/** Format a duration from now to a future ISO date as human-readable. */
export function formatResetTime(isoDate: string, now?: Date): string {
  const resetAt = new Date(isoDate);
  const current = now ?? new Date();
  const diffMs = resetAt.getTime() - current.getTime();
  if (diffMs <= 0) return "now";

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes === 0) return "<1m";
  return `${minutes}m`;
}

function formatCodexResetTime(value: unknown, now?: Date): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatResetTime(new Date(value * 1000).toISOString(), now);
  }
  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return formatResetTime(new Date(numeric * 1000).toISOString(), now);
    }
    return formatResetTime(value, now);
  }
  return null;
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/** Any window shorter than 24h is a session window; longer is weekly. */
const SESSION_WINDOW_MAX_MINUTES = 1440;

/**
 * Classify a Codex rate-limit window as session or weekly by its window_minutes.
 * Codex reorders windows across plan types, so position is not reliable: a window
 * whose window_minutes is finite and < 24h is the session window, otherwise weekly.
 * When window_minutes is missing or not finite, fall back to the positional meaning.
 */
function classifyCodexWindow(
  window: CodexRateLimitWindow,
  positionalRole: "session" | "weekly",
): "session" | "weekly" {
  const minutes = window.window_minutes;
  if (typeof minutes === "number" && Number.isFinite(minutes)) {
    return minutes < SESSION_WINDOW_MAX_MINUTES ? "session" : "weekly";
  }
  return positionalRole;
}

/** Parse a Codex token_count rate_limits payload into the shared usage shape. */
export function parseCodexRateLimits(rateLimits: CodexRateLimits, now?: Date): UsageData {
  const data: UsageData = {
    sessionPct: null,
    weeklyPct: null,
    sessionReset: null,
    weeklyReset: null,
  };

  const windows: Array<[CodexRateLimitWindow | undefined, "session" | "weekly"]> = [
    [rateLimits.primary, "session"],
    [rateLimits.secondary, "weekly"],
  ];

  for (const [window, positionalRole] of windows) {
    if (!window) continue;
    if (classifyCodexWindow(window, positionalRole) === "session") {
      data.sessionPct = percent(window.used_percent);
      data.sessionReset = formatCodexResetTime(window.resets_at, now);
    } else {
      data.weeklyPct = percent(window.used_percent);
      data.weeklyReset = formatCodexResetTime(window.resets_at, now);
    }
  }

  return data;
}

/**
 * Parse output from `agy -p "/usage"` into UsageData.
 *
 * Example output:
 *   Quota:
 *   Gemini Models          Weekly Limit Remaining     100%  2026-09-10T04:38:29Z
 *   Gemini Models          Five Hour Limit Remaining  99%   2026-09-03T09:38:29Z
 *   Claude and GPT models  Weekly Limit Remaining     100%  2026-09-10T04:44:18Z
 *   Claude and GPT models  Five Hour Limit Remaining  100%  2026-09-03T09:44:18Z
 *
 * Session window is "Five Hour" (or similar hourly/session limit).
 * Weekly window is "Weekly".
 * Note that the table reports "Limit Remaining X%". Usage percentage is 100 - remaining.
 * If the user does not have a session limit, sessionPct will remain null.
 */
export function parseGeminiUsage(output: string, now?: Date): UsageData {
  const data: UsageData = {
    sessionPct: null,
    weeklyPct: null,
    sessionReset: null,
    weeklyReset: null,
  };

  // Strip ANSI escape codes if present
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
  const pctRegex = /(\d+(?:\.\d+)?)\s*%/;

  for (const line of plain.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // We only process Gemini lines
    if (!/gemini/i.test(trimmed)) continue;

    const isWeekly = /weekly/i.test(trimmed);
    const isSession = /five\s*hour|session|\bhour\b/i.test(trimmed);
    if (!isWeekly && !isSession) continue;

    const pctMatch = trimmed.match(pctRegex);
    const isoMatch = trimmed.match(isoRegex);

    let pct: number | null = null;
    if (pctMatch && pctMatch[1] !== undefined) {
      const val = parseFloat(pctMatch[1]);
      if (Number.isFinite(val)) {
        if (/remaining/i.test(trimmed)) {
          pct = Math.max(0, Math.min(100, Math.round(100 - val)));
        } else {
          pct = Math.max(0, Math.min(100, Math.round(val)));
        }
      }
    }

    const reset = isoMatch && isoMatch[0] ? formatResetTime(isoMatch[0], now) : null;

    if (isSession) {
      data.sessionPct = pct;
      data.sessionReset = reset;
    } else if (isWeekly) {
      data.weeklyPct = pct;
      data.weeklyReset = reset;
    }
  }

  return data;
}

/** Bytes read per step when a Codex session log is read from its end. */
export const CODEX_TAIL_CHUNK_BYTES = 64 * 1024;

/** Only a line that contains this text can carry usage, so only such lines are JSON-parsed. */
const CODEX_USAGE_MARKER = "rate_limits";

interface JsonlFile {
  path: string;
  mtimeMs: number;
}

async function collectJsonlFiles(dir: string, depth = 0): Promise<JsonlFile[]> {
  if (depth > 5) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: JsonlFile[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(path, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // The file went away after readdir.
      }
    }
  }
  return files;
}

function parseCodexUsageLine(line: string): UsageData | null {
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const rateLimits = record?.payload?.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object") return null;

  const data = parseCodexRateLimits(rateLimits);
  if (
    data.sessionPct === null
    && data.weeklyPct === null
    && data.sessionReset === null
    && data.weeklyReset === null
  ) {
    return null;
  }
  return data;
}

/** Parse one log line, given as its byte pieces in file order. */
function parseCodexUsagePieces(pieces: Buffer[]): UsageData | null {
  const line = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces);
  if (!line.includes(CODEX_USAGE_MARKER)) return null;
  return parseCodexUsageLine(line.toString("utf8"));
}

/**
 * Find the last usage payload in one Codex session log. The file is read from
 * its end in CODEX_TAIL_CHUNK_BYTES steps, and reading stops at the line
 * closest to the end that has usage, so a large file is never read whole.
 */
async function readLastCodexUsage(path: string): Promise<UsageData | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    let position = (await handle.stat()).size;
    // The pieces, in file order, of the line that the chunks read so far start inside.
    let pending: Buffer[] = [];
    while (position > 0) {
      const length = Math.min(CODEX_TAIL_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead);

      let end = chunk.length;
      while (end > 0) {
        const newline = chunk.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const data = parseCodexUsagePieces([chunk.subarray(newline + 1, end), ...pending]);
        if (data) return data;
        pending = [];
        end = newline;
      }
      pending.unshift(chunk.subarray(0, end));
    }
    // The first line of the file has no newline before it.
    return parseCodexUsagePieces(pending);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Read the newest Codex usage payload from local Codex session JSONL logs.
 * Logs are searched newest mtime first, and the first log that has a usage
 * line answers, so older logs are not read.
 */
export async function fetchCodexUsage(): Promise<UsageResult> {
  const files = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  // Equal mtimes fall back to the path: rollout-<start time> names sort by age.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));

  for (const file of files) {
    const data = await readLastCodexUsage(file.path);
    if (data) return { data, error: false };
  }
  return { data: null, error: true };
}

interface GeminiCacheFile {
  timestamp: number;
  data: UsageData;
  nextBackoffMs?: number;
}

async function readGeminiCache(): Promise<GeminiCacheFile | null> {
  try {
    const file = Bun.file(GEMINI_CACHE_PATH);
    return await file.json();
  } catch {
    return null;
  }
}

async function writeGeminiCache(cache: GeminiCacheFile): Promise<void> {
  await mkdir(ITSYBITSY_DIR, { recursive: true });
  const tmpPath = GEMINI_CACHE_PATH + ".tmp." + process.pid;
  await Bun.write(tmpPath, JSON.stringify(cache));
  await rename(tmpPath, GEMINI_CACHE_PATH);
}

async function isGeminiLocked(): Promise<boolean> {
  try {
    const s = await stat(GEMINI_LOCK_PATH);
    return Date.now() - s.mtimeMs < LOCK_MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function acquireGeminiLock(): Promise<void> {
  try {
    await writeFile(GEMINI_LOCK_PATH, "");
  } catch {
    // ignore — best-effort
  }
}

async function releaseGeminiLock(): Promise<void> {
  try {
    await unlink(GEMINI_LOCK_PATH);
  } catch {
    // ignore
  }
}

async function handleGeminiFailure(cache: GeminiCacheFile | null, now: number): Promise<UsageResult> {
  await releaseGeminiLock();
  if (cache) {
    const backoffMs = Math.min(cache.nextBackoffMs ?? 60_000, MAX_BACKOFF_MS);
    const nextBackoffMs = Math.min(backoffMs + 60_000, MAX_BACKOFF_MS);
    const retryTimestamp = Math.floor((now + backoffMs - CACHE_TTL_MS) / 1000);
    await writeGeminiCache({ timestamp: retryTimestamp, data: cache.data, nextBackoffMs });
    return { data: cache.data, error: true };
  }
  return { data: null, error: true };
}

export const AGY_USAGE_TIMEOUT_MS = 10_000;

/** Output that means agy wants the user to log in before it answers. */
const AGY_LOGIN_MESSAGE = /\b(?:not logged in|not signed in|sign in|log in)\b/i;

export interface GeminiUsageResult extends UsageResult {
  /**
   * True when the `agy` run looks like it is waiting on a login: it timed out
   * (agy's OAuth flow blocks while it waits on the browser), or it failed with
   * a login message in its output. Each new run opens another browser login
   * window, so the caller should stop polling.
   */
  authFailed?: boolean;
}

/**
 * Handle an agy run that finished without usage data. A login message in its
 * output marks the failure as `authFailed`; any other failure only backs off.
 */
async function geminiFailure(
  cache: GeminiCacheFile | null,
  now: number,
  output: { stdout: string; stderr: string } | null,
): Promise<GeminiUsageResult> {
  const result = await handleGeminiFailure(cache, now);
  if (output && AGY_LOGIN_MESSAGE.test(`${output.stdout}\n${output.stderr}`)) {
    return { ...result, authFailed: true };
  }
  return result;
}

/**
 * Fetch Gemini usage from `agy -p "/usage"`.
 * Caches at ~/.itsybitsy/gemini-usage-cache.json with 3-minute TTL.
 * Uses a lock file to rate-limit calls to once per 30s across processes.
 */
export async function fetchGeminiUsage(
  nowDate?: Date,
  timeoutMs = AGY_USAGE_TIMEOUT_MS,
): Promise<GeminiUsageResult> {
  await mkdir(ITSYBITSY_DIR, { recursive: true });
  const cache = await readGeminiCache();
  const now = Date.now();
  if (cache && now - cache.timestamp * 1000 < CACHE_TTL_MS) {
    return { data: cache.data, error: false };
  }

  if (await isGeminiLocked()) {
    if (cache) return { data: cache.data, error: false };
    return { data: null, error: true };
  }

  await acquireGeminiLock();

  let proc: any;
  try {
    proc = spawnCtx.runner(
      ["agy", "-p", "/usage"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
  } catch {
    return handleGeminiFailure(cache, now);
  }

  const drain: Promise<{ stdout: string; stderr: string; exitCode: number } | null> = (async () => {
    const [stdout, stderr] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : "",
      proc.stderr ? new Response(proc.stderr).text() : "",
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })().catch(() => null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const res = await Promise.race([drain, timeout]);
    if (timer) clearTimeout(timer);

    if (res === "timeout") {
      // agy's OAuth flow blocks while it waits on the browser, so a hung run
      // has most likely opened a login window already.
      try { proc.kill?.(); } catch {}
      return { ...(await handleGeminiFailure(cache, now)), authFailed: true };
    }

    if (!res || res.exitCode !== 0) {
      try { proc.kill?.(); } catch {}
      return geminiFailure(cache, now, res);
    }

    const data = parseGeminiUsage(res.stdout, nowDate ?? new Date(now));
    if (data.sessionPct === null && data.weeklyPct === null) {
      return geminiFailure(cache, now, res);
    }

    await writeGeminiCache({ timestamp: Math.floor(now / 1000), data, nextBackoffMs: 60_000 });
    await releaseGeminiLock();
    return { data, error: false };
  } catch {
    if (timer) clearTimeout(timer);
    try { proc.kill?.(); } catch {}
    return handleGeminiFailure(cache, now);
  }
}

