/**
 * Claude API usage tracking — fetches session/weekly utilization from Anthropic API.
 * Caches at ~/.itsybitsy/usage-cache.json with 3-minute TTL.
 * Uses a lock file to rate-limit API calls to once per 30s across processes.
 *
 * Credentials come from both `~/.claude/.credentials.json` and the macOS
 * Keychain; candidates are ranked by expiry and tried in turn, because one
 * store can hold a stale copy of a token Claude Code has since refreshed in
 * the other (see `rankTokenCandidates`).
 */

import { userHome } from "./home";
import { join } from "node:path";
import { rename, mkdir, stat, writeFile, unlink, readdir, readFile } from "node:fs/promises";

import { InjectionContext, SpawnContext } from "./types";
import type { FetchLike } from "./types";

/** Injection context for fetch — avoids monkey-patching globalThis.fetch */
export const fetchCtx = new InjectionContext<FetchLike>(globalThis.fetch);

/** Spawn context for usage keychain lookup */
export const spawnCtx = new SpawnContext();

let ITSYBITSY_DIR = join(userHome(), ".itsybitsy");
let CACHE_PATH = join(ITSYBITSY_DIR, "usage-cache.json");
let LOCK_PATH = join(ITSYBITSY_DIR, "usage.lock");
let CREDENTIALS_PATH = join(userHome(), ".claude", ".credentials.json");
let CODEX_SESSIONS_DIR = join(userHome(), ".codex", "sessions");
let GEMINI_CACHE_PATH = join(ITSYBITSY_DIR, "gemini-usage-cache.json");
let GEMINI_LOCK_PATH = join(ITSYBITSY_DIR, "gemini-usage.lock");
const CACHE_TTL_MS = 180_000; // 3 minute normal refresh
const LOCK_MAX_AGE_MS = 30_000; // only one API attempt per 30s across processes
const API_TIMEOUT_MS = 5_000; // 5s fetch timeout
const MAX_BACKOFF_MS = 10 * 60_000; // 10 minutes max backoff on failures

/** Override directory paths for testing. */
export function setTestDir(dir: string): void {
  ITSYBITSY_DIR = dir;
  CACHE_PATH = join(dir, "usage-cache.json");
  LOCK_PATH = join(dir, "usage.lock");
  CREDENTIALS_PATH = join(dir, "credentials.json");
  CODEX_SESSIONS_DIR = join(dir, "codex-sessions");
  GEMINI_CACHE_PATH = join(dir, "gemini-usage-cache.json");
  GEMINI_LOCK_PATH = join(dir, "gemini-usage.lock");
}

