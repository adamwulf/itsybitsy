/**
 * Antigravity CLI (`agy`) PreToolUse hook handler — the deny-by-default gate.
 *
 * Agy is launched with `--dangerously-skip-permissions --mode=accept-edits`
 * in both kernel modes. This hook controls tool approvals and remains the
 * always-on path boundary when the itsybitsy kernel wrapper is disabled
 * (SPEC-ANTIGRAVITY-CLI.md D3). Load-bearing properties:
 *
 *   1. Deny-by-default. A tool call is allowed only if the translated Claude
 *      call passes the merged agent-type allow list (_all / _non_coordinator /
 *      <type>) AND path isolation.
 *   2. Path isolation. Every agy tool is translated to a synthetic Claude call
 *      (agy-tools.ts) and run through the shared checkPathAccess against the
 *      per-agent access table (ctx.access = meta.paths ∪ the runtime roots), so
 *      /tmp and ~/.itsybitsy are not reachable through file tools unless the
 *      agent's paths block grants them.
 *   3. Fail-CLOSED. agy treats a crash / non-JSON / `{}` / timeout as a DENY
 *      (the opposite of codex). We still wrap everything in try/catch and emit
 *      an explicit `{"decision":"deny","reason":…}` so denials are logged, and
 *      always exit 0 (D4).
 *   4. Conversation-id capture. Defensively capture `conversationId` into
 *      meta.agy_conversation_id if empty (PreInvocation is the primary capture).
 *
 * Output contract: `{"decision":"allow"|"deny","reason":"…"}`.
 */

import { join } from "path";
import { isValidAgentId } from "../validation";
import { mutateAgentMeta } from "../agents";
import { logAgent } from "../agent-lifecycle";
import { userHome } from "../home";
import {
  REGULAR_AGENT_DEFAULT_ALLOW,
  REGULAR_AGENT_DEFAULT_DENY,
} from "../settings-builder";
import { loadMergedAgentTypePermissions } from "./shared";
import { resolveAgentContext } from "./agent-context";
import {
  agentProtectedWritePaths,
  checkPathAccess,
  checkIbCommandAccess,
  toolMatchesPattern,
  META_UNREADABLE_DENY_REASON,
  type HookDecision,
  type PathCheckContext,
} from "./agent-path";
import { buildAgentAccessTable } from "./paths-table";
import { translateAgyTool, buildAgyAllowOutput, buildAgyDenyOutput } from "./agy-tools";
import { findShellMetachar } from "./shell-metachar";

/** Format tool args for denial logs, matching the Claude/codex hook style. */
function formatToolArgs(toolArgs: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(toolArgs)) {
    if (typeof value === "string") {
      const truncated = value.length > 60 ? value.slice(0, 57) + "..." : value;
      parts.push(`${key}=${truncated}`);
    }
  }
  return parts.join(", ");
}

/**
 * Pure decision function for the agy PreToolUse handler. Translates the agy
 * call, then runs the synthesized Claude call through checkPathAccess against
 * the per-agent access table.
 *
 * Path isolation: agy has no sandbox, so a file tool that resolves outside the
 * agent's access table (ctx.access = meta.paths ∪ the runtime roots) must be
 * denied. checkPathAccess resolves every path through that table — deny by
 * default — with the worktree, project dir and scratchpad allowed as runtime
 * roots. There is no worktree-only fallback; a missing paths block is strict.
 *
 * Deny list: for claude the CLI enforces `permissions.deny`; for agy the hook
 * is the only boundary, so a deny pattern that matches the synthesized call OR
 * the raw agy tool name denies here, and deny WINS over allow.
 */
