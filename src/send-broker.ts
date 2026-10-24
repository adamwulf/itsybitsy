/**
 * Watchdog send broker — how a SANDBOXED agent sends to an agent in another repo.
 *
 * Writing the message is not the problem: outboxes live in
 * `~/.itsybitsy/agents/<id>/` (outbox.ts), which the sandbox grants. Finding
 * the target is. `ib send` resolves it with readAllAgents, which lists the
 * `.ittybitty/agents` directory of every registered repo. A worktree agent's
 * profile grants that directory for its own repo only, so every other repo
 * fails with EPERM and the target is reported as not found.
 *
 * The answer is the one `ib ask`, the lifecycle commands and `ib new-agent`
 * already use (ask-broker.ts, lifecycle-broker.ts, spawn-broker.ts): the
 * agent's WATCHDOG runs unsandboxed, so the sandboxed command hands it the
 * request and waits. The queue, the file format and the at-most-once handling
 * are the spawn broker's; a request with `op: "send"` is dispatched here.
 *
 *   sandboxed `ib send <target>`  ──request.json──▶  the caller's own watchdog
 *        (client, this file)                          (server, this file)
 *                                 ◀──result.json───   resolves the target, sends
 *
 * Who uses it: the same callers as the ask and lifecycle brokers — only a
 * WORKTREE agent whose itsybitsy sandbox is enabled (`resolveRoutedCaller`).
 * Every other caller sends directly, as before.
 *
 * Fallback: a routed caller can still send directly to an agent of its own
 * repo, so `ib send` must not work less well than before the broker. When the
 * watchdog is not live, or predates this broker (it refuses the request before
 * it does anything), the CLI sends directly. When a current watchdog has taken
 * the request, it does not: the message may already be queued, and a second
 * send would deliver it twice.
 *
 * Trust model: the request is untrusted DATA and carries only the target and
 * the message text — never a sender, an agent id of the caller, a repo or a
 * path. The watchdog sends as its OWN agent (verified against the sealed
 * record, as for a spawn) and passes that id as `fromAgent`, so a request
 * cannot send in another agent's name; `--from` for another agent is refused
 * on the client. The watchdog never delivers to the requester itself: a
 * recipient's `tmux_session` and heartbeat are files that agent can write, so
 * a send to itself would let it choose where the unsandboxed watchdog types
 * its text. A send to itself therefore stays on the direct path (isAgentAt,
 * targetIsCaller). Files never cross: the client reads `-f <path>` and stdin
 * inside the sandbox, and the watchdog never reads a path for the agent. It
 * also never sets `stageAttachments` (send-time attachment staging copies the
 * files a message names; outside the sandbox that would let an agent copy out
 * any file the watchdog can read).
 */

import { randomBytes } from "crypto";
import { join, resolve } from "path";
import type { Agent } from "./agents";
import {
  hasLiveWatchdog,
  resolveCallerAgentContext,
  sendMessage,
  teamSend,
  type IbCommandResult,
  type ResolvedCallerContext,
} from "./ib-commands";
import { listRepos, type RepoEntry } from "./registry";
import { resolveSendTarget, type ResolvedSendTarget } from "./resolve-target";
import {
  SPAWN_CLIENT_TIMEOUT_MS,
  SPAWN_MAX_PROMPT_BYTES,
  brokerFail,
  isSameDirectory,
  resolveRoutedCaller,
  submitWatchdogRequest,
  verifyBrokerRequester,
  type SpawnClientDeps,
  type SpawnServerDeps,
} from "./spawn-broker";

/** The `op` that marks a request in the watchdog queue as a message to send. */
export const SEND_OP = "send";

/** Longest target accepted: an agent id or nickname, `@repo/agent`, a team. */
export const SEND_MAX_TARGET_CHARS = 256;

const REQUEST_FIELDS = new Set(["v", "id", "op", "target", "message"]);
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * What a watchdog that predates this broker answers, exactly. It refuses the
 * request before doing anything, so the client may still send directly.
 * One without any op broker parses the request as a spawn; one with the
 * lifecycle broker (and maybe the ask broker) parses it as a lifecycle request,
 * which stops at `message`, the first field it does not know.
 */
