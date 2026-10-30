import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, appendFile } from "node:fs/promises";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { appendAgentLog, attachSandboxLaunch, collectorLine, holdCollectorClient, restartSandboxCollector, sandboxCollectorPaths,
  sandboxCollectorRunning, sandboxCollectorStatus, serveSandboxCollector, stopSandboxCollector, tryCollectorLock, validateRegistration,
  type AttachOptions, type CollectorReader, type RegisteredProcess, type ServeOptions } from "./sandbox-collector";
import { newSandboxTag } from "./sandbox";
import { sandboxLogParent, sandboxProfilePath } from "./sandbox-log-paths";
import { openSandboxProcessReader, type ProcessObservation } from "./sandbox-processes";
import { isSandboxedProcess } from "./sandbox-detect";
import { ALLOW_DEFAULT_PROFILE, SANDBOX_EXEC, assertSandboxExecApplies, liveSandboxProbes } from "./sandbox-live-probes";
import { withTimeZone } from "./test-utils";

const darwinTest = process.platform === "darwin" ? test : test.skip;
const MODULE = JSON.stringify(join(import.meta.dir, "sandbox-collector.ts"));

// ---- the kernel's view of processes, as fixture data ----

// Every daemon and attach below reads this table instead of the kernel, so the
// suite also passes inside a sandbox, where kern.bootsessionuuid is unreadable.
// Files, flocks, the stream pipe and child processes stay real. Fixture PIDs are
// above any macOS PID, so they can never name a real process; "killing" one only
// removes its row. The LIVE probes at the end of this file check the real reader.
const FAKE_BOOT = "00000000-0000-0000-0000-000000000000";
const TEST_PROCESS_BIRTH = "1700000000:0";
const table = new Map<number, ProcessObservation>();
const resetTable = () => {
  table.clear();
  table.set(process.pid, { pid: process.pid, ppid: 1, birth: TEST_PROCESS_BIRTH });
};
resetTable();
const processTable: ReturnType<typeof openSandboxProcessReader> =
  { boot: FAKE_BOOT, read: pid => table.get(pid) ?? null, sandboxed: () => false, close: () => {} };
const serve = (opts: ServeOptions) => serveSandboxCollector({ openProcessReader: () => processTable, ...opts });
const attach = (opts: AttachOptions) => attachSandboxLaunch({ openProcessReader: () => processTable, ...opts });

let fixtureCount = 0;
/** A live process in the table, a child of the test process unless told otherwise. */
function fixtureProcess(ppid = process.pid): { pid: number; kill: () => void } {
  const pid = 2_000_000 + ++fixtureCount;
  table.set(pid, { pid, ppid, birth: `1700000000:${fixtureCount}` });
  return { pid, kill: () => { table.delete(pid); } };
}

/** The factory for a child process's script, which cannot see the table: every
 * PID is alive, with the boot and birth the table gives the test process. */
const childProcessReader = `() => ({ boot: ${JSON.stringify(FAKE_BOOT)}, read: pid => ({ pid, ppid: 1, birth: ${JSON.stringify(TEST_PROCESS_BIRTH)} }), sandboxed: () => false, close: () => {} })`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetTable();
});

async function until(predicate: () => Promise<boolean> | boolean, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("collector fixture did not reach the expected state");
}

const text = (path: string) => readFile(path, "utf8").catch(() => "");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** A shell wait loop that also ends after ~60 s: a run that cannot signal its
 * children (a sandboxed agent) or that dies mid-test must not leave it spinning. */
const boundedWait = (condition: string) => `i=0; while ${condition} && [ $i -lt 3000 ]; do sleep 0.02; i=$((i+1)); done`;

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "sandbox-collector-test-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

type LaunchFixture = { agentDir: string; agentLog: string; dir: string; name: string; tag: string };

/** The same artifacts the launcher and the launch preamble create, in a private
 * namespace: the agent's tagged profile and one launch directory. */
async function launchDir(home: string, agent: string): Promise<LaunchFixture> {
  const agentDir = join(home, "agents", agent);
  await mkdir(agentDir, { recursive: true });
  const parent = sandboxLogParent(agentDir, home);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tag = newSandboxTag();
  await writeFile(sandboxProfilePath(agentDir, home), `(version 1)\n(deny default (with message "${tag}"))\n`, { mode: 0o600 });
  const dir = mkdtempSync(join(parent, "sandbox-log."));
  await chmod(dir, 0o700);
  await writeFile(join(dir, "stop"), "");
  return { agentDir, agentLog: join(agentDir, "agent.log"), dir, name: dir.split("/").pop()!, tag };
}

// ---- pure validation with a fake reader ----

const observation =(pid: number, ppid: number, birth = `1700000000:${pid}`): ProcessObservation => ({ pid, ppid, birth });
const named = (p: ProcessObservation): RegisteredProcess => ({ pid: p.pid, birth: p.birth });

function fakeReader(processes: ProcessObservation[], sandboxed: number[] = []): CollectorReader {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  return { boot: FAKE_BOOT, read: pid => byPid.get(pid) ?? null, sandboxed: pid => sandboxed.includes(pid) };
}

async function registration(dir: string, fields: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "registration.json"), JSON.stringify({ v: 2, boot: FAKE_BOOT,
    owner: named(observation(100, 1)), registrar: named(observation(300, 200)),
    token: randomBytes(16).toString("hex"), tag: newSandboxTag(), ...fields }));
}

test("validateRegistration accepts a private launch from the exact registrar and owner it names", async () => {
  const home = await tempHome();
  const launch = await launchDir(home, "a");
  await registration(launch.dir, { agentLog: launch.agentLog, tag: launch.tag });
  const reader = fakeReader([observation(100, 1), observation(200, 100), observation(300, 200)]);
  const accepted = validateRegistration(launch.name, `${launch.dir}\n`, reader, home);
  expect(accepted.dir).toBe(launch.dir);
  expect(accepted.agentLog).toBe(launch.agentLog);
  expect(accepted.owner.pid).toBe(100);
  expect(accepted.tag).toBe(launch.tag);
});

