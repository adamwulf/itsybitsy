import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, appendFile } from "node:fs/promises";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { appendAgentLog, attachSandboxLaunch, holdCollectorClient, restartSandboxCollector, sandboxCollectorPaths,
  sandboxCollectorRunning, sandboxCollectorStatus, serveSandboxCollector, stopSandboxCollector, tryCollectorLock, validateRegistration,
  type CollectorReader, type RegisteredProcess } from "./sandbox-collector";
import { sandboxLogParent } from "./sandbox-log-paths";
import { openSandboxProcessReader } from "./sandbox-processes";
import { isSandboxedProcess } from "./sandbox-detect";
import type { ProcessObservation } from "./sandbox-denials";

const darwinTest = process.platform === "darwin" ? test : test.skip;
const MODULE = JSON.stringify(join(import.meta.dir, "sandbox-collector.ts"));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

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

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "sandbox-collector-test-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

type LaunchFixture = { agentDir: string; agentLog: string; dir: string; name: string };

/** The same artifacts the launch preamble creates, in a private namespace. */
async function launchDir(home: string, agent: string): Promise<LaunchFixture> {
  const agentDir = join(home, "agents", agent);
  await mkdir(agentDir, { recursive: true });
  const parent = sandboxLogParent(agentDir, home);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(parent, "sandbox-log."));
  await chmod(dir, 0o700);
  await writeFile(join(dir, "stop"), "");
  return { agentDir, agentLog: join(agentDir, "agent.log"), dir, name: dir.split("/").pop()! };
}

// ---- pure validation with a fake reader ----

const FAKE_BOOT = "00000000-0000-0000-0000-000000000000";
const observation = (pid: number, ppid: number, birth = `1700000000:${pid}`): ProcessObservation =>
  ({ pid, ppid, birth, before: 1n, after: 1n });
const named = (p: ProcessObservation): RegisteredProcess => ({ pid: p.pid, birth: p.birth });

function fakeReader(processes: ProcessObservation[], sandboxed: number[] = []): CollectorReader {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  return { boot: FAKE_BOOT, read: pid => byPid.get(pid) ?? null, sandboxed: pid => sandboxed.includes(pid) };
}

async function registration(dir: string, fields: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "registration.json"), JSON.stringify({ v: 1, boot: FAKE_BOOT,
    owner: named(observation(100, 1)), registrar: named(observation(300, 200)),
    token: randomBytes(16).toString("hex"), ...fields }));
}

test("validateRegistration accepts a private launch from the exact registrar and owner it names", async () => {
  const home = await tempHome();
  const launch = await launchDir(home, "a");
  await registration(launch.dir, { agentLog: launch.agentLog });
  const reader = fakeReader([observation(100, 1), observation(200, 100), observation(300, 200)]);
  const accepted = validateRegistration(launch.name, `${launch.dir}\n`, reader, home);
  expect(accepted.dir).toBe(launch.dir);
  expect(accepted.agentLog).toBe(launch.agentLog);
  expect(accepted.owner.pid).toBe(100);
  expect([...accepted.registrarAncestors].sort()).toEqual([200, 300]);
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
  await reject({ v: 2 }, "unsupported registration protocol");
  await reject({ token: "short" }, "malformed registration");
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
  await writeFile(join(other.dir, "registration.json"), JSON.stringify({ v: 1 }));
  await symlink(join(other.dir, "registration.json"), join(launch.dir, "registration.json"));
  expect(() => validateRegistration(launch.name, launch.dir, fakeReader(tree), home)).toThrow();
});

// ---- the only writer into agent-writable directories ----

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

