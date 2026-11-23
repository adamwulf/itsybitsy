import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, open, readdir, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { createCliFixture, type CliFixture } from "../test-cli-runner";
import { setUserHome, resetUserHome } from "../home";
import { drainOutbox, resetSendSpawnRunner, setSendSpawnRunner } from "../ib-commands";
import { makeAgent, makeSpawnResult, waitFor } from "../test-utils";
import { spawnCtx as paneProbe } from "../tmux-poller";
import { acquireOutboxLock, outboxPath, readOutbox } from "../outbox";
import { createMessageReceiver } from "./receive-message";
import { createFakeClock, createMemoryLink } from "./test-pair-transport";
import { requestSend, serveTrustedConnection } from "./peer-link";
import { encodeSendHeader, type SendHeader } from "./send-frame";

let cli: CliFixture;
let repo: string;
let receiver: ReturnType<typeof createMessageReceiver>;
let lines: string[];
const paired = async () => "desk";
const header = (fields: Partial<SendHeader> = {}): SendHeader => ({
  op: "send", id: crypto.randomUUID(), files: [], message: "/compact",
  from: { kind: "user" }, target: { kind: "agent", agent: "worker" }, ...fields,
});

beforeEach(async () => {
  cli = await createCliFixture();
  setUserHome(cli.home);
  await Bun.write(join(cli.home, ".itsybitsy/machine-name"), "laptop");
  repo = await cli.addRepo("photos");
  for (const id of ["worker", "photos"]) {
    const { agentDir } = await cli.addAgent(repo, id, {
      tmux_session: "ib-" + id, ...(id === "photos" && { agentType: "repo-coordinator" }),
    });
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
  }
  lines = [];
  receiver = createMessageReceiver(() => {}, line => lines.push(line), Date.now, 4096, { tempDir: cli.root, hasFreeSpace: async () => true });
  setSendSpawnRunner(() => makeSpawnResult());
  paneProbe.set(() => makeSpawnResult(0, "0"));
});
afterEach(async () => {
  resetSendSpawnRunner();
  paneProbe.reset();
  resetUserHome();
  await cli.cleanup();
});

