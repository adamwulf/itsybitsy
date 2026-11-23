import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { buildAttachmentManifest, hashFile } from "./attachment-manifest";
import { CHUNK_BYTES, DEFAULT_TRANSFER_LIMITS } from "./transfer-limits";

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-manifest-"));
  cwd = join(home, "work");
  await mkdir(cwd);
});
afterEach(() => rm(home, { force: true, recursive: true }));

test("resolves relative, home, absolute and symlink spellings into one manifest entry", async () => {
  const original = join(cwd, "file");
  const alias = join(cwd, "link");
  await writeFile(original, "hello");
  await symlink(original, alias);
  const paths = ["file", "~/work/file", "./link", original, "./link"];
  const manifest = await buildAttachmentManifest(paths, { cwd, home, limits: { ...DEFAULT_TRANSFER_LIMITS, maxFiles: 1 } });
  expect(manifest).toHaveLength(1);
  const source = await realpath(original);
  expect(manifest[0]).toMatchObject({ argument: "file", name: "file", size: 5, source });
  expect(new Set(manifest[0]!.spellings)).toEqual(new Set([...paths, source, alias]));
});

test("refuses missing paths, directories, fifos and sockets before opening them", async () => {
  await Bun.$`mkfifo ${join(cwd, "fifo")}`.quiet();
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(join(cwd, "socket"), resolve));
  try {
    for (const argument of ["~/unused", "./", "./fifo", "./socket"]) {
      await expect(buildAttachmentManifest([argument], { cwd, home })).rejects.toThrow(argument);
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
      await expect(buildAttachmentManifest([argument], { cwd, home })).rejects.toThrow(/protected/i);
    }
  }
  await mkdir(join(home, ".itsybitsy", "peer-outbox"));
  await writeFile(join(home, ".itsybitsy", "peer-outbox", "ok"), "");
  expect(await buildAttachmentManifest(["~/.itsybitsy/peer-outbox/ok"], { cwd, home })).toHaveLength(1);
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
    expect(await hashFile(path)).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});
