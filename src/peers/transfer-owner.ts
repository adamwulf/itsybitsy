import { constants } from "node:fs";
import { lstat, mkdtemp, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isPidAliveCtx, processStartEpochSecondsCtx } from "../agents";

export type TransferOwner = { pid: number; start: number | null };
export function stagingOwnerStart(pid: number): number | null {
  const start = processStartEpochSecondsCtx.fn(pid);
  return start !== null && Number.isSafeInteger(start) && start > 0 ? start : null;
}

export async function writeTransferOwner(dir: string, owner: TransferOwner) {
  const temp = join(dir, ".owner-" + randomUUID());
  try {
    await writeFile(temp, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    await rename(temp, join(dir, "owner.json"));
  } finally { await rm(temp, { force: true }); }
}

export async function readTransferOwner(dir: string): Promise<TransferOwner | undefined> {
  let handle;
  try { handle = await open(join(dir, "owner.json"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256) return;
    const data = Buffer.alloc(257);
    const { bytesRead } = await handle.read(data);
    let value;
    try { value = JSON.parse(data.toString("utf8", 0, bytesRead)); } catch { return; }
    if (Number.isSafeInteger(value?.pid) && value.pid > 0 && (value.start === null || Number.isSafeInteger(value.start) && value.start > 0)) return value;
  } finally { await handle.close(); }
}

export function ownerIsDead(owner: TransferOwner): boolean {
  if (!isPidAliveCtx.fn(owner.pid)) return true;
  const observed = owner.start !== null ? stagingOwnerStart(owner.pid) : null;
  return observed !== null && observed !== owner.start;
}

export async function makeOutgoingDirectory(root = "/tmp") {
  const owner = { pid: process.pid, start: stagingOwnerStart(process.pid) };
  const dir = await mkdtemp(join(root, `itsybitsy-outgoing-${owner.pid}-${owner.start ?? 0}-`));
  try { await writeTransferOwner(dir, owner); return dir; }
  catch (err) { await rm(dir, { recursive: true, force: true }); throw err; }
}

export async function sweepOutgoingDirectories(root = "/tmp") {
  for await (const entry of await opendir(root)) {
    const match = /^itsybitsy-outgoing-([1-9]\d*)-(\d+)-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const dir = join(root, entry.name);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) continue;
      // The name carries the same identity for the interval between mkdtemp and the owner write.
      const owner = await readTransferOwner(dir) ?? { pid: Number(match[1]), start: Number(match[2]) || null };
      if (ownerIsDead(owner)) await rm(dir, { recursive: true, force: true });
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
}
