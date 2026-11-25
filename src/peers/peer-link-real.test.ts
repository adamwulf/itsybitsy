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
import { dirname, join } from "node:path";
import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { resetUserHome, setUserHome } from "../home";
import { makeAgent, waitFor } from "../test-utils";
import { loadOrCreateIdentity } from "./identity";
import { captureAgentDiff } from "./agent-diff";
import { loadIroh, type Iroh } from "./iroh";
import { listeningOrThrow } from "./test-pair-transport";
import { generatePairCode } from "./pair-code";
import { PEER_ALPN, PEER_CLOSE, encodePeerRequest, toRemoteAgents } from "./peer-link";
import { lifecycleFixture } from "./test-remote-lifecycle";
import type { RemoteLifecycleDeps } from "./remote-lifecycle";
import type { RemoteSpawnDeps } from "./new-agent";
import { captureAgentPane, readAgentPromptText } from "./agent-pane";
import { createMessageReceiver } from "./receive-message";
import { createAttachmentReceiver } from "./receive-attachments";
import { captureLiveDisplayPane, spawnCtx as paneProbe } from "../tmux-poller";
import { readOutbox } from "../outbox";
import { setSendSpawnRunner, resetSendSpawnRunner } from "../ib-commands";
import { makeSpawnResult } from "../test-utils";
import { PeerService } from "./service";
import { addPeer, readPeers, removePeer, shortPeerId } from "./store";

const ALLOWED_KEYS = ["agentType", "createdEpoch", "id", "manager", "nickname", "repoName", "repoPath", "repoRegistryName", "state"];

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
  async function makeSide(label: string, agents: Agent[], remoteSpawn?: RemoteSpawnDeps, remoteLifecycle?: RemoteLifecycleDeps): Promise<Side> {
    const home = await mkdtemp(join(tmpdir(), `ib-peer-link-real-${label}-`));
    homes.push(home);
    const id = (await inHome(home, loadOrCreateIdentity)).id;
    const logs: string[] = [];
    let snapshots = 0;
    const receive = createMessageReceiver(line => logs.push(line), () => {}, Date.now, 4096, createAttachmentReceiver({ tempDir: home, hasFreeSpace: async () => true }));

    const service = new PeerService({
      remoteStartDenial: null,
      remoteSpawn, remoteLifecycle,
      receiveMessage: (header, peerId, _peerName, body, options) => inHome(home, () =>
        receive(header, peerId, async () => (await readPeers()).find(p => p.id === peerId)?.name ?? null, body, options)),

      captureAgent: (repo, id, lines) => captureAgentPane(agents, repo, id, lines),
      captureCoordinator: async () => ({ state: "running", text: label + " coordinator" }),
      captureDiff: (repo, id) => captureAgentDiff(agents, repo, id),
      readPrompt: (repo, id) => readAgentPromptText(agents, repo, id),
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
        return { coordinator: null, repos: [{ registryName: "app", displayName: "app", remoteUrl: null, relPath: null }], agents: toRemoteAgents(agents), questions: [] };
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
  const bAgents = [localAgent("agent-b1", { nickname: "builder", created_epoch: 1_700_000_000 }), localAgent("agent-b2", { manager: "agent-b1", created_epoch: 1_700_000_060 })];
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
    { id: "agent-b1", nickname: "builder", repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: null, createdEpoch: 1_700_000_000 },
    { id: "agent-b2", nickname: null, repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: "agent-b1", createdEpoch: 1_700_000_060 },
  ]);
  for (const entry of seenByA) expect(Object.keys(entry).sort()).toEqual(ALLOWED_KEYS);
  // B sees A's agents without A's system coordinator.
  expect(link(b)!.agents!.map((agent) => agent.id)).toEqual(["agent-a1"]);
  expect(JSON.stringify([seenByA, link(b)!.agents])).not.toContain("SECRET");
  expect([...a.logs, ...b.logs].filter((line) => line.includes("not a peer") || line.includes("failed"))).toEqual([]);
  // Each side logs the path of the connection it dialed and of the one it accepted: direct on loopback.
  for (const [side, other, otherName] of [[a, b, "B"], [b, a, "A"]] as const) {
    for (const how of ["dialed", "accepted"]) {
      // The accepting side can have open paths and none selected.
      const line = new RegExp(`^peer link: ${how} ${otherName} \\(${shortPeerId(other.id)}\\): direct to \\S+:\\d+, rtt \\d+ ms( \\(none selected, \\d+ open\\))?$`);
      expect(side.logs).toContainEqual(expect.stringMatching(line));
    }
  }
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

test("a trusted loopback new-agent with files delivers them, says they arrived, and starts the agent with this machine's copy", async () => {
  const net = makeNetwork(await loadIroh());
  const received = await mkdtemp(join(tmpdir(), "ib-peer-link-real-received-"));
  homes.push(received);
  const newAgent = mock<RemoteSpawnDeps["newAgent"]>(async () => ({ ok: true, stdout: "worker-24\n", stderr: "", exitCode: 0 }));
  const type = "receiver-fixture-only";
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", [], {
    listSpawnableTypes: () => [type], listRepos: async () => [{ name: "App", path: "/b/app" }], newAgent, notice: () => {},
    attachments: createAttachmentReceiver({ tempDir: received, hasFreeSpace: async () => true }),
  });
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => link(a)?.connected === true, { message: "A polls B", timeoutMs: 10_000 });
  // Several body chunks.
  const content = "0123456789".repeat(20_000);
  const filesDir = join(a.home, "staged");
  await Bun.write(join(filesDir, "0"), content);
  const files = [{ name: "one.txt", spellings: ["./one.txt"], size: content.length, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") }];
  expect(await a.service.startRemoteAgent(b.id, { repo: "app", type, prompt: "read ./one.txt", files }, { filesDir })).toBe("worker-24");
  expect(newAgent.mock.calls).toHaveLength(1);
  const [repoPath, prompt] = newAgent.mock.calls[0]!;
  expect(repoPath).toBe("/b/app");
  const copy = prompt.split("\n").at(-1)!.split(" → ")[1]!;
  expect(copy).toStartWith(received);
  expect(prompt).toStartWith(`read ${copy}\n`);
  expect(await Bun.file(copy).text()).toBe(content);
  const ended = (label: string) => new RegExp(`^peer link: transfer ok: new-agent ${label} \\(\\S+\\): ${content.length} of ${content.length} bytes in `);
  expect(a.logs).toContainEqual(expect.stringMatching(ended("to B")));
  await waitFor(() => b.logs.some(line => ended("from A").test(line)), { message: "receipt ended" });
});

