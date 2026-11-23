/**
 * The trusted link end to end through the REAL wrapper and addon: PeerServices
 * with their own temporary homes (the userHome() seam), each bound with
 * presetMinimal + RelayMode.disabled() + bindAddr 127.0.0.1:0 (no relays, no
 * discovery, no outside service), dialing each other's direct addresses. The
 * poll timer is sped up 50x so a tick is 100 ms.
 */

import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { resetUserHome, setUserHome } from "../home";
import { makeAgent, waitFor } from "../test-utils";
import { loadOrCreateIdentity } from "./identity";
import { loadIroh, type Iroh } from "./iroh";
import { listeningOrThrow } from "./test-pair-transport";
import { generatePairCode } from "./pair-code";
import { PEER_ALPN, PEER_CLOSE, encodePeerRequest, toRemoteAgents } from "./peer-link";
import type { RemoteSpawnDeps } from "./new-agent";
import { createMessageReceiver } from "./receive-message";
import { spawnCtx as paneProbe } from "../tmux-poller";
import { readOutbox } from "../outbox";
import { setSendSpawnRunner, resetSendSpawnRunner } from "../ib-commands";
import { makeSpawnResult } from "../test-utils";
import { PeerService } from "./service";
import { addPeer, readPeers, removePeer, shortPeerId } from "./store";

const ALLOWED_KEYS = ["agentType", "id", "manager", "nickname", "repoName", "repoPath", "repoRegistryName", "state"];

const homes: string[] = [];
const services: PeerService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  resetUserHome();
  resetSendSpawnRunner();
  paneProbe.reset();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/**
 * userHome() is one global, and every side runs in this process, so every
 * call that reads it runs under a lock with its side's home set.
 */
let homeChain: Promise<unknown> = Promise.resolve();
function inHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const run = homeChain.then(async () => {
    setUserHome(home);
    try {
      return await fn();
    } finally {
      resetUserHome();
    }
  });
  homeChain = run.catch(() => {});
  return run;
}

