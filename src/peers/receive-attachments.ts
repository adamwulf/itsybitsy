import { transferStagingRoot } from "../runtime-names";
import { stagingArea, stagingOwnerStart, writeTransferOwner } from "./transfer-owner";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTransferLimits } from "../config";
import { readMachineName } from "../machine-name";
import { sanitizeAttachmentName } from "./attachment-name";
import { rewriteAttachmentPaths, type AttachmentMapping } from "./attachment-paths";
import { hasFreeSpace, VolumeReservations, watcherTmpReservations } from "./attachment-space";
import { checkIncomingFiles } from "./transfer-limits";
import type { PairStream } from "./pairing";
import { waitForIO, streamFileBody, requireSendFin, type AttachmentEntry, type FileBodyOptions } from "./send-frame";

/**
 * Inbound attachments on the trusted link (SPEC §20.4 "Message sends"), shared
 * by message sends and remote starts: the live limits, the busy rule, the
 * /tmp reservation, the private partial directory, the hash and FIN checks,
 * the atomic commit and the rewrite of the text that names the files.
 */

export type ReceiveStorage = { tempDir: string; stagingRoot?: string; hasFreeSpace: typeof hasFreeSpace };

export interface ReceivedAttachments {
  /** The text with each spelling rewritten to this machine's copy, and the mapping appended. */
  text: string;
  /** Publish the verified snapshot under its final /tmp name. */
  commit(): Promise<void>;
  /** Remove the private partial and its owner record. */
  cleanup(): Promise<void>;
  /** Remove a committed snapshot that nothing refers to. */
  discard(): Promise<void>;
}

export interface ReceiptContext {
  /** The paired name, for the progress notice. */
  peerName: string;
  log(line: string): void;
  notice(line: string): void;
  now?(): number;
}

/** Receive the declared files once, while the caller holds the transfer slot. */
export type ReceiveFiles = (text: string, body: Pick<PairStream, "read">, options: FileBodyOptions) => Promise<ReceivedAttachments>;

