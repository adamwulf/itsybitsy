/**
 * The pair protocol (docs/plans/iroh-peering.md, "Pairing"; SPEC.md §20.2).
 *
 * ALPN `itsybitsy/pair/1`, one connection per pairing. The initiator (A)
 * dialed the responder (B) by B's id, so QUIC has already proved the other end
 * holds B's key. B trusts A's key (`conn.remoteId`) only once A sends the code
 * B is showing on its own screen.
 *
 * Each request and its reply use their own bi stream: A opens it, writes one
 * JSON object and calls `finish`; B reads it with `readToEnd(4096)`, writes one
 * JSON reply on the same stream and calls `finish`. No framing code.
 *
 *   A→B {"op":"pair-hello"}
 *   B→A {"op":"pair-code-shown"} | {"op":"pair-refused","reason":...}
 *       | {"op":"pair-ok"}      (A is already in B's peers.json: no code)
 *   A→B {"op":"pair-code","code":"..."}
 *   B→A {"op":"pair-ok"} | {"op":"pair-fail","reason":"wrong-code"|"expired"}
 *
 * B always sends the last message. It then waits for A to close (A closes as
 * soon as it has read it), so a close cannot race the reply, and closes itself
 * after {@link FINAL_REPLY_LINGER_MS} at the latest. Every other close carries
 * a code that tells the other side why: {@link PAIR_CLOSE}. A new connection
 * that sends no pair-hello within {@link HELLO_TIMEOUT_MS}, or whose read
 * fails, is closed with the error code; after that, the code's 2-minute
 * expiry bounds how long B waits.
 *
 * Both sides are state machines over {@link PairConnection}, a small transport
 * seam: src/peers/service.ts adapts the iroh wrapper to it, and the tests use
 * an in-memory link (src/peers/test-pair-transport.ts) and a fake clock.
 */

import {
  PAIR_CODE_TTL_MS,
  isPairCodeExpired,
  normalizePairCode,
  pairCodeExpiresAt,
  pairCodesEqual,
} from "./pair-code";
import { normalizePeerId, shortPeerId, type Peer } from "./store";

export const PAIR_ALPN = "itsybitsy/pair/1";
/** Longest message either side reads (`readToEnd` limit). */
export const PAIR_MAX_MESSAGE_BYTES = 4096;
/** How long B waits, after its last message, for A to close before closing itself. */
export const FINAL_REPLY_LINGER_MS = 5_000;
/** How long B waits for a new connection's pair-hello before closing it (error code). */
export const HELLO_TIMEOUT_MS = 10_000;

/** Connection close codes. The other side maps them to what it shows. */
export const PAIR_CLOSE = {
  /** Finished normally, after the last message. */
  done: 0,
  /** Esc on this side. The other side shows "pairing cancelled". */
  cancelled: 1,
  /** B's code expired. */
  expired: 2,
  /** A malformed message or an internal error. The reason says which. */
  error: 3,
} as const;

/** Longest close reason this side sends. */
const MAX_CLOSE_REASON = 100;
/** Longest piece of text from the other side that is shown or logged. */
const MAX_REMOTE_TEXT = 80;

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** One bi stream. */
export interface PairStream {
  writeAll(bytes: Uint8Array): Promise<void>;
  /** Finish the send half: the other side's readToEnd then completes. */
  finish(): Promise<void>;
  /** Read until the other side finishes. Throws {@link PairProtocolError} past `limit` bytes. */
  readToEnd(limit: number): Promise<Uint8Array>;
  cancel(): Promise<void>;
}

/** Why a connection closed. */
export type PairCloseInfo =
  | { byPeer: true; code: number; reason: string }
  | { byPeer: false; reason: string };

/** One pair-ALPN connection, seen from either side. */
export interface PairConnection {
  /** The other side's id, authenticated by the handshake: 64 lowercase hex characters. */
  readonly remoteId: string;
  openBi(): Promise<PairStream>;
  acceptBi(): Promise<PairStream>;
  /** Close at once. Pending calls on both sides fail. */
  close(code: number, reason: string): void;
  /** Resolves once the connection has closed, for any reason. */
  closed(): Promise<PairCloseInfo>;
  /** Why the connection closed, or null while it is open. Set before a failed call rejects. */
  closeInfo(): PairCloseInfo | null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type PairRefusal = "not-accepting" | "busy";
export type PairFailReason = "wrong-code" | "expired";

export type PairMessage =
  | { op: "pair-hello" }
  | { op: "pair-code-shown" }
  | { op: "pair-refused"; reason: PairRefusal }
  | { op: "pair-ok" }
  | { op: "pair-code"; code: string }
  | { op: "pair-fail"; reason: PairFailReason };

/** A message that is oversized, not JSON, has an unknown op, or arrived out of turn. */
export class PairProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairProtocolError";
  }
}

