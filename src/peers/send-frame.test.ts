import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSendHeader, encodeSendHeader, requireSendFin, sendFileBody, streamFileBody, type SendHeader } from "./send-frame";
import { rewriteAttachmentPaths } from "./attachment-paths";
import { CHUNK_BYTES, IDLE_TIMEOUT_MS, MAX_HEADER_BYTES } from "./transfer-limits";

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const file = { name: "雪.png", size: 4, spellings: ["./雪.png"], sha256: "a".repeat(64) };
const header: SendHeader = {
  op: "send", id: "97885550-0b3b-45a3-a790-ba6a71819ee9", from: { kind: "user" },
  target: { kind: "agent", agent: "worker" }, message: "🪴", files: [file],
};

class MemoryStream {
  offset = 0;
  reads: number[] = [];
  exactReads: number[] = [];
  constructor(readonly bytes: Uint8Array, readonly fragment = Infinity) {}
  async read(limit: number) {
    this.reads.push(limit);
    const chunk = this.bytes.subarray(this.offset, this.offset + Math.min(limit, this.fragment));
    this.offset += chunk.length;
    return Array.from(chunk);
  }
  async readExact(n: number) {
    this.exactReads.push(n);
    const bytes = await this.read(n);
    if (bytes.length !== n) throw new Error("early EOF");
    return bytes;
  }
}

function frame(bytes: Uint8Array) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

test("header round-trips as length-prefixed UTF-8 without consuming a body", async () => {
  for (const target of [header.target, { kind: "agent", repo: "r", agent: "a" }, { kind: "system" }, { kind: "repo-coordinator", repo: "r" }] as const) {
    const h = { ...header, target };
    const encoded = encodeSendHeader(h);
    expect(Buffer.from(encoded)).toEqual(frame(Buffer.from(JSON.stringify(h))));
    const stream = new MemoryStream(Buffer.concat([encoded, Buffer.from("body")]));
    expect(await decodeSendHeader(stream)).toEqual(h);
    expect(stream.offset).toBe(encoded.length);
  }
  const h = { ...header, from: { kind: "agent" as const, id: "desk/repo/alice" } };
  expect(await decodeSendHeader(new MemoryStream(encodeSendHeader(h)))).toEqual(h);
});

test("header cap is inclusive; an oversize prefix is refused before reading the body", async () => {
  const overhead = Buffer.byteLength(JSON.stringify({ ...header, message: "" }));
  const message = "x".repeat(MAX_HEADER_BYTES - overhead);
  expect(encodeSendHeader({ ...header, message }).length).toBe(4 + MAX_HEADER_BYTES);
  expect(() => encodeSendHeader({ ...header, message: message + "a" })).toThrow(/header/i);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(MAX_HEADER_BYTES + 1);
  const stream = new MemoryStream(prefix);
  await expect(decodeSendHeader(stream)).rejects.toThrow(/header/i);
  expect(stream.exactReads).toEqual([4]);
});

test("rejects invalid UTF-8, JSON, truncated frames, and malformed header fields", async () => {
  const json = Buffer.from(JSON.stringify(header));
  const badUtf8 = Buffer.from(json);
  badUtf8[badUtf8.indexOf(Buffer.from(header.message))] = 255;
  for (const bytes of [Buffer.alloc(3), frame(json).subarray(0, -1), frame(badUtf8), frame(Buffer.from("{"))]) {
    await expect(decodeSendHeader(new MemoryStream(bytes))).rejects.toThrow();
  }
  for (const fields of [
    { op: "other" }, { id: "invalid" }, { from: null }, { from: { kind: "agent", id: 1 } },
    { from: { kind: "agent" } }, { from: { kind: "user", id: "surprise" } },
    { target: { agent: "a" } }, { target: { kind: "unknown" } }, { target: { kind: "system", repo: "r" } },
    { target: { kind: "agent", agent: 42 } }, { target: { kind: "agent", agent: "a", repo: false } },
    { target: { kind: "repo-coordinator" } }, { target: { kind: "repo-coordinator", repo: "r", agent: "a" } },
    { files: [{ ...file, spellings: null }] }, { files: [{ ...file, spellings: [] }] },
    { files: [{ ...file, spellings: [2] }] }, { files: [{ ...file, spellings: [""] }] },
    { message: null }, { files: {} }, { files: [{ ...file, name: 2 }] }, { files: [{ ...file, size: -1 }] },
    { files: [{ ...file, size: 1.1 }] }, { files: [{ ...file, sha256: "z".repeat(64) }] },
  ]) {
    const bytes = frame(Buffer.from(JSON.stringify({ ...header, ...fields })));
    await expect(decodeSendHeader(new MemoryStream(bytes))).rejects.toThrow();
  }
});

test("receives exactly one body in short reads, hashes all chunks, and leaves the next byte", async () => {
  const bytes = Buffer.alloc(2 * CHUNK_BYTES + 7, "abc");
  for (const size of [0, CHUNK_BYTES, bytes.length - 1]) {
    const stream = new MemoryStream(bytes, CHUNK_BYTES - 3);
    const chunks: Uint8Array[] = [];
    const progress: number[] = [];
    const hash = await streamFileBody(stream, size, async chunk => { chunks.push(chunk); }, {
      onProgress: total => progress.push(total),
    });
    expect(hash).toBe(digest(bytes.subarray(0, size)));
    expect(Buffer.concat(chunks)).toEqual(bytes.subarray(0, size));
    expect(stream.offset).toBe(size);
    expect(stream.reads.every(n => n > 0 && n <= CHUNK_BYTES)).toBe(true);
    expect(progress.at(-1) ?? 0).toBe(size);
  }
});

