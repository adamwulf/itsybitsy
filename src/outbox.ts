/**
 * Per-agent (and per-coordinator) tmux message-delivery queue.
 *
 * Problem this solves: `ib send`, the dashboard send dialog, watchdog
 * notifications, and stop-hook nudges all type directly into an agent's tmux
 * session with `tmux send-keys -l -- <chunk>` … `Enter`. There is no
 * serialization, so two messages to the SAME agent that overlap in wall-clock
 * time interleave their chunks and Enters and land as one merged prompt.
 *
 * Fix: every write path ENQUEUES to a per-agent `outbox.jsonl` (sibling of
 * `meta.json`). A single drainer — the agent's own watchdog
 * (`runPerAgentWatchdog`), or a lock-guarded inline fallback when no live
 * watchdog exists — pops messages one at a time and types them. A per-session
 * advisory lock (`.outbox.lock`) guarantees only one drainer ever writes to a
 * given session, so two `send-keys`/`Enter` sequences can never interleave.
 *
 * There is intentionally NO central dispatcher: the queue and lock are keyed
 * per-agent (i.e. per tmux session), so busy multi-agent communication has no
 * single bottleneck. This is distinct from the Telegram channel outbox in
 * `src/channels/outbox.ts`, which is unrelated.
 */

import { join } from "path";
import { rename, unlink, stat, readFile, appendFile, open, mkdir } from "fs/promises";

/** Filename for the per-agent message queue (sibling of meta.json). */
export const OUTBOX_FILENAME = "outbox.jsonl";
/** Filename for the per-session delivery lock. */
export const OUTBOX_LOCK_FILENAME = ".outbox.lock";

/**
 * One queued message awaiting delivery to an agent's tmux session.
 *
 * The `[sent by ...]` prefix is intentionally NOT pre-formatted at enqueue
 * time — prefix/label resolution (including the `user.name` config read)
 * happens at DRAIN time in `deliverMessage` so the formatting logic lives in
 * one place and matches the historical `sendMessage` behavior exactly.
 *
 * The one thing that MUST be resolved at enqueue time is `fromAgent`: the
 * cwd-based sender auto-detection depends on the SENDER process's cwd, which is
 * gone by drain time. The resolved sender (real ID, `@`-sentinel, or "" for the
 * human user) is stored here.
 */
export interface OutboxMessage {
  /** Unique id — lets the drainer rewrite the file to the not-yet-delivered remainder. */
  id: string;
  /** Raw user message (no `[sent by ...]` prefix). */
  message: string;
  /** Resolved sender: real agent id, `@`-sentinel, or "" for the human user. */
  fromAgent: string;
  /** Mirrors the historical `opts.raw` — suppresses the `[sent by ...]` prefix. */
  raw: boolean;
  /** Wall-clock ms at enqueue time (debugging / ordering aid). */
  enqueuedAtMs: number;
}

/** Path to an agent/coordinator outbox file, given the directory that holds meta.json. */
export function outboxPath(dir: string): string {
  return join(dir, OUTBOX_FILENAME);
}

/** Path to an agent/coordinator delivery lock file. */
export function outboxLockPath(dir: string): string {
  return join(dir, OUTBOX_LOCK_FILENAME);
}

/**
 * Append one message to the outbox. A single small `appendFile` of one line is
 * atomic on POSIX (O_APPEND), and the per-session lock around the DRAIN means a
 * concurrent drainer never truncates a half-written line: the drainer reads the
 * whole file, parses complete lines, and rewrites only the not-yet-delivered
 * remainder. An append that lands mid-drain is simply picked up next drain.
 *
 * `id` and `enqueuedAtMs` are injectable for deterministic tests.
 */
export async function enqueueOutbox(
  dir: string,
  msg: Omit<OutboxMessage, "id" | "enqueuedAtMs"> & { id?: string; enqueuedAtMs?: number },
): Promise<OutboxMessage> {
  const record: OutboxMessage = {
    id: msg.id ?? crypto.randomUUID(),
    message: msg.message,
    fromAgent: msg.fromAgent,
    raw: msg.raw,
    enqueuedAtMs: msg.enqueuedAtMs ?? Date.now(),
  };
  // Ensure the agent/coordinator directory exists before appending. In
  // production this dir always exists (created at spawn); creating it here is a
  // no-message-loss safeguard so a queued message is never silently dropped on
  // a missing dir (e.g. a synthetic-agent send target). mkdir recursive is a
  // no-op when the dir already exists.
  await mkdir(dir, { recursive: true });
  // Single-line append. The trailing newline keeps each record on its own line
  // so a partial write (extremely unlikely for a sub-PIPE_BUF line) is detected
  // as an unparseable trailing fragment and skipped, never merged into another.
  await appendFile(outboxPath(dir), JSON.stringify(record) + "\n");
  return record;
}

/**
 * Read all currently-queued messages, in FIFO order. Returns [] when the file
 * is missing or empty. Lines that fail to parse (e.g. a torn final append) are
 * skipped rather than throwing — a malformed line must not wedge the queue.
 */
