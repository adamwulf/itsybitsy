import { test, expect, describe } from "bun:test";
import { runCodexDispatcher } from "./codex-dispatcher";

function captureWrite(): { writes: string[]; write: (chunk: string) => boolean } {
  const writes: string[] = [];
  return { writes, write: (chunk: string) => { writes.push(chunk); return true; } };
}

describe("runCodexDispatcher — HIGH 1 fail-open contract", () => {
  test("missing agent-id: pre-tool-use emits valid PreToolUse deny + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("pre-tool-use", undefined, { deps: { write } });
    expect(res.exitCode).toBe(0);
    expect(writes.length).toBe(1);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("missing agent-id");
  });

  test("invalid agent-id: pre-tool-use emits valid PreToolUse deny + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("pre-tool-use", "bad id with spaces", {
      deps: { write },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("invalid agent-id");
  });

  test("missing agent-id: session-start emits valid SessionStart noop + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("session-start", undefined, { deps: { write } });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("invalid agent-id: stop emits valid Stop noop + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("stop", "/etc/passwd", { deps: { write } });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  });

  test("handler module fails to import (synthetic): pre-tool-use emits deny + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("pre-tool-use", "agent-okzz", {
      deps: {
        write,
        invokeHandler: () => Promise.reject(new Error("ENOENT: handler module missing")),
      },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("dispatcher load failed");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("ENOENT");
  });

  test("handler module fails to import: session-start emits valid noop + exit 0 (codex doesn't deny session starts)", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("session-start", "agent-okzz", {
      deps: {
        write,
        invokeHandler: () => Promise.reject(new Error("import failed")),
      },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("handler module fails to import: stop emits valid noop + exit 0", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("stop", "agent-okzz", {
      deps: {
        write,
        invokeHandler: () => Promise.reject(new Error("kaboom")),
      },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  });

  test("happy-path handler success: no extra write, exit 0", async () => {
    // The handler itself owns the response payload; the dispatcher must not
    // double-write when the handler succeeded.
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("pre-tool-use", "agent-okzz", {
      deps: {
        write,
        invokeHandler: () => Promise.resolve(),
      },
    });
    expect(res.exitCode).toBe(0);
    expect(writes.length).toBe(0);
  });

  test("--dry-run failure: exit code 1 (signals spawn-time caller to abort)", async () => {
    // dry-run is consumed by the spawn caller, not codex, so failure → exit 1.
    // This test asserts the contract — actual stderr output is swallowed by
    // the harness here, but the exit code is the load-bearing signal.
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("pre-tool-use", "agent-okzz", {
      dryRun: true,
      deps: {
        write,
        invokeDryRun: () => Promise.reject(new Error("meta.json missing")),
      },
    });
    expect(res.exitCode).toBe(1);
    expect(writes.length).toBe(0); // no stdout payload in dry-run mode
  });

  test("--dry-run success: exit 0, no stdout payload", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("session-start", "agent-okzz", {
      dryRun: true,
      deps: {
        write,
        invokeDryRun: () => Promise.resolve(),
      },
    });
    expect(res.exitCode).toBe(0);
    expect(writes.length).toBe(0);
  });

  // HIGH 3 from Phase 4 review — simulate a handler that throws when invoked
  // with the synthetic payload (the load-bearing case the old "meta exists?"
  // check missed). The dispatcher must still surface exit 1 so the spawn
  // refuses to launch into a fail-open hook.
  test("--dry-run failure: handler module loads but throws at invoke → exit 1", async () => {
    const { writes, write } = captureWrite();
    const res = await runCodexDispatcher("stop", "agent-okzz", {
      dryRun: true,
      deps: {
        write,
        invokeDryRun: () => Promise.reject(new Error("runtime crash in handler")),
      },
    });
    expect(res.exitCode).toBe(1);
    expect(writes.length).toBe(0);
  });
});
