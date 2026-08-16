/**
 * Claude API usage tracking — fetches session/weekly utilization from Anthropic API.
 * Caches at ~/.itsybitsy/usage-cache.json with 3-minute TTL.
 * Uses a lock file to rate-limit API calls to once per 30s across processes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { rename, mkdir, stat, writeFile, unlink, readdir, readFile } from "node:fs/promises";

import { InjectionContext, SpawnContext } from "./types";
import type { FetchLike } from "./types";

/** Injection context for fetch — avoids monkey-patching globalThis.fetch */
export const fetchCtx = new InjectionContext<FetchLike>(globalThis.fetch);

/** Spawn context for usage keychain lookup */
export const spawnCtx = new SpawnContext();

let ITSYBITSY_DIR = join(homedir(), ".itsybitsy");
let CACHE_PATH = join(ITSYBITSY_DIR, "usage-cache.json");
let LOCK_PATH = join(ITSYBITSY_DIR, "usage.lock");
let CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
let CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
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
}

/** Reset directory paths to defaults. */
export function resetTestDir(): void {
  ITSYBITSY_DIR = join(homedir(), ".itsybitsy");
  CACHE_PATH = join(ITSYBITSY_DIR, "usage-cache.json");
  LOCK_PATH = join(ITSYBITSY_DIR, "usage.lock");
  CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
  CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
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

async function readAccessToken(): Promise<string | null> {
  // Try credentials file first
  try {
    const file = Bun.file(CREDENTIALS_PATH);
    const data = await file.json();
    const token = data?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
  } catch {
    // Fall through to keychain
  }

  // Try macOS Keychain
  try {
    const proc = spawnCtx.runner(
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const raw = await new Response(proc.stdout).text();
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        // Keychain value may be JSON with the token inside
        try {
          const parsed = JSON.parse(trimmed);
          const token = parsed?.claudeAiOauth?.accessToken;
          if (typeof token === "string" && token.length > 0) return token;
        } catch {
          // Not JSON — use raw value as token
          return trimmed;
        }
      }
    }
  } catch {
    // Keychain not available
  }

  return null;
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
    await writeCache({ timestamp: retryTimestamp, response: cache.response, nextBackoffMs });
    return { data: parseUsageResponse(cache.response), error: true };
  }
  return { data: null, error: true };
}

export async function fetchUsage(): Promise<UsageResult> {
  await mkdir(ITSYBITSY_DIR, { recursive: true });
  // Check cache
  const cache = await readCache();
  const now = Date.now();
  if (cache && now - cache.timestamp * 1000 < CACHE_TTL_MS) {
    return { data: parseUsageResponse(cache.response), error: false };
  }

  const token = await readAccessToken();
  if (!token) return { data: null, error: true };

  // Rate limit: only one API attempt per 30s across all processes
  if (await isLocked()) {
    if (cache) return { data: parseUsageResponse(cache.response), error: false };
    return { data: null, error: true };
  }

  await acquireLock();
  try {
    const resp = await fetchCtx.fn("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!resp.ok) {
      return await handleFailure(cache, now);
    }

    const body = (await resp.json()) as ApiResponse;

    if (body.error) {
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
