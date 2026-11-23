/**
 * The trusted link's protocol (src/peers/peer-link.ts) over the in-memory
 * link: no addon, no network. The real-endpoint version of the main cases is
 * peer-link-real.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUserHome, resetUserHome } from "../home";
import { acceptRemoteAgent, type RemoteSpawnDeps } from "./new-agent";
import { listSpawnableTypeNamesSync } from "../agent-types";
import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { makeAgent, waitFor } from "../test-utils";
import { irohAddonLoaderCtx } from "./iroh";
import {
  PEER_CLOSE,
  PEER_MAX_REPLY_BYTES,
  NEW_AGENT_MAX_REQUEST_BYTES,
  requestNewAgent,
  requestCoordinatorPane,
  PEER_MAX_REQUEST_BYTES,
  PeerErrorReply,
  PeerProtocolError,
  decodeAgentsReply,
  encodeAgentsReply,
  requestAgents,
  serveTrustedConnection,
  toRemoteAgents,
  peerSnapshot,
  type PeerSnapshot,
  type PeerResponderDeps,
  type RemoteAgent,
} from "./peer-link";
import { createFakeClock, createMemoryLink, type MemoryConnection } from "./test-pair-transport";

const ID_A = "a1".repeat(32);
const ID_B = "b2".repeat(32);
const ALLOWED_KEYS = ["agentType", "id", "manager", "nickname", "repoName", "repoPath", "repoRegistryName", "state"];

beforeEach(() => {
  irohAddonLoaderCtx.set(async () => {
    throw new Error("a peer-link test loaded the iroh addon");
  });
});
afterEach(() => irohAddonLoaderCtx.reset());

/** An agent with every field the reply must leave out set to something recognizable. */
function fullAgent(id: string, extra: Partial<Agent["meta"]> = {}): Agent {
  const agent = makeAgent({ id, repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running" });
  Object.assign(agent.meta, {
    prompt: "SECRET PROMPT",
    summary: "secret summary",
    session_id: "secret-session",
    tmux_session: "secret-tmux",
    claude_pid: "4242",
    agentType: "worker",
    manager: "agent-mgr",
    nickname: "builder",
    ...extra,
  });
  return agent;
}

const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

/** B serves the trusted ALPN on its end of a memory link; returns A's end and B's counters. */
function serve(options: { readerId?: string; captureCoordinator?: PeerResponderDeps["captureCoordinator"]; paneReaders?: Set<string>; peers?: Set<string>; snapshot?: () => PeerSnapshot; startAgent?: PeerResponderDeps["startAgent"] } = {}) {
  const readerId = options.readerId ?? ID_A;
  const link = createMemoryLink(readerId, ID_B);
  const peers = options.peers ?? new Set([readerId]);
  const logs: string[] = [];
  let snapshots = 0;
  let checks = 0;
  const clock = createFakeClock();
  const done = serveTrustedConnection(link.b, {
    setTimer: clock.setTimer,
    startAgent: options.startAgent,
    captureCoordinator: options.captureCoordinator,
    paneReaders: options.paneReaders ?? new Set(),
    peerName: async (id) => {
      checks++;
      return peers.has(id) ? "Alice" : null;
    },
    snapshot: () => {
      snapshots++;
      return options.snapshot ? options.snapshot() : { coordinator: null, repos: [], agents: [] };
    },
    log: (line) => logs.push(line),
  });
  return {
    clock,
    a: link.a,
    b: link.b,
    peers,
    logs,
    done,
    snapshots: () => snapshots,
    checks: () => checks,
  };
}

/** Send raw bytes as one request on A's end; the reply bytes, or the error. */
async function rawRequest(conn: MemoryConnection, bytes: Uint8Array): Promise<Uint8Array | Error> {
  try {
    const stream = await conn.openBi();
    await stream.writeAll(bytes);
    await stream.finish();
    return await stream.readToEnd(PEER_MAX_REPLY_BYTES);
  } catch (err) {
    return err as Error;
  }
}

const decodeText = (bytes: Uint8Array | Error) => JSON.parse(new TextDecoder().decode(bytes as Uint8Array));

describe("toRemoteAgents", () => {
  test("keeps exactly the eight allowed fields and leaves out the system coordinator", () => {
    const worker = fullAgent("agent-1");
    // A nicknamed repo: shown as "library", keyed by its registry name "lib".
    const bare = makeAgent({ id: "agent-2", repoName: "library", repoRegistryName: "lib", repoPath: "/repos/lib", state: "waiting" });
    const system = fullAgent("agent-sys", { agentType: SYSTEM_COORDINATOR_TYPE });
    const out = toRemoteAgents([worker, system, bare]);
    expect(out).toEqual([
      { id: "agent-1", nickname: "builder", repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: "agent-mgr" },
      { id: "agent-2", nickname: null, repoName: "library", repoRegistryName: "lib", repoPath: "/repos/lib", state: "waiting", agentType: null, manager: null },
    ]);
    for (const entry of out) expect(Object.keys(entry).sort()).toEqual(ALLOWED_KEYS);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});

describe("decodeAgentsReply", () => {
  test("rebuilds each entry from the allowed fields only, and strips control characters", () => {
    const { repos, agents } = decodeAgentsReply(
      encode({
        op: "agents", coordinator: { state: "running" },
        repos: [{ registryName: "ap\u202ep", displayName: "App\n", path: "/private" }],
        agents: [{ id: "agent-1", repoName: "app\x1b[31m", repoRegistryName: "app\x1b[31m", repoPath: "/r", state: "running", prompt: "leak", extra: { x: 1 } }],
      }),
    );
    expect(repos).toEqual([{ registryName: "app", displayName: "App" }]);
    expect(agents).toEqual([{ id: "agent-1", nickname: null, repoName: "app[31m", repoRegistryName: "app[31m", repoPath: "/r", state: "running", agentType: null, manager: null }]);
    expect(Object.keys(agents[0]!).sort()).toEqual(ALLOWED_KEYS);
  });

  test("strips format characters too: bidi overrides and isolates, zero-width marks, the BOM", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, U+2066 LEFT-TO-RIGHT ISOLATE, U+200B ZERO WIDTH SPACE,
    // U+200D ZERO WIDTH JOINER, U+FEFF BOM, U+00AD SOFT HYPHEN: all \p{Cf}.
    const cf = "‮⁦​‍﻿­";
    const { agents: [agent] } = decodeAgentsReply(
      encode({
        op: "agents", coordinator: { state: "running" },
        repos: [{ registryName: "ap\u202ep", displayName: "App\n", path: "/private" }],
        agents: [{ id: `agent${cf}-1`, nickname: `nick${cf}`, repoName: `app${cf}`, repoRegistryName: `app${cf}`, repoPath: `/r${cf}`, state: `run${cf}ning`, agentType: `w${cf}`, manager: `m${cf}` }],
      }),
    );
    expect(agent).toEqual({ id: "agent-1", nickname: "nick", repoName: "app", repoRegistryName: "app", repoPath: "/r", state: "running", agentType: "w", manager: "m" });
    for (const value of Object.values(agent!)) expect(value).not.toMatch(/\p{Cf}/u);
    // An error reply's reason is cleaned the same way.
    expect(() => decodeAgentsReply(encode({ op: "error", reason: `bad‮reason` }))).toThrow(
      new PeerErrorReply("the other side reported: badreason"),
    );
  });

  test("an error reply, and anything malformed, throw", () => {
    expect(() => decodeAgentsReply(encode({ op: "error", reason: "unknown op \"x\"" }))).toThrow(
      new PeerErrorReply('the other side reported: unknown op "x"'),
    );
    expect(() => decodeAgentsReply(encode("not json"))).toThrow(new PeerProtocolError("reply is not JSON"));
    expect(() => decodeAgentsReply(encode([1]))).toThrow(new PeerProtocolError("reply is not a JSON object"));
    expect(() => decodeAgentsReply(encode({ op: "agents" }))).toThrow(new PeerProtocolError("reply is not an agent list"));
    expect(() => decodeAgentsReply(encode({ op: "agents", repos: [], agents: [{ id: 1 }] }))).toThrow(
      new PeerProtocolError("agent 0 in the reply is malformed"),
    );
    expect(() => decodeAgentsReply(encode({ op: "agents", agents: [] }))).toThrow("reply has no repo list");
    for (const repo of [null, {}, { registryName: "app" }, { registryName: 2, displayName: "App" }]) {
      expect(() => decodeAgentsReply(encode({ op: "agents", agents: [], repos: [repo] }))).toThrow("repo 0 in the reply is malformed");
    }
    // repoRegistryName is required, like repoName: rows are keyed by it.
    const noRegistryName = { id: "a", repoName: "app", repoPath: "/r", state: "running" };
    expect(() => decodeAgentsReply(encode({ op: "agents", repos: [], agents: [noRegistryName] }))).toThrow(
      new PeerProtocolError("agent 0 in the reply is malformed"),
    );
    expect(() => decodeAgentsReply(new Uint8Array([0xff, 0xfe]))).toThrow(new PeerProtocolError("reply is not UTF-8"));
  });

  test("a list over 1 MB is sent as an error reply", () => {
    const big: RemoteAgent[] = [{ id: "x".repeat(PEER_MAX_REPLY_BYTES), nickname: null, repoName: "r", repoRegistryName: "r", repoPath: "/r", state: "running", agentType: null, manager: null }];
    expect(() => decodeAgentsReply(encodeAgentsReply({ coordinator: null, repos: [], agents: big }))).toThrow(
      new PeerErrorReply(`the other side reported: the agent list is over ${PEER_MAX_REPLY_BYTES} bytes`),
    );
  });
});

describe("requestAgents", () => {
  test("a reply over 1 MB rejects with a protocol error, not a parse", async () => {
    const link = createMemoryLink(ID_A, ID_B);
    // A responder that ignores the cap: it answers with more than 1 MB.
    const responder = (async () => {
      const stream = await link.b.acceptBi();
      await stream.readToEnd(PEER_MAX_REQUEST_BYTES);
      const agents = [{ id: "x".repeat(PEER_MAX_REPLY_BYTES), nickname: null, repoName: "r", repoRegistryName: "r", repoPath: "/r", state: "running", agentType: null, manager: null }];
      await stream.writeAll(encode({ op: "agents", agents }));
      await stream.finish();
    })();
    await expect(requestAgents(link.a)).rejects.toThrow(new PeerProtocolError(`reply longer than ${PEER_MAX_REPLY_BYTES} bytes`));
    await responder;
    link.a.close(PEER_CLOSE.done, "done");
  });
});

describe("serveTrustedConnection", () => {
  const snapshot = () => peerSnapshot([
    { name: "app", path: "/repos/app" },
    { name: "empty", nickname: "No agents", path: "/repos/empty" },
  ], [fullAgent("agent-1")], "waiting");

  test("answers a peer's agents requests, each on its own stream, over one connection", async () => {
    const side = serve({ snapshot });
    expect(await requestAgents(side.a)).toEqual(snapshot());
    expect(await requestAgents(side.a)).toEqual(snapshot());
    expect(snapshot().coordinator).toEqual({ state: "waiting" });
    expect(snapshot().repos).toEqual([{ registryName: "app", displayName: "app" }, { registryName: "empty", displayName: "No agents" }]);
    expect(side.snapshots()).toBe(2);
    // One check at the connection's accept, then two per request: when its
    // stream is accepted and right before it is answered.
    expect(side.checks()).toBe(5);
    expect(side.a.closeInfo()).toBeNull();
    side.a.close(PEER_CLOSE.done, "done");
    await side.done;
  });

  test("an id not in peers.json is closed before anything is read, and the handler never runs", async () => {
    const side = serve({ peers: new Set(), snapshot });
    const reply = await rawRequest(side.a, encode({ op: "agents" }));
    expect(reply).toBeInstanceOf(Error);
    expect(side.a.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.notPeer, reason: "not a peer" });
    await side.done;
    expect(side.snapshots()).toBe(0);
    expect(side.checks()).toBe(1);
    expect(side.logs).toContain(`peer link: closed a connection from ${ID_A.slice(0, 10)}: not a peer`);
  });

  test("a peer removed while connected: its next request on the same connection is refused", async () => {
    const side = serve({ snapshot });
    expect(await requestAgents(side.a)).toEqual(snapshot());
    side.peers.delete(ID_A);
    await expect(requestAgents(side.a)).rejects.toThrow();
    expect(side.a.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.notPeer, reason: "not a peer" });
    expect(side.snapshots()).toBe(1);
    await side.done;
    expect(side.logs).toContain(`peer link: refused a request from ${ID_A.slice(0, 10)}: no longer a peer; closing`);
  });

  test("a stream opened while trusted but finished after the removal gets no answer: closed as not a peer", async () => {
    const side = serve({ snapshot });
    const stream = await side.a.openBi();
    // The connection's check and the stream's accept-time check both pass.
    await waitFor(() => side.checks() === 2, { message: "stream accepted" });
    side.peers.delete(ID_A); // `ib peer remove` while the request is still open
    await stream.writeAll(encode({ op: "agents" }));
    await stream.finish();
    expect(await stream.readToEnd(PEER_MAX_REPLY_BYTES).catch((err: Error) => err)).toBeInstanceOf(Error);
    expect(side.a.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.notPeer, reason: "not a peer" });
    expect(side.snapshots()).toBe(0);
    expect(side.checks()).toBe(3);
    await side.done;
    expect(side.logs).toContain(`peer link: refused a request from ${ID_A.slice(0, 10)}: no longer a peer; closing`);
  });

  test("an unknown op gets an error reply and the connection stays usable", async () => {
    const side = serve({ snapshot });
    expect(decodeText(await rawRequest(side.a, encode({ op: "prompts" })))).toEqual({ op: "error", reason: 'unknown op "prompts"' });
    expect(side.a.closeInfo()).toBeNull();
    expect(await requestAgents(side.a)).toEqual(snapshot());
    side.a.close(PEER_CLOSE.done, "done");
    await side.done;
  });

  test("non-framed reads renew their idle deadline on each fragment", async () => {
    const side = serve({ snapshot });
    const accept = side.b.acceptBi.bind(side.b);
    spyOn(side.b, "acceptBi").mockImplementationOnce(async () => {
      const stream = await accept();
      const read = stream.read.bind(stream);
      spyOn(stream, "read").mockImplementation(limit => { side.clock.advance(35_000); return read(Math.min(2, limit)); });
      return stream;
    });
    try { expect(await requestAgents(side.a)).toEqual(snapshot()); }
    finally { side.a.close(0, "done"); await side.done; }
  });

  test.each([262144, 262145])("reads at most 262144 bytes for a %i-byte encoded new-agent request", async size => {
    const startAgent = mock(async () => "agent-id");
    const side = serve({ startAgent });
    const accept = side.b.acceptBi.bind(side.b);
    const limits: number[] = [];
    spyOn(side.b, "acceptBi").mockImplementationOnce(async () => {
      const stream = await accept();
      const read = stream.read.bind(stream);
      spyOn(stream, "read").mockImplementation(limit => { limits.push(limit); return read(limit); });
      return stream;
    });
    const request = { op: "new-agent", repo: "app", type: "worker", prompt: "é" };
    request.prompt += "x".repeat(size - encode(request).length);
    const reply = await rawRequest(side.a, encode(request));
    expect(limits[0]).toBe(1);
    expect(Math.max(...limits)).toBeLessThanOrEqual(64 * 1024);
    if (size === 262144) {
      expect(decodeText(reply)).toEqual({ ok: true, id: "agent-id" });
      expect(startAgent).toHaveBeenCalledTimes(1);
    } else {
      expect(reply).toBeInstanceOf(Error);
      expect(startAgent).not.toHaveBeenCalled();
      expect(side.a.closeInfo()).toMatchObject({ code: PEER_CLOSE.error });
    }
    side.a.close(0, "done");
  });

  for (const [label, bytes, reason] of [
    ["new-agent over 256 KB", encode({ op: "new-agent", prompt: "a".repeat(NEW_AGENT_MAX_REQUEST_BYTES) }), `request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes`],
    ["unknown op over 4096 bytes", encode({ op: "unknown", pad: "a".repeat(4096) }), "request longer than 4096 bytes"],
    ["not JSON", encode("{"), "request is not JSON"],
    ["not an object", encode([1, 2]), "request is not a JSON object"],
    ["no op", encode({ agents: true }), "request has no op"],
    ["not UTF-8", new Uint8Array([0xc3, 0x28]), "request is not UTF-8"],
    ["over 4096 bytes", encode({ op: "agents", pad: "x".repeat(PEER_MAX_REQUEST_BYTES) }), `request longer than ${PEER_MAX_REQUEST_BYTES} bytes`],
  ] as const) {
    test(`a malformed request (${label}) closes the connection with code 3`, async () => {
      const side = serve({ snapshot });
      expect(await rawRequest(side.a, bytes)).toBeInstanceOf(Error);
      expect(side.a.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.error, reason });
      expect(side.snapshots()).toBe(0);
      await side.done;
    });
  }

  test("a snapshot that throws gets an error reply, not a crash", async () => {
    const side = serve({
      snapshot: () => {
        throw new Error("watcher gone");
      },
    });
    await expect(requestAgents(side.a)).rejects.toThrow(new PeerErrorReply("the other side reported: internal error"));
    expect(side.logs).toContain(`peer link: could not build the agent list for ${ID_A.slice(0, 10)}: watcher gone`);
    expect(await requestAgents(side.a).catch((err: Error) => err.message)).toBe("the other side reported: internal error");
    side.a.close(PEER_CLOSE.done, "done");
    await side.done;
  });

  test("the dialer closing mid-request ends the handler quietly", async () => {
    const side = serve({ snapshot });
    const stream = await side.a.openBi();
    await stream.writeAll(encode({ op: "agents" }));
    side.a.close(PEER_CLOSE.done, "done");
    await side.done;
    await waitFor(() => side.b.closeInfo() !== null, { message: "B sees the close" });
    expect(side.logs.filter((line) => line.includes("closing"))).toEqual([]);
  });
});


