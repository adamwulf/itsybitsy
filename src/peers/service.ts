/**
 * The iroh endpoint inside `ib watch` (docs/plans/iroh-peering.md, "Process
 * model"; SPEC.md §20.3), and the one pairing session it runs at a time.
 *
 * - Binding: Phase 2 binds when the Peers dialog opens (`openDialog`), never
 *   at boot, and only once. Before binding it takes the endpoint lock; when
 *   another live `ib watch` holds it, it does not bind and reports
 *   "peering disabled: ib watch pid N owns the endpoint". Each later dialog
 *   open retries, so peering moves here once the owner exits.
 * - Binding is async and the dialog shows "starting…" while it runs, but the
 *   first addon load is NOT off the event loop: iroh.ts's dynamic import of
 *   the package evaluates the napi module synchronously, so the first open
 *   stalls the UI once, for about a third of a second (230-400 ms compiled),
 *   after the dialog has drawn. The module stays loaded, so a later rebind
 *   does not stall.
 * - Once bound, the endpoint stays up until `shutdown()` (ib watch exit),
 *   which closes it (resolving the pending `acceptNext`, which otherwise keeps
 *   Bun alive) and releases the lock.
 * - The accept loop hands each connection to its own task and catches errors
 *   per connection: one failed handshake never stops it. It dispatches by
 *   ALPN; Phase 2 has only the pair ALPN. If `acceptNext` itself fails, the
 *   endpoint is closed and the lock released, so the next dialog open binds
 *   afresh.
 * - Everything is logged through the injected `log` (watch.log in `ib watch`),
 *   never to stderr, which would corrupt the TUI.
 *
 * The id and the paired peers come from identity.ts and store.ts, so the
 * dialog shows them even when peering is disabled or the addon fails.
 */

import { acquireEndpointLock, releaseEndpointLock, type EndpointLockResult } from "./endpoint-lock";
import { loadOrCreateIdentity, type PeerIdentity } from "./identity";
import { isIrohTooLong, loadIroh, type IrohCloseInfo } from "./iroh";
import { generatePairCode } from "./pair-code";
import {
  PAIR_ALPN,
  PAIR_CLOSE,
  PairInitiator,
  PairProtocolError,
  parsePairTarget,
  respondToPairing,
  type PairConnection,
  type PairRefusal,
  type PairResponder,
  type PairRole,
  type PairSession,
  type PairSessionDeps,
  type PairStage,
  type PairStream,
} from "./pairing";
import { addPeer, readPeers, shortPeerId, type Peer } from "./store";

// ---------------------------------------------------------------------------
// What the service needs from a bound endpoint. The wrapper's IrohEndpoint,
// IrohIncoming, IrohConnection and IrohBiStream satisfy these structurally;
// the tests use fakes.
// ---------------------------------------------------------------------------

