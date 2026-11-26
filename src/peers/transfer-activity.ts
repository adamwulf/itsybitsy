/**
 * Attachment transfers with each peer (SPEC.md §20.4 "Slow links"): the one
 * place the send and receive paths report to and the poller asks.
 *
 * - {@link TransferActivity.begin} starts one transfer with attachment
 *   bodies: an outbound send or new-agent with files (service.ts, through
 *   {@link TransferActivity.track}), or the inbound receipt of one once it
 *   owns its body; or a `watch-log` copy (`ib export-logs`): the requester's
 *   receipt of the reply from its header, and the responder's reply write
 *   (service.ts `fetchWatchLog`, peer-link.ts `serveWatchLog`). It logs one
 *   watch.log line when the transfer starts and one when it ends: ok or
 *   failed with the reason, bytes moved, elapsed seconds and average KB/s.
 *   Nothing is logged per chunk.
 * - Each progress report (a body chunk QUIC accepted for sending or one
 *   received, a header write, a reply fragment) marks the peer as moving
 *   bytes now.
 * - {@link TransferActivity.recentProgress} is true while a transfer with the
 *   peer runs and has moved bytes within {@link TRANSFER_PROGRESS_WINDOW_MS},
 *   and for that long after the watch-log responder's write ends ok, since
 *   its last bytes can still be in flight ({@link TransferStart.endsAtLastWrite}).
 *   The poller then keeps a link whose agents poll or pane read timed out
 *   (poller.ts). A stalled transfer is still ended by its own idle timeout.
 */

import { singleLine } from "./single-line";
import { shortPeerId } from "./store";
import { IDLE_TIMEOUT_MS } from "./transfer-limits";

/**
 * How recently a running transfer must have moved bytes to keep its link
 * through a request timeout: the transfer's own idle deadline. A sender's
 * progress is a write QUIC accepted, and up to a stream window of it (about
 * 1.25 MB) is still in flight after the last write and FIN, so on a slow link
 * a healthy transfer can report nothing for longer than any shorter window.
 * The keep rule must not lapse while the transfer itself still counts as alive.
 */
export const TRANSFER_PROGRESS_WINDOW_MS = IDLE_TIMEOUT_MS;

/** Longest failure reason an end line carries. */
const MAX_REASON = 200;

export interface TransferStart {
  peerId: string;
  /** The paired name, or null when unknown: the line then names the short id alone. */
  peerName: string | null;
  /** The request that carries the bodies: a watch-log copy's are in its reply. */
  op: "send" | "new-agent" | "watch-log";
  /** Outbound ("to" the peer) or inbound ("from" it). */
  direction: "to" | "from";
  files: number;
  /** The declared size of every body together. */
  bytes: number;
  /**
   * The transfer ends when QUIC has accepted its last write and FIN, with no
   * reply to say the peer has the bytes: a `watch-log` responder's reply
   * write. Up to a stream window (about 1.25 MB) can still be in flight then,
   * so after an ok end the peer keeps counting as progressing for
   * {@link TRANSFER_PROGRESS_WINDOW_MS} measured from the end. The end line
   * says `written` instead of claiming delivery.
   */
  endsAtLastWrite?: boolean;
}

/** One running transfer. The first of {@link ok} and {@link failed} ends it; later calls do nothing. */
export interface ActiveTransfer {
  /** The cumulative body bytes moved so far. Call it as often as bytes move. */
  progress(bytes: number): void;
  ok(): void;
  failed(err: unknown): void;
}

export interface TransferActivityDeps {
  /** Epoch ms. */
  now(): number;
  /** watch.log in `ib watch`. */
  log(line: string): void;
}

export class TransferActivity {
  /** Running transfers per peer id and when any of them last moved bytes. */
  private readonly peers = new Map<string, { running: number; lastProgressAt: number }>();
  /** When the last {@link TransferStart.endsAtLastWrite} transfer with each peer id ended ok. */
  private readonly lastWriteEnds = new Map<string, number>();

  constructor(private readonly deps: TransferActivityDeps) {}

  /**
   * A transfer with `peerId` is running and moved bytes within
   * {@link TRANSFER_PROGRESS_WINDOW_MS}, or one with
   * {@link TransferStart.endsAtLastWrite} ended ok within that window.
   */
  recentProgress(peerId: string): boolean {
    const now = this.deps.now();
    const peer = this.peers.get(peerId);
    if (peer !== undefined && now - peer.lastProgressAt <= TRANSFER_PROGRESS_WINDOW_MS) return true;
    const ended = this.lastWriteEnds.get(peerId);
    if (ended === undefined) return false;
    if (now - ended <= TRANSFER_PROGRESS_WINDOW_MS) return true;
    this.lastWriteEnds.delete(peerId);
    return false;
  }

  /** Start one transfer and log its start line. The start counts as progress. */
  begin(start: TransferStart): ActiveTransfer {
    const { now, log } = this.deps;
    const began = now();
    const name = start.peerName === null ? "" : `${singleLine(start.peerName)} `;
    const label = `${start.op} ${start.direction} ${name}(${shortPeerId(start.peerId)})`;
    log(`peer link: transfer started: ${label}: ${start.files} ${start.files === 1 ? "file" : "files"}, ${start.bytes} bytes`);
    const peer = this.peers.get(start.peerId) ?? { running: 0, lastProgressAt: began };
    this.peers.set(start.peerId, peer);
    peer.running++;
    peer.lastProgressAt = began;
    let moved = 0;
    let ended = false;
    // Bytes QUIC accepted, not bytes the peer confirmed.
    const bytes = start.endsAtLastWrite ? "bytes written" : "bytes";
    const end = (outcome: string) => {
      if (ended) return;
      ended = true;
      if (--peer.running === 0 && this.peers.get(start.peerId) === peer) this.peers.delete(start.peerId);
      const endedAt = now();
      if (start.endsAtLastWrite && outcome === "ok") {
        this.lastWriteEnds.set(start.peerId, endedAt);
      }
      const ms = Math.max(endedAt - began, 0);
      const rate = moved / 1024 / (Math.max(ms, 1) / 1000);
      log(`peer link: transfer ${outcome}: ${label}: ${moved} of ${start.bytes} ${bytes} in ${(ms / 1000).toFixed(1)} s, ${rate.toFixed(1)} KB/s`);
    };
    return {
      progress: (bytes) => {
        if (ended) return;
        moved = Math.max(moved, bytes);
        peer.lastProgressAt = now();
      },
      ok: () => end("ok"),
      failed: (err) => {
        const reason = singleLine(err instanceof Error ? err.message : String(err)) || "unknown error";
        end(`failed (${reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason})`);
      },
    };
  }

  /** {@link begin} around `run`, which gets the progress callback. Returns or throws what `run` does. */
  async track<T>(start: TransferStart, run: (progress: (bytes: number) => void) => Promise<T>): Promise<T> {
    const transfer = this.begin(start);
    try {
      const value = await run(transfer.progress);
      transfer.ok();
      return value;
    } catch (err) {
      transfer.failed(err);
      throw err;
    }
  }
}
