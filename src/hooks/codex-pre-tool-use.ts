/**
 * Codex PreToolUse hook handler — the deny-by-default gate for codex agents.
 *
 * Codex's hook contract is documented at developers.openai.com/codex/hooks
 * and verified empirically in the Phase 2 spike (CODEX-CLI-NOTES.md). The
 * load-bearing properties this file enforces:
 *
 *   1. Deny-by-default. Any tool call that doesn't match the merged allow
 *      list from the agent-type layers (_all.md / _non_coordinator.md /
 *      <type>.md) is denied.
 *   2. Path isolation. Bash commands are run through the existing
 *      checkPathAccess matcher; apply_patch's patch body is parsed for
 *      `*** Add/Update/Delete File:` directives and each target path is
 *      gated by the same matcher.
 *   3. Allow == echo-back. Per Phase 2 spike B1, codex rejects standalone
 *      permissionDecision:"allow" as "unsupported" and FAILS OPEN. The
 *      only documented allow form is `permissionDecision:"allow"` paired
 *      with `updatedInput` echoing the original tool_input.
 *   4. Fail-OPEN mitigation. Codex treats any crash / malformed JSON /
 *      unsupported decision / non-zero exit as "proceed with the call"
 *      (the opposite of fail-safe). This handler wraps every code path
 *      in try/catch, validates the agentId argv before any work, and
 *      always emits valid JSON + exits 0.
 *   5. Session id capture. The PreToolUse handler captures session_id (or
 *      sessionId, defensively) into meta.codex_session_id only if it's
 *      empty — Phase 7 resume support. The SessionStart handler is the
 *      primary capture point (it fires regardless of tool calls); this
 *      is the fallback for sessions where SessionStart somehow misses.
 */

import { join } from "path";
import { realpath } from "fs/promises";
import { isValidAgentId } from "../validation";
import { mutateAgentMeta } from "../agents";
import {
  buildCodexAllowOutput,
  buildCodexDenyOutput,
  extractApplyPatchPaths,
  loadMergedAgentTypePermissions,
} from "./shared";
import {
  checkPathAccess,
  type HookDecision,
  type PathCheckContext,
} from "./agent-path";

/** Read a value from data, accepting both snake_case and camelCase spellings. */
function readDefensive(
  data: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const k of keys) {
    if (k in data && data[k] !== undefined && data[k] !== null && data[k] !== "") {
      return data[k];
    }
  }
  return undefined;
}

/**
 * Pure decision function for the codex PreToolUse handler. Mirrors the layout
 * of checkPathAccess but is split so the io-free portion can be unit-tested.
 *
 * Inputs:
 *   - toolName/toolInput/cwd — from codex's stdin payload
 *   - allowList — merged allow patterns from the agent-type layers
 *   - ctx — the same PathCheckContext the claude-side hook uses
 *
 * Behavior:
 *   - Bash: defer entirely to checkPathAccess (handles cd, shell-path parser,
 *     ib subcommand restrictions).
 *   - apply_patch: parse every target path from the patch body; deny if any
 *     extracted path resolves outside the worktree (or fails the allow list).
 *     A patch with no extractable paths is denied (an apply_patch with no
 *     targets is either malformed or a probe — neither belongs in production).
 *   - Other tools: delegate to checkPathAccess.
 *
 * Returns the same { decision, reason } shape as checkPathAccess.
 */
export function checkCodexPreToolUse(
  input: { toolName: string; toolInput: Record<string, unknown>; cwd: string },
  ctx: PathCheckContext,
): HookDecision {
  const { toolName, toolInput, cwd } = input;

  if (toolName === "apply_patch") {
    const patchBody = String(toolInput.command ?? "");
    const targets = extractApplyPatchPaths(patchBody);
    if (targets.length === 0) {
      return {
        decision: "deny",
        reason: "apply_patch payload contained no Add/Update/Delete File directives",
      };
    }
    // SPEC §3.2: codex's `-s workspace-write` sandbox leaks /tmp, $TMPDIR, and
    // ~/.codex/memories. Per SPEC we MUST do path-isolation in the hook and
    // MUST NOT fall through to checkPathAccess's legacy permissive branch
    // (step 13). Force step 12 to fire by passing an explicit `allowedPaths`
    // that contains only the worktree (plus any agent-configured extras).
    // Worktree-internal paths still allow via step 7 BEFORE step 12 is checked.
    // apply_patch's "allow list" is path-only by intent: see SPEC §5.5 — apply_patch
    // is codex's equivalent of claude's Write+Edit, gated on path not tool-allow.
    const apEffectiveAllowedPaths =
      ctx.allowedPaths !== undefined ? ctx.allowedPaths : [ctx.worktreePath];
    for (const target of targets) {
      const synthesized = {
        toolName: "Write",
        toolInput: { file_path: target },
        cwd,
      };
      const decision = checkPathAccess(synthesized, {
        ...ctx,
        allowList: ["Write", ...ctx.allowList],
        allowedPaths: apEffectiveAllowedPaths,
      });
      if (decision.decision === "deny") {
        return {
          decision: "deny",
          reason: `apply_patch target rejected (${target}): ${decision.reason}`,
        };
      }
    }
    return { decision: "allow", reason: "apply_patch targets in worktree" };
  }

  return checkPathAccess({ toolName, toolInput, cwd }, ctx);
}

/**
 * Persist the codex session id into meta.codex_session_id if it is currently
 * empty. Idempotent: an already-set field is left untouched (the first hook
 * firing wins). Best-effort — any I/O error is swallowed because a hook MUST
 * NOT crash (codex would fail open).
 */
