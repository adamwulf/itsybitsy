import { waitForIO } from "./send-frame";
import { peerTerminalSocket, transferStagingRoot } from "../runtime-names";
import type { TerminalHostDeps } from "./terminal-host";
import { startTerminalRelay, type TerminalRelay } from "./terminal-relay";
import { finishRecovery, sweepDiffCopies, sweepOutgoingDirectories } from "./transfer-owner";
/**
 * The iroh endpoint inside `ib watch` (docs/plans/iroh-peering.md, "Process
 * model" and "Reconnection"; SPEC.md §20.3), the one pairing session it runs
 * at a time, and the trusted link's poller.
 *
 * - The endpoint binds at boot when `peers.json` lists at least one peer
 *   (`bootIfPaired`, which `ib watch` starts in the background once the
 *   watcher's first scan is done), or when the Peers tab opens
 *   (`openDialog`) with nothing bound yet, and again through the automatic
 *   rebind after a failure (below); one bind runs at a time, and a bound
 *   endpoint is never bound again. An install with no peers that never
 *   opens the dialog never loads the addon or touches the network. Before
 *   binding it takes the endpoint lock; when another live `ib watch` holds it,
 *   it does not bind and reports "peering disabled: ib watch pid N owns the
 *   endpoint". A disabled watcher retries the lock every 30 s and whenever
 *   the Peers dialog opens.
 * - After a failure (a bind that fails, or the accept loop failing once its
 *   endpoint is closed), the service rebinds on its own through the same
 *   path, after 5 s, then 10, 20, 40 and 60 s, staying at 60 s; a rebind
 *   whose endpoint stays up for 60 s resets that, while one whose accept
 *   loop dies sooner is one more failure, so a flapping endpoint backs off
 *   too. It retries only while something needs the endpoint:
 *   `peers.json` lists a peer, or the Peers tab is open. A live lock holder switches the watcher to the 30 s
 *   lock poll. Shutdown stops both retry paths. Opening the dialog while a retry is pending
 *   binds at once, in place of the retry. `binding` is held from the start of
 *   a bind (or of a failed endpoint's close) until its retry is armed, so two
 *   binds never run and each failure leaves at most one endpoint and one lock.
 *   Each failure is one watch.log line with its wait; at the 60 s cap a
 *   repeat of the same failure is not logged again. When that failure is an
 *   accept-loop failure, each rebind's bound, closing and closed lines are
 *   not logged either, including the bind that ends up staying up; its
 *   recovery is logged when the 60 s stability check fires. A bind after a
 *   bind-stage failure (identity, lock, bind) is always logged.
 * - Binding is async, but the first addon load is NOT off the event loop:
 *   iroh.ts's dynamic import of the package evaluates the napi module
 *   synchronously, so the first bind stalls the UI once, for about a third of
 *   a second (230-400 ms compiled). For a paired install that happens at boot,
 *   just after the first agent tree has drawn; otherwise on the first dialog open, after
 *   the dialog has drawn "starting…". The module stays loaded, so a later
 *   rebind does not stall.
 * - The endpoint accepts two ALPNs: pair (pairing.ts) and peer (peer-link.ts,
 *   the trusted link). Once bound, the poller (poller.ts) runs and asks each
 *   peer in `peers.json` for its agents every 5 s; the trusted ALPN answers
 *   from the injected `agents()` snapshot (the watcher's last fully detected
 *   agents).
 * - While bound, it also listens on the `ib peer attach` socket
 *   (terminal-relay.ts), which relays remote terminals over the poller's
 *   connections; closing the endpoint closes the socket first.
 * - Once bound, the endpoint stays up until `ib watch` exits (`shutdown()`)
 *   or until the accept loop fails. Either way the poller stops, then the
 *   endpoint is closed (which resolves a pending `acceptNext`, which otherwise
 *   keeps Bun alive) and the lock is released; after an accept-loop failure,
 *   the retry above binds again.
 * - The accept loop hands each connection to its own task and catches errors
 *   per connection: one failed handshake or bad peer never stops it. It
 *   dispatches by ALPN and closes any other. If `acceptNext` itself fails, the
 *   endpoint is closed and the lock released before the retry is armed, so the
 *   rebind starts afresh instead of next to the old endpoint.
 * - Everything is logged through the injected `log` (watch.log in `ib watch`),
 *   never to stderr, which would corrupt the TUI.
 *
 * The id and the paired peers come from identity.ts and store.ts, so the
 * dialog shows them even when peering is disabled or the addon fails.
 */

import { createPeerOutboxPoll, type pollPeerOutbox } from "./peer-outbox";
import type { AttachmentEntry, SendHeader } from "./send-frame";
import { cleanRemoteText, requestAcknowledge, requestLifecycle, requestSend } from "./peer-link";
import { createMessageReceiver, targetLabel } from "./receive-message";
import { createAttachmentReceiver, totalBytes } from "./receive-attachments";
import { remoteLifecycleDenial, remoteSendDenial, remoteStartDenialAtStartup, remoteTerminalDenial } from "./remote-start-caller";
import { acquireEndpointLock, releaseEndpointLock, renewEndpointLease, type EndpointLockResult } from "./endpoint-lock";
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
import { acceptRemoteAgent, acceptRemoteAgentWithFiles, type RemoteSpawnDeps } from "./new-agent";
import { acceptRemoteLifecycle, type RemoteLifecycleRequest, type RemoteLifecycleDeps } from "./remote-lifecycle";
import { acceptRemoteAcknowledge, type RemoteQuestionDeps } from "./remote-questions";
import { detectAgentStates } from "../agents";
import { acknowledgeQuestion, newAgent, mergeAgent, mergeCheckAgent, retireAgent, rehireAgent, resumeAgent } from "../ib-commands";
import { listSpawnableTypeNamesSync } from "../agent-types";
import { listRepos } from "../registry";
import { PEER_ALPN, requestAgentDiff, requestAgentPrompt, requestNewAgent, serveTrustedConnection, type PeerPane, type PeerPaneTarget, type PeerResponderDeps, type PeerSnapshot, type RemoteNewAgentRequest } from "./peer-link";
import { captureMarkedCoordinatorPane } from "../tmux-poller";
import { classifyCoordinatorState, IB_COORDINATOR_SESSION } from "../coordinator";
import { stripAnsi } from "../parse-state";
import { writeRemoteAgents } from "./remote-agents";
import { PeerPoller, type PeerLinkState } from "./poller";
import { addPeer, normalizePeerId, readPeers, shortPeerId, type Peer } from "./store";