test("a new-agent stream without a reply times out at 30 s", async () => {
  const link = createMemoryLink(ID_A, ID_B);
  const clock = createFakeClock();
  const pending = requestNewAgent(link.a, { repo: "app", type: "worker", prompt: "hello" }, clock.setTimer);
  const stream = await link.b.acceptBi();
  expect(decodeText(await stream.readToEnd(4096))).toEqual({ op: "new-agent", repo: "app", type: "worker", prompt: "hello" });
  clock.advance(29_999);
  expect(link.a.closeInfo()).toBeNull();
  clock.advance(1);
  await expect(pending).rejects.toThrow("timed out after 30 s");
  expect(link.b.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.done });
});

test.each(["", "bad/id", "agent\u001b[32m", "white space"])("rejects a malformed success id %j as a protocol error", async id => {
  const side = serve({ startAgent: async () => id });
  await expect(requestNewAgent(side.a, { repo: "app", type: "worker", prompt: "hi" }, side.clock.setTimer))
    .rejects.toBeInstanceOf(PeerProtocolError);
  side.a.close(0, "done");
});

describe("trusted new-agent responder", () => {
  const request = { op: "new-agent", repo: "ApP", type: "worker", prompt: "build it" };
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ib-peer-request-"));
    setUserHome(home);
  });
  afterEach(async () => {
    resetUserHome();
    await rm(home, { recursive: true, force: true });
  });

  function receiver(ok = true) {
    const spawn = mock<RemoteSpawnDeps["newAgent"]>(async () => ({
      ok, stdout: ok ? "agent-123\n" : "", stderr: ok ? "" : "Worktree is dirty", exitCode: ok ? 0 : 1,
    }));
    const notice = mock((_message: string) => {});
    const deps = { listSpawnableTypes: listSpawnableTypeNamesSync, listRepos: async () => [{ name: "app", path: "/local/app" }], newAgent: spawn, notice };
    const side = serve({ startAgent: (req, name) => acceptRemoteAgent(req, name, deps, line => side.logs.push(line)) });
    return { side, spawn, notice, deps };
  }

  test.each([
    ["non-string repo", { repo: 42 }, "Invalid repo registry name"],
    ["path instead of repo name", { repo: "/local/app" }, "Invalid repo registry name"],
    ["parent directory", { repo: ".." }, "Invalid repo registry name"],
    ["NUL in name", { repo: "app\0" }, "Invalid repo registry name"],
    ["non-string type", { type: 42 }, "unknown or not spawnable"],
    ["unregistered repo", { repo: "missing", type: "_all" }, "Repo is not registered"],
    ["unknown type", { type: "absent", prompt: "" }, "unknown or not spawnable"],
    ["layer-only type", { type: "_all" }, "unknown or not spawnable"],
    ["repo coordinator", { type: "repo-coordinator", name: "!" }, "repo-coordinator"],
    ["non-string name", { name: 42 }, "name must be a string"],
    ["invalid name", { name: "../x", prompt: "" }, "agent name may only contain"],
    ["reserved name", { name: "system" }, "reserved name"],
    ["repo name collision", { name: "app" }, "collides with registered repo"],
    ["empty prompt", { prompt: "  " }, "non-empty text"],
    ["non-text prompt", { prompt: 17 }, "non-empty text"],
  ] as const)("refuses %s before spawning", async (_, overrides, reason) => {
    const { side, spawn, notice } = receiver();
    const reply = decodeText(await rawRequest(side.a, encode({ ...request, ...overrides })));
    expect(reply).toEqual({ ok: false, error: expect.stringContaining(reason) });
    expect(spawn).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    side.a.close(0, "done");
  });

  test("refuses a peer removed after its new-agent stream was accepted", async () => {
    const { side, spawn } = receiver();
    const stream = await side.a.openBi();
    await waitFor(() => side.checks() === 2);
    side.peers.clear();
    await stream.writeAll(encode(request));
    await stream.finish();
    await expect(stream.readToEnd(4096)).rejects.toThrow();
    expect(side.a.closeInfo()).toMatchObject({ byPeer: true, code: PEER_CLOSE.notPeer });
    expect(spawn).not.toHaveBeenCalled();
  });

  test("matches a dotted stored name and starts only at the registered path", async () => {
    const { side, spawn, deps } = receiver();
    spyOn(deps, "listRepos").mockResolvedValue([{ name: "milestonemade.com", path: "/local/site" }]);
    const reply = decodeText(await rawRequest(side.a, encode({ ...request, repo: "MilestoneMade.com", path: "/other" })));
    expect(reply).toEqual({ ok: true, id: "agent-123" });
    expect(spawn.mock.calls).toEqual([["/local/site", request.prompt, { type: request.type, name: undefined }]]);
    side.a.close(0, "done");
  });

  test("rejects a system coordinator even when the local layer is spawnable", async () => {
    await Bun.write(join(home, ".itsybitsy", "agent-types", "system-coordinator.md"), "---\nspawnable: true\n---\n");
    const { side, spawn } = receiver();
    const reply = decodeText(await rawRequest(side.a, encode({ ...request, type: SYSTEM_COORDINATOR_TYPE })));
    expect(reply).toEqual({ ok: false, error: "Cannot start a system-coordinator remotely" });
    expect(spawn).not.toHaveBeenCalled();
    side.a.close(0, "done");
  });

  test("revocation during registry lookup prevents the spawn", async () => {
    const { side, deps, spawn } = receiver();
    const registry = Promise.withResolvers<Awaited<ReturnType<typeof deps.listRepos>>>();
    const lookup = spyOn(deps, "listRepos").mockReturnValue(registry.promise);
    const reply = rawRequest(side.a, encode(request));
    await waitFor(() => lookup.mock.calls.length === 1);
    side.peers.clear();
    registry.resolve([{ name: "app", path: "/app" }]);
    expect(decodeText(await reply)).toEqual({ ok: false, error: "Machine is no longer paired" });
    expect(spawn).not.toHaveBeenCalled();
    side.a.close(0, "done");
  });

  test("validates the prompt cap in bytes", async () => {
    const { side, deps, spawn } = receiver();
    await expect(acceptRemoteAgent({ ...request, prompt: "é".repeat(131073) }, async () => "Alice", deps, () => {})).rejects.toThrow("256 KB");
    expect(spawn).not.toHaveBeenCalled();
    side.a.close(0, "done");
  });

  test("polls while spawn is pending and returns an uncertain outcome at the responder deadline", async () => {
    const { side, spawn } = receiver();
    spawn.mockImplementation(() => new Promise(() => {}));
    const pending = rawRequest(side.a, encode(request));
    await waitFor(() => spawn.mock.calls.length === 1);
    expect(await requestAgents(side.a)).toEqual({ coordinator: null, repos: [], agents: [] });
    side.clock.advance(25_000);
    expect(decodeText(await pending)).toEqual({ ok: false, error: expect.stringContaining("outcome unknown") });
    expect(await requestAgents(side.a)).toEqual({ coordinator: null, repos: [], agents: [] });
    side.a.close(0, "done");
  });

  test("a throwing spawn gets an error reply and leaves the connection usable", async () => {
    const { side, spawn } = receiver();
    spawn.mockRejectedValue(new Error("spawn failed"));
    expect(decodeText(await rawRequest(side.a, encode(request)))).toEqual({ ok: false, error: "spawn failed" });
    expect(await requestAgents(side.a)).toEqual({ coordinator: null, repos: [], agents: [] });
    side.a.close(0, "done");
  });

  test("a long valid id is returned intact and bounded in the receiving notice", async () => {
    const { side, spawn, notice } = receiver();
    const id = "w".repeat(256);
    spawn.mockResolvedValue({ ok: true, exitCode: 0, stdout: id, stderr: "" });
    expect(await requestNewAgent(side.a, request, side.clock.setTimer)).toBe(id);
    expect(notice.mock.calls[0]?.[0]).toBe(`Alice started agent ${"w".repeat(79)}… in app`);
    side.a.close(0, "done");
  });

  test("returns spawn failures with one log entry and no success notice", async () => {
    const { side, notice } = receiver(false);
    expect(decodeText(await rawRequest(side.a, encode(request)))).toEqual({ ok: false, error: "Worktree is dirty" });
    expect(side.logs.filter(line => line.includes("Worktree is dirty"))).toHaveLength(1);
    expect(notice).not.toHaveBeenCalled();
    side.a.close(0, "done");
  });

  test("matches a mixed-case registry name, passes only type and name, and announces the id", async () => {
    const { side, spawn, notice } = receiver();
    const prompt = "a".repeat(5000);
    const reply = decodeText(await rawRequest(side.a, encode({ ...request, name: "builder", prompt, model: "other", permissions: ["all"] })));
    expect(reply).toEqual({ ok: true, id: "agent-123" });
    expect(spawn.mock.calls).toEqual([["/local/app", prompt, { type: "worker", name: "builder" }]]);
    const message = "Alice started agent agent-123 in app";
    expect(notice.mock.calls).toEqual([[message]]);
    expect(side.logs.filter(line => line === message)).toHaveLength(1);
    side.a.close(0, "done");
  });
});

