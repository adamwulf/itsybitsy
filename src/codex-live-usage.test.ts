import { test, expect, describe, afterEach } from "bun:test";
import {
  codexLiveSpawnCtx,
  codexRateLimitsFromResponse,
  fetchCodexLiveUsage,
  CODEX_APP_SERVER_COMMAND,
} from "./codex-live-usage";
import { parseCodexRateLimits } from "./usage";
import type { SpawnFn } from "./types";

/** What a fake app-server can do in reply to a message. */
interface FakeIo {
  /** Write one stdout line. */
  line(text: string): void;
  /** Write stdout bytes as they are (no newline added). */
  raw(text: string): void;
  stderr(text: string): void;
  /** Close stdout/stderr and resolve `exited`. */
  exit(code?: number): void;
}

interface FakeState {
  commands: string[][];
  stdinModes: unknown[];
  /** Every JSON message the probe wrote to stdin, in order. */
  messages: Record<string, unknown>[];
  /** The signal of each kill() call (undefined = default SIGTERM). */
  kills: unknown[];
  stdinEnded: boolean;
}

/**
 * A fake `codex app-server`: `onMessage` sees each JSON line the probe writes
 * to stdin and answers through `io`. By default kill() makes it exit.
 */
function fakeAppServer(
  onMessage: (message: Record<string, any>, io: FakeIo) => void,
  options: { exitOnKill?: boolean } = {},
): { spawn: SpawnFn; state: FakeState } {
  const state: FakeState = { commands: [], stdinModes: [], messages: [], kills: [], stdinEnded: false };
  const spawn: SpawnFn = (cmd, opts) => {
    state.commands.push(cmd);
    state.stdinModes.push(opts?.stdin);
    const encoder = new TextEncoder();
    let stdoutCtl!: ReadableStreamDefaultController<Uint8Array>;
    let stderrCtl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { stdoutCtl = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { stderrCtl = c; } });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    let hasExited = false;
    const io: FakeIo = {
      line: (text) => { try { stdoutCtl.enqueue(encoder.encode(text + "\n")); } catch {} },
      raw: (text) => { try { stdoutCtl.enqueue(encoder.encode(text)); } catch {} },
      stderr: (text) => { try { stderrCtl.enqueue(encoder.encode(text)); } catch {} },
      exit: (code = 0) => {
        if (hasExited) return;
        hasExited = true;
        try { stdoutCtl.close(); } catch {}
        try { stderrCtl.close(); } catch {}
        resolveExit(code);
      },
    };
    let pending = "";
    return {
      stdout,
      stderr,
      exited,
      stdin: {
        write(chunk: string) {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const message = JSON.parse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            state.messages.push(message);
            onMessage(message, io);
          }
          return chunk.length;
        },
        flush() {},
        end() { state.stdinEnded = true; },
      },
      kill(signal?: number | string) {
        state.kills.push(signal);
        if (options.exitOnKill !== false) io.exit(143);
      },
    };
  };
  return { spawn, state };
}

const INITIALIZE_RESULT = {
  userAgent: "itsybitsy/0.165.0",
  codexHome: "/Users/test/.codex",
  platformFamily: "unix",
  platformOs: "macos",
};

/** A server that answers `initialize`, then answers `account/rateLimits/read` with `answer`. */
function answering(answer: (id: unknown) => string) {
  return (message: Record<string, any>, io: FakeIo) => {
    if (message.method === "initialize") io.line(JSON.stringify({ id: message.id, result: INITIALIZE_RESULT }));
    if (message.method === "account/rateLimits/read") io.line(answer(message.id));
  };
}

/** An `account/rateLimits/read` result in the v2 (camelCase) shape. */
function rateLimitsResult(primary: unknown, secondary: unknown = null) {
  const snapshot = {
    limitId: "codex",
    limitName: null,
    primary,
    secondary,
    credits: { hasCredits: true, unlimited: false, balance: "100" },
    planType: "pro",
    rateLimitReachedType: null,
  };
  return { rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot } };
}

const FETCHED_AT = Date.parse("2026-11-07T22:00:00Z");
const WEEKLY = { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1794700000 };
const SESSION = { usedPercent: 41, windowDurationMins: 300, resetsAt: 1794110000 };

afterEach(() => {
  codexLiveSpawnCtx.reset();
});

