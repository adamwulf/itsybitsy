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
  //
  // Some global flags consume the next token as their value (e.g., -c key=val).
  // We must skip those value tokens so they aren't mistaken for the subcommand.
  const tokens = command.split(/\s+/);
  // tokens[0] is "git"
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    // -C with attached path (e.g., "-C/other/repo") or standalone -C
    if (token === "-C" || token.startsWith("-C")) {
      return "-C";
    }
    // Git global short flags that consume the next token as a value.
    // Must skip the value so it isn't mistaken for the subcommand.
    if (token === "-c") {
      i += 2; // skip -c and its value
      continue;
    }
    // Long flags with = (e.g., --namespace=foo) are one token starting with -
    // Long flags with space value (e.g., --namespace foo) — these are already
    // handled by --git-dir/--work-tree regex above. For other long flags with
    // values (--namespace, --config-env, --super-prefix), their values don't
    // start with - so they'd cause a false break. But these are obscure global
    // flags unlikely to appear in agent commands, and a false break just means
    // we stop scanning early — erring on the side of allowing (not blocking).
    if (token.startsWith("-")) {
      i++;
      continue;
    }
    // First non-flag token is the subcommand — stop scanning for global -C
    break;
  }

  return null;
}
