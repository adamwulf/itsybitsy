import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAliveCtx, processStartEpochSecondsCtx, resetProcessStartEpochSecondsCache } from "../agents";
import { resetUserHome, setUserHome } from "../home";
import { peerDir, peerEndpointLockFile, peersFile } from "../runtime-names";
import { makeAgent, waitFor } from "../test-utils";
import { acquireEndpointLock, releaseEndpointLock } from "./endpoint-lock";
import { loadOrCreateIdentity } from "./identity";
import { IrohError, irohAddonLoaderCtx } from "./iroh";
import { PAIR_ALPN, PAIR_CLOSE, PAIR_MAX_MESSAGE_BYTES, PairProtocolError, decodePairMessage, encodePairMessage } from "./pairing";
import {
  PEER_ALPN,
  PEER_CLOSE,
  PEER_MAX_REQUEST_BYTES,
  encodePeerRequest,
  requestAgents,
  serveTrustedConnection,
  toRemoteAgents,
  type RemoteAgent,
} from "./peer-link";
import {
  PeerService,
  defaultPeerServiceDeps,
  peerRetryDelayMs,
  toPairConnection,
  type PeerServiceDeps,
  type ServiceConnection,
  type ServiceEndpoint,
  type ServiceIncoming,
  type ServiceStream,
} from "./service";
import { addPeer, readPeers } from "./store";
import { createFakeClock, createMemoryLink, type MemoryConnection } from "./test-pair-transport";

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

  acceptNext(): Promise<ServiceIncoming | null> {
    if (this.isClosed) return Promise.resolve(null);
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

/** A memory connection as the wrapper's connection shape, on `alpn`. */
function serviceConnection(conn: MemoryConnection, alpn = PAIR_ALPN): ServiceConnection {
  return {
    remoteId: () => conn.remoteId,
    alpn: () => alpn,
    openBi: () => conn.openBi(),
    acceptBi: () => conn.acceptBi(),
    close: (code, reason) => conn.close(code, reason),
    closed: () => conn.closed(),
    closeInfo: () => conn.closeInfo(),
  };
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
  const clock = createFakeClock();
  const service = new PeerService({
    acquireLock: () => acquireEndpointLock(),
    releaseLock: () => releaseEndpointLock(),
    loadIdentity: loadOrCreateIdentity,
    bindEndpoint: async (_secretKey, alpns) => {
      binds.push(alpns);
      const next = endpoints[binds.length - 1];
      if (!next) throw new Error(`bind ${binds.length} has no fake endpoint`);
      if (next instanceof Error) throw next;
      return next;
    },
    readPeers,
    addPeer,
    generateCode: () => "ABCD1234",
    now: clock.now,
    setTimer: clock.setTimer,
    log: (line) => logs.push(line),
    agents: () => [],
    ...overrides,
  });
  return { service, endpoint, logs, binds, clock };
}

const lockContents = () => readFile(peerEndpointLockFile(), "utf-8").catch(() => null);

/** When the pending automatic rebind runs, or null when the status is not an error with one pending. */
function retryAt(service: PeerService): number | null {
  const status = service.view().status;
  return status.kind === "error" ? status.retryAt : null;
}

describe("PeerService binding", () => {
  test("with no peers nothing binds until the dialog opens; then it takes the lock and binds once, on the pair and peer ALPNs", async () => {
    const { service, binds, logs } = makeService();
    expect(service.view().status).toEqual({ kind: "idle" });
    expect(binds).toEqual([]);
    expect(await lockContents()).toBeNull();

    service.openDialog();
    expect(service.view().status).toEqual({ kind: "starting" });
    await waitFor(() => service.view().status.kind === "listening", { message: "listening" });
    expect(binds).toEqual([[PAIR_ALPN, PEER_ALPN]]);
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
    expect(logs).toContain("peering: could not bind the endpoint: load: dlopen failed");
    await service.shutdown();
  });

  test("the real defaults are never reached: the addon loader throws in this file", async () => {
    // Guard for the tests above: they inject bindEndpoint, so the addon is never needed.
    const { defaultPeerServiceDeps } = await import("./service");
    const deps = defaultPeerServiceDeps(() => {}, () => []);
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
    void serveTrustedConnection(link.b, { isPeer: async () => true, snapshot: () => agents, log: () => {} });
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
  { id: "agent-r1", nickname: null, repoName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: null },
];

describe("PeerService at boot", () => {
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
      { id: ID_REMOTE, name: "Laptop C", connected: true, lastOkAt: expect.any(Number), lastError: null, agents: REMOTE_AGENTS },
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
    const realBind = defaultPeerServiceDeps(() => {}, () => []).bindEndpoint;
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

describe("PeerService self-heal", () => {
  const SOCKET_GONE = "Endpoint.acceptNext: socket gone";
  const NOT_NEEDED = "peering: not retrying the bind: no paired peers and the Peers dialog is closed";
  const retriedLogs = (logs: string[]) => logs.filter((line) => line.startsWith("peering: retrying the bind after "));

  test("an accept-loop failure rebinds after 5 s, through the lock, and the poller runs again", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const first = new FakeEndpoint();
    const second = new FakeEndpoint();
    const { service, binds, logs, clock } = makeService({}, [first, second]);
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
    expect(logs).toContain("peering: retrying the bind in 5 s");

    clock.advance(4_999);
    await Bun.sleep(10);
    expect(binds.length).toBe(1);
    clock.advance(1);
    await waitFor(() => service.view().status.kind === "listening" && second.accepting, { message: "rebound" });
    expect(binds).toEqual([[PAIR_ALPN, PEER_ALPN], [PAIR_ALPN, PEER_ALPN]]);
    expect(await lockContents()).toBe(`${process.pid} ${ME_START}\n`);
    await waitFor(() => service.view().links[0]?.connected === true, { message: "polled again" });
    expect(second.connects).toEqual([ID_REMOTE]);
    expect(retriedLogs(logs)).toEqual(["peering: retrying the bind after 1 failure"]);
    expect(logs).toContain("peering: recovered after 1 failure");
    await service.shutdown();
    expect(second.closeCalls).toBe(1);
  });

  test("repeated bind failures back off 5, 10, 20, 40, 60, 60 s; a success resets it to 5 s", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const fail = (n: number) => new Error(`load: dlopen failed ${n}`);
    const endpoint = new FakeEndpoint();
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's dial stays pending
    const { service, binds, logs, clock } = makeService({}, [fail(1), fail(2), fail(3), fail(4), fail(5), fail(6), endpoint]);
    await service.bootIfPaired();

    const waits: number[] = [];
    for (let failure = 1; failure <= 6; failure++) {
      await waitFor(() => retryAt(service) !== null, { message: `retry ${failure} armed` });
      expect(service.view().status).toMatchObject({ kind: "error", message: `load: dlopen failed ${failure}` });
      expect(await lockContents()).toBeNull();
      const wait = retryAt(service)! - clock.now();
      waits.push(wait / 1000);
      clock.advance(wait - 1);
      await Bun.sleep(5);
      expect(binds.length).toBe(failure);
      clock.advance(1);
      await waitFor(() => binds.length === failure + 1, { message: `bind ${failure + 1}` });
    }
    expect(waits).toEqual([5, 10, 20, 40, 60, 60]);
    await waitFor(() => service.view().status.kind === "listening" && endpoint.accepting, { message: "bound" });
    expect(logs.filter((line) => line.startsWith("peering: retrying the bind in "))).toEqual(
      waits.map((s) => `peering: retrying the bind in ${s} s`),
    );
    expect(retriedLogs(logs)).toEqual([
      "peering: retrying the bind after 1 failure",
      ...[2, 3, 4, 5, 6].map((n) => `peering: retrying the bind after ${n} failures`),
    ]);
    expect(logs).toContain("peering: recovered after 6 failures");

    endpoint.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => retryAt(service) !== null, { message: "retry after the loop failed" });
    expect(retryAt(service)! - clock.now()).toBe(5_000);
    await service.shutdown();
  });

  test("with no peers and the dialog closed, an accept-loop failure does not rebind", async () => {
    const first = new FakeEndpoint();
    const { service, binds, logs, clock } = makeService({}, [first, new FakeEndpoint()]);
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && first.accepting, { message: "accepting" });
    service.closeDialog(); // the endpoint stays bound, but nothing needs it any more

    first.failAccept(new Error(SOCKET_GONE));
    await waitFor(() => logs.includes(NOT_NEEDED), { message: "not retrying" });
    expect(service.view().status).toEqual({ kind: "error", message: `accept loop stopped: ${SOCKET_GONE}`, retryAt: null });
    expect(await lockContents()).toBeNull();
    clock.advance(600_000);
    await Bun.sleep(10);
    expect(binds.length).toBe(1);
    expect(logs.some((line) => line.startsWith("peering: retrying"))).toBe(false);
    await service.shutdown();
  });

  test("a pending retry binds nothing once nothing needs the endpoint: the dialog closed, or the last peer removed", async () => {
    // Armed while the dialog was open; the dialog closes before it fires.
    {
      const { service, binds, logs, clock } = makeService({}, [new Error("load: dlopen failed"), new FakeEndpoint()]);
      service.openDialog();
      await waitFor(() => retryAt(service) !== null, { message: "retry armed" });
      service.closeDialog();
      clock.advance(5_000);
      await waitFor(() => logs.includes(NOT_NEEDED), { message: "not retrying" });
      expect(binds.length).toBe(1);
      expect(service.view().status).toEqual({ kind: "error", message: "load: dlopen failed", retryAt: null });
      expect(retriedLogs(logs)).toEqual([]);
      await service.shutdown();
    }
    // Armed for a paired install; peers.json is emptied (ib peer remove) before it fires.
    {
      await addPeer({ id: ID_REMOTE, name: "Laptop C" });
      const { service, binds, logs, clock } = makeService({}, [new Error("load: dlopen failed"), new FakeEndpoint()]);
      await service.bootIfPaired();
      expect(retryAt(service)).toBe(clock.now() + 5_000);
      await writeFile(peersFile(), "[]\n");
      clock.advance(5_000);
      await waitFor(() => logs.includes(NOT_NEEDED), { message: "not retrying" });
      expect(binds.length).toBe(1);
      expect(service.view().peers).toEqual([]);
      clock.advance(600_000);
      await Bun.sleep(10);
      expect(binds.length).toBe(1);
      await service.shutdown();
    }
  });

  test("another live ib watch taking the lock stops the retries: disabled, and the lock is not polled", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    let acquires = 0;
    const { service, binds, logs, clock } = makeService(
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

    clock.advance(600_000);
    await Bun.sleep(10);
    expect(acquires).toBe(2);
    expect(binds.length).toBe(1);
    expect(await lockContents()).toBe(`${OTHER.pid} ${OTHER.startEpoch}\n`);
    await service.shutdown();
  });

  test("shutdown cancels a pending retry, and a retry that fires during shutdown binds nothing", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const clock = createFakeClock();
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const { service, binds, logs } = makeService(
      {
        now: clock.now,
        setTimer: (ms, fn) => {
          timers.push({ ms, fn });
          return clock.setTimer(ms, fn);
        },
      },
      [new Error("load: dlopen failed"), new FakeEndpoint()],
    );
    await service.bootIfPaired();
    expect(retryAt(service)).toBe(clock.now() + 5_000);
    const retry = timers.find((t) => t.ms === 5_000)!;

    const stopping = service.shutdown();
    expect(clock.pending()).toBe(0);
    expect(retryAt(service)).toBeNull();
    // A timer whose callback was already on its way when the cancel ran.
    retry.fn();
    await stopping;
    retry.fn();
    clock.advance(600_000);
    await Bun.sleep(10);
    expect(binds.length).toBe(1);
    expect(await lockContents()).toBeNull();
    expect(retriedLogs(logs)).toEqual([]);
    expect(service.view().status).toMatchObject({ kind: "error", retryAt: null });
  });

  test("opening the dialog during a pending retry binds at once, once, and cancels the timer", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const endpoint = new FakeEndpoint();
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's dial stays pending
    const { service, binds, logs, clock } = makeService({}, [new Error("load: dlopen failed"), endpoint]);
    await service.bootIfPaired();
    expect(retryAt(service)).not.toBeNull();

    service.openDialog();
    expect(service.view().status).toEqual({ kind: "starting" });
    service.closeDialog();
    service.openDialog();
    await waitFor(() => service.view().status.kind === "listening" && endpoint.accepting, { message: "bound" });
    expect(binds.length).toBe(2);
    expect(retriedLogs(logs)).toEqual([]);
    expect(logs).toContain("peering: recovered after 1 failure");

    clock.advance(600_000);
    await Bun.sleep(10);
    expect(binds.length).toBe(2);
    expect(service.view().status).toEqual({ kind: "listening" });
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
    const { service, clock } = makeService({
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
    clock.advance(600_000);
    await Bun.sleep(10);
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
    clock.advance(5_000);
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
    await Bun.sleep(10); // the dialog's own peers.json read has settled
    let changes = 0;
    service.onChange(() => changes++);
    clock.advance(1_000);
    expect(changes).toBe(1);
    clock.advance(1_000);
    expect(changes).toBe(2);
    service.closeDialog();
    changes = 0;
    clock.advance(1_000);
    expect(changes).toBe(0);
    await service.shutdown();
  });
});

describe("peerRetryDelayMs", () => {
  test("5, 10, 20, 40, then 60 s however many failures", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100, 10_000].map(peerRetryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe("PeerService trusted ALPN", () => {
  test("answers a listed peer from agents(), projected to the allowed fields, and closes anyone else unread", async () => {
    await addPeer({ id: ID_REMOTE, name: "Laptop C" });
    const local = makeAgent({ id: "agent-1", repoName: "app", repoPath: "/repos/app", state: "waiting" });
    Object.assign(local.meta, { prompt: "SECRET PROMPT", agentType: "worker", manager: "agent-0", nickname: "nick" });
    let snapshots = 0;
    const { service, endpoint } = makeService({
      agents: () => {
        snapshots++;
        return [local];
      },
    });
    endpoint.connectImpl = () => new Promise(() => {}); // the poller's own dial to ID_REMOTE stays pending
    await service.bootIfPaired();
    const selfId = service.view().selfId!;

    const listed = incomingFrom(endpoint, selfId, PEER_ALPN);
    const reply = await requestAgents(listed);
    expect(reply).toEqual(toRemoteAgents([local]));
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
});

/** What the wrapper's readToEnd throws for a stream longer than its limit (iroh.ts isIrohTooLong). */
const irohTooLong = () => new IrohError("RecvStream.readToEnd", "TooLong");

/** `stream` with its reads failing as `fail` says. */
function failingReads(stream: ServiceStream, fail: () => Error): ServiceStream {
  return {
    writeAll: (bytes) => stream.writeAll(bytes),
    finish: () => stream.finish(),
    readToEnd: async () => {
      throw fail();
    },
  };
}

describe("toPairConnection maps iroh's TooLong to PairProtocolError", () => {
  for (const [alpn, reason] of [
    [PAIR_ALPN, `message longer than ${PAIR_MAX_MESSAGE_BYTES} bytes`],
    [PEER_ALPN, `request longer than ${PEER_MAX_REQUEST_BYTES} bytes`],
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
      await stream.writeAll(alpn === PAIR_ALPN ? encodePairMessage({ op: "pair-hello" }) : encodePeerRequest("agents"));
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
