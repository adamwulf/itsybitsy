/** Test-only: the opt-in for probes of real kernel facts (the boot identity,
 * process ancestry, `sandbox_check`, nested sandboxes). The default suite must
 * not touch them, because it also has to pass inside a sandbox. On a macOS host
 * outside any sandbox:
 *
 *   IB_LIVE_SANDBOX=1 bun test src/sandbox-detect.test.ts src/sandbox-collector.test.ts --test-name-pattern LIVE
 *
 * Without the variable the probes are reported as skipped and their prerequisite
 * is not checked. With it, each file's prerequisite is its own `LIVE capability:`
 * row. A host that lacks it fails that row, with CAPABILITY UNAVAILABLE, and skips
 * the probes: the run did not verify anything, and no product assertion failed.
 * A host that has it runs the probes, and nothing suppresses their assertions.
 * Only test files read the variable; nothing in production does.
 */
import { test } from "bun:test";
import { existsSync } from "node:fs";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const ALLOW_DEFAULT_PROFILE = "(version 1)(allow default)";

export type LiveCapability = { state: "off" } | { state: "unavailable"; reason: string } | { state: "available" };

export function resolveLiveCapability(optIn: string | undefined, check: () => void): LiveCapability {
  if (optIn !== "1") return { state: "off" };
  try {
    check();
    return { state: "available" };
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The `test` for probes that need `check` to pass. Call it once per file, while
 * the file is collected; `check` throws the reason the capability is missing. */
export function liveSandboxProbes(capability: string, check: () => void) {
  const resolved = resolveLiveCapability(process.env.IB_LIVE_SANDBOX, check);
  if (resolved.state === "off") return test.skip;
  test(`LIVE capability: ${capability}`, () => {
    if (resolved.state === "unavailable") throw new Error(`CAPABILITY UNAVAILABLE, no probe ran: ${resolved.reason}`);
  });
  return resolved.state === "available" ? test : test.skip;
}

/** Throws unless this host can apply a profile: macOS, and not already sandboxed
 * (a nested apply fails with `sandbox_apply: Operation not permitted`). */
export function assertSandboxExecApplies(): void {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) throw new Error(`${SANDBOX_EXEC} is absent; macOS only`);
  const applied = Bun.spawnSync([SANDBOX_EXEC, "-p", ALLOW_DEFAULT_PROFILE, "/usr/bin/true"], { stdout: "ignore", stderr: "pipe" });
  if (applied.exitCode !== 0) {
    throw new Error(`${SANDBOX_EXEC} cannot apply a profile here (exit ${applied.exitCode}): ${applied.stderr.toString().trim()}`);
  }
}