async function exchange(request: SendHeader, name: () => Promise<string | null> = paired, revoked = false, data?: Uint8Array) {
  const { a, b } = createMemoryLink("authenticated", "destination");
  const serving = serveTrustedConnection(b, {
    peerName: name, receiveMessage: receiver, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    log() {}, setTimer(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  });
  try {
    const stream = await a.openBi();
    await stream.writeAll(encodeSendHeader(request));
    if (data) await stream.writeAll(data);
    await stream.finish();
    return JSON.parse(new TextDecoder().decode(await stream.readToEnd(4096)));
  } finally { if (revoked) expect(a.closeInfo()).toMatchObject({ code: 1 }); a.close(0, "done"); await serving; }
}

test("concurrent and subsequent repeats acknowledge once, with sender attribution in the real queue", async () => {
  for (const from of [{ kind: "user" }, { kind: "agent", id: "desk/tools/alice" }, { kind: "system" }] as const) {
    const request = header({ from, message: from.kind + " hello" });
    const replies = await Promise.all([exchange(request), exchange(request)]);
    for (const reply of [...replies, await exchange(request)]) expect(reply).toEqual({ ok: true, id: request.id });
  }
  const queued = await readOutbox(join(cli.home, ".itsybitsy", "agents", "worker"));
  expect(queued.map(item => item.fromAgent)).toEqual(["", "desk/tools/alice", "desk/@system"]);
  expect(lines).toEqual(Array(3).fill("desk sent a message to worker"));
});

test("the ordinary drainer applies passthrough and peer labels to the queued text", async () => {
  const calls: string[][] = [];
  setSendSpawnRunner(cmd => { calls.push(cmd); return makeSpawnResult(); });
  for (const [from, message] of [
    [{ kind: "user" }, "/compact"], [{ kind: "user" }, "!pwd"],
    [{ kind: "agent", id: "desk/tools/alice" }, "/compact"], [{ kind: "system" }, "!pwd"],
  ] as const) {
    expect(await exchange(header({ from, message }))).toMatchObject({ ok: true });
  }
  const agent = makeAgent({ id: "worker", repoPath: repo });
  const result = await drainOutbox(agent, join(cli.home, ".itsybitsy", "agents", agent.id));
  expect(result.ok).toBe(true);
  expect(calls.filter(cmd => cmd.includes("-l")).map(cmd => cmd.at(-1))).toEqual([
    "/compact", "!pwd", "[sent by agent desk/tools/alice]: /compact", "[sent by desk/@system]: !pwd",
  ]);
});

test("wire ids ignore recycled nicknames and select the keyed queue of the named repo", async () => {
  await cli.addAgent(repo, "replacement", { nickname: "old-id" });
  expect(await exchange(header({ target: { kind: "agent", repo: "photos", agent: "old-id" } }))).toMatchObject({ op: "error" });
  const other = await cli.addRepo("other");
  for (const [path, name] of [[repo, "photos"], [other, "other"]] as const) {
    const key = "home/" + name + "/same";
    const { agentDir } = await cli.addAgent(path, "same", { queue_key: key });
    await mkdir(join(cli.home, ".itsybitsy", "agents", key), { recursive: true });
    await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
  }
  expect(await exchange(header({ target: { kind: "agent", repo: "other", agent: "same" } }))).toMatchObject({ ok: true });
  const base = join(cli.home, ".itsybitsy", "agents", "home");
  expect(await readOutbox(join(base, "photos", "same"))).toHaveLength(0);
  expect(await readOutbox(join(base, "other", "same"))).toHaveLength(1);
});

test("a differently cased UUID is still a replay after the recipient drained", async () => {
  const original = header({ id: "aaaaaaaa-1234-1234-1234-123456789abc" });
  expect(await exchange(original)).toMatchObject({ ok: true });
  const dir = join(cli.home, ".itsybitsy", "agents", "worker");
  await drainOutbox(makeAgent({ id: "worker", repoPath: repo }), dir);
  expect(await exchange({ ...original, id: original.id.toUpperCase() })).toMatchObject({ ok: true });
  expect(await readOutbox(dir)).toEqual([]);
});

test("cache capacity retains accepted ids for ten minutes, independently per peer", async () => {
  let now = 0;
  const receive = createMessageReceiver(() => {}, line => lines.push(line), () => now, 2);
  const request = header();
  await receive(request, "peer-a", paired);
  now++;
  await receive(request, "peer-b", paired);
  now = 599_999;
  await expect(receive(header(), "peer-a", paired)).rejects.toThrow("busy, try again");
  await receive(request, "peer-a", paired);
  expect(lines).toHaveLength(2);
  now++;
  await receive(request, "peer-a", paired);
  await receive(request, "peer-b", paired);
  expect(lines).toHaveLength(3);
});

// The sandbox cannot bind native iroh endpoints. The fake clock drives the
// full idle window and the transport records the QUIC close following FIN.
test.each(["header", "FIN"])("stalled %s stops the receive half and returns the idle error", async stage => {
  const { a, b } = createMemoryLink("sender", "receiver");
  const clock = createFakeClock();
  const stream = await a.openBi();
  const response = await b.acceptBi();
  const finished = Promise.withResolvers<void>();
  const finish = response.finish.bind(response);
  response.finish = async () => { await finish(); finished.resolve(); };
  // QUIC can acknowledge every reply byte while the client has yet to read.
  response.stopReceiving = async () => { await b.closed(); };
  const close = spyOn(b, "close");
  const accept = b.acceptBi.bind(b);
  b.acceptBi = async () => { b.acceptBi = accept; return response; };
  const serving = serveTrustedConnection(b, { peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    log() {}, receiveMessage: receiver, setTimer: clock.setTimer });
  try {
    await stream.writeAll(stage === "header" ? Uint8Array.of(0) : encodeSendHeader(header()));
    await Bun.sleep(0);
    clock.advance(60_000);
    await finished.promise;
    await Bun.sleep(0);
    clock.advance(4999);
    expect(a.closeInfo()).toBeNull();
    if (stage === "header") {
      const reply = JSON.parse(new TextDecoder().decode(await stream.readToEnd(4096)));
      expect(reply).toMatchObject({ op: "error", reason: expect.stringContaining("No progress") });
      a.close(0, "read the error");
    } else {
      clock.advance(1); // The ACK finished before the single teardown owner closed.
      expect(await a.closed()).toMatchObject({ byPeer: true, code: 3, reason: "send read stalled" });
      expect(close).toHaveBeenCalledTimes(1);
    }
    await serving;
    await expect(stream.writeAll(Uint8Array.of(1))).rejects.toThrow();
  } finally { a.close(0, "done"); await serving; }
});

test("unknown, stopped, unpaired and attachment sends are refused before queueing", async () => {
  expect(await exchange(header({ target: { kind: "agent", agent: "missing" } }))).toMatchObject({ op: "error", reason: expect.stringContaining("not found") });
  const files = [{ name: "a", size: 0, sha256: "0".repeat(64), spellings: ["a"] }];
  expect(await exchange(header({ files }))).toEqual({ op: "error", reason: "Attachment hash mismatch" });
  let checks = 0;
  await expect(exchange(header(), async () => ++checks < 4 ? "desk" : null, true)).rejects.toThrow();
  paneProbe.set(cmd => {
    if (cmd[1] === "list-panes") return makeSpawnResult(0, "1\n0"); // live auxiliary window
    expect(cmd).toEqual(["tmux", "display-message", "-p", "-t", "=ib-worker:", "#{pane_dead}"]);
    return makeSpawnResult(0, "1"); // dead delivery pane
  });
  expect(await exchange(header())).toMatchObject({ op: "error", reason: expect.stringContaining("not running") });
  paneProbe.set(() => makeSpawnResult(1, "", "no such session"));
  expect(await exchange(header())).toMatchObject({ op: "error", reason: expect.stringContaining("not running") });
  expect(lines).toEqual([]);
  expect(await readOutbox(join(cli.home, ".itsybitsy", "agents", "worker"))).toEqual([]);
});

test("repo and system coordinators use their own queues", async () => {
  const request = header({ target: { kind: "repo-coordinator", repo: "PHOTOS" } });
  expect(await exchange(request)).toEqual({ ok: true, id: request.id });
  expect(await readOutbox(join(cli.home, ".itsybitsy", "agents", "photos"))).toMatchObject([{ fromAgent: "", raw: false, message: "/compact" }]);
  paneProbe.set(() => makeSpawnResult(0, "1"));
  expect(await exchange(header({ target: { kind: "system" } }))).toMatchObject({ op: "error", reason: expect.stringContaining("not running") });
  paneProbe.set(() => makeSpawnResult(0, "0"));
  // Hold the normal coordinator queue lock until after inspecting the acceptance.
  const dir = join(cli.home, ".itsybitsy");
  await Bun.write(join(dir, ".outbox.lock"), String(process.pid));
  expect(await exchange(header({ target: { kind: "system" } }))).toMatchObject({ ok: true });
  expect(await readOutbox(dir)).toMatchObject([{ message: "/compact", raw: false }]);
  await unlink(join(dir, ".outbox.lock"));
  await waitFor(async () => !(await readOutbox(dir)).length);
});

test("remote @system acknowledges enqueue and the local inline drainer steals an abandoned lock", async () => {
  const dir = join(cli.home, ".itsybitsy");
  const abandoned = await acquireOutboxLock(dir);
  if (!abandoned) throw new Error("fixture could not acquire coordinator lock");
  const old = new Date(Date.now() - 31_000);
  await utimes(abandoned.path, old, old);
  const release = Promise.withResolvers<number>();
  const entered = Promise.withResolvers<string[]>();
  setSendSpawnRunner(cmd => {
    if (cmd.includes("-l")) {
      entered.resolve(cmd);
      return { ...makeSpawnResult(), exited: release.promise };
    }
    return makeSpawnResult();
  });
  try {
    expect(await exchange(header({ target: { kind: "system" } }))).toMatchObject({ ok: true });
    const typed = await entered.promise;
    expect(typed).toContain("=ib-coordinator:");
    expect(typed.at(-1)).toBe("/compact");
    // No fixture release: delivery is paused under the replacement lock.
    expect(await Bun.file(abandoned.path).text()).not.toContain(abandoned.token);
  } finally { release.resolve(0); }
  await waitFor(async () => !(await readOutbox(join(cli.home, ".itsybitsy"))).length);
});

test("a stalled delivery probe is killed and reaped", async () => {
  const { isDeliveryPaneLive } = await import("../tmux-poller");
  const exit = Promise.withResolvers<number>();
  let reaped = false;
  paneProbe.set(() => ({
    ...makeSpawnResult(), exited: exit.promise.then(code => { reaped = true; return code; }),
    kill: () => { exit.resolve(1); },
  }));
  await expect(isDeliveryPaneLive("ib-worker", 5)).rejects.toThrow("timed out");
  expect(reaped).toBe(true);
});

test.each(["write", "finish"] as const)("a stalled acknowledgement %s cancels its stream", async op => {
  const { a, b } = createMemoryLink("sender", "receiver");
  const client = await a.openBi();
  const server = await b.acceptBi();
  const entered = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  server[op] = async () => { entered.resolve(); await b.closed(); throw new Error("connection closed"); };
  server.cancel = async () => { cancelling.resolve(); await b.closed(); };
  const accept = b.acceptBi.bind(b);
  b.acceptBi = async () => { b.acceptBi = accept; return server; };
  const clock = createFakeClock();
  const serving = serveTrustedConnection(b, {
    peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    log() {}, receiveMessage: receiver, setTimer: clock.setTimer,
  });
  try {
    await client.writeAll(encodeSendHeader(header()));
    await client.finish();
    await entered.promise;
    const ack = client.readToEnd(4096);
    clock.advance(60_000);
    await cancelling.promise;
    expect(a.closeInfo()).toBeNull();
    clock.advance(5000);
    await expect(ack).rejects.toThrow();
    expect(a.closeInfo()).toMatchObject({ byPeer: true, reason: "send reply stalled" });
    expect(lines).toHaveLength(1);
  } finally { a.close(0, "done"); await serving; }
});

function manifestFile(data: string, name = "../nested/a.txt", spelling = "./source") {
  return { name, size: Buffer.byteLength(data), sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"), spellings: [spelling] };
}

async function receiveFixture(space = true) {
  const dir = join(cli.root, "received");
  await mkdir(dir);
  receiver = createMessageReceiver(() => {}, line => lines.push(line), Date.now, 4096, { tempDir: dir, stagingRoot: join(cli.root, "staging"), hasFreeSpace: async () => space });
  return dir;
}

test("verified files are private, sanitized, mapped once, and retained across a replay", async () => {
  const dir = await receiveFixture();
  const files = [manifestFile("one", "../unsafe/a.txt"), manifestFile("two", "../other/a.txt", "./another")];
  const req = header({ message: "/compact ./source", files });
  for (let i = 0; i < 2; i++) expect(await exchange(req, paired, false, Buffer.from("onetwo"))).toEqual({ ok: true, id: req.id });
  const roots = await readdir(dir);
  expect(roots).toHaveLength(1);
  const root = join(dir, roots[0]!);
  const paths = [join(root, "0/a.txt"), join(root, "1/a.txt")];
  expect(await Promise.all(paths.map(p => Bun.file(p).text()))).toEqual(["one", "two"]);
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect((await stat(paths[0]!)).mode & 0o777).toBe(0o600);
  expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toMatchObject([{
    noPassthrough: true, message: `/compact ${paths[0]}

Attachments copied to this machine:
- ./source → ${paths[0]}
- ./another → ${paths[1]}`,
  }]);
  expect(lines).toEqual(["desk sent a message (2 files, 0.00 MB) to worker"]);
});

test.each(["hash", "short", "trailing", "disk", "revoked", "stall", "malformed"])("attachment %s failure retains no files or queue entry", async kind => {
  const dir = await receiveFixture(kind !== "disk");
  const files = [manifestFile("abc")];
  if (kind === "malformed") files[0]!.sha256 = "wrong";
  const req = header({ files });
  if (kind === "stall") {
    let reading = false;
    const clock = createFakeClock();
    const result = receiver(req, "peer", paired, { read: () => { reading = true; return new Promise(() => {}); } }, { setTimer: clock.setTimer });
    await waitFor(() => reading);
    clock.advance(60_000);
    await expect(result).rejects.toThrow("No progress");
  } else if (kind === "revoked") {
    let checks = 0;
    await expect(exchange(req, async () => ++checks < 4 ? "desk" : null, true, Buffer.from("abc"))).rejects.toThrow();
    await waitFor(async () => !(await readdir(dir)).length);
  } else {
    const data = { hash: "abd", short: "ab", trailing: "abcd", disk: "", malformed: "" }[kind]!;
    const error = { hash: "hash mismatch", short: "Early EOF", trailing: "Trailing data", disk: "1 GiB", malformed: "Malformed" }[kind]!;
    expect(await exchange(req, paired, false, Buffer.from(data))).toMatchObject({ op: "error", reason: expect.stringContaining(error) });
  }
  expect(await readdir(dir)).toEqual([]);
  expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toEqual([]);
});

test.each([
  ["maxFileMB", 1, [1048577]], ["maxMessageMB", 1, [700000, 700000]], ["maxFiles", 1, [1, 1]],
  ...["maxFileMB", "maxMessageMB", "maxFiles"].flatMap(key => [[key, 0, [0]], [key, 0, [1]]] as const),
] as const)("uses this receiver's live %s = %i for sizes %j", async (key, value, sizes) => {
  await receiveFixture();
  const first = header({ files: [manifestFile("")] });
  expect(await exchange(first)).toMatchObject({ ok: true });
  await Bun.write(join(cli.home, ".itsybitsy/config.json"), JSON.stringify({ peering: { attachments: { maxFileMB: 1, [key]: value } } }));
  const req = header({ files: sizes.map((size, i) => ({ ...manifestFile("", "a", String(i)), size })) });
  expect(await exchange(req)).toMatchObject({ op: "error", reason: expect.stringContaining(`laptop (peering.attachments.${key} = ${value})`) });
  expect(await exchange(header())).toMatchObject({ ok: true });
});

test("one transfer per peer and two across the watcher; failed readers release their slots", async () => {
  await receiveFixture();
  const req = () => header({ files: [manifestFile("x")] });
  const finish = Promise.withResolvers<Uint8Array>();
  let reads = 0;
  const body = { read: () => { reads++; return finish.promise; } };
  const first = receiver(req(), "one", paired, body);
  await waitFor(() => reads === 1);
  await expect(receiver(req(), "one", paired, body)).rejects.toThrow("busy, try again");
  const second = receiver(req(), "two", paired, body);
  await waitFor(() => reads === 2);
  await expect(receiver(req(), "three", paired, body)).rejects.toThrow("busy, try again");
  finish.resolve(new Uint8Array());
  expect((await Promise.allSettled([first, second])).map(r => r.status)).toEqual(["rejected", "rejected"]);
  expect(await exchange(header({ files: [manifestFile("")] }))).toMatchObject({ ok: true });
});

test("multi-megabyte send streams through the receiver with bounded reads and cumulative progress", async () => {
  const dir = await receiveFixture();
  const filesDir = join(cli.root, "files");
  await mkdir(filesDir);
  const chunk = Buffer.alloc(64 * 1024, 17);
  const chunks = 65;
  const hasher = new Bun.CryptoHasher("sha256");
  const handle = await open(join(filesDir, "0"), "wx");
  try {
    for (let i = 0; i < chunks; i++) { await handle.writeFile(chunk); hasher.update(chunk); }
  } finally { await handle.close(); }
  const size = chunks * chunk.length;
  const files = [{ name: "large", size, sha256: hasher.digest("hex"), spellings: ["/large"] }];
  const req = header({ files });
  const { a, b } = createMemoryLink("one", "two");
  let maxRead = 0;
  let bodyReads = 0;
  const timer = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
  const serving = serveTrustedConnection(b, {
    peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }), log() {}, setTimer: timer,
    receiveMessage: (header, peer, name, body, options) => receiver(header, peer, name, {
      read: limit => { maxRead = Math.max(maxRead, limit); bodyReads++; return body!.read(limit); },
    }, options),
  });
  let sent = 0;
  try {
    expect(await requestSend(a, req, timer, { filesDir, onProgress: n => { expect(n - sent).toBeLessThanOrEqual(chunk.length); sent = n; } })).toBe(req.id);
    expect(sent).toBe(size);
    expect(maxRead).toBe(chunk.length);
    expect(bodyReads).toBeGreaterThanOrEqual(chunks + 1);
    const [root] = await readdir(dir);
    expect((await stat(join(dir, root!, "0/large"))).size).toBe(size);
  } finally { a.close(0, "done"); await serving; }
});

