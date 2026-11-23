import { createHash } from "node:crypto";
import { fileChunks, type ManifestEntry } from "./attachment-manifest";
import { CHUNK_BYTES, IDLE_TIMEOUT_MS, MAX_HEADER_BYTES } from "./transfer-limits";

export type SendTarget =
  | { kind: "agent"; repo?: string; agent: string }
  | { kind: "system" }
  | { kind: "repo-coordinator"; repo: string };

export interface SendHeader {
  op: "send";
  id: string;
  from: { kind: "user" } | { kind: "agent"; id: string };
  target: SendTarget;
  message: string;
  files: { name: string; size: number; sha256: string; spellings: string[] }[];
}

type Bytes = Uint8Array | number[];
interface ReadStream { read(limit: number): Promise<Bytes> }

export function encodeSendHeader(header: SendHeader): Buffer {
  const json = JSON.stringify(header);
  const length = Buffer.byteLength(json);
  if (length > MAX_HEADER_BYTES) throw new Error(`Send header exceeds ${MAX_HEADER_BYTES} bytes`);
  const frame = Buffer.allocUnsafe(4 + length);
  frame.writeUInt32BE(length);
  frame.write(json, 4);
  return frame;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, ...keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function validFrom(value: unknown): value is SendHeader["from"] {
  if (!object(value)) return false;
  if (value.kind === "user") return onlyKeys(value, "kind");
  if (value.kind !== "agent" || !nonempty(value.id) || !onlyKeys(value, "kind", "id")) return false;
  const segments = value.id.split("/");
  return segments.length === 3 && segments.every(nonempty);
}
function validTarget(value: unknown): value is SendTarget {
  if (!object(value)) return false;
  switch (value.kind) {
    case "system": return onlyKeys(value, "kind");
    case "repo-coordinator": return nonempty(value.repo) && onlyKeys(value, "kind", "repo");
    case "agent": return nonempty(value.agent) && !value.agent.startsWith("@") &&
      (value.repo === undefined || nonempty(value.repo)) && onlyKeys(value, "kind", "repo", "agent");
    default: return false;
  }
}
function validFile(value: unknown): value is SendHeader["files"][number] {
  return object(value) && nonempty(value.name) && typeof value.size === "number" &&
    Number.isSafeInteger(value.size) && value.size >= 0 && typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(value.sha256) && Array.isArray(value.spellings) &&
    value.spellings.length > 0 && value.spellings.every(nonempty) && onlyKeys(value, "name", "size", "sha256", "spellings");
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function readHeaderBytes(stream: ReadStream, size: number, options: FileBodyOptions): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const limit = Math.min(CHUNK_BYTES, size - offset);
    const chunk = await waitForIO(options, () => stream.read(limit));
    if (!chunk.length) throw new Error("Incomplete send header");
    if (chunk.length > limit) throw new Error("Read exceeded requested header size");
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

export async function decodeSendHeader(stream: ReadStream, options: FileBodyOptions = {}): Promise<SendHeader> {
  const prefix = await readHeaderBytes(stream, 4, options);
  const length = prefix.readUInt32BE();
  if (length > MAX_HEADER_BYTES) throw new Error(`Send header exceeds ${MAX_HEADER_BYTES} bytes`);
  const bytes = await readHeaderBytes(stream, length, options);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!object(value) || !onlyKeys(value, "op", "id", "from", "target", "message", "files") ||
      value.op !== "send" || typeof value.id !== "string" || !UUID.test(value.id) ||
      !validFrom(value.from) || !validTarget(value.target) || typeof value.message !== "string" ||
      !Array.isArray(value.files) || !value.files.every(validFile)) throw new Error("Malformed send header");
  return { op: "send", id: value.id, from: value.from, target: value.target, message: value.message, files: value.files };
}

export interface FileBodyOptions {
  /** Cumulative bytes successfully written for this file. */
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
  setTimer?: (ms: number, callback: () => void) => () => void;
}

function setIdleTimer(ms: number, callback: () => void) {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

/** One deadline per outstanding I/O. Its listener and timer are released at
 * each step, including on error. A stalled operation cannot start the next step. */
async function waitForIO<T>(options: FileBodyOptions, operation: () => T | Promise<T>): Promise<T> {
  const { signal, setTimer = setIdleTimer } = options;
  signal?.throwIfAborted();
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(signal!.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const cancel = setTimer(IDLE_TIMEOUT_MS, () => stopped.reject(new Error(`No progress for ${IDLE_TIMEOUT_MS} ms`)));
  try {
    const result = await Promise.race([stopped.promise, operation()]);
    signal?.throwIfAborted();
    return result;
  } finally {
    cancel();
    signal?.removeEventListener("abort", abort);
  }
}

export async function streamFileBody(
  stream: ReadStream, size: number,
  sink: (chunk: Uint8Array) => void | Promise<void>, options: FileBodyOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid file body size");
  const hash = createHash("sha256");
  let written = 0;
  while (written < size) {
    const limit = Math.min(CHUNK_BYTES, size - written);
    const bytes = await waitForIO(options, () => stream.read(limit));
    if (!bytes.length) throw new Error(`Early EOF after ${written} of ${size} bytes`);
    if (bytes.length > limit) throw new Error("Read exceeded requested file chunk size");
    const chunk = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    hash.update(chunk);
    await waitForIO(options, () => sink(chunk));
    written += chunk.length;
    options.onProgress?.(written);
  }
  return hash.digest("hex");
}

/** Complete a request after all declared bodies, including a text-only request. */
export async function requireSendFin(stream: ReadStream, options: FileBodyOptions = {}): Promise<void> {
  const trailing = await waitForIO(options, () => stream.read(1));
  if (trailing.length) throw new Error("Trailing data after declared file bodies");
}

/** Only the caller knows when the last file has been sent and may finish the stream. */
export async function sendFileBody(
  { handle, size }: Pick<ManifestEntry, "handle" | "size">, stream: { writeAll(bytes: number[]): Promise<void> }, options: FileBodyOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid file body size");
  const chunks = fileChunks(handle, size);
  let written = 0;
  for (;;) {
    const next = await waitForIO(options, () => chunks.next());
    if (next.done) return;
    const chunk = next.value;
    await waitForIO(options, () => stream.writeAll(Array.from(chunk)));
    written += chunk.length;
    options.onProgress?.(written);
  }
}
