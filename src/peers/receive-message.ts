import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTransferLimits } from "../config";
import { readMachineName } from "../machine-name";
import { sanitizeAttachmentName } from "./attachment-name";
import { rewriteAttachmentPaths, type AttachmentMapping } from "./attachment-paths";
import { hasFreeSpace } from "./attachment-space";
import { checkIncomingFiles } from "./transfer-limits";
import type { PairStream } from "./pairing";
import { sendMessage, type PeerEnqueueOptions } from "../ib-commands";
import { listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { streamFileBody, requireSendFin, type FileBodyOptions, type SendHeader, type SendTarget } from "./send-frame";

export function targetLabel(target: SendTarget): string {
  if (target.kind === "system") return "@system";
  if (target.kind === "repo-coordinator") return "@" + target.repo;
  return target.repo ? target.repo + "/" + target.agent : target.agent;
}

async function enqueue(header: SendHeader, peerName: string, peerSend: PeerEnqueueOptions) {
  const fromAgent = header.from.kind === "agent" ? header.from.id :
    header.from.kind === "system" ? peerName + "/@system" : undefined;
  const opts = { fromAgent, peerSend, noPassthrough: header.files.length > 0 };
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

/** Shared across this watcher's inbound connections. Concurrent replays await the first enqueue. */
export function createMessageReceiver(log: (line: string) => void, notice: (line: string) => void, now = Date.now, capacity = 4096,
  storage = { tempDir: "/tmp", hasFreeSpace },
) {
  const accepted = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const receiving = new Set<string>();
  return async (header: SendHeader, peerId: string, readPeerName: () => Promise<string | null>,
    body?: Pick<PairStream, "read">, options: FileBodyOptions = {}) => {
    if (!header.message) throw new Error("Message is empty");
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
    if (earlier) return earlier;
    if (accepted.size + pending.size >= capacity) throw new Error("busy, try again");
    const work = async () => {
      const { files } = header;
      let root: string | undefined;
      let bodyError: unknown;
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (files.length) {
        if (receiving.has(peerId) || receiving.size >= 2) throw new Error("busy, try again");
        receiving.add(peerId);
      }
      try {
        const result = await enqueue(header, name, {
          log,
          senderKind: header.from.kind === "user" ? undefined : header.from.kind,
          async beforeEnqueue() {
            const mapping: AttachmentMapping[] = [];
            if (files.length) {
              if (!body) throw new Error("Missing attachment stream");
              try {
                const limits = checkIncomingFiles(files, await readTransferLimits(), { machine: await readMachineName() });
                if (!limits.ok) throw new Error(limits.error);
                if (!await storage.hasFreeSpace(storage.tempDir, total)) throw new Error("Insufficient space for attachments and the 1 GiB reserve");
                root = await mkdtemp(join(storage.tempDir, "itsybitsy-attachments-"));
                let received = 0;
                for (const [index, file] of files.entries()) {
                  const dir = join(root, String(index));
                  await mkdir(dir, { mode: 0o700 });
                  const destination = join(dir, sanitizeAttachmentName(file.name));
                  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                  try {
                    const digest = await streamFileBody(body, file.size, chunk => handle.writeFile(chunk), {
                      ...options, onProgress: bytes => options.onProgress?.(received + bytes),
                    });
                    if (digest !== file.sha256.toLowerCase()) throw new Error("Attachment hash mismatch");
                  } finally { await handle.close(); }
                  received += file.size;
                  mapping.push({ destination, spellings: file.spellings });
                }
                await requireSendFin(body, options);
              } catch (err) { bodyError = err; throw err; }
            }
            if (await readPeerName() === null) throw new Error("not a peer");
            if (mapping.length) return rewriteAttachmentPaths(header.message, mapping);
          },
        });
        if (!result.ok) throw bodyError ?? new Error(result.stderr);
      } catch (error) {
        if (root) await rm(root, { recursive: true, force: true });
        throw error;
      } finally { if (files.length) receiving.delete(peerId); }
      accepted.set(key, now() + 600_000);
      const summary = files.length ? ` (${files.length} files, ${(total / 1024 ** 2).toFixed(2)} MB)` : "";
      const line = `${name} sent a message${summary} to ${targetLabel(header.target)}`;
      log(line);
      notice(line);
    };
    const task = work();
    pending.set(key, task);
    try { await task; } finally { pending.delete(key); }
  };
}
