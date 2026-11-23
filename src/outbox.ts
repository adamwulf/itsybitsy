import { flock, LOCK_EX, LOCK_NB } from "./file-lock";
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
 * `<coordinatorHome>/agents/<machine>/<repo>/<id>/` for keyed agents.
 * Keyless agents keep `<coordinatorHome>/agents/<id>/` so their existing
 * watchdogs can deliver messages. Both paths come from `agentOutboxDir`. The
 * queue was moved out of the per-worktree agent dir so codex agents running
 * with `-s workspace-write` can write to any other agent's outbox — codex
 * spawns add the entire `<coordinatorHome>` as a writable root, and the
 * per-worktree agent dir is invisible to other sandboxes. A single drainer —
 * the agent's own watchdog (`runPerAgentWatchdog`), or a lock-guarded inline
 * fallback when no live watchdog exists — pops messages one at a time and
 * types them. One advisory lock (`.outbox.lock`) per queue directory keeps
 * drainers from interleaving their `send-keys`/`Enter` sequences. Keyless
 * agents with the same ID share that lock across their tmux sessions.
 * The system coordinator's queue directory is `<coordinatorHome>` itself.
 * Its senders pass that path via `sendMessage`'s `outboxDir` option.
 *
 * There is no central dispatcher. Each queue is drained independently.
 * The Telegram channel outbox lives in `src/channels/outbox.ts`.
 */

import { withPinnedDirectory } from "./pinned-directory";
import { constants } from "node:fs";
import { join } from "path";
import { rename, unlink, stat, lstat, readFile, writeFile, open, type FileHandle, rm, rmdir } from "fs/promises";
import type { RepoEntry } from "./registry";
import type { AgentMeta } from "./agents";
import { getCoordinatorHome } from "./coordinator";
import { isValidAgentId } from "./validation";

/** Filename for the per-agent message queue. */
export const OUTBOX_FILENAME = "outbox.jsonl";
/** Filename for the delivery lock in each queue directory. */
export const OUTBOX_LOCK_FILENAME = ".outbox.lock";

