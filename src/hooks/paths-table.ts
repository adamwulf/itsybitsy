/**
 * Build the per-agent filesystem access table the PreToolUse hooks resolve
 * against. This is the hook-side counterpart of the kernel profile generator:
 * it feeds the SAME shared resolver (`prepareAccessTable` / `resolvePreparedAccess`
 * from src/sandbox.ts) the SAME table (`meta.paths` plus the spawn-keyed runtime
 * roots plus the tmux-socket deny), so the hook and the kernel agree on every
 * decision.
 *
 * THE INVARIANT (SPEC-PATH-ALLOWLIST.md §8): a MISSING `paths` block behaves
 * exactly like an EMPTY one — deny by default. `resolvePathsConfig(undefined)`
 * returns three empty lists, never a permissive wildcard, so an agent whose
 * `meta.json` carries no `paths` key can reach only the runtime roots (its
 * worktree, agent dir, git dir, repo-agents dir, project dir, scratchpad) and
 * nothing else.
 *
 * Kept deliberately light: it imports src/sandbox.ts and src/agent-types.ts
 * (both already in every hook's dependency graph) but NOT the heavy
 * src/ib-commands.ts. `resolveTmuxSocketDir` was moved into src/sandbox.ts for
 * exactly this reason.
 */

import { join, resolve } from "path";
import { realpathSync } from "fs";
import { userHome } from "../home";
import { encodeClaudeProjectPath } from "../auto-compact";
import { metaCanSpawnChildren, loadAgentType, type AgentType } from "../agent-types";
import {
  canonicalizeSandboxPath,
  prepareAccessTable,
  resolvePathsConfig,
  resolveTmuxSocketDir,
  sandboxPathAccessTable,
  type OrderedPathEntry,
  type PathAccessTable,
  type PathOperation,
  type PathsConfig,
  type PreparedAccessTable,
  type SandboxProfileParams,
} from "../sandbox";

/**
 * Compute the fully-resolved absolute path to an agent's Claude project
 * directory (`~/.claude/projects/<encoded-worktree>`). The directory may not
 * exist yet — in that case we fall back to the resolve() result so the match
 * against realpath'd inbound file paths still works once it's created.
 *
 * Lives here (rather than in agent-path.ts) so paths-table.ts has no import
 * cycle with agent-path.ts; agent-path.ts re-exports it for existing callers.
 */
export function claudeProjectDirFor(worktreePath: string): string {
  const encoded = encodeClaudeProjectPath(worktreePath);
  let projectDir = resolve(join(userHome(), ".claude", "projects", encoded));
  try {
    projectDir = realpathSync(projectDir);
  } catch {
    // Directory doesn't exist yet — keep the resolve() result
  }
  return projectDir;
}

/**
 * The scratchpad root Claude Code hands each session:
 * `/private/tmp/claude-<uid>/<encodeClaudeProjectPath(worktree)>` (one level
 * above the session id, so a respawned session is still covered).
 *
 * NOTE: this layout was OBSERVED from live Claude Code sessions, not documented
 * in the repo. It MUST be re-checked if Claude Code changes where it puts the
 * scratchpad — see SPEC-PATH-ALLOWLIST.md §6.10 answer (a).
 */
export function claudeScratchpadDirFor(worktreePath: string, uid: number): string {
  const encoded = encodeClaudeProjectPath(worktreePath);
  return canonicalizeSandboxPath(`/private/tmp/claude-${uid}/${encoded}`);
}

/** The inputs the sync table builder needs, all pre-resolved by the caller. */
export interface AgentAccessTableParams {
  paths: PathsConfig;
  agentDir: string;
  worktreePath: string;
  agentsDir: string;
  rootRepo: string;
  /** The git common dir (resolved via `git rev-parse --git-common-dir`). */
  gitDir: string;
  /** The tmux socket DIRECTORY (resolveTmuxSocketDir) — a deny root for non-spawners. */
  tmuxSock: string;
  canSpawnChildren: boolean;
  home?: string;
}

/**
 * Build the RAW (unsorted) PathAccessTable for an agent from its resolved
 * `paths` plus the runtime roots. Synchronous and pure so both the async
 * `buildAgentAccessTable` and the unit tests can drive it with explicit params.
 *
 * The runtime roots come from `sandboxPathAccessTable` (AGENTDIR, WORKTREE,
 * GITDIR, REPOAGENTS — spawn-keyed — and PARENTCLAUDE for spawners, plus the
 * tmux deny for non-spawners); the Claude project dir and scratchpad are
 * appended as additional WRITE runtime allow roots. This matches what the kernel
 * profile grants (worker 1 passes PROJECTDIR/SCRATCHPAD through
 * SandboxProfileParams; the hook computes the same values from the worktree).
 */
export function agentPathAccessTable(p: AgentAccessTableParams): PathAccessTable {
  const params: SandboxProfileParams = {
    AGENTDIR: p.agentDir,
    WORKTREE: p.worktreePath,
    GITDIR: p.gitDir,
    REPOAGENTS: p.agentsDir,
    PARENTCLAUDE: join(p.rootRepo, ".claude"),
    TMUXSOCK: p.tmuxSock,
    canSpawnChildren: p.canSpawnChildren,
    HOME: p.home,
  };
  const table = sandboxPathAccessTable(p.paths, params);
  const uid = process.getuid?.() ?? 0;
  table.runtimeRoots.push(
    { path: canonicalizeSandboxPath(claudeProjectDirFor(p.worktreePath)), op: "write" },
    { path: claudeScratchpadDirFor(p.worktreePath, uid), op: "write" },
  );
  return table;
}

