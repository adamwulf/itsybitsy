/**
 * Codex SessionStart hook handler.
 *
 * Two responsibilities per SPEC §5.6:
 *   1. Write deterministic state ("running") to meta.json via writeAgentState —
 *      mirrors the Phase-42 flow on the claude side so detectAgentStates() can
 *      read the stored state without scraping codex's TUI.
 *   2. Capture session_id (defensively reading both `session_id` and
 *      `sessionId`) into meta.codex_session_id IF the field is empty. This
 *      is the PRIMARY session-id capture point — SessionStart always fires,
 *      regardless of whether the agent reaches a tool call (reviewer #1).
 *
 * Codex's hook contract is FAIL-OPEN (any crash → tool call proceeds), so
 * the entire handler is wrapped in try/catch and always emits valid JSON +
 * exits 0. The stdout payload is intentionally a minimal SessionStart shape
 * (no additionalContext) — codex consumes it but does not require any data.
 */

import { join } from "path";
import { realpath } from "fs/promises";
import { isValidAgentId } from "../validation";
import { writeAgentState } from "../agents";
import { captureCodexSessionId } from "./codex-pre-tool-use";

const HOOK_EVENT_NAME = "SessionStart";

/** Read a value from data, accepting both snake_case and camelCase spellings. */
function readDefensive(
  data: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function buildSessionStartNoop(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: HOOK_EVENT_NAME, additionalContext: "" },
  });
}

function emitNoop(write: (chunk: string) => unknown = (c) => process.stdout.write(c)): void {
  write(buildSessionStartNoop());
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

export interface CodexSessionStartDeps {
  rawStdin?: string;
  agentDirOverride?: string;
  /** Skip mutating meta.json on disk (used by the dry-run path). */
  skipMetaWrites?: boolean;
  /** Optional stdout writer override (used by dry-run to capture output). */
  write?: (chunk: string) => unknown;
}

export async function hookCodexSessionStart(
  agentId: string,
  deps?: CodexSessionStartDeps,
): Promise<void> {
  const write = deps?.write ?? ((chunk: string) => process.stdout.write(chunk));
  try {
    if (!isValidAgentId(agentId)) {
      // Argv parse failure. Still emit a valid payload so codex doesn't fail open.
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
    } catch { /* malformed JSON — still proceed with the empty-state write */ }

    const cwd = typeof data.cwd === "string" ? data.cwd : process.cwd();
    const agentDir = await resolveAgentDir(agentId, cwd, deps?.agentDirOverride);

    if (!deps?.skipMetaWrites) {
      await writeAgentState(agentDir, "running");
      const sessionId = readDefensive(data, "session_id", "sessionId");
      if (sessionId) {
        await captureCodexSessionId(agentDir, sessionId);
      }
    }

    emitNoop(write);
  } catch {
    try {
      emitNoop(write);
    } catch { /* even stdout failed — exit 0 silently */ }
  }
}

/**
 * Spawn-time precheck (HIGH 3 from the Phase 4 review). Actually invokes
 * the real handler with a synthetic payload and verifies the resulting
 * stdout is valid JSON with the right hookEventName. Catches module-load
 * failures, runtime crashes, and output-contract regressions.
 */
export async function hookCodexSessionStartDryRun(agentId: string): Promise<void> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for codex-session-start dry-run: ${agentId}`);
  }
  const dir = await resolveAgentDir(agentId, process.cwd());
  const metaFile = Bun.file(join(dir, "meta.json"));
  if (!(await metaFile.exists())) {
    throw new Error(`codex-session-start dry-run: meta.json not found at ${join(dir, "meta.json")}`);
  }
  // Actually invoke the handler with a synthetic SessionStart payload and
  // skipMetaWrites so we don't mutate the running agent's state.
  const buf: string[] = [];
  const syntheticInput = JSON.stringify({
    cwd: dir,
    session_id: "dry-run-no-uuid",
  });
  await hookCodexSessionStart(agentId, {
    rawStdin: syntheticInput,
    skipMetaWrites: true,
    write: (chunk: string) => { buf.push(chunk); return chunk.length; },
  });
  const out = buf.join("");
  if (!out) {
    throw new Error("codex-session-start dry-run: handler produced no output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`codex-session-start dry-run: handler emitted non-JSON output: ${(err as Error).message}`);
  }
  const hookOutput = (parsed as Record<string, unknown>)?.hookSpecificOutput as
    | Record<string, unknown>
    | undefined;
  if (!hookOutput || hookOutput.hookEventName !== "SessionStart") {
    throw new Error(
      `codex-session-start dry-run: handler output missing hookSpecificOutput.hookEventName="SessionStart" (got ${JSON.stringify(parsed)})`,
    );
  }
}