test("validateRegistration rejects forged, redirected, stale, unprivate and unproven registrations", async () => {
  const home = await tempHome();
  const launch = await launchDir(home, "a");
  const other = await launchDir(home, "b");
  const tree = [observation(100, 1), observation(200, 100), observation(300, 200), observation(400, 1)];
  const reject = async (fields: Record<string, unknown>, expected: string, opts: { name?: string; entry?: string; reader?: CollectorReader } = {}) => {
    await registration(launch.dir, { agentLog: launch.agentLog, ...fields });
    expect(() => validateRegistration(opts.name ?? launch.name, opts.entry ?? launch.dir, opts.reader ?? fakeReader(tree), home)).toThrow(expected);
  };
  await reject({}, "invalid registration name", { name: "../sandbox-log.x" });
  await reject({}, "outside the sealed launch namespace", { entry: join(home, "elsewhere", launch.name) });
  await reject({}, "outside the sealed launch namespace", { name: other.name, entry: launch.dir });
  await reject({ agentLog: other.agentLog }, "agent log is not bound");
  await reject({ v: 1 }, "unsupported registration protocol"); // before tags: no tag to attribute by
  await reject({ token: "short" }, "malformed registration");
  await reject({ tag: undefined }, "malformed registration");
  await reject({ tag: "ib-agent:short" }, "malformed registration");
  await reject({ tag: `ib-agent:${"0".repeat(32)}\nib-agent:${"1".repeat(32)}` }, "malformed registration");
  await reject({ owner: 100 }, "malformed registration"); // a bare PID is not an identity
  await reject({ boot: "11111111-1111-1111-1111-111111111111" }, "registration is from another boot");
  await reject({ registrar: { pid: 999, birth: "1700000000:999" } }, "registrar is not running");
  // Same PIDs, other births: a crash or reboot left the directory, the PIDs were reused.
  await reject({ registrar: { pid: 300, birth: "1800000000:1" } }, "registrar is not running (or its PID now names another process)");
  await reject({ owner: { pid: 100, birth: "1800000000:1" } }, "launch owner is not running (or its PID now names another process)");
  await reject({ registrar: named(observation(400, 1)) }, "not an ancestor");
  await reject({}, "is sandboxed", { reader: fakeReader(tree, [100]) });
  await reject({}, "is sandboxed", { reader: fakeReader(tree, [300]) });

  await chmod(launch.dir, 0o755);
  await reject({}, "not a private directory");
  await chmod(launch.dir, 0o700);

  const linked = join(launch.dir, "..", "sandbox-log.linked");
  await symlink(launch.dir, linked);
  await reject({}, "not a private directory", { name: "sandbox-log.linked", entry: linked });

  await rm(join(launch.dir, "registration.json"));
  await writeFile(join(other.dir, "registration.json"), JSON.stringify({ v: 2 }));
  await symlink(join(other.dir, "registration.json"), join(launch.dir, "registration.json"));
  expect(() => validateRegistration(launch.name, launch.dir, fakeReader(tree), home)).toThrow();
});

// ---- the only writer into agent-writable directories ----

test("a status line uses agent.log's local [YYYY-MM-DD HH:MM:SS] stamp, not UTC", () => {
  setSystemTime(new Date("2026-10-08T18:10:28.777Z"));
  try {
    expect(withTimeZone("America/Chicago", () => collectorLine("ERROR", "sandbox-log.ABC", "log stream failed\nforged")))
      .toBe("[2026-10-08 13:10:28] [SandboxCollector] ERROR: launch=sandbox-log.ABC log stream failed forged\n");
  } finally { setSystemTime(); }
});

test("appendAgentLog never follows a symlinked agent.log", async () => {
  const home = await tempHome();
  const victim = join(home, "victim");
  await writeFile(victim, "original\n");
  const agentLog = join(home, "agent.log");
  await symlink(victim, agentLog);
  expect(() => appendAgentLog(agentLog, "[Sandbox] injected\n")).toThrow();
  expect(await text(victim)).toBe("original\n");
});

darwinTest("appendAgentLog refuses a FIFO at once, with no reader and with a reader", async () => {
  const home = await tempHome();
  const fifo = join(home, "agent.log");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
  // No reader: a blocking open would wait forever; O_NONBLOCK fails with ENXIO.
  expect(() => appendAgentLog(fifo, "x\n")).toThrow();
  // A reader: the open succeeds, but a FIFO is not a regular file; nothing is written.
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    expect(() => appendAgentLog(fifo, "x\n")).toThrow("not a regular file");
    expect(readSync(reader, Buffer.alloc(16))).toBe(0); // EOF: no writer left, no data
  } finally { closeSync(reader); }
});

// ---- locks ----

darwinTest("the daemon role is exclusive, and client locks block the daemon's exit lock", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  const role = tryCollectorLock(paths.daemonLock);
  expect(role).not.toBeNull();
  expect(tryCollectorLock(paths.daemonLock)).toBeNull();
  expect(sandboxCollectorRunning(paths)).toBe(true);
  closeSync(role!);
  expect(sandboxCollectorRunning(paths)).toBe(false);

  const clientA = holdCollectorClient(paths);
  const clientB = holdCollectorClient(paths); // shared: many registrars at once
  expect(tryCollectorLock(paths.clientsLock)).toBeNull();
  closeSync(clientA);
  expect(tryCollectorLock(paths.clientsLock)).toBeNull();
  closeSync(clientB);
  const exit = tryCollectorLock(paths.clientsLock);
  expect(exit).not.toBeNull();
  closeSync(exit!);
});

darwinTest("a handed-over daemon role outlives the parent and dies with the daemon, not its children", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  const ready = join(home, "ready");
  const daemon = join(home, "daemon.ts");
  await writeFile(daemon, `
    import { dlopen, FFIType } from "bun:ffi";
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    if (lib.symbols.flock(3, 6) !== 0) process.exit(3); // fd 3 must hold LOCK_EX already
    Bun.spawn(["/bin/sh", "-c", ${JSON.stringify(boundedWait(`[ -d '${home}' ]`))}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await Bun.write(${JSON.stringify(ready)}, "");
    await Bun.sleep(30000);
  `);
  const role = tryCollectorLock(paths.daemonLock)!;
  const child = Bun.spawn([process.execPath, daemon], { stdio: ["ignore", "ignore", "ignore", role] });
  closeSync(role);
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await child.exited; });
  await until(() => Bun.file(ready).exists());
  // Our copy is closed; the role stays held through the child's fd 3.
  expect(sandboxCollectorRunning(paths)).toBe(true);
  child.kill("SIGKILL");
  await child.exited;
  // The daemon's own child is still alive and must not have inherited fd 3.
  expect(sandboxCollectorRunning(paths)).toBe(false);
});

darwinTest("status shows the heartbeat age and marks a stopped loop STALE with the manual fix", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  const role = tryCollectorLock(paths.daemonLock)!; // a daemon that holds its lock...
  try {
    await writeFile(paths.heartbeat, JSON.stringify({ v: 1, pid: 4242, nonce: "abcdef01", updatedAt: 1_000_000, launches: 3 }));
    const fresh = sandboxCollectorStatus(home, 1_001_000);
    expect(fresh).toContain("running: yes");
    expect(fresh).toContain("launches: 3");
    expect(fresh).toContain("heartbeat age: 1.0 s");
    expect(fresh).not.toContain("STALE");
    const stale = sandboxCollectorStatus(home, 1_030_000); // ...whose loop stopped 30 s ago
    expect(stale).toContain("heartbeat age: 30.0 s (STALE)");
    expect(stale).toContain("kill -9 4242");
  } finally { closeSync(role); }
  expect(sandboxCollectorStatus(home, 1_030_000)).toContain("running: no");
});

