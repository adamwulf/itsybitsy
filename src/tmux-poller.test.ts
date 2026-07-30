import { test, expect, describe, afterEach } from "bun:test";
import {
  TmuxPoller,
  captureTmuxOutput,
  captureTmuxOutputResult,
  probeTmuxSession,
  hasAttachedClient,
  spawnCtx,
  expandTabs,
} from "./tmux-poller";

function mockSpawn(stdout: string, exitCode: number, delay = 0, stderr = "") {
  spawnCtx.set((_cmd: string[], _opts?: any) => {
    const encoder = new TextEncoder();
    const stdoutStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stdout));
        controller.close();
      },
    });
    const stderrStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stderr));
        controller.close();
      },
    });
    return {
      stdout: stdoutStream,
      stderr: stderrStream,
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

  test("detailed capture preserves tmux stderr and exit code", async () => {
    mockSpawn("", 1, 0, "capture-pane temporarily unavailable");
    const result = await captureTmuxOutputResult("my-session");
    expect(result).toEqual({
      status: "error",
      error: "capture-pane temporarily unavailable",
      exitCode: 1,
    });
  });

  test("detailed capture preserves spawn exceptions", async () => {
    spawnCtx.set(() => { throw new Error("operation not permitted"); });
    const result = await captureTmuxOutputResult("my-session");
    expect(result).toEqual({
      status: "error",
      error: "operation not permitted",
      exitCode: null,
    });
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

  test("uses -J so tmux joins soft-wrapped continuation lines (logical lines)", async () => {
    let capturedCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });
    await captureTmuxOutput("sess", 50);
    // -J rejoins tmux-wrapped lines; state detection consumes UNWRAPPED logical
    // lines. Regression guard: removing -J reverts to physical-line captures.
    expect(capturedCmd).toContain("-J");
  });

  test("preserves program-emitted newlines from a -J capture (join correctness)", async () => {
    // Simulate a -J capture: tmux has already rejoined its own soft-wrapped
    // continuation lines into single logical lines, but program-emitted \n
    // between short lines are preserved. captureTmuxOutput must pass these
    // through verbatim (only stripping ANSI), so the newline structure the
    // state matchers see is exactly tmux's logical-line structure.
    const joined =
      "this is one very long logical line that tmux -J rejoined from several soft-wrapped physical rows into a single line\n" +
      "short line A\n" +
      "short line B\n";
    mockSpawn(joined, 0);
    const result = await captureTmuxOutput("sess", 50);
    expect(result).toBe(joined);
    // Three logical lines (+ trailing empty from the final \n).
    expect(result!.split("\n").filter((l) => l.length > 0)).toHaveLength(3);
  });
});

