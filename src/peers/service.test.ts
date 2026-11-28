import { createPeerOutboxPoll, handoffRemoteMessage, handoffWatchLog, textHeader } from "./peer-outbox";
import { decodeWatchLogOutput, type WatchLogFile } from "./watch-log-files";
import { humanSendTerminalDenial, remoteStartDenialAtStartup } from "./remote-start-caller";
import { spyOn, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAliveCtx, processStartEpochSecondsCtx, resetProcessStartEpochSecondsCache } from "../agents";
import { resetUserHome, setUserHome } from "../home";
import { agentsDir, peerDir, peerEndpointLockFile, peersFile } from "../runtime-names";
import { effectiveSpawnCapability, grantAgentPermission, setAgentSpawnCapability } from "../agent-permissions";
import type { RemotePermissionDeps } from "./remote-permissions";
import { makeAgent, waitFor } from "../test-utils";
import { acquireEndpointLock, releaseEndpointLock } from "./endpoint-lock";
import { readConnectedPeers } from "./remote-agents";
import { loadOrCreateIdentity } from "./identity";
import { IrohError, irohAddonLoaderCtx, type IrohPath } from "./iroh";
import { PAIR_ALPN, PAIR_CLOSE, PAIR_MAX_MESSAGE_BYTES, PairProtocolError, decodePairMessage, encodePairMessage } from "./pairing";
import {
  PEER_ALPN,
  PEER_CLOSE,
  NEW_AGENT_MAX_REQUEST_BYTES,
  encodeAgentsReply,
  encodePeerRequest,
  requestAgents,
  requestPermissions,
  requestWatchLog,
  serveTrustedConnection,
  toRemoteAgents,
  type RemoteAgent,
} from "./peer-link";
import {
  LATE_TIMER_INTERVAL_MS,
  PeerService,
  defaultPeerServiceDeps,
  describePaths,
  peerRetryDelayMs,
  toPairConnection,
  type PeerServiceDeps,
  type ServiceConnection,
  type ServiceEndpoint,
  type ServiceIncoming,
  type ServiceStream,
} from "./service";
import { addPeer, readPeers, removePeer, type Peer } from "./store";
import { Scheduler } from "../scheduler";
import { claimScheduledRun, createScheduledTask, readScheduledTasks, recordScheduledRunResult } from "../scheduled-tasks";
import { PEER_POLL_INTERVAL_MS, PEER_REQUEST_TIMEOUT_MS } from "./poller";
import { TerminalFrameReader, encodeTerminalOpen, parseTerminalExit } from "./terminal-frame";
import { listSpawnableTypeNamesSync } from "../agent-types";
import type { RemoteSpawnDeps } from "./new-agent";
import { createAttachmentReceiver } from "./receive-attachments";
import { encodeFrameHeader } from "./send-frame";
import { createFakeClock, createMemoryLink, type FakeClock, type MemoryConnection } from "./test-pair-transport";
import { connect } from "node:net";

const ID_REMOTE = "c3".repeat(32);

/** An endpoint whose incoming connections the test pushes. Loads no addon. */
class FakeEndpoint implements ServiceEndpoint {
  private queue: ServiceIncoming[] = [];
  private waiters: Array<{ resolve: (incoming: ServiceIncoming | null) => void; reject: (err: Error) => void }> = [];
  private isClosed = false;
  closeCalls = 0;
  readonly connects: string[] = [];
  /** What a dial does; by default it fails at once. */
  connectImpl: (id: string) => Promise<ServiceConnection> = async () => {
    throw new Error("Endpoint.connect: no network in tests");
  };

  push(incoming: ServiceIncoming): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(incoming);
    else this.queue.push(incoming);
  }

  /** Make the pending (or next) acceptNext reject, as an endpoint-level failure would. */
  failAccept(err: Error): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.reject(err);
  }

  /** Make the next acceptNext reject at once, the moment the accept loop starts. */
  acceptFailure: Error | null = null;

  acceptNext(): Promise<ServiceIncoming | null> {
    if (this.isClosed) return Promise.resolve(null);
    const failure = this.acceptFailure;
    if (failure !== null) {
      this.acceptFailure = null;
      return Promise.reject(failure);
    }
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  connect(id: string): Promise<ServiceConnection> {
    this.connects.push(id);
    return this.connectImpl(id);
  }

  /** When set, close() does not resolve until this does. */
  closeGate: Promise<void> | null = null;

  async close(): Promise<void> {
    this.closeCalls++;
    this.isClosed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
    if (this.closeGate) await this.closeGate;
  }

  /** acceptNext is waiting (the accept loop is running). */
  get accepting(): boolean {
    return this.waiters.length > 0;
  }
}

/** A memory connection as the wrapper's connection shape, on `alpn`: one direct path, and no path changes unless `paths` says so. */
function serviceConnection(conn: MemoryConnection, alpn = PAIR_ALPN, paths: FakePaths = new FakePaths()): ServiceConnection {
  return {
    remoteId: () => conn.remoteId,
    alpn: () => alpn,
    openBi: () => conn.openBi(),
    acceptBi: () => conn.acceptBi(),
    close: (code, reason) => conn.close(code, reason),
    closed: () => conn.closed(),
    closeInfo: () => conn.closeInfo(),
    paths: () => paths.current,
    watchPaths: (onChange) => {
      paths.watchers.add(onChange);
      return () => { paths.watchers.delete(onChange); };
    },
  };
}

/** A connection's paths as a test sets them; `select` fires the path watch. */
class FakePaths {
  current: IrohPath[] = [{ selected: true, relay: false, remoteAddr: "192.0.2.7:4433", rttMs: 12 }];
  readonly watchers = new Set<() => void>();
  select(path: IrohPath): void {
    this.current = [path];
    for (const watcher of this.watchers) watcher();
  }
}

/** An incoming connection from ID_REMOTE; returns the remote (dialing) end. */
function incomingFrom(ep: FakeEndpoint, selfId: string, alpn = PAIR_ALPN): MemoryConnection {
  const link = createMemoryLink(ID_REMOTE, selfId);
  ep.push({ accept: async () => serviceConnection(link.b, alpn) });
  return link.a;
}

async function rawRequest(conn: MemoryConnection, bytes: Uint8Array): Promise<Uint8Array | Error> {
  try {
    const stream = await conn.openBi();
    await stream.writeAll(bytes);
    await stream.finish();
    return await stream.readToEnd(PAIR_MAX_MESSAGE_BYTES);
  } catch (err) {
    return err as Error;
  }
}

// The liveness check is the real one; only its two OS probes are stubbed (as
// in endpoint-lock.test.ts), so the real lock file decides.
const ME_START = 1_700_000_000;
const OTHER = { pid: 4202, startEpoch: 1_700_000_500 };
let home: string;
let alive: Set<number>;
let starts: Map<number, number>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ib-peer-service-"));
  setUserHome(home);
  alive = new Set([process.pid]);
  starts = new Map([[process.pid, ME_START]]);
  isPidAliveCtx.set((pid) => alive.has(pid));
  processStartEpochSecondsCtx.set((pid) => starts.get(pid) ?? null);
  resetProcessStartEpochSecondsCache();
  // Nothing here may load the addon.
  irohAddonLoaderCtx.set(async () => {
    throw new Error("a service test loaded the iroh addon");
  });
});

afterEach(async () => {
  isPidAliveCtx.reset();
  processStartEpochSecondsCtx.reset();
  resetProcessStartEpochSecondsCache();
  irohAddonLoaderCtx.reset();
  resetUserHome();
  await rm(home, { recursive: true, force: true });
});

/**
 * Real lock, identity and store under the temp home; fake endpoints (bind N
 * returns `endpoints[N]`, or throws it when it is an Error); a fake clock.
 * `endpoint` is the first FakeEndpoint in the list.
 */
function makeService(overrides: Partial<PeerServiceDeps> = {}, endpoints: Array<FakeEndpoint | Error> = [new FakeEndpoint()]) {
  const endpoint = endpoints.find((e): e is FakeEndpoint => e instanceof FakeEndpoint) ?? new FakeEndpoint();
  const logs: string[] = [];
  const binds: string[][] = [];
  /**
   * Bind attempts as soon as they start: every bind calls loadIdentity
   * synchronously, and a retry's bind calls readPeers synchronously first
   * (with the dialog closed), so a stray attempt shows without waiting.
   */
  const calls = { loadIdentity: 0, readPeers: 0 };
  const clock = createFakeClock();
  const service = new PeerService({
      remoteStartDenial: null,
    acquireLock: () => acquireEndpointLock(),
    releaseLock: () => releaseEndpointLock(),
    loadIdentity: () => {
      calls.loadIdentity++;
      return loadOrCreateIdentity();
    },
    bindEndpoint: async (_secretKey, alpns) => {
      binds.push(alpns);
      const next = endpoints[binds.length - 1];
      if (!next) throw new Error(`bind ${binds.length} has no fake endpoint`);
      if (next instanceof Error) throw next;
      return next;
    },
    readPeers: () => {
      calls.readPeers++;
      return readPeers();
    },
    addPeer,
    removePeer,
    generateCode: () => "ABCD1234",
    now: clock.now,
    setTimer: clock.setTimer,
    log: (line) => logs.push(line),
    snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }),
    ...overrides,
  });
  return { service, endpoint, logs, binds, clock, calls };
}

const lockContents = () => readFile(peerEndpointLockFile(), "utf-8").then(text => text.replace(/\n[a-f0-9-]{36}\n$/, "\n")).catch(() => null);

/** When the pending automatic rebind runs, or null when the status is not an error with one pending. */
function retryAt(service: PeerService): number | null {
  const status = service.view().status;
  return status.kind === "error" ? status.retryAt : null;
}

/**
 * Let `ms` pass in steps of at most 1 s, as it does while the event loop
 * runs, so the bound endpoint's late-timer (LATE_TIMER_LOG_MS) stays quiet.
 * A single advance(ms) is a stall that long, and the late-timer logs it.
 */
function elapse(clock: FakeClock, ms: number): void {
  for (let left = ms; left > 0; left -= LATE_TIMER_INTERVAL_MS) clock.advance(Math.min(LATE_TIMER_INTERVAL_MS, left));
}

/** Run every continuation already queued as a microtask (and the ones they queue), without waiting on real time. */
async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** A promise the test settles by hand. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PeerService binding", () => {
  test("with no peers nothing binds until the dialog opens; then it takes the lock and binds once, on the pair and peer ALPNs", async () => {
    const { service, binds, logs, clock } = makeService();
    expect(service.view().status).toEqual({ kind: "idle" });
    expect(binds).toEqual([]);
    expect(await lockContents()).toBeNull();

    service.openDialog();
    expect(service.view().status).toEqual({ kind: "starting" });
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    expect(binds).toEqual([[PAIR_ALPN, PEER_ALPN]]);
    expect(clock.pending()).toBe(2); // the poller's timer and the late-timer: a clean first bind arms no stability check
    expect(await lockContents()).toBe(`${process.pid} ${ME_START}\n`);
    const selfId = service.view().selfId!;
    expect(selfId).toMatch(/^[0-9a-f]{64}$/);
    expect(logs).toContain(`peering: endpoint bound as ${selfId.slice(0, 10)}`);

    service.closeDialog();
    service.openDialog();
    await Bun.sleep(10);
    expect(binds.length).toBe(1);
    await service.shutdown();
  });

  test("while bound it serves the ib peer attach socket, naming peers by name or id, and removes it on shutdown", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const socketPath = join(home, "t.sock");
    const { service } = makeService({ terminalSocketPath: socketPath });
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    await waitFor(() => stat(socketPath).then(() => true, () => false), { message: "socket listening" });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const attach = async (peer: string) => {
      const socket = connect(socketPath);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      const closed = new Promise(resolve => socket.once("close", resolve));
      socket.write(encodeTerminalOpen({ peer, agent: "worker", cols: 80, rows: 24 }));
      await closed;
      const [frame] = new TerminalFrameReader().push(Buffer.concat(chunks));
      return parseTerminalExit(frame!.payload).reason;
    };
    expect(await attach("laptop c")).toBe("Laptop C is disconnected");
    // The clean form commands use (cleanPeerName) names it too.
    expect(await attach("laptop-c")).toBe("Laptop C is disconnected");
    expect(await attach(ID_REMOTE.toUpperCase())).toBe("Laptop C is disconnected");
    expect(await attach("nobody")).toBe('no paired peer has the name or id "nobody"');

    await service.shutdown();
    await expect(stat(socketPath)).rejects.toThrow();
  });

  test("the attach socket refuses every open while the startup human-caller decision denies", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const socketPath = join(home, "t.sock");
    const { service } = makeService({ terminalSocketPath: socketPath, remoteStartDenial: "Remote starts are disabled inside tmux" });
    service.openDialog();
    await waitFor(() => stat(socketPath).then(() => true, () => false), { message: "socket listening" });
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise(resolve => socket.once("close", resolve));
    socket.write(encodeTerminalOpen({ peer: "Laptop C", agent: "worker", cols: 80, rows: 24 }));
    await closed;
    const [frame] = new TerminalFrameReader().push(Buffer.concat(chunks));
    expect(parseTerminalExit(frame!.payload).reason)
      .toBe("Remote terminals are disabled while ib watch runs inside tmux; restart ib watch from a terminal outside tmux");
    await service.shutdown();
  });

  test("another live ib watch holds the lock: no bind, the dialog says who, and the id and peers still show", async () => {
    alive.add(OTHER.pid);
    starts.set(OTHER.pid, OTHER.startEpoch);
    await mkdir(peerDir(), { recursive: true });
    await writeFile(peerEndpointLockFile(), `${OTHER.pid} ${OTHER.startEpoch}\n`);
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });

    const { service, binds, logs } = makeService();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "disabled", { message: "disabled" });
    expect(service.view().status).toEqual({ kind: "disabled", ownerPid: OTHER.pid });
    expect(binds).toEqual([]);
    expect(logs).toContain(`peering disabled: ib watch pid ${OTHER.pid} owns the endpoint`);
    expect(await lockContents()).toBe(`${OTHER.pid} ${OTHER.startEpoch}\n`);
    expect(service.view().selfId).toMatch(/^[0-9a-f]{64}$/);
    await waitFor(() => service.view().peers.length === 1, { message: "peers loaded" });
    expect(service.view().peers[0]!.name).toBe("Laptop C");
    expect(service.pairWith(ID_REMOTE)).toBe(`Peering is disabled: ib watch pid ${OTHER.pid} owns the endpoint.`);

    // Once the owner is gone, the next dialog open takes the endpoint over.
    alive.delete(OTHER.pid);
    service.closeDialog();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening after the owner exited" });
    expect(binds).toEqual([[PAIR_ALPN, PEER_ALPN]]);
    await service.shutdown();
  });

  test("shutdown closes the endpoint, ends the accept loop and releases the lock", async () => {
    const { service, endpoint, logs } = makeService();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    expect(await lockContents()).not.toBeNull();
    await service.shutdown();
    expect(endpoint.closeCalls).toBe(1);
    await service.acceptLoopDone;
    expect(await lockContents()).toBeNull();
    expect(logs).toContain("peering: endpoint closed");
  });

  test("a failed accept loop closes the endpoint and releases the lock, so the next open rebinds cleanly", async () => {
    const first = new FakeEndpoint();
    const second = new FakeEndpoint();
    const { service, binds, logs, clock } = makeService({}, [first, second]);
    const ownLock = `${process.pid} ${ME_START}\n`;
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && first.accepting, { message: "first endpoint accepting" });
    expect(await lockContents()).toBe(ownLock);

    let finishClose!: () => void;
    first.closeGate = new Promise((resolve) => (finishClose = resolve));
    first.failAccept(new Error("Endpoint.acceptNext: socket gone"));
    await waitFor(() => first.closeCalls === 1, { message: "first close started" });
    expect(service.view().status).toEqual({
      kind: "error",
      message: "accept loop stopped: Endpoint.acceptNext: socket gone",
      retryAt: null,
    });
    // An open while the close is still running must not bind next to it.
    service.closeDialog();
    service.openDialog();
    await Bun.sleep(10);
    expect(binds.length).toBe(1);
    expect(await lockContents()).toBe(ownLock);
    finishClose();
    await waitFor(async () => (await lockContents()) === null, { message: "lock released" });
    expect(binds.length).toBe(1);
    expect(logs).toContain("peering: accept loop stopped: Endpoint.acceptNext: socket gone; closing the endpoint");
    expect(logs).toContain("peering: endpoint closed");
    // The dialog is open, so the retry is armed once the close is done.
    await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
    expect(service.view().status).toMatchObject({ retryAt: clock.now() + 5_000 });

    service.closeDialog();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && second.accepting, { message: "rebound" });
    expect(binds.length).toBe(2);
    expect(await lockContents()).toBe(ownLock);
    await service.shutdown();
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
    expect(await lockContents()).toBeNull();
  });

  test("shutdown with nothing bound touches no lock", async () => {
    const { service } = makeService({
      releaseLock: async () => {
        throw new Error("released a lock it never took");
      },
    });
    await service.shutdown();
  });

  test("a failed bind shows the error and releases the lock", async () => {
    const { service, logs, clock } = makeService({
      bindEndpoint: async () => {
        throw new Error("load: dlopen failed");
      },
    });
    service.openDialog();
    await waitFor(() => retryAt(service) !== null, { message: "error, retry armed" });
    expect(service.view().status).toEqual({ kind: "error", message: "load: dlopen failed", retryAt: clock.now() + 5_000 });
    expect(await lockContents()).toBeNull();
    expect(logs).toContain("peering: could not bind the endpoint: load: dlopen failed; retrying in 5 s");
    await service.shutdown();
  });

  test("the real defaults are never reached: the addon loader throws in this file", async () => {
    // Guard for the tests above: they inject bindEndpoint, so the addon is never needed.
    const { defaultPeerServiceDeps } = await import("./service");
    const deps = defaultPeerServiceDeps("Desk", () => {}, () => ({ coordinator: null, repos: [], agents: [], questions: [] }), () => {}, null);
    await expect(deps.bindEndpoint(new Uint8Array(32), [PAIR_ALPN])).rejects.toThrow("a service test loaded the iroh addon");
  });
});

