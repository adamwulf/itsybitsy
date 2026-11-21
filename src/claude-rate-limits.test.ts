import { setUserHome, resetUserHome } from "./home";
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  CLAUDE_RATE_LIMITS_FILE,
  claudeUsageFromRecord,
  combineWindows,
  deleteClaudeRateLimits,
  parseStatuslineRateLimits,
  readClaudeUsage,
  recordClaudeRateLimits,
  type ClaudeRateLimitsRecord,
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
    expect(usage.sessionWindowEnded).toBe(true);
    expect(usage.weeklyPct).toBe(60);
  });

  test("an ended weekly window does not mark the session window as ended", () => {
    const usage = claudeUsageFromRecord({
      updatedAt: NOW_S,
      five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: 100, resets_at: NOW_S - 1 },
    }, now);
    expect(usage.sessionPct).toBe(9);
    expect(usage.weeklyPct).toBe(0);
    expect(usage.sessionWindowEnded).toBeUndefined();
  });

  test("reports a missing window as null", () => {
    const usage = claudeUsageFromRecord({ updatedAt: NOW_S, seven_day: { used_percentage: 5, resets_at: NOW_S + 60 } }, now);
    expect(usage.sessionPct).toBeNull();
    expect(usage.sessionReset).toBeNull();
    expect(usage.sessionWindowEnded).toBeUndefined();
    expect(usage.weeklyPct).toBe(5);
  });
});

describe("combineWindows", () => {
  const RESET = NOW_S + 3 * 86_400;
  /** A record whose only window is a weekly report of `pct` written at `updatedAt`. */
  const weekly = (updatedAt: number, pct: number, resets_at = RESET): ClaudeRateLimitsRecord =>
    ({ updatedAt, seven_day: { used_percentage: pct, resets_at } });

  test("after a manual reset, the newest report wins over higher older ones in the same window", () => {
    // A reset keeps resets_at and drops used_percentage; idle sessions still
    // hold their readings from before it.
    const records = [
      weekly(NOW_S - 3000, 96),
      weekly(NOW_S - 2000, 95),
      weekly(NOW_S - 1000, 93),
      weekly(NOW_S - 60, 20),
      weekly(NOW_S - 30, 20),
    ];
    expect(combineWindows(records, "seven_day")).toEqual({ used_percentage: 20, resets_at: RESET });
  });

  test("normal growth: the newest report, which is also the highest, wins", () => {
    const records = [weekly(NOW_S - 600, 40), weekly(NOW_S - 300, 42), weekly(NOW_S - 60, 45)];
    expect(combineWindows(records, "seven_day")).toEqual({ used_percentage: 45, resets_at: RESET });
  });

  test("reports that share the newest updatedAt and disagree give their average", () => {
    const records = [weekly(NOW_S - 600, 96), weekly(NOW_S, 19), weekly(NOW_S, 20)];
    expect(combineWindows(records, "seven_day")).toEqual({ used_percentage: 19.5, resets_at: RESET });
  });

  test("a later window wins over an earlier one whatever their updatedAt", () => {
    // The old window's report is the most recently written; it still loses.
    const records: ClaudeRateLimitsRecord[] = [
      { updatedAt: NOW_S, five_hour: { used_percentage: 100, resets_at: NOW_S - 60 } },
      { updatedAt: NOW_S - 300, five_hour: { used_percentage: 2, resets_at: NOW_S + 5 * 3600 } },
    ];
    expect(combineWindows(records, "five_hour")).toEqual({ used_percentage: 2, resets_at: NOW_S + 5 * 3600 });
  });

  test("a newer record without the window does not count; no report gives undefined", () => {
    const records: ClaudeRateLimitsRecord[] = [
      weekly(NOW_S - 600, 30),
      { updatedAt: NOW_S, five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 } },
    ];
    expect(combineWindows(records, "seven_day")).toEqual({ used_percentage: 30, resets_at: RESET });
    expect(combineWindows([weekly(NOW_S, 30)], "five_hour")).toBeUndefined();
    expect(combineWindows([], "seven_day")).toBeUndefined();
  });
});

