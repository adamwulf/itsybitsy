import { constants as osConstants } from "node:os";
import { constants } from "node:fs";
import { copyFile, link, readdir, lstat, mkdir, open, realpath, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileChunks, hashFile, type ManifestEntry, type AttachmentArgument } from "./attachment-manifest";
import { hasFreeSpace, type VolumeReservations } from "./attachment-space";
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

async function copyOpened(handle: FileHandle, size: number, destination: string, signal?: AbortSignal, progress?: () => void, written?: (bytes: number) => void) {
  const copy = await open(destination, "wx", 0o600);
  try {
    for await (const chunk of fileChunks(handle, size)) {
      signal?.throwIfAborted();
      await copy.writeFile(chunk);
      written?.(chunk.length);
      progress?.();
    }
  } finally { await copy.close(); }
}

async function stageSnapshot(handle: FileHandle, file: { size: number; sha256: string }, destination: string,
  signal: AbortSignal | undefined, progress: (() => void) | undefined, mismatch: string, clone = cloneOpened, written?: (bytes: number) => void) {
  if (await clone(handle, destination)) written?.(file.size);
  else await copyOpened(handle, file.size, destination, signal, progress, written);
  const copy = await openStagedFile(destination, file.size);
  try {
    const opened = await copy.stat({ bigint: true });
    const named = await lstat(destination, { bigint: true });
    if (!named.isFile() || opened.ino !== named.ino || opened.dev !== named.dev) throw new Error("Attachment snapshot changed while opening");
    await copy.chmod(0o600);
    if (await hashFile({ handle: copy, size: file.size }, signal, progress) !== file.sha256) throw new Error(mismatch);
  } finally { await copy.close(); }
}

export async function cloneAttachments(dir: string, entries: (ManifestEntry & { sha256: string })[], signal?: AbortSignal, clone = cloneOpened, leasedDirectory = false, reservations?: VolumeReservations) {
  if (!leasedDirectory) await mkdir(dir, { mode: 0o700 });
  const reserve = reservations?.transfer();
  try {
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let remaining = total;
    if (!await hasFreeSpace(dir, reserve?.(total) ?? total)) throw new Error("Insufficient space for staged attachments and the 1 GiB reserve");
    const files: SendHeader["files"] = [];
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const destination = join(dir, String(index));
      const named = await lstat(entry.source, { bigint: true });
      const opened = await entry.handle.stat({ bigint: true });
      const mismatch = `Attachment changed after manifest: ${entry.source}`;
      if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error(mismatch);
      await stageSnapshot(entry.handle, entry, destination, signal, undefined, mismatch, clone, bytes => { remaining -= bytes; reserve?.(remaining); });
      const { name, size, sha256, spellings } = entry;
      files.push({ name, size, sha256, spellings });
    }
    return files;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  } finally { reserve?.(0); }
}

export function remoteAttachmentStage(paths: readonly AttachmentArgument[], sender: AttachmentSender, signal?: AbortSignal,
  onStaged?: (files: SendHeader["files"]) => void, reservations?: VolumeReservations): StageRemoteFiles {
  return (dir, leasedDirectory) => withSenderManifest(paths, sender, signal, async entries => {
    const files = await cloneAttachments(dir, entries, signal, cloneOpened, leasedDirectory, reservations);
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
  return withAgentSubdirectory(agentDir, id ? ["send-attachments", id] : ["send-attachments"], use);
}

export async function withAgentSubdirectory<T>(
  agentDir: string, components: string[], use: (dir: FileHandle, path: string, noFollow: number) => Promise<T>,
) {
  const root = join(await realpath(dirname(agentDir)), basename(agentDir));
  const flags = constants.O_RDONLY | constants.O_DIRECTORY;
  if (process.platform === "darwin") {
    const O_NOFOLLOW_ANY = 0x20000000;
    const path = join(root, ...components);
    const request = await open(path, flags | O_NOFOLLOW_ANY);
    try { return await use(request, path, O_NOFOLLOW_ANY); }
    finally { await request.close(); }
  }
  let dir = await open(root, flags | constants.O_NOFOLLOW);
  try {
    for (const name of components) {
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
export async function removeBrokerMember(dir: FileHandle, leaf: string, directory = false) {
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
          await stageSnapshot(handle, file, destination, signal, progress, "Broker attachment hash mismatch");
        } finally { await handle.close(); }
        await removeBrokerMember(request, String(index));
      }
    });
    return files;
  };
}

export function stagingDirectoryStat(agentDir: string, id: string) {
  return withBrokerDirectory(agentDir, id, dir => dir.stat());
}