test("a read half that rejects stop after FIN still delivers the attachment acknowledgement", async () => {
  await receiveFixture();
  const { a, b } = createMemoryLink("sender", "receiver");
  const accept = b.acceptBi.bind(b);
  let stopsAfterFin = 0;
  let earlyStops = 0;
  b.acceptBi = async () => {
    const stream = await accept();
    const read = stream.read.bind(stream);
    const stop = stream.stopReceiving.bind(stream);
    let finished = false;
    stream.read = async limit => {
      const chunk = await read(limit);
      if (chunk.length === 0) finished = true;
      return chunk;
    };
    stream.stopReceiving = async () => {
      if (finished) { stopsAfterFin++; throw new Error("receive half already consumed"); }
      earlyStops++;
      await stop();
    };
    return stream;
  };
  const timer = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
  const serving = serveTrustedConnection(b, { peerName: paired, receiveMessage: receiver,
    snapshot: () => ({ agents: [], repos: [], coordinator: null }), log() {}, setTimer: timer });
  const filesDir = join(cli.root, "staged");
  await Bun.write(join(filesDir, "0"), "hello");
  const request = header({ files: [manifestFile("hello")] });
  try {
    expect(await requestSend(a, request, timer, { filesDir })).toBe(request.id);
    expect(await requestSend(a, request, timer, { filesDir })).toBe(request.id);
    expect(stopsAfterFin).toBe(0);
    expect(earlyStops).toBe(1); // the replay has an unread body
    expect(lines).toHaveLength(1);
  } finally { a.close(0, "done"); await serving; }
});

