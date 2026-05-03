/**
 * Minimal hand-rolled subset of Telegram Bot API types.
 *
 * Phase 4 stub: just enough for `getUpdates` and `sendMessage` shapes.
 * Phase 2 owns the full version of this file (with TelegramChat etc.).
 * If Phase 2 lands first, the merge of Phase 4 onto Phase 2 should keep
 * Phase 2's superset and drop these stubs. If Phase 4 lands first, Phase 5
 * (which depends on both) will reconcile any conflicts.
 *
 * No grammy. No external types.
 */

export interface TelegramChat {
  id: number;
  type?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  text?: string;
  caption?: string;
  /** Present on photo/document/voice/etc. messages — used by the dispatcher
   * to decide attachment-fallback behavior. Loosely typed since v1 doesn't
   * download files. */
  photo?: unknown;
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  video_note?: unknown;
  sticker?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/** Bot API response envelope. */
export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}