describe("PeerService accept loop", () => {
  test("survives a failed handshake and serves the next connection", async () => {
    const { service, endpoint, logs } = makeService();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    const selfId = service.view().selfId!;

    endpoint.push({
      accept: async () => {
        throw new Error("Incoming.accept: the cryptographic handshake failed");
      },
    });
    const remote = incomingFrom(endpoint, selfId);
    const reply = await rawRequest(remote, encodePairMessage({ op: "pair-hello" }));
    expect(decodePairMessage(reply as Uint8Array)).toEqual({ op: "pair-code-shown" });
    expect(logs).toContain("peering: incoming connection failed: Incoming.accept: the cryptographic handshake failed");
    expect(service.view().session?.stage).toMatchObject({ stage: "code-shown", code: "ABCD1234" });
    expect(service.view().session?.role).toBe("responder");
    expect(service.view().session?.peerId).toBe(ID_REMOTE);
    await service.shutdown();
  });

  test("a connection on an unknown ALPN is closed, and the loop goes on", async () => {
    const { service, endpoint, logs } = makeService();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    const selfId = service.view().selfId!;
    const stray = incomingFrom(endpoint, selfId, "itsybitsy/other/1");
    await waitFor(() => stray.closeInfo() !== null, { message: "stray closed" });
    expect(stray.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.error, reason: "unknown alpn" });
    expect(logs).toContain('peering: closed a connection on unknown ALPN "itsybitsy/other/1"');
    const remote = incomingFrom(endpoint, selfId);
    expect(decodePairMessage((await rawRequest(remote, encodePairMessage({ op: "pair-hello" }))) as Uint8Array)).toEqual({
      op: "pair-code-shown",
    });
    await service.shutdown();
  });

  test("refuses a second request as busy while one is pending, and any request once the dialog closes", async () => {
    const { service, endpoint } = makeService();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    const selfId = service.view().selfId!;

    const first = incomingFrom(endpoint, selfId);
    await rawRequest(first, encodePairMessage({ op: "pair-hello" }));
    const second = incomingFrom(endpoint, selfId);
    expect(decodePairMessage((await rawRequest(second, encodePairMessage({ op: "pair-hello" }))) as Uint8Array)).toEqual({
      op: "pair-refused",
      reason: "busy",
    });

    // Closing the dialog cancels the pending one; the requester sees the cancel code.
    service.closeDialog();
    expect(service.view().session).toBeNull();
    await waitFor(() => first.closeInfo() !== null, { message: "first closed" });
    expect(first.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.cancelled, reason: "cancelled" });
    const third = incomingFrom(endpoint, selfId);
    expect(decodePairMessage((await rawRequest(third, encodePairMessage({ op: "pair-hello" }))) as Uint8Array)).toEqual({
      op: "pair-refused",
      reason: "not-accepting",
    });
    await service.shutdown();
  });
});

describe("PeerService busy rule across directions", () => {
  test("an incoming pair-hello while an outgoing pairing is still dialing gets busy", async () => {
    const { service, endpoint } = makeService();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    const selfId = service.view().selfId!;
    endpoint.connectImpl = () => new Promise(() => {}); // a dial that is still in flight
    const outgoing = "d4".repeat(32);
    expect(service.pairWith(outgoing)).toBeNull();
    expect(service.view().session).toMatchObject({ role: "initiator", peerId: outgoing, stage: { stage: "connecting" } });

    const remote = incomingFrom(endpoint, selfId);
    expect(decodePairMessage((await rawRequest(remote, encodePairMessage({ op: "pair-hello" }))) as Uint8Array)).toEqual({
      op: "pair-refused",
      reason: "busy",
    });
    expect(service.view().session).toMatchObject({ role: "initiator", peerId: outgoing });
    await service.shutdown();
  });

  test("the code of a cancelled request is a wrong code in the next one", async () => {
    const codes = ["ABCD1234", "WXYZ5678"];
    const { service, endpoint } = makeService({ generateCode: () => codes.shift()! });
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    const selfId = service.view().selfId!;

    const first = incomingFrom(endpoint, selfId);
    await rawRequest(first, encodePairMessage({ op: "pair-hello" }));
    expect(service.view().session?.stage).toMatchObject({ stage: "code-shown", code: "ABCD1234" });
    service.cancel();

    const second = incomingFrom(endpoint, selfId);
    await rawRequest(second, encodePairMessage({ op: "pair-hello" }));
    expect(service.view().session?.stage).toMatchObject({ stage: "code-shown", code: "WXYZ5678" });
    const reply = await rawRequest(second, encodePairMessage({ op: "pair-code", code: "ABCD-1234" }));
    expect(decodePairMessage(reply as Uint8Array)).toEqual({ op: "pair-fail", reason: "wrong-code" });
    expect(service.view().session?.stage).toEqual({ stage: "failed", failure: { kind: "wrong-code" } });
    expect(await readPeers()).toEqual([]);
    second.close(PAIR_CLOSE.done, "done");
    await service.shutdown();
  });
});

describe("PeerService pairWith", () => {
  test("checks the typed id and the endpoint state before dialing", async () => {
    const { service, endpoint } = makeService();
    expect(service.pairWith(ID_REMOTE)).toBe("Peering is still starting; try again in a moment.");
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    expect(service.pairWith("nope")).toBe("Not an id: an id is 64 hex characters.");
    expect(service.pairWith(service.view().selfId!)).toBe("That is this install's own id.");
    expect(endpoint.connects).toEqual([]);

    expect(service.pairWith(` ${ID_REMOTE.toUpperCase()} `)).toBeNull();
    expect(service.view().session).toMatchObject({ role: "initiator", peerId: ID_REMOTE });
    await waitFor(() => service.view().session?.stage.stage === "failed", { message: "dial failed" });
    expect(endpoint.connects).toEqual([ID_REMOTE]);
    expect(service.view().session?.stage).toEqual({
      stage: "failed",
      failure: { kind: "connection-failed", detail: "Endpoint.connect: no network in tests" },
    });
    service.dismiss();
    expect(service.view().session).toBeNull();
    await service.shutdown();
  });

  test("Esc while the code is shown cancels and returns to the idle view; session ids increase", async () => {
    const { service, endpoint } = makeService();
    const changes: number[] = [];
    service.onChange(() => changes.push(1));
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    const selfId = service.view().selfId!;
    const remote = incomingFrom(endpoint, selfId);
    await rawRequest(remote, encodePairMessage({ op: "pair-hello" }));
    const firstId = service.view().session!.id;
    service.cancel();
    expect(service.view().session).toBeNull();
    await waitFor(() => remote.closeInfo() !== null, { message: "remote closed" });
    expect(remote.closeInfo()).toEqual({ byPeer: true, code: PAIR_CLOSE.cancelled, reason: "cancelled" });
    const again = incomingFrom(endpoint, selfId);
    await rawRequest(again, encodePairMessage({ op: "pair-hello" }));
    expect(service.view().session!.id).toBeGreaterThan(firstId);
    expect(changes.length).toBeGreaterThan(0);
    await service.shutdown();
  });
});

/**
 * Make `endpoint`'s dials reach a responder (the real one, over an in-memory
 * link) that lists this install and reports `agents`. `events` records each
 * close of a dialed connection, so a test can check what closed first.
 */
function answerDials(endpoint: FakeEndpoint, agents: RemoteAgent[], events: string[] = []): MemoryConnection[] {
  const served: MemoryConnection[] = [];
  endpoint.connectImpl = async (id) => {
    const link = createMemoryLink("00".repeat(32), id);
    served.push(link.b);
    void serveTrustedConnection(link.b, { setTimer: createFakeClock().setTimer, peerName: async () => "paired", snapshot: () => ({ coordinator: null, repos: [], agents, questions: [] }), log: () => {} });
    const conn = serviceConnection(link.a, PEER_ALPN);
    return {
      ...conn,
      close: (code, reason) => {
        events.push(`conn.close ${code} ${reason}`);
        conn.close(code, reason);
      },
    };
  };
  return served;
}

const REMOTE_AGENTS: RemoteAgent[] = [
  { id: "agent-r1", nickname: null, repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: null, createdEpoch: 1_700_000_000, model: null },
];

// The Peers tab's Enter and remove prompt on a paired peer (SPEC §20.1).
describe("PeerService reconnectPeer and removePeer", () => {
  const ID_OTHER = "d4".repeat(32);

  test("reconnectPeer: refused inline while unbound; once bound it closes the link and redials now", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint, logs } = makeService();
    const served = answerDials(endpoint, REMOTE_AGENTS);
    expect(service.reconnectPeer(ID_REMOTE)).toBe("Peering is still starting; try again in a moment.");
    expect(endpoint.connects).toEqual([]);
    await service.bootIfPaired();
    await waitFor(() => service.view().links[0]?.connected === true, { message: "peer polled" });
    expect(service.reconnectPeer(ID_OTHER)).toBe("Not polled yet: its first poll starts within 5 s.");

    expect(service.reconnectPeer(ID_REMOTE)).toBeNull();
    expect(served[0]!.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.done, reason: "reconnecting" });
    expect(service.view().links[0]).toMatchObject({ connected: false, reconnecting: true, lastError: null });
    await waitFor(() => service.view().links[0]?.connected === true, { message: "reconnected" });
    expect(endpoint.connects).toEqual([ID_REMOTE, ID_REMOTE]);
    expect(logs).toContain(`peer link: reconnecting to Laptop C (${ID_REMOTE.slice(0, 10)}) on request: closing the connection and dialing again`);
    expect(logs.filter(line => line.includes("disconnected"))).toEqual([]);
    await service.shutdown();
  });

  test("removePeer: removes by the full id, re-reads the list and drops the link at once; a failure is returned", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    await addPeer({ id: ID_OTHER, name: "Desk" });
    const targets: string[] = [];
    let failure: Error | null = null;
    const { service, endpoint, logs } = makeService({
      removePeer: async (target) => {
        targets.push(target);
        if (failure) throw failure;
        return removePeer(target);
      },
    });
    const served = answerDials(endpoint, REMOTE_AGENTS);
    await service.bootIfPaired();
    await waitFor(() => service.view().links.every(link => link.connected) && service.view().links.length === 2, { message: "both polled" });

    failure = new Error("disk full");
    expect(await service.removePeer(ID_REMOTE)).toBe("Could not remove Laptop C: disk full");
    expect(service.view().peers.map(p => p.id)).toEqual([ID_REMOTE, ID_OTHER]);
    failure = null;

    expect(await service.removePeer(ID_REMOTE)).toBeNull();
    expect(targets).toEqual([ID_REMOTE, ID_REMOTE]);
    expect((await readPeers()).map(p => p.id)).toEqual([ID_OTHER]);
    expect(service.view().peers.map(p => p.id)).toEqual([ID_OTHER]);
    // No tick: the poller has already dropped it.
    expect(service.view().links.map(link => link.id)).toEqual([ID_OTHER]);
    expect(served[endpoint.connects.indexOf(ID_REMOTE)]!.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.done, reason: "removed" });
    expect(served[endpoint.connects.indexOf(ID_OTHER)]!.closeInfo()).toBeNull();
    expect(logs).toContain(`peer link: stopped polling Laptop C (${ID_REMOTE.slice(0, 10)}): no longer in peers.json`);

    expect(await service.removePeer(ID_REMOTE)).toBe(`${ID_REMOTE.slice(0, 10)} was already removed.`);
    await service.shutdown();
  });

  test("removePeer: a poll's peers.json read from before the removal does not bring the peer back", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    await addPeer({ id: ID_OTHER, name: "Desk" });
    // The next read returns `hold` instead, once.
    let hold: Promise<Peer[]> | null = null;
    const { service, endpoint, clock } = makeService({
      readPeers: () => {
        const held = hold;
        hold = null;
        return held ?? readPeers();
      },
    });
    answerDials(endpoint, REMOTE_AGENTS);
    await service.bootIfPaired();
    await waitFor(() => service.view().links.length === 2 && service.view().links.every(link => link.connected), { message: "both polled" });

    const stale = await readPeers();
    const read = gate<void>();
    hold = read.promise.then(() => stale);
    elapse(clock, PEER_POLL_INTERVAL_MS); // a tick, whose read is held with the old list
    await flushMicrotasks();
    expect(hold).toBeNull();
    expect(await service.removePeer(ID_REMOTE)).toBeNull();
    read.resolve();
    await flushMicrotasks();
    expect(service.view().peers.map(p => p.id)).toEqual([ID_OTHER]);
    expect(service.view().links.map(link => link.id)).toEqual([ID_OTHER]);
    expect(endpoint.connects.filter(id => id === ID_REMOTE)).toHaveLength(1);
    await service.shutdown();
  });
});