describe("coordinator-pane", () => {
  const text = "\x1b[31mred\x1b[0m\t\x1b]8;;file:/private\x07label\x1b]8;;\x07\x07\u009b\r\n\x1b]8;;https://example.com\x07site\x1b]8;;\x07";
  const pane = { state: "running", text };
  test("serves only its own sanitized capture and logs the first read across connections", async () => {
    const captureCoordinator = mock(async () => pane);
    const paneReaders = new Set<string>();
    const sides = [serve({ captureCoordinator, paneReaders }), serve({ captureCoordinator, paneReaders })];
    for (const side of sides) {
      const reply = decodeText(await rawRequest(side.a, encode({ op: "coordinator-pane", session: "other" })));
      expect(reply).toEqual({ op: "coordinator-pane", state: "running", text: "red   label\n\x1b]8;;https://example.com\x07site\x1b]8;;\x07" });
      side.a.close(0, "done");
    }
    expect(sides.flatMap(side => side.logs).filter(line => line.includes("read the system coordinator pane"))).toHaveLength(1);
    expect(captureCoordinator.mock.calls).toEqual([[], []]);
  });

  test("audits each peer once after a successful finish, including a failed first delivery", async () => {
    const paneReaders = new Set<string>();
    const options = { paneReaders, captureCoordinator: async () => pane };
    const failed = serve(options);
    const accept = failed.b.acceptBi.bind(failed.b);
    const finishing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(failed.b, "acceptBi").mockImplementationOnce(async () => {
      const stream = await accept();
      stream.finish = async () => {
        finishing.resolve();
        await release.promise;
        failed.b.close(0, "delivery failed");
        throw new Error("finish failed");
      };
      return stream;
    });
    const read = requestCoordinatorPane(failed.a);
    await finishing.promise;
    expect(paneReaders.size).toBe(0);
    release.resolve();
    await expect(read).rejects.toThrow();
    expect(failed.logs.filter(line => line.includes("read the system coordinator pane"))).toBeEmpty();
    const deliveries = [];
    for (const readerId of [ID_A, "cd".repeat(32), ID_A, "cd".repeat(32)]) {
      const side = serve({ ...options, readerId });
      await requestCoordinatorPane(side.a);
      side.a.close(0, "done");
      await side.done;
      deliveries.push(...side.logs.filter(line => line.includes("read the system coordinator pane")));
    }
    expect(deliveries).toEqual([ID_A, "cd".repeat(32)].map(id =>
      `peer link: Alice (${id.slice(0, 10)}) read the system coordinator pane`));
  });

  test("returns an error when there is no coordinator", async () => {
    const side = serve({ captureCoordinator: async () => null });
    await expect(requestCoordinatorPane(side.a)).rejects.toThrow("No system coordinator");
    expect(side.logs.join(" ")).not.toContain("read the system coordinator pane");
    side.a.close(0, "done");
  });

  test.each(["resolve", "reject"])("refuses a removed reader when its pending capture will %s", async outcome => {
    const pending = Promise.withResolvers<typeof pane>();
    const captureCoordinator = mock(() => pending.promise);
    const refused = serve({ peers: new Set(), captureCoordinator });
    await expect(requestCoordinatorPane(refused.a)).rejects.toThrow();
    expect(captureCoordinator).not.toHaveBeenCalled();
    const side = serve({ captureCoordinator });
    const read = requestCoordinatorPane(side.a);
    await waitFor(() => captureCoordinator.mock.calls.length === 1);
    side.peers.clear();
    if (outcome === "resolve") pending.resolve(pane);
    else pending.reject(new Error("capture failed"));
    await expect(read).rejects.toThrow();
    expect(side.a.closeInfo()).toMatchObject({ code: PEER_CLOSE.notPeer });
    expect(side.logs.join(" ")).not.toContain("read the system coordinator pane");
  });

  test("dialer filters an untrusted raw reply before rendering", async () => {
    const { a, b } = createMemoryLink(ID_A, ID_B);
    const read = requestCoordinatorPane(a);
    const stream = await b.acceptBi();
    await stream.readToEnd(PEER_MAX_REQUEST_BYTES);
    const link = "\x1b]8;;https://example.org\x07site\x1b]8;;\x07";
    const unsafe = "\x1b]0;window title\x07\x1b[12;9Hhello\x1b]8;;file:///private\x07 label\x1b]8;;\x07 " + link;
    await stream.writeAll(encode({ op: "coordinator-pane", state: "running", text: unsafe }));
    await stream.finish();
    expect(await read).toEqual({ state: "running", text: "hello label " + link });
    a.close(0, "done");
  });

  test("drops the entire four-byte code point when only two of its bytes fit", async () => {
    const envelope = { op: "coordinator-pane", state: "running", text: "" };
    const suffix = "a".repeat(PEER_MAX_REPLY_BYTES - encode(envelope).length - 2);
    const side = serve({ captureCoordinator: async () => ({ state: "running", text: "🔥" + suffix }) });
    const bytes = await rawRequest(side.a, encode({ op: envelope.op }));
    const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes as Uint8Array));
    expect(reply.text).toBe(suffix);
    side.a.close(0, "done");
  });

  for (const separator of ["\n", ""]) {
    test(`caps JSON bytes and keeps the newest text with separator ${JSON.stringify(separator)}`, async () => {
      const text = "oldest" + ('🔥"\\' + separator).repeat(150_000) + "newest\n\n";
      const side = serve({ captureCoordinator: async () => ({ state: "running", text }) });
      const bytes = await rawRequest(side.a, encode({ op: "coordinator-pane" }));
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect((bytes as Uint8Array).length).toBeLessThanOrEqual(PEER_MAX_REPLY_BYTES);
      const reply = decodeText(bytes);
      expect(reply.text.endsWith("newest\n\n")).toBe(true);
      expect(reply.text).not.toContain("oldest");
      expect(text.endsWith(reply.text)).toBe(true);
      side.a.close(0, "done");
    });
  }
});


