import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { formatResetTime, parseUsageResponse, parseCodexRateLimits, parseGeminiUsage, fetchCodexUsage, fetchGeminiUsage, fetchUsage, setTestDir, resetTestDir, fetchCtx, spawnCtx, type UsageResult } from "./usage";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { mockFetch as createMockFetch } from "./test-utils";

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

describe("parseUsageResponse", () => {
  const now = new Date("2025-12-12T16:15:00Z");

  test("parses full response", () => {
    const result = parseUsageResponse(
      {
        five_hour: { utilization: 57.3, resets_at: "2025-12-12T16:59:00Z" },
        seven_day: { utilization: 35.1, resets_at: "2025-12-15T00:00:00Z" },
      },
      now,
    );
    expect(result).toEqual({
      sessionPct: 57,
      weeklyPct: 35,
      sessionReset: "44m",
      weeklyReset: "2d 7h",
    });
  });

  test("rounds utilization to integer", () => {
    const result = parseUsageResponse(
      {
        five_hour: { utilization: 99.9, resets_at: "2025-12-12T17:00:00Z" },
        seven_day: { utilization: 0.4, resets_at: "2025-12-15T00:00:00Z" },
      },
      now,
    );
    expect(result.sessionPct).toBe(100);
    expect(result.weeklyPct).toBe(0);
  });

  test("handles missing five_hour", () => {
    const result = parseUsageResponse(
      { seven_day: { utilization: 50, resets_at: "2025-12-15T00:00:00Z" } },
      now,
    );
    expect(result.sessionPct).toBeNull();
    expect(result.sessionReset).toBeNull();
    expect(result.weeklyPct).toBe(50);
  });

  test("handles missing seven_day", () => {
    const result = parseUsageResponse(
      { five_hour: { utilization: 50, resets_at: "2025-12-12T17:00:00Z" } },
      now,
    );
    expect(result.weeklyPct).toBeNull();
    expect(result.weeklyReset).toBeNull();
    expect(result.sessionPct).toBe(50);
  });

  test("handles empty response", () => {
    const result = parseUsageResponse({}, now);
    expect(result).toEqual({
      sessionPct: null,
      weeklyPct: null,
      sessionReset: null,
      weeklyReset: null,
    });
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

describe("fetchUsage", () => {
  let tmpDir: string;

  const apiResponse = {
    five_hour: { utilization: 42.0, resets_at: "2025-12-12T20:00:00Z" },
    seven_day: { utilization: 25.0, resets_at: "2025-12-18T00:00:00Z" },
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "usage-test-"));
    setTestDir(tmpDir);
  });

  afterEach(async () => {
    resetTestDir();
    fetchCtx.reset();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Write a credentials file so readAccessToken succeeds. */
  async function writeCredentials(token = "test-token"): Promise<void> {
    const credPath = join(tmpDir, "credentials.json");
    await Bun.write(credPath, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  }

  /** Write a cache file with the given timestamp (epoch seconds). */
  async function writeTestCache(timestampSec: number, response = apiResponse, nextBackoffMs?: number): Promise<void> {
    const cachePath = join(tmpDir, "usage-cache.json");
    const cache: any = { timestamp: timestampSec, response };
    if (nextBackoffMs !== undefined) cache.nextBackoffMs = nextBackoffMs;
    await Bun.write(cachePath, JSON.stringify(cache));
  }

  function mockFetch(response: unknown, ok = true, status = 200): void {
    fetchCtx.set(createMockFetch(response, ok, status));
  }

  test("returns cached response when cache is fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await writeTestCache(nowSec, apiResponse);
    // No credentials needed — should return from cache without API call
    let fetchCalled = false;
    fetchCtx.set((async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; }) as any);

    const result = await fetchUsage();

    expect(fetchCalled).toBe(false);
    expect(result.error).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
    expect(result.data!.weeklyPct).toBe(25);
  });

  test("cache is still fresh at 2 minutes (within 3-minute TTL)", async () => {
    // Cache timestamp 2 minutes ago — should still be fresh with 180s TTL
    const twoMinAgo = Math.floor(Date.now() / 1000) - 120;
    await writeTestCache(twoMinAgo, apiResponse);
    let fetchCalled = false;
    fetchCtx.set((async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; }) as any);

    const result = await fetchUsage();

    expect(fetchCalled).toBe(false);
    expect(result.error).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("fetches from API when cache is stale", async () => {
    // Cache timestamp 4 minutes ago (stale, since TTL is 180s)
    const staleSec = Math.floor(Date.now() / 1000) - 240;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();

    const freshResponse = {
      five_hour: { utilization: 80.0, resets_at: "2025-12-12T22:00:00Z" },
      seven_day: { utilization: 50.0, resets_at: "2025-12-19T00:00:00Z" },
    };
    mockFetch(freshResponse);

    const result = await fetchUsage();

    expect(result.error).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(80);
    expect(result.data!.weeklyPct).toBe(50);
  });

  test("returns error when no token available and no cache", async () => {
    // No credentials file, no cache
    fetchCtx.set((async () => { throw new Error("should not be called"); }) as any);

    const result = await fetchUsage();
    expect(result.data).toBeNull();
    expect(result.error).toBe(true);
  });

  test("returns stale cache when locked", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 240;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    // Create a fresh lock file
    await writeFile(join(tmpDir, "usage.lock"), "");

    let fetchCalled = false;
    fetchCtx.set((async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; }) as any);

    const result = await fetchUsage();

    expect(fetchCalled).toBe(false);
    expect(result.error).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("returns error when locked and no cache", async () => {
    await writeCredentials();
    await writeFile(join(tmpDir, "usage.lock"), "");

    const result = await fetchUsage();
    expect(result.data).toBeNull();
    expect(result.error).toBe(true);
  });

  test("handles non-ok response with existing cache (backoff)", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 240;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    mockFetch({}, false, 500);

    const result = await fetchUsage();

    // Should return stale cache data with error flag
    expect(result.error).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);

    // Verify cache was rewritten with backoff timestamp
    const cacheFile = Bun.file(join(tmpDir, "usage-cache.json"));
    const updatedCache = await cacheFile.json();
    expect(updatedCache.nextBackoffMs).toBeDefined();
    // Retry timestamp should be in the future
    expect(updatedCache.timestamp).toBeGreaterThan(staleSec);
  });

  test("returns error on non-ok response with no cache", async () => {
    await writeCredentials();
    mockFetch({}, false, 500);

    const result = await fetchUsage();
    expect(result.data).toBeNull();
    expect(result.error).toBe(true);
  });

  test("handles API error field in response body", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 240;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    mockFetch({ error: "something went wrong" });

    const result = await fetchUsage();

    // Should return stale cache with error flag
    expect(result.error).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("handles network error with stale cache", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 240;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    fetchCtx.set((async () => { throw new Error("network error"); }) as any);

    const result = await fetchUsage();

    expect(result.error).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("returns error on network error with no cache", async () => {
    await writeCredentials();
    fetchCtx.set((async () => { throw new Error("network error"); }) as any);

    const result = await fetchUsage();
    expect(result.data).toBeNull();
    expect(result.error).toBe(true);
  });

  test("successful fetch writes cache and cleans up lock", async () => {
    await writeCredentials();
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(result.error).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);

    // Cache should exist
    const cacheFile = Bun.file(join(tmpDir, "usage-cache.json"));
    expect(await cacheFile.exists()).toBe(true);
    const cache = await cacheFile.json();
    expect(cache.response).toEqual(apiResponse);
    expect(cache.nextBackoffMs).toBe(60_000);

    // Lock should be released
    const lockFile = Bun.file(join(tmpDir, "usage.lock"));
    expect(await lockFile.exists()).toBe(false);
  });

  test("backoff increases on repeated errors", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 240;
    // Simulate prior backoff of 120s
    await writeTestCache(staleSec, apiResponse, 120_000);
    await writeCredentials();
    mockFetch({}, false, 500);

    await fetchUsage();

    const cache = await Bun.file(join(tmpDir, "usage-cache.json")).json();
    // nextBackoffMs should be 120_000 + 60_000 = 180_000
    expect(cache.nextBackoffMs).toBe(180_000);
  });

  test("backoff caps at MAX_BACKOFF_MS (10 minutes)", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 240;
    // Already at max backoff
    await writeTestCache(staleSec, apiResponse, 600_000);
    await writeCredentials();
    mockFetch({}, false, 500);

    await fetchUsage();

    const cache = await Bun.file(join(tmpDir, "usage-cache.json")).json();
    // Should cap at 600_000 (10 minutes)
    expect(cache.nextBackoffMs).toBe(600_000);
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

describe("readAccessToken keychain fallback", () => {
  let tmpDir: string;

  const apiResponse = {
    five_hour: { utilization: 42.0, resets_at: "2025-12-12T20:00:00Z" },
    seven_day: { utilization: 25.0, resets_at: "2025-12-18T00:00:00Z" },
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "usage-keychain-"));
    setTestDir(tmpDir);
  });

  afterEach(async () => {
    resetTestDir();
    fetchCtx.reset();
    spawnCtx.reset();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function mockFetch(response: unknown, ok = true): void {
    fetchCtx.set(createMockFetch(response, ok, ok ? 200 : 500));
  }

  /** Create a mock spawn that simulates keychain output. */
  function mockSpawn(stdout: string, exitCode: number): void {
    spawnCtx.set(() => {
      const stdoutBlob = new Blob([stdout]);
      return {
        stdout: stdoutBlob.stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(exitCode),
      };
    });
  }

  test("uses keychain token when credentials file missing", async () => {
    // No credentials file — triggers keychain fallback
    const keychainJson = JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } });
    mockSpawn(keychainJson, 0);
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("uses raw keychain value as token when not JSON", async () => {
    // No credentials file; keychain returns a plain string (not JSON)
    mockSpawn("raw-access-token-value", 0);
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("uses raw keychain value as token when JSON is malformed", async () => {
    // No credentials file; keychain returns invalid JSON — falls through to
    // "not JSON — use raw value as token" path
    mockSpawn("{invalid json", 0);
    mockFetch(apiResponse);

    const result = await fetchUsage();

    // The raw string "{invalid json" is used as token, so API call proceeds
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("returns null when keychain command fails (non-zero exit)", async () => {
    // No credentials file; keychain command exits with error
    mockSpawn("", 44); // security returns 44 when item not found

    const result = await fetchUsage();

    expect(result.data).toBeNull();
  });

  test("returns null when keychain returns JSON without token field", async () => {
    // No credentials file; keychain returns valid JSON but missing accessToken
    const noTokenJson = JSON.stringify({ someOtherField: "value" });
    mockSpawn(noTokenJson, 0);

    const result = await fetchUsage();

    // JSON parsed OK but no claudeAiOauth.accessToken, so token is undefined → null
    expect(result.data).toBeNull();
  });

  test("returns null when keychain returns empty output", async () => {
    // No credentials file; keychain returns empty string
    mockSpawn("", 0);

    const result = await fetchUsage();

    expect(result.data).toBeNull();
  });

  test("returns null when spawn throws (keychain not available)", async () => {
    // No credentials file; spawn itself throws
    spawnCtx.set(() => {
      throw new Error("spawn failed");
    });

    const result = await fetchUsage();

    expect(result.data).toBeNull();
  });

  test("prefers credentials file over keychain", async () => {
    // Write a valid credentials file
    await Bun.write(join(tmpDir, "credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }));

    // Keychain should NOT be called
    let spawnCalled = false;
    spawnCtx.set(() => {
      spawnCalled = true;
      return {
        stdout: new Blob([]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(1),
      };
    });
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(spawnCalled).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("falls through to keychain when credentials file has empty token", async () => {
    // Write credentials with empty token
    await Bun.write(join(tmpDir, "credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "" } }));

    const keychainJson = JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } });
    mockSpawn(keychainJson, 0);
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("falls through to keychain when credentials file has no claudeAiOauth field", async () => {
    // Credentials file exists but missing the claudeAiOauth key
    await Bun.write(join(tmpDir, "credentials.json"),
      JSON.stringify({ someOtherKey: "value" }));

    const keychainJson = JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } });
    mockSpawn(keychainJson, 0);
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("falls through to keychain when credentials file has non-string accessToken", async () => {
    // accessToken is a number instead of string — typeof check fails
    await Bun.write(join(tmpDir, "credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: 12345 } }));

    const keychainJson = JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } });
    mockSpawn(keychainJson, 0);
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(result.data).not.toBeNull();
    expect(result.data!.sessionPct).toBe(42);
  });

  test("returns null when keychain returns JSON with empty accessToken", async () => {
    // No credentials file; keychain returns valid JSON but token is empty string
    const emptyTokenJson = JSON.stringify({ claudeAiOauth: { accessToken: "" } });
    mockSpawn(emptyTokenJson, 0);

    const result = await fetchUsage();

    expect(result.data).toBeNull();
  });

  test("returns null when keychain returns whitespace-only output", async () => {
    // No credentials file; keychain output trims to empty string
    mockSpawn("   \n  \t  ", 0);

    const result = await fetchUsage();

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
});

