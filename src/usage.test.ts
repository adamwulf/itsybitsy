import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { formatResetTime, parseCodexRateLimits, parseGeminiUsage, fetchCodexUsage, fetchGeminiUsage, setTestDir, resetTestDir, spawnCtx } from "./usage";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";

describe("formatResetTime", () => {
  const now = new Date("2025-12-12T16:15:00Z");

  test("formats days and hours", () => {
    expect(formatResetTime("2025-12-15T00:00:00Z", now)).toBe("2d 7h");
  });

  test("formats hours and minutes", () => {
    expect(formatResetTime("2025-12-12T18:30:00Z", now)).toBe("2h 15m");
  });

  test("formats minutes only", () => {
    expect(formatResetTime("2025-12-12T16:59:00Z", now)).toBe("44m");
  });

  test("returns 'now' for past time", () => {
    expect(formatResetTime("2025-12-12T15:00:00Z", now)).toBe("now");
  });

  test("returns 'now' for exact current time", () => {
    expect(formatResetTime("2025-12-12T16:15:00Z", now)).toBe("now");
  });

  test("formats exactly 1 day", () => {
    expect(formatResetTime("2025-12-13T16:15:00Z", now)).toBe("1d 0h");
  });

  test("formats exactly 1 hour", () => {
    expect(formatResetTime("2025-12-12T17:15:00Z", now)).toBe("1h 0m");
  });
});

describe("parseCodexRateLimits", () => {
  const now = new Date("2026-05-31T20:00:00Z");

  test("parses Codex primary and secondary limit windows", () => {
    const result = parseCodexRateLimits(
      {
        primary: { used_percent: 4.4, window_minutes: 300, resets_at: 1780275600 },
        secondary: { used_percent: 1.2, window_minutes: 10080, resets_at: 1780779600 },
      },
      now,
    );

    expect(result).toEqual({
      sessionPct: 4,
      weeklyPct: 1,
      sessionReset: "5h 0m",
      weeklyReset: "6d 1h",
    });
  });

  test("classifies current shape (primary=weekly 10080, secondary null)", () => {
    const result = parseCodexRateLimits(
      {
        primary: { used_percent: 3.3, window_minutes: 10080, resets_at: 1780779600 },
        secondary: null as any,
      },
      now,
    );

    expect(result).toEqual({
      sessionPct: null,
      weeklyPct: 3,
      sessionReset: null,
      weeklyReset: "6d 1h",
    });
  });

  test("classifies by window_minutes, not position, when windows are reversed", () => {
    const result = parseCodexRateLimits(
      {
        primary: { used_percent: 1.2, window_minutes: 10080, resets_at: 1780779600 },
        secondary: { used_percent: 4.4, window_minutes: 300, resets_at: 1780275600 },
      },
      now,
    );

    expect(result).toEqual({
      sessionPct: 4,
      weeklyPct: 1,
      sessionReset: "5h 0m",
      weeklyReset: "6d 1h",
    });
  });

  test("falls back to positional meaning when window_minutes is missing", () => {
    const result = parseCodexRateLimits(
      {
        primary: { used_percent: 4.4, resets_at: 1780275600 },
        secondary: { used_percent: 1.2, resets_at: 1780779600 },
      },
      now,
    );

    expect(result).toEqual({
      sessionPct: 4,
      weeklyPct: 1,
      sessionReset: "5h 0m",
      weeklyReset: "6d 1h",
    });
  });
});

describe("fetchCodexUsage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codex-usage-test-"));
    setTestDir(tmpDir);
  });

  afterEach(async () => {
    resetTestDir();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads newest Codex rate limits from session jsonl", async () => {
    const sessionsDir = join(tmpDir, "codex-sessions", "2026", "05", "31");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "rollout-old.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-31T19:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 12, window_minutes: 300, resets_at: 1780275600 },
            secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1780779600 },
          },
        },
      }) + "\n",
    );
    await writeFile(
      join(sessionsDir, "rollout-new.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-31T20:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 42, window_minutes: 300, resets_at: 1780275600 },
            secondary: { used_percent: 9, window_minutes: 10080, resets_at: 1780779600 },
          },
        },
      }) + "\n",
    );

    const result = await fetchCodexUsage();

    expect(result.error).toBe(false);
    expect(result.data?.sessionPct).toBe(42);
    expect(result.data?.weeklyPct).toBe(9);
  });

  test("returns an error when no Codex usage payload exists", async () => {
    const result = await fetchCodexUsage();

    expect(result.error).toBe(true);
    expect(result.data).toBeNull();
  });
});

