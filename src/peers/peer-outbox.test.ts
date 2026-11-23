import { isPidAliveCtx, processStartEpochSecondsCtx } from "../agents";
import { writeTransferOwner } from "./transfer-owner";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUserHome, setUserHome } from "../home";
import { waitFor } from "../test-utils";
import { createPeerOutboxPoll, handoffRemoteMessage, textHeader, pollPeerOutbox } from "./peer-outbox";
import { MAX_HEADER_BYTES } from "./transfer-limits";

let home: string;
let base: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-handoff-"));
  setUserHome(home);
  processStartEpochSecondsCtx.set(() => 100);
  base = join(home, ".itsybitsy", "peer-outbox");
});
afterEach(async () => { isPidAliveCtx.reset(); processStartEpochSecondsCtx.reset(); resetUserHome(); await rm(home, { recursive: true, force: true }); });

test.each(["oversize", "symlink", "FIFO"])("refuses a %s peer request without sending", async kind => {
  const id = crypto.randomUUID();
  const dir = join(base, id);
  await mkdir(dir, { recursive: true });
  await writeTransferOwner(dir, { pid: process.pid, start: 100 });
  const path = join(dir, "request.json");
  const header = { ...textHeader({ kind: "system" }, "hi", { kind: "user" }), id };
  const envelope = JSON.stringify({ peer: "peer", header });
  if (kind === "oversize") await Bun.write(path, envelope + " ".repeat(MAX_HEADER_BYTES + 193));
  if (kind === "symlink") {
    const valid = join(home, "valid-request.json");
    await Bun.write(valid, envelope);
    await symlink(valid, path);
  }
  if (kind === "FIFO") expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
  let sends = 0;
  await pollPeerOutbox(async () => { sends++; return ""; }, () => {});
  expect(await Bun.file(join(base, ".claimed", id + `@${process.pid}-100`, "result.json")).json()).toMatchObject({ ok: false });
  expect(sends).toBe(0);
});

test.each([false, true])("interrupt after publication (claimed=%s)", async claimed => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const control = new AbortController();
  const result = handoffRemoteMessage("peer", header, control.signal);
  await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
  const started = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<string>();
  const poll = claimed ? pollPeerOutbox(async () => { started.resolve(); return hold.promise; }, () => {}) : undefined;
  if (claimed) await started.promise;
  control.abort();
  try {
    const outcome = await result;
    expect(outcome.exitCode).toBe(130);
    expect(outcome.stderr).toContain(claimed ? "outcome unknown" : "cancelled before sending");
    expect(await Bun.file(join(base, header.id, "request.json")).exists()).toBe(false);
  } finally { hold.resolve(header.id); await poll; }
});

test("an interrupted direct send never publishes an already-cancelled request", async () => {
  const header = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const outcome = await handoffRemoteMessage("peer", header, AbortSignal.abort());
  expect(outcome).toMatchObject({ exitCode: 130, stderr: expect.stringContaining("cancelled before sending") });
  expect(await Bun.file(join(base, header.id, "request.json")).exists()).toBe(false);
});


test("the complete encoded header is validated before probing watcher liveness", async () => {
  const header = textHeader({ kind: "system" }, "x".repeat(MAX_HEADER_BYTES - 1), { kind: "system" });
  expect(await handoffRemoteMessage("peer", header)).toMatchObject({ ok: false, stderr: "Send header exceeds 262144 bytes" });
});

test("claimed request publishes byte progress and propagates CLI interruption to the stream owner", async () => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "read", { kind: "user" });
  const controller = new AbortController();
  const result = handoffRemoteMessage("peer", header, controller.signal);
  await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
  const poll = pollPeerOutbox(async (_peer, _header, transfer) => {
    transfer.onProgress!(192);
    return new Promise((_, reject) => transfer.signal!.addEventListener("abort", () => reject(transfer.signal!.reason), { once: true }));
  }, () => {});
  const claimed = join(base, ".claimed", header.id + `@${process.pid}-100`);
  await waitFor(async () => (await Bun.file(join(claimed, "progress")).json().catch(() => null))?.bytes === 192);
  controller.abort();
  expect(await result).toMatchObject({ exitCode: 130, stderr: "outcome unknown — check the recipient" });
  await poll;
  await expect(fs.stat(claimed)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a claimed cancellation with a failed signal still has an unknown outcome", async () => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hello", { kind: "user" });
  const control = new AbortController();
  const result = handoffRemoteMessage("peer", header, control.signal);
  await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
  const finish = Promise.withResolvers<string>();
  const watcher = pollPeerOutbox(async () => {
    await mkdir(join(base, ".claimed", header.id + `@${process.pid}-100`, "cancel")); // writeFile will receive EISDIR
    control.abort();
    return finish.promise;
  }, () => {});
  const { collectSendCleanupDiagnostics, finishSendCleanup } = await import("../send-cleanup");
  collectSendCleanupDiagnostics();
  const output: string[] = [];
  const printer = spyOn(console, "error").mockImplementation(line => { output.push(String(line)); });
  try {
    output.push((await result).stderr);
    await finishSendCleanup();
    expect(output).toEqual(["outcome unknown — check the recipient", expect.stringContaining("Could not signal claimed send cancellation")]);
  } finally { printer.mockRestore(); finish.resolve(header.id); await watcher; }
});

