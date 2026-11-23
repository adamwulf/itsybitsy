import * as runtimeNames from "./runtime-names";
import { dirname, isAbsolute, join, resolve } from "path";
import { readdir, realpath } from "fs/promises";
import { CLAUDE_PID_START_MARGIN_SECONDS } from "./agents";
import { REPO_COORDINATOR_TYPE } from "./coordinator-type-names";
import { isValidAgentId, isValidPeerSenderIdSegment } from "./validation";
import { userInfo } from "os";

export interface NoWorktreeCaller {
  meta: Record<string, unknown>;
  agentDir: string;
  repoPath: string;
}

interface CallerDeps {
  remoteSender?: boolean;
  systemPanePid?: () => Promise<number | null>;
  /** The dashboard already observed the complete process chain. Its scan must fail closed on unreadable records. */
  dashboardAncestry?: ReadonlySet<number>;
  registryHome?: string;
  /**
   * Canonical repo roots to search instead of every registered repo. The hooks
   * pass the repos of the agent records they already found when they run inside
   * the agent's kernel sandbox, where no other registered repo is readable.
   */
  roots?: string[];
  pid?: number;
  readParents?: () => Map<number, number>;
  identityCurrent?: (pid: number, epoch: number | undefined) => boolean;
}

function readParentPids(): Map<number, number> {
  const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], {
    stdout: "pipe", stderr: "pipe", timeout: 2_000,
    env: { LC_ALL: "C", LC_TIME: "C" },
  });
  if (result.exitCode !== 0 || result.stdout.length > 4 * 1024 * 1024) {
    throw new Error("Cannot verify no-worktree caller process ancestry");
  }
  const parents = new Map<number, number>();
  for (const line of result.stdout.toString().split("\n")) {
    const fields = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (fields) parents.set(Number(fields[1]), Number(fields[2]));
  }
  return parents;
}

function processIdentityCurrent(pid: number, epoch: number | undefined): boolean {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return false;
  try {
    process.kill(pid, 0);
    const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe", stderr: "pipe", timeout: 2_000,
      env: { LC_ALL: "C", LC_TIME: "C" },
    });
    if (result.exitCode !== 0 || result.stdout.length > 1_024) return false;
    const start = Date.parse(result.stdout.toString().trim()) / 1_000;
    return Number.isFinite(start) && Math.abs(start - epoch) <= CLAUDE_PID_START_MARGIN_SECONDS;
  } catch { return false; }
}

