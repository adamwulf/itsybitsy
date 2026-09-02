/**
 * `agy --version` probe (SPEC-ANTIGRAVITY-CLI.md §6 Risk 1; Phase 2 live bug).
 *
 * The version string is stamped into `meta.agy_version` at spawn so a fixture /
 * behaviour drift is dated. Best effort — a missing or broken `agy` must NEVER
 * block the spawn.
 *
 * The live bug this module fixes: agy 1.1.23 (per its own release notes) blocks
 * forever when it inherits an unclosed stdin pipe. The old probe ran through the
 * generic spawn-ctx runner, which leaves the child's stdin open and then `await`s
 * `proc.exited` unconditionally — so `agy --version` hung and the whole spawn
 * hung with it. The fix is two-fold and belt-and-suspenders:
 *   1. spawn with stdin explicitly `"ignore"` so agy can't block on it, and
 *   2. race a hard timeout so even an unexpected wedge (a different agy build, a
 *      Gatekeeper stall — see Risk 10) can't hang the spawn: on timeout the
 *      child is killed and the version is stamped "".
 */

import type { SpawnFn } from "./types";

/** Hard timeout for the `agy --version` probe. The spawn must never block on it. */
export const AGY_VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe `agy --version`, returning the trimmed stdout on success or "" on ANY
 * failure (spawn throw, non-zero exit, stream error, or timeout). Never blocks
 * the caller longer than `timeoutMs`.
 *
 * `run` is the injectable spawn function (the newAgent spawn-ctx runner) so
 * tests can supply a runner whose child never resolves and assert the probe
 * still returns "" within the timeout.
 */
export async function probeAgyVersion(
  run: SpawnFn,
  timeoutMs: number = AGY_VERSION_PROBE_TIMEOUT_MS,
): Promise<string> {
  let proc;
  try {
    // stdin: "ignore" — the crux of the fix. Without a closed stdin agy 1.1.23
    // blocks forever waiting on the inherited pipe.
    proc = run(["agy", "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch {
    return "";
  }

  // Drain stdout + await exit. Wrapped so a rejection (e.g. the stream closing
  // when we kill the child on timeout) resolves to null rather than surfacing as
  // an unhandled rejection after the race has already moved on.
  const probe: Promise<{ stdout: string; exitCode: number } | null> = (async () => {
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  })().catch(() => null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const result = await Promise.race([probe, timeout]);
    if (result === null) {
      // Timed out (or the probe errored) — kill the child so it can't linger and
      // give up on the version string.
      try { proc.kill?.(); } catch { /* best-effort */ }
      return "";
    }
    return result.exitCode === 0 ? result.stdout.trim() : "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
