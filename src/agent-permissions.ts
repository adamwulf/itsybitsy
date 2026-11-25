/**
 * An agent's allow list and spawn capability, as `b` in `ib watch` changes
 * them: for a local agent from the dashboard (src/tui/agent-actions.ts), and
 * for a paired dashboard's request (src/peers/remote-permissions.ts, SPEC §20.4
 * "Remote permissions"). Both run in the unsandboxed `ib watch`.
 */
import { join } from "node:path";
import type { Agent } from "./agents";
import { loadAgentType } from "./agent-types";
import { REPO_COORDINATOR_TYPE } from "./coordinator-type-names";
import { sealAgentRecord, sendMessage, writeMetaJsonAtomic } from "./ib-commands";
import * as runtimeNames from "./runtime-names";
import { isValidToolList } from "./validation";

export const INVALID_PERMISSION_ENTRY = "Invalid permission entry — disallowed characters";

/** Resolve the settings.local.json path for an agent.
 * Coordinator agents use <agentDir>/.claude/; everyone else uses <agentDir>/repo/.claude/. */
export function agentSettingsLocalPath(agent: Agent): string {
  const agentDir = agentDirFor(agent);
  const base = agent.meta.agentType === REPO_COORDINATOR_TYPE ? agentDir : join(agentDir, "repo");
  return join(base, ".claude", "settings.local.json");
}

/** Physical agent dir backing an agent record (archived agents are blocked before a change). */
function agentDirFor(agent: Agent): string {
  const dir = agent.archived ? "archive" : "agents";
  return join(runtimeNames.runtimeDir(agent.repoPath), dir, agent.id);
}

/** Append an entry to the permissions.allow array in a settings.local.json file.
 *  Returns { added: true } on success, { added: false, reason: "duplicate" } if the
 *  entry is already present, or { added: false, reason: "error", message } on failure.
 *  Preserves deny list and any other keys. If the file is missing, creates a new one.
 *  If the file exists but is malformed, aborts without overwriting. */
export type AddPermissionResult =
  | { added: true }
  | { added: false; reason: "duplicate" }
  | { added: false; reason: "error"; message: string };

export async function addPermissionToSettings(
  settingsPath: string,
  entry: string,
): Promise<AddPermissionResult> {
  const file = Bun.file(settingsPath);
  let settings: Record<string, unknown> = {};
  if (await file.exists()) {
    try {
      settings = (await file.json()) as Record<string, unknown>;
    } catch (err) {
      return { added: false, reason: "error", message: `Malformed JSON: ${(err as Error).message}` };
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      return { added: false, reason: "error", message: "settings.local.json is not an object" };
    }
  }
  const existingPerms = (settings.permissions as Record<string, unknown> | undefined) ?? {};
  if (typeof existingPerms !== "object" || existingPerms === null || Array.isArray(existingPerms)) {
    return { added: false, reason: "error", message: "permissions is not an object" };
  }
  const rawAllow = existingPerms.allow;
  const allow = Array.isArray(rawAllow) ? [...(rawAllow as unknown[])].filter((v): v is string => typeof v === "string") : [];
  const rawDeny = existingPerms.deny;
  const deny = Array.isArray(rawDeny) ? [...(rawDeny as unknown[])].filter((v): v is string => typeof v === "string") : [];
  if (allow.includes(entry)) {
    return { added: false, reason: "duplicate" };
  }
  const dedupedAllow = Array.from(new Set([...allow, entry]));
  const newSettings = {
    ...settings,
    permissions: {
      ...existingPerms,
      allow: dedupedAllow,
      deny,
    },
  };
  try {
    await Bun.write(settingsPath, JSON.stringify(newSettings, null, 2));
  } catch (err) {
    return { added: false, reason: "error", message: (err as Error).message };
  }
  return { added: true };
}

/**
 * Resolve an agent's CURRENT effective spawn capability, mirroring the
 * precedence the intercept-task hook enforces:
 *   1. `meta.canSpawnChildren` per-agent override (when a boolean).
 *   2. otherwise the agent type's `canSpawnChildren`.
 *   3. otherwise the legacy `!meta.worker` fallback.
 * Kept in one place so the 'b' dialog's toggle label matches what the hook does.
 */
