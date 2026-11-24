import { parseLifecycleRequest, lifecycleTimeout, lifecyclePast, type RemoteLifecycleRequest } from "./remote-lifecycle";
import { requestLookup } from "../request-lookup";
import { transferOwnerState, type TransferOwner, finishRecovery, inspectTransferDirectory, reclaimTransfer, safeTransferParent, sweepEntries, sweepTransferDirectory, transferDirectoryBatch, writeTransferOwner, stagingOwnerStart } from "./transfer-owner";
import { cancellationPoll, cancellationMarkerExists, trackSendCleanup, warnSendCleanup } from "../send-cleanup";
import type { StageRemoteFiles } from "./remote-attachments";
import { interruptedSend, withdrawPublishedRequest } from "../spawn-broker";
import type { VerifiedSendCaller } from "./send-caller";
export { remoteCliCaller } from "./send-caller";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { IDLE_TIMEOUT_MS, MAX_HEADER_BYTES } from "./transfer-limits";
import { access, mkdir, open, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IbCommandResult } from "../ib-commands";
import { readMachineName } from "../machine-name";
import { registeredQueueRepo } from "../outbox";
import { isSandboxedProcess } from "../sandbox-detect";
import type { RepoEntry } from "../registry";
import { peerOutboxDir } from "../runtime-names";
import { hasLivePeerWatcher } from "./endpoint-lock";
import { SEND_UNKNOWN, type OutgoingTransfer } from "./peer-link";
import { targetLabel } from "./receive-message";
import { encodeSendHeader, parseSendHeader, type SendHeader, type SendTarget } from "./send-frame";

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
const detail = (err: unknown) => err instanceof Error ? err.message : String(err);
const fail = (stderr: string): IbCommandResult => ({ ok: false, exitCode: 1, stdout: "", stderr });
const requestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function parseClaim(name: string) {
  const match = /^([a-f0-9-]+)@([1-9]\d*)-([1-9]\d*)$/i.exec(name);
  if (!match || !requestId.test(match[1]!)) return;
  const pid = Number(match[2]), start = Number(match[3]);
  if (Number.isSafeInteger(pid) && Number.isSafeInteger(start)) return { id: match[1]!, owner: { pid, start } };
}

async function findClaim(base: string, id: string) {
  try {
    const parent = join(base, ".claimed");
    for await (const entry of await opendir(parent)) {
      if (entry.isDirectory() && entry.name.startsWith(id + "@") && parseClaim(entry.name)) return join(parent, entry.name);
    }
  } catch (err) { if (!missing(err)) throw err; }
}

export async function qualifiedAgentSender(id: string, repoPath: string, repos: RepoEntry[]): Promise<SendHeader["from"]> {
  const repo = await registeredQueueRepo(repoPath, repos);
  if (!repo) throw new Error("Remote sends require the requester's repo to be registered");
  return { kind: "agent", id: `${await readMachineName()}/${repo}/${id}` };
}

type RemoteSender =
  | { kind: "direct"; from: SendHeader["from"] }
  | { kind: "worktree"; id: string; repoPath: string; agentDir: string };

export async function cliRemoteSender(repos: RepoEntry[], identity: VerifiedSendCaller, explicit?: string): Promise<RemoteSender> {
  let id = "";
  let sender: RemoteSender;
  if (identity.kind === "agent") {
    const { meta, repoPath, agentDir } = identity.caller;
    id = String(meta.id);
    if (meta.worktree === true) {
      sender = { kind: "worktree", id, repoPath, agentDir };
    } else {
      if (isSandboxedProcess()) throw new Error("remote sends from a sandboxed repo coordinator are not supported yet");
      sender = { kind: "direct", from: await qualifiedAgentSender(id, repoPath, repos) };
    }
  } else {
    id = identity.kind === "system" ? "@system" : "";
    sender = { kind: "direct", from: { kind: identity.kind } };
  }
  if (explicit !== undefined && explicit !== id) throw new Error("Remote --from must match the detected sender");
  return sender;
}

async function writeJson(dir: string, name: string, data: unknown) {
  const temp = join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    await rename(temp, join(dir, name));
  } finally { await rm(temp, { force: true }); }
}

export function textHeader(target: SendTarget, message: string, from: SendHeader["from"]): SendHeader {
  return { op: "send", id: randomUUID(), target, message, from, files: [] };
}

/** A claimed request might already have reached the other machine. Never re-submit it. */
export async function handoffRemoteMessage(peer: string, header: SendHeader, signal?: AbortSignal, stage?: StageRemoteFiles, onProgress?: () => void, beforePublish?: () => Promise<void>, origin?: TransferOwner): Promise<IbCommandResult> {
  return handoffPeerRequest({
    id: header.id, success: `Sent to ${targetLabel(header.target)}`, signal, onProgress, beforePublish,
    validate: () => encodeSendHeader(parseSendHeader(header)),
    prepare: async staging => {
      if (stage) {
        header = { ...header, files: await stage(join(staging, "files")) };
        encodeSendHeader(parseSendHeader(header));
      }
      return { peer, header, origin };
    },
  });
}

