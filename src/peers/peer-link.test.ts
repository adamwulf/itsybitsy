/**
 * The trusted link's protocol (src/peers/peer-link.ts) over the in-memory
 * link: no addon, no network. The real-endpoint version of the main cases is
 * peer-link-real.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUserHome, resetUserHome } from "../home";
import { acceptRemoteLifecycle } from "./remote-lifecycle";
import { lifecycleFixture } from "./test-remote-lifecycle";
import { acceptRemoteAgent, type RemoteSpawnDeps } from "./new-agent";
import { listSpawnableTypeNamesSync } from "../agent-types";
import { readRepoAgents, type Agent, type PendingQuestion } from "../agents";
import { logAgent } from "../agent-lifecycle";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { captureAgentPane, readAgentPromptText } from "./agent-pane";
import { spawnCtx as paneCapture } from "../tmux-poller";
import { makeAgent, makeSpawnResult, waitFor } from "../test-utils";
import { irohAddonLoaderCtx } from "./iroh";
import {
  PEER_CLOSE,
  PEER_MAX_REPLY_BYTES,
  NEW_AGENT_MAX_REQUEST_BYTES,
  requestNewAgent,
  requestPane,
  requestAgentPrompt,
  requestLifecycle,
  requestAcknowledge,
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
const ALLOWED_KEYS = ["agentType", "createdEpoch", "id", "manager", "nickname", "repoName", "repoPath", "repoRegistryName", "state"];

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
function serve(options: { lifecycle?: PeerResponderDeps["lifecycle"]; acknowledgeQuestion?: PeerResponderDeps["acknowledgeQuestion"]; readerId?: string; captureAgent?: PeerResponderDeps["captureAgent"]; captureCoordinator?: PeerResponderDeps["captureCoordinator"]; readPrompt?: PeerResponderDeps["readPrompt"]; paneReaders?: Set<string>; peers?: Set<string>; snapshot?: () => PeerSnapshot; startAgent?: PeerResponderDeps["startAgent"] } = {}) {
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
    lifecycle: options.lifecycle,
    acknowledgeQuestion: options.acknowledgeQuestion,
    captureCoordinator: options.captureCoordinator,
    captureAgent: options.captureAgent,
    readPrompt: options.readPrompt,
    paneReaders: options.paneReaders ?? new Set(),
    peerName: async (id) => {
      checks++;
      return peers.has(id) ? "Alice" : null;
    },
    snapshot: () => {
      snapshots++;
      return options.snapshot ? options.snapshot() : { coordinator: null, repos: [], agents: [], questions: [] };
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
  test("the agents reply omits broken records and local placeholders, including on a cached refresh", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ib-peer-agents-"));
    const agentsDir = join(repo, ".itsybitsy", "agents");
    try {
      for (const [id, overrides] of [
        ["active", {}], ["starting", { claude_pid: "" }], ["bad-pid", { claude_pid: 42 }],
        ["bad-worktree", { worktree: null }], ["wrong-dir", { id: "wrong-id" }],
      ] as const) {
        await Bun.write(join(agentsDir, id, "meta.json"), JSON.stringify({ id, worktree: true, claude_pid: "42", ...overrides }));
      }
      await Bun.write(join(agentsDir, "broken", "meta.json"), "{");
      await mkdir(join(agentsDir, "unreadable", "meta.json"), { recursive: true });
      const placeholder = join(agentsDir, "placeholder");
      await mkdir(placeholder);
      await logAgent(placeholder, "[spawn] start id=placeholder");
      for (let refresh = 0; refresh < 2; refresh++) {
        const { agents } = await readRepoAgents(repo, "app", false);
        expect(agents.find(a => a.id === "placeholder")?.state).toBe("creating");
        const reply = decodeAgentsReply(encodeAgentsReply(peerSnapshot([], agents, [], undefined, new Map())));
        expect(reply.agents.map(a => a.id).sort()).toEqual(["active", "starting"]);
      }
      if (process.getuid?.() !== 0) {
        await chmod(join(agentsDir, "active", "meta.json"), 0);
        const { agents } = await readRepoAgents(repo, "app", false);
        expect(toRemoteAgents(agents).map(a => a.id)).toEqual(["starting"]);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("keeps exactly the nine allowed fields and leaves out the system coordinator", () => {
    const worker = fullAgent("agent-1", { created_epoch: 1_700_000_000 });
    // A nicknamed repo: shown as "library", keyed by its registry name "lib".
    const bare = makeAgent({ id: "agent-2", repoName: "library", repoRegistryName: "lib", repoPath: "/repos/lib", state: "waiting" });
    bare.meta.created_epoch = 1_700_000_060;
    const system = fullAgent("agent-sys", { agentType: SYSTEM_COORDINATOR_TYPE });
    const out = toRemoteAgents([worker, system, bare]);
    expect(out).toEqual([
      { id: "agent-1", nickname: "builder", repoName: "app", repoRegistryName: "app", repoPath: "/repos/app", state: "running", agentType: "worker", manager: "agent-mgr", createdEpoch: 1_700_000_000 },
      { id: "agent-2", nickname: null, repoName: "library", repoRegistryName: "lib", repoPath: "/repos/lib", state: "waiting", agentType: null, manager: null, createdEpoch: 1_700_000_060 },
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
        op: "agents", coordinator: { state: "running" }, questions: [],
        repos: [{ registryName: "ap\u202ep", displayName: "App\n", path: "/private" }],
        agents: [{ id: "agent-1", repoName: "app\x1b[31m", repoRegistryName: "app\x1b[31m", repoPath: "/r", state: "running", createdEpoch: 1_700_000_000, prompt: "leak", extra: { x: 1 } }],
      }),
    );
    expect(repos).toEqual([{ registryName: "app", displayName: "App", remoteUrl: null, relPath: null }]);
    expect(agents).toEqual([{ id: "agent-1", nickname: null, repoName: "app[31m", repoRegistryName: "app[31m", repoPath: "/r", state: "running", agentType: null, manager: null, createdEpoch: 1_700_000_000 }]);
    expect(Object.keys(agents[0]!).sort()).toEqual(ALLOWED_KEYS);
  });

  test("createdEpoch is required and must be a number: the tree sorts by it", () => {
    const reply = (extra: Record<string, unknown>) => encode({ op: "agents", coordinator: null, questions: [], repos: [],
      agents: [{ id: "a", repoName: "app", repoRegistryName: "app", repoPath: "/r", state: "running", ...extra }] });
    expect(decodeAgentsReply(reply({ createdEpoch: 1_700_000_000 })).agents[0]!.createdEpoch).toBe(1_700_000_000);
    for (const bad of [{}, { createdEpoch: null }, { createdEpoch: "1700000000" }, { createdEpoch: true }]) {
      expect(() => decodeAgentsReply(reply(bad))).toThrow(new PeerProtocolError("agent 0 in the reply is malformed"));
    }
  });

  test("a repo's remoteUrl and relPath round-trip; absent or null decode as null, and any other type fails the reply", () => {
    const sent: PeerSnapshot = { coordinator: null, repos: [
      { registryName: "foo", displayName: "Foo", remoteUrl: "git@github.com:owner/Foo.git", relPath: "swift-packages/Foo" },
      { registryName: "bar", displayName: "bar", remoteUrl: null, relPath: null },
    ], agents: [], questions: [] };
    expect(decodeAgentsReply(encodeAgentsReply(sent))).toEqual(sent);
    const absent = decodeAgentsReply(encode({ op: "agents", coordinator: null, agents: [], questions: [], repos: [{ registryName: "foo", displayName: "Foo" }] }));
    expect(absent.repos).toEqual([{ registryName: "foo", displayName: "Foo", remoteUrl: null, relPath: null }]);
    // A URL that is empty or carries a control or format character is dropped,
    // not cleaned into another URL. Anything else is kept as sent:
    // checkCloneUrl checks it when `c` is pressed and again in cloneRepo.
    const urlOf = (remoteUrl: string) =>
      decodeAgentsReply(encode({ op: "agents", coordinator: null, agents: [], questions: [], repos: [{ registryName: "foo", displayName: "Foo", remoteUrl }] })).repos[0]!.remoteUrl;
    for (const dropped of ["", "ext::sh\x1b[31m", "git@host:o/r\n", "git@host:o/r\0", "https://h/o/\u202er", "git@host:o/\u200br"]) {
      expect(urlOf(dropped)).toBeNull();
    }
    for (const kept of ["git@github.com:owner/Foo.git", "ext::ssh", "https://h/o/r"]) expect(urlOf(kept)).toBe(kept);
    for (const bad of [{ remoteUrl: 1 }, { remoteUrl: {} }, { relPath: ["a"] }, { relPath: false }]) {
      expect(() => decodeAgentsReply(encode({ op: "agents", coordinator: null, agents: [], questions: [], repos: [{ registryName: "foo", displayName: "Foo", ...bad }] })))
        .toThrow(new PeerProtocolError("repo 0 in the reply is malformed"));
    }
  });

  test("a relPath that could leave the clone root, or is unsafe to join, is dropped to null", () => {
    const relPathOf = (relPath: string) =>
      decodeAgentsReply(encode({ op: "agents", coordinator: null, agents: [], questions: [], repos: [{ registryName: "foo", displayName: "Foo", remoteUrl: "https://h/foo", relPath }] })).repos[0]!.relPath;
    for (const kept of ["Foo", "swift-packages/Foo", "a/b/c/Foo", "dots.in.name/..Foo", "x".repeat(512), ".github/Foo", "swift/Foo.git", "itsybitsy/Foo"]) {
      expect(relPathOf(kept)).toBe(kept);
    }
    for (const dropped of [
      "/Users/me/Developer/Foo", "../Foo", "a/../../Foo", "a/./Foo", "./Foo", "a//Foo", "a/Foo/", "", "..",
      "a\\..\\Foo", "a\0/Foo", "a\n/Foo", "a/.\u200b./Foo", "x".repeat(513),
      // A clone at <root>/.git would make the clone root a repo the peer configured.
      ".git", "swift/.git", "a/.GIT/x", ".Git",
      // One under a repo's runtime dir would plant a fake agent folder ib reads.
      ".itsybitsy", "foo/.itsybitsy/agents/x", ".ItsyBitsy",
      // APFS's case folding: the long s is an s, the dotless ı an i.
      ".itſybitſy", "a/.itſybitſy/agents/x", ".gıt",
    ]) {
      expect(relPathOf(dropped)).toBeNull();
    }
  });

  test("strips format characters too: bidi overrides and isolates, zero-width marks, the BOM", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, U+2066 LEFT-TO-RIGHT ISOLATE, U+200B ZERO WIDTH SPACE,
    // U+200D ZERO WIDTH JOINER, U+FEFF BOM, U+00AD SOFT HYPHEN: all \p{Cf}.
    const cf = "‮⁦​‍﻿­";
    const { agents: [agent] } = decodeAgentsReply(
      encode({
        op: "agents", coordinator: { state: "running" }, questions: [],
        repos: [{ registryName: "ap\u202ep", displayName: "App\n", path: "/private" }],
        agents: [{ id: `agent${cf}-1`, nickname: `nick${cf}`, repoName: `app${cf}`, repoRegistryName: `app${cf}`, repoPath: `/r${cf}`, state: `run${cf}ning`, agentType: `w${cf}`, manager: `m${cf}`, createdEpoch: 1_700_000_000 }],
      }),
    );
    expect(agent).toEqual({ id: "agent-1", nickname: "nick", repoName: "app", repoRegistryName: "app", repoPath: "/r", state: "running", agentType: "w", manager: "m", createdEpoch: 1_700_000_000 });
    for (const value of Object.values(agent!)) if (typeof value === "string") expect(value).not.toMatch(/\p{Cf}/u);
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
    const big: RemoteAgent[] = [{ id: "x".repeat(PEER_MAX_REPLY_BYTES), nickname: null, repoName: "r", repoRegistryName: "r", repoPath: "/r", state: "running", agentType: null, manager: null, createdEpoch: 0 }];
    expect(() => decodeAgentsReply(encodeAgentsReply({ coordinator: null, repos: [], agents: big, questions: [] }))).toThrow(
      new PeerErrorReply(`the other side reported: the agent list is over ${PEER_MAX_REPLY_BYTES} bytes`),
    );
  });
});

describe("questions in the agents reply", () => {
  const question = (agent: string, repoPath: string, id = `q-${agent}`): PendingQuestion =>
    ({ id, agent, question: "Proceed?", timestamp: "2026-11-24T10:00:00Z", status: "pending", repoPath });
  const wire = (agent: string, extra: Record<string, unknown> = {}) =>
    ({ id: `q-${agent}`, agent, repoRegistryName: "app", question: "Proceed?", timestamp: "2026-11-24T10:00:00Z", ...extra });
  const reply = (questions: unknown) => encode({
    op: "agents", coordinator: null, repos: [{ registryName: "app", displayName: "App" }], questions,
    agents: [{ id: "agent-1", repoName: "App", repoRegistryName: "app", repoPath: "/repos/app", state: "waiting", createdEpoch: 1_700_000_000 }],
  });

  test("peerSnapshot sends only the questions of agents it sends, named by their repo registry name", () => {
    const worker = makeAgent({ id: "agent-1", repoName: "library", repoRegistryName: "lib", repoPath: "/repos/lib", state: "waiting" });
    const system = fullAgent("agent-sys", { agentType: SYSTEM_COORDINATOR_TYPE });
    const snapshot = peerSnapshot([], [worker, system], [
      question("agent-1", "/repos/lib"),
      question("agent-1", "/repos/other"), // the same id in a repo the reply has no agent for
      question("agent-sys", "/repos/app"),
      question("agent-gone", "/repos/lib"),
    ], undefined, new Map());
    expect(snapshot.questions).toEqual([
      { id: "q-agent-1", agent: "agent-1", repoRegistryName: "lib", question: "Proceed?", timestamp: "2026-11-24T10:00:00Z" },
    ]);
    expect(decodeAgentsReply(encodeAgentsReply(snapshot)).questions).toEqual(snapshot.questions);
  });

  test("the dialer requires the list and every field, drops extra fields and unknown askers, and cleans the text", () => {
    const { questions } = decodeAgentsReply(reply([
      wire("agent-1", { id: "q-1‮", question: "Line one\tx\nLine​ two\x1b[31m\r", timestamp: "2026\n-11", status: "pending", prompt: "leak" }),
      wire("agent-2"),
      wire("agent-1", { repoRegistryName: "other" }),
    ]));
    expect(questions).toEqual([
      { id: "q-1", agent: "agent-1", repoRegistryName: "app", question: "Line one   x\nLine two[31m", timestamp: "2026-11" },
    ]);
    expect(() => decodeAgentsReply(encode({ op: "agents", coordinator: null, repos: [], agents: [] }))).toThrow(
      new PeerProtocolError("reply has no question list"),
    );
    for (const key of ["id", "agent", "repoRegistryName", "question", "timestamp"]) {
      expect(() => decodeAgentsReply(reply([wire("agent-1"), wire("agent-1", { [key]: undefined })]))).toThrow(
        new PeerProtocolError("question 1 in the reply is malformed"),
      );
      expect(() => decodeAgentsReply(reply([wire("agent-1", { [key]: 7 })]))).toThrow("question 0 in the reply is malformed");
    }
    expect(() => decodeAgentsReply(reply([null]))).toThrow("question 0 in the reply is malformed");
    expect(() => decodeAgentsReply(reply({}))).toThrow("reply has no question list");
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
  ], [fullAgent("agent-1")], [], "waiting", new Map([["/repos/app", { remoteUrl: "git@github.com:owner/app.git", relPath: "tools/app" }]]));

  test("answers a peer's agents requests, each on its own stream, over one connection", async () => {
    const side = serve({ snapshot });
    expect(await requestAgents(side.a)).toEqual(snapshot());
    expect(await requestAgents(side.a)).toEqual(snapshot());
    expect(snapshot().coordinator).toEqual({ state: "waiting" });
    // A repo the clone-info cache has not read yet reports null for both fields.
    expect(snapshot().repos).toEqual([
      { registryName: "app", displayName: "app", remoteUrl: "git@github.com:owner/app.git", relPath: "tools/app" },
      { registryName: "empty", displayName: "No agents", remoteUrl: null, relPath: null },
    ]);
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
    try {
      const stream = await side.a.openBi();
      const bytes = encode({ op: "agents" });
      await stream.writeAll(bytes.subarray(0, 3));
      await Bun.sleep(0);
      side.clock.advance(35_000);
      await stream.writeAll(bytes.subarray(3));
      await Bun.sleep(0);
      side.clock.advance(35_000);
      await stream.finish();
      expect(decodeAgentsReply(await stream.readToEnd(PEER_MAX_REPLY_BYTES))).toEqual(snapshot());
    }
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


test("lifecycle requests run the receiver’s local commands, return merge errors and resolve retired agents", async () => {
  const repo = await mkdtemp(join(tmpdir(), "ib-peer-lifecycle-"));
  const deps = await lifecycleFixture(repo);
  const side = serve({ lifecycle: (req, name) => acceptRemoteLifecycle(req, name, deps, () => {}) });
  const target = { id: "worker", repo: "app" };
  try {
    const ask = (request: Parameters<typeof requestLifecycle>[1]) => requestLifecycle(side.a, request, "Laptop", side.clock.setTimer);
    expect(await ask({ ...target, action: "merge", checkOnly: true })).toEqual({ output: "Ready" });
    expect(deps.mergeAgent).not.toHaveBeenCalled();
    deps.mergeAgent.mockResolvedValueOnce({ ok: false, exitCode: 1, stderr: "Merge conflict in app.ts", stdout: "" });
    await expect(ask({ ...target, action: "merge" })).rejects.toThrow("Merge conflict in app.ts");
    deps.mergeAgent.mockResolvedValueOnce({ ok: true, exitCode: 0, stdout: "Merged one commit", stderr: "" });
    expect(await ask({ ...target, action: "merge", keep: true, force: true })).toEqual({ output: "Merged one commit" });
    // The merge names this machine, for a failed push's retry hint.
    expect(deps.mergeAgent.mock.calls.at(-1)).toEqual([expect.objectContaining({ id: "worker" }), repo, { keep: true, _peerRequest: { machine: "Studio" } }]);
    await ask({ ...target, action: "resume" });
    await ask({ ...target, action: "retire" });
    await ask({ id: "worker", action: "rehire" });
    expect(deps.rehireAgent.mock.calls).toEqual([["worker", { repoPath: repo }]]);
    expect(deps.notice.mock.calls).toEqual(["merged", "resumed", "retired", "rehired"].map(verb => [`Alice ${verb} worker in App`, "info"]));
    deps.mergeAgent.mockResolvedValueOnce({ ok: true, exitCode: 0, stdout: "Nothing to merge: branch is current", stderr: "" });
    expect(await ask({ ...target, action: "merge", keep: true })).toEqual({ output: "Nothing to merge: branch is current" });
    expect(deps.notice.mock.calls.at(-1)?.[0]).toContain("Nothing to merge: branch is current");
  } finally {
    side.a.close(0, "done");
    await rm(repo, { recursive: true, force: true });
  }
});

test("a merge whose push failed on the receiver returns pushFailure beside its output", async () => {
  const repo = await mkdtemp(join(tmpdir(), "ib-peer-lifecycle-push-"));
  const deps = await lifecycleFixture(repo);
  const logs: string[] = [];
  const side = serve({ lifecycle: (req, name) => acceptRemoteLifecycle(req, name, deps, line => logs.push(line)) });
  const target = { id: "worker", repo: "app" };
  // git's whole error, as mergeAgent reports it: later lines indented.
  const pushFailure = "origin: To /remotes/origin.git\n  ! [rejected] main -> main (fetch first)\n  hint: Updates were rejected";
  const failed = { ok: true, exitCode: 0, pushFailure };
  // mergeAgent's stdout: the push's ✗ lines, then the warning whose hint names
  // this machine (from _peerRequest). Nothing else adds a hint.
  const report = "✗ origin: ! [rejected] main -> main (fetch first)\nWarning: merged, but the push of main failed. Run `ib push App` on Studio to push it.";
  const keptStdout = `Merged agent worker into main (1 commit(s), agent kept running)\n${report}`;
  const closedStdout = `Closed agent: worker (merged to main at abc)\n${report}`;
  try {
    const ask = (request: Parameters<typeof requestLifecycle>[1]) => requestLifecycle(side.a, request, "Laptop", side.clock.setTimer);
    // A closing merge's output is its teardown warnings, then its stdout. The
    // warnings also go apart, only when there are some.
    deps.mergeAgent.mockResolvedValueOnce({ ...failed, stdout: closedStdout, stderr: "" });
    expect(await ask({ ...target, action: "merge" })).toEqual({ output: closedStdout, pushFailure });
    deps.mergeAgent.mockResolvedValueOnce({ ...failed, stdout: closedStdout, stderr: "Could not remove the agent directory" });
    expect(await ask({ ...target, action: "merge" })).toEqual({
      output: `Could not remove the agent directory\n${closedStdout}`, pushFailure, warnings: "Could not remove the agent directory",
    });
    // --keep's output is the merge report, which already has the push lines and the hint.
    deps.mergeAgent.mockResolvedValueOnce({ ...failed, stdout: keptStdout, stderr: "" });
    expect(await ask({ ...target, action: "merge", keep: true })).toEqual({ output: keptStdout, pushFailure });
    // This machine's own header alert is red, without git's To/hint lines.
    expect(deps.notice.mock.calls).toEqual(Array(3).fill(
      ["Alice merged worker in App · push failed: origin: ! [rejected] main -> main (fetch first)", "error"]));
    // The log keeps the whole error, on one line.
    expect(logs).toEqual(Array(3).fill(
      "Alice merged worker in App · push failed: origin: To /remotes/origin.git ! [rejected] main -> main (fetch first) hint: Updates were rejected"));
  } finally {
    side.a.close(0, "done");
    await rm(repo, { recursive: true, force: true });
  }
});

test.each(["pushFailure", "warnings"])("a lifecycle reply with a non-string %s is malformed, so the outcome is unknown", async field => {
  const link = createMemoryLink(ID_A, ID_B);
  const clock = createFakeClock();
  const result = requestLifecycle(link.a, { action: "merge", repo: "app", id: "worker" }, "Laptop B", clock.setTimer)
    .catch((err: Error) => err);
  const stream = await link.b.acceptBi();
  await stream.readToEnd(4096);
  await stream.writeAll(encode({ ok: true, output: "", [field]: 7 }));
  await stream.finish();
  const error = await result;
  // As for any malformed lifecycle reply: the request was already sent.
  expect(error).toHaveProperty("message", "outcome unknown — check Laptop B");
  expect((error as Error).cause).toBeInstanceOf(PeerProtocolError);
  link.a.close(0, "done");
});

test("ambiguous retired nicknames suggest addresses on the paired machine", async () => {
  const repo = await mkdtemp(join(tmpdir(), "ib-peer-ambiguous-rehire-"));
  const deps = await lifecycleFixture(repo);
  const side = serve({ lifecycle: (req, name) => acceptRemoteLifecycle(req, name, deps, () => {}) });
  try {
    for (const id of ["first", "second"]) {
      await Bun.write(join(repo, ".itsybitsy", "archive", id, "meta.json"), JSON.stringify({ id, nickname: "reviewer" }));
    }
    for (const scope of [{}, { repo: "app" }]) {
      await expect(requestLifecycle(side.a, { ...scope, action: "rehire", id: "reviewer" }, "Laptop B", side.clock.setTimer))
        .rejects.toThrow("'reviewer' matches several agents; use 'Laptop B/App/first' or 'Laptop B/App/second'");
    }
    expect(deps.rehireAgent).not.toHaveBeenCalled();
  } finally {
    side.a.close(0, "done");
    await rm(repo, { recursive: true, force: true });
  }
});

test("dropping the trusted link after lifecycle FIN leaves the outcome unknown", async () => {
  const link = createMemoryLink(ID_A, ID_B);
  const clock = createFakeClock();
  const result = requestLifecycle(link.a, { action: "retire", repo: "app", id: "worker" }, "Laptop B", clock.setTimer);
  const stream = await link.b.acceptBi();
  expect(decodeText(await stream.readToEnd(4096))).toMatchObject({ op: "lifecycle", action: "retire", id: "worker" });
  link.b.close(0, "receiver stopped");
  await expect(result).rejects.toThrow("outcome unknown — check Laptop B");
});

test.each([["merge", 120000], ["retire", 30000], ["rehire", 30000], ["resume", 30000]] as const)(
  "%s waits for its own deadline and reports the machine to check", async (action, ms) => {
    const link = createMemoryLink(ID_A, ID_B);
    const clock = createFakeClock();
    let settled = false;
    const pending = requestLifecycle(link.a, { action, id: "worker", repo: "app" }, "Laptop", clock.setTimer)
      .catch(err => err.message).finally(() => { settled = true; });
    await (await link.b.acceptBi()).readToEnd(4096);
    await Bun.sleep(0);
    clock.advance(ms - 1);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    clock.advance(1);
    await Bun.sleep(0);
    clock.advance(750);
    expect(await pending).toBe("outcome unknown — check Laptop");
  });

describe("acknowledge", () => {
  test("runs the receiver's handler as the paired peer, and an error reply surfaces its reason", async () => {
    const calls: unknown[][] = [];
    const side = serve({ acknowledgeQuestion: async (repo, id, readPeerName) => {
      calls.push([repo, id, await readPeerName()]);
      if (id === "q-gone") throw new Error("Question 'q-gone' not found");
    } });
    try {
      await requestAcknowledge(side.a, "app", "q-1", side.clock.setTimer);
      expect(calls).toEqual([["app", "q-1", "Alice"]]);
      await expect(requestAcknowledge(side.a, "app", "q-gone", side.clock.setTimer))
        .rejects.toThrow(new PeerErrorReply("Question 'q-gone' not found"));
      expect(side.logs).toContain(`peer link: acknowledge from ${ID_A.slice(0, 10)} failed: Question 'q-gone' not found`);
      expect(side.a.closeInfo()).toBeNull();
    } finally {
      side.a.close(0, "done");
      await side.done;
    }
  });

  test("an unpaired caller is refused and the handler never runs", async () => {
    const acknowledgeQuestion = mock(async () => {});
    const side = serve({ peers: new Set(), acknowledgeQuestion });
    await expect(requestAcknowledge(side.a, "app", "q-1", side.clock.setTimer)).rejects.toThrow();
    expect(side.a.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.notPeer, reason: "not a peer" });
    expect(acknowledgeQuestion).not.toHaveBeenCalled();
    await side.done;
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
  clock.advance(1); await Bun.sleep(0); clock.advance(750);
  await expect(pending).rejects.toThrow("timed out after 30 s");
  expect(link.b.closeInfo()).toMatchObject({ byPeer: true, code: 3 });
  link.a.close(0, "done");
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
    expect(reply).toEqual({ op: "error", reason: expect.stringContaining(reason) });
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
    expect(reply).toEqual({ op: "error", reason: "Cannot start a system-coordinator remotely" });
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
    expect(decodeText(await reply)).toEqual({ op: "error", reason: "Machine is no longer paired" });
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
    expect(await requestAgents(side.a)).toEqual({ coordinator: null, repos: [], agents: [], questions: [] });
    side.clock.advance(25_000);
    expect(decodeText(await pending)).toEqual({ op: "error", reason: expect.stringContaining("outcome unknown") });
    expect(await requestAgents(side.a)).toEqual({ coordinator: null, repos: [], agents: [], questions: [] });
    side.a.close(0, "done");
  });

  test("a throwing spawn gets an error reply and leaves the connection usable", async () => {
    const { side, spawn } = receiver();
    spawn.mockRejectedValue(new Error("spawn failed"));
    expect(decodeText(await rawRequest(side.a, encode(request)))).toEqual({ op: "error", reason: "spawn failed" });
    expect(await requestAgents(side.a)).toEqual({ coordinator: null, repos: [], agents: [], questions: [] });
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
    expect(decodeText(await rawRequest(side.a, encode(request)))).toEqual({ op: "error", reason: "Worktree is dirty" });
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

describe("agent-pane", () => {
  const target = { op: "agent-pane", repo: "App", id: "reader" } as const;

  test("resolves the registered repo and exact id, then returns sanitized text and state", async () => {
    const agent = fullAgent("reader", { tmux_session: "receiver-session" });
    const other = { ...agent, repoRegistryName: "another", meta: { ...agent.meta, tmux_session: "other-session" } };
    const capture = mock(() => makeSpawnResult(0, "0\n\x1b[31mready\x1b[0m"));
    paneCapture.set(capture);
    const side = serve({ captureAgent: (repo, id, lines) => captureAgentPane([other, agent], repo, id, lines) });
    try {
      expect(await requestPane(side.a, target, 701)).toEqual({ text: "ready", state: "running" });
      expect(capture).toHaveBeenCalledWith(["tmux", "display-message", "-p", "-t", "=receiver-session:", "#{pane_dead}",
        ";", "capture-pane", "-t", "=receiver-session:", "-p", "-e", "-J", "-S", "-701", "-E", "-"], expect.anything());
      await expect(requestPane(side.a, { ...target, id: "missing" }, 200)).rejects.toThrow("Agent not found");
      await expect(requestPane(side.a, { ...target, repo: "elsewhere" }, 200)).rejects.toThrow("Agent not found");
      expect(capture).toHaveBeenCalledTimes(1);
      capture.mockReturnValueOnce(makeSpawnResult(1, "", "can't find session"));
      await expect(requestPane(side.a, target, 200)).rejects.toThrow("Agent session is unavailable");
      capture.mockReturnValueOnce(makeSpawnResult(0, "1\ndead pane"));
      await expect(requestPane(side.a, target, 200)).rejects.toThrow("Agent session is unavailable");
    } finally {
      paneCapture.reset();
      side.a.close(0, "done");
    }
  });

  test.each([[-1, 200], [813, 813], [5001, 5000]])("clamps both incoming pane requests at %i lines", async (lines, expected) => {
    const pane = { state: "idle", text: "output" };
    const captureAgent = mock(async (_repo: string, _id: string, _lines: number) => pane);
    const captureCoordinator = mock(async (_lines: number) => pane);
    const side = serve({ captureAgent, captureCoordinator });
    try {
      for (const requested of [target, { op: "coordinator-pane" }]) {
        expect(decodeText(await rawRequest(side.a, encode({ ...requested, lines })))).toEqual({ op: requested.op, ...pane });
      }
      expect(captureAgent.mock.calls).toEqual([["App", "reader", expected]]);
      expect(captureCoordinator.mock.calls).toEqual([[expected]]);
    } finally { side.a.close(0, "done"); }
  });
});

describe("agent-prompt", () => {
  test("reads the registered agent's prompt.txt, else meta.prompt; the dialer keeps line breaks and drops control characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ib-peer-prompt-"));
    const agent = { ...fullAgent("reader"), storageDir: dir };
    const other = { ...fullAgent("reader"), repoRegistryName: "another", storageDir: join(dir, "other") };
    const system = { ...fullAgent("system", { agentType: SYSTEM_COORDINATOR_TYPE }), storageDir: dir };
    const side = serve({ readPrompt: (repo, id) => readAgentPromptText([other, system, agent], repo, id) });
    try {
      // No prompt.txt: meta.prompt, as the local pane falls back.
      expect(await requestAgentPrompt(side.a, "App", "reader")).toBe("SECRET PROMPT");
      await Bun.write(join(dir, "prompt.txt"), "line 1\r\n\tline\x1b[31m 2‮");
      expect(await requestAgentPrompt(side.a, "App", "reader")).toBe("line 1\n   line[31m 2");
      for (const [repo, id] of [["App", "missing"], ["elsewhere", "reader"], ["App", "system"]]) {
        await expect(requestAgentPrompt(side.a, repo!, id!)).rejects.toThrow(new PeerErrorReply("Agent not found"));
      }
    } finally {
      side.a.close(0, "done");
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a malformed request, an install without the reader, and a prompt over the reply cap", async () => {
    const side = serve({ readPrompt: async () => "x".repeat(PEER_MAX_REPLY_BYTES) });
    const bare = serve();
    try {
      expect(decodeText(await rawRequest(side.a, encode({ op: "agent-prompt", repo: "App" })))).toEqual({ op: "error", reason: "Expected repo and agent id" });
      await expect(requestAgentPrompt(side.a, "App", "reader")).rejects.toThrow(new PeerErrorReply(`The prompt is over ${PEER_MAX_REPLY_BYTES} bytes`));
      await expect(requestAgentPrompt(bare.a, "App", "reader")).rejects.toThrow(new PeerErrorReply("Remote prompts are unavailable"));
    } finally {
      side.a.close(0, "done");
      bare.a.close(0, "done");
    }
  });

  test("a peer removed while its prompt is read gets no prompt, only the not-a-peer close", async () => {
    const read = Promise.withResolvers<string>();
    let started = false;
    const side = serve({ readPrompt: () => { started = true; return read.promise; } });
    const reply = requestAgentPrompt(side.a, "App", "reader");
    await waitFor(() => started);
    side.peers.delete(ID_A);
    read.resolve("the prompt");
    await expect(reply).rejects.toThrow();
    expect(side.a.closeInfo()).toEqual({ byPeer: true, code: PEER_CLOSE.notPeer, reason: "not a peer" });
  });
});

describe("coordinator-pane", () => {
  const text = "\x1b[31mred\x1b[0m\t\x1b]8;;file:/private\x07label\x1b]8;;\x07\x07\u009b\r\n\x1b]8;;https://example.com\x07site\x1b]8;;\x07";
  const pane = { state: "running", text };
  test("serves only its own sanitized capture and logs the first read across connections", async () => {
    const captureCoordinator = mock(async (_lines: number) => pane);
    const paneReaders = new Set<string>();
    const sides = [serve({ captureCoordinator, paneReaders }), serve({ captureCoordinator, paneReaders })];
    for (const side of sides) {
      const reply = decodeText(await rawRequest(side.a, encode({ op: "coordinator-pane", session: "other" })));
      expect(reply).toEqual({ op: "coordinator-pane", state: "running", text: "red   label\n\x1b]8;;https://example.com\x07site\x1b]8;;\x07" });
      side.a.close(0, "done");
    }
    expect(sides.flatMap(side => side.logs).filter(line => line.includes("read the system coordinator pane"))).toHaveLength(1);
    expect(captureCoordinator.mock.calls).toEqual([[200], [200]]);
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
    const read = requestPane(failed.a, { op: "coordinator-pane" }, 200);
    await finishing.promise;
    expect(paneReaders.size).toBe(0);
    release.resolve();
    await expect(read).rejects.toThrow();
    expect(failed.logs.filter(line => line.includes("read the system coordinator pane"))).toBeEmpty();
    const deliveries = [];
    for (const readerId of [ID_A, "cd".repeat(32), ID_A, "cd".repeat(32)]) {
      const side = serve({ ...options, readerId });
      await requestPane(side.a, { op: "coordinator-pane" }, 200);
      side.a.close(0, "done");
      await side.done;
      deliveries.push(...side.logs.filter(line => line.includes("read the system coordinator pane")));
    }
    expect(deliveries).toEqual([ID_A, "cd".repeat(32)].map(id =>
      `peer link: Alice (${id.slice(0, 10)}) read the system coordinator pane`));
  });

  test("returns an error when there is no coordinator", async () => {
    const side = serve({ captureCoordinator: async () => null });
    await expect(requestPane(side.a, { op: "coordinator-pane" }, 200)).rejects.toThrow("No system coordinator");
    expect(side.logs.join(" ")).not.toContain("read the system coordinator pane");
    side.a.close(0, "done");
  });

  test.each(["resolve", "reject"])("refuses a removed reader when its pending capture will %s", async outcome => {
    const pending = Promise.withResolvers<typeof pane>();
    const captureCoordinator = mock(() => pending.promise);
    const refused = serve({ peers: new Set(), captureCoordinator });
    await expect(requestPane(refused.a, { op: "coordinator-pane" }, 200)).rejects.toThrow();
    expect(captureCoordinator).not.toHaveBeenCalled();
    const side = serve({ captureCoordinator });
    const read = requestPane(side.a, { op: "coordinator-pane" }, 200);
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
    const read = requestPane(a, { op: "coordinator-pane" }, 200);
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
  clock.advance(60_000); await Bun.sleep(0); clock.advance(750);
  await expect(sent).rejects.toThrow("outcome unknown — check the agent");
  expect(opens).toHaveBeenCalledTimes(1);
  expect(clock.pending()).toBe(0);
  expect(b.closeInfo()).toMatchObject({ byPeer: true, code: 3 });
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

test.each(["writeAll", "finish"] as const)("new-agent reads a busy reply after %s rejects", async op => {
  const { a, b } = createMemoryLink("client", "server");
  const client = await a.openBi();
  a.openBi = async () => client;
  const server = await b.acceptBi();
  client[op] = async () => { throw Error("request half stopped"); };
  try {
    await server.writeAll(encode({ op: "error", reason: "busy, try again" }));
    await server.finish();
    await expect(requestNewAgent(a, { repo: "app", prompt: "x", type: "worker" }, createFakeClock().setTimer)).rejects.toThrow("busy, try again");
    expect(a.closeInfo()).toBeNull();
  } finally { a.close(0, "done"); }
});

test("a flow-controlled write surfaces a finished refusal before cancellation", async () => {
  const { requestSend } = await import("./peer-link");
  const { textHeader } = await import("./peer-outbox");
  const { a, b } = createMemoryLink("client", "server");
  const clock = createFakeClock();
  const writing = Promise.withResolvers<void>();
  const stream = await a.openBi();
  a.openBi = async () => stream;
  stream.write = async () => { writing.resolve(); await a.closed(); throw Error("closed"); };
  const cancelled = spyOn(stream, "resetSending");
  try {
    const result = requestSend(a, textHeader({ kind: "system" }, "hi", { kind: "user" }), clock.setTimer).catch(err => err);
    const peer = await b.acceptBi();
    await writing.promise;
    await peer.writeAll(encode({ op: "error", reason: "busy, try again" }));
    await peer.finish();
    clock.advance(60_000);
    expect((await result).message).toBe("busy, try again");
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(a.closeInfo()).toBeNull();
  } finally { a.close(0, "done"); }
});

test.each([true, false])("the original read observes the whole writer grace (late refusal=%s)", async refused => {
  const { a, b } = createMemoryLink("client", "server");
  const clock = createFakeClock();
  const stream = await a.openBi(); a.openBi = async () => stream;
  const pending = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const reading = spyOn(stream, "readToEnd");
  stream.writeAll = async () => { entered.resolve(); await pending.promise; };
  const peer = await b.acceptBi();
  try {
    const outcome = requestNewAgent(a, { repo: "repo", type: "worker", prompt: "hi" }, clock.setTimer).catch(err => err);
    await entered.promise;
    clock.advance(30_000); await Bun.sleep(0);
    clock.advance(400); pending.resolve();
    if (refused) {
      await peer.writeAll(encode({ op: "error", reason: "late refusal" })); await peer.finish();
      expect((await outcome).message).toContain("late refusal"); expect(a.closeInfo()).toBeNull();
    } else {
      clock.advance(350); expect((await outcome).message).toContain("timed out");
      expect(b.closeInfo()).toMatchObject({ byPeer: true, code: 3 });
    }
    expect(reading).toHaveBeenCalledTimes(1);
  } finally { pending.resolve(); a.close(0, "done"); }
});

test("each partial header write reports a milestone with zero body bytes", async () => {
  const { requestSend } = await import("./peer-link");
  const { a, b } = createMemoryLink("sender", "receiver");
  const open = a.openBi.bind(a);
  let writes = 0;
  spyOn(a, "openBi").mockImplementation(async () => {
    const stream = await open(), write = stream.write.bind(stream);
    stream.write = chunk => { writes++; return write(chunk.subarray(0, 16)); };
    return stream;
  });
  const header = { op: "send", id: crypto.randomUUID(), from: { kind: "user" }, target: { kind: "system" }, message: "hello" } as const;
  const progress: number[] = [];
  const sent = requestSend(a, { ...header, files: [] }, createFakeClock().setTimer, { onProgress: bytes => progress.push(bytes) });
  const peer = await b.acceptBi();
  await peer.readToEnd(4096);
  expect(writes).toBeGreaterThan(1);
  expect(progress).toEqual(Array(writes).fill(0));
  await peer.writeAll(encode({ ok: true, id: header.id }));
  await peer.finish();
  expect(await sent).toBe(header.id);
  a.close(0, "done");
});

test("a client that exits while openBi is pending writes nothing and resets", async () => {
  const { requestSend } = await import("./peer-link");
  const { a, b } = createMemoryLink("sender", "receiver");
  const clock = createFakeClock(), opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const open = a.openBi.bind(a);
  let alive = true, writes = 0, resets = 0;
  spyOn(a, "openBi").mockImplementation(async () => {
    const stream = await open(), reset = stream.resetSending.bind(stream);
    stream.write = async bytes => { writes++; return bytes.length; };
    stream.resetSending = async () => { resets++; return reset(); };
    opened.resolve(); await release.promise; return stream;
  });
  const send = requestSend(a, { op: "send", id: crypto.randomUUID(), target: { kind: "system" },
    from: { kind: "user" }, message: "hi", files: [] }, clock.setTimer, {
      verifyClient() { if (!alive) throw Error("sender exited"); },
    }).catch(err => err);
  const remote = await b.acceptBi();
  await opened.promise; alive = false; release.resolve();
  await waitFor(() => resets === 1);
  await remote.finish();
  expect(String(await send)).toContain("sender exited");
  expect(writes).toBe(0);
  a.close(0, "done");
});
