/**
 * Live Codex plan usage for the `ib watch` status bar, read from the account
 * instead of from the last Codex session log (which goes stale when a window
 * resets and no codex session runs afterwards). SPEC.md §6.6.3.
 *
 * `codex app-server` speaks JSON-RPC over stdio, one JSON object per line,
 * without the `"jsonrpc": "2.0"` field ("we neither send nor expect" it,
 * codex-rs/app-server-protocol/src/rpc.rs). The probe sends `initialize`; once
 * that answers, it sends the `initialized` notification and
 * `account/rateLimits/read`, takes the response with the matching id (skipping
 * notifications such as `account/rateLimits/updated`), and stops the process.
 * `account/rateLimits/read` asks OpenAI's backend for the account's current
 * windows. It starts no thread, so no hook fires and no session log is written,
 * and it spends no quota. Shapes come from openai/codex at tag rust-v0.165.0:
 * app-server-protocol/src/protocol/{common.rs, v1.rs, v2/account.rs}.
 */

import { SpawnContext } from "./types";
import type { SpawnResult } from "./types";
import { codexUsageReading } from "./usage";
import type { CodexRateLimits, CodexRateLimitWindow, CodexUsageReading } from "./usage";

/**
 * Spawn context for the `codex app-server` probe. Tests swap it, and the
 * `bun test` preload replaces its default so a test never starts real codex.
 */
export const codexLiveSpawnCtx = new SpawnContext();

export const CODEX_APP_SERVER_COMMAND: readonly string[] = ["codex", "app-server"];
/** The whole probe, from spawn to answer, must finish within this. */
export const CODEX_LIVE_USAGE_TIMEOUT_MS = 15_000;
/** How long the app-server gets to exit after SIGTERM before it gets SIGKILL. */
export const CODEX_LIVE_KILL_GRACE_MS = 2_000;

const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;
/**
 * `initialize` params. Only `clientInfo.name` and `clientInfo.version` are
 * required; codex puts them in its user agent, so the name must be a valid
 * HTTP header value.
 */
const CLIENT_INFO = { name: "itsybitsy", version: "1" };
/** Characters of app-server stderr kept for a failure message. */
const STDERR_TAIL_CHARS = 400;

export interface CodexLiveUsageResult {
  /** The account's windows and the time they were fetched; null when the probe failed. */
  reading: CodexUsageReading | null;
  /** Why the probe failed; null on success. */
  error: string | null;
}

export interface CodexLiveUsageOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  /** Clock for the reading's time (epoch ms). Defaults to Date.now. */
  now?: () => number;
}

/** Map one `account/rateLimits/read` window (camelCase) to the session-log shape. */
function logShapeWindow(window: unknown): CodexRateLimitWindow | null {
  if (!window || typeof window !== "object") return null;
  const w = window as Record<string, unknown>;
  return { used_percent: w.usedPercent, window_minutes: w.windowDurationMins, resets_at: w.resetsAt };
}

/**
 * The windows of an `account/rateLimits/read` result, mapped to the
 * session-log shape that parseCodexRateLimits classifies (by window length,
 * not position). `rateLimits` is the server's "codex" bucket, the same
 * `limit_id` the session logs carry. Null when the result has no snapshot.
 */
