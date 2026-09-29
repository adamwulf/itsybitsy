import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { isSandboxedProcess, setSandboxedProcessOverride } from "./sandbox-detect";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const detectModule = join(import.meta.dir, "sandbox-detect.ts");
const probe = `const { isSandboxedProcess } = await import(${JSON.stringify(detectModule)}); console.log(isSandboxedProcess());`;

function runProbe(prefix: string[]): { exitCode: number; out: string } {
  const proc = Bun.spawnSync([...prefix, process.execPath, "-e", probe], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, out: proc.stdout.toString().trim() };
}

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

  // The real kernel check, against a real sandbox: this is the property the
  // spawn broker relies on (an agent cannot forge it, unlike an env var).
  test.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))(
    "the kernel check is false outside a sandbox and true inside one",
    () => {
      expect(runProbe([])).toEqual({ exitCode: 0, out: "false" });
      const inside = runProbe([SANDBOX_EXEC, "-p", "(version 1)(allow default)"]);
      // Applying a sandbox fails when this suite already runs inside one
      // (`sandbox_apply: Operation not permitted`); nothing to assert then.
      if (inside.exitCode !== 0) return;
      expect(inside.out).toBe("true");
    },
  );
});