test("a trusted loopback peer retires and rehires an archived agent on the other machine", async () => {
  const net = makeNetwork(await loadIroh());
  const repo = await mkdtemp(join(tmpdir(), "ib-peer-real-lifecycle-"));
  homes.push(repo);
  const deps = await lifecycleFixture(repo);
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", [], undefined, deps);
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => !!link(a)?.connected);
  await a.service.runRemoteLifecycle(b.id, { action: "retire", repo: "app", id: "worker" });
  await a.service.runRemoteLifecycle(b.id, { action: "rehire", id: "worker" });
  expect(deps.retireAgent.mock.calls[0]?.[0]).toMatchObject({ repoPath: repo, id: "worker" });
  expect(deps.rehireAgent.mock.calls).toEqual([["worker", { repoPath: repo }]]);
  expect(deps.notice.mock.calls).toEqual([["A retired worker in App", "info"], ["A rehired worker in App", "info"]]);
});

test("reads the paired machine's system coordinator over a real loopback connection", async () => {
  const net = makeNetwork(await loadIroh());
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", []);
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => link(a)?.connected === true, { message: "A polls B", timeoutMs: 10_000 });
  expect(await a.service.fetchPane(b.id, { op: "coordinator-pane" }, 200)).toEqual({ state: "running", text: "b coordinator" });
  expect(b.logs.some(line => line.includes("read the system coordinator pane"))).toBe(true);
});

