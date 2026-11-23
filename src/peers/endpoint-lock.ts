/** One watcher owns the endpoint and its transfer recovery task. */
import { randomUUID } from "node:crypto";
import { flock, LOCK_EX, LOCK_NB } from "../file-lock";
import { open, readFile, link, rename, rm, stat, writeFile, unlink } from "node:fs/promises";
import { stagingOwnerStart, transferOwnerState } from "./transfer-owner";
import { isPidAliveCtx, processStartEpochSecondsCtx } from "../agents";
import { peerEndpointLockFile } from "../runtime-names";
import { ensurePeerDir } from "./peer-dir";

/** Who holds (or wants) the lock. */
export interface EndpointLockOwner {
  pid: number;
  /** Process start time, epoch seconds. Undefined when it could not be read. */
  startEpoch?: number;
}

export type EndpointLockResult =
  /** We hold the lock. `takenFromPid` is the dead owner whose lock we took over, if any. */
  | { acquired: true; takenFromPid?: number; generation?: string }
  /** A live process holds the lock. */
  | { acquired: false; ownerPid: number };

/** This process, as a lock owner. */
export function currentEndpointLockOwner(): EndpointLockOwner {
  const startEpoch = stagingOwnerStart(process.pid);
  return startEpoch === null ? { pid: process.pid } : { pid: process.pid, startEpoch };
}

function formatOwner(owner: EndpointLockOwner): string {
  return owner.startEpoch === undefined ? `${owner.pid}\n` : `${owner.pid} ${owner.startEpoch}\n`;
}

function parseOwner(text: string): (EndpointLockOwner & { generation?: string }) | null {
  const match = /^([1-9][0-9]*)(?: ([1-9][0-9]*))?(?:\n([a-f0-9-]{36}))?$/.exec(text.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  const startEpoch = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(pid) || (startEpoch !== undefined && !Number.isSafeInteger(startEpoch))) return null;
  return { pid, startEpoch, generation: match[3] };
}

function sameOwner(text: string | null, self: EndpointLockOwner) {
  const owner = text === null ? null : parseOwner(text);
  return owner?.pid === self.pid && owner.startEpoch === self.startEpoch;
}

/** The lock's contents, or null when it does not exist. */
async function readLock(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The watch owner refreshes its lock on every poll, including identical snapshots. */
export async function renewEndpointLease(): Promise<void> {
  const lock = await open(peerEndpointLockFile(), "r+");
  try {
    if (sameOwner(await lock.readFile("utf8"), currentEndpointLockOwner())) {
      const now = new Date();
      await lock.utimes(now, now);
    }
  } finally { await lock.close(); }
}

/** If a sandbox hides process birth times, a fresh owner heartbeat bounds stale visibility. */
export async function hasLiveEndpointOwner(generation: string | undefined, maxLeaseAge: number): Promise<boolean> {
  const lock = await open(peerEndpointLockFile(), "r");
  try {
    const owner = parseOwner(await lock.readFile("utf8"));
    if (!owner || !isPidAliveCtx.fn(owner.pid)) return false;
    const stat = await lock.stat();
    if (generation !== undefined && owner.generation !== generation) return false;
    const start = owner.startEpoch === undefined ? null : processStartEpochSecondsCtx.fn(owner.pid);
    if (start !== null) return start === owner.startEpoch;
    const age = Date.now() - stat.mtimeMs;
    return age >= -1 && age <= maxLeaseAge;
  } finally { await lock.close(); }
}

export async function hasLivePeerWatcher(): Promise<boolean> {
  try {
    return await hasLiveEndpointOwner(undefined, 15_000);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** All cooperating writers serialize namespace mutations using a stable inode.
 * Kernel release on exit includes a crash between tombstoning and publication. */
async function withLockGuard<T>(path: string, action: () => Promise<T>) {
  const guard = await open(path + ".guard", "a+", 0o600);
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (flock(guard.fd, LOCK_EX | LOCK_NB) === 0) return await action();
      await Bun.sleep(10);
    }
    throw Error("Endpoint lock update is busy");
  } finally { await guard.close(); }
}

function bootTimeMs(): number | undefined {
  if (process.platform !== "darwin") return;
  const result = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"]);
  const seconds = result.exitCode === 0 && /sec = (\d+),/.exec(result.stdout.toString())?.[1];
  if (seconds) return Number(seconds) * 1000;
}

export async function acquireEndpointLock(self: EndpointLockOwner = currentEndpointLockOwner(), boot = bootTimeMs): Promise<EndpointLockResult> {
  if (self.startEpoch === undefined) throw Error("Cannot verify this watcher’s process start time");
  await ensurePeerDir();
  const path = peerEndpointLockFile();
  const generation = randomUUID();
  const temp = path + "." + generation;
  try {
    await writeFile(temp, formatOwner(self) + generation + "\n", { mode: 0o600, flag: "wx" });
    return await withLockGuard(path, async (): Promise<EndpointLockResult> => {
      const contents = await readLock(path);
      if (contents === null) { await link(temp, path); return { acquired: true, generation }; }
      const owner = parseOwner(contents);

      if (sameOwner(contents, self)) {
        if (owner?.generation) return { acquired: true, generation: owner.generation };
        await rename(temp, path);
        return { acquired: true, generation };
      }
      const state = async (file: string) => {
        const birth = (await stat(file)).birthtimeMs;
        if (owner) return transferOwnerState({ pid: owner.pid, start: owner.startEpoch ?? null }, birth);
        if (birth > 0 && birth < (boot() ?? 0)) return "proven-dead";
        throw Error("Cannot verify the existing endpoint lock");
      };
      if (await state(path) !== "proven-dead") return { acquired: false, ownerPid: owner!.pid };
      const tombstone = path + ".dead." + randomUUID();
      await rename(path, tombstone);
      try {
        if ((await readLock(tombstone)) !== contents || await state(tombstone) !== "proven-dead") {
          await link(tombstone, path);
          throw Error("Endpoint lock changed during takeover");
        }
        await link(temp, path);
        return { acquired: true, generation, ...(owner && { takenFromPid: owner.pid }) };
      } finally { await rm(tombstone, { force: true }); }
    });
  } finally { await rm(temp, { force: true }); }
}

export async function releaseEndpointLock(self: EndpointLockOwner = currentEndpointLockOwner()): Promise<boolean> {
  const path = peerEndpointLockFile();
  try {
    return await withLockGuard(path, async () => {
      if (!sameOwner(await readLock(path), self)) return false;
      await unlink(path);
      return true;
    });
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
}
