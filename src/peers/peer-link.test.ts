/**
 * The trusted link's protocol (src/peers/peer-link.ts) over the in-memory
 * link: no addon, no network. The real-endpoint version of the main cases is
 * peer-link-real.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { makeAgent, waitFor } from "../test-utils";
import { irohAddonLoaderCtx } from "./iroh";
import {
  PEER_CLOSE,
  PEER_MAX_REPLY_BYTES,
  PEER_MAX_REQUEST_BYTES,
  PeerErrorReply,
  PeerProtocolError,
  decodeAgentsReply,
  encodeAgentsReply,
  requestAgents,
  serveTrustedConnection,
  toRemoteAgents,
  type RemoteAgent,
} from "./peer-link";
import { createMemoryLink, type MemoryConnection } from "./test-pair-transport";

const ID_A = "a1".repeat(32);
const ID_B = "b2".repeat(32);
const ALLOWED_KEYS = ["agentType", "id", "manager", "nickname", "repoName", "repoPath", "state"];

beforeEach(() => {
  irohAddonLoaderCtx.set(async () => {
    throw new Error("a peer-link test loaded the iroh addon");
  });
});
afterEach(() => irohAddonLoaderCtx.reset());

/** An agent with every field the reply must leave out set to something recognizable. */
function fullAgent(id: string, extra: Partial<Agent["meta"]> = {}): Agent {
  const agent = makeAgent({ id, repoName: "app", repoPath: "/repos/app", state: "running" });
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
function serve(options: { peers?: Set<string>; snapshot?: () => RemoteAgent[] } = {}) {
  const link = createMemoryLink(ID_A, ID_B);
  const peers = options.peers ?? new Set([ID_A]);
  const logs: string[] = [];
  let snapshots = 0;
  let checks = 0;
  const done = serveTrustedConnection(link.b, {
    isPeer: async (id) => {
      checks++;
      return peers.has(id);
    },
    snapshot: () => {
      snapshots++;
      return options.snapshot ? options.snapshot() : [];
    },
    log: (line) => logs.push(line),
  });
  return {
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
  test("keeps exactly the seven allowed fields and leaves out the system coordinator", () => {
    const worker = fullAgent("agent-1");
    const bare = makeAgent({ id: "agent-2", repoName: "lib", repoPath: "/repos/lib", state: "waiting" });
    const system = fullAgent("agent-sys", { agentType: SYSTEM_COORDINATOR_TYPE });
    const out = toRemoteAgents([worker, system, bare]);
    expect(out).toEqual([
      { id: "agent-1", nickname: "builder", repoName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: "agent-mgr" },
      { id: "agent-2", nickname: null, repoName: "lib", repoPath: "/repos/lib", state: "waiting", agentType: null, manager: null },
    ]);
    for (const entry of out) expect(Object.keys(entry).sort()).toEqual(ALLOWED_KEYS);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});

describe("decodeAgentsReply", () => {
  test("rebuilds each entry from the allowed fields only, and strips control characters", () => {
    const agents = decodeAgentsReply(
      encode({
        op: "agents",
        agents: [{ id: "agent-1", repoName: "app\x1b[31m", repoPath: "/r", state: "running", prompt: "leak", extra: { x: 1 } }],
      }),
    );
    expect(agents).toEqual([{ id: "agent-1", nickname: null, repoName: "app[31m", repoPath: "/r", state: "running", agentType: null, manager: null }]);
    expect(Object.keys(agents[0]!).sort()).toEqual(ALLOWED_KEYS);
  });

  test("an error reply, and anything malformed, throw", () => {
    expect(() => decodeAgentsReply(encode({ op: "error", reason: "unknown op \"x\"" }))).toThrow(
      new PeerErrorReply('the other side reported: unknown op "x"'),
    );
    expect(() => decodeAgentsReply(encode("not json"))).toThrow(new PeerProtocolError("reply is not JSON"));
    expect(() => decodeAgentsReply(encode([1]))).toThrow(new PeerProtocolError("reply is not a JSON object"));
    expect(() => decodeAgentsReply(encode({ op: "agents" }))).toThrow(new PeerProtocolError("reply is not an agent list"));
    expect(() => decodeAgentsReply(encode({ op: "agents", agents: [{ id: 1 }] }))).toThrow(
      new PeerProtocolError("agent 0 in the reply is malformed"),
    );
    expect(() => decodeAgentsReply(new Uint8Array([0xff, 0xfe]))).toThrow(new PeerProtocolError("reply is not UTF-8"));
  });

  test("a list over 1 MB is sent as an error reply", () => {
    const big: RemoteAgent[] = [{ id: "x".repeat(PEER_MAX_REPLY_BYTES), nickname: null, repoName: "r", repoPath: "/r", state: "running", agentType: null, manager: null }];
    expect(() => decodeAgentsReply(encodeAgentsReply(big))).toThrow(
      new PeerErrorReply(`the other side reported: the agent list is over ${PEER_MAX_REPLY_BYTES} bytes`),
    );
  });
});

describe("serveTrustedConnection", () => {
  const snapshot = (): RemoteAgent[] => toRemoteAgents([fullAgent("agent-1")]);

  test("answers a peer's agents requests, each on its own stream, over one connection", async () => {
    const side = serve({ snapshot });
    expect(await requestAgents(side.a)).toEqual(snapshot());
    expect(await requestAgents(side.a)).toEqual(snapshot());
    expect(side.snapshots()).toBe(2);
    // One check at accept, one per request.
    expect(side.checks()).toBe(3);
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

  test("an unknown op gets an error reply and the connection stays usable", async () => {
    const side = serve({ snapshot });
    expect(decodeText(await rawRequest(side.a, encode({ op: "prompts" })))).toEqual({ op: "error", reason: 'unknown op "prompts"' });
    expect(side.a.closeInfo()).toBeNull();
    expect(await requestAgents(side.a)).toEqual(snapshot());
    side.a.close(PEER_CLOSE.done, "done");
    await side.done;
  });

  for (const [label, bytes, reason] of [
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
