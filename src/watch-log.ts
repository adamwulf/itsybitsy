/**
 * Append-only diagnostic log for `ib watch`. Writes to ~/.itsybitsy/watch.log
 * with size-based rotation: when the active log exceeds 1 MB, watch.log.2 is
 * deleted (if present), watch.log.1 → watch.log.2, watch.log → watch.log.1,
 * and a fresh watch.log is started. Total on-disk footprint capped at 3 MB
 * (active + 2 rotated).
 *
 * Logging must never crash the dashboard — every fs operation here swallows
 * errors silently. Callers do not get failure feedback; this is an
 * observability sink, not an error channel.
 */

import { join } from "path";
import { homedir } from "os";
import {
  appendFileSync, statSync, mkdirSync, renameSync, unlinkSync,
} from "fs";

const MAX_BYTES = 1_048_576; // 1 MB

/**
 * Resolve the default log path. Honors the IB_WATCH_LOG_PATH env override when
 * present so a harness (notably `bun test`) can redirect the log away from the
 * user's live ~/.itsybitsy/watch.log for the whole process — including the
 * path resetWatchLogPath() restores to. In normal use the env is unset and
 * this is exactly ~/.itsybitsy/watch.log.
 */
function resolveDefaultLogPath(): string {
  const override = process.env.IB_WATCH_LOG_PATH;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".itsybitsy", "watch.log");
}

const DEFAULT_LOG_PATH = resolveDefaultLogPath();

let logPath = DEFAULT_LOG_PATH;
let watchRunning = false;

/**
 * Flip the "watch is rendering" flag. While set, logWarning() routes its
 * output through logToWatchLog so warnings can't corrupt the dashboard;
 * while clear, logWarning() falls back to stderr for CLI ergonomics.
 */
export function setWatchRunning(v: boolean): void {
  watchRunning = v;
}

/**
 * Emit a warning line. If `ib watch` is currently running its TUI, the line
 * is appended to ~/.itsybitsy/watch.log. Otherwise it is written to stderr.
 * Never throws.
 */
export function logWarning(line: string): void {
  if (watchRunning) {
    logToWatchLog(line);
  } else {
    try {
      process.stderr.write(line.endsWith("\n") ? line : line + "\n");
    } catch {
      /* swallow — logging must never crash callers */
    }
  }
}

/** Test override — point the logger at a temp file. */
export function setWatchLogPath(path: string): void {
  logPath = path;
}

export function resetWatchLogPath(): void {
  logPath = DEFAULT_LOG_PATH;
}

export function getWatchLogPath(): string {
  return logPath;
}

/**
 * Append a single line (with ISO 8601 timestamp prefix and trailing newline)
 * to the active watch log, rotating first if the active file is at/over 1 MB.
 * Never throws.
 */
export function logToWatchLog(line: string): void {
  try {
    rotateIfNeeded();
  } catch {
    /* swallow — rotation failure must not block the write */
  }

  try {
    ensureParentDir();
    const stamp = new Date().toISOString();
    appendFileSync(logPath, `${stamp} ${line}\n`);
  } catch {
    /* swallow — logging must never crash callers */
  }
}

function ensureParentDir(): void {
  try {
    const parent = parentOf(logPath);
    mkdirSync(parent, { recursive: true });
  } catch {
    /* swallow */
  }
}

function parentOf(p: string): string {
  const ix = p.lastIndexOf("/");
  return ix < 0 ? "." : p.slice(0, ix) || "/";
}

/**
 * Rotation policy: keep watch.log + watch.log.1 + watch.log.2 (≤ 3 MB total).
 * If watch.log is at or over 1 MB:
 *   1. unlink watch.log.2 if it exists
 *   2. rename watch.log.1 → watch.log.2 if it exists
 *   3. rename watch.log → watch.log.1
 * The next write recreates watch.log fresh.
 */
function rotateIfNeeded(): void {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    // No active log yet — nothing to rotate.
    return;
  }

  if (size < MAX_BYTES) return;

  const log1 = `${logPath}.1`;
  const log2 = `${logPath}.2`;

  try {
    unlinkSync(log2);
  } catch {
    /* may not exist — fine */
  }

  try {
    renameSync(log1, log2);
  } catch {
    /* may not exist — fine */
  }

  try {
    renameSync(logPath, log1);
  } catch {
    /* if this fails the active log stays as-is; next write still appends */
  }
}
