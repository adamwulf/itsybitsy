import { test, expect, describe } from "bun:test";
import { formatTimestamp, buildTimestampContext } from "./inject-timestamp";

// A fixed epoch used across tests: 2025-05-29 19:32:07 UTC.
const FIXED_EPOCH_MS = 1748547127000;
const FIXED_EPOCH_SECONDS = 1748547127;

// `Intl` resolves the local timezone once at process start and ignores later
// `process.env.TZ` mutations, so tests pass an explicit IANA zone for
// determinism rather than mutating the environment.

describe("formatTimestamp", () => {
  test("formats local time with timezone abbreviation and raw epoch seconds", () => {
    // 19:32:07 UTC is 14:32:07 in America/Chicago (CDT, summer).
    expect(formatTimestamp(FIXED_EPOCH_MS, "America/Chicago")).toBe(
      `2025-05-29 14:32:07 CDT (epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });

  test("respects the provided timezone (UTC)", () => {
    expect(formatTimestamp(FIXED_EPOCH_MS, "UTC")).toBe(
      `2025-05-29 19:32:07 UTC (epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });

  test("respects the provided timezone (Tokyo, offset-style zone name)", () => {
    // 19:32:07 UTC is 04:32:07 next day in Asia/Tokyo (+09:00). The short zone
    // name for Tokyo resolves to an offset form ("GMT+9") in this ICU build
    // rather than "JST" — assert the date/time, not the exact zone label.
    expect(formatTimestamp(FIXED_EPOCH_MS, "Asia/Tokyo")).toMatch(
      new RegExp(`^2025-05-30 04:32:07 .+ \\(epoch ${FIXED_EPOCH_SECONDS}\\)$`),
    );
  });

  test("uses zero-padded two-digit month/day/time fields", () => {
    // 2025-01-02 03:04:05 UTC
    const epochMs = Date.UTC(2025, 0, 2, 3, 4, 5);
    expect(formatTimestamp(epochMs, "UTC")).toBe(
      `2025-01-02 03:04:05 UTC (epoch ${Math.floor(epochMs / 1000)})`,
    );
  });

  test("normalizes midnight to 00 rather than 24", () => {
    const epochMs = Date.UTC(2025, 5, 1, 0, 0, 0); // 2025-06-01 00:00:00 UTC
    expect(formatTimestamp(epochMs, "UTC")).toContain("2025-06-01 00:00:00 UTC");
  });

  test("floors sub-second epoch to whole seconds", () => {
    // 999ms past the fixed second should still report the same epoch seconds.
    expect(formatTimestamp(FIXED_EPOCH_MS + 999, "UTC")).toContain(
      `(epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });

  test("defaults to the machine local timezone when none is given", () => {
    // Without an explicit zone the output still parses into the expected shape;
    // we don't assert the zone name (it varies by host) but the rest is fixed.
    const out = formatTimestamp(FIXED_EPOCH_MS);
    expect(out).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} .+ \(epoch 1748547127\)$/,
    );
  });
});

describe("buildTimestampContext", () => {
  test("prefixes the timestamp with a human-readable label", () => {
    expect(buildTimestampContext(FIXED_EPOCH_MS, "America/Chicago")).toBe(
      `Current time: 2025-05-29 14:32:07 CDT (epoch ${FIXED_EPOCH_SECONDS})`,
    );
  });
});
