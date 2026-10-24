/**
 * `ib send` target resolution (@-addressing, SPEC §12.3.1 and §16.1).
 *
 * This lives outside src/index.ts so that the watchdog's send broker
 * (send-broker.ts) can resolve a target for a sandboxed agent without
 * importing the CLI entry point. index.ts re-exports `matchAgentById` and
 * `resolveTarget`, so direct callers see no change.
 */

import type { Agent } from "./agents";
import { repoDisplayName, resolveRepo, repoResolutionError, type RepoEntry } from "./registry";
import { normalizeTeamName, getTeam } from "./teams";

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
  team?: { name: string; members: Agent[] };
}

/**
 * Resolve a send target using @-based addressing, and return the error text
 * instead of printing it (`error` is set when the target cannot be used).
 * `cwd` decides the caller's own repo, for `@coordinator` and for the
 * same-repo-first search of a bare id. Supports:
 *   @system → system coordinator
 *   @coordinator → own repo's coordinator
 *   @<repo-name> → that repo's coordinator
 *   @<repo-name>/<agent-id> → agent in specific repo
 *   @<team-name> → a team, resolved to its current member Agents (§16.4)
 *   <agent-id> (bare) → search same-repo first, then all repos
 *
 * Resolution order for a bare `@<name>` (§16.1): @system → @coordinator/@<repo>
 * → team. The team lookup is a FALL-THROUGH reached only after the repo lookup
 * fails, and only for a bare `@<name>` (no slash) — `@<repo>/<agent>` can never
 * address a team and still hard-errors on an unknown repo.
 */
export async function resolveSendTarget(
  target: string,
  repos: RepoEntry[],
  cwd: string = process.cwd(),
): Promise<ResolvedSendTarget & { error?: string }> {
  const { readAllAgents } = await import("./agents");
  const { checkCoordinatorExists } = await import("./coordinator");

  // @system → system coordinator
  if (target === "@system") {
    return { agent: null, isSystemCoordinator: true };
  }

  // Detect own repo from CWD
  const findOwnRepo = (): RepoEntry | null => {
    const exactMatch = repos.find((r) => r.path === cwd);
    if (exactMatch) return exactMatch;
    const prefixMatch = repos.find((r) => cwd.startsWith(r.path + "/"));
    if (prefixMatch) return prefixMatch;

    // Check if CWD is inside an agent worktree: /.ittybitty/agents/([^/]+)/repo/
    const match = cwd.match(/\/.ittybitty\/agents\/[^/]+\/repo$/);
    if (match) {
      // Extract the root repo path by going up from /.ittybitty/agents/
      const repoRoot = cwd.substring(0, cwd.lastIndexOf("/.ittybitty"));
      return repos.find((r) => r.path === repoRoot) || null;
    }

    return null;
  };

  const ownRepo = findOwnRepo();

  // @coordinator → own repo's coordinator
  if (target === "@coordinator") {
    if (!ownRepo) {
      return { agent: null, isSystemCoordinator: false, error: "Error: @coordinator requires running from within a repo" };
    }
    const coordResult = await checkCoordinatorExists(ownRepo.path);
    if (coordResult.exists && coordResult.isCoordinator) {
      const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
      const coordinator = agents.find((a) => a.id === coordResult.agentId);
      return { agent: coordinator || null, isSystemCoordinator: false };
    }
    return { agent: null, isSystemCoordinator: false, error: `Error: no coordinator found for repo ${repoDisplayName(ownRepo)}` };
  }

  // @<repo-name> → that repo's coordinator
  // @<repo-name>/<agent-id> → agent in specific repo
  if (target.startsWith("@")) {
    const afterAt = target.substring(1);
    const slashIdx = afterAt.indexOf("/");
    const repoName = slashIdx >= 0 ? afterAt.substring(0, slashIdx) : afterAt;
    const agentId = slashIdx >= 0 ? afterAt.substring(slashIdx + 1) : null;

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
      if (!agentId) {
        const teamName = normalizeTeamName(repoName);
        const team = await getTeam(teamName);
        if (team) {
          // Resolve each member id to a live Agent. Members that no longer
          // exist are simply skipped here — eager/lazy pruning happens at SEND
          // time (teamSend calls pruneDeadMembers), not during resolution.
          const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
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
      const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
      const repoAgents = agents.filter((a) => a.repoPath === repo.path);
      const match = matchAgentById(agentId, repoAgents);
      if (!match) {
        return { agent: null, isSystemCoordinator: false, error: `Agent not found: ${agentId} in repo ${repoName}` };
      }
      return { agent: match, isSystemCoordinator: false };
    }

    // @<repo> → that repo's coordinator
    const coordResult = await checkCoordinatorExists(repo.path);
    if (coordResult.exists && coordResult.isCoordinator) {
      const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
      const coordinator = agents.find((a) => a.id === coordResult.agentId);
      return { agent: coordinator || null, isSystemCoordinator: false };
    }
    return { agent: null, isSystemCoordinator: false, error: `Error: no coordinator found for repo ${repoName}` };
  }

  // <agent-id> (bare) → search same-repo first, then all repos
  const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);

  // Try same-repo agents first (if we have an ownRepo)
  if (ownRepo) {
    const sameRepoAgents = agents.filter((a) => a.repoPath === ownRepo.path);
    const sameRepoMatch = matchAgentById(target, sameRepoAgents);
    if (sameRepoMatch) {
      return { agent: sameRepoMatch, isSystemCoordinator: false };
    }
    // No match in same repo, continue to global
  }

  // Fall back to global search
  const globalMatch = matchAgentById(target, agents);
  if (!globalMatch) {
    return { agent: null, isSystemCoordinator: false, error: `Agent not found: ${target}` };
  }

  return { agent: globalMatch, isSystemCoordinator: false };
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
  const { error, ...resolved } = await resolveSendTarget(target, repos, cwd);
  if (error) console.error(error);
  return resolved;
}