export function checkAgyPreToolUse(
  input: { toolName: string; toolArgs: unknown },
  ctx: PathCheckContext,
  denyList: string[] = [],
): HookDecision {
  const t = translateAgyTool(input.toolName, input.toolArgs, ctx.allowList);
  if (t.action === "deny") {
    return { decision: "deny", reason: t.reason };
  }

  // run_command must be a SINGLE command with no shell metacharacters outside
  // quotes. Unlike Claude Code — which re-enforces permissions per sub-command —
  // agy has no second layer, so chaining/piping/redirection on one line would
  // evade the allow list AND path isolation (`ls y; ib retire other`,
  // `cat x; cd ..; cat sibling`). Apply the same single-command rule coordinators
  // live under, BEFORE the allow-list/path decision.
  if (input.toolName === "run_command") {
    const command = typeof t.toolInput.command === "string" ? t.toolInput.command : "";
    const hit = findShellMetachar(command);
    if (hit) {
      return {
        decision: "deny",
        reason:
          `run_command cannot contain shell metacharacters outside quotes (found: ${hit}). ` +
          `Run one command per call; put literal text in single quotes or a quoted-delimiter heredoc.`,
      };
    }
  }

  // Deny list wins over allow. Match against the synthesized Claude call (so a
  // type that denies `Write` blocks write_to_file) OR the raw agy tool name (so
  // a type can deny an agy tool verbatim).
  for (const pattern of denyList) {
    if (!pattern) continue;
    if (toolMatchesPattern(t.toolName, t.toolInput, pattern) || pattern === input.toolName) {
      return { decision: "deny", reason: "tool denied by agent-type deny list" };
    }
  }

  // A run_command carries a MODEL-CONTROLLED `Cwd` (translated to t.cwd). The
  // shared checkPathAccess never validates the cwd itself — Claude's Bash tool
  // has no cwd argument — so a benign allow-listed command (e.g. `ls`) with
  // Cwd set to the main repo / a sibling worktree / /tmp would execute THERE,
  // outside the worktree. Gate the directory as a READ through the access table
  // (an LS on it: "LS" prepended to the allow list) before the command is
  // checked. Absent Cwd defaults to the worktree, a runtime root, so no
  // validation is needed for that case.
  if (t.cwd !== undefined) {
    const cwdDecision = checkPathAccess(
      { toolName: "LS", toolInput: { file_path: t.cwd }, cwd: ctx.worktreePath },
      { ...ctx, allowList: ["LS", ...ctx.allowList] },
    );
    if (cwdDecision.decision === "deny") {
      return {
        decision: "deny",
        reason: `run_command Cwd rejected (${t.cwd}): ${cwdDecision.reason}`,
      };
    }
  }

  const cwd = t.cwd ?? ctx.worktreePath;
  return checkPathAccess(
    { toolName: t.toolName, toolInput: t.toolInput, cwd },
    ctx,
  );
}

/**
 * Persist the agy conversation id into meta.agy_conversation_id if empty.
 * Idempotent — the first firing wins. Best-effort (never throws).
 */
export async function captureAgyConversationId(
  agentDir: string,
  conversationId: string,
): Promise<boolean> {
  if (!conversationId) return false;
  return mutateAgentMeta(agentDir, (meta) => {
    if (
      typeof meta.agy_conversation_id === "string" &&
      (meta.agy_conversation_id as string).length > 0
    ) {
      return null;
    }
    meta.agy_conversation_id = conversationId;
  });
}

/**
 * Load the merged allow/deny lists for an agy agent — same three-layer source
 * as codex (_all / _non_coordinator / <type>), plus the shared regular-agent
 * defaults, plus any dynamic grants added to `.claude/settings.local.json`
 * (the `ib watch` 'b' dialog writes there).
 */
