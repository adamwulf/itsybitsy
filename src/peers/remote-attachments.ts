import { constants } from "node:fs";
import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { hashFile, type ManifestEntry } from "./attachment-manifest";
import { hasFreeSpace } from "./attachment-space";
import { withSenderManifest, type AttachmentSender } from "./local-attachments";
import type { SendHeader } from "./send-frame";

export type StageRemoteFiles = (dir: string) => Promise<SendHeader["files"]>;

export async function openStagedFile(path: string, size: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
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
