import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasFreeSpace } from "./attachment-space";
import { checkManifestLimits } from "./transfer-limits";
import { readTransferLimits } from "../config";
import { accountHome, userHome } from "../home";
import { resolveAttachmentSharedCaller, type ResolvedCallerContext } from "../ib-commands";
import { registeredRepoRoots, locateRegisteredAgentDir } from "../hooks/agent-context";
import { matchWorktreeCaller } from "../runtime-names";
import { remoteCliCaller } from "./peer-outbox";
import { buildAgentAccessTable, buildSystemHookPolicy, pathDenialReason } from "../hooks/paths-table";
import { metaKernelSandboxed, resolvePreparedAccess, type PreparedAccessTable } from "../sandbox";
import { readMachineName } from "../machine-name";
import { buildAttachmentManifest, fileChunks, hashFile, type ManifestEntry } from "./attachment-manifest";
import { rewriteAttachmentPaths, type AttachmentMapping } from "./attachment-paths";

export async function copyLocalAttachments(
  message: string, entries: readonly (ManifestEntry & { sha256: string })[], signal?: AbortSignal,
  tempDir = "/tmp",
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

export type AttachmentSender = { kind: "user" | "system" } | { kind: "agent"; caller: ResolvedCallerContext };

async function directoryIdentity(path: string): Promise<string | undefined> {
  try {
    const dir = await stat(path, { bigint: true });
    if (dir.isDirectory()) return `${dir.dev}:${dir.ino}`;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Match the closest registered directory by metadata, including APFS case aliases. */
async function registeredCallerRepo(home: string, cwd: string, worktreeRepo?: string) {
  const registered = new Set<string>();
  for (const root of await registeredRepoRoots(home)) {
    const id = await directoryIdentity(root);
    if (id) registered.add(id);
  }
  for (let dir = worktreeRepo ?? cwd; ; dir = dirname(dir)) {
    const id = await directoryIdentity(dir);
    if (id && registered.has(id)) return dir;
    if (worktreeRepo || dir === dirname(dir)) return undefined;
  }
}

export async function resolveAttachmentSender(cwd = process.cwd()): Promise<AttachmentSender> {
  if (await remoteCliCaller.isHuman()) return { kind: "user" };
  const unknown = "cannot verify the sender of an attachment";
  const home = accountHome();
  const systemDir = join(home, ".itsybitsy");
  if (cwd === systemDir || cwd.startsWith(systemDir + "/")) {
    if (await remoteCliCaller.isSystem()) return { kind: "system" };
    throw new Error(unknown);
  }
  const worktree = matchWorktreeCaller(cwd);
  const repo = await registeredCallerRepo(home, cwd, worktree?.[1]);
  if (!repo) throw new Error(unknown);
  const shared = await resolveAttachmentSharedCaller(cwd, repo);
  if (shared) return { kind: "agent", caller: shared };
  if (worktree) {
    const id = worktree[2];
    if (!id) throw new Error(unknown);
    const location = await locateRegisteredAgentDir(repo, id);
    if (!location || !cwd.startsWith(join(location.agentDir, "repo") + "/") && cwd !== join(location.agentDir, "repo")) {
      throw new Error(unknown);
    }
    const meta = await Bun.file(join(location.agentDir, "meta.json")).json();
    if (meta?.id !== id || meta.worktree !== true) throw new Error(unknown);
    return { kind: "agent", caller: { ...location, meta } };
  }
  throw new Error(unknown);
}

async function senderAttachmentAccess(sender: AttachmentSender) {
  if (sender.kind === "user") return {};
  let access: PreparedAccessTable;
  if (sender.kind === "agent") {
    const { caller } = sender;
    access = await buildAgentAccessTable({
      meta: caller.meta, rootRepo: caller.repoPath, agentDir: caller.agentDir, agentsDir: dirname(caller.agentDir),
      worktreePath: caller.meta.worktree === false ? caller.repoPath : join(caller.agentDir, "repo"),
      kernelSandboxed: metaKernelSandboxed(caller.meta), home: accountHome(),
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

export async function stageLocalAttachments(message: string, paths: readonly string[], sender: AttachmentSender, signal?: AbortSignal) {
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
