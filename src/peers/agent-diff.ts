import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentWorktreePath, type Agent } from "../agents";
import { isCoordinatorType } from "../coordinator-type-names";
import { transferStagingRoot } from "../runtime-names";
import { stagingArea, stagingOwnerStart, writeTransferOwner } from "./transfer-owner";

export const MAX_AGENT_DIFF_BYTES = 64 * 1024 * 1024;
export const EMPTY_DIFF = "No changes to show — diff is empty";
export interface AgentDiff { base: string; patch: Buffer }

const exec = promisify(execFile);

export async function captureAgentDiff(agents: readonly Agent[], repo: string, id: string): Promise<AgentDiff> {
  const agent = agents.find(a => a.id === id && a.repoRegistryName.toLowerCase() === repo.toLowerCase()
    && !a.archived && !isCoordinatorType(a.meta.agentType));
  if (!agent) throw new Error(`Agent ${id} not found in ${repo}`);
  const cwd = agentWorktreePath(agent);
  if (!existsSync(join(cwd, ".git"))) throw new Error("Worktree no longer exists — agent may have been merged");
  const mergeBase = await Bun.$`git merge-base HEAD main`.cwd(cwd).quiet().nothrow();
  if (mergeBase.exitCode !== 0) throw new Error("Could not determine merge-base with main");
  const base = mergeBase.text().trim();
  try {
    const { stdout: patch } = await exec("git", ["diff", "--binary", base], { cwd, encoding: "buffer", maxBuffer: MAX_AGENT_DIFF_BYTES });
    if (!patch.length) throw new Error(EMPTY_DIFF);
    return { base, patch };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Agent diff exceeds 64 MiB");
    throw err;
  }
}

async function runGit(cwd: string, args: string[], stdin?: Buffer) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: stdin ?? "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code) throw new Error(stderr.trim().split("\n")[0] || `git ${args[0]} exited with code ${code}`);
}

export async function prepareDiffCopy(repoPath: string, repo: string, machine: string, { base, patch }: AgentDiff, root = transferStagingRoot()) {
  const dir = await mkdtemp(join(await stagingArea(root, "diffs"), "copy-"));
  const cwd = join(dir, "repo");
  try {
    await writeTransferOwner(dir, { pid: process.pid, start: stagingOwnerStart(process.pid) });
    await runGit(dir, ["clone", "--shared", "--no-checkout", "--", repoPath, cwd]);
    const check = await Bun.$`git cat-file -e ${base + "^{commit}"}`.cwd(cwd).quiet().nothrow();
    if (check.exitCode) throw new Error(`Fetch or pull ${repo} first: commit ${base} from ${machine} is not in your copy`);
    await runGit(cwd, ["checkout", "--detach", base]);
    // The object can exist locally even when this machine's main is behind.
    await runGit(cwd, ["branch", "-f", "main", base]);
    // Track new files too, so git diff <base> includes them in the tool.
    await runGit(cwd, ["apply", "--index", "--binary", "--whitespace=nowarn"], patch);
    return { dir, cwd };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
