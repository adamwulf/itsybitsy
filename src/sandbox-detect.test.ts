import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { isSandboxedProcess, setSandboxedProcessOverride } from "./sandbox-detect";
import { ALLOW_DEFAULT_PROFILE, SANDBOX_EXEC, assertSandboxExecApplies, liveSandboxProbes } from "./sandbox-live-probes";

const detectModule = join(import.meta.dir, "sandbox-detect.ts");
const probe = `const { isSandboxedProcess } = await import(${JSON.stringify(detectModule)}); console.log(isSandboxedProcess());`;

function runProbe(prefix: string[]): { exitCode: number; out: string } {
  const proc = Bun.spawnSync([...prefix, process.execPath, "-e", probe], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, out: proc.stdout.toString().trim() };
}

const liveTest = liveSandboxProbes("sandbox-exec can apply a profile on this host", assertSandboxExecApplies);

describe("isSandboxedProcess", () => {
  afterEach(() => setSandboxedProcessOverride(null));

  test("the override wins in both directions", () => {
    setSandboxedProcessOverride(() => true);
    expect(isSandboxedProcess()).toBe(true);
    setSandboxedProcessOverride(() => false);
    expect(isSandboxedProcess()).toBe(false);
  });

  test("always answers with a boolean, and false off macOS", () => {
    const answer = isSandboxedProcess();
    expect(typeof answer).toBe("boolean");
    if (process.platform !== "darwin") expect(answer).toBe(false);
  });

  // Holds inside and outside a sandbox: a child inherits its parent's.
  test("a new process gets the answer of the process that started it", () => {
    expect(runProbe([])).toEqual({ exitCode: 0, out: String(isSandboxedProcess()) });
  });

  // The real kernel check, against a real sandbox: this is the property the
  // spawn broker relies on (an agent cannot forge it, unlike an env var).
  liveTest("LIVE: the kernel check is false outside a sandbox and true inside one", () => {
    expect(runProbe([])).toEqual({ exitCode: 0, out: "false" });
    expect(runProbe([SANDBOX_EXEC, "-p", ALLOW_DEFAULT_PROFILE])).toEqual({ exitCode: 0, out: "true" });
  });
});
