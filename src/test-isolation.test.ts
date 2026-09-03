/**
 * Regression test for the global tmux safety backstop installed by the
 * `bun test` preload (test-preload.ts).
 *
 * The backstop exists so that `bun test` is STRUCTURALLY unable to launch a real
 * `tmux ...` command against the developer's live, fixed-name `ib-coordinator`
 * session — new-session, send-keys, kill-session, or capture-pane. See the long
 * comment in test-preload.ts for why that fixed shared server/session makes each
 * of those command classes unsafe.
 *
 * The mechanism: the preload calls SpawnContext.setDefault(safeTestSpawnRunner)
 * on both coordinator.ts's `coordinatorSpawnCtx` and tmux-poller.ts's `spawnCtx`,
 * so a plain `.reset()` — including one that fires from async work still draining
 * after a test tore its mock down — lands on the safe no-op stub instead of the
 * production default (live `Bun.spawn`).
 *
 * These tests prove: (a) reset restores the safety runner, not Bun.spawn;
 * (b) the stub is a well-formed, subprocess-free no-op for every dangerous
 * fixed-session command class; (c) the real tmux-poller capture/probe/kill paths
 * stay inert on top of it; and (d) an ordinary per-test `.set(mock)` still
 * overrides it and reset returns to the stub afterwards.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { safeTestSpawnRunner } from "../test-preload";
import { coordinatorSpawnCtx, IB_COORDINATOR_SESSION } from "./coordinator";
import {
  spawnCtx as tmuxPollerSpawnCtx,
  captureTmuxOutput,
  probeTmuxSession,
  killTmuxSessionResult,
} from "./tmux-poller";
import { tmuxSessionTarget } from "./validation";
import type { SpawnFn } from "./types";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (text.length > 0) c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

const target = tmuxSessionTarget(IB_COORDINATOR_SESSION); // "=ib-coordinator:"

/**
 * Representative command arrays for the four dangerous classes, all aimed at the
 * fixed `ib-coordinator` session exactly as coordinator.ts / tmux-poller.ts build
 * them. Keyed by the lifecycle role the manager task calls out (create / kill /
 * send / capture).
 */
const FIXED_SESSION_COMMANDS = {
  create: ["tmux", "new-session", "-d", "-s", IB_COORDINATOR_SESSION, "-x", "80", "-y", "24"],
  send: ["tmux", "send-keys", "-t", target, "claude --model opus", "Enter"],
  kill: ["tmux", "kill-session", "-t", target],
  capture: ["tmux", "capture-pane", "-t", target, "-p", "-J", "-S", "-5000", "-E", "-"],
} satisfies Record<string, string[]>;

// Both contexts share the same preload baseline; reset after every test so a
// stray `.set()` can never bleed into the next one (mirrors what the real test
// suites do in their own afterEach hooks).
afterEach(() => {
  coordinatorSpawnCtx.reset();
  tmuxPollerSpawnCtx.reset();
});

describe("tmux safety backstop — reset baseline", () => {
  test("coordinatorSpawnCtx.reset() restores the safety stub, not Bun.spawn", () => {
    coordinatorSpawnCtx.set(((): any => { throw new Error("real spawn must never run"); }) as SpawnFn);
    coordinatorSpawnCtx.reset();
    expect(coordinatorSpawnCtx.runner).toBe(safeTestSpawnRunner);
    expect(coordinatorSpawnCtx.runner).not.toBe(Bun.spawn as unknown as SpawnFn);
  });

  test("tmux-poller spawnCtx.reset() restores the safety stub, not Bun.spawn", () => {
    tmuxPollerSpawnCtx.set(((): any => { throw new Error("real spawn must never run"); }) as SpawnFn);
    tmuxPollerSpawnCtx.reset();
    expect(tmuxPollerSpawnCtx.runner).toBe(safeTestSpawnRunner);
    expect(tmuxPollerSpawnCtx.runner).not.toBe(Bun.spawn as unknown as SpawnFn);
  });
});

