import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSendHeader, encodeSendHeader, requireSendFin, sendFileBody, streamFileBody, type SendHeader } from "./send-frame";
import { buildAttachmentManifest, hashFile } from "./attachment-manifest";
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
  constructor(readonly bytes: Uint8Array, readonly fragment = Infinity) {}
  async read(limit: number) {
    this.reads.push(limit);
    const chunk = this.bytes.subarray(this.offset, this.offset + Math.min(limit, this.fragment));
    this.offset += chunk.length;
    return Array.from(chunk);
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
  expect(stream.reads).toEqual([4]);
});

test("rejects invalid UTF-8, JSON, truncated frames, and malformed header fields", async () => {
  const json = Buffer.from(JSON.stringify(header));
  const badUtf8 = Buffer.from(json);
  badUtf8[badUtf8.indexOf(Buffer.from(header.message))] = 255;
  for (const bytes of [Buffer.alloc(3), frame(json).subarray(0, -1), frame(badUtf8), frame(Buffer.from("{"))]) {
    await expect(decodeSendHeader(new MemoryStream(bytes))).rejects.toThrow();
  }
  for (const fields of [
    { extra: true }, ...["a", "a/b", "a//b", "/r/a", "m/r/", "m/r/a/extra"].map(id => ({ from: { kind: "agent", id } })),
    { op: "other" }, { id: "invalid" }, { from: null }, { from: { kind: "agent", id: 1 } },
    { from: { kind: "agent" } }, { from: { kind: "user", id: "surprise" } },
    { target: { agent: "a" } }, { target: { kind: "unknown" } }, { target: { kind: "system", repo: "r" } },
    { target: { kind: "agent", agent: 42 } }, { target: { kind: "agent", agent: "a", repo: false } },
    { target: { kind: "repo-coordinator" } }, { target: { kind: "repo-coordinator", repo: "r", agent: "a" } },
    { files: [{ ...file, spellings: null }] }, { files: [{ ...file, spellings: [] }] },
    { files: [{ ...file, spellings: [2] }] }, { files: [{ ...file, spellings: [""] }] },
    { files: [{ ...file, spellings: ["./line\nbreak"] }] },
    { files: [{ ...file, spellings: ["./bi\u202edi"] }] },
    { files: [file, { ...file, name: "different" }] },
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
    await sendFileBody({ handle, size: data.length }, { write: async bytes => { chunks.push(Buffer.from(bytes)); return bytes.length; } }, {
      onProgress: total => progress.push(total),
    });
    expect(chunks.map(chunk => chunk.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 1]);
    expect(Buffer.concat(chunks)).toEqual(data);
    expect(progress).toEqual([CHUNK_BYTES, CHUNK_BYTES * 2, data.length]);

    for (const size of [data.length + 1, data.length - 1, 0]) {
      let sent = 0;
      await expect(sendFileBody({ handle, size }, { write: async bytes => { sent += bytes.length; return bytes.length; } }))
        .rejects.toThrow(size > data.length ? /short|EOF/i : /long|exceed/i);
      expect(sent).toBe(Math.min(size, data.length));
    }

    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<number>();
    const send = sendFileBody({ handle, size: data.length }, { write: () => { started.resolve(); return stalled.promise; } }, { signal: controller.signal });
    await started.promise;
    controller.abort(new Error("sender cancelled"));
    await expect(send).rejects.toThrow("sender cancelled");
    stalled.resolve(1);
  } finally {
    await handle?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest to header to message preserves the spellings of two image.png files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ib-frame-manifest-"));
  try {
    for (const folder of ["a", "b"]) {
      await mkdir(join(cwd, folder));
      await writeFile(join(cwd, folder, "image.png"), folder);
    }
    const entries = await buildAttachmentManifest(["./a/image.png", "./b/image.png"], { cwd, home: cwd, machine: "desk" });
    try {
      const files = await Promise.all(entries.map(async entry => ({
        name: entry.name, spellings: entry.spellings, size: entry.size, sha256: await hashFile(entry),
      })));
      const message = "./a/image.png ./b/image.png ./a/image.png";
      const decoded = await decodeSendHeader(new MemoryStream(encodeSendHeader({ ...header, files, message })));
      const mapping = decoded.files.map(({ name, spellings }, index) => ({ spellings, destination: "/tmp/" + index + "/" + name }));
      expect(rewriteAttachmentPaths(decoded.message, mapping)).toBe(
        "/tmp/0/image.png /tmp/1/image.png /tmp/0/image.png\n\nAttachments copied to this machine:" +
        "\n- ./a/image.png → /tmp/0/image.png\n- ./b/image.png → /tmp/1/image.png",
      );
    } finally {
      await Promise.all(entries.map(entry => entry.handle.close()));
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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

class IdleClock {
  now = 0;
  private pending = new Map<() => void, number>();
  setTimer = (ms: number, fn: () => void) => {
    expect(ms).toBe(IDLE_TIMEOUT_MS);
    this.pending.set(fn, this.now + ms);
    return () => { this.pending.delete(fn); };
  };
  advance(ms: number) {
    this.now += ms;
    for (const [fn, due] of this.pending) {
      if (due <= this.now) {
        this.pending.delete(fn);
        fn();
      }
    }
  }
}

test("header prefix and payload each time out or abort when their read stalls", async () => {
  for (const partial of [Buffer.alloc(2), encodeSendHeader(header).subarray(0, 7)]) {
    for (const abort of [false, true]) {
      const clock = new IdleClock();
      const controller = new AbortController();
      const memory = new MemoryStream(partial);
      const blocked = Promise.withResolvers<void>();
      const transfer = decodeSendHeader({ async read(n) {
        if (memory.offset < partial.length) return memory.read(n);
        blocked.resolve();
        return new Promise<number[]>(() => {});
      } }, { setTimer: clock.setTimer, signal: controller.signal });
      await blocked.promise;
      if (abort) controller.abort(new Error("cancel header"));
      else clock.advance(IDLE_TIMEOUT_MS);
      await expect(transfer).rejects.toThrow(abort ? /cancel header/ : /progress/i);
    }
  }
});

test("fragmented headers succeed across many idle intervals when each read progresses", async () => {
  const clock = new IdleClock();
  const stream = new MemoryStream(encodeSendHeader(header), 2);
  const decoded = await decodeSendHeader({ read(n) {
    clock.advance(IDLE_TIMEOUT_MS - 1);
    return stream.read(n);
  } }, { setTimer: clock.setTimer });
  expect(decoded).toEqual(header);
  expect(clock.now).toBeGreaterThan(3 * IDLE_TIMEOUT_MS);
});

test("receiver waits for the sink before reading again and progresses across idle intervals", async () => {
  const clock = new IdleClock();
  const bytes = Buffer.alloc(5 * CHUNK_BYTES, "123");
  const stream = new MemoryStream(bytes);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const transfer = streamFileBody({ read(n) {
    clock.advance(IDLE_TIMEOUT_MS / 3);
    return stream.read(n);
  } }, bytes.length, async () => {
    if (++writes === 1) {
      started.resolve();
      await release.promise;
    }
    clock.advance(IDLE_TIMEOUT_MS / 3);
  }, { setTimer: clock.setTimer });
  await started.promise;
  expect(stream.reads).toEqual([CHUNK_BYTES]);
  expect(stream.offset).toBe(CHUNK_BYTES);
  release.resolve();
  expect(await transfer).toBe(digest(bytes));
  expect(writes).toBe(5);
  expect(clock.now).toBeGreaterThan(3 * IDLE_TIMEOUT_MS);
});

test("positive partial writes renew the sender idle timer and preserve every byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ib-partial-write-"));
  try {
    const path = join(dir, "file");
    const body = Buffer.from("a flow-controlled file");
    await writeFile(path, body);
    const handle = await open(path, "r");
    try {
      const clock = new IdleClock();
      const sent: number[] = [];
      const progress: number[] = [];
      await sendFileBody({ handle, size: body.length }, { async write(bytes) {
        clock.advance(IDLE_TIMEOUT_MS - 1);
        const part = bytes.slice(0, 2);
        sent.push(...part);
        return part.length;
      } }, { setTimer: clock.setTimer, onProgress: n => progress.push(n) });
      expect(Buffer.from(sent)).toEqual(body);
      expect(progress).toEqual(Array.from({ length: Math.ceil(body.length / 2) }, (_, i) => Math.min(body.length, (i + 1) * 2)));
      expect(clock.now).toBeGreaterThan(2 * IDLE_TIMEOUT_MS);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort from the final receive progress callback rejects the body", async () => {
  const controller = new AbortController();
  const receive = streamFileBody(new MemoryStream(Buffer.from("x")), 1, () => {}, {
    signal: controller.signal,
    onProgress: () => controller.abort(new Error("cancel after last byte")),
  });
  await expect(receive).rejects.toThrow("cancel after last byte");
});

test("agent sender segments use the machine, registry and agent naming grammars", async () => {
  const parse = (id: string) => decodeSendHeader(new MemoryStream(encodeSendHeader({ ...header, from: { kind: "agent", id } })));
  for (const id of ["Adam’s Mac/Project_2/helper-1", "desk/milestonemade.com/worker-1", "desk/~3fa9c2d1/agent",
    "desk/site/milestonemade.com", "desk/" + "r".repeat(65) + "/a"]) {
    expect((await parse(id)).from).toEqual({ kind: "agent", id });
  }
  for (const bad of [" /repo/a", "desk/ /a", "desk/repo/ ", " desk/repo/a", "desk /repo/a", "../r/a",
    "x".repeat(33) + "/r/a", "desk/~/a", "desk/~3FA9C2D1/a", "desk/~3fa9c2d1x/a", "de\nsk/r/a", "de\u202esk/r/a",
    "desk/re\tpo/a", "desk/repo/a\n", "desk/./a", "desk/../a", "desk/r/.", "desk/r/..", "desk/r/@nick", "desk/r/nick name"]) {
    await expect(parse(bad)).rejects.toThrow(/malformed/i);
  }
});

for (const separator of ["\u2028", "\u2029"]) {
  test("rejects U+" + separator.codePointAt(0)!.toString(16) + " before a sender spelling reaches the mapping block", async () => {
    const bytes = encodeSendHeader({ ...header, files: [{ ...file, spellings: ["./image.png" + separator + "- extra line"] }] });
    const rewrite = decodeSendHeader(new MemoryStream(bytes)).then(decoded => rewriteAttachmentPaths(decoded.message,
      decoded.files.map(({ spellings }) => ({ spellings, destination: "/tmp/image.png" }))));
    await expect(rewrite).rejects.toThrow(/malformed/i);
  });
}