describe("PeerService at boot", () => {
  test.skipIf(process.env.IB_LIVE_CALLER !== "1")("reads launchd from the production macOS ps columns", async () => {
    expect(await remoteStartDenialAtStartup({
      stdinTTY: true, stdoutTTY: true, env: {}, cwd: "/", pid: 1,
      resolveCaller: async () => "no-agent",
    })).toBeNull();
  });

  test.each([
    ["human", true, true, undefined, null],
    ["agent", true, true, undefined, "Only a human"],
    ["system coordinator", true, true, "/tmp/tmux-501/default,13,0", "inside tmux"],
    ["custom tmux directory", true, true, "/other/tmp/server,12,0", "inside tmux"],
    ["empty tmux variable", true, true, "", "inside tmux"],
    ["non-TTY input", false, true, undefined, "interactive terminal"],
    ["non-TTY output", true, false, undefined, "interactive terminal"],
    ["malformed tmux", true, true, "?", "inside tmux"],
    ["claude", true, true, undefined, "disabled under claude"],
    ["codex", true, true, undefined, "disabled under codex"],
    ["agy", true, true, undefined, "disabled under agy"],
    ["ancestry error", true, true, undefined, "Cannot verify dashboard process ancestry"],
    ["missing parent", true, true, undefined, "Cannot verify dashboard process ancestry"],
    ["kernel agent", true, true, undefined, "disabled under codex"],
    ["missing kernel name", true, true, undefined, "Cannot verify dashboard process ancestry"],
    ["missing executable", true, true, undefined, "Cannot verify dashboard process ancestry"],
    ["early PID zero", true, true, undefined, "Cannot verify dashboard process ancestry"],
    ["cycle", true, true, undefined, "Cannot verify dashboard process ancestry"],
    ["damaged metadata", true, true, undefined, "Cannot verify"],
    ["resolver error", true, true, undefined, "Cannot verify"],
  ] as const)("classifies the %s dashboard once for the service lifetime", async (kind, stdinTTY, stdoutTTY, tmux, reason) => {
    let evidence = kind as string;
    const input = { stdinTTY, stdoutTTY, env: { TMUX: tmux }, cwd: "/app", pid: 30,
      readProcessTable: async (command: string[]) => {
        expect(command).toEqual(["/bin/ps", "-axww", "-o", "pid=PID,ppid=PPID,lstart=STARTED,ucomm=KERNEL,comm=COMMAND"]);
        if (evidence === "ancestry error") throw new Error("ps failed");
        const parent = evidence === "missing parent" ? 999 : evidence === "early PID zero" ? 0 : evidence === "cycle" ? 30 : 1;
        const exe = ["claude", "codex", "agy"].includes(evidence) ? evidence : "Terminal";
        const kernel = evidence === "missing kernel name" ? "" : evidence === "kernel agent" ? "codex" : "My Terminal";
        const commandName = evidence === "missing executable" ? "" : `/Applications/My Apps/${exe}`;
        return [
          "PID PPID STARTED                  KERNEL           COMMAND",
          " 30   20 Sat Nov 21 12:01:00 2026 ib               /bin/ib",
          " 20   10 Sat Nov 21 12:01:00 2026 zsh              /bin/zsh",
          ` 10 ${String(parent).padStart(4)} Sat Nov 21 12:01:00 2026 ${kernel.padEnd(16)} ${commandName}`,
          "  1    0 Sat Nov 21 12:01:00 2026 launchd          /sbin/launchd",
        ].join("\n");
      },
      resolveCaller: async (): Promise<"agent" | "no-agent" | "unverifiable"> => {
        if (evidence === "resolver error") throw new Error("unavailable");
        if (evidence === "damaged metadata") return "unverifiable";
        return evidence === "agent" ? "agent" : "no-agent";
      },
    };
    const decision = await remoteStartDenialAtStartup(input);
    // Redirected input is valid for a CLI send with a terminal on stdout.
    const sendDenial = await humanSendTerminalDenial(input);
    expect(sendDenial === null).toBe(kind === "human" || kind === "non-TTY input");
    if (tmux !== undefined) {
      expect(decision).toBe("Remote starts are disabled inside tmux");
      expect(sendDenial).toContain("run ib send from a terminal outside tmux");
      expect(await humanSendTerminalDenial(input, "local-send")).toBeNull();
    }
    const { service } = makeService({ remoteStartDenial: decision });
    if (reason === null) expect(decision).toBeNull();
    else expect(decision).toContain(reason);
    evidence = reason ? "human" : "agent";
    Object.assign(input, { stdinTTY: !!reason, stdoutTTY: !!reason, env: {} });
    const request = { repo: "app", type: "worker", prompt: "hello" };
    await expect(service.startRemoteAgent(ID_REMOTE, request)).rejects.toThrow(reason ?? "no longer paired");
  });

  test.each(["process table", "metadata"])("boots while the %s reader is pending and keeps a timeout denial after it finishes", async stage => {
    const table = "PID PPID STARTED                  KERNEL COMMAND\n  1    0 Sat Nov 21 12:01:00 2026 init   /sbin/launchd";
    const release = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<AbortSignal>();
    let signal: AbortSignal;
    const clock = createFakeClock();
    const decision = remoteStartDenialAtStartup({
      stdinTTY: true, stdoutTTY: true, env: {}, cwd: "/", pid: 1,
      readProcessTable: async (_command, abort) => {
        signal = abort;
        if (stage === "process table") {
          reading.resolve(abort);
          await release.promise;
        } else {
          clock.advance(1_500);
        }
        return table;
      },
      resolveCaller: async () => {
        if (stage === "metadata") {
          reading.resolve(signal);
          await release.promise;
        }
        return "no-agent";
      },
    }, clock);
    const service = new PeerService(defaultPeerServiceDeps("Desk", () => {}, () => ({ coordinator: null, repos: [], agents: [], questions: [] }), () => {}, decision, home));
    try {
      const observed = await reading.promise;
      await service.bootIfPaired();
      expect(service.remoteStartDenial).toBe("checking whether remote starts are allowed");
      const request = { repo: "app", type: "worker", prompt: "hello" };
      await expect(service.startRemoteAgent(ID_REMOTE, request)).rejects.toThrow("checking whether remote starts are allowed");
      const changes: (string | null)[] = [];
      service.onChange(() => changes.push(service.remoteStartDenial));
      clock.advance(stage === "process table" ? 1_999 : 499);
      await flushMicrotasks();
      expect(observed.aborted).toBe(false);
      expect(service.remoteStartDenial).toBe("checking whether remote starts are allowed");
      clock.advance(1);
      expect(await decision).toContain("timed out");
      expect(observed.aborted).toBe(true);
      release.resolve();
      await flushMicrotasks();
      expect(changes).toEqual([service.remoteStartDenial]);
      await expect(service.startRemoteAgent(ID_REMOTE, request)).rejects.toThrow("timed out");
    } finally { release.resolve(); await service.shutdown(); }
  });

  test("caches one denial when the reader succeeds at the deadline before the timer fires", async () => {
    const clock = createFakeClock();
    const table = Promise.withResolvers<string>();
    const resolveCaller = mock(async () => "no-agent" as const);
    const decision = remoteStartDenialAtStartup({
      stdinTTY: true, stdoutTTY: true, env: {}, cwd: "/", pid: 1,
      readProcessTable: () => table.promise,
      resolveCaller,
    }, clock);
    const { service } = makeService({ remoteStartDenial: decision });
    const changes: (string | null)[] = [];
    service.onChange(() => changes.push(service.remoteStartDenial));

    clock.jump(2_000);
    expect(clock.pending()).toBe(1);
    table.resolve("PID PPID STARTED                  KERNEL COMMAND\n  1    0 Sat Nov 21 12:01:00 2026 init   /sbin/launchd");
    const denial = await decision;
    expect(resolveCaller).toHaveBeenCalledTimes(1);
    expect(denial).toContain("timed out");
    expect(clock.pending()).toBe(0);
    clock.advance(0);
    await flushMicrotasks();
    expect(service.remoteStartDenial).toBe(denial);
    expect(changes).toEqual([denial]);
  });

  test.each(["caller denied", "local removal"])("pane and prompt reads open no stream while pending or after %s", async scenario => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const decision = gate<string | null>();
    const { service, endpoint } = makeService({ remoteStartDenial: decision.promise });
    const connections = answerDials(endpoint, []);
    try {
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      const open = spyOn(connections[0]!.peer, "openBi");
      await expect(service.fetchPane(ID_REMOTE, { op: "coordinator-pane" }, 200)).rejects.toThrow("checking whether remote starts are allowed");
      await expect(service.fetchAgentPrompt(ID_REMOTE, "app", "worker")).rejects.toThrow("checking whether remote starts are allowed");
      decision.resolve(scenario === "caller denied" ? "Dashboard inside tmux" : null);
      await flushMicrotasks();
      if (scenario === "local removal") await writeFile(peersFile(), "[]");
      const refusal = scenario === "caller denied" ? "Dashboard inside tmux" : "Machine is no longer paired";
      await expect(service.fetchPane(ID_REMOTE, { op: "agent-pane", repo: "app", id: "worker" }, 200)).rejects.toThrow(refusal);
      await expect(service.fetchAgentPrompt(ID_REMOTE, "app", "worker")).rejects.toThrow(refusal);
      expect(open).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
    }
  });

  test("dashboard lifecycle commands require the startup human decision before opening a stream", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const decision = gate<string | null>();
    const { service, endpoint } = makeService({ remoteStartDenial: decision.promise });
    const connections = answerDials(endpoint, []);
    try {
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      const open = spyOn(connections[0]!.peer, "openBi");
      const request = { action: "merge" as const, repo: "app", id: "worker" };
      await expect(service.runRemoteLifecycle(ID_REMOTE, request)).rejects.toThrow("checking whether remote merge is allowed");
      decision.resolve("Only a human can start an agent on another machine");
      await flushMicrotasks();
      await expect(service.runRemoteLifecycle(ID_REMOTE, request)).rejects.toThrow("Only a human can merge an agent on another machine");
      expect(open).not.toHaveBeenCalled();
    } finally { await service.shutdown(); }
  });

  test("a CLI lifecycle handoff names the peer by its clean name; a dashboard command by its stored name", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { AmbiguousRemoteRehire } = await import("./remote-lifecycle");
    const { service, endpoint } = makeService();
    const request = { action: "rehire" as const, id: "former" };
    try {
      // The CLI's errors are agent-visible; the dashboard's notices show the display name.
      await expect(service.runRemoteLifecycle(ID_REMOTE, request, "handoff")).rejects.toThrow("laptop-c is disconnected");
      await expect(service.runRemoteLifecycle(ID_REMOTE, { action: "retire", repo: "app", id: "worker" }, "dashboard"))
        .rejects.toThrow("Laptop C is disconnected");
      endpoint.connectImpl = async id => {
        const link = createMemoryLink("00".repeat(32), id);
        void serveTrustedConnection(link.b, {
          setTimer: createFakeClock().setTimer, peerName: async () => "paired", log() {},
          snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }),
          lifecycle: async () => { throw new AmbiguousRemoteRehire("'former' matches several agents", [{ repo: "app", id: "a-1" }, { repo: "web", id: "w-1" }]); },
        });
        return serviceConnection(link.a, PEER_ALPN);
      };
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      await expect(service.runRemoteLifecycle(ID_REMOTE, request, "handoff"))
        .rejects.toThrow("'former' matches several agents; use laptop-c/app/a-1 or laptop-c/web/w-1");
    } finally { await service.shutdown(); }
  });

  test("a verified CLI handoff uses the connected stream even when dashboard sends are denied", async () => {
    const { textHeader } = await import("./peer-outbox");
    const header = textHeader({ kind: "agent", agent: "helper" }, "hi", { kind: "user" });
    const { service, endpoint } = makeService({ remoteStartDenial: "inside tmux" });
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const received: string[] = [];
    endpoint.connectImpl = async id => {
      const link = createMemoryLink("00".repeat(32), id);
      void serveTrustedConnection(link.b, {
        setTimer: createFakeClock().setTimer, peerName: async () => "paired",
        snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }), log() {},
        receiveMessage: async message => { received.push(message.id); },
      });
      return serviceConnection(link.a, PEER_ALPN);
    };
    try {
      await expect(service.sendRemoteMessage(ID_REMOTE, header, "handoff")).rejects.toThrow("disconnected");
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      await expect(service.sendRemoteMessage(ID_REMOTE, header)).rejects.toThrow("inside tmux");
      let alive = true;
      const name = service["peerName"].bind(service);
      const pairing = spyOn(service as any, "peerName").mockImplementation(async () => {
        const paired = await name(ID_REMOTE); alive = false; return paired;
      });
      try {
        await expect(service.sendRemoteMessage(ID_REMOTE, header, "handoff", {
          verifyClient() { if (!alive) throw Error("client exited"); },
        })).rejects.toThrow("client exited");
        expect(received).toEqual([]);
      } finally { pairing.mockRestore(); }
      expect(await service.sendRemoteMessage(ID_REMOTE, header, "handoff")).toBe(header.id);
      await writeFile(peersFile(), "[]");
      await expect(service.sendRemoteMessage(ID_REMOTE, header, "handoff")).rejects.toThrow("no longer paired");
      expect(received).toEqual([header.id]);
    } finally { await service.shutdown(); }
  });

  test("startRemoteAgent uses the connected peer stream and honors local unpairing before the next poll", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint } = makeService();
    const starts: unknown[] = [];
    endpoint.connectImpl = async id => {
      const link = createMemoryLink("00".repeat(32), id);
      void serveTrustedConnection(link.b, {
        setTimer: createFakeClock().setTimer,
        peerName: async () => "paired", snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }), log: () => {},
        startAgent: async request => { starts.push(request); return "my-agent"; },
        startAgentWithFiles: async (header, _peer, _name, body) => {
          starts.push({ ...header, body: new TextDecoder().decode(await body.read(16)) });
          return "with-files";
        },
      });
      return serviceConnection(link.a, PEER_ALPN);
    };
    const request = { repo: "app", type: "worker", prompt: "hello" };
    const files = [{ name: "a.txt", size: 3, sha256: "0".repeat(64), spellings: ["./a.txt"] }];
    const filesDir = join(home, "outgoing");
    await mkdir(filesDir);
    await writeFile(join(filesDir, "0"), "abc");
    try {
      await expect(service.startRemoteAgent(ID_REMOTE, request)).rejects.toThrow("disconnected");
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      expect(await service.startRemoteAgent(ID_REMOTE, request)).toBe("my-agent");
      expect(await service.startRemoteAgent(ID_REMOTE, { ...request, files }, { filesDir })).toBe("with-files");
      await writeFile(peersFile(), "[]");
      await expect(service.startRemoteAgent(ID_REMOTE, request)).rejects.toThrow("no longer paired");
      expect(starts).toEqual([{ op: "new-agent", ...request }, { op: "new-agent", ...request, files, body: "abc" }]);
      expect(endpoint.connects).toEqual([ID_REMOTE]);
    } finally {
      await service.shutdown();
    }
  });

  test("an outbound send or start with files logs one line when its transfer starts and one when it ends; one without files logs none", async () => {
    const { textHeader } = await import("./peer-outbox");
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint, logs } = makeService();
    /** Read a request's bodies through FIN: the sender has reported every byte by then. */
    const drain = async (body: { read(limit: number): Promise<Uint8Array> }) => { while ((await body.read(16)).length); };
    endpoint.connectImpl = async id => {
      const link = createMemoryLink("00".repeat(32), id);
      void serveTrustedConnection(link.b, {
        setTimer: createFakeClock().setTimer, peerName: async () => "paired", log: () => {},
        snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }),
        startAgentWithFiles: async (_header, _peer, _name, body) => { await drain(body); return "with-files"; },
        receiveMessage: async (header, _peer, _name, body) => {
          if (body) await drain(body);
          if (header.files.length) throw new Error("Agent not found: helper");
        },
      });
      return serviceConnection(link.a, PEER_ALPN);
    };
    const files = [{ name: "a.txt", size: 3, sha256: "0".repeat(64), spellings: ["./a.txt"] }];
    const filesDir = join(home, "outgoing");
    await mkdir(filesDir);
    await writeFile(join(filesDir, "0"), "abc");
    const peer = `Laptop C (${ID_REMOTE.slice(0, 10)})`;
    try {
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      const progress: number[] = [];
      const header = textHeader({ kind: "agent", agent: "helper" }, "hi", { kind: "user" });
      expect(await service.sendRemoteMessage(ID_REMOTE, header, "handoff")).toBe(header.id);
      expect(logs.filter(line => line.includes("transfer"))).toEqual([]);
      expect(await service.startRemoteAgent(ID_REMOTE, { repo: "app", type: "worker", prompt: "use ./a.txt", files }, { filesDir, onProgress: bytes => progress.push(bytes) })).toBe("with-files");
      // The caller's own progress callback still sees every report.
      expect(progress.at(-1)).toBe(3);
      await expect(service.sendRemoteMessage(ID_REMOTE, { ...textHeader({ kind: "agent", agent: "helper" }, "read ./a.txt", { kind: "user" }), files }, "handoff", { filesDir }))
        .rejects.toThrow("Agent not found: helper");
      expect(logs.filter(line => line.includes("transfer"))).toEqual([
        `peer link: transfer started: new-agent to ${peer}: 1 file, 3 bytes`,
        `peer link: transfer ok: new-agent to ${peer}: 3 of 3 bytes in 0.0 s, 2.9 KB/s`,
        `peer link: transfer started: send to ${peer}: 1 file, 3 bytes`,
        `peer link: transfer failed (Agent not found: helper): send to ${peer}: 3 of 3 bytes in 0.0 s, 2.9 KB/s`,
      ]);
    } finally {
      await service.shutdown();
    }
  });

  test("acknowledgeRemoteQuestion waits for the startup human decision, needs the connected link, then asks the peer", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const decision = gate<string | null>();
    const { service, endpoint } = makeService({ remoteStartDenial: decision.promise });
    const acks: unknown[][] = [];
    endpoint.connectImpl = async id => {
      const link = createMemoryLink("00".repeat(32), id);
      void serveTrustedConnection(link.b, {
        setTimer: createFakeClock().setTimer,
        peerName: async () => "paired", snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }), log: () => {},
        acknowledgeQuestion: async (repo, questionId) => { acks.push([repo, questionId]); },
      });
      return serviceConnection(link.a, PEER_ALPN);
    };
    try {
      await expect(service.acknowledgeRemoteQuestion(ID_REMOTE, "app", "q-1")).rejects.toThrow("checking whether remote acknowledge is allowed");
      decision.resolve(null);
      await flushMicrotasks();
      await expect(service.acknowledgeRemoteQuestion(ID_REMOTE, "app", "q-1")).rejects.toThrow("Laptop C is disconnected");
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      await service.acknowledgeRemoteQuestion(ID_REMOTE, "app", "q-1");
      expect(acks).toEqual([["app", "q-1"]]);
    } finally {
      await service.shutdown();
    }
  });

  test("remotePermissions waits for the startup human decision, needs the connected link, then asks the peer", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const decision = gate<string | null>();
    const { service, endpoint } = makeService({ remoteStartDenial: decision.promise });
    const requests: unknown[] = [];
    endpoint.connectImpl = async id => {
      const link = createMemoryLink("00".repeat(32), id);
      void serveTrustedConnection(link.b, {
        setTimer: createFakeClock().setTimer,
        peerName: async () => "paired", snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }), log: () => {},
        permissions: async request => { requests.push(request); return { canSpawnChildren: true }; },
      });
      return serviceConnection(link.a, PEER_ALPN);
    };
    const read = { repo: "app", id: "worker" };
    try {
      await expect(service.remotePermissions(ID_REMOTE, read)).rejects.toThrow("checking whether remote permission changes are allowed");
      decision.resolve(null);
      await flushMicrotasks();
      await expect(service.remotePermissions(ID_REMOTE, read)).rejects.toThrow("Laptop C is disconnected");
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      expect(await service.remotePermissions(ID_REMOTE, { ...read, allow: "Read" })).toEqual({ canSpawnChildren: true });
      expect(requests).toEqual([{ ...read, allow: "Read" }]);
    } finally {
      await service.shutdown();
    }
  });

  test("a denied dashboard opens no stream for remotePermissions", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint } = makeService({ remoteStartDenial: "Only a human can start an agent on another machine" });
    const connections = answerDials(endpoint, []);
    try {
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      const open = spyOn(connections[0]!.peer, "openBi");
      await expect(service.remotePermissions(ID_REMOTE, { repo: "app", id: "worker", canSpawnChildren: true }))
        .rejects.toThrow("Only a human can change an agent's permissions on another machine");
      expect(open).not.toHaveBeenCalled();
    } finally { await service.shutdown(); }
  });

  test("the owning watch renews the lease each poll and replaces the snapshot only on visible changes", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { writeRemoteAgents, renewLease } = defaultPeerServiceDeps("Desk", () => {}, () => ({ coordinator: null, repos: [], agents: [], questions: [] }), () => {}, null);
    const { service, endpoint, clock } = makeService({ writeRemoteAgents, renewLease });
    answerDials(endpoint, [{ ...REMOTE_AGENTS[0]!, repoName: "display only" }]);
    await service.bootIfPaired();
    const file = join(peerDir(), "remote-agents.json");
    try {
      await waitFor(() => service.view().links[0]?.connected === true, { message: "first snapshot" });
      const first = JSON.parse(await readFile(file, "utf8")).peers;
      expect(first).toEqual([{ id: ID_REMOTE, name: "Laptop C", connected: true, lastOkAt: clock.now(),
        agents: [{ repo: "app", id: "agent-r1", nickname: null, state: "running" }] }]);
      const original = await open(file);
      try {
        const inode = (await original.stat()).ino;
        expect(await readConnectedPeers()).toEqual(first);
        starts.set(process.pid, ME_START + 1);
        expect(await readConnectedPeers()).toEqual([]);
        starts.delete(process.pid); // ps is unavailable to the reader.
        await utimes(peerEndpointLockFile(), new Date(0), new Date(0));
        expect(await readConnectedPeers()).toEqual([]);
        starts.set(process.pid, ME_START); // watch uses its real process start.
        clock.advance(5000);
        await waitFor(() => service.view().links[0]?.lastOkAt === clock.now(), { message: "identical snapshot" });
        expect((await stat(file)).ino).toBe(inode);
        starts.delete(process.pid);
        expect(await readConnectedPeers()).toEqual(first);
        starts.set(process.pid, ME_START);
        expect(JSON.parse(await readFile(file, "utf8")).peers).toEqual(first);
        await service.shutdown();
        expect((await stat(file)).ino).not.toBe(inode);
        expect(JSON.parse(await original.readFile("utf8")).peers).toEqual(first);
        expect(JSON.parse(await readFile(file, "utf8")).peers[0].connected).toBe(false);
      } finally {
        await original.close();
      }
    } finally {
      await service.shutdown();
    }
  });

  test("binds when peers.json lists a peer, on both ALPNs, and starts polling it; a later dialog open does not rebind", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint, binds, logs } = makeService();
    answerDials(endpoint, REMOTE_AGENTS);
    await service.bootIfPaired();
    expect(service.view().status).toEqual({ kind: "listening" });
    expect(binds).toEqual([[PAIR_ALPN, PEER_ALPN]]);
    expect(await lockContents()).toBe(`${process.pid} ${ME_START}\n`);
    expect(logs).toContain("peering: binding at boot for 1 paired peer");
    expect(service.view().peers.map((p) => p.name)).toEqual(["Laptop C"]);

    await waitFor(() => service.view().links[0]?.connected === true, { message: "peer polled" });
    expect(service.view().links).toEqual([
      { id: ID_REMOTE, name: "Laptop C", connected: true, connectedAt: expect.any(Number), lastOkAt: expect.any(Number), lastError: null, coordinator: null, repos: [], agents: REMOTE_AGENTS, questions: [], reconnecting: false },
    ]);
    expect(endpoint.connects).toEqual([ID_REMOTE]);

    service.openDialog();
    await Bun.sleep(10);
    expect(binds.length).toBe(1);
    await service.shutdown();
  });

  test("with no peers (no file, or an empty list) nothing binds and the addon is never loaded", async () => {
    let loads = 0;
    irohAddonLoaderCtx.set(async () => {
      loads++;
      throw new Error("loaded");
    });
    const realBind = defaultPeerServiceDeps("Desk", () => {}, () => ({ coordinator: null, repos: [], agents: [], questions: [] }), () => {}, null).bindEndpoint;
    for (const setup of [async () => {}, async () => {
      await mkdir(peerDir(), { recursive: true });
      await writeFile(peersFile(), "[]\n");
    }]) {
      await setup();
      const { service, logs } = makeService({ bindEndpoint: realBind });
      await service.bootIfPaired();
      expect(service.view().status).toEqual({ kind: "idle" });
      expect(service.view().links).toEqual([]);
      expect(await lockContents()).toBeNull();
      expect(logs).toEqual([]);
    }
    expect(loads).toBe(0);
  });

  test("another live ib watch holds the lock: no bind, it is logged, and the status says so", async () => {
    alive.add(OTHER.pid);
    starts.set(OTHER.pid, OTHER.startEpoch);
    await mkdir(peerDir(), { recursive: true });
    await writeFile(peerEndpointLockFile(), `${OTHER.pid} ${OTHER.startEpoch}\n`);
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });

    const { service, endpoint, binds, logs } = makeService();
    await service.bootIfPaired();
    expect(service.view().status).toEqual({ kind: "disabled", ownerPid: OTHER.pid });
    expect(binds).toEqual([]);
    expect(logs).toContain(`peering disabled: ib watch pid ${OTHER.pid} owns the endpoint`);
    expect(await lockContents()).toBe(`${OTHER.pid} ${OTHER.startEpoch}\n`);
    await Bun.sleep(10);
    expect(endpoint.connects).toEqual([]);
    expect(service.view().links).toEqual([]);
    await service.shutdown();
  });

  test("bootIfPaired after shutdown does nothing: peers.json is not even read", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    let reads = 0;
    const { service, binds, logs } = makeService({
      readPeers: async () => {
        reads++;
        return readPeers();
      },
    });
    await service.shutdown();
    await service.bootIfPaired();
    expect(reads).toBe(0);
    expect(binds).toEqual([]);
    expect(service.view().status).toEqual({ kind: "idle" });
    expect(await lockContents()).toBeNull();
    expect(logs).toEqual([]);
  });

  test("a malformed peers.json binds nothing and shows its error", async () => {
    await mkdir(peerDir(), { recursive: true });
    await writeFile(peersFile(), "{");
    const { service, binds, logs } = makeService();
    await service.bootIfPaired();
    expect(service.view().status).toEqual({ kind: "idle" });
    expect(binds).toEqual([]);
    expect(service.view().peersError).toContain("not valid JSON");
    expect(logs.some((line) => line.startsWith("peering: not binding at boot:"))).toBe(true);
  });

  test("shutdown stops the poller before it closes the endpoint", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint } = makeService();
    const events: string[] = [];
    const served = answerDials(endpoint, REMOTE_AGENTS, events);
    const close = endpoint.close.bind(endpoint);
    endpoint.close = async () => {
      events.push("endpoint.close");
      await close();
    };
    await service.bootIfPaired();
    await waitFor(() => service.view().links[0]?.connected === true, { message: "peer polled" });
    await service.shutdown();
    expect(events).toEqual([`conn.close ${PEER_CLOSE.done} shutting down`, "endpoint.close"]);
    expect(served[0]!.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.done, reason: "shutting down" });
    expect(service.view().links[0]).toMatchObject({ connected: false, agents: REMOTE_AGENTS });
  });

  test("a failed accept loop stops the poller with the endpoint", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint } = makeService();
    const served = answerDials(endpoint, REMOTE_AGENTS);
    await service.bootIfPaired();
    await waitFor(() => service.view().links[0]?.connected === true && endpoint.accepting, { message: "polled and accepting" });
    endpoint.failAccept(new Error("Endpoint.acceptNext: socket gone"));
    await waitFor(() => service.view().status.kind === "error", { message: "loop failed" });
    await waitFor(() => served[0]!.closeInfo() !== null, { message: "poller connection closed" });
    expect(service.view().links[0]?.connected).toBe(false);
    await service.shutdown();
  });
});

