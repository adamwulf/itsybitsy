import { realpathArgument, type AttachmentArgument } from "./attachment-manifest";
import { watcherTmpReservations } from "./attachment-space";
import { remoteAttachmentStage } from "./remote-attachments";
import type { SendHeader } from "./send-frame";
import { inspectTransferDirectory, makeOutgoingDirectory } from "./transfer-owner";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { references } from "../message-attachments";
import { userHome } from "../home";
import { runtimeDir } from "../runtime-names";
import { canonicalizeSandboxPath } from "../sandbox";

export interface PeerAttachmentCandidate {
  /** The reference as the message spells it, trailing punctuation trimmed. */
  argument: string;
  /** Its canonical path on this machine. */
  source: string;
  /** Checked when the path dialog opens. */
  checked: boolean;
}

function missing(err: unknown) {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The references in `text` the user may send to a peer as attachments, using
 * the input field's parser: each names an existing regular file on this
 * machine, /tmp included, since a peer cannot read this machine's /tmp. Every
 * other reference (a directory, a missing path, a relative one without
 * `localRoot`) stays raw text and is not offered.
 *
 * `localRoot` is this machine's checkout of the target's repository. A file
 * inside it is live on the peer's own checkout, so it starts unchecked, as
 * does a relative reference, which resolves against it. A file in the
 * checkout's runtime directory (other agents' worktrees, logs) exists only on
 * this machine and starts checked, as does any file outside the checkout.
 */
export async function peerAttachmentCandidates(text: string, localRoot?: string) {
  let noPassthrough = false;
  const candidates = new Map<string, PeerAttachmentCandidate>();
  const local = localRoot && canonicalizeSandboxPath(localRoot);
  const inside = (root: string | undefined, path: string) => !!root && (path === root || path.startsWith(root + "/"));
  const live = (path: string) => inside(local, path) && !inside(local && runtimeDir(local), path);
  for (const ref of references(text)) {
    let path = ref.path;
    const relative = !path.startsWith("/") && !path.startsWith("~/");
    if (relative && !localRoot) {
      if (ref.start === 0) noPassthrough = true;
      continue;
    }
    for (;;) {
      const absolute = path.startsWith("~/") ? userHome() + path.slice(1) : relative ? localRoot + "/" + path : path;
      let source: string;
      try {
        source = await realpathArgument(absolute);
      } catch (err) {
        if (!missing(err)) throw err;
        if (!ref.quote && /[.,;:!\)\]}]$/.test(path)) { path = path.slice(0, -1); continue; }
        // A missing slash-command name stays a slash command.
        if (ref.start === 0 && (ref.quote || !/^\/[\w-]+$/.test(path))) noPassthrough = true;
        break;
      }
      if (ref.start === 0) noPassthrough = true;
      const info = await stat(source).catch(err => { if (!missing(err)) throw err; });
      if (info?.isFile() && !candidates.has(path)) {
        candidates.set(path, { argument: path, source, checked: !relative && !live(source) });
      }
      break;
    }
  }
  return { candidates: [...candidates.values()], noPassthrough };
}

export interface StagedPeerAttachments {
  /** The staged files, for the transfer's `filesDir`. */
  filesDir: string;
  /** The header's `files`. */
  files: SendHeader["files"];
  /** Remove the staging directory. A failure goes to `onCleanupError`. */
  cleanup: () => Promise<void>;
}

/**
 * Stage the user's `paths` for a transfer to a peer in a new outgoing
 * directory that this process owns. A failure removes the directory before it
 * rejects.
 */
export async function stagePeerAttachments(
  paths: readonly AttachmentArgument[],
  { signal, onCleanupError }: { signal?: AbortSignal; onCleanupError?: (err: unknown) => void } = {},
): Promise<StagedPeerAttachments> {
  const staging = await makeOutgoingDirectory();
  const cleanup = async () => {
    try { await rm(staging, { recursive: true, force: true }); }
    catch (err) { onCleanupError?.(err); }
  };
  try {
    const filesDir = join(staging, "files");
    const files = await remoteAttachmentStage(paths, { kind: "user" }, signal, undefined, watcherTmpReservations)(filesDir);
    const { owner, state } = await inspectTransferDirectory(staging);
    if (state !== "verified-live" || owner?.pid !== process.pid) throw new Error("Cannot verify the outgoing attachment owner");
    return { filesDir, files, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
