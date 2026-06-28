/**
 * Telegram inbound-attachment storage.
 *
 * Downloaded inbound files (photos, documents, voice, etc.) are written under
 *   ~/.itsybitsy/channels/telegram/inbound/<chat>/<unix-ms>-<safeName>
 * so the coordinator (and the agents it spawns) can read them as ordinary
 * local files. A local path beats base64: agents are file-oriented and a
 * base64 blob would blow up the coordinator prompt.
 *
 * Retention policy
 * ----------------
 * Inbound files are kept INDEFINITELY by default — unlike the outbox's 5s
 * result retention, the agent may still need an inbound file long after the
 * message that delivered it (e.g. "summarize the PDF I sent yesterday"). We
 * deliberately do NOT auto-delete. A best-effort, opt-in sweep
 * (`pruneInboundOlderThan`) is provided so an operator (or a future
 * housekeeping pass) can reclaim space by age, but nothing calls it on the
 * hot path. `INBOUND_DEFAULT_TTL_MS` (30 days) documents the suggested manual
 * cutoff; it is NOT applied automatically.
 *
 * Path-traversal safety
 * ---------------------
 * The on-disk filename is ALWAYS a generated `<unix-ms>-<safeName>` stem. The
 * `safeName` passed in is already sanitized by the dispatcher (via the shared
 * `safeName()` helper), and we additionally strip any path separators and `..`
 * segments here so a malicious Telegram `file_name` can never escape the
 * per-chat inbound directory. The chat segment is likewise sanitized.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdir, readdir, stat, rename, unlink } from "fs/promises";

let overrideInboundDir: string | undefined;

// Naming note: this module follows the OUTBOX convention
// (`setOutboxDir`/`resetOutboxDir`/`defaultOutboxDir`), not the
// `setStateDir` convention used by access.ts / chat-id-cache.ts /
// last-message-cache.ts. Those caches all share ONE json-state directory
// (`access.defaultStateDir()`); the inbound store is a distinct *file* store
// under `telegram/inbound/`, exactly analogous to the outbox's file store —
// so it mirrors the outbox's dir-override naming, which is the right analog.

/** Override the inbound root directory. Tests point this at a tmpdir so they
 *  never touch the real ~/.itsybitsy state. */
export function setInboundDir(dir: string): void {
  overrideInboundDir = dir;
}

/** Reset the inbound directory override. Tests call this in afterEach. */
export function resetInboundDir(): void {
  overrideInboundDir = undefined;
}

/** Resolve the active inbound root directory. Honors `setInboundDir` for tests;
 *  in production it lives under `$HOME/.itsybitsy/channels/telegram/inbound`. */
export function defaultInboundDir(): string {
  return (
    overrideInboundDir ??
    join(process.env.HOME ?? homedir(), ".itsybitsy", "channels", "telegram", "inbound")
  );
}

/** Suggested manual retention cutoff for inbound files (30 days). NOT applied
 *  automatically — see the module header. Exposed so an operator/housekeeping
 *  pass can call `pruneInboundOlderThan(INBOUND_DEFAULT_TTL_MS)`. */
export const INBOUND_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Final-layer path-traversal guard. Strips directory separators, NUL, and any
 *  `..` so the resulting string can only ever be a leaf name under the chat
 *  dir. The dispatcher already runs `safeName()`; this is defense-in-depth so
 *  the storage layer is safe regardless of caller. */
function leafName(name: string): string {
  const stripped = String(name)
    .replace(/[/\\]/g, "_") // no path separators
    .replace(/\0/g, "") // no NUL
    .replace(/\.\.+/g, "_"); // collapse any run of dots (kills `..`)
  const trimmed = stripped.trim();
  return trimmed === "" ? "file" : trimmed;
}

/** Sanitize the chat segment the same way — a chat id is normally numeric, but
 *  we never trust it blindly for a directory name. */
function chatSegment(chatId: string): string {
  const seg = String(chatId).replace(/[^0-9A-Za-z_-]/g, "_");
  return seg === "" ? "unknown" : seg;
}

/**
 * Write inbound bytes to `<inbound>/<chat>/<unix-ms>-<safeName>` and return the
 * absolute path. The `unixMs` stem keeps names unique and chronological; the
 * caller supplies it (the dispatcher uses the message timestamp / clock) so the
 * module stays clock-free and testable. Creates the per-chat dir at 0o700.
 */
export async function storeInboundFile(
  chatId: string,
  unixMs: number,
  safeName: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = join(defaultInboundDir(), chatSegment(chatId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const leaf = `${unixMs}-${leafName(safeName)}`;
  const finalPath = join(dir, leaf);
  // Atomic write: .tmp + rename so a crash mid-write never leaves a partial
  // file the agent might read as complete.
  const tmpPath = `${finalPath}.tmp`;
  await Bun.write(tmpPath, bytes);
  await rename(tmpPath, finalPath);
  return finalPath;
}

/**
 * Best-effort, opt-in sweep: delete inbound files older than `maxAgeMs`. NOT
 * called on any hot path — provided for an operator or future housekeeping
 * pass. Never throws; returns the count of files removed. Directories are left
 * in place (cheap, and avoids racing a concurrent write into an empty chat dir).
 */
export async function pruneInboundOlderThan(maxAgeMs: number, now: number): Promise<number> {
  const root = defaultInboundDir();
  let removed = 0;
  let chatDirs: string[];
  try {
    chatDirs = await readdir(root);
  } catch {
    return 0; // nothing to prune
  }
  for (const chat of chatDirs) {
    const chatDir = join(root, chat);
    let files: string[];
    try {
      files = await readdir(chatDir);
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(chatDir, f);
      try {
        const st = await stat(p);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(p);
          removed += 1;
        }
      } catch {
        // race or permission — skip
      }
    }
  }
  return removed;
}
