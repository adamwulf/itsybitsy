#!/usr/bin/env bun
/**
 * ib — Cross-repo agent management dashboard
 * CLI entrypoint
 */

import { join } from "path";
import { addRepo, removeRepo, listRepos, repoDisplayName, type RepoEntry } from "./registry";
import { resolveAgentIcon } from "./agents";
import type { Agent, FlatEntry } from "./agents";
import { isValidAgentId, tmuxSessionTarget } from "./validation";
import { SYSTEM_AGENT_ID } from "./hooks/shared";
import { normalizeTeamName, getTeam } from "./teams";

const args = process.argv.slice(2);
const command = args[0];

/**
 * Collect non-archived agents for display, optionally filtered by manager.
 * Recursively walks children, pushing { agent, depth } into the result array.
 */
export function collectAgents(
  agent: Agent,
  depth: number,
  managerFilter: string | null,
  result: { agent: Agent; depth: number }[],
): void {
  if (agent.archived) return;
  if (managerFilter) {
    if (agent.meta.manager !== managerFilter && agent.id !== managerFilter) return;
  }
  result.push({ agent, depth });
  for (const child of agent.children) {
    collectAgents(child, depth + 1, managerFilter, result);
  }
}

/**
 * Recursively search for a manager by ID in the agent tree.
 * When found, collects that manager's children using collectAgents.
 */
export function findManagerInTree(
  agent: Agent,
  managerId: string,
  result: { agent: Agent; depth: number }[],
): void {
  if (agent.id === managerId) {
    for (const child of agent.children) {
      collectAgents(child, 1, null, result);
    }
  } else {
    for (const child of agent.children) {
      findManagerInTree(child, managerId, result);
    }
  }
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

/** Find an agent by exact ID (or nickname) across all registered repos. */
export async function findAgentById(id: string, repos: RepoEntry[]): Promise<Agent | null> {
  const { readAllAgents } = await import("./agents");
  const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
  return matchAgentById(id, agents);
}

/** Print an IbCommandResult and exit. */
export async function printAndExit(result: { ok: boolean; exitCode: number; stdout: string; stderr: string }): Promise<never> {
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}

/**
 * Read message/prompt body from stdin when it is piped (not a TTY), trimming
 * surrounding whitespace to match `send`'s historical semantics. Returns an
 * empty string when stdin is a TTY, so an interactive invocation with no
 * positional arg never blocks waiting for input.
 *
 * This is the shared stdin-reading core behind the heredoc fallback for
 * `ib send`, `ib new-agent`, and `ib ask`. It mirrors the established pattern
 * (`for await (const chunk of process.stdin)`) used by `send` and `parse-state`
 * — deliberately NOT `Bun.stdin.stream()` — so all three CLI paths stay
 * consistent.
 */
export async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  }
  return chunks.join("").trim();
}

/**
 * Injectable check for whether the system-coordinator tmux session is running.
 * Default implementation calls `tmux has-session -t ib-coordinator`. Tests can
 * override via `setSystemCoordinatorHasSessionFn()` to avoid invoking tmux.
 */
let systemCoordinatorHasSessionFn: (sessionName: string) => Promise<boolean> = async (
  sessionName: string,
) => {
  const exit = await Bun.spawn(["tmux", "has-session", "-t", tmuxSessionTarget(sessionName)], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  return exit === 0;
};

export function setSystemCoordinatorHasSessionFn(
  fn: (sessionName: string) => Promise<boolean>,
): void {
  systemCoordinatorHasSessionFn = fn;
}

export function resetSystemCoordinatorHasSessionFn(): void {
  systemCoordinatorHasSessionFn = async (sessionName: string) => {
    const exit = await Bun.spawn(["tmux", "has-session", "-t", tmuxSessionTarget(sessionName)], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return exit === 0;
  };
}

/**
 * Build the synthetic Agent used to deliver @system messages through the
 * standard sendMessage path. The recipient log/state writes inside sendMessage
 * target an agent dir that does not exist (the system coordinator has no agent
 * dir by design) — logAgent and writeAgentState both swallow missing-dir
 * errors. We pick the sender's repo as the synthetic repoPath when detectable
 * so sendMessage's sender-log write lands in the correct repo.
 */
export function buildSystemCoordinatorAgent(
  tmuxSessionName: string,
  cwd: string = process.cwd(),
): Agent {
  const m = cwd.match(/^(.+?)\/\.ittybitty\/agents\/[^/]+\/repo(?:\/|$)/);
  const repoPath = m ? m[1]! : "/tmp";
  return {
    id: "ib-coordinator",
    repoPath,
    repoName: "system",
    meta: {
      id: "ib-coordinator",
      session_id: "",
      tmux_session: tmuxSessionName,
      prompt: "",
      manager: null,
      created: "",
      created_epoch: 0,
      worktree: false,
      worker: false,
      yolo: false,
      model: "",
      claude_pid: "",
    },
    state: "running",
    age: "",
    archived: false,
    children: [],
  };
}

/**
 * Deliver a message to the system coordinator's tmux session via the standard
 * sendMessage path. Returns an IbCommandResult — the caller is responsible for
 * printing output and exiting with the appropriate code.
 *
 * If the coordinator session is not running, returns ok=false with a clear
 * error message and never invokes sendMessage.
 */
export async function sendToSystemCoordinator(
  message: string,
  opts?: { fromAgent?: string; cwd?: string; raw?: boolean },
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  const { IB_COORDINATOR_SESSION } = await import("./coordinator");
  const running = await systemCoordinatorHasSessionFn(IB_COORDINATOR_SESSION);
  if (!running) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr:
        "System coordinator is not running. Start it from the dashboard (`ib watch`) or by selecting it there.",
    };
  }

  const cwd = opts?.cwd ?? process.cwd();
  const syntheticAgent = buildSystemCoordinatorAgent(IB_COORDINATOR_SESSION, cwd);
  const { sendMessage } = await import("./ib-commands");
  const { getCoordinatorHome } = await import("./coordinator");
  // The system coordinator has no agent dir and no per-agent watchdog, so its
  // outbox queue + delivery lock live in the coordinator home. Routing every
  // coordinator send (CLI `ib send @system`, watchdog `@system` notifications,
  // and the dashboard coordinator send dialog) through this one queue + lock
  // serializes all writes to the `ib-coordinator` tmux session so they can't
  // interleave. There is no central dispatcher — the lock is keyed to the
  // single coordinator session, exactly mirroring the per-agent design.
  const sendOpts: { fromAgent?: string; cwd?: string; raw?: boolean; outboxDir?: string } = {
    cwd,
    outboxDir: getCoordinatorHome(),
  };
  if (opts?.fromAgent) sendOpts.fromAgent = opts.fromAgent;
  if (opts?.raw) sendOpts.raw = true;
  const result = await sendMessage(syntheticAgent, message, sendOpts);

  if (result.ok) {
    return { ok: true, exitCode: 0, stdout: "Sent to system coordinator", stderr: "" };
  }
  return result;
}

/**
 * Resolve the target directory for `ib merge <agent-id>` based on the caller's cwd.
 *
 * Three branches:
 *   1. cwd is the system coordinator home (~/.itsybitsy/ or under it) — returns
 *      `agent.repoPath` so the merge lands in the agent's owning repo. This lets
 *      the system coordinator merge agents across all registered repos.
 *   2. cwd is inside `agent.repoPath` — returns cwd unchanged. The user is in
 *      their own repo (possibly on a feature branch they want to merge into).
 *   3. cwd is anything else — returns an error. Refuses to silently substitute
 *      because a sibling-repo or unrelated cwd almost certainly means the user
 *      meant to merge into the agent's repo from somewhere else, but proceeding
 *      with `agent.repoPath` would mask the mistake.
 *
 * Paths are compared after `realpathSync` so symlinked $HOME (common on macOS)
 * doesn't cause a silent miss. Falls back to `resolve()` when realpath fails
 * (path may not exist on disk for some reason — defensive).
 */
export function resolveMergeTargetDir(
  agent: Agent,
  cwd: string,
): { ok: true; targetDir: string } | { ok: false; error: string } {
  const { realpathSync } = require("fs") as typeof import("fs");
  const { resolve } = require("path") as typeof import("path");
  const { getCoordinatorHome } = require("./coordinator") as typeof import("./coordinator");

  const canonical = (p: string): string => {
    try { return realpathSync(p); } catch { return resolve(p); }
  };

  const resolvedCwd = canonical(cwd);
  const resolvedRepo = canonical(agent.repoPath);
  const resolvedHome = canonical(getCoordinatorHome());

  if (resolvedCwd === resolvedHome || resolvedCwd.startsWith(resolvedHome + "/")) {
    return { ok: true, targetDir: agent.repoPath };
  }

  if (resolvedCwd === resolvedRepo || resolvedCwd.startsWith(resolvedRepo + "/")) {
    return { ok: true, targetDir: cwd };
  }

  return {
    ok: false,
    error: `Refusing to merge: cwd is not inside agent's repo (${agent.repoPath}). cd into the repo, or use the per-repo coordinator.`,
  };
}

/** Require an agent ID argument, find it, or exit with error. */
export async function requireAgent(idArg: string | undefined, repos: RepoEntry[]): Promise<Agent> {
  if (!idArg) {
    console.error("Usage: ib <command> <agent-id>");
    process.exit(1);
  }
  const agent = await findAgentById(idArg, repos);
  if (!agent) {
    console.error(`Agent not found: ${idArg}`);
    process.exit(1);
  }
  return agent;
}

/**
 * Resolve a send target using @-based addressing.
 * Returns { agent, isSystemCoordinator, team? } or null if not found/invalid.
 * Supports:
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
export async function resolveTarget(
  target: string,
  repos: RepoEntry[],
  cwd: string = process.cwd(),
): Promise<{ agent: Agent | null; isSystemCoordinator: boolean; team?: { name: string; members: Agent[] } }> {
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
      console.error("Error: @coordinator requires running from within a repo");
      return { agent: null, isSystemCoordinator: false };
    }
    const coordResult = await checkCoordinatorExists(ownRepo.path);
    if (coordResult.exists && coordResult.isCoordinator) {
      const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
      const coordinator = agents.find((a) => a.id === coordResult.agentId);
      return { agent: coordinator || null, isSystemCoordinator: false };
    }
    console.error(`Error: no coordinator found for repo ${repoDisplayName(ownRepo)}`);
    return { agent: null, isSystemCoordinator: false };
  }

  // @<repo-name> → that repo's coordinator
  // @<repo-name>/<agent-id> → agent in specific repo
  if (target.startsWith("@")) {
    const afterAt = target.substring(1);
    const slashIdx = afterAt.indexOf("/");
    const repoName = slashIdx >= 0 ? afterAt.substring(0, slashIdx) : afterAt;
    const agentId = slashIdx >= 0 ? afterAt.substring(slashIdx + 1) : null;

    const repo = repos.find((r) => repoDisplayName(r) === repoName);
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
      console.error(`Error: no repo or team named: ${repoName}`);
      return { agent: null, isSystemCoordinator: false };
    }

    if (agentId) {
      // @<repo>/<agent-id> → agent in specific repo
      const { agents } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
      const repoAgents = agents.filter((a) => a.repoPath === repo.path);
      const match = matchAgentById(agentId, repoAgents);
      if (!match) {
        console.error(`Agent not found: ${agentId} in repo ${repoName}`);
        return { agent: null, isSystemCoordinator: false };
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
    console.error(`Error: no coordinator found for repo ${repoName}`);
    return { agent: null, isSystemCoordinator: false };
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
    console.error(`Agent not found: ${target}`);
    return { agent: null, isSystemCoordinator: false };
  }

  return { agent: globalMatch, isSystemCoordinator: false };
}

/**
 * True when `args` (excluding the command itself at index 0) contains a help flag.
 * Used at the top of each command case block to print a per-command usage string
 * and return, before the command's normal argument parsing runs.
 */
export function hasHelpFlag(args: string[]): boolean {
  return args.slice(1).some((a) => a === "--help" || a === "-h");
}

/**
 * Per-command usage strings. Looked up by the command keyword as it appears
 * after `ib` (e.g. "new-agent", "send", "team add"). Each entry is the full
 * text to print when the user passes --help / -h.
 *
 * Sub-grouped commands (team, hooks, config) have both an outer entry (e.g.
 * "team") and per-subcommand entries (e.g. "team add"). The dispatcher in
 * main() picks the most specific available match.
 */
