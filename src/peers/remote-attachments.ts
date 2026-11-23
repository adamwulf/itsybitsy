import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, rm, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileChunks, hashFile, type ManifestEntry } from "./attachment-manifest";
import { hasFreeSpace } from "./attachment-space";
import { withSenderManifest, type AttachmentSender } from "./local-attachments";
import type { SendHeader } from "./send-frame";

export type StageRemoteFiles = (dir: string) => Promise<SendHeader["files"]>;

export async function openStagedFile(path: string, size: number, flags = constants.O_NOFOLLOW) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== size || info.nlink !== 1) throw new Error("Invalid staged attachment");
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}

export async function cloneAttachments(dir: string, entries: (ManifestEntry & { sha256: string })[], signal?: AbortSignal) {
  await mkdir(dir, { mode: 0o700 });
  try {
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (!await hasFreeSpace(dir, total)) throw new Error("Insufficient space for staged attachments and the 1 GiB reserve");
    const files: SendHeader["files"] = [];
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const destination = join(dir, String(index));
      await copyFile(entry.source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      const handle = await openStagedFile(destination, entry.size);
      try {
        await handle.chmod(0o600);
        if (await hashFile({ handle, size: entry.size }, signal) !== entry.sha256) {
          throw new Error(`Attachment changed after manifest: ${entry.source}`);
        }
      } finally { await handle.close(); }
      const { name, size, sha256, spellings } = entry;
      files.push({ name, size, sha256, spellings });
    }
    return files;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export function remoteAttachmentStage(paths: readonly string[], sender: AttachmentSender, signal?: AbortSignal,
  onStaged?: (files: SendHeader["files"]) => void): StageRemoteFiles {
  return dir => withSenderManifest(paths, sender, signal, async entries => {
    const files = await cloneAttachments(dir, entries, signal);
    onStaged?.(files);
    return files;
  });
}

// A broker request controls neither the directory nor the leaf spelling. On
// Darwin O_NOFOLLOW_ANY also rejects symlinks in intermediate components.
// Linux pins each child directory with an fd before opening the next one.
async function withBrokerDirectory<T>(
  agentDir: string, id: string, use: (dir: FileHandle, path: string, noFollow: number) => Promise<T>,
) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid broker attachment request id");
  const root = join(await realpath(dirname(agentDir)), basename(agentDir));
  const flags = constants.O_RDONLY | constants.O_DIRECTORY;
  if (process.platform === "darwin") {
    const O_NOFOLLOW_ANY = 0x20000000;
    const path = join(root, "send-attachments", id);
    const request = await open(path, flags | O_NOFOLLOW_ANY);
    try { return await use(request, path, O_NOFOLLOW_ANY); }
    finally { await request.close(); }
  }
  let dir = await open(root, flags | constants.O_NOFOLLOW);
  try {
    for (const name of ["send-attachments", id]) {
      const next = await open(`/proc/self/fd/${dir.fd}/${name}`, flags | constants.O_NOFOLLOW);
      await dir.close();
      dir = next;
    }
    return await use(dir, `/proc/self/fd/${dir.fd}`, constants.O_NOFOLLOW);
  } finally { await dir.close(); }
}

export function createBrokerProgress(agentDir: string, id: string) {
  return withBrokerDirectory(agentDir, id, (_dir, path, noFollow) =>
    open(join(path, "progress"), noFollow | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
}

// Finish the cross-volume move only after the private copy is verified.
// unlinkat scopes deletion to the pinned request even if a parent is renamed.
// Darwin's /dev/fd does not support directory-relative path traversal.
async function releaseBrokerFile(dir: FileHandle, index: number) {
  if (process.platform !== "darwin") return unlink(`/proc/self/fd/${dir.fd}/${index}`);
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    const name = Buffer.from(String(index) + "\0");
    if (libc.symbols.unlinkat(dir.fd, ptr(name), 0) !== 0) throw new Error(`Could not release staged attachment ${index}`);
  } finally { libc.close(); }
}

export function brokerAttachmentStage(agentDir: string, id: string, files: SendHeader["files"], signal?: AbortSignal, progress?: () => void): StageRemoteFiles {
  return async dir => {
    await mkdir(dir, { mode: 0o700 });
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (!await hasFreeSpace(dir, total)) throw new Error("Insufficient space for broker attachments and the 1 GiB reserve");
    await withBrokerDirectory(agentDir, id, async (request, path, noFollow) => {
      for (const [index, file] of files.entries()) {
        signal?.throwIfAborted();
        const handle = await openStagedFile(join(path, String(index)), file.size, noFollow);
        try {
          const copy = await open(join(dir, String(index)), "wx", 0o600);
          try {
            const digest = createHash("sha256");
            for await (const chunk of fileChunks(handle, file.size)) {
              signal?.throwIfAborted();
              digest.update(chunk);
              await copy.writeFile(chunk);
              progress?.();
            }
            if (digest.digest("hex") !== file.sha256) throw new Error("Broker attachment hash mismatch");
          } finally { await copy.close(); }
        } finally { await handle.close(); }
        await releaseBrokerFile(request, index);
      }
    });
    return files;
  };
}
