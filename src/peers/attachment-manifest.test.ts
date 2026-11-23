import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { link, mkdtemp, mkdir, open, rename, symlink, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  expect(new Set(entries[0]!.spellings)).toEqual(new Set([...paths, source]));
});

test("refuses missing paths, directories, fifos and sockets before opening them", async () => {
  await Bun.$`mkfifo ${join(cwd, "fifo")}`.quiet();
  await symlink(cwd, join(cwd, "dirlink"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(join(cwd, "socket"), resolve));
  try {
    for (const argument of ["~/unused", "./", "./fifo", "./socket", "./dirlink", "/dev/null"]) {
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
      // Select the positional overload used by fileChunks for the spy.
      const reader: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<unknown> } = handle;
      const reads = spyOn(reader, "read");
      const stats = spyOn(handle, "stat");
      expect(await hashFile({ handle, size: length })).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(stats).toHaveBeenCalledTimes(1);
      expect(reads.mock.calls.length).toBe(Math.ceil(length / CHUNK_BYTES));
      for (const [buffer, , limit, position] of reads.mock.calls) {
        expect(buffer).toBe(reads.mock.calls[0]![0]);
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(CHUNK_BYTES);
        expect(position).toBeGreaterThanOrEqual(0);
        expect(position + limit).toBeLessThanOrEqual(length);
      }
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
  expect(await hashFile(entry!)).toBe(digest);
  const chunks: Buffer[] = [];
  await sendFileBody(entry!, { write: async bytes => { chunks.push(Buffer.from(bytes)); return bytes.length; } });
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

test("case aliases on a case-insensitive filesystem share entries and respect protected roots", async () => {
  await writeFile(join(cwd, "Report"), "example");
  if (!existsSync(join(cwd, "REPORT"))) return;
  const entries = await manifest(["./REPORT", "./report"], { cwd, home, machine: "desk" });
  expect(entries).toHaveLength(1);
  expect(entries[0]!.spellings).toEqual(expect.arrayContaining(["./REPORT", "./report"]));
  for (const root of ["peer", "sealed"]) {
    const dir = join(home, ".itsybitsy", root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fixture"), "example");
    await expect(manifest(["~/.ITSYBITSY/" + root.toUpperCase() + "/FIXTURE"], { cwd, home, machine: "desk" }))
      .rejects.toThrow("protected");
  }
});

test("rejects hard links to files anywhere in either protected tree", async () => {
  for (const root of ["peer", "sealed"]) {
    const nested = join(home, ".itsybitsy", root, "nested", "more");
    await mkdir(nested, { recursive: true });
    const protectedFile = join(nested, "fixture");
    await writeFile(protectedFile, "example");
    await link(protectedFile, join(cwd, root));
    await expect(manifest([root], { cwd, home, machine: "desk" })).rejects.toThrow(/protected/);
  }
});

test("absent protected roots allow a regular attachment", async () => {
  await mkdir(join(home, ".itsybitsy"));
  await writeFile(join(cwd, "report"), "ok");
  expect(await manifest(["report"], { cwd, home, machine: "desk" })).toHaveLength(1);
});

test("a dangling protected root or descendant prevents sending an unrelated file", async () => {
  const state = join(home, ".itsybitsy");
  await mkdir(state);
  await writeFile(join(cwd, "report"), "ok");
  const peer = join(state, "peer");
  await symlink(join(home, "missing"), peer);
  const build = () => manifest(["report"], { cwd, home, machine: "desk" });
  await expect(build()).rejects.toThrow(/protected/);
  await rm(peer);
  await mkdir(peer);
  await symlink(join(home, "missing"), join(peer, "broken"));
  await expect(build()).rejects.toThrow(/protected/);
});

test("hashing refuses growth and truncation since validation, including an initially empty file", async () => {
  const path = join(cwd, "change");
  for (const [before, after] of [["a", "ab"], ["ab", "a"], ["", "b"]] as const) {
    await writeFile(path, before);
    const [entry] = await manifest([path], { cwd, home, machine: "desk" });
    await writeFile(path, after);
    await expect(hashFile(entry!)).rejects.toThrow(after.length < before.length ? /EOF/ : /exceeds/);
  }
});

test("a trailing slash or dot requires a directory even if the underlying name is a file", async () => {
  await writeFile(join(cwd, "report"), "ok");
  for (const argument of ["report/", "report/.", "~/work/report/./"]) {
    await expect(manifest([argument], { cwd, home, machine: "desk" })).rejects.toThrow(argument);
  }
});
