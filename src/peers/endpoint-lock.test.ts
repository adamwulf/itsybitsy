import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAliveCtx, processStartEpochSecondsCtx, resetProcessStartEpochSecondsCache } from "../agents";
import { resetUserHome, setUserHome } from "../home";
import { peerDir, peerEndpointLockFile } from "../runtime-names";
import { acquireEndpointLock, currentEndpointLockOwner, releaseEndpointLock } from "./endpoint-lock";

// The liveness check is the real isPidAliveSince; only its two OS probes are
// stubbed: signal 0 (`alive`) and the process start time from `ps` (`starts`).
const ME = { pid: 4101, startEpoch: 1_700_000_000 };
const OTHER = { pid: 4202, startEpoch: 1_700_000_500 };

let home: string;
let alive: Set<number>;
let starts: Map<number, number>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-endpoint-lock-"));
  setUserHome(home);
  alive = new Set([ME.pid]);
  starts = new Map([[ME.pid, ME.startEpoch]]);
  isPidAliveCtx.set((pid) => alive.has(pid));
  processStartEpochSecondsCtx.set((pid) => starts.get(pid) ?? null);
  resetProcessStartEpochSecondsCache();
});

afterEach(async () => {
  isPidAliveCtx.reset();
  processStartEpochSecondsCtx.reset();
  resetProcessStartEpochSecondsCache();
  resetUserHome();
  await rm(home, { recursive: true, force: true });
});

/** OTHER is running, with the start time its lock records. */
function otherRunning(): void {
  alive.add(OTHER.pid);
  starts.set(OTHER.pid, OTHER.startEpoch);
}

async function writeLock(contents: string): Promise<void> {
  await mkdir(peerDir(), { recursive: true });
  await writeFile(peerEndpointLockFile(), contents);
}

const lockContents = () => readFile(peerEndpointLockFile(), "utf-8").catch(() => null);
const line = (o: { pid: number; startEpoch: number }) => `${o.pid} ${o.startEpoch}\n`;

describe("acquireEndpointLock", () => {
  test("creates the lock with our pid and start time, in a 0700 peer directory", async () => {
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true });
    expect(await lockContents()).toBe(line(ME));
    expect((await stat(peerDir())).mode & 0o777).toBe(0o700);
  });

  test("defaults to this process's pid and real start time", async () => {
    starts.set(process.pid, 1_699_999_000);
    expect(currentEndpointLockOwner()).toEqual({ pid: process.pid, startEpoch: 1_699_999_000 });
    expect(await acquireEndpointLock()).toEqual({ acquired: true });
    expect(await lockContents()).toBe(`${process.pid} 1699999000\n`);
  });

  test("writes the pid alone when this process cannot read its start time", async () => {
    expect(await acquireEndpointLock({ pid: ME.pid })).toEqual({ acquired: true });
    expect(await lockContents()).toBe(`${ME.pid}\n`);
  });

  test("fails with the owner's pid while a live process holds it, leaving the lock alone", async () => {
    otherRunning();
    await writeLock(line(OTHER));
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: false, ownerPid: OTHER.pid });
    expect(await lockContents()).toBe(line(OTHER));
  });

  test("takes over a dead owner's lock", async () => {
    await writeLock(line(OTHER));
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true, takenFromPid: OTHER.pid });
    expect(await lockContents()).toBe(line(ME));
  });

  test("takes over when the owner's pid is alive but belongs to a process that started at another time", async () => {
    // An unclean exit left the lock; after a reboot an unrelated process got the pid.
    alive.add(OTHER.pid);
    starts.set(OTHER.pid, OTHER.startEpoch + 3600);
    await writeLock(line(OTHER));
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true, takenFromPid: OTHER.pid });
    expect(await lockContents()).toBe(line(ME));
  });

  test("a live owner whose start time cannot be read still counts as alive", async () => {
    alive.add(OTHER.pid); // no entry in `starts`: ps cannot tell
    await writeLock(line(OTHER));
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: false, ownerPid: OTHER.pid });
  });

  test("a pid-only lock counts as alive while its pid is", async () => {
    alive.add(OTHER.pid);
    await writeLock(`${OTHER.pid}\n`);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: false, ownerPid: OTHER.pid });
    alive.delete(OTHER.pid);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true, takenFromPid: OTHER.pid });
  });

  test("a lock that holds exactly us is ours", async () => {
    await writeLock(line(ME));
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true });
    expect(await lockContents()).toBe(line(ME));
  });

  test("our own pid from an earlier process is stale and taken over", async () => {
    await writeLock(`${ME.pid} ${ME.startEpoch - 86_400}\n`);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true, takenFromPid: ME.pid });
    expect(await lockContents()).toBe(line(ME));
  });

  test("takes over a lock whose contents stay unreadable", async () => {
    for (const junk of ["", "not a pid\n", "0\n", "-5\n", "12 0\n", "12 x\n"]) {
      await writeLock(junk);
      expect(await acquireEndpointLock(ME)).toEqual({ acquired: true });
      expect(await lockContents()).toBe(line(ME));
      await rm(peerEndpointLockFile());
    }
  });

  test("waits for an empty lock to get its owner instead of taking it over", async () => {
    otherRunning();
    await writeLock("");
    setTimeout(() => void writeFile(peerEndpointLockFile(), line(OTHER)), 30);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: false, ownerPid: OTHER.pid });
    expect(await lockContents()).toBe(line(OTHER));
  });

  test("of many processes racing for a free lock, exactly one gets it", async () => {
    const owners = Array.from({ length: 10 }, (_, i) => ({ pid: 5000 + i, startEpoch: 1_700_001_000 + i }));
    for (const o of owners) {
      alive.add(o.pid);
      starts.set(o.pid, o.startEpoch);
    }
    const results = await Promise.all(owners.map((o) => acquireEndpointLock(o)));
    expect(results.filter((r) => r.acquired).length).toBe(1);
    const ownerPid = Number((await lockContents())!.split(" ")[0]);
    expect(owners.map((o) => o.pid)).toContain(ownerPid);
    for (const r of results) {
      if (!r.acquired) expect(r.ownerPid).toBe(ownerPid);
    }
  });
});

