/**
 * Antigravity CLI (`agy`) PreInvocation hook handler.
 *
 * Fires at the start of every model turn (SPEC-ANTIGRAVITY-CLI.md §4.4). Three
 * responsibilities:
 *   1. writeAgentState("running") — the deterministic state so the dashboard /
 *      watchdog don't have to scrape the alt-screen agy TUI.
 *   2. Capture meta.agy_conversation_id (the PRIMARY capture point — it fires
 *      regardless of tool calls, and `agy resume` needs the id).
 *   3. Touch `<agentDir>/agy-hook-heartbeat` — the liveness marker the Phase 3
 *      watchdog checks to detect hooks silently absent under API-key auth.
 *
 * Output contract: `{}` (PreInvocation is not a gate). Always exits 0.
 */

import { join } from "path";
import { realpath } from "fs/promises";
import { isValidAgentId } from "../validation";
import { writeAgentState } from "../agents";
import { captureAgyConversationId } from "./agy-pre-tool-use";
import { AGY_EMPTY_OUTPUT } from "./agy-tools";

/** The per-agent liveness marker filename touched on every PreInvocation. */
export const AGY_HEARTBEAT_FILENAME = "agy-hook-heartbeat";

function emitNoop(write: (chunk: string) => unknown = (c) => process.stdout.write(c)): void {
  write(AGY_EMPTY_OUTPUT);
}

async function resolveAgentDir(agentId: string, cwd: string, override?: string): Promise<string> {
  if (override) return override;
  const m = cwd.match(/(.*\/\.ittybitty\/agents)/);
  const agentsDir = m ? m[1]! : join(process.cwd(), ".ittybitty", "agents");
  let dir = join(agentsDir, agentId);
  try {
    dir = await realpath(dir);
  } catch { /* directory may have just been created — fall through */ }
  return dir;
}

export interface AgyPreInvocationDeps {
  rawStdin?: string;
  agentDirOverride?: string;
  /** Skip mutating meta.json / touching the heartbeat (dry-run). */
  skipMetaWrites?: boolean;
  write?: (chunk: string) => unknown;
}

export async function hookAgyPreInvocation(
  agentId: string,
  deps?: AgyPreInvocationDeps,
): Promise<void> {
  const write = deps?.write ?? ((chunk: string) => process.stdout.write(chunk));
  try {
    if (!isValidAgentId(agentId)) {
      emitNoop(write);
      return;
    }

    const rawStdin =
      deps?.rawStdin ?? (await new Response(Bun.stdin.stream()).text());
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawStdin);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch { /* malformed JSON — still proceed with the running-state write */ }

    // agy payloads carry no `cwd`; the hook process cwd is <worktree>/.agents.
    const agentDir = await resolveAgentDir(agentId, process.cwd(), deps?.agentDirOverride);

    if (!deps?.skipMetaWrites) {
      await writeAgentState(agentDir, "running");
      const conversationId =
        typeof data.conversationId === "string" ? data.conversationId : "";
      if (conversationId) {
        await captureAgyConversationId(agentDir, conversationId);
      }
      // Touch the liveness marker. Best-effort — never fail the hook over it.
      try {
        await Bun.write(join(agentDir, AGY_HEARTBEAT_FILENAME), `${Date.now()}\n`);
      } catch { /* ignore */ }
    }

    emitNoop(write);
  } catch {
    try {
      emitNoop(write);
    } catch { /* even stdout failed — exit 0 silently */ }
  }
}

/**
 * Spawn-time precheck. Invokes the real handler with a synthetic payload
 * (skipMetaWrites) and verifies it emits a valid JSON object. Throws on failure.
 */
export async function hookAgyPreInvocationDryRun(agentId: string): Promise<void> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for agy-pre-invocation dry-run: ${agentId}`);
  }
  const dir = await resolveAgentDir(agentId, process.cwd());
  const metaFile = Bun.file(join(dir, "meta.json"));
  if (!(await metaFile.exists())) {
    throw new Error(`agy-pre-invocation dry-run: meta.json not found at ${join(dir, "meta.json")}`);
  }
  const buf: string[] = [];
  await hookAgyPreInvocation(agentId, {
    rawStdin: JSON.stringify({ conversationId: "dry-run-no-uuid" }),
    skipMetaWrites: true,
    write: (chunk: string) => { buf.push(chunk); return chunk.length; },
  });
  const out = buf.join("");
  if (!out) {
    throw new Error("agy-pre-invocation dry-run: handler produced no output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`agy-pre-invocation dry-run: handler emitted non-JSON output: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `agy-pre-invocation dry-run: handler output is not a JSON object (got ${JSON.stringify(parsed)})`,
    );
  }
}
