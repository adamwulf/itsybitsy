import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  readAccess,
  addChat,
  removeChat,
  isAllowed,
  isGroupShaped,
  setStateDir,
  resetStateDir,
  readChatId,
  writeChatId,
} from "./access";

let tmpRoot: string;
let stateDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "access-test-"));
  stateDir = join(tmpRoot, "channels", "telegram");
  setStateDir(stateDir);
});

afterEach(async () => {
  resetStateDir();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("readAccess", () => {
  test("returns empty state when file does not exist", async () => {
    const state = await readAccess();
    expect(state).toEqual({ allowed_chat_ids: [], allowed_user_ids: [] });
  });

  test("does not create the state directory on a pure read of a missing file", async () => {
    await readAccess();
    // dir should not exist yet — we only create on writes
    let exists = true;
    try {
      await readdir(stateDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("round-trip: write then read returns equal state", async () => {
    await addChat("12345");
    await addChat("67890");
    const state = await readAccess();
    expect(state.allowed_chat_ids).toEqual(["12345", "67890"]);
    expect(state.allowed_user_ids).toEqual([]);
  });

  test("recovers from corrupt JSON by renaming aside and returning empty state", async () => {
    // Pre-create the state dir + a corrupt file
    await addChat("seed"); // creates dir
    await removeChat("seed");
    const accessPath = join(stateDir, "access.json");
    await writeFile(accessPath, "{not valid json");

    const state = await readAccess();
    expect(state).toEqual({ allowed_chat_ids: [], allowed_user_ids: [] });

    // The corrupt file should have been renamed aside.
    const entries = await readdir(stateDir);
    const corruptFiles = entries.filter((f) => f.startsWith("access.json.corrupt-"));
    expect(corruptFiles.length).toBe(1);
    // Original path should be absent (we never re-wrote it on a pure read)
    expect(entries.includes("access.json")).toBe(false);
  });

  test("recovers from wrong-shape JSON (e.g. missing fields)", async () => {
    await addChat("seed");
    await removeChat("seed");
    const accessPath = join(stateDir, "access.json");
    await writeFile(accessPath, JSON.stringify({ totally: "different shape" }));

    const state = await readAccess();
    expect(state).toEqual({ allowed_chat_ids: [], allowed_user_ids: [] });

    const entries = await readdir(stateDir);
    const corruptFiles = entries.filter((f) => f.startsWith("access.json.corrupt-"));
    expect(corruptFiles.length).toBe(1);
  });

  test("recovers from non-string array elements", async () => {
    await addChat("seed");
    await removeChat("seed");
    const accessPath = join(stateDir, "access.json");
    await writeFile(
      accessPath,
      JSON.stringify({ allowed_chat_ids: [1, 2, 3], allowed_user_ids: [] })
    );

    const state = await readAccess();
    expect(state).toEqual({ allowed_chat_ids: [], allowed_user_ids: [] });
  });
});

describe("addChat / removeChat", () => {
  test("addChat is idempotent", async () => {
    expect(await addChat("42")).toBe(true);
    expect(await addChat("42")).toBe(false);
    const state = await readAccess();
    expect(state.allowed_chat_ids).toEqual(["42"]);
  });

  test("removeChat is idempotent", async () => {
    await addChat("42");
    expect(await removeChat("42")).toBe(true);
    expect(await removeChat("42")).toBe(false);
    const state = await readAccess();
    expect(state.allowed_chat_ids).toEqual([]);
  });

  test("removeChat on missing entry returns false without writing", async () => {
    expect(await removeChat("nope")).toBe(false);
    const state = await readAccess();
    expect(state.allowed_chat_ids).toEqual([]);
  });

  test("addChat creates the state directory on first touch", async () => {
    await addChat("123");
    const entries = await readdir(stateDir);
    expect(entries.includes("access.json")).toBe(true);
  });

  test("multiple add/remove operations preserve user list", async () => {
    await addChat("a");
    await addChat("b");
    await addChat("c");
    await removeChat("b");
    const state = await readAccess();
    expect(state.allowed_chat_ids).toEqual(["a", "c"]);
  });

  test("atomic write: no .tmp file is left behind on success", async () => {
    await addChat("42");
    const entries = await readdir(stateDir);
    const tmpFiles = entries.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});

describe("isAllowed", () => {
  test("empty allowlist denies everything (deny-all default)", async () => {
    expect(await isAllowed("12345", "999")).toBe(false);
    expect(await isAllowed("12345", undefined)).toBe(false);
    expect(await isAllowed(0, 0)).toBe(false);
  });

  test("allows by chat_id", async () => {
    await addChat("12345");
    expect(await isAllowed("12345", undefined)).toBe(true);
    expect(await isAllowed("12345", "any-user")).toBe(true);
    expect(await isAllowed("99999", "any-user")).toBe(false);
  });

  test("coerces numeric chat_id to string before checking", async () => {
    await addChat("12345");
    expect(await isAllowed(12345, undefined)).toBe(true);
  });

  test("denies a chat that is not on the list, even with a user_id provided", async () => {
    await addChat("12345");
    expect(await isAllowed("99999", "12345")).toBe(false);
  });
});

describe("isGroupShaped", () => {
  test("negative chat_id is group-shaped", () => {
    expect(isGroupShaped("-1001234567890")).toBe(true);
    expect(isGroupShaped(-100)).toBe(true);
  });

  test("positive chat_id is not group-shaped", () => {
    expect(isGroupShaped("12345")).toBe(false);
    expect(isGroupShaped(12345)).toBe(false);
  });

  test("addChat does not block group-shaped ids — caller decides", async () => {
    expect(await addChat("-1001234567890")).toBe(true);
    expect(await isAllowed("-1001234567890", undefined)).toBe(true);
  });
});

describe("chat-id state file (writeChatId / readChatId)", () => {
  test("readChatId returns null when the file does not exist", async () => {
    expect(await readChatId()).toBeNull();
  });

  test("writeChatId then readChatId round-trips a numeric id as string", async () => {
    await writeChatId(12345);
    expect(await readChatId()).toBe("12345");
  });

  test("writeChatId then readChatId round-trips a string id", async () => {
    await writeChatId("987654");
    expect(await readChatId()).toBe("987654");
  });

  test("readChatId trims trailing newline written by writeChatId", async () => {
    await writeChatId("42");
    // The file should contain a trailing newline, but readChatId trims it.
    const raw = await Bun.file(join(stateDir, "chat-id")).text();
    expect(raw.endsWith("\n")).toBe(true);
    expect(await readChatId()).toBe("42");
  });

  test("readChatId returns null when the file is empty", async () => {
    await writeChatId("seed");
    await writeFile(join(stateDir, "chat-id"), "");
    expect(await readChatId()).toBeNull();
  });

  test("readChatId returns null when the file is whitespace-only", async () => {
    await writeChatId("seed");
    await writeFile(join(stateDir, "chat-id"), "   \n\n");
    expect(await readChatId()).toBeNull();
  });

  test("writeChatId overwrites the previous value", async () => {
    await writeChatId("111");
    await writeChatId("222");
    expect(await readChatId()).toBe("222");
  });

  test("writeChatId creates the state directory if missing", async () => {
    // No prior write to addChat; the dir should not exist yet.
    let exists = true;
    try {
      await readdir(stateDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    await writeChatId("555");
    const entries = await readdir(stateDir);
    expect(entries).toContain("chat-id");
  });

  test("writeChatId trims whitespace from the input", async () => {
    await writeChatId("  12345  \n");
    expect(await readChatId()).toBe("12345");
  });
});
