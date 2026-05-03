import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  readCachedChatId,
  writeCachedChatId,
  clearCachedChatId,
  setStateDir,
  resetStateDir,
} from "./chat-id-cache";
import {
  setStateDir as setAccessStateDir,
  resetStateDir as resetAccessStateDir,
} from "./access";

let tmpRoot: string;
let stateDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "chat-id-cache-test-"));
  stateDir = join(tmpRoot, "channels", "telegram");
  setStateDir(stateDir);
});

afterEach(async () => {
  resetStateDir();
  resetAccessStateDir();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("readCachedChatId", () => {
  test("returns null when file is missing", async () => {
    expect(await readCachedChatId()).toBeNull();
  });

  test("does not create the state directory on a pure read of a missing file", async () => {
    await readCachedChatId();
    let exists = true;
    try {
      await readdir(stateDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("round-trip: write then read returns the same id", async () => {
    await writeCachedChatId("12345");
    expect(await readCachedChatId()).toBe("12345");
  });

  test("returns null on an empty file", async () => {
    await writeCachedChatId("seed"); // creates dir
    const path = join(stateDir, "chat-id-cache.json");
    await writeFile(path, "");
    expect(await readCachedChatId()).toBeNull();
  });

  test("recovers from corrupt JSON by renaming aside and returning null", async () => {
    await writeCachedChatId("seed");
    const path = join(stateDir, "chat-id-cache.json");
    await writeFile(path, "{not valid json");

    expect(await readCachedChatId()).toBeNull();

    const entries = await readdir(stateDir);
    const corruptFiles = entries.filter((f) => f.startsWith("chat-id-cache.json.corrupt-"));
    expect(corruptFiles.length).toBe(1);
    expect(entries.includes("chat-id-cache.json")).toBe(false);
  });

  test("recovers from wrong-shape JSON (missing chat_id)", async () => {
    await writeCachedChatId("seed");
    const path = join(stateDir, "chat-id-cache.json");
    await writeFile(path, JSON.stringify({ totally: "different shape" }));

    expect(await readCachedChatId()).toBeNull();

    const entries = await readdir(stateDir);
    const corruptFiles = entries.filter((f) => f.startsWith("chat-id-cache.json.corrupt-"));
    expect(corruptFiles.length).toBe(1);
  });

  test("recovers from non-string chat_id", async () => {
    await writeCachedChatId("seed");
    const path = join(stateDir, "chat-id-cache.json");
    await writeFile(
      path,
      JSON.stringify({ chat_id: 12345, cached_at: new Date().toISOString() }),
    );

    expect(await readCachedChatId()).toBeNull();
  });

  test("returns null on empty-string chat_id", async () => {
    await writeCachedChatId("seed");
    const path = join(stateDir, "chat-id-cache.json");
    await writeFile(
      path,
      JSON.stringify({ chat_id: "", cached_at: new Date().toISOString() }),
    );

    expect(await readCachedChatId()).toBeNull();
  });
});

describe("writeCachedChatId", () => {
  test("creates the state directory on first touch", async () => {
    await writeCachedChatId("123");
    const entries = await readdir(stateDir);
    expect(entries.includes("chat-id-cache.json")).toBe(true);
  });

  test("atomic write: no .tmp file is left behind on success", async () => {
    await writeCachedChatId("42");
    const entries = await readdir(stateDir);
    const tmpFiles = entries.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  test("overwrites an existing cache", async () => {
    await writeCachedChatId("first");
    await writeCachedChatId("second");
    expect(await readCachedChatId()).toBe("second");
  });

  test("persists ISO 8601 cached_at timestamp", async () => {
    const before = Date.now();
    await writeCachedChatId("99");
    const after = Date.now();
    const path = join(stateDir, "chat-id-cache.json");
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw);
    expect(typeof parsed.cached_at).toBe("string");
    const ts = Date.parse(parsed.cached_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("clearCachedChatId", () => {
  test("deletes the cache file", async () => {
    await writeCachedChatId("99");
    await clearCachedChatId();
    expect(await readCachedChatId()).toBeNull();
  });

  test("idempotent — swallows ENOENT", async () => {
    await clearCachedChatId();
    await clearCachedChatId();
    expect(await readCachedChatId()).toBeNull();
  });
});

describe("state dir resolution", () => {
  test("falls back to access.ts's defaultStateDir when no local override is set", async () => {
    // Reset our local override and point the access module at a known dir.
    resetStateDir();
    const altRoot = await mkdtemp(join(tmpdir(), "chat-id-cache-fallback-"));
    const altDir = join(altRoot, "channels", "telegram");
    setAccessStateDir(altDir);
    try {
      await writeCachedChatId("alt");
      const entries = await readdir(altDir);
      expect(entries.includes("chat-id-cache.json")).toBe(true);
      expect(await readCachedChatId()).toBe("alt");
    } finally {
      resetAccessStateDir();
      await rm(altRoot, { recursive: true, force: true });
    }
  });
});
