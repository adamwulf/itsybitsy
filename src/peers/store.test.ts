import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUserHome, setUserHome } from "../home";
import { peerDir, peersFile } from "../runtime-names";
import {
  addPeer,
  normalizePeerId,
  PeerStoreError,
  readPeers,
  removePeer,
  sanitizePeerName,
  shortPeerId,
} from "./store";

const ID_A = "a".repeat(64);
const ID_B = "0123456789abcdef".repeat(4);
const ID_C = "c".repeat(64);

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-peer-store-"));
  setUserHome(home);
});

afterEach(async () => {
  resetUserHome();
  await rm(home, { recursive: true, force: true });
});

describe("normalizePeerId", () => {
  test("trims and lowercases a 64-hex id", () => {
    expect(normalizePeerId(`  ${ID_B.toUpperCase()}\n`)).toBe(ID_B);
  });

  test("rejects anything that is not 64 hex characters", () => {
    for (const bad of ["", "a".repeat(63), "a".repeat(65), "g".repeat(64), shortPeerId(ID_A), `${"a".repeat(32)} ${"a".repeat(31)}`]) {
      expect(normalizePeerId(bad)).toBeNull();
    }
  });
});

describe("sanitizePeerName", () => {
  test("strips control characters and trims", () => {
    expect(sanitizePeerName("  Laptop\u0007 B\u001b[31m\n", ID_A)).toBe("Laptop B[31m");
    expect(sanitizePeerName("a\u0085b\u007fc", ID_A)).toBe("abc");
  });

  test("caps at 32 characters, counting code points, without a trailing space", () => {
    expect(sanitizePeerName("x".repeat(40), ID_A)).toBe("x".repeat(32));
    expect(sanitizePeerName("😀".repeat(40), ID_A)).toBe("😀".repeat(32));
    expect(sanitizePeerName(`${"y".repeat(31)} z`, ID_A)).toBe("y".repeat(31));
  });

  test("an empty name falls back to the first 10 hex characters of the id", () => {
    expect(sanitizePeerName("", ID_B)).toBe("0123456789");
    expect(sanitizePeerName(" \u0000\t ", ID_B)).toBe("0123456789");
  });
});

describe("readPeers", () => {
  test("a missing file is an empty list", async () => {
    expect(await readPeers()).toEqual([]);
  });

  test("normalizes ids and names read from disk", async () => {
    await mkdir(peerDir(), { recursive: true });
    await writeFile(peersFile(), JSON.stringify([{ id: ` ${ID_A.toUpperCase()} `, name: "\u0007", pairedAt: "2026-11-15T00:00:00.000Z" }]));
    expect(await readPeers()).toEqual([{ id: ID_A, name: "aaaaaaaaaa", pairedAt: "2026-11-15T00:00:00.000Z" }]);
  });

  test("a file that is not a valid peer list throws instead of reading as empty", async () => {
    await mkdir(peerDir(), { recursive: true });
    for (const [text, message] of [
      ["{nope", "not valid JSON"],
      ["{}", "not a JSON array"],
      [JSON.stringify([{ id: "short", name: "x" }]), "entry 0 has no valid id"],
      [JSON.stringify([null]), "entry 0 has no valid id"],
    ] as const) {
      await writeFile(peersFile(), text);
      const err = await readPeers().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PeerStoreError);
      expect((err as Error).message).toContain(message);
    }
  });
});

describe("addPeer", () => {
  test("writes a JSON array of {id, name, pairedAt} in a 0700 directory", async () => {
    const stored = await addPeer({ id: ID_A, name: "Laptop B", pairedAt: "2026-11-15T01:02:03.000Z" });
    expect(stored).toEqual({ id: ID_A, name: "Laptop B", pairedAt: "2026-11-15T01:02:03.000Z" });
    expect(JSON.parse(await readFile(peersFile(), "utf-8"))).toEqual([stored]);
    expect((await stat(peerDir())).mode & 0o777).toBe(0o700);
  });

  test("normalizes the id, sanitizes the name and defaults pairedAt to now", async () => {
    const before = Date.now();
    const stored = await addPeer({ id: `\t${ID_B.toUpperCase()} `, name: "  " });
    expect(stored.id).toBe(ID_B);
    expect(stored.name).toBe("0123456789");
    const at = Date.parse(stored.pairedAt);
    expect(at).toBeGreaterThanOrEqual(before - 1);
    expect(at).toBeLessThanOrEqual(Date.now() + 1);
  });

  test("rejects an invalid id and writes nothing", async () => {
    await expect(addPeer({ id: "abc", name: "x" })).rejects.toThrow("not a peer id");
    expect(await readPeers()).toEqual([]);
  });

  test("replaces any entry with the same id; names need not be unique", async () => {
    await addPeer({ id: ID_A, name: "one", pairedAt: "t1" });
    await addPeer({ id: ID_B, name: "same", pairedAt: "t2" });
    await addPeer({ id: ID_C, name: "same", pairedAt: "t3" });
    await addPeer({ id: ID_A.toUpperCase(), name: "one again", pairedAt: "t4" });
    expect(await readPeers()).toEqual([
      { id: ID_B, name: "same", pairedAt: "t2" },
      { id: ID_C, name: "same", pairedAt: "t3" },
      { id: ID_A, name: "one again", pairedAt: "t4" },
    ]);
  });

  test("leaves no temp file behind", async () => {
    await addPeer({ id: ID_A, name: "x" });
    expect(await readdir(peerDir())).toEqual(["peers.json"]);
  });

  test("refuses to overwrite a malformed peers.json", async () => {
    await mkdir(peerDir(), { recursive: true });
    await writeFile(peersFile(), "{nope");
    await expect(addPeer({ id: ID_A, name: "x" })).rejects.toBeInstanceOf(PeerStoreError);
    expect(await readFile(peersFile(), "utf-8")).toBe("{nope");
  });
});

describe("removePeer", () => {
  beforeEach(async () => {
    await addPeer({ id: ID_A, name: "alpha", pairedAt: "t1" });
    await addPeer({ id: ID_B, name: "twin", pairedAt: "t2" });
    await addPeer({ id: ID_C, name: "twin", pairedAt: "t3" });
  });

  test("removes by exact full id, trimmed and lowercased", async () => {
    const result = await removePeer(` ${ID_B.toUpperCase()}`);
    expect(result).toEqual({ ok: true, removed: { id: ID_B, name: "twin", pairedAt: "t2" } });
    expect((await readPeers()).map((p) => p.id)).toEqual([ID_A, ID_C]);
  });

  test("removes by exact name", async () => {
    expect(await removePeer("alpha")).toEqual({ ok: true, removed: { id: ID_A, name: "alpha", pairedAt: "t1" } });
    expect((await readPeers()).map((p) => p.id)).toEqual([ID_B, ID_C]);
  });

  test("a name shared by several peers removes nothing and returns them", async () => {
    const result = await removePeer("twin");
    expect(result).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: [
        { id: ID_B, name: "twin", pairedAt: "t2" },
        { id: ID_C, name: "twin", pairedAt: "t3" },
      ],
    });
    expect((await readPeers()).length).toBe(3);
  });

  test("no prefix, partial or case-folded name matches", async () => {
    for (const target of ["alph", "ALPHA", shortPeerId(ID_A), ID_A.slice(0, 63)]) {
      expect(await removePeer(target)).toEqual({ ok: false, reason: "not-found" });
    }
    expect((await readPeers()).length).toBe(3);
  });

  test("an empty store has nothing to remove", async () => {
    await rm(peersFile());
    expect(await removePeer("alpha")).toEqual({ ok: false, reason: "not-found" });
  });
});
