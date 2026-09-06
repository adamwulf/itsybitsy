import { copyFile, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve } from "node:path";

interface PathReference {
  start: number;
  end: number;
  path: string;
  quote?: string;
}

export interface StagedMessage {
  message: string;
  staged: boolean;
  /** Only for attempts that were NOT accepted into the delivery queue. */
  cleanup: () => Promise<void>;
}

function pathStart(text: string, offset: number): boolean {
  return (text[offset] === "/" && text[offset + 1] !== "/")
    || text.startsWith("./", offset) || text.startsWith("../", offset);
}

/** Read terminal drag/drop spelling as data; never invoke a shell. Offsets
 * refer to the original text so replacing a path preserves surrounding prose. */
function references(text: string): PathReference[] {
  const found: PathReference[] = [];
  for (let i = 0; i < text.length; i++) {
    // Code spans/fences are examples, not attachment requests.
    if (text[i] === "`") {
      let width = 1;
      while (text[i + width] === "`") width++;
      const close = text.indexOf("`".repeat(width), i + width);
      if (close < 0) {
        // An unfinished fenced block is still code. An unmatched inline
        // delimiter is ordinary prose and must not hide later attachments.
        if (width >= 3) break;
        i += width - 1;
        continue;
      }
      i = close + width - 1;
      continue;
    }
    const previous = text[i - 1];
    if (previous !== undefined && !/[ \t\r\n([<]/.test(previous)) continue;
    const quote = text[i] === '"' || text[i] === "'" ? text[i] : undefined;
    const pathOffset = i + (quote ? 1 : 0);
    if (!pathStart(text, pathOffset)) continue;
    const start = i;
    let path = "";
    let closed = !quote;
    for (i = pathOffset; i < text.length; i++) {
      const char = text[i]!;
      if (quote ? char === quote : /[ \t\r\n<>`]/.test(char)) {
        closed = true;
        break;
      }
      if (char === "\\" && quote !== "'") {
        const next = text[i + 1];
        if (next === undefined || /[\r\n]/.test(next)) throw new Error("Incomplete escape in attachment path");
        // Double quotes only unescape shell-special characters. A backslash
        // before an ordinary character remains part of the filename.
        if (!quote || /[\\"$`]/.test(next)) {
          path += next;
          i++;
        } else path += char;
      } else path += char;
    }
    if (!closed) throw new Error("Unclosed quote in attachment path");
    const end = i + (quote ? 1 : 0);
    if (path === "/") continue;
    if (/[\x00-\x1f]/.test(path)) throw new Error("Attachment paths cannot contain control characters");
    found.push({ start, end, path, quote });
    if (!quote) i--;
  }
  return found;
}

function spellPath(path: string, quote?: string): string {
  if (quote === "'") return `'${path.replaceAll("'", "'\\''")}'`;
  if (quote === '"') return `"${path.replace(/[\\"$`]/g, "\\$&")}"`;
  return path.replace(/[\s\\'"`$&;|<>(){}\[\]!?*#~]/g, "\\$&");
}

/** Stage only the FINAL submitted text. Each attempt owns a fresh /tmp dir;
 * successful sends retain it for queued delivery and later reads. There is
 * deliberately no acknowledgment-based cleanup or age-based expiry here:
 * the OS/user may clean /tmp, but ib must not invalidate a pending message. */
export async function stageMessageAttachments(message: string, baseDir: string): Promise<StagedMessage> {
  const parsed = references(message);
  const files: Array<PathReference & { source: string }> = [];
  for (const reference of parsed) {
    let path = reference.path;
    let end = reference.end;
    for (;;) {
      const source = resolve(baseDir, path);
      try {
        const info = await stat(source);
        if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${reference.path} (directories are not copied)`);
        files.push({ ...reference, path, end, source: await realpath(source) });
        break;
      } catch (error) {
        // A missing, unquoted /clear-style name is a slash command. Existing
        // root-level files and explicitly quoted references are still files.
        if (!reference.quote && /^\/[\w-]+$/.test(path) && (error as NodeJS.ErrnoException).code === "ENOENT") break;
        // Bare paths may end in prose/Markdown punctuation. Never trim a
        // quoted filename, and prefer the exact existing name first.
        if (!reference.quote && (error as NodeJS.ErrnoException).code === "ENOENT" && /[.,;:!\)\]}]$/.test(path)) {
          path = path.slice(0, -1);
          end--;
          continue;
        }
        throw new Error(`Cannot stage attachment ${JSON.stringify(reference.path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!files.length) return { message, staged: false, cleanup: async () => {} };

  // Use /tmp explicitly, not TMPDIR (which on macOS can be outside the
  // sandbox's /private/tmp floor). mkdtemp + COPYFILE_EXCL prevent collisions.
  const directory = await mkdtemp("/tmp/itsybitsy-attachments-");
  const cleanup = async () => { await rm(directory, { recursive: true, force: true }); };
  try {
    const destinations = new Map<string, string>();
    let result = "";
    let cursor = 0;
    for (const file of files) {
      let destination = destinations.get(file.source);
      if (!destination) {
        const fileDir = join(directory, String(destinations.size));
        await mkdir(fileDir);
        destination = join(fileDir, basename(file.path));
        await copyFile(file.source, destination, constants.COPYFILE_EXCL);
        destinations.set(file.source, destination);
      }
      result += message.slice(cursor, file.start) + spellPath(destination, file.quote);
      cursor = file.end;
    }
    result += message.slice(cursor);
    return { message: result, staged: true, cleanup };
  } catch (error) {
    await cleanup();
    throw new Error(`Could not copy message attachments: ${error instanceof Error ? error.message : String(error)}`);
  }
}
