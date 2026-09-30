/**
 * Watchdog ask broker — how a SANDBOXED agent asks the user a question.
 *
 * `ib ask` records the question in `<repo>/.ittybitty/user-questions.json` and
 * then tells the user (macOS `say`, Telegram). A sandboxed worktree agent
 * cannot do that itself: its profile grants its own agent dir, its worktree and
 * `<repo>/.ittybitty/agents`, but NOT `<repo>/.ittybitty` — so the questions
 * file is outside its write roots and the question never reaches the user.
 *
 * The answer is the one `ib new-agent` and the lifecycle commands already use
 * (spawn-broker.ts, lifecycle-broker.ts): the agent's WATCHDOG runs
 * unsandboxed, so the sandboxed command hands it the request and waits. The
 * queue, the file format and the at-most-once handling are the spawn broker's;
 * a request with `op: "ask"` is dispatched here.
 *
 *   sandboxed `ib ask "..."`  ──request.json──▶  the caller's own watchdog
 *        (client, this file)                      (server, this file)
 *                             ◀──result.json───   runs the normal askQuestion()
 *
 * Who uses it: the same callers as the lifecycle broker — only a WORKTREE agent
 * whose itsybitsy sandbox is enabled (`resolveRoutedCaller`). Every other
 * caller runs `ib ask` directly, as before.
 *
 * Trust model: the request is untrusted DATA and carries only the question
 * text — never an agent id, a repo or a path. The watchdog asks as its OWN
 * agent (verified against the sealed record, as for a spawn), so a request
 * cannot put a question in another agent's name, and `--id` for another agent
 * is refused on the client. `askQuestion()` then applies its ordinary rules
 * (top-level only, `allowAgentQuestions`).
 *
 * Known limitation (SPEC-SANDBOX §4C.8): the top-level rule reads `manager`
 * from the requester's own meta.json, which the agent can write and the seal
 * does not cover. That is the same for a direct `ib ask`; the rule is a
 * convention for who talks to the user, not a boundary. `askQuestion()` also
 * puts the unsealed `name` from that file in the `say` and Telegram text,
 * which now run outside the sandbox (text only: one argv entry, no shell).
 */

import { randomBytes } from "crypto";
import { dirname } from "path";
import {
  askQuestion,
  askTopLevelRefusal,
  hasLiveWatchdog,
  resolveCallerAgentContext,
  type IbCommandResult,
  type ResolvedCallerContext,
} from "./ib-commands";
import {
  SPAWN_CLIENT_TIMEOUT_MS,
  SPAWN_MAX_PROMPT_BYTES,
  brokerFail,
  resolveRoutedCaller,
  submitWatchdogRequest,
  verifyBrokerRequester,
  type SpawnClientDeps,
  type SpawnServerDeps,
} from "./spawn-broker";

/** The `op` that marks a request in the watchdog queue as a question. */
export const ASK_OP = "ask";

const REQUEST_FIELDS = new Set(["v", "id", "op", "question"]);

export interface AskRequest {
  v: 1;
  id: string;
  op: typeof ASK_OP;
  question: string;
}

type ParsedAskRequest = { ok: true; request: AskRequest } | { ok: false; error: string };

/** Strictly parse an untrusted request; only the allowlisted fields survive. */
export function parseAskRequest(text: string, expectedId: string): ParsedAskRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "ask request is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "ask request must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!REQUEST_FIELDS.has(key)) return { ok: false, error: `ask request has unsupported field '${key}'` };
  }
  if (obj.v !== 1) return { ok: false, error: "unsupported ask request version" };
  if (obj.id !== expectedId) return { ok: false, error: "ask request id does not match its file name" };
  if (obj.op !== ASK_OP) return { ok: false, error: "ask request has an unsupported op" };
  if (typeof obj.question !== "string" || obj.question.trim() === "") {
    return { ok: false, error: "ask request needs a non-empty question" };
  }
  if (Buffer.byteLength(obj.question, "utf8") > SPAWN_MAX_PROMPT_BYTES) {
    return { ok: false, error: "ask request question is too large" };
  }
  return { ok: true, request: { v: 1, id: expectedId, op: ASK_OP, question: obj.question } };
}

// ── Client (runs inside the sandbox) ─────────────────────────────────────────

/**
 * Ask the calling agent's watchdog to record a question for the user, and wait
 * for the answer. Fails at once when the watchdog is not live, and after
 * SPAWN_CLIENT_TIMEOUT_MS (30s) when it is live but does not answer.
 */
