/**
 * Remote starts with attachments (SPEC §20.4 "Remote starts"): the framed
 * new-agent request over the in-memory link, received with the same limits
 * and busy rule as message sends.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { listSpawnableTypeNamesSync } from "../agent-types";
import { setUserHome, resetUserHome } from "../home";
import { resetSendSpawnRunner, setSendSpawnRunner } from "../ib-commands";
import { createCliFixture, type CliFixture } from "../test-cli-runner";
import { makeSpawnResult, waitFor } from "../test-utils";
import { spawnCtx as paneProbe } from "../tmux-poller";
import { acceptRemoteAgentWithFiles, type RemoteSpawnDeps } from "./new-agent";
import { NEW_AGENT_FILES_RECEIVED, NEW_AGENT_UNKNOWN, PEER_CLOSE, requestNewAgent, serveTrustedConnection, type PeerResponderDeps } from "./peer-link";
import { createAttachmentReceiver, type AttachmentReceiver } from "./receive-attachments";
import { createMessageReceiver } from "./receive-message";
import { encodeFrameHeader, TransferIdleError, type AttachmentEntry, type SendHeader } from "./send-frame";
import { createFakeClock, createMemoryLink, type FakeClock } from "./test-pair-transport";

let cli: CliFixture;
let received: string;
let staging: string;
let attachments: AttachmentReceiver;
let spawn: ReturnType<typeof mock<RemoteSpawnDeps["newAgent"]>>;
let notices: string[];
let logs: string[];

beforeEach(async () => {
  cli = await createCliFixture();
  setUserHome(cli.home);
  await Bun.write(join(cli.home, ".itsybitsy/machine-name"), "laptop");
  received = join(cli.root, "received");
  await mkdir(received);
  staging = join(cli.root, "staging");
  attachments = createAttachmentReceiver({ tempDir: received, stagingRoot: staging, hasFreeSpace: async () => true });
  spawn = mock<RemoteSpawnDeps["newAgent"]>(async () => ({ ok: true, exitCode: 0, stdout: "agent-123\n", stderr: "" }));
  notices = [];
  logs = [];
});
afterEach(async () => {
  resetUserHome();
  await cli.cleanup();
});

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

function file(data: string, name = "a.txt", spelling = "./a.txt"): AttachmentEntry {
  return { name, size: Buffer.byteLength(data), sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"), spellings: [spelling] };
}

/** The numbered bodies `requestNewAgent` sends from `filesDir`. */
async function stage(...bodies: string[]): Promise<string> {
  const dir = join(cli.root, "outgoing-" + crypto.randomUUID());
  for (const [index, body] of bodies.entries()) await Bun.write(join(dir, String(index)), body);
  return dir;
}

function spawnDeps(): RemoteSpawnDeps {
  return {
    listSpawnableTypes: listSpawnableTypeNamesSync, listRepos: async () => [{ name: "app", path: "/local/app" }],
    newAgent: spawn, notice: line => notices.push(line), attachments,
  };
}

/** B serves the trusted ALPN with framed starts handled by acceptRemoteAgentWithFiles. */
function serve(clock: FakeClock = createFakeClock(), extra: Partial<PeerResponderDeps> = {}, peerId = "dialer") {
  const link = createMemoryLink(peerId, "receiver");
  const done = serveTrustedConnection(link.b, {
    peerName: async () => "Alice", snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }),
    log: line => logs.push(line), setTimer: clock.setTimer,
    startAgentWithFiles: (header, peer, readPeerName, body, options) =>
      acceptRemoteAgentWithFiles(header, peer, readPeerName, body, options, spawnDeps(), line => logs.push(line)),
    ...extra,
  });
  return { a: link.a, clock, done, close: async () => { link.a.close(0, "done"); await done; } };
}

async function entries(dir: string): Promise<string[]> {
  return readdir(dir).catch(err => { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; });
}

const noPartials = async () => (await entries(join(staging, "incoming"))).length === 0;

