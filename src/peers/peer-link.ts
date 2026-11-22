/**
 * The trusted link between paired installs (docs/plans/iroh-peering.md,
 * "Reconnection" and "First connected feature"; SPEC.md §20.4).
 *
 * ALPN `itsybitsy/peer/1`. Only ids listed in `peers.json` may use it:
 *   - the responder re-reads `peers.json` for every accepted connection and
 *     closes any other id with {@link PEER_CLOSE.notPeer} before reading
 *     anything from it;
 *   - it re-reads the file again for EVERY request on a live connection, both
 *     when the request's stream is accepted and again right before it is
 *     answered, so `ib peer remove` takes effect on the next answer (even for
 *     a stream opened before the removal) rather than the next dial.
 *
 * Each request uses its own bi stream: the dialer writes one JSON object and
 * calls `finish`; the responder reads the bounded request, writes one
 * JSON reply and calls `finish`; the dialer reads the reply with
 * `readToEnd(1 MB)`. No framing code.
 *
 *   dialer    → {"op":"agents"}
 *   responder → {"op":"agents","repos":[{registryName, displayName}, …],"agents":[{id, nickname, repoName, repoRegistryName, repoPath, state, agentType, manager}, …]}
 *             | {"op":"error","reason":"…"}   (an unknown op, a list over 1 MB, an internal error)
 *
 * A request over its op-specific cap, or one that is not UTF-8, not JSON, not an object
 * or has no op, closes the connection with {@link PEER_CLOSE.error} and the
 * reason. The agent list carries exactly the eight fields above, never
 * prompts, logs or tmux output, and never the system coordinator.
 *
 * The transport is the pair protocol's seam ({@link PairConnection}):
 * service.ts adapts the iroh wrapper with `toPairConnection`, and the tests use
 * the in-memory link in test-pair-transport.ts. On that seam, `readToEnd`
 * throws {@link PairProtocolError} when the stream is over its limit.
 */

import { repoDisplayName, type RepoEntry } from "../registry";
import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { PairProtocolError, type PairCloseInfo, type PairConnection, type PairStream } from "./pairing";
import { shortPeerId } from "./store";

export const PEER_ALPN = "itsybitsy/peer/1";
/** All requests except new-agent. */
export const PEER_MAX_REQUEST_BYTES = 4096;
export const NEW_AGENT_MAX_REQUEST_BYTES = 256 * 1024;
export const NEW_AGENT_TIMEOUT_MS = 30_000;

export interface RemoteNewAgentRequest {
  repo: string;
  type: string;
  name?: string;
  prompt: string;
}
/** Longest reply the dialer reads (`readToEnd` limit), and the cap on the agent list. */
export const PEER_MAX_REPLY_BYTES = 1_048_576;

/** Connection close codes on the trusted ALPN. */
export const PEER_CLOSE = {
  /** A normal close: this side is shutting down, stopped polling the peer, or gave up on a request that timed out. */
  done: 0,
  /** The other side's id is not in this install's `peers.json`. */
  notPeer: 1,
  /** A malformed request. The reason says which. */
  error: 3,
} as const;

/** Longest piece of text from the other side that is shown or logged. */
const MAX_REMOTE_TEXT = 80;
/** Longest close reason this side sends. */
const MAX_CLOSE_REASON = 100;

/** One agent as the other install reports it. Exactly these fields cross the wire. */
export interface RemoteAgent {
  id: string;
  nickname: string | null;
  /** The repo's display name on the other install (its nickname, else its registry name): what is shown. */
  repoName: string;
  /** The repo's registry name on the other install: what the row is keyed by (SPEC §20.5). */
  repoRegistryName: string;
  repoPath: string;
  /** The agent's state on the other install (an AgentState there; kept as text here). */
  state: string;
  agentType: string | null;
  /** The id of the agent's manager, so the receiving side can nest it. */
  manager: string | null;
}

export interface RemoteRepo {
  registryName: string;
  displayName: string;
}

export interface PeerSnapshot {
  repos: RemoteRepo[];
  agents: RemoteAgent[];
}

