import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timed, timedSync } from "./perf";

let tmpDir: string;
let logPath: string;
const savedPerf = process.env.IB_PERF;
const savedLog = process.env.IB_PERF_LOG;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ib-perf-test-"));
  logPath = join(tmpDir, "perf.jsonl");
});

afterEach(() => {
  if (savedPerf === undefined) delete process.env.IB_PERF;
  else process.env.IB_PERF = savedPerf;
  if (savedLog === undefined) delete process.env.IB_PERF_LOG;
  else process.env.IB_PERF_LOG = savedLog;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readEntries(path: string): Array<Record<string, unknown>> {
  const content = readFileSync(path, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("timed (disabled)", () => {
  test("returns the function's result", async () => {
    delete process.env.IB_PERF;
    process.env.IB_PERF_LOG = logPath;
    const result = await timed("merge", "phase-a", async () => 42);
    expect(result).toBe(42);
  });

  test("does not write to disk", async () => {
    delete process.env.IB_PERF;
    process.env.IB_PERF_LOG = logPath;
    await timed("merge", "phase-a", async () => "ok");
    expect(existsSync(logPath)).toBe(false);
  });

  test("propagates errors without writing", async () => {
    delete process.env.IB_PERF;
    process.env.IB_PERF_LOG = logPath;
    await expect(timed("merge", "phase-a", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(existsSync(logPath)).toBe(false);
  });

  test("supports synchronous wrapped functions", async () => {
    delete process.env.IB_PERF;
    const result = await timed("x", "y", () => 7);
    expect(result).toBe(7);
  });
});

describe("timed (enabled)", () => {
  test("returns the function's result and writes a JSONL line", async () => {
    process.env.IB_PERF = "1";
    process.env.IB_PERF_LOG = logPath;
    const result = await timed("merge", "rebase", async () => "done");
    expect(result).toBe("done");
    expect(existsSync(logPath)).toBe(true);
    const entries = readEntries(logPath);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.cmd).toBe("merge");
    expect(entry.phase).toBe("rebase");
    expect(typeof entry.ts).toBe("number");
    expect(entry.pid).toBe(process.pid);
    expect(typeof entry.ms).toBe("number");
    expect(entry.ms as number).toBeGreaterThanOrEqual(0);
  });

  test("ms field reflects elapsed time", async () => {
    process.env.IB_PERF = "1";
    process.env.IB_PERF_LOG = logPath;
    await timed("c", "p", async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    const entries = readEntries(logPath);
    expect(entries[0]!.ms as number).toBeGreaterThan(10);
  });

  test("propagates thrown errors after recording duration", async () => {
    process.env.IB_PERF = "1";
    process.env.IB_PERF_LOG = logPath;
    await expect(timed("c", "p", async () => {
      throw new Error("kaboom");
    })).rejects.toThrow("kaboom");
    expect(existsSync(logPath)).toBe(true);
    const entries = readEntries(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cmd).toBe("c");
    expect(entries[0]!.phase).toBe("p");
  });

  test("appends multiple entries to the same log", async () => {
    process.env.IB_PERF = "1";
    process.env.IB_PERF_LOG = logPath;
    await timed("a", "one", async () => 1);
    await timed("a", "two", async () => 2);
    await timed("b", "three", async () => 3);
    const entries = readEntries(logPath);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.phase)).toEqual(["one", "two", "three"]);
  });

  test("creates the parent directory lazily", async () => {
    process.env.IB_PERF = "1";
    const nested = join(tmpDir, "nested", "dir", "perf.jsonl");
    process.env.IB_PERF_LOG = nested;
    await timed("c", "p", async () => 1);
    expect(existsSync(nested)).toBe(true);
    expect(statSync(nested).isFile()).toBe(true);
  });
});

describe("timedSync", () => {
  test("returns result and is a no-op when disabled", () => {
    delete process.env.IB_PERF;
    process.env.IB_PERF_LOG = logPath;
    const result = timedSync("c", "p", () => 99);
    expect(result).toBe(99);
    expect(existsSync(logPath)).toBe(false);
  });

  test("writes JSONL when enabled", () => {
    process.env.IB_PERF = "1";
    process.env.IB_PERF_LOG = logPath;
    const result = timedSync("c", "p", () => "x");
    expect(result).toBe("x");
    const entries = readEntries(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cmd).toBe("c");
    expect(entries[0]!.phase).toBe("p");
    expect(entries[0]!.ms as number).toBeGreaterThanOrEqual(0);
  });

  test("propagates thrown errors after recording duration", () => {
    process.env.IB_PERF = "1";
    process.env.IB_PERF_LOG = logPath;
    expect(() => timedSync("c", "p", () => {
      throw new Error("sync boom");
    })).toThrow("sync boom");
    const entries = readEntries(logPath);
    expect(entries).toHaveLength(1);
  });
});