async function loadAgyEffectivePermissions(
  agentType: string | undefined,
  worktreePath: string,
): Promise<{ allow: string[]; deny: string[] }> {
  const permissions = await loadMergedAgentTypePermissions(agentType);
  permissions.allow.unshift(...REGULAR_AGENT_DEFAULT_ALLOW);
  permissions.deny.unshift(...REGULAR_AGENT_DEFAULT_DENY);
  try {
    const settingsFile = Bun.file(join(worktreePath, ".claude", "settings.local.json"));
    if (await settingsFile.exists()) {
      const settings = await settingsFile.json();
      if (Array.isArray(settings?.permissions?.allow)) {
        for (const entry of settings.permissions.allow) {
          if (typeof entry === "string") permissions.allow.push(entry);
        }
      }
      if (Array.isArray(settings?.permissions?.deny)) {
        for (const entry of settings.permissions.deny) {
          if (typeof entry === "string") permissions.deny.push(entry);
        }
      }
    }
  } catch { /* dynamic grant file is best-effort; static permissions still apply */ }

  return {
    allow: [...new Set(permissions.allow)],
    deny: [...new Set(permissions.deny)],
  };
}

export interface AgyPreToolUseDeps {
  /** Override stdin read; tests inject a synchronous string. */
  rawStdin?: string;
  /** Override the resolved agent dir. */
  agentDirOverride?: string;
  /** Disable meta.json side-effects (conversation-id capture) — tests with no fs. */
  skipMetaWrites?: boolean;
  /** Optional stdout writer override (dry-run captures output). */
  write?: (chunk: string) => unknown;
}

/**
 * CLI entry: `ib hooks agy-pre-tool-use <agentId> [--dry-run]`. Always emits
 * valid JSON to stdout and always exits 0 (D4). agy fails CLOSED, so every
 * error path emits an explicit deny.
 */
export async function hookAgyPreToolUse(
  agentId: string,
  deps?: AgyPreToolUseDeps,
): Promise<void> {
  const write = deps?.write ?? ((chunk: string) => process.stdout.write(chunk));
  try {
    if (!isValidAgentId(agentId)) {
      write(buildAgyDenyOutput("Invalid agent id passed to agy-pre-tool-use"));
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
      write(buildAgyDenyOutput("agy hook stdin was not valid JSON"));
      return;
    }

    const toolCall =
      data.toolCall && typeof data.toolCall === "object" && !Array.isArray(data.toolCall)
        ? (data.toolCall as Record<string, unknown>)
        : {};
    const toolName = typeof toolCall.name === "string" ? toolCall.name : "";
    const toolArgs = toolCall.args;

    // agy hook payloads carry no `cwd`; the hook process cwd is <worktree>/.agents.
    const ctxResolved = await resolveAgentContext(
      agentId,
      process.cwd(),
      deps?.agentDirOverride,
    );

    // Defensive conversation-id capture (PreInvocation is primary).
    if (!deps?.skipMetaWrites) {
      const conversationId =
        typeof data.conversationId === "string" ? data.conversationId : "";
      if (conversationId) {
        await captureAgyConversationId(ctxResolved.agentDir, conversationId);
      }
    }

    // A missing/unparseable meta.json DENIES — the hook resolves its path lists
    // from meta.paths, so there is no permissive fallback (the invariant). agy
    // already fails closed, so this is the explicit, logged form of that.
    if (!ctxResolved.meta) {
      await logAgent(
        ctxResolved.agentDir,
        `[PreToolUse] Permission denied: ${toolName} — ${META_UNREADABLE_DENY_REASON}`,
      );
      write(buildAgyDenyOutput(META_UNREADABLE_DENY_REASON));
      return;
    }

    const permissions = await loadAgyEffectivePermissions(
      ctxResolved.agentType,
      ctxResolved.worktreePath,
    );

    const access = await buildAgentAccessTable({
      meta: ctxResolved.meta,
      agentDir: ctxResolved.agentDir,
      worktreePath: ctxResolved.worktreePath,
      agentsDir: ctxResolved.agentsDir,
      rootRepo: ctxResolved.rootRepo,
      home: userHome(),
    }).catch(() => null);
    if (!access) {
      await logAgent(
        ctxResolved.agentDir,
        `[PreToolUse] Permission denied: ${toolName} — ${META_UNREADABLE_DENY_REASON}`,
      );
      write(buildAgyDenyOutput(META_UNREADABLE_DENY_REASON));
      return;
    }

    const ctx: PathCheckContext = {
      agentId,
      agentDir: ctxResolved.agentDir,
      worktreePath: ctxResolved.worktreePath,
      agentsDir: ctxResolved.agentsDir,
      rootRepo: ctxResolved.rootRepo,
      allowList: permissions.allow,
      access,
      protectedWritePaths: agentProtectedWritePaths(ctxResolved.agentDir),
    };

    // Parity with hookCheckPath: manager-only ib subcommands (retire / merge /
    // nuke / pause / resume / reassign <target>) require the caller to be the
    // target's manager or spawner. run_command is agy's Bash, so gate its
    // CommandLine the same way, BEFORE the path/allow-list decision. A non-ib or
    // non-manager-only command returns null and falls through unchanged.
    let ibDenial: HookDecision | null = null;
    if (toolName === "run_command") {
      const rc =
        toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
          ? (toolArgs as Record<string, unknown>)
          : {};
      const command = typeof rc.CommandLine === "string" ? rc.CommandLine : "";
      if (command) {
        ibDenial = await checkIbCommandAccess(command, agentId, ctxResolved.agentsDir);
      }
    }

    const decision =
      ibDenial ?? checkAgyPreToolUse({ toolName, toolArgs }, ctx, permissions.deny);

    if (decision.decision === "allow") {
      write(buildAgyAllowOutput(decision.reason));
    } else {
      const argsForLog =
        toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
          ? formatToolArgs(toolArgs as Record<string, unknown>)
          : "";
      const suffix = argsForLog ? ` (${argsForLog})` : "";
      await logAgent(ctxResolved.agentDir, `[PreToolUse] Permission denied: ${toolName}${suffix} — ${decision.reason}`);
      write(buildAgyDenyOutput(decision.reason));
    }
  } catch (err) {
    // Fail-CLOSED: any uncaught error denies. Never let the process throw.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      write(buildAgyDenyOutput(`agy-pre-tool-use crashed: ${msg}`));
    } catch {
      /* even stdout failed — exit 0 silently */
    }
  }
}

