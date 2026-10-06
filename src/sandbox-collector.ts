/** One unsandboxed collector per user owns ONE `log stream` for every sandboxed
 * launch (docs/SANDBOX-SHARED-COLLECTOR.md). Launches register only through the
 * sealed tree, which the shipped floor denies to every sandboxed agent. Per-launch
 * attribution is unchanged (sandbox-denials.ts, sandbox-process-tree.ts).
 *
 * `serve`  — the daemon: the stream and every launch's state.
 * `attach` — one per launch, run by the start.sh/resume.sh supervisor subshell:
 *            registers the launch, waits for the daemon's acknowledgement, and
 *            starts a daemon whenever none is running while the launch is alive.
 *
 * Lifecycle is decided by kernel flocks, never by elapsed time:
 * - `daemon.lock` LOCK_EX is the daemon role. Whoever takes it is the one
 *   process that may run a daemon; an attach that wins it hands the locked fd to
 *   the daemon it spawns (fd 3), so the role never has a free gap. The kernel
 *   frees it on any exit, SIGKILL included: a free lock means no daemon.
 * - `clients.lock` LOCK_SH is held by every attach for its whole life. The daemon
 *   exits only once it can take LOCK_EX there (no attach alive) with no launch
 *   left, and gives up `daemon.lock` while still holding it, so no attach can
 *   register with a daemon that is exiting.
 */
import { dlopen, FFIType } from "bun:ffi";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { sealDir } from "./agent-seal";
import { SandboxAttribution, SandboxLogFramer, SandboxOutputBudget, formatSandboxRecord,
  parseSandboxReport, processIdentity, type ProcessObservation, type SandboxReport } from "./sandbox-denials";
import { sandboxLogParent } from "./sandbox-log-paths";
import { closeSandboxLogStream, sandboxStreamExited } from "./sandbox-log-stream";
import { sampleSandboxTree } from "./sandbox-process-tree";
import { openSandboxProcessReader } from "./sandbox-processes";

const LAUNCH_NAME = /^sandbox-log\.[a-zA-Z0-9]+$/;
const PROTOCOL = 1;
/** Daemon starts one attach may make (first start + restarts): a daemon that
 * dies at once on every start must not turn into a spawn loop. */
const MAX_STARTS = 4;
const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4;

export interface SandboxCollectorPaths {
  root: string; daemonLock: string; clientsLock: string; inbox: string; heartbeat: string; log: string; stop: string;
}

export function sandboxCollectorPaths(home?: string): SandboxCollectorPaths {
  const root = join(sealDir(home), "sandbox-collector");
  return { root, daemonLock: join(root, "daemon.lock"), clientsLock: join(root, "clients.lock"), inbox: join(root, "inbox"),
    heartbeat: join(root, "heartbeat.json"), log: join(root, "collector.log"), stop: join(root, "stop") };
}

function ensureCollectorDirs(paths: SandboxCollectorPaths): void {
  mkdirSync(paths.inbox, { recursive: true, mode: 0o700 });
  chmodSync(paths.root, 0o700);
  chmodSync(paths.inbox, 0o700);
}

let flockSymbol: ((fd: number, operation: number) => number) | undefined;
function flock(fd: number, operation: number): number {
  if (!flockSymbol) {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flockSymbol = (f, o) => lib.symbols.flock(f, o);
  }
  return flockSymbol(fd, operation);
}

const openLockFile = (path: string) => openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);

/** Take a flock without waiting, or null while a conflicting holder exists.
 * The kernel drops a flock on every kind of exit, SIGKILL included, so a dead
 * holder never leaves a stale lock and nothing needs a saved PID. */
export function tryCollectorLock(path: string, operation = LOCK_EX): number | null {
  const fd = openLockFile(path);
  if (flock(fd, operation | LOCK_NB) === 0) return fd;
  closeSync(fd);
  return null;
}

/** An attach's shared client lock, held for its whole life. It waits only while
 * an exiting daemon holds LOCK_EX, which it does across two close() calls. */
