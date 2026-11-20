/**
 * Telegram connection status file.
 *
 *   ~/.itsybitsy/channels/telegram/status.json
 *
 * `ib watch` owns the Telegram connection (boot, inbound poll loop, outbox).
 * It rewrites this small file whenever the connection state changes, so other
 * processes can see that state cheaply without talking to Telegram:
 *
 *   - `ib tgsend` / `ib tgreact` / `ib tgsendfile` read it when no result
 *     arrives in their wait window, to say WHY the message is still queued
 *     ("Telegram is unreachable (HTTP 502)", "ib watch is not running", ...).
 *   - A human can `cat` it.
 *
 * The writer is the `ib watch` process (src/tui/dashboard.ts). It writes on
 * state transitions only, never per poll, and removes the file on a clean
 * exit. A crashed writer leaves a stale file behind, so readers check that
 * `pid` is still alive (`live` in {@link readTelegramStatus}).
 *
 * Writes are atomic (`.tmp` + rename). Reads never throw. The file holds no
 * secret: `lastError` is a token-safe label (`classifyError()` output or an
 * HTTP status/description), never a URL.
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { rename, unlink } from "fs/promises";
import { defaultStateDir as accessDefaultStateDir } from "./access";

/**
 * - `connecting`: `ib watch` has a bot token but has not reached Telegram yet
 *   (boot is retrying a network/5xx/timeout probe failure).
 * - `connected`: the last poll succeeded and the outbox is not stalled.
 * - `reconnecting`: the poll loop or the outbox is backing off after a
 *   transient failure. Queued messages stay on disk and are sent on recovery.
 * - `disabled`: routing is off for this `ib watch` session (no token, token
 *   rejected, another poller/webhook, or no allowlisted chat). Queued messages
 *   stay on disk until an `ib watch` start that boots successfully.
 */
export type TelegramConnectionState = "connecting" | "connected" | "reconnecting" | "disabled";

export interface TelegramConnectionStatus {
  state: TelegramConnectionState;
  /** Token-safe label of the most recent failure (e.g. `HTTP 502`,
   *  `errno:ETIMEDOUT`), or for `disabled` the reason routing is off. Null
   *  when there is nothing to report. */
  lastError: string | null;
  /** Epoch ms when `lastError` was observed, or null. */
  lastErrorAt: number | null;
  /** Outbox items (texts, reactions, files) not yet delivered. While boot is
   *  still connecting or routing is disabled there is no outbox, and this is
   *  the count of item files waiting in the outbox dir (refreshed on the
   *  monitor's 5 s backstop and on boot events). */
  outboxPending: number;
  /** pid of the `ib watch` process that wrote the file. */
  pid: number;
  /** Epoch ms of the write. */
  updatedAt: number;
}

let overrideStateDir: string | undefined;

/** Point the status file at a test directory. */
export function setStatusDir(dir: string): void {
  overrideStateDir = dir;
}

export function resetStatusDir(): void {
  overrideStateDir = undefined;
}

function stateDir(): string {
  return overrideStateDir ?? accessDefaultStateDir();
}

export function telegramStatusPath(): string {
  return join(stateDir(), "status.json");
}

const STATES: ReadonlySet<string> = new Set(["connecting", "connected", "reconnecting", "disabled"]);

function normalize(parsed: unknown): TelegramConnectionStatus | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.state !== "string" || !STATES.has(o.state)) return null;
  if (o.lastError !== null && typeof o.lastError !== "string") return null;
  if (o.lastErrorAt !== null && typeof o.lastErrorAt !== "number") return null;
  if (typeof o.outboxPending !== "number" || !Number.isFinite(o.outboxPending)) return null;
  if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) return null;
  if (typeof o.updatedAt !== "number" || !Number.isFinite(o.updatedAt)) return null;
  return {
    state: o.state as TelegramConnectionState,
    lastError: o.lastError as string | null,
    lastErrorAt: o.lastErrorAt as number | null,
    outboxPending: o.outboxPending,
    pid: o.pid,
    updatedAt: o.updatedAt,
  };
}

/** Injectable liveness check. `process.kill(pid, 0)` throws ESRCH for a dead
 *  pid and EPERM for a live pid we may not signal (e.g. from a sandboxed
 *  agent); only ESRCH means "gone". */
export type PidAliveFn = (pid: number) => boolean;
const defaultPidAlive: PidAliveFn = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Read the status file. Returns null when it is missing, unreadable or
 * malformed (never throws). `live` is false when the writing `ib watch` is no
 * longer running, i.e. the file is a leftover from a crash.
 */
export async function readTelegramStatus(
  pidAlive: PidAliveFn = defaultPidAlive,
): Promise<{ status: TelegramConnectionStatus; live: boolean } | null> {
  let text: string;
  try {
    const file = Bun.file(telegramStatusPath());
    if (!(await file.exists())) return null;
    text = await file.text();
  } catch {
    return null;
  }
  let status: TelegramConnectionStatus | null;
  try {
    status = normalize(JSON.parse(text));
  } catch {
    return null;
  }
  if (status === null) return null;
  return { status, live: pidAlive(status.pid) };
}

/** Atomically write the status file (creates the state dir at 0o700). */
export async function writeTelegramStatus(status: TelegramConnectionStatus): Promise<void> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const path = telegramStatusPath();
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(status) + "\n");
  await rename(tmp, path);
}

/** Remove the status file if `ownerPid` wrote it. Best effort; never throws.
 *  `ib watch` calls this on a clean exit. The pid check keeps one `ib watch`
 *  from deleting a file another running `ib watch` wrote. */
export async function clearTelegramStatus(ownerPid: number = process.pid): Promise<void> {
  const current = await readTelegramStatus(() => true);
  if (current !== null && current.status.pid !== ownerPid) return;
  try {
    await unlink(telegramStatusPath());
  } catch {
    /* already gone */
  }
}