export function encodePairMessage(message: PairMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

/** Parse one message. Throws {@link PairProtocolError} for anything that is not a known message. */
export function decodePairMessage(bytes: Uint8Array): PairMessage {
  if (bytes.length > PAIR_MAX_MESSAGE_BYTES) {
    throw new PairProtocolError(`message longer than ${PAIR_MAX_MESSAGE_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PairProtocolError("message is not UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PairProtocolError("message is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PairProtocolError("message is not a JSON object");
  }
  const m = value as { op?: unknown; reason?: unknown; code?: unknown };
  switch (m.op) {
    case "pair-hello":
    case "pair-code-shown":
    case "pair-ok":
      return { op: m.op };
    case "pair-refused":
      if (m.reason === "not-accepting" || m.reason === "busy") return { op: m.op, reason: m.reason };
      throw new PairProtocolError("pair-refused has an unknown reason");
    case "pair-fail":
      if (m.reason === "wrong-code" || m.reason === "expired") return { op: m.op, reason: m.reason };
      throw new PairProtocolError("pair-fail has an unknown reason");
    case "pair-code":
      if (typeof m.code === "string") return { op: m.op, code: m.code };
      throw new PairProtocolError("pair-code has no code");
    default:
      throw new PairProtocolError(
        typeof m.op === "string" ? `unknown op ${JSON.stringify(cleanRemoteText(m.op))}` : "message has no op",
      );
  }
}

// ---------------------------------------------------------------------------
// Stages and failures
// ---------------------------------------------------------------------------

export type PairRole = "initiator" | "responder";

export type PairFailure =
  | { kind: "refused"; reason: PairRefusal }
  | { kind: "wrong-code" }
  | { kind: "expired" }
  | { kind: "cancelled" }
  | { kind: "connection-failed"; detail: string }
  | { kind: "error"; detail: string };

export type PairStage =
  /** A: dialing B and sending pair-hello. */
  | { stage: "connecting" }
  /** A: B is showing a code; waiting for the user to type it. */
  | { stage: "code-entry" }
  /** A: pair-code sent, waiting for B's verdict. */
  | { stage: "verifying" }
  /** B: a pair-hello was admitted; checking whether A is already paired. */
  | { stage: "incoming" }
  /** B: showing `code` until `expiresAt` (epoch ms). */
  | { stage: "code-shown"; code: string; expiresAt: number }
  /** Both: paired and saved under `savedName`; asking for a name. */
  | { stage: "naming"; savedName: string }
  /** Both: finished. `alreadyPaired`: B already trusted A, so no code was used. */
  | { stage: "done"; name: string; alreadyPaired: boolean }
  /** Both: finished without pairing. */
  | { stage: "failed"; failure: PairFailure };

/** The stages in which the protocol itself is still running. */
const PROTOCOL_STAGES = new Set<PairStage["stage"]>(["connecting", "code-entry", "verifying", "incoming", "code-shown"]);

/** What the dialog shows for a failure. `peer` names the other install (its short id). */
export function describePairFailure(failure: PairFailure, peer: string): string {
  switch (failure.kind) {
    case "refused":
      return failure.reason === "busy"
        ? `Pairing refused: ${peer} is busy with another pairing.`
        : `Pairing refused: ${peer} does not have its Peers tab open.`;
    case "wrong-code":
      return "Wrong code. Pairing failed; start again from the install that dials.";
    case "expired":
      return "The code expired. Pairing failed.";
    case "cancelled":
      return "Pairing cancelled.";
    case "connection-failed":
      return `Connection failed: ${failure.detail}`;
    case "error":
      return `Pairing failed: ${failure.detail}`;
  }
}

/** The failure a side shows when the connection closes while the protocol is running. */
export function failureFromClose(info: PairCloseInfo): PairFailure {
  if (!info.byPeer) return { kind: "connection-failed", detail: cleanRemoteText(info.reason) || "connection closed" };
  switch (info.code) {
    case PAIR_CLOSE.cancelled:
      return { kind: "cancelled" };
    case PAIR_CLOSE.expired:
      return { kind: "expired" };
    case PAIR_CLOSE.error:
      return { kind: "error", detail: `the other side reported: ${cleanRemoteText(info.reason) || "an error"}` };
    default:
      return { kind: "connection-failed", detail: "the other side closed the connection" };
  }
}

/** The id typed into "Pair with id", checked: 64 hex characters (trimmed, lowercased), not this install's own. */
export function parsePairTarget(input: string, selfId: string | null): { ok: true; id: string } | { ok: false; error: string } {
  if (input.trim() === "") return { ok: false, error: "Paste the other install's id (ib peer id prints it)." };
  const id = normalizePeerId(input);
  if (id === null) return { ok: false, error: "Not an id: an id is 64 hex characters." };
  if (selfId !== null && id === selfId) return { ok: false, error: "That is this install's own id." };
  return { ok: true, id };
}

/**
 * Text from the other side, made safe to show: control characters become
 * spaces, format characters (bidi overrides, zero-width marks: \p{Cf}) are
 * dropped, one line, capped.
 */
function cleanRemoteText(text: string): string {
  const flat = text.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_REMOTE_TEXT ? `${flat.slice(0, MAX_REMOTE_TEXT - 1)}…` : flat;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** What both sides need from their host (src/peers/service.ts, or a test). */
export interface PairSessionDeps {
  readPeers(): Promise<Peer[]>;
  /** Save a peer, replacing any entry with the same id (store.addPeer). */
  addPeer(peer: { id: string; name: string; pairedAt?: string }): Promise<Peer>;
  /** watch.log in `ib watch`. */
  log(line: string): void;
  /** Called after every stage change. */
  onChange(): void;
  /** Schedule `fn` after `ms`; returns a cancel function. Injectable so tests never wait. */
  setTimer(ms: number, fn: () => void): () => void;
}

abstract class PairSessionBase {
  abstract readonly role: PairRole;
  private current: PairStage;
  protected conn: PairConnection | null = null;
  /** This side closed the connection on purpose; a close seen after that is not a failure. */
  private ended = false;
  /** The pairing has succeeded on the wire (A got pair-ok, or B accepted the code): Esc no longer cancels. */
  protected committed = false;
  /** The peer entry as saved, which naming replaces. */
  protected saved: Peer | null = null;
  private savingName = false;

  constructor(
    /** The other install's id. */
    readonly peerId: string,
    initial: PairStage,
    protected readonly host: PairSessionDeps,
  ) {
    this.current = initial;
  }

  get stage(): PairStage {
    return this.current;
  }

  /**
   * True until the session is done or failed, naming included. While one
   * session is pending, the responder refuses new pair-hellos as busy.
   */
  isPending(): boolean {
    return this.current.stage !== "done" && this.current.stage !== "failed";
  }

  /** Esc while the protocol runs: close the connection with the cancel code. */
  cancel(): void {
    if (!this.inProtocol() || this.committed) return;
    this.discardCode();
    this.fail({ kind: "cancelled" });
    this.endConnection(PAIR_CLOSE.cancelled, "cancelled");
  }

  /**
   * Answer the "Name for <short id>:" prompt. A name replaces the saved entry
   * (same id, same pairedAt); null or blank keeps the saved name.
   */
  async submitName(name: string | null): Promise<void> {
    if (this.current.stage !== "naming" || this.savingName || this.saved === null) return;
    const saved = this.saved;
    const typed = name?.trim() ?? "";
    if (typed === "") {
      this.setStage({ stage: "done", name: saved.name, alreadyPaired: false });
      return;
    }
    this.savingName = true;
    try {
      const stored = await this.host.addPeer({ id: this.peerId, name: typed, pairedAt: saved.pairedAt });
      this.saved = stored;
      this.setStage({ stage: "done", name: stored.name, alreadyPaired: false });
    } catch (err) {
      this.setStage({ stage: "failed", failure: { kind: "error", detail: `paired, but the name was not saved: ${errorDetail(err)}` } });
    } finally {
      this.savingName = false;
    }
  }

  protected inProtocol(): boolean {
    return PROTOCOL_STAGES.has(this.current.stage);
  }

  protected setStage(stage: PairStage): void {
    this.current = stage;
    if (stage.stage === "naming" || stage.stage === "done" || stage.stage === "failed") {
      const what = stage.stage === "failed"
        ? describePairFailure(stage.failure, shortPeerId(this.peerId))
        : stage.stage === "naming" ? "paired" : `done (${stage.alreadyPaired ? "already paired" : `named ${JSON.stringify(stage.name)}`})`;
      this.host.log(`pairing (${this.role}) with ${shortPeerId(this.peerId)}: ${what}`);
    }
    this.host.onChange();
  }

  /** Move to a failure, unless the protocol has already finished. */
  protected fail(failure: PairFailure): void {
    if (this.inProtocol()) this.setStage({ stage: "failed", failure });
  }

  /** Forget any code this side holds (responder only). */
  protected discardCode(): void {}

  /** Close the connection on purpose, once. */
  protected endConnection(code: number, reason: string): void {
    if (this.ended || this.conn === null) return;
    this.ended = true;
    if (this.conn.closeInfo() === null) this.conn.close(code, reason.slice(0, MAX_CLOSE_REASON));
  }

  /** Fail when the other side closes while the protocol runs (e.g. its Esc while A types the code). */
  protected watchClose(conn: PairConnection): void {
    conn.closed().then(
      (info) => {
        if (!this.ended) this.fail(failureFromClose(info));
      },
      () => {},
    );
  }

  /** A transport call failed: classify it by why the connection closed. */
  protected handleError(err: unknown): void {
    if (!this.inProtocol()) return;
    if (err instanceof PairProtocolError) {
      this.protocolError(err.message);
      return;
    }
    const info = this.conn?.closeInfo() ?? null;
    if (info !== null && !this.ended) {
      this.fail(failureFromClose(info));
      return;
    }
    this.fail({ kind: "connection-failed", detail: errorDetail(err) });
    this.endConnection(PAIR_CLOSE.error, "connection error");
  }

  /** The other side broke the protocol: close with the error code and show why. */
  protected protocolError(detail: string): void {
    this.discardCode();
    this.fail({ kind: "error", detail });
    this.endConnection(PAIR_CLOSE.error, detail);
  }

  /**
   * Send B's last message: write it, finish, then wait for A to close (or the
   * linger timeout) and close. The caller sets the final stage first, so A's
   * close, which can arrive before this resolves, is never read as a failure.
   */
  protected async sendFinal(stream: PairStream, message: PairMessage): Promise<void> {
    const conn = this.conn!;
    this.ended = true;
    try {
      await stream.writeAll(encodePairMessage(message));
      await stream.finish();
    } catch (err) {
      this.host.log(`pairing (${this.role}) with ${shortPeerId(this.peerId)}: last message not sent: ${errorDetail(err)}`);
      closeQuietly(conn, PAIR_CLOSE.error, "connection error");
      return;
    }
    await lingerThenClose(conn, this.host.setTimer);
  }
}

/** Wait until `conn` closes or {@link FINAL_REPLY_LINGER_MS} passes, then close it if still open. */
async function lingerThenClose(conn: PairConnection, setTimer: PairSessionDeps["setTimer"]): Promise<void> {
  await new Promise<void>((resolve) => {
    const cancel = setTimer(FINAL_REPLY_LINGER_MS, resolve);
    conn.closed().then(
      () => {
        cancel();
        resolve();
      },
      () => {
        cancel();
        resolve();
      },
    );
  });
  if (conn.closeInfo() === null) conn.close(PAIR_CLOSE.done, "done");
}

function closeQuietly(conn: PairConnection, code: number, reason: string): void {
  try {
    if (conn.closeInfo() === null) conn.close(code, reason.slice(0, MAX_CLOSE_REASON));
  } catch {
    // Already gone.
  }
}

/** A's side: dial B, send pair-hello, then the code the user types. */
export interface InitiatorDeps extends PairSessionDeps {
  /** Dial `peerId` on {@link PAIR_ALPN}. */
  dial(peerId: string): Promise<PairConnection>;
}

export class PairInitiator extends PairSessionBase {
  readonly role = "initiator";

  constructor(peerId: string, private readonly deps: InitiatorDeps) {
    super(peerId, { stage: "connecting" }, deps);
  }

  /** Dial and send pair-hello. Resolves once B's reply is handled. Never throws. */
  async start(): Promise<void> {
    let conn: PairConnection;
    try {
      conn = await this.deps.dial(this.peerId);
    } catch (err) {
      this.fail({ kind: "connection-failed", detail: errorDetail(err) });
      return;
    }
    if (!this.inProtocol()) {
      // Cancelled while the dial was in flight.
      closeQuietly(conn, PAIR_CLOSE.cancelled, "cancelled");
      return;
    }
    this.conn = conn;
    this.watchClose(conn);
    const reply = await this.request({ op: "pair-hello" });
    if (reply === null) return;
    switch (reply.op) {
      case "pair-code-shown":
        this.setStage({ stage: "code-entry" });
        return;
      case "pair-ok":
        await this.paired();
        return;
      case "pair-refused":
        this.endConnection(PAIR_CLOSE.done, "done");
        this.fail({ kind: "refused", reason: reply.reason });
        return;
      default:
        this.protocolError(`unexpected ${reply.op} in reply to pair-hello`);
    }
  }

  /** Send the code the user typed (normalized). Only in code-entry; B allows one attempt. */
  async submitCode(code: string): Promise<void> {
    if (this.stage.stage !== "code-entry") return;
    this.setStage({ stage: "verifying" });
    const reply = await this.request({ op: "pair-code", code: normalizePairCode(code) });
    if (reply === null) return;
    switch (reply.op) {
      case "pair-ok":
        await this.paired();
        return;
      case "pair-fail":
        this.endConnection(PAIR_CLOSE.done, "done");
        this.fail(reply.reason === "wrong-code" ? { kind: "wrong-code" } : { kind: "expired" });
        return;
      default:
        this.protocolError(`unexpected ${reply.op} in reply to pair-code`);
    }
  }

  /** One request on its own bi stream. Null when the session failed or was cancelled meanwhile. */
  private async request(message: PairMessage): Promise<PairMessage | null> {
    const conn = this.conn!;
    try {
      const stream = await conn.openBi();
      await stream.writeAll(encodePairMessage(message));
      await stream.finish();
      const reply = decodePairMessage(await stream.readToEnd(PAIR_MAX_MESSAGE_BYTES));
      return this.inProtocol() ? reply : null;
    } catch (err) {
      this.handleError(err);
      return null;
    }
  }

  /** pair-ok: close, save B (keeping a name A already gave it), ask for a name. */
  private async paired(): Promise<void> {
    this.committed = true;
    this.endConnection(PAIR_CLOSE.done, "done");
    try {
      const existing = (await this.host.readPeers()).find((p) => p.id === this.peerId);
      this.saved = await this.host.addPeer({ id: this.peerId, name: existing?.name ?? shortPeerId(this.peerId) });
    } catch (err) {
      this.fail({ kind: "error", detail: `could not save ${shortPeerId(this.peerId)}: ${errorDetail(err)}` });
      return;
    }
    this.setStage({ stage: "naming", savedName: this.saved.name });
  }
}

/** B's side: what the host decides and provides. */
export interface ResponderDeps extends PairSessionDeps {
  /**
   * Called once per pair-hello, synchronously: return the refusal, or null to
   * admit `session` (the host records it as its current pairing in the same
   * call, so the check and the claim cannot interleave with another hello).
   */
  admit(session: PairResponder): PairRefusal | null;
  generateCode(): string;
  /** Epoch ms. Injectable so tests can expire a code without waiting. */
  now(): number;
}

export class PairResponder extends PairSessionBase {
  readonly role = "responder";
  private code: string | null = null;
  private cancelExpiry: (() => void) | null = null;

  constructor(conn: PairConnection, private readonly deps: ResponderDeps) {
    super(conn.remoteId, { stage: "incoming" }, deps);
    this.conn = conn;
  }

  /** Run an admitted session, starting from the pair-hello's stream. Never throws. */
  async run(helloStream: PairStream): Promise<void> {
    const conn = this.conn!;
    this.watchClose(conn);
    let existing: Peer | undefined;
    try {
      existing = (await this.host.readPeers()).find((p) => p.id === this.peerId);
    } catch (err) {
      this.fail({ kind: "error", detail: `could not read peers.json: ${errorDetail(err)}` });
      this.endConnection(PAIR_CLOSE.error, "internal error");
      return;
    }
    if (!this.inProtocol()) return;

    if (existing !== undefined) {
      // Already trusted (e.g. A never got the last pair-ok): no code, and
      // the name B gave A stays.
      this.committed = true;
      this.saved = existing;
      this.setStage({ stage: "done", name: existing.name, alreadyPaired: true });
      await this.sendFinal(helloStream, { op: "pair-ok" });
      return;
    }

    const code = this.deps.generateCode();
    const expiresAt = pairCodeExpiresAt(this.deps.now());
    this.code = code;
    this.cancelExpiry = this.host.setTimer(PAIR_CODE_TTL_MS, () => this.expire());
    this.setStage({ stage: "code-shown", code, expiresAt });
    try {
      await helloStream.writeAll(encodePairMessage({ op: "pair-code-shown" }));
      await helloStream.finish();
    } catch (err) {
      this.discardCode();
      this.handleError(err);
      return;
    }

    let stream: PairStream;
    let message: PairMessage;
    try {
      stream = await conn.acceptBi();
      message = decodePairMessage(await stream.readToEnd(PAIR_MAX_MESSAGE_BYTES));
    } catch (err) {
      this.discardCode();
      this.handleError(err);
      return;
    }
    if (!this.inProtocol()) return;
    if (message.op !== "pair-code") {
      this.protocolError(`expected pair-code, got ${message.op}`);
      return;
    }

    // One attempt per code: whatever happens next, this code is gone.
    const expected = this.code;
    this.discardCode();
    if (expected === null || isPairCodeExpired(expiresAt, this.deps.now())) {
      this.fail({ kind: "expired" });
      await this.sendFinal(stream, { op: "pair-fail", reason: "expired" });
      return;
    }
    if (!pairCodesEqual(normalizePairCode(message.code), expected)) {
      this.fail({ kind: "wrong-code" });
      await this.sendFinal(stream, { op: "pair-fail", reason: "wrong-code" });
      return;
    }

    // Save A before replying pair-ok: once A hears pair-ok, B must trust it.
    this.committed = true;
    try {
      this.saved = await this.host.addPeer({ id: this.peerId, name: shortPeerId(this.peerId) });
    } catch (err) {
      this.fail({ kind: "error", detail: `could not save ${shortPeerId(this.peerId)}: ${errorDetail(err)}` });
      this.endConnection(PAIR_CLOSE.error, "could not save the pairing");
      return;
    }
    this.setStage({ stage: "naming", savedName: this.saved.name });
    await this.sendFinal(stream, { op: "pair-ok" });
  }

  protected override discardCode(): void {
    this.code = null;
    this.cancelExpiry?.();
    this.cancelExpiry = null;
  }

  /** The 2-minute timer: discard the code and close, so A shows "expired". */
  private expire(): void {
    this.cancelExpiry = null;
    if (this.stage.stage !== "code-shown" || this.committed) return;
    this.discardCode();
    this.fail({ kind: "expired" });
    this.endConnection(PAIR_CLOSE.expired, "expired");
  }
}

export type PairSession = PairInitiator | PairResponder;

/**
 * Serve one incoming pair-ALPN connection as B: read pair-hello, ask the host
 * to admit it, and either refuse or run the session. Never throws.
 */
export async function respondToPairing(conn: PairConnection, deps: ResponderDeps): Promise<void> {
  const from = shortPeerId(conn.remoteId);
  let stream: PairStream;
  let hello: PairMessage;
  // A connection that never sends pair-hello must not hold this handler (and
  // its connection) open: close it after HELLO_TIMEOUT_MS, which fails the read.
  let timedOut = false;
  const cancelTimeout = deps.setTimer(HELLO_TIMEOUT_MS, () => {
    timedOut = true;
    closeQuietly(conn, PAIR_CLOSE.error, "no pair-hello");
  });
  try {
    stream = await conn.acceptBi();
    hello = decodePairMessage(await stream.readToEnd(PAIR_MAX_MESSAGE_BYTES));
  } catch (err) {
    if (timedOut) {
      deps.log(`pairing: no pair-hello from ${from} within ${HELLO_TIMEOUT_MS / 1000} s`);
    } else if (err instanceof PairProtocolError) {
      deps.log(`pairing: ${err.message}, from ${from}`);
      closeQuietly(conn, PAIR_CLOSE.error, err.message);
    } else {
      deps.log(`pairing: connection from ${from} failed before pair-hello: ${errorDetail(err)}`);
      closeQuietly(conn, PAIR_CLOSE.error, "connection error");
    }
    return;
  } finally {
    cancelTimeout();
  }
  if (hello.op !== "pair-hello") {
    deps.log(`pairing: expected pair-hello from ${from}, got ${hello.op}`);
    closeQuietly(conn, PAIR_CLOSE.error, `expected pair-hello, got ${hello.op}`);
    return;
  }

  const session = new PairResponder(conn, deps);
  const refusal = deps.admit(session);
  if (refusal !== null) {
    deps.log(`pairing: refused ${from} (${refusal})`);
    try {
      await stream.writeAll(encodePairMessage({ op: "pair-refused", reason: refusal }));
      await stream.finish();
    } catch {
      closeQuietly(conn, PAIR_CLOSE.error, "connection error");
      return;
    }
    await lingerThenClose(conn, deps.setTimer);
    return;
  }
  deps.log(`pairing: request from ${from}`);
  await session.run(stream);
}
