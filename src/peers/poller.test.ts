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
import { PEER_POLL_INTERVAL_MS, PEER_REQUEST_TIMEOUT_MS, PeerPoller } from "./poller";
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
  return { id, nickname: null, repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state, agentType: "worker", manager: null };
}

/** The other install: whether it lists us, what it reports, and the connections it has served. */
interface Remote {
  allowed: boolean;
  repos: { registryName: string; displayName: string }[];
  agents: RemoteAgent[];
  requests: number;
  /** The far (responder) end of each connection dialed to it. */
  served: MemoryConnection[];
  /** Its event loop is wedged: requests are accepted but never answered. */
  stalled: boolean;
  /** Dials that arrived while an earlier connection from us was still open. */
  overlaps: number;
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
      r = { allowed: true, repos: [{ registryName: "app", displayName: "App" }], agents: [remoteAgent(`agent-of-${id.slice(0, 4)}`)], requests: 0, served: [], stalled: false, overlaps: 0 };
      remotes.set(id, r);
    }
    return r;
  };

  /** A working dial: an in-memory link served by the real responder. */
  const connect = async (id: string): Promise<PairConnection> => {
    const r = remote(id);
    if (r.served.some((c) => c.closeInfo() === null)) r.overlaps++;
    const link = createMemoryLink(SELF, id);
    r.served.push(link.b);
    void serveTrustedConnection(link.b, {
      peerName: async () => {
        // A wedged remote: the per-request check never returns, so no reply is sent.
        if (r.stalled) await new Promise(() => {});
        return r.allowed ? "paired" : null;
      },
      snapshot: () => {
        r.requests++;
        return { repos: r.repos, agents: r.agents };
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
      repos: rig.remote(P1).repos,
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

  test("a peer removed and paired again while its dial hangs still gets no second dial; the late dial is closed", async () => {
    const rig = makeRig([peer(P1, "B")]);
    const hung = deferredDial();
    rig.setDial((id) => (rig.dials.length === 1 ? hung.promise : rig.connect(id)));
    rig.poller.start();
    await waitFor(() => rig.dials.length === 1, { message: "first dial" });
    rig.setPeers([]);
    rig.tick();
    await waitFor(() => rig.state(P1) === undefined, { message: "removed" });
    rig.setPeers([peer(P1, "B again")]);
    rig.tick();
    await waitFor(() => rig.state(P1)?.name === "B again", { message: "re-added" });
    rig.tick();
    await Bun.sleep(10);
    expect(rig.dials).toEqual([P1]);

    const late = await rig.connect(P1);
    hung.resolve(late);
    await waitFor(() => late.closeInfo() !== null, { message: "the old dial is closed when it lands" });
    rig.tick();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "the new link dials afresh" });
    expect(rig.dials).toEqual([P1, P1]);
    rig.poller.stop();
  });

  test("a dial started before stop() is not adopted after a restart, and blocks a second dial until it settles", async () => {
    const rig = makeRig([peer(P1, "B")]);
    const hung = deferredDial();
    rig.setDial((id) => (rig.dials.length === 1 ? hung.promise : rig.connect(id)));
    rig.poller.start();
    await waitFor(() => rig.dials.length === 1, { message: "first dial" });
    rig.poller.stop();
    rig.poller.start();
    await Bun.sleep(10);
    expect(rig.dials).toEqual([P1]);

    const late = await rig.connect(P1);
    hung.resolve(late);
    await waitFor(() => late.closeInfo() !== null, { message: "the pre-stop dial is closed" });
    expect(rig.state(P1)?.connected).toBe(false);
    rig.tick();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "dialed afresh" });
    expect(rig.dials).toEqual([P1, P1]);
    rig.poller.stop();
  });

  test("a hung request is never doubled; after 15 s it times out, its connection is closed, and the next tick redials", async () => {
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
    // The dial lands 2 s after start, so the request's 15 s timeout falls
    // between ticks (at 17 s) rather than on one.
    const dial = deferredDial();
    rig.setDial(() => dial.promise);
    rig.poller.start();
    await waitFor(() => rig.dials.length === 1, { message: "dialing" });
    rig.clock.jump(2_000);
    dial.resolve(counting);
    await waitFor(() => streams === 1, { message: "first request sent" });
    for (const ms of [3_000, 5_000, 5_000]) {
      rig.clock.advance(ms); // ticks at 5, 10 and 15 s: the request is in flight, so P1 is skipped
      await Bun.sleep(5);
    }
    expect(streams).toBe(1);
    expect(rig.dials).toEqual([P1]);
    expect(rig.state(P1)?.lastError).toBeNull();
    expect(silent.a.closeInfo()).toBeNull();

    rig.setDial(rig.connect);
    expect(PEER_REQUEST_TIMEOUT_MS).toBe(15_000);
    rig.clock.advance(2_000); // t = 17 s: 15 s after the request started, between ticks
    await waitFor(() => rig.state(P1)?.lastError === "request timed out", { message: "timed out" });
    expect(rig.state(P1)?.connected).toBe(false);
    expect(silent.b.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.done, reason: "request timed out" });
    expect(streams).toBe(1);
    expect(rig.dials).toEqual([P1]);
    expect(rig.logs).toContain(`peer link: B (${P1.slice(0, 10)}): request timed out`);

    rig.clock.advance(3_000); // t = 20 s: the next tick redials
    await waitFor(() => rig.state(P1)?.connected === true, { message: "redialed" });
    expect(rig.dials).toEqual([P1, P1]);
    expect(rig.remote(P1).overlaps).toBe(0);
    rig.poller.stop();
  });

  test("a connected peer whose remote wedges: shown connected until its request times out, then redialed; the list stays", async () => {
    const rig = makeRig([peer(P1, "B")]);
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.connected === true, { message: "connected" });
    const list = rig.state(P1)!.agents;
    expect(rig.clock.pending()).toBe(1); // an answered request leaves only the tick timer armed

    rig.remote(P1).stalled = true;
    rig.tick(); // t = 5 s: this request hangs
    await Bun.sleep(5);
    rig.tick(); // 10 s
    rig.tick(); // 15 s
    await Bun.sleep(5);
    expect(rig.remote(P1).served.length).toBe(1);
    expect(rig.state(P1)?.connected).toBe(true);

    // t = 20 s: the timeout and a tick fall due together. Whichever order the
    // fake clock runs them in, there is exactly one redial and no overlap.
    rig.remote(P1).stalled = false;
    rig.tick();
    await waitFor(() => rig.state(P1)?.lastError === "request timed out" || rig.dials.length === 2, { message: "timed out" });
    expect(rig.remote(P1).served[0]!.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.done, reason: "request timed out" });
    rig.tick(); // 25 s
    await waitFor(() => rig.state(P1)?.connected === true, { message: "redialed" });
    expect(rig.dials).toEqual([P1, P1]);
    expect(rig.remote(P1).overlaps).toBe(0);
    expect(rig.state(P1)).toMatchObject({ connected: true, lastError: null, agents: list });
    expect(rig.logs).toContain(`peer link: B (${P1.slice(0, 10)}): request timed out`);
    rig.poller.stop();
  });

  test("a failed dial is retried on the next tick; a drop keeps the last list; the next tick redials", async () => {
    const rig = makeRig([peer(P1, "B")]);
    rig.setDial(async () => {
      throw new IrohError("Endpoint.connect", "timed out");
    });
    rig.poller.start();
    await waitFor(() => rig.state(P1)?.lastError !== null, { message: "first dial failed" });
    expect(rig.state(P1)).toEqual({ id: P1, name: "B", connected: false, lastOkAt: null, lastError: "timed out", repos: null, agents: null });

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
    expect(rig.state(P1)).toEqual({ id: P1, name: "B", connected: false, lastOkAt: okAt, lastError: "closed by the other side", repos: rig.remote(P1).repos, agents: firstList });

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
    const unchangedAgents = rig.state(P1)!.agents;
    rig.remote(P1).repos.push({ registryName: "empty", displayName: "Empty" });
    rig.tick();
    await waitFor(() => rig.changes() === afterConnect + 2, { message: "a repo-only change notifies" });
    expect(rig.state(P1)?.repos).toEqual(rig.remote(P1).repos);
    expect(rig.state(P1)?.agents).toEqual(unchangedAgents);
    rig.tick();
    await waitFor(() => rig.state(P1)?.lastOkAt === rig.clock.now(), { message: "identical reply processed" });
    expect(rig.changes()).toBe(afterConnect + 2);

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