export function peerSnapshot(repos: readonly RepoEntry[], agents: readonly Agent[]): PeerSnapshot {
  return {
    repos: repos.map((repo) => ({ registryName: repo.name, displayName: repoDisplayName(repo) })),
    agents: toRemoteAgents(agents),
  };
}

/** A request, reply or agent entry that is malformed, oversized, or not what the protocol allows. */
export class PeerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerProtocolError";
  }
}

/** The other side answered a request with `{"op":"error"}`. */
export class PeerErrorReply extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerErrorReply";
  }
}

/**
 * Text from the other side, made safe to show: control characters become
 * spaces, format characters (bidi overrides, zero-width marks: \p{Cf}) are
 * dropped, one line, capped.
 */
export function cleanRemoteText(text: string): string {
  const flat = text.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_REMOTE_TEXT ? `${flat.slice(0, MAX_REMOTE_TEXT - 1)}…` : flat;
}

/**
 * The reply's agent list, from the watcher's last fully detected snapshot
 * (`AgentWatcher.lastDetectedAgents` in `ib watch`): the eight
 * allowed fields of each agent, and no system coordinator. (The system
 * coordinator has no agent directory, so the watcher never lists it; the
 * filter keeps it out even if that changes.)
 */
export function toRemoteAgents(agents: readonly Agent[]): RemoteAgent[] {
  return agents
    .filter((a) => a.meta.agentType !== SYSTEM_COORDINATOR_TYPE)
    .map((a) => ({
      id: a.id,
      nickname: a.meta.nickname ?? null,
      repoName: a.repoName,
      repoRegistryName: a.repoRegistryName,
      repoPath: a.repoPath,
      state: a.state,
      agentType: a.meta.agentType ?? null,
      manager: a.meta.manager ?? null,
    }));
}

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

export function encodePeerRequest(op: string): Uint8Array {
  return encodeJson({ op });
}

function encodeErrorReply(reason: string): Uint8Array {
  return encodeJson({ op: "error", reason });
}

/** The `agents` reply, or an error reply when the list is over {@link PEER_MAX_REPLY_BYTES}. */
export function encodeAgentsReply({ repos, agents }: PeerSnapshot): Uint8Array {
  const bytes = encodeJson({ op: "agents", repos, agents });
  if (bytes.length > PEER_MAX_REPLY_BYTES) return encodeErrorReply(`the agent list is over ${PEER_MAX_REPLY_BYTES} bytes`);
  return bytes;
}

function decodeObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PeerProtocolError(`${what} is not UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PeerProtocolError(`${what} is not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PeerProtocolError(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Keep the payload untrusted until the handler validates its fields. */
export function decodePeerRequest(bytes: Uint8Array): Record<string, unknown> & { op: string } {
  const message = decodeObject(bytes, "request");
  if (typeof message.op !== "string") throw new PeerProtocolError("request has no op");
  const limit = message.op === "new-agent" ? NEW_AGENT_MAX_REQUEST_BYTES : PEER_MAX_REQUEST_BYTES;
  if (bytes.length > limit) throw new PeerProtocolError(`request longer than ${limit} bytes`);
  return { ...message, op: message.op };
}

/**
 * Strip control and format characters from a field the other side sent, so it
 * is safe to draw in the TUI: \p{Cc} (escape sequences, newlines, tabs) and
 * \p{Cf} (bidi overrides that reorder the rest of the row, zero-width marks).
 */
const cleanField = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, "");

function parseRemoteAgent(entry: unknown, index: number): RemoteAgent {
  const malformed = () => new PeerProtocolError(`agent ${index} in the reply is malformed`);
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw malformed();
  const e = entry as Record<string, unknown>;
  const required = (key: string): string => {
    const value = e[key];
    if (typeof value !== "string") throw malformed();
    return cleanField(value);
  };
  const optional = (key: string): string | null => {
    const value = e[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw malformed();
    return cleanField(value);
  };
  // A new object with only the allowed fields: anything else the other side
  // sent is dropped here.
  return {
    id: required("id"),
    nickname: optional("nickname"),
    repoName: required("repoName"),
    repoRegistryName: required("repoRegistryName"),
    repoPath: required("repoPath"),
    state: required("state"),
    agentType: optional("agentType"),
    manager: optional("manager"),
  };
}

/**
 * Parse an `agents` reply. Throws {@link PeerErrorReply} for an error reply
 * and {@link PeerProtocolError} for anything malformed.
 */
export function decodeAgentsReply(bytes: Uint8Array): PeerSnapshot {
  const message = decodeObject(bytes, "reply");
  if (message.op === "error") {
    const reason = typeof message.reason === "string" ? cleanRemoteText(message.reason) : "";
    throw new PeerErrorReply(`the other side reported: ${reason || "an error"}`);
  }
  if (message.op !== "agents" || !Array.isArray(message.agents)) throw new PeerProtocolError("reply is not an agent list");
  if (!Array.isArray(message.repos)) throw new PeerProtocolError("reply has no repo list");
  const repos = message.repos.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== "object" || !("registryName" in entry) || typeof entry.registryName !== "string"
        || !("displayName" in entry) || typeof entry.displayName !== "string") {
      throw new PeerProtocolError(`repo ${i} in the reply is malformed`);
    }
    return { registryName: cleanField(entry.registryName), displayName: cleanField(entry.displayName) };
  });
  return { repos, agents: message.agents.map(parseRemoteAgent) };
}

