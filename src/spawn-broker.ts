import { openBrokerResults, pinnedPath, withPinnedDirectory } from "./pinned-directory";
import { requestLookup } from "./request-lookup";
import { trackSendCleanup, warnSendCleanup } from "./send-cleanup";
import { isCoordinatorType } from "./coordinator-type-names";
import * as runtimeNames from "./runtime-names";
/**
 * Watchdog spawn broker — how a SANDBOXED agent spawns a child agent.
 *
 * A sandboxed process cannot do the spawn work itself: applying the child's
 * Seatbelt profile from inside the parent's fails (`sandbox_apply: Operation not
 * permitted`), binding the child's proxy port is denied, and reaching the tmux
 * server to start the child is a sandbox escape we would rather not grant. The
 * agent's WATCHDOG, however, is started by the tmux server, so it is not a
 * descendant of the agent and runs UNSANDBOXED (SPEC-SANDBOX §4C.2). So:
 *
 *   sandboxed `ib new-agent`  ──request.json──▶  the agent's own watchdog
 *        (client, this file)                       (server, this file)
 *                             ◀──result.json───    runs the normal newAgent()
 *
 * The child is then launched exactly as for any spawn: its CLI is wrapped in its
 * OWN profile by start.sh, and it gets its own (unsandboxed) watchdog.
 *
 * Files live in the requesting agent's own directory (`<repo>/.itsybitsy/agents/
 * <id>/`), the one place a sandboxed agent can always write:
 *   spawn-requests/<id>.json   client -> watchdog
 *   spawn-results/<id>.json    watchdog -> client
 * The request carries the FULL prompt text — never a path — so the unsandboxed
 * watchdog can never be steered into reading a file on the agent's behalf.
 *
 * Trust model: the request is untrusted DATA. The watchdog takes the caller's
 * identity from the agent's own meta.json, verifies that meta against its sealed
 * record (enabled agents cannot edit their way into `canSpawnChildren`). An
 * explicitly sandbox-disabled requester may have no seal, retaining its
 * hook-enforced policy; Codex's native sandbox still needs this spawn broker.
 * The watchdog hands the caller to newAgent() as `_trustedCaller`, so every
 * ordinary caller gate (canSpawnChildren, user-only --model, spawnedBy) applies.
 * Only a fixed allowlist of fields is honored; `model`, `repo` and `spawnedBy`
 * are never accepted.
 *
 * The same queue also carries the other commands a sandboxed agent cannot run
 * itself. A request with an `op` field is not a spawn: `op: "ask"` (`ib ask`)
 * is handed to ask-broker.ts, `op: "send"` (`ib send`) to send-broker.ts, and
 * every other op (the lifecycle commands) to lifecycle-broker.ts. They share
 * the transport, the routing rule and the requester check defined here.
 *
 * Known limitation (SPEC-SANDBOX §4C.6): while a spawner still holds a WRITE
 * grant on `.itsybitsy/agents` it can write another agent's request directory in
 * the same repo. Dropping that grant for spawners is the follow-up that removes
 * the impersonation path.
 */

import { randomBytes } from "crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { readAgentMeta, type AgentMeta } from "./agents";
import {
  hasLiveWatchdog,
  newAgent,
  resolveCallerAgentContext,
  verifyAgentSealChecked,
  type IbCommandResult,
  type NewAgentOptions,
  type ResolvedCallerContext,
} from "./ib-commands";
import type { SealVerification } from "./agent-seal";
import type { LifecycleServerDeps } from "./lifecycle-broker";
import { resolveSandboxEnabled } from "./sandbox";
import { isSandboxedProcess } from "./sandbox-detect";
import type { SendServerDeps } from "./send-broker";

export const SPAWN_REQUEST_DIRNAME = "spawn-requests";
export const SPAWN_RESULT_DIRNAME = "spawn-results";
/** How long a sandboxed `ib new-agent` waits for its watchdog before giving up. */
export const SPAWN_CLIENT_TIMEOUT_MS = 30_000;
export const SPAWN_RESULT_POLL_MS = 200;
/** Largest prompt accepted in a request (the whole prompt travels in the JSON). */
export const SPAWN_MAX_PROMPT_BYTES = 1024 * 1024;
/** Cap on stdout/stderr text relayed back to the client. */
export const SPAWN_MAX_OUTPUT_CHARS = 64 * 1024;
/** Results the client never collected (it timed out or died) are pruned after this. */
export const SPAWN_STALE_RESULT_MS = 10 * 60_000;

