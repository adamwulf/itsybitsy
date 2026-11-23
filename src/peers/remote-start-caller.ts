import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_PID_START_MARGIN_SECONDS } from "../agents";
import { resolveDashboardCaller } from "../no-worktree-caller";

interface DashboardCaller {
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  pid: number;
  readProcessTable?(command: [string, ...string[]], signal: AbortSignal): Promise<string>;
  resolveCaller: typeof resolveDashboardCaller;
}

const execFileAsync = promisify(execFile);

async function readProcessTable([file, ...args]: [string, ...string[]], signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { signal, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: "C" } });
  return stdout;
}

interface Ancestor {
  parent: number;
  names: string[];
  started: string;
}

/** One ps snapshot. Require an unbroken chain from this process through PID 1. */
async function readAncestors(pid: number, readTable: NonNullable<DashboardCaller["readProcessTable"]>, signal: AbortSignal): Promise<Map<number, Ancestor> | null> {
  const processes = new Map<number, Ancestor>();
  try {
    // ps pads columns in bytes. Use the headings so spaces within either name
    // are preserved and a blank field cannot borrow text from the next one.
    const table = await readTable(["/bin/ps", "-axww", "-o", "pid=PID,ppid=PPID,lstart=STARTED,ucomm=KERNEL,comm=COMMAND"], signal);
    if (signal.aborted) return null;
    const [header, ...rows] = table.split("\n");
    if (!header || !/^\s*PID\s+PPID\s+STARTED\s+KERNEL\s+COMMAND\s*$/.test(header)) return null;
    const kernel = header.indexOf("KERNEL");
    const command = header.indexOf("COMMAND");
    for (const line of rows) {
      const bytes = Buffer.from(line);
      const ids = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+$/.exec(bytes.toString("utf8", 0, kernel));
      if (!ids) continue;
      const names = [bytes.toString("utf8", kernel, command).trim(), bytes.toString("utf8", command).trim()];
      processes.set(Number(ids[1]), { parent: Number(ids[2]), started: ids[3]!, names: names.map(name => basename(name)) });
    }
  } catch {
    return null;
  }
  const ancestry = new Map<number, Ancestor>();
  while (pid > 0 && !ancestry.has(pid)) {
    const process = processes.get(pid);
    // macOS ps may show "(launchd)" in comm when another user's argv is unreadable.
    // We also check ucomm, the kernel p_comm that a process cannot set. Agent
    // CLIs run as the same user, so ps can read their argv.
    if (!process || process.names.some(name => !name)) break;
    ancestry.set(pid, process);
    if (pid === 1) return ancestry;
    pid = process.parent;
  }
  return null;
}

async function classifyCaller(signal: AbortSignal, input: DashboardCaller | undefined, terminalOnly: boolean): Promise<string | null> {
  const unverified = "Cannot verify the dashboard caller’s agent metadata for remote starts";
  try {
    const { stdinTTY, stdoutTTY, env, cwd, resolveCaller, pid, readProcessTable: readTable = readProcessTable } = input ?? {
      stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env,
      cwd: process.cwd(), pid: process.pid, readProcessTable, resolveCaller: resolveDashboardCaller,
    };
    if (stdinTTY !== true || stdoutTTY !== true) return "Remote starts require an interactive terminal";
    if (env.TMUX !== undefined) return "Remote starts are disabled inside tmux";
    const ancestors = await readAncestors(pid, readTable, signal);
    if (!ancestors) return "Cannot verify dashboard process ancestry for remote starts";
    for (const { names } of ancestors.values()) {
      const agent = names.find(name => ["claude", "codex", "agy"].includes(name.toLowerCase()));
      if (agent) return `Remote starts are disabled under ${agent}`;
    }
    if (terminalOnly) return null;
    // Verify shared-repo PID epochs against this same snapshot, without
    // running the ordinary caller resolver's synchronous ps probes.
    const caller = await resolveCaller(cwd, new Set(ancestors.keys()), {
      identityCurrent: (pid, epoch) => {
        const ancestor = ancestors.get(pid);
        return ancestor !== undefined && epoch !== undefined
          && Math.abs(Date.parse(ancestor.started) / 1_000 - epoch) <= CLAUDE_PID_START_MARGIN_SECONDS;
      },
    });
    if (caller === "no-agent") return null;
    if (caller === "agent") return "Only a human can start an agent on another machine";
    return unverified;
  } catch {
    return unverified;
  }
}

const startupClock = {
  now: () => performance.now(),
  setTimer(ms: number, callback: () => void) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/** One startup decision, including process and filesystem reads, under one deadline. */
async function callerDenial(input: DashboardCaller | undefined, clock: typeof startupClock, terminalOnly: boolean): Promise<string | null> {
  const timeout = "Remote starts are disabled because checking the dashboard caller timed out";
  const timeoutMs = 2_000;
  const deadline = clock.now() + timeoutMs;
  const controller = new AbortController();
  const expired = Promise.withResolvers<string>();
  const cancelTimer = clock.setTimer(timeoutMs, () => {
    expired.resolve(timeout);
    controller.abort();
  });
  try {
    const result = await Promise.race([expired.promise, classifyCaller(controller.signal, input, terminalOnly)]);
    return clock.now() >= deadline ? timeout : result;
  } finally {
    cancelTimer();
  }
}

export function remoteStartDenialAtStartup(input?: DashboardCaller, clock = startupClock) {
  return callerDenial(input, clock, false);
}

export async function isHumanSendTerminal(input?: DashboardCaller): Promise<boolean> {
  return await callerDenial(input, startupClock, true) === null;
}

/** Use the same startup decision when the dashboard sends a message. */
export function remoteSendDenial(reason: string): string {
  return reason.replace(/remote starts/gi, match => match === "Remote starts" ? "Remote sends" : "remote sends")
    .replace("start an agent on another machine", "send to another machine");
}
