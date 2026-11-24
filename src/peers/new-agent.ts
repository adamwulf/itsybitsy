import { REPO_COORDINATOR_TYPE, SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { validateAgentName, type newAgent } from "../ib-commands";
import { isStoredRepoName, type RepoEntry } from "../registry";
import type { PairStream } from "./pairing";
import { cleanRemoteText, NEW_AGENT_MAX_REQUEST_BYTES, withStartDeadline, type StartReceiptOptions } from "./peer-link";
import { fileSummary, type AttachmentReceiver } from "./receive-attachments";
import { waitForIO, type NewAgentHeader } from "./send-frame";

export interface RemoteSpawnDeps {
  listSpawnableTypes(): string[];
  listRepos(): Promise<RepoEntry[]>;
  newAgent: typeof newAgent;
  notice(message: string): void;
  /** This watcher's inbound attachments, shared with message sends. Without it, framed starts are refused. */
  attachments?: AttachmentReceiver;
}

interface ValidatedStart { repo: RepoEntry; type: string; name?: string; prompt: string }

/** Every check of a remote start, before the pairing re-check and any attachment body. */
async function validateRemoteAgent({ repo, type, name, prompt }: { repo?: unknown; type?: unknown; name?: unknown; prompt?: unknown }, deps: RemoteSpawnDeps): Promise<ValidatedStart> {
  if (!isStoredRepoName(repo) || repo.includes("\0")) throw new Error("Invalid repo registry name");
  const repos = await deps.listRepos();
  const registered = repos.find(r => r.name.toLowerCase() === repo.toLowerCase());
  if (!registered) throw new Error("Repo is not registered on this machine");
  if (typeof type !== "string" || !deps.listSpawnableTypes().includes(type)) {
    throw new Error("Agent type is unknown or not spawnable on this machine");
  }
  if (type === REPO_COORDINATOR_TYPE || type === SYSTEM_COORDINATOR_TYPE) throw new Error(`Cannot start a ${type} remotely`);
  if (name !== undefined) {
    if (typeof name !== "string") throw new Error("Agent name must be a string");
    const reason = validateAgentName(name, repos);
    if (reason) throw new Error(reason);
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Prompt must be non-empty text");
  if (Buffer.byteLength(prompt) > NEW_AGENT_MAX_REQUEST_BYTES) throw new Error("Prompt exceeds 256 KB");
  return { repo: registered, type, name, prompt };
}

/** The caller has just re-checked the pairing. `summary` describes received files for the log and notice. */
async function spawnRemoteAgent({ repo, type, name }: ValidatedStart, prompt: string, peerName: string, deps: RemoteSpawnDeps, log: (line: string) => void, summary = ""): Promise<string> {
  const result = await deps.newAgent(repo.path, prompt, { type, name });
  if (!result.ok) throw new Error(result.stderr || result.stdout || "Could not start agent");
  const id = result.stdout.trim();
  log(`${peerName} started agent ${id} in ${repo.name}${summary}`);
  deps.notice(`${peerName} started agent ${cleanRemoteText(id)} in ${repo.name}${summary}`);
  return id;
}

/** The caller has just re-read the allowlist and obtained the paired name. */
export async function acceptRemoteAgent(
  request: Record<string, unknown>,
  readPeerName: () => Promise<string | null>,
  deps: RemoteSpawnDeps,
  log: (line: string) => void,
): Promise<string> {
  const start = await validateRemoteAgent(request, deps);
  const peerName = await readPeerName();
  if (peerName === null) throw new Error("Machine is no longer paired");
  return spawnRemoteAgent(start, start.prompt, peerName, deps, log);
}

/**
 * A framed start (SPEC §20.4 "Remote starts"): every check of
 * {@link acceptRemoteAgent} before any body is read, then the bodies under the
 * limits, busy rule and reservation that message sends use. After the bodies
 * verify it re-checks the pairing, commits the snapshot and spawns with the
 * rewritten prompt. Only the spawn runs under the responder's start deadline.
 * A spawn that fails removes the committed snapshot, since nothing refers to it.
 */
export async function acceptRemoteAgentWithFiles(
  header: NewAgentHeader,
  peerId: string,
  readPeerName: () => Promise<string | null>,
  body: Pick<PairStream, "read">,
  options: StartReceiptOptions,
  deps: RemoteSpawnDeps,
  log: (line: string) => void,
): Promise<string> {
  const attachments = deps.attachments;
  if (!attachments) throw new Error("Remote starts with attachments are unavailable");
  const peerName = await waitForIO(options, readPeerName);
  if (peerName === null) throw new Error("Machine is no longer paired");
  const start = await waitForIO(options, () => validateRemoteAgent(header, deps));
  // The transfer slot and reservation last until the snapshot is committed, not through the spawn.
  const staged = await attachments(peerId, header.files, { peerName, log, notice: deps.notice }, async receive => {
    options.admitted?.(true);
    const received = await receive(start.prompt, body, options);
    if (await waitForIO(options, readPeerName) === null) throw new Error("Machine is no longer paired");
    options.signal?.throwIfAborted();
    options.committing?.();
    await received.commit();
    return received;
  });
  return withStartDeadline(options.setTimer, async () => {
    const spawn = spawnRemoteAgent(start, staged.text, peerName, deps, log, fileSummary(header.files));
    // Past the deadline the spawn may still succeed and use the files: only its own failure discards them.
    spawn.catch(() => staged.discard().catch(err => log(`peer link: could not remove unused attachments: ${err}`)));
    return spawn;
  });
}