test("a framed start receives the files and starts the agent with the receiver's /tmp paths", async () => {
  const side = serve();
  const files = [file("one", "a.txt", "./docs/a.txt"), file("two", "b.txt", "./b.txt")];
  try {
    const id = await requestNewAgent(side.a, { repo: "APP", type: "worker", prompt: "Read ./docs/a.txt and ./b.txt", files },
      side.clock.setTimer, { filesDir: await stage("one", "two") });
    expect(id).toBe("agent-123");
    const [root, ...others] = await readdir(received);
    expect(others).toEqual([]);
    const paths = [join(received, root!, "0/a.txt"), join(received, root!, "1/b.txt")];
    expect(await Promise.all(paths.map(path => Bun.file(path).text()))).toEqual(["one", "two"]);
    expect(spawn.mock.calls).toEqual([["/local/app", `Read ${paths[0]} and ${paths[1]}

Attachments copied to this machine:
- ./docs/a.txt → ${paths[0]}
- ./b.txt → ${paths[1]}`, { type: "worker", name: undefined }]]);
    expect(notices).toEqual(["Alice started agent agent-123 in app (2 files, 0.00 MB)"]);
    expect(logs).toContain("Alice started agent agent-123 in app (2 files, 0.00 MB)");
    expect(await noPartials()).toBe(true);
  } finally { await side.close(); }
});

test.each([
  ["an unregistered repo", { repo: "missing" }, "Repo is not registered"],
  ["an unknown type", { type: "absent" }, "unknown or not spawnable"],
  ["a coordinator type", { type: "repo-coordinator" }, "Cannot start a repo-coordinator remotely"],
  ["an invalid name", { name: "../x" }, "agent name may only contain"],
  ["a blank prompt", { prompt: "  " }, "non-empty text"],
  ["a non-string repo", { repo: 42 }, "Malformed new-agent header"],
  ["an extra key", { path: "/other" }, "Malformed new-agent header"],
  ["no files", { files: [] }, "Malformed new-agent header"],
] as const)("refuses %s before reading any body", async (_, overrides, reason) => {
  const side = serve();
  const header = { op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")], ...overrides };
  try {
    // The header alone, with neither the body nor FIN: a reply proves no body read was awaited.
    const stream = await side.a.openBi();
    await stream.writeAll(encodeFrameHeader(header));
    expect(decode(await stream.readToEnd(4096))).toEqual({ op: "error", reason: expect.stringContaining(reason) });
    expect(spawn).not.toHaveBeenCalled();
    expect(await entries(staging)).toEqual([]);
    expect(logs.filter(line => line.startsWith("peer link: new-agent from"))).toEqual([expect.stringContaining(reason)]);
    expect(side.a.closeInfo()).toBeNull();
  } finally { await side.close(); }
});

test("a framed start and a message send share the busy rule", async () => {
  const repo = await cli.addRepo("photos");
  const { agentDir } = await cli.addAgent(repo, "worker", { tmux_session: "ib-worker" });
  await Bun.write(join(agentDir, "meta.transient.json"), JSON.stringify({
    watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
  }));
  setSendSpawnRunner(() => makeSpawnResult());
  paneProbe.set(() => makeSpawnResult(0, "0"));
  const receiveMessage = createMessageReceiver(() => {}, () => {}, Date.now, 4096, attachments);
  const send = (): SendHeader => ({
    op: "send", id: crypto.randomUUID(), from: { kind: "user" }, target: { kind: "agent", agent: "worker" }, message: "see ./a.txt", files: [file("x")],
  });
  const paired = async () => "Alice";
  const held = Promise.withResolvers<Uint8Array>();
  let reads = 0;
  const pendingBody = { read: () => { reads++; return held.promise; } };
  const first = serve(createFakeClock(), { receiveMessage }, "one");
  const second = serve(createFakeClock(), { receiveMessage }, "two");
  try {
    // A send from "one" holds its slot while its body is pending.
    const sending = receiveMessage(send(), "one", paired, pendingBody).catch(err => err);
    await waitFor(() => reads === 1);
    await expect(requestNewAgent(first.a, { repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] },
      first.clock.setTimer, { filesDir: await stage("abc") })).rejects.toThrow("busy, try again");

    // A start from "two" takes the second slot, and nothing else fits.
    const stream = await second.a.openBi();
    await stream.writeAll(encodeFrameHeader({ op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] }));
    await waitFor(async () => (await entries(join(staging, "incoming"))).some(name => name.endsWith(".partial")));
    await expect(receiveMessage(send(), "three", paired, pendingBody)).rejects.toThrow("busy, try again");
    await expect(receiveMessage(send(), "two", paired, pendingBody)).rejects.toThrow("busy, try again");
    expect(reads).toBe(1);

    held.resolve(new Uint8Array());
    expect(String(await sending)).toContain("Early EOF");
    await stream.writeAll(Buffer.from("abc"));
    await stream.finish();
    expect(decode(await stream.readToEnd(4096))).toEqual({ ok: true, id: "agent-123" });
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve(new Uint8Array());
    resetSendSpawnRunner();
    paneProbe.reset();
    await first.close();
    await second.close();
  }
});

