import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
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

export function remoteAttachmentStage(paths: readonly string[], sender: AttachmentSender, signal?: AbortSignal): StageRemoteFiles {
  return dir => withSenderManifest(paths, sender, signal, entries => cloneAttachments(dir, entries, signal));
}

// A broker request controls neither the directory nor the leaf spelling. On
// Darwin O_NOFOLLOW_ANY also rejects symlinks in intermediate components.
// Linux pins each child directory with an fd before opening the next one.
async function openBrokerFile(agentDir: string, id: string, index: number, size: number) {
  const root = await realpath(agentDir);
  if (process.platform === "darwin") {
    return openStagedFile(join(root, "send-attachments", id, String(index)), size, 0x20000000);
  }
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const parent = await open(join(root, "send-attachments"), flags);
  try {
    const request = await open(`/proc/self/fd/${parent.fd}/${id}`, flags);
    try { return await openStagedFile(`/proc/self/fd/${request.fd}/${index}`, size); }
    finally { await request.close(); }
  } finally { await parent.close(); }
}

export function brokerAttachmentStage(agentDir: string, id: string, files: SendHeader["files"], signal?: AbortSignal): StageRemoteFiles {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid broker attachment request id");
  return async dir => {
    await mkdir(dir, { mode: 0o700 });
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (!await hasFreeSpace(dir, total)) throw new Error("Insufficient space for broker attachments and the 1 GiB reserve");
    for (const [index, file] of files.entries()) {
      signal?.throwIfAborted();
      const handle = await openBrokerFile(agentDir, id, index, file.size);
      try {
        const copy = await open(join(dir, String(index)), "wx", 0o600);
        try {
          const digest = createHash("sha256");
          for await (const chunk of fileChunks(handle, file.size)) {
            signal?.throwIfAborted();
            digest.update(chunk);
            await copy.writeFile(chunk);
          }
          if (digest.digest("hex") !== file.sha256) throw new Error("Broker attachment hash mismatch");
        } finally { await copy.close(); }
      } finally { await handle.close(); }
    }
    return files;
  };
}