const REQUEST_ID = /^[0-9a-f]{32}$/;
const REQUEST_FILE = /^([0-9a-f]{32})\.json$/;
const MAX_FIELD_CHARS = 200;
const REQUEST_FIELDS = new Set(["v", "id", "prompt", "type", "name", "effort", "manager", "noWorktree"]);

export interface SpawnRequest {
  v: 1;
  id: string;
  prompt: string;
  type?: string;
  name?: string;
  effort?: string;
  manager?: string;
  noWorktree?: boolean;
}

export interface SpawnResult {
  v: 1;
  id: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function spawnRequestDir(agentDir: string): string {
  return join(agentDir, SPAWN_REQUEST_DIRNAME);
}

export function spawnResultDir(agentDir: string): string {
  return join(agentDir, SPAWN_RESULT_DIRNAME);
}

/** Create both queue directories (the watchdog does this once at start). */
export async function ensureSpawnBrokerDirs(agentDir: string): Promise<void> {
  await mkdir(spawnRequestDir(agentDir), { recursive: true });
  await mkdir(spawnResultDir(agentDir), { recursive: true });
}

/** Write via a temp name in the same directory, then rename, so a reader never sees half a file. */
async function writeJsonAtomic(dir: string, name: string, value: unknown, signal?: AbortSignal, createParent = true): Promise<void> {
  signal?.throwIfAborted();
  if (createParent) await mkdir(dir, { recursive: true });
  const start = createParent ? 0 : (await import("./peers/transfer-owner")).stagingOwnerStart(process.pid) ?? 0;
  const tmp = join(dir, `.${name}.${process.pid}-${start}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    await rename(tmp, join(dir, name));
  } finally { await rm(tmp, { force: true }); }
}

export function brokerFail(stderr: string): IbCommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr };
}

/** Publication, claim and withdrawal all rename the same ready entry. */
export async function withdrawPublishedRequest(ready: string, withdrawn: string): Promise<boolean> {
  try { await rename(ready, withdrawn); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  await rm(withdrawn, { recursive: true, force: true }).catch(err => warnSendCleanup(`Withdrawn request cleanup failed: ${err}`));
  return true;
}

export function interruptedSend(state: "unpublished" | "withdrawn" | "claimed", recipient = "the recipient"): IbCommandResult {
  const stderr = state === "claimed" ? `outcome unknown — check ${recipient}` : "cancelled before sending";
  return { ok: false, exitCode: 130, stdout: "", stderr };
}

/**
 * Do two paths name the same directory? Unknown (either cannot be resolved)
 * counts as yes. The brokers use it to tell an agent from its requester: on a
 * case-insensitive volume `Agent-X` opens the directory of `agent-x`.
 */
export async function isSameDirectory(a: string, b: string): Promise<boolean> {
  try {
    const [resolvedA, resolvedB] = await Promise.all([realpath(a), realpath(b)]);
    return resolvedA === resolvedB;
  } catch {
    return true;
  }
}

/** The words that differ between the kinds of request a client can queue. */
export interface WatchdogRequestWording {
  /** Names the request: "could not write the <request> request". */
  request: string;
  /** Completes "waiting for the watchdog of '<id>' to <action>". */
  action: string;
  /** Said when the deadline passes after the watchdog already took the request. */
  alreadyStarted: string;
}

/**
 * Queue one request for the caller's watchdog and wait for its answer. Shared
 * by every brokered command (spawn here, lifecycle commands in
 * lifecycle-broker.ts). Gives up after `timeoutMs`, so a command can never
 * hang; it then withdraws the request if the watchdog has not taken it yet.
 */
export async function submitWatchdogRequest(
  agentDir: string,
  callerId: string,
  request: { id: string },
  wording: WatchdogRequestWording,
  timeoutMs: number,
  deps: Pick<SpawnClientDeps, "pollMs" | "sleep" | "now" | "signal" | "onUncertain" | "claimTimeoutMs" | "readProgress" | "cancelClaimed"> = {},
): Promise<IbCommandResult> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => performance.now());
  const pollMs = deps.pollMs ?? SPAWN_RESULT_POLL_MS;

  if (deps.signal?.aborted) return interruptedSend("unpublished");
  try {
    await writeJsonAtomic(spawnRequestDir(agentDir), `${request.id}.json`, request, deps.signal);
  } catch (err) {
    if (deps.signal?.aborted) return interruptedSend("unpublished");
    return brokerFail(`Error: could not write the ${wording.request} request: ${err instanceof Error ? err.message : String(err)}`);
  }

  const resultFile = join(spawnResultDir(agentDir), `${request.id}.json`);
  const requestFile = join(spawnRequestDir(agentDir), `${request.id}.json`);
  let awaitingClaim = deps.claimTimeoutMs !== undefined;
  let deadline = now() + (deps.claimTimeoutMs ?? timeoutMs);
  let lastProgress = 0;
  let progressRead: Promise<void> | undefined;
  let warnedProgress = false;
  let resultDiagnostic: string | undefined;
  const readResult = requestLookup(async (): Promise<IbCommandResult | undefined> => {
    if (awaitingClaim) {
      try { await stat(requestFile); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        awaitingClaim = false;
        deadline = now() + timeoutMs;
      }
    }
    let result: Partial<SpawnResult>;
    try { result = await Bun.file(resultFile).json(); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
    if (result.id !== request.id || typeof result.exitCode !== "number") {
      deps.onUncertain?.();
      return brokerFail(`Error: the watchdog returned a malformed ${wording.request} result`);
    }
    return { ok: result.ok === true, exitCode: result.exitCode,
      stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" };
  }, err => { resultDiagnostic = String(err); });
  const consume = async (result: IbCommandResult) => {
    const cleanup = rm(resultFile, { force: true });
    if (deps.cancelClaimed) trackSendCleanup(cleanup, "Remote broker result cleanup failed");
    else await cleanup;
    return result;
  };
  while (!deps.signal?.aborted) {
    const result = await readResult(deadline - now(), deps.signal);
    if (result && !deps.signal?.aborted) return consume(result);
    if (deps.signal?.aborted) break;
    if (!awaitingClaim && deps.readProgress) {
      progressRead ??= deps.readProgress().then(progress => {
        if (progress > lastProgress) {
          lastProgress = progress;
          deadline = now() + timeoutMs;
        }
      }, err => {
        if (!warnedProgress && (err as NodeJS.ErrnoException).code !== "ENOENT") {
          warnSendCleanup(`Remote send progress read failed: ${err}`);
          warnedProgress = true;
        }
      }).finally(() => { progressRead = undefined; });
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }

  // Timed out. Withdraw the request if the watchdog has not taken it yet; if it
  // already has, the command may still finish — say so.
  let stillQueued: boolean;
  try { stillQueued = await withdrawPublishedRequest(requestFile, join(spawnRequestDir(agentDir), `${request.id}@${process.pid}-0.json.withdrawn`)); }
  catch (err) { deps.onUncertain?.(); return brokerFail(`outcome unknown — check the recipient (could not withdraw request: ${err})`); }
  if (!stillQueued && !deps.signal?.aborted) {
    const result = await readResult(150, deps.signal);
    if (result && !deps.signal?.aborted) return consume(result);
    if (resultDiagnostic && !deps.signal?.aborted) return brokerFail(`outcome unknown — check the recipient (${resultDiagnostic})`);
  }
  if (!stillQueued && deps.signal?.aborted && deps.cancelClaimed) {
    await deps.cancelClaimed().catch(err => warnSendCleanup(`Could not signal claimed send cancellation: ${err}`));
  }
  if (!stillQueued) deps.onUncertain?.();
  if (deps.signal?.aborted) return interruptedSend(stillQueued ? "withdrawn" : "claimed");
  return brokerFail(
    `Error: timed out after ${Math.round((awaitingClaim ? deps.claimTimeoutMs! : timeoutMs) / 1000)}s waiting for the watchdog of '${callerId}' to ${wording.action}. ` +
      (stillQueued
        ? "The request was withdrawn; check that the agent's watchdog is healthy and retry."
        : wording.alreadyStarted),
  );
}

// ── Client (runs inside the sandbox) ─────────────────────────────────────────

export interface SpawnClientDeps {
  cancelClaimed?: () => Promise<void>;
  readProgress?: () => Promise<number>;
  claimTimeoutMs?: number;
  /** A claimed request may have enqueued its snapshots before the reply was lost. */
  onUncertain?: () => void;
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  resolveCaller?: (cwd: string) => Promise<ResolvedCallerContext | null>;
  watchdogLive?: (agentDir: string) => Promise<boolean>;
}

/**
 * Ask the calling agent's watchdog to spawn a child, and wait for the answer.
 * Fails at once when the watchdog is not live, and after SPAWN_CLIENT_TIMEOUT_MS
 * (30s) when it is live but does not answer, so the command can never hang.
 */
export async function requestSpawnViaWatchdog(
  prompt: string,
  opts: NewAgentOptions,
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult> {
  let caller: ResolvedCallerContext | null;
  try {
    caller = await (deps.resolveCaller ?? resolveCallerAgentContext)(deps.cwd ?? process.cwd());
  } catch (err) {
    return brokerFail(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!caller || !caller.agentDir || typeof caller.meta.id !== "string") {
    return brokerFail(
      "Error: cannot spawn from inside the sandbox: this shell is not inside a registered agent, " +
        "so there is no agent watchdog to ask. Run `ib new-agent` from an agent's own worktree.",
    );
  }
  const callerId = caller.meta.id;

  // The same user-only gate newAgent() applies; refuse before sending anything.
  if (opts.model) {
    return brokerFail(
      `Error: '${callerId}' cannot pass --model — the model is a user-only setting. The spawned agent's model comes from its agent type (or the user's config); ask the user if a different model is needed.`,
    );
  }
  if (Buffer.byteLength(prompt, "utf8") > SPAWN_MAX_PROMPT_BYTES) {
    return brokerFail(`Error: prompt is larger than ${SPAWN_MAX_PROMPT_BYTES} bytes; shorten it or point the agent at a file it can read`);
  }

  // Tell "no watchdog" from "slow watchdog" up front, without waiting 30s.
  const live = await (deps.watchdogLive ?? hasLiveWatchdog)(caller.agentDir);
  if (!live) {
    return brokerFail(
      `Error: cannot spawn from inside the sandbox: the watchdog for '${callerId}' is not running ` +
        `(no fresh heartbeat), and the watchdog is what starts child agents. Restart this agent so its ` +
        `watchdog starts, then retry.`,
    );
  }

  const request: SpawnRequest = {
    v: 1,
    id: randomBytes(16).toString("hex"),
    prompt,
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.manager !== undefined ? { manager: opts.manager } : {}),
    ...(opts.noWorktree ? { noWorktree: true } : {}),
  };
  return submitWatchdogRequest(
    caller.agentDir,
    callerId,
    request,
    {
      request: "spawn",
      action: "spawn the agent",
      alreadyStarted: "The watchdog had already started the spawn, so the agent may still appear — check `ib list`.",
    },
    deps.timeoutMs ?? SPAWN_CLIENT_TIMEOUT_MS,
    deps,
  );
}

/**
 * The `ib new-agent` entry point for a sandboxed process. Returns null when the
 * process is NOT sandboxed (the caller then spawns directly, exactly as before).
 * `--repo` and `--spawned-by*` are refused here: the watchdog only spawns into
 * its own agent's repo and derives the spawner itself.
 */
export async function routeNewAgentThroughWatchdog(
  prompt: string,
  opts: NewAgentOptions,
  flags: { repoArg?: string; spawnedByFlags?: boolean },
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult | null> {
  if (!isSandboxedProcess()) return null;
  if (flags.repoArg) {
    return brokerFail("Error: --repo is not supported inside the sandbox: a sandboxed agent spawns children only in its own repo, through its watchdog.");
  }
  if (flags.spawnedByFlags) {
    return brokerFail("Error: --spawned-by / --spawned-by-repo are internal and cannot be used inside the sandbox.");
  }
  return requestSpawnViaWatchdog(prompt, opts, deps);
}

/**
 * The routing rule for the commands that keep a direct path (the lifecycle
 * commands, `ib ask` and `ib send`). Returns the caller to route to its watchdog, or null
 * when the caller must run the command directly, exactly as before the brokers
 * existed. Only one kind of caller is routed: a worktree agent inside its own
 * itsybitsy sandbox. Everyone else keeps the direct path:
 *   - a process that is not sandboxed;
 *   - a sandboxed shell that is not (or cannot be shown to be) an agent;
 *   - a `worktree:false` agent — its profile grants the repo root, so the
 *     direct path works (for `ib ask`: the question is recorded, but the
 *     Telegram outbox is outside the stock profile, SPEC-SANDBOX §4C.8), and
 *     its per-agent watchdog exits at once (there is no `<agentDir>/repo`),
 *     so there is nobody to ask;
 *   - an agent whose itsybitsy sandbox is disabled. `isSandboxedProcess()` is
 *     still true for a codex agent there (codex's own sandbox), which grants
 *     what these commands need; and such an agent has no seal to verify.
 * This only ROUTES. A caller that lies in its own meta.json to get the direct
 * path runs the command inside its real sandbox, where it fails as before.
 */
export async function resolveRoutedCaller(
  deps: Pick<SpawnClientDeps, "cwd" | "resolveCaller"> = {},
): Promise<ResolvedCallerContext | null> {
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
  return caller;
}

// ── Server (runs in the unsandboxed watchdog) ────────────────────────────────

export interface SpawnServerDeps {
  /** In-flight transfer jobs owned by this watchdog, keyed by agent directory. */
  transferSignal?: AbortSignal;
  transferJobs?: Map<string, Promise<void>>;
  newAgent?: (repoPath: string, prompt: string, opts: NewAgentOptions) => Promise<IbCommandResult>;
  verifySeal?: (
    repoPath: string,
    agentId: string,
    meta: Record<string, unknown>,
    helperCwd: string,
  ) => Promise<SealVerification>;
  readMeta?: (agentDir: string) => Promise<{ meta: AgentMeta | null; error?: string }>;
  now?: () => number;
  /** Seams for the lifecycle commands handled by lifecycle-broker.ts. */
  lifecycle?: LifecycleServerDeps;
  /** Seam for the `ib ask` request handled by ask-broker.ts. */
  askQuestion?: (repoPath: string, agentId: string, question: string) => Promise<IbCommandResult>;
  /** Seams for the `ib send` request handled by send-broker.ts. */
  send?: SendServerDeps;
}

type ParsedRequest = { ok: true; request: SpawnRequest } | { ok: false; error: string };

function optionalString(value: unknown, field: string): string | undefined | Error {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_CHARS) {
    return new Error(`invalid ${field}`);
  }
  return value;
}

/** Strictly parse an untrusted request; only the allowlisted fields survive. */
export function parseSpawnRequest(text: string, expectedId: string): ParsedRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "spawn request is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "spawn request must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!REQUEST_FIELDS.has(key)) return { ok: false, error: `spawn request has unsupported field '${key}'` };
  }
  if (obj.v !== 1) return { ok: false, error: "unsupported spawn request version" };
  if (obj.id !== expectedId) return { ok: false, error: "spawn request id does not match its file name" };
  if (typeof obj.prompt !== "string" || obj.prompt.trim() === "") {
    return { ok: false, error: "spawn request needs a non-empty prompt" };
  }
  if (Buffer.byteLength(obj.prompt, "utf8") > SPAWN_MAX_PROMPT_BYTES) {
    return { ok: false, error: "spawn request prompt is too large" };
  }
  if (obj.noWorktree !== undefined && typeof obj.noWorktree !== "boolean") {
    return { ok: false, error: "invalid noWorktree" };
  }
  const fields: Record<string, string | undefined> = {};
  for (const field of ["type", "name", "effort", "manager"] as const) {
    const value = optionalString(obj[field], field);
    if (value instanceof Error) return { ok: false, error: `spawn request has ${value.message}` };
    fields[field] = value;
  }
  return {
    ok: true,
    request: {
      v: 1,
      id: expectedId,
      prompt: obj.prompt,
      ...(fields.type !== undefined ? { type: fields.type } : {}),
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
      ...(fields.manager !== undefined ? { manager: fields.manager } : {}),
      ...(obj.noWorktree === true ? { noWorktree: true } : {}),
    },
  };
}

function clip(text: string): string {
  return text.length > SPAWN_MAX_OUTPUT_CHARS ? `${text.slice(0, SPAWN_MAX_OUTPUT_CHARS)}\n…(truncated)` : text;
}

async function writeResult(agentDir: string, id: string, result: IbCommandResult, signal?: AbortSignal): Promise<void> {
  const payload: SpawnResult = {
    v: 1,
    id,
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
  };
  signal?.throwIfAborted();
  const dir = await openBrokerResults(agentDir, true);
  try { await writeJsonAtomic(await pinnedPath(dir), `${id}.json`, payload, signal, false); }
  finally { await dir.close(); }
}

/** Completed markers carry the watchdog identity in their first 16 bytes.
 * Unpublished temps carry it in the name, even if their write never began. */
async function pruneBrokerProgress(path: string, name: string) {
  const { transferOwnerState } = await import("./peers/transfer-owner");
    const temp = /\.progress\.(\d+)-(\d+)-/.exec(name);
    let pid: number, start: number;
    if (temp) {
      pid = Number(temp[1]); start = Number(temp[2]);
    } else {
      const { open } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      const file = await open(join(path, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) return;
        const bytes = Buffer.alloc(16);
        if ((await file.read(bytes)).bytesRead !== bytes.length) return;
        pid = bytes.readDoubleLE(); start = bytes.readDoubleLE(8);
      } finally { await file.close(); }
    }
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(start) && start >= 0 &&
        transferOwnerState({ pid, start: start || null }, 0) === "proven-dead") await rm(join(path, name), { force: true });
}

const JSON_TEMP = /^\.[a-f0-9]{32}\.json\.([1-9]\d*)-(\d+)-[a-f0-9]{8}\.tmp$/;
const WITHDRAWN = /^[a-f0-9]{32}@([1-9]\d*)-(\d+)\.json\.withdrawn$/;
const LEGACY_TEMP = /^\.[a-f0-9]{32}\.json\.[a-f0-9]{8}\.tmp$/;
const LEGACY_WITHDRAWN = /^[a-f0-9]{32}\.json\.withdrawn$/;

async function recoverBrokerArtifact(parent: string, name: string, requests: boolean) {
  const match = JSON_TEMP.exec(name) ?? (requests && WITHDRAWN.exec(name));
  if (!match && !LEGACY_TEMP.test(name) && !(requests && LEGACY_WITHDRAWN.test(name))) return false;
  const { transferOwnerState, reclaimTransfer } = await import("./peers/transfer-owner");
  const path = join(parent, name);
  const info = await lstat(path);
  if (!info.isFile()) return true;
  const owner = match ? { pid: Number(match[1]), start: Number(match[2]) || null } : undefined;
  if (owner && (!Number.isSafeInteger(owner.pid) || owner.start !== null && !Number.isSafeInteger(owner.start))) return true;
  // The sandboxed CLI records only a PID. Keep a running PID even if it
  // outlives the retention window; its eventual exit permits recovery.
  const state = transferOwnerState(owner, 0);
  if (state === "proven-dead" || (!owner && reclaimTransfer(state, `${info.dev}:${info.ino}:${info.birthtimeMs}`, performance.now()))) {
    await rm(path, { force: true });
  }
  return true;
}

/** Remove results a client never collected. */
async function pruneStaleResults(agentDir: string, nowMs: number): Promise<void> {
  const dir = await openBrokerResults(agentDir, false).catch(() => undefined);
  if (!dir) return;
  try {
    const parent = await pinnedPath(dir);
    const names = await readdir(parent);
  for (const name of names) {
    if (await recoverBrokerArtifact(parent, name, false).catch(() => true)) continue;
    if (/^[a-f0-9]{32}\.progress(?:\.([1-9]\d*)-(\d+)-[a-f0-9]{16}\.tmp)?$/.test(name)) {
      await pruneBrokerProgress(parent, name).catch(err => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnSendCleanup(`Cannot recover broker progress: ${err}`);
      });
      continue;
    }
    if (!REQUEST_FILE.test(name) && !/^[a-f0-9]{32}\.cancel$/.test(name)) continue;
    const path = join(parent, name);
    try {
      if (nowMs - (await lstat(path)).mtimeMs > SPAWN_STALE_RESULT_MS) await rm(path, { force: true });
    } catch { /* raced with the client's own delete */ }
  }
  } finally { await dir.close(); }
}

/**
 * Handle every queued spawn request for one agent. At-most-once: each request
 * file is removed BEFORE it is acted on, so a request that crashes the handler
 * can never be retried in a loop. Returns how many requests were handled.
 */
export async function processSpawnRequests(
  agentId: string,
  repoPath: string,
  deps: SpawnServerDeps = {},
): Promise<number> {
  const agentDir = runtimeNames.agentDir(repoPath, agentId);
  const nowMs = (deps.now ?? Date.now)();
  await pruneStaleResults(agentDir, nowMs);

  if (deps.transferJobs) {
    const { sweepStagingRequests } = await import("./send-broker");
    await sweepStagingRequests(agentDir, performance.now()).catch(err => warnSendCleanup(`Staging cleanup failed: ${err}`));
  }

  let names: string[];
  try {
    names = (await readdir(spawnRequestDir(agentDir))).sort();
  } catch {
    return 0;
  }

  let handled = 0;
  for (const name of names) {
    // File names are agent-controlled: only a plain 32-hex id is ever used as a path.
    if (deps.transferSignal?.aborted) break;
    const match = REQUEST_FILE.exec(name);
    if (!match) {
      if (JSON_TEMP.test(name) || WITHDRAWN.test(name) || LEGACY_TEMP.test(name) || LEGACY_WITHDRAWN.test(name)) {
        await withPinnedDirectory(spawnRequestDir(agentDir), false, dir => recoverBrokerArtifact(dir, name, true)).catch(() => {});
      }
      continue;
    }
    const id = match[1]!;
    const requestPath = join(spawnRequestDir(agentDir), name);

    const claimed = requestPath + ".claimed";
    try { await rename(requestPath, claimed); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    let text: string;
    let createdMs: number;
    try {
      const { size, birthtimeMs } = await stat(claimed);
      createdMs = birthtimeMs;
      if (size > SPAWN_MAX_PROMPT_BYTES * 2) {
        await writeResult(agentDir, id, brokerFail("Error: spawn request is too large"), deps.transferSignal);
        handled++;
        continue;
      }
      text = await Bun.file(claimed).text();
    } catch (err) {
      await writeResult(agentDir, id, brokerFail(`Cannot read claimed request: ${err}`), deps.transferSignal);
      handled++;
      continue;
    } finally { await rm(claimed, { force: true }); }
    handled++;

    async function dispatch() {
      let result: IbCommandResult;
      try { result = await handleOneRequest(agentId, repoPath, agentDir, id, text, deps, createdMs); }
      catch (err) { result = brokerFail(`Error: spawn failed: ${err instanceof Error ? err.message : String(err)}`); }
      try { await writeResult(agentDir, id, result, deps.transferSignal); }
      catch { /* The client deadline handles an unavailable result channel. */ }
    }
    const jobs = deps.transferJobs;
    const named = jobs && requestOp(text);
    if (deps.transferSignal?.aborted) break;
    if (jobs && named?.present && (named.op === "remote-send" || named.op === "local-attachment-send")) {
      if (jobs.has(agentDir)) await writeResult(agentDir, id, brokerFail("busy, try again"), deps.transferSignal);
      else jobs.set(agentDir, dispatch().finally(() => jobs.delete(agentDir)));
    } else await dispatch();
  }
  return handled;
}

/**
 * Establish WHO a request is from. Identity comes from the agent's own record,
 * never from the request. Enabled agents must match their seal. A spawn from
 * an explicitly sandbox-disabled agent may have no seal (Codex still needs
 * the broker under its native sandbox). `verb` names the action ("spawn", ...).
 */
export async function verifyBrokerRequester(
  agentId: string,
  repoPath: string,
  agentDir: string,
  verb: string,
  deps: Pick<SpawnServerDeps, "readMeta" | "verifySeal">,
): Promise<{ ok: true; meta: AgentMeta } | { ok: false; result: IbCommandResult }> {
  const { meta } = await (deps.readMeta ?? readAgentMeta)(agentDir);
  if (!meta || meta.id !== agentId) {
    return { ok: false, result: brokerFail(`Error: cannot read the metadata of '${agentId}'; refusing to ${verb} on its behalf`) };
  }
  // Always check the protected record, even if writable meta says disabled:
  // changing an enabled agent's metadata must not bypass its existing seal.
  let verification: SealVerification;
  try {
    verification = await (deps.verifySeal ?? verifyAgentSealChecked)(
      repoPath,
      agentId,
      meta as unknown as Record<string, unknown>,
      agentDir,
    );
  } catch (err) {
    return {
      ok: false,
      result: brokerFail(`Error: could not verify the sealed record for '${agentId}': ${err instanceof Error ? err.message : String(err)}`),
    };
  }
  // Disabled agents deliberately have no seal. Like resume, accept only a
  // genuine missing-record result in that mode; mismatches, corruption and
  // read failures still fail closed. Other broker operations keep their
  // existing seal requirement (disabled callers use their direct paths).
  const unsealedDisabledSpawn = verb === "spawn"
    && meta.sandbox?.enabled === false
    && !verification.ok
    && verification.field === "(missing)";
  const unsealedDisabledSend = verb === "send remotely" && meta.worktree === true
    && meta.sandbox?.enabled === false && !verification.ok && verification.field === "(missing)";
  if (!verification.ok && !unsealedDisabledSpawn && !unsealedDisabledSend) {
    return {
      ok: false,
      result: brokerFail(
        verification.field === "(missing)"
          ? `Error: no sealed record for '${agentId}'; run \`ib sandbox refresh ${agentId}\` from an unsandboxed session, then retry`
          : `Error: meta.json for '${agentId}' does not match its sealed record (${verification.field}); refusing to ${verb}`,
      ),
    };
  }
  if (verb === "send remotely") {
    const { isRegisteredAgentWorktree } = await import("./no-worktree-caller");
    const root = await realpath(repoPath);
    const expected = join(runtimeNames.agentDir(root, agentId), "repo");
    const gitFile = join(expected, ".git");
    if (isCoordinatorType(meta.agentType) || await realpath(gitFile).catch(() => null) !== gitFile
        || !await isRegisteredAgentWorktree(expected, [root], true)) {
      return { ok: false, result: brokerFail("Remote sends through a watchdog require a worktree agent with a verified Git backlink") };
    }
  }
  return { ok: true, meta };
}

