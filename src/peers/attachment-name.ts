import { posix } from "node:path";

const MAX_NAME_BYTES = 200;

function utf8Prefix(value: string, budget: number): string {
  let end = 0;
  for (const char of value) {
    budget -= Buffer.byteLength(char);
    if (budget < 0) break;
    end += char.length;
  }
  return value.slice(0, end);
}

export function sanitizeAttachmentName(name: string): string {
  const base = posix.basename(name.replaceAll("\\", "/"))
    .replaceAll("\0", "_").replace(/[\p{Cc}\p{Cf}]/gu, "");
  if (!base || base === "." || base === "..") return "attachment";
  if (Buffer.byteLength(base) <= MAX_NAME_BYTES) return base;

  const extension = posix.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  // An extension may itself exceed the budget. Keep at least the first stem character.
  const first = String.fromCodePoint(stem.codePointAt(0)!);
  const suffix = utf8Prefix(extension, MAX_NAME_BYTES - Buffer.byteLength(first));
  return utf8Prefix(stem, MAX_NAME_BYTES - Buffer.byteLength(suffix)) + suffix;
}
