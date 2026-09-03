/**
 * Global `bun test` preload (wired in via bunfig.toml `[test].preload`).
 *
 * Two safety jobs, both for the WHOLE test run and both impossible to forget in
 * an individual test:
 *
 *  1. Redirect the ib-watch diagnostic log away from the developer's real
 *     ~/.itsybitsy/watch.log. logToWatchLog is reached transitively by many code
 *     paths under test (orphan reaping, coordinator refcount pruning, lifecycle
 *     teardown), and any of them writing to the live log pollutes it. watch-log.ts
 *     reads IB_WATCH_LOG_PATH as its default path, so setting the env here —
 *     before any module loads — makes both the default and whatever
 *     resetWatchLogPath() restores to point at a throwaway temp file.
 *
 *     The temp path deliberately ends in `.itsybitsy/watch.log` so watch-log's own
 *     "reset restores the default" assertion (which matches /\.itsybitsy\/watch\.log$/)
 *     still holds. Individual tests that call setWatchLogPath() to a per-test temp
 *     file continue to work unchanged.
 *
 *  2. Neuter the two spawn contexts that drive the developer's fixed-name
 *     `ib-coordinator` tmux session — see the tmux safety backstop below.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SpawnFn, SpawnResult } from "./src/types";

// The watch-log redirect MUST run before any module that reads IB_WATCH_LOG_PATH
// at import time, so it stays first and the coordinator / tmux-poller imports
// below are deferred to dynamic import()s after it.
if (!process.env.IB_WATCH_LOG_PATH) {
  const base = mkdtempSync(join(tmpdir(), "ib-test-home-"));
  process.env.IB_WATCH_LOG_PATH = join(base, ".itsybitsy", "watch.log");
}

// ---------------------------------------------------------------------------
// tmux safety backstop
// ---------------------------------------------------------------------------
//
// The coordinator (src/coordinator.ts) and the tmux poller (src/tmux-poller.ts)
// both talk to ONE fixed, shared tmux session — `ib-coordinator` — on the
// developer's ONE default tmux server. That session is the live coordinator the
// developer is actually using while `ib watch` runs. Unlike per-agent sessions
// (whose names carry a random agent id and live only inside a test's temp home),
// this name is a hard-coded constant, so a stray call from a test hits the real
// thing every time.
//
// The dangerous command classes both contexts can emit against that fixed
// session, and why each is unsafe against a shared server/session:
//
//   • tmux new-session ... -s ib-coordinator  — would spawn a real coordinator
//        Claude process attached to the developer's session (or collide with the
//        one already there).
//   • tmux send-keys    ... -t =ib-coordinator:  — would type keystrokes / an
//        `Enter` into whatever the developer's coordinator is doing right now.
//   • tmux kill-session ... -t =ib-coordinator:  — would tear down the developer's
//        live coordinator mid-session, dropping its refcount and transcript.
//   • tmux capture-pane ... -t =ib-coordinator:  — would read the developer's live
//        pane; harmless on its own, but it proves a real tmux subprocess launched
//        where none should.
//
// A per-test `.set(mock)` normally intercepts these, but two gaps remain that no
// individual test can close: a test that forgets to stub, and — the real hazard
// (dashboard/coordinator tests especially) — async work (a poll tick, a pending
// coordinator step) that is still draining AFTER the test called `.reset()`.
// Before this backstop, `.reset()` restored the production default, which is the
// live `Bun.spawn`, so that late work launched a real `tmux ...` against
// `ib-coordinator`.
//
// The fix installs a safe no-op runner as the RESET BASELINE of both contexts
// via SpawnContext.setDefault() (see src/types.ts). It returns a well-formed but
// empty SpawnResult — closed stdout/stderr streams and exit code 0 — and never
// calls Bun.spawn, so no subprocess is ever launched. After this, `.reset()`
// lands on the stub, not on `Bun.spawn`, while any per-test `.set(mock)` still
// overrides it exactly as before. This is wired through the bunfig preload (not
// NODE_ENV) so it is structurally in force for every `bun test` invocation.

/** Fresh, already-closed empty stream so each caller gets its own reader. */
function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

/**
 * Safe replacement for `Bun.spawn` during tests. Returns a well-formed
 * SpawnResult with empty stdout/stderr and a success exit code, and launches no
 * subprocess. Exported so the regression test (src/test-isolation.test.ts) can
 * assert, by identity, that a context's `.reset()` restored THIS runner rather
 * than the real spawner.
 */
export const safeTestSpawnRunner: SpawnFn = (): SpawnResult => ({
  stdout: closedStream(),
  stderr: closedStream(),
  exited: Promise.resolve(0),
  kill: () => {},
});

// Deferred to dynamic import so the IB_WATCH_LOG_PATH redirect above runs first.
// Importing these modules only constructs the SpawnContext singletons (no spawn
// happens at module load), then we replace their reset baseline with the stub.
const { coordinatorSpawnCtx } = await import("./src/coordinator");
const { spawnCtx: tmuxPollerSpawnCtx } = await import("./src/tmux-poller");
coordinatorSpawnCtx.setDefault(safeTestSpawnRunner);
tmuxPollerSpawnCtx.setDefault(safeTestSpawnRunner);