export async function captureCodexSessionId(
  agentDir: string,
  sessionId: string,
): Promise<boolean> {
  if (!sessionId) return false;
  return mutateAgentMeta(agentDir, (meta) => {
    if (typeof meta.codex_session_id === "string" && (meta.codex_session_id as string).length > 0) {
      return null;
    }
    meta.codex_session_id = sessionId;
  });
}

interface DispatcherDeps {
  /** Override stdin read; tests inject a synchronous string. */
  rawStdin?: string;
  /** Override the resolved agent dir (rarely used; agents.ts already resolves it). */
  agentDirOverride?: string;
  /** Disable the on-disk side-effects (session-id capture) — tests with no fs. */
  skipSessionIdCapture?: boolean;
}

/**
 * Resolve `agentDir`/`agentsDir`/`worktreePath` from the agent id. Mirrors
 * the resolution in hookCheckPath (agent-path.ts) but is scoped narrower —
 * codex agents always have a worktree (codex doesn't run for coordinators
 * today; see SPEC §5.4) so we don't need the @system branch here.
 */
async function resolveAgentContext(
  agentId: string,
  cwd: string,
  agentDirOverride?: string,
): Promise<{
  agentDir: string;
  agentsDir: string;
  worktreePath: string;
  rootRepo: string;
  agentType?: string;
}> {
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

  // Canonicalize agentDir so PreToolUse + SessionStart agree on path identity
  // (matters for the per-agent .meta.lock — different forms = different lock
  // files = no mutual exclusion). resolveAgentDir in codex-session-start.ts
  // does the same realpath.
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
  try {
    const metaFile = Bun.file(join(agentDir, "meta.json"));
    if (await metaFile.exists()) {
      const meta = await metaFile.json();
      if (typeof meta.agentType === "string") agentType = meta.agentType;
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

  return { agentDir, agentsDir, worktreePath, rootRepo, agentType };
}

/**
 * CLI entry: `ib hooks codex-pre-tool-use <agentId> [--dry-run]`. Always
 * emits valid JSON to stdout and always exits 0, even on error — codex's
 * documented hook failure mode is FAIL-OPEN so any unhandled exception
 * would mean the tool call PROCEEDS.
 *
 * `--dry-run` is the spawn-time precheck path (SPEC §5.4 step 7 / §5.5
 * fail-open hardening): verify the dispatcher resolves and meta.json
 * exists, then exit 0 WITHOUT reading stdin. Used by the Phase 4 spawn
 * code to refuse the launch if our handler can't be invoked.
 */
export async function hookCodexPreToolUse(
  agentId: string,
  deps?: DispatcherDeps,
): Promise<void> {
  // Wrap EVERYTHING in try/catch — any uncaught error in codex fails open.
  try {
    if (!isValidAgentId(agentId)) {
      process.stdout.write(buildCodexDenyOutput("Invalid agent id passed to codex-pre-tool-use"));
      return;
    }

    const rawStdin =
      deps?.rawStdin ?? (await new Response(Bun.stdin.stream()).text());
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawStdin);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // Codex sent malformed JSON. Per fail-safe-on-the-itsybitsy-side, deny.
      process.stdout.write(buildCodexDenyOutput("codex hook stdin was not valid JSON"));
      return;
    }

    const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
    const toolInput =
      data.tool_input && typeof data.tool_input === "object" && !Array.isArray(data.tool_input)
        ? (data.tool_input as Record<string, unknown>)
        : {};
    const cwd = typeof data.cwd === "string" ? data.cwd : process.cwd();

    const ctxResolved = await resolveAgentContext(agentId, cwd, deps?.agentDirOverride);

    // Defensive session-id capture (fallback to SessionStart handler).
    if (!deps?.skipSessionIdCapture) {
      const sessionId = readDefensive(data, "session_id", "sessionId");
      if (typeof sessionId === "string" && sessionId.length > 0) {
        await captureCodexSessionId(ctxResolved.agentDir, sessionId);
      }
    }

    const permissions = await loadMergedAgentTypePermissions(ctxResolved.agentType);

    const ctx: PathCheckContext = {
      agentId,
      agentDir: ctxResolved.agentDir,
      worktreePath: ctxResolved.worktreePath,
      agentsDir: ctxResolved.agentsDir,
      rootRepo: ctxResolved.rootRepo,
      allowList: permissions.allow,
    };

    const decision = checkCodexPreToolUse({ toolName, toolInput, cwd }, ctx);

    if (decision.decision === "allow") {
      process.stdout.write(buildCodexAllowOutput(toolInput));
    } else {
      process.stdout.write(buildCodexDenyOutput(decision.reason));
    }
  } catch (err) {
    // Last-ditch deny. Never let the process throw — codex would fail open.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      process.stdout.write(buildCodexDenyOutput(`codex-pre-tool-use crashed: ${msg}`));
    } catch {
      // If even stdout.write fails, exit 0 silently — codex still fails open,
      // but at least we didn't propagate the throw.
    }
  }
}

/**
 * Spawn-time precheck (SPEC §5.4 step 7 / §5.5 fail-open mitigation): verify
 * the dispatcher resolves for the given agent id and that meta.json exists.
 * Does NOT read stdin. Throws on failure so the spawn caller can abort.
 */
export async function hookCodexPreToolUseDryRun(agentId: string): Promise<void> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for codex-pre-tool-use dry-run: ${agentId}`);
  }
  const ctxResolved = await resolveAgentContext(agentId, process.cwd());
  const metaPath = join(ctxResolved.agentDir, "meta.json");
  const file = Bun.file(metaPath);
  if (!(await file.exists())) {
    throw new Error(`codex-pre-tool-use dry-run: meta.json not found at ${metaPath}`);
  }
}
