import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_BODY_PRIORITY, PEER_CLOSE, requestWatchLog, serveTrustedConnection, type PeerResponderDeps } from "./peer-link";
import { encodeFrameHeader } from "./send-frame";
import { createFakeClock, createMemoryLink, type MemoryConnection, type MemoryStream } from "./test-pair-transport";
import { TransferActivity } from "./transfer-activity";
import { waitFor } from "../test-utils";
import {
  decodeWatchLogOutput, describeWatchLogFiles, encodeWatchLogOutput, readWatchLogFiles, WATCH_LOG_MAX_BYTES, type WatchLogFile,
} from "./watch-log-files";

const ID_A = "aa".repeat(32);
const ID_B = "bb".repeat(32);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("readWatchLogFiles", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ib-watch-log-files-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("reads the files that exist, as they are, newest first", async () => {
    const path = join(dir, "watch.log");
    await Bun.write(path, "newest\n");
    await Bun.write(`${path}.2`, Buffer.from([0, 0xff, 0x0a]));
    const files = await readWatchLogFiles(path);
    expect(files.map(file => file.name)).toEqual(["watch.log", "watch.log.2"]);
    expect(Buffer.from(files[0]!.body).toString()).toBe("newest\n");
    expect([...files[1]!.body]).toEqual([0, 0xff, 0x0a]);
  });

  test("no watch log at all is no files", async () => {
    expect(await readWatchLogFiles(join(dir, "watch.log"))).toEqual([]);
  });

  test("describes the count and size", () => {
    expect(describeWatchLogFiles([{ body: new Uint8Array(3 * 1024 ** 2 - 100 * 1024) }, { body: new Uint8Array(0) }])).toBe("2 files, 2.9 MB");
    expect(describeWatchLogFiles([{ body: new Uint8Array(10) }])).toBe("1 file, 0.0 MB");
  });
});

