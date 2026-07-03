/**
 * Per-agent (and per-coordinator) tmux message-delivery queue.
 *
 * Problem this solves: `ib send`, the dashboard send dialog, watchdog
 * notifications, and stop-hook nudges all type directly into an agent's tmux
 * session with `tmux send-keys -l -- <chunk>` … `Enter`. There is no
 * serialization, so two messages to the SAME agent that overlap in wall-clock
 * time interleave their chunks and Enters and land as one merged prompt.
 *
 * Fix: every write path ENQUEUES to a per-agent `outbox.jsonl` under
 * `<coordinatorHome>/agents/<id>/` (computed via `agentOutboxDir(id)`). The
 * queue was moved out of the per-worktree agent dir so codex agents running
 * with `-s workspace-write` can write to any other agent's outbox — codex
 * spawns add the entire `<coordinatorHome>` as a writable root, and the
 * per-worktree agent dir is invisible to other sandboxes. A single drainer —
 * the agent's own watchdog (`runPerAgentWatchdog`), or a lock-guarded inline
 * fallback when no live watchdog exists — pops messages one at a time and
 * types them. A per-session advisory lock (`.outbox.lock`) guarantees only one
 * drainer ever writes to a given session, so two `send-keys`/`Enter` sequences
 * can never interleave. The system coordinator's outbox is the one exception:
 * it lives in `<coordinatorHome>` directly (not under `agents/`), and callers
 * pass that path explicitly via `sendMessage`'s `outboxDir` opt.
 *
 * There is intentionally NO central dispatcher: the queue and lock are keyed
 * per-agent (i.e. per tmux session), so busy multi-agent communication has no
 * single bottleneck. This is distinct from the Telegram channel outbox in
 * `src/channels/outbox.ts`, which is unrelated.
 */

import { join } from "path";
import { rename, unlink, stat, readFile, appendFile, open, mkdir, rmdir } from "fs/promises";
import { getCoordinatorHome } from "./coordinator";

/** Filename for the per-agent message queue. */
export const OUTBOX_FILENAME = "outbox.jsonl";
/** Filename for the per-session delivery lock. */
export const OUTBOX_LOCK_FILENAME = ".outbox.lock";

/**
 * Per-agent outbox directory under the coordinator home
 * (`~/.itsybitsy/agents/<id>/`). Centralizing the queue out of each agent's
 * per-worktree directory lets a codex agent running with `-s workspace-write`
 * write to ANY other agent's outbox via `ib send` — codex agents are sandboxed
 * to their own worktree plus any roots passed via `--add-dir`, so we add this
 * single root to every codex spawn (see `buildCodexLaunchArgs`).
 *
 * The agent's own log, state, and meta still live under the per-worktree
 * `<repoPath>/.ittybitty/agents/<id>/` — only the message-delivery queue and
 * its lock move here.
 */
export function agentOutboxDir(agentId: string): string {
  return join(getCoordinatorHome(), "agents", agentId);
}

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
  /** When set, this message was fanned out to team @<team>; deliverMessage renders "in @<team>" in the prefix. Resolved at drain time. */
  team?: string;
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
    team: msg.team,
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
          team: typeof obj.team === "string" ? obj.team : undefined,
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
 * (archive/retire/nuke) alongside `deleteAgentTransient`. Best-effort:
 * any error (including ENOENT) is ignored.
 *
 * Also attempts to rmdir `dir` itself afterwards — when this is called against
 * the centralized per-agent outbox dir (`agentOutboxDir(id)`), that dir is
 * ours to create and clean up. The rmdir is best-effort: ENOENT (already
 * gone) and ENOTEMPTY (something else dropped a file in there) are both
 * ignored. The coordinator's outbox lives in `getCoordinatorHome()` directly,
 * which we must NOT rmdir; that case is explicitly short-circuited below as
 * defense-in-depth (ENOTEMPTY would also naturally protect it, but a guard
 * removes any latent footgun for a future caller that does pass it in).
 */
export async function deleteAgentOutbox(dir: string): Promise<void> {
  for (const p of [outboxPath(dir), outboxLockPath(dir)]) {
    try {
      await unlink(p);
    } catch {
      /* best-effort */
    }
  }
  // Never rmdir the coordinator home itself — that path is the system
  // coordinator's outbox location, not an ephemeral per-agent subdir.
  if (dir === getCoordinatorHome()) return;
  try {
    await rmdir(dir);
  } catch {
    /* best-effort — ENOENT/ENOTEMPTY both ignored */
  }
}

/** A held lock — pass to `releaseOutboxLock` (always in a finally block). */
export interface OutboxLock {
  dir: string;
  path: string;
  /**
   * Unique ownership token written into the lock file at acquire time.
   * `releaseOutboxLock` only removes the file when the on-disk token still
   * matches this — so if our lock was stolen (stale-steal by another process)
   * and re-created by the thief, our release is a no-op and we never delete the
   * thief's lock out from under them. Without this, an original holder whose
   * lock was stolen would delete the new holder's lock, letting a third drainer
   * acquire concurrently → interleaved/duplicated delivery.
   */
  token: string;
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

/** Serialize the holder pid + a unique token into the lock file body. */
function lockBody(token: string): string {
  return `${process.pid}:${token}`;
}

/** Parse the token out of a lock-file body (everything after the first `:`). */
function tokenFromBody(body: string): string {
  const idx = body.indexOf(":");
  return idx >= 0 ? body.slice(idx + 1) : body;
}

/**
 * Acquire the per-session advisory delivery lock via exclusive file creation
 * (O_CREAT|O_EXCL). On EEXIST the lock is held by someone else; retry with
 * backoff up to `timeoutMs`. Writes `<pid>:<token>` into the lock file (token
 * for ownership verification on release, pid for debuggability). Returns the
 * lock handle on success, or null on timeout.
 *
 * Stealing: when `steal` is set and the existing lock's mtime is older than
 * `staleMs`, the stale lock is removed and re-created. This is the inline
 * fallback's safety valve against a crashed holder. The token (verified on
 * release) ensures a stolen-from holder never deletes the thief's lock.
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
    const token = crypto.randomUUID();
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(lockBody(token));
      } finally {
        await handle.close();
      }
      return { dir, path, token };
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
            // Steal: read the current token so we only remove the lock we
            // observed as stale (don't unlink a fresh lock a third party may
            // have just created in the race window). The subsequent O_EXCL
            // open is the real arbiter — a racing stealer loses with EEXIST
            // and retries.
            let staleToken: string | null = null;
            try {
              staleToken = tokenFromBody(await readFile(path, "utf-8"));
            } catch {
              /* lock vanished — retry immediately */
              continue;
            }
            await unlinkIfToken(path, staleToken);
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

/**
 * Remove the lock file ONLY if its on-disk token still matches `token`. This
 * is the ownership guard shared by release and steal: it prevents deleting a
 * lock that has since been re-created by a different holder.
 */
async function unlinkIfToken(path: string, token: string): Promise<void> {
  try {
    const body = await readFile(path, "utf-8");
    if (tokenFromBody(body) !== token) return; // not our lock anymore — leave it
  } catch {
    return; // already gone
  }
  try {
    await unlink(path);
  } catch {
    /* raced with another release/steal — fine */
  }
}

/**
 * Release a held lock — removes the lock file only when the on-disk token still
 * matches the handle's token (i.e. we still hold it). If our lock was stolen
 * and re-created by another process, this is a no-op so we never delete the new
 * holder's lock. Best-effort.
 */
export async function releaseOutboxLock(lock: OutboxLock | null): Promise<void> {
  if (!lock) return;
  await unlinkIfToken(lock.path, lock.token);
}