test.each(["body", "ack"])("cancelling while the %s is pending resets the exchange", async stage => {
  const filesDir = join(cli.root, "outgoing");
  await mkdir(filesDir);
  await Bun.write(join(filesDir, "0"), "x");
  const { a, b } = createMemoryLink("sender", "receiver");
  const stream = await a.openBi();
  a.openBi = async () => stream;
  const pending = Promise.withResolvers<void>();
  if (stage === "body") {
    const write = stream.write.bind(stream);
    stream.write = async bytes => {
      if (bytes.length !== 1) return write(bytes);
      pending.resolve();
      await a.closed();
      throw new Error("closed");
    };
  } else {
    const read = stream.read.bind(stream);
    stream.read = limit => { pending.resolve(); return read(limit); };
  }
  const controller = new AbortController();
  const timer = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
  const sending = requestSend(a, header({ files: [manifestFile("x")] }), timer, { filesDir, signal: controller.signal });
  try {
    const received = await b.acceptBi();
    await pending.promise;
    controller.abort(new Error("cancelled"));
    await expect(sending).rejects.toThrow(stage === "body" ? "cancelled" : "outcome unknown");
    await expect(received.writeAll(Buffer.from("late"))).rejects.toThrow();
  } finally { a.close(0, "done"); }
});