/** Reset directory paths to defaults. */
export function resetTestDir(): void {
  ITSYBITSY_DIR = join(userHome(), ".itsybitsy");
  CACHE_PATH = join(ITSYBITSY_DIR, "usage-cache.json");
  LOCK_PATH = join(ITSYBITSY_DIR, "usage.lock");
  CREDENTIALS_PATH = join(userHome(), ".claude", ".credentials.json");
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

interface ApiResponse {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  error?: unknown;
}

interface CacheFile {
  timestamp: number;
  response: ApiResponse;
  nextBackoffMs?: number; // backoff interval for next failure (ms)
  /**
   * Epoch seconds of the last failed refresh. Present only while the entry is
   * a backoff placeholder holding the previous good response; cleared by the
   * next successful fetch. Readers report such an entry as `error: true` so
   * callers can tell a live reading from a stale one.
   */
  failedAt?: number;
}

/** True when the cache entry is a backoff placeholder written by a failed refresh. */
function isBackoffCache(cache: CacheFile): boolean {
  return cache.failedAt !== undefined;
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

interface CodexUsageCandidate {
  data: UsageData;
  timestamp: number;
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

/** Parse API response into UsageData. */
export function parseUsageResponse(resp: ApiResponse, now?: Date): UsageData {
  return {
    sessionPct: resp.five_hour ? Math.round(resp.five_hour.utilization) : null,
    weeklyPct: resp.seven_day ? Math.round(resp.seven_day.utilization) : null,
    sessionReset: resp.five_hour ? formatResetTime(resp.five_hour.resets_at, now) : null,
    weeklyReset: resp.seven_day ? formatResetTime(resp.seven_day.resets_at, now) : null,
  };
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

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(path, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

function parseCodexUsageLine(line: string): CodexUsageCandidate | null {
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

  const timestamp = typeof record?.timestamp === "string"
    ? new Date(record.timestamp).getTime()
    : 0;
  return { data, timestamp: Number.isFinite(timestamp) ? timestamp : 0 };
}

/** Read the newest Codex usage payload from local Codex session JSONL logs. */
export async function fetchCodexUsage(): Promise<UsageResult> {
  const files = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  let newest: CodexUsageCandidate | null = null;

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const candidate = parseCodexUsageLine(line);
      if (!candidate) continue;
      if (!newest || candidate.timestamp >= newest.timestamp) newest = candidate;
    }
  }

  if (!newest) return { data: null, error: true };
  return { data: newest.data, error: false };
}

/** An OAuth access token plus its expiry, when the source records one. */
export interface TokenCandidate {
  token: string;
  /** Epoch milliseconds when the token expires; null when the source has no expiry. */
  expiresAt: number | null;
}

/** Extract a token candidate from a parsed Claude Code credentials payload. */
function candidateFromCredentials(parsed: unknown): TokenCandidate | null {
  const oauth = (parsed as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) return null;
  const expiresAt = oauth?.expiresAt;
  return {
    token,
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

/** Read the token in ~/.claude/.credentials.json, if any. */
async function readFileCandidate(): Promise<TokenCandidate | null> {
  try {
    const file = Bun.file(CREDENTIALS_PATH);
    return candidateFromCredentials(await file.json());
  } catch {
    return null;
  }
}

/** Read the token in the macOS Keychain, if any. */
async function readKeychainCandidate(): Promise<TokenCandidate | null> {
  try {
    const proc = spawnCtx.runner(
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const raw = await new Response(proc.stdout).text();
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    // Keychain value may be JSON with the token inside
    try {
      return candidateFromCredentials(JSON.parse(trimmed));
    } catch {
      // Not JSON — use raw value as token
      return { token: trimmed, expiresAt: null };
    }
  } catch {
    // Keychain not available
    return null;
  }
}

/**
 * Order token candidates by how likely they are to be accepted, dropping
 * duplicates:
 *   1. unexpired tokens, latest expiry first
 *   2. tokens with no recorded expiry, in source order
 *   3. expired tokens, latest expiry first
 *
 * Claude Code refreshes its OAuth token in place — on macOS in the Keychain,
 * elsewhere in `~/.claude/.credentials.json`. When both sources exist, one of
 * them is a stale copy whose token silently expires. Blindly preferring one
 * source leaves the usage fetch failing with that dead token forever, so the
 * caller tries candidates in this order until the API accepts one.
 */
export function rankTokenCandidates(candidates: Array<TokenCandidate | null>, now: number): string[] {
  const seen = new Set<string>();
  const unique: TokenCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.token)) continue;
    seen.add(candidate.token);
    unique.push(candidate);
  }
  const tier = (c: TokenCandidate): number => {
    if (c.expiresAt === null) return 1;
    return c.expiresAt > now ? 0 : 2;
  };
  return unique
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) =>
      tier(a.candidate) - tier(b.candidate)
      || (b.candidate.expiresAt ?? 0) - (a.candidate.expiresAt ?? 0)
      || a.index - b.index)
    .map(({ candidate }) => candidate.token);
}

/** All known access tokens, best candidate first. Empty when none is available. */
async function readAccessTokens(now: number): Promise<string[]> {
  const fileCandidate = await readFileCandidate();
  const keychainCandidate = await readKeychainCandidate();
  return rankTokenCandidates([fileCandidate, keychainCandidate], now);
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const file = Bun.file(CACHE_PATH);
    return await file.json();
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheFile): Promise<void> {
  await mkdir(ITSYBITSY_DIR, { recursive: true });
  const tmpPath = CACHE_PATH + ".tmp." + process.pid;
  await Bun.write(tmpPath, JSON.stringify(cache));
  await rename(tmpPath, CACHE_PATH);
}

/** Returns true if a lock file exists and is younger than LOCK_MAX_AGE_MS. */
async function isLocked(): Promise<boolean> {
  try {
    const s = await stat(LOCK_PATH);
    return Date.now() - s.mtimeMs < LOCK_MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<void> {
  try {
    await writeFile(LOCK_PATH, "");
  } catch {
    // ignore — best-effort
  }
}

async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_PATH);
  } catch {
    // ignore
  }
}