describe("tmux safety backstop — dangerous fixed-session commands are inert no-ops", () => {
  for (const [role, cmd] of Object.entries(FIXED_SESSION_COMMANDS)) {
    test(`coordinatorSpawnCtx no-ops "${role}" against ${IB_COORDINATOR_SESSION}`, async () => {
      coordinatorSpawnCtx.reset();
      // The runner is our stub by identity, so this launches no subprocess...
      expect(coordinatorSpawnCtx.runner).toBe(safeTestSpawnRunner);
      // ...and .run() (which drains both streams and awaits exit) sees a
      // well-formed empty success.
      const { stdout, stderr, exitCode } = await coordinatorSpawnCtx.run(cmd);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    });

    test(`tmux-poller spawnCtx no-ops "${role}" against ${IB_COORDINATOR_SESSION}`, async () => {
      tmuxPollerSpawnCtx.reset();
      expect(tmuxPollerSpawnCtx.runner).toBe(safeTestSpawnRunner);
      const { stdout, stderr, exitCode } = await tmuxPollerSpawnCtx.run(cmd);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    });
  }

  test("the safe stub returns fresh, independently readable streams per call", async () => {
    tmuxPollerSpawnCtx.reset();
    const a = tmuxPollerSpawnCtx.runner(FIXED_SESSION_COMMANDS.capture, { stdout: "pipe", stderr: "pipe" });
    const b = tmuxPollerSpawnCtx.runner(FIXED_SESSION_COMMANDS.kill, { stdout: "pipe", stderr: "pipe" });
    // Draining one must not consume or lock the other's stream.
    expect(await new Response(a.stdout).text()).toBe("");
    expect(await new Response(b.stdout).text()).toBe("");
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
  });
});

describe("tmux safety backstop — real tmux-poller paths stay inert on the stub", () => {
  test("captureTmuxOutput(ib-coordinator) reads nothing and launches no tmux", async () => {
    tmuxPollerSpawnCtx.reset();
    // capture-pane funnels through spawnCtx; exit 0 + empty pane → "" (never null,
    // which would mean a real non-zero tmux exit), and no subprocess ran.
    expect(await captureTmuxOutput(IB_COORDINATOR_SESSION)).toBe("");
  });

  test("probeTmuxSession(ib-coordinator) resolves without a real has-session call", async () => {
    tmuxPollerSpawnCtx.reset();
    // has-session via the stub exits 0 → "live". The value is incidental; the
    // point is it resolves synchronously-fast with no tmux subprocess.
    expect((await probeTmuxSession(IB_COORDINATOR_SESSION)).status).toBe("live");
  });

  test("killTmuxSessionResult(ib-coordinator) resolves without a real kill-session call", async () => {
    tmuxPollerSpawnCtx.reset();
    const result = await killTmuxSessionResult(IB_COORDINATOR_SESSION);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

describe("tmux safety backstop — per-test mocks still override, reset returns to stub", () => {
  test("coordinatorSpawnCtx: .set(mock) intercepts, .reset() falls back to the stub", async () => {
    const calls: string[][] = [];
    const spy: SpawnFn = (cmd) => {
      calls.push(cmd);
      return { stdout: streamOf("mocked-out"), stderr: streamOf(""), exited: Promise.resolve(0) };
    };

    coordinatorSpawnCtx.set(spy);
    expect(coordinatorSpawnCtx.runner).toBe(spy);

    const first = await coordinatorSpawnCtx.run(FIXED_SESSION_COMMANDS.kill);
    expect(first.stdout).toBe("mocked-out");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(FIXED_SESSION_COMMANDS.kill);

    // Reset must drop the spy and restore the safety stub — the hazard being that
    // late async work after reset would otherwise reach the real spawner.
    coordinatorSpawnCtx.reset();
    expect(coordinatorSpawnCtx.runner).toBe(safeTestSpawnRunner);

    const second = await coordinatorSpawnCtx.run(FIXED_SESSION_COMMANDS.kill);
    expect(second.stdout).toBe(""); // served by the stub, not the spy
    expect(calls).toHaveLength(1); // spy never saw the post-reset call
  });

  test("tmux-poller spawnCtx: .set(mock) intercepts, .reset() falls back to the stub", async () => {
    const calls: string[][] = [];
    const spy: SpawnFn = (cmd) => {
      calls.push(cmd);
      return { stdout: streamOf("poller-mock"), stderr: streamOf(""), exited: Promise.resolve(0) };
    };

    tmuxPollerSpawnCtx.set(spy);
    expect(tmuxPollerSpawnCtx.runner).toBe(spy);

    const captured = await captureTmuxOutput(IB_COORDINATOR_SESSION);
    expect(captured).toBe("poller-mock");
    expect(calls).toHaveLength(1);

    tmuxPollerSpawnCtx.reset();
    expect(tmuxPollerSpawnCtx.runner).toBe(safeTestSpawnRunner);

    // Post-reset capture is served by the stub (empty), and the spy is untouched.
    expect(await captureTmuxOutput(IB_COORDINATOR_SESSION)).toBe("");
    expect(calls).toHaveLength(1);
  });
});