describe("recordClaudeRateLimits / readClaudeUsage", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-rate-limits-test-"));
    setUserHome(home);
    await Bun.write(join(home, ".itsybitsy", "machine-name"), "studio");
    setCoordinatorHome(home);
  });

  afterEach(async () => {
    resetUserHome();
    resetCoordinatorHome();
    await rm(home, { recursive: true, force: true });
  });

  function recordDir(id: string): string {
    return id === "@system" ? home : join(home, "agents", "studio", "repo", id);
  }

  function recordPath(agentId: string): string {
    return join(recordDir(agentId), CLAUDE_RATE_LIMITS_FILE);
  }

  test("writes the record under the agent's folder", async () => {
    await recordClaudeRateLimits(recordDir("agent-a"), {
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
    await recordClaudeRateLimits(recordDir("agent-a"), {
      five_hour: { used_percentage: 100, resets_at: NOW_S + 60 },
      seven_day: { used_percentage: 50, resets_at: NOW_S + 86_400 },
    }, NOW_MS);
    await recordClaudeRateLimits(recordDir("agent-a"), {
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

  test("a plan that stops reporting a 5-hour window: old records end it, a new report revives it", async () => {
    // A session from before the plan change keeps its old 5-hour window.
    await recordClaudeRateLimits(recordDir("old-session"), {
      five_hour: { used_percentage: 1, resets_at: NOW_S - 3600 },
      seven_day: { used_percentage: 6, resets_at: NOW_S + 86_400 },
    }, NOW_MS - 7_200_000);
    // A session started since then only ever reports the weekly window.
    await recordClaudeRateLimits(recordDir("new-session"), {
      seven_day: { used_percentage: 15, resets_at: NOW_S + 86_400 },
    }, NOW_MS);

    const ended = await readClaudeUsage(new Date(NOW_MS));
    expect(ended.data?.sessionWindowEnded).toBe(true);
    expect(ended.data?.sessionPct).toBe(0);
    expect(ended.data?.weeklyPct).toBe(15);

    // Any session reporting a live window brings the session reading back.
    await recordClaudeRateLimits(recordDir("new-session"), {
      five_hour: { used_percentage: 2, resets_at: NOW_S + 3600 },
    }, NOW_MS);

    const live = await readClaudeUsage(new Date(NOW_MS));
    expect(live.data?.sessionWindowEnded).toBeUndefined();
    expect(live.data?.sessionPct).toBe(2);
  });

  test("combines the windows of all agents: the current window, its newest report", async () => {
    await recordClaudeRateLimits(recordDir("agent-a"), {
      five_hour: { used_percentage: 20, resets_at: NOW_S + 3600 },
      seven_day: { used_percentage: 40, resets_at: NOW_S + 86_400 },
    }, NOW_MS - 600_000);
    await recordClaudeRateLimits(recordDir("agent-b"), {
      five_hour: { used_percentage: 70, resets_at: NOW_S + 3600 },
    }, NOW_MS - 300_000);
    await recordClaudeRateLimits(recordDir("@system"), {
      seven_day: { used_percentage: 45, resets_at: NOW_S + 86_400 },
    }, NOW_MS - 60_000);

    const result = await readClaudeUsage(new Date(NOW_MS));
    expect(result).toEqual({
      data: { sessionPct: 70, weeklyPct: 45, sessionReset: "1h 0m", weeklyReset: "1d 0h" },
      error: false,
    });
  });

  test("combines flat legacy usage with qualified agent usage", async () => {
    // A legacy agent ID can also be a machine prefix for newer agents.
    await recordClaudeRateLimits(join(home, "agents", "studio"), {
      five_hour: { resets_at: NOW_S + 3600, used_percentage: 65 },
    }, NOW_MS);
    await recordClaudeRateLimits(recordDir("agent-new"), {
      five_hour: { resets_at: NOW_S + 3600, used_percentage: 20 },
      seven_day: { resets_at: NOW_S + 86400, used_percentage: 70 },
    }, NOW_MS);
    const { data } = await readClaudeUsage(new Date(NOW_MS));
    expect(data?.sessionPct).toBe(65);
    expect(data?.weeklyPct).toBe(70);
  });

  test("aggregates old and new machine prefixes and the coordinator with a missing or changed machine name", async () => {
    const file = join(home, ".itsybitsy", "machine-name");
    const reader = () => readClaudeUsage(new Date(NOW_MS));
    await rm(file);
    await recordClaudeRateLimits(home, { seven_day: { resets_at: NOW_S + 86400, used_percentage: 75 } }, NOW_MS - 120_000);
    expect((await reader()).data?.weeklyPct).toBe(75);
    await recordClaudeRateLimits(recordDir("old"), { five_hour: { resets_at: NOW_S + 3600, used_percentage: 60 } }, NOW_MS);
    await recordClaudeRateLimits(join(home, "agents", "renamed", "repo", "new"), {
      seven_day: { resets_at: NOW_S + 86400, used_percentage: 90 },
    }, NOW_MS - 60_000);
    const missing = await reader();
    expect(missing.data?.sessionPct).toBe(60);
    expect(missing.data?.weeklyPct).toBe(90);
    await Bun.write(file, "renamed");
    expect(await reader()).toEqual(missing);
  });

  test("an idle session re-running its statusline with old values does not win", async () => {
    // An idle session last saw 2% in the current window; the account has
    // since reached 100% (agent-busy). The idle session's statusline runs
    // again later (a mode toggle, a refreshInterval) with its old values, so
    // the write is skipped and its record keeps the older updatedAt.
    await recordClaudeRateLimits(recordDir("agent-idle-same-window"), {
      five_hour: { used_percentage: 2, resets_at: NOW_S + 3600 },
    }, NOW_MS - 900_000);
    await recordClaudeRateLimits(recordDir("agent-busy"), {
      five_hour: { used_percentage: 100, resets_at: NOW_S + 3600 },
    }, NOW_MS - 600_000);
    await recordClaudeRateLimits(recordDir("agent-idle-same-window"), {
      five_hour: { used_percentage: 2, resets_at: NOW_S + 3600 },
    }, NOW_MS - 5_000);
    // A session that last saw the previous window, written most recently.
    await recordClaudeRateLimits(recordDir("agent-idle-old-window"), {
      five_hour: { used_percentage: 3, resets_at: NOW_S - 14_400 },
    }, NOW_MS - 1_000);

    const result = await readClaudeUsage(new Date(NOW_MS));
    expect(result.data?.sessionPct).toBe(100);
    expect(result.data?.sessionReset).toBe("1h 0m");
  });

  test("a manual weekly reset reads as the newest report, not the highest (live 96%-vs-20% case)", async () => {
    // Recorded 2026-11-17: idle agents still held the reading from before
    // the user reset the weekly limit, newer ones reported after it. All
    // carry the same resets_at. The footer showed 96%; the real usage was 20%.
    const resetsAt = 1795176000;
    const at = (s: number) => s * 1000;
    await recordClaudeRateLimits(recordDir("phase1-cleanup"), { seven_day: { used_percentage: 96, resets_at: resetsAt } }, at(1794810325));
    await recordClaudeRateLimits(recordDir("older-idle-a"), { seven_day: { used_percentage: 95, resets_at: resetsAt } }, at(1794805000));
    await recordClaudeRateLimits(recordDir("older-idle-b"), { seven_day: { used_percentage: 93, resets_at: resetsAt } }, at(1794790000));
    // Two agents wrote 19 and 20 in the same second; a later one wrote 20.
    await recordClaudeRateLimits(recordDir("today-a"), { seven_day: { used_percentage: 19, resets_at: resetsAt } }, at(1794940000));
    await recordClaudeRateLimits(recordDir("today-b"), { seven_day: { used_percentage: 20, resets_at: resetsAt } }, at(1794940000));
    await recordClaudeRateLimits(recordDir("today-c"), { seven_day: { used_percentage: 20, resets_at: resetsAt } }, at(1794945000));

    const result = await readClaudeUsage(new Date(at(1794950256)));
    expect(result.error).toBe(false);
    expect(result.data?.weeklyPct).toBe(20);
  });

  test("a new window's report wins over a higher report of the window that just reset", async () => {
    // After a limit reset: the limited agent still holds 100% for the old
    // window, and another agent has started the new window at 2%. The old
    // window's usage must not count, or the watchdog never nudges.
    await recordClaudeRateLimits(recordDir("agent-limited"), {
      five_hour: { used_percentage: 100, resets_at: NOW_S - 60 },
    }, NOW_MS - 120_000);
    await recordClaudeRateLimits(recordDir("agent-fresh"), {
      five_hour: { used_percentage: 2, resets_at: NOW_S + 5 * 3600 - 300 },
    }, NOW_MS - 300_000);

    const result = await readClaudeUsage(new Date(NOW_MS));
    expect(result.data?.sessionPct).toBe(2);
    expect(result.data?.sessionReset).toBe("4h 55m");
  });

  test("reports of one window with slightly different reset times are combined", async () => {
    // agent-b's later resets_at does not put agent-a's newer report in an
    // older window.
    await recordClaudeRateLimits(recordDir("agent-b"), {
      five_hour: { used_percentage: 4, resets_at: NOW_S + 3630 },
    }, NOW_MS - 60_000);
    await recordClaudeRateLimits(recordDir("agent-a"), {
      five_hour: { used_percentage: 90, resets_at: NOW_S + 3600 },
    }, NOW_MS);

    const result = await readClaudeUsage(new Date(NOW_MS));
    expect(result.data?.sessionPct).toBe(90);
    expect(result.data?.sessionReset).toBe("1h 0m");
  });

  test("does not rewrite the record when the windows are unchanged", async () => {
    const windows = { five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 } };
    await recordClaudeRateLimits(recordDir("agent-a"), windows, NOW_MS);
    await recordClaudeRateLimits(recordDir("agent-a"), windows, NOW_MS + 60_000);
    expect((await Bun.file(recordPath("agent-a")).json()).updatedAt).toBe(NOW_S);

    await recordClaudeRateLimits(recordDir("agent-a"), { five_hour: { used_percentage: 10, resets_at: NOW_S + 3600 } }, NOW_MS + 120_000);
    expect((await Bun.file(recordPath("agent-a")).json()).updatedAt).toBe(NOW_S + 120);
  });

  test("deleteClaudeRateLimits removes the record and temp files only", async () => {
    await recordClaudeRateLimits(recordDir("agent-a"), { five_hour: { used_percentage: 9, resets_at: NOW_S + 3600 } }, NOW_MS);
    const dir = recordDir("agent-a");
    await writeFile(join(dir, `${CLAUDE_RATE_LIMITS_FILE}.tmp.4242`), "{}");
    await writeFile(join(dir, "outbox.jsonl"), "");

    await deleteClaudeRateLimits(dir);

    expect((await readdir(dir)).sort()).toEqual(["outbox.jsonl"]);
    await deleteClaudeRateLimits(recordDir("missing")); // no folder: no error
  });

  test("skips unreadable records and folders without one", async () => {
    await mkdir(recordDir("agent-empty"), { recursive: true });
    await mkdir(recordDir("agent-bad"), { recursive: true });
    await writeFile(recordPath("agent-bad"), "{not json");
    await recordClaudeRateLimits(recordDir("agent-ok"), {
      seven_day: { used_percentage: 33, resets_at: NOW_S + 86_400 },
    }, NOW_MS);

    const result = await readClaudeUsage(new Date(NOW_MS));
    expect(result.data?.weeklyPct).toBe(33);
  });

  test("returns no reading and no error when nothing is recorded", async () => {
    expect(await readClaudeUsage(new Date(NOW_MS))).toEqual({ data: null, error: false });
    await mkdir(join(home, "agents", "old-flat-agent"), { recursive: true });
    await mkdir(recordDir("agent-a"), { recursive: true });
    expect(await readClaudeUsage(new Date(NOW_MS))).toEqual({ data: null, error: false });
  });
});
