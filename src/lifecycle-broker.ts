/**
 * Watchdog lifecycle broker — how a SANDBOXED agent retires, merges or rehires
 * a child agent.
 *
 * A sandboxed manager cannot do this work itself. Its profile grants its own
 * agent dir, its worktree, the repo's git dir and `<repo>/.ittybitty/agents`,
 * but NOT the main repo root or `<repo>/.ittybitty/archive`. The lifecycle code
 * runs `git -C <main repo> ...` (which dies with `Unable to read current working
 * directory: Operation not permitted`) and moves the agent into the archive or
 * reads it back, so a direct `ib retire`, `ib merge` or `ib rehire` fails inside
 * the sandbox.
 *
 * The answer is the one `ib new-agent` already uses (spawn-broker.ts): the
 * agent's WATCHDOG runs unsandboxed, so the sandboxed command hands it the
 * request and waits. The queue, the file format and the at-most-once handling
 * are the spawn broker's; a request that carries an `op` field is a lifecycle
 * request and is dispatched here.
 *
 *   sandboxed `ib retire <id>`  ──request.json──▶  the caller's own watchdog
 *        (client, this file)                        (server, this file)
 *                               ◀──result.json───   runs the normal retireAgent()
 *
 * Who uses it: only a WORKTREE agent whose itsybitsy sandbox is enabled. Every
 * other caller runs the command directly, as before — an unsandboxed caller, a
 * shell that is not an agent, a `worktree:false` agent (its profile grants the
 * repo root, and it has no per-agent watchdog to ask), and an agent whose
 * itsybitsy sandbox is off (a codex agent then sits in codex's own sandbox,
 * which grants what these commands need, and it has no seal to verify).
 *
 * Trust model: the request is untrusted DATA and carries only an op and a target
 * id. The watchdog takes the caller's identity from its own agent (verified
 * against the sealed record, as for a spawn) and applies the SAME rule the
 * PreToolUse hook applies to a direct command — `checkManagerCommandAccess`:
 * only the target's manager or spawner (or the repo's coordinator) may act on
 * it. The hook alone is not enough here, because a sandboxed agent can write a
 * request file without running `ib`.
 *
 * Every agent can write its OWN meta.json, and the seal covers only
 * `agentType`, `canSpawnChildren`, `paths` and `sandbox`. So nothing here trusts
 * an unsealed field of the requester's meta:
 *   - the target is the directory entry named exactly by the request, whose
 *     meta.json carries the same id — `meta.id` alone identifies nothing;
 *   - an agent is never its own target (its `manager` field is its own to
 *     write), compared by directory as well as by id;
 *   - the rule gets the verified meta and does not read the file again;
 *   - a merge is aimed at `<agentDir>/repo`, never where `meta.worktree`
 *     points, and the request cannot name a directory;
 *   - a rehire is authorized from the archive of the requester's repo only.
 * The target must be in the requester's own repo.
 *
 * Known limitations (SPEC-SANDBOX §4C.7):
 *   - The rule reads `manager` / `spawned_by` from the TARGET's meta.json, and
 *     the seal does not cover them. The target itself can write them, and they
 *     are copied into its archive when it is retired; a spawner can write them
 *     for any agent in its repo. So an agent can hand itself to any other agent
 *     in the repo, and a spawner can take any agent. What the broker does NOT
 *     trust is the REQUESTER's own file.
 *   - The `<agentDir>/repo` check is check-then-use: the requester can swap the
 *     directory for a symlink after the check, while the merge runs.
 */

import { randomBytes } from "crypto";
import { lstat, realpath } from "fs/promises";
import { basename, join, resolve } from "path";
import { readAllAgents, type Agent } from "./agents";
import {
  hasLiveWatchdog,
  mergeAgent,
  rehireAgent,
  resolveCallerAgentContext,
  retireAgent,
  type IbCommandResult,
  type MergeAgentOptions,
  type ResolvedCallerContext,
} from "./ib-commands";
import { listRepos, repoDisplayName } from "./registry";
import { resolveSandboxEnabled } from "./sandbox";
import { isSandboxedProcess } from "./sandbox-detect";
import {
  brokerFail,
  submitWatchdogRequest,
  verifyBrokerRequester,
  type SpawnClientDeps,
  type SpawnServerDeps,
} from "./spawn-broker";
import { isValidAgentId } from "./validation";

/** The commands a sandboxed agent hands to its watchdog. */
export const LIFECYCLE_OPS = ["retire", "merge", "rehire"] as const;
export type LifecycleOp = (typeof LIFECYCLE_OPS)[number];

