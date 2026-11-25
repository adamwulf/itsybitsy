/**
 * Exit and crash records for `ib watch` (SPEC §8.14). launchDashboard installs
 * these and nothing else does: hooks and every other `ib` command keep Bun's
 * default handling.
 *
 * Bun prints an uncaught exception or an unhandled rejection to stderr, where
 * the TUI hides it, and exits 1, so a JS crash used to leave nothing in
 * watch.log. Each handler here writes ONE `[crash]` entry to watch.log
 * synchronously (the process is about to die), restores the terminal the way
 * a quit does, prints the error to stderr as Bun would have, and exits 1. A
 * crash is never turned into keep-running: registering an unhandledRejection
 * listener stops Bun from exiting on its own, so the handler must exit.
 *
 * Every JS-level exit (a quit, a crash above, a signal handled by
 * terminal-cleanup.ts, a `process.exit` anywhere) also writes one `[exit]`
 * line from the process "exit" event. A native crash (a Bun panic, a segfault
 * in the iroh napi addon) runs no JS, so it leaves neither line: a run that
 * ends with no `[exit]` line died natively, and bounce.sh's exit-status line
 * and watch-stderr.log are its only record.
 */

import { inspect } from "util";
import { getWatchLogPath, logToWatchLog } from "../watch-log";

export type FatalEvent = "uncaughtException" | "unhandledRejection";

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
 * The thrown value as text: an Error's name, message and full stack, or any
 * other value's inspect form (a rejection can carry anything). Never throws.
 */
export function describeFatalReason(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const head = `${reason.name}: ${reason.message}`;
      const stack = typeof reason.stack === "string" ? reason.stack : "";
      // Bun's stack starts with "Name: message"; don't print it twice.
      if (stack.startsWith(head)) return stack;
      return stack ? `${head}\n${stack}` : head;
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

  const onFatal = (event: FatalEvent, reason: unknown): void => {
    if (crashed) {
      // A second fatal error while handling the first (its stderr write, a
      // late rejection): the first one's entry is written; just leave.
      deps.exit(1);
      return;
    }
    crashed = true;
    ending = `crashed (${event})`;
    const described = describeFatalReason(reason);
    // The record first: everything after it is best effort.
    try { deps.log(formatCrashEntry(event, reason, runInfo(deps))); } catch { /* logging never throws, but be sure */ }
    try { restoreTerminal(); } catch { /* still exit */ }
    try {
      deps.writeStderr(`ib watch crashed (${event}); the error is also in ${getWatchLogPath()}\n${described}\n`);
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
    uninstall() {
      deps.target.off("uncaughtException", watchCrashOnUncaughtException);
      deps.target.off("unhandledRejection", watchCrashOnUnhandledRejection);
      deps.target.off("exit", watchCrashOnExit);
    },
  };
}