export interface ServiceStream {
  writeAll(bytes: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  readToEnd(limit: number): Promise<Uint8Array>;
}

export interface ServiceConnection {
  remoteId(): { toString(): string };
  alpn(): string;
  openBi(): Promise<ServiceStream>;
  acceptBi(): Promise<ServiceStream>;
  close(code: number, reason: string): void;
  closed(): Promise<IrohCloseInfo>;
  closeInfo(): IrohCloseInfo | null;
}

export interface ServiceIncoming {
  accept(): Promise<ServiceConnection>;
}

export interface ServiceEndpoint {
  acceptNext(): Promise<ServiceIncoming | null>;
  connect(id: string, alpn: string): Promise<ServiceConnection>;
  close(): Promise<void>;
}

export interface PeerServiceDeps {
  acquireLock(): Promise<EndpointLockResult>;
  releaseLock(): Promise<unknown>;
  loadIdentity(): Promise<PeerIdentity>;
  /** Load the addon and bind an endpoint with this key, accepting these ALPNs. */
  bindEndpoint(secretKey: Uint8Array, alpns: string[]): Promise<ServiceEndpoint>;
  readPeers(): Promise<Peer[]>;
  addPeer(peer: { id: string; name: string; pairedAt?: string }): Promise<Peer>;
  generateCode(): string;
  now(): number;
  setTimer(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

/** The real dependencies: the endpoint lock, ~/.itsybitsy/peer, and the addon with the n0 preset. */
export function defaultPeerServiceDeps(log: (line: string) => void): PeerServiceDeps {
  return {
    acquireLock: () => acquireEndpointLock(),
    releaseLock: () => releaseEndpointLock(),
    loadIdentity: loadOrCreateIdentity,
    bindEndpoint: async (secretKey, alpns) => (await loadIroh()).Endpoint.bind({ secretKey, alpns, preset: { kind: "n0" } }),
    readPeers,
    addPeer,
    generateCode: () => generatePairCode(),
    now: () => Date.now(),
    setTimer: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    log,
  };
}

/** The endpoint's state, as the dialog shows it. */
export type EndpointStatus =
  /** Not asked to bind yet. */
  | { kind: "idle" }
  /** Loading the identity, taking the lock, loading the addon and binding. */
  | { kind: "starting" }
  /** Bound; the accept loop runs. */
  | { kind: "listening" }
  /** Another live `ib watch` holds the endpoint lock. */
  | { kind: "disabled"; ownerPid: number }
  | { kind: "error"; message: string };

export interface PeerSessionView {
  /** Increases with every new session, so the dialog can reset its inputs. */
  id: number;
  role: PairRole;
  /** The other install's id. */
  peerId: string;
  stage: PairStage;
}

export interface PeerServiceView {
  status: EndpointStatus;
  /** This install's id, once loaded. */
  selfId: string | null;
  identityError: string | null;
  peers: Peer[];
  peersError: string | null;
  session: PeerSessionView | null;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Adapt a wrapper connection to the pair protocol's seam. */
export function toPairConnection(conn: ServiceConnection): PairConnection {
  const stream = (s: ServiceStream): PairStream => ({
    writeAll: (bytes) => s.writeAll(bytes),
    finish: () => s.finish(),
    readToEnd: async (limit) => {
      try {
        return await s.readToEnd(limit);
      } catch (err) {
        if (isIrohTooLong(err)) throw new PairProtocolError(`message longer than ${limit} bytes`);
        throw err;
      }
    },
  });
  return {
    remoteId: conn.remoteId().toString(),
    openBi: async () => stream(await conn.openBi()),
    acceptBi: async () => stream(await conn.acceptBi()),
    close: (code, reason) => conn.close(code, reason),
    closed: () => conn.closed(),
    closeInfo: () => conn.closeInfo(),
  };
}

export class PeerService {
  private status: EndpointStatus = { kind: "idle" };
  private endpoint: ServiceEndpoint | null = null;
  private binding: Promise<void> | null = null;
  private lockHeld = false;
  private shuttingDown = false;
  private dialogOpen = false;
  private selfId: string | null = null;
  private identityError: string | null = null;
  private peers: Peer[] = [];
  private peersError: string | null = null;
  private active: { id: number; session: PairSession } | null = null;
  private nextSessionId = 0;
  private readonly listeners = new Set<() => void>();
  /** The accept loop's promise, for tests. */
  acceptLoopDone: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PeerServiceDeps) {}

  /** Subscribe to every change of {@link view}. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  view(): PeerServiceView {
    const active = this.active;
    return {
      status: this.status,
      selfId: this.selfId,
      identityError: this.identityError,
      peers: this.peers,
      peersError: this.peersError,
      session: active === null
        ? null
        : { id: active.id, role: active.session.role, peerId: active.session.peerId, stage: active.session.stage },
    };
  }

  /** The Peers dialog opened: accept pairing requests, and bind if not bound yet. */
  openDialog(): void {
    this.dialogOpen = true;
    void this.refreshPeers();
    const kind = this.status.kind;
    if (!this.shuttingDown && this.binding === null && kind !== "starting" && kind !== "listening") {
      this.binding = this.bind().finally(() => {
        this.binding = null;
      });
    }
    this.notify();
  }

  /** The Peers dialog closed: stop accepting, and cancel a pairing still in progress. */
  closeDialog(): void {
    this.dialogOpen = false;
    this.cancel();
    this.active = null;
    this.notify();
  }

  /**
   * Start pairing with the id typed into "Pair with id". Returns the error to
   * show inline, or null once the session has started.
   */
  pairWith(input: string): string | null {
    const target = parsePairTarget(input, this.selfId);
    if (!target.ok) return target.error;
    const status = this.status;
    if (status.kind === "starting" || status.kind === "idle") return "Peering is still starting; try again in a moment.";
    if (status.kind === "disabled") return `Peering is disabled: ib watch pid ${status.ownerPid} owns the endpoint.`;
    if (status.kind === "error") return `Peering is unavailable: ${status.message}`;
    if (this.active?.session.isPending()) return "Another pairing is in progress.";
    const session = new PairInitiator(target.id, {
      ...this.sessionDeps(),
      dial: (peerId) => this.dial(peerId),
    });
    this.install(session);
    void session.start();
    return null;
  }

  /** The code typed at A's prompt. */
  submitCode(code: string): void {
    const session = this.active?.session;
    if (session instanceof PairInitiator) void session.submitCode(code);
  }

  /** The name typed at the "Name for <short id>:" prompt; null keeps the saved name. */
  submitName(name: string | null): void {
    void this.active?.session.submitName(name);
  }

  /**
   * Esc while a pairing runs: cancel it and go back to the idle view. A session
   * that can no longer be cancelled (already paired: naming, or saving after
   * pair-ok) stays.
   */
  cancel(): void {
    const active = this.active;
    if (active === null) return;
    active.session.cancel();
    if (!active.session.isPending()) {
      this.active = null;
      this.notify();
    }
  }

  /** Leave a finished session's result: back to the idle view. */
  dismiss(): void {
    if (this.active !== null && !this.active.session.isPending()) {
      this.active = null;
      this.notify();
    }
  }

  /** ib watch is exiting: cancel any pairing, close the endpoint, release the lock. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.active?.session.cancel();
    this.active = null;
    if (this.binding !== null) await this.binding;
    await this.closeEndpoint();
  }

  /**
   * Close the bound endpoint (if any) and release the lock (if held), leaving
   * the service unbound so a later bind starts clean.
   */
  private async closeEndpoint(): Promise<void> {
    const ep = this.endpoint;
    this.endpoint = null;
    try {
      if (ep !== null) await ep.close();
    } catch (err) {
      this.deps.log(`peering: closing the endpoint failed: ${errorDetail(err)}`);
    } finally {
      if (this.lockHeld) {
        this.lockHeld = false;
        try {
          await this.deps.releaseLock();
        } catch (err) {
          this.deps.log(`peering: releasing the endpoint lock failed: ${errorDetail(err)}`);
        }
      }
    }
    if (ep !== null) this.deps.log("peering: endpoint closed");
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private setStatus(status: EndpointStatus): void {
    this.status = status;
    this.notify();
  }

  private async refreshPeers(): Promise<void> {
    try {
      this.peers = await this.deps.readPeers();
      this.peersError = null;
    } catch (err) {
      this.peersError = errorDetail(err);
    }
    this.notify();
  }

  private async bind(): Promise<void> {
    this.setStatus({ kind: "starting" });
    let identity: PeerIdentity;
    try {
      identity = await this.deps.loadIdentity();
      this.selfId = identity.id;
      this.identityError = null;
    } catch (err) {
      this.identityError = errorDetail(err);
      this.deps.log(`peering: could not load this install's identity: ${this.identityError}`);
      this.setStatus({ kind: "error", message: this.identityError });
      return;
    }

    let lock: EndpointLockResult;
    try {
      lock = await this.deps.acquireLock();
    } catch (err) {
      const message = `could not take the endpoint lock: ${errorDetail(err)}`;
      this.deps.log(`peering: ${message}`);
      this.setStatus({ kind: "error", message });
      return;
    }
    if (!lock.acquired) {
      this.deps.log(`peering disabled: ib watch pid ${lock.ownerPid} owns the endpoint`);
      this.setStatus({ kind: "disabled", ownerPid: lock.ownerPid });
      return;
    }
    this.lockHeld = true;
    if (lock.takenFromPid !== undefined) {
      this.deps.log(`peering: took over the endpoint lock from pid ${lock.takenFromPid}, which is gone`);
    }

    let ep: ServiceEndpoint;
    try {
      ep = await this.deps.bindEndpoint(identity.secretKey, [PAIR_ALPN]);
    } catch (err) {
      const message = errorDetail(err);
      this.deps.log(`peering: could not bind the endpoint: ${message}`);
      this.lockHeld = false;
      await this.deps.releaseLock().catch(() => {});
      this.setStatus({ kind: "error", message });
      return;
    }
    if (this.shuttingDown) {
      // shutdown() waits for this bind and then closes `this.endpoint`.
      this.endpoint = ep;
      return;
    }
    this.endpoint = ep;
    this.deps.log(`peering: endpoint bound as ${shortPeerId(identity.id)}`);
    this.setStatus({ kind: "listening" });
    this.acceptLoopDone = this.acceptLoop(ep);
  }

  private async acceptLoop(ep: ServiceEndpoint): Promise<void> {
    for (;;) {
      let incoming: ServiceIncoming | null;
      try {
        incoming = await ep.acceptNext();
      } catch (err) {
        if (this.endpoint !== ep) return;
        // Without its accept loop the endpoint is useless: close it and give
        // the lock back, so the next dialog open binds afresh instead of
        // binding a second endpoint with the same key next to this one.
        // `binding` keeps a dialog open from starting that bind before the
        // close has finished.
        const message = `accept loop stopped: ${errorDetail(err)}`;
        this.deps.log(`peering: ${message}; closing the endpoint`);
        this.cancel();
        this.setStatus({ kind: "error", message });
        this.binding = this.closeEndpoint().finally(() => {
          this.binding = null;
        });
        return;
      }
      if (incoming === null) return; // the endpoint closed
      void this.handleIncoming(incoming);
    }
  }

  /** One incoming connection. Every error stays here, so the accept loop goes on. */
  private async handleIncoming(incoming: ServiceIncoming): Promise<void> {
    let conn: ServiceConnection;
    try {
      conn = await incoming.accept();
    } catch (err) {
      this.deps.log(`peering: incoming connection failed: ${errorDetail(err)}`);
      return;
    }
    try {
      const alpn = conn.alpn();
      if (alpn === PAIR_ALPN) {
        await respondToPairing(toPairConnection(conn), {
          ...this.sessionDeps(),
          admit: (session) => this.admit(session),
          generateCode: this.deps.generateCode,
          now: this.deps.now,
        });
        return;
      }
      this.deps.log(`peering: closed a connection on unknown ALPN ${JSON.stringify(alpn)}`);
      conn.close(PAIR_CLOSE.error, "unknown alpn");
    } catch (err) {
      this.deps.log(`peering: incoming connection failed: ${errorDetail(err)}`);
    }
  }

  /** B's admission rule: only while the dialog is open and no other pairing is pending. */
  private admit(session: PairResponder): PairRefusal | null {
    if (!this.dialogOpen || this.shuttingDown) return "not-accepting";
    if (this.active?.session.isPending()) return "busy";
    this.install(session);
    return null;
  }

  private install(session: PairSession): void {
    this.active = { id: ++this.nextSessionId, session };
    this.notify();
  }

  private async dial(peerId: string): Promise<PairConnection> {
    const ep = this.endpoint;
    if (ep === null) throw new Error("the endpoint is closed");
    return toPairConnection(await ep.connect(peerId, PAIR_ALPN));
  }

  private sessionDeps(): PairSessionDeps {
    return {
      readPeers: this.deps.readPeers,
      addPeer: async (peer) => {
        const stored = await this.deps.addPeer(peer);
        void this.refreshPeers();
        return stored;
      },
      log: this.deps.log,
      onChange: () => this.notify(),
      setTimer: this.deps.setTimer,
    };
  }
}
