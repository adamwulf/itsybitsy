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
 * - A peer never has two dials or requests in flight at once. A dial can take
 *   up to 30 s to fail, so ticks that come while one is pending skip that
 *   peer. A failure is retried on the next tick.
 * - Per-peer state lives only in memory: connected or not, `lastOkAt`,
 *   `lastError`, and the last agent list received, which is kept after the
 *   peer drops (Phase 4 shows it dimmed as "last seen"). Nothing is written to
 *   disk.
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
  type RemoteAgent,
} from "./peer-link";
import type { PairConnection } from "./pairing";
import { shortPeerId, type Peer } from "./store";
import { IrohError } from "./iroh";

export const PEER_POLL_INTERVAL_MS = 5_000;

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
  agents: readonly RemoteAgent[] | null;
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
  /** A dial or request is in flight. */
  busy: boolean;
  connected: boolean;
  lastOkAt: number | null;
  lastError: string | null;
  agents: readonly RemoteAgent[] | null;
  /** `agents` as JSON, to tell a changed list from the same one. */
  agentsKey: string | null;
}

/** A failed dial or request, as one short line. */
function describeFailure(err: unknown, conn: PairConnection | null): string {
  const info = conn?.closeInfo() ?? null;
  if (info !== null) return describePeerClose(info);
  if (err instanceof PeerErrorReply || err instanceof PeerProtocolError) return err.message;
  if (err instanceof IrohError) return cleanRemoteText(err.detail) || "unknown error";
  return cleanRemoteText(err instanceof Error ? err.message : String(err)) || "unknown error";
}

export class PeerPoller {
  private links = new Map<string, Link>();
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
      agents: link.agents,
    }));
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
      if (!link.busy) void this.poll(link);
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
          busy: false,
          connected: false,
          lastOkAt: null,
          lastError: null,
          agents: null,
          agentsKey: null,
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
      if (conn !== null) closeQuietly(conn, PEER_CLOSE.done, "removed");
      this.deps.log(`peer link: stopped polling ${link.name} (${shortPeerId(link.id)}): no longer in peers.json`);
    }
    const reordered = [...next.keys()].join() !== [...this.links.keys()].join();
    this.links = next;
    if (changed || reordered) this.notify();
  }

  /** This link is still polled: the poller runs and the peer is still listed. */
  private isCurrent(link: Link): boolean {
    return this.running && this.links.get(link.id) === link;
  }

  /** One dial (if needed) and one request for `link`. Never throws. */
  private async poll(link: Link): Promise<void> {
    link.busy = true;
    let conn: PairConnection | null = link.conn;
    try {
      if (conn === null || conn.closeInfo() !== null) {
        link.conn = null;
        conn = null;
        const dialed = await this.deps.dial(link.id);
        if (!this.isCurrent(link)) {
          closeQuietly(dialed, PEER_CLOSE.done, "shutting down");
          return;
        }
        conn = dialed;
        link.conn = dialed;
        this.watchClose(link, dialed);
      }
      const agents = await requestAgents(conn);
      if (!this.isCurrent(link)) return;
      this.succeeded(link, agents);
    } catch (err) {
      if (!this.isCurrent(link)) return;
      this.failed(link, describeFailure(err, conn));
    } finally {
      link.busy = false;
    }
  }

  /** When `conn` closes while it is still `link`'s connection: mark the peer disconnected, so the next tick redials. */
  private watchClose(link: Link, conn: PairConnection): void {
    conn.closed().then(
      (info) => {
        if (link.conn !== conn) return; // replaced, or closed on purpose by this side
        link.conn = null;
        if (this.isCurrent(link)) this.failed(link, describePeerClose(info));
      },
      () => {
        if (link.conn !== conn) return;
        link.conn = null;
        if (this.isCurrent(link)) this.failed(link, "connection closed");
      },
    );
  }

  private succeeded(link: Link, agents: RemoteAgent[]): void {
    link.lastOkAt = this.deps.now();
    const key = JSON.stringify(agents);
    const changed = !link.connected || link.lastError !== null || key !== link.agentsKey;
    if (!link.connected) this.deps.log(`peer link: connected to ${link.name} (${shortPeerId(link.id)})`);
    link.connected = true;
    link.lastError = null;
    if (key !== link.agentsKey) {
      link.agents = agents;
      link.agentsKey = key;
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
