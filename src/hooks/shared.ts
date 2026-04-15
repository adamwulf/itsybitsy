/**
 * Shared constants and patterns used across hook implementations.
 */

/**
 * Matches agent worktree paths: .ittybitty/agents/<agentId>/repo
 * Capturing group 1 contains the agent ID.
 */
export const AGENT_CWD_PATTERN = /\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/;

/**
 * Check if a git command uses directory-changing flags that bypass path isolation.
 * Returns the blocked flag name if found, or null if the command is clean.
 *
 * Blocked flags:
 * - `-C <path>`: must appear immediately after `git` (before the subcommand).
 *   Note: `-C` is also a valid subcommand flag (e.g., `git commit -C HEAD`,
 *   `git diff -C`), so we only match it in the global position.
 * - `--git-dir[= ]<path>`: always a global flag.
 * - `--work-tree[= ]<path>`: always a global flag.
 */
export function checkGitDirectoryFlags(command: string): string | null {
  if (!/^git\s/.test(command)) return null;

  // -C must appear right after "git" (possibly after other global flags) but
  // before the subcommand. The simplest correct check: -C immediately after "git ".
  if (/^git\s+-C\s/.test(command)) return "-C";
  if (/\s--git-dir[\s=]/.test(command)) return "--git-dir";
  if (/\s--work-tree[\s=]/.test(command)) return "--work-tree";

  return null;
}
