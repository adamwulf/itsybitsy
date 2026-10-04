/**
 * Shared helpers for building Claude `settings.local.json` for ittybitty
 * agents. The system coordinator, per-repo coordinators, and regular agents
 * each need a slightly different shape, but they share a hooks block and a
 * layer-loading pattern. Centralizing the duplication here keeps the
 * three callers honest about what's actually different.
 */

import { join } from "path";
import { ensureAgentTypesDir, loadAgentType } from "./agent-types";
import { userHome } from "./home";
import { ensureSlashCommands } from "./slash-commands";

export interface PermissionLayer {
  allow: string[];
  deny: string[];
}

export const REGULAR_AGENT_DEFAULT_ALLOW = [
  "Bash(ib:*)",
  "Bash(git status:*)", "Bash(git add:*)", "Bash(git commit:*)",
  "Bash(git diff:*)", "Bash(git show:*)", "Bash(git log:*)",
  "Bash(git ls-files:*)", "Bash(git grep:*)", "Bash(git rm:*)",
  "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git checkout:*)",
  "Bash(git restore:*)", "Bash(git reset:*)",
  "Bash(pwd:*)", "Bash(ls:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(cat:*)", "Bash(grep:*)",
  "Read", "Write", "Edit", "Glob", "Grep",
  "TodoWrite", "Task", "TaskCreate", "Agent", "TaskOutput", "KillShell", "NotebookEdit",
  "WebFetch", "WebSearch", "ToolSearch",
];

export const REGULAR_AGENT_DEFAULT_DENY = ["EnterPlanMode", "ExitPlanMode"];

/**
 * Load a single agent-type layer file's permissions block. Missing layers
 * are reported on stderr and treated as empty — this matches the previous
 * inline behavior in coordinator.ts and ib-commands.ts so failures are
 * never silent but also never fatal.
 */
export async function loadLayerPermissions(layerName: string): Promise<PermissionLayer> {
  try {
    const layer = await loadAgentType(layerName);
    return {
      allow: layer.permissions?.allow ?? [],
      deny: layer.permissions?.deny ?? [],
    };
  } catch (err) {
    console.error(`Warning: failed to load ${layerName} agent type layer: ${err instanceof Error ? err.message : String(err)}`);
    return { allow: [], deny: [] };
  }
}

/**
 * Resolve the final permissions list by merging hardcoded floor + layer
 * permissions. Layer allow entries that conflict with the hardcoded deny
 * are silently dropped (a layer can never override the floor). Result is
 * deduplicated.
 *
 * `ensureAgentTypesDir` is invoked first so embedded layer files are
 * present on disk before any layer load attempt.
 */
export async function buildLayeredPermissions(opts: {
  hardcodedAllow: string[];
  hardcodedDeny: string[];
  layerNames: string[];
}): Promise<{ allow: string[]; deny: string[] }> {
  try {
    await ensureAgentTypesDir();
  } catch {
    // If this fails, fall through — loadLayerPermissions logs and returns empty
  }

  // Same first-run idempotent populate pattern as ensureAgentTypesDir, but
  // for `/respawn` and `/restart` slash commands shipped with itsybitsy.
  // Missing files are written; existing files are left alone so user edits
  // survive upgrades. Failures are non-fatal — slash commands are a UX
  // convenience, not a hard requirement.
  try {
    await ensureSlashCommands();
  } catch (err) {
    console.error(`Warning: failed to ensure slash commands: ${err instanceof Error ? err.message : String(err)}`);
  }

  const layerPerms = await Promise.all(opts.layerNames.map(loadLayerPermissions));
  const hardcodedDenySet = new Set(opts.hardcodedDeny);

  const filteredLayerAllow = layerPerms.flatMap((p) =>
    p.allow.filter((entry) => !hardcodedDenySet.has(entry)),
  );
  const layerDeny = layerPerms.flatMap((p) => p.deny);

  return {
    allow: [...new Set([...opts.hardcodedAllow, ...filteredLayerAllow])],
    deny: [...new Set([...opts.hardcodedDeny, ...layerDeny])],
  };
}

