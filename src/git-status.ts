/**
 * Worktree cleanliness probe for the dashboard's "Git Status" stoplight
 * (SPEC §11.4).
 *
 * `checkWorktreeCleanliness(path)` answers one question about a git worktree:
 * does it hold uncommitted work? "Uncommitted" follows the same definition the
 * `ib new-agent` dirty-worktree gate uses — any line from
 * `git status --porcelain`, so staged, unstaged AND untracked files all count.
 *
 * Runs `--no-optional-locks` because this is a background poller: `git status`
 * otherwise refreshes the index and takes `index.lock`, which would contend
 * with the agent's own git commands in the same worktree.
 *
 * All subprocess calls go through `gitStatusSpawnCtx` so tests can inject a
 * fake runner. The global `bun test` preload (test-preload.ts) replaces its
 * reset baseline with the safe no-op stub, so a dashboard test that reaches
 * this probe never launches a real `git`.
 */

import { SpawnContext } from "./types";

/** Injectable spawn context for the git status probe. */
export const gitStatusSpawnCtx = new SpawnContext();

/**
 * Result of a cleanliness probe. `null` means "unknown": the path is not a git
 * worktree, does not exist, or git failed — the caller should show neither
 * clean nor dirty.
 */
export type WorktreeCleanliness = "clean" | "dirty" | null;

/**
 * Probe `cwd` for uncommitted work. Never throws — a missing directory (an
 * archived agent whose worktree is gone), a non-git directory, or a failing
 * `git` all resolve to `null`.
 */
export async function checkWorktreeCleanliness(cwd: string): Promise<WorktreeCleanliness> {
  try {
    const { stdout, exitCode } = await gitStatusSpawnCtx.run([
      "git", "-C", cwd, "--no-optional-locks", "status", "--porcelain",
    ]);
    if (exitCode !== 0) return null;
    return stdout === "" ? "clean" : "dirty";
  } catch {
    return null;
  }
}
