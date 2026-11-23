import * as fs from "node:fs/promises";
import * as brokerFiles from "./remote-attachments";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAliveCtx, processStartEpochSecondsCtx } from "../agents";
import { finishRecovery, inspectBrokerLease, reclaimTransfer, sweepEntries, sweepOutgoingDirectories, transferDirectoryBatch, transferOwnerState, writeTransferOwner } from "./transfer-owner";
import { sweepStagingLease } from "../send-broker";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ib-transfer-owner-"));
  isPidAliveCtx.set(pid => pid === process.pid);
  processStartEpochSecondsCtx.set(() => 10);
});
afterEach(async () => {
  isPidAliveCtx.reset(); processStartEpochSecondsCtx.reset();
  await rm(root, { recursive: true, force: true });
});

test("live, dead, recycled and unverifiable transfer owners share one expiry rule", () => {
  const owner = { pid: process.pid, start: 10 };
  expect(transferOwnerState(owner, 10_000)).toBe("verified-live");
  expect(transferOwnerState(owner, 0, 11)).toBe("proven-dead");
  expect(transferOwnerState(owner, 0, 10)).toBe("verified-live");
  expect(transferOwnerState({ ...owner, start: null }, 9_999)).toBe("unverifiable");
  expect(transferOwnerState({ pid: 42, start: null }, 0, null)).toBe("proven-dead");
  // A wall-clock rollback can place the record before the process start.
  expect(transferOwnerState(owner, 9_999)).toBe("verified-live");
  expect(transferOwnerState({ ...owner, start: 9 }, 10_000)).toBe("proven-dead");
  expect(transferOwnerState({ ...owner, pid: 42 }, 10_000)).toBe("proven-dead");
  expect(transferOwnerState({ ...owner, start: null }, 10_000)).toBe("unverifiable");
  expect(transferOwnerState(undefined, 10_000)).toBe("unverifiable");
  processStartEpochSecondsCtx.set(() => null);
  expect(transferOwnerState(owner, 10_000)).toBe("unverifiable");
  expect(reclaimTransfer("unverifiable", "fixture-inode", 10_000)).toBe(false);
  expect(reclaimTransfer("unverifiable", "fixture-inode", 86_409_999)).toBe(false);
  expect(reclaimTransfer("unverifiable", "fixture-inode", 86_410_000)).toBe(true);
  expect(reclaimTransfer("verified-live", "fixture-inode", 86_410_001)).toBe(false);
});

test("a clock rollback at first sight refuses dispatch and retains the live CLI staging", async () => {
  const id = "a".repeat(32);
  const path = join(root, "send-attachments", id);
  await mkdir(path, { recursive: true });
  await Bun.write(join(path, "lease"), JSON.stringify({ pid: process.pid }));
  processStartEpochSecondsCtx.set(() => Math.ceil(Date.now() / 1000) + 1);
  expect((await inspectBrokerLease(root, id)).state).toBe("unverifiable");
  expect(await Bun.file(join(path, "owner.json")).exists()).toBe(false);
  await sweepStagingLease(root, id, Date.now());
  expect(await readdir(join(root, "send-attachments"))).toEqual([id]);
});

test("recovery ignores committed snapshots and refuses a symlink above a sweep root", async () => {
  const parent = join(root, "private", "snapshots");
  const name = "itsybitsy-attachments-" + crypto.randomUUID();
  const partial = join(parent, "incoming", crypto.randomUUID() + ".partial");
  const committed = join(parent, name);
  for (const path of [partial, committed]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeTransferOwner(path, { pid: 42, start: 10 });
  }
  await symlink(join(root, "private"), join(root, "redirected"));
  await expect(sweepOutgoingDirectories(join(root, "redirected", "snapshots"))).rejects.toThrow("Unsafe transfer directory");
  expect((await stat(partial)).isDirectory()).toBe(true);
  await sweepOutgoingDirectories(parent);
  expect(await readdir(join(parent, "incoming"))).toEqual([]);
  expect((await stat(committed)).isDirectory()).toBe(true);
});

test("a bounded scan continues beyond the first batch", async () => {
  for (const name of ["a", "b", "c"]) await mkdir(join(root, name));
  const first = await transferDirectoryBatch(root, "test", 2);
  const second = await transferDirectoryBatch(root, "test", 2);
  expect(first).toHaveLength(2);
  expect([...first, ...second].sort()).toEqual(["a", "b", "c"]);
});