export function openBrokerLease(agentDir: string, id: string, name: "lease" | "owner.json" = "lease") {
  return withBrokerDirectory(agentDir, id, (_dir, path, noFollow) =>
    open(join(path, name), constants.O_RDONLY | constants.O_NONBLOCK | noFollow));
}

// Both names are in the same protected request directory. A reader can only
// open the published name after the entire record has been written and closed.
export function publishBrokerRecord(agentDir: string, id: string, name: "lease" | "owner.json", value: unknown) {
  return withBrokerDirectory(agentDir, id, async (dir, path, noFollow) => {
    const leaf = ".record-" + crypto.randomUUID();
    const temp = join(path, leaf);
    const file = await open(temp, noFollow | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      try { await file.writeFile(JSON.stringify(value)); } finally { await file.close(); }
      if (process.platform !== "darwin") return await link(temp, join(path, name));
      const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
      const libc = dlopen("/usr/lib/libSystem.B.dylib", {
        __error: { args: [], returns: FFIType.ptr },
        linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      });
      try {
        const from = Buffer.from(leaf + "\0"), to = Buffer.from(name + "\0");
        if (libc.symbols.linkat(dir.fd, ptr(from), dir.fd, ptr(to), 0) === 0) return;
        const errno = read.i32(libc.symbols.__error()!);
        throw Object.assign(Error(`Cannot publish ${name} (errno ${errno})`), { code: errno === osConstants.errno.EEXIST ? "EEXIST" : undefined });
      } finally { libc.close(); }
    } finally { await removeBrokerMember(dir, leaf); }
  });
}

// Reclaim only protocol-owned entries through pinned directory handles. A
// forged lease cannot make the watchdog recursively delete a supplied path.
export async function removeAbandonedStaging(agentDir: string, id: string) {
  try {
    await withBrokerDirectory(agentDir, id, async (dir, path) => {
      for (const name of await readdir(path)) {
        if (/^\.record-[a-f0-9-]{36}$/.test(name)) await removeBrokerMember(dir, name);
      }
      await removeBrokerMember(dir, "progress");
      for (let n = 0; n < 100; n++) await removeBrokerMember(dir, String(n));
      await removeBrokerMember(dir, "owner.json");
      await removeBrokerMember(dir, "lease");
    });
    await withBrokerDirectory(agentDir, undefined, parent => removeBrokerMember(parent, id, true));
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

/** Publish only verified broker inputs. The watch recovery sweep owns abandoned
 * partials and their sidecars under the same incoming root as peer receipts. */
export async function publishLocalBrokerAttachments(
  message: string, stage: StageRemoteFiles, checkOwner: () => Promise<void>,
  signal: AbortSignal, tempDir = "/tmp",
) {
  const { stagingArea, writeTransferOwner, stagingOwnerStart } = await import("./transfer-owner");
  const { transferStagingRoot } = await import("../runtime-names");
  const { rewriteAttachmentPaths } = await import("./attachment-paths");
  const { sanitizeAttachmentName } = await import("./attachment-name");
  const area = await stagingArea(tempDir === "/tmp" ? transferStagingRoot() : join(tempDir, "staging"), "incoming");
  const id = crypto.randomUUID();
  const partial = join(area, id + ".partial");
  const sidecar = id + ".owner";
  const destination = join(tempDir, "itsybitsy-attachments-" + id);
  await writeTransferOwner(area, { pid: process.pid, start: stagingOwnerStart(process.pid) }, sidecar);
  try {
    await mkdir(partial, { mode: 0o700 });
    const bodies = join(partial, "bodies");
    const files = await stage(bodies);
    const mapping = [];
    for (const [index, file] of files.entries()) {
      signal.throwIfAborted();
      const number = String(index);
      const name = sanitizeAttachmentName(file.name);
      await mkdir(join(partial, number), { mode: 0o700 });
      await rename(join(bodies, number), join(partial, number, name));
      mapping.push({ spellings: file.spellings, destination: join(destination, number, name) });
    }
    await rmdir(bodies);
    const rewritten = rewriteAttachmentPaths(message, mapping, 1024 ** 2, 64 * 1024);
    await checkOwner();
    signal.throwIfAborted();
    await rename(partial, destination).catch(error => {
      if (error.code === "EXDEV") throw Error("Staging and delivered attachments must be on the same filesystem", { cause: error });
      throw error;
    });
    return rewritten;
  } finally {
    await rm(partial, { recursive: true, force: true });
    await rm(join(area, sidecar), { force: true });
  }
}
