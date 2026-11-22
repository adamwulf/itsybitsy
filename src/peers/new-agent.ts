import { listSpawnableTypeNamesSync } from "../agent-types";
import { REPO_COORDINATOR_TYPE, SYSTEM_COORDINATOR_TYPE } from "../coordinator-type-names";
import { validateAgentName, type newAgent } from "../ib-commands";
import { isValidRepoName } from "../validation";
import type { RepoEntry } from "../registry";
import { NEW_AGENT_MAX_REQUEST_BYTES } from "./peer-link";

export interface RemoteSpawnDeps {
  listRepos(): Promise<RepoEntry[]>;
  newAgent: typeof newAgent;
  notice(message: string): void;
}

/** The caller has just re-read the allowlist and obtained the paired name. */
export async function acceptRemoteAgent(
  { repo, type, name, prompt }: Record<string, unknown>,
  readPeerName: () => Promise<string | null>,
  deps: RemoteSpawnDeps,
  log: (line: string) => void,
): Promise<string> {
  if (typeof repo !== "string" || !isValidRepoName(repo)) throw new Error("Invalid repo registry name");
  const repos = await deps.listRepos();
  const registered = repos.find(r => r.name.toLowerCase() === repo.toLowerCase());
  if (!registered) throw new Error("Repo is not registered on this machine");
  if (typeof type !== "string" || !listSpawnableTypeNamesSync().includes(type)) {
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

  const peerName = await readPeerName();
  if (peerName === null) throw new Error("Machine is no longer paired");
  const result = await deps.newAgent(registered.path, prompt, { type, name });
  if (!result.ok) throw new Error(result.stderr || result.stdout || "Could not start agent");
  const id = result.stdout.trim();
  const notice = `${peerName} started agent ${id} in ${registered.name}`;
  log(notice);
  deps.notice(notice);
  return id;
}
