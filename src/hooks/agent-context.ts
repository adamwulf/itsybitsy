/**
 * Shared agent-context resolution for the codex and agy PreToolUse/state hooks.
 *
 * Both CLIs run their hooks in an unpredictable environment and pass the agent
 * id on argv rather than deriving it from cwd. This helper resolves the agent
 * directory, worktree, agents dir, root repo, and agent type from that id (and
 * the process cwd), canonicalizing paths with realpath so the different hook
 * events agree on path identity (which matters for the per-agent meta lock).
 *
 * Extracted verbatim from codex-pre-tool-use.ts so agy hooks can reuse it
 * without copy-paste; codex behaviour is byte-identical.
 */

import { isAbsolute, join, resolve } from "path";
import { realpath } from "fs/promises";
import { userInfo } from "os";
import { isValidAgentId } from "../validation";
import { resolveNoWorktreeCaller, type NoWorktreeCaller } from "../no-worktree-caller";

export interface FindNoWorktreeAgentsDirDeps {
  /** OS-account home containing .itsybitsy/repos.json; test-only override. */
  registryHome?: string;
}

export type NoWorktreeRepoRootsLoader = () => Promise<string[]>;
let noWorktreeRepoRootsLoaderOverride: NoWorktreeRepoRootsLoader | null = null;

/** Test seam for handlers that call the shared resolver without dependency args. */
export function setNoWorktreeRepoRootsLoader(loader: NoWorktreeRepoRootsLoader): void {
  noWorktreeRepoRootsLoaderOverride = loader;
}

export function resetNoWorktreeRepoRootsLoader(): void {
  noWorktreeRepoRootsLoaderOverride = null;
}

export type BoundNoWorktreeCallerResolver = (cwd: string) => Promise<NoWorktreeCaller | null>;
let boundNoWorktreeCallerResolverOverride: BoundNoWorktreeCallerResolver | null = null;

export function setBoundNoWorktreeCallerResolver(resolver: BoundNoWorktreeCallerResolver): void {
  boundNoWorktreeCallerResolverOverride = resolver;
}

export function resetBoundNoWorktreeCallerResolver(): void {
  boundNoWorktreeCallerResolverOverride = null;
}

export interface RegisteredAgentContext {
  meta: Record<string, unknown>;
  agentDir: string;
  agentsDir: string;
  repoPath: string;
}

export interface BoundHookAgentContext extends RegisteredAgentContext {
  worktreePath: string;
}