export async function readOutbox(dir: string): Promise<OutboxMessage[]> {
  let content: string;
  try {
    content = await readFile(outboxPath(dir), "utf-8");
  } catch {
    return []; // missing file → empty queue
  }
  const out: OutboxMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.id === "string" &&
        typeof obj.message === "string" &&
        typeof obj.fromAgent === "string" &&
        typeof obj.raw === "boolean"
      ) {
        out.push({
          id: obj.id,
          message: obj.message,
          fromAgent: obj.fromAgent,
          raw: obj.raw,
          enqueuedAtMs: typeof obj.enqueuedAtMs === "number" ? obj.enqueuedAtMs : 0,
        });
      }
    } catch {
      /* skip malformed line — never let one bad record wedge the queue */
    }
  }
  return out;
}

/**
 * Rewrite the outbox to exactly `remaining`, atomically (tmp + rename).
 *
 * IMPORTANT (no double-delivery, no loss): callers hold the per-session lock,
 * read the batch, deliver one message, then call this with the messages that
 * have NOT yet been delivered. To account for appends that arrived mid-drain
 * (other processes can append even while we hold the lock — the lock guards
 * delivery, not enqueue), we re-read the file here and preserve any records
 * whose id is not in the delivered set. This keeps the FIFO remainder of the
 * batch AND any newly-appended records, so nothing is lost or redelivered.
 *
 * When the resulting set is empty the file is removed.
 */
export async function rewriteOutboxRemoving(dir: string, deliveredIds: Set<string>): Promise<void> {
  const current = await readOutbox(dir);
  const remaining = current.filter((m) => !deliveredIds.has(m.id));
  const path = outboxPath(dir);
  if (remaining.length === 0) {
    try {
      await unlink(path);
    } catch {
      /* already gone */
    }
    return;
  }
  const tmpPath = path + ".tmp";
  await Bun.write(tmpPath, remaining.map((m) => JSON.stringify(m)).join("\n") + "\n");
  await rename(tmpPath, path);
}

/**
 * Delete the outbox queue and its lock. Called from agent teardown
 * (archive/kill/nuke) alongside `deleteAgentTransient`. Best-effort:
 * any error (including ENOENT) is ignored.
 */
export async function deleteAgentOutbox(dir: string): Promise<void> {
  for (const p of [outboxPath(dir), outboxLockPath(dir)]) {
    try {
      await unlink(p);
    } catch {
      /* best-effort */
    }
  }
}

/** A held lock — pass to `releaseOutboxLock` (always in a finally block). */
export interface OutboxLock {
  dir: string;
  path: string;
}

export interface AcquireLockOpts {
  /** Total time to keep retrying before giving up, in ms. Default 5000. */
  timeoutMs?: number;
  /** Backoff between attempts, in ms. Default 25. */
  backoffMs?: number;
  /**
   * If true and the held lock looks stale (mtime older than `staleMs`), steal
   * it. The inline fallback sets this so a crashed holder can't wedge delivery
   * forever; the watchdog leaves it false (it just retries next tick).
   */
  steal?: boolean;
  /** Age past which a lock is considered stale and stealable. Default 30000. */
  staleMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable now (tests). */
  now?: () => number;
}

/**
 * Acquire the per-session advisory delivery lock via exclusive file creation
 * (O_CREAT|O_EXCL). On EEXIST the lock is held by someone else; retry with
 * backoff up to `timeoutMs`. Writes the holder pid into the lock file for
 * debuggability. Returns the lock handle on success, or null on timeout.
 *
 * Stealing: when `steal` is set and the existing lock's mtime is older than
 * `staleMs`, the stale lock is removed and re-created. This is the inline
 * fallback's safety valve against a crashed holder.
 */
export async function acquireOutboxLock(dir: string, opts?: AcquireLockOpts): Promise<OutboxLock | null> {
  const path = outboxLockPath(dir);
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const backoffMs = opts?.backoffMs ?? 25;
  const staleMs = opts?.staleMs ?? 30_000;
  const sleep = opts?.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts?.now ?? (() => Date.now());

  const deadline = now() + timeoutMs;
  // First attempt is unconditional; subsequent attempts are gated on the
  // deadline so a timeoutMs of 0 still tries exactly once.
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return { dir, path };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "EEXIST") {
        // Unexpected error (e.g. dir missing) — treat as un-acquirable.
        return null;
      }
      // Held by someone. Optionally steal if stale.
      if (opts?.steal) {
        try {
          const st = await stat(path);
          if (now() - st.mtimeMs > staleMs) {
            try {
              await unlink(path);
            } catch {
              /* someone else may have just released/stolen it — fall through to retry */
            }
            continue; // retry immediately after steal attempt
          }
        } catch {
          /* lock vanished between EEXIST and stat — retry immediately */
          continue;
        }
      }
    }
    if (now() >= deadline) return null;
    await sleep(backoffMs);
  }
}

/** Release a held lock by removing the lock file. Best-effort. */
export async function releaseOutboxLock(lock: OutboxLock | null): Promise<void> {
  if (!lock) return;
  try {
    await unlink(lock.path);
  } catch {
    /* already removed (e.g. stolen) — fine */
  }
}
