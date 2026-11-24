import { describe, expect, test } from "bun:test";
import {
  MAX_TERMINAL_DATA,
  TERMINAL_FRAME,
  TerminalFrameReader,
  TerminalProtocolError,
  encodeTerminalData,
  encodeTerminalExit,
  encodeTerminalFrame,
  encodeTerminalOpen,
  encodeTerminalResize,
  parseTerminalExit,
  parseTerminalOpen,
  parseTerminalResize,
} from "./terminal-frame";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("terminal frames", () => {
  test("an open frame starts with byte 1, which no other trusted-link request does", () => {
    const frame = encodeTerminalOpen({ agent: "worker-1", cols: 80, rows: 24 });
    expect(frame[0]).toBe(1);
  });

  test("the reader reassembles frames split at any byte", () => {
    const stream = Buffer.concat([
      encodeTerminalOpen({ agent: "a", repo: "alpha", cols: 120, rows: 40, peer: "laptop" }),
      ...encodeTerminalData(bytes("hello")),
      encodeTerminalResize({ cols: 90, rows: 30 }),
      encodeTerminalExit({ code: 0, reason: "exited" }),
    ]);
    for (let split = 1; split < stream.length; split++) {
      const reader = new TerminalFrameReader();
      const frames = [...reader.push(stream.subarray(0, split)), ...reader.push(stream.subarray(split))];
      expect(frames.map(f => f.type)).toEqual([TERMINAL_FRAME.open, TERMINAL_FRAME.data, TERMINAL_FRAME.resize, TERMINAL_FRAME.exit]);
      expect(parseTerminalOpen(frames[0]!.payload, { allowPeer: true })).toEqual({ agent: "a", repo: "alpha", cols: 120, rows: 40, peer: "laptop" });
      expect(new TextDecoder().decode(frames[1]!.payload)).toBe("hello");
      expect(parseTerminalResize(frames[2]!.payload)).toEqual({ cols: 90, rows: 30 });
      expect(parseTerminalExit(frames[3]!.payload)).toEqual({ code: 0, reason: "exited" });
      expect(reader.pending).toBe(0);
    }
  });

  test("data is split into frames of at most 64 KiB", () => {
    const frames = encodeTerminalData(new Uint8Array(MAX_TERMINAL_DATA * 2 + 1));
    expect(frames.map(f => f.length - 5)).toEqual([MAX_TERMINAL_DATA, MAX_TERMINAL_DATA, 1]);
    expect(encodeTerminalData(new Uint8Array())).toEqual([]);
  });

  test("the reader refuses an unknown type or an oversized frame before buffering it", () => {
    expect(() => new TerminalFrameReader().push(encodeTerminalFrame(9 as 1, new Uint8Array()))).toThrow(TerminalProtocolError);
    const oversized = Buffer.alloc(5);
    oversized[0] = TERMINAL_FRAME.data;
    oversized.writeUInt32BE(MAX_TERMINAL_DATA + 1, 1);
    expect(() => new TerminalFrameReader().push(oversized)).toThrow("bad length");
    expect(() => new TerminalFrameReader().push(encodeTerminalFrame(TERMINAL_FRAME.resize, new Uint8Array(3)))).toThrow("bad length");
  });

  test("the host refuses an open that names a peer, an invalid agent id or a bad size", () => {
    const open = (value: unknown) => bytes(JSON.stringify(value));
    expect(() => parseTerminalOpen(open({ agent: "a", cols: 80, rows: 24, peer: "x" }), { allowPeer: false })).toThrow("unknown fields");
    expect(() => parseTerminalOpen(open({ agent: "a;rm", cols: 80, rows: 24 }), { allowPeer: false })).toThrow("agent id");
    expect(() => parseTerminalOpen(open({ agent: "a", cols: 0, rows: 24 }), { allowPeer: false })).toThrow("bad size");
    expect(() => parseTerminalOpen(open({ agent: "a", repo: "x/y", cols: 80, rows: 24 }), { allowPeer: false })).toThrow("repo");
    expect(() => parseTerminalOpen(open({ agent: "a", cols: 80, rows: 24 }), { allowPeer: true })).toThrow("names no peer");
    expect(() => parseTerminalOpen(bytes("[]"), { allowPeer: false })).toThrow("not a JSON object");
  });

  test("a resize outside 1..1000 is refused", () => {
    expect(() => parseTerminalResize(Buffer.from([0, 0, 0, 24]))).toThrow("bad size");
    expect(() => parseTerminalResize(Buffer.from([0x03, 0xe9, 0, 24]))).toThrow("bad size");
  });

  test("an exit reason is capped", () => {
    const exit = parseTerminalExit(new TerminalFrameReader().push(encodeTerminalExit({ code: null, reason: "x".repeat(1000) }))[0]!.payload);
    expect(exit.code).toBeNull();
    expect(exit.reason.length).toBe(300);
  });
});