// ---------------------------------------------------------------------------
// What the service needs from a bound endpoint. The wrapper's IrohEndpoint,
// IrohIncoming, IrohConnection and IrohBiStream satisfy these structurally;
// the tests use fakes.
// ---------------------------------------------------------------------------

export interface ServiceStream {
  write(bytes: Uint8Array): Promise<number>;
  resetSending(): Promise<void>;
  stopReceiving(): Promise<void>;
  read(limit: number): Promise<Uint8Array>;
  writeAll(bytes: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  readToEnd(limit: number): Promise<Uint8Array>;
  cancel(): Promise<void>;
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
  notice?(message: string): void;
  pollOutbox?: typeof pollPeerOutbox;
  recoverTransfers?(): Promise<void>;
  receiveMessage?: ReturnType<typeof createMessageReceiver>;
  captureCoordinator?: PeerResponderDeps["captureCoordinator"];
  captureAgent?: PeerResponderDeps["captureAgent"];
  captureDiff?: PeerResponderDeps["captureDiff"];
  readPrompt?: PeerResponderDeps["readPrompt"];
  remoteStartDenial: string | null | Promise<string | null>;
  remoteLifecycle?: RemoteLifecycleDeps;
  remoteQuestions?: RemoteQuestionDeps;
  remoteSpawn?: RemoteSpawnDeps;
  writeRemoteAgents?(states: PeerLinkState[], generation: string): void;
  renewLease?(): Promise<void>;
  acquireLock(): Promise<EndpointLockResult>;
  releaseLock(): Promise<unknown>;
  loadIdentity(): Promise<PeerIdentity>;
  /** Load the addon and bind an endpoint with this key, accepting these ALPNs. */
  bindEndpoint(secretKey: Uint8Array, alpns: string[]): Promise<ServiceEndpoint>;
  /** Hosting remote terminals on this install's agents (terminal-host.ts). Without it, opens are refused. */
  terminal?: TerminalHostDeps;
  /** Where `ib peer attach` reaches this endpoint (terminal-relay.ts); no socket without it. */
  terminalSocketPath?: string;
  readPeers(): Promise<Peer[]>;
  addPeer(peer: { id: string; name: string; pairedAt?: string }): Promise<Peer>;
  generateCode(): string;
  now(): number;
  setTimer(ms: number, fn: () => void): () => void;
  log(line: string): void;
  /**
   * The agents the trusted ALPN reports: in `ib watch`, the watcher's last
   * fully detected snapshot (`watcher.lastDetectedAgents`, never the
   * mid-refresh `lastAgents`), so an answer costs no extra IO.
   */
  snapshot(): PeerSnapshot;
}

/**
 * The real dependencies: the endpoint lock, ~/.itsybitsy/peer, the addon with
 * the n0 preset, and `agents` (the watcher's last fully detected agents in `ib watch`).
 */
export function defaultPeerServiceDeps(machine: string, log: (line: string) => void, snapshot: () => PeerSnapshot, notice: (message: string) => void, remoteStartDenial: PeerServiceDeps["remoteStartDenial"] = remoteStartDenialAtStartup(), recoveryRoot = transferStagingRoot()): PeerServiceDeps {
  const poll = createPeerOutboxPoll();
  // Sends and remote starts share the busy rule and the /tmp reservation.
  const attachments = createAttachmentReceiver();
  let diffCleanup: Promise<void> | undefined;
  return {
    notice,
    pollOutbox: poll,
    recoverTransfers: async () => {
      // Once on startup (or lock takeover). The attachment sweeps also run on a timer.
      diffCleanup ??= sweepDiffCopies(recoveryRoot).catch(err => { diffCleanup = undefined; throw err; });
      await finishRecovery([diffCleanup, sweepOutgoingDirectories(recoveryRoot), poll.recover()]);
    },
    receiveMessage: createMessageReceiver(log, notice, () => performance.now(), 4096, attachments),
    remoteStartDenial,
    captureCoordinator: async lines => {
      const text = await captureMarkedCoordinatorPane(IB_COORDINATOR_SESSION, machine, { log, lines });
      return text === null ? null : { text, state: classifyCoordinatorState(stripAnsi(text)) };
    },
    remoteLifecycle: { listRepos, mergeAgent, mergeCheckAgent, retireAgent, rehireAgent, resumeAgent, detectAgentStates, notice },
    remoteQuestions: { listRepos, acknowledgeQuestion, notice },
    remoteSpawn: { listRepos, listSpawnableTypes: listSpawnableTypeNamesSync, newAgent, notice, attachments },
    writeRemoteAgents,
    renewLease: renewEndpointLease,
    acquireLock: () => acquireEndpointLock(),
    releaseLock: () => releaseEndpointLock(),
    loadIdentity: loadOrCreateIdentity,
    bindEndpoint: async (secretKey, alpns) => (await loadIroh()).Endpoint.bind({ secretKey, alpns, preset: { kind: "n0" } }),
    terminalSocketPath: peerTerminalSocket(),
    readPeers,
    addPeer,
    generateCode: () => generatePairCode(),
    now: () => Date.now(),
    setTimer: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    log,
    snapshot,
  };
}

/** The first automatic rebind after a failure waits this long; each further failure doubles it. */
export const PEER_RETRY_INITIAL_MS = 5_000;
/** The longest wait between automatic rebinds. */
export const PEER_RETRY_MAX_MS = 60_000;
/** While the open Peers tab shows a pending retry, the service notifies this often, so its countdown moves. */
export const PEER_RETRY_COUNTDOWN_MS = 1_000;
/**
 * A rebind counts as recovered, and the backoff resets, only once its
 * endpoint has stayed up this long; an accept loop that dies sooner is one
 * more failure, so an endpoint that binds and then fails at once backs off
 * instead of rebinding every 5 s.
 */
export const PEER_RETRY_STABLE_MS = 60_000;

/** The wait before the automatic rebind after `failures` failures in the current run (1 or more): 5, 10, 20, 40, then 60 s. */
export function peerRetryDelayMs(failures: number): number {
  const doublings = Math.min(Math.max(failures - 1, 0), 16);
  return Math.min(PEER_RETRY_MAX_MS, PEER_RETRY_INITIAL_MS * 2 ** doublings);
}

/** How an accept-loop failure's message starts (the status message and its watch.log lines). */
const ACCEPT_LOOP_STOPPED = "accept loop stopped: ";

/** How one bind ended. A failure carries its watch.log text, logged once with the retry it arms. */
type BindOutcome =
  | { kind: "bound" }
  | { kind: "disabled" }
  | { kind: "failed"; failure: string }
  | { kind: "shutting-down" };

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
  /**
   * The last bind, or the accept loop, failed. `retryAt` (on the injected
   * clock) is when the automatic rebind runs, or null when none is pending.
   */
  | { kind: "error"; message: string; retryAt: number | null };

export interface PeerSessionView {
  /** Increases with every new session, so the dialog can reset its inputs. */
  id: number;
  role: PairRole;
  /** The other install's id. */
  peerId: string;
  stage: PairStage;
}

export interface IncomingTransfer { id: string; label: string; bytes: number; total: number }

export interface PeerServiceView {
  incoming?: IncomingTransfer[];
  status: EndpointStatus;
  /** This install's id, once loaded. */
  selfId: string | null;
  identityError: string | null;
  peers: Peer[];
  peersError: string | null;
  session: PeerSessionView | null;
  /**
   * Each polled peer's link state (poller.ts), in `peers.json` order. Empty
   * until the endpoint has bound; kept, disconnected, after it stops.
   */
  links: readonly PeerLinkState[];
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `1 failure`, `2 failures`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Adapt a wrapper connection to the pair protocol's seam. */
export function toPairConnection(conn: ServiceConnection): PairConnection {
  const stream = (s: ServiceStream): PairStream => ({
    read: (limit) => s.read(limit),
    write: bytes => s.write(bytes),
    resetSending: () => s.resetSending(),
    stopReceiving: () => s.stopReceiving(),
    writeAll: (bytes) => s.writeAll(bytes),
    finish: () => s.finish(),
    cancel: () => s.cancel(),
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
  /**
   * A bind, or a failed endpoint's close, that is still running (with the
   * retry it arms); no other bind starts until it settles.
   */
  private binding: Promise<void> | null = null;
  /**
   * Failures in the current run, which sets the retry's wait: counted since
   * resetRetries last ran, on a recovery (armStableTimer, once a bind has
   * stayed up PEER_RETRY_STABLE_MS) or a give-up (stopRetrying, or
   * retryLater when nothing needs the endpoint). A bind does not reset it,
   * so it stays above 0 while listening during that stability window, until
   * the stable check fires.
   */
  private failures = 0;
  /** The failure last logged at the 60 s cap; the same one again is not logged (logFailure). */
  private quietFailure: string | null = null;
  /** Cancels the pending automatic rebind; null when none is pending. */
  private cancelRetryTimer: (() => void) | null = null;
  /** Cancels the open dialog's countdown tick; null when none is armed. */
  private cancelCountdown: (() => void) | null = null;
  /** Cancels the check that a rebind has stayed up for PEER_RETRY_STABLE_MS; null when none is armed. */
  private cancelStableTimer: (() => void) | null = null;
  private lockHeld = false;
  private lockGeneration?: string;
  private recovery?: Promise<void>;
  private recoverTransfers(): Promise<void> {
    if (!this.lockHeld || this.shuttingDown || !this.deps.recoverTransfers) return Promise.resolve();
    return this.recovery ??= this.deps.recoverTransfers().catch(err => this.deps.log(`transfer cleanup: ${errorDetail(err)}`))
      .finally(() => { this.recovery = undefined; });
  }
  private shuttingDown = false;
  private dialogOpen = false;
  private selfId: string | null = null;
  private identityError: string | null = null;
  private peers: Peer[] = [];
  private peersError: string | null = null;
  private active: { id: number; session: PairSession } | null = null;
  private nextSessionId = 0;
  private readonly listeners = new Set<() => void>();
  /** Polls each peer's agents while the endpoint is bound. */
  private readonly poller: PeerPoller;
  private readonly outboxPolls = new Set<Promise<void>>();
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private outboxOwner?: AbortController;
  private outboxTimer?: ReturnType<typeof setInterval>;
  private readonly receipts = new Map<string, { row?: IncomingTransfer; controller: AbortController; done: Promise<void> }>();
  cancelReceipt(id: string) {
    const receipt = this.receipts.get(id);
    if (receipt?.row) receipt.controller.abort(new Error("Receive cancelled"));
  }

  private readonly headerReaders = new Set<import("./pairing").PairStream>();
  /** The `ib peer attach` socket, from a successful bind until closeEndpoint. */
  private terminalRelay: Promise<TerminalRelay | null> | null = null;
  private readonly paneReaders = new Set<string>();
  /** The accept loop's promise, for tests. */
  acceptLoopDone: Promise<void> = Promise.resolve();

  private callerDenial: string | null = "checking whether remote starts are allowed";

  get remoteStartDenial(): string | null {
    return this.callerDenial;
  }

  constructor(private readonly deps: PeerServiceDeps) {
    const decision = deps.remoteStartDenial;
    if (decision === null || typeof decision === "string") {
      this.callerDenial = decision;
    } else {
      void decision.catch(() => "Cannot verify the dashboard caller for remote starts").then(denial => {
        this.callerDenial = denial;
        this.notify();
      });
    }
    this.poller = new PeerPoller({
      readPeers: async () => {
        await deps.renewLease?.();
        this.peers = await deps.readPeers();
        return this.peers;
      },
      dial: (id) => this.dialPeer(id),
      now: deps.now,
      setTimer: deps.setTimer,
      log: deps.log,
    });
    this.poller.onChange(() => {
      this.publishRemoteAgents();
      this.notify();
    });
  }

  private publishRemoteAgents(): void {
    try {
      if (this.lockHeld && this.lockGeneration) this.deps.writeRemoteAgents?.(this.poller.states(), this.lockGeneration);
    } catch (err) {
      this.deps.log(`peering: could not write remote-agents.json: ${errorDetail(err)}`);
    }
  }

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
      links: this.poller.states(),
      ...(this.receipts.size && { incoming: Array.from(this.receipts.values()).flatMap(entry => entry.row ? [{ ...entry.row }] : []) }),
    };
  }

  /**
   * `ib watch` boot: bind when `peers.json` lists at least one peer. With no
   * peers nothing is loaded or bound. When another live `ib watch` holds the
   * endpoint lock, the status says so and nothing binds, as for the dialog.
   * Never throws.
   */
  async bootIfPaired(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.deps.recoverTransfers && !this.recoveryTimer) {
      this.recoveryTimer = setInterval(() => {
        if (this.endpoint) void this.recoverTransfers();
        else if (!this.cancelRetryTimer) void this.bootIfPaired();
      }, 30_000);
    }
    if (this.endpoint) { await this.recoverTransfers(); return; }
    if (!this.deps.recoverTransfers && (!await this.readPeersAtBoot() || !this.peers.length)) return;
    this.startBind(false, !!this.deps.recoverTransfers);
    if (this.binding !== null) await this.binding;
  }