/** `clock.setTimer`, recording each timer and whether it is still armed. */
function recordTimers(clock: FakeClock) {
  const timers: Array<{ ms: number; fn: () => void; armed: boolean }> = [];
  const setTimer = (ms: number, fn: () => void): (() => void) => {
    const timer = { ms, fn, armed: true };
    timers.push(timer);
    const cancel = clock.setTimer(ms, () => {
      timer.armed = false;
      fn();
    });
    return () => {
      timer.armed = false;
      cancel();
    };
  };
  return { timers, setTimer };
}

describe("PeerService self-heal", () => {
  const SOCKET_GONE = "Endpoint.acceptNext: socket gone";
  const NOT_NEEDED = "peering: not retrying the bind: no paired peers and the Peers tab is hidden";
  const OWN_LOCK = `${process.pid} ${ME_START}\n`;
  const AT_CAP = "retrying every 60 s, not logging this error again until it changes";
  /** watch.log lines about retrying; each failure has exactly one, so there is no separate "retrying" line. */
  const retryLines = (logs: string[]) => logs.filter((line) => /retrying|recovered/.test(line));
  const recovered = (failures: number) =>
    `peering: recovered after ${failures} failure${failures === 1 ? "" : "s"}: the endpoint has stayed up for 60 s`;

  test("an accept-loop failure rebinds after 5 s, through the lock, and the poller runs again", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const first = new FakeEndpoint();
    const second = new FakeEndpoint();
    const { service, binds, logs, clock, calls } = makeService({}, [first, second]);
    answerDials(first, REMOTE_AGENTS);
    answerDials(second, REMOTE_AGENTS);
    await service.bootIfPaired();
    await waitFor(() => service.view().links[0]?.connected === true && first.accepting, { message: "polled and accepting" });

    first.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
    expect(service.view().status).toEqual({ kind: "error", message: `accept loop stopped: ${SOCKET_GONE}`, retryAt: clock.now() + 5_000 });
    expect(first.closeCalls).toBe(1);
    expect(await lockContents()).toBeNull();
    expect(service.view().links[0]?.connected).toBe(false);
    expect(logs).toContain(`peering: accept loop stopped: ${SOCKET_GONE}; closing the endpoint`);
    expect(logs).toContain(`peering: accept loop stopped: ${SOCKET_GONE}; retrying in 5 s`);

    const before = { ...calls };
    clock.advance(4_999);
    await flushMicrotasks();
    expect(calls).toEqual(before); // not due yet: no retry has started
    expect(retryAt(service)).toBe(clock.now() + 1);
    clock.advance(1);
    await waitFor(() => service.view().status.kind === "listening" && second.accepting, { message: "rebound" });
    expect(binds).toEqual([[PAIR_ALPN, PEER_ALPN], [PAIR_ALPN, PEER_ALPN]]);
    expect(await lockContents()).toBe(OWN_LOCK);
    await waitFor(() => service.view().links[0]?.connected === true, { message: "polled again" });
    expect(second.connects).toEqual([ID_REMOTE]);
    expect(retryLines(logs)).toEqual([`peering: accept loop stopped: ${SOCKET_GONE}; retrying in 5 s`]);
    clock.advance(60_000); // recovered once the rebind has stayed up for 60 s
    expect(retryLines(logs)).toEqual([`peering: accept loop stopped: ${SOCKET_GONE}; retrying in 5 s`, recovered(1)]);
    await service.shutdown();
    expect(second.closeCalls).toBe(1);
  });

  test("repeated bind failures back off 5, 10, 20, 40, 60, 60 s, one log line each; a bind that stays up resets it to 5 s", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const fail = (n: number) => new Error(`load: dlopen failed ${n}`);
    const endpoint = new FakeEndpoint();
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's dial stays pending
    const { service, binds, logs, clock, calls } = makeService({}, [fail(1), fail(2), fail(3), fail(4), fail(5), fail(6), endpoint]);
    await service.bootIfPaired();

    const waits: number[] = [];
    for (let failure = 1; failure <= 6; failure++) {
      await waitFor(() => retryAt(service) !== null, { message: `retry ${failure} armed` });
      expect(service.view().status).toMatchObject({ kind: "error", message: `load: dlopen failed ${failure}` });
      expect(await lockContents()).toBeNull();
      const wait = retryAt(service)! - clock.now();
      waits.push(wait / 1000);
      const before = { ...calls };
      clock.advance(wait - 1);
      await flushMicrotasks();
      expect(calls).toEqual(before);
      clock.advance(1);
      await waitFor(() => binds.length === failure + 1, { message: `bind ${failure + 1}` });
    }
    expect(waits).toEqual([5, 10, 20, 40, 60, 60]);
    await waitFor(() => service.view().status.kind === "listening" && endpoint.accepting, { message: "bound" });
    // Each failure is a different error, so each is logged, at the cap too.
    expect(retryLines(logs)).toEqual([
      "peering: could not bind the endpoint: load: dlopen failed 1; retrying in 5 s",
      "peering: could not bind the endpoint: load: dlopen failed 2; retrying in 10 s",
      "peering: could not bind the endpoint: load: dlopen failed 3; retrying in 20 s",
      "peering: could not bind the endpoint: load: dlopen failed 4; retrying in 40 s",
      `peering: could not bind the endpoint: load: dlopen failed 5; ${AT_CAP}`,
      `peering: could not bind the endpoint: load: dlopen failed 6; ${AT_CAP}`,
    ]);
    clock.advance(60_000);
    expect(retryLines(logs).at(-1)).toBe(recovered(6));

    endpoint.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => retryAt(service) !== null, { message: "retry after the loop failed" });
    expect(retryAt(service)! - clock.now()).toBe(5_000);
    await service.shutdown();
  });

  test("a permanent failure logs one line per attempt up to the 60 s cap, then only when the error changes", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const same = new Error("load: dlopen failed");
    const other = new Error("bind: address in use");
    const endpoint = new FakeEndpoint();
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's dial stays pending
    const script = [same, same, same, same, same, same, same, other, same, endpoint];
    const { service, binds, logs, clock } = makeService({}, script);
    await service.bootIfPaired();
    for (let failure = 1; failure <= 9; failure++) {
      await waitFor(() => retryAt(service) !== null, { message: `retry ${failure} armed` });
      clock.advance(retryAt(service)! - clock.now());
      await waitFor(() => binds.length === failure + 1, { message: `bind ${failure + 1}` });
    }
    await waitFor(() => service.view().status.kind === "listening" && endpoint.accepting, { message: "bound" });
    const selfId = service.view().selfId!;
    elapse(clock, 60_000);
    // Failures 6 and 7 repeat failure 5 at the cap: not logged. 8 differs, and 9 differs from 8.
    // The bind that ends a run of bind-stage failures is a change, so it is logged; its
    // recovery is logged once it has stayed up.
    expect(logs).toEqual([
      "peering: binding at boot for 1 paired peer",
      "peering: could not bind the endpoint: load: dlopen failed; retrying in 5 s",
      "peering: could not bind the endpoint: load: dlopen failed; retrying in 10 s",
      "peering: could not bind the endpoint: load: dlopen failed; retrying in 20 s",
      "peering: could not bind the endpoint: load: dlopen failed; retrying in 40 s",
      `peering: could not bind the endpoint: load: dlopen failed; ${AT_CAP}`,
      `peering: could not bind the endpoint: bind: address in use; ${AT_CAP}`,
      `peering: could not bind the endpoint: load: dlopen failed; ${AT_CAP}`,
      `peering: endpoint bound as ${selfId.slice(0, 10)}`,
      recovered(9),
    ]);
    await service.shutdown();
  });

  test("after a recovery, and after giving up, a failure matching the old quiet one is logged again at the cap", async () => {
    const same = new Error("load: dlopen failed");
    const atCap = `peering: could not bind the endpoint: load: dlopen failed; ${AT_CAP}`;
    const capLines = (logs: string[]) => logs.filter((line) => line === atCap).length;
    /** Let the pending retry fire, and wait for its bind to be called. */
    const fire = async (service: PeerService, binds: string[][], clock: FakeClock) => {
      const before = binds.length;
      await waitFor(() => retryAt(service) !== null, { message: `retry after bind ${before}` });
      clock.advance(retryAt(service)! - clock.now());
      await waitFor(() => binds.length === before + 1, { message: `bind ${before + 1}` });
    };

    // Recovery: five failures reach the cap (quiet), a rebind stays up 60 s, then five more.
    {
      await addPeer({ id: ID_REMOTE, name: "Laptop C" });
      const ep = new FakeEndpoint();
      ep.connectImpl = () => new Promise(() => {});
      const { service, binds, logs, clock } = makeService({}, [same, same, same, same, same, ep, same, same, same, same]);
      await service.bootIfPaired();
      for (let i = 0; i < 5; i++) await fire(service, binds, clock); // binds 2-5 fail, bind 6 is ep
      await waitFor(() => service.view().status.kind === "listening" && ep.accepting, { message: "bound" });
      expect(capLines(logs)).toBe(1);
      clock.advance(60_000);
      expect(logs).toContain(recovered(5));
      ep.failAccept(new Error(SOCKET_GONE)); // failure 1 of the new run
      for (let i = 0; i < 4; i++) await fire(service, binds, clock); // binds 7-10: failures 2-5
      await waitFor(() => retryAt(service) !== null, { message: "retry after bind 10" });
      expect(retryAt(service)! - clock.now()).toBe(60_000);
      expect(capLines(logs)).toBe(2);
      await service.shutdown();
    }

    // Give-up: five failures reach the cap with the dialog open; it closes, the retry gives up; five more.
    {
      await writeFile(peersFile(), "[]\n");
      const { service, binds, logs, clock } = makeService({}, Array.from({ length: 10 }, () => same));
      service.openDialog();
      for (let i = 0; i < 4; i++) await fire(service, binds, clock); // binds 2-5
      await waitFor(() => retryAt(service) !== null, { message: "retry after bind 5" });
      expect(capLines(logs)).toBe(1);
      service.closeDialog();
      clock.advance(retryAt(service)! - clock.now());
      await waitFor(() => logs.includes(NOT_NEEDED), { message: "gave up" });
      service.openDialog(); // bind 6: failure 1 of the new run
      await waitFor(() => binds.length === 6, { message: "bind 6" });
      for (let i = 0; i < 4; i++) await fire(service, binds, clock); // binds 7-10
      await waitFor(() => retryAt(service) !== null, { message: "retry after bind 10" });
      expect(retryAt(service)! - clock.now()).toBe(60_000);
      expect(capLines(logs)).toBe(2);
      await service.shutdown();
    }
  });

  test("an endpoint whose accept loop dies as soon as it binds backs off 5, 10, 20, 40, 60 s, goes quiet at the cap, and logs only the recovery of the bind that stays up", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const endpoints = Array.from({ length: 8 }, (_, i) => {
      const ep = new FakeEndpoint();
      // Every bind succeeds; the first 7 accept loops die at once, the 8th stays up.
      if (i < 7) ep.acceptFailure = new Error(SOCKET_GONE);
      ep.connectImpl = () => new Promise(() => {});
      return ep;
    });
    const { service, binds, logs, clock } = makeService({}, endpoints);
    await service.bootIfPaired();
    const waits: number[] = [];
    for (let failure = 1; failure <= 7; failure++) {
      await waitFor(() => retryAt(service) !== null, { message: `retry ${failure} armed` });
      expect(endpoints[failure - 1]!.closeCalls).toBe(1);
      const wait = retryAt(service)! - clock.now();
      waits.push(wait / 1000);
      if (failure === 7) break;
      clock.advance(wait);
      await waitFor(() => binds.length === failure + 1, { message: `bind ${failure + 1}` });
    }
    // No flapping at 5 s: a rebind that does not stay up continues the run.
    expect(waits).toEqual([5, 10, 20, 40, 60, 60, 60]);
    const selfId = service.view().selfId!;
    const stopped = `peering: accept loop stopped: ${SOCKET_GONE}`;
    const cycle = (tail: string) => [`peering: endpoint bound as ${selfId.slice(0, 10)}`, `${stopped}; closing the endpoint`, "peering: endpoint closed", `${stopped}; ${tail}`];
    // At the cap the failure is logged once; the 6th and 7th cycles repeat it and log nothing at all.
    expect(logs).toEqual([
      "peering: binding at boot for 1 paired peer",
      ...cycle("retrying in 5 s"),
      ...cycle("retrying in 10 s"),
      ...cycle("retrying in 20 s"),
      ...cycle("retrying in 40 s"),
      ...cycle(AT_CAP),
    ]);

    // The 8th bind comes up and stays up: still part of the quiet run, so it is not logged...
    const quietLogs = [...logs];
    clock.advance(retryAt(service)! - clock.now());
    await waitFor(() => service.view().status.kind === "listening" && endpoints[7]!.accepting, { message: "bind 8 stays up" });
    expect(binds.length).toBe(8);
    expect(logs).toEqual(quietLogs);
    elapse(clock, 59_999);
    expect(logs).toEqual(quietLogs);
    // ...and 60 s later its recovery is, counting all 7 failures.
    clock.advance(1);
    expect(logs).toEqual([...quietLogs, recovered(7)]);
    await service.shutdown();
    expect(clock.pending()).toBe(0);
  });

  test("the backoff resets only once a rebind has stayed up for 60 s", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const [ep1, ep2, ep3, ep4] = [new FakeEndpoint(), new FakeEndpoint(), new FakeEndpoint(), new FakeEndpoint()];
    for (const ep of [ep1, ep2, ep3, ep4]) ep.connectImpl = () => new Promise(() => {});
    ep1.acceptFailure = new Error(SOCKET_GONE);
    const { service, logs, clock } = makeService({}, [ep1, ep2, ep3, ep4]);
    await service.bootIfPaired();
    await waitFor(() => retryAt(service) !== null, { message: "retry 1 armed" });
    expect(retryAt(service)! - clock.now()).toBe(5_000);

    // ep2 stays up for 59.999 s, then fails: still the same run, so the wait doubles.
    clock.advance(5_000);
    await waitFor(() => service.view().status.kind === "listening" && ep2.accepting, { message: "ep2 bound" });
    clock.advance(59_999);
    expect(logs.some((line) => line.startsWith("peering: recovered"))).toBe(false);
    ep2.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => retryAt(service) !== null, { message: "retry 2 armed" });
    expect(retryAt(service)! - clock.now()).toBe(10_000);

    // ep3 stays up for 60 s: recovered, and its later failure waits 5 s again.
    clock.advance(10_000);
    await waitFor(() => service.view().status.kind === "listening" && ep3.accepting, { message: "ep3 bound" });
    clock.advance(59_999);
    expect(logs.some((line) => line.startsWith("peering: recovered"))).toBe(false);
    clock.advance(1);
    expect(logs).toContain(recovered(2));
    ep3.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => retryAt(service) !== null, { message: "retry 3 armed" });
    expect(retryAt(service)! - clock.now()).toBe(5_000);
    await service.shutdown();
    expect(clock.pending()).toBe(0);
  });

  test("a failed identity load and a lock error (not another owner holding it) retry like a failed bind", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    {
      let loads = 0;
      const { service, binds, logs, clock } = makeService({
        loadIdentity: async () => {
          if (++loads === 1) throw new Error("secret.key is not 64 lowercase hex characters");
          return loadOrCreateIdentity();
        },
      });
      await service.bootIfPaired();
      expect(service.view().status).toEqual({
        kind: "error",
        message: "secret.key is not 64 lowercase hex characters",
        retryAt: clock.now() + 5_000,
      });
      expect(service.view().identityError).toBe("secret.key is not 64 lowercase hex characters");
      expect(binds).toEqual([]);
      expect(await lockContents()).toBeNull();
      expect(logs).toContain("peering: could not load this install's identity: secret.key is not 64 lowercase hex characters; retrying in 5 s");
      clock.advance(5_000);
      await waitFor(() => service.view().status.kind === "listening", { message: "bound after the identity retry" });
      expect(service.view().identityError).toBeNull();
      expect(binds.length).toBe(1);
      clock.advance(60_000);
      expect(logs).toContain(recovered(1));
      await service.shutdown();
    }
    {
      let acquires = 0;
      const { service, binds, logs, clock } = makeService({
        acquireLock: async () => {
          if (++acquires === 1) throw new Error("EACCES: permission denied");
          return acquireEndpointLock();
        },
      });
      await service.bootIfPaired();
      expect(service.view().status).toEqual({
        kind: "error",
        message: "could not take the endpoint lock: EACCES: permission denied",
        retryAt: clock.now() + 5_000,
      });
      expect(binds).toEqual([]);
      expect(logs).toContain("peering: could not take the endpoint lock: EACCES: permission denied; retrying in 5 s");
      clock.advance(5_000);
      await waitFor(() => service.view().status.kind === "listening", { message: "bound after the lock retry" });
      expect(acquires).toBe(2);
      expect(binds.length).toBe(1);
      expect(await lockContents()).toBe(OWN_LOCK);
      await service.shutdown();
    }
  });

  test("after giving up, the next run of failures starts at 5 s again", async () => {
    const { service, binds, logs, clock } = makeService({}, [new Error("e1"), new Error("e2"), new Error("e3"), new FakeEndpoint()]);
    service.openDialog();
    await waitFor(() => retryAt(service) !== null, { message: "retry 1 armed" });
    expect(retryAt(service)! - clock.now()).toBe(5_000);
    clock.advance(5_000);
    await waitFor(() => binds.length === 2 && retryAt(service) !== null, { message: "retry 2 armed" });
    expect(retryAt(service)! - clock.now()).toBe(10_000);
    // No peers: once the dialog closes, the pending retry gives up.
    service.closeDialog();
    clock.advance(10_000);
    await waitFor(() => logs.includes(NOT_NEEDED), { message: "gave up" });
    expect(clock.pending()).toBe(0);
    service.openDialog();
    await waitFor(() => binds.length === 3 && retryAt(service) !== null, { message: "retry after the next failure" });
    expect(retryAt(service)! - clock.now()).toBe(5_000);
    expect(logs).toContain("peering: could not bind the endpoint: e3; retrying in 5 s");

    // Give up again; the next bind succeeds. A bind right after a give-up is clean: no stability check.
    service.closeDialog();
    clock.advance(5_000);
    await waitFor(() => logs.filter((line) => line === NOT_NEEDED).length === 2, { message: "gave up again" });
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "bound" });
    expect(binds.length).toBe(4);
    expect(clock.pending()).toBe(2); // the poller's timer and the late-timer
    clock.advance(60_000);
    expect(logs.some((line) => line.startsWith("peering: recovered"))).toBe(false);
    await service.shutdown();
  });

  test("a bind that settles after its accept loop has already failed does not clear the close's hold: nothing binds next to the closing endpoint", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const first = new FakeEndpoint();
    const second = new FakeEndpoint();
    for (const ep of [first, second]) ep.connectImpl = () => new Promise(() => {});
    // The loop fails on its first acceptNext, before the bind that started it has settled.
    first.acceptFailure = new Error(SOCKET_GONE);
    const closing = gate<void>();
    first.closeGate = closing.promise;
    const { service, binds, calls } = makeService({}, [first, second]);
    await service.bootIfPaired(); // returns once that bind has settled
    await waitFor(() => first.closeCalls === 1, { message: "close started" });
    expect(service.view().status).toEqual({ kind: "error", message: `accept loop stopped: ${SOCKET_GONE}`, retryAt: null });

    // The close still runs: an open must not start a bind next to the old endpoint.
    const loads = calls.loadIdentity;
    service.openDialog();
    await flushMicrotasks();
    expect(calls.loadIdentity).toBe(loads);
    expect(service.view().status.kind).toBe("error");
    expect(binds.length).toBe(1);
    expect(await lockContents()).toBe(OWN_LOCK);

    closing.resolve();
    await waitFor(() => retryAt(service) !== null, { message: "retry armed after the close" });
    expect(await lockContents()).toBeNull();
    service.closeDialog();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && second.accepting, { message: "rebound" });
    expect(binds.length).toBe(2);
    expect(first.closeCalls).toBe(1);
    await service.shutdown();
  });

  test("with no peers and the dialog closed, an accept-loop failure does not rebind", async () => {
    const first = new FakeEndpoint();
    const { service, logs, clock, calls } = makeService({}, [first, new FakeEndpoint()]);
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && first.accepting, { message: "accepting" });
    service.closeDialog(); // the endpoint stays bound, but nothing needs it any more

    first.failAccept(new Error(SOCKET_GONE));
    const gaveUp = `peering: accept loop stopped: ${SOCKET_GONE}; not retrying: no paired peers and the Peers tab is hidden`;
    await waitFor(() => logs.includes(gaveUp), { message: "not retrying" });
    expect(service.view().status).toEqual({ kind: "error", message: `accept loop stopped: ${SOCKET_GONE}`, retryAt: null });
    expect(await lockContents()).toBeNull();
    expect(clock.pending()).toBe(0); // nothing armed: no retry, and the poller stopped
    const before = { ...calls };
    clock.advance(600_000);
    await flushMicrotasks();
    expect(calls).toEqual(before);
    expect(retryLines(logs)).toEqual([gaveUp]);
    await service.shutdown();
  });

  test("a pending retry binds nothing once nothing needs the endpoint: the dialog closed, or the last peer removed", async () => {
    // Armed while the dialog was open; the dialog closes before it fires.
    {
      const { service, binds, logs, clock, calls } = makeService({}, [new Error("load: dlopen failed"), new FakeEndpoint()]);
      service.openDialog();
      await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
      service.closeDialog();
      clock.advance(5_000);
      await waitFor(() => logs.includes(NOT_NEEDED), { message: "not retrying" });
      expect(binds.length).toBe(1);
      expect(calls.loadIdentity).toBe(1);
      expect(service.view().status).toEqual({ kind: "error", message: "load: dlopen failed", retryAt: null });
      expect(clock.pending()).toBe(0);
      await service.shutdown();
    }
    // Armed for a paired install; peers.json is emptied (ib peer remove) before it fires.
    {
      await addPeer({ id: ID_REMOTE, name: "Laptop C" });
      const { service, binds, logs, clock, calls } = makeService({}, [new Error("load: dlopen failed"), new FakeEndpoint()]);
      await service.bootIfPaired();
      expect(retryAt(service)).toBe(clock.now() + 5_000);
      await writeFile(peersFile(), "[]\n");
      clock.advance(5_000);
      await waitFor(() => logs.includes(NOT_NEEDED), { message: "not retrying" });
      expect(binds.length).toBe(1);
      expect(calls.loadIdentity).toBe(1);
      expect(service.view().peers).toEqual([]);
      expect(clock.pending()).toBe(0); // nothing left to fire
      await service.shutdown();
    }
  });

  test("another live ib watch taking the lock stops the retries: disabled, and the lock is not polled", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    let acquires = 0;
    const { service, binds, logs, clock, calls } = makeService(
      {
        acquireLock: () => {
          acquires++;
          return acquireEndpointLock();
        },
      },
      [new Error("load: dlopen failed"), new FakeEndpoint()],
    );
    await service.bootIfPaired();
    expect(retryAt(service)).toBe(clock.now() + 5_000);

    // Another ib watch takes the endpoint while the retry waits.
    alive.add(OTHER.pid);
    starts.set(OTHER.pid, OTHER.startEpoch);
    await writeFile(peerEndpointLockFile(), `${OTHER.pid} ${OTHER.startEpoch}\n`);
    clock.advance(5_000);
    await waitFor(() => service.view().status.kind === "disabled", { message: "disabled" });
    expect(service.view().status).toEqual({ kind: "disabled", ownerPid: OTHER.pid });
    expect(acquires).toBe(2);
    expect(logs).toContain(`peering disabled: ib watch pid ${OTHER.pid} owns the endpoint`);
    expect(logs).toContain("peering: not retrying the bind: another ib watch owns the endpoint");

    expect(clock.pending()).toBe(0); // nothing left to fire, so the lock is never tried again
    clock.advance(600_000);
    await flushMicrotasks();
    expect(acquires).toBe(2);
    expect(calls.loadIdentity).toBe(2);
    expect(binds.length).toBe(1);
    expect(await lockContents()).toBe(`${OTHER.pid} ${OTHER.startEpoch}\n`);
    await service.shutdown();
  });

  test("shutdown cancels a pending retry, and a retry that fires during shutdown binds nothing", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const clock = createFakeClock();
    const { timers, setTimer } = recordTimers(clock);
    const { service, binds, logs, calls } = makeService({ now: clock.now, setTimer }, [new Error("load: dlopen failed"), new FakeEndpoint()]);
    await service.bootIfPaired();
    expect(retryAt(service)).toBe(clock.now() + 5_000);
    const retry = timers.find((t) => t.ms === 5_000 && t.armed)!;

    const stopping = service.shutdown();
    expect(retry.armed).toBe(false);
    expect(clock.pending()).toBe(0);
    expect(retryAt(service)).toBeNull();
    const before = { ...calls };
    // A timer whose callback was already on its way when the cancel ran: it starts nothing.
    retry.fn();
    await stopping;
    retry.fn();
    await flushMicrotasks();
    expect(calls).toEqual(before);
    expect(binds.length).toBe(1);
    expect(await lockContents()).toBeNull();
    expect(service.view().status).toEqual({ kind: "error", message: "load: dlopen failed", retryAt: null });
    expect(retryLines(logs)).toEqual(["peering: could not bind the endpoint: load: dlopen failed; retrying in 5 s"]);
  });

  test("a retry in flight when shutdown begins leaves no endpoint, starts no poller, and releases the lock", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    // The retry's bind is held inside bindEndpoint, after taking the lock, when shutdown starts.
    {
      const late = new FakeEndpoint();
      const held = gate<FakeEndpoint>();
      let bindCalls = 0;
      const { service, logs, clock } = makeService({
        bindEndpoint: async () => {
          if (++bindCalls === 1) throw new Error("load: dlopen failed");
          return held.promise;
        },
      });
      await service.bootIfPaired();
      clock.advance(5_000);
      await waitFor(() => bindCalls === 2, { message: "the retry's bind is in flight" });
      expect(await lockContents()).toBe(OWN_LOCK);
      const stopping = service.shutdown();
      held.resolve(late);
      await stopping;
      expect(late.closeCalls).toBe(1);
      expect(late.connects).toEqual([]); // the poller never dialed
      expect(service.view().links).toEqual([]);
      expect(clock.pending()).toBe(0); // no poller timer, no retry
      expect(await lockContents()).toBeNull();
      expect(logs.some((line) => line.startsWith("peering: endpoint bound"))).toBe(false);
    }
    // The retry is still re-reading peers.json when shutdown starts: it binds nothing.
    {
      const peersRead = gate<Peer[]>();
      let holdReads = false;
      const { service, binds, calls, clock } = makeService(
        { readPeers: () => (holdReads ? peersRead.promise : readPeers()) },
        [new Error("load: dlopen failed"), new FakeEndpoint()],
      );
      await service.bootIfPaired();
      holdReads = true;
      clock.advance(5_000);
      const stopping = service.shutdown();
      peersRead.resolve(await readPeers());
      await stopping;
      expect(binds.length).toBe(1);
      expect(calls.loadIdentity).toBe(1);
      expect(clock.pending()).toBe(0);
      expect(await lockContents()).toBeNull();
    }
  });

  test("with the dialog open, no timer is left behind once the retry fires, or after shutdown", async () => {
    // A retry and its countdown pending: shutdown cancels both.
    {
      const { service, clock } = makeService({}, [new Error("load: dlopen failed"), new FakeEndpoint()]);
      service.openDialog();
      await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
      expect(clock.pending()).toBe(2); // the retry, and the countdown tick
      await service.shutdown();
      expect(clock.pending()).toBe(0);
    }
    // The retry fires (its bind held in flight), then shutdown.
    {
      const held = gate<FakeEndpoint>();
      const late = new FakeEndpoint();
      let bindCalls = 0;
      const { service, clock } = makeService({
        bindEndpoint: async () => {
          if (++bindCalls === 1) throw new Error("load: dlopen failed");
          return held.promise;
        },
      });
      service.openDialog();
      await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
      clock.advance(5_000);
      expect(clock.pending()).toBe(0); // the retry fired; its countdown is cancelled
      expect(retryAt(service)).toBeNull();
      await waitFor(() => bindCalls === 2, { message: "the retry's bind is in flight" });
      expect(clock.pending()).toBe(0);
      const stopping = service.shutdown();
      held.resolve(late);
      await stopping;
      expect(clock.pending()).toBe(0);
      expect(late.closeCalls).toBe(1);
    }
  });

  test("opening the dialog during a pending retry binds at once, once, and cancels the timer", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const endpoint = new FakeEndpoint();
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's dial stays pending
    const clock = createFakeClock();
    const { timers, setTimer } = recordTimers(clock);
    const { service, binds, logs } = makeService({ now: clock.now, setTimer }, [new Error("load: dlopen failed"), endpoint]);
    await service.bootIfPaired();
    expect(retryAt(service)).not.toBeNull();
    const retry = timers.find((t) => t.ms === 5_000 && t.armed)!;

    service.openDialog();
    expect(retry.armed).toBe(false);
    expect(service.view().status).toEqual({ kind: "starting" });
    service.closeDialog();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && endpoint.accepting, { message: "bound" });
    expect(binds.length).toBe(2);
    expect(retryLines(logs)).toEqual(["peering: could not bind the endpoint: load: dlopen failed; retrying in 5 s"]);
    // Left: the late-timer, the poller's timer, and the 60 s check that the rebind stays up. No retry.
    expect(timers.filter((t) => t.armed).map((t) => t.ms).sort((a, b) => a - b)).toEqual([LATE_TIMER_INTERVAL_MS, 5_000, 60_000]);
    expect(timers.filter((t) => t.armed)).not.toContain(retry);
    clock.advance(60_000);
    expect(logs).toContain(recovered(1));
    await service.shutdown();
  });

  test("each failure leaves one endpoint and one lock owner: a rebind waits for the close, and the lock is never taken twice", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const ep1 = new FakeEndpoint();
    const ep3 = new FakeEndpoint();
    const ep4 = new FakeEndpoint();
    const script: Array<FakeEndpoint | Error> = [ep1, new Error("bind: address in use"), ep3, ep4];
    for (const ep of [ep1, ep3, ep4]) ep.connectImpl = () => new Promise(() => {});
    const returned: FakeEndpoint[] = [];
    const closed = new Set<FakeEndpoint>();
    const violations: string[] = [];
    let binds = 0;
    let lockHolders = 0;
    const { service, clock, calls } = makeService({
      acquireLock: async () => {
        if (lockHolders > 0) violations.push(`lock taken while held, before bind ${binds + 1}`);
        const result = await acquireEndpointLock();
        if (result.acquired) lockHolders++;
        return result;
      },
      releaseLock: async () => {
        lockHolders--;
        return releaseEndpointLock();
      },
      bindEndpoint: async () => {
        binds++;
        if (returned.some((ep) => !closed.has(ep))) violations.push(`bind ${binds} while an endpoint is still open`);
        const next = script[binds - 1]!;
        if (next instanceof Error) throw next;
        const close = next.close.bind(next);
        next.close = async () => {
          await close();
          closed.add(next);
        };
        returned.push(next);
        return next;
      },
    });

    await service.bootIfPaired();
    expect(service.view().status).toEqual({ kind: "listening" });
    expect(clock.pending()).toBe(2); // the poller's timer and the late-timer: a clean boot bind arms no stability check

    // The accept loop fails; its close hangs. Nothing binds until it is done.
    let finishClose!: () => void;
    ep1.closeGate = new Promise((resolve) => (finishClose = resolve));
    await waitFor(() => ep1.accepting, { message: "ep1 accepting" });
    ep1.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => ep1.closeCalls === 1, { message: "close started" });
    for (let i = 0; i < 3; i++) {
      service.openDialog();
      service.closeDialog();
    }
    expect(clock.pending()).toBe(0); // the poller stopped; the retry is armed only after the close
    clock.advance(600_000);
    await flushMicrotasks();
    expect(calls.loadIdentity).toBe(1);
    expect(binds).toBe(1);
    expect(retryAt(service)).toBeNull();
    finishClose();

    // Retry: bind 2 fails, the dialog opens during its retry (bind 3), then ep3 fails and the retry binds ep4.
    await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
    clock.advance(5_000);
    await waitFor(() => binds === 2 && retryAt(service) !== null, { message: "bind 2 failed, retry armed" });
    expect(retryAt(service)! - clock.now()).toBe(10_000);
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && ep3.accepting, { message: "ep3 bound" });
    ep3.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => retryAt(service) !== null, { message: "retry armed after ep3" });
    // ep3 failed before staying up 60 s: the third failure of the run.
    expect(retryAt(service)! - clock.now()).toBe(20_000);
    clock.advance(20_000);
    await waitFor(() => service.view().status.kind === "listening" && ep4.accepting, { message: "ep4 bound" });

    await service.shutdown();
    expect(binds).toBe(4);
    expect(violations).toEqual([]);
    expect(lockHolders).toBe(0);
    expect([ep1.closeCalls, ep3.closeCalls, ep4.closeCalls]).toEqual([1, 1, 1]);
    expect(await lockContents()).toBeNull();
  });

  test("while the dialog is open, a pending retry notifies every second so its countdown moves; closing the dialog stops that", async () => {
    const { service, clock } = makeService({}, [new Error("load: dlopen failed"), new FakeEndpoint()]);
    service.openDialog();
    await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
    let changes = 0;
    service.onChange(() => changes++);
    // advance() fires its timers synchronously, so nothing else can notify in between.
    const tick = () => {
      const before = changes;
      clock.advance(1_000);
      return changes - before;
    };
    expect(tick()).toBe(1);
    expect(tick()).toBe(1);
    service.closeDialog();
    expect(clock.pending()).toBe(1); // only the retry is left
    expect(tick()).toBe(0);
    await service.shutdown();
  });
});