test("concurrent peers reserve outstanding bytes until write or failure", async () => {
  const budgets: number[] = [];
  const receive = createMessageReceiver(() => {}, () => {}, Date.now, 4096, {
    tempDir: cli.root, hasFreeSpace: async (_dir, bytes) => { budgets.push(bytes); return bytes <= 4; },
  });
  const request = () => header({ files: [manifestFile("abc")] });
  const held = Promise.withResolvers<Uint8Array>();
  const first = receive(request(), "a", paired, { read: () => held.promise });
  await waitFor(() => budgets.length === 1);
  await expect(receive(request(), "b", paired, { read: async () => Buffer.alloc(0) })).rejects.toThrow("Insufficient space");
  held.resolve(Buffer.alloc(0));
  await expect(first).rejects.toThrow("Early EOF");
  await expect(receive(request(), "b", paired, { read: async () => Buffer.alloc(0) })).rejects.toThrow("Early EOF");
  expect(budgets).toEqual([3, 6, 3]);
});

test("pending replay and framed header readers have independent watcher-wide ceilings", async () => {
  const req = header({ files: [manifestFile("x")] });
  const body = Promise.withResolvers<Uint8Array>();
  const requests = Array.from({ length: 9 }, () => receiver(req, "a", paired, { read: () => body.promise }));
  const done = Promise.allSettled(requests);
  await expect(receiver(req, "a", paired)).rejects.toThrow("busy");
  body.resolve(Buffer.alloc(0));
  expect((await done).every(r => r.status === "rejected")).toBe(true);
  const deps = { peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    headerReaders: new Set<import("./pairing").PairStream>(), setTimer: createFakeClock().setTimer, log() {} };
  const links = [createMemoryLink("a", "local"), createMemoryLink("b", "local")];
  const serving = links.map(link => serveTrustedConnection(link.b, deps));
  try {
    for (let i = 0; i < 8; i++) await (await links[i % 2]!.a.openBi()).writeAll(Uint8Array.of(0));
    await waitFor(() => deps.headerReaders.size === 8);
    const conn = links[0]!.a;
    const open = conn.openBi.bind(conn);
    conn.openBi = async () => {
      const stream = await open();
      let count = 0;
      stream.write = async () => {
        if (++count === 1) return 1;
        throw new Error("receiver stopped reading the header");
      };
      return stream;
    };
    await expect(requestSend(conn, header(), deps.setTimer)).rejects.toThrow("busy, try again");
  } finally { links.forEach(link => link.a.close(0, "done")); await Promise.all(serving); }
});

test("a stuck sender reset closes the connection and releases a partial receipt", async () => {
  const dir = await receiveFixture();
  const filesDir = join(cli.root, "staged");
  await mkdir(filesDir);
  await Bun.write(join(filesDir, "0"), "abc");
  const { a, b } = createMemoryLink("sender", "receiver");
  const stream = await a.openBi();
  a.openBi = async () => stream;
  const write = stream.write.bind(stream);
  stream.write = async bytes => {
    if (bytes.length === 3) return write(bytes.subarray(0, 1));
    if (bytes.length === 2) { await a.closed(); throw Error("closed"); }
    return write(bytes);
  };
  stream.cancel = () => new Promise(() => {});
  const controller = new AbortController();
  const timer = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms === 5000 ? 5 : ms); return () => clearTimeout(t); };
  const handler = Promise.withResolvers<void>();
  const serving = serveTrustedConnection(b, { peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    setTimer: timer, log() {}, receiveMessage: async (...args) => {
      try { await receiver(...args); } finally { handler.resolve(); }
    } });
  const sending = requestSend(a, header({ files: [manifestFile("abc")] }), timer, { filesDir, signal: controller.signal });
  await waitFor(async () => {
    const partials = join(cli.root, "staging/incoming");
    const [root] = await readdir(partials).catch(() => []);
    return !!root && (await stat(join(partials, root, "0/a.txt")).catch(() => null))?.size === 1;
  });
  controller.abort(Error("cancelled"));
  await expect(sending).rejects.toThrow("cancelled");
  await Promise.all([serving, handler.promise]);
  expect(await readdir(dir)).toEqual([]);
  await receiver(header({ files: [manifestFile("")] }), "sender", paired, { read: async () => Buffer.alloc(0) });
});

