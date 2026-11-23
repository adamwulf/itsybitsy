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
 * `readToEnd(1 MB)`. The send operation uses a length-prefixed header before FIN.
 *
 * SPEC §20.4 defines the wire shapes for agents, coordinator-pane, new-agent and send.
 *
 * A request over its op-specific cap, or one that is not UTF-8, not JSON, not an object
 * or has no op, closes the connection with {@link PEER_CLOSE.error} and the
 * reason. The agent list carries only the fields of {@link RemoteAgent} (SPEC §20.4), never
 * prompts, logs or tmux output, and never the system coordinator.
 *
 * The transport is the pair protocol's seam ({@link PairConnection}):
 * service.ts adapts the iroh wrapper with `toPairConnection`, and the tests use
 * the in-memory link in test-pair-transport.ts. On that seam, `readToEnd`
 * throws {@link PairProtocolError} when the stream is over its limit.
 */

import { CHUNK_BYTES } from "./transfer-limits";
import { join } from "node:path";
import { openStagedFile } from "./remote-attachments";
import { sendFileBody, type FileBodyOptions, encodeSendHeader, TransferIdleError, decodeSendHeader, requireSendFin, waitForIO, type SendHeader } from "./send-frame";
import { repoDisplayName, type RepoEntry } from "../registry";
import { isValidAgentId } from "../validation";
import type { Agent } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { PairProtocolError, type PairCloseInfo, type PairConnection, type PairStream } from "./pairing";
import { shortPeerId } from "./store";
import { keepAllowedLinks, linkifyMessageUrls } from "../hyperlinks";
import { expandTabs } from "../tmux-poller";
import { stripAnsi } from "../parse-state";

export const PEER_ALPN = "itsybitsy/peer/1";
/** Unframed JSON requests except new-agent. */
export const PEER_MAX_REQUEST_BYTES = 4096;
export const NEW_AGENT_MAX_REQUEST_BYTES = 256 * 1024;
export const NEW_AGENT_TIMEOUT_MS = 30_000;
// Leave the responder time to return an uncertain outcome before the dialer gives up.
const RESPONDER_START_TIMEOUT_MS = 25_000;

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
  coordinator: { state: string } | null;
  repos: RemoteRepo[];
  agents: RemoteAgent[];
}

export interface CoordinatorPane {
  state: string;
  text: string;
}

function sanitizePane(text: string): string {
  return linkifyMessageUrls(keepAllowedLinks(expandTabs(text)));
}

/** Budget the encoded JSON (including escaped newlines, link escapes and UTF-8). */
function encodeCoordinatorPane(pane: CoordinatorPane): Uint8Array {
  const state = cleanRemoteText(pane.state);
  const encode = (text: string) => encodeJson({ op: "coordinator-pane", state, text });
  const text = sanitizePane(pane.text);
  const reply = encode(text);
  if (reply.length <= PEER_MAX_REPLY_BYTES) return reply;

  let remaining = PEER_MAX_REPLY_BYTES - encode("").length;
  const lines = text.split("\n");
  let first = lines.length;
  while (first > 0) {
    const line = lines[first - 1]!;
    const cost = encodeJson(line).length - 2 + (first < lines.length ? 2 : 0);
    if (cost > remaining) break;
    remaining -= cost;
    first--;
  }
  const tail = lines.slice(first).join("\n");
  if (tail.trim() || first === 0 || remaining < 2) return encode(tail);

  // One oversized final line. Take its plain-text suffix on a code point
  // boundary so trimming cannot split a hyperlink or a surrogate pair.
  const chars = Array.from(stripAnsi(lines[first - 1]!));
  if (first < lines.length) remaining -= 2;
  let start = chars.length;
  while (start > 0) {
    remaining -= Buffer.byteLength(JSON.stringify(chars[start - 1])) - 2;
    if (remaining < 0) break;
    start--;
  }
  return encode(chars.slice(start).join("") + (first < lines.length ? "\n" : "") + tail);
}

