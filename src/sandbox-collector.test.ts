import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, appendFile } from "node:fs/promises";
import { closeSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { attachSandboxLaunch, holdCollectorClient, sandboxCollectorPaths, sandboxCollectorRunning, serveSandboxCollector,
  tryCollectorLock, validateRegistration, type CollectorReader } from "./sandbox-collector";
import { sandboxLogParent } from "./sandbox-log-paths";
import type { ProcessObservation } from "./sandbox-denials";

const darwinTest = process.platform === "darwin" ? test : test.skip;
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

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "sandbox-collector-test-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** The same artifacts the launch preamble creates, in a private namespace. */
async function launchDir(home: string, agent: string): Promise<{ agentDir: string; agentLog: string; dir: string; name: string }> {
  const agentDir = join(home, "agents", agent);
  await mkdir(agentDir, { recursive: true });
  const parent = sandboxLogParent(agentDir, home);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(parent, "sandbox-log."));
  await chmod(dir, 0o700);
  await writeFile(join(dir, "stop"), "");
  return { agentDir, agentLog: join(agentDir, "agent.log"), dir, name: dir.split("/").pop()! };
}

function observation(pid: number, ppid: number, birth = `1700000000:${pid}`): ProcessObservation {
  return { pid, ppid, birth, before: 1n, after: 1n };
}

function fakeReader(processes: ProcessObservation[], sandboxed: number[] = []): CollectorReader {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  return { read: pid => byPid.get(pid) ?? null, sandboxed: pid => sandboxed.includes(pid) };
}

async function registration(dir: string, fields: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "registration.json"), JSON.stringify({ v: 1, token: randomBytes(16).toString("hex"), ...fields }));
}

test("validateRegistration accepts a private launch from a registrar that descends from the owner", async () => {
  const home = await tempHome();
  const launch = await launchDir(home, "a");
  await registration(launch.dir, { agentLog: launch.agentLog, owner: 100, registrar: 300 });
  const reader = fakeReader([observation(100, 1), observation(200, 100), observation(300, 200)]);
  const accepted = validateRegistration(launch.name, `${launch.dir}\n`, reader, home);
  expect(accepted.dir).toBe(launch.dir);
  expect(accepted.agentLog).toBe(launch.agentLog);
  expect(accepted.owner.pid).toBe(100);
  expect([...accepted.registrarAncestors].sort()).toEqual([200, 300]);
});

