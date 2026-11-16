/**
 * The trusted link's poller (src/peers/poller.ts) with a fake clock and a
 * fake transport: each dial makes an in-memory link whose far end runs the
 * real responder (peer-link.ts serveTrustedConnection). No addon, no network,
 * no real waiting for ticks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { waitFor } from "../test-utils";
import { IrohError, irohAddonLoaderCtx } from "./iroh";
import { PEER_CLOSE, serveTrustedConnection, type RemoteAgent } from "./peer-link";
import type { PairConnection } from "./pairing";
import { PEER_POLL_INTERVAL_MS, PeerPoller } from "./poller";
import type { Peer } from "./store";
import { createFakeClock, createMemoryLink, type MemoryConnection } from "./test-pair-transport";

const SELF = "5e".repeat(32);
const P1 = "a1".repeat(32);
const P2 = "b2".repeat(32);

beforeEach(() => {
  irohAddonLoaderCtx.set(async () => {
    throw new Error("a poller test loaded the iroh addon");
  });
});
afterEach(() => irohAddonLoaderCtx.reset());

function remoteAgent(id: string, state = "running"): RemoteAgent {
  return { id, nickname: null, repoName: "app", repoPath: "/repos/app", state, agentType: "worker", manager: null };
}

/** The other install: whether it lists us, what it reports, and the connections it has served. */
interface Remote {
  allowed: boolean;
  agents: RemoteAgent[];
  requests: number;
  /** The far (responder) end of each connection dialed to it. */
  served: MemoryConnection[];
}

