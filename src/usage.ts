/**
 * Claude API usage tracking — fetches session/weekly utilization from Anthropic API.
 * Caches at ~/.itsybitsy/usage-cache.json with 1-minute TTL.
 * Uses a lock file to rate-limit API calls to once per 30s across processes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { rename, mkdir, stat, writeFile, unlink } from "node:fs/promises";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** For test injection — avoids monkey-patching globalThis.fetch */
let fetchFn: FetchLike = globalThis.fetch;

/** Override fetch for testing. */
export function setTestFetch(fn: FetchLike): void {
  fetchFn = fn;
}

/** Reset fetch to globalThis.fetch. */
export function resetTestFetch(): void {
  fetchFn = globalThis.fetch;
}

let ITSYBITSY_DIR = join(homedir(), ".itsybitsy");
let CACHE_PATH = join(ITSYBITSY_DIR, "usage-cache.json");
let LOCK_PATH = join(ITSYBITSY_DIR, "usage.lock");
let CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const CACHE_TTL_MS = 60_000; // 1 minute normal refresh
const LOCK_MAX_AGE_MS = 30_000; // only one API attempt per 30s across processes
const API_TIMEOUT_MS = 5_000; // 5s fetch timeout
const MAX_BACKOFF_MS = 10 * 60_000; // 10 minutes max backoff on failures

/** Override directory paths for testing. */
export function setTestDir(dir: string): void {
  ITSYBITSY_DIR = dir;
  CACHE_PATH = join(dir, "usage-cache.json");
  LOCK_PATH = join(dir, "usage.lock");
  CREDENTIALS_PATH = join(dir, "credentials.json");
}

/** Reset directory paths to defaults. */
export function resetTestDir(): void {
  ITSYBITSY_DIR = join(homedir(), ".itsybitsy");
  CACHE_PATH = join(ITSYBITSY_DIR, "usage-cache.json");
  LOCK_PATH = join(ITSYBITSY_DIR, "usage.lock");
  CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
}

export interface UsageData {
  sessionPct: number | null;
  weeklyPct: number | null;
  sessionReset: string | null;
  weeklyReset: string | null;
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
    const proc = Bun.spawn(
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
async function handleFailure(cache: CacheFile | null, now: number): Promise<UsageData | null> {
  await releaseLock();
  if (cache) {
    const backoffMs = Math.min(cache.nextBackoffMs ?? 60_000, MAX_BACKOFF_MS);
    const nextBackoffMs = Math.min(backoffMs + 60_000, MAX_BACKOFF_MS);
    const retryTimestamp = Math.floor((now + backoffMs - CACHE_TTL_MS) / 1000);
    await writeCache({ timestamp: retryTimestamp, response: cache.response, nextBackoffMs });
    return parseUsageResponse(cache.response);
  }
  return null;
}

export async function fetchUsage(): Promise<UsageData | null> {
  await mkdir(ITSYBITSY_DIR, { recursive: true });
  // Check cache
  const cache = await readCache();
  const now = Date.now();
  if (cache && now - cache.timestamp * 1000 < CACHE_TTL_MS) {
    return parseUsageResponse(cache.response);
  }

  const token = await readAccessToken();
  if (!token) return null;

  // Rate limit: only one API attempt per 30s across all processes
  if (await isLocked()) {
    if (cache) return parseUsageResponse(cache.response);
    return null;
  }

  await acquireLock();
  try {
    const resp = await fetchFn("https://api.anthropic.com/api/oauth/usage", {
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
    return parseUsageResponse(body);
  } catch {
    // Network error or timeout — use stale cache if available
    await releaseLock();
    if (cache) return parseUsageResponse(cache.response);
    return null;
  }
}