  private async readPeersAtBoot() {
    await this.refreshPeers();
    if (this.peersError) {
      this.deps.log(`peering: not binding at boot: ${this.peersError}`);
      return false;
    }
    if (this.peers.length) this.deps.log(`peering: binding at boot for ${this.peers.length} paired peer${this.peers.length === 1 ? "" : "s"}`);
    return true;
  }

  /**
   * The Peers tab opened: accept pairing requests, and bind if not bound
   * yet. A pending retry is replaced by this bind, which starts at once.
   */
  openDialog(): void {
    this.dialogOpen = true;
    void this.refreshPeers();
    this.startBind();
    this.notify();
  }

  /**
   * Start a bind unless one runs (or a failed endpoint is still closing), the
   * endpoint is up, or `ib watch` is exiting. It cancels a pending retry,
   * which it replaces. `retry` marks the retry timer's bind, which first
   * checks that something still needs the endpoint.
   */
  private startBind(retry = false, readPeersAtBoot = false): void {
    const kind = this.status.kind;
    if (this.shuttingDown || this.binding !== null || kind === "starting" || kind === "listening") return;
    this.cancelRetry();
    this.track(this.bindOrStop(retry, readPeersAtBoot));
  }

  /** Hold `binding` until `work` settles, so no bind starts meanwhile. */
  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work.finally(() => {
      if (this.binding === tracked) this.binding = null;
    });
    this.binding = tracked;
  }