darwinTest("serve refuses a handed-over fd that is not daemon.lock", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  // An exclusively locked fd on ANOTHER file: flock alone would accept it.
  const decoy = tryCollectorLock(join(home, "decoy.lock"))!;
  expect(await serve({ home, lockFd: decoy })).toBe(1);
  expect(sandboxCollectorRunning(paths)).toBe(false);
});

darwinTest("exit-versus-register: an attach waits out an exiting daemon, then starts exactly one", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  const launch = await launchDir(home, "a");
  // The exiting daemon's state: role still held, clients.lock held exclusively.
  const role = tryCollectorLock(paths.daemonLock)!;
  const exiting = tryCollectorLock(paths.clientsLock)!;
  const reached = join(home, "reached");
  const calls = join(home, "calls");
  const script = join(home, "attach.ts");
  await writeFile(script, `
    import { appendFileSync, fstatSync, lstatSync } from "node:fs";
    import { attachSandboxLaunch } from ${MODULE};
    const held: number[] = [];
    await Bun.write(${JSON.stringify(reached)}, "");
    process.exit(await attachSandboxLaunch({ dir: ${JSON.stringify(launch.dir)}, owner: ${process.pid},
      agentLog: ${JSON.stringify(launch.agentLog)}, home: ${JSON.stringify(home)}, pollMs: 50,
      openProcessReader: ${childProcessReader},
      startCollector: fd => {
        const a = fstatSync(fd), b = lstatSync(${JSON.stringify(paths.daemonLock)});
        appendFileSync(${JSON.stringify(calls)}, String(a.dev === b.dev && a.ino === b.ino) + "\\n");
        held.push(fd); // keep the role, as a daemon would
      } }));
  `);
  const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; });
  await until(() => Bun.file(reached).exists());
  await Bun.sleep(300);
  // Blocked in its shared client lock: nothing registered, nothing started.
  expect(existsSync(join(launch.dir, "registration.json"))).toBe(false);
  expect(readdirSync(paths.inbox)).toEqual([]);
  expect(existsSync(calls)).toBe(false);
  closeSync(role);    // the exiting daemon gives up the role first,
  closeSync(exiting); // then the clients lock
  await until(async () => (await text(calls)).length > 0);
  await Bun.sleep(300);
  expect(await text(calls)).toBe("true\n"); // exactly one start, with daemon.lock itself
  expect(sandboxCollectorRunning(paths)).toBe(true); // the role is held through that fd
  expect(existsSync(join(launch.dir, "registration.json"))).toBe(true);
  child.kill(); // SIGTERM: the launch ends while it waits for an answer
  expect(await child.exited).toBe(0);
}, 20000);

// ---- the daemon with a controlled stream peer ----

/** A controlled stream peer that relays a feed file; NOT /usr/bin/log. */
async function fakeStream(home: string) {
  const feed = join(home, "feed.ndjson");
  const exitFile = join(home, "stream-exit");
  await writeFile(feed, "");
  const script = join(home, "stream.ts");
  await writeFile(script, `
    import { readFileSync, existsSync } from "node:fs";
    let offset = 0;
    void (async () => { for await (const _ of Bun.stdin.stream()) {} process.exit(0); })();
    setInterval(() => {
      if (existsSync(${JSON.stringify(exitFile)})) process.exit(9);
      const data = readFileSync(${JSON.stringify(feed)}, "utf8");
      if (data.length > offset) { process.stdout.write(data.slice(offset)); offset = data.length; }
    }, 5);
  `);
  const streams: Bun.Subprocess[] = [];
  cleanups.push(async () => {
    for (const s of streams) if (s.exitCode === null && s.signalCode === null) s.kill();
    await Promise.all(streams.map(s => s.exited));
  });
  let mach = 1000;
  const markers: number[] = [];
  return {
    feed,
    script,
    exitFile,
    /** performance.now() of every marker the daemon emitted. */
    markers,
    spawnStream: (_predicate: string) => {
      const s = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      streams.push(s);
      return s;
    },
    emitMarker: (marker: string) => {
      markers.push(performance.now());
      void appendFile(feed, `${JSON.stringify({ processImagePath: "/usr/bin/logger", eventMessage: marker })}\n`);
    },
    /** A kernel report as the stream delivers it: the profile's tag is the last line. */
    report: (tag: string, pid: number, operation: string, path = "/private/tmp/forbidden") => appendFile(feed, `${JSON.stringify({
      messageType: "Error", subsystem: "", category: "", processID: 0, processImagePath: "/kernel",
      senderImagePath: "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox", bootUUID: "",
      timestamp: "2026-10-06 17:00:00.000000-0500", machTimestamp: ++mach,
      eventMessage: `Sandbox: sleep(${pid}) deny(1) ${operation} ${path}\n${tag}`,
    })}\n`),
  };
}

const identity = (pid: number, reader: CollectorReader = processTable): RegisteredProcess => {
  const p = reader.read(pid);
  if (!p) throw new Error(`no process ${pid}`);
  return { pid: p.pid, birth: p.birth };
};

/** Write what attach writes, for a registrar the test controls. */
async function writeRegistration(launch: LaunchFixture, registrar: RegisteredProcess, tag = launch.tag, reader: CollectorReader = processTable): Promise<string> {
  const token = randomBytes(16).toString("hex");
  await writeFile(join(launch.dir, "registration.json"), JSON.stringify({ v: 2, agentLog: launch.agentLog,
    boot: reader.boot, owner: identity(process.pid, reader), registrar, token, tag }));
  return token;
}

async function register(home: string, launch: LaunchFixture, registrarPid: number, tag = launch.tag): Promise<string> {
  const token = await writeRegistration(launch, identity(registrarPid), tag);
  await writeFile(join(sandboxCollectorPaths(home).inbox, launch.name), launch.dir);
  return token;
}

/** Stand in for a live attach: a shared client lock keeps the daemon serving. */
async function client(home: string): Promise<{ release: () => void }> {
  await mkdir(sandboxCollectorPaths(home).inbox, { recursive: true, mode: 0o700 });
  let fd: number | null = holdCollectorClient(sandboxCollectorPaths(home));
  const release = () => { if (fd !== null) { closeSync(fd); fd = null; } };
  cleanups.push(async () => release());
  return { release };
}

type Stream = Awaited<ReturnType<typeof fakeStream>>;
/** A daemon with a fast loop, so lifecycle tests do not wait out the 1 s
 * cadence; "the daemon loop runs once a second" checks the real one. */
function startDaemon(home: string, stream: Stream, lockFd?: number): Promise<number> {
  const served = serve({ home, lockFd, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker, loopMs: 100 });
  cleanups.push(async () => { await writeFile(sandboxCollectorPaths(home).stop, "stop\n").catch(() => {}); await served; });
  return served;
}

