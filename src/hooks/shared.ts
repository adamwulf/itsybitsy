/**
 * Shared constants and patterns used across hook implementations.
 */

import { join } from "path";
import { homedir } from "os";
import { realpathSync } from "fs";
import { loadAgentType } from "../agent-types";

/**
 * Matches agent worktree paths: .ittybitty/agents/<agentId>/repo
 * Capturing group 1 contains the agent ID.
 */
export const AGENT_CWD_PATTERN = /\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/;

/**
 * Sentinel agent ID for the system coordinator. Not a valid agent ID per
 * `isValidAgentId()` (begins with `@`), but accepted as a hardcoded constant
 * by hook entry points so the system coordinator's hooks can identify
 * themselves.
 */
export const SYSTEM_AGENT_ID = "@system";

/**
 * Compute the system coordinator's home directory (`~/.itsybitsy/`).
 *
 * Inlined here (rather than importing `getCoordinatorHome` from `coordinator.ts`)
 * because `shared.ts` is loaded by every hook entry point, and pulling in
 * `coordinator.ts` would transitively load `tmux-poller`, `agents`, and other
 * heavyweight modules into hooks that don't need them.
 *
 * Honors the `HOME` env var (matching `coordinator.ts`'s `itsybitsyHome()`)
 * but does NOT honor the test-only `setCoordinatorHome` override — tests that
 * exercise hook code paths set `HOME` directly via the env var.
 */
function systemCoordinatorHome(): string {
  return join(process.env.HOME ?? homedir(), ".itsybitsy");
}

/**
 * Resolves the agent identity for a given cwd.
 *
 * Returns one of:
 * - `{ agentId: "@system", agentDir: <coordinator home>, syntheticMeta: {...} }`
 *   when cwd is inside the system coordinator's home directory.
 * - `{ agentId: <id>, agentDir: <repo>/.ittybitty/agents/<id> }` when cwd
 *   matches the agent worktree pattern. No `syntheticMeta` — callers should
 *   read the on-disk `meta.json` themselves.
 * - `null` for primary Claude / unrecognized cwds.
 *
 * Per-repo coordinators are intentionally NOT handled here — their existing
 * flow (cwd matches pattern, meta.json read from `<repo>/.ittybitty/agents/<basename>/`)
 * already works because per-repo coordinators ARE worktree agents. This
 * helper exists primarily to give the system coordinator (which lives outside
 * any repo) a uniform identity object so hook bodies don't need special-case
 * branching.
 */
export interface ResolvedAgent {
  agentId: string;
  agentDir: string;
  /**
   * Synthetic in-memory meta — only populated for `@system`, where no
   * meta.json exists on disk. Mirrors the meta fields hook bodies care about
   * (agentType, worker) so existing branches keep working.
   */
  syntheticMeta?: Record<string, unknown>;
}

export function resolveAgentFromCwd(cwd: string): ResolvedAgent | null {
  // Try the system coordinator first. The cwd is `~/.itsybitsy/` itself or
  // any subdirectory of it. Use realpath so symlinked HOME values match.
  const home = systemCoordinatorHome();
  let resolvedHome = home;
  try {
    resolvedHome = realpathSync(home);
  } catch { /* directory may not exist yet — fall through */ }

  let resolvedCwd = cwd;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch { /* cwd may not exist (unlikely from a hook) — fall through */ }

  if (resolvedCwd === resolvedHome || resolvedCwd.startsWith(resolvedHome + "/")) {
    return {
      agentId: SYSTEM_AGENT_ID,
      agentDir: resolvedHome,
      syntheticMeta: {
        agentType: "system",
        worker: false,
      },
    };
  }

  // Worktree agent
  const m = AGENT_CWD_PATTERN.exec(cwd);
  if (m) {
    const agentId = m[1]!;
    const ittybittyIdx = cwd.indexOf("/.ittybitty/agents/");
    const repoRoot = cwd.substring(0, ittybittyIdx);
    return {
      agentId,
      agentDir: join(repoRoot, ".ittybitty", "agents", agentId),
    };
  }

  return null;
}

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

// ── Codex hook helpers ───────────────────────────────────────────────────────

/**
 * Extract target file paths from an apply_patch tool_input.command body.
 *
 * Codex's apply_patch uses git-style markers:
 *   *** Begin Patch
 *   *** Add File: <path>
 *   *** Update File: <path>
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * Returns the list of paths in document order (duplicates preserved so callers
 * can report exactly what the patch targeted). Paths are returned verbatim —
 * the caller is responsible for resolving relative paths against cwd.
 */
export function extractApplyPatchPaths(patchBody: string): string[] {
  if (!patchBody) return [];
  const paths: string[] = [];
  const lines = patchBody.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/);
    if (m) paths.push(m[1]!);
  }
  return paths;
}

/**
 * Build the codex PreToolUse JSON contract for a "deny" decision.
 * Always includes `permissionDecisionReason` — omitting it triggers a separate
 * codex error path that fails open.
 */
export function buildCodexDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Build the codex PreToolUse JSON contract for an "allow" decision.
 * Pairs `permissionDecision: "allow"` with `updatedInput` echoing the original
 * tool_input verbatim — standalone allow triggers codex's "unsupported
 * permissionDecision:allow" path which is FAIL-OPEN. The echo-back rewrite is
 * the documented no-op allow form (Phase 2 spike B1).
 */
export function buildCodexAllowOutput(originalToolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: originalToolInput,
    },
  });
}

/**
 * Merged allow/deny permission lists for an agent, derived from the same
 * three-layer source as `buildAgentSettings()`:
 *   - `_all.md` — applied to every spawned agent
 *   - `_non_coordinator.md` — applied to non-coordinator agents only
 *   - `<type>.md` — per-type permissions
 *
 * Each layer is loaded defensively; a missing layer contributes nothing rather
 * than throwing. Allow + deny are deduplicated via Set.
 */
export async function loadMergedAgentTypePermissions(
  agentType: string | undefined,
): Promise<{ allow: string[]; deny: string[] }> {
  const allowSet = new Set<string>();
  const denySet = new Set<string>();

  async function addLayer(name: string): Promise<{ ok: boolean; isCoordinator: boolean }> {
    try {
      const layer = await loadAgentType(name);
      for (const a of layer.permissions?.allow ?? []) allowSet.add(a);
      for (const d of layer.permissions?.deny ?? []) denySet.add(d);
      return { ok: true, isCoordinator: layer.name === "coordinator" };
    } catch {
      return { ok: false, isCoordinator: false };
    }
  }

  await addLayer("_all");

  const isCoordinatorType = agentType === "coordinator" || agentType === "system";
  if (!isCoordinatorType) {
    await addLayer("_non_coordinator");
  }

  if (agentType) {
    await addLayer(agentType);
  }

  return { allow: [...allowSet], deny: [...denySet] };
}
