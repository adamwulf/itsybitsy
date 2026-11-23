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
import { cleanRemoteText } from "./peer-link";
import { checkIncomingFiles, IDLE_TIMEOUT_MS } from "./transfer-limits";
import type { PairStream } from "./pairing";
import { sendMessage, type PeerEnqueueOptions } from "../ib-commands";
import { listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { waitForIO, streamFileBody, requireSendFin, type FileBodyOptions, type SendHeader, type SendTarget } from "./send-frame";

export function targetLabel(target: SendTarget): string {
  if (target.kind === "system") return "@system";
  if (target.kind === "repo-coordinator") return "@" + target.repo;
  return target.repo ? target.repo + "/" + target.agent : target.agent;
}

async function enqueue(header: SendHeader, peerName: string, peerSend: PeerEnqueueOptions) {
  const fromAgent = header.from.kind === "agent" ? header.from.id :
    header.from.kind === "system" ? peerName + "/@system" : undefined;
  const opts = { fromAgent, peerSend, noPassthrough: header.files.length > 0 || header.noPassthrough === true };
  const target = header.target;
  if (target.kind === "system") {
    const { sendToSystemCoordinator } = await import("../index");
    return sendToSystemCoordinator(header.message, opts);
  }

  let repos = await listRepos();
  if (target.repo !== undefined) {
    const name = target.repo.toLowerCase();
    repos = repos.filter(repo => repo.name.toLowerCase() === name);
    if (repos.length !== 1) throw new Error(`Unknown or ambiguous repo: ${target.repo}`);
  }
  if (target.kind === "agent" && target.agent.includes("/")) throw new Error("Invalid agent target");
  const scoped = target.repo !== undefined;
  const address = target.kind === "repo-coordinator" ? "@coordinator" : target.agent;
  const resolved = await resolveAgentTarget(address, repos, scoped ? repos[0]!.path : "/", "agent", true);
  if (!resolved.agent) throw new Error(resolved.error ?? `Agent not found: ${targetLabel(target)}`);
  return sendMessage(resolved.agent, header.message, opts);
}

type ReceiveStorage = { tempDir: string; stagingRoot?: string; hasFreeSpace: typeof hasFreeSpace };

async function receiveAttachments(header: SendHeader, body: Pick<PairStream, "read">, storage: ReceiveStorage, options: FileBodyOptions, reserve: (bytes: number) => number, defer: (cleanup: Promise<void>) => void) {
  let pending: Promise<unknown> | undefined;
  const io = <T>(operation: () => Promise<T>) => waitForIO(options, () => {
    const running = operation().finally(() => { pending = undefined; });
    pending = running;
    return running;
  });
  const limits = checkIncomingFiles(header.files, await io(readTransferLimits), { machine: await io(readMachineName) });
  if (!limits.ok) throw new Error(limits.error);
  const total = header.files.reduce((sum, file) => sum + file.size, 0);
  if (!await io(() => storage.hasFreeSpace(storage.tempDir, reserve(total)))) throw new Error("Insufficient space for attachments and the 1 GiB reserve");
  const id = crypto.randomUUID();
  const root = join(storage.tempDir, "itsybitsy-attachments-" + id);
  const staging = storage.stagingRoot ?? (storage.tempDir === "/tmp" ? transferStagingRoot() : join(storage.tempDir, "staging"));
  const partial = join(await io(() => stagingArea(staging, "incoming")), id + ".partial");
  let current: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const close = async () => { const file = handle; handle = undefined; await file?.close(); };
  const cleanup = async () => {
    const outstanding = pending;
    const rollback = (async () => {
      await outstanding?.catch(() => {});
      try { await close(); } finally { if (current) await rm(current, { recursive: true, force: true }); }
    })();
    if (outstanding) defer(rollback);
    else {
      try { await waitForIO({ setTimer: options.setTimer }, () => rollback); }
      catch { defer(rollback); }
    }
  };
  try {
    await io(async () => { await mkdir(partial, { mode: 0o700 }); current = partial; });
    await io(() => writeTransferOwner(partial, { pid: process.pid, start: stagingOwnerStart(process.pid) }));
    let received = 0;
    const mapping: AttachmentMapping[] = [];
    for (const [index, file] of header.files.entries()) {
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
    return { message: rewriteAttachmentPaths(header.message, mapping, 1024 ** 2, 64 * 1024), cleanup,
      async commit() {
        await io(() => rm(join(partial, "owner.json")));
        try { await io(async () => { await rename(partial, root); current = root; }); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") throw Error("Incoming staging and committed attachments must be on the same filesystem", { cause: err });
          throw err;
        }
      },
    };
  } catch (error) { await cleanup(); throw error; }
}

/** Shared across this watcher's inbound connections. Concurrent replays await the first enqueue. */
export function createMessageReceiver(log: (line: string) => void, notice: (line: string) => void, now = Date.now, capacity = 4096,
  storage: ReceiveStorage = { tempDir: "/tmp", hasFreeSpace },
  reservations = storage.tempDir === "/tmp" ? watcherTmpReservations : new VolumeReservations(),
) {
  const accepted = new Map<string, number>();
  type Replay = (failure?: { error: unknown }) => void;
  const pending = new Map<string, Set<Replay>>();
  let waiters = 0;
  const receiving = new Set<string>();
  return async (header: SendHeader, peerId: string, readPeerName: () => Promise<string | null>,
    body?: Pick<PairStream, "read">, options: import("./peer-link").ReceiptOptions = {}) => {
    if (!header.message && !header.files.length) throw new Error("Message is empty");
    const name = await readPeerName();
    if (name === null) throw new Error("not a peer");

    const key = peerId + ":" + header.id.toLowerCase();
    const time = now();
    for (const [id, expires] of accepted) {
      if (expires > time) break;
      accepted.delete(id);
    }
    if (accepted.has(key)) return;
    const earlier = pending.get(key);
    if (earlier) {
      if (waiters >= 8) throw new Error("busy, try again");
      waiters++;
      const result = Promise.withResolvers<void>();
      const finish: Replay = failure => failure ? result.reject(failure.error) : result.resolve();
      const closed = () => result.reject(options.signal!.reason);
      const timeout = () => result.reject(new Error("still being received — outcome unknown"));
      const setTimer = options.setTimer ?? ((ms, fn) => {
        const timer = setTimeout(fn, ms); return () => clearTimeout(timer);
      });
      const cancel = setTimer(IDLE_TIMEOUT_MS, timeout);
      try {
        options.admitted?.(false);
        options.signal?.throwIfAborted();
        earlier.add(finish);
        options.signal?.addEventListener("abort", closed, { once: true });
        return await result.promise;
      } finally {
        cancel();
        options.signal?.removeEventListener("abort", closed);
        earlier.delete(finish);
        waiters--;
      }
    }
    if (accepted.size + pending.size >= capacity) throw new Error("busy, try again");
    const work = async () => {
      const { files } = header;
      let staged: Awaited<ReturnType<typeof receiveAttachments>> | undefined;
      let bodyError: unknown;
      const reserve = reservations.transfer();
      let cleanupOwnsReservation = false;
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (files.length) {
        if (receiving.has(peerId) || receiving.size >= 2) throw new Error("busy, try again");
        receiving.add(peerId);
      }
      try {
        options.admitted?.(files.length > 0);
        const result = await enqueue(header, name, {
          log,
          signal: options.signal,
          senderKind: header.from.kind === "user" ? undefined : header.from.kind,
          prepareMessage: files.length ? async () => {
            if (!body) throw new Error("Missing attachment stream");
            let nextNotice = 0;
            try {
              staged = await receiveAttachments(header, body, storage, { ...options, onProgress: bytes => {
                reserve(total - bytes);
                options.onProgress?.(bytes);
                if (total > 5 * 1024 ** 2 && now() >= nextNotice) {
                  nextNotice = now() + 1000;
                  notice(`Receiving from ${name}: ${bytes} / ${total} bytes`);
                }
              } }, reserve, cleanup => {
                cleanupOwnsReservation = true;
                void cleanup.catch(err => log(`Attachment cleanup failed: ${err}`)).finally(() => reserve(0));
              });
              return staged.message;
            } catch (err) { bodyError = err; throw err; }
          } : undefined,
          async beforeEnqueue() {
            if (await readPeerName() === null) throw new Error("not a peer");
            options.signal?.throwIfAborted();
            options.committing?.();
            await staged?.commit();
          },
        });
        if (!result.ok) throw bodyError ?? new Error(result.stderr);
      } catch (error) {
        await staged?.cleanup();
        throw error;
      } finally { if (!cleanupOwnsReservation) reserve(0); if (files.length) receiving.delete(peerId); }
      accepted.set(key, now() + 600_000);
      const summary = files.length ? ` (${files.length} files, ${(total / 1024 ** 2).toFixed(2)} MB)` : "";
      const line = `${cleanRemoteText(name)} sent a message${summary} to ${cleanRemoteText(targetLabel(header.target))}`;
      log(line);
      notice(line);
    };
    const replays = new Set<Replay>();
    pending.set(key, replays);
    try {
      await work();
      for (const finish of replays) finish();
    } catch (error) {
      for (const finish of replays) finish({ error });
      throw error;
    } finally { pending.delete(key); }
  };
}
