import { basename } from "node:path";
import { resolveDashboardCaller } from "../no-worktree-caller";

interface DashboardCaller {
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  pid: number;
  readProcessTable?(command: string[]): string;
  resolveCaller: typeof resolveDashboardCaller;
}

function readProcessTable(command: string[]): string {
  const ps = Bun.spawnSync(command, {
    stdout: "pipe", stderr: "pipe", timeout: 2_000, env: { LC_ALL: "C" },
  });
  if (ps.exitCode !== 0 || ps.stdout.length > 4 * 1024 * 1024) throw new Error("Incomplete process table");
  return ps.stdout.toString();
}

/** One ps snapshot. Require an unbroken chain from this process through PID 1. */
function readAncestors(pid: number, readTable: NonNullable<DashboardCaller["readProcessTable"]>): Map<number, string[]> | null {
  const processes = new Map<number, { parent: number; names: string[] }>();
  try {
    // ps pads columns in bytes. Use the headings so spaces within either name
    // are preserved and a blank field cannot borrow text from the next one.
    const [header, ...rows] = readTable(["/bin/ps", "-axww", "-o", "pid=PID,ppid=PPID,ucomm=KERNEL,comm=COMMAND"]).split("\n");
    if (!header || !/^\s*PID\s+PPID\s+KERNEL\s+COMMAND\s*$/.test(header)) return null;
    const kernel = header.indexOf("KERNEL");
    const command = header.indexOf("COMMAND");
    for (const line of rows) {
      const bytes = Buffer.from(line);
      const ids = /^\s*(\d+)\s+(\d+)\s+$/.exec(bytes.toString("utf8", 0, kernel));
      if (!ids) continue;
      const names = [bytes.toString("utf8", kernel, command).trim(), bytes.toString("utf8", command).trim()];
      processes.set(Number(ids[1]), { parent: Number(ids[2]), names: names.map(name => basename(name)) });
    }
  } catch {
    return null;
  }
  const ancestry = new Map<number, string[]>();
  while (pid > 0 && !ancestry.has(pid)) {
    const process = processes.get(pid);
    if (!process || process.names.some(name => !name)) break;
    ancestry.set(pid, process.names);
    if (pid === 1) return ancestry;
    pid = process.parent;
  }
  return null;
}

/** Evaluated once by launchDashboard. Only null enables outbound remote starts. */
export async function remoteStartDenialAtStartup(input?: DashboardCaller): Promise<string | null> {
  const unverified = "Cannot verify the dashboard caller’s agent metadata for remote starts";
  try {
    const { stdinTTY, stdoutTTY, env, cwd, resolveCaller, pid, readProcessTable: readTable = readProcessTable } = input ?? {
      stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env,
      cwd: process.cwd(), pid: process.pid, readProcessTable, resolveCaller: resolveDashboardCaller,
    };
    if (stdinTTY !== true || stdoutTTY !== true) return "Remote starts require an interactive terminal";
    if (env.TMUX !== undefined) return "Remote starts are disabled inside tmux";
    const ancestors = readAncestors(pid, readTable);
    if (!ancestors) return "Cannot verify dashboard process ancestry for remote starts";
    for (const names of ancestors.values()) {
      const agent = names.find(name => ["claude", "codex", "agy"].includes(name.toLowerCase()));
      if (agent) return `Remote starts are disabled under ${agent}`;
    }
    const caller = await resolveCaller(cwd, new Set(ancestors.keys()));
    if (caller === "no-agent") return null;
    if (caller === "agent") return "Only a human can start an agent on another machine";
    return unverified;
  } catch {
    return unverified;
  }
}
