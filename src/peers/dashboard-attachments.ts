import { realpathArgument, type AttachmentArgument } from "./attachment-manifest";
import { watcherTmpReservations } from "./attachment-space";
import { remoteAttachmentStage } from "./remote-attachments";
import type { SendHeader } from "./send-frame";
import { inspectTransferDirectory, makeOutgoingDirectory } from "./transfer-owner";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { references } from "../message-attachments";
import { userHome } from "../home";

/** One file the message names: one row in the path dialog, however many ways the message spells it. */
export interface PeerAttachmentCandidate {
  /** The file's first spelling in the message, trailing punctuation trimmed: the dialog row. */
  argument: string;
  /** Its canonical path on this machine. */
  source: string;
  /** Every spelling of the file in message order, `argument` first. An attached file is rewritten in all of them. */
  spellings: string[];
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
 * `localRoot`) stays raw text and is not offered. `localRoot` is this
 * machine's checkout of the target's repository: a relative reference
 * resolves against it.
 *
 * Spellings that resolve to the same file make one candidate, so checking it
 * attaches the file and rewrites each of them. Every candidate starts
 * unchecked in the path dialog, as in a local send.
 */
export async function peerAttachmentCandidates(text: string, localRoot?: string) {
  let noPassthrough = false;
  const candidates = new Map<string, PeerAttachmentCandidate>();
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
      if (info?.isFile()) {
        const known = candidates.get(source);
        if (!known) candidates.set(source, { argument: path, source, spellings: [path] });
        else if (!known.spellings.includes(path)) known.spellings.push(path);
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
 * Stage the files the user checked for a transfer to a peer in a new outgoing
 * directory that this process owns, each with all of its spellings. A failure
 * removes the directory before it rejects.
 */
export async function stagePeerAttachments(
  chosen: readonly PeerAttachmentCandidate[],
  { signal, onCleanupError }: { signal?: AbortSignal; onCleanupError?: (err: unknown) => void } = {},
): Promise<StagedPeerAttachments> {
  const staging = await makeOutgoingDirectory();
  const cleanup = async () => {
    try { await rm(staging, { recursive: true, force: true }); }
    catch (err) { onCleanupError?.(err); }
  };
  try {
    const filesDir = join(staging, "files");
    const paths: AttachmentArgument[] = chosen.flatMap(({ source, spellings }) => spellings.map(argument => ({ argument, source })));
    const files = await remoteAttachmentStage(paths, { kind: "user" }, signal, undefined, watcherTmpReservations)(filesDir);
    const { owner, state } = await inspectTransferDirectory(staging);
    if (state !== "verified-live" || owner?.pid !== process.pid) throw new Error("Cannot verify the outgoing attachment owner");
    return { filesDir, files, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
