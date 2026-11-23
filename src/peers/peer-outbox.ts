import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userHome } from "../home";
import { resolveSenderId, type IbCommandResult } from "../ib-commands";
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

export async function cliRemoteSender(repos: RepoEntry[], explicit?: string, cwd = process.cwd()): Promise<SendHeader["from"]> {
  const id = resolveSenderId("", { cwd });
  if (explicit !== undefined && explicit !== id) throw new Error("Remote --from must match the detected sender");
  const worktree = matchWorktreeCaller(cwd);
  if (worktree) {
    if (id !== worktree[2]) throw new Error("Cannot verify remote sender from this worktree");
    return qualifiedAgentSender(id, worktree[1]!, repos);
  }
  return { kind: id === "@system" ? "system" : "user" };
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
export async function handoffRemoteMessage(peer: string, header: SendHeader): Promise<IbCommandResult> {
  try {
    if (!await hasLivePeerWatcher()) return fail("remote sends need ib watch running on this machine");
    encodeSendHeader(parseSendHeader(header));
    const dir = join(root(), header.id);
    await mkdir(root(), { mode: 0o700, recursive: true });
    await mkdir(dir, { mode: 0o700 });
    try {
      await writeJson(dir, "request.json", { peer, header });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    const deadline = Date.now() + 10_000;
    do {
      try {
        const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
        await rm(dir, { recursive: true, force: true });
        return result.ok === true && result.id === header.id
          ? { ok: true, exitCode: 0, stdout: `Sent to ${targetLabel(header.target)}`, stderr: "" }
          : fail(result.error ?? SEND_UNKNOWN);
      } catch (err) {
        if (!missing(err)) throw err;
      }
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    try { await unlink(join(dir, "request.json")); } catch (err) {
      if (missing(err)) return fail("Remote send timed out: " + SEND_UNKNOWN);
      throw err;
    }
    await rm(dir, { recursive: true, force: true });
    return fail("Remote send timed out before ib watch claimed the request");
  } catch (err) { return fail(detail(err)); }
}

type Send = (peer: string, header: SendHeader) => Promise<string>;

/** Only the bound endpoint owner polls. The rename wins against CLI cancellation
 * and concurrent polls. A claimed request from a previous owner is never replayed. */
export async function pollPeerOutbox(send: Send, log: (line: string) => void): Promise<void> {
  const base = root();
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  await Promise.all(entries.filter(e => e.isDirectory() && requestId.test(e.name)).map(async entry => {
    const dir = join(base, entry.name);
    try {
      if (Date.now() - (await stat(dir)).mtimeMs >= 600_000) {
        await rm(dir, { recursive: true, force: true });
        return;
      }
      const claimed = join(dir, "claimed.json");
      await rename(join(dir, "request.json"), claimed);
      let result;
      try {
        const { peer, header: raw } = JSON.parse(await readFile(claimed, "utf8"));
        const header = parseSendHeader(raw);
        if (header.id !== entry.name || typeof peer !== "string") throw new Error("Invalid peer-outbox request");
        result = { ok: true, id: await send(peer, header) };
      } catch (err) { result = { ok: false, error: detail(err) }; }
      await writeJson(dir, "result.json", result);
    } catch (err) {
      if (!missing(err)) log(`peer-outbox: ${detail(err)}`);
    }
  }));
}