export async function effectiveSpawnCapability(agent: Agent): Promise<boolean> {
  const meta = agent.meta;
  if (typeof meta.canSpawnChildren === "boolean") return meta.canSpawnChildren;
  if (meta.agentType) {
    try {
      const type = await loadAgentType(meta.agentType);
      return type.canSpawnChildren;
    } catch {
      // Unknown type — fall through to the worker fallback.
    }
  }
  return !meta.worker;
}

/**
 * The outcome of a permission change: on failure, the notice the dashboard
 * shows; on success, why telling the agent failed, if it did.
 */
export type PermissionChangeResult = { ok: true; notifyError?: string } | { ok: false; error: string };

/** Add `entry` to the agent's settings.local.json allow list, then tell the agent. */
export async function grantAgentPermission(agent: Agent, entry: string): Promise<PermissionChangeResult> {
  if (!isValidToolList(entry)) return { ok: false, error: INVALID_PERMISSION_ENTRY };
  const result = await addPermissionToSettings(agentSettingsLocalPath(agent), entry);
  if (!result.added) return { ok: false, error: result.reason === "duplicate" ? "Already in allow list" : `Failed: ${result.message}` };
  const sendResult = await sendMessage(
    agent,
    `Permission to '${entry}' has been granted. You may retry the action that was previously denied.`,
    { cwd: "/" },
  );
  return sendResult.ok ? { ok: true } : { ok: true, notifyError: sendResult.stderr || sendResult.stdout };
}

/**
 * Persist `next` as the agent's per-agent spawn override, re-seal a sandboxed
 * agent, then tell the agent. Updates the in-memory record on success.
 */
export async function setAgentSpawnCapability(agent: Agent, next: boolean): Promise<PermissionChangeResult> {
  const agentDir = agentDirFor(agent);
  try {
    const metaFile = Bun.file(join(agentDir, "meta.json"));
    if (!(await metaFile.exists())) return { ok: false, error: `Failed: meta.json missing for ${agent.id}` };
    const meta = (await metaFile.json()) as Record<string, unknown>;
    const prevCanSpawn = meta.canSpawnChildren; // for rollback on re-seal failure
    meta.canSpawnChildren = next;
    await writeMetaJsonAtomic(agentDir, meta);

    // Re-seal a sandboxed ENABLED agent so the frozen profile record
    // reflects the new spawn capability. canSpawnChildren is a sealed
    // input (SPEC-SANDBOX §4C.3): without re-sealing, this legitimate
    // toggle reads as tamper on the next resume/respawn (verifyMetaAgainstSeal
    // fails hard) and `ib sandbox refresh` refuses it. The toggle runs
    // UNSANDBOXED in `ib watch`, so the direct seal write lands. A disabled
    // agent has no profile and is never verified, so skip it.
    const sandbox = meta.sandbox as { enabled?: boolean } | undefined;
    if (sandbox?.enabled) {
      try {
        await sealAgentRecord(agent.repoPath, agent.id, meta, agentDir);
      } catch (err) {
        // Roll the meta write back — a half-applied toggle (meta changed,
        // seal stale) would brick the agent on its next resume, which is
        // worse than a refused toggle. Restore the prior canSpawnChildren
        // (its absence when there was no per-agent override) and re-write.
        if (prevCanSpawn === undefined) delete meta.canSpawnChildren;
        else meta.canSpawnChildren = prevCanSpawn;
        await writeMetaJsonAtomic(agentDir, meta).catch(() => {});
        return { ok: false, error: `Failed to re-seal ${agent.id}; spawn toggle rolled back: ${(err as Error).message}` };
      }
    }

    // Reflect the change in the in-memory record so the dashboard is current.
    agent.meta.canSpawnChildren = next;
    const sendResult = await sendMessage(
      agent,
      next
        ? "You can now spawn sub-agents (`ib new-agent --type worker \"task\"`)."
        : "Your ability to spawn sub-agents has been revoked. Report back to your manager instead.",
      { cwd: "/" },
    );
    return sendResult.ok ? { ok: true } : { ok: true, notifyError: sendResult.stderr || sendResult.stdout };
  } catch (err) {
    return { ok: false, error: `Failed: ${(err as Error).message}` };
  }
}