/** Handle API failure: apply exponential backoff on cached response, or return null. */
async function handleFailure(cache: CacheFile | null, now: number): Promise<UsageResult> {
  await releaseLock();
  if (cache) {
    const backoffMs = Math.min(cache.nextBackoffMs ?? 60_000, MAX_BACKOFF_MS);
    const nextBackoffMs = Math.min(backoffMs + 60_000, MAX_BACKOFF_MS);
    const retryTimestamp = Math.floor((now + backoffMs - CACHE_TTL_MS) / 1000);
    await writeCache({
      timestamp: retryTimestamp,
      response: cache.response,
      nextBackoffMs,
      failedAt: Math.floor(now / 1000),
    });
    return { data: parseUsageResponse(cache.response), error: true };
  }
  return { data: null, error: true };
}

export async function fetchUsage(): Promise<UsageResult> {
  await mkdir(ITSYBITSY_DIR, { recursive: true });
  // Check cache. A backoff placeholder is served until its retry time but is
  // flagged as an error: its numbers are the last good response, not live.
  const cache = await readCache();
  const now = Date.now();
  if (cache && now - cache.timestamp * 1000 < CACHE_TTL_MS) {
    return { data: parseUsageResponse(cache.response), error: isBackoffCache(cache) };
  }

  const tokens = await readAccessTokens(now);
  if (tokens.length === 0) return { data: null, error: true };

  // Rate limit: only one API attempt per 30s across all processes
  if (await isLocked()) {
    if (cache) return { data: parseUsageResponse(cache.response), error: isBackoffCache(cache) };
    return { data: null, error: true };
  }

  await acquireLock();
  try {
    // Try each credential in turn: a rejected token (expired copy in one of
    // the two credential stores) must not mask a valid one in the other.
    let body: ApiResponse | null = null;
    for (const token of tokens) {
      const resp = await fetchCtx.fn("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) continue;

      const candidate = (await resp.json()) as ApiResponse;
      if (candidate.error) continue;

      body = candidate;
      break;
    }

    if (!body) {
      return await handleFailure(cache, now);
    }

    // Success — write cache with no backoff, release lock
    await writeCache({ timestamp: Math.floor(now / 1000), response: body, nextBackoffMs: 60_000 });
    await releaseLock();
    return { data: parseUsageResponse(body), error: false };
  } catch {
    // Network error or timeout — use stale cache if available
    await releaseLock();
    if (cache) return { data: parseUsageResponse(cache.response), error: true };
    return { data: null, error: true };
  }
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

/**
 * Fetch Gemini usage from `agy -p "/usage"`.
 * Caches at ~/.itsybitsy/gemini-usage-cache.json with 3-minute TTL.
 * Uses a lock file to rate-limit calls to once per 30s across processes.
 */
export async function fetchGeminiUsage(nowDate?: Date): Promise<UsageResult> {
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

  const drain: Promise<{ stdout: string; exitCode: number } | null> = (async () => {
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  })().catch(() => null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), AGY_USAGE_TIMEOUT_MS);
  });

  try {
    const res = await Promise.race([drain, timeout]);
    if (timer) clearTimeout(timer);

    if (!res || res.exitCode !== 0) {
      try { proc.kill?.(); } catch {}
      return handleGeminiFailure(cache, now);
    }

    const data = parseGeminiUsage(res.stdout, nowDate ?? new Date(now));
    if (data.sessionPct === null && data.weeklyPct === null) {
      return handleGeminiFailure(cache, now);
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

