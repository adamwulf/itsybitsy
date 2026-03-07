/**
 * Claude API usage tracking — fetches session/weekly utilization from Anthropic API.
 * Caches at ~/.itsybitsy/usage-cache.json with 5-minute TTL.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { rename, mkdir } from "node:fs/promises";

const ITSYBITSY_DIR = join(homedir(), ".itsybitsy");
const CACHE_PATH = join(ITSYBITSY_DIR, "usage-cache.json");
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const CACHE_TTL_MS = 60_000; // 1 minute normal refresh
const MAX_BACKOFF_MS = 10 * 60_000; // 10 minutes max backoff on failures

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

  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!resp.ok) {
      if (cache) {
        const backoffMs = Math.min(cache.nextBackoffMs ?? 60_000, MAX_BACKOFF_MS);
        const nextBackoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        // Set timestamp so next retry happens after backoffMs
        const retryTimestamp = Math.floor((now + backoffMs - CACHE_TTL_MS) / 1000);
        await writeCache({ timestamp: retryTimestamp, response: cache.response, nextBackoffMs });
        return parseUsageResponse(cache.response);
      }
      return null;
    }

    const body = (await resp.json()) as ApiResponse;

    if (body.error) {
      if (cache) {
        const backoffMs = Math.min(cache.nextBackoffMs ?? 60_000, MAX_BACKOFF_MS);
        const nextBackoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        const retryTimestamp = Math.floor((now + backoffMs - CACHE_TTL_MS) / 1000);
        await writeCache({ timestamp: retryTimestamp, response: cache.response, nextBackoffMs });
        return parseUsageResponse(cache.response);
      }
      return null;
    }

    // Success — write cache with no backoff
    await writeCache({ timestamp: Math.floor(now / 1000), response: body, nextBackoffMs: 60_000 });
    return parseUsageResponse(body);
  } catch {
    // Network error — use stale cache if available
    if (cache) return parseUsageResponse(cache.response);
    return null;
  }
}