test.skipIf(!Bun.which("tmux"))("reads a registered agent's tmux history over loopback", async () => {
  const net = makeNetwork(await loadIroh());
  const target = { op: "agent-pane", repo: "app", id: "worker" } as const;
  const a = await net.makeSide("a", [localAgent("worker", { tmux_session: "a-worker" })]);
  const b = await net.makeSide("b", [localAgent("worker", { tmux_session: "b-worker" })]);
  const dir = await mkdtemp("/tmp/ib-agent-pane-");
  paneProbe.set((cmd, opts) => {
    const proc = Bun.spawn(["tmux", "-f", "/dev/null", "-S", join(dir, "sock"), ...cmd.slice(1)], opts);
    return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: () => proc.kill("SIGKILL") };
  });
  try {
    const session = await paneProbe.run(["tmux", "new-session", "-d", "-s", "b-worker",
      `awk 'BEGIN { for (i=1; i<=600; i++) print "history-", i }'; exec sleep 60`]);
    expect(session.exitCode).toBe(0);
    await waitFor(async () => (await captureLiveDisplayPane("b-worker", 650))?.includes("history- 600") === true);
    await pairBoth(a, b);
    await bootPair(a, b);
    await waitFor(() => link(a)?.connected === true);
    const latest = await a.service.fetchPane(b.id, target, 200);
    expect(latest.text).toContain("history- 600");
    expect(latest.text).not.toMatch(/history- 10\b/);
    const history = await a.service.fetchPane(b.id, target, 650);
    expect(history.state).toBe("running");
    expect(history.text).toMatch(/history- 10\b/);
  } finally {
    await paneProbe.run(["tmux", "kill-server"]);
    paneProbe.reset();
    await rm(dir, { recursive: true, force: true });
  }
});

test("opens an agent diff larger than the JSON reply limit over a paired loopback connection", async () => {
  const net = makeNetwork(await loadIroh());
  const agent = localAgent("worker", { worktree: false });
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", [agent]);
  agent.repoPath = b.home;
  await Bun.$`git init -qb main`.cwd(b.home).quiet();
  await Bun.write(join(b.home, "tracked"), "before\n");
  await Bun.$`git add tracked`.cwd(b.home).quiet();
  await Bun.$`git -c user.name=test -c user.email=test@example.org commit -qm base`.cwd(b.home).quiet();
  const base = (await Bun.$`git rev-parse HEAD`.cwd(b.home).text()).trim();
  await Bun.write(join(b.home, "tracked"), "working tree\n".repeat(90_000));
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => !!link(a)?.connected);
  const reply = await a.service.fetchAgentDiff(b.id, "app", "worker");
  expect(reply.base).toBe(base);
  expect(reply.patch.length).toBeGreaterThan(1_048_576);
  expect(reply.patch.equals((await Bun.$`git diff --binary ${base}`.cwd(b.home).quiet()).stdout)).toBe(true);
  expect(await a.service.fetchPane(b.id, { op: "coordinator-pane" }, 200)).toMatchObject({ text: "b coordinator" });
});

test("reads a registered agent's prompt.txt over a paired loopback connection", async () => {
  const net = makeNetwork(await loadIroh());
  const agent = localAgent("worker");
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", [agent]);
  agent.storageDir = join(b.home, "worker");
  await Bun.write(join(agent.storageDir, "prompt.txt"), "Build it\nthen test it");
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => !!link(a)?.connected);
  expect(await a.service.fetchAgentPrompt(b.id, "app", "worker")).toBe("Build it\nthen test it");
  await expect(a.service.fetchAgentPrompt(b.id, "app", "missing")).rejects.toThrow("Agent not found");
});