test("a hash mismatch leaves no snapshot and starts nothing", async () => {
  const side = serve();
  try {
    const stream = await side.a.openBi();
    await stream.writeAll(encodeFrameHeader({ op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] }));
    await stream.writeAll(Buffer.from("abd"));
    await stream.finish();
    const reply = await stream.readToEnd(4096);
    // The receipt failed before the files-received signal: the reply is the bare error.
    expect(String.fromCharCode(reply[0]!)).toBe("{");
    expect(decode(reply)).toEqual({ op: "error", reason: "Attachment hash mismatch" });
    await waitFor(noPartials);
    expect(await readdir(received)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  } finally { await side.close(); }
});

test("a failed spawn removes the committed snapshot", async () => {
  spawn.mockResolvedValue({ ok: false, exitCode: 1, stdout: "", stderr: "Worktree is dirty" });
  const side = serve();
  try {
    await expect(requestNewAgent(side.a, { repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] },
      side.clock.setTimer, { filesDir: await stage("abc") })).rejects.toThrow("Worktree is dirty");
    expect(spawn).toHaveBeenCalledTimes(1);
    await waitFor(async () => (await readdir(received)).length === 0);
    expect(await noPartials()).toBe(true);
    expect(notices).toEqual([]);
  } finally { await side.close(); }
});

test("the responder's 25 s deadline covers the spawn, not the transfer, and keeps a pending spawn's files", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<RemoteSpawnDeps["newAgent"]>>>();
  spawn.mockImplementation(() => pending.promise);
  const side = serve();
  try {
    const stream = await side.a.openBi();
    await stream.writeAll(encodeFrameHeader({ op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] }));
    await waitFor(async () => (await entries(join(staging, "incoming"))).some(name => name.endsWith(".partial")));
    // A slow transfer: past the start deadline, inside the 60 s idle timeout.
    side.clock.advance(40_000);
    await stream.writeAll(Buffer.from("abc"));
    await stream.finish();
    await waitFor(() => spawn.mock.calls.length === 1);
    side.clock.advance(24_999);
    await Bun.sleep(0);
    side.clock.advance(1);
    const reply = await stream.readToEnd(4096);
    // The files-received signal came before the spawn; the spawn's error follows it.
    expect(reply[0]).toBe(NEW_AGENT_FILES_RECEIVED[0]!);
    expect(decode(reply)).toEqual({ op: "error", reason: expect.stringContaining("outcome unknown after 25 s") });
    // The agent may still start and read its files.
    expect(await readdir(received)).toHaveLength(1);
    pending.resolve({ ok: false, exitCode: 1, stdout: "", stderr: "late failure" });
    await waitFor(async () => (await readdir(received)).length === 0);
  } finally { pending.resolve({ ok: false, exitCode: 1, stdout: "", stderr: "" }); await side.close(); }
});

test("a start releases its transfer slot at commit, so the same peer's attachment send is admitted during the spawn", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<RemoteSpawnDeps["newAgent"]>>>();
  spawn.mockImplementation(() => pending.promise);
  const receiveMessage = createMessageReceiver(() => {}, () => {}, Date.now, 4096, attachments);
  const side = serve();
  try {
    const starting = requestNewAgent(side.a, { repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] },
      side.clock.setTimer, { filesDir: await stage("abc") });
    await waitFor(() => spawn.mock.calls.length === 1);
    let admitted = false;
    const send: SendHeader = { op: "send", id: crypto.randomUUID(), from: { kind: "user" }, target: { kind: "agent", agent: "worker" },
      message: "see ./a.txt", files: [file("x")] };
    const sending = receiveMessage(send, "dialer", async () => "Alice", { read: async () => new Uint8Array() }, {
      admitted: () => { admitted = true; },
    }).catch(err => err);
    expect(admitted).toBe(false);
    await waitFor(() => admitted, { message: "the send passes the busy rule" });
    // It fails later, on this test's missing target, never as busy.
    expect(String(await sending)).not.toContain("busy");
    pending.resolve({ ok: true, exitCode: 0, stdout: "agent-123", stderr: "" });
    expect(await starting).toBe("agent-123");
  } finally { pending.resolve({ ok: false, exitCode: 1, stdout: "", stderr: "" }); await side.close(); }
});