test("Ctrl-C during a successful claimed result read still reports unknown", async () => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hello", { kind: "user" });
  const controller = new AbortController();
  const read = fs.readFile;
  const resultPath = join(base, ".claimed", header.id + `@${process.pid}-100`, "result.json");
  const spy = spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof read>) => {
    const contents = await read(...args);
    if (args[0] === resultPath) controller.abort();
    return contents;
  }) as typeof read);
  try {
    const result = handoffRemoteMessage("peer", header, controller.signal);
    await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
    await pollPeerOutbox(async () => header.id, () => {});
    expect(await result).toMatchObject({ exitCode: 130, stderr: "outcome unknown — check the recipient" });
  } finally { spy.mockRestore(); }
});


test("staging without a record survives until hard expiry regardless of the name", async () => {
  const parent = join(base, ".staging");
  const stranded = join(parent, crypto.randomUUID() + ".2147483647");
  await mkdir(stranded, { recursive: true });
  const created = (await fs.stat(stranded)).birthtimeMs;
  const poll = (now: number) => createPeerOutboxPoll(() => now).recover();
  await poll(created + 24 * 3600_000 - 1);
  expect(await fs.readdir(parent)).toHaveLength(1);
  await poll(created + 24 * 3600_000);
  expect(await fs.readdir(parent)).toEqual([]);
});

test.each(["absent", "null", "unverifiable"])("a ready request with %s ownership cannot send", async kind => {
  const h = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const dir = join(base, h.id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "request.json"), JSON.stringify({ peer: "peer", header: h }));
  if (kind !== "absent") await writeTransferOwner(dir, { pid: process.pid, start: kind === "null" ? null : 100 });
  if (kind === "unverifiable") processStartEpochSecondsCtx.set(() => null);
  let sent = false;
  await pollPeerOutbox(async () => { sent = true; return h.id; }, () => {});
  expect(sent).toBe(false);
  expect(await Bun.file(join(dir, "request.json")).exists()).toBe(true);
});

test("a successful ACK prints before a failed result cleanup warning", async () => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  const { collectSendCleanupDiagnostics, finishSendCleanup } = await import("../send-cleanup");
  const h = textHeader({ kind: "system" }, "hello", { kind: "user" });
  const dir = join(base, ".claimed", h.id + `@${process.pid}-100`);
  const output: string[] = [];
  const { printAndExit } = await import("../index");
  const stop = spyOn(process, "exit").mockImplementation(() => { throw Error("test exit"); });
  const stdout = spyOn(console, "log").mockImplementation(line => { output.push(String(line)); });
  const printer = spyOn(console, "error").mockImplementation(line => { output.push(String(line)); });
  const remove = fs.rm;
  const fail = spyOn(fs, "rm").mockImplementation(async (path, opts) => {
    if (path === dir) throw Error("cleanup unavailable");
    await remove(path, opts);
  });
  collectSendCleanupDiagnostics();
  try {
    const sending = handoffRemoteMessage("peer", h);
    await waitFor(() => Bun.file(join(base, h.id, "request.json")).exists());
    await pollPeerOutbox(async () => h.id, () => {});
    const result = await sending;
    expect(result.ok).toBe(true);
    await expect(printAndExit(result)).rejects.toThrow("test exit");
    expect(stop).toHaveBeenCalledWith(0);
    expect(output).toEqual(["Sent to @system", expect.stringContaining("cleanup unavailable")]);
  } finally { fail.mockRestore(); printer.mockRestore(); stdout.mockRestore(); stop.mockRestore(); await finishSendCleanup(); }
});