darwinTest("the daemon loop runs once a second; readiness comes from the pump, not the loop", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  // The test decides which markers come back; none reach the stream by themselves.
  const emitted: { at: number; marker: string }[] = [];
  const served = serve({ home, spawnStream: stream.spawnStream,
    emitMarker: marker => { emitted.push({ at: performance.now(), marker }); } });
  cleanups.push(async () => { await writeFile(paths.stop, "stop\n").catch(() => {}); await served; });

  // A's markers never come back: one per pass, then the 3 s deadline fails it,
  // inside the preamble's 5 s bound (at most one pass to admit + 3 s).
  const a = await launchDir(home, "a");
  const registered = performance.now();
  const tokenA = await register(home, a, fixtureProcess().pid);
  await until(async () => (await text(join(a.dir, "done"))) === tokenA, 8000);
  expect(performance.now() - registered).toBeLessThan(4500);
  expect(await text(a.agentLog)).toContain("readiness marker was not observed within 3 seconds");
  const passes = emitted.map(e => e.at);
  expect(passes.length).toBe(3);
  for (let i = 1; i < passes.length; i++) {
    expect(passes[i]! - passes[i - 1]!).toBeGreaterThanOrEqual(990);
    expect(passes[i]! - passes[i - 1]!).toBeLessThan(1500);
  }
  // The heartbeat is written by the same pass.
  const first = JSON.parse(await text(paths.heartbeat)).updatedAt;
  await until(async () => JSON.parse(await text(paths.heartbeat)).updatedAt !== first, 3000);
  expect(JSON.parse(await text(paths.heartbeat)).updatedAt - first).toBeGreaterThanOrEqual(990);

  // B's first marker comes back: `ready` follows at once, not at the next pass.
  const b = await launchDir(home, "b");
  await register(home, b, fixtureProcess().pid);
  await until(() => emitted.length === 4, 3000);
  const returned = performance.now();
  await appendFile(stream.feed, `${JSON.stringify({ processImagePath: "/usr/bin/logger", eventMessage: emitted[3]!.marker })}\n`);
  await until(() => existsSync(join(b.dir, "ready")), 3000);
  expect(performance.now() - returned).toBeLessThan(500);
  expect(emitted.length).toBe(4);
  // And so is a report: B's record arrives between passes too.
  const reported = performance.now();
  await stream.report(b.tag, 101, "file-read-data");
  await until(async () => (await text(b.agentLog)).includes("pid=101"), 3000);
  expect(performance.now() - reported).toBeLessThan(500);
  registrars.release();
  await writeFile(join(b.dir, "stop"), "stop\n");
  expect(await served).toBe(0);
}, 20000);

darwinTest("a cold start whose first marker is lost is ready on the next 1 s pass, inside the 5 s bound", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  let emitted = 0;
  const daemons: Promise<number>[] = [];
  // The attach starts a daemon at the real cadence; its stream is cold, so the
  // first marker never comes back.
  const startCollector = (lockFd: number) => {
    const served = serve({ home, lockFd, spawnStream: stream.spawnStream,
      emitMarker: marker => { if (++emitted > 1) stream.emitMarker(marker); } });
    cleanups.push(async () => { await writeFile(paths.stop, "stop\n").catch(() => {}); await served; });
    daemons.push(served);
  };
  const a = await launchDir(home, "a");
  const registered = performance.now();
  const attached = attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, startCollector, pollMs: 50 });
  await until(() => existsSync(join(a.dir, "ready")), 5000);
  const elapsed = performance.now() - registered;
  expect(emitted).toBe(2);
  expect(elapsed).toBeGreaterThanOrEqual(900); // it waited for the next pass
  expect(elapsed).toBeLessThan(2500);
  await writeFile(join(a.dir, "stop"), "stop\n");
  expect(await attached).toBe(0);
  expect(await daemons[0]).toBe(0);
}, 20000);

darwinTest("one daemon serves two launches and routes each report to its own launch only, by exact tag", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  const served = startDaemon(home, stream);
  await until(() => sandboxCollectorRunning(paths));
  // A second daemon defers to the running one at once.
  expect(await serve({ home, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker })).toBe(0);

  const a = await launchDir(home, "a");
  const b = await launchDir(home, "b");
  const registrarA = fixtureProcess();
  const registrarB = fixtureProcess();
  const tokenA = await register(home, a, registrarA.pid);
  const tokenB = await register(home, b, registrarB.pid);
  await until(async () => await Bun.file(join(a.dir, "ready")).exists() && await Bun.file(join(b.dir, "ready")).exists());
  expect(await text(a.agentLog)).toContain(`launch=${a.name} stream ready`);

  // Any pid: a report belongs to the launch whose tag is its last line.
  await stream.report(a.tag, 101, "file-read-data");
  await stream.report(b.tag, 102, "file-write-create");
  await stream.report(newSandboxTag(), 103, "file-read-data"); // an unknown tag
  // Path text naming A's tag, but B's real tag last: B's only.
  await stream.report(b.tag, 104, "file-read-data", `/tmp/x\n${a.tag}`);
  // A's tag in the middle of the last line is not A's tag.
  await stream.report(`${a.tag} `, 105, "file-read-data");
  // A report the kernel cut inside A's tag.
  await stream.report(`${a.tag.slice(0, 20)}<…>`, 107, "file-read-data");
  await until(async () => (await text(a.agentLog)).includes("[Sandbox]") && count(await text(b.agentLog), "[Sandbox]") === 2);
  await Bun.sleep(300); // nothing else may arrive
  const logA = await text(a.agentLog);
  const logB = await text(b.agentLog);
  expect(count(logA, "[Sandbox]")).toBe(1);
  expect(logA).toContain(`[Sandbox] file-read-data process="sleep" pid=101 target="/private/tmp/forbidden" launch=${a.name} `);
  expect(logB).toContain(`[Sandbox] file-write-create process="sleep" pid=102 `);
  expect(logB).toContain(`[Sandbox] file-read-data process="sleep" pid=104 `);
  for (const log of [logA, logB]) {
    expect(log).not.toContain("pid=103");
    expect(log).not.toContain("pid=105");
    expect(log).not.toContain("pid=107");
  }
  // agent.log is readable by other agents: the collector never writes a launch's
  // own tag there (B's log shows A's tag only as the path text above).
  expect(logA).not.toContain(a.tag.slice("ib-agent:".length));
  expect(logB).not.toContain(b.tag.slice("ib-agent:".length));

  // A third launch cannot register a tag another launch already holds.
  const c = await launchDir(home, "c");
  await register(home, c, fixtureProcess().pid, a.tag);
  await until(async () => (await text(join(c.dir, "done"))) === "rejected");
  expect(existsSync(join(c.dir, "failed"))).toBe(true);
  expect(await text(paths.log)).toContain("attribution tag is already registered by another launch");

  // The launch's own stop file ends only that launch.
  await writeFile(join(a.dir, "stop"), "stop\n");
  await until(async () => (await text(join(a.dir, "done"))) === tokenA);
  expect(await text(a.agentLog)).toContain(`launch=${a.name} collector stopped`);
  expect(await Bun.file(join(b.dir, "done")).exists()).toBe(false);
  // Its tag is no longer registered.
  await stream.report(a.tag, 106, "file-read-data");
  await Bun.sleep(300);
  expect(await text(a.agentLog)).not.toContain("pid=106");

  // A dead registrar ends its launch too, with a warning while the owner lives.
  registrarB.kill();
  await until(async () => (await text(join(b.dir, "done"))) === tokenB);
  expect(await text(b.agentLog)).toContain("collection stopping before the launch ends; coverage reduced");

  // No launch left, but a registrar still holds its client lock: keep serving.
  await Bun.sleep(300);
  expect(sandboxCollectorRunning(paths)).toBe(true);
  // The last client lock goes: exit and give up the role.
  registrars.release();
  expect(await served).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 20000);

