import { expect, test } from "bun:test";
import { sandboxStreamExited } from "./sandbox-log-watch";

test("stream liveness detects real signal termination despite a null exit code", async () => {
  const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    expect(sandboxStreamExited(child)).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGKILL");
    expect(sandboxStreamExited(child)).toBe(true);
  } finally {
    if (!sandboxStreamExited(child)) child.kill();
    await child.exited;
  }
});

test("stream liveness detects normal and failing exits", async () => {
  for (const code of [0, 17]) {
    const child = Bun.spawn(["/bin/sh", "-c", `exit ${code}`], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(child.exitCode).toBe(code);
    expect(sandboxStreamExited(child)).toBe(true);
  }
});