test("a live watcher stuck before wire I/O does not renew the client deadline", async () => {
  await Bun.write(join(home, ".itsybitsy", "peer", "endpoint.lock"), String(process.pid));
  let now = performance.now();
  const time = spyOn(performance, "now").mockImplementation(() => now);
  const h = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const result = handoffRemoteMessage("peer", h);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  try {
    await waitFor(() => Bun.file(join(base, h.id, "request.json")).exists());
    const run = createPeerOutboxPoll(() => now)(async () => { entered.resolve(); return finish.promise; }, () => {});
    await entered.promise;
    await Bun.sleep(100); // the client observes the real worker claim
    for (let i = 0; i < 3; i++) { now += 21_000; await Bun.sleep(300); }
    expect((await result).stderr).toContain("timed out");
    finish.resolve(h.id);
    await run;
  } finally { time.mockRestore(); finish.resolve(h.id); }
});

async function readyRequest() {
  const header = textHeader({ kind: "system" }, "hello", { kind: "user" });
  const ready = join(base, header.id);
  const claimed = join(base, ".claimed", header.id + `@${process.pid}-200`);
  const client = { pid: 10101, start: 100 };
  isPidAliveCtx.set(() => true);
  processStartEpochSecondsCtx.set(pid => pid === client.pid ? client.start : 200);
  await mkdir(ready, { recursive: true });
  await writeTransferOwner(ready, client);
  await Bun.write(join(ready, "request.json"), JSON.stringify({ peer: "peer", header }));
  return { client, header, ready, claimed };
}

test.each(["waiting", "unverifiable", "cancelled", "dead"])('interrupted claim recovery for a %s submitter never resends', async state => {
  const { client, ready, claimed } = await readyRequest();
  const rename = fs.rename;
  const interrupted = spyOn(fs, "rename").mockImplementation(async (source, dest) => {
    if (source === ready) {
      expect(dest).toBe(claimed);
      await rename(source, dest);
      throw Error("stopped immediately after claim");
    }
    await rename(source, dest);
  });
  let sends = 0;
  const send = async () => { sends++; return ""; };
  try { await createPeerOutboxPoll()(send, () => {}); } finally { interrupted.mockRestore(); }
  expect(await Bun.file(join(claimed, "owner.json")).json()).toEqual(client);
  processStartEpochSecondsCtx.set(pid => pid === process.pid ? 201 : state === "unverifiable" ? null : client.start);
  if (state === "cancelled") await Bun.write(join(claimed, "cancel"), "");
  if (state === "dead") isPidAliveCtx.set(pid => pid !== client.pid);
  const replacement = createPeerOutboxPoll();
  await replacement.recover();
  await replacement(send, () => {});
  if (state === "waiting" || state === "unverifiable") expect(await Bun.file(join(claimed, "result.json")).json()).toEqual({ ok: false, error: "outcome unknown — check the recipient" });
  else await expect(fs.stat(claimed)).rejects.toMatchObject({ code: "ENOENT" });
  expect(sends).toBe(0);
});

test("a worker that died before the rename leaves the request ready", async () => {
  const { ready, header, claimed } = await readyRequest();

  const worker = createPeerOutboxPoll();
  await worker.recover();
  await worker(async () => header.id, () => {});
  expect(await Bun.file(join(claimed, "result.json")).json()).toEqual({ ok: true, id: header.id });
});

test.each([null, 201])("a worker whose observed start changes to %s after claiming cannot send", async observed => {
  const { client, ready, claimed } = await readyRequest();
  const rename = fs.rename;
  const change = spyOn(fs, "rename").mockImplementation(async (source, dest) => {
    await rename(source, dest);
    if (source === ready) processStartEpochSecondsCtx.set(pid => pid === client.pid ? client.start : observed);
  });
  let sent = false;
  try { await createPeerOutboxPoll()(async () => { sent = true; return ""; }, () => {}); }
  finally { change.mockRestore(); }
  expect(sent).toBe(false);
  expect(await Bun.file(join(claimed, "result.json")).json()).toEqual({ ok: false, error: "Cannot verify the peer-outbox worker" });
});