describe("codexRateLimitsFromResponse", () => {
  test("maps the camelCase windows to the session-log shape", () => {
    expect(codexRateLimitsFromResponse(rateLimitsResult(WEEKLY))).toEqual({
      primary: { used_percent: 3, window_minutes: 10080, resets_at: 1794700000 },
      secondary: null,
    });
  });

  test("a result without a snapshot gives null", () => {
    expect(codexRateLimitsFromResponse(null)).toBeNull();
    expect(codexRateLimitsFromResponse({})).toBeNull();
    expect(codexRateLimitsFromResponse({ rateLimits: "nope" })).toBeNull();
  });
});

describe("fetchCodexLiveUsage", () => {
  test("reads a good snapshot and stops the process", async () => {
    const { spawn, state } = fakeAppServer(answering((id) => JSON.stringify({ id, result: rateLimitsResult(WEEKLY) })));
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage({ now: () => FETCHED_AT });

    expect(result.error).toBeNull();
    expect(result.reading).toEqual({
      rateLimits: { primary: { used_percent: 3, window_minutes: 10080, resets_at: 1794700000 }, secondary: null },
      observedAtMs: FETCHED_AT,
    });
    expect(parseCodexRateLimits(result.reading!.rateLimits, new Date(FETCHED_AT))).toEqual({
      sessionPct: null,
      weeklyPct: 3,
      sessionReset: null,
      weeklyReset: "7d 1h",
    });
    expect(state.commands).toEqual([[...CODEX_APP_SERVER_COMMAND]]);
    expect(state.stdinModes).toEqual(["pipe"]);
    expect(state.kills).toEqual([undefined]);
    expect(state.stdinEnded).toBe(true);
  });

  test("sends initialize, then initialized and account/rateLimits/read, with no jsonrpc field", async () => {
    const { spawn, state } = fakeAppServer(answering((id) => JSON.stringify({ id, result: rateLimitsResult(WEEKLY) })));
    codexLiveSpawnCtx.set(spawn);

    await fetchCodexLiveUsage();

    expect(state.messages).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "itsybitsy", version: "1" } } },
      { method: "initialized" },
      { id: 2, method: "account/rateLimits/read" },
    ]);
  });

  test("does not send the rate-limit request before initialize answers", async () => {
    const seen: { initialize?: Record<string, any>; io?: FakeIo } = {};
    const { spawn, state } = fakeAppServer((message, io) => {
      if (message.method === "initialize") { seen.initialize = message; seen.io = io; }
      if (message.method === "account/rateLimits/read") {
        io.line(JSON.stringify({ id: message.id, result: rateLimitsResult(WEEKLY) }));
      }
    });
    codexLiveSpawnCtx.set(spawn);

    const pending = fetchCodexLiveUsage();
    await Bun.sleep(10);
    expect(state.messages.map((m) => m.method)).toEqual(["initialize"]);

    seen.io!.line(JSON.stringify({ id: seen.initialize!.id, result: INITIALIZE_RESULT }));
    const result = await pending;
    expect(result.error).toBeNull();
    expect(state.messages.map((m) => m.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });

  test("windows in either order classify by windowDurationMins", async () => {
    // The weekly window first and the 5-hour window second.
    const { spawn } = fakeAppServer(answering((id) => JSON.stringify({ id, result: rateLimitsResult(WEEKLY, SESSION) })));
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage({ now: () => FETCHED_AT });

    const usage = parseCodexRateLimits(result.reading!.rateLimits, new Date(FETCHED_AT));
    expect(usage.sessionPct).toBe(41);
    expect(usage.weeklyPct).toBe(3);
    expect(usage.sessionReset).toBe("5h 53m");
    expect(usage.weeklyReset).toBe("7d 1h");
  });

  test("an error response (an API-key account) is a failure, and the process is stopped", async () => {
    const error = { code: -32600, message: "chatgpt authentication required to read rate limits" };
    const { spawn, state } = fakeAppServer(answering((id) => JSON.stringify({ id, error })));
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage();

    expect(result.reading).toBeNull();
    expect(result.error).toBe("account/rateLimits/read failed: chatgpt authentication required to read rate limits (code -32600)");
    expect(state.kills).toEqual([undefined]);
  });

  test("an initialize error is a failure and sends nothing more", async () => {
    const { spawn, state } = fakeAppServer((message, io) => {
      io.line(JSON.stringify({ id: message.id, error: { code: -32600, message: "Invalid clientInfo.name" } }));
    });
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage();

    expect(result.reading).toBeNull();
    expect(result.error).toBe("initialize failed: Invalid clientInfo.name (code -32600)");
    expect(state.messages.map((m) => m.method)).toEqual(["initialize"]);
  });

  test("skips garbage, blank and partial lines, and reads a response split across chunks", async () => {
    const { spawn } = fakeAppServer((message, io) => {
      if (message.method === "initialize") {
        io.line("WARN some log text on stdout");
        io.line("");
        io.line("{\"id\": 1, \"result\"");
        io.line("[1, 2, 3]");
        io.line(JSON.stringify({ id: message.id, result: INITIALIZE_RESULT }));
      }
      if (message.method === "account/rateLimits/read") {
        const response = JSON.stringify({ id: message.id, result: rateLimitsResult(WEEKLY) });
        io.raw(response.slice(0, 20));
        io.raw(response.slice(20) + "\r\n");
      }
    });
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage();

    expect(result.error).toBeNull();
    expect(result.reading?.rateLimits.primary).toEqual({ used_percent: 3, window_minutes: 10080, resets_at: 1794700000 });
  });

  test("ignores notifications and server requests before the response", async () => {
    const { spawn } = fakeAppServer((message, io) => {
      if (message.method === "initialize") {
        io.line(JSON.stringify({ method: "account/rateLimits/updated", params: rateLimitsResult({ usedPercent: 99, windowDurationMins: 10080, resetsAt: 1 }) }));
        io.line(JSON.stringify({ id: message.id, result: INITIALIZE_RESULT }));
      }
      if (message.method === "account/rateLimits/read") {
        io.line(JSON.stringify({ method: "account/rateLimits/updated", params: rateLimitsResult({ usedPercent: 98, windowDurationMins: 10080, resetsAt: 1 }) }));
        // A server-to-client request reusing the same id must not be taken as the answer.
        io.line(JSON.stringify({ id: message.id, method: "item/tool/requestUserInput", params: {} }));
        io.line(JSON.stringify({ id: message.id, result: rateLimitsResult(WEEKLY) }));
      }
    });
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage();

    expect(result.error).toBeNull();
    expect(result.reading?.rateLimits.primary).toEqual({ used_percent: 3, window_minutes: 10080, resets_at: 1794700000 });
  });

  test("a response with no rate-limit windows is a failure", async () => {
    const { spawn } = fakeAppServer(answering((id) => JSON.stringify({ id, result: rateLimitsResult(null, null) })));
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage();

    expect(result.reading).toBeNull();
    expect(result.error).toBe("account/rateLimits/read returned no rate-limit windows");
  });

  test("times out and kills a server that never answers", async () => {
    const { spawn, state } = fakeAppServer(() => {});
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage({ timeoutMs: 30 });

    expect(result.reading).toBeNull();
    expect(result.error).toBe("codex app-server did not answer within 30ms");
    expect(state.kills).toEqual([undefined]);
    expect(state.stdinEnded).toBe(true);
  });

  test("SIGKILLs a server that does not exit after SIGTERM", async () => {
    const { spawn, state } = fakeAppServer(() => {}, { exitOnKill: false });
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage({ timeoutMs: 20, killGraceMs: 20 });

    expect(result.error).toContain("did not answer");
    expect(state.kills).toEqual([undefined]);
    await Bun.sleep(60);
    expect(state.kills).toEqual([undefined, "SIGKILL"]);
  });

  test("does not SIGKILL a server that exits after SIGTERM", async () => {
    const { spawn, state } = fakeAppServer(() => {});
    codexLiveSpawnCtx.set(spawn);

    await fetchCodexLiveUsage({ timeoutMs: 20, killGraceMs: 20 });
    await Bun.sleep(60);

    expect(state.kills).toEqual([undefined]);
  });

  test("a spawn failure (codex not installed) is a failure, not a throw", async () => {
    codexLiveSpawnCtx.set(() => {
      throw new Error("Executable not found in $PATH: \"codex\"");
    });

    const result = await fetchCodexLiveUsage();

    expect(result).toEqual({ reading: null, error: "could not start codex app-server: Executable not found in $PATH: \"codex\"" });
  });

  test("a server that exits before answering is a failure that carries its stderr", async () => {
    const { spawn } = fakeAppServer((_message, io) => {
      io.stderr("Error: failed to load auth\n");
      io.exit(1);
    });
    codexLiveSpawnCtx.set(spawn);

    const result = await fetchCodexLiveUsage();

    expect(result.reading).toBeNull();
    expect(result.error).toBe("codex app-server exited before answering (stderr: Error: failed to load auth)");
  });

  test("a stdin write that throws is a failure", async () => {
    codexLiveSpawnCtx.set(() => ({
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      exited: new Promise<number>(() => {}),
      stdin: { write() { throw new Error("EPIPE"); } },
      kill: () => {},
    }));

    const result = await fetchCodexLiveUsage({ timeoutMs: 1_000, killGraceMs: 10 });

    expect(result).toEqual({ reading: null, error: "could not write to codex app-server: EPIPE" });
  });
});
