import { test, expect, describe } from "bun:test";
import { formatResetTime, parseUsageResponse } from "./usage";

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
