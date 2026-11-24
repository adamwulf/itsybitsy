import { realpathSync } from "node:fs";
import { canonicalRepoPath, sameRepoPath } from "./repo-identity";
import { shellQuote } from "./validation";
import { basename, resolve } from "node:path";
import * as runtimeNames from "./runtime-names";
import { readMachineName } from "./machine-name";
import { readConnectedPeers } from "./peers/remote-agents";
import type { SendTarget } from "./peers/send-frame";
import { hasLivePeerWatcher } from "./peers/endpoint-lock";
import type { Agent, AgentReadError } from "./agents";
import { repoDisplayName, resolveRepo, repoResolutionError, type RepoEntry } from "./registry";
import { normalizeTeamName, getTeam } from "./teams";

/** How many unreadable directories a not-found error names before "+N more". */
const MAX_NAMED_UNREADABLE_DIRS = 3;

/** List failures on a repository's storage directories, excluding individual records. */
function unreadableRepoDirs(errors: AgentReadError[], searched: RepoEntry[]): string[] {
  const dirs = new Set(searched.flatMap((r) => [runtimeNames.agentsDir(r.path), runtimeNames.archiveDir(r.path)]));
  return [...new Set(errors.map((e) => e.agentDir))].filter((dir) => dirs.has(dir));
}

function unreadableAgentsDirsNote(unreadable: string[]): string {
  if (unreadable.length === 0) return "";
  const named = unreadable.slice(0, MAX_NAMED_UNREADABLE_DIRS).join(", ");
  const more = unreadable.length > MAX_NAMED_UNREADABLE_DIRS ? ` +${unreadable.length - MAX_NAMED_UNREADABLE_DIRS} more` : "";
  return ` (could not read ${named}${more}; a sandbox may block it)`;
}

/**
 * Match an agent by ID (or nickname) from a pre-loaded list. Exact match only —
 * CLI inputs must use a full agent id or a full nickname. Prefix matching is
 * intentionally NOT supported (TUI fuzzy filters are unaffected).
 *
 * Precedence:
 *   1. Exact id wins over everything (the canonical, immutable identity).
 *   2. Exact nickname is the input alias — matched EXACTLY only.
 */
export function matchAgentById(id: string, agents: Agent[]): Agent | null {
  const exactId = agents.find((a) => a.id === id);
  if (exactId) return exactId;
  const exactNick = agents.find((a) => a.meta.nickname === id);
  if (exactNick) return exactNick;
  return null;
}

/** Where a send goes: one agent, the system coordinator, or a team. */
export interface ResolvedSendTarget {
  agent: Agent | null;
  isSystemCoordinator: boolean;
  remote?: { peer: string; target: SendTarget };
  team?: { name: string; members: Agent[] };
}

export function findOwnRepo(cwd: string, repos: RepoEntry[]): RepoEntry | undefined {
  let path = resolve(cwd);
  try { path = realpathSync.native(path); } catch { /* Work from the accessible prefix. */ }
  const worktree = runtimeNames.matchWorktreePath(path);
  if (worktree) {
    const root = path.slice(0, worktree.index);
    return repos.find((r) => sameRepoPath(r.path, root, worktree[1])) ?? { path: root, name: basename(root) };
  }
  return repos.map((repo) => ({ repo, root: canonicalRepoPath(repo.path) }))
    .filter(({ repo, root }) => path === root || path.startsWith(root + "/") ||
      path === repo.path || path.startsWith(repo.path + "/"))
    .sort((a, b) => b.root.length - a.root.length)[0]?.repo;
}

type TargetResult = ResolvedSendTarget & {
  error?: string;
  incompleteVisibility?: { unreadableDirs: string[] };
  candidates?: { repo: string; id: string }[];
};

function failure(error: string, unreadableDirs: string[] = []): TargetResult {
  const result: TargetResult = { agent: null, isSystemCoordinator: false, error };
  if (unreadableDirs.length) result.incompleteVisibility = { unreadableDirs };
  return result;
}

const local = (agent: Agent): TargetResult => ({ agent, isSystemCoordinator: false });

