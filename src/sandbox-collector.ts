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
 * - `clients.lock` LOCK_SH is held by every attach for its whole life. The idle
 *   exit happens only once the daemon can take LOCK_EX there (no attach alive)
 *   with no launch left, and gives up `daemon.lock` while still holding it, so
 *   no attach can register with a daemon that is exiting.
 * - The other exits: `restart` / SIGTERM / SIGINT and a stream failure leave
 *   every launch WITHOUT `done` and give up the role first (attaches start a
 *   successor that re-adopts); `stop` finishes every launch (`done`) first.
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
/** Daemon starts one attach may make in a row without an acknowledgement in
 * between: a daemon that dies at once on every start must not become a spawn
 * loop. Every `ready` resets the count, so a long launch survives any number of
 * restarts that each worked. */
const MAX_STARTS = 4;
const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4;
/** Cadences, not deadlines: how often state is re-read, never a decision made
 * because time passed. Tree sampling stays at 20 ms (it sets how early a
 * short-lived child must be seen to be attributed); everything else is 250 ms. */
const SAMPLE_MS = 20;
const MARKER_MS = 50;
const CHECK_MS = 250;
/** `status` only: a heartbeat this old means the daemon loop is not running. */
const STALE_HEARTBEAT_MS = 5000;

export interface SandboxCollectorPaths {
  root: string; daemonLock: string; clientsLock: string; inbox: string; heartbeat: string; log: string;
  stop: string; restart: string;
}

export function sandboxCollectorPaths(home?: string): SandboxCollectorPaths {
  const root = join(sealDir(home), "sandbox-collector");
  return { root, daemonLock: join(root, "daemon.lock"), clientsLock: join(root, "clients.lock"), inbox: join(root, "inbox"),
    heartbeat: join(root, "heartbeat.json"), log: join(root, "collector.log"), stop: join(root, "stop"),
    restart: join(root, "restart") };
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
  /** The running kernel boot session (kern.bootsessionuuid). */
  boot: string;
  read(pid: number): ProcessObservation | null;
  sandboxed(pid: number): boolean;
}

/** A process as registration.json names it: PID alone can be reused after a
 * crash or reboot, PID + birth within one boot cannot. */
export interface RegisteredProcess { pid: number; birth: string }

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
const isRegisteredProcess = (value: unknown): value is RegisteredProcess =>
  !!value && typeof value === "object" && isPid((value as RegisteredProcess).pid) &&
  typeof (value as RegisteredProcess).birth === "string" && /^\d{1,20}:\d{1,6}$/.test((value as RegisteredProcess).birth);

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
 * namespace, written in this boot, naming the agent.log bound to that
 * namespace, by the exact live registrar process (PID + birth) it names, which
 * descends from the exact launch owner process it names; both unsandboxed. */
export function validateRegistration(entryName: string, entryText: string, reader: CollectorReader, home?: string): AcceptedRegistration {
  const dir = checkLaunchDirectory(entryName, entryText, home);
  const registration = JSON.parse(readPrivateFile(join(dir, "registration.json"), 8192));
  if (registration?.v !== PROTOCOL) throw new Error(`unsupported registration protocol ${String(registration?.v)}`);
  const { agentLog, owner, registrar, token, boot } = registration;
  // Unchanged rule: a launch directory may only name the agent.log of the agent
  // directory whose hash names its namespace.
  if (typeof agentLog !== "string" || !isAbsolute(agentLog) || sandboxLogParent(dirname(agentLog), home) !== dirname(dir)) {
    throw new Error("agent log is not bound to this launch namespace");
  }
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token) || typeof boot !== "string" ||
      !isRegisteredProcess(owner) || !isRegisteredProcess(registrar)) {
    throw new Error("malformed registration");
  }
  // A launch directory outlives a crash or reboot; its PIDs may now name
  // unrelated processes. Only the same boot and the same birth are accepted.
  if (boot !== reader.boot) throw new Error("registration is from another boot");
  const ownerProcess = reader.read(owner.pid);
  if (!ownerProcess || processIdentity(ownerProcess) !== processIdentity(owner)) {
    throw new Error("launch owner is not running (or its PID now names another process)");
  }
  const registrarProcess = reader.read(registrar.pid);
  if (!registrarProcess || processIdentity(registrarProcess) !== processIdentity(registrar)) {
    throw new Error("registrar is not running (or its PID now names another process)");
  }
  // The per-launch collector proved the owner was ITS ancestor. The shared
  // daemon is nobody's descendant, so prove it of the live registrar instead.
  const registrarAncestors = new Set<number>();
  let ancestor: ProcessObservation | null = registrarProcess;
  for (let depth = 0; ancestor && depth < 64 && ancestor.pid !== owner.pid; depth++) {
    registrarAncestors.add(ancestor.pid);
    ancestor = reader.read(ancestor.ppid);
  }
  if (!ancestor || processIdentity(ancestor) !== processIdentity(ownerProcess)) {
    throw new Error("launch owner is not an ancestor of the registrar");
  }
  if (reader.sandboxed(owner.pid) || reader.sandboxed(registrar.pid)) throw new Error("launch owner or registrar is sandboxed");
  return { name: entryName, dir, agentLog, token, owner: ownerProcess, registrar: registrarProcess, registrarAncestors };
}

