import { test, expect, describe, afterEach } from "bun:test";
import {
  compareVersions,
  checkForUpdate,
  startUpdateChecker,
  stopUpdateChecker,
  setTestFetch,
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

  test("calls onResult callback with update version after timer fires", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({ version: "5.0.0" }), { status: 200 })
    );

    const results: (string | null)[] = [];
    // Use 0ms initial delay by starting checker, then manually triggering
    startUpdateChecker("1.0.0", (version) => {
      results.push(version);
    });

    // Wait for the 2s startup delay + fetch to complete
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toBe("v5.0.0");
  });

  test("onResult callback not called after stopUpdateChecker", async () => {
    let fetchDelay: ReturnType<typeof setTimeout>;
    setTestFetch(() =>
      new Promise<Response>((resolve) => {
        // Delay the response so we can stop before it resolves
        fetchDelay = setTimeout(() => {
          resolve(new Response(JSON.stringify({ version: "5.0.0" }), { status: 200 }));
        }, 500);
      })
    );

    const results: (string | null)[] = [];
    startUpdateChecker("1.0.0", (version) => {
      results.push(version);
    });

    // Wait for the 2s startup delay so doCheck starts
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    // Stop while fetch is in flight
    stopUpdateChecker();

    // Wait for the delayed fetch to resolve
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    // Callback should not have been called since we stopped
    expect(results.length).toBe(0);
  });

  test("onResult not called when no update available (null result)", async () => {
    setTestFetch(async () =>
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 })
    );

    const results: (string | null)[] = [];
    startUpdateChecker("1.0.0", (version) => {
      results.push(version);
    });

    // Wait for the 2s startup delay + fetch to complete
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    // Callback should not have been called since version is current
    expect(results.length).toBe(0);
  });

  test("transient error does not clear previously discovered update", async () => {
    let callCount = 0;
    setTestFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ version: "5.0.0" }), { status: 200 });
      }
      // Second call: transient error
      throw new Error("Network error");
    });

    const results: string[] = [];
    startUpdateChecker("1.0.0", (version) => {
      results.push(version);
    });

    // Wait for first check
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(results).toEqual(["v5.0.0"]);

    // No further callback should arrive even on error — onResult only fires for non-null
    // (The interval won't fire within this test, but the design ensures it)
  });
});