export function holdCollectorClient(paths: SandboxCollectorPaths): number {
  const fd = openLockFile(paths.clientsLock);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (flock(fd, LOCK_SH) === 0) return fd; // blocking; non-zero is EINTR or an error
  }
  closeSync(fd);
  throw new Error("cannot take the shared collector client lock");
}

export function sandboxCollectorRunning(paths: SandboxCollectorPaths): boolean {
  try {
    // A shared probe conflicts with the daemon's LOCK_EX but never wins the role.
    const fd = tryCollectorLock(paths.daemonLock, LOCK_SH);
    if (fd === null) return true;
    closeSync(fd);
  } catch { /* no lock file or directory: nothing is running */ }
  return false;
}

/** The agent can write its own directory: never follow a final symlink, never
 * block on a FIFO, and write only to a regular file. */
export function appendAgentLog(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("agent log is not a regular file");
    writeSync(fd, text);
  } finally { closeSync(fd); }
}

function collectorLine(level: string, launch: string, message: string): string {
  return `[${new Date().toISOString()}] [SandboxCollector] ${level}: launch=${launch} ${message.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}\n`;
}

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function readPrivateFile(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`${basename(path)} is not a small regular file`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export interface CollectorReader {
  read(pid: number): ProcessObservation | null;
  sandboxed(pid: number): boolean;
}

export interface AcceptedRegistration {
  name: string;
  dir: string;
  agentLog: string;
  token: string;
  owner: ProcessObservation;
  registrar: ProcessObservation;
  /** The registrar and its ancestors below the owner; a CLI root may not be one. */
  registrarAncestors: Set<number>;
}

const isPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

/** A private directory of this user in the sealed launch namespace; only such a
 * directory is ever written to (including `failed` for a rejected launch). */
export function checkLaunchDirectory(entryName: string, entryText: string, home?: string): string {
  if (!LAUNCH_NAME.test(entryName)) throw new Error("invalid registration name");
  const dir = entryText.trim();
  if (!isAbsolute(dir) || basename(dir) !== entryName || dirname(dirname(dir)) !== join(sealDir(home), "sandbox-logs") ||
      !/^[0-9a-f]{64}$/.test(basename(dirname(dir)))) throw new Error("registration is outside the sealed launch namespace");
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("launch directory is not a private directory of this user");
  }
  return dir;
}

/** Accept a registration only from a private launch directory in the sealed
 * namespace, naming the agent.log bound to that namespace, from a live and
 * unsandboxed registrar that descends from the unsandboxed launch owner. */
export function validateRegistration(entryName: string, entryText: string, reader: CollectorReader, home?: string): AcceptedRegistration {
  const dir = checkLaunchDirectory(entryName, entryText, home);
  const registration = JSON.parse(readPrivateFile(join(dir, "registration.json"), 8192));
  if (registration?.v !== PROTOCOL) throw new Error(`unsupported registration protocol ${String(registration?.v)}`);
  const { agentLog, owner, registrar, token } = registration;
  // Unchanged rule: a launch directory may only name the agent.log of the agent
  // directory whose hash names its namespace.
  if (typeof agentLog !== "string" || !isAbsolute(agentLog) || sandboxLogParent(dirname(agentLog), home) !== dirname(dir)) {
    throw new Error("agent log is not bound to this launch namespace");
  }
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token) || !isPid(owner) || !isPid(registrar)) {
    throw new Error("malformed registration");
  }
  const ownerProcess = reader.read(owner);
  const registrarProcess = reader.read(registrar);
  if (!ownerProcess || !registrarProcess) throw new Error("launch owner or registrar is not running");
  // The per-launch collector proved the owner was ITS ancestor. The shared
  // daemon is nobody's descendant, so prove it of the live registrar instead.
  const registrarAncestors = new Set<number>();
  let ancestor: ProcessObservation | null = registrarProcess;
  for (let depth = 0; ancestor && depth < 64 && ancestor.pid !== owner; depth++) {
    registrarAncestors.add(ancestor.pid);
    ancestor = reader.read(ancestor.ppid);
  }
  if (!ancestor || processIdentity(ancestor) !== processIdentity(ownerProcess)) {
    throw new Error("launch owner is not an ancestor of the registrar");
  }
  if (reader.sandboxed(owner) || reader.sandboxed(registrar)) throw new Error("launch owner or registrar is sandboxed");
  return { name: entryName, dir, agentLog, token, owner: ownerProcess, registrar: registrarProcess, registrarAncestors };
}

