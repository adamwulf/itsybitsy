import { cliActorId, localCliActor, localHumanInCheckout, verifiedSendCaller } from "./peers/send-caller";
import { isCoordinatorType } from "./coordinator-type-names";
import { isAgentSendProcess } from "./peers/remote-start-caller";
import type { LocalQueueGuard } from "./outbox";
import { openBrokerResults, pinnedPath } from "./pinned-directory";
import { cancellationPoll, cancellationMarkerExists } from "./send-cleanup";
import { inspectBrokerLease, stagingOwnerStart, transferOwnerState, type TransferOwner, reclaimTransfer, transferDirectoryBatch } from "./peers/transfer-owner";
import { trackSendCleanup, warnSendCleanup } from "./send-cleanup";
import * as runtimeNames from "./runtime-names";
/**
 * Watchdog send broker — how a SANDBOXED agent sends to an agent in another repo.
 *
 * The sandbox grants writes to the recipient's queue directory (SPEC §4.1.1).
 * `ib send` resolves the recipient by listing the
 * `.itsybitsy/agents` directory of every registered repo. A worktree agent's
 * profile grants that directory for its own repo only, so every other repo
 * fails with EPERM and the target is reported as not found. `@system` is new
 * reach: its outbox is in `~/.itsybitsy/` itself and its delivery needs tmux,
 * so a sandboxed agent could not message it before (SPEC-SANDBOX §4C.9).
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
 * Local sends retain the existing sandboxed worktree broker and direct paths.
 * A remote user or @system sends directly through peer-outbox. A verified
 * shared-checkout repo coordinator sends directly only outside the sandbox.
 * On every CLI and sandbox configuration a worktree agent submits a
 * remote-send request to its watchdog. The watchdog checks the requester
 * and its repo registration, resolves the raw address with full visibility,
 * and publishes only a remote match. Explicitly disabled worktrees have no
 * seal and require a genuine missing seal plus the Git worktree backlink.
 *
 * Trust model: the request is untrusted DATA and carries only the target and
 * the message text — never a sender, an agent id of the caller, a repo or a
 * source path to open. Remote manifests also carry file metadata and rewrite
 * spellings. The watchdog reads only numbered, private request files. It sends as its OWN agent (verified against the sealed
 * record, as for a spawn) and passes that id as `fromAgent`, so a request
 * cannot send in another agent's name; `--from` for another agent is refused
 * on the client. The watchdog never types into the requester’s tmux session: a
 * recipient's `tmux_session` and heartbeat are files that agent can write, so
 * a send to itself would let it choose where the unsandboxed watchdog types
 * its text. Text-only self-sends use the direct path. A brokered attachment
 * self-send only appends to the requester’s queue for the regular drain. For local sends, the client reads `-f <path>` and stdin
 * inside the sandbox, and the watchdog never reads a path for the agent. It
 * also never sets `stageAttachments` (send-time attachment staging copies the
 * files a message names; outside the sandbox that would let an agent copy out
 * any file the watchdog can read).
 */

import { waitForIO, type FileBodyOptions, encodeSendHeader, parseSendHeader, type SendHeader, type SendTarget } from "./peers/send-frame";
import { readMachineName } from "./machine-name";
import { mkdir, open, rm, stat, rename } from "node:fs/promises";
import { readTransferLimits } from "./config";
import { checkIncomingFiles, IDLE_TIMEOUT_MS } from "./peers/transfer-limits";
import { prepareLocalBrokerAttachments, brokerAttachmentStage, publishBrokerRecord, createBrokerProgress, removeAbandonedStaging, remoteAttachmentStage, type StageRemoteFiles } from "./peers/remote-attachments";
import type { AttachmentSender } from "./peers/local-attachments";
import { metaKernelSandboxed } from "./sandbox";
import { isSandboxedProcess } from "./sandbox-detect";
import { sameRepoPath } from "./repo-identity";
import { randomBytes } from "crypto";
import { join } from "path";
import { type Agent } from "./agents";
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
  resolveRoutedCaller, interruptedSend,
  spawnResultDir, submitWatchdogRequest,
  verifyBrokerRequester,
  type SpawnClientDeps,
  type SpawnServerDeps,
} from "./spawn-broker";

