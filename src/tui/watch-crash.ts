/**
 * Exit and crash records for `ib watch` (SPEC §8.14). launchDashboard installs
 * these and nothing else does: hooks and every other `ib` command keep Bun's
 * default handling.
 *
 * Bun prints an uncaught exception or an unhandled rejection to stderr, where
 * the TUI hides it, and exits 1, so a JS crash used to leave nothing in
 * watch.log. Each handler here writes ONE `[crash]` entry to watch.log
 * synchronously (the process is about to die), restores the terminal the way
 * a quit does, prints the same text to stderr where Bun would have printed
 * the error, and exits 1. The text is the util.inspect form with bot tokens
 * redacted (describeFatalReason), not Bun's own error printer. A
 * crash is never turned into keep-running: registering an unhandledRejection
 * listener stops Bun from exiting on its own, so the handler must exit. A
 * startup failure (launchDashboard rejects) never reaches these handlers:
 * launchDashboard writes its `[crash] ... startup` entry with recordFatal and
 * rethrows it to main().catch.
 *
 * Every JS-level exit (a quit, a crash above, a signal handled by
 * terminal-cleanup.ts, a `process.exit` anywhere) also writes one `[exit]`
 * line from the process "exit" event. A run that ends with no `[exit]` line
 * ran no JS exit handlers: a Bun panic (SIGTRAP, including a native segfault
 * Bun catches, as in the iroh napi addon), a native abort() (SIGABRT), an
 * outside SIGKILL, a signal not handled at that moment, or a failure before
 * launchDashboard ran. bounce.sh's exit-status line and
 * watch-stderr.log tell which.
 */

import { inspect } from "util";
import { getWatchLogPath, logToWatchLog } from "../watch-log";

/** `startup`: launchDashboard rejected before the dashboard was up (recordFatal). */
export type FatalEvent = "uncaughtException" | "unhandledRejection" | "startup";

/** The process surface the handlers attach to. Tests pass an EventEmitter. */
export interface CrashHandlerTarget {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface WatchCrashDeps {
  target: CrashHandlerTarget;
  /** Must not return in production; tests record the code instead. */
  exit: (code: number) => void;
  /** One synchronous watch.log entry (logToWatchLog stamps it). */
  log: (entry: string) => void;
  writeStderr: (text: string) => void;
  pid: number;
  /** Seconds since the process started. */
  uptime: () => number;
}

export interface WatchCrashHandlers {
  /**
   * The synchronous terminal teardown to run before exiting on a crash.
   * launchDashboard sets it once the TUI exists; until then a crash restores
   * nothing, since nothing has taken over the terminal.
   */
  setRestoreTerminal(restore: () => void): void;
  /** Called as an orderly quit begins, so the `[exit]` line says how it was asked to quit. */
  noteQuit(how: string): void;
  /**
   * Write the `[crash]` entry for an error the handlers never see: a startup
   * failure that launchDashboard rethrows to main().catch, which prints it
   * and exits 1 as before. Only records; no teardown, no exit.
   */
  recordFatal(event: FatalEvent, reason: unknown): void;
  /** Detach every listener (tests). */
  uninstall(): void;
}

function defaultDeps(): WatchCrashDeps {
  return {
    target: process,
    exit: (code) => process.exit(code),
    log: logToWatchLog,
    writeStderr: (text) => { process.stderr.write(text); },
    pid: process.pid,
    uptime: () => process.uptime(),
  };
}

/**
 * A Telegram bot token as it appears in a Bot API URL (`bot<id>:<secret>`),
 * or bare, as the config stores it. Tight to the token's shape, so words in a
 * stack ("bottom", "robot") are left alone.
 */
const BOT_TOKEN_IN_PATH = /\bbot\d+:[A-Za-z0-9_-]+/g;
const BARE_BOT_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{30,}/g;

/**
 * Remove Telegram bot tokens. watch.log is a file users copy between
 * machines, and an Error's own fields can carry a request URL (a fetch
 * error's `path`) with the token in it. telegram-client.ts redacts its own
 * log labels the same way (redactLabelText).
 */
export function redactSecrets(text: string): string {
  return text.replace(BOT_TOKEN_IN_PATH, "bot<redacted>").replace(BARE_BOT_TOKEN, "<redacted bot token>");
}

/**
 * The thrown value as text, with bot tokens redacted (redactSecrets): its
 * util.inspect form (`inspect(value, { depth: 4 })`). For an Error that is
 * the full stack plus its own fields and `[cause]` chain; a network or napi
 * error's `code` is often the detail that matters. This is not Bun's own
 * error printer (no source excerpt). A rejection can carry any value. Never
 * throws.
 */
export function describeFatalReason(reason: unknown): string {
  return redactSecrets(describeUnredacted(reason));
}

function describeUnredacted(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const text = inspect(reason, { depth: 4 });
      // A stack overwritten with other text would hide the name and message.
      const head = `${reason.name}: ${reason.message}`;
      return text.includes(head) ? text : `${head}\n${text}`;
    }
    return `non-Error value: ${inspect(reason, { depth: 4 })}`;
  } catch {
    try {
      return `unprintable value: ${String(reason)}`;
    } catch {
      return "unprintable value";
    }
  }
}

