import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, rename, symlink, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { buildAttachmentManifest, hashFile, type ManifestEntry } from "./attachment-manifest";
import { sendFileBody } from "./send-frame";
import { CHUNK_BYTES, DEFAULT_TRANSFER_LIMITS } from "./transfer-limits";

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-manifest-"));
  cwd = join(home, "work");
  await mkdir(cwd);
});
const owned: ManifestEntry[] = [];
async function manifest(...args: Parameters<typeof buildAttachmentManifest>) {
  const entries = await buildAttachmentManifest(...args);
  owned.push(...entries);
  return entries;
}
afterEach(async () => {
  await Promise.all(owned.splice(0).map(entry => entry.handle.close()));
  await rm(home, { force: true, recursive: true });
});

test("resolves relative, home, absolute and symlink spellings into one manifest entry", async () => {
  const original = join(cwd, "file");
  const alias = join(cwd, "link");
  await writeFile(original, "hello");
  await symlink(original, alias);
  const paths = ["file", "~/work/file", "./link", original, "./link"];
  const entries = await manifest(paths, { cwd, home, machine: "desk", limits: { ...DEFAULT_TRANSFER_LIMITS, maxFiles: 1 } });
  expect(entries).toHaveLength(1);
  const source = await realpath(original);
  expect(entries[0]).toMatchObject({ argument: "file", name: "file", size: 5, source });
  expect(new Set(entries[0]!.spellings)).toEqual(new Set([...paths, source, alias]));
});

test("refuses missing paths, directories, fifos and sockets before opening them", async () => {
  await Bun.$`mkfifo ${join(cwd, "fifo")}`.quiet();
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(join(cwd, "socket"), resolve));
  try {
    for (const argument of ["~/unused", "./", "./fifo", "./socket"]) {
      await expect(buildAttachmentManifest([argument], { cwd, home, machine: "desk" })).rejects.toThrow(argument);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("refuses both protected roots by canonical path, including symlinked directories", async () => {
  await mkdir(join(home, ".itsybitsy"));
  for (const name of ["peer", "sealed"]) {
    const dir = join(home, name);
    await mkdir(dir);
    await symlink(dir, join(home, ".itsybitsy", name));
    await writeFile(join(dir, "data"), "test fixture");
    await symlink(join(dir, "data"), join(cwd, name));
    for (const argument of ["./" + name, "~/.itsybitsy/" + name + "/data", "~/" + name + "/data"]) {
      await expect(buildAttachmentManifest([argument], { cwd, home, machine: "desk" })).rejects.toThrow(/protected/i);
    }
  }
  await mkdir(join(home, ".itsybitsy", "peer-outbox"));
  await writeFile(join(home, ".itsybitsy", "peer-outbox", "ok"), "");
  expect(await manifest(["~/.itsybitsy/peer-outbox/ok"], { cwd, home, machine: "desk" })).toHaveLength(1);
});

test("enforces supplied limits and names the sending machine", async () => {
  await writeFile(join(cwd, "data"), "ab");
  const options = { cwd, home, machine: "sender", limits: { ...DEFAULT_TRANSFER_LIMITS, maxFileBytes: 1 } };
  await expect(buildAttachmentManifest(["./data"], options)).rejects.toThrow(/sender.*maxFileMB/);
});

test("hashes across chunk boundaries and handles an empty file", async () => {
  const path = join(cwd, "data");
  for (const length of [0, CHUNK_BYTES, CHUNK_BYTES * 3 + 11]) {
    const bytes = Buffer.alloc(length, "abcdefg");
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      expect(await hashFile(handle)).toBe(createHash("sha256").update(bytes).digest("hex"));
    } finally {
      await handle.close();
    }
  }
});

test("hash and body reads stay on the validated file after its name is replaced", async () => {
  const path = join(cwd, "report");
  await writeFile(path, "original");
  const [entry] = await manifest([path], { cwd, home, machine: "desk" });
  await rename(path, path + ".old");
  await writeFile(path, "different");
  const digest = createHash("sha256").update("original").digest("hex");
  expect(await hashFile(entry!.handle)).toBe(digest);
  const chunks: Buffer[] = [];
  await sendFileBody(entry!.handle, { writeAll: async bytes => { chunks.push(Buffer.from(bytes)); } });
  expect(Buffer.concat(chunks).toString()).toBe("original");
});

test("resolves symlinks before parent components for both cwd and home arguments", async () => {
  await mkdir(join(home, "remote", "sub"), { recursive: true });
  await symlink(join(home, "remote", "sub"), join(cwd, "dirlink"));
  await writeFile(join(home, "remote", "x"), "intended");
  await writeFile(join(cwd, "x"), "lexical");
  const args = ["dirlink/../x", "~/work/dirlink/../x"];
  const [entry] = await manifest(args, { cwd, home, machine: "desk" });
  expect(entry!.source).toBe(await realpath(join(home, "remote", "x")));
  expect(entry!.spellings).toEqual(expect.arrayContaining(args));
  expect(entry!.spellings).not.toContain(join(cwd, "x"));
});

test("every disable switch takes precedence over a missing path", async () => {
  for (const field of ["maxFileBytes", "maxMessageBytes", "maxFiles"] as const) {
    const limits = { ...DEFAULT_TRANSFER_LIMITS, [field]: 0 };
    await expect(manifest(["missing"], { cwd, home, limits, machine: "desk" })).rejects.toThrow("attachments are disabled on desk");
  }
});