const OLD_WATCHDOG_ANSWERS = new Set([
  "Error: spawn request has unsupported field 'op'",
  "Error: lifecycle request has unsupported field 'message'",
]);

export interface SendRequest {
  v: 1;
  id: string;
  op: typeof SEND_OP;
  target: string;
  message: string;
}

type ParsedSendRequest = { ok: true; request: SendRequest } | { ok: false; error: string };

/** A target the request can carry: any text the CLI could resolve, bounded and without control characters. */
function isBrokerableTarget(target: unknown): target is string {
  return (
    typeof target === "string" &&
    target.length > 0 &&
    target.length <= SEND_MAX_TARGET_CHARS &&
    !CONTROL_CHARS.test(target)
  );
}

/** Where an agent lives: its id, its repo and its own agent directory. */
interface AgentLocation {
  id: string;
  repoPath: string;
  agentDir: string;
}

/**
 * Is `agent` the agent at `self`? By id within the same repo, and by resolved
 * directory: the id in a meta.json is that agent's own to write (an agent can
 * give itself another agent's id), and on a case-insensitive volume a case
 * variant opens the same directory. Unknown counts as yes (isSameDirectory).
 *
 * Why it matters: a recipient's `tmux_session` and watchdog heartbeat come
 * from files that agent can write, and the seal does not cover them. Sending
 * to the requester itself would let a sandboxed agent choose both the text and
 * the tmux session that its UNSANDBOXED watchdog types it into.
 */
async function isAgentAt(agent: Agent, self: AgentLocation): Promise<boolean> {
  if (agent.id === self.id && resolve(agent.repoPath) === resolve(self.repoPath)) return true;
  return isSameDirectory(agent.storageDir ?? join(agent.repoPath, ".ittybitty", "agents", agent.id), self.agentDir);
}

/** Strictly parse an untrusted request; only the allowlisted fields survive. */
export function parseSendRequest(text: string, expectedId: string): ParsedSendRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "send request is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "send request must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!REQUEST_FIELDS.has(key)) return { ok: false, error: `send request has unsupported field '${key}'` };
  }
  if (obj.v !== 1) return { ok: false, error: "unsupported send request version" };
  if (obj.id !== expectedId) return { ok: false, error: "send request id does not match its file name" };
  if (obj.op !== SEND_OP) return { ok: false, error: "send request has an unsupported op" };
  if (!isBrokerableTarget(obj.target)) {
    return { ok: false, error: "send request has an invalid target" };
  }
  // Empty only, as on the direct path (`ib send` refuses "" and nothing else).
  if (typeof obj.message !== "string" || obj.message === "") {
    return { ok: false, error: "send request needs a non-empty message" };
  }
  if (Buffer.byteLength(obj.message, "utf8") > SPAWN_MAX_PROMPT_BYTES) {
    return { ok: false, error: "send request message is too large" };
  }
  return { ok: true, request: { v: 1, id: expectedId, op: SEND_OP, target: obj.target, message: obj.message } };
}

// ── Client (runs inside the sandbox) ─────────────────────────────────────────

/**
 * Ask the calling agent's watchdog to resolve `target` and send `message` as
 * the caller, and wait for the answer. Returns null when the watchdog did not
 * take the request — it is not live, or it predates this broker — and the
 * caller must send directly instead. Gives up after SPAWN_CLIENT_TIMEOUT_MS
 * (30s) when the watchdog is live but does not answer; that is an error, not a
 * fallback.
 */