test.each(["shutdown", "cancel"])("%s cleans a tracked receipt after its first byte", async action => {
  const dir = await receiveFixture();
  const { PeerService, defaultPeerServiceDeps } = await import("./service");
  const service = new PeerService({ ...defaultPeerServiceDeps("local", () => {}, () => ({ agents: [], repos: [], coordinator: null }), () => {}, null), receiveMessage: receiver });
  let started = false;
  const receipt = service.receiveTracked(header({ files: [manifestFile("abc")] }), "peer", paired, {
    read: () => { if (started) return new Promise(() => {}); started = true; return Promise.resolve(Buffer.from("a")); },
  });
  const stopped = receipt.catch(err => err);
  await waitFor(() => service.view().incoming?.[0]?.bytes === 1);
  if (action === "shutdown") await service.shutdown();
  else service.cancelReceipt(service.view().incoming![0]!.id);
  expect(await stopped).toBeInstanceOf(Error);
  expect(await readdir(dir)).toEqual([]);
  expect(service.view().incoming ?? []).toEqual([]);
  expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toEqual([]);
});

test("requestSend retains the machine, key and value of a long file limit error", async () => {
  const { a, b } = createMemoryLink("sender", "local");
  const timer = createFakeClock().setTimer;
  const req = header();
  const serving = serveTrustedConnection(b, { peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }), log() {}, setTimer: timer,
    receiveMessage: async () => { throw Error("File " + "x".repeat(900) + " exceeds the limit on laptop (peering.attachments.maxFileMB = 1)"); },
  });
  try {
    const result = await requestSend(a, req, timer).catch((err: Error) => err.message);
    expect(result).toContain("laptop (peering.attachments.maxFileMB = 1)");
    expect(result.length).toBeLessThanOrEqual(300);
  }
  finally { a.close(0, "done"); await serving; }
});

test("exclusive destination creation preserves existing bytes and cleans the failed receipt", async () => {
  const dir = await receiveFixture();
  const existing = join(cli.root, "existing");
  await Bun.write(existing, "original");
  const openFile = fs.open;
  const collision = spyOn(fs, "open").mockImplementation(async (path, ...args) => {
    if (String(path).startsWith(join(cli.root, "staging/incoming") + "/") && String(path).endsWith("/a.txt")) await fs.link(existing, path);
    return openFile(path, ...args);
  });
  try {
    expect(await exchange(header({ files: [manifestFile("replacement")] }), paired, false, Buffer.from("replacement"))).toMatchObject({ op: "error" });
    expect(await Bun.file(existing).text()).toBe("original");
    expect(await readdir(dir)).toEqual([]);
    expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toEqual([]);
  } finally { collision.mockRestore(); }
});

test.each(["second hash", "target stopped"])("%s after writing the first file rolls back the entire receipt", async kind => {
  const dir = await receiveFixture();
  const files = [manifestFile("one"), manifestFile("two", "b", "./other")];
  if (kind === "target stopped") {
    let probes = 0;
    paneProbe.set(() => makeSpawnResult(0, probes++ ? "1" : "0"));
  }
  const bytes = Buffer.from(kind === "second hash" ? "onebad" : "onetwo");
  expect(await exchange(header({ files }), paired, false, bytes)).toMatchObject({
    op: "error", reason: expect.stringContaining(kind === "second hash" ? "hash mismatch" : "not running"),
  });
  expect(await readdir(dir)).toEqual([]);
  expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toEqual([]);
});

test("a near-limit spelling header with an empty message cannot allocate an oversized rewrite index", async () => {
  const dir = await receiveFixture();
  const file = { ...manifestFile(""), spellings: ["x".repeat(250_000)] };
  await expect(receiver(header({ message: "", files: [file] }), "peer", paired, { read: async () => Buffer.alloc(0) }))
    .rejects.toThrow("spelling index exceeds");
  expect(await readdir(dir)).toEqual([]);
});

test("a committing receipt no longer accepts dashboard cancellation", async () => {
  await receiveFixture();
  const { PeerService, defaultPeerServiceDeps } = await import("./service");
  const service = new PeerService({ ...defaultPeerServiceDeps("local", () => {}, () => ({ agents: [], repos: [], coordinator: null }), () => {}, null), receiveMessage: receiver });
  let id = "";
  let reset = false;
  await service.receiveTracked(header({ files: [manifestFile("")] }), "peer", paired, { read: async () => Buffer.alloc(0) }, {
    admitted: () => { id = service.view().incoming![0]!.id; },
    committing: () => {
      expect(service.view().incoming ?? []).toEqual([]);
      service.cancelReceipt(id);
    }, cancelStream: () => { reset = true; },
  });
  expect(id).not.toBe("");
  expect(reset).toBe(false);
  expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toHaveLength(1);
});

test("a leading dashboard project reference remains literal through wire decode and enqueue", async () => {
  const { dashboardAttachmentPaths } = await import("./dashboard-attachments");
  const message = join(repo, "live.ts");
  await Bun.write(message, "live");
  const detection = await dashboardAttachmentPaths(message, "/remote/repo", repo);
  expect(detection).toEqual({ paths: [], noPassthrough: true });
  expect(await exchange(header({ message, noPassthrough: true }))).toMatchObject({ ok: true });
  expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toMatchObject([{ message, noPassthrough: true }]);
});