describe("describePaths", () => {
  const relay = { selected: false, relay: true, remoteAddr: "https://relay.example./", rttMs: 140 };
  const ip = (remoteAddr: string, rttMs = 30) => ({ selected: false, relay: false, remoteAddr, rttMs });

  test("names the selected path, direct or relayed, with its RTT", () => {
    expect(describePaths([{ ...relay, selected: true }, ip("198.51.100.4:61000")]).text).toBe("relayed via https://relay.example./, rtt 140 ms");
    expect(describePaths([relay, { ...ip("198.51.100.4:61000", 31), selected: true }]).text).toBe("direct to 198.51.100.4:61000, rtt 31 ms");
  });

  test("with none selected (an accepting side can stay so): direct if any direct path is open, else relayed", () => {
    expect(describePaths([relay, ip("198.51.100.4:61000")]).text).toBe("direct to 198.51.100.4:61000, rtt 30 ms (none selected, 2 open)");
    expect(describePaths([relay]).text).toBe("relayed via https://relay.example./, rtt 140 ms (none selected, 1 open)");
    expect(describePaths([])).toEqual({ key: "none", text: "no open path" });
  });

  test("the key changes only with the answer: hole-punch candidates coming and going leave it alone", () => {
    const key = (paths: Parameters<typeof describePaths>[0]) => describePaths(paths).key;
    expect(key([ip("[2001:db8::1]:5000")])).toBe(key([ip("127.0.0.1:5000", 2), relay]));
    expect(key([relay])).not.toBe(key([relay, ip("127.0.0.1:5000")]));
    const selected = { ...ip("127.0.0.1:5000"), selected: true };
    expect(key([selected])).toBe(key([{ ...selected, rttMs: 99 }, ip("[2001:db8::1]:5000")]));
    expect(key([selected])).not.toBe(key([{ ...ip("127.0.0.1:6000"), selected: true }]));
  });
});

