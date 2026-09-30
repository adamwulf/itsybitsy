/**
 * Watchdog lifecycle broker — how a SANDBOXED agent retires or merges a child
 * agent.
 *
 * A sandboxed manager cannot do this work itself. Its profile grants its own
 * agent dir, its worktree, the repo's git dir and `<repo>/.ittybitty/agents`,
 * but NOT the main repo root or `<repo>/.ittybitty/archive`. The lifecycle code
 * runs `git -C <main repo> ...` (which dies with `Unable to read current working
 * directory: Operation not permitted`) and moves the agent into the archive, so
 * a direct `ib retire` or `ib merge` fails inside the sandbox.
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
 * Trust model: the request is untrusted DATA and carries only an op and a target
 * id. The watchdog takes the caller's identity from its own agent (verified
 * against the sealed record, as for a spawn) and applies the SAME rule the
 * PreToolUse hook applies to a direct command — `checkIbCommandAccess`: only the
 * target's manager or spawner (or the repo's coordinator) may act on it. The
 * hook alone is not enough here, because a sandboxed agent can write a request
 * file without running `ib`. The target must be in the caller's own repo, and a
 * merge lands in the caller's own worktree (the request cannot name a directory).
 *
 * Known limitation (SPEC-SANDBOX §4C.6): that rule reads `manager` /
 * `spawned_by` from the TARGET's meta.json, which a spawner can write (it holds
 * a write grant on `.ittybitty/agents`) and which the seal does not cover. A
 * spawner can therefore make itself the manager of any agent in its repo.
 */

import { randomBytes } from "crypto";
import { basename, join, resolve } from "path";
import { readAllAgents, type Agent } from "./agents";
import {
  hasLiveWatchdog,
  mergeAgent,
  resolveCallerAgentContext,
  retireAgent,
  type IbCommandResult,
  type MergeAgentOptions,
  type ResolvedCallerContext,
} from "./ib-commands";
import { listRepos, repoDisplayName } from "./registry";
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
export const LIFECYCLE_OPS = ["retire", "merge"] as const;
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
  | { op: "merge"; target: string; keep?: boolean };

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
 * The lifecycle-command entry point for a sandboxed process. Returns null when
 * the process is NOT sandboxed (the caller then runs the command directly,
 * exactly as before).
 */
export async function routeLifecycleThroughWatchdog(
  command: LifecycleCommand,
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult | null> {
  if (!isSandboxedProcess()) return null;
  return requestLifecycleViaWatchdog(command, deps);
}

// ── Server (runs in the unsandboxed watchdog) ────────────────────────────────

export interface LifecycleServerDeps {
  /** Returns the deny reason, or null when the caller may run `op` on the target. */
  authorize?: (op: LifecycleOp, targetId: string, callerId: string, agentsDir: string) => Promise<string | null>;
  findAgent?: (repoPath: string, agentId: string) => Promise<Agent | null>;
  retire?: (agent: Agent) => Promise<IbCommandResult>;
  merge?: (agent: Agent, targetDir: string, options: MergeAgentOptions) => Promise<IbCommandResult>;
}

/**
 * The rule for a direct command, reused as-is: the PreToolUse hook's
 * `checkIbCommandAccess` on the equivalent command line, so the brokered and
 * the direct path can never disagree about who may act on an agent.
 */
async function authorizeLifecycle(
  op: LifecycleOp,
  targetId: string,
  callerId: string,
  agentsDir: string,
): Promise<string | null> {
  const { checkIbCommandAccess } = await import("./hooks/agent-path");
  const decision = await checkIbCommandAccess(`ib ${op} ${targetId}`, callerId, agentsDir);
  return decision?.decision === "deny" ? decision.reason : null;
}

/** Resolve an exact agent id inside one repository only. */
async function findAgentInRepo(repoPath: string, agentId: string): Promise<Agent | null> {
  const repo = (await listRepos()).find((entry) => resolve(entry.path) === resolve(repoPath));
  const name = repo ? repoDisplayName(repo) : basename(repoPath);
  const { agents } = await readAllAgents([{ path: repoPath, name }], false);
  return agents.find((agent) => agent.id === agentId) ?? null;
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

  const seams = deps.lifecycle ?? {};
  const agentsDir = join(ctx.repoPath, ".ittybitty", "agents");
  try {
    const denied = await (seams.authorize ?? authorizeLifecycle)(op, target, ctx.agentId, agentsDir);
    if (denied) return brokerFail(denied);

    const agent = await (seams.findAgent ?? findAgentInRepo)(ctx.repoPath, target);
    if (!agent) {
      return brokerFail(
        `Error: agent '${target}' is not in the repository of '${ctx.agentId}'; a sandboxed agent can ${op} only agents in its own repo`,
      );
    }
    if (op === "merge") {
      // The merge lands where the requester is: its worktree, or the repo root
      // for a worktree:false agent. Never a directory named by the request.
      const callerCwd = requester.meta.worktree === false ? ctx.repoPath : join(ctx.agentDir, "repo");
      return await (seams.merge ?? mergeAgent)(agent, callerCwd, {
        keep: request.keep === true,
        _brokeredCaller: { cwd: callerCwd },
      });
    }
    return await (seams.retire ?? retireAgent)(agent);
  } catch (err) {
    return brokerFail(`Error: ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
