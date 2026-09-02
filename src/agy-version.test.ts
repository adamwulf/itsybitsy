import { test, expect, describe } from "bun:test";
import { probeAgyVersion } from "./agy-version";
import type { SpawnFn, SpawnResult } from "./types";

/** A resolved SpawnResult with the given stdout + exit code. */
function makeResult(stdout: string, exitCode: number, opts?: { onKill?: () => void }): SpawnResult {
  return {
    stdout: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(stdout)); c.close(); },
    }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    exited: Promise.resolve(exitCode),
    kill: opts?.onKill,
  };
}

/** A SpawnResult whose child never exits and whose stdout never closes. */
function makeNeverResolving(onKill?: () => void): SpawnResult {
  return {
    stdout: new ReadableStream({ start() { /* never enqueues, never closes */ } }),
    stderr: new ReadableStream({ start() { /* never closes */ } }),
    exited: new Promise<number>(() => { /* never resolves */ }),
    kill: onKill,
  };
}

describe("probeAgyVersion", () => {
  test("returns trimmed stdout on a clean (exit 0) probe", async () => {
    const run: SpawnFn = () => makeResult("agy 1.1.23\n", 0);
    expect(await probeAgyVersion(run, 1000)).toBe("agy 1.1.23");
  });

  test("returns '' when the probe exits non-zero", async () => {
    const run: SpawnFn = () => makeResult("some error", 1);
    expect(await probeAgyVersion(run, 1000)).toBe("");
  });

  test("returns '' when the spawn itself throws", async () => {
    const run: SpawnFn = () => { throw new Error("ENOENT: agy not found"); };
    expect(await probeAgyVersion(run, 1000)).toBe("");
  });

  test("passes stdin:'ignore' so agy can't block on an inherited stdin pipe", async () => {
    let seenOpts: unknown;
    const run: SpawnFn = (_cmd, opts) => { seenOpts = opts; return makeResult("v", 0); };
    await probeAgyVersion(run, 1000);
    expect((seenOpts as { stdin?: string }).stdin).toBe("ignore");
  });

  test("probes exactly `agy --version`", async () => {
    let seenCmd: string[] = [];
    const run: SpawnFn = (cmd) => { seenCmd = cmd; return makeResult("v", 0); };
    await probeAgyVersion(run, 1000);
    expect(seenCmd).toEqual(["agy", "--version"]);
  });

  test("a never-resolving runner returns '' within the timeout (and kills the child)", async () => {
    let killed = false;
    const run: SpawnFn = () => makeNeverResolving(() => { killed = true; });
    const start = Date.now();
    const result = await probeAgyVersion(run, 50);
    const elapsed = Date.now() - start;
    expect(result).toBe("");
    expect(elapsed).toBeLessThan(1000); // did not wait the full 5s default
    expect(killed).toBe(true);
  });

  test("tolerates a child with no kill() method on timeout", async () => {
    const run: SpawnFn = () => makeNeverResolving(undefined);
    expect(await probeAgyVersion(run, 50)).toBe("");
  });
});
