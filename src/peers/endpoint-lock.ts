/**
 * `~/.itsybitsy/peer/endpoint.lock`: one iroh endpoint per machine
 * (docs/plans/iroh-peering.md, "Process model"). Two endpoints with the same
 * key would fight over the relay connection and discovery records, so only the
 * `ib watch` that holds this lock binds one.
 *
 * The lock file holds the owner's pid and a newline. Nothing calls this yet;
 * a later phase wires it into `ib watch`.
 *
 * Taking over a dead owner's lock follows the outbox lock's steal: remove the
 * lock only while it still holds the dead pid we read, then retry the
 * exclusive create, which is the real arbiter. Two processes that read the
 * same dead pid at the same instant could, in a window of microseconds, both
 * end up believing they hold it. Only a human starting two `ib watch` at once
 * over a stale lock could hit that.
 */

import { open, readFile, unlink } from "node:fs/promises";
import { isPidAliveCtx } from "../agents";
import { peerEndpointLockFile } from "../runtime-names";
import { ensurePeerDir } from "./peer-dir";

export type EndpointLockResult =
  /** We hold the lock. `takenFromPid` is the dead owner whose lock we took over, if any. */
  | { acquired: true; takenFromPid?: number }
  /** A live process holds the lock. */
  | { acquired: false; ownerPid: number };

/**
 * A process that loses the exclusive create can read the lock in the moment
 * between the winner's create and its write, and see it empty. Re-read
 * contents that are not a pid this many times, this far apart, before taking
 * the lock over as stale.
 */
const UNREADABLE_RETRIES = 10;
const UNREADABLE_DELAY_MS = 20;
/** Create/take-over rounds before giving up. Each lost round means another process moved first. */
const MAX_ROUNDS = 5;

function parsePid(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : null;
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
 * Take the endpoint lock for `pid` (default: this process).
 *
 * - No lock: create it exclusively with our pid.
 * - The lock holds `pid` already: we hold it.
 * - The lock holds a live pid: fail with that owner's pid.
 * - The lock holds a dead pid, or contents that stay unreadable: take it over.
 *
 * Errors other than "the lock exists" (e.g. permissions) are thrown.
 */
export async function acquireEndpointLock(pid: number = process.pid): Promise<EndpointLockResult> {
  await ensurePeerDir();
  const path = peerEndpointLockFile();
  let takenFromPid: number | undefined;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      const file = await open(path, "wx");
      try {
        await file.writeFile(`${pid}\n`);
      } finally {
        await file.close();
      }
      return takenFromPid === undefined ? { acquired: true } : { acquired: true, takenFromPid };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let contents = await readLock(path);
    for (let i = 0; i < UNREADABLE_RETRIES && contents !== null && parsePid(contents) === null; i++) {
      await Bun.sleep(UNREADABLE_DELAY_MS);
      contents = await readLock(path);
    }
    if (contents === null) continue; // released in the meantime: create again

    const owner = parsePid(contents);
    if (owner === pid) return { acquired: true };
    if (owner !== null && isPidAliveCtx.fn(owner)) return { acquired: false, ownerPid: owner };

    if (owner !== null) takenFromPid = owner;
    await unlinkIfUnchanged(path, contents);
  }

  throw new Error(`could not take ${path}: other processes kept changing it`);
}

/**
 * Release the endpoint lock held by `pid` (default: this process). Deletes
 * the file only if it still holds that pid, so a process whose lock was taken
 * over never deletes the new owner's. Returns true when it deleted the lock.
 */
export async function releaseEndpointLock(pid: number = process.pid): Promise<boolean> {
  const path = peerEndpointLockFile();
  const contents = await readLock(path);
  if (contents === null || parsePid(contents) !== pid) return false;
  return unlinkIfUnchanged(path, contents);
}
