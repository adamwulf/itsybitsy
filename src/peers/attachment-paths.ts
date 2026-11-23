import { references, spellPath } from "../message-attachments";

export interface AttachmentMapping {
  spellings: readonly string[];
  destination: string;
}

export function rewriteAttachmentPaths(message: string, mapping: readonly AttachmentMapping[]): string {
  if (!mapping.length) return message;
  const bySpelling = new Map<string, AttachmentMapping>();
  for (const file of mapping) {
    for (const spelling of file.spellings) bySpelling.set(spelling, file);
  }
  const seen = new Set<AttachmentMapping>();
  let cursor = 0;
  let result = "";
  for (const ref of references(message)) {
    const file = bySpelling.get(ref.path);
    if (!file) continue;
    seen.add(file);
    result += message.slice(cursor, ref.start) + spellPath(file.destination, ref.quote);
    cursor = ref.end;
  }
  result += message.slice(cursor);
  const missing = mapping.filter(file => !seen.has(file)).map(file => spellPath(file.destination));
  if (missing.length) result += "\n\nAttachments: " + missing.join(" ");
  return result;
}
