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
 * - `-C <path>` or `-C<path>`: only in the global position (before the subcommand).
 *   `-C` is also a valid subcommand flag (e.g., `git commit -C HEAD`,
 *   `git diff -C`), so we walk tokens to distinguish global vs subcommand position.
 * - `--git-dir[= ]<path>`: always a global flag.
 * - `--work-tree[= ]<path>`: always a global flag.
 */
export function checkGitDirectoryFlags(command: string): string | null {
  if (!/^git\s/.test(command)) return null;

  // --git-dir and --work-tree are always global flags, safe to match anywhere.
  if (/\s--git-dir[\s=]/.test(command)) return "--git-dir";
  if (/\s--work-tree[\s=]/.test(command)) return "--work-tree";

  // For -C, walk tokens after "git" to find it in the global flag position.
  // Global flags come before the subcommand (first non-flag token).
  // Once we see a non-flag token, any subsequent -C is a subcommand flag.
  const tokens = command.split(/\s+/);
  // tokens[0] is "git"
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    // -C with attached path (e.g., "-C/other/repo")
    if (token === "-C" || token.startsWith("-C")) {
      return "-C";
    }
    // Skip other global flags (tokens starting with -)
    // Also skip values of long flags like --no-pager (no value) vs --git-dir=x (handled above)
    if (token.startsWith("-")) {
      continue;
    }
    // First non-flag token is the subcommand — stop scanning for global -C
    break;
  }

  return null;
}