function makeRig(initialPeers: Peer[]) {
  const clock = createFakeClock();
  let peers = initialPeers;
  const remotes = new Map<string, Remote>();
  const dials: string[] = [];
  const logs: string[] = [];
  let readError: Error | null = null;

  const remote = (id: string): Remote => {
    let r = remotes.get(id);
    if (r === undefined) {
      r = { allowed: true, agents: [remoteAgent(`agent-of-${id.slice(0, 4)}`)], requests: 0, served: [] };
      remotes.set(id, r);
    }
    return r;
  };

  /** A working dial: an in-memory link served by the real responder. */
  const connect = async (id: string): Promise<PairConnection> => {
    const r = remote(id);
    const link = createMemoryLink(SELF, id);
    r.served.push(link.b);
    void serveTrustedConnection(link.b, {
      isPeer: async () => r.allowed,
      snapshot: () => {
        r.requests++;
        return r.agents;
      },
      log: () => {},
    });
    return link.a;
  };

  let dialImpl: (id: string) => Promise<PairConnection> = connect;
  const poller = new PeerPoller({
    readPeers: async () => {
      if (readError) throw readError;
      return peers.map((p) => ({ ...p }));
    },
    dial: (id) => {
      dials.push(id);
      return dialImpl(id);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    log: (line) => logs.push(line),
  });
  let changes = 0;
  poller.onChange(() => changes++);

  return {
    clock,
    poller,
    dials,
    logs,
    remote,
    connect,
    changes: () => changes,
    setPeers: (next: Peer[]) => {
      peers = next;
    },
    setReadError: (err: Error | null) => {
      readError = err;
    },
    setDial: (fn: (id: string) => Promise<PairConnection>) => {
      dialImpl = fn;
    },
    state: (id: string) => poller.states().find((s) => s.id === id),
    /** Fire the next tick. */
    tick: () => clock.advance(PEER_POLL_INTERVAL_MS),
  };
}

const peer = (id: string, name: string): Peer => ({ id, name, pairedAt: "2026-11-16T00:00:00.000Z" });

/** A dial the test resolves or rejects by hand. */
function deferredDial() {
  let resolve!: (conn: PairConnection) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<PairConnection>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PeerPoller", () => {
  test("polls at start and then every 5 s, keeping one live connection per peer", async () => {
    const rig = makeRig([peer(P1, "Laptop B")]);
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "connected" });
    expect(rig.state(P1)).toEqual({
      id: P1,
      name: "Laptop B",
      connected: true,
      lastOkAt: rig.clock.now(),
      lastError: null,
      agents: rig.remote(P1).agents,
    });
    for (let i = 2; i <= 4; i++) {
      rig.tick();
      await waitFor(() => rig.remote(P1).requests === i, { message: `request ${i}` });
    }
    expect(rig.dials).toEqual([P1]);
    expect(rig.state(P1)!.lastOkAt).toBe(rig.clock.now());
    expect(rig.logs).toContain(`peer link: connected to Laptop B (${P1.slice(0, 10)})`);
    rig.poller.stop();
  });

  test("a hung dial: no second dial or request while it is pending, and other peers keep polling", async () => {
    const rig = makeRig([peer(P1, "Slow"), peer(P2, "Fast")]);
    const hung = deferredDial();
    rig.setDial((id) => (id === P1 ? hung.promise : rig.connect(id)));
    rig.poller.start();
    await waitFor(() => rig.state(P2)?.connected === true, { message: "P2 connected" });
    for (let i = 0; i < 6; i++) {
      rig.tick(); // 30 s: as long as a dial can take to fail
      await waitFor(() => rig.remote(P2).requests === i + 2, { message: `P2 request ${i + 2}` });
    }
    expect(rig.dials.filter((id) => id === P1)).toEqual([P1]);
    expect(rig.remote(P1).requests).toBe(0);

    // The dial finally lands: its request goes out, and later ticks reuse the connection.
    hung.resolve(await rig.connect(P1));
    await waitFor(() => rig.state(P1)?.connected === true, { message: "P1 connected" });
    rig.tick();
    await waitFor(() => rig.remote(P1).requests === 2, { message: "P1 second request" });
    expect(rig.dials.filter((id) => id === P1)).toEqual([P1]);
    rig.poller.stop();
  });

  test("a hung request is never doubled: ticks skip the peer until it settles", async () => {
    const rig = makeRig([peer(P1, "B")]);
    // A connection whose far end never answers: no responder runs on it.
    const silent = createMemoryLink(SELF, P1);
    let streams = 0;
    const counting: PairConnection = {
      remoteId: P1,
      openBi: () => {
        streams++;
        return silent.a.openBi();
      },
      acceptBi: () => silent.a.acceptBi(),
      close: (code, reason) => silent.a.close(code, reason),
      closed: () => silent.a.closed(),
      closeInfo: () => silent.a.closeInfo(),
    };
    rig.setDial(async () => counting);
    rig.poller.start();
    await waitFor(() => streams === 1, { message: "first request sent" });
    for (let i = 0; i < 4; i++) rig.tick();
    await Bun.sleep(10);
    expect(streams).toBe(1);
    expect(rig.dials).toEqual([P1]);

    // The far end gives up on the connection: the request fails, and the next tick redials.
    silent.b.close(PEER_CLOSE.done, "bye");
    await waitFor(() => rig.state(P1)?.lastError === "closed by the other side", { message: "failed" });
    rig.setDial(rig.connect);
    rig.tick();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "redialed" });
    expect(rig.dials).toEqual([P1, P1]);
    rig.poller.stop();
  });

  test("a failed dial is retried on the next tick; a drop keeps the last list; the next tick redials", async () => {
    const rig = makeRig([peer(P1, "B")]);
    rig.setDial(async () => {
      throw new IrohError("Endpoint.connect", "timed out");
    });
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.lastError !== null, { message: "first dial failed" });
    expect(rig.state(P1)).toEqual({ id: P1, name: "B", connected: false, lastOkAt: null, lastError: "timed out", agents: null });

    rig.setDial(rig.connect);
    rig.tick();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "retried" });
    const okAt = rig.clock.now();
    const firstList = rig.remote(P1).agents;
    expect(rig.state(P1)).toMatchObject({ connected: true, lastOkAt: okAt, lastError: null, agents: firstList });

    // The other side drops the connection (its ib watch quits).
    rig.clock.jump(1_000);
    rig.remote(P1).served[0]!.close(PEER_CLOSE.done, "shutting down");
    await waitFor(() => rig.state(P1)?.connected === false, { message: "dropped" });
    expect(rig.state(P1)).toEqual({ id: P1, name: "B", connected: false, lastOkAt: okAt, lastError: "closed by the other side", agents: firstList });

    // Its list changes while it is away; the redial brings the new one.
    rig.remote(P1).agents = [remoteAgent("agent-new", "waiting")];
    rig.tick();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "redialed" });
    expect(rig.dials).toEqual([P1, P1, P1]);
    expect(rig.state(P1)!.agents).toEqual([remoteAgent("agent-new", "waiting")]);
    rig.poller.stop();
  });

  test("a peer that no longer lists us: 'not a peer', and its last list stays", async () => {
    const rig = makeRig([peer(P1, "B")]);
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "connected" });
    const list = rig.state(P1)!.agents;
    rig.remote(P1).allowed = false; // `ib peer remove` on the other side
    rig.tick();
    await waitFor(() => rig.state(P1)?.lastError === "not a peer", { message: "refused" });
    expect(rig.state(P1)).toMatchObject({ connected: false, agents: list });
    // Refused on the existing connection: no new dial was needed to find out.
    expect(rig.dials).toEqual([P1]);
    rig.tick();
    await waitFor(() => rig.dials.length === 2, { message: "redial" });
    await Bun.sleep(5);
    expect(rig.state(P1)?.lastError).toBe("not a peer");
    rig.poller.stop();
  });

  test("peers.json is re-read every tick: added peers are polled, removed ones dropped and closed, renames followed", async () => {
    const rig = makeRig([peer(P1, "B")]);
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "P1 connected" });

    rig.setPeers([peer(P1, "B"), peer(P2, "C")]);
    rig.tick();
    await waitFor(() => rig.state(P2)?.connected === true, { message: "P2 polled after it was added" });

    rig.setPeers([peer(P2, "Laptop C")]);
    rig.tick();
    await waitFor(() => rig.state(P1) === undefined, { message: "P1 dropped" });
    expect(rig.remote(P1).served[0]!.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.done, reason: "removed" });
    expect(rig.poller.states().map((s) => [s.id, s.name])).toEqual([[P2, "Laptop C"]]);
    expect(rig.logs).toContain(`peer link: stopped polling B (${P1.slice(0, 10)}): no longer in peers.json`);
    const p1Requests = rig.remote(P1).requests;
    rig.tick();
    await waitFor(() => rig.remote(P2).requests === 3, { message: "P2 still polled" });
    expect(rig.remote(P1).requests).toBe(p1Requests);
    rig.poller.stop();
  });

  test("a peers.json read failure keeps polling the known peers and is logged once", async () => {
    const rig = makeRig([peer(P1, "B")]);
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "connected" });
    rig.setReadError(new Error("peers.json: not valid JSON"));
    rig.tick();
    await waitFor(() => rig.remote(P1).requests === 2, { message: "still polled" });
    rig.tick();
    await waitFor(() => rig.remote(P1).requests === 3, { message: "still polled again" });
    expect(rig.logs.filter((l) => l.includes("could not read peers.json"))).toEqual([
      "peer link: could not read peers.json: peers.json: not valid JSON",
    ]);
    rig.poller.stop();
  });

  test("onChange fires on visible changes only; a repeated failure is logged once", async () => {
    const rig = makeRig([peer(P1, "B")]);
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "connected" });
    const afterConnect = rig.changes();
    expect(afterConnect).toBeGreaterThan(0);
    rig.tick();
    await waitFor(() => rig.remote(P1).requests === 2, { message: "second request" });
    await Bun.sleep(5);
    expect(rig.changes()).toBe(afterConnect); // same list, still connected: nothing to redraw

    rig.remote(P1).agents = [remoteAgent("agent-x", "complete")];
    rig.tick();
    await waitFor(() => rig.changes() === afterConnect + 1, { message: "a new list notifies" });

    rig.remote(P1).served[0]!.close(PEER_CLOSE.done, "bye");
    rig.setDial(async () => {
      throw new IrohError("Endpoint.connect", "timed out");
    });
    await waitFor(() => rig.state(P1)?.connected === false, { message: "dropped" });
    for (let i = 0; i < 3; i++) {
      rig.tick();
      await waitFor(() => rig.dials.length === 2 + i, { message: `failed dial ${i + 1}` });
    }
    await Bun.sleep(5);
    expect(rig.logs.filter((l) => l.endsWith(": timed out"))).toEqual([`peer link: B (${P1.slice(0, 10)}): timed out`]);
    rig.poller.stop();
  });

  test("stop: the timer is cancelled, connections close, a dial in flight is closed when it lands; start resumes", async () => {
    const rig = makeRig([peer(P1, "B"), peer(P2, "C")]);
    const hung = deferredDial();
    rig.setDial((id) => (id === P2 ? hung.promise : rig.connect(id)));
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "P1 connected" });
    const list = rig.state(P1)!.agents;

    rig.poller.stop();
    expect(rig.poller.isRunning).toBe(false);
    expect(rig.clock.pending()).toBe(0);
    expect(rig.remote(P1).served[0]!.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.done, reason: "shutting down" });
    expect(rig.state(P1)).toMatchObject({ connected: false, agents: list });

    const late = await rig.connect(P2);
    hung.resolve(late);
    await waitFor(() => late.closeInfo() !== null, { message: "the late dial is closed" });
    expect(rig.state(P2)).toMatchObject({ connected: false, lastError: null, agents: null });

    rig.clock.advance(PEER_POLL_INTERVAL_MS * 4);
    await Bun.sleep(5);
    expect(rig.dials).toEqual([P1, P2]);

    rig.setDial(rig.connect);
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true && rig.state(P2)?.connected === true, { message: "resumed" });
    rig.poller.stop();
  });
});
