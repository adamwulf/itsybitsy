import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTransferLimits } from "../config";
import { userHome } from "../home";
import { readMachineName } from "../machine-name";
import { buildAttachmentManifest, fileChunks, hashFile, type ManifestEntry } from "./attachment-manifest";
import { rewriteAttachmentPaths, type AttachmentMapping } from "./attachment-paths";

export async function copyLocalAttachments(
  message: string, entries: readonly (ManifestEntry & { sha256: string })[], signal?: AbortSignal,
  tempDir = "/tmp",
) {
  const root = await mkdtemp(join(tempDir, "itsybitsy-attachments-"));
  const cleanup = () => rm(root, { force: true, recursive: true });
  try {
    const mapping: AttachmentMapping[] = [];
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const dir = join(root, String(index));
      await mkdir(dir, { mode: 0o700 });
      const destination = join(dir, entry.name);
      const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const digest = createHash("sha256");
        for await (const chunk of fileChunks(entry.handle, entry.size)) {
          signal?.throwIfAborted();
          await file.writeFile(chunk);
          digest.update(chunk);
        }
        if (digest.digest("hex") !== entry.sha256) throw new Error(`Attachment hash mismatch: ${entry.source}`);
      } finally {
        await file.close();
      }
      mapping.push({ spellings: entry.spellings, destination });
    }
    return { message: rewriteAttachmentPaths(message, mapping), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function stageLocalAttachments(message: string, paths: readonly string[], signal?: AbortSignal) {
  const entries = await buildAttachmentManifest(paths, {
    cwd: process.cwd(), home: userHome(), machine: await readMachineName(), limits: await readTransferLimits(),
  });
  try {
    const verified = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      verified.push({ ...entry, sha256: await hashFile(entry) });
    }
    return await copyLocalAttachments(message, verified, signal);
  } finally {
    await Promise.allSettled(entries.map(entry => entry.handle.close()));
  }
}
