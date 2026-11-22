import { resolveCallerAgentContext } from "../ib-commands";

interface DashboardCaller {
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  resolveCaller: typeof resolveCallerAgentContext;
}

/** Evaluated once by launchDashboard. Only null enables outbound remote starts. */
export async function remoteStartDenialAtStartup(input?: DashboardCaller): Promise<string | null> {
  const unverified = "Cannot verify the dashboard caller for remote starts";
  try {
    const { stdinTTY, stdoutTTY, env, cwd, resolveCaller } = input ?? {
      stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env,
      cwd: process.cwd(), resolveCaller: resolveCallerAgentContext,
    };
    if (stdinTTY !== true || stdoutTTY !== true) return "Remote starts require an interactive terminal";
    if (env.TMUX !== undefined) return "Remote starts are disabled inside tmux";
    return await resolveCaller(cwd) === null ? null : "Only a human can start an agent on another machine";
  } catch {
    return unverified;
  }
}