describe("peerRetryDelayMs", () => {
  test("5, 10, 20, 40, then 60 s however many failures", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100, 10_000].map(peerRetryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe("PeerService late-timer (SPEC §20.4)", () => {
  const lateLines = (logs: string[]) => logs.filter((line) => line.startsWith("peering: 1 s timer"));

  test("while bound, a 1 s tick that runs 5 s or more after it was due is one line with the measured delay", async () => {
    const { service, logs, clock } = makeService();
    clock.advance(60_000); // nothing bound yet: no timer runs
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    elapse(clock, 30_000); // every tick on time
    clock.advance(10_800); // the tick due 1 s after the last one runs 9.8 s late
    clock.advance(5_999); // 4.999 s late: under the threshold
    clock.advance(6_000); // exactly 5 s late
    expect(lateLines(logs)).toEqual(["peering: 1 s timer ran 9.8 s late", "peering: 1 s timer ran 5.0 s late"]);
    await service.shutdown();
    clock.advance(60_000);
    expect(lateLines(logs)).toHaveLength(2);
  });

  test("it stops when the endpoint closes and on shutdown, and starts again with the rebind", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const [first, second] = [new FakeEndpoint(), new FakeEndpoint()];
    for (const ep of [first, second]) ep.connectImpl = () => new Promise(() => {}); // the poller's dials stay pending
    const clock = createFakeClock();
    const { timers, setTimer } = recordTimers(clock);
    const { service, logs } = makeService({ now: clock.now, setTimer }, [first, second]);
    const lateTimers = () => timers.filter((t) => t.armed && t.ms === LATE_TIMER_INTERVAL_MS).length;
    expect(lateTimers()).toBe(0);
    await service.bootIfPaired();
    await waitFor(() => service.view().status.kind === "listening" && first.accepting, { message: "bound" });
    expect(lateTimers()).toBe(1);

    first.failAccept(new Error("Endpoint.acceptNext: socket gone"));
    await waitFor(() => retryAt(service) !== null, { message: "closed, retry armed" });
    expect(lateTimers()).toBe(0);
    clock.advance(retryAt(service)! - clock.now());
    await waitFor(() => service.view().status.kind === "listening" && second.accepting, { message: "rebound" });
    expect(lateTimers()).toBe(1);

    await service.shutdown();
    expect(lateTimers()).toBe(0);
    expect(lateLines(logs)).toEqual([]);
  });
});

test("defaultPeerServiceDeps answers permissions requests with the local b's own functions", () => {
  const deps = defaultPeerServiceDeps("local", () => {}, () => ({ coordinator: null, repos: [], agents: [], questions: [] }), () => {}, null, join(home, "staging"));
  expect(deps.remotePermissions).toMatchObject({ effectiveSpawnCapability, grantAgentPermission, setAgentSpawnCapability });
});

test("defaultPeerServiceDeps gives message sends and remote starts one attachment receiver", async () => {
  const deps = defaultPeerServiceDeps("local", () => {}, () => ({ coordinator: null, repos: [], agents: [], questions: [] }), () => {}, null, join(home, "staging"));
  const file = { name: "a.txt", size: 1, sha256: "0".repeat(64), spellings: ["./a.txt"] };
  const release = Promise.withResolvers<void>();
  // A remote start from "peer" holds its transfer slot.
  const holding = deps.remoteSpawn!.attachments!("peer", [file], { peerName: "Laptop C", log() {}, notice() {} }, () => release.promise);
  try {
    const send = { op: "send", id: crypto.randomUUID(), from: { kind: "user" }, target: { kind: "agent", agent: "nobody" }, message: "x", files: [file] } as const;
    await expect(deps.receiveMessage!({ ...send, files: [file] }, "peer", async () => "Laptop C")).rejects.toThrow("busy, try again");
  } finally {
    release.resolve();
    await holding;
  }
});

describe("PeerService keeps the link while a transfer moves bytes", () => {
  const kept = `peer link: Laptop C (${ID_REMOTE.slice(0, 10)}): agents poll timed out within 60 s of a transfer with this peer moving bytes; keeping the connection`;

  /**
   * A service whose poller dials ID_REMOTE over a memory link whose far end the
   * test drives: it answers the first agents poll, so the link is connected.
   */
  async function connectedService(overrides: Partial<PeerServiceDeps> = {}, wrap: (conn: MemoryConnection) => void = () => {}) {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const rig = makeService(overrides);
    let far: MemoryConnection | undefined;
    rig.endpoint.connectImpl = async id => {
      const link = createMemoryLink("00".repeat(32), id);
      wrap(link.a);
      far = link.b;
      return serviceConnection(link.a, PEER_ALPN);
    };
    await rig.service.bootIfPaired();
    await waitFor(() => far !== undefined, { message: "dialed" });
    const first = await far!.acceptBi();
    await first.readToEnd(4096);
    await first.writeAll(encodeAgentsReply({ coordinator: null, repos: [], agents: [], questions: [] }));
    await first.finish();
    await waitFor(() => rig.service.view().links[0]?.connected === true, { message: "connected" });
    /** The next tick's agents poll, read and left unanswered, then its 30 s deadline and 750 ms grace. */
    const stallPoll = async () => {
      rig.clock.advance(PEER_POLL_INTERVAL_MS);
      const poll = await far!.acceptBi();
      expect(JSON.parse(new TextDecoder().decode(await poll.readToEnd(4096))).op).toBe("agents");
      await Bun.sleep(0);
      rig.clock.advance(PEER_REQUEST_TIMEOUT_MS);
      await Bun.sleep(0);
      rig.clock.advance(750);
      await Bun.sleep(0);
    };
    return { ...rig, far: far!, stallPoll };
  }

  test("inbound: a receipt blocked mid-body keeps a stalled poll's connection; once it ends, the kept poll closes at its next check", async () => {
    const newAgent = mock<RemoteSpawnDeps["newAgent"]>(async () => ({ ok: true, exitCode: 0, stdout: "agent-1", stderr: "" }));
    const { service, endpoint, logs, clock, far, stallPoll } = await connectedService({ remoteSpawn: {
      listSpawnableTypes: listSpawnableTypeNamesSync, listRepos: async () => [{ name: "app", path: "/local/app" }], newAgent, notice() {},
      attachments: createAttachmentReceiver({ tempDir: home, stagingRoot: join(home, "staging"), hasFreeSpace: async () => true }),
    } });
    await writeFile(join(home, ".itsybitsy", "machine-name"), "laptop");
    // The other side's own connection carries a start whose body arrives 1 byte of 3, then stops.
    const inbound = incomingFrom(endpoint, service.view().selfId!, PEER_ALPN);
    try {
      const stream = await inbound.openBi();
      await stream.writeAll(encodeFrameHeader({ op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt",
        files: [{ name: "a.txt", size: 3, sha256: new Bun.CryptoHasher("sha256").update("abc").digest("hex"), spellings: ["./a.txt"] }] }));
      await stream.writeAll(Buffer.from("a"));
      await waitFor(() => service.view().incoming?.[0]?.bytes === 1, { message: "receiving" });

      await stallPoll();
      await waitFor(() => logs.includes(kept), { message: "kept" });
      expect(far.closeInfo()).toBeNull();
      expect(service.view().links[0]).toMatchObject({ connected: true, lastError: null });

      // The receipt completes: no transfer with the peer moves bytes any more.
      await stream.writeAll(Buffer.from("bc"));
      await stream.finish();
      expect(JSON.parse(new TextDecoder().decode(await stream.readToEnd(4096)))).toEqual({ ok: true, id: "agent-1" });
      clock.advance(PEER_REQUEST_TIMEOUT_MS); // the kept poll's next check
      await waitFor(() => service.view().links[0]?.connected === false, { message: "closed" });
      expect(far.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.error });
      expect(service.view().links[0]?.lastError).toBe("no reply to the agents poll within 30 s");
    } finally {
      inbound.close(PEER_CLOSE.done, "done");
      await service.shutdown();
    }
  });

  test("outbound: a send whose body write is blocked keeps a stalled poll's connection; once it ends, the kept poll closes at its next check", async () => {
    const { textHeader } = await import("./peer-outbox");
    // The far end reads slowly: after the header, this side's body writes wait.
    const reading = Promise.withResolvers<void>();
    const { service, logs, clock, far, stallPoll } = await connectedService({}, conn => {
      const open = conn.openBi.bind(conn);
      conn.openBi = async () => {
        const stream = await open();
        const setPriority = stream.setPriority.bind(stream), write = stream.write.bind(stream);
        let body = false, writes = 0;
        stream.setPriority = priority => { body = true; return setPriority(priority); };
        stream.write = async bytes => {
          if (body && writes++ > 0) await reading.promise;
          return write(bytes);
        };
        return stream;
      };
    });
    const filesDir = join(home, "outgoing");
    await mkdir(filesDir);
    await writeFile(join(filesDir, "0"), "abc");
    const header = { ...textHeader({ kind: "agent", agent: "helper" }, "read ./a.txt", { kind: "user" }),
      files: [{ name: "a.txt", size: 3, sha256: new Bun.CryptoHasher("sha256").update("abc").digest("hex"), spellings: ["./a.txt"] }] };
    try {
      const sending = service.sendRemoteMessage(ID_REMOTE, header, "handoff", { filesDir });
      const send = await far.acceptBi();
      await waitFor(() => logs.some(line => line.startsWith("peer link: transfer started: send to Laptop C")), { message: "sending" });

      await stallPoll();
      await waitFor(() => logs.includes(kept), { message: "kept" });
      expect(far.closeInfo()).toBeNull();
      expect(service.view().links[0]).toMatchObject({ connected: true, lastError: null });

      // The far end takes the body and acknowledges: the send ends.
      reading.resolve();
      await send.readToEnd(4096);
      await send.writeAll(new TextEncoder().encode(JSON.stringify({ ok: true, id: header.id })));
      await send.finish();
      expect(await sending).toBe(header.id);
      clock.advance(PEER_REQUEST_TIMEOUT_MS); // the kept poll's next check
      await waitFor(() => service.view().links[0]?.connected === false, { message: "closed" });
      expect(far.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.error });
      expect(service.view().links[0]?.lastError).toBe("no reply to the agents poll within 30 s");
    } finally {
      reading.resolve();
      await service.shutdown();
    }
  });

  test("a watch log copy whose body arrives slowly keeps a stalled poll's connection, with transfer lines from its header to its end", async () => {
    const { service, logs, clock, far, stallPoll } = await connectedService();
    const short = ID_REMOTE.slice(0, 10);
    const body = Buffer.from("remote line\n");
    try {
      const copying = service.fetchWatchLog(ID_REMOTE);
      const copy = await far.acceptBi();
      expect(JSON.parse(new TextDecoder().decode(await copy.readToEnd(4096)))).toEqual({ op: "watch-log" });
      await copy.writeAll(encodeFrameHeader({ op: "watch-log", now: clock.now(), version: "9.9.9", name: "laptop-c",
        files: [{ name: "watch.log", size: body.length, sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex") }] }));
      await copy.writeAll(body.subarray(0, 1));
      await waitFor(() => logs.includes(`peer link: transfer started: watch-log from Laptop C (${short}): 1 file, 12 bytes`), { message: "copying" });

      await stallPoll();
      await waitFor(() => logs.includes(kept), { message: "kept" });
      expect(far.closeInfo()).toBeNull();
      expect(service.view().links[0]).toMatchObject({ connected: true, lastError: null });

      // The rest of the body and FIN arrive: the copy ends ok.
      await copy.writeAll(body.subarray(1));
      await copy.finish();
      expect(Buffer.from((await copying).files[0]!.body).toString()).toBe("remote line\n");
      expect(logs.find(line => line.startsWith("peer link: transfer ok:"))).toStartWith(`peer link: transfer ok: watch-log from Laptop C (${short}): 12 of 12 bytes in `);
      clock.advance(PEER_REQUEST_TIMEOUT_MS); // the kept poll's next check
      await waitFor(() => service.view().links[0]?.connected === false, { message: "closed" });
    } finally {
      await service.shutdown();
    }
  });

  test("a watch log copy that fails after its header ends its transfer failed", async () => {
    const { service, logs, far } = await connectedService();
    const short = ID_REMOTE.slice(0, 10);
    try {
      const copying = service.fetchWatchLog(ID_REMOTE).catch((err: Error) => err);
      const copy = await far.acceptBi();
      await copy.readToEnd(4096);
      await copy.writeAll(encodeFrameHeader({ op: "watch-log", now: 1, version: "9.9.9", name: "laptop-c",
        files: [{ name: "watch.log", size: 3, sha256: "0".repeat(64) }] }));
      await copy.writeAll(Buffer.from("abc"));
      await copy.finish();
      expect(String(await copying)).toContain("watch.log hash mismatch");
      expect(logs.find(line => line.startsWith("peer link: transfer failed"))).toStartWith(`peer link: transfer failed (watch.log hash mismatch): watch-log from Laptop C (${short}): 3 of 3 bytes in `);
    } finally {
      await service.shutdown();
    }
  });
});

describe("PeerService trusted ALPN", () => {
  test("answers a listed peer from agents(), projected to the allowed fields, and closes anyone else unread", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const local = makeAgent({ id: "agent-1", repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "waiting" });
    Object.assign(local.meta, { prompt: "SECRET PROMPT", agentType: "worker", manager: "agent-0", nickname: "nick" });
    let snapshots = 0;
    const { service, endpoint } = makeService({
      snapshot: () => {
        snapshots++;
        return { coordinator: null, repos: [], agents: toRemoteAgents([local]), questions: [] };
      },
    });
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's own dial to ID_REMOTE stays pending
    await service.bootIfPaired();
    const selfId = service.view().selfId!;

    const listed = incomingFrom(endpoint, selfId, PEER_ALPN);
    const reply = await requestAgents(listed);
    expect(reply).toEqual({ coordinator: null, repos: [], agents: toRemoteAgents([local]), questions: [] });
    expect(JSON.stringify(reply)).not.toContain("SECRET");
    expect(snapshots).toBe(1);

    const strangerLink = createMemoryLink("d4".repeat(32), selfId);
    endpoint.push({ accept: async () => serviceConnection(strangerLink.b, PEER_ALPN) });
    await expect(requestAgents(strangerLink.a)).rejects.toThrow();
    expect(strangerLink.a.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.notPeer, reason: "not a peer" });
    expect(snapshots).toBe(1);

    listed.close(PEER_CLOSE.done, "done");
    await service.shutdown();
  });

  test("a permissions request reaches remotePermissions on this machine's agent, as the paired peer", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const repo = join(home, "app");
    await Bun.write(join(agentsDir(repo), "worker", "meta.json"), JSON.stringify(makeAgent({ id: "worker" }).meta));
    const notices: unknown[][] = [];
    const remotePermissions: RemotePermissionDeps = {
      listRepos: async () => [{ name: "App", path: repo }],
      effectiveSpawnCapability: async () => false,
      grantAgentPermission: mock<RemotePermissionDeps["grantAgentPermission"]>(async () => ({ ok: true })),
      setAgentSpawnCapability: async () => ({ ok: true }),
      notice: (...args) => { notices.push(args); },
    };
    const { service, endpoint, logs } = makeService({ remotePermissions });
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's own dial to ID_REMOTE stays pending
    await service.bootIfPaired();
    const conn = incomingFrom(endpoint, service.view().selfId!, PEER_ALPN);
    try {
      expect(await requestPermissions(conn, { repo: "app", id: "worker", allow: "Read" }, "Desk", createFakeClock().setTimer))
        .toEqual({ canSpawnChildren: false });
      expect(remotePermissions.grantAgentPermission).toHaveBeenCalledWith(expect.objectContaining({ id: "worker", repoPath: repo }), "Read");
      expect(notices).toEqual([["Laptop C added Read to worker allow list in App", "info"]]);
      expect(logs).toContain("Laptop C added Read to worker allow list in App");
    } finally {
      conn.close(PEER_CLOSE.done, "done");
      await service.shutdown();
    }
  });

  test("a framed remote start shows its receipt row, and shutdown cancels it and removes the partial", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    await writeFile(join(home, ".itsybitsy", "machine-name"), "laptop");
    const staging = join(home, "staging");
    const newAgent = mock<RemoteSpawnDeps["newAgent"]>(async () => ({ ok: true, exitCode: 0, stdout: "agent-1", stderr: "" }));
    const { service, endpoint } = makeService({ remoteSpawn: {
      listSpawnableTypes: listSpawnableTypeNamesSync, listRepos: async () => [{ name: "app", path: "/local/app" }], newAgent, notice() {},
      attachments: createAttachmentReceiver({ tempDir: home, stagingRoot: staging, hasFreeSpace: async () => true }),
    } });
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's own dial to ID_REMOTE stays pending
    await service.bootIfPaired();
    const conn = incomingFrom(endpoint, service.view().selfId!, PEER_ALPN);
    const files = [{ name: "a.txt", size: 3, sha256: new Bun.CryptoHasher("sha256").update("abc").digest("hex"), spellings: ["./a.txt"] }];
    const stream = await conn.openBi();
    await stream.writeAll(encodeFrameHeader({ op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt", files }));
    await stream.writeAll(Buffer.from("a"));
    await waitFor(() => service.view().incoming?.[0]?.bytes === 1);
    expect(service.view().incoming).toEqual([{ id: expect.any(String), label: "Laptop C → new agent in app", bytes: 1, total: 3 }]);
    await service.shutdown();
    await waitFor(async () => (await readdir(join(staging, "incoming"))).length === 0);
    expect(service.view().incoming ?? []).toEqual([]);
    expect(newAgent).not.toHaveBeenCalled();
    conn.close(PEER_CLOSE.done, "done");
  });

  test("each trusted connection logs its path when it opens and each time its selected path changes; the watch stops on close", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint, logs } = makeService();
    const dialedPaths = new FakePaths();
    dialedPaths.current = [
      { selected: true, relay: true, remoteAddr: "https://relay.example./", rttMs: 140 },
      { selected: false, relay: false, remoteAddr: "198.51.100.4:61000", rttMs: 0 },
    ];
    endpoint.connectImpl = async id => {
      const link = createMemoryLink("00".repeat(32), id);
      void serveTrustedConnection(link.b, {
        setTimer: createFakeClock().setTimer, peerName: async () => "paired", log: () => {},
        snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }),
      });
      return serviceConnection(link.a, PEER_ALPN, dialedPaths);
    };
    const peer = `Laptop C (${ID_REMOTE.slice(0, 10)})`;
    const pathLines = () => logs.filter(line => / (dialed|accepted) /.test(line));
    try {
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      expect(pathLines()).toEqual([`peer link: dialed ${peer}: relayed via https://relay.example./, rtt 140 ms`]);

      // The relay to direct upgrade, then a repeat event for the same path: one line.
      dialedPaths.select({ selected: true, relay: false, remoteAddr: "198.51.100.4:61000", rttMs: 31 });
      dialedPaths.select({ selected: true, relay: false, remoteAddr: "198.51.100.4:61000", rttMs: 29 });
      expect(pathLines().at(-1)).toBe(`peer link: dialed ${peer}: path changed: direct to 198.51.100.4:61000, rtt 31 ms`);
      expect(pathLines()).toHaveLength(2);

      // The other side's own dial, accepted here.
      const acceptedPaths = new FakePaths();
      const inbound = createMemoryLink(ID_REMOTE, service.view().selfId!);
      endpoint.push({ accept: async () => serviceConnection(inbound.b, PEER_ALPN, acceptedPaths) });
      await waitFor(() => acceptedPaths.watchers.size === 1, { message: "accepted" });
      expect(pathLines().at(-1)).toBe(`peer link: accepted ${peer}: direct to 192.0.2.7:4433, rtt 12 ms`);
      inbound.a.close(PEER_CLOSE.done, "done");
      await waitFor(() => acceptedPaths.watchers.size === 0, { message: "accepted watch stopped" });

      // A connection that fails the allowlist gets no path line and no watch.
      const strangerId = "d4".repeat(32);
      const strangerPaths = new FakePaths();
      const stranger = createMemoryLink(strangerId, service.view().selfId!);
      endpoint.push({ accept: async () => serviceConnection(stranger.b, PEER_ALPN, strangerPaths) });
      await waitFor(() => stranger.a.closeInfo() !== null, { message: "stranger closed" });
      expect(stranger.a.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.notPeer });
      expect(logs.filter(line => line.includes(strangerId.slice(0, 10)))).toEqual([
        `peer link: closed a connection from ${strangerId.slice(0, 10)}: not a peer`,
      ]);
      expect(strangerPaths.watchers.size).toBe(0);
      expect(pathLines()).toHaveLength(3);
    } finally {
      await service.shutdown();
    }
    await waitFor(() => dialedPaths.watchers.size === 0, { message: "dialed watch stopped" });
  });

  test("an inbound framed start logs one transfer line once it owns its body and one at its commit: the spawn after it is not counted", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    await writeFile(join(home, ".itsybitsy", "machine-name"), "laptop");
    let spawnTakes = () => {};
    const newAgent = mock<RemoteSpawnDeps["newAgent"]>(async () => {
      spawnTakes(); // a worktree and a tmux session take seconds
      return { ok: true, exitCode: 0, stdout: "agent-1", stderr: "" };
    });
    const { service, endpoint, logs, clock } = makeService({ remoteSpawn: {
      listSpawnableTypes: listSpawnableTypeNamesSync, listRepos: async () => [{ name: "app", path: "/local/app" }], newAgent, notice() {},
      attachments: createAttachmentReceiver({ tempDir: home, stagingRoot: join(home, "staging"), hasFreeSpace: async () => true }),
    } });
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's own dial to ID_REMOTE stays pending
    await service.bootIfPaired();
    const conn = incomingFrom(endpoint, service.view().selfId!, PEER_ALPN);
    const start = async (sha256: string) => {
      const stream = await conn.openBi();
      await stream.writeAll(encodeFrameHeader({ op: "new-agent", repo: "app", type: "worker", prompt: "use ./a.txt",
        files: [{ name: "a.txt", size: 3, sha256, spellings: ["./a.txt"] }] }));
      await stream.writeAll(Buffer.from("abc"));
      await stream.finish();
      return JSON.parse(new TextDecoder().decode(await stream.readToEnd(4096)));
    };
    const peer = `Laptop C (${ID_REMOTE.slice(0, 10)})`;
    const abc = new Bun.CryptoHasher("sha256").update("abc").digest("hex");
    try {
      spawnTakes = () => clock.jump(8_000);
      expect(await start(abc)).toEqual({ ok: true, id: "agent-1" });
      expect(await start("0".repeat(64))).toEqual({ op: "error", reason: "Attachment hash mismatch" });
      // A spawn that fails after the whole body arrived: the transfer itself was fine.
      newAgent.mockImplementationOnce(async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "worktree add failed" }));
      expect(await start(abc)).toEqual({ op: "error", reason: "worktree add failed" });
      expect(logs.filter(line => line.includes("transfer"))).toEqual([
        `peer link: transfer started: new-agent from ${peer}: 1 file, 3 bytes`,
        `peer link: transfer ok: new-agent from ${peer}: 3 of 3 bytes in 0.0 s, 2.9 KB/s`,
        `peer link: transfer started: new-agent from ${peer}: 1 file, 3 bytes`,
        `peer link: transfer failed (Attachment hash mismatch): new-agent from ${peer}: 3 of 3 bytes in 0.0 s, 2.9 KB/s`,
        `peer link: transfer started: new-agent from ${peer}: 1 file, 3 bytes`,
        `peer link: transfer ok: new-agent from ${peer}: 3 of 3 bytes in 0.0 s, 2.9 KB/s`,
      ]);
    } finally {
      conn.close(PEER_CLOSE.done, "done");
      await service.shutdown();
    }
  });
});