test("refuses early EOF and reads larger than requested", async () => {
  await expect(streamFileBody(new MemoryStream(Buffer.from("x")), 2, () => {})).rejects.toThrow(/EOF/);
  await expect(streamFileBody({ read: async () => [1, 2] }, 1, () => {})).rejects.toThrow(/size|limit/i);
});

test("abort interrupts an outstanding read and a late chunk never reaches the sink", async () => {
  const controller = new AbortController();
  const pending = Promise.withResolvers<number[]>();
  let writes = 0;
  const transfer = streamFileBody({ read: () => pending.promise }, 1, () => { writes++; }, { signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await expect(transfer).rejects.toThrow("cancelled");
  pending.resolve([42]);
  await Promise.resolve();
  expect(writes).toBe(0);
  await expect(streamFileBody(new MemoryStream(Buffer.alloc(0)), 0, () => {}, { signal: controller.signal })).rejects.toThrow("cancelled");
});

test("a stalled sink hits the idle timeout and does not report progress", async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  let expire: (() => void) | undefined;
  const progress: number[] = [];
  const transfer = streamFileBody(new MemoryStream(Buffer.from("x")), 1, () => {
    started.resolve();
    return pending.promise;
  }, {
    onProgress: n => progress.push(n),
    setTimer(ms, fn) {
      expect(ms).toBe(IDLE_TIMEOUT_MS);
      expire = fn;
      return () => { expire = undefined; };
    },
  });
  await started.promise;
  expire!();
  await expect(transfer).rejects.toThrow(/idle|no progress/i);
  pending.resolve();
  expect(progress).toEqual([]);
  expect(expire).toBeUndefined();
});

test("sends bounded chunks in order, reports cumulative bytes and can abort a stalled write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ib-frame-"));
  let handle: FileHandle | undefined;
  try {
    const path = join(dir, "file");
    const data = Buffer.alloc(CHUNK_BYTES * 2 + 1, "abc");
    await writeFile(path, data);
    handle = await open(path, "r");
    const chunks: Buffer[] = [];
    const progress: number[] = [];
    await sendFileBody(handle, { writeAll: async bytes => { chunks.push(Buffer.from(bytes)); } }, {
      onProgress: total => progress.push(total),
    });
    expect(chunks.map(chunk => chunk.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 1]);
    expect(Buffer.concat(chunks)).toEqual(data);
    expect(progress).toEqual([CHUNK_BYTES, CHUNK_BYTES * 2, data.length]);

    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
    const send = sendFileBody(handle, { writeAll: () => { started.resolve(); return stalled.promise; } }, { signal: controller.signal });
    await started.promise;
    controller.abort(new Error("sender cancelled"));
    await expect(send).rejects.toThrow("sender cancelled");
    stalled.resolve();
  } finally {
    await handle?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("header spellings preserve two identical basenames and repeated references during rewriting", async () => {
  const input = { ...header, message: "./a/image.png ./b/image.png ~/a/image.png", files: [
    { ...file, name: "image.png", spellings: ["./a/image.png", "~/a/image.png"] },
    { ...file, name: "image.png", spellings: ["./b/image.png"] },
  ] };
  const decoded = await decodeSendHeader(new MemoryStream(encodeSendHeader(input)));
  const mapping = decoded.files.map(({ name, spellings }, index) => ({ spellings, destination: "/tmp/" + index + "/" + name }));
  expect(rewriteAttachmentPaths(decoded.message, mapping)).toBe("/tmp/0/image.png /tmp/1/image.png /tmp/0/image.png");
});

test("requires clean FIN after zero or more file bodies using a one-byte read", async () => {
  for (const body of ["", "body"]) {
    const clean = new MemoryStream(Buffer.from(body));
    if (body) await streamFileBody(clean, body.length, () => {});
    await requireSendFin(clean);
    expect(clean.reads.at(-1)).toBe(1);
    const trailing = new MemoryStream(Buffer.from(body + "extra"));
    if (body) await streamFileBody(trailing, body.length, () => {});
    await expect(requireSendFin(trailing)).rejects.toThrow(/trailing/i);
    expect(trailing.offset).toBe(body.length + 1);
  }
});

test("stalled FIN can time out or be aborted", async () => {
  const stream = { read: () => new Promise<number[]>(() => {}) };
  let expire!: () => void;
  const waiting = requireSendFin(stream, { setTimer(ms, fn) {
    expect(ms).toBe(IDLE_TIMEOUT_MS);
    expire = fn;
    return () => {};
  } });
  expire();
  await expect(waiting).rejects.toThrow(/progress/i);
  const controller = new AbortController();
  const cancelled = requireSendFin(stream, { signal: controller.signal });
  controller.abort(new Error("cancel FIN"));
  await expect(cancelled).rejects.toThrow("cancel FIN");
});
