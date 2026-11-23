import { spellPath } from "../message-attachments";

export interface AttachmentMapping {
  spellings: readonly string[];
  destination: string;
}

type Replacement = { form: string; replacement: string };

/** Match literal filesystem spellings and their three terminal forms between
 * whitespace boundaries. Walk the original text so replacements cannot cascade. */
export function rewriteAttachmentPaths(message: string, mapping: readonly AttachmentMapping[]): string {
  if (!mapping.length) return message;
  const byFirstWord = new Map<string, Replacement[]>();
  const lines = ["Attachments copied to this machine:"];
  for (const { spellings, destination } of mapping) {
    lines.push(`- ${spellings[0]} → ${spellPath(destination)}`);
    for (const spelling of spellings) {
      for (const quote of [undefined, "'", '"']) {
        const forms = new Set([spellPath(spelling, quote)]);
        if (!quote) forms.add(spelling);
        for (const form of forms) {
          if (!form) continue;
          const first = /^\S*/.exec(form)![0];
          const bucket = byFirstWord.get(first) ?? [];
          bucket.push({ form, replacement: spellPath(destination, quote) });
          byFirstWord.set(first, bucket);
        }
      }
    }
  }
  for (const bucket of byFirstWord.values()) bucket.sort((a, b) => b.form.length - a.form.length);

  let result = "";
  let cursor = 0;
  for (let pos = 0; pos < message.length;) {
    if (pos > 0 && !/\s/.test(message[pos - 1]!)) { pos++; continue; }
    let end = pos;
    while (end < message.length && !/\s/.test(message[end]!)) end++;
    const match = byFirstWord.get(message.slice(pos, end))?.find(({ form }) => {
      const after = pos + form.length;
      return message.startsWith(form, pos) && (after === message.length || /\s/.test(message[after]!));
    });
    if (match) {
      result += message.slice(cursor, pos) + match.replacement;
      pos += match.form.length;
      cursor = pos;
    } else {
      pos = Math.max(end, pos + 1);
    }
  }
  return result + message.slice(cursor) + "\n\n" + lines.join("\n");
}