describe("the watch-log op", () => {
  let a: MemoryConnection;
  let b: MemoryConnection;
  let server: Promise<void> | undefined;
  let logs: string[];
  /** Each stream the responder accepted, to read its send priority. */
  let accepted: MemoryStream[];

  beforeEach(() => {
    ({ a, b } = createMemoryLink(ID_A, ID_B));
    logs = [];
    accepted = [];
    const acceptBi = b.acceptBi.bind(b);
    b.acceptBi = async () => {
      const stream = await acceptBi();
      accepted.push(stream as MemoryStream);
      return stream;
    };
    server = undefined;
  });
  afterEach(async () => {
    a.close(0, "done");
    await server;
  });

  function serve(deps: Partial<PeerResponderDeps>) {
    server = serveTrustedConnection(b, {
      peerName: async () => "Desk",
      snapshot: () => ({ repos: [], agents: [], coordinator: null, questions: [] }),
      setTimer: createFakeClock().setTimer,
      log: line => logs.push(line),
      ...deps,
    });
  }

  test("copies every file byte for byte, with the peer's name, version and clock", async () => {
    const files: WatchLogFile[] = [
      { name: "watch.log", body: randomBytes(1_500_000) },
      { name: "watch.log.1", body: Buffer.from("older line\n") },
      { name: "watch.log.2", body: new Uint8Array(0) },
    ];
    serve({ readWatchLog: async () => ({ name: "laptop", version: "0.1.3", files }) });
    const log = await requestWatchLog(a, createFakeClock().setTimer);
    expect(log.name).toBe("laptop");
    expect(log.version).toBe("0.1.3");
    expect(log.files.map(file => file.name)).toEqual(["watch.log", "watch.log.1", "watch.log.2"]);
    for (const [i, file] of log.files.entries()) expect(sha256(file.body)).toBe(sha256(files[i]!.body));
    // The peer stamps `now` between this side's send and header times.
    expect(log.sentAt).toBeLessThanOrEqual(log.now);
    expect(log.now).toBeLessThanOrEqual(log.headerAt);
    expect(log.headerAt).toBeLessThanOrEqual(log.doneAt);
    expect(accepted[0]!.priority).toBe(ATTACHMENT_BODY_PRIORITY);
    await Bun.sleep(0);
    expect(logs).toContain(`peer link: Desk (${ID_A.slice(0, 10)}) copied the watch log (3 files, 1.4 MB)`);
  });

  test("the requesting side hears of the header once it is valid, then the body bytes received so far", async () => {
    const files: WatchLogFile[] = [
      { name: "watch.log", body: randomBytes(150_000) },
      { name: "watch.log.1", body: Buffer.from("older line\n") },
    ];
    serve({ readWatchLog: async () => ({ name: "laptop", version: "0.1.3", files }) });
    const heard: string[] = [];
    const progress: number[] = [];
    await requestWatchLog(a, createFakeClock().setTimer, undefined, Date.now, {
      header: (count, bytes) => heard.push(`${count} files, ${bytes} bytes`),
      progress: bytes => progress.push(bytes),
    });
    expect(heard).toEqual(["2 files, 150011 bytes"]);
    expect(progress.at(-1)).toBe(150_011);
    expect(progress.length).toBeGreaterThan(2);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));
  });

  test("the responding side's reply write is a transfer: it moves bytes while it writes, then ends ok", async () => {
    const clock = createFakeClock();
    const transfers = new TransferActivity({ now: clock.now, log: line => logs.push(line) });
    const body = randomBytes(200_000);
    // The third write (after the header and the first body chunk) waits for the test.
    const release = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const acceptBi = b.acceptBi.bind(b);
    b.acceptBi = async () => {
      const stream = await acceptBi();
      const write = stream.write.bind(stream);
      let writes = 0;
      stream.write = async bytes => {
        if (writes++ === 2) { blocked.resolve(); await release.promise; }
        return write(bytes);
      };
      return stream;
    };
    serve({ transfers, readWatchLog: async () => ({ name: "laptop", version: "0.1.3", files: [{ name: "watch.log", body }] }) });
    const copying = requestWatchLog(a, createFakeClock().setTimer);
    await blocked.promise;
    const short = ID_A.slice(0, 10);
    expect(logs).toContain(`peer link: transfer started: watch-log to Desk (${short}): 1 file, 200000 bytes`);
    expect(transfers.recentProgress(ID_A)).toBe(true);
    release.resolve();
    expect(sha256((await copying).files[0]!.body)).toBe(sha256(body));
    await waitFor(() => logs.some(line => line.startsWith("peer link: transfer ok:")), { message: "transfer ok" });
    expect(logs.find(line => line.startsWith("peer link: transfer ok:"))).toStartWith(`peer link: transfer ok: watch-log to Desk (${short}): 200000 of 200000 bytes in 0.0 s, `);
    expect(transfers.recentProgress(ID_A)).toBe(false);
  });

  test("a reply write that fails ends the responder's transfer failed", async () => {
    const transfers = new TransferActivity({ now: Date.now, log: line => logs.push(line) });
    serve({ transfers, readWatchLog: async () => ({ name: "laptop", version: "0.1.3", files: [{ name: "watch.log", body: randomBytes(200_000) }] }) });
    const stream = await a.openBi();
    await stream.writeAll(Buffer.from(JSON.stringify({ op: "watch-log" })));
    await stream.finish();
    await stream.stopReceiving(); // the requester gave up on the reply
    await waitFor(() => logs.some(line => line.startsWith("peer link: transfer failed")), { message: "transfer failed" });
    expect(logs.find(line => line.startsWith("peer link: transfer failed"))).toMatch(/^peer link: transfer failed \(.+\): watch-log to Desk \(aaaaaaaaaa\): \d+ of 200000 bytes in /);
    expect(logs).toContain(`peer link: sending the watch log to Desk (${ID_A.slice(0, 10)}) failed`);
  });

  test("a machine with no watch log answers with no files", async () => {
    serve({ readWatchLog: async () => ({ name: "laptop", version: "0.1.3", files: [] }) });
    const log = await requestWatchLog(a, createFakeClock().setTimer);
    expect(log.files).toEqual([]);
  });

  test("a peer whose ib has no watch-log op: its error is reported as the peer's", async () => {
    const pending = requestWatchLog(a, createFakeClock().setTimer);
    const stream = await b.acceptBi();
    expect(JSON.parse(Buffer.from(await stream.readToEnd(4096)).toString())).toEqual({ op: "watch-log" });
    await stream.writeAll(Buffer.from(JSON.stringify({ op: "error", reason: 'unknown op "watch-log"' })));
    await stream.finish();
    await expect(pending).rejects.toThrow('the peer replied: unknown op "watch-log"');
  });

  test("files over the 8 MB cap are refused, and the refusal is logged", async () => {
    const files: WatchLogFile[] = [{ name: "watch.log", body: new Uint8Array(WATCH_LOG_MAX_BYTES + 1) }];
    serve({ readWatchLog: async () => ({ name: "laptop", version: "0.1.3", files }) });
    const reason = `The watch log files total ${WATCH_LOG_MAX_BYTES + 1} bytes, over the ${WATCH_LOG_MAX_BYTES}-byte limit`;
    await expect(requestWatchLog(a, createFakeClock().setTimer)).rejects.toThrow(`the peer replied: ${reason}`);
    expect(logs).toContain(`peer link: watch log request from Desk (${ID_A.slice(0, 10)}) failed: ${reason}`);
  });

  test("a responder that cannot read its files says so", async () => {
    serve({ readWatchLog: async () => { throw new Error("EACCES: permission denied, open 'watch.log'"); } });
    await expect(requestWatchLog(a, createFakeClock().setTimer)).rejects.toThrow("the peer replied: EACCES: permission denied, open 'watch.log'");
  });

  test("a peer removed while the files are read is not answered", async () => {
    let paired = true;
    serve({
      peerName: async () => paired ? "Desk" : null,
      readWatchLog: async () => {
        paired = false;
        return { name: "laptop", version: "0.1.3", files: [{ name: "watch.log", body: Buffer.from("x") }] };
      },
    });
    await expect(requestWatchLog(a, createFakeClock().setTimer)).rejects.toThrow();
    expect(b.closes).toContainEqual({ code: PEER_CLOSE.notPeer, reason: "not a peer" });
  });

  async function answerWith(header: object, bodies: Uint8Array[] = []) {
    const pending = requestWatchLog(a, createFakeClock().setTimer);
    const stream = await b.acceptBi();
    await stream.readToEnd(4096);
    await stream.writeAll(encodeFrameHeader(header));
    for (const body of bodies) await stream.writeAll(body);
    await stream.finish();
    return pending;
  }

  const good = { op: "watch-log", now: 1, version: "0.1.3", name: "laptop" };

  test.each([
    ["a name outside the three log files", { ...good, files: [{ name: "../x", size: 1, sha256: "0".repeat(64) }] }],
    ["the same file twice", { ...good, files: [{ name: "watch.log", size: 0, sha256: sha256(new Uint8Array()) }, { name: "watch.log", size: 0, sha256: sha256(new Uint8Array()) }] }],
    ["a missing clock", { ...good, now: "soon", files: [] }],
    ["another op", { ...good, op: "agent-diff", files: [] }],
  ])("refuses a header with %s", async (_what, header) => {
    await expect(answerWith(header)).rejects.toThrow("Malformed watch-log header");
  });

  test("refuses a declared total over the cap before reading a body", async () => {
    const header = { ...good, files: [{ name: "watch.log", size: WATCH_LOG_MAX_BYTES + 1, sha256: "0".repeat(64) }] };
    await expect(answerWith(header)).rejects.toThrow(`over the ${WATCH_LOG_MAX_BYTES}-byte limit`);
  });

  test("refuses a body whose hash does not match", async () => {
    const header = { ...good, files: [{ name: "watch.log", size: 1, sha256: "0".repeat(64) }] };
    await expect(answerWith(header, [Uint8Array.of(7)])).rejects.toThrow("watch.log hash mismatch");
  });
});

test("a fetched copy survives the trip from ib watch to the CLI", () => {
  const log = {
    name: "laptop", version: "0.1.3", now: 10, sentAt: 9, headerAt: 11, doneAt: 12,
    files: [{ name: "watch.log" as const, body: Buffer.from([0, 1, 2, 0xff]) }],
  };
  const decoded = decodeWatchLogOutput(encodeWatchLogOutput(log));
  expect({ ...decoded, files: [] }).toEqual({ ...log, files: [] });
  expect([...decoded.files[0]!.body]).toEqual([0, 1, 2, 0xff]);
  expect(() => decodeWatchLogOutput(JSON.stringify({ ...JSON.parse(encodeWatchLogOutput(log)), files: [{ name: "../x", base64: "" }] })))
    .toThrow("malformed watch log copy");
});
