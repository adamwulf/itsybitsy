/**
 * `ib export-logs [<machine>] [--out <dir>]` (SPEC.md §20.4 "Watch log
 * copies", §12.1.3): copy the `ib watch` log files of this machine and of
 * every paired peer (or the one named) into one directory, as they are, so
 * the two sides of a peer-link problem can be read together.
 *
 * - This machine's files (watch-log-files.ts) are read here and always
 *   written, unless reading them fails.
 * - A peer's are fetched by this machine's endpoint-owning `ib watch` over
 *   the trusted link, through the peer outbox (`handoffWatchLog`). Without a
 *   live `ib watch` here, no peer is fetched.
 * - `export.txt` records, per machine, only what is known when it is written:
 *   names, ids, versions, file sizes, times, the clock comparison, errors.
 *   There is no merged file, filtering or analysis.
 *
 * It never loads the iroh addon (export-logs.test.ts makes the loader throw).
 * The hooks allow it to humans and @system only (`checkIbCommandAccess` in
 * src/hooks/agent-path.ts).
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IbCommandResult } from "../ib-commands";
import { IB_VERSION } from "../ib-version";
import { userHome } from "../home";
import { cleanMachineName, readMachineName } from "../machine-name";
import { peerSecretKeyFile, runtimeDir } from "../runtime-names";
import { hasLivePeerWatcher } from "./endpoint-lock";
import { deriveEndpointId, parseSecretKey } from "./identity";
import { handoffWatchLog, WATCH_NOT_RUNNING } from "./peer-outbox";
import { cleanPeerName, normalizePeerId, readPeers, shortPeerId, type Peer } from "./store";
import { singleLine } from "./single-line";
import { decodeWatchLogOutput, describeWatchLogFiles, readWatchLogFiles, type PeerWatchLog, type WatchLogFile } from "./watch-log-files";

export const EXPORT_LOGS_USAGE = "Usage: ib export-logs [<machine>] [--out <dir>]";
export const EXPORT_FILE = "export.txt";
/**
 * Peer requests published to the outbox at once. ib watch runs at most four
 * outbox requests together and fails one not claimed within 10 s, so with
 * many peers, or alongside an `ib send`, publishing them all could fail some
 * as unclaimed.
 */
export const PEER_FETCHES_AT_ONCE = 2;

export interface ExportLogsDeps {
  readPeers(): Promise<Peer[]>;
  machineName(): Promise<string>;
  /** This machine's full peer id, or what to write instead (`none (…)`, `unknown (…)`). */
  selfId(): Promise<string>;
  readLocalFiles(): Promise<WatchLogFile[]>;
  /** A live `ib watch` owns this machine's peer endpoint. */
  watcherRunning(): Promise<boolean>;
  /** Ask `ib watch` for the peer's files: `handoffWatchLog`. */
  fetch(peer: Peer, signal: AbortSignal): Promise<IbCommandResult>;
  /** Epoch ms. */
  now(): number;
  /** Where a default export directory is created. */
  exportsRoot(): string;
  stdout(line: string): void;
  stderr(line: string): void;
}

const detail = (err: unknown) => singleLine(err instanceof Error ? err.message : String(err));

/** The id derived from `secret.key` without creating one, which `ib peer id` would. */
async function readSelfId(): Promise<string> {
  const path = peerSecretKeyFile();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return `none (${path} does not exist)`;
    return `unknown (${detail(err)})`;
  }
  try {
    return deriveEndpointId(parseSecretKey(text, path));
  } catch (err) {
    return `unknown (${detail(err)})`;
  }
}

export function defaultExportLogsDeps(): ExportLogsDeps {
  return {
    readPeers,
    machineName: readMachineName,
    selfId: readSelfId,
    readLocalFiles: () => readWatchLogFiles(),
    watcherRunning: hasLivePeerWatcher,
    fetch: (peer, signal) => handoffWatchLog(peer.id, cleanPeerName(peer), signal),
    now: Date.now,
    exportsRoot: () => join(runtimeDir(userHome()), "log-exports"),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

export interface ExportLogsArgs {
  machine?: string;
  out?: string;
}

export function parseExportLogsArgs(args: string[]): ExportLogsArgs | { error: string } {
  const parsed: ExportLogsArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? args[++i] : arg.slice("--out=".length);
      if (!value) return { error: "Error: --out needs a directory" };
      if (parsed.out !== undefined) return { error: "Error: --out given twice" };
      parsed.out = value;
    } else if (arg.startsWith("-")) {
      return { error: `Error: unknown option '${arg}'` };
    } else if (parsed.machine !== undefined) {
      return { error: "Error: ib export-logs takes at most one machine. Quote a name that contains spaces." };
    } else {
      parsed.machine = arg;
    }
  }
  return parsed;
}

