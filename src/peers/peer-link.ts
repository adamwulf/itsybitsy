import { suggestedAddress } from "../resolve-target";
import { AmbiguousRemoteRehire, lifecycleTimeout, parseLifecycleRequest, type RemoteLifecycleOutcome, type RemoteLifecycleRequest } from "./remote-lifecycle";
import { parsePermissionRequest, type RemotePermissionOutcome, type RemotePermissionRequest } from "./remote-permissions";
import { trackSendCleanup } from "../send-cleanup";
import { singleLine } from "./single-line";
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
 * `readToEnd(1 MB)`. The send operation, and a new-agent request with
 * attachments, use a length-prefixed header and file bodies before FIN.
 * A stream whose first byte is 1 is a long-lived remote terminal, served by
 * terminal-host.ts (SPEC §20.4 "Remote terminal").
 *
 * SPEC §20.4 defines the wire shapes for agents, pane and prompt reads, new-agent, lifecycle, acknowledge, permissions and send.
 * A `watch-log` reply (`ib export-logs`, "Watch log copies") is framed like `agent-diff`.
 *
 * A request over its op-specific cap, or one that is not UTF-8, not JSON, not an object
 * or has no op, closes the connection with {@link PEER_CLOSE.error} and the
 * reason. The agent list carries only the fields of {@link RemoteAgent} (SPEC §20.4), never
 * prompts, logs or tmux output, and never the system coordinator. A prompt is read
 * on its own request, only while the other side shows it.
 *
 * The transport is the pair protocol's seam ({@link PairConnection}):
 * service.ts adapts the iroh wrapper with `toPairConnection`, and the tests use
 * the in-memory link in test-pair-transport.ts. On that seam, `readToEnd`
 * throws {@link PairProtocolError} when the stream is over its limit.
 */

