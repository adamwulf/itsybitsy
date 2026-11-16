import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAliveCtx } from "../agents";
import { resetUserHome, setUserHome } from "../home";
import { peerDir, peerEndpointLockFile } from "../runtime-names";
import { acquireEndpointLock, releaseEndpointLock } from "./endpoint-lock";

const ME = 4101;
const OTHER = 4202;

let home: string;
let alive: Set<number>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-endpoint-lock-"));
  setUserHome(home);
  alive = new Set([ME]);
  isPidAliveCtx.set((pid) => alive.has(pid));
});

afterEach(async () => {
  isPidAliveCtx.reset();
  resetUserHome();
  await rm(home, { recursive: true, force: true });
});

async function writeLock(contents: string): Promise<void> {
  await mkdir(peerDir(), { recursive: true });
  await writeFile(peerEndpointLockFile(), contents);
}

const lockContents = () => readFile(peerEndpointLockFile(), "utf-8").catch(() => null);

describe("acquireEndpointLock", () => {
  test("creates the lock with our pid, in a 0700 peer directory", async () => {
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true });
    expect(await lockContents()).toBe(`${ME}\n`);
    expect((await stat(peerDir())).mode & 0o777).toBe(0o700);
  });

  test("defaults to this process's pid", async () => {
    alive.add(process.pid);
    expect(await acquireEndpointLock()).toEqual({ acquired: true });
    expect(await lockContents()).toBe(`${process.pid}\n`);
  });

  test("fails with the owner's pid while a live process holds it, leaving the lock alone", async () => {
    alive.add(OTHER);
    await writeLock(`${OTHER}\n`);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: false, ownerPid: OTHER });
    expect(await lockContents()).toBe(`${OTHER}\n`);
  });

  test("takes over a dead owner's lock", async () => {
    await writeLock(`${OTHER}\n`);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true, takenFromPid: OTHER });
    expect(await lockContents()).toBe(`${ME}\n`);
  });

  test("a lock that already holds our pid is ours", async () => {
    await writeLock(`${ME}\n`);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true });
    expect(await lockContents()).toBe(`${ME}\n`);
  });

  test("takes over a lock whose contents stay unreadable", async () => {
    for (const junk of ["", "not a pid\n", "0\n", "-5\n"]) {
      await writeLock(junk);
      expect(await acquireEndpointLock(ME)).toEqual({ acquired: true });
      expect(await lockContents()).toBe(`${ME}\n`);
      await rm(peerEndpointLockFile());
    }
  });

  test("waits for an empty lock to get its pid instead of taking it over", async () => {
    alive.add(OTHER);
    await writeLock("");
    setTimeout(() => void writeFile(peerEndpointLockFile(), `${OTHER}\n`), 30);
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: false, ownerPid: OTHER });
    expect(await lockContents()).toBe(`${OTHER}\n`);
  });

  test("of many processes racing for a free lock, exactly one gets it", async () => {
    const pids = Array.from({ length: 10 }, (_, i) => 5000 + i);
    for (const pid of pids) alive.add(pid);
    const results = await Promise.all(pids.map((pid) => acquireEndpointLock(pid)));
    const winners = results.filter((r) => r.acquired);
    expect(winners.length).toBe(1);
    const owner = Number((await lockContents())!.trim());
    expect(pids).toContain(owner);
    for (const r of results) {
      if (!r.acquired) expect(r.ownerPid).toBe(owner);
    }
  });
});

describe("releaseEndpointLock", () => {
  test("deletes the lock while it holds our pid", async () => {
    await acquireEndpointLock(ME);
    expect(await releaseEndpointLock(ME)).toBe(true);
    expect(await lockContents()).toBeNull();
  });

  test("leaves a lock that holds another pid", async () => {
    await writeLock(`${OTHER}\n`);
    expect(await releaseEndpointLock(ME)).toBe(false);
    expect(await lockContents()).toBe(`${OTHER}\n`);
  });

  test("a process whose lock was taken over does not delete the new owner's", async () => {
    await acquireEndpointLock(OTHER); // OTHER owns it, then dies
    expect(await acquireEndpointLock(ME)).toEqual({ acquired: true, takenFromPid: OTHER });
    expect(await releaseEndpointLock(OTHER)).toBe(false);
    expect(await lockContents()).toBe(`${ME}\n`);
  });

  test("no lock: nothing to release", async () => {
    expect(await releaseEndpointLock(ME)).toBe(false);
  });

  test("after a release, another process can acquire", async () => {
    alive.add(OTHER);
    await acquireEndpointLock(ME);
    expect(await acquireEndpointLock(OTHER)).toEqual({ acquired: false, ownerPid: ME });
    await releaseEndpointLock(ME);
    expect(await acquireEndpointLock(OTHER)).toEqual({ acquired: true });
  });
});