/** The paired peer `target` names: its full id, or its name, compared in clean form (cleanPeerName). */
function resolvePeer(peers: Peer[], target: string): Peer {
  const id = normalizePeerId(target);
  const byId = id === null ? undefined : peers.find((peer) => peer.id === id);
  if (byId) return byId;
  const named = peers.filter((peer) => cleanPeerName(peer) === cleanMachineName(target));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`${named.length} peers are named ${JSON.stringify(target)}; use the full id: ${named.map((peer) => peer.id).join(", ")}`);
  throw new Error(`no paired peer has the name or id ${JSON.stringify(target)}`);
}

/** `20261125T180312Z`: a UTC stamp with no characters a shell or Finder treats specially. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/** A new, private directory under `root`, named by the stamp (with `-2`, `-3`… if taken). */
async function createStampedDir(root: string, ms: number): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let n = 1; ; n++) {
    const dir = join(root, n === 1 ? stamp(ms) : `${stamp(ms)}-${n}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw err;
    }
  }
}

/** `--out`: created when missing; an existing one must be empty, so nothing in it is overwritten. */
async function prepareGivenDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await readdir(dir)).length > 0) throw new Error(`${dir} is not empty`);
  return dir;
}

/**
 * A machine's directory name: runs of anything but letters, digits, `.`, `_`
 * and `-` become one `-` (a name can hold `'`, spaces or `/`), with no
 * leading or trailing `-` or `.`. Names are compared ignoring case, as APFS
 * does; a taken one gets the short id, then a number.
 */
export function machineDirName(name: string, id: string | null, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || (id === null ? "this-machine" : shortPeerId(id));
  let candidate = base;
  if (taken.has(candidate.toLowerCase())) candidate = `${base}-${id === null ? "this-machine" : shortPeerId(id)}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

async function writeCopies(dir: string, files: readonly WatchLogFile[]): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  for (const file of files) await writeFile(join(dir, file.name), file.body, { mode: 0o600, flag: "wx" });
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * `peer clock − local clock: +0.402 s (± 0.100 s)`: the peer's `now` minus
 * the midpoint of this side's send and header times, with half that interval
 * (rounded up to the millisecond) as the bound. The peer read its clock
 * between the two, so the true difference lies within it.
 */
export function clockComparison(copy: Pick<PeerWatchLog, "now" | "sentAt" | "headerAt">): string {
  const offset = copy.now - (copy.sentAt + copy.headerAt) / 2;
  const bound = Math.ceil((copy.headerAt - copy.sentAt) / 2);
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  return `peer clock − local clock: ${offset < 0 ? "-" : "+"}${seconds(Math.abs(offset))} s (± ${seconds(bound)} s)`;
}

function fileLines(dirName: string, files: readonly WatchLogFile[]): string[] {
  if (!files.length) return [`directory: ${dirName}/ (no watch log files)`];
  return [`directory: ${dirName}/`, ...files.map((file) => `  ${file.name.padEnd(12)} ${file.body.length} bytes`)];
}

type PeerOutcome = { peer: Peer; copy: PeerWatchLog } | { peer: Peer; error: string };

/** One export, with `signal` standing for Ctrl-C. Returns the exit code. */
export async function exportLogs(parsed: ExportLogsArgs, deps: ExportLogsDeps, signal: AbortSignal): Promise<number> {
  const startedAt = deps.now();
  let peers: Peer[] = [];
  let peersError: string | null = null;
  try {
    peers = await deps.readPeers();
  } catch (err) {
    peersError = detail(err);
  }
  let targets = peers;
  if (parsed.machine !== undefined) {
    if (peersError !== null) throw new Error(peersError);
    targets = [resolvePeer(peers, parsed.machine)];
  }
  const dir = parsed.out !== undefined ? await prepareGivenDir(resolve(parsed.out)) : await createStampedDir(deps.exportsRoot(), startedAt);
  deps.stdout(`Exported to ${dir}`);
  const taken = new Set([EXPORT_FILE]);

  // This machine.
  let machine: string | null = null;
  let machineError = "";
  try {
    machine = await deps.machineName();
  } catch (err) {
    machineError = detail(err);
  }
  const label = machine === null ? "this machine" : `${machine} (this machine)`;
  const local = [`machine: ${label}`];
  if (machine === null) local.push(`machine name: unknown (${machineError})`);
  local.push(`id: ${await deps.selfId()}`, `ib version: ${IB_VERSION}`);
  let failed = false;
  try {
    const files = await deps.readLocalFiles();
    const copiedAt = deps.now();
    const dirName = machineDirName(machine ?? "", null, taken);
    await writeCopies(join(dir, dirName), files);
    local.push(`copied at: ${iso(copiedAt)}`, ...fileLines(dirName, files));
    deps.stdout(`${label}: ${describeWatchLogFiles(files)}`);
  } catch (err) {
    failed = true;
    local.push(`not copied: ${detail(err)}`);
    deps.stdout(`${label}: not copied: ${detail(err)}`);
  }

  // export.txt now, with this machine's block, and each peer's block appended
  // once its outcome is known: an export killed midway keeps what it had.
  const report = join(dir, EXPORT_FILE);
  const opening = [`ib export-logs, started ${iso(startedAt)} (this machine's clock)`, local.join("\n")];
  if (peersError !== null) opening.push(`paired peers: not read: ${peersError}`);
  await writeFile(report, opening.join("\n\n") + "\n", { mode: 0o600, flag: "wx" });
  /** One peer's files and block at a time, in the order their outcomes arrive. */
  let writing: Promise<void> = Promise.resolve();
  const serially = (write: () => Promise<void>) => {
    const done = writing.then(write);
    writing = done.catch(() => {});
    return done;
  };

  // The peers, PEER_FETCHES_AT_ONCE at a time.
  let running: boolean | string = false;
  if (targets.length) {
    try {
      running = await deps.watcherRunning();
    } catch (err) {
      running = `could not check whether ib watch is running: ${detail(err)}`;
    }
  }
  const fetchPeer = async (peer: Peer): Promise<PeerOutcome> => {
    if (running !== true) return { peer, error: running === false ? WATCH_NOT_RUNNING : running };
    const result = await deps.fetch(peer, signal);
    if (!result.ok) return { peer, error: signal.aborted ? "interrupted" : singleLine(result.stderr) || `exit ${result.exitCode}` };
    try {
      return { peer, copy: decodeWatchLogOutput(result.stdout) };
    } catch (err) {
      return { peer, error: detail(err) };
    }
  };
  const record = (outcome: PeerOutcome) => serially(async () => {
    const { peer } = outcome;
    // The clean name, as `ib export-logs <machine>` and every address take it.
    const name = cleanPeerName(peer);
    const block = [`machine: ${name} (paired peer)`, `id: ${peer.id}`];
    if ("error" in outcome) {
      failed = true;
      block.push(`not fetched: ${outcome.error}`);
      await appendFile(report, "\n" + block.join("\n") + "\n");
      deps.stdout(`${name}: not fetched: ${outcome.error}`);
      return;
    }
    const { copy } = outcome;
    const dirName = machineDirName(name, peer.id, taken);
    await writeCopies(join(dir, dirName), copy.files);
    block.push(
      `machine name it reports: ${copy.name}`,
      `ib version: ${copy.version}`,
      `copied at: ${iso(copy.now)} (its clock)`,
      `request sent at: ${iso(copy.sentAt)} (this machine's clock)`,
      `reply header received at: ${iso(copy.headerAt)} (this machine's clock)`,
      `reply complete at: ${iso(copy.doneAt)} (this machine's clock)`,
      clockComparison(copy),
      ...fileLines(dirName, copy.files),
    );
    await appendFile(report, "\n" + block.join("\n") + "\n");
    deps.stdout(`${name}: ${describeWatchLogFiles(copy.files)}`);
  });
  // Each worker publishes its next request once its last one has finished.
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const peer = targets[next++]!;
      await record(await fetchPeer(peer));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PEER_FETCHES_AT_ONCE, targets.length) }, worker));
  if (peersError !== null) {
    failed = true;
    deps.stdout(`paired peers: not read: ${peersError}`);
  }
  return failed ? 1 : 0;
}

/** Run `ib export-logs <args>` (args exclude "export-logs"). Prints, and returns the exit code. */
export async function runExportLogs(args: string[], deps: ExportLogsDeps = defaultExportLogsDeps()): Promise<number> {
  const parsed = parseExportLogsArgs(args);
  if ("error" in parsed) {
    deps.stderr(parsed.error);
    deps.stderr(EXPORT_LOGS_USAGE);
    return 1;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  try {
    return await exportLogs(parsed, deps, controller.signal);
  } catch (err) {
    deps.stderr(`Error: ${detail(err)}`);
    return 1;
  } finally {
    process.off("SIGINT", interrupt);
  }
}