test("a failed entry leaves the rest of its batch reachable and is retried", async () => {
  for (const name of ["a", "b", "c"]) await mkdir(join(root, name));
  const seen: string[] = [];
  await expect(sweepEntries(root, async name => { seen.push(name); if (seen.length === 1) throw Error("unavailable"); })).rejects.toThrow("unavailable");
  expect(seen.sort()).toEqual(["a", "b", "c"]);
  const retried: string[] = [];
  await sweepEntries(root, async name => { retried.push(name); });
  expect(retried.sort()).toEqual(seen);
});

test("recovery reports errors only after every root finishes", async () => {
  const held = Promise.withResolvers<void>();
  let reported = false;
  const outcome = finishRecovery([Promise.reject(Error("outbox unavailable")), held.promise]).catch(err => {
    reported = true;
    return err;
  });
  await Bun.sleep(0);
  expect(reported).toBe(false);
  held.resolve();
  expect(await outcome).toBeInstanceOf(AggregateError);
  expect(reported).toBe(true);
});

test("a watchdog reclaims a reused PID from its saved stamp even without a lease birth time", async () => {
  const id = "b".repeat(32), dir = join(root, "send-attachments", id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "lease"), JSON.stringify({ pid: process.pid }));
  await sweepStagingLease(root, id, Date.now());
  expect(await Bun.file(join(dir, "owner.json")).json()).toEqual({ pid: process.pid, start: 10 });
  const open = brokerFiles.openBrokerLease;
  const spy = spyOn(brokerFiles, "openBrokerLease").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[2] === undefined) {
      const info = await handle.stat(); info.birthtimeMs = 0;
      handle.stat = (async () => info) as typeof handle.stat;
    }
    return handle;
  });
  try {
    processStartEpochSecondsCtx.set(() => 11);
    await sweepStagingLease(root, id, Date.now());
    expect(await readdir(join(root, "send-attachments"))).toEqual([]);
  } finally { spy.mockRestore(); }
});

test("an interrupted watchdog stamp write leaves no visible stamp and can be retried", async () => {
  const id = "e".repeat(32), path = join(root, "send-attachments", id);
  await mkdir(path, { recursive: true });
  await Bun.write(join(path, "lease"), JSON.stringify({ pid: process.pid }));
  const open = fs.open;
  const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes("/.record-")) handle.writeFile = async () => { throw Error("interrupted"); };
    return handle;
  });
  try {
    expect((await inspectBrokerLease(root, id)).state).toBe("unverifiable");
    expect(await readdir(path)).toEqual(["lease"]);
  } finally { spy.mockRestore(); }
  expect((await inspectBrokerLease(root, id)).state).toBe("verified-live");
});

test("a dead lease PID proves death even with an unreadable stamp", async () => {
  const id = "d".repeat(32), dir = join(root, "send-attachments", id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "lease"), JSON.stringify({ pid: 42 }));
  await Bun.write(join(dir, "owner.json"), "{");
  expect((await inspectBrokerLease(root, id)).state).toBe("proven-dead");
  await sweepStagingLease(root, id, Date.now());
  expect(await readdir(join(root, "send-attachments"))).toEqual([]);
});

test("a published watchdog stamp remains authoritative across a crash before temp unlink", async () => {
  const id = "f".repeat(32), dir = join(root, "send-attachments", id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "lease"), JSON.stringify({ pid: process.pid }));
  const temp = join(dir, ".record-" + crypto.randomUUID());
  await Bun.write(temp, JSON.stringify({ pid: process.pid, start: 10 }));
  await fs.link(temp, join(dir, "owner.json"));
  expect((await inspectBrokerLease(root, id)).state).toBe("verified-live");
  processStartEpochSecondsCtx.set(() => 11);
  await sweepStagingLease(root, id, Date.now());
  expect(await readdir(join(root, "send-attachments"))).toEqual([]);
});

test("a forward calendar step leaves an unverified partial in its retention window", async () => {
  const dir = join(root, "incoming", crypto.randomUUID() + ".partial");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await sweepOutgoingDirectories(root);
  const future = Date.now() + 2 * 86_400_000;
  const clock = spyOn(Date, "now").mockReturnValue(future);
  try { await sweepOutgoingDirectories(root); expect((await stat(dir)).isDirectory()).toBe(true); }
  finally { clock.mockRestore(); }
});
