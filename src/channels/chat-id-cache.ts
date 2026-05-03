/**
 * Telegram chat-id cache.
 *
 * Persists the resolved private-chat id at
 *   ~/.itsybitsy/channels/telegram/chat-id-cache.json
 * with the schema:
 *   { chat_id: string, cached_at: string (ISO 8601) }
 *
 * The file lives in the same `telegram` directory as `access.json` so the
 * boot helper can resolve a chat id once (via inbound walk) and skip the
 * fresh-DM requirement on subsequent `ib watch` startups. Cache invalidation
 * is driven by the dispatcher's startup probe — a 401/403 result clears the
 * file so the next boot re-resolves.
 *
 * Writes are atomic (.tmp + rename). On JSON parse failure or wrong-shape
 * content, the corrupt file is renamed aside to
 * `chat-id-cache.json.corrupt-<unix-ms>` and we return null — this module
 * never throws on read.
 *
 * NOTE: The filename is intentionally distinct from the Phase A `chat-id`
 * artifact so the one-time cleanup unlink in src/tui/dashboard.ts (Phase B)
 * does not delete this cache.
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { rename, unlink } from "fs/promises";
import { defaultStateDir as accessDefaultStateDir } from "./access";

export interface CachedChatId {
  chat_id: string;
  cached_at: string;
}

let overrideStateDir: string | undefined;

export function setStateDir(dir: string): void {
  overrideStateDir = dir;
}

export function resetStateDir(): void {
  overrideStateDir = undefined;
}

/**
 * Returns the directory containing the cache file. The local override wins;
 * otherwise we fall through to access.ts's `defaultStateDir()` so both files
 * stay co-located (and tests that set the dir via `access.setStateDir` also
 * get this module pointed at the same place).
 */
export function defaultStateDir(): string {
  return overrideStateDir ?? accessDefaultStateDir();
}

function cachePath(): string {
  return join(defaultStateDir(), "chat-id-cache.json");
}

function ensureStateDir(): void {
  mkdirSync(defaultStateDir(), { recursive: true, mode: 0o700 });
}

function normalize(parsed: unknown): CachedChatId | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const chatId = obj.chat_id;
  const cachedAt = obj.cached_at;
  if (typeof chatId !== "string" || chatId === "") return null;
  if (typeof cachedAt !== "string") return null;
  return { chat_id: chatId, cached_at: cachedAt };
}

/**
 * Read the cached chat id. Never throws — returns null when the file is
 * missing, empty, malformed, or wrong-shape. A corrupt file is renamed aside
 * to `chat-id-cache.json.corrupt-<timestamp>` so the user can recover it
 * manually; subsequent reads see the file as missing and return null.
 */
export async function readCachedChatId(): Promise<string | null> {
  const path = cachePath();
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let text: string;
  try {
    text = await file.text();
  } catch {
    return null;
  }
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text);
    const normalized = normalize(parsed);
    if (normalized) return normalized.chat_id;
  } catch {
    // fall through to corrupt-file handling
  }
  const corruptPath = `${path}.corrupt-${Date.now()}`;
  try {
    await rename(path, corruptPath);
  } catch {
    /* best effort */
  }
  return null;
}

/**
 * Persist the resolved chat id atomically. Creates the state directory at
 * mode 0o700 if missing.
 */
export async function writeCachedChatId(id: string): Promise<void> {
  ensureStateDir();
  const path = cachePath();
  const tmpPath = `${path}.tmp`;
  const payload: CachedChatId = {
    chat_id: id,
    cached_at: new Date().toISOString(),
  };
  await Bun.write(tmpPath, JSON.stringify(payload, null, 2) + "\n");
  await rename(tmpPath, path);
}

/**
 * Delete the cache file. Idempotent — swallows ENOENT and any other error.
 * Used by the dispatcher when a 401/403 startup probe indicates the cached
 * id is stale (token rotated, bot deactivated, etc).
 */
export async function clearCachedChatId(): Promise<void> {
  const path = cachePath();
  try {
    await unlink(path);
  } catch {
    /* best effort — file may already be absent */
  }
}
