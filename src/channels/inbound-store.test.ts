import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join, dirname } from "path";
import { mkdtemp, rm, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import {
  setInboundDir,
  resetInboundDir,
  defaultInboundDir,
  storeInboundFile,
  pruneInboundOlderThan,
  INBOUND_DEFAULT_TTL_MS,
} from "./inbound-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inbound-store-test-"));
  setInboundDir(join(root, "inbound"));
});

afterEach(async () => {
  resetInboundDir();
  await rm(root, { recursive: true, force: true });
});

describe("defaultInboundDir", () => {
  test("respects setInboundDir override", () => {
    expect(defaultInboundDir()).toBe(join(root, "inbound"));
  });

  test("falls back to ~/.itsybitsy/... when no override", () => {
    resetInboundDir();
    const dir = defaultInboundDir();
    expect(dir.endsWith(join(".itsybitsy", "channels", "telegram", "inbound"))).toBe(true);
    setInboundDir(join(root, "inbound")); // restore for afterEach symmetry
  });
});

describe("storeInboundFile", () => {
  test("writes bytes under <inbound>/<chat>/<unix-ms>-<name> and returns the path", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const path = await storeInboundFile("100", 1782610000000, "photo.jpg", bytes);

    expect(path).toBe(join(root, "inbound", "100", "1782610000000-photo.jpg"));
    const read = await readFile(path);
    expect(Array.from(read)).toEqual([1, 2, 3, 4]);
  });

  test("creates the per-chat directory", async () => {
    const path = await storeInboundFile("42", 1, "x.bin", new Uint8Array([0]));
    const st = await stat(dirname(path));
    expect(st.isDirectory()).toBe(true);
  });

  test("path-traversal: a malicious file name cannot escape the chat dir", async () => {
    // safeName() in the dispatcher already strips most of this, but the storage
    // layer must be safe regardless of caller.
    const path = await storeInboundFile("100", 5, "../../etc/passwd", new Uint8Array([9]));
    // The resolved path must still live under the chat dir.
    const chatDir = join(root, "inbound", "100");
    expect(path.startsWith(chatDir + "/")).toBe(true);
    expect(path).not.toContain("/etc/passwd");
    expect(path).not.toContain("..");
  });

  test("path-traversal: separators in the name are neutralized", async () => {
    const path = await storeInboundFile("100", 6, "a/b\\c.png", new Uint8Array([1]));
    const chatDir = join(root, "inbound", "100");
    expect(path.startsWith(chatDir + "/")).toBe(true);
    // No nested directory was created — the separators became underscores.
    expect(path).toBe(join(chatDir, "6-a_b_c.png"));
  });

  test("a malicious chat id is sanitized to a single segment", async () => {
    const path = await storeInboundFile("../../evil", 7, "x.bin", new Uint8Array([1]));
    // The chat segment is sanitized; the file still lands under the inbound root.
    expect(path.startsWith(join(root, "inbound") + "/")).toBe(true);
    expect(path).not.toContain("/evil/x.bin"); // not a real nested path escape
  });

  test("an empty name falls back to a placeholder", async () => {
    const path = await storeInboundFile("100", 8, "", new Uint8Array([1]));
    expect(path).toBe(join(root, "inbound", "100", "8-file"));
  });
});

describe("pruneInboundOlderThan (opt-in housekeeping)", () => {
  test("removes files older than the cutoff, keeps newer ones", async () => {
    const old = await storeInboundFile("100", 1, "old.bin", new Uint8Array([1]));
    const fresh = await storeInboundFile("100", 2, "new.bin", new Uint8Array([1]));

    // Back-date the "old" file's mtime well past the TTL.
    const { utimes } = await import("fs/promises");
    const longAgo = new Date(Date.now() - INBOUND_DEFAULT_TTL_MS - 60_000);
    await utimes(old, longAgo, longAgo);

    const removed = await pruneInboundOlderThan(INBOUND_DEFAULT_TTL_MS, Date.now());
    expect(removed).toBe(1);

    expect(await Bun.file(old).exists()).toBe(false);
    expect(await Bun.file(fresh).exists()).toBe(true);
  });

  test("returns 0 when the inbound dir does not exist", async () => {
    resetInboundDir();
    setInboundDir(join(root, "does-not-exist"));
    const removed = await pruneInboundOlderThan(1000, Date.now());
    expect(removed).toBe(0);
  });
});