darwinTest("a coalesced summary keeps its count; an ambiguous process name is counted, not recorded", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const registrars = await client(home);
  const served = startDaemon(home, stream);
  const a = await launchDir(home, "a");
  await register(home, a, fixtureProcess().pid);
  await until(() => Bun.file(join(a.dir, "ready")).exists());
  await appendFile(stream.feed, `${JSON.stringify({
    messageType: "Error", processID: 0, processImagePath: "/kernel", bootUUID: "",
    senderImagePath: "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox",
    timestamp: "2026-10-06 17:00:00.000000-0500", machTimestamp: 77,
    eventMessage: `29 duplicate reports for Sandbox: bash(81072) deny(1) file-read-data /x\n${a.tag}`,
  })}\n`);
  await stream.report(a.tag, 0, "file-read-data", "/y"); // "sleep(0)": no valid split
  await until(async () => (await text(a.agentLog)).includes("duplicates=29"));
  expect(await text(a.agentLog)).toContain('[Sandbox] file-read-data process="bash" pid=81072 target="/x"');
  // The ambiguous count reaches the launch's summary when it ends.
  await writeFile(join(a.dir, "stop"), "stop\n");
  await until(() => Bun.file(join(a.dir, "done")).exists());
  expect(await text(a.agentLog)).toContain("ambiguous process names omitted=1");
  registrars.release();
  expect(await served).toBe(0);
}, 20000);

darwinTest("a FIFO agent.log fails only its own launch; another launch still gets its record", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  const served = startDaemon(home, stream);
  const a = await launchDir(home, "a");
  const b = await launchDir(home, "b");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", a.agentLog]).exitCode).toBe(0); // no reader, ever
  const tokenA = await register(home, a, fixtureProcess().pid);
  const tokenB = await register(home, b, fixtureProcess().pid);
  await until(async () => await Bun.file(join(a.dir, "ready")).exists() && await Bun.file(join(b.dir, "ready")).exists());
  await stream.report(a.tag, 101, "file-read-data");
  await stream.report(b.tag, 102, "file-write-create");
  await until(async () => (await text(b.agentLog)).includes(`[Sandbox] file-write-create process="sleep" pid=102 `));
  await until(async () => (await text(join(a.dir, "done"))) === tokenA);
  expect(existsSync(join(a.dir, "failed"))).toBe(true);
  expect(await text(paths.log)).toContain("agent.log unwritable");
  expect(sandboxCollectorRunning(paths)).toBe(true); // B is still served
  await writeFile(join(b.dir, "stop"), "stop\n");
  await until(async () => (await text(join(b.dir, "done"))) === tokenB);
  registrars.release();
  expect(await served).toBe(0);
}, 20000);

darwinTest("the daemon rejects a registration redirected to another agent's log", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  const served = startDaemon(home, stream);
  const a = await launchDir(home, "a");
  const victim = await launchDir(home, "victim");
  const registrar = fixtureProcess();
  await writeFile(join(a.dir, "registration.json"), JSON.stringify({ v: 2, agentLog: victim.agentLog, boot: FAKE_BOOT,
    owner: identity(process.pid), registrar: identity(registrar.pid), token: randomBytes(16).toString("hex"), tag: a.tag }));
  await writeFile(join(paths.inbox, a.name), a.dir);
  await until(async () => (await text(paths.log)).includes(`registration ${a.name} rejected: Error: agent log is not bound`));
  // The registrar hears it through its own private directory only.
  expect(await Bun.file(join(a.dir, "failed")).exists()).toBe(true);
  expect(await text(join(a.dir, "done"))).toBe("rejected");
  expect(await Bun.file(join(a.dir, "ready")).exists()).toBe(false);
  expect(await Bun.file(victim.agentLog).exists()).toBe(false);
  registrars.release();
  expect(await served).toBe(0);
}, 20000);

darwinTest("a stale directory with a dead or reused registrar is never adopted, and is examined once", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  // Dead: the registrar exited (a crashed supervisor).
  const dead = await launchDir(home, "dead");
  const gone = fixtureProcess();
  const goneIdentity = identity(gone.pid);
  gone.kill();
  await writeRegistration(dead, goneIdentity);
  // Reused: the PID is alive but names another process (other birth).
  const reused = await launchDir(home, "reused");
  await writeRegistration(reused, { pid: fixtureProcess().pid, birth: "1000000000:1" });
  const first = startDaemon(home, stream);
  await until(async () => (await text(paths.log)).includes(`launch ${dead.name} not adopted`) &&
    (await text(paths.log)).includes(`launch ${reused.name} not adopted`));
  for (const launch of [dead, reused]) {
    expect(await text(join(launch.dir, "done"))).toBe("rejected");
    expect(existsSync(join(launch.dir, "failed"))).toBe(true);
    expect(existsSync(join(launch.dir, "ready"))).toBe(false);
    expect(await text(launch.agentLog)).toBe("");
  }
  expect(await text(paths.log)).toContain("registrar is not running (or its PID now names another process)");
  await writeFile(paths.stop, "stop\n");
  expect(await first).toBe(0);
  // The next daemon start skips both (they carry `done`).
  const second = startDaemon(home, stream);
  await until(() => Bun.file(paths.heartbeat).exists()); // its loop ran, so its scan ran
  expect(count(await text(paths.log), `launch ${dead.name} not adopted`)).toBe(1);
  expect(count(await text(paths.log), `launch ${reused.name} not adopted`)).toBe(1);
  registrars.release();
  expect(await second).toBe(0);
}, 20000);

// ---- attach ----

