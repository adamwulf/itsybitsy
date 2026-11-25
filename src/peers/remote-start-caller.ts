import type { RemoteLifecycleAction } from "./remote-lifecycle";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_PID_START_MARGIN_SECONDS } from "../agents";
import { coordinatorSenderPanePid } from "../coordinator";
import { resolveDashboardCaller } from "../no-worktree-caller";

interface DashboardCaller {
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  hasControllingTerminal?: () => Promise<boolean>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  pid: number;
  readProcessTable?(command: [string, ...string[]], signal: AbortSignal): Promise<string>;
  resolveCaller: typeof resolveDashboardCaller;
}

const execFileAsync = promisify(execFile);
const TMUX_START_DENIAL = "Remote starts are disabled inside tmux";
export const TMUX_SEND_DENIAL = "Remote sends from a human are disabled inside tmux; run ib send from a terminal outside tmux";

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

async function hasControllingTerminal(): Promise<boolean> {
  try {
    const tty = await open("/dev/tty", constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
    await tty.close();
    return true;
  } catch { return false; }
}

async function classifyCaller(signal: AbortSignal, input: DashboardCaller | undefined, mode: "start" | "remote-send" | "local-send"): Promise<string | null> {
  const unverified = "Cannot verify the dashboard caller’s agent metadata for remote starts";
  try {
    const { stdinTTY, stdoutTTY, stderrTTY, hasControllingTerminal: controllingTTY, env, cwd, resolveCaller, pid, readProcessTable: readTable = readProcessTable } = input ?? {
      stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, stderrTTY: process.stderr.isTTY,
      hasControllingTerminal, env: process.env,
      cwd: process.cwd(), pid: process.pid, readProcessTable, resolveCaller: resolveDashboardCaller,
    };
    const humanSend = mode !== "start";
    const interactive = humanSend ? stdoutTTY === true || stderrTTY === true || await controllingTTY?.() : stdinTTY === true && stdoutTTY === true;
    if (!interactive) return "Remote starts require an interactive terminal";
    if (mode !== "local-send" && env.TMUX !== undefined) return mode === "start" ? TMUX_START_DENIAL : TMUX_SEND_DENIAL;
    const ancestors = await readAncestors(pid, readTable, signal);
    if (!ancestors) return "Cannot verify dashboard process ancestry for remote starts";
    for (const { names } of ancestors.values()) {
      const agent = names.find(name => ["claude", "codex", "agy"].includes(name.toLowerCase()));
      if (agent) return `Remote starts are disabled under ${agent}`;
    }
    // Verify shared-repo PID epochs against this same snapshot, without
    // running the ordinary caller resolver's synchronous ps probes.
    const caller = await resolveCaller(cwd, new Set(ancestors.keys()), {
      ...(humanSend && { humanSend }),
      ...(mode === "local-send" && { localCheckout: true }),
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
async function terminalCallerDenial(input: DashboardCaller | undefined, clock: typeof startupClock, mode: "start" | "remote-send" | "local-send"): Promise<string | null> {
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
    const result = await Promise.race([expired.promise, classifyCaller(controller.signal, input, mode)]);
    return clock.now() >= deadline ? timeout : result;
  } finally {
    cancelTimer();
  }
}

export function remoteStartDenialAtStartup(input?: DashboardCaller, clock = startupClock): Promise<string | null> {
  return terminalCallerDenial(input, clock, "start");
}

export function humanSendTerminalDenial(input?: DashboardCaller, mode: "remote-send" | "local-send" = "remote-send"): Promise<string | null> {
  return terminalCallerDenial(input, startupClock, mode);
}

/** A cwd under the coordinator home identifies @system only inside its live pane's process tree. */
export async function isSystemPaneCaller(
  pid = process.pid,
  readPane = coordinatorSenderPanePid,
  readTable = readProcessTable,
): Promise<boolean> {
  const signal = AbortSignal.timeout(2000);
  try {
    const pane = await readPane();
    if (pane === null || signal.aborted) return false;
    const ancestors = await readAncestors(pid, readTable, signal);
    return !signal.aborted && ancestors?.has(pane) === true;
  } catch { return false; }
}

/** Check the named CLI and its recorded agent ancestor in one process snapshot.
 * This verifies the named process tree, not the writer of a broker record. */
export async function isAgentSendProcess(
  origin: { pid: number; start: number | null }, meta: { claude_pid: string; claude_pid_epoch?: number },
  readTable = readProcessTable,
): Promise<boolean> {
  const agent = Number(meta.claude_pid);
  if (!Number.isSafeInteger(agent) || agent <= 1 || agent === origin.pid || !meta.claude_pid_epoch || origin.start === null) return false;
  const signal = AbortSignal.timeout(2000);
  const ancestors = await readAncestors(origin.pid, readTable, signal);
  const cli = ancestors?.get(origin.pid), parent = ancestors?.get(agent);
  return !signal.aborted && !!cli && !!parent && Date.parse(cli.started) / 1000 === origin.start &&
    Math.abs(Date.parse(parent.started) / 1000 - meta.claude_pid_epoch) <= CLAUDE_PID_START_MARGIN_SECONDS;
}

/** Use the same startup decision when the dashboard sends a message. */
export function remoteSendDenial(reason: string): string {
  if (reason === TMUX_START_DENIAL) return "Remote sends are disabled while ib watch runs inside tmux; restart ib watch from a terminal outside tmux";
  return reason.replace(/remote starts/gi, match => match === "Remote starts" ? "Remote sends" : "remote sends")
    .replace("start an agent on another machine", "send to another machine");
}

/** The startup decision worded for remote terminals (SPEC §20.4 "Remote terminal"). */
export function remoteTerminalDenial(reason: string): string {
  if (reason === TMUX_START_DENIAL) return "Remote terminals are disabled while ib watch runs inside tmux; restart ib watch from a terminal outside tmux";
  return reason.replace(/remote starts/gi, match => match === "Remote starts" ? "Remote terminals" : "remote terminals")
    .replace("start an agent on another machine", "open a terminal on another machine");
}

/** The startup decision worded for `b` on a remote agent (SPEC §20.4 "Remote permissions"). */
export function remotePermissionDenial(reason: string): string {
  if (reason === TMUX_START_DENIAL) return "Remote permission changes are disabled while ib watch runs inside tmux; restart ib watch from a terminal outside tmux";
  return reason.replace(/remote starts/gi, match => match === "Remote starts" ? "Remote permission changes" : "remote permission changes")
    .replace("start an agent on another machine", "change an agent's permissions on another machine");
}

export function remoteLifecycleDenial(reason: string, action: RemoteLifecycleAction | "acknowledge"): string {
  if (reason === TMUX_START_DENIAL) return `Remote ${action} is disabled inside tmux. Use a terminal outside tmux.`;
  return reason.replace("Remote starts are", `Remote ${action} is`)
    .replace("Remote starts require", `Remote ${action} requires`)
    .replace("remote starts are", `remote ${action} is`)
    .replace("remote starts", `remote ${action}`)
    .replace("start an agent on another machine", `${action} an agent on another machine`);
}