/**
 * Spawn-time precheck. Invokes the real handler with a synthetic run_command
 * payload (which is denied deny-by-default) and verifies the stdout is valid
 * JSON carrying a `decision` field. Throws on failure so the spawn caller can
 * refuse the launch.
 */
export async function hookAgyPreToolUseDryRun(agentId: string): Promise<void> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for agy-pre-tool-use dry-run: ${agentId}`);
  }
  const ctxResolved = await resolveAgentContext(agentId, process.cwd());
  const metaPath = join(ctxResolved.agentDir, "meta.json");
  const file = Bun.file(metaPath);
  if (!(await file.exists())) {
    throw new Error(`agy-pre-tool-use dry-run: meta.json not found at ${metaPath}`);
  }
  const buf: string[] = [];
  const syntheticInput = JSON.stringify({
    conversationId: "dry-run-no-uuid",
    toolCall: { name: "run_command", args: { CommandLine: "echo dry-run-probe" } },
  });
  await hookAgyPreToolUse(agentId, {
    rawStdin: syntheticInput,
    skipMetaWrites: true,
    write: (chunk: string) => { buf.push(chunk); return chunk.length; },
  });
  const out = buf.join("");
  if (!out) {
    throw new Error("agy-pre-tool-use dry-run: handler produced no output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`agy-pre-tool-use dry-run: handler emitted non-JSON output: ${(err as Error).message}`);
  }
  const decision = (parsed as Record<string, unknown>)?.decision;
  if (decision !== "allow" && decision !== "deny") {
    throw new Error(
      `agy-pre-tool-use dry-run: handler output missing decision:"allow"|"deny" (got ${JSON.stringify(parsed)})`,
    );
  }
}