darwinTest("attach registers its profile's tag; a raw profile without one is refused", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  const a = await launchDir(home, "a");
  // A daemon that holds the role and never answers: the registration stays.
  const role = tryCollectorLock(paths.daemonLock)!;
  cleanups.push(async () => closeSync(role));
  const attached = attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, pollMs: 20 });
  await until(() => existsSync(join(paths.inbox, a.name)));
  expect(JSON.parse(await text(join(a.dir, "registration.json"))).tag).toBe(a.tag);
  writeFileSync(join(a.dir, "failed"), "");
  expect(await attached).toBe(1);

  const b = await launchDir(home, "b");
  await writeFile(sandboxProfilePath(b.agentDir, home), "(version 1)\n(deny default)\n");
  expect(await attach({ dir: b.dir, owner: process.pid, agentLog: b.agentLog, home, pollMs: 20 })).toBe(1);
  expect(await text(b.agentLog)).toContain("the launch profile carries no attribution tag");
  expect(existsSync(join(b.dir, "registration.json"))).toBe(false);
});

darwinTest("upgrade: a launch registered before tags (protocol 1) is rejected by the new daemon's scan; its attach returns", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const daemons: Promise<number>[] = [];
  const startCollector = (lockFd: number) => { daemons.push(startDaemon(home, stream, lockFd)); };
  const a = await launchDir(home, "a");
  const attached = attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, startCollector, pollMs: 50 });
  await until(() => Bun.file(join(a.dir, "ready")).exists());
  // What an older `ib` wrote for this launch: no tag.
  const { tag: _tag, ...older } = JSON.parse(await text(join(a.dir, "registration.json")));
  await writeFile(join(a.dir, "registration.json"), JSON.stringify({ ...older, v: 1 }));
  // The daemon is replaced (as by `ib sandbox-collector restart` after the upgrade).
  expect(restartSandboxCollector(home)).toBe(true);
  expect(await daemons[0]).toBe(0);
  // The successor's startup scan rejects it in the launch's own directory...
  await until(async () => (await text(join(a.dir, "done"))) === "rejected", 6000);
  expect(existsSync(join(a.dir, "failed"))).toBe(true);
  expect(await text(paths.log)).toContain(`launch ${a.name} not adopted: Error: unsupported registration protocol 1`);
  // ...and its attach returns with a visible ERROR instead of waiting.
  expect(await attached).toBe(1);
  expect(await text(a.agentLog)).toContain("shared collector rejected this launch");
  expect(existsSync(join(a.dir, "ready"))).toBe(false);
  // With that attach gone, the successor has nothing to serve and exits.
  expect(daemons.length).toBe(2);
  expect(await daemons[1]).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 20000);

darwinTest("attach starts a new daemon after a stream failure and the new one re-adopts every live launch", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const daemons: Promise<number>[] = [];
  const startCollector = (lockFd: number) => { daemons.push(startDaemon(home, stream, lockFd)); };
  const a = await launchDir(home, "a");
  const attached = attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, startCollector, pollMs: 50 });
  await until(() => Bun.file(join(a.dir, "ready")).exists());
  // B's registrar never notices a restart; the new daemon must adopt it anyway.
  const b = await launchDir(home, "b");
  const registrarB = fixtureProcess();
  await register(home, b, registrarB.pid);
  await until(() => Bun.file(join(b.dir, "ready")).exists());

  // The stream dies: the daemon reports it and exits without `done`.
  await writeFile(stream.exitFile, "");
  expect(await daemons[0]).toBe(1);
  await rm(stream.exitFile);
  await until(async () => count(await text(a.agentLog), "stream ready") === 2 &&
    (await text(b.agentLog)).includes("shared collector resumed"), 6000);
  const log = await text(a.agentLog);
  expect(log).toContain("shared collector failed: Error: log stream stopped unexpectedly");
  expect(log).toContain("shared collector stopped; starting a new one");
  expect(await text(b.agentLog)).not.toContain("starting a new one");
  expect(daemons.length).toBe(2);

  await stream.report(a.tag, 101, "file-read-data");
  await stream.report(b.tag, 102, "file-write-create");
  await until(async () => (await text(a.agentLog)).includes(`[Sandbox] file-read-data process="sleep" pid=101 `) &&
    (await text(b.agentLog)).includes(`[Sandbox] file-write-create process="sleep" pid=102 `));
  registrarB.kill();
  await until(() => Bun.file(join(b.dir, "done")).exists());

  // The launch's stop ends it; attach returns once the daemon wrote `done`.
  await writeFile(join(a.dir, "stop"), "stop\n");
  expect(await attached).toBe(0);
  expect(await text(a.agentLog)).toContain(`launch=${a.name} collector stopped`);
  expect(await Bun.file(join(paths.inbox, a.name)).exists()).toBe(false);
  // The attach released its client lock and no launch is left: the daemon exits.
  expect(await daemons[1]).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 20000);

darwinTest("attach gives up after 4 starts in a row that never answer", async () => {
  const home = await tempHome();
  const a = await launchDir(home, "a");
  let starts = 0;
  // Each "daemon" dies at once: its fd closes, the role is free again.
  const code = await attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, pollMs: 20,
    startCollector: fd => { starts++; closeSync(fd); } });
  expect(code).toBe(1);
  expect(starts).toBe(4);
  expect(await text(a.agentLog)).toContain("shared collector did not stay up after 4 starts");
});

darwinTest("every acknowledged start resets the start count, so a long launch survives many restarts", async () => {
  const home = await tempHome();
  const a = await launchDir(home, "a");
  let starts = 0;
  // Three cycles of: two daemons die unanswered, the third acknowledges and then
  // dies. After that, every daemon dies unanswered. The first cycle is the
  // first registration; the other two are restarts from the registered loop.
  const code = await attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, pollMs: 20,
    startCollector: fd => {
      starts++;
      if (starts <= 9 && starts % 3 === 0) writeFileSync(join(a.dir, "ready"), a.name);
      closeSync(fd);
    } });
  expect(code).toBe(1);
  // 3 + 3 + 3 + 4. Without the reset after the first `ready` the 5th start
  // would be refused (4 calls); without the reset after a restart's `ready`,
  // the 8th (7 calls).
  expect(starts).toBe(13);
  expect(count(await text(a.agentLog), "shared collector stopped; starting a new one")).toBe(3);
}, 20000);

darwinTest("a registered attach returns when a daemon rejects its launch while holding the role", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  const a = await launchDir(home, "a");
  // Stand in for a live daemon: hold the role, acknowledge, then reject.
  let role: number | null = tryCollectorLock(paths.daemonLock)!;
  const releaseRole = () => { if (role !== null) { closeSync(role); role = null; } };
  cleanups.push(async () => releaseRole());
  let starts = 0;
  const attached = attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, pollMs: 20,
    startCollector: fd => { starts++; closeSync(fd); } });
  await until(() => existsSync(join(paths.inbox, a.name)));
  writeFileSync(join(a.dir, "ready"), a.name);
  await Bun.sleep(100); // now in the registered loop, the role still held
  writeFileSync(join(a.dir, "failed"), "");
  writeFileSync(join(a.dir, "done"), "rejected");
  const outcome = await Promise.race([attached, Bun.sleep(3000).then(() => "timeout" as const)]);
  if (outcome === "timeout") {
    // Free the role so the attach ends here, not after this test's cleanup
    // removed its directory: it starts a daemon once, and register() then sees
    // the rejection (code 1, one start).
    releaseRole();
    await attached;
    throw new Error("attach did not return after rejection");
  }
  expect(outcome).toBe(1);
  expect(starts).toBe(0);
  expect(await text(a.agentLog)).toContain("shared collector rejected this launch");
});