  /**
   * One bind, through the lock as at boot and on dialog open, then what its
   * outcome asks for: a retry after a failure, none when another `ib watch`
   * owns the endpoint. The retry timer's bind first re-reads `peers.json`.
   */
  private async bindOrStop(retry: boolean, readPeersAtBoot: boolean): Promise<void> {
    if (retry) {
      const notNeeded = await this.whyNotNeeded();
      if (this.shuttingDown) return;
      if (notNeeded !== null) {
        this.stopRetrying(notNeeded);
        return;
      }
    }
    const outcome = await this.bind(readPeersAtBoot);
    if (outcome.kind === "failed") this.retryLater(outcome.failure);
    else if (outcome.kind === "disabled" && this.failures > 0) this.stopRetrying("another ib watch owns the endpoint");
  }

  /**
   * Why nothing needs the endpoint, or null when something does: the Peers
   * dialog is open, or `peers.json` (re-read) lists a peer. A `peers.json`
   * that cannot be read is no reason to bind, as at boot.
   */
  private async whyNotNeeded(): Promise<string | null> {
    if (this.dialogOpen) return null;
    let readError: string | null = null;
    try {
      this.peers = await this.deps.readPeers();
      this.peersError = null;
    } catch (err) {
      readError = errorDetail(err);
      this.peersError = readError;
    }
    this.notify();
    if (this.dialogOpen) return null;
    if (readError !== null) return `could not read peers.json: ${readError}`;
    return this.peers.length === 0 ? "no paired peers and the Peers tab is hidden" : null;
  }

