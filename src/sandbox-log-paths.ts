import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { sealDir } from "./agent-seal";

/** The shipped floor denies sealed/ even when an agent can write AGENTDIR.
 * Bind each parent's artifact namespace to the agent directory, without trusting
 * an agent-controlled filename or exporting a writable control channel to it.
 */
export function sandboxLogParent(agentDir: string, home?: string): string {
  const key = createHash("sha256").update(resolve(agentDir)).digest("hex");
  return join(sealDir(home), "sandbox-logs", key);
}