darwinTest("a registering attach whose owner is gone when the rejection appears ends quietly", async () => {
  const home = await tempHome();
  const paths = sandboxCollectorPaths(home);
  await mkdir(paths.inbox, { recursive: true, mode: 0o700 });
  const a = await launchDir(home, "a");
  // Stand in for a live daemon that never acknowledges: the attach stays in its
  // registering loop.
  const role = tryCollectorLock(paths.daemonLock)!;
  cleanups.push(async () => closeSync(role));
  const owner = fixtureProcess();
  let starts = 0;
  const attached = attach({ dir: a.dir, owner: owner.pid, agentLog: a.agentLog, home, startCollector: () => { starts++; } });
  await until(() => existsSync(join(paths.inbox, a.name))); // registering
  // One synchronous step on the attach's event loop, so that its next check
  // sees BOTH the owner gone and the rejection, in whichever order it checks them.
  owner.kill();
  writeFileSync(join(a.dir, "failed"), "");
  writeFileSync(join(a.dir, "done"), "rejected");
  expect(await attached).toBe(0);
  expect(starts).toBe(0);
  expect(await text(a.agentLog)).not.toContain("rejected this launch");
});

darwinTest("a successor's re-adopt scan rejects a launch whose owner just exited; its attach returns", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const daemons: Promise<number>[] = [];
  const startCollector = (lockFd: number) => { daemons.push(startDaemon(home, stream, lockFd)); };
  // M: a launch whose owner (this process) stays alive; its attach is fast.
  const m = await launchDir(home, "m");
  const attachedM = attach({ dir: m.dir, owner: process.pid, agentLog: m.agentLog, home, startCollector, pollMs: 20 });
  await until(() => Bun.file(join(m.dir, "ready")).exists());
  // L: this process is its registrar too, descending from an owner that can exit
  // while the attach lives on.
  const l = await launchDir(home, "l");
  const lOwner = fixtureProcess(1);
  table.get(process.pid)!.ppid = lOwner.pid;
  let lStarts = 0;
  const attachedL = attach({ dir: l.dir, owner: lOwner.pid, agentLog: l.agentLog, home,
    startCollector: fd => { lStarts++; closeSync(fd); } });
  await until(() => Bun.file(join(l.dir, "ready")).exists(), 8000);
  await Bun.sleep(100); // now in the registered loop, asleep for most of its 1 s poll
  // The poll misses the short gap in the replacement below (M's is 20 ms): L
  // cannot win the freed lock, so when it runs again the successor holds the
  // role, and only the rejection can end its wait.
  // L's owner exits, and the daemon is replaced before it finishes L (1 s drain).
  lOwner.kill();
  expect(restartSandboxCollector(home)).toBe(true);
  expect(await daemons[0]).toBe(0);
  // M's attach starts the successor; its scan adopts M and rejects L.
  await until(async () => (await text(join(l.dir, "done"))) === "rejected", 8000);
  expect(existsSync(join(l.dir, "failed"))).toBe(true);
  await until(async () => (await text(paths.log)).includes(`launch ${l.name} not adopted: Error: launch owner is not running`), 8000);
  expect(sandboxCollectorRunning(paths)).toBe(true); // the successor holds the role
  expect(await attachedL).toBe(0); // without the fix: never. The owner is gone: L ends quietly
  expect(lStarts).toBe(0);
  await until(async () => count(await text(m.agentLog), "stream ready") === 2, 8000);
  expect(await text(m.agentLog)).toContain("shared collector stopped; starting a new one");
  expect(daemons.length).toBe(2);
  // With L's attach gone, the successor exits once M ends.
  await writeFile(join(m.dir, "stop"), "stop\n");
  expect(await attachedM).toBe(0);
  expect(await daemons[1]).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 30000);

async function attachedPair(home: string, stream: Stream) {
  const daemons: Promise<number>[] = [];
  const startCollector = (lockFd: number) => { daemons.push(startDaemon(home, stream, lockFd)); };
  const launches: { launch: LaunchFixture; attached: Promise<number> }[] = [];
  for (const name of ["a", "b"]) {
    const launch = await launchDir(home, name);
    const attached = attach({ dir: launch.dir, owner: process.pid, agentLog: launch.agentLog, home, startCollector, pollMs: 50 });
    await until(() => Bun.file(join(launch.dir, "ready")).exists());
    launches.push({ launch, attached });
  }
  return { daemons, launches };
}

darwinTest("stop ends every launch: each gets done, each attach returns, the daemon frees the role", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const { daemons, launches } = await attachedPair(home, stream);
  expect(daemons.length).toBe(1);
  expect(stopSandboxCollector(home)).toBe(true);
  for (const { launch, attached } of launches) {
    expect(await attached).toBe(0);
    expect(await text(launch.agentLog)).toContain("collection stopping before the launch ends; coverage reduced");
    expect(await text(launch.agentLog)).toContain(`launch=${launch.name} collector stopped`);
    expect(existsSync(join(launch.dir, "done"))).toBe(true);
  }
  expect(await daemons[0]).toBe(0);
  expect(daemons.length).toBe(1); // nobody started another
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 20000);

darwinTest("restart leaves every launch to a new daemon: no done, and the new one re-adopts", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const { daemons, launches } = await attachedPair(home, stream);
  expect(restartSandboxCollector(home)).toBe(true);
  expect(await daemons[0]).toBe(0);
  // The attach that wins the freed role says so and starts the successor; the
  // successor re-adopts the other launch, whose attach did not notice.
  const restarted = (log: string) => log.includes("starting a new one") ? count(log, "stream ready") === 2 : log.includes("shared collector resumed");
  await until(async () => {
    for (const { launch } of launches) if (!restarted(await text(launch.agentLog))) return false;
    return true;
  }, 6000);
  expect(daemons.length).toBe(2);
  let starters = 0;
  for (const { launch } of launches) {
    const log = await text(launch.agentLog);
    expect(log).toContain("shared collector restarting on request");
    if (log.includes("starting a new one")) starters++;
    expect(existsSync(join(launch.dir, "done"))).toBe(false);
  }
  expect(starters).toBe(1);
  // Re-adopted with their tags: the new daemon attributes both again.
  for (const [index, { launch }] of launches.entries()) await stream.report(launch.tag, 200 + index, "file-read-data");
  for (const [index, { launch }] of launches.entries()) {
    await until(async () => (await text(launch.agentLog)).includes(`pid=${200 + index} `));
    expect(await text(launch.agentLog)).not.toContain(`pid=${201 - index} `);
  }
  for (const { launch } of launches) await writeFile(join(launch.dir, "stop"), "stop\n");
  for (const { attached } of launches) expect(await attached).toBe(0);
  expect(await daemons[1]).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 20000);