darwinTest("the real sandbox_check fails closed for a reaped process", async () => {
  const reader = openSandboxProcessReader();
  try {
    const child = Bun.spawn(["/usr/bin/true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(reader.sandboxed(child.pid)).toBe(true);
    // Same kernel call as the routing check, whether or not this suite is sandboxed.
    expect(reader.sandboxed(process.pid)).toBe(isSandboxedProcess());
  } finally { reader.close(); }
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
    Bun.spawn(["/bin/sh", "-c", ${JSON.stringify(`while [ -d '${home}' ]; do sleep 0.02; done`)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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
  expect(await serveSandboxCollector({ home, lockFd: decoy })).toBe(1);
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
  const clock = openSandboxProcessReader();
  cleanups.push(async () => clock.close());
  return {
    feed,
    script,
    exitFile,
    spawnStream: (_predicate: string) => {
      const s = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      streams.push(s);
      return s;
    },
    emitMarker: (marker: string) => {
      void appendFile(feed, `${JSON.stringify({ processImagePath: "/usr/bin/logger", eventMessage: marker })}\n`);
    },
    report: (pid: number, operation: string) => appendFile(feed, `${JSON.stringify({
      messageType: "Error", subsystem: "", category: "", processID: 0, processImagePath: "/kernel",
      senderImagePath: "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox", bootUUID: "",
      timestamp: "2026-10-06 17:00:00.000000-0500", machTimestamp: Number(clock.clock()),
      eventMessage: `Sandbox: sleep(${pid}) deny(1) ${operation} /private/tmp/forbidden`,
    })}\n`),
  };
}

function sleeper(): Bun.Subprocess {
  const child = Bun.spawn(["/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await child.exited; });
  return child;
}

const realReader = openSandboxProcessReader();
afterAll(() => realReader.close());
const identity = (pid: number): RegisteredProcess => {
  const p = realReader.read(pid);
  if (!p) throw new Error(`no process ${pid}`);
  return { pid: p.pid, birth: p.birth };
};

/** Write what attach writes, for a registrar the test controls. */
async function writeRegistration(launch: LaunchFixture, registrar: RegisteredProcess): Promise<string> {
  const token = randomBytes(16).toString("hex");
  await writeFile(join(launch.dir, "registration.json"), JSON.stringify({ v: 1, agentLog: launch.agentLog,
    boot: realReader.boot, owner: identity(process.pid), registrar, token }));
  return token;
}

async function register(home: string, launch: LaunchFixture, registrarPid: number): Promise<string> {
  const token = await writeRegistration(launch, identity(registrarPid));
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
function startDaemon(home: string, stream: Stream, lockFd?: number): Promise<number> {
  const served = serveSandboxCollector({ home, lockFd, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker, sandboxed: () => false });
  cleanups.push(async () => { await writeFile(sandboxCollectorPaths(home).stop, "stop\n").catch(() => {}); await served; });
  return served;
}

async function registerRoot(launch: LaunchFixture, pid: number): Promise<void> {
  await writeFile(join(launch.dir, "root-request"), `${pid}\n`);
}

darwinTest("one daemon serves two launches and routes each report to its own launch only", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  const served = startDaemon(home, stream);
  await until(() => sandboxCollectorRunning(paths));
  // A second daemon defers to the running one at once.
  expect(await serveSandboxCollector({ home, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker })).toBe(0);

  const a = await launchDir(home, "a");
  const b = await launchDir(home, "b");
  const registrarA = sleeper();
  const registrarB = sleeper();
  const tokenA = await register(home, a, registrarA.pid);
  const tokenB = await register(home, b, registrarB.pid);
  await until(async () => await Bun.file(join(a.dir, "ready")).exists() && await Bun.file(join(b.dir, "ready")).exists());
  expect(await text(a.agentLog)).toContain(`launch=${a.name} stream ready`);

  const rootA = sleeper();
  const rootB = sleeper();
  await registerRoot(a, rootA.pid);
  await registerRoot(b, rootB.pid);
  await until(async () => await Bun.file(join(a.dir, "root-ready")).exists() && await Bun.file(join(b.dir, "root-ready")).exists());

  await Bun.sleep(30);
  await stream.report(rootA.pid, "file-read-data");
  await stream.report(rootB.pid, "file-write-create");
  await stream.report(registrarA.pid, "file-read-data"); // in no registered tree
  await until(async () => (await text(a.agentLog)).includes("[Sandbox]") && (await text(b.agentLog)).includes("[Sandbox]"));
  await Bun.sleep(600); // past the pending window: nothing else may arrive
  const logA = await text(a.agentLog);
  const logB = await text(b.agentLog);
  expect(logA).toContain(`[Sandbox] file-read-data process="sleep" pid=${rootA.pid} `);
  expect(logA).toContain(`launch=${a.name}`);
  expect(logA).not.toContain(`pid=${rootB.pid}`);
  expect(logA).not.toContain(`pid=${registrarA.pid} `);
  expect(logB).toContain(`[Sandbox] file-write-create process="sleep" pid=${rootB.pid} `);
  expect(logB).not.toContain(`pid=${rootA.pid}`);

  // A third launch cannot claim a root another launch already registered.
  const c = await launchDir(home, "c");
  const registrarC = sleeper();
  await register(home, c, registrarC.pid);
  await until(() => Bun.file(join(c.dir, "ready")).exists());
  await registerRoot(c, rootA.pid);
  await until(() => Bun.file(join(c.dir, "failed")).exists());
  expect(await text(c.agentLog)).toContain("already registered by another launch");

  // The launch's own stop file ends only that launch, with a visible warning.
  await writeFile(join(a.dir, "stop"), "stop\n");
  await until(async () => (await text(join(a.dir, "done"))) === tokenA);
  expect(await text(a.agentLog)).toContain("collection stopping before the registered CLI exits");
  expect(await text(a.agentLog)).toContain(`launch=${a.name} collector stopped`);
  expect(await Bun.file(join(b.dir, "done")).exists()).toBe(false);

  // A dead registrar ends its launch too.
  registrarB.kill();
  await until(async () => (await text(join(b.dir, "done"))) === tokenB);

  // No launch left, but a registrar still holds its client lock: keep serving.
  await Bun.sleep(300);
  expect(sandboxCollectorRunning(paths)).toBe(true);
  // The last client lock goes: exit and give up the role.
  registrars.release();
  expect(await served).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 20000);

darwinTest("a root that is not the owner's child, or is the registrar itself, is refused", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const registrars = await client(home);
  const served = startDaemon(home, stream);
  // X: the root's parent is a shell, not the launch owner.
  const x = await launchDir(home, "x");
  const tokenX = await register(home, x, sleeper().pid);
  // Y: the root is the registrar (an ancestor below the owner, like the supervisor subshell).
  const y = await launchDir(home, "y");
  const registrarY = sleeper();
  const tokenY = await register(home, y, registrarY.pid);
  await until(async () => await Bun.file(join(x.dir, "ready")).exists() && await Bun.file(join(y.dir, "ready")).exists());
  const shell = Bun.spawn(["/bin/sh", "-c", `( while [ -d '${home}' ]; do sleep 0.05; done ) & echo $!; wait`],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  // The background loop ends by itself once the temp home is removed.
  cleanups.push(async () => { if (shell.exitCode === null && shell.signalCode === null) shell.kill(); await shell.exited; });
  const reader = shell.stdout.getReader();
  const grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim());
  reader.releaseLock();
  expect(realReader.read(grandchild)?.ppid).toBe(shell.pid);
  await registerRoot(x, grandchild);
  await registerRoot(y, registrarY.pid);
  for (const [launch, token] of [[x, tokenX], [y, tokenY]] as const) {
    await until(async () => (await text(join(launch.dir, "done"))) === token);
    expect(existsSync(join(launch.dir, "failed"))).toBe(true);
    expect(existsSync(join(launch.dir, "root-ready"))).toBe(false);
    expect(await text(launch.agentLog)).toContain("CLI root registration could not verify launch ancestry");
  }
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
  const tokenA = await register(home, a, sleeper().pid);
  const tokenB = await register(home, b, sleeper().pid);
  await until(async () => await Bun.file(join(a.dir, "ready")).exists() && await Bun.file(join(b.dir, "ready")).exists());
  const rootA = sleeper();
  const rootB = sleeper();
  await registerRoot(a, rootA.pid);
  await registerRoot(b, rootB.pid);
  await until(async () => await Bun.file(join(a.dir, "root-ready")).exists() && await Bun.file(join(b.dir, "root-ready")).exists());
  await Bun.sleep(30);
  await stream.report(rootA.pid, "file-read-data");
  await stream.report(rootB.pid, "file-write-create");
  await until(async () => (await text(b.agentLog)).includes(`[Sandbox] file-write-create process="sleep" pid=${rootB.pid} `));
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
  const registrar = sleeper();
  await writeFile(join(a.dir, "registration.json"), JSON.stringify({ v: 1, agentLog: victim.agentLog, boot: realReader.boot,
    owner: identity(process.pid), registrar: identity(registrar.pid), token: randomBytes(16).toString("hex") }));
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
  const gone = Bun.spawn(["/bin/sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const goneIdentity = identity(gone.pid);
  gone.kill();
  await gone.exited;
  await writeRegistration(dead, goneIdentity);
  // Reused: the PID is alive but names another process (other birth).
  const reused = await launchDir(home, "reused");
  await writeRegistration(reused, { pid: sleeper().pid, birth: "1000000000:1" });
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

darwinTest("attach starts a new daemon after a stream failure and the new one re-adopts every live root", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const daemons: Promise<number>[] = [];
  const startCollector = (lockFd: number) => { daemons.push(startDaemon(home, stream, lockFd)); };
  const a = await launchDir(home, "a");
  const attached = attachSandboxLaunch({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, startCollector, pollMs: 50 });
  await until(() => Bun.file(join(a.dir, "ready")).exists());
  const root = sleeper();
  await registerRoot(a, root.pid);
  await until(() => Bun.file(join(a.dir, "root-ready")).exists());
  // B's registrar never notices a restart; the new daemon must adopt it anyway.
  const b = await launchDir(home, "b");
  const registrarB = sleeper();
  await register(home, b, registrarB.pid);
  await until(() => Bun.file(join(b.dir, "ready")).exists());
  const rootB = sleeper();
  await registerRoot(b, rootB.pid);
  await until(() => Bun.file(join(b.dir, "root-ready")).exists());

  // The stream dies: the daemon reports it and exits without `done`.
  await writeFile(stream.exitFile, "");
  expect(await daemons[0]).toBe(1);
  await rm(stream.exitFile);
  await until(async () => (await text(a.agentLog)).includes("shared collector resumed") &&
    (await text(b.agentLog)).includes("shared collector resumed"), 6000);
  const log = await text(a.agentLog);
  expect(log).toContain("shared collector failed: Error: log stream stopped unexpectedly");
  expect(log).toContain("shared collector stopped; starting a new one");
  expect(await text(b.agentLog)).not.toContain("starting a new one");
  expect(daemons.length).toBe(2);

  await Bun.sleep(30);
  await stream.report(root.pid, "file-read-data");
  await stream.report(rootB.pid, "file-write-create");
  await until(async () => (await text(a.agentLog)).includes(`[Sandbox] file-read-data process="sleep" pid=${root.pid} `) &&
    (await text(b.agentLog)).includes(`[Sandbox] file-write-create process="sleep" pid=${rootB.pid} `));
  registrarB.kill();
  await until(() => Bun.file(join(b.dir, "done")).exists());

  // Root exit ends the launch; attach returns once the daemon wrote `done`.
  root.kill();
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
  const code = await attachSandboxLaunch({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, pollMs: 20,
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
  const code = await attachSandboxLaunch({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, pollMs: 20,
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
  const attached = attachSandboxLaunch({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, pollMs: 20,
    startCollector: fd => { starts++; closeSync(fd); } });
  await until(() => existsSync(join(paths.inbox, a.name)));
  writeFileSync(join(a.dir, "ready"), a.name);
  await Bun.sleep(100); // now in the registered loop, the role still held
  writeFileSync(join(a.dir, "failed"), "");
  writeFileSync(join(a.dir, "done"), "rejected");
  const outcome = await Promise.race([attached, Bun.sleep(3000).then(() => "timeout" as const)]);
  if (outcome === "timeout") {
    // Free the role so the attach ends here (it then runs out of starts),
    // not after this test's cleanup removed its directory.
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
  const release = join(home, "release-owner");
  const pidFile = join(home, "attach-pid");
  const exitFile = join(home, "attach-exit");
  const script = join(home, "attach.ts");
  await writeFile(script, `
    import { existsSync, writeFileSync } from "node:fs";
    import { attachSandboxLaunch } from ${MODULE};
    setInterval(() => { if (!existsSync(${JSON.stringify(home)})) process.exit(9); }, 100);
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const code = await attachSandboxLaunch({ dir: ${JSON.stringify(a.dir)}, owner: process.ppid,
      agentLog: ${JSON.stringify(a.agentLog)}, home: ${JSON.stringify(home)}, startCollector: () => { process.exit(7); } });
    writeFileSync(${JSON.stringify(exitFile)}, String(code));
    process.exit(code);
  `);
  const owner = Bun.spawn(["/bin/sh", "-c", `"${process.execPath}" '${script}' & while [ ! -f '${release}' ]; do sleep 0.02; done`],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => { await writeFile(release, "").catch(() => {}); await owner.exited; });
  await until(() => existsSync(join(paths.inbox, a.name)), 8000); // registering
  const attachPid = Number(await text(pidFile));
  // Freeze it, so that its next check sees BOTH the owner gone and the
  // rejection, in whichever order it checks them.
  process.kill(attachPid, "SIGSTOP");
  try {
    await writeFile(release, "");
    await owner.exited;
    writeFileSync(join(a.dir, "failed"), "");
    writeFileSync(join(a.dir, "done"), "rejected");
  } finally { process.kill(attachPid, "SIGCONT"); }
  await until(() => existsSync(exitFile), 8000);
  expect(await text(exitFile)).toBe("0");
  expect(await text(a.agentLog)).not.toContain("rejected this launch");
}, 20000);

darwinTest("a successor's re-adopt scan rejects a launch whose owner just exited; its attach returns", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const daemons: Promise<number>[] = [];
  const startCollector = (lockFd: number) => { daemons.push(startDaemon(home, stream, lockFd)); };
  // M: a launch whose owner (this process) stays alive; its attach is fast.
  const m = await launchDir(home, "m");
  const attachedM = attachSandboxLaunch({ dir: m.dir, owner: process.pid, agentLog: m.agentLog, home, startCollector, pollMs: 20 });
  await until(() => Bun.file(join(m.dir, "ready")).exists());
  await registerRoot(m, sleeper().pid);
  await until(() => Bun.file(join(m.dir, "root-ready")).exists());
  // L: its attach runs under a disposable owner shell, so the owner can exit
  // while the attach lives on. It ends by itself if the temp home disappears.
  const l = await launchDir(home, "l");
  const release = join(home, "release-owner");
  const exitFile = join(home, "l-exit");
  const script = join(home, "attach-l.ts");
  await writeFile(script, `
    import { appendFileSync, closeSync, existsSync, writeFileSync } from "node:fs";
    import { attachSandboxLaunch } from ${MODULE};
    setInterval(() => { if (!existsSync(${JSON.stringify(home)})) process.exit(9); }, 100);
    const code = await attachSandboxLaunch({ dir: ${JSON.stringify(l.dir)}, owner: process.ppid,
      agentLog: ${JSON.stringify(l.agentLog)}, home: ${JSON.stringify(home)},
      startCollector: fd => { appendFileSync(${JSON.stringify(join(home, "l-starts"))}, "x"); closeSync(fd); } });
    writeFileSync(${JSON.stringify(exitFile)}, String(code));
    process.exit(code);
  `);
  const owner = Bun.spawn(["/bin/sh", "-c", `"${process.execPath}" '${script}' & while [ ! -f '${release}' ]; do sleep 0.02; done`],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => { await writeFile(release, "").catch(() => {}); await owner.exited; });
  await until(() => Bun.file(join(l.dir, "ready")).exists(), 8000);
  // L's owner exits, and the daemon is replaced before it finishes L (1 s drain).
  await writeFile(release, "");
  await owner.exited;
  expect(restartSandboxCollector(home)).toBe(true);
  expect(await daemons[0]).toBe(0);
  // M's attach starts the successor; its scan adopts M and rejects L. (If L's
  // slower poll wins the freed lock first, L returns 0 through the free-lock
  // path and the successor rejects it afterwards, so wait for each result.)
  await until(() => existsSync(exitFile), 8000);
  expect(await text(exitFile)).toBe("0"); // the owner is gone: L ends quietly
  await until(async () => (await text(join(l.dir, "done"))) === "rejected", 8000);
  expect(existsSync(join(l.dir, "failed"))).toBe(true);
  await until(async () => (await text(paths.log)).includes(`launch ${l.name} not adopted: Error: launch owner is not running`), 8000);
  expect(existsSync(join(home, "l-starts"))).toBe(false);
  await until(async () => (await text(m.agentLog)).includes("shared collector resumed"), 8000);
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
    const attached = attachSandboxLaunch({ dir: launch.dir, owner: process.pid, agentLog: launch.agentLog, home, startCollector, pollMs: 50 });
    await until(() => Bun.file(join(launch.dir, "ready")).exists());
    await registerRoot(launch, sleeper().pid);
    await until(() => Bun.file(join(launch.dir, "root-ready")).exists());
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
    expect(await text(launch.agentLog)).toContain("collection stopping before the registered CLI exits");
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
  await until(async () => {
    for (const { launch } of launches) if (!(await text(launch.agentLog)).includes("shared collector resumed")) return false;
    return true;
  }, 6000);
  expect(daemons.length).toBe(2);
  for (const { launch } of launches) {
    expect(await text(launch.agentLog)).toContain("shared collector restarting on request");
    expect(existsSync(join(launch.dir, "done"))).toBe(false);
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
    process.exit(await serveSandboxCollector({ home: ${JSON.stringify(home)}, lockFd: 3, sandboxed: () => false,
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
  const attached = attachSandboxLaunch({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, startCollector, pollMs: 50 });
  await until(() => Bun.file(join(a.dir, "ready")).exists(), 8000);
  await registerRoot(a, sleeper().pid);
  await until(() => Bun.file(join(a.dir, "root-ready")).exists());
  children[0]!.kill("SIGTERM");
  expect(await children[0]!.exited).toBe(0);
  expect(existsSync(join(a.dir, "done"))).toBe(false);
  await until(async () => (await text(a.agentLog)).includes("shared collector resumed"), 8000);
  expect(children.length).toBe(2);
  expect(await text(a.agentLog)).toContain("shared collector restarting on request");
  await writeFile(join(a.dir, "stop"), "stop\n");
  expect(await attached).toBe(0);
  expect(await children[1]!.exited).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 30000);