describe("parseGeminiUsage", () => {
  const now = new Date("2026-09-02T23:44:44Z");

  test("parses full quota output with session and weekly limits", () => {
    const output = [
      "Quota:",
      "Gemini Models          Weekly Limit Remaining     100%  2026-09-10T04:38:29Z",
      "Gemini Models          Five Hour Limit Remaining  99%   2026-09-03T09:38:29Z",
      "Claude and GPT models  Weekly Limit Remaining     100%  2026-09-10T04:44:18Z",
      "Claude and GPT models  Five Hour Limit Remaining  100%  2026-09-03T09:44:18Z",
    ].join("\n");

    const result = parseGeminiUsage(output, now);
    expect(result.sessionPct).toBe(1); // 100 - 99 = 1% used
    expect(result.weeklyPct).toBe(0); // 100 - 100 = 0% used
    expect(result.sessionReset).toBe("9h 53m");
    expect(result.weeklyReset).toBe("7d 4h");
  });

  test("parses when user does not have session limits (weekly only)", () => {
    const output = [
      "Quota:",
      "Gemini Models          Weekly Limit Remaining     80%  2026-09-10T04:38:29Z",
      "Claude and GPT models  Weekly Limit Remaining     100%  2026-09-10T04:44:18Z",
    ].join("\n");

    const result = parseGeminiUsage(output, now);
    expect(result.sessionPct).toBeNull();
    expect(result.sessionReset).toBeNull();
    expect(result.weeklyPct).toBe(20); // 100 - 80 = 20% used
    expect(result.weeklyReset).toBe("7d 4h");
  });

  test("parses 0% remaining as 100% used", () => {
    const output = "Gemini Models   Five Hour Limit Remaining   0%   2026-09-03T09:38:29Z";
    const result = parseGeminiUsage(output, now);
    expect(result.sessionPct).toBe(100);
  });

  test("handles ANSI color escape sequences", () => {
    const output = "\x1b[32mGemini Models\x1b[0m          \x1b[1mWeekly Limit Remaining\x1b[0m     \x1b[33m75%\x1b[0m  2026-09-10T04:38:29Z";
    const result = parseGeminiUsage(output, now);
    expect(result.weeklyPct).toBe(25);
    expect(result.weeklyReset).toBe("7d 4h");
  });

  test("returns all nulls when output has no Gemini lines", () => {
    const output = [
      "Quota:",
      "Claude and GPT models  Weekly Limit Remaining     100%  2026-09-10T04:44:18Z",
      "Claude and GPT models  Five Hour Limit Remaining  100%  2026-09-03T09:44:18Z",
    ].join("\n");

    const result = parseGeminiUsage(output, now);
    expect(result).toEqual({
      sessionPct: null,
      weeklyPct: null,
      sessionReset: null,
      weeklyReset: null,
    });
  });

  test("returns all nulls on empty output", () => {
    const result = parseGeminiUsage("", now);
    expect(result).toEqual({
      sessionPct: null,
      weeklyPct: null,
      sessionReset: null,
      weeklyReset: null,
    });
  });
});