test("removing the pairing while the body is received refuses the start before commit and leaves no snapshot", async () => {
  let paired = true;
  const side = serve(createFakeClock(), { peerName: async () => paired ? "Alice" : null });
  try {
    const stream = await side.a.openBi();
    await stream.writeAll(encodeFrameHeader({ op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] }));
    await stream.writeAll(Buffer.from("a"));
    await waitFor(async () => {
      const partial = (await entries(join(staging, "incoming"))).find(name => name.endsWith(".partial"));
      return !!partial && (await entries(join(staging, "incoming", partial, "0"))).length === 1;
    }, { message: "the body has started" });
    paired = false;
    await stream.writeAll(Buffer.from("bc"));
    await stream.finish();
    await expect(stream.readToEnd(4096)).rejects.toThrow();
    expect(side.a.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.notPeer });
    await waitFor(noPartials);
    expect(await readdir(received)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  } finally { await side.close(); }
});

test("a start without files is still the JSON request", async () => {
  const link = createMemoryLink("dialer", "receiver");
  const reply = requestNewAgent(link.a, { repo: "app", type: "worker", prompt: "hello", files: [] }, createFakeClock().setTimer);
  try {
    const stream = await link.b.acceptBi();
    const bytes = await stream.readToEnd(4096);
    expect(String.fromCharCode(bytes[0]!)).toBe("{");
    expect(decode(bytes)).toEqual({ op: "new-agent", repo: "app", type: "worker", prompt: "hello" });
    await stream.writeAll(Buffer.from(JSON.stringify({ ok: true, id: "agent-1" })));
    await stream.finish();
    expect(await reply).toBe("agent-1");
  } finally { link.a.close(0, "done"); }
});

test("a start without files still ends when its signal is aborted", async () => {
  const link = createMemoryLink("dialer", "receiver");
  const clock = createFakeClock();
  const controller = new AbortController();
  const reply = requestNewAgent(link.a, { repo: "app", type: "worker", prompt: "hello" }, clock.setTimer, { signal: controller.signal })
    .catch(err => err);
  try {
    await (await link.b.acceptBi()).readToEnd(4096);
    controller.abort(new Error("Dashboard shutting down"));
    // The unanswered reply gets the teardown grace, then the connection closes.
    await Bun.sleep(0);
    clock.advance(750);
    expect(String(await reply)).toContain("Dashboard shutting down");
  } finally { link.a.close(0, "done"); }
});

test("a framed start without its staged directory is refused before opening a stream", async () => {
  const link = createMemoryLink("dialer", "receiver");
  await expect(requestNewAgent(link.a, { repo: "app", type: "worker", prompt: "x", files: [file("abc")] }, createFakeClock().setTimer))
    .rejects.toThrow("Missing staged attachments");
  link.a.close(0, "done");
});

const TIMED_OUT = "Remote agent request timed out after 30 s. Check the peer for the agent.";

test.each(["timeout", "lost reply"])("with files the dialer's 30 s deadline starts at the files-received signal, and a %s after it leaves the outcome unknown", async kind => {
  const link = createMemoryLink("dialer", "receiver");
  const clock = createFakeClock();
  const stream = await link.a.openBi();
  link.a.openBi = async () => stream;
  const bodyWrite = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const write = stream.write.bind(stream);
  let writes = 0;
  stream.write = async bytes => {
    if (++writes === 2) { bodyWrite.resolve(); await release.promise; }
    return write(bytes);
  };
  let settled = false;
  const progress: number[] = [];
  const outcome = requestNewAgent(link.a, { repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] },
    clock.setTimer, { filesDir: await stage("abc"), onProgress: bytes => progress.push(bytes) }).catch(err => err).finally(() => { settled = true; });
  try {
    const incoming = await link.b.acceptBi();
    await bodyWrite.promise;
    // The transfer runs past 30 s with no deadline, inside the 60 s idle timeout.
    clock.advance(45_000);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    release.resolve();
    await incoming.readToEnd(4096);
    await Bun.sleep(0);
    // The bodies are still in flight after FIN: no deadline yet. A deadline would have fired and spent its teardown grace.
    clock.advance(45_000);
    await Bun.sleep(0);
    clock.advance(1_000);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    const reports = progress.length;
    await incoming.writeAll(NEW_AGENT_FILES_RECEIVED);
    await Bun.sleep(0);
    // Reading the signal is transfer progress, which the keep-open rule counts.
    expect(progress.length).toBe(reports + 1);
    if (kind === "timeout") {
      clock.advance(29_999);
      await Bun.sleep(0);
      expect(settled).toBe(false);
      clock.advance(1);
      await Bun.sleep(0);
      clock.advance(750);
    } else link.b.close(0, "receiver stopped");
    const err = await outcome;
    expect(err.message).toBe(NEW_AGENT_UNKNOWN);
    if (kind === "timeout") expect(err.cause.message).toBe(TIMED_OUT);
  } finally { release.resolve(); link.a.close(0, "done"); }
});