/** What a close of the trusted connection means, as the poller shows it. */
export function describePeerClose(info: PairCloseInfo): string {
  if (!info.byPeer) return cleanRemoteText(info.reason) || "connection closed";
  switch (info.code) {
    case PEER_CLOSE.notPeer:
      return "not a peer";
    case PEER_CLOSE.error:
      return `the other side reported: ${cleanRemoteText(info.reason) || "an error"}`;
    default:
      return "closed by the other side";
  }
}

export function closeQuietly(conn: PairConnection, code: number, reason: string): void {
  try {
    if (conn.closeInfo() === null) conn.close(code, reason.slice(0, MAX_CLOSE_REASON));
  } catch {
    // Already gone.
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Dialer
// ---------------------------------------------------------------------------

/**
 * Ask for the other install's agents on its own bi stream. Throws on any
 * failure: the transport's error, a {@link PeerErrorReply}, or a
 * {@link PeerProtocolError} for a malformed or oversized reply.
 */
export async function requestAgents(conn: PairConnection): Promise<PeerSnapshot> {
  const stream = await conn.openBi();
  await stream.writeAll(encodePeerRequest("agents"));
  await stream.finish();
  let bytes: Uint8Array;
  try {
    bytes = await stream.readToEnd(PEER_MAX_REPLY_BYTES);
  } catch (err) {
    if (err instanceof PairProtocolError) throw new PeerProtocolError(`reply longer than ${PEER_MAX_REPLY_BYTES} bytes`);
    throw err;
  }
  return decodeAgentsReply(bytes);
}

/** Use a separate stream on the live trusted connection. Never retry a spawn. */
export async function requestNewAgent(
  conn: PairConnection,
  { repo, type, name, prompt }: RemoteNewAgentRequest,
  setTimer: (ms: number, fn: () => void) => () => void,
): Promise<string> {
  const bytes = encodeJson({ op: "new-agent", repo, type, name, prompt });
  if (bytes.length > NEW_AGENT_MAX_REQUEST_BYTES) throw new PeerProtocolError(`request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes`);
  const exchange = async () => {
    const stream = await conn.openBi();
    await stream.writeAll(bytes);
    await stream.finish();
    const reply = decodeObject(await stream.readToEnd(PEER_MAX_REPLY_BYTES), "reply");
    if (reply.ok === true && typeof reply.id === "string" && cleanField(reply.id)) return cleanField(reply.id);
    if (reply.ok === false && typeof reply.error === "string") throw new PeerErrorReply(cleanRemoteText(reply.error));
    throw new PeerProtocolError("malformed new-agent reply");
  };
  let cancel: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    cancel = setTimer(NEW_AGENT_TIMEOUT_MS, () => {
      reject(new Error("Remote agent request timed out after 30 s. Check the peer for the agent."));
      closeQuietly(conn, PEER_CLOSE.done, "request timed out");
    });
  });
  try {
    return await Promise.race([exchange(), timeout]);
  } finally {
    cancel?.();
  }
}

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