  /**
   * After a failure (a failed bind, or a failed accept loop once its endpoint
   * is closed): count it and arm the automatic rebind, unless `ib watch` is
   * exiting or nothing needs the endpoint (no peers known, the dialog closed;
   * the retry re-reads `peers.json` before it binds). `failure` is logged
   * here, once, with what happens next.
   */
  private retryLater(failure: string): void {
    if (this.shuttingDown) {
      this.deps.log(`peering: ${failure}`);
      return;
    }
    this.failures++;
    if (!this.dialogOpen && this.peers.length === 0) {
      this.deps.log(`peering: ${failure}; not retrying: no paired peers and the Peers tab is hidden`);
      this.resetRetries();
      return;
    }
    const delay = peerRetryDelayMs(this.failures);
    const retryAt = this.deps.now() + delay;
    this.cancelRetryTimer = this.deps.setTimer(delay, () => {
      this.cancelRetryTimer = null;
      // Clears the countdown and `retryAt` even if startBind finds a bind
      // already running (that bind arms its own retry if it fails).
      this.cancelRetry();
      this.startBind(true);
    });
    this.logFailure(failure, delay);
    if (this.status.kind === "error") this.setStatus({ ...this.status, retryAt });
    this.armCountdown();
  }

  /**
   * One watch.log line per failure, with the wait before the retry. At the
   * 60 s cap a failure identical to the last one logged there is not logged
   * again, so a permanent failure does not fill watch.log; a different one
   * is, and `recovered after N failures` gives the count. While an
   * accept-loop failure repeats like that, the other lines of each rebind
   * that repeats it (bound, closing, closed) are not logged either
   * ({@link quietFailureRepeats}, {@link quietBindCycle}).
   */
  private logFailure(failure: string, delay: number): void {
    if (delay < PEER_RETRY_MAX_MS) {
      this.deps.log(`peering: ${failure}; retrying in ${delay / 1000} s`);
      return;
    }
    if (failure === this.quietFailure) return;
    this.quietFailure = failure;
    this.deps.log(`peering: ${failure}; retrying every ${PEER_RETRY_MAX_MS / 1000} s, not logging this error again until it changes`);
  }

  /** Give up retrying until the next bind: log why, and start the next run of failures at 5 s. */
  private stopRetrying(why: string): void {
    this.deps.log(`peering: not retrying the bind: ${why}`);
    this.resetRetries();
  }

  /** `failure` repeats the failure no longer logged at the 60 s cap. */
  private quietFailureRepeats(failure: string): boolean {
    return this.quietFailure !== null && failure === this.quietFailure;
  }

  /**
   * The failure repeating unlogged at the cap is an accept-loop failure, so
   * each cycle binds before it fails again: such a bind is part of the
   * repeat and is not logged. A bind after a bind-stage failure (identity,
   * lock, bind) is a change, and is logged.
   */
  private quietBindCycle(): boolean {
    return this.quietFailure !== null && this.quietFailure.startsWith(ACCEPT_LOOP_STOPPED);
  }

  /**
   * After a bind that follows failures: once that endpoint has stayed up for
   * PEER_RETRY_STABLE_MS, log the recovery and reset the backoff. Closing the
   * endpoint sooner cancels it, so that failure continues the run.
   */
  private armStableTimer(ep: ServiceEndpoint): void {
    this.cancelStable();
    this.cancelStableTimer = this.deps.setTimer(PEER_RETRY_STABLE_MS, () => {
      this.cancelStableTimer = null;
      if (this.endpoint !== ep || this.shuttingDown) return;
      this.deps.log(
        `peering: recovered after ${plural(this.failures, "failure")}: the endpoint has stayed up for ${PEER_RETRY_STABLE_MS / 1000} s`,
      );
      this.resetRetries();
    });
  }

  private cancelStable(): void {
    this.cancelStableTimer?.();
    this.cancelStableTimer = null;
  }

  /** A new run of failures starts at 5 s, and logs its first failure at the cap again. */
  private resetRetries(): void {
    this.failures = 0;
    this.quietFailure = null;
  }

  /** Cancel the pending retry (and the dialog's countdown); the error stays shown. */
  private cancelRetry(): void {
    this.cancelRetryTimer?.();
    this.cancelRetryTimer = null;
    this.cancelCountdown?.();
    this.cancelCountdown = null;
    if (this.status.kind === "error" && this.status.retryAt !== null) this.setStatus({ ...this.status, retryAt: null });
  }

  /**
   * While the dialog is open and a retry is pending, notify every second, so
   * the dialog's "retrying in N s" counts down.
   */
  private armCountdown(): void {
    if (this.cancelCountdown !== null || !this.dialogOpen || this.cancelRetryTimer === null) return;
    this.cancelCountdown = this.deps.setTimer(PEER_RETRY_COUNTDOWN_MS, () => {
      this.cancelCountdown = null;
      if (this.cancelRetryTimer === null) return;
      this.notify();
      this.armCountdown();
    });
  }

