/**
 * The trusted link's poller (docs/plans/iroh-peering.md, "Reconnection";
 * SPEC.md §20.4). It runs in `ib watch` while the endpoint is bound.
 *
 * - Every {@link PEER_POLL_INTERVAL_MS} it re-reads `peers.json` (so pairing
 *   and `ib peer remove` take effect on the next tick) and asks each listed
 *   peer for its agents (peer-link.ts `requestAgents`). It polls once at
 *   start, then on the timer.
 * - Each peer keeps one live connection between polls; a new dial happens
 *   only once that connection has closed.
 * - Periodic agents polls for a peer never overlap, including their dials. A dial can take
 *   up to 30 s to fail, so ticks that come while one is pending skip that
 *   peer. A failure is retried on the next tick.
 * - Once connected, the agents request has a {@link PEER_REQUEST_TIMEOUT_MS} deadline.
 *   Dialing has its own deadline. A peer can keep
 *   its QUIC connection alive and still never answer (its `ib watch` event
 *   loop wedged while the Rust side runs on), which would otherwise leave the
 *   peer skipped forever. On timeout the connection is closed, `lastError` is
 *   "request timed out", and the next tick redials. Closing the connection is
 *   what ends that agents poll. A coordinator-pane timeout affects only its own stream.
 * - The poller tracks per-peer state: connected or not, `lastOkAt`,
 *   `lastError`, and the last repo and agent lists received. The unified tree
 *   keeps disconnected agents dimmed and shows the peer’s link status in their info panel.
 * - {@link PeerPoller.onChange} fires when what a reader can see changes:
 *   connected, the error, the agent list, the name, or the set of peers. A
 *   successful poll that changes nothing but `lastOkAt` does not fire it.
 * - {@link PeerPoller.stop} cancels the timer and closes every connection;
 *   `ib watch` stops the poller before it closes the endpoint. A dial or
 *   request still in flight is ignored when it settles. `start` again
 *   resumes with the state kept.
 *
 * Every dependency is injected, so the tests drive it with a fake clock and a
 * fake transport.
 */

import {
  PEER_CLOSE,
  PeerErrorReply,
  PeerProtocolError,
  closeQuietly,
  cleanRemoteText,
  describePeerClose,
  requestAgents,
  requestCoordinatorPane,
  type CoordinatorPane,
  type RemoteAgent,
  type RemoteRepo,
  type PeerSnapshot,
} from "./peer-link";
import type { PairConnection } from "./pairing";
import { shortPeerId, type Peer } from "./store";
import { IrohError } from "./iroh";

export const PEER_POLL_INTERVAL_MS = 5_000;
/** Longest an `agents` request may take on a live connection before it is closed. */
export const PEER_REQUEST_TIMEOUT_MS = 15_000;

/** A request that got no reply within {@link PEER_REQUEST_TIMEOUT_MS}. */
class PeerRequestTimeout extends Error {
  constructor() {
    super("request timed out");
    this.name = "PeerRequestTimeout";
  }
}

/** One peer's link state, as the dashboard reads it. */
export interface PeerLinkState {
  id: string;
  /** The name from `peers.json`. */
  name: string;
  /** The last request succeeded and its connection is still open. */
  connected: boolean;
  /** When the last request succeeded (epoch ms), or null if none has. */
  lastOkAt: number | null;
  /** Why the last dial or request failed, or the connection closed; null once a request succeeds. */
  lastError: string | null;
  /** The last agent list received, kept after the peer drops; null until one arrives. */
  coordinator: PeerSnapshot["coordinator"];
  repos: readonly RemoteRepo[] | null;
  agents: readonly RemoteAgent[] | null;
}

export type PeerLinkStatus = "connected" | "connecting" | "offline";

/** A new peer is connecting until its first outcome. Retrying keeps the previous outcome. */
export function peerLinkStatus(link: PeerLinkState | undefined): PeerLinkStatus {
  if (!link) return "connecting";
  if (link.connected) return "connected";
  return link.lastError === null && link.lastOkAt === null ? "connecting" : "offline";
}

export interface PeerPollerDeps {
  /** Re-read `peers.json`. */
  readPeers(): Promise<Peer[]>;
  /** Dial `id` on the trusted ALPN. */
  dial(id: string): Promise<PairConnection>;
  /** Epoch ms. */
  now(): number;
  /** Schedule `fn` after `ms`; returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
  /** watch.log in `ib watch`. */
  log(line: string): void;
}

interface Link {
  id: string;
  name: string;
  conn: PairConnection | null;
  connected: boolean;
  lastOkAt: number | null;
  lastError: string | null;
  coordinator: PeerSnapshot["coordinator"];
  repos: readonly RemoteRepo[] | null;
  agents: readonly RemoteAgent[] | null;
  /** The complete snapshot as JSON, to tell a changed list from the same one. */
  snapshotKey: string | null;
}

