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

export interface ResolvedAgentContext {
  agentDir: string;
  agentsDir: string;
  worktreePath: string;
  rootRepo: string;
  agentType?: string;
  /**
   * `meta.allowedPaths`, when the agent type declares extra writable roots
   * (read from the same meta.json parse as `agentType`). Codex ignores this
   * field; the agy PreToolUse handler uses it to widen the forced path
   * isolation (worktree + the type's allowedPaths).
   */
  allowedPaths?: string[];
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
  let allowedPaths: string[] | undefined;
  try {
    const metaFile = Bun.file(join(agentDir, "meta.json"));
    if (await metaFile.exists()) {
      const meta = await metaFile.json();
      if (typeof meta.agentType === "string") agentType = meta.agentType;
      if (Array.isArray(meta.allowedPaths)) {
        allowedPaths = (meta.allowedPaths as unknown[]).filter(
          (p): p is string => typeof p === "string",
        );
      }
    }
  } catch { /* ignore */ }

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

  return { agentDir, agentsDir, worktreePath, rootRepo, agentType, allowedPaths };
}
