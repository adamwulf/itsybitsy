import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  TmuxPoller,
  captureTmuxOutput,
  captureTmuxOutputResult,
  probeTmuxSession,
  probeTmuxPane,
  killTmuxSessionResult,
  hasAttachedClient,
  spawnCtx,
  expandTabs,
} from "./tmux-poller";
import { waitFor } from "./test-utils";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.close(); } });
}

// `delay` and `stderr` exist for the probe/capture-result tests, which assert on
// tmux's stderr text and exit code. The TmuxPoller tests below pass neither: they
// drive the poller's clock by hand (see installManualClock), so they have no use
// for a timed exit. `delay` still runs on a real setTimeout — the manual clock
// swaps setInterval only — so both styles coexist in one file.
function mockSpawn(stdout: string, exitCode: number, delay = 0, stderr = "") {
  spawnCtx.set((_cmd: string[], _opts?: any) => ({
    stdout: streamOf(stdout),
    stderr: streamOf(stderr),
    exited: delay > 0
      ? new Promise<number>((r) => setTimeout(() => r(exitCode), delay))
      : Promise.resolve(exitCode),
  }));
}

/**
 * Hands the poller's interval timer to the test for the duration of one test.
 *
 * TmuxPoller.start() arms a 1s setInterval, so every count assertion in this
 * file used to race that timer. `Bun.sleep(50); expect(calls).toBe(n)` can fail
 * in BOTH directions — too slow and the in-flight poll hasn't landed yet (n-1),
 * slow enough that a real tick fires and there is an extra poll (n+1) — and
 * neither outcome says anything about the behaviour under test.
 *
 * Swapping setInterval/clearInterval means no tick EVER fires unless the test
 * fires one, so counts are exact by construction, and a test that WANTS a tick
 * gets it instantly instead of sleeping 1.1s for one. This stubs nothing inside
 * the poller: `tick()` invokes the very callback start() registered, which is
 * the same code a real timer would run. It also makes two properties directly
 * observable that the old sleeps could only infer — whether stop() actually
 * cleared the interval, and whether a second interval got armed.
 */
interface ManualClock {
  /** Fire the poller's interval callback once — exactly what a 1s tick does. */
  tick(): void;
  /** How many intervals are currently armed (start() arms one, stop() clears it). */
  readonly armedTimers: number;
  restore(): void;
}

function installManualClock(): ManualClock {
  // Typed view of the two globals we swap; avoids `any` and the read-only
  // complaint from assigning to a `declare function` global.
  const g = globalThis as unknown as {
    setInterval: (fn: () => void, ms?: number) => unknown;
    clearInterval: (handle?: unknown) => void;
  };
  const realSetInterval = g.setInterval;
  const realClearInterval = g.clearInterval;
  const armed = new Set<object>();
  let callback: (() => void) | null = null;

  g.setInterval = (fn: () => void) => {
    callback = fn;
    const handle = {};
    armed.add(handle);
    return handle;
  };
  g.clearInterval = (handle?: unknown) => {
    if (typeof handle === "object" && handle !== null && armed.has(handle)) {
      armed.delete(handle);
      return;
    }
    // Not one of ours (e.g. a timer some other code armed before we swapped in).
    realClearInterval(handle);
  };

  return {
    tick() {
      if (!callback) throw new Error("manual clock: no interval armed — did start() run?");
      callback();
    },
    get armedTimers() { return armed.size; },
    restore() {
      g.setInterval = realSetInterval;
      g.clearInterval = realClearInterval;
    },
  };
}

/**
 * A short fixed sleep used ONLY before a NEGATIVE assertion ("no poll
 * happened"). There is nothing to wait for when the code is correct, so this is
 * not synchronisation — it exists so that a poll which should not have started
 * has time to reach its callback and be caught. Lengthening it would not make
 * any passing test more reliable; it would only slow the suite down.
 */