/** A failed dial or request, as one short line. */
function describeFailure(err: unknown, conn: PairConnection | null): string {
  // Checked first: the timeout closes the connection itself, so closeInfo is set.
  if (err instanceof PeerRequestTimeout) return err.message;
  const info = conn?.closeInfo() ?? null;
  if (info !== null) return describePeerClose(info);
  if (err instanceof PeerErrorReply || err instanceof PeerProtocolError) return err.message;
  if (err instanceof IrohError) return cleanRemoteText(err.detail) || "unknown error";
  return cleanRemoteText(err instanceof Error ? err.message : String(err)) || "unknown error";
}

export class PeerPoller {
  private links = new Map<string, Link>();
  /**
   * Peer ids with a dial or request in flight. Keyed by id rather than kept
   * on the link, so a peer removed and paired again while its old dial hangs
   * still never gets a second one.
   */
  private readonly inFlight = new Set<string>();
  /** Each peer has one live link. Its native pane read can outlast the wire deadline. */
  private readonly paneReads = new WeakMap<PairConnection, AbortSignal>();
  /** Bumped by every stop(): work started before a stop is ignored when it settles, even after a restart. */
  private generation = 0;
  private running = false;
  private readingPeers = false;
  private cancelTimer: (() => void) | null = null;
  private lastReadError: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: PeerPollerDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Subscribe to every visible change of {@link states}. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Each peer's state, in `peers.json` order. */
  states(): PeerLinkState[] {
    return [...this.links.values()].map((link) => ({
      id: link.id,
      name: link.name,
      connected: link.connected,
      lastOkAt: link.lastOkAt,
      lastError: link.lastError,
      coordinator: link.coordinator,
      repos: link.repos,
      agents: link.agents,
    }));
  }

  /** The already authenticated link for a human-initiated request. */
  connectedConnection(peerId: string): PairConnection | null {
    const link = this.links.get(peerId);
    return link?.connected && link.conn?.closeInfo() === null ? link.conn : null;
  }

  async fetchCoordinatorPane(peerId: string): Promise<CoordinatorPane> {
    const conn = this.connectedConnection(peerId);
    if (!conn) throw new Error("Machine is disconnected");
    const pending = this.paneReads.get(conn);
    if (pending) throw pending.reason ?? new Error("Previous coordinator pane read is still pending");
    const abort = new AbortController();
    this.paneReads.set(conn, abort.signal);
    const deadline = Promise.withResolvers<never>();
    const cancel = this.deps.setTimer(PEER_REQUEST_TIMEOUT_MS, () => {
      const error = new Error("Coordinator pane request timed out. Previous read is still pending.");
      abort.abort(error);
      deadline.reject(error);
    });
    // iroh 1.2.0's readToEnd holds the receive mutex needed by stop(). Release
    // the slot when the underlying exchange settles, even if the caller timed out.
    const read = requestCoordinatorPane(conn, abort.signal).finally(() => this.paneReads.delete(conn));
    try {
      return await Promise.race([read, deadline.promise]);
    } finally {
      cancel();
    }
  }

  /** Poll now, then every {@link PEER_POLL_INTERVAL_MS}. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
    void this.tick();
  }

  /** Cancel the timer and close every connection. The state is kept. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.cancelTimer?.();
    this.cancelTimer = null;
    for (const link of this.links.values()) {
      const conn = link.conn;
      link.conn = null;
      link.connected = false;
      if (conn !== null) closeQuietly(conn, PEER_CLOSE.done, "shutting down");
    }
    this.notify();
  }

  /** One round: re-read `peers.json`, then poll every peer that is not busy. The timer calls it. */
  async tick(): Promise<void> {
    if (!this.running || this.readingPeers) return;
    this.readingPeers = true;
    let peers: Peer[] | null = null;
    try {
      peers = await this.deps.readPeers();
      this.lastReadError = null;
    } catch (err) {
      // Keep polling the peers already known (the other side still checks
      // its own allowlist); log once per distinct error, not every tick.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.lastReadError) this.deps.log(`peer link: could not read peers.json: ${message}`);
      this.lastReadError = message;
    } finally {
      this.readingPeers = false;
    }
    if (!this.running) return;
    if (peers !== null) this.sync(peers);
    for (const link of this.links.values()) {
      if (!this.inFlight.has(link.id)) void this.poll(link);
    }
  }