export function peerSnapshot(repos: readonly RepoEntry[], agents: readonly Agent[], coordinatorState: string | undefined): PeerSnapshot {
  return {
    coordinator: coordinatorState === undefined ? null : { state: coordinatorState },
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
  const flat = singleLine(text);
  return flat.length > MAX_REMOTE_TEXT ? `${flat.slice(0, MAX_REMOTE_TEXT - 1)}…` : flat;
}

function singleLine(text: string) {
  return text.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

function sendDiagnostic(text: string) {
  const flat = singleLine(text);
  // Limit refusals end with the machine and setting. Keep that suffix
  // intact even when the peer supplied a very long filename.
  return flat.length > 300 ? flat.slice(0, 99) + "…" + flat.slice(-200) : flat;
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
export function encodeAgentsReply({ repos, agents, coordinator }: PeerSnapshot): Uint8Array {
  const bytes = encodeJson({ op: "agents", repos, agents, coordinator });
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
  const agents = message.agents.map(parseRemoteAgent);
  const coordinator = message.coordinator;
  if (coordinator === null) return { repos, agents, coordinator };
  if (!coordinator || typeof coordinator !== "object" || !("state" in coordinator) || typeof coordinator.state !== "string") {
    throw new PeerProtocolError("reply has malformed coordinator state");
  }
  return { repos, agents, coordinator: { state: cleanRemoteText(coordinator.state) } };
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
  return decodeAgentsReply(await requestRead(conn, "agents"));
}

async function requestRead(conn: PairConnection, op: string, signal?: AbortSignal): Promise<Uint8Array> {
  const stream = await conn.openBi();
  const cancel = () => { void stream.cancel().catch(() => {}); };
  if (signal?.aborted) {
    cancel();
    throw signal.reason;
  }
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await stream.writeAll(encodePeerRequest(op));
    await stream.finish();
    return await stream.readToEnd(PEER_MAX_REPLY_BYTES);
  } catch (err) {
    if (err instanceof PairProtocolError) throw new PeerProtocolError(`reply longer than ${PEER_MAX_REPLY_BYTES} bytes`);
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function requestCoordinatorPane(conn: PairConnection, signal?: AbortSignal): Promise<CoordinatorPane> {
  const reply = decodeObject(await requestRead(conn, "coordinator-pane", signal), "reply");
  if (reply.ok === false && typeof reply.error === "string") throw new PeerErrorReply(cleanRemoteText(reply.error));
  if (reply.op !== "coordinator-pane" || typeof reply.state !== "string" || typeof reply.text !== "string") {
    throw new PeerProtocolError("malformed coordinator-pane reply");
  }
  return { state: cleanRemoteText(reply.state), text: sanitizePane(reply.text) };
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
    if (reply.ok === true && typeof reply.id === "string" && isValidAgentId(reply.id)) return reply.id;
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

export const SEND_UNKNOWN = "outcome unknown — check the agent";

async function writeWithProgress(stream: PairStream, bytes: Uint8Array, setTimer: PeerResponderDeps["setTimer"], signal?: AbortSignal) {
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    const n = await waitForIO({ setTimer, signal }, () => stream.write(chunk));
    if (!Number.isInteger(n) || n <= 0 || n > chunk.length) throw new Error("Invalid send write count");
    offset += n;
  }
}

export interface OutgoingTransfer {
  filesDir?: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
}

/** One exchange. Once FIN is attempted the peer may already have committed the message. */
export async function requestSend(conn: PairConnection, header: SendHeader, setTimer: PeerResponderDeps["setTimer"], transfer: OutgoingTransfer = {}): Promise<string> {
  if (header.files.length && !transfer.filesDir) throw new Error("Missing staged attachments");
  const bytes = encodeSendHeader(header);
  let stream: PairStream | undefined;
  let finished = false;
  let mayBeQueued = false;
  const io = <T>(operation: () => Promise<T>) => waitForIO({ setTimer, signal: transfer.signal }, operation);
  try {
    const active = await io(async () => {
      const opened = await conn.openBi();
      if (finished) { await opened.cancel(); throw new Error("Remote send timed out"); }
      stream = opened;
      return opened;
    });
    await writeWithProgress(active, bytes, setTimer, transfer.signal);
    let sent = 0;
    // A receiver can reject the header and stop its read half before we
    // finish writing. Read its error ACK on the independent return half.
    let writeError: unknown;
    try {
      for (const [index, file] of header.files.entries()) {
        const handle = await openStagedFile(join(transfer.filesDir!, String(index)), file.size);
        try {
          await sendFileBody({ handle, size: file.size }, { async write(chunk) {
            try { return await active.write(chunk); }
            catch (err) { writeError = err; throw err; }
          } }, { setTimer, signal: transfer.signal, onProgress: bytes => transfer.onProgress?.(sent + bytes) });
        } finally { await handle.close(); }
        sent += file.size;
      }
      transfer.signal?.throwIfAborted();
      mayBeQueued = true;
      await io(() => active.finish());
    } catch (err) {
      if ((!writeError && !mayBeQueued) || err instanceof TransferIdleError || transfer.signal?.aborted) throw err;
      writeError = err;
    }
    const parts: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await io(() => active.read(Math.min(CHUNK_BYTES, PEER_MAX_REPLY_BYTES + 1 - length)));
      if (!chunk.length) break;
      length += chunk.length;
      if (length > PEER_MAX_REPLY_BYTES) throw new Error("Send acknowledgement exceeds limit");
      parts.push(chunk);
    }
    if (!length && writeError) throw writeError;
    const reply = decodeObject(Buffer.concat(parts, length), "reply");
    if (reply.ok === true && reply.id === header.id) return header.id;
    if (reply.ok === false && typeof reply.error === "string") throw new PeerErrorReply(sendDiagnostic(reply.error));
    throw new PeerProtocolError("Malformed send acknowledgement");
  } catch (err) {
    if (stream) {
      if (!await settledWithinGrace(stream.cancel(), { setTimer })) closeQuietly(conn, PEER_CLOSE.error, "send reset stalled");
    } else if (transfer.signal?.aborted || err instanceof TransferIdleError) {
      closeQuietly(conn, PEER_CLOSE.error, "send open interrupted");
    }
    if (mayBeQueued && !(err instanceof PeerErrorReply)) throw new Error(SEND_UNKNOWN);
    throw err;
  } finally { finished = true; }
}

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

export interface ReceiptOptions extends FileBodyOptions { cancelStream?: () => void }

export interface PeerResponderDeps {
  /** Paired name for this id, re-read on every call. A failed read returns null. */
  peerName(id: string): Promise<string | null>;
  /** The agent list to send: built from the watcher's last fully detected snapshot, with no IO. */
  snapshot(): PeerSnapshot;
  receiveMessage?(header: SendHeader, peerId: string, readPeerName: () => Promise<string | null>, body?: Pick<PairStream, "read">, options?: ReceiptOptions): Promise<void>;
  captureCoordinator?(): Promise<CoordinatorPane | null>;
  /** Shared by all connections served by this ib watch. */
  paneReaders?: Set<string>;
  headerReaders?: Set<PairStream>;
  setTimer(ms: number, fn: () => void): () => void;
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
  const headerReaders = deps.headerReaders ??= new Set();
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
    if (headerReaders.size >= 8) {
      void stream.stopReceiving().catch(() => {});
      try {
        await writeWithProgress(stream, encodeJson({ ok: false, error: "busy, try again" }), deps.setTimer);
        await waitForIO(deps, () => stream.finish());
      } catch { closeQuietly(conn, PEER_CLOSE.error, "busy reply stalled"); }
      continue;
    }
    headerReaders.add(stream);
    void serveRequest(conn, stream, from, deps);
  }
}

async function startAgentWithDeadline(
  deps: PeerResponderDeps, request: Record<string, unknown>, peerId: string,
): Promise<string> {
  if (!deps.startAgent) throw new Error("Remote starts are unavailable");
  let expired = false;
  const deadline = Promise.withResolvers<never>();
  const cancel = deps.setTimer(RESPONDER_START_TIMEOUT_MS, () => {
    expired = true;
    deadline.reject(new Error("Remote start outcome unknown after 25 s. Check the peer for the agent."));
  });
  try {
    const spawn = deps.startAgent(request, async () => {
      const name = await deps.peerName(peerId);
      return expired ? null : name;
    });
    return await Promise.race([spawn, deadline.promise]);
  } finally {
    cancel();
  }
}

/** Give the client time to consume its reply, or a reset time to acquire the native stream mutex. */
async function settledWithinGrace(operation: Promise<unknown>, deps: Pick<PeerResponderDeps, "setTimer">): Promise<boolean> {
  const deadline = Promise.withResolvers<false>();
  const cancel = deps.setTimer(5000, () => deadline.resolve(false));
  try {
    return await Promise.race([operation.then(() => true, () => false), deadline.promise]);
  } finally { cancel(); }
}

/** One request on its own stream. Every error stays here. */
async function serveRequest(conn: PairConnection, stream: PairStream, from: string, deps: PeerResponderDeps): Promise<void> {
  let request: ReturnType<typeof decodePeerRequest>;
  try {
    // Every valid sized header begins with zero (the cap is 256 KiB).
    // Other ops begin with JSON. Peek one byte without waiting for FIN.
    const options = { setTimer: deps.setTimer };
    const first = await waitForIO(options, () => stream.read(1));
    if (first[0] === 0) {
      let prefix: Uint8Array | undefined = first;
      const reader = { read: async (limit: number) => {
        if (!prefix) return stream.read(limit);
        const byte = prefix;
        prefix = undefined;
        return byte;
      } };
      let reply;
      let stalledRead = false;
      try {
        const header = await decodeSendHeader(reader, options);
        if (!header.files.length) await requireSendFin(stream, options);
        deps.headerReaders?.delete(stream);
        if (!deps.receiveMessage) throw new Error("Remote sends are unavailable");
        await deps.receiveMessage(header, conn.remoteId, async () => {
          const name = await deps.peerName(conn.remoteId);
          if (name === null) closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
          return name;
        }, stream, { ...options, cancelStream: () => {
          void settledWithinGrace(stream.cancel(), deps).then(ok => {
            if (!ok) closeQuietly(conn, PEER_CLOSE.error, "receive reset stalled");
          });
        } });
        // A replay can acknowledge a previously queued attachment without
        // consuming its duplicate body.
        if (header.files.length) void stream.stopReceiving().catch(() => {});
        reply = { ok: true, id: header.id };
      } catch (err) {
        stalledRead = err instanceof TransferIdleError;
        // STOP_SENDING is independent of the send half. The error ACK can
        // finish even if the native reader is still unwinding a stalled read.
        void stream.stopReceiving().catch(() => {});
        reply = { ok: false, error: sendDiagnostic(errorDetail(err)) };
      }
      try {
        await writeWithProgress(stream, encodeJson(reply), deps.setTimer);
        await waitForIO(options, () => stream.finish());
        if (stalledRead) await settledWithinGrace(conn.closed(), deps);
      } catch {
        if (!await settledWithinGrace(stream.cancel(), deps)) {
          closeQuietly(conn, PEER_CLOSE.error, "send reply stalled");
          return;
        }
      }
      if (stalledRead) closeQuietly(conn, PEER_CLOSE.error, "send read stalled");
      return;
    }
    const rest = await stream.readToEnd(NEW_AGENT_MAX_REQUEST_BYTES - first.length);
    request = decodePeerRequest(Buffer.concat([first, rest]));
  } catch (err) {
    if (err instanceof PeerProtocolError || err instanceof PairProtocolError) {
      // PairProtocolError is the seam's readToEnd past its limit.
      const reason = err instanceof PairProtocolError ? `request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes` : err.message;
      deps.log(`peer link: ${reason}, from ${from}; closing`);
      closeQuietly(conn, PEER_CLOSE.error, reason);
    }
    else if (err instanceof TransferIdleError) closeQuietly(conn, PEER_CLOSE.error, "request read stalled");
    else { void stream.cancel().catch(() => {}); }
    return;
  } finally { deps.headerReaders?.delete(stream); }

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
  let capturedPane = false;
  if (request.op === "agents") {
    try {
      reply = encodeAgentsReply(deps.snapshot());
    } catch (err) {
      deps.log(`peer link: could not build the agent list for ${from}: ${errorDetail(err)}`);
      reply = encodeErrorReply("internal error");
    }
  } else if (request.op === "coordinator-pane") {
    try {
      const pane = await deps.captureCoordinator?.();
      if (!pane) throw new Error("No system coordinator");
      reply = encodeCoordinatorPane(pane);
      capturedPane = true;
    } catch (err) {
      reply = encodeJson({ ok: false, error: cleanRemoteText(errorDetail(err)) });
    }
    // A tmux capture is asynchronous. Pairing must still hold before sending
    // either the capture or the reason it failed.
    if (await deps.peerName(conn.remoteId) === null) {
      closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
      return;
    }
  } else if (request.op === "new-agent") {
    try {
      const id = await startAgentWithDeadline(deps, request, conn.remoteId);
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
    if (capturedPane && deps.paneReaders && !deps.paneReaders.has(conn.remoteId)) {
      deps.paneReaders.add(conn.remoteId);
      deps.log(`peer link: ${peerName} (${from}) read the system coordinator pane`);
    }
  } catch {
    // The dialer went away; its poller reports that on its side.
  }
}