function giveASpuriousPollAChance(): Promise<void> {
  return Bun.sleep(25);
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
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
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
        stdout: emptyStream(),
        stderr: emptyStream(),
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

  test("returns unknown when the tmux server is unavailable", async () => {
    mockSpawn("", 1, 0, "no server running on /tmp/tmux-501/default");
    expect(await probeTmuxSession("my-session")).toEqual({
      status: "unknown",
      error: "no server running on /tmp/tmux-501/default",
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

describe("probeTmuxPane", () => {
  test("queries every window in the exact session", async () => {
    let capturedCmd: string[] = [];
    spawnCtx.set((cmd: string[]) => {
      capturedCmd = cmd;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("0\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
      };
    });

    await probeTmuxPane("my-session");

    expect(capturedCmd).toContain("-s");
    expect(capturedCmd).toContain("=my-session:");
  });

  test("returns live from authoritative pane metadata", async () => {
    mockSpawn("0\n", 0);
    expect(await probeTmuxPane("my-session")).toEqual({ status: "live" });
  });

  test("returns dead only when every pane is dead", async () => {
    mockSpawn("1\n1\n", 0);
    expect(await probeTmuxPane("my-session")).toEqual({ status: "dead" });
  });

  test("returns live when any pane remains live", async () => {
    mockSpawn("1\n0\n", 0);
    expect(await probeTmuxPane("my-session")).toEqual({ status: "live" });
  });

  test("returns unknown for unavailable or malformed metadata", async () => {
    mockSpawn("", 1, 0, "permission denied");
    expect(await probeTmuxPane("my-session")).toEqual({
      status: "unknown",
      error: "permission denied",
      exitCode: 1,
    });

    mockSpawn("Pane is dead\n", 0);
    const malformed = await probeTmuxPane("my-session");
    expect(malformed.status).toBe("unknown");
  });
});

describe("killTmuxSessionResult", () => {
  test("preserves stderr and exit code for failed teardown", async () => {
    mockSpawn("", 1, 0, "session is attached");
    expect(await killTmuxSessionResult("my-session")).toEqual({
      ok: false,
      error: "session is attached",
      exitCode: 1,
    });
  });

  test("preserves spawn exceptions", async () => {
    spawnCtx.set(() => { throw new Error("spawn denied"); });
    expect(await killTmuxSessionResult("my-session")).toEqual({
      ok: false,
      error: "spawn denied",
      exitCode: null,
    });
  });
});

// -------------------------------------------------------------------
// TmuxPoller
// -------------------------------------------------------------------
describe("TmuxPoller", () => {
  let poller: TmuxPoller;
  let clock: ManualClock;

  beforeEach(() => {
    clock = installManualClock();
  });

  afterEach(() => {
    // Order matters: stop() while the fake clearInterval is still installed, so
    // the poller's handle is retired by the same clock that issued it.
    poller?.stop();
    clock.restore();
  });

  test("setAgent triggers immediate poll when running", async () => {
    mockSpawn("line1\nline2\n", 0);
    let stripped: string | undefined;
    poller = new TmuxPoller({
      onOutput(_raw, s) { stripped = s; },
    });
    poller.start();
    poller.setAgent("test-session");
    // Wait for the poll's output to arrive rather than guessing how long the
    // async capture takes, and assert on the same value we waited for.
    await waitFor(() => stripped !== undefined, { message: "onOutput from setAgent's immediate poll" });
    expect(stripped).toBe("line1\nline2\n");
  });

  test("setAgent(null) pauses polling — no output emitted", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return { stdout: streamOf("data\n"), stderr: emptyStream(), exited: Promise.resolve(0) };
    });
    let callCount = 0;
    poller = new TmuxPoller({
      onOutput() { callCount++; },
    });
    poller.start();
    poller.setAgent(null);

    // Three tick opportunities instead of the single one a 1.2s sleep bought,
    // and instantly: a tick on a null session must not spawn anything.
    clock.tick();
    clock.tick();
    clock.tick();
    await giveASpuriousPollAChance();

    expect(captureCalls).toBe(0);
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
    await waitFor(() => outputs.includes("agent-A output\n"), { message: "output from session-A" });

    mockSpawn("agent-B output\n", 0);
    poller.setAgent("session-B");
    await waitFor(() => outputs.includes("agent-B output\n"), { message: "output from session-B" });

    expect(outputs).toContain("agent-A output\n");
    expect(outputs).toContain("agent-B output\n");
  });

  test("race condition: stale output discarded when agent changes mid-poll", async () => {
    const outputs: string[] = [];
    // The first poll's tmux exit is released by hand, so the agent switch below
    // is GUARANTEED to land while that poll is still in flight — rather than
    // hoping a 50ms sleep falls inside a 200ms window on a loaded machine.
    let releaseStale!: () => void;
    const stalePending = new Promise<void>((resolve) => { releaseStale = resolve; });
    let staleSettled = false;
    spawnCtx.set((_cmd: string[], _opts?: any) => ({
      stdout: streamOf("stale-output\n"),
      stderr: emptyStream(),
      exited: stalePending.then(() => { staleSettled = true; return 0; }),
    }));

    poller = new TmuxPoller({
      onOutput(_raw, stripped) {
        outputs.push(stripped);
      },
    });
    poller.start();
    poller.setAgent("session-old");

    // Switch agents while the first poll is blocked on its exit.
    mockSpawn("fresh-output\n", 0);
    poller.setAgent("session-new");
    await waitFor(() => outputs.includes("fresh-output\n"), { message: "output from the new session" });

    // Now give the stale poll a full chance to deliver: let its exit settle,
    // then drive one more poll all the way to its callback. Anything the stale
    // poll was going to emit would have been emitted before that later output.
    releaseStale();
    await waitFor(() => staleSettled, { message: "the stale poll's tmux exit to settle" });
    clock.tick();
    await waitFor(
      () => outputs.filter((o) => o === "fresh-output\n").length >= 2,
      { message: "a later poll to complete after the stale one settled" },
    );

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
    await waitFor(() => receivedRaw !== undefined, { message: "onOutput for a dead session" });
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
    await waitFor(() => errorMsg !== undefined, { message: "onError from the throwing spawn" });
    expect(errorMsg).toBe("tmux not found");
  });

  test("stop prevents further polling", async () => {
    let captureCalls = 0;
    let callCount = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return { stdout: streamOf("data\n"), stderr: emptyStream(), exited: Promise.resolve(0) };
    });
    poller = new TmuxPoller({
      onOutput() { callCount++; },
    });
    poller.start();
    poller.setAgent("session");
    await waitFor(() => callCount > 0, { message: "the first poll's output" });
    const countAfterFirst = callCount;
    const capturesAfterFirst = captureCalls;

    poller.stop();
    // What the old 1.2s sleep could only infer, asserted directly: stop()
    // really did clear the interval it armed, so no further tick exists.
    expect(clock.armedTimers).toBe(0);
    // And even if a tick were already in flight, the callback must be inert.
    clock.tick();
    await giveASpuriousPollAChance();

    expect(captureCalls).toBe(capturesAfterFirst);
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
    await giveASpuriousPollAChance();
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
        stdout: streamOf(stdout),
        stderr: emptyStream(),
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
    // The width query is the last thing setAgent starts, so its callback
    // firing means the poll it also started has already been counted. No tick
    // can fire behind our back, so these counts are exact rather than "exact
    // as long as the sleep landed inside the 1s interval".
    await waitFor(() => widths.length > 0, { message: "onWidth from setAgent's width query" });

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
        stdout: streamOf(stdout),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({
      onOutput() {},
      onWidth() {},
    });
    poller.start();
    poller.setAgent("session-A");
    // Two ticks on top of setAgent's immediate poll — the same thing the old
    // 1.2s sleep was buying (one tick), only more of it and instantly.
    clock.tick();
    clock.tick();
    await waitFor(() => captureCalls >= 3, { message: "captures from setAgent plus two ticks" });

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
        stdout: streamOf(stdout),
        stderr: emptyStream(),
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
    await waitFor(() => widths.length > 0, { message: "onWidth from the first setAgent" });
    const capturesAfterFirst = captureCalls;
    expect(displayMessageCalls).toBe(1);

    // Calling setAgent with the same session should be a no-op (short-circuit)
    poller.setAgent("session-A");
    poller.setAgent("session-A");
    await giveASpuriousPollAChance();

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
        stdout: streamOf(stdout),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({
      onOutput() {},
      onWidth() {},
    });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => displayMessageCalls === 1, { message: "the width query for session-A" });
    expect(displayMessageCalls).toBe(1);

    poller.setAgent("session-B");
    await waitFor(() => displayMessageCalls === 2, { message: "the width query for session-B" });
    expect(displayMessageCalls).toBe(2);
  });

  test("default capture uses the new 200-line cap", async () => {
    let capturedCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      capturedCmd = cmd;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => capturedCmd.length > 0, { message: "a capture-pane command to be recorded" });

    expect(capturedCmd).toContain("-200");
    expect(capturedCmd).not.toContain("-5000");
  });

  test("display poll capture-pane includes -J (reflow logical lines ourselves)", async () => {
    let capturedCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) capturedCmd = cmd;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => capturedCmd.length > 0, { message: "a capture-pane command to be recorded" });

    // -J makes the poll return logical lines; the dashboard word-wraps them to
    // the pane width so the whole scrollback renders at one consistent width.
    expect(capturedCmd).toContain("-J");
  });

  test("setLines updates the next capture command's -S argument", async () => {
    let lastCmd: string[] = [];
    spawnCtx.set((cmd: string[], _opts?: any) => {
      lastCmd = cmd;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => lastCmd.includes("-200"), { message: "the default -200 capture" });
    expect(lastCmd).toContain("-200");

    poller.setLines(50);
    await waitFor(() => lastCmd.includes("-50"), { message: "a capture using -50 after setLines(50)" });
    expect(lastCmd).toContain("-50");

    poller.setLines(1234);
    await waitFor(() => lastCmd.includes("-1234"), { message: "a capture using -1234 after setLines(1234)" });
    expect(lastCmd).toContain("-1234");
  });

  test("setLines triggers an immediate poll when value changes (no wait for tick)", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => captureCalls > 0, { message: "the poll from setAgent" });
    const before = captureCalls;

    // Changing the value should trigger an immediate extra poll. "Immediate"
    // means "without waiting for a tick", and no tick can fire here — the test
    // owns the clock — so exactly one extra poll is what this must produce.
    poller.setLines(500);
    await waitFor(() => captureCalls === before + 1, { message: "the extra poll from setLines(500)" });
    expect(captureCalls).toBe(before + 1);
  });

  test("setLines is a no-op when the value is unchanged", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => captureCalls > 0, { message: "the poll from setAgent" });
    const before = captureCalls;

    poller.setLines(200); // same as default
    await giveASpuriousPollAChance();
    expect(captureCalls).toBe(before);
  });

  test("setLines before start does not poll", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.setLines(100);
    await giveASpuriousPollAChance();
    expect(captureCalls).toBe(0);
  });

  test("setAgent before start does not query width", async () => {
    let displayMessageCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("display-message")) displayMessageCalls++;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({
      onOutput() {},
      onWidth() {},
    });
    // setAgent without start — should not trigger width query
    poller.setAgent("session");
    await giveASpuriousPollAChance();
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
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => captureCalls > 0, { message: "the poll from setAgent" });
    expect(captureCalls).toBeGreaterThan(0);

    poller.stop();
    const countAfterStop = captureCalls;
    // The interval is really gone (not merely quiet for 1.2s)...
    expect(clock.armedTimers).toBe(0);
    // ...and the callback is inert if one fires anyway. Firing the tick is a
    // more direct test of the name than waiting for a tick that cannot come.
    clock.tick();
    clock.tick();
    await giveASpuriousPollAChance();
    expect(captureCalls).toBe(countAfterStop);
  });

  test("resume() restarts polling and fires an immediate poll when a session is set", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: streamOf("data\n"),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => captureCalls > 0, { message: "the poll from setAgent" });

    // Pause — simulates the pane going off-screen
    poller.stop();
    const countWhilePaused = captureCalls;
    expect(clock.armedTimers).toBe(0);
    clock.tick();
    await giveASpuriousPollAChance();
    expect(captureCalls).toBe(countWhilePaused);

    // Resume — should immediately poll (no waiting up to 1s for the next tick)
    expect(poller.isRunning()).toBe(false);
    poller.resume();
    expect(poller.isRunning()).toBe(true);
    expect(clock.armedTimers).toBe(1);
    // Nothing but resume() can produce a poll here, so the count is exactly
    // one higher — the old version had to hope no 1s tick landed in the gap.
    await waitFor(() => captureCalls === countWhilePaused + 1, { message: "the immediate poll from resume()" });
    expect(captureCalls).toBe(countWhilePaused + 1);
  });

  test("resume() is a no-op when already running (no duplicate timer / poll)", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    poller.start();
    poller.setAgent("session-A");
    await waitFor(() => captureCalls > 0, { message: "the poll from setAgent" });
    const before = captureCalls;
    expect(clock.armedTimers).toBe(1);

    // resume() while already running must not fire an extra poll
    poller.resume();
    await giveASpuriousPollAChance();
    expect(captureCalls).toBe(before);
    // ...and must not arm a second interval either, which is the other half of
    // this test's name and was previously unchecked.
    expect(clock.armedTimers).toBe(1);
  });

  test("resume() without a session set does not poll", async () => {
    let captureCalls = 0;
    spawnCtx.set((cmd: string[], _opts?: any) => {
      if (cmd.includes("capture-pane")) captureCalls++;
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
      };
    });

    poller = new TmuxPoller({ onOutput() {} });
    // No setAgent — resume should start the timer but not poll a null session.
    poller.resume();
    expect(poller.isRunning()).toBe(true);
    clock.tick();
    await giveASpuriousPollAChance();
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
  let clock: ManualClock;

  beforeEach(() => {
    clock = installManualClock();
  });

  afterEach(() => {
    poller?.stop();
    clock.restore();
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
    await waitFor(() => receivedRaw !== undefined, { message: "onOutput carrying the tabbed line" });

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
    await waitFor(() => receivedRaw !== undefined, { message: "onOutput for the tab-free line" });
    expect(receivedRaw).toBe("plain output line\n");
  });
});
