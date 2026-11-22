import { basename } from "node:path";
import { resolveDashboardCaller } from "../no-worktree-caller";

interface DashboardCaller {
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  pid: number;
  readProcessTable(): string;
  resolveCaller: typeof resolveDashboardCaller;
}

function readProcessTable(): string {
  const ps = Bun.spawnSync(["/bin/ps", "-axww", "-o", "pid=,ppid=,comm="], {
    stdout: "pipe", stderr: "pipe", timeout: 2_000, env: { LC_ALL: "C" },
  });
  if (ps.exitCode !== 0 || ps.stdout.length > 4 * 1024 * 1024) throw new Error("Incomplete process table");
  return ps.stdout.toString();
}

/** One ps snapshot. Require an unbroken chain from this process through PID 1. */
function readAncestors(pid: number, readTable: () => string): Map<number, string> | null {
  const processes = new Map<number, { parent: number; executable: string }>();
  try {
    for (const line of readTable().split("\n")) {
      const fields = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (fields) processes.set(Number(fields[1]), { parent: Number(fields[2]), executable: basename(fields[3]!) });
    }
  } catch {
    return null;
  }
  const ancestry = new Map<number, string>();
  while (pid > 0 && !ancestry.has(pid)) {
    const process = processes.get(pid);
    if (!process?.executable) break;
    ancestry.set(pid, process.executable);
    if (pid === 1) return ancestry;
    pid = process.parent;
  }
  return null;
}

/** Evaluated once by launchDashboard. Only null enables outbound remote starts. */
export async function remoteStartDenialAtStartup(input?: DashboardCaller): Promise<string | null> {
  const unverified = "Cannot verify the dashboard caller’s agent metadata for remote starts";
  try {
    const { stdinTTY, stdoutTTY, env, cwd, resolveCaller, pid, readProcessTable: readTable } = input ?? {
      stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env,
      cwd: process.cwd(), pid: process.pid, readProcessTable, resolveCaller: resolveDashboardCaller,
    };
    if (stdinTTY !== true || stdoutTTY !== true) return "Remote starts require an interactive terminal";
    if (env.TMUX !== undefined) return "Remote starts are disabled inside tmux";
    const ancestors = readAncestors(pid, readTable);
    if (!ancestors) return "Cannot verify dashboard process ancestry for remote starts";
    for (const executable of ancestors.values()) {
      if (["claude", "codex", "agy"].includes(executable.toLowerCase())) {
        return `Remote starts are disabled under ${executable}`;
      }
    }
    const caller = await resolveCaller(cwd, new Set(ancestors.keys()));
    if (caller === "no-agent") return null;
    if (caller === "agent") return "Only a human can start an agent on another machine";
    return unverified;
  } catch {
    return unverified;
  }
}
