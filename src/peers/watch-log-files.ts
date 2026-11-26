/**
 * The `ib watch` log files that `ib export-logs` copies (SPEC.md §20.4
 * "Watch log copies"): watch.log and its rotations watch.log.1 and
 * watch.log.2 (src/watch-log.ts), as they are, read whole into memory.
 *
 * - The endpoint-owning `ib watch` answers a peer's `watch-log` request with
 *   them (service.ts, `serveWatchLog` in peer-link.ts).
 * - `ib export-logs` copies this machine's own (export-logs.ts).
 * - A peer's copy travels from `ib watch` to the CLI through the peer outbox
 *   as JSON with base64 bodies ({@link encodeWatchLogOutput}).
 */

import { open, type FileHandle } from "node:fs/promises";
import { getWatchLogPath } from "../watch-log";

/** The files' names, on the wire and in an export, newest first. */
export const WATCH_LOG_FILE_NAMES = ["watch.log", "watch.log.1", "watch.log.2"] as const;
export type WatchLogFileName = (typeof WATCH_LOG_FILE_NAMES)[number];

/** The largest total a `watch-log` reply may carry. Rotation keeps about 3 MB. */
export const WATCH_LOG_MAX_BYTES = 8 * 1024 * 1024;

export interface WatchLogFile {
  name: WatchLogFileName;
  body: Uint8Array;
}

export function isWatchLogFileName(name: unknown): name is WatchLogFileName {
  return typeof name === "string" && (WATCH_LOG_FILE_NAMES as readonly string[]).includes(name);
}

/**
 * The watch log files that exist at `path`, `path.1` and `path.2`, newest
 * first. Every file is opened before any is read: an open handle keeps the
 * file it opened when a rotation renames it, so a rotation can land only
 * between two opens, not while the files are read.
 */
export async function readWatchLogFiles(path = getWatchLogPath()): Promise<WatchLogFile[]> {
  const handles: { name: WatchLogFileName; handle: FileHandle }[] = [];
  try {
    for (const [index, name] of WATCH_LOG_FILE_NAMES.entries()) {
      try {
        handles.push({ name, handle: await open(index === 0 ? path : `${path}.${index}`, "r") });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    const files: WatchLogFile[] = [];
    for (const { name, handle } of handles) files.push({ name, body: await handle.readFile() });
    return files;
  } finally {
    await Promise.allSettled(handles.map(({ handle }) => handle.close()));
  }
}

export function totalWatchLogBytes(files: readonly { body: Uint8Array }[]): number {
  return files.reduce((total, file) => total + file.body.length, 0);
}

/** `3 files, 2.9 MB` (MB of 1024² bytes). */
export function describeWatchLogFiles(files: readonly { body: Uint8Array }[]): string {
  const mb = (totalWatchLogBytes(files) / 1024 ** 2).toFixed(1);
  return `${files.length} file${files.length === 1 ? "" : "s"}, ${mb} MB`;
}

/** A peer's watch log as the endpoint-owning `ib watch` received it (`requestWatchLog` in peer-link.ts). */
export interface PeerWatchLog {
  /** The machine name the peer reports for itself. */
  name: string;
  /** The peer's `ib` version. */
  version: string;
  /** The peer's clock (epoch ms) when it answered, after it had read its files. */
  now: number;
  /** This machine's clock (epoch ms) just before the request was written. */
  sentAt: number;
  /** This machine's clock (epoch ms) when the reply's header arrived. */
  headerAt: number;
  /** This machine's clock (epoch ms) when the reply's last byte arrived. */
  doneAt: number;
  files: WatchLogFile[];
}

/** The peer-outbox result's output for a watch log copy: {@link PeerWatchLog} with base64 bodies. */
export function encodeWatchLogOutput(log: PeerWatchLog): string {
  return JSON.stringify({
    ...log,
    files: log.files.map((file) => ({ name: file.name, base64: Buffer.from(file.body).toString("base64") })),
  });
}

/** Parse {@link encodeWatchLogOutput}'s JSON. Throws on anything else. */
export function decodeWatchLogOutput(text: string): PeerWatchLog {
  const malformed = () => new Error("ib watch returned a malformed watch log copy");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed();
  const v = value as Record<string, unknown>;
  const time = (key: string): number => {
    const t = v[key];
    if (typeof t !== "number" || !Number.isFinite(t)) throw malformed();
    return t;
  };
  if (typeof v.name !== "string" || typeof v.version !== "string" || !Array.isArray(v.files)) throw malformed();
  const seen = new Set<string>();
  const files = v.files.map((entry: unknown): WatchLogFile => {
    if (!entry || typeof entry !== "object") throw malformed();
    const { name, base64 } = entry as Record<string, unknown>;
    if (!isWatchLogFileName(name) || seen.has(name) || typeof base64 !== "string") throw malformed();
    seen.add(name);
    return { name, body: Buffer.from(base64, "base64") };
  });
  return {
    name: v.name, version: v.version,
    now: time("now"), sentAt: time("sentAt"), headerAt: time("headerAt"), doneAt: time("doneAt"),
    files,
  };
}