describe("fetchGeminiUsage", () => {
  let tmpDir: string;
  const sampleAgyOutput = [
    "Quota:",
    "Gemini Models          Weekly Limit Remaining     90%  2026-09-10T04:38:29Z",
    "Gemini Models          Five Hour Limit Remaining  95%   2026-09-03T09:38:29Z",
  ].join("\n");

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gemini-usage-test-"));
    setTestDir(tmpDir);
  });

  afterEach(async () => {
    resetTestDir();
    spawnCtx.reset();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function mockAgySpawn(stdout: string, exitCode: number): void {
    spawnCtx.set(() => {
      const stdoutBlob = new Blob([stdout]);
      return {
        stdout: stdoutBlob.stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(exitCode),
      };
    });
  }

  test("fetches from agy and caches result", async () => {
    mockAgySpawn(sampleAgyOutput, 0);

    const result = await fetchGeminiUsage();
    expect(result.error).toBe(false);
    expect(result.data?.sessionPct).toBe(5); // 100 - 95
    expect(result.data?.weeklyPct).toBe(10); // 100 - 90

    // Check cache file was written
    const cacheFile = Bun.file(join(tmpDir, "gemini-usage-cache.json"));
    expect(await cacheFile.exists()).toBe(true);
    const cached = await cacheFile.json();
    expect(cached.data.sessionPct).toBe(5);
    expect(cached.data.weeklyPct).toBe(10);
  });

  test("returns cached response when cache is fresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeFile(
      join(tmpDir, "gemini-usage-cache.json"),
      JSON.stringify({
        timestamp: now,
        data: { sessionPct: 15, weeklyPct: 8, sessionReset: "2h", weeklyReset: "5d" },
      }),
    );

    // If runner is invoked it will fail
    mockAgySpawn("should not be called", 1);

    const result = await fetchGeminiUsage();
    expect(result.error).toBe(false);
    expect(result.data?.sessionPct).toBe(15);
  });

  test("returns error when agy command fails and no cache exists", async () => {
    mockAgySpawn("error: command not found", 1);

    const result = await fetchGeminiUsage();
    expect(result.error).toBe(true);
    expect(result.data).toBeNull();
  });

  test("returns stale cache with error: true when agy command fails", async () => {
    // Write stale cache (4 minutes old)
    const oldTimestamp = Math.floor((Date.now() - 240_000) / 1000);
    await writeFile(
      join(tmpDir, "gemini-usage-cache.json"),
      JSON.stringify({
        timestamp: oldTimestamp,
        data: { sessionPct: 7, weeklyPct: 3, sessionReset: "1h", weeklyReset: "4d" },
      }),
    );

    mockAgySpawn("network failure", 1);

    const result = await fetchGeminiUsage();
    expect(result.error).toBe(true);
    expect(result.data?.sessionPct).toBe(7);
  });

  function mockAgySpawnWithStderr(stdout: string, stderr: string, exitCode: number): void {
    spawnCtx.set(() => ({
      stdout: new Blob([stdout]).stream(),
      stderr: new Blob([stderr]).stream(),
      exited: Promise.resolve(exitCode),
    }));
  }

  test("a successful run does not report authFailed", async () => {
    // Login words in a run that parses must not flag it: the login check runs
    // only when the run gives no usage data.
    mockAgySpawn(`${sampleAgyOutput}\nTo switch accounts, log in again.`, 0);

    const result = await fetchGeminiUsage();
    expect(result.error).toBe(false);
    expect(result.authFailed).toBeUndefined();
  });

  test("a run that times out reports authFailed and is killed", async () => {
    // agy's OAuth flow blocks while it waits on the browser: the run never
    // exits on its own. kill() ends it so no stream is left open.
    let killed = false;
    spawnCtx.set(() => {
      let closeStdout = () => {};
      let closeStderr = () => {};
      let exit = (_code: number) => {};
      return {
        stdout: new ReadableStream({ start(c) { closeStdout = () => c.close(); } }),
        stderr: new ReadableStream({ start(c) { closeStderr = () => c.close(); } }),
        exited: new Promise<number>((resolve) => { exit = resolve; }),
        kill: () => {
          killed = true;
          closeStdout();
          closeStderr();
          exit(143);
        },
      };
    });

    const result = await fetchGeminiUsage(undefined, 20);
    expect(result.authFailed).toBe(true);
    expect(result.error).toBe(true);
    expect(result.data).toBeNull();
    expect(killed).toBe(true);
  });

  test("a failed run with a login message on stderr reports authFailed", async () => {
    mockAgySpawnWithStderr("", "Error: not signed in. Run agy and sign in first.", 1);

    const result = await fetchGeminiUsage();
    expect(result.authFailed).toBe(true);
    expect(result.error).toBe(true);
  });

  test("a run with a login message on stdout and no usage reports authFailed", async () => {
    mockAgySpawnWithStderr("You are not logged in. Please Log In to continue.", "", 0);

    const result = await fetchGeminiUsage();
    expect(result.authFailed).toBe(true);
    expect(result.error).toBe(true);
  });

  test("a non-zero exit without a login message does not report authFailed", async () => {
    mockAgySpawnWithStderr("", "error: quota service unavailable (design in progress)", 1);

    const result = await fetchGeminiUsage();
    expect(result.error).toBe(true);
    expect(result.authFailed).toBeUndefined();
  });

  test("a login message keeps the stale cache as the result", async () => {
    const oldTimestamp = Math.floor((Date.now() - 240_000) / 1000);
    await writeFile(
      join(tmpDir, "gemini-usage-cache.json"),
      JSON.stringify({
        timestamp: oldTimestamp,
        data: { sessionPct: 7, weeklyPct: 3, sessionReset: "1h", weeklyReset: "4d" },
      }),
    );
    mockAgySpawnWithStderr("", "not logged in", 1);

    const result = await fetchGeminiUsage();
    expect(result.authFailed).toBe(true);
    expect(result.error).toBe(true);
    expect(result.data?.sessionPct).toBe(7);
  });
});

