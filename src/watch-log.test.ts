import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { existsSync } from "fs";
import {
  logToWatchLog,
  setWatchLogPath,
  resetWatchLogPath,
  getWatchLogPath,
} from "./watch-log";

const ONE_MB = 1_048_576;

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "watch-log-test-"));
}

describe("watch-log", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
    logPath = join(tmp, "watch.log");
    setWatchLogPath(logPath);
  });

  afterEach(async () => {
    resetWatchLogPath();
    await rm(tmp, { recursive: true, force: true });
  });

  describe("logToWatchLog", () => {
    test("appends a line with ISO timestamp prefix", async () => {
      logToWatchLog("hello world");
      const content = await readFile(logPath, "utf8");
      expect(content).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z hello world\n$/,
      );
    });

    test("appends multiple lines", async () => {
      logToWatchLog("first");
      logToWatchLog("second");
      const content = await readFile(logPath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(lines[0]).toMatch(/ first$/);
      expect(lines[1]).toMatch(/ second$/);
    });

    test("creates parent directory if missing", async () => {
      const nested = join(tmp, "nested", "deeper", "watch.log");
      setWatchLogPath(nested);
      logToWatchLog("created the dir");
      const content = await readFile(nested, "utf8");
      expect(content).toContain("created the dir");
    });

    test("never throws when path is unwritable", () => {
      // Simulate a write to an impossible path. No throw expected.
      setWatchLogPath("/dev/null/cannot/write/here.log");
      expect(() => logToWatchLog("should not throw")).not.toThrow();
    });
  });

  describe("rotation", () => {
    test("file under 1 MB does not rotate", async () => {
      // Pre-fill below threshold.
      await writeFile(logPath, "x".repeat(ONE_MB - 100));
      logToWatchLog("still in main");
      expect(existsSync(`${logPath}.1`)).toBe(false);
      expect(existsSync(`${logPath}.2`)).toBe(false);
    });

    test("file at or over 1 MB triggers rotation to .1", async () => {
      // Pre-fill at threshold so the next write rotates.
      await writeFile(logPath, "x".repeat(ONE_MB));
      logToWatchLog("after rotate");

      expect(existsSync(`${logPath}.1`)).toBe(true);
      // The rotated .1 contains the old bulk content.
      const rotated = await readFile(`${logPath}.1`, "utf8");
      expect(rotated.length).toBe(ONE_MB);
      // The active log holds only the new line.
      const active = await readFile(logPath, "utf8");
      expect(active).toMatch(/after rotate\n$/);
      expect(active.length).toBeLessThan(200);
      expect(existsSync(`${logPath}.2`)).toBe(false);
    });

    test("existing .1 shifts to .2 on next rotation", async () => {
      // Pre-existing .1 (from a prior rotation) and an oversized active log.
      await writeFile(`${logPath}.1`, "old-one-content");
      await writeFile(logPath, "x".repeat(ONE_MB));

      logToWatchLog("triggers shift");

      // .2 now holds what used to be .1
      const dotTwo = await readFile(`${logPath}.2`, "utf8");
      expect(dotTwo).toBe("old-one-content");
      // .1 now holds the previously-active 1MB log
      const dotOne = await readFile(`${logPath}.1`, "utf8");
      expect(dotOne.length).toBe(ONE_MB);
      // Active log is fresh
      const active = await readFile(logPath, "utf8");
      expect(active).toMatch(/triggers shift\n$/);
    });

    test("existing .2 is deleted (not preserved) on rotation", async () => {
      // We cap at 3 files total: watch.log + .1 + .2. .2 is the oldest and
      // gets evicted when .1 needs to rotate into .2's slot.
      await writeFile(`${logPath}.2`, "evict-me");
      await writeFile(`${logPath}.1`, "becomes-dot-two");
      await writeFile(logPath, "x".repeat(ONE_MB));

      logToWatchLog("post-rotate");

      // Old .2 contents should be gone — it was overwritten by old .1
      const dotTwo = await readFile(`${logPath}.2`, "utf8");
      expect(dotTwo).toBe("becomes-dot-two");
      // No .3 should ever appear.
      expect(existsSync(`${logPath}.3`)).toBe(false);
    });

    test("works when no rotated files exist yet", async () => {
      await writeFile(logPath, "y".repeat(ONE_MB + 50));
      logToWatchLog("first rotation ever");

      expect(existsSync(`${logPath}.1`)).toBe(true);
      expect(existsSync(`${logPath}.2`)).toBe(false);
      expect(existsSync(`${logPath}.3`)).toBe(false);
    });

    test("works with missing parent dir", async () => {
      const nested = join(tmp, "missing", "watch.log");
      setWatchLogPath(nested);
      // No file exists yet — first write must succeed without rotating.
      expect(() => logToWatchLog("first")).not.toThrow();
      const content = await readFile(nested, "utf8");
      expect(content).toMatch(/first\n$/);
    });

    test("does not produce a watch.log.3 even after multiple rotations", async () => {
      // Three rotations in a row.
      for (let i = 0; i < 3; i++) {
        await writeFile(logPath, "z".repeat(ONE_MB));
        logToWatchLog(`rotation-${i}`);
      }
      expect(existsSync(`${logPath}.3`)).toBe(false);
      expect(existsSync(`${logPath}.2`)).toBe(true);
      expect(existsSync(`${logPath}.1`)).toBe(true);
    });
  });

  describe("path management", () => {
    test("getWatchLogPath returns the active path", () => {
      expect(getWatchLogPath()).toBe(logPath);
    });

    test("resetWatchLogPath restores the default", () => {
      resetWatchLogPath();
      expect(getWatchLogPath()).toMatch(/\.itsybitsy\/watch\.log$/);
    });
  });
});
