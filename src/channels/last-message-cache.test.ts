import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import {
  readLastMessage,
  writeLastMessage,
  setStateDir,
  resetStateDir,
} from "./last-message-cache";

let tmpRoot: string;
let stateDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "last-message-cache-test-"));
  stateDir = join(tmpRoot, "channels", "telegram");
  setStateDir(stateDir);
});

afterEach(async () => {
  resetStateDir();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("readLastMessage", () => {
  test("returns null when file is missing", async () => {
    expect(await readLastMessage()).toBeNull();
  });

  test("round-trips a written value", async () => {
    await writeLastMessage("12345", 99);
    const got = await readLastMessage();
    expect(got).not.toBeNull();
    expect(got!.chat_id).toBe("12345");
    expect(got!.message_id).toBe(99);
    expect(typeof got!.cached_at).toBe("string");
  });

  test("the latest write wins", async () => {
    await writeLastMessage("12345", 1);
    await writeLastMessage("12345", 2);
    const got = await readLastMessage();
    expect(got!.message_id).toBe(2);
  });

  test("returns null and renames a corrupt file aside", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "last-message.json"), "{not json");
    expect(await readLastMessage()).toBeNull();
    const entries = await readdir(stateDir);
    expect(entries.some((e) => e.startsWith("last-message.json.corrupt-"))).toBe(true);
  });

  test("returns null on wrong-shape content (missing message_id)", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "last-message.json"), JSON.stringify({ chat_id: "1", cached_at: "t" }));
    expect(await readLastMessage()).toBeNull();
  });

  test("returns null when message_id is not a number", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "last-message.json"),
      JSON.stringify({ chat_id: "1", message_id: "99", cached_at: "t" }),
    );
    expect(await readLastMessage()).toBeNull();
  });
});

describe("writeLastMessage", () => {
  test("creates the state directory if missing", async () => {
    await writeLastMessage("777", 5);
    const entries = await readdir(stateDir);
    expect(entries).toContain("last-message.json");
  });
});
