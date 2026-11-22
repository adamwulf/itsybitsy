import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveCallerAgentContext } from "../ib-commands";
import { canonicalizeSandboxPath, resolveTmuxSocketDir } from "../sandbox";

interface DashboardCaller {
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  env: NodeJS.ProcessEnv;
  uid?: number;
  cwd: string;
  resolveCaller: typeof resolveCallerAgentContext;
}

/** Evaluated once by launchDashboard. Only null enables outbound remote starts. */
export async function remoteStartDenialAtStartup(input?: DashboardCaller): Promise<string | null> {
  const unverified = "Cannot verify the dashboard caller for remote starts";
  try {
    const { stdinTTY, stdoutTTY, env, uid, cwd, resolveCaller } = input ?? {
      stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env,
      uid: process.getuid?.(), cwd: process.cwd(), resolveCaller: resolveCallerAgentContext,
    };
    if (stdinTTY !== true || stdoutTTY !== true) return "Remote starts require an interactive terminal";
    if (env.TMUX !== undefined) {
      const socket = /^([^,]+),\d+,\d+$/.exec(env.TMUX)?.[1];
      if (!socket || !isAbsolute(socket) || uid === undefined || (env.TMUX_TMPDIR && !isAbsolute(env.TMUX_TMPDIR))) return unverified;
      // Derive the managed root without letting the current session choose it.
      const root = resolveTmuxSocketDir(uid, { TMUX_TMPDIR: env.TMUX_TMPDIR });
      const inManagedDir = (path: string) => path === root || path.startsWith(root + "/");
      if (inManagedDir(canonicalizeSandboxPath(socket)) || inManagedDir(realpathSync(socket))) {
        return "Remote starts are disabled in an itsybitsy tmux session";
      }
    }
    return await resolveCaller(cwd) === null ? null : "Only a human can start an agent on another machine";
  } catch {
    return unverified;
  }
}
