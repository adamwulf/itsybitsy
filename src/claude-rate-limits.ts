/**
 * Claude plan usage (the 5-hour and 7-day rate limits) without the keychain.
 *
 * Claude Code sends `rate_limits` to its statusLine command (Pro/Max accounts,
 * after the session's first API response). Every Claude session ib launches
 * runs `ib hooks statusline <id>` (src/hooks/statusline.ts), which records the
 * two windows here in `~/.itsybitsy/agents/<id>/claude-rate-limits.json`. The
 * `ib watch` status bar and the watchdog's rate-limit recovery combine the
 * records of all agents (see `combineWindows`).
 *
 * ib used to call the Anthropic usage API with the OAuth token from the macOS
 * keychain (`security find-generic-password`). On recent macOS a keychain read
 * from a CLI tool can show a password dialog, and a locked keychain shows one
 * for every read, so ib no longer reads the keychain at all.
 */

import { join } from "path";
import { mkdir, readdir, rename, unlink } from "fs/promises";
import { getCoordinatorHome } from "./coordinator";
import { agentOutboxDir } from "./outbox";
import { formatResetTime } from "./usage";
import type { UsageData, UsageResult } from "./usage";

export const CLAUDE_RATE_LIMITS_FILE = "claude-rate-limits.json";

/** One rate-limit window as Claude Code reports it. */
export interface RateLimitWindow {
  /** Percentage of the window used, 0-100. */
  used_percentage: number;
  /** Unix epoch seconds when the window resets. */
  resets_at: number;
}

/** The windows a statusline input carries. Either can be absent. */
export interface ClaudeRateLimits {
  five_hour?: RateLimitWindow;
  seven_day?: RateLimitWindow;
}

export interface ClaudeRateLimitsRecord extends ClaudeRateLimits {
  /** Epoch seconds when this record's windows last changed (diagnostic only). */
  updatedAt: number;
}

/**
 * Two reports of one window can carry slightly different `resets_at` values.
 * Distinct windows are at least 5 hours apart (a new 5-hour window starts at
 * the first request after the old one resets), so reports within an hour of
 * each other are the same window.
 */
const SAME_WINDOW_SECONDS = 3600;

function parseWindow(value: unknown): RateLimitWindow | undefined {
  const w = value as { used_percentage?: unknown; resets_at?: unknown } | null | undefined;
  if (typeof w?.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) return undefined;
  if (typeof w.resets_at !== "number" || !Number.isFinite(w.resets_at)) return undefined;
  return { used_percentage: w.used_percentage, resets_at: w.resets_at };
}

/**
 * The 5-hour and 7-day windows of a parsed statusline input, or null when it
 * has neither (no `rate_limits` yet, or an account without plan limits).
 */
