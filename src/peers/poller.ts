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
 *   "no reply to the agents poll within 30 s", and the next tick redials. Closing the connection is
 *   what ends that agents poll. A coordinator-pane timeout affects only its own stream.
 * - Except during a transfer (SPEC.md §20.4 "Slow links"): while
 *   `transferProgressing` holds for the peer, an agents poll or pane read
 *   that times out leaves the connection open and keeps waiting for its late
 *   reply, still holding its slot (`inFlight`, `paneReads`), so nothing piles
 *   up behind it on the slow link. It holds while a transfer with the peer (a
 *   send or new-agent with files, or a watch-log copy; either direction,
 *   either connection) is running and has moved bytes within
 *   TRANSFER_PROGRESS_WINDOW_MS (60 s), or this machine's watch-log reply to
 *   the peer ended ok within that window. The link's state stays as it was
 *   (connected, the last lists, no error); a late agents reply is used as that
 *   poll's answer, and a late pane reply as the read's. Each kept timeout is
 *   one watch.log line. The exchange asks again every 30 s while it waits;
 *   the first time the rule no longer holds, it closes the connection as an
 *   unkept timeout would. A peer that moves transfer bytes is not wedged,
 *   and on a slow link closing the connection would kill the transfer itself.
 * - When a connected link fails, watch.log gets the shared disconnect line
 *   (peer-link.ts `disconnectLine`): the peer, `dialed`, how long it was up
 *   since `connectedAt`, and the reason. Failures while not connected are
 *   logged once per change of error.
 * - The poller tracks per-peer state: connected or not (and since when), `lastOkAt`,
 *   `lastError`, and the last repo and agent lists received. The unified tree
 *   keeps disconnected agents dimmed and shows the peer’s link status in their info panel.
 * - {@link PeerPoller.onChange} fires when what a reader can see changes:
 *   connected, the error, the agent list, the name, or the set of peers. A
 *   successful poll that changes nothing but `lastOkAt` does not fire it.
 * - {@link PeerPoller.reconnect} (the Peers tab's Enter) closes the peer's
 *   connection on purpose and polls it now. That close is not a failure: no
 *   disconnect line, no `lastError`. The link reads `reconnecting` (shown as
 *   `connecting`) until the outcome. It never starts a second dial: a pending
 *   request ends with the close and its poll redials as it settles, and a
 *   pending dial is the reconnect.
 * - {@link PeerPoller.update} follows a `peers.json` change this process made
 *   (the Peers tab's remove) at once, instead of on the next tick. A tick
 *   whose read started before it discards that read, which may hold the
 *   old list, and polls the links update() left.
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
  PeerErrorReply, PeerBusyReply,
  PeerProtocolError,
  closeQuietly,
  cleanRemoteText,
  describePeerClose,
  disconnectLine,
  PEER_REQUEST_TIMEOUT_MS,
  requestAgents,
  requestPane,
  type PeerPane,
  type PeerPaneTarget,
  type RemoteAgent,
  type RemoteQuestion,
  type RemoteRepo,
  type PeerSnapshot,
} from "./peer-link";
import type { PairConnection } from "./pairing";
import { shortPeerId, type Peer } from "./store";
import { IrohError } from "./iroh";
import { TRANSFER_PROGRESS_WINDOW_MS } from "./transfer-activity";

export const PEER_POLL_INTERVAL_MS = 5_000;
// The agents poll's deadline lives with the request in peer-link.ts.
export { PEER_REQUEST_TIMEOUT_MS };

/** An agents poll that got no reply within {@link PEER_REQUEST_TIMEOUT_MS}. */
class PeerRequestTimeout extends Error {
  constructor() {
    super(`no reply to the agents poll within ${PEER_REQUEST_TIMEOUT_MS / 1000} s`);
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
  /** When `connected` last became true (epoch ms); null while not connected. */
  connectedAt: number | null;
  /** When the last request succeeded (epoch ms), or null if none has. */
  lastOkAt: number | null;
  /** Why the last dial or request failed, or the connection closed; null once a request succeeds. */
  lastError: string | null;
  /** The last agent list received, kept after the peer drops; null until one arrives. */
  coordinator: PeerSnapshot["coordinator"];
  repos: readonly RemoteRepo[] | null;
  agents: readonly RemoteAgent[] | null;
  /** The pending questions of those agents, kept like them; null until a list arrives. */
  questions: readonly RemoteQuestion[] | null;
  /** True from a manual reconnect ({@link PeerPoller.reconnect}) until its outcome. */
  reconnecting?: boolean;
}

export type PeerLinkStatus = "connected" | "connecting" | "offline";

/** A new or reconnecting peer is connecting until its first outcome. Retrying keeps the previous outcome. */
export function peerLinkStatus(link: PeerLinkState | undefined): PeerLinkStatus {
  if (!link) return "connecting";
  if (link.connected) return "connected";
  if (link.reconnecting) return "connecting";
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
  /**
   * transfer-activity.ts `recentProgress`: a transfer with this peer is
   * running and moved bytes within TRANSFER_PROGRESS_WINDOW_MS (60 s), or
   * this machine's watch-log reply to it ended ok within that window. While
   * it is true, a timed-out agents poll or pane read keeps its connection.
   * Without it, every timeout closes it.
   */
  transferProgressing?(peerId: string): boolean;
}

interface Link {
  id: string;
  name: string;
  conn: PairConnection | null;
  connected: boolean;
  connectedAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  coordinator: PeerSnapshot["coordinator"];
  repos: readonly RemoteRepo[] | null;
  agents: readonly RemoteAgent[] | null;
  questions: readonly RemoteQuestion[] | null;
  /** The complete snapshot as JSON, to tell a changed list from the same one. */
  snapshotKey: string | null;
  /** A manual reconnect awaits its outcome. */
  reconnecting: boolean;
  /** A manual reconnect closed the connection of the poll in flight: that poll redials when it settles. */
  redial: boolean;
}

/** A failed dial or request, as one short line. */
function describeFailure(err: unknown, conn: PairConnection | null): string {
  // Preserve the request deadline diagnostic if its pending reply also forced a connection close.
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
   * Peer ids with a dial or request in flight, including a request kept
   * through a transfer that still waits for its late reply. Keyed by id
   * rather than kept on the link, so a peer removed and paired again while its
   * old dial hangs still never gets a second one.
   */
  private readonly inFlight = new Set<string>();
  /**
   * One pane read per live link. Its native read can outlast the wire deadline,
   * and a read kept through a transfer waits for its late reply: either way the
   * slot stays taken until the read settles.
   */
  private readonly paneReads = new WeakSet<PairConnection>();
  /** Bumped by every stop(): work started before a stop is ignored when it settles, even after a restart. */
  private generation = 0;
  private running = false;
  private readingPeers = false;
  private cancelTimer: (() => void) | null = null;
  private lastReadError: string | null = null;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;

  constructor(private readonly deps: PeerPollerDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Bumped by every {@link update}. A `peers.json` read that started before
   * the latest update() may predate that change, so its list is discarded.
   */
  get peersEpoch(): number {
    return this.epoch;
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
      connectedAt: link.connectedAt,
      lastOkAt: link.lastOkAt,
      lastError: link.lastError,
      coordinator: link.coordinator,
      repos: link.repos,
      agents: link.agents,
      questions: link.questions,
      reconnecting: link.reconnecting,
    }));
  }

  /**
   * A manual reconnect (SPEC.md §20.1, the Peers tab's Enter): close the
   * peer's connection, if any, and poll it now. The close is on purpose:
   * `link.conn` is cleared first, so watchClose ignores it, and the poll it
   * ends does not record it (`redial`). The link shows `connecting` until the
   * outcome. Never a second dial: a request in flight ends with the close and
   * its poll redials as it settles, and a dial in flight is the reconnect.
   * Returns false when the poller is stopped or does not poll this peer.
   */
  reconnect(peerId: string): boolean {
    const link = this.links.get(peerId);
    if (!this.running || link === undefined) return false;
    const conn = link.conn;
    const pending = this.inFlight.has(link.id);
    const what = conn !== null ? "closing the connection and dialing again" : pending ? "a dial is already in progress" : "dialing now";
    this.deps.log(`peer link: reconnecting to ${link.name} (${shortPeerId(link.id)}) on request: ${what}`);
    link.conn = null;
    link.connected = false;
    link.connectedAt = null;
    link.lastError = null;
    link.reconnecting = true;
    if (pending && conn !== null) link.redial = true;
    if (conn !== null) closeQuietly(conn, PEER_CLOSE.done, "reconnecting");
    if (!pending) void this.poll(link);
    this.notify();
    return true;
  }

  /** Follow a `peers.json` change this process made (the Peers tab's remove) now, not on the next tick. */
  update(peers: Peer[]): void {
    if (!this.running) return;
    this.epoch++;
    this.sync(peers);
  }

  /** The already authenticated link for a human-initiated request. */
  connectedConnection(peerId: string): PairConnection | null {
    const link = this.links.get(peerId);
    return link?.connected && link.conn?.closeInfo() === null ? link.conn : null;
  }

  async fetchPane(peerId: string, target: PeerPaneTarget, lines: number): Promise<PeerPane> {
    const conn = this.connectedConnection(peerId);
    if (!conn) throw new Error("Machine is disconnected");
    if (this.paneReads.has(conn)) throw new Error("Previous pane read is still pending");
    this.paneReads.add(conn);
    // A kept timeout keeps waiting inside requestPane, so the slot stays taken until the read settles.
    try { return await requestPane(conn, target, lines, this.deps.setTimer, this.keepOnTimeout(peerId, `${target.op} read`)); }
    finally { this.paneReads.delete(conn); }
  }

  /**
   * One request's `keepOpenOnTimeout`: true while `transferProgressing` is
   * for the peer (the keep rule, SPEC.md §20.4 "Slow links"). The exchange asks when the request's teardown misses
   * its grace and again each interval while the kept read waits; the first yes
   * writes the one watch.log line for this timeout.
   */
  private keepOnTimeout(peerId: string, what: string): () => boolean {
    let logged = false;
    return () => {
      const keep = this.deps.transferProgressing?.(peerId) ?? false;
      if (keep && !logged) {
        logged = true;
        const name = this.links.get(peerId)?.name ?? "peer";
        // What `transferProgressing` tests, so the line states that and no more.
        const window = `${TRANSFER_PROGRESS_WINDOW_MS / 1000} s`;
        this.deps.log(`peer link: ${name} (${shortPeerId(peerId)}): ${what} timed out within ${window} of a transfer with this peer moving bytes; keeping the connection`);
      }
      return keep;
    };
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
      link.connectedAt = null;
      link.reconnecting = false;
      link.redial = false;
      if (conn !== null) closeQuietly(conn, PEER_CLOSE.done, "shutting down");
    }
    this.notify();
  }

  /** One round: re-read `peers.json`, then poll every peer that is not busy. The timer calls it. */
  async tick(): Promise<void> {
    if (!this.running || this.readingPeers) return;
    this.readingPeers = true;
    const epoch = this.epoch;
    let peers: Peer[] | null = null;
    try {
      peers = await this.deps.readPeers();
      // Read before the Peers tab's removal landed (update): keep the links as update() left them.
      if (epoch !== this.epoch) peers = null;
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
          connectedAt: null,
          lastOkAt: null,
          lastError: null,
          coordinator: null,
          repos: null,
          agents: null,
          questions: null,
          snapshotKey: null,
          reconnecting: false,
          redial: false,
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
      // A kept timeout keeps waiting inside requestAgents, so `inFlight` holds until its late reply or a close.
      const snapshot = await requestAgents(conn, this.deps.setTimer, new PeerRequestTimeout(), this.keepOnTimeout(link.id, "agents poll"));
      // A final reply can arrive alongside the close notification. Only a live link recovers.
      if (!this.isCurrent(link, generation) || link.conn !== conn || this.recordObservedClose(link, conn)) return;
      this.succeeded(link, snapshot);
    } catch (err) {
      if (!this.isCurrent(link, generation)) return;
      // A manual reconnect closed this poll's connection: the redial below reports the outcome.
      if (link.redial) return;
      if (err instanceof PeerBusyReply && link.conn === conn && conn && !this.recordObservedClose(link, conn)) {
        // A busy first reply connects the link as a list would: its `connected to` line, and `connectedAt` for the disconnect line.
        this.markConnected(link, this.deps.now());
        if (link.lastError !== err.message) { link.lastError = err.message; this.notify(); }
      } else this.failed(link, describeFailure(err, conn));
    } finally {
      this.inFlight.delete(link.id);
      if (link.redial) {
        link.redial = false;
        if (this.isCurrent(link, generation)) void this.poll(link);
      }
    }
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
    this.markConnected(link, link.lastOkAt);
    link.lastError = null;
    if (key !== link.snapshotKey) {
      link.coordinator = snapshot.coordinator;
      link.repos = snapshot.repos;
      link.agents = snapshot.agents;
      link.questions = snapshot.questions;
      link.snapshotKey = key;
    }
    if (changed) this.notify();
  }

  /** A link not yet connected becomes so at `at`: the `connected to` line, and the time its disconnect line counts from. */
  private markConnected(link: Link, at: number): void {
    link.reconnecting = false;
    if (link.connected) return;
    this.deps.log(`peer link: connected to ${link.name} (${shortPeerId(link.id)})`);
    link.connected = true;
    link.connectedAt = at;
  }

  /**
   * A dial or request failed, or the connection closed. A link that was up
   * gets the shared disconnect line (SPEC §20.4); otherwise one line per
   * change of error.
   */
  private failed(link: Link, message: string): void {
    // A reconnect cleared `lastError`, so its failure is always logged and shown.
    link.reconnecting = false;
    if (link.connected && link.connectedAt !== null) {
      this.deps.log(disconnectLine(link.name, link.id, "dialed", this.deps.now() - link.connectedAt, message));
    } else if (link.lastError !== message) {
      this.deps.log(`peer link: ${link.name} (${shortPeerId(link.id)}): ${message}`);
    } else if (!link.connected) return;
    link.connected = false;
    link.connectedAt = null;
    link.lastError = message;
    this.notify();
  }
}