/**
 * Resolve the git common dir the way the kernel profile does (SPEC §8): run
 * `git rev-parse --git-common-dir` in the worktree and resolve a relative
 * answer against the worktree, canonicalized (longest-existing-prefix). Falls
 * back to `<rootRepo>/.git` (or `<worktree>/.git` when rootRepo is unknown) when
 * git fails, so the git dir is always a concrete deny-agnostic write root.
 */
async function resolveGitCommonDir(worktreePath: string, rootRepo: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", worktreePath, "rev-parse", "--git-common-dir"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) {
      const trimmed = out.trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (trimmed) {
        const abs = trimmed.startsWith("/") ? trimmed : resolve(worktreePath, trimmed);
        return canonicalizeSandboxPath(abs);
      }
    }
  } catch { /* fall through to the fallback */ }
  return canonicalizeSandboxPath(join(rootRepo || worktreePath, ".git"));
}

/**
 * Build (and prepare) the access table for a normal worktree agent from its
 * `meta.json`. A missing `paths` key resolves to three EMPTY lists — deny by
 * default, never permissive (the invariant). `canSpawnChildren` is resolved
 * from the meta via the single source of truth `metaCanSpawnChildren`, so the
 * REPOAGENTS write root, the PARENTCLAUDE root and the tmux deny match the
 * kernel exactly.
 */
export async function buildAgentAccessTable(input: {
  meta: Record<string, unknown>;
  agentDir: string;
  worktreePath: string;
  agentsDir: string;
  rootRepo: string;
  home?: string;
}): Promise<PreparedAccessTable> {
  const paths = resolvePathsConfig(input.meta.paths as PathsConfig | undefined);
  const gitDir = await resolveGitCommonDir(input.worktreePath, input.rootRepo);
  const uid = process.getuid?.() ?? 0;
  const table = agentPathAccessTable({
    paths,
    agentDir: input.agentDir,
    worktreePath: input.worktreePath,
    agentsDir: input.agentsDir,
    rootRepo: input.rootRepo,
    gitDir,
    tmuxSock: resolveTmuxSocketDir(uid),
    canSpawnChildren: await metaCanSpawnChildren(input.meta),
    home: input.home ?? userHome(),
  });
  return prepareAccessTable(table);
}

/**
 * Union the `paths` blocks of a set of agent-type layers, mirroring the paths
 * half of `mergeSandboxLayerConfigs` (kept out of the hook so it does not import
 * the heavy ib-commands module). Layers without a `paths` block contribute
 * nothing; the result is always three lists (empty when no layer defines any),
 * never permissive.
 */
function unionLayerPaths(layers: Array<AgentType | undefined>): PathsConfig {
  const defined = layers
    .map((layer) => layer?.paths)
    .filter((value): value is PathsConfig => value !== undefined);
  return resolvePathsConfig({
    allowRead: [...new Set(defined.flatMap((c) => c.allowRead))],
    allowWrite: [...new Set(defined.flatMap((c) => c.allowWrite))],
    deny: [...new Set(defined.flatMap((c) => c.deny))],
  });
}

/**
 * Build (and prepare) the access table for the `@system` coordinator, which has
 * no `meta.json`. Its lists come from `_all.md` ∪ `system.md`, resolved live at
 * hook time (the agent-types dir is read-only in the floor). Everything is
 * rooted at `<home>/.itsybitsy`. If a layer fails to load the table is empty
 * lists plus the runtime roots — strict, NEVER permissive.
 */
export async function buildSystemAccessTable(home: string): Promise<PreparedAccessTable> {
  const itsyHome = join(home, ".itsybitsy");
  let paths: PathsConfig = { allowRead: [], allowWrite: [], deny: [] };
  const [allLayer, systemLayer] = await Promise.all([
    loadAgentType("_all").catch(() => undefined),
    loadAgentType("system").catch(() => undefined),
  ]);
  paths = unionLayerPaths([allLayer, systemLayer]);

  const uid = process.getuid?.() ?? 0;
  const table = agentPathAccessTable({
    paths,
    agentDir: itsyHome,
    worktreePath: itsyHome,
    agentsDir: join(itsyHome, "agents"),
    rootRepo: itsyHome,
    gitDir: itsyHome,
    tmuxSock: resolveTmuxSocketDir(uid),
    canSpawnChildren: true,
    home,
  });
  return prepareAccessTable(table);
}

// ── Denial-reason classification (message only) ──────────────────────────────

/**
 * Does an ordered entry match a canonical absolute path? Mirrors the private
 * `orderedEntryMatches` in src/sandbox.ts. Used ONLY to word the denial reason —
 * the allow/deny decision itself always comes from `resolvePreparedAccess`, so a
 * drift here can never change a decision, only the explanation.
 */
function entryMatches(entry: OrderedPathEntry, absolutePath: string): boolean {
  if (entry.compiled.kind === "glob") {
    const regex = entry.regex ?? new RegExp(entry.compiled.value);
    return regex.test(absolutePath);
  }
  const value = entry.compiled.value;
  if (value === "/") return absolutePath.startsWith("/");
  return absolutePath === value || absolutePath.startsWith(`${value}/`);
}

/**
 * Word the denial reason for a path the resolver rejected: name the operation,
 * the resolved path, and WHY — a `paths.deny` hit versus no matching allow
 * entry. Reads well in the Denials tab of `ib watch`.
 */
export function pathDenialReason(
  prepared: PreparedAccessTable,
  absolutePath: string,
  op: PathOperation,
): string {
  const canonical = canonicalizeSandboxPath(absolutePath);
  if (prepared.deny.some((entry) => entryMatches(entry, canonical))) {
    return `Access denied: ${op} ${canonical} matches a paths.deny entry`;
  }
  return `Access denied: ${op} ${canonical} is not in paths.allowRead/allowWrite`;
}