  private schedule(): void {
    this.cancelTimer = this.deps.setTimer(PEER_POLL_INTERVAL_MS, () => {
      if (!this.running) return;
      this.schedule();
      void this.tick();
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Match the links to `peers`: drop removed ones (closing their connection), add new ones, follow renames. */
  private sync(peers: Peer[]): void {
    let changed = false;
    const next = new Map<string, Link>();
    for (const peer of peers) {
      const link = this.links.get(peer.id);
      if (link === undefined) {
        next.set(peer.id, {
          id: peer.id,
          name: peer.name,
          conn: null,
          connected: false,
          lastOkAt: null,
          lastError: null,
          coordinator: null,
          repos: null,
          agents: null,
          snapshotKey: null,
        });
        changed = true;
      } else {
        if (link.name !== peer.name) {
          link.name = peer.name;
          changed = true;
        }
        next.set(peer.id, link);
      }
    }
    for (const link of this.links.values()) {
      if (next.has(link.id)) continue;
      changed = true;
      const conn = link.conn;
      link.conn = null;
      if (conn !== null) {
        this.paneReads.delete(conn);
        closeQuietly(conn, PEER_CLOSE.done, "removed");
      }
      this.deps.log(`peer link: stopped polling ${link.name} (${shortPeerId(link.id)}): no longer in peers.json`);
    }
    const reordered = [...next.keys()].join() !== [...this.links.keys()].join();
    this.links = next;
    if (changed || reordered) this.notify();
  }

  /**
   * Work started in `generation` still counts: no stop() since, the poller
   * runs, and the peer is still listed as this same link.
   */
  private isCurrent(link: Link, generation: number): boolean {
    return this.running && generation === this.generation && this.links.get(link.id) === link;
  }

  /** One dial (if needed) and one request for `link`. Never throws. */
  private async poll(link: Link): Promise<void> {
    const generation = this.generation;
    this.inFlight.add(link.id);
    let conn: PairConnection | null = link.conn;
    try {
      if (conn === null || this.recordObservedClose(link, conn)) {
        conn = null;
        const dialed = await this.deps.dial(link.id);
        if (!this.isCurrent(link, generation)) {
          closeQuietly(dialed, PEER_CLOSE.done, "shutting down");
          return;
        }
        conn = dialed;
        link.conn = dialed;
        this.watchClose(link, dialed, generation);
      }
      const snapshot = await this.requestWithTimeout(link, conn);
      // A final reply can arrive alongside the close notification. Only a live link recovers.
      if (!this.isCurrent(link, generation) || link.conn !== conn || this.recordObservedClose(link, conn)) return;
      this.succeeded(link, snapshot);
    } catch (err) {
      if (!this.isCurrent(link, generation)) return;
      this.failed(link, describeFailure(err, conn));
    } finally {
      this.inFlight.delete(link.id);
    }
  }

  /**
   * {@link requestAgents} bounded by {@link PEER_REQUEST_TIMEOUT_MS}. On
   * timeout it detaches `conn` from `link` (so the close is not reported as the
   * other side's), closes it, which fails the pending request, and rejects
   * with {@link PeerRequestTimeout}.
   */
  private requestWithTimeout(link: Link, conn: PairConnection): Promise<PeerSnapshot> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = this.deps.setTimer(PEER_REQUEST_TIMEOUT_MS, () => {
        if (settled) return;
        settled = true;
        if (link.conn === conn) link.conn = null;
        closeQuietly(conn, PEER_CLOSE.done, "request timed out");
        reject(new PeerRequestTimeout());
      });
      requestAgents(conn).then(
        (snapshot) => {
          if (settled) return;
          settled = true;
          cancel();
          resolve(snapshot);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          cancel();
          reject(err);
        },
      );
    });
  }

  /** closeInfo() on the current connection may be available before its closed() notification. */
  private recordObservedClose(link: Link, conn: PairConnection): boolean {
    const info = conn.closeInfo();
    if (info === null) return false;
    this.failed(link, describePeerClose(info));
    link.conn = null;
    return true;
  }

  /** When `conn` closes while it is still `link`'s connection: mark the peer disconnected, so the next tick redials. */
  private watchClose(link: Link, conn: PairConnection, generation: number): void {
    const closed = (message: string) => {
      this.paneReads.delete(conn);
      if (link.conn !== conn) return; // replaced, or closed on purpose by this side
      link.conn = null;
      if (this.isCurrent(link, generation)) this.failed(link, message);
    };
    conn.closed().then(
      (info) => closed(describePeerClose(info)),
      () => closed("connection closed"),
    );
  }

  private succeeded(link: Link, snapshot: PeerSnapshot): void {
    link.lastOkAt = this.deps.now();
    const key = JSON.stringify(snapshot);
    const changed = !link.connected || link.lastError !== null || key !== link.snapshotKey;
    if (!link.connected) this.deps.log(`peer link: connected to ${link.name} (${shortPeerId(link.id)})`);
    link.connected = true;
    link.lastError = null;
    if (key !== link.snapshotKey) {
      link.coordinator = snapshot.coordinator;
      link.repos = snapshot.repos;
      link.agents = snapshot.agents;
      link.snapshotKey = key;
    }
    if (changed) this.notify();
  }

  private failed(link: Link, message: string): void {
    if (!link.connected && link.lastError === message) return;
    if (link.lastError !== message) this.deps.log(`peer link: ${link.name} (${shortPeerId(link.id)}): ${message}`);
    link.connected = false;
    link.lastError = message;
    this.notify();
  }
}