const COMMAND_HELP: Record<string, string> = {
  add:
    "Usage: ib add [path]\n" +
    "  Register a repo. Defaults to the current working directory.",
  remove:
    "Usage: ib remove <path|name>\n" +
    "  Unregister a previously added repo by absolute path or display name.",
  list:
    "Usage: ib list [--manager <id>] [--json] [--verbose|-v]\n" +
    "  Aliases: ls\n" +
    "  List repos and their agents.\n" +
    "  --manager <id>  Only show children of the given manager agent\n" +
    "  --json          Emit machine-readable JSON\n" +
    "  --verbose, -v   Print warnings about unreadable agent dirs",
  state:
    "Usage: ib state [--manager <id>] [--json] [--verbose|-v] [--cleanup [--dry-run]]\n" +
    "  List agents with PID/liveness diagnostics and orphan detection.\n" +
    "  --manager <id>  Only show children of the given manager agent\n" +
    "  --json          Emit machine-readable JSON\n" +
    "  --verbose, -v   Print warnings about unreadable agent dirs\n" +
    "  --cleanup       Kill orphan tmux sessions and processes\n" +
    "  --dry-run       Only valid with --cleanup; print what would be killed",
  watch:
    "Usage: ib watch\n" +
    "  Launch the interactive TUI dashboard. Requires tmux.",
  watchdog:
    "Usage: ib watchdog <agent-id>\n" +
    "  Run the per-agent watchdog loop for an agent. Internal — used by the\n" +
    "  agent lifecycle; not normally invoked by users.",
  agents:
    "Usage: ib agents [--verbose|-v]\n" +
    "  Aliases: tree\n" +
    "  List every agent across all registered repos in a tree view with state,\n" +
    "  age, model, and prompt summary.\n" +
    "  --verbose, -v   Print warnings about unreadable agent dirs",
  look:
    "Usage: ib look <agent-id> [--lines N] [--all] [--follow]\n" +
    "  Show an agent's live tmux pane contents.\n" +
    "  --lines N       Capture the last N lines (default 100)\n" +
    "  --all           Capture up to 10000 lines\n" +
    "  --follow        Attach to the agent's tmux session (Ctrl+b d to detach)",
  status:
    "Usage: ib status [<agent-id>]\n" +
    "  Show an agent's git log and working-tree status. With no id, infers the\n" +
    "  agent from the current working directory.",
  diff:
    "Usage: ib diff [<agent-id>] [--stat]\n" +
    "  Show an agent's git diff against its parent branch. With no id, infers\n" +
    "  the agent from the current working directory; if there is no agent\n" +
    "  context, diffs the current branch against its merge-base.\n" +
    "  --stat          Show a diffstat summary instead of the full diff",
  log:
    'Usage: ib log [--id <agent-id>] [--quiet|-q] "message"\n' +
    "  Append a line to an agent's log file.\n" +
    "  --id <id>       Target agent id (defaults to cwd-detected agent)\n" +
    "  --quiet, -q     Do not also echo the message to stdout",
  "parse-state":
    "Usage: ib parse-state [file] [-v|--verbose]\n" +
    "  Parse agent state from a tmux capture (file path or piped stdin).\n" +
    "  -v, --verbose   Also print the matched reason",
  info:
    "Usage: ib info <agent-id>\n" +
    "  Show an agent's metadata (id, repo, state, model, type, worktree, etc.).",
  questions:
    "Usage: ib questions [--all|-a]\n" +
    "  Alias: q\n" +
    "  Show pending agent questions across all repos.\n" +
    "  --all, -a       Include already-acknowledged questions",
  send:
    "Usage: ib send [--from <id>] <target> [-f|--file <path>] [message...]\n" +
    "  Send a message to an agent, the system coordinator, a repo coordinator,\n" +
    "  or a team. If no inline message and no -f file is given, the message body\n" +
    "  is read from stdin.\n" +
    "  --from <id>     Mark the sender for the recipient's notification\n" +
    "  -f, --file <p>  Read the message body from a file (wins over stdin)\n" +
    "\n" +
    "Targets:\n" +
    "  @system                System coordinator\n" +
    "  @coordinator           Own repo's coordinator (cwd-detected)\n" +
    "  @<repo>                A repo's coordinator\n" +
    "  @<repo>/<agent-id>     A specific agent in a specific repo\n" +
    "  @<team>                Every member of a team\n" +
    "  <agent-id>             A specific agent by id or nickname",
  nickname:
    "Usage: ib nickname <agent-id> [<new-nickname> | --clear]\n" +
    "  Set, clear, or show an agent's nickname. With no third arg, prints the\n" +
    "  current nickname.\n" +
    "  --clear         Remove the existing nickname",
  kill:
    "Usage: ib kill <agent-id> [--force]\n" +
    "  Stop an agent without archiving its worktree.\n" +
    "  --force         Skip confirmation prompts",
  nuke:
    "Usage: ib nuke <agent-id>\n" +
    "  Kill an agent AND archive its directory. Removes the tmux session and\n" +
    "  git worktree.",
  "merge-check":
    "Usage: ib merge-check <agent-id>\n" +
    "  Check whether an agent's branch is ready to merge cleanly into its\n" +
    "  parent. Does not perform the merge.",
  merge:
    "Usage: ib merge <agent-id> [--force]\n" +
    "  Merge an agent's branch into its parent and close the agent.\n" +
    "  --force         Skip confirmation prompts",
  resume:
    "Usage: ib resume <agent-id> [--force]\n" +
    "  Resume a stopped agent in its existing worktree.\n" +
    "  --force         Skip confirmation prompts",
  respawn:
    "Usage: ib respawn [<agent-id>]\n" +
    "  Alias: restart\n" +
    "  Restart an agent's Claude session in-place. With no id, infers the agent\n" +
    "  from the current working directory (backs the /respawn slash command).\n" +
    "  Pass @system to restart the system coordinator.",
  "new-agent":
    "Usage: ib new-agent [--type <type>] [--model <model>] [--manager <id>] [--name <name>]\n" +
    "                    [--repo <name|path>] [--spawned-by <id> [--spawned-by-repo <path>]]\n" +
    '                    [--allow <tools>] [--deny <tools>] [--no-worktree] [--yolo]\n' +
    '                    [-f|--file|--prompt-file <path>] ["prompt..."]\n' +
    "  Alias: new\n" +
    "  Spawn a new agent. The prompt may be supplied positionally, via -f/--file,\n" +
    "  or piped on stdin.\n" +
    "  --type <type>          Agent type (see `ib list-types`)\n" +
    "  --model <m>            Model selector, e.g. claude:opus or codex:gpt-5-codex\n" +
    "  --manager <id>         Parent manager agent id\n" +
    "  --name <n>             Optional human-readable agent name\n" +
    "  --repo <name|path>     Target repo (defaults to cwd-matched repo)\n" +
    "  --allow <tools>        Comma-separated extra allowed tools\n" +
    "  --deny <tools>         Comma-separated extra denied tools\n" +
    "  --no-worktree          Do not create a git worktree\n" +
    "  --yolo                 Skip safety prompts (rarely needed)\n" +
    "  -f, --file <path>      Read prompt body from a file",
  acknowledge:
    "Usage: ib acknowledge <question-id>\n" +
    "  Alias: ack\n" +
    "  Acknowledge a pending agent question by id.",
  ask:
    'Usage: ib ask [--id <agent-id>] "question"\n' +
    "  Ask the user a question from an agent context. The question may be passed\n" +
    "  positionally or piped on stdin.\n" +
    "  --id <id>       Agent id (defaults to cwd-detected agent)",
  "init-types":
    "Usage: ib init-types\n" +
    "  Alias: init-agent-types\n" +
    "  Populate ~/.itsybitsy/agent-types/ with the built-in agent type files.\n" +
    "  Existing files are not overwritten.",
  "list-types":
    "Usage: ib list-types\n" +
    "  Alias: list-agent-types\n" +
    "  List available agent types with whether they are spawnable and whether\n" +
    "  they may spawn children.",
  "show-type":
    "Usage: ib show-type <name> [--json]\n" +
    "  Alias: show-agent-type\n" +
    "  Print the full definition for a single agent type: description, flags,\n" +
    "  allow/deny tool lists, and the prompt body. The `inherits:` chain is\n" +
    "  resolved before display. Layer files (_all.md, _non_coordinator.md) are\n" +
    "  applied at spawn time and are NOT shown here — inspect them directly\n" +
    "  with `ib show-type _all` / `ib show-type _non_coordinator`.\n" +
    "  --json          Emit machine-readable JSON",
  "list-models":
    "Usage: ib list-models [--json]\n" +
    "  Alias: models\n" +
    "  List known <cli>:<model> selectors grouped by CLI.\n" +
    "  --json          Emit machine-readable JSON",
  config:
    "Usage: ib config <subcommand> [args...]\n" +
    "  list, ls              List all config keys with values\n" +
    "  get <key>             Get a config value\n" +
    "  set <key> <value>     Set a scalar config value\n" +
    "  add <key> <value>     Add a value to an array config key\n" +
    "  remove <key> <value>  Remove a value from an array config key\n" +
    "  unset <key>           Remove a key, reverting to default",
  "config list":
    "Usage: ib config list\n" +
    "  Alias: ib config ls\n" +
    "  Print every known config key with its current value and source.",
  "config get":
    "Usage: ib config get <key>\n" +
    "  Print the current value of a config key.",
  "config set":
    "Usage: ib config set <key> <value>\n" +
    "  Set a scalar config value. Use `ib config add` for array-typed keys.",
  "config add":
    "Usage: ib config add <key> <value>\n" +
    "  Append a value to an array-typed config key.",
  "config remove":
    "Usage: ib config remove <key> <value>\n" +
    "  Remove a value from an array-typed config key.",
  "config unset":
    "Usage: ib config unset <key>\n" +
    "  Remove a key from the user config file, reverting to its built-in default.",
  hooks:
    "Usage: ib hooks <subcommand>\n" +
    "  install                Install safety hooks (~/.claude/settings.json)\n" +
    "  uninstall              Uninstall safety hooks\n" +
    "  status                 Show safety-hook installation status\n" +
    "  intercept-install      Install the intercept hook\n" +
    "  intercept-uninstall    Uninstall the intercept hook\n" +
    "  intercept-status       Show intercept-hook installation status\n" +
    "\n" +
    "Internal hook entrypoints (invoked by Claude Code, not directly by users):\n" +
    "  intercept-task, session-start, main-path, inject-status, inject-timestamp,\n" +
    "  codex-pre-tool-use, codex-session-start, codex-stop",
  "hooks install":
    "Usage: ib hooks install\n" +
    "  Install the safety hooks block into ~/.claude/settings.json.",
  "hooks uninstall":
    "Usage: ib hooks uninstall\n" +
    "  Remove the safety hooks block from ~/.claude/settings.json.",
  "hooks status":
    "Usage: ib hooks status\n" +
    "  Show whether the safety hooks are installed.",
  "hooks intercept-install":
    "Usage: ib hooks intercept-install\n" +
    "  Install the intercept (PreToolUse on Task) hook into ~/.claude/settings.json.",
  "hooks intercept-uninstall":
    "Usage: ib hooks intercept-uninstall\n" +
    "  Remove the intercept hook from ~/.claude/settings.json.",
  "hooks intercept-status":
    "Usage: ib hooks intercept-status\n" +
    "  Show whether the intercept hook is installed.",
  "hooks intercept-task":
    "Usage: ib hooks intercept-task\n" +
    "  Internal: PreToolUse hook entrypoint for Task tool calls. Reads JSON from\n" +
    "  stdin, writes a permission decision to stdout.",
  "hooks session-start":
    "Usage: ib hooks session-start [<agent-id>]\n" +
    "  Internal: SessionStart hook entrypoint. Injects role-specific context\n" +
    "  into the new Claude session.",
  "hooks main-path":
    "Usage: ib hooks main-path\n" +
    "  Internal: PreToolUse hook for the primary Claude session — blocks the\n" +
    "  user's main Claude from operating inside agent worktrees.",
  "hooks inject-status":
    "Usage: ib hooks inject-status [--full|--if-changed|--brief] [--visible]\n" +
    "  Internal: UserPromptSubmit hook that injects a brief agents-status\n" +
    "  summary into the primary Claude's context.",
  "hooks inject-timestamp":
    "Usage: ib hooks inject-timestamp\n" +
    "  Internal: hook entrypoint that injects a current-timestamp marker.",
  "hooks codex-pre-tool-use":
    "Usage: ib hooks codex-pre-tool-use <agent-id> [--dry-run]\n" +
    "  Internal: codex PreToolUse hook entrypoint. --dry-run is used by the\n" +
    "  spawn-time precheck.",
  "hooks codex-session-start":
    "Usage: ib hooks codex-session-start <agent-id> [--dry-run]\n" +
    "  Internal: codex SessionStart hook entrypoint. --dry-run is used by the\n" +
    "  spawn-time precheck.",
  "hooks codex-stop":
    "Usage: ib hooks codex-stop <agent-id> [--dry-run]\n" +
    "  Internal: codex Stop hook entrypoint. --dry-run is used by the spawn-time\n" +
    "  precheck.",
  team:
    "Usage: ib team <subcommand> [args...]\n" +
    "  create <name>             Create an empty team\n" +
    "  add <name> <agent-id>     Add an agent to a team\n" +
    "  remove <name> <agent-id>  Remove an agent from a team\n" +
    "  list                      List all teams with member counts\n" +
    "  delete <name>             Delete a team",
  "team create":
    "Usage: ib team create <name>\n" +
    "  Create a new empty team.",
  "team add":
    "Usage: ib team add <name> <agent-id>\n" +
    "  Add an agent to an existing team.",
  "team remove":
    "Usage: ib team remove <name> <agent-id>\n" +
    "  Remove an agent from a team.",
  "team list":
    "Usage: ib team list\n" +
    "  List every team with its member count.",
  "team delete":
    "Usage: ib team delete <name>\n" +
    "  Delete a team. Does not affect the agents themselves.",
  roster:
    "Usage: ib roster <name>\n" +
    "  List a team's members with their repo and current state.",
  push:
    "Usage: ib push <repo-id>\n" +
    "  Push the repo's main (or master) branch to every configured remote.\n" +
    "  Each remote is attempted independently — read-only remotes are\n" +
    "  reported but do not stop pushes to the others.\n" +
    "  <repo-id>       Registered repo name, nickname, or absolute path",
  tgallow:
    "Usage: ib tgallow <chat_id>\n" +
    "  Allow a Telegram chat id to interact with itsybitsy.",
  tgdeny:
    "Usage: ib tgdeny <chat_id>\n" +
    "  Remove a Telegram chat id from the allowlist.",
  tgsend:
    "Usage: ib tgsend <text>\n" +
    "  Send a one-shot message to the configured Telegram chat.",
  "generate-summary":
    "Usage: ib generate-summary <agentDir>\n" +
    "  Internal: regenerate an agent's summary file. Fire-and-forget.",
  "write-pid":
    "Usage: ib write-pid <agent-id> <pid>\n" +
    "  Internal: record an agent's spawned process PID into meta.json. Called\n" +
    "  by start.sh / resume.sh.",
  "respawn-self":
    "Usage: ib respawn-self <agent-id>\n" +
    "  Internal: the detached worker launched by `ib respawn` calls this to\n" +
    "  perform the kill+restart from outside the target agent's tmux session.",
  "hook-check-path":
    "Usage: ib hook-check-path <agent-id>\n" +
    "  Internal: PreToolUse hook entrypoint that enforces path isolation. Reads\n" +
    "  JSON from stdin, writes a permission decision to stdout.",
  "hook-status":
    "Usage: ib hook-status <agent-id>\n" +
    "  Internal: Stop hook entrypoint. Detects stuck agents and triggers nudges.",
  "hook-permission-denied":
    "Usage: ib hook-permission-denied <agent-id>\n" +
    "  Internal: hook entrypoint that records permission-denied events to the\n" +
    "  agent log.",
  "hook-mark-running":
    "Usage: ib hook-mark-running <agent-id>\n" +
    "  Internal: hook entrypoint that records that an agent has resumed.",
};

