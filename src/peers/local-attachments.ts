import { InjectionContext } from "../types";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasFreeSpace } from "./attachment-space";
import { checkManifestLimits } from "./transfer-limits";
import { readTransferLimits } from "../config";
import { accountHome, userHome } from "../home";
import { verifiedSendCaller, type VerifiedSendCaller } from "./send-caller";
import { buildAgentAccessTable, buildSystemHookPolicy, pathDenialReason } from "../hooks/paths-table";
import { metaKernelSandboxed, resolvePreparedAccess, type PreparedAccessTable } from "../sandbox";
import { readMachineName } from "../machine-name";
import { buildAttachmentManifest, fileChunks, hashFile, type ManifestEntry, type AttachmentArgument } from "./attachment-manifest";
import { rewriteAttachmentPaths, type AttachmentMapping } from "./attachment-paths";

export const localAttachmentVolume = new InjectionContext("/tmp");

export async function copyLocalAttachments(
  message: string, entries: readonly (ManifestEntry & { sha256: string })[], signal?: AbortSignal,
  tempDir = localAttachmentVolume.fn,
) {
  const bytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (!await hasFreeSpace(tempDir, bytes)) throw new Error(`Insufficient space in ${tempDir} for ${bytes} attachment bytes plus the 1 GiB reserve`);
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

export type AttachmentSender = VerifiedSendCaller;

export function resolveAttachmentSender(cwd = process.cwd()) {
  return verifiedSendCaller(cwd, "attachments");
}

async function senderAttachmentAccess(sender: AttachmentSender) {
  if (sender.kind === "user") return {};
  let access: PreparedAccessTable;
  if (sender.kind === "agent") {
    const { caller } = sender;
    access = await buildAgentAccessTable({
      meta: caller.meta, rootRepo: caller.repoPath, agentDir: caller.agentDir, agentsDir: dirname(caller.agentDir),
      worktreePath: caller.meta.worktree === false ? caller.repoPath : join(caller.agentDir, "repo"),
      kernelSandboxed: metaKernelSandboxed(caller.meta), home: accountHome(), forAttachments: true,
    });
  } else {
    access = (await buildSystemHookPolicy(accountHome())).access;
  }
  return {
    sandboxed: access.kernelSandboxed === true,
    checkRead(source: string) {
      if (resolvePreparedAccess(access, source, "read") === "deny") throw new Error(pathDenialReason(access, source, "read", true));
    },
  };
}

export async function withSenderManifest<T>(
  paths: readonly AttachmentArgument[], sender: AttachmentSender, signal: AbortSignal | undefined,
  use: (entries: (ManifestEntry & { sha256: string })[], machine: string) => Promise<T>,
) {
  const cwd = process.cwd();
  const machine = await readMachineName();
  const entries = await buildAttachmentManifest(paths, {
    ...await senderAttachmentAccess(sender), cwd, home: accountHome(), argumentHome: userHome(), machine, limits: await readTransferLimits(),
  });
  try {
    const verified = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      verified.push({ ...entry, sha256: await hashFile(entry, signal) });
    }
    return await use(verified, machine);
  } finally {
    await Promise.allSettled(entries.map(entry => entry.handle.close()));
  }
}

export async function stageLocalAttachments(message: string, paths: readonly string[], sender: AttachmentSender, signal?: AbortSignal) {
  return withSenderManifest(paths, sender, signal, async (entries, machine) => {
    const staged = await copyLocalAttachments(message, entries, signal);
    try {
      // A large copy can outlive a settings edit. Check the receiving
      // machine's current limits before handing the snapshots to its queue.
      const result = checkManifestLimits(entries, await readTransferLimits(), { machine });
      if (!result.ok) throw new Error(result.error);
      return staged;
    } catch (error) {
      await staged.cleanup();
      throw error;
    }
  });
}
