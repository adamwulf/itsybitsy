import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  compareVersions,
  checkForUpdate,
  getUpdateAvailable,
  startUpdateChecker,
  stopUpdateChecker,
  setTestFetch,
  setTestVersion,
  resetTestOverrides,
} from "./update-check";

describe("compareVersions", () => {
  test("returns 0 for equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("returns 1 when b is newer (patch)", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(1);
  });

  test("returns 1 when b is newer (minor)", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBe(1);
  });

  test("returns 1 when b is newer (major)", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(1);
  });

  test("returns -1 when a is newer", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBe(-1);
  });

  test("handles v prefix", () => {
    expect(compareVersions("v1.0.0", "v1.0.1")).toBe(1);
  });

  test("handles mixed v prefix", () => {
    expect(compareVersions("1.0.0", "v1.0.1")).toBe(1);
  });
});

describe("checkForUpdate", () => {
  afterEach(() => {
    resetTestOverrides();
  });

  test("returns version string when newer exists", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({ version: "2.0.0" }), { status: 200 })
    );
    const result = await checkForUpdate("1.0.0");
    expect(result).toBe("v2.0.0");
  });

  test("returns null when current is latest", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 })
    );
    const result = await checkForUpdate("1.0.0");
    expect(result).toBeNull();
  });

  test("returns null when current is newer than registry", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({ version: "0.9.0" }), { status: 200 })
    );
    const result = await checkForUpdate("1.0.0");
    expect(result).toBeNull();
  });

  test("returns null on fetch error", async () => {
    setTestFetch(async () => {
      throw new Error("Network error");
    });
    const result = await checkForUpdate("1.0.0");
    expect(result).toBeNull();
  });

  test("returns null on non-ok response", async () => {
    setTestFetch(async () => new Response("Not found", { status: 404 }));
    const result = await checkForUpdate("1.0.0");
    expect(result).toBeNull();
  });

  test("returns null when response has no version field", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({}), { status: 200 })
    );
    const result = await checkForUpdate("1.0.0");
    expect(result).toBeNull();
  });

  test("returns null for empty current version", async () => {
    const result = await checkForUpdate("");
    expect(result).toBeNull();
  });

  test("normalizes v prefix in result", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({ version: "v2.0.0" }), { status: 200 })
    );
    const result = await checkForUpdate("1.0.0");
    expect(result).toBe("v2.0.0");
  });
});

describe("startUpdateChecker / stopUpdateChecker", () => {
  afterEach(() => {
    stopUpdateChecker();
    resetTestOverrides();
  });

  test("getUpdateAvailable returns null before any check", () => {
    expect(getUpdateAvailable()).toBeNull();
  });

  test("stopUpdateChecker resets cached result", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 })
    );
    const result = await checkForUpdate("1.0.0");
    expect(result).toBe("v9.9.9");
    stopUpdateChecker();
    expect(getUpdateAvailable()).toBeNull();
  });
});