test("validateRegistration rejects forged, redirected, unprivate and unproven registrations", async () => {
  const home = await tempHome();
  const launch = await launchDir(home, "a");
  const other = await launchDir(home, "b");
  const tree = [observation(100, 1), observation(200, 100), observation(300, 200), observation(400, 1)];
  const reject = async (fields: Record<string, unknown>, expected: string, opts: { name?: string; entry?: string; reader?: CollectorReader } = {}) => {
    await registration(launch.dir, { agentLog: launch.agentLog, owner: 100, registrar: 300, ...fields });
    expect(() => validateRegistration(opts.name ?? launch.name, opts.entry ?? launch.dir, opts.reader ?? fakeReader(tree), home)).toThrow(expected);
  };
  await reject({}, "invalid registration name", { name: "../sandbox-log.x" });
  await reject({}, "outside the sealed launch namespace", { entry: join(home, "elsewhere", launch.name) });
  await reject({}, "outside the sealed launch namespace", { name: other.name, entry: launch.dir });
  await reject({ agentLog: other.agentLog }, "agent log is not bound");
  await reject({ v: 2 }, "unsupported registration protocol");
  await reject({ token: "short" }, "malformed registration");
  await reject({ registrar: 999 }, "not running");
  await reject({ registrar: 400 }, "not an ancestor");
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
  const { openSandboxProcessReader } = await import("./sandbox-processes");
  const clock = openSandboxProcessReader();
  cleanups.push(async () => clock.close());
  return {
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

async function register(home: string, launch: { dir: string; name: string; agentLog: string }, registrar: number): Promise<string> {
  const token = randomBytes(16).toString("hex");
  await writeFile(join(launch.dir, "registration.json"), JSON.stringify({ v: 1, agentLog: launch.agentLog, owner: process.pid, registrar, token }));
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

darwinTest("one daemon serves two launches and routes each report to its own launch only", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  const served = serveSandboxCollector({ home, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker, sandboxed: () => false });
  cleanups.push(async () => { await writeFile(paths.stop, "stop\n").catch(() => {}); await served; });
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
  await writeFile(join(a.dir, "root-request"), `${rootA.pid}\n`);
  await writeFile(join(b.dir, "root-request"), `${rootB.pid}\n`);
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
  await writeFile(join(c.dir, "root-request"), `${rootA.pid}\n`);
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
  await until(() => Bun.file(join(c.dir, "done")).exists());
  await Bun.sleep(100);
  expect(sandboxCollectorRunning(paths)).toBe(true);
  // The last client lock goes: exit and give up the role.
  registrars.release();
  expect(await served).toBe(0);
  expect(sandboxCollectorRunning(paths)).toBe(false);
}, 20000);

darwinTest("the daemon rejects a registration redirected to another agent's log", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const registrars = await client(home);
  const served = serveSandboxCollector({ home, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker, sandboxed: () => false });
  cleanups.push(async () => { await writeFile(paths.stop, "stop\n").catch(() => {}); await served; });
  const a = await launchDir(home, "a");
  const victim = await launchDir(home, "victim");
  const registrar = sleeper();
  await writeFile(join(a.dir, "registration.json"), JSON.stringify({ v: 1, agentLog: victim.agentLog, owner: process.pid, registrar: registrar.pid, token: randomBytes(16).toString("hex") }));
  await writeFile(join(paths.inbox, a.name), a.dir);
  await until(async () => (await text(paths.log)).includes(`registration ${a.name} rejected: Error: agent log is not bound`));
  // The registrar hears it through its own private directory only.
  expect(await Bun.file(join(a.dir, "failed")).exists()).toBe(true);
  expect(await Bun.file(join(a.dir, "ready")).exists()).toBe(false);
  expect(await Bun.file(victim.agentLog).exists()).toBe(false);
  registrars.release();
  expect(await served).toBe(0);
}, 20000);

darwinTest("attach restarts a failed daemon and the new one re-adopts the live root", async () => {
  const home = await tempHome();
  const stream = await fakeStream(home);
  const paths = sandboxCollectorPaths(home);
  const daemons: Promise<number>[] = [];
  // In-process daemon: it takes ownership of the fd the attach won.
  const startCollector = (lockFd: number) => {
    daemons.push(serveSandboxCollector({ home, lockFd, spawnStream: stream.spawnStream, emitMarker: stream.emitMarker, sandboxed: () => false }));
  };
  cleanups.push(async () => { await writeFile(paths.stop, "stop\n").catch(() => {}); await Promise.all(daemons); });
  const a = await launchDir(home, "a");
  const attached = attachSandboxLaunch({ dir: a.dir, owner: process.pid, agentLog: a.agentLog, home, startCollector });
  await until(() => Bun.file(join(a.dir, "ready")).exists());
  const root = sleeper();
  await writeFile(join(a.dir, "root-request"), `${root.pid}\n`);
  await until(() => Bun.file(join(a.dir, "root-ready")).exists());
  // B's registrar never notices a restart; the new daemon must adopt it anyway.
  const b = await launchDir(home, "b");
  const registrarB = sleeper();
  await register(home, b, registrarB.pid);
  await until(() => Bun.file(join(b.dir, "ready")).exists());
  const rootB = sleeper();
  await writeFile(join(b.dir, "root-request"), `${rootB.pid}\n`);
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

  // The re-adopted roots are attributed by the new daemon.
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