test("dashboard staging reserves its unwritten bytes against incoming transfers", async () => {
  const { VolumeReservations } = await import("./attachment-space");
  const { cloneAttachments } = await import("./remote-attachments");
  const reservations = new VolumeReservations();
  const checked: number[] = [];
  const receive = createMessageReceiver(() => {}, () => {}, Date.now, 4096, {
    tempDir: cli.root, hasFreeSpace: async (_dir, bytes) => { checked.push(bytes); return bytes <= 3; },
  }, reservations);
  const source = join(cli.root, "source");
  await Bun.write(source, "abc");
  const handle = await open(source, "r");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const file = manifestFile("abc");
  const stage = cloneAttachments(join(cli.root, "stage"), [{ ...file, source, handle, argument: source }],
    undefined, async () => { entered.resolve(); await release.promise; return false; }, false, reservations);
  try {
    await entered.promise;
    const request = () => receive(header({ files: [file] }), "peer", paired, { read: async () => Buffer.alloc(0) });
    await expect(request()).rejects.toThrow("Insufficient space");
    release.resolve();
    await stage;
    await expect(request()).rejects.toThrow("Early EOF");
    expect(checked).toEqual([6, 3]);
  } finally { release.resolve(); await stage; await handle.close(); }
});

test("pending replays share their receipt without creating extra cancel targets", async () => {
  await receiveFixture();
  const { PeerService, defaultPeerServiceDeps } = await import("./service");
  const service = new PeerService({ ...defaultPeerServiceDeps("local", () => {}, () => ({ agents: [], repos: [], coordinator: null }), () => {}, null), receiveMessage: receiver });
  const req = header({ files: [manifestFile("abc")] });
  const first = service.receiveTracked(req, "peer", paired, { read: () => new Promise(() => {}) });
  const admitted = Promise.withResolvers<void>();
  await waitFor(() => !!service.view().incoming?.length);
  const second = service.receiveTracked(req, "peer", paired, undefined, { admitted: owns => {
    expect(owns).toBe(false); admitted.resolve();
  } });
  const both = Promise.allSettled([first, second]);
  await admitted.promise;
  expect(service.view().incoming).toHaveLength(1);
  service.cancelReceipt(service.view().incoming![0]!.id);
  expect((await both).every(result => result.status === "rejected")).toBe(true);
});

test("a stalled non-framed request releases the watcher header slot", async () => {
  const { IDLE_TIMEOUT_MS } = await import("./transfer-limits");
  const clock = createFakeClock();
  const { a, b } = createMemoryLink("peer", "local");
  const readers = new Set<import("./pairing").PairStream>();
  const reading = Promise.withResolvers<void>();
  const accept = b.acceptBi.bind(b);
  b.acceptBi = async () => {
    const stream = await accept();
    const read = stream.read.bind(stream);
    stream.read = n => { if (n > 1) reading.resolve(); return read(n); };
    return stream;
  };
  const serving = serveTrustedConnection(b, { peerName: paired, headerReaders: readers,
    snapshot: () => ({ agents: [], repos: [], coordinator: null }), setTimer: clock.setTimer, log() {} });
  try {
    await (await a.openBi()).writeAll(Buffer.from("{"));
    await reading.promise;
    expect(readers.size).toBe(1);
    clock.advance(IDLE_TIMEOUT_MS);
    await Bun.sleep(0);
    clock.advance(5000);
    await serving;
    expect(readers.size).toBe(0);
  } finally { a.close(0, "done"); }
});

test("shutdown waits for an admitted text-only receipt and prevents its queue append", async () => {
  const { PeerService, defaultPeerServiceDeps } = await import("./service");
  const service = new PeerService({ ...defaultPeerServiceDeps("local", () => {}, () => ({ agents: [], repos: [], coordinator: null }), () => {}, null), receiveMessage: receiver });
  const checking = Promise.withResolvers<void>();
  const allow = Promise.withResolvers<string>();
  let reads = 0;
  const receipt = service.receiveTracked(header(), "peer", async () => {
    if (++reads === 1) return "peer";
    checking.resolve();
    return allow.promise;
  }).catch(err => err);
  await checking.promise;
  expect(service.view().incoming ?? []).toEqual([]);
  let stopped = false;
  const quit = service.shutdown().then(() => { stopped = true; });
  await Bun.sleep(5);
  expect(stopped).toBe(false);
  allow.resolve("peer");
  await quit;
  expect(await receipt).toBeInstanceOf(Error);
  expect(await readOutbox(join(cli.home, ".itsybitsy/agents/worker"))).toEqual([]);
});

test("closing a replay connection frees its waiter while the original body is pending", async () => {
  await receiveFixture();
  const req = header({ files: [manifestFile("abc")] });
  const owner = new AbortController();
  const admitted = Promise.withResolvers<void>();
  const first = receiver(req, "peer", paired, { read: () => new Promise(() => {}) },
    { signal: owner.signal, admitted: () => admitted.resolve() }).catch(err => err);
  await admitted.promise;
  const waiters = Array.from({ length: 8 }, () => {
    const link = createMemoryLink("peer", "local");
    const entered = Promise.withResolvers<void>();
    const serving = serveTrustedConnection(link.b, { peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
      log() {}, setTimer: createFakeClock().setTimer, receiveMessage: (h, p, name, body, options) =>
        receiver(h, p, name, body, { ...options, admitted: owns => { options?.admitted?.(owns); entered.resolve(); } }) });
    return { link, serving, entered };
  });
  try {
    await Promise.all(waiters.map(async w => { const stream = await w.link.a.openBi(); await stream.writeAll(encodeSendHeader(req)); await w.entered.promise; }));
    await expect(receiver(req, "peer", paired)).rejects.toThrow("busy");
    waiters[0]!.link.a.close(0, "replay cancelled");
    await waiters[0]!.serving;
    const admittedAgain = Promise.withResolvers<void>();
    const result = receiver(req, "peer", paired, undefined, { admitted: () => admittedAgain.resolve() }).catch(err => err);
    await admittedAgain.promise;
    owner.abort();
    await result;
  } finally { owner.abort(); for (const w of waiters) w.link.a.close(0, "done"); await first; await Promise.all(waiters.map(w => w.serving)); }
});

