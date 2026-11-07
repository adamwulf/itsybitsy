/**
 * Test support: a throwaway git identity, so tests that make real commits pass
 * on a machine with no git identity and never read the developer's own git
 * config (signing, hooks, templates).
 *
 * Bun.spawn does not see runtime changes to process.env, so the identity is
 * passed to each child through `env` instead of being set on process.env.
 */

import { join } from "path";
import type { SpawnFn } from "./types";

export interface GitIdentity {
  /** process.env plus GIT_CONFIG_GLOBAL (the test config) and GIT_CONFIG_NOSYSTEM. */
  env: Record<string, string | undefined>;
  /** Runs a command with `env`. Set it on a SpawnContext such as createRepoSpawnCtx. */
  spawn: SpawnFn;
}

/** Write a git config with a test identity into `dir` and return its env and runner. */
export async function makeGitIdentity(dir: string): Promise<GitIdentity> {
  const configPath = join(dir, "test-gitconfig");
  await Bun.write(
    configPath,
    "[user]\n\tname = Test User\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n",
  );
  const env = { ...process.env, GIT_CONFIG_GLOBAL: configPath, GIT_CONFIG_NOSYSTEM: "1" };
  const spawn = ((cmd: string[], opts?: { stdout: "pipe"; stderr: "pipe" }) =>
    Bun.spawn(cmd, { ...opts, env })) as SpawnFn;
  return { env, spawn };
}
