/**
 * `~/.itsybitsy/peer/endpoint.lock`: one iroh endpoint per machine
 * (docs/plans/iroh-peering.md, "Process model"). Two endpoints with the same
 * key would fight over the relay connection and discovery records, so only the
 * `ib watch` that holds this lock binds one.
 *
 * The lock file holds `<pid> <startEpoch>` and a newline: the owner's pid and
 * its REAL process start time in epoch seconds (selfProcessStartEpochSeconds),
 * the same stamp the lifecycle locks in src/agents.ts use. Not the time of the
 * write: the Peers dialog can take the lock hours after `ib watch` started.
 * The lock survives a reboot, so a pid alone is not enough: after an unclean
 * exit, an unrelated process can get the same pid. The owner counts as alive
 * only when isPidAliveSinceUncached accepts its pid AND start time. When a
 * process cannot read its own start time (`ps` denied), it writes the pid
 * alone, and such a lock counts as alive while the pid is.
 *
 * src/peers/service.ts takes it before binding (at boot when peers.json lists
 * a peer, or when the Peers dialog first opens) and releases it when `ib watch`
 * exits.
 *
 * Taking over a dead owner's lock follows the outbox lock's steal: remove the
 * lock only while it still holds what we read, then retry the exclusive
 * create, which is the real arbiter. Two processes that read the same dead
 * owner at the same instant could, in a window of microseconds, both end up
 * believing they hold it. Only a human starting two `ib watch` at once over a
 * stale lock could hit that.
 */

import { open, readFile, unlink } from "node:fs/promises";
import { isPidAliveSinceUncached, isPidAliveCtx, processStartEpochSecondsCtx, selfProcessStartEpochSeconds } from "../agents";
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
  | { acquired: true; takenFromPid?: number }
  /** A live process holds the lock. */
  | { acquired: false; ownerPid: number };

/**
 * A process that loses the exclusive create can read the lock in the moment
 * between the winner's create and its write, and see it empty. Re-read
 * contents that are not an owner this many times, this far apart, before
 * taking the lock over as stale.
 */
const UNREADABLE_RETRIES = 10;
const UNREADABLE_DELAY_MS = 20;
/** Create/take-over rounds before giving up. Each lost round means another process moved first. */
const MAX_ROUNDS = 5;

/** This process, as a lock owner. */
export function currentEndpointLockOwner(): EndpointLockOwner {
  const startEpoch = selfProcessStartEpochSeconds();
  return startEpoch === undefined ? { pid: process.pid } : { pid: process.pid, startEpoch };
}

function formatOwner(owner: EndpointLockOwner): string {
  return owner.startEpoch === undefined ? `${owner.pid}\n` : `${owner.pid} ${owner.startEpoch}\n`;
}

function parseOwner(text: string): EndpointLockOwner | null {
  const match = /^([1-9][0-9]*)(?: ([1-9][0-9]*))?$/.exec(text.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  const startEpoch = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(pid) || (startEpoch !== undefined && !Number.isSafeInteger(startEpoch))) return null;
  return startEpoch === undefined ? { pid } : { pid, startEpoch };
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
    if (await lock.readFile("utf8") === formatOwner(currentEndpointLockOwner())) {
      const now = new Date();
      await lock.utimes(now, now);
    }
  } finally { await lock.close(); }
}

/** If a sandbox hides process birth times, a fresh owner heartbeat bounds stale visibility. */
export async function hasLiveEndpointOwner(snapshotMtime: number, maxLeaseAge: number): Promise<boolean> {
  const lock = await open(peerEndpointLockFile(), "r");
  try {
    const owner = parseOwner(await lock.readFile("utf8"));
    if (!owner || !isPidAliveCtx.fn(owner.pid)) return false;
    const stat = await lock.stat();
    if (stat.birthtimeMs > snapshotMtime) return false;
    const start = owner.startEpoch === undefined ? null : processStartEpochSecondsCtx.fn(owner.pid);
    if (start !== null) return start === owner.startEpoch;
    const age = Date.now() - stat.mtimeMs;
    return age >= -1 && age <= maxLeaseAge;
  } finally { await lock.close(); }
}

/** Remove the lock only if it still holds exactly `expected`. Returns true when this call removed it. */
async function unlinkIfUnchanged(path: string, expected: string): Promise<boolean> {
  if ((await readLock(path)) !== expected) return false;
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Take the endpoint lock for `self` (default: this process).
 *
 * - No lock: create it exclusively with our pid and start time.
 * - The lock holds exactly what we write: we hold it already.
 * - The lock holds a live owner (pid alive with a matching start time): fail
 *   with that owner's pid.
 * - The lock holds a dead owner, a pid now used by a process that started at
 *   another time, our own pid from an earlier process, or contents that stay
 *   unreadable: take it over.
 *
 * Errors other than "the lock exists" (e.g. permissions) are thrown.
 */
export async function acquireEndpointLock(self: EndpointLockOwner = currentEndpointLockOwner()): Promise<EndpointLockResult> {
  await ensurePeerDir();
  const path = peerEndpointLockFile();
  let takenFromPid: number | undefined;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      const file = await open(path, "wx");
      try {
        await file.writeFile(formatOwner(self));
      } finally {
        await file.close();
      }
      return takenFromPid === undefined ? { acquired: true } : { acquired: true, takenFromPid };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let contents = await readLock(path);
    for (let i = 0; i < UNREADABLE_RETRIES && contents !== null && parseOwner(contents) === null; i++) {
      await Bun.sleep(UNREADABLE_DELAY_MS);
      contents = await readLock(path);
    }
    if (contents === null) continue; // released in the meantime: create again

    const owner = parseOwner(contents);
    if (owner !== null) {
      if (contents === formatOwner(self)) return { acquired: true };
      // No other live process can have our pid, so a lock with our pid that
      // is not exactly ours was written by an earlier process: stale.
      if (owner.pid !== self.pid && isPidAliveSinceUncached(owner.pid, owner.startEpoch)) {
        return { acquired: false, ownerPid: owner.pid };
      }
      takenFromPid = owner.pid;
    }
    await unlinkIfUnchanged(path, contents);
  }

  throw new Error(`could not take ${path}: other processes kept changing it`);
}

/**
 * Release the endpoint lock held by `self` (default: this process). Deletes
 * the file only if it still holds exactly our pid and start time, so a process
 * whose lock was taken over never deletes the new owner's. Returns true when
 * it deleted the lock.
 */
export async function releaseEndpointLock(self: EndpointLockOwner = currentEndpointLockOwner()): Promise<boolean> {
  const path = peerEndpointLockFile();
  const contents = formatOwner(self);
  if ((await readLock(path)) !== contents) return false;
  return unlinkIfUnchanged(path, contents);
}
