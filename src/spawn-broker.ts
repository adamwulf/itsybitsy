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
 * Files live in the requesting agent's own directory (`<repo>/.ittybitty/agents/
 * <id>/`), the one place a sandboxed agent can always write:
 *   spawn-requests/<id>.json   client -> watchdog
 *   spawn-results/<id>.json    watchdog -> client
 * The request carries the FULL prompt text — never a path — so the unsandboxed
 * watchdog can never be steered into reading a file on the agent's behalf.
 *
 * Trust model: the request is untrusted DATA. The watchdog takes the caller's
 * identity from the agent's own meta.json, verifies that meta against its sealed
 * record (an agent cannot edit its way into `canSpawnChildren`), builds the
 * verified caller itself and hands it to newAgent() as `_trustedCaller`, so every
 * ordinary caller gate (canSpawnChildren, user-only --model, spawnedBy) applies.
 * Only a fixed allowlist of fields is honored; `model`, `repo` and `spawnedBy`
 * are never accepted.
 *
 * The same queue also carries the lifecycle commands a sandboxed agent cannot
 * run itself: a request with an `op` field is handed to lifecycle-broker.ts,
 * which shares the transport and the requester check defined here.
 *
 * Known limitation (SPEC-SANDBOX §4C.6): while a spawner still holds a WRITE
 * grant on `.ittybitty/agents` it can write another agent's request directory in
 * the same repo. Dropping that grant for spawners is the follow-up that removes
 * the impersonation path.
 */

import { randomBytes } from "crypto";
import { mkdir, readdir, rename, rm, stat } from "fs/promises";
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
import { isSandboxedProcess } from "./sandbox-detect";

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
async function writeJsonAtomic(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
  await Bun.write(tmp, JSON.stringify(value));
  await rename(tmp, join(dir, name));
}

export function brokerFail(stderr: string): IbCommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr };
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
  deps: Pick<SpawnClientDeps, "pollMs" | "sleep" | "now"> = {},
): Promise<IbCommandResult> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? SPAWN_RESULT_POLL_MS;

  try {
    await writeJsonAtomic(spawnRequestDir(agentDir), `${request.id}.json`, request);
  } catch (err) {
    return brokerFail(`Error: could not write the ${wording.request} request: ${err instanceof Error ? err.message : String(err)}`);
  }

  const resultFile = join(spawnResultDir(agentDir), `${request.id}.json`);
  const deadline = now() + timeoutMs;
  for (;;) {
    const file = Bun.file(resultFile);
    if (await file.exists()) {
      try {
        const result = (await file.json()) as Partial<SpawnResult>;
        await rm(resultFile, { force: true });
        if (result.id !== request.id || typeof result.exitCode !== "number") {
          return brokerFail(`Error: the watchdog returned a malformed ${wording.request} result`);
        }
        return {
          ok: result.ok === true,
          exitCode: result.exitCode,
          stdout: typeof result.stdout === "string" ? result.stdout : "",
          stderr: typeof result.stderr === "string" ? result.stderr : "",
        };
      } catch {
        // A partially visible file cannot happen (atomic rename); treat a
        // parse failure as "not ready" only until the deadline.
      }
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }

  // Timed out. Withdraw the request if the watchdog has not taken it yet; if it
  // already has, the command may still finish — say so.
  const requestFile = join(spawnRequestDir(agentDir), `${request.id}.json`);
  const stillQueued = await Bun.file(requestFile).exists();
  if (stillQueued) await rm(requestFile, { force: true });
  return brokerFail(
    `Error: timed out after ${Math.round(timeoutMs / 1000)}s waiting for the watchdog of '${callerId}' to ${wording.action}. ` +
      (stillQueued
        ? "The request was withdrawn; check that the agent's watchdog is healthy and retry."
        : wording.alreadyStarted),
  );
}

// ── Client (runs inside the sandbox) ─────────────────────────────────────────

export interface SpawnClientDeps {
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

// ── Server (runs in the unsandboxed watchdog) ────────────────────────────────

export interface SpawnServerDeps {
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

async function writeResult(agentDir: string, id: string, result: IbCommandResult): Promise<void> {
  const payload: SpawnResult = {
    v: 1,
    id,
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
  };
  await writeJsonAtomic(spawnResultDir(agentDir), `${id}.json`, payload);
}

/** Remove results a client never collected. */
async function pruneStaleResults(agentDir: string, nowMs: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(spawnResultDir(agentDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!REQUEST_FILE.test(name)) continue;
    const path = join(spawnResultDir(agentDir), name);
    try {
      if (nowMs - (await stat(path)).mtimeMs > SPAWN_STALE_RESULT_MS) await rm(path, { force: true });
    } catch { /* raced with the client's own delete */ }
  }
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
  const agentDir = join(repoPath, ".ittybitty", "agents", agentId);
  const nowMs = (deps.now ?? Date.now)();
  await pruneStaleResults(agentDir, nowMs);

  let names: string[];
  try {
    names = (await readdir(spawnRequestDir(agentDir))).sort();
  } catch {
    return 0;
  }

  let handled = 0;
  for (const name of names) {
    // File names are agent-controlled: only a plain 32-hex id is ever used as a path.
    const match = REQUEST_FILE.exec(name);
    if (!match) continue;
    const id = match[1]!;
    const requestPath = join(spawnRequestDir(agentDir), name);

    let text: string;
    try {
      const size = (await stat(requestPath)).size;
      if (size > SPAWN_MAX_PROMPT_BYTES * 2) {
        await rm(requestPath, { force: true });
        await writeResult(agentDir, id, brokerFail("Error: spawn request is too large"));
        handled++;
        continue;
      }
      text = await Bun.file(requestPath).text();
    } catch {
      continue; // withdrawn by the client, or not yet readable
    }
    await rm(requestPath, { force: true });
    handled++;

    let result: IbCommandResult;
    try {
      result = await handleOneRequest(agentId, repoPath, agentDir, id, text, deps);
    } catch (err) {
      result = brokerFail(`Error: spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await writeResult(agentDir, id, result);
    } catch { /* the client will time out; nothing else to do */ }
  }
  return handled;
}

/**
 * Establish WHO a request is from. Identity comes from the agent's own record,
 * never from the request, and that record is trusted only while it matches its
 * seal. `verb` names the refused action in the error ("spawn", "retire", ...).
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
  // meta.json is writable by the agent, so trust it only if it still matches the
  // sealed record made at spawn (agentType / canSpawnChildren / paths / sandbox).
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
  if (!verification.ok) {
    return {
      ok: false,
      result: brokerFail(
        verification.field === "(missing)"
          ? `Error: no sealed record for '${agentId}'; run \`ib sandbox refresh ${agentId}\` from an unsandboxed session, then retry`
          : `Error: meta.json for '${agentId}' does not match its sealed record (${verification.field}); refusing to ${verb}`,
      ),
    };
  }
  return { ok: true, meta };
}

/** A request that names an `op` is a lifecycle command (lifecycle-broker.ts), not a spawn. */
function isLifecycleRequest(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text);
    return !!raw && typeof raw === "object" && !Array.isArray(raw) && "op" in raw;
  } catch {
    return false;
  }
}

async function handleOneRequest(
  agentId: string,
  repoPath: string,
  agentDir: string,
  id: string,
  text: string,
  deps: SpawnServerDeps,
): Promise<IbCommandResult> {
  if (isLifecycleRequest(text)) {
    // Lazy import: lifecycle-broker.ts imports this module.
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