import { CHUNK_BYTES, IDLE_TIMEOUT_MS } from "./transfer-limits";
import type { TransferActivity } from "./transfer-activity";
import { createHash } from "node:crypto";
import { MAX_AGENT_DIFF_BYTES, type AgentDiff } from "./agent-diff";
import { describeWatchLogFiles, isWatchLogFileName, totalWatchLogBytes, WATCH_LOG_FILE_NAMES, WATCH_LOG_MAX_BYTES, type PeerWatchLog, type WatchLogFile } from "./watch-log-files";
import { join } from "node:path";
import { openStagedFile } from "./remote-attachments";
import {
  decodeFrameHeader, encodeFrameHeader, encodeSendHeader, parseNewAgentHeader, parseSendHeader, readHeaderBytes, requireSendFin,
  sendFileBody, streamFileBody, TransferIdleError, waitForIO, type AttachmentEntry, type FileBodyOptions, type NewAgentHeader, type SendHeader,
} from "./send-frame";
import { isStoredRepoName, repoDisplayName, type RepoEntry } from "../registry";
import { isValidAgentId } from "../validation";
import type { Agent, PendingQuestion } from "../agents";
import { SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { isSafeCloneRelPath } from "../clone-repo";
import { PairProtocolError, type PairCloseInfo, type PairConnection, type PairStream } from "./pairing";
import { shortPeerId } from "./store";
import { keepAllowedLinks, linkifyMessageUrls } from "../hyperlinks";
import { expandTabs } from "../tmux-poller";
import { stripAnsi } from "../parse-state";
import { TERMINAL_FRAME } from "./terminal-frame";
import { TERMINALS_UNAVAILABLE, serveTerminal, type TerminalHostDeps } from "./terminal-host";

export const PEER_ALPN = "itsybitsy/peer/1";
/** Unframed JSON requests except new-agent. */
export const PEER_MAX_REQUEST_BYTES = 4096;
export const NEW_AGENT_MAX_REQUEST_BYTES = 256 * 1024;
export const NEW_AGENT_TIMEOUT_MS = 30_000;
/**
 * Deadline for an `agents` poll, a pane read, an agent-prompt read and an
 * acknowledge on a live connection. A kept request (SPEC.md §20.4 "Slow
 * links") asks its keep rule again at this interval.
 */
export const PEER_REQUEST_TIMEOUT_MS = 30_000;
// Leave the responder time to return an uncertain outcome before the dialer gives up.
const RESPONDER_START_TIMEOUT_MS = 25_000;
/**
 * "Files received": the first byte of a framed new-agent's reply once the
 * responder has received, verified and committed every body, before it spawns.
 * The dialer starts its {@link NEW_AGENT_TIMEOUT_MS} deadline when it reads it.
 * It is JSON whitespace, so the reply after it parses as before.
 */
export const NEW_AGENT_FILES_RECEIVED = Uint8Array.of(0x0a);

export interface RemoteNewAgentRequest {
  repo: string;
  type: string;
  name?: string;
  prompt: string;
  /** A scheduled task's auto-retire switch (SPEC §21.2): the receiver passes it to `newAgent`. */
  autoRetire?: boolean;
  /** Staged attachments, numbered in `OutgoingTransfer.filesDir`. With any, the request is framed like `send`. */
  files?: AttachmentEntry[];
}
/** Longest reply the dialer reads (`readToEnd` limit), and the cap on the agent list. */
export const PEER_MAX_REPLY_BYTES = 1_048_576;

/**
 * The send priority of a request stream that carries attachment bodies (a
 * send or new-agent with files; SPEC §20.4 "Slow links"). Every other stream
 * keeps the default 0, so a poll, pane read, reply or other request written
 * on the same connection goes out ahead of queued body bytes.
 */
export const ATTACHMENT_BODY_PRIORITY = -1;

/** Connection close codes on the trusted ALPN. */
export const PEER_CLOSE = {
  /** A normal close: this side is shutting down or stopped polling the peer. */
  done: 0,
  /** The other side's id is not in this install's `peers.json`. */
  notPeer: 1,
  /** A protocol error or stream teardown still pending at the grace deadline. */
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
  /** The agent's `meta.created_epoch` (seconds), so the receiving side can sort it in spawn order. */
  createdEpoch: number;
  /** The agent's `meta.model` (`<cli>:<model>`), so the receiving side slices the right CLI's input box off its capture and shows it as the info panel's `Model:` row. */
  model: string | null;
}

export interface RemoteRepo {
  registryName: string;
  displayName: string;
  /** The repo's `remote.origin.url` on the other install, as configured minus credentials; what "Clone here" clones (SPEC §20.5). */
  remoteUrl: string | null;
  /** The repo's path under the other install's clone root, e.g. `swift-packages/Foo`; sanitized on receipt. */
  relPath: string | null;
}

/** A pending `ib ask` question of an agent in the same reply (SPEC §20.4). Exactly these fields cross the wire. */
export interface RemoteQuestion {
  id: string;
  /** The asking agent's id. */
  agent: string;
  /** The asking agent's repo registry name on the other install. */
  repoRegistryName: string;
  /** Multi-line: newlines are kept. */
  question: string;
  timestamp: string;
}

export interface PeerSnapshot {
  coordinator: { state: string } | null;
  repos: RemoteRepo[];
  agents: RemoteAgent[];
  questions: RemoteQuestion[];
}

export type PeerPaneTarget = { op: "coordinator-pane" } | { op: "agent-pane"; repo: string; id: string };

export function clampPaneLines(lines: number): number {
  return Math.min(5000, Math.max(200, Math.trunc(lines)));
}

export interface PeerPane {
  state: string;
  text: string;
}

function sanitizePane(text: string): string {
  return linkifyMessageUrls(keepAllowedLinks(expandTabs(text)));
}

/** Budget the encoded JSON (including escaped newlines, link escapes and UTF-8). */
function encodePane(op: PeerPaneTarget["op"], pane: PeerPane): Uint8Array {
  const state = cleanRemoteText(pane.state);
  const encode = (text: string) => encodeJson({ op, state, text });
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

/**
 * The `agents` reply. `questions` are the watcher's pending questions from the
 * same refresh as `agents`: only those of an agent the reply sends, each named
 * by that agent's repo registry name. `cloneInfo` is the dashboard's cache of
 * each repo's clone fields, by repo path, refreshed off this path, so the
 * answer costs no IO; a repo it has not read yet reports null for both.
 */
export function peerSnapshot(
  repos: readonly RepoEntry[],
  agents: readonly Agent[],
  questions: readonly PendingQuestion[],
  coordinatorState: string | undefined,
  cloneInfo: ReadonlyMap<string, Pick<RemoteRepo, "remoteUrl" | "relPath">>,
): PeerSnapshot {
  const sent = toRemoteAgents(agents);
  const registryNames = new Map(sent.map((agent) => [`${agent.repoPath}\0${agent.id}`, agent.repoRegistryName]));
  return {
    coordinator: coordinatorState === undefined ? null : { state: coordinatorState },
    repos: repos.map((repo) => {
      const info = cloneInfo.get(repo.path);
      return { registryName: repo.name, displayName: repoDisplayName(repo), remoteUrl: info?.remoteUrl ?? null, relPath: info?.relPath ?? null };
    }),
    agents: sent,
    questions: questions.flatMap((q) => {
      const repoRegistryName = registryNames.get(`${q.repoPath}\0${q.agent}`);
      return repoRegistryName === undefined ? []
        : [{ id: q.id, agent: q.agent, repoRegistryName, question: q.question, timestamp: q.timestamp }];
    }),
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

function sendDiagnostic(text: string) {
  const flat = singleLine(text);
  // Limit refusals end with the machine and setting. Keep that suffix
  // intact even when the peer supplied a very long filename.
  return flat.length > 300 ? flat.slice(0, 99) + "…" + flat.slice(-200) : flat;
}

/**
 * The reply's agent list, from the watcher's last fully detected snapshot
 * (`AgentWatcher.lastDetectedAgents` in `ib watch`): the ten
 * allowed fields of each agent, and no system coordinator. (The system
 * coordinator has no agent directory, so the watcher never lists it; the
 * filter keeps it out even if that changes.)
 */
export function toRemoteAgents(agents: readonly Agent[]): RemoteAgent[] {
  return agents
    .filter((a) => !a.metadataError && a.meta.agentType !== SYSTEM_COORDINATOR_TYPE)
    .map((a) => ({
      id: a.id,
      nickname: a.meta.nickname ?? null,
      repoName: a.repoName,
      repoRegistryName: a.repoRegistryName,
      repoPath: a.repoPath,
      state: a.state,
      agentType: a.meta.agentType ?? null,
      manager: a.meta.manager ?? null,
      createdEpoch: a.meta.created_epoch,
      model: a.meta.model ?? null,
    }));
}

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

export function encodePeerRequest(op: string): Uint8Array {
  return encodeJson({ op });
}

export class PeerBusyReply extends PeerErrorReply {}

function encodeErrorReply(reason: string): Uint8Array {
  return encodeJson({ op: "error", reason });
}

/** The `agents` reply, or an error reply when the list is over {@link PEER_MAX_REPLY_BYTES}. */
export function encodeAgentsReply({ repos, agents, coordinator, questions }: PeerSnapshot): Uint8Array {
  const bytes = encodeJson({ op: "agents", repos, agents, coordinator, questions });
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
/** {@link cleanField} for multi-line text: newlines are kept and tabs become spaces. */
const cleanLines = (text: string): string => expandTabs(text).replace(/[^\P{Cc}\n]|\p{Cf}/gu, "");

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
  const { createdEpoch } = e;
  if (typeof createdEpoch !== "number" || !Number.isFinite(createdEpoch)) throw malformed();
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
    createdEpoch,
    model: optional("model"),
  };
}

function parseRemoteQuestion(entry: unknown, index: number): RemoteQuestion {
  const malformed = () => new PeerProtocolError(`question ${index} in the reply is malformed`);
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw malformed();
  const e = entry as Record<string, unknown>;
  const required = (key: string): string => {
    const value = e[key];
    if (typeof value !== "string") throw malformed();
    return value;
  };
  return {
    id: cleanField(required("id")),
    agent: cleanField(required("agent")),
    repoRegistryName: cleanField(required("repoRegistryName")),
    question: cleanLines(required("question")),
    timestamp: cleanField(required("timestamp")),
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
    if (reason === "busy, try again") throw new PeerBusyReply(reason);
    throw new PeerErrorReply(`the other side reported: ${reason || "an error"}`);
  }
  if (message.op !== "agents" || !Array.isArray(message.agents)) throw new PeerProtocolError("reply is not an agent list");
  if (!Array.isArray(message.repos)) throw new PeerProtocolError("reply has no repo list");
  const repos = message.repos.map((entry: unknown, i: number): RemoteRepo => {
    const malformed = () => new PeerProtocolError(`repo ${i} in the reply is malformed`);
    if (!entry || typeof entry !== "object" || !("registryName" in entry) || typeof entry.registryName !== "string"
        || !("displayName" in entry) || typeof entry.displayName !== "string") {
      throw malformed();
    }
    const optional = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") throw malformed();
      return value;
    };
    const remoteUrl = optional("remoteUrl" in entry ? entry.remoteUrl : undefined);
    const relPath = optional("relPath" in entry ? entry.relPath : undefined);
    return {
      registryName: cleanField(entry.registryName),
      displayName: cleanField(entry.displayName),
      remoteUrl: safeRemoteUrl(remoteUrl),
      relPath: safeRelPath(relPath),
    };
  });
  const agents = message.agents.map(parseRemoteAgent);
  if (!Array.isArray(message.questions)) throw new PeerProtocolError("reply has no question list");
  // Only the questions of an agent in this reply: the receiving tree has a row for nothing else.
  const askers = new Set(agents.map((agent) => `${agent.repoRegistryName}\0${agent.id}`));
  const questions = message.questions.map(parseRemoteQuestion)
    .filter((q) => askers.has(`${q.repoRegistryName}\0${q.agent}`));
  const coordinator = message.coordinator;
  if (coordinator === null) return { repos, agents, coordinator, questions };
  if (!coordinator || typeof coordinator !== "object" || !("state" in coordinator) || typeof coordinator.state !== "string") {
    throw new PeerProtocolError("reply has malformed coordinator state");
  }
  return { repos, agents, coordinator: { state: cleanRemoteText(coordinator.state) }, questions };
}

/**
 * A peer's `remoteUrl`, or null when it is empty or carries any control or
 * format character: such a URL is dropped, not cleaned into a different one.
 * What is left is checked against the clone URL grammar when `c` is pressed
 * and again in cloneRepo (SPEC §20.5).
 */
function safeRemoteUrl(remoteUrl: string | null): string | null {
  return remoteUrl === null || remoteUrl === "" || /[\p{Cc}\p{Cf}]/u.test(remoteUrl) ? null : remoteUrl;
}

/** Longest `relPath` kept from the other side. */
const MAX_REL_PATH = 512;

/**
 * A peer's `relPath` as this side may join it under its own clone root, or
 * null: an absolute path, a segment {@link isSafeCloneRelPath} refuses (empty,
 * `.`, `..`, or `.git` or `.itsybitsy` in any case), a backslash, NUL or any
 * other control or format character, or more than {@link MAX_REL_PATH}
 * characters all drop it, so the clone falls back to `<root>/<name>`.
 */
function safeRelPath(relPath: string | null): string | null {
  if (relPath === null || relPath.length > MAX_REL_PATH || relPath.startsWith("/") || /[\\\p{Cc}\p{Cf}]/u.test(relPath)) return null;
  return isSafeCloneRelPath(relPath) ? relPath : null;
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

/** How long a connection was up, for its disconnect line: `45s`, `7m05s`, `2h03m`. */
export function formatLinkUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h${pad(Math.floor(seconds / 60) % 60)}m`;
}

/**
 * The line both ends write when a trusted connection that was up closes
 * (SPEC §20.4 "Connection log lines"); agents grep both machines' logs for it.
 */
export function disconnectLine(name: string, id: string, how: "dialed" | "accepted", upMs: number, reason: string): string {
  return `peer link: ${name} (${shortPeerId(id)}): disconnected (${how}, up ${formatLinkUptime(upMs)}): ${reason}`;
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
type Timer = PeerResponderDeps["setTimer"];
const realTimer: Timer = (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); };

export function requestAgents(conn: PairConnection, setTimer = realTimer, timeoutError = new Error("request timed out"), keepOpenOnTimeout?: () => boolean): Promise<PeerSnapshot> {
  return clientExchange(conn, encodePeerRequest("agents"), decodeAgentsReply, { setTimer, timeout: [PEER_REQUEST_TIMEOUT_MS, timeoutError], keepOpenOnTimeout });
}

export function requestPane(conn: PairConnection, target: PeerPaneTarget, lines: number, setTimer = realTimer, keepOpenOnTimeout?: () => boolean): Promise<PeerPane> {
  return clientExchange(conn, encodeJson({ ...target, lines: clampPaneLines(lines) }), bytes => {
    const reply = decodeObject(bytes, "reply");
    if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(cleanRemoteText(reply.reason));
    if (reply.op !== target.op || typeof reply.state !== "string" || typeof reply.text !== "string") {
      throw new PeerProtocolError(`malformed ${target.op} reply`);
    }
    return { state: cleanRemoteText(reply.state), text: sanitizePane(reply.text) };
  }, { setTimer, timeout: [PEER_REQUEST_TIMEOUT_MS, new Error(target.op === "agent-pane" ? "Agent pane request timed out" : "Coordinator pane request timed out")], keepOpenOnTimeout });
}

/** The agent's prompt as its own INITIAL PROMPT pane shows it, safe to draw. */
export function requestAgentPrompt(conn: PairConnection, repo: string, id: string, setTimer = realTimer): Promise<string> {
  return clientExchange(conn, encodeJson({ op: "agent-prompt", repo, id }), bytes => {
    const reply = decodeObject(bytes, "reply");
    if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(cleanRemoteText(reply.reason));
    if (reply.op !== "agent-prompt" || typeof reply.prompt !== "string") throw new PeerProtocolError("malformed agent-prompt reply");
    return cleanLines(reply.prompt);
  }, { setTimer, timeout: [PEER_REQUEST_TIMEOUT_MS, new Error("Agent prompt request timed out")] });
}

export function requestAgentDiff(conn: PairConnection, repo: string, id: string, setTimer = realTimer): Promise<AgentDiff> {
  return clientExchange(conn, encodeJson({ op: "agent-diff", repo, id }), { read: readDiffReply }, { setTimer });
}

async function readDiffReply(stream: Pick<PairStream, "read">, options: FileBodyOptions): Promise<AgentDiff> {
  const prefix = await readHeaderBytes(stream, 4, options);
  if (prefix[0] !== 0) {
    // Standard JSON refusal, including a busy or older peer.
    const parts = [prefix];
    let length = prefix.length;
    while (length <= PEER_MAX_REQUEST_BYTES) {
      const chunk = await waitForIO(options, () => stream.read(PEER_MAX_REQUEST_BYTES + 1 - length));
      if (!chunk.length) {
        const reply = decodeObject(Buffer.concat(parts), "reply");
        if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(sendDiagnostic(reply.reason));
        break;
      }
      parts.push(Buffer.from(chunk));
      length += chunk.length;
    }
    throw new PeerProtocolError("Malformed agent-diff reply");
  }
  const header = await decodeFrameHeader(stream, prefix, options);
  if (!header || typeof header !== "object" || !("op" in header) || header.op !== "agent-diff" ||
      !("base" in header) || typeof header.base !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(header.base) ||
      !("sha256" in header) || typeof header.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(header.sha256) ||
      !("size" in header) || typeof header.size !== "number" || !Number.isSafeInteger(header.size) ||
      header.size < 1 || header.size > MAX_AGENT_DIFF_BYTES) throw new PeerProtocolError("Malformed agent-diff header");
  const patch = Buffer.allocUnsafe(header.size);
  let offset = 0;
  const digest = await streamFileBody(stream, header.size, chunk => {
    patch.set(chunk, offset);
    offset += chunk.length;
  }, options);
  if (digest !== header.sha256) throw new PeerProtocolError("Agent diff hash mismatch");
  await requireSendFin(stream, options);
  return { base: header.base, patch };
}

/**
 * Copy the other install's watch log files (SPEC §20.4 "Watch log copies").
 * `clock` (epoch ms) stamps the request and the reply on this side, so the
 * caller can compare the peer's `now` with this machine's clock. There is no
 * overall deadline: each read has the transfer idle timeout, and `signal`
 * stops the exchange. `report` hears of the bodies as they arrive, so the
 * copy can count as a transfer (service.ts `fetchWatchLog`).
 */
export async function requestWatchLog(conn: PairConnection, setTimer = realTimer, signal?: AbortSignal, clock: () => number = Date.now, report?: WatchLogReport): Promise<PeerWatchLog> {
  const sentAt = clock();
  const reply = await clientExchange(conn, encodeJson({ op: "watch-log" }), {
    read: (stream, options) => readWatchLogReply(stream, { ...options, signal }, clock, report),
  }, { setTimer, signal });
  return { ...reply, sentAt };
}

/** The largest epoch ms a Date holds (ECMA-262 time values). */
const MAX_DATE_MS = 8.64e15;

/** A watch-log copy's progress on the requesting side. */
export interface WatchLogReport {
  /** A valid header arrived: `files` bodies of `bytes` in all follow. */
  header(files: number, bytes: number): void;
  /** The cumulative body bytes received so far. */
  progress(bytes: number): void;
}

async function readWatchLogReply(stream: Pick<PairStream, "read">, options: FileBodyOptions, clock: () => number, report?: WatchLogReport): Promise<Omit<PeerWatchLog, "sentAt">> {
  const prefix = await readHeaderBytes(stream, 4, options);
  if (prefix[0] !== 0) {
    // A JSON error reply: a refusal, or a peer whose ib has no watch-log op.
    const parts = [prefix];
    let length = prefix.length;
    for (;;) {
      const chunk = await waitForIO(options, () => stream.read(PEER_MAX_REQUEST_BYTES + 1 - length));
      if (!chunk.length) break;
      parts.push(Buffer.from(chunk));
      length += chunk.length;
      if (length > PEER_MAX_REQUEST_BYTES) throw new PeerProtocolError("Malformed watch-log reply");
    }
    const reply = decodeObject(Buffer.concat(parts), "reply");
    if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(`the peer replied: ${sendDiagnostic(reply.reason)}`);
    throw new PeerProtocolError("Malformed watch-log reply");
  }
  const header = await decodeFrameHeader(stream, prefix, options);
  const headerAt = clock();
  const malformed = () => new PeerProtocolError("Malformed watch-log header");
  if (!header || typeof header !== "object" || Array.isArray(header)) throw malformed();
  const { op, now, version, name: machine, files } = header as Record<string, unknown>;
  // `now` must be a time a Date can hold (|now| ≤ 8.64e15 ms): export.txt prints it as one.
  if (op !== "watch-log" || typeof now !== "number" || !Number.isFinite(now) || Math.abs(now) > MAX_DATE_MS || typeof version !== "string" ||
      typeof machine !== "string" || !Array.isArray(files) || files.length > WATCH_LOG_FILE_NAMES.length) throw malformed();
  const seen = new Set<string>();
  let total = 0;
  const entries = files.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw malformed();
    const { name, size, sha256 } = entry as Record<string, unknown>;
    // Only the three known names: the requesting side writes each file under its name.
    if (!isWatchLogFileName(name) || seen.has(name) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
        typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw malformed();
    seen.add(name);
    total += size;
    return { name, size, sha256 };
  });
  if (total > WATCH_LOG_MAX_BYTES) throw new PeerProtocolError(`The watch-log reply declares ${total} bytes, over the ${WATCH_LOG_MAX_BYTES}-byte limit`);
  report?.header(entries.length, total);
  const bodies: WatchLogFile[] = [];
  let received = 0;
  for (const { name, size, sha256 } of entries) {
    const body = Buffer.allocUnsafe(size);
    let offset = 0;
    const digest = await streamFileBody(stream, size, chunk => {
      body.set(chunk, offset);
      offset += chunk.length;
    }, { ...options, onProgress: bytes => report?.progress(received + bytes) });
    if (digest !== sha256) throw new PeerProtocolError(`${name} hash mismatch`);
    received += size;
    bodies.push({ name, body });
  }
  await requireSendFin(stream, options);
  return { name: cleanRemoteText(machine), version: cleanRemoteText(version), now, headerAt, doneAt: clock(), files: bodies };
}

export const NEW_AGENT_UNKNOWN = "Remote start outcome unknown. Check the peer for the agent.";

/**
 * Without files, one JSON request. With files, a framed request like `send`:
 * the 30 s deadline starts when the reply says the files are received
 * ({@link NEW_AGENT_FILES_RECEIVED}), and the transfer before it, including
 * the bodies still in flight after FIN, has the send's idle timeouts. After
 * FIN a lost reply leaves the outcome unknown.
 */
export async function requestNewAgent(conn: PairConnection, { repo, type, name, prompt, autoRetire, files = [] }: RemoteNewAgentRequest, setTimer: Timer, transfer: OutgoingTransfer = {}): Promise<string> {
  const framed = files.length > 0;
  if (framed && !transfer.filesDir) throw new Error("Missing staged attachments");
  const tooLong = new PeerProtocolError(`request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes`);
  let bytes: Uint8Array;
  if (!framed) {
    bytes = encodeJson({ op: "new-agent", repo, type, name, prompt, autoRetire });
    if (bytes.length > NEW_AGENT_MAX_REQUEST_BYTES) throw tooLong;
  } else {
    const header: NewAgentHeader = {
      op: "new-agent", repo, type, ...(name !== undefined && { name }), prompt, ...(autoRetire !== undefined && { autoRetire }), files,
    };
    // The frame header has the same 256 KiB cap.
    try { bytes = encodeFrameHeader(header); } catch { throw tooLong; }
  }
  return clientExchange(conn, bytes, payload => {
    const reply = decodeObject(payload, "reply");
    if (reply.ok === true && typeof reply.id === "string" && isValidAgentId(reply.id)) return reply.id;
    if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(framed ? sendDiagnostic(reply.reason) : cleanRemoteText(reply.reason));
    throw new PeerProtocolError("malformed new-agent reply");
  }, {
    setTimer, timeout: [NEW_AGENT_TIMEOUT_MS, new Error("Remote agent request timed out after 30 s. Check the peer for the agent.")],
    // Both forms can be aborted (dashboard shutdown); the file transfer is framed-only.
    signal: transfer.signal, onSent: transfer.onSent,
    ...framed && { ...transfer, files, timeoutAfterFilesReceived: true, unknownAfterFin: NEW_AGENT_UNKNOWN },
  });
}

/**
 * Lifecycle commands use their own overall deadline. A merge may be silent for
 * two minutes. A reply without `pushFailure` or `warnings` (no failed push,
 * or an older install) leaves them undefined.
 */
export async function requestLifecycle(conn: PairConnection, request: RemoteLifecycleRequest, machine: string, setTimer: Timer, transfer?: Pick<OutgoingTransfer, "signal" | "verifyClient">): Promise<RemoteLifecycleOutcome> {
  const bytes = encodeJson({ ...request, op: "lifecycle" });
  if (bytes.length > PEER_MAX_REQUEST_BYTES) throw new Error("Lifecycle request exceeds the request limit");
  const unknown = new Error(`outcome unknown — check ${machine}`);
  try {
    return await clientExchange(conn, bytes, payload => {
      const reply = decodeObject(payload, "reply");
      if (reply.op === "error" && typeof reply.reason === "string") {
        const reason = lifecycleText(reply.reason);
        if (!Array.isArray(reply.candidates)) throw new PeerErrorReply(reason);
        const addresses = reply.candidates.map(candidate => {
          if (!isStoredRepoName(candidate?.repo) || typeof candidate.id !== "string" || !isValidAgentId(candidate.id)) {
            throw new PeerProtocolError("Malformed rehire candidate");
          }
          return suggestedAddress(`${machine}/${candidate.repo}/${candidate.id}`);
        }).sort();
        throw new PeerErrorReply(`${reason}; use ${addresses.join(" or ")}`);
      }
      if (reply.ok !== true || typeof reply.output !== "string" ||
          (reply.pushFailure !== undefined && typeof reply.pushFailure !== "string") ||
          (reply.warnings !== undefined && typeof reply.warnings !== "string")) throw new PeerProtocolError("Malformed lifecycle reply");
      return {
        output: lifecycleText(reply.output),
        ...(reply.pushFailure ? { pushFailure: lifecycleText(reply.pushFailure) } : {}),
        ...(reply.warnings ? { warnings: lifecycleText(reply.warnings) } : {}),
      };
    }, { ...transfer, setTimer, unknownAfterFin: unknown.message, timeout: [lifecycleTimeout(request.action), unknown] });
  } catch (err) {
    if (err instanceof TransferIdleError) throw unknown;
    throw err;
  }
}

function lifecycleText(text: string): string {
  return stripAnsi(text).split("\n").map(line => line.replace(/[\p{Cc}\p{Cf}]/gu, " ")).join("\n").slice(0, 32_768);
}

/** Acknowledge one of the other install's pending questions (SPEC §20.4). */
export function requestAcknowledge(conn: PairConnection, repo: string, id: string, setTimer: Timer): Promise<void> {
  return clientExchange(conn, encodeJson({ op: "acknowledge", repo, id }), payload => {
    const reply = decodeObject(payload, "reply");
    if (reply.ok === true) return;
    if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(cleanRemoteText(reply.reason));
    throw new PeerProtocolError("malformed acknowledge reply");
  }, { setTimer, timeout: [PEER_REQUEST_TIMEOUT_MS, new Error("Acknowledge request timed out")] });
}

/** A change re-seals a sandboxed agent and enqueues a message to it before the reply. */
const PERMISSIONS_TIMEOUT_MS = 30_000;

/**
 * Read or change the permissions of one of the other install's agents (SPEC
 * §20.4 "Remote permissions"). After FIN, a change whose reply is lost has an
 * unknown outcome; a read just failed.
 */
export async function requestPermissions(conn: PairConnection, request: RemotePermissionRequest, machine: string, setTimer: Timer): Promise<RemotePermissionOutcome> {
  const bytes = encodeJson({ ...request, op: "permissions" });
  if (bytes.length > PEER_MAX_REQUEST_BYTES) throw new Error("Permission request exceeds the request limit");
  const change = request.allow !== undefined || request.canSpawnChildren !== undefined;
  const unknown = new Error(`outcome unknown — check ${machine}`);
  try {
    return await clientExchange(conn, bytes, payload => {
      const reply = decodeObject(payload, "reply");
      if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(sendDiagnostic(reply.reason));
      if (reply.ok !== true || typeof reply.canSpawnChildren !== "boolean" ||
          (reply.notifyError !== undefined && typeof reply.notifyError !== "string")) throw new PeerProtocolError("Malformed permissions reply");
      return {
        canSpawnChildren: reply.canSpawnChildren,
        ...(typeof reply.notifyError === "string" && { notifyError: sendDiagnostic(reply.notifyError) }),
      };
    }, change
      ? { setTimer, unknownAfterFin: unknown.message, timeout: [PERMISSIONS_TIMEOUT_MS, unknown] }
      : { setTimer, timeout: [PERMISSIONS_TIMEOUT_MS, new Error("Permission request timed out")] });
  } catch (err) {
    if (change && err instanceof TransferIdleError) throw unknown;
    throw err;
  }
}

export const SEND_UNKNOWN = "outcome unknown — check the agent";

/** `milestone` gets the bytes of `bytes` written so far, after each write. */
async function writeWithProgress(stream: Pick<PairStream, "write">, bytes: Uint8Array, setTimer: PeerResponderDeps["setTimer"], signal?: AbortSignal, milestone?: (written: number) => void) {
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    const n = await waitForIO({ setTimer, signal }, () => stream.write(chunk));
    if (!Number.isInteger(n) || n <= 0 || n > chunk.length) throw new Error("Invalid send write count");
    offset += n;
    milestone?.(offset);
  }
}

export interface OutgoingTransfer {
  verifyClient?: () => void;
  filesDir?: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
  /**
   * The request, its bodies and FIN are written. A write completes once QUIC
   * buffers it, so bytes may still be in flight: only the reply says the peer
   * has them.
   */
  onSent?: () => void;
}

interface ClientOptions extends OutgoingTransfer {
  setTimer: Timer;
  timeout?: [number, Error];
  /**
   * Arm `timeout` when the reply begins with {@link NEW_AGENT_FILES_RECEIVED}
   * instead of at stream open: the transfer before it has idle timeouts only.
   */
  timeoutAfterFilesReceived?: boolean;
  /**
   * Asked once `timeout` has fired and this exchange's stream could not be torn
   * down within the grace. True leaves the connection open instead of closing
   * it, and the exchange then waits for its stalled native read, which settles
   * once the late reply or the connection's close arrives. So the caller's
   * request slot stays taken and no second request piles up behind it on the
   * slow link. A late reply is returned as the exchange's result. While it
   * waits it asks again every `timeout` interval, and the first no closes the
   * connection as an unkept timeout would. The poller's agents poll and pane
   * reads pass one that is true while a transfer with the peer is running and
   * has moved bytes within the last 60 s, or this machine's watch-log reply to
   * the peer ended ok within that window (transfer-activity.ts
   * `recentProgress`, SPEC §20.4 "Slow links").
   */
  keepOpenOnTimeout?: () => boolean;
  unknownAfterFin?: string;
  files?: AttachmentEntry[];
}

type StreamReply<T> = { read(stream: Pick<PairStream, "read">, options: FileBodyOptions): Promise<T> };
/** One owner for the request deadline, both halves of the stream, and teardown. */
async function clientExchange<T>(conn: PairConnection, bytes: Uint8Array, decode: ((bytes: Uint8Array) => T) | StreamReply<T>, options: ClientOptions): Promise<T> {
  const { setTimer, timeout, files } = options;
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const armTimeout = () => timeout && setTimer(timeout[0], () => deadline.abort(timeout[1]));
  let clear = options.timeoutAfterFilesReceived ? undefined : armTimeout();
  const io = <V>(operation: () => Promise<V>) => waitForIO({ setTimer, signal }, operation);
  /**
   * A teardown (`stalled`) that missed its grace closes the connection, unless
   * the caller keeps it through this request's own timeout: then wait for it,
   * asking again each `timeout` interval, and close once the caller says no.
   */
  const closeStalled = async (stalled: Promise<unknown>) => {
    const keep = options.keepOpenOnTimeout;
    if (timeout && keep && signal.reason === timeout[1]) {
      while (keep()) {
        if (await settledWithinGrace(stalled, { setTimer }, timeout[0])) return;
      }
    }
    closeQuietly(conn, PEER_CLOSE.error, "send reset stalled");
  };
  let opening: Promise<PairStream> | undefined;
  let active: PairStream;
  try { active = await io(() => { options.verifyClient?.(); return opening = conn.openBi(); }); }
  catch (err) {
    clear?.();
    if (opening) {
      const cancelled = opening.then(stream => stream.cancel());
      if (!await settledWithinGrace(cancelled, { setTimer })) await closeStalled(cancelled);
    }
    throw err;
  }

  let sent = 0;
  let attemptedFin = false;
  let sendDone = false;
  let cancelIdle: (() => void) | undefined;
  const renewReplyIdle = () => {
    if (!sendDone || typeof decode !== "function") return; // framed readers time each read with waitForIO
    cancelIdle?.();
    cancelIdle = setTimer(IDLE_TIMEOUT_MS, () => deadline.abort(new TransferIdleError(`No progress for ${IDLE_TIMEOUT_MS} ms`)));
  };
  let frameStop: Promise<unknown> | undefined;
  async function readReply() {
    if (typeof decode !== "function") {
      let fin = false;
      let reading: Promise<Uint8Array> | undefined;
      try {
        return await decode.read({ read: async limit => {
          reading = active.read(limit);
          const chunk = await reading;
          fin = chunk.length === 0;
          return chunk;
        } }, { setTimer });
      } catch (err) {
        // A malformed header can leave a body unread. An idle deadline can
        // leave a native read pending. Both belong to this exchange's grace.
        if (!fin) frameStop = Promise.allSettled([reading, active.stopReceiving()]);
        throw err;
      }
    }
    if (!files) return decode(await active.readToEnd(PEER_MAX_REPLY_BYTES));
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await active.read(Math.min(CHUNK_BYTES, PEER_MAX_REPLY_BYTES + 1 - length));
      if (!chunk.length) return decode(Buffer.concat(parts, length));
      // An exchange that is ending has aborted `deadline` first, so this timer cannot outlive it.
      if (options.timeoutAfterFilesReceived && length === 0 && chunk[0] === NEW_AGENT_FILES_RECEIVED[0] && !signal.aborted) clear = armTimeout();
      length += chunk.length;
      if (length > PEER_MAX_REPLY_BYTES) throw new Error("Send acknowledgement exceeds limit");
      parts.push(chunk);
      options.onProgress?.(sent);
      renewReplyIdle();
    }
  }
  async function writeRequest() {
    options.verifyClient?.();
    if (files?.length) await io(() => active.setPriority(ATTACHMENT_BODY_PRIORITY));
    if (files) await writeWithProgress(active, bytes, setTimer, signal, () => options.onProgress?.(0));
    else await io(() => active.writeAll(bytes));
    for (const [index, file] of (files ?? []).entries()) {
      signal.throwIfAborted();
      const opening = openStagedFile(join(options.filesDir!, String(index)), file.size);
      let handle: Awaited<typeof opening>;
      try { handle = await io(() => opening); }
      catch (err) {
        trackSendCleanup(opening.then(file => file.close(), () => {}), "Late staged attachment close failed");
        throw err;
      }
      try { await sendFileBody({ handle, size: file.size }, active, { setTimer, signal, onProgress: n => options.onProgress?.(sent + n) }); }
      catch (err) { trackSendCleanup(handle.close(), "Staged attachment close failed"); throw err; }
      const closing = handle.close();
      try { await io(() => closing); }
      catch (err) { trackSendCleanup(closing, "Staged attachment close failed"); throw err; }
      sent += file.size;
    }
    signal.throwIfAborted();
    options.verifyClient?.();
    attemptedFin = true;
    await io(() => active.finish());
    sendDone = true;
    options.onSent?.();
    if (files) renewReplyIdle();
  }

  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  let received: Outcome | undefined;
  const failure = (error: unknown): Outcome => ({ ok: false, error });
  // This single reader owns the native receive mutex through FIN, including
  // the teardown grace. It stays alive when the independent writer stops.
  const reply = readReply().then((value): Outcome => ({ ok: true, value }), failure).then(result => received = result);
  const stopped = Promise.withResolvers<Outcome>();
  const abort = () => stopped.resolve(failure(signal.reason));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const result = await Promise.race([reply, writeRequest().then(() => reply, failure), stopped.promise]);
    if (!received || !sendDone || frameStop) {
      deadline.abort(new Error("Request writer stopped"));
      const teardown = Promise.allSettled([reply.then(() => frameStop), sendDone ? undefined : active.resetSending()]);
      if (!await settledWithinGrace(teardown, { setTimer })) await closeStalled(teardown);
    }
    if (received?.ok) return received.value;
    if (received && received.error instanceof PeerErrorReply) throw received.error;
    if (result.ok) return result.value;
    if (attemptedFin && options.unknownAfterFin) throw new Error(options.unknownAfterFin, { cause: result.error });
    if (result.error instanceof PairProtocolError) throw new PeerProtocolError(`reply longer than ${PEER_MAX_REPLY_BYTES} bytes`);
    throw result.error;
  } finally {
    clear?.(); cancelIdle?.(); signal.removeEventListener("abort", abort);
  }
}

export async function requestSend(conn: PairConnection, header: SendHeader, setTimer: Timer, transfer: OutgoingTransfer = {}): Promise<string> {
  if (header.files.length && !transfer.filesDir) throw new Error("Missing staged attachments");
  return clientExchange(conn, encodeSendHeader(header), bytes => {
    const reply = decodeObject(bytes, "reply");
    if (reply.ok === true && reply.id === header.id) return header.id;
    if (reply.op === "error" && typeof reply.reason === "string") throw new PeerErrorReply(sendDiagnostic(reply.reason));
    throw new PeerProtocolError("Malformed send acknowledgement");
  }, { ...transfer, setTimer, files: header.files, unknownAfterFin: SEND_UNKNOWN });
}

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

export interface ReceiptOptions extends FileBodyOptions { cancelStream?: () => void; admitted?: (ownsBody: boolean) => void; committing?: () => void }
export interface StartReceiptOptions extends ReceiptOptions {
  setTimer: Timer;
  /** Write {@link NEW_AGENT_FILES_RECEIVED} on the reply stream: call it once every body is committed, before the spawn. */
  filesReceived(): Promise<void>;
}

export interface PeerResponderDeps {
  /** Paired name for this id, re-read on every call. A failed read returns null. */
  peerName(id: string): Promise<string | null>;
  /** The agent list to send: built from the watcher's last fully detected snapshot, with no IO. */
  snapshot(): PeerSnapshot;
  receiveMessage?(header: SendHeader, peerId: string, readPeerName: () => Promise<string | null>, body?: Pick<PairStream, "read">, options?: ReceiptOptions): Promise<void>;
  captureCoordinator?(lines: number): Promise<PeerPane | null>;
  captureAgent?(repo: string, id: string, lines: number): Promise<PeerPane>;
  captureDiff?(repo: string, id: string): Promise<AgentDiff>;
  readPrompt?(repo: string, id: string): Promise<string>;
  /** This machine's name, `ib` version and watch log files, for a `watch-log` request. Without it the request is refused. */
  readWatchLog?(): Promise<{ name: string; version: string; files: WatchLogFile[] }>;
  /** Transfers per peer (transfer-activity.ts): a `watch-log` reply's write is one. */
  transfers?: Pick<TransferActivity, "begin">;
  /** Shared by all connections served by this ib watch. */
  paneReaders?: Set<string>;
  headerReaders?: Set<PairStream>;
  setTimer(ms: number, fn: () => void): () => void;
  /** Epoch ms, for the disconnect line's uptime and slow-answer lines. Defaults to Date.now. */
  now?(): number;
  lifecycle?(request: RemoteLifecycleRequest, readPeerName: () => Promise<string | null>): Promise<RemoteLifecycleOutcome>;
  /** The request's `repo` and `id` as received: the handler validates them. */
  acknowledgeQuestion?(repo: unknown, id: unknown, readPeerName: () => Promise<string | null>): Promise<void>;
  permissions?(request: RemotePermissionRequest, readPeerName: () => Promise<string | null>): Promise<RemotePermissionOutcome>;
  startAgent?(request: Record<string, unknown>, readPeerName: () => Promise<string | null>): Promise<string>;
  /** A framed new-agent request: validate, receive the bodies, then spawn within {@link withStartDeadline}. */
  startAgentWithFiles?(header: NewAgentHeader, peerId: string, readPeerName: () => Promise<string | null>, body: Pick<PairStream, "read">, options: StartReceiptOptions): Promise<string>;
  /** Remote terminals (terminal-host.ts). Without it every terminal open is refused. */
  terminal?: TerminalHostDeps;
  /** Called once the connection's id passed the allowlist, before any request is read (service.ts logs its path then). Must not throw. */
  trusted?(): void;
  /** watch.log in `ib watch`. */
  log(line: string): void;
}

/**
 * Serve one accepted trusted-ALPN connection until it closes. Checks the
 * allowlist before reading anything, again when each request's stream is
 * accepted, and again right before each answer. Each request runs in its own
 * task with its own error handling. Never throws.
 *
 * A lookup that says "not a peer" refuses as such. One that failed refuses
 * with its error and close code 3, so neither side's log says the peer was
 * removed. One cut short because the connection closed writes no refusal:
 * at the accept it writes that the connection closed during its pairing
 * check, with the close's reason; once the connection passed the allowlist,
 * its close writes the shared disconnect line (`accepted`, up since it passed).
 */
export async function serveTrustedConnection(conn: PairConnection, deps: PeerResponderDeps): Promise<void> {
  const headerReaders = deps.headerReaders ??= new Set();
  const from = shortPeerId(conn.remoteId);
  const now = deps.now ?? Date.now;
  const lifetime = new AbortController();
  void conn.closed().then(() => lifetime.abort(new Error("Peer connection closed")), err => lifetime.abort(err));
  const readPeerName = deps.peerName.bind(deps);
  /** The pairing lookup, bounded by the IO deadline and the connection's life. Throws when it did not finish. */
  const lookup = (id = conn.remoteId) => waitForIO({ setTimer: deps.setTimer, signal: lifetime.signal }, () => readPeerName(id));
  deps = { ...deps, peerName: async id => {
    try { return await lookup(id); }
    catch (err) {
      // A lookup cut short by the close adds nothing to the disconnect line.
      if (!lifetime.signal.aborted) deps.log(`peer link: pairing lookup failed: ${errorDetail(err)}`);
      return null;
    }
  } };
  let name: string;
  try {
    const found = await lookup();
    if (found === null) {
      deps.log(`peer link: closed a connection from ${from}: not a peer`);
      closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
      return;
    }
    name = found;
  } catch (err) {
    if (lifetime.signal.aborted) {
      // The connection closed during the check: this side refused nothing.
      const reason = await conn.closed().then(describePeerClose, errorDetail);
      deps.log(`peer link: connection from ${from} closed during its pairing check: ${reason}`);
      return;
    }
    deps.log(`peer link: closed a connection from ${from}: pairing lookup failed: ${errorDetail(err)}`);
    closeQuietly(conn, PEER_CLOSE.error, "pairing lookup failed");
    return;
  }
  const trustedAt = now();
  deps.log(`peer link: ${from} connected`);
  void conn.closed().then(describePeerClose, errorDetail).then(reason =>
    deps.log(disconnectLine(name || from, conn.remoteId, "accepted", now() - trustedAt, reason)));
  deps.trusted?.();
  /** Pairing still holds: the name. Otherwise the connection is closed (or already was) and null. */
  const stillPaired = async (): Promise<string | null> => {
    try {
      const found = await lookup();
      if (found !== null) {
        name = found;
        return found;
      }
      deps.log(`peer link: refused a request from ${from}: no longer a peer; closing`);
      closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
    } catch (err) {
      if (lifetime.signal.aborted) return null;
      deps.log(`peer link: refused a request from ${from}: pairing lookup failed: ${errorDetail(err)}; closing`);
      closeQuietly(conn, PEER_CLOSE.error, "pairing lookup failed");
    }
    return null;
  };
  for (;;) {
    let stream: PairStream;
    try {
      stream = await conn.acceptBi();
    } catch {
      return; // the connection closed
    }
    const acceptedAt = now();
    if ((await stillPaired()) === null) return;
    if (headerReaders.size >= 8) {
      await sendReply(conn, stream, deps, encodeErrorReply("busy, try again"), stream.stopReceiving());
      continue;
    }
    headerReaders.add(stream);
    void serveRequest(conn, stream, from, deps, lifetime.signal, acceptedAt, stillPaired);
  }
}

/**
 * The responder's start deadline: past it the reply says the outcome is
 * unknown while `start` goes on. `expired` lets a pairing check refuse a spawn
 * that nobody waits for. A framed start runs only its spawn under it.
 */
export async function withStartDeadline<T>(setTimer: Timer, start: (expired: () => boolean) => Promise<T>): Promise<T> {
  let expired = false;
  const deadline = Promise.withResolvers<never>();
  const cancel = setTimer(RESPONDER_START_TIMEOUT_MS, () => {
    expired = true;
    deadline.reject(new Error("Remote start outcome unknown after 25 s. Check the peer for the agent."));
  });
  try {
    return await Promise.race([start(() => expired), deadline.promise]);
  } finally {
    cancel();
  }
}

async function startAgentWithDeadline(
  deps: PeerResponderDeps, request: Record<string, unknown>, peerId: string,
): Promise<string> {
  const startAgent = deps.startAgent;
  if (!startAgent) throw new Error("Remote starts are unavailable");
  return withStartDeadline(deps.setTimer, expired => startAgent(request, async () => {
    const name = await deps.peerName(peerId);
    return expired() ? null : name;
  }));
}

/** Give the client time to consume its reply, or a reset time to acquire the native stream mutex. */
async function settledWithinGrace(operation: Promise<unknown>, deps: Pick<PeerResponderDeps, "setTimer">, ms = 750): Promise<boolean> {
  const deadline = Promise.withResolvers<false>();
  const cancel = deps.setTimer(ms, () => deadline.resolve(false));
  try {
    return await Promise.race([operation.then(() => true, () => true), deadline.promise]);
  } finally { cancel(); }
}

/** A reply write's progress: the bytes of the whole reply written so far, and the write's failure. */
interface ReplyReport { progress(bytes: number): void; failed(err: unknown): void }

/** The handler owns the reply and teardown. A settled stop or reset is stream-local. */
async function sendReply(conn: PairConnection, stream: PairStream, deps: PeerResponderDeps, bytes: Uint8Array | Uint8Array[],
  stop?: Promise<void>, stalledRead?: Promise<Uint8Array>, report?: ReplyReport) {
  const stopped = stop?.catch(() => {});
  const writeReply = async () => {
    let written = 0;
    for (const part of Array.isArray(bytes) ? bytes : [bytes]) {
      await writeWithProgress(stream, part, deps.setTimer, undefined, report && (n => report.progress(written + n)));
      written += part.length;
    }
    await waitForIO(deps, () => stream.finish());
  };
  if (stalledRead) {
    // The native read is still pending. Bound the entire ACK attempt before
    // closing, with a delivery grace only if the reply actually settled.
    if (await settledWithinGrace(writeReply(), deps)) {
      const drained = Promise.allSettled([stalledRead, stopped]);
      if (await settledWithinGrace(Promise.race([drained, conn.closed()]), deps, 5000)) return false;
    }
    closeQuietly(conn, PEER_CLOSE.error, "send read stalled");
    return false;
  }
  let delivered = true;
  try { await writeReply(); }
  catch (err) {
    delivered = false;
    report?.failed(err);
    if (err instanceof TransferIdleError && !await settledWithinGrace(stream.cancel(), deps)) {
      closeQuietly(conn, PEER_CLOSE.error, "send reply stalled");
      return false;
    }
  }
  if (stopped && !await settledWithinGrace(stopped, deps)) closeQuietly(conn, PEER_CLOSE.error, "receive stop stalled");
  return delivered;
}

/** Plain request/reply ops whose answer is timed: one taking {@link SLOW_ANSWER_MS} or more is logged. */
const TIMED_OPS = new Set(["agents", "coordinator-pane", "agent-pane", "agent-prompt", "agent-diff", "lifecycle", "acknowledge", "permissions"]);
const SLOW_ANSWER_MS = 5_000;

/**
 * One request on its own stream. Every error stays here. `acceptedAt` is when
 * its stream was accepted; `stillPaired` is the connection's pairing re-check.
 */
async function serveRequest(conn: PairConnection, stream: PairStream, from: string, deps: PeerResponderDeps, signal: AbortSignal,
  acceptedAt: number, stillPaired: () => Promise<string | null>): Promise<void> {
  let request: ReturnType<typeof decodePeerRequest>;
  let reading: Promise<Uint8Array> | undefined;
  async function read(limit: number) {
    reading = stream.read(limit);
    try { return await reading; } finally { reading = undefined; }
  }
  try {
    // Every valid sized header begins with zero (the cap is 256 KiB).
    // Other ops begin with JSON. Peek one byte without waiting for FIN.
    const options = { setTimer: deps.setTimer };
    const first = await waitForIO(options, () => read(1));
    if (first[0] === TERMINAL_FRAME.open) {
      // A long-lived session: it holds no header-reader slot.
      deps.headerReaders?.delete(stream);
      await serveTerminal(conn.remoteId, stream, first, from, {
        ...(deps.terminal ?? TERMINALS_UNAVAILABLE),
        peerName: deps.peerName, setTimer: deps.setTimer, log: deps.log,
        closeNotPeer: () => closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer"),
        closeError: (reason) => closeQuietly(conn, PEER_CLOSE.error, reason),
      });
      return;
    }
    if (first[0] === 0) {
      let prefix: Uint8Array | undefined = first;
      let receivedFin = false;
      const reader = { read: async (limit: number) => {
        const chunk = prefix ?? await read(limit);
        prefix = undefined;
        if (!chunk.length) receivedFin = true;
        return chunk;
      } };
      // Native QUIC can reject STOP_SENDING once the receive half reached FIN.
      let stopping: Promise<void> | undefined;
      const stopUnreadBody = () => {
        if (!receivedFin) stopping ??= stream.stopReceiving().catch(() => {});
      };
      let reply: Uint8Array;
      let stalledRead: Promise<Uint8Array> | undefined;
      let starting = false;
      const readPeerName = async () => {
        const name = await deps.peerName(conn.remoteId);
        if (name === null) closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
        return name;
      };
      const receipt = { ...options, signal, admitted: () => deps.headerReaders?.delete(stream), cancelStream: () => {
        stopping ??= stream.cancel().catch(() => {});
      } };
      try {
        // Decode the header once, then dispatch on its op.
        const frame = await decodeFrameHeader(reader, await readHeaderBytes(reader, 4, options), options);
        const op = typeof frame === "object" && frame !== null && "op" in frame ? frame.op : undefined;
        if (op === "send") {
          const header = parseSendHeader(frame);
          if (!header.files.length) await requireSendFin(reader, options);
          if (!deps.receiveMessage) throw new Error("Remote sends are unavailable");
          await deps.receiveMessage(header, conn.remoteId, readPeerName, reader, receipt);
          // A replay can acknowledge a previously queued attachment without
          // consuming its duplicate body.
          if (header.files.length) stopUnreadBody();
          reply = encodeJson({ ok: true, id: header.id });
        } else if (op === "new-agent") {
          starting = true;
          const header = parseNewAgentHeader(frame);
          if (!deps.startAgentWithFiles) throw new Error("Remote starts with attachments are unavailable");
          reply = encodeJson({ ok: true, id: await deps.startAgentWithFiles(header, conn.remoteId, readPeerName, reader, {
            ...receipt, filesReceived: () => writeWithProgress(stream, NEW_AGENT_FILES_RECEIVED, deps.setTimer),
          }) });
        } else throw new Error("Malformed frame header");
      } catch (err) {
        if (err instanceof TransferIdleError) stalledRead = reading;
        // STOP_SENDING is independent of the send half. The error ACK can
        // finish even if the native reader is still unwinding a stalled read.
        stopUnreadBody();
        const reason = sendDiagnostic(errorDetail(err));
        if (starting) deps.log(`peer link: new-agent from ${from} failed: ${reason}`);
        reply = encodeErrorReply(reason);
      }
      await sendReply(conn, stream, deps, reply, stopping, stalledRead);
      return;
    }
    let payload = Buffer.alloc(1024);
    payload.set(first);
    let length = first.length;
    while (true) {
      const limit = Math.min(CHUNK_BYTES, NEW_AGENT_MAX_REQUEST_BYTES - length + 1);
      const part = await waitForIO(options, () => read(limit));
      if (!part.length) break;
      if (part.length > limit || length + part.length > NEW_AGENT_MAX_REQUEST_BYTES) throw new PeerProtocolError(`request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes`);
      if (length + part.length > payload.length) {
        const next = Buffer.allocUnsafe(Math.min(NEW_AGENT_MAX_REQUEST_BYTES, Math.max(2 * payload.length, length + part.length)));
        payload.copy(next, 0, 0, length);
        payload = next;
      }
      payload.set(part, length);
      length += part.length;
    }
    request = decodePeerRequest(payload.subarray(0, length));
  } catch (err) {
    if (err instanceof PeerProtocolError || err instanceof PairProtocolError) {
      // PairProtocolError is the seam's readToEnd past its limit.
      const reason = err instanceof PairProtocolError ? `request longer than ${NEW_AGENT_MAX_REQUEST_BYTES} bytes` : err.message;
      deps.log(`peer link: ${reason}, from ${from}; closing`);
      closeQuietly(conn, PEER_CLOSE.error, reason);
    }
    else await sendReply(conn, stream, deps, encodeErrorReply(sendDiagnostic(errorDetail(err))), stream.stopReceiving(), reading);
    return;
  } finally { deps.headerReaders?.delete(stream); }

  // Again now, right before answering: the stream was accepted on its first
  // frame, and a client can hold it open across `ib peer remove` before it
  // finishes the request. The answer reflects peers.json as of this moment.
  const peerName = await stillPaired();
  if (peerName === null) return;

  let reply: Uint8Array | Uint8Array[];
  let capturedCoordinator = false;
  if (request.op === "agents") {
    try {
      reply = encodeAgentsReply(deps.snapshot());
    } catch (err) {
      deps.log(`peer link: could not build the agent list for ${from}: ${errorDetail(err)}`);
      reply = encodeErrorReply("internal error");
    }
  } else if (request.op === "coordinator-pane" || request.op === "agent-pane") {
    try {
      const count = request.lines === undefined && request.op === "coordinator-pane" ? 200 : request.lines;
      if (typeof count !== "number" || !Number.isInteger(count)) throw new Error("Expected an integer line count");
      const lines = clampPaneLines(count);
      let pane;
      if (request.op === "agent-pane") {
        if (typeof request.repo !== "string" || typeof request.id !== "string") throw new Error("Expected repo and agent id");
        pane = await deps.captureAgent?.(request.repo, request.id, lines);
        if (!pane) throw new Error("Agent pane unavailable");
      } else {
        pane = await deps.captureCoordinator?.(lines);
        if (!pane) throw new Error("No system coordinator");
      }
      reply = encodePane(request.op, pane);
      capturedCoordinator = request.op === "coordinator-pane";
    } catch (err) {
      reply = encodeErrorReply(cleanRemoteText(errorDetail(err)));
    }
    // A tmux capture is asynchronous. Pairing must still hold before sending
    // either the capture or the reason it failed.
    if (await deps.peerName(conn.remoteId) === null) {
      closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
      return;
    }
  } else if (request.op === "agent-diff") {
    try {
      if (typeof request.repo !== "string" || typeof request.id !== "string") throw new Error("Malformed agent-diff request");
      if (!deps.captureDiff) throw new Error("Remote diffs are unavailable");
      const { base, patch } = await deps.captureDiff(request.repo, request.id);
      if (patch.length > MAX_AGENT_DIFF_BYTES) throw new Error("Agent diff exceeds 64 MiB");
      const sha256 = createHash("sha256").update(patch).digest("hex");
      reply = [encodeFrameHeader({ op: "agent-diff", base, size: patch.length, sha256 }), patch];
    } catch (err) {
      reply = encodeErrorReply(sendDiagnostic(errorDetail(err)));
    }
    if (await deps.peerName(conn.remoteId) === null) {
      closeQuietly(conn, PEER_CLOSE.notPeer, "not a peer");
      return;
    }
  } else if (request.op === "watch-log") {
    return serveWatchLog(conn, stream, from, peerName, deps, stillPaired);
  } else if (request.op === "agent-prompt") {
    try {
      if (typeof request.repo !== "string" || typeof request.id !== "string") throw new Error("Expected repo and agent id");
      if (!deps.readPrompt) throw new Error("Remote prompts are unavailable");
      reply = encodeJson({ op: "agent-prompt", prompt: await deps.readPrompt(request.repo, request.id) });
      if (reply.length > PEER_MAX_REPLY_BYTES) throw new Error(`The prompt is over ${PEER_MAX_REPLY_BYTES} bytes`);
    } catch (err) {
      reply = encodeErrorReply(cleanRemoteText(errorDetail(err)));
    }
    // Reading prompt.txt is asynchronous, as a capture is.
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
      reply = encodeErrorReply(error);
    }
  } else if (request.op === "lifecycle") {
    try {
      if (!deps.lifecycle) throw new Error("Remote lifecycle commands are unavailable");
      const { output, pushFailure, warnings } = await deps.lifecycle(parseLifecycleRequest(request), () => deps.peerName(conn.remoteId));
      reply = encodeJson({
        ok: true, output: lifecycleText(output),
        ...(pushFailure ? { pushFailure: lifecycleText(pushFailure) } : {}),
        ...(warnings ? { warnings: lifecycleText(warnings) } : {}),
      });
    } catch (err) {
      const error = lifecycleText(errorDetail(err));
      deps.log(`peer link: lifecycle request from ${from} failed: ${singleLine(error)}`);
      reply = err instanceof AmbiguousRemoteRehire
        ? encodeJson({ op: "error", reason: error, candidates: err.candidates }) : encodeErrorReply(error);
    }
  } else if (request.op === "acknowledge") {
    try {
      if (!deps.acknowledgeQuestion) throw new Error("Remote acknowledgements are unavailable");
      await deps.acknowledgeQuestion(request.repo, request.id, () => deps.peerName(conn.remoteId));
      reply = encodeJson({ ok: true });
    } catch (err) {
      const error = cleanRemoteText(errorDetail(err));
      deps.log(`peer link: acknowledge from ${from} failed: ${error}`);
      reply = encodeErrorReply(error);
    }
  } else if (request.op === "permissions") {
    try {
      if (!deps.permissions) throw new Error("Remote permissions are unavailable");
      const { canSpawnChildren, notifyError } = await deps.permissions(parsePermissionRequest(request), () => deps.peerName(conn.remoteId));
      reply = encodeJson({ ok: true, canSpawnChildren, ...(notifyError !== undefined && { notifyError: sendDiagnostic(notifyError) }) });
    } catch (err) {
      const error = sendDiagnostic(errorDetail(err));
      deps.log(`peer link: permissions request from ${from} failed: ${error}`);
      reply = encodeErrorReply(error);
    }
  } else {
    reply = encodeErrorReply(`unknown op ${JSON.stringify(cleanRemoteText(request.op))}`);
  }
  const delivered = await sendReply(conn, stream, deps, reply);
  // From the stream's accept until the reply was written, or its write failed.
  const tookMs = (deps.now ?? Date.now)() - acceptedAt;
  if (TIMED_OPS.has(request.op) && tookMs >= SLOW_ANSWER_MS) {
    deps.log(`peer link: answered ${request.op} for ${peerName} (${from}) in ${(tookMs / 1000).toFixed(1)} s${delivered ? "" : "; writing the reply failed"}`);
  }
  if (delivered && capturedCoordinator && deps.paneReaders && !deps.paneReaders.has(conn.remoteId)) {
    deps.paneReaders.add(conn.remoteId);
    deps.log(`peer link: ${peerName} (${from}) read the system coordinator pane`);
  }
}

/**
 * Answer a `watch-log` request (SPEC §20.4 "Watch log copies"). Every file is
 * read into memory first, so a rotation during the reply cannot mix two
 * versions; then one framed reply in the style of `agent-diff`: the header
 * lists each file with its size and SHA-256 plus `now`, the `ib` version and
 * this machine's name, then the bodies in order, then FIN. The reply's
 * write is a transfer (`deps.transfers`), so a slow copy keeps the link
 * (SPEC "Slow links"), also for a window after FIN while its last bytes can
 * still be in flight. `stillPaired` is the connection's pairing re-check,
 * so a failed lookup after the read closes with code 3, not as "not a peer".
 */
async function serveWatchLog(conn: PairConnection, stream: PairStream, from: string, peerName: string, deps: PeerResponderDeps,
  stillPaired: () => Promise<string | null>): Promise<void> {
  let reply: Uint8Array[];
  let copied: string | undefined;
  let sizes = { files: 0, bytes: 0 };
  try {
    if (!deps.readWatchLog) throw new Error("Watch log copies are unavailable");
    const { name, version, files } = await deps.readWatchLog();
    const total = totalWatchLogBytes(files);
    if (total > WATCH_LOG_MAX_BYTES) throw new Error(`The watch log files total ${total} bytes, over the ${WATCH_LOG_MAX_BYTES}-byte limit`);
    const entries = files.map(file => ({ name: file.name, size: file.body.length, sha256: createHash("sha256").update(file.body).digest("hex") }));
    // `now` is read after the files and before the header is written, so the
    // requester's send and header times bound it.
    reply = [encodeFrameHeader({ op: "watch-log", now: (deps.now ?? Date.now)(), version, name, files: entries }), ...files.map(file => file.body)];
    copied = describeWatchLogFiles(files);
    sizes = { files: files.length, bytes: total };
  } catch (err) {
    const error = sendDiagnostic(errorDetail(err));
    deps.log(`peer link: watch log request from ${peerName} (${from}) failed: ${error}`);
    reply = [encodeErrorReply(error)];
  }
  // Reading the files is asynchronous, as a capture is. A refusal closes the connection and logs its line.
  if (await stillPaired() === null) return;
  if (copied === undefined) {
    await sendReply(conn, stream, deps, reply);
    return;
  }
  // Bulk bodies, like attachment bodies: other replies on this connection go out first.
  await waitForIO(deps, () => stream.setPriority(ATTACHMENT_BODY_PRIORITY)).catch(() => {});
  // No reply follows FIN, so the transfer ends when QUIC has accepted the
  // last write, with up to a stream window still in flight: `endsAtLastWrite`
  // keeps this peer's link through that tail.
  const transfer = deps.transfers?.begin({
    peerId: conn.remoteId, peerName: peerName || null, op: "watch-log", direction: "to", ...sizes, endsAtLastWrite: true,
  });
  const headerBytes = reply[0]!.length;
  const delivered = await sendReply(conn, stream, deps, reply, undefined, undefined, transfer && {
    // Body bytes only, as the transfer's total counts them.
    progress: bytes => transfer.progress(Math.max(0, bytes - headerBytes)),
    failed: err => transfer.failed(err),
  });
  if (delivered) transfer?.ok();
  else transfer?.failed(new Error("writing the reply failed"));
  deps.log(delivered ? `peer link: wrote the watch log to ${peerName} (${from}) (${copied})` : `peer link: sending the watch log to ${peerName} (${from}) failed`);
}
