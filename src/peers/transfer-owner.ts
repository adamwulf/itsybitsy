import { transferStagingRoot } from "../runtime-names";
import { openBrokerLease, publishBrokerRecord, stagingDirectoryStat } from "./remote-attachments";
import { constants, type Dir } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

async function readOwnerFields(handle: FileHandle): Promise<TransferOwner | undefined> {
  const stat = await handle.stat();
  // A create-once record can retain its temporary hard link if its publisher
  // exits just after link(). Both names refer to the complete protected record.
  if (!stat.isFile() || stat.nlink < 1 || stat.size > 256) return;
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

export function transferOwnerState(owner: TransferOwner | undefined, _createdMs: number, observed = owner && stagingOwnerStart(owner.pid)): OwnerState {
  if (!owner) return "unverifiable";
  if (!isPidAliveCtx.fn(owner.pid)) return "proven-dead";
  if (observed == null) return "unverifiable";
  if (owner.start !== null) return observed === owner.start ? "verified-live" : "proven-dead";
  return "unverifiable";
}

// Eviction or process restart gives an unverified directory a fresh window.
const firstObservations = new Map<string, number>();
export function reclaimTransfer(state: OwnerState, inode: string, now: number) {
  if (state !== "unverifiable") {
    firstObservations.delete(inode);
    return state === "proven-dead";
  }
  const first = firstObservations.get(inode);
  if (first !== undefined) return now - first >= OWNER_EXPIRY_MS;
  if (firstObservations.size >= 65_536) firstObservations.delete(firstObservations.keys().next().value!);
  firstObservations.set(inode, now);
  return false;
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
  try { return await readBatch(parent, key, limit); }
  catch (err) {
    const scan = scans.get(key);
    scans.delete(key);
    await scan?.handle.close().catch(() => {});
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  } finally { listing.delete(key); }
}
async function readBatch(parent: string, key: string, limit: number) {
  const entries = [];
  const path = await safeTransferParent(parent);
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
  let file: FileHandle | undefined;
  const inode = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  try {
    file = await open(join(dir, "owner.json"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const record = await file.stat();
    const owner = await readOwnerFields(file);
    return { owner, state: transferOwnerState(owner, record.birthtimeMs), inode };
  } catch { return { owner: undefined, state: "unverifiable" as const, inode }; }
  finally { await file?.close(); }
}

export async function sweepTransferDirectory(dir: string, now: number) {
  try {
    const safe = await safeTransferParent(dir);
    const { state, inode } = await inspectTransferDirectory(safe);
    if (reclaimTransfer(state, inode, now)) await rm(safe, { recursive: true, force: true });
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

export async function stagingArea(root: string, area: "incoming" | "outgoing") {
  await safeTransferParent(dirname(root));
  for (const dir of [root, join(root, area)]) {
    await mkdir(dir, { mode: 0o700 }).catch(err => { if (err.code !== "EEXIST") throw err; });
    const info = await lstat(await safeTransferParent(dir));
    if (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) throw Error("Unsafe transfer staging permissions: " + dir);
  }
  return join(root, area);
}

export async function makeOutgoingDirectory(root = transferStagingRoot()) {
  const dir = await mkdtemp(join(await stagingArea(root, "outgoing"), "snapshot-"));
  try { await writeTransferOwner(dir, { pid: process.pid, start: stagingOwnerStart(process.pid) }); return dir; }
  catch (err) { await rm(dir, { recursive: true, force: true }); throw err; }
}

export async function sweepEntries(parent: string, visit: (name: string) => Promise<void>) {
  const failures: unknown[] = [];
  for (const name of await transferDirectoryBatch(parent)) {
    try { await visit(name); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") failures.push(err); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
}

export async function finishRecovery(operations: Promise<void>[]) {
  const outcomes = await Promise.allSettled(operations);
  const failures = outcomes.flatMap(r => r.status === "rejected" ? [r.reason] : []);
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
}

export async function sweepOutgoingDirectories(root = transferStagingRoot(), now = performance.now()) {
  await finishRecovery((["incoming", "outgoing"] as const).map(async name => {
    const area = await stagingArea(root, name);
    await sweepEntries(area, async entry => {
      if (name === "incoming" ? !/^[a-f0-9-]{36}\.partial$/.test(entry) : !/^snapshot-[a-zA-Z0-9]{6}$/.test(entry)) return;
      await sweepTransferDirectory(join(area, entry), now);
    });
  }));
}

/** A sandbox writes its PID alone. Only the watchdog observes and records its
 * start, after checking it predates the lease, and later verifies that stamp. */
export async function inspectBrokerLease(dir: string, id: string): Promise<{ state: OwnerState; inode: string; identity?: string; owner?: TransferOwner }> {
  const info = await stagingDirectoryStat(dir, id);
  const inode = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  let lease: FileHandle | undefined;
  let stamp: FileHandle | undefined;
  try {
    lease = await openBrokerLease(dir, id);
    const leaseInfo = await lease.stat();
    const seed = await readOwnerFields(lease);
    if (!seed) return { state: "unverifiable", inode };
    const observed = stagingOwnerStart(seed.pid);
    const identity = `${leaseInfo.dev}:${leaseInfo.ino}:${seed.pid}:${observed}`;
    try { stamp = await openBrokerLease(dir, id, "owner.json"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const candidate = { pid: seed.pid, start: observed };
      const firstSight = transferOwnerState({ pid: seed.pid, start: null }, leaseInfo.birthtimeMs, observed);
      if (firstSight === "proven-dead" || !leaseInfo.birthtimeMs || observed === null || observed * 1000 > leaseInfo.birthtimeMs) return { state: firstSight, inode };
      try {
        await publishBrokerRecord(dir, id, "owner.json", candidate);
        return { state: "verified-live", inode, identity, owner: candidate };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      stamp = await openBrokerLease(dir, id, "owner.json");
    }
    const saved = await readOwnerFields(stamp);
    // Even without a usable saved stamp, a missing lease PID proves death.
    const owner = saved?.pid === seed.pid ? saved : { pid: seed.pid, start: null };
    return { state: transferOwnerState(owner, leaseInfo.birthtimeMs, observed), inode, identity, owner };
  } catch { return { state: "unverifiable", inode }; }
  finally { await stamp?.close(); await lease?.close(); }
}
