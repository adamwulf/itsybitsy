/**
 * Shared helpers for building Claude `settings.local.json` for ittybitty
 * agents. The system coordinator, per-repo coordinators, and regular agents
 * each need a slightly different shape, but they share a hooks block and a
 * layer-loading pattern. Centralizing the duplication here keeps the
 * three callers honest about what's actually different.
 */

import { ensureAgentTypesDir, loadAgentType } from "./agent-types";
import { ensureSlashCommands } from "./slash-commands";

export interface PermissionLayer {
  allow: string[];
  deny: string[];
}

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
 * The shape varies along three axes:
 *   - whether the Stop hook is included (system coordinator omits it; it
 *     has its own state detection)
 *   - whether intercept-task is enabled and what its matcher should be
 *     (coordinators include `Bash` in the matcher; regular agents don't)
 *   - whether the session-start hook command takes the agent ID as an
 *     argument (coordinators do; regular agents don't because the hook
 *     derives identity from cwd)
 *
 * Key insertion order is preserved across callers — when Stop is omitted
 * the remaining keys are emitted as `[PreToolUse, PermissionRequest,
 * SessionStart]` (system coordinator); when Stop is present the order is
 * `[Stop, PermissionRequest, PreToolUse, SessionStart]`.
 */
export function buildHooksBlock(opts: {
  agentId: string;
  includeStop: boolean;
  interceptMatcher: string | null;
  sessionStartIncludesAgentId: boolean;
}): Record<string, unknown> {
  const preToolUseHooks: unknown[] = [
    { matcher: "*", hooks: [{ type: "command", command: `ib hook-check-path ${opts.agentId}` }] },
  ];
  if (opts.interceptMatcher !== null) {
    preToolUseHooks.push({
      matcher: opts.interceptMatcher,
      hooks: [{ type: "command", command: "ib hooks intercept-task" }],
    });
  }

  const sessionStartCmd = opts.sessionStartIncludesAgentId
    ? `ib hooks session-start ${opts.agentId}`
    : "ib hooks session-start";
  const permissionDeniedCmd = `ib hook-permission-denied ${opts.agentId}`;

  const hooks: Record<string, unknown> = {};
  if (opts.includeStop) {
    hooks.Stop = [{ matcher: "*", hooks: [{ type: "command", command: `ib hook-status ${opts.agentId}` }] }];
    hooks.PermissionRequest = [{ matcher: "*", hooks: [{ type: "command", command: permissionDeniedCmd }] }];
    hooks.PreToolUse = preToolUseHooks;
    hooks.SessionStart = [{ hooks: [{ type: "command", command: sessionStartCmd }] }];
  } else {
    hooks.PreToolUse = preToolUseHooks;
    hooks.PermissionRequest = [{ matcher: "*", hooks: [{ type: "command", command: permissionDeniedCmd }] }];
    hooks.SessionStart = [{ hooks: [{ type: "command", command: sessionStartCmd }] }];
  }
  return hooks;
}

/** Intercept-task matcher for coordinators (system + per-repo) — Bash is included
 * because coordinators have additional Bash restrictions enforced in the hook. */
export const COORDINATOR_INTERCEPT_MATCHER = "Task|Agent|TaskCreate|Bash|AskUserQuestion";

/** Intercept-task matcher for regular agents (managers) — Bash is NOT included. */
export const REGULAR_AGENT_INTERCEPT_MATCHER = "Task|Agent|TaskCreate|AskUserQuestion";
