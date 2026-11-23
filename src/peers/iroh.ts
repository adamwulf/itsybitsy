/**
 * The one module that loads the iroh addon (`@number0/iroh`), and only through
 * the dynamic import in {@link loadIroh}. Nothing else in the codebase imports
 * the package (src/peers/iroh.test.ts checks this).
 *
 * Loading the addon costs ~25 ms of CPU and 230-400 ms of wall time in the
 * compiled binary (docs/plans/iroh-spike-findings.md), so only `ib watch`
 * loads it. Hooks and the `ib peer` commands never do.
 *
 * A thin wrapper over the addon's quirks:
 *   - the addon takes and returns byte buffers as plain `Array<number>` and
 *     rejects `Uint8Array`/`Buffer`; this module converts at the boundary, so
 *     callers only see `Uint8Array`;
 *   - every addon error is a plain `Error` with `code: "GenericFailure"` whose
 *     meaning is only in its (often multi-line, Rust-debug) message; this module
 *     rethrows each one as an {@link IrohError} with a short one-line message.
 *
 * It exposes only what the current phase uses. Later phases extend it. Phase 2
 * (pairing) adds endpoints, connections and bi streams.
 */

import { InjectionContext } from "../types";

/** The addon's module type. A type-only reference: it loads nothing. */
type IrohAddon = typeof import("@number0/iroh");
type AddonSecretKey = InstanceType<IrohAddon["SecretKey"]>;
type AddonEndpointId = InstanceType<IrohAddon["EndpointId"]>;
type AddonEndpoint = InstanceType<IrohAddon["Endpoint"]>;
type AddonEndpointAddr = InstanceType<IrohAddon["EndpointAddr"]>;
type AddonIncoming = InstanceType<IrohAddon["Incoming"]>;
type AddonConnection = InstanceType<IrohAddon["Connection"]>;
type AddonBiStream = InstanceType<IrohAddon["BiStream"]>;

/** Longest message an {@link IrohError} carries before it is cut. */
const MAX_ERROR_MESSAGE = 160;

/** An addon failure, with the addon's message cut down to one short line. */
export class IrohError extends Error {
  constructor(
    /** The wrapper call that failed, e.g. `"SecretKey.fromBytes"`. */
    readonly op: string,
    /** The shortened addon message. */
    readonly detail: string,
  ) {
    super(`${op}: ${detail}`);
    this.name = "IrohError";
  }
}

/**
 * Shorten an addon error to one line: the first non-empty line of its message,
 * whitespace collapsed, cut at {@link MAX_ERROR_MESSAGE} characters.
 */
export function shortIrohMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  if (collapsed.length === 0) return "unknown error";
  return collapsed.length > MAX_ERROR_MESSAGE ? `${collapsed.slice(0, MAX_ERROR_MESSAGE - 1)}…` : collapsed;
}

/** Run one addon call, rethrowing its failure as an {@link IrohError}. */
function call<T>(op: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new IrohError(op, shortIrohMessage(err));
  }
}

/** {@link call} for an addon call that returns a promise. */
async function callAsync<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new IrohError(op, shortIrohMessage(err));
  }
}

const toArray = (bytes: Uint8Array): number[] => Array.from(bytes);
const toUint8 = (bytes: number[]): Uint8Array => Uint8Array.from(bytes);
const textToArray = (text: string): number[] => Array.from(new TextEncoder().encode(text));
const arrayToText = (bytes: number[]): string => new TextDecoder().decode(Uint8Array.from(bytes));

/**
 * True for the error {@link IrohBiStream.readToEnd} throws when the stream is
 * longer than its limit (the addon's `TooLong`).
 */
export function isIrohTooLong(err: unknown): boolean {
  return err instanceof IrohError && err.op === "RecvStream.readToEnd" && err.detail === "TooLong";
}

/** Why a connection closed. */
export type IrohCloseInfo =
  /** The other side called close(code, reason). */
  | { byPeer: true; code: number; reason: string }
  /** Anything else: closed locally (`"closed"`), timed out, and so on. */
  | { byPeer: false; reason: string };

/**
 * Parse the addon's close-reason text. A close by the other side reads
 * `closed by peer: <reason> (code <n>)`, where the reason is the peer's own
 * text and may itself contain parentheses; anything else (`"closed"` after a
 * local close, `"timed out"`, ...) is not by the peer.
 */
export function parseIrohCloseReason(text: string): IrohCloseInfo {
  const match = /^closed by peer: ([\s\S]*) \(code (\d+)\)$/.exec(text);
  if (match) return { byPeer: true, code: Number(match[2]), reason: match[1]! };
  return { byPeer: false, reason: text };
}

/** An endpoint's id: a 32-byte ed25519 public key, written as 64 lowercase hex characters. */
export class IrohEndpointId {
  constructor(private readonly raw: AddonEndpointId) {}

