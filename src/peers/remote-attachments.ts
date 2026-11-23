import { constants as osConstants } from "node:os";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileChunks, hashFile, type ManifestEntry, type AttachmentArgument } from "./attachment-manifest";
import { hasFreeSpace } from "./attachment-space";
import { withSenderManifest, type AttachmentSender } from "./local-attachments";
import type { SendHeader } from "./send-frame";

export type StageRemoteFiles = (dir: string, leasedDirectory?: boolean) => Promise<SendHeader["files"]>;

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

async function cloneByPath(source: string, destination: string) {
  try {
    await copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "ENOTTY"].includes((err as NodeJS.ErrnoException).code ?? "")) return false;
    throw err;
  }
}

async function copyOpened(handle: FileHandle, size: number, destination: string, signal?: AbortSignal, progress?: () => void) {
  const copy = await open(destination, "wx", 0o600);
  try {
    for await (const chunk of fileChunks(handle, size)) {
      signal?.throwIfAborted();
      await copy.writeFile(chunk);
      progress?.();
    }
  } finally { await copy.close(); }
}

export async function cloneAttachments(dir: string, entries: (ManifestEntry & { sha256: string })[], signal?: AbortSignal, clone = cloneByPath, leasedDirectory = false) {
  if (!leasedDirectory) await mkdir(dir, { mode: 0o700 });
  try {
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (!await hasFreeSpace(dir, total)) throw new Error("Insufficient space for staged attachments and the 1 GiB reserve");
    const files: SendHeader["files"] = [];
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const destination = join(dir, String(index));
      if (!await clone(entry.source, destination)) await copyOpened(entry.handle, entry.size, destination, signal);
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

export function remoteAttachmentStage(paths: readonly AttachmentArgument[], sender: AttachmentSender, signal?: AbortSignal,
  onStaged?: (files: SendHeader["files"]) => void): StageRemoteFiles {
  return (dir, leasedDirectory) => withSenderManifest(paths, sender, signal, async entries => {
    const files = await cloneAttachments(dir, entries, signal, cloneByPath, leasedDirectory);
    onStaged?.(files);
    return files;
  });
}

// A broker request controls neither the directory nor the leaf spelling. On
// Darwin O_NOFOLLOW_ANY also rejects symlinks in intermediate components.
// Linux pins each child directory with an fd before opening the next one.
async function withBrokerDirectory<T>(
  agentDir: string, id: string | undefined, use: (dir: FileHandle, path: string, noFollow: number) => Promise<T>,
) {
  if (id !== undefined && !/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid broker attachment request id");
  const root = join(await realpath(dirname(agentDir)), basename(agentDir));
  const flags = constants.O_RDONLY | constants.O_DIRECTORY;
  if (process.platform === "darwin") {
    const O_NOFOLLOW_ANY = 0x20000000;
    const path = join(root, "send-attachments", id ?? "");
    const request = await open(path, flags | O_NOFOLLOW_ANY);
    try { return await use(request, path, O_NOFOLLOW_ANY); }
    finally { await request.close(); }
  }
  let dir = await open(root, flags | constants.O_NOFOLLOW);
  try {
    for (const name of id ? ["send-attachments", id] : ["send-attachments"]) {
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
async function removeBrokerMember(dir: FileHandle, leaf: string, directory = false) {
  if (process.platform !== "darwin") {
    const path = `/proc/self/fd/${dir.fd}/${leaf}`;
    try { return await (directory ? rmdir(path) : unlink(path)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; return; }
  }
  const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    __error: { args: [], returns: FFIType.ptr },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    const name = Buffer.from(leaf + "\0");
    if (libc.symbols.unlinkat(dir.fd, ptr(name), directory ? 0x80 /* AT_REMOVEDIR */ : 0) !== 0 &&
        read.i32(libc.symbols.__error()!) !== osConstants.errno.ENOENT) throw new Error(`Could not remove staged member ${leaf}`);
  } finally { libc.close(); }
}

async function cloneOpened(handle: FileHandle, destination: string) {
  if (process.platform !== "darwin") return cloneByPath(`/proc/self/fd/${handle.fd}`, destination);
  const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    fclonefileat: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  try {
    const name = Buffer.from(destination + "\0");
    if (libc.symbols.fclonefileat(handle.fd, -2 /* AT_FDCWD */, ptr(name), 0) === 0) return true;
    const errno = read.i32(libc.symbols.__error()!);
    if ([osConstants.errno.ENOTSUP, osConstants.errno.EXDEV, osConstants.errno.ENOSYS].includes(errno)) return false;
    throw new Error(`Cannot clone staged attachment (errno ${errno})`);
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
          const destination = join(dir, String(index));
          if (!await cloneOpened(handle, destination)) await copyOpened(handle, file.size, destination, signal, progress);
          const copy = await openStagedFile(destination, file.size);
          try {
            const opened = await copy.stat({ bigint: true });
            const named = await lstat(destination, { bigint: true });
            if (opened.ino !== named.ino || opened.dev !== named.dev) throw new Error("Broker clone changed while opening");
            await copy.chmod(0o600);
            if (await hashFile({ handle: copy, size: file.size }, signal, progress) !== file.sha256) throw new Error("Broker attachment hash mismatch");
          } finally { await copy.close(); }
        } finally { await handle.close(); }
        await removeBrokerMember(request, String(index));
      }
    });
    return files;
  };
}

export function openBrokerLease(agentDir: string, id: string) {
  return withBrokerDirectory(agentDir, id, (_dir, path, noFollow) =>
    open(join(path, "lease"), constants.O_RDONLY | constants.O_NONBLOCK | noFollow));
}

// Reclaim only protocol-owned entries through pinned directory handles. A
// forged lease cannot make the watchdog recursively delete a supplied path.
export async function removeAbandonedStaging(agentDir: string, id: string) {
  try {
    await withBrokerDirectory(agentDir, id, async dir => {
      await removeBrokerMember(dir, "progress");
      await removeBrokerMember(dir, "lease");
      for (let n = 0; n < 100; n++) await removeBrokerMember(dir, String(n));
    });
    await withBrokerDirectory(agentDir, undefined, parent => removeBrokerMember(parent, id, true));
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}
