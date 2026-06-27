/**
 * Telegram reaction emoji allowlist + validation.
 *
 * `setMessageReaction` only accepts emoji from Telegram's documented default
 * reaction set (https://core.telegram.org/bots/api#reactiontypeemoji). A chat
 * may additionally enable custom emoji, but v1 never produces those — we
 * restrict outbound reactions to the documented set so a typo or unsupported
 * emoji fails locally with a clear message instead of producing an opaque
 * `BAD_REQUEST: REACTION_INVALID` from the API.
 *
 * The set is mirrored verbatim from the Bot API docs as of 2026-06. Telegram
 * occasionally extends it; an emoji we don't recognize is rejected here rather
 * than sent — the user sees the supported set and can pick an alternative.
 */

/** Telegram's documented default reaction emoji set. Frozen so callers cannot
 *  mutate it. Order matches the Bot API docs listing. */
export const ALLOWED_REACTION_EMOJIS: ReadonlySet<string> = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱",
  "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡",
  "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡",
  "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨",
  "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂",
  "🤷", "🤷‍♀", "😡",
]);

/** Heart emoji is documented as `❤` (U+2764) but is commonly typed with the
 *  variation selector `❤️` (U+2764 U+FE0F). Telegram accepts the bare form;
 *  we normalize a trailing VS16 off so the common typed form validates and is
 *  sent in the documented shape. Same for the other VS16-bearing entries
 *  (`🔥` etc. are single code points already; only a handful carry VS16). */
const VARIATION_SELECTOR_16 = "️";

/** Canonicalize an emoji to the form Telegram documents: strip a trailing
 *  VS16 when the bare form is in the allowlist. Leaves everything else
 *  untouched. Exported for tests. */
export function canonicalizeReactionEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (ALLOWED_REACTION_EMOJIS.has(trimmed)) return trimmed;
  // Try stripping a single trailing VS16 (common when an emoji is typed/pasted
  // with the colorful presentation selector).
  if (trimmed.endsWith(VARIATION_SELECTOR_16)) {
    const bare = trimmed.slice(0, -VARIATION_SELECTOR_16.length);
    if (ALLOWED_REACTION_EMOJIS.has(bare)) return bare;
  }
  // Try ADDING a VS16 — some allowlist entries carry it (`❤‍🔥`); the user may
  // have typed the bare combining form.
  const withVs = trimmed + VARIATION_SELECTOR_16;
  if (ALLOWED_REACTION_EMOJIS.has(withVs)) return withVs;
  return trimmed;
}

/** True if `emoji` (after canonicalization) is a documented reaction emoji. */
export function isAllowedReactionEmoji(emoji: string): boolean {
  return ALLOWED_REACTION_EMOJIS.has(canonicalizeReactionEmoji(emoji));
}

/** Result of validating a user-supplied reaction emoji. */
export type ReactionValidation =
  | { ok: true; emoji: string }
  | { ok: false; message: string };

/** Validate + canonicalize a user-supplied reaction emoji for `setMessageReaction`.
 *  On success returns the documented form to send; on failure returns a
 *  human-readable message naming a few supported emoji as a hint. */
export function validateReactionEmoji(input: string): ReactionValidation {
  const trimmed = (input ?? "").trim();
  if (trimmed === "") {
    return { ok: false, message: "no emoji provided" };
  }
  const canonical = canonicalizeReactionEmoji(trimmed);
  if (!ALLOWED_REACTION_EMOJIS.has(canonical)) {
    const hint = ["👍", "👎", "❤", "🔥", "🎉", "😁"].join(" ");
    return {
      ok: false,
      message: `unsupported reaction emoji "${trimmed}". Telegram only allows its documented reaction set, e.g. ${hint}`,
    };
  }
  return { ok: true, emoji: canonical };
}
