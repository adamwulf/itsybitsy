import { test, expect, describe, afterEach } from "bun:test";
import { TmuxPoller, captureTmuxOutput, hasAttachedClient, spawnCtx } from "./tmux-poller";

function mockSpawn(stdout: string, exitCode: number, delay = 0) {
  spawnCtx.set((_cmd: string[], _opts?: any) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stdout));
        controller.close();
      },
    });
    return {
      stdout: stream,
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: delay > 0
        ? new Promise<number>((r) => setTimeout(() => r(exitCode), delay))
        : Promise.resolve(exitCode),
    };
  });
}

afterEach(() => {
  spawnCtx.reset();
});

// -------------------------------------------------------------------
// captureTmuxOutput
// -------------------------------------------------------------------
describe("captureTmuxOutput", () => {
  test("returns null when tmux session doesn't exist (non-zero exit)", async () => {
    mockSpawn("", 1);
    const result = await captureTmuxOutput("nonexistent-session");
    expect(result).toBeNull();
  });

  test("returns stripped string output on success", async () => {
    mockSpawn("Hello \x1b[31mworld\x1b[0m\n", 0);
    const result = await captureTmuxOutput("my-session");
    expect(result).toBe("Hello world\n");
  });

  test("returns null when spawn throws", async () => {
    spawnCtx.set(() => { throw new Error("spawn failed"); });
    const result = await captureTmuxOutput("my-session");
    expect(result).toBeNull();
  });

  test("passes lines parameter to tmux command", async () => {
    let capturedCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      capturedCmd = cmd;
      const stream = new ReadableStream({ start(c) { c.close(); } });
      return {
        stdout: stream,
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });
    await captureTmuxOutput("sess", 50);
    expect(capturedCmd).toContain("-50");
  });
});

// -------------------------------------------------------------------
// TmuxPoller
// -------------------------------------------------------------------
describe("TmuxPoller", () => {
  let poller: TmuxPoller;

  afterEach(() => {
    poller?.stop();
  });

  test("setAgent triggers immediate poll when running", async () => {
    mockSpawn("line1\nline2\n", 0);
    let outputCalled = false;
    poller = new TmuxPoller({
      onOutput(_raw, stripped) {
        outputCalled = true;
        expect(stripped).toBe("line1\nline2\n");
      },
    });
    poller.start();
    poller.setAgent("test-session");
    // Wait for the async poll to complete
    await Bun.sleep(50);
    expect(outputCalled).toBe(true);
  });

  test("setAgent(null) pauses polling — no output emitted", async () => {
    mockSpawn("data\n", 0);
    let callCount = 0;
    poller = new TmuxPoller({
      onOutput() { callCount++; },
    });
    poller.start();
    poller.setAgent(null);
    // Wait past one interval
    await Bun.sleep(1200);
    expect(callCount).toBe(0);
  });

  test("switching agents resets and triggers new poll", async () => {
    const outputs: string[] = [];
    mockSpawn("agent-A output\n", 0);
    poller = new TmuxPoller({
      onOutput(_raw, stripped) {
        outputs.push(stripped);
      },
    });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);

    mockSpawn("agent-B output\n", 0);
    poller.setAgent("session-B");
    await Bun.sleep(50);

    expect(outputs).toContain("agent-A output\n");
    expect(outputs).toContain("agent-B output\n");
  });

  test("race condition: stale output discarded when agent changes mid-poll", async () => {
    const outputs: string[] = [];
    // First spawn takes 200ms — simulates slow tmux
    mockSpawn("stale-output\n", 0, 200);

    poller = new TmuxPoller({
      onOutput(_raw, stripped) {
        outputs.push(stripped);
      },
    });
    poller.start();
    poller.setAgent("session-old");

    // Switch agent before the slow poll resolves
    await Bun.sleep(50);
    mockSpawn("fresh-output\n", 0);
    poller.setAgent("session-new");
    await Bun.sleep(300);

    // The stale "stale-output" should have been discarded
    expect(outputs).not.toContain("stale-output\n");
    expect(outputs).toContain("fresh-output\n");
  });

  test("onOutput called with empty strings when tmux exits non-zero (session not found)", async () => {
    mockSpawn("", 1);
    let receivedRaw: string | undefined;
    let receivedStripped: string | undefined;
    poller = new TmuxPoller({
      onOutput(raw, stripped) {
        receivedRaw = raw;
        receivedStripped = stripped;
      },
    });
    poller.start();
    poller.setAgent("dead-session");
    await Bun.sleep(50);
    expect(receivedRaw).toBe("");
    expect(receivedStripped).toBe("");
  });

  test("onError called when spawn throws", async () => {
    spawnCtx.set(() => { throw new Error("tmux not found"); });
    let errorMsg: string | undefined;
    poller = new TmuxPoller({
      onOutput() {},
      onError(err) { errorMsg = err.message; },
    });
    poller.start();
    poller.setAgent("any-session");
    await Bun.sleep(50);
    expect(errorMsg).toBe("tmux not found");
  });

  test("stop prevents further polling", async () => {
    mockSpawn("data\n", 0);
    let callCount = 0;
    poller = new TmuxPoller({
      onOutput() { callCount++; },
    });
    poller.start();
    poller.setAgent("session");
    await Bun.sleep(50);
    const countAfterFirst = callCount;
    poller.stop();
    await Bun.sleep(1200);
    expect(callCount).toBe(countAfterFirst);
  });

  test("setAgent before start does not poll", async () => {
    mockSpawn("data\n", 0);
    let callCount = 0;
    poller = new TmuxPoller({
      onOutput() { callCount++; },
    });
    // setAgent without start — should not trigger poll
    poller.setAgent("session");
    await Bun.sleep(50);
    expect(callCount).toBe(0);
  });
});

// -------------------------------------------------------------------
// hasAttachedClient
// -------------------------------------------------------------------
describe("hasAttachedClient", () => {
  test("returns true when clients are attached", async () => {
    mockSpawn("/dev/ttys001\n/dev/ttys002\n", 0);
    const result = await hasAttachedClient("my-session");
    expect(result).toBe(true);
  });

  test("returns false when no clients attached (empty output)", async () => {
    mockSpawn("", 0);
    const result = await hasAttachedClient("my-session");
    expect(result).toBe(false);
  });

  test("returns false when tmux exits non-zero (session not found)", async () => {
    mockSpawn("", 1);
    const result = await hasAttachedClient("nonexistent-session");
    expect(result).toBe(false);
  });

  test("returns false when spawn throws", async () => {
    spawnCtx.set(() => { throw new Error("tmux not found"); });
    const result = await hasAttachedClient("my-session");
    expect(result).toBe(false);
  });
});
