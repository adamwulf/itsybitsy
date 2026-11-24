/**
 * `ib peer attach <peer>/[<repo>/]<agent>` (SPEC §20.4 "Remote terminal"):
 * attach this terminal to an agent's tmux session on a paired peer, through
 * the terminal socket of the endpoint-owning `ib watch` (terminal-relay.ts).
 *
 * The terminal is put in raw mode, so every key goes to the remote tmux
 * client; leave with its detach key. Inside a local tmux window (how `ib
 * watch` opens it) the local tmux takes the prefix first: press it twice to
 * reach the remote one.
 *
 * Like the other `ib peer` commands this never loads the iroh addon, and the
 * agent hooks deny it to every agent session.
 */

import { connect, type Socket } from "node:net";
import { peerTerminalSocket } from "../runtime-names";
import { isValidAgentId } from "../validation";
import {
  MAX_TERMINAL_SIZE,
  TERMINAL_FRAME,
  TerminalFrameReader,
  encodeTerminalData,
  encodeTerminalOpen,
  encodeTerminalResize,
  parseTerminalExit,
  type TerminalExit,
  type TerminalSize,
} from "./terminal-frame";

export const ATTACH_USAGE = "Usage: ib peer attach <peer>/[<repo>/]<agent>";

export interface AttachTarget {
  peer: string;
  repo?: string;
  agent: string;
}

/** `<peer>/<agent>` or `<peer>/<repo>/<agent>`; null when it is neither. */
export function parseAttachTarget(text: string): AttachTarget | null {
  const parts = text.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some(part => part.length === 0)) return null;
  const peer = parts[0]!;
  const agent = parts.at(-1)!;
  if (!isValidAgentId(agent)) return null;
  return parts.length === 3 ? { peer, repo: parts[1]!, agent } : { peer, agent };
}

/** What the command talks to: the terminal and the socket. Injectable for tests. */
export interface AttachIO {
  stdin: Pick<NodeJS.ReadStream, "isTTY" | "on" | "off" | "resume" | "pause"> & { setRawMode?(mode: boolean): unknown };
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "columns" | "rows" | "write" | "on" | "off">;
  stderr(text: string): void;
  socketPath: string;
}

function defaultIO(): AttachIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: (text) => { process.stderr.write(text); },
    socketPath: peerTerminalSocket(),
  };
}

function terminalSize(stdout: AttachIO["stdout"]): TerminalSize {
  const clamp = (value: number | undefined, fallback: number) =>
    Math.min(MAX_TERMINAL_SIZE, Math.max(1, Number.isInteger(value) && value! > 0 ? value! : fallback));
  return { cols: clamp(stdout.columns, 80), rows: clamp(stdout.rows, 24) };
}

/** Text from the remote side, safe to print: control and format characters removed. */
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Wait for one line on stdin (canonical mode): the "Press Enter" after a failure. */
function waitForEnter(stdin: AttachIO["stdin"]): Promise<void> {
  return new Promise(resolve => {
    const done = () => { stdin.off("data", done); stdin.pause(); resolve(); };
    stdin.on("data", done);
    stdin.resume();
  });
}

/** Run `ib peer attach <args>`. Returns the exit code: 0 when the remote tmux client exited cleanly. */
export async function runAttach(args: string[], io: AttachIO = defaultIO()): Promise<number> {
  const target = args.length === 1 ? parseAttachTarget(args[0]!) : null;
  if (!target) {
    io.stderr(`${ATTACH_USAGE}\n`);
    return 1;
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY || !io.stdin.setRawMode) {
    io.stderr("Error: ib peer attach needs an interactive terminal\n");
    return 1;
  }
  let socket: Socket;
  try {
    socket = await openSocket(io.socketPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    io.stderr(`Error: cannot reach the ib watch that owns the peer endpoint (${io.socketPath}: ${code}). Is ib watch running and paired?\n`);
    return 1;
  }

  let exit: TerminalExit | null = null;
  const reader = new TerminalFrameReader();
  const ended = Promise.withResolvers<void>();
  const send = (bytes: Uint8Array) => { if (!socket.destroyed) socket.write(bytes); };
  const onInput = (chunk: Buffer) => { for (const frame of encodeTerminalData(chunk)) send(frame); };
  const onResize = () => send(encodeTerminalResize(terminalSize(io.stdout)));
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const frame of reader.push(chunk)) {
        if (frame.type === TERMINAL_FRAME.data) io.stdout.write(frame.payload);
        else if (frame.type === TERMINAL_FRAME.exit) exit = parseTerminalExit(frame.payload);
      }
    } catch (err) {
      exit ??= { code: null, reason: err instanceof Error ? err.message : String(err) };
      socket.destroy();
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => ended.resolve());

  send(encodeTerminalOpen({ ...target, ...terminalSize(io.stdout) }));
  io.stdin.setRawMode(true);
  io.stdin.on("data", onInput);
  io.stdin.resume();
  io.stdout.on("resize", onResize);
  try {
    await ended.promise;
  } finally {
    io.stdout.off("resize", onResize);
    io.stdin.off("data", onInput);
    io.stdin.setRawMode(false);
    io.stdin.pause();
  }

  const result = exit as TerminalExit | null;
  if (result?.code === 0) return 0;
  io.stderr(`\r\n[remote terminal ended: ${clean(result?.reason ?? "") || "the connection to ib watch closed"}]\r\n`);
  io.stderr("Press Enter to close.");
  await waitForEnter(io.stdin);
  return 1;
}