test("with files a transfer that stalls before the files-received signal fails on the 60 s idle timeout", async () => {
  const link = createMemoryLink("dialer", "receiver");
  const clock = createFakeClock();
  let settled = false;
  const outcome = requestNewAgent(link.a, { repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] },
    clock.setTimer, { filesDir: await stage("abc") }).catch(err => err).finally(() => { settled = true; });
  try {
    await (await link.b.acceptBi()).readToEnd(4096);
    await Bun.sleep(0);
    clock.advance(59_999);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    clock.advance(1);
    await Bun.sleep(0);
    clock.advance(750);
    const err = await outcome;
    expect(err.message).toBe(NEW_AGENT_UNKNOWN);
    expect(err.cause).toBeInstanceOf(TransferIdleError);
  } finally { link.a.close(0, "done"); }
});

test("a framed start whose bodies arrive more than 30 s after FIN, still moving, starts the agent", async () => {
  const side = serve();
  // QUIC accepts each write and FIN at once; the bytes reach B only as `deliver` sends them, like a slow link's stream window.
  const stream = await side.a.openBi();
  side.a.openBi = async () => stream;
  const write = stream.write.bind(stream), finish = stream.finish.bind(stream);
  const inFlight: Array<() => Promise<unknown>> = [];
  stream.write = async bytes => {
    const copy = Uint8Array.from(bytes);
    inFlight.push(() => write(copy));
    return bytes.length;
  };
  stream.finish = async () => { inFlight.push(finish); };
  const deliver = async () => { await inFlight.shift()!(); };
  let settled = false;
  const outcome = requestNewAgent(side.a, { repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] },
    side.clock.setTimer, { filesDir: await stage("abc") }).finally(() => { settled = true; });
  try {
    await waitFor(() => inFlight.length === 3, { message: "header, body and FIN sent" });
    await deliver();
    await waitFor(async () => (await entries(join(staging, "incoming"))).some(name => name.endsWith(".partial")));
    side.clock.advance(20_000);
    await deliver();
    // Past 30 s after FIN, and past any teardown grace a deadline there would have started.
    side.clock.advance(25_000);
    await Bun.sleep(0);
    side.clock.advance(1_000);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(side.a.closeInfo()).toBeNull();
    await deliver();
    expect(await outcome).toBe("agent-123");
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await side.close(); }
});

test("the responder signals before its spawn, so a spawn that hangs 30 s after the signal times out the dialer", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<RemoteSpawnDeps["newAgent"]>>>();
  spawn.mockImplementation(() => pending.promise);
  // The responder's clock stays still, so its own 25 s deadline cannot answer first.
  const side = serve();
  const dialer = createFakeClock();
  let settled = false;
  const outcome = requestNewAgent(side.a, { repo: "app", type: "worker", prompt: "use ./a.txt", files: [file("abc")] },
    dialer.setTimer, { filesDir: await stage("abc") }).catch(err => err).finally(() => { settled = true; });
  try {
    await waitFor(() => spawn.mock.calls.length === 1);
    await Bun.sleep(0);
    dialer.advance(29_999);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    dialer.advance(1);
    await Bun.sleep(0);
    dialer.advance(750);
    const err = await outcome;
    expect(err.message).toBe(NEW_AGENT_UNKNOWN);
    expect(err.cause.message).toBe(TIMED_OUT);
  } finally { pending.resolve({ ok: false, exitCode: 1, stdout: "", stderr: "" }); await side.close(); }
});
