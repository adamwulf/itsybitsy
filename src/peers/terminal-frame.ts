/**
 * The frames of a remote terminal session (SPEC §20.4 "Remote terminal"). The
 * same frames cross the local attach socket (`ib peer attach` ↔ `ib watch`)
 * and the trusted-link stream (`ib watch` ↔ the peer's `ib watch`).
 *
 * A frame is one type byte, a u32 big-endian payload length and the payload:
 *   - open (1), client → host, first frame only: JSON `{agent, repo?, cols,
 *     rows}`, plus `peer` on the local socket;
 *   - data (2), both ways: raw terminal bytes;
 *   - resize (3), client → host: u16 big-endian cols, then rows;
 *   - exit (4), host → client, last frame: JSON `{code, reason}`.
 *
 * Every stream on the trusted link that starts with byte 1 is therefore a
 * terminal session: a framed `send` starts with 0 (its length prefix is under
 * 16 MiB) and a JSON request with `{`.
 */

import { CHUNK_BYTES } from "./transfer-limits";
import { isValidAgentId } from "../validation";

export const TERMINAL_FRAME = { open: 1, data: 2, resize: 3, exit: 4 } as const;
export type TerminalFrameType = (typeof TERMINAL_FRAME)[keyof typeof TERMINAL_FRAME];

/** Largest data payload a side sends or accepts. */
export const MAX_TERMINAL_DATA = CHUNK_BYTES;
/** Largest open or exit payload. */
export const MAX_TERMINAL_CONTROL = 4096;
const HEADER_BYTES = 5;
/** Terminal sizes outside 1..MAX_TERMINAL_SIZE are refused. */
export const MAX_TERMINAL_SIZE = 1000;

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalOpen extends TerminalSize {
  agent: string;
  /** The agent's registry repo on the host, when the client knows it. */
  repo?: string;
  /** The paired peer's name or id. Only on the local socket; never sent to the host. */
  peer?: string;
}

export interface TerminalExit {
  /** The attach process's exit code, or null when the session ended without one. */
  code: number | null;
  reason: string;
}

export interface TerminalFrame {
  type: TerminalFrameType;
  payload: Uint8Array;
}

/** A frame that is malformed, oversized, or not allowed where it arrived. */
export class TerminalProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalProtocolError";
  }
}

export function encodeTerminalFrame(type: TerminalFrameType, payload: Uint8Array): Uint8Array {
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame[0] = type;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export function encodeTerminalOpen(open: TerminalOpen): Uint8Array {
  return encodeTerminalFrame(TERMINAL_FRAME.open, json(open));
}

/** Data frames for `bytes`, split at {@link MAX_TERMINAL_DATA}. */
export function encodeTerminalData(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_TERMINAL_DATA) {
    frames.push(encodeTerminalFrame(TERMINAL_FRAME.data, bytes.subarray(offset, offset + MAX_TERMINAL_DATA)));
  }
  return frames;
}

export function encodeTerminalResize({ cols, rows }: TerminalSize): Uint8Array {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt16BE(cols, 0);
  payload.writeUInt16BE(rows, 2);
  return encodeTerminalFrame(TERMINAL_FRAME.resize, payload);
}

export function encodeTerminalExit(exit: TerminalExit): Uint8Array {
  const reason = exit.reason.length > 300 ? `${exit.reason.slice(0, 299)}…` : exit.reason;
  return encodeTerminalFrame(TERMINAL_FRAME.exit, json({ code: exit.code, reason }));
}

const KNOWN_TYPES = new Set<number>(Object.values(TERMINAL_FRAME));

/** Splits a byte stream into frames. Throws {@link TerminalProtocolError} on a bad header. */
export class TerminalFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** Bytes held that do not yet make a whole frame. */
  get pending(): number {
    return this.buffer.length;
  }

  push(chunk: Uint8Array): TerminalFrame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames: TerminalFrame[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const type = this.buffer[0]!;
      const length = this.buffer.readUInt32BE(1);
      if (!KNOWN_TYPES.has(type)) throw new TerminalProtocolError(`unknown terminal frame type ${type}`);
      const limit = type === TERMINAL_FRAME.data ? MAX_TERMINAL_DATA : type === TERMINAL_FRAME.resize ? 4 : MAX_TERMINAL_CONTROL;
      if (length > limit || (type === TERMINAL_FRAME.resize && length !== 4)) {
        throw new TerminalProtocolError(`terminal frame type ${type} has a bad length (${length} bytes)`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;
      frames.push({ type: type as TerminalFrameType, payload: Uint8Array.from(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)) });
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
    return frames;
  }
}

function decodeJson(payload: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new TerminalProtocolError(`${what} is not UTF-8 JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TerminalProtocolError(`${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TERMINAL_SIZE;
}

/**
 * Parse an open frame's payload. `peer` is kept only when `allowPeer` (the
 * local socket); the host refuses an open that names one.
 */
export function parseTerminalOpen(payload: Uint8Array, { allowPeer }: { allowPeer: boolean }): TerminalOpen {
  const value = decodeJson(payload, "terminal open");
  const allowed = allowPeer ? ["agent", "repo", "cols", "rows", "peer"] : ["agent", "repo", "cols", "rows"];
  if (!Object.keys(value).every(key => allowed.includes(key))) throw new TerminalProtocolError("terminal open has unknown fields");
  const { agent, repo, cols, rows, peer } = value;
  if (typeof agent !== "string" || !isValidAgentId(agent)) throw new TerminalProtocolError("terminal open has no valid agent id");
  if (repo !== undefined && (typeof repo !== "string" || repo.length === 0 || /[\p{Cc}\p{Cf}/]/u.test(repo))) {
    throw new TerminalProtocolError("terminal open has a malformed repo");
  }
  if (!validSize(cols) || !validSize(rows)) throw new TerminalProtocolError("terminal open has a bad size");
  if (allowPeer && (typeof peer !== "string" || peer.length === 0)) throw new TerminalProtocolError("terminal open names no peer");
  return { agent, cols, rows, ...(repo !== undefined && { repo }), ...(allowPeer && { peer: peer as string }) };
}

export function parseTerminalResize(payload: Uint8Array): TerminalSize {
  const bytes = Buffer.from(payload);
  const size = { cols: bytes.readUInt16BE(0), rows: bytes.readUInt16BE(2) };
  if (!validSize(size.cols) || !validSize(size.rows)) throw new TerminalProtocolError("terminal resize has a bad size");
  return size;
}

/** Parse an exit frame. The reason is the other side's text: callers strip it before showing it. */
export function parseTerminalExit(payload: Uint8Array): TerminalExit {
  const value = decodeJson(payload, "terminal exit");
  const code = value.code === null || (typeof value.code === "number" && Number.isInteger(value.code)) ? value.code as number | null : undefined;
  if (code === undefined || typeof value.reason !== "string") throw new TerminalProtocolError("terminal exit is malformed");
  return { code, reason: value.reason };
}
