/**
 * Clipboard read support for macOS (pbpaste).
 * Used by dialog text inputs to support Ctrl+V paste.
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Module-level paste reassembly state.
 *
 * Terminals deliver bracketed pastes as `\x1b[200~<content>\x1b[201~`. For long
 * pastes the content is split across multiple stdin read chunks. We buffer the
 * partial content here until the end marker arrives, then dispatch the full
 * paste via the caller's async callback.
 *
 * Module-level (rather than per-component) is correct because only one input
 * field has focus at a time, and stdin chunks are processed sequentially.
 */
let pasteInProgress: { buffer: string } | null = null;

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
  if (!data.startsWith(PASTE_START)) return null;
  const endIdx = data.indexOf(PASTE_END);
  if (endIdx !== -1) {
    return data.slice(PASTE_START.length, endIdx);
  }
  return data.slice(PASTE_START.length);
}

/** Cancel any in-progress chunked bracketed paste, discarding its buffered prefix.
 *  Callers should invoke this when input focus is interrupted (e.g. user presses
 *  Escape, dialog closes) so a paste that never receives its end marker cannot
 *  silently swallow subsequent input. */
export function cancelPaste(): void {
  pasteInProgress = null;
}

/** Test-only alias for cancelPaste — retained so test setup reads as state reset. */
export function resetPasteState(): void {
  pasteInProgress = null;
}

/** Test-only: returns true if a chunked bracketed paste is currently being assembled. */
export function isPasteInProgress(): boolean {
  return pasteInProgress !== null;
}

/** Resolve paste data from input.
 *  Returns the text to insert synchronously (for single-chunk bracketed paste / multi-char paste),
 *  or null if the data does not produce immediate text.
 *  Null may mean: not paste data, Ctrl+V (clipboard read in progress), or a bracketed paste that
 *  is split across multiple read chunks (continued via subsequent calls).
 *  In the chunked-paste case, the assembled text is delivered to onAsyncPaste once complete. */
export function resolvePasteText(
  data: string,
  onAsyncPaste: (text: string) => void,
): string | null {
  // Continuation chunk for an in-progress bracketed paste.
  if (pasteInProgress !== null) {
    const endIdx = data.indexOf(PASTE_END);
    if (endIdx !== -1) {
      // Paste completes in this chunk. Append prefix, finalize, deliver via callback.
      // Trailing data after PASTE_END is dropped (consistent with single-chunk behavior).
      const finalText = pasteInProgress.buffer + data.slice(0, endIdx);
      pasteInProgress = null;
      onAsyncPaste(finalText);
      return null;
    }
    // Still no end marker — keep buffering.
    pasteInProgress.buffer += data;
    return null;
  }

  // Ctrl+V (0x16) → async clipboard read
  if (data === "\x16") {
    readClipboard().then((text) => {
      if (text) onAsyncPaste(text);
    });
    return null;
  }

  // Bracketed paste sequence (start marker present)
  if (data.startsWith(PASTE_START)) {
    const endIdx = data.indexOf(PASTE_END);
    if (endIdx !== -1) {
      // Complete paste in a single chunk.
      return data.slice(PASTE_START.length, endIdx);
    }
    // Start marker without end marker — paste is split across chunks.
    pasteInProgress = { buffer: data.slice(PASTE_START.length) };
    return null;
  }

  // Multi-character paste (printable text, not an escape sequence)
  if (isPasteData(data)) return data;
  return null;
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