export function handoffRemoteLifecycle(peer: string, machine: string, lifecycle: RemoteLifecycleRequest): Promise<IbCommandResult> {
  return handoffPeerRequest({
    id: randomUUID(), success: `${machine} ${lifecyclePast[lifecycle.action]} ${lifecycle.id}`,
    lifecycle: { machine, timeout: lifecycleTimeout(lifecycle.action) },
    prepare: async () => ({ peer, lifecycle }),
  });
}

async function handoffPeerRequest(options: {
  id: string; success: string; validate?(): void; prepare(staging: string): Promise<object>;
  signal?: AbortSignal; onProgress?: () => void; beforePublish?: () => Promise<void>;
  lifecycle?: { machine: string; timeout: number };
}): Promise<IbCommandResult> {
  const { id, success, signal, onProgress, beforePublish, lifecycle } = options;
  const unknown = lifecycle ? `outcome unknown — check ${lifecycle.machine}` : SEND_UNKNOWN;
  let published = false;
  try {
    if (signal?.aborted) return interruptedSend("unpublished");
    options.validate?.();
    const live = await hasLivePeerWatcher();
    if (signal?.aborted) return interruptedSend("unpublished");
    if (!live) return fail(lifecycle ? "Remote lifecycle commands need ib watch running on this machine" : "remote sends need ib watch running on this machine");
    const base = peerOutboxDir();
    const dir = join(base, id);
    const staging = join(base, ".staging", id + "." + process.pid);
    let claimed: string | undefined;
    await mkdir(join(base, ".staging"), { mode: 0o700, recursive: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      // Worktree CLI requests arrive here through their unsandboxed watchdog.
      const start = stagingOwnerStart(process.pid);
      if (start === null) throw new Error("Cannot verify the peer-outbox owner");
      await writeTransferOwner(staging, { pid: process.pid, start });
      await writeJson(staging, "request.json", await options.prepare(staging));
      await beforePublish?.();
      signal?.throwIfAborted();
      await rename(staging, dir);
      published = true;
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      if (signal?.aborted) return interruptedSend("unpublished");
      throw err;
    }
    const publishedAt = performance.now();
    let deadline = publishedAt + 10_000; // M2 claim window. Transfer progress uses the wire idle interval.
    let claimedSeen = false;
    let lastSequence = 0;
    let warnedProgress = false;
    let progressRead: Promise<void> | undefined;
    let polling = true;

    let resultDiagnostic: string | undefined;
    const readResult = requestLookup(async (): Promise<IbCommandResult | undefined> => {
      if (!claimed) {
        try { await access(dir); return; } catch (err) { if (!missing(err)) throw err; }
        claimed = await findClaim(base, id);
      }
      if (!claimed) return;
      try {
        const result = JSON.parse(await readFile(join(claimed, "result.json"), "utf8"));
        return result.ok === true && result.id === id
          ? { ok: true, exitCode: 0, stdout: success, stderr: result.output ?? "" }
          : fail(result.error ?? unknown);
      } catch (err) {
        if (!missing(err)) resultDiagnostic = detail(err);
      }
    }, err => { resultDiagnostic = detail(err); });
    function consume(result: IbCommandResult) {
      polling = false;
      trackSendCleanup(rm(claimed!, { recursive: true, force: true }), "Peer send result cleanup failed");
      return result;
    }
    async function readProgress() {
      if (!claimed || lifecycle) return;
      try {
        const { sequence } = JSON.parse(await readFile(join(claimed, "progress"), "utf8"));
        if (polling && Number.isSafeInteger(sequence) && sequence > lastSequence) {
          onProgress?.();
          lastSequence = sequence;
          deadline = performance.now() + IDLE_TIMEOUT_MS;
        }
      } catch (err) {
        if (!missing(err) && !warnedProgress) {
          warnSendCleanup(`Remote send progress read failed: ${detail(err)}`);
          warnedProgress = true;
        }
      }
    }
    while (!signal?.aborted) {
      const result = await readResult(deadline - performance.now(), signal);
      if (result && !signal?.aborted) return consume(result);
      if (signal?.aborted) break;
      if (!claimedSeen && claimed) {
        claimedSeen = true;
        deadline = lifecycle ? publishedAt + lifecycle.timeout : performance.now() + IDLE_TIMEOUT_MS;
      }
      progressRead ??= readProgress().finally(() => { progressRead = undefined; });
      if (performance.now() >= deadline) break;
      await Bun.sleep(50);
    }
    polling = false;
    const withdrawn = await withdrawPublishedRequest(dir, staging);
    if (!withdrawn) {
      // Reuse an outstanding lookup through the final check. A hung lookup
      // cannot hold Ctrl-C or extend an ordinary timeout indefinitely.
      if (!claimed || !signal?.aborted) {
        const result = await readResult(150, signal?.aborted ? undefined : signal);
        if (result && !signal?.aborted) return consume(result);
      }
      if (claimed) await writeFile(join(claimed, signal?.aborted ? "cancel" : "timeout"), "", { mode: 0o600 })
        .catch(err => { if (!missing(err)) warnSendCleanup(`Could not signal claimed send cancellation: ${err}`); });
      if (lifecycle) return fail(unknown);
      if (!signal?.aborted) {
        const last = await readResult(150, signal);
        if (last && !signal?.aborted) return consume(last);
      }
      if (resultDiagnostic && !signal?.aborted) return fail(`outcome unknown — check the recipient (${resultDiagnostic})`);
    }
    if (lifecycle) return fail(unknown);
    if (signal?.aborted) return interruptedSend(withdrawn ? "withdrawn" : "claimed");
    return fail(withdrawn ? "Remote send timed out before ib watch claimed the request" : "Remote send timed out: " + SEND_UNKNOWN);
  } catch (err) { return !published && signal?.aborted ? interruptedSend("unpublished") : fail(published ? `${lifecycle ? unknown : "outcome unknown — check the recipient"} (${detail(err)})` : detail(err)); }
}

type Lifecycle = (peer: string, request: RemoteLifecycleRequest, transfer: OutgoingTransfer) => Promise<string>;

type Send = (peer: string, header: SendHeader, transfer: OutgoingTransfer) => Promise<string>;

// A peer id (64 ASCII characters) and the JSON object wrapping the wire header.
const MAX_ENVELOPE_BYTES = MAX_HEADER_BYTES + 192;
async function readRequest(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Expected a regular peer request file");
    if (info.size > MAX_ENVELOPE_BYTES) throw new Error("Peer request exceeds the envelope limit");
    const bytes = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (!bytesRead) return JSON.parse(bytes.toString("utf8", 0, length));
      length += bytesRead;
    }
    throw new Error("Peer request exceeds the envelope limit");
  } finally { await file.close(); }
}