interface Launch extends AcceptedRegistration {
  stopFd: number;
  marker: string;
  markerSeen: boolean;
  markerNext: number;
  markerDeadline: number;
  ready: boolean;
  /** A re-registration after a daemon restart: its root may already exist. */
  resumed: boolean;
  attribution?: SandboxAttribution;
  active: ProcessObservation[];
  budget: SandboxOutputBudget;
  overflow: number;
  ambiguous: number;
  lastSummary: number;
  stopAt?: number;
}

export interface ServeOptions {
  home?: string;
  /** An fd already holding `daemon.lock` LOCK_EX, handed over by the attach
   * that won the role. Without it, serve tries the lock once and defers to a
   * running daemon. */
  lockFd?: number;
  /** Test seams: the stream helper, the readiness-marker emitter, and the
   * kernel sandbox check (a test suite may itself run inside a sandbox). */
  spawnStream?: (predicate: string) => Bun.Subprocess<"pipe", "pipe", "pipe">;
  emitMarker?: (marker: string) => void;
  sandboxed?: (pid: number) => boolean;
}

const sameProcess = (current: ProcessObservation | null | undefined, expected: ProcessObservation) =>
  !!current && processIdentity(current) === processIdentity(expected);

/** The daemon. No watchdog, dashboard or pane owns it; launches restart it. */
export async function serveSandboxCollector(opts: ServeOptions = {}): Promise<number> {
  const paths = sandboxCollectorPaths(opts.home);
  ensureCollectorDirs(paths);
  let lockFd: number | null;
  if (opts.lockFd !== undefined) {
    // Re-locking through the inherited open file description succeeds only if
    // the handed-over fd really holds the role.
    if (flock(opts.lockFd, LOCK_EX | LOCK_NB) !== 0) return 1;
    lockFd = opts.lockFd;
  } else {
    lockFd = tryCollectorLock(paths.daemonLock);
    if (lockFd === null) return 0; // another daemon already serves this user
  }
  const note = (message: string) => {
    try { appendAgentLog(paths.log, `[${new Date().toISOString()}] pid=${process.pid} ${message.replace(/[\r\n]/g, " ")}\n`); } catch { /* best effort */ }
  };
  const status = (launch: Launch, level: string, message: string) => {
    const line = collectorLine(level, launch.name, message);
    try { appendAgentLog(launch.agentLog, line); } catch { note(`agent.log unwritable: ${line.trim()}`); }
  };
  try { if (statSync(paths.log).size > 1024 * 1024) writeFileSync(paths.log, ""); } catch { /* no log yet */ }
  try { unlinkSync(paths.stop); } catch { /* a stale stop must not end this instance */ }
  const nonce = randomBytes(16).toString("hex");
  const markerPrefix = `IBSandboxReady-${nonce}`;
  const emitMarker = opts.emitMarker ?? ((marker: string) => {
    const child = Bun.spawn(["/usr/bin/logger", "-t", "itsybitsy-sandbox", marker], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 500);
    void child.exited.then(() => clearTimeout(timer));
  });
  const launches = new Map<string, Launch>();
  const roots = new Map<string, string>(); // root identity -> launch name
  let reader: ReturnType<typeof openSandboxProcessReader> | undefined;
  let stream: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let outputReader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  let errorReader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  let pumping: Promise<void> | undefined;
  let errors: Promise<void> | undefined;
  let stderr = "";
  let failed: unknown;
  let stopping = false;
  const stop = () => { stopping = true; };
  const hup = () => {};
  process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", hup);
  const drop = (launch: Launch) => {
    try { closeSync(launch.stopFd); } catch { /* already closed */ }
    launches.delete(launch.name);
    if (launch.attribution) roots.delete(processIdentity(launch.attribution.root));
  };
  const summary = (launch: Launch) => {
    if (launch.budget.suppressed || launch.overflow || launch.ambiguous) {
      status(launch, "WARNING", `output suppressed=${launch.budget.suppressed}; system stream queue overflow=${launch.overflow}; ambiguous reports omitted=${launch.ambiguous}; coverage reduced`);
    }
    launch.budget.suppressed = 0; launch.overflow = 0; launch.ambiguous = 0;
  };
  const finish = (launch: Launch) => {
    summary(launch);
    status(launch, "INFO", "collector stopped");
    try { writeFileSync(join(launch.dir, "done"), launch.token); } catch { /* supervisor already removed it */ }
    drop(launch);
  };
  const fail = (launch: Launch, error: unknown) => {
    status(launch, "ERROR", `${String(error)}; kernel enforcement remains required`);
    try { writeFileSync(join(launch.dir, "failed"), ""); } catch { /* removed */ }
    try { writeFileSync(join(launch.dir, "done"), launch.token); } catch { /* removed */ }
    drop(launch);
  };
  try {
    reader = openSandboxProcessReader();
    const predicate = `(subsystem == "com.apple.sandbox.reporting" AND category == "violation") OR (eventMessage CONTAINS "Sandbox:") OR (eventMessage CONTAINS "${markerPrefix}")`;
    stream = opts.spawnStream?.(predicate) ?? Bun.spawn(["ib", "sandbox-log-stream", "--predicate", predicate],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    outputReader = stream.stdout.getReader();
    errorReader = stream.stderr.getReader();
    const framer = new SandboxLogFramer();
    const pending: { report: SandboxReport; received: number }[] = [];
    pumping = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await outputReader!.read();
        if (chunk.done) break;
        for (const line of framer.push(decoder.decode(chunk.value, { stream: true }))) {
          if (line.includes(markerPrefix)) {
            try {
              const event = JSON.parse(line);
              if (typeof event.eventMessage === "string" && event.processImagePath === "/usr/bin/logger") {
                for (const launch of launches.values()) if (event.eventMessage.includes(launch.marker)) launch.markerSeen = true;
              }
            } catch { /* log stream's non-JSON banner is not an event */ }
          }
          const report = parseSandboxReport(line, reader!.boot, { liveStream: true,
            onAmbiguous: () => { for (const launch of launches.values()) launch.ambiguous++; } });
          if (report) {
            if (pending.length < 512) pending.push({ report, received: performance.now() });
            else for (const launch of launches.values()) launch.overflow++;
          }
        }
      }
    })().catch(error => { failed = error; });
    errors = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await errorReader!.read();
        if (chunk.done) break;
        if (stderr.length < 4096) stderr += decoder.decode(chunk.value).slice(0, 4096 - stderr.length);
      }
    })().catch(error => { failed = error; });
    note(`collector started; nonce=${nonce.slice(0, 8)}`);

    const admit = (name: string, dirText: string, now: number): void => {
      const existing = launches.get(name);
      if (existing) {
        if (existing.dir !== dirText.trim()) throw new Error("launch name already registered");
        // A registrar re-registers after removing `ready`: acknowledge again.
        if (existing.ready) writeFileSync(join(existing.dir, "ready"), existing.name);
        return;
      }
      let accepted: AcceptedRegistration;
      try {
        accepted = validateRegistration(name, dirText,
          { read: pid => reader!.read(pid), sandboxed: opts.sandboxed ?? (pid => reader!.sandboxed(pid)) }, opts.home);
      } catch (error) {
        // Tell the registrar through its own private directory, never through
        // the unverified agent.log path.
        try { writeFileSync(join(checkLaunchDirectory(name, dirText, opts.home), "failed"), ""); } catch { /* not ours to mark */ }
        throw error;
      }
      const stopFd = openSync(join(accepted.dir, "stop"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      launches.set(name, { ...accepted, stopFd, marker: `${markerPrefix} ${name} ready`, markerSeen: false,
        markerNext: now, markerDeadline: now + 3000, ready: false,
        resumed: existsSync(join(accepted.dir, "root-request")),
        active: [], budget: new SandboxOutputBudget(), overflow: 0, ambiguous: 0, lastSummary: now });
    };
    const accept = (now: number) => {
      let names: string[];
      try { names = readdirSync(paths.inbox); } catch { return; }
      for (const name of names) {
        if (name.endsWith(".tmp")) continue;
        const entry = join(paths.inbox, name);
        try {
          const text = readPrivateFile(entry, 4096);
          try { unlinkSync(entry); } catch { /* at most once: never act on an entry twice */ }
          admit(name, text, now);
          note(`registration ${name} accepted`);
        } catch (error) {
          // An unverified registration's agent.log path is not trusted.
          try { unlinkSync(entry); } catch { /* already removed */ }
          note(`registration ${name} rejected: ${String(error)}`);
        }
      }
    };
    // Re-adopt every live launch at startup, so a restart does not depend on
    // each registrar noticing the gap (another one may restart us first).
    const logsRoot = join(sealDir(opts.home), "sandbox-logs");
    const list = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
    for (const namespace of list(logsRoot)) {
      if (!/^[0-9a-f]{64}$/.test(namespace)) continue;
      for (const name of list(join(logsRoot, namespace))) {
        const dir = join(logsRoot, namespace, name);
        if (!LAUNCH_NAME.test(name) || !existsSync(join(dir, "registration.json")) || existsSync(join(dir, "done"))) continue;
        try {
          admit(name, dir, performance.now());
          note(`launch ${name} re-adopted`);
        } catch (error) { note(`launch ${name} not adopted: ${String(error)}`); }
      }
    }

    const tick = (launch: Launch, now: number) => {
      const currentRoot = launch.attribution && reader!.read(launch.attribution.root.pid);
      const rootAlive = !!launch.attribution && sameProcess(currentRoot, launch.attribution.root);
      if (stopping || fstatSync(launch.stopFd).size > 0 || !sameProcess(reader!.read(launch.owner.pid), launch.owner) ||
          !sameProcess(reader!.read(launch.registrar.pid), launch.registrar)) {
        if (launch.stopAt === undefined && rootAlive) status(launch, "WARNING", "collection stopping before the registered CLI exits; coverage reduced");
        launch.stopAt ??= now + 1000;
      }
      if (launch.attribution && !rootAlive) launch.stopAt ??= now + 1000;
      if (launch.stopAt !== undefined && now >= launch.stopAt) { finish(launch); return; }
      if (!launch.ready) {
        if (launch.markerSeen) {
          writeFileSync(join(launch.dir, "ready"), launch.name);
          launch.ready = true;
          if (launch.resumed) status(launch, "WARNING", "shared collector resumed; reports while it was down were not collected; coverage reduced");
          else status(launch, "INFO", "stream ready; coverage limited to verified observed process lifetimes; unknown and OS-coalesced reports omitted");
        } else if (now >= launch.markerDeadline) {
          throw new Error("log stream readiness marker was not observed within 3 seconds");
        } else {
          if (now >= launch.markerNext) { emitMarker(launch.marker); launch.markerNext = now + 100; }
          return;
        }
      }
      if (!launch.attribution && launch.stopAt === undefined && existsSync(join(launch.dir, "root-request"))) {
        const pidText = readPrivateFile(join(launch.dir, "root-request"), 64).trim();
        const root = /^[1-9]\d{0,9}$/.test(pidText) ? reader!.read(Number(pidText)) : null;
        // The gate is a direct child of start.sh/resume.sh (setsid execs it).
        if (!root || root.ppid !== launch.owner.pid || launch.registrarAncestors.has(root.pid)) {
          throw new Error("CLI root registration could not verify launch ancestry");
        }
        if (roots.has(processIdentity(root))) throw new Error("CLI root is already registered by another launch");
        roots.set(processIdentity(root), launch.name);
        launch.attribution = new SandboxAttribution(root);
        launch.attribution.observe([root], now);
        launch.active = [root];
        writeFileSync(join(launch.dir, "root-ready"), launch.name);
      }
      if (launch.attribution) {
        const samples = sampleSandboxTree(reader!, launch.attribution.root, launch.active, currentRoot);
        launch.attribution.observe(samples, now);
        launch.active = samples;
      }
      if (now - launch.lastSummary >= 60000) { summary(launch); launch.lastSummary = now; }
    };

    let lastBeat = -Infinity; // performance.now() starts near 0: beat at once
    while (true) {
      const now = performance.now();
      if (!stopping && existsSync(paths.stop)) {
        stopping = true;
        try { unlinkSync(paths.stop); } catch { /* removed */ }
        note("stop requested");
      }
      if (sandboxStreamExited(stream) || failed) {
        throw new Error(`log stream stopped unexpectedly (exit=${stream.exitCode}, signal=${stream.signalCode}): ${(stderr || String(failed ?? "no output")).trim()}`);
      }
      if (!stopping) accept(now);
      for (const launch of [...launches.values()]) {
        try { tick(launch, now); } catch (error) { fail(launch, error); }
      }
      const attributing = [...launches.values()].filter(launch => launch.attribution);
      if (attributing.length === 0) pending.length = 0; // nobody registered: all reports are unrelated
      for (let index = 0; index < pending.length;) {
        const item = pending[index]!;
        const matches: { launch: Launch; identity: ProcessObservation }[] = [];
        for (const launch of attributing) {
          if (!launches.has(launch.name)) continue; // failed earlier in this tick
          const identity = launch.attribution!.attribute(item.report);
          if (identity) matches.push({ launch, identity });
        }
        if (matches.length === 1) {
          const { launch, identity } = matches[0]!;
          if (launch.budget.accept(item.report, identity, now)) {
            try { appendAgentLog(launch.agentLog, `${formatSandboxRecord(item.report, identity, launch.name)}\n`); }
            catch (error) { fail(launch, error); }
          }
          pending.splice(index, 1);
        } else if (matches.length > 1) {
          // Two launches claim one process instance: never guess between them.
          for (const { launch } of matches) launch.ambiguous++;
          pending.splice(index, 1);
        } else if (now - item.received > 500) pending.splice(index, 1);
        else index++;
      }
      if (now - lastBeat >= 1000) {
        try {
          writeAtomic(paths.heartbeat, JSON.stringify({ v: PROTOCOL, pid: process.pid, nonce: nonce.slice(0, 8),
            updatedAt: Date.now(), launches: launches.size }));
        } catch (error) { note(`heartbeat failed: ${String(error)}`); }
        lastBeat = now;
      }
      if (launches.size === 0) {
        if (stopping) break;
        let waiting = 1;
        try { waiting = readdirSync(paths.inbox).filter(name => !name.endsWith(".tmp")).length; } catch { /* keep serving */ }
        // Every attach holds clients.lock shared for its whole life, so LOCK_EX
        // here means no launch can still need us. Give up the role while we
        // hold it: an attach that waits for its shared lock then finds no daemon
        // and starts a new one, instead of registering with this one.
        const clients = waiting === 0 ? tryCollectorLock(paths.clientsLock, LOCK_EX) : null;
        if (clients !== null) {
          closeSync(lockFd);
          lockFd = null;
          closeSync(clients);
          break;
        }
      }
      await Bun.sleep(20);
    }
    note(stopping ? "collector stopped on request" : "no launches and no registrars left; exiting");
    return 0;
  } catch (error) {
    note(`ERROR: ${String(error)}`);
    // No `done`: each launch's registrar sees the lock free and restarts us.
    for (const launch of [...launches.values()]) {
      status(launch, "ERROR", `shared collector failed: ${String(error)}; kernel enforcement remains required`);
      drop(launch);
    }
    // Give up the role now, not after the stream teardown below.
    if (lockFd !== null) { closeSync(lockFd); lockFd = null; }
    return 1;
  } finally {
    if (stream) await closeSandboxLogStream(stream, [outputReader, errorReader]);
    await pumping; await errors;
    outputReader?.releaseLock(); errorReader?.releaseLock();
    for (const launch of [...launches.values()]) drop(launch);
    reader?.close();
    try {
      if (JSON.parse(readFileSync(paths.heartbeat, "utf8")).pid === process.pid) unlinkSync(paths.heartbeat);
    } catch { /* none */ }
    process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", hup);
    if (lockFd !== null) closeSync(lockFd); // gives up the daemon role
  }
}

