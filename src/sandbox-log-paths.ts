import { createHash } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sealDir } from "./agent-seal";

/** The shipped floor denies sealed/ even when an agent can write AGENTDIR.
 * Bind each parent's artifact namespace to the agent directory, without trusting
 * an agent-controlled filename or exporting a writable control channel to it.
 */
export function sandboxLogParent(agentDir: string, home?: string): string {
  const key = createHash("sha256").update(resolve(agentDir)).digest("hex");
  return join(sealDir(home), "sandbox-logs", key);
}

/** The agent's tagged Seatbelt profile. Its attribution tag holds a secret
 * nonce, so it lives in the agent's sealed namespace: no sandboxed agent can read
 * it, while the unsandboxed launcher and `sandbox-exec` can. */
export function sandboxProfilePath(agentDir: string, home?: string): string {
  return join(sandboxLogParent(agentDir, home), "sandbox.sb");
}

/** Agent teardown: remove the profile, then its namespace directory once no
 * launch directory is left in it (a launch's supervisor removes its own).
 * Best effort: the tag belongs to no live launch any more, and a leftover file
 * must never fail a teardown. */
export function removeSandboxProfile(agentDir: string, home?: string): void {
  const profile = sandboxProfilePath(agentDir, home);
  try { rmSync(profile, { force: true }); } catch { /* unwritable here: leave it */ }
  try { rmdirSync(dirname(profile)); } catch { /* not empty, or already gone */ }
}