interface Launch extends AcceptedRegistration {
  stopFd: number;
  marker: string;
  markerSeen: boolean;
  markerNext: number;
  markerDeadline: number;
  ready: boolean;
  /** When stop file, owner and registrar are next re-read (every CHECK_MS). */
  nextCheck: number;
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
    // The handed-over fd must BE daemon.lock (flock on any other file would
    // succeed too), and LOCK_EX on it must succeed: through the inherited open
    // file description that holds the role, or because the role is free. It
    // fails while another description holds daemon.lock.
    let sameFile = false;
    try {
      const held = fstatSync(opts.lockFd);
      const path = lstatSync(paths.daemonLock);
      sameFile = path.isFile() && held.dev === path.dev && held.ino === path.ino;
    } catch { /* not an open file, or no lock file */ }
    if (!sameFile || flock(opts.lockFd, LOCK_EX | LOCK_NB) !== 0) {
      try { closeSync(opts.lockFd); } catch { /* not open */ }
      return 1;
    }
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
  // A stale request must not end this instance.
  for (const request of [paths.stop, paths.restart]) { try { unlinkSync(request); } catch { /* none */ } }
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
  /** stop: finish every launch (`done`), so every attach returns, then exit.
   * restart: leave like a crash, WITHOUT `done` and giving up the role first,
   * so the attaches start a new daemon that re-adopts their launches. */
  let leaving: "stop" | "restart" | undefined;
  const restartOnSignal = () => { leaving ??= "restart"; };
  const hup = () => {};
  process.on("SIGTERM", restartOnSignal); process.on("SIGINT", restartOnSignal); process.on("SIGHUP", hup);
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
          { boot: reader!.boot, read: pid => reader!.read(pid), sandboxed: opts.sandboxed ?? (pid => reader!.sandboxed(pid)) }, opts.home);
      } catch (error) {
        // Tell the registrar through its own private directory, never through
        // the unverified agent.log path. `done` (not the registration's token)
        // also keeps a stale directory from being re-examined on every start.
        try {
          const dir = checkLaunchDirectory(name, dirText, opts.home);
          writeFileSync(join(dir, "failed"), "");
          writeFileSync(join(dir, "done"), "rejected");
        } catch { /* not ours to mark */ }
        throw error;
      }
      const stopFd = openSync(join(accepted.dir, "stop"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      launches.set(name, { ...accepted, stopFd, marker: `${markerPrefix} ${name} ready`, markerSeen: false,
        markerNext: now, markerDeadline: now + 3000, ready: false, nextCheck: now,
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
      // The 1 s drain makes a finer check of these pointless.
      if (now >= launch.nextCheck) {
        launch.nextCheck = now + CHECK_MS;
        if (leaving === "stop" || fstatSync(launch.stopFd).size > 0 || !sameProcess(reader!.read(launch.owner.pid), launch.owner) ||
            !sameProcess(reader!.read(launch.registrar.pid), launch.registrar)) {
          if (launch.stopAt === undefined && rootAlive) status(launch, "WARNING", "collection stopping before the registered CLI exits; coverage reduced");
          launch.stopAt ??= now + 1000;
        }
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
    let nextControl = 0;
    let nextAccept = 0;
    let inboxMtime: bigint | undefined;
    /** A directory's mtime changes when an entry is added or removed. A stat
     * is far cheaper than a readdir; the CHECK_MS fallback covers anything a
     * timestamp could miss. */
    const inboxChanged = () => {
      try {
        const mtime = statSync(paths.inbox, { bigint: true }).mtimeNs;
        if (mtime !== inboxMtime) { inboxMtime = mtime; return true; }
      } catch { /* no inbox yet */ }
      return false;
    };
    while (true) {
      const now = performance.now();
      if (now >= nextControl) {
        nextControl = now + CHECK_MS;
        if (existsSync(paths.restart)) { leaving ??= "restart"; try { unlinkSync(paths.restart); } catch { /* removed */ } }
        if (existsSync(paths.stop)) { leaving ??= "stop"; try { unlinkSync(paths.stop); } catch { /* removed */ } }
      }
      if (leaving === "restart") {
        note("restart requested; leaving every launch to the next daemon");
        for (const launch of [...launches.values()]) {
          status(launch, "WARNING", "shared collector restarting on request; reports until the next one is ready are not collected");
          drop(launch);
        }
        // Give up the role before the stream teardown, so a registrar can
        // start the next daemon at once.
        closeSync(lockFd);
        lockFd = null;
        break;
      }
      if (sandboxStreamExited(stream) || failed) {
        throw new Error(`log stream stopped unexpectedly (exit=${stream.exitCode}, signal=${stream.signalCode}): ${(stderr || String(failed ?? "no output")).trim()}`);
      }
      if (!leaving && (inboxChanged() || now >= nextAccept)) {
        accept(now);
        nextAccept = now + CHECK_MS;
      }
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
        if (leaving === "stop") break;
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
      // Tree sampling needs 20 ms only while a root is registered; a launch
      // waiting for its readiness marker needs it seen soon; otherwise idle.
      const values = [...launches.values()];
      await Bun.sleep(values.some(launch => launch.attribution) ? SAMPLE_MS
        : values.some(launch => !launch.ready) ? MARKER_MS : CHECK_MS);
    }
    note(leaving === "stop" ? "collector stopped on request" : leaving === "restart" ? "collector left for a restart"
      : "no launches and no registrars left; exiting");
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
    process.off("SIGTERM", restartOnSignal); process.off("SIGINT", restartOnSignal); process.off("SIGHUP", hup);
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
  /** Test seam: how often a registered attach re-reads `done` and the lock. */
  pollMs?: number;
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
    const registrar = reader.read(process.pid);
    if (!registrar) throw new Error("registrar identity unavailable");
    // PID + birth + boot: a directory left by a crash or reboot can never be
    // adopted on behalf of a process that merely reuses one of these PIDs.
    writeAtomic(join(opts.dir, "registration.json"), JSON.stringify({ v: PROTOCOL, agentLog: opts.agentLog, boot: reader.boot,
      owner: { pid: owner.pid, birth: owner.birth }, registrar: { pid: registrar.pid, birth: registrar.birth }, token }));
    const startCollector = opts.startCollector ?? ((fd: number) => spawnSandboxCollector(paths, fd));
    const file = (name: string) => join(opts.dir, name);
    const done = () => {
      if (!existsSync(file("done"))) return false;
      try { return readFileSync(file("done"), "utf8") === token; } catch { return false; }
    };
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
    starts = 0; // an acknowledged start worked
    let stopSent = false;
    while (true) {
      if (done()) return 0;
      // A daemon that FAILED this launch writes our token to `done` (handled
      // above). `failed` without it, or a foreign `done`, is a rejection, for
      // example by a successor's re-adopt scan after the owner exited. Final:
      // that daemon holds the role, so waiting for a free lock would never end.
      if (existsSync(file("failed")) || existsSync(file("done"))) return ownerAlive() ? refused("rejected") : 0;
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
        starts = 0;
        continue;
      }
      await Bun.sleep(opts.pollMs ?? 1000);
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

export function sandboxCollectorStatus(home?: string, now = Date.now()): string {
  const paths = sandboxCollectorPaths(home);
  const running = sandboxCollectorRunning(paths);
  const lines = [`running: ${running ? "yes" : "no"}`];
  try {
    const heartbeat = JSON.parse(readFileSync(paths.heartbeat, "utf8"));
    const age = now - Number(heartbeat.updatedAt);
    const stale = running && !(age <= STALE_HEARTBEAT_MS);
    lines.push(`pid: ${heartbeat.pid}`, `launches: ${heartbeat.launches}`,
      `heartbeat age: ${(age / 1000).toFixed(1)} s${stale ? " (STALE)" : ""}`);
    if (stale) {
      lines.push(`The daemon holds its lock but its loop has not run for ${Math.round(age / 1000)} s.`,
        `End it with: kill -9 ${heartbeat.pid}  (each running launch then starts a new daemon, which re-adopts it)`);
    }
  } catch { lines.push("heartbeat: none"); }
  lines.push(`state: ${paths.root}`);
  return lines.join("\n");
}

/** End collection for EVERY running launch: each gets `collector stopped` and
 * `done`, so its attach exits; then the daemon exits. Running agents are not
 * collected again until they are resumed. */
export function stopSandboxCollector(home?: string): boolean {
  const paths = sandboxCollectorPaths(home);
  if (!sandboxCollectorRunning(paths)) return false;
  writeAtomic(paths.stop, "stop\n");
  return true;
}

/** Replace the daemon without ending collection: it leaves every launch to the
 * next daemon (no `done`) and gives up the role; a running attach then starts a
 * new daemon, which re-adopts every launch. SIGTERM does the same. */
export function restartSandboxCollector(home?: string): boolean {
  const paths = sandboxCollectorPaths(home);
  if (!sandboxCollectorRunning(paths)) return false;
  writeAtomic(paths.restart, "restart\n");
  return true;
}