  /** The full id: 64 lowercase hex characters. */
  toString(): string {
    return call("EndpointId.toString", () => this.raw.toString());
  }

  /** The short id: the first 10 hex characters. */
  fmtShort(): string {
    return call("EndpointId.fmtShort", () => this.raw.fmtShort());
  }
}

/** The secret half of an endpoint identity: 32 bytes. */
export class IrohSecretKey {
  constructor(private readonly raw: AddonSecretKey) {}

  /** The 32 secret-key bytes. */
  toBytes(): Uint8Array {
    return toUint8(call("SecretKey.toBytes", () => this.raw.toBytes()));
  }

  /** The public id this key derives. */
  public(): IrohEndpointId {
    return new IrohEndpointId(call("SecretKey.public", () => this.raw.public()));
  }
}

/**
 * One bidirectional QUIC stream: the send half (`writeAll`, `finish`) and the
 * receive half (`readToEnd`) together.
 */
export class IrohBiStream {
  constructor(private readonly raw: AddonBiStream) {}

  /** Abort only this request, even if the send half was already finished. */
  async cancel(): Promise<void> {
    await Promise.allSettled([this.raw.recv.stop(0n), this.raw.send.reset(0n)]);
  }

  async read(limit: number): Promise<Uint8Array> {
    return toUint8(await callAsync("RecvStream.read", () => this.raw.recv.read(limit)));
  }

  /** Write all of `bytes`. */
  writeAll(bytes: Uint8Array): Promise<void> {
    return callAsync("SendStream.writeAll", () => this.raw.send.writeAll(toArray(bytes)));
  }

  /** Finish the send half: the other side's `readToEnd` then completes. */
  finish(): Promise<void> {
    return callAsync("SendStream.finish", () => this.raw.send.finish());
  }

  /**
   * Read until the other side finishes. Throws an {@link IrohError} that
   * {@link isIrohTooLong} accepts when the stream is longer than `limit` bytes.
   */
  async readToEnd(limit: number): Promise<Uint8Array> {
    return toUint8(await callAsync("RecvStream.readToEnd", () => this.raw.recv.readToEnd(limit)));
  }
}

/** An open connection to another endpoint. */
export class IrohConnection {
  constructor(private readonly raw: AddonConnection) {}

  /** The other side's id, authenticated by the QUIC handshake. */
  remoteId(): IrohEndpointId {
    return new IrohEndpointId(call("Connection.remoteId", () => this.raw.remoteId()));
  }

  /** The ALPN the connection was made with. */
  alpn(): string {
    return arrayToText(call("Connection.alpn", () => this.raw.alpn()));
  }

  /** Open a new bi stream. The other side sees it in {@link acceptBi} once it has data. */
  async openBi(): Promise<IrohBiStream> {
    return new IrohBiStream(await callAsync("Connection.openBi", () => this.raw.openBi()));
  }

  /** Wait for the other side to open a bi stream. */
  async acceptBi(): Promise<IrohBiStream> {
    return new IrohBiStream(await callAsync("Connection.acceptBi", () => this.raw.acceptBi()));
  }

  /**
   * Close the connection at once. The other side's pending calls fail, and its
   * {@link closeInfo} reads `{byPeer: true, code, reason}`.
   */
  close(code: number, reason: string): void {
    call("Connection.close", () => this.raw.close(BigInt(code), textToArray(reason)));
  }

  /** Resolves once the connection has closed, for any reason. */
  async closed(): Promise<IrohCloseInfo> {
    return parseIrohCloseReason(await callAsync("Connection.closed", () => this.raw.closed()));
  }

  /**
   * Why the connection closed, or null while it is open. Already set by the
   * time a call that failed because of the close rejects.
   */
  closeInfo(): IrohCloseInfo | null {
    const reason = call("Connection.closeReason", () => this.raw.closeReason());
    return reason === null ? null : parseIrohCloseReason(reason);
  }
}

/** A connection attempt from another endpoint, before its handshake. */
export class IrohIncoming {
  constructor(private readonly raw: AddonIncoming) {}

  /**
   * Run the handshake and return the connection. A failed handshake (an ALPN
   * this endpoint does not offer, a dialer that expected another id) rejects
   * here, so an accept loop must catch per connection.
   */
  async accept(): Promise<IrohConnection> {
    const accepting = await callAsync("Incoming.accept", () => this.raw.accept());
    return new IrohConnection(await callAsync("Accepting.connect", () => accepting.connect()));
  }
}

/** A bound endpoint. */
export class IrohEndpoint {
  constructor(
    private readonly raw: AddonEndpoint,
    private readonly makeAddr: (id: string, directAddresses?: string[]) => AddonEndpointAddr,
  ) {}

  /** This endpoint's id. */
  id(): IrohEndpointId {
    return new IrohEndpointId(call("Endpoint.id", () => this.raw.id()));
  }

