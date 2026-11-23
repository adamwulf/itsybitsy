import { copyFile, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { canonicalizeSandboxPath } from "./sandbox";
import { userHome } from "./home";

export interface PathReference {
  start: number;
  end: number;
  path: string;
  quote?: string;
}

export interface StagedMessage {
  message: string;
  staged: boolean;
  /** A leading file reference is message text even if it stays in the live tree. */
  noPassthrough?: boolean;
  /** Only for attempts that were NOT accepted into the delivery queue. */
  cleanup: () => Promise<void>;
}

function pathStart(text: string, offset: number): boolean {
  return (text[offset] === "/" && text[offset + 1] !== "/")
    || text.startsWith("./", offset) || text.startsWith("../", offset)
    || text.startsWith("~/", offset);
}

/** Closing offsets for Markdown code spans and fenced blocks. Fences split the
 * text into blocks, so an unmatched inline opener cannot consume a fence. */
function markdownCodeEnds(text: string): Map<number, number> {
  const ends = new Map<number, number>();
  function inline(start: number, end: number) {
    const runs = [...text.slice(start, end).matchAll(/`+/g)];
    const nextByWidth = new Map<number, number>();
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i]!;
      const pos = start + run.index;
      const width = run[0].length;
      // At an unmatched run, skip the entire delimiter as ordinary prose.
      ends.set(pos, (nextByWidth.get(width) ?? pos) + width);
      nextByWidth.set(width, pos);
    }
  }
  let start = 0;
  let fence: { pos: number; marker: string } | undefined;
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm)) {
    const [, marker, rest] = match;
    if (fence) {
      if (marker![0] === fence.marker[0] && marker!.length >= fence.marker.length && /^[ \t]*$/.test(rest!)) {
        start = match.index + match[0].length;
        ends.set(fence.pos, start);
        fence = undefined;
      }
    } else if (marker![0] !== "`" || !rest!.includes("`")) {
      inline(start, match.index);
      fence = { pos: match.index, marker: marker! };
    }
  }
  if (fence) ends.set(fence.pos, text.length);
  else inline(start, text.length);
  return ends;
}

export const TRAILING_PATH_PUNCTUATION = /[.,;:!\)\]}]$/;

/** A quote can be followed by prose punctuation, but not a filename suffix. */
function endsPathToken(text: string, end: number): boolean {
  while (end < text.length && TRAILING_PATH_PUNCTUATION.test(text[end]!)) end++;
  return end === text.length || /[ \t\r\n<>`]/.test(text[end]!);
}

/** Read terminal drag/drop spelling as data; never invoke a shell. Offsets
 * refer to the original text so replacing a path preserves surrounding prose. */
export function references(text: string, { tolerateMalformed = false } = {}): PathReference[] {
  const found: PathReference[] = [];
  const code = markdownCodeEnds(text);
  for (let i = 0; i < text.length; i++) {
    const codeEnd = code.get(i);
    if (codeEnd !== undefined) {
      i = codeEnd - 1;
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
    let malformed: string | undefined;
    for (i = pathOffset; i < text.length; i++) {
      const char = text[i]!;
      if (quote ? char === quote : /[ \t\r\n<>`]/.test(char)) {
        closed = true;
        break;
      }
      if (char === "\\" && quote !== "'") {
        const next = text[i + 1];
        if (next === undefined || /[\r\n]/.test(next)) {
          malformed = "Incomplete escape in attachment path";
          break;
        }
        // Double quotes only unescape shell-special characters. A backslash
        // before an ordinary character remains part of the filename.
        if (!quote || /[\\"$`]/.test(next)) {
          path += next;
          i++;
        } else path += char;
      } else path += char;
    }
    if (!closed) malformed ??= "Unclosed quote in attachment path";
    if (/[\x00-\x1f]/.test(path)) malformed ??= "Attachment paths cannot contain control characters";
    if (malformed) {
      if (!tolerateMalformed) throw new Error(malformed);
      // Resume at the next token; a malformed reference owns no replacement.
      i = pathOffset;
      while (i < text.length && !/[ \t\r\n]/.test(text[i]!)) i++;
      i--;
      continue;
    }
    const end = i + (quote ? 1 : 0);
    if (path === "/") continue;
    if (quote && !endsPathToken(text, end)) continue;
    found.push({ start, end, path, quote });
    if (!quote) i--;
  }
  return found;
}

export function spellPath(path: string, quote?: string): string {
  if (quote === "'") return `'${path.replaceAll("'", "'\\''")}'`;
  if (quote === '"') return `"${path.replace(/[\\"$`]/g, "\\$&")}"`;
  return path.replace(/[\s\\'"`$&;|<>(){}\[\]!?*#~]/g, "\\$&");
}

/** Stage only the FINAL submitted text. Each attempt owns a fresh /tmp dir;
 * successful sends retain it for queued delivery and later reads. There is
 * deliberately no acknowledgment-based cleanup or age-based expiry here:
 * the OS/user may clean /tmp, but ib must not invalidate a pending message. */
export async function stageMessageAttachments(message: string, baseDir: string, liveRoot?: string): Promise<StagedMessage> {
  const parsed = references(message);
  const files: Array<PathReference & { source: string }> = [];
  let noPassthrough = false;
  const repoRoot = resolve(baseDir);
  const canonicalLiveRoot = liveRoot ? canonicalizeSandboxPath(liveRoot) : undefined;
  const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
  const resolveReference = (path: string): string => {
    let source = path.startsWith("~/")
      ? resolve(userHome(), path.slice(2))
      : resolve(baseDir, path);
    // A relative project reference means the recipient's live checkout, even
    // when baseDir is the main repository and the recipient has a worktree.
    // Preserve future files too: "create ./src/new.ts" is an instruction, not
    // an attempt to attach a missing file. Relative paths outside the project
    // still resolve against baseDir for attachment staging.
    if (liveRoot && !path.startsWith("/") && inside(repoRoot, source)) {
      source = resolve(liveRoot, relative(repoRoot, source));
    }
    return source;
  };
  const isLiveReference = (path: string): boolean => {
    if (!canonicalLiveRoot) return false;
    // Resolve existing symlink prefixes so a project symlink pointing outside
    // the worktree is still staged instead of leaving an inaccessible path.
    return inside(canonicalLiveRoot, canonicalizeSandboxPath(resolveReference(path)));
  };
  for (const reference of parsed) {
    let path = reference.path;
    let end = reference.end;
    for (;;) {
      const source = resolveReference(path);
      try {
        const info = await stat(source);
        if (isLiveReference(path)) {
          if (reference.start === 0) noPassthrough = true;
          break;
        }
        if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${reference.path} (directories are not copied)`);
        files.push({ ...reference, path, end, source: await realpath(source) });
        if (reference.start === 0) noPassthrough = true;
        break;
      } catch (error) {
        // A missing, unquoted /clear-style name is a slash command. Existing
        // root-level files and explicitly quoted references are still files.
        if (!reference.quote && /^\/[\w-]+$/.test(path) && (error as NodeJS.ErrnoException).code === "ENOENT") break;
        // Bare paths may end in prose/Markdown punctuation. Never trim a
        // quoted filename, and prefer the exact existing name first.
        if (!reference.quote && (error as NodeJS.ErrnoException).code === "ENOENT" && TRAILING_PATH_PUNCTUATION.test(path)) {
          path = path.slice(0, -1);
          end--;
          continue;
        }
        // No successful stat is required for a future live project reference.
        // Resolve punctuation first so "./external-symlink.png," cannot hide
        // an external target behind a nonexistent name ending in a comma.
        if (isLiveReference(path)) {
          if (reference.start === 0) noPassthrough = true;
          break;
        }
        throw new Error(`Cannot stage attachment ${JSON.stringify(reference.path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!files.length) return { message, staged: false, noPassthrough, cleanup: async () => {} };

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
    return { message: result, staged: true, noPassthrough, cleanup };
  } catch (error) {
    await cleanup();
    throw new Error(`Could not copy message attachments: ${error instanceof Error ? error.message : String(error)}`);
  }
}
