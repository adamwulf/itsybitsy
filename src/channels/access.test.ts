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