  /** The direct `ip:port` addresses this endpoint can be reached at. */
  directAddresses(): string[] {
    return call("Endpoint.addr", () => this.raw.addr().directAddresses());
  }

  /**
   * The next incoming connection attempt, or null once the endpoint is closed.
   * A pending call keeps the process alive until {@link close}.
   */
  async acceptNext(): Promise<IrohIncoming | null> {
    const incoming = await callAsync("Endpoint.acceptNext", () => this.raw.acceptNext());
    return incoming === null ? null : new IrohIncoming(incoming);
  }

  /**
   * Dial the endpoint with this full id. With no `directAddresses`, iroh finds
   * it by id alone (relays and discovery, under the n0 preset); tests pass the
   * other endpoint's {@link directAddresses}. A dial can take up to 30 s to fail.
   */
  async connect(id: string, alpn: string, directAddresses?: string[]): Promise<IrohConnection> {
    const addr = call("EndpointAddr", () => this.makeAddr(id, directAddresses));
    return new IrohConnection(await callAsync("Endpoint.connect", () => this.raw.connect(addr, textToArray(alpn))));
  }

  /** Close the endpoint and its connections. A pending {@link acceptNext} resolves with null. */
  close(): Promise<void> {
    return callAsync("Endpoint.close", () => this.raw.close());
  }
}

/** Which network an endpoint uses. */
export type IrohPreset =
  /** n0's public relays and discovery: other endpoints find this one by id alone. */
  | { kind: "n0" }
  /**
   * No relays and no discovery, bound to `bindAddr` (e.g. `"127.0.0.1:0"`).
   * Touches no outside service. For tests, which dial {@link IrohEndpoint.directAddresses}.
   */
  | { kind: "local"; bindAddr: string };

export interface IrohBindOptions {
  /** The 32 secret-key bytes: the endpoint's identity. */
  secretKey: Uint8Array;
  /** The ALPNs this endpoint accepts connections for. */
  alpns: string[];
  preset: IrohPreset;
}

/** What {@link loadIroh} returns: the wrapped calls this phase uses. */
export interface Iroh {
  SecretKey: {
    /** A new random secret key. */
    generate(): IrohSecretKey;
    /** A secret key from its 32 bytes. */
    fromBytes(bytes: Uint8Array): IrohSecretKey;
  };
  EndpointId: {
    /**
     * Parse a full id. Accepts only 64 lowercase hex characters: trim and
     * lowercase user input first (normalizePeerId in src/peers/store.ts).
     */
    fromString(id: string): IrohEndpointId;
  };
  Endpoint: {
    /** Bind an endpoint. */
    bind(options: IrohBindOptions): Promise<IrohEndpoint>;
  };
}

function wrap(addon: IrohAddon): Iroh {
  const makeAddr = (id: string, directAddresses?: string[]): AddonEndpointAddr => {
    const endpointId = addon.EndpointId.fromString(id);
    return directAddresses ? new addon.EndpointAddr(endpointId, null, directAddresses) : new addon.EndpointAddr(endpointId);
  };
  const bind = async (options: IrohBindOptions): Promise<AddonEndpoint> => {
    const secretKey = toArray(options.secretKey);
    const alpns = options.alpns.map(textToArray);
    if (options.preset.kind === "n0") return addon.Endpoint.bind({ secretKey, alpns });
    const builder = addon.Endpoint.builder();
    addon.presetMinimal(builder);
    builder.relayMode(addon.RelayMode.disabled());
    builder.bindAddr(options.preset.bindAddr);
    builder.secretKey(secretKey);
    builder.alpns(alpns);
    return builder.bind();
  };
  return {
    SecretKey: {
      generate: () => new IrohSecretKey(call("SecretKey.generate", () => addon.SecretKey.generate())),
      fromBytes: (bytes) => new IrohSecretKey(call("SecretKey.fromBytes", () => addon.SecretKey.fromBytes(toArray(bytes)))),
    },
    EndpointId: {
      fromString: (id) => new IrohEndpointId(call("EndpointId.fromString", () => addon.EndpointId.fromString(id))),
    },
    Endpoint: {
      bind: async (options) => new IrohEndpoint(await callAsync("Endpoint.bind", () => bind(options)), makeAddr),
    },
  };
}

/**
 * Loads the addon module. Injectable so a test can make loading throw and so
 * prove a code path never reaches the addon.
 */
export const irohAddonLoaderCtx = new InjectionContext<() => Promise<IrohAddon>>(() => import("@number0/iroh"));

/**
 * Load the iroh addon and return the wrapped API. The module system caches
 * the import, so only the first call in a process pays the load cost. A load
 * failure is rethrown as an {@link IrohError} with op `"load"`.
 */
export async function loadIroh(): Promise<Iroh> {
  let addon: IrohAddon;
  try {
    addon = await irohAddonLoaderCtx.fn();
  } catch (err) {
    throw new IrohError("load", shortIrohMessage(err));
  }
  return wrap(addon);
}