async function registeredRepoRoots(registryHome: string): Promise<string[]> {
  const registryFile = Bun.file(join(registryHome, ".itsybitsy", "repos.json"));
  if (!(await registryFile.exists())) return [];

  let registry: unknown;
  try {
    registry = await registryFile.json();
  } catch {
    throw new Error("Cannot resolve no-worktree agent: invalid repository registry");
  }
  if (
    !registry ||
    typeof registry !== "object" ||
    !Array.isArray((registry as { repos?: unknown }).repos)
  ) {
    throw new Error("Cannot resolve no-worktree agent: invalid repository registry");
  }

  const roots = new Set<string>();
  for (const entry of (registry as { repos: unknown[] }).repos) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      !isAbsolute((entry as { path: string }).path)
    ) {
      throw new Error("Cannot resolve no-worktree agent: invalid registered repository path");
    }
    try {
      roots.add(await realpath((entry as { path: string }).path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...roots];
}

/**
 * Locate a worktree:false agent by explicit id under operator-registered repo
 * roots. Cwd and HOME are model-controlled and therefore supply no authority;
 * the optional registry-home dependency exists only for isolated tests.
 * Multiple matching records are ambiguous and fail closed.
 */
export async function resolveRegisteredAgentById(
  agentId: string,
  deps: FindNoWorktreeAgentsDirDeps = {},
): Promise<RegisteredAgentContext | null> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Cannot resolve registered agent: invalid id '${agentId}'`);
  }
  const matches: RegisteredAgentContext[] = [];
  const repoRoots = deps.registryHome !== undefined
    ? await registeredRepoRoots(deps.registryHome)
    : noWorktreeRepoRootsLoaderOverride !== null
      ? await noWorktreeRepoRootsLoaderOverride()
      : await registeredRepoRoots(userInfo().homedir);
  for (const rawRepoRoot of repoRoots) {
    if (!isAbsolute(rawRepoRoot)) {
      throw new Error("Cannot resolve no-worktree agent: invalid registered repository path");
    }
    let repoRoot: string;
    try {
      repoRoot = await realpath(rawRepoRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const candidateAgentsDir = join(repoRoot, ".ittybitty", "agents");
    const agentDir = join(candidateAgentsDir, agentId);
    const candidateMeta = Bun.file(join(agentDir, "meta.json"));
    try {
      if (!(await candidateMeta.exists())) continue;
      const meta = await candidateMeta.json();
      if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.id !== agentId) {
        throw new Error(`Cannot resolve no-worktree agent '${agentId}': invalid metadata`);
      }
      matches.push({
        meta: meta as Record<string, unknown>,
        agentDir,
        agentsDir: candidateAgentsDir,
        repoPath: repoRoot,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Cannot resolve no-worktree agent")) {
        throw error;
      }
      throw new Error(`Cannot resolve no-worktree agent '${agentId}': unreadable metadata`);
    }
  }

  if (matches.length > 1) {
    throw new Error(`Cannot resolve registered agent '${agentId}': ambiguous records`);
  }
  return matches[0] ?? null;
}

/** Backward-compatible narrow lookup used by worktree:false hook handlers. */
export async function findNoWorktreeAgentsDir(
  agentId: string,
  _cwd: string,
  deps: FindNoWorktreeAgentsDirDeps = {},
): Promise<string | null> {
  const context = await resolveRegisteredAgentById(agentId, deps);
  return context?.meta.worktree === false ? context.agentsDir : null;
}

/**
 * Authenticate an explicit hook agent id. Worktree agents are bound to their
 * canonical registered worktree cwd. Shared-repo agents are bound to the
 * recorded live Claude process ancestry, so agent A cannot invoke a hook as B.
 */
export async function resolveBoundHookAgent(
  agentId: string,
  cwd: string,
  deps: FindNoWorktreeAgentsDirDeps & {
    noWorktreeCallerResolver?: BoundNoWorktreeCallerResolver;
  } = {},
): Promise<BoundHookAgentContext> {
  const registered = await resolveRegisteredAgentById(agentId, deps);
  if (!registered) {
    throw new Error(`Cannot authenticate hook agent '${agentId}': no registered record`);
  }

  if (registered.meta.worktree === false) {
    const caller = await (
      deps.noWorktreeCallerResolver ??
      boundNoWorktreeCallerResolverOverride ??
      resolveNoWorktreeCaller
    )(cwd);
    if (!caller || caller.meta.id !== agentId) {
      throw new Error(`Cannot authenticate hook agent '${agentId}': process belongs to another agent`);
    }
    let callerDir: string;
    let registeredDir: string;
    try {
      callerDir = await realpath(caller.agentDir);
      registeredDir = await realpath(registered.agentDir);
    } catch {
      throw new Error(`Cannot authenticate hook agent '${agentId}': invalid shared-repo caller`);
    }
    if (
      callerDir !== registeredDir
    ) {
      throw new Error(`Cannot authenticate hook agent '${agentId}': process belongs to another agent`);
    }
    return { ...registered, worktreePath: registered.repoPath };
  }

  let worktreePath: string;
  let canonicalCwd: string;
  try {
    worktreePath = await realpath(join(registered.agentDir, "repo"));
    canonicalCwd = await realpath(cwd);
  } catch {
    throw new Error(`Cannot authenticate hook agent '${agentId}': invalid worktree context`);
  }
  if (canonicalCwd !== worktreePath && !canonicalCwd.startsWith(worktreePath + "/")) {
    throw new Error(`Cannot authenticate hook agent '${agentId}': cwd is outside its worktree`);
  }
  return { ...registered, worktreePath };
}

/**
 * Resolve just the (canonicalized) agent directory from an agent id + cwd.
 * Shared by the codex and agy state hooks (SessionStart / PreInvocation / Stop)
 * which only need the agent dir, not the full worktree/root-repo context.
 * Extracted verbatim from those handlers' identical local copies.
 */
export async function resolveAgentDir(
  agentId: string,
  cwd: string,
  override?: string,
): Promise<string> {
  if (override) return override;
  const m = cwd.match(/(.*\/\.ittybitty\/agents)/);
  const agentsDir = m ? m[1]! : join(process.cwd(), ".ittybitty", "agents");
  let dir = join(agentsDir, agentId);
  try {
    dir = await realpath(dir);
  } catch { /* directory may not exist yet, or was removed mid-hook */ }
  return dir;
}

export interface ResolvedAgentContext {
  agentDir: string;
  agentsDir: string;
  worktreePath: string;
  rootRepo: string;
  agentType?: string;
  /**
   * The parsed `meta.json` object, or `undefined` when it is missing or
   * unparseable. The codex and agy PreToolUse handlers build their access table
   * from `meta.paths` (via buildAgentAccessTable) and must DENY when it is
   * absent — the invariant (missing == deny), never a permissive fallback.
   */
  meta?: Record<string, unknown>;
}

/**
 * Resolve `agentDir`/`agentsDir`/`worktreePath` from the agent id. Mirrors the
 * resolution in hookCheckPath (agent-path.ts) but is scoped narrower — codex
 * and agy agents always have a worktree (neither runs for coordinators today)
 * so we don't need the @system branch here.
 */
export async function resolveAgentContext(
  agentId: string,
  cwd: string,
  agentDirOverride?: string,
): Promise<ResolvedAgentContext> {
  let agentDir: string;
  let agentsDir: string;
  if (agentDirOverride) {
    agentDir = agentDirOverride;
    agentsDir = join(agentDir, "..");
  } else {
    const cwdMatch = cwd.match(/(.*\/\.ittybitty\/agents)/);
    agentsDir = cwdMatch ? cwdMatch[1]! : join(process.cwd(), ".ittybitty", "agents");
    agentDir = join(agentsDir, agentId);
  }

  // Canonicalize agentDir so PreToolUse + the state hooks agree on path identity
  // (matters for the per-agent .meta.lock — different forms = different lock
  // files = no mutual exclusion).
  try {
    agentDir = await realpath(agentDir);
  } catch { /* directory may not exist yet (transient) */ }

  let worktreePath = join(agentDir, "repo");
  try {
    worktreePath = await realpath(worktreePath);
  } catch {
    // worktree directory may not exist (transient); fall through
  }

  let agentType: string | undefined;
  let meta: Record<string, unknown> | undefined;
  try {
    const metaFile = Bun.file(join(agentDir, "meta.json"));
    if (await metaFile.exists()) {
      const parsed = await metaFile.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
        if (typeof meta.agentType === "string") agentType = meta.agentType;
      }
    }
  } catch { /* ignore — meta stays undefined, handlers deny on missing meta */ }

  let rootRepo = "";
  try {
    const proc = Bun.spawn(
      ["git", "worktree", "list", "--porcelain"],
      { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) {
      const m = out.match(/^worktree (.+)$/m);
      if (m) rootRepo = m[1]!;
    }
  } catch { /* ignore */ }

  return { agentDir, agentsDir, worktreePath, rootRepo, agentType, meta };
}