test("a failed result publication is retried without sending the request again", async () => {
  const { claimed, header } = await readyRequest();
  const poll = createPeerOutboxPoll();
  const rename = fs.rename;
  const resultPath = join(claimed, "result.json");
  const temporary = spyOn(fs, "rename").mockImplementation(async (source, dest) => {
    if (dest === resultPath) throw Error("storage unavailable");
    await rename(source, dest);
  });
  let sends = 0;
  const send = async () => { sends++; return header.id; };
  const messages: string[] = [];
  try { await poll(send, line => messages.push(line)); }
  finally { temporary.mockRestore(); }
  expect(await Bun.file(resultPath).exists()).toBe(false);
  expect(messages.join(" ")).toContain("retrying claim finalization");
  // There is no subsequent dispatch poll or recovery task after endpoint loss.
  await waitFor(() => Bun.file(resultPath).exists());
  expect(sends).toBe(1);
  expect(await Bun.file(resultPath).json()).toEqual({ ok: true, id: header.id });
});

test("a failed worker progress marker leaves the known ACK intact", async () => {
  const { ready, claimed, header } = await readyRequest();
  await mkdir(join(ready, "progress")); // The progress rename cannot replace a directory.
  const { collectSendCleanupDiagnostics, finishSendCleanup } = await import("../send-cleanup");
  const output: string[] = [];
  const printer = spyOn(console, "error").mockImplementation(line => { output.push(String(line)); });
  collectSendCleanupDiagnostics();
  try {
    await createPeerOutboxPoll()(async (_peer, _header, transfer) => {
      transfer.signal!.throwIfAborted();
      transfer.onProgress!(0);
      return header.id;
    }, () => {});
    expect(await Bun.file(join(claimed, "result.json")).json()).toEqual({ ok: true, id: header.id });
    expect(output).toEqual([]);
    await finishSendCleanup();
    expect(output).toEqual([expect.stringContaining("progress update failed")]);
  } finally { printer.mockRestore(); }
});

test("an ordinary timeout observes a result published during the last poll sleep", async () => {
  await Bun.write(join(home, ".itsybitsy/peer/endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const claimed = join(base, ".claimed", header.id + `@${process.pid}-100`);
  const sleep = Bun.sleep;
  let now = performance.now();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const poll = spyOn(Bun, "sleep").mockImplementation(async delay => {
    if (delay !== 50) return sleep(delay);
    await mkdir(join(base, ".claimed"), { recursive: true });
    await fs.rename(join(base, header.id), claimed);
    await Bun.write(join(claimed, "result.json"), JSON.stringify({ ok: true, id: header.id }));
    now += 60_000;
  });
  try { expect(await handoffRemoteMessage("peer", header)).toMatchObject({ ok: true }); }
  finally { clock.mockRestore(); poll.mockRestore(); }
});

test("malformed progress warns once and keeps polling for the delivery result", async () => {
  await Bun.write(join(home, ".itsybitsy/peer/endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const claimed = join(base, ".claimed", header.id + `@${process.pid}-100`);
  const logs: string[] = [];
  const warning = spyOn(console, "error").mockImplementation(message => { logs.push(String(message)); });
  try {
    const result = handoffRemoteMessage("peer", header);
    await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
    await mkdir(join(base, ".claimed")); await fs.rename(join(base, header.id), claimed);
    await Bun.write(join(claimed, "progress"), "broken");
    await waitFor(() => logs.length === 1); await Bun.sleep(70);
    await Bun.write(join(claimed, "result.json"), JSON.stringify({ ok: true, id: header.id }));
    expect(await result).toMatchObject({ ok: true });
    expect(logs).toEqual([expect.stringContaining("progress read failed")]);
  } finally { warning.mockRestore(); }
});

test.each([false, true])("a transient result read is retried and persistent errors retain the diagnostic (persistent=%s)", async persistent => {
  await Bun.write(join(home, ".itsybitsy/peer/endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hi", { kind: "user" });
  const path = join(base, ".claimed", header.id + `@${process.pid}-100`, "result.json");
  const read = fs.readFile; let failed = false, now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const spy = spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof read>) => {
    const bytes = await read(...args);
    if (args[0] === path && (persistent || !failed)) { failed = true; now += 61_000; throw Error("fixture read failure"); }
    return bytes;
  }) as typeof read);
  try {
    const waiting = handoffRemoteMessage("peer", header);
    await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
    await createPeerOutboxPoll()(async () => header.id, () => {});
    const result = await waiting;
    expect(result.ok).toBe(!persistent);
    if (persistent) { expect(result.stderr).toContain("outcome unknown"); expect(result.stderr).toContain("fixture read failure"); }
    expect(failed).toBe(true);
  } finally { spy.mockRestore(); clock.mockRestore(); }
});

test("a failed progress rename retries the same sequence on the next tick", async () => {
  const { claimed, header } = await readyRequest();
  const path = join(claimed, "progress"), rename = fs.rename;
  let failed = false;
  const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === path && !failed) { failed = true; throw Error("rename unavailable"); }
    await rename(from, to);
  });
  try {
    await createPeerOutboxPoll()(async () => {
      await waitFor(() => Bun.file(path).exists());
      expect(await Bun.file(path).json()).toEqual({ sequence: 0, bytes: 0 });
      return header.id;
    }, () => {});
    expect(failed).toBe(true);
  } finally { spy.mockRestore(); }
});