/**
 * Build the `hooks` block for a `settings.local.json` file.
 *
 * The shape varies along several axes:
 *   - whether the Stop hook is included (system coordinator omits it; it
 *     has its own state detection)
 *   - whether intercept-task is enabled and what its matcher should be
 *     (both coordinators and regular agents include `Bash` in the matcher —
 *     coordinators for their Bash restrictions, regular agents so the
 *     busy-wait detector can catch managers/workers spinning on `sleep`)
 *   - whether the session-start hook command takes the agent ID as an
 *     argument (coordinators do; regular agents don't because the hook
 *     derives identity from cwd)
 *   - whether the other cwd-sensitive hooks receive an explicit agent ID
 *     (required by worktree:false agents because their cwd is the shared repo)
 *   - whether the inject-timestamp PostToolUse hook is included (regular
 *     agents get it; the hook body is gated on the `hooks.injectTimestamp`
 *     config so the entry being present is harmless when the config is off)
 *
 * Key insertion order is preserved across callers — when Stop is omitted
 * the remaining keys are emitted as `[PreToolUse, PermissionRequest,
 * UserPromptSubmit, SessionStart]` (system coordinator); when Stop is
 * present the order is `[Stop, PermissionRequest, PreToolUse,
 * UserPromptSubmit, SessionStart]`. When `includeTimestamp` is set, a
 * `PostToolUse` key is appended after `PreToolUse` in either ordering.
 */
export function buildHooksBlock(opts: {
  agentId: string;
  includeStop: boolean;
  interceptMatcher: string | null;
  sessionStartIncludesAgentId: boolean;
  /** Pass agent identity to intercept-task and inject-timestamp instead of
   * deriving it from cwd. Required for worktree:false isolated settings. */
  identityDependentHooksIncludeAgentId?: boolean;
  includeTimestamp?: boolean;
  /** When true (system coordinator only), append `ib tgtyping` to both the
   *  UserPromptSubmit and PostToolUse hook arrays so the Telegram chat shows
   *  a "typing..." indicator while the coordinator is working. The indicator
   *  decays naturally on idle (no Stop hook). */
  includeTelegramTyping?: boolean;
}): Record<string, unknown> {
  const preToolUseHooks: unknown[] = [
    { matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${opts.agentId}` }] },
  ];
  if (opts.interceptMatcher !== null) {
    const interceptCommand = opts.identityDependentHooksIncludeAgentId
      ? `ib hooks intercept-task ${opts.agentId}`
      : "ib hooks intercept-task";
    preToolUseHooks.push({
      matcher: opts.interceptMatcher,
      hooks: [{ type: "command", command: interceptCommand }],
    });
  }

  const timestampCommand = opts.identityDependentHooksIncludeAgentId
    ? `ib hooks inject-timestamp ${opts.agentId}`
    : "ib hooks inject-timestamp";

  const postToolUseHooks: unknown[] | null =
    opts.includeTimestamp || opts.includeTelegramTyping ? [] : null;
  if (postToolUseHooks && opts.includeTimestamp) {
    postToolUseHooks.push({ matcher: "*", hooks: [{ type: "command", command: timestampCommand }] });
  }
  if (postToolUseHooks && opts.includeTelegramTyping) {
    postToolUseHooks.push({ matcher: "*", hooks: [{ type: "command", command: "ib tgtyping" }] });
  }

  const sessionStartCmd = opts.sessionStartIncludesAgentId
    ? `ib hooks session-start ${opts.agentId}`
    : "ib hooks session-start";
  const permissionDeniedCmd = `ib hook-permission-denied ${opts.agentId}`;
  // When timestamps are enabled, also inject one alongside the state-flip on
  // every user prompt — gives the agent a wall-clock anchor for messages that
  // arrive long after its last tool call. Same hook command, same config gate.
  const userPromptSubmitHooks: unknown[] = [
    { hooks: [{ type: "command", command: `ib hook-mark-running ${opts.agentId}` }] },
  ];
  if (opts.includeTimestamp) {
    userPromptSubmitHooks.push({ hooks: [{ type: "command", command: timestampCommand }] });
  }
  if (opts.includeTelegramTyping) {
    userPromptSubmitHooks.push({ hooks: [{ type: "command", command: "ib tgtyping" }] });
  }

  const hooks: Record<string, unknown> = {};
  if (opts.includeStop) {
    hooks.Stop = [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-status ${opts.agentId}` }] }];
    hooks.PermissionRequest = [{ matcher: "*", hooks: [{ type: "command", command: permissionDeniedCmd }] }];
    hooks.PreToolUse = preToolUseHooks;
    if (postToolUseHooks) hooks.PostToolUse = postToolUseHooks;
    hooks.UserPromptSubmit = userPromptSubmitHooks;
    hooks.SessionStart = [{ hooks: [{ type: "command", command: sessionStartCmd }] }];
  } else {
    hooks.PreToolUse = preToolUseHooks;
    if (postToolUseHooks) hooks.PostToolUse = postToolUseHooks;
    hooks.PermissionRequest = [{ matcher: "*", hooks: [{ type: "command", command: permissionDeniedCmd }] }];
    hooks.UserPromptSubmit = userPromptSubmitHooks;
    hooks.SessionStart = [{ hooks: [{ type: "command", command: sessionStartCmd }] }];
  }
  return hooks;
}

