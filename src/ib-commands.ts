/**
 * Async wrappers for ib mutation commands.
 * Every command runs with cwd set to the agent's repoPath.
 */

import type { Agent } from "./agents";

export interface IbCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Pluggable runner — defaults to Bun.spawn, overridable for tests */
export type IbRunner = (args: string[], cwd: string) => Promise<IbCommandResult>;

const defaultRunner: IbRunner = async (args, cwd) => {
  const proc = Bun.spawn(["ib", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

let currentRunner: IbRunner = defaultRunner;

/** Override the runner (for testing) */
export function setRunner(runner: IbRunner) {
  currentRunner = runner;
}

/** Reset to the default Bun.spawn runner */
export function resetRunner() {
  currentRunner = defaultRunner;
}

async function runIb(args: string[], cwd: string): Promise<IbCommandResult> {
  return currentRunner(args, cwd);
}

export async function killAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["kill", agent.id, "--force"], agent.repoPath);
}

export async function nukeAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["nuke", agent.id, "--force"], agent.repoPath);
}

export async function resumeAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["resume", agent.id], agent.repoPath);
}

export async function reassignAgent(agent: Agent, newManager: string): Promise<IbCommandResult> {
  return runIb(["reassign", agent.id, newManager], agent.repoPath);
}

export async function mergeCheckAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["merge-check", agent.id], agent.repoPath);
}

export async function mergeAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["merge", agent.id, "--force"], agent.repoPath);
}

export async function sendMessage(agent: Agent, message: string): Promise<IbCommandResult> {
  return runIb(["send", agent.id, message], agent.repoPath);
}

export interface NewAgentOptions {
  name?: string;
  worker?: boolean;
  yolo?: boolean;
  model?: string;
  manager?: string;
}

export async function newAgent(
  repoPath: string,
  prompt: string,
  opts?: NewAgentOptions
): Promise<IbCommandResult> {
  const args = ["new-agent"];
  if (opts?.name) args.push("--name", opts.name);
  if (opts?.worker) args.push("--worker");
  if (opts?.yolo) args.push("--yolo");
  if (opts?.model) args.push("--model", opts.model);
  if (opts?.manager) args.push("--manager", opts.manager);
  args.push(prompt);
  return runIb(args, repoPath);
}

export async function diffAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["diff", agent.id], agent.repoPath);
}

export async function statusAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["status", agent.id], agent.repoPath);
}

export async function pauseAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["pause", agent.id], agent.repoPath);
}

export async function acknowledgeQuestion(repoPath: string, questionId: string): Promise<IbCommandResult> {
  return runIb(["acknowledge", questionId], repoPath);
}