  /**
   * The Peers tab closed: stop accepting, and cancel a pairing still in
   * progress. A pending retry stays; when it fires it binds only if
   * `peers.json` lists a peer.
   */
  closeDialog(): void {
    this.dialogOpen = false;
    this.cancelCountdown?.();
    this.cancelCountdown = null;
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

  async fetchPane(peerId: string, target: PeerPaneTarget, lines: number): Promise<PeerPane> {
    if (this.remoteStartDenial !== null) throw new Error(this.remoteStartDenial);
    if (await this.peerName(peerId) === null) throw new Error("Machine is no longer paired");
    return this.poller.fetchPane(peerId, target, lines);
  }

  async fetchAgentDiff(peerId: string, repo: string, id: string) {
    if (this.remoteStartDenial !== null) throw new Error(this.remoteStartDenial);
    if (await this.peerName(peerId) === null) throw new Error("Machine is no longer paired");
    const conn = this.poller.connectedConnection(peerId);
    if (!conn) throw new Error("Machine is disconnected");
    return requestAgentDiff(conn, repo, id, this.deps.setTimer);
  }

  async fetchAgentPrompt(peerId: string, repo: string, id: string): Promise<string> {
    if (this.remoteStartDenial !== null) throw new Error(this.remoteStartDenial);
    if (await this.peerName(peerId) === null) throw new Error("Machine is no longer paired");
    const conn = this.poller.connectedConnection(peerId);
    if (!conn) throw new Error("Machine is disconnected");
    return requestAgentPrompt(conn, repo, id, this.deps.setTimer);
  }

  async receiveTracked(...args: Parameters<NonNullable<import("./peer-link").PeerResponderDeps["receiveMessage"]>>) {
    const [header, peer, name, body, options] = args;
    const receive = this.deps.receiveMessage!;
    await this.trackReceipt(peer, targetLabel(header.target), header.files, options ?? {}, tracked => receive(header, peer, name, body, tracked));
  }

  /** An inbound receipt (a send or a framed remote start): its row while it owns a body, Esc until commit, and shutdown. */
  private async trackReceipt<O extends import("./peer-link").ReceiptOptions, T>(peer: string, target: string, files: readonly AttachmentEntry[], options: O, receive: (options: O) => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new Error("Watcher shutting down");
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const label = this.peers.find(p => p.id === peer)?.name ?? shortPeerId(peer);
    const row = { id, label: cleanRemoteText(label + " → " + target), bytes: 0, total: totalBytes(files) };
    const done = Promise.withResolvers<void>();
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await receive({ ...options, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, admitted: ownsBody => {
        if (this.shuttingDown) throw new Error("Watcher shutting down");
        this.receipts.set(id, { row: ownsBody ? row : undefined, controller, done: done.promise });
        if (ownsBody) {
          if (options.cancelStream) controller.signal.addEventListener("abort", options.cancelStream, { once: true });
          this.notify();
        }
        options.admitted?.(ownsBody);
      }, committing: () => {
        const receipt = this.receipts.get(id);
        if (receipt?.row) { receipt.row = undefined; this.notify(); }
        options.committing?.();
      }, onProgress: bytes => {
        row.bytes = bytes;
        progressTimer ??= setTimeout(() => {
          progressTimer = undefined;
          this.notify();
        }, 100);
      } });
    } finally {
      clearTimeout(progressTimer);
      const visible = this.receipts.get(id)?.row;
      this.receipts.delete(id);
      if (visible) this.notify();
      done.resolve();
    }
  }

  async sendRemoteMessage(peerId: string, header: SendHeader, source: "dashboard" | "handoff" = "dashboard", transfer?: import("./peer-link").OutgoingTransfer): Promise<string> {
    if (source === "dashboard") {
      if (this.remoteStartDenial !== null) throw new Error(remoteSendDenial(this.remoteStartDenial));
      if (header.from.kind !== "user") throw new Error("Dashboard sends require a user sender");
    }
    const peer = await waitForIO({ setTimer: this.deps.setTimer, signal: transfer?.signal }, () => this.peerName(peerId));
    if (peer === null) throw new Error("Machine is no longer paired");
    const conn = this.poller.connectedConnection(peerId);
    if (!conn) throw new Error("Machine is disconnected");
    const id = await requestSend(conn, header, this.deps.setTimer, transfer);
    const line = `Sent a message to ${peer}/${targetLabel(header.target)}`;
    this.deps.log(line);
    if (source === "handoff") this.deps.notice?.(line);
    return id;
  }

  async runRemoteLifecycle(peerId: string, request: RemoteLifecycleRequest, source: "dashboard" | "handoff" = "dashboard", transfer?: import("./peer-link").OutgoingTransfer): Promise<string> {
    if (source === "dashboard" && this.remoteStartDenial !== null) throw new Error(remoteLifecycleDenial(this.remoteStartDenial, request.action));
    const machine = await this.peerName(peerId);
    if (machine === null) throw new Error("Machine is no longer paired");
    const conn = this.poller.connectedConnection(peerId);
    if (!conn) throw new Error(`${machine} is disconnected`);
    return requestLifecycle(conn, request, machine, this.deps.setTimer, transfer);
  }

  /** Acknowledge a pending question on the paired machine that owns it, gated like {@link runRemoteLifecycle}. */
  async acknowledgeRemoteQuestion(peerId: string, repo: string, questionId: string): Promise<void> {
    if (this.remoteStartDenial !== null) throw new Error(remoteLifecycleDenial(this.remoteStartDenial, "acknowledge"));
    const machine = await this.peerName(peerId);
    if (machine === null) throw new Error("Machine is no longer paired");
    const conn = this.poller.connectedConnection(peerId);
    if (!conn) throw new Error(`${machine} is disconnected`);
    await requestAcknowledge(conn, repo, questionId, this.deps.setTimer);
  }

