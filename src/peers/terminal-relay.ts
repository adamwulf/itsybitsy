/**
 * The local attach socket of the endpoint-owning `ib watch` (SPEC §20.4
 * "Remote terminal"): `~/.itsybitsy/peer/terminal.sock`, mode 0600, inside
 * the 0700 peer directory.
 *
 * Only the `ib watch` holding the endpoint lock has the iroh endpoint, so
 * `ib peer attach` reaches a peer through it: the client sends an open frame
 * that also names the peer, the relay opens a terminal stream on that peer's
 * live trusted connection (the poller's) and forwards it the open frame
 * without the peer, then whole frames both ways. Anything that fails before
 * the stream is open, or a link that drops mid-session, reaches the client as
 * an exit frame.
 *
 * Anyone who can connect to the socket can type into the peer's agent
 * sessions. The kernel sandbox denies agents the connect (src/sandbox.ts).
 */

import { chmod, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import type { PairConnection, PairStream } from "./pairing";
import {
  MAX_TERMINAL_DATA,
  TERMINAL_FRAME,
  TerminalFrameReader,
  TerminalProtocolError,
  encodeTerminalExit,
  encodeTerminalFrame,
  encodeTerminalOpen,
  parseTerminalOpen,
  type TerminalFrame,
} from "./terminal-frame";

/** How long a client has to send its open frame. */
export const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

export interface TerminalRelayDeps {
  /**
   * Why this `ib watch` may not open remote terminals (its startup
   * human-caller decision, as for every other outbound peer request), or
   * null when it may.
   */
  denial?(): string | null;
  /** The paired peer that `target` (a name or id) names; throws with the reason to show. */
  resolvePeer(target: string): Promise<{ id: string; name: string }>;
  /** The peer's live trusted connection, or null while it is disconnected. */
  connection(peerId: string): PairConnection | null;
  log(line: string): void;
}

export interface TerminalRelay {
  /** Stop listening, end every relayed session and remove the socket. */
  close(): Promise<void>;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const reencode = (frame: TerminalFrame) => encodeTerminalFrame(frame.type, frame.payload);

/** Write one frame and wait until the socket has taken it. */
function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (socket.destroyed || socket.writableEnded) return Promise.reject(new Error("the attach client is gone"));
  return new Promise((resolve, reject) => socket.write(bytes, err => err ? reject(err) : resolve()));
}

/**
 * Listen on `path`. A socket file left there is removed first: the caller
 * holds the endpoint lock, so no other live `ib watch` owns it.
 */
export async function startTerminalRelay(path: string, deps: TerminalRelayDeps): Promise<TerminalRelay> {
  await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    void relayClient(socket, deps);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", err => deps.log(`peer link: terminal socket error: ${errorDetail(err)}`));
  await chmod(path, 0o600);
  return {
    close: async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      await unlink(path).catch(() => {});
    },
  };
}

/** One attach client, from its open frame until both directions have ended. Never throws. */
async function relayClient(socket: Socket, deps: TerminalRelayDeps): Promise<void> {
  socket.on("error", () => {}); // a client that vanishes ends its iterator below
  const chunks: AsyncIterator<Buffer> = socket[Symbol.asyncIterator]();
  const fromClient = new TerminalFrameReader();
  let stream: PairStream;
  let label: string;
  try {
    let frames: TerminalFrame[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no open frame within 10 s")), TERMINAL_OPEN_TIMEOUT_MS);
    });
    try {
      while (!frames.length) {
        const next = await Promise.race([chunks.next(), timeout]);
        if (next.done) { socket.destroy(); return; }
        frames = fromClient.push(next.value);
      }
    } finally { clearTimeout(timer); }
    const [head, ...rest] = frames;
    if (head!.type !== TERMINAL_FRAME.open) throw new TerminalProtocolError("the first frame is not an open frame");
    const { peer: target, ...open } = parseTerminalOpen(head!.payload, { allowPeer: true });
    const denied = deps.denial?.() ?? null;
    if (denied !== null) throw new Error(denied);
    const peer = await deps.resolvePeer(target!);
    const conn = deps.connection(peer.id);
    if (!conn) throw new Error(`${peer.name} is disconnected`);
    stream = await conn.openBi();
    label = `${peer.name}/${open.agent}`;
    try {
      await stream.writeAll(encodeTerminalOpen(open));
      for (const frame of rest) await stream.writeAll(reencode(frame));
    } catch (err) {
      await stream.cancel().catch(() => {});
      throw err;
    }
  } catch (err) {
    socket.end(encodeTerminalExit({ code: null, reason: errorDetail(err) }));
    return;
  }
  deps.log(`peer link: relaying a local terminal to ${label}`);

  const upstream = (async () => {
    try {
      for (;;) {
        const next = await chunks.next();
        if (next.done) break;
        for (const frame of fromClient.push(next.value)) await stream.writeAll(reencode(frame));
      }
      await stream.finish();
    } catch {
      await stream.resetSending().catch(() => {});
    }
  })();

  const downstream = (async () => {
    const fromHost = new TerminalFrameReader();
    let exited = false;
    try {
      for (;;) {
        const chunk = await stream.read(MAX_TERMINAL_DATA);
        if (!chunk.length) break;
        for (const frame of fromHost.push(chunk)) {
          if (frame.type === TERMINAL_FRAME.exit) exited = true;
          await writeSocket(socket, reencode(frame));
        }
      }
      if (!exited) await writeSocket(socket, encodeTerminalExit({ code: null, reason: "the remote terminal ended without an exit status" }));
    } catch (err) {
      if (!exited) await writeSocket(socket, encodeTerminalExit({ code: null, reason: `connection lost: ${errorDetail(err)}` })).catch(() => {});
    }
    socket.end();
    await stream.stopReceiving().catch(() => {});
  })();

  await Promise.all([upstream, downstream]);
  deps.log(`peer link: local terminal to ${label} ended`);
}