async function registeredRoots(registryHome: string, strict: boolean): Promise<string[]> {
  // Unlike the display-oriented registry reader, malformed/unreadable policy
  // must not silently become an empty registry and misclassify an agent as a
  // human. Missing registry is the ordinary pre-registration human case.
  const file = Bun.file(join(registryHome, ".itsybitsy", "repos.json"));
  if (!strict && !(await file.exists())) return [];
  let registry;
  try {
    registry = await file.json();
  } catch (err) {
    if (strict && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (!registry || !Array.isArray(registry.repos)) throw new Error("Cannot verify caller: invalid repository registry");
  const roots = new Set<string>();
  for (const entry of registry.repos) {
    if (!entry || typeof entry.path !== "string" || !isAbsolute(entry.path)) {
      throw new Error("Cannot verify caller: invalid registered repository path");
    }
    try {
      roots.add(await realpath(entry.path));
    } catch (error) {
      if (!isSkippableRepoError(error, strict)) throw error;
    }
  }
  return [...roots];
}

/**
 * A registered repo the current process cannot reach is not a candidate, so it
 * is skipped rather than failing the whole lookup. ENOENT covers a repo that was
 * moved or deleted; EPERM/EACCES cover a repo outside the caller's reach — a
 * sandboxed agent (kernel Seatbelt profile) can only read its own repo, so
 * every other registered repo fails `realpath`/`readdir` with EPERM. Skipping
 * is safe for caller attribution: a caller's own agent record lives in a repo
 * it can read, so the record that identifies it is never the one skipped.
 * Malformed registry data and every other I/O error still throw (fail closed).
 */
function isSkippableRepoError(error: unknown, strict: boolean): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || (!strict && (code === "EPERM" || code === "EACCES"));
}

function ancestorPids(pid: number, parents: Map<number, number>, requireInit = false): Set<number> {
  const ancestors = new Set<number>();
  while (pid > 1) {
    if (ancestors.has(pid) || ancestors.size >= 128) {
      throw new Error("Cannot verify no-worktree caller: invalid process ancestry");
    }
    ancestors.add(pid);
    const parent = parents.get(pid);
    if (parent === undefined || !Number.isSafeInteger(parent) || parent < 0) {
      throw new Error("Cannot verify no-worktree caller: incomplete process ancestry");
    }
    pid = parent;
  }
  if (requireInit && pid !== 1) throw new Error("Cannot verify remote sender: incomplete process ancestry");
  return ancestors;
}

/**
 * An existing agent worktree already identifies its caller. Verify both the
 * registered repository and Git's worktree backlink before taking this fast
 * path: a directory that only resembles an agent worktree is not sufficient.
 * This uses filesystem reads only; Codex's native sandbox can prohibit ps.
 */
async function isRegisteredAgentWorktree(cwd: string, roots: string[]): Promise<boolean> {
  try {
    const canonicalCwd = await realpath(cwd);
    const match = runtimeNames.matchWorktreeCaller(canonicalCwd);
    if (!match || !roots.includes(match[1]!) || !isValidAgentId(match[2]!)) return false;
    const repoPath = match[1]!;
    const agentId = match[2]!;
    const agentDir = runtimeNames.agentDir(repoPath, agentId);
    const worktreePath = join(agentDir, "repo");
    const meta = await Bun.file(join(agentDir, "meta.json")).json();
    if (!meta || Array.isArray(meta) || meta.id !== agentId || meta.worktree === false) return false;

    const gitFile = join(worktreePath, ".git");
    const pointer = (await Bun.file(gitFile).text()).trim().match(/^gitdir: (.+)$/);
    if (!pointer) return false;
    const gitDir = await realpath(resolve(worktreePath, pointer[1]!));
    // Git's worktree administration directory must belong to this registered
    // repo, and its backlink must name this exact worktree's .git file.
    const worktreesDir = await realpath(join(repoPath, ".git", "worktrees"));
    if (dirname(gitDir) !== worktreesDir) return false;
    const backlink = (await Bun.file(join(gitDir, "gitdir")).text()).trim();
    if (!backlink) return false;
    return await realpath(resolve(gitDir, backlink)) === await realpath(gitFile);
  } catch {
    // Missing or unverifiable worktree metadata must use the existing caller
    // verification, never gain an exemption from caller authorization.
    return false;
  }
}

/** System sessions have no agent metadata. Use the coordinator's registered
 * launch pane, while its recorded CLI is live, to identify its process tree. */
async function systemPanePid(): Promise<number | null> {
  const { IB_COORDINATOR_SESSION } = await import("./coordinator");
  const { COORDINATOR_PANE_COMMAND, COORDINATOR_PANE_ID, runCoordinatorCommand } = await import("./tmux-poller");
  const match = `#{==:#{pane_id}:#{pane_dead}:#{pane_current_command},#{${COORDINATOR_PANE_ID}}:0:#{${COORDINATOR_PANE_COMMAND}}}`;
  const res = await runCoordinatorCommand(["tmux", "list-panes", "-s", "-t", "=" + IB_COORDINATOR_SESSION,
    "-F", `#{?${match},#{pane_pid},}`], 2000);
  if (res.code !== 0) {
    if (/can't find session|no server running|no such file or directory/i.test(res.error)) return null;
    throw new Error("Cannot verify system coordinator process: " + res.error.trim());
  }
  const value = res.text.trim();
  if (!value) throw new Error("Cannot verify system coordinator launch pane");
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid system coordinator process");
  return Number(value);
}

/**
 * Identify an agent that shares a repository cwd with human CLI callers.
 * A cwd or claimed environment/argument ID alone cannot distinguish them.
 * Match the actual process ancestry to a recorded live CLI PID/start epoch.
 * Recheck ancestry after metadata reads and identity validation so a vanished
 * or reparented process never supplies caller authority.
 *
 * Registered agent worktrees do not need process ancestry: their protected
 * metadata identifies the caller. Otherwise search canonical registered roots
 * (or `deps.roots`, see CallerDeps) independently of cwd so an unregistered
 * forged tree cannot replace it.
 * Multiple matching records are an error; filesystem order cannot choose which
 * caller policy wins.
 */
export async function resolveNoWorktreeCaller(
  cwd: string,
  deps: CallerDeps = {},
): Promise<NoWorktreeCaller | null> {
  const candidates: NoWorktreeCaller[] = [];
  // HOME is model-controlled. Resolve the operator home from the OS account.
  const strict = deps.remoteSender === true || deps.dashboardAncestry !== undefined;
  const roots = deps.roots ?? await registeredRoots(deps.registryHome ?? userInfo().homedir, strict);
  if (!deps.dashboardAncestry && await isRegisteredAgentWorktree(cwd, roots)) {
    if (!deps.remoteSender) return null;
    const [, repoPath, id] = runtimeNames.matchWorktreeCaller(await realpath(cwd))!;
    return { repoPath: repoPath!, agentDir: runtimeNames.agentDir(repoPath!, id!), meta: { id } };
  }
  if (deps.remoteSender && runtimeNames.matchWorktreeCaller(cwd)) {
    throw new Error("Cannot verify remote sender: invalid registered worktree backlink");
  }
  for (const repoPath of roots) {
    const agentsDir = runtimeNames.agentsDir(repoPath);
    const entries = await readdir(agentsDir, { withFileTypes: true }).catch((error) => {
      if ((!strict && error.code === "ENOTDIR") || isSkippableRepoError(error, strict)) return [];
      throw error;
    });
    for (const entry of entries) {
      const dottedCoordinator = deps.remoteSender && entry.name.includes(".") && isValidPeerSenderIdSegment(entry.name);
      if (!entry.isDirectory() || (!isValidAgentId(entry.name) && !dottedCoordinator)) continue;
      const agentDir = join(agentsDir, entry.name);
      let meta: Record<string, unknown>;
      try {
        meta = await Bun.file(join(agentDir, "meta.json")).json();
      } catch (err) {
        if (strict) throw err;
        continue;
      }
      if (!meta || Array.isArray(meta) || meta.id !== entry.name || (strict && typeof meta.worktree !== "boolean")) {
        if (strict) throw new Error("Invalid agent metadata");
        continue;
      }
      if ((!deps.remoteSender && meta.worktree !== false) || (dottedCoordinator && meta.agentType !== REPO_COORDINATOR_TYPE)) continue;
      if (deps.remoteSender && meta.worktree === false && meta.claude_pid === "" && (cwd === repoPath || cwd.startsWith(repoPath + "/"))) {
        throw new Error("Cannot verify remote sender: shared-checkout agent has no recorded process identity");
      }
      if (strict && meta.claude_pid !== "") {
        const pid = Number(meta.claude_pid);
        if (typeof meta.claude_pid !== "string" || !/^\d+$/.test(meta.claude_pid) || !Number.isSafeInteger(pid) || pid <= 1) {
          throw new Error("Invalid agent process identity");
        }
      }
      candidates.push({ meta, agentDir, repoPath });
    }
  }
  if (!deps.remoteSender && !candidates.length) return null;

  const readParents = deps.readParents ?? readParentPids;
  const identityCurrent = deps.identityCurrent ?? processIdentityCurrent;
  const pid = deps.pid ?? process.pid;
  const before = deps.dashboardAncestry ?? ancestorPids(pid, readParents(), deps.remoteSender);
  const matches = candidates.filter(({ meta }) => {
    const rawPid = meta.claude_pid;
    if (typeof rawPid !== "string" || !/^\d+$/.test(rawPid)) return false;
    const cliPid = Number(rawPid);
    return cliPid > 1 && Number.isSafeInteger(cliPid) && before.has(cliPid);
  });
  if (!matches.length) {
    if (deps.remoteSender) {
      const lookup = deps.systemPanePid ?? systemPanePid;
      const pane = await lookup();
      if (pane !== null && before.has(pane)) {
        if (!ancestorPids(pid, readParents(), deps.remoteSender).has(pane) || await lookup() !== pane) throw new Error("System coordinator identity changed");
        return { meta: { id: "@system" }, repoPath: "", agentDir: "" };
      }
    }
    return null;
  }
  if (matches.length !== 1) throw new Error("Cannot verify no-worktree caller: ambiguous agent records");
  const caller = matches[0]!;
  const cliPid = Number(caller.meta.claude_pid);
  const epoch = caller.meta.claude_pid_epoch;
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0 || !identityCurrent(cliPid, epoch)) {
    if (deps.remoteSender) throw new Error("Cannot verify remote sender: shared-checkout agent process identity is stale");
    throw new Error("Cannot verify no-worktree caller process identity; resume the agent before spawning children");
  }
  const after = deps.dashboardAncestry ?? ancestorPids(pid, readParents(), deps.remoteSender);
  if (!after.has(cliPid) || !identityCurrent(cliPid, epoch)) {
    throw new Error("Cannot verify no-worktree caller: process identity changed");
  }
  return caller;
}

/** The dashboard distinguishes a clean negative lookup from an unreadable identity. */
export async function resolveDashboardCaller(
  cwd: string,
  ancestry: ReadonlySet<number>,
  deps: Pick<CallerDeps, "registryHome" | "identityCurrent"> = {},
): Promise<"agent" | "no-agent" | "unverifiable"> {
  try {
    const path = await realpath(cwd);
    const worktree = runtimeNames.matchWorktreeCaller(path);
    if (worktree) {
      const meta = await Bun.file(join(runtimeNames.worktreeAgentDir(path), "meta.json")).json();
      return meta?.id === worktree[2] && meta.worktree === true ? "agent" : "unverifiable";
    }
    const caller = await resolveNoWorktreeCaller(path, { ...deps, dashboardAncestry: ancestry });
    return caller === null ? "no-agent" : "agent";
  } catch {
    return "unverifiable";
  }
}