export async function requestSendViaWatchdog(
  target: string,
  message: string,
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult | null> {
  let caller: ResolvedCallerContext | null;
  try {
    caller = await (deps.resolveCaller ?? resolveCallerAgentContext)(deps.cwd ?? process.cwd());
  } catch (err) {
    return brokerFail(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!caller || !caller.agentDir || typeof caller.meta.id !== "string") {
    return brokerFail(
      "Error: cannot run 'ib send' through the watchdog: this shell is not inside a registered agent, " +
        "so there is no agent watchdog to ask. Run `ib send` from an agent's own worktree.",
    );
  }
  const callerId = caller.meta.id;

  // The request cannot carry these. The direct path has no such limits, and
  // reaches what it reached before (the caller's own repo).
  if (!isBrokerableTarget(target) || Buffer.byteLength(message, "utf8") > SPAWN_MAX_PROMPT_BYTES) {
    return null;
  }

  // No watchdog to take the request: send directly, as before.
  const live = await (deps.watchdogLive ?? hasLiveWatchdog)(caller.agentDir);
  if (!live) return null;

  // Field order matters for one case: a watchdog that predates this broker
  // names the first field it does not know (see OLD_WATCHDOG_ANSWERS).
  const request: SendRequest = { v: 1, id: randomBytes(16).toString("hex"), op: SEND_OP, target, message };
  const result = await submitWatchdogRequest(
    caller.agentDir,
    callerId,
    request,
    {
      request: "send",
      action: `send the message to '${target}'`,
      alreadyStarted:
        "The watchdog had already taken the message, so it may still be delivered; check with the recipient before sending it again.",
    },
    deps.timeoutMs ?? SPAWN_CLIENT_TIMEOUT_MS,
    deps,
  );
  if (!result.ok && OLD_WATCHDOG_ANSWERS.has(result.stderr)) return null;
  return result;
}

/** What `ib send` hands the broker. */
export interface SendCommand {
  target: string;
  /** `--from`, when given. */
  fromAgent?: string;
  /** Reads the message (inline, `-f <path>`, or stdin), inside the sandbox. */
  readMessage: () => Promise<string>;
  /** Printed when there is no message, as on the direct path. */
  usage: string;
  /** The registered repos (`listRepos()`), to tell a send to the caller itself. */
  repos: RepoEntry[];
}

/**
 * Does `target` resolve to the caller itself? Resolved with the CLI's own
 * resolver over the caller's repo only. That is enough: a target that resolves
 * to the caller does so in its own repo (a bare id or nickname is looked up
 * there first; `@<repo>/<id>`, `@<repo>` and `@coordinator` name that repo),
 * and that repo is readable inside the sandbox while other repos are not.
 */
async function targetIsCaller(target: string, caller: ResolvedCallerContext, repos: RepoEntry[]): Promise<boolean> {
  if (typeof caller.meta.id !== "string") return false;
  const ownRepo = repos.filter((r) => resolve(r.path) === resolve(caller.repoPath));
  if (ownRepo.length === 0) return false;
  try {
    const { agent } = await resolveSendTarget(target, ownRepo, join(caller.agentDir, "repo"));
    return agent !== null && (await isAgentAt(agent, { id: caller.meta.id, repoPath: caller.repoPath, agentDir: caller.agentDir }));
  } catch {
    return false; // the watchdog refuses a send to its requester anyway
  }
}

/**
 * The `ib send` entry point. Returns null when the caller must send directly,
 * exactly as before this broker existed: every caller that
 * `resolveRoutedCaller` does not route, a routed caller that sends to itself
 * (its own repo and outbox are reachable in the sandbox, and the watchdog
 * refuses it), and a routed caller whose watchdog does not take the request
 * (see requestSendViaWatchdog). A routed caller sends only as itself: its
 * watchdog serves its own agent and nobody else.
 */
export async function routeSendThroughWatchdog(
  command: SendCommand,
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult | null> {
  const caller = await resolveRoutedCaller(deps);
  if (!caller) return null;
  if (command.fromAgent !== undefined && command.fromAgent !== caller.meta.id) {
    return brokerFail(
      "Error: --from for another agent is not supported inside the sandbox: a sandboxed agent sends only as itself, through its watchdog.",
    );
  }
  if (await targetIsCaller(command.target, caller, command.repos)) return null;
  const message = await command.readMessage();
  if (!message) return brokerFail(command.usage);
  return requestSendViaWatchdog(command.target, message, { ...deps, resolveCaller: async () => caller });
}

// ── Server (runs in the unsandboxed watchdog) ────────────────────────────────

/** Seams for the `ib send` request handled here. */
export interface SendServerDeps {
  listRepos?: () => Promise<RepoEntry[]>;
  resolveTarget?: (
    target: string,
    repos: RepoEntry[],
    cwd: string,
  ) => Promise<ResolvedSendTarget & { error?: string }>;
  sendMessage?: (agent: Agent, message: string, opts: { fromAgent: string }) => Promise<IbCommandResult>;
  teamSend?: (
    teamName: string,
    members: Agent[],
    message: string,
    opts: { fromAgent: string; excludeRecipient: (agent: Agent) => Promise<boolean> },
    repos: RepoEntry[],
  ) => Promise<IbCommandResult>;
  sendToSystemCoordinator?: (message: string, opts: { fromAgent: string; cwd: string }) => Promise<IbCommandResult>;
}

/** `@system`: the CLI's own function (lazy import, as the watchdog's notifications do). */
async function sendToSystemCoordinatorDefault(
  message: string,
  opts: { fromAgent: string; cwd: string },
): Promise<IbCommandResult> {
  const { sendToSystemCoordinator } = await import("./index");
  return sendToSystemCoordinator(message, opts);
}

/**
 * Handle one send request on behalf of `agentId`. Called by the spawn
 * broker's queue handler, which has already consumed the request file.
 */
export async function handleSendRequest(
  ctx: { agentId: string; repoPath: string; agentDir: string; id: string; text: string },
  deps: SpawnServerDeps,
): Promise<IbCommandResult> {
  const parsed = parseSendRequest(ctx.text, ctx.id);
  if (!parsed.ok) return brokerFail(`Error: ${parsed.error}`);
  const { target, message } = parsed.request;

  // Identity comes from the agent's own sealed record, never from the request.
  const requester = await verifyBrokerRequester(ctx.agentId, ctx.repoPath, ctx.agentDir, "send", deps);
  if (!requester.ok) return requester.result;

  const seams = deps.send ?? {};
  const fromAgent = ctx.agentId;
  const self: AgentLocation = { id: ctx.agentId, repoPath: ctx.repoPath, agentDir: ctx.agentDir };
  // Where the requester "is": its own worktree, the cwd of a direct `ib send`
  // there. It decides `@coordinator` and the same-repo-first search of a bare
  // id; the watchdog's own cwd says nothing about the requester.
  const callerCwd = join(ctx.agentDir, "repo");
  try {
    const repos = await (seams.listRepos ?? listRepos)();
    const resolved = await (seams.resolveTarget ?? resolveSendTarget)(target, repos, callerCwd);
    if (resolved.error) return brokerFail(resolved.error);
    // The ordinary commands, as the watchdog's own agent. `fromAgent` is
    // always passed: these functions otherwise detect the sender from the
    // cwd, which here is the watchdog's. `stageAttachments` is never set.
    if (resolved.isSystemCoordinator) {
      return await (seams.sendToSystemCoordinator ?? sendToSystemCoordinatorDefault)(message, { fromAgent, cwd: callerCwd });
    }
    // Never deliver to the requester itself (see isAgentAt). A team drops it
    // like the sender; a single target is refused.
    const excludeRecipient = (agent: Agent): Promise<boolean> => isAgentAt(agent, self);
    if (resolved.team) {
      return await (seams.teamSend ?? teamSend)(
        resolved.team.name,
        resolved.team.members,
        message,
        { fromAgent, excludeRecipient },
        repos,
      );
    }
    if (!resolved.agent) return brokerFail(`Agent not found: ${target}`);
    if (await excludeRecipient(resolved.agent)) {
      return brokerFail(`Error: '${ctx.agentId}' cannot send to itself through its watchdog; send directly`);
    }
    return await (seams.sendMessage ?? sendMessage)(resolved.agent, message, { fromAgent });
  } catch (err) {
    return brokerFail(`Error: send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
