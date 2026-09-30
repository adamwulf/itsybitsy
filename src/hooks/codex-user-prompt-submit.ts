/**
 * Codex UserPromptSubmit hook handler.
 *
 * Fires when a prompt is submitted — typed by a human in the pane or delivered
 * by `ib send` — before codex processes it. It applies the same rule as
 * Claude's UserPromptSubmit hook (`markRunningOnPrompt`, SPEC §6.6): write
 * `running` unless the agent is `stopped`. Without it a codex agent had no
 * turn-start state write after SessionStart, so a direct human turn that ended
 * in the same state kept a manager's `ib ack` (SPEC §8.5.2) forever.
 *
 * Output contract: `{}`. Codex parses this event's stdout as JSON ("hook
 * returned invalid user prompt submit JSON output"), the same family as Stop,
 * where `{}` is the verified no-op. Never plain text, never empty stdout.
 *
 * Codex's hook contract is FAIL-OPEN, so the handler is wrapped in try/catch
 * and always emits valid JSON + exits 0.
 */

import { join } from "path";
import { isValidAgentId } from "../validation";
import { resolveAgentDir } from "./agent-context";
import { markRunningOnPrompt } from "./mark-running";

const NOOP = "{}";

export interface CodexUserPromptSubmitDeps {
  rawStdin?: string;
  agentDirOverride?: string;
  /** Skip mutating meta.json on disk (used by the dry-run path). */
  skipMetaWrites?: boolean;
  /** Optional stdout writer override (used by dry-run to capture output). */
  write?: (chunk: string) => unknown;
}

export async function hookCodexUserPromptSubmit(
  agentId: string,
  deps?: CodexUserPromptSubmitDeps,
): Promise<void> {
  const write = deps?.write ?? ((chunk: string) => process.stdout.write(chunk));
  try {
    if (!isValidAgentId(agentId)) {
      write(NOOP);
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
    } catch { /* malformed JSON — still apply the prompt rule */ }

    const cwd = typeof data.cwd === "string" ? data.cwd : process.cwd();
    const agentDir = await resolveAgentDir(agentId, cwd, deps?.agentDirOverride);
    if (!deps?.skipMetaWrites) {
      await markRunningOnPrompt(agentDir);
    }
    write(NOOP);
  } catch {
    try {
      write(NOOP);
    } catch { /* even stdout failed — exit 0 silently */ }
  }
}

/**
 * Spawn-time precheck: invoke the real handler with a synthetic payload (no
 * meta writes) and check it emits a JSON object with no hookSpecificOutput
 * envelope. Catches module-load failures, crashes, and output regressions.
 */
export async function hookCodexUserPromptSubmitDryRun(agentId: string): Promise<void> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for codex-user-prompt-submit dry-run: ${agentId}`);
  }
  const dir = await resolveAgentDir(agentId, process.cwd());
  if (!(await Bun.file(join(dir, "meta.json")).exists())) {
    throw new Error(`codex-user-prompt-submit dry-run: meta.json not found at ${join(dir, "meta.json")}`);
  }
  const buf: string[] = [];
  await hookCodexUserPromptSubmit(agentId, {
    rawStdin: JSON.stringify({ cwd: dir, prompt: "dry-run" }),
    skipMetaWrites: true,
    write: (chunk: string) => { buf.push(chunk); return chunk.length; },
  });
  const out = buf.join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`codex-user-prompt-submit dry-run: handler emitted non-JSON output: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || "hookSpecificOutput" in parsed) {
    throw new Error(`codex-user-prompt-submit dry-run: handler output must be a plain JSON object (got ${out})`);
  }
}
