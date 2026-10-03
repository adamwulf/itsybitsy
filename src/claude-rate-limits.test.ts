import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  CLAUDE_RATE_LIMITS_FILE,
  claudeUsageFromRecord,
  parseStatuslineRateLimits,
  readClaudeUsage,
  recordClaudeRateLimits,
} from "./claude-rate-limits";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";

const NOW_MS = Date.UTC(2026, 9, 3, 23, 0, 0); // 2026-10-03T23:00:00Z
const NOW_S = NOW_MS / 1000;

describe("parseStatuslineRateLimits", () => {
  test("returns both windows from a statusline input", () => {
    const input = {
      rate_limits: {
        five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 },
        seven_day: { used_percentage: 11.5, resets_at: NOW_S + 86_400 },
      },
    };
    expect(parseStatuslineRateLimits(input)).toEqual({
      five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: 11.5, resets_at: NOW_S + 86_400 },
    });
  });

  test("returns only the windows that are present", () => {
    const input = { rate_limits: { seven_day: { used_percentage: 40, resets_at: NOW_S + 60 } } };
    expect(parseStatuslineRateLimits(input)).toEqual({ seven_day: { used_percentage: 40, resets_at: NOW_S + 60 } });
  });

  test("returns null with no rate_limits, no windows, or malformed windows", () => {
    expect(parseStatuslineRateLimits({ model: { id: "claude-opus-5-5" } })).toBeNull();
    expect(parseStatuslineRateLimits({ rate_limits: {} })).toBeNull();
    expect(parseStatuslineRateLimits({
      rate_limits: { five_hour: { used_percentage: "9", resets_at: NOW_S }, seven_day: { used_percentage: 5 } },
    })).toBeNull();
    expect(parseStatuslineRateLimits(null)).toBeNull();
  });
});

describe("claudeUsageFromRecord", () => {
  const now = new Date(NOW_MS);

  test("reports a live window's percentage and time to reset", () => {
    const usage = claudeUsageFromRecord({
      updatedAt: NOW_S,
      five_hour: { used_percentage: 83.6, resets_at: NOW_S + 2 * 3600 + 30 * 60 },
      seven_day: { used_percentage: 41.2, resets_at: NOW_S + 3 * 86_400 + 4 * 3600 },
    }, now);
    expect(usage).toEqual({ sessionPct: 84, weeklyPct: 41, sessionReset: "2h 30m", weeklyReset: "3d 4h" });
  });

  test("reports a window whose reset time has passed as 0% with no reset time", () => {
    const usage = claudeUsageFromRecord({
      updatedAt: NOW_S - 7200,
      five_hour: { used_percentage: 100, resets_at: NOW_S - 1 },
      seven_day: { used_percentage: 60, resets_at: NOW_S + 86_400 },
    }, now);
    expect(usage.sessionPct).toBe(0);
    expect(usage.sessionReset).toBeNull();
    expect(usage.weeklyPct).toBe(60);
  });

  test("reports a missing window as null", () => {
    const usage = claudeUsageFromRecord({ updatedAt: NOW_S, seven_day: { used_percentage: 5, resets_at: NOW_S + 60 } }, now);
    expect(usage.sessionPct).toBeNull();
    expect(usage.sessionReset).toBeNull();
    expect(usage.weeklyPct).toBe(5);
  });
});

describe("recordClaudeRateLimits / readClaudeUsage", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-rate-limits-test-"));
    setCoordinatorHome(home);
  });

  afterEach(async () => {
    resetCoordinatorHome();
    await rm(home, { recursive: true, force: true });
  });

  function recordPath(agentId: string): string {
    return join(home, "agents", agentId, CLAUDE_RATE_LIMITS_FILE);
  }

  test("writes the record under the agent's folder", async () => {
    await recordClaudeRateLimits("agent-a", {
      five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: 11, resets_at: NOW_S + 86_400 },
    }, NOW_MS);

    expect(await Bun.file(recordPath("agent-a")).json()).toEqual({
      updatedAt: NOW_S,
      five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: 11, resets_at: NOW_S + 86_400 },
    });
  });

  test("keeps a window that a later input leaves out, so its reset stays visible", async () => {
    // A rate-limited agent: 5-hour window full. Claude Code then drops the
    // window from its input when the window resets.
    await recordClaudeRateLimits("agent-a", {
      five_hour: { used_percentage: 100, resets_at: NOW_S + 60 },
      seven_day: { used_percentage: 50, resets_at: NOW_S + 86_400 },
    }, NOW_MS);
    await recordClaudeRateLimits("agent-a", {
      seven_day: { used_percentage: 51, resets_at: NOW_S + 86_400 },
    }, NOW_MS + 120_000);

    const record = await Bun.file(recordPath("agent-a")).json();
    expect(record.five_hour).toEqual({ used_percentage: 100, resets_at: NOW_S + 60 });
    expect(record.seven_day.used_percentage).toBe(51);

    // Read after the reset: the kept 5-hour window reads as 0%.
    const result = await readClaudeUsage(new Date(NOW_MS + 120_000));
    expect(result.error).toBe(false);
    expect(result.data?.sessionPct).toBe(0);
    expect(result.data?.weeklyPct).toBe(51);
  });

  test("reads the newest record across all agents", async () => {
    await recordClaudeRateLimits("agent-old", {
      five_hour: { used_percentage: 70, resets_at: NOW_S + 3600 },
    }, NOW_MS - 600_000);
    await recordClaudeRateLimits("agent-new", {
      five_hour: { used_percentage: 20, resets_at: NOW_S + 3600 },
    }, NOW_MS - 60_000);
    await recordClaudeRateLimits("@system", {
      five_hour: { used_percentage: 50, resets_at: NOW_S + 3600 },
    }, NOW_MS - 300_000);

    const result = await readClaudeUsage(new Date(NOW_MS));
    expect(result).toEqual({
      data: { sessionPct: 20, weeklyPct: null, sessionReset: "1h 0m", weeklyReset: null },
      error: false,
    });
  });

  test("skips unreadable records and folders without one", async () => {
    await mkdir(join(home, "agents", "agent-empty"), { recursive: true });
    await mkdir(join(home, "agents", "agent-bad"), { recursive: true });
    await writeFile(recordPath("agent-bad"), "{not json");
    await recordClaudeRateLimits("agent-ok", {
      seven_day: { used_percentage: 33, resets_at: NOW_S + 86_400 },
    }, NOW_MS);

    const result = await readClaudeUsage(new Date(NOW_MS));
    expect(result.data?.weeklyPct).toBe(33);
  });

  test("returns no reading and no error when nothing is recorded", async () => {
    expect(await readClaudeUsage(new Date(NOW_MS))).toEqual({ data: null, error: false });
    await mkdir(join(home, "agents", "agent-a"), { recursive: true });
    expect(await readClaudeUsage(new Date(NOW_MS))).toEqual({ data: null, error: false });
  });
});