/** The command prefix of ib's statusLine wrapper (src/hooks/statusline.ts). */
export const STATUSLINE_HOOK_COMMAND = "ib hooks statusline";

/** A Claude Code `statusLine` setting of type "command" (plus display keys such as `padding`). */
export interface CommandStatusLine {
  type: "command";
  command: string;
  [key: string]: unknown;
}

/**
 * A `statusLine` setting value as a command statusline, or null when it is
 * not one. ib's own wrapper is also null, so it can never run itself.
 */
export function parseCommandStatusLine(value: unknown): CommandStatusLine | null {
  const setting = value as Record<string, unknown> | null | undefined;
  if (!setting || typeof setting !== "object") return null;
  if (setting.type !== "command" || typeof setting.command !== "string") return null;
  if (setting.command.trim() === "" || setting.command.includes(STATUSLINE_HOOK_COMMAND)) return null;
  return setting as CommandStatusLine;
}

/**
 * The statusLine a Claude session in `projectDir` would use without ib: the
 * project's `.claude/settings.json` statusLine, else the user's
 * `~/.claude/settings.json` one. `.claude/settings.local.json` is skipped for
 * the reason buildAgentSettings skips it (it can belong to a coordinator).
 */
export async function resolveUserStatusLine(projectDir: string | null): Promise<CommandStatusLine | null> {
  const paths = [
    ...(projectDir ? [join(projectDir, ".claude", "settings.json")] : []),
    join(userHome(), ".claude", "settings.json"),
  ];
  for (const path of paths) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const settings = (await file.json()) as { statusLine?: unknown } | null;
      if (settings?.statusLine === undefined) continue;
      return parseCommandStatusLine(settings.statusLine);
    } catch {
      // Unreadable or invalid settings: try the next layer.
    }
  }
  return null;
}

/**
 * The `statusLine` of every Claude session ib launches. `ib hooks statusline`
 * records Claude Code's `rate_limits` for ib's usage display
 * (src/claude-rate-limits.ts), then runs `inner` — the statusline the session
 * would show without ib — so the footer looks the same. The display keys of
 * `inner` (`padding`, `refreshInterval`, ...) are kept for the same reason.
 */
export function buildStatusLine(agentId: string, inner: CommandStatusLine | null): Record<string, unknown> {
  return { ...(inner ?? {}), type: "command", command: `${STATUSLINE_HOOK_COMMAND} ${agentId}` };
}

/** Intercept-task matcher for coordinators (system + per-repo) — Bash is included
 * because coordinators have additional Bash restrictions enforced in the hook. */
export const COORDINATOR_INTERCEPT_MATCHER = "Task|Agent|TaskCreate|Bash|AskUserQuestion";

/** Intercept-task matcher for regular agents (managers + workers) — Bash IS
 * included so the busy-wait detector (checkBusyWaitBash) runs for them. Without
 * Bash here, Claude Code would never route a regular agent's Bash calls through
 * `ib hooks intercept-task`, and a manager spinning on `sleep` would not be
 * caught. The hook returns "skip" for ordinary (non-busy-wait) Bash, so the
 * only added cost is one hook-process spawn per Bash call (same as coordinators). */
export const REGULAR_AGENT_INTERCEPT_MATCHER = "Task|Agent|TaskCreate|Bash|AskUserQuestion";
