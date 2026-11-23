import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkManifestLimits } from "./transfer-limits";
import { readTransferLimits } from "../config";
import { userHome } from "../home";
import { resolveCallerAgentContext } from "../ib-commands";
import { matchWorktreeCaller } from "../runtime-names";
import { isSandboxedProcess } from "../sandbox-detect";
import { buildAgentAccessTable, pathDenialReason } from "../hooks/paths-table";
import { resolvePreparedAccess } from "../sandbox";
import { checkAttachmentIdentitiesViaWatchdog } from "./attachment-identity-broker";
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

async function senderAttachmentAccess(cwd: string, signal?: AbortSignal) {
  const caller = await resolveCallerAgentContext(cwd);
  if (!caller) {
    if (matchWorktreeCaller(cwd)) throw new Error("Cannot verify attachment sender metadata");
    return {};
  }
  const sandboxed = isSandboxedProcess();
  const access = await buildAgentAccessTable({
    meta: caller.meta, rootRepo: caller.repoPath, agentDir: caller.agentDir, agentsDir: dirname(caller.agentDir),
    worktreePath: caller.meta.worktree === false ? caller.repoPath : join(caller.agentDir, "repo"),
    kernelSandboxed: sandboxed,
  });
  return {
    checkRead(source: string) {
      if (resolvePreparedAccess(access, source, "read") === "deny") throw new Error(pathDenialReason(access, source, "read", true));
    },
    checkWithWatchdog: sandboxed
      ? (ids: string[]) => checkAttachmentIdentitiesViaWatchdog(caller, ids, signal)
      : undefined,
  };
}

export async function stageLocalAttachments(message: string, paths: readonly string[], signal?: AbortSignal) {
  const cwd = process.cwd();
  const machine = await readMachineName();
  const entries = await buildAttachmentManifest(paths, {
    ...await senderAttachmentAccess(cwd, signal), cwd, home: userHome(), machine, limits: await readTransferLimits(),
  });
  try {
    const verified = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      verified.push({ ...entry, sha256: await hashFile(entry) });
    }
    const staged = await copyLocalAttachments(message, verified, signal);
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
  } finally {
    await Promise.allSettled(entries.map(entry => entry.handle.close()));
  }
}
