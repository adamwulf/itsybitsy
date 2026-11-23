import { inspectTransferDirectory, safeTransferParent, sweepTransferDirectory, transferDirectoryBatch, writeTransferOwner, stagingOwnerStart } from "./transfer-owner";
import { trackSendCleanup, warnSendCleanup } from "../send-cleanup";
import type { StageRemoteFiles } from "./remote-attachments";
import { interruptedSend, withdrawPublishedRequest } from "../spawn-broker";
import { verifiedSendCaller } from "./send-caller";
export { remoteCliCaller } from "./send-caller";
import { randomUUID } from "node:crypto";
import { constants, existsSync, renameSync, writeFileSync } from "node:fs";
import { IDLE_TIMEOUT_MS, MAX_HEADER_BYTES } from "./transfer-limits";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export async function qualifiedAgentSender(id: string, repoPath: string, repos: RepoEntry[]): Promise<SendHeader["from"]> {
  const repo = await registeredQueueRepo(repoPath, repos);
  if (!repo) throw new Error("Remote sends require the requester's repo to be registered");
  return { kind: "agent", id: `${await readMachineName()}/${repo}/${id}` };
}

type RemoteSender =
  | { kind: "direct"; from: SendHeader["from"] }
  | { kind: "worktree"; id: string; repoPath: string; agentDir: string };