test("a pending replay expires independently while the body is still being received", async () => {
  await receiveFixture();
  const held = Promise.withResolvers<Uint8Array>();
  const entered = Promise.withResolvers<void>();
  const req = header({ files: [manifestFile("")] });
  const original = receiver(req, "peer", paired, { read() { entered.resolve(); return held.promise; } });
  await entered.promise;
  try {
    const clock = createFakeClock();
    const clocks = [clock, ...Array.from({ length: 7 }, () => createFakeClock())];
    const admission = clocks.map(() => Promise.withResolvers<void>());
    const waiters = clocks.map((c, i) => receiver(req, "peer", paired, undefined, {
      setTimer: c.setTimer, admitted: () => admission[i]!.resolve(),
    }));
    await Promise.all(admission.map(a => a.promise));
    await expect(receiver(req, "peer", paired)).rejects.toThrow("busy");
    clock.advance(60_000);
    await expect(waiters[0]!).rejects.toThrow("still being received — outcome unknown");
    const admitted = Promise.withResolvers<void>();
    const replacement = receiver(req, "peer", paired, undefined, { admitted: () => admitted.resolve() });
    await admitted.promise;
    await expect(receiver(req, "peer", paired)).rejects.toThrow("busy");
    held.resolve(new Uint8Array());
    await Promise.all([replacement, ...waiters.slice(1)]);
  } finally { held.resolve(new Uint8Array()); await original; }
});

test("shutdown during the dedupe read prevents the queue append", async () => {
  const { PeerService, defaultPeerServiceDeps } = await import("./service");
  const service = new PeerService({ ...defaultPeerServiceDeps("local", () => {}, () => ({ agents: [], repos: [], coordinator: null }), () => {}, null, cli.root), receiveMessage: receiver });
  const dir = join(cli.home, ".itsybitsy", "agents", "worker");
  const read = fs.readFile;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const held = spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof read>) => {
    if (args[0] === outboxPath(dir)) { entered.resolve(); await resume.promise; }
    return read(...args);
  }) as typeof read);
  try {
    const receive = service.receiveTracked(header(), "peer", paired);
    await entered.promise;
    const stopped = service.shutdown();
    resume.resolve();
    await expect(receive).rejects.toThrow("shutting down");
    await stopped;
    expect(await readOutbox(dir)).toEqual([]);
  } finally { resume.resolve(); held.mockRestore(); await service.shutdown(); }
});

test("a replay of another stream's idle failure keeps its connection for the next exchange", async () => {
  const { requestAgents } = await import("./peer-link");
  await receiveFixture();
  const clock = createFakeClock();
  const read = Promise.withResolvers<void>();
  const originalClock = createFakeClock();
  const req = header({ files: [manifestFile("a")] });
  const original = receiver(req, "peer", paired, { read: () => {
    read.resolve(); return new Promise(() => {});
  } }, { setTimer: originalClock.setTimer }).catch(err => err);
  await read.promise;
  const { a, b } = createMemoryLink("peer", "local");
  const waiting = Promise.withResolvers<void>();
  const serving = serveTrustedConnection(b, {
    peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }), log() {}, setTimer: clock.setTimer,
    receiveMessage: (h, p, name, body, options) => receiver(h, p, name, body, { ...options,
      admitted: owns => { options?.admitted?.(owns); waiting.resolve(); } }),
  });
  try {
    const stream = await a.openBi();
    await stream.writeAll(encodeSendHeader(req));
    await waiting.promise;
    originalClock.advance(60_000);
    await original;
    expect(JSON.parse(new TextDecoder().decode(await stream.readToEnd(4096)))).toMatchObject({ op: "error" });
    await Bun.sleep(0);
    clock.advance(5000);
    expect(await requestAgents(a)).toMatchObject({ agents: [] });
  } finally { a.close(0, "done"); await serving; }
});

test("a stalled framed read with a pending error reply closes once at the whole-ACK grace", async () => {
  const { a, b } = createMemoryLink("sender", "receiver");
  const clock = createFakeClock();
  const client = await a.openBi();
  const server = await b.acceptBi();
  const writing = Promise.withResolvers<void>();
  server.write = async () => { writing.resolve(); await b.closed(); throw Error("closed"); };
  server.stopReceiving = async () => { await b.closed(); };
  const accept = b.acceptBi.bind(b);
  b.acceptBi = async () => { b.acceptBi = accept; return server; };
  const close = spyOn(b, "close");
  const serving = serveTrustedConnection(b, { peerName: paired, snapshot: () => ({ agents: [], repos: [], coordinator: null }),
    log() {}, receiveMessage: receiver, setTimer: clock.setTimer });
  try {
    await client.writeAll(Uint8Array.of(0));
    await Bun.sleep(0);
    clock.advance(60_000);
    await writing.promise;
    clock.advance(749);
    expect(close).not.toHaveBeenCalled();
    clock.advance(1);
    await serving;
    expect(close).toHaveBeenCalledTimes(1);
  } finally { a.close(0, "done"); }
});
