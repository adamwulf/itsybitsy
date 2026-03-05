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

/** Pluggable runner — defaults to Bun.$, overridable for tests */
export type IbRunner = (args: string[], cwd: string) => Promise<IbCommandResult>;

const defaultRunner: IbRunner = async (args, cwd) => {
  const result = await Bun.$`ib ${args}`.cwd(cwd).nothrow().quiet();
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout,
    stderr,
  };
};

let currentRunner: IbRunner = defaultRunner;

/** Override the runner (for testing) */
export function setRunner(runner: IbRunner) {
  currentRunner = runner;
}

/** Reset to the default Bun.$ runner */
export function resetRunner() {
  currentRunner = defaultRunner;
}

async function runIb(args: string[], cwd: string): Promise<IbCommandResult> {
  return currentRunner(args, cwd);
}

export async function killAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["kill", agent.id], agent.repoPath);
}

export async function nukeAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["kill", agent.id, "--force"], agent.repoPath);
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
  worker?: boolean;
  yolo?: boolean;
  model?: string;
}

export async function newAgent(
  repoPath: string,
  prompt: string,
  opts?: NewAgentOptions
): Promise<IbCommandResult> {
  const args = ["new-agent"];
  if (opts?.worker) args.push("--worker");
  if (opts?.yolo) args.push("--yolo");
  if (opts?.model) args.push("--model", opts.model);
  args.push(prompt);
  return runIb(args, repoPath);
}

export async function diffAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["diff", agent.id], agent.repoPath);
}

export async function statusAgent(agent: Agent): Promise<IbCommandResult> {
  return runIb(["status", agent.id], agent.repoPath);
}