test("agents send text and two files in both directions over real paired endpoints", async () => {
  const net = makeNetwork(await loadIroh());
  const a = await net.makeSide("a", [localAgent("alice")]);
  const b = await net.makeSide("b", [localAgent("bob")]);
  setSendSpawnRunner(() => makeSpawnResult());
  paneProbe.set(() => makeSpawnResult(0, "0"));
  for (const [side, agent] of [[a, "alice"], [b, "bob"]] as const) {
    const repo = join(side.home, "app");
    const dir = join(repo, ".itsybitsy", "agents", agent);
    await Bun.write(join(side.home, ".itsybitsy/machine-name"), agent);
    await Bun.write(join(side.home, ".itsybitsy", "repos.json"), JSON.stringify({ version: 1, repos: [{ path: repo, name: "app" }] }));
    await Bun.write(join(dir, "meta.json"), JSON.stringify(localAgent(agent, { tmux_session: "ib-" + agent }).meta));
    await Bun.write(join(dir, "meta.transient.json"), JSON.stringify({
      watchdog_pid: process.pid, updated_at_ms: Date.now(), tmux_compacting: false, tmux_rate_limited: false, has_background_tasks: false,
    }));
  }
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => !!link(a)?.connected && !!link(b)?.connected, { message: "both connected", timeoutMs: 10_000 });
  for (const [sender, recipient, from, to, senderName, recipientName] of [[a, b, "A/app/alice", "bob", "A", "B"], [b, a, "B/app/bob", "alice", "B", "A"]] as const) {
    const id = crypto.randomUUID();
    const filesDir = join(sender.home, "staged");
    const files = [];
    for (const [index, name] of ["one.txt", "two.txt"].entries()) {
      const content = from + "/" + name;
      await Bun.write(join(filesDir, String(index)), content);
      files.push({ name, spellings: ["./" + name], size: content.length, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") });
    }
    expect(await sender.service.sendRemoteMessage(recipient.id, {
      op: "send", from: { kind: "agent", id: from }, id, target: { kind: "agent", repo: "app", agent: to }, message: "read ./one.txt ./two.txt", files,
    }, "handoff", { filesDir })).toBe(id);
    const queued = await readOutbox(join(recipient.home, ".itsybitsy", "agents", to));
    expect(queued).toMatchObject([{ fromAgent: from, noPassthrough: true }]);
    const [body, , heading, first, second] = queued[0]!.message.split("\n");
    const paths = [first!, second!].map(line => line.split(" → ")[1]!);
    const root = dirname(dirname(paths[0]!));
    expect(root).toStartWith(join(recipient.home, "itsybitsy-attachments-"));
    try {
      expect(body).toBe("read " + paths.join(" "));
      expect(heading).toBe("Attachments copied to this machine:");
      for (const [index, path] of paths.entries()) {
        expect(path).toBe(join(root, String(index), files[index]!.name));
        expect(await Bun.file(path).text()).toBe(from + "/" + files[index]!.name);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
    // One start and one end line on each side, nothing per chunk.
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    const ended = (label: string) => new RegExp(`^peer link: transfer ok: ${label}: ${bytes} of ${bytes} bytes in \\d+\\.\\d s, \\d+\\.\\d KB/s$`);
    const outbound = `send to ${recipientName} \\(${shortPeerId(recipient.id)}\\)`;
    const inbound = `send from ${senderName} \\(${shortPeerId(sender.id)}\\)`;
    expect(sender.logs.filter(line => line.includes(`send to ${recipientName} `))).toEqual([
      `peer link: transfer started: send to ${recipientName} (${shortPeerId(recipient.id)}): 2 files, ${bytes} bytes`,
      expect.stringMatching(ended(outbound)),
    ]);
    await waitFor(() => recipient.logs.some(line => ended(inbound).test(line)), { message: "receipt ended" });
    expect(recipient.logs.filter(line => line.includes(`send from ${senderName} `))).toEqual([
      `peer link: transfer started: send from ${senderName} (${shortPeerId(sender.id)}): 2 files, ${bytes} bytes`,
      expect.stringMatching(ended(inbound)),
    ]);
  }
});

test("a refusal preserves the shared connection for the next exchange", async () => {
  const net = makeNetwork(await loadIroh());
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", []);
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => !!link(a)?.connected);
  const connection = a.service["poller"].connectedConnection(b.id)!;
  const filesDir = join(a.home, "refused");
  await Bun.write(join(filesDir, "0"), "a");
  const file = { name: "one", size: 1, sha256: new Bun.CryptoHasher("sha256").update("a").digest("hex"), spellings: ["./one"] };
  await expect(a.service.sendRemoteMessage(b.id, { op: "send", id: crypto.randomUUID(), from: { kind: "user" },
    target: { kind: "agent", agent: "missing" }, message: "hello", files: [file] }, "handoff", { filesDir })).rejects.toThrow("not found");
  expect(await a.service.fetchPane(b.id, { op: "coordinator-pane" }, 200)).toMatchObject({ text: "b coordinator" });
  expect(a.service["poller"].connectedConnection(b.id)).toBe(connection);
});

test("an agents poll during header saturation receives busy and stays connected", async () => {
  const net = makeNetwork(await loadIroh());
  const a = await net.makeSide("a", []);
  const b = await net.makeSide("b", []);
  await pairBoth(a, b);
  await bootPair(a, b);
  await waitFor(() => !!link(a)?.connected);
  const connection = a.service["poller"].connectedConnection(b.id)!;
  const streams = await Promise.all(Array.from({ length: 8 }, () => connection.openBi()));
  try {
    for (const stream of streams) await stream.writeAll(Uint8Array.of(0));
    await waitFor(() => link(a)?.lastError === "busy, try again");
    expect(link(a)?.connected).toBe(true);
    expect(a.service["poller"].connectedConnection(b.id)).toBe(connection);
  } finally { await Promise.all(streams.map(s => s.cancel())); }
});
