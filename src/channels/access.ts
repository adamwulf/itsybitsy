/**
 * Telegram channel allowlist persistence.
 *
 * State lives at ~/.itsybitsy/channels/telegram/access.json with the schema:
 *   { allowed_chat_ids: string[], allowed_user_ids: string[] }
 *
 * Both lists default to empty, which means deny-all.
 *
 * Writes are atomic (.tmp + rename). On JSON parse failure, the corrupt file
 * is renamed aside to access.json.corrupt-<unix-ms> and we continue with an
 * empty allowlist — this module never throws on load.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { rename } from "fs/promises";

export interface AccessState {
  allowed_chat_ids: string[];
  allowed_user_ids: string[];
}

const EMPTY_STATE: AccessState = Object.freeze({
  allowed_chat_ids: [],
  allowed_user_ids: [],
}) as AccessState;

let overrideStateDir: string | undefined;

export function setStateDir(dir: string): void {
  overrideStateDir = dir;
}

export function resetStateDir(): void {
  overrideStateDir = undefined;
}

export function defaultStateDir(): string {
  return overrideStateDir ?? join(process.env.HOME ?? homedir(), ".itsybitsy", "channels", "telegram");
}

function accessPath(): string {
  return join(defaultStateDir(), "access.json");
}

function ensureStateDir(): void {
  mkdirSync(defaultStateDir(), { recursive: true, mode: 0o700 });
}

function emptyState(): AccessState {
  return { allowed_chat_ids: [], allowed_user_ids: [] };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function normalizeState(parsed: unknown): AccessState | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const chats = obj.allowed_chat_ids;
  const users = obj.allowed_user_ids;
  if (!isStringArray(chats) || !isStringArray(users)) return null;
  return { allowed_chat_ids: [...chats], allowed_user_ids: [...users] };
}

/**
 * Read the allowlist. Never throws — returns empty state if the file is
 * missing or corrupt. A corrupt file is renamed aside to
 * `access.json.corrupt-<timestamp>` so the user can recover it manually.
 */
export async function readAccess(): Promise<AccessState> {
  const path = accessPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return emptyState();
  let text: string;
  try {
    text = await file.text();
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(text);
    const state = normalizeState(parsed);
    if (state) return state;
  } catch {
    // fall through to corrupt-file handling
  }
  // Corrupt or wrong-shape — rename aside and continue with empty state.
  const corruptPath = `${path}.corrupt-${Date.now()}`;
  try {
    await rename(path, corruptPath);
  } catch {
    /* best effort */
  }
  return emptyState();
}

async function writeAccess(state: AccessState): Promise<void> {
  ensureStateDir();
  const path = accessPath();
  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(state, null, 2) + "\n");
  await rename(tmpPath, path);
}

/**
 * Add a chat_id to the allowlist. Idempotent.
 * Returns true if added, false if it was already present.
 */
export async function addChat(id: string): Promise<boolean> {
  const state = await readAccess();
  const idStr = String(id);
  if (state.allowed_chat_ids.includes(idStr)) return false;
  state.allowed_chat_ids.push(idStr);
  await writeAccess(state);
  return true;
}

/**
 * Remove a chat_id from the allowlist. Idempotent.
 * Returns true if removed, false if it was not present.
 */
export async function removeChat(id: string): Promise<boolean> {
  const state = await readAccess();
  const idStr = String(id);
  const idx = state.allowed_chat_ids.indexOf(idStr);
  if (idx === -1) return false;
  state.allowed_chat_ids.splice(idx, 1);
  await writeAccess(state);
  return true;
}

/**
 * Check whether a (chat_id, user_id) pair is allowed.
 *
 * Empty allowlists = deny-all. A non-empty `allowed_chat_ids` list permits
 * any sender in that chat; a non-empty `allowed_user_ids` list permits that
 * user from any chat. The two lists are OR'd.
 */
export async function isAllowed(chatId: string | number, userId: string | number | undefined): Promise<boolean> {
  const state = await readAccess();
  const chatStr = String(chatId);
  if (state.allowed_chat_ids.includes(chatStr)) return true;
  if (userId !== undefined && state.allowed_user_ids.includes(String(userId))) return true;
  return false;
}

/**
 * A chat_id whose stringified form starts with `-` is a Telegram group/supergroup.
 * Returns true if the id looks group-shaped. Phase 2 surfaces this as a warning
 * in `ib tgcheck` only — group-shaped IDs are NOT blocked from the allowlist
 * (the user may add a group deliberately, even though Phase 5 only routes 1:1 DMs).
 */
export function isGroupShaped(id: string | number): boolean {
  return String(id).startsWith("-");
}

// Re-export for tests / callers that prefer not to import the type by name.
export { EMPTY_STATE };
