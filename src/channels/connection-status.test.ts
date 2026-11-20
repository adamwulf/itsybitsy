import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  setStatusDir,
  resetStatusDir,
  telegramStatusPath,
  readTelegramStatus,
  writeTelegramStatus,
  clearTelegramStatus,
  type TelegramConnectionStatus,
} from "./connection-status";

const sample = (over: Partial<TelegramConnectionStatus> = {}): TelegramConnectionStatus => ({
  state: "reconnecting",
  lastError: "HTTP 502",
  lastErrorAt: 1_000,
  outboxPending: 2,
  pid: 4242,
  updatedAt: 2_000,
  ...over,
});

describe("connection-status", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-status-"));
    setStatusDir(dir);
  });
  afterEach(() => {
    resetStatusDir();
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file reads as null", async () => {
    expect(await readTelegramStatus(() => true)).toBeNull();
  });

  test("write then read round-trips, with liveness from the injected check", async () => {
    await writeTelegramStatus(sample());
    expect(await readTelegramStatus(() => true)).toEqual({ status: sample(), live: true });
    expect(await readTelegramStatus(() => false)).toEqual({ status: sample(), live: false });
  });

  test("malformed or wrong-shape content reads as null", async () => {
    writeFileSync(telegramStatusPath(), "{not json");
    expect(await readTelegramStatus(() => true)).toBeNull();
    writeFileSync(telegramStatusPath(), JSON.stringify({ ...sample(), state: "weird" }));
    expect(await readTelegramStatus(() => true)).toBeNull();
    writeFileSync(telegramStatusPath(), JSON.stringify({ ...sample(), pid: 0 }));
    expect(await readTelegramStatus(() => true)).toBeNull();
  });

  test("default liveness check sees this process as alive", async () => {
    await writeTelegramStatus(sample({ pid: process.pid }));
    expect((await readTelegramStatus())?.live).toBe(true);
  });

  test("clear removes only a file the owner wrote", async () => {
    await writeTelegramStatus(sample({ pid: 111 }));
    await clearTelegramStatus(222);
    expect(existsSync(telegramStatusPath())).toBe(true);
    await clearTelegramStatus(111);
    expect(existsSync(telegramStatusPath())).toBe(false);
    // Idempotent on a missing file.
    await clearTelegramStatus(111);
  });
});