/** What the wrapper's readToEnd throws for a stream longer than its limit (iroh.ts isIrohTooLong). */
const irohTooLong = () => new IrohError("RecvStream.readToEnd", "TooLong");

/** `stream` with its reads failing as `fail` says. */
function failingReads(stream: ServiceStream, fail: () => Error): ServiceStream {
  return {
    write: bytes => stream.write(bytes),
          resetSending: () => stream.resetSending(),
          stopReceiving: () => stream.stopReceiving(),
          read: limit => stream.read(limit),
    writeAll: (bytes) => stream.writeAll(bytes),
    cancel: () => stream.cancel(),
    finish: () => stream.finish(),
    setPriority: (priority) => stream.setPriority(priority),
    readToEnd: async () => {
      throw fail();
    },
  };
}

describe("toPairConnection maps iroh's TooLong to PairProtocolError", () => {
  for (const [alpn, reason] of [
    [PAIR_ALPN, `message longer than ${PAIR_MAX_MESSAGE_BYTES} bytes`],
    [PEER_ALPN, `request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes`],
  ] as const) {
    test(`on the ${alpn} ALPN: an over-long message closes the connection with code 3 and says why`, async () => {
      // A listed peer, so the trusted ALPN reads its request at all.
      await addPeer({ id: ID_REMOTE, name: "Laptop C" });
      const { service, endpoint } = makeService();
      endpoint.connectImpl = () => new Promise(() => {}); // the poller's own dial stays pending
      service.openDialog();
      await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
      const link = createMemoryLink(ID_REMOTE, service.view().selfId!);
      const conn = serviceConnection(link.b, alpn);
      endpoint.push({
        accept: async () => ({ ...conn, acceptBi: async () => failingReads(await conn.acceptBi(), irohTooLong) }),
      });

      const stream = await link.a.openBi();
      await stream.writeAll(alpn === PAIR_ALPN ? encodePairMessage({ op: "pair-hello" }) : Buffer.alloc(NEW_AGENT_MAX_REQUEST_BYTES + 1, "a"));
      await stream.finish();
      await waitFor(() => link.a.closeInfo() !== null, { message: "the connection closed" });
      // Unmapped, the pair ALPN would close it as a "connection error", and the
      // trusted ALPN would not close it at all.
      expect(link.a.closeInfo()).toEqual({ byPeer: true, code: alpn === PAIR_ALPN ? PAIR_CLOSE.error : PEER_CLOSE.error, reason });
      await service.shutdown();
    });
  }

  test("on both stream directions; any other read error passes through unchanged", async () => {
    const link = createMemoryLink(ID_REMOTE, "00".repeat(32));
    const other = new IrohError("RecvStream.readToEnd", "Reset");
    const conn = serviceConnection(link.a, PEER_ALPN);
    const opened = toPairConnection({ ...conn, openBi: async () => failingReads(await conn.openBi(), irohTooLong) });
    const read = (await opened.openBi()).readToEnd(1234);
    await expect(read).rejects.toBeInstanceOf(PairProtocolError);
    await expect(read).rejects.toThrow("message longer than 1234 bytes");

    const passthrough = toPairConnection({ ...conn, openBi: async () => failingReads(await conn.openBi(), () => other) });
    await expect((await passthrough.openBi()).readToEnd(10)).rejects.toBe(other);
  });
});

