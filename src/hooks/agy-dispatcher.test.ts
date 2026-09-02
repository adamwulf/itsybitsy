import { test, expect, describe } from "bun:test";
import { runAgyDispatcher } from "./agy-dispatcher";

function captureWrite(): { writes: string[]; write: (chunk: string) => boolean } {
  const writes: string[] = [];
  return { writes, write: (chunk: string) => { writes.push(chunk); return true; } };
}

describe("runAgyDispatcher — fail-closed contract", () => {
  test("missing agent-id: pre-tool-use emits a valid deny + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-tool-use", undefined, { deps: { write } });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("missing agent-id");
  });

  test("invalid agent-id: pre-tool-use emits a valid deny + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-tool-use", "bad id with spaces", { deps: { write } });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("invalid agent-id");
  });

  test("missing agent-id: pre-invocation emits {} + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-invocation", undefined, { deps: { write } });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(writes[0]!)).toEqual({});
  });

  test("invalid agent-id: stop emits {} + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("stop", "/etc/passwd", { deps: { write } });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(writes[0]!)).toEqual({});
  });

  test("handler import failure: pre-tool-use emits a deny naming the failure + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-tool-use", "agent-okzz", {
      deps: { write, invokeHandler: () => Promise.reject(new Error("ENOENT: handler module missing")) },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("dispatcher load failed");
    expect(parsed.reason).toContain("ENOENT");
  });

  test("handler import failure: pre-invocation still emits {} + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-invocation", "agent-okzz", {
      deps: { write, invokeHandler: () => Promise.reject(new Error("boom")) },
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(writes[0]!)).toEqual({});
  });

  test("handler import failure: stop still emits {} + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("stop", "agent-okzz", {
      deps: { write, invokeHandler: () => Promise.reject(new Error("kaboom")) },
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(writes[0]!)).toEqual({});
  });

  test("happy-path handler success: no extra write, exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-tool-use", "agent-okzz", {
      deps: { write, invokeHandler: () => Promise.resolve() },
    });
    expect(res.exitCode).toBe(0);
    expect(writes.length).toBe(0);
  });

  test("--dry-run failure: exit code 1, no stdout payload", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-tool-use", "agent-okzz", {
      dryRun: true,
      deps: { write, invokeDryRun: () => Promise.reject(new Error("meta.json missing")) },
    });
    expect(res.exitCode).toBe(1);
    expect(writes.length).toBe(0);
  });

  test("--dry-run success: exit 0, no stdout payload", async () => {
    const { writes, write } = captureWrite();
    const res = await runAgyDispatcher("pre-invocation", "agent-okzz", {
      dryRun: true,
      deps: { write, invokeDryRun: () => Promise.resolve() },
    });
    expect(res.exitCode).toBe(0);
    expect(writes.length).toBe(0);
  });
});
