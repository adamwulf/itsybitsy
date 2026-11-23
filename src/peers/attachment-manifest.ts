import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { canonicalizeSandboxPath } from "../sandbox";
import { sanitizeAttachmentName } from "./attachment-name";
import { CHUNK_BYTES, checkManifestLimits, DEFAULT_TRANSFER_LIMITS, type TransferLimits } from "./transfer-limits";

export interface ManifestEntry {
  argument: string;
  source: string;
  name: string;
  size: number;
  spellings: string[];
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
  for (const argument of paths) {
    const expanded = argument === "~" ? home : argument.startsWith("~/") ? join(home, argument.slice(2)) : argument;
    const absolute = resolve(cwd, expanded);
    try {
      const source = await realpath(absolute);
      if (protectedDirs.some(dir => source === dir || source.startsWith(dir + sep))) {
        throw new Error("protected attachment path");
      }
      let entry = entries.get(source);
      if (!entry) {
        const info = await stat(source);
        if (!info.isFile()) throw new Error("not a regular file");
        entry = { argument, source, size: info.size, name: sanitizeAttachmentName(basename(absolute)), spellings: [] };
        entries.set(source, entry);
      }
      for (const spelling of [argument, absolute, source]) {
        if (!entry.spellings.includes(spelling)) entry.spellings.push(spelling);
      }
    } catch (error) {
      throw new Error(`Cannot attach ${JSON.stringify(argument)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const files = Array.from(entries.values());
  const result = checkManifestLimits(files, limits, { machine });
  if (!result.ok) throw new Error(result.error);
  return files;
}

/** The buffer is reused on the next read. Consume each chunk before advancing. */
export async function* fileChunks(path: string): AsyncGenerator<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await file.close();
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fileChunks(path)) hash.update(chunk);
  return hash.digest("hex");
}
