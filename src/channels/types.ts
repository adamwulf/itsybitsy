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

/** One size of a photo. A photo message carries an array of these, smallest
 *  to largest; the dispatcher picks the LAST element (full resolution) to
 *  download. Only `file_id` is guaranteed; `file_size` may be absent on some
 *  sizes (Telegram omits it for thumbnails occasionally). */
export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  /** Bytes. Used for the 20 MB download guard when present. */
  file_size?: number;
}

/** A general file/document attachment (`document` field). `file_name` and
 *  `mime_type` are user/Telegram-supplied — never trust `file_name` for an
 *  on-disk path (path traversal); sanitize via `safeName()`. */
export interface Document {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** A voice note (`voice` field). Ogg/Opus, no file_name. */
export interface Voice {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

/** An audio file (`audio` field). May carry title/performer/file_name. */
export interface Audio {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** A video file (`video` field). */
export interface Video {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** A round video note (`video_note` field). Square video; no file_name. */
export interface VideoNote {
  file_id: string;
  file_unique_id: string;
  length?: number;
  duration?: number;
  file_size?: number;
}

/** A sticker (`sticker` field). WEBP/TGS/WEBM; no file_name. */
export interface Sticker {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
  set_name?: string;
  file_size?: number;
}

/** Result of `getFile` — Telegram returns a `file_path` we use to build the
 *  download URL (`/file/bot<token>/<file_path>`). `file_size` here is the
 *  authoritative size when the message-level field was absent. */
export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  /** Relative path under the bot's file storage; combined with the token to
   *  form the download URL. Absent for files Telegram declines to serve. */
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  text?: string;
  caption?: string;
  /** Present on photo/document/voice/etc. messages. The dispatcher downloads
   *  the file and surfaces a local path to the coordinator. Photos arrive as
   *  an array of sizes (largest is last); other kinds are a single object. */
  photo?: PhotoSize[];
  document?: Document;
  voice?: Voice;
  audio?: Audio;
  video?: Video;
  video_note?: VideoNote;
  sticker?: Sticker;
}

/** A single reaction. v1 only emits/consumes `type: "emoji"`; custom-emoji
 *  reactions (`type: "custom_emoji"`) and paid reactions are tolerated on the
 *  inbound side but never produced on the outbound side. */
export interface ReactionTypeEmoji {
  type: "emoji";
  emoji: string;
}

export interface ReactionTypeCustomEmoji {
  type: "custom_emoji";
  custom_emoji_id: string;
}

export type ReactionType = ReactionTypeEmoji | ReactionTypeCustomEmoji | { type: string };

/** `message_reaction` update payload — fires when a user adds/removes a
 *  reaction on a message the bot can see. In a private chat the actor is in
 *  `user`; in anonymous group contexts the actor is in `actor_chat` and `user`
 *  is absent (we don't route groups, but the shape is kept correct). */
export interface MessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  actor_chat?: TelegramChat;
  date?: number;
  old_reaction: ReactionType[];
  new_reaction: ReactionType[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  message_reaction?: MessageReactionUpdated;
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