/**
 * The `op` field of a request. A request that names an `op` is not a spawn:
 * `"ask"` is a question (ask-broker.ts), `"send"` is a message (send-broker.ts),
 * and every other value is left to the lifecycle broker (lifecycle-broker.ts),
 * which refuses the ones it does not know.
 */
function requestOp(text: string): { present: false } | { present: true; op: unknown } {
  try {
    const raw: unknown = JSON.parse(text);
    if (!!raw && typeof raw === "object" && !Array.isArray(raw) && "op" in raw) {
      return { present: true, op: (raw as Record<string, unknown>).op };
    }
  } catch { /* not JSON: the spawn parser reports it */ }
  return { present: false };
}

async function handleOneRequest(
  agentId: string,
  repoPath: string,
  agentDir: string,
  id: string,
  text: string,
  deps: SpawnServerDeps,
  createdMs: number,
): Promise<IbCommandResult> {
  const named = requestOp(text);
  if (named.present) {
    // Lazy imports: these modules import this one.
    if (named.op === "ask") {
      const { handleAskRequest } = await import("./ask-broker");
      return handleAskRequest({ agentId, repoPath, agentDir, id, text }, deps);
    }
    if (named.op === "send" || named.op === "remote-send" || named.op === "local-attachment-send") {
      const { handleSendRequest } = await import("./send-broker");
      return handleSendRequest({ agentId, repoPath, agentDir, id, text, createdMs }, deps);
    }
    const { handleLifecycleRequest } = await import("./lifecycle-broker");
    return handleLifecycleRequest({ agentId, repoPath, agentDir, id, text }, deps);
  }

  const parsed = parseSpawnRequest(text, id);
  if (!parsed.ok) return brokerFail(`Error: ${parsed.error}`);
  const request = parsed.request;

  const requester = await verifyBrokerRequester(agentId, repoPath, agentDir, "spawn", deps);
  if (!requester.ok) return requester.result;
  const meta = requester.meta;

  const caller: ResolvedCallerContext = {
    meta: meta as unknown as Record<string, unknown>,
    agentDir,
    repoPath,
  };
  const opts: NewAgentOptions = {
    ...(request.type !== undefined ? { type: request.type } : {}),
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.manager !== undefined ? { manager: request.manager } : {}),
    ...(request.noWorktree ? { noWorktree: true } : {}),
    _trustedCaller: caller,
    // Where the requester "is": its worktree, or the repo root for worktree:false.
    _cwd: meta.worktree === false ? repoPath : join(agentDir, "repo"),
  };
  return (deps.newAgent ?? newAgent)(repoPath, request.prompt, opts);
}