/**
 * How long a sandboxed lifecycle command waits for its watchdog. Longer than a
 * spawn: a teardown captures tmux, stops the agent and removes a whole worktree.
 * Kept under the 120s default tool timeout so the agent gets this command's own
 * "may still finish" message instead of a killed tool call.
 */
export const LIFECYCLE_CLIENT_TIMEOUT_MS = 100_000;

const REQUEST_FIELDS = new Set(["v", "id", "op", "target", "keep"]);

export interface LifecycleRequest {
  v: 1;
  id: string;
  op: LifecycleOp;
  target: string;
  /** `ib merge --keep`; valid for `merge` only. */
  keep?: boolean;
}

/** What the CLI asks for; the request id is added by the client. */
export type LifecycleCommand =
  | { op: "retire"; target: string }
  | { op: "merge"; target: string; keep?: boolean }
  | { op: "rehire"; target: string };

type ParsedLifecycleRequest = { ok: true; request: LifecycleRequest } | { ok: false; error: string };

/** Strictly parse an untrusted request; only the allowlisted fields survive. */
export function parseLifecycleRequest(text: string, expectedId: string): ParsedLifecycleRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "lifecycle request is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "lifecycle request must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!REQUEST_FIELDS.has(key)) return { ok: false, error: `lifecycle request has unsupported field '${key}'` };
  }
  if (obj.v !== 1) return { ok: false, error: "unsupported lifecycle request version" };
  if (obj.id !== expectedId) return { ok: false, error: "lifecycle request id does not match its file name" };
  if (typeof obj.op !== "string" || !(LIFECYCLE_OPS as readonly string[]).includes(obj.op)) {
    return { ok: false, error: "lifecycle request has an unsupported op" };
  }
  // The target becomes a path segment and a command argument: a plain agent id only.
  if (typeof obj.target !== "string" || !isValidAgentId(obj.target)) {
    return { ok: false, error: "lifecycle request has an invalid target" };
  }
  if (obj.keep !== undefined && (obj.op !== "merge" || typeof obj.keep !== "boolean")) {
    return { ok: false, error: "lifecycle request has an invalid keep" };
  }
  return {
    ok: true,
    request: {
      v: 1,
      id: expectedId,
      op: obj.op as LifecycleOp,
      target: obj.target,
      ...(obj.keep === true ? { keep: true } : {}),
    },
  };
}

// ── Client (runs inside the sandbox) ─────────────────────────────────────────

/**
 * Ask the calling agent's watchdog to run a lifecycle command, and wait for the
 * answer. Fails at once when the watchdog is not live, and after
 * LIFECYCLE_CLIENT_TIMEOUT_MS when it is live but does not answer.
 */