export function codexRateLimitsFromResponse(result: unknown): CodexRateLimits | null {
  if (!result || typeof result !== "object") return null;
  const snapshot = (result as Record<string, unknown>).rateLimits;
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  return { primary: logShapeWindow(s.primary), secondary: logShapeWindow(s.secondary) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A JSON-RPC error object as text: its message and code. */
function rpcErrorText(error: unknown): string {
  if (error && typeof error === "object") {
    const { message, code } = error as Record<string, unknown>;
    if (typeof message === "string") return typeof code === "number" ? `${message} (code ${code})` : message;
  }
  return JSON.stringify(error) ?? String(error);
}

/** Keep a promise a sink method may return from becoming an unhandled rejection. */
function ignoreRejection(value: unknown): void {
  if (value instanceof Promise) value.catch(() => {});
}

/**
 * Close stdin and SIGTERM the app-server; SIGKILL it if it has not exited
 * after `graceMs`. The escalation timer does not keep the process alive.
 */
function stopProcess(proc: SpawnResult, graceMs: number): void {
  try { ignoreRejection(proc.stdin?.end?.()); } catch {}
  try { proc.kill?.(); } catch {}
  const escalate = setTimeout(() => {
    try { proc.kill?.("SIGKILL"); } catch {}
  }, graceMs);
  escalate.unref?.();
  proc.exited.then(() => clearTimeout(escalate), () => clearTimeout(escalate));
}

/** A stream reader, as far as stopping it goes. */
type Cancelable = { cancel(reason?: unknown): Promise<void> };

/**
 * Read `stream` to its end, calling `onText` with each decoded chunk. The
 * reader goes into `readers` so the caller can cancel it.
 */
async function readText(
  stream: ReadableStream<Uint8Array>,
  readers: Cancelable[],
  onText: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  readers.push(reader);
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onText(decoder.decode(value, { stream: true }));
  }
  const rest = decoder.decode();
  if (rest) onText(rest);
}

/**
 * Fetch the account's Codex rate limits from `codex app-server`. Never throws:
 * a missing `codex`, an account without plan limits (an API key, or not
 * logged in: the server answers with an error), an RPC error, a timeout, or an
 * answer without windows all give `{ reading: null, error }`. The process is
 * always stopped before this returns.
 */
export async function fetchCodexLiveUsage(options: CodexLiveUsageOptions = {}): Promise<CodexLiveUsageResult> {
  const timeoutMs = options.timeoutMs ?? CODEX_LIVE_USAGE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? CODEX_LIVE_KILL_GRACE_MS;
  const now = options.now ?? Date.now;

  let proc: SpawnResult;
  try {
    proc = codexLiveSpawnCtx.runner([...CODEX_APP_SERVER_COMMAND], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  } catch (err) {
    return { reading: null, error: `could not start codex app-server: ${errorText(err)}` };
  }

  return new Promise<CodexLiveUsageResult>((resolve) => {
    let settled = false;
    let stderrTail = "";
    const readers: Cancelable[] = [];

    const finish = (result: CodexLiveUsageResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopProcess(proc, killGraceMs);
      for (const reader of readers) reader.cancel().catch(() => {});
      resolve(result);
    };
    const fail = (why: string): void => {
      const tail = stderrTail.trim();
      finish({ reading: null, error: tail ? `${why} (stderr: ${tail})` : why });
    };
    const timer = setTimeout(() => fail(`codex app-server did not answer within ${timeoutMs}ms`), timeoutMs);

    const stdin = proc.stdin;
    const stdout = proc.stdout;
    if (!stdin || !stdout) {
      fail("codex app-server has no stdin/stdout pipe");
      return;
    }

    const send = (message: object): boolean => {
      try {
        stdin.write(JSON.stringify(message) + "\n");
        ignoreRejection(stdin.flush?.());
        return true;
      } catch (err) {
        fail(`could not write to codex app-server: ${errorText(err)}`);
        return false;
      }
    };

    const onMessage = (message: Record<string, unknown>): void => {
      // Notifications and server-to-client requests carry a method; only responses are matched.
      if ("method" in message) return;
      if (message.id === INITIALIZE_ID) {
        if (message.error !== undefined) {
          fail(`initialize failed: ${rpcErrorText(message.error)}`);
          return;
        }
        if (send({ method: "initialized" })) send({ id: RATE_LIMITS_ID, method: "account/rateLimits/read" });
        return;
      }
      if (message.id === RATE_LIMITS_ID) {
        if (message.error !== undefined) {
          fail(`account/rateLimits/read failed: ${rpcErrorText(message.error)}`);
          return;
        }
        const rateLimits = codexRateLimitsFromResponse(message.result);
        const reading = rateLimits ? codexUsageReading(rateLimits, now()) : null;
        if (reading) finish({ reading, error: null });
        else fail("account/rateLimits/read returned no rate-limit windows");
      }
    };

    const onLine = (line: string): void => {
      if (settled) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return; // Not a protocol line.
      }
      if (message && typeof message === "object" && !Array.isArray(message)) {
        onMessage(message as Record<string, unknown>);
      }
    };

    const stderrDone = proc.stderr
      ? readText(proc.stderr, readers, (text) => {
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      }).catch(() => {})
      : Promise.resolve();

    let buffered = "";
    readText(stdout, readers, (text) => {
      buffered += text;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    })
      .then(async () => {
        onLine(buffered);
        // Let stderr finish so the failure message carries it; the timer still bounds the wait.
        await stderrDone;
        fail("codex app-server exited before answering");
      })
      .catch((err) => fail(`reading codex app-server output failed: ${errorText(err)}`));

    send({ id: INITIALIZE_ID, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });
}
