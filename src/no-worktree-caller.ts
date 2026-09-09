import { isAbsolute, join } from "path";
import { readdir, realpath } from "fs/promises";
import { CLAUDE_PID_START_MARGIN_SECONDS } from "./agents";
import { isValidAgentId } from "./validation";
import { userInfo } from "os";

export interface NoWorktreeCaller {
  meta: Record<string, unknown>;
  agentDir: string;
  repoPath: string;
}

interface CallerDeps {
  registryHome?: string;
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

async function registeredRoots(registryHome: string): Promise<string[]> {
  // Unlike the display-oriented registry reader, malformed/unreadable policy
  // must not silently become an empty registry and misclassify an agent as a
  // human. Missing registry is the ordinary pre-registration human case.
  const file = Bun.file(join(registryHome, ".itsybitsy", "repos.json"));
  if (!(await file.exists())) return [];
  const registry = await file.json();
  if (!registry || !Array.isArray(registry.repos)) throw new Error("Cannot verify caller: invalid repository registry");
  const roots = new Set<string>();
  for (const entry of registry.repos) {
    if (!entry || typeof entry.path !== "string" || !isAbsolute(entry.path)) {
      throw new Error("Cannot verify caller: invalid registered repository path");
    }
    try {
      roots.add(await realpath(entry.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...roots];
}

function ancestorPids(pid: number, parents: Map<number, number>): Set<number> {
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
  return ancestors;
}

/**
 * Identify an agent that shares a repository cwd with human CLI callers.
 * A cwd or claimed environment/argument ID alone cannot distinguish them.
 * Match the actual process ancestry to a recorded live CLI PID/start epoch.
 * Recheck ancestry after metadata reads and identity validation so a vanished
 * or reparented process never supplies caller authority.
 *
 * Only canonical roots from the operator's repository registry are authority
 * roots. Search them independently of cwd so moving to a different directory
 * cannot hide the real caller or replace it with an unregistered forged tree.
 * Multiple matching records are an error; filesystem order cannot choose which
 * caller policy wins.
 */
export async function resolveNoWorktreeCaller(
  _cwd: string,
  deps: CallerDeps = {},
): Promise<NoWorktreeCaller | null> {
  const candidates: NoWorktreeCaller[] = [];
  // HOME is model-controlled. Resolve the operator home from the OS account.
  for (const repoPath of await registeredRoots(deps.registryHome ?? userInfo().homedir)) {
    const agentsDir = join(repoPath, ".ittybitty", "agents");
    const entries = await readdir(agentsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidAgentId(entry.name)) continue;
      const agentDir = join(agentsDir, entry.name);
      let meta: Record<string, unknown>;
      try {
        meta = await Bun.file(join(agentDir, "meta.json")).json();
      } catch { continue; }
      if (!meta || Array.isArray(meta) || meta.id !== entry.name || meta.worktree !== false) continue;
      candidates.push({ meta, agentDir, repoPath });
    }
  }
  if (!candidates.length) return null;

  const readParents = deps.readParents ?? readParentPids;
  const identityCurrent = deps.identityCurrent ?? processIdentityCurrent;
  const pid = deps.pid ?? process.pid;
  const before = ancestorPids(pid, readParents());
  const matches = candidates.filter(({ meta }) => {
    const rawPid = meta.claude_pid;
    if (typeof rawPid !== "string" || !/^\d+$/.test(rawPid)) return false;
    const cliPid = Number(rawPid);
    return cliPid > 1 && Number.isSafeInteger(cliPid) && before.has(cliPid);
  });
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Cannot verify no-worktree caller: ambiguous agent records");
  const caller = matches[0]!;
  const cliPid = Number(caller.meta.claude_pid);
  const epoch = caller.meta.claude_pid_epoch;
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0 || !identityCurrent(cliPid, epoch)) {
    throw new Error("Cannot verify no-worktree caller process identity; resume the agent before spawning children");
  }
  const after = ancestorPids(pid, readParents());
  if (!after.has(cliPid) || !identityCurrent(cliPid, epoch)) {
    throw new Error("Cannot verify no-worktree caller: process identity changed");
  }
  return caller;
}