/**
 * Print the help text for a known command and return true. Returns false when
 * no entry exists, so the caller can fall back to top-level usage.
 */
export function printCommandHelp(commandKey: string): boolean {
  const text = COMMAND_HELP[commandKey];
  if (!text) return false;
  console.log(text);
  return true;
}

function printUsage(): void {
  console.log("ib — Cross-repo agent dashboard");
  console.log("");
  console.log("Registry:");
  console.log("  add [path]          Register a repo (default: cwd)");
  console.log("  remove <path>       Unregister a repo");
  console.log("  list, ls            List repos and their agents (--manager <id>, --json)");
  console.log("  state               List agents with PID/liveness diagnostics + orphan detection (--manager <id>, --json, --cleanup, --dry-run)");
  console.log("  push <repo-id>      Push the repo's main branch to every configured remote");
  console.log("");
  console.log("Monitoring:");
  console.log("  watch               Launch TUI dashboard");
  console.log("  watchdog <id>       Run per-agent watchdog");
  console.log("  agents, tree        List all agents with states");
  console.log("  look <id>           Show agent's live tmux output (--lines N, --all, --follow)");
  console.log("  status <id>         Show agent's git log and status");
  console.log("  diff <id>           Show agent's git diff from parent (--stat)");
  console.log("  log <msg>           Write to agent log (--id <id>, --quiet)");
  console.log("  parse-state [file]  Parse agent state from text (-v for verbose)");
  console.log("  info <id>           Show agent's metadata");
  console.log("");
  console.log("Communication:");
  console.log("  send <id> <msg>     Send a message to an agent or @<team> (--from <id>, stdin)");
  console.log("  ask <question>      Ask user a question (--id <agent-id>)");
  console.log("  questions, q        Show pending agent questions (--all)");
  console.log("  acknowledge <qid>   Acknowledge a pending question (alias: ack)");
  console.log("");
  console.log("Teams:");
  console.log("  team create <name>  Create an empty team");
  console.log("  team add <name> <id>    Add an agent to a team");
  console.log("  team remove <name> <id> Remove an agent from a team");
  console.log("  team list           List all teams with member counts");
  console.log("  team delete <name>  Delete a team");
  console.log("  roster <name>       List a team's members with repo and state");
  console.log("");
  console.log("Agent Lifecycle:");
  console.log("  new-agent, new      Spawn a new agent");
  console.log("  kill <id>           Stop an agent without merging");
  console.log("  nuke <id>           Kill and archive an agent");
  console.log("  merge <id>          Merge agent's work and close it");
  console.log("  merge-check <id>    Check if agent is ready to merge");
  console.log("  resume <id>         Resume a stopped agent");
  console.log("  respawn [id]        Restart an agent's Claude session in-place (alias: restart)");
  console.log("                      No-arg form infers the agent from cwd — used by the /respawn slash command");
  console.log("");
  console.log("Configuration:");
  console.log("  config list         List all config keys with values");
  console.log("  config get <key>    Get a config value");
  console.log("  config set <k> <v>  Set a config value");
  console.log("  init-types          Populate ~/.itsybitsy/agent-types/ with built-in types");
  console.log("  list-types          List available agent types");
  console.log("  show-type <name>    Show full definition for a single agent type");
  console.log("  list-models, models  List known <cli>:<model> selectors");
  console.log("  config add <k> <v>  Add to array config key");
  console.log("  config remove <k> <v> Remove from array config key");
  console.log("  config unset <key>  Unset a config key (revert to default)");
  console.log("");
  console.log("Hooks:");
  console.log("  hooks install       Install safety hooks");
  console.log("  hooks uninstall     Uninstall safety hooks");
  console.log("  hooks status        Show hook installation status");
  console.log("  hooks intercept-install    Install intercept hook");
  console.log("  hooks intercept-uninstall  Uninstall intercept hook");
  console.log("  hooks intercept-status     Show intercept hook status");
  console.log("");
  console.log("Telegram:");
  console.log("  tgallow <chat_id>   Allow a Telegram chat_id");
  console.log("  tgdeny <chat_id>    Remove a Telegram chat_id from the allowlist");
  console.log("  tgsend <text>       Send a message to the configured Telegram chat");
}