/** A local agent with fields that must never cross the wire. */
function localAgent(id: string, meta: Partial<Agent["meta"]> = {}): Agent {
  const agent = makeAgent({ id, repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running" });
  Object.assign(agent.meta, { prompt: "SECRET PROMPT", summary: "SECRET SUMMARY", agentType: "worker", ...meta });
  return agent;
}

interface Side {
  service: PeerService;
  home: string;
  id: string;
  logs: string[];
  /** How many times the trusted ALPN asked this side for its agents. */
  snapshots: () => number;
}

/** Direct addresses by endpoint id, so a dial by id can reach another loopback endpoint. */
function makeNetwork(iroh: Iroh) {
  const addresses = new Map<string, string[]>();
  async function makeSide(label: string, agents: Agent[], remoteSpawn?: RemoteSpawnDeps): Promise<Side> {
    const home = await mkdtemp(join(tmpdir(), `ib-peer-link-real-${label}-`));
    homes.push(home);
    const id = (await inHome(home, loadOrCreateIdentity)).id;
    const logs: string[] = [];
    let snapshots = 0;
    const receive = createMessageReceiver(line => logs.push(line), () => {});

    const service = new PeerService({
      remoteStartDenial: null,
      remoteSpawn,
      receiveMessage: (header, peerId) => inHome(home, () =>
        receive(header, peerId, async () => (await readPeers()).find(p => p.id === peerId)?.name ?? null)),

      captureCoordinator: async () => ({ state: "running", text: label + " coordinator" }),
      acquireLock: async () => ({ acquired: true }),
      releaseLock: async () => true,
      loadIdentity: () => inHome(home, loadOrCreateIdentity),
      bindEndpoint: async (secretKey, alpns) => {
        const ep = await iroh.Endpoint.bind({ secretKey, alpns, preset: { kind: "local", bindAddr: "127.0.0.1:0" } });
        addresses.set(ep.id().toString(), ep.directAddresses());
        return {
          acceptNext: () => ep.acceptNext(),
          connect: async (peerId, alpn) => {
            const addrs = addresses.get(peerId);
            if (!addrs) throw new Error(`${shortPeerId(peerId)} is not bound yet`);
            return ep.connect(peerId, alpn, addrs);
          },
          close: () => ep.close(),
        };
      },
      readPeers: () => inHome(home, readPeers),
      addPeer: (peer) => inHome(home, () => addPeer(peer)),
      generateCode: () => generatePairCode(),
      now: () => Date.now(),
      // 50x faster: a 5 s poll tick is 100 ms.
      setTimer: (ms, fn) => {
        const timer = setTimeout(fn, Math.max(1, Math.round(ms / 50)));
        return () => clearTimeout(timer);
      },
      log: (line) => logs.push(line),
      snapshot: () => {
        snapshots++;
        return { coordinator: null, repos: [{ registryName: "app", displayName: "app" }], agents: toRemoteAgents(agents) };
      },
    });
    services.push(service);
    return { service, home, id, logs, snapshots: () => snapshots };
  }
  return { addresses, makeSide };
}

/** Each side lists the other in its peers.json. */
async function pairBoth(a: Side, b: Side): Promise<void> {
  await inHome(a.home, () => addPeer({ id: b.id, name: "B" }));
  await inHome(b.home, () => addPeer({ id: a.id, name: "A" }));
}

async function bootPair(a: Side, b: Side): Promise<void> {
  await Promise.all([a.service.bootIfPaired(), b.service.bootIfPaired()]);
  expect(listeningOrThrow(a.service)).toBe(true);
  expect(listeningOrThrow(b.service)).toBe(true);
}

const link = (side: Side) => side.service.view().links[0];

test("each side binds at boot and its poller fetches the other's snapshot, with exactly the allowed fields", async () => {
  const net = makeNetwork(await loadIroh());
  const aAgents = [localAgent("agent-a1"), localAgent("agent-sys", { agentType: SYSTEM_COORDINATOR_TYPE })];
  const bAgents = [localAgent("agent-b1", { nickname: "builder" }), localAgent("agent-b2", { manager: "agent-b1" })];
  const a = await net.makeSide("a", aAgents);
  const b = await net.makeSide("b", bAgents);
  await pairBoth(a, b);

  await bootPair(a, b);
  expect(a.service.view().status).toEqual({ kind: "listening" });
  expect(b.service.view().status).toEqual({ kind: "listening" });
  await waitFor(() => link(a)?.connected === true && link(b)?.connected === true, { message: "both polled", timeoutMs: 10_000 });

  const seenByA = link(a)!.agents!;
  expect(seenByA).toEqual(toRemoteAgents(bAgents));
  expect(seenByA).toEqual([
    { id: "agent-b1", nickname: "builder", repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: null },
    { id: "agent-b2", nickname: null, repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: "agent-b1" },
  ]);
  for (const entry of seenByA) expect(Object.keys(entry).sort()).toEqual(ALLOWED_KEYS);
  // B sees A's agents without A's system coordinator.
  expect(link(b)!.agents!.map((agent) => agent.id)).toEqual(["agent-a1"]);
  expect(JSON.stringify([seenByA, link(b)!.agents])).not.toContain("SECRET");
  expect([...a.logs, ...b.logs].filter((line) => line.includes("not a peer") || line.includes("failed"))).toEqual([]);
});

test("an id not in peers.json is closed on the peer ALPN before anything is read, and the handler never runs", async () => {
  const iroh = await loadIroh();
  const net = makeNetwork(iroh);
  const b = await net.makeSide("b", [localAgent("agent-b1")]);
  // B lists nobody, so it binds when its dialog opens rather than at boot.
  b.service.openDialog();
  await waitFor(() => listeningOrThrow(b.service), { message: "B listening", timeoutMs: 10_000 });

  const stranger = await iroh.Endpoint.bind({
    secretKey: iroh.SecretKey.generate().toBytes(),
    alpns: [],
    preset: { kind: "local", bindAddr: "127.0.0.1:0" },
  });
  try {
    const conn = await stranger.connect(b.id, PEER_ALPN, net.addresses.get(b.id));
    const stream = await conn.openBi();
    const reply = await (async () => {
      await stream.writeAll(encodePeerRequest("agents"));
      await stream.finish();
      return stream.readToEnd(1_048_576);
    })().catch((err: Error) => err);
    // Closing before reading can surface as either a stream error or an empty reply.
    if (!(reply instanceof Error)) expect(reply).toHaveLength(0);
    await waitFor(() => conn.closeInfo() !== null, { message: "stranger closed" });
    expect(conn.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.notPeer, reason: "not a peer" });
    expect(b.snapshots()).toBe(0);
    const strangerId = stranger.id().toString();
    expect(b.logs).toContain(`peer link: closed a connection from ${shortPeerId(strangerId)}: not a peer`);
  } finally {
    await stranger.close();
  }
});

test("after the responder removes a peer, the next request on the existing connection is refused", async () => {
  const net = makeNetwork(await loadIroh());
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", [localAgent("agent-b1")]);
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => link(a)?.connected === true, { message: "A polls B", timeoutMs: 10_000 });
  const list = link(a)!.agents;
  expect(b.logs).toContain(`peer link: ${shortPeerId(a.id)} connected`);

  // `ib peer remove` on B.
  await inHome(b.home, async () => {
    expect((await removePeer(a.id)).ok).toBe(true);
  });
  await waitFor(() => link(a)?.lastError === "not a peer", { message: "A refused", timeoutMs: 10_000 });
  expect(link(a)).toMatchObject({ connected: false, agents: list });
  // Refused by the per-request check on the live connection, not at a new accept.
  expect(b.logs).toContain(`peer link: refused a request from ${shortPeerId(a.id)}: no longer a peer; closing`);
});

