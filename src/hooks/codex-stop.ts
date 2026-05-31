/**
 * Codex Stop hook handler.
 *
 * Phase 3 scope (per SPEC §5.6): write the deterministic state to meta.json
 * when codex's session ends. The matching state-detection branch in
 * detectAgentStates() is Phase 5 work — for now the stored state just lets
 * the dashboard show "waiting"/"complete" instead of leaving "running" stale.
 *
 * State selection mirrors the claude-side Stop hook (src/hooks/agent-status.ts):
 *   - "complete" when the last assistant message explicitly signals completion
 *     ("I HAVE COMPLETED THE GOAL" sentinel, in line with detectStateFromMessage).
 *   - "waiting" when the agent ended a turn without a completion sentinel
 *     (codex's typical end-of-turn — model returned control to the user).
 *
 * Codex's Stop payload (verified empirically — see CODEX-CLI-NOTES.md) does
 * NOT include a `last_assistant_message` field; codex's analogue is the
 * `transcript_path` rollout file. Reading the rollout file is out of Phase 3
 * scope — Phase 5 will wire that in. For Phase 3 we default to "waiting" and
 * promote to "complete" only when the caller (or future state-detection
 * branch) supplies an explicit signal.
 *
 * Codex's hook contract is FAIL-OPEN: any crash → tool call proceeds. The
 * handler wraps everything in try/catch and always emits valid JSON + exits 0.
 */

import { join } from "path";
import { realpath } from "fs/promises";
import { isValidAgentId } from "../validation";
import { writeAgentState, type MetaState } from "../agents";
import { detectStateFromMessage } from "./agent-status";

const HOOK_EVENT_NAME = "Stop";

function emitNoop(): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: HOOK_EVENT_NAME, additionalContext: "" },
    }),
  );
}

async function resolveAgentDir(agentId: string, cwd: string, override?: string): Promise<string> {
  if (override) return override;
  const m = cwd.match(/(.*\/\.ittybitty\/agents)/);
  const agentsDir = m ? m[1]! : join(process.cwd(), ".ittybitty", "agents");
  let dir = join(agentsDir, agentId);
  try {
    dir = await realpath(dir);
  } catch { /* directory may have been removed (agent killed mid-stop) */ }
  return dir;
}

/**
 * Pick the meta.state value to write for a Stop hook firing. Reuses the
 * detectStateFromMessage helper from the claude side so the sentinel
 * vocabulary matches across CLIs.
 */
export function deriveCodexStopState(lastAssistantMessage?: string): MetaState {
  if (!lastAssistantMessage) return "waiting";
  const detected = detectStateFromMessage(lastAssistantMessage);
  if (detected === "complete") return "complete";
  return "waiting";
}

export interface CodexStopDeps {
  rawStdin?: string;
  agentDirOverride?: string;
}

export async function hookCodexStop(agentId: string, deps?: CodexStopDeps): Promise<void> {
  try {
    if (!isValidAgentId(agentId)) {
      emitNoop();
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
    } catch { /* malformed JSON — still proceed with the default-waiting write */ }

    const cwd = typeof data.cwd === "string" ? data.cwd : process.cwd();
    const agentDir = await resolveAgentDir(agentId, cwd, deps?.agentDirOverride);

    const lastMessage =
      typeof data.last_assistant_message === "string"
        ? data.last_assistant_message
        : undefined;
    const state = deriveCodexStopState(lastMessage);
    await writeAgentState(agentDir, state);

    emitNoop();
  } catch {
    try {
      emitNoop();
    } catch { /* even stdout failed — exit 0 silently */ }
  }
}

/**
 * Spawn-time precheck. Mirrors the other codex hooks' dry-run contract.
 */
export async function hookCodexStopDryRun(agentId: string): Promise<void> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for codex-stop dry-run: ${agentId}`);
  }
  const dir = await resolveAgentDir(agentId, process.cwd());
  const metaFile = Bun.file(join(dir, "meta.json"));
  if (!(await metaFile.exists())) {
    throw new Error(`codex-stop dry-run: meta.json not found at ${join(dir, "meta.json")}`);
  }
}