/** Resolve the registered segment from one registry snapshot, including symlinked repos. */
export async function registeredQueueRepo(repoPath: string, repos: RepoEntry[]): Promise<string | undefined> {
  let repo = repos.find((r) => r.path === repoPath);
  if (!repo && repos.length) {
    // The checkout path may differ from the registered path through a symlink.
    const physical = await stat(repoPath).catch(() => null);
    if (physical) {
      for (const entry of repos) {
        const candidate = await stat(entry.path).catch(() => null);
        if (candidate?.ino === physical.ino && candidate.dev === physical.dev) {
          repo = entry;
          break;
        }
      }
    }
  }
  if (!repo) return undefined;
  const name = repo.name;
  const matches = repos.filter((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) {
    throw new Error(`Ambiguous queue for repo name '${name}' registered at: ${matches.map((entry) => entry.path).join(", ")}`);
  }
  return name;
}

type QueueAgent = { id: string; meta: Pick<AgentMeta, "queue_key"> | null };

/** Validate persisted metadata before interpreting it as a relative path. */
export function queueDirForKey(key: string, agentId: string): string {
  const parts = typeof key === "string" ? key.split("/") : [];
  if (parts.length !== 3 || parts[2] !== agentId ||
      parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(`Invalid queue key for '${agentId}': ${JSON.stringify(key)}`);
  }
  return join(getCoordinatorHome(), "agents", key);
}

/** Agents without a stored key keep the queue their original watchdog uses. */
export function agentOutboxDir({ id, meta }: QueueAgent): string {
  if (meta?.queue_key !== undefined) return queueDirForKey(meta.queue_key, id);
  if (!isValidAgentId(id)) throw new Error(`Invalid agent id for queue: ${JSON.stringify(id)}`);
  return join(getCoordinatorHome(), "agents", id);
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
  /** Qualified peer labels can start with @, too. Retain their wire kind for the drainer. */
  peerSender?: "agent" | "system";
  /** Mirrors the historical `opts.raw` — suppresses the `[sent by ...]` prefix. */
  raw: boolean;
  /** Wall-clock ms at enqueue time (debugging / ordering aid). */
  enqueuedAtMs: number;
  /** When set, this message was fanned out to team @<team>; deliverMessage renders "in @<team>" in the prefix. Resolved at drain time. */
  team?: string;
  /**
   * When true, delivery MUST NOT treat a leading `/` or `!` as a user
   * slash/bang passthrough (see `deliverMessage`). Set for a send-time-staged
   * message that BEGINS with a file-path reference — an absolute `/tmp/...`
   * staged copy OR a live in-worktree path kept literal (e.g. an absolute path
   * into the agent's own worktree): that path is data, not a command, and must
   * be delivered with the normal `[sent by ...]:` prefix so it does not land in
   * column 0 and fire as a slash command. A genuine leading slash command
   * (`/clear`, or `/compact` before an attachment) leaves this unset so its
   * passthrough is preserved.
   */
  noPassthrough?: boolean;
}

/** Path to an agent/coordinator outbox file, given its queue directory. */
export function outboxPath(dir: string): string {
  return join(dir, OUTBOX_FILENAME);
}

/** Path to an agent/coordinator delivery lock file. */
export function outboxLockPath(dir: string): string {
  return join(dir, OUTBOX_LOCK_FILENAME);
}

async function openQueue(parent: string, append: boolean) {
  const path = outboxPath(parent);
  const before = await lstat(path).catch(err => { if (err.code !== "ENOENT") throw err; });
  const invalid = () => new Error("Expected a single-link regular outbox queue file");
  if (before && (!before.isFile() || before.nlink !== 1)) throw invalid();
  const access = append ? constants.O_RDWR | constants.O_APPEND | constants.O_CREAT : constants.O_RDONLY;
  const file = await open(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const opened = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (!opened.isFile() || !named.isFile() || opened.nlink !== 1n || named.nlink !== 1n ||
        opened.dev !== named.dev || opened.ino !== named.ino) throw invalid();
    return file;
  } catch (err) { await file.close(); throw err; }
}

/** Writers lock the directory inode, which survives replacement of the JSONL
 * file. The independent delivery lock serializes tmux, outside this section. */
async function withQueueMutation<T>(dir: string, create: boolean, signal: AbortSignal | undefined, work: (parent: string) => Promise<T>) {
  return withPinnedDirectory(dir, create, async (parent, directory) => {
    const deadline = performance.now() + 60_000;
    while (flock(directory.fd, LOCK_EX | LOCK_NB) !== 0) {
      signal?.throwIfAborted();
      if (performance.now() >= deadline) throw Error("Timed out waiting for queue mutation lock");
      await Bun.sleep(10);
    }
    signal?.throwIfAborted();
    return work(parent);
  });
}

export async function enqueueOutbox(
  dir: string,
  msg: Omit<OutboxMessage, "id" | "enqueuedAtMs"> & { id?: string; enqueuedAtMs?: number },
  reservedKey?: string,
  signal?: AbortSignal,
): Promise<OutboxMessage> {
  try {
    return await withQueueMutation(dir, reservedKey === undefined, signal, async parent => {
      const file = await openQueue(parent, true);
      try { return await appendRecord(file); } finally { await file.close(); }
    });
  } catch (err) {
    if (reservedKey !== undefined && (err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`agent ${reservedKey} no longer exists`);
    throw err;
  }
  async function appendRecord(file: FileHandle) {
    const content = await file.readFile("utf8");
    const existing = parseQueue(content);
    const dup = existing.find(
      (m) =>
        m.fromAgent === msg.fromAgent &&
        m.peerSender === msg.peerSender &&
        m.message === msg.message &&
        m.raw === msg.raw &&
        m.team === msg.team &&
        (m.noPassthrough === true) === (msg.noPassthrough === true),
    );
    if (dup) return dup;

    const record: OutboxMessage = {
      id: msg.id ?? crypto.randomUUID(),
      message: msg.message,
      fromAgent: msg.fromAgent,
      peerSender: msg.peerSender,
      raw: msg.raw,
      enqueuedAtMs: msg.enqueuedAtMs ?? Date.now(),
      team: msg.team,
      // Persist only when explicitly true so an ordinary record round-trips
      // identically to before (JSON.stringify drops the undefined key), keeping
      // the dedupe match above stable against pre-existing queued messages.
      noPassthrough: msg.noPassthrough === true ? true : undefined,
    };
    signal?.throwIfAborted();
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    await file.appendFile(separator + JSON.stringify(record) + "\n");
    return record;
  }
}

/**
 * Read all currently-queued messages, in FIFO order. Returns [] when the file
 * is missing or empty. Lines that fail to parse (e.g. a torn final append) are
 * skipped rather than throwing — a malformed line must not wedge the queue.
 */
export async function readOutbox(dir: string): Promise<OutboxMessage[]> {
  try { return await withPinnedDirectory(dir, false, readPinnedQueue); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
}

async function readPinnedQueue(parent: string) {
  const file = await openQueue(parent, false);
  try { return parseQueue(await file.readFile("utf8")); }
  finally { await file.close(); }
}

function parseQueue(content: string) {
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
          peerSender: obj.peerSender === "system" || obj.peerSender === "agent" ? obj.peerSender : undefined,
          raw: obj.raw,
          enqueuedAtMs: typeof obj.enqueuedAtMs === "number" ? obj.enqueuedAtMs : 0,
          team: typeof obj.team === "string" ? obj.team : undefined,
          noPassthrough: obj.noPassthrough === true ? true : undefined,
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
 * IMPORTANT (no double-delivery, no loss): callers hold the queue directory's lock,
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
  try {
    await withQueueMutation(dir, false, undefined, async parent => {
      const current = await readPinnedQueue(parent);
      const remaining = current.filter(m => !deliveredIds.has(m.id));
      const path = outboxPath(parent);
      if (!remaining.length) { await unlink(path); return; }
      const temp = path + "." + crypto.randomUUID() + ".tmp";
      try {
        await writeFile(temp, remaining.map(m => JSON.stringify(m)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    });
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

/** Collect unlink failures so teardown can try each remaining file. */
export async function unlinkQueueFile(path: string, warnings: string[]): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Warning: could not unlink ${path}: ${(err as Error).message}`);
    }
  }
}

export async function deleteAgentOutbox(dir: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const path of [outboxPath(dir), outboxPath(dir) + ".tmp", outboxLockPath(dir)]) {
    await unlinkQueueFile(path, warnings);
  }
  if (dir !== getCoordinatorHome()) {
    try {
      await rmdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`Warning: could not remove queue directory ${dir}: ${(err as Error).message}`);
      }
    }
  }
  return warnings;
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
 * Acquire the queue directory's advisory delivery lock via exclusive file creation
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