test("claim refuses a brokered send whose originating CLI died after publication", async () => {
  await Bun.write(join(home, ".itsybitsy/peer/endpoint.lock"), String(process.pid));
  const header = textHeader({ kind: "system" }, "hi", { kind: "agent", id: "laptop/repo/worker" });
  const origin = { pid: 42, start: 100 };
  isPidAliveCtx.set(() => true);
  const result = handoffRemoteMessage("peer", header, undefined, undefined, undefined, undefined, origin);
  await waitFor(() => Bun.file(join(base, header.id, "request.json")).exists());
  expect((await Bun.file(join(base, header.id, "request.json")).json()).origin).toEqual(origin);
  isPidAliveCtx.set(pid => pid !== origin.pid);
  let sends = 0;
  await createPeerOutboxPoll()(async () => { sends++; return header.id; }, () => {});
  expect(await result).toMatchObject({ ok: false, stderr: "Cannot verify the originating CLI" });
  expect(sends).toBe(0);
});

test("a full staging volume frees bodies and publishes the retained ACK", async () => {
  const { ready, claimed, header } = await readyRequest();
  await mkdir(join(ready, "files"));
  await Bun.write(join(ready, "files", "0"), "attachment");
  const rename = fs.rename;
  const publication = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === join(claimed, "result.json") && await Bun.file(join(claimed, "files", "0")).exists()) {
      throw Object.assign(Error("disk full"), { code: "ENOSPC" });
    }
    await rename(from, to);
  });
  let sends = 0;
  try {
    await createPeerOutboxPoll()(async () => { sends++; return header.id; }, () => {});
    await waitFor(() => Bun.file(join(claimed, "result.json")).exists());
    expect(await Bun.file(join(claimed, "result.json")).json()).toEqual({ ok: true, id: header.id });
    expect(sends).toBe(1);
  } finally { publication.mockRestore(); }
});

test("two watchers racing a paused claim use only the identity of the winner", async () => {
  const { ready, header, claimed } = await readyRequest();
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const rename = fs.rename;
  const pause = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === ready && to === claimed) { entered.resolve(); await held.promise; }
    await rename(from, to);
  });
  let sends = 0;
  const send = async () => { sends++; return header.id; };
  try {
    const first = createPeerOutboxPoll()(send, () => {});
    await entered.promise;
    processStartEpochSecondsCtx.set(pid => pid === process.pid ? 201 : 100);
    await createPeerOutboxPoll()(send, () => {});
    held.resolve(); await first;
    expect(await fs.readdir(join(base, ".claimed"))).toEqual([header.id + `@${process.pid}-201`]);
    expect(sends).toBe(1);
  } finally { held.resolve(); pause.mockRestore(); }
});

test("four retained results leave a network slot for a fifth request", async () => {
  const batch = await Promise.all(Array.from({ length: 4 }, () => readyRequest()));
  const paths = new Set(batch.map(item => join(item.claimed, "result.json")));
  const rename = fs.rename;
  const full = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (paths.has(String(to))) throw Error("storage unavailable");
    return rename(from, to);
  });
  const poll = createPeerOutboxPoll();
  const sends: string[] = [];
  const send = async (_peer: string, header: { id: string }) => { sends.push(header.id); return header.id; };
  try {
    await poll(send, () => {});
    const fifth = await readyRequest();
    await poll(send, () => {});
    expect(sends.sort()).toEqual([...batch, fifth].map(item => item.header.id).sort());
    expect(await Bun.file(join(fifth.claimed, "result.json")).json()).toMatchObject({ ok: true });
  } finally { full.mockRestore(); }
});
