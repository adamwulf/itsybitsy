import { expect, test } from "bun:test";
import { decodeSandboxChildPids } from "./sandbox-processes";

test("native child-count contract preserves one, two and three descendants", () => {
  // Live Darwin 25 reproduction: return=2, buffer holds two PIDs. Dividing this
  // return by four (proc_listpids convention) incorrectly discarded both.
  const buffer = new Int32Array([30618, 30619, 30620, 0, 0, 0, 0, 0]);
  expect(decodeSandboxChildPids(buffer, 0)).toEqual([]);
  expect(decodeSandboxChildPids(buffer, 1)).toEqual([30618]);
  expect(decodeSandboxChildPids(buffer, 2)).toEqual([30618, 30619]);
  expect(decodeSandboxChildPids(buffer, 3)).toEqual([30618, 30619, 30620]);
});

test("enumeration rejects errors, malformed counts and a potentially truncated buffer", () => {
  const buffer = new Int32Array(4096);
  for (const count of [-1, 0.5, NaN, 4096, 16384]) {
    expect(() => decodeSandboxChildPids(buffer, count)).toThrow("enumeration unavailable");
  }
  expect(decodeSandboxChildPids(new Int32Array([17, 0, -1, 0]), 3)).toEqual([17]);
});
