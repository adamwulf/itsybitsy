import { openBrokerLease, stagingDirectoryStat } from "./remote-attachments";
import { constants, type Dir } from "node:fs";
import { lstat, mkdtemp, open, opendir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  try { return await readOwnerFields(handle); } finally { await handle.close(); }
}

async function readOwnerFields(handle: FileHandle): Promise<TransferOwner | undefined> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256) return;
  const data = Buffer.alloc(257);
  const { bytesRead } = await handle.read(data);
  let value;
  try { value = JSON.parse(data.toString("utf8", 0, bytesRead)); } catch { return; }
  if (Number.isSafeInteger(value?.pid) && value.pid > 0 &&
      (value.start == null || Number.isSafeInteger(value.start) && value.start > 0)) {
    return { pid: value.pid, start: value.start ?? null };
  }
}

export type OwnerState = "verified-live" | "proven-dead" | "unverifiable";
export const OWNER_EXPIRY_MS = 24 * 3600_000;

export function transferOwnerState(owner: TransferOwner | undefined, createdMs: number, observed = owner && stagingOwnerStart(owner.pid)): OwnerState {
  if (!owner) return "unverifiable";
  if (!isPidAliveCtx.fn(owner.pid)) return "proven-dead";
  if (observed == null) return "unverifiable";
  if (observed * 1000 > createdMs || (owner.start !== null && observed !== owner.start)) return "proven-dead";
  return owner.start === null ? "unverifiable" : "verified-live";
}

export function reclaimTransfer(state: OwnerState, createdMs: number, now: number) {
  return state === "proven-dead" || (state === "unverifiable" && now - createdMs >= OWNER_EXPIRY_MS);
}

// Darwin's system /tmp and /var are aliases. Start at their physical roots
// and reject links in every component supplied by the caller.
export async function safeTransferParent(path: string): Promise<string> {
  const absolute = resolve(path);
  const physical = process.platform === "darwin" ? absolute.replace(/^\/(tmp|var)(?=\/|$)/, "/private/$1") : absolute;
  let current = "/";
  for (const part of physical.split("/").filter(Boolean)) {
    current = join(current, part);
    if (!(await lstat(current)).isDirectory()) throw new Error("Unsafe transfer directory: " + current);
  }
  return physical;
}

const scans = new Map<string, { handle: Dir; dev: number; ino: number }>();
/** Resume a bounded enumeration at the next entry on the following pass. */
const listing = new Set<string>();
export async function transferDirectoryBatch(parent: string, purpose = "sweep", limit = 256) {
  const key = parent + ":" + purpose;
  if (listing.has(key)) return [];
  listing.add(key);
  try { return await readBatch(parent, key, limit); } finally { listing.delete(key); }
}
async function readBatch(parent: string, key: string, limit: number) {
  const entries = [];
  let path: string;
  try { path = await safeTransferParent(parent); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  const info = await lstat(path);
  let scan = scans.get(key);
  if (scan && (scan.ino !== info.ino || scan.dev !== info.dev)) {
    await scan.handle.close(); scans.delete(key); scan = undefined;
  }
  if (!scan) { scan = { handle: await opendir(path), dev: info.dev, ino: info.ino }; scans.set(key, scan); }
  for (let i = 0; i < limit; i++) {
    const entry = await scan.handle.read();
    if (!entry) { await scan.handle.close(); scans.delete(key); break; }
    if (entry.isDirectory()) entries.push(entry.name);
  }
  return entries;
}

export async function inspectTransferDirectory(dir: string) {
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error("Unsafe transfer directory: " + dir);
  const owner = await readTransferOwner(dir).catch(() => undefined);
  const record = await lstat(join(dir, "owner.json")).catch(() => undefined);
  const created = (record ?? info).birthtimeMs;
  return { owner, state: transferOwnerState(owner, created), created };
}

export async function sweepTransferDirectory(dir: string, now: number) {
  try {
    const safe = await safeTransferParent(dir);
    const { state, created } = await inspectTransferDirectory(safe);
    if (reclaimTransfer(state, created, now)) await rm(safe, { recursive: true, force: true });
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

export async function makeOutgoingDirectory(root = "/tmp") {
  const owner = { pid: process.pid, start: stagingOwnerStart(process.pid) };
  const dir = await mkdtemp(join(root, `itsybitsy-outgoing-${owner.pid}-${owner.start ?? 0}-`));
  try { await writeTransferOwner(dir, owner); return dir; }
  catch (err) { await rm(dir, { recursive: true, force: true }); throw err; }
}

export async function sweepOutgoingDirectories(root = "/tmp", now = Date.now()) {
  for (const name of await transferDirectoryBatch(root)) {
    if (!/^itsybitsy-outgoing-[1-9]\d*-\d+-[a-zA-Z0-9]{6}$/.test(name) &&
        !/^itsybitsy-attachments-[a-f0-9-]{36}\.partial$/.test(name)) continue;
    const dir = join(root, name);
    const info = await lstat(dir).catch(() => undefined);
    if (info?.isDirectory() && info.uid === process.getuid?.() && !(info.mode & 0o077)) await sweepTransferDirectory(dir, now);
  }
}

/** A sandbox writes its PID alone. Only the watchdog observes and records its
 * start, after checking it predates the lease, and later verifies that stamp. */
export async function inspectBrokerLease(dir: string, id: string): Promise<{ state: OwnerState; created: number }> {
  const info = await stagingDirectoryStat(dir, id);
  let created = info.birthtimeMs;
  let lease: FileHandle | undefined;
  let stamp: FileHandle | undefined;
  try {
    lease = await openBrokerLease(dir, id);
    created = (await lease.stat()).birthtimeMs;
    const seed = await readOwnerFields(lease);
    if (!seed) return { state: "unverifiable", created };
    const observed = stagingOwnerStart(seed.pid);
    const candidate = { pid: seed.pid, start: observed };
    const firstSight = transferOwnerState(candidate, created, observed);
    if (firstSight !== "verified-live") return { state: firstSight, created };
    try { stamp = await openBrokerLease(dir, id, "owner.json"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      try {
        stamp = await openBrokerLease(dir, id, "owner.json", true);
        await stamp.writeFile(JSON.stringify(candidate));
        return { state: firstSight, created };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      stamp = await openBrokerLease(dir, id, "owner.json");
    }
    const saved = await readOwnerFields(stamp);
    return { state: transferOwnerState(saved?.pid === seed.pid ? saved : undefined, created, observed), created };
  } catch { return { state: "unverifiable", created }; }
  finally { await stamp?.close(); await lease?.close(); }
}