export async function cliRemoteSender(repos: RepoEntry[], explicit?: string, cwd = process.cwd()): Promise<RemoteSender> {
  const identity = await verifiedSendCaller(cwd, "remote", repos.map(repo => repo.path));
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
  const temp = join(dir, name + ".tmp");
  await writeFile(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  await rename(temp, join(dir, name));
}

export function textHeader(target: SendTarget, message: string, from: SendHeader["from"]): SendHeader {
  return { op: "send", id: randomUUID(), target, message, from, files: [] };
}

/** A claimed request might already have reached the other machine. Never re-submit it. */
export async function handoffRemoteMessage(peer: string, header: SendHeader, signal?: AbortSignal, stage?: StageRemoteFiles, onProgress?: () => void): Promise<IbCommandResult> {
  let published = false;
  try {
    if (signal?.aborted) return interruptedSend("unpublished");
    encodeSendHeader(parseSendHeader(header));
    const live = await hasLivePeerWatcher();
    if (signal?.aborted) return interruptedSend("unpublished");
    if (!live) return fail("remote sends need ib watch running on this machine");
    const base = peerOutboxDir();
    const dir = join(base, header.id);
    const staging = join(base, ".staging", header.id + "." + process.pid);
    const claimed = join(base, ".claimed", header.id);
    await mkdir(join(base, ".staging"), { mode: 0o700, recursive: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      // Worktree CLI requests arrive here through their unsandboxed watchdog.
      const start = stagingOwnerStart(process.pid);
      if (start === null) throw new Error("Cannot verify the peer-outbox owner");
      await writeTransferOwner(staging, { pid: process.pid, start });
      if (stage) {
        header = { ...header, files: await stage(join(staging, "files")) };
        encodeSendHeader(parseSendHeader(header));
      }
      await writeJson(staging, "request.json", { peer, header });
      signal?.throwIfAborted();
      await rename(staging, dir);
      published = true;
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      if (signal?.aborted) return interruptedSend("unpublished");
      throw err;
    }
    let deadline = Date.now() + 10_000; // M2 claim window. Transfer progress uses the wire idle interval.
    let lastProgress = "";

    const readResult = async (): Promise<IbCommandResult | undefined> => {
      try {
        const result = JSON.parse(await readFile(join(claimed, "result.json"), "utf8"));
        trackSendCleanup(rm(claimed, { recursive: true, force: true }), "Peer send result cleanup failed");
        return result.ok === true && result.id === header.id
          ? { ok: true, exitCode: 0, stdout: `Sent to ${targetLabel(header.target)}`, stderr: "" }
          : fail(result.error ?? SEND_UNKNOWN);
      } catch (err) {
        if (!missing(err)) throw err;
      }
    };
    while (!signal?.aborted && Date.now() < deadline) {
      const result = await readResult();
      if (result && !signal?.aborted) return result;
      if (signal?.aborted) break;
      try {
        const progress = await readFile(join(claimed, "progress"), "utf8");
        if (progress !== lastProgress) {
          if (JSON.parse(progress).sequence > 0) onProgress?.();
          lastProgress = progress;
          deadline = Date.now() + IDLE_TIMEOUT_MS;
        }
      } catch (err) { if (!missing(err)) throw err; }
      await Bun.sleep(50);
    }
    const withdrawn = await withdrawPublishedRequest(dir, staging);
    if (!withdrawn) {
      await writeFile(join(claimed, "cancel"), "", { mode: 0o600 })
        .catch(err => { if (!missing(err)) warnSendCleanup(`Could not signal claimed send cancellation: ${err}`); });
      if (existsSync(join(claimed, "result.json"))) {
        trackSendCleanup(rm(claimed, { recursive: true, force: true }), "Cancelled peer result cleanup failed");
      }
    }
    if (signal?.aborted) return interruptedSend(withdrawn ? "withdrawn" : "claimed");
    return fail(withdrawn ? "Remote send timed out before ib watch claimed the request" : "Remote send timed out: " + SEND_UNKNOWN);
  } catch (err) { return !published && signal?.aborted ? interruptedSend("unpublished") : fail(detail(err)); }
}

type Send = (peer: string, header: SendHeader, transfer: OutgoingTransfer) => Promise<string>;

// A peer id (64 ASCII characters) and the JSON object wrapping the wire header.
const MAX_ENVELOPE_BYTES = MAX_HEADER_BYTES + 128;
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

export function createPeerOutboxPoll(now = Date.now) {
  const active = new Set<string>();
  let nextSweep = 0;
  let lastBase: string | undefined;
  let workers = 0;

  let sweeping: Promise<void> | undefined;
  async function sweep(parent: string, staging = false) {
    for (const name of await transferDirectoryBatch(parent)) {
      const id = staging ? name.replace(/\.[1-9]\d*$/, "") : name;
      const path = join(parent, name);
      if (requestId.test(id) && !active.has(path)) await sweepTransferDirectory(path, now());
    }
  }

  return async function poll(send: Send, log: (line: string) => void, ownsEndpoint = () => true): Promise<void> {
    const base = peerOutboxDir();
    const claimed = join(base, ".claimed");
    if (!sweeping && (base !== lastBase || now() >= nextSweep)) {
      lastBase = base;
      nextSweep = now() + 30_000;
      sweeping = Promise.all([sweep(base), sweep(claimed), sweep(join(base, ".staging"), true)]).then(() => {}).finally(() => { sweeping = undefined; });
    }
    await sweeping;
    if (!ownsEndpoint() || workers >= 4) return;
    const ready = (await transferDirectoryBatch(base, "dispatch")).filter(name => requestId.test(name));
    if (!ready.length) return;
    await mkdir(claimed, { recursive: true, mode: 0o700 });
    await safeTransferParent(claimed);
    const ids = ready.values();
    async function worker() {
      workers++;
      try {
        for (const id of ids) {
          if (!ownsEndpoint()) return;
          const dir = join(claimed, id);
          try {
            if ((await inspectTransferDirectory(join(base, id))).state !== "verified-live") continue;
            await rename(join(base, id), dir);
          } catch (err) {
            if (!missing(err)) log(`peer-outbox: ${detail(err)}`);
            continue;
          }
          active.add(dir);
          try {
            const { owner: clientOwner, state } = await inspectTransferDirectory(dir);
            if (state !== "verified-live" || !clientOwner) continue;
            const start = stagingOwnerStart(process.pid);
            if (start === null) throw new Error("Cannot verify the peer-outbox worker");
            await writeTransferOwner(dir, { pid: process.pid, start });
            let result;
            try {
              const { peer, header: raw } = await readRequest(join(dir, "request.json"));
              const header = parseSendHeader(raw);
              if (header.id !== id || typeof peer !== "string") throw new Error("Invalid peer-outbox request");
              const controller = new AbortController();
              let bytes = 0;
              let sequence = 0;
              let recorded = -1;
              // Publish the initial claim once and then only actual wire progress.
              const tick = () => {
                try {
                  if (existsSync(join(dir, "cancel")) || !ownsEndpoint()) controller.abort(new Error("Send cancelled"));
                  if (sequence === recorded) return;
                  recorded = sequence;
                  writeFileSync(join(dir, "progress.tmp"), JSON.stringify({ bytes, sequence }), { mode: 0o600 });
                  renameSync(join(dir, "progress.tmp"), join(dir, "progress"));
                } catch (err) { controller.abort(err); }
              };
              tick();
              const timer = setInterval(tick, 250);
              try {
                result = { ok: true, id: await send(peer, header, {
                  filesDir: join(dir, "files"), signal: controller.signal, onProgress: n => { bytes = n; sequence++; },
                }) };
                tick();
              } finally { clearInterval(timer); }
            } catch (err) { result = { ok: false, error: detail(err) }; }
            if (existsSync(join(dir, "cancel"))) {
              await rm(dir, { recursive: true, force: true });
              continue;
            }
            await writeTransferOwner(dir, clientOwner);
            await writeJson(dir, "result.json", result);
            await rm(join(dir, "files"), { recursive: true, force: true })
              .catch(err => log(`peer-outbox: could not remove sent files: ${detail(err)}`));
          } catch (err) {
            if (!missing(err)) log(`peer-outbox: ${detail(err)}`);
          } finally {
            if (existsSync(join(dir, "cancel"))) await rm(dir, { recursive: true, force: true })
              .catch(err => log(`peer-outbox: cancelled claim cleanup failed: ${detail(err)}`));
            active.delete(dir);
          }
        }
      } finally { workers--; }
    }
    await Promise.all(Array.from({ length: Math.min(4 - workers, ready.length) }, worker));
  };
}

export const pollPeerOutbox = createPeerOutboxPoll();