darwinTest("SIGTERM to a daemon process restarts it like `restart`, through the fd 3 hand-over", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const daemonScript = join(home, "daemon-child.ts");
  await writeFile(daemonScript, `
    import { appendFile } from "node:fs/promises";
    import { serveSandboxCollector } from ${MODULE};
    process.exit(await serveSandboxCollector({ home: ${JSON.stringify(home)}, lockFd: 3, loopMs: 100,
      openProcessReader: ${childProcessReader},
      spawnStream: () => Bun.spawn([process.execPath, ${JSON.stringify(stream.script)}], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
      emitMarker: m => { void appendFile(${JSON.stringify(stream.feed)}, JSON.stringify({ processImagePath: "/usr/bin/logger", eventMessage: m }) + "\\n"); } }));
  `);
  const children: Bun.Subprocess[] = [];
  cleanups.push(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    await Promise.all(children.map(c => c.exited));
  });
  const startCollector = (fd: number) => {
    children.push(Bun.spawn([process.execPath, daemonScript], { stdio: ["ignore", "ignore", "inherit", fd] }));
    closeSync(fd);
  };
  const a = await launchDir(home, "a");
  const attached = attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, startCollector, pollMs: 50 });
  await until(() => Bun.file(join(a.dir, "ready")).exists(), 8000);
  children[0]!.kill("SIGTERM");
  expect(await children[0]!.exited).toBe(0);
  expect(existsSync(join(a.dir, "done"))).toBe(false);
  await until(async () => count(await text(a.agentLog), "stream ready") === 2, 8000);
  expect(children.length).toBe(2);
  expect(await text(a.agentLog)).toContain("shared collector restarting on request");
  expect(await text(a.agentLog)).toContain("shared collector stopped; starting a new one");
  await writeFile(join(a.dir, "stop"), "stop\n");
  expect(await attached).toBe(0);
  expect(await children[1]!.exited).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 30000);

// ---- a missing process reader ----

const cannotOpenReader = () => { throw new Error("cannot read kernel boot identity"); };

darwinTest("a daemon that cannot open the process reader fails and frees the role", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  expect(await serve({ home, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker, openProcessReader: cannotOpenReader })).toBe(1);
  expect(sandboxCollectorRunning(paths)).toBe(false);
  expect(await text(paths.log)).toContain("cannot read kernel boot identity");
});

darwinTest("an attach that cannot open the process reader says so in agent.log and registers nothing", async () => {
  const home = await tempHome();
  const a = await launchDir(home, "a");
  expect(await attach({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, openProcessReader: cannotOpenReader })).toBe(1);
  expect(await text(a.agentLog)).toContain("cannot read kernel boot identity; kernel enforcement remains required");
  expect(existsSync(join(a.dir, "registration.json"))).toBe(false);
});

// ---- LIVE: the real kernel, on a host outside any sandbox (sandbox-live-probes.ts) ----

const liveTest = liveSandboxProbes("the real process reader, in an unsandboxed process", () => {
  assertSandboxExecApplies();
  const reader = openSandboxProcessReader();
  try {
    if (!reader.read(process.pid)) throw new Error("proc_pidinfo cannot read this process");
    if (reader.sandboxed(process.pid)) throw new Error("this run is itself sandboxed");
  } finally { reader.close(); }
});

function sleeper(prefix: string[] = []): Bun.Subprocess {
  const child = Bun.spawn([...prefix, "/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await child.exited; });
  return child;
}

liveTest("LIVE: the real sandbox_check fails closed for a reaped process", async () => {
  const reader = openSandboxProcessReader();
  try {
    const child = Bun.spawn(["/usr/bin/true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(reader.sandboxed(child.pid)).toBe(true);
    // Same kernel call as the routing check.
    expect(reader.sandboxed(process.pid)).toBe(isSandboxedProcess());
  } finally { reader.close(); }
});

liveTest("LIVE: the real reader reports the boot, and each process's parent and stable birth until it is reaped", async () => {
  const reader = openSandboxProcessReader();
  try {
    expect(reader.boot).toMatch(/^[a-f0-9-]{36}$/);
    const self = reader.read(process.pid)!;
    expect(self.ppid).toBe(process.ppid);
    expect(self.birth).toMatch(/^\d+:\d+$/);
    const child = sleeper();
    const observed = reader.read(child.pid)!;
    expect(observed.ppid).toBe(process.pid);
    expect(reader.read(child.pid)).toEqual(observed);
    child.kill();
    await child.exited;
    expect(reader.read(child.pid)).toBeNull();
  } finally { reader.close(); }
});

liveTest("LIVE: a daemon on the real reader follows a real registrar and refuses what the kernel disproves", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  const reader = openSandboxProcessReader();
  cleanups.push(async () => reader.close());
  const offer = async (launch: LaunchFixture, registrar: RegisteredProcess) => {
    const token = await writeRegistration(launch, registrar, launch.tag, reader);
    await writeFile(join(paths.inbox, launch.name), launch.dir);
    return token;
  };
  const refused = async (name: string, registrar: RegisteredProcess, reason: string) => {
    const launch = await launchDir(home, name);
    await offer(launch, registrar);
    await until(async () => (await text(paths.log)).includes(`registration ${launch.name} rejected: Error: ${reason}`));
    expect(await text(join(launch.dir, "done"))).toBe("rejected");
  };
  const served = serveSandboxCollector({ home, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker, loopMs: 100 });
  cleanups.push(async () => { await writeFile(paths.stop, "stop\n").catch(() => {}); await served; });

  // A real child of this process is adopted, and its real exit ends the launch.
  const followed = await launchDir(home, "followed");
  const registrar = sleeper();
  const token = await offer(followed, identity(registrar.pid, reader));
  await until(() => existsSync(join(followed.dir, "ready")));
  registrar.kill();
  await until(async () => (await text(join(followed.dir, "done"))) === token);
  expect(await text(followed.agentLog)).toContain("collection stopping before the launch ends; coverage reduced");

  // The kernel disproves each of these.
  await refused("reused", { pid: sleeper().pid, birth: "1000000000:1" }, "registrar is not running (or its PID now names another process)");
  await refused("unrelated", identity(process.ppid, reader), "launch owner is not an ancestor of the registrar");
  const sandboxed = sleeper([SANDBOX_EXEC, "-p", ALLOW_DEFAULT_PROFILE]);
  await until(() => reader.sandboxed(sandboxed.pid));
  await refused("sandboxed", identity(sandboxed.pid, reader), "launch owner or registrar is sandboxed");

  registrars.release();
  expect(await served).toBe(0);
}, 20000);