/** Start the daemon outside any pane session, with none of the launch's state.
 * Takes ownership of `lockFd` (the won daemon role): the child inherits it as
 * fd 3 and our copy is closed, so the role passes over without a free gap. */
export function spawnSandboxCollector(paths: SandboxCollectorPaths, lockFd: number): void {
  const env = { ...process.env };
  for (const key of ["AGENT_LOG", "IB_SANDBOX_LOG_DIR", "IB_SANDBOX_LOG_AGENT_LOG", "IB_SANDBOX_LOG_STOP_OPEN"]) delete env[key];
  let logFd: number | undefined;
  try {
    logFd = openSync(paths.log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    Bun.spawn(["ib", "sandbox-collector", "serve", "--lock-fd", "3"],
      { cwd: "/", env, stdio: ["ignore", "ignore", logFd, lockFd], detached: true }).unref();
  } finally {
    if (logFd !== undefined) closeSync(logFd);
    closeSync(lockFd);
  }
}

export interface AttachOptions {
  dir: string;
  owner: number;
  agentLog: string;
  home?: string;
  /** Test seam: start a daemon that takes ownership of the won `daemon.lock` fd. */
  startCollector?: (lockFd: number) => void;
}

/** One per launch. The supervisor subshell removes the launch directory after
 * this returns, so the daemon finishes with it (`done`) before we exit. */
export async function attachSandboxLaunch(opts: AttachOptions): Promise<number> {
  const paths = sandboxCollectorPaths(opts.home);
  const launch = basename(opts.dir);
  const status = (level: string, message: string) => {
    const line = collectorLine(level, launch, message);
    try { appendAgentLog(opts.agentLog, line); } catch { process.stderr.write(line); }
  };
  const entry = join(paths.inbox, launch);
  let terminating = false;
  const terminate = () => { terminating = true; };
  const hup = () => {};
  process.on("SIGTERM", terminate); process.on("SIGINT", terminate); process.on("SIGHUP", hup);
  let reader: ReturnType<typeof openSandboxProcessReader> | undefined;
  let clientFd: number | undefined;
  try {
    if (dirname(opts.dir) !== sandboxLogParent(dirname(opts.agentLog), opts.home) || !LAUNCH_NAME.test(launch) ||
        !lstatSync(opts.dir).isDirectory()) throw new Error("invalid launch artifact directory");
    reader = openSandboxProcessReader();
    const owner = reader.read(opts.owner);
    if (!owner) throw new Error("launch owner identity unavailable");
    ensureCollectorDirs(paths);
    // Held for our whole life: while any attach holds it, no daemon exits.
    clientFd = holdCollectorClient(paths);
    const token = randomBytes(16).toString("hex");
    writeAtomic(join(opts.dir, "registration.json"),
      JSON.stringify({ v: PROTOCOL, agentLog: opts.agentLog, owner: opts.owner, registrar: process.pid, token }));
    const startCollector = opts.startCollector ?? ((fd: number) => spawnSandboxCollector(paths, fd));
    const file = (name: string) => join(opts.dir, name);
    const done = () => { try { return readFileSync(file("done"), "utf8") === token; } catch { return false; } };
    const ownerAlive = () => sameProcess(reader!.read(owner.pid), owner);
    let starts = 0;
    /** A free `daemon.lock` means no daemon: winning it makes us the one
     * process that starts the next one. Null: a daemon holds the role. */
    const winDaemonRole = () => tryCollectorLock(paths.daemonLock);
    const start = (fd: number): boolean => {
      if (++starts > MAX_STARTS) { closeSync(fd); return false; }
      startCollector(fd);
      return true;
    };
    /** Register, then wait for the daemon's answer. Nothing here is timed: the
     * daemon answers `ready` or `failed`, a free lock shows it is gone (and we
     * start another), or our own launch ends. */
    const register = async (): Promise<"ready" | "rejected" | "ended" | "exhausted"> => {
      writeAtomic(entry, opts.dir);
      while (true) {
        if (existsSync(file("ready"))) return "ready";
        if (existsSync(file("failed")) || done()) return "rejected";
        if (terminating || !ownerAlive()) return "ended";
        const fd = winDaemonRole();
        if (fd !== null && !start(fd)) return "exhausted";
        await Bun.sleep(50);
      }
    };
    const refused = (answer: "rejected" | "exhausted") => {
      // A daemon that failed this launch has already logged why (and wrote done).
      if (answer === "exhausted") status("ERROR", `shared collector did not stay up after ${MAX_STARTS} starts; kernel enforcement remains required`);
      else if (!done()) status("ERROR", `shared collector rejected this launch (see ${paths.log}); kernel enforcement remains required`);
      return 1;
    };
    let answer = await register();
    if (answer === "ended") return 0;
    if (answer !== "ready") return refused(answer);
    let stopSent = false;
    while (true) {
      if (done()) return 0;
      if (terminating && !stopSent) {
        // The directory stays reserved until we return, so its path is safe.
        try { appendAgentLog(file("stop"), "stop\n"); } catch { /* removed */ }
        stopSent = true;
      }
      const fd = winDaemonRole();
      if (fd !== null) {
        // No daemon. It may have finished us just before it exited.
        if (done() || terminating || !ownerAlive() || statSync(file("stop")).size > 0) { closeSync(fd); return 0; }
        status("WARNING", "shared collector stopped; starting a new one; reports until it is ready are not collected");
        try { unlinkSync(file("ready")); } catch { /* none */ }
        if (!start(fd)) return refused("exhausted");
        answer = await register();
        if (answer === "ended") return 0;
        if (answer !== "ready") return refused(answer);
        continue;
      }
      await Bun.sleep(250);
    }
  } catch (error) {
    status("ERROR", `${String(error)}; kernel enforcement remains required`);
    return 1;
  } finally {
    try { if (readFileSync(entry, "utf8") === opts.dir) unlinkSync(entry); } catch { /* accepted or absent */ }
    if (clientFd !== undefined) closeSync(clientFd);
    reader?.close();
    process.off("SIGTERM", terminate); process.off("SIGINT", terminate); process.off("SIGHUP", hup);
  }
}

export function sandboxCollectorStatus(home?: string): string {
  const paths = sandboxCollectorPaths(home);
  let heartbeat = "none";
  try { heartbeat = readFileSync(paths.heartbeat, "utf8"); } catch { /* none */ }
  return `running: ${sandboxCollectorRunning(paths) ? "yes" : "no"}\nheartbeat: ${heartbeat}\nstate: ${paths.root}`;
}

/** Ask a running daemon to finish every launch (1 s drain) and exit. */
export function stopSandboxCollector(home?: string): boolean {
  const paths = sandboxCollectorPaths(home);
  if (!sandboxCollectorRunning(paths)) return false;
  writeAtomic(paths.stop, "stop\n");
  return true;
}
