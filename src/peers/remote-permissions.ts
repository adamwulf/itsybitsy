/** The receiver of `{"op":"permissions"}` (SPEC §20.4 "Remote permissions"): `b` in a paired dashboard on one of this machine's agents. */
import type { effectiveSpawnCapability, grantAgentPermission, setAgentSpawnCapability } from "../agent-permissions";
import { isCoordinatorType } from "../coordinator-type-names";
import { isStoredRepoName, type listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { isValidAgentId, isValidToolList } from "../validation";
import { singleLine } from "./single-line";

/** With neither `allow` nor `canSpawnChildren`, a read of the agent's spawn capability. */
export interface RemotePermissionRequest {
  repo: string;
  id: string;
  /** An entry to add to the agent's settings.local.json allow list. */
  allow?: string;
  /** The spawn capability to set as the agent's per-agent override. */
  canSpawnChildren?: boolean;
}

export interface RemotePermissionOutcome {
  /** The agent's effective spawn capability once the request is done. */
  canSpawnChildren: boolean;
  /** The change was made, but telling the agent failed. */
  notifyError?: string;
}

export function parsePermissionRequest(raw: Record<string, unknown>): RemotePermissionRequest {
  const { repo, id, allow, canSpawnChildren } = raw;
  if (!isStoredRepoName(repo) || repo.includes("\0")) throw new Error("Invalid repo registry name");
  if (typeof id !== "string" || !isValidAgentId(id)) throw new Error("Invalid agent id");
  if (allow !== undefined && (typeof allow !== "string" || !allow.trim() || allow !== allow.trim() || !isValidToolList(allow))) {
    throw new Error("Invalid permission entry");
  }
  if (canSpawnChildren !== undefined && typeof canSpawnChildren !== "boolean") throw new Error("Invalid spawn capability");
  if (allow !== undefined && canSpawnChildren !== undefined) throw new Error("A permission request changes one thing");
  return { repo, id, ...(allow !== undefined && { allow }), ...(canSpawnChildren !== undefined && { canSpawnChildren }) };
}

export interface RemotePermissionDeps {
  listRepos: typeof listRepos;
  effectiveSpawnCapability: typeof effectiveSpawnCapability;
  grantAgentPermission: typeof grantAgentPermission;
  setAgentSpawnCapability: typeof setAgentSpawnCapability;
  notice(message: string, kind: "info" | "error"): void;
}

/**
 * Resolve agent `id` in the registered repo `repo` (ignoring case) and read or
 * change its permissions as the local `b` does. A failed change's reason is
 * the notice the local dialog would show.
 */
export async function acceptRemotePermission(request: RemotePermissionRequest, readPeerName: () => Promise<string | null>, deps: RemotePermissionDeps, log: (line: string) => void): Promise<RemotePermissionOutcome> {
  const { repo, id } = request;
  const repos = (await deps.listRepos()).filter(entry => entry.name.toLowerCase() === repo.toLowerCase());
  if (repos.length !== 1) throw new Error("Repo is not uniquely registered on this machine");
  const { agent, error } = await resolveAgentTarget(id, repos, "/", "agent", true);
  if (!agent) throw new Error(error ?? `Agent not found: ${id}`);
  if (isCoordinatorType(agent.meta.agentType)) throw new Error("Remote coordinators are read-only");
  const peer = await readPeerName();
  if (peer === null) throw new Error("Machine is no longer paired");
  if (request.allow === undefined && request.canSpawnChildren === undefined) {
    return { canSpawnChildren: await deps.effectiveSpawnCapability(agent) };
  }
  const result = request.allow !== undefined
    ? await deps.grantAgentPermission(agent, request.allow)
    : await deps.setAgentSpawnCapability(agent, request.canSpawnChildren!);
  if (!result.ok) throw new Error(result.error);
  const done = request.allow !== undefined
    ? `${peer} added ${request.allow} to ${agent.id} allow list in ${agent.repoRegistryName}`
    : `${peer} ${request.canSpawnChildren ? "enabled" : "disabled"} sub-agent spawning for ${agent.id} in ${agent.repoRegistryName}`;
  log(singleLine(result.notifyError === undefined ? done : `${done} · notify failed: ${result.notifyError}`));
  deps.notice(done, "info");
  return {
    canSpawnChildren: await deps.effectiveSpawnCapability(agent),
    ...(result.notifyError !== undefined && { notifyError: result.notifyError }),
  };
}
