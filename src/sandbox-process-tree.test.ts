import { expect, test } from "bun:test";
import { sampleSandboxTree } from "./sandbox-process-tree";
import { SandboxAttribution, type ProcessObservation } from "./sandbox-denials";

const observation = (pid: number, ppid: number, birth: string, time: bigint): ProcessObservation =>
  ({ pid, ppid, birth, before: time, after: time + 1n });
const root = observation(10, 1, "100:0", 10n);

test("already-read root seeds a tick even after the active list was lost", () => {
  let reads = 0;
  const reader = { read: () => { reads++; return null; }, children: () => [] };
  expect(sampleSandboxTree(reader, root, [], root)).toEqual([root]);
  expect(reads).toBe(0);
  expect(sampleSandboxTree(reader, root, [root], root)).toEqual([root]);
  expect(reads).toBe(0); // no second root read can lose a successful observation
});

test("new child ancestry is bracketed by the same parent birth identity", () => {
  const child = observation(20, 10, "200:0", 20n);
  const parentAfter = observation(10, 1, "100:0", 30n);
  const reader = {
    read: (pid: number) => pid === 20 ? child : pid === 10 ? parentAfter : null,
    children: (pid: number) => pid === 10 ? [20] : [],
  };
  const samples = sampleSandboxTree(reader, root, [root], root);
  expect(samples).toEqual([root, child]);
  const attribution = new SandboxAttribution(root);
  attribution.observe(samples, 0);
  expect(attribution.liveIdentities().map(p => p.pid)).toEqual([10, 20]);
});

test("parent reuse during enumeration cannot admit the replacement parent children", () => {
  // All wall births are plausible even without a clock step: an old parent
  // sample plus a new process with its PID must NEVER establish an edge.
  const unrelatedChild = observation(20, 10, "300:0", 20n);
  for (const parentAfter of [null, observation(10, 1, "200:0", 30n), observation(10, 1, "50:0", 30n)]) {
    const samples = sampleSandboxTree({
      read: (pid: number) => pid === 20 ? unrelatedChild : parentAfter,
      children: (pid: number) => pid === 10 ? [20] : [],
    }, root, [root], root);
    expect(samples).toEqual([root]);
  }
});

test("inconsistent temporal brackets are omitted", () => {
  for (const child of [observation(20, 10, "200:0", 0n), observation(20, 10, "200:0", 40n)]) {
    expect(sampleSandboxTree({
      read: (pid: number) => pid === 20 ? child : observation(10, 1, "100:0", 30n),
      children: (pid: number) => pid === 10 ? [20] : [],
    }, root, [root], root)).toEqual([root]);
  }
});

test("verified descendants remain sampled after reparenting and root exit", () => {
  const child = observation(20, 1, "200:0", 20n);
  const samples = sampleSandboxTree({
    read: (pid: number) => pid === 20 ? child : null,
    children: () => [],
  }, root, [root, child], null);
  expect(samples).toEqual([child]);
});
