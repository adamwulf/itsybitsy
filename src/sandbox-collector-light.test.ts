import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { holdCollectorClient, sandboxCollectorPaths, tryCollectorLock, type SandboxCollectorPaths } from "./sandbox-collector";
import { COLLECTOR_HEARTBEAT_STALE_MS, collectorHealthDetail, sandboxCollectorHealth } from "./sandbox-collector-light";

const darwinTest = process.platform === "darwin" ? test : test.skip;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A temp home through the module's home seam; never the real ~/.itsybitsy. */
async function collectorHome(): Promise<{ home: string; paths: SandboxCollectorPaths }> {
  const home = await mkdtemp(join(tmpdir(), "sandbox-collector-light-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  return { home, paths };
}

/** The daemon role, held the way `serve` holds it. */
function holdDaemonRole(paths: SandboxCollectorPaths): void {
  const fd = tryCollectorLock(paths.daemonLock);
  expect(fd).not.toBeNull();
  cleanups.push(async () => closeSync(fd!));
}

function holdClient(paths: SandboxCollectorPaths): void {
  const fd = holdCollectorClient(paths);
  cleanups.push(async () => closeSync(fd));
}

const NOW = 1_800_000_000_000;
const beat = (paths: SandboxCollectorPaths, updatedAt: number) =>
  writeFile(paths.heartbeat, JSON.stringify({ v: 1, pid: 4242, nonce: "abcd1234", updatedAt, launches: 2 }));

test("switched off: grey, without probing even a held daemon role", async () => {
  const { home, paths } = await collectorHome();
  if (process.platform === "darwin") holdDaemonRole(paths);
  const status = sandboxCollectorHealth({ home, enabled: false, now: NOW });
  expect(status.light).toBe("grey");
  expect(status.state).toBe("off");
  expect(collectorHealthDetail(status)).toBe("off: switched off in this build");
});

darwinTest("not running with no attached launch: grey (the daemon exits by design)", async () => {
  const { home, paths } = await collectorHome();
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW })).toMatchObject({ light: "grey", state: "idle" });
  // A heartbeat left by a killed daemon does not matter without the role.
  await beat(paths, NOW);
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW })).toMatchObject({ light: "grey", state: "idle" });
  // No state directory at all: no launch ever attached.
  const empty = await mkdtemp(join(tmpdir(), "sandbox-collector-light-empty-"));
  cleanups.push(() => rm(empty, { recursive: true, force: true }));
  expect(sandboxCollectorHealth({ home: empty, enabled: true, now: NOW })).toMatchObject({ light: "grey", state: "idle" });
});

darwinTest("running with a fresh heartbeat: green, with the heartbeat's pid, age and launches", async () => {
  const { home, paths } = await collectorHome();
  holdDaemonRole(paths);
  holdClient(paths);
  await beat(paths, NOW - 1200);
  const status = sandboxCollectorHealth({ home, enabled: true, now: NOW });
  expect(status).toEqual({ light: "green", state: "ok", pid: 4242, heartbeatAgeMs: 1200, launches: 2 });
  expect(collectorHealthDetail(status)).toBe("ok: pid 4242, heartbeat 1s ago, 2 launches");
});

darwinTest("running with a stale heartbeat: yellow (stuck but alive)", async () => {
  const { home, paths } = await collectorHome();
  holdDaemonRole(paths);
  await beat(paths, NOW - COLLECTOR_HEARTBEAT_STALE_MS);
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW }).light).toBe("green"); // at the limit
  await beat(paths, NOW - COLLECTOR_HEARTBEAT_STALE_MS - 1);
  const status = sandboxCollectorHealth({ home, enabled: true, now: NOW });
  expect(status).toMatchObject({ light: "yellow", state: "stale", heartbeatAgeMs: COLLECTOR_HEARTBEAT_STALE_MS + 1 });
  expect(collectorHealthDetail(status)).toBe("stale: pid 4242, heartbeat 10s ago, 2 launches");
});

darwinTest("running before its first heartbeat (or an unreadable one): yellow", async () => {
  const { home, paths } = await collectorHome();
  holdDaemonRole(paths);
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW })).toMatchObject({ light: "yellow", state: "starting" });
  await writeFile(paths.heartbeat, "{not json");
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW })).toMatchObject({ light: "yellow", state: "starting" });
  await writeFile(paths.heartbeat, JSON.stringify({ v: 1, pid: 4242 }));
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW })).toMatchObject({ light: "yellow", state: "starting" });
});

darwinTest("launches attached with no daemon: yellow at first, red when the next probe agrees", async () => {
  const { home, paths } = await collectorHome();
  holdClient(paths);
  const first = sandboxCollectorHealth({ home, enabled: true, now: NOW });
  expect(first).toMatchObject({ light: "yellow", state: "no-daemon" });
  const second = sandboxCollectorHealth({ home, enabled: true, now: NOW, previous: first });
  expect(second).toMatchObject({ light: "red", state: "broken" });
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW, previous: second }).light).toBe("red");
  expect(collectorHealthDetail(second)).toBe("broken: launches attached, no daemon");
  // A daemon taking the role ends it at once.
  holdDaemonRole(paths);
  await beat(paths, NOW);
  expect(sandboxCollectorHealth({ home, enabled: true, now: NOW, previous: second }).light).toBe("green");
});

darwinTest("probes never take a role, never wait, and close every fd", async () => {
  const { home, paths } = await collectorHome();
  const openFds = () => readdirSync("/dev/fd").length;
  const before = openFds();
  for (let i = 0; i < 20; i++) sandboxCollectorHealth({ home, enabled: true, now: NOW });
  expect(openFds()).toBe(before);
  // Nothing is left holding either lock: the daemon role and the exit lock are free.
  for (const lock of [paths.daemonLock, paths.clientsLock]) {
    const fd = tryCollectorLock(lock);
    expect(fd).not.toBeNull();
    closeSync(fd!);
  }

  // With a daemon and an attach holding their locks, a probe returns at once
  // and leaves both holders in place.
  holdDaemonRole(paths);
  holdClient(paths);
  await beat(paths, NOW);
  const started = performance.now();
  for (let i = 0; i < 20; i++) sandboxCollectorHealth({ home, enabled: true, now: NOW });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(openFds()).toBe(before + 2);
  expect(tryCollectorLock(paths.daemonLock)).toBeNull();
  expect(tryCollectorLock(paths.clientsLock)).toBeNull();
});
