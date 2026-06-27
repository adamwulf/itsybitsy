/**
 * Telegram last-inbound-message cache.
 *
 * Persists the most recent inbound message the dispatcher delivered, at
 *   ~/.itsybitsy/channels/telegram/last-message.json
 * with the schema:
 *   { chat_id: string, message_id: number, cached_at: string (ISO 8601) }
 *
 * Why: `ib tgreact <emoji>` runs as a short-lived per-shell process (like
 * `ib tgsend`) and has no access to the dispatcher's in-memory state. To react
 * to "Adam's latest message" it reads this cache for the target chat_id +
 * message_id. `ib watch`'s dispatcher writes it every time it delivers an
 * inbound user message (text or attachment) to the coordinator.
 *
 * Co-located with access.json / chat-id-cache.json under the `telegram`
 * state dir so all channel state shares one directory and one test override
 * (`access.setStateDir`).
 *
 * Writes are atomic (.tmp + rename). On JSON parse failure or wrong-shape
 * content the corrupt file is renamed aside to
 * `last-message.json.corrupt-<unix-ms>` and we return null — this module
 * never throws on read.
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { rename } from "fs/promises";
import { defaultStateDir as accessDefaultStateDir } from "./access";

export interface CachedLastMessage {
  chat_id: string;
  message_id: number;
  cached_at: string;
}

let overrideStateDir: string | undefined;

export function setStateDir(dir: string): void {
  overrideStateDir = dir;
}

export function resetStateDir(): void {
  overrideStateDir = undefined;
}

/** Directory containing the cache file. Local override wins; otherwise falls
 *  through to access.ts's `defaultStateDir()` so all channel state co-locates
 *  (and tests that set the dir via `access.setStateDir` get this too). */
export function defaultStateDir(): string {
  return overrideStateDir ?? accessDefaultStateDir();
}

function cachePath(): string {
  return join(defaultStateDir(), "last-message.json");
}

function ensureStateDir(): void {
  mkdirSync(defaultStateDir(), { recursive: true, mode: 0o700 });
}

function normalize(parsed: unknown): CachedLastMessage | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const chatId = obj.chat_id;
  const messageId = obj.message_id;
  const cachedAt = obj.cached_at;
  if (typeof chatId !== "string" || chatId === "") return null;
  if (typeof messageId !== "number" || !Number.isFinite(messageId)) return null;
  if (typeof cachedAt !== "string") return null;
  return { chat_id: chatId, message_id: messageId, cached_at: cachedAt };
}

/**
 * Read the cached last inbound message. Never throws — returns null when the
 * file is missing, empty, malformed, or wrong-shape. A corrupt file is renamed
 * aside to `last-message.json.corrupt-<timestamp>`.
 */
export async function readLastMessage(): Promise<CachedLastMessage | null> {
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
    if (normalized) return normalized;
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
 * Persist the latest inbound message id + chat id atomically. Creates the
 * state directory at mode 0o700 if missing.
 */
export async function writeLastMessage(chatId: string, messageId: number): Promise<void> {
  ensureStateDir();
  const path = cachePath();
  const tmpPath = `${path}.tmp`;
  const payload: CachedLastMessage = {
    chat_id: chatId,
    message_id: messageId,
    cached_at: new Date().toISOString(),
  };
  await Bun.write(tmpPath, JSON.stringify(payload, null, 2) + "\n");
  await rename(tmpPath, path);
}