export async function requestLifecycleViaWatchdog(
  command: LifecycleCommand,
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult> {
  const { op, target } = command;
  // `ib rehire` takes the id straight from the command line; refuse a bad one
  // here, with the direct path's message, rather than queue it.
  if (!isValidAgentId(target)) return brokerFail(`Invalid agent id: ${target}`);

  let caller: ResolvedCallerContext | null;
  try {
    caller = await (deps.resolveCaller ?? resolveCallerAgentContext)(deps.cwd ?? process.cwd());
  } catch (err) {
    return brokerFail(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!caller || !caller.agentDir || typeof caller.meta.id !== "string") {
    return brokerFail(
      `Error: cannot run 'ib ${op}' from inside the sandbox: this shell is not inside a registered agent, ` +
        `so there is no agent watchdog to ask. Run \`ib ${op}\` from an agent's own worktree.`,
    );
  }
  const callerId = caller.meta.id;

  // Tell "no watchdog" from "slow watchdog" up front, without waiting.
  const live = await (deps.watchdogLive ?? hasLiveWatchdog)(caller.agentDir);
  if (!live) {
    return brokerFail(
      `Error: cannot run 'ib ${op}' from inside the sandbox: the watchdog for '${callerId}' is not running ` +
        `(no fresh heartbeat), and the watchdog is what runs this command for a sandboxed agent. Restart this ` +
        `agent so its watchdog starts, then retry.`,
    );
  }

  // Field order matters for one case: a watchdog that predates this broker
  // parses every request as a spawn and names the first field it does not know.
  const request: LifecycleRequest = {
    v: 1,
    id: randomBytes(16).toString("hex"),
    op,
    target,
    ...(command.op === "merge" && command.keep ? { keep: true } : {}),
  };
  const result = await submitWatchdogRequest(
    caller.agentDir,
    callerId,
    request,
    {
      request: op,
      action: `${op} '${target}'`,
      alreadyStarted: `The watchdog had already started the ${op}, so it may still finish — check \`ib list\`.`,
    },
    deps.timeoutMs ?? LIFECYCLE_CLIENT_TIMEOUT_MS,
    deps,
  );
  if (!result.ok && result.stderr.includes("spawn request has unsupported field 'op'")) {
    return brokerFail(
      `Error: the watchdog for '${callerId}' predates sandboxed 'ib ${op}'. Restart this agent so its ` +
        `watchdog picks up the feature, then retry.`,
    );
  }
  return result;
}

/**
 * The lifecycle-command entry point. Returns null when the caller must run the
 * command directly, exactly as before this broker existed. Only one kind of
 * caller is routed to the watchdog: a worktree agent inside its own itsybitsy
 * sandbox. Everyone else keeps the direct path:
 *   - a process that is not sandboxed;
 *   - a sandboxed shell that is not (or cannot be shown to be) an agent;
 *   - a `worktree:false` agent — its profile grants the repo root, so the
 *     direct path works, and its per-agent watchdog exits at once (there is no
 *     `<agentDir>/repo`), so there is nobody to ask;
 *   - an agent whose itsybitsy sandbox is disabled. `isSandboxedProcess()` is
 *     still true for a codex agent there (codex's own sandbox), which grants
 *     what these commands need; and such an agent has no seal to verify.
 * This only ROUTES. A caller that lies in its own meta.json to get the direct
 * path runs the command inside its real sandbox, where it fails as before.
 */
export async function routeLifecycleThroughWatchdog(
  command: LifecycleCommand,
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult | null> {
  if (!isSandboxedProcess()) return null;
  let caller: ResolvedCallerContext | null;
  try {
    caller = await (deps.resolveCaller ?? resolveCallerAgentContext)(deps.cwd ?? process.cwd());
  } catch {
    return null;
  }
  if (!caller || !caller.agentDir) return null;
  if (caller.meta.worktree === false) return null;
  const sandbox = caller.meta.sandbox as { enabled?: unknown } | undefined;
  if (!resolveSandboxEnabled(sandbox?.enabled)) return null;
  const resolved = caller;
  return requestLifecycleViaWatchdog(command, { ...deps, resolveCaller: async () => resolved });
}

// ── Server (runs in the unsandboxed watchdog) ────────────────────────────────

export interface LifecycleServerDeps {
  /** Returns the deny reason, or null when the caller may run `op` on the target. */
  authorize?: (
    op: LifecycleOp,
    targetId: string,
    callerId: string,
    agentsDir: string,
    callerMeta: Record<string, unknown>,
  ) => Promise<string | null>;
  findAgent?: (repoPath: string, agentId: string) => Promise<Agent | null>;
  retire?: (agent: Agent) => Promise<IbCommandResult>;
  merge?: (agent: Agent, targetDir: string, options: MergeAgentOptions) => Promise<IbCommandResult>;
  rehire?: (agentId: string, opts: { repoPath: string }) => Promise<IbCommandResult>;
}

/**
 * The rule for a direct command, reused: the PreToolUse hook's manager rule, so
 * the brokered and the direct path cannot disagree about who may act on an
 * agent. It is called with structured arguments (a synthesized command line
 * would be re-parsed, and a target such as `-v` would read as a flag and skip
 * the rule), with the VERIFIED caller meta (the rule must not read the caller's
 * file again after the seal check), and, for a rehire, against the archive of
 * the requester's repo only (an active record is something a spawner can write).
 */
async function authorizeLifecycle(
  op: LifecycleOp,
  targetId: string,
  callerId: string,
  agentsDir: string,
  callerMeta: Record<string, unknown>,
): Promise<string | null> {
  const { checkManagerCommandAccess } = await import("./hooks/agent-path");
  const decision = await checkManagerCommandAccess(op, targetId, callerId, agentsDir, {
    callerMeta,
    ownArchiveOnly: op === "rehire",
  });
  return decision ? decision.reason : null;
}

/**
 * Resolve an exact agent id inside one repository only. The record must be the
 * one stored in the directory ENTRY named exactly `agentId`, and its own
 * `meta.id` must say the same. `meta.id` alone is not an identity: an agent can
 * write its own meta.json. readAllAgents lists real directories under their
 * on-disk names, so neither a case variant of an id (macOS volumes are
 * case-insensitive), nor a symlink, nor a record that claims another agent's
 * id can match.
 */
async function findAgentInRepo(repoPath: string, agentId: string): Promise<Agent | null> {
  const repo = (await listRepos()).find((entry) => resolve(entry.path) === resolve(repoPath));
  const name = repo ? repoDisplayName(repo) : basename(repoPath);
  const { agents } = await readAllAgents([{ path: repoPath, name }], false);
  const directory = join(repoPath, ".ittybitty", "agents", agentId);
  return agents.find((agent) => agent.storageDir === directory && agent.id === agentId) ?? null;
}

/** Do two paths name the same directory? Unknown (either cannot be resolved) counts as yes. */
async function isSameDirectory(a: string, b: string): Promise<boolean> {
  try {
    const [resolvedA, resolvedB] = await Promise.all([realpath(a), realpath(b)]);
    return resolvedA === resolvedB;
  } catch {
    return true;
  }
}

/**
 * Handle one lifecycle request on behalf of `agentId`. Called by the spawn
 * broker's queue handler, which has already consumed the request file.
 */
export async function handleLifecycleRequest(
  ctx: { agentId: string; repoPath: string; agentDir: string; id: string; text: string },
  deps: SpawnServerDeps,
): Promise<IbCommandResult> {
  const parsed = parseLifecycleRequest(ctx.text, ctx.id);
  if (!parsed.ok) return brokerFail(`Error: ${parsed.error}`);
  const request = parsed.request;
  const { op, target } = request;

  // Identity comes from the agent's own sealed record, never from the request.
  const requester = await verifyBrokerRequester(ctx.agentId, ctx.repoPath, ctx.agentDir, op, deps);
  if (!requester.ok) return requester.result;

  // An agent is never its own target. The rule reads `manager` from the
  // TARGET's meta.json; for a self-target that is the requester's own file,
  // which it can write, so it could name itself its own manager.
  if (target === ctx.agentId) {
    return brokerFail(`Error: '${ctx.agentId}' cannot ${op} itself`);
  }

  const seams = deps.lifecycle ?? {};
  const agentsDir = join(ctx.repoPath, ".ittybitty", "agents");
  const authorize = (): Promise<string | null> =>
    (seams.authorize ?? authorizeLifecycle)(
      op,
      target,
      ctx.agentId,
      agentsDir,
      requester.meta as unknown as Record<string, unknown>,
    );
  try {
    // A rehire target is an archive, not an active agent. Only the requester's
    // own repo is searched, and only its archive decides.
    if (op === "rehire") {
      const denied = await authorize();
      if (denied) return brokerFail(denied);
      return await (seams.rehire ?? rehireAgent)(target, { repoPath: ctx.repoPath });
    }

    // Resolve the target FIRST, by its directory. Everything after this point
    // — the rule's read of the target's meta.json and the command itself —
    // then acts on a directory that is known to exist under exactly this name
    // and is known not to be the requester's own.
    const agent = await (seams.findAgent ?? findAgentInRepo)(ctx.repoPath, target);
    if (!agent) {
      return brokerFail(
        `Error: agent '${target}' is not in the repository of '${ctx.agentId}'; a sandboxed agent can ${op} only agents in its own repo`,
      );
    }
    // The string compare above is not enough on a case-insensitive volume,
    // where `Agent-X` opens the directory of `agent-x`.
    if (await isSameDirectory(agent.storageDir ?? join(agentsDir, target), ctx.agentDir)) {
      return brokerFail(`Error: '${ctx.agentId}' cannot ${op} itself`);
    }

    const denied = await authorize();
    if (denied) return brokerFail(denied);

    if (op === "merge") {
      // The merge is aimed at the requester's own worktree. The directory is
      // fixed by the agent's id — not by the request, and not by
      // `meta.worktree`, which the requester can write and the seal does not
      // cover (it would otherwise choose the main checkout as the target).
      // lstat: a symlink there is refused too, or the agent could point it at
      // the main checkout. This is a check before use, not a lock: mergeAgent
      // then uses the same PATH for several seconds, and the requester owns
      // the parent directory (SPEC-SANDBOX §4C.7, limitation 5).
      const callerWorktree = join(ctx.agentDir, "repo");
      const isDirectory = await lstat(callerWorktree).then((entry) => entry.isDirectory()).catch(() => false);
      if (!isDirectory) {
        return brokerFail(`Error: '${ctx.agentId}' has no worktree to merge into (${callerWorktree})`);
      }
      return await (seams.merge ?? mergeAgent)(agent, callerWorktree, {
        keep: request.keep === true,
        _brokeredCaller: { cwd: callerWorktree },
      });
    }
    return await (seams.retire ?? retireAgent)(agent);
  } catch (err) {
    return brokerFail(`Error: ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