describe("releaseEndpointLock", () => {
  test("deletes the lock while it holds us", async () => {
    await acquireEndpointLock(ME);
    expect(await releaseEndpointLock(ME)).toBe(true);
    expect(await lockContents()).toBeNull();
  });

  test("leaves a lock that holds another owner", async () => {
    await writeLock(line(OTHER));
    expect(await releaseEndpointLock(ME)).toBe(false);
    expect(await lockContents()).toBe(line(OTHER));
  });

  test("leaves a lock with our pid but another start time", async () => {
    await writeLock(`${ME.pid} ${ME.startEpoch + 1}\n`);
    expect(await releaseEndpointLock(ME)).toBe(false);
    expect(await lockContents()).toBe(`${ME.pid} ${ME.startEpoch + 1}\n`);
  });

  test("a process whose lock was taken over does not delete the new owner's", async () => {
    await acquireEndpointLock(OTHER); // OTHER owns it, then dies
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true, takenFromPid: OTHER.pid });
    expect(await releaseEndpointLock(OTHER)).toBe(false);
    expect(await lockContents()).toBe(line(ME));
  });

  test("no lock: nothing to release", async () => {
    expect(await releaseEndpointLock(ME)).toBe(false);
  });

  test("after a release, another process can acquire", async () => {
    otherRunning();
    await acquireEndpointLock(ME);
    expect(await acquireEndpointLock(OTHER)).toEqual({ acquired: false, ownerPid: ME.pid });
    await releaseEndpointLock(ME);
    expect(await acquireEndpointLock(OTHER)).toEqual({ acquired: true });
  });
});

test("simultaneous standbys replace a dead lock exactly once", async () => {
  otherRunning(); await writeLock("9999 123\n");
  const results = await Promise.all([acquireEndpointLock(ME), acquireEndpointLock(OTHER)]);
  expect(results.filter(r => r.acquired)).toHaveLength(1);
  const winner = results[0]!.acquired ? ME : OTHER;
  expect(await lockContents()).toBe(line(winner));
  expect(results.find(r => !r.acquired)).toEqual({ acquired: false, ownerPid: winner.pid });
});

test("a suspended identity writer exposes no empty lock", async () => {
  otherRunning();
  const writing = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const original = fs.writeFile;
  const spy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (args[1] === line(ME)) { writing.resolve(); await resume.promise; }
    await original(...args);
  });
  try {
    const first = acquireEndpointLock(ME); await writing.promise;
    expect(await lockContents()).toBeNull();
    expect(await acquireEndpointLock(OTHER)).toEqual({ acquired: true });
    resume.resolve(); expect(await first).toEqual({ acquired: false, ownerPid: OTHER.pid });
    expect(await lockContents()).toBe(line(OTHER));
  } finally { resume.resolve(); spy.mockRestore(); }
});