/** The `op` that marks a request in the watchdog queue as a message to send. */
export const SEND_OP = "send";

/** Longest target accepted: an agent id or nickname, `@repo/agent`, a team. */
export const SEND_MAX_TARGET_CHARS = 256;

const LOCAL_TARGET_EXIT = 66; // Private broker result: no remote handoff was attempted.
const LOCAL_REMOTE_TARGET = "The target resolves locally. Use @<repo>/<agent> for a local send or <machine>/<repo>/<agent> for a remote send.";
const REQUEST_FIELDS = new Set(["v", "id", "op", "target", "message", "noPassthrough", "files", "clientPid"]);
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
  op: typeof SEND_OP | "remote-send" | "local-attachment-send";
  target: string;
  message: string;
  noPassthrough?: true;
  files?: SendHeader["files"];
  clientPid?: number;
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
  if (agent.id === self.id && sameRepoPath(agent.repoPath, self.repoPath)) return true;
  return isSameDirectory(agent.storageDir ?? runtimeNames.agentDir(agent.repoPath, agent.id), self.agentDir);
}

async function verifiedSelfRecipient(agent: Agent, self: AgentLocation): Promise<boolean> {
  const path = agent.storageDir ?? runtimeNames.agentDir(agent.repoPath, agent.id);
  try {
    const [target, caller] = await Promise.all([stat(path, { bigint: true }), stat(self.agentDir, { bigint: true })]);
    if (target.isDirectory() && caller.isDirectory()) return target.dev === caller.dev && target.ino === caller.ino;
  } catch (error) { throw Error("Cannot verify the local attachment recipient directory", { cause: error }); }
  throw Error("Cannot verify the local attachment recipient directory");
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
  if (obj.op !== SEND_OP && obj.op !== "remote-send" && obj.op !== "local-attachment-send") return { ok: false, error: "send request has an unsupported op" };
  const pid = obj.clientPid;
  if (obj.op !== SEND_OP ? typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 : pid !== undefined) {
    return { ok: false, error: "invalid remote send client PID" };
  }
  if (obj.noPassthrough !== undefined && (obj.noPassthrough !== true || obj.op !== SEND_OP)) {
    return { ok: false, error: "invalid noPassthrough for send request" };
  }
  if (!isBrokerableTarget(obj.target)) {
    return { ok: false, error: "send request has an invalid target" };
  }
  // Empty only, as on the direct path (`ib send` refuses "" and nothing else).
  if (typeof obj.message !== "string" || (obj.message === "" && !(obj.op !== SEND_OP && Array.isArray(obj.files) && obj.files.length))) {
    return { ok: false, error: "send request needs a non-empty message" };
  }
  if (Buffer.byteLength(obj.message, "utf8") > SPAWN_MAX_PROMPT_BYTES) {
    return { ok: false, error: "send request message is too large" };
  }
  let files: SendHeader["files"] | undefined;
  if (obj.files !== undefined) {
    if (obj.op === SEND_OP) return { ok: false, error: "Only remote requests may carry files" };
    try {
      const header = parseSendHeader({ op: "send", id: crypto.randomUUID(), from: { kind: "user" }, target: { kind: "system" }, message: obj.message, files: obj.files });
      encodeSendHeader(header);
      files = header.files;
    } catch (err) { return { ok: false, error: String(err) }; }
  }
  if (obj.op === "local-attachment-send" && !files?.length) return { ok: false, error: "Local attachment send needs files" };
  return { ok: true, request: { v: 1, id: expectedId, op: obj.op, target: obj.target, message: obj.message, ...(typeof pid === "number" && { clientPid: pid }), ...(files && { files }), ...(obj.noPassthrough === true && { noPassthrough: true }) } };
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
  noPassthrough = false,
): Promise<IbCommandResult | null> {
  let caller: ResolvedCallerContext | null;
  try {
    caller = await (deps.resolveCaller ?? resolveCallerAgentContext)(deps.cwd ?? process.cwd());
  } catch (err) {
    if (deps.signal?.aborted) return interruptedSend("unpublished");
    return brokerFail(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (deps.signal?.aborted) return interruptedSend("unpublished");
  if (!caller || !caller.agentDir || typeof caller.meta.id !== "string") {
    return brokerFail(
      "Error: cannot run 'ib send' through the watchdog: this shell is not inside a registered agent, " +
        "so there is no agent watchdog to ask. Run `ib send` from an agent's own worktree.",
    );
  }
  return submitSendRequest("send", caller.agentDir, caller.meta.id, target, message, deps, noPassthrough);
}


async function startStagingLease(dir: string, id: string) {
  const stage = join(dir, "send-attachments", id);
  await mkdir(stage, { mode: 0o700 });
  try {
    await publishBrokerRecord(dir, id, "lease", { pid: process.pid });
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
}

async function requireActiveStagingLease(dir: string, id: string, origin: TransferOwner, expected?: string) {
  const { state, identity, owner } = await inspectBrokerLease(dir, id);
  if (state !== "verified-live" || owner?.pid !== origin.pid || owner.start !== origin.start || !identity || expected !== undefined && expected !== identity) {
    throw new Error("Cannot verify the staging lease owner");
  }
  return identity;
}

export async function sweepStagingLease(dir: string, id: string, now = performance.now()) {
  if (!/^[0-9a-f]{32}$/.test(id)) return;

  const { state, inode } = await inspectBrokerLease(dir, id);
  if (!reclaimTransfer(state, inode, now)) return;
  await removeAbandonedStaging(dir, id);
}

export async function sweepStagingRequests(dir: string, now: number) {
  let ids;
  try { ids = await transferDirectoryBatch(join(dir, "send-attachments")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  for (const id of ids) {
    try { await sweepStagingLease(dir, id, now); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnSendCleanup(`Staging cleanup failed: ${err}`); }
  }
}

async function submitSendRequest(op: SendRequest["op"], dir: string, callerId: string, target: string, message: string, deps: SpawnClientDeps, noPassthrough = false, stage?: StageRemoteFiles, missingBroker?: string) {
  const transfer = op !== SEND_OP;
  if (deps.signal?.aborted) return interruptedSend("unpublished");
  if (!isBrokerableTarget(target)) return transfer ? brokerFail("send request has an invalid target") : null;
  if (Buffer.byteLength(message, "utf8") > SPAWN_MAX_PROMPT_BYTES) return transfer ? brokerFail("send request message is too large") : null;
  let live;
  try { live = await (deps.watchdogLive ?? hasLiveWatchdog)(dir); }
  catch (err) { return deps.signal?.aborted ? interruptedSend("unpublished") : brokerFail(String(err)); }
  if (deps.signal?.aborted) return interruptedSend("unpublished");
  if (!live) return transfer ? brokerFail(op === "remote-send" ? "Remote sends from a worktree agent need its watchdog running" : missingBroker ?? "Local attachment sends need the worktree watchdog running") : null;
  const request: SendRequest = { v: 1, id: randomBytes(16).toString("hex"), op, target, message, ...(transfer && { clientPid: process.pid }), ...(noPassthrough && { noPassthrough: true }) };
  const parent = join(dir, "send-attachments");
  const staged = join(parent, request.id);
  let ownsStage = false;
  try {
    if (stage) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await startStagingLease(dir, request.id);
      ownsStage = true;
      request.files = await stage(staged, true);
    }
    const result = await submitWatchdogRequest(
      dir,
      callerId,
      request,
      {
        request: "send",
        action: `send the message to '${target}'`,
        alreadyStarted:
          "The watchdog had already taken the message, so it may still be delivered; check with the recipient before sending it again.",
      },
      deps.timeoutMs ?? (transfer ? IDLE_TIMEOUT_MS : SPAWN_CLIENT_TIMEOUT_MS),
      transfer ? { ...deps, claimTimeoutMs: Math.min(10_000, deps.timeoutMs ?? Infinity), cancelClaimed: async () => {
        if (ownsStage) await rm(staged, { recursive: true, force: true });
        else await (await open(join(spawnResultDir(dir), request.id + ".cancel"), "wx", 0o600)).close();
      }, readProgress: async () => {
        return Math.max(0, (await stat(join(spawnResultDir(dir), request.id + ".progress"))).size - 16);
      } } : deps,
    );
    if (!transfer && !result.ok && OLD_WATCHDOG_ANSWERS.has(result.stderr)) return null;
    return result;
  } finally {
    if (ownsStage) trackSendCleanup(rm(staged, { recursive: true, force: true }), "Remote staging cleanup failed");
  }
}

/** What `ib send` hands the broker. */
export interface SendCommand {
  attachments?: readonly string[];
  readRawMessage?: () => Promise<string>;
  attachmentSender?: () => Promise<AttachmentSender>;
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

/** Use the same address scope as the CLI when deciding whether a send to self stays direct. */
async function targetIsCaller(target: string, caller: ResolvedCallerContext, repos: RepoEntry[]): Promise<boolean> {
  if (typeof caller.meta.id !== "string") return false;
  try {
    const { agent } = await resolveSendTarget(target, repos, join(caller.agentDir, "repo"));
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
  const sender = await command.attachmentSender?.();
  const agent = sender?.kind === "agent" ? sender.caller : undefined;
  const sharedCoordinator = !!agent && agent.meta.worktree === false && isCoordinatorType(agent.meta.agentType) &&
    isSandboxedProcess() && metaKernelSandboxed(agent.meta);
  const caller = sender
    ? agent && (sharedCoordinator || (agent.meta.worktree === true && metaKernelSandboxed(agent.meta))) ? agent : null
    : await resolveRoutedCaller(deps);
  if (deps.signal?.aborted) return interruptedSend("unpublished");
  if (!caller) return null;
  if (command.fromAgent !== undefined && command.fromAgent !== caller.meta.id) {
    return brokerFail(
      "Error: --from for another agent is not supported inside the sandbox: a sandboxed agent sends only as itself, through its watchdog.",
    );
  }
  if (sender && command.attachments?.length && isSandboxedProcess()) {
    const body = await (command.readRawMessage ?? command.readMessage)();
    return submitSendRequest("local-attachment-send", caller.agentDir, String(caller.meta.id), command.target, body, deps,
      false, remoteAttachmentStage(command.attachments, sender, deps.signal),
      sharedCoordinator ? "sandboxed repo coordinators cannot attach files locally yet without a running watchdog broker" : undefined);
  }
  if (await targetIsCaller(command.target, caller, command.repos)) return null;
  const message = await command.readMessage();
  if (deps.signal?.aborted) return interruptedSend("unpublished");
  if (!message) return brokerFail(command.usage);
  return requestSendViaWatchdog(command.target, message, { ...deps, resolveCaller: async () => caller }, !!command.attachmentSender);
}

type CliSendRoute = { result: IbCommandResult } | { local: ResolvedSendTarget; fromAgent: string };

/** Bound the encoded header even when only the watchdog can resolve the raw
 * address. Empty agent/repo fields account for the still-unknown label bytes. */
function checkRemoteSize(message: string, target: SendTarget, from: SendHeader["from"]) {
  encodeSendHeader({ op: "send", id: crypto.randomUUID(), message, target, from, files: [] });
}

/** Route machine-qualified worktree sends from their address alone. A bare
 * name uses the usual same-repo-first resolver. An inconclusive sandbox
 * lookup delegates the raw address, never a guessed remote id. */
export async function routeCliSend(command: SendCommand, deps: SpawnClientDeps & { resolveTarget?: typeof resolveSendTarget } = {}): Promise<CliSendRoute> {
  const cwd = deps.cwd ?? process.cwd();
  const resolveAddress = deps.resolveTarget ?? resolveSendTarget;
  const { target, repos } = command;
  const worktree = runtimeNames.matchWorktreeCaller(cwd);
  const localSyntax = target.startsWith("@");
  const machine = !localSyntax && target.includes("/") ? target.split("/")[0] : undefined;
  const cancelled = () => ({ result: interruptedSend("unpublished") });
  try {
    let deferred = false;
    let localMachine = false;
    let message: string | undefined;
    const remoteName = machine ? target.slice(machine.length + 1) : "";
    const minimumTarget: SendTarget = remoteName === "@system" ? { kind: "system" }
      : remoteName.startsWith("@") && !remoteName.includes("/") ? { kind: "repo-coordinator", repo: remoteName.slice(1) }
      : { kind: "agent", repo: "", agent: "" };
    if (machine) {
      const localName = await readMachineName().catch(() => "");
      localMachine = machine.toLowerCase() === localName.toLowerCase();
      deferred = !localMachine && (!!worktree || isSandboxedProcess());
      if (!localMachine) {
        message = await (command.readRawMessage ?? command.readMessage)();
        if (deps.signal?.aborted) return cancelled();
        checkRemoteSize(message, minimumTarget, { kind: "user" });
      }
    }
    let resolved;
    if (!localSyntax && !localMachine && !deferred) {
      resolved = await resolveAddress(target, repos, cwd, !!worktree);
      deferred = !!worktree && !!resolved.incompleteVisibility;
    }
    if (deps.signal?.aborted) return cancelled();
    let actor = command.attachmentSender ? await command.attachmentSender()
      : deferred || resolved?.remote ? await verifiedSendCaller(cwd, "remote", repos.map(repo => repo.path))
      : await localCliActor(cwd);
    // A verified human in an agent checkout sends as the user, with or without --from.
    // The already-verified attachment sender still governs access to source files.
    if (!deferred && !resolved?.remote && actor.kind === "agent" &&
        await localHumanInCheckout(cwd, actor.caller)) {
      actor = { kind: "user" };
    }
    const fromAgent = cliActorId(actor, command.fromAgent);
    const localDeps = { ...deps, resolveCaller: async () => actor.kind === "agent" ? actor.caller : null };
    if (deferred || resolved?.remote) {
      const { cliRemoteSender, handoffRemoteMessage, qualifiedAgentSender, textHeader } = await import("./peers/peer-outbox");
      const sender = await cliRemoteSender(repos, actor, command.fromAgent);
      if (deps.signal?.aborted) return cancelled();
      message ??= await (command.readRawMessage ?? command.readMessage)();
      if (deps.signal?.aborted) return cancelled();
      if (!message && !command.attachments?.length) return { result: brokerFail(command.usage) };
      const stage = command.attachmentSender && remoteAttachmentStage(command.attachments!, await command.attachmentSender(), deps.signal, files => {
        const bytes = files.reduce((total, file) => total + file.size, 0);
        if (bytes > 5 * 1024 ** 2) console.error(`sending ${files.length} files (${(bytes / 1024 ** 2).toFixed(1)} MB) to ${target}…`);
      });
      if (sender.kind === "worktree") {
        const from = await qualifiedAgentSender(sender.id, sender.repoPath, repos)
          .catch(() => ({ kind: "agent", id: `//${sender.id}` } as const));
        checkRemoteSize(message, resolved?.remote?.target ?? minimumTarget, from);
        const result = await submitSendRequest("remote-send", sender.agentDir, sender.id, target, message, deps, false, stage);
        if (!machine && result?.exitCode === LOCAL_TARGET_EXIT) {
          const local = await routeSendThroughWatchdog(command, localDeps);
          return { result: local ?? result };
        }
        // A remote submission always selects a result, even without a watcher.
        return { result: result! };
      }
      checkRemoteSize(message, resolved?.remote?.target ?? minimumTarget, sender.from);
      resolved ??= await resolveAddress(target, repos, cwd);
      if (deps.signal?.aborted) return cancelled();
      if (resolved.remote) {
        return { result: await handoffRemoteMessage(resolved.remote.peer, textHeader(resolved.remote.target, message, sender.from), deps.signal, stage) };
      }
    }
    if (resolved?.error) return { result: brokerFail(resolved.error) };
    const brokered = actor.kind === "user" ? null : await routeSendThroughWatchdog(command, localDeps);
    if (brokered) return { result: brokered };
    resolved ??= await resolveAddress(target, repos, cwd);
    if (deps.signal?.aborted) return cancelled();
    if (resolved.remote) return { result: brokerFail("Use a machine-qualified address to send remotely") };
    return resolved.error ? { result: brokerFail(resolved.error) } : { local: resolved, fromAgent };
  } catch (err) {
    return deps.signal?.aborted ? cancelled() : { result: brokerFail(err instanceof Error ? err.message : String(err)) };
  }
}

// ── Server (runs in the unsandboxed watchdog) ────────────────────────────────

/** Seams for the `ib send` request handled here. */
export interface SendServerDeps {
  verifySendProcess?: typeof isAgentSendProcess;
  attachmentTempDir?: string;
  setTimer?: FileBodyOptions["setTimer"];
  listRepos?: () => Promise<RepoEntry[]>;
  resolveTarget?: (
    target: string,
    repos: RepoEntry[],
    cwd: string,
  ) => Promise<ResolvedSendTarget & { error?: string }>;
  sendMessage?: (agent: Agent, message: string, opts: { noPassthrough?: true; fromAgent: string }) => Promise<IbCommandResult>;
  teamSend?: (
    teamName: string,
    members: Agent[],
    message: string,
    opts: { noPassthrough?: true; fromAgent: string; excludeRecipient: (agent: Agent) => Promise<boolean> },
    repos: RepoEntry[],
  ) => Promise<IbCommandResult>;
  sendToSystemCoordinator?: (message: string, opts: { noPassthrough?: true; fromAgent: string; cwd: string }) => Promise<IbCommandResult>;
}

/** `@system`: the CLI's own function (lazy import, as the watchdog's notifications do). */
async function sendToSystemCoordinatorDefault(
  message: string,
  opts: { noPassthrough?: true; fromAgent: string; cwd: string },
  probeOptions: FileBodyOptions,
): Promise<IbCommandResult> {
  const { sendToSystemCoordinator } = await import("./index");
  return sendToSystemCoordinator(message, opts, probeOptions);
}

/**
 * Handle one send request on behalf of `agentId`. Called by the spawn
 * broker's queue handler, which has already consumed the request file.
 */
export async function handleSendRequest(
  ctx: { agentId: string; repoPath: string; agentDir: string; id: string; text: string; createdMs?: number },
  deps: SpawnServerDeps,
): Promise<IbCommandResult> {
  const parsed = parseSendRequest(ctx.text, ctx.id);
  if (!parsed.ok) return brokerFail(`Error: ${parsed.error}`);
  const { target, op } = parsed.request;
  let message = parsed.request.message;
  const localFiles = op === "local-attachment-send";
  const remote = op === "remote-send";

  // Identity comes from the agent's own sealed record, never from the request.
  const requester = await verifyBrokerRequester(ctx.agentId, ctx.repoPath, ctx.agentDir, remote ? "send remotely" : "send", deps);
  if (!requester.ok) return requester.result;

  const seams = deps.send ?? {};
  const fromAgent = ctx.agentId;
  const sendOpts = { fromAgent, ...((localFiles || parsed.request.noPassthrough) && { noPassthrough: true as const }) };
  const self: AgentLocation = { id: ctx.agentId, repoPath: ctx.repoPath, agentDir: ctx.agentDir };
  // Where the requester "is": its own worktree, the cwd of a direct `ib send`
  // there. It decides `@coordinator` and the same-repo-first search of a bare
  // id; the watchdog's own cwd says nothing about the requester.
  const callerCwd = localFiles && requester.meta.worktree === false ? ctx.repoPath : join(ctx.agentDir, "repo");
  try {
    const lookup = <T>(read: () => Promise<T>) => remote || localFiles
      ? waitForIO({ signal: deps.transferSignal, setTimer: seams.setTimer }, read) : read();
    const repos = await lookup(seams.listRepos ?? listRepos);
    const sender = remote ? await lookup(async () => (await import("./peers/peer-outbox")).qualifiedAgentSender(ctx.agentId, ctx.repoPath, repos)) : null;
    const resolved = await lookup(() => (seams.resolveTarget ?? resolveSendTarget)(target, repos, callerCwd));
    if (resolved.error) return brokerFail(resolved.error);
    // The ordinary commands, as the watchdog's own agent. `fromAgent` is
    // always passed: these functions otherwise detect the sender from the
    // cwd, which here is the watchdog's. `stageAttachments` is never set.
    async function dispatchLocal(queueGuard?: LocalQueueGuard) {
      const opts = queueGuard ? { ...sendOpts, queueGuard } : sendOpts;
      if (resolved.remote) return brokerFail("Use a machine-qualified address to send remotely");
      if (resolved.isSystemCoordinator) {
        return await (seams.sendToSystemCoordinator ?? sendToSystemCoordinatorDefault)(message, { ...opts, cwd: callerCwd },
          { signal: queueGuard?.signal ?? deps.transferSignal, setTimer: seams.setTimer });
      }
      // Never deliver to the requester itself (see isAgentAt). A team drops it
      // like the sender; a single target is refused.
      const excludeRecipient = (agent: Agent) => localFiles ? verifiedSelfRecipient(agent, self) : isAgentAt(agent, self);
      if (resolved.team) {
        return await (seams.teamSend ?? teamSend)(
          resolved.team.name,
          resolved.team.members,
          message,
          { ...opts, excludeRecipient },
          repos,
        );
      }
      if (!resolved.agent) return brokerFail(`Agent not found: ${target}`);
      if (await excludeRecipient(resolved.agent)) {
        if (localFiles) {
          // The requester's own watchdog drains its queue normally. Never use
          // requester-writable tmux metadata for an inline delivery here.
          const { enqueueOutbox, agentOutboxDir } = await import("./outbox");
          const dir = agentOutboxDir({ id: ctx.agentId, meta: resolved.agent.meta });
          await enqueueOutbox(dir, { message, fromAgent, noPassthrough: true, raw: false }, resolved.agent.meta.queue_key, queueGuard?.signal, queueGuard);
          return { ok: true, exitCode: 0, stdout: "", stderr: "" };
        }
        return brokerFail(`Error: '${ctx.agentId}' cannot send to itself through its watchdog; send directly`);
      }
      return await (seams.sendMessage ?? sendMessage)(resolved.agent, message, opts);
    }
    if (remote || localFiles) {
      if (localFiles && resolved.remote) return brokerFail("Local attachment sends require a local target");
      if (remote && !resolved.remote) {
        const result = brokerFail(LOCAL_REMOTE_TARGET);
        result.exitCode = LOCAL_TARGET_EXIT;
        return result;
      }
      const { handoffRemoteMessage, textHeader } = await import("./peers/peer-outbox");
      const files = parsed.request.files ?? [];
      const limits = checkIncomingFiles(files, await readTransferLimits(), { machine: await readMachineName() });
      if (!limits.ok) return brokerFail(limits.error);
      const controller = new AbortController();
      const pid = parsed.request.clientPid!;
      const origin: TransferOwner = { pid, start: stagingOwnerStart(pid) };
      if (!files.length && (transferOwnerState(origin, 0) !== "verified-live" || !ctx.createdMs || origin.start! * 1000 > ctx.createdMs)) {
        return brokerFail("Cannot verify the remote send client");
      }
      let clientIdentity: string | undefined;
      let marker: Awaited<ReturnType<typeof createBrokerProgress>> | undefined;
      const results = await openBrokerResults(ctx.agentDir, true);
      const resultPath = await pinnedPath(results).catch(async err => { await results.close(); throw err; });
      const textProgress = join(resultPath, ctx.id + ".progress");
      try {
        if (files.length) {
          clientIdentity = await requireActiveStagingLease(ctx.agentDir, ctx.id, origin);
          marker = await createBrokerProgress(ctx.agentDir, ctx.id);
        } else {
          deps.transferSignal?.throwIfAborted();
        }
        if (!await (seams.verifySendProcess ?? isAgentSendProcess)(origin, requester.meta)) {
          throw Error("Cannot verify that the send client belongs to this agent process");
        }
      }
      catch (err) {
        await marker?.close();
        await results.close();
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return interruptedSend("claimed");
        throw err;
      }
      const signal = deps.transferSignal ? AbortSignal.any([controller.signal, deps.transferSignal]) : controller.signal;
      const cancelPath = join(resultPath, ctx.id + ".cancel");
      const checkClient = cancellationPoll(async () => files.length
        ? (await marker!.stat()).nlink === 0 : cancellationMarkerExists(cancelPath), controller);
      const ownerStart = stagingOwnerStart(process.pid);
      const ownerBytes = Buffer.alloc(16);
      ownerBytes.writeDoubleLE(process.pid);
      ownerBytes.writeDoubleLE(ownerStart ?? 0, 8);
      let sequence = 0, recorded = 0, updated = -Infinity;
      let publication: Promise<void> | undefined;
      let warned = false;
      const tick = () => {
        checkClient();
        if (publication || sequence === recorded || performance.now() - updated < 250) return;
        const next = sequence;
        updated = performance.now();
        const temp = `${textProgress}.${process.pid}-${ownerStart ?? 0}-${randomBytes(8).toString("hex")}.tmp`;
        publication = (async () => {
          try {
            const file = await open(temp, "wx", 0o600);
            try { await file.writeFile(ownerBytes); await file.truncate(ownerBytes.length + next); } finally { await file.close(); }
            await rename(temp, textProgress);
            recorded = next;
          } finally { await rm(temp, { force: true }); }
        })().catch(err => {
          if (!warned) warnSendCleanup(`Remote send progress update failed: ${err}`);
          warned = true;
        }).finally(() => { publication = undefined; });
      };
      const progress = () => { sequence++; };
      tick();
      const timer = setInterval(tick, 250);
      try {
        const stage = files.length ? brokerAttachmentStage(ctx.agentDir, ctx.id, files, signal, progress) : undefined;
        const checkLease = async () => { await requireActiveStagingLease(ctx.agentDir, ctx.id, origin, clientIdentity); };
        if (localFiles) {
          const snapshot = await prepareLocalBrokerAttachments(ctx.agentDir, message, stage!, signal, seams.attachmentTempDir);
          try {
            message = snapshot.message;
            await checkLease();
            signal.throwIfAborted();
            return await dispatchLocal({ signal, accepted: snapshot.accepted, beforeAppend: async () => {
              await snapshot.publish();
              await checkLease();
            } });
          } finally {
            await snapshot.finish().catch(err => warnSendCleanup(`Local attachment cleanup failed: ${err}`));
          }
        } else {
          const result = await handoffRemoteMessage(resolved.remote!.peer, textHeader(resolved.remote!.target, message, sender!), signal, stage, progress,
            files.length ? checkLease : undefined, origin);
          if (signal.aborted) return interruptedSend("claimed");
          return result;
        }
      } finally {
        clearInterval(timer);
        if (marker) trackSendCleanup(marker.close(), "Broker progress close failed");
        trackSendCleanup(Promise.resolve(publication).then(() => rm(textProgress, { force: true })).finally(() => results.close()), "Broker progress cleanup failed");
      }
    }
    return await dispatchLocal();
  } catch (err) {
    return brokerFail(`Error: send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