describe("probeTmuxSession", () => {
  test("returns live only for a successful exact-session probe", async () => {
    mockSpawn("", 0);
    expect(await probeTmuxSession("my-session")).toEqual({ status: "live" });
  });

  test("returns missing for tmux's affirmative missing-session response", async () => {
    mockSpawn("", 1, 0, "can't find session: my-session");
    expect(await probeTmuxSession("my-session")).toEqual({
      status: "missing",
      error: "can't find session: my-session",
    });
  });

  test("returns unknown for permission errors", async () => {
    mockSpawn("", 1, 0, "error connecting to /tmp/tmux/default (Permission denied)");
    expect(await probeTmuxSession("my-session")).toEqual({
      status: "unknown",
      error: "error connecting to /tmp/tmux/default (Permission denied)",
      exitCode: 1,
    });
  });

  test("returns unknown when the probe cannot spawn", async () => {
    spawnCtx.set(() => { throw new Error("posix_spawn tmux: EPERM"); });
    expect(await probeTmuxSession("my-session")).toEqual({
      status: "unknown",
      error: "posix_spawn tmux: EPERM",
      exitCode: null,
    });
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

  // Change E: window_width should be queried once on setAgent, not every tick
  test("setAgent triggers exactly one display-message (#{window_width}) call", async () => {
    let captureCalls = 0;
    let displayMessageCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      const isDisplayMessage = cmd.includes("display-message");
      const isCapture = cmd.includes("capture-pane");
      if (isCapture) captureCalls++;
      if (isDisplayMessage) displayMessageCalls++;
      const stdout = isDisplayMessage ? "120\n" : "pane content\n";
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(stdout));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    let widths: number[] = [];
    poller = new TmuxPoller({
      onOutput() {},
      onWidth(w) { widths.push(w); },
    });
    poller.start();
    poller.setAgent("session-A");
    // Allow the immediate poll + width query to complete
    await Bun.sleep(50);

    expect(captureCalls).toBe(1);
    expect(displayMessageCalls).toBe(1);
    expect(widths).toEqual([120]);
  });

  test("subsequent poll ticks for the same session do NOT call display-message", async () => {
    let captureCalls = 0;
    let displayMessageCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      const isDisplayMessage = cmd.includes("display-message");
      const isCapture = cmd.includes("capture-pane");
      if (isCapture) captureCalls++;
      if (isDisplayMessage) displayMessageCalls++;
      const stdout = isDisplayMessage ? "100\n" : "pane content\n";
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(stdout));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({
      onOutput() {},
      onWidth() {},
    });
    poller.start();
    poller.setAgent("session-A");
    // Wait long enough for at least 2 poll ticks (1s interval, immediate + 1)
    await Bun.sleep(1200);

    // Multiple captures should have happened, but display-message only once (from setAgent)
    expect(captureCalls).toBeGreaterThan(1);
    expect(displayMessageCalls).toBe(1);
  });

  test("setAgent with the same session does NOT re-trigger poll or width query", async () => {
    let captureCalls = 0;
    let displayMessageCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      const isDisplayMessage = cmd.includes("display-message");
      const isCapture = cmd.includes("capture-pane");
      if (isCapture) captureCalls++;
      if (isDisplayMessage) displayMessageCalls++;
      const stdout = isDisplayMessage ? "100\n" : "pane content\n";
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(stdout));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({
      onOutput() {},
      onWidth() {},
    });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);
    const capturesAfterFirst = captureCalls;
    expect(displayMessageCalls).toBe(1);

    // Calling setAgent with the same session should be a no-op (short-circuit)
    poller.setAgent("session-A");
    poller.setAgent("session-A");
    await Bun.sleep(50);

    expect(captureCalls).toBe(capturesAfterFirst);
    expect(displayMessageCalls).toBe(1);
  });

  test("switching agents triggers a fresh display-message call", async () => {
    let displayMessageCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      const isDisplayMessage = cmd.includes("display-message");
      if (isDisplayMessage) displayMessageCalls++;
      const stdout = isDisplayMessage ? "80\n" : "pane content\n";
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(stdout));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({
      onOutput() {},
      onWidth() {},
    });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);
    expect(displayMessageCalls).toBe(1);

    poller.setAgent("session-B");
    await Bun.sleep(50);
    expect(displayMessageCalls).toBe(2);
  });

  test("default capture uses the new 200-line cap", async () => {
    let capturedCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);

    expect(capturedCmd).toContain("-200");
    expect(capturedCmd).not.toContain("-5000");
  });

  test("display poll capture-pane includes -J (reflow logical lines ourselves)", async () => {
    let capturedCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) capturedCmd = cmd;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);

    // -J makes the poll return logical lines; the dashboard word-wraps them to
    // the pane width so the whole scrollback renders at one consistent width.
    expect(capturedCmd).toContain("-J");
  });

  test("setLines updates the next capture command's -S argument", async () => {
    let lastCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      lastCmd = cmd;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);
    expect(lastCmd).toContain("-200");

    poller.setLines(50);
    await Bun.sleep(50);
    expect(lastCmd).toContain("-50");

    poller.setLines(1234);
    await Bun.sleep(50);
    expect(lastCmd).toContain("-1234");
  });

  test("setLines triggers an immediate poll when value changes (no wait for tick)", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);
    const before = captureCalls;

    // Changing the value should trigger an immediate extra poll
    poller.setLines(500);
    await Bun.sleep(50);
    expect(captureCalls).toBe(before + 1);
  });

  test("setLines is a no-op when the value is unchanged", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);
    const before = captureCalls;

    poller.setLines(200); // same as default
    await Bun.sleep(50);
    expect(captureCalls).toBe(before);
  });

  test("setLines before start does not poll", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.setLines(100);
    await Bun.sleep(50);
    expect(captureCalls).toBe(0);
  });

  test("setAgent before start does not query width", async () => {
    let displayMessageCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("display-message")) displayMessageCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({
      onOutput() {},
      onWidth() {},
    });
    // setAgent without start — should not trigger width query
    poller.setAgent("session");
    await Bun.sleep(50);
    expect(displayMessageCalls).toBe(0);
  });

  // -----------------------------------------------------------------
  // isRunning / resume — pause/resume support for hidden panes
  // -----------------------------------------------------------------
  test("isRunning reflects start/stop state", () => {
    poller = new TmuxPoller({ onOutput() {} });
    expect(poller.isRunning()).toBe(false);
    poller.start();
    expect(poller.isRunning()).toBe(true);
    poller.stop();
    expect(poller.isRunning()).toBe(false);
  });

  test("stopped poller does NOT spawn capture-pane on tick", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);
    expect(captureCalls).toBeGreaterThan(0);

    poller.stop();
    const countAfterStop = captureCalls;
    // Wait past more than one interval — a stopped poller must not spawn.
    await Bun.sleep(1200);
    expect(captureCalls).toBe(countAfterStop);
  });

  test("resume() restarts polling and fires an immediate poll when a session is set", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data\n"));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);

    // Pause — simulates the pane going off-screen
    poller.stop();
    const countWhilePaused = captureCalls;
    await Bun.sleep(1100);
    expect(captureCalls).toBe(countWhilePaused);

    // Resume — should immediately poll (no waiting up to 1s for the next tick)
    expect(poller.isRunning()).toBe(false);
    poller.resume();
    expect(poller.isRunning()).toBe(true);
    await Bun.sleep(50);
    expect(captureCalls).toBe(countWhilePaused + 1);
  });

  test("resume() is a no-op when already running (no duplicate timer / poll)", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await Bun.sleep(50);
    const before = captureCalls;

    // resume() while already running must not fire an extra poll
    poller.resume();
    await Bun.sleep(50);
    expect(captureCalls).toBe(before);
  });

  test("resume() without a session set does not poll", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    // No setAgent — resume should start the timer but not poll a null session.
    poller.resume();
    expect(poller.isRunning()).toBe(true);
    await Bun.sleep(50);
    expect(captureCalls).toBe(0);
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

// -------------------------------------------------------------------
// expandTabs (tab → 3 spaces) helper + TmuxPoller boundary
// -------------------------------------------------------------------
describe("expandTabs", () => {
  test("replaces a single tab with 3 spaces", () => {
    expect(expandTabs("a\tb")).toBe("a   b");
  });

  test("replaces every tab in a multi-tab line", () => {
    expect(expandTabs("\tA\t\tB\t")).toBe("   A      B   ");
  });

  test("leaves tab-free strings untouched", () => {
    const s = "plain ascii line with no tabs";
    expect(expandTabs(s)).toBe(s);
  });

  test("preserves newlines and only expands tabs", () => {
    expect(expandTabs("line1\twith\ttab\nline2\twith\ttab")).toBe(
      "line1   with   tab\nline2   with   tab",
    );
  });
});

describe("TmuxPoller tab handling at the boundary", () => {
  let poller: TmuxPoller;

  afterEach(() => {
    poller?.stop();
  });

  // This is the regression guard for the ib watch crash: a future change
  // that removes expandTabs() from poll() will cause this test to fail
  // because the raw \t will reach onOutput verbatim.
  test("onOutput receives tab-expanded output (regression guard for ib watch crash)", async () => {
    // Simulate a codex agent editing a .pbxproj line containing literal
    // tabs — exactly the input that crashed the TUI.
    mockSpawn("C589242A207A\t\tC58B0000\t\t/* identifier */\n", 0);

    let receivedRaw: string | undefined;
    let receivedStripped: string | undefined;
    poller = new TmuxPoller({
      onOutput(raw, stripped) {
        receivedRaw = raw;
        receivedStripped = stripped;
      },
    });
    poller.start();
    poller.setAgent("tabby-session");
    await Bun.sleep(50);

    expect(receivedRaw).toBeDefined();
    expect(receivedStripped).toBeDefined();
    // Boundary invariant: no literal tab characters reach the consumer.
    expect(receivedRaw).not.toContain("\t");
    expect(receivedStripped).not.toContain("\t");
    // And the expanded content is what we expect.
    expect(receivedRaw).toBe(
      "C589242A207A      C58B0000      /* identifier */\n",
    );
  });

  test("tab-free output passes through onOutput unchanged", async () => {
    mockSpawn("plain output line\n", 0);
    let receivedRaw: string | undefined;
    poller = new TmuxPoller({
      onOutput(raw, _stripped) {
        receivedRaw = raw;
      },
    });
    poller.start();
    poller.setAgent("plain-session");
    await Bun.sleep(50);
    expect(receivedRaw).toBe("plain output line\n");
  });
});
