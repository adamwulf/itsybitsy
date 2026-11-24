import type { detectAgentStates } from "../agents";
import { isCoordinatorType } from "../coordinator-type-names";
import type { mergeAgent, mergeCheckAgent, retireAgent, rehireAgent, resumeAgent } from "../ib-commands";
import { isStoredRepoName, type listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { isValidAgentId } from "../validation";

export type RemoteLifecycleAction = "merge" | "retire" | "rehire" | "resume";
export interface RemoteLifecycleRequest {
  action: RemoteLifecycleAction;
  id: string;
  /** Machine/agent rehire can search all registered archives. */
  repo?: string;
  force?: boolean;
  keep?: boolean;
  checkOnly?: boolean;
}

export const lifecyclePast = { merge: "merged", retire: "retired", rehire: "rehired", resume: "resumed" } as const;
export const lifecycleTimeout = (action: RemoteLifecycleAction) => action === "merge" ? 120_000 : 30_000;

export function parseLifecycleRequest(raw: Record<string, unknown>): RemoteLifecycleRequest {
  const { action, id, repo, keep, checkOnly, force } = raw;
  if (action !== "merge" && action !== "retire" && action !== "rehire" && action !== "resume") throw new Error("Unknown lifecycle action");
  if (typeof id !== "string" || !id.trim() || id.includes("/") || id.startsWith("@") || /[\p{Cc}\p{Cf}]/u.test(id) ||
      (action !== "rehire" && !isValidAgentId(id))) throw new Error("Invalid agent id");
  if (repo !== undefined && (!isStoredRepoName(repo) || repo.includes("\0"))) throw new Error("Invalid repo registry name");
  if (repo === undefined && action !== "rehire") throw new Error("A registered repo is required");
  if ((force !== undefined && typeof force !== "boolean") ||
      (keep !== undefined && typeof keep !== "boolean") ||
      (checkOnly !== undefined && typeof checkOnly !== "boolean")) throw new Error("Invalid lifecycle options");
  if (action !== "merge" && (keep !== undefined || checkOnly !== undefined)) throw new Error("Keep and checkOnly apply only to merge");
  return { action, id, repo, keep, checkOnly, force };
}

export class AmbiguousRemoteRehire extends Error {
  constructor(reason: string, readonly candidates: { repo: string; id: string }[]) { super(reason); }
}

export interface RemoteLifecycleDeps {
  listRepos: typeof listRepos;
  mergeAgent: typeof mergeAgent;
  mergeCheckAgent: typeof mergeCheckAgent;
  retireAgent: typeof retireAgent;
  rehireAgent: typeof rehireAgent;
  resumeAgent: typeof resumeAgent;
  detectAgentStates: typeof detectAgentStates;
  notice(message: string): void;
}

export async function acceptRemoteLifecycle(request: RemoteLifecycleRequest, readPeerName: () => Promise<string | null>, deps: RemoteLifecycleDeps, log: (line: string) => void): Promise<string> {
  const { action, repo, id } = request;
  let repos = await deps.listRepos();
  if (repo !== undefined) {
    repos = repos.filter(entry => entry.name.toLowerCase() === repo.toLowerCase());
    if (repos.length !== 1) throw new Error("Repo is not uniquely registered on this machine");
  }
  const { agent, error, candidates } = await resolveAgentTarget(id, repos, "/", action === "rehire" ? "rehire" : "agent", true);
  if (candidates && error) throw new AmbiguousRemoteRehire(error, candidates);
  if (!agent) throw new Error(error ?? `Agent not found: ${id}`);
  if (isCoordinatorType(agent.meta.agentType)) throw new Error("Remote coordinators are read-only");
  const peer = await readPeerName();
  if (peer === null) throw new Error("Machine is no longer paired");
  // --force is accepted by the local commands. None of their native operations prompts.
  let result;
  switch (action) {
    case "merge":
      result = request.checkOnly ? await deps.mergeCheckAgent(agent) : await deps.mergeAgent(agent, agent.repoPath, { keep: !!request.keep });
      break;
    case "retire": result = await deps.retireAgent(agent); break;
    case "rehire": result = await deps.rehireAgent(agent.id, { repoPath: agent.repoPath }); break;
    case "resume":
      await deps.detectAgentStates([agent], { reap: true });
      result = await deps.resumeAgent(agent);
      break;
  }
  if (!result.ok) throw new Error(result.stderr || result.stdout || `Remote ${action} failed`);
  if (request.checkOnly) return result.stdout || result.stderr || "(no output)";
  const notice = `${peer} ${lifecyclePast[action]} ${agent.id} in ${agent.repoRegistryName}`;
  log(notice);
  deps.notice(notice);
  return result.stderr;
}