  /** With `request.files`, `transfer.filesDir` holds the staged bodies, numbered as in {@link sendRemoteMessage}. */
  async startRemoteAgent(peerId: string, request: RemoteNewAgentRequest, transfer?: import("./peer-link").OutgoingTransfer): Promise<string> {
    if (this.remoteStartDenial !== null) throw new Error(this.remoteStartDenial);
    if (await waitForIO({ setTimer: this.deps.setTimer, signal: transfer?.signal }, () => this.peerName(peerId)) === null) throw new Error("Machine is no longer paired");
    const conn = this.poller.connectedConnection(peerId);
    if (!conn) throw new Error("Machine is disconnected");
    return requestNewAgent(conn, request, this.deps.setTimer, transfer);
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

  /**
   * ib watch is exiting: cancel a pending retry and any pairing, stop the
   * poller, close the endpoint, release the lock.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.recoveryTimer);
    const receipts = [...this.receipts.values()];
    for (const receipt of receipts) receipt.controller.abort(new Error("Watcher shutting down"));
    this.cancelRetry();
    this.active?.session.cancel();
    this.active = null;
    this.outboxOwner?.abort(new Error("Watcher shutting down"));
    const drain = async () => {
      if (this.binding !== null) await this.binding;
      await Promise.all([this.closeEndpoint(), Promise.allSettled(receipts.map(entry => entry.done)), Promise.allSettled(this.outboxPolls)]);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([drain(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
    } finally { clearTimeout(timer); }
  }

  /**
   * Stop the poller, then close the bound endpoint (if any) and release the
   * lock (if held), leaving the service unbound so a later bind starts clean.
   * The endpoint did not stay up long enough to count as recovered, so the
   * stable check is cancelled. `logClosed` false leaves out "endpoint closed".
   */
  private async closeEndpoint(logClosed = true): Promise<void> {
    this.cancelStable();
    clearInterval(this.outboxTimer);
    this.outboxOwner?.abort(new Error("Endpoint stopped"));
    this.poller.stop();
    const ep = this.endpoint;
    this.endpoint = null;
    const relay = this.terminalRelay;
    this.terminalRelay = null;
    try {
      await (await relay)?.close();
    } catch (err) {
      this.deps.log(`peering: closing the terminal socket failed: ${errorDetail(err)}`);
    }
    try {
      if (ep !== null) await ep.close();
    } catch (err) {
      this.deps.log(`peering: closing the endpoint failed: ${errorDetail(err)}`);
    } finally {
      await this.recovery;
      if (this.lockHeld) {
        this.lockHeld = false;
        try {
          await this.deps.releaseLock();
        } catch (err) {
          this.deps.log(`peering: releasing the endpoint lock failed: ${errorDetail(err)}`);
        }
      }
    }
    if (ep !== null && logClosed) this.deps.log("peering: endpoint closed");
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

  /**
   * Load the identity, take the lock, bind, and start the accept loop and the
   * poller. Every failure is shown, leaves the lock released, and is returned
   * for the caller to log once with the retry it arms (retryLater).
   */
  private async bind(readPeersAtBoot: boolean): Promise<BindOutcome> {
    this.setStatus({ kind: "starting" });
    let lock: EndpointLockResult;
    try {
      lock = this.lockHeld ? { acquired: true, generation: this.lockGeneration } : await this.deps.acquireLock();
    } catch (err) {
      const message = `could not take the endpoint lock: ${errorDetail(err)}`;
      this.setStatus({ kind: "error", message, retryAt: null });
      return { kind: "failed", failure: message };
    }
    if (!lock.acquired) {
      if (readPeersAtBoot) await this.refreshPeers();
      if (this.dialogOpen || this.peers.length) {
        try { this.selfId = (await this.deps.loadIdentity()).id; this.identityError = null; }
        catch (err) { this.identityError = errorDetail(err); }
      }
      this.deps.log(`peering disabled: ib watch pid ${lock.ownerPid} owns the endpoint`);
      this.setStatus({ kind: "disabled", ownerPid: lock.ownerPid });
      return { kind: "disabled" };
    }
    this.lockHeld = true;
    this.lockGeneration = lock.generation;
    await this.recoverTransfers();
    if (this.shuttingDown) return { kind: "shutting-down" };
    const readable = !readPeersAtBoot || await this.readPeersAtBoot();
    if (!readable || !this.dialogOpen && !this.peers.length) {
      this.setStatus({ kind: "idle" });
      return { kind: "bound" };
    }
    let identity: PeerIdentity;
    try {
      identity = await this.deps.loadIdentity();
      this.selfId = identity.id;
      this.identityError = null;
    } catch (err) {
      this.lockHeld = false;
      await this.deps.releaseLock().catch(() => {});
      this.identityError = errorDetail(err);
      this.setStatus({ kind: "error", message: this.identityError, retryAt: null });
      return { kind: "failed", failure: `could not load this install's identity: ${this.identityError}` };
    }

    this.publishRemoteAgents(); // replace any snapshot left by the previous lock owner
    if (lock.takenFromPid !== undefined) {
      this.deps.log(`peering: took over the endpoint lock from pid ${lock.takenFromPid}, which is gone`);
    }

    let ep: ServiceEndpoint;
    try {
      ep = await this.deps.bindEndpoint(identity.secretKey, [PAIR_ALPN, PEER_ALPN]);
    } catch (err) {
      const message = errorDetail(err);
      await this.recovery;
      this.lockHeld = false;
      await this.deps.releaseLock().catch(() => {});
      this.setStatus({ kind: "error", message, retryAt: null });
      return { kind: "failed", failure: `could not bind the endpoint: ${message}` };
    }
    if (this.shuttingDown) {
      // shutdown() waits for this bind and then closes `this.endpoint`.
      this.endpoint = ep;
      return { kind: "shutting-down" };
    }
    this.endpoint = ep;
    if (!this.quietBindCycle()) this.deps.log(`peering: endpoint bound as ${shortPeerId(identity.id)}`);
    // After failures, the run (and its backoff) ends only once this endpoint
    // has stayed up for PEER_RETRY_STABLE_MS, which also logs the recovery.
    if (this.failures > 0) this.armStableTimer(ep);
    this.setStatus({ kind: "listening" });
    this.acceptLoopDone = this.acceptLoop(ep);
    this.poller.start();
    this.terminalRelay = this.startRelay();
    const poll = this.deps.pollOutbox;
    if (poll) {
      const owner = this.outboxOwner = new AbortController();
      const dispatches = new Set<symbol>();
      this.outboxTimer = setInterval(() => {
        if (owner.signal.aborted || dispatches.size >= 4) return;
        const dispatch = Symbol();
        dispatches.add(dispatch);
        const dispatchFinished = () => { dispatches.delete(dispatch); };
        const work = poll((peer, header, transfer) => this.sendRemoteMessage(peer, header, "handoff", {
          ...transfer, signal: transfer.signal ? AbortSignal.any([owner.signal, transfer.signal]) : owner.signal,
        }), this.deps.log, () => !owner.signal.aborted && this.endpoint === ep && !this.shuttingDown, dispatchFinished,
          (peer, request, transfer) => this.runRemoteLifecycle(peer, request, "handoff", transfer))
          .catch(err => this.deps.log(`peer-outbox: ${errorDetail(err)}`))
          .finally(() => { dispatchFinished(); this.outboxPolls.delete(work); });
        this.outboxPolls.add(work);
      }, 250);
    }
    return { kind: "bound" };
  }

  private async acceptLoop(ep: ServiceEndpoint): Promise<void> {
    for (;;) {
      let incoming: ServiceIncoming | null;
      try {
        incoming = await ep.acceptNext();
      } catch (err) {
        if (this.endpoint !== ep) return;
        // Without its accept loop the endpoint is useless: close it and give
        // the lock back, then arm the retry, so the rebind starts afresh
        // instead of binding a second endpoint with the same key next to
        // this one. `binding` keeps a dialog open from starting that bind
        // before the close has finished. The failure is logged now (a close
        // that hangs would otherwise hide it) and again with the retry; an
        // accept loop can fail at most once per successful bind.
        // A repeat of the failure that is no longer logged is not logged here
        // either.
        const message = `${ACCEPT_LOOP_STOPPED}${errorDetail(err)}`;
        const quiet = this.quietFailureRepeats(message);
        if (!quiet) this.deps.log(`peering: ${message}; closing the endpoint`);
        this.cancel();
        this.setStatus({ kind: "error", message, retryAt: null });
        this.track(this.closeEndpoint(!quiet).then(() => this.retryLater(message)));
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
      if (alpn === PEER_ALPN) {
        const remoteSpawn = this.deps.remoteSpawn;
        await serveTrustedConnection(toPairConnection(conn), {
          setTimer: this.deps.setTimer,
          peerName: (id) => this.peerName(id),
          lifecycle: this.deps.remoteLifecycle && ((request, readPeerName) =>
            acceptRemoteLifecycle(request, readPeerName, this.deps.remoteLifecycle!, this.deps.log)),
          acknowledgeQuestion: this.deps.remoteQuestions && ((repo, id, readPeerName) =>
            acceptRemoteAcknowledge(repo, id, readPeerName, this.deps.remoteQuestions!, this.deps.log)),
          startAgent: remoteSpawn && ((request, readPeerName) =>
            acceptRemoteAgent(request, readPeerName, remoteSpawn, this.deps.log)),
          startAgentWithFiles: remoteSpawn && ((header, peer, readPeerName, body, options) =>
            this.trackReceipt(peer, `new agent in ${header.repo}`, header.files, options, tracked =>
              acceptRemoteAgentWithFiles(header, peer, readPeerName, body, { ...options, ...tracked }, remoteSpawn, this.deps.log))),
          receiveMessage: this.deps.receiveMessage && ((...args) => this.receiveTracked(...args)),
          snapshot: this.deps.snapshot,
          captureCoordinator: this.deps.captureCoordinator,
          captureAgent: this.deps.captureAgent,
          captureDiff: this.deps.captureDiff,
          readPrompt: this.deps.readPrompt,
          terminal: this.deps.terminal,
          paneReaders: this.paneReaders, headerReaders: this.headerReaders,
          log: this.deps.log,
        });
        return;
      }
      this.deps.log(`peering: closed a connection on unknown ALPN ${JSON.stringify(alpn)}`);
      conn.close(PAIR_CLOSE.error, "unknown alpn");
    } catch (err) {
      this.deps.log(`peering: incoming connection failed: ${errorDetail(err)}`);
    }
  }

  /** The trusted ALPN's allowlist: `peers.json`, re-read on every call. A failed read refuses. */
  private async peerName(id: string): Promise<string | null> {
    try {
      return (await this.deps.readPeers()).find((peer) => peer.id === id)?.name ?? null;
    } catch (err) {
      this.deps.log(`peer link: could not read peers.json, so refusing: ${errorDetail(err)}`);
      return null;
    }
  }

  /** Listen for `ib peer attach` while this endpoint is up. A failure only costs the socket. */
  private async startRelay(): Promise<TerminalRelay | null> {
    const path = this.deps.terminalSocketPath;
    if (!path) return null;
    try {
      return await startTerminalRelay(path, {
        denial: () => this.remoteStartDenial === null ? null : remoteTerminalDenial(this.remoteStartDenial),
        resolvePeer: (target) => this.resolveTerminalPeer(target),
        connection: (id) => this.poller.connectedConnection(id),
        log: this.deps.log,
      });
    } catch (err) {
      this.deps.log(`peering: no terminal socket at ${path}: ${errorDetail(err)}`);
      return null;
    }
  }

  /** The peer `ib peer attach` names: its full id, or its name ignoring case. */
  private async resolveTerminalPeer(target: string): Promise<Peer> {
    const peers = await this.deps.readPeers();
    const id = normalizePeerId(target);
    const byId = id === null ? undefined : peers.find((peer) => peer.id === id);
    if (byId) return byId;
    const named = peers.filter((peer) => peer.name.toLowerCase() === target.toLowerCase());
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw new Error(`${named.length} peers are named ${JSON.stringify(target)}; use the full id`);
    throw new Error(`no paired peer has the name or id ${JSON.stringify(target)}`);
  }

  /** The poller's dial: the trusted ALPN, on the bound endpoint. */
  private async dialPeer(id: string): Promise<PairConnection> {
    const ep = this.endpoint;
    if (ep === null) throw new Error("the endpoint is closed");
    return toPairConnection(await ep.connect(id, PEER_ALPN));
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