export function createPeerOutboxPoll(now = () => performance.now()) {
  const active = new Set<string>();
  type DeliveryResult = { ok: true; id: string; output?: string } | { ok: false; error: string };
  let workers = 0;

  async function releaseBodies(dir: string, log: (line: string) => void, delay = 250): Promise<void> {
    try { await rm(join(dir, "files"), { recursive: true, force: true }); }
    catch (err) {
      log(`peer-outbox: retrying sent file cleanup: ${detail(err)}`);
      setTimeout(() => void releaseBodies(dir, log, Math.min(30_000, delay * 2)), delay).unref();
    }
  }

  async function finalize(dir: string, result: DeliveryResult, log: (line: string) => void, delay = 250): Promise<void> {
    try {
      if (!existsSync(join(dir, "result.json"))) {
        if (existsSync(join(dir, "cancel"))) await rm(dir, { recursive: true, force: true });
        else await writeJson(dir, "result.json", result);
      }
    } catch (err) {
      if (!missing(err) || existsSync(dir)) {
        log(`peer-outbox: retrying claim finalization: ${detail(err)}`);
        // This worker owns the result even after its endpoint and poller stop.
        setTimeout(() => void finalize(dir, result, log, Math.min(30_000, delay * 2)), delay).unref();
        return;
      }
    }
    active.delete(dir);
  }

  async function sweep(parent: string, staging = false) {
    await sweepEntries(parent, async name => {
      const id = staging ? name.replace(/\.[1-9]\d*$/, "") : name;
      const path = join(parent, name);
      if (requestId.test(id) && !active.has(path)) await sweepTransferDirectory(path, now());
    });
  }

  async function recoverClaim(parent: string, name: string) {
    const claim = parseClaim(name);
    const dir = join(parent, name);
    if (!claim || active.has(dir)) return;
    await safeTransferParent(dir);
    const client = await inspectTransferDirectory(dir);
    const published = existsSync(join(dir, "result.json"));
    if ((!published && existsSync(join(dir, "cancel"))) || reclaimTransfer(client.state, client.inode, now())) {
      await rm(dir, { recursive: true, force: true });
      return;
    }
    if (published) {
      await rm(join(dir, "files"), { recursive: true, force: true });
      return;
    }
    if (transferOwnerState(claim.owner, 0) === "proven-dead") {
      // A claim can survive a crash on either side of FIN. Never re-dispatch it.
      await rm(join(dir, "files"), { recursive: true, force: true });
      await writeJson(dir, "result.json", { ok: false, error: "outcome unknown — check the recipient" });
    }
  }

  async function recover() {
    const base = peerOutboxDir();
    const claimed = join(base, ".claimed");
    await finishRecovery([sweep(base), sweepEntries(claimed, id => recoverClaim(claimed, id)), sweep(join(base, ".staging"), true)]);
  }

  async function poll(send: Send, log: (line: string) => void, ownsEndpoint = () => true, dispatchFinished?: () => void, runLifecycle?: Lifecycle): Promise<void> {
    const base = peerOutboxDir();
    const claimed = join(base, ".claimed");
    if (!ownsEndpoint()) return;
    if (workers >= 4) return;
    const ready = (await transferDirectoryBatch(base, "dispatch")).filter(name => requestId.test(name));
    if (!ready.length) return;
    await mkdir(claimed, { recursive: true, mode: 0o700 });
    await safeTransferParent(claimed);
    const ids = ready.values();
    const publications: Promise<void>[] = [];
    async function worker() {
      workers++;
      try {
        for (const id of ids) {
          if (!ownsEndpoint()) return;
          const start = stagingOwnerStart(process.pid);
          if (start === null) { log("Cannot verify the peer-outbox worker"); continue; }
          const owner = { pid: process.pid, start };
          const dir = join(claimed, `${id}@${owner.pid}-${start}`);
          if (active.has(dir)) continue;
          active.add(dir);
          try {
            const readyDir = join(base, id);
            if ((await inspectTransferDirectory(readyDir)).state !== "verified-live") { active.delete(dir); continue; }
            await rename(readyDir, dir);
          } catch (err) {
            active.delete(dir);
            if (!missing(err)) log(`peer-outbox: ${detail(err)}`);
            continue;
          }
          let result: DeliveryResult;
          try {
            const submitter = await inspectTransferDirectory(dir);
            if (submitter.state !== "verified-live") throw new Error("Cannot verify the peer-outbox client");
            const { peer, header: raw, origin, lifecycle } = await readRequest(join(dir, "request.json"));
            const header = lifecycle === undefined ? parseSendHeader(raw) : undefined;
            if ((header && header.id !== id) || typeof peer !== "string") throw new Error("Invalid peer-outbox request");
            if (transferOwnerState(owner, 0) !== "verified-live") throw new Error("Cannot verify the peer-outbox worker");
            const verifyClient = () => {
              if (transferOwnerState(submitter.owner, 0) !== "verified-live") throw new Error("Cannot verify the peer-outbox client");
              if (origin !== undefined && transferOwnerState(origin, 0) !== "verified-live") throw new Error("Cannot verify the originating CLI");
            };
            verifyClient();
            const controller = new AbortController();
            let bytes = 0;
            let sequence = 0;
            let recorded = -1;
            let writing: Promise<void> | undefined;
            let warned = false;
            const checkCancel = cancellationPoll(async () => await cancellationMarkerExists(join(dir, "cancel"))
              || await cancellationMarkerExists(join(dir, "timeout")), controller);
            const tick = () => {
              if (!ownsEndpoint()) controller.abort(new Error("Send cancelled"));
              checkCancel();
              if (writing || sequence === recorded) return;
              const next = sequence;
              writing = writeJson(dir, "progress", { bytes, sequence: next }).then(() => { recorded = next; }, err => {
                if (!warned && !missing(err)) warnSendCleanup(`Remote send progress update failed: ${detail(err)}`);
                warned = true;
              }).finally(() => { writing = undefined; });
            };
            tick();
            const timer = setInterval(tick, 250);
            try {
              if (header) {
                const sent = await send(peer, header, {
                  verifyClient, filesDir: join(dir, "files"), signal: controller.signal, onProgress: n => { bytes = n; sequence++; },
                });
                result = { ok: true, id: sent };
              } else {
                if (!runLifecycle) throw new Error("Remote lifecycle commands are unavailable");
                result = { ok: true, id, output: await runLifecycle(peer, parseLifecycleRequest(lifecycle), { verifyClient, signal: controller.signal }) };
              }
              tick();
            } finally { clearInterval(timer); }
          } catch (err) { result = { ok: false, error: detail(err) }; }
          void releaseBodies(dir, log);
          publications.push(finalize(dir, result, log));
        }
      } finally { workers--; }
    }
    await Promise.all(Array.from({ length: Math.max(0, Math.min(4 - workers, ready.length)) }, worker));
    dispatchFinished?.();
    await Promise.all(publications);
  }
  return Object.assign(poll, { recover });
}

export type PeerOutboxPoll = (send: Send, log: (line: string) => void, ownsEndpoint?: () => boolean, dispatchFinished?: () => void, runLifecycle?: Lifecycle) => Promise<void>;
export const pollPeerOutbox: PeerOutboxPoll = createPeerOutboxPoll();
