import { test, expect, describe, afterEach } from "bun:test";
import { checkWorktreeCleanliness, gitStatusSpawnCtx } from "./git-status";
import type { SpawnFn, SpawnResult } from "./types";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (text.length > 0) c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function fakeSpawn(
  handler: (cmd: string[]) => { stdout?: string; stderr?: string; exitCode?: number },
): { fn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: SpawnFn = (cmd): SpawnResult => {
    calls.push(cmd);
    const r = handler(cmd);
    return {
      stdout: streamOf(r.stdout ?? ""),
      stderr: streamOf(r.stderr ?? ""),
      exited: Promise.resolve(r.exitCode ?? 0),
      kill: () => {},
    };
  };
  return { fn, calls };
}

describe("checkWorktreeCleanliness", () => {
  afterEach(() => {
    gitStatusSpawnCtx.reset();
  });

  test("runs a lock-free porcelain status against the given path", async () => {
    const { fn, calls } = fakeSpawn(() => ({ stdout: "" }));
    gitStatusSpawnCtx.set(fn);
    await checkWorktreeCleanliness("/repo/.ittybitty/agents/agent-1/repo");
    expect(calls).toEqual([[
      "git", "-C", "/repo/.ittybitty/agents/agent-1/repo",
      "--no-optional-locks", "status", "--porcelain",
    ]]);
  });

  test("reports clean when porcelain output is empty", async () => {
    gitStatusSpawnCtx.set(fakeSpawn(() => ({ stdout: "" })).fn);
    expect(await checkWorktreeCleanliness("/wt")).toBe("clean");
  });

  test("reports dirty for a modified tracked file", async () => {
    gitStatusSpawnCtx.set(fakeSpawn(() => ({ stdout: " M src/index.ts\n" })).fn);
    expect(await checkWorktreeCleanliness("/wt")).toBe("dirty");
  });

  test("reports dirty for a staged file", async () => {
    gitStatusSpawnCtx.set(fakeSpawn(() => ({ stdout: "A  src/new.ts\n" })).fn);
    expect(await checkWorktreeCleanliness("/wt")).toBe("dirty");
  });

  test("reports dirty for an untracked file (same rule as the spawn gate)", async () => {
    gitStatusSpawnCtx.set(fakeSpawn(() => ({ stdout: "?? scratch.txt\n" })).fn);
    expect(await checkWorktreeCleanliness("/wt")).toBe("dirty");
  });

  test("returns null (unknown) when git exits non-zero", async () => {
    gitStatusSpawnCtx.set(fakeSpawn(() => ({
      stderr: "fatal: not a git repository",
      exitCode: 128,
    })).fn);
    expect(await checkWorktreeCleanliness("/not-a-repo")).toBeNull();
  });

  test("returns null (unknown) when the spawn itself throws", async () => {
    gitStatusSpawnCtx.set((() => {
      throw new Error("ENOENT: no such file or directory");
    }) as SpawnFn);
    expect(await checkWorktreeCleanliness("/gone")).toBeNull();
  });

  test("returns null when the porcelain stream rejects mid-read", async () => {
    gitStatusSpawnCtx.set(((): SpawnResult => ({
      stdout: new ReadableStream({ start(c) { c.error(new Error("pipe broke")); } }),
      stderr: streamOf(""),
      exited: Promise.resolve(0),
      kill: () => {},
    })) as SpawnFn);
    expect(await checkWorktreeCleanliness("/wt")).toBeNull();
  });
});
