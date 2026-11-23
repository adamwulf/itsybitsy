import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { canonicalizeSandboxPath } from "../sandbox";
import { sanitizeAttachmentName } from "./attachment-name";
import { CHUNK_BYTES, checkAttachmentsEnabled, checkManifestLimits, DEFAULT_TRANSFER_LIMITS, type TransferLimits } from "./transfer-limits";

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

function fileIdentity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}`;
}

/** Follow directory links once per identity. Only ENOENT from the initial
 * lstat of a root means an empty tree; failures below it invalidate the scan. */
async function protectedIdentities(roots: string[]): Promise<Set<string>> {
  const identities = new Set<string>();
  async function visit(path: string, info: BigIntStats) {
    const id = fileIdentity(info);
    if (identities.has(id)) return;
    identities.add(id);
    if (!info.isDirectory()) return;
    for (const name of await readdir(path)) {
      const child = join(path, name);
      await visit(child, await stat(child, { bigint: true }));
    }
    const after = await stat(path, { bigint: true });
    if (fileIdentity(after) !== id || after.ctimeNs !== info.ctimeNs) throw new Error("directory changed during enumeration");
  }
  for (const root of roots) {
    try {
      const entry = await lstat(root, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!entry) continue;
      const info = entry.isSymbolicLink() ? await stat(root, { bigint: true }) : entry;
      if (!info.isDirectory()) throw new Error("root is not a directory");
      await visit(root, info);
    } catch (error) {
      throw new Error(`Cannot enumerate protected attachment tree ${JSON.stringify(root)}: ${error}`, { cause: error });
    }
  }
  return identities;
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
  machine: string;
}

export async function buildAttachmentManifest(
  paths: readonly string[], { cwd, home, limits = DEFAULT_TRANSFER_LIMITS, machine }: ManifestOptions,
): Promise<ManifestEntry[]> {
  if (!paths.length) return [];
  const enabled = checkAttachmentsEnabled(limits, machine);
  if (!enabled.ok) throw new Error(enabled.error);
  const roots = ["peer", "sealed"].map(name => join(home, ".itsybitsy", name));
  const protectedDirs = roots.map(root => canonicalizeSandboxPath(root));
  const protectedFiles = await protectedIdentities(roots);
  const entries = new Map<string, ManifestEntry>();
  try {
    for (const argument of paths) {
      // Let the filesystem walk symlinks before interpreting a following "..".
      const expanded = argument === "~" ? home : argument.startsWith("~/") ? home + argument.slice(1) : argument;
      const absolute = isAbsolute(expanded) ? expanded : cwd + sep + expanded;
      try {
        if (absolute.endsWith("/") || absolute.endsWith("/.")) throw new Error("directory spelling is not a regular file");
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
            if (protectedFiles.has(fileIdentity(opened))) throw new Error("protected attachment identity");
            entry = { argument, source, handle, size: Number(opened.size), name: sanitizeAttachmentName(basename(absolute)), spellings: [] };
            const result = checkManifestLimits([...entries.values(), entry], limits, { machine });
            if (!result.ok) throw new Error(result.error);
            entries.set(source, entry);
          } catch (error) {
            await handle.close();
            throw error;
          }
        }
        for (const spelling of [argument, source]) {
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
export async function* fileChunks(file: FileHandle, expectedSize: number): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error("Invalid file body size");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  while (position < expectedSize) {
    const limit = Math.min(buffer.length, expectedSize - position);
    const { bytesRead } = await file.read(buffer, 0, limit, position);
    if (!bytesRead) throw new Error("Early EOF before declared file size");
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
  if ((await file.read(buffer, 0, 1, position)).bytesRead) throw new Error("Source exceeds declared file size");
}

export async function hashFile({ handle, size }: Pick<ManifestEntry, "handle" | "size">): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fileChunks(handle, size)) hash.update(chunk);
  return hash.digest("hex");
}
