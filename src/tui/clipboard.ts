/**
 * Clipboard read support for macOS (pbpaste).
 * Used by dialog text inputs to support Ctrl+V paste.
 */

/** Read the system clipboard contents via pbpaste. Returns empty string on failure. */
export async function readClipboard(): Promise<string> {
  try {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}

/** Check if data looks like a multi-character paste (all printable, not an escape sequence). */
export function isPasteData(data: string): boolean {
  if (data.length <= 1) return false;
  if (data.charCodeAt(0) < 0x20) return false; // starts with control char (includes ESC)
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    // Allow printable ASCII + newlines + tabs + any char >= 0x80 (unicode)
    if (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) return false;
  }
  return true;
}

/** Extract text from a bracketed paste sequence (\x1b[200~ ... \x1b[201~). */
export function extractBracketedPaste(data: string): string | null {
  const startMarker = "\x1b[200~";
  const endMarker = "\x1b[201~";
  if (!data.startsWith(startMarker)) return null;
  const endIdx = data.indexOf(endMarker);
  if (endIdx !== -1) {
    return data.slice(startMarker.length, endIdx);
  }
  return data.slice(startMarker.length);
}

/** Insert pasted text into a textarea-style lines array.
 *  Appends to the last line, then splits on newlines for multiline paste. */
export function insertTextIntoLines(lines: string[], text: string): void {
  const parts = text.split(/\r?\n/);
  const lastIdx = lines.length - 1;
  lines[lastIdx] = (lines[lastIdx] ?? "") + parts[0];
  for (let i = 1; i < parts.length; i++) {
    lines.push(parts[i]!);
  }
}
