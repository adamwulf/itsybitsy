import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { canonicalizeSandboxPath } from "../sandbox";
import { sanitizeAttachmentName } from "./attachment-name";
import { CHUNK_BYTES, checkManifestLimits, DEFAULT_TRANSFER_LIMITS, type TransferLimits } from "./transfer-limits";

// Bun normalizes ".." before its realpath call. Resolve the directory to
// the left of each parent step first, leaving symlink traversal to the OS.
async function realpathArgument(absolute: string): Promise<string> {
  const parts = absolute.split(/\/\.\.(?=\/|$)/);
  let prefix = parts[0]!;
  for (const rest of parts.slice(1)) {
    const directory = await realpath(prefix || sep);
    if (!(await stat(directory)).isDirectory()) throw new Error("parent component requires a directory");
    prefix = dirname(directory) + rest;
  }
  return realpath(prefix);
}

export interface ManifestEntry {
  argument: string;
  source: string;
  name: string;
  size: number;
  spellings: string[];
  /** Owned by the caller. Hash and stage from this handle, then close it. */
  handle: FileHandle;
}

interface ManifestOptions {
  cwd: string;
  home: string;
  limits?: TransferLimits;
  machine?: string;
}

export async function buildAttachmentManifest(
  paths: readonly string[], { cwd, home, limits = DEFAULT_TRANSFER_LIMITS, machine = "this machine" }: ManifestOptions,
): Promise<ManifestEntry[]> {
  if (!paths.length) return [];
  const protectedDirs = ["peer", "sealed"].map(name => canonicalizeSandboxPath(join(home, ".itsybitsy", name)));
  const entries = new Map<string, ManifestEntry>();
  try {
    for (const argument of paths) {
      // Let the filesystem walk symlinks before interpreting a following "..".
      const expanded = argument === "~" ? home : argument.startsWith("~/") ? home + argument.slice(1) : argument;
      const absolute = isAbsolute(expanded) ? expanded : cwd + sep + expanded;
      try {
        const source = await realpathArgument(absolute);
        if (protectedDirs.some(dir => source === dir || source.startsWith(dir + sep))) {
          throw new Error("protected attachment path");
        }
        let entry = entries.get(source);
        if (!entry) {
          const before = await stat(source, { bigint: true });
          if (!before.isFile()) throw new Error("not a regular file");
          // NONBLOCK prevents a racing FIFO from hanging open. NOFOLLOW
          // refuses a symlink substituted in the final component.
          const handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          try {
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
                await realpath(source) !== source) throw new Error("file changed while opening");
            entry = { argument, source, handle, size: Number(opened.size), name: sanitizeAttachmentName(basename(absolute)), spellings: [] };
            const result = checkManifestLimits([...entries.values(), entry], limits, { machine });
            if (!result.ok) throw new Error(result.error);
            entries.set(source, entry);
          } catch (error) {
            await handle.close();
            throw error;
          }
        }
        const spellingPath = absolute.split(sep).includes("..") ? absolute : normalize(absolute);
        for (const spelling of [argument, spellingPath, source]) {
          if (!entry.spellings.includes(spelling)) entry.spellings.push(spelling);
        }
      } catch (error) {
        throw new Error(`Cannot attach ${JSON.stringify(argument)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    return Array.from(entries.values());
  } catch (error) {
    await Promise.allSettled(Array.from(entries.values(), entry => entry.handle.close()));
    throw error;
  }
}

/** Positional reads let hashing and staging share the same validated handle.
 * Each iteration reuses the buffer, so consume the chunk before advancing. */
export async function* fileChunks(file: FileHandle): AsyncGenerator<Buffer> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

export async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fileChunks(file)) hash.update(chunk);
  return hash.digest("hex");
}
