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

/** What a lifecycle command reports to the machine that asked for it (SPEC §20.4). */
export interface RemoteLifecycleOutcome {
  output: string;
  /**
   * A merge whose push after merging (`merge.pushAfterMerge`, SPEC.md §3.4)
   * failed on the machine that ran it: one `<remote>: <git error>` line per
   * remote. The merge itself succeeded.
   */
  pushFailure?: string;
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

export async function acceptRemoteLifecycle(request: RemoteLifecycleRequest, readPeerName: () => Promise<string | null>, deps: RemoteLifecycleDeps, log: (line: string) => void): Promise<RemoteLifecycleOutcome> {
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
  if (request.checkOnly) return { output: result.stdout || result.stderr || "(no output)" };
  // This machine's own push after the merge, read from its own config; the
  // requester never says whether to push.
  const pushFailure = result.pushFailure;
  const done = request.keep && result.stdout.startsWith("Nothing to merge:")
    ? `${peer} checked ${agent.id} in ${agent.repoRegistryName}: ${result.stdout}`
    : `${peer} ${lifecyclePast[action]} ${agent.id} in ${agent.repoRegistryName}`;
  const notice = pushFailure ? `${done} · push failed: ${pushFailure}` : done;
  log(notice);
  deps.notice(notice);
  if (!pushFailure) return { output: request.keep ? result.stdout : result.stderr };
  // --keep's stdout already ends with the push's status lines and warning. A
  // closing merge returns only its teardown warnings, so the failure joins
  // them: a requester that does not read pushFailure (the CLI, an older
  // install) still shows it.
  const output = request.keep ? result.stdout : [result.stderr, `push failed: ${pushFailure}`].filter(Boolean).join("\n");
  return { output, pushFailure };
}