test("a trusted loopback new-agent stream starts the stubbed agent and returns its id", async () => {
  const net = makeNetwork(await loadIroh());
  const newAgent = mock<RemoteSpawnDeps["newAgent"]>(async () => ({ ok: true, stdout: "worker-23\n", stderr: "", exitCode: 0 }));
  const type = "receiver-fixture-only";
  const listSpawnableTypes = mock(() => [type]);
  const notice = mock((_line: string) => {});
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", [], { listSpawnableTypes, listRepos: async () => [{ name: "App", path: "/b/app" }], newAgent, notice });
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => link(a)?.connected === true, { message: "A polls B", timeoutMs: 10_000 });
  const prompt = "read this ".repeat(800);
  expect(await a.service.startRemoteAgent(b.id, { repo: "app", type, prompt })).toBe("worker-23");
  expect(listSpawnableTypes.mock.calls).toEqual([[]]);
  expect(newAgent.mock.calls).toEqual([["/b/app", prompt, { type, name: undefined }]]);
  expect(b.logs).toContain("A started agent worker-23 in App");
  expect(notice.mock.calls).toEqual([["A started agent worker-23 in App"]]);
});

test("reads the paired machine's system coordinator over a real loopback connection", async () => {
  const net = makeNetwork(await loadIroh());
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", []);
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => link(a)?.connected === true, { message: "A polls B", timeoutMs: 10_000 });
  expect(await a.service.fetchCoordinatorPane(b.id)).toEqual({ state: "running", text: "b coordinator" });
  expect(b.logs.some(line => line.includes("read the system coordinator pane"))).toBe(true);
});

test("agents send text in both directions over real paired endpoints", async () => {
  const net = makeNetwork(await loadIroh());
  const a = await net.makeSide("a", [localAgent("alice")]);
  const b = await net.makeSide("b", [localAgent("bob")]);
  setSendSpawnRunner(() => makeSpawnResult());
  paneProbe.set(() => makeSpawnResult(0, "0"));
  for (const [side, agent] of [[a, "alice"], [b, "bob"]] as const) {
    const repo = join(side.home, "app");
    const dir = join(repo, ".itsybitsy", "agents", agent);
    await Bun.write(join(side.home, ".itsybitsy", "repos.json"), JSON.stringify({ version: 1, repos: [{ path: repo, name: "app" }] }));
    await Bun.write(join(dir, "meta.json"), JSON.stringify(localAgent(agent, { tmux_session: "ib-" + agent }).meta));
    await Bun.write(join(dir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
  }
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => !!link(a)?.connected && !!link(b)?.connected, { message: "both connected", timeoutMs: 10_000 });
  for (const [sender, recipient, from, to] of [[a, b, "A/app/alice", "bob"], [b, a, "B/app/bob", "alice"]] as const) {
    const id = crypto.randomUUID();
    expect(await sender.service.sendRemoteMessage(recipient.id, {
      op: "send", from: { kind: "agent", id: from }, id, target: { kind: "agent", repo: "app", agent: to }, message: "hi", files: [],
    }, "handoff")).toBe(id);
    expect(await readOutbox(join(recipient.home, ".itsybitsy", "agents", to))).toMatchObject([{ message: "hi", fromAgent: from }]);
  }
});
