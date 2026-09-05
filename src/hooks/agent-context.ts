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

import { join } from "path";
import { realpath } from "fs/promises";

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
      ["git", "-C", worktreePath, "worktree", "list", "--porcelain"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) {
      const m = out.match(/^worktree (.+)$/m);
      if (m) rootRepo = m[1]!;
    }
  } catch { /* ignore */ }

  return { agentDir, agentsDir, worktreePath, rootRepo, agentType, meta };
}