async function main() {
  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return;
  }

  // Per-command help dispatch: `ib <command> --help` (or -h). Handled BEFORE
  // the switch so each case body doesn't need its own help check. Nested
  // subcommands (hooks / team / config) are checked at both layers — e.g.
  // `ib team add --help` resolves to the "team add" entry, while `ib team
  // --help` resolves to the "team" entry.
  if (command && hasHelpFlag(args)) {
    // Try the deepest match first: "<command> <sub>" if a sub is present.
    // Only do this for the known sub-grouped commands; everywhere else, the
    // top-level command key is the only valid lookup.
    const sub = args[1];
    if (sub && (command === "hooks" || command === "team" || command === "config")) {
      const subKey = `${command} ${sub}`;
      if (COMMAND_HELP[subKey]) {
        console.log(COMMAND_HELP[subKey]);
        return;
      }
    }
    // Alias normalisation — look up help text under the canonical command name.
    const canonical =
      command === "ls" ? "list"
      : command === "tree" ? "agents"
      : command === "q" ? "questions"
      : command === "ack" ? "acknowledge"
      : command === "new" ? "new-agent"
      : command === "restart" ? "respawn"
      : command === "init-agent-types" ? "init-types"
      : command === "list-agent-types" ? "list-types"
      : command === "show-agent-type" ? "show-type"
      : command === "models" ? "list-models"
      : command;
    if (printCommandHelp(canonical)) return;
    // Unknown command + --help — fall through to top-level usage.
    printUsage();
    return;
  }

  switch (command) {
    case "add": {
      const target = args[1] ?? process.cwd();
      const result = await addRepo(target);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case "remove": {
      const target = args[1];
      if (!target) {
        console.error("Usage: ib remove <path|name>");
        process.exit(1);
      }
      const result = await removeRepo(target);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case "push": {
      const repoId = args[1];
      if (!repoId) {
        console.error("Usage: ib push <repo-id>");
        process.exit(1);
      }
      const repos = await listRepos();
      const match = repos.find(
        (r) => r.path === repoId || r.name === repoId || r.nickname === repoId,
      );
      if (!match) {
        console.error(`Repo not found: ${repoId}`);
        process.exit(1);
      }
      const { pushRepo } = await import("./ib-commands");
      await printAndExit(await pushRepo(match.path));
      break;
    }
    case "list":
    case "ls": {
      const { readAllAgents, buildAgentTree, detectAgentStates } = await import("./agents");
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered. Use 'ib add <path>' to add one.");
        break;
      }

      // Filter by --manager flag if provided
      const managerIdx = args.indexOf("--manager");
      const managerFilter = managerIdx !== -1 ? args[managerIdx + 1] : null;
      const jsonOutput = args.includes("--json");

      const verbose = args.includes("--verbose") || args.includes("-v");
      const { agents, errors } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
      if (verbose) {
        for (const err of errors) {
          console.error(`Warning: ${err.error}`);
        }
      }
      // Read-only display: don't reap (ib list never mutates agent state).
      await detectAgentStates(agents, { reap: false });
      const roots = buildAgentTree(agents);

      if (jsonOutput) {
        // Collect agents matching the manager filter (reuse extracted helpers)
        const agentsToShow: { agent: Agent; depth: number }[] = [];
        for (const root of roots) {
          if (managerFilter) {
            if (root.id === managerFilter) {
              for (const child of root.children) {
                collectAgents(child, 1, null, agentsToShow);
              }
            } else {
              findManagerInTree(root, managerFilter, agentsToShow);
            }
          } else {
            collectAgents(root, 0, null, agentsToShow);
          }
        }
        const jsonData = agentsToShow.map(({ agent: a }) => ({
          id: a.id,
          nickname: a.meta.nickname ?? null,
          state: a.state,
          age: a.age,
          model: a.meta.model,
          worker: a.meta.worker,
          agentType: a.meta.agentType ?? null,
          manager: a.meta.manager ?? null,
          repo: a.repoName,
          repoPath: a.repoPath,
          prompt: a.meta.prompt,
          summary: a.meta.summary ?? null,
          orphaned: a.orphaned ?? false,
        }));
        console.log(JSON.stringify(jsonData, null, 2));
        break;
      }

      const { BOLD, DIM, RESET } = await import("./tui/colors");
      const { displayState } = await import("./tui/agent-tree");
      const { getStateColors } = await import("./tui/color-scheme");
      const stateColors = getStateColors();

      let isFirst = true;
      for (const repo of repos) {
        const name = repoDisplayName(repo);
        // Find root agents for this repo
        const repoRoots = roots.filter((a) => a.repoName === name && !a.archived);

        if (!isFirst) console.log("");
        isFirst = false;
        console.log(`${BOLD}${name}${RESET}  ${DIM}→  ${repo.path}${RESET}`);

        // Collect agents to display (flat list with indentation for children)
        const agentsToShow: { agent: Agent; depth: number }[] = [];
        for (const root of repoRoots) {
          if (managerFilter) {
            // When filtering by manager, show direct children of the manager
            if (root.id === managerFilter) {
              for (const child of root.children) {
                collectAgents(child, 1, null, agentsToShow);
              }
            } else {
              findManagerInTree(root, managerFilter, agentsToShow);
            }
          } else {
            collectAgents(root, 0, null, agentsToShow);
          }
        }

        if (agentsToShow.length === 0) {
          console.log(`  ${DIM}(no agents)${RESET}`);
        } else {
          for (const { agent, depth } of agentsToShow) {
            const indent = "  ".repeat(depth);
            const icon = resolveAgentIcon(agent.meta);
            const state = displayState(agent.state);
            const colorCode = stateColors[state] ?? DIM;
            const orphanMark = agent.orphaned ? "⚠ " : "";
            const mgr = agent.meta.manager ? `  ${DIM}mgr:${agent.meta.manager.slice(-8)}${RESET}` : "";
            // Show `nickname (id)` when a nickname is set, else just the id.
            const nameLabel = agent.meta.nickname
              ? `${agent.meta.nickname} ${DIM}(${agent.id})${RESET}`
              : agent.id;
            console.log(`${indent}${orphanMark}${icon} ${nameLabel}  ${colorCode}${state}${RESET}  ${agent.age}  ${DIM}${agent.meta.model}${RESET}${mgr}`);
          }
        }
      }
      break;
    }
    case "state": {
      const { readAllAgents, buildAgentTree, detectAgentStates } = await import("./agents");
      const {
        gatherAgentState,
        formatPidComponent,
        gatherOrphans,
        buildTrackedSets,
        prepareAndRunCleanup,
        sanitizeForDisplay,
      } = await import("./state-command");
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered. Use 'ib add <path>' to add one.");
        break;
      }

      const managerIdx = args.indexOf("--manager");
      const managerFilter = managerIdx !== -1 ? args[managerIdx + 1] : null;
      const jsonOutput = args.includes("--json");
      const verbose = args.includes("--verbose") || args.includes("-v");
      const cleanupMode = args.includes("--cleanup");
      const dryRunMode = args.includes("--dry-run");
      if (dryRunMode && !cleanupMode) {
        console.error("Error: --dry-run only makes sense with --cleanup");
        process.exit(1);
      }

      // `ib state` is the orphan-detection command: include archived agents so
      // their tmux_session/claude_pid/watchdog_pid metadata enters the tracked
      // set (buildTrackedSets). A stale-but-archived PID/session must not be
      // mis-classified as an orphan just because it's archived.
      const { agents, errors, liveTmuxSessions } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), true);
      if (verbose) {
        for (const err of errors) {
          console.error(`Warning: ${err.error}`);
        }
      }
      // Read-only display: don't reap. `ib state --cleanup` has its own
      // explicit orphan-kill path via prepareAndRunCleanup below.
      await detectAgentStates(agents, { reap: false });
      const roots = buildAgentTree(agents);

      // Collect agents per-repo so we can group output (same shape as `ib list`).
      const perRepo: { repoName: string; repoPath: string; rows: { agent: Agent; depth: number }[] }[] = [];
      for (const repo of repos) {
        const name = repoDisplayName(repo);
        const repoRoots = roots.filter((a) => a.repoName === name && !a.archived);
        const rows: { agent: Agent; depth: number }[] = [];
        for (const root of repoRoots) {
          if (managerFilter) {
            if (root.id === managerFilter) {
              for (const child of root.children) {
                collectAgents(child, 1, null, rows);
              }
            } else {
              findManagerInTree(root, managerFilter, rows);
            }
          } else {
            collectAgents(root, 0, null, rows);
          }
        }
        perRepo.push({ repoName: name, repoPath: repo.path, rows });
      }

      // Gather state for every displayed agent. Repos run sequentially so the
      // human-readable output stays grouped, but agents within a repo are
      // gathered in parallel (each spawns up to ~3 short-lived helpers).
      type GatheredRepo = {
        repoName: string;
        repoPath: string;
        rows: { agent: Agent; depth: number; row: Awaited<ReturnType<typeof gatherAgentState>> }[];
      };
      const gathered: GatheredRepo[] = [];
      for (const r of perRepo) {
        const gatheredRows = await Promise.all(
          r.rows.map(async ({ agent, depth }) => ({
            agent,
            depth,
            row: await gatherAgentState(agent),
          }))
        );
        gathered.push({ repoName: r.repoName, repoPath: r.repoPath, rows: gatheredRows });
      }

      // Always gather orphans across the WHOLE registry (every repo, every
      // agent — never just the ones matched by --manager). The tracked set
      // must include all known agents so legitimate work in other repos isn't
      // mis-flagged. We pass `liveTmuxSessions` from `readAllAgents()` so the
      // tmux-orphan view is consistent with the rest of the codebase's view
      // of live sessions (no extra `tmux list-sessions` call). `repoPaths`
      // is the absolute repo paths from the registry — required so a
      // claude process whose cwd is inside a stray `.ittybitty/agents/`
      // directory NOT under any registered repo isn't classified as ours.
      const repoPaths = repos.map((r) => r.path);
      const tracked = await buildTrackedSets(agents);
      const orphans = await gatherOrphans(tracked, liveTmuxSessions, repoPaths);

      // If --cleanup, kill orphans now and capture the result. To defend
      // against the race where another agent was spawned between our gather
      // and now, `prepareAndRunCleanup` re-reads agents FROM DISK (not from
      // our in-memory snapshot) and rebuilds the tracked set from that fresh
      // view before delegating to cleanupOrphans. Any target that became
      // tracked since gather is skipped. With --dry-run, no kills are issued.
      type CleanupReportT = Awaited<ReturnType<typeof prepareAndRunCleanup>>["cleanupReport"];
      let cleanupReport: CleanupReportT | null = null;
      if (cleanupMode) {
        const repoArgs = repos.map((r) => ({ path: r.path, name: repoDisplayName(r) }));
        const result = await prepareAndRunCleanup(
          orphans,
          // Cleanup re-reads agents from disk to defend against the gather/kill
          // race (see prepareAndRunCleanup docs). Pass `true` for the same
          // reason as the initial scan above — buildTrackedSets needs every
          // archived agent's metadata so post-archive PIDs/sessions aren't
          // mis-flagged as orphans.
          () => readAllAgents(repoArgs, true),
          { dryRun: dryRunMode, repoPaths },
        );
        cleanupReport = result.cleanupReport;
      }

      if (jsonOutput) {
        const agentRows = gathered.flatMap((g) => g.rows.map(({ row }) => row));
        const payload: {
          agents: typeof agentRows;
          orphans: typeof orphans;
          cleanup_actions?: NonNullable<typeof cleanupReport>["actions"];
        } = { agents: agentRows, orphans };
        if (cleanupReport) payload.cleanup_actions = cleanupReport.actions;
        console.log(JSON.stringify(payload, null, 2));
        break;
      }

      const { BOLD, DIM, RESET } = await import("./tui/colors");
      const { displayState } = await import("./tui/agent-tree");
      const { getStateColors } = await import("./tui/color-scheme");
      const stateColors = getStateColors();

      let isFirst = true;
      for (const g of gathered) {
        if (!isFirst) console.log("");
        isFirst = false;
        console.log(`${BOLD}${g.repoName}${RESET}  ${DIM}→  ${g.repoPath}${RESET}`);
        if (g.rows.length === 0) {
          console.log(`  ${DIM}(no agents)${RESET}`);
          continue;
        }
        for (const { agent, depth, row } of g.rows) {
          const indent = "  ".repeat(depth);
          const icon = resolveAgentIcon(agent.meta);
          const stateText = displayState(agent.state);
          const colorCode = stateColors[stateText] ?? DIM;
          const orphanMark = agent.orphaned ? "⚠ " : "";
          const tmux = formatPidComponent("tmux", row.tmux_pane_pid, row.tmux_pane_alive);
          const claude = formatPidComponent("claude", row.claude_pid, row.claude_alive);
          const watchdog = formatPidComponent("watchdog", row.watchdog_pid, row.watchdog_alive);
          const orphanCount = row.unexpected_children.length;
          const orphansSuffix = orphanCount > 0 ? `  ${DIM}[orphans: ${orphanCount}]${RESET}` : "";
          console.log(
            `${indent}${orphanMark}${icon} ${agent.id}  ${colorCode}${stateText}${RESET}  ${agent.age}  ${DIM}${tmux}  ${claude}  ${watchdog}${RESET}${orphansSuffix}`
          );
        }
      }

      // ── ORPHANS section ─────────────────────────────────────────────────
      // Always rendered (even when everything is clean — explicit "none" lines
      // make it obvious cleanup ran and found nothing). When --cleanup was
      // passed, each entry is annotated inline ([killed] / [skipped: …] /
      // [kill failed: …]). All cleanup result reporting happens here — no
      // duplicate per-action stderr line so `2>&1` consumers see one record
      // per orphan, not two.
      const annotateAction = (kind: string, target: string): string => {
        if (!cleanupReport) return "";
        const action = cleanupReport.actions.find(
          (a) => a.kind === kind && a.target === target
        );
        if (!action) return "";
        if (action.killed) return `  ${DIM}[killed]${RESET}`;
        if (action.skipped) return `  ${DIM}[skipped: ${action.error ?? "unknown"}]${RESET}`;
        return `  ${DIM}[kill failed: ${action.error ?? "unknown"}]${RESET}`;
      };

      console.log("");
      const orphansHeader = cleanupMode && dryRunMode
        ? `${BOLD}ORPHANS${RESET} ${DIM}(dry-run — no kills issued)${RESET}`
        : `${BOLD}ORPHANS${RESET}`;
      console.log(orphansHeader);
      const labelWidth = "ib watch processes:".length;
      const renderHeader = (label: string) => `  ${label.padEnd(labelWidth)}`;

      if (orphans.tmux_sessions.length === 0) {
        console.log(`${renderHeader("tmux sessions:")} ${DIM}none${RESET}`);
      } else {
        console.log(`${renderHeader("tmux sessions:")}`);
        for (const session of orphans.tmux_sessions) {
          const ann = annotateAction("tmux_session", session);
          console.log(`    ${sanitizeForDisplay(session)}${ann}`);
        }
      }

      if (orphans.claude_processes.length === 0) {
        console.log(`${renderHeader("claude processes:")} ${DIM}none${RESET}`);
      } else {
        console.log(`${renderHeader("claude processes:")}`);
        for (const proc of orphans.claude_processes) {
          const ann = annotateAction("claude_process", String(proc.pid));
          console.log(`    ${proc.pid}  ${DIM}${sanitizeForDisplay(proc.command)}${RESET}${ann}`);
        }
      }

      if (orphans.watchdog_processes.length === 0) {
        console.log(`${renderHeader("watchdog processes:")} ${DIM}none${RESET}`);
      } else {
        console.log(`${renderHeader("watchdog processes:")}`);
        for (const proc of orphans.watchdog_processes) {
          const ann = annotateAction("watchdog_process", String(proc.pid));
          console.log(`    ${proc.pid}  ${DIM}${sanitizeForDisplay(proc.command)}${RESET}${ann}`);
        }
      }

      if (orphans.ib_watch_processes.length === 0) {
        console.log(`${renderHeader("ib watch processes:")} ${DIM}none${RESET}`);
      } else {
        console.log(`${renderHeader("ib watch processes:")}`);
        for (const proc of orphans.ib_watch_processes) {
          const ann = annotateAction("ib_watch_process", String(proc.pid));
          console.log(`    ${proc.pid}  ${DIM}${sanitizeForDisplay(proc.command)}${RESET}${ann}`);
        }
      }
      break;
    }
    case "watchdog": {
      const watchdogAgentId = args[1];

      if (!watchdogAgentId) {
        console.error("Usage: ib watchdog <agent-id>");
        process.exit(1);
      }

      if (!isValidAgentId(watchdogAgentId)) {
        console.error(`Invalid agent ID: ${watchdogAgentId}`);
        process.exit(1);
      }
      const { runPerAgentWatchdog } = await import("./watchdog");
      const repos = await listRepos();
      if (repos.length === 0) {
        console.error("No repos registered.");
        process.exit(1);
      }
      // Find the repo containing this agent
      const { existsSync } = await import("fs");
      const agentRepo = repos.find((r) =>
        existsSync(join(r.path, ".ittybitty", "agents", watchdogAgentId, "meta.json"))
      );
      if (!agentRepo) {
        console.error(`Agent ${watchdogAgentId} not found in any registered repo.`);
        process.exit(1);
      }
      await runPerAgentWatchdog(watchdogAgentId, agentRepo.path);

      // runPerAgentWatchdog blocks until exit conditions are met
      break;
    }
    case "generate-summary": {
      const agentDir = args[1];
      if (!agentDir) {
        console.error("Usage: ib generate-summary <agentDir>");
        process.exit(1);
      }
      const { generateSummary } = await import("./generate-summary");
      try {
        await generateSummary(agentDir);
      } catch { /* ignore — fire-and-forget subprocess */ }
      break;
    }
    case "write-pid": {
      // Internal subcommand called by start.sh to record the
      // spawned process PID. Routes through mutateAgentMeta so the
      // claude_pid write does not race with concurrent meta.json mutations
      // from the codex SessionStart hook (which writes codex_session_id) or
      // the watchdog (which writes watchdog_pid). The naive inline
      // `bun -e readFileSync...writeFileSync` it replaces had a real
      // lost-write race window on codex agents.
      // Usage: ib write-pid <agent-id> <pid>
      const wpAgentId = args[1];
      const wpPidArg = args[2];
      if (!wpAgentId || !wpPidArg) {
        console.error("Usage: ib write-pid <agent-id> <pid>");
        process.exit(1);
      }
      if (!isValidAgentId(wpAgentId)) {
        console.error(`Invalid agent ID: ${wpAgentId}`);
        process.exit(1);
      }
      // Validate PID syntactically — start.sh passes $! which is always
      // numeric, but defense-in-depth rejects anything that isn't a
      // positive integer to keep garbage out of meta.json.
      if (!/^[1-9][0-9]*$/.test(wpPidArg)) {
        console.error(`Invalid PID: ${wpPidArg}`);
        process.exit(1);
      }
      const { mutateAgentMeta } = await import("./agents");
      const wpRepos = await listRepos();
      const { existsSync: wpExists } = await import("fs");
      const wpRepo = wpRepos.find((r) =>
        wpExists(join(r.path, ".ittybitty", "agents", wpAgentId, "meta.json"))
      );
      if (!wpRepo) {
        console.error(`Agent ${wpAgentId} not found in any registered repo.`);
        process.exit(1);
      }
      const wpAgentDir = join(wpRepo.path, ".ittybitty", "agents", wpAgentId);
      await mutateAgentMeta(wpAgentDir, (meta) => {
        meta.claude_pid = wpPidArg;
      });
      break;
    }
    case "watch": {
      if (!Bun.which("tmux")) {
        console.error("Error: 'tmux' not found on PATH. Install tmux: brew install tmux");
        process.exit(1);
      }
      const { launchDashboard } = await import("./tui/dashboard");
      await launchDashboard();
      break;
    }
    case "agents":
    case "tree": {
      const { readAllAgents, buildAgentTree, flattenAgentTree, detectAgentStates } = await import("./agents");
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered. Use 'ib add <path>' to add one.");
        break;
      }
      const verbose = args.includes("--verbose") || args.includes("-v");
      const { agents, errors } = await readAllAgents(repos.map((r) => ({ path: r.path, name: repoDisplayName(r) })), false);
      if (verbose) {
        for (const err of errors) {
          console.error(`Warning: ${err.error}`);
        }
      }
      // Read-only display: don't reap (ib tree never mutates agent state).
      await detectAgentStates(agents, { reap: false });
      const roots = buildAgentTree(agents);
      const flat = flattenAgentTree(roots, repos.map((r) => ({ name: repoDisplayName(r), path: r.path })));
      if (flat.length === 0) {
        console.log("No agents found across registered repos.");
      } else {
        const { visibleWidth } = await import("@mariozechner/pi-tui");
        const { displayState, computeStateColWidth } = await import("./tui/agent-tree");
        const { getStateColors } = await import("./tui/color-scheme");
        const { BOLD, DIM, RESET } = await import("./tui/colors");

        // Collect real agent rows for column width computation
        type AgentEntry = Extract<FlatEntry, { kind: "agent" }>;
        const rowByEntry = new Map<AgentEntry, { prefix: string; state: string; age: string; model: string }>();
        for (const entry of flat) {
          if (entry.kind !== "agent") continue;
          const orphanedPrefix = entry.agent.orphaned ? "⚠ " : "";
          const icon = resolveAgentIcon(entry.agent.meta);
          const prefix = `${entry.connector}${orphanedPrefix}${icon} ${entry.agent.id}`;
          rowByEntry.set(entry, {
            prefix,
            state: displayState(entry.agent.state),
            age: entry.agent.age,
            model: entry.agent.meta.model,
          });
        }

        // Compute max visible widths for alignment
        const maxState = computeStateColWidth(flat);
        let maxPrefix = 0, maxAge = 0, maxModel = 0;
        for (const row of rowByEntry.values()) {
          const pw = visibleWidth(row.prefix);
          if (pw > maxPrefix) maxPrefix = pw;
          if (row.age.length > maxAge) maxAge = row.age.length;
          if (row.model.length > maxModel) maxModel = row.model.length;
        }

        // Compute available width for prompt (terminal width minus fixed columns and gaps)
        const termWidth = process.stdout.columns || 120;
        // prefix + 2 + state + 2 + age + 2 + model + 2 = fixed portion
        const fixedWidth = maxPrefix + 2 + maxState + 2 + maxAge + 2 + maxModel + 2;
        const promptWidth = Math.max(20, termWidth - fixedWidth);

        const stateColors = getStateColors();
        let isFirst = true;
        for (const entry of flat) {
          if (entry.kind === "system-coordinator") continue; // CLI list doesn't show coordinator
          if (entry.kind === "repo-header") {
            if (!isFirst) console.log(""); // blank line between repos
            isFirst = false;
            console.log(`${BOLD}${entry.repoName}${RESET}  ${DIM}→  ${entry.repoPath}${RESET}`);
            if (!entry.hasAgents) {
              console.log(`  ${DIM}(no agents)${RESET}`);
            }
            continue;
          }

          const row = rowByEntry.get(entry)!;
          // Pad prefix using visibleWidth to account for box-drawing/icon chars
          const prefixPad = maxPrefix - visibleWidth(row.prefix);
          const paddedPrefix = row.prefix + " ".repeat(Math.max(0, prefixPad));
          const colorCode = stateColors[row.state] ?? DIM;
          const prompt = (entry.agent.meta.summary ?? entry.agent.meta.prompt).slice(0, promptWidth).replace(/\n/g, " ");
          const archived = entry.agent.archived ? ` ${DIM}[archived]${RESET}` : "";
          const line = [
            paddedPrefix,
            `${colorCode}${row.state.padEnd(maxState)}${RESET}`,
            row.age.padEnd(maxAge),
            row.model.padEnd(maxModel),
            prompt + archived,
          ].join("  ");
          console.log(line);
        }
      }
      break;
    }
    case "look": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const hasAll = args.includes("--all");
      const hasFollow = args.includes("--follow");
      const linesIdx = args.indexOf("--lines");
      const lines = hasAll ? 10000 : linesIdx !== -1 ? parseInt(args[linesIdx + 1]!, 10) || 100 : 100;

      const tmuxSession = agent.meta.tmux_session;

      if (hasFollow) {
        if (!tmuxSession) {
          console.error("Agent has no tmux session");
          process.exit(1);
        }
        console.error(`Attaching to ${agent.id} (Ctrl+b d to detach)...`);
        const attachProc = Bun.spawn(["tmux", "attach", "-t", tmuxSessionTarget(tmuxSession), "-r"], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        process.exit(await attachProc.exited);
        break;
      }

      const { captureTmuxOutput } = await import("./tmux-poller");

      if (tmuxSession) {
        const output = await captureTmuxOutput(tmuxSession, lines);
        if (output !== null) {
          process.stdout.write(output);
          break;
        }
      }

      // No tmux session or session not found — fall back to agent.log
      const { readAgentLog } = await import("./agents");
      const logLines = await readAgentLog(agent);
      console.log(logLines.join("\n"));
      break;
    }
    case "info": {
      const { detectAgentStates } = await import("./agents");
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      // Read-only display: don't reap (ib info never mutates agent state).
      await detectAgentStates([agent], { reap: false });
      const m = agent.meta;
      console.log(`Agent:        ${agent.id}`);
      console.log(`Repo:         ${agent.repoName} (${agent.repoPath})`);
      console.log(`State:        ${agent.state}`);
      console.log(`Model:        ${m.model}`);
      console.log(`Agent Type:   ${m.agentType ?? (m.worker ? "worker" : "manager")}`);
      console.log(`Worker:       ${m.worker}`);
      console.log(`Manager:      ${m.manager ?? "none"}`);
      console.log(`Created:      ${m.created}`);
      console.log(`Age:          ${agent.age}`);
      console.log(`Tmux session: ${m.tmux_session || "none"}`);
      console.log(`Worktree:     ${m.worktree}`);
      console.log(`Archived:     ${agent.archived}`);
      console.log(`Prompt:       ${m.prompt.slice(0, 200).replace(/\n/g, " ")}`);
      break;
    }
    case "questions":
    case "q": {
      const { readPendingQuestions, readAllQuestions } = await import("./agents");
      const repos = await listRepos();
      const showAll = args.includes("--all") || args.includes("-a");
      if (repos.length === 0) {
        console.log("No repos registered.");
        break;
      }
      let found = false;
      for (const repo of repos) {
        const questions = showAll
          ? await readAllQuestions(repo.path)
          : await readPendingQuestions(repo.path);
        for (const q of questions) {
          found = true;
          const statusTag = showAll && q.status === "acknowledged" ? " [acknowledged]" : "";
          console.log(`[${repo.name}] ${q.agent} (${q.id})${statusTag}`);
          console.log(`  ${q.question}`);
          console.log(`  ${q.timestamp}`);
          console.log("");
        }
      }
      if (!found) {
        console.log(showAll ? "No questions yet." : "No pending questions");
      }
      break;
    }
    case "diff": {
      const repos = await listRepos();
      const statOnly = args.includes("--stat");
      const diffArgs = args.slice(1).filter((a) => a !== "--stat");
      let diffAgentId: string | undefined = diffArgs[0];

      // Auto-detect agent ID from CWD if not provided
      if (!diffAgentId) {
        const cwd = process.cwd();
        const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
        if (worktreeMatch) {
          diffAgentId = worktreeMatch[1];
        }
      }

      if (diffAgentId) {
        const agent = await findAgentById(diffAgentId, repos);
        if (!agent) {
          console.error(`Agent not found: ${diffAgentId}`);
          process.exit(1);
        }
        const { diffAgent } = await import("./ib-commands");
        await printAndExit(await diffAgent(agent, { stat: statOnly }));
      } else {
        // No agent context — diff current branch vs its merge-base
        const { diffCwd } = await import("./ib-commands");
        await printAndExit(await diffCwd({ stat: statOnly }));
      }
      break;
    }
    case "status": {
      const repos = await listRepos();
      let statusAgentId: string | undefined = args[1];

      // Auto-detect agent ID from CWD if not provided
      if (!statusAgentId) {
        const cwd = process.cwd();
        const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
        if (worktreeMatch) {
          statusAgentId = worktreeMatch[1];
        }
      }

      const agent = await requireAgent(statusAgentId, repos);
      const { statusAgent } = await import("./ib-commands");
      await printAndExit(await statusAgent(agent));
      break;
    }
    case "send": {
      const repos = await listRepos();
      // Parse known flags (--from, -f/--file) at any position. Unknown short
      // flags (e.g. `-x`) and unknown long flags (e.g. `--bogus`) are rejected
      // BEFORE the target is seen so typos surface immediately. AFTER the
      // target, raw tokens — including ones that start with `-` — are joined
      // as the message body, so users can send messages like "-n hello".
      const sendArgs = args.slice(1);
      let fromAgent: string | undefined;
      let filePath: string | undefined;
      const filteredSendArgs: string[] = [];
      let seenTarget = false;
      for (let i = 0; i < sendArgs.length; i++) {
        const tok = sendArgs[i]!;
        // Known flags are always recognized, before OR after the target.
        // Existing scripts pass `ib send <id> -f <path>` and that must keep
        // working.
        if (tok === "--from") {
          if (!sendArgs[i + 1]) { console.error("Error: --from requires a value"); process.exit(1); }
          fromAgent = sendArgs[++i];
          continue;
        }
        if (tok === "-f" || tok === "--file") {
          if (!sendArgs[i + 1]) { console.error(`Error: ${tok} requires a path`); process.exit(1); }
          filePath = sendArgs[++i];
          continue;
        }
        if (!seenTarget) {
          // Before the target: anything starting with `-` is an unknown flag.
          if (tok.startsWith("-")) {
            console.error(`Error: unknown flag '${tok}'`);
            process.exit(1);
          }
          // First non-flag positional is the target.
          filteredSendArgs.push(tok);
          seenTarget = true;
        } else {
          // After the target: tokens are message body, no flag parsing.
          filteredSendArgs.push(tok);
        }
      }

      const usage = "Usage: ib send [--from <id>] <target> [-f <path>] [message...]\n  -f, --file <path>  Read message body from a file";

      if (!filteredSendArgs[0]) {
        console.error(usage);
        console.error("Targets: @system, @coordinator, @<repo>, @<repo>/<agent-id>, @<team>, or <agent-id>");
        process.exit(1);
      }

      const target = filteredSendArgs[0]!;
      const inlineMessage = filteredSendArgs.slice(1).join(" ");

      // Mutex: -f and inline message are mutually exclusive.
      if (filePath && inlineMessage) {
        console.error("Error: cannot combine -f/--file with an inline message");
        process.exit(1);
      }

      // Read file upfront so file errors are reported before agent lookup.
      let fileContent: string | undefined;
      if (filePath) {
        try {
          const f = Bun.file(filePath);
          if (!(await f.exists())) {
            console.error(`Error: file not found: ${filePath}`);
            process.exit(1);
          }
          fileContent = (await f.text()).trim();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Error: could not read file ${filePath}: ${msg}`);
          process.exit(1);
        }
      }

      // Resolve message content per precedence: inline > file > stdin.
      const resolveMessageBody = async (): Promise<string> => {
        if (inlineMessage) return inlineMessage;
        if (fileContent !== undefined) return fileContent;
        return readStdinIfPiped();
      };

      const { agent: resolvedAgent, isSystemCoordinator, team } = await resolveTarget(target, repos);

      if (isSystemCoordinator) {
        const coordMessage = await resolveMessageBody();
        if (!coordMessage) {
          console.error(usage);
          process.exit(1);
        }
        const result = await sendToSystemCoordinator(coordMessage, fromAgent ? { fromAgent } : undefined);
        await printAndExit(result);
        break;
      }

      // A team target resolves to ZERO-OR-MORE recipients, so it must branch
      // BEFORE the single-recipient `!resolvedAgent` guard below (§16.4): an
      // empty team is a no-op SUCCESS, not the exit-1 an unresolved single
      // `@name` produces. `teamSend` handles the empty recipient set itself.
      if (team) {
        const teamMessage = await resolveMessageBody();
        if (!teamMessage) {
          console.error(usage);
          process.exit(1);
        }
        const { teamSend } = await import("./ib-commands");
        await printAndExit(await teamSend(team.name, team.members, teamMessage, fromAgent ? { fromAgent } : undefined, repos));
        break;
      }

      if (!resolvedAgent) {
        process.exit(1);
      }

      const message = await resolveMessageBody();
      if (!message) {
        console.error(usage);
        process.exit(1);
      }
      const { sendMessage } = await import("./ib-commands");
      await printAndExit(await sendMessage(resolvedAgent, message, fromAgent ? { fromAgent } : undefined));
      break;
    }
    case "nickname": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);   // resolves by id OR nickname
      const rest = args.slice(2);
      const clear = rest.includes("--clear");
      const nickname = clear ? "" : rest[0];
      if (!clear && !nickname) {
        // no-arg: show current nickname
        console.log(agent.meta.nickname ?? "(no nickname set)");
        process.exit(0);
      }
      const { renameAgent } = await import("./ib-commands");
      await printAndExit(await renameAgent(agent, clear ? null : nickname!));  // null = clear
      break;
    }
    case "kill": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const extraArgs = args.slice(2).filter((a) => a !== "--force");
      if (extraArgs.length > 0) {
        console.error(`Warning: unknown arguments ignored: ${extraArgs.join(" ")}`);
      }
      const { killAgent } = await import("./ib-commands");
      await printAndExit(await killAgent(agent));
      break;
    }
    case "nuke": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { nukeAgent } = await import("./ib-commands");
      await printAndExit(await nukeAgent(agent));
      break;
    }
    case "merge-check": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { mergeCheckAgent } = await import("./ib-commands");
      await printAndExit(await mergeCheckAgent(agent));
      break;
    }
    case "merge": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const extraArgs = args.slice(2).filter((a) => a !== "--force");
      if (extraArgs.length > 0) {
        console.error(`Warning: unknown arguments ignored: ${extraArgs.join(" ")}`);
      }
      const resolved = resolveMergeTargetDir(agent, process.cwd());
      if (!resolved.ok) {
        console.error(resolved.error);
        process.exit(1);
      }
      const { mergeAgent } = await import("./ib-commands");
      await printAndExit(await mergeAgent(agent, resolved.targetDir));
      break;
    }
    case "resume": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const extraArgs = args.slice(2).filter((a) => a !== "--force");
      if (extraArgs.length > 0) {
        console.error(`Warning: unknown arguments ignored: ${extraArgs.join(" ")}`);
      }
      const { detectAgentStates } = await import("./agents");
      // Lifecycle path: about to mutate the agent (resume). Reaping a stale
      // husk tmux session before relaunch is desired.
      await detectAgentStates([agent], { reap: true });
      const { resumeAgent } = await import("./ib-commands");
      await printAndExit(await resumeAgent(agent));
      break;
    }
    case "respawn":
    case "restart": {
      // Backs the `/respawn` and `/restart` slash commands. Resolves the
      // current agent from the explicit ID arg, or — when no arg is given
      // — from the cwd, so the slash command body can be the literal
      // string `ib respawn` with no quoting. Schedules a detached
      // worker that does the actual kill+restart so this Claude session
      // can exit cleanly. See respawnAgent() for the full design.
      const idArg = args[1];
      const repos = await listRepos();

      // @system: route to the system coordinator restart path directly.
      // The system coordinator has no Agent object (no meta.json on disk),
      // so it can't go through the regular respawnAgent flow.
      if (idArg === "@system") {
        const { discardSystemCoordinator, ensureSystemCoordinator } = await import("./coordinator");
        await discardSystemCoordinator();
        await ensureSystemCoordinator();
        console.log("System coordinator restart scheduled (fresh session)");
        process.exit(0);
      }

      // Resolve target. If no ID, infer from cwd via the same mechanism
      // hooks use. This lets the slash command body call `ib respawn` with
      // no arguments — the most natural UX for a self-respawn.
      let agent: Agent | null = null;
      if (idArg) {
        agent = await findAgentById(idArg, repos);
        if (!agent) {
          console.error(`Agent not found: ${idArg}`);
          process.exit(1);
        }
      } else {
        const { resolveAgentFromCwd, SYSTEM_AGENT_ID } = await import("./hooks/shared");
        const resolved = resolveAgentFromCwd(process.cwd());
        if (resolved?.agentId === SYSTEM_AGENT_ID) {
          const { discardSystemCoordinator, ensureSystemCoordinator } = await import("./coordinator");
          await discardSystemCoordinator();
          await ensureSystemCoordinator();
          console.log("System coordinator restart scheduled (fresh session)");
          process.exit(0);
        }
        if (!resolved) {
          console.error("Could not detect current agent from cwd. Pass an agent ID: ib respawn <id>");
          process.exit(1);
        }
        agent = await findAgentById(resolved.agentId, repos);
        if (!agent) {
          console.error(`Agent not found: ${resolved.agentId}`);
          process.exit(1);
        }
      }

      const { detectAgentStates } = await import("./agents");
      // Lifecycle path: about to mutate the agent (respawn). Reaping a stale
      // husk tmux session before relaunch is desired.
      await detectAgentStates([agent], { reap: true });
      const { respawnAgent } = await import("./ib-commands");
      await printAndExit(await respawnAgent(agent));
      break;
    }
    case "respawn-self": {
      // Internal subcommand: the detached worker launched by `respawn`
      // calls this to perform the actual kill+restart from outside the
      // target agent's tmux session. Not intended for direct user use.
      const idArg = args[1];
      if (!idArg) {
        console.error("Usage: ib respawn-self <agent-id>");
        process.exit(1);
      }
      const repos = await listRepos();
      const agent = await findAgentById(idArg, repos);
      if (!agent) {
        console.error(`Agent not found: ${idArg}`);
        process.exit(1);
      }
      const { detectAgentStates } = await import("./agents");
      // Lifecycle path: about to mutate the agent (respawn-self). Reaping a
      // stale husk tmux session before relaunch is desired.
      await detectAgentStates([agent], { reap: true });
      const { respawnSelf } = await import("./ib-commands");
      await printAndExit(await respawnSelf(agent));
      break;
    }
    case "new-agent":
    case "new": {
      const ibArgs = args.slice(1); // strip "new-agent"/"new"

      // Parse flags first (validates syntax before repo lookup)
      const promptParts: string[] = [];
      const opts: import("./ib-commands").NewAgentOptions = {};
      let repoArg: string | undefined;
      let spawnedByAgentId: string | undefined;
      let spawnedByRepoPath: string | undefined;
      // Track whether we've seen a positional (non-flag) prompt token. Used to
      // gate the unknown-short-flag rejection so that a user CAN write a prompt
      // that starts with a dash by quoting it after the first non-flag token.
      let seenPromptToken = false;
      // Track whether an explicit -f/--file/--prompt-file was supplied. When it
      // was, its content wins over stdin (even if empty), so the heredoc stdin
      // fallback is suppressed — mirroring `send`'s "-f > stdin" precedence.
      let promptFromFile = false;
      for (let i = 0; i < ibArgs.length; i++) {
        const arg = ibArgs[i]!;
        if (arg === "--type") {
          if (!ibArgs[i + 1]) { console.error("Error: --type requires a value"); process.exit(1); }
          opts.type = ibArgs[++i];
        }
        else if (arg === "--model") {
          if (!ibArgs[i + 1]) { console.error("Error: --model requires a value"); process.exit(1); }
          opts.model = ibArgs[++i];
        }
        else if (arg === "--manager") {
          if (!ibArgs[i + 1]) { console.error("Error: --manager requires an agent ID"); process.exit(1); }
          opts.manager = ibArgs[++i];
        }
        else if (arg === "--name") {
          if (!ibArgs[i + 1]) { console.error("Error: --name requires a value"); process.exit(1); }
          opts.name = ibArgs[++i];
        }
        else if (arg === "--repo") {
          if (!ibArgs[i + 1]) { console.error("Error: --repo requires a value"); process.exit(1); }
          repoArg = ibArgs[++i];
        }
        else if (arg === "--spawned-by") {
          if (!ibArgs[i + 1]) { console.error("Error: --spawned-by requires a value"); process.exit(1); }
          spawnedByAgentId = ibArgs[++i];
        }
        else if (arg === "--spawned-by-repo") {
          if (!ibArgs[i + 1]) { console.error("Error: --spawned-by-repo requires a value"); process.exit(1); }
          spawnedByRepoPath = ibArgs[++i];
        }
        else if (arg === "--prompt-file" || arg === "-f" || arg === "--file") {
          if (!ibArgs[i + 1]) { console.error(`Error: ${arg} requires a value`); process.exit(1); }
          const promptFilePath = ibArgs[++i]!;
          const promptFile = Bun.file(promptFilePath);
          if (!(await promptFile.exists())) { console.error(`Error: prompt file not found: ${promptFilePath}`); process.exit(1); }
          promptParts.push(await promptFile.text());
          // Mark that an explicit -f/--file was supplied so it wins over stdin
          // even when its content is empty (matching `send`'s "-f > stdin"
          // precedence). Without this flag, an empty file would leave the prompt
          // blank and the stdin fallback below would incorrectly leak in.
          promptFromFile = true;
        }
        else if (arg === "--no-worktree") { opts.noWorktree = true; }
        else if (arg === "--yolo") { opts.yolo = true; }
        else if (arg === "--allow") {
          if (!ibArgs[i + 1]) { console.error("Error: --allow requires a value"); process.exit(1); }
          opts.allowTools = ibArgs[++i];
        }
        else if (arg === "--deny") {
          if (!ibArgs[i + 1]) { console.error("Error: --deny requires a value"); process.exit(1); }
          opts.denyTools = ibArgs[++i];
        }
        else if (arg.startsWith("--")) {
          console.error(`Error: unknown flag '${arg}'`);
          process.exit(1);
        }
        // Reject any other `-x` short flag before we have seen a positional
        // prompt token, to catch typos like `-F /tmp/foo.md` that would
        // otherwise be silently appended to the prompt body and then rejected
        // by claude. After the first positional token, a leading `-` is just
        // part of the prompt body.
        else if (!seenPromptToken && arg.startsWith("-") && arg.length > 1) {
          console.error(`Error: unknown flag '${arg}'`);
          process.exit(1);
        }
        else {
          promptParts.push(arg);
          seenPromptToken = true;
        }
      }
      // Prompt precedence: positional tokens / -f file content > piped stdin.
      // Only fall back to reading stdin (heredoc) when NEITHER a positional
      // prompt NOR an explicit -f/--file was supplied — exactly like `ib send`,
      // where -f wins over stdin even when the file is empty. When stdin is a
      // TTY (interactive, no arg) readStdinIfPiped() returns "" and newAgent()
      // emits the existing "Error: prompt required" — preserving prior behavior.
      let prompt = promptParts.join(" ");
      if (!prompt && !promptFromFile) {
        prompt = await readStdinIfPiped();
      }

      // Validate --spawned-by / --spawned-by-repo co-dependency and construct spawnedBy
      if (spawnedByRepoPath && !spawnedByAgentId) {
        console.error("Error: --spawned-by-repo requires --spawned-by");
        process.exit(1);
      }
      if (spawnedByAgentId && !isValidAgentId(spawnedByAgentId)) {
        console.error("Error: invalid --spawned-by agent ID");
        process.exit(1);
      }
      if (spawnedByAgentId) {
        opts.spawnedBy = {
          agent_id: spawnedByAgentId,
          repo_path: spawnedByRepoPath ?? process.cwd(),
        };
      }

      // Determine target repo: --repo flag > cwd match > single registered repo > error
      const repos = await listRepos();
      let repoPath: string | null = null;

      if (repoArg) {
        const match = repos.find((r) => r.name === repoArg || r.path === repoArg);
        if (!match) {
          console.error(`Repo not found: ${repoArg}`);
          process.exit(1);
        }
        repoPath = match.path;
      } else {
        const cwd = process.cwd();
        const cwdMatch = repos.find((r) => cwd === r.path || cwd.startsWith(r.path + "/"));
        if (cwdMatch) {
          repoPath = cwdMatch.path;
        } else if (repos.length === 1) {
          repoPath = repos[0]!.path;
        } else {
          console.error("Cannot determine target repo. Use --repo <name|path> or run from within a registered repo.");
          process.exit(1);
        }
      }

      const { newAgent } = await import("./ib-commands");
      await printAndExit(await newAgent(repoPath, prompt, opts));
      break;
    }
    case "acknowledge":
    case "ack": {
      const questionId = args[1];
      if (!questionId) {
        console.error("Usage: ib ack <question-id>");
        process.exit(1);
      }
      // Find which repo has this question
      const { readPendingQuestions } = await import("./agents");
      const repos = await listRepos();
      let repoPath: string | null = null;
      for (const repo of repos) {
        const questions = await readPendingQuestions(repo.path);
        if (questions.some((q) => q.id === questionId)) {
          repoPath = repo.path;
          break;
        }
      }
      if (!repoPath) {
        if (repos.length === 0) {
          console.error("No repos registered.");
          process.exit(1);
        }
        repoPath = repos[0]!.path;
      }
      const { acknowledgeQuestion } = await import("./ib-commands");
      await printAndExit(await acknowledgeQuestion(repoPath, questionId));
      break;
    }
    case "ask": {
      const repos = await listRepos();
      // Parse --id flag or auto-detect from CWD
      const askArgs = args.slice(1);
      let askAgentId: string | undefined;
      const askQuestionParts: string[] = [];
      for (let i = 0; i < askArgs.length; i++) {
        const arg = askArgs[i]!;
        if (arg === "--id") {
          askAgentId = askArgs[++i];
        } else {
          askQuestionParts.push(arg);
        }
      }
      // Question precedence: positional tokens > piped stdin. When no positional
      // question was supplied, fall back to reading stdin (heredoc), exactly like
      // `ib send`. A TTY with no arg returns "" and falls through to the existing
      // usage error below — preserving prior behavior.
      let askQuestionText = askQuestionParts.join(" ");
      if (!askQuestionText) {
        askQuestionText = await readStdinIfPiped();
      }

      // Auto-detect agent ID from CWD
      if (!askAgentId) {
        const cwd = process.cwd();
        const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
        if (worktreeMatch) {
          askAgentId = worktreeMatch[1];
        }
      }

      if (!askAgentId) {
        console.error("Error: Could not detect agent ID. Run from an agent worktree or use --id <agent-id>.");
        process.exit(1);
      }
      if (!askQuestionText) {
        console.error('Usage: ib ask [--id <agent-id>] "question"');
        process.exit(1);
      }

      // Determine repo path from agent
      const askAgent = await findAgentById(askAgentId, repos);
      if (!askAgent) {
        console.error(`Agent not found: ${askAgentId}`);
        process.exit(1);
      }

      const { askQuestion } = await import("./ib-commands");
      await printAndExit(await askQuestion(askAgent.repoPath, askAgentId, askQuestionText));
      break;
    }
    case "log": {
      const repos = await listRepos();
      // Parse --id and --quiet flags
      const logArgs = args.slice(1);
      let logAgentId: string | undefined;
      let logQuiet = false;
      const logMessageParts: string[] = [];
      for (let i = 0; i < logArgs.length; i++) {
        const arg = logArgs[i]!;
        if (arg === "--id") {
          logAgentId = logArgs[++i];
        } else if (arg === "--quiet" || arg === "-q") {
          logQuiet = true;
        } else {
          logMessageParts.push(arg);
        }
      }
      const logMessage = logMessageParts.join(" ");

      // Auto-detect agent ID from cwd if not specified
      if (!logAgentId) {
        const cwd = process.cwd();
        const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
        if (worktreeMatch) {
          logAgentId = worktreeMatch[1];
        }
      }

      if (!logAgentId) {
        console.error("Error: Could not detect agent ID. Run from an agent worktree or use --id.");
        process.exit(1);
      }
      if (!logMessage) {
        console.error('Usage: ib log [--id <agent-id>] [--quiet] "message"');
        process.exit(1);
      }

      const agent = await findAgentById(logAgentId, repos);
      if (!agent) {
        console.error(`Agent not found: ${logAgentId}`);
        process.exit(1);
      }

      const { join } = await import("path");
      const { logAgent } = await import("./agent-lifecycle");
      const agentDir = join(agent.repoPath, ".ittybitty", agent.archived ? "archive" : "agents", agent.id);
      await logAgent(agentDir, logMessage);

      if (!logQuiet) {
        console.log(logMessage);
      }
      break;
    }
    case "parse-state": {
      const { parseState } = await import("./parse-state");
      const psArgs = args.slice(1);
      let verbose = false;
      let inputFile: string | undefined;
      for (const arg of psArgs) {
        if (arg === "-v" || arg === "--verbose") verbose = true;
        else if (!arg.startsWith("-")) inputFile = arg;
      }

      let input: string;
      if (inputFile) {
        const file = Bun.file(inputFile);
        if (!(await file.exists())) {
          console.error(`Error: file not found: ${inputFile}`);
          process.exit(1);
        }
        input = await file.text();
      } else if (process.stdin.isTTY) {
        console.error("Error: no input provided. Use a file argument or pipe input.");
        console.error("Usage: ib parse-state [file] or echo 'text' | ib parse-state");
        process.exit(1);
      } else {
        // Read from stdin
        const chunks: string[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        }
        input = chunks.join("");
      }

      const result = parseState(input);
      if (verbose) {
        console.log(`${result.state} (matched: ${result.reason})`);
      } else {
        console.log(result.state);
      }
      break;
    }
    // ── Hook subcommands (called by Claude Code's hook system) ──
    // The literal `@system` sentinel is accepted in addition to real agent IDs
    // here. It is NOT user input — it's hardcoded into the system coordinator's
    // settings.local.json by `writeCoordinatorFiles()` in coordinator.ts —
    // so allowing it doesn't widen the attack surface, and we keep
    // `isValidAgentId()` itself strict for everywhere else (spawn, registry,
    // health-check) where the value is supplied externally.
    case "hook-check-path": {
      const id = args[1];
      if (!id) { console.error("Usage: ib hook-check-path <agent-id>"); process.exit(1); }
      if (id !== SYSTEM_AGENT_ID && !isValidAgentId(id)) { console.error("Invalid agent ID"); process.exit(1); }
      const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
      const { hookCheckPath } = await import("./hooks/agent-path");
      const stdin = await new Response(Bun.stdin.stream()).text();
      const agentDir = resolveAgentDir(process.cwd(), id);
      await withHookLogging("hook-check-path", agentDir, stdin, () => hookCheckPath(id, stdin));
      break;
    }
    case "hook-status": {
      const id = args[1];
      if (!id) { console.error("Usage: ib hook-status <agent-id>"); process.exit(1); }
      if (!isValidAgentId(id)) { console.error("Invalid agent ID"); process.exit(1); }
      const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
      const { hookStatus } = await import("./hooks/agent-status");
      const stdin = await new Response(Bun.stdin.stream()).text();
      const agentDir = resolveAgentDir(process.cwd(), id);
      await withHookLogging("hook-status", agentDir, stdin, () => hookStatus(id, stdin));
      break;
    }
    case "hook-permission-denied": {
      const id = args[1];
      if (!id) { console.error("Usage: ib hook-permission-denied <agent-id>"); process.exit(1); }
      if (id !== SYSTEM_AGENT_ID && !isValidAgentId(id)) { console.error("Invalid agent ID"); process.exit(1); }
      const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
      const { hookPermissionDenied } = await import("./hooks/permission-denied");
      const stdin = await new Response(Bun.stdin.stream()).text();
      const agentDir = resolveAgentDir(process.cwd(), id);
      await withHookLogging("hook-permission-denied", agentDir, stdin, () => hookPermissionDenied(id, stdin));
      break;
    }
    case "hook-mark-running": {
      const id = args[1];
      if (!id) { console.error("Usage: ib hook-mark-running <agent-id>"); process.exit(1); }
      if (id !== SYSTEM_AGENT_ID && !isValidAgentId(id)) { console.error("Invalid agent ID"); process.exit(1); }
      const { hookMarkRunning } = await import("./hooks/mark-running");
      await hookMarkRunning();
      break;
    }
    case "init-types":
    case "init-agent-types": {
      const { initAgentTypes } = await import("./agent-types");
      try {
        const created = await initAgentTypes();
        const home = process.env.HOME || (await import("os")).homedir();
        const typesDir = (await import("path")).join(home, ".itsybitsy", "agent-types");
        if (created.length === 0) {
          console.log(`Agent type files already present at: ${typesDir} (no files created)`);
        } else {
          console.log(`Agent type files initialized at: ${typesDir}`);
          for (const name of created) {
            console.log(`  created ${name}`);
          }
        }
      } catch (err) {
        console.error(`Error initializing agent types: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    case "list-types":
    case "list-agent-types": {
      const { ensureAgentTypesDir, listAgentTypes } = await import("./agent-types");
      try {
        await ensureAgentTypesDir();
        const types = await listAgentTypes();
        types.sort((a, b) => a.name.localeCompare(b.name));

        const DESC_MAX = 60;
        const truncate = (s: string): string =>
          s.length > DESC_MAX ? s.substring(0, DESC_MAX - 1) + "…" : s;

        const rows = types.map((t) => {
          const spawnable = t.spawnable === false ? "no" : "yes";
          const spawnsChildren =
            t.spawnable === false ? "-" : t.canSpawnChildren ? "yes" : "no";
          return {
            name: t.name,
            spawnable,
            spawnsChildren,
            description: truncate(t.description || ""),
          };
        });

        const headers = { name: "NAME", spawnable: "SPAWNABLE", spawnsChildren: "SPAWNS CHILDREN", description: "DESCRIPTION" };
        const nameWidth = Math.max(headers.name.length, ...rows.map((r) => r.name.length));
        const spawnableWidth = Math.max(headers.spawnable.length, ...rows.map((r) => r.spawnable.length));
        const childrenWidth = Math.max(headers.spawnsChildren.length, ...rows.map((r) => r.spawnsChildren.length));

        const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));

        console.log(
          `${pad(headers.name, nameWidth)}  ${pad(headers.spawnable, spawnableWidth)}  ${pad(headers.spawnsChildren, childrenWidth)}  ${headers.description}`,
        );
        for (const row of rows) {
          console.log(
            `${pad(row.name, nameWidth)}  ${pad(row.spawnable, spawnableWidth)}  ${pad(row.spawnsChildren, childrenWidth)}  ${row.description}`,
          );
        }
      } catch (err) {
        console.error(`Error listing agent types: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    case "show-type":
    case "show-agent-type": {
      const name = args[1];
      if (!name || name.startsWith("--")) {
        console.error("Usage: ib show-type <name> [--json]");
        process.exit(1);
      }
      const wantJson = args.includes("--json");
      const { ensureAgentTypesDir, loadAgentType } = await import("./agent-types");
      try {
        await ensureAgentTypesDir();
        const type = await loadAgentType(name);
        if (wantJson) {
          console.log(JSON.stringify(type, null, 2));
          break;
        }
        const allow = type.permissions?.allow ?? [];
        const deny = type.permissions?.deny ?? [];
        const spawnable = type.spawnable === false ? "no" : "yes";
        const spawnsChildren =
          type.spawnable === false ? "-" : type.canSpawnChildren ? "yes" : "no";

        console.log(`NAME: ${type.name}`);
        if (type.description) console.log(`DESCRIPTION: ${type.description}`);
        console.log(`SPAWNABLE: ${spawnable}`);
        console.log(`SPAWNS CHILDREN: ${spawnsChildren}`);
        console.log(`INSTRUCTION STYLE: ${type.instructionStyle}`);
        if (type.model) console.log(`MODEL: ${type.model}`);
        if (type.icon) console.log(`ICON: ${type.icon}`);
        if (type.allowedPaths && type.allowedPaths.length > 0) {
          console.log("ALLOWED PATHS:");
          for (const p of type.allowedPaths) console.log(`  ${p}`);
        }
        if (type.repos && type.repos.length > 0) {
          console.log("REPOS:");
          for (const r of type.repos) console.log(`  ${r}`);
        }
        console.log("");
        console.log(`PERMISSIONS ALLOW (${allow.length}):`);
        for (const t of allow) console.log(`  ${t}`);
        console.log("");
        console.log(`PERMISSIONS DENY (${deny.length}):`);
        for (const t of deny) console.log(`  ${t}`);
        console.log("");
        console.log("PROMPT BODY (template — {{vars}} are substituted at spawn time):");
        console.log(type.markdownBody ?? "");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        console.error("Run 'ib list-types' to see available agent types.");
        process.exit(1);
      }
      break;
    }
    case "list-models":
    case "models": {
      const { KNOWN_MODELS } = await import("./known-models");
      if (args.includes("--json")) {
        const enriched = KNOWN_MODELS.map((m) => ({ ...m, full: `${m.cli}:${m.model}` }));
        console.log(JSON.stringify(enriched, null, 2));
        break;
      }
      const byCli = new Map<string, typeof KNOWN_MODELS>();
      for (const entry of KNOWN_MODELS) {
        const bucket = byCli.get(entry.cli) ?? [];
        bucket.push(entry);
        byCli.set(entry.cli, bucket);
      }
      const fullWidth = Math.max(...KNOWN_MODELS.map((m) => `${m.cli}:${m.model}`.length));
      const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
      const clis = Array.from(byCli.keys()).sort();
      for (let i = 0; i < clis.length; i++) {
        const cli = clis[i]!;
        if (i > 0) console.log("");
        console.log(cli.toUpperCase());
        for (const entry of byCli.get(cli)!) {
          const full = `${entry.cli}:${entry.model}`;
          if (entry.description) {
            console.log(`  ${pad(full, fullWidth)} — ${entry.description}`);
          } else {
            console.log(`  ${full}`);
          }
        }
      }
      break;
    }
    case "config": {
      const { runConfigCommand } = await import("./config-command");
      await runConfigCommand(args.slice(1));
      break;
    }
    case "hooks": {
      // Nested subcommands under "hooks"
      const subcommand = args[1];
      switch (subcommand) {
        case "intercept-task": {
          const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
          const { hookInterceptTask } = await import("./hooks/intercept-task");
          const stdin = await new Response(Bun.stdin.stream()).text();
          const agentDir = resolveAgentDir(process.cwd());
          await withHookLogging("intercept-task", agentDir, stdin, () => hookInterceptTask(stdin));
          break;
        }
        case "session-start": {
          const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
          const { hookSessionStart } = await import("./hooks/session-start");
          const stdin = await new Response(Bun.stdin.stream()).text();
          const agentDir = resolveAgentDir(process.cwd());
          const agentIdArg = args[2]; // optional: ib hooks session-start <agentId>
          await withHookLogging("session-start", agentDir, stdin, () => hookSessionStart(stdin, agentIdArg));
          break;
        }
        case "main-path": {
          const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
          const { hookMainPath } = await import("./hooks/main-path");
          const stdin = await new Response(Bun.stdin.stream()).text();
          const agentDir = resolveAgentDir(process.cwd());
          await withHookLogging("main-path", agentDir, stdin, () => hookMainPath(stdin));
          break;
        }
        case "inject-status": {
          const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
          const { hookInjectStatus } = await import("./hooks/inject-status");
          const stdin = await new Response(Bun.stdin.stream()).text();
          const agentDir = resolveAgentDir(process.cwd());
          const statusFlags = args.slice(2);
          let mode: "full" | "if-changed" | "brief" = "full";
          let visible = false;
          for (const flag of statusFlags) {
            if (flag === "--full") mode = "full";
            else if (flag === "--if-changed") mode = "if-changed";
            else if (flag === "--brief") mode = "brief";
            else if (flag === "--visible") visible = true;
          }
          await withHookLogging("inject-status", agentDir, stdin, () => hookInjectStatus({ mode, visible }, stdin));
          break;
        }
        case "inject-timestamp": {
          const { resolveAgentDir, withHookLogging } = await import("./hooks/slow-hook-logger");
          const { hookInjectTimestamp } = await import("./hooks/inject-timestamp");
          const stdin = await new Response(Bun.stdin.stream()).text();
          const agentDir = resolveAgentDir(process.cwd());
          await withHookLogging("inject-timestamp", agentDir, stdin, () => hookInjectTimestamp(stdin));
          break;
        }
        case "codex-pre-tool-use":
        case "codex-session-start":
        case "codex-stop": {
          // Codex's hook contract is FAIL-OPEN — any non-zero exit / thrown
          // error / unsupported decision means the tool call PROCEEDS.
          // Dispatcher-level argv parsing + import errors must be caught and
          // converted to a valid no-op/deny payload + exit 0. See
          // src/hooks/codex-dispatcher.ts for the load-bearing logic.
          const event = subcommand.replace(/^codex-/, "") as
            | "pre-tool-use"
            | "session-start"
            | "stop";
          const id = args[2];
          const dryRun = args.slice(3).includes("--dry-run");
          const { runCodexDispatcher } = await import("./hooks/codex-dispatcher");
          const { exitCode } = await runCodexDispatcher(event, id, { dryRun });
          process.exit(exitCode);
        }
        case "install": {
          const { installSafetyHooks } = await import("./ib-commands");
          await printAndExit(await installSafetyHooks(process.cwd()));
          break;
        }
        case "uninstall": {
          const { uninstallSafetyHooks } = await import("./ib-commands");
          await printAndExit(await uninstallSafetyHooks(process.cwd()));
          break;
        }
        case "status": {
          const { hooksStatus } = await import("./ib-commands");
          await printAndExit(await hooksStatus(process.cwd()));
          break;
        }
        case "intercept-install": {
          const { installInterceptHook } = await import("./ib-commands");
          await printAndExit(await installInterceptHook(process.cwd()));
          break;
        }
        case "intercept-uninstall": {
          const { uninstallInterceptHook } = await import("./ib-commands");
          await printAndExit(await uninstallInterceptHook(process.cwd()));
          break;
        }
        case "intercept-status": {
          const { interceptHooksStatus } = await import("./ib-commands");
          await printAndExit(await interceptHooksStatus(process.cwd()));
          break;
        }
        default:
          console.error(`Unknown hooks subcommand: ${subcommand}`);
          console.error("Available: intercept-task, session-start, main-path, inject-status, inject-timestamp, codex-pre-tool-use, codex-session-start, codex-stop, install, uninstall, status, intercept-install, intercept-uninstall, intercept-status");
          process.exit(1);
      }
      break;
    }
    case "team": {
      const sub = args[1];
      const teamUsage =
        "Usage: ib team <create|add|remove|list|delete> ...\n" +
        "  ib team create <name>\n" +
        "  ib team add <name> <agent-id>\n" +
        "  ib team remove <name> <agent-id>\n" +
        "  ib team list\n" +
        "  ib team delete <name>";
      if (!sub) {
        console.error(teamUsage);
        process.exit(1);
      }
      const repos = await listRepos();
      const {
        teamCreate,
        teamAdd,
        teamRemove,
        teamList,
        teamDelete,
      } = await import("./ib-commands");
      switch (sub) {
        case "create": {
          const name = args[2];
          if (!name) {
            console.error("Usage: ib team create <name>");
            process.exit(1);
          }
          // createdBy is left "" for human CLI creation (§16 DETAIL 7).
          await printAndExit(await teamCreate(name));
          break;
        }
        case "add": {
          const name = args[2];
          const agentId = args[3];
          if (!name || !agentId) {
            console.error("Usage: ib team add <name> <agent-id>");
            process.exit(1);
          }
          await printAndExit(await teamAdd(name, agentId, repos));
          break;
        }
        case "remove": {
          const name = args[2];
          const agentId = args[3];
          if (!name || !agentId) {
            console.error("Usage: ib team remove <name> <agent-id>");
            process.exit(1);
          }
          await printAndExit(await teamRemove(name, agentId, repos));
          break;
        }
        case "list": {
          await printAndExit(await teamList());
          break;
        }
        case "delete": {
          const name = args[2];
          if (!name) {
            console.error("Usage: ib team delete <name>");
            process.exit(1);
          }
          await printAndExit(await teamDelete(name));
          break;
        }
        default: {
          console.error(`Error: unknown team subcommand '${sub}'`);
          console.error(teamUsage);
          process.exit(1);
        }
      }
      break;
    }
    case "roster": {
      const name = args[1];
      if (!name) {
        console.error("Usage: ib roster <name>");
        process.exit(1);
      }
      const repos = await listRepos();
      const { roster } = await import("./ib-commands");
      await printAndExit(await roster(name, repos));
      break;
    }
    case "tgallow": {
      const id = args[1];
      if (!id) {
        console.error("Usage: ib tgallow <chat_id>");
        process.exit(1);
      }
      const { addChat, isGroupShaped } = await import("./channels/access");
      const added = await addChat(id);
      if (added) {
        console.log(`added: ${id}`);
        if (isGroupShaped(id)) {
          console.log(`warning: ${id} looks like a group/supergroup id (starts with "-"). Phase 5 only routes 1:1 DMs.`);
        }
      } else {
        console.log(`already allowed: ${id}`);
      }
      break;
    }
    case "tgdeny": {
      const id = args[1];
      if (!id) {
        console.error("Usage: ib tgdeny <chat_id>");
        process.exit(1);
      }
      const { removeChat } = await import("./channels/access");
      const removed = await removeChat(id);
      console.log(removed ? `removed: ${id}` : `not present: ${id}`);
      break;
    }
    case "tgsend": {
      const text = args[1];
      if (!text) {
        console.error("Usage: ib tgsend <text>");
        process.exit(1);
      }
      const { telegramSend } = await import("./ib-commands");
      const result = await telegramSend(text);
      if (result.ok) {
        console.log(result.message);
      } else {
        console.error(result.message);
        process.exit(1);
      }
      break;
    }
    default: {
      printUsage();
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
