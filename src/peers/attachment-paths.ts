import { references, spellPath, TRAILING_PATH_PUNCTUATION } from "../message-attachments";

export interface AttachmentMapping {
  spellings: readonly string[];
  destination: string;
}

/** Bare filenames are prose. Only path-prefixed references are rewritten;
 * a bare --attach argument still gets a destination on the Attachments line. */
export function rewriteAttachmentPaths(message: string, mapping: readonly AttachmentMapping[]): string {
  if (!mapping.length) return message;
  const bySpelling = new Map<string, AttachmentMapping>();
  for (const file of mapping) {
    for (const spelling of file.spellings) bySpelling.set(spelling, file);
  }
  const seen = new Set<AttachmentMapping>();
  let cursor = 0;
  let result = "";
  for (const ref of references(message, { tolerateMalformed: true })) {
    let { path, end } = ref;
    let file = bySpelling.get(path);
    while (!file && !ref.quote && TRAILING_PATH_PUNCTUATION.test(path)) {
      path = path.slice(0, -1);
      end--;
      file = bySpelling.get(path);
    }
    if (!file) continue;
    seen.add(file);
    result += message.slice(cursor, ref.start) + spellPath(file.destination, ref.quote);
    cursor = end;
  }
  result += message.slice(cursor);
  const missing = mapping.filter(file => !seen.has(file)).map(file => spellPath(file.destination));
  if (missing.length) result += "\n\nAttachments: " + missing.join(" ");
  return result;
}