export async function requestAskViaWatchdog(
  question: string,
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
      "Error: cannot run 'ib ask' from inside the sandbox: this shell is not inside a registered agent, " +
        "so there is no agent watchdog to ask. Run `ib ask` from an agent's own worktree.",
    );
  }
  const callerId = caller.meta.id;

  // The same top-level rule askQuestion() applies in the watchdog; checked
  // here first so that a sub-agent gets "use ib send <manager>" and not a hint
  // about its watchdog. The watchdog's check is the one that decides.
  const refusal = await askTopLevelRefusal(dirname(caller.agentDir), caller.meta);
  if (refusal) return refusal;

  if (Buffer.byteLength(question, "utf8") > SPAWN_MAX_PROMPT_BYTES) {
    return brokerFail(`Error: question is larger than ${SPAWN_MAX_PROMPT_BYTES} bytes; shorten it`);
  }

  // Tell "no watchdog" from "slow watchdog" up front, without waiting.
  const live = await (deps.watchdogLive ?? hasLiveWatchdog)(caller.agentDir);
  if (!live) {
    return brokerFail(
      `Error: cannot run 'ib ask' from inside the sandbox: the watchdog for '${callerId}' is not running ` +
        `(no fresh heartbeat), and the watchdog is what records a question for a sandboxed agent. Restart this ` +
        `agent so its watchdog starts, then retry.`,
    );
  }

  // Field order matters for one case: a watchdog that predates this broker
  // names the first field it does not know (`op`, or `question` for one that
  // has the lifecycle broker only).
  const request: AskRequest = { v: 1, id: randomBytes(16).toString("hex"), op: ASK_OP, question };
  const result = await submitWatchdogRequest(
    caller.agentDir,
    callerId,
    request,
    {
      request: "ask",
      action: "record the question",
      alreadyStarted: "The watchdog had already taken the question, so it may still reach the user.",
    },
    deps.timeoutMs ?? SPAWN_CLIENT_TIMEOUT_MS,
    deps,
  );
  if (
    !result.ok &&
    (result.stderr.includes("spawn request has unsupported field 'op'") ||
      result.stderr.includes("lifecycle request has unsupported field 'question'"))
  ) {
    return brokerFail(
      `Error: the watchdog for '${callerId}' predates sandboxed 'ib ask'. Restart this agent so its ` +
        `watchdog picks up the feature, then retry.`,
    );
  }
  return result;
}

/**
 * The `ib ask` entry point. Returns null when the caller must ask directly,
 * exactly as before this broker existed (`resolveRoutedCaller` has the rule).
 * `agentId` is the agent the command line names (`--id`, or the one detected
 * from the cwd). A routed caller asks only as itself: its watchdog serves its
 * own agent and nobody else.
 */
export async function routeAskThroughWatchdog(
  question: string,
  agentId: string,
  deps: SpawnClientDeps = {},
): Promise<IbCommandResult | null> {
  const caller = await resolveRoutedCaller(deps);
  if (!caller) return null;
  if (agentId !== caller.meta.id) {
    return brokerFail(
      "Error: --id for another agent is not supported inside the sandbox: a sandboxed agent asks the user only as itself, through its watchdog.",
    );
  }
  return requestAskViaWatchdog(question, { ...deps, resolveCaller: async () => caller });
}

// ── Server (runs in the unsandboxed watchdog) ────────────────────────────────

/**
 * Handle one ask request on behalf of `agentId`. Called by the spawn broker's
 * queue handler, which has already consumed the request file.
 */
export async function handleAskRequest(
  ctx: { agentId: string; repoPath: string; agentDir: string; id: string; text: string },
  deps: SpawnServerDeps,
): Promise<IbCommandResult> {
  const parsed = parseAskRequest(ctx.text, ctx.id);
  if (!parsed.ok) return brokerFail(`Error: ${parsed.error}`);

  // Identity comes from the agent's own sealed record, never from the request.
  const requester = await verifyBrokerRequester(ctx.agentId, ctx.repoPath, ctx.agentDir, "ask", deps);
  if (!requester.ok) return requester.result;

  try {
    // The ordinary command, as the watchdog's own agent: the top-level rule,
    // the config check, the log line and the notifications all apply.
    return await (deps.askQuestion ?? askQuestion)(ctx.repoPath, ctx.agentId, parsed.request.question);
  } catch (err) {
    return brokerFail(`Error: ask failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