export interface PeerResponderDeps {
  /** Paired name for this id, re-read on every call. A failed read returns null. */
  peerName(id: string): Promise<string | null>;
  /** The agent list to send: built from the watcher's last fully detected snapshot, with no IO. */
  snapshot(): PeerSnapshot;
  startAgent?(request: Record<string, unknown>, readPeerName: () => Promise<string | null>): Promise<string>;
  /** watch.log in `ib watch`. */
  log(line: string): void;
}

/**
 * Serve one accepted trusted-ALPN connection until it closes. Checks the
 * allowlist before reading anything, again when each request's stream is
 * accepted, and again right before each answer. Each request runs in its own
 * task with its own error handling. Never throws.
 */
export async function serveTrustedConnection(conn: PairConnection, deps: PeerResponderDeps): Promise<void> {
  const from = shortPeerId(conn.remoteId);
  if ((await deps.peerName(conn.remoteId)) === null) {
    deps.log(`peer link: closed a connection from ${from}: not a peer`);
    closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
    return;
  }
  deps.log(`peer link: ${from} connected`);
  for (;;) {
    let stream: PairStream;
    try {
      stream = await conn.acceptBi();
    } catch {
      return; // the connection closed
    }
    if ((await deps.peerName(conn.remoteId)) === null) {
      deps.log(`peer link: refused a request from ${from}: no longer a peer; closing`);
      closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
      return;
    }
    void serveRequest(conn, stream, from, deps);
  }
}

/** One request on its own stream. Every error stays here. */
async function serveRequest(conn: PairConnection, stream: PairStream, from: string, deps: PeerResponderDeps): Promise<void> {
  let request: ReturnType<typeof decodePeerRequest>;
  try {
    request = decodePeerRequest(await stream.readToEnd(NEW_AGENT_MAX_REQUEST_BYTES));
  } catch (err) {
    if (err instanceof PeerProtocolError || err instanceof PairProtocolError) {
      // PairProtocolError is the seam's readToEnd past its limit.
      const reason = err instanceof PairProtocolError ? `request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes` : err.message;
      deps.log(`peer link: ${reason}, from ${from}; closing`);
      closeQuietly(conn, PEER_CLOSE.error, reason);
    }
    // Anything else: the stream or the connection is gone; there is no one to answer.
    return;
  }

  // Again now, right before answering: the stream was accepted on its first
  // frame, and a client can hold it open across `ib peer remove` before it
  // finishes the request. The answer reflects peers.json as of this moment.
  const peerName = await deps.peerName(conn.remoteId);
  if (peerName === null) {
    deps.log(`peer link: refused a request from ${from}: no longer a peer; closing`);
    closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
    return;
  }

  let reply: Uint8Array;
  if (request.op === "agents") {
    try {
      reply = encodeAgentsReply(deps.snapshot());
    } catch (err) {
      deps.log(`peer link: could not build the agent list for ${from}: ${errorDetail(err)}`);
      reply = encodeErrorReply("internal error");
    }
  } else if (request.op === "new-agent") {
    try {
      if (!deps.startAgent) throw new Error("Remote starts are unavailable");
      const id = await deps.startAgent(request, () => deps.peerName(conn.remoteId));
      reply = encodeJson({ ok: true, id });
    } catch (err) {
      const error = cleanRemoteText(errorDetail(err));
      deps.log(`peer link: new-agent from ${from} failed: ${error}`);
      reply = encodeJson({ ok: false, error });
    }
  } else {
    reply = encodeErrorReply(`unknown op ${JSON.stringify(cleanRemoteText(request.op))}`);
  }
  try {
    await stream.writeAll(reply);
    await stream.finish();
  } catch {
    // The dialer went away; its poller reports that on its side.
  }
}
