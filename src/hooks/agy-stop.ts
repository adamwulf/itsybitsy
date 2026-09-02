/**
 * Antigravity CLI (`agy`) Stop hook handler.
 *
 * Fires when agy ends a turn (SPEC-ANTIGRAVITY-CLI.md §4.4 / D9):
 *   - Reads the tail of the transcript (last PLANNER_RESPONSE with content) and
 *     runs detectStateFromMessage — "complete" on the completion sentinel, else
 *     "waiting". Unlike codex, agy's Stop payload does NOT carry the last
 *     assistant message, so we read `transcriptPath` from the payload.
 *   - Writes the derived state to meta.json.
 *   - If the state is "complete" but `git status --porcelain` is non-empty,
 *     writes "running" back and returns the uncommitted-work continue nudge
 *     (`{"decision":"continue","reason":…}`), mirroring codex-stop.
 *   - Logs a non-empty `error` field.
 *
 * Output contract: `{}` or `{"decision":"continue","reason":"…"}`. Always exits 0.
 */

import { join } from "path";
import { realpath } from "fs/promises";
import { isValidAgentId } from "../validation";
import { writeAgentState, type MetaState } from "../agents";
import { logAgent } from "../agent-lifecycle";
import { detectStateFromMessage } from "./agent-status";
import { AGY_EMPTY_OUTPUT, buildAgyStopContinue } from "./agy-tools";

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
  } catch { /* directory may have been removed (agent killed mid-stop) */ }
  return dir;
}

/**
 * Pick the meta.state value for a Stop firing. Reuses detectStateFromMessage so
 * the sentinel vocabulary matches the claude / codex sides.
 */
export function deriveAgyStopState(lastMessage?: string): MetaState {
  if (!lastMessage) return "waiting";
  const detected = detectStateFromMessage(lastMessage);
  if (detected === "complete") return "complete";
  return "waiting";
}

/**
 * Extract a plain-text string from a transcript line's `content` field, whose
 * shape agy has not pinned. Handles: a bare string; an array of strings /
 * `{text}` objects (joined); a `{text}` object. Anything else → "".
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const el of content) {
      if (typeof el === "string") parts.push(el);
      else if (el && typeof el === "object" && typeof (el as { text?: unknown }).text === "string") {
        parts.push((el as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
}

/**
 * Scan a transcript JSONL for the last `PLANNER_RESPONSE` line that carries
 * text content. Returns the extracted text, or undefined when none is found.
 * Malformed lines are skipped.
 */
export function extractLastPlannerResponseText(jsonl: string): string | undefined {
  if (!jsonl) return undefined;
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== "PLANNER_RESPONSE") continue;
    const text = extractTextFromContent(obj.content);
    if (text.length > 0) return text;
  }
  return undefined;
}

export interface AgyStopDeps {
  rawStdin?: string;
  agentDirOverride?: string;
  /** Override transcript reading for tests. */
  readTranscript?: (path: string) => Promise<string | undefined>;
  /** Override git status for tests. */
  checkGitStatus?: () => Promise<string>;
  /** Skip mutating meta.json on disk (dry-run). */
  skipMetaWrites?: boolean;
  write?: (chunk: string) => unknown;
}

async function readTranscriptFile(path: string): Promise<string | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    return await file.text();
  } catch {
    return undefined;
  }
}

async function readGitPorcelain(agentDir: string, deps?: AgyStopDeps): Promise<string> {
  if (deps?.checkGitStatus) return deps.checkGitStatus();
  try {
    const repoDir = join(agentDir, "repo");
    const proc = Bun.spawn(
      ["git", "-C", repoDir, "status", "--porcelain"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const porcelain = await new Response(proc.stdout).text();
    await proc.exited;
    return porcelain;
  } catch {
    return "";
  }
}

export async function hookAgyStop(agentId: string, deps?: AgyStopDeps): Promise<void> {
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
    } catch { /* malformed JSON — still proceed with the default-waiting write */ }

    const agentDir = await resolveAgentDir(agentId, process.cwd(), deps?.agentDirOverride);

    // Log a non-empty agy error field (D9) — best-effort.
    if (typeof data.error === "string" && data.error.length > 0) {
      await logAgent(agentDir, `[Stop] agy reported error: ${data.error}`);
    }

    // Read the transcript tail for the last assistant message.
    let lastMessage: string | undefined;
    const transcriptPath = typeof data.transcriptPath === "string" ? data.transcriptPath : "";
    if (transcriptPath) {
      const reader = deps?.readTranscript ?? readTranscriptFile;
      const jsonl = await reader(transcriptPath);
      if (jsonl) lastMessage = extractLastPlannerResponseText(jsonl);
    }

    const state = deriveAgyStopState(lastMessage);
    if (!deps?.skipMetaWrites) {
      await writeAgentState(agentDir, state);
    }

    if (state === "complete") {
      const porcelain = await readGitPorcelain(agentDir, deps);
      if (porcelain.trim() !== "") {
        if (!deps?.skipMetaWrites) {
          await writeAgentState(agentDir, "running");
        }
        write(buildAgyStopContinue(
          "[watchdog]: You have uncommitted changes. Please commit your work using git add && git commit before completing.",
        ));
        return;
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
 * Spawn-time precheck. Invokes the real handler with a synthetic payload
 * (skipMetaWrites) and verifies it emits a valid JSON object. Throws on failure.
 */
export async function hookAgyStopDryRun(agentId: string): Promise<void> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent id for agy-stop dry-run: ${agentId}`);
  }
  const dir = await resolveAgentDir(agentId, process.cwd());
  const metaFile = Bun.file(join(dir, "meta.json"));
  if (!(await metaFile.exists())) {
    throw new Error(`agy-stop dry-run: meta.json not found at ${join(dir, "meta.json")}`);
  }
  const buf: string[] = [];
  await hookAgyStop(agentId, {
    rawStdin: JSON.stringify({ transcriptPath: "" }),
    skipMetaWrites: true,
    write: (chunk: string) => { buf.push(chunk); return chunk.length; },
  });
  const out = buf.join("");
  if (!out) {
    throw new Error("agy-stop dry-run: handler produced no output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`agy-stop dry-run: handler emitted non-JSON output: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `agy-stop dry-run: handler output is not a JSON object (got ${JSON.stringify(parsed)})`,
    );
  }
}
