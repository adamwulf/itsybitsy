/**
 * Test-only helpers for the pair protocol (src/peers/pairing.ts): an
 * in-memory {@link PairConnection} pair and a fake clock. No addon, no
 * network, no real waiting.
 *
 * The link follows the real transport's contract as the iroh probes showed it
 * (docs/plans/iroh-spike-findings.md and src/peers/iroh.test.ts):
 *   - a bi stream opened on one side is accepted on the other;
 *   - readToEnd resolves once the writer finishes, and throws
 *     PairProtocolError past its limit (what service.ts maps TooLong to);
 *   - close(code, reason) fails every pending call on both sides, and
 *     closeInfo() is set before they reject: `{byPeer: false, reason:
 *     "closed"}` locally, `{byPeer: true, code, reason}` on the other side.
 */

import type { PeerService } from "./service";
import { PairProtocolError, type PairCloseInfo, type PairConnection, type PairStream } from "./pairing";

/** A loopback fixture should surface a failed bind before any retry or test deadline. */
export function listeningOrThrow(service: PeerService): boolean {
  const status = service.view().status;
  if (status.kind === "error") throw new Error(status.message);
  return status.kind === "listening";
}

/** One direction of a bi stream. */
class Pipe {
  private chunks: Uint8Array[] = [];
  private finished = false;
  private cancelled = false;

  cancel(): void { this.cancelled = true; this.wake(); }
  private waiters: Array<() => void> = [];

  write(bytes: Uint8Array): void {
    if (this.cancelled) throw new Error("stream cancelled");
    if (this.finished) throw new Error("write after finish");
    this.chunks.push(Uint8Array.from(bytes));
    this.wake();
  }

  finish(): void {
    this.finished = true;
    this.wake();
  }

  /** Wake readers so they can see a close. */
  wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async read(limit: number, isClosed: () => boolean): Promise<Uint8Array> {
    for (;;) {
      if (this.cancelled || isClosed()) throw new Error("stream closed");
      const chunk = this.chunks.shift();
      if (chunk?.length) {
        if (chunk.length > limit) this.chunks.unshift(chunk.subarray(limit));
        return chunk.subarray(0, limit);
      }
      if (this.finished) return new Uint8Array();
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }

  async readToEnd(limit: number, isClosed: () => boolean): Promise<Uint8Array> {
    for (;;) {
      if (this.cancelled) throw new Error("stream cancelled");
      if (isClosed()) throw new Error("connection lost");
      if (this.finished) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    if (total > limit) throw new PairProtocolError(`message longer than ${limit} bytes`);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

class MemoryStream implements PairStream {
  constructor(
    private readonly outgoing: Pipe,
    private readonly incoming: Pipe,
    private readonly conn: MemoryConnection,
  ) {}

  async resetSending(): Promise<void> { this.outgoing.cancel(); }

  async stopReceiving(): Promise<void> { this.incoming.cancel(); }

  async cancel(): Promise<void> {
    this.incoming.cancel();
    this.outgoing.cancel();
  }

  async write(bytes: Uint8Array): Promise<number> { await this.writeAll(bytes); return bytes.length; }

  async writeAll(bytes: Uint8Array): Promise<void> {
    if (this.conn.closeInfo()) throw new Error("connection lost");
    this.outgoing.write(bytes);
  }

  async finish(): Promise<void> {
    if (this.conn.closeInfo()) throw new Error("connection lost");
    this.outgoing.finish();
  }

  read(limit: number): Promise<Uint8Array> {
    return this.incoming.read(limit, () => this.conn.closeInfo() !== null);
  }

  readToEnd(limit: number): Promise<Uint8Array> {
    return this.incoming.readToEnd(limit, () => this.conn.closeInfo() !== null);
  }
}

export class MemoryConnection implements PairConnection {
  peer!: MemoryConnection;
  private info: PairCloseInfo | null = null;
  private acceptQueue: MemoryStream[] = [];
  private acceptWaiters: Array<() => void> = [];
  private pipes: Pipe[] = [];
  private resolveClosed!: (info: PairCloseInfo) => void;
  private readonly closedPromise = new Promise<PairCloseInfo>((resolve) => {
    this.resolveClosed = resolve;
  });
  /** Every close(code, reason) this side made, for assertions. */
  readonly closes: Array<{ code: number; reason: string }> = [];

  constructor(readonly remoteId: string) {}

  async openBi(): Promise<PairStream> {
    if (this.info) throw new Error("connection lost");
    const toPeer = new Pipe();
    const fromPeer = new Pipe();
    this.pipes.push(toPeer, fromPeer);
    this.peer.pipes.push(toPeer, fromPeer);
    this.peer.deliver(new MemoryStream(fromPeer, toPeer, this.peer));
    return new MemoryStream(toPeer, fromPeer, this);
  }

  async acceptBi(): Promise<PairStream> {
    for (;;) {
      if (this.info) throw new Error("connection lost");
      const next = this.acceptQueue.shift();
      if (next) return next;
      await new Promise<void>((resolve) => this.acceptWaiters.push(resolve));
    }
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    if (this.info) return;
    this.markClosed({ byPeer: false, reason: "closed" });
    this.peer.markClosed({ byPeer: true, code, reason });
  }

  closed(): Promise<PairCloseInfo> {
    return this.closedPromise;
  }

  closeInfo(): PairCloseInfo | null {
    return this.info;
  }

  private deliver(stream: MemoryStream): void {
    this.acceptQueue.push(stream);
    for (const waiter of this.acceptWaiters.splice(0)) waiter();
  }

  private markClosed(info: PairCloseInfo): void {
    if (this.info) return;
    this.info = info;
    for (const waiter of this.acceptWaiters.splice(0)) waiter();
    for (const pipe of this.pipes) pipe.wake();
    this.resolveClosed(info);
  }
}

/** Two connected ends: `a` is A's connection to B (remoteId = idB), `b` is B's to A. */
export function createMemoryLink(idA: string, idB: string): { a: MemoryConnection; b: MemoryConnection } {
  const a = new MemoryConnection(idB);
  const b = new MemoryConnection(idA);
  a.peer = b;
  b.peer = a;
  return { a, b };
}

/** A clock whose timers fire only when {@link FakeClock.advance} passes them. */
export interface FakeClock {
  now(): number;
  setTimer(ms: number, fn: () => void): () => void;
  /** Move time forward and fire every timer now due, in due order. */
  advance(ms: number): void;
  /** Move time forward WITHOUT firing timers: a timer that is due but has not run yet. */
  jump(ms: number): void;
  /** Timers armed and not yet fired or cancelled. */
  pending(): number;
}

export function createFakeClock(start = 1_800_000_000_000): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer(ms, fn) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((x, y) => x[1].at - y[1].at || x[0] - y[0]);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.fn();
      }
    },
    jump(ms) {
      now += ms;
    },
    pending: () => timers.size,
  };
}