export function totalBytes(files: readonly AttachmentEntry[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/** ` (N files, X MB)` for the receiver's log and notice; empty without files. */
export function fileSummary(files: readonly AttachmentEntry[]): string {
  return files.length ? ` (${files.length} files, ${(totalBytes(files) / 1024 ** 2).toFixed(2)} MB)` : "";
}

async function receiveAttachments(text: string, files: readonly AttachmentEntry[], body: Pick<PairStream, "read">, storage: ReceiveStorage, options: FileBodyOptions, reserve: (bytes: number) => number, defer: (cleanup: Promise<void>, retry: () => Promise<void>) => void): Promise<ReceivedAttachments> {
  let pending: Promise<unknown> | undefined;
  const io = <T>(operation: () => Promise<T>) => waitForIO(options, () => {
    const running = operation().finally(() => { pending = undefined; });
    pending = running;
    return running;
  });
  const limits = checkIncomingFiles(files, await io(readTransferLimits), { machine: await io(readMachineName) });
  if (!limits.ok) throw new Error(limits.error);
  if (!await io(() => storage.hasFreeSpace(storage.tempDir, reserve(totalBytes(files))))) throw new Error("Insufficient space for attachments and the 1 GiB reserve");
  const id = crypto.randomUUID();
  const root = join(storage.tempDir, "itsybitsy-attachments-" + id);
  const staging = storage.stagingRoot ?? (storage.tempDir === "/tmp" ? transferStagingRoot() : join(storage.tempDir, "staging"));
  const partial = join(await io(() => stagingArea(staging, "incoming")), id + ".partial");
  const area = join(staging, "incoming");
  const sidecar = join(area, id + ".owner");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const close = async () => { const file = handle; handle = undefined; await file?.close(); };
  const cleanup = async () => {
    const outstanding = pending;
    const remove = async () => {
      await rm(partial, { recursive: true, force: true });
      await rm(sidecar, { force: true });
    };
    const rollback = (async () => {
      await outstanding?.catch(() => {});
      try { await close(); } finally { await remove(); }
    })();
    if (outstanding) defer(rollback, remove);
    else {
      try { await waitForIO({ setTimer: options.setTimer }, () => rollback); }
      catch { defer(rollback, remove); }
    }
  };
  try {
    await io(() => writeTransferOwner(area, { pid: process.pid, start: stagingOwnerStart(process.pid) }, id + ".owner"));
    await io(() => mkdir(partial, { mode: 0o700 }));
    let received = 0;
    const mapping: AttachmentMapping[] = [];
    for (const [index, file] of files.entries()) {
      const dir = join(partial, String(index));
      await io(() => mkdir(dir, { mode: 0o700 }));
      const name = sanitizeAttachmentName(file.name);
      await io(async () => { handle = await open(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); });
      const digest = await streamFileBody(body, file.size, chunk => io(() => handle!.writeFile(chunk)), {
        ...options, onProgress: bytes => options.onProgress?.(received + bytes),
      });
      await io(close);
      if (digest !== file.sha256.toLowerCase()) throw new Error("Attachment hash mismatch");
      received += file.size;
      mapping.push({ destination: join(root, String(index), name), spellings: file.spellings });
    }
    await requireSendFin(body, options);
    return { text: rewriteAttachmentPaths(text, mapping, 1024 ** 2, 64 * 1024), cleanup,
      async commit() {
        try { await io(() => rename(partial, root)); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") throw Error("Incoming staging and committed attachments must be on the same filesystem", { cause: err });
          throw err;
        }
        await io(() => rm(sidecar));
      },
      discard: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) { await cleanup(); throw error; }
}

/**
 * One per watcher, shared by message sends and remote starts: each receiver
 * allows one active attachment transfer per authenticated peer and two in total.
 * `run` receives the declared files at most once while it holds the slot. When
 * `run` fails, an uncommitted receipt is rolled back.
 */
export function createAttachmentReceiver(
  storage: ReceiveStorage = { tempDir: "/tmp", hasFreeSpace },
  reservations = storage.tempDir === "/tmp" ? watcherTmpReservations : new VolumeReservations(),
) {
  const receiving = new Set<string>();
  return async <T>(peerId: string, files: readonly AttachmentEntry[], context: ReceiptContext, run: (receive: ReceiveFiles) => Promise<T>): Promise<T> => {
    const { log, notice, now = () => performance.now() } = context;
    let staged: ReceivedAttachments | undefined;
    const reserve = reservations.transfer();
    let cleanupOwnsReservation = false;
    const total = totalBytes(files);
    if (files.length) {
      if (receiving.has(peerId) || receiving.size >= 2) throw new Error("busy, try again");
      receiving.add(peerId);
    }
    try {
      return await run(async (text, body, options) => {
        let nextNotice = 0;
        staged = await receiveAttachments(text, files, body, storage, { ...options, onProgress: bytes => {
          reserve(total - bytes);
          options.onProgress?.(bytes);
          if (total > 5 * 1024 ** 2 && now() >= nextNotice) {
            nextNotice = now() + 1000;
            notice(`Receiving from ${context.peerName}: ${bytes} / ${total} bytes`);
          }
        } }, reserve, (cleanup, retry) => {
          cleanupOwnsReservation = true;
          const finish = (operation: Promise<void>, delay: number) => {
            void operation.then(() => reserve(0), err => {
              log(`Retrying attachment cleanup: ${err}`);
              setTimeout(() => finish(retry(), Math.min(delay * 2, 30_000)), delay).unref();
            });
          };
          finish(cleanup, 250);
        });
        return staged;
      });
    } catch (error) {
      await staged?.cleanup();
      throw error;
    } finally { if (!cleanupOwnsReservation) reserve(0); if (files.length) receiving.delete(peerId); }
  };
}

export type AttachmentReceiver = ReturnType<typeof createAttachmentReceiver>;
