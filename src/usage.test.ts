import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { formatResetTime, parseUsageResponse, fetchUsage, setTestDir, resetTestDir, setTestFetch, resetTestFetch } from "./usage";
import { join } from "path";
import { mkdtemp, rm, writeFile } from "fs/promises";
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
    resetTestFetch();
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

  function mockFetch(response: any, ok = true, status = 200): void {
    setTestFetch((async () => ({
      ok,
      status,
      json: async () => response,
    })) as any);
  }

  test("returns cached response when cache is fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await writeTestCache(nowSec, apiResponse);
    // No credentials needed — should return from cache without API call
    let fetchCalled = false;
    setTestFetch((async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; }) as any);

    const result = await fetchUsage();

    expect(fetchCalled).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.sessionPct).toBe(42);
    expect(result!.weeklyPct).toBe(25);
  });

  test("fetches from API when cache is stale", async () => {
    // Cache timestamp 2 minutes ago (stale, since TTL is 60s)
    const staleSec = Math.floor(Date.now() / 1000) - 120;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();

    const freshResponse = {
      five_hour: { utilization: 80.0, resets_at: "2025-12-12T22:00:00Z" },
      seven_day: { utilization: 50.0, resets_at: "2025-12-19T00:00:00Z" },
    };
    mockFetch(freshResponse);

    const result = await fetchUsage();

    expect(result).not.toBeNull();
    expect(result!.sessionPct).toBe(80);
    expect(result!.weeklyPct).toBe(50);
  });

  test("returns null when no token available and no cache", async () => {
    // No credentials file, no cache
    setTestFetch((async () => { throw new Error("should not be called"); }) as any);

    const result = await fetchUsage();
    expect(result).toBeNull();
  });

  test("returns stale cache when locked", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 120;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    // Create a fresh lock file
    await writeFile(join(tmpDir, "usage.lock"), "");

    let fetchCalled = false;
    setTestFetch((async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; }) as any);

    const result = await fetchUsage();

    expect(fetchCalled).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.sessionPct).toBe(42);
  });

  test("returns null when locked and no cache", async () => {
    await writeCredentials();
    await writeFile(join(tmpDir, "usage.lock"), "");

    const result = await fetchUsage();
    expect(result).toBeNull();
  });

  test("handles non-ok response with existing cache (backoff)", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 120;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    mockFetch({}, false, 500);

    const result = await fetchUsage();

    // Should return stale cache data
    expect(result).not.toBeNull();
    expect(result!.sessionPct).toBe(42);

    // Verify cache was rewritten with backoff timestamp
    const cacheFile = Bun.file(join(tmpDir, "usage-cache.json"));
    const updatedCache = await cacheFile.json();
    expect(updatedCache.nextBackoffMs).toBeDefined();
    // Retry timestamp should be in the future
    expect(updatedCache.timestamp).toBeGreaterThan(staleSec);
  });

  test("returns null on non-ok response with no cache", async () => {
    await writeCredentials();
    mockFetch({}, false, 500);

    const result = await fetchUsage();
    expect(result).toBeNull();
  });

  test("handles API error field in response body", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 120;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    mockFetch({ error: "something went wrong" });

    const result = await fetchUsage();

    // Should return stale cache
    expect(result).not.toBeNull();
    expect(result!.sessionPct).toBe(42);
  });

  test("handles network error with stale cache", async () => {
    const staleSec = Math.floor(Date.now() / 1000) - 120;
    await writeTestCache(staleSec, apiResponse);
    await writeCredentials();
    setTestFetch((async () => { throw new Error("network error"); }) as any);

    const result = await fetchUsage();

    expect(result).not.toBeNull();
    expect(result!.sessionPct).toBe(42);
  });

  test("returns null on network error with no cache", async () => {
    await writeCredentials();
    setTestFetch((async () => { throw new Error("network error"); }) as any);

    const result = await fetchUsage();
    expect(result).toBeNull();
  });

  test("successful fetch writes cache and cleans up lock", async () => {
    await writeCredentials();
    mockFetch(apiResponse);

    const result = await fetchUsage();

    expect(result).not.toBeNull();
    expect(result!.sessionPct).toBe(42);

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
    const staleSec = Math.floor(Date.now() / 1000) - 120;
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
    const staleSec = Math.floor(Date.now() / 1000) - 120;
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