describe("endpoint owner peer-outbox polling", () => {
  test("only the lock owner recovers a ready entry without peers or a bound endpoint", async () => {
    const base = join(home, ".itsybitsy", "peer-outbox");
    const dir = join(base, crypto.randomUUID());
    await mkdir(dir, { recursive: true });
    const { writeTransferOwner } = await import("./transfer-owner");
    await writeTransferOwner(dir, { pid: OTHER.pid, start: OTHER.startEpoch });
    const deps = defaultPeerServiceDeps("Desk", () => {}, () => ({ coordinator: null, agents: [], repos: [], questions: [] }), () => {}, null, home);
    const locked = new PeerService({ ...deps, acquireLock: async () => ({ acquired: false, ownerPid: 42 }) });
    const owner = new PeerService(deps);
    try {
      await locked.bootIfPaired();
      expect((await stat(dir)).isDirectory()).toBe(true);
      await owner.bootIfPaired();
      expect(await readdir(base)).toEqual([]);
      expect(owner.view().status.kind).not.toBe("listening");
    } finally { await locked.shutdown(); await owner.shutdown(); }
  });

  test("a malformed peer list leaves the lock owner recovering without binding", async () => {
    const events: string[] = [];
    const { service, binds } = makeService({ recoverTransfers: async () => { events.push("recover"); },
      readPeers: async () => { events.push("read peers"); throw Error("invalid peer list"); } });
    try {
      await service.bootIfPaired();
      expect(events).toEqual(["recover", "read peers"]);
      expect(binds).toHaveLength(0);
      expect(service.view().peersError).toBe("invalid peer list");
    } finally { await service.shutdown(); }
  });

  test("a suspended recovery retains the service lock through endpoint close", async () => {
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let hold = false;
    const owner = makeService({ recoverTransfers: async () => { if (hold) { entered.resolve(); await held.promise; } } });
    const other = makeService({ acquireLock: () => acquireEndpointLock(OTHER), releaseLock: () => releaseEndpointLock(OTHER),
      recoverTransfers: async () => {} });
    alive.add(OTHER.pid); starts.set(OTHER.pid, OTHER.startEpoch);
    try {
      owner.service.openDialog();
      await waitFor(() => owner.service.view().status.kind === "listening");
      hold = true;
      const sweep = owner.service.bootIfPaired();
      await entered.promise;
      const closing = owner.service.shutdown();
      await other.service.bootIfPaired();
      expect(other.service.view().status.kind).toBe("disabled");
      held.resolve(); await sweep; await closing;
      await other.service.bootIfPaired();
      expect(other.service.view().status.kind).toBe("idle");
    } finally { held.resolve(); await owner.service.shutdown(); await other.service.shutdown(); }
  });

  test("only the owner polls, overlapping ticks send each id once with four active, and endpoint loss stops claims", async () => {
    const base = join(home, ".itsybitsy", "peer-outbox");
    const owner = makeService({ pollOutbox: createPeerOutboxPoll() });
    const secondPoll = mock(createPeerOutboxPoll());
    const second = makeService({ acquireLock: () => acquireEndpointLock(OTHER), pollOutbox: secondPoll });
    const gate = Promise.withResolvers<void>();
    const send = spyOn(owner.service, "sendRemoteMessage").mockImplementation(async (_peer, header) => {
      await gate.promise;
      return header.id;
    });
    const headers = Array.from({ length: 6 }, () => textHeader({ kind: "system" }, "message", { kind: "user" }));
    const abort = new AbortController();
    let requests: ReturnType<typeof handoffRemoteMessage>[] = [];
    try {
      owner.service.openDialog();
      await waitFor(() => owner.service.view().status.kind === "listening");
      second.service.openDialog();
      await waitFor(() => second.service.view().status.kind === "disabled");
      requests = headers.map(header => handoffRemoteMessage(ID_REMOTE, header, abort.signal));
      await waitFor(() => send.mock.calls.length === 4);
      const id = send.mock.calls[0]![1].id;
      const dir = join(base, ".claimed", id + `@${process.pid}-${processStartEpochSecondsCtx.fn(process.pid)}`);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, "request.json"))).mode & 0o777).toBe(0o600);
      await Bun.sleep(300);
      expect(send).toHaveBeenCalledTimes(4);
      gate.resolve();
      expect((await Promise.all(requests)).every(r => r.ok)).toBe(true);
      expect(send.mock.calls.map(call => call[1].id).sort()).toEqual(headers.map(header => header.id).sort());
      expect(send.mock.calls.every(call => call[2] === "handoff")).toBe(true);
      owner.endpoint.failAccept(new Error("lost endpoint"));
      await waitFor(() => owner.service.view().status.kind === "error");
      const pending = textHeader({ kind: "system" }, "after loss", { kind: "user" });
      const path = join(base, pending.id, "request.json");
      await Bun.write(path, JSON.stringify({ peer: ID_REMOTE, header: pending }));
      await Bun.sleep(350);
      expect(await Bun.file(path).exists()).toBe(true);
      expect(send).toHaveBeenCalledTimes(6);
      expect(secondPoll).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      gate.resolve();
      await Promise.all(requests);
      await second.service.shutdown();
      await owner.service.shutdown();
    }
  });

  test("an owner keeps live claims across sweeps and reclaims dead claims without replay", async () => {
    const base = join(home, ".itsybitsy", "peer-outbox", ".claimed");
    const crashed = textHeader({ kind: "system" }, "old", { kind: "user" });
    const done = textHeader({ kind: "system" }, "complete", { kind: "user" });
    const abandoned = join(base, crashed.id + `@${OTHER.pid}-${OTHER.startEpoch}`, "request.json");
    const unread = join(base, done.id + `@${OTHER.pid}-${OTHER.startEpoch}`, "result.json");
    await Bun.write(abandoned, JSON.stringify({ peer: ID_REMOTE, header: crashed }));
    await Bun.write(unread, JSON.stringify({ ok: true, id: done.id }));
    const { writeTransferOwner } = await import("./transfer-owner");
    alive.add(OTHER.pid);
    starts.set(OTHER.pid, OTHER.startEpoch);
    for (const id of [crashed.id, done.id]) await writeTransferOwner(join(base, id + `@${OTHER.pid}-${OTHER.startEpoch}`), { pid: OTHER.pid, start: OTHER.startEpoch! });
    let now = Date.now();
    const tick = createPeerOutboxPoll(() => now);
    let finishedAt = -1;
    const poll: import("./peer-outbox").PeerOutboxPoll = async (...args) => {
      const startedAt = now;
      await tick(...args);
      finishedAt = startedAt;
    };
    const { service } = makeService({ pollOutbox: poll, recoverTransfers: () => tick.recover() });
    const send = spyOn(service, "sendRemoteMessage");
    try {
      service.openDialog();
      await waitFor(() => finishedAt === now);
      now += 599_000;
      await waitFor(() => finishedAt === now);
      now += 29_999;
      await waitFor(() => finishedAt === now);
      expect(await Bun.file(abandoned).exists()).toBe(true);
      expect(await Bun.file(unread).exists()).toBe(true);
      alive.delete(OTHER.pid);
      now++;
      await service.bootIfPaired();
      await waitFor(() => finishedAt === now);
      expect(await Bun.file(abandoned).exists()).toBe(false);
      expect(await Bun.file(unread).exists()).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally { await service.shutdown(); }
  });
});

test("watcher shutdown aborts an outbox worker and waits for its cleanup", async () => {
  const started = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const header = textHeader({ kind: "system" }, "hello", { kind: "user" });
  let signal: AbortSignal | undefined;
  const { service } = makeService({ pollOutbox: async send => {
    try { await send(ID_REMOTE, header, {}); } finally { await cleanup.promise; }
  } });
  spyOn(service, "sendRemoteMessage").mockImplementation(async (_id, _header, _src, transfer) => {
    signal = transfer!.signal;
    started.resolve();
    return new Promise(resolve => signal!.addEventListener("abort", () => resolve(header.id), { once: true }));
  });
  await service.openDialog();
  await started.promise;
  let done = false;
  const stop = service.shutdown().then(() => { done = true; });
  await Bun.sleep(10);
  expect(signal?.aborted).toBe(true);
  expect(done).toBe(false);
  cleanup.resolve();
  await stop;
});

describe("scheduled remote runs and the endpoint owner (SPEC §21.2)", () => {
  const TASK = { machine: ID_REMOTE, repo: "web", agentType: "worker", prompt: "Check the build", cron: "* * * * *", autoRetire: false };

  /** Run `body` with setInterval handed to the test, which fires the timers itself. */
  async function withCapturedIntervals(body: (armed: Array<{ fn: () => void; ms: number }>) => Promise<void>): Promise<void> {
    const g = globalThis as unknown as { setInterval: (fn: () => void, ms?: number) => unknown; clearInterval: (handle?: unknown) => void };
    const realSetInterval = g.setInterval;
    const realClearInterval = g.clearInterval;
    const armed: Array<{ fn: () => void; ms: number; handle: object }> = [];
    g.setInterval = (fn, ms = 0) => {
      const handle = {};
      armed.push({ fn, ms, handle });
      return handle;
    };
    g.clearInterval = (handle) => {
      const i = armed.findIndex(a => a.handle === handle);
      if (i !== -1) armed.splice(i, 1);
      else realClearInterval(handle);
    };
    try {
      await body(armed);
    } finally {
      g.setInterval = realSetInterval;
      g.clearInterval = realClearInterval;
    }
  }

  /** A scheduler wired to `service` as startDashboard wires it, with the real store. */
  function schedulerFor(service: PeerService, now: () => number, started: string[]): Scheduler {
    return new Scheduler({
      now,
      readTasks: readScheduledTasks,
      claimRun: claimScheduledRun,
      recordResult: recordScheduledRunResult,
      startLocal: async () => { throw new Error("no local task in this test"); },
      startRemote: (task, prompt, signal) => {
        started.push(task.id);
        return service.startRemoteAgent(task.machine!, { repo: task.repo, type: task.agentType, prompt, autoRetire: task.autoRetire }, { signal });
      },
      remoteRunsHere: () => !service.endpointOwnedElsewhere,
      machineName: "Desk",
      targetName: id => id ?? "Desk",
      log: () => {},
      notice: () => {},
      refresh: () => {},
    });
  }

  test("a dashboard that lost the endpoint lock leaves a remote run unclaimed while the 30 s lock poll asks again", async () => {
    alive.add(OTHER.pid);
    starts.set(OTHER.pid, OTHER.startEpoch);
    await mkdir(peerDir(), { recursive: true });
    await writeFile(peerEndpointLockFile(), `${OTHER.pid} ${OTHER.startEpoch}\n`);
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    await createScheduledTask(TASK);
    // Holds the lock poll's lock check open, so the scheduler's tick runs inside it.
    let lockGate: Promise<void> | null = null;

    await withCapturedIntervals(async (armed) => {
      const { service } = makeService({
        recoverTransfers: async () => {},
        acquireLock: async () => {
          if (lockGate) await lockGate;
          return acquireEndpointLock();
        },
      });
      let nowMs = Date.now();
      const started: string[] = [];
      const scheduler = schedulerFor(service, () => nowMs, started);
      try {
        await service.bootIfPaired();
        expect(service.view().status).toEqual({ kind: "disabled", ownerPid: OTHER.pid });
        scheduler.start();
        // ib watch arms the lock poll (in bootIfPaired), then the scheduler's tick,
        // both every 30 s: each period they fire in that order, in one turn.
        const timers = armed.filter(a => a.ms === 30_000);
        expect(timers).toHaveLength(2);

        nowMs += 60_000; // a run is due
        const held = Promise.withResolvers<void>();
        lockGate = held.promise;
        for (const timer of timers) timer.fn();
        expect(service.view().status.kind).toBe("starting");
        await scheduler.tick(); // the tick the timer started

        expect(started).toEqual([]);
        expect((await readScheduledTasks())[0]!.lastRunAt).toBeUndefined();
        held.resolve();
        await waitFor(() => service.view().status.kind === "disabled", { message: "the lock poll to find the owner again" });
      } finally {
        lockGate = null;
        await scheduler.stop();
        await service.shutdown();
      }
    });
  });

  test("a single dashboard whose bind failed still claims a remote run and records why it did not start", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const task = await createScheduledTask(TASK);
    const { service } = makeService({ recoverTransfers: async () => {} }, [new Error("network is unreachable")]);
    let nowMs = Date.now();
    const started: string[] = [];
    const scheduler = schedulerFor(service, () => nowMs, started);
    try {
      await service.bootIfPaired();
      expect(service.view().status.kind).toBe("error");

      nowMs += 60_000;
      await scheduler.tick();

      expect(started).toEqual([task.id]);
      const stored = (await readScheduledTasks())[0]!;
      expect(stored.lastRunAt).toBeGreaterThan(0);
      expect(stored.lastError).toBe("Machine is disconnected");
    } finally {
      await scheduler.stop();
      await service.shutdown();
    }
  });
});

describe("watch log copies (ib export-logs)", () => {
  const remoteFiles: WatchLogFile[] = [
    { name: "watch.log", body: Buffer.from("remote newest\n") },
    { name: "watch.log.1", body: Buffer.from("remote older\n") },
  ];

  test("the CLI's request reaches the peer through the outbox and the poller's connection", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint, clock } = makeService({ pollOutbox: createPeerOutboxPoll() });
    const responderLogs: string[] = [];
    endpoint.connectImpl = async (id) => {
      const link = createMemoryLink("00".repeat(32), id);
      void serveTrustedConnection(link.b, {
        setTimer: createFakeClock().setTimer, peerName: async () => "Desk", log: (line) => responderLogs.push(line),
        snapshot: () => ({ coordinator: null, repos: [], agents: [], questions: [] }),
        readWatchLog: async () => ({ name: "laptop-c", version: "9.9.9", files: remoteFiles }),
      });
      return serviceConnection(link.a, PEER_ALPN);
    };
    try {
      await service.bootIfPaired();
      await waitFor(() => service.view().links[0]?.connected === true);
      const result = await handoffWatchLog(ID_REMOTE, "Laptop C", new AbortController().signal);
      expect(result).toMatchObject({ ok: true, exitCode: 0, stderr: "" });
      const copy = decodeWatchLogOutput(result.stdout);
      expect(copy).toMatchObject({ name: "laptop-c", version: "9.9.9", sentAt: clock.now(), headerAt: clock.now(), doneAt: clock.now() });
      expect(copy.files.map((file) => [file.name, Buffer.from(file.body).toString()])).toEqual([
        ["watch.log", "remote newest\n"], ["watch.log.1", "remote older\n"],
      ]);
      expect(responderLogs).toContain("peer link: wrote the watch log to Desk (0000000000) (2 files, 0.0 MB)");
    } finally {
      await service.shutdown();
    }
  });

  test("a disconnected peer is reported with the service's reason", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service } = makeService({ pollOutbox: createPeerOutboxPoll() });
    try {
      await service.bootIfPaired();
      await waitFor(() => typeof service.view().links[0]?.lastError === "string");
      expect(await handoffWatchLog(ID_REMOTE, "Laptop C", new AbortController().signal))
        .toMatchObject({ ok: false, exitCode: 1, stderr: "Machine is disconnected" });
    } finally {
      await service.shutdown();
    }
  });

  test("an accepted trusted connection is answered from readWatchLog", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const { service, endpoint, logs } = makeService({
      readWatchLog: async () => ({ name: "desk", version: "1.2.3", files: remoteFiles.slice(0, 1) }),
    });
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's own dial to ID_REMOTE stays pending
    await service.bootIfPaired();
    const conn = incomingFrom(endpoint, service.view().selfId!, PEER_ALPN);
    try {
      const copy = await requestWatchLog(conn, createFakeClock().setTimer);
      expect(copy).toMatchObject({ name: "desk", version: "1.2.3" });
      expect(copy.files.map((file) => file.name)).toEqual(["watch.log"]);
      await waitFor(() => logs.includes(`peer link: wrote the watch log to Laptop C (${ID_REMOTE.slice(0, 10)}) (1 file, 0.0 MB)`));
      // The reply's write is one of the service's transfers.
      expect(logs).toContain(`peer link: transfer started: watch-log to Laptop C (${ID_REMOTE.slice(0, 10)}): 1 file, 14 bytes`);
      expect(logs.some(line => line.startsWith(`peer link: transfer ok: watch-log to Laptop C (${ID_REMOTE.slice(0, 10)}): 14 of 14 bytes written in `))).toBe(true);
    } finally {
      conn.close(PEER_CLOSE.done, "done");
      await service.shutdown();
    }
  });
});