export function parseStatuslineRateLimits(input: unknown): ClaudeRateLimits | null {
  const rateLimits = (input as { rate_limits?: { five_hour?: unknown; seven_day?: unknown } } | null)?.rate_limits;
  const fiveHour = parseWindow(rateLimits?.five_hour);
  const sevenDay = parseWindow(rateLimits?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return {
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
}

async function readRecord(path: string): Promise<ClaudeRateLimitsRecord | null> {
  try {
    const raw = (await Bun.file(path).json()) as { updatedAt?: unknown; five_hour?: unknown; seven_day?: unknown };
    if (typeof raw?.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null;
    const fiveHour = parseWindow(raw.five_hour);
    const sevenDay = parseWindow(raw.seven_day);
    return {
      updatedAt: raw.updatedAt,
      ...(fiveHour ? { five_hour: fiveHour } : {}),
      ...(sevenDay ? { seven_day: sevenDay } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Merge `windows` into the agent's record. A window absent from `windows`
 * keeps its previous value: Claude Code drops a window from its input once
 * the window resets, and the reader needs the old `resets_at` to see that the
 * window has reset (a rate-limited agent's last record would otherwise lose
 * its 5-hour window exactly when it becomes usable again).
 */
export async function recordClaudeRateLimits(
  agentId: string,
  windows: ClaudeRateLimits,
  now: number = Date.now(),
): Promise<void> {
  const dir = agentOutboxDir(agentId);
  const path = join(dir, CLAUDE_RATE_LIMITS_FILE);
  const previous = await readRecord(path);
  const merged: ClaudeRateLimits = {
    ...(previous?.five_hour ? { five_hour: previous.five_hour } : {}),
    ...(previous?.seven_day ? { seven_day: previous.seven_day } : {}),
    ...windows,
  };
  // Most statusline runs repeat the session's last reading; skip the write.
  if (previous && sameWindow(previous.five_hour, merged.five_hour) && sameWindow(previous.seven_day, merged.seven_day)) {
    return;
  }
  const record: ClaudeRateLimitsRecord = { updatedAt: Math.floor(now / 1000), ...merged };
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  await Bun.write(tmpPath, JSON.stringify(record));
  await rename(tmpPath, path);
}

function sameWindow(a: RateLimitWindow | undefined, b: RateLimitWindow | undefined): boolean {
  if (!a || !b) return a === b;
  return a.used_percentage === b.used_percentage && a.resets_at === b.resets_at;
}

/**
 * Delete an agent's record (and any temp file a killed statusline run left)
 * from its folder at teardown, so `deleteAgentOutbox` can remove the folder.
 */
export async function deleteClaudeRateLimits(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(CLAUDE_RATE_LIMITS_FILE)) continue;
    try {
      await unlink(join(dir, entry));
    } catch {
      // Best effort, like the rest of teardown.
    }
  }
}

/**
 * The account's current window from all agents' reports of it. Each session
 * reports the last values it saw, and an idle session keeps reporting old
 * ones, so the record's write time says nothing about which report is
 * current. The current window is the one that resets last; within it, usage
 * only grows, so the highest reported percentage is the latest.
 */
export function combineWindows(windows: Array<RateLimitWindow | undefined>): RateLimitWindow | undefined {
  const reports = windows.filter((w): w is RateLimitWindow => w !== undefined);
  if (reports.length === 0) return undefined;
  const latestReset = Math.max(...reports.map((w) => w.resets_at));
  const current = reports.filter((w) => latestReset - w.resets_at < SAME_WINDOW_SECONDS);
  return {
    used_percentage: Math.max(...current.map((w) => w.used_percentage)),
    resets_at: latestReset,
  };
}

/**
 * One window as status-bar usage: its percentage and time to reset, or 0%
 * with no reset time once `resets_at` has passed (the window has reset).
 */
function windowUsage(window: RateLimitWindow | undefined, now: Date): { pct: number | null; reset: string | null } {
  if (!window) return { pct: null, reset: null };
  if (window.resets_at * 1000 <= now.getTime()) return { pct: 0, reset: null };
  return {
    pct: Math.max(0, Math.min(100, Math.round(window.used_percentage))),
    reset: formatResetTime(new Date(window.resets_at * 1000).toISOString(), now),
  };
}

/** Convert a record to the shared status-bar usage shape. */
export function claudeUsageFromRecord(record: ClaudeRateLimitsRecord, now: Date = new Date()): UsageData {
  const session = windowUsage(record.five_hour, now);
  const weekly = windowUsage(record.seven_day, now);
  return {
    sessionPct: session.pct,
    weeklyPct: weekly.pct,
    sessionReset: session.reset,
    weeklyReset: weekly.reset,
  };
}

/**
 * Claude plan usage from the records of every agent's statusline. All agents
 * share one account, so each window is combined across records
 * (`combineWindows`). `data` is null (and `error` false) when no Claude
 * session has recorded rate limits yet — nothing failed, there is no reading.
 */
export async function readClaudeUsage(now: Date = new Date()): Promise<UsageResult> {
  const agentsDir = join(getCoordinatorHome(), "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return { data: null, error: false };
  }
  const records = (await Promise.all(
    entries.map((entry) => readRecord(join(agentsDir, entry, CLAUDE_RATE_LIMITS_FILE))),
  )).filter((record): record is ClaudeRateLimitsRecord => record !== null);
  if (records.length === 0) return { data: null, error: false };
  const fiveHour = combineWindows(records.map((r) => r.five_hour));
  const sevenDay = combineWindows(records.map((r) => r.seven_day));
  const combined: ClaudeRateLimitsRecord = {
    updatedAt: Math.max(...records.map((r) => r.updatedAt)),
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
  return { data: claudeUsageFromRecord(combined, now), error: false };
}