async function readAddressMachineName(): Promise<string | TargetResult> {
  try {
    return await readMachineName();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export function suggestedAddress(address: string): string {
  return /^[a-zA-Z0-9_@./-]+$/.test(address) ? address : shellQuote(address);
}

/** Resolve an address in the calling CLI or hook's cwd. Rehire can also address retired agents. */
export async function resolveAgentTarget(
  target: string,
  repos: RepoEntry[],
  cwd: string = process.cwd(),
  purpose: "send" | "agent" | "rehire" | "lifecycle" = "agent",
  inboundPeer = false,
  requirePeerVisibility = false,
): Promise<TargetResult> {
  const { readAgentsOfRepos } = await import("./agents");
  const { checkCoordinatorExists } = await import("./coordinator");
  async function readAgents(scope: RepoEntry[] = repos) {
    const { agents, errors } = await readAgentsOfRepos(scope.map((r) => ({
      path: r.path, name: repoDisplayName(r), registryName: r.name,
    })), purpose === "rehire");
    // The ownership gate and the action must refer to the same directory.
    return { agents: agents.filter((a) => a.archived || !a.storageDir ||
      basename(a.storageDir) === a.id), errors };
  }

  function matchesInRepo(name: string, agents: Agent[]): Agent[] {
    if (inboundPeer && purpose !== "rehire") return agents.filter(agent => agent.id === name);
    const first = matchAgentById(name, agents);
    if (!first) return [];
    if (purpose !== "rehire" || first.id === name) return [first];
    const byId = new Map<string, Agent>();
    for (const agent of agents) {
      if (agent.meta.nickname === name && !byId.has(agent.id)) byId.set(agent.id, agent);
    }
    return [...byId.values()];
  }

  function incompleteNickname(name: string, matches: Agent[], unreadable: string[]): TargetResult | undefined {
    if (purpose !== "rehire" || !matches.some((a) =>
      a.id !== name && unreadable.includes(runtimeNames.archiveDir(a.repoPath)))) return undefined;
    return failure(`Cannot resolve '${target}'${unreadableAgentsDirsNote(unreadable)}`, unreadable);
  }

  function resolveInRepo(name: string, matches: Agent[], registered = true): TargetResult | undefined {
    if (!matches.length) return undefined;
    const first = matches[0]!;
    if (matches.length === 1) return local(first);
    const forms = matches.map(({ id }) => suggestedAddress(registered ? `@${first.repoRegistryName}/${id}` : id)).sort();
    return failure(`'${name}' matches several retired agent ids; use ${forms.join(" or ")}`);
  }

  if (target === "@system") {
    return purpose === "send" ? { agent: null, isSystemCoordinator: true } : failure("Agent not found: @system");
  }

  // @coordinator → own repo's coordinator
  if (target === "@coordinator") {
    const ownRepo = findOwnRepo(cwd, repos);
    if (!ownRepo) {
      return { agent: null, isSystemCoordinator: false, error: "Error: @coordinator requires running from within a repo" };
    }
    const coordResult = await checkCoordinatorExists(ownRepo.path);
    if (coordResult.exists && coordResult.isCoordinator) {
      const { agents } = await readAgents([ownRepo]);
      const coordinator = agents.find((a) => a.id === coordResult.agentId);
      return { agent: coordinator || null, isSystemCoordinator: false };
    }
    return { agent: null, isSystemCoordinator: false, error: `Error: no coordinator found for repo ${repoDisplayName(ownRepo)}` };
  }

  // @<repo-name> → that repo's coordinator
  // @<repo-name>/<agent-id> → agent in specific repo
  if (target.startsWith("@")) {
    const segments = target.slice(1).split("/");
    if (segments.length > 2 || segments.some((part) => !part)) return failure(`Agent not found: ${target}`);
    const repoName = segments[0]!;
    const agentId = segments[1];

    // Shared resolver: registry id / basename (case-insensitive) or path.
    const repoResolution = resolveRepo(repoName, repos, cwd);
    if (!repoResolution.ok && repoResolution.reason === "ambiguous") {
      // An ambiguous `@<name>` must NOT fall through to a team — that would
      // silently pick a different namespace. Report the collision instead.
      return { agent: null, isSystemCoordinator: false, error: `Error: ${repoResolutionError(repoName, repoResolution)}` };
    }
    const repo = repoResolution.ok ? repoResolution.repo : null;
    if (!repo) {
      // No repo by this name. For a bare `@<name>` (no slash) this is where the
      // TEAM lookup falls through (§16.1/§16.4): try a team before erroring. A
      // slashed `@<repo>/<agent>` can never address a team, so it still errors.
      if (!agentId && purpose === "send") {
        const teamName = normalizeTeamName(repoName);
        const team = await getTeam(teamName);
        if (team) {
          // Resolve each member id to a live Agent. Members that no longer
          // exist are simply skipped here — eager/lazy pruning happens at SEND
          // time (teamSend calls pruneDeadMembers), not during resolution.
          const { agents } = await readAgents();
          const byId = new Map(agents.map((a) => [a.id, a]));
          const members: Agent[] = [];
          for (const id of team.members) {
            const agent = byId.get(id);
            if (agent) members.push(agent);
          }
          return { agent: null, isSystemCoordinator: false, team: { name: teamName, members } };
        }
      }
      return { agent: null, isSystemCoordinator: false, error: `Error: no repo or team named: ${repoName}` };
    }

    if (agentId) {
      // @<repo>/<agent-id> → agent in specific repo
      const { agents, errors } = await readAgents([repo]);
      const matches = matchesInRepo(agentId, agents);
      const unreadable = unreadableRepoDirs(errors, [repo]);
      const match = incompleteNickname(agentId, matches, unreadable) ?? resolveInRepo(agentId, matches);
      if (!match) {
        return failure(`Agent not found: ${agentId} in repo ${repoName}${unreadableAgentsDirsNote(unreadable)}`, unreadable);
      }
      return match;
    }

    // @<repo> → that repo's coordinator
    const coordResult = await checkCoordinatorExists(repo.path);
    if (coordResult.exists && coordResult.isCoordinator) {
      const { agents } = await readAgents([repo]);
      const coordinator = agents.find((a) => a.id === coordResult.agentId);
      return { agent: coordinator || null, isSystemCoordinator: false };
    }
    return { agent: null, isSystemCoordinator: false, error: `Error: no coordinator found for repo ${repoName}` };
  }

  const parts = target.split("/");
  if (parts.length > 3 || parts.some((part) => !part)) return failure(`Agent not found: ${target}`);
  const name = parts.at(-1)!;
  const machine = parts.length > 1 ? parts[0]!.toLowerCase() : undefined;
  const repoName = parts.length === 3 ? parts[1]!.toLowerCase() : undefined;

  // A bare name first searches the caller's repo, including its worktrees.
  const ownRepo = machine || (inboundPeer && purpose === "rehire") ? undefined : findOwnRepo(cwd, repos);
  let searched = repos;
  let ownErrors: AgentReadError[] = [];
  if (ownRepo) {
    const { agents, errors } = await readAgents([ownRepo]);
    const matches = matchesInRepo(name, agents);
    const match = incompleteNickname(name, matches, unreadableRepoDirs(errors, [ownRepo])) ??
      resolveInRepo(name, matches, repos.includes(ownRepo));
    if (match) return match;
    ownErrors = errors;
    searched = repos.filter((r) => r !== ownRepo);
  }
  const [localMachine, connected] = await Promise.all([machine ? readAddressMachineName() : "", inboundPeer ? [] : readConnectedPeers(requirePeerVisibility).catch(() => null)]);
  if (typeof localMachine !== "string") return localMachine;
  if (connected === null) return failure("Cannot resolve the target with the peer cache hidden", [runtimeNames.peerDir()]);
  const includesLocal = !machine || localMachine.toLowerCase() === machine;
  const peers = connected.filter((p) => !p.name.startsWith("@") && (!machine || p.name.toLowerCase() === machine));
  if (!includesLocal && !peers.length) {
    if (purpose === "send" && !await hasLivePeerWatcher()) return failure("remote sends need ib watch running on this machine");
    return failure(`Unknown machine: ${parts[0]}`);
  }
  if (!includesLocal && parts.length === 2 && name.startsWith("@") && name.length > 1) {
    if (purpose === "lifecycle") return failure("Select a remote agent");
    if (purpose !== "send") return failure("remote agents are read-only");
    if (peers.length !== 1) return failure(`Ambiguous machine: ${parts[0]}`);
    return { agent: null, isSystemCoordinator: false, remote: {
      peer: peers[0]!.id, target: name === "@system" ? { kind: "system" } : { kind: "repo-coordinator", repo: name.slice(1) },
    } };
  }

  searched = includesLocal ? searched.filter((r) => !repoName || r.name.toLowerCase() === repoName) : [];
  const { agents, errors } = await readAgents(searched);
  const unreadable = unreadableRepoDirs([...ownErrors, ...errors], ownRepo ? [...searched, ownRepo] : searched);
  const note = unreadableAgentsDirsNote(unreadable);
  if (note && !repoName) {
    return failure(`Cannot resolve '${target}'${note}; use machine/repo/agent`, unreadable);
  }
  const matches: { machine: string; repo: string; agent?: Agent; remote?: { peer: string; target: SendTarget } }[] = [];
  for (const repo of searched) {
    for (const agent of matchesInRepo(name, agents.filter((a) => a.repoPath === repo.path))) {
      if (!matches.some((m) => m.agent?.id === agent.id && sameRepoPath(m.agent.repoPath, agent.repoPath))) {
        matches.push({ machine: localMachine, repo: repo.name, agent });
      }
    }
  }
  for (const peer of peers) {
    const matchingRepos = new Set(peer.agents.filter((a) =>
      (!repoName || a.repo.toLowerCase() === repoName) && (a.id === name || a.nickname === name)
    ).map((a) => a.repo));
    for (const repo of matchingRepos) {
      const inRepo = peer.agents.filter(a => a.repo === repo);
      const match = inRepo.find(a => a.id === name) ?? inRepo.find(a => a.nickname === name)!;
      matches.push({ machine: peer.name, repo, remote: { peer: peer.id, target: { kind: "agent", repo, agent: match.id } } });
    }
  }
  const incomplete = incompleteNickname(name, matches.flatMap((m) => m.agent ? [m.agent] : []), unreadable);
  if (incomplete) return incomplete;
  if (matches.length === 0) {
    return failure(`Agent not found: ${target}${note}`, unreadable);
  }
  if (matches.length > 1) {
    if (inboundPeer && purpose === "rehire") {
      // The caller owns the pairing name, so only it can build usable addresses.
      return { ...failure(`'${name}' matches several agents`),
        candidates: matches.map(m => ({ repo: m.repo, id: m.agent!.id })) };
    }
    if (!machine && matches.some((m) => m.agent)) {
      const localName = await readAddressMachineName();
      if (typeof localName === "string") {
        for (const m of matches) if (m.agent) m.machine = localName;
      }
    }
    matches.sort((a, b) => a.machine.localeCompare(b.machine) || a.repo.localeCompare(b.repo));
    const machines = [...new Set(matches.map((m) => m.machine))];
    const first = matches[0]!;
    if (first.agent && matches.every((m) => m.agent && sameRepoPath(m.agent.repoPath, first.agent!.repoPath))) {
      return resolveInRepo(name, matches.map((m) => m.agent!))!;
    }
    const forms = matches.map((m) => {
      if (m.agent && !m.machine) return `@${m.repo}/${purpose === "rehire" ? m.agent.id : name}`;
      if (purpose === "rehire" && m.agent) return `${m.machine}/${m.repo}/${m.agent.id}`;
      return matches.some((other) => other !== m && other.machine === m.machine)
        ? `${m.machine}/${m.repo}/${name}` : `${m.machine}/${name}`;
    });
    const description = machines.includes("") ? "is ambiguous" : `exists on ${machines.join(" and ")}`;
    return failure(`'${name}' ${description}; use ${forms.map(suggestedAddress).join(" or ")}`);
  }
  const agent = matches[0]!.agent;
  if (agent) return local(agent);
  if (purpose === "send" || (machine && purpose === "lifecycle")) return { agent: null, isSystemCoordinator: false, remote: matches[0]!.remote };
  return failure("remote agents are read-only");
}

export function resolveSendTarget(target: string, repos: RepoEntry[], cwd = process.cwd(), requirePeerVisibility = false): Promise<TargetResult> {
  return resolveAgentTarget(target, repos, cwd, "send", false, requirePeerVisibility);
}

/**
 * Resolve a send target for the CLI: `resolveSendTarget`, with its error
 * printed to stderr. Returns { agent, isSystemCoordinator, team? }; `agent` is
 * null (and not a system/team target) when the target was not found or invalid.
 */
export async function resolveTarget(
  target: string,
  repos: RepoEntry[],
  cwd: string = process.cwd(),
): Promise<ResolvedSendTarget> {
  const { error, incompleteVisibility: _, ...resolved } = await resolveSendTarget(target, repos, cwd);
  if (error) console.error(error);
  return resolved;
}
