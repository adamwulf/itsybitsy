import { realpath } from "node:fs/promises";
import { findOwnRepo } from "../resolve-target";
import { getCoordinatorAgentId } from "../coordinator";
import { isRegisteredAgentWorktree } from "../no-worktree-caller";
import { isHumanSendTerminal } from "./remote-start-caller";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { MAX_HEADER_BYTES } from "./transfer-limits";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userHome } from "../home";
import { resolveSenderId, resolveRemoteSharedCaller, type IbCommandResult } from "../ib-commands";
import { readMachineName } from "../machine-name";
import { registeredQueueRepo } from "../outbox";
import { readRepoId } from "../repo-id";
import type { RepoEntry } from "../registry";
import { matchWorktreeCaller, runtimeDir } from "../runtime-names";
import { hasLivePeerWatcher } from "./endpoint-lock";
import { SEND_UNKNOWN } from "./peer-link";
import { targetLabel } from "./receive-message";
import { encodeSendHeader, parseSendHeader, type SendHeader, type SendTarget } from "./send-frame";

const root = () => join(runtimeDir(userHome()), "peer-outbox");
const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
const detail = (err: unknown) => err instanceof Error ? err.message : String(err);
const fail = (stderr: string): IbCommandResult => ({ ok: false, exitCode: 1, stdout: "", stderr });
const requestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export async function qualifiedAgentSender(id: string, repoPath: string, repos: RepoEntry[]): Promise<SendHeader["from"]> {
  const registered = await registeredQueueRepo(repoPath, repos);
  const repo = registered ?? "~" + await readRepoId(repoPath);
  return { kind: "agent", id: `${await readMachineName()}/${repo}/${id}` };
}

export const remoteCliCaller = { isHuman: isHumanSendTerminal };
const unverifiable = "cannot verify the sender of a remote send; run it from a terminal or from the agent's worktree";

export async function cliRemoteSender(repos: RepoEntry[], explicit?: string, cwd = process.cwd()): Promise<SendHeader["from"]> {
  let id = "";
  let from: SendHeader["from"] = { kind: "user" };
  if (!await remoteCliCaller.isHuman()) {
    const path = await realpath(cwd);
    id = resolveSenderId("", { cwd: path });
    const worktree = matchWorktreeCaller(path);
    if (worktree) {
      if (!id || !await isRegisteredAgentWorktree(path, [worktree[1]!])) throw new Error(unverifiable);
      from = await qualifiedAgentSender(id, worktree[1]!, repos);
    } else if (id === "@system") {
      from = { kind: "system" };
    } else {
      const repo = findOwnRepo(path, repos);
      const caller = repo && await resolveRemoteSharedCaller(path, repo.path, getCoordinatorAgentId(repo.path)).catch(() => null);
      if (!caller) throw new Error(unverifiable);
      id = String(caller.meta.id);
      from = await qualifiedAgentSender(id, caller.repoPath, repos);
    }
  }
  if (explicit !== undefined && explicit !== id) throw new Error("Remote --from must match the detected sender");
  return from;
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
export async function handoffRemoteMessage(peer: string, header: SendHeader, signal?: AbortSignal): Promise<IbCommandResult> {
  try {
    if (!await hasLivePeerWatcher()) return fail("remote sends need ib watch running on this machine");
    encodeSendHeader(parseSendHeader(header));
    const base = root();
    const dir = join(base, header.id);
    const staging = join(base, ".staging", header.id);
    const claimed = join(base, ".claimed", header.id);
    await mkdir(join(base, ".staging"), { mode: 0o700, recursive: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      await writeJson(staging, "request.json", { peer, header });
      await rename(staging, dir);
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
    const deadline = Date.now() + 10_000;
    while (!signal?.aborted && Date.now() < deadline) {
      try {
        const result = JSON.parse(await readFile(join(claimed, "result.json"), "utf8"));
        await rm(claimed, { recursive: true, force: true });
        return result.ok === true && result.id === header.id
          ? { ok: true, exitCode: 0, stdout: `Sent to ${targetLabel(header.target)}`, stderr: "" }
          : fail(result.error ?? SEND_UNKNOWN);
      } catch (err) {
        if (!missing(err)) throw err;
      }
      await Bun.sleep(50);
    }
    const reason = signal?.aborted ? "Remote send interrupted" : "Remote send timed out";
    try { await rename(dir, staging); } catch (err) {
      if (missing(err)) return fail(reason + ": " + SEND_UNKNOWN);
      throw err;
    }
    await rm(staging, { recursive: true, force: true });
    return fail(reason + " before ib watch claimed the request");
  } catch (err) { return fail(detail(err)); }
}

type Send = (peer: string, header: SendHeader) => Promise<string>;

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

const retentionMs = 10 * 60_000;

export function createPeerOutboxPoll(now = Date.now) {
  const active = new Set<string>();
  let nextSweep = 0;
  let lastBase: string | undefined;
  let workers = 0;

  async function sweep(parent: string) {
    let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); }
    catch (err) { if (missing(err)) return; throw err; }
    for (const entry of entries) {
      const path = join(parent, entry.name);
      if (!entry.isDirectory() || !requestId.test(entry.name) || active.has(path)) continue;
      try {
        if (now() - (await stat(path)).mtimeMs >= retentionMs && !active.has(path)) {
          await rm(path, { recursive: true, force: true });
        }
      } catch (err) { if (!missing(err)) throw err; }
    }
  }

  return async function poll(send: Send, log: (line: string) => void, ownsEndpoint = () => true): Promise<void> {
    const base = root();
    const claimed = join(base, ".claimed");
    if (base !== lastBase || now() >= nextSweep) {
      lastBase = base;
      nextSweep = now() + 30_000;
      await Promise.all([sweep(claimed), sweep(join(base, ".staging"))]);
    }
    if (!ownsEndpoint() || workers >= 4) return;
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (err) { if (missing(err)) return; throw err; }
    const ready = entries.filter(e => e.isDirectory() && requestId.test(e.name));
    if (!ready.length) return;
    await mkdir(claimed, { recursive: true, mode: 0o700 });
    const ids = ready.map(e => e.name).values();
    async function worker() {
      workers++;
      try {
        for (const id of ids) {
          if (!ownsEndpoint()) return;
          const dir = join(claimed, id);
          try {
            await rename(join(base, id), dir);
          } catch (err) {
            if (!missing(err)) log(`peer-outbox: ${detail(err)}`);
            continue;
          }
          active.add(dir);
          try {
            if (now() - (await stat(dir)).mtimeMs >= retentionMs) {
              await rm(dir, { recursive: true, force: true });
              continue;
            }
            let result;
            try {
              const { peer, header: raw } = await readRequest(join(dir, "request.json"));
              const header = parseSendHeader(raw);
              if (header.id !== id || typeof peer !== "string") throw new Error("Invalid peer-outbox request");
              result = { ok: true, id: await send(peer, header) };
            } catch (err) { result = { ok: false, error: detail(err) }; }
            await writeJson(dir, "result.json", result);
          } catch (err) {
            if (!missing(err)) log(`peer-outbox: ${detail(err)}`);
          } finally { active.delete(dir); }
        }
      } finally { workers--; }
    }
    await Promise.all(Array.from({ length: Math.min(4 - workers, ready.length) }, worker));
  };
}

export const pollPeerOutbox = createPeerOutboxPoll();