function runInfo(deps: WatchCrashDeps): string {
  let uptime = "?";
  try { uptime = `${deps.uptime().toFixed(1)}s`; } catch { /* keep "?" */ }
  return `pid ${deps.pid}, uptime ${uptime}`;
}

/** The `[crash]` entry: a header line, then the error indented beneath it. */
export function formatCrashEntry(event: FatalEvent, reason: unknown, info: string): string {
  const body = describeFatalReason(reason).split("\n").map((line) => `    ${line}`).join("\n");
  return `[crash] ib watch died: ${event} (${info})\n${body}`;
}

export function installWatchCrashHandlers(overrides: Partial<WatchCrashDeps> = {}): WatchCrashHandlers {
  const deps: WatchCrashDeps = { ...defaultDeps(), ...overrides };
  let restoreTerminal: () => void = () => {};
  /** How this run is ending, for the `[exit]` line; null for any other exit (a signal, a process.exit). */
  let ending: string | null = null;
  let crashed = false;

  /** Write the `[crash]` entry; false when this run already wrote one. */
  const record = (event: FatalEvent, reason: unknown): boolean => {
    if (crashed) return false;
    crashed = true;
    ending = `crashed (${event})`;
    try { deps.log(formatCrashEntry(event, reason, runInfo(deps))); } catch { /* logging never throws, but be sure */ }
    return true;
  };

  const onFatal = (event: FatalEvent, reason: unknown): void => {
    // A second fatal error while handling the first (its stderr write, a
    // late rejection): the first one's entry is written; just leave.
    if (!record(event, reason)) {
      deps.exit(1);
      return;
    }
    // The record is written: everything after it is best effort.
    try { restoreTerminal(); } catch { /* still exit */ }
    try {
      deps.writeStderr(`ib watch crashed (${event}); the error is also in ${getWatchLogPath()}\n${describeFatalReason(reason)}\n`);
    } catch { /* a closed stderr must not stop the exit */ }
    deps.exit(1);
  };

  // Distinct names: a test looks for these among process's listeners.
  const watchCrashOnUncaughtException = (err: unknown): void => onFatal("uncaughtException", err);
  const watchCrashOnUnhandledRejection = (reason: unknown): void => onFatal("unhandledRejection", reason);
  const watchCrashOnExit = (code: unknown): void => {
    try {
      deps.log(`[exit] ib watch exiting with code ${String(code)}${ending ? `, ${ending}` : ""} (${runInfo(deps)})`);
    } catch { /* never throw from an exit listener */ }
  };

  deps.target.on("uncaughtException", watchCrashOnUncaughtException);
  deps.target.on("unhandledRejection", watchCrashOnUnhandledRejection);
  deps.target.on("exit", watchCrashOnExit);

  return {
    setRestoreTerminal(restore) { restoreTerminal = restore; },
    noteQuit(how) { if (!crashed) ending = `quit via ${how}`; },
    recordFatal(event, reason) { record(event, reason); },
    uninstall() {
      deps.target.off("uncaughtException", watchCrashOnUncaughtException);
      deps.target.off("unhandledRejection", watchCrashOnUnhandledRejection);
      deps.target.off("exit", watchCrashOnExit);
    },
  };
}