test("a lost send acknowledgement reports uncertainty and never opens another stream", async () => {
  const { requestSend } = await import("./peer-link");
  const { a, b } = createMemoryLink("sender", "receiver");
  const clock = createFakeClock();
  const header = { op: "send", id: crypto.randomUUID(), from: { kind: "user" }, target: { kind: "system" }, files: [], message: "hi" } as const;
  const opens = spyOn(a, "openBi");
  const sent = requestSend(a, { ...header, files: [] }, clock.setTimer);
  const incoming = await b.acceptBi();
  await incoming.readToEnd(4096);
  await Bun.sleep(0);
  clock.advance(60_000);
  await expect(sent).rejects.toThrow("outcome unknown — check the agent");
  expect(opens).toHaveBeenCalledTimes(1);
  expect(clock.pending()).toBe(0);
  expect(a.closeInfo()).toBeNull();
  a.close(0, "done");
});

test("acknowledgement progress keeps a send alive beyond sixty seconds", async () => {
  const { requestSend } = await import("./peer-link");
  const { textHeader } = await import("./peer-outbox");
  const { a, b } = createMemoryLink("sender", "receiver");
  const clock = createFakeClock();
  const header = textHeader({ kind: "system" }, "hello", { kind: "user" });
  const sent = requestSend(a, header, clock.setTimer);
  try {
    const stream = await b.acceptBi();
    await stream.readToEnd(4096);
    const reply = encode({ ok: true, id: header.id });
    for (const part of [reply.subarray(0, 4), reply.subarray(4)]) {
      await Bun.sleep(0);
      clock.advance(40_000);
      await stream.writeAll(part);
    }
    await stream.finish();
    expect(await sent).toBe(header.id);
    expect(clock.pending()).toBe(0);
  } finally { a.close(0, "done"); }
});
